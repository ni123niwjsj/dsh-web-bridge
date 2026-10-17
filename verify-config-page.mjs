// Regression test for the client half: render both seats in a minimal React
// sandbox and assert the slot registrations and the exact writes they emit.
// No browser required.
//
//   node verify-config-page.mjs
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

// ------------------------------------------------------------- mini React
// Hooks are scoped per component function (one instance each), like React does
// per fiber; a single global array lets a child shift the parent's slots.
const instances = new Map();
let current;
const flatten = (children) => children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false);
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: flatten(children) }),
  useState: (init) => {
    const state = current;
    const at = state.cursor++;
    if (!(at in state.slots)) state.slots[at] = typeof init === "function" ? init() : init;
    return [state.slots[at], (next) => {
      state.slots[at] = typeof next === "function" ? next(state.slots[at]) : next;
    }];
  },
  useEffect: (run) => {
    const state = current;
    const at = state.cursor++;
    const slot = state.slots[at] ?? (state.slots[at] = { ran: false, cleanup: undefined });
    if (!slot.ran) {
      slot.ran = true;
      slot.cleanup = run();
    }
  },
};
const renderNode = (node) => {
  if (node === null || node === undefined || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(renderNode);
  if (typeof node.type === "function") {
    const state = instances.get(node.type) ?? { slots: [], cursor: 0 };
    instances.set(node.type, state);
    state.cursor = 0;
    const previous = current;
    current = state;
    let rendered;
    try {
      rendered = node.type({ ...node.props, children: node.children.length === 1 ? node.children[0] : node.children });
    } finally {
      current = previous;
    }
    return renderNode(rendered);
  }
  return { ...node, children: node.children.map(renderNode) };
};
const render = (element) => renderNode(element);
const walk = (node, visit) => {
  if (node === null || node === undefined || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit));
  visit(node);
  node.children.forEach((child) => walk(child, visit));
};
const find = (tree, predicate) => {
  let hit;
  walk(tree, (node) => {
    if (hit === undefined && predicate(node)) hit = node;
  });
  return hit;
};
const label = (node) => (node.children ?? []).filter((child) => typeof child === "string").join("");
const mount = (component, props) => {
  instances.clear();
  const element = React.createElement(component, props);
  return { element, tree: () => render(element) };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ------------------------------------------------------------ load the file
let plugin;
const registrations = [];
const injected = [];
// The real registry declares `inject(name, cb)` and calls `cb` only once that
// slot exists; a stub with `register` alone once hid exactly that defect.
const slots = {
  inject: (name, register) => {
    injected.push(name);
    register();
  },
  register: (options, component) => registrations.push({ options, component }),
};
const sandbox = {
  window: {
    __DSH_BRIDGE__: { token: "t", roots: [] },
    __DSH_WEB_BRIDGE__: { state: "running", url: "http://127.0.0.1:39977/", upstream: "127.0.0.1:3080", injectClickScript: true, lastEvents: [], searchRoots: ["/home/shuaige/code", "/home/shuaige/code/dsh workspace"] },
    __ModuleLoader__: { load: ({ factory }) => { plugin = factory((name) => (name === "react" ? React : {})); } },
  },
  navigator: { language: "zh-CN", clipboard: { writeText: async () => {} } },
  console: { info() {}, warn() {}, error() {} },
  setTimeout: () => 0,
};
createContext(sandbox);
runInContext(readFileSync(new URL("./lib/client.js", import.meta.url), "utf8"), sandbox);

/** Apply the client plugin with (or without) the shared forms service. */
const applyWith = (forms) => {
  registrations.length = 0;
  plugin.apply({ get: (name) => (name === "configForms" ? forms : undefined), slots });
  return {
    section: registrations.find((entry) => entry.options.name === "settings.section"),
    rowConfig: registrations.find((entry) => entry.options.name === "plugins.row.config"),
    all: [...registrations],
  };
};

// ---------------------------------------------------------------- assertions
const results = [];
const check = (name, ok, detail = "") => {
  results.push([name, ok]);
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? `  ${detail}` : ""}`);
};

const ROW_KEY = "@ni123niwjsj/dsh-web-bridge#dsh-web-bridge";
const ROW = "dsh-web-bridge";
const base = { port: 39977, upstream: "127.0.0.1:3080", roots: [], injectClickScript: true, decorate: true, hijackChip: "off", autoStart: true, openCommand: "code", launchMode: "auto" };

/** Form as the row configuration page receives it. */
const makeRowForm = (value, extra = {}, calls = []) => ({
  state: { status: extra.status ?? "ready", value, base: undefined, user: extra.user ?? {}, revision: 7, writable: extra.writable !== false, mode: "host" },
  mutate: async (ops, revision) => {
    calls.push({ ops, revision });
    return extra.accept !== false;
  },
});
/** Form as the shared `configForms` service hands it out. */
const makeSharedForm = (value, extra = {}, calls = []) => {
  const snapshot = { status: extra.status ?? "ready", value, base: undefined, user: extra.user ?? {}, revision: extra.revision ?? 11, writable: extra.writable !== false, mode: "host" };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate: async (ops, revision) => {
      calls.push({ ops, revision });
      return extra.accept !== false;
    },
    set: async () => true,
    unset: async () => true,
  };
};
const SERVED = [{ ns: "llm-deepseek" }, { ns: "settings.agentLoop" }];
const makeService = (byId, fallback, served = SERVED) => ({
  get: (id) => byId[id] ?? fallback ?? makeSharedForm({}, { status: "unavailable" }),
  describe: () => ({ getSnapshot: () => ({ view: { namespaces: served }, writable: true }) }),
});

// ---- seat registration
let regs = applyWith(undefined);
check("registers the settings section", regs.section?.options.id === ROW, JSON.stringify(regs.section?.options));
check("registers the row config page with the package#row key", regs.rowConfig?.options.key === ROW_KEY, JSON.stringify(regs.rowConfig?.options));
check("registers exactly two seats", regs.all.length === 2, `count=${regs.all.length}`);
check("registers through slots.inject for both slots", injected.includes("settings.section") && injected.includes("plugins.row.config"), JSON.stringify([...new Set(injected)]));

// A `no such file under …` answer raises exactly one question — which
// directories were tried — so the page answers it without DevTools.
{
  const { section } = applyWith(makeService({ [ROW]: makeSharedForm(base) }));
  const tree = renderNode(section.component({}));
  const texts = [];
  const walk = (node) => {
    if (typeof node === "string") texts.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object" && node.children) node.children.forEach(walk);
  };
  walk(tree);
  check(
    "the settings page lists the live relative-path search roots",
    texts.some((text) => text.includes("相对路径搜索目录") && text.includes("/home/shuaige/code/dsh workspace")),
    JSON.stringify(texts.filter((text) => text.includes("搜索目录"))),
  );
}

// ---- settings page without the service still renders (status only)
let tree = render(React.createElement(regs.section.component, {}));
check("settings page renders without the forms service", JSON.stringify(tree).includes("DSH Web 桥接"));
check("settings page says the row is not served", JSON.stringify(tree).includes("没有向本客户端公开配置"));

// ---- settings page with the shared service: editable in place
const sharedCalls = [];
regs = applyWith(makeService({ [ROW]: makeSharedForm(base, { revision: 11 }, sharedCalls) }));
let settingsCase = mount(regs.section.component, {});
tree = settingsCase.tree();
check("settings page renders the shared form", find(tree, (node) => node.type === "input" && node.props.type === "number") !== undefined);
check("settings page lists all nine fields", ["端口", "上游地址", "root 目录", "注入点击脚本", "路径可点外观", "接管官方胶囊", "随 DSH 启动", "打开文件的命令", "打开方式"].every((name) => JSON.stringify(tree).includes(name)));
find(tree, (node) => node.type === "input" && node.props.type === "number").props.onChange({ target: { value: "41234" } });
tree = settingsCase.tree();
const settingsSave = find(tree, (node) => node.type === "button" && label(node) === "保存");
check("settings page save enables after an edit", settingsSave?.props.disabled === false);
settingsSave.props.onClick();
await tick();
check("settings page writes through the shared form", sharedCalls[0]?.ops?.[0]?.path?.[0] === "port" && sharedCalls[0]?.ops?.[0]?.value === 41234 && sharedCalls[0]?.revision === 11, JSON.stringify(sharedCalls[0]));

// ---- fallback: only the include:-prefixed entry id is served
const includeCalls = [];
regs = applyWith(makeService({ [ROW]: makeSharedForm(base, { status: "unavailable" }), [`include:${ROW}`]: makeSharedForm(base, { revision: 12 }, includeCalls) }));
settingsCase = mount(regs.section.component, {});
tree = settingsCase.tree();
check("falls back to the include: entry id", find(tree, (node) => node.type === "input" && node.props.type === "number") !== undefined);
find(tree, (node) => node.type === "input" && node.props.type === "number").props.onChange({ target: { value: "41235" } });
tree = settingsCase.tree();
find(tree, (node) => node.type === "button" && label(node) === "保存").props.onClick();
await tick();
check("fallback write uses the served revision", includeCalls[0]?.revision === 12 && includeCalls[0]?.ops?.[0]?.value === 41235, JSON.stringify(includeCalls[0]));

// ---- nothing ready: the diagnostic reports what the host actually serves
regs = applyWith(makeService({}, undefined, [{ ns: "llm-deepseek" }, { ns: "llm-commandcode" }]));
const diag = JSON.stringify(mount(regs.section.component, {}).tree());
check("diagnostic lists the served namespaces", diag.includes("llm-deepseek") && diag.includes("llm-commandcode"));
check(
  "diagnostic lists every candidate tried",
  ["dsh-web-bridge=", "include:dsh-web-bridge=", "@ni123niwjsj/dsh-web-bridge#dsh-web-bridge="].every((token) => diag.includes(token)),
);

// ---- row configuration page (host-provided form)
regs = applyWith(undefined);
const rowSummary = render(React.createElement(regs.rowConfig.component, { view: "summary" }));
check("row summary view renders the address", JSON.stringify(rowSummary).includes("39977"));
const rowLoading = render(React.createElement(regs.rowConfig.component, { view: "page" }));
// No form object means "this deployment serves no configuration here", not "still
// loading" — the loading text was previously shown forever and could never resolve.
check("row page without a host form says the row is not served", JSON.stringify(rowLoading).includes("没有向本客户端公开配置"));
const rowUnavailable = render(React.createElement(regs.rowConfig.component, { view: "page", form: makeRowForm(base, { status: "unavailable", writable: false }) }));
check("row page with an unavailable namespace explains itself", JSON.stringify(rowUnavailable).includes("没有向本客户端公开配置"));

const rowCalls = [];
const rowCase = mount(regs.rowConfig.component, { view: "page", form: makeRowForm(base, {}, rowCalls) });
tree = rowCase.tree();
check("row page renders all nine fields", ["端口", "上游地址", "root 目录", "注入点击脚本", "路径可点外观", "接管官方胶囊", "随 DSH 启动", "打开文件的命令", "打开方式"].every((name) => JSON.stringify(tree).includes(name)));
check("row save is disabled while clean", find(tree, (node) => node.type === "button" && label(node) === "保存")?.props.disabled === true);
find(tree, (node) => node.type === "input" && node.props.type === "number").props.onChange({ target: { value: "40001" } });
tree = rowCase.tree();
find(tree, (node) => node.type === "button" && label(node) === "保存").props.onClick();
await tick();
check("row page emits exactly one set op for the port", rowCalls.length === 1 && rowCalls[0].ops.length === 1 && rowCalls[0].ops[0].value === 40001, JSON.stringify(rowCalls[0]));
check("row page fences the write with the read revision", rowCalls[0]?.revision === 7);

// ---- validation, read-only, restore, list editing, refusal
const invalidCase = mount(regs.rowConfig.component, { view: "page", form: makeRowForm(base, {}, rowCalls) });
find(invalidCase.tree(), (node) => node.type === "input" && node.props.type === "number").props.onChange({ target: { value: "70000" } });
const invalidTree = invalidCase.tree();
check("invalid port shows an error", JSON.stringify(invalidTree).includes("1–65535 的整数"));
check("invalid port disables save", find(invalidTree, (node) => node.type === "button" && label(node) === "保存")?.props.disabled === true);

const readOnlyTree = mount(regs.rowConfig.component, { view: "page", form: makeRowForm(base, { writable: false }) }).tree();
check("read-only namespace disables save", find(readOnlyTree, (node) => node.type === "button" && label(node) === "保存")?.props.disabled === true);

const restoreCalls = [];
const overriddenTree = mount(regs.rowConfig.component, { view: "page", form: makeRowForm({ ...base, openCommand: "codium" }, { user: { openCommand: "codium" } }, restoreCalls) }).tree();
const restore = find(overriddenTree, (node) => node.type === "button" && label(node) === "恢复默认");
check("overridden field offers restore", restore !== undefined);
restore.props.onClick();
await tick();
check("restore emits an unset op", restoreCalls[0]?.ops?.[0]?.op === "unset" && restoreCalls[0]?.ops?.[0]?.path?.[0] === "openCommand", JSON.stringify(restoreCalls[0]));

const rootsCalls = [];
const rootsCase = mount(regs.rowConfig.component, { view: "page", form: makeRowForm(base, {}, rootsCalls) });
find(rootsCase.tree(), (node) => node.type === "input" && node.props.placeholder === "/absolute/path")
  .props.onChange({ target: { value: "/home/shuaige/code/dsh workspace" } });
find(rootsCase.tree(), (node) => node.type === "button" && label(node) === "添加").props.onClick();
find(rootsCase.tree(), (node) => node.type === "button" && label(node) === "保存").props.onClick();
await tick();
check("adding a root emits a roots set op", rootsCalls[0]?.ops?.[0]?.path?.[0] === "roots" && rootsCalls[0]?.ops?.[0]?.value?.[0] === "/home/shuaige/code/dsh workspace", JSON.stringify(rootsCalls[0]));

const refusedCase = mount(regs.rowConfig.component, { view: "page", form: makeRowForm(base, { accept: false }) });
find(refusedCase.tree(), (node) => node.type === "input" && node.props.type === "number").props.onChange({ target: { value: "39001" } });
find(refusedCase.tree(), (node) => node.type === "button" && label(node) === "保存").props.onClick();
await tick();
check("host refusal is surfaced", JSON.stringify(refusedCase.tree()).includes("拒绝了"));

// ---- the control that broke: a translucent <select> made the browser paint its popup
//      white while the text stayed light, so the options were unreadable. Pin the fix.
{
  const { section } = applyWith(makeService({ [ROW]: makeSharedForm(base) }));
  const tree = renderNode(section.component({}));
  const selects = [];
  const options = [];
  const collect = (node) => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (node === null || typeof node !== "object") return;
    if (node.type === "select") selects.push(node);
    if (node.type === "option") options.push(node);
    (node.children ?? []).forEach(collect);
  };
  collect(tree);
  // Three dropdowns: launch mode, chip takeover, and the diff modifier (batch 4 / B6).
  check("the form renders its dropdowns as <select>", selects.length === 3, String(selects.length));
  check(
    "a select is given an OPAQUE themed background, not a translucent one",
    selects.every((node) => /var\(--dsw-alias-bg-layer-\d/u.test(String(node.props.style?.background ?? ""))),
    JSON.stringify(selects.map((node) => node.props.style?.background)),
  );
  check(
    "every option carries its own background and colour",
    options.length > 0 && options.every((node) => String(node.props.style?.backgroundColor ?? "") !== "" && String(node.props.style?.color ?? "") !== ""),
    `${options.length} option(s)`,
  );
  check(
    "...using theme tokens that exist in this Harness build",
    [...selects, ...options].every((node) =>
      Object.values(node.props.style ?? {}).every((value) => !String(value).includes("--dsw-font-mono") && !String(value).includes("fill-tsp-secondary") && !String(value).includes("border-secondary")),
    ),
  );
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(failed === 0 ? `\n全部通过（${results.length} 项）` : `\n失败 ${failed}/${results.length} 项`);
process.exit(failed === 0 ? 0 : 1);
