/**
 * RUN's routes: start, list, read and stop passive assessments.
 *
 *   POST /api/v1/security/applications/:appId/assessments   { retestOf? }   editor. 409 without a current authorization (the plain reason)
 *                                                                           or while the application has an assessment that has not finished.
 *   GET  /api/v1/security/projects/:id/assessments          ?applicationId=&state=&limit=&before=   viewer
 *   GET  /api/v1/security/assessments/:aid                                  viewer
 *   POST /api/v1/security/assessments/:aid/cancel                           editor. Stops within seconds; what was found is kept.
 *   POST /api/v1/security/projects/:id/stop-all                             editor. Emergency stop: every unfinished assessment of the project.
 *
 * Answers: `{ assessment }`, `{ assessments }`, stop-all `{ stopped, assessments }`. An assessment is the contract's SecurityAssessment
 * plus `applicationName` and `cancelRequested`.
 *
 * The assessment loop (../assessment/runner.ts) runs in the API process when WORKER_EMBEDDED is on (the default), and is stopped with
 * the server. Its own work data never leaves the server.
 *
 * Round 52, EXECUTION_MODE=runners: the loop runs in the API process (as the dispatch worker does) and sends the steps that touch the
 * application to the starter's runner (../assessment/on-runner.ts). A start is refused with the runs' codes when that runner cannot take
 * it (not set up, offline, too old, a private address it does not open); every other rule of a start is the same.
 */
import { z } from "zod";
import { runnersOnly, SCANNERS_NOT_ON_RUNNER } from "../../platform/runner-only.js";
import { ownerIdOfActor } from "../../platform/agent-store.js";
import { assertAssessmentRunner, assessOnRunner } from "../assessment/on-runner.js";
import { currentActor, runAs, SYSTEM_ACTOR } from "../../platform/auth/actor.js";
import type { Db } from "../../platform/db.js";
import { HttpError } from "../../platform/http-error.js";
import { recordSecurityEvent } from "../audit.js";
import { ASSESSMENT_STATES, FINISHED_STATES, type SecurityApplication, type SecurityAssessment } from "../contract.js";
import { guardFor } from "../assessment/guard.js";
import { AssessmentLoop, type RunnerDeps } from "../assessment/runner.js";
import { resolveSignIn } from "../signin.js";
import { scannerSettings } from "../scanners/settings.js";
import { notifyAssessmentFinished } from "../notify.js";
import type { SecurityStore } from "../store.js";
import { SECURITY_API, type SecurityRouteCtx } from "./context.js";

const loops = new WeakMap<Db, AssessmentLoop>();

/** The loop started by the routes for this database (undefined when WORKER_EMBEDDED is off). Tests use it to wait or stop. */
export function assessmentLoopOf(db: Db): AssessmentLoop | undefined {
    return loops.get(db);
}

/** The audit line when an assessment ends (recorded as the platform: the loop is background work). */
export function recordFinished(db: Db, a: SecurityAssessment, app: SecurityApplication | undefined): void {
    const words: Partial<Record<SecurityAssessment["state"], string>> = {
        COMPLETED: "finished",
        PARTIALLY_COMPLETED: "finished with gaps",
        FAILED: "failed",
        CANCELLED: "was cancelled",
    };
    runAs(SYSTEM_ACTOR, () =>
        recordSecurityEvent(db, {
            projectId: a.projectId,
            applicationId: a.applicationId,
            action: "assessment.finished",
            objectType: "assessment",
            objectId: a.id,
            summary: `The passive assessment of “${app?.name ?? "a deleted application"}” ${words[a.state] ?? "ended"}.${a.error ? ` ${a.error.slice(0, 300)}` : ""}`,
        }),
    );
}

