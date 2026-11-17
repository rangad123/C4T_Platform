/**
 * The "observed vs captured" report (src/eval/bench/observed.ts, report.ts, `bench-report --observed` in bench/cli.ts): which findings the
 * author saw and the saved script kept (captured), which it saw but the script lost (observed only), false positives, and E1 / E2 with
 * their denominators. Pure functions over hand-built results, plus the read-only command on a temporary folder: no app, platform or model.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { benchReportMain } from "../src/eval/bench/cli.js";
import { categorize } from "../src/eval/bench/metrics.js";
import { candidateOf, EVIDENCE_FIELDS, evidenceGaps, NO_SCREENSHOTS, observedKind, observedOf, overBudget, seriesOf, sessionsFromEvents, trialProblem, withLabels } from "../src/eval/bench/observed.js";
import { e8Lines, observedMarkdown } from "../src/eval/bench/report.js";
import { BenchmarkSchema, type BenchFinding, type Benchmark, type ExplorationSession } from "../src/eval/bench/schema.js";
import { CandidateFindingSchema } from "../src/engine/explore/finding.js";

const f = (testKey: string, source: BenchFinding["source"], replay: BenchFinding["replay"], over: Partial<BenchFinding> = {}): BenchFinding => {
    const { category, defects } = categorize(replay);
    return { id: `id-${testKey}`, testKey, title: `Test ${testKey}`, source, replay, category, defects, firstSeenAt: null, ...over };
};

// Hand-built: each line says what the definitions make of it.
const FINDINGS: BenchFinding[] = [
    // fails seeded, passes clean, pinned to BS-01: captured; E1 yes; E2 yes
    f("WEB-001", "authoring", { seeded: "failed", clean: "passed", single: { "BS-01": "failed", "BS-02": "passed" } }, { capture: "captured" }),
    // fails seeded and clean: false positive; E1 yes (it failed on the seeded app); E2 no
    f("WEB-002", "authoring", { seeded: "finding", clean: "failed", single: {} }),
    // the author said defect, replay passed: observed only, labelled BS-02; E1 no
    f("WEB-003", "authoring", { seeded: "passed", clean: null, single: {} }, { label: "BS-02", capture: "observed_only" }),
    // replay passed and a person said false positive: false positive; E1 no
    f("WEB-004", "authoring", { seeded: "passed", clean: null, single: {} }, { label: "false_positive" }),
    // the replay did not run: not verified; E1 no (still counted in its denominator)
    f("WEB-005", "authoring", { seeded: "not_run", clean: null, single: {} }),
    // fails seeded, the clean replay did not run: captured; E1 yes; E2 no (in its denominator)
    f("WEB-006", "authoring", { seeded: "failed", clean: "not_run", single: {} }),
    // a validation failure that passed on replay: not verified; not an author-time finding (outside E1 / E2)
    f("WEB-007", "validation", { seeded: "passed", clean: null, single: {} }),
    // a check that fails everywhere: false positive; outside E1 / E2
    f("WEB-008", "check", { seeded: "finding", clean: "finding", single: {} }),
];

const metrics = { seeded: 2, detected: 1, missed: 1, detectedLabeled: 1, findings: 8, truePositives: 1, falsePositives: 3, unreproduced: 4, selectedForVerification: 8, reproduced: 4, detectionRate: 0.5, precision: 0.125, precisionVerified: 0.25, falsePositiveRate: 0.375, reproductionRate: 0.5, detectionTimeMs: null, cost: null, costPerConfirmedDefect: null, testsGenerated: 20, workflows: 7, workflowsCovered: 7, executionFailures: 0, flaky: 0, durationMs: 1000, aiCalls: 10, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const bench = (findings: BenchFinding[], status: "done" | "stopped" = "done"): Benchmark => ({
    format: 1,
    mode: "discovery",
    baseline: false,
    config: {
        engineCommit: "abc1234",
        engineDirty: false,
        prompts: [],
        model: { provider: "scripted", model: "m", fastModel: null, planningModel: null, temperature: "default" },
        catalogueVersion: "2026-11-14.1",
        apps: [{ id: "bench-shop", version: "v1" }],
        options: {},
        prices: null,
        approvedBudget: null,
        dailyCallCap: null,
        resumes: 0,
        runtime: { node: "v24", platform: "linux" },
    },
    apps: [{ id: "bench-shop", entryId: "bench-shop", status, appVersion: "v1", seededDefects: ["BS-01", "BS-02"], defects: [], findings, metrics }],
    metrics,
    notes: [],
});

describe("what each finding is, observed vs captured", () => {
    it("matches the hand-computed kinds", () => {
        expect(FINDINGS.map(observedKind)).toEqual(["captured", "false_positive", "observed_only", "false_positive", "unverified", "captured", "unverified", "false_positive"]);
    });

    it("counts, E1 and E2 with their denominators match the definitions", () => {
        const o = observedOf(bench(FINDINGS));
        expect(o.counts).toEqual({ captured: 2, observed_only: 1, false_positive: 3, unverified: 2 });
        expect(o.e1).toEqual({ n: 3, of: 6, rate: 0.5 });
        expect(o.e2).toEqual({ n: 1, of: 3, rate: 1 / 3 });
        expect(o.cleanNotRun).toBe(1);
        expect(o.observedDefects).toEqual(["BS-02"]);
        expect(o.observedUnlabelled).toBe(0);
        expect(o.authorCapture).toEqual({ captured: 1, observed_only: 1, unrecorded: 4 });
    });

    it("no authoring findings: E1 and E2 have no rate, never 0%", () => {
        const o = observedOf(bench([FINDINGS[6]!, FINDINGS[7]!]));
        expect(o.e1).toEqual({ n: 0, of: 0, rate: null });
        expect(o.e2).toEqual({ n: 0, of: 0, rate: null });
    });

    it("a labels file applies only to findings the replays could not verify, with a seeded defect or false_positive", () => {
        const plain = FINDINGS.map(({ label: _l, ...x }) => x as BenchFinding);
        const labelled = withLabels(bench(plain), { "bench-shop/WEB-003": "BS-02", "bench-shop/WEB-004": "false_positive", "bench-shop/WEB-001": "false_positive", "bench-shop/WEB-005": "BS-99" });
        const by = Object.fromEntries(labelled.apps[0]!.findings.map((x) => [x.testKey, x.label]));
        expect(by).toEqual({ "WEB-001": undefined, "WEB-002": undefined, "WEB-003": "BS-02", "WEB-004": "false_positive", "WEB-005": undefined, "WEB-006": undefined, "WEB-007": undefined, "WEB-008": undefined });
        expect(observedOf(labelled).counts).toEqual({ captured: 2, observed_only: 1, false_positive: 3, unverified: 2 });
        const none = observedOf(bench(plain));
        expect(none.observedUnlabelled).toBe(2);
        expect(none.observedDefects).toEqual([]);
    });

    it("an unfinished trial is a problem, said in a sentence", () => {
        expect(trialProblem(bench(FINDINGS))).toBeUndefined();
        expect(trialProblem(bench(FINDINGS, "stopped"))).toMatch(/bench-shop did not finish \(stopped\)/);
    });

    it("median and range over trials, leaving out trials with no rate", () => {
        expect(seriesOf([0.5, 1, 0.25, null])).toEqual({ n: 3, median: 0.5, min: 0.25, max: 1 });
        expect(seriesOf([0.2, 0.4])).toEqual({ n: 2, median: 0.30000000000000004, min: 0.2, max: 0.4 });
        expect(seriesOf([null])).toEqual({ n: 0, median: null, min: null, max: null });
    });

    it("the Markdown section names the counts and the denominators", () => {
        const md = observedMarkdown([{ name: "trial-1", observed: observedOf(bench(FINDINGS)) }]);
        expect(md).toContain("## Observed vs captured");
        expect(md).toContain("| E1 capture: author-time findings whose saved script fails on the seeded app | 3 of 6 (50%) |");
        expect(md).toContain("| E2 replay isolation: of those, scripts that pass on the clean app | 1 of 3 (33.3%) |");
        expect(md).toMatch(/\| bench-shop \| WEB-003 \| authoring \| observed_only \| passed \| - \| observed only \| BS-02 \|/);
    });
});

describe("results files", () => {
    it("an old results file (no capture field) still reads; capture is optional and checked", () => {
        const old = bench(FINDINGS.map(({ capture: _c, ...x }) => x as BenchFinding));
        expect(BenchmarkSchema.safeParse(old).success).toBe(true);
        expect(BenchmarkSchema.safeParse(bench(FINDINGS)).success).toBe(true);
        const bad = bench([{ ...FINDINGS[0]!, capture: "maybe" as never }]);
        expect(BenchmarkSchema.safeParse(bad).success).toBe(false);
    });
});

describe("bench-report --observed <folder> (read-only)", () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    });
    const folder = (files: Record<string, unknown>): string => {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), "bench-observed-"));
        dirs.push(d);
        for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(d, name), JSON.stringify(body));
        return d;
    };
    const run = (b: Benchmark) => ({ format: 1, startedAt: "2026-11-17T01:29:00.000Z", finishedAt: "2026-11-17T02:00:00.000Z", benchmark: b });
    const cli = async (argv: string[]) => {
        const lines: string[] = [];
        const code = await benchReportMain(argv, { log: (s) => lines.push(s) });
        return { code, out: lines.join("\n") };
    };

    it("prints the section for the finished result and writes nothing", async () => {
        const d = folder({ "2026-11-16-1945-benchmark-discovery-partial.json": run(bench([])), "2026-11-17-0129-benchmark-discovery.json": run(bench(FINDINGS)) });
        const before = fs.readdirSync(d).sort();
        const r = await cli(["--observed", d]);
        expect(r.code).toBe(0);
        expect(r.out).toContain("3 of 6 (50%)");
        expect(fs.readdirSync(d).sort()).toEqual(before);
    });

    it("two trials: per-trial rows and the median and range", async () => {
        const one = folder({ "a-benchmark-discovery.json": run(bench(FINDINGS)) });
        const two = folder({ "b-benchmark-discovery.json": run(bench([FINDINGS[0]!])) });
        const r = await cli(["--observed", one, two]);
        expect(r.code).toBe(0);
        expect(r.out).toMatch(/E1 over 2 trials: median 75%, range 50%–100%/);
    });

    it("a folder without a finished result fails with a sentence (the trial is missing, not dropped)", async () => {
        const d = folder({ "2026-11-16-1945-benchmark-discovery-partial.json": run(bench(FINDINGS)) });
        const r = await cli(["--observed", d]);
        expect(r.code).toBe(2);
        expect(r.out).toMatch(/No finished benchmark result in .*: this trial is missing/);
    });

    it("a result with an app that did not finish fails with a sentence", async () => {
        const d = folder({ "x-benchmark-discovery.json": run(bench(FINDINGS, "stopped")) });
        const r = await cli(["--observed", d]);
        expect(r.code).toBe(2);
        expect(r.out).toMatch(/bench-shop did not finish \(stopped\)/);
    });

    it("two finished results in one folder are refused (which trial is meant?)", async () => {
        const d = folder({ "a-benchmark-discovery.json": run(bench(FINDINGS)), "b-benchmark-discovery.json": run(bench(FINDINGS)) });
        const r = await cli(["--observed", d]);
        expect(r.code).toBe(2);
        expect(r.out).toMatch(/2 finished benchmark results in/);
    });

    it("without --observed it prints the usage and fails", async () => {
        const r = await cli([]);
        expect(r.code).toBe(2);
        expect(r.out).toMatch(/Usage: node scripts\/eval.mjs bench-report --observed/);
    });
});

// ── Per-objective counts, stop reasons, E6–E8 (P3-23) ────────────────────────────────────────────────────────────────────────────────

/** A candidate finding as the engine stores it on the test (parsed with the engine's own contract, so the field names are the real ones). */
const complete = () =>
    CandidateFindingSchema.parse({
        objective: { id: "obj-1", kind: "rule", source: "R-1", operator: "invalid_input" },
        actions: { stepCount: 6 },
        expected: { text: "The total is the sum of the lines.", source: "R-1" },
        observed: "The total was $31.00 for lines of $10 and $20.",
        evidence: { screenshots: [], requests: ["POST /api/cart -> 200"], console: [] },
        capture: "captured",
        independence: "independent",
        confidence: "high",
        fingerprint: "a".repeat(64),
        modelVersion: "mv-1",
        replays: [],
    });

