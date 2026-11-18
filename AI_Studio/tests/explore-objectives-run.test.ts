/**
 * The objective stage of an exploration (testing-engine Phase 3, P3-19), with a scripted model double (never a real model):
 *   - without a browser: each operator of an objective is its own pursuit (its fingerprint includes the operator, so the loop does not
 *     skip the second as a duplicate); a data-changing operator is skipped with "data changes off" (naming the setting) unless the server allows it and the
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
import { COMPLIANT, exploreShop, OBJECTIVES_WITH_DATA, scriptedShopModel, shopKnowledge, startShop, type ShopSite } from "./fixtures/objectives-shop.js";

const thorough = LEVEL_SETTINGS.thorough;
const pursuitsOf = (dataOperators: boolean, dataChanges = dataOperators) =>
    objectivePursuits(shopKnowledge(), { maxObjectives: thorough.exploration.objectives, steps: thorough.authoringMaxSteps, perObjective: thorough.exploration.perObjective, dataChanges, dataOperators, requiresAuth: false });

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

    it("a data-changing operator, the form-submitting as stated and invalid input among them, is skipped with 'data changes off' unless data operators are allowed", () => {
        const off = pursuitsOf(false);
        const constraint = off.objectives.find((o) => o.kind === "constraint")!;
        const rule = off.objectives.find((o) => o.kind === "rule")!;
        expect(off.skipped).toEqual([
            { objectiveId: rule.id, operator: "as_stated", reason: SKIP_REASONS.dataOff },
            { objectiveId: constraint.id, operator: "invalid_input", reason: SKIP_REASONS.dataOff },
            { objectiveId: constraint.id, operator: "boundary_input", reason: SKIP_REASONS.dataOff },
        ]);
        expect(off.pursuits).toEqual([]);
        // The project allows data changes, the server does not: the form-submitting ones run, the boundary value says the server's setting is off.
        const project = pursuitsOf(false, true);
        expect(project.pursuits.map((p) => p.operator).sort()).toEqual(["as_stated", "invalid_input"]);
        expect(project.skipped).toEqual([{ objectiveId: constraint.id, operator: "boundary_input", reason: SKIP_REASONS.serverDataOff }]);
        const on = pursuitsOf(true);
        expect(on.skipped).toEqual([]);
        expect(on.pursuits.map((p) => p.operator).sort()).toEqual(["as_stated", "boundary_input", "invalid_input"]);
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
        const url = "http://shop.test/order";
        /** Asked before, told after (CP2 H-2): what the loop is asked for one action that runs. */
        const step = (t: ReturnType<typeof actionTracker>, a: { tool: string; args: unknown; target?: string; read?: boolean }) => {
            const asked = t.before({ ...a, url });
            t.after({ ...a, ok: true, url });
            return asked;
        };
        const click = { tool: "click", args: { by: "role", value: "Order" } };
        const fill = (value: string) => ({ tool: "fill", args: { target: { by: "label", value: "Quantity" }, value } });
        const a = [step(track, fill("0")), step(track, click), step(track, click), step(track, click)];
        expect(a[1]!.state).not.toBe(a[2]!.state);
        expect(a[3]).toEqual(a[2]);
        // A different value typed before the same submit is a new state.
        const b = actionTracker(url);
        const c = [step(b, fill("0")), step(b, click), step(b, fill("11")), step(b, click)];
        expect(c[1]!.state).not.toBe(c[3]!.state);
        expect(c[0]!.state.startsWith("/order|")).toBe(true);
    });

    it("the action tracker keys an action by the element it resolves to, not by the locator's spelling (CP2 M-1)", () => {
        const t = actionTracker("http://shop.test/cart");
        const url = "http://shop.test/cart";
        const target = 'button "Continue" @0123456789ab';
        const one = t.before({ tool: "click", args: { by: "css", value: "form button" }, target, url });
        const two = t.before({ tool: "click", args: { by: "role", role: "button", value: "Continue" }, target, url });
        expect(two.action).toBe(one.action);
        expect(one.action).not.toContain("form button");
        // The value typed stays part of a fill's key; its locator's spelling does not.
        const f1 = t.before({ tool: "fill", args: { target: { by: "label", value: "Qty" }, value: "5" }, target: 'spinbutton "Qty" @aa', url });
        const f2 = t.before({ tool: "fill", args: { target: { by: "css", value: "input[name=qty]" }, value: "5" }, target: 'spinbutton "Qty" @aa', url });
        const f3 = t.before({ tool: "fill", args: { target: { by: "label", value: "Qty" }, value: "6" }, target: 'spinbutton "Qty" @aa', url });
        expect(f2.action).toBe(f1.action);
        expect(f3.action).not.toBe(f1.action);
        // Two spellings of one address are one navigation.
        expect(t.before({ tool: "navigate", args: { url: "/cart" }, url }).action).toBe(t.before({ tool: "navigate", args: { url: "http://shop.test/cart" }, url }).action);
    });

    it("the action tracker: a read between two clicks does not make the second look new, and a fresh pass starts again", () => {
        const t = actionTracker("http://shop.test/cart");
        const url = "http://shop.test/cart";
        const target = 'button "Continue" @0123456789ab';
        const run = (a: { tool: string; args: unknown; target?: string; read?: boolean }) => {
            const asked = t.before({ ...a, url });
            t.after({ ...a, ok: true, url });
            return asked;
        };
        const click = { tool: "click", args: {}, target };
        const first = run(click);
        const second = run(click);
        run({ tool: "wait", args: { ms: 1 }, read: true });
        const third = run(click);
        run({ tool: "wait", args: { ms: 2 }, read: true });
        expect(second.state).not.toBe(first.state);
        expect(third).toEqual(second);
        expect(run({ tool: "wait", args: { ms: 3 }, read: true }).read).toBe(true);
        t.freshPass("http://shop.test/cart");
        expect(t.before({ ...click, url })).toEqual(first);
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
        const { summary, events, tests, images } = await exploreShop(site, llm, OBJECTIVES_WITH_DATA);

        // The session (data changes allowed, as the benchmark runs): one stop reason, every pursuit run, nothing skipped. The boundary
        // value has no script here, so its test writer stops without a test.
        const ex = summary.exploration!;
        expect(ex.stopReason).toBe("objectives_done");
        expect(events.filter((e) => e.kind === "exploration_stopped")).toHaveLength(1);
        // Row 173: each pursuit's start and end for the run page's live list, with ids and the operator only (no page text, no prompt).
        const rule = ex.objectives.find((o) => o.kind === "rule")!.id;
        const field = ex.objectives.find((o) => o.kind === "constraint")!.id;
        expect(events.filter((e) => /^objective_(started|finished)$/.test(e.kind))).toEqual([
            { kind: "objective_started", message: `${rule} as_stated: started`, data: { objectiveId: rule, operator: "as_stated" } },
            { kind: "objective_finished", message: `${rule} as_stated: finished (completed)`, data: { objectiveId: rule, operator: "as_stated", outcome: "completed" } },
            { kind: "objective_started", message: `${field} invalid_input: started`, data: { objectiveId: field, operator: "invalid_input" } },
            { kind: "objective_finished", message: `${field} invalid_input: finished (completed)`, data: { objectiveId: field, operator: "invalid_input", outcome: "completed" } },
            { kind: "objective_started", message: `${field} boundary_input: started`, data: { objectiveId: field, operator: "boundary_input" } },
            { kind: "objective_finished", message: `${field} boundary_input: finished (writer_stopped)`, data: { objectiveId: field, operator: "boundary_input", outcome: "writer_stopped" } },
        ]);
        expect(ex.budgets).toEqual({ objectives: 3, actions: 750, aiCalls: 750, tokens: 7_500_000, minutes: 90, depth: 8, steps: 30 });
        expect(ex.skipped).toEqual([]);
        expect(ex.outcomes.filter((o) => !o.objectiveId.endsWith(":boundary_input")).map((o) => o.status)).toEqual(["completed", "completed"]);
        expect(ex.usage.aiCalls).toBe(calls.filter((c) => !c.startsWith("object:")).length);
        // The test writer's own five actions, and the replays without AI that reached the application (CP2 M-5): each pursuit's prune
        // replay of its saved steps (3: open, navigate, check; 4: open, fill, click, check) and its finding's two fresh replays.
        const performed = ex.actionLog.filter((r) => r.result === "performed");
        expect(performed.filter((r) => !r.action.startsWith("replay: "))).toHaveLength(5);
        expect(performed.filter((r) => r.action.startsWith("replay: ")).map((r) => r.action)).toEqual([
            "replay: the replay that drops stale steps (3 steps)",
            "replay: the two fresh replays of the independence check (6 steps)",
            "replay: the replay that drops stale steps (4 steps)",
            "replay: the two fresh replays of the independence check (8 steps)",
        ]);
        expect(ex.usage.actions).toBe(5 + 3 + 6 + 4 + 8);
        // The action log (every row, under the 2,000-row cap) and the coverage record built from it and the saved tests.
        expect(ex.actionLogOmitted).toBe(0);
        expect(ex.coverage.rules).toMatchObject({ total: 1, exercised: 1 });
        expect(ex.coverage.inputClasses).toMatchObject({ exercised: 1, notExercised: ["page-order/order/qty boundary_input"] });
        expect(ex.coverage.pages.notExercised).not.toContain("/cart");
        expect(ex.coverage.pages.notExercised).not.toContain("/order");
        // Nothing is "data changes off"; the only operator not run is the boundary value whose test writer stopped.
        expect(ex.coverage.notRun).toEqual([{ objectiveId: field, operator: "boundary_input", reason: "not finished: The test writer stopped before finishing the test" }]);
        expect(ex.coverage.unexplored).toEqual([]);
        // The rule as stated (its pursuit and the saved check citing its ref are one scenario) and the quantity's invalid input.
        expect(ex.coverage.uniqueScenarios).toBe(2);

        // Two defect tests for review, each carrying a captured finding tied to its objective and operator.
        expect(tests.map((t) => t.validation)).toEqual(["NEEDS_REVIEW", "NEEDS_REVIEW"]);
        const findings = tests.map((t) => CandidateFindingSchema.parse(t.meta.finding));
        expect(findings.map((f) => [f.objective?.kind, f.objective?.operator, f.expected.source, f.capture, f.independence, f.confidence]).sort()).toEqual([
            ["constraint", "invalid_input", "expected:1", "captured", "independent", "high"],
            ["rule", "as_stated", "R-TOTAL", "captured", "independent", "high"],
        ]);
        expect(findings.find((f) => f.objective?.kind === "rule")!.expected.text).toBe("The total equals the sum of the lines: $25.00");
        expect(findings.every((f) => f.modelVersion === "mv-shop-1")).toBe(true);
        // Row 173: each finding references the pictures of the page where its replays stopped (one per replay), stored as screenshots.
        for (const f of findings) {
            expect(f.evidence.screenshots).toHaveLength(2);
            for (const ref of f.evidence.screenshots) expect(images.get(ref)).toMatchObject({ kind: "screenshot", name: expect.stringMatching(/^WEB-\d{3}-finding-[12]\.jpg$/), bytes: expect.any(Number) });
        }
        expect(new Set(findings.flatMap((f) => f.evidence.screenshots)).size).toBe(4);
        // Every expected result keeps its stated source end to end: the scenario cites the objective's ref, in its objective and in
        // the expected text, and the constraint's finding states that text (not a model-written expectation).
        for (const t of tests) {
            const sc = t.meta.scenario as { objective: { source: string }; expectedResults: string[] };
            expect(["R-TOTAL", "page-order/order/qty"]).toContain(sc.objective.source);
            expect(sc.expectedResults).toEqual([expect.stringMatching(new RegExp(`\\(source: ${sc.objective.source}\\)$`))]);
        }
        expect(findings.find((f) => f.objective?.kind === "constraint")!.expected.text).toBe(
            `${JSON.stringify('The field "Quantity" accepts a value only when the value must be a valid number; at least 1; at most 10; any other value is refused.')} (source: page-order/order/qty)`,
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
        // Row 173: the request says the rule was explored last time, so only the quantity's objective is "not explored yet".
        // The project allows data changes and the server does not (no dataOperators): the two form-submitting operators run, and the
        // boundary value is skipped naming the server's setting (owner, 2026-11-21).
        const { summary, events, tests } = await exploreShop(site, llm, { objectives: true, allowMutatingApiTests: true, exploredObjectives: ["R-TOTAL"] });
        expect(summary.exploration!.skipped).toEqual([{ objectiveId: expect.stringMatching(/^OBJ-/), operator: "boundary_input", reason: SKIP_REASONS.serverDataOff }]);
        expect(summary.exploration!.objectives.map((o) => [o.kind, /not explored yet/.test(o.reason)])).toEqual([
            ["constraint", true],
            ["rule", false],
        ]);
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
