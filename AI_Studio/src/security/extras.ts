/**
 * Round 20 (SIGN): what an application keeps beyond CORE's columns, in two tables of their own (migration slot 33):
 *
 *   security_application_extras   the saved sign-in the assessment loads (an account name, never a value) and the sensitive workflows
 *   security_api_documents        the uploaded API document (OpenAPI / Swagger text, at most 2 MB) and its summary
 *
 * Both use `IF NOT EXISTS` and are also created by `ensureSecurityTables` (store.ts), so the module works whether or not the slot ran
 * yet, and re-running the SQL is harmless. Rows go with their application (ON DELETE CASCADE), so with the project.
 *
 * Stable API (store.ts and the routes use it):
 *   readExtras(db, appId) -> { signInAccount, sensitiveWorkflows }      writeExtras(db, appId, patch)
 *   apiDocumentSummary(db, appId) · apiDocumentText(db, appId) · saveApiDocument(db, appId, doc) · deleteApiDocument(db, appId)
 */
import type { Db, Row } from "../platform/db.js";
import type { ApiDocumentSummary, SensitiveWorkflow } from "./contract.js";

/** Migration slot 33. */
export const SECURITY_SIGNIN_MIGRATION = `
CREATE TABLE IF NOT EXISTS security_application_extras (
    application_id TEXT PRIMARY KEY REFERENCES security_applications(id) ON DELETE CASCADE,
    signin_account TEXT,                      -- "main" or a test account's name; the session itself stays in saved_sessions (encrypted)
    sensitive_json TEXT NOT NULL DEFAULT '[]',-- [{ name, pathPrefixes, note }]: never requested
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS security_api_documents (
    application_id TEXT PRIMARY KEY REFERENCES security_applications(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    format TEXT NOT NULL,                     -- json | yaml
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    content TEXT NOT NULL,                    -- the document as uploaded; never returned by the API
    summary_json TEXT NOT NULL,               -- title, version, operation counts (ApiDocumentSummary without the file fields)
    uploaded_at TEXT NOT NULL,
    uploaded_by TEXT NOT NULL
);
`;

export const EXTRAS_LIMITS = {
    sensitiveWorkflows: 30,
    workflowNameMax: 120,
    workflowPrefixes: 20,
    workflowNoteMax: 1000,
    apiDocumentBytes: 2 * 1024 * 1024,
    fileNameMax: 200,
} as const;

const json = <T>(s: unknown, fallback: T): T => {
    if (typeof s !== "string" || !s) return fallback;
    try {
        return JSON.parse(s) as T;
    } catch {
        return fallback;
    }
};

const ensured = new WeakSet<Db>();
export function ensureExtrasTables(db: Db): void {
    if (ensured.has(db)) return;
    db.raw.exec(SECURITY_SIGNIN_MIGRATION);
    ensured.add(db);
}

export interface ApplicationExtras {
    signInAccount: string | null;
    sensitiveWorkflows: SensitiveWorkflow[];
}

export function readExtras(db: Db, appId: string): ApplicationExtras {
    ensureExtrasTables(db);
    const r = db.get<Row>("SELECT signin_account, sensitive_json FROM security_application_extras WHERE application_id = ?", appId);
    return { signInAccount: r?.signin_account ?? null, sensitiveWorkflows: json<SensitiveWorkflow[]>(r?.sensitive_json, []) };
}

/** Sets the given fields (undefined = keep). A row is only written when something is set, so untouched applications have none. */
export function writeExtras(db: Db, appId: string, patch: Partial<ApplicationExtras>): void {
    if (patch.signInAccount === undefined && patch.sensitiveWorkflows === undefined) return;
    ensureExtrasTables(db);
    const cur = readExtras(db, appId);
    const next = { signInAccount: patch.signInAccount === undefined ? cur.signInAccount : patch.signInAccount, sensitiveWorkflows: patch.sensitiveWorkflows ?? cur.sensitiveWorkflows };
    db.run(
        `INSERT INTO security_application_extras (application_id, signin_account, sensitive_json, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(application_id) DO UPDATE SET signin_account = excluded.signin_account, sensitive_json = excluded.sensitive_json, updated_at = excluded.updated_at`,
        appId,
        next.signInAccount,
        JSON.stringify(next.sensitiveWorkflows),
        new Date().toISOString(),
    );
}

const summaryOf = (r: Row): ApiDocumentSummary => {
    const s = json<Partial<ApiDocumentSummary>>(r.summary_json, {});
    return {
        fileName: r.file_name,
        format: r.format === "yaml" ? "yaml" : "json",
        sizeBytes: Number(r.size_bytes),
        sha256: r.sha256,
        title: s.title ?? null,
        version: s.version ?? null,
        operations: Number(s.operations ?? 0),
        requestable: Number(s.requestable ?? 0),
        uploadedAt: r.uploaded_at,
        uploadedBy: r.uploaded_by,
    };
};

export function apiDocumentSummary(db: Db, appId: string): ApiDocumentSummary | null {
    ensureExtrasTables(db);
    const r = db.get<Row>("SELECT file_name, format, size_bytes, sha256, summary_json, uploaded_at, uploaded_by FROM security_api_documents WHERE application_id = ?", appId);
    return r ? summaryOf(r) : null;
}

/** The document's text, for the assessment and the operation list only. */
export function apiDocumentText(db: Db, appId: string): { text: string; summary: ApiDocumentSummary } | undefined {
    ensureExtrasTables(db);
    const r = db.get<Row>("SELECT * FROM security_api_documents WHERE application_id = ?", appId);
    return r ? { text: String(r.content), summary: summaryOf(r) } : undefined;
}

export function saveApiDocument(db: Db, appId: string, doc: Omit<ApiDocumentSummary, "uploadedAt"> & { content: string }): ApiDocumentSummary {
    ensureExtrasTables(db);
    const summary = { title: doc.title, version: doc.version, operations: doc.operations, requestable: doc.requestable };
    db.run(
        `INSERT INTO security_api_documents (application_id, file_name, format, size_bytes, sha256, content, summary_json, uploaded_at, uploaded_by) VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(application_id) DO UPDATE SET file_name = excluded.file_name, format = excluded.format, size_bytes = excluded.size_bytes, sha256 = excluded.sha256,
            content = excluded.content, summary_json = excluded.summary_json, uploaded_at = excluded.uploaded_at, uploaded_by = excluded.uploaded_by`,
        appId,
        doc.fileName,
        doc.format,
        doc.sizeBytes,
        doc.sha256,
        doc.content,
        JSON.stringify(summary),
        new Date().toISOString(),
        doc.uploadedBy.slice(0, 200),
    );
    return apiDocumentSummary(db, appId)!;
}

export function deleteApiDocument(db: Db, appId: string): boolean {
    ensureExtrasTables(db);
    return Number(db.run("DELETE FROM security_api_documents WHERE application_id = ?", appId).changes) > 0;
}

/** The path prefixes of every sensitive workflow (they are excluded like `excludedPaths`). */
export function sensitivePrefixes(workflows: readonly SensitiveWorkflow[] | undefined): string[] {
    return [...new Set((workflows ?? []).flatMap((w) => w.pathPrefixes))];
}
