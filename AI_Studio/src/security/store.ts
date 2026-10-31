/**
 * Security Assessment module: every table of the module (migration slot 31) and the one store all its parts use.
 *
 * Stable API (RUN, FIND and the routes build on these names; change them only additively):
 *
 *   new SecurityStore(db)                      one per Db is fine; `securityStoreFor(db)` caches one
 *
 *   applications   createApplication(projectId, input) · getApplication(id) · listApplications(projectId) · countApplications(projectId)
 *                  updateApplication(id, patch) · deleteApplication(id)
 *   authorizations addAuthorization(appId, input) (revokes the earlier unrevoked ones) · getAuthorization(id) · listAuthorizations(appId)
 *                  revokeAuthorization(id, by) · currentAuthorization(app) · authorizationState(app)   (see ./authorization.ts for the rules)
 *   assessments    createAssessment({ applicationId, authorizationId, startedBy, retestOf? }) · getAssessment(id) · listAssessments(filter)
 *                  updateAssessment(id, patch) · activeAssessment(appId) · activeAssessments(projectId)
 *                  claimAssessment(owner, leaseMs) · renewLease(id, owner, leaseMs) · releaseLease(id, owner)
 *                  requestCancel(id) · cancelRequested(id) · getWorkData(id) / setWorkData(id, value)   (RUN's own scratch JSON)
 *   findings       upsertFinding(input) -> { finding, created } (dedup by application + fingerprint; never changes `validation`)
 *                  getFinding(id) · findingByFingerprint(appId, fp) · listFindings(filter) · countFindings(filter)
 *                  setValidation(id, validation, { comment, assessmentId? }) (keeps history) · findingHistory(id)
 *                  addFindingNote(id, comment, assessmentId?) (history row without a state change, e.g. "still present")
 *                  recordSighting(findingId, assessmentId, evidence) · sightingsOf(assessmentId) · findingIdsSeenIn(assessmentId)
 *   audit          addAudit(event) · listAudit(projectId, { limit, before }) (use ./audit.ts `recordSecurityEvent`, which also writes Activity)
 *   settings       testingType(projectId) · setTestingType(projectId, type)
 *   retention      prune(retentionDays, now?) -> counts
 *
 * Everything belongs to a project (the tenant boundary): rows carry project_id or reach it through their application, and the rows go
 * with the project (ON DELETE CASCADE). Evidence a finding keeps is its latest (findings.evidence_json); evidence per assessment lives in
 * security_finding_sightings and goes with the assessment when retention prunes it. Values are stored as given: redaction is done before
 * (FIND's ingest and manual entry), never here.
 */
import { randomUUID } from "node:crypto";
import type { Db, Row } from "../platform/db.js";
import { actorLabel, currentActor } from "../platform/auth/actor.js";
import {
    FINISHED_STATES,
    ASSESSMENT_KINDS,
    type AssessmentState,
    type Confidence,
    type Evidence,
    type FindingCategory,
    type SecurityApplication,
    type SecurityAssessment,
    type SecurityAuthorization,
    type SecurityEnvironment,
    type SecurityFinding,
    type Severity,
    type ValidationState,
} from "./contract.js";
import { authorizationStateOf, scopeFingerprint, type AuthorizationState } from "./authorization.js";
import { apiDocumentSummary, ensureExtrasTables, readExtras, writeExtras } from "./extras.js";
import { ensureScannerTables } from "./scanners/store.js";
import type { SensitiveWorkflow } from "./contract.js";