describe("E7: what a candidate finding carries", () => {
    it("a complete finding lacks nothing", () => {
        expect(evidenceGaps(complete(), "WEB-001")).toEqual([]);
    });

    it("each missing field is named", () => {
        const f = complete();
        expect(evidenceGaps({ ...f, expected: { ...f.expected, source: null } }, "WEB-001")).toEqual(["source"]);
        expect(evidenceGaps({ ...f, objective: null }, "WEB-001")).toEqual(["objective"]);
        expect(evidenceGaps({ ...f, evidence: { screenshots: [], requests: [], console: [] } }, "WEB-001")).toEqual(["evidence"]);
        expect(evidenceGaps({ ...f, actions: { stepCount: 0 } }, "WEB-001")).toEqual(["actions"]);
        expect(evidenceGaps({ ...f, modelVersion: null, observed: "  " }, "WEB-001")).toEqual(["observed", "modelVersion"]);
        expect(evidenceGaps({ ...f, confidence: "certain" }, "WEB-001")).toEqual(["confidence"]);
        expect(evidenceGaps(f, "")).toEqual(["reproduction"]);
    });

    it("only a captured finding needs a stated source: one marked observed_only with no source is not missing it", () => {
        const f = complete();
        const observedOnly = { ...f, capture: "observed_only", independence: "not_run", confidence: "low", expected: { ...f.expected, source: null } };
        expect(evidenceGaps(observedOnly, "WEB-001")).toEqual([]);
        // Captured with no source, or not marked at all: the source is missing.
        expect(evidenceGaps({ ...f, expected: { ...f.expected, source: null } }, "WEB-001")).toEqual(["source"]);
        const { capture: _c, ...unmarked } = observedOnly;
        expect(evidenceGaps(unmarked, "WEB-001")).toEqual(["source"]);
    });

    it("request or console lines are evidence enough; no screenshot is noted, not a gap", () => {
        const f = complete();
        expect(evidenceGaps(f, "WEB-001")).toEqual([]);
        expect(evidenceGaps({ ...f, evidence: { screenshots: [], requests: [], console: ["Console error: boom"] } }, "WEB-001")).toEqual([]);
        expect(candidateOf(f, "WEB-001").notes).toEqual([NO_SCREENSHOTS]);
        expect(candidateOf({ ...f, evidence: { ...f.evidence, screenshots: ["shots/1.png"] } }, "WEB-001")).not.toHaveProperty("notes");
    });

    it("a defect test without a candidate finding lacks it and every field", () => {
        expect(evidenceGaps(undefined, "WEB-001")).toEqual(["finding", ...EVIDENCE_FIELDS]);
        expect(candidateOf(undefined, "WEB-001")).toEqual({ objective: null, missing: ["finding", ...EVIDENCE_FIELDS] });
    });

    it("keeps the objective's kind and operator", () => {
        expect(candidateOf(complete(), "WEB-001")).toEqual({ objective: { kind: "rule", operator: "invalid_input" }, missing: [], notes: [NO_SCREENSHOTS] });
        const { operator: _o, ...noOperator } = complete().objective!;
        expect(candidateOf({ ...complete(), objective: noOperator }, "WEB-001").objective).toEqual({ kind: "rule", operator: null });
    });
});

