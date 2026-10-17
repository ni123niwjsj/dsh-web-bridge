// Unit test for the host half's `apply`: the settings-namespace declaration, the
// configurable field set, and the status injection, including the paths that must
// never take the plugin down. Runs without a Harness, a profile, or a live DSH
// server; the schema and gate checks use the Harness's own packages when this
// machine has them (see verify-support.mjs).
//
//   node verify-host-apply.mjs
import { apply, buildConfig, deriveToken, isVolatileRef, liveRoots, readRowSettings } from "./lib/index.js";
import { loadHarness, loadSettingsProjection } from "./verify-support.mjs";
import { readFileSync } from "node:fs";

const results = [];
const check = (name, ok, detail = "") => {
  results.push([name, ok]);
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? `  ${detail}` : ""}`);
};
/**
 * Record a check that could not run.
 *
 * Skipping used to be invisible: the run still said "全部通过" and exited 0, while the
 * skipped check was the one this suite exists for ("every Config field is marked
 * volatile" — without the mark, `dsh-settings` projects no namespace and the whole
 * settings page is empty). A skip is now counted, reported, and fatal unless
 * `ALLOW_SKIP=1` says the caller knows the Harness is absent.
 */
const skipped = [];
const skip = (name) => {
  skipped.push(name);
  console.log(`  ⏭  ${name} (not available on this machine)`);
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/**
 * Fake host context. `inject(['settings'], cb)` runs `cb` with a child context
 * that carries the service plus its own `effect`, which is how the documented
 * pattern scopes the page policy to this plugin's fiber.
 */
const makeCtx = ({ settings, withInject = true, systemPromptThrows = false } = {}) => {
  const taps = [];
  const warnings = [];
  const disposers = [];
  const childDisposers = [];
  const listeners = new Map();
  const fiber = { id: "dsh-web-bridge-fiber" };
  const calls = { configure: [], effects: 0, childEffects: 0, injectedServices: [] };
  const promptSections = [];
  const promptWarnings = [];
  const childCtx = {
    settings,
    systemPrompt: {
      getSectionOrder: (name) => (name === "FILE_REFERENCE" ? 900 : 0),
      section: (options) => {
        if (systemPromptThrows) throw new Error("section registry is closed");
        promptSections.push(options);
        return () => {};
      },
    },
    effect: (run) => {
      calls.childEffects += 1;
      const dispose = run();
      if (typeof dispose === "function") childDisposers.push(dispose);
      return dispose;
    },
  };
  const ctx = {
    fiber,
    get: (name) => (name === "settings" ? settings : undefined),
    effect: (run) => {
      calls.effects += 1;
      const dispose = run();
      if (typeof dispose === "function") disposers.push(dispose);
      return dispose;
    },
    on: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return () => {};
    },
    webServer: {
      tapIndex: (transform) => {
        taps.push(transform);
        return () => {};
      },
    },
    logger: { info() {}, warn: (message) => warnings.push(String(message)), debug() {} },
  };
  if (withInject) {
    ctx.inject = (services, run) => {
      calls.injectedServices.push(...services);
      run(childCtx);
    };
  }
  const emit = (event, ...args) => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };
  return { ctx, taps, warnings, disposers, childDisposers, calls, fiber, listeners, emit, promptSections, promptWarnings };
};

const settingsStub = (namespaces = ["llm-deepseek", "llm-commandcode"]) => ({
  configure: function configure(presentation) {
    // eslint-disable-next-line no-invalid-this
    return () => {};
  },
  describe: () => namespaces.map((ns) => ({ ns })),
});

const readSnapshot = (transform) => {
  const html = transform("<html><head><title>t</title></head><body></body></html>");
  const at = html.indexOf("window.__DSH_WEB_BRIDGE__=");
  if (at < 0) return undefined;
  const raw = html.slice(at + "window.__DSH_WEB_BRIDGE__=".length).split(";</script>")[0];
  return JSON.parse(raw);
};

// ---- happy path: declare the namespace, do not start the bridge, inject status
{
  const configureCalls = [];
  const settings = {
    configure: (presentation, owner) => {
      configureCalls.push({ presentation, owner });
      return () => {};
    },
    describe: () => [{ ns: "dsh-web-bridge" }, { ns: "llm-deepseek" }],
  };
  const { ctx, taps, calls, fiber, listeners } = makeCtx({ settings });
  apply(ctx, { port: 39977, upstream: "127.0.0.1:3080", autoStart: false });
  check("apply registers three parent effects (live settings, lifecycle, tap)", calls.effects === 3, `effects=${calls.effects}`);
  check("subscribes to loader/volatile-update on this fiber", listeners.has("loader/volatile-update"), JSON.stringify([...listeners.keys()]));
  check(
    "declares the policy inside the settings child context, and the prompt in its own",
    calls.injectedServices.includes("settings") && calls.injectedServices.includes("systemPrompt") && calls.childEffects === 2,
    JSON.stringify({ services: calls.injectedServices, childEffects: calls.childEffects }),
  );
  check("owns its own page, so auto form generation is off", configureCalls.length === 1 && configureCalls[0].presentation.auto === false, JSON.stringify(configureCalls[0]?.presentation));
  check("passes this plugin's fiber as the policy owner", configureCalls[0]?.owner === fiber, JSON.stringify(configureCalls[0]?.owner));
  check("injects exactly one index tap", taps.length === 1, `taps=${taps.length}`);
  const snapshot = readSnapshot(taps[0]);
  check("snapshot reports the stopped bridge when autoStart is false", snapshot?.state === "stopped", JSON.stringify(snapshot?.state));
  check("snapshot carries the host namespaces", JSON.stringify(snapshot?.namespaces) === JSON.stringify(["dsh-web-bridge", "llm-deepseek"]), JSON.stringify(snapshot?.namespaces));
  check("snapshot keeps the configured port", snapshot?.port === 39977 && String(snapshot?.url).includes("39977"), JSON.stringify([snapshot?.port, snapshot?.url]));
}

// ---- no settings service: still applies, no namespace reported
{
  const { ctx, taps, calls } = makeCtx({ settings: undefined, withInject: false });
  let threw;
  try {
    apply(ctx, { autoStart: false });
  } catch (error) {
    threw = error;
  }
  check("apply survives a context without ctx.inject at all", threw === undefined, String(threw));
  check("still registers the three independent effects", calls.effects === 3, `effects=${calls.effects}`);
  check("does not touch a missing settings service", calls.configure.length === 0);
  const snapshot = readSnapshot(taps[0]);
  check("snapshot reports no namespaces", snapshot?.namespaces === undefined, JSON.stringify(snapshot?.namespaces));
}

// ---- configure throws: warn, keep going, bridge must not be taken down
{
  const settings = {
    configure: () => {
      throw new Error("a policy already exists for this instance");
    },
    describe: () => {
      throw new Error("mirror unavailable");
    },
  };
  const { ctx, taps, warnings, calls } = makeCtx({ settings });
  let threw;
  try {
    apply(ctx, { autoStart: false });
  } catch (error) {
    threw = error;
  }
  check("apply survives a throwing configure()", threw === undefined, String(threw));
  check("the failure is logged, not swallowed silently", warnings.some((line) => line.includes("settings page policy not registered")), JSON.stringify(warnings));
  check("the status tap still works", calls.effects === 3 && readSnapshot(taps[0]) !== undefined);
}

// ---- configure returns no disposer: cleanup must still be safe
{
  const disposers = [];
  const settings = { configure: () => undefined, describe: () => [] };
  const { ctx, disposers: parentDisposers, childDisposers } = makeCtx({ settings });
  apply(ctx, { autoStart: false });
  for (const dispose of [...parentDisposers, ...childDisposers]) {
    try {
      dispose();
    } catch (error) {
      disposers.push(String(error));
    }
  }
  check("cleanup tolerates a missing disposer", disposers.length === 0, JSON.stringify(disposers));
}

// ---- the anchor guidance: the one form DSH's own file-reference prompt cannot teach
{
  const { ctx, promptSections } = makeCtx({ settings: settingsStub() });
  apply(ctx, { autoStart: false });
  const section = promptSections[0];
  check("registers exactly one prompt section", promptSections.length === 1, JSON.stringify(promptSections.map((entry) => entry.name)));
  check("...named and ordered right after DSH's own file-reference section", section?.name === "dsh-web-bridge:file-anchors" && section?.order === 901, JSON.stringify({ name: section?.name, order: section?.order }));
  check(
    "...teaching the anchor, the #L form, and the do-not-invent rule",
    section?.text.includes("path#<text>") && section?.text.includes("#L24") && section.text.includes("never invent a line number") && section.text.includes("inline code rather than a Markdown link"),
    JSON.stringify(section?.text?.slice(0, 80)),
  );
}

// The guidance changes model behaviour in every session, so its switch has to be real:
// with `anchorPrompt: false` nothing may be registered at all.
{
  const { ctx, promptSections } = makeCtx({ settings: settingsStub() });
  apply(ctx, { autoStart: false, anchorPrompt: false });
  check(
    "anchorPrompt: false registers NO guidance section",
    promptSections.length === 0,
    JSON.stringify(promptSections.map((entry) => entry.name)),
  );
}

{
  const { ctx, warnings, promptSections } = makeCtx({ settings: settingsStub(), systemPromptThrows: true });
  let threw;
  try {
    apply(ctx, { autoStart: false });
  } catch (error) {
    threw = error;
  }
  check("a refusing prompt registry is a warning, not a crash", threw === undefined && promptSections.length === 0 && warnings.some((line) => line.includes("file-anchor guidance not registered")), JSON.stringify(warnings));
}

// ---- the settings-page gate. `describe()` drops any entry whose schema has no
//      `.volatile()` field, so such a row has NO namespace and no page anywhere
//      can offer a form for it, whatever else is configured.
{
  const z = (await loadHarness("schemastery"))?.default;
  if (z === undefined) skip("schema and settings-gate checks");
  else {
    const fields = ["port", "upstream", "roots", "injectClickScript", "decorate", "hijackChip", "autoStart", "openCommand", "launchMode"];
    const Config = buildConfig(z);
    const unmarked = fields.filter((name) => Config.dict?.[name]?.meta?.volatile !== true);
    check("every Config field carries .volatile()", unmarked.length === 0, `unmarked: ${JSON.stringify(unmarked)}`);

    const projection = await loadSettingsProjection();
    if (projection === undefined) skip("shipped volatileForm() gate");
    else {
      const form = projection.volatileForm(Config);
      check(
        "the shipped dsh-settings volatileForm() yields a form for this row",
        form !== undefined && fields.every((name) => name in (form.dict ?? {})),
        JSON.stringify({ form: form !== undefined, keys: Object.keys(form?.dict ?? {}) }),
      );
      check(
        "...and an unmarked field set yields none (the defect this guards)",
        projection.volatileForm(z.object({ port: z.natural(), upstream: z.string() })) === undefined,
      );

      // The whole host → client payload: what `describe()` puts on the wire is
      // `form.toJSON()` plus `plainConfig(fiber.config)`, and the client decodes
      // it with `rehydrate(schema)` then `schema(value)`. A failure there leaves
      // the page stuck at "loading", which looks nothing like the defect above.
      const samples = {
        "profile sets port and roots": { port: 40001, roots: ["/tmp"], upstream: "127.0.0.1:3080" },
        "untouched row (defaults only)": {},
        "every field overridden": { port: 41000, upstream: "127.0.0.1:9999", roots: ["/a", "/b"], injectClickScript: false, autoStart: false, openCommand: "codium", launchMode: "portal" },
      };
      const failures = [];
      for (const [label, raw] of Object.entries(samples)) {
        const schema = projection.volatileForm(Config)?.toJSON();
        const value = projection.plainConfig(Config(raw));
        try {
          z(schema)(value);
        } catch (error) {
          failures.push(`${label}: ${error.message}`);
        }
      }
      check("the host→client payload decodes for every shape of config", failures.length === 0, JSON.stringify(failures));
    }
  }
}

// ---- reading settings through the live references the mark produces
{
  const ref = (value) => Object.freeze({ get: () => value });
  const read = readRowSettings({
    port: ref(41234),
    upstream: ref("127.0.0.1:9"),
    roots: ref(["/tmp"]),
    injectClickScript: ref(false),
    autoStart: ref(false),
    openCommand: ref("codium"),
    launchMode: ref("portal"),
  });
  check(
    "readRowSettings reads every marked field through get()",
    read.port === 41234 && read.upstream === "127.0.0.1:9" && read.roots[0] === "/tmp" && read.injectClickScript === false && read.autoStart === false && read.openCommand === "codium" && read.launchMode === "portal",
    JSON.stringify(read),
  );
  const plain = readRowSettings({ port: 5000, autoStart: true });
  check(
    "plain values pass through and missing fields take schema defaults",
    plain.port === 5000 && plain.upstream === "127.0.0.1:3080" && plain.roots.length === 0 && plain.autoStart === true && readRowSettings({}).port === 39977 && readRowSettings({}).hijackChip === "off" && readRowSettings({}).decorate === true,
    JSON.stringify(plain),
  );
  check(
    "only a FROZEN { get() } counts as a reference",
    isVolatileRef(ref(1)) === true && isVolatileRef({ get: () => 1 }) === false && isVolatileRef([1]) === false && isVolatileRef(null) === false,
  );
}

// ---- a live write arrives as an event, not as a second apply()
{
  const ref = (value) => Object.freeze({ get: () => value });
  const { ctx, taps, emit } = makeCtx({ settings: settingsStub() });
  apply(ctx, { port: ref(39977), upstream: ref("127.0.0.1:3080"), autoStart: ref(false) });
  const before = readSnapshot(taps[0]);
  check("volatile references reach the status snapshot unwrapped", before?.port === 39977 && before?.autoStart === false, JSON.stringify([before?.port, before?.autoStart]));
  emit("loader/volatile-update", [["port"], ["roots"]]);
  await settle();
  const after = readSnapshot(taps[0]);
  check(
    "loader/volatile-update is recorded and adopts without starting a disabled bridge",
    after?.state === "stopped" && after?.lastEvents?.[0]?.kind === "config" && after.lastEvents[0].paths.join("+") === "port+roots",
    JSON.stringify(after?.lastEvents),
  );
}

// ---- a relative path is resolved against the live session working directories,
//      because the page shows paths the way the session wrote them
{
  const sessions = {
    list: () => [
      { header: { cwd: "/home/shuaige/code/dsh workspace" } },
      { header: { cwd: "relative/ignored" } },
      { header: {} },
      {},
    ],
  };
  const withSessions = { get: (name) => (name === "sessions" ? sessions : undefined) };
  check(
    "liveRoots appends every live session working directory",
    JSON.stringify(liveRoots(withSessions, ["/configured"])) === JSON.stringify(["/configured", "/home/shuaige/code/dsh workspace"]),
    JSON.stringify(liveRoots(withSessions, ["/configured"])),
  );
  const throwing = {
    get: () => {
      throw new Error("sessions unavailable");
    },
  };
  check(
    "liveRoots degrades to the configured roots, never throws",
    JSON.stringify(liveRoots({ get: () => undefined }, ["/c"])) === JSON.stringify(["/c"]) &&
      JSON.stringify(liveRoots(throwing, ["/c"])) === JSON.stringify(["/c"]) &&
      liveRoots(undefined).length === 0,
  );
  const { ctx, taps } = makeCtx({ settings: settingsStub() });
  ctx.get = (name) => (name === "sessions" ? sessions : undefined);
  apply(ctx, { autoStart: false, roots: ["/configured"] });
  const snapshot = readSnapshot(taps[0]);
  check(
    "the status snapshot separates configured roots from the live search list",
    JSON.stringify(snapshot?.roots) === JSON.stringify(["/configured"]) &&
      JSON.stringify(snapshot?.searchRoots) === JSON.stringify(["/configured", "/home/shuaige/code/dsh workspace"]),
    JSON.stringify({ roots: snapshot?.roots, searchRoots: snapshot?.searchRoots }),
  );
}

// ---- the page's request token is DERIVED, never random: it must outlive the
//      plugin instance, because a loaded page can only learn a new one by reload
{
  const home = Buffer.alloc(32, 7);
  const other = Buffer.alloc(32, 9);
  const first = deriveToken(home);
  check("deriveToken is deterministic for one Harness home", first === deriveToken(home) && /^[0-9a-f]{24}$/u.test(first), first);
  check("...and differs for a different signing secret", deriveToken(other) !== first, deriveToken(other));
}

const failed = results.filter(([, ok]) => !ok).length;
// ---- the bundle patch has to stay parseable -------------------------------------
// A single mis-indented line here made YAML parsing fail, which made the whole bundle
// fail to load: the plugin vanished from Settings and its bridge never started. Nothing
// in the suite touched this file before, so it is checked structurally here (no YAML
// dependency, so it also runs in CI).
{
  const lines = readFileSync(new URL("./cordis.patch.yml", import.meta.url), "utf8").split("\n");
  const at = lines.findIndex((line) => /^\s*config:\s*$/u.test(line));
  const keys = [];
  let badIndent = [];
  if (at >= 0) {
    for (let i = at + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim() === "") continue;
      // Everything after `config:` in this file belongs to the config mapping, so ANY
      // other indent is a structural error — not "the block ended". Treating a 4-space
      // line as the end is exactly how the mis-indent slipped past the first version of
      // this guard.
      const indent = line.match(/^ */u)[0].length;
      if (indent !== 8) badIndent.push(`${i + 1}:${line}`);
      keys.push(line.trim().split(":")[0]);
    }
  }
  check("cordis.patch.yml has a config block", at > 0, String(at));
  check("every config entry is indented exactly 8 spaces", badIndent.length === 0, badIndent.join(" | "));
  const expected = ["port", "upstream", "roots", "injectClickScript", "decorate", "anchorPrompt", "diffModifier", "hijackChip", "autoStart", "openCommand", "launchMode"];
  check("...and ships a default for every field the schema declares", expected.every((key) => keys.includes(key)) && keys.length === expected.length, keys.join(","));
}

if (skipped.length > 0) {
  console.log(`\n跳过 ${skipped.length} 项（${skipped.join("；")}）`);
  if (process.env.ALLOW_SKIP !== "1") {
    console.log("  这不算通过：本套件的关键是「每个字段都带 .volatile()」。装好 Harness 再跑，或用 ALLOW_SKIP=1 明确接受跳过。");
    process.exit(2);
  }
}
console.log(failed === 0 ? `\n全部通过（${results.length} 项）` : `\n失败 ${failed}/${results.length} 项`);
process.exit(failed === 0 ? 0 : 1);
