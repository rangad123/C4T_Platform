/**
 * The PR bench's scores (testing-engine Phase 6, spec §6.2): G1–G7 and G9 from the steps run.ts recorded. Pure: no platform, no files.
 * Targets are the spec's, frozen before the first run; a criterion with nothing to score says "not measured", never 0 or 100%.
 */
import { median } from "../repeat/report.js";

export interface RunRecord {
    repeat: number;
    arm: "focused" | "full";
    tests: number;
    /** Wall time of the run's job (started to finished), ms. */
    ms: number;
    /** Test keys that failed. */
    failed: string[];
    /** Test keys that did not pass or fail (not run, skipped). */
    notRun: string[];
    /** The focused set was empty: nothing ran. */
    skipped?: boolean;
    /** The run's findings were still waiting for verification when the bench went on. */
    unsettled?: boolean;
    jobId?: string;
}
export interface FixCheckRecord {
    issue: number | null;
    /** Findings the seed's PR confirmed and filed as the issue. */
    linked: number;
    delivery?: number;
    jobId?: string;
    findings: Array<{ id: string; test: string | null; state: string; stillReproduces: boolean; inRegressionSuite: boolean; reopened?: boolean; stateAfterReturn?: string }>;
    returned?: { jobId: string | null; failed: string[] };
}
export interface PrStep {
    number: number;
    kind: "seed" | "claim" | "fix" | "refactor" | "decoy" | "unmapped";
    app: string;
    seed?: string;
    title: string;
    head: string;
    selection?: { total: number; selected: string[]; explained: string[]; fullRunRecommended: boolean; fullRunReasons: string[]; unmapped: string[]; endpoints: string[] };
    runs: RunRecord[];
    /** AI calls made while the PR was analysed and selected (G9). */
    aiCalls: number;
    stepMs: number;
    confirmed?: { issue: number | null; findings: string[]; failingTests: string[] };
    fixCheck?: FixCheckRecord;
}
export interface SetupRecord {
    main: string;
    suite: Record<string, number>;
    repeat: number;
    aiCalls: number;
    g5: { pass: boolean; notes: string[] };
}

export type Verdict = "meets" | "misses" | "not measured";
export interface Spread {
    median: number;
    min: number;
    max: number;
    n: number;
}
export interface Criterion {
    id: string;
    name: string;
    target: string;
    verdict: Verdict;
    value: string;
    notes: string[];
}
export interface PrRow {
    number: number;
    kind: PrStep["kind"];
    app: string;
    seed?: string;
    selected: number;
    total: number;
    fullRunRecommended: boolean;
    /** Repeats whose full run had a failing test, and of those, repeats whose focused set held one (G1). */
    failingRepeats: number;
    caughtRepeats: number;
    fullFailed: string[];
    focusedMs: Spread | null;
    fullMs: Spread | null;
    timeShare: Spread | null;
    fixState?: string;
}
export interface ChangeReport {
    criteria: Criterion[];
    prs: PrRow[];
    trials: { prs: number; runs: number; runsWithProblems: number; repeats: number };
    notes: string[];
}

export const spread = (xs: number[]): Spread | null => (xs.length ? { median: median(xs)!, min: Math.min(...xs), max: Math.max(...xs), n: xs.length } : null);
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const fmtSpread = (s: Spread | null, f: (x: number) => string) => (s ? `${f(s.median)} (range ${f(s.min)}–${f(s.max)}, n=${s.n})` : "—");
const MEASURED: ReadonlyArray<PrStep["kind"]> = ["seed", "fix", "refactor", "decoy", "unmapped"];
const runOf = (p: PrStep, r: number, arm: "focused" | "full") => p.runs.find((x) => x.repeat === r && x.arm === arm);
const repeatsOf = (p: PrStep) => [...new Set(p.runs.map((r) => r.repeat))].sort((a, b) => a - b);

/** G1 for one PR and repeat: undefined when the full run had no failing test; else whether the focused set holds one of them. */
export function caught(p: PrStep, r: number): boolean | undefined {
    const full = runOf(p, r, "full");
    if (!full?.failed.length) return undefined;
    const selected = new Set(p.selection?.selected ?? []);
    return full.failed.some((k) => selected.has(k));
}

