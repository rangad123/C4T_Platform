/**
 * Relation checks against the real bench shop (Phase 4 T11b), port 9491: the same stored tests run as rendered API and web scripts
 * and through the live interpreter. Clean, every relation holds; with BS-01, BS-02 or BS-11 alone switched on, the relation of the
 * requirement it breaks fails, and the failure names the expression, its values and the requirement. Expected values come from the
 * requirements (3.9, 4.1, 4.5; amounts in cents, 2.7), not from a run of the shop.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "@playwright/test";
import { loadConfig } from "../src/config.js";
import { launchChromium } from "../src/engine/discovery/browser.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { runScripts } from "../src/engine/validation/runner.js";
import { executeStep, runtimeData } from "../src/engine/web/interpreter.js";
import { startBenchApp, type RunningBenchApp } from "../src/eval/bench/verify/app.js";

const PORT = 9491;
const alice = { username: "alice@example.test", password: "Password1!" };
const REQ_3_9 = "subtotal == sum(lines[*].lineTotal)";
const REQ_4_1 = "discount == round(subtotal * 0.10)";
const REQ_4_5 = "(subtotal - discount >= 5000) implies shipping == 0";

// p1 costs 1250 and p3 425 (the product list): 4 × p1 is exactly $50.00 (4.5), then 3 × p3 makes two lines (3.9), then SAVE10 (4.1).
const add = (productId: string, quantity: number) => ({ action: "request", method: "POST", path: "/api/cart/items", body: { productId, quantity }, auth: "default" });
const api: TestSpec = TestSpecSchema.parse({
    testId: "API-001",
    title: "Cart amounts follow the stated rules",
    kind: "api",
    steps: [
        add("p1", 4),
        { action: "assertResponse", check: "relation", expression: REQ_4_5, source: "4.5" },
        add("p3", 3),
        { action: "assertResponse", check: "relation", expression: REQ_3_9, source: "3.9" },
        { action: "request", method: "POST", path: "/api/cart/discount", body: { code: "SAVE10" }, auth: "default", extract: { disc: "discount" } },
        { action: "assertResponse", check: "relation", expression: REQ_4_1, source: "4.1" },
        { action: "assertResponse", check: "relation", expression: "$disc == discount and $disc > 0" },
    ],
});

const addOnPage = (productId: string, quantity: number, extract?: Record<string, string>) => [
    { action: "navigate", url: `/products/${productId}` },
    { action: "fill", locator: { by: "label", value: "Quantity" }, value: String(quantity) },
    { action: "click", locator: { by: "role", role: "button", value: "Add to cart" } },
    { action: "wait", until: "response", value: "/api/cart/items", ...(extract ? { extract } : {}) },
];
const web: TestSpec = TestSpecSchema.parse({
    testId: "WEB-001",
    title: "The cart the page builds follows the stated rules",
    kind: "web",
    steps: [
        { action: "navigate", url: "/login" },
        { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}" },
        { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" },
        { action: "click", locator: { by: "role", role: "button", value: "Sign in" } },
        { action: "wait", until: "visible", locator: { by: "role", role: "button", value: "Sign out" } },
        ...addOnPage("p1", 2, { first: "subtotal" }),
        ...addOnPage("p3", 3, { lineCount: "lines" }),
        { action: "assertResponse", check: "relation", expression: REQ_3_9, source: "3.9" },
        { action: "assertResponse", check: "relation", expression: "$first == 2500 and count($lineCount) == 2" },
    ],
});

// The live interpreter judges relations on the answers of request steps (the browser's own session): add through the page, then read.
const signIn = web.steps.slice(0, 5);
const interpreted: TestSpec = TestSpecSchema.parse({
    testId: "WEB-002",
    title: "The cart the page builds follows the stated rules, read back",
    kind: "web",
    steps: [
        ...signIn,
        ...addOnPage("p1", 2).slice(0, 3),
        { action: "wait", until: "url", value: "/cart" },
        ...addOnPage("p3", 3).slice(0, 3),
        { action: "wait", until: "url", value: "/cart" },
        { action: "request", method: "GET", path: "/api/cart", extract: { first: "subtotal" } },
        { action: "assertResponse", check: "relation", expression: REQ_3_9, source: "3.9" },
        { action: "assertResponse", check: "relation", expression: "$first == 3775" },
    ],
});

let app: RunningBenchApp | undefined;
let browser: Browser;
async function shop(defects: string): Promise<RunningBenchApp> {
    await app?.stop();
    app = await startBenchApp("bench-shop", PORT, defects);
    return app;
}

async function script(spec: TestSpec, base: string) {
    const r = renderScript(spec, spec.kind === "api" ? "playwright-api" : "playwright", { baseUrl: base });
    const [res] = await runScripts(loadConfig({}).scratchDir, [{ testId: spec.testId, filename: r.filename, content: r.content }], { baseUrl: base, headless: true, credentials: alice }, { workers: 1 });
    return res!;
}

/** The live interpreter, as authoring runs steps: the error of the first step that fails, or undefined. */
async function interpret(spec: TestSpec, base: string): Promise<string | undefined> {
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        const data = runtimeData(spec.testData, alice);
        for (const step of spec.steps) await executeStep(page, step, data, base, 8_000);
        return undefined;
    } catch (e) {
        return (e as Error).message;
    } finally {
        await context.close();
    }
}

