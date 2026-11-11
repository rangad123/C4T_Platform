/**
 * The Security Assessment part of a project backup (Storage and backup, `GET /api/projects/:id/backup`, restore with
 * `POST /api/projects/restore`): one document, `security.json`, in the project's zip. src/platform/backup.ts calls these four:
 *
 *   exportSecurityData(db, projectId)   the document, its counts and what must be entered again; undefined for a project without
 *                                       security data (its backup then looks exactly as before)
 *   SecurityBackupSchema / securityBackupProblem(doc)   reading and checking an untrusted document before anything is created
 *   importSecurityData(db, newProjectId, doc)           writes it into the NEW project (synchronous: part of the restore's one stretch)
 *   forgetSecurityData(db, projectId)                   what a failed restore must remove besides the project row (the trail has no foreign key)
 *
 * What travels: the testing type, the assessment-message setting, applications (with sensitive workflows, the name of the saved sign-in
 * they use and the uploaded API document), every authorization record (the exact statement, approver, basis, document reference,
 * restrictions, who confirmed it and when, revocation), assessments (state, coverage, timestamps, the retest link), findings with their
 * evidence, validation history and sightings, and the module's audit trail. Ids are replaced by references inside the document and new
 * ids are made on restore.
 * What never travels: secrets. Evidence was redacted when it was stored and is redacted again on restore (a backup is a file someone may
 * have edited); the saved signed-in state itself (cookies, tokens) is not in a backup, only the account's name, and the restore lists it as
 * something to enter again; alert channels are not in a backup (their addresses are secrets), so chosen channels are dropped.
 *
 * On restore, nothing runs and nothing is authorized: authorizations come back as history and are marked withdrawn ("Restored from a
 * backup: record a new authorization before the next assessment"), and an assessment that had not finished comes back cancelled.
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../platform/http-error.js";
import type { Db, Row } from "../platform/db.js";
import { recordSecurityEvent, SECURITY_ACTIVITY_PREFIX } from "./audit.js";
import { currentActor } from "../platform/auth/actor.js";
import { UserStore } from "../platform/user-store.js";
import { ASSESSMENT_STATES, CATEGORIES, CONFIDENCES, ENVIRONMENTS, FINISHED_STATES, SEVERITIES, VALIDATION_STATES } from "./contract.js";
import { apiDocumentText, EXTRAS_LIMITS, saveApiDocument, writeExtras } from "./extras.js";
import { redactEvidence, redactText } from "./findings/redact.js";
import { forgetNotificationSettings, notificationSettings, saveNotificationSettings } from "./notify.js";
import { SECURITY_LIMITS as L, securityStoreFor, TESTING_TYPES } from "./store.js";

/** Caps on what one project's security document may hold (export keeps the newest within them; restore refuses more). */
export const SECURITY_BACKUP_LIMITS = {
    applications: L.applicationsPerProject,
    authorizations: 5000,
    assessments: 5000,
    findings: 20_000,
    historyPerFinding: 500,
    sightingsPerFinding: 500,
    audit: 20_000,
    /** The document as written; a project backup's JSON documents may be at most 32 MB. */
    maxBytes: 30 * 1024 * 1024,
    /** API documents' text within that. */
    apiDocumentBytes: 12 * 1024 * 1024,
} as const;
const B = SECURITY_BACKUP_LIMITS;

// ── the document ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const s = (max: number) => z.string().max(max);
const iso = s(40);
const ref = s(100).min(1);

const EvidenceDoc = z.object({ kind: z.enum(["response-header", "cookie", "status", "body-excerpt", "tls", "note"]), label: s(400), value: s(L.evidenceValueMax + 100), observedAt: iso });

