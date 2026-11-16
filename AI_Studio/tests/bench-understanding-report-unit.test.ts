/**
 * The understanding benchmark's report (src/eval/bench/understanding/report.ts): median and range per criterion, per app, for one input
 * configuration; a verdict of pass, fail or inconclusive (the range overlaps the threshold); error and work counts per run; a missing or
 * failed trial makes the series incomplete and no criterion passes. Expected numbers are worked out by hand.
 */
import { describe, expect, it } from "vitest";
import { buildReport, renderReportMd, stat, verdictAtLeast, verdictAtMost, type TrialResult } from "../src/eval/bench/understanding/report.js";
import type { UnderstandingScore } from "../src/eval/bench/understanding/score.js";

const r = (found: number, total: number) => ({ found, total, value: total ? found / total : null, missed: [] });
/** A score where every criterion is met, with the given overrides. */
function score(over: { screens?: number; endpoints?: number; extraDocumented?: number; workflows?: number; anyRules?: number; citing?: number; explicitContradicting?: number; explicitUnreviewed?: number } = {}): UnderstandingScore {
    const of10 = (v: number | undefined, d: number) => r(Math.round((v ?? d) * 10), 10);
    return {
        app: "x-shop",
        answerKeySha256: "a".repeat(64),
        screens: of10(over.screens, 1),
        endpoints: { ...of10(over.endpoints, 1), documentedNotInDocument: Array.from({ length: over.extraDocumented ?? 0 }, (_, i) => `GET /x${i}`) },
        workflows: { ...of10(over.workflows, 1), needsJudgement: [] },
        defectRules: { any: of10(over.anyRules, 1), explicitCiting: of10(over.citing, 1), links: {}, needsJudgement: [] },
        provenance: { ...r(4, 4), confirmedWithoutPerson: [], fromObserved: [] },
        wrongRules: {
            explicit: { total: 20, reviewed: 20 - (over.explicitUnreviewed ?? 0), contradicting: over.explicitContradicting ?? 0, rate: (over.explicitContradicting ?? 0) / (20 - (over.explicitUnreviewed ?? 0)), unreviewed: Array.from({ length: over.explicitUnreviewed ?? 0 }, (_, i) => `R-${i}`) },
            inferred: { total: 0, reviewed: 0, contradicting: 0, rate: null, unreviewed: [] },
        },
    };
}
const trial = (engine: "baseline" | "candidate", n: number, s: UnderstandingScore | undefined, counts: TrialResult["counts"] = { aiCalls: 10, failedCalls: 0, pages: 8 }, inputs: "url" | "full" = "url"): TrialResult => ({
    app: "x-shop",
    inputs,
    engine,
    trial: n,
    status: s ? "completed" : "failed",
    ...(s ? { score: s } : { error: "The analysis job failed." }),
    counts,
});
const series = (cand: number[], base: number[], inputs: "url" | "full" = "url") => [
    ...cand.map((w, i) => trial("candidate", i + 1, score({ workflows: w }), undefined, inputs)),
    ...base.map((w, i) => trial("baseline", i + 1, score({ workflows: w }), undefined, inputs)),
];
const criterion = (rep: ReturnType<typeof buildReport>, id: string) => rep.apps[0].criteria.find((c) => c.id === id)!;

describe("median and range", () => {
    it("odd count: the middle value; even count: the mean of the two middle values", () => {
        expect(stat([0.8, 1, 0.9, 0.95, 0.85])).toEqual({ n: 5, median: 0.9, min: 0.8, max: 1 });
        expect(stat([4, 1, 3, 2])).toEqual({ n: 4, median: 2.5, min: 1, max: 4 });
    });
});

