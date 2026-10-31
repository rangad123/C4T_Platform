import type { Tone } from "../../lib/labels";
import { plural } from "../../lib/format";

export type CleanupStatus = "removed" | "already-gone" | "failed" | "no-delete-operation" | "skipped";

export interface CleanupItem {
    id: number;
    testId: string;
    testCaseId: string | null;
    path: string;
    recordId: string;
    status: CleanupStatus;
    reason: string | null;
    canRetry: boolean;
    createdAt: string;
}

export interface CleanupCounts {
    created: number;
    removed: number;
    leftBehind: number;
    failed: number;
    noWay: number;
    skipped: number;
}

export interface CleanupRun {
    jobId: string;
    at: string;
    environment: string | null;
    counts: CleanupCounts;
    summary: string;
    items: CleanupItem[];
}

export interface ProjectCleanup {
    enabled: boolean;
    dataChangingTests: number;
    latest: CleanupRun | null;
    runs: Array<Omit<CleanupRun, "items">>;
}

export interface TestCleanup {
    enabled: boolean;
    latest: CleanupRun | null;
}

export interface RetryResult {
    retried: number;
    removed: number;
    failedAgain: number;
    notReached: number;
    latest: CleanupRun | null;
}

/** Plain words for each outcome. "Removed" covers both a record we deleted and one the test deleted itself. */
export const CLEANUP_STATUS: Record<CleanupStatus, { label: string; tone: Tone }> = {
    removed: { label: "Removed", tone: "success" },
    "already-gone": { label: "Already gone", tone: "success" },
    failed: { label: "Could not remove", tone: "danger" },
    "no-delete-operation": { label: "No way to remove it", tone: "warning" },
    skipped: { label: "Left in place", tone: "warning" },
};

/** "Last run created 5 records; 4 removed, 1 left behind." */
export function runSentence(c: CleanupCounts): string {
    if (c.created === 0) return "Last run created no records.";
    const left = c.leftBehind > 0 ? `, ${c.leftBehind} left behind` : "";
    if (c.leftBehind === 0 && c.created > 1) return `Last run created ${plural(c.created, "record")}; all removed.`;
    return `Last run created ${plural(c.created, "record")}; ${c.removed} removed${left}.`;
}

/** Records that are still in the application. */
export const leftBehind = (items: CleanupItem[]): CleanupItem[] => items.filter((i) => i.status !== "removed" && i.status !== "already-gone");
