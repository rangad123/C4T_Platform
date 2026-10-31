/** API drift history: the shape of what the API answered in each run (never the values), kept per project. */
import { diffSnapshots, addObservations, type ApiSnapshot, type ObservedResponse, type OpObservation } from "../engine/contracts/drift.js";
import type { ApiChange } from "../engine/contracts/diff.js";
import type { Db } from "./db.js";

/** Migration slot 9. */
export const DRIFT_MIGRATION = `
CREATE TABLE api_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    complete INTEGER NOT NULL,        -- 0 when the run covered only some of the project's API tests
    operations_json TEXT NOT NULL,    -- { "GET /users/{}": { statuses: [200], shape } }: field names and types only
    UNIQUE (project_id, job_id)
);
CREATE INDEX idx_api_snapshots_project ON api_snapshots(project_id, id);
`;

/** Snapshots kept per project. */
export const KEEP_SNAPSHOTS = 20;

interface Row {
    job_id: string;
    at: string;
    complete: number;
    operations_json: string;
}

const toSnapshot = (r: Row): ApiSnapshot => ({ jobId: r.job_id, at: r.at, complete: Boolean(r.complete), operations: JSON.parse(r.operations_json) as Record<string, OpObservation> });

/** True unless the job re-ran only some of the project's API tests (then an unseen operation proves nothing). */
function coversAllApiTests(db: Db, projectId: string, jobId: string): boolean {
    const job = db.get<{ options_json: string }>("SELECT options_json FROM generation_jobs WHERE id = ?", jobId);
    if (!job) return true;
    const opts = JSON.parse(job.options_json) as { mode?: string; testIds?: string[] };
    if (opts.mode !== "validate") return true;
    const chosen = new Set(opts.testIds ?? []);
    return db.all<{ id: string }>("SELECT id FROM test_cases WHERE project_id = ? AND kind = 'api' AND status = 'ACTIVE'", projectId).every((t) => chosen.has(t.id));
}

/**
 * Add what one test run observed to the job's snapshot (created on first use). Called for every execution, so a
 * run with many tests accumulates one snapshot. Never throws: drift detection must not affect a job.
 */
export function recordObservations(db: Db, args: { projectId: string; jobId: string; responses: ObservedResponse[]; at?: string }): void {
    try {
        if (!args.responses.some((r) => r && typeof r === "object" && "obs" in r)) return;
        db.tx(() => {
            const row = db.get<Row>("SELECT job_id, at, complete, operations_json FROM api_snapshots WHERE project_id = ? AND job_id = ?", args.projectId, args.jobId);
            const operations: Record<string, OpObservation> = row ? (JSON.parse(row.operations_json) as Record<string, OpObservation>) : {};
            addObservations(operations, args.responses);
            const complete = coversAllApiTests(db, args.projectId, args.jobId) ? 1 : 0;
            if (row) db.run("UPDATE api_snapshots SET operations_json = ?, complete = ? WHERE project_id = ? AND job_id = ?", JSON.stringify(operations), complete, args.projectId, args.jobId);
            else {
                db.run("INSERT INTO api_snapshots (project_id, job_id, at, complete, operations_json) VALUES (?,?,?,?,?)", args.projectId, args.jobId, args.at ?? new Date().toISOString(), complete, JSON.stringify(operations));
                db.run("DELETE FROM api_snapshots WHERE project_id = ? AND id NOT IN (SELECT id FROM api_snapshots WHERE project_id = ? ORDER BY id DESC LIMIT ?)", args.projectId, args.projectId, KEEP_SNAPSHOTS);
            }
        });
    } catch (err) {
        console.error(`[job ${args.jobId.slice(0, 8)}] could not record the API snapshot:`, err);
    }
}

/** Oldest first. */
export function listSnapshots(db: Db, projectId: string): ApiSnapshot[] {
    return db.all<Row>("SELECT job_id, at, complete, operations_json FROM api_snapshots WHERE project_id = ? ORDER BY id", projectId).map(toSnapshot);
}

export interface ApiChanges {
    /** The run compared against, and the newer run; null `from` = nothing to compare yet. */
    from: { jobId: string; at: string } | null;
    to: { jobId: string; at: string } | null;
    breaking: ApiChange[];
    nonBreaking: ApiChange[];
    /** Plain-language reason when there is nothing to compare. */
    message?: string;
}

const ref = (s: ApiSnapshot) => ({ jobId: s.jobId, at: s.at });

/**
 * Newer run vs an older one. By default the newest snapshot against the one before it; `since` picks the older run
 * (a job id) to compare against; `to` picks the newer run (used right after a job, for its alert).
 * Returns undefined when `since` / `to` name a run that has no snapshot.
 */
export function apiChanges(db: Db, projectId: string, opts: { since?: string; to?: string } = {}): ApiChanges | undefined {
    const all = listSnapshots(db, projectId);
    const toIdx = opts.to ? all.findIndex((s) => s.jobId === opts.to) : all.length - 1;
    if (opts.to && toIdx < 0) return undefined;
    const latest = all[toIdx];
    if (!latest) return { from: null, to: null, breaking: [], nonBreaking: [], message: "No API requests have been recorded yet. Run an analysis that includes API tests." };
    const prevIdx = opts.since ? all.findIndex((s) => s.jobId === opts.since) : toIdx - 1;
    if (opts.since && (prevIdx < 0 || prevIdx >= toIdx)) return undefined;
    const previous = all[prevIdx];
    if (!previous) return { from: null, to: ref(latest), breaking: [], nonBreaking: [], message: "Only one run has been recorded so far. Changes show up after the next run." };
    const d = diffSnapshots(previous, latest);
    return { from: ref(previous), to: ref(latest), breaking: d.breaking, nonBreaking: d.nonBreaking };
}
