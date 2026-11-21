/**
 * Candidate findings (testing-engine Phase 3) as the run page shows them: the API's answer and the words for it. Browser-free, so tests
 * read the same rules the page uses.
 *
 *   GET /api/projects/:id/candidate-findings?job=  → FindingsAnswer: the findings this run found first or last, newest seen first.
 *
 * Phase 5 (U1): each finding also carries its lifecycle state and the server's `review` (src/platform/routes/explore-findings.ts): the
 * status label (findings/score.ts `label`, never "Confirmed" below high confidence), severity and confidence apart, reproduction, steps
 * and the likely cause with its label. The page only orders and shows them: Confirmed first by severity, then the ones a person must
 * review, then the rest folded by state.
 */

export type CaptureState = "captured" | "observed_only";
export type Independence = "independent" | "state_dependent" | "not_run" | "not_on_clean_state";
export type Confidence = "high" | "medium" | "low";

/** The finding itself (src/engine/explore/finding.ts CandidateFinding), as the page reads it. */
export interface CandidateFinding {
    objective: { id: string; kind: string; source: string; operator?: string } | null;
    actions: { stepCount: number };
    expected: { text: string; source: string | null };
    observed: string;
    evidence: { screenshots: string[]; requests: string[]; console: string[] };
    capture: CaptureState;
    independence: Independence;
    confidence: Confidence;
    fingerprint: string;
    modelVersion: string | null;
    replays: Array<{ label: string; outcome: "failed" | "passed" | "error"; failedStep?: number; summary: string }>;
}

export type Severity = "critical" | "high" | "medium" | "low";
/** A lifecycle state (src/engine/findings/lifecycle.ts FINDING_STATES). */
export type FindingState = string;

/** What the results card shows of a finding, worked out on the server (routes/explore-findings.ts reviewOf). */
export interface FindingReview {
    label: string;
    severity: Severity;
    severityBasis: string | null;
    confidence: Confidence;
    confidenceBasis: string;
    reproduction: { same: number; of: number };
    steps: Array<{ action: string; target?: string; url?: string }>;
    cause: { label: string; text: string };
    stateLabel: string;
    /** The state's place in the lifecycle. */
    stateRank: number;
    /** The verdicts the lifecycle lets a person give from this state. */
    personMay: { confirm: boolean; notABug: boolean };
}

/** One stored finding (src/platform/candidate-finding-store.ts CandidateFindingRecord). */
export interface FindingRecord {
    id: string;
    testId: string | null;
    confidence: Confidence;
    capture: CaptureState;
    seenCount: number;
    firstSeenAt: string;
    lastSeenAt: string;
    finding: CandidateFinding;
    state: FindingState;
    groupId: string | null;
    review: FindingReview;
}

export interface FindingsAnswer {
    findings: FindingRecord[];
}

export const CONFIDENCE_WORD: Record<Confidence, string> = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" };
export const CAPTURE_WORD: Record<CaptureState, string> = { captured: "Captured: kept as a failing check", observed_only: "Seen, not kept as a check" };
export const NOT_SETTLED = "Needs a person to check";

const SOURCED = "The expected result has a stated source";

/** What a confidence means (Decision 9, confidenceOf): high and medium need a stated source and a kept failing check; the replay decides. */
export function confidenceMeaning(f: Pick<CandidateFinding, "confidence" | "independence">): string {
    if (f.confidence === "high") return `${SOURCED}, the saved test fails at that check, and it failed the same way when replayed from a fresh start.`;
    if (f.confidence === "medium")
        return f.independence === "state_dependent"
            ? `${SOURCED} and the saved test fails at that check, but replayed from a fresh start it did not fail the same way, so it may depend on what ran before.`
            : f.independence === "not_on_clean_state"
              ? `${SOURCED} and the saved test fails at that check, and it failed the same way when replayed, but on the shared test account, so it may still depend on what earlier tests left there.`
              : `${SOURCED} and the saved test fails at that check, but it could not be replayed from a fresh start.`;
    return "The AI saw this while exploring, but no failing check of a stated expected result was kept.";
}

const EXPECTED_N = /^expected:(\d+)$/;