describe("verdicts", () => {
    it("at least a threshold: pass when the whole range meets it, fail when none does, inconclusive when the range overlaps it", () => {
        expect(verdictAtLeast([0.9, 0.95, 1], 0.9)).toBe("pass");
        expect(verdictAtLeast([0.85, 0.95, 1], 0.9)).toBe("inconclusive");
        expect(verdictAtLeast([0.5, 0.8, 0.89], 0.9)).toBe("fail");
    });
    it("at most a threshold, the same way", () => {
        expect(verdictAtMost([0, 0.05], 0.05)).toBe("pass");
        expect(verdictAtMost([0, 0.1], 0.05)).toBe("inconclusive");
        expect(verdictAtMost([0.06, 0.1], 0.05)).toBe("fail");
    });
});

describe("a complete url series", () => {
    it("U3 passes only when at least 80% and the whole candidate range is above the Baseline-U range", () => {
        const rep = buildReport({ inputs: "url", repeat: 5, apps: ["x-shop"], trials: series([0.8, 0.9, 0.9, 1, 0.9], [0.5, 0.6, 0.5, 0.6, 0.7]) });
        expect(rep.complete).toBe(true);
        const u3 = criterion(rep, "U3");
        expect(u3.candidate).toEqual({ n: 5, median: 0.9, min: 0.8, max: 1 });
        expect(u3.baseline).toEqual({ n: 5, median: 0.6, min: 0.5, max: 0.7 });
        expect(u3.verdict).toBe("pass");
    });
    it("U3 is inconclusive when the candidate range overlaps the baseline range, and fails when it is wholly at or below it", () => {
        expect(criterion(buildReport({ inputs: "url", repeat: 5, apps: ["x-shop"], trials: series([0.8, 0.9, 0.9, 1, 0.9], [0.5, 0.6, 0.8, 0.6, 0.7]) }), "U3").verdict).toBe("inconclusive");
        expect(criterion(buildReport({ inputs: "url", repeat: 5, apps: ["x-shop"], trials: series([0.8, 0.8, 0.8, 0.8, 0.8], [0.8, 0.9, 0.9, 0.9, 0.9]) }), "U3").verdict).toBe("fail");
    });
    it("U3 without a Baseline-U series is inconclusive", () => {
        const rep = buildReport({ inputs: "url", repeat: 5, apps: ["x-shop"], trials: series([1, 1, 1, 1, 1], []) });
        expect(criterion(rep, "U3").verdict).toBe("inconclusive");
    });
    it("in url, U2 and U4 are reported without a target", () => {
        const rep = buildReport({ inputs: "url", repeat: 5, apps: ["x-shop"], trials: series([1, 1, 1, 1, 1], [0, 0, 0, 0, 0]) });
        expect(criterion(rep, "U2").verdict).toBe("reported");
        expect(criterion(rep, "U4").verdict).toBe("reported");
    });
});

describe("a full series", () => {
    it("U2 needs every documented operation and no invented documented one; U4 needs 80% explicit citing", () => {
        const trials = [1, 2, 3, 4, 5].flatMap((n) => [
            trial("candidate", n, score({ endpoints: 1, extraDocumented: n === 3 ? 1 : 0, citing: n === 5 ? 0.7 : 0.9 }), undefined, "full"),
            trial("baseline", n, score(), undefined, "full"),
        ]);
        const rep = buildReport({ inputs: "full", repeat: 5, apps: ["x-shop"], trials });
        expect(criterion(rep, "U2").verdict).toBe("pass");
        // documented-not-in-document counts 0,0,1,0,0: range 0–1 against "at most 0" → overlaps → inconclusive.
        expect(criterion(rep, "U2-extra")).toMatchObject({ candidate: { median: 0, min: 0, max: 1 }, verdict: "inconclusive" });
        // citing 0.9 ×4 and 0.7: range 0.7–0.9 overlaps 0.8.
        expect(criterion(rep, "U4")).toMatchObject({ candidate: { median: 0.9, min: 0.7, max: 0.9 }, verdict: "inconclusive" });
        expect(criterion(rep, "U3").verdict).toBe("pass");
    });
    it("a series mixing url and full is refused", () => {
        const trials = [...series([1, 1, 1, 1, 1], [], "full"), trial("baseline", 1, score(), undefined, "url")];
        expect(() => buildReport({ inputs: "full", repeat: 5, apps: ["x-shop"], trials })).toThrow(/url.*full|full.*url/);
    });
});

