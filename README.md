---
description: "Serves the DSH Web GUI on a second loopback origin so any IDE webview (VS Code Simple Browser, JetBrains, VS Code forks) can embed it, with optional click-to-open in your editor."
kind: "package-reference"
---

# @ni123niwjsj/dsh-web-bridge

English | [中文](README.zh.md)

## Overview

Serves this DSH Web GUI on a second loopback origin. An IDE webview that embeds `127.0.0.1:3080` directly is rejected by DSH's same-origin fence; this plugin answers the embedder on its own origin and speaks to DSH as a trusted, credential-holding client, so **any IDE that can render a web page can be a DSH front door**. With the click script enabled, clicking a file path in the UI opens it in your editor, and Alt/Cmd+click opens a native diff.

## Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further exploration](#further-exploration)
- [Known limitations](#known-limitations-and-deferred-work)
- [Dev note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Install

The standard DSH bundle command (replace `<profile>` with yours; a Web UI is usually `web`):

```bash
# 1) Straight from GitHub (use this while the package is not on npm yet; it installs the repository's current state)
dsh plugin --profile web add github:ni123niwjsj/dsh-web-bridge

# 2) From npm (once published)
dsh plugin --profile web add @ni123niwjsj/dsh-web-bridge

# 3) Local development: clone and point at the directory
git clone https://github.com/ni123niwjsj/dsh-web-bridge && cd dsh-web-bridge
dsh plugin --profile web add link:$PWD
```

Uninstall with `dsh plugin --profile web remove @ni123niwjsj/dsh-web-bridge`.

> ⚠️ **Pick one of the three and do not mix them** — they all install the same package name, so installing two of them leaves both in place and conflicting; `remove` first when switching.
> Every behaviour described here was measured against **DSH 0.2.0-rc.2** (and relies on runtime behaviour of `@deepseek-ai/schemastery` and `dsh-settings`).

Restart DSH when prompted. The plugin starts with DSH and stops with it. Its only writes go to **one scratch root per instance** (a random `mkdtemp` directory holding HEAD snapshots and the self-test repo), removed when the bridge closes.

### Use

1. Settings → **DSH Web Bridge**: confirm the state is “Running” and copy the address (default `http://127.0.0.1:39977/`).
2. Open that address in your IDE:
   - VS Code: `Ctrl+Shift+P` → **Simple Browser: Show** → paste the address
   - JetBrains or other IDEs: the built-in web preview or an external browser
3. For a fixed layout (panel on the right, files always in the middle): drag the tab into a right-hand group, click that group, then run **Lock Group** from the command palette.

### Configuration

Edit it on this plugin row’s configuration page (Settings → Plugins → this bundle → the row’s **Configure**). The plugin renders that page itself: the host hands it `form` (live values plus write actions), so the page offers field validation, `default/overridden` markers, a per-field **Restore default**, and save feedback. Writes go through the host settings channel into the profile patch — no file editing. Saving `port`/`upstream`/`roots`/`injectClickScript`/`openCommand`/`launchMode` restarts the bridge with the new config; `decorate`/`hijackChip` need no restart at all — a page reload picks them up.

> **How a relative path finds its file (the heart of click-to-open):** the page shows a path **exactly as the session wrote it** (`dsh-web-bridge/lib/bridge.js`), while the bridge's own working directory is the **parent** of the project — so on its own it resolves nothing. The host half therefore hands the bridge a **function, not a list**: on every click it reads `ctx.get('sessions').list()` for each live session's `header.cwd` (subagents each own a session, so they are covered too) and adds the configured `roots`, the process working directory and `$HOME`. Sessions come and go, and reading per click is what makes a session created *after* the bridge started clickable — no restart, and no hand-maintained list of every project. `sessions` is not a hard dependency: without it, absolute paths and anything under `roots` still resolve. A failed resolution returns the `searched` array and the status snapshot carries `searchRoots`, so "which directories did it try" is answerable at a glance.

> **Maintainer note — the gate it is easy to miss:** whether a form appears at all depends on every field carrying `.volatile()`. The host’s `settings.describe()` runs each entry through its private `volatileForm()` and **drops any entry without a marked field entirely** — that row then has no namespace at all, `configForms.get()` answers `unavailable`, and no arrangement of `configure({ auto: false }, ctx.fiber)` can change it (that call only declares “this row ships its own page, do not auto-generate one”). Once marked, a field no longer parses to a plain value but to a frozen live reference `{ get() }` the Loader rewrites in place, so every read must go through `.get()` at the moment of use (`readRowSettings()`), and a change arrives as a `loader/volatile-update` event **without remounting the plugin** (`adopt()` restarts the bridge from it). A changed port binds the new origin before releasing the old one, so a port already in use cannot cost a working bridge.

| Field | Default | Meaning |
|---|---|---|
| `port` | `39977` | Port of the second loopback origin |
| `upstream` | `127.0.0.1:3080` | The running DSH Web server to proxy |
| `roots` | `[]` | Extra directories a relative path may resolve against. Rarely needed: the **working directory of every live session** (`Session.header.cwd`, subagents included), the process working directory and `$HOME` are searched automatically |
| `injectClickScript` | `true` | Inject the click-to-open script; turn off for a plain proxy |
| `decorate` | `true` | Underline and pointer on recognised inline paths, so they look clickable |
| `hijackChip` | `off` | Whether a click on the official file chip is taken over: `off` keeps the Harness viewer too (default), `auto` takes over inside an IDE shell only, `on` always takes over |
| `autoStart` | `true` | Start the bridge when the plugin activates |
| `openCommand` | `code` | Editor CLI used to open a file (`code`, `codium`, or an absolute path) |
| `launchMode` | `auto` | `auto`: CLI first, then the desktop portal; `editor`: CLI only; `portal`: `vscode://` through xdg-desktop-portal (Linux) |

### How click-to-open works

The injected script (`lib/click-script.js`, served from disk on every request) does two things, and **neither depends on DSH nor on the format whoever wrote the message happened to use**:

1. **Recognize.** From the clicked element it walks up at most 8 levels, looking for a path in an attribute (`title` / `aria-label` / `href` / `data-path` / `data-file` / `data-review-file`), then for an element whose **entire text** is a path (optionally with `:123` / `:123-145` / `#L123` / `#anchor`). Segments may hold non-ASCII letters and spaces, so a Chinese file name and a workspace directory with a space both work. The official chip's shape — path in `title`, line in the visible label — has both halves combined, so the line is not lost.
2. **Make it look clickable.** Every **inline** element it recognizes gets a dotted underline, a pointer cursor and a small icon on hover (plus a tooltip). That is the whole point: a path *looks* openable without anyone having to know the feature exists first. `Alt`/`⌘` + click opens a **real diff** (`code -r --diff <HEAD snapshot> <file>`; outside a git repo, without a HEAD revision, or when the editor refuses, it degrades to a plain open by design).
3. **Find the file.** An absolute path is used as-is. A relative one is tried against every search root in turn (the configured `roots`, **every live session's working directory**, the process working directory and `$HOME`). **When none of them hits, it scans one level deeper** — each root's immediate subdirectories (`docs/TODO.md` → `<root>/*/docs/TODO.md`) — because people and models write paths relative to the directory they are working in, not the session root. That fallback is used **only for an unambiguous match**: several matches are **listed and refused**, since silently opening a plausible-but-wrong file is worse than not opening one.
4. **Echo the target.** Before opening, the bridge reads that line (bounded: 512KB) and puts the result in the toast: the line's own text on success (`:250 "token: deriveToken(secret),"`), an outright warning when the number is **past the end of the file** ("the file has only 165 lines"), and a note naming the subdirectory when the one-level fallback was what found it. **This is what makes a wrong jump visible on the spot** — a line number is a snapshot that goes stale, but the text on the line cannot lie.

5. **Anchors — the durable half of a citation.** A line number is a *snapshot*: it is right when written and wrong after the next edit, and going stale does not error — it quietly lands you on an unrelated line. So a path may carry an **anchor** instead: `path#<text>`, which the host resolves by searching the file literally **at click time**.

   | Form | Meaning |
   |---|---|
   | `path:24`, `path:24-30` | a line / a range (the range takes its first line) |
   | `path#L24`, `path#L24-L30` | the same in `#` form (which is what DSH's own file-reference prompt teaches) |
   | `path#deriveToken` | an **anchor**: searched literally, case-sensitively, first occurrence wins |

   Precedence is **anchor → line → open only**: a hit uses the anchor's line; several hits take the first and **say how many**; a miss falls back to the line (and says so); neither opens the file without a jump. **An anchor can never make a file fail to open.**

6. **Taking over the official chip (optional, off by default).** Clicking the Harness's own file chip also opens its viewer tab, so with the editor jump that is two actions for one click. `hijackChip` can take the click over: `stopPropagation()` during the capture phase, and since React's `onClick` lives on the root container (a descendant of `document`) it never receives the event — no viewer tab. Only clicks where a target was actually recognised are touched.

   | Setting | What a chip click does |
   |---|---|
   | `off` (**default**) | editor jump **+** Harness viewer tab (i.e. no change) |
   | `auto` | **inside an IDE shell** editor only; a plain browser keeps the Harness behaviour |
   | `on` | always editor only |
   | (`injectClickScript: false`) | Harness viewer only, no editor jump |

   The `auto` test for "is this an IDE shell" **rests on measurement, not assumption**: VS Code's Simple Browser is **not** an iframe (measured `window.top === window`); what separates it is the user agent — `Code/1.141.0 … Electron/43.7.7` versus a bare `Chrome/154`. So the rule is **`Electron` / `Code/` / `vscode` / `JCEF` in the agent, or a page that reports being framed**. The verdict is reported with every page load to `/__bridge/log` (`kind: "hello"`, fields `shell` and `hijack`), so "why did it not take over" is answerable from the log.

   **A failure hands the click back.** Suppression is synchronous and opening is asynchronous, so if the editor side fails the script re-dispatches the click with a one-shot skip flag and the Harness viewer opens as usual — the worst case is "same as not taking over", never "nothing happened".

Two ways to switch the decoration off **without a restart**: `decorate: false` in the injected config, or `localStorage.setItem("dsh-web-bridge:decorate", "off")` in the browser console.

Two deliberate boundaries:

- **A path buried inside a sentence is not recognized** (the whole text has to be the path). The rule was tightened by a real false positive: the status line `168 tok/s69.3M tok` was nearly opened as a file.
- **Spaces and non-ASCII letters are recognised**: a path segment may hold **non-ASCII letters** (`测试清单.md`) and **single spaces** (`dsh workspace`); in the attribute channel a space is only allowed from the **second segment on**, or the prose in front of a path gets swallowed (`Read src/api/server.ts` would match from `Read`).
- **An element's text must have a single source**: `textContent` is every descendant's text glued together, so walking up to an ancestor can spell a path by accident. DSH's file viewer did exactly that — its tab strip holds the label `hello.html`, the breadcrumb `/home/dev/hello.html` and the badge `HTML`, and the concatenation `hello.html/home/dev/hello.htmlHTML` made every click anywhere in that strip report "no such file". Only an element whose text has one source (a leaf, or a single wrapper around one) is now read as a path.
- **Dot-files are recognised**: `/tmp/x/.gitignore` has no stem before its extension, which the old shape demanded.
- The guards are the **letter right after the dot** (which is why `168 tok/s69.3M tok` is refused) and the single-source rule above; the extension length is no longer a criterion (it is 16 now).
- **The subdirectory fallback is one level deep**: `<root>/*/path` resolves, `<root>/*/*/path` does not. Two levels widen the room for a wrong guess; add it when a real case shows up.

DSH's own chip is a **separate path**: its resolver matches verbatim (the token must equal a path produced this turn, or the unique basename of one), so a `:399` suffix never becomes a chip; and what it opens is DSH's own preview tab, whose opener takes a path and **no line**. So for "jump to line N" the reliable route is always the injected script.

### What the model is told

The plugin registers **one supplementary section** in the system prompt (`systemPrompt.section`, named `dsh-web-bridge:file-anchors`, ordered immediately after DSH's own file-reference section). It covers only what that section cannot: a line number is a snapshot, an anchor is durable, and **do not invent a line number**. DSH already mandates workspace-relative paths and the `#L24` spelling, so nothing there is repeated. A refused registration is a warning and never affects the bridge.

### Endpoints

The bridge origin also exposes diagnostics, each needing the derived token in a header (see the runtime invariants at the end). `/__bridge/client.js` is the exception: the page fetches it, so it is not a secret:

| Method | Path | Purpose |
|---|---|---|
| GET | `/__bridge/ping` | State: upstream, roots, event count |
| GET | `/__bridge/log?limit=N` | Recent open/diff/click events, including the real DOM of a click |
| POST | `/__bridge/open` | `{file, line?}` → open in the editor at the line |
| POST | `/__bridge/diff` | `{file}` → native diff (`--diff <HEAD snapshot> <working file>`, degrading to a plain open) |
| POST | `/__bridge/report` | Click reports from the injected script |
| GET | `/__bridge/selftest` | Verifies the snapshot, the open path and the target line in a temp git repo; **dry by default** (it checks the command instead of launching), `?live=1` to actually open |
| GET | `/__bridge/client.js` | The injected script |

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation detail — click to expand</summary>

DSH’s `/api` entry requires a loopback or trusted `Host`, rejects `Sec-Fetch-Site: cross-site`, requires `Origin` to equal `Host` when present, and the index needs the `HttpOnly; SameSite=Strict`, authority-bound signed cookie. A page inside an IDE webview satisfies none of that, so the plugin:

- mints the cookie from the durable `client-connection/browser-session` signing secret in `ctx.credentials`;
- strips `Origin` / `Sec-Fetch-Site` / `Referer` upstream (a missing `Origin` is what DSH reads as a trusted client);
- strips `Set-Cookie` downstream, so the embedder never holds a credential;
- proxies HTTP and WebSocket, injecting `window.__DSH_BRIDGE__` and the click script into `text/html` responses;
- keeps click detection heuristic (the official UI has no `<a href>`) and strict: a text node must *be* a path, an extension must start with a letter, and an attribute match returns only the matched span. Misses are reported with the real DOM to `/__bridge/log`.

Opening a file prefers the editor CLI (`code -r -g`) and falls back to the desktop portal (`vscode://file/...` through `xdg-desktop-portal`) — the only path that works when the bridge itself runs sandboxed.

</details>

<a id="further-exploration"></a>
## Further exploration

- The no-install minimal version lives beside this package: `dsh-bridge/` (single-process proxy plus `run.sh`).
- Related skills: `cordis-plugin-development` (Host/Client shape and Config), `cordis-composition-reference` (patch dialect).

<a id="known-limitations-and-deferred-work"></a>
## Known limitations

- **Loopback only**: the bridge holds the session cookie; never bind it to a non-loopback address.
- **One direction**: DSH → editor. The reverse (injecting an editor selection, applying hunks) needs a VS Code extension.
- **Heuristic click detection**: the official UI offers no link to intercept; a miss records the real DOM in the log so the rules can be tightened.
- **`launchMode: portal` is Linux-only**; on macOS and Windows use `editor` and run DSH inside a session.
- **Version coupling**: the cookie format is a DSH internal convention; a change there needs a matching update, and the failure reason is surfaced in the settings page.
- New files or non-git directories have no HEAD revision, so a diff degrades to opening the file.

**What this revision fixed (after an external code review)**

- **The bridge has a fence of its own now.** `Host` must be `127.0.0.1:<port>` / `localhost:<port>`; any request carrying a **foreign `Origin`**, or a `Sec-Fetch-Site: cross-site` subresource (a cross-site *document* navigation is still allowed, so a link or a pasted URL can never lock the IDE's own page out), is refused with 403 — on the **HTTP and the WebSocket upgrade paths alike** (a browser always sends `Origin` on a WS handshake, and WS gets no CORS protection). An origin-less request is a navigation or a subresource and is allowed: it can read nothing, and DNS rebinding is caught by the `Host` rule above. The upgrade handler used to strip `Origin`/`Sec-Fetch-Site` and forward, and DSH's fence treats "no Origin" as trusted, so **any web page could speak to `/api/remote.mux` as the operator**. A malformed `Host` could also throw synchronously inside the request listener, which DSH's fail-loud handler turns into `process.exit(1)`. Now the listener is wrapped, the handler chain has a `.catch`, an invalid `openCommand` fails instead of throwing, and the request body is bounded and abort-tolerant: **every failure degrades to a warning or a 500, never to a dead session.**
- **The token is back to being a CSRF token**: header only (a query token leaks into history, logs and `Referer`), and a token must be configured at start (both sides `undefined` used to compare equal).
- **The diff is real**: `--diff` was never passed, and an Alt+click launched the same command **twice** (the standalone sibling always had it right). It is now one `code -r --diff <HEAD snapshot> <file>`, degrading to a plain open only on failure.
- **No more leaked listeners**: `start()`/`adopt()` share one serial queue (the old `start()` only checked `handle`, which is assigned two awaits later, so two quick saves left several servers listening).
- **Clean shutdown**: `close()` destroys upgraded tunnels, and HEAD snapshots plus the self-test repo live under one per-instance scratch root (random name, `wx` writes) that is removed on close.
- **The event loop is no longer blocked**: git runs asynchronously (a diff click could previously freeze a session for 15s) and file tests cost one syscall instead of two.
- **Injected JSON escapes `<`**, so a session working directory containing `</script>` cannot end the script element early.

**Deliberate choices that stay**

- **Absolute paths and `..` are still allowed**: the UI shows paths outside the workspace, and that is a feature. The boundary is *who may ask* (fence + token), not *what may be asked for*.
- **Recognition stays strict**: a path buried mid-sentence, or one containing spaces, is not recognised — the `168 tok/s69.3M tok` false positive is why. Loosening needs a plan for false positives.
- **Diagnostics are not privilege-tiered** beyond `?limit`: whoever can speak on the bridge origin is already the page holding the token.

**Known, not done**

- The one-level directory scan is still synchronous I/O, with fewer syscalls and a lower cap; moving it to `fs/promises` is a separate change.
- The self-test repo and HEAD snapshots are cleaned when the bridge closes, not immediately (the editor still has to read them).

- **Anchor-first location.** A line number in `path:250` is a *snapshot* of the moment the message was written; edit the file and it goes stale — and going stale does not error, it silently delivers you to an unrelated line. Resolve `path` plus a unique snippet (a symbol, one line of code) against the file **at click time** instead, with three levels: anchor found and unique → its line; otherwise → the line the message carried; otherwise → just open the file. Then a wrong jump becomes impossible.
- **Echo the target line.** Read that line before opening and put it in the toast (`:250 · "token: deriveToken(secret),"`), so a bad jump is visible immediately. Nearly free.
- **Contribute a prompt section.** The host exposes `systemPrompt.section({ name, order, text })`, which a plugin may register in its own scope (a skill would work too). Direction: cite files as `path:line`; **omit the line when unsure** (a wrong line is worse than none); quote a unique snippet when citing code. It is advice, not a guarantee — and it cannot fix staleness.
- **Take over the official chip** (optional): `stopPropagation()` during capture suppresses DSH's own `onClick`, so clicking a chip no longer opens an extra DSH preview tab. The trade-off is that suppression must be optimistic (a failed editor call leaves only the toast), so it belongs behind a switch.
- **Make `decorate` a Config field.** The affordance switch currently has only the escape hatch `localStorage["dsh-web-bridge:decorate"] = "off"`; a real field costs one DSH restart.
- **Loosen recognition** (a trade-off): a path buried mid-sentence and a path containing spaces are both unrecognized today. Loosening needs a plan for false positives — the status line `168 tok/s69.3M tok` was nearly opened as a file once.

<a id="dev-note"></a>
### Dev note

<details>
<summary>Maintainer context — click to expand</summary>

```bash
for f in lib/*.js; do node --check "$f"; done   # one at a time: extra args are script arguments

# CI (.github/workflows/checks.yml) runs the three suites that need NO live DSH:
#   verify-click-match · verify-config-page · verify-resolve
# The other three are for a machine that has one: verify-host-apply needs the real
# schemastery/dsh-settings, and verify-live-config / verify-plugin need a running DSH
# plus $DSH_HOME/.credentials.yaml.
node verify-click-match.mjs    # matcher (anchors, CJK, spaces, dot-files, concatenations refused), token self-heal, the affordance, the toast, takeover states and hand-back (96 checks)
node verify-host-apply.mjs     # host half: volatile marks, the settings gate, live reads, session roots, token derivation, the prompt section (35 checks)
node verify-resolve.mjs        # resolution, the echo, anchors, the injected page config, a real diff (twice, with pruning), header hygiene (55 checks)
node verify-live-config.mjs    # real bridge: saved changes, relative paths, token stability, and no listener leaked by two quick saves (24 checks)
node verify-config-page.mjs    # both client seats, the writes they emit, the control colours (33 checks)
node verify-plugin.mjs 39989   # the bridge's own fence, its fatal paths and the self-test (22 checks; needs a live DSH)
node verify-support.mjs        # self-check: can the Harness's own schemastery / dsh-settings be found
# 281 checks in total
```

The verification scripts (including `verify-support.mjs`) are not in `files` and never ship. `lib/bridge.js` and `dsh-bridge/dsh-bridge-proxy.mjs` are two shapes of the same logic (in-plugin and standalone) and must be changed together — but they are **not** identical: the standalone is a functional **subset**. Missing there: the `roots` provider (no session store, so it relies on `--root` and never adds `$HOME`), anchors and the `#L`/`:line` suffixes, the one-level directory fallback, `resolvedBy`/`root`/`candidates` in the reply, and the newest recognition rules in `bridge-client.js` (porting them is queued). The plugin, in turn, has no `/__bridge/test` or `/__bridge/token`.

</details>

**Runtime invariants:** the plugin listens on loopback only and **trusts nothing but its own origin**:

- the `Host` must be one of its own names (this is what stops DNS rebinding);
- a foreign `Origin` is refused with 403 on HTTP **and** on the WebSocket upgrade;
- a `Sec-Fetch-Site: cross-site` subresource is refused; a cross-site **document** navigation is allowed, so an IDE page can never be locked out of its own bridge;
- on the **proxy** path a state-changing request (anything but GET/HEAD) must carry this bridge's own `Origin` — a browser always sends it, and it is what stops a local process from driving the full GUI API with no credential. It injects the operator's session cookie into everything it forwards, so this check is the whole boundary. The `/__bridge/*` diagnostics are exempt on purpose: they authenticate with the token, and a token is a credential (`curl -H "x-bridge-token: …"` keeps working).
  **What the token actually is:** the diagnostics need it, and `/__bridge/open` answers with the text of the target line — so a token is effectively *read any line of any file* on this machine, and it is inlined into every page the bridge serves. Treat it as a file-read credential, not merely as CSRF protection.

**Residual risk, stated plainly:** a *local process of another user* can forge `Origin`, so on a shared machine the loopback listener is still an escalation path — such a process cannot read your `~/.dsh` credentials, but it can use this port. Single-user machines are unaffected.

`ctx.effect` closes the bridge on unload; it adds no persistent state, and its only writes are the per-instance scratch root described above.

**About the token (a real failure this had):** the token guarding the bridge endpoints is **derived** from the durable signing secret (`deriveToken`), never random per activation — because a page outlives the bridge: restarting DSH remounts the plugin, and a loaded document can only learn a new token by being reloaded. Everything else survives (the proxied UI needs no token), so the symptom is "the UI looks alive and every click silently 403s". A derived token is the same for one Harness home forever: across restarts, remounts and plugin upgrades. The cost is that it cannot rotate on its own (rotate the DSH browser-session secret instead). The injected script adds one more layer: on a 403 it re-reads this document's HTML for a newer token and retries once, and only reloads the page (once per 20s) when that is impossible.

## License

MIT — see [LICENSE](./LICENSE).

<p align="right"><a href="#ni123niwjsjdsh-web-bridge">Back to top</a></p>
