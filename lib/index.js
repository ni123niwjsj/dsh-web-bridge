// Host half: own the bridge's lifecycle and tell the Web page where it is.
//
// The bridge runs in this process (no child process, no CLI), so the plugin's
// install/uninstall and its Config are the whole story:
//   * `credentials` supplies the durable browser-session signing secret;
//   * `webServer.tapIndex` injects a status global into the served index, which
//     the Client half's settings page reads;
//   * every Config field is marked `.volatile()`, which is what gives this row a
//     settings namespace at all AND what lets a saved value reach the running
//     bridge without remounting it;
//   * the page's request token is DERIVED from that secret, never random, so a
//     page loaded before a restart keeps working (see `deriveToken`).
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { startBridge } from "./bridge.js";

/**
 * Derive the bridge's request token from the durable signing secret.
 *
 * It must NOT be random per activation. A page outlives the bridge that served
 * it: restarting DSH remounts this plugin, and the document keeps whatever token
 * it was loaded with, because a page can only learn a new one by being reloaded.
 * Everything else survives a restart — the proxied UI needs no token at all — so
 * a rotating token shows up as "the UI looks alive but every click silently
 * fails with `missing or wrong bridge token`", which is the bug this removes.
 *
 * `client-connection/browser-session` is written once per Harness home and is not
 * rewritten on restart, so one install always derives one token: across
 * restarts, remounts and plugin upgrades, with no state of its own to store,
 * migrate or clean up.
 *
 * The cost is that it cannot rotate on its own — rotating means rotating the DSH
 * browser-session secret. That is the right coupling: this token only guards
 * loopback endpoints that open a file, and rotating it would just recreate the
 * failure above.
 * @param secret - the 32-byte browser-session secret.
 * @returns 24 hex characters, the same shape the standalone proxy persists.
 */
export const deriveToken = (secret) =>
  createHmac("sha256", secret).update("dsh-web-bridge/v1/bridge-token").digest("hex").slice(0, 24);

/**
 * Load `@deepseek-ai/schemastery` so the row gets a Config schema — the source
 * of the form the Harness renders and of the `serialize`/defaults behaviour the
 * Loader parses this entry's config with.
 *
 * A profile-installed bundle that is a workspace link has no dependency tree of
 * its own, so a bare import fails. The Harness ships this package next to its
 * CLI, so resolution is retried from the CLI's location — the same file the
 * Harness itself imports, which keeps schema objects identical.
 */
const loadSchema = async (specifier = "@deepseek-ai/schemastery") => {
  const bases = [import.meta.url, process.argv[1], process.env.DSH_CLI].filter(
    (value) => typeof value === "string" && value !== "",
  );
  for (const base of bases) {
    try {
      const resolved = createRequire(base).resolve(specifier);
      const module = await import(pathToFileURL(resolved).href);
      if (module?.default !== undefined) return module.default;
    } catch {
      /* try the next base */
    }
  }
  return undefined;
};

/**
 * Mark one Config field as editable from the settings surfaces.
 *
 * `schemastery`'s `.volatile()` is the only mark `dsh-settings` projects a form
 * from: `describe()` runs the plugin schema through its private `volatileForm()`
 * and DROPS the entry when that yields nothing, so an object schema with no
 * marked field has no namespace at all — `configForms.get()` answers
 * `unavailable` and no page can offer a form, however the entry is configured.
 *
 * The mark also changes what the field PARSES to: a frozen live reference the
 * Loader rewrites in place instead of remounting this plugin. That is why every
 * read goes through {@link readRowSettings} and why a saved change arrives as a
 * `loader/volatile-update` event rather than a second `apply`.
 */
const markVolatile = (schema) => (typeof schema?.volatile === "function" ? schema.volatile() : schema);

/**
 * Build this row's Config schema. Exported so the test suite can drive the real
 * field set with a real schemastery, which a standalone test cannot always
 * resolve on its own.
 */
