// Regression test for the injected click matcher: run the real script inside a
// vm sandbox with fake DOM objects and assert what it accepts.
//
//   node verify-click-match.mjs
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const listeners = [];
const sandbox = {
  window: { __DSH_BRIDGE__: { token: "test-token", roots: ["/tmp"] } },
  document: {
    body: { appendChild() {} },
    addEventListener: (type, handler) => listeners.push([type, handler]),
    createElement: () => ({ style: {}, remove() {} }),
  },
  location: { href: "http://127.0.0.1:39977/" },
  fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) }),
  console: { info() {}, warn() {}, error() {} },
  setTimeout: () => 0,
};
sandbox.window.parentElement = null;
sandbox.document.body.tagName = "BODY";
createContext(sandbox);
runInContext(readFileSync(new URL("./lib/click-script.js", import.meta.url), "utf8"), sandbox);

const matcher = sandbox.window.__DSH_BRIDGE_MATCH__;
const element = (text, attrs = {}, extra = {}) => ({
  tagName: "SPAN",
  textContent: text,
  parentElement: null,
  getAttributeNames: () => Object.keys(attrs),
  getAttribute: (name) => (name in attrs ? attrs[name] : null),
  ...extra,
});

import { createChecks } from "./verify-support.mjs";

const { results, check, summary } = createChecks();

// The exact false positive recorded in /__bridge/log on 2026-10-15 12:54:46.
const falsePositive =
  "这个readme工作区内修改DeepSeek V4.1 Flash (CC)high32 轮 258 步·168 tok/s69.3M tok·缓存命中 98%·≥$0.70Session cost ≥$0.7050%";

check("rejects the recorded status-line false positive", matcher.textTarget(falsePositive) === undefined);
check("rejects an empty text node", matcher.textTarget("") === undefined);
check("rejects bare prose with no path", matcher.textTarget("这个 readme 写的是什么意思") === undefined);
check("rejects a numeric-led extension (tok/s69.3M)", matcher.attrTarget("168 tok/s69.3M tok") === undefined);

// ---- paths are allowed to contain spaces and non-ASCII letters
//      (a working directory called `dsh workspace`, a file called `测试清单.md`)
const cjkAbsolute = matcher.textTarget("/home/shuaige/code/dsh workspace/测试清单.md");
check("a path with a space and CJK letters is recognised whole-text", cjkAbsolute?.path === "/home/shuaige/code/dsh workspace/测试清单.md", JSON.stringify(cjkAbsolute));
check("...and its attribute form is recognised too", matcher.attrTarget("在侧边栏打开 /home/shuaige/code/dsh workspace/测试清单.md")?.path === "/home/shuaige/code/dsh workspace/测试清单.md", JSON.stringify(matcher.attrTarget("在侧边栏打开 /home/shuaige/code/dsh workspace/测试清单.md")));
check("a CJK directory name works as well", matcher.textTarget("/tmp/项目/src/主程序.ts")?.path === "/tmp/项目/src/主程序.ts", JSON.stringify(matcher.textTarget("/tmp/项目/src/主程序.ts")));
{
  // The official chip for a delivered file: the full path lives in `title`, the
  // label may be a bare basename with a line — the two halves are combined.
  const chip = matcher.findTarget(element("测试清单.md:12", { title: "/home/shuaige/code/dsh workspace/测试清单.md" }));
  check("a CJK chip hands over its path AND its line", chip?.path === "/home/shuaige/code/dsh workspace/测试清单.md" && chip.line === 12, JSON.stringify(chip));
}
check(
  "...and the affordance recognises it too",
  matcher.isPathElement({ tagName: "CODE", textContent: "/home/shuaige/code/dsh workspace/测试清单.md", parentElement: null, getAttribute: () => null }, "inline") === true,
);
// Still rejected: prose with a path inside it, and the recorded status line.
check("a path inside a sentence is still not a whole-text path", matcher.textTarget("详见 /home/shuaige/code/dsh workspace/测试清单.md 的说明") === undefined);
check("...and the recorded status line is still refused", matcher.attrTarget(falsePositive) === undefined && matcher.textTarget(falsePositive) === undefined);

const plain = matcher.textTarget("dsh-bridge/README.md");
check("accepts a plain relative path", plain?.path === "dsh-bridge/README.md" && plain.line === undefined, JSON.stringify(plain));

const withLine = matcher.textTarget("  src/main/app.ts:42  ");
check("accepts a path with :line", withLine?.path === "src/main/app.ts" && withLine.line === 42, JSON.stringify(withLine));

const hashLine = matcher.textTarget("lib/bridge.js#L12");
check("accepts a #L line suffix", hashLine?.path === "lib/bridge.js" && hashLine.line === 12, JSON.stringify(hashLine));

const quoted = matcher.textTarget('"dsh-web-bridge/lib/index.js"');
check("accepts a quoted path", quoted?.path === "dsh-web-bridge/lib/index.js", JSON.stringify(quoted));

