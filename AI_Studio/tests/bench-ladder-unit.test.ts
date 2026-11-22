/**
 * Phase 7 B5: the ladder runner and its report (eval/bench/ladder.ts). The run order alternates rungs per wave; each run uses the same
 * harness flags on its own rung's tree and records the tree's fingerprint; the report gives per rung the median and range of every metric
 * over the trials that measured it, lists every trial (unfinished ones included) and says the detection verdict.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ladderMain, ladderReport, ladderRuns, treeFingerprint, verdict } from "../src/eval/bench/ladder.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ladder-"));

describe("ladderRuns", () => {
    it("alternates the rung order per wave, one run per rung, app and wave", () => {
        const runs = ladderRuns([{ id: "L0", tree: "/t0" }, { id: "L1", tree: "/t1" }, { id: "L2", tree: "/t2" }], ["shop", "rbac"], 2, "/out");
        expect(runs.map((r) => `${r.wave}:${r.rung}:${r.app}`)).toEqual(["1:L0:shop", "1:L0:rbac", "1:L1:shop", "1:L1:rbac", "1:L2:shop", "1:L2:rbac", "2:L2:shop", "2:L2:rbac", "2:L1:shop", "2:L1:rbac", "2:L0:shop", "2:L0:rbac"]);
        expect(runs[0]).toEqual({ rung: "L0", tree: "/t0", app: "shop", wave: 1, out: "/out/L0/shop-1", dataDir: "/out/L0/shop-1/data" });
    });
});

describe("treeFingerprint", () => {
    it("is LADDER.md's command over src, examples and scripts, sorted bytewise", () => {
        const dir = tmp();
        // Z (0x5A) sorts before _ (0x5F) bytewise, after it in a locale's order.
        for (const f of ["src/b.ts", "src/A.ts", "src/a/c.ts", "src/_u.ts", "src/Z.ts", "examples/x.mjs", "scripts/s.mjs", "other/ignored.ts"]) {
            fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
            fs.writeFileSync(path.join(dir, f), f);
        }
        const shell = execSync("find src examples scripts -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -c1-16", { cwd: dir, encoding: "utf8" }).trim();
        expect(treeFingerprint(dir)).toBe(shell);
        fs.writeFileSync(path.join(dir, "other/ignored.ts"), "changed");
        expect(treeFingerprint(dir)).toBe(shell);
        fs.writeFileSync(path.join(dir, "src/b.ts"), "changed");
        expect(treeFingerprint(dir)).not.toBe(shell);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

/** A finished result file as the bench writes it (only the fields the report reads). */
function writeTrial(out: string, app: string, m: { detected: number; falsePositives: number; cost: number | null; durationMs: number; reproductionRate: number | null }) {
    fs.mkdirSync(out, { recursive: true });
    const metrics = { seeded: 12, reachable: 11, detected: m.detected, missed: 12 - m.detected, detectedLabeled: 0, findings: 4, truePositives: m.detected, falsePositives: m.falsePositives, unreproduced: 0, selectedForVerification: 4, reproduced: 3, detectionRate: m.detected / 12, precision: null, precisionVerified: null, falsePositiveRate: null, reproductionRate: m.reproductionRate, detectionTimeMs: null, cost: m.cost, costPerConfirmedDefect: null, testsGenerated: 10, workflows: 4, workflowsCovered: 2, executionFailures: 0, flaky: 0, durationMs: m.durationMs, aiCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const config = { engineCommit: "unknown", engineDirty: true, prompts: [], model: { provider: "p", model: "scripted", fastModel: null, planningModel: null, temperature: "default" }, catalogueVersion: "2026-11-14.1", apps: [], options: {}, prices: null, approvedBudget: null, dailyCallCap: null, resumes: 0, runtime: { node: "22", platform: "linux" } };
    const appResult = { id: app, entryId: app, projectId: "p1", status: "done", appVersion: "v", seededDefects: [], defects: [], findings: [], metrics };
    const benchmark = { format: 1, scoring: 2, mode: "discovery", baseline: false, config, apps: [appResult], metrics, notes: [] };
    fs.writeFileSync(path.join(out, "2026-11-22-1000-benchmark-discovery.json"), JSON.stringify({ benchmark, entries: [{ projectId: "p1", tests: [{ id: "a", testId: "WEB-1", firstRun: "passed", reruns: ["passed", "failed"] }] }] }));
}

describe("ladderMain", () => {
    it("runs each rung's own tree with the same flags, records the fingerprint, and skips a finished trial when run again", async () => {
        const root = tmp();
        const trees = ["t0", "t1"].map((t) => {
            const d = path.join(root, t);
            fs.mkdirSync(path.join(d, "src"), { recursive: true });
            fs.writeFileSync(path.join(d, "src/x.ts"), t);
            return d;
        });
        const out = path.join(root, "out");
        const calls: Array<{ cwd: string; args: string[] }> = [];
        const spawn = (cwd: string, args: string[]) => {
            calls.push({ cwd, args });
            // The first L1 trial finishes; every other one stops without a result.
            if (cwd === trees[1] && !calls.slice(0, -1).some((c) => c.cwd === trees[1])) writeTrial(args[args.indexOf("--out") + 1]!, "shop", { detected: 1, falsePositives: 0, cost: 0, durationMs: 1, reproductionRate: null });
            return 0;
        };
        const argv = ["--rungs", `L0=${trees[0]},L1=${trees[1]}`, "--apps", "shop", "--trials", "2", "--out", out, "--port-base", "7600", "--", "--layers-only", "--level", "quick"];
        expect(await ladderMain(argv, { spawn, log: () => {} })).toBe(0);
        expect(calls.map((c) => c.cwd)).toEqual([trees[0], trees[1], trees[1], trees[0]]);
        expect(calls[0]!.args).toEqual(["scripts/eval.mjs", "bench", "--layers-only", "--level", "quick", "--apps", "shop", "--out", path.join(out, "L0/shop-1"), "--data-dir", path.join(out, "L0/shop-1/data"), "--port-base", "7600", "--yes"]);
        const rec = JSON.parse(fs.readFileSync(path.join(out, "L1/shop-1/ladder-run.json"), "utf8"));
        expect(rec).toMatchObject({ format: 1, rung: "L1", tree: trees[1], fingerprint: treeFingerprint(trees[1]!), app: "shop", wave: 1, exitCode: 0, flags: ["--layers-only", "--level", "quick"] });
        // Again: L1/shop-1 has its result, the other three run again.
        calls.length = 0;
        expect(await ladderMain(argv, { spawn, log: () => {} })).toBe(0);
        expect(calls.map((c) => c.args[c.args.indexOf("--out") + 1])).toEqual([path.join(out, "L0/shop-1"), path.join(out, "L1/shop-2"), path.join(out, "L0/shop-2")]);
        // A trial the bench stopped (its state saved) is continued with --resume.
        fs.writeFileSync(path.join(out, "L0/shop-2/bench-state.json"), "{}");
        calls.length = 0;
        expect(await ladderMain(argv, { spawn, log: () => {} })).toBe(0);
        expect(calls.find((c) => c.args.includes(path.join(out, "L0/shop-2")))!.args.at(-1)).toBe("--resume");
        expect(calls.find((c) => c.args.includes(path.join(out, "L0/shop-1")))!.args).not.toContain("--resume");
        // --plan-only runs nothing.
        calls.length = 0;
        const lines: string[] = [];
        expect(await ladderMain([...argv.slice(0, -4), "--plan-only", ...argv.slice(-4)], { spawn, log: (s) => lines.push(s) })).toBe(0);
        expect(calls).toEqual([]);
        expect(lines.join("\n")).toContain("L0 shop wave 2");
        fs.rmSync(root, { recursive: true, force: true });
    });

    it("refuses a rung without a tree, a repeated rung, and a missing --out", async () => {
        const log = () => {};
        expect(await ladderMain(["--rungs", "L0=/nope", "--apps", "shop", "--out", "/tmp/x"], { spawn: () => 0, log })).toBe(2);
        expect(await ladderMain(["--rungs", `L0=${os.tmpdir()},L0=${os.tmpdir()}`, "--apps", "shop", "--out", "/tmp/x"], { spawn: () => 0, log })).toBe(2);
        expect(await ladderMain(["--rungs", `L0=${os.tmpdir()}`, "--apps", "shop"], { spawn: () => 0, log })).toBe(2);
        // The ladder sets --out (and --apps, --data-dir, --port-base, --yes, --resume) itself.
        expect(await ladderMain(["--rungs", `L0=${os.tmpdir()}`, "--apps", "shop", "--out", "/tmp/x", "--", "--out", "/tmp/y"], { spawn: () => 0, log })).toBe(2);
    });
});

describe("verdict", () => {
    it("passes when the candidate's minimum beats the baseline's maximum, or the median gap beats the larger range", () => {
        expect(verdict([1, 2, 2], [3, 4, 5])).toBe("better");
        // Overlap (2 is in both), median gap 3 > larger range 2: better; with range 3 it is not shown.
        expect(verdict([0, 1, 2], [2, 4, 4])).toBe("better");
        expect(verdict([0, 1, 2], [2, 4, 5])).toBe("not shown");
        expect(verdict([0, 1, 4], [2, 3, 4])).toBe("not shown");
        expect(verdict([3, 4, 5], [0, 1, 2])).toBe("worse");
        expect(verdict([], [1])).toBe("not measured");
    });
});

describe("ladderReport", () => {
    it("gives per rung the median and range over the trials that measured each metric, and lists every trial", () => {
        const root = tmp();
        const run = (rung: string, wave: number, m: Parameters<typeof writeTrial>[2] | null) => {
            const out = path.join(root, rung, `shop-${wave}`);
            fs.mkdirSync(out, { recursive: true });
            fs.writeFileSync(path.join(out, "ladder-run.json"), JSON.stringify({ format: 1, rung, tree: `/t/${rung}`, fingerprint: `fp${rung}`, app: "shop", wave, flags: [], exitCode: m ? 0 : 4 }));
            if (m) writeTrial(out, "shop", m);
        };
        run("L0", 1, { detected: 0, falsePositives: 5, cost: 1, durationMs: 60_000, reproductionRate: 0.5 });
        run("L0", 2, { detected: 1, falsePositives: 7, cost: 3, durationMs: 180_000, reproductionRate: null });
        run("L4", 1, { detected: 4, falsePositives: 2, cost: 2, durationMs: 120_000, reproductionRate: 1 });
        run("L4", 2, null);
        const md = ladderReport(root);
        expect(md).toContain("| Confirmed (detected) | 0.5 (0–1) [2/2] | 4 (4–4) [1/2] |");
        expect(md).toContain("| False positives | 6 (5–7) [2/2] | 2 (2–2) [1/2] |");
        expect(md).toContain("| Cost (USD) | $2.00 ($1.00–$3.00) [2/2] | $2.00 ($2.00–$2.00) [1/2] |");
        expect(md).toContain("| Reproduction rate (replays) | 50% (50%–50%) [1/2] | 100% (100%–100%) [1/2] |");
        expect(md).toContain("| Time (min) | 2 (1–3) [2/2] | 2 (2–2) [1/2] |");
        // Stability from the entry's reruns: 1 of 2 runs passed. Mutation score: no saved data, not measured.
        expect(md).toContain("| Suite stability | 50% (50%–50%) [2/2] | 50% (50%–50%) [1/2] |");
        expect(md).toContain("| Mutation score | not measured | not measured |");
        expect(md).toContain("| L4 | 2 | shop | fpL4 | not finished (exit 4) |");
        expect(md).toContain("Detection, L4 against L0 (shop): better");
        fs.rmSync(root, { recursive: true, force: true });
    });

    it("takes the median, not the mean", () => {
        const root = tmp();
        for (const [wave, detected] of [[1, 0], [2, 1], [3, 5]] as const) {
            const out = path.join(root, "L0", `shop-${wave}`);
            fs.mkdirSync(out, { recursive: true });
            fs.writeFileSync(path.join(out, "ladder-run.json"), JSON.stringify({ format: 1, rung: "L0", tree: "/t", fingerprint: "fp", app: "shop", wave, flags: [], exitCode: 0 }));
            writeTrial(out, "shop", { detected, falsePositives: 0, cost: 0, durationMs: 0, reproductionRate: null });
        }
        expect(ladderReport(root)).toContain("| Confirmed (detected) | 1 (0–5) [3/3] |");
        fs.rmSync(root, { recursive: true, force: true });
    });
});