export const buildConfig = (z) =>
  z.object({
    port: markVolatile(z.natural().min(1).max(65535).default(39977)).description("Port of the extra loopback origin that serves this DSH Web GUI to IDE webviews."),
    upstream: markVolatile(z.string().default("127.0.0.1:3080")).description("The running DSH Web server to proxy, as host:port."),
    roots: markVolatile(z.array(z.string()).default([])).description("Extra directories a relative path from the UI may resolve against. The process working directory and your home directory are always included."),
    injectClickScript: markVolatile(z.boolean().default(true)).description("Inject the script that opens a clicked file path in your editor. Turn off for a plain proxy."),
    autoStart: markVolatile(z.boolean().default(true)).description("Start the bridge when this plugin activates."),
    openCommand: markVolatile(z.string().default("code")).description("Editor CLI used to open a file, e.g. code, codium, or an absolute path."),
    hijackChip: markVolatile(z.union([z.const("off"), z.const("auto"), z.const("on")]).default("off")).description("Whether a click on the official file chip is taken over so only your editor opens: off keeps the Harness viewer open too (default), on always takes over, auto takes over only inside an IDE shell (detected from the page)."),
    decorate: markVolatile(z.boolean().default(true)).description("Underline and cursor on every path this plugin recognises, so it looks clickable. Off leaves the page untouched."),
    launchMode: markVolatile(z.union([z.const("auto"), z.const("editor"), z.const("portal")]).default("auto")).description("auto: editor CLI first, then the desktop portal. editor: CLI only. portal: vscode:// URI through xdg-desktop-portal (Linux)."),
  });

const z = await loadSchema();
let Config;
try {
  if (z === undefined) throw new Error("schemastery not resolvable");
  Config = buildConfig(z);
} catch {
  Config = undefined;
}
export { Config };

/**
 * Whether a parsed config value is a Loader volatile reference.
 *
 * Duck-typed on what `createVolatile` produces — a frozen object carrying
 * `get()` — rather than on cosmokit's private write symbol, because cosmokit is
 * not a peer of this bundle. Parsed config is plain JSON, which is never frozen,
 * so the test cannot misfire on an ordinary field.
 */
export const isVolatileRef = (value) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.isFrozen(value) &&
  typeof value.get === "function";

/**
 * Read this row's config as plain settings.
 *
 * Every marked field is read through `.get()` FRESH on each call, because a
 * reference's identity is stable while its value changes. A field that is not a
 * reference passes through, which also keeps a plain object (a unit test, or a
 * Harness whose schemastery predates the mark) readable.
 * @param config - the config object `apply` received.
 * @returns every setting with its schema default applied.
 */
export const readRowSettings = (config) => {
  const source = typeof config === "object" && config !== null ? config : {};
  const plain = {};
  for (const [field, value] of Object.entries(source)) {
    plain[field] = isVolatileRef(value) ? value.get() : value;
  }
  return {
    port: plain.port ?? 39977,
    upstream: plain.upstream ?? "127.0.0.1:3080",
    roots: Array.isArray(plain.roots) ? plain.roots : [],
    injectClickScript: plain.injectClickScript !== false,
    autoStart: plain.autoStart !== false,
    openCommand: plain.openCommand ?? "code",
    launchMode: plain.launchMode ?? "auto",
    hijackChip: plain.hijackChip ?? "off",
    decorate: plain.decorate !== false,
  };
};

/**
 * The one thing the Harness's own file-reference guidance does not say.
 *
 * DSH already ships `ui:deliverable-file-references`, which tells the model to link
 * every file mention to a path relative to the working directory and to append
 * `#L24` / `#L24-L30` for a known line. What it cannot say is that a line number is
 * a *snapshot*: it is right when written and wrong after the next edit. An anchor is
 * text the bridge looks up in the file at click time, which is why this section only
 * adds the anchor and the "do not invent a line" rule instead of repeating the rest.
 */
export const FILE_ANCHOR_PROMPT = [
  "When you cite a file you may anchor it to text that appears inside it: write `path#<text>` (for example `lib/index.js#deriveToken`).",
  "The editor bridge resolves that text against the file at click time, so the jump still lands correctly after the file changes.",
  "`#L24` and `#L24-L30` still mean a line or a range; anything else after `#` is an anchor, matched literally and case-sensitively, and the first match wins.",
  "Prefer an anchor when the line may move, keep `path:line` when it is stable, and never invent a line number — if you are not sure of it, write the path alone.",
  "When the point is to jump to a particular place, write that reference as inline code rather than a Markdown link: a link is opened by the Harness's own viewer in a new tab, while inline code opens in the editor directly.",
].join(" ");

