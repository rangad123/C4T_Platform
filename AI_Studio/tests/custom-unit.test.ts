/**
 * Hand-written (custom) scripts, browser-free: the static guard as a table (every rule and the ways around it), helper resolution and
 * path safety, the run-policy decision table, the runner's own refusal, script versions, helper usage, the Git repository store, and the
 * parts of take-over and the gate that need only a database. Nothing here starts a browser or runs a script.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { checkScript, ENV_ALLOWED, GUARD_RULES, guardAvailable, MAX_HELPER_BYTES, MAX_SCRIPT_BYTES } from "../src/engine/custom/guard.js";
import { helperClosure, helperPath, isHelperName, MAX_HELPERS } from "../src/engine/custom/helpers.js";
import { renderWithAdapter } from "../src/engine/frameworks/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { CLEANUP_HELPER_SOURCE } from "../src/engine/cleanup/helper.js";
import { CONTRACT_HELPER_SOURCE } from "../src/engine/contracts/check.js";
import { DRIFT_HELPER_SOURCE } from "../src/engine/contracts/drift.js";
import { EVIDENCE_HELPER_SOURCE } from "../src/engine/evidence/capture.js";
import { HEALTH_HELPER_SOURCE } from "../src/engine/health/checks.js";
import { ACCESS_API_HELPER_SOURCE, ACCESS_HELPER_SOURCE } from "../src/engine/identity/access.js";
import { TOTP_HELPER_SOURCE } from "../src/engine/identity/totp.js";
import { INPUT_HELPER_SOURCE } from "../src/engine/inputs/checks.js";
import { PERF_HELPER_SOURCE } from "../src/engine/performance/checks.js";
import { LATENCY_HELPER_SOURCE } from "../src/engine/performance/latency.js";
import { LOAD_CALL_SOURCE, LOAD_HELPER_SOURCE } from "../src/engine/performance/load.js";
import { SECURITY_HELPER_SOURCE } from "../src/engine/security/checks.js";
import { VISION_HELPER_SOURCE } from "../src/engine/vision/capture.js";
import { customRefusals } from "../src/engine/validation/runner.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { customRunDecision, CUSTOM_REFUSAL, splitCustom } from "../src/platform/custom-policy.js";
import { CustomScripts } from "../src/platform/custom-scripts.js";
import { CustomScriptStore, GitRepoStore, KEEP_VERSIONS } from "../src/platform/custom-script-store.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { addTest, seedProject, type Seed } from "./fixtures/dashboard-seed.js";

const rules = (code: string, kind: "test" | "helper" = "test") => checkScript(code, { kind }).diagnostics.filter((d) => d.severity === "error").map((d) => d.rule);
const warnings = (code: string) => checkScript(code).diagnostics.filter((d) => d.severity === "warning").map((d) => d.rule);

const HEAD = `import { test, expect } from "@playwright/test";\n`;
const body = (inner: string) => `${HEAD}test("x", async ({ page }) => {\n${inner}\n});\n`;

describe("guard: code the platform itself generates is accepted", () => {
    it("accepts rendered web and API scripts", () => {
        const web = TestSpecSchema.parse({
            testId: "WEB-001",
            title: "Sign in works",
            kind: "web",
            steps: [{ action: "navigate", url: "/" }, { action: "fill", locator: { by: "label", value: "Email" }, value: "a@b.c" }, { action: "click", locator: { by: "role", role: "button", value: "Go" } }, { action: "assert", check: "visible", locator: { by: "text", value: "Hi" } }],
        });
        const api = TestSpecSchema.parse({ testId: "API-001", title: "List answers", kind: "api", steps: [{ action: "request", method: "GET", path: "/api/x" }, { action: "assertResponse", check: "status", expected: 200 }] });
        for (const [spec, fw] of [[web, "playwright"], [api, "playwright-api"]] as const) {
            const script = renderWithAdapter(spec, fw, { baseUrl: "http://127.0.0.1:1" });
            const r = checkScript(script.content);
            expect(r.diagnostics.filter((d) => d.severity === "error"), script.filename).toEqual([]);
            expect(r.ok).toBe(true);
        }
    });
});

describe("guard: every helper the generators paste into scripts passes (so any generated test can be taken over)", () => {
    const sources: Record<string, string> = { CLEANUP_HELPER_SOURCE, CONTRACT_HELPER_SOURCE, DRIFT_HELPER_SOURCE, EVIDENCE_HELPER_SOURCE, HEALTH_HELPER_SOURCE, ACCESS_HELPER_SOURCE, ACCESS_API_HELPER_SOURCE, TOTP_HELPER_SOURCE, INPUT_HELPER_SOURCE, PERF_HELPER_SOURCE, LATENCY_HELPER_SOURCE, LOAD_HELPER_SOURCE, LOAD_CALL_SOURCE, SECURITY_HELPER_SOURCE, VISION_HELPER_SOURCE };
    it.each(Object.entries(sources))("%s", (_name, source) => {
        const errors = checkScript(`${HEAD}${source}
`).diagnostics.filter((d) => d.severity === "error");
        expect(errors.map((d) => `${d.line}:${d.column} ${d.rule} ${d.message}`)).toEqual([]);
    });
});

describe("guard: ordinary hand-written code is accepted", () => {
    const ok: Array<[string, string]> = [
        ["a plain test", body(`await page.goto("/");\nawait expect(page).toHaveTitle(/x/);`)],
        ["reading the allowed environment names", body(`const a = process.env.BASE_URL, b = process.env["TEST_USERNAME"], c = process.env.API_TOKEN, d = process.env.TEST_ADMIN_PASSWORD;\nvoid [a, b, c, d];`)],
        ["destructuring allowed names", body(`const { BASE_URL, TEST_PASSWORD } = process.env;\nvoid [BASE_URL, TEST_PASSWORD];`)],
        ["the axe import", `import AxeBuilder from "@axe-core/playwright";\nimport { test } from "@playwright/test";\ntest("a", async ({ page }) => { await new AxeBuilder({ page }).analyze(); });`],
        ["a helper import", `import { login } from "./helpers/login-steps";\nimport { test } from "@playwright/test";\ntest("a", async ({ page }) => { await login(page); });`],
        ["a cookie path of / (not a file)", body(`await page.context().addCookies([{ name: "a", value: "b", domain: "x.test", path: "/" }]);`)],
        ["a screenshot saved by a plain relative name", body(`await page.screenshot({ path: "shot.png" });`)],
        ["words that only look like forbidden ones", body(`const modules = ["require", "eval"]; const functionName = "constructor"; const globalValue = 1; // import fs from "fs"\nvoid [modules, functionName, globalValue];`)],
        ["a string that mentions require(", body(`await test.step("calls require(\\"fs\\") in words only", async () => {});`)],
        ["type annotations that name Function", body(`const f: Function = () => 1; void f;`)],
        ["a loop that waits", body(`while (true) { await page.waitForTimeout(10); if (Math.random() > 2) break; }`)],
    ];
    it.each(ok)("%s", (_name, code) => {
        const r = checkScript(code);
        expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    });
});

describe("guard: refused code, one rule at a time", () => {
    // [name, code, the rule that must fire]
    const refused: Array<[string, string, string]> = [
        ["a node module import", `import fs from "fs";\n${body("")}`, "import"],
        ["child_process with the node: prefix", `import { exec } from "node:child_process";\n${body("")}`, "import"],
        ["fs/promises", `import { readFile } from "fs/promises";\n${body("")}`, "import"],
        ["a type-only import of a node module", `import type { Server } from "http";\n${body("")}`, "import"],
        ["a side-effect import", `import "net";\n${body("")}`, "import"],
        ["a package that is not allowed", `import { chromium } from "playwright";\n${body("")}`, "import"],
        ["a sub-path of an allowed package", `import x from "@playwright/test/lib/x";\n${body("")}`, "import"],
        ["a relative import outside helpers", `import { u } from "../lib/util";\n${body("")}`, "import"],
        ["an app alias import", `import { u } from "@app/util";\n${body("")}`, "import"],
        ["export * from a node module", `export * from "fs";\n${body("")}`, "import"],
        ["export { x } from a node module", `export { readFileSync } from "fs";\n${body("")}`, "import"],
        ["import x = require()", `import fs = require("fs");\n${body("")}`, "require"],
        ["a type import() of a node module", `type T = typeof import("fs");\n${body("")}`, "import"],
        ["require()", body(`const fs = require("fs");`), "require"],
        ["require built from a joined string", body(`require("chi" + "ld_process");`), "require"],
        ["require written with a unicode escape", body(`\\u0072equire("fs");`), "require"],
        ["require passed around", body(`const r = require; void r;`), "require"],
        ["dynamic import()", body(`await import("fs");`), "dynamic-import"],
        ["dynamic import() of a joined name", body(`await import("child_" + "process");`), "dynamic-import"],
        ["dynamic import() hidden after a comment", body(`/* nothing to see */ await import("fs");`), "dynamic-import"],
        ["globalThis with a joined key", body(`(globalThis["req" + "uire"] as any)("fs");`), "global"],
        ["globalThis with a template key", body("(globalThis[`req${\"uire\"}`] as any)(\"fs\");"), "global"],
        ["global", body(`(global as any).process.exit(1);`), "global"],
        ["module", body(`module.exports = {};`), "global"],
        ["eval", body(`eval("1+1");`), "eval"],
        ["eval reached by a unicode escape", body(`\\u0065val("1");`), "eval"],
        ["new Function", body(`new Function("return 1")();`), "function-constructor"],
        ["Function() without new", body(`Function("return process")();`), "function-constructor"],
        ["Function as a tagged template", body("Function`return 1`();"), "function-constructor"],
        ["the Function constructor through .constructor", body(`(async () => {}).constructor("return 1")();`), "forbidden-property"],
        ["the Function constructor through a joined key", body(`([] as any)["constr" + "uctor"]["constr" + "uctor"]("return 1")();`), "forbidden-property"],
        ["__proto__", body(`({} as any).__proto__.x = 1;`), "forbidden-property"],
        ["process.exit", body(`process.exit(1);`), "process"],
        ["process.kill", body(`process.kill(process.pid);`), "process"],
        ["process.mainModule", body(`(process as any).mainModule;`), "process"],
        ["process reached by element access", body(`process["env"]["BASE_URL"];`), "process"],
        ["a secret environment name", body(`const k = process.env.LLM_API_KEY; void k;`), "env"],
        ["a secret environment name by element access", body(`const k = process.env["SECRET_KEY"]; void k;`), "env"],
        ["an environment name computed at run time", body(`const n = "BASE_URL"; const k = process.env[n]; void k;`), "env"],
        ["the whole environment copied (outside the platform helper)", body(`const e = process.env; void e;`), "env"],
        ["the whole environment spread", body(`const e = { ...process.env }; void e;`), "env"],
        ["a destructured secret", body(`const { LLM_API_KEY } = process.env; void LLM_API_KEY;`), "env"],
        ["require declared away", `declare const require: any;\n${body(`require("fs");`)}`, "require"],
        ["an ambient module declaration", `declare module "fs" { export const x: number; }\n${body("")}`, "declare-module"],
        ["import.meta", body(`void import.meta.url;`), "import-meta"],
        ["an invalid helper name (upper case)", `import { a } from "./helpers/Login";\n${body("")}`, "import-helper"],
        ["a helper path that climbs", `import { a } from "./helpers/../secret";\n${body("")}`, "import"],
        ["a nested helper path", `import { a } from "./helpers/a/b";\n${body("")}`, "import"],
        ["a helper called like a Windows device", `import { a } from "./helpers/con";\n${body("")}`, "import-helper"],
        ["a helper with an extension", `import { a } from "./helpers/login.ts";\n${body("")}`, "import-helper"],
        ["a screenshot to an absolute path", body(`await page.screenshot({ path: "/tmp/x.png" });`), "path-escape"],
        ["a screenshot to a Windows drive", body(`await page.screenshot({ path: "C:\\\\x.png" });`), "path-escape"],
        ["a screenshot climbing out", body(`await page.screenshot({ path: "../../x.png" });`), "path-escape"],
        ["a download saved elsewhere", body(`const d: any = null; await d.saveAs("/etc/x");`), "path-escape"],
        ["a path joined from pieces", body(`await page.screenshot({ path: "/" + "tmp" + "/x.png" });`), "path-escape"],
        ["a browser started from another program", body(`const b: any = null; await b.launch({ executablePath: "C:\\\\bad.exe" });`), "launch-option"],
        ["a persistent browser profile", body(`const b: any = null; await b.launchPersistentContext("x");`), "launch"],
        ["controlling a desktop app through Playwright", `import { _electron } from "@playwright/test";\n${body("")}`, "import"],
        ["a syntax error", body(`const = ;`), "syntax"],
        ["a text-direction override in a comment", `${HEAD}// admin\u202E\n${body("")}`, "control-character"],
        ["a control character", `${HEAD}const a = 1;\u0000\n${body("")}`, "control-character"],
    ];
    it.each(refused)("%s", (_name, code, rule) => {
        expect(rules(code), checkScript(code).diagnostics.map((d) => `${d.line}:${d.column} ${d.rule} ${d.message}`).join("\n")).toContain(rule);
        expect(checkScript(code).ok).toBe(false);
    });

    it("a refusal names the line and the column", () => {
        const r = checkScript(`${HEAD}\nconst fs = require("fs");\n`).diagnostics.find((d) => d.rule === "require")!;
        expect(r.line).toBe(3);
        expect(r.column).toBeGreaterThan(10);
        expect(r.message).toMatch(/require/);
    });

    it("refuses a script and a helper that are too large, and says how large", () => {
        const big = `// ${"x".repeat(MAX_SCRIPT_BYTES)}\n`;
        const r = checkScript(big);
        expect(r.ok).toBe(false);
        expect(r.diagnostics[0]).toMatchObject({ rule: "size", severity: "error" });
        expect(checkScript(`// ${"x".repeat(MAX_HELPER_BYTES)}\n`, { kind: "helper" }).ok).toBe(false);
        expect(checkScript(`// ${"x".repeat(MAX_HELPER_BYTES / 2)}\n`, { kind: "helper" }).ok).toBe(true);
    });
});

