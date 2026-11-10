/**
 * Round 20 (SIGN) routes: the saved sign-ins an assessment can use, uploading one for an application, and the uploaded API document.
 * The application's own fields (`signInAccount`, `sensitiveWorkflows`) go through CORE's application routes (core.ts).
 *
 *   GET    /api/v1/security/projects/:id/sign-ins                  viewer   { signIns: SignInStatus[] }   (?applicationId= judges them for it)
 *   PUT    /api/v1/security/applications/:appId/saved-sign-in       editor   { account, storageState, checkUrl? } -> { signIn }
 *   GET    /api/v1/security/applications/:appId/api-document        viewer   { document, operations, baseUrl }
 *   PUT    /api/v1/security/applications/:appId/api-document        editor   { fileName, content } -> { document, operations, baseUrl }
 *   DELETE /api/v1/security/applications/:appId/api-document        editor   { deleted }
 *
 * No answer ever carries a cookie, a storage value or the document's text.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { parseStorageState, StorageStateError } from "../../engine/auth/storage-state.js";
import { HttpError } from "../../platform/http-error.js";
import { SecretBox } from "../../platform/secrets.js";
import { ACCOUNT_NAME, SessionStore } from "../../platform/session-store.js";
import { API_DOCUMENT_MAX_BYTES, ApiDocumentError, planOperations, readApiDocument, type PlannedOperation } from "../api-document.js";
import type { SecurityApplication } from "../contract.js";
import { apiDocumentSummary, apiDocumentText, deleteApiDocument, EXTRAS_LIMITS, saveApiDocument } from "../extras.js";
import { withSensitiveExclusions } from "../assessment/runner.js";
import { inScope } from "../scope.js";
import { accountNames, isSignOut, signInChoices, signInLabel, signInStatus } from "../signin.js";
import { SECURITY_API, type SecurityRouteCtx } from "./context.js";

const SavedSignInBody = z
    .object({
        account: z.string().trim().regex(ACCOUNT_NAME, "Choose “main” (the project's own sign-in) or the name of a test account."),
        /** A Playwright storage state (the file `--save-storage` writes), as an object or as its JSON text. */
        storageState: z.union([z.string().max(1_000_000), z.record(z.string(), z.unknown())]),
        /** A signed-in page of the application (default: its address); opened first by the assessment to tell whether the sign-in works. */
        checkUrl: z.string().trim().min(1).max(2000).optional(),
    })
    .strict();

const DocumentBody = z
    .object({
        fileName: z
            .string()
            .trim()
            .min(1, "Give the file's name.")
            .max(EXTRAS_LIMITS.fileNameMax)
            .regex(/^[^\u0000-\u001f\u007f/\\]+$/, "The file name contains characters that are not allowed."),
        content: z.string().max(API_DOCUMENT_MAX_BYTES * 2, `The API document is larger than ${API_DOCUMENT_MAX_BYTES / 1024 / 1024} MB.`),
    })
    .strict();

const ListQuery = z.object({ applicationId: z.string().max(100).optional(), projectId: z.string().optional() });

/** The operations, as the assessment would treat them now (the scope rules without DNS; DNS is checked again at the time). */
function preview(app: SecurityApplication, text: string, fileName: string): { operations: PlannedOperation[]; baseUrl: string; total: number; requestable: number } {
    const plan = planOperations(readApiDocument(text, fileName).doc, app.targetUrl);
    const scoped = withSensitiveExclusions(app);
    let requestable = 0;
    const operations = plan.operations.map((o) => {
        if (!o.request || !o.url) return o;
        const v = inScope(o.url, scoped);
        if (!v.ok) return { ...o, request: false, reason: v.code === "excluded-path" ? "It is under an excluded path or a sensitive workflow, so it is never called." : `${v.reason} It is not called.`, kind: "refused" as const };
        requestable++;
        return o;
    });
    return { operations, baseUrl: plan.baseUrl, total: plan.total, requestable };
}