/** Ready only when the signing secret's owner exists. */
export const inject = ["credentials", "webServer"];

/**
 * Directories a relative path from the page is resolved against, in priority order.
 *
 * The page shows a path the way the session wrote it (`dsh-web-bridge/lib/bridge.js`,
 * not an absolute path), and the bridge's own working directory is `/home/shuaige/code`
 * — the PARENT of the project — so it resolves nothing on its own. The `sessions`
 * service carries the answer: each live session's immutable `header.cwd`, which
 * covers agent sessions and their subagents (every one gets its own session).
 *
 * Sessions appear and disappear while this row stays active, so this is evaluated
 * per click rather than captured at activation: a session started after the bridge
 * came up is clickable with no restart and no hand-maintained directory list.
 *
 * `sessions` is deliberately NOT a hard dependency — a deployment without it still
 * resolves absolute paths and anything under the row's configured `roots`.
 * @param ctx - this plugin's context.
 * @param configured - the row's `roots` values.
 * @returns absolute directory paths, the configured roots first.
 */
export const liveRoots = (ctx, configured = []) => {
  const found = [];
  try {
    const sessions = typeof ctx?.get === "function" ? ctx.get("sessions") : undefined;
    for (const session of sessions?.list?.() ?? []) {
      const cwd = session?.header?.cwd;
      if (typeof cwd === "string" && cwd.startsWith("/")) found.push(cwd);
    }
  } catch {
    /* the configured roots still apply */
  }
  return [...configured, ...found];
};

