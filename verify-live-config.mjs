// End-to-end proof that a saved setting reaches the RUNNING bridge.
//
// The host half is driven with real volatile references — the frozen `{ get() }`
// the Loader parses a `.volatile()` field into — and a real bridge, then the
// Loader's own `loader/volatile-update` event is fired the way its
// `_commitVolatile()` fires it: after rewriting the reference in place. Nothing
// is remounted, so the origin can only move if `apply` adopted the change.
//
//   node verify-live-config.mjs
import { createServer, connect } from "node:net";
import { createServer as createHttp } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "./lib/index.js";

import { createChecks } from "./verify-support.mjs";

const { results, check, summary } = createChecks();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A free loopback port. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

/** A frozen live reference, as `createVolatile` produces it: stable identity, mutable value. */
const volatile = (initial) => {
  let current = initial;
  return {
    ref: Object.freeze({ get: () => current }),
    set: (value) => {
      current = value;
    },
  };
};

/** Whether something is accepting connections on a loopback port. */
const listening = (port) =>
  new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    const done = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
    setTimeout(() => done(false), 2000).unref?.();
  });

/** The smallest host context this plugin needs: credentials, an index tap, effects, events. */
const makeHost = () => {
  const cleanups = [];
  const taps = [];
  const listeners = new Map();
  const warnings = [];
  const secret = randomBytes(32).toString("base64url");
  const ctx = {
    fiber: { id: "dsh-web-bridge-fiber" },
    get: () => undefined,
    on: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return () => {};
    },
    effect: (run) => {
      // Collect the cleanup instead of dropping it: "unload closes the bridge" is an
      // invariant of this plugin and used to have no assertion at all.
      const off = run();
      if (typeof off === "function") cleanups.push(off);
      return () => {};
    },
    credentials: { readRecord: async () => ({ payload: { secret } }) },
    webServer: {
      tapIndex: (transform) => {
        taps.push(transform);
        return () => {};
      },
    },
    logger: { info() {}, warn: (message) => warnings.push(String(message)), debug() {} },
  };
  const snapshot = () => {
    const html = taps[0]("<html><head></head><body></body></html>");
    const at = html.indexOf("window.__DSH_WEB_BRIDGE__=");
    return at < 0 ? undefined : JSON.parse(html.slice(at + "window.__DSH_WEB_BRIDGE__=".length).split(";</script>")[0]);
  };
  const emit = (event, ...args) => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };
  const waitFor = async (predicate, label, attempts = 100) => {
    for (let index = 0; index < attempts; index += 1) {
      if (predicate(snapshot())) return true;
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(snapshot())}`);
  };
  return {
    /** Run every collected cleanup, i.e. what unloading the plugin does. */
    dispose: async () => {
      for (const off of cleanups.reverse()) await off();
    },
ctx, snapshot, emit, waitFor, warnings };
};

const first = await freePort();
const second = await freePort();
const taken = await freePort();

const port = volatile(first);
const upstream = volatile("127.0.0.1:9");
const autoStart = volatile(true);
const roots = volatile([]);
const injectClickScript = volatile(true);
const openCommand = volatile("code");
const launchMode = volatile("auto");
const config = {
  port: port.ref,
  upstream: upstream.ref,
  roots: roots.ref,
  injectClickScript: injectClickScript.ref,
  autoStart: autoStart.ref,
  openCommand: openCommand.ref,
  launchMode: launchMode.ref,
};

const host = makeHost();
apply(host.ctx, config);
await host.waitFor((state) => state?.state === "running" && state.port === first, "the first origin");
check("the bridge starts on the configured port", host.snapshot().port === first, JSON.stringify(host.snapshot().url));
check("the start reaches the loopback origin", await listening(first));

// A form write: the Loader rewrites the reference in place, then announces the
// path on this fiber. No remount happens, which is the whole point.
port.set(second);
host.emit("loader/volatile-update", [["port"]]);
await host.waitFor((state) => state?.state === "running" && state.port === second, "the second origin");
check("a saved port moves the running origin", host.snapshot().url.includes(String(second)), JSON.stringify(host.snapshot().url));
check("the new origin serves", await listening(second));
check("the previous origin is released", (await listening(first)) === false);
check(
  "the change is recorded as a config event",
  (host.snapshot().lastEvents ?? []).some((event) => event.kind === "config" && event.paths?.join() === "port"),
  JSON.stringify(host.snapshot().lastEvents),
);

// A port that is already in use must not cost a working bridge.
const blocker = createServer();
await new Promise((resolve) => blocker.listen(taken, "127.0.0.1", resolve));
port.set(taken);
host.emit("loader/volatile-update", [["port"]]);
await sleep(600);
check("a taken port leaves the working origin alone", host.snapshot().state === "running" && host.snapshot().port === second, JSON.stringify([host.snapshot().state, host.snapshot().port]));
check(
  "the refusal is reported, not swallowed",
  typeof host.snapshot().error === "string" && host.snapshot().error.includes("EADDRINUSE"),
  JSON.stringify(host.snapshot().error),
);
check("the working origin still serves", await listening(second));
await new Promise((resolve) => blocker.close(resolve));

// Writing the value it already runs on is a no-op, not a restart.
port.set(second);
host.emit("loader/volatile-update", [["port"]]);
await sleep(300);
check("an unchanged value does not restart the bridge", host.snapshot().state === "running" && host.snapshot().port === second && (await listening(second)));

// `autoStart` is adopted live too, in both directions.
autoStart.set(false);
host.emit("loader/volatile-update", [["autoStart"]]);
await host.waitFor((state) => state?.state === "stopped", "the bridge to stop");
check("turning autoStart off stops the bridge", (await listening(second)) === false);
autoStart.set(true);
host.emit("loader/volatile-update", [["autoStart"]]);
await host.waitFor((state) => state?.state === "running" && state.port === second, "the bridge to restart");
check("turning it back on restarts it on the live port", await listening(second));

// ---- a relative path is resolved against the LIVE session working directory.
//      This is the fix for a real failure: `no such file under /home/shuaige/code,
//      /home/shuaige: dsh-web-bridge/lib/bridge.js`. The page shows paths the way a
//      session wrote them, and the bridge's own cwd is the PARENT of the project.
{
  const scratch = mkdtempSync(join(tmpdir(), "dsh-bridge-roots-"));
  const fakeEditor = join(scratch, "fake-editor");
  writeFileSync(fakeEditor, `#!/bin/sh\nprintf '%s\\n' "$@" > "${scratch}/args"\nexit 0\n`, { mode: 0o755 });
  const project = mkdtempSync(join(tmpdir(), "dsh-project-"));
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "app.ts"), "export {};\n");

  // The session list starts EMPTY, so the very same running bridge has to change
  // its answer later without a restart — which is the point of a provider.
  let live = [];
  const host = makeHost();
  host.ctx.get = (name) => (name === "sessions" ? { list: () => live.map((cwd) => ({ header: { cwd } })) } : undefined);

  // A real upstream, because the bridge only injects its token into an HTML index
  // it served itself — a dead upstream would leave nothing to read the token from.
  const upstreamPort = await freePort();
  const upstream = createHttp((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><head><title>upstream</title></head><body>ok</body></html>");
  });
  await new Promise((done) => upstream.listen(upstreamPort, "127.0.0.1", done));

  const rootPort = await freePort();
  apply(host.ctx, {
    port: volatile(rootPort).ref,
    upstream: volatile(`127.0.0.1:${upstreamPort}`).ref,
    roots: volatile([]).ref,
    autoStart: volatile(true).ref,
    openCommand: volatile(fakeEditor).ref,
    launchMode: volatile("editor").ref,
  });
  await host.waitFor((state) => state?.state === "running", "the roots-test bridge");

  const index = await (await fetch(`http://127.0.0.1:${rootPort}/`)).text();
  const token = index.match(/"token":"([^"]+)"/)?.[1];
  check("the token is injected into the proxied index", typeof token === "string" && token.length > 0);
  const openRelative = async (file) => {
    const response = await fetch(`http://127.0.0.1:${rootPort}/__bridge/open`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bridge-token": token },
      body: JSON.stringify({ file, line: 3 }),
    });
    return response.json();
  };

  const before = await openRelative("src/app.ts");
  check("a relative path fails while no session covers it", before.ok === false && before.searched?.length > 0, JSON.stringify(before.error));

  live = [project];
  const after = await openRelative("src/app.ts");
  check(
    "the same bridge resolves it once a session appears (no restart)",
    after.ok === true && after.file === join(project, "src", "app.ts"),
    JSON.stringify({ ok: after.ok, file: after.file, error: after.error }),
  );
  check(
    "the resolved path reaches the editor with its line number",
    readFileSync(join(scratch, "args"), "utf8").trim() === `-r\n-g\n${join(project, "src", "app.ts")}:3`,
    JSON.stringify(readFileSync(join(scratch, "args"), "utf8").trim()),
  );
  check(
    "the live search list is reported for the next failure",
    (host.snapshot().searchRoots ?? []).includes(project),
    JSON.stringify(host.snapshot().searchRoots),
  );
  check(
    "an absolute path keeps working regardless of the roots",
    (await openRelative(join(project, "src", "app.ts"))).file === join(project, "src", "app.ts"),
  );
  await new Promise((done) => upstream.close(done));
}

