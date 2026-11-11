/**
 * The scanner layer's own tables and the one store all its parts use (additive: it creates nothing that already exists and changes no
 * existing table).
 *
 *   security_scan_runs           one row per tool per assessment: which tool, at which profile, how it ended, what it found, the
 *                                approval that let it run, and the coverage it reported
 *   security_scanner_settings    which scanners a project may run (an administrator switches a tool on platform-wide with
 *                                SECURITY_SCANNERS; a project then has to allow it too, so one client cannot scan with a tool another
 *                                client has not agreed to)
 *
 * Both use `IF NOT EXISTS` and are also created by `ensureSecurityTables` (store.ts), so the module works whether or not the
 * migration slot ran yet, and re-running the SQL is harmless. Rows go with their project (ON DELETE CASCADE).
 *
 * Stable API:
 *   ScanRunStore (or the functions below)   recordRun(input) -> ScanRun
 *                                          updateRun(id, patch) -> ScanRun | undefined
 *                                          getRun(id) · listRuns(assessmentId) · runsOfAssessment(assessmentId)
 *   projectScanners(projectId) -> ScannerId[]   setProjectScanners(projectId, ids)
 *
 * Nothing in here redacts or normalizes: the findings pipeline (findings/ingest.ts) owns that. This store keeps the record of what
 * ran, in words a person can read.
 */
import { randomUUID } from "node:crypto";
import type { Db, Row } from "../../platform/db.js";
import { SCANNER_IDS, type ScannerId } from "./contract.js";
import type { ScanApproval, ScannerCoverage, ScanIntensity } from "./contract.js";

/** How one tool's run ended. Deliberately not the assessment's states: a run is a step inside an assessment. */
export const SCAN_RUN_STATES = ["QUEUED", "RUNNING", "COMPLETED", "PARTIALLY_COMPLETED", "FAILED", "CANCELLED", "SKIPPED", "UNAVAILABLE"] as const;
export type ScanRunState = (typeof SCAN_RUN_STATES)[number];
export const FINISHED_RUN_STATES: readonly ScanRunState[] = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED", "CANCELLED", "SKIPPED", "UNAVAILABLE"];

export const SCANNER_MIGRATION = `
CREATE TABLE IF NOT EXISTS security_scan_runs (
    id TEXT PRIMARY KEY,
    assessment_id TEXT NOT NULL REFERENCES security_assessments(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    application_id TEXT NOT NULL REFERENCES security_applications(id) ON DELETE CASCADE,
    scanner TEXT NOT NULL,
    profile TEXT NOT NULL,
    state TEXT NOT NULL,
    reference TEXT,
    started_at TEXT,
    finished_at TEXT,
    took_ms INTEGER,
    findings_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    coverage_json TEXT NOT NULL DEFAULT '{}',
    approval_json TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sec_scanrun_assessment ON security_scan_runs(assessment_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sec_scanrun_project ON security_scan_runs(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sec_scanrun_scanner ON security_scan_runs(scanner, created_at);

CREATE TABLE IF NOT EXISTS security_scanner_settings (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    enabled_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
);
`;

