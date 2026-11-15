/**
 * Scheduled passive assessments: one schedule per security application (daily or weekly at a time in UTC, or off). A due schedule starts the
 * same passive assessment a person starts from the application page, in its maker's name, and only when:
 *   - the application has a current authorization (checked when it is due: an expired or revoked one stops the schedule, with a sentence
 *     and an audit line, and a person must switch it on again after recording a new one);
 *   - no other assessment of the application is under way (then this slot is skipped, and the next one is tried);
 *   - its maker may still use the project (a person who was removed, switched off or lost the project stops the schedule, with a sentence).
 * The kind is always passive: a schedule never starts anything else. A retest is never scheduled.
 *
 * The due schedules are looked at by the platform scheduler's tick (platform/schedule-services.ts, `onTick`), so no timer of its own runs.
 * A due schedule is taken with a compare-and-swap on `next_run_at`, so two processes never start it twice. Missed slots after downtime are
 * not replayed: the next run is worked out from now.
 */
import { z } from "zod";
import type { Platform } from "../platform/bootstrap.js";
import type { Db } from "../platform/db.js";
import { HttpError } from "../platform/http-error.js";
import { getAgentServices } from "../platform/agent-services.js";
import { OPEN_OWNER_ID } from "../platform/agent-store.js";
import { assertC4tOwnerMayRun } from "../platform/c4t-service.js";
import { runAs } from "../platform/auth/actor.js";
import { runnersOnly } from "../platform/runner-only.js";
import { assertAssessmentRunner } from "./assessment/on-runner.js";
import { recordSecurityEvent } from "./audit.js";
import { securitySettings } from "./settings.js";
import { securityStoreFor } from "./store.js";

export { ensureScheduleTables, SECURITY_SCHEDULE_MIGRATION } from "./schedule-schema.js";
import { ensureScheduleTables } from "./schedule-schema.js";

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time such as 02:00 (UTC).");
export const SecurityCadenceSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("daily"), time: Time }).strict(),
    z.object({ type: z.literal("weekly"), weekday: z.number().int().min(0).max(6), time: Time }).strict(),
]);
export type SecurityCadence = z.infer<typeof SecurityCadenceSchema>;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const describeSecurityCadence = (c: SecurityCadence): string => (c.type === "daily" ? `Every day at ${c.time} UTC` : `Every ${WEEKDAYS[c.weekday]} at ${c.time} UTC`);

/** The next moment strictly after `fromMs` (UTC calendar) at which this cadence is due. */
export function nextSecurityRun(c: SecurityCadence, fromMs: number): number {
    const [h, m] = c.time.split(":").map(Number) as [number, number];
    const from = new Date(fromMs);
    for (let offset = 0; offset <= 8; offset++) {
        const t = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + offset, h, m, 0, 0);
        if (t > fromMs && (c.type === "daily" || new Date(t).getUTCDay() === c.weekday)) return t;
    }
    throw new Error("unreachable: a weekly cadence always has a run within 8 days");
}

export type ScheduleOutcome = "started" | "skipped" | "stopped" | "error";

export interface SecuritySchedule {
    applicationId: string;
    projectId: string;
    cadence: SecurityCadence;
    enabled: boolean;
    nextRunAt: string | null;
    makerId: string;
    makerName: string;
    lastRunAt: string | null;
    lastOutcome: ScheduleOutcome | null;
    lastNote: string | null;
    lastAssessmentId: string | null;
}

interface Row {
    application_id: string;
    project_id: string;
    cadence_json: string;
    enabled: number;
    next_run_at: number | null;
    maker_id: string;
    maker_name: string;
    last_run_at: string | null;
    last_outcome: string | null;
    last_note: string | null;
    last_assessment_id: string | null;
}