const bracketed = matcher.textTarget("[src/api/server.ts:7]");
check("accepts a bracketed path with a line", bracketed?.path === "src/api/server.ts" && bracketed.line === 7, JSON.stringify(bracketed));

const range = matcher.textTarget("src/main/app.ts:42-60");
check("accepts a line RANGE and takes its first line", range?.path === "src/main/app.ts" && range.line === 42, JSON.stringify(range));

const col = matcher.textTarget("src/main/app.ts:42:7");
check("accepts a line:column suffix", col?.line === 42, JSON.stringify(col));

const prose = matcher.attrTarget("打开 dsh-bridge/README.md 看看");
check("attribute search returns only the matched path", prose?.path === "dsh-bridge/README.md", JSON.stringify(prose));

const proseLine = matcher.attrTarget("Read src/api/server.ts:12 first");
check("attribute search keeps the line suffix", proseLine?.path === "src/api/server.ts" && proseLine.line === 12, JSON.stringify(proseLine));

const fromData = matcher.findTarget(element("a/b/c.py", { "data-review-file": "a/b/c.py" }));
check("finds a path through data-review-file", fromData?.path === "a/b/c.py" && fromData.via === "data-review-file", JSON.stringify(fromData));

const fromTitle = matcher.findTarget(element("", { title: "打开 docs/guide/setup.md:8" }));
check("finds a path embedded in title", fromTitle?.path === "docs/guide/setup.md" && fromTitle.line === 8, JSON.stringify(fromTitle));

const fromText = matcher.findTarget(element("src/features/auth/login.ts"));
check("finds a path from a leaf text node", fromText?.path === "src/features/auth/login.ts" && fromText.via === "text", JSON.stringify(fromText));

const nothing = matcher.findTarget(element(falsePositive));
check("findTarget returns nothing for the status line", nothing === undefined);
check("installed a capture-phase click listener", listeners.some(([type]) => type === "click"));


/**
 * Mount the real click script in a fresh sandbox and run ONE click through it,
 * against a bridge that only accepts `validToken`. Returns what the page did:
 * which requests it sent, which toasts it showed, whether it reloaded.
 */
