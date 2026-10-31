/**
 * Deploy triggers. Two kinds of routes:
 *  - management (create / list / revoke a project's tokens): behind the API key like every other project route;
 *  - the pipeline's two routes, `POST /api/triggers/:token/run` and `GET /api/triggers/:token/status/:jobId`: the token is the
 *    only credential, and the API-key middleware lets exactly these two through (see isTriggerTokenRoute in trigger-store.ts).
 * A revoked or unknown token answers 404, never 401, so a token cannot be probed for.
 */
import { z } from "zod";
import { HttpError } from "../http-error.js";
import { getRunbookServices } from "../runbook-runner.js";
import { runbookRunStatus, startRunbookForToken } from "../runbook-triggers.js";
import { getTriggerServices, MIN_RUN_GAP_MS, RateLimited } from "../trigger-services.js";
import type { TriggerToken } from "../trigger-store.js";
import type { RouteCtx } from "./types.js";

const MAX_ACTIVE_TOKENS = 10;

const CreateBody = z.object({
    label: z.string().trim().min(1).max(60).optional(),
    /** The pipeline may send a different address for a run (preview deployments). Off unless asked for. */
    allowUrl: z.boolean().default(false),
    /** Start a run of this runbook instead of a plain re-run (see routes/runbooks.ts). */
    runbookId: z.string().min(1).max(64).nullable().optional(),
});

const publicToken = (t: TriggerToken) => ({
    id: t.id,
    label: t.label,
    hint: t.hint,
    allowUrl: t.allowUrl,
    createdAt: t.createdAt,
    lastUsedAt: t.lastUsedAt,
    revokedAt: t.revokedAt,
});

export function registerTriggerRoutes(ctx: RouteCtx): void {
    const { app, project, p } = ctx;
    const svc = getTriggerServices(p);
    const runbooks = getRunbookServices(p).store;
    const withRunbook = (t: TriggerToken) => {
        const rb = runbooks.get(runbooks.tokenLink(t.id) ?? "");
        return { ...publicToken(t), runbookId: rb?.id ?? null, runbookName: rb?.name ?? null };
    };

    // ── management ─────────────────────────────────────────────────────────────
    app.get("/api/projects/:id/triggers", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        return { minSecondsBetweenRuns: MIN_RUN_GAP_MS / 1000, tokens: svc.store.list(id).map(withRunbook) };
    });

    app.post("/api/projects/:id/triggers", async (req, reply) => {
        const { id } = req.params as { id: string };
        project(id);
        const { runbookId, ...body } = CreateBody.parse(req.body ?? {});
        if (runbookId && runbooks.get(runbookId)?.projectId !== id) throw new HttpError(404, "This project has no runbook with that id.");
        if (svc.store.list(id).filter((t) => !t.revokedAt).length >= MAX_ACTIVE_TOKENS) throw new HttpError(409, `A project can have ${MAX_ACTIVE_TOKENS} active tokens. Revoke one you no longer use first.`);
        const { token, record } = svc.store.create(id, body);
        // The only time the token is ever shown: only its hash is kept.
        if (runbookId) runbooks.setTokenLink(record.id, runbookId);
        return reply.code(201).send({ ...withRunbook(record), token });
    });

    app.delete("/api/projects/:id/triggers/:tid", async (req) => {
        const { id, tid } = req.params as { id: string; tid: string };
        project(id);
        if (!svc.store.revoke(id, tid)) throw new HttpError(404, "Token not found, or already revoked");
        return { revoked: true };
    });

    // ── the pipeline's routes (the token is the credential) ───────────────────
    app.post("/api/triggers/:token/run", async (req, reply) => {
        const { token } = req.params as { token: string };
        try {
            // A token linked to a runbook starts a run of it; every other token starts the plain re-run below.
            const viaRunbook = await startRunbookForToken(p, token, req.body);
            if (viaRunbook) return reply.code(202).send(viaRunbook);
            const { job, testCount, ignored } = await svc.run(token, req.body);
            const run = svc.store.getRun(job.id);
            return reply.code(202).send({ jobId: job.id, state: "queued", testCount, commit: run?.commit ?? null, environment: run?.environment ?? null, ...(ignored.length ? { ignored } : {}) });
        } catch (e) {
            if (e instanceof RateLimited) return reply.header("retry-after", String(e.retryAfterSec)).code(429).send({ error: e.message, retryAfterSeconds: e.retryAfterSec });
            throw e;
        }
    });

    app.get("/api/triggers/:token/status/:jobId", async (req) => {
        const { token, jobId } = req.params as { token: string; jobId: string };
        return runbookRunStatus(p, token, jobId) ?? svc.status(token, jobId);
    });
}
