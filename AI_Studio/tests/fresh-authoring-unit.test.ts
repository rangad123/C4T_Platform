/**
 * Row 235 (fixes 2 and 4 of ROW233-ROOT-CAUSE.md), without a browser or a model (fast tier):
 *   - cleanAuthoringPlan: a test that changes cart, orders or account state, and every objective pursuit, is WRITTEN as a newly registered
 *     account, under row 229's conditions (data changes allowed, a sign-up page found, signs in as the main account, no role account, no
 *     starting record such as ord-1000 named); otherwise it is written on the shared account as before, and the plan says why;
 *   - freshAccountScenario tells the writer the account starts empty and, when the test checks a total, to build two or more lines itself;
 *   - the objective action share: the session's actions over the number of objectives, at least 20; the loop refuses a pursuit's action
 *     past its objective's share, skips that objective's later pursuits, and the next objective still gets its turn.
 * The job side is tests/orchestrator-clean-replay.test.ts.
 */
import { describe, expect, it } from "vitest";
import { cleanAuthoringPlan, freshAccountScenario } from "../src/engine/explore/clean-account.js";
import { runExploration, type ObjectiveContext, type ObjectiveRun } from "../src/engine/explore/loop.js";
import { LEVEL_SETTINGS } from "../src/engine/levels.js";
import { OBJECTIVE_ACTIONS_FLOOR, objectivePursuits, sessionBudgets } from "../src/engine/orchestrator.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";

const scenario = (over: Record<string, unknown> = {}) =>
    ScenarioSchema.parse({ scenarioId: "S-1", title: "Cart total", description: "The cart adds up its lines", category: "Cart", requiresAuth: true, expectedResults: ["The total is the sum of the lines"], ...over });
const base = { scenario: scenario(), objective: false, signsInAsMain: true, roleAccount: false, dataChanges: true, signupPath: "/register", startingIds: new Set(["ord-1000"]) };

