/**
 * Row 205 item 7 (owner decision 2026-11-21, row 206), with a scripted model double and a real browser on a one-page shop: a writer that
 * reaches "Place order" places it only when the authoring input allows purchases (the project allows tests that change data); off, it
 * stops before paying and checks the button. The double decides from the instructions it is given, as a model would. No paid AI.
 * Run under the browser lock: node scripts/with-lock.mjs browser -- npx vitest run tests/author-purchases.test.ts
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MockLanguageModelV3 } from "ai/test";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import { launchChromium } from "../src/engine/discovery/browser.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { authorWebSpec } from "../src/engine/web/author.js";

let server: Server;
let base = "";
let orders = 0;
let browser: Browser;

const PAGE = `<!doctype html><html><head><title>Review and pay</title></head><body><main><h1>Review and pay</h1><p>Total: $12.00</p>
<form method="post" action="/orders"><button type="submit">Place order</button></form></main></body></html>`;
const PLACED = `<!doctype html><html><head><title>Order placed</title></head><body><main><h1>Order placed</h1></main></body></html>`;

beforeAll(async () => {
    server = createServer((req, res) => {
        if (req.method === "POST" && req.url === "/orders") {
            orders += 1;
            res.writeHead(303, { location: "/placed" }).end();
            return;
        }
        res.writeHead(200, { "content-type": "text/html" }).end(req.url === "/placed" ? PLACED : PAGE);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await launchChromium(true);
}, 30_000);
afterAll(async () => {
    await browser?.close();
    server?.close();
});

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
type Call = { tool: string; input: Record<string, unknown> };
const PLACE = { by: "role", role: "button", value: "Place order" };

/** A model double that places the order only when its instructions allow payments, else checks the button and stops. */
function writer() {
    let plan: Call[] | undefined;
    let i = 0;
    return new MockLanguageModelV3({
        doGenerate: async (options) => {
            if (!plan) {
                const system = options.prompt.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
                plan = /placing orders and making payments in the application under test is allowed/.test(system)
                    ? [
                          { tool: "click", input: { target: PLACE } },
                          { tool: "assert", input: { check: "visible", target: { by: "role", role: "heading", value: "Order placed" } } },
                          { tool: "finish", input: { result: "complete", explanation: "Placed the order" } },
                      ]
                    : [
                          { tool: "assert", input: { check: "visible", target: PLACE } },
                          { tool: "finish", input: { result: "complete", explanation: "Stopped before paying" } },
                      ];
            }
            const next = plan[i++];
            if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
            return { content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
        },
    });
}

const ctxFor = (model: MockLanguageModelV3): EngineContext => ({
    config: loadConfig({}),
    emit: () => undefined,
    llm: { modelName: "scripted", model, usage: { inputTokens: 0, outputTokens: 0 }, object: async () => ({}) as never, text: async () => "" },
});
const appModel = (): AppModel => ({
    url: base, origin: base, siteType: "ecommerce", purpose: "demo", features: [], pages: [], navigation: [], apis: [], journeys: [],
    authentication: { required: false, mechanisms: [], loggedIn: false }, externalDependencies: [], documentedTestCases: [],
    stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
});
const scenario = ScenarioSchema.parse({ scenarioId: "S-PAY", title: "Place the order", description: "Review and place the order", category: "Checkout", startPath: "/", expectedResults: ["The order is placed"] });

describe("placing an order while authoring", () => {
    it("off: the writer stops before Place order and nothing is ordered", async () => {
        orders = 0;
        for (const allowPurchases of [undefined, false]) {
            const out = await authorWebSpec({ ctx: ctxFor(writer()), browser, baseUrl: base, model: appModel(), scenario, ...(allowPurchases === undefined ? {} : { allowPurchases }) });
            expect(out.status).toBe("complete");
            expect(out.steps.some((s) => s.action === "click")).toBe(false);
        }
        expect(orders).toBe(0);
    }, 90_000);

    it("on: the writer places the order and checks it was placed", async () => {
        orders = 0;
        const out = await authorWebSpec({ ctx: ctxFor(writer()), browser, baseUrl: base, model: appModel(), scenario, allowPurchases: true });
        expect(out.status).toBe("complete");
        expect(out.steps.map((s) => s.action)).toEqual(["navigate", "click", "assert"]);
        expect(orders).toBeGreaterThanOrEqual(1);
    }, 90_000);
});