beforeAll(async () => {
    browser = await launchChromium(true);
}, 60_000);
afterAll(async () => {
    await browser?.close();
    await app?.stop();
});

describe("API script on bench-shop", () => {
    it("clean: every relation holds", async () => {
        const r = await script(api, (await shop("none")).base);
        expect(r.status, r.error).toBe("passed");
    }, 120_000);
    const seeded: Array<[string, string, RegExp]> = [
        ["BS-11", "4.5", /Relation check failed \(4\.5\): \(subtotal - discount >= 5000\) implies shipping == 0\. Values: subtotal = 5000, discount = 0, subtotal - discount = 5000, shipping = 500\./],
        ["BS-02", "3.9", /Relation check failed \(3\.9\): subtotal == sum\(lines\[\*\]\.lineTotal\)\. Values: subtotal = 5425, lines\[\*\]\.lineTotal = \[5000,1275\], sum\(lines\[\*\]\.lineTotal\) = 6275\./],
        ["BS-01", "4.1", /Relation check failed \(4\.1\): discount == round\(subtotal \* 0\.10\)\. Values: discount = 500, subtotal = 6275, subtotal \* 0\.10 = 627\.5, round\(subtotal \* 0\.10\) = 628\./],
    ];
    for (const [seed, req, message] of seeded) {
        it(`${seed} alone: the ${req} relation fails and says why`, async () => {
            const r = await script(api, (await shop(seed)).base);
            expect(r.status).toBe("failed");
            expect(r.error).toMatch(message);
        }, 120_000);
    }
});

describe("web script and live interpreter on bench-shop", () => {
    const want = /Relation check failed \(3\.9\): subtotal == sum\(lines\[\*\]\.lineTotal\)\. Values: subtotal = 2925, lines\[\*\]\.lineTotal = \[2500,1275\], sum\(lines\[\*\]\.lineTotal\) = 3775\./;
    it("clean: the script keeps the redirecting form's answer and passes; the interpreter passes on read-back answers", async () => {
        const base = (await shop("none")).base;
        const r = await script(web, base);
        expect(r.status, r.error).toBe("passed");
        await app!.reset();
        expect(await interpret(interpreted, base)).toBeUndefined();
    }, 180_000);
    it("BS-02: both fail on the 3.9 relation, naming its values", async () => {
        const base = (await shop("BS-02")).base;
        const r = await script(web, base);
        expect(r.status).toBe("failed");
        expect(r.error).toMatch(want);
        await app!.reset();
        expect(await interpret(interpreted, base)).toMatch(want);
    }, 180_000);
    it("the interpreter says plainly when a kept answer's body went with the page (a redirecting form), never a wrong value", async () => {
        const base = (await shop("none")).base;
        // Whether the body is gone depends on timing; either way the interpreter never judges a wrong or empty answer.
        const error = await interpret(web, base);
        if (error !== undefined) expect(error).toMatch(/^The answer from the address containing "\/api\/cart\/items" could not be read: the page moved on/);
    }, 180_000);
});