/** Loop dependencies for a platform (tests build their own with smaller limits and a stand-in browser). */
export function loopDeps(ctx: Pick<SecurityRouteCtx, "p" | "settings">): RunnerDeps {
    const scanners = scannerSettings(ctx.p.config as unknown as Record<string, string | undefined>);
    // Round 52: on a platform that runs tests only on runners, the steps that touch the application run on the starter's runner. The external
    // scanners run on this computer, so they are left out there (and the coverage list says so).
    if (runnersOnly(ctx.p.config)) {
        return {
            db: ctx.p.db,
            settings: ctx.settings,
            headless: true,
            guardFor: () => {
                throw new Error("An assessment's requests are sent from the runner here, never from the platform.");
            },
            signInFor: (app) => resolveSignIn(ctx.p.db, ctx.p.config, app),
            onFinished: (a, app) => {
                recordFinished(ctx.p.db, a, app);
                void notifyAssessmentFinished(ctx.p, a, app);
            },
            onRunner: assessOnRunner(ctx.p, ctx.settings),
            ...(scanners.enabled.length ? { scannersLeftOut: SCANNERS_NOT_ON_RUNNER } : {}),
        };
    }
    return {
        db: ctx.p.db,
        settings: ctx.settings,
        headless: ctx.p.config.HEADLESS,
        guardFor: (app, signal, signIn) => guardFor(app, ctx.settings, signal, {}, signIn),
        // Round 20 (SIGN): the saved sign-in the application names (decrypted for the assessment only, limited to the scope).
        signInFor: (app) => resolveSignIn(ctx.p.db, ctx.p.config, app),
        onFinished: (a, app) => {
            recordFinished(ctx.p.db, a, app);
            // OPS: the project's alert channels hear about it when its notification setting says so (never throws, never waits).
            void notifyAssessmentFinished(ctx.p, a, app);
        },
        // SCAN: the external scanner layer. It is attached only when an administrator has named at least one tool, so a platform with
        // no scanner configured runs no scanner stage at all and the assessment behaves exactly as it did before the layer existed.
        //
        // Only the SETTINGS belong here. The saved sign-in and the AI interface are per application, and one loop serves every application
        // in the platform, so the runner resolves them per assessment from `signInFor` rather than being handed one loop-wide value that
        // would be the wrong application's.
        ...(scannerSettings(ctx.p.config as unknown as Record<string, string | undefined>).enabled.length
            ? { scanners: { settings: scannerSettings(ctx.p.config as unknown as Record<string, string | undefined>) } }
            : {}),
    };
}

const StartBody = z.object({ retestOf: z.string().min(1).max(100).nullable().optional() }).strict();
const ListQuery = z.object({
    applicationId: z.string().max(100).optional(),
    state: z.enum(ASSESSMENT_STATES).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    before: z.string().max(40).optional(),
    projectId: z.string().optional(),
});

const isFinished = (s: SecurityAssessment["state"]) => FINISHED_STATES.includes(s);

/**
 * Stop one assessment: an unclaimed queued one ends at once (nothing was requested); a running one is asked to stop and its loop ends it
 * within seconds. True when something was stopped or asked to stop.
 */
function stopOne(db: Db, store: SecurityStore, id: string, words: string): boolean {
    if (!store.requestCancel(id)) return false;
    // Only when no loop holds it: otherwise the loop records the end itself (and keeps what it had found).
    db.run(
        "UPDATE security_assessments SET state = 'CANCELLED', progress_text = ?, finished_at = ? WHERE id = ? AND state = 'QUEUED' AND (lease_until IS NULL OR lease_until < ?)",
        words,
        new Date().toISOString(),
        id,
        Date.now(),
    );
    return true;
}

