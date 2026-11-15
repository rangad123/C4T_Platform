/** The test-selection preview's answers (src/platform/routes/selection.ts). The preview recommends; it never runs or skips a test. */

export type CoverageSource = "declared" | "observed";
export type Completeness = "declared-complete" | "observed-complete" | "partial" | "unknown";

export interface SelectionReason {
    change: string;
    matched: string;
    source: CoverageSource;
    seenIn: string[];
    sentence: string;
}

export interface SelectionTest {
    testId: string;
    testKey: string;
    title: string;
    kind: string;
    completeness: Completeness;
    reasons: SelectionReason[];
    why?: string;
    /** What a deploy trigger does differently with this test (its maker's runner can or cannot run it). */
    notes?: string[];
}

export interface SelectionPreview {
    recommendationOnly: true;
    note: string;
    ignored: Array<{ given: string; why: string }>;
    /** Entries past the preview's limit: not compared with any test. */
    notProcessed: string[];
    matched: SelectionTest[];
    unknown: SelectionTest[];
    notMatched: SelectionTest[];
    /** Tests that cannot run (unreadable, or left out on this person's runner), with why. */
    cannotRun: SelectionTest[];
    uncoveredChanges: string[];
    /** Something could not be judged: only a full run is safe. */
    fullRunRequired: boolean;
    fullRunReasons: string[];
    /** Each active deploy trigger compared with this person's runner. */
    triggers: Array<{ trigger: string; parity: "same" | "different" | "unresolved"; why?: string }>;
    counts: { tests: number; matched: number; unknown: number; proposed: number; notMatched: number; cannotRun: number };
    scope: "runnable" | "all";
    /** How recent a test's latest passing run must be for its recorded coverage to count, in days. */
    freshDays: number;
}

export interface DetectedChanges {
    pages: string[];
    endpoints: string[];
    sources: string[];
    message?: string;
}

/** One entry per line; blank lines and surrounding spaces dropped. */
export const linesOf = (text: string): string[] =>
    text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

export const SOURCE_WORDS: Record<CoverageSource, { label: string; tip: string }> = {
    declared: { label: "Declared", tip: "The test's own steps open this page or call this endpoint." },
    observed: { label: "Observed", tip: "A recorded run of the test's current version opened this page or called this endpoint." },
};
