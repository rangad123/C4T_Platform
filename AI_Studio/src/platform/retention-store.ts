/**
 * Storage of the retention feature (migration slot 16): each project's retention policy, a log of every pruning run, and the
 * list of things a person still has to re-enter after restoring a backup.
 *
 * Pruned evidence files stay as rows in `artifacts` (marked with `pruned_at` and a reason) so run history, trends and flaky
 * detection never change; only the file on disk is gone.
 */
import { DEFAULT_POLICY, platformDefaultDays, policyFromPlatformDefault, type RetentionPolicy } from "../engine/retention/policy.js";
import type { Db, Row } from "./db.js";

export const RETENTION_MIGRATION = `
ALTER TABLE artifacts ADD COLUMN pruned_at TEXT;
ALTER TABLE artifacts ADD COLUMN pruned_reason TEXT;
CREATE INDEX idx_artifacts_project_pruned ON artifacts(project_id, pruned_at);
CREATE TABLE retention_policies (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 0,
    keep_days INTEGER NOT NULL,
    keep_failed_days INTEGER NOT NULL,
    keep_latest_runs INTEGER NOT NULL,
    max_artifact_mb INTEGER,
    updated_at TEXT NOT NULL
);
CREATE TABLE retention_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    trigger_kind TEXT NOT NULL,            -- manual | scheduled
    files INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    errors INTEGER NOT NULL DEFAULT 0,
    error_sample TEXT                      -- the first few problems, in words (never a host path)
);
CREATE INDEX idx_retention_log_project ON retention_log(project_id, id);
CREATE TABLE restore_needs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_restore_needs_project ON restore_needs(project_id);
`;

export interface EffectivePolicy extends RetentionPolicy {
    /** Where the numbers come from: this project's own saved policy, the platform default, or the built-in defaults. */
    source: "project" | "platform" | "default";
}

export interface RetentionLogRow {
    id: number;
    at: string;
    trigger: "manual" | "scheduled";
    files: number;
    bytes: number;
    errors: number;
    errorSample: string | null;
}

export interface RestoreNeed {
    id: number;
    kind: string;
    label: string;
    detail: string | null;
}

const LOG_KEPT = 200;
const now = () => new Date().toISOString();

export class RetentionStore {
    constructor(
        private readonly db: Db,
        /** RETENTION_DEFAULT_DAYS as written in the environment. */
        private readonly platformDefault?: string,
    ) {}

    /** The policy saved for the project, if any. */
    saved(projectId: string): RetentionPolicy | undefined {
        const r = this.db.get<Row>("SELECT * FROM retention_policies WHERE project_id = ?", projectId);
        if (!r) return undefined;
        return { enabled: Boolean(r.enabled), keepDays: r.keep_days, keepFailedDays: r.keep_failed_days, keepLatestRuns: r.keep_latest_runs, maxArtifactMB: r.max_artifact_mb ?? null };
    }

    /** What applies to the project: its own policy, else the platform default (when the operator set one), else "off". */
    effective(projectId: string): EffectivePolicy {
        const own = this.saved(projectId);
        if (own) return { ...own, source: "project" };
        const days = platformDefaultDays(this.platformDefault);
        if (days !== undefined) return { ...policyFromPlatformDefault(days), source: "platform" };
        return { ...DEFAULT_POLICY, source: "default" };
    }

    save(projectId: string, p: RetentionPolicy): void {
        this.db.run(
            `INSERT INTO retention_policies (project_id, enabled, keep_days, keep_failed_days, keep_latest_runs, max_artifact_mb, updated_at) VALUES (?,?,?,?,?,?,?)
             ON CONFLICT(project_id) DO UPDATE SET enabled = excluded.enabled, keep_days = excluded.keep_days, keep_failed_days = excluded.keep_failed_days,
                keep_latest_runs = excluded.keep_latest_runs, max_artifact_mb = excluded.max_artifact_mb, updated_at = excluded.updated_at`,
            projectId,
            p.enabled ? 1 : 0,
            p.keepDays,
            p.keepFailedDays,
            p.keepLatestRuns,
            p.maxArtifactMB ?? null,
            now(),
        );
    }

    log(projectId: string, row: { at?: string; trigger: "manual" | "scheduled"; files: number; bytes: number; errors: number; errorSample?: string }): void {
        this.db.run("INSERT INTO retention_log (project_id, at, trigger_kind, files, bytes, errors, error_sample) VALUES (?,?,?,?,?,?,?)", projectId, row.at ?? now(), row.trigger, row.files, row.bytes, row.errors, row.errorSample?.slice(0, 600) ?? null);
        // Keep the log short: it is a record of recent runs, not an archive.
        this.db.run("DELETE FROM retention_log WHERE project_id = ? AND id <= (SELECT id FROM retention_log WHERE project_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)", projectId, projectId, LOG_KEPT);
    }

    recent(projectId: string, limit = 10): RetentionLogRow[] {
        return this.db
            .all<Row>("SELECT * FROM retention_log WHERE project_id = ? ORDER BY id DESC LIMIT ?", projectId, limit)
            .map((r) => ({ id: r.id, at: r.at, trigger: r.trigger_kind, files: r.files, bytes: r.bytes, errors: r.errors, errorSample: r.error_sample }));
    }

    /** When the last scheduled run for the project happened (epoch ms), if ever. */
    lastScheduledAt(projectId: string): number | undefined {
        const r = this.db.get<{ at: string }>("SELECT at FROM retention_log WHERE project_id = ? AND trigger_kind = 'scheduled' ORDER BY id DESC LIMIT 1", projectId);
        const t = r ? Date.parse(r.at) : NaN;
        return Number.isNaN(t) ? undefined : t;
    }

    addNeeds(projectId: string, needs: Array<{ kind: string; label: string; detail?: string }>): void {
        for (const n of needs) this.db.run("INSERT INTO restore_needs (project_id, kind, label, detail, created_at) VALUES (?,?,?,?,?)", projectId, n.kind, n.label, n.detail ?? null, now());
    }

    needs(projectId: string): RestoreNeed[] {
        return this.db.all<Row>("SELECT id, kind, label, detail FROM restore_needs WHERE project_id = ? ORDER BY id", projectId).map((r) => ({ id: r.id, kind: r.kind, label: r.label, detail: r.detail }));
    }

    clearNeeds(projectId: string): number {
        return Number(this.db.run("DELETE FROM restore_needs WHERE project_id = ?", projectId).changes);
    }
}
