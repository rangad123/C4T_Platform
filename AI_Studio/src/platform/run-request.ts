/**
 * `runnerId` in a run-start body (the per-run runner choice of rounds 39-44). Round 45: every run goes to its owner's own runner, so the
 * field is accepted and ignored: a hook removes it before the route's own body check (strict bodies stay unchanged), so a web page or
 * script that still sends it keeps working. A malformed value is still a plain 400.
 */
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

/** Removes `runnerId` from the body of the run-start routes (so the route's own body schema is unchanged); a malformed one is a 400. Registered before the routes. */
export function installRunnerChoice(app: FastifyInstance): void {
    app.addHook("preValidation", (req, _reply, done) => {
        try {
            if (req.method !== "POST" || !RUN_START_ROUTES.has(req.routeOptions?.url ?? "")) return done();
            const body = req.body as Record<string, unknown> | null | undefined;
            if (body && typeof body === "object" && !Array.isArray(body) && "runnerId" in body) {
                const parsed = RunnerId.optional().nullable().safeParse(body.runnerId);
                if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "runnerId is not valid");
                delete body.runnerId;
            }
            done();
        } catch (e) {
            done(e as Error);
        }
    });
}