describe("guard: warnings, helpers and what it cannot see", () => {
    it("warns about a loop that may never end and about building paths from __dirname, without refusing", () => {
        const loop = checkScript(body(`while (true) {}`));
        expect(loop.ok).toBe(true);
        expect(warnings(body(`while (true) {}`))).toContain("infinite-loop");
        expect(warnings(body(`for (;;) {}`))).toContain("infinite-loop");
        expect(warnings(body(`const p = __dirname + "/x"; void p;`))).toContain("path-building");
    });

    it("reads helper imports from the syntax tree, for a test and for a helper", () => {
        expect(checkScript(`import { a } from "./helpers/one";\nimport { b } from "./helpers/two-b";\nimport "@playwright/test";\n`).helperImports.sort()).toEqual(["one", "two-b"]);
        expect(checkScript(`import { a } from "./one";\n`, { kind: "helper" }).helperImports).toEqual(["one"]);
        // a test imports helpers by ./helpers/<name>; the bare form is not a helper import there
        expect(rules(`import { a } from "./one";\n`, "test")).toContain("import");
        // and a helper may not climb or use another folder
        expect(rules(`import { a } from "./helpers/one";\n`, "helper")).toContain("import");
    });

    it("lists the environment names a script may read", () => {
        for (const n of ["BASE_URL", "API_BASE_URL", "TEST_USERNAME", "TEST_ENV_REGION", "API_TOKEN", "API_AUTH_HEADER"]) expect(ENV_ALLOWED(n), n).toBe(true);
        for (const n of ["SECRET_KEY", "LLM_API_KEY", "PATH", "HOME", "NODE_OPTIONS", "AITP_URL", "test_username", "TESTING"]) expect(ENV_ALLOWED(n), n).toBe(false);
        expect(GUARD_RULES.join(" ")).toMatch(/not a security boundary/);
        expect(guardAvailable()).toBe(true);
    });

    it("documents what it cannot see: a property name that only exists at run time passes (the run policy is the boundary)", () => {
        // This is the honest limit stated in docs/features/custom-scripts.md. If the guard ever learns to catch it, change the doc and this test together.
        // (A name joined from constant pieces IS folded since round 13: see tests/guard-hardening.test.ts. One that is computed by a method call is not.)
        const sneaky = body(`const key = Array.from("rotcurtsnoc").reverse().join(""); const f = ([] as any)[key][key]; void f;`);
        expect(checkScript(sneaky).ok).toBe(true);
        expect(checkScript(body(`const key = ["constr", "uctor"].join(""); const f = ([] as any)[key][key]; void f;`)).ok).toBe(false);
    });
});