describe("U6 wrong explicit rules", () => {
    it("at most 5% contradicting; an unreviewed explicit rule makes it inconclusive", () => {
        const five = (s: UnderstandingScore) => [1, 2, 3, 4, 5].map((n) => trial("candidate", n, s));
        const ok = buildReport({ inputs: "url", repeat: 5, apps: ["x-shop"], trials: five(score({ explicitContradicting: 1 })) });
        expect(criterion(ok, "U6").verdict).toBe("pass"); // 1 / 20 = 5%
        const unreviewed = buildReport({ inputs: "url", repeat: 5, apps: ["x-shop"], trials: five(score({ explicitUnreviewed: 2 })) });
        expect(criterion(unreviewed, "U6")).toMatchObject({ verdict: "inconclusive" });
        expect(criterion(unreviewed, "U6").why).toMatch(/2 explicit rules not reviewed/);
    });
});

describe("too few trials or nothing to measure", () => {
    const allMet = (n: number) => [...Array.from({ length: n }, (_, i) => trial("candidate", i + 1, score({ workflows: 1 }))), ...Array.from({ length: n }, (_, i) => trial("baseline", i + 1, score({ workflows: 0.5 })))];
    it("fewer than 5 trials per side: nothing passes, and the report says so first", () => {
        const rep = buildReport({ inputs: "url", repeat: 4, apps: ["x-shop"], trials: allMet(4) });
        expect(rep.complete).toBe(true);
        expect(rep.apps[0].criteria.filter((c) => c.verdict === "pass")).toEqual([]);
        expect(criterion(rep, "U1")).toMatchObject({ verdict: "inconclusive", why: "fewer than 5 trials per side" });
        expect(renderReportMd(rep).split("\n").find((l) => l.trim() && !l.startsWith("#"))).toMatch(/^\*\*Smoke series: fewer than 5 trials per side/);
    });
    it("the same series with 5 trials passes (the rule above is about the count)", () => {
        expect(criterion(buildReport({ inputs: "url", repeat: 5, apps: ["x-shop"], trials: allMet(5) }), "U1").verdict).toBe("pass");
    });
    it("no rules at all: U5, its two counts and U6 are inconclusive, never pass", () => {
        const noRules = (): UnderstandingScore => ({
            ...score(),
            provenance: { found: 0, total: 0, value: null, missed: [], confirmedWithoutPerson: [], fromObserved: [] },
            wrongRules: { explicit: { total: 0, reviewed: 0, contradicting: 0, rate: null, unreviewed: [] }, inferred: { total: 0, reviewed: 0, contradicting: 0, rate: null, unreviewed: [] } },
        });
        const rep = buildReport({ inputs: "url", repeat: 5, apps: ["x-shop"], trials: [1, 2, 3, 4, 5].map((n) => trial("candidate", n, noRules())) });
        for (const id of ["U5", "U5-confirmed", "U5-observed", "U6"]) expect(criterion(rep, id), id).toMatchObject({ verdict: "inconclusive" });
    });
    it("U7 passes only when decisions, the no-change rerun and the one-change rerun were all measured", () => {
        const inc = (over: object) => ({ ...score(), incremental: { decisions: { found: 2, total: 2, value: 1, missed: [] }, kept: { found: 2, total: 2, value: 1, missed: [] }, changedText: { decided: 1, carried: [] }, noChange: { newVersion: false, aiCallsForUnchangedSources: 0, ok: true }, oneChanged: { extra: [], missing: [], ok: true }, ...over } });
        const rep = (s: UnderstandingScore) => criterion(buildReport({ inputs: "url", repeat: 5, apps: ["x-shop"], trials: [1, 2, 3, 4, 5].map((n) => trial("candidate", n, s)) }), "U7").verdict;
        expect(rep(inc({}))).toBe("pass");
        expect(rep(inc({ oneChanged: undefined }))).toBe("inconclusive");
        expect(rep(inc({ decisions: { found: 0, total: 0, value: null, missed: [] } }))).toBe("inconclusive");
        // A decision that followed a rule whose source text changed fails U7, whatever the share.
        expect(rep(inc({ changedText: { decided: 1, carried: ["R-9"] } }))).toBe("fail");
        // The carry share is reported beside U7.
        const share = criterion(buildReport({ inputs: "url", repeat: 5, apps: ["x-shop"], trials: [1, 2, 3, 4, 5].map((n) => trial("candidate", n, inc({ decisions: { found: n, total: 10, value: n / 10, missed: [] } }))) }), "U7-carried");
        expect(share.candidate).toEqual({ n: 5, median: 0.3, min: 0.1, max: 0.5 });
    });
});

