/**
 * A defect is captured only by a failing check whose source is stated (fast tier, pure; queue row 172). A rule given to the scenario
 * (stated by a source or confirmed by a person) is stated by its ref. `expected:<n>` is stated only when the scenario's n-th expected
 * result is itself tied to a stated source: an objective scenario (explore/perturb.ts scenarioFor, whose expected result cites its source)
 * or a planner expected result that cites a usable rule's ref. A planner's own expected result is not: the planner wrote it, the app and
 * its documents did not (C1b: all 13 "captured" defects failed on the clean app for that reason). Such a defect stays observed only,
 * confidence low, with no source.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { objectivesFrom } from "../src/engine/explore/objectives.js";
import { scenarioFor } from "../src/engine/explore/perturb.js";
import { defectFinding } from "../src/engine/orchestrator.js";
import { parseRequirementsDeterministic } from "../src/engine/requirements/parse.js";
import type { KnowledgeRule } from "../src/engine/planning/planner.js";
import { ScenarioSchema, type Scenario } from "../src/engine/spec/schema.js";
import { statedSource, type AuthorOutcome } from "../src/engine/web/author.js";

const RULE: KnowledgeRule = { ref: "R-TOTAL", kind: "constraint" as KnowledgeRule["kind"], description: "The total is the sum of the line prices", expected: "Total = sum of lines", explicitness: "explicit", status: "unverified", workflows: [] };
const GUESSED: KnowledgeRule = { ...RULE, ref: "R-GUESS", explicitness: "implicit" as KnowledgeRule["explicitness"] };
const planned = (expectedResults: string[]): Scenario => ScenarioSchema.parse({ scenarioId: "S-CART", title: "Cart total", description: "The cart adds up its lines", category: "Cart", startPath: "/cart", expectedResults });
const objectiveScenario = (): Scenario => {
    const budget = { steps: 30, minutes: 10, tokens: 300_000 };
    const o = objectivesFrom({}, [{ ...RULE, ref: "R-7" } as never], [], { maxObjectives: 10, budget }).objectives[0]!;
    // "As stated" submits forms, so it is built only where data changes are allowed (owner, 2026-11-21).
    const r = scenarioFor(o, "as_stated", { dataOperators: true });
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

describe("statedSource: an expected result naming a requirement id", () => {
    const covering = (requirements: string[], expected: string): Scenario =>
        ScenarioSchema.parse({ scenarioId: "S-REQ", title: "Cart total", description: "d", category: "Cart", startPath: "/cart", requirements, expectedResults: ["The cart page is shown", expected] });
    const PROJECT = ["REQ-1", "REQ-2", "1.2"];

    it("is stated when the scenario covers that requirement and the project has it", () => {
        expect(statedSource("expected:2", covering(["REQ-1"], "The total is $25.00 (REQ-1)"), undefined, PROJECT)).toBe(true);
        expect(statedSource("expected:2", covering(["REQ-2", "REQ-1"], "REQ-1: the total is $25.00."), [RULE], PROJECT)).toBe(true);
        expect(statedSource("expected:2", covering(["1.2"], "The total is $25.00 (requirement 1.2)."), undefined, PROJECT)).toBe(true);
        // The other expected result of the same scenario names nothing: still the planner's own.
        expect(statedSource("expected:1", covering(["REQ-1"], "The total is $25.00 (REQ-1)"), undefined, PROJECT)).toBe(false);
    });

    it("is not stated for a real requirement id the scenario does not cover", () => {
        expect(statedSource("expected:2", covering(["REQ-2"], "The total is $25.00 (REQ-1)"), undefined, PROJECT)).toBe(false);
        expect(statedSource("expected:2", covering([], "The total is $25.00 (REQ-1)"), undefined, PROJECT)).toBe(false);
    });

    it("is not stated for an id the scenario claims but the project does not have", () => {
        expect(statedSource("expected:2", covering(["REQ-9"], "The total is $25.00 (REQ-9)"), undefined, PROJECT)).toBe(false);
        expect(statedSource("expected:2", covering(["REQ-1"], "The total is $25.00 (REQ-1)"), undefined, undefined)).toBe(false);
        expect(statedSource("expected:2", covering(["REQ-1"], "The total is $25.00 (REQ-1)"), undefined, [])).toBe(false);
    });

    it("is not stated for a near-miss token", () => {
        for (const text of ["The total is $25.00 (REQ-10)", "The total is $25.00 (XREQ-1)", "The total is $25.00 (REQ-1-B)", "The total is $25.00 (REQ-1.3)", "The total is $25.00 (req-1)"]) {
            expect(statedSource("expected:2", covering(["REQ-1"], text), undefined, PROJECT), text).toBe(false);
        }
        expect(statedSource("expected:2", covering(["1.2"], "The total is $25.00 (section 1.2.3)"), undefined, PROJECT)).toBe(false);
        expect(statedSource("expected:2", covering(["1.2"], "The total is $25.00 (section 11.2)"), undefined, PROJECT)).toBe(false);
    });
});

describe("statedSource: a numeric requirement id counts only when cited as a requirement (CP3 N-4)", () => {
    // The bench requirements documents number their requirements 1.1 to 8.x; a planner's quantity or price can equal one.
    const covering = (requirements: string[], expected: string): Scenario =>
        ScenarioSchema.parse({ scenarioId: "S-NUM", title: "Mug", description: "d", category: "Cart", startPath: "/cart", requirements, expectedResults: [expected] });
    const PROJECT = ["1", "2", "1.1", "2.3", "8.10"];
    const stated = (requirements: string[], expected: string) => statedSource("expected:1", covering(requirements, expected), undefined, PROJECT);

    it("a bare number equal to a covered id is not a citation", () => {
        expect(stated(["1.1"], "The mug costs 1.1 kg")).toBe(false);
        expect(stated(["1.1"], "The weight shows 1.1.")).toBe(false);
        expect(stated(["2"], "The cart badge shows 2 items")).toBe(false);
        expect(stated(["1.1"], "The page shows [1.1]")).toBe(false);
        expect(stated(["2.3"], "Section (2.3) is shown")).toBe(false);
    });

    it("an explicit citation of a covered id that the project has is stated", () => {
        for (const text of [
            "requirement 1.1: the total is $25.00",
            "Requirement 1.1: the total is $25.00",
            "The total is $25.00 (requirement 1.1).",
            "The total is $25.00 (req 1.1)",
            "The total is $25.00 [requirement 1.1]",
            "The total is $25.00 per requirement 1.1.",
            "The total is $25.00 (requirements 2.3 and 1.1)",
        ])
            expect(stated(["1.1"], text), text).toBe(true);
        expect(stated(["2.3"], "The product page says how many one customer may order (see requirement 2.3)")).toBe(true);
        expect(stated(["8.10"], "The order is listed (requirement 8.10)")).toBe(true);
    });

    it("a cited id the scenario does not cover, or the project does not have, is not stated", () => {
        expect(stated(["2.3"], "The total is $25.00 (requirement 1.1)")).toBe(false);
        expect(stated([], "The total is $25.00 (requirement 1.1)")).toBe(false);
        expect(stated(["9.9"], "The total is $25.00 (requirement 9.9)")).toBe(false);
        expect(statedSource("expected:1", covering(["1.1"], "The total is $25.00 (requirement 1.1)"), undefined, undefined)).toBe(false);
    });

    it("a citation of a longer or different number is not one of the covered id", () => {
        for (const text of ["(requirement 1.10)", "(requirement 11.1)", "(requirement 1.1.2)", "(REQ-1.12)", "(requirement 21.1)", "(requirement 1.1a)"])
            expect(stated(["1.1"], `The total is $25.00 ${text}`), text).toBe(false);
        expect(stated(["8.10"], "The order is listed (requirement 8.1)")).toBe(false);
        // "requirement" too far before the bracketed number.
        expect(stated(["1.1"], "The requirement page lists every product with its price and weight (1.1)")).toBe(false);
    });

    it("a requirement word followed by a quantity is prose, not a citation (CP3b R-6)", () => {
        // The form is "requirement <id>" with only a space between, ending the citation, or "(requirement <id>)" / "[requirement <id>]".
        expect(stated(["8"], "The password length requirement: 8 or more characters is enforced")).toBe(false);
        expect(stated(["2"], "The minimum order requirement (2) items is shown")).toBe(false);
        expect(stated(["2"], "Requirements 2 or more items show a discount")).toBe(false);
        expect(stated(["8"], "The length requirement 8 characters is shown")).toBe(false);
        expect(stated(["2"], "A requirement of 2 items is shown")).toBe(false);
        // Punctuation between the word and the number is not the form either.
        for (const text of ["The total is $25.00 (REQ-1.1)", "The total is $25.00 per requirement [1.1]", "The total is $25.00, as the requirements say (1.1)", "The total is $25.00 (requirement: 1.1)", "The total is $25.00 (requirement #1.1)"])
            expect(stated(["1.1"], text), text).toBe(false);
        // Ending at the end of the text or at a punctuation mark is a citation.
        expect(stated(["2"], "The discount is shown (requirement 2)")).toBe(true);
        expect(stated(["2"], "The discount is shown, see requirement 2")).toBe(true);
        expect(stated(["2"], "Requirement 2: the discount is shown")).toBe(true);
    });

    it("every id of the bench requirements documents is stated when cited as the planner is told to, and never as a bare number", () => {
        for (const bench of ["bench-shop", "bench-rbac"]) {
            const ids = parseRequirementsDeterministic(readFileSync(new URL(`../examples/${bench}/requirements/requirements.md`, import.meta.url), "utf8")).map((r) => r.id);
            expect(ids.length, bench).toBeGreaterThan(40);
            for (const id of ids) {
                const s = ScenarioSchema.parse({ scenarioId: "S-B", title: "t", description: "d", category: "c", requirements: [id], expectedResults: [`The cart shows ${id} items`, `The total is ${id} kg (requirement ${id})`] });
                expect(statedSource("expected:1", s, undefined, ids), `${bench} ${id} bare`).toBe(false);
                expect(statedSource("expected:2", s, undefined, ids), `${bench} ${id} cited`).toBe(true);
            }
        }
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

    it("a check of an expected result naming a requirement of the job its scenario covers: captured; without the job's ids, observed only", () => {
        const s = ScenarioSchema.parse({ scenarioId: "S-REQ", title: "Cart total", description: "d", category: "Cart", requirements: ["REQ-1"], expectedResults: ["The cart page is shown", "The total is $25.00 (REQ-1)"] });
        const tied = defectFinding({ scenario: s, rules: [], requirementIds: ["REQ-1"], outcome: outcome("expected:2"), capture: "captured", independence: independent, stepCount: 3, modelVersion: null });
        expect(tied).toMatchObject({ confidence: "high", source: "expected:2" });
        expect(tied.finding).toMatchObject({ capture: "captured", expected: { text: "The total is $25.00 (REQ-1)", source: "expected:2" } });
        const unknown = defectFinding({ scenario: s, rules: [], outcome: outcome("expected:2"), capture: "captured", independence: independent, stepCount: 3, modelVersion: null });
        expect(unknown).toMatchObject({ confidence: "low", source: null });
    });

    it("a defect of an objective scenario (built the way the objective stage builds it) names its objective", () => {
        const s = objectiveScenario();
        const found = defectFinding({ scenario: s, rules: [{ ...RULE, ref: "R-7" }], outcome: outcome("R-7"), capture: "captured", independence: independent, stepCount: 3, modelVersion: "mv-1" });
        expect(found.finding).toMatchObject({ objective: { ...s.objective!, source: "R-7", operator: "as_stated" }, capture: "captured", modelVersion: "mv-1" });
    });
});
