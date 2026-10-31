/**
 * Tests the *plumbing* of the LLM authoring agent with a scripted model double (AI SDK's
 * MockLanguageModelV3): tool schemas, live execution against a real browser, step recording,
 * failed-action handling, the mandatory-assertion rule, repair-resume, and spec → script → pass.
 * It does NOT test model quality — that needs real credentials (scripts/e2e.ts).
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import { launchChromium } from "../src/engine/discovery/browser.js";
import { renderScript } from "../src/engine/generators/index.js";
import { ScenarioSchema, TestSpecSchema } from "../src/engine/spec/schema.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { runScripts } from "../src/engine/validation/runner.js";
import { authorWebSpec, pruneByReplay, toSpec } from "../src/engine/web/author.js";

const PORT = 5073;
const BASE = `http://127.0.0.1:${PORT}`;
let app: ChildProcess;
let browser: Browser;

beforeAll(async () => {
    app = spawn(process.execPath, [path.join(REPO_ROOT, "examples/sample-app/server.mjs"), String(PORT)], { stdio: "ignore" });
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
});

type Call = { tool: string; input: Record<string, unknown> };

/** A model double that plays back a fixed list of tool calls, one per generate round. */
function scripted(calls: Call[]) {
    let i = 0;
    const seen: string[] = [];
    const model = new MockLanguageModelV3({
        doGenerate: async (options) => {
            const next = calls[i++];
            seen.push(JSON.stringify(options.prompt).slice(-300));
            if (!next) {
                return {
                    content: [{ type: "text" as const, text: "done" }],
                    finishReason: { unified: "stop" as const, raw: "stop" },
                    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
                    warnings: [],
                };
            }
            return {
                content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: next.tool, input: JSON.stringify(next.input) }],
                finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
                usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
                warnings: [],
            };
        },
    });
    return { model, seen };
}

const ctxFor = (model: MockLanguageModelV3): EngineContext => ({
    config: loadConfig({}),
    emit: () => undefined,
    llm: { modelName: "scripted", model, usage: { inputTokens: 0, outputTokens: 0 }, object: async () => ({}) as never, text: async () => "" },
});

const emptyModel: AppModel = {
    url: BASE, origin: BASE, siteType: "ecommerce", purpose: "demo", features: [], pages: [], navigation: [], apis: [], journeys: [],
    authentication: { required: true, mechanisms: [], loggedIn: false }, externalDependencies: [], documentedTestCases: [],
    stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
};

const scenario = ScenarioSchema.parse({
    scenarioId: "S-001",
    title: "Login succeeds with valid credentials",
    description: "A registered user logs in",
    category: "Authentication",
    priority: "critical",
    startPath: "/login",
    expectedResults: ["Account page greets the user"],
    requiresAuth: true,
});
const creds = { username: "demo@example.com", password: "Password123!" };

