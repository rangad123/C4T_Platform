/**
 * The queries behind the live streams. Read-only, on the shared database connection (a stream never holds a connection of its
 * own), and shaped for tailing: events after an id, in id order, for one job or for every job of a project.
 */
import type { Db } from "./db.js";
import type { StreamEvent } from "./stream-core.js";

export const TERMINAL_STATUSES = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];

const toEvent = (r: Record<string, any>): StreamEvent => ({ id: Number(r.id), at: String(r.created_at), level: String(r.level), message: String(r.message), stage: String(r.stage), kind: String(r.kind), jobId: String(r.job_id) });

export function jobEventsAfter(db: Db, jobId: string, afterId: number, limit: number): StreamEvent[] {
    return db.all("SELECT id, job_id, stage, kind, level, message, created_at FROM agent_events WHERE job_id = ? AND id > ? ORDER BY id LIMIT ?", jobId, afterId, limit).map(toEvent);
}

/**
 * Ids the project stream reads again below its position each round (TailSource.overlap). Its events come from every job of the
 * project, written by several workers at once; on PostgreSQL an id is handed out before its commit, so 101 can become visible
 * after 102. A single job's events are written one after another, so the job stream needs none. On SQLite ids commit in order
 * and the re-read finds nothing new. Ids are shared by all projects, so a commit later than this many newer ids of any project would still be missed.
 */
export const PROJECT_STREAM_OVERLAP = 100;

export function projectEventsAfter(db: Db, projectId: string, afterId: number, limit: number): StreamEvent[] {
    return db
        .all(
            `SELECT e.id, e.job_id, e.stage, e.kind, e.level, e.message, e.created_at
               FROM agent_events e JOIN generation_jobs j ON j.id = e.job_id
              WHERE j.project_id = ? AND e.id > ? ORDER BY e.id LIMIT ?`,
            projectId,
            afterId,
            limit,
        )
        .map(toEvent);
}

/**
 * Where a new connection (no Last-Event-ID) starts: the events with an id above `after` are the most recent `keep` of the job,
 * `earlier` is how many older ones exist and are not replayed.
 */
export function recentWindow(db: Db, jobId: string, keep: number): { after: number; earlier: number } {
    const total = Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_events WHERE job_id = ?", jobId)?.n ?? 0);
    if (total <= keep) return { after: 0, earlier: 0 };
    const edge = db.get<{ id: number }>("SELECT id FROM agent_events WHERE job_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?", jobId, keep);
    return { after: Number(edge?.id ?? 0), earlier: total - keep };
}

/** The highest event id of a project (a project stream without Last-Event-ID shows what happens from now on). */
export function projectHead(db: Db, projectId: string): number {
    return Number(db.get<{ m: number | null }>("SELECT MAX(e.id) AS m FROM agent_events e JOIN generation_jobs j ON j.id = e.job_id WHERE j.project_id = ?", projectId)?.m ?? 0);
}

/** The most recent jobs of a project with just enough to notice a change cheaply. */
export function recentJobStates(db: Db, projectId: string, limit: number): Array<{ id: string; status: string; updatedAt: string }> {
    return db.all("SELECT id, status, updated_at FROM generation_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?", projectId, limit).map((r) => ({ id: String(r.id), status: String(r.status), updatedAt: String(r.updated_at) }));
}
