/**
 * Stronger web checks (round 54) in real Playwright runs against a local site: every new check passes where it should and fails where it
 * should, an ARIA snapshot with a changing number still matches, soft outcome checks report every failure with the first step's index, a
 * remembered price is compared across pages, and a request inside a web test refuses a foreign origin. The live interpreter agrees.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { launchChromium } from "../src/engine/discovery/browser.js";
import { renderScript } from "../src/engine/generators/index.js";
import { StepSchema, TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { runScripts, type ScriptRun } from "../src/engine/validation/runner.js";
import { captureAriaTemplate, executeStep, runtimeData } from "../src/engine/web/interpreter.js";

const PORT = 9310;
const BASE = `http://127.0.0.1:${PORT}`;
let order = 1000;

const PAGES: Record<string, () => string> = {
    "/product": () => `<h1>Blue mug</h1><img alt="Blue mug photo" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><span data-testid="price">$12.50</span><a href="/cart">Add to cart</a>`,
    // Every load shows a new order number: an ARIA snapshot template must still match.
    "/cart": () => `<h1>Your cart</h1><ul aria-label="Cart lines"><li>Blue mug <span data-testid="line">$12.50</span></li><li>Red cup <span>$3.00</span></li></ul>
<p data-testid="total">Total: $15.50</p><p data-testid="order">Order ${++order} placed</p>`,
    "/form": () => `<label for="email">Email</label><input id="email" autofocus aria-invalid="true" aria-errormessage="err" value="bad@">
<p id="err">Enter a valid email address</p>
<label><input type="checkbox" checked> Gift wrap</label><label><input type="checkbox"> Express</label>
<label for="code">Code</label><input id="code" readonly value="X1">
<button class="btn primary" title="Save the form" style="color: rgb(200, 0, 0)">Save</button>
<div style="height: 3000px"></div><p>Far below</p>`,
    "/slow": () => `<p id="state">Loading</p><a href="/cart">Cart</a><script>setTimeout(() => fetch("/api/cart").then(() => { document.getElementById("state").remove(); const p = document.createElement("p"); p.textContent = "Loaded"; document.body.append(p); }), 400);</script>`,
};

let server: http.Server;
let browser: Browser;
beforeAll(async () => {
    server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", BASE);
        if (url.pathname === "/api/cart") {
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(JSON.stringify({ id: 7, items: 2 }));
        }
        const page = Object.hasOwn(PAGES, url.pathname) ? PAGES[url.pathname] : undefined;
        res.writeHead(page ? 200 : 404, { "content-type": "text/html" });
        res.end(`<!doctype html><html lang="en"><head><title>Shop</title></head><body>${page ? page() : "Not found"}</body></html>`);
    });
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
    expect((server.address() as AddressInfo).port).toBe(PORT);
    browser = await launchChromium(true);
}, 60_000);
afterAll(async () => {
    await browser?.close();
    await new Promise((r) => server?.close(r));
});

let n = 0;
const spec = (start: string, steps: unknown[]): TestSpec => TestSpecSchema.parse({ testId: `WEB-${String(++n).padStart(3, "0")}`, title: "Check", kind: "web", steps: [{ action: "navigate", url: start }, ...steps] });

async function run(specs: TestSpec[]): Promise<Map<string, ScriptRun>> {
    const scripts = specs.map((s) => {
        const r = renderScript(s, "playwright", { baseUrl: BASE });
        return { testId: s.testId, filename: r.filename, content: r.content };
    });
    const out = await runScripts(loadConfig({}).scratchDir, scripts, { baseUrl: BASE, headless: true }, { workers: 4 });
    return new Map(out.map((r) => [r.testId, r]));
}

const email = { by: "label", value: "Email" };
const save = { by: "role", role: "button", value: "Save" };
/** Each check once where it holds and once where it does not. */
const CHECKS: Array<{ name: string; pass: Record<string, unknown>; fail: Record<string, unknown> }> = [
    { name: "checked", pass: { check: "checked", locator: { by: "label", value: "Gift wrap" } }, fail: { check: "checked", locator: { by: "label", value: "Express" } } },
    { name: "unchecked", pass: { check: "unchecked", locator: { by: "label", value: "Express" } }, fail: { check: "unchecked", locator: { by: "label", value: "Gift wrap" } } },
    { name: "focused", pass: { check: "focused", locator: email }, fail: { check: "focused", locator: { by: "label", value: "Code" } } },
    { name: "editable", pass: { check: "editable", locator: email }, fail: { check: "editable", locator: { by: "label", value: "Code" } } },
    { name: "inViewport", pass: { check: "inViewport", locator: save }, fail: { check: "inViewport", locator: { by: "text", value: "Far below" } } },
    { name: "attribute", pass: { check: "attribute", locator: email, name: "aria-invalid", expected: "true" }, fail: { check: "attribute", locator: email, name: "aria-invalid", expected: "false" } },
    { name: "class", pass: { check: "class", locator: save, expected: "primary" }, fail: { check: "class", locator: save, expected: "prim" } },
    { name: "css", pass: { check: "css", locator: save, name: "color", expected: "rgb(200, 0, 0)" }, fail: { check: "css", locator: save, name: "color", expected: "rgb(0, 0, 0)" } },
    { name: "accessibleName", pass: { check: "accessibleName", locator: { by: "title", value: "Save the form" }, expected: "Save" }, fail: { check: "accessibleName", locator: save, expected: "Submit" } },
    { name: "accessibleErrorMessage", pass: { check: "accessibleErrorMessage", locator: email, expected: "valid email" }, fail: { check: "accessibleErrorMessage", locator: email, expected: "Required" } },
    { name: "exactText", pass: { check: "exactText", locator: { by: "testId", value: "total" }, expected: "Total: $15.50" }, fail: { check: "exactText", locator: { by: "testId", value: "total" }, expected: "Total: $15" } },
    { name: "notText", pass: { check: "notText", expected: "undefined" }, fail: { check: "notText", expected: "Red cup" } },
    { name: "urlPattern", pass: { check: "urlPattern", expected: "/c*t" }, fail: { check: "urlPattern", expected: "/orders/*" } },
];
const startOf = (c: (typeof CHECKS)[number]) => (["exactText", "notText", "urlPattern"].includes(c.name) ? "/cart" : "/form");

