/** Types of the schedules API and the plain-language wording used by the Schedule tab. */
import type { Severity } from "../../api";

export type Cadence =
    | { type: "interval"; every: number; unit: "minutes" | "hours" }
    | { type: "daily"; time: string }
    | { type: "weekly"; weekday: number; time: string };

export type ScheduleKind = "validate" | "generate";

export interface Schedule {
    id: string;
    name: string;
    kind: ScheduleKind;
    kindLabel: string;
    cadence: Cadence;
    cadenceText: string;
    enabled: boolean;
    retryFailures: number;
    nextRunAt: string | null;
    lastRunAt: string | null;
    lastJobId: string | null;
    lastOutcome: "started" | "skipped" | "error" | null;
    lastOutcomeAt: string | null;
    lastNote: string | null;
    /** The runbook this schedule starts instead of a plain run (see features/runbooks). */
    runbookId?: string | null;
    runbookName?: string | null;
}

export interface ScheduleList {
    serverTime: string;
    timezone: { name: string; utcOffsetMinutes: number };
    schedulerEnabled: boolean;
    schedules: Schedule[];
}

export interface TrendRun {
    jobId: string;
    finishedAt: string;
    mode: string;
    trigger: "manual" | "schedule" | "deploy";
    jobStatus: string;
    total: number;
    validated: number;
    needsReview: number;
    failed: number;
    flaky: number;
    passRate: number | null;
    durationMs: number | null;
}

export interface Trends {
    days: number;
    runs: TrendRun[];
    summary: { runs: number; firstPassRate: number | null; latestPassRate: number | null; averagePassRate: number | null; passRateDelta: number | null };
}

export interface FlakyTest {
    id: string;
    testKey: string;
    title: string;
    executions: number;
    passes: number;
    fails: number;
    flips: number;
    flipRate: number;
    flakyPasses: number;
    lastStatus: string;
    lastRunAt: string;
}

export type AlertEvent = "run_failed" | "regression" | "recovered" | "flaky" | "api_breaking_change";
export type ChannelKind = "webhook" | "slack" | "teams" | "email";

export interface AlertChannel {
    id: string;
    kind: ChannelKind;
    name: string;
    /** The address's host; for email, the recipients. */
    host: string;
    /** Email channels: who gets the mail, and the mail server in use (never the login). */
    recipients?: string[];
    smtp?: { source: "server" | "channel"; host: string; port: number; secure: boolean; from: string; hasLogin: boolean } | null;
    events: AlertEvent[];
    minSeverity: Severity | null;
    enabled: boolean;
}

/** What the "add a channel" form needs: whether the server has mail settings of its own. */
export interface AlertOptions {
    email: { serverMail: { host: string; port: number; secure: boolean; from: string; hasLogin: boolean } | null; maxRecipients: number };
}

export interface AlertLogEntry {
    id: number;
    channelName: string;
    channelKind: ChannelKind;
    event: string;
    status: "sent" | "failed";
    httpStatus: number | null;
    attempts: number;
    error: string | null;
    summary: string | null;
    createdAt: string;
}

export const EVENT_LABEL: Record<AlertEvent, { label: string; help: string }> = {
    run_failed: { label: "A run has failures", help: "Some tests failed or found a problem." },
    regression: { label: "A test starts failing", help: "A test that passed before now fails." },
    recovered: { label: "A failing test is fixed", help: "A test that failed before now passes." },
    flaky: { label: "A test is unreliable", help: "A test failed, then passed when run again." },
    api_breaking_change: { label: "The API changed in a breaking way", help: "A field, type or endpoint that clients rely on changed since the previous run." },
};
export const EVENT_ORDER: AlertEvent[] = ["regression", "run_failed", "flaky", "recovered", "api_breaking_change"];

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Sunday 02:00" style description of when something happens, in server time. */
export function whenText(iso: string | null, now = Date.now()): string {
    if (!iso) return "—";
    const d = new Date(iso);
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate()).getTime()) / 86_400_000);
    if (days === 0) return `Today at ${time}`;
    if (days === 1) return `Tomorrow at ${time}`;
    if (days > 1 && days < 7) return `${d.toLocaleDateString([], { weekday: "long" })} at ${time}`;
    return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} at ${time}`;
}

/** "UTC+05:30" for a minutes offset. */
export function utcOffsetText(minutes: number): string {
    const sign = minutes < 0 ? "-" : "+";
    const a = Math.abs(minutes);
    return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}