/** Migration slot 31: all security tables. `IF NOT EXISTS` so `ensureSecurityTables` can also make sure of it on first use. */
export const SECURITY_MIGRATION = `
CREATE TABLE IF NOT EXISTS security_applications (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    target_url TEXT NOT NULL,
    environment TEXT NOT NULL,
    scope_json TEXT NOT NULL,                 -- extra authorized origins / host patterns
    excluded_paths_json TEXT NOT NULL,        -- path prefixes never requested
    max_rps INTEGER NOT NULL,
    api_spec_url TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sec_apps_project ON security_applications(project_id, created_at);

CREATE TABLE IF NOT EXISTS security_authorizations (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES security_applications(id) ON DELETE CASCADE,
    basis TEXT NOT NULL,                      -- owner | client-permission
    approver_name TEXT NOT NULL,
    approver_email TEXT,
    document_reference TEXT,
    restrictions TEXT,
    statement TEXT NOT NULL,                  -- the exact sentence the person confirmed
    confirmed_by_user_id TEXT,
    confirmed_by_name TEXT NOT NULL,
    confirmed_at TEXT NOT NULL,
    scope_fingerprint TEXT NOT NULL,          -- target, scope, exclusions and rate limit at the time (authorization.ts)
    revoked_at TEXT,
    revoked_by TEXT,
    revoked_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_sec_auth_app ON security_authorizations(application_id, confirmed_at);

CREATE TABLE IF NOT EXISTS security_assessments (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES security_applications(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    authorization_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'passive',
    state TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    progress_text TEXT NOT NULL DEFAULT '',
    coverage_json TEXT,
    error TEXT,
    started_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    retest_of TEXT,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    lease_owner TEXT,                         -- the assessment loop holding it (RUN), and until when (epoch ms)
    lease_until INTEGER,
    heartbeat_at TEXT,
    work_json TEXT                            -- RUN's own working data (pages seen, step outcomes); never shown as is
);
CREATE INDEX IF NOT EXISTS idx_sec_assess_project ON security_assessments(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sec_assess_app ON security_assessments(application_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sec_assess_state ON security_assessments(state);

CREATE TABLE IF NOT EXISTS security_findings (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    application_id TEXT NOT NULL REFERENCES security_applications(id) ON DELETE CASCADE,
    first_assessment_id TEXT REFERENCES security_assessments(id) ON DELETE SET NULL,
    last_assessment_id TEXT REFERENCES security_assessments(id) ON DELETE SET NULL,
    fingerprint TEXT NOT NULL,
    check_id TEXT,                            -- which built-in check produced it (null for manual findings)
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    severity TEXT NOT NULL,
    confidence TEXT NOT NULL,
    location TEXT NOT NULL,
    description TEXT NOT NULL,
    impact TEXT NOT NULL,
    remediation TEXT NOT NULL,
    reproduction TEXT,
    evidence_json TEXT NOT NULL,              -- the latest evidence (already redacted)
    source TEXT NOT NULL,                     -- built-in | manual
    ai_note TEXT,
    validation TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    created_by TEXT,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sec_find_fp ON security_findings(application_id, fingerprint);
CREATE INDEX IF NOT EXISTS idx_sec_find_project ON security_findings(project_id, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_sec_find_severity ON security_findings(project_id, severity);
CREATE INDEX IF NOT EXISTS idx_sec_find_validation ON security_findings(project_id, validation);
CREATE INDEX IF NOT EXISTS idx_sec_find_last ON security_findings(last_assessment_id);

CREATE TABLE IF NOT EXISTS security_finding_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    finding_id TEXT NOT NULL REFERENCES security_findings(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,                      -- "Name (user id)" or the plain word ("Platform")
    actor_id TEXT,
    from_validation TEXT,
    to_validation TEXT,
    comment TEXT,
    assessment_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_sec_hist_finding ON security_finding_history(finding_id, id);

CREATE TABLE IF NOT EXISTS security_finding_sightings (
    finding_id TEXT NOT NULL REFERENCES security_findings(id) ON DELETE CASCADE,
    assessment_id TEXT NOT NULL REFERENCES security_assessments(id) ON DELETE CASCADE,
    seen_at TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    PRIMARY KEY (finding_id, assessment_id)
);
CREATE INDEX IF NOT EXISTS idx_sec_sight_assessment ON security_finding_sightings(assessment_id);

CREATE TABLE IF NOT EXISTS security_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    project_id TEXT NOT NULL,                 -- no foreign key: the trail outlives what it describes
    application_id TEXT,
    actor_kind TEXT NOT NULL,
    actor_id TEXT,
    actor_name TEXT NOT NULL,
    action TEXT NOT NULL,                     -- a SecurityAuditAction code ("application.created")
    object_type TEXT NOT NULL,
    object_id TEXT,
    summary TEXT NOT NULL                     -- one plain sentence, no secrets
);
CREATE INDEX IF NOT EXISTS idx_sec_audit_project ON security_audit(project_id, id);

CREATE TABLE IF NOT EXISTS security_project_settings (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    testing_type TEXT NOT NULL,               -- functional | security | both
    updated_at TEXT NOT NULL
);
`;

const ensured = new WeakSet<Db>();
/** The migration slot creates the tables; this also covers a database opened by code that registered the slot later. */
export function ensureSecurityTables(db: Db): void {
    if (ensured.has(db)) return;
    db.raw.exec(SECURITY_MIGRATION);
    // Round 20 (SIGN, slot 33): the sign-in, sensitive workflows and API document tables (extras.ts).
    ensureExtrasTables(db);
    // Round (SCAN): the scanner run and project scanner tables, plus the additive approval column on an assessment that predates them.
    ensureScannerTables(db);
    ensured.add(db);
}

const stores = new WeakMap<Db, SecurityStore>();
/** One store per database (cheap; the cache only saves the table check). */
export function securityStoreFor(db: Db): SecurityStore {
    let s = stores.get(db);
    if (!s) stores.set(db, (s = new SecurityStore(db)));
    return s;
}

// ── limits (everything that comes from people or apps is capped) ──────────────────────────────────────────────────────────────────────
export const SECURITY_LIMITS = {
    applicationsPerProject: 200,
    nameMax: 120,
    urlMax: 2000,
    scopeEntries: 50,
    scopeEntryMax: 255,
    excludedPaths: 100,
    excludedPathMax: 500,
    notesMax: 4000,
    rpsMin: 1,
    rpsMax: 10,
    rpsDefault: 2,
    authorizationsPerApplication: 500,
    approverNameMax: 200,
    emailMax: 254,
    documentReferenceMax: 500,
    restrictionsMax: 2000,
    findingTextMax: 8000,
    findingTitleMax: 300,
    locationMax: 2000,
    evidenceItems: 20,
    evidenceValueMax: 4000,
    commentMax: 2000,
    findingsPerApplication: 5000,
} as const;

export const TESTING_TYPES = ["functional", "security", "both"] as const;
export type TestingType = (typeof TESTING_TYPES)[number];

// ── inputs ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface ApplicationInput {
    name: string;
    targetUrl: string;
    environment: SecurityEnvironment;
    scope?: string[];
    excludedPaths?: string[];
    maxRequestsPerSecond?: number;
    apiSpecUrl?: string | null;
    notes?: string | null;
    /** Round 20 (SIGN): kept in extras.ts's table. */
    signInAccount?: string | null;
    sensitiveWorkflows?: SensitiveWorkflow[];
}
export type ApplicationPatch = Partial<ApplicationInput>;

export interface AuthorizationInput {
    basis: SecurityAuthorization["basis"];
    approverName: string;
    approverEmail?: string | null;
    documentReference?: string | null;
    restrictions?: string | null;
    /** The sentence shown to the person and confirmed (authorization.ts `authorizationStatement`). */
    statement: string;
    confirmedByUserId?: string | null;
    confirmedByName: string;
}

