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
import { MAX_PER_SOURCE, mergeRequestLogs, totalsOfEntries, type StoredRequestLog } from "../egress/request-log.js";
import type { EgressCounts, EgressEntry } from "../egress/guard.js";
import { redactText } from "../../shared/redact-text.js";

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
        // Set on the runs of a scanner stage that was interrupted and is being run again (supersedeScannerRuns).
        ["security_scan_runs", "superseded_at", "TEXT"],
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
    return db.all<Row>("SELECT * FROM security_scan_runs WHERE assessment_id = ? AND scanner <> ? AND superseded_at IS NULL ORDER BY created_at, id", assessmentId, PLATFORM_REQUESTS).map(rowOf);
}

/**
 * A scanner stage is about to run (again) for this assessment: the runs an interrupted earlier attempt left are superseded, so the run
 * lists show each scanner once. Their request logs stay in the assessment's request log (those requests were made).
 */
export function supersedeScannerRuns(db: Db, assessmentId: string): void {
    ensureScannerTables(db);
    db.run("UPDATE security_scan_runs SET superseded_at = ? WHERE assessment_id = ? AND scanner <> ? AND superseded_at IS NULL", new Date().toISOString(), assessmentId, PLATFORM_REQUESTS);
}

// ── the assessment's one request log ────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * The platform's own requests are kept beside the scanners': rows of this table whose `scanner` is PLATFORM_REQUESTS, one per part of the
 * assessment (`reference`: "steps", "cross-account"), holding only a request log in their coverage. They are not tool runs (the run
 * lists leave them out); they exist so that one read gives every request of an assessment, and so the platform's log is kept and
 * deleted exactly as a scanner's is (with its assessment).
 */
export const PLATFORM_REQUESTS = "platform";

/**
 * The check families the platform's own requests are logged under. A stored log names only these: a log can come back from a runner,
 * and one that named a new source for every entry would otherwise be kept in full (the cap is per source).
 */
export const PLATFORM_SOURCES: readonly string[] = ["discovery", "checks", "api-document", "sign-in", "cross-account", "tls"].map((family) => `platform:${family}`);
/** The source an entry is stored under: one of the known families, and "platform:checks" for anything else. */
export const platformSource = (source: unknown): string => (PLATFORM_SOURCES.includes(String(source ?? "")) ? String(source) : "platform:checks");
/** Most method names counted for one source of a stored log. */
const MAX_METHODS = 16;

/** One source's counts as stored: numbers only, and method names that look like method names, a bounded number of them. */
function cleanCounts(c: EgressCounts): EgressCounts {
    const n = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));
    const byMethod: Record<string, number> = {};
    for (const [method, count] of Object.entries(c.byMethod && typeof c.byMethod === "object" ? c.byMethod : {})) {
        if (!/^[A-Za-z]{1,16}$/.test(method)) continue;
        const key = method.toUpperCase();
        if (!(key in byMethod) && Object.keys(byMethod).length >= MAX_METHODS) continue;
        byMethod[key] = (byMethod[key] ?? 0) + n(count);
    }
    return { total: n(c.total), allowed: n(c.allowed), refused: n(c.refused), failed: n(c.failed), byMethod };
}

