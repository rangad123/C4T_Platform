/**
 * The objective stage of an exploration (testing-engine Phase 3, P3-19), with a scripted model double (never a real model):
 *   - without a browser: each operator of an objective is its own pursuit (its fingerprint includes the operator, so the loop does not
 *     skip the second as a duplicate); a data-changing operator is skipped with "data changes off" unless the server allows it and the
 *     run allows data changes; every level's session budgets sit inside its own limits; the gated AI client counts each call and refuses
 *     one once a budget is spent; the action tracker tells a double submit from a repeat;
 *   - a real browser on a local shop with two seeded defects (tests/fixtures/objectives-shop.ts, port 9853): both become captured
 *     candidate findings whose saved steps replay red on the seeded shop and green on the fixed one; the session ends with a stop reason;
 *     the data-changing operator is skipped; with objectives off the job's events are what they are without the stage at all.
 * Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/explore-objectives-run.test.ts
 */
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT_LIMITS } from "../src/engine/agent/objective.js";
import { CandidateFindingSchema } from "../src/engine/explore/finding.js";
import { checkIndependence } from "../src/engine/explore/independence.js";
import { runExploration, type ActionLogRow } from "../src/engine/explore/loop.js";
import { SKIP_REASONS } from "../src/engine/explore/perturb.js";
import { LEVEL_SETTINGS, LEVELS } from "../src/engine/levels.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { actionTracker, boundedActionLog, coverageModelOf, ExplorationStopped, gatedLlm, objectivePursuits } from "../src/engine/orchestrator.js";
import { COMPLIANT, exploreShop, scriptedShopModel, shopKnowledge, startShop, type ShopSite } from "./fixtures/objectives-shop.js";

const thorough = LEVEL_SETTINGS.thorough;
const pursuitsOf = (dataOperators: boolean) =>
    objectivePursuits(shopKnowledge(), { maxObjectives: thorough.exploration.objectives, steps: thorough.authoringMaxSteps, perObjective: thorough.exploration.perObjective, dataOperators, requiresAuth: false });

