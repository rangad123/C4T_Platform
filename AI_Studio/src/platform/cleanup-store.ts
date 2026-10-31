/**
 * Test-data cleanup ledger: which records a run's data-changing API tests created, and what became of each.
 *
 * Only paths and ids are stored (never a response body, a header or a token). Rows older than 30 days are pruned.
 * The per-project switch (cleanupAfter) lives here too.
 */
import { countItems, summaryLine, type CleanupCounts, type CleanupStatus, type FinishedItem } from "../engine/cleanup/ledger.js";
import type { Db } from "./db.js";

/** Migration slot 13. */
export const CLEANUP_MIGRATION = `
CREATE TABLE cleanup_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL,
    test_case_id TEXT REFERENCES test_cases(id) ON DELETE SET NULL,
    test_key TEXT NOT NULL,
    seq INTEGER NOT NULL,            -- creation order within the run
    method TEXT NOT NULL,
    path TEXT NOT NULL,              -- the collection the record was POSTed to
    record_id TEXT NOT NULL,         -- the id the application gave it (not a secret)
    delete_path TEXT,                -- the DELETE address planned for it; NULL = no known way to remove it
    origin TEXT,                     -- the application address the run talked to
    environment TEXT,                -- a named environment, or NULL for the project's own address
    status TEXT NOT NULL,            -- removed already-gone failed no-delete-operation skipped
    reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,        -- when the test created the record
    cleaned_at TEXT                  -- when cleanup last tried
);
CREATE INDEX idx_cleanup_project ON cleanup_ledger(project_id, id);
CREATE INDEX idx_cleanup_test ON cleanup_ledger(test_case_id, id);
CREATE TABLE cleanup_settings (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    cleanup_after INTEGER NOT NULL,
    updated_at TEXT NOT NULL
);
`;

export const RETENTION_DAYS = 30;

export interface LedgerRow {
    id: number;
    jobId: string;
    testId: string;
    testCaseId: string | null;
    method: string;
    path: string;
    recordId: string;
    deletePath: string | null;
    origin: string | null;
    environment: string | null;
    status: CleanupStatus;
    reason: string | null;
    attempts: number;
    createdAt: string;
    cleanedAt: string | null;
}

export interface CleanupRun {
    jobId: string;
    /** When the run created its first record. */
    at: string;
    environment: string | null;
    counts: CleanupCounts;
    summary: string;
    items: PublicItem[];
}

/** What the API shows of a ledger row. Ids and paths only. */
export interface PublicItem {
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

const toRow = (r: Record<string, any>): LedgerRow => ({
    id: r.id,
    jobId: r.job_id,
    testId: r.test_key,
    testCaseId: r.test_case_id,
    method: r.method,
    path: r.path,
    recordId: r.record_id,
    deletePath: r.delete_path,
    origin: r.origin,
    environment: r.environment,
    status: r.status,
    reason: r.reason,
    attempts: r.attempts,
    createdAt: r.created_at,
    cleanedAt: r.cleaned_at,
});

const toPublic = (r: LedgerRow): PublicItem => ({
    id: r.id,
    testId: r.testId,
    testCaseId: r.testCaseId,
    path: r.path,
    recordId: r.recordId,
    status: r.status,
    reason: r.reason,
    canRetry: r.status === "failed" && Boolean(r.deletePath),
    createdAt: r.createdAt,
});

export class CleanupStore {
    constructor(private readonly db: Db) {}

    /** Store a run's ledger (oldest first, as finished by the engine) and drop rows past retention. Never throws into a job. */
    record(args: { projectId: string; jobId: string; items: FinishedItem[] }): void {
        const now = new Date().toISOString();
        this.db.tx(() => {
            for (const i of args.items) {
                const test = this.db.get<{ id: string }>("SELECT id FROM test_cases WHERE project_id = ? AND test_key = ?", args.projectId, i.testId);
                this.db.run(
                    "INSERT INTO cleanup_ledger (project_id, job_id, test_case_id, test_key, seq, method, path, record_id, delete_path, origin, environment, status, reason, attempts, created_at, cleaned_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    args.projectId,
                    args.jobId,
                    test?.id ?? null,
                    i.testId,
                    i.seq,
                    i.method,
                    i.path,
                    i.id,
                    i.deletePath ?? null,
                    i.origin ?? null,
                    i.environment ?? null,
                    i.status,
                    i.reason ?? null,
                    i.status === "removed" || i.status === "already-gone" || i.status === "failed" ? 1 : 0,
                    i.createdAt,
                    i.status === "skipped" || i.status === "no-delete-operation" ? null : now,
                );
            }
        });
        this.prune();
    }

