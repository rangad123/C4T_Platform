/**
 * Round 13 (AZ1), findings M1 and M3 of the AX review: the static guard for hand-written scripts.
 *   M1  it never hangs and never throws: hostile shapes (the reviewer's 120 KB `1+1+...`, 60 000 open brackets) come back as a diagnostic quickly
 *   M3  names that lead to the Function constructor, to prototypes, to Playwright's desktop and Android parts, browser start options, file paths
 *       and file addresses are seen also when they sit in a constant, a destructuring pattern, a joined string or a namespace import
 * Browser-free. The reviewer's own examples are in .scratch/review/ax-guard.mts.
 */
import { describe, expect, it } from "vitest";
import { checkScript, GUARD_RULES, MAX_AST_DEPTH } from "../src/engine/custom/guard.js";

const HEAD = `import { test, expect, chromium } from "@playwright/test";\n`;
const body = (inner: string) => `${HEAD}test("a", async ({ page }) => {\n${inner}\n});\n`;
const rules = (code: string) => checkScript(code).diagnostics.filter((d) => d.severity === "error").map((d) => d.rule);

describe("M1: the guard never hangs and never throws", () => {
    // [name, source]: each used to take seconds (the sum) or throw a RangeError (the brackets)
    const hostile: Array<[string, string]> = [
        ["the reviewer's 120 KB sum of ones", "const x = " + Array(60_000).fill("1").join("+") + ";"],
        ["60 000 open and closed parentheses", "const x = " + "(".repeat(60_000) + "1" + ")".repeat(60_000) + ";"],
        ["60 000 nested array brackets", "const x = " + "[".repeat(60_000) + "]".repeat(60_000) + ";"],
        ["20 000 nested functions", "function a(){".repeat(20_000) + "}".repeat(20_000)],
        ["a member chain 40 000 long", "const x = a" + ".b".repeat(40_000) + ";"],
        ["a template literal nested 3 000 deep", "const x = " + "`${".repeat(3_000) + "1" + "}`".repeat(3_000) + ";"],
        ["a long run of unary operators", "const x = " + "!".repeat(50_000) + "1;"],
        ["a thousand declarations of one name", Array.from({ length: 5_000 }, (_, i) => `const k = "v${i}";`).join("\n")],
        ["200 000 characters of junk", "@#%^&*".repeat(33_000)],
    ];
    it.each(hostile)("%s: a verdict in about a second, never an exception", (_name, code) => {
        const started = Date.now();
        const r = checkScript(code);
        const took = Date.now() - started;
        // The old guard took 49 s on one of these. The budget is generous so a busy machine (the whole fast tier running) does not fail the test.
        expect(took, `${took} ms`).toBeLessThan(8000);
        expect(Array.isArray(r.diagnostics)).toBe(true);
        expect(typeof r.ok).toBe("boolean");
    });

    it("the deep or huge ones are refused with a plain sentence, not passed", () => {
        for (const code of ["const x = " + Array(60_000).fill("1").join("+") + ";", "const x = " + "(".repeat(60_000) + "1" + ")".repeat(60_000) + ";"]) {
            const r = checkScript(code);
            expect(r.ok).toBe(false);
            expect(r.diagnostics[0]!.message).toMatch(/nested|deeply|Split it/);
        }
        expect(checkScript("const x = " + Array(MAX_AST_DEPTH + 10).fill("1").join("+") + ";").diagnostics[0]!.rule).toBe("complexity");
        // ordinary nesting and ordinary long expressions are fine
        expect(checkScript(body("const x = " + Array(200).fill("1").join("+") + "; void x;")).ok).toBe(true);
    });

    it("any failure inside the check becomes an error diagnostic (the platform's other work is never taken down)", () => {
        const r = checkScript(undefined as unknown as string);
        expect(r.ok).toBe(false);
        expect(r.diagnostics[0]).toMatchObject({ severity: "error", rule: "unreadable" });
        expect(r.helperImports).toEqual([]);
    });

    it("a script near the size limit with ordinary code is checked in a few seconds at most", () => {
        let code = HEAD;
        let i = 0;
        while (Buffer.byteLength(code) < 190_000) code += `test("case ${i++}", async ({ page }) => {\n  const k = "a${i}";\n  await page.goto("/x/" + k);\n  await expect(page.getByRole("button", { name: "Go ${i}" })).toBeVisible();\n});\n`;
        const started = Date.now();
        const r = checkScript(code);
        expect(Date.now() - started).toBeLessThan(5000);
        expect(r.ok).toBe(true);
    });

    it("a long list of findings is cut, the verdict is not", () => {
        const many = HEAD + Array.from({ length: 2_000 }, (_, i) => `const a${i} = require("x${i}");`).join("\n");
        const r = checkScript(many);
        expect(r.ok).toBe(false);
        expect(r.diagnostics.length).toBeLessThanOrEqual(302);
        expect(r.diagnostics.some((d) => d.rule === "many-findings")).toBe(true);
    });

    it("a syntax error is still reported with its place, from the parser", () => {
        const r = checkScript(`${HEAD}const = ;\n`);
        expect(r.diagnostics.find((d) => d.rule === "syntax")).toMatchObject({ line: 2, severity: "error" });
    });
});

