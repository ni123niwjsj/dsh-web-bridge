// Regression tests for relative-path resolution and the target-line preview:
// the one-level fallback (a path written relative to a SUBDIRECTORY of a root),
// the refusal to guess between ambiguous matches, and the bounded read that tells
// the reader what is actually on the line they are about to be sent to.
//
//   node verify-resolve.mjs
//
// Runs a real bridge on a free port with `dryRun`, so nothing is ever opened in an
// editor. Upstream is a throwaway HTML server (the bridge only needs one to serve
// an index, and this suite never proxies through it).
import { createServer as createHttp } from "node:http";
import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAnchor, peek, scanOneLevel, startBridge } from "./lib/bridge.js";

const results = [];
const check = (name, ok, detail = "") => {
  results.push([name, ok]);
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? `  ${detail}` : ""}`);
};

const freePort = () =>
  new Promise((done, fail) => {
    const server = createHttp();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });

const write = (path, text) => {
  writeFileSync(path, text, "utf8");
  return path;
};

// ---------------------------------------------------------------- the tree
const scratch = mkdtempSync(join(tmpdir(), "dsh-resolve-"));
// A unique tag on every fixture name. `readRoots()` always appends the process
// working directory and $HOME, and this suite runs from the plugin directory -
// which really does contain `docs/TODO.md`. Without the tag, a relative path would
// hit THAT file through a direct root match and quietly test the wrong thing, which
// is exactly the silent-wrong-file hazard this suite exists to guard against.
const tag = randomBytes(3).toString("hex");
const name = (stem, extension = "md") => `${stem}-${tag}.${extension}`;
for (const dir of ["docs", "alpha/docs", "beta/docs", "project/docs", "project/deep/er"]) mkdirSync(join(scratch, dir), { recursive: true });
const directDoc = write(join(scratch, "docs", name("DIRECT")), "direct wins\n");
write(join(scratch, "project", "docs", name("DIRECT")), "the subdirectory copy\n");
const scannedDoc = write(join(scratch, "project", "docs", name("SCANNED")), "# todo\nline two\nline three\n");
write(join(scratch, "alpha", "docs", name("AMBIG")), "alpha\n");
write(join(scratch, "beta", "docs", name("AMBIG")), "beta\n");
write(join(scratch, "project", "deep", "er", name("TWO")), "two levels down\n");
const lines = write(join(scratch, name("LINES")), "L1\nL2\nL3\nL4\nL5\n");
const anchored = write(
  join(scratch, name("ANCHORED")),
  "alpha\nbeta\nexport const deriveToken = (secret) => 1;\n// deriveToken is used below\ngamma\n",
);
const big = write(join(scratch, name("BIG")), `${Array.from({ length: 20000 }, (_, index) => `line ${index + 1} ${"x".repeat(30)}`).join("\n")}\n`);
const binary = join(scratch, name("BINARY", "bin"));
writeFileSync(binary, Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x41]));
write(join(scratch, name("PLAIN", "txt")), "not a match\n");

// ------------------------------------------------------- scanOneLevel (pure)
{
  const found = scanOneLevel([scratch], `docs/${name("SCANNED")}`);
  check("scanOneLevel finds a path one level below a root", found.matches.length === 1 && found.matches[0] === scannedDoc, JSON.stringify(found.matches));
  check("...and reports how much it looked at", found.scanned > 0, String(found.scanned));
  check("...and finds nothing outside the scratch root (fixtures are unique)", found.matches.every((path) => path.startsWith(scratch)), JSON.stringify(found.matches));

  const ambiguous = scanOneLevel([scratch], `docs/${name("AMBIG")}`);
  check("scanOneLevel reports every match, it does not stop at the first", ambiguous.matches.length === 2, JSON.stringify(ambiguous.matches));

  const capped = scanOneLevel([scratch], `docs/${name("SCANNED")}`, { limit: 1 });
  check("scanOneLevel honours its entry cap", capped.scanned <= 1, String(capped.scanned));

  const missingRoot = scanOneLevel([join(scratch, "nope"), scratch], `docs/${name("SCANNED")}`);
  check("an unreadable root is skipped, not fatal", missingRoot.matches.length === 1, JSON.stringify(missingRoot.matches));

  const tooDeep = scanOneLevel([scratch], `er/${name("TWO")}`);
  check("the scan is ONE level deep by design (no recursion)", tooDeep.matches.length === 0, JSON.stringify(tooDeep.matches));
}

// ------------------------------------------------------------- peek (pure)
{
  const middle = peek(lines, 3);
  check("peek returns the target line and the file's line count", middle.lineText === "L3" && middle.total === 5, JSON.stringify(middle));

  const past = peek(lines, 99);
  check("a line past the end is reported as beyond, with the real total", past.beyond === true && past.total === 5 && past.lineText === undefined, JSON.stringify(past));

  const noLine = peek(lines, undefined);
  check("no line requested means no line text", noLine.lineText === undefined && noLine.total === 5, JSON.stringify(noLine));

  const inWindow = peek(big, 100);
  check("a line inside the preview window is found in a big file", inWindow.lineText?.startsWith("line 100 "), JSON.stringify(inWindow.lineText));
  check("...and a big file reports NO total, because the window cannot know it", inWindow.total === undefined, JSON.stringify(inWindow.total));
  const farBeyond = peek(big, 999999);
  check("...so it refuses to claim `beyond` either", farBeyond.beyond === undefined && farBeyond.lineText === undefined, JSON.stringify(farBeyond));

  const unreadable = peek(binary, 1);
  check("a binary file never throws", typeof unreadable === "object", JSON.stringify(unreadable));
  check("a missing file never throws", JSON.stringify(peek(join(scratch, name("GONE")), 1)) === "{}");
}

// ------------------------------------------------------------ findAnchor (pure)
{
  const unique = findAnchor(anchored, "export const deriveToken");
  check("findAnchor reports the first matching line", unique.line === 3 && unique.matches === 1, JSON.stringify(unique));

  const repeated = findAnchor(anchored, "deriveToken");
  check("...and counts every occurrence, taking the first line", repeated.line === 3 && repeated.matches === 2, JSON.stringify(repeated));

  check("a missing anchor reports zero matches, not an error", JSON.stringify(findAnchor(anchored, "no-such-text")) === '{"matches":0}');
  check("an empty or oversized anchor is refused", findAnchor(anchored, "   ").matches === 0 && findAnchor(anchored, "x".repeat(200)).matches === 0);
  check("the search is case-sensitive and literal", findAnchor(anchored, "DERIVETOKEN").matches === 0 && findAnchor(anchored, "derive.*").matches === 0);

  const beyond = findAnchor(big, "line 19999");
  check("an anchor past the 512KB window is reported as truncated, not as absent", beyond.matches === 0 && beyond.truncated === true, JSON.stringify(beyond));
  check("...while one inside the window is found", findAnchor(big, "line 100 ").line === 100);
}

// --------------------------------------------------- end to end via the bridge
{
  const upstreamPort = await freePort();
  /** Every request the fake upstream saw: its headers and the target it was asked for. */
  const seenUpstream = [];
  const upstream = createHttp((req, res) => {
    seenUpstream.push({ headers: req.headers, url: req.url });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><head><title>up</title></head><body>ok</body></html>");
  });
  await new Promise((done) => upstream.listen(upstreamPort, "127.0.0.1", done));

  const port = await freePort();
  const token = "resolve-suite";
  const bridge = await startBridge({
    port,
    upstream: `127.0.0.1:${upstreamPort}`,
    roots: [scratch],
    injectClickScript: true,
    openCommand: "code",
    launchMode: "auto",
    token,
    secret: randomBytes(32),
    dryRun: true, // the launcher reports the command instead of running it
    // Read per index render, so a saved switch reaches the next page load without
    // restarting the bridge — asserted below through the injected page config.
    clientConfig: () => ({ hijackChip: "auto", decorate: false }),
    onEvent: () => {},
  });

  // The page's own configuration rides the index injection, not the bridge's start
  // options, so flipping a switch needs a reload and nothing else.
  const indexHtml = await (await fetch(bridge.url)).text();
  const pageConfig = JSON.parse(indexHtml.match(/__DSH_BRIDGE__=(\{.*?\});<\/script>/su)?.[1] ?? "{}");
  check(
    "the index injection carries the live client switches and the resolved roots",
    pageConfig.hijackChip === "auto" && pageConfig.decorate === false && Array.isArray(pageConfig.roots) && pageConfig.token === token,
    JSON.stringify({ hijackChip: pageConfig.hijackChip, decorate: pageConfig.decorate, roots: pageConfig.roots }),
  );

  const post = async (body) => {
    const response = await fetch(new URL("/__bridge/open", bridge.url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-bridge-token": token },
      body: JSON.stringify(body),
    });
    return response.json();
  };
  const open = (file, line) => post(line === undefined ? { file } : { file, line });

  const scanned = await open(`docs/${name("SCANNED")}`, 3);
  check("a path written relative to a SUBDIRECTORY now opens (the whole point)", scanned.ok === true && scanned.file === scannedDoc, JSON.stringify({ ok: scanned.ok, file: scanned.file, error: scanned.error }));
  check("...and the reply says it was found by scanning, and under which root", scanned.resolvedBy === "scan" && scanned.root === join(scratch, "project"), JSON.stringify({ resolvedBy: scanned.resolvedBy, root: scanned.root }));
  check("...and it echoes the target line", scanned.lineText === "line three", JSON.stringify(scanned.lineText));
  check("...with the command the editor would have run", String(scanned.command).includes(`${scannedDoc}:3`), JSON.stringify(scanned.command));

  const direct = await open(`docs/${name("DIRECT")}`);
  check(
    "a direct hit wins over a scan match, and names the root that served it",
    direct.ok === true && direct.file === directDoc && direct.resolvedBy === "root" && direct.root === scratch,
    JSON.stringify({ file: direct.file, resolvedBy: direct.resolvedBy, root: direct.root }),
  );

  const ambiguous = await open(`docs/${name("AMBIG")}`);
  check(
    "two matches are refused instead of guessed",
    ambiguous.ok === false && ambiguous.candidates?.length === 2 && JSON.stringify(ambiguous.error).includes("will not guess"),
    JSON.stringify({ ok: ambiguous.ok, candidates: ambiguous.candidates, error: ambiguous.error }),
  );

  const tooDeep = await open(`er/${name("TWO")}`);
  check("two levels down is still out of scope (documented boundary)", tooDeep.ok === false && tooDeep.searched?.length > 0, JSON.stringify(tooDeep.error));

  const missing = await open(`docs/${name("NOPE")}`);
  check("a genuine miss still reports what it searched", missing.ok === false && missing.searched?.length > 0 && typeof missing.scanned === "number", JSON.stringify({ error: missing.error, scanned: missing.scanned }));

  const beyond = await open(name("LINES"), 99);
  check("an impossible line number comes back as a warning, not a silent jump", beyond.ok === true && beyond.beyond === true && beyond.total === 5, JSON.stringify(beyond));

  const absolute = await open(directDoc);
  check("an absolute path resolves directly and says so", absolute.ok === true && absolute.resolvedBy === "absolute", JSON.stringify(absolute.resolvedBy));

  const empty = await open("");
  check("an empty request is rejected", empty.ok === false && empty.error === "file is required", JSON.stringify(empty.error));

  // ---- anchors: the target is resolved against the file AT CLICK TIME
  const byAnchor = await open(`${name("ANCHORED")}#export const deriveToken`);
  check(
    "a `path#anchor` opens the file at the anchor's line",
    byAnchor.ok === true && byAnchor.file === anchored && byAnchor.line === 3 && byAnchor.anchorMatches === 1,
    JSON.stringify({ ok: byAnchor.ok, file: byAnchor.file, line: byAnchor.line, matches: byAnchor.anchorMatches }),
  );
  check("...and echoes the anchored line, so a wrong landing is visible", byAnchor.lineText === "export const deriveToken = (secret) => 1;", JSON.stringify(byAnchor.lineText));

  const repeatedAnchor = await open(`${name("ANCHORED")}#deriveToken`);
  check(
    "a repeated anchor takes the first line and says how many it found",
    repeatedAnchor.line === 3 && repeatedAnchor.anchorMatches === 2,
    JSON.stringify({ line: repeatedAnchor.line, matches: repeatedAnchor.anchorMatches }),
  );

  const anchorWins = await post({ file: `${name("ANCHORED")}#beta`, line: 99 });
  check("an anchor beats the line that came with it (the anchor is the durable one)", anchorWins.line === 2 && anchorWins.anchor === "beta", JSON.stringify({ line: anchorWins.line, anchor: anchorWins.anchor }));

  const anchorMissed = await post({ file: `${name("ANCHORED")}#not-in-this-file`, line: 5 });
  check(
    "a missed anchor falls back to the line instead of failing",
    anchorMissed.ok === true && anchorMissed.line === 5 && anchorMissed.anchorMissed === true && anchorMissed.lineText === "gamma",
    JSON.stringify({ line: anchorMissed.line, missed: anchorMissed.anchorMissed, text: anchorMissed.lineText }),
  );

  const hashLine = await open(`${name("ANCHORED")}#L4`);
  check("`#L4` is still a LINE, not an anchor", hashLine.line === 4 && hashLine.anchor === undefined, JSON.stringify({ line: hashLine.line, anchor: hashLine.anchor }));

  const bodyAnchor = await post({ file: name("ANCHORED"), anchor: "gamma" });
  check("the anchor may also arrive as its own field", bodyAnchor.line === 5 && bodyAnchor.anchor === "gamma", JSON.stringify({ line: bodyAnchor.line, anchor: bodyAnchor.anchor }));

  // The documented GET form must honour a numeric STRING line (`?line=3`).
  const getForm = await (await fetch(new URL(`/__bridge/open?file=${encodeURIComponent(name("LINES"))}&line=4`, bridge.url), { headers: { "x-bridge-token": token } })).json();
  check("the documented GET form honours a numeric string line", getForm.line === 4 && String(getForm.command).endsWith(":4"), JSON.stringify({ line: getForm.line, command: getForm.command }));

  const anchorTooBig = await post({ file: `${name("BIG")}#line 19999`, line: 7 });
  check(
    "an anchor outside the read window is honest about it and keeps the line",
    anchorTooBig.line === 7 && anchorTooBig.anchorMissed === true && anchorTooBig.anchorPartial === true,
    JSON.stringify({ line: anchorTooBig.line, missed: anchorTooBig.anchorMissed, partial: anchorTooBig.anchorPartial }),
  );

  await bridge.close();

  // ---- what must never travel upstream
  // ---- the diff is a REAL diff, launched exactly once
  // A fake editor records its argv, so the assertion is on what actually ran rather
  // than on what the reply claims. (The old code ran the plain open and then the same
  // command again, and never passed `--diff` at all — while still reporting "diff".)
  const repo = join(scratch, "repo");
  mkdirSync(repo, { recursive: true });
  const tracked = join(repo, "tracked.txt");
  const gitArgs = ["-c", "user.email=bridge@local", "-c", "user.name=bridge"];
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(tracked, "one\n", "utf8");
  execFileSync("git", [...gitArgs, "add", "tracked.txt"], { cwd: repo });
  execFileSync("git", [...gitArgs, "commit", "-qm", "base"], { cwd: repo });
  writeFileSync(tracked, "two\n", "utf8");

  const argvLog = join(scratch, "editor-argv.log");
  const fakeEditor = join(scratch, "fake-editor");
  writeFileSync(fakeEditor, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${argvLog}"\nexit 0\n`, { mode: 0o755 });
  const diffPort = await freePort();
  const diffBridge = await startBridge({
    port: diffPort,
    upstream: `127.0.0.1:${upstreamPort}`,
    roots: [scratch],
    injectClickScript: false,
    openCommand: fakeEditor,
    launchMode: "editor", // no portal fallback, so exactly one launch can happen
    token,
    secret: randomBytes(32),
    onEvent: () => {},
  });
  const diffReply = await (await fetch(new URL("/__bridge/diff", diffBridge.url), {
    method: "POST",
    headers: { "content-type": "application/json", "x-bridge-token": token },
    body: JSON.stringify({ file: join(repo, "tracked.txt") }),
  })).json();
  check("a diff request really passes --diff with the HEAD snapshot", diffReply.mode === "diff" && String(diffReply.command).includes("--diff") && String(diffReply.command).includes("HEAD-"), JSON.stringify(diffReply.command));
  // A SECOND diff of the same file: the snapshot name used to be fixed, so `wx` made this
  // fail with EEXIST and the reply silently degraded to a plain open.
  const diffAgain = await (await fetch(new URL("/__bridge/diff", diffBridge.url), {
    method: "POST",
    headers: { "content-type": "application/json", "x-bridge-token": token },
    body: JSON.stringify({ file: join(repo, "tracked.txt") }),
  })).json();
  check("a second diff of the SAME file is still a real diff", diffAgain.mode === "diff" && String(diffAgain.command).includes("--diff"), JSON.stringify({ mode: diffAgain.mode, note: diffAgain.note, error: diffAgain.error }));
  check("...with its own snapshot, not the previous one", diffAgain.headFile !== diffReply.headFile, JSON.stringify({ first: diffReply.headFile, second: diffAgain.headFile }));

  const launches = readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean);
  check("...and launches the editor exactly once per request", launches.length === 2, JSON.stringify(launches));
  check("...with the snapshot first and the working file last", launches.every((line) => /--diff\s+\S*HEAD-\S*\s+\S*tracked\.txt$/u.test(line)), JSON.stringify(launches));
  // ---- 批次 3:不该上游看到的东西,以及"只清旧快照"这条规则
  // 用此刻还活着的那台(diffBridge):主桥在这一段之前已经关闭
  await fetch(diffBridge.url, { headers: { "x-bridge-token": token } });
  const lastSeen = seenUpstream.at(-1);
  check("the bridge never forwards its own request token upstream", lastSeen?.headers["x-bridge-token"] === undefined, JSON.stringify(Object.keys(lastSeen?.headers ?? {}).filter((k) => k.includes("token"))));
  check("...while still injecting the session cookie", typeof lastSeen?.headers.cookie === "string" && lastSeen.headers.cookie.length > 0);

  // 只清"旧"快照:把上一份的 mtime 拨旧,再请求一次 diff,它应当被清掉,而新发出去的那份必须还在
  const aged = String(diffReply.headFile ?? "");
  const longAgo = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(aged, longAgo, longAgo);
  await (await fetch(new URL("/__bridge/diff", diffBridge.url), {
    method: "POST",
    headers: { "content-type": "application/json", "x-bridge-token": token },
    body: JSON.stringify({ file: join(repo, "tracked.txt") }),
  })).json();
  check("an aged snapshot is pruned by the next diff", existsSync(aged) === false, aged);
  check("...while the snapshot just handed out survives", existsSync(String(diffAgain.headFile ?? "")) === true, String(diffAgain.headFile));

  // The scratch root is a per-instance promise: it must be gone once the bridge is.
  const scratchRoot = dirname(String(diffReply.headFile ?? ""));
  check("the HEAD snapshot lives under a per-instance scratch root", scratchRoot.includes("dsh-web-bridge-"), scratchRoot);
  check("...which exists while the bridge does", existsSync(scratchRoot) === true, scratchRoot);
  await diffBridge.close();
  await new Promise((resolve) => setTimeout(resolve, 200));
  check("...and is removed when the bridge closes", existsSync(scratchRoot) === false, scratchRoot);

  await new Promise((done) => upstream.close(done));
}

// The fixtures live in one scratch directory; leaving it behind used to be the suite's
// only lasting side effect (ten of them per run across all suites, see docs/TODO.md).
rmSync(scratch, { recursive: true, force: true });

const failed = results.filter(([, ok]) => !ok).length;
console.log(failed === 0 ? `\n全部通过（${results.length} 项）` : `\n失败 ${failed}/${results.length} 项`);
process.exit(failed === 0 ? 0 : 1);