/** Where the expected result comes from: a rule or requirement by its reference, one of the test's planned expected results, or nowhere stated. */
export function sourceText(source: string | null): string {
    if (source === null) return "No stated source: the AI’s own expectation";
    const n = EXPECTED_N.exec(source);
    return n ? `Expected result ${n[1]} of the test’s plan` : `Stated in ${source}`;
}

const RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

/** Captured findings first, then higher confidence; otherwise the platform's order (newest seen first). */
export function findingOrder(list: readonly FindingRecord[]): FindingRecord[] {
    return list
        .map((f, i) => ({ f, i }))
        .sort((a, b) => Number(a.f.capture !== "captured") - Number(b.f.capture !== "captured") || RANK[a.f.confidence] - RANK[b.f.confidence] || a.i - b.i)
        .map((x) => x.f);
}

const OUTCOME_WORD = { failed: "failed", passed: "passed", error: "could not run" } as const;

/** One replay from a fresh start, in a sentence. */
export const replayText = (r: CandidateFinding["replays"][number]): string =>
    `Replayed from a fresh start: ${OUTCOME_WORD[r.outcome] ?? r.outcome}${r.outcome === "failed" && r.failedStep ? ` at step ${r.failedStep}` : ""}.${r.summary ? ` ${r.summary}` : ""}`;

/** What a finding's picture shows: the page where a fresh replay of its test stopped (row 173, findingShooter). */
export const shotAlt = (i: number, n: number): string => `Screenshot ${i + 1} of ${n}: the page where a fresh replay of this finding’s test stopped`;

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Confirmed (as the label says, so high confidence only), else needs a person's review (that state, or a "Possible …" label), else the rest. */
export function bucketOf(r: Pick<FindingRecord, "state" | "review">): "confirmed" | "review" | "rest" {
    if (r.review.label.startsWith("Confirmed ")) return "confirmed";
    return r.state === "needs_manual_review" || r.review.label.startsWith("Possible ") ? "review" : "rest";
}

/** By severity, worst first; then findingOrder. */
const bySeverity = (list: readonly FindingRecord[]) =>
    findingOrder(list)
        .map((f, i) => ({ f, i }))
        .sort((a, b) => SEVERITY_RANK[a.f.review.severity] - SEVERITY_RANK[b.f.review.severity] || a.i - b.i)
        .map((x) => x.f);

/** The card's order: Confirmed by severity, then Needs manual review by severity, then the rest folded by state (lifecycle order). */
export function findingSections(list: readonly FindingRecord[]): { confirmed: FindingRecord[]; review: FindingRecord[]; folded: Array<{ state: FindingState; label: string; findings: FindingRecord[] }> } {
    const rest = list.filter((r) => bucketOf(r) === "rest");
    return {
        confirmed: bySeverity(list.filter((r) => bucketOf(r) === "confirmed")),
        review: bySeverity(list.filter((r) => bucketOf(r) === "review")),
        folded: [...new Map(rest.map((r) => [r.state, r.review])).entries()]
            .sort((a, b) => a[1].stateRank - b[1].stateRank)
            .map(([state, rv]) => ({ state, label: rv.stateLabel, findings: findingOrder(rest.filter((r) => r.state === state)) })),
    };
}

/** States a finding can be filed as an issue from (routes/integrations.ts FILABLE). */
const FILABLE: readonly FindingState[] = ["confirmed", "classified", "needs_manual_review"];

/** Which of the four actions a finding offers a person who may change it: only moves the lifecycle allows a person. */
export function actionsOf(r: Pick<FindingRecord, "state" | "groupId" | "review">, hasTracker: boolean): { confirm: boolean; notABug: boolean; split: boolean; fileIssue: boolean } {
    return {
        confirm: r.review.personMay.confirm,
        notABug: r.review.personMay.notABug,
        split: r.groupId !== null,
        fileIssue: hasTracker && FILABLE.includes(r.state),
    };
}

/** "Reproduced 2 of 3 times", or why there is no count yet. */
export function reproductionText(r: { same: number; of: number }): string {
    if (r.of === 0) return "Not tried yet";
    if (r.of === 1) return r.same ? "Failed once, not replayed yet" : "Not reproduced: the one attempt did not fail";
    return `Failed the same way ${r.same} of ${r.of} times`;
}

export const SEVERITY_WORD: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

/** One step of the saved test in a line. */
export const stepText = (s: FindingReview["steps"][number]): string => [s.action, s.target, s.url].filter(Boolean).join(" ");
