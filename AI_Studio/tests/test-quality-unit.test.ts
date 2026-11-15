/**
 * The test-quality model (testing-engine Phase 1, src/eval/quality/score.ts): every dimension on hand-made tests, including when it is
 * not measurable. Pure functions: fast tier.
 */
import { describe, expect, it } from "vitest";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { boundaryOrNegative, classOf, DIMENSIONS, scoreSuite, scoreTest, type DimensionScore, type RuleFact } from "../src/eval/quality/score.js";

const spec = (steps: unknown[], over: Record<string, unknown> = {}): TestSpec => TestSpecSchema.parse({ testId: "WEB-001", title: "A test", kind: "web", steps, ...over });
const btn = (name: string) => ({ by: "role", role: "button", value: name });
const field = (name: string) => ({ by: "label", value: name });
const of = (scores: DimensionScore[], d: string) => scores.find((s) => s.dimension === d)!;

const happy = spec([
    { action: "navigate", url: "/cart" },
    { action: "fill", locator: field("Quantity"), value: "2" },
    { action: "click", locator: btn("Update") },
    { action: "assert", check: "exactText", locator: field("Total"), expected: "30.00" },
    { action: "assert", check: "visible", locator: btn("Checkout") },
]);

const RULES: RuleFact[] = [
    { ref: "R-1", kind: "calculation", status: "unverified", explicitness: "explicit" },
    { ref: "R-2", kind: "transition", status: "unverified", explicitness: "inferred" },
    { ref: "R-3", kind: "transition", status: "confirmed", explicitness: "inferred" },
    { ref: "R-4", kind: "permission", status: "rejected", explicitness: "explicit" },
];

describe("assertion quality", () => {
    it("averages the outcome assertions after the last action, exact values strong and presence weak", () => {
        const s = of(scoreTest({ spec: happy }), "assertionQuality");
        expect(s.score).toBe(0.65); // (1 + 0.3) / 2
        expect(s.evidence).toEqual(["step 4: exactText (1)", "step 5: visible (0.3)"]);
    });

    it("scores 0 without an assertion, and an assertion before the last action does not count as the outcome", () => {
        expect(of(scoreTest({ spec: spec([{ action: "navigate", url: "/" }, { action: "click", locator: btn("Go") }]) }), "assertionQuality").score).toBe(0);
        const early = of(scoreTest({ spec: spec([{ action: "navigate", url: "/" }, { action: "assert", check: "exactText", locator: btn("A"), expected: "A" }, { action: "click", locator: btn("Go") }]) }), "assertionQuality");
        expect(early.score).toBe(0);
        expect(early.evidence).toContain("no assertion after the last action");
    });

    it("counts a content check without an expected value as a presence check, and 'no server error' as the weakest", () => {
        expect(of(scoreTest({ spec: spec([{ action: "navigate", url: "/" }, { action: "assert", check: "text", locator: btn("A") }]) }), "assertionQuality").score).toBe(0.3);
        const api = spec([{ action: "request", method: "POST", path: "/api/orders", body: {} }, { action: "assertResponse", check: "statusBelow", expected: 500 }], { kind: "api", testId: "API-001" });
        expect(of(scoreTest({ spec: api }), "assertionQuality").score).toBe(0.1);
    });

    it("averages in the deliberate-fault result when there is one", () => {
        const s = of(scoreTest({ spec: happy, strength: { caught: 1, total: 4 } }), "assertionQuality");
        expect(s.score).toBe(0.45); // (0.65 + 0.25) / 2
        expect(s.evidence).toContain("faults caught 1 of 4");
    });
});

describe("links and sources", () => {
    it("requirement relevance: a requirement or trusted rule 1, only unconfirmed inferred rules 0.5, nothing 0, no context not measurable", () => {
        expect(of(scoreTest({ spec: happy }), "requirementRelevance").score).toBeNull();
        const linked = spec(happy.steps, { source: { origin: "browser-agent", requirements: ["REQ-4"] } });
        expect(of(scoreTest({ spec: linked, knownRequirements: new Set(["REQ-4"]) }), "requirementRelevance").score).toBe(1);
        expect(of(scoreTest({ spec: linked, knownRequirements: new Set(["REQ-9"]) }), "requirementRelevance").score).toBe(0);
        expect(of(scoreTest({ spec: happy, rules: RULES, ruleRefs: ["R-2"] }), "requirementRelevance").score).toBe(0.5);
        expect(of(scoreTest({ spec: happy, rules: RULES, ruleRefs: ["R-3"] }), "requirementRelevance").score).toBe(1);
        expect(of(scoreTest({ spec: happy, rules: RULES, ruleRefs: ["R-4"] }), "requirementRelevance").score).toBe(0);
    });

    it("expected-result reliability: the share of outcomes with a stating source; today's tests have none and say so", () => {
        const none = of(scoreTest({ spec: happy }), "expectedResultReliability");
        expect(none.score).toBeNull();
        expect(none.notMeasurable).toMatch(/no source/);
        const s = of(
            scoreTest({
                spec: happy,
                rules: RULES,
                expectedOutcomes: [
                    { text: "Total 30", sourceType: "requirement" },
                    { text: "Shipped stays shipped", sourceType: "inferred", ruleRef: "R-3" },
                    { text: "Looks like the page did", sourceType: "observed" },
                    { text: "Guess", sourceType: "inferred", ruleRef: "R-2" },
                ],
            }),
            "expectedResultReliability",
        );
        expect(s.score).toBe(0.5);
    });
});