describe("every new check in a real Playwright run", () => {
    it("passes where it holds and fails, at its own step, where it does not; the interpreter agrees", async () => {
        const passing = CHECKS.map((c) => spec(startOf(c), [{ action: "assert", ...c.pass }]));
        const failing = CHECKS.map((c) => spec(startOf(c), [{ action: "assert", ...c.fail }]));
        const runs = await run([...passing, ...failing]);
        for (const [i, c] of CHECKS.entries()) {
            expect(runs.get(passing[i]!.testId)?.status, `${c.name} passes: ${runs.get(passing[i]!.testId)?.error}`).toBe("passed");
            const f = runs.get(failing[i]!.testId)!;
            expect(f.status, `${c.name} fails`).toBe("failed");
            expect(f.failedStepIndex, c.name).toBe(1);
        }
        // The live interpreter (authoring, repair replays) gives the same verdicts.
        const ctx = await browser.newContext();
        try {
            const page = await ctx.newPage();
            for (const c of CHECKS) {
                const data = runtimeData({});
                await executeStep(page, { action: "navigate", url: startOf(c), description: "" }, data, BASE);
                await executeStep(page, StepSchema.parse({ action: "assert", ...c.pass }) as never, data, BASE, 3_000);
                await expect(executeStep(page, StepSchema.parse({ action: "assert", ...c.fail }) as never, data, BASE, 1_500), c.name).rejects.toThrow();
            }
        } finally {
            await ctx.close();
        }
    }, 180_000);
});

