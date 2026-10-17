// The bridge itself: a second loopback origin in front of the DSH Web GUI.
//
// Why it exists: DSH's /api fence rejects `Sec-Fetch-Site: cross-site` and
// requires Origin to equal Host, and the index needs the signed browser cookie
// (`HttpOnly; SameSite=Strict`, authority-bound). A page embedded in an IDE
// webview is cross-site and has no cookie, so it can never satisfy that fence.
// This server answers the embedder on its own loopback origin and speaks to DSH
// as a trusted, credential-holding client:
//   * mints the browser cookie from the durable signing secret
//   * strips Origin / Sec-Fetch-Site / Referer upstream
//   * strips Set-Cookie downstream, so the embedder never holds a credential
//   * proxies HTTP and WebSocket
//   * injects a small script so clicking a file path opens it in the editor
import { createHash, createHmac, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLICK_SCRIPT = fileURLToPath(new URL("./click-script.js", import.meta.url));
const COOKIE_PREFIX = "dsh-auth-";
const PAYLOAD_VERSION = 1;
const b64url = (buf) => Buffer.from(buf).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

/** Cookie name and value DSH accepts for one canonical authority. */
export function mintCookie(secret, authority, days = 30) {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + days * 24 * 60 * 60 * 1000;
  const body = b64url(Buffer.from(JSON.stringify({ version: PAYLOAD_VERSION, authority, issuedAt, expiresAt }), "utf8"));
  const signature = b64url(createHmac("sha256", secret).update(body).digest());
  const name = `${COOKIE_PREFIX}${b64url(createHash("sha256").update(authority).digest())}`;
  return { name, value: `v1.${body}.${signature}` };
}

/**
 * Run git without blocking the harness.
 *
 * The bridge lives inside the DSH process, so a synchronous `git show` with a 15s
 * timeout could freeze the agent loop — and the UI with it — for that long. Async
 * here, and a short timeout: a snapshot that cannot be produced in seconds is not
 * worth stalling a session for.
 */
const git = (args, cwd) =>
  new Promise((settle, fail) => {
    execFile("git", args, { cwd, encoding: "utf8", timeout: 4000 }, (error, stdout) =>
      error === null ? settle(String(stdout)) : fail(error),
    );
  });

/**
 * Scratch space shared by one bridge instance.
 *
 * HEAD snapshots and the self-test repo go in here instead of straight into the
 * system temp directory: a per-instance root means two checkouts with the same file
 * name cannot silently share a snapshot, the directory is created with a random name
 * that cannot be pre-created or symlinked, and `close()` removes the lot. The names
 * are still sanitised and hashed so a file name cannot escape the root.
 */
const makeScratch = () => mkdtempSync(join(tmpdir(), "dsh-web-bridge-"));

/** HEAD content of one tracked file, written into the given scratch root for `code --diff`. */
async function headSnapshot(file, scratch) {
  try {
    const repo = (await git(["rev-parse", "--show-toplevel"], dirname(file))).trim();
    const head = await git(["show", `HEAD:${relative(repo, file)}`], repo);
    const label = `${basename(file).replaceAll(/[^\w.-]/gu, "_")}-${createHash("sha256").update(file).digest("hex").slice(0, 12)}`;
    // `wx` refuses a path that already exists, symlink included — that is the point —
    // so the name has to be FRESH on every call. A fixed name made the SECOND diff of
    // the same file fail with EEXIST and silently degrade to a plain open.
    for (const stale of readdirSync(scratch).filter((name) => name.startsWith(`HEAD-${label}-`))) {
      // Only snapshots old enough that no request in flight can still be reading them:
      // deleting the file a concurrent diff was just handed shows an empty diff.
      const previous = join(scratch, stale);
      try {
        if (Date.now() - statSync(previous).mtimeMs > 60_000) rmSync(previous, { force: true });
      } catch {
        /* already gone */
      }
    }
    const target = join(scratch, `HEAD-${label}-${randomBytes(6).toString("hex")}`);
    writeFileSync(target, head, { encoding: "utf8", flag: "wx" });
    return { ok: true, repo, headFile: target };
  } catch (error) {
    return { ok: false, reason: String(error.stderr ?? error.message ?? error).trim().split("\n")[0] };
  }
}

/**
 * Open one file, preferring the editor CLI and falling back to the desktop
 * portal. The portal exists because a bridge running inside a sandbox cannot
 * make the snap `code` wrapper create its systemd transient scope.
 */
export function createLauncher({ openCommand = "code", launchMode = "auto", dryRun = false, argv } = {}) {
  /** The editor argv for one target: `code -r -g <file>:<line>` unless a caller says otherwise. */
  const editorArgs = (file, line) => (typeof argv === "function" ? argv(file, line) : ["-r", "-g", line ? `${file}:${line}` : file]);
  const spawnDetached = (command, args) =>
    new Promise((settle) => {
      if (dryRun) return settle({ ok: true, command: `${command} ${args.join(" ")}`, dryRun: true });
      // An empty or non-string command makes `spawn` throw synchronously; a config
      // field is user input, so that has to be a failed open, not an exception that
      // travels up into the request path.
      if (typeof command !== "string" || command.trim() === "") {
        return settle({ ok: false, command: "", error: "no editor command configured" });
      }
      let child;
      try {
        child = spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        return settle({ ok: false, command: `${command} ${args.join(" ")}`, error: error instanceof Error ? error.message : String(error) });
      }
      let stderr = "";
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        settle(result);
      };
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });
      child.once("error", (error) => finish({ ok: false, command: `${command} ${args.join(" ")}`, error: error.message }));
      child.once("exit", (code) => {
        const detail = stderr.trim().split("\n").filter(Boolean).slice(-2).join(" | ");
        if (code === 0) finish({ ok: true, command: `${command} ${args.join(" ")}`, ...(detail ? { stderr: detail } : {}) });
        else finish({ ok: false, command: `${command} ${args.join(" ")}`, error: `exit ${String(code)}${detail ? `: ${detail}` : ""}` });
      });
      setTimeout(() => {
        child.unref();
        finish({ ok: true, command: `${command} ${args.join(" ")}`, detached: true });
      }, 1500).unref();
    });

  const viaPortal = (file, line) =>
    new Promise((settle) => {
      const uri = `vscode://file${encodeURI(file)}${line ? `:${line}` : ""}`;
      const child = spawn(
        "gdbus",
        ["call", "--session", "--dest", "org.freedesktop.portal.Desktop", "--object-path",
          "/org/freedesktop/portal/desktop", "--method", "org.freedesktop.portal.OpenURI.OpenURI", "", uri, "{}"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.once("error", (error) => settle({ ok: false, uri, error: error.message }));
      child.once("exit", (code) =>
        settle(code === 0 && out.includes("objectpath")
          ? { ok: true, uri, via: "portal" }
          : { ok: false, uri, error: err.trim() || `gdbus exit ${String(code)}` }),
      );
    });

  return async function open(file, line) {
    if (launchMode === "portal") return viaPortal(file, line);
    const direct = await spawnDetached(openCommand, editorArgs(file, line));
    if (direct.ok && !direct.detached) return direct;
    if (launchMode === "editor") return direct;
    const portal = await viaPortal(file, line);
    return {
      ...portal,
      note: `${direct.detached ? "editor CLI did not hand off" : `editor CLI failed (${direct.error})`}; opened through the desktop portal`,
    };
  };
}

/**
 * Directories below each root whose immediate children are worth trying, one level
 * deep, for a relative path that resolved NOWHERE directly.
 *
 * People and models write paths relative to the directory they are working in —
 * `docs/TODO.md` from inside the project — while this bridge resolves relative
 * paths against the session working directory. That mismatch produced a real
 * failure (`no such file under …, /home/shuaige: docs/TODO.md`) and it is frequent
 * enough to be worth a fallback. One level, no recursion: it covers the habit
 * without widening the room for a wrong guess, and the caller only accepts an
 * unambiguous match.
 * @param roots - search roots, in priority order.
 * @param relativePath - the path as written, already free of a leading `./`.
 * @param options - `limit` bounds the directory entries examined per root.
 * @returns the matching absolute paths and how many entries were examined.
 */
export const scanOneLevel = (roots, relativePath, { limit = 400 } = {}) => {
  const matches = [];
  let scanned = 0;
  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // unreadable or vanished: not a reason to fail the whole search
    }
    for (const entry of entries.slice(0, limit)) {
      scanned += 1;
      // A regular file cannot have children; a directory or a symlink to one can,
      // and a symlink to a file simply yields a candidate that does not exist.
      if (entry.isFile()) continue;
      const candidate = resolve(root, entry.name, relativePath);
      try {
        if (statSync(candidate, { throwIfNoEntry: false })?.isFile() === true) matches.push(candidate);
      } catch {
        /* keep scanning */
      }
    }
  }
  return { matches, scanned };
};