export interface AssessmentPatch {
    state?: AssessmentState;
    progress?: number;
    progressText?: string;
    coverage?: SecurityAssessment["coverage"];
    error?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
}

export interface AssessmentFilter {
    projectId?: string;
    applicationId?: string;
    states?: AssessmentState[];
    limit?: number;
    /** Only assessments created before this ISO time (paging). */
    before?: string;
}

/** What FIND's ingest (or the manual entry route) hands to the store. Already redacted. */
export interface FindingInput {
    projectId: string;
    applicationId: string;
    /** The assessment that saw it (null for a manual finding). */
    assessmentId: string | null;
    fingerprint: string;
    checkId?: string | null;
    title: string;
    category: FindingCategory;
    severity: Severity;
    confidence: Confidence;
    location: string;
    description: string;
    impact: string;
    remediation: string;
    reproduction?: string | null;
    evidence: Evidence[];
    source: SecurityFinding["source"];
    aiNote?: string | null;
    /** The state a NEW finding starts in (default needs-review). An existing finding keeps the state people gave it. */
    initialValidation?: ValidationState;
    /** When it was seen (default now). */
    seenAt?: string;
}

export interface FindingFilter {
    projectId: string;
    applicationId?: string;
    severities?: Severity[];
    categories?: FindingCategory[];
    validations?: ValidationState[];
    /** Last seen on or after / on or before (ISO). */
    from?: string;
    to?: string;
    /** Text contained in the location. */
    location?: string;
    /** Text contained in the title, description or location. */
    q?: string;
    source?: SecurityFinding["source"];
    lastAssessmentId?: string;
    limit?: number;
    offset?: number;
}

export interface FindingHistoryEntry {
    id: number;
    at: string;
    actor: string;
    actorId: string | null;
    from: ValidationState | null;
    to: ValidationState | null;
    comment: string | null;
    assessmentId: string | null;
}

export const SECURITY_AUDIT_ACTIONS = [
    "application.created",
    "application.changed",
    "application.deleted",
    "authorization.recorded",
    "authorization.revoked",
    "assessment.started",
    "assessment.cancelled",
    "assessment.stopped",
    "assessment.finished",
    "finding.created",
    "finding.validation-changed",
    "report.exported",
    "testing-type.changed",
    "retention.pruned",
    // Round 20 (SIGN): the uploaded API document and a saved sign-in uploaded from the security section.
    "api-document.uploaded",
    "api-document.removed",
    "sign-in.saved",
    // Round 20 (OPS): the project's assessment messages, and security data restored from a project backup.
    "notifications.changed",
    // Round (SCAN): which external scanners this project is allowed to use. A run itself is recorded with its assessment.
    "scanners.changed",
    "project.restored",
    // Round 21: a project backup downloaded without its security data (for a platform from before round 20).
    "project.backup-without-security",
] as const;
export type SecurityAuditAction = (typeof SECURITY_AUDIT_ACTIONS)[number];

export interface SecurityAuditEvent {
    projectId: string;
    applicationId?: string | null;
    action: SecurityAuditAction;
    objectType: "application" | "authorization" | "assessment" | "finding" | "report" | "project" | "retention";
    objectId?: string | null;
    /** One plain sentence without secrets ("Added the application “Shop” (https://shop.example.com)."). */
    summary: string;
}

export interface SecurityAuditRow extends SecurityAuditEvent {
    id: number;
    at: string;
    actor: { kind: string; id: string | null; name: string };
}

const nowIso = () => new Date().toISOString();
const json = <T>(s: string | null | undefined, fallback: T): T => {
    if (!s) return fallback;
    try {
        return JSON.parse(s) as T;
    } catch {
        return fallback;
    }
};
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
/** A stored profile. An unreadable or older value reads back as "passive", which is what every assessment before this change was. */
const isKind = (s: unknown): s is SecurityAssessment["kind"] => typeof s === "string" && (ASSESSMENT_KINDS as readonly string[]).includes(s);
const clipOrNull = (s: string | null | undefined, n: number) => (s == null || s === "" ? null : clip(s, n));
/** LIKE pattern for "contains", with the wildcards in the input escaped. */
const contains = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const appOf = (r: Row): SecurityApplication => ({
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    targetUrl: r.target_url,
    environment: r.environment,
    scope: json<string[]>(r.scope_json, []),
    excludedPaths: json<string[]>(r.excluded_paths_json, []),
    maxRequestsPerSecond: r.max_rps,
    apiSpecUrl: r.api_spec_url ?? null,
    notes: r.notes ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
});

/** The contract shape, plus the confirmed sentence and who revoked it (additive fields). */
export type StoredAuthorization = SecurityAuthorization & { statement: string; revokedBy: string | null; revokedReason: string | null };

const authOf = (r: Row): StoredAuthorization => ({
    id: r.id,
    applicationId: r.application_id,
    basis: r.basis,
    approverName: r.approver_name,
    approverEmail: r.approver_email ?? null,
    documentReference: r.document_reference ?? null,
    restrictions: r.restrictions ?? null,
    confirmedByUserId: r.confirmed_by_user_id ?? null,
    confirmedByName: r.confirmed_by_name,
    confirmedAt: r.confirmed_at,
    scopeFingerprint: r.scope_fingerprint,
    revokedAt: r.revoked_at ?? null,
    statement: r.statement,
    revokedBy: r.revoked_by ?? null,
    revokedReason: r.revoked_reason ?? null,
});