describe("ARIA snapshot, soft outcome checks, remembered values, waits and requests", () => {
    it("runs them for real", async () => {
        // The template is captured once (as the authoring agent does); the run loads the page again, with a new order number.
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(`${BASE}/cart`);
        const cartLines = { by: "role", role: "list", value: "Cart lines" };
        const template = await captureAriaTemplate(page, cartLines as never, {});
        const orderTemplate = await captureAriaTemplate(page, { by: "testId", value: "order" } as never, {});
        await ctx.close();
        expect(template).toContain('- list "Cart lines"');
        expect(template).toContain("Blue mug \\$[\\w.,:/-]+");
        expect(orderTemplate).toContain("/Order [\\w.,:/-]+ placed/");

        const aria = spec("/cart", [{ action: "assert", check: "ariaSnapshot", locator: { by: "testId", value: "order" }, expected: orderTemplate }, { action: "assert", check: "ariaSnapshot", locator: cartLines, expected: template }]);
        const ariaWrong = spec("/cart", [{ action: "assert", check: "ariaSnapshot", locator: cartLines, expected: template.replace("Red cup", "Green cup") }, { action: "click", locator: { by: "text", value: "Your cart" } }]);
        // Three outcome checks, the 2nd and 3rd wrong: both are reported, and the first failed step is the 2nd check (index 2).
        const soft = spec("/cart", [
            { action: "assert", check: "text", locator: { by: "testId", value: "total" }, expected: "15.50" },
            { action: "assert", check: "exactText", locator: { by: "testId", value: "line" }, expected: "$99.00" },
            { action: "assert", check: "notText", expected: "Blue mug" },
        ]);
        // The price on the product page is the price in the cart, and less than the cart total.
        const remembered = spec("/product", [
            { action: "remember", locator: { by: "testId", value: "price" }, name: "price" },
            { action: "click", locator: { by: "role", role: "link", value: "Add to cart" } },
            { action: "wait", until: "url", value: "/cart" },
            { action: "assert", check: "remembered", locator: { by: "role", role: "listitem", filter: { hasText: "Blue mug" } }, name: "price", compare: "contains" },
            { action: "assert", check: "remembered", locator: { by: "testId", value: "line" }, name: "price", compare: "equals" },
            { action: "assert", check: "remembered", locator: { by: "testId", value: "total" }, name: "price", compare: "greater" },
            { action: "assert", check: "text", locator: { by: "testId", value: "line", within: { by: "role", role: "list" } }, expected: "{{price}}" },
        ]);
        const rememberedWrong = spec("/product", [
            { action: "remember", locator: { by: "testId", value: "price" }, name: "price" },
            { action: "navigate", url: "/cart" },
            { action: "assert", check: "remembered", locator: { by: "testId", value: "total" }, name: "price", compare: "less" },
        ]);
        const waits = spec("/slow", [
            { action: "wait", until: "response", value: "/api/cart" },
            { action: "wait", until: "hidden", locator: { by: "text", value: "Loading" } },
            { action: "wait", until: "visible", locator: { by: "text", value: "Loaded" } },
            { action: "request", method: "GET", path: "/api/cart", auth: "none", extract: { cartId: "id" } },
            { action: "assertResponse", check: "status", expected: 200 },
            { action: "assertResponse", check: "jsonPath", path: "items", expected: "2" },
            { action: "navigate", url: "/cart?id={{cartId}}" },
            { action: "assert", check: "url", expected: "id=7" },
        ]);
        const runs = await run([aria, ariaWrong, soft, remembered, rememberedWrong, waits]);
        const r = (s: TestSpec) => runs.get(s.testId)!;
        expect(r(aria).status, r(aria).error).toBe("passed");
        expect(r(ariaWrong).status).toBe("failed");
        expect(r(ariaWrong).failedStepIndex).toBe(1);
        expect(r(soft).status).toBe("failed");
        expect(r(soft).failedStepIndex).toBe(2);
        expect(r(soft).steps.filter((s) => s.status === "failed").map((s) => s.index)).toEqual([2, 3]);
        expect(r(soft).steps.find((s) => s.index === 1)?.status).toBe("passed");
        expect(r(remembered).status, r(remembered).error).toBe("passed");
        expect(r(rememberedWrong).status).toBe("failed");
        expect(r(rememberedWrong).failedStepIndex).toBe(3);
        expect(r(waits).status, r(waits).error).toBe("passed");

        // The interpreter runs the same steps (the response wait sees the response the page already received).
        const live = await browser.newContext();
        try {
            const p = await live.newPage();
            for (const s of [remembered, waits, aria]) {
                const data = runtimeData({});
                for (const step of s.steps) await executeStep(p, step, data, BASE);
            }
            const data = runtimeData({});
            await executeStep(p, { action: "navigate", url: "/cart", description: "" }, data, BASE);
            await expect(executeStep(p, { action: "request", method: "GET", path: "http://localhost:9311/x", auth: "none", description: "" }, data, BASE)).rejects.toThrow("A web test sends requests only to the application's own site or its API address");
        } finally {
            await live.close();
        }
    }, 180_000);
});
