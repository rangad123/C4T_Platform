/**
 * Stronger and more reliable web tests, with a scripted model double (never a real model) against local sites:
 * a finish without an assertion on the outcome is pushed back, the review's fix is applied through the resume path,
 * a blocked scenario gets one retry, the level's step limit reaches the agent, and a test that still fails after
 * validation is reported as flaky or as broken at its step.
 */
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import type { EngineContext, EngineEvent } from "../src/engine/context.js";
import { launchChromium } from "../src/engine/discovery/browser.js";
import { LEVEL_SETTINGS } from "../src/engine/levels.js";
import { ScenarioSchema, TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { validateBatch } from "../src/engine/validation/validator.js";
import { authorWebSpec } from "../src/engine/web/author.js";

const APP_PORT = 9230;
const FIX_PORT = 9231;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const FIX = `http://127.0.0.1:${FIX_PORT}`;
let app: ChildProcess;
let fixture: http.Server;
let browser: Browser;
let flakyLoads = 0;

beforeAll(async () => {
    app = spawn(process.execPath, [path.join(REPO_ROOT, "examples/sample-app/server.mjs"), String(APP_PORT)], { stdio: "ignore" });
    // /flaky shows "Done" on every second load; /broken has no "Save Changes" button any more, only "Save changes".
    fixture = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        if (req.url === "/flaky") res.end(`<!doctype html><title>Flaky</title><h1>${++flakyLoads % 2 === 0 ? "Done" : "Working"}</h1>`);
        else res.end(`<!doctype html><title>Form</title><h1>Form</h1><button onclick="document.getElementById('m').textContent='Saved'">Save changes</button><p id="m">Not saved</p>`);
    });
    await new Promise<void>((r) => fixture.listen(FIX_PORT, "127.0.0.1", r));
    for (let i = 0; i < 40; i++) {
        try {
            if ((await fetch(BASE + "/")).ok) break;
        } catch {
            await new Promise((r) => setTimeout(r, 150));
        }
    }
    browser = await launchChromium(true);
}, 30_000);
afterAll(async () => {
    await browser?.close();
    app?.kill();
    fixture?.close();
});

type Call = { tool: string; input: Record<string, unknown> };
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