const ApplicationDoc = z.object({
    ref,
    name: s(L.nameMax).min(1),
    targetUrl: s(L.urlMax).min(1),
    environment: z.enum(ENVIRONMENTS),
    scope: z.array(s(L.scopeEntryMax)).max(L.scopeEntries),
    excludedPaths: z.array(s(L.excludedPathMax)).max(L.excludedPaths),
    maxRequestsPerSecond: z.number().int().min(L.rpsMin).max(L.rpsMax),
    apiSpecUrl: s(L.urlMax).nullable(),
    notes: s(L.notesMax).nullable(),
    createdAt: iso,
    updatedAt: iso,
    signInAccount: s(200).nullable().default(null),
    sensitiveWorkflows: z
        .array(z.object({ name: s(EXTRAS_LIMITS.workflowNameMax).min(1), pathPrefixes: z.array(s(L.excludedPathMax).min(1)).max(EXTRAS_LIMITS.workflowPrefixes), note: s(EXTRAS_LIMITS.workflowNoteMax).nullable().default(null) }))
        .max(EXTRAS_LIMITS.sensitiveWorkflows)
        .default([]),
    apiDocument: z
        .object({
            fileName: s(EXTRAS_LIMITS.fileNameMax).min(1),
            format: z.enum(["json", "yaml"]),
            title: s(500).nullable(),
            version: s(200).nullable(),
            operations: z.number().int().min(0).max(1_000_000),
            requestable: z.number().int().min(0).max(1_000_000),
            uploadedBy: s(200),
            content: z.string().max(EXTRAS_LIMITS.apiDocumentBytes),
        })
        .nullable()
        .default(null),
});

const AuthorizationDoc = z.object({
    ref,
    applicationRef: ref,
    basis: z.enum(["owner", "client-permission"]),
    approverName: s(L.approverNameMax),
    approverEmail: s(L.emailMax).nullable(),
    documentReference: s(L.documentReferenceMax).nullable(),
    restrictions: s(L.restrictionsMax).nullable(),
    statement: s(20_000),
    confirmedByName: s(200),
    confirmedAt: iso,
    scopeFingerprint: s(200),
    revokedAt: iso.nullable(),
    revokedBy: s(200).nullable(),
    revokedReason: s(300).nullable(),
});

const AssessmentDoc = z.object({
    ref,
    applicationRef: ref,
    authorizationRef: ref,
    state: z.enum(ASSESSMENT_STATES),
    progress: z.number().int().min(0).max(100),
    progressText: s(500),
    coverage: z
        .object({ pagesSeen: z.number().int().min(0), formsSeen: z.number().int().min(0), apiCallsSeen: z.number().int().min(0), notInspected: z.array(s(600)).max(100) })
        .passthrough()
        .nullable(),
    error: s(2000).nullable(),
    startedBy: s(200),
    createdAt: iso,
    startedAt: iso.nullable(),
    finishedAt: iso.nullable(),
    retestOfRef: ref.nullable(),
});

const HistoryDoc = z.object({ at: iso, actor: s(300), from: z.enum(VALIDATION_STATES).nullable(), to: z.enum(VALIDATION_STATES).nullable(), comment: s(L.commentMax + 100).nullable(), assessmentRef: ref.nullable() });

const FindingDoc = z.object({
    ref,
    applicationRef: ref,
    firstAssessmentRef: ref.nullable(),
    lastAssessmentRef: ref.nullable(),
    fingerprint: s(500).min(1),
    checkId: s(200).nullable(),
    title: s(L.findingTitleMax + 100).min(1),
    category: z.enum(CATEGORIES),
    severity: z.enum(SEVERITIES),
    confidence: z.enum(CONFIDENCES),
    location: s(L.locationMax + 100),
    description: s(L.findingTextMax + 100),
    impact: s(L.findingTextMax + 100),
    remediation: s(L.findingTextMax + 100),
    reproduction: s(L.findingTextMax + 100).nullable(),
    evidence: z.array(EvidenceDoc).max(L.evidenceItems),
    source: z.enum(["built-in", "manual"]),
    aiNote: s(L.findingTextMax + 100).nullable(),
    validation: z.enum(VALIDATION_STATES),
    firstSeenAt: iso,
    lastSeenAt: iso,
    createdBy: s(300).nullable(),
    history: z.array(HistoryDoc).max(B.historyPerFinding),
    sightings: z.array(z.object({ assessmentRef: ref, seenAt: iso, evidence: z.array(EvidenceDoc).max(L.evidenceItems) })).max(B.sightingsPerFinding),
});

const AuditDoc = z.object({
    at: iso,
    applicationRef: ref.nullable(),
    actorKind: s(30),
    actorName: s(200),
    action: s(80),
    objectType: s(40),
    objectRef: ref.nullable(),
    summary: s(1100),
});