const mountAndClick = async ({ pageToken = "stale", validToken = "fresh", documentToken = "fresh", reloadAllowed = true, reply = {}, reject = false, text = "src/app.ts:3", config = {}, ua = "", framed = false, modifiers = {} } = {}) => {
  const calls = [];
  const greetings = [];
  const event = { prevented: 0, stopped: 0 };
  const handedBack = { clicks: 0 };
  const toasts = [];
  const styles = [];
  const reloads = [];
  const handlers = [];
  const sandbox = {
    window: { __DSH_BRIDGE__: { token: pageToken, roots: [], ...config } },
    navigator: { userAgent: ua },
    document: {
      body: {
        tagName: "BODY",
        appendChild: (el) => {
          toasts.push(el.textContent);
          styles.push(el.style.cssText);
        },
      },
      addEventListener: (type, handler) => handlers.push(handler),
      createElement: () => ({ style: {}, remove() {}, textContent: "" }),
    },
    location: { href: "http://127.0.0.1:39977/", reload: () => reloads.push(Date.now()) },
    sessionStorage: { getItem: () => (reloadAllowed ? null : String(Date.now())), setItem: () => {} },
    fetch: async (url, options = {}) => {
      if (url === "http://127.0.0.1:39977/") {
        calls.push({ kind: "document" });
        const body = documentToken === null ? "<html><body>no token here</body></html>" : `<script>window.__DSH_BRIDGE__={"token":"${documentToken}","roots":[]};</script>`;
        return { ok: true, status: 200, text: async () => body };
      }
      const sent = options.headers["x-bridge-token"];
      const body = JSON.parse(options.body);
      // The once-per-load environment report is not part of the click behaviour, so it
      // is kept out of `calls` — the sequence assertions below are about clicks.
      if (body?.kind === "hello") {
        greetings.push({ token: sent, body });
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      calls.push({ kind: "post", url, token: sent, body });
      const accepted = !reject && sent === validToken;
      return {
        ok: accepted,
        status: accepted ? 200 : reject ? 400 : 403,
        json: async () =>
          accepted
            ? { ok: true, file: "/tmp/project/src/app.ts", line: 3, ...reply }
            : { ok: false, error: "missing or wrong bridge token", ...reply },
      };
    },
    console: { info() {}, warn() {}, error() {} },
    setTimeout: () => 0,
  };
  sandbox.window.parentElement = null;
  // `top === window` means "top-level document" — and the MEASURED VS Code page is
  // exactly that, so a shell can only be recognised through the user agent there.
  sandbox.window.top = framed ? {} : sandbox.window;
  createContext(sandbox);
  runInContext(readFileSync(new URL("./lib/click-script.js", import.meta.url), "utf8"), sandbox);
  // The suffix is carried through the retry, so the assertions can see it.
  await handlers[0]({
    target: element(text, {}, { click: () => { handedBack.clicks += 1; } }),
    altKey: false,
    ...modifiers,
    preventDefault: () => { event.prevented += 1; },
    stopPropagation: () => { event.stopped += 1; },
  });
  return { calls, greetings, toasts, styles, reloads, event, handedBack };
};

// ---- a stale token (the page is older than the bridge) must heal itself
{
  const run = await mountAndClick({ pageToken: "stale", validToken: "fresh", documentToken: "fresh" });
  check(
    "a 403 renews the token from the document and retries the same request",
    run.calls.map((call) => call.kind).join(",") === "post,post,document,post" &&
      run.calls[1].token === "stale" &&
      run.calls[3].token === "fresh" &&
      run.calls[3].body.file === "src/app.ts" &&
      run.calls[3].body.line === 3 &&
      run.calls[3].body.via === "text",
    JSON.stringify(run.calls.map((call) => [call.kind, call.token])),
  );
  check("...and the click then succeeds, without a reload", run.toasts.at(-1)?.includes("open /tmp/project/src/app.ts:3") && run.reloads.length === 0, JSON.stringify(run.toasts));
}

// ---- when the token cannot be read back, the page reloads itself exactly once
{
  const run = await mountAndClick({ pageToken: "stale", validToken: "fresh", documentToken: null });
  check("an unreadable token falls back to one reload", run.reloads.length === 1 && run.toasts.at(-1)?.includes("正在刷新"), JSON.stringify({ reloads: run.reloads.length, toasts: run.toasts }));
}

// ---- the reload guard: a bridge that keeps refusing must not loop the tab
{
  const run = await mountAndClick({ pageToken: "stale", validToken: "fresh", documentToken: null, reloadAllowed: false });
  check(
    "...but not twice inside the cooldown — it reports the refusal instead",
    run.reloads.length === 0 && run.toasts.at(-1)?.includes("missing or wrong bridge token"),
    JSON.stringify({ reloads: run.reloads.length, toasts: run.toasts }),
  );
}


// ---- the official UI's file chip: path in `title`, label (with the line) in text.
//      This is the shape DSH renders for `[index.js:19-40](<path#L19-L40>)`.
{
  const chip = (title, text) => element(text, { title, type: "button" });
  const whole = matcher.findTarget(chip("dsh-web-bridge/lib/index.js", "index.js:19-40"));
  check(
    "a file chip's line is taken from its visible label",
    whole?.path === "dsh-web-bridge/lib/index.js" && whole.line === 19 && whole.via === "title",
    JSON.stringify(whole),
  );
  const single = matcher.findTarget(chip("dsh-web-bridge/lib/index.js", "index.js:250"));
  check("a single-line label works too", single?.line === 250, JSON.stringify(single));
  const hash = matcher.findTarget(chip("src/api/server.ts", "server.ts#L42"));
  check("a #L label works too", hash?.line === 42, JSON.stringify(hash));
  const bare = matcher.findTarget(chip("dsh-web-bridge/lib/index.js", "index.js"));
  check("a label with no line stays line-free (opens at the top)", bare?.path === "dsh-web-bridge/lib/index.js" && bare.line === undefined, JSON.stringify(bare));
  const attrLine = matcher.findTarget(chip("src/api/server.ts:12", "whatever.ts"));
  check("a line inside the attribute is not overridden by the label", attrLine?.line === 12, JSON.stringify(attrLine));
}


// ---- the affordance: a path the official UI left inert must LOOK clickable,
//      without asking DSH, the model, or the reader for anything.
const fakeEl = (tag, text, { children = [], attrs = {}, display = "inline", editable = false } = {}) => {
  const el = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    textContent: text,
    firstElementChild: children[0] ?? null,
    parentElement: null,
    isContentEditable: editable,
    display,
    attrs: { ...attrs },
  };
  el.getAttribute = (name) => (name in el.attrs ? el.attrs[name] : null);
  el.setAttribute = (name, value) => {
    el.attrs[name] = String(value);
  };
  el.removeAttribute = (name) => {
    delete el.attrs[name];
  };
  children.forEach((child, index) => {
    child.parentElement = el;
    Object.defineProperty(child, "nextElementSibling", { get: () => children[index + 1] ?? null, configurable: true });
  });
  return el;
};

const LINK = "data-dsh-bridge-link";
{
  const code = fakeEl("code", "bridge-jump-test/index.html:250");
  check("an inline code element holding a path is decorable", matcher.isPathElement(code, "inline") === true);
  check("the same text in a block box is not", matcher.isPathElement(code, "block") === false);
  check("prose is not", matcher.isPathElement(fakeEl("code", "见 src/app.ts:12 的说明"), "inline") === false);
  const chip = fakeEl("button", "bridge-jump-test/index.html:250");
  check("an interactive element is left alone", matcher.isPathElement(chip, "inline") === false);
  const inEditor = fakeEl("div", "bridge-jump-test/index.html:250", { editable: true });
  check("the composer is left alone", matcher.isPathElement(inEditable(code, inEditor), "inline") === false);
}