describe("criteria some trials could not measure", () => {
    const noRules = (): UnderstandingScore => ({ ...score(), provenance: { found: 0, total: 0, value: null, missed: [], confirmedWithoutPerson: [], fromObserved: [] } });
    it("shows the measured trials' median and range with how many of the series were measured, and stays inconclusive", () => {
        // U5 is 1 in trials 1, 3 and 5; trials 2 and 4 stored no rules (nothing to measure).
        const rep = buildReport({ inputs: "full", repeat: 5, apps: ["x-shop"], trials: [1, 2, 3, 4, 5].map((n) => trial("candidate", n, n % 2 ? score() : noRules(), undefined, "full")) });
        const u5 = criterion(rep, "U5");
        expect(u5).toMatchObject({ candidate: { n: 3, median: 1, min: 1, max: 1 }, verdict: "inconclusive" });
        expect(u5.why).toMatch(/3 of 5 measured/);
        expect(renderReportMd(rep)).toMatch(/\| U5 .*\| 1 \(1–1\) \| – \| inconclusive \| 3 of 5 measured/);
    });
    it("with every trial measured nothing changes: the verdict is judged", () => {
        const rep = buildReport({ inputs: "full", repeat: 5, apps: ["x-shop"], trials: [1, 2, 3, 4, 5].map((n) => trial("candidate", n, score(), undefined, "full")) });
        expect(criterion(rep, "U5")).toMatchObject({ candidate: { n: 5 }, verdict: "pass", why: "" });
    });
});

describe("AI calls by purpose (U8)", () => {
    it("median and range per purpose: analysis reading, exploration planning, everything else", () => {
        const byPurpose = [
            { analysis: 3, planning: 5, other: 0 },
            { analysis: 3, planning: 8, other: 1 },
            { analysis: 2, planning: 6, other: 0 },
            { analysis: 3, planning: 7, other: 0 },
            { analysis: 4, planning: 5, other: 2 },
        ];
        const trials = byPurpose.map((p, i) => trial("candidate", i + 1, score(), { aiCalls: p.analysis + p.planning + p.other, failedCalls: 0, pages: 8, byPurpose: p }));
        const rep = buildReport({ inputs: "url", repeat: 5, apps: ["x-shop"], trials });
        expect(criterion(rep, "U8-analysis")).toMatchObject({ candidate: { n: 5, median: 3, min: 2, max: 4 }, verdict: "reported" });
        expect(criterion(rep, "U8-planning")).toMatchObject({ candidate: { n: 5, median: 6, min: 5, max: 8 }, verdict: "reported" });
        expect(criterion(rep, "U8-other")).toMatchObject({ candidate: { n: 5, median: 0, min: 0, max: 2 }, verdict: "reported" });
        expect(renderReportMd(rep)).toMatch(/\| U8-analysis \| AI calls per analysis: reading the application \|/);
    });
});

