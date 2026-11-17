/**
 * Authoring records one turn's tool calls in the order they started (queue row 156).
 *
 * The AI SDK runs the tool calls of one model turn at the same time. executeStep runs one page's steps in order (P3-05), but each call
 * then settles the page, reads what happened and takes a snapshot before its step is recorded, so a call whose aftermath takes longer
 * (here a click that opens a new tab that is slow to settle) was recorded after a later call of the same turn, and the saved test ran its steps in the
 * wrong order. Now the calls of a turn run one at a time, in the order they started, and are recorded in that order.
 *
 * Scripted model double (never a real model): turn 1 sends a click that opens a new tab, slow to settle, and a wait on the first page together.
 */
import http from "node:http";
import { MockLanguageModelV3 } from "ai/test";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import { launchChromium } from "../src/engine/discovery/browser.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { authorWebSpec } from "../src/engine/web/author.js";

const PORT = 9894;
const BASE = `http://127.0.0.1:${PORT}`;
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`;
const server = http.createServer((req, res) => {
    const send = (html: string) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
    };
    // The help page opens in a new tab; its picture comes slowly, so the new tab takes a while to settle.
    if (req.url === "/help") return send(page("Help", `<h1>Help centre</h1><img src="/slow.png" alt="">`));
    if (req.url === "/slow.png") return void setTimeout(() => {
        res.writeHead(404);
        res.end();
    }, 2_000);
    send(page("Orders", `<h1>Orders</h1><a href="/help" target="_blank">Open help</a>`));
});

let browser: Browser;
beforeAll(async () => {
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
    browser = await launchChromium(true);
}, 30_000);
afterAll(async () => {
    await browser?.close();
    server.close();
});

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const call = (id: string, toolName: string, input: unknown) => ({ type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) });
const appModel: AppModel = {
    url: BASE, origin: BASE, siteType: "other", purpose: "fixture", features: [], pages: [], navigation: [], apis: [], journeys: [],
    authentication: { required: false, mechanisms: [], loggedIn: false }, externalDependencies: [], documentedTestCases: [],
    stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
};

describe("one turn's tool calls are recorded in the order they started", () => {
    it("a click whose new tab is slow to settle stays before the wait sent with it in the same turn", async () => {
        const turns = [
            [
                call("a", "click", { target: { by: "role", role: "link", value: "Open help" }, why: "Open the help" }),
                call("b", "wait", { until: "visible", target: { by: "role", role: "heading", value: "Orders" } }),
            ],
            [call("c", "assert", { check: "visible", target: { by: "role", role: "heading", value: "Help centre" } })],
            [call("d", "finish", { result: "complete", explanation: "Help opened" })],
        ];
        let turn = 0;
        const model = new MockLanguageModelV3({
            doGenerate: async () => {
                const content = turns[turn++];
                if (!content) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
                return { content, finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
            },
        });
        const ctx: EngineContext = {
            config: loadConfig({}),
            emit: () => undefined,
            llm: { modelName: "scripted", model, usage: { inputTokens: 0, outputTokens: 0 }, object: async () => ({}) as never, text: async () => "OK" },
        };
        const actions: string[] = [];
        const scenario = ScenarioSchema.parse({ scenarioId: "S-ORDER", title: "Open help", description: "Help opens in a new tab", category: "Help", startPath: "/", expectedResults: ["The help centre shows"] });
        const out = await authorWebSpec({ ctx, browser, baseUrl: BASE, model: appModel, scenario, onAction: (a) => actions.push(a.tool) });
        expect(out, out.explanation).toMatchObject({ status: "complete" });
        expect(out.steps.map((s) => s.action)).toEqual(["navigate", "click", "wait", "assert"]);
        expect(out.steps[1]).toMatchObject({ action: "click", opensPopup: true });
        expect(actions).toEqual(["click", "wait", "assert"]);
    }, 90_000);
});