export function apply(ctx, config = {}) {
  /** Settings the running bridge was built from — the diff base for a live update. */
  let active = readRowSettings(config);

  const state = {
    state: "stopped",
    url: undefined,
    port: active.port,
    upstream: active.upstream,
    roots: active.roots,
    injectClickScript: active.injectClickScript,
    autoStart: active.autoStart,
    openCommand: active.openCommand,
    launchMode: active.launchMode,
    hijackChip: active.hijackChip,
    decorate: active.decorate,
    startedAt: undefined,
    error: undefined,
    lastEvents: [],
  };
  let handle;
  /** In-flight activation, so two callers cannot bind two listeners. */
  let starting;

  const readSecret = async () => {
    const record = await ctx.credentials.readRecord("client-connection/browser-session");
    const raw = record?.payload?.secret;
    if (typeof raw !== "string") {
      throw new Error("no client-connection/browser-session record; run `dsh web` once so this Harness home has a signing secret");
    }
    const secret = Buffer.from(raw.replaceAll("-", "+").replaceAll("_", "/"), "base64");
    if (secret.byteLength !== 32) throw new Error("browser-session secret is not 32 bytes");
    return secret;
  };

  /**
   * Serialises every lifecycle action.
   *
   * `start()` used to guard only on `handle !== undefined`, which is assigned two
   * awaits later, and `adopt()` was fired with `void` from the config listener — so
   * two quick saves could each bind a listener and leak the first one for the life of
   * the process. Everything that can bind or close a server now runs through this one
   * chain, and a failure inside it is a warning rather than an unhandled rejection.
   */
  let queue = Promise.resolve();
  const serialize = (task) => {
    const run = () => Promise.resolve()
      .then(task)
      .catch((error) => {
        ctx.logger?.warn?.(`dsh-web-bridge: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      });
    queue = queue.then(run, run);
    return queue;
  };

  const start = async () => {
    if (handle !== undefined) return handle;
    if (starting !== undefined) return starting;
    starting = begin().finally(() => {
      starting = undefined;
    });
    return starting;
  };

  const begin = async () => {
    const wanted = readRowSettings(config);
    state.state = "starting";
    state.error = undefined;
    try {
      const secret = await readSecret();
      handle = await startBridge({
        port: wanted.port,
        upstream: wanted.upstream,
        // A provider, not a list: the bridge resolves every click against the
        // sessions that are live at that moment.
        roots: () => liveRoots(ctx, readRowSettings(config).roots),
        injectClickScript: wanted.injectClickScript,
        openCommand: wanted.openCommand,
        launchMode: wanted.launchMode,
        // Read per index render, not captured: these change what the PAGE does, so a
        // saved switch reaches the next reload without restarting the bridge.
        clientConfig: () => {
          const current = readRowSettings(config);
          return { hijackChip: current.hijackChip, decorate: current.decorate };
        },
        // Derived from the secret, so it survives a remount: the page holding it
        // has no way to learn a new one without being reloaded.
        token: deriveToken(secret),
        secret,
        onEvent: (event) => {
          state.lastEvents = [event, ...state.lastEvents].slice(0, 5);
        },
      });
      active = wanted;
      state.state = "running";
      state.url = handle.url;
      state.port = handle.port;
      state.upstream = handle.upstream;
      state.roots = wanted.roots;
      state.injectClickScript = wanted.injectClickScript;
      state.startedAt = new Date().toISOString();
      ctx.logger?.info?.(`dsh-web-bridge: ${handle.url} -> http://${handle.upstream}/`);
    } catch (error) {
      handle = undefined;
      state.state = "failed";
      const message = error instanceof Error ? error.message : String(error);
      state.error = message;
      ctx.logger?.warn?.(`dsh-web-bridge: ${message}`);
    }
    return handle;
  };

  const stop = async () => {
    // Wait for an activation in flight, or it would bind after this returns.
    if (starting !== undefined) await starting.catch(() => {});
    const current = handle;
    handle = undefined;
    state.state = "stopped";
    state.url = undefined;
    if (current !== undefined) await current.close();
  };

  /**
   * Adopt the row's settings after a profile write.
   *
   * A volatile write commits into the running references and announces itself
   * with `loader/volatile-update` instead of remounting this plugin, so `apply`
   * never runs again: without this pass a saved change would sit in the profile
   * and reach nothing, and the page would read "saved" while the old origin kept
   * serving. A changed origin is bound BEFORE the old one is released, so a port
   * that is already taken cannot cost the user a working bridge.
   */
  const adopt = async () => {
    const next = readRowSettings(config);
    state.autoStart = next.autoStart;
    state.openCommand = next.openCommand;
    state.launchMode = next.launchMode;
    state.port = next.port;
    state.upstream = next.upstream;
    state.roots = next.roots;
    state.injectClickScript = next.injectClickScript;
    state.hijackChip = next.hijackChip;
    state.decorate = next.decorate;

    if (!next.autoStart) {
      await stop();
      return;
    }
    if (handle === undefined) {
      await start();
      return;
    }
    const changed =
      next.port !== active.port ||
      next.upstream !== active.upstream ||
      next.injectClickScript !== active.injectClickScript ||
      next.openCommand !== active.openCommand ||
      next.launchMode !== active.launchMode ||
      next.roots.join("\n") !== active.roots.join("\n");
    if (!changed) return;

    const previous = handle;
    if (next.port !== active.port) {
      handle = undefined;
      if ((await start()) !== undefined) {
        await previous.close();
        return;
      }
      // The new origin did not come up: restore the one that was working and
      // keep the error, so the page shows both the live URL and the refusal.
      handle = previous;
      state.state = "running";
      state.url = previous.url;
      state.port = previous.port;
      state.upstream = active.upstream;
      state.roots = active.roots;
      state.injectClickScript = active.injectClickScript;
      return;
    }
    await stop();
    await start();
  };

  // Declare this instance's settings page policy the documented way: inside an
  // optional `settings` child context and with this plugin's own fiber as the
  // owner (the `dsh-settings` README, and what the shipped provider plugins do).
  //
  // The owner argument makes this a declaration *for this instance*: a Cordis
  // Service reads `ctx` as the PROVIDING plugin's fiber, so a call without it
  // addresses the settings provider itself, which then reports that that
  // instance already has a policy. `auto: false` because this bundle ships its
  // own page; the README states the policy never removes configuration
  // read/write.
  //
  // Note what this does NOT do: it publishes no namespace. The namespace comes
  // from the `.volatile()` marks above plus an active fiber — declaring a policy
  // for an entry whose form projection is empty changes nothing. Every failure
  // here is a warning, because none of it may take the bridge down.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.effect(() => {
        let dispose;
        try {
          dispose = settingsCtx.settings.configure({ auto: false }, ctx.fiber);
        } catch (error) {
          ctx.logger?.warn?.(
            `dsh-web-bridge: settings page policy not registered: ${error instanceof Error ? error.message : String(error)}`,
          );
          return undefined;
        }
        return () => {
          try {
            dispose?.();
          } catch {
            /* already released */
          }
        };
      }, 'dsh-web-bridge: settings page policy');
    });
  }

  // Teach the model the one form the Harness's own guidance cannot: an anchor, which
  // survives edits the way a line number cannot. Registered in an optional
  // `systemPrompt` child exactly like the settings policy above, and every failure is
  // a warning — a missing guidance section must never take the bridge down.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.effect(() => {
        try {
          return promptCtx.systemPrompt.section({
            name: 'dsh-web-bridge:file-anchors',
            // Sit immediately after DSH's own file-reference section.
            order: promptCtx.systemPrompt.getSectionOrder('FILE_REFERENCE') + 1,
            text: FILE_ANCHOR_PROMPT,
          });
        } catch (error) {
          ctx.logger?.warn?.(
            `dsh-web-bridge: file-anchor guidance not registered: ${error instanceof Error ? error.message : String(error)}`,
          );
          return undefined;
        }
      }, 'dsh-web-bridge: file-anchor guidance');
    });
  }

  // Read-only view of the same service for the status diagnostic below.
  const settingsForReport = typeof ctx.get === 'function' ? ctx.get('settings') : undefined;

  // A form write reaches a volatile field as an in-place update announced on this
  // event — never as a remount — so this is the only thing that makes a saved
  // change take effect. The listener is scoped to this fiber by the Loader.
  ctx.effect(() => {
    const off = ctx.on?.('loader/volatile-update', (paths) => {
      state.lastEvents = [
        {
          kind: 'config',
          at: new Date().toISOString(),
          paths: (Array.isArray(paths) ? paths : []).map((path) => (Array.isArray(path) ? path.join('.') : String(path))),
        },
        ...state.lastEvents,
      ].slice(0, 5);
      void serialize(adopt);
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, 'dsh-web-bridge: live settings');

  // Lifecycle: start with the plugin (unless the row turned it off), stop with it.
  ctx.effect(() => {
    if (readRowSettings(config).autoStart) void serialize(start);
    return () => {
      void stop();
    };
  });

  // The settings page reads this snapshot; the tap runs per index render, so the
  // value is never stale even though the bridge restarts between renders.
  ctx.effect(() =>
    ctx.webServer.tapIndex((html) => {
      // Namespaces the Host actually serves: the ground truth a page needs when a
      // form lookup misses, reported without waiting for the client mirror.
      // `undefined` means "no settings service"; `[]` means "serves none".
      let namespaces;
      try {
        namespaces =
          settingsForReport === undefined
            ? undefined
            : (settingsForReport.describe?.() ?? [])
                .map((entry) => entry?.ns)
                .filter((ns) => typeof ns === 'string')
                .slice(0, 30);
      } catch {
        namespaces = undefined;
      }
      const snapshot = {
        state: state.state,
        url: state.url ?? `http://127.0.0.1:${state.port}/`,
        port: state.port,
        upstream: state.upstream,
        roots: state.roots,
        // Everything a relative path will actually be tried under right now: the
        // configured roots plus every live session's working directory. Reported
        // because "which directory was it looking in" is the whole question when a
        // click comes back `no such file under …`.
        searchRoots: liveRoots(ctx, state.roots),
        injectClickScript: state.injectClickScript,
        autoStart: state.autoStart,
        openCommand: state.openCommand,
        launchMode: state.launchMode,
        hijackChip: state.hijackChip,
        decorate: state.decorate,
        startedAt: state.startedAt,
        error: state.error,
        lastEvents: state.lastEvents,
        namespaces,
      };
      // `<` escaped: a session working directory can contain `</script>`.
      const injection = `<script>window.__DSH_WEB_BRIDGE__=${JSON.stringify(snapshot).replaceAll("<", "\\u003c")};</script>`;
      return /<head[^>]*>/iu.test(html) ? html.replace(/<head[^>]*>/iu, (tag) => `${tag}${injection}`) : `${injection}${html}`;
    }),
  );
}