describe("objective pursuits, budgets and bounds (no browser)", () => {
    it("each operator of an objective is a pursuit of its own, and the loop pursues both", async () => {
        const { objectives, pursuits } = pursuitsOf(true);
        const constraint = objectives.find((o) => o.kind === "constraint")!;
        const own = pursuitsOf(true).pursuits.filter((p) => p.objective.id === constraint.id);
        expect(own.map((p) => p.operator)).toEqual(["invalid_input", "boundary_input"]);
        expect(new Set(pursuits.map((p) => p.fingerprint)).size).toBe(pursuits.length);
        const ran: string[] = [];
        const r = await runExploration({
            objectives: own,
            budgets: { objectives: 10, actions: 10, aiCalls: 10, tokens: 10, minutes: 1, depth: 2 },
            runObjective: async (p) => (ran.push(p.operator), { status: "completed" }),
            now: () => 0,
            usage: () => ({ aiCalls: 0, tokens: 0 }),
            reset: async () => undefined,
        });
        expect(ran).toEqual(["invalid_input", "boundary_input"]);
        expect(r.outcomes.map((o) => [o.objectiveId, o.status])).toEqual([
            [`${constraint.id}:invalid_input`, "completed"],
            [`${constraint.id}:boundary_input`, "completed"],
        ]);
    });

    it("a data-changing operator is skipped with 'data changes off' unless data operators are allowed", () => {
        const off = pursuitsOf(false);
        const constraint = off.objectives.find((o) => o.kind === "constraint")!;
        expect(off.skipped).toEqual([{ objectiveId: constraint.id, operator: "boundary_input", reason: SKIP_REASONS.dataOff }]);
        expect(off.pursuits.map((p) => p.operator).sort()).toEqual(["as_stated", "invalid_input"]);
        expect(pursuitsOf(true).skipped).toEqual([]);
    });

    it("the job keeps the first 2,000 rows of the action log and counts the rows it left out", () => {
        const row = (seq: number): ActionLogRow => ({ seq, objectiveId: "OBJ-1:as_stated", state: "/cart|", action: `click ${seq}`, atMs: seq, result: "performed" });
        const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i + 1));
        const big = boundedActionLog(rows(2_345));
        expect(big.actionLog).toHaveLength(2_000);
        expect([big.actionLog[0]!.seq, big.actionLog.at(-1)!.seq]).toEqual([1, 2_000]);
        expect(big.actionLogOmitted).toBe(345);
        expect(boundedActionLog(rows(2_000))).toEqual({ actionLog: rows(2_000), actionLogOmitted: 0 });
        expect(boundedActionLog([])).toEqual({ actionLog: [], actionLogOmitted: 0 });
    });

    it("coverage reads the crawled pages with their named elements, the objective pages by id, the endpoints and the knowledge's workflow steps", () => {
        const k = shopKnowledge();
        k.objectiveInputs!.workflowSteps = [{ workflowId: "WF-1", steps: [{ order: 1, action: "Order one", page: "page-order", endpoint: "POST /api/order" }] }];
        k.objectiveInputs!.transitions = [{ entity: "order", from: "new", to: "paid", trigger: "pay", sourceType: "requirement", expectation: true, evidence: [] }];
        const page = (path: string, components: Array<{ role: string; name: string }>) => ({ path, components }) as never;
        const m = coverageModelOf(
            { pages: [page("/cart", [{ role: "status", name: "Total" }]), page("/order", [{ role: "button", name: "Order" }])] } as never,
            k.objectiveInputs!,
            [{ method: "POST", path: "/api/order" }] as never,
        );
        expect(m.pages).toEqual([
            { id: "/cart", path: "/cart", elements: [{ role: "status", name: "Total" }] },
            { id: "page-order", path: "/order", elements: [{ role: "button", name: "Order" }] },
        ]);
        expect(m.endpoints).toEqual([{ method: "POST", path: "/api/order" }]);
        expect(m.workflows).toEqual([{ id: "WF-1", steps: [{ order: 1, action: "Order one", page: "page-order", endpoint: "POST /api/order" }] }]);
        expect(m.transitions).toEqual([{ entity: "order", from: "new", to: "paid" }]);
    });

    it("every level's session budgets sit inside its own limits; thorough pursues at most 25 objectives", () => {
        expect(thorough.exploration.objectives).toBeLessThanOrEqual(25);
        for (const level of LEVELS) {
            const s = LEVEL_SETTINGS[level];
            const e = s.exploration;
            expect(e.aiCalls, level).toBeLessThanOrEqual(s.maxScenarios * s.authoringMaxSteps);
            expect(e.objectives, level).toBeLessThanOrEqual(500);
            expect(e.perObjective.tokens).toBeLessThanOrEqual(AGENT_LIMITS.tokens.max);
            expect(e.perObjective.minutes).toBeLessThanOrEqual(AGENT_LIMITS.minutes.max);
            expect(s.authoringMaxSteps).toBeLessThanOrEqual(AGENT_LIMITS.steps.max);
            for (const v of [e.objectives, e.actions, e.aiCalls, e.tokens, e.minutes, e.depth]) expect(Number.isFinite(v) && v >= 1).toBe(true);
        }
    });

    it("the gated client counts every call and refuses one once the gate says the budget is spent", async () => {
        const { llm } = scriptedShopModel(() => ({}));
        let calls = 0;
        const gated: LlmClient = gatedLlm(llm, () => {
            if (calls >= 1) throw new ExplorationStopped("spent");
            calls++;
        });
        expect(await gated.text({ system: "s", prompt: "p" })).toBe("yes");
        await expect(gated.text({ system: "s", prompt: "p" })).rejects.toThrow("spent");
        expect(calls).toBe(1);
        expect(gated.usage).toBe(llm.usage);
    });

    it("the action tracker: a double submit is two states, the same action again on that state is a repeat", () => {
        const track = actionTracker("http://shop.test/order");
        const click = { tool: "click", args: { by: "role", value: "Order" }, ok: true, observation: "url=http://shop.test/order" };
        const fill = (value: string) => ({ tool: "fill", args: { target: { by: "label", value: "Quantity" }, value }, ok: true, observation: "url=http://shop.test/order" });
        const a = [track(fill("0")), track(click), track(click), track(click)];
        expect(a[1]!.state).not.toBe(a[2]!.state);
        expect(a[3]).toEqual(a[2]);
        // A different value typed before the same submit is a new state.
        const b = actionTracker("http://shop.test/order");
        const c = [b(fill("0")), b(click), b(fill("11")), b(click)];
        expect(c[1]!.state).not.toBe(c[3]!.state);
        expect(c[0]!.state.startsWith("/order|")).toBe(true);
    });
});

const PORT = 9853;
let site: ShopSite;
let browser: Browser;

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = await startShop(PORT);
    browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
    await browser?.close();
    site?.server.close();
});

