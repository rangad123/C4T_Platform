/**
 * The risk score of a proposed test (testing-engine Phase 6): a fixed, explainable sum like explore/priority.ts, never a learned one.
 * Each factor is named with its value and its points in the reason shown beside the test:
 *
 *   change impact        how many entries of the change its footprint reaches       3 each, at most 3 entries
 *   business criticality the test's priority                                       critical 4, high 3, medium 1, low 0
 *   failure rate         recent runs of its current script that did not pass         0–4 (the share of 4)
 *   previous defects     findings seen before on what it reaches                     2 each, at most 3
 *   workflow dependency  app-model workflows whose steps its footprint takes part in 1 each, at most 3
 *   reliability          quarantined −2, unreliable (flaky) −1: its result counts for less
 *
 * The score only orders the proposed tests. It never removes one: a quarantined or flaky test that covers the change stays proposed.
 * `fullRunRecommendation` says when a focused run is not enough: too much of the change maps to nothing, or a shared part changed.
 */

export interface RiskFacts {
    /** The test's stored priority. */
    priority?: string;
    /** Recent runs of its current script, and how many of them did not pass. */
    runs: number;
    failed: number;
    /** Findings seen before on the pages and endpoints it reaches. */
    defects: number;
    /** App-model workflows its footprint takes part in. */
    workflows: number;
    quarantined?: boolean;
    flaky?: boolean;
}

export interface RiskFactor {
    factor: "change impact" | "business criticality" | "failure rate" | "previous defects" | "workflow dependency" | "reliability";
    value: string;
    points: number;
}

export interface Risk {
    score: number;
    factors: RiskFactor[];
    reason: string;
}

export const NO_FACTS: RiskFacts = { runs: 0, failed: 0, defects: 0, workflows: 0 };
const CRITICALITY: Record<string, number> = { critical: 4, high: 3, medium: 1, low: 0 };
/** A focused run is not recommended when more than this share of the changed files reach no route on evidence. */
export const UNMAPPED_SHARE_LIMIT = 0.2;

const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

/** The score of a test whose footprint reaches `impact` entries of the change. */
export function riskOf(impact: number, f: RiskFacts = NO_FACTS): Risk {
    const priority = f.priority?.toLowerCase();
    const factors: RiskFactor[] = [
        { factor: "change impact", value: n(impact, "entry of the change", "entries of the change"), points: 3 * Math.min(impact, 3) },
        { factor: "business criticality", value: priority && priority in CRITICALITY ? priority : "not set", points: CRITICALITY[priority ?? ""] ?? 0 },
        { factor: "failure rate", value: f.runs ? `${f.failed} of ${n(f.runs, "recent run", "recent runs")} did not pass` : "no recent runs", points: f.runs ? Math.round((4 * f.failed) / f.runs) : 0 },
        { factor: "previous defects", value: n(f.defects, "finding", "findings"), points: 2 * Math.min(f.defects, 3) },
        { factor: "workflow dependency", value: n(f.workflows, "workflow", "workflows"), points: Math.min(f.workflows, 3) },
        {
            factor: "reliability",
            value: f.quarantined ? "quarantined: its result counts for less, and it stays proposed" : f.flaky ? "unreliable: its result counts for less, and it stays proposed" : "reliable",
            points: f.quarantined ? -2 : f.flaky ? -1 : 0,
        },
    ];
    const score = factors.reduce((s, x) => s + x.points, 0);
    return { score, factors, reason: `Risk ${score}: ${factors.map((x) => `${x.factor} ${x.value} (${x.points >= 0 ? "+" : "−"}${Math.abs(x.points)})`).join(", ")}.` };
}

/** What impact analysis (engine/impact/analyze.ts) says about the PR, as far as a full run depends on it. */
export interface ImpactSummary {
    files: number;
    unmapped: string[];
    shared: string[];
}

/** Whether only a full run is safe for this change, and why. */
export function fullRunRecommendation(i: ImpactSummary): string[] {
    const reasons: string[] = [];
    if (i.files > 0 && i.unmapped.length / i.files > UNMAPPED_SHARE_LIMIT) {
        reasons.push(
            `${i.unmapped.length} of ${n(i.files, "changed file", "changed files")} (${Math.round((100 * i.unmapped.length) / i.files)}%) reach no route on evidence, more than ${UNMAPPED_SHARE_LIMIT * 100}%: a focused run may miss what they change (${i.unmapped.slice(0, 5).join(", ")}).`,
        );
    }
    if (i.shared.length) reasons.push(`A shared part changed: code that runs outside every route handler reaches every request (${i.shared[0]}).`);
    return reasons;
}
