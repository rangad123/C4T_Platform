/**
 * A failing check tied to a stated expectation is kept (scripted model double, never a real model, against a local fixture):
 * an assert that cites a source (a rule given to the scenario, or `expected:<n>` for its n-th expected result) and fails is remembered,
 * and when the agent then finishes with "defect" it becomes the saved test's last step, so the saved test fails on the app with the bug
 * and passes on the app without it. Without such a check the defect is "observed only". A source the scenario was not given is
 * refused and nothing is recorded; a failing assert without a source stays unrecorded, as before.
 */
import http from "node:http";
import { MockLanguageModelV3 } from "ai/test";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import { BrowserSession, launchChromium, settle } from "../src/engine/discovery/browser.js";
import type { KnowledgeRule } from "../src/engine/planning/planner.js";
import { ScenarioSchema, TestSpecSchema, type Step } from "../src/engine/spec/schema.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { executeStep, runtimeData } from "../src/engine/web/interpreter.js";
import { authorWebSpec, pruneByReplay, toSpec } from "../src/engine/web/author.js";

const PORT = 9800;
const BASE = `http://127.0.0.1:${PORT}`;
/** The seeded app shows a wrong total (10 + 15 = 30); the fixed one the right one. */
let seeded = true;
let server: http.Server;
let browser: Browser;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        // /recalc shows the wrong total until "Recalculate" is pressed.
        if (req.url === "/recalc") return void res.end(`<!doctype html><title>Cart</title><h1>Cart</h1><p>Total: <output aria-label="Total">$30.00</output></p><button onclick="document.querySelector('output').textContent='$25.00'">Recalculate</button>`);
        res.end(`<!doctype html><title>Cart</title><h1>Cart</h1><ul><li>Mug $10.00</li><li>Plate $15.00</li></ul><p>Total: <output id="total" aria-label="Total">${seeded ? "$30.00" : "$25.00"}</output></p>`);
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
/** The defect verdict reviews answer "yes" (a real bug), so the outcome stays a defect. */
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
const scenario = ScenarioSchema.parse({ scenarioId: "S-CART", title: "Cart total", description: "The cart adds up its lines", category: "Cart", startPath: "/cart", expectedResults: ["The cart page is shown", "The total is $25.00"] });
const RULE: KnowledgeRule = { ref: "R-TOTAL", kind: "constraint" as KnowledgeRule["kind"], description: "The total is the sum of the line prices", expected: "Total = sum of lines", explicitness: "explicit", status: "unverified", workflows: [] };
const totalLocator = { by: "role", role: "status", value: "Total" };
const heading: Call = { tool: "assert", input: { check: "visible", target: { by: "role", role: "heading", value: "Cart" }, source: "expected:1" } };
const finishDefect: Call = { tool: "finish", input: { result: "defect", explanation: "The total shows $30.00, not $25.00" } };

/** Replays saved steps in a fresh browser, as a saved test runs: true when every step passed. */
async function replays(steps: Step[]): Promise<boolean> {
    const session = await BrowserSession.launch(browser, { startUrl: BASE });
    session.page.setDefaultTimeout(3_000);
    try {
        const data = runtimeData({});
        for (const step of steps) {
            await executeStep(session.page, step, data, BASE, 3_000);
            await settle(session.page, 500);
        }
        return true;
    } catch {
        return false;
    } finally {
        await session.close();
    }
}

