import { z } from "zod";
import { HttpError } from "../http-error.js";
import { getAgentServices } from "../agent-services.js";
import { LiveAuditStore } from "../live-session-store.js";
import { LiveSessionService } from "../live-session-service.js";
import { recorderOf } from "./recorder.js";
import type { RouteCtx } from "./types.js";

const SnapshotQuery = z.object({ image: z.enum(["1", "true", "0", "false"]).optional() });

/**
 * Drive a recording session step by step (Builder AV): perform one action in the live page and read the page. Everything is a thin layer over the recorder
 * (a session is a recording, so "save as a test" is the recorder's own route). Behind the API key like every route under /api/.
 */
export function registerLiveSessionRoutes(ctx: RouteCtx): void {
    const { app, p, repo, project } = ctx;
    const recorder = recorderOf(app);
    if (!recorder) throw new Error("The recorder routes must be registered before the live session routes.");
    const audit = new LiveAuditStore(p.db);
    const service = new LiveSessionService({
        recorder,
        audit,
        credentialsFor: (projectId) => {
            const latest = repo.getLatestApplicationPublic(projectId);
            const a = latest ? repo.getApplication(String(latest.id)) : undefined;
            const c = a?.credentials;
            return a && c ? { origin: a.origin, credentials: { ...(c.username ? { username: c.username } : {}), ...(c.password ? { password: c.password } : {}), ...(c.totpSecret ? { totpSecret: c.totpSecret } : {}) } } : undefined;
        },
        secretsFor: (projectId) => getAgentServices(p).projectSecrets(projectId),
    });

    app.post("/api/recordings/:rid/act", async (req) => {
        const { rid } = req.params as { rid: string };
        const body = (req.body ?? {}) as Record<string, unknown>;
        const { image, ...action } = body;
        if (image !== undefined && typeof image !== "boolean") throw new HttpError(400, "image is true or false.");
        return service.act(rid, action, { image: image === true });
    });

    app.get("/api/recordings/:rid/snapshot", async (req) => {
        const { rid } = req.params as { rid: string };
        const q = SnapshotQuery.parse(req.query);
        return service.snapshot(rid, { image: q.image === "1" || q.image === "true" });
    });

    // The sessions that were driven step by step, newest first: counts and addresses only.
    app.get("/api/projects/:id/live-sessions", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        return { sessions: audit.list(id) };
    });
}