describe("cleanAuthoringPlan", () => {
    it("a test that changes cart, orders or account state is written as a new account", () => {
        expect(cleanAuthoringPlan(base)).toEqual({ register: true, signupPath: "/register" });
        expect(cleanAuthoringPlan({ ...base, scenario: scenario({ title: "Place an order", description: "Checkout places it", expectedResults: ["The order is listed"] }) })).toMatchObject({ register: true });
        expect(cleanAuthoringPlan({ ...base, scenario: scenario({ title: "Edit the profile", description: "Change the delivery address", expectedResults: ["Saved"] }) })).toMatchObject({ register: true });
    });

    it("every objective pursuit is, whatever its wording", () => {
        const plain = scenario({ title: "Home page heading", description: "The heading is shown", expectedResults: ["A heading"] });
        expect(cleanAuthoringPlan({ ...base, scenario: plain })).toMatchObject({ register: false });
        expect(cleanAuthoringPlan({ ...base, scenario: plain, objective: true })).toEqual({ register: true, signupPath: "/register" });
    });

    it("otherwise it is written on the shared account, and says why", () => {
        for (const [over, why] of [
            [{ signsInAsMain: false }, /does not sign in as the project's test account/],
            [{ roleAccount: true }, /named test account/],
            [{ dataChanges: false }, /does not allow tests that change data/],
            [{ signupPath: undefined }, /no sign-up page/],
            [{ scenario: scenario({ description: "Open ord-1000 and cancel it" }) }, /starting data, ord-1000/],
        ] as const) {
            const p = cleanAuthoringPlan({ ...base, ...over, objective: true });
            expect(p, JSON.stringify(over)).toMatchObject({ register: false, clean: false });
            expect((p as { why: string }).why).toMatch(why);
        }
    });
});

describe("freshAccountScenario", () => {
    it("says the account starts empty, and a total needs two or more lines the test adds", () => {
        const s = freshAccountScenario(scenario({ preconditions: ["Signed in"] }));
        expect(s.preconditions[0]).toBe("Signed in");
        expect(s.preconditions[1]).toMatch(/newly registered account.*empty cart and no orders/);
        expect(s.preconditions[2]).toMatch(/at least two different products.*quantity 2 or more/);
        const noTotal = freshAccountScenario(scenario({ title: "Edit the profile", description: "Change the name", expectedResults: ["Saved"] }));
        expect(noTotal.preconditions).toHaveLength(1);
        expect(noTotal.preconditions.join(" ")).not.toMatch(/two different products/);
    });
});

describe("the objective action share (fix 4)", () => {
    it("is the session's actions over the objectives, at least the floor", () => {
        const level = LEVEL_SETTINGS.thorough.exploration;
        expect(OBJECTIVE_ACTIONS_FLOOR).toBe(20);
        expect(sessionBudgets(level, 104, 50).objectiveActions).toBe(20); // 750 / 50 = 15, below the floor
        expect(sessionBudgets(level, 12, 5).objectiveActions).toBe(150);
        expect(sessionBudgets({ ...level, actions: 5_000 }, 300, 200).objectiveActions).toBe(25);
        expect(sessionBudgets(level, 0, 0).objectiveActions).toBe(750);
    });

    it("the pursuits of one objective share its allowance", () => {
        const thorough = LEVEL_SETTINGS.thorough;
        const k = { rules: [], workflows: [], objectiveInputs: { pages: [{ id: "p-signup", path: "/signup", forms: [{ name: "signup", fields: [{ name: "email", type: "email", required: true }] }] }], transitions: [], workflowSteps: [] } };
        const built = objectivePursuits(k, { maxObjectives: 50, steps: thorough.authoringMaxSteps, perObjective: thorough.exploration.perObjective, dataChanges: true, dataOperators: true, requiresAuth: false });
        expect(built.pursuits.length).toBeGreaterThan(0);
        for (const p of built.pursuits) expect(p.share).toBe(p.objective.id);
    });

    const walk =
        (n: number) =>
        async (ctx: ObjectiveContext): Promise<ObjectiveRun> => {
            for (let i = 0; i < n; i++) if (!ctx.act({ state: `s${i}`, action: `click #${i}` }).allowed) break;
            return { status: "completed" };
        };

    it("one objective cannot spend the session: its pursuits stop at its share and the next objective gets a turn", async () => {
        const pursuits = [
            { id: "OBJ-money:as_stated", share: "OBJ-money", priority: 11, fingerprint: "m1", n: 30 },
            { id: "OBJ-money:repeat", share: "OBJ-money", priority: 11, fingerprint: "m2", n: 30 },
            { id: "OBJ-cancel:as_stated", share: "OBJ-cancel", priority: 3, fingerprint: "c1", n: 5 },
        ];
        const ran: string[] = [];
        const r = await runExploration({
            objectives: pursuits,
            budgets: { objectives: 3, actions: 40, aiCalls: 100, tokens: 1e9, minutes: 60, depth: 10, objectiveActions: 20 },
            runObjective: async (p, ctx) => (ran.push(p.id), walk(p.n)(ctx)),
            now: () => 0,
            usage: () => ({ aiCalls: 0, tokens: 0 }),
            reset: async () => undefined,
        });
        // Without the share the first pursuit took 30 and the second the last 10: the cancel objective was never reached.
        expect(ran).toEqual(["OBJ-money:as_stated", "OBJ-cancel:as_stated"]);
        expect(r.outcomes.map((o) => [o.objectiveId, o.status, o.actions])).toEqual([
            ["OBJ-money:as_stated", "stopped", 20],
            ["OBJ-money:repeat", "stopped", 0],
            ["OBJ-cancel:as_stated", "completed", 5],
        ]);
        expect(r.outcomes[0]!.reason).toMatch(/share of 20 actions/);
        expect(r.outcomes[1]!.reason).toMatch(/share of 20 actions/);
        expect(r.usage.actions).toBe(25);
    });

    it("without a share key each pursuit is its own objective", async () => {
        const r = await runExploration({
            objectives: [{ id: "a", priority: 2, fingerprint: "a", n: 30 }, { id: "b", priority: 1, fingerprint: "b", n: 30 }],
            budgets: { objectives: 2, actions: 100, aiCalls: 100, tokens: 1e9, minutes: 60, depth: 10, objectiveActions: 20 },
            runObjective: async (p, ctx) => walk(p.n)(ctx),
            now: () => 0,
            usage: () => ({ aiCalls: 0, tokens: 0 }),
            reset: async () => undefined,
        });
        expect(r.outcomes.map((o) => o.actions)).toEqual([20, 20]);
    });
});
