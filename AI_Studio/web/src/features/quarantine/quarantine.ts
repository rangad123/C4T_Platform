/** Flaky-test quarantine: the shapes the API returns and the few words the screens share. */
export { apiMessage, saveName, savedName } from "../manual/manual";

export const MAX_REASON = 300;
export const MAX_DAYS = 60;
export const DEFAULT_DAYS = 14;

export interface QuarantineBrief {
    reason: string;
    since: string;
    expiresAt: string;
}

export interface ReleaseHint {
    suggest: boolean;
    passedInARow: number;
    text: string | null;
}

export interface EntryView {
    id: string;
    projectId: string;
    testId: string;
    testKey: string;
    title: string;
    reason: string;
    source: "manual" | "suggested";
    by: string;
    since: string;
    expiresAt: string;
    status: "active" | "released" | "expired";
    reviewedAt: string | null;
    reviewedBy: string | null;
    endedAt: string | null;
    endedBy: string | null;
    daysLeft: number;
    /** False when the entry exists but the test counts again. */
    gating: boolean;
    note: string | null;
    release: ReleaseHint;
}

export interface Suggestion {
    testId: string;
    testKey: string;
    title: string;
    evidence: string;
    suggestedReason: string;
    lastRunAt: string;
}

export interface ProjectQuarantine {
    active: EntryView[];
    ended: EntryView[];
    suggestions: Suggestion[];
    summary: string | null;
    limits: { defaultDays: number; maxDays: number; maxReason: number };
}

export interface HistoryRow {
    id: number;
    at: string;
    kind: "quarantined" | "released" | "expired" | "reviewed";
    by: string;
    reason: string;
}

export interface TestQuarantine {
    entry: EntryView | null;
    eligible: boolean;
    code: string;
    why: string;
    evidence: string | null;
    suggestedReason: string | null;
    lastEnded: EntryView | null;
    history: HistoryRow[];
}

/** "2 tests are in quarantine and not counted." */
export const countedSentence = (n: number): string => `${n} ${n === 1 ? "test is" : "tests are"} in quarantine and not counted.`;

export const HISTORY_WORDS: Record<HistoryRow["kind"], string> = {
    quarantined: "put it in quarantine",
    released: "released it from quarantine",
    expired: "ended automatically",
    reviewed: "reviewed it",
};