const planned = (budgets: unknown) => ({ id: 1, kind: "objectives_planned", message: "planned", data: { objectives: 3, pursuits: 4, skipped: 0, overCap: 0, budgets } });
const stopped = (data: unknown, message = "Exploring by objectives stopped: all objectives were pursued.") => ({ id: 9, kind: "exploration_stopped", message, data });
const BUDGETS = { objectives: 4, actions: 50, aiCalls: 60, tokens: 1_000_000, minutes: 30, depth: 3, steps: 25 };

describe("sessions and E6 from the job's events", () => {
    it("pairs objectives_planned with exploration_stopped, in order; one left open has no stop reason", () => {
        const s = sessionsFromEvents("job-1", [
            planned(BUDGETS),
            { id: 2, kind: "possible_defect", message: "x", data: {} },
            stopped({ stopReason: "ai_calls", pursued: 3, actions: 40, aiCalls: 61 }),
            planned(BUDGETS),
        ]);
        expect(s).toEqual([
            { jobId: "job-1", stopReason: "ai_calls", detail: "Exploring by objectives stopped: all objectives were pursued.", budgets: { objectives: 4, actions: 50, aiCalls: 60 }, used: { objectives: 3, actions: 40, aiCalls: 61 } },
            { jobId: "job-1", stopReason: null, detail: "", budgets: { objectives: 4, actions: 50, aiCalls: 60 }, used: null },
        ]);
        expect(overBudget(s[0]!)).toEqual(["aiCalls"]);
        expect(overBudget(s[1]!)).toEqual([]);
    });

    it("reaching a budget exactly is not over it; unreadable data is left out, never guessed", () => {
        const [at] = sessionsFromEvents("j", [planned(BUDGETS), stopped({ stopReason: "actions", pursued: 4, actions: 50, aiCalls: 60 })]);
        expect(overBudget(at!)).toEqual([]);
        const [bad] = sessionsFromEvents("j", [planned({ actions: "many" }), stopped({ stopReason: "", pursued: -1 })]);
        expect(bad).toMatchObject({ stopReason: null, budgets: null, used: null });
        expect(sessionsFromEvents("j", [])).toEqual([]);
    });

    it("a second stop with no session opened stands alone; it never overwrites the closed one", () => {
        const s = sessionsFromEvents("j", [planned(BUDGETS), stopped({ stopReason: "time", pursued: 1, actions: 2, aiCalls: 3 }), stopped({ stopReason: "cancelled", pursued: 0, actions: 0, aiCalls: 0 })]);
        expect(s.map((x) => [x.stopReason, x.budgets !== null])).toEqual([["time", true], ["cancelled", false]]);
    });
});