export function registerSecuritySignInRoutes(ctx: SecurityRouteCtx): void {
    const { app } = ctx;
    const params = (req: { params: unknown }) => req.params as Record<string, string>;
    const db = ctx.p.db;
    const cfg = ctx.p.config;

    app.get(`${SECURITY_API}/projects/:id/sign-ins`, async (req) => {
        const { id } = params(req);
        ctx.project(id);
        const q = ctx.body(ListQuery, req.query);
        const forApp = q.applicationId ? ctx.application(q.applicationId) : undefined;
        if (forApp && forApp.projectId !== id) throw new HttpError(404, "Application not found");
        return { signIns: signInChoices(db, cfg, id, forApp) };
    });

    app.put(`${SECURITY_API}/applications/:appId/saved-sign-in`, async (req) => {
        const a = ctx.application(params(req).appId!, req);
        const body = ctx.body(SavedSignInBody, req.body);
        const known = accountNames(db, cfg, a.projectId);
        if (!known.includes(body.account)) throw new HttpError(400, `There is no test account named “${body.account}”. Add it under Test accounts first, or choose “main”.`);
        let state;
        try {
            state = parseStorageState(body.storageState);
        } catch (e) {
            throw new HttpError(400, e instanceof StorageStateError ? e.message : "The saved sign-in could not be read.");
        }
        let checkUrl = a.targetUrl;
        if (body.checkUrl) {
            try {
                checkUrl = new URL(body.checkUrl, a.targetUrl).href;
            } catch {
                throw new HttpError(400, "The signed-in page is not a web address.");
            }
            if (!inScope(checkUrl, a).ok) throw new HttpError(400, "The signed-in page must be on the application's own site or in its scope, and not under an excluded path.");
            if (isSignOut(checkUrl)) throw new HttpError(400, "The signed-in page looks like a sign-out address. Give a page that only a signed-in person sees, such as /account.");
        }
        let sessions: SessionStore;
        try {
            sessions = new SessionStore(db, new SecretBox(cfg.dataDir, cfg.SECRET_KEY));
        } catch {
            throw new HttpError(500, "The platform's secret store is not available, so a sign-in cannot be saved.");
        }
        sessions.saveSession(a.projectId, body.account, { state, appUrl: a.targetUrl, checkUrl, how: "file" });
        ctx.audit({ projectId: a.projectId, applicationId: a.id, action: "sign-in.saved", objectType: "application", objectId: a.id, summary: `Saved a sign-in for ${signInLabel(body.account)} from a file, for “${a.name}” (${state.cookies.length} cookie${state.cookies.length === 1 ? "" : "s"}; values are never shown).` });
        return { signIn: signInStatus(db, cfg, a.projectId, body.account, a) };
    });

    app.get(`${SECURITY_API}/applications/:appId/api-document`, async (req) => {
        const a = ctx.application(params(req).appId!, req);
        const doc = apiDocumentText(db, a.id);
        if (!doc) return { document: null, operations: [], baseUrl: null };
        try {
            const p = preview(a, doc.text, doc.summary.fileName);
            return { document: doc.summary, operations: p.operations, baseUrl: p.baseUrl };
        } catch {
            return { document: doc.summary, operations: [], baseUrl: null };
        }
    });

    app.put(`${SECURITY_API}/applications/:appId/api-document`, async (req) => {
        const a = ctx.application(params(req).appId!, req);
        const body = ctx.body(DocumentBody, req.body);
        const size = Buffer.byteLength(body.content, "utf8");
        if (size > API_DOCUMENT_MAX_BYTES) throw new HttpError(400, `The API document is larger than ${API_DOCUMENT_MAX_BYTES / 1024 / 1024} MB.`);
        let read;
        let p;
        try {
            read = readApiDocument(body.content, body.fileName);
            p = preview(a, body.content, body.fileName);
        } catch (e) {
            throw new HttpError(400, e instanceof ApiDocumentError ? e.message : "The API document could not be read.");
        }
        const document = saveApiDocument(db, a.id, {
            fileName: body.fileName,
            format: read.format,
            sizeBytes: size,
            sha256: createHash("sha256").update(body.content).digest("hex"),
            title: read.title,
            version: read.version,
            operations: p.total,
            requestable: p.requestable,
            uploadedBy: ctx.actorName(req),
            content: body.content,
        });
        ctx.audit({ projectId: a.projectId, applicationId: a.id, action: "api-document.uploaded", objectType: "application", objectId: a.id, summary: `Uploaded the API document “${body.fileName}” for “${a.name}”: ${p.total} operation${p.total === 1 ? "" : "s"}, ${p.requestable} GET without required parameters (the only ones an assessment requests).` });
        return { document, operations: p.operations, baseUrl: p.baseUrl };
    });

    app.delete(`${SECURITY_API}/applications/:appId/api-document`, async (req) => {
        const a = ctx.application(params(req).appId!, req);
        const had = apiDocumentSummary(db, a.id);
        const deleted = deleteApiDocument(db, a.id);
        if (deleted) ctx.audit({ projectId: a.projectId, applicationId: a.id, action: "api-document.removed", objectType: "application", objectId: a.id, summary: `Removed the API document “${had?.fileName ?? ""}” of “${a.name}”.` });
        return { deleted };
    });

}