describe("M3: the reviewer's bypasses are refused", () => {
    // [name, code, rule that must fire]
    const refused: Array<[string, string, string]> = [
        // the Function constructor
        ["a constant holding \"constructor\", used twice as a key", body(`const k = "constructor"; const F = (async () => {})[k][k]; await F("return 1")();`), "forbidden-property"],
        ["a constant built from pieces", body(`const a = "constr"; const b = a + "uctor"; ([] as any)[b]("x");`), "forbidden-property"],
        ["a template holding the name", body("const a = \"constr\"; const f = ([] as any)[`${a}uctor`];"), "forbidden-property"],
        ["a name joined from an array", body(`const k = ["constr", "uctor"].join(""); const f = ([] as any)[k];`), "forbidden-property"],
        ["a name joined with concat", body(`const f = ([] as any)["constr".concat("uctor")];`), "forbidden-property"],
        ["a name chosen by a condition", body(`const k = Math.random() > 2 ? "length" : "constructor"; const f = ([] as any)[k];`), "forbidden-property"],
        ["a name changed to the forbidden one later", body(`let k = "length"; k = "constructor"; const f = ([] as any)[k];`), "forbidden-property"],
        ["a name in upper case, folded", body(`const f = ([] as any)["CONSTRUCTOR".toLowerCase()];`), "forbidden-property"],
        ["destructuring the constructor", body(`const { constructor: F } = async () => {}; await F("return 1")();`), "forbidden-property"],
        ["destructuring a quoted constructor", body(`const { "constructor": F } = async () => {}; void F;`), "forbidden-property"],
        ["destructuring a computed constructor", body(`const { ["constructor"]: F } = async () => {}; await F("return 1")();`), "forbidden-property"],
        ["destructuring a computed key held in a constant", body(`const k = "constructor"; const { [k]: F } = async () => {}; void F;`), "forbidden-property"],
        ["destructuring a shorthand constructor", body(`const { constructor } = {} as any; void constructor;`), "forbidden-property"],
        ["destructuring in a parameter", body(`const f = ({ constructor }: any) => constructor; void f;`), "forbidden-property"],
        ["a key computed at run time in a pattern", body(`const k = String(Math.random()); const { [k]: v } = {} as any; void v;`), "forbidden-property"],
        ["destructuring __proto__", body(`const { __proto__: p } = {} as any; void p;`), "forbidden-property"],
        // reflection
        ["Reflect.get", body(`const F = Reflect.get(async () => {}, "constructor"); await F("return 1")();`), "reflection"],
        ["Reflect used at all", body(`const keys = Reflect.ownKeys({}); void keys;`), "reflection"],
        ["a property descriptor of the prototype", body(`const F = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(async()=>{}), "constructor")!.value; await F("return 1")();`), "forbidden-property"],
        ["getOwnPropertyDescriptors", body(`const d = Object.getOwnPropertyDescriptors({}); void d;`), "forbidden-property"],
        ["getPrototypeOf alone", body(`const p = Object.getPrototypeOf({}); void p;`), "forbidden-property"],
        ["setPrototypeOf", body(`Object.setPrototypeOf({}, null);`), "forbidden-property"],
        ["getPrototypeOf reached by a constant name", body(`const n = "getPrototypeOf"; const p = (Object as any)[n]({}); void p;`), "forbidden-property"],
        ["getPrototypeOf taken out of Object", body(`const { getPrototypeOf } = Object; void getPrototypeOf;`), "forbidden-property"],
        // Playwright parts that start programs
        ["_electron through a namespace import", `import * as pw from "@playwright/test";\nimport { test } from "@playwright/test";\ntest("a", async () => { await pw._electron.launch({}); });`, "import"],
        ["_electron through a namespace import and a quoted key", `import * as pw from "@playwright/test";\nimport { test } from "@playwright/test";\ntest("a", async () => { await pw["_electron"].launch({}); });`, "import"],
        ["android through a namespace import", `import * as pw from "@playwright/test";\nimport { test } from "@playwright/test";\ntest("a", async () => { await pw.android.devices(); });`, "import"],
        ["android through a constant name on a namespace", `import * as pw from "@playwright/test";\nimport { test } from "@playwright/test";\nconst n = "android";\ntest("a", async () => { await (pw as any)[n].devices(); });`, "import"],
        ["android through a copy of the namespace", `import * as pw from "@playwright/test";\nimport { test } from "@playwright/test";\nconst alias = pw;\ntest("a", async () => { await alias.android.devices(); });`, "import"],
        ["android through destructuring the namespace", `import * as pw from "@playwright/test";\nimport { test } from "@playwright/test";\nconst { android } = pw;\ntest("a", async () => { await android.devices(); });`, "import"],
        ["android through the default import", `import pw from "@playwright/test";\nimport { test } from "@playwright/test";\ntest("a", async () => { await pw.android.devices(); });`, "import"],
        ["_electron on anything", body(`await (page as any)._electron.launch({});`), "import"],
        // browser start options
        ["launch args", `${HEAD}test("a", async () => { await chromium.launch({ args: ["--renderer-cmd-prefix=calc.exe"] }); });`, "launch-option"],
        ["launch env", `${HEAD}test("a", async () => { await chromium.launch({ env: { A: "b" } }); });`, "launch-option"],
        ["test.use launchOptions args and env", `${HEAD}test.use({ launchOptions: { args: ["--x"], env: { A: "b" } } });\ntest("a", async () => {});`, "launch-option"],
        ["args given as a shorthand", `${HEAD}const args = ["--x"];\ntest.use({ launchOptions: { args } });\ntest("a", async () => {});`, "launch-option"],
        ["newContext with launchOptions", body(`await page.context().browser()!.newContext({ launchOptions: { args: ["--x"] } } as any);`), "launch-option"],
        ["connecting to a browser somewhere else", `${HEAD}test("a", async () => { await chromium.connect("ws://127.0.0.1:1/"); });`, "launch"],
        // file paths
        ["a path kept in a constant (setInputFiles and storageState)", body(`const p = "C:/Windows/win.ini"; await page.setInputFiles("input", p); await page.context().storageState({ path: p });`), "path-escape"],
        ["a path joined from pieces", body(`const p = ["C:", "Windows"].join("/"); await page.screenshot({ path: p + "/x.png" });`), "path-escape"],
        ["a path that climbs, in a constant", body(`const up = "../../secret.txt"; await page.screenshot({ path: up });`), "path-escape"],
        ["a path in a shorthand option", body(`const path = "/etc/passwd"; await page.screenshot({ path });`), "path-escape"],
        ["setInputFiles with an absolute path as the only argument", body(`await page.locator("input").setInputFiles("C:/Users/x/secret.txt");`), "path-escape"],
        ["setInputFiles with a list of paths", body(`await page.locator("input").setInputFiles(["a.png", "/etc/passwd"]);`), "path-escape"],
        ["storageState read from an absolute path", `import { test, request } from "@playwright/test";\ntest("a", async () => { await request.newContext({ storageState: "C:/Users/x/secret.json" }); });`, "path-escape"],
        ["a video folder outside the test folder", body(`await page.context().browser()!.newContext({ recordVideo: { dir: "/tmp/v" } });`), "path-escape"],
        ["a HAR file outside the test folder", body(`await page.context().browser()!.newContext({ recordHar: { path: "C:/x/h.har" } });`), "path-escape"],
        // file addresses
        ["opening a file address", body(`await page.goto("file:///C:/Windows/win.ini");`), "goto-scheme"],
        ["opening a file address kept in a constant", body(`const u = "file:" + "///etc/passwd"; await page.goto(u);`), "goto-scheme"],
        ["opening a file address in capitals", body(`await page.goto("  FILE:///etc/passwd");`), "goto-scheme"],
        ["opening a browser-internal address", body(`await page.goto("chrome://net-export/");`), "goto-scheme"],
    ];
    it.each(refused)("%s", (_name, code, rule) => {
        const r = checkScript(code);
        expect(rules(code), r.diagnostics.map((d) => `${d.line}:${d.column} ${d.rule} ${d.message}`).join("\n")).toContain(rule);
        expect(r.ok).toBe(false);
    });
});

