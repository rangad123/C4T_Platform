/**
 * The audit trail of sessions driven step by step: one row per session, never one per action or keystroke. It holds who-what-where in counts and addresses,
 * never a typed value, a page text or a picture. The row is made by the first call that drives the session and updated in place after that.
 */
import type { Db } from "./db.js";
import { actorLabel } from "./auth/actor.js";

export const LIVE_SESSION_MIGRATION = `
CREATE TABLE live_session_audit (
    recording_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    start_url TEXT NOT NULL,              -- origin and path only: no query, no credentials
    runner TEXT NOT NULL,                 -- 'platform' or 'agent:<name>'
    opened_at TEXT NOT NULL,
    last_at TEXT NOT NULL,
    actions INTEGER NOT NULL DEFAULT 0,   -- actions performed
    refused INTEGER NOT NULL DEFAULT 0,   -- actions the platform or the recorder refused
    snapshots INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_live_session_audit_project ON live_session_audit(project_id, opened_at);
`;

export interface LiveAuditRow {
    recordingId: string;
    projectId: string;
    startUrl: string;
    runner: string;
    openedAt: string;
    lastAt: string;
    actions: number;
    refused: number;
    snapshots: number;
}

/** An address without its query, fragment or credentials. */
export function auditUrl(raw: string): string {
    try {
        const u = new URL(raw);
        return `${u.origin}${u.pathname}`.slice(0, 300);
    } catch {
        return "";
    }
}

/** Sessions kept per project (the newest by opening time). */
export const KEEP_LIVE_AUDIT_ROWS = 1000;

export class LiveAuditStore {
    constructor(
        private readonly db: Db,
        /** Overridable so a test does not have to open a thousand sessions. */
        private readonly keepRows: number = KEEP_LIVE_AUDIT_ROWS,
    ) {}

    /** Counts one call of a session; the row is made on the first. */
    count(s: { recordingId: string; projectId: string; startUrl: string; runner: string }, what: "actions" | "refused" | "snapshots"): void {
        const now = new Date().toISOString();
        const made = this.db.run(
            "INSERT INTO live_session_audit (recording_id, project_id, start_url, runner, opened_at, last_at, actor) VALUES (?,?,?,?,?,?,?) ON CONFLICT (recording_id) DO NOTHING",
            s.recordingId,
            s.projectId,
            auditUrl(s.startUrl),
            s.runner.slice(0, 120),
            now,
            now,
            // Who drove the session (a person, the access key used by the MCP server...), from the request (auth/actor.ts).
            actorLabel(),
        );
        // A new session row: forget the oldest ones beyond the cap, so the trail cannot grow without end.
        if (Number(made.changes) > 0) {
            this.db.run(
                "DELETE FROM live_session_audit WHERE project_id = ? AND recording_id NOT IN (SELECT recording_id FROM live_session_audit WHERE project_id = ? ORDER BY opened_at DESC, recording_id DESC LIMIT ?)",
                s.projectId,
                s.projectId,
                this.keepRows,
            );
        }
        // The column name comes from the closed set above, never from a request.
        this.db.run(`UPDATE live_session_audit SET ${what} = ${what} + 1, last_at = ? WHERE recording_id = ?`, now, s.recordingId);
    }

    list(projectId: string, limit = 50): LiveAuditRow[] {
        return this.db
            .all<Record<string, any>>("SELECT * FROM live_session_audit WHERE project_id = ? ORDER BY opened_at DESC LIMIT ?", projectId, Math.max(1, Math.min(200, limit)))
            .map((r) => ({ recordingId: r.recording_id, projectId: r.project_id, startUrl: r.start_url, runner: r.runner, openedAt: r.opened_at, lastAt: r.last_at, actions: r.actions, refused: r.refused, snapshots: r.snapshots }));
    }
}
