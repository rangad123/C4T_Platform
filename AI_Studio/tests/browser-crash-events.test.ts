/**
 * A crashed page or a browser that went away is an observed event (discovery/browser.ts): the session says so once, a crawl ends with one
 * warning instead of one failed page per address left (discovery/crawler.ts), and a test being written ends as blocked with that reason
 * (web/author.ts). Also: every caller that opens a browser session whose observed text can reach a prompt, a record or evidence passes the
 * run's secrets. A local page, a real browser, a scripted model; no AI provider.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext, EngineEvent } from "../src/engine/context.js";
import { BrowserSession, launchChromium } from "../src/engine/discovery/browser.js";
import { crawl } from "../src/engine/discovery/crawler.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { authorWebSpec } from "../src/engine/web/author.js";

const PORT = 9550;
const BASE = `http://127.0.0.1:${PORT}`;
const page = (n: number) => `<!doctype html><html><head><title>Page ${n}</title></head><body><h1>Page ${n}</h1>${Array.from({ length: 6 }, (_, i) => `<a href="/p${n * 10 + i}">Go ${n * 10 + i}</a>`).join(" ")}</body></html>`;

let server: http.Server;
beforeAll(async () => {
    server = http.createServer((req, res) => {
        const n = Number((req.url ?? "/").replace(/^\/p?/, "") || 0) || 0;
        res.writeHead(200, { "content-type": "text/html" }).end(page(n));
    });
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
});
afterAll(async () => new Promise((r) => server?.close(r)));

const ctxWith = (events: EngineEvent[], model?: unknown): EngineContext =>
    ({
        config: loadConfig({}),
        emit: (e: EngineEvent) => void events.push(e),
        llm: { modelName: "scripted", model, usage: { inputTokens: 0, outputTokens: 0 }, object: async () => ({}) as never, text: async () => "yes" },
    }) as unknown as EngineContext;

describe("a crash is an observed event", () => {
    it("a crashed page sets the session's crash reason once and the events say so", async () => {
        const browser = await launchChromium(true);
        try {
            const session = await BrowserSession.launch(browser, { startUrl: BASE });
            await session.page.goto(BASE);
            expect(session.crashed).toBeUndefined();
            await session.page.goto("chrome://crash").catch(() => undefined);
            await new Promise((r) => setTimeout(r, 500));
            expect(session.crashed).toBe("The page crashed in the browser");
            const ev = session.takeEvents();
            expect(ev.crashed).toBe("The page crashed in the browser");
            expect(ev.problems).toContain("The page crashed in the browser");
            // Reported once: the next events do not repeat it, the session still knows.
            expect(session.takeEvents().crashed).toBeUndefined();
            expect(session.crashed).toBe("The page crashed in the browser");
            await session.close();
        } finally {
            await browser.close();
        }
    }, 60_000);

    it("a browser that goes away during a crawl ends it with one warning, not one failed page per address left", async () => {
        const browser = await launchChromium(true);
        const events: EngineEvent[] = [];
        const session = await BrowserSession.launch(browser, { startUrl: BASE });
        let seen = 0;
        const ctx = ctxWith(events);
        const emit = ctx.emit;
        ctx.emit = (e: EngineEvent) => {
            emit(e);
            if (e.kind === "page_visited" && ++seen === 2) void browser.close();
        };
        const r = await crawl(session, ctx, { startUrl: BASE, maxPages: 30, maxDepth: 3, maxPerPattern: 30 });
        const crashed = events.filter((e) => e.kind === "discovery_browser_crashed");
        expect(crashed.length).toBe(1);
        expect(crashed[0]!.message).toMatch(/closed unexpectedly/);
        expect(events.filter((e) => e.kind === "page_failed").map((e) => e.message)).toEqual([]);
        expect(r.pages.length).toBeGreaterThanOrEqual(2);
        await session.close();
    }, 90_000);

    it("a test being written ends as blocked with the crash as its reason, and the job's events say so", async () => {
        const browser = await launchChromium(true);
        let calls = 0;
        const model = new MockLanguageModelV3({
            doGenerate: async () => {
                calls++;
                // The browser goes away before the agent's first action is carried out.
                if (calls === 1) await browser.close();
                const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
                return { content: [{ type: "tool-call" as const, toolCallId: `c${calls}`, toolName: "click", input: JSON.stringify({ target: { by: "role", role: "link", value: "Go 1" } }) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
            },
        });
        const events: EngineEvent[] = [];
        const emptyModel = { url: BASE, origin: BASE, siteType: "x", purpose: "x", features: [], pages: [], navigation: [], apis: [], journeys: [], authentication: { required: false, mechanisms: [], loggedIn: false }, externalDependencies: [], documentedTestCases: [], stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 0 } } as unknown as AppModel;
        const scenario = ScenarioSchema.parse({ scenarioId: "S-009", title: "Open a page", description: "x", category: "Nav", priority: "high", startPath: "/", expectedResults: ["Page 1 shows"] });
        const out = await authorWebSpec({ ctx: ctxWith(events, model), browser, baseUrl: BASE, model: emptyModel, scenario, maxSteps: 6 });
        expect(out.status).toBe("blocked");
        expect(out.explanation).toBe("The browser closed unexpectedly, so this test could not be finished.");
        expect(events.some((e) => e.kind === "browser_crashed" && /S-009/.test(e.message))).toBe(true);
        // It stopped at once: the agent was not asked again and again.
        expect(calls).toBeLessThanOrEqual(2);
    }, 90_000);
});

describe("every session whose observed text can reach a prompt, a record or evidence gets the run's secrets", () => {
    const src = (f: string) => fs.readFileSync(path.join(import.meta.dirname, "..", "src", f), "utf8");
    it("discovery, authoring, the replay check and agent runs pass secrets to the session", () => {
        // orchestrator.ts has two: discovery's session and, since 151113c (2026-11-16, before rows 180-183), the signed-out pass's fresh
        // session (crawler.ts addSignedOutPages). That one goes through crawl() like discovery, so a crash there is the same observed event.
        for (const [file, count] of [["engine/orchestrator.ts", 2], ["engine/web/author.ts", 2], ["engine/agent/objective.ts", 1]] as const) {
            const text = src(file);
            const launches = text.split("BrowserSession.launch(").slice(1).map((rest) => rest.slice(0, rest.indexOf("});") >= 0 && rest.indexOf("});") < rest.indexOf(";") + 400 ? rest.indexOf("});") : rest.indexOf(";")));
            expect(launches.length, file).toBe(count);
            for (const l of launches) expect(l, file).toMatch(/secrets/);
        }
    });
    it("repair, plain-English authoring and strengthening hand the run's secrets to the authoring agent", () => {
        expect(src("engine/validation/validator.ts")).toMatch(/repairWeb\(\{[\s\S]*?secrets: secretsOfRun\(deps\.env\)/);
        expect(src("engine/validation/repair.ts")).toMatch(/authorWebSpec\(\{[\s\S]*?args\.secrets/);
        expect(src("engine/authoring/plain.ts")).toMatch(/authorWebSpec\(\{[\s\S]*?secrets: \[req\.credentials\?\.password/);
        expect(src("engine/mutation/strength.ts")).toMatch(/authorWebSpec\(\{[^}]*deps\.secrets/);
        expect(src("engine/orchestrator.ts")).toMatch(/secrets: authoringSecretsOf\(req\), limit: levelSettings\(req\)\.strengthTests/);
    });
});