    prune(days = RETENTION_DAYS): number {
        const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
        return Number(this.db.run("DELETE FROM cleanup_ledger WHERE created_at < ?", cutoff).changes);
    }

    private runOf(rows: LedgerRow[]): CleanupRun {
        const sorted = [...rows].sort((a, b) => a.id - b.id);
        const counts = countItems(sorted);
        return { jobId: sorted[0]!.jobId, at: sorted.map((r) => r.createdAt).sort()[0]!, environment: sorted[0]!.environment, counts, summary: summaryLine(counts), items: sorted.map(toPublic) };
    }

    /** The newest run of the project that created records. */
    latestRun(projectId: string): CleanupRun | null {
        const last = this.db.get<{ job_id: string }>("SELECT job_id FROM cleanup_ledger WHERE project_id = ? ORDER BY id DESC LIMIT 1", projectId);
        if (!last) return null;
        return this.runOf(this.db.all("SELECT * FROM cleanup_ledger WHERE project_id = ? AND job_id = ?", projectId, last.job_id).map(toRow));
    }

    /** Recent runs, newest first, without their items. */
    runs(projectId: string, limit = 10): Array<Omit<CleanupRun, "items">> {
        const jobs = this.db.all<{ job_id: string }>("SELECT job_id FROM cleanup_ledger WHERE project_id = ? GROUP BY job_id ORDER BY MAX(id) DESC LIMIT ?", projectId, limit);
        return jobs.map(({ job_id }) => {
            const { items: _items, ...rest } = this.runOf(this.db.all("SELECT * FROM cleanup_ledger WHERE project_id = ? AND job_id = ?", projectId, job_id).map(toRow));
            return rest;
        });
    }

    /** What the newest run that touched this test created for it. */
    latestForTest(testCaseId: string): CleanupRun | null {
        const last = this.db.get<{ job_id: string; project_id: string }>("SELECT job_id, project_id FROM cleanup_ledger WHERE test_case_id = ? ORDER BY id DESC LIMIT 1", testCaseId);
        if (!last) return null;
        return this.runOf(this.db.all("SELECT * FROM cleanup_ledger WHERE job_id = ? AND test_case_id = ?", last.job_id, testCaseId).map(toRow));
    }

    /** Failed items of the project's latest run that can be tried again (they have a recorded DELETE address). */
    retryable(projectId: string): LedgerRow[] {
        const last = this.db.get<{ job_id: string }>("SELECT job_id FROM cleanup_ledger WHERE project_id = ? ORDER BY id DESC LIMIT 1", projectId);
        if (!last) return [];
        return this.db
            .all("SELECT * FROM cleanup_ledger WHERE project_id = ? AND job_id = ? AND status = 'failed' AND delete_path IS NOT NULL ORDER BY seq DESC, id DESC", projectId, last.job_id)
            .map(toRow);
    }

    /** Record the outcome of a retry. */
    update(id: number, status: CleanupStatus, reason?: string): void {
        this.db.run("UPDATE cleanup_ledger SET status = ?, reason = ?, attempts = attempts + 1, cleaned_at = ? WHERE id = ?", status, reason ?? null, new Date().toISOString(), id);
    }

    /** The project's switch; undefined = never set (cleanup is on). */
    getEnabled(projectId: string): boolean | undefined {
        const r = this.db.get<{ cleanup_after: number }>("SELECT cleanup_after FROM cleanup_settings WHERE project_id = ?", projectId);
        return r ? Boolean(r.cleanup_after) : undefined;
    }

    setEnabled(projectId: string, enabled: boolean): void {
        this.db.run(
            "INSERT INTO cleanup_settings (project_id, cleanup_after, updated_at) VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET cleanup_after = excluded.cleanup_after, updated_at = excluded.updated_at",
            projectId,
            enabled ? 1 : 0,
            new Date().toISOString(),
        );
    }
}
