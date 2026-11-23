/**
 * Queue row 228: three step faults behind the Phase 3 smoke trial's false positives (row 227 triage), against a local fixture with a
 * scripted model double (never a real model):
 * - 3b: a control's role locator is recorded with an exact name, so the link "Products" does not also match "Browse products" (WEB-017);
 * - 2a: an assert of the engine's own wording ("Every step completes: ...") is refused and not recorded (WEB-065);
 * - 3a: the interpreter's "wait until response" takes only a response that came while the step before it ran or after, as the rendered
 *   script does: the page load's /api/account does not satisfy a wait for "account" after Save sent /api/profile (WEB-026).
 */
import http from "node:http";
import { MockLanguageModelV3 } from "ai/test";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import { launchChromium } from "../src/engine/discovery/browser.js";
import { ScenarioSchema, type Step } from "../src/engine/spec/schema.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { authorWebSpec } from "../src/engine/web/author.js";
import { executeStep, runtimeData } from "../src/engine/web/interpreter.js";

const PORT = 9228;
const BASE = `http://127.0.0.1:${PORT}`;
let server: http.Server;
let browser: Browser;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        if (req.url?.startsWith("/api/")) {
            res.writeHead(200, { "content-type": "application/json" });
            return void res.end("{}");
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        if (req.url === "/products") return void res.end(`<!doctype html><title>Products</title><h1>Products</h1><a href="/cart">Cart</a>`);
        if (req.url === "/qty") return void res.end(`<!doctype html><title>Cart</title><h1>Cart</h1><label>Quantity <input type="number" value="9"></label>`);
        if (req.url === "/profile")
            return void res.end(
                `<!doctype html><title>Profile</title><h1>Profile</h1><p id="msg"></p><button onclick="fetch('/api/profile', { method: 'PUT' }).then(() => { document.querySelector('#msg').textContent = 'Saved.'; })">Save</button><script>fetch('/api/account')</script>`,
            );
        // An empty cart offers "Browse products" next to the menu's "Products".
        res.end(`<!doctype html><title>Cart</title><nav><a href="/products">Products</a></nav><h1>Cart</h1><p>Your cart is empty. <a href="/products">Browse products</a></p>`);
    });
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
    browser = await launchChromium(true);
}, 30_000);
afterAll(async () => {
    await browser?.close();
    server?.close();
});

