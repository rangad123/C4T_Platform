/**
 * A defect is captured only by a failing check whose source is stated (fast tier, pure; queue row 172). A rule given to the scenario
 * (stated by a source or confirmed by a person) is stated by its ref. `expected:<n>` is stated only when the scenario's n-th expected
 * result is itself tied to a stated source: an objective scenario (explore/perturb.ts scenarioFor, whose expected result cites its source)
 * or a planner expected result that cites a usable rule's ref. A planner's own expected result is not: the planner wrote it, the app and
 * its documents did not (C1b: all 13 "captured" defects failed on the clean app for that reason). Such a defect stays observed only,
 * confidence low, with no source.
 */
import { describe, expect, it } from "vitest";
import { objectivesFrom } from "../src/engine/explore/objectives.js";
import { scenarioFor } from "../src/engine/explore/perturb.js";
import { defectFinding } from "../src/engine/orchestrator.js";
import type { KnowledgeRule } from "../src/engine/planning/planner.js";
import { ScenarioSchema, type Scenario } from "../src/engine/spec/schema.js";
import { statedSource, type AuthorOutcome } from "../src/engine/web/author.js";

const RULE: KnowledgeRule = { ref: "R-TOTAL", kind: "constraint" as KnowledgeRule["kind"], description: "The total is the sum of the line prices", expected: "Total = sum of lines", explicitness: "explicit", status: "unverified", workflows: [] };
const GUESSED: KnowledgeRule = { ...RULE, ref: "R-GUESS", explicitness: "implicit" as KnowledgeRule["explicitness"] };
const planned = (expectedResults: string[]): Scenario => ScenarioSchema.parse({ scenarioId: "S-CART", title: "Cart total", description: "The cart adds up its lines", category: "Cart", startPath: "/cart", expectedResults });
const objectiveScenario = (): Scenario => {
    const budget = { steps: 30, minutes: 10, tokens: 300_000 };
    const o = objectivesFrom({}, [{ ...RULE, ref: "R-7" } as never], [], { maxObjectives: 10, budget }).objectives[0]!;
    const r = scenarioFor(o, "as_stated");
    if (r.status !== "ready") throw new Error("objective scenario not ready");
    return r.scenario;
};

describe("statedSource", () => {
    it("a usable rule's ref is stated; a rule nobody stated or confirmed is not", () => {
        expect(statedSource("R-TOTAL", planned(["x"]), [RULE])).toBe(true);
        expect(statedSource("R-GUESS", planned(["x"]), [GUESSED])).toBe(false);
        expect(statedSource("R-TOTAL", planned(["x"]), [{ ...RULE, status: "rejected" }])).toBe(false);
        expect(statedSource("R-TOTAL", planned(["x"]), undefined)).toBe(false);
    });

    it("a planner's own expected result is not stated", () => {
        const s = planned(["The cart page is shown", "The total is $25.00"]);
        expect(statedSource("expected:2", s, [RULE])).toBe(false);
        expect(statedSource("expected:1", s, undefined)).toBe(false);
    });

    it("a planner expected result that cites a usable rule's ref is stated; a near-miss ref or an unusable rule is not", () => {
        const s = planned(["The cart page is shown", "The total is $25.00 (source: R-TOTAL)", "The total is right (R-TOTALS)", "The guess holds (source: R-GUESS)"]);
        expect(statedSource("expected:2", s, [RULE])).toBe(true);
        expect(statedSource("expected:2", s, undefined)).toBe(false);
        expect(statedSource("expected:3", s, [RULE])).toBe(false);
        expect(statedSource("expected:4", s, [RULE, GUESSED])).toBe(false);
        expect(statedSource("expected:5", s, [RULE])).toBe(false);
    });

    it("an objective scenario's expected result is stated (it cites its source); a coverage gap or an expected result without the cite is not", () => {
        const s = objectiveScenario();
        expect(s.expectedResults[0]).toContain("(source: R-7)");
        expect(statedSource("expected:1", s, undefined)).toBe(true);
        expect(statedSource("expected:1", { ...s, objective: { ...s.objective!, kind: "coverage-gap" } }, undefined)).toBe(false);
        expect(statedSource("expected:1", { ...s, expectedResults: ["The page looks right"] }, undefined)).toBe(false);
        expect(statedSource("expected:1", { ...s, objective: undefined }, undefined)).toBe(false);
    });
});

describe("defectFinding keeps the rule", () => {
    const outcome = (source: string): Extract<AuthorOutcome, { status: "defect" }> => ({ status: "defect", steps: [], testData: {}, explanation: "The total shows $30.00", capture: "captured", capturedCheck: { source, observed: "$30.00" } });
    const notRun = { independence: "not_run" as const, replays: [] };
    const independent = { independence: "independent" as const, replays: [] };

    it("a check of a planner's own expected result: observed only, confidence low, no source", () => {
        const found = defectFinding({ scenario: planned(["The cart page is shown", "The total is $25.00"]), rules: [RULE], outcome: outcome("expected:2"), capture: "captured", independence: notRun, stepCount: 3, modelVersion: null });
        expect(found).toMatchObject({ confidence: "low", source: null });
        expect(found.finding).toMatchObject({ capture: "observed_only", expected: { source: null } });
    });

    it("a check of an expected result tied to a rule, or of the rule itself: captured", () => {
        const tied = defectFinding({ scenario: planned(["The cart page is shown", "The total is $25.00 (source: R-TOTAL)"]), rules: [RULE], outcome: outcome("expected:2"), capture: "captured", independence: independent, stepCount: 3, modelVersion: null });
        expect(tied).toMatchObject({ confidence: "high", source: "expected:2" });
        expect(tied.finding).toMatchObject({ capture: "captured" });
        const rule = defectFinding({ scenario: planned(["The total is $25.00"]), rules: [RULE], outcome: outcome("R-TOTAL"), capture: "captured", independence: notRun, stepCount: 3, modelVersion: null });
        expect(rule).toMatchObject({ confidence: "medium", source: "R-TOTAL" });
        expect(rule.finding).toMatchObject({ capture: "captured", expected: { text: "Total = sum of lines", source: "R-TOTAL" } });
    });
});
