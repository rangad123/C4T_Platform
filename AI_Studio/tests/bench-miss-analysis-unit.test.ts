/**
 * Phase 7 B4: miss analysis (eval/bench/miss-analysis.ts) on a hand-built trial. Each missed seed's stage follows ROW233's rules (which
 * replay a sighting failed, which engine event held it back, whether a rule or a layer reached the run); each false positive gets a source.
 */
import { describe, expect, it } from "vitest";
import type { SavedTrial } from "../src/eval/bench/effectiveness.js";
import { mainStage, mainStages, missAnalysis } from "../src/eval/bench/miss-analysis.js";
import type { BenchAppResult } from "../src/eval/bench/schema.js";

const replay = (seeded: string, clean: string | null) => ({ seeded, clean, single: {} });
const finding = (id: string, testKey: string, category: string, r: ReturnType<typeof replay>, extra: object = {}) => ({ id, testKey, category, defects: [], replay: r, source: "authoring", ...extra });
const seeds = ["BS-01", "BS-03", "BS-05", "BS-07", "BS-09", "BS-12", "BS-13"];
const trial = {
    seededDefects: seeds,
    defects: seeds.map((id) => ({ id, category: id === "BS-13" ? "frontend-api-consistency" : "x", detected: false })).concat([{ id: "BS-02", category: "calculation", detected: true }]),
    findings: [
        // BS-03 observed only (seeded replay passes): weak assertion.
        finding("t1", "WEB-001", "unreproduced", replay("passed", null), { capture: "observed_only" }),
        // BS-12 seen twice, failing on the clean app too: reproduction failed; once more as weak.
        finding("t2", "WEB-002", "false_positive", replay("failed", "failed")),
        finding("t3", "WEB-003", "false_positive", replay("failed", "failed")),
        finding("t4", "WEB-004", "unreproduced", replay("passed", null)),
        // False positives with no seed: one with leftovers (state), one citing no requirement (assumption), one citing one (observation),
        // and one the engine itself did not report (left out).
        finding("t6", "WEB-006", "false_positive", replay("failed", "failed")),
        finding("t7", "WEB-007", "false_positive", replay("failed", "failed")),
        finding("t8", "WEB-008", "false_positive", replay("failed", "failed")),
        finding("t9", "WEB-009", "false_positive", replay("failed", "failed"), { reason: "Not reported as a finding: it depends on earlier state" }),
    ],
} as unknown as BenchAppResult;
const test = (id: string, key: string, title: string, observed: string, meta: object = {}, validationStatus = "NEEDS_REVIEW") => ({ id, key, title, validationStatus, validationReason: null, meta: { authoring: "defect", explanation: `Steps. Observed: ${observed}`, ...meta } });
const orders = "Opening /orders afterwards does not list ord-1018.";
const saved: SavedTrial = {
    tests: [
        test("t1", "WEB-001", "Quantity above 10 is refused", "entered quantity 11 and the app accepted it."),
        test("t2", "WEB-002", "Orders list", orders),
        test("t3", "WEB-003", "Orders list again", orders),
        test("t4", "WEB-004", "Orders list once more", orders),
        // BS-07 never became a finding: its own-steps replay stopped.
        test("t5", "WEB-005", "Place order twice", "clicked Place order again: placed a second order ord-1010.", {}, "FAILED_VALIDATION"),
        test("t6", "WEB-006", "Cart", "nothing seeded", { leftovers: [{ step: 3, what: "uses ord-1003" }], scenario: { requirements: ["3.1"] } }),
        test("t7", "WEB-007", "Cart", "nothing seeded", { scenario: { title: "Cart" } }),
        test("t8", "WEB-008", "Cart", "nothing seeded", { scenario: { requirements: ["4.4"] } }),
        test("t9", "WEB-009", "Cart", "nothing seeded"),
    ],
    events: [{ jobId: "j", kind: "defect_unverified", message: "WEB-005 Place order: not reported as a finding", data: { testKey: "WEB-005" }, at: "2026-11-20T10:00:00.000Z" }],
    // 4.1 (BS-01) and 3.4 (BS-09) reached the planner; 6.8 (BS-05) did not.
    rules: [
        { ref: "R-1", sourceRef: "4.1" },
        { ref: "R-2", sourceRef: "3.4" },
    ],
    coverage: null,
    layers: { page: { status: "ran", tests: 9 }, api: { status: "unavailable", reason: "Not checked: no API test was made." }, storedData: { status: "unavailable", reason: "x" }, database: { status: "unavailable", reason: "y" } },
};
const catalogue = [{ id: "BS-13", category: "frontend-api-consistency", requirement: "3.12" }];