describe("authoring keeps a failing sourced check", () => {
    it("ends the defect test with the failing sourced assert, which fails on the seeded app and passes on the fixed one", async () => {
        seeded = true;
        const actions: Array<{ tool: string; ok: boolean; observation: string }> = [];
        const out = await authorWebSpec({
            ctx: ctxFor(scripted([heading, { tool: "assert", input: { check: "exactText", target: totalLocator, expected: "$25.00", source: "R-TOTAL" } }, finishDefect])),
            browser, baseUrl: BASE, model: emptyModel, scenario, rules: [RULE], onAction: (a) => actions.push(a),
        });
        expect(out.status).toBe("defect");
        expect(out).toMatchObject({ capture: "captured" });
        const last = out.steps.at(-1)!;
        expect(last).toMatchObject({ action: "assert", check: "exactText", expected: "$25.00", source: "R-TOTAL" });
        expect(out.steps.filter((s) => s.action === "assert")).toHaveLength(2);
        // What the app showed instead is kept with the check (masked, one line).
        expect(out.status === "defect" && out.capturedCheck).toMatchObject({ source: "R-TOTAL", observed: expect.stringContaining("$30.00") });

        const spec = TestSpecSchema.parse(toSpec(scenario, out, "WEB-900"));
        expect(spec.steps.at(-1)).toMatchObject({ source: "R-TOTAL" });
        expect(await replays(spec.steps)).toBe(false);
        seeded = false;
        expect(await replays(spec.steps)).toBe(true);
        seeded = true;
    }, 90_000);

    it("accepts expected:<n> for one of the scenario's expected results", async () => {
        const out = await authorWebSpec({
            ctx: ctxFor(scripted([heading, { tool: "assert", input: { check: "exactText", target: totalLocator, expected: "$25.00", source: "expected:2" } }, finishDefect])),
            browser, baseUrl: BASE, model: emptyModel, scenario,
        });
        expect(out).toMatchObject({ status: "defect", capture: "captured" });
        expect(out.steps.at(-1)).toMatchObject({ check: "exactText", source: "expected:2" });
        expect(out.steps[1]).toMatchObject({ check: "visible", source: "expected:1" });
    }, 90_000);

    it("refuses a source the scenario was not given, with a sentence, and records nothing", async () => {
        const actions: Array<{ tool: string; ok: boolean; observation: string }> = [];
        const out = await authorWebSpec({
            ctx: ctxFor(scripted([
                heading,
                { tool: "assert", input: { check: "exactText", target: totalLocator, expected: "$25.00", source: "R-OTHER" } },
                { tool: "assert", input: { check: "exactText", target: totalLocator, expected: "$25.00", source: "expected:3" } },
                finishDefect,
            ])),
            browser, baseUrl: BASE, model: emptyModel, scenario, rules: [RULE], onAction: (a) => actions.push(a),
        });
        const refused = actions.filter((a) => a.tool === "assert" && !a.ok);
        expect(refused).toHaveLength(2);
        for (const r of refused) expect(r.observation).toMatch(/^The source .* is not a rule given to this scenario nor one of its expected results/);
        expect(out).toMatchObject({ status: "defect", capture: "observed_only" });
        expect(out.steps.map((s) => s.action)).toEqual(["navigate", "assert"]);
    }, 90_000);

    it("keeps a failing assert without a source unrecorded, and the defect is observed only", async () => {
        const out = await authorWebSpec({
            ctx: ctxFor(scripted([heading, { tool: "assert", input: { check: "exactText", target: totalLocator, expected: "$25.00" } }, finishDefect])),
            browser, baseUrl: BASE, model: emptyModel, scenario, rules: [RULE],
        });
        expect(out).toMatchObject({ status: "defect", capture: "observed_only" });
        expect(out.steps.map((s) => s.action)).toEqual(["navigate", "assert"]);
    }, 90_000);

    it("failed, then more actions: the saved defect test ends at the failing check, where it failed", async () => {
        seeded = true;
        const out = await authorWebSpec({
            ctx: ctxFor(scripted([
                heading,
                { tool: "assert", input: { check: "exactText", target: totalLocator, expected: "$25.00", source: "R-TOTAL" } },
                // The agent goes on after the check failed: to another page, where it checks something that passes.
                { tool: "navigate", input: { url: "/recalc" } },
                { tool: "assert", input: { check: "visible", target: { by: "role", role: "button", value: "Recalculate" } } },
                finishDefect,
            ])),
            browser, baseUrl: BASE, model: emptyModel, scenario, rules: [RULE],
        });
        expect(out).toMatchObject({ status: "defect", capture: "captured" });
        // The steps after the failing check are dropped: the test is what ran up to the check, then the check.
        expect(out.steps.map((s) => s.action)).toEqual(["navigate", "assert", "assert"]);
        expect(out.steps.at(-1)).toMatchObject({ check: "exactText", expected: "$25.00", source: "R-TOTAL" });
        const spec = TestSpecSchema.parse(toSpec(scenario, out, "WEB-901"));
        expect(await replays(spec.steps)).toBe(false);
        seeded = false;
        expect(await replays(spec.steps)).toBe(true);
        seeded = true;
    }, 90_000);

    it("does not append a sourced check that failed once and then passed", async () => {
        const check = { check: "exactText", target: totalLocator, expected: "$25.00", source: "R-TOTAL" };
        const out = await authorWebSpec({
            ctx: ctxFor(scripted([
                { tool: "assert", input: check },
                { tool: "click", input: { target: { by: "role", role: "button", value: "Recalculate" } } },
                { tool: "assert", input: check },
                { tool: "finish", input: { result: "defect", explanation: "The total was wrong until recalculated" } },
            ])),
            browser, baseUrl: BASE, model: emptyModel, scenario: { ...scenario, startPath: "/recalc" }, rules: [RULE],
        });
        expect(out).toMatchObject({ status: "defect", capture: "observed_only" });
        expect(out.steps.map((s) => s.action)).toEqual(["navigate", "click", "assert"]);
    }, 90_000);
});