describe("helpers: closure, depth and path safety", () => {
    const code: Record<string, string> = {
        a: `import { b } from "./b";\nexport const a = 1;\n`,
        b: `import { c } from "./c";\nexport const b = 1;\n`,
        c: `import { d } from "./d";\nexport const c = 1;\n`,
        d: `export const d = 1;\n`,
        loop1: `import { x } from "./loop2";\nexport const y = 1;\n`,
        loop2: `import { y } from "./loop1";\nexport const x = 1;\n`,
    };
    const get = (n: string) => code[n];

    it("follows helper imports up to three levels and reports what is missing or too deep", () => {
        const r = helperClosure([`import { a } from "./helpers/a";\nimport { m } from "./helpers/gone";\n`], get);
        expect(r.helpers.map((h) => h.name)).toEqual(["a", "b", "c"]);
        expect(r.missing).toEqual(["gone"]);
        expect(r.tooDeep).toEqual(["d"]);
    });

    it("takes a helper once and survives a cycle", () => {
        const r = helperClosure([`import { y } from "./helpers/loop1";\n`, `import { y } from "./helpers/loop1";\n`], get);
        expect(r.helpers.map((h) => h.name).sort()).toEqual(["loop1", "loop2"]);
    });

    it("accepts only plain helper names", () => {
        for (const n of ["login", "login-steps", "a1", "x".repeat(41)]) expect(isHelperName(n), n).toBe(true);
        for (const n of ["", "A", "1a", "-a", "a_b", "a.b", "a/b", "a\\b", "../a", "..", ".", "a b", "x".repeat(42), "con", "nul", "com1", "lpt9", "aux", "prn", "é"]) expect(isHelperName(n), JSON.stringify(n)).toBe(false);
    });

    it("never writes a helper outside <run folder>/helpers", () => {
        const dir = path.join(os.tmpdir(), "aitp-run");
        expect(helperPath(dir, "login")).toBe(path.join(dir, "helpers", "login.ts"));
        for (const n of ["../x", "..\\x", "/etc/x", "C:\\x", "a/b", "A", "con", "login.ts", "%2e%2e", "login\u0000"]) expect(() => helperPath(dir, n), JSON.stringify(n)).toThrow();
    });
});