describe("authoring agent plumbing", () => {
    it("records only working steps, enforces assertions, and yields a spec that validates", async () => {
        const { model } = scripted([
            { tool: "fill", input: { target: { by: "label", value: "Email" }, value: "{{credentials.username}}" } },
            { tool: "click", input: { target: { by: "role", role: "button", value: "Nonexistent" } } }, // fails → must NOT be recorded
            { tool: "fill", input: { target: { by: "label", value: "Password" }, value: "{{credentials.password}}" } },
            { tool: "click", input: { target: { by: "role", role: "button", value: "Log in" } } },
            { tool: "assert", input: { check: "visible", target: { by: "role", role: "heading", value: "Welcome, Demo User" } } },
            { tool: "assert", input: { check: "url", expected: "/account" } },
            { tool: "finish", input: { result: "complete", explanation: "Logged in" } },
        ]);
        const actions: Array<{ tool: string; ok: boolean }> = [];
        const out = await authorWebSpec({ ctx: ctxFor(model), browser, baseUrl: BASE, model: emptyModel, scenario, credentials: creds, onAction: (a) => actions.push({ tool: a.tool, ok: a.ok }) });

        expect(out.status).toBe("complete");
        expect(actions.filter((a) => !a.ok)).toHaveLength(1);
        expect(out.steps.map((s) => s.action)).toEqual(["navigate", "fill", "fill", "click", "assert", "assert"]);
        // secrets stay symbolic in the recorded spec
        expect(JSON.stringify(out.steps)).not.toContain("Password123!");
        expect(JSON.stringify(out.steps)).toContain("{{credentials.password}}");

        const spec = TestSpecSchema.parse(toSpec(scenario, out, "WEB-001"));
        const script = renderScript(spec, "playwright", { baseUrl: BASE });
        const [run] = await runScripts(loadConfig({}).scratchDir, [{ testId: spec.testId, filename: script.filename, content: script.content }], { baseUrl: BASE, credentials: creds, headless: true });
        expect(run!.status, run!.error).toBe("passed");
    }, 90_000);

    it("refuses to call a test complete when nothing was asserted", async () => {
        const { model } = scripted([
            { tool: "fill", input: { target: { by: "label", value: "Email" }, value: "x@example.com" } },
            { tool: "finish", input: { result: "complete", explanation: "done" } },
        ]);
        const out = await authorWebSpec({ ctx: ctxFor(model), browser, baseUrl: BASE, model: emptyModel, scenario });
        expect(out.status).toBe("blocked");
        expect(out.explanation).toMatch(/without recording any assertion/);
    }, 60_000);

    it("does not record a failing assertion and reports a defect when the model says so", async () => {
        const { model } = scripted([
            { tool: "assert", input: { check: "visible", expected: "Text that is not on the page" } },
            { tool: "finish", input: { result: "defect", explanation: "Expected banner is missing" } },
        ]);
        const out = await authorWebSpec({ ctx: ctxFor(model), browser, baseUrl: BASE, model: emptyModel, scenario });
        expect(out.status).toBe("defect");
        expect(out.steps.some((s) => s.action === "assert")).toBe(false);
    }, 60_000);

    it("resumes from a replayed prefix when repairing", async () => {
        const { model } = scripted([
            { tool: "click", input: { target: { by: "role", role: "button", value: "Log in" } } },
            { tool: "assert", input: { check: "url", expected: "/account" } },
            { tool: "finish", input: { result: "complete", explanation: "fixed" } },
        ]);
        const prefix = TestSpecSchema.parse({
            testId: "WEB-009", title: "prefix", kind: "web",
            steps: [
                { action: "navigate", url: "/login" },
                { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}" },
                { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" },
            ],
        }).steps;
        const out = await authorWebSpec({ ctx: ctxFor(model), browser, baseUrl: BASE, model: emptyModel, scenario, credentials: creds, resume: { prefix, failure: "Failed step: 4. Click button 'Sign in'" } });
        expect(out.status).toBe("complete");
        expect(out.steps.map((s) => s.action)).toEqual(["navigate", "fill", "fill", "click", "assert"]);
    }, 60_000);
});

describe("stale-step pruning", () => {
    const login = [
        { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}" },
        { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" },
        { action: "click", locator: { by: "role", role: "button", value: "Log in" } },
    ];
    // Shape of the real WEB-008 failure: a leftover second login sequence after the first one succeeded.
    const stale = TestSpecSchema.parse({
        testId: "WEB-020",
        title: "Login with a leftover duplicate",
        kind: "web",
        steps: [{ action: "navigate", url: "/login" }, ...login, ...login, { action: "assert", check: "url", expected: "/account" }],
    }).steps;

    it("drops leftover steps that fail on a clean replay and keeps the test intact", async () => {
        const r = await pruneByReplay(browser, BASE, stale, creds, true);
        expect(r.dropped).toBe(3);
        expect(r.steps.map((s) => s.action)).toEqual(["navigate", "fill", "fill", "click", "assert"]);
    }, 60_000);

    it("keeps the original steps when pruning would hide a failing assertion", async () => {
        const broken = [...stale.slice(0, 4), { action: "assert", check: "visible", expected: "Text that never appears" }] as typeof stale;
        const r = await pruneByReplay(browser, BASE, broken, creds, true);
        expect(r.dropped).toBe(0);
        expect(r.steps).toBe(broken);
    }, 60_000);
});