export const SecurityBackupSchema = z.object({
    format: z.literal(1),
    testingType: z.enum(TESTING_TYPES),
    notifications: z.object({ newCriticalHigh: z.boolean(), failed: z.boolean(), everyFinish: z.boolean(), channelsChosen: z.boolean().default(false) }).nullable().default(null),
    applications: z.array(ApplicationDoc).max(B.applications),
    authorizations: z.array(AuthorizationDoc).max(B.authorizations),
    assessments: z.array(AssessmentDoc).max(B.assessments),
    findings: z.array(FindingDoc).max(B.findings),
    audit: z.array(AuditDoc).max(B.audit),
    /** What the export left out to stay within the caps, in plain words (shown as restore notes). */
    omitted: z.array(s(400)).max(20).default([]),
});
export type SecurityBackupDoc = z.infer<typeof SecurityBackupSchema>;

export interface SecurityNeed {
    label: string;
    detail: string;
}

// ── export ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const json = <T>(raw: unknown, fallback: T): T => {
    if (typeof raw !== "string" || !raw) return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
};

/**
 * The project's security data as one document, or undefined when the project has none (no applications, no trail, the testing type
 * never chosen and no message setting saved). Throws a 413 HttpError when it cannot fit a project backup even without the optional parts.
 */
export function exportSecurityData(db: Db, projectId: string): { doc: SecurityBackupDoc; counts: Record<string, number>; needs: SecurityNeed[] } | undefined {
    const store = securityStoreFor(db);
    const typeSaved = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM security_project_settings WHERE project_id = ?", projectId)?.n ?? 0;
    const apps = store.listApplications(projectId);
    const auditCount = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM security_audit WHERE project_id = ?", projectId)?.n ?? 0;
    const notify = notificationSettings(db, projectId);
    if (!apps.length && !auditCount && !typeSaved && !notify.saved) return undefined;

    const omitted: string[] = [];
    const needs: SecurityNeed[] = [];
    const appRef = new Map(apps.map((a, i) => [a.id, `app-${i + 1}`]));
    let apiBudget = B.apiDocumentBytes;
    const applications = apps.map((a) => {
        let apiDocument: SecurityBackupDoc["applications"][number]["apiDocument"] = null;
        const doc = apiDocumentText(db, a.id);
        if (doc) {
            if (doc.text.length <= apiBudget) {
                apiBudget -= doc.text.length;
                apiDocument = { fileName: doc.summary.fileName, format: doc.summary.format, title: doc.summary.title, version: doc.summary.version, operations: doc.summary.operations, requestable: doc.summary.requestable, uploadedBy: doc.summary.uploadedBy, content: doc.text };
            } else omitted.push(`The API document of “${a.name.slice(0, 60)}” was too large to keep in the backup; upload it again.`);
        }
        if (a.signInAccount) needs.push({ label: `Saved sign-in “${a.signInAccount.slice(0, 60)}” for the security assessment of “${a.name.slice(0, 60)}”`, detail: "The signed-in state is not in the backup. Sign in again in Settings before a signed-in assessment." });
        return {
            ref: appRef.get(a.id)!,
            name: a.name,
            targetUrl: a.targetUrl,
            environment: a.environment,
            scope: a.scope,
            excludedPaths: a.excludedPaths,
            maxRequestsPerSecond: a.maxRequestsPerSecond,
            apiSpecUrl: a.apiSpecUrl,
            notes: a.notes,
            createdAt: a.createdAt,
            updatedAt: a.updatedAt,
            signInAccount: a.signInAccount ?? null,
            sensitiveWorkflows: (a.sensitiveWorkflows ?? []).map((w) => ({ name: w.name, pathPrefixes: w.pathPrefixes, note: w.note ?? null })),
            apiDocument,
        };
    });

    const authRows = apps.flatMap((a) => store.listAuthorizations(a.id)).slice(0, B.authorizations);
    const authRef = new Map(authRows.map((r, i) => [r.id, `auth-${i + 1}`]));
    const authorizations = authRows.map((r) => ({
        ref: authRef.get(r.id)!,
        applicationRef: appRef.get(r.applicationId)!,
        basis: r.basis,
        approverName: r.approverName,
        approverEmail: r.approverEmail,
        documentReference: r.documentReference,
        restrictions: r.restrictions,
        statement: r.statement,
        confirmedByName: r.confirmedByName,
        confirmedAt: r.confirmedAt,
        scopeFingerprint: r.scopeFingerprint,
        revokedAt: r.revokedAt,
        revokedBy: r.revokedBy,
        revokedReason: r.revokedReason,
    }));

    // Newest first within the cap; an assessment whose authorization did not make it is left out with it.
    const assessRows = db.all<Row>(`SELECT * FROM security_assessments WHERE project_id = ? ORDER BY created_at DESC, ${db.dialect.insertionOrder()} DESC LIMIT ?`, projectId, B.assessments).filter((r) => authRef.has(r.authorization_id));
    const totalAssessments = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM security_assessments WHERE project_id = ?", projectId)?.n ?? 0;
    if (totalAssessments > assessRows.length) omitted.push(`${totalAssessments - assessRows.length} older assessments were left out (a backup keeps at most ${B.assessments}); their findings are kept.`);
    const assessRef = new Map(assessRows.map((r, i) => [r.id as string, `assessment-${i + 1}`]));
    const assessments = assessRows.map((r) => ({
        ref: assessRef.get(r.id)!,
        applicationRef: appRef.get(r.application_id)!,
        authorizationRef: authRef.get(r.authorization_id)!,
        state: r.state,
        progress: r.progress,
        progressText: r.progress_text,
        coverage: json(r.coverage_json, null),
        error: r.error ?? null,
        startedBy: r.started_by,
        createdAt: r.created_at,
        startedAt: r.started_at ?? null,
        finishedAt: r.finished_at ?? null,
        retestOfRef: r.retest_of ? (assessRef.get(r.retest_of) ?? null) : null,
    }));

    const findRows = db.all<Row>("SELECT * FROM security_findings WHERE project_id = ? ORDER BY last_seen_at DESC, id LIMIT ?", projectId, B.findings);
    const totalFindings = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM security_findings WHERE project_id = ?", projectId)?.n ?? 0;
    if (totalFindings > findRows.length) omitted.push(`${totalFindings - findRows.length} findings seen longest ago were left out (a backup keeps at most ${B.findings}).`);
    const findings = findRows.map((r, i) => ({
        ref: `finding-${i + 1}`,
        applicationRef: appRef.get(r.application_id)!,
        firstAssessmentRef: r.first_assessment_id ? (assessRef.get(r.first_assessment_id) ?? null) : null,
        lastAssessmentRef: r.last_assessment_id ? (assessRef.get(r.last_assessment_id) ?? null) : null,
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
        evidence: json(r.evidence_json, []),
        source: r.source,
        aiNote: r.ai_note ?? null,
        validation: r.validation,
        firstSeenAt: r.first_seen_at,
        lastSeenAt: r.last_seen_at,
        createdBy: r.created_by ?? null,
        history: db
            .all<Row>("SELECT * FROM security_finding_history WHERE finding_id = ? ORDER BY id LIMIT ?", r.id, B.historyPerFinding)
            .map((h) => ({ at: h.at, actor: h.actor, from: h.from_validation ?? null, to: h.to_validation ?? null, comment: h.comment ?? null, assessmentRef: h.assessment_id ? (assessRef.get(h.assessment_id) ?? null) : null })),
        sightings: db
            .all<Row>("SELECT * FROM security_finding_sightings WHERE finding_id = ? ORDER BY seen_at DESC LIMIT ?", r.id, B.sightingsPerFinding)
            .filter((x) => assessRef.has(x.assessment_id))
            .map((x) => ({ assessmentRef: assessRef.get(x.assessment_id)!, seenAt: x.seen_at, evidence: json(x.evidence_json, []) })),
    }));

    // The trail: newest within the cap, written oldest first. Object ids become references where the object travels too.
    const findRef = new Map(findRows.map((r, i) => [r.id as string, `finding-${i + 1}`]));
    const objectRef = (id: string): string | null => appRef.get(id) ?? authRef.get(id) ?? assessRef.get(id) ?? findRef.get(id) ?? null;
    const auditRows = db.all<Row>("SELECT * FROM security_audit WHERE project_id = ? ORDER BY id DESC LIMIT ?", projectId, B.audit).reverse();
    if (auditCount > auditRows.length) omitted.push(`${auditCount - auditRows.length} oldest lines of the security trail were left out (a backup keeps at most ${B.audit}).`);
    const audit = auditRows.map((r) => ({
        at: r.at,
        applicationRef: r.application_id ? (appRef.get(r.application_id) ?? null) : null,
        actorKind: String(r.actor_kind).slice(0, 30),
        actorName: r.actor_name,
        action: r.action,
        objectType: r.object_type,
        objectRef: r.object_id === projectId ? "project" : r.object_id ? objectRef(r.object_id) : null,
        summary: r.summary,
    }));

    const doc: SecurityBackupDoc = {
        format: 1,
        testingType: store.testingType(projectId),
        notifications: notify.saved ? { newCriticalHigh: notify.newCriticalHigh, failed: notify.failed, everyFinish: notify.everyFinish, channelsChosen: notify.channelIds !== null } : null,
        applications,
        authorizations,
        assessments,
        findings,
        audit,
        omitted,
    };
    // Keep the document within what a restore reads: per-assessment evidence first, then the API documents, go when it is too large.
    const size = () => Buffer.byteLength(JSON.stringify(doc, null, 2)); // as the backup writes it
    if (size() > B.maxBytes) {
        for (const f of doc.findings) for (const x of f.sightings) x.evidence = [];
        doc.omitted.push("The evidence each assessment saw was left out to keep the backup small enough; every finding keeps its latest evidence.");
    }
    if (size() > B.maxBytes) {
        for (const a of doc.applications) a.apiDocument = null;
        doc.omitted.push("The uploaded API documents were left out to keep the backup small enough; upload them again.");
    }
    if (size() > B.maxBytes) throw new HttpError(413, "The project's security assessment data is too large for a project backup (more than 30 MB). Use the scheduled full backup of the platform (BACKUP_DIR) to keep it.");

    const counts = { securityApplications: applications.length, securityAuthorizations: authorizations.length, securityAssessments: assessments.length, securityFindings: findings.length, securityAuditLines: audit.length };
    return { doc, counts, needs };
}

