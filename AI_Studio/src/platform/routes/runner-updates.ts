/**
 * Runner update routes (docs/features/runner-updates.md).
 *
 * Runner side (inside the agent protocol's scope, so the token check of routes/agents.ts runs first; the API key is never accepted instead):
 *   POST /api/agent/update                 { agentId } -> { update?: RunnerUpdateOffer }
 *   GET  /api/agent/update/files/:name     one file an offer can name, with its length and (for whole files) x-content-sha256
 *
 * Admin side (API key or a signed-in owner, like every other route; recorded in Activity by the access hook):
 *   PUT  /api/projects/:id/agents/:agentId/updates   { auto: boolean }   update automatically, or only when asked
 *   POST /api/projects/:id/agents/:agentId/update                         "Update this runner": the same update, now
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { SafeName } from "../../agent-protocol/schema.js";
import type { AgentTokenRecord } from "../agent-store.js";
import { getAgentServices, type AgentService } from "../agent-services.js";
import { accessControlOf, actorOf } from "../auth/access.js";
import { currentActor } from "../auth/actor.js";
import { HttpError } from "../http-error.js";
import { canManagePersonal } from "../runner-health.js";
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

/** The admin routes, registered from routes/index.ts. */
export function registerRunnerUpdateRoutes(ctx: RouteCtx): void {
    const { app, p } = ctx;
    const updates = runnerUpdatesFor(p);
    // What the runners report about their updates goes to Activity (once per report), as the runner itself.
    updates.activity = (row) => {
        accessControlOf(app).users.addActivity({ actorKind: "runner", actorId: row.agentId, actorName: row.agentName, action: row.action, projectId: row.projectId, detail: row.detail });
    };

    const agentOf = (req: FastifyRequest, projectId: string, agentId: string) => {
        ctx.project(projectId);
        const a = getAgentServices(p).store.getAgent(agentId);
        if (!a || !getAgentServices(p).store.agentServes(agentId, projectId)) throw new HttpError(404, "That runner does not belong to this project.");
        const token = getAgentServices(p).store.getToken(a.tokenId);
        // A person's own computer (round 39): only that person (or a platform admin) decides how it updates, whatever the project.
        if (token?.kind === "personal") {
            if (!canManagePersonal(actorOf(req) ?? currentActor(), token)) throw new HttpError(403, "This runner is someone's own computer. Only they can change how it updates.");
            return a;
        }
        // Updating is managing the machine: a shared runner is its owner's to update, not each project's.
        const owner = token?.organizationId ?? null;
        if (owner !== accessControlOf(app).projects.store.projectOrganization(projectId)) throw new HttpError(403, "This runner is shared with this project. Its owner updates it from the Runners page.");
        return a;
    };

    app.put("/api/projects/:id/agents/:agentId/updates", async (req) => {
        const { id, agentId } = req.params as { id: string; agentId: string };
        const a = agentOf(req, id, agentId);
        const body = z.object({ auto: z.boolean({ message: "auto is true or false." }) }).strict().safeParse(req.body ?? {});
        if (!body.success) throw new HttpError(400, body.error.issues[0]?.message ?? "Send { auto: true } or { auto: false }.");
        updates.setAuto(a.id, body.data.auto);
        return updates.publicView(a);
    });

    app.post("/api/projects/:id/agents/:agentId/update", async (req) => {
        const { id, agentId } = req.params as { id: string; agentId: string };
        const a = agentOf(req, id, agentId);
        const view = updates.publicView(a);
        if (!view.latest) throw new HttpError(409, "The runner files have not been built on this server, so there is nothing to update to. Run `npm run build:runner`.");
        if (!view.can) throw new HttpError(409, `“${a.name}” cannot update itself: it was started from a repository checkout or from a download made before runner updates existed. Download a new runner (Settings, Runners, Add a runner).`);
        if (!view.outOfDate) throw new HttpError(409, `“${a.name}” is already on version ${view.latest}.`);
        if (!view.published) throw new HttpError(409, `${view.unpublished ?? "This server offers no signed runner update."} To update “${a.name}”, download the new version from the Runners page.`);
        updates.request(a.id);
        return updates.publicView(a);
    });
}

