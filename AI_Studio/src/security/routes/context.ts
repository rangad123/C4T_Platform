/**
 * What every security route module gets (RUN's and FIND's too). Built once by ./index.ts.
 *
 * Stable API (SecurityRouteCtx):
 *   app                  the module's own Fastify scope: its hooks (the off switch, the audit fallback) apply only to /api/v1/security routes.
 *                        Register full paths: `${SECURITY_API}/assessments/:aid`.
 *   p, repo, store, settings
 *   project(id)          the project row or 404
 *   application(appId, req?)   the application or 404; with `req`, a `?projectId=` in the query must match (404 otherwise)
 *   assessment(aid, req?) · finding(fid, req?) · authorization(authId, req?)   same, each 404 when unknown or of another project
 *   audit(event)         recordSecurityEvent (security trail + Activity, with who)
 *   actorName(req)       the plain name of who is calling ("Ana", "Access key")
 *   body(schema, req)    zod parse with the first problem as a plain 400 message
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { z } from "zod";
import { actorOf } from "../../platform/auth/access.js";
import { currentActor, type Actor } from "../../platform/auth/actor.js";
import type { Platform } from "../../platform/bootstrap.js";
import type { Row } from "../../platform/db.js";
import { HttpError } from "../../platform/http-error.js";
import type { Repo } from "../../platform/repo.js";
import { recordSecurityEvent } from "../audit.js";
import type { SecurityApplication, SecurityAssessment, SecurityFinding } from "../contract.js";
import type { SecuritySettings } from "../settings.js";
import type { SecurityAuditEvent, SecurityStore, StoredAuthorization } from "../store.js";

export const SECURITY_API = "/api/v1/security";

export interface SecurityRouteCtx {
    app: FastifyInstance;
    p: Platform;
    repo: Repo;
    store: SecurityStore;
    settings: SecuritySettings;
    project(id: string): Row;
    application(appId: string, req?: FastifyRequest): SecurityApplication;
    assessment(aid: string, req?: FastifyRequest): SecurityAssessment & { cancelRequested: boolean };
    finding(fid: string, req?: FastifyRequest): SecurityFinding & { checkId: string | null };
    authorization(authId: string, req?: FastifyRequest): StoredAuthorization & { projectId: string };
    audit(e: SecurityAuditEvent): void;
    actor(req: FastifyRequest): Actor;
    actorName(req: FastifyRequest): string;
    body<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S>;
}

/** A `?projectId=` in the query, when the caller sent one: an object of another project then answers 404 like an unknown one. */
const projectFilter = (req?: FastifyRequest): string | undefined => {
    const q = (req?.query ?? {}) as Record<string, unknown>;
    return typeof q.projectId === "string" && q.projectId ? q.projectId : undefined;
};

export function makeSecurityRouteCtx(base: { app: FastifyInstance; p: Platform; repo: Repo; project(id: string): Row; store: SecurityStore; settings: SecuritySettings }): SecurityRouteCtx {
    const { store } = base;
    const guard = <T extends { projectId: string }>(x: T | undefined, what: string, req?: FastifyRequest): T => {
        const want = projectFilter(req);
        if (!x || (want && x.projectId !== want)) throw new HttpError(404, `${what} not found`);
        return x;
    };
    return {
        ...base,
        application: (appId, req) => guard(store.getApplication(appId), "Application", req),
        assessment: (aid, req) => guard(store.getAssessment(aid), "Assessment", req),
        finding: (fid, req) => guard(store.getFinding(fid), "Finding", req),
        authorization: (authId, req) => {
            const a = store.getAuthorization(authId);
            const app = a ? store.getApplication(a.applicationId) : undefined;
            return guard(a && app ? { ...a, projectId: app.projectId } : undefined, "Authorization", req);
        },
        audit: (e) => recordSecurityEvent(base.p.db, e),
        actor: (req) => actorOf(req) ?? currentActor(),
        actorName: (req) => (actorOf(req) ?? currentActor()).name,
        body: (schema, value) => {
            const r = schema.safeParse(value ?? {});
            if (!r.success) {
                const issue = r.error.issues[0];
                const where = issue?.path?.length ? ` (${issue.path.join(".")})` : "";
                throw new HttpError(400, `${issue?.message ?? "Invalid request"}${issue && /^(Required|Invalid|Expected)/.test(issue.message) ? where : ""}`, r.error.issues);
            }
            return r.data;
        },
    };
}