// ── restore ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const countBy = (xs: string[]) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
};

/** Cross-references in a document: every reference points at something in it, and none appears twice. A plain problem, or undefined. */
export function securityBackupProblem(d: SecurityBackupDoc): string | undefined {
    const unique = (refs: string[], what: string) => (new Set(refs).size !== refs.length ? `two ${what} have the same reference` : undefined);
    const apps = new Set(d.applications.map((a) => a.ref));
    const auths = new Set(d.authorizations.map((a) => a.ref));
    const assess = new Set(d.assessments.map((a) => a.ref));
    const problem =
        unique(d.applications.map((a) => a.ref), "applications") ??
        unique(d.authorizations.map((a) => a.ref), "authorizations") ??
        unique(d.assessments.map((a) => a.ref), "assessments") ??
        unique(d.findings.map((f) => f.ref), "findings") ??
        (d.authorizations.some((a) => !apps.has(a.applicationRef)) ? "an authorization belongs to an application that is not in the backup" : undefined) ??
        (d.assessments.some((a) => !apps.has(a.applicationRef) || !auths.has(a.authorizationRef) || (a.retestOfRef !== null && !assess.has(a.retestOfRef))) ? "an assessment refers to something that is not in the backup" : undefined) ??
        (d.findings.some(
            (f) =>
                !apps.has(f.applicationRef) ||
                (f.firstAssessmentRef !== null && !assess.has(f.firstAssessmentRef)) ||
                (f.lastAssessmentRef !== null && !assess.has(f.lastAssessmentRef)) ||
                f.sightings.some((x) => !assess.has(x.assessmentRef)) ||
                f.history.some((h) => h.assessmentRef !== null && !assess.has(h.assessmentRef)),
        )
            ? "a finding refers to something that is not in the backup"
            : undefined) ??
        (new Set(d.findings.map((f) => `${f.applicationRef}\n${f.fingerprint}`)).size !== d.findings.length ? "two findings of one application are the same finding" : undefined) ??
        ([...countBy(d.findings.map((f) => f.applicationRef)).values()].some((n) => n > L.findingsPerApplication) ? "an application has more findings than one may have" : undefined) ??
        (d.applications.some((a) => {
            try {
                return !/^https?:$/.test(new URL(a.targetUrl).protocol);
            } catch {
                return true;
            }
        })
            ? "an application's address is not a web address"
            : undefined);
    return problem ? `The backup is damaged: security.json: ${problem}.` : undefined;
}

