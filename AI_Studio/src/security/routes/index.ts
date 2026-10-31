/**
 * The Security Assessment module's routes, all under /api/v1/security, registered from src/platform/routes/index.ts with one line.
 *
 * Each part registers its own file here with ONE line in `registerSecurityRoutes` (RUN: assessments, FIND: findings and reports):
 *   registerXxxRoutes(sctx: SecurityRouteCtx)   — see ./context.ts for what the context gives (store, settings, 404 helpers, audit)
 * and adds a rule for each route in src/platform/auth/roles.ts (the route-to-role test fails otherwise).
 *
 * The routes live in their own Fastify scope, so these hooks apply to them only:
 *   - the switch: with SECURITY_ASSESSMENT=off every route except GET /status answers 404 (after the usual sign-in check);
 *   - the audit fallback: the platform's generic Activity hook skips /api/v1/security (auth/access.ts), because changes here record
 *     their own plainer events (recordSecurityEvent: security trail + Activity). A change that did not record one (a refused request,
 *     a route that forgot) is still listed in Activity in the generic "METHOD /route" form, with who and the status.
 * Also: the daily retention prune (SECURITY_RETENTION_DAYS) of finished assessments and their per-assessment evidence.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { actorOf } from "../../platform/auth/access.js";
import { runAs, SYSTEM_ACTOR } from "../../platform/auth/actor.js";
import { HttpError } from "../../platform/http-error.js";
import type { RouteCtx } from "../../platform/routes/types.js";
import { UserStore } from "../../platform/user-store.js";
import { auditedThisRequest, recordSecurityEvent } from "../audit.js";
import { securitySettings } from "../settings.js";
import { securityStoreFor, type SecurityStore } from "../store.js";
import { makeSecurityRouteCtx, SECURITY_API, type SecurityRouteCtx } from "./context.js";
import { registerSecurityCoreRoutes } from "./core.js";

export { SECURITY_API, type SecurityRouteCtx } from "./context.js";

export const SECURITY_OFF_MESSAGE = "Security assessment is turned off on this platform.";
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const DAY_MS = 86_400_000;

/** The project a security request is about, from its route parameters (for the Activity fallback). */
function projectOfRequest(store: SecurityStore, req: FastifyRequest): string | null {
    const p = (req.params ?? {}) as Record<string, string | undefined>;
    try {
        if (p.id) return p.id;
        if (p.appId) return store.getApplication(p.appId)?.projectId ?? null;
        if (p.aid) return store.getAssessment(p.aid)?.projectId ?? null;
        if (p.fid) return store.getFinding(p.fid)?.projectId ?? null;
        if (p.authId) {
            const a = store.getAuthorization(p.authId);
            return a ? (store.getApplication(a.applicationId)?.projectId ?? null) : null;
        }
    } catch {
        /* the Activity line is best effort */
    }
    return null;
}

/** Removes finished assessments past the retention period; one audit line per project that lost some. */
export function pruneSecurityData(ctx: Pick<SecurityRouteCtx, "p" | "store" | "settings">, now = Date.now()): { assessments: number; sightings: number } {
    const r = ctx.store.prune(ctx.settings.retentionDays, now);
    runAs(SYSTEM_ACTOR, () => {
        for (const [projectId, n] of Object.entries(r.byProject)) {
            recordSecurityEvent(ctx.p.db, { projectId, action: "retention.pruned", objectType: "retention", summary: `Removed ${n} finished assessment${n === 1 ? "" : "s"} older than ${ctx.settings.retentionDays} days and their evidence. Findings keep their latest evidence.` });
        }
    });
    return { assessments: r.assessments, sightings: r.sightings };
}

export function registerSecurityRoutes(ctx: RouteCtx): void {
    const settings = securitySettings(ctx.p.config);
    const store = securityStoreFor(ctx.p.db);
    const activity = new UserStore(ctx.p.db);

    void ctx.app.register(async (scoped: FastifyInstance) => {
        const sctx = makeSecurityRouteCtx({ app: scoped, p: ctx.p, repo: ctx.repo, project: ctx.project, store, settings });

        scoped.addHook("onRequest", async (req) => {
            if (!settings.enabled && req.routeOptions?.url !== `${SECURITY_API}/status`) throw new HttpError(404, SECURITY_OFF_MESSAGE);
        });

        scoped.addHook("onResponse", async (req, reply) => {
            try {
                const actor = actorOf(req);
                const template = req.routeOptions?.url;
                if (!actor || !template || SAFE.has(req.method) || actor.kind === "runner" || auditedThisRequest(actor)) return;
                activity.addActivity({
                    actorKind: actor.kind,
                    actorId: actor.id ?? null,
                    actorName: actor.name,
                    action: `${req.method} ${template}`,
                    path: req.url.split("?")[0]!,
                    projectId: projectOfRequest(store, req),
                    status: reply.statusCode,
                    detail: actor.via === "token" ? "With a personal API token" : null,
                });
            } catch (e) {
                req.log.warn({ err: e }, "security activity not recorded");
            }
        });

        registerSecurityCoreRoutes(sctx);
        // RUN and FIND: one line each below (their route files in src/security/routes/).
        (await import("./findings.js")).registerSecurityFindingRoutes(sctx); // FIND: findings, validation, manual entry, overview, reports
        (await import("./assessments.js")).registerAssessmentRoutes(sctx); // RUN: start, list, read, cancel, emergency stop; the assessment loop
        (await import("./notifications.js")).registerSecurityNotificationRoutes(sctx); // OPS: messages when an assessment ends
        (await import("./signin.js")).registerSecuritySignInRoutes(sctx); // SIGN: saved sign-ins, uploaded API documents
        (await import("./scanners.js")).registerSecurityScannerRoutes(sctx); // SCAN: which external scanners this project may use, and what they did
    });

    // The daily retention prune: first a few minutes after start (not during start-up), then once a day. Timers never keep the process up.
    const run = () => {
        try {
            pruneSecurityData({ p: ctx.p, store, settings });
        } catch (e) {
            ctx.app.log.warn({ err: e }, "security retention prune failed");
        }
    };
    const first = setTimeout(run, 5 * 60_000);
    const daily = setInterval(run, DAY_MS);
    first.unref();
    daily.unref();
    ctx.app.addHook("onClose", async () => {
        clearTimeout(first);
        clearInterval(daily);
    });
}
