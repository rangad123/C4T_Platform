/**
 * Candidate findings (testing-engine Phase 3) as the run page shows them: the API's answer and the words for it. Browser-free, so tests
 * read the same rules the page uses.
 *
 *   GET /api/projects/:id/candidate-findings?job=  → FindingsAnswer: the findings this run found first or last, newest seen first.
 *
 * A candidate finding is found by the AI and needs a person to check it; the page never calls one settled. Its confidence is stated
 * (src/engine/explore/finding.ts confidenceOf), so its meaning here follows the same rule.
 */

export type CaptureState = "captured" | "observed_only";
export type Independence = "independent" | "state_dependent" | "not_run";
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
}

export interface FindingsAnswer {
    findings: FindingRecord[];
}

export const CONFIDENCE_WORD: Record<Confidence, string> = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" };
export const CAPTURE_WORD: Record<CaptureState, string> = { captured: "Kept as a failing check", observed_only: "Seen only, not kept as a check" };
export const NOT_SETTLED = "Needs a person to check";

const SOURCED = "The expected result has a stated source";

/** What a confidence means (Decision 9, confidenceOf): high and medium need a stated source and a kept failing check; the replay decides. */
export function confidenceMeaning(f: Pick<CandidateFinding, "confidence" | "independence">): string {
    if (f.confidence === "high") return `${SOURCED}, the saved test fails at that check, and it failed the same way when replayed from a fresh start.`;
    if (f.confidence === "medium")
        return f.independence === "state_dependent"
            ? `${SOURCED} and the saved test fails at that check, but replayed from a fresh start it did not fail the same way, so it may depend on what ran before.`
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