describe("run policy: the decision table", () => {
    const agent = (customScripts?: boolean) => ({ customScripts });
    // [host allows, runs on agent, agents, allowed?]
    const table: Array<[boolean, boolean, Array<{ customScripts?: boolean }>, boolean]> = [
        [false, false, [], false],
        [true, false, [], true],
        [true, false, [agent(true)], true],
        [false, false, [agent(true)], false], // an agent that agreed does not open the host: the project runs on the platform
        [true, true, [], false], // the project runs on an agent and none is connected: nothing runs, whatever the host allows
        [true, true, [agent(false)], false], // the host switch does not widen what an agent allows
        [true, true, [agent(undefined)], false],
        [false, true, [agent(false), agent(true)], true],
        [false, true, [agent(true)], true],
    ];
    it.each(table)("host %s, on an agent %s, agents %j", (hostAllowed, runsOnAgent, agents, allowed) => {
        const d = customRunDecision({ hostAllowed, runsOnAgent, agents });
        expect(d.allowed).toBe(allowed);
        if (!d.allowed) expect(d.message).toMatch(/--allow-custom-scripts|ALLOW_CUSTOM_SCRIPTS/);
    });

    it("names what to switch on, as the contract says", () => {
        expect(CUSTOM_REFUSAL).toBe("This project has code tests. Start your runner agent with --allow-custom-scripts, or set ALLOW_CUSTOM_SCRIPTS=true on the server.");
        const d = customRunDecision({ hostAllowed: false, runsOnAgent: true, agents: [] });
        expect(!d.allowed && d.message).toBe(CUSTOM_REFUSAL);
    });
});