export function scoreChange(setup: SetupRecord, steps: PrStep[]): ChangeReport {
    const measured = steps.filter((p) => MEASURED.includes(p.kind));
    const repeats = [...new Set(measured.flatMap(repeatsOf))].sort((a, b) => a - b);
    const criteria: Criterion[] = [];
    const notes: string[] = [];

    // G1: per repeat, the share of PRs with a failing full run whose focused set holds a failing test; then median and range.
    const rate = (ps: PrStep[], r: number) => {
        const judged = ps.map((p) => caught(p, r)).filter((x): x is boolean => x !== undefined);
        return judged.length ? judged.filter(Boolean).length / judged.length : undefined;
    };
    const g1All = spread(repeats.map((r) => rate(measured, r)).filter((x): x is number => x !== undefined));
    const seeds = measured.filter((p) => p.kind === "seed");
    const g1Seed = spread(repeats.map((r) => rate(seeds, r)).filter((x): x is number => x !== undefined));
    const uncovered = seeds.filter((p) => repeatsOf(p).every((r) => caught(p, r) === undefined)).map((p) => p.seed!);
    const missed = measured.filter((p) => repeatsOf(p).some((r) => caught(p, r) === false)).map((p) => `#${p.number} ${p.kind} ${p.seed ?? ""}`.trim());
    criteria.push({
        id: "G1",
        name: "Recall: PRs whose full run fails and whose focused set holds a failing test",
        target: "≥ 90% of PRs; 100% of single-seed PRs whose seed has a covering test",
        verdict: !g1All || !g1Seed ? "not measured" : g1All.min >= 0.9 && g1Seed.min === 1 ? "meets" : "misses",
        value: `all PRs ${fmtSpread(g1All, pct)}; single-seed PRs ${fmtSpread(g1Seed, pct)}`,
        notes: [...(uncovered.length ? [`No test of the suite fails for ${uncovered.join(", ")}: not judged.`] : []), ...(missed.length ? [`Missed in at least one repeat: ${missed.join("; ")}.`] : [])],
    });

    // G2: per PR the focused share of tests and of wall time (per PR the median over its repeats); then the median over PRs.
    const rows: PrRow[] = steps.map((p) => {
        const rs = repeatsOf(p);
        const share = rs.map((r) => {
            const f = runOf(p, r, "focused");
            const full = runOf(p, r, "full");
            return f && full && full.ms > 0 ? (f.skipped ? 0 : f.ms) / full.ms : NaN;
        });
        return {
            number: p.number,
            kind: p.kind,
            app: p.app,
            ...(p.seed ? { seed: p.seed } : {}),
            selected: p.selection?.selected.length ?? 0,
            total: p.selection?.total ?? 0,
            fullRunRecommended: p.selection?.fullRunRecommended ?? false,
            failingRepeats: rs.filter((r) => caught(p, r) !== undefined).length,
            caughtRepeats: rs.filter((r) => caught(p, r) === true).length,
            fullFailed: [...new Set(p.runs.filter((r) => r.arm === "full").flatMap((r) => r.failed))].sort(),
            focusedMs: spread(p.runs.filter((r) => r.arm === "focused").map((r) => r.ms)),
            fullMs: spread(p.runs.filter((r) => r.arm === "full").map((r) => r.ms)),
            timeShare: spread(share.filter((x) => Number.isFinite(x))),
            ...(p.fixCheck?.findings.length ? { fixState: [...new Set(p.fixCheck.findings.map((f) => f.state))].join(", ") } : {}),
        };
    });
    const mRows = rows.filter((r) => MEASURED.includes(r.kind) && r.total > 0);
    const sizeShare = spread(mRows.map((r) => r.selected / r.total));
    const timeShare = spread(mRows.map((r) => r.timeShare?.median).filter((x): x is number => x !== undefined));
    criteria.push({
        id: "G2",
        name: "Focus: focused size and wall time against the full suite",
        target: "median ≤ 40% of tests, ≤ 50% of time",
        verdict: !sizeShare || !timeShare ? "not measured" : sizeShare.median <= 0.4 && timeShare.median <= 0.5 ? "meets" : "misses",
        value: `tests ${fmtSpread(sizeShare, pct)}; time ${fmtSpread(timeShare, pct)} (over PRs; each PR its median over repeats)`,
        notes: (["seed", "fix", "refactor", "decoy", "unmapped"] as const).map((k) => {
            const ks = mRows.filter((r) => r.kind === k);
            return `${k}: tests ${fmtSpread(spread(ks.map((r) => r.selected / r.total)), pct)}, time ${fmtSpread(spread(ks.map((r) => r.timeShare?.median).filter((x): x is number => x !== undefined)), pct)}`;
        }),
    });

    // G3: every selected test has at least one evidence-backed reason; the decoy selects nothing.
    const withSel = steps.filter((p) => p.selection);
    const selectedN = withSel.reduce((n, p) => n + p.selection!.selected.length, 0);
    const explainedN = withSel.reduce((n, p) => n + p.selection!.selected.filter((k) => p.selection!.explained.includes(k)).length, 0);
    const decoys = steps.filter((p) => p.kind === "decoy" && p.selection);
    const decoySelected = decoys.reduce((n, p) => n + p.selection!.selected.length, 0);
    criteria.push({
        id: "G3",
        name: "Explanations: selected tests with an evidence-backed reason; selections from the decoy",
        target: "100%; 0",
        verdict: !selectedN || !decoys.length ? "not measured" : explainedN === selectedN && decoySelected === 0 ? "meets" : "misses",
        value: `${explainedN} of ${selectedN} selected tests explained (${selectedN ? pct(explainedN / selectedN) : "—"}); decoy selected ${decoys.length ? decoySelected : "—"}`,
        notes: [],
    });

    // G4: a change in an unmapped file recommends a full run.
    const unmapped = steps.filter((p) => p.kind === "unmapped" && p.selection);
    const g4 = unmapped.filter((p) => p.selection!.fullRunRecommended).length;
    criteria.push({
        id: "G4",
        name: "Unmapped change → full run recommended",
        target: "100%",
        verdict: !unmapped.length ? "not measured" : g4 === unmapped.length ? "meets" : "misses",
        value: `${g4} of ${unmapped.length}`,
        notes: [...unmapped, ...decoys].map((p) => `#${p.number} ${p.kind}: ${p.selection!.fullRunRecommended ? "full run recommended" : "no full run recommended"}${p.selection!.fullRunReasons.length ? ` (${p.selection!.fullRunReasons[0]})` : ""}`),
    });

    criteria.push({ id: "G5", name: "Full suite runnable from the same PR view and trigger", target: "test passes", verdict: setup.g5.pass ? "meets" : "misses", value: setup.g5.pass ? "passes" : "fails", notes: setup.g5.notes });

    // G6: the fix PRs' findings become Fixed (after passing attempts on the fixed build), the claims' never; each Fixed one joins the
    // Regression suite and reopens when its bug comes back.
    const fixes = steps.filter((p) => p.kind === "fix" && p.fixCheck?.findings.length);
    const claims = steps.filter((p) => p.kind === "claim" && p.fixCheck?.findings.length);
    const fixF = fixes.flatMap((p) => p.fixCheck!.findings);
    const fixed = fixF.filter((f) => f.state === "fixed");
    const wrong = claims.flatMap((p) => p.fixCheck!.findings).filter((f) => f.state === "fixed");
    const inSuite = fixed.filter((f) => f.inRegressionSuite).length;
    const reopened = fixed.filter((f) => f.reopened).length;
    const noFinding = steps.filter((p) => p.kind === "fix" && !p.fixCheck?.linked).map((p) => p.seed!);
    criteria.push({
        id: "G6",
        name: "Regression: Fixed after passing attempts; a claim that does not fix is not Fixed; regression test added; reopen on return",
        target: "100%, 0 wrong Fixed, 100%, 100%",
        verdict: !fixF.length ? "not measured" : fixed.length === fixF.length && wrong.length === 0 && inSuite === fixed.length && reopened === fixed.length ? "meets" : "misses",
        value: `Fixed ${fixed.length} of ${fixF.length} fix-PR findings; wrong Fixed ${wrong.length} of ${claims.flatMap((p) => p.fixCheck!.findings).length} claim findings; in the Regression suite ${inSuite} of ${fixed.length}; reopened ${reopened} of ${fixed.length}`,
        notes: [
            ...(noFinding.length ? [`No confirmed finding to fix (nothing failed, or verification did not reproduce it): ${noFinding.join(", ")}.`] : []),
            ...fixF.filter((f) => f.state !== "fixed").map((f) => `${f.test}: ${f.state} after its fix PR.`),
            ...fixed.filter((f) => !f.reopened).map((f) => `${f.test}: not reopened when the bug came back (${f.stateAfterReturn ?? "not checked"}).`),
        ],
    });

    criteria.push({
        id: "G7",
        name: "History numbers equal hand-computed values on a fixture history",
        target: "exact",
        verdict: "not measured",
        value: "—",
        notes: [`The quality history (Phase 6 X2, trends.ts) is not on this base; the bench's own history to compare it with: ${fixed.length} Fixed, ${fixed.filter((f) => f.reopened).length} reopened, ${steps.filter((p) => p.selection).length} PRs analysed, ${steps.filter((p) => p.confirmed?.findings.length).reduce((n, p) => n + p.confirmed!.findings.length, 0)} findings confirmed.`],
    });

    const calls = steps.map((p) => p.aiCalls);
    const maxCalls = calls.length ? Math.max(...calls) : 0;
    criteria.push({ id: "G9", name: "AI cost: calls per PR for impact and selection", target: "≤ 1 (0 by default)", verdict: !calls.length ? "not measured" : maxCalls === 0 ? "meets" : maxCalls <= 1 ? "meets" : "misses", value: `max ${maxCalls} per PR over ${calls.length} PRs (setup ${setup.aiCalls})`, notes: [] });

    const allRuns = measured.flatMap((p) => p.runs);
    const problems = allRuns.filter((r) => r.notRun.length || r.unsettled || !Number.isFinite(r.ms));
    if (problems.length) notes.push(`${problems.length} run(s) with tests not run, findings left unverified, or no wall time.`);
    const flaky = measured.filter((p) => new Set(p.runs.filter((r) => r.arm === "full").map((r) => r.failed.join(","))).size > 1);
    if (flaky.length) notes.push(`The full run's failing tests differ between repeats for ${flaky.map((p) => `#${p.number}`).join(", ")}.`);
    const missing = measured.filter((p) => repeatsOf(p).length !== setup.repeat || p.runs.length !== 2 * setup.repeat);
    if (missing.length) notes.push(`${missing.length} PR(s) do not have ${setup.repeat} focused and ${setup.repeat} full runs.`);
    return { criteria, prs: rows, trials: { prs: steps.length, runs: allRuns.length, runsWithProblems: problems.length, repeats: setup.repeat }, notes };
}

export function renderChangeMd(r: ChangeReport): string {
    const ms = (s: Spread | null) => (s ? `${Math.round(s.median)} (${Math.round(s.min)}–${Math.round(s.max)})` : "—");
    const L = [
        "# PR bench",
        "",
        `${r.trials.prs} pull requests, ${r.trials.runs} measured runs (${r.trials.repeats} focused and ${r.trials.repeats} full per PR, alternating), ${r.trials.runsWithProblems} with problems.`,
        "",
        "| # | Criterion | Target | Result | Verdict |",
        "| --- | --- | --- | --- | --- |",
        ...r.criteria.map((c) => `| ${c.id} | ${c.name} | ${c.target} | ${c.value} | ${c.verdict} |`),
        "",
        ...r.criteria.flatMap((c) => (c.notes.length ? [`**${c.id}**`, ...c.notes.map((n) => `- ${n}`), ""] : [])),
        ...(r.notes.length ? ["**Run notes**", ...r.notes.map((n) => `- ${n}`), ""] : []),
        "## Per pull request",
        "",
        "| PR | Kind | App | Seed | Selected | Full run recommended | Full fails (tests) | G1 caught | Focused ms | Full ms | Time share | Fix check |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ...r.prs.map(
            (p) =>
                `| #${p.number} | ${p.kind} | ${p.app} | ${p.seed ?? ""} | ${p.selected}/${p.total} | ${p.fullRunRecommended ? "yes" : "no"} | ${p.fullFailed.join(", ") || "—"} | ${p.failingRepeats ? `${p.caughtRepeats}/${p.failingRepeats}` : "—"} | ${ms(p.focusedMs)} | ${ms(p.fullMs)} | ${p.timeShare ? `${pct(p.timeShare.median)} (${pct(p.timeShare.min)}–${pct(p.timeShare.max)})` : "—"} | ${p.fixState ?? ""} |`,
        ),
        "",
    ];
    return L.join("\n");
}