const toSchedule = (r: Row): SecuritySchedule => ({
    applicationId: r.application_id,
    projectId: r.project_id,
    cadence: JSON.parse(r.cadence_json) as SecurityCadence,
    enabled: Number(r.enabled) === 1,
    nextRunAt: r.next_run_at === null || r.next_run_at === undefined ? null : new Date(Number(r.next_run_at)).toISOString(),
    makerId: r.maker_id,
    makerName: r.maker_name,
    lastRunAt: r.last_run_at,
    lastOutcome: (r.last_outcome as ScheduleOutcome | null) ?? null,
    lastNote: r.last_note,
    lastAssessmentId: r.last_assessment_id,
});

export class SecurityScheduleStore {
    constructor(
        private readonly db: Db,
        private readonly clock: () => number = Date.now,
    ) {
        ensureScheduleTables(db);
    }

    get(applicationId: string): SecuritySchedule | undefined {
        const r = this.db.get<Row>("SELECT * FROM security_schedules WHERE application_id = ?", applicationId);
        return r ? toSchedule(r) : undefined;
    }

    /** Set (or switch off) an application's schedule; the person setting it becomes its maker. Switching on starts the clock from now. */
    set(app: { id: string; projectId: string }, cadence: SecurityCadence | null, maker: { id: string; name: string }, previous?: SecuritySchedule): SecuritySchedule {
        const now = new Date(this.clock()).toISOString();
        const c = cadence ?? previous?.cadence ?? { type: "daily", time: "02:00" };
        const next = cadence ? nextSecurityRun(cadence, this.clock()) : null;
        this.db.run(
            `INSERT INTO security_schedules (application_id, project_id, cadence_json, enabled, next_run_at, maker_id, maker_name, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?)
             ON CONFLICT(application_id) DO UPDATE SET cadence_json = excluded.cadence_json, enabled = excluded.enabled, next_run_at = excluded.next_run_at,
               maker_id = excluded.maker_id, maker_name = excluded.maker_name, updated_at = excluded.updated_at`,
            app.id,
            app.projectId,
            JSON.stringify(c),
            cadence ? 1 : 0,
            next,
            maker.id,
            maker.name.slice(0, 200),
            now,
            now,
        );
        return this.get(app.id)!;
    }

    /** Schedules due at `nowMs`, oldest first. */
    due(nowMs: number): SecuritySchedule[] {
        return this.db.all<Row>("SELECT * FROM security_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at", nowMs).map(toSchedule);
    }

    /** Take a due schedule: only one process wins (compare-and-swap on its due time). */
    claim(s: SecuritySchedule, nextMs: number): boolean {
        const expected = s.nextRunAt ? Date.parse(s.nextRunAt) : null;
        return this.db.run("UPDATE security_schedules SET next_run_at = ? WHERE application_id = ? AND enabled = 1 AND next_run_at = ?", nextMs, s.applicationId, expected).changes === 1;
    }

    record(applicationId: string, outcome: ScheduleOutcome, note: string | null, at: string, assessmentId?: string): void {
        this.db.run(
            "UPDATE security_schedules SET last_run_at = ?, last_outcome = ?, last_note = ?, last_assessment_id = COALESCE(?, last_assessment_id) WHERE application_id = ?",
            at,
            outcome,
            note?.slice(0, 400) ?? null,
            assessmentId ?? null,
            applicationId,
        );
    }

    /** Switch it off (an expired authorization, a maker who lost access): a person switches it on again. */
    stop(applicationId: string, note: string, at: string): void {
        this.db.run("UPDATE security_schedules SET enabled = 0, next_run_at = NULL WHERE application_id = ?", applicationId);
        this.record(applicationId, "stopped", note, at);
    }
}

export const MAKER_LOST_ACCESS = "The schedule was switched off: the person who set it can no longer use this project. Someone who can should set it again.";
export const KEY_CANNOT_SCHEDULE = "Sign in with your own account to schedule assessments: a scheduled assessment runs in its maker's name.";

/** May this maker still start assessments of the project? Throws an HttpError with the sentence when not. */
async function assertMakerMayRun(p: Platform, makerId: string, projectId: string): Promise<void> {
    if (!getAgentServices(p).store.ownerMayRun(makerId, projectId)) throw new HttpError(403, MAKER_LOST_ACCESS);
    await assertC4tOwnerMayRun(p, makerId);
}

