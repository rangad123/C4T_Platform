import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db, Row } from "./db.js";

// ── cadence ─────────────────────────────────────────────────────────────────

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time such as 02:00");

/** How often a schedule runs, in plain terms. Daily/weekly times are server local time. */
// Interval runs are limited to every 5 minutes: plenty for a test run, and a typo cannot hammer the application.
export const CadenceSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("interval"), every: z.number().int().min(1).max(10_080), unit: z.enum(["minutes", "hours"]) }),
    z.object({ type: z.literal("daily"), time: Time }),
    z.object({ type: z.literal("weekly"), weekday: z.number().int().min(0).max(6), time: Time }),
]).refine((c) => c.type !== "interval" || c.unit === "hours" || c.every >= 5, { message: "Run at most every 5 minutes", path: ["every"] });
export type Cadence = z.infer<typeof CadenceSchema>;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The next moment strictly after `fromMs` at which a schedule with this cadence is due. */
export function nextRunAfter(c: Cadence, fromMs: number): number {
    if (c.type === "interval") return fromMs + c.every * (c.unit === "hours" ? 3_600_000 : 60_000);
    const [h, m] = c.time.split(":").map(Number) as [number, number];
    const from = new Date(fromMs);
    // Built from local calendar parts (not by adding 24 h) so daylight-saving changes keep the wall-clock time.
    for (let offset = 0; offset <= 8; offset++) {
        const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset, h, m, 0, 0);
        if (d.getTime() > fromMs && (c.type === "daily" || d.getDay() === c.weekday)) return d.getTime();
    }
    throw new Error("unreachable: a weekly cadence always has a run within 8 days");
}

export function describeCadence(c: Cadence): string {
    if (c.type === "interval") return `Every ${c.every === 1 ? (c.unit === "hours" ? "hour" : "minute") : `${c.every} ${c.unit}`}`;
    if (c.type === "daily") return `Every day at ${c.time}`;
    return `Every ${WEEKDAYS[c.weekday]} at ${c.time}`;
}

// ── schedules ───────────────────────────────────────────────────────────────

export const SCHEDULE_KINDS = ["validate", "generate"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];
export type LastOutcome = "started" | "skipped" | "error";

export interface Schedule {
    id: string;
    projectId: string;
    name: string;
    kind: ScheduleKind;
    cadence: Cadence;
    enabled: boolean;
    retryFailures: number;
    /** Epoch ms; null while disabled. */
    nextRunAt: number | null;
    lastRunAt: string | null;
    lastJobId: string | null;
    lastOutcome: LastOutcome | null;
    lastOutcomeAt: string | null;
    lastNote: string | null;
    createdAt: string;
    updatedAt: string;
}

const toSchedule = (r: Row): Schedule => ({
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    kind: r.kind,
    cadence: JSON.parse(r.cadence_json),
    enabled: Boolean(r.enabled),
    retryFailures: r.retry_failures,
    nextRunAt: r.next_run_at ?? null,
    lastRunAt: r.last_run_at,
    lastJobId: r.last_job_id,
    lastOutcome: r.last_outcome,
    lastOutcomeAt: r.last_outcome_at,
    lastNote: r.last_note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
});

const iso = () => new Date().toISOString();

export class ScheduleStore {
    constructor(
        private readonly db: Db,
        private readonly clock: () => number = Date.now,
    ) {}

    create(input: { projectId: string; name: string; kind: ScheduleKind; cadence: Cadence; enabled?: boolean; retryFailures?: number }): Schedule {
        const id = randomUUID();
        const enabled = input.enabled ?? true;
        const t = iso();
        this.db.run(
            `INSERT INTO schedules (id, project_id, name, kind, cadence_json, enabled, retry_failures, next_run_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
            id,
            input.projectId,
            input.name,
            input.kind,
            JSON.stringify(input.cadence),
            enabled ? 1 : 0,
            input.retryFailures ?? 1,
            enabled ? nextRunAfter(input.cadence, this.clock()) : null,
            t,
            t,
        );
        return this.get(id)!;
    }

    get(id: string): Schedule | undefined {
        const r = this.db.get("SELECT * FROM schedules WHERE id = ?", id);
        return r ? toSchedule(r) : undefined;
    }

    list(projectId: string): Schedule[] {
        return this.db.all("SELECT * FROM schedules WHERE project_id = ? ORDER BY created_at", projectId).map(toSchedule);
    }

    /** Changing the cadence or re-enabling restarts the clock from now: the next run is never in the past. */
    update(id: string, patch: { name?: string; kind?: ScheduleKind; cadence?: Cadence; enabled?: boolean; retryFailures?: number }): Schedule | undefined {
        const cur = this.get(id);
        if (!cur) return undefined;
        const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Schedule;
        const reschedule = patch.cadence !== undefined || (patch.enabled === true && !cur.enabled);
        const nextRunAt = !next.enabled ? null : reschedule ? nextRunAfter(next.cadence, this.clock()) : cur.nextRunAt;
        this.db.run(
            "UPDATE schedules SET name = ?, kind = ?, cadence_json = ?, enabled = ?, retry_failures = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
            next.name,
            next.kind,
            JSON.stringify(next.cadence),
            next.enabled ? 1 : 0,
            next.retryFailures,
            nextRunAt,
            iso(),
            id,
        );
        return this.get(id);
    }

    delete(id: string): boolean {
        return Number(this.db.run("DELETE FROM schedules WHERE id = ?", id).changes) > 0;
    }

    /** Enabled schedules whose time has come. */
    due(nowMs: number): Schedule[] {
        return this.db.all("SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at", nowMs).map(toSchedule);
    }

    /**
     * Atomically take a due schedule: moves `next_run_at` forward only if it still holds the value the caller
     * saw. Of two scheduler processes looking at the same row, exactly one gets `true`.
     */
    claim(id: string, expectedNext: number, newNext: number): boolean {
        const r = this.db.run("UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ? AND enabled = 1 AND next_run_at = ?", newNext, iso(), id, expectedNext);
        return Number(r.changes) > 0;
    }

    /** Undo a claim whose run could not start because a job appeared in the meantime. */
    unclaim(id: string, claimedNext: number, previousNext: number): void {
        this.db.run("UPDATE schedules SET next_run_at = ? WHERE id = ? AND next_run_at = ?", previousNext, id, claimedNext);
    }

    recordRun(id: string, r: { outcome: LastOutcome; jobId?: string; note?: string | null; at?: string }): void {
        const started = r.outcome === "started";
        const at = r.at ?? iso();
        this.db.run(
            "UPDATE schedules SET last_outcome = ?, last_outcome_at = ?, last_note = ?, last_run_at = CASE WHEN ? THEN ? ELSE last_run_at END, last_job_id = CASE WHEN ? THEN ? ELSE last_job_id END WHERE id = ?",
            r.outcome,
            at,
            r.note ?? null,
            started ? 1 : 0,
            at,
            started ? 1 : 0,
            r.jobId ?? null,
            id,
        );
    }
}