const session = (over: Partial<ExplorationSession> = {}): ExplorationSession => ({ jobId: "job-c", stopReason: "objectives_done", detail: "", budgets: { objectives: 4, actions: 50, aiCalls: 60 }, used: { objectives: 4, actions: 30, aiCalls: 20 }, ...over });
const cand = (testKey: string, kind: string | null, operator: string | null, missing: string[] = []): BenchFinding =>
    f(testKey, "authoring", { seeded: "failed", clean: "passed", single: {} }, { candidate: { objective: kind ? { kind, operator } : null, missing } });
/** A trial with the exploration record: its findings, sessions, AI calls and cost. */
const trial = (findings: BenchFinding[], sessions: ExplorationSession[], o: { baseline?: boolean; aiCalls?: number; cost?: number | null } = {}): Benchmark => {
    const b = bench(findings);
    const m = { ...b.metrics, aiCalls: o.aiCalls ?? 10, cost: o.cost === undefined ? null : o.cost };
    return { ...b, baseline: o.baseline ?? false, metrics: m, apps: b.apps.map((a) => ({ ...a, metrics: m, exploration: { sessions } })) };
};

describe("per trial: findings by objective, stop reasons, E6, E7, E8", () => {
    // Hand-built: two rule/invalid_input findings (one without its evidence), one workflow/repeat, one without an objective, and a check.
    const FOUND = [cand("WEB-101", "rule", "invalid_input"), cand("WEB-102", "rule", "invalid_input", ["evidence"]), cand("WEB-103", "workflow", "repeat"), cand("WEB-104", null, null, ["objective"]), FINDINGS[7]!];

    it("gives the stated counts", () => {
        const o = observedOf(trial(FOUND, [session(), session({ jobId: "job-d", stopReason: "ai_calls", used: { objectives: 2, actions: 10, aiCalls: 61 } })], { aiCalls: 90, cost: 0.12 }));
        expect(o.byObjective).toEqual([
            { kind: "none", operator: "none", findings: 1 },
            { kind: "rule", operator: "invalid_input", findings: 2 },
            { kind: "workflow", operator: "repeat", findings: 1 },
        ]);
        expect(o.e6).toEqual({ sessions: 2, withStopReason: 2, stopReasons: { ai_calls: 1, objectives_done: 1 }, overBudget: [{ jobId: "job-d", over: ["aiCalls"] }], pass: false });
        // The check is not a candidate finding: 4 candidates, 2 complete; one missing field fails E7 for the trial.
        expect(o.e7).toEqual({ n: 2, of: 4, rate: 0.5, missing: { evidence: 1, objective: 1 }, pass: false });
        expect(o.e8).toEqual({ aiCalls: 90, cost: 0.12, sessionCalls: 81 });
    });

    it("all bounded and complete: E6 and E7 pass", () => {
        const o = observedOf(trial([cand("WEB-101", "rule", "invalid_input")], [session()]));
        expect(o.e6).toMatchObject({ pass: true });
        expect(o.e7).toMatchObject({ n: 1, of: 1, pass: true });
        const md = observedMarkdown([{ name: "t", observed: o }]);
        expect(md).toContain("| E6 bounded: every session has a stop reason, none over budget | pass |");
        expect(md).toContain("| E7 evidence: candidate findings with every field | 1 of 1 (100%): pass |");
        expect(md).toContain("| rule | invalid_input | 1 |");
    });

    it("a session with no recorded stop reason fails E6", () => {
        const o = observedOf(trial([], [session({ stopReason: null, used: null })]));
        expect(o.e6).toMatchObject({ sessions: 1, withStopReason: 0, pass: false });
        expect(observedMarkdown([{ name: "t", observed: o }])).toContain("1 session(s) with no recorded stop reason");
    });

    it("the Markdown names the failures", () => {
        const md = observedMarkdown([{ name: "t", observed: observedOf(trial(FOUND, [session({ jobId: "job-d", used: { objectives: 5, actions: 10, aiCalls: 1 } })])) }]);
        expect(md).toContain("| Sessions over a budget | job-d (objectives) |");
        expect(md).toContain("| E7 evidence: candidate findings with every field | 2 of 4 (50%): fail |");
        expect(md).toContain("| Fields missing (findings) | evidence 1, objective 1 |");
        expect(md).toMatch(/\| WEB-102 \| authoring \|.*\| rule \/ invalid_input \| evidence \|/);
    });

    it("the missing-fields column keeps 'screenshots: none saved' visible, and it does not fail E7", () => {
        const shotless = f("WEB-201", "authoring", { seeded: "failed", clean: "passed", single: {} }, { candidate: { objective: { kind: "rule", operator: "as_stated" }, missing: [], notes: [NO_SCREENSHOTS] } });
        const o = observedOf(trial([shotless], [session()]));
        expect(o.e7).toMatchObject({ n: 1, of: 1, pass: true });
        expect(observedMarkdown([{ name: "t", observed: o }])).toMatch(/\| WEB-201 \| .*\| rule \/ as_stated \| screenshots: none saved \|/);
    });

    it("on a baseline trial E6 and E7 are not applicable, never a fail; the per-objective counts still show", () => {
        const o = observedOf(trial(FOUND, [session({ stopReason: null, used: null })], { baseline: true }));
        expect(o.e6).toBe("not_applicable");
        expect(o.e7).toBe("not_applicable");
        expect(o.byObjective).toContainEqual({ kind: "rule", operator: "invalid_input", findings: 2 });
        const md = observedMarkdown([{ name: "b", observed: o }]);
        expect(md).toContain("| E6 bounded | not applicable (baseline does not explore by objectives) |");
        expect(md).toContain("| E7 evidence | not applicable (baseline does not explore by objectives) |");
        expect(md).not.toMatch(/: fail \||\| fail \|/);
    });

    it("an older result without the exploration record reports them as not available, never zero", () => {
        const o = observedOf(bench(FINDINGS));
        expect(o.byObjective).toBeNull();
        expect(o.e6).toBeNull();
        expect(o.e7).toBeNull();
        expect(o.e8).toEqual({ aiCalls: 10, cost: null, sessionCalls: null });
        const md = observedMarkdown([{ name: "old", observed: o }]);
        expect(md).toContain("| E6 bounded | not available");
        expect(md).toContain("| E7 evidence | not available");
        expect(md).toContain("| AI calls in the objective sessions | not available");
        expect(md).toContain("Candidate findings by objective: not available");
        expect(md).not.toMatch(/\| (Objective sessions|Sessions over a budget) \| 0/);
        // And it still parses.
        expect(BenchmarkSchema.safeParse(bench(FINDINGS)).success).toBe(true);
        expect(BenchmarkSchema.safeParse(trial(FOUND, [session()])).success).toBe(true);
    });
});

