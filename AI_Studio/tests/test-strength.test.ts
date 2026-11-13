/**
 * Testing the tests, against a local sample site with a scripted model double (never a real model): a test with a strong assertion
 * catches every deliberate fault; a weak one (visibility only) misses some, is given a stronger check through the review path, and
 * then catches them; the level's bound is kept; and every request reaches the site exactly as it does without faults.
 */
import http from "node:http";
import { MockLanguageModelV3 } from "ai/test";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext, EngineEvent } from "../src/engine/context.js";
import { launchChromium } from "../src/engine/discovery/browser.js";
import { checkStrength } from "../src/engine/mutation/strength.js";
import type { Strength } from "../src/engine/mutation/faults.js";
import { ScenarioSchema, TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { localExecutor } from "../src/engine/frameworks/index.js";
import { renderWithAdapter } from "../src/engine/frameworks/index.js";

const PORT = 9260;
const BASE = `http://127.0.0.1:${PORT}`;
let server: http.Server;
let browser: Browser;
/** Every request the site received: method, path and body. */
let received: string[] = [];

const PAGE = `<!doctype html><title>Fruit</title><h1>Fruit</h1>
<button onclick="load()">Load</button>
<ul id="list" style="min-height:20px;border:1px solid gray"></ul>
<script>
async function load() {
  try {
    const r = await fetch("/api/items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: "fruit" }) });
    const items = await r.json();
    document.getElementById("list").innerHTML = items.map((i) => "<li>" + i.name + "</li>").join("");
  } catch (e) { /* the list stays empty */ }
}
</script>`;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            received.push(`${req.method} ${req.url} ${body}`);
            if (req.url === "/api/items") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify([{ name: "Apple" }, { name: "Pear" }]));
            } else if (req.url === "/") {
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                res.end(PAGE);
            } else {
                res.writeHead(404);
                res.end();
            }
        });
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
function ctxFor(calls: Call[]) {
    const events: EngineEvent[] = [];
    const prompts: string[] = [];
    const model = scripted(calls);
    const orig = model.doGenerate.bind(model);
    model.doGenerate = async (opts) => (prompts.push(JSON.stringify(opts.prompt)), orig(opts));
    const ctx: EngineContext = { config: loadConfig({}), emit: (e) => events.push(e), llm: { modelName: "scripted", model, usage: { inputTokens: 0, outputTokens: 0 }, object: async () => ({}) as never, text: async () => "OK" } };
    return { ctx, events, prompts };
}
const appModel: AppModel = {
    url: BASE, origin: BASE, siteType: "other", purpose: "demo", features: [], pages: [], navigation: [], apis: [], journeys: [],
    authentication: { required: false, mechanisms: [], loggedIn: false }, externalDependencies: [], documentedTestCases: [],
    stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
} as AppModel;
const scenario = ScenarioSchema.parse({ scenarioId: "S-1", title: "Load fruit", description: "Load the list", category: "List", startPath: "/", expectedResults: ["The fruit list shows Apple"] });
const spec = (id: string, check: unknown): TestSpec =>
    TestSpecSchema.parse({ testId: id, title: id, kind: "web", category: "List", source: { origin: "browser-agent" }, steps: [{ action: "navigate", url: "/" }, { action: "click", locator: { by: "role", role: "button", value: "Load" } }, check] });
const strong = spec("WEB-101", { action: "assert", check: "visible", expected: "Apple" });
const weak = spec("WEB-102", { action: "assert", check: "visible", locator: { by: "css", value: "#list" } });
const deps = (ctx: EngineContext, limit: number, withBrowser = true) => ({ scratchDir: ctx.config.scratchDir, env: { baseUrl: BASE, headless: true }, render: { baseUrl: BASE }, workers: 2, baseUrl: BASE, model: appModel, limit, ...(withBrowser ? { browser } : {}) });