type Call = { tool: string; input: Record<string, unknown> };
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
function scripted(calls: Call[]) {
    let i = 0;
    return new MockLanguageModelV3({
        doGenerate: async () => {
            const next = calls[i++];
            if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
            return { content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
        },
    });
}
const ctxFor = (model: MockLanguageModelV3): EngineContext => ({
    config: loadConfig({}),
    emit: () => undefined,
    llm: { modelName: "scripted", model, usage: { inputTokens: 0, outputTokens: 0 }, object: async () => ({}) as never, text: async () => "yes" },
});
const emptyModel: AppModel = {
    url: BASE, origin: BASE, siteType: "ecommerce", purpose: "demo", features: [], pages: [], navigation: [], apis: [], journeys: [],
    authentication: { required: false, mechanisms: [], loggedIn: false }, externalDependencies: [], documentedTestCases: [],
    stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
};
const scenario = ScenarioSchema.parse({
    scenarioId: "S-BROWSE", title: "Browse products", description: "Open the products from the menu", category: "Catalogue", startPath: "/cart",
    expectedResults: ['Every step completes: "Open the products" (source: journey-4)'],
});

describe("authoring guards against false positives (row 228)", () => {
    it("records a control's role locator with an exact name, and refuses an assert of the engine's own wording", async () => {
        const actions: Array<{ tool: string; ok: boolean; observation: string }> = [];
        const out = await authorWebSpec({
            ctx: ctxFor(
                scripted([
                    { tool: "click", input: { target: { by: "role", role: "link", value: "Products" } } },
                    { tool: "assert", input: { check: "visible", target: { by: "text", value: "Every step completes: Open the products" }, source: "expected:1" } },
                    { tool: "assert", input: { check: "text", target: { by: "role", role: "main" }, expected: 'every step completes: "Open the products"' } },
                    { tool: "assert", input: { check: "visible", target: { by: "role", role: "heading", value: "Products" }, source: "expected:1" } },
                    { tool: "finish", input: { result: "complete", explanation: "The products page opened" } },
                ]),
            ),
            browser, baseUrl: BASE, model: emptyModel, scenario, onAction: (a) => actions.push(a),
        });
        expect(out.status).toBe("complete");
        const click = out.steps.find((s) => s.action === "click") as Extract<Step, { action: "click" }> | undefined;
        expect(click?.locator).toEqual({ by: "role", role: "link", value: "Products", exact: true });
        const refused = actions.filter((a) => a.tool === "assert" && !a.ok);
        expect(refused).toHaveLength(2);
        for (const a of refused) expect(a.observation).toMatch(/how the scenario words its expected result/);
        expect(out.steps.filter((s) => s.action === "assert")).toHaveLength(1);
    }, 120_000);

    it("a text check on a form field is recorded and run as a value check (paid shop-2 WEB-045: toHaveText on a spinbutton is always empty)", async () => {
        const actions: Array<{ tool: string; ok: boolean; observation: string }> = [];
        const out = await authorWebSpec({
            ctx: ctxFor(
                scripted([
                    { tool: "assert", input: { check: "exactText", target: { by: "role", role: "spinbutton", value: "Quantity" }, expected: "9", source: "expected:1" } },
                    { tool: "finish", input: { result: "complete", explanation: "The quantity shows 9" } },
                ]),
            ),
            browser, baseUrl: BASE, model: emptyModel, scenario: { ...scenario, scenarioId: "S-QTY", startPath: "/qty", expectedResults: ["The cart line keeps quantity 9"] }, onAction: (a) => actions.push(a),
        });
        expect(actions.find((a) => a.tool === "assert")?.ok).toBe(true);
        expect(out.steps.filter((s) => s.action === "assert")).toEqual([expect.objectContaining({ check: "value", expected: "9", locator: { by: "role", role: "spinbutton", value: "Quantity", exact: true } })]);
        const { withFormControlChecks } = await import("../src/engine/web/author.js");
        // A check of a field by its placeholder too; other elements, and a check that is not of text, are left alone.
        const ph: Step = { action: "assert", check: "text", locator: { by: "placeholder", value: "Search" }, expected: "mug", description: "" };
        expect(withFormControlChecks(ph)).toEqual({ ...ph, check: "value" });
        const heading: Step = { action: "assert", check: "exactText", locator: { by: "role", role: "heading", value: "Cart" }, expected: "Cart", description: "" };
        expect(withFormControlChecks(heading)).toEqual(heading);
        const visible: Step = { action: "assert", check: "visible", locator: { by: "role", role: "textbox", value: "Name" }, description: "" };
        expect(withFormControlChecks(visible)).toEqual(visible);
    }, 120_000);

    it("refuses a role locator without its role, with one sentence, and records nothing of it (paid rbac-2 WEB-038)", async () => {
        const { ROLE_MISSING } = await import("../src/engine/spec/schema.js");
        const actions: Array<{ tool: string; ok: boolean; observation: string }> = [];
        const out = await authorWebSpec({
            ctx: ctxFor(
                scripted([
                    { tool: "assert", input: { check: "visible", target: { by: "role", role: "link", value: "Products", within: { by: "role", value: "Main" } }, source: "expected:1" } },
                    { tool: "assert", input: { check: "visible", target: { by: "role", role: "heading", value: "Cart" }, source: "expected:1" } },
                    // A writer that reads the refusal as the defect: the refused check must not become the captured one.
                    { tool: "finish", input: { result: "defect", explanation: "The menu link is missing" } },
                ]),
            ),
            browser, baseUrl: BASE, model: emptyModel, scenario: { ...scenario, scenarioId: "S-ROLE", expectedResults: ["The cart page opens"] }, onAction: (a) => actions.push(a),
        });
        const refused = actions.find((a) => a.tool === "assert" && !a.ok);
        expect(refused?.observation).toContain(ROLE_MISSING);
        expect(out.steps.filter((s) => s.action === "assert")).toEqual([expect.objectContaining({ locator: expect.objectContaining({ role: "heading" }) })]);
        expect(out.status === "defect" && out.capture).not.toBe("captured");
    }, 120_000);

    it("keeps the substring match for containers and for a name the writer set exact=false on", async () => {
        const { withExactRoleNames } = await import("../src/engine/web/author.js");
        const row: Step = { action: "click", locator: { by: "role", role: "button", value: "Remove", within: { by: "role", role: "row", value: "Trail Mug" } }, description: "" };
        expect(withExactRoleNames(row)).toEqual({ ...row, locator: { by: "role", role: "button", value: "Remove", exact: true, within: { by: "role", role: "row", value: "Trail Mug" } } });
        const loose: Step = { action: "click", locator: { by: "role", role: "link", value: "Products", exact: false }, description: "" };
        expect(withExactRoleNames(loose)).toEqual(loose);
        const text: Step = { action: "click", locator: { by: "text", value: "Products" }, description: "" };
        expect(withExactRoleNames(text)).toEqual(text);
    });

    it("a wait for a response takes only one that came while the step before it ran or after, as the rendered script does", async () => {
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            const data = runtimeData({});
            const step = (s: Record<string, unknown>) => ({ description: "", ...s }) as Step;
            await executeStep(page, step({ action: "navigate", url: "/profile" }), data, BASE);
            await page.getByText("Profile").first().waitFor();
            await page.waitForTimeout(300); // the page's own /api/account has come
            await executeStep(page, step({ action: "click", locator: { by: "role", role: "button", value: "Save", exact: true } }), data, BASE);
            await expect(executeStep(page, step({ action: "wait", ms: 0, until: "response", value: "account" }), data, BASE, 1_500)).rejects.toThrow(/Timeout/i);
            // The response the click caused is taken, also after another wait.
            await executeStep(page, step({ action: "click", locator: { by: "role", role: "button", value: "Save", exact: true } }), data, BASE);
            await executeStep(page, step({ action: "wait", ms: 0, until: "response", value: "/api/profile" }), data, BASE, 3_000);
            // A response wait right after the navigate that caused it still sees it.
            await executeStep(page, step({ action: "navigate", url: "/profile" }), data, BASE);
            await executeStep(page, step({ action: "wait", ms: 0, until: "response", value: "account" }), data, BASE, 3_000);
        } finally {
            await context.close();
        }
    }, 60_000);
});