// helper: put `child` inside `parent` so the isInteractive walk can see it
function inEditable(child, parent) {
  child.parentElement = parent;
  return child;
}

{
  const code = fakeEl("code", "bridge-jump-test/index.html:250");
  matcher.sync(code);
  check("sync marks a path and explains itself in the tooltip", code.attrs[LINK] === "" && typeof code.attrs.title === "string", JSON.stringify(code.attrs));
  code.textContent = "改成了普通文字";
  matcher.sync(code);
  check("...and unmarks it when the text stops being a path", !(LINK in code.attrs) && !("title" in code.attrs), JSON.stringify(code.attrs));
}

{
  const timers = [];
  const observers = [];
  const styles = [];
  const listeners = [];
  const existing = fakeEl("code", "bridge-jump-test/index.html:250");
  const body = fakeEl("body", "", { children: [existing] });
  const sandbox = {
    window: { __DSH_BRIDGE__: { token: "test-token", roots: [] }, getComputedStyle: (el) => ({ display: el.display ?? "inline" }) },
    document: {
      body,
      head: { appendChild: (el) => styles.push(el) },
      createElement: () => ({ id: "", textContent: "" }),
      getElementById: () => null,
      addEventListener: (type, handler) => listeners.push(handler),
    },
    location: { href: "http://127.0.0.1:39977/" },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }
      observe(target, options) {
        this.target = target;
        this.options = options;
      }
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout: (fn) => {
      timers.push(fn);
      return 0;
    },
    console: { info() {}, warn() {}, error() {} },
  };
  createContext(sandbox);
  runInContext(readFileSync(new URL("./lib/click-script.js", import.meta.url), "utf8"), sandbox);

  check("the stylesheet is installed", styles.length === 1 && styles[0].id === "dsh-web-bridge-affordance" && styles[0].textContent.includes("cursor: pointer"), `${styles.length} style(s)`);
  check("existing paths are marked on load", existing.attrs[LINK] === "", JSON.stringify(existing.attrs));
  check(
    "a watcher follows the chat, including streamed text",
    observers.length === 1 && observers[0].options.childList === true && observers[0].options.subtree === true && observers[0].options.characterData === true,
    JSON.stringify(observers[0]?.options),
  );

  const added = fakeEl("code", "dsh-web-bridge/lib/bridge.js:12");
  observers[0].callback([{ type: "childList", addedNodes: [added] }]);
  check("a newly rendered path is queued, not marked inline", !(LINK in added.attrs), JSON.stringify(added.attrs));
  timers.pop()();
  check("...and marked once the batch flushes", added.attrs[LINK] === "", JSON.stringify(added.attrs));

  const streamed = fakeEl("code", "还没写完");
  observers[0].callback([{ type: "characterData", target: { parentElement: streamed } }]);
  streamed.textContent = "src/api/server.ts:7";
  timers.pop()();
  check("a streamed text update is picked up too", streamed.attrs[LINK] === "", JSON.stringify(streamed.attrs));
}

{
  const styles = [];
  const sandbox = {
    window: { __DSH_BRIDGE__: { token: "t", roots: [] }, getComputedStyle: () => ({ display: "inline" }) },
    document: {
      body: fakeEl("body", "", { children: [fakeEl("code", "a/b/c.ts:1")] }),
      head: { appendChild: (el) => styles.push(el) },
      createElement: () => ({ id: "", textContent: "" }),
      getElementById: () => null,
      addEventListener: () => {},
    },
    location: { href: "http://127.0.0.1:39977/" },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    localStorage: { getItem: (key) => (key === "dsh-web-bridge:decorate" ? "off" : null), setItem: () => {} },
    setTimeout: () => 0,
    console: { info() {}, warn() {}, error() {} },
  };
  createContext(sandbox);
  runInContext(readFileSync(new URL("./lib/click-script.js", import.meta.url), "utf8"), sandbox);
  check("the localStorage escape hatch turns decoration off", styles.length === 0 && sandbox.document.body.firstElementChild.attrs[LINK] === undefined);
}

// ---- what the toast says about WHERE the file was found and WHAT is on the line
{
  const scanned = await mountAndClick({ reply: { resolvedBy: "scan", root: "/tmp/dsh workspace/project", lineText: "line three" } });
  const text = scanned.toasts.at(-1);
  check("the toast names the subdirectory the file was found under", text.includes("在 project/ 下找到"), JSON.stringify(text));
  check("...and echoes the line it is about to land on", text.includes(":3 「line three」"), JSON.stringify(text));
  check("...and is still a success toast", scanned.styles.at(-1).includes("#1f6f3f"), scanned.styles.at(-1));
}

