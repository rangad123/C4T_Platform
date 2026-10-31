/** What `GET /api/tests/:id/sentry` and `GET /api/projects/:id/sentry` answer. */
export interface RelatedIssue {
    id: string;
    title: string;
    level: "fatal" | "error" | "warning" | "info" | "debug" | "unknown";
    count: number;
    firstSeen: string | null;
    lastSeen: string | null;
    url: string;
    /** Why it might be related, in plain words. */
    reason: string;
}

export type RelatedAnswer =
    | { connected: false }
    | { connected: true; state: "ok"; issues: RelatedIssue[]; note: string; checkedAt: string; cached: boolean }
    | { connected: true; state: "unavailable"; code: string; message: string };

export interface SentryConnectionAnswer {
    connected: boolean;
    connection?: { id: string; name: string; baseUrl: string; organization: string; project: string };
}

export const LEVEL_WORD: Record<RelatedIssue["level"], string> = { fatal: "Fatal", error: "Error", warning: "Warning", info: "Info", debug: "Debug", unknown: "Issue" };

export const eventsText = (n: number) => `${n.toLocaleString()} ${n === 1 ? "event" : "events"}`;
