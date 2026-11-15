/** The table of scheduled passive assessments (schedules.ts). No imports, so store.ts can create it without an import cycle. */
import type { Db } from "../platform/db.js";

export const SECURITY_SCHEDULE_MIGRATION = `
CREATE TABLE IF NOT EXISTS security_schedules (
    application_id TEXT PRIMARY KEY REFERENCES security_applications(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    cadence_json TEXT NOT NULL,               -- {type:'daily',time:'HH:MM'} | {type:'weekly',weekday:0-6,time:'HH:MM'} (UTC)
    enabled INTEGER NOT NULL,
    next_run_at BIGINT,                       -- epoch ms; NULL while off
    maker_id TEXT NOT NULL,                   -- the person whose name a scheduled assessment runs in (user id, or "open")
    maker_name TEXT NOT NULL,
    last_run_at TEXT,
    last_outcome TEXT,                        -- started | skipped | stopped | error
    last_note TEXT,
    last_assessment_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sec_schedules_due ON security_schedules(enabled, next_run_at);
`;

const ensured = new WeakSet<Db>();
/** Safe to call repeatedly; also called from ensureSecurityTables (store.ts). */
export function ensureScheduleTables(db: Db): void {
    if (ensured.has(db)) return;
    db.raw.exec(SECURITY_SCHEDULE_MIGRATION);
    ensured.add(db);
}