// ---- the token must survive a remount. A page loaded before a DSH restart holds
//      the token it was loaded with and can only learn a new one by being
//      reloaded, so a per-activation token means "UI alive, every click 403s".
{
  const secret = randomBytes(32).toString("base64url");
  const credentials = { readRecord: async () => ({ payload: { secret } }) };
  // The token only reaches a page through an injected HTML index, so these
  // activations need a live upstream — a dead one answers 502 and injects nothing.
  const upstreamPort = await freePort();
  const upstream = createHttp((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><head><title>up</title></head><body>ok</body></html>");
  });
  await new Promise((done) => upstream.listen(upstreamPort, "127.0.0.1", done));
  const startHost = async () => {
    const host = makeHost();
    host.ctx.credentials = credentials;
    const port = await freePort();
    apply(host.ctx, {
      port: volatile(port).ref,
      upstream: volatile(`127.0.0.1:${upstreamPort}`).ref,
      roots: volatile([]).ref,
      autoStart: volatile(true).ref,
      openCommand: volatile("code").ref,
      launchMode: volatile("editor").ref,
    });
    await host.waitFor((state) => state?.state === "running", `the activation on ${port}`);
    const index = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    return { port, token: index.match(/"token":"([^"]+)"/)?.[1] };
  };

  const first = await startHost();
  const second = await startHost();
  check("two activations of the same Harness home mint the same token", first.token === second.token, JSON.stringify([first.token, second.token]));

  // The real failure: a page holding the FIRST activation's token talks to the
  // SECOND bridge. That is what happens across a DSH restart.
  const ping = await fetch(`http://127.0.0.1:${second.port}/__bridge/ping`, { headers: { "x-bridge-token": first.token } });
  check("a page holding the older token keeps working against the new bridge", ping.status === 200, String(ping.status));

  // And a token from a different Harness home must NOT be accepted.
  const other = await (async () => {
    const host = makeHost();
    host.ctx.credentials = { readRecord: async () => ({ payload: { secret: randomBytes(32).toString("base64url") } }) };
    const port = await freePort();
    apply(host.ctx, {
      port: volatile(port).ref,
      upstream: volatile(`127.0.0.1:${upstreamPort}`).ref,
      roots: volatile([]).ref,
      autoStart: volatile(true).ref,
      openCommand: volatile("code").ref,
      launchMode: volatile("editor").ref,
    });
    await host.waitFor((state) => state?.state === "running", "the foreign activation");
    const index = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    return { port, token: index.match(/"token":"([^"]+)"/)?.[1] };
  })();
  check("a different Harness home derives a different token", other.token !== first.token, JSON.stringify(other.token));
  const denied = await fetch(`http://127.0.0.1:${other.port}/__bridge/ping`, { headers: { "x-bridge-token": first.token } });
  check("...and is refused", denied.status === 403, String(denied.status));
  await new Promise((done) => upstream.close(done));
}