describe("E8 across trials: candidate median against the baseline median", () => {
    const t = (baseline: boolean, aiCalls: number, cost: number | null) => observedOf(trial([], [], { baseline, aiCalls, cost }));

    it("at most 2× the baseline median passes", () => {
        const lines = e8Lines([t(true, 10, 0.1), t(true, 20, 0.2), t(true, 30, 0.3), t(false, 30, 0.4), t(false, 50, 0.4)]);
        expect(lines[0]).toBe("- E8 AI calls: candidate median 40 (2 trials, range 30–50), baseline median 20 (3 trials), 2×: pass (at most 2× the baseline median)");
        expect(lines[1]).toBe("- E8 estimated cost: candidate median $0.40 (2 trials, range $0.40–$0.40), baseline median $0.20 (3 trials), 2×: pass (at most 2× the baseline median)");
    });

    it("more than 2× fails", () => {
        expect(e8Lines([t(true, 20, null), t(false, 41, null)])[0]).toMatch(/candidate median 41 .* baseline median 20 .*: fail/);
    });

    it("without a baseline trial, or without prices, it says there is nothing to compare", () => {
        expect(e8Lines([t(false, 10, 0.1), t(false, 20, 0.1)])).toEqual(["- E8: no baseline trial among these, so no comparison with the baseline median"]);
        expect(e8Lines([t(true, 20, null), t(false, 30, null)])[1]).toBe("- E8 estimated cost: no baseline trial was priced, so no comparison");
    });

    it("is in the multi-trial section", () => {
        const md = observedMarkdown([{ name: "b", observed: t(true, 20, null) }, { name: "c", observed: t(false, 30, null) }]);
        expect(md).toContain("- E8 AI calls: candidate median 30 (1 trials, range 30–30), baseline median 20 (1 trials), 1.5×: pass");
    });
});