describe("M3: ordinary code is still accepted", () => {
    const fine: Array<[string, string]> = [
        ["a constant that is never used as a property name", body(`const functionName = "constructor"; const label = ["a", "b"].join("-"); void [functionName, label];`)],
        ["a constant text used as a locator and an address", body(`const where = "/products"; await page.goto(where); await page.getByText("constructor").click();`)],
        ["destructuring ordinary names", body(`const { a, b: c, ...rest } = { a: 1, b: 2, d: 3 }; void [a, c, rest];`)],
        ["a computed key that is a plain constant", body(`const k = "name"; const { [k]: n } = { name: "x" }; void n;`)],
        ["a browser start without options of that kind", `${HEAD}test("a", async () => { await chromium.launch({ headless: true, slowMo: 10 }); });`],
        ["args and env as ordinary names in data", body(`const job = { args: [1, 2], env: "prod" }; test.info().annotations.push({ type: "job", description: JSON.stringify(job) });`)],
        ["a relative screenshot, a relative upload, a video in the test folder", body(`await page.screenshot({ path: "shots/a.png" }); await page.locator("input").setInputFiles("fixtures/a.png"); await page.context().browser()!.newContext({ recordVideo: { dir: "videos" } });`)],
        ["an XPath selector given to the page form of setInputFiles", body(`await page.setInputFiles("input#file", "fixtures/a.png");`)],
        ["a cookie path", body(`await page.context().addCookies([{ name: "a", value: "b", domain: "x.test", path: "/" }]);`)],
        ["a storage state cookie path in an options object", `import { test, request } from "@playwright/test";\ntest("a", async () => { await request.newContext({ storageState: { cookies: [{ name: "a", value: "b", domain: "x.test", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }], origins: [] } }); });`],
        ["opening an http address and a relative one", body(`await page.goto("https://example.test/a"); await page.goto("/b"); await page.goto("data-not-a-scheme");`)],
        ["a property called android on your own data", body(`const device = { android: true }; void device.android;`)],
        ["the word Reflect in a string and a comment", body(`// Reflect on this\nconst note = "Reflect.get is not used"; void note;`)],
        ["a destructured namespace member that is fine", `import * as pw from "@playwright/test";\nimport { test } from "@playwright/test";\nconst { chromium } = pw;\ntest("a", async () => { void chromium; });`],
    ];
    it.each(fine)("%s", (_name, code) => {
        const r = checkScript(code);
        expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.line}:${d.column} ${d.rule} ${d.message}`)).toEqual([]);
    });
});

describe("M3: the rules are told honestly", () => {
    it("lists the new refusals and the limits of the check, including network traffic and untrusted authors", () => {
        const text = GUARD_RULES.join(" ");
        expect(text).toMatch(/Reflect/);
        expect(text).toMatch(/getPrototypeOf/);
        expect(text).toMatch(/args and env/);
        expect(text).toMatch(/file: address/);
        expect(text).toMatch(/fetch and request\.newContext/);
        expect(text).toMatch(/ALLOW_CUSTOM_SCRIPTS must not be enabled for authors you do not trust/);
        expect(text).toMatch(/not a security boundary/);
    });
    it("still cannot see a name computed at run time (stated, not hidden)", () => {
        expect(checkScript(body(`const key = Array.from("rotcurtsnoc").reverse().join(""); const f = ([] as any)[key]; void f;`)).ok).toBe(true);
    });
});
