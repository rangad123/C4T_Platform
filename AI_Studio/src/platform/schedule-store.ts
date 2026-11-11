import { randomUUID } from "node:crypto";
import { OPEN_OWNER_ID } from "./agent-store.js";
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
    /** The person who made the schedule (a user id); null for schedules made before this was kept, or by an API key. */
    createdBy: string | null;
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
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
});

const iso = () => new Date().toISOString();

export class ScheduleStore {
    constructor(
        private readonly db: Db,
        private readonly clock: () => number = Date.now,
    ) {}

    create(input: { projectId: string; name: string; kind: ScheduleKind; cadence: Cadence; enabled?: boolean; retryFailures?: number; createdBy?: string | null }): Schedule {
        const id = randomUUID();
        const enabled = input.enabled ?? true;
        const t = iso();
        this.db.run(
            `INSERT INTO schedules (id, project_id, name, kind, cadence_json, enabled, retry_failures, next_run_at, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            id,
            input.projectId,
            input.name,
            input.kind,
            JSON.stringify(input.cadence),
            enabled ? 1 : 0,
            input.retryFailures ?? 1,
            enabled ? nextRunAfter(input.cadence, this.clock()) : null,
            input.createdBy ?? null,
            t,
            t,
        );
        return this.get(id)!;
    }

    /**
     * Round 45: a schedule with no recorded creator (made before migration 52) gets one from the Activity log, only where that is certain
     * (a person, or the open server as OPEN_OWNER_ID).
     * The latest successful change to it (PATCH .../schedules/<id>) by a person names them (a later change by anyone else, or none: not
     * certain). Without a change: the one successful "POST .../schedules" in its project within 10 seconds of its creation, by a person,
     * when no other schedule of the project was made in that window. Everything else stays without an owner and is refused at its next fire.
     * Idempotent; returns how many were attributed.
     */
    backfillOwners(): number {
        const WINDOW_MS = 10_000;
        let n = 0;
        const orphans = this.db.all<{ id: string; project_id: string; created_at: string }>("SELECT id, project_id, created_at FROM schedules WHERE created_by IS NULL");
        for (const o of orphans) {
            let owner: string | null = null;
            const edit = this.db.get<{ actor_kind: string; actor_id: string | null }>(
                "SELECT actor_kind, actor_id FROM activity WHERE action = 'PATCH /api/projects/:id/schedules/:sid' AND path = ? AND status < 400 ORDER BY id DESC LIMIT 1",
                `/api/projects/${o.project_id}/schedules/${o.id}`,
            );
            const ownerOfRow = (r: { actor_kind: string; actor_id: string | null }): string | null => (r.actor_kind === "user" ? r.actor_id : r.actor_kind === "open" ? OPEN_OWNER_ID : null);
            if (edit) owner = ownerOfRow(edit);
            else {
                const made = Date.parse(o.created_at);
                const near = (at: string) => Math.abs(Date.parse(at) - made) <= WINDOW_MS;
                const creates = this.db
                    .all<{ at: string; actor_kind: string; actor_id: string | null }>("SELECT at, actor_kind, actor_id FROM activity WHERE action = 'POST /api/projects/:id/schedules' AND project_id = ? AND status < 400", o.project_id)
                    .filter((r) => near(r.at));
                const siblings = this.db.all<{ created_at: string }>("SELECT created_at FROM schedules WHERE project_id = ?", o.project_id).filter((r) => near(r.created_at));
                if (Number.isFinite(made) && creates.length === 1 && siblings.length === 1) owner = ownerOfRow(creates[0]!);
            }
            if (owner && (owner === OPEN_OWNER_ID || this.db.get("SELECT 1 AS x FROM users WHERE id = ?", owner))) n += Number(this.db.run("UPDATE schedules SET created_by = ? WHERE id = ? AND created_by IS NULL", owner, o.id).changes);
        }
        return n;
    }

    get(id: string): Schedule | undefined {
        const r = this.db.get("SELECT * FROM schedules WHERE id = ?", id);
        return r ? toSchedule(r) : undefined;
    }

    list(projectId: string): Schedule[] {
        return this.db.all("SELECT * FROM schedules WHERE project_id = ? ORDER BY created_at", projectId).map(toSchedule);
    }

    /**
     * Changing the cadence or re-enabling restarts the clock from now: the next run is never in the past. `createdBy` (the person who last
     * set it up, whose own computer may take its runs) changes only when given.
     */
    update(id: string, patch: { name?: string; kind?: ScheduleKind; cadence?: Cadence; enabled?: boolean; retryFailures?: number; createdBy?: string | null }): Schedule | undefined {
        const cur = this.get(id);
        if (!cur) return undefined;
        const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Schedule;
        const reschedule = patch.cadence !== undefined || (patch.enabled === true && !cur.enabled);
        const nextRunAt = !next.enabled ? null : reschedule ? nextRunAfter(next.cadence, this.clock()) : cur.nextRunAt;
        this.db.run(
            "UPDATE schedules SET name = ?, kind = ?, cadence_json = ?, enabled = ?, retry_failures = ?, next_run_at = ?, created_by = ?, updated_at = ? WHERE id = ?",
            next.name,
            next.kind,
            JSON.stringify(next.cadence),
            next.enabled ? 1 : 0,
            next.retryFailures,
            nextRunAt,
            next.createdBy ?? null,
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
        // An archived project's schedules wait, untouched, until it is restored (project-folders.ts).
        return this.db
            .all("SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? AND project_id NOT IN (SELECT id FROM projects WHERE archived_at IS NOT NULL) ORDER BY next_run_at", nowMs)
            .map(toSchedule);
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