{
  const beyond = await mountAndClick({ reply: { beyond: true, total: 165 } });
  check("a line past the end of the file is warned about, not silently opened", beyond.toasts.at(-1).includes("文件只有 165 行"), JSON.stringify(beyond.toasts.at(-1)));
  check("...in the error colour", beyond.styles.at(-1).includes("#b3261e"), beyond.styles.at(-1));
}

{
  const ambiguous = await mountAndClick({
    pageToken: "fresh",
    reject: true,
    reply: { error: "docs/X.md exists in 2 places, so this bridge will not guess", candidates: ["/a/docs/X.md", "/b/docs/X.md"] },
  });
  const text = ambiguous.toasts.at(-1);
  check("an ambiguous answer lists the candidates instead of guessing", text.includes("/a/docs/X.md") && text.includes("/b/docs/X.md"), JSON.stringify(text));
  check("...and does not try to renew a token over it", ambiguous.calls.every((call) => call.kind === "post"), JSON.stringify(ambiguous.calls.map((call) => call.kind)));
}

// ---- anchors: `path#text` is resolved against the file when the click happens
{
  const anchored = matcher.textTarget("lib/index.js#deriveToken");
  check("a whole-text `path#anchor` is recognised as an anchor", anchored?.path === "lib/index.js" && anchored.anchor === "deriveToken" && anchored.line === undefined, JSON.stringify(anchored));

  const spaced = matcher.textTarget("lib/index.js#export const deriveToken");
  check("an anchor may contain spaces", spaced?.anchor === "export const deriveToken", JSON.stringify(spaced));

  const line = matcher.textTarget("lib/index.js#L24");
  check("`#L24` stays a LINE and is never mistaken for an anchor", line?.line === 24 && line.anchor === undefined, JSON.stringify(line));

  const ranged = matcher.textTarget("lib/index.js#L24-L30");
  check("`#L24-L30` takes its first line, still not an anchor", ranged?.line === 24 && ranged.anchor === undefined, JSON.stringify(ranged));

  const rangedColon = matcher.textTarget("lib/index.js:24-30");
  check("`:24-30` takes its first line too", rangedColon?.line === 24 && rangedColon.anchor === undefined, JSON.stringify(rangedColon));

  check("lineTail reads a `#L24-L30` range off a chip label", matcher.lineTail("index.js#L24-L30") === 24, String(matcher.lineTail("index.js#L24-L30")));

  check("anchorTail reads the anchor off a chip label", matcher.anchorTail("index.js#deriveToken") === "deriveToken", String(matcher.anchorTail("index.js#deriveToken")));
  check("...but refuses to read `#L24` as an anchor", matcher.anchorTail("index.js#L24") === undefined, String(matcher.anchorTail("index.js#L24")));
  check("...and refuses an empty one", matcher.anchorTail("index.js#") === undefined, String(matcher.anchorTail("index.js#")));

  // The official chip's shape again: path in `title`, everything else in the label.
  const chip = matcher.findTarget(element("index.js#deriveToken", { title: "dsh-web-bridge/lib/index.js" }));
  check(
    "a chip whose label carries an anchor hands both halves over",
    chip?.path === "dsh-web-bridge/lib/index.js" && chip.anchor === "deriveToken" && chip.via === "title",
    JSON.stringify(chip),
  );

  check("an anchored path still gets the clickable affordance", matcher.isPathElement(fakeEl("code", "lib/index.js#deriveToken"), "inline") === true);
}

{
  const sent = await mountAndClick({ text: "lib/index.js#deriveToken", pageToken: "fresh", reply: { file: "/tmp/project/lib/index.js", anchor: "deriveToken", anchorMatches: 1, lineText: "export const deriveToken = (secret) =>" } });
  const post = sent.calls.find((call) => call.kind === "post" && call.body?.anchor !== undefined);
  check("the click request carries the anchor", post?.body.anchor === "deriveToken" && post.body.file === "lib/index.js", JSON.stringify(post?.body));
  check("...and the toast names the anchor and what it found", sent.toasts.at(-1).includes("锚点「deriveToken」命中 1 处") && sent.toasts.at(-1).includes("export const deriveToken"), JSON.stringify(sent.toasts.at(-1)));
}

{
  const repeated = await mountAndClick({ text: "lib/index.js#deriveToken", pageToken: "fresh", reply: { file: "/tmp/p/lib/index.js", line: 3, anchor: "deriveToken", anchorMatches: 3 } });
  check("a repeated anchor says how many it found", repeated.toasts.at(-1).includes("命中 3 处，取第一处"), JSON.stringify(repeated.toasts.at(-1)));
}

{
  const missed = await mountAndClick({ text: "lib/index.js#nope", pageToken: "fresh", reply: { file: "/tmp/p/lib/index.js", line: 9, anchor: "nope", anchorMatches: 0, anchorMissed: true } });
  check("a missed anchor is reported, and the line still opened", missed.toasts.at(-1).includes("锚点「nope」没找到") && missed.toasts.at(-1).includes(":9"), JSON.stringify(missed.toasts.at(-1)));
}