const RESTORED_REASON = "Restored from a backup: record a new authorization before the next assessment.";
const UNFINISHED_WORDS = "Restored from a backup before it had finished; it was not run again.";
const clean = (v: string | null, max: number) => (v === null ? null : redactText(v, max));

/**
 * Writes the document into the new project. Synchronous (no await), so it is part of the restore's single stretch of database work;
 * a failure throws and the caller removes the project (and calls `forgetSecurityData`). Returns counts and plain notes.
 */
export function importSecurityData(db: Db, projectId: string, d: SecurityBackupDoc): { counts: Record<string, number>; notes: string[] } {
    const store = securityStoreFor(db);
    const now = new Date().toISOString();
    const notes: string[] = [...d.omitted];
    const appIds = new Map<string, string>();
    const authIds = new Map<string, string>();
    const assessIds = new Map<string, string>();
    const findIds = new Map<string, string>();

    store.setTestingType(projectId, d.testingType);
    if (d.notifications) {
        saveNotificationSettings(db, projectId, { newCriticalHigh: d.notifications.newCriticalHigh, failed: d.notifications.failed, everyFinish: d.notifications.everyFinish, channelIds: null });
        if (d.notifications.channelsChosen) notes.push("Assessment messages went to chosen alert channels. Alert channels are not in a backup: add them again, then choose them for the assessment messages.");
    }

    for (const a of d.applications) {
        const id = randomUUID();
        appIds.set(a.ref, id);
        db.run(
            "INSERT INTO security_applications (id, project_id, name, target_url, environment, scope_json, excluded_paths_json, max_rps, api_spec_url, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            id,
            projectId,
            a.name,
            a.targetUrl,
            a.environment,
            JSON.stringify(a.scope),
            JSON.stringify(a.excludedPaths),
            a.maxRequestsPerSecond,
            a.apiSpecUrl,
            a.notes,
            a.createdAt,
            a.updatedAt,
        );
        if (a.signInAccount !== null || a.sensitiveWorkflows.length) writeExtras(db, id, { signInAccount: a.signInAccount, sensitiveWorkflows: a.sensitiveWorkflows });
        if (a.apiDocument) {
            const content = a.apiDocument.content;
            saveApiDocument(db, id, {
                fileName: a.apiDocument.fileName,
                format: a.apiDocument.format,
                sizeBytes: Buffer.byteLength(content),
                sha256: createHash("sha256").update(content).digest("hex"),
                title: a.apiDocument.title,
                version: a.apiDocument.version,
                operations: a.apiDocument.operations,
                requestable: a.apiDocument.requestable,
                uploadedBy: a.apiDocument.uploadedBy,
                content,
            });
        }
    }

    for (const r of d.authorizations) {
        const id = randomUUID();
        authIds.set(r.ref, id);
        // History, not permission: a restored authorization is never current (the person restoring confirms again).
        db.run(
            "INSERT INTO security_authorizations (id, application_id, basis, approver_name, approver_email, document_reference, restrictions, statement, confirmed_by_user_id, confirmed_by_name, confirmed_at, scope_fingerprint, revoked_at, revoked_by, revoked_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            id,
            appIds.get(r.applicationRef)!,
            r.basis,
            r.approverName,
            r.approverEmail,
            r.documentReference,
            r.restrictions,
            r.statement,
            null,
            r.confirmedByName,
            r.confirmedAt,
            r.scopeFingerprint,
            r.revokedAt ?? now,
            r.revokedAt ? r.revokedBy : "Restore",
            r.revokedAt ? r.revokedReason : RESTORED_REASON,
        );
    }
    if (d.authorizations.some((r) => !r.revokedAt)) notes.push("Security assessment authorizations were restored as history and withdrawn: record a new authorization before the next assessment.");

    for (const a of d.assessments) assessIds.set(a.ref, randomUUID());
    let unfinished = 0;
    for (const a of d.assessments) {
        const done = FINISHED_STATES.includes(a.state);
        if (!done) unfinished++;
        db.run(
            "INSERT INTO security_assessments (id, application_id, project_id, authorization_id, kind, state, progress, progress_text, coverage_json, error, started_by, created_at, started_at, finished_at, retest_of, cancel_requested) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)",
            assessIds.get(a.ref)!,
            appIds.get(a.applicationRef)!,
            projectId,
            authIds.get(a.authorizationRef)!,
            "passive",
            done ? a.state : "CANCELLED",
            a.progress,
            done ? a.progressText : UNFINISHED_WORDS,
            a.coverage === null ? null : JSON.stringify(a.coverage),
            a.error,
            a.startedBy,
            a.createdAt,
            a.startedAt,
            done ? a.finishedAt : (a.finishedAt ?? now),
            a.retestOfRef ? assessIds.get(a.retestOfRef)! : null,
        );
    }
    if (unfinished) notes.push(`${unfinished} security assessment${unfinished === 1 ? " had" : "s had"} not finished when the backup was made; ${unfinished === 1 ? "it was" : "they were"} restored as cancelled.`);

    let history = 0;
    let sightings = 0;
    for (const f of d.findings) {
        const id = randomUUID();
        findIds.set(f.ref, id);
        db.run(
            "INSERT INTO security_findings (id, project_id, application_id, first_assessment_id, last_assessment_id, fingerprint, check_id, title, category, severity, confidence, location, description, impact, remediation, reproduction, evidence_json, source, ai_note, validation, first_seen_at, last_seen_at, created_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            id,
            projectId,
            appIds.get(f.applicationRef)!,
            f.firstAssessmentRef ? assessIds.get(f.firstAssessmentRef)! : null,
            f.lastAssessmentRef ? assessIds.get(f.lastAssessmentRef)! : null,
            f.fingerprint,
            f.checkId,
            redactText(f.title, L.findingTitleMax),
            f.category,
            f.severity,
            f.confidence,
            redactText(f.location, L.locationMax),
            redactText(f.description, L.findingTextMax),
            redactText(f.impact, L.findingTextMax),
            redactText(f.remediation, L.findingTextMax),
            clean(f.reproduction, L.findingTextMax),
            JSON.stringify(f.evidence.map((e) => redactEvidence(e))),
            f.source,
            clean(f.aiNote, L.findingTextMax),
            f.validation,
            f.firstSeenAt,
            f.lastSeenAt,
            f.createdBy,
            now,
        );
        for (const h of f.history) {
            db.run(
                "INSERT INTO security_finding_history (finding_id, at, actor, actor_id, from_validation, to_validation, comment, assessment_id) VALUES (?,?,?,?,?,?,?,?)",
                id,
                h.at,
                h.actor,
                null,
                h.from,
                h.to,
                clean(h.comment, L.commentMax),
                h.assessmentRef ? assessIds.get(h.assessmentRef)! : null,
            );
            history++;
        }
        const seen = new Set<string>();
        for (const x of f.sightings) {
            if (seen.has(x.assessmentRef)) continue;
            seen.add(x.assessmentRef);
            db.run("INSERT INTO security_finding_sightings (finding_id, assessment_id, seen_at, evidence_json) VALUES (?,?,?,?)", id, assessIds.get(x.assessmentRef)!, x.seenAt, JSON.stringify(x.evidence.map((e) => redactEvidence(e))));
            sightings++;
        }
    }

    const objectId = (r: string | null): string | null => (r === "project" ? projectId : r ? (appIds.get(r) ?? authIds.get(r) ?? assessIds.get(r) ?? findIds.get(r) ?? null) : null);
    for (const e of d.audit) {
        db.run(
            "INSERT INTO security_audit (at, project_id, application_id, actor_kind, actor_id, actor_name, action, object_type, object_id, summary) VALUES (?,?,?,?,?,?,?,?,?,?)",
            e.at,
            projectId,
            e.applicationRef ? (appIds.get(e.applicationRef) ?? null) : null,
            e.actorKind,
            null,
            e.actorName,
            e.action,
            e.objectType,
            objectId(e.objectRef),
            redactText(e.summary, 1000),
        );
    }

    const counts = { securityApplications: d.applications.length, securityAuthorizations: d.authorizations.length, securityAssessments: d.assessments.length, securityFindings: d.findings.length, securityHistory: history, securitySightings: sightings, securityAuditLines: d.audit.length };
    const words = `${d.applications.length} application${d.applications.length === 1 ? "" : "s"}, ${d.assessments.length} assessment${d.assessments.length === 1 ? "" : "s"}, ${d.findings.length} finding${d.findings.length === 1 ? "" : "s"}`;
    recordSecurityEvent(db, { projectId, action: "project.restored", objectType: "project", objectId: projectId, summary: `Restored the security assessment data from a project backup: ${words}. Earlier authorizations are kept as history; record a new one before the next assessment.` });
    return { counts, notes };
}