describe("stored tests and pruning", () => {
    it("a stored spec and a scenario without the new fields still parse; the new fields parse when present", () => {
        const old = TestSpecSchema.parse({ testId: "WEB-001", title: "Old test", kind: "web", category: "c", source: { origin: "browser-agent" }, steps: [{ action: "assert", check: "visible", locator: { by: "text", value: "x" } }] });
        expect(old.steps[0]).not.toHaveProperty("source");
        const sourced = TestSpecSchema.parse({ ...old, steps: [{ action: "assert", check: "visible", locator: { by: "text", value: "x" }, source: "expected:1" }] });
        expect(sourced.steps[0]).toMatchObject({ source: "expected:1" });
        expect(ScenarioSchema.parse({ scenarioId: "S", title: "t", description: "d", category: "c", expectedResults: ["x"] })).not.toHaveProperty("objective");
        const withObjective = ScenarioSchema.parse({ scenarioId: "S", title: "t", description: "d", category: "c", expectedResults: ["x"], objective: { id: "obj-1", kind: "rule", source: "R-TOTAL", operator: "double-submit" } });
        expect(withObjective.objective).toEqual({ id: "obj-1", kind: "rule", source: "R-TOTAL", operator: "double-submit" });
        expect(() => ScenarioSchema.parse({ scenarioId: "S", title: "t", description: "d", category: "c", expectedResults: ["x"], objective: { id: "obj-1", kind: "nonsense", source: "R" } })).toThrow();
    });

    it("pruneByReplay drops a stale action and keeps the final failing sourced assert", async () => {
        seeded = true;
        const steps = TestSpecSchema.parse({
            testId: "WEB-002", title: "Pruned test", kind: "web", category: "c", source: { origin: "browser-agent" },
            steps: [
                { action: "navigate", url: "/cart" },
                { action: "click", locator: { by: "role", role: "button", value: "Gone already" } },
                { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Cart" } },
                { action: "assert", check: "exactText", locator: totalLocator, expected: "$25.00", source: "R-TOTAL" },
            ],
        }).steps;
        const pruned = await pruneByReplay(browser, BASE, steps, undefined, false);
        expect(pruned.dropped).toBe(1);
        expect(pruned.steps.map((s) => s.action)).toEqual(["navigate", "assert", "assert"]);
        expect(pruned.steps.at(-1)).toMatchObject({ source: "R-TOTAL" });
    }, 60_000);
});