// ---- the environment report: the hijack decision needs facts, not a user agent
{
  const run = await mountAndClick({ pageToken: "fresh" });
  check("a page announces its environment exactly once per load", run.greetings.length === 1 && run.greetings[0].body.kind === "hello", JSON.stringify(run.greetings.map((entry) => entry.body.kind)));
  check("...saying whether it is embedded in a shell, and what it runs in", typeof run.greetings[0]?.body.embedded === "boolean" && typeof run.greetings[0]?.body.ua === "string", JSON.stringify(run.greetings[0]?.body));
  check("...and it stays out of the click sequence the other assertions read", run.calls.every((call) => call.body?.kind !== "hello"), JSON.stringify(run.calls.map((call) => call.body?.kind)));
}

// ---- taking over the official chip: measured facts, three states, and a hand-back
{
  // The two user agents actually observed in /__bridge/log on this machine.
  const VSCODE_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.141.0 Chrome/150.0.7871.250 Electron/43.7.7 Safari/537.36";
  const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

  check("the measured VS Code agent reads as an IDE shell", matcher.classifyShell(VSCODE_UA, false) === "ide", matcher.classifyShell(VSCODE_UA, false));
  check("a plain browser agent does not — even though it is top-level too", matcher.classifyShell(BROWSER_UA, false) === "browser", matcher.classifyShell(BROWSER_UA, false));
  check("JetBrains' JCEF marker is recognised without having been measured here", matcher.classifyShell("Mozilla/5.0 JCEF/123 Chrome/100", false) === "ide");
  check("a bare embedded frame counts as a shell even with an ordinary agent", matcher.classifyShell(BROWSER_UA, true) === "frame");
}

{
  const off = await mountAndClick({ config: { hijackChip: "off" }, ua: "Code/1.141.0 Electron/43.7.7", pageToken: "fresh" });
  check("`off` never suppresses the Harness's own handler", off.event.prevented === 0 && off.event.stopped === 0, JSON.stringify(off.event));
  check("...but the click still opens the editor", off.calls.some((call) => call.body?.file === "src/app.ts"), JSON.stringify(off.calls.map((call) => call.body)));
}

{
  const on = await mountAndClick({ config: { hijackChip: "on" }, ua: "Code/1.141.0 Electron/43.7.7", pageToken: "fresh" });
  check("`on` takes the click over, so no second tab is opened", on.event.prevented === 1 && on.event.stopped === 1, JSON.stringify(on.event));
}

{
  const autoIde = await mountAndClick({ config: { hijackChip: "auto" }, ua: "Code/1.141.0 Electron/43.7.7", pageToken: "fresh" });
  check("`auto` takes over inside the IDE shell", autoIde.event.prevented === 1, JSON.stringify(autoIde.event));
  const autoBrowser = await mountAndClick({ config: { hijackChip: "auto" }, ua: "Chrome/154.0.0.0 Safari/537.36", pageToken: "fresh" });
  check("...and leaves a plain browser tab to the Harness", autoBrowser.event.prevented === 0 && autoBrowser.event.stopped === 0, JSON.stringify(autoBrowser.event));
  const autoFrame = await mountAndClick({ config: { hijackChip: "auto" }, ua: "Chrome/154.0.0.0 Safari/537.36", framed: true, pageToken: "fresh" });
  check("...while a real iframe still counts as a shell", autoFrame.event.prevented === 1, JSON.stringify(autoFrame.event));
}

{
  const missed = await mountAndClick({ config: { hijackChip: "on" }, ua: "Code/1.141.0 Electron/43.7.7", pageToken: "fresh", reject: true, reply: { error: "no such file under /tmp" } });
  check("a failed open hands the click back instead of leaving nothing", missed.handedBack.clicks === 1, JSON.stringify(missed.handedBack));
  check("...and the hand-back does not loop into a second bridge call", missed.calls.filter((call) => call.body?.file !== undefined).length === 1, JSON.stringify(missed.calls.map((call) => call.body?.file)));
}

{
  const hello = await mountAndClick({ config: { hijackChip: "auto" }, ua: "Code/1.141.0 Electron/43.7.7", pageToken: "fresh" });
  check("the load report says which shell it is and whether it takes over", hello.greetings[0]?.body.shell === "ide" && hello.greetings[0]?.body.hijack === true, JSON.stringify(hello.greetings[0]?.body));
}