// ── round 21: the restore message, and a backup without the security data ─────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listWords = (parts: string[]) => (parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);

/**
 * What a restore brought back of the security data, in words for the restore message ("1 application, 1 authorization (withdrawn: record
 * a new one before the next assessment), 3 assessments and 3 findings"), from the restore's counts.
 */
export function securityRestoreWords(counts: Record<string, number>): string {
    const n = (k: string) => counts[k] ?? 0;
    if (!n("securityApplications") && !n("securityAssessments") && !n("securityFindings")) return "the security assessment settings (no applications, assessments or findings)";
    const auth = n("securityAuthorizations");
    return listWords([
        plural(n("securityApplications"), "application"),
        ...(auth ? [`${plural(auth, "authorization")} (withdrawn: record a new one before the next assessment)`] : []),
        plural(n("securityAssessments"), "assessment"),
        plural(n("securityFindings"), "finding"),
    ]);
}

/** The project's security data in numbers, or undefined when it has none (the same rule as `exportSecurityData`). Reads counts only. */
export function securityDataCounts(db: Db, projectId: string): { applications: number; authorizations: number; assessments: number; findings: number } | undefined {
    const count = (sql: string) => db.get<{ n: number }>(sql, projectId)?.n ?? 0;
    const applications = count("SELECT COUNT(*) AS n FROM security_applications WHERE project_id = ?");
    const audit = count("SELECT COUNT(*) AS n FROM security_audit WHERE project_id = ?");
    const typeSaved = count("SELECT COUNT(*) AS n FROM security_project_settings WHERE project_id = ?");
    if (!applications && !audit && !typeSaved && !notificationSettings(db, projectId).saved) return undefined;
    return {
        applications,
        authorizations: count("SELECT COUNT(*) AS n FROM security_authorizations WHERE application_id IN (SELECT id FROM security_applications WHERE project_id = ?)"),
        assessments: count("SELECT COUNT(*) AS n FROM security_assessments WHERE project_id = ?"),
        findings: count("SELECT COUNT(*) AS n FROM security_findings WHERE project_id = ?"),
    };
}

