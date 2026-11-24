/**
 * Phase 5 B1: verification scoring of one trial (eval/bench/verify-score.ts) on a hand-built trial whose values are worked out by hand
 * below; a trial without verification data, or a criterion without its own input, is "not measured", never 0.
 */
import { describe, expect, it } from "vitest";
import type { BenchAppResult } from "../src/eval/bench/schema.js";
import { REPORT_FIELDS, verificationOf, verifyScore, type Verification, type VerifiedFinding } from "../src/eval/bench/verify-score.js";

const b = (id: string, category: string, defects: string[] = [], label?: string) => ({ id, category, defects, ...(label ? { label } : {}) });
const trial = {
    findings: [b("t1", "confirmed", ["BS-01"]), b("t2", "confirmed", ["BS-02"]), b("t3", "false_positive"), b("t4", "false_positive", [], "false_positive"), b("t5", "unreproduced", [], "BS-03"), b("t6", "false_positive")],
    metrics: { precision: 0.4, cost: 2, durationMs: 1000 },
} as unknown as BenchAppResult;

const full = Object.fromEntries(REPORT_FIELDS.map((k) => [k, `the ${k}`])) as Record<string, string>;
const f = (id: string, testId: string, o: Partial<VerifiedFinding>): VerifiedFinding => ({ id, testId, state: "candidate", reason: null, groupId: null, findingClass: null, confidence: null, ...o });
const SHOP = "examples/bench-shop/server.mjs";
const verification: Verification = {
    findings: [
        f("f1", "t1", { state: "confirmed", reason: "Reproduced 3 of 3", groupId: "g1", findingClass: "app_defect", confidence: "high", report: { ...full, likelyCause: "unknown: the project has no code source" }, rootCause: { label: "strongly_supported", locations: [{ path: `/repo/${SHOP}`, fn: "priced", exists: true }] } }),
        f("f2", "t2", { state: "unconfirmed", findingClass: "open", confidence: "medium" }),
        f("f3", "t3", { state: "confirmed", reason: "A person confirmed it", groupId: "g3", findingClass: "app_defect", confidence: "medium", report: { ...full, evidence: "" }, rootCause: { label: "hypothesis", locations: [{ path: "src/nowhere.js", line: 9, exists: false }] } }),
        f("f4", "t4", { state: "not_a_bug", reason: "The page is right", findingClass: "incorrect_expectation" }),
        f("f5", "t5", { groupId: "g1", findingClass: "open" }),
        f("f6", "t6", { state: "automation_issue", reason: "The step is wrong", findingClass: "app_defect" }),
    ],
    added: { cost: 0.2, durationMs: 250 },
};
const seedLocations = [{ seed: "BS-01", file: SHOP, line: 142, handler: "priced", routes: ["GET /api/cart"] }];