describe("inputs", () => {
    it("classifies typed values", () => {
        expect(["", " ", "0", "-3", "2.5", "1000000", "x".repeat(101), "<b>", "名前", "a@b.co", "Anna"].map(classOf)).toEqual(["empty", "whitespace", "zero", "negative", "decimal", "large-number", "long", "special", "unicode", "email", "ordinary"]);
    });

    it("input diversity: distinct classes / 4, {{vars}} resolved from the test's data; not measurable when nothing is typed", () => {
        const t = spec([{ action: "navigate", url: "/" }, { action: "fill", locator: field("Q"), value: "{{q}}" }, { action: "fill", locator: field("N"), value: "Anna" }, { action: "fill", locator: field("E"), value: "a@b.co" }, { action: "assert", check: "visible", locator: btn("Ok") }], { testData: { q: "-1" } });
        expect(of(scoreTest({ spec: t }), "inputDiversity")).toMatchObject({ score: 0.75, evidence: ["class negative", "class ordinary", "class email"] });
        expect(of(scoreTest({ spec: spec([{ action: "navigate", url: "/" }]) }), "inputDiversity").score).toBeNull();
    });

    it("boundary and negative: by type, by a boundary input, or by an asserted rejection", () => {
        expect(boundaryOrNegative(happy)).toEqual([]);
        expect(of(scoreTest({ spec: happy }), "boundaryNegativeCoverage").score).toBe(0);
        expect(boundaryOrNegative(spec(happy.steps, { type: "negative" }))).toEqual(["type negative"]);
        expect(boundaryOrNegative(spec([{ action: "navigate", url: "/" }, { action: "fill", locator: field("Q"), value: "0" }, { action: "assert", check: "accessibleErrorMessage", locator: field("Q"), expected: "at least 1" }]))).toEqual(["input zero", "asserts a validation message"]);
        const api = spec([{ action: "request", method: "POST", path: "/api/cart", body: { quantity: -1 } }, { action: "assertResponse", check: "statusClass", expected: "4xx" }], { kind: "api", testId: "API-002" });
        expect(boundaryOrNegative(api)).toEqual(["expects a 4xx answer"]);
    });
});

describe("running", () => {
    it("reproducibility: own start, no fixed pause, own data", () => {
        expect(of(scoreTest({ spec: happy }), "reproducibility").score).toBe(1);
        const shaky = spec([{ action: "click", locator: btn("Go") }, { action: "wait", ms: 2000 }, { action: "fill", locator: field("Q"), value: "{{fromElsewhere}}" }, { action: "assert", check: "visible", locator: btn("Ok") }]);
        const s = of(scoreTest({ spec: shaky }), "reproducibility");
        expect(s.score).toBe(0);
        expect(s.evidence).toEqual(["does not open its own start", "has a fixed pause", "needs values it does not set: fromElsewhere"]);
        const extracted = spec([{ action: "request", method: "POST", path: "/api/x", extract: { id: "id" } }, { action: "request", method: "GET", path: "/api/x/{{id}}" }, { action: "assertResponse", check: "status", expected: 200 }], { kind: "api", testId: "API-003" });
        expect(of(scoreTest({ spec: extracted }), "reproducibility").score).toBe(1);
    });

    it("execution stability: agreement with the most common verdict over 3+ runs that ran", () => {
        expect(of(scoreTest({ spec: happy, runs: [true, true] }), "executionStability").score).toBeNull();
        expect(of(scoreTest({ spec: happy, runs: [true, false, true, true, null] }), "executionStability")).toMatchObject({ score: 0.75, evidence: ["3 passed, 1 failed of 4"] });
        expect(of(scoreTest({ spec: happy, runs: [false, false, false] }), "executionStability").score).toBe(1);
    });
});

describe("the suite", () => {
    it("coverage of workflows, trusted rules and transitions; not measurable without a model", () => {
        const tests = [
            { spec: happy, workflows: ["checkout"], ruleRefs: ["R-1"] },
            { spec: spec(happy.steps, { type: "boundary" }), workflows: ["cart"], ruleRefs: ["R-3"] },
        ];
        const s = scoreSuite({ tests, workflows: ["checkout", "cart", "orders", "signin"], rules: RULES });
        expect(of(s, "workflowCoverage").score).toBe(0.5);
        // Trusted: R-1 (explicit), R-3 (confirmed); R-2 is an unconfirmed guess and R-4 was rejected.
        expect(of(s, "businessRuleCoverage")).toMatchObject({ score: 1, evidence: ["R-1: covered", "R-3: covered"] });
        expect(of(s, "stateTransitionCoverage").score).toBe(1);
        expect(of(s, "boundaryNegativeCoverage").score).toBe(0.5);
        const bare = scoreSuite({ tests: [{ spec: happy }] });
        expect(of(bare, "workflowCoverage").score).toBeNull();
        expect(of(bare, "businessRuleCoverage").score).toBeNull();
        expect(of(bare, "stateTransitionCoverage").score).toBeNull();
    });

    it("names every one of the ten dimensions between the test and suite scores", () => {
        const names = new Set([...scoreTest({ spec: happy }), ...scoreSuite({ tests: [{ spec: happy }] })].map((s) => s.dimension));
        expect([...names].sort()).toEqual([...DIMENSIONS].sort());
        for (const s of [...scoreTest({ spec: happy }), ...scoreSuite({ tests: [{ spec: happy }] })]) {
            expect(s.method.length).toBeGreaterThan(10);
            if (s.score === null) expect(s.notMeasurable).toBeTruthy();
            else expect(s.score).toBeGreaterThanOrEqual(0);
        }
    });
});
