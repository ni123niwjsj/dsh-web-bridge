// Standalone verification of this plugin's bridge core: run it without
// installing the plugin, so a defect is found before it reaches a profile.
//
// The suite pins the bridge's OWN fence, which is the whole reason the bridge can
// exist: it relaxes DSH's upstream checks for pages IT served, so it must refuse
// everyone else. An earlier version of this file asserted the opposite — it sent a
// foreign `Origin` and `Sec-Fetch-Site: cross-site` and demanded 200/101 — which is
// how a cross-site WebSocket hijack shipped with a green suite behind it.
//
//   node verify-plugin.mjs [port]
//
// Needs a running DSH Web server and its signing secret in $DSH_HOME.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { connect as netConnect } from "node:net";
import { startBridge } from "./lib/bridge.js";

const readSecret = (dshHome = process.env.DSH_HOME || join(homedir(), ".dsh")) => {
  const path = join(dshHome, ".credentials.yaml");
  const lines = readFileSync(path, "utf8").split(/\r?\n/u);
  let base;
  for (const line of lines) {
    if (base === undefined) {
      const opening = line.match(/^(\s*)(?:["']?)client-connection\/browser-session(?:["']?):\s*$/u);
      if (opening) base = opening[1].length;
      continue;
    }
    if (line.trim() === "") continue;
    if (line.match(/^(\s*)/u)[1].length <= base) break;
    const found = line.match(/^\s*secret:\s*(.+?)\s*$/u);
    if (found === null) continue;
    return Buffer.from(found[1].replace(/^["']|["']$/gu, "").replaceAll("-", "+").replaceAll("_", "/"), "base64");
  }
  throw new Error(`no browser-session record in ${path}`);
};

const port = Number(process.argv[2] ?? 39989);
const token = "verify-token";
const bridge = await startBridge({
  port,
  upstream: "127.0.0.1:3080",
  roots: [process.cwd()],
  injectClickScript: true,
  openCommand: process.env.DSH_BRIDGE_CODE || "code",
  launchMode: "auto",
  token,
  secret: readSecret(),
  onEvent: () => {},
});
console.log(`bridge: ${bridge.url} -> http://${bridge.upstream}/`);

const OWN = `http://127.0.0.1:${port}`;
const FOREIGN = "http://evil.example";
/** What the bridge's own page sends: its own origin, same-origin fetch metadata, the token. */
const asPage = { origin: OWN, "sec-fetch-site": "same-origin", "x-bridge-token": token };
/** What a navigation sends: nothing at all (a browser tab, an IDE webview, curl). */
const asNavigation = {};
const asForeignPage = { origin: FOREIGN, "sec-fetch-site": "cross-site", "x-bridge-token": token };

/** One raw HTTP/1.1 request over a socket, answering its status line. */
const rawRequest = (targetPort, text) =>
  new Promise((settle) => {
    const socket = netConnect(targetPort, "127.0.0.1", () => socket.write(text));
    let out = "";
    socket.on("data", (chunk) => {
      out += chunk.toString("latin1");
    });
    const done = () => {
      socket.destroy();
      settle(out.split("\r\n")[0] || "(no reply)");
    };
    socket.on("error", (error) => settle(`socket error: ${error.message}`));
    socket.on("close", done);
    setTimeout(done, 4000).unref?.();
  });
// The bridge runs inside the DSH process, so anything fatal here is fatal there.
// DSH answers an unhandled rejection or uncaught exception with process.exit(1), so
// the suite records both and asserts at the end that nothing ever reached them.
const fatal = [];
process.on("uncaughtException", (error) => fatal.push(`uncaughtException: ${error?.code ?? error?.message}`));
process.on("unhandledRejection", (error) => fatal.push(`unhandledRejection: ${error?.code ?? error?.message ?? error}`));

const results = [];
const check = (name, ok, detail = "") => {
  results.push([name, ok]);
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? `  ${detail}` : ""}`);
};

const index = await fetch(bridge.url, { headers: asNavigation });
const html = await index.text();
check("a navigation (no origin, as a browser tab or IDE webview sends) returns 200", index.status === 200, String(index.status));
check("index carries the bridge config", html.includes("__DSH_BRIDGE__"));
check("index carries the click script", html.includes("/__bridge/client.js"));

const ping = await fetch(new URL("/__bridge/ping", bridge.url), { headers: asPage });
const pingBody = await ping.json();
check("the page's own origin reaches /__bridge/ping", ping.status === 200 && pingBody.upstream === "127.0.0.1:3080", JSON.stringify(pingBody.roots));

const api = await fetch(new URL("/api/nope", bridge.url), {
  method: "POST",
  headers: { ...asPage, "content-type": "application/json" },
  body: JSON.stringify({ type: "client-request", rpcId: "t", method: "nope", payload: {} }),
});
check("/api passes the fence and auth for the bridge's own page (404 = admitted)", api.status === 404, String(api.status));

const denied = await fetch(new URL("/__bridge/ping", bridge.url));
check("bridge endpoints still need the token", denied.status === 403, String(denied.status));

const queryToken = await fetch(new URL(`/__bridge/ping?token=${token}`, bridge.url));
check("the token is not accepted from a query string", queryToken.status === 403, String(queryToken.status));

// A malformed Host used to be parsed straight into a URL, which threw inside the
// request listener — an uncaught exception, and DSH answers those with exit(1).
const badHost = await rawRequest(port, "GET / HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n");
check("a malformed Host is answered, not thrown", badHost.includes("403") || badHost.includes("400"), badHost.slice(0, 40));

const aborted = await rawRequest(port, "POST /__bridge/open HTTP/1.1\r\nHost: 127.0.0.1:" + port + "\r\ncontent-length: 9000\r\n\r\n");
check("...and an aborted body on top of it is still answered", aborted.includes("403") || aborted.includes("400") || aborted.includes("500"), aborted.slice(0, 40));

const foreignIndex = await fetch(bridge.url, { headers: { origin: FOREIGN } });
check("a foreign origin cannot load the proxied GUI", foreignIndex.status === 403, String(foreignIndex.status));

// An origin-less request is a navigation or a no-cors subresource: it must load (the
// IDE's own webview sends no origin), and it can read nothing — the token is header-only
// and stale-host requests are refused by the Host rule above.
const navigationLike = await fetch(bridge.url, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } });
check("an origin-less navigation still loads (the IDE webview sends no origin)", navigationLike.status === 200, String(navigationLike.status));

// A cross-site POST/XHR/WS always carries the initiator's origin, so that is the rule
// that matters; `Sec-Fetch-Site` alone (no origin) is a navigation or a no-cors read.
const foreignApi = await fetch(new URL("/api/nope", bridge.url), { method: "POST", headers: { ...asForeignPage, "content-type": "application/json" }, body: "{}" });
check("a cross-site fetch (foreign origin) cannot reach /api", foreignApi.status === 403, String(foreignApi.status));

const foreignPing = await fetch(new URL("/__bridge/ping", bridge.url), { headers: asForeignPage });
check("a cross-site request cannot reach the bridge endpoints", foreignPing.status === 403, String(foreignPing.status));

const self = await (await fetch(new URL("/__bridge/selftest", bridge.url), { headers: asPage })).json();
check("selftest resolves the HEAD snapshot and the open path", self.checks?.snapshotOk === true && self.checks?.openOk === true, JSON.stringify(self.checks));
check("selftest probes the launcher DRY, so it never opens an editor window", self.checks?.dryRun === true, JSON.stringify(self.checks));
check("selftest asks for a line that exists, and says what is on it", self.checks?.targetLineOk === true, JSON.stringify(self.checks));

// The bridge runs in this process, so the upgrade probe must be async: a
// synchronous child would block the very event loop that serves it.
const probeUpgrade = (targetPort, path, extraHeaders = {}) =>
  new Promise((settle) => {
    const socket = netConnect(targetPort, "127.0.0.1", () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${targetPort}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
        "Sec-WebSocket-Version: 13",
        ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
      ];
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    let buffer = "";
    const done = (line) => {
      socket.destroy();
      settle(line);
    };
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      if (buffer.includes("\r\n\r\n")) done(buffer.split("\r\n")[0]);
    });
    socket.on("error", (error) => done(`socket error: ${error.message}`));
    setTimeout(() => done(buffer.split("\r\n")[0] || "timeout"), 8000).unref?.();
  });

// The upgrade path is where the fence matters most: browsers apply no CORS to a
// WebSocket handshake, so an unchecked proxy hands the session mux to any page.
const ownUpgrade = await probeUpgrade(port, "/api/remote.mux", { Origin: OWN });
check("the bridge's own page may upgrade (101)", ownUpgrade.includes("101"), ownUpgrade.slice(0, 60));

// An authenticated request that dies mid-body: the token gets it past `authorized`,
// so this reaches `readBody`'s iterator — the exact shape that used to raise an
// unhandled ECONNRESET (and therefore kill the session).
const abortAuthenticated = await rawRequest(
  port,
  `POST /__bridge/report HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nx-bridge-token: ${token}\r\ncontent-type: application/json\r\ncontent-length: 9000\r\n\r\n`,
);
check("an authenticated request that dies mid-body is absorbed", abortAuthenticated === "(no reply)" || abortAuthenticated.includes("200") || abortAuthenticated.includes("400"), abortAuthenticated.slice(0, 40));

const log = await (await fetch(new URL("/__bridge/log?limit=abc", bridge.url), { headers: asPage })).json();
check("a non-numeric log limit means the default, not everything", log.limit === 50 && log.events.length <= 50, JSON.stringify({ limit: log.limit, events: log.events.length }));

const foreignUpgrade = await probeUpgrade(port, "/api/remote.mux", { Origin: FOREIGN });
check("a foreign origin may NOT upgrade", foreignUpgrade.includes("403"), foreignUpgrade.slice(0, 60));

// A browser always sends Origin on a WebSocket handshake, so the foreign-origin rule
// is the whole defence there; an origin-less handshake is a local process, which could
// read the files directly anyway.
const originlessUpgrade = await probeUpgrade(port, "/api/remote.mux", {});
check("an origin-less (non-browser) upgrade is still admitted", originlessUpgrade.includes("101"), originlessUpgrade.slice(0, 60));

await bridge.close();
// Give the aborted-request rejection a turn to surface before judging it.
await new Promise((resolve) => setTimeout(resolve, 300));
check("nothing the bridge did reached a fatal process-level handler", fatal.length === 0, JSON.stringify(fatal));

const failed = results.filter(([, ok]) => !ok).length;
console.log(failed === 0 ? `\n全部通过（${results.length} 项）` : `\n失败 ${failed}/${results.length} 项`);
process.exit(failed === 0 ? 0 : 1);