const assessmentOf = (r: Row): SecurityAssessment & { cancelRequested: boolean } => ({
    id: r.id,
    applicationId: r.application_id,
    projectId: r.project_id,
    authorizationId: r.authorization_id,
    kind: isKind(r.kind) ? r.kind : "passive",
    approval: json<SecurityAssessment["approval"]>(r.approval_json, null),
    state: r.state,
    progress: r.progress,
    progressText: r.progress_text,
    coverage: json<SecurityAssessment["coverage"]>(r.coverage_json, null),
    error: r.error ?? null,
    startedBy: r.started_by,
    createdAt: r.created_at,
    startedAt: r.started_at ?? null,
    finishedAt: r.finished_at ?? null,
    retestOf: r.retest_of ?? null,
    cancelRequested: r.cancel_requested === 1,
});

const findingOf = (r: Row): SecurityFinding & { checkId: string | null } => ({
    id: r.id,
    projectId: r.project_id,
    applicationId: r.application_id,
    firstAssessmentId: r.first_assessment_id ?? null,
    lastAssessmentId: r.last_assessment_id ?? null,
    fingerprint: r.fingerprint,
    checkId: r.check_id ?? null,
    title: r.title,
    category: r.category,
    severity: r.severity,
    confidence: r.confidence,
    location: r.location,
    description: r.description,
    impact: r.impact,
    remediation: r.remediation,
    reproduction: r.reproduction ?? null,
    evidence: json<Evidence[]>(r.evidence_json, []),
    source: r.source,
    aiNote: r.ai_note ?? null,
    validation: r.validation,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
});

const capEvidence = (ev: Evidence[]): Evidence[] =>
    ev.slice(0, SECURITY_LIMITS.evidenceItems).map((e) => ({ kind: e.kind, label: clip(String(e.label), 200), value: clip(String(e.value), SECURITY_LIMITS.evidenceValueMax), observedAt: e.observedAt }));

const FINISHED_SQL = FINISHED_STATES.map((s) => `'${s}'`).join(",");

export class SecurityStore {
    constructor(private readonly db: Db) {
        ensureSecurityTables(db);
    }