describe("testing the tests", () => {
    it("a strong test catches every fault; a weak one misses, is strengthened once, then catches", async () => {
        const { ctx, events, prompts } = ctxFor([
            { tool: "assert", input: { check: "visible", target: { by: "text", value: "Apple" } } },
            { tool: "finish", input: { result: "complete", explanation: "Asserted the fruit" } },
        ]);
        const scored = new Map<string, Strength>();
        const strengthened = new Map<string, TestSpec>();
        const summary = await checkStrength(ctx, deps(ctx, Infinity), [strong, weak].map((s) => ({ spec: s, validationStatus: "VALIDATED", scenario })), {
            onScored: async (id, s) => void scored.set(id, s),
            onStrengthened: async (id, s, run) => (expect(run.status).toBe("passed"), void strengthened.set(id, s)),
        });
        expect(scored.get("WEB-101")).toMatchObject({ caught: 5, total: 5, missed: [] });
        expect(scored.get("WEB-101")!.strengthened).toBeUndefined();
        // The weak test was sent once with the note naming the faults it missed, and the stronger version catches all five (the offline fault too).
        expect(prompts.some((p) => p.includes("add an assertion that would fail when the page's data comes back empty"))).toBe(true);
        expect(strengthened.get("WEB-102")!.steps.at(-1)).toMatchObject({ action: "assert", check: "visible", locator: { by: "text", value: "Apple" } });
        expect(scored.get("WEB-102")).toMatchObject({ caught: 5, total: 5, strengthened: true });
        expect(summary).toMatchObject({ checked: 2, caught: 10, total: 10, strengthened: 1 });
        const weakBefore = events.find((e) => e.kind === "strength_scored" && String(e.message).startsWith("WEB-102"));
        expect(weakBefore?.message).toMatch(/catches 5 of 5.*stronger check/);
    }, 240_000);

    it("scores the weak test as it is without a browser to strengthen it, and keeps the level's bound", async () => {
        const { ctx } = ctxFor([]);
        const scored = new Map<string, Strength>();
        await checkStrength(ctx, deps(ctx, Infinity, false), [{ spec: weak, validationStatus: "VALIDATED" }], { onScored: async (id, s) => void scored.set(id, s) });
        // Only hiding the list breaks a visibility check: an error, an empty list and changed content all pass.
        expect(scored.get("WEB-102")).toMatchObject({ caught: 1, total: 5 });
        expect(scored.get("WEB-102")!.missed).toEqual(["the page's data comes back as a server error", "the page's data comes back empty", "the checked element shows different content", "the browser goes offline"]);

        const bounded = new Map<string, Strength>();
        const s = await checkStrength(ctx, deps(ctx, 1, false), [strong, weak].map((x) => ({ spec: x, validationStatus: "VALIDATED" })), { onScored: async (id, v) => void bounded.set(id, v) });
        expect([...bounded.keys()]).toEqual(["WEB-101"]);
        expect(s.checked).toBe(1);
        // A test that did not pass validation is never replayed.
        const none = await checkStrength(ctx, deps(ctx, Infinity, false), [{ spec: strong, validationStatus: "FAILED_VALIDATION" }], { onScored: async () => undefined });
        expect(none.checked).toBe(0);
    }, 240_000);

    it("sends every request to the site exactly as a run without faults does", async () => {
        const { ctx } = ctxFor([]);
        received = [];
        const s = renderWithAdapter(strong, "playwright", { baseUrl: BASE });
        const [plain] = await localExecutor.execute("playwright", { scratchDir: ctx.config.scratchDir, scripts: [{ testId: strong.testId, filename: s.filename, content: s.content }] }, { run: { baseUrl: BASE, headless: true } }, { workers: 1 });
        expect(plain!.status).toBe("passed");
        const normal = new Set(received);
        received = [];
        await checkStrength(ctx, deps(ctx, Infinity, false), [{ spec: strong, validationStatus: "VALIDATED" }], { onScored: async () => undefined });
        expect(received.length).toBeGreaterThan(0);
        expect(received.filter((r) => !normal.has(r))).toEqual([]);
        expect(received.filter((r) => r.startsWith("POST /api/items")).every((r) => r === 'POST /api/items {"q":"fruit"}')).toBe(true);
    }, 240_000);
});