describe("verifyScore", () => {
    it("gives the hand-computed values", () => {
        const s = verifyScore(trial, verification, { seedLocations, describesSeed: ["t6"] });
        // Confirmed groups g1 (harness: t1 confirmed) and g3 (t3 a false positive): 1 of 2.
        expect(s.V1).toEqual({ measured: true, value: 0.5, n: 2, listPrecision: 0.4 });
        // Harness-confirmed t1 (Confirmed) and t2 (Unconfirmed, no reason).
        expect(s.V2).toEqual({ measured: true, value: 0.5, n: 2, unconfirmedWithoutReason: ["t2"] });
        // f2 has no reason, f5 is still a candidate.
        expect(s.V3).toEqual({ measured: true, value: 4 / 6, n: 6, silent: ["f2", "f5"] });
        // False positives t3 (app defect) and t4 (incorrect expectation); t6 describes a seed. Labels t4 (right) and t5 (seeded, open).
        expect(s.V4).toEqual({ measured: true, fp: { value: 0.5, n: 2, decided: 0.5 }, labelled: { value: 0.5, n: 2, decided: 0.5 } });
        // g1 holds BS-01 (t1) and BS-03 (t5's label): mixed; BS-02 in f2's own group.
        expect(s.V5).toEqual({ measured: true, mixed: 1, groupsPerSeed: { "BS-01": 1, "BS-03": 1, "BS-02": 1 }, median: 1 });
        expect(s.V6).toEqual({ measured: true, confirmedBelowHigh: 1, securityWithoutH5: 0 });
        // g1's BS-01 is located at priced(): f1 is Strongly supported there. f3 cites a file that does not exist.
        expect(s.V7).toEqual({ measured: true, invented: 1, value: 1, n: 1 });
        expect(s.V8).toEqual({ measured: true, value: 0.5, n: 2, incomplete: ["f3"] });
        expect(s.V11).toEqual({ measured: true, cost: 0.1, time: 0.25 });
    });

    it("counts a route handler that reaches the seed, and a security finding Confirmed critical without H5", () => {
        const g = { ...verification, findings: [f("f1", "t1", { state: "confirmed", reason: "r", findingClass: "app_defect", confidence: "high", security: { severity: "critical", reproduced: false }, rootCause: { label: "verified", locations: [{ path: "x", route: "GET /api/cart", exists: true }] } })] };
        const s = verifyScore(trial, g, { seedLocations });
        expect(s.V7).toMatchObject({ measured: true, value: 1, invented: 0 });
        expect(s.V6).toEqual({ measured: true, confirmedBelowHigh: 0, securityWithoutH5: 1 });
        const hypothesis = { ...g, findings: [{ ...g.findings[0]!, rootCause: { ...g.findings[0]!.rootCause!, label: "hypothesis" as const } }] };
        expect(verifyScore(trial, hypothesis, { seedLocations }).V7).toMatchObject({ value: 0 });
    });

    it("counts a root cause at any of a seed's lines (BS-10 sits in the order API and in the review page)", () => {
        const one = { ...trial, findings: [b("t1", "confirmed", ["BS-10"])] } as unknown as BenchAppResult;
        // paid shop API-060: located at POST /api/orders, BS-10's first line.
        const v = { ...verification, findings: [f("f1", "t1", { state: "confirmed", reason: "r", groupId: "g", findingClass: "app_defect", confidence: "high", rootCause: { label: "strongly_supported", locations: [{ path: SHOP, line: 311, fn: "api", route: "POST /api/orders", exists: true }] } })] };
        const lines = [
            { seed: "BS-10", file: SHOP, line: 302, handler: "api", routes: ["POST /api/orders"] },
            { seed: "BS-10", file: SHOP, line: 413, handler: "pages", routes: ["GET (page) /checkout/review"] },
        ];
        // One group of one seed: 1 of 1, whichever line comes last in seed-locations.json.
        expect(verifyScore(one, v, { seedLocations: lines }).V7).toEqual({ measured: true, invented: 0, value: 1, n: 1 });
        expect(verifyScore(one, v, { seedLocations: [...lines].reverse() }).V7).toEqual({ measured: true, invented: 0, value: 1, n: 1 });
    });

    it("counts every reported false positive in V4, and one left without a class as not classed not an app defect", () => {
        const fps = { ...trial, findings: [b("u1", "false_positive"), b("u2", "false_positive"), b("u3", "false_positive"), b("u4", "false_positive")] } as unknown as BenchAppResult;
        // u1 classed incorrect expectation, u2 an app defect, u3 left unresolved (stored class null); u4 was never reported (no platform finding).
        const v = { ...verification, findings: [f("g1", "u1", { state: "not_a_bug", reason: "r", findingClass: "incorrect_expectation" }), f("g2", "u2", { state: "confirmed", reason: "r", findingClass: "app_defect" }), f("g3", "u3", { state: "unconfirmed", reason: "r" })] };
        expect(verifyScore(fps, v, { describesSeed: [] }).V4).toMatchObject({ measured: true, fp: { value: 1 / 3, n: 3, decided: 1 / 3 } });
    });

    it("calls a group mixed only when it holds findings pinned to different seeds, not a finding whose pin names several", () => {
        const pins = { ...trial, findings: [b("p1", "confirmed", ["BS-06", "BS-18"]), b("p2", "confirmed", ["BS-07", "BS-18"]), b("p3", "confirmed", ["BS-01"]), b("p4", "confirmed", ["BS-02"])] } as unknown as BenchAppResult;
        const v = (groups: Array<string | null>) => ({ ...verification, findings: groups.map((g, i) => f(`q${i + 1}`, `p${i + 1}`, { state: "confirmed", reason: "r", groupId: g })) });
        // Each finding alone, p1 and p2 each pinned to two seeds: no group mixes seeds.
        expect(verifyScore(pins, v([null, null, null, null])).V5).toMatchObject({ mixed: 0 });
        // p1 and p2 share BS-18: one seed they agree on, not mixed. p3 and p4 are pinned to different seeds: mixed.
        expect(verifyScore(pins, v(["g1", "g1", "g2", "g2"])).V5).toMatchObject({ mixed: 1 });
    });

    it("allows unknown only for the likely cause, and only with a reason", () => {
        const one = (report: Record<string, string>) => verifyScore(trial, { ...verification, findings: [f("f1", "t1", { state: "confirmed", reason: "r", confidence: "high", report })] }).V8;
        expect(one({ ...full, likelyCause: "Unknown — no code source is connected" })).toMatchObject({ value: 1 });
        expect(one({ ...full, likelyCause: "unknown" })).toMatchObject({ value: 0 });
        expect(one({ ...full, area: "unknown: not recorded" })).toMatchObject({ value: 0 });
    });

    it("says not measured, never 0, when the trial or a criterion has no data", () => {
        const none = verifyScore(trial, undefined);
        for (const [k, m] of Object.entries(none)) expect(m, k).toEqual({ measured: false, why: "The trial has no verification data." });
        const bare = verifyScore(trial, { findings: verification.findings.map(({ report: _r, rootCause: _c, ...x }) => x), added: { cost: null, durationMs: null } }, { seedLocations });
        expect(bare.V7).toEqual({ measured: false, why: "No finding has a root cause (C2)." });
        expect(bare.V8).toEqual({ measured: false, why: "No Confirmed finding has a report (C3)." });
        expect(bare.V11.measured).toBe(false);
        expect(verifyScore(trial, verification).V7).toEqual({ measured: false, why: "No seed locations were given." });
        // Measured, but nothing to divide by: null with a sentence.
        expect(verifyScore(trial, { findings: [], added: verification.added }).V1).toEqual({ measured: true, value: null, n: 0, note: "Nothing was Confirmed.", listPrecision: 0.4 });
    });
});

describe("verificationOf", () => {
    it("reads each stored finding with its last event's reason", async () => {
        const rows = [{ id: "f1", testId: "t1", state: "confirmed", groupId: "g1", findingClass: "app_defect", confidenceDetail: { confidence: "high" } }, { id: "f2", testId: null, state: "candidate", groupId: null, findingClass: null, confidenceDetail: null }];
        const events: Record<string, Array<{ reason: string | null }>> = { f1: [{ reason: "first" }, { reason: "Reproduced 3 of 3" }], f2: [] };
        const store = { list: async () => rows, history: async (_p: string, id: string) => events[id] } as never;
        const v = await verificationOf(store, "p1", { cost: 0.1, durationMs: 5 });
        expect(v).toEqual({
            findings: [
                { id: "f1", testId: "t1", state: "confirmed", reason: "Reproduced 3 of 3", groupId: "g1", findingClass: "app_defect", confidence: "high" },
                { id: "f2", testId: null, state: "candidate", reason: null, groupId: null, findingClass: null, confidence: null },
            ],
            added: { cost: 0.1, durationMs: 5 },
        });
    });
});
