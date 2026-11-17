/**
 * A click whose new tab is slow to answer is noticed at the click (queue row 159).
 *
 * Playwright hands out a new tab only once its first page has answered. A help page that takes ~2 s to answer arrived after the click's
 * short settle, so the click was saved without opensPopup and the next action was told about the new tab instead (and ran on the first
 * page). The session now sees the new tab's navigation start at the click and waits for the tab, bounded; a click that opens nothing
 * waits no longer than before.
 *
 * Scripted model double (never a real model).
 */
import http from "node:http";
import { MockLanguageModelV3 } from "ai/test";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import { BrowserSession, launchChromium } from "../src/engine/discovery/browser.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { authorWebSpec } from "../src/engine/web/author.js";

const PORT = 9895;
const BASE = `http://127.0.0.1:${PORT}`;
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`;
const server = http.createServer((req, res) => {
    const send = (html: string) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
    };
    // The help page opens in a new tab and itself answers slowly.
    if (req.url === "/help") return void setTimeout(() => send(page("Help", `<h1>Help centre</h1>`)), 2_000);
    // A page the same tab goes to, as slowly.
    if (req.url === "/slow") return void setTimeout(() => send(page("Slow", `<h1>Slow page</h1>`)), 2_000);
    send(page("Orders", `<h1>Orders</h1><a href="/help" target="_blank">Open help</a><a href="/slow">Same tab</a><button onclick="this.textContent='Done'">Mark</button>`));
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

describe("a new tab whose page answers slowly", () => {
    it("is noticed at the click that opened it: the click waits for the popup and the next step works in it", async () => {
        const turns = [
            [call("a", "click", { target: { by: "role", role: "link", value: "Open help" }, why: "Open the help" })],
            [call("b", "assert", { check: "visible", target: { by: "role", role: "heading", value: "Help centre" } })],
            [call("c", "finish", { result: "complete", explanation: "Help opened" })],
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
        const observations: Record<string, string> = {};
        const scenario = ScenarioSchema.parse({ scenarioId: "S-SLOWTAB", title: "Open help", description: "Help opens in a new tab", category: "Help", startPath: "/", expectedResults: ["The help centre shows"] });
        const out = await authorWebSpec({ ctx, browser, baseUrl: BASE, model: appModel, scenario, onAction: (a) => (observations[a.tool] = a.observation) });
        expect(out, out.explanation).toMatchObject({ status: "complete" });
        expect(out.steps.map((s) => s.action)).toEqual(["navigate", "click", "assert"]);
        expect(out.steps[1]).toMatchObject({ action: "click", opensPopup: true });
        expect(out.steps[2]).toMatchObject({ action: "assert", inPopup: true });
        expect(observations.click).toContain("A new tab opened");
        expect(observations.assert).not.toContain("A new tab opened");
    }, 90_000);

    it("costs a click that opens no new tab nothing: the wait for a new tab returns at once", async () => {
        const session = await BrowserSession.launch(browser, { startUrl: BASE });
        try {
            await session.page.goto(BASE);
            for (const name of ["Mark", "Same tab"]) {
                session.takeEvents();
                await session.page.getByText(name, { exact: true }).click();
                await session.quiet();
                const t = Date.now();
                await session.newTab();
                expect(Date.now() - t, name).toBeLessThan(100);
                expect(session.takeEvents().opened, name).toEqual([]);
            }
        } finally {
            await session.close();
        }
    }, 30_000);
});
