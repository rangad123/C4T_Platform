/**
 * The risk score, "full run recommended" and the focused set (src/platform/selection/risk.ts, preview.ts). Pure: coverage is written here.
 * Each factor's points come from the table in risk.ts's header; each test moves one factor and pins its points.
 */
import { describe, expect, it } from "vitest";
import type { CoverageItem, TestCoverage } from "../src/platform/selection/coverage.js";
import { focusedSelection, previewSelection, readChanges } from "../src/platform/selection/preview.js";
import { fullRunRecommendation, NO_FACTS, riskOf, type RiskFacts } from "../src/platform/selection/risk.js";

const pointsOf = (impact: number, f: Partial<RiskFacts> = {}) => Object.fromEntries(riskOf(impact, { ...NO_FACTS, ...f }).factors.map((x) => [x.factor, x.points]));
const ep = (method: string, path: string): CoverageItem => ({ kind: "endpoint", method: method as CoverageItem["method"], path, query: [], source: "declared", seenIn: ["step 1"] });
const test = (id: string, items: CoverageItem[], completeness: TestCoverage["completeness"] = "declared-complete"): TestCoverage => ({ testId: id, testKey: id, title: id, kind: "api", items, completeness, limits: completeness === "partial" ? ["It opens pages by clicking."] : [] });

describe("each factor of the risk score", () => {
    it("change impact: 3 points per entry of the change reached, at most 3 entries", () => {
        expect([0, 1, 2, 3, 4].map((n) => pointsOf(n)["change impact"])).toEqual([0, 3, 6, 9, 9]);
    });

    it("business criticality: the test's priority, critical 4, high 3, medium 1, low 0, anything else 0", () => {
        expect(["critical", "HIGH", "medium", "low", "urgent", undefined].map((priority) => pointsOf(0, { priority })["business criticality"])).toEqual([4, 3, 1, 0, 0, 0]);
    });

    it("failure rate: the share of recent runs that did not pass, out of 4; nothing without runs", () => {
        expect(pointsOf(0, { runs: 4, failed: 1 })["failure rate"]).toBe(1);
        expect(pointsOf(0, { runs: 4, failed: 4 })["failure rate"]).toBe(4);
        expect(pointsOf(0, { runs: 3, failed: 2 })["failure rate"]).toBe(3);
        expect(pointsOf(0, { runs: 0, failed: 0 })["failure rate"]).toBe(0);
    });

    it("previous defects: 2 per finding, at most 3", () => {
        expect([0, 1, 3, 5].map((defects) => pointsOf(0, { defects })["previous defects"])).toEqual([0, 2, 6, 6]);
    });

    it("workflow dependency: 1 per workflow, at most 3", () => {
        expect([0, 2, 3, 7].map((workflows) => pointsOf(0, { workflows })["workflow dependency"])).toEqual([0, 2, 3, 3]);
    });

    it("reliability: quarantined −2, flaky −1, otherwise 0", () => {
        expect(pointsOf(0, { quarantined: true, flaky: true }).reliability).toBe(-2);
        expect(pointsOf(0, { flaky: true }).reliability).toBe(-1);
        expect(pointsOf(0).reliability).toBe(0);
    });

    it("is their sum, with every factor and value named in the reason", () => {
        const r = riskOf(2, { priority: "high", runs: 4, failed: 2, defects: 1, workflows: 2, flaky: true });
        expect(r.score).toBe(6 + 3 + 2 + 2 + 2 - 1);
        expect(r.reason).toBe(
            "Risk 14: change impact 2 entries of the change (+6), business criticality high (+3), failure rate 2 of 4 recent runs did not pass (+2), previous defects 1 finding (+2), workflow dependency 2 workflows (+2), reliability unreliable: its result counts for less, and it stays proposed (−1).",
        );
    });
});

describe("full run recommended (G4)", () => {
    it("when more than 20% of the changed files are unmapped, not at 20%", () => {
        expect(fullRunRecommendation({ files: 5, unmapped: ["a.md"], shared: [] })).toEqual([]);
        const r = fullRunRecommendation({ files: 4, unmapped: ["a.md"], shared: [] });
        expect(r).toEqual(["1 of 4 changed files (25%) reach no route on evidence, more than 20%: a focused run may miss what they change (a.md)."]);
        expect(fullRunRecommendation({ files: 1, unmapped: ["lib/x.ts"], shared: [] })).toHaveLength(1);
    });

    it("when a shared part changed, whatever the share", () => {
        expect(fullRunRecommendation({ files: 10, unmapped: [], shared: ["server.mjs:77 is in userOf(); userOf is used at server.mjs:90, outside every route handler."] })).toEqual([
            "A shared part changed: code that runs outside every route handler reaches every request (server.mjs:77 is in userOf(); userOf is used at server.mjs:90, outside every route handler.).",
        ]);
    });

    it("makes the preview require a full run, even when every test's coverage is known", () => {
        const coverage = [test("A", [ep("POST", "/orders")]), test("B", [ep("GET", "/health")])];
        const { changes } = readChanges({ endpoints: ["POST /orders"] });
        expect(previewSelection(coverage, changes).fullRunRequired).toBe(false);
        const p = previewSelection(coverage, changes, [], { impact: { files: 1, unmapped: ["README.md"], shared: [] } });
        expect(p.fullRunRequired).toBe(true);
        expect(p.fullRunReasons[0]).toMatch(/^1 of 1 changed file \(100%\) reach no route/);
        // a recommendation still: the tests are the same
        expect(p.matched.map((t) => t.testId)).toEqual(["A"]);
    });
});

describe("the preview uses the score", () => {
    const coverage = [test("A", [ep("POST", "/orders")]), test("B", [ep("POST", "/orders"), ep("GET", "/orders")]), test("C", [ep("GET", "/orders")]), test("D", [], "partial")];
    const { changes } = readChanges({ endpoints: ["POST /orders", "GET /orders"] });

    it("orders proposed tests by score (then key), and a quarantined or flaky covering test stays proposed", () => {
        const risk = new Map<string, RiskFacts>([
            ["A", { ...NO_FACTS, priority: "critical" }],
            ["B", { ...NO_FACTS, quarantined: true }],
            ["C", { ...NO_FACTS, flaky: true }],
        ]);
        const p = previewSelection(coverage, changes, [], { risk });
        // A 3+4 = 7, B 6−2 = 4, C 3−1 = 2
        expect(p.matched.map((t) => [t.testId, t.risk!.score])).toEqual([["A", 7], ["B", 4], ["C", 2]]);
        expect(p.unknown.map((t) => [t.testId, t.risk!.score])).toEqual([["D", 0]]);
        expect(p.notMatched).toEqual([]);
    });

    it("scores a test without facts on change impact alone", () => {
        const p = previewSelection(coverage, changes);
        expect(p.matched.map((t) => [t.testId, t.risk!.score])).toEqual([["B", 6], ["A", 3], ["C", 3]]);
    });
});

describe("the focused set", () => {
    const coverage = [test("A", [ep("POST", "/orders")]), test("B", [ep("GET", "/health")]), test("C", [], "partial"), test("E", [ep("POST", "/orders")])];

    it("is every proposed test (matched and unknown) that can run, never one outside the runnable set", () => {
        const f = focusedSelection(coverage, new Set(["A", "B", "C"]), { endpoints: ["POST /orders"] }, {});
        expect(f.testIds.sort()).toEqual(["A", "C"]);
        expect(f.fullRunReasons.join(" ")).toMatch(/not fully known/);
    });
});