/** Field sizes and the shared redaction once more: a log can come back from a runner, and what is stored is shown to the run's viewers. */
function cleanEntry(e: EgressEntry): EgressEntry | undefined {
    if (!e || typeof e !== "object" || !["allowed", "refused", "failed"].includes(e.verdict)) return undefined;
    return {
        at: String(e.at ?? "").slice(0, 40),
        source: platformSource(e.source),
        method: String(e.method ?? "").slice(0, 16),
        host: String(e.host ?? "").slice(0, 255),
        path: redactText(String(e.path ?? "").split(/[?#]/)[0]!.slice(0, 500), 500),
        verdict: e.verdict,
        ...(typeof e.status === "number" ? { status: e.status } : {}),
        ...(e.reason ? { reason: redactText(String(e.reason).slice(0, 300), 300) } : {}),
    };
}

/** Keep (replace) the platform's request log of one part of an assessment. Always "platform:<family>" sources, whatever the log says. */
export function savePlatformRequests(db: Db, a: { id: string; projectId: string; applicationId: string; kind?: string }, part: string, log: StoredRequestLog | undefined): void {
    if (!log || !Array.isArray(log.entries)) return;
    ensureScannerTables(db);
    // Totals per known family; whatever else the log names is counted under "platform:checks", as its entries are.
    const perSource: StoredRequestLog[] = [];
    for (const [source, c] of Object.entries(log.totals && typeof log.totals === "object" ? log.totals : {}).slice(0, 1_000)) if (source.startsWith("platform:") && c && typeof c === "object") perSource.push({ entries: [], totals: { [platformSource(source)]: cleanCounts(c) } });
    const clean = mergeRequestLogs([{ entries: log.entries.map(cleanEntry).filter((e): e is EgressEntry => Boolean(e)), totals: {} }, ...perSource]);
    for (const [source, c] of Object.entries(clean.totals)) clean.totals[source] = cleanCounts(c);
    const coverage = JSON.stringify({ inspected: [], notInspected: [], requestLog: clean.entries, requestTotals: clean.totals });
    const now = new Date().toISOString();
    const existing = db.get<Row>("SELECT id FROM security_scan_runs WHERE assessment_id = ? AND scanner = ? AND reference = ?", a.id, PLATFORM_REQUESTS, part);
    if (existing) db.run("UPDATE security_scan_runs SET coverage_json = ?, finished_at = ? WHERE id = ?", coverage, now, String(existing.id));
    else
        db.run(
            `INSERT INTO security_scan_runs (id, assessment_id, project_id, application_id, scanner, profile, state, reference, finished_at, findings_count, coverage_json, created_at)
             VALUES (?,?,?,?,?,?, 'COMPLETED', ?, ?, 0, ?, ?)`,
            randomUUID(),
            a.id,
            a.projectId,
            a.applicationId,
            PLATFORM_REQUESTS,
            isProfile(String(a.kind)) ? String(a.kind) : "passive",
            part,
            now,
            coverage,
            now,
        );
}

export interface AssessmentRequestLog extends StoredRequestLog {
    /** Most entries listed per source; `totals` always count every request. */
    capPerSource: number;
    /** Per source: requests counted but not listed (over the cap). A scanner's own counts beyond its listed entries are not stored. */
    notListed: Record<string, number>;
}

/** Every request of one assessment, scanners' and the platform's together, in time order, each with its source. */
export function requestLogOfAssessment(db: Db, assessmentId: string): AssessmentRequestLog {
    ensureScannerTables(db);
    const logs: StoredRequestLog[] = [];
    for (const r of db.all<Row>("SELECT scanner, coverage_json FROM security_scan_runs WHERE assessment_id = ? ORDER BY created_at, id", assessmentId)) {
        const coverage = json<ScannerCoverage & { requestTotals?: Record<string, EgressCounts> }>(r.coverage_json, { inspected: [], notInspected: [] });
        const platform = String(r.scanner) === PLATFORM_REQUESTS;
        // A scanner's entries are its own whatever they say; the platform's rows were made "platform:*" when they were saved.
        const entries = ((coverage.requestLog ?? []) as EgressEntry[]).map((e) => (platform ? e : { ...e, source: `scanner:${String(r.scanner)}` }));
        logs.push({ entries, totals: platform && coverage.requestTotals ? coverage.requestTotals : totalsOfEntries(entries) });
    }
    const merged = mergeRequestLogs(logs);
    const listed: Record<string, number> = {};
    for (const e of merged.entries) listed[e.source ?? ""] = (listed[e.source ?? ""] ?? 0) + 1;
    const notListed: Record<string, number> = {};
    for (const [source, c] of Object.entries(merged.totals)) if (c.total > (listed[source] ?? 0)) notListed[source] = c.total - (listed[source] ?? 0);
    return { ...merged, capPerSource: MAX_PER_SOURCE, notListed };
}

/** Every run of one project, most recent first, for the project's scanner history. */
export function listRuns(db: Db, projectId: string, limit = 100): ScanRun[] {
    ensureScannerTables(db);
    return db.all<Row>("SELECT * FROM security_scan_runs WHERE project_id = ? AND scanner <> ? AND superseded_at IS NULL ORDER BY created_at DESC, id DESC LIMIT ?", projectId, PLATFORM_REQUESTS, limit).map(rowOf);
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