/**
 * A project backup was downloaded without its security data (`?withoutSecurity=true`, owner only), in the format of the platform before
 * round 20 so an older platform can restore it. Recorded in the project's security trail and Activity when the project has security data
 * (what was left out); in Activity only when it has none (nothing was left out, and a trail line would itself be security data).
 */
export function recordBackupWithoutSecurity(db: Db, projectId: string): void {
    const c = securityDataCounts(db, projectId);
    if (c) {
        const left = listWords([plural(c.applications, "application"), plural(c.authorizations, "authorization"), plural(c.assessments, "assessment"), plural(c.findings, "finding")]);
        recordSecurityEvent(db, { projectId, action: "project.backup-without-security", objectType: "project", objectId: projectId, summary: `Downloaded a project backup without the security assessment data, for an older platform: ${left} were left out of it.` });
        return;
    }
    const actor = currentActor();
    new UserStore(db).addActivity({ actorKind: actor.kind, actorId: actor.id ?? null, actorName: actor.name, action: `${SECURITY_ACTIVITY_PREFIX}project.backup-without-security`, path: null, projectId, status: null, detail: "Downloaded a project backup without the security assessment data, for an older platform: the project has none, so nothing was left out." });
}

/** Everything of a project's security data that does not go away with the project row (a failed restore calls this). */
export function forgetSecurityData(db: Db, projectId: string): void {
    try {
        db.run("DELETE FROM security_audit WHERE project_id = ?", projectId);
        forgetNotificationSettings(db, projectId);
    } catch {
        /* nothing more can be done */
    }
}