export function registerAssessmentRoutes(ctx: SecurityRouteCtx): void {
    const { app, store, p } = ctx;
    const params = (req: { params: unknown }) => req.params as Record<string, string>;
    const view = (a: SecurityAssessment & { cancelRequested?: boolean }) => ({ ...a, cancelRequested: a.cancelRequested ?? false, applicationName: store.getApplication(a.applicationId)?.name ?? null });

    let loop: AssessmentLoop | undefined;
    // EXECUTION_MODE=runners: the loop runs here whatever WORKER_EMBEDDED says (it opens no browser and sends nothing: the runner does).
    if ((p.config.WORKER_EMBEDDED || runnersOnly(p.config)) && ctx.settings.enabled && !loops.has(p.db)) {
        loop = new AssessmentLoop(loopDeps(ctx), 1_500);
        loops.set(p.db, loop);
        // Started once the server is ready (not while routes are still being registered), stopped with it.
        app.addHook("onReady", async () => loop!.start());
        app.addHook("onClose", async () => {
            await loop!.stop();
            loops.delete(p.db);
        });
    }

    app.post(`${SECURITY_API}/applications/:appId/assessments`, async (req, reply) => {
        const a = ctx.application(params(req).appId!, req);
        const body = ctx.body(StartBody, req.body);
        const auth = store.authorizationState(a);
        if (auth.state !== "current" || !auth.authorizationId) throw new HttpError(409, auth.message);
        const active = store.activeAssessment(a.id);
        if (active) throw new HttpError(409, `An assessment of “${a.name}” is already under way (started ${active.createdAt.slice(0, 16).replace("T", " ")}). Wait for it to finish, or cancel it, before starting another.`);
        if (body.retestOf) {
            const original = store.getAssessment(body.retestOf);
            if (!original || original.applicationId !== a.id) throw new HttpError(404, "The assessment to retest was not found for this application.");
            if (original.state !== "COMPLETED" && original.state !== "PARTIALLY_COMPLETED") throw new HttpError(409, "Only a finished assessment can be retested. Wait for it to finish first.");
        }
        // Round 52: it runs on the starter's runner: refused now, with the runs' sentences and the Settings link, when that runner cannot take it.
        const actor = currentActor();
        const ownerId = ownerIdOfActor(actor);
        if (runnersOnly(p.config)) assertAssessmentRunner(p, { kind: actor.kind, ownerId }, a.projectId, a.targetUrl);
        const created = store.createAssessment({
            applicationId: a.id,
            authorizationId: auth.authorizationId,
            startedBy: ctx.actorName(req),
            retestOf: body.retestOf ?? null,
            progressText: body.retestOf ? "Waiting to start the retest." : "Waiting to start.",
        });
        // Whose runner it goes to (kept with its work data, so a platform restart still knows).
        if (runnersOnly(p.config)) store.setWorkData(created.id, { attempts: 0, ownerId });
        ctx.audit({
            projectId: a.projectId,
            applicationId: a.id,
            action: "assessment.started",
            objectType: "assessment",
            objectId: created.id,
            summary: body.retestOf ? `Started a retest of the earlier findings of “${a.name}” (${a.targetUrl}).` : `Started a passive assessment of “${a.name}” (${a.targetUrl}), at most ${a.maxRequestsPerSecond} requests a second.`,
        });
        loops.get(p.db)?.poke();
        reply.code(201);
        return { assessment: view(store.getAssessment(created.id)!) };
    });

    app.get(`${SECURITY_API}/projects/:id/assessments`, async (req) => {
        const { id } = params(req);
        ctx.project(id!);
        const q = ctx.body(ListQuery, req.query);
        if (q.applicationId) {
            const a = store.getApplication(q.applicationId);
            if (!a || a.projectId !== id) throw new HttpError(404, "Application not found");
        }
        const list = store.listAssessments({ projectId: id, ...(q.applicationId ? { applicationId: q.applicationId } : {}), ...(q.state ? { states: [q.state] } : {}), limit: q.limit ?? 50, ...(q.before ? { before: q.before } : {}) });
        return { assessments: list.map(view) };
    });

    app.get(`${SECURITY_API}/assessments/:aid`, async (req) => ({ assessment: view(ctx.assessment(params(req).aid!, req)) }));

    app.post(`${SECURITY_API}/assessments/:aid/cancel`, async (req, reply) => {
        const a = ctx.assessment(params(req).aid!, req);
        if (isFinished(a.state)) throw new HttpError(409, "This assessment has already finished, so there is nothing to cancel.");
        const appRow = store.getApplication(a.applicationId);
        stopOne(p.db, store, a.id, "Cancelled before it started. Nothing was requested.");
        ctx.audit({ projectId: a.projectId, applicationId: a.applicationId, action: "assessment.cancelled", objectType: "assessment", objectId: a.id, summary: `Cancelled the passive assessment of “${appRow?.name ?? "an application"}”. What was found until then is kept.` });
        reply.code(202);
        return { assessment: view(store.getAssessment(a.id)!) };
    });

    app.post(`${SECURITY_API}/projects/:id/stop-all`, async (req, reply) => {
        const { id } = params(req);
        ctx.project(id!);
        const active = store.activeAssessments(id!);
        const stopped = active.filter((a) => stopOne(p.db, store, a.id, "Stopped by the emergency stop before it started. Nothing was requested."));
        ctx.audit({
            projectId: id!,
            action: "assessment.stopped",
            objectType: "project",
            objectId: id!,
            summary: stopped.length ? `Emergency stop: ${stopped.length} running assessment${stopped.length === 1 ? " was" : "s were"} asked to stop.` : "Emergency stop: no assessment was running.",
        });
        reply.code(202);
        return { stopped: stopped.length, assessments: stopped.map((a) => view(store.getAssessment(a.id)!)) };
    });
}