export interface FireResult {
    applicationId: string;
    outcome: ScheduleOutcome | "lost";
    assessmentId?: string;
    note?: string;
}

/**
 * Start the passive assessments whose schedule is due. Called from the platform scheduler's tick; never throws (each schedule's problem is
 * recorded on it). `poke` wakes the assessment loop.
 */
export async function fireDueSecuritySchedules(p: Platform, nowMs: number, poke?: () => void): Promise<FireResult[]> {
    if (!securitySettings(p.config).enabled) return [];
    const store = securityStoreFor(p.db);
    const schedules = new SecurityScheduleStore(p.db, () => nowMs);
    const out: FireResult[] = [];
    for (const s of schedules.due(nowMs)) {
        const at = new Date(nowMs).toISOString();
        if (!schedules.claim(s, nextSecurityRun(s.cadence, nowMs))) {
            out.push({ applicationId: s.applicationId, outcome: "lost" });
            continue;
        }
        const app = store.getApplication(s.applicationId);
        if (!app) continue;
        const audit = (action: "assessment.started" | "schedule.stopped", summary: string, objectId?: string) =>
            runAs({ kind: "schedule", name: "Schedule", role: "editor" }, () =>
                recordSecurityEvent(p.db, { projectId: app.projectId, applicationId: app.id, action, objectType: action === "assessment.started" ? "assessment" : "application", objectId: objectId ?? app.id, summary }),
            );
        try {
            const auth = store.authorizationState(app);
            if (auth.state !== "current" || !auth.authorizationId) {
                const note = `The schedule was switched off: ${auth.message} Record a new authorization, then switch the schedule on again.`;
                schedules.stop(app.id, note, at);
                audit("schedule.stopped", `The scheduled assessment of “${app.name}” was switched off: there is no current authorization.`);
                out.push({ applicationId: app.id, outcome: "stopped", note });
                continue;
            }
            try {
                await assertMakerMayRun(p, s.makerId, app.projectId);
            } catch (e) {
                if (e instanceof HttpError && e.status === 403) {
                    schedules.stop(app.id, e.message, at);
                    audit("schedule.stopped", `The scheduled assessment of “${app.name}” was switched off: ${s.makerName} can no longer use this project.`);
                    out.push({ applicationId: app.id, outcome: "stopped", note: e.message });
                    continue;
                }
                throw e;
            }
            const active = store.activeAssessment(app.id);
            if (active) {
                const note = `Skipped: an assessment of “${app.name}” was already under way. The next scheduled time is tried as usual.`;
                schedules.record(app.id, "skipped", note, at);
                out.push({ applicationId: app.id, outcome: "skipped", note });
                continue;
            }
            if (runnersOnly(p.config)) assertAssessmentRunner(p, { kind: s.makerId === OPEN_OWNER_ID ? "open" : "user", ownerId: s.makerId }, app.projectId, app.targetUrl);
            const created = store.createAssessment({ applicationId: app.id, authorizationId: auth.authorizationId, startedBy: s.makerName, retestOf: null, progressText: "Waiting to start (scheduled)." });
            if (runnersOnly(p.config)) store.setWorkData(created.id, { attempts: 0, ownerId: s.makerId });
            schedules.record(app.id, "started", null, at, created.id);
            audit("assessment.started", `Started the scheduled passive assessment of “${app.name}” (${app.targetUrl}) for ${s.makerName}, at most ${app.maxRequestsPerSecond} requests a second.`, created.id);
            out.push({ applicationId: app.id, outcome: "started", assessmentId: created.id });
        } catch (e) {
            const note = (e instanceof Error ? e.message : String(e)).slice(0, 300);
            schedules.record(app.id, "error", note, at);
            out.push({ applicationId: app.id, outcome: "error", note });
        }
    }
    if (out.some((r) => r.outcome === "started")) poke?.();
    return out;
}