/** How much of a file is read to answer "what is on line N" — bounds the cost. */
const PREVIEW_BYTES = 512 * 1024;

/**
 * What the target line says, and — when the whole file fit the window — how many
 * lines it has.
 *
 * The line number in a message is a snapshot: it can be stale, or simply wrong.
 * Echoing the line makes a bad jump visible at once instead of several seconds
 * later, and a number past the end of the file becomes an outright warning, which
 * is the easiest kind of mistake for a reader to catch.
 * @param file - an existing file.
 * @param line - 1-based line number, when one was requested.
 * @returns `{ lineText?, total?, beyond? }`; empty for a binary or unreadable file.
 */
export const peek = (file, line) => {
  const out = {};
  try {
    const complete = statSync(file).size <= PREVIEW_BYTES;
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(PREVIEW_BYTES);
      const read = readSync(fd, buffer, 0, PREVIEW_BYTES, 0);
      const lines = buffer.subarray(0, read).toString("utf8").split("\n");
      if (complete) out.total = lines.length - (lines[lines.length - 1] === "" ? 1 : 0);
      if (Number.isFinite(line) && line > 0) {
        const raw = lines[line - 1];
        if (raw !== undefined) out.lineText = raw.replace(/\r$/u, "").trim().slice(0, 160);
        else if (complete) out.beyond = true;
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    /* binary, permission, or a race: no preview is not a failure to open */
  }
  return out;
};

/**
 * The first line containing `anchor`, literally, plus how many lines contain it.
 *
 * An anchor is what makes a jump survive an edit: the line number in a message is a
 * snapshot of the moment it was written, while a piece of text that was unique then
 * is usually still unique later, and it is resolved against the file **at click
 * time**. The search is a plain literal, case-sensitive substring test — no language
 * parsing, no fuzzy matching — over the same bounded window `peek()` uses.
 * @param file - an existing file.
 * @param anchor - the text to look for.
 * @param options - `limit` caps the anchor length (a whole file is not an anchor).
 * @returns `{ line?, matches, truncated? }`; `matches: 0` also means "unreadable".
 */
export const findAnchor = (file, anchor, { limit = 120 } = {}) => {
  const needle = typeof anchor === "string" ? anchor.trim() : "";
  if (needle === "" || needle.length > limit) return { matches: 0 };
  try {
    const truncated = statSync(file).size > PREVIEW_BYTES;
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(PREVIEW_BYTES);
      const read = readSync(fd, buffer, 0, PREVIEW_BYTES, 0);
      let first;
      let matches = 0;
      for (const [index, raw] of buffer.subarray(0, read).toString("utf8").split("\n").entries()) {
        if (!raw.includes(needle)) continue;
        matches += 1;
        if (first === undefined) first = index + 1;
      }
      return { ...(first === undefined ? {} : { line: first }), matches, ...(truncated ? { truncated: true } : {}) };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { matches: 0 };
  }
};

/** Start the bridge. Returns the URL, the live state, and a close function. */
export function startBridge(options) {
  const {
    port = 39977,
    upstream = "127.0.0.1:3080",
    roots = [],
    clientConfig = undefined,
    injectClickScript = true,
    token,
    secret,
    onEvent = () => {},
  } = options;
  if (!secret || secret.byteLength !== 32) throw new Error("dsh-web-bridge: a 32-byte signing secret is required");
  // A tokenless bridge would compare `undefined === undefined` and admit everyone.
  if (typeof token !== "string" || token.trim().length < 8) throw new Error("dsh-web-bridge: a request token of at least 8 characters is required");
  const scratch = makeScratch();

  const [upHost, upPort] = String(upstream).replace(/^https?:\/\//u, "").split("/")[0].split(":");
  const UPSTREAM = `${upHost}:${upPort}`;
  /**
   * The directories a relative path is tried under, computed on EVERY use.
   *
   * `roots` may be a function because the set is not a property of the bridge:
   * the page shows paths relative to the working directory of whichever session
   * wrote them (`dsh-web-bridge/lib/bridge.js`, not an absolute path), and
   * sessions come and go while this origin stays up. Evaluating per request is
   * what makes a newly started session clickable without a restart — and it is
   * why the user does not have to list every project by hand.
   */
  const readRoots = () => {
    let configured;
    try {
      configured = typeof roots === "function" ? roots() : roots;
    } catch {
      /* a failing provider must not break resolution for the built-ins */
    }
    return [...new Set([...(configured ?? []), process.cwd(), homedir()])]
      .filter((path) => typeof path === "string" && path !== "")
      .map((path) => resolve(path));
  };
  /**
   * Whatever the row wants the PAGE to know, read fresh on every index render.
   *
   * These decide client behaviour only — whether a click on the official chip is
   * taken over, whether recognised paths get their affordance — so a saved switch
   * must reach the next page load without rebuilding the bridge underneath it.
   */
  const readClientConfig = () => {
    try {
      const value = typeof clientConfig === "function" ? clientConfig() : clientConfig;
      return typeof value === "object" && value !== null ? value : {};
    } catch {
      return {};
    }
  };

  // The bridge exists to relax DSH's own fence for pages IT served — so it has to
  // impose its own, with its own origin as the trust anchor. Without this, the fence
  // we strip upstream is simply re-exposed: any local process, and any web page via
  // DNS rebinding, could speak to the session as the operator.
  const AUTHORITIES = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  /** Whether the request addresses this bridge by one of its own names. Blocks DNS rebinding. */
  const hostAllowed = (req) => {
    const host = String(req.headers.host ?? "").toLowerCase();
    if (AUTHORITIES.has(host)) return true;
    return host === "" && String(req.httpVersion ?? "").startsWith("1.0");
  };
  /**
   * Whether the request comes from a context entitled to act for the operator.
   *
   * A browser always names the origin on a fetch, an XHR and a WebSocket handshake —
   * and a WebSocket handshake gets no CORS protection at all — so a foreign origin is
   * refused outright. An absent origin is a navigation (pasted URL, IDE webview), a
   * no-cors subresource, or a non-browser client: rebinding is already caught by the
   * Host rule above, a cross-origin page cannot read any response without a CORS
   * grant, and the state-changing routes need a header-only token. Refusing those too
   * would risk locking the IDE's own page out of its own bridge.
   */
  const originAllowed = (req) => {
    const site = String(req.headers["sec-fetch-site"] ?? "").toLowerCase();
    const dest = String(req.headers["sec-fetch-dest"] ?? "").toLowerCase();
    // A cross-site fetch, XHR or WebSocket is refused. A cross-site *document*
    // navigation is the one exception, so a link or a pasted URL can never lock the
    // IDE's own page out of its own bridge.
    if (site === "cross-site" && dest !== "document") return false;
    const origin = req.headers.origin;
    if (origin === undefined || origin === null || origin === "") return true;
    try {
      return AUTHORITIES.has(new URL(String(origin)).host.toLowerCase());
    } catch {
      return false; // including the literal `null` origin
    }
  };
  /** Refuse with a status the caller can read, and never with a thrown error. */
  const refuse = (res, status, reason) => {
    try {
      json(res, status, { ok: false, error: reason });
    } catch {
      /* the socket is already gone */
    }
    return true;
  };

  const open = createLauncher(options);
  const events = [];
  const record = (event) => {
    events.push({ at: new Date().toISOString(), ...event });
    if (events.length > 300) events.splice(0, events.length - 300);
    onEvent(event);
  };

  let cookie = mintCookie(secret, UPSTREAM, 1);
  const cookieHeader = () => `${cookie.name}=${cookie.value}`;
  const refresh = setInterval(() => {
    cookie = mintCookie(secret, UPSTREAM, 1);
  }, 6 * 60 * 60 * 1000);
  refresh.unref?.();

  const resolveFile = (input) => {
    if (typeof input !== "string" || input.trim() === "") return { error: "file is required" };
    let text = input.trim().replace(/^file:\/\//u, "").replaceAll("\\", "/");
    let line;
    let anchor;
    // A trailing `#…` is a fragment: `#L24` / `#L24-L30` are line numbers (the form
    // DSH's own file-reference prompt teaches), anything else is an anchor.
    const hash = text.match(/^(.*)#([^#]+)$/u);
    if (hash !== null) {
      const fragment = hash[2].trim();
      const asLine = fragment.match(/^L(\d{1,6})(?:-L?(\d{1,6}))?$/u);
      if (asLine !== null) {
        text = hash[1];
        line = Number(asLine[1]);
      } else if (fragment !== "") {
        text = hash[1];
        anchor = fragment;
      }
    }
    const at = text.match(/^(.*?):(\d{1,6})(?:[-:]\d{1,5})?$/u);
    if (at) {
      text = at[1];
      line = Number(at[2]);
    }
    const searchRoots = readRoots();
    const relativeText = text.replace(/^\.\//u, "");
    // `readRoots()` always ends with the process working directory and $HOME, so
    // every relative hit is a root hit; an absolute path has no root to name.
    const direct = isAbsolute(text)
      ? [{ path: text, root: undefined }]
      : searchRoots.map((root) => ({ path: resolve(root, relativeText), root }));
    for (const candidate of direct) {
      try {
        // One syscall instead of two (`existsSync` + `statSync`), and never a throw.
        if (statSync(candidate.path, { throwIfNoEntry: false })?.isFile() === true) {
          return { file: candidate.path, line, anchor, resolvedBy: candidate.root === undefined ? "absolute" : "root", ...(candidate.root === undefined ? {} : { root: candidate.root }) };
        }
      } catch {
        /* keep looking */
      }
    }

    // Nothing directly. The path may have been written relative to a SUBDIRECTORY
    // of a root — the habit that produced this fallback. Accept only one match:
    // opening a plausible-but-wrong file silently is worse than refusing.
    if (!isAbsolute(text)) {
      const { matches, scanned } = scanOneLevel(searchRoots, relativeText);
      if (matches.length === 1) {
        return { file: matches[0], line, anchor, resolvedBy: "scan", root: dirname(dirname(matches[0])) };
      }
      if (matches.length > 1) {
        return { error: `${text} exists in ${matches.length} places, so this bridge will not guess`, candidates: matches, searched: searchRoots };
      }
      return { error: `no such file under ${searchRoots.join(", ")}: ${input}`, searched: searchRoots, scanned };
    }
    return { error: `no such file under ${searchRoots.join(", ")}: ${input}`, searched: searchRoots };
  };

  /** Whether a failed editor CLI may be retried through the desktop portal. */
  const launchModeAllowsPortal = (options) => (options?.launchMode ?? "auto") === "auto";

  const openInEditor = async ({ file, line, anchor, diff }) => {
    const found = resolveFile(file);
    // Forward EVERY piece of search metadata on the failure: "which directories did
    // it try, how much did it look at, and was it ambiguous" is the whole answer to
    // a `no such file`, and a field dropped here is a field the reader cannot see.
    if (found.error) {
      const { error, ...search } = found;
      return { ok: false, error, ...search };
    }
    const askedLine = Number(line);
    const wanted = found.line ?? (Number.isFinite(askedLine) && askedLine > 0 ? askedLine : undefined);
    const needle = found.anchor ?? (typeof anchor === "string" && anchor.trim() !== "" ? anchor.trim() : undefined);

    // Anchor first, line second, plain open last: the anchor is the only one of the
    // three that is still right after the file has changed underneath the message.
    let at = wanted;
    let tracedAnchor = {};
    if (needle !== undefined) {
      const search = findAnchor(found.file, needle);
      if (search.line !== undefined) {
        at = search.line;
        tracedAnchor = { anchor: needle, anchorLine: search.line, anchorMatches: search.matches };
      } else {
        tracedAnchor = { anchor: needle, anchorMatches: 0, anchorMissed: true, ...(search.truncated === true ? { anchorPartial: true } : {}) };
      }
    }

    // Where it was found, and what is actually on that line: together they turn a
    // wrong jump from a silent surprise into something readable in the toast.
    const traced = { resolvedBy: found.resolvedBy, ...(found.root === undefined ? {} : { root: found.root }), ...tracedAnchor, ...peek(found.file, at) };
    if (diff) {
      const snapshot = await headSnapshot(found.file, scratch);
      if (snapshot.ok) {
        // ONE launch, with the real diff argv: `code -r --diff <HEAD snapshot> <file>`.
        // (The previous version ran the plain open first and then the same command
        // again, and never passed `--diff` at all.)
        const differ = createLauncher({ ...options, argv: () => ["-r", "--diff", snapshot.headFile, found.file] });
        const result = await differ(found.file, at);
        const degraded = result.ok !== true && launchModeAllowsPortal(options);
        const fallback = degraded ? await open(found.file, at) : result;
        return {
          ...fallback,
          mode: fallback.via === "portal" ? "open" : "diff",
          file: found.file,
          line: at,
          headFile: snapshot.headFile,
          repo: snapshot.repo,
          ...(fallback === result ? {} : { note: `diff degraded to a plain open (${result.error ?? "editor refused"})` }),
          ...traced,
        };
      }
      return { ...(await open(found.file, at)), mode: "open", file: found.file, line: at, note: `diff unavailable (${snapshot.reason})`, ...traced };
    }
    return { ...(await open(found.file, at)), mode: "open", file: found.file, line: at, ...traced };
  };

  // Header only: a token in a URL ends up in history, logs and `Referer`, and the
  // state-changing routes answer GET. The comparison also has to reject the case
  // where neither side is set — that is how a tokenless bridge would open wide.
  const authorized = (req) => {
    const offered = req.headers["x-bridge-token"];
    return typeof offered === "string" && offered !== "" && offered === token;
  };
  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body, null, 2));
  };
  /** Largest request body this bridge will read; anything past it is ignored. */
  const MAX_BODY_BYTES = 64 * 1024;
  /**
   * Read a JSON body without ever rejecting.
   *
   * A client that closes mid-body (a user closing the tab during a click; anything
   * local sending a content-length it never fulfils) makes the async iterator throw
   * `ECONNRESET`. That must land as "no body" — a 400 from the caller — and never as
   * an unhandled rejection, which DSH's fail-loud handler turns into `process.exit(1)`.
   * @returns the parsed object, or `{}` when it is absent, too large, or truncated.
   */
  const readBody = async (req) => {
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) return {};
        chunks.push(chunk);
      }
    } catch {
      return {};
    }
    if (chunks.length === 0) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  };

  /**
   * Probe the HEAD snapshot and the open path inside a throwaway git repo.
   *
   * The open probe is DRY by default. A self-test that launches the user's editor
   * is a self-test that pops a window on someone's screen — and a probe of line 3
   * in a one-line file is precisely the mistake `peek()` exists to warn about, so
   * it must not be the self-test's own example. `live: true` (`?live=1`) exists for
   * a human who actually wants to watch it open.
   * @param options - `live` runs the real launcher instead of the dry one.
   * @returns the checks, the temp repo, and the launcher result.
   */
  const selfTest = async ({ live = false } = {}) => {
    // Inside the bridge's scratch root, so `close()` removes it too.
    const dir = mkdtempSync(join(scratch, "selftest-"));
    const file = join(dir, "sample.txt");
    const args = ["-c", "user.email=bridge@local", "-c", "user.name=bridge"];
    try {
      // The same async helper as everything else: no synchronous git anywhere in a
      // process that also serves the agent loop.
      await git(["init", "-q"], dir);
      writeFileSync(file, "one\n", "utf8");
      await git([...args, "add", "sample.txt"], dir);
      await git([...args, "commit", "-qm", "base"], dir);
      writeFileSync(file, "two\n", "utf8");
    } catch (error) {
      return { ok: false, error: `selftest setup failed: ${error.message}` };
    }
    const snapshot = await headSnapshot(file, scratch);
    // Line 1, which exists — and assert it, so the probe cannot drift into asking
    // for a line the file does not have.
    const opened = await createLauncher({ ...options, dryRun: !live })(file, 1);
    const preview = peek(file, 1);
    let headContent;
    try {
      headContent = readFileSync(snapshot.headFile ?? "", "utf8").trim();
    } catch {
      headContent = undefined;
    }
    const checks = {
      snapshotOk: snapshot.ok === true && headContent === "one",
      openOk: typeof opened.command === "string" || typeof opened.uri === "string",
      dryRun: opened.dryRun === true,
      targetLineOk: preview.lineText === "two" && preview.total === 1,
    };
    return { ok: Object.values(checks).every(Boolean), checks, tempRepo: dir, headContent, open: opened };
  };

  const handleBridge = async (req, res, url) => {
    if (url.pathname === "/__bridge/client.js") {
      let script;
      try {
        script = readFileSync(CLICK_SCRIPT);
      } catch (error) {
        // The file can vanish between requests; that is a 500, not a dead session.
        return refuse(res, 500, `click script unreadable: ${error instanceof Error ? error.message : String(error)}`);
      }
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(script);
      return true;
    }
    if (!authorized(req)) {
      json(res, 403, { ok: false, error: "missing or wrong bridge token" });
      return true;
    }
    if (url.pathname === "/__bridge/ping") {
      json(res, 200, { ok: true, upstream: UPSTREAM, roots: readRoots(), injectClickScript, events: events.length });
      return true;
    }
    if (url.pathname === "/__bridge/log") {
      const asked = Number(url.searchParams.get("limit") ?? 50);
      // A non-numeric limit must not silently mean "everything".
      const limit = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), 300) : 50;
      json(res, 200, { ok: true, total: events.length, limit, events: events.slice(-limit) });
      return true;
    }
    if (url.pathname === "/__bridge/open" || url.pathname === "/__bridge/diff") {
      const body = req.method === "POST" ? await readBody(req) : Object.fromEntries(url.searchParams);
      const result = await openInEditor({ ...body, diff: url.pathname.endsWith("diff") || body.diff === true });
      record({ kind: url.pathname.slice("/__bridge/".length), request: body, result });
      json(res, result.ok ? 200 : 400, result);
      return true;
    }
    if (url.pathname === "/__bridge/report") {
      record({ kind: "click", ...(await readBody(req)) });
      json(res, 200, { ok: true });
      return true;
    }
    if (url.pathname === "/__bridge/selftest") {
      // `?live=1` is the escape hatch for a human who wants to see the editor open.
      json(res, 200, await selfTest({ live: url.searchParams.get("live") === "1" }));
      return true;
    }
    return false;
  };

  const upstreamHeaders = (headers) => {
    const out = { ...headers };
    delete out.origin;
    delete out.referer;
    delete out["sec-fetch-site"];
    delete out["sec-fetch-mode"];
    delete out["sec-fetch-dest"];
    out.host = UPSTREAM;
    out["accept-encoding"] = "identity";
    out.cookie = cookieHeader();
    // Our own credential must not travel upstream: it opens any file on this machine, and
    // anything inside the DSH process (a logger, an interceptor, a gateway) could keep it.
    delete out["x-bridge-token"];
    return out;
  };

  const downstreamHeaders = (headers, extra = {}) => {
    const out = { ...headers, ...extra };
    delete out["set-cookie"];
    delete out["x-frame-options"];
    if (typeof out["content-security-policy"] === "string") {
      out["content-security-policy"] = out["content-security-policy"]
        .split(";")
        .filter((part) => !part.trim().toLowerCase().startsWith("frame-ancestors"))
        .join(";");
    }
    return out;
  };

  // D1: which revision of the click script a page is running. It is read from disk per
  // request (so it can be updated without a restart), which makes "the page is running an
  // older copy" a real possibility — this is what makes it visible in the log.
  const clientRev = (() => {
    try {
      return createHash("sha256").update(readFileSync(CLICK_SCRIPT)).digest("hex").slice(0, 8);
    } catch {
      return null;
    }
  })();

  const injectIntoHtml = (html) => {
    // `<` is escaped because a session working directory or a configured root can
    // contain `</script>`, which would otherwise end the element early.
    const config = `<script>window.__DSH_BRIDGE__=${JSON.stringify({ token, roots: readRoots(), clientRev, ...readClientConfig() }).replaceAll("<", "\\u003c")};</script>`;
    const script = '<script src="/__bridge/client.js" defer></script>';
    let out = /<head[^>]*>/iu.test(html) ? html.replace(/<head[^>]*>/iu, (tag) => `${tag}${config}`) : `${config}${html}`;
    return /<\/body>/iu.test(out) ? out.replace(/<\/body>/iu, `${script}</body>`) : `${out}${script}`;
  };

  /**
   * Whether a state-changing request may travel down the PROXY path.
   *
   * The proxy injects the operator's session cookie into everything it forwards, so
   * without this check any local process — `curl -H "Host: 127.0.0.1:<port>"` is the
   * whole exploit — could drive the full GUI API without ever presenting a credential.
   * The fence above only compares a `Host` header, which is not authentication.
   *
   * A browser always sends `Origin` on a request that is neither GET nor HEAD, so
   * requiring it costs the embedded page nothing and closes the local-process path.
   * The diagnostic routes are exempt on purpose: they authenticate with the token, and
   * a token IS a credential, so `curl -H "x-bridge-token: …"` keeps working.
   */
  const mutationAllowed = (req) => {
    const method = String(req.method ?? "GET").toUpperCase();
    if (method === "GET" || method === "HEAD") return true;
    const origin = req.headers.origin;
    if (origin === undefined || origin === null || origin === "") return false;
    try {
      return AUTHORITIES.has(new URL(String(origin)).host.toLowerCase());
    } catch {
      return false;
    }
  };

  /** Forward one request to the running DSH server, injecting the click script on HTML. */
  const proxy = (req, res, url) => {
    const proxied = httpRequest(
      // `url.pathname + url.search`, never `req.url`: an absolute-form target
      // (`GET http://evil.example/x`) would otherwise be passed upstream verbatim.
      { host: upHost, port: Number(upPort), method: req.method, path: `${url.pathname}${url.search}`, headers: upstreamHeaders(req.headers) },
      (upstreamRes) => {
        const type = String(upstreamRes.headers["content-type"] ?? "");
        const encoding = String(upstreamRes.headers["content-encoding"] ?? "").toLowerCase();
        // Rewriting the body means this side owns its length and framing, and a
        // body we cannot decode must pass through untouched.
        const injectable =
          injectClickScript &&
          upstreamRes.statusCode === 200 &&
          type.includes("text/html") &&
          (encoding === "" || encoding === "identity");
        if (!injectable) {
          res.writeHead(upstreamRes.statusCode ?? 502, downstreamHeaders(upstreamRes.headers));
          upstreamRes.pipe(res);
          return;
        }
        const chunks = [];
        upstreamRes.on("data", (chunk) => chunks.push(chunk));
        upstreamRes.on("end", () => {
          const body = Buffer.from(injectIntoHtml(Buffer.concat(chunks).toString("utf8")), "utf8");
          const headers = downstreamHeaders(upstreamRes.headers, {
            "content-type": "text/html; charset=utf-8",
            "content-length": String(body.byteLength),
          });
          delete headers["transfer-encoding"];
          delete headers["content-encoding"];
          res.writeHead(upstreamRes.statusCode ?? 200, headers);
          res.end(body);
        });
      },
    );
    proxied.on("error", (error) => {
      try {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end(`dsh-web-bridge: upstream error: ${error.message}\n`);
      } catch {
        /* the client is already gone */
      }
    });
    req.pipe(proxied);
  };

  const server = createServer((req, res) => {
    // Everything below runs inside one try: a synchronous throw in a request listener
    // is an uncaught exception, and DSH answers those with process.exit(1). The base
    // is a constant on purpose — a malformed `Host` used to be parsed straight into a
    // URL, which threw before any of this could answer.
    try {
      if (!hostAllowed(req) || !originAllowed(req)) {
        refuse(res, 403, "this bridge answers only its own origin");
        return;
      }
      // An absolute-form target is a different request than the one this authority was
      // asked for; there is no reason to serve it.
      if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(String(req.url ?? ""))) {
        refuse(res, 400, "absolute-form request targets are not accepted");
        return;
      }
      const url = new URL(req.url ?? "/", "http://bridge.invalid");
      if (url.pathname.startsWith("/__bridge/")) {
        void handleBridge(req, res, url)
          .then((handled) => {
            if (!handled) json(res, 404, { ok: false, error: `unknown bridge route ${url.pathname}` });
          })
          .catch((error) => {
            // Every failure degrades to a warning and a 500 — never to a dead session.
            record({ kind: "error", route: url.pathname, error: error instanceof Error ? error.message : String(error) });
            console.warn?.("dsh-web-bridge: bridge route failed:", error);
            refuse(res, 500, error instanceof Error ? error.message : String(error));
          });
        return;
      }
      if (!mutationAllowed(req)) {
        // Recorded, so the settings page can show WHY something was refused.
        record({ kind: "refused", method: req.method, route: url.pathname, reason: "state-changing request without a same-origin Origin" });
        refuse(res, 403, "a state-changing request on the proxy path must come from this bridge's own origin");
        return;
      }
      proxy(req, res, url);
    } catch (error) {
      console.warn?.("dsh-web-bridge: request handling failed:", error);
      refuse(res, 400, "malformed request");
    }
  });

  /** Live upgraded tunnels, so `close()` can actually end them. */
  const tunnels = new Set();

  server.on("upgrade", (req, socket, head) => {
    // The WebSocket handshake is where the upstream fence is thinnest: browsers apply
    // no CORS to it, so without a check here ANY page could speak to the session mux
    // as the operator. Same rule as the HTTP side, and never a forwarded foreign Origin.
    try {
      if (!hostAllowed(req) || !originAllowed(req)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
    } catch {
      socket.destroy();
      return;
    }
    tunnels.add(socket);
    socket.on("close", () => tunnels.delete(socket));
    const upstreamSocket = netConnect(Number(upPort), upHost, () => {
      const headers = upstreamHeaders(req.headers);
      const lines = [
        `${req.method} ${req.url} HTTP/1.1`,
        ...Object.entries(headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`),
      ];
      upstreamSocket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    tunnels.add(upstreamSocket);
    upstreamSocket.on("close", () => tunnels.delete(upstreamSocket));
    const close = () => {
      upstreamSocket.destroy();
      socket.destroy();
    };
    upstreamSocket.on("error", close);
    socket.on("error", close);
    socket.on("close", () => upstreamSocket.destroy());
  });

  return new Promise((settle, fail) => {
    server.once("error", (error) => fail(new Error(`dsh-web-bridge: cannot listen on 127.0.0.1:${port}: ${error.message}`)));
    server.listen(port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${port}/`;
      record({ kind: "start", url, upstream: UPSTREAM });
      settle({
        url,
        port,
        upstream: UPSTREAM,
        roots: readRoots(),
        token,
        close: () =>
          new Promise((done) => {
            clearInterval(refresh);
            // `server.close()` waits for connections, and upgraded sockets are no longer
            // the server's to wait for — so end them explicitly, then clean the scratch.
            for (const tunnel of tunnels) tunnel.destroy();
            tunnels.clear();
            server.close(() => {
              rmSync(scratch, { recursive: true, force: true });
              done();
            });
            server.closeAllConnections?.();
          }),
        status: () => ({
          url,
          port,
          upstream: UPSTREAM,
          roots: readRoots(),
          injectClickScript,
          events: events.length,
          lastEvents: events.slice(-5),
        }),
      });
    });
  });
}
