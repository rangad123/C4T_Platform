/**
 * Scoring rules v2 (queue row 237, ROW233-ROOT-CAUSE.md fix 5): fairness of the false-positive count and the report only; detection is
 * scored exactly as before. Pure functions and the read-only `bench-report --rescore` command: no app, platform or model.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCatalogue } from "../src/eval/bench/catalogue.js";
import { benchReportMain } from "../src/eval/bench/cli.js";
import { headlineOf } from "../src/eval/bench/controller.js";
import { benchMetrics, categorize, combineMetrics, rescored, SCORING_VERSION } from "../src/eval/bench/metrics.js";
import { benchMarkdown } from "../src/eval/bench/report.js";
import { BenchmarkSchema, type BenchFinding, type Benchmark } from "../src/eval/bench/schema.js";
import { Db } from "../src/platform/db.js";
import { EvalStore } from "../src/platform/eval-store.js";
import type { EvalRun } from "../src/eval/run.js";

const f = (testKey: string, source: BenchFinding["source"], replay: BenchFinding["replay"], over: Partial<BenchFinding> = {}): BenchFinding => {
    const { category, defects } = categorize(replay);
    return { id: `id-${testKey}`, testKey, title: `Test ${testKey}`, source, replay, category, defects, firstSeenAt: null, ...over };
};
const BOTH_FAIL = { seeded: "failed", clean: "failed", single: {} } as const;
const FINDINGS: BenchFinding[] = [
    // confirmed BS-01: detected
    f("WEB-001", "authoring", { seeded: "failed", clean: "passed", single: { "BS-01": "failed", "BS-09": "passed" } }),
    // a real false positive
    f("WEB-002", "authoring", BOTH_FAIL, { reason: "The application did not behave as the test expected" }),
    // the engine's leftover gate (orchestrator.ts): saved for review, never a finding, in both of its wordings
    f("WEB-003", "authoring", BOTH_FAIL, { reason: "Not reported as a finding: The test depends on what the account held before it ran" }),
    f("WEB-004", "authoring", BOTH_FAIL, { reason: "Not validated: The test depends on what the account held before it ran" }),
    // the author reported a defect, the saved test passes on the seeded app: seen but not reproducible
    f("WEB-005", "authoring", { seeded: "passed", clean: null, single: {} }),
    // a validation failure that passed on replay: not something the author saw
    f("WEB-006", "validation", { seeded: "passed", clean: null, single: {} }),
];
const base = { startedAt: "2026-11-21T10:00:00.000Z", cost: null, testsGenerated: 10, workflows: 5, workflowsCovered: 3, executionFailures: 0, flaky: 0, durationMs: 1000, aiCalls: 5, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const SEEDED = ["BS-01", "BS-09"];

describe("scoring rules v2", () => {
    const m = benchMetrics({ ...base, seeded: SEEDED, findings: FINDINGS, unreachable: ["BS-09"] });

    it("tests the engine itself did not report are left out of the false positives and counted on their own", () => {
        expect(m.falsePositives).toBe(1);
        expect(m.notReported).toBe(2);
        expect(m.falsePositiveRate).toBe(1 / 6);
    });
    it("seen but not reproducible: the author reported a defect and the saved test passes on the seeded app", () => {
        expect(m.seenNotReproducible).toBe(1);
        expect(m.falsePositives).toBe(1);
    });
    it("an unreachable seeded defect lowers the effective maximum, never the seeded count or the detection rate", () => {
        expect(m.reachable).toBe(1);
        expect(m.seeded).toBe(2);
        expect(m.detected).toBe(1);
        expect(m.detectionRate).toBe(0.5);
        expect(benchMetrics({ ...base, seeded: ["BS-01"], findings: [], unreachable: ["BS-09"] }).reachable).toBe(1);
    });
    it("the new counts are summed over apps", () => {
        const all = combineMetrics([m, m]);
        expect([all.notReported, all.seenNotReproducible, all.reachable, all.falsePositives]).toEqual([4, 2, 2, 2]);
    });
});

describe("the catalogue", () => {
    it("marks BS-09 unreachable with the reason, and only BS-09", () => {
        const c = loadCatalogue();
        const marked = c.defects.filter((d) => d.unreachable);
        expect(marked.map((d) => d.id)).toEqual(["BS-09"]);
        expect(marked[0]!.unreachable).toMatch(/401/);
    });
});

const OLD_METRICS = { ...benchMetrics({ ...base, seeded: SEEDED, findings: FINDINGS }), falsePositives: 3 };
delete (OLD_METRICS as Partial<typeof OLD_METRICS>).notReported;
delete (OLD_METRICS as Partial<typeof OLD_METRICS>).seenNotReproducible;
delete (OLD_METRICS as Partial<typeof OLD_METRICS>).reachable;
const oldResult = (): Benchmark => ({
    format: 1,
    mode: "discovery",
    baseline: false,
    config: { engineCommit: "abc1234", engineDirty: false, prompts: [], model: { provider: "p", model: "m", fastModel: null, planningModel: null, temperature: "x" }, catalogueVersion: "1", apps: [{ id: "bench-shop", version: "v" }], options: {}, prices: null, approvedBudget: null, dailyCallCap: null, resumes: 0, runtime: { node: "v24", platform: "linux" } },
    apps: [{ id: "bench-shop", entryId: "bench-shop", status: "done", appVersion: "v", seededDefects: SEEDED, defects: SEEDED.map((id) => ({ id, category: "c", workflow: "w", severity: "high", detected: id === "BS-01", labeledOnly: false, findings: id === "BS-01" ? ["WEB-001"] : [] })), findings: FINDINGS, metrics: { ...OLD_METRICS, detectionTimeMs: 1234 } }],
    metrics: OLD_METRICS,
    notes: [],
});
const run = (b: Benchmark) => ({ format: 1, startedAt: "2026-11-21T10:00:00.000Z", finishedAt: "2026-11-21T11:00:00.000Z", benchmark: b }) as unknown as EvalRun;

describe("versioned results", () => {
    it("an old result (no scoring field, no new counts) still reads, and reads as v1", () => {
        const b = oldResult();
        expect(BenchmarkSchema.safeParse(b).success).toBe(true);
        expect(headlineOf(b).scoring).toBe(1);
        expect(benchMarkdown(b, run(b))).toMatch(/Scoring rules v1\b/);
    });
    it("re-scoring an old result: v2, the false positives recomputed, detection and every other number unchanged", () => {
        const b = oldResult();
        const r = rescored(b, ["BS-09"]);
        expect(r.scoring).toBe(SCORING_VERSION);
        expect(SCORING_VERSION).toBe(2);
        expect(BenchmarkSchema.safeParse(r).success).toBe(true);
        const a = r.apps[0]!;
        expect([a.metrics.detected, a.metrics.falsePositives, a.metrics.notReported, a.metrics.seenNotReproducible, a.metrics.reachable]).toEqual([1, 1, 2, 1, 1]);
        expect(a.metrics.detectionTimeMs).toBe(1234);
        expect(a.metrics.testsGenerated).toBe(10);
        expect(a.defects.find((d) => d.id === "BS-09")!.unreachable).toBe(true);
        expect(r.metrics.falsePositives).toBe(1);
        expect(b.apps[0]!.metrics.falsePositives).toBe(3); // the input is left as it was
    });
    it("the v2 report names its rules, the effective maximum, and the two new lines apart from false positives", () => {
        const r = rescored(oldResult(), ["BS-09"]);
        const md = benchMarkdown(r, run(r));
        expect(md).toMatch(/Scoring rules v2\b/);
        expect(md).toContain("| Effective maximum (seeded defects a test can reach) | 1 of 2 (unreachable: BS-09) |");
        expect(md).toContain("| False positives | 1 |");
        expect(md).toMatch(/\| Not reported by the engine \(left out of false positives\) \| 2 \|/);
        expect(md).toMatch(/\| Seen but not reproducible [^|]*\| 1 \|/);
        expect(md).toMatch(/\| BS-09 \|[^\n]*\| no \(unreachable\) \|/);
    });
    it("the platform does not compare benchmark numbers across scoring versions", () => {
        const db = new Db(":memory:");
        const s = new EvalStore(db);
        const asRun = (b: Benchmark, startedAt: string): EvalRun => ({ format: 1, corpus: "benchmark-discovery", startedAt, finishedAt: startedAt, repeat: 1, planOnly: false, platform: { mode: "in-process", model: "m" }, entries: [], overall: { entries: 0, entriesDone: 0, rates: {} as never, benchmark: headlineOf(b) } as never, benchmark: b });
        const v1 = oldResult();
        const v2 = rescored(oldResult(), ["BS-09"]);
        s.add(asRun(v1, "2026-11-20T10:00:00.000Z"), "{}");
        s.add(asRun(v2, "2026-11-21T10:00:00.000Z"), "{}");
        s.add(asRun(v2, "2026-11-22T10:00:00.000Z"), "{}");
        const [newest, middle] = s.list();
        expect(s.compare(middle!)!.overall.some((c) => c.metric.startsWith("benchmark."))).toBe(false);
        expect(s.compare(newest!)!.overall.some((c) => c.metric.startsWith("benchmark."))).toBe(true);
        db.close();
    });
});

describe("bench-report --rescore (read-only)", () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    });
    it("prints before and after per trial and writes nothing", async () => {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), "bench-rescore-"));
        dirs.push(d);
        fs.writeFileSync(path.join(d, "a-benchmark-discovery.json"), JSON.stringify(run(oldResult())));
        const before = fs.readdirSync(d);
        const lines: string[] = [];
        const code = await benchReportMain(["--rescore", d], { log: (s) => lines.push(s) });
        const out = lines.join("\n");
        expect(code).toBe(0);
        expect(out).toMatch(/\| [^|]*a-benchmark-discovery\.json \| v1 → v2 \| 1 → 1 \| 2 → 1 \| 3 → 1 \| 2 \| 1 \|/);
        expect(fs.readdirSync(d)).toEqual(before);
    });
});
