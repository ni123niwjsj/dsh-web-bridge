// Shared support for the verify-*.mjs suites.
//
// The suites must assert against the Harness's OWN behaviour — its schemastery
// and the settings gate that decides whether this row has a namespace at all —
// rather than against a hand copy that can drift. This module finds the
// `@deepseek-ai` scope of the Harness install running on this machine.
//
//   node verify-support.mjs        # self-check: reports what was found
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Directories that could hold the `@deepseek-ai` scope, nearest first. */
const scopeCandidates = () => {
  const found = [];
  let dir = import.meta.dirname;
  for (;;) {
    found.push(join(dir, "node_modules", "@deepseek-ai"));
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (typeof process.env.DSH_CLI === "string" && process.env.DSH_CLI !== "") {
    found.push(join(dirname(process.env.DSH_CLI), "..", "@deepseek-ai"));
  }
  const cache = join(homedir(), ".npm", "_npx");
  if (existsSync(cache)) {
    for (const entry of readdirSync(cache)) found.push(join(cache, entry, "node_modules", "@deepseek-ai"));
  }
  return found;
};

/**
 * Resolve one Harness package to a file URL.
 * @param name - package name inside the `@deepseek-ai` scope, e.g. `schemastery`.
 * @returns the module URL, or undefined when this machine has no Harness install.
 */
/**
 * The check accumulator every suite used to carry its own copy of.
 *
 * Six copies had drifted in formatting, and one of them silently dropped skipped checks.
 * One implementation means one summary shape, one exit-code rule, and no suite that
 * "passes" while printing nothing.
 * @returns `{ results, check, failed, summary }`; `summary()` also returns the failure count.
 */
export const createChecks = () => {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push([name, Boolean(ok)]);
    console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? `  ${detail}` : ""}`);
  };
  const failed = () => results.filter(([, ok]) => !ok).length;
  const summary = () => {
    const bad = failed();
    console.log(bad === 0 ? `\n全部通过（${results.length} 项）` : `\n失败 ${bad}/${results.length} 项`);
    return bad;
  };
  return { results, check, failed, summary };
};

/** A port that was free a moment ago: bind :0, read it back, release it. */
export const freePort = () =>
  new Promise((settle, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => settle(typeof address === "object" && address !== null ? address.port : 0));
    });
  });

export const locateHarness = (name) => {
  for (const scope of scopeCandidates()) {
    const dir = join(scope, name);
    if (!existsSync(join(dir, "package.json"))) continue;
    try {
      return pathToFileURL(createRequire(join(dir, "package.json")).resolve(`@deepseek-ai/${name}`)).href;
    } catch {
      /* not resolvable from this scope; try the next one */
    }
  }
  return undefined;
};

/** Import one Harness package, or undefined when it is not installed. */
export const loadHarness = async (name) => {
  const url = locateHarness(name);
  return url === undefined ? undefined : import(url);
};

/**
 * The settings projection itself, lifted out of the shipped `dsh-settings`
 * bundle rather than re-implemented, so these suites cannot drift from what the
 * Harness actually runs.
 *
 * The extracted block is the shipped source verbatim: `isRecord` → `walk` →
 * `redactSecrets` → `plainConfig` → `plainSchema` → `volatileForm`. Two values
 * it closes over are supplied here: the real `z`, and an `isVolatile` duck-typed
 * on the frozen `{ get() }` shape `createVolatile` produces (cosmokit's own test
 * uses a private symbol that is not exported to a plugin).
 * @returns `{ plainConfig, plainSchema, volatileForm }`, or undefined when unavailable.
 */
export const loadSettingsProjection = async () => {
  const url = locateHarness("dsh-settings");
  if (url === undefined) return undefined;
  const source = await readFileSync(fileURLToPath(url), "utf8");
  const start = source.indexOf("function isRecord(");
  const gate = source.indexOf("function volatileForm(");
  const end = gate < 0 ? -1 : source.indexOf("\n}\n", gate);
  if (start < 0 || end < 0) return undefined;
  const z = (await loadHarness("schemastery"))?.default;
  if (z === undefined) return undefined;
  const isVolatile = (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value) && Object.isFrozen(value) && typeof value.get === "function";
  const body = source.slice(start, end + 3);
  return new Function("z", "isVolatile", `${body}; return { plainConfig, plainSchema, volatileForm };`)(z, isVolatile);
};

/** The gate alone, for suites that only ask whether a row has a form at all. */
export const loadVolatileForm = async () => (await loadSettingsProjection())?.volatileForm;

if (import.meta.filename === process.argv[1]) {
  for (const name of ["schemastery", "dsh-settings"]) {
    console.log(`${name}: ${locateHarness(name) ?? "(not found on this machine)"}`);
  }
  console.log(`projection: ${(await loadSettingsProjection()) ? "extracted from the shipped bundle" : "(unavailable)"}`);
}