const ensured = new WeakSet<Db>();
/** Safe to call repeatedly and from several places; the first call for a database creates the tables. */
export function ensureScannerTables(db: Db): void {
    if (ensured.has(db)) return;
    db.raw.exec(SCANNER_MIGRATION);
    // Additive column on an existing table: the approval recorded for an intrusive profile, kept with the assessment that used it.
    // SQLite has no ADD COLUMN IF NOT EXISTS, so the existing columns are read once and only what is missing is added.
    for (const [table, column, definition] of [
        ["security_assessments", "approval_json", "TEXT"],
    ] as const) {
        if (db.dialect.tableExists(db, table) && !db.dialect.columnExists(db, table, column)) db.raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    ensured.add(db);
}

export interface ScanRun {
    id: string;
    assessmentId: string;
    projectId: string;
    applicationId: string;
    scanner: ScannerId;
    profile: ScanIntensity;
    state: ScanRunState;
    /** The tool's own run id (a ZAP scan id, a nuclei run id), for traceability back to the tool's own records. */
    reference: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    tookMs: number | null;
    findingsCount: number;
    /** One plain sentence: why it failed, was skipped, or was unavailable. Never raw tool output with a key in it. */
    error: string | null;
    coverage: ScannerCoverage;
    approval: ScanApproval | null;
    createdAt: string;
}

const json = <T>(raw: unknown, fallback: T): T => {
    if (typeof raw !== "string" || !raw) return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
};

const isScanner = (v: string): v is ScannerId => (SCANNER_IDS as readonly string[]).includes(v);
const isProfile = (v: string): v is ScanIntensity => (["passive", "conservative-active", "advanced"] as string[]).includes(v);
const isState = (v: string): v is ScanRunState => (SCAN_RUN_STATES as readonly string[]).includes(v);

const rowOf = (r: Row): ScanRun => ({
    id: String(r.id),
    assessmentId: String(r.assessment_id),
    projectId: String(r.project_id),
    applicationId: String(r.application_id),
    scanner: isScanner(String(r.scanner)) ? (String(r.scanner) as ScannerId) : "nuclei",
    profile: isProfile(String(r.profile)) ? (String(r.profile) as ScanIntensity) : "passive",
    state: isState(String(r.state)) ? (String(r.state) as ScanRunState) : "FAILED",
    reference: r.reference ?? null,
    startedAt: r.started_at ?? null,
    finishedAt: r.finished_at ?? null,
    tookMs: r.took_ms === null || r.took_ms === undefined ? null : Number(r.took_ms),
    findingsCount: Number(r.findings_count ?? 0),
    error: r.error ?? null,
    coverage: json<ScannerCoverage>(r.coverage_json, { inspected: [], notInspected: [] }),
    approval: json<ScanApproval | null>(r.approval_json, null),
    createdAt: String(r.created_at),
});

export interface CreateRunInput {
    assessmentId: string;
    projectId: string;
    applicationId: string;
    scanner: ScannerId;
    profile: ScanIntensity;
    approval?: ScanApproval | null;
    at?: Date;
}

/** One new run row, `QUEUED`. The id is returned so the caller can update it as the run goes. */
export function createRun(db: Db, input: CreateRunInput): ScanRun {
    ensureScannerTables(db);
    const id = randomUUID();
    const at = (input.at ?? new Date()).toISOString();
    db.run(
        `INSERT INTO security_scan_runs (id, assessment_id, project_id, application_id, scanner, profile, state, findings_count, coverage_json, approval_json, created_at)
         VALUES (?,?,?,?,?,?, 'QUEUED', 0, '{}', ?, ?)`,
        id,
        input.assessmentId,
        input.projectId,
        input.applicationId,
        input.scanner,
        input.profile,
        input.approval ? JSON.stringify(input.approval) : null,
        at,
    );
    return getRun(db, id)!;
}

export function updateRun(db: Db, id: string, patch: Partial<Pick<ScanRun, "state" | "reference" | "startedAt" | "finishedAt" | "tookMs" | "findingsCount" | "error" | "coverage">>): ScanRun | undefined {
    ensureScannerTables(db);
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    const put = (column: string, value: string | number | null) => {
        sets.push(`${column} = ?`);
        values.push(value);
    };
    if (patch.state !== undefined) put("state", patch.state);
    if (patch.reference !== undefined) put("reference", patch.reference);
    if (patch.startedAt !== undefined) put("started_at", patch.startedAt);
    if (patch.finishedAt !== undefined) put("finished_at", patch.finishedAt);
    if (patch.tookMs !== undefined) put("took_ms", patch.tookMs);
    if (patch.findingsCount !== undefined) put("findings_count", patch.findingsCount);
    if (patch.error !== undefined) put("error", patch.error);
    if (patch.coverage !== undefined) put("coverage_json", JSON.stringify(patch.coverage ?? { inspected: [], notInspected: [] }));
    if (!sets.length) return getRun(db, id);
    db.run(`UPDATE security_scan_runs SET ${sets.join(", ")} WHERE id = ?`, ...values, id);
    return getRun(db, id);
}

export function getRun(db: Db, id: string): ScanRun | undefined {
    ensureScannerTables(db);
    const r = db.get<Row>("SELECT * FROM security_scan_runs WHERE id = ?", id);
    return r ? rowOf(r) : undefined;
}

/** Every run of one assessment, oldest first (the order they were meant to run in). */
export function runsOfAssessment(db: Db, assessmentId: string): ScanRun[] {
    ensureScannerTables(db);
    return db.all<Row>("SELECT * FROM security_scan_runs WHERE assessment_id = ? ORDER BY created_at, id", assessmentId).map(rowOf);
}

/** Every run of one project, most recent first, for the project's scanner history. */
export function listRuns(db: Db, projectId: string, limit = 100): ScanRun[] {
    ensureScannerTables(db);
    return db.all<Row>("SELECT * FROM security_scan_runs WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?", projectId, limit).map(rowOf);
}

/** The scanners this project allows. Empty means none: a tool switched on platform-wide still may not scan this client's targets. */
export function projectScanners(db: Db, projectId: string): ScannerId[] {
    ensureScannerTables(db);
    const r = db.get<Row>("SELECT enabled_json FROM security_scanner_settings WHERE project_id = ?", projectId);
    const names = json<string[]>(r?.enabled_json, []);
    return SCANNER_IDS.filter((id) => names.includes(id));
}

/** Replaces the project's allowed scanners with `ids` (unknown names are dropped, order is canonical). */
export function setProjectScanners(db: Db, projectId: string, ids: readonly string[]): ScannerId[] {
    ensureScannerTables(db);
    const wanted = new Set(ids.map((i) => String(i).toLowerCase()));
    const kept = SCANNER_IDS.filter((id) => wanted.has(id));
    db.run(
        `INSERT INTO security_scanner_settings (project_id, enabled_json, updated_at) VALUES (?,?,?)
         ON CONFLICT(project_id) DO UPDATE SET enabled_json = excluded.enabled_json, updated_at = excluded.updated_at`,
        projectId,
        JSON.stringify(kept),
        new Date().toISOString(),
    );
    return kept;
}