describe("exploring the seeded shop by objectives", () => {
    it("both seeded defects become captured candidate findings that replay red on the seeded shop and green on the fixed one", async () => {
        site.fixed = false;
        const { llm, calls } = scriptedShopModel(() => COMPLIANT);
        const { summary, events, tests } = await exploreShop(site, llm, { objectives: true });

        // The session: one stop reason, every pursuit run, the data-changing operator skipped.
        const ex = summary.exploration!;
        expect(ex.stopReason).toBe("objectives_done");
        expect(events.filter((e) => e.kind === "exploration_stopped")).toHaveLength(1);
        expect(ex.budgets).toEqual({ objectives: 25, actions: 750, aiCalls: 750, tokens: 7_500_000, minutes: 90, depth: 8, steps: 30 });
        expect(ex.skipped).toEqual([{ objectiveId: expect.stringMatching(/^OBJ-/), operator: "boundary_input", reason: "data changes off" }]);
        expect(ex.outcomes.map((o) => o.status)).toEqual(["completed", "completed"]);
        expect(ex.usage.aiCalls).toBe(calls.filter((c) => !c.startsWith("object:")).length);
        expect(ex.usage.actions).toBe(5);
        // The action log (every row, under the 2,000-row cap) and the coverage record built from it and the saved tests.
        expect(ex.actionLog.filter((r) => r.result === "performed")).toHaveLength(5);
        expect(ex.actionLogOmitted).toBe(0);
        expect(ex.coverage.rules).toMatchObject({ total: 1, exercised: 1 });
        expect(ex.coverage.inputClasses).toMatchObject({ exercised: 1, notExercised: ["page-order/order/qty boundary_input"] });
        expect(ex.coverage.pages.notExercised).not.toContain("/cart");
        expect(ex.coverage.pages.notExercised).not.toContain("/order");
        expect(ex.coverage.notRun).toContainEqual({ objectiveId: ex.skipped[0]!.objectiveId, operator: "boundary_input", reason: "data changes off" });
        expect(ex.coverage.unexplored).toEqual([]);

        // Two defect tests for review, each carrying a captured finding tied to its objective and operator.
        expect(tests.map((t) => t.validation)).toEqual(["NEEDS_REVIEW", "NEEDS_REVIEW"]);
        const findings = tests.map((t) => CandidateFindingSchema.parse(t.meta.finding));
        expect(findings.map((f) => [f.objective?.kind, f.objective?.operator, f.expected.source, f.capture, f.independence, f.confidence]).sort()).toEqual([
            ["constraint", "invalid_input", "expected:1", "captured", "independent", "high"],
            ["rule", "as_stated", "R-TOTAL", "captured", "independent", "high"],
        ]);
        expect(findings.find((f) => f.objective?.kind === "rule")!.expected.text).toBe("The total equals the sum of the lines: $25.00");
        expect(findings.every((f) => f.modelVersion === "mv-shop-1")).toBe(true);
        // Every expected result keeps its stated source end to end: the scenario cites the objective's ref, in its objective and in
        // the expected text, and the constraint's finding states that text (not a model-written expectation).
        for (const t of tests) {
            const sc = t.meta.scenario as { objective: { source: string }; expectedResults: string[] };
            expect(["R-TOTAL", "page-order/order/qty"]).toContain(sc.objective.source);
            expect(sc.expectedResults).toEqual([expect.stringMatching(new RegExp(`\\(source: ${sc.objective.source}\\)$`))]);
        }
        expect(findings.find((f) => f.objective?.kind === "constraint")!.expected.text).toBe(
            'The field "Quantity" accepts a value only when the value must be a valid number; at least 1; at most 10; any other value is refused. (source: page-order/order/qty)',
        );

        // Each saved test fails on the seeded shop and passes once the defect is fixed (no AI).
        for (const t of tests) {
            const seeded = await checkIndependence(browser, site.url, { steps: t.spec.steps });
            expect(seeded.replays.map((r) => r.outcome), t.spec.title).toEqual(["failed", "failed"]);
        }
        site.fixed = true;
        try {
            for (const t of tests) {
                const fixed = await checkIndependence(browser, site.url, { steps: t.spec.steps });
                expect(fixed.replays.map((r) => r.outcome), t.spec.title).toEqual(["passed", "passed"]);
            }
        } finally {
            site.fixed = false;
        }
    }, 300_000);

    it("a pursuit whose steps do not apply its operator saves nothing and says so", async () => {
        site.fixed = false;
        // The invalid-input pursuit types an allowed value: the operator was not applied.
        const notApplied = { ...COMPLIANT, "Invalid input": COMPLIANT["Invalid input"]!.map((c) => (c.tool === "fill" ? { ...c, input: { ...c.input, value: "5" } } : c)) };
        const { llm } = scriptedShopModel(() => notApplied);
        const { summary, events, tests } = await exploreShop(site, llm, { objectives: true });
        expect(tests.map((t) => (t.meta.finding as { objective: { operator: string } }).objective.operator)).toEqual(["as_stated"]);
        expect(events.filter((e) => e.kind === "operator_not_applied").map((e) => e.message)).toEqual([expect.stringContaining('the recorded steps do not apply the operator "invalid_input"')]);
        expect(summary.exploration!.outcomes.find((o) => o.objectiveId.endsWith(":invalid_input"))!.result).toMatchObject({ applied: false });
    }, 300_000);

    it("with objectives off the job is what it is without the stage: the same events, no exploration, no test-writer call", async () => {
        site.fixed = false;
        const strip = (e: { kind: string; message: string }) => ({ kind: e.kind, message: e.message });
        const runs = [];
        for (const extra of [{ objectives: false }, {}, { appKnowledge: undefined }]) {
            const { llm, calls } = scriptedShopModel(() => COMPLIANT);
            const r = await exploreShop(site, llm, extra);
            runs.push({ ...r, calls });
        }
        for (const r of runs) {
            expect(r.summary.exploration).toBeUndefined();
            expect(r.tests).toEqual([]);
            expect(r.calls).toEqual(["object:analysis"]);
            expect(r.events.some((e) => /objective|exploration_stopped/.test(e.kind))).toBe(false);
        }
        expect(runs[0]!.events.map(strip)).toEqual(runs[1]!.events.map(strip));
        expect(runs[0]!.events.map(strip)).toEqual(runs[2]!.events.map(strip));
    }, 300_000);
});
