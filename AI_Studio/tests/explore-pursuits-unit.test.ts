/**
 * Row 205 (row 204 triage): how the objective stage turns the level's budgets and the model's objectives into pursuits, without a
 * browser or a model.
 *   - The level's `objectives` caps objectives when the list is built; the loop then runs every pursuit built from them (one objective
 *     with one operator each), still bounded by the session's time, AI-call, token and action budgets.
 *   - Workflow steps name the model's page ids ("page:/cart"); a pursuit starts at that page's address, and a direct URL opens one.
 *   - A pursuit ended by its own time or token limit is not finished, and says that its steps so far were not saved; one ended by the
 *     session or the loop stays a completed pursuit with the reason (the loop records the session's stop itself).
 */
import { describe, expect, it } from "vitest";
import { runExploration } from "../src/engine/explore/loop.js";
import { LEVEL_SETTINGS } from "../src/engine/levels.js";
import { endedPursuit, ExplorationStopped, ObjectiveLimitReached, objectivePursuits, sessionBudgets } from "../src/engine/orchestrator.js";
import { c1eKnowledge } from "./fixtures/bench-shop-c1e.js";

describe("the session's pursuit budget", () => {
    it("3 objectives x 3 operators with an objectives budget of 3 runs all 9 pursuits", async () => {
        const level = { ...LEVEL_SETTINGS.thorough.exploration, objectives: 3 };
        const pursuits = ["OBJ-a", "OBJ-b", "OBJ-c"].flatMap((id, i) =>
            ["as_stated", "double_submit", "refresh"].map((op) => ({ id: `${id}:${op}`, priority: 10 - i, fingerprint: `${id}-${op}` })),
        );
        const budgets = sessionBudgets(level, pursuits.length, 3);
        const ran: string[] = [];
        const r = await runExploration({
            objectives: pursuits,
            budgets,
            runObjective: async (p) => (ran.push(p.id), { status: "completed" }),
            now: () => 0,
            usage: () => ({ aiCalls: 0, tokens: 0 }),
            reset: async () => undefined,
        });
        expect(ran).toHaveLength(9);
        expect(r.outcomes.filter((o) => o.status === "not_reached")).toEqual([]);
        expect(r.stopReason).toBe("objectives_done");
        // The other budgets are the level's own.
        expect(budgets).toEqual({ objectives: 9, actions: level.actions, aiCalls: level.aiCalls, tokens: level.tokens, minutes: level.minutes, depth: level.depth, objectiveActions: level.actions / 3 });
    });

    it("the session's other budgets still stop the pursuits", async () => {
        const level = { ...LEVEL_SETTINGS.thorough.exploration, objectives: 3, aiCalls: 4 };
        const pursuits = Array.from({ length: 9 }, (_, i) => ({ id: `OBJ-${i}:as_stated`, priority: 1, fingerprint: `f${i}` }));
        let calls = 0;
        const r = await runExploration({
            objectives: pursuits,
            budgets: sessionBudgets(level, pursuits.length, pursuits.length),
            runObjective: async () => ((calls += 1), { status: "completed" }),
            now: () => 0,
            usage: () => ({ aiCalls: calls, tokens: 0 }),
            reset: async () => undefined,
        });
        expect(calls).toBe(4);
        expect(r.stopReason).toBe("ai_calls");
    });

    it("a model whose every operator is skipped (data changes off) builds no pursuit, and the session ends at once instead of failing the job", async () => {
        const thorough = LEVEL_SETTINGS.thorough;
        // One required email field: its as stated and invalid input checks submit the form, so with data changes off neither runs.
        const k = { rules: [], workflows: [], objectiveInputs: { pages: [{ id: "p-signup", path: "/signup", forms: [{ name: "signup", fields: [{ name: "email", type: "email", required: true }] }] }], transitions: [], workflowSteps: [] } };
        const built = objectivePursuits(k, { maxObjectives: thorough.exploration.objectives, steps: thorough.authoringMaxSteps, perObjective: thorough.exploration.perObjective, dataChanges: false, dataOperators: false, requiresAuth: false });
        expect(built.objectives.length).toBeGreaterThan(0);
        expect(built.pursuits).toEqual([]);
        expect(built.skipped.length).toBeGreaterThan(0);
        let ran = 0;
        const r = await runExploration({
            objectives: built.pursuits,
            budgets: sessionBudgets(thorough.exploration, built.pursuits.length, built.objectives.length),
            runObjective: async () => ((ran += 1), { status: "completed" }),
            now: () => 0,
            usage: () => ({ aiCalls: 0, tokens: 0 }),
            reset: async () => undefined,
        });
        expect(ran).toBe(0);
        expect(r.stopReason).toBe("objectives_done");
        expect(r.usage.objectives).toBe(0);
    });
});