// ---- the affordance must not destroy what it decorates
{
  const el = fakeEl("code", "a/b/c.ts:1", { attrs: { title: "原有的提示" } });
  matcher.sync(el);
  check(
    "decoration parks the original tooltip instead of destroying it",
    el.attrs.title !== "原有的提示" && el.attrs["data-dsh-bridge-title"] === "原有的提示",
    JSON.stringify(el.attrs),
  );
  el.textContent = "不再是路径了";
  matcher.sync(el);
  check(
    "...and puts it back when the mark is removed",
    el.attrs.title === "原有的提示" && !("data-dsh-bridge-title" in el.attrs),
    JSON.stringify(el.attrs),
  );
  const bare = fakeEl("code", "a/b/c.ts:1");
  matcher.sync(bare);
  bare.textContent = "不再是路径了";
  matcher.sync(bare);
  check("...leaving no stray title on an element that had none", !("title" in bare.attrs), JSON.stringify(bare.attrs));
}

// ---- 回归:DSH 查看器的"标签条"把三段文字拼成了一串,曾被当成路径
//      (真机日志原文:found=hello.html/home/dev/hello.htmlHTML via=text → no such file)
{
  const textNode = (value) => ({ nodeType: 3, nodeValue: value });
  const elNode = (text, childNodes, attrs = {}) => {
    const el = { nodeType: 1, tagName: "SPAN", textContent: text, childNodes, parentElement: null, attrs, getAttribute: (n) => (n in attrs ? attrs[n] : null), getAttributeNames: () => Object.keys(attrs) };
    for (const child of childNodes) if (child.nodeType === 1) child.parentElement = el;
    return el;
  };

  const tabLabel = elNode("hello.html", [textNode("hello.html")]);
  const crumb = elNode("/home/dev/hello.html", [textNode("/home/dev/hello.html")]);
  const badge = elNode("HTML", [textNode("HTML")]);
  const strip = elNode("hello.html/home/dev/hello.htmlHTML", [tabLabel, crumb, badge], { role: "tablist" });
  const closeBtn = elNode("", [], { "aria-label": "关闭" });
  closeBtn.parentElement = strip;

  check(
    "a container that GLUES several children's text is not a path (the tab-strip bug)",
    matcher.findTarget(strip) === undefined,
    JSON.stringify(matcher.findTarget(strip)),
  );
  // 真实 DOM 是"只套一层包装、拼接源在里面":包装层只有一个元素子节点,旧规则只看直接子节点 → 放行 ✗
  const pane = elNode("hello.html关闭/home/dev/hello.htmlHTML", [strip]);
  check(
    "a single wrapper AROUND the strip is rejected too (the real shape, B1 verdict)",
    matcher.findTarget(pane) === undefined,
    JSON.stringify(matcher.findTarget(pane)),
  );
  check(
    "...while a wrapper around a plain leaf is still fine",
    matcher.findTarget(elNode("dsh-web-bridge/lib/bridge.js", [elNode("dsh-web-bridge/lib/bridge.js", [textNode("dsh-web-bridge/lib/bridge.js")])]))?.path === "dsh-web-bridge/lib/bridge.js",
  );
  check(
    "...so clicking the tab's close button no longer reports a bogus path",
    matcher.findTarget(closeBtn) === undefined,
    JSON.stringify(matcher.findTarget(closeBtn)),
  );
  check(
    "...and the affordance does not decorate such a container either",
    matcher.isPathElement(strip, "inline") === false,
  );
  check(
    "a leaf whose text is one path still matches",
    matcher.findTarget(elNode("dsh-web-bridge/lib/bridge.js", [textNode("dsh-web-bridge/lib/bridge.js")]))?.path === "dsh-web-bridge/lib/bridge.js",
    JSON.stringify(matcher.findTarget(elNode("dsh-web-bridge/lib/bridge.js", [textNode("dsh-web-bridge/lib/bridge.js")]))),
  );
  check(
    "...and so does a single wrapper around that leaf",
    matcher.findTarget(elNode("dsh-web-bridge/lib/bridge.js", [elNode("dsh-web-bridge/lib/bridge.js", [textNode("dsh-web-bridge/lib/bridge.js")])]))?.path === "dsh-web-bridge/lib/bridge.js",
  );
  check(
    "a paragraph with a path plus prose is refused",
    matcher.findTarget(elNode("详见 dsh-web-bridge/lib/bridge.js 的说明", [textNode("详见 "), elNode("dsh-web-bridge/lib/bridge.js", [textNode("dsh-web-bridge/lib/bridge.js")]), textNode(" 的说明")])) === undefined,
  );
  // 长扩展名不再被长度上限挡掉(以前 7 个字符封顶,`.gitignore` 就被拒了)
  check(
    "a dot-file with a long tail is a path now (.gitignore)",
    matcher.textTarget("/home/shuaige/code/dsh workspace/dsh-bridge/.gitignore")?.path === "/home/shuaige/code/dsh workspace/dsh-bridge/.gitignore",
    JSON.stringify(matcher.textTarget("/home/shuaige/code/dsh workspace/dsh-bridge/.gitignore")),
  );
}