// ---- two saves back to back must not leak a listener. The old `start()` guarded only
//      on `handle !== undefined`, which is assigned two awaits later, so the second
//      restart bound a second server while the first one stayed up for good.
{
  const portA = await freePort();
  const portB = await freePort();
  const portC = await freePort();
  const port = volatile(portA);
  const host = makeHost();
  apply(host.ctx, {
    port: port.ref,
    upstream: volatile("127.0.0.1:9").ref,
    roots: volatile([]).ref,
    autoStart: volatile(true).ref,
    openCommand: volatile("code").ref,
    launchMode: volatile("editor").ref,
  });
  await host.waitFor((state) => state?.state === "running" && state.port === portA, "the first port");

  port.set(portB);
  host.emit("loader/volatile-update", [["port"]]);
  port.set(portC);
  host.emit("loader/volatile-update", [["port"]]);

  await host.waitFor((state) => state?.state === "running" && state.port === portC, "the last port");
  await sleep(600);
  const alive = { a: await listening(portA), b: await listening(portB), c: await listening(portC) };
  check("two rapid port saves settle on the last port", alive.c === true, JSON.stringify(alive));
  check("...and leave no orphan listener behind", alive.a === false && alive.b === false, JSON.stringify(alive));
}

// ---- unloading the plugin must actually close the listener. The fake ctx used to drop
//      every effect cleanup, so this invariant had no assertion at all.
{
  const port = await freePort();
  const host = makeHost();
  apply(host.ctx, {
    port: volatile(port).ref,
    upstream: volatile("127.0.0.1:9").ref,
    roots: volatile([]).ref,
    autoStart: volatile(true).ref,
    openCommand: volatile("code").ref,
    launchMode: volatile("editor").ref,
  });
  await host.waitFor((state) => state?.state === "running" && state.port === port, "a running bridge before unload");
  check("a running bridge listens before unload", (await listening(port)) === true);
  await host.dispose();
  await sleep(400);
  check("unloading the plugin closes the bridge", (await listening(port)) === false);
}

process.exit(summary() === 0 ? 0 : 1);