describe("workflow pages are addresses, not model page ids", () => {
    const thorough = LEVEL_SETTINGS.thorough;
    const built = () => objectivePursuits(c1eKnowledge(), { maxObjectives: 500, steps: thorough.authoringMaxSteps, perObjective: thorough.exploration.perObjective, dataChanges: true, dataOperators: true, requiresAuth: true });

    it("the C1e model's workflow steps carry page ids", () => {
        const k = c1eKnowledge();
        const steps = k.objectiveInputs!.workflowSteps.find((w) => w.workflowId.startsWith("journey-10"))!.steps;
        expect(steps.map((s) => s.page)).toEqual(["page:/cart", "page:/cart", "page:/cart"]);
    });

    it("a workflow pursuit starts at its first step's page address (/cart), never at the page id", () => {
        const { pursuits } = built();
        const checkout = pursuits.filter((p) => p.objective.source.ref.startsWith("journey-10"));
        expect(checkout.length).toBeGreaterThan(0);
        for (const p of checkout) expect(p.scenario.startPath).toBe("/cart");
        const register = pursuits.find((p) => p.objective.source.ref.startsWith("journey-1-") && p.operator === "as_stated")!;
        expect(register.scenario.startPath).toBe("/register");
        // No pursuit at all starts at, or opens directly, an address that is not a path.
        for (const p of pursuits) {
            expect(p.scenario.startPath, p.id).toMatch(/^\//);
            if (p.check.url !== undefined) expect(p.check.url, p.id).toMatch(/^\//);
        }
        expect(pursuits.some((p) => p.operator === "direct_url")).toBe(true);
    });

    it("a page id that is not \"page:<path>\" is looked up in the model's pages (P-cart is /cart)", () => {
        const k = c1eKnowledge((id) => (id === "page:/cart" ? "P-cart" : id));
        expect(k.objectiveInputs!.workflowSteps.find((w) => w.workflowId.startsWith("journey-10"))!.steps.map((s) => s.page)).toEqual(["P-cart", "P-cart", "P-cart"]);
        const { pursuits } = objectivePursuits(k, { maxObjectives: 500, steps: thorough.authoringMaxSteps, perObjective: thorough.exploration.perObjective, dataChanges: true, dataOperators: true, requiresAuth: true });
        const checkout = pursuits.filter((p) => p.objective.source.ref.startsWith("journey-10"));
        expect(checkout.length).toBeGreaterThan(0);
        for (const p of checkout) expect(p.scenario.startPath).toBe("/cart");
    });
});

describe("a pursuit ended by its own limit", () => {
    it("is not finished, and says the steps so far were not saved", () => {
        const limit = new ObjectiveLimitReached("The objective's limit of 750000 AI tokens was reached.");
        for (const err of [limit, new Error("The model call failed.", { cause: limit })]) {
            const run = endedPursuit(err, false);
            expect(run).toMatchObject({ status: "writer_stopped" });
            expect(run && "reason" in run ? run.reason : "").toMatch(/^The objective's limit of 750000 AI tokens was reached before its test was finished; the steps done so far were not saved\.$/);
        }
    });

    it("one ended by the session or the loop is a completed pursuit with the reason; anything else is not an ended pursuit", () => {
        expect(endedPursuit(new ExplorationStopped("The session stopped (tokens)."), false)).toEqual({ status: "completed", result: { ended: "The session stopped (tokens)." } });
        expect(endedPursuit(new Error("boom"), true)).toEqual({ status: "completed", result: { ended: "The exploration ended this pursuit." } });
        expect(endedPursuit(new Error("boom"), false)).toBeUndefined();
    });
});