// ---- 批次 2:用户能直接感知的五条(逗号/空格/href/菜单控件/相邻文本节点)
{
  const T = (v) => ({ nodeType: 3, nodeValue: v });
  const mk = (tag, text, kids = [], attrs = {}) => {
    const el = { nodeType: 1, tagName: tag, textContent: text, childNodes: kids, parentElement: null, attrs, getAttribute: (n) => (n in attrs ? attrs[n] : null), getAttributeNames: () => Object.keys(attrs) };
    kids.forEach((c) => { if (c.nodeType === 1) c.parentElement = el; });
    return el;
  };

  // E4:逗号几乎总是"并列两个路径"
  check("a comma-joined pair is not one path", matcher.textTarget("a/b.ts, c/d.ts") === undefined, JSON.stringify(matcher.textTarget("a/b.ts, c/d.ts")));
  check("...but a single trailing comma is still fine", matcher.textTarget("a/b.ts,")?.path === "a/b.ts", JSON.stringify(matcher.textTarget("a/b.ts,")));

  // F8:扩展名后紧跟空格 = 两个路径
  check("two paths separated by a space are not one path", matcher.textTarget("src/a.ts src/b.ts") === undefined, JSON.stringify(matcher.textTarget("src/a.ts src/b.ts")));
  check("...while a directory name with a space still works", matcher.textTarget("/home/shuaige/code/dsh workspace/测试清单.md")?.path === "/home/shuaige/code/dsh workspace/测试清单.md");

  // F9:相邻文本节点是【一个】来源,不是拼接
  const splitLeaf = mk("CODE", "a/b.md", [T("a/"), T("b.md")]);
  check("a path split across two text nodes is clickable again", matcher.findTarget(splitLeaf)?.path === "a/b.md", JSON.stringify(matcher.findTarget(splitLeaf)));

  // E6:href 只在"像文件"时才当路径
  const asLink = (href) => mk("A", "docs", [T("docs")], { href });
  check("an in-app route href is left alone", matcher.findTarget(asLink("/docs/guide.html")) === undefined, JSON.stringify(matcher.findTarget(asLink("/docs/guide.html"))));
  check("a relative href is a file reference", matcher.findTarget(asLink("./src/app.ts"))?.path === "./src/app.ts");
  // A `file:` URL is allowed through the href guard, but the path regex still wants a
  // path shape, so it resolves to nothing rather than to a wrong file. Recorded as a
  // known limitation instead of an assertion that would encode it as intended.
  const savedRoots = sandbox.window.__DSH_BRIDGE__.roots;
  sandbox.window.__DSH_BRIDGE__.roots = ["/home/shuaige/code/dsh workspace"];
  check("an absolute href under a configured root is a file reference", matcher.findTarget(asLink("/home/shuaige/code/dsh workspace/dsh-web-bridge/.gitignore"))?.path !== undefined);
  check("...and one outside every root is not", matcher.findTarget(asLink("/etc/hosts.md")) === undefined);
  sandbox.window.__DSH_BRIDGE__.roots = savedRoots;

  // F4:开菜单的控件整体跳过
  const picker = mk("BUTTON", "a.md", [T("a.md")], { "aria-haspopup": "menu", "data-review-file": "/home/x/a.md" });
  check("a control that opens a menu is not treated as a file reference", matcher.findTarget(picker) === undefined, JSON.stringify(matcher.findTarget(picker)));
  const plain = mk("BUTTON", "a.md", [T("a.md")], { "data-review-file": "/home/x/a.md" });
  check("...while a plain path-bearing button still is", matcher.findTarget(plain)?.path === "/home/x/a.md", JSON.stringify(matcher.findTarget(plain)));
}

// ---- 批次 4:diff 修饰键(B6)与脚本修订号(D1)
{
  /** The open/diff endpoint a run actually asked for (the report POST comes first). */
  const askedFor = (run) => run.calls.filter((c) => c?.url === "/__bridge/diff" || c?.url === "/__bridge/open").map((c) => c.url);
  const viaCtrl = await mountAndClick({ config: { diffModifier: "ctrl" }, modifiers: { ctrlKey: true } });
  check("diffModifier=ctrl makes Ctrl+click ask for a diff", askedFor(viaCtrl)[0] === "/__bridge/diff", JSON.stringify(askedFor(viaCtrl)));
  const viaAlt = await mountAndClick({ config: { diffModifier: "ctrl" }, modifiers: { altKey: true } });
  check("...and Alt+click no longer does (the configured mode is honoured)", askedFor(viaAlt)[0] === "/__bridge/open", JSON.stringify(askedFor(viaAlt)));
  const byDefault = await mountAndClick({ modifiers: { altKey: true } });
  check("...while the default (alt) still opens a diff on Alt+click", askedFor(byDefault)[0] === "/__bridge/diff", JSON.stringify(askedFor(byDefault)));
  const withRev = await mountAndClick({ config: { clientRev: "abc12345" } });
  check("the hello report carries the click-script revision (D1)", JSON.stringify(withRev.greetings).includes("abc12345"), JSON.stringify(withRev.greetings));
}

process.exit(summary() === 0 ? 0 : 1);
