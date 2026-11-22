/**
 * Phase 5 H3: verification registered in the benchmark. `bench --verify-attempts <n>` is parsed and recorded in the run's config (both
 * sides of a comparison say how many attempts they used); `bench-report --verification` prints V1–V8 and V11 per app of each trial with
 * verifyScore (verify-score.ts), and an app with no verification data reads "not measured", never 0. Pure, plus the read-only command
 * on a temporary folder: no app, platform or model.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { benchReportMain, configLimits, parseBenchArgs } from "../src/eval/bench/cli.js";
import { categorize } from "../src/eval/bench/metrics.js";
import { BenchmarkSchema, type BenchFinding, type Benchmark } from "../src/eval/bench/schema.js";

const finding = (id: string, testKey: string, seeded: "failed" | "passed", clean: "passed" | null, single: Record<string, "failed" | "passed"> = {}): BenchFinding => {
    const replay = { seeded, clean, single };
    return { id, testKey, title: `Test ${testKey}`, source: "authoring", replay, ...categorize(replay), firstSeenAt: null };
};
const metrics = { seeded: 1, detected: 1, missed: 0, detectedLabeled: 0, findings: 2, truePositives: 1, falsePositives: 1, unreproduced: 0, selectedForVerification: 2, reproduced: 1, detectionRate: 1, precision: 0.5, precisionVerified: null, falsePositiveRate: 0.5, reproductionRate: 0.5, detectionTimeMs: null, cost: 2, costPerConfirmedDefect: null, testsGenerated: 2, workflows: 1, workflowsCovered: 1, executionFailures: 0, flaky: 0, durationMs: 1000, aiCalls: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const app = (id: string, verification?: unknown) => ({
    id,
    entryId: id,
    status: "done",
    appVersion: "v1",
    seededDefects: ["BS-02"],
    defects: [],
    // t1: fails with the seed, passes without it and fails with BS-02 alone (confirmed); t2: passes with the seeds (not a seed's finding).
    findings: [finding("t1", "WEB-001", "failed", "passed", { "BS-02": "failed" }), finding("t2", "WEB-002", "passed", null)],
    metrics,
    ...(verification ? { verification } : {}),
});
const verified = {
    findings: [
        { id: "f1", testId: "t1", state: "confirmed", reason: "The same check failed the same way in 3 of 3 attempts", groupId: null, findingClass: "app_defect", confidence: "high" },
        { id: "f2", testId: "t2", state: "unconfirmed", reason: "It passed in 3 of 3 attempts on a newly registered account each time", groupId: null, findingClass: null, confidence: "medium" },
    ],
    added: { cost: 0, durationMs: 250 },
};
const trial = (apps: unknown[]): Benchmark =>
    BenchmarkSchema.parse({
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
            options: { verifyAttempts: 3 },
            prices: null,
            approvedBudget: null,
            dailyCallCap: null,
            resumes: 0,
            runtime: { node: "v24", platform: "linux" },
        },
        apps,
        metrics,
        notes: [],
    });

describe("--verify-attempts", () => {
    it("takes 1 to 5 attempts and is recorded in the run's options; without it nothing changes", () => {
        const a = parseBenchArgs(["--verify-attempts", "3"]);
        expect(a.verifyAttempts).toBe(3);
        expect(configLimits(a).options).toEqual({ verifyAttempts: 3 });
        expect(configLimits(parseBenchArgs([])).options).toEqual({});
        expect(() => parseBenchArgs(["--verify-attempts", "6"])).toThrow();
        expect(() => parseBenchArgs(["--verify-attempts", "0"])).toThrow();
    });
});

describe("bench-report --verification", () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    });
    const folder = (b: Benchmark): string => {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), "bench-verification-"));
        dirs.push(d);
        fs.writeFileSync(path.join(d, "x-benchmark-discovery.json"), JSON.stringify({ format: 1, startedAt: "2026-11-17T01:29:00.000Z", finishedAt: "2026-11-17T02:00:00.000Z", benchmark: b }));
        return d;
    };
    const cli = async (argv: string[]) => {
        const lines: string[] = [];
        const code = await benchReportMain(argv, { log: (s) => lines.push(s) });
        return { code, out: lines.join("\n") };
    };

    it("prints each app's scores, and not measured for an app without verification data", async () => {
        const r = await cli(["--verification", folder(trial([app("bench-shop", verified), app("bench-rbac")]))]);
        expect(r.code, r.out).toBe(0);
        const rows = r.out.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Trial"));
        const shop = rows.find((l) => l.includes("| bench-shop |"))!;
        const rbac = rows.find((l) => l.includes("| bench-rbac |"))!;
        // V1: the one Confirmed group is harness-confirmed (1 of 1); V2: the harness confirmed t1 and the engine did (1 of 1); V3: both have a
        // reason (2 of 2); V6: nothing Confirmed below high; V11: no cost, 250 ms of the trial's 1000.
        expect(shop).toContain("| 100% of 1 | 100% of 1 | 100% of 2 |");
        expect(shop).toContain("| 0 below high, 0 security without H5 |");
        expect(shop).toContain("| cost 0%, time 25% |");
        expect(rbac.split("|").slice(3, -1).map((c) => c.trim())).toEqual(Array(9).fill("not measured"));
    });

    it("refuses a missing trial", async () => {
        expect((await cli(["--verification", path.join(os.tmpdir(), "no-such-trial-p56")])).code).toBe(2);
    });
});