describe("the requirements input variant", () => {
    it("a full series says whether the requirements were imported one record per requirement or uploaded whole", () => {
        const trials = [1, 2, 3, 4, 5].map((n) => trial("candidate", n, score(), undefined, "full"));
        expect(buildReport({ inputs: "full", repeat: 5, apps: ["x-shop"], trials, doc: "whole" }).doc).toBe("whole");
        expect(renderReportMd(buildReport({ inputs: "full", repeat: 5, apps: ["x-shop"], trials, doc: "whole" }))).toMatch(/Requirements document: uploaded whole, as one document/);
        expect(renderReportMd(buildReport({ inputs: "full", repeat: 5, apps: ["x-shop"], trials }))).toMatch(/Requirements document: imported one record per numbered requirement/);
    });
});

describe("every trial must have run", () => {
    it("a missing trial makes the series incomplete and no criterion passes", () => {
        const trials = series([1, 1, 1, 1, 1], [0, 0, 0, 0, 0]).filter((t) => !(t.engine === "candidate" && t.trial === 3));
        const rep = buildReport({ inputs: "url", repeat: 5, apps: ["x-shop"], trials });
        expect(rep.complete).toBe(false);
        expect(rep.problems.join("\n")).toMatch(/x-shop candidate trial 3 is missing/);
        expect(rep.apps[0].criteria.filter((c) => c.verdict === "pass")).toEqual([]);
    });
    it("a failed trial is listed with its error and counts, and makes the series incomplete", () => {
        const trials = series([1, 1, 1, 1], [0, 0, 0, 0, 0]);
        trials.push(trial("candidate", 5, undefined, { aiCalls: 3, failedCalls: 3, pages: 0 }));
        const rep = buildReport({ inputs: "url", repeat: 5, apps: ["x-shop"], trials });
        expect(rep.complete).toBe(false);
        expect(rep.problems.join("\n")).toMatch(/x-shop candidate trial 5 failed: The analysis job failed\./);
        expect(rep.apps[0].runs.find((x) => x.engine === "candidate" && x.trial === 5)).toEqual({ engine: "candidate", trial: 5, status: "failed", aiCalls: 3, failedCalls: 3, pages: 0, error: "The analysis job failed." });
    });
});

describe("error and work counts", () => {
    it("AI calls per analysis (U8) as median and range per side; failed calls and pages per run", () => {
        const calls = [12, 10, 14, 11, 13];
        const trials = calls.map((c, i) => trial("candidate", i + 1, score(), { aiCalls: c, failedCalls: i === 0 ? 1 : 0, pages: 9 }));
        const rep = buildReport({ inputs: "url", repeat: 5, apps: ["x-shop"], trials });
        expect(criterion(rep, "U8")).toMatchObject({ candidate: { n: 5, median: 12, min: 10, max: 14 }, verdict: "reported" });
        expect(rep.apps[0].runs.map((x) => x.failedCalls)).toEqual([1, 0, 0, 0, 0]);
        expect(rep.apps[0].runs.every((x) => x.pages === 9)).toBe(true);
    });
});

describe("markdown", () => {
    it("states the configuration and trial count, and shows the verdicts and per-run counts", () => {
        const rep = buildReport({ inputs: "url", repeat: 5, apps: ["x-shop"], trials: series([0.8, 0.9, 0.9, 1, 0.9], [0.5, 0.6, 0.5, 0.6, 0.7]) });
        const md = renderReportMd(rep);
        expect(md).toMatch(/Input configuration: url/);
        expect(md).toMatch(/Trials: 5 per side, 10 of 10 ran/);
        expect(md).toMatch(/\| U3 .*\| 0\.9 \(0\.8–1\) \| 0\.6 \(0\.5–0\.7\) \| pass \|/);
        expect(md).toMatch(/\| candidate \| 1 \| completed \| 10 \| 0 \| 8 \|/);
    });
    it("an incomplete series says so before anything else", () => {
        const rep = buildReport({ inputs: "url", repeat: 5, apps: ["x-shop"], trials: series([1, 1], []) });
        expect(renderReportMd(rep).split("\n").find((l) => l.trim() && !l.startsWith("#"))).toMatch(/^\*\*Incomplete series/);
    });
});
