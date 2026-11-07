/**
 * The runner a person chose for one run (COMMON contract "per-run runner choice"). Every route that starts a run accepts an optional
 * `runnerId` (an agent_tokens id) in its JSON body. A hook reads it once, before the route's own body check (so strict bodies need no
 * new field), and `Repo.createJob` puts it in `JobOptions.runner` the way it records who started the job (from the request, not from
 * each route). Only carried here: the job gate checks that this person may use that runner, and only that runner is offered the run.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "./http-error.js";

/** The routes a person starts a run from (route patterns as registered). A run started any other way keeps the project's own setting. */
export const RUN_START_ROUTES: ReadonlySet<string> = new Set([
    "/api/projects/:id/runs",
    "/api/tests/:id/validate",
    "/api/tests/:id/baseline",
    "/api/tests/:id/variants",
    "/api/projects/:id/variants",
    "/api/projects/:id/environments/:name/runs",
    "/api/projects/:id/test-suites/:sid/run",
    "/api/projects/:id/schedules/:sid/run",
    "/api/projects/:id/validation",
    "/api/projects/:id/specs",
]);

const RunnerId = z.string().trim().min(1, "runnerId must not be empty").max(64, "runnerId is too long");
const store = new AsyncLocalStorage<{ runnerId: string | undefined }>();

/** The runner chosen for the run this request starts, if any. */
export const requestedRunnerId = (): string | undefined => store.getStore()?.runnerId;

/** Run `fn` as if its request chose this runner (tests, and starters outside a request). */
export const withRequestedRunner = <T>(runnerId: string | undefined, fn: () => T): T => store.run({ runnerId }, fn);

/** Reads `runnerId` off the body of the run-start routes (and removes it, so the route's own body schema is unchanged). Registered before the routes. */
export function installRunnerChoice(app: FastifyInstance): void {
    app.addHook("preValidation", (req, _reply, done) => {
        try {
            if (req.method !== "POST" || !RUN_START_ROUTES.has(req.routeOptions?.url ?? "")) return done();
            const body = req.body as Record<string, unknown> | null | undefined;
            let runnerId: string | undefined;
            if (body && typeof body === "object" && !Array.isArray(body) && "runnerId" in body) {
                const parsed = RunnerId.optional().nullable().safeParse(body.runnerId);
                if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "runnerId is not valid");
                runnerId = parsed.data ?? undefined;
                delete body.runnerId;
            }
            // Always entered on these routes, so nothing from elsewhere can carry over into this request.
            store.enterWith({ runnerId });
            done();
        } catch (e) {
            done(e as Error);
        }
    });
}
