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
import { observedKind, observedOf, seriesOf, trialProblem, withLabels } from "../src/eval/bench/observed.js";
import { observedMarkdown } from "../src/eval/bench/report.js";
import { BenchmarkSchema, type BenchFinding, type Benchmark } from "../src/eval/bench/schema.js";

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