describe("missAnalysis", () => {
    const m = missAnalysis(trial, saved, catalogue);
    const stage = (id: string) => m.seeds.find((s) => s.seed === id);

    it("gives each missed seed its stage, and leaves a detected one out", () => {
        expect(m.seeds.map((s) => s.seed)).toEqual(seeds);
        expect(stage("BS-03")).toMatchObject({ stage: "weak_assertion", sightings: [{ testKey: "WEB-001", stage: "weak_assertion", detail: "observed only: no failing check saved" }] });
        // 2 reproduction failed, 1 weak.
        expect(stage("BS-12")).toMatchObject({ stage: "reproduction_failed", detail: "2 of 3 sightings" });
        expect(stage("BS-12")!.sightings.map((s) => s.detail)).toEqual(["fails on the clean app too (leans on earlier state)", "fails on the clean app too (leans on earlier state)", "its saved check passes on the seeded app"]);
        expect(stage("BS-07")).toMatchObject({ stage: "not_executed", sightings: [{ testKey: "WEB-005", stage: "not_executed" }] });
        // No sighting: the rule was there (not generated) or not (context insufficient); BS-13's api layer was not checked.
        expect(stage("BS-01")).toMatchObject({ stage: "not_generated", sightings: [] });
        expect(stage("BS-09")).toMatchObject({ stage: "not_generated" });
        expect(stage("BS-05")).toMatchObject({ stage: "context_insufficient", detail: "no rule from requirement 6.8 reached the planner" });
        expect(stage("BS-13")).toMatchObject({ stage: "layer_unavailable", detail: "api: Not checked: no API test was made." });
    });

    it("gives each reported false positive its source", () => {
        expect(m.falsePositives).toEqual([
            { testKey: "WEB-002", source: "state", detail: "its author saw BS-12; it fails on the clean app too" },
            { testKey: "WEB-003", source: "state", detail: "its author saw BS-12; it fails on the clean app too" },
            { testKey: "WEB-006", source: "state", detail: "leans on what the account held before the test" },
            { testKey: "WEB-007", source: "assumption", detail: "its expectation cites no requirement" },
            { testKey: "WEB-008", source: "observation", detail: "a stated expectation the app meets: the check or the observation was wrong" },
        ]);
    });

    it("says misclassified when Phase 5 classed the finding as no app defect, and context insufficient without rules", () => {
        const v = { findings: [{ id: "f1", testId: "t1", state: "unconfirmed", reason: "r", groupId: null, findingClass: "test_fault", confidence: null }], added: { cost: null, durationMs: null } };
        const c = missAnalysis({ ...trial, verification: v } as BenchAppResult, { ...saved, rules: null }, catalogue);
        expect(c.seeds.find((s) => s.seed === "BS-03")).toMatchObject({ stage: "misclassified", detail: "1 of 1 sightings" });
        expect(c.seeds.find((s) => s.seed === "BS-01")).toMatchObject({ stage: "context_insufficient" });
        // Without a layer report BS-13 falls back to its requirement: 3.12 has no rule.
        expect(missAnalysis(trial, { ...saved, layers: null }, catalogue).seeds.find((s) => s.seed === "BS-13")).toMatchObject({ stage: "context_insufficient", detail: "no rule from requirement 3.12 reached the planner" });
    });

    it("counts a person's label as a sighting, and an engine-held state test as reproduction failed", () => {
        const labelled = { ...trial, findings: [finding("t1", "WEB-001", "unreproduced", replay("passed", null), { label: "BS-05" })] } as unknown as BenchAppResult;
        const held = { ...saved, tests: [test("t1", "WEB-001", "Shipped order", "nothing"), test("t5", "WEB-005", "Place order twice", "placed a second order ord-1010.", {}, "NEEDS_REVIEW")], events: [{ jobId: "j", kind: "depends_on_earlier_state", message: "WEB-005 held", data: null, at: "x" }] };
        const m2 = missAnalysis(labelled, held, catalogue);
        expect(m2.seeds.find((s) => s.seed === "BS-05")).toMatchObject({ stage: "weak_assertion", sightings: [{ testKey: "WEB-001" }] });
        expect(m2.seeds.find((s) => s.seed === "BS-07")).toMatchObject({ stage: "reproduction_failed", sightings: [{ detail: "held back: depends on earlier state" }] });
    });
});

describe("mainStage / mainStages", () => {
    it("takes the most sightings, a tie going to the later stage", () => {
        expect(mainStage({ weak_assertion: 3, reproduction_failed: 3 })).toBe("reproduction_failed");
        expect(mainStage({ weak_assertion: 4, reproduction_failed: 3 })).toBe("weak_assertion");
        expect(mainStage({})).toBe("not_generated");
    });

    it("sums sightings over trials; a seed never sighted takes its most frequent trial stage", () => {
        const s = (seed: string, stage: string, sightings: string[] = []) => ({ seed, stage, detail: "", sightings: sightings.map((x) => ({ testKey: "k", stage: x, detail: "" })) });
        const got = mainStages([
            { seeds: [s("A", "weak_assertion", ["weak_assertion"]), s("B", "context_insufficient")], falsePositives: [] },
            { seeds: [s("A", "not_executed", ["not_executed", "not_executed"]), s("B", "not_generated")], falsePositives: [] },
            { seeds: [s("A", "not_generated"), s("B", "not_generated")], falsePositives: [] },
        ] as never);
        expect(got).toEqual({ A: "not_executed", B: "not_generated" });
    });
});
