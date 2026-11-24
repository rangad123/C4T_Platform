/**
 * The benchmark's numbers (src/eval/bench/metrics.ts), its estimate and limits (cost.ts), its recording (record.ts), its result schema
 * and the area reach of the apps (apps.ts): pure functions, no app, platform or model.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BENCH_APPS, workflowsReached } from "../src/eval/bench/apps.js";
import { parseCatalogue } from "../src/eval/bench/catalogue.js";
import { estimate, tokenLimits } from "../src/eval/bench/cost.js";
import { benchMetrics, categorize, combineMetrics, costOfTokens } from "../src/eval/bench/metrics.js";
import { execFileSync } from "node:child_process";
import { engineVersion, promptFingerprints, verifyBaseline, writeBaseline, writeEngineStamp } from "../src/eval/bench/record.js";
import { BenchmarkSchema, type BenchFinding } from "../src/eval/bench/schema.js";
import { BENCH_COMPARED, compareMetrics } from "../src/eval/metrics.js";

const START = "2026-11-14T10:00:00.000Z";
const finding = (over: Partial<BenchFinding> & Pick<BenchFinding, "replay">): BenchFinding => {
    const { category, defects } = categorize(over.replay);
    return { id: over.testKey ?? "t", testKey: "WEB-001", title: "A test", source: "validation", category, defects, firstSeenAt: null, ...over };
};
const base = { startedAt: START, cost: null, testsGenerated: 10, workflows: 5, workflowsCovered: 3, executionFailures: 1, flaky: 0, durationMs: 1000, aiCalls: 50, inputTokens: 100_000, outputTokens: 5_000, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe("what a finding is, from its replays", () => {
    it("confirmed: fails with the defects on, passes with all off, fails with one alone", () => {
        expect(categorize({ seeded: "finding", clean: "passed", single: { "BS-01": "failed", "BS-02": "passed" } })).toEqual({ category: "confirmed", defects: ["BS-01"] });
    });
    it("combined: no single defect alone makes it fail", () => {
        expect(categorize({ seeded: "failed", clean: "passed", single: { "BS-01": "passed", "BS-02": "passed" } })).toEqual({ category: "combined", defects: [] });
    });
    it("false positive: it also fails on the correct app", () => {
        expect(categorize({ seeded: "failed", clean: "failed", single: {} }).category).toBe("false_positive");
        expect(categorize({ seeded: "finding", clean: "finding", single: {} }).category).toBe("false_positive");
    });
    it("unreproduced: did not fail again with the defects on, or the correct app could not be tried", () => {
        expect(categorize({ seeded: "passed", clean: null, single: {} }).category).toBe("unreproduced");
        expect(categorize({ seeded: "not_run", clean: null, single: {} }).category).toBe("unreproduced");
        expect(categorize({ seeded: "failed", clean: "not_run", single: {} }).category).toBe("unreproduced");
    });
    it("several single defects: attributed to each, sorted", () => {
        expect(categorize({ seeded: "failed", clean: "passed", single: { b: "failed", a: "finding" } }).defects).toEqual(["a", "b"]);
    });
});

describe("the numbers, with their denominators", () => {
    const seeded = ["D1", "D2", "D3", "D4"];
    const findings = [
        finding({ testKey: "WEB-001", replay: { seeded: "failed", clean: "passed", single: { D1: "failed", D2: "passed", D3: "passed", D4: "passed" } }, firstSeenAt: "2026-11-14T10:05:00.000Z" }),
        finding({ testKey: "WEB-002", replay: { seeded: "failed", clean: "passed", single: { D1: "failed", D2: "failed", D3: "passed", D4: "passed" } }, firstSeenAt: "2026-11-14T10:02:00.000Z" }),
        finding({ testKey: "WEB-003", replay: { seeded: "failed", clean: "failed", single: {} } }),
        finding({ testKey: "WEB-004", replay: { seeded: "passed", clean: null, single: {} } }),
        finding({ testKey: "WEB-005", replay: { seeded: "failed", clean: "passed", single: { D1: "passed", D2: "passed", D3: "passed", D4: "passed" } } }),
    ];
    const m = benchMetrics({ ...base, seeded, findings, cost: 12 });

    it("detection rate = detected / seeded", () => {
        expect(m.detected).toBe(2);
        expect(m.missed).toBe(2);
        expect(m.detectionRate).toBe(0.5);
    });
    it("precision = true positives (confirmed + combined) / all findings; verified precision leaves unreproduced out", () => {
        expect(m.truePositives).toBe(3);
        expect(m.precision).toBe(3 / 5);
        expect(m.precisionVerified).toBe(3 / 4);
    });
    it("false-positive rate = false positives / all findings", () => {
        expect(m.falsePositives).toBe(1);
        expect(m.falsePositiveRate).toBe(1 / 5);
    });
    it("reproduction rate = failed again with the defects on / every finding", () => {
        expect(m.selectedForVerification).toBe(5);
        expect(m.reproduced).toBe(4);
        expect(m.reproductionRate).toBe(4 / 5);
        expect(m.unreproduced).toBe(1);
    });
    it("detection time = start to the earliest failure of a confirmed finding", () => {
        expect(m.detectionTimeMs).toBe(2 * 60_000);
    });
    it("cost per confirmed defect = cost / detected", () => {
        expect(m.costPerConfirmedDefect).toBe(6);
    });
    it("no findings, nothing seeded, no cost: rates are null, never zero or a division by zero", () => {
        const e = benchMetrics({ ...base, seeded: [], findings: [] });
        expect([e.detectionRate, e.precision, e.precisionVerified, e.falsePositiveRate, e.reproductionRate, e.detectionTimeMs, e.costPerConfirmedDefect]).toEqual([null, null, null, null, null, null, null]);
        expect(benchMetrics({ ...base, seeded, findings: [], cost: 5 }).costPerConfirmedDefect).toBeNull();
    });
    it("a defect only reached through a finding that is not seeded in this run does not count", () => {
        const x = benchMetrics({ ...base, seeded: ["D1"], findings: [finding({ replay: { seeded: "failed", clean: "passed", single: { D9: "failed" } } })] });
        expect(x.detected).toBe(0);
    });
    it("labels: a person's defect label counts apart from detection, a false-positive label counts as a false positive", () => {
        const x = benchMetrics({
            ...base,
            seeded,
            findings: [finding({ testKey: "WEB-007", replay: { seeded: "passed", clean: null, single: {} }, label: "D3" }), finding({ testKey: "WEB-008", replay: { seeded: "not_run", clean: null, single: {} }, label: "false_positive" })],
        });
        expect(x.detected).toBe(0);
        expect(x.detectedLabeled).toBe(1);
        expect(x.falsePositives).toBe(1);
    });
});

describe("the whole benchmark from its apps", () => {
    it("sums counts and recomputes rates from the sums (never averages rates)", () => {
        const a = benchMetrics({ ...base, seeded: ["A1"], findings: [finding({ replay: { seeded: "failed", clean: "passed", single: { A1: "failed" } } })], cost: 2 });
        const b = benchMetrics({ ...base, seeded: ["B1", "B2", "B3"], findings: [], cost: null });
        const all = combineMetrics([a, b]);
        expect(all.seeded).toBe(4);
        expect(all.detected).toBe(1);
        expect(all.detectionRate).toBe(0.25);
        expect(all.cost).toBe(2);
        expect(all.costPerConfirmedDefect).toBe(2);
        expect(all.workflows).toBe(10);
    });
});

describe("cost", () => {
    const price = { model: "m", inputPerMTok: 2, outputPerMTok: 10, cachedInputPerMTok: 0.1, cacheWritePerMTok: 2.5 };
    it("prices tokens like the platform: cached reads and writes at their own price", () => {
        expect(costOfTokens({ inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 500_000, cacheWriteTokens: 100_000 }, price)).toBeCloseTo(0.4 * 2 + 0.5 * 0.1 + 0.1 * 2.5 + 0.1 * 10, 6);
        expect(costOfTokens({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, undefined)).toBeNull();
    });
    it("the estimate grows from low to high and is priced only with a price", () => {
        const e = estimate({ apps: 2, maxScenarios: 50, authoringMaxSteps: 30, price });
        expect(e.low.calls).toBeLessThan(e.mid.calls);
        expect(e.mid.calls).toBeLessThan(e.high.calls);
        expect(e.mid.cost).toBeGreaterThan(0);
        expect(estimate({ apps: 1, maxScenarios: 50, authoringMaxSteps: 30 }).mid.cost).toBeNull();
    });
    it("a calibrated estimate uses the last run's tokens per call", () => {
        const e = estimate({ apps: 1, maxScenarios: 10, authoringMaxSteps: 30, previous: { inputPerCall: 20_000, outputPerCall: 500, callsPerTest: 10 } });
        expect(e.mid.inputTokens).toBe(e.mid.calls * 20_000);
        expect(e.basis).toMatch(/last benchmark/);
    });
    it("token limits are reached before the budget is: the whole run and each app", () => {
        const l = tokenLimits(10, 2, price);
        const blended = (0.9 * 2 + 0.1 * 10) / 1_000_000;
        expect(l.monthlyTokens).toBe(Math.floor(10 / blended));
        expect(l.jobTokens).toBe(Math.floor(l.monthlyTokens / 2));
        // Real AI use is mostly input: priced at the input price this many tokens costs less than the budget.
        expect((l.monthlyTokens * 2) / 1_000_000).toBeLessThan(10);
    });
});

describe("recording", () => {
    it("fingerprints every prompt source of the engine", () => {
        const f = promptFingerprints();
        expect(f.map((x) => x.file)).toContain("src/engine/web/author.ts");
        expect(f.every((x) => /^[0-9a-f]{64}$/.test(x.sha256))).toBe(true);
    });
    it("the engine's commit and dirty state: from git, or from the stamp of a copy without git (the VM), checked by the tree fingerprint", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "bench-engine-"));
        try {
            const repo = path.join(root, "repo");
            const write = (dir: string, f: string, text: string) => (fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }), fs.writeFileSync(path.join(dir, f), text));
            write(repo, "src/engine/a.ts", "a");
            write(repo, "src/platform/findings/v.ts", "v");
            const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, encoding: "utf8" }).trim();
            git("init", "-q");
            git("add", ".");
            git("commit", "-qm", "c");
            const sha = git("rev-parse", "HEAD");
            expect(engineVersion(repo)).toMatchObject({ commit: sha, dirty: false });
            // Phase 5 lives outside src/engine (platform/findings): a change there makes the tree dirty too.
            write(repo, "src/platform/findings/v.ts", "changed");
            expect(engineVersion(repo)).toMatchObject({ commit: sha, dirty: true });
            write(repo, "src/platform/findings/v.ts", "v");

            // A copy without .git (rsync --exclude .git): unknown, unless stamped.
            const copy = path.join(root, "copy");
            fs.cpSync(path.join(repo, "src"), path.join(copy, "src"), { recursive: true });
            expect(engineVersion(copy)).toMatchObject({ commit: "unknown", dirty: true });
            writeEngineStamp(repo, copy);
            expect(engineVersion(copy)).toMatchObject({ commit: sha, dirty: false });
            // The copy changed after it was stamped: dirty.
            write(copy, "src/engine/a.ts", "edited on the VM");
            expect(engineVersion(copy)).toMatchObject({ commit: sha, dirty: true });
            // Stamped from a dirty checkout: dirty, though the copy equals it.
            write(repo, "src/engine/a.ts", "edited on the VM");
            writeEngineStamp(repo, copy);
            expect(engineVersion(copy)).toMatchObject({ commit: sha, dirty: true });
            expect(engineVersion(copy).fingerprint).toMatch(/^[0-9a-f]{16}$/);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
    it("the baseline is written once, read-only, with its hash; a second write is refused", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-baseline-"));
        try {
            const w = writeBaseline(dir, '{"a":1}');
            expect(fs.readFileSync(`${w.file}.sha256`, "utf8")).toContain(w.sha256);
            expect(verifyBaseline(dir)).toBe(true);
            expect(() => writeBaseline(dir, '{"a":2}')).toThrow(/never overwritten/);
            expect(fs.readFileSync(w.file, "utf8")).toBe('{"a":1}');
        } finally {
            for (const f of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, f), 0o644);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
    it("the catalogue: unique ids, required fields, a hash of its text", () => {
        const text = JSON.stringify({ version: "1", defects: [{ id: "BS-01", app: "bench-shop", workflow: "Cart", category: "calculation", severity: "high", expected: "x" }] });
        const c = parseCatalogue(text);
        expect(c.defects[0]!.expected).toBe("x");
        expect(c.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(() => parseCatalogue(JSON.stringify({ version: "1", defects: [{ id: "A", app: "x", workflow: "w", category: "c", severity: "s" }, { id: "A", app: "x", workflow: "w", category: "c", severity: "s" }] }))).toThrow(/twice/);
        expect(() => parseCatalogue("{")).toThrow(/not valid JSON/);
    });
});

describe("areas reached", () => {
    it("by address prefix, not by a shared beginning of a word", () => {
        const shop = BENCH_APPS.find((a) => a.id === "bench-shop")!;
        expect(workflowsReached(shop, ["/cart", "/products/p1", "/api/orders/ord-1"]).sort()).toEqual(["Cart", "Orders", "Product browsing"]);
        expect(workflowsReached(shop, ["/cartography"])).toEqual([]);
    });
});

describe("the stored result", () => {
    it("is validated with caps, and benchmark numbers take part in the comparison with the previous run", () => {
        const m = benchMetrics({ ...base, seeded: ["D1"], findings: [] });
        const b = {
            format: 1,
            mode: "discovery",
            baseline: true,
            config: { engineCommit: "abc1234", engineDirty: false, prompts: [], model: { provider: "p", model: "m", fastModel: null, planningModel: null, temperature: "x" }, catalogueVersion: "1", apps: [{ id: "bench-shop", version: "v" }], options: { level: "thorough" }, prices: null, approvedBudget: null, dailyCallCap: null, resumes: 0, runtime: { node: "v24", platform: "linux-x64" } },
            apps: [],
            metrics: m,
            notes: [],
        };
        expect(BenchmarkSchema.safeParse(b).success).toBe(true);
        expect(BenchmarkSchema.safeParse({ ...b, extra: 1 }).success).toBe(false);
        const changes = compareMetrics({ benchmark: { detectionRate: 0.2, falsePositiveRate: 0.1 } }, { benchmark: { detectionRate: 0.5, falsePositiveRate: 0.3 } }, BENCH_COMPARED);
        expect(compareMetrics({}, {}).some((c) => c.metric.startsWith("benchmark."))).toBe(false);
        expect(changes.find((c) => c.metric === "benchmark.detectionRate")?.change).toBe("better");
        expect(changes.find((c) => c.metric === "benchmark.falsePositiveRate")?.change).toBe("worse");
    });
});
