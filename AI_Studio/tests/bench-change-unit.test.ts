/**
 * The PR bench (Phase 6 B2), browser-free: the repository examples/bench-repo/build.mjs makes (the §6.2 PR set, each PR one real change,
 * the same commits every time), the files GitHub would give for its PRs and what impact analysis reads from them, and the scorer
 * (src/eval/bench/change/score.ts) on a hand-built set of steps whose G1–G9 values were worked out by hand below. Local git only.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeImpact } from "../src/engine/impact/analyze.js";
import { BenchAppHost, benchApp } from "../src/eval/bench/apps.js";
import { gitOf, parseChangeArgs, prFiles, treeOf, type ManifestPr } from "../src/eval/bench/change/run.js";
import { caught, renderChangeMd, scoreChange, type PrStep, type RunRecord, type SetupRecord } from "../src/eval/bench/change/score.js";

const BUILD = path.join(import.meta.dirname, "..", "examples", "bench-repo", "build.mjs");
let dir = "";
let manifest: { main: string; prs: ManifestPr[] };
let git: ReturnType<typeof gitOf>;

beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-bench-repo-"));
    execFileSync(process.execPath, [BUILD, path.join(dir, "a")]);
    manifest = JSON.parse(fs.readFileSync(path.join(dir, "a", "prs.json"), "utf8"));
    git = gitOf(path.join(dir, "a"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const app = (name: string) => fs.readFileSync(path.join(import.meta.dirname, "..", "examples", name, "server.mjs"), "utf8");

describe("the bench repository", () => {
    it("holds the §6.2 PR set: 12 + 8 single-seed PRs plus the 8 + 3 Phase 4 extension seeds, a fix and a false fix claim for each, 3 refactors, 1 decoy, 1 unmapped", () => {
        const count = (k: string) => manifest.prs.filter((p) => p.kind === k).length;
        expect([count("seed"), count("fix"), count("claim"), count("refactor"), count("decoy"), count("unmapped")]).toEqual([31, 31, 31, 3, 1, 1]);
        expect(manifest.prs.filter((p) => p.kind === "seed" && p.app === "bench-shop")).toHaveLength(20);
        expect(manifest.prs.map((p) => p.number)).toEqual(manifest.prs.map((_, i) => i + 1));
        // Each seed's claim and fix come after it and say they fix the same issue.
        for (const s of manifest.prs.filter((p) => p.kind === "seed")) {
            const claim = manifest.prs.find((p) => p.kind === "claim" && p.seed === s.seed)!;
            const fix = manifest.prs.find((p) => p.kind === "fix" && p.seed === s.seed)!;
            expect(claim.number).toBeGreaterThan(s.number);
            expect(fix.number).toBeGreaterThan(claim.number);
            expect(claim.issue).toBe(fix.issue);
            expect(fix.title).toContain(`Fixes #${fix.issue}`);
            expect([claim.base, fix.base]).toEqual([s.head, s.head]);
        }
    });

    it("a seed PR turns exactly its seed on in code; its fix is main again; its claim still has the bug", () => {
        for (const s of manifest.prs.filter((p) => p.kind === "seed")) {
            const file = `examples/${s.app}/server.mjs`;
            const src = app(s.app);
            expect(git("show", `${s.head}:${file}`), s.seed).toBe(src.split(`on("${s.seed}")`).join("true"));
            expect(git("show", `${s.head}:${file}`)).not.toContain(`on("${s.seed}")`);
            const fix = manifest.prs.find((p) => p.kind === "fix" && p.seed === s.seed)!;
            expect(git("rev-parse", `${fix.head}^{tree}`)).toBe(git("rev-parse", `${manifest.main}^{tree}`));
            const claim = manifest.prs.find((p) => p.kind === "claim" && p.seed === s.seed)!;
            expect(git("show", `${claim.head}:${file}`).startsWith(git("show", `${s.head}:${file}`))).toBe(true);
        }
        // main is the apps as they are, with every seed off.
        expect(git("show", `${manifest.main}:examples/bench-shop/server.mjs`)).toBe(app("bench-shop"));
    });

    it("gives the same commits every time it is built", () => {
        execFileSync(process.execPath, [BUILD, path.join(dir, "b")]);
        expect(fs.readFileSync(path.join(dir, "b", "prs.json"), "utf8")).toBe(fs.readFileSync(path.join(dir, "a", "prs.json"), "utf8"));
        expect(() => execFileSync(process.execPath, [BUILD, path.join(dir, "a")], { stdio: "pipe" })).toThrow(/not empty/);
    });

    it("answers each PR's files as GitHub's files API does: hunks only, a rename with its old name", () => {
        const seed = manifest.prs.find((p) => p.seed === "BS-03" && p.kind === "seed")!;
        const files = prFiles(git, seed);
        expect(files).toHaveLength(1);
        expect(files[0]).toMatchObject({ filename: "examples/bench-shop/server.mjs", status: "modified" });
        expect(files[0]!.patch!.startsWith("@@ ")).toBe(true);
        expect(files[0]!.patch!.split("\n").filter((l) => l.startsWith("+") && l.includes("true ? MAX_PER_ITEM + 1"))).toHaveLength(2);
        const decoy = manifest.prs.find((p) => p.kind === "decoy")!;
        expect(prFiles(git, decoy)).toEqual([expect.objectContaining({ filename: "examples/bench-shop/cart-routes.mjs", status: "renamed", previous_filename: "examples/bench-shop/cart.mjs" })]);
    });

    it("feeds impact analysis: a seed PR reaches its route, the decoy and the unmapped change reach none", async () => {
        const analyse = async (pr: ManifestPr) =>
            analyzeImpact({ files: prFiles(git, pr).map((f) => ({ path: f.filename, status: f.status as never, ...(f.patch ? { patch: f.patch } : {}), ...(f.previous_filename ? { previousPath: f.previous_filename } : {}) })), sources: treeOf(git, pr.head) });
        const bs06 = await analyse(manifest.prs.find((p) => p.seed === "BS-06" && p.kind === "seed")!);
        expect(bs06.endpoints.map((e) => `${e.method} ${e.path}`)).toEqual(["PUT /api/profile"]);
        for (const kind of ["decoy", "unmapped"]) {
            const r = await analyse(manifest.prs.find((p) => p.kind === kind)!);
            expect(r.endpoints, kind).toEqual([]);
            expect(r.unmapped, kind).toHaveLength(1);
        }
    });
});

describe("a benchmark app's start", () => {
    it("refuses when another process already answers on its port", async () => {
        const other = http.createServer((_q, r) => r.end("someone else"));
        await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
        const port = (other.address() as AddressInfo).port;
        try {
            await expect(new BenchAppHost(benchApp("bench-shop")!, port).start("none")).rejects.toThrow(`Another process already answers on port ${port}`);
        } finally {
            await new Promise((resolve) => other.close(resolve));
        }
    });
});

describe("the command's options", () => {
    it("needs a folder, and a repository unless only reporting", () => {
        expect(() => parseChangeArgs(["--repo", "x"])).toThrow(/--out/);
        expect(() => parseChangeArgs(["--out", "x"])).toThrow(/--repo/);
        expect(parseChangeArgs(["--out", "x", "--report"])).toMatchObject({ report: true, repeat: 5, all: false });
        expect(parseChangeArgs(["--out", "x", "--repo", "y", "--all", "--repeat", "3"])).toMatchObject({ all: true, repeat: 3 });
        expect(() => parseChangeArgs(["--out", path.join(import.meta.dirname, "..", "data"), "--report"])).toThrow(/own \.\/data/);
        expect(() => parseChangeArgs(["--out", "x", "--repo", "y", "--repeat", "0"])).toThrow(/whole number/);
    });
});

// ── the scorer on hand-built steps ──────────────────────────────────────────
const run = (repeat: number, arm: "focused" | "full", ms: number, failed: string[] = [], extra: Partial<RunRecord> = {}): RunRecord => ({ repeat, arm, tests: arm === "full" ? 10 : 2, ms, failed, notRun: [], ...extra });
const sel = (selected: string[], explained = selected, fullRunRecommended = false) => ({ total: 10, selected, explained, fullRunRecommended, fullRunReasons: fullRunRecommended ? ["1 of 1 changed files reach no route."] : [], unmapped: [], endpoints: [] });
const SETUP: SetupRecord = { main: "m", suite: { "bench-shop": 10 }, repeat: 2, aiCalls: 0, g5: { pass: true, notes: [] } };
const base = { app: "bench-shop", title: "t", head: "h", aiCalls: 0, stepMs: 1 };
const STEPS: PrStep[] = [
    // caught in both repeats; time shares 20/100 and 30/80 → median 0.2875
    { ...base, number: 1, kind: "seed", seed: "BS-01", selection: sel(["T1", "T2"]), runs: [run(1, "focused", 20, ["T1"]), run(1, "full", 100, ["T1", "T3"]), run(2, "full", 80, ["T1"]), run(2, "focused", 30, ["T1"])] },
    // its failing test T6 is not in the focused set: missed twice; one selected test has no reason; time shares .2 and .4 → .3
    { ...base, number: 2, kind: "seed", seed: "BS-02", selection: sel(["T5"], []), runs: [run(1, "focused", 10), run(1, "full", 50, ["T6"]), run(2, "full", 50, ["T6"]), run(2, "focused", 20)] },
    { ...base, number: 3, kind: "fix", seed: "BS-01", selection: sel(["T1", "T2"]), runs: [run(1, "focused", 10), run(1, "full", 100), run(2, "full", 100), run(2, "focused", 10)], fixCheck: { issue: 101, linked: 1, findings: [{ id: "f1", test: "T1", state: "fixed", stillReproduces: false, inRegressionSuite: true, reopened: true }] } },
    { ...base, number: 4, kind: "claim", seed: "BS-01", selection: sel(["T1"]), runs: [], fixCheck: { issue: 101, linked: 1, findings: [{ id: "f1", test: "T1", state: "confirmed", stillReproduces: true, inRegressionSuite: false }] } },
    { ...base, number: 5, kind: "decoy", selection: sel([], [], true), runs: [run(1, "focused", 0, [], { skipped: true, tests: 0 }), run(1, "full", 100), run(2, "full", 100), run(2, "focused", 0, [], { skipped: true, tests: 0 })] },
    { ...base, number: 6, kind: "unmapped", aiCalls: 1, selection: sel([]), runs: [run(1, "focused", 0, [], { skipped: true, tests: 0 }), run(1, "full", 100), run(2, "full", 100), run(2, "focused", 0, [], { skipped: true, tests: 0 })] },
];
const crit = (steps: PrStep[], id: string, setup = SETUP) => scoreChange(setup, steps).criteria.find((c) => c.id === id)!;

describe("the PR bench's G7: X2's quality history against the bench's own count", () => {
    // f1 is confirmed at its seed PR, Fixed by its fix PR, comes back once (reopened) and is confirmed again: 2 confirmations, 1 reopen.
    const steps = STEPS.map((p) => (p.number === 1 ? { ...p, confirmed: { issue: 101, findings: ["f1"], failingTests: ["T1"] } } : p));
    it("meets when the history's confirmations, reopens and reopened findings equal the bench's, per app", () => {
        const g7 = scoreChange(SETUP, steps, { "bench-shop": { confirmed: 2, reopened: 1, reopenedFindings: 1 } }).criteria.find((c) => c.id === "G7")!;
        expect(g7).toMatchObject({ verdict: "meets", value: "bench-shop: confirmed 2 = 2, reopened 1 = 1, reopened findings 1 = 1" });
    });
    it("misses on any difference, and is not measured without a history", () => {
        const g7 = scoreChange(SETUP, steps, { "bench-shop": { confirmed: 3, reopened: 1, reopenedFindings: 1 } }).criteria.find((c) => c.id === "G7")!;
        expect(g7.verdict).toBe("misses");
        expect(g7.notes).toContain("bench-shop: the history says 3 confirmations, the bench counted 2.");
        expect(scoreChange(SETUP, steps).criteria.find((c) => c.id === "G7")!.verdict).toBe("not measured");
    });
});

describe("the PR bench's scores", () => {
    it("G1 is judged per repeat on PRs whose full run fails: 1 of 2 caught each time, so 50%, and the seed PR that missed is named", () => {
        expect([caught(STEPS[0]!, 1), caught(STEPS[1]!, 1), caught(STEPS[2]!, 1)]).toEqual([true, false, undefined]);
        const g1 = crit(STEPS, "G1");
        expect(g1.verdict).toBe("misses");
        expect(g1.value).toBe("all PRs 50% (range 50%–50%, n=2); single-seed PRs 50% (range 50%–50%, n=2)");
        expect(g1.notes).toEqual(["Missed in at least one repeat: #2 seed BS-02."]);
        // With the second seed's failing test selected too, every one is caught.
        const all = STEPS.map((p) => (p.number === 2 ? { ...p, selection: sel(["T5", "T6"]) } : p));
        expect(crit(all, "G1")).toMatchObject({ verdict: "meets", value: "all PRs 100% (range 100%–100%, n=2); single-seed PRs 100% (range 100%–100%, n=2)" });
    });

    it("G1 with no failing full run is not measured, never 0% or 100%", () => {
        expect(crit([STEPS[2]!, STEPS[4]!], "G1")).toMatchObject({ verdict: "not measured" });
        expect(crit([], "G1").verdict).toBe("not measured");
    });

    it("G2 takes each PR's median time share, then the median over PRs: tests 10%, time 10%", () => {
        const g2 = crit(STEPS, "G2");
        // sizes .2 .1 .2 0 0 → .1; time .2875 .3 .1 0 0 → .1 (the claim has no runs and is left out)
        expect(g2.value).toBe("tests 10% (range 0%–20%, n=5); time 10% (range 0%–30%, n=5) (over PRs; each PR its median over repeats)");
        expect(g2.verdict).toBe("meets");
        const rows = scoreChange(SETUP, STEPS).prs;
        expect(rows[0]!.timeShare).toEqual({ median: 0.2875, min: 0.2, max: 0.375, n: 2 });
        // Half the suite selected for every measured PR misses the 40% size target.
        const wide = STEPS.map((p) => ({ ...p, selection: { ...p.selection!, selected: ["T1", "T2", "T3", "T4", "T5"], explained: ["T1", "T2", "T3", "T4", "T5"] } }));
        expect(crit(wide, "G2").verdict).toBe("misses");
    });

    it("G3 counts selected tests with a reason over every analysed PR (5 of 6) and the decoy's selections", () => {
        expect(crit(STEPS, "G3")).toMatchObject({ verdict: "misses", value: "5 of 6 selected tests explained (83.3%); decoy selected 0" });
        const decoyPicks = STEPS.map((p) => (p.kind === "decoy" ? { ...p, selection: sel(["T9"]) } : p.number === 2 ? { ...p, selection: sel(["T5"]) } : p));
        expect(crit(decoyPicks, "G3")).toMatchObject({ verdict: "misses", value: "7 of 7 selected tests explained (100%); decoy selected 1" });
        expect(crit(STEPS.map((p) => (p.number === 2 ? { ...p, selection: sel(["T5"]) } : p)), "G3").verdict).toBe("meets");
    });

    it("G4 asks every unmapped change for a full run", () => {
        expect(crit(STEPS, "G4")).toMatchObject({ verdict: "misses", value: "0 of 1" });
        expect(crit(STEPS.map((p) => (p.kind === "unmapped" ? { ...p, selection: sel([], [], true) } : p)), "G4")).toMatchObject({ verdict: "meets", value: "1 of 1" });
    });

    it("G5 follows the setup's full run", () => {
        expect(crit(STEPS, "G5").verdict).toBe("meets");
        expect(crit(STEPS, "G5", { ...SETUP, g5: { pass: false, notes: ["x"] } }).verdict).toBe("misses");
    });

    it("G6: Fixed, in the Regression suite and reopened, with the claim not Fixed; any one of them failing misses", () => {
        expect(crit(STEPS, "G6")).toMatchObject({ verdict: "meets", value: "Fixed 1 of 1 fix-PR findings; wrong Fixed 0 of 1 claim findings; in the Regression suite 1 of 1; reopened 1 of 1" });
        const edit = (n: number, f: Record<string, unknown>) => STEPS.map((p) => (p.number === n ? { ...p, fixCheck: { ...p.fixCheck!, findings: [{ ...p.fixCheck!.findings[0]!, ...f }] } } : p));
        expect(crit(edit(4, { state: "fixed" }), "G6").value).toContain("wrong Fixed 1 of 1");
        expect(crit(edit(4, { state: "fixed" }), "G6").verdict).toBe("misses");
        expect(crit(edit(3, { state: "confirmed" }), "G6").verdict).toBe("misses");
        expect(crit(edit(3, { inRegressionSuite: false }), "G6").verdict).toBe("misses");
        expect(crit(edit(3, { reopened: false }), "G6").verdict).toBe("misses");
        expect(crit(STEPS.filter((p) => p.kind !== "fix"), "G6").verdict).toBe("not measured");
        expect(crit(edit(3, { fixedAgain: false }), "G6").notes).toContain("Fixed again when the fix was deployed again after the return: 0 of 1.");
    });

    it("G7 is not measured on this base; G9 allows one AI call per PR, not two", () => {
        expect(crit(STEPS, "G7").verdict).toBe("not measured");
        expect(crit(STEPS, "G9")).toMatchObject({ verdict: "meets", value: "max 1 per PR over 6 PRs (setup 0)" });
        expect(crit(STEPS.map((p) => (p.number === 6 ? { ...p, aiCalls: 2 } : p)), "G9").verdict).toBe("misses");
    });

    it("says which runs had problems and which PRs lack repeats, and renders every PR", () => {
        const broken = STEPS.map((p) => (p.number === 1 ? { ...p, runs: [...p.runs.slice(0, 3), { ...p.runs[3]!, notRun: ["T2"] }] } : p.number === 3 ? { ...p, runs: p.runs.slice(0, 2) } : p));
        const r = scoreChange(SETUP, broken);
        expect(r.notes).toEqual(["1 run(s) with tests not run, findings left unverified, or no wall time.", "The full run's failing tests differ between repeats for #1.", "1 PR(s) do not have 2 focused and 2 full runs."]);
        const masked = STEPS.map((p) => (p.number === 1 ? { ...p, runs: p.runs.map((r, i) => (i === 1 ? { ...r, reported: [] } : r)) } : p));
        expect(scoreChange(SETUP, masked).notes[0]).toBe("1 run(s) reported other failures than the app's checks gave (a test tracking an open bug runs as an expected failure); the scores use the app's outcome.");
        expect(crit(masked, "G1").value).toBe(crit(STEPS, "G1").value);
        const md = renderChangeMd(scoreChange(SETUP, STEPS));
        expect(md).toContain("| G1 | Recall");
        expect(md.match(/^\| #\d+ \|/gm)).toHaveLength(6);
    });
});