describe("the runner refuses on its own", () => {
    const clean = { testId: "A", filename: "A.spec.ts", content: body(`await page.goto("/");`), custom: true };
    const dirty = { testId: "B", filename: "B.spec.ts", content: body(`require("fs");`), custom: true };
    const generated = { testId: "C", filename: "C.spec.ts", content: "this is not even checked" };

    it("refuses every hand-written script when the machine did not agree, and leaves the others alone", () => {
        const r = customRefusals([clean, generated, dirty], [], false);
        expect([...r.keys()]).toEqual([0, 2]);
        expect(r.get(0)).toMatch(/not allowed to run on this machine/);
    });
    it("checks each script and each helper again when the machine agreed", () => {
        expect([...customRefusals([clean, dirty, generated], [], true).keys()]).toEqual([1]);
        expect(customRefusals([clean], [{ name: "ok", content: "export const a = 1;\n" }], true).size).toBe(0);
        expect(customRefusals([clean], [{ name: "bad", content: `import fs from "fs";\n` }], true).get(0)).toMatch(/helper “bad”/);
    });
    it("does not even look at a batch without hand-written scripts", () => {
        expect(customRefusals([generated], [], false).size).toBe(0);
    });
});

describe("the database: versions, helpers, Git repositories, take-over", () => {
    let dataDir: string;
    let off: Platform;
    let on: Platform;
    let seed: Seed;
    let store: CustomScriptStore;

    beforeAll(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-custom-unit-"));
        off = bootstrap(loadConfig({ DATA_DIR: path.join(dataDir, "off"), SECRET_KEY: "test-secret-key-0123456789" }));
        on = bootstrap(loadConfig({ DATA_DIR: path.join(dataDir, "on"), SECRET_KEY: "test-secret-key-0123456789", ALLOW_CUSTOM_SCRIPTS: "true", API_KEY: "a-test-key" }));
        seed = seedProject(off, "Custom unit");
        store = new CustomScriptStore(off.db);
    });
    afterAll(() => {
        off?.db.close();
        on?.db.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    it("keeps versions, skips identical content and prunes the oldest but never the generated one", () => {
        const t = addTest(off, seed, "ver");
        store.mark(t, seed.projectId, { origin: "taken-over" });
        expect(store.addVersion(t, { content: "g", kind: "generated", force: true, version: 0 })).toEqual({ version: 0, created: true });
        expect(store.addVersion(t, { content: "g", kind: "taken-over", force: true, version: 1 })).toEqual({ version: 1, created: true });
        expect(store.addVersion(t, { content: "g", kind: "edited" })).toEqual({ version: 1, created: false });
        expect(store.addVersion(t, { content: "h", kind: "edited", note: "second", by: "me" })).toEqual({ version: 2, created: true });
        for (let i = 0; i < KEEP_VERSIONS + 20; i++) store.addVersion(t, { content: `edit ${i}`, kind: "edited" });
        const list = store.listVersions(t);
        expect(list.filter((v) => v.version > 0).length).toBe(KEEP_VERSIONS);
        expect(list.some((v) => v.version === 0 && v.kind === "generated")).toBe(true);
        expect(list[0]!.version).toBe(KEEP_VERSIONS + 22);
        expect(store.getVersion(t, 1)).toBeUndefined();
        expect(store.getVersion(t, 0)?.content).toBe("g");
        expect(list.find((v) => v.version === KEEP_VERSIONS + 22)).toMatchObject({ kind: "edited", bytes: 8 });
    });

    it("counts helper users through other helpers and refuses a 21st helper", () => {
        const p = seed.projectId;
        store.putHelper(p, "one", `import { b } from "./two";\n`, ["two"]);
        store.putHelper(p, "two", `export const b = 1;\n`, []);
        const t = addTest(off, seed, "uses");
        store.mark(t, p, { origin: "written", imports: ["one"] });
        expect(store.usersOfHelper(p, "one")).toEqual([t]);
        expect(store.usersOfHelper(p, "two")).toEqual([t]); // through "one"
        expect(store.listHelpers(p).map((h) => [h.name, h.usedBy])).toEqual([["one", 1], ["two", 1]]);
        expect(store.putHelper(p, "two", `export const b = 1;\n`, [])).toEqual({ created: false, changed: false });
        expect(store.putHelper(p, "two", `export const b = 2;\n`, [])).toEqual({ created: false, changed: true });
        for (let i = store.countHelpers(p); i < MAX_HELPERS; i++) store.putHelper(p, `h${i}`, "export {};\n", []);
        expect(() => store.putHelper(p, "one-too-many", "export {};\n", [])).toThrow(/at most 20/);
        // another project has none of them
        const other = seedProject(off, "Other project");
        expect(store.listHelpers(other.projectId)).toEqual([]);
        expect(store.getHelper(other.projectId, "one")).toBeUndefined();
        expect(store.usersOfHelper(other.projectId, "one")).toEqual([]);
    });

    it("stores Git repositories per project, counts their tests, and dropping the link keeps the tests", () => {
        const git = new GitRepoStore(off.db);
        const other = seedProject(off, "Git other");
        const repo = git.create(seed.projectId, { host: "example.test", path: "team/tests", ref: "main", commit: "a".repeat(40), subpath: "e2e" });
        expect(repo).toMatchObject({ host: "example.test", path: "team/tests", ref: "main", commit: "a".repeat(40), subpath: "e2e" });
        expect(git.list(seed.projectId).map((r) => r.id)).toEqual([repo.id]);
        expect(git.get(other.projectId, repo.id)).toBeUndefined(); // another project's id is never found
        expect(git.list(other.projectId)).toEqual([]);
        const t = addTest(off, seed, "git1");
        store.mark(t, seed.projectId, { origin: "git", git: { host: "example.test", path: "team/tests", ref: "main", commit: "a".repeat(40), importedAt: "2026-10-11T00:00:00Z", repoId: repo.id, file: "e2e/a.spec.ts" } });
        expect(git.testCount(seed.projectId, repo.id)).toBe(1);
        expect(git.testsOf(seed.projectId, repo.id)).toEqual([{ testId: t, file: "e2e/a.spec.ts" }]);
        const updated = git.update(seed.projectId, repo.id, { commit: "b".repeat(40) });
        expect(updated?.commit).toBe("b".repeat(40));
        expect(git.update(other.projectId, repo.id, { commit: "c".repeat(40) })).toBeUndefined();
        expect(git.delete(other.projectId, repo.id)).toBe(false);
        expect(git.delete(seed.projectId, repo.id)).toBe(true);
        expect(store.isCustom(t)).toBe(true);
        expect(store.get(t)?.git).toMatchObject({ host: "example.test", file: "e2e/a.spec.ts" });
        expect(store.get(t)?.git?.repoId).toBeUndefined();
    });

    it("lists what taking a test over gives up, and refuses what cannot be taken over", async () => {
        const svc = new CustomScripts({ p: off, repo: off.repo, applicationFor: async () => ({ id: seed.appId, url: "http://127.0.0.1:5590" }), startValidationJob: async (pid, aid, ids) => await off.repo.createJob(pid, aid, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: ids }) });
        const t = addTest(off, seed, "info");
        const info = svc.takeOverInfo(t);
        expect(info.allowed).toBe(true);
        expect(info.losses.join(" ")).toMatch(/only source/);
        expect(info.losses.join(" ")).not.toMatch(/shared elements/); // this test uses none
        // a test with a shared element reference also loses that
        const spec = TestSpecSchema.parse({ testId: "WEB-900", title: "Uses a shared element", kind: "web", steps: [{ action: "navigate", url: "/" }, { action: "click", locator: { ref: "Shop / Buy" } }] });
        const suite = off.repo.getOrCreateSuite(seed.projectId, "Web", "web");
        const w = off.repo.insertTest({ projectId: seed.projectId, suiteId: suite, jobId: null, spec, framework: "playwright", validationStatus: "PENDING" });
        off.repo.addScript(w, { framework: "playwright", filename: "WEB-900.spec.ts", content: "v1", hash: "h", storagePath: "x/w", executable: true });
        const withRef = svc.takeOverInfo(w);
        expect(withRef.losses.join(" ")).toMatch(/shared elements/);
        expect(withRef.losses.join(" ")).toMatch(/Repair suggestions/);
        // already custom
        store.mark(t, seed.projectId, { origin: "written" });
        expect(svc.takeOverInfo(t)).toMatchObject({ allowed: false, reason: expect.stringMatching(/already a code test/) });
        expect(() => svc.takeOverInfo("nope")).toThrow(/not found/);
    });

    it("never rewrites the spec of a hand-written test, whoever asks", () => {
        const t = addTest(off, seed, "lock");
        const before = off.repo.getTest(t)!.spec;
        store.mark(t, seed.projectId, { origin: "taken-over", specArchive: before });
        const changed = { ...before, title: "Somebody repaired this", steps: before.steps.slice(0, 1) };
        off.repo.updateTest(t, { spec: changed, validationStatus: "FAILED_VALIDATION", reason: "boom" });
        const after = off.repo.getTest(t)!;
        expect(after.spec).toEqual(before);
        expect(after.title).toBe(before.title);
        expect(after.validationStatus).toBe("FAILED_VALIDATION"); // the status does change: it is a result
    });

    it("refuses a job with hand-written tests where they may not run, and allows it where the host agreed", async () => {
        const t = addTest(off, seed, "gate");
        store.mark(t, seed.projectId, { origin: "written" });
        await expect(off.repo.createJob(seed.projectId, seed.appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [t] })).rejects.toThrow(/ALLOW_CUSTOM_SCRIPTS=true/);
        // a job that does not include it is not affected
        const plain = addTest(off, seed, "gate-plain");
        expect((await off.repo.createJob(seed.projectId, seed.appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [plain] })).status).toBe("QUEUED");
        // the same tests, a platform that agreed
        const s2 = seedProject(on, "Custom on");
        const t2 = addTest(on, s2, "gate");
        new CustomScriptStore(on.db).mark(t2, s2.projectId, { origin: "written" });
        expect((await on.repo.createJob(s2.projectId, s2.appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [t2] })).status).toBe("QUEUED");
    });

    it("leaves hand-written tests out of automated runs where they may not run, and says so", async () => {
        const s = seedProject(off, "Automated");
        const a = addTest(off, s, "a");
        const b = addTest(off, s, "b");
        store.mark(b, s.projectId, { origin: "written" });
        const split = await splitCustom(off.repo, s.projectId, [a, b]);
        expect(split.ids).toEqual([a]);
        expect(split.skipped).toEqual([b]);
        expect(split.note).toMatch(/1 code test was not run/);
        const s2 = seedProject(on, "Automated on");
        const c = addTest(on, s2, "c");
        new CustomScriptStore(on.db).mark(c, s2.projectId, { origin: "written" });
        expect((await splitCustom(on.repo, s2.projectId, [c])).ids).toEqual([c]);
    });
});