    // ── applications ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    createApplication(projectId: string, input: ApplicationInput): SecurityApplication {
        const id = randomUUID();
        const at = nowIso();
        this.db.run(
            "INSERT INTO security_applications (id, project_id, name, target_url, environment, scope_json, excluded_paths_json, max_rps, api_spec_url, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            id,
            projectId,
            input.name,
            input.targetUrl,
            input.environment,
            JSON.stringify(input.scope ?? []),
            JSON.stringify(input.excludedPaths ?? []),
            input.maxRequestsPerSecond ?? SECURITY_LIMITS.rpsDefault,
            input.apiSpecUrl ?? null,
            input.notes ?? null,
            at,
            at,
        );
        writeExtras(this.db, id, { signInAccount: input.signInAccount, sensitiveWorkflows: input.sensitiveWorkflows });
        return this.getApplication(id)!;
    }

    /** Round 20 (SIGN): the saved sign-in, the sensitive workflows and the API document summary (extras.ts). */
    private withExtras(a: SecurityApplication): SecurityApplication {
        const x = readExtras(this.db, a.id);
        return { ...a, signInAccount: x.signInAccount, sensitiveWorkflows: x.sensitiveWorkflows, apiDocument: apiDocumentSummary(this.db, a.id) };
    }

    getApplication(id: string): SecurityApplication | undefined {
        const r = this.db.get("SELECT * FROM security_applications WHERE id = ?", id);
        return r ? this.withExtras(appOf(r)) : undefined;
    }

    listApplications(projectId: string): SecurityApplication[] {
        return this.db.all("SELECT * FROM security_applications WHERE project_id = ? ORDER BY created_at, id", projectId).map((r) => this.withExtras(appOf(r)));
    }

    countApplications(projectId: string): number {
        return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM security_applications WHERE project_id = ?", projectId)?.n ?? 0;
    }

    updateApplication(id: string, patch: ApplicationPatch): SecurityApplication | undefined {
        const cur = this.getApplication(id);
        if (!cur) return undefined;
        const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as SecurityApplication;
        this.db.run(
            "UPDATE security_applications SET name = ?, target_url = ?, environment = ?, scope_json = ?, excluded_paths_json = ?, max_rps = ?, api_spec_url = ?, notes = ?, updated_at = ? WHERE id = ?",
            next.name,
            next.targetUrl,
            next.environment,
            JSON.stringify(next.scope),
            JSON.stringify(next.excludedPaths),
            next.maxRequestsPerSecond,
            next.apiSpecUrl ?? null,
            next.notes ?? null,
            nowIso(),
            id,
        );
        writeExtras(this.db, id, { signInAccount: patch.signInAccount, sensitiveWorkflows: patch.sensitiveWorkflows });
        return this.getApplication(id);
    }

    /** Removes the application with its authorizations, assessments and findings (the audit trail stays). */
    deleteApplication(id: string): boolean {
        return Number(this.db.run("DELETE FROM security_applications WHERE id = ?", id).changes) > 0;
    }

    // ── authorizations ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    /** Records a confirmation for the application as it is now; earlier unrevoked ones are revoked ("replaced by a newer one"). */
    addAuthorization(appId: string, input: AuthorizationInput): StoredAuthorization {
        const app = this.getApplication(appId);
        if (!app) throw new Error(`Unknown application ${appId}`);
        const id = randomUUID();
        const at = nowIso();
        this.db.tx(() => {
            this.db.run(
                "UPDATE security_authorizations SET revoked_at = ?, revoked_by = ?, revoked_reason = ? WHERE application_id = ? AND revoked_at IS NULL",
                at,
                clip(input.confirmedByName, 200),
                "Replaced by a newer authorization.",
                appId,
            );
            this.db.run(
                "INSERT INTO security_authorizations (id, application_id, basis, approver_name, approver_email, document_reference, restrictions, statement, confirmed_by_user_id, confirmed_by_name, confirmed_at, scope_fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                id,
                appId,
                input.basis,
                input.approverName,
                input.approverEmail ?? null,
                input.documentReference ?? null,
                input.restrictions ?? null,
                input.statement,
                input.confirmedByUserId ?? null,
                clip(input.confirmedByName, 200),
                at,
                scopeFingerprint(app),
            );
        });
        return this.getAuthorization(id)!;
    }

    getAuthorization(id: string): StoredAuthorization | undefined {
        const r = this.db.get("SELECT * FROM security_authorizations WHERE id = ?", id);
        return r ? authOf(r) : undefined;
    }

    /** Newest first. */
    listAuthorizations(appId: string): StoredAuthorization[] {
        return this.db.all(`SELECT * FROM security_authorizations WHERE application_id = ? ORDER BY confirmed_at DESC, ${this.db.dialect.insertionOrder()} DESC`, appId).map(authOf);
    }

    countAuthorizations(appId: string): number {
        return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM security_authorizations WHERE application_id = ?", appId)?.n ?? 0;
    }

    revokeAuthorization(id: string, by: string, reason = "Revoked."): StoredAuthorization | undefined {
        this.db.run("UPDATE security_authorizations SET revoked_at = ?, revoked_by = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL", nowIso(), clip(by, 200), clip(reason, 300), id);
        return this.getAuthorization(id);
    }

    /** The authorization an assessment may start under: not revoked, and recorded for the target, scope, exclusions and rate it has now. */
    currentAuthorization(app: SecurityApplication): StoredAuthorization | undefined {
        const fp = scopeFingerprint(app);
        const r = this.db.get(`SELECT * FROM security_authorizations WHERE application_id = ? AND revoked_at IS NULL AND scope_fingerprint = ? ORDER BY confirmed_at DESC, ${this.db.dialect.insertionOrder()} DESC LIMIT 1`, app.id, fp);
        return r ? authOf(r) : undefined;
    }

    /** "current" | "stale" | "revoked" | "none", with the plain sentence the API and the UI show. */
    authorizationState(app: SecurityApplication): AuthorizationState {
        return authorizationStateOf(app, this.listAuthorizations(app.id)[0]);
    }

    // ── assessments ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    createAssessment(input: { applicationId: string; authorizationId: string; startedBy: string; retestOf?: string | null; progressText?: string }): SecurityAssessment {
        const app = this.getApplication(input.applicationId);
        if (!app) throw new Error(`Unknown application ${input.applicationId}`);
        const id = randomUUID();
        this.db.run(
            "INSERT INTO security_assessments (id, application_id, project_id, authorization_id, kind, state, progress, progress_text, started_by, created_at, retest_of) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            id,
            app.id,
            app.projectId,
            input.authorizationId,
            "passive",
            "QUEUED",
            0,
            input.progressText ?? "Waiting to start.",
            clip(input.startedBy, 200),
            nowIso(),
            input.retestOf ?? null,
        );
        return this.getAssessment(id)!;
    }

    getAssessment(id: string): (SecurityAssessment & { cancelRequested: boolean }) | undefined {
        const r = this.db.get("SELECT * FROM security_assessments WHERE id = ?", id);
        return r ? assessmentOf(r) : undefined;
    }

    /** Newest first. */
    listAssessments(f: AssessmentFilter): Array<SecurityAssessment & { cancelRequested: boolean }> {
        const where: string[] = [];
        const vals: Array<string | number> = [];
        if (f.projectId) (where.push("project_id = ?"), vals.push(f.projectId));
        if (f.applicationId) (where.push("application_id = ?"), vals.push(f.applicationId));
        if (f.states?.length) (where.push(`state IN (${f.states.map(() => "?").join(",")})`), vals.push(...f.states));
        if (f.before) (where.push("created_at < ?"), vals.push(f.before));
        const limit = Math.max(1, Math.min(500, f.limit ?? 50));
        return this.db.all(`SELECT * FROM security_assessments ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, ${this.db.dialect.insertionOrder()} DESC LIMIT ?`, ...vals, limit).map(assessmentOf);
    }

    updateAssessment(id: string, patch: AssessmentPatch): (SecurityAssessment & { cancelRequested: boolean }) | undefined {
        const sets: string[] = [];
        const vals: Array<string | number | null> = [];
        if (patch.state !== undefined) (sets.push("state = ?"), vals.push(patch.state));
        if (patch.progress !== undefined) (sets.push("progress = ?"), vals.push(Math.max(0, Math.min(100, Math.round(patch.progress)))));
        if (patch.progressText !== undefined) (sets.push("progress_text = ?"), vals.push(clip(patch.progressText, 500)));
        if (patch.coverage !== undefined) (sets.push("coverage_json = ?"), vals.push(patch.coverage === null ? null : JSON.stringify(patch.coverage)));
        if (patch.error !== undefined) (sets.push("error = ?"), vals.push(patch.error === null ? null : clip(patch.error, 2000)));
        if (patch.startedAt !== undefined) (sets.push("started_at = ?"), vals.push(patch.startedAt));
        if (patch.finishedAt !== undefined) (sets.push("finished_at = ?"), vals.push(patch.finishedAt));
        if (sets.length) this.db.run(`UPDATE security_assessments SET ${sets.join(", ")} WHERE id = ?`, ...vals, id);
        return this.getAssessment(id);
    }

    /** The application's assessment that has not finished yet (at most one is allowed; RUN enforces it when starting). */
    activeAssessment(appId: string): (SecurityAssessment & { cancelRequested: boolean }) | undefined {
        const r = this.db.get(`SELECT * FROM security_assessments WHERE application_id = ? AND state NOT IN (${FINISHED_SQL}) ORDER BY created_at DESC LIMIT 1`, appId);
        return r ? assessmentOf(r) : undefined;
    }

    activeAssessments(projectId: string): Array<SecurityAssessment & { cancelRequested: boolean }> {
        return this.db.all(`SELECT * FROM security_assessments WHERE project_id = ? AND state NOT IN (${FINISHED_SQL}) ORDER BY created_at`, projectId).map(assessmentOf);
    }

    /**
     * Takes the oldest assessment that is queued, or unfinished with an expired lease (its loop died), for `owner` until now + leaseMs.
     * Atomic (one UPDATE … WHERE): two loops never get the same one. Returns undefined when there is nothing to do.
     */
    claimAssessment(owner: string, leaseMs: number, now = Date.now()): (SecurityAssessment & { cancelRequested: boolean }) | undefined {
        return this.db.tx(() => {
            const r = this.db.get<{ id: string }>(
                `SELECT id FROM security_assessments WHERE state NOT IN (${FINISHED_SQL}) AND (lease_until IS NULL OR lease_until < ?) ORDER BY created_at LIMIT 1`,
                now,
            );
            if (!r) return undefined;
            const changed = this.db.run(
                `UPDATE security_assessments SET lease_owner = ?, lease_until = ?, heartbeat_at = ? WHERE id = ? AND state NOT IN (${FINISHED_SQL}) AND (lease_until IS NULL OR lease_until < ?)`,
                owner,
                now + leaseMs,
                new Date(now).toISOString(),
                r.id,
                now,
            ).changes;
            return Number(changed) > 0 ? this.getAssessment(r.id) : undefined;
        });
    }

    /** Extends the lease; false when someone else holds it now (stop working on it). */
    renewLease(id: string, owner: string, leaseMs: number, now = Date.now()): boolean {
        return Number(this.db.run("UPDATE security_assessments SET lease_until = ?, heartbeat_at = ? WHERE id = ? AND lease_owner = ?", now + leaseMs, new Date(now).toISOString(), id, owner).changes) > 0;
    }

    releaseLease(id: string, owner: string): void {
        this.db.run("UPDATE security_assessments SET lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ?", id, owner);
    }

    /** Asks the loop running it to stop (cancel, emergency stop, a revoked authorization). False when it had already finished. */
    requestCancel(id: string): boolean {
        return Number(this.db.run(`UPDATE security_assessments SET cancel_requested = 1 WHERE id = ? AND state NOT IN (${FINISHED_SQL})`, id).changes) > 0;
    }

    cancelRequested(id: string): boolean {
        return this.db.get<{ c: number }>("SELECT cancel_requested AS c FROM security_assessments WHERE id = ?", id)?.c === 1;
    }

    getWorkData<T = unknown>(id: string): T | undefined {
        const r = this.db.get<{ w: string | null }>("SELECT work_json AS w FROM security_assessments WHERE id = ?", id);
        return r?.w ? json<T | undefined>(r.w, undefined) : undefined;
    }

    setWorkData(id: string, value: unknown): void {
        this.db.run("UPDATE security_assessments SET work_json = ? WHERE id = ?", value === undefined ? null : JSON.stringify(value), id);
    }

    // ── findings ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    /**
     * Insert, or update the finding with the same application + fingerprint: latest wording, severity and evidence, last seen and last
     * assessment. `validation` is only set for a new finding (people own it after that). Records a sighting when an assessment is given.
     */
    upsertFinding(input: FindingInput): { finding: SecurityFinding & { checkId: string | null }; created: boolean } {
        const at = input.seenAt ?? nowIso();
        const evidence = JSON.stringify(capEvidence(input.evidence));
        const L = SECURITY_LIMITS;
        return this.db.tx(() => {
            const existing = this.db.get<{ id: string }>("SELECT id FROM security_findings WHERE application_id = ? AND fingerprint = ?", input.applicationId, input.fingerprint);
            let id: string;
            if (existing) {
                id = existing.id;
                this.db.run(
                    "UPDATE security_findings SET title = ?, category = ?, severity = ?, confidence = ?, location = ?, description = ?, impact = ?, remediation = ?, reproduction = ?, evidence_json = ?, ai_note = COALESCE(?, ai_note), check_id = COALESCE(?, check_id), last_seen_at = ?, last_assessment_id = COALESCE(?, last_assessment_id), updated_at = ? WHERE id = ?",
                    clip(input.title, L.findingTitleMax),
                    input.category,
                    input.severity,
                    input.confidence,
                    clip(input.location, L.locationMax),
                    clip(input.description, L.findingTextMax),
                    clip(input.impact, L.findingTextMax),
                    clip(input.remediation, L.findingTextMax),
                    clipOrNull(input.reproduction, L.findingTextMax),
                    evidence,
                    clipOrNull(input.aiNote, L.findingTextMax),
                    input.checkId ?? null,
                    at,
                    input.assessmentId,
                    nowIso(),
                    id,
                );
            } else {
                id = randomUUID();
                this.db.run(
                    "INSERT INTO security_findings (id, project_id, application_id, first_assessment_id, last_assessment_id, fingerprint, check_id, title, category, severity, confidence, location, description, impact, remediation, reproduction, evidence_json, source, ai_note, validation, first_seen_at, last_seen_at, created_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    id,
                    input.projectId,
                    input.applicationId,
                    input.assessmentId,
                    input.assessmentId,
                    input.fingerprint,
                    input.checkId ?? null,
                    clip(input.title, L.findingTitleMax),
                    input.category,
                    input.severity,
                    input.confidence,
                    clip(input.location, L.locationMax),
                    clip(input.description, L.findingTextMax),
                    clip(input.impact, L.findingTextMax),
                    clip(input.remediation, L.findingTextMax),
                    clipOrNull(input.reproduction, L.findingTextMax),
                    evidence,
                    input.source,
                    clipOrNull(input.aiNote, L.findingTextMax),
                    input.initialValidation ?? "needs-review",
                    at,
                    at,
                    input.source === "manual" ? actorLabel() : null,
                    nowIso(),
                );
            }
            if (input.assessmentId) this.recordSighting(id, input.assessmentId, input.evidence, at);
            return { finding: this.getFinding(id)!, created: !existing };
        });
    }

    getFinding(id: string): (SecurityFinding & { checkId: string | null }) | undefined {
        const r = this.db.get("SELECT * FROM security_findings WHERE id = ?", id);
        return r ? findingOf(r) : undefined;
    }

    findingByFingerprint(appId: string, fingerprint: string): (SecurityFinding & { checkId: string | null }) | undefined {
        const r = this.db.get("SELECT * FROM security_findings WHERE application_id = ? AND fingerprint = ?", appId, fingerprint);
        return r ? findingOf(r) : undefined;
    }

    private findingWhere(f: FindingFilter): { sql: string; vals: Array<string | number> } {
        const where: string[] = ["project_id = ?"];
        const vals: Array<string | number> = [f.projectId];
        const inList = (col: string, xs?: readonly string[]) => {
            if (xs?.length) (where.push(`${col} IN (${xs.map(() => "?").join(",")})`), vals.push(...xs));
        };
        if (f.applicationId) (where.push("application_id = ?"), vals.push(f.applicationId));
        inList("severity", f.severities);
        inList("category", f.categories);
        inList("validation", f.validations);
        if (f.source) (where.push("source = ?"), vals.push(f.source));
        if (f.lastAssessmentId) (where.push("last_assessment_id = ?"), vals.push(f.lastAssessmentId));
        if (f.from) (where.push("last_seen_at >= ?"), vals.push(f.from));
        if (f.to) (where.push("last_seen_at <= ?"), vals.push(f.to));
        if (f.location) (where.push(`${this.db.dialect.likeInsensitive("location")} ESCAPE '\\'`), vals.push(contains(f.location.slice(0, 500))));
        if (f.q) {
            const p = contains(f.q.slice(0, 500));
            where.push(`(${this.db.dialect.likeInsensitive("title")} ESCAPE '\\' OR ${this.db.dialect.likeInsensitive("description")} ESCAPE '\\' OR ${this.db.dialect.likeInsensitive("location")} ESCAPE '\\')`);
            vals.push(p, p, p);
        }
        return { sql: `WHERE ${where.join(" AND ")}`, vals };
    }

    /** Most severe first, then most recently seen. */
    listFindings(f: FindingFilter): Array<SecurityFinding & { checkId: string | null }> {
        const { sql, vals } = this.findingWhere(f);
        const limit = Math.max(1, Math.min(1000, f.limit ?? 200));
        const offset = Math.max(0, f.offset ?? 0);
        return this.db
            .all(
                `SELECT * FROM security_findings ${sql} ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, last_seen_at DESC, id LIMIT ? OFFSET ?`,
                ...vals,
                limit,
                offset,
            )
            .map(findingOf);
    }

    countFindings(f: FindingFilter): number {
        const { sql, vals } = this.findingWhere(f);
        return this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM security_findings ${sql}`, ...vals)?.n ?? 0;
    }

    countFindingsOfApplication(appId: string): number {
        return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM security_findings WHERE application_id = ?", appId)?.n ?? 0;
    }

    /** Changes the validation state and keeps the change (who, when, from, to, comment) in the finding's history. */
    setValidation(id: string, validation: ValidationState, opts: { comment?: string | null; assessmentId?: string | null } = {}): (SecurityFinding & { checkId: string | null }) | undefined {
        const cur = this.getFinding(id);
        if (!cur) return undefined;
        const actor = currentActor();
        this.db.tx(() => {
            this.db.run("UPDATE security_findings SET validation = ?, updated_at = ? WHERE id = ?", validation, nowIso(), id);
            this.db.run(
                "INSERT INTO security_finding_history (finding_id, at, actor, actor_id, from_validation, to_validation, comment, assessment_id) VALUES (?,?,?,?,?,?,?,?)",
                id,
                nowIso(),
                actorLabel(actor),
                actor.id ?? null,
                cur.validation,
                validation,
                clipOrNull(opts.comment, SECURITY_LIMITS.commentMax),
                opts.assessmentId ?? null,
            );
        });
        return this.getFinding(id);
    }

    /** A history line without a state change ("Still present in retest …"). */
    addFindingNote(id: string, comment: string, assessmentId: string | null = null): void {
        const actor = currentActor();
        this.db.run(
            "INSERT INTO security_finding_history (finding_id, at, actor, actor_id, from_validation, to_validation, comment, assessment_id) VALUES (?,?,?,?,?,?,?,?)",
            id,
            nowIso(),
            actorLabel(actor),
            actor.id ?? null,
            null,
            null,
            clip(comment, SECURITY_LIMITS.commentMax),
            assessmentId,
        );
    }

    /** Oldest first. */
    findingHistory(id: string): FindingHistoryEntry[] {
        return this.db
            .all("SELECT * FROM security_finding_history WHERE finding_id = ? ORDER BY id", id)
            .map((r) => ({ id: r.id, at: r.at, actor: r.actor, actorId: r.actor_id ?? null, from: r.from_validation ?? null, to: r.to_validation ?? null, comment: r.comment ?? null, assessmentId: r.assessment_id ?? null }));
    }

    recordSighting(findingId: string, assessmentId: string, evidence: Evidence[], at = nowIso()): void {
        this.db.run(
            "INSERT INTO security_finding_sightings (finding_id, assessment_id, seen_at, evidence_json) VALUES (?,?,?,?) ON CONFLICT(finding_id, assessment_id) DO UPDATE SET seen_at = excluded.seen_at, evidence_json = excluded.evidence_json",
            findingId,
            assessmentId,
            at,
            JSON.stringify(capEvidence(evidence)),
        );
    }

    /** What one assessment saw: finding ids with the evidence as observed in that assessment. */
    sightingsOf(assessmentId: string): Array<{ findingId: string; seenAt: string; evidence: Evidence[] }> {
        return this.db
            .all("SELECT finding_id, seen_at, evidence_json FROM security_finding_sightings WHERE assessment_id = ? ORDER BY seen_at", assessmentId)
            .map((r) => ({ findingId: r.finding_id, seenAt: r.seen_at, evidence: json<Evidence[]>(r.evidence_json, []) }));
    }

    findingIdsSeenIn(assessmentId: string): Set<string> {
        return new Set(this.db.all<{ finding_id: string }>("SELECT finding_id FROM security_finding_sightings WHERE assessment_id = ?", assessmentId).map((r) => r.finding_id));
    }

    // ── audit ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    /** The security trail row only. Prefer `recordSecurityEvent` (./audit.ts), which also lists it in the platform's Activity. */
    addAudit(e: SecurityAuditEvent): number {
        const actor = currentActor();
        return Number(
            this.db.get<{ id: number }>(
                "INSERT INTO security_audit (at, project_id, application_id, actor_kind, actor_id, actor_name, action, object_type, object_id, summary) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id",
                nowIso(),
                e.projectId,
                e.applicationId ?? null,
                actor.kind,
                actor.id ?? null,
                clip(actor.name, 200),
                e.action,
                e.objectType,
                e.objectId ?? null,
                clip(e.summary, 1000),
            )!.id,
        );
    }

    /** Newest first. */
    listAudit(projectId: string, f: { limit?: number; before?: number; applicationId?: string; action?: string } = {}): SecurityAuditRow[] {
        const where = ["project_id = ?"];
        const vals: Array<string | number> = [projectId];
        if (f.before) (where.push("id < ?"), vals.push(f.before));
        if (f.applicationId) (where.push("application_id = ?"), vals.push(f.applicationId));
        if (f.action) (where.push("action = ?"), vals.push(f.action));
        const limit = Math.max(1, Math.min(200, f.limit ?? 50));
        return this.db.all(`SELECT * FROM security_audit WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`, ...vals, limit).map((r) => ({
            id: r.id,
            at: r.at,
            projectId: r.project_id,
            applicationId: r.application_id ?? null,
            actor: { kind: r.actor_kind, id: r.actor_id ?? null, name: r.actor_name },
            action: r.action,
            objectType: r.object_type,
            objectId: r.object_id ?? null,
            summary: r.summary,
        }));
    }

    // ── per-project settings ───────────────────────────────────────────────────────────────────────────────────────────────────────────
    /** "functional" when never set. */
    testingType(projectId: string): TestingType {
        const t = this.db.get<{ t: string }>("SELECT testing_type AS t FROM security_project_settings WHERE project_id = ?", projectId)?.t;
        return (TESTING_TYPES as readonly string[]).includes(t ?? "") ? (t as TestingType) : "functional";
    }

    setTestingType(projectId: string, type: TestingType): void {
        this.db.run(
            "INSERT INTO security_project_settings (project_id, testing_type, updated_at) VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET testing_type = excluded.testing_type, updated_at = excluded.updated_at",
            projectId,
            type,
            nowIso(),
        );
    }

    // ── retention ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    /**
     * Removes finished assessments older than `retentionDays` (by when they finished) with their per-assessment evidence (sightings).
     * Findings stay, with their latest evidence; their first/last assessment links become empty. Running assessments are never touched.
     * Returns the counts per project (for the audit line).
     */
    prune(retentionDays: number, now = Date.now()): { assessments: number; sightings: number; byProject: Record<string, number> } {
        const cutoff = new Date(now - retentionDays * 86_400_000).toISOString();
        return this.db.tx(() => {
            const rows = this.db.all<{ id: string; project_id: string }>(`SELECT id, project_id FROM security_assessments WHERE state IN (${FINISHED_SQL}) AND finished_at IS NOT NULL AND finished_at < ?`, cutoff);
            if (!rows.length) return { assessments: 0, sightings: 0, byProject: {} };
            const ids = rows.map((r) => r.id);
            let sightings = 0;
            const byProject: Record<string, number> = {};
            for (const r of rows) byProject[r.project_id] = (byProject[r.project_id] ?? 0) + 1;
            for (let i = 0; i < ids.length; i += 200) {
                const chunk = ids.slice(i, i + 200);
                const marks = chunk.map(() => "?").join(",");
                sightings += Number(this.db.run(`DELETE FROM security_finding_sightings WHERE assessment_id IN (${marks})`, ...chunk).changes);
                this.db.run(`UPDATE security_assessments SET retest_of = NULL WHERE retest_of IN (${marks})`, ...chunk);
                this.db.run(`DELETE FROM security_assessments WHERE id IN (${marks})`, ...chunk);
            }
            return { assessments: ids.length, sightings, byProject };
        });
    }
}