/** Plays back tool calls one per round; `forever` repeats one call without end. */
function scripted(calls: Call[], forever?: Call) {
    let i = 0;
    const model = new MockLanguageModelV3({
        doGenerate: async () => {
            const next = calls[i++] ?? forever;
            if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
            return { content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
        },
    });
    return { model, rounds: () => i };
}

function ctxFor(model: MockLanguageModelV3, review = "") {
    const events: EngineEvent[] = [];
    const reviews: Array<{ purpose?: string; prompt: string }> = [];
    const ctx: EngineContext = {
        config: loadConfig({}),
        emit: (e) => events.push(e),
        llm: { modelName: "scripted", model, usage: { inputTokens: 0, outputTokens: 0 }, object: async () => ({}) as never, text: async (a) => (reviews.push(a), review) },
    };
    return { ctx, events, reviews };
}

const emptyModel = (url: string): AppModel => ({
    url, origin: url, siteType: "ecommerce", purpose: "demo", features: [], pages: [], navigation: [], apis: [], journeys: [],
    authentication: { required: false, mechanisms: [], loggedIn: false }, externalDependencies: [], documentedTestCases: [],
    stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
});
const scenario = ScenarioSchema.parse({ scenarioId: "S-001", title: "Login succeeds", description: "A registered user logs in", category: "Authentication", startPath: "/login", expectedResults: ["Account page greets the user"], requiresAuth: true });
const creds = { username: "demo@example.com", password: "Password123!" };
const login: Call[] = [
    { tool: "fill", input: { target: { by: "label", value: "Email" }, value: "{{credentials.username}}" } },
    { tool: "fill", input: { target: { by: "label", value: "Password" }, value: "{{credentials.password}}" } },
    { tool: "click", input: { target: { by: "role", role: "button", value: "Log in" } } },
];

describe("authoring: outcome assertions, review, retry, limits", () => {
    it("pushes back a finish that only checks the clicked element, and the agent goes on to assert the outcome", async () => {
        const { model } = scripted([
            { tool: "fill", input: { target: { by: "label", value: "Email" }, value: "x@example.com" } },
            { tool: "assert", input: { check: "visible", target: { by: "label", value: "Email" } } },
            { tool: "finish", input: { result: "complete", explanation: "done" } },
            { tool: "assert", input: { check: "value", target: { by: "label", value: "Email" }, expected: "x@example.com" } },
            { tool: "finish", input: { result: "complete", explanation: "done" } },
        ]);
        const { ctx } = ctxFor(model);
        const actions: Array<{ tool: string; ok: boolean; observation: string }> = [];
        const out = await authorWebSpec({ ctx, browser, baseUrl: BASE, model: emptyModel(BASE), scenario, onAction: (a) => actions.push(a) });
        expect(out.status).toBe("complete");
        expect(actions.find((a) => a.tool === "finish")).toMatchObject({ ok: false, observation: expect.stringMatching(/no assertion on the scenario's expected outcome/) });
        expect(out.steps.filter((s) => s.action === "assert").map((s) => (s as { check: string }).check)).toEqual(["visible", "value"]);
    }, 60_000);

    it("applies the review's fix once by resuming authoring", async () => {
        const { model } = scripted([
            ...login,
            { tool: "assert", input: { check: "url", expected: "/account" } },
            { tool: "finish", input: { result: "complete", explanation: "Logged in" } },
            // The resumed session after the review: the greeting the scenario expects.
            { tool: "assert", input: { check: "visible", target: { by: "role", role: "heading", value: "Welcome, Demo User" } } },
            { tool: "finish", input: { result: "complete", explanation: "Greeting asserted" } },
        ]);
        const { ctx, events, reviews } = ctxFor(model, "- Assert the greeting on the account page");
        const out = await authorWebSpec({ ctx, browser, baseUrl: BASE, model: emptyModel(BASE), scenario, credentials: creds, review: true });
        expect(reviews).toHaveLength(1);
        expect(reviews[0]!.prompt).toContain("Account page greets the user");
        expect(events.some((e) => e.kind === "review_fixes")).toBe(true);
        expect(out.status).toBe("complete");
        expect(out.explanation).toBe("Greeting asserted");
        expect(out.steps.map((s) => s.action)).toEqual(["navigate", "fill", "fill", "click", "assert", "assert"]);
    }, 90_000);

    it("a review that says ok changes nothing", async () => {
        const { model } = scripted([...login, { tool: "assert", input: { check: "url", expected: "/account" } }, { tool: "finish", input: { result: "complete", explanation: "Logged in" } }]);
        const { ctx, events } = ctxFor(model, "OK");
        const out = await authorWebSpec({ ctx, browser, baseUrl: BASE, model: emptyModel(BASE), scenario, credentials: creds, review: true });
        expect(out).toMatchObject({ status: "complete", explanation: "Logged in" });
        expect(events.some((e) => e.kind === "review_fixes")).toBe(false);
    }, 60_000);

    it("retries a blocked scenario once in a fresh browser", async () => {
        const { model } = scripted([
            { tool: "finish", input: { result: "blocked", explanation: "The form did not load" } },
            { tool: "assert", input: { check: "visible", target: { by: "role", role: "heading", value: "Login" } } },
            { tool: "finish", input: { result: "complete", explanation: "Login page shown" } },
        ]);
        const { ctx, events } = ctxFor(model);
        const out = await authorWebSpec({ ctx, browser, baseUrl: BASE, model: emptyModel(BASE), scenario, retryBlocked: true });
        expect(out.status).toBe("complete");
        expect(events.filter((e) => e.kind === "scenario_retry")).toHaveLength(1);

        // Twice blocked: reported as blocked after exactly one retry.
        const twice = scripted([{ tool: "finish", input: { result: "blocked", explanation: "a" } }, { tool: "finish", input: { result: "blocked", explanation: "b" } }]);
        const again = await authorWebSpec({ ctx: ctxFor(twice.model).ctx, browser, baseUrl: BASE, model: emptyModel(BASE), scenario, retryBlocked: true });
        expect(again).toMatchObject({ status: "blocked", explanation: "b" });
        expect(twice.rounds()).toBe(2);
    }, 60_000);

    it("stops at the level's authoring step limit", async () => {
        const limit = LEVEL_SETTINGS.thorough.authoringMaxSteps;
        // An assertion with nothing to check is refused at once: the agent never finishes, so only the step limit ends it.
        const { model, rounds } = scripted([], { tool: "assert", input: { check: "url" } });
        const out = await authorWebSpec({ ctx: ctxFor(model).ctx, browser, baseUrl: BASE, model: emptyModel(BASE), scenario, maxSteps: limit });
        expect(out.status).toBe("blocked");
        expect(rounds()).toBe(limit);
        expect(LEVEL_SETTINGS.deep.authoringMaxSteps).toBeGreaterThan(limit);
    }, 60_000);
});

describe("validation: flaky or broken", () => {
    const spec = (id: string, steps: unknown[]): TestSpec => TestSpecSchema.parse({ testId: id, title: id, kind: "web", category: "Form", source: { origin: "browser-agent" }, steps });
    const fixScenario = ScenarioSchema.parse({ scenarioId: "S-9", title: "Form", description: "Use the form", category: "Form", expectedResults: ["Saved"] });

    it("runs a failing new test once more and says flaky or broken, with the step and a replacement", async () => {
        flakyLoads = 0;
        const flaky = spec("WEB-101", [{ action: "navigate", url: "/flaky" }, { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Done" } }]);
        const broken = spec("WEB-102", [
            { action: "navigate", url: "/broken" },
            { action: "click", locator: { by: "role", role: "button", value: "Save Changes", exact: true } },
            { action: "assert", check: "text", locator: { by: "css", value: "#m" }, expected: "Saved" },
        ]);
        const { ctx } = ctxFor(scripted([]).model);
        const attempts = new Map<string, number>();
        const outcomes = await validateBatch(
            ctx,
            { browser, scratchDir: ctx.config.scratchDir, env: { baseUrl: FIX, headless: true }, render: { baseUrl: FIX }, model: emptyModel(FIX), maxRepairAttempts: 0, confirmFailures: true, workers: 1 },
            [flaky, broken].map((s) => ({ spec: s, framework: "playwright" as const, scenario: fixScenario })),
            { onAttempt: async (t, a) => void attempts.set(t.spec.testId, a), onFinal: async () => undefined },
        );
        const [f, b] = outcomes;
        expect(f!.status).toBe("FAILED_VALIDATION");
        expect(f!.reason).toMatch(/^Flaky: passed 1 of 2 runs/);
        expect(b!.status).toBe("FAILED_VALIDATION");
        expect(b!.reason).toMatch(/^Fails every time at .*Save Changes/);
        expect(b!.reason).toMatch(/likely replacement is .*Save changes/);
        expect(attempts.get("WEB-101")).toBe(2);
        expect(attempts.get("WEB-102")).toBe(2);
    }, 120_000);
});
