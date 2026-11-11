/**
 * Runner update routes (docs/features/runner-updates.md).
 *
 * Runner side (inside the agent protocol's scope, so the token check of routes/agents.ts runs first; the API key is never accepted instead):
 *   POST /api/agent/update                 { agentId } -> { update?: RunnerUpdateOffer }
 *   GET  /api/agent/update/files/:name     one file an offer can name, with its length and (for whole files) x-content-sha256
 *
 * The person's side: POST /api/me/runner/update ("Update now", routes/runners.ts). Round 45 removed the per-project routes.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { SafeName } from "../../agent-protocol/schema.js";
import type { AgentService } from "../agent-services.js";
import { accessControlOf } from "../auth/access.js";
import type { AgentTokenRecord } from "../agent-store.js";
import { HttpError } from "../http-error.js";
import { runnerUpdatesFor, type RunnerUpdates } from "../runner-update.js";
import type { RouteCtx } from "./types.js";

const MAX_BODY = 4096;

async function smallJson(req: FastifyRequest): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req.raw) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY) throw new HttpError(413, "The request is too large.");
        chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8").trim();
    try {
        return text ? JSON.parse(text) : {};
    } catch {
        throw new HttpError(400, "Malformed JSON body");
    }
}

/** The two runner routes, registered by routes/agents.ts inside its token-checked scope. */
export function registerUpdateAgentRoutes(
    scope: FastifyInstance,
    h: { svc: AgentService; updates: RunnerUpdates; token: (req: FastifyRequest) => AgentTokenRecord; other: (req: FastifyRequest) => void },
): void {
    scope.post("/api/agent/update", async (req) => {
        h.other(req);
        const body = z.object({ agentId: z.string().min(1).max(64) }).safeParse(await smallJson(req));
        if (!body.success) throw new HttpError(400, "The update request is not in the expected format (agentId).");
        const agent = h.svc.agentOf(h.token(req), body.data.agentId);
        const offer = h.updates.offer(agent);
        return offer ? { update: offer } : {};
    });

    scope.get("/api/agent/update/files/:name", async (req, reply) => {
        h.other(req);
        const { name } = req.params as { name: string };
        if (!SafeName.safeParse(name).success) throw new HttpError(400, "Unsafe file name.");
        const f = h.updates.file(name);
        if (!f) throw new HttpError(404, "File not found.");
        reply.header("content-type", "application/octet-stream").header("content-length", String(f.size)).header("cache-control", "no-store");
        if (f.sha256) reply.header("x-content-sha256", f.sha256);
        return reply.send(f.body);
    });
}

/** What the runners report about their updates goes to Activity (once per report), as the runner itself. Registered from routes/index.ts. */
export function registerRunnerUpdateRoutes(ctx: RouteCtx): void {
    const { app, p } = ctx;
    const updates = runnerUpdatesFor(p);
    updates.activity = (row) => {
        accessControlOf(app).users.addActivity({ actorKind: "runner", actorId: row.agentId, actorName: row.agentName, action: row.action, projectId: row.projectId, detail: row.detail });
    };
}
