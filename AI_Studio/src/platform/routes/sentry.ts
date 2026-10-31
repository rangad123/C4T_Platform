import { HttpError } from "../http-error.js";
import { assertAllowedTarget } from "../net-guard.js";
import { SecretBox } from "../secrets.js";
import { TrackerError } from "../issues/http.js";
import { SentryClient, SentrySettings, type SentryConfig } from "../sentry/client.js";
import { relatedCache, relatedErrors } from "../sentry/related.js";
import { SentryStore } from "../sentry/store.js";
import { z } from "zod";
import type { RouteCtx } from "./types.js";

/**
 * Sentry context routes. Sentry is read-only here: the connection can look up issues around a failed run and nothing else.
 * It is stored in the integrations table but is not an issue tracker (see ../sentry/store.ts).
 */
export function registerSentryRoutes(ctx: RouteCtx): void {
    const { app, p, repo } = ctx;
    const store = new SentryStore(p.db, new SecretBox(p.config.dataDir, p.config.SECRET_KEY));

    const upstream = (e: unknown): never => {
        if (e instanceof TrackerError) throw new HttpError(502, e.message, { code: e.code, upstreamStatus: e.upstreamStatus });
        throw e;
    };

    app.get("/api/projects/:id/sentry", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const c = store.get(id);
        return c ? { connected: true, connection: c } : { connected: false };
    });

    // The token may be left out when changing the names or address of an existing connection.
    const Body = SentrySettings.extend({ token: z.string().min(1).max(500).optional() }).extend({ verify: z.boolean().default(true) });
    app.put("/api/projects/:id/sentry", async (req, reply) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const { verify, ...settings } = Body.parse(req.body);
        if (!settings.token && !store.get(id)) throw new HttpError(400, "Enter the Sentry token to connect.");
        await assertAllowedTarget(settings.baseUrl);
        if (verify) {
            // Check with the token that will be used: the new one, or the stored one when it was left out.
            const cfg: SentryConfig = { kind: "sentry", baseUrl: settings.baseUrl, organization: settings.organization, project: settings.project };
            try {
                if (settings.token) await new SentryClient(cfg, settings.token).verify();
                else await store.clientWith(id, cfg)!.verify();
            } catch (e) {
                upstream(e);
            }
        }
        const existed = Boolean(store.get(id));
        const saved = store.save(id, settings);
        relatedCache.clearProject(id);
        return reply.code(existed ? 200 : 201).send({ connected: true, connection: saved });
    });

    app.delete("/api/projects/:id/sentry", async (req, reply) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        if (!store.remove(id)) throw new HttpError(404, "Sentry is not connected to this project");
        relatedCache.clearProject(id);
        return reply.code(204).send();
    });

    /** A real call to Sentry. A failed check is an answer, not a server error. */
    app.post("/api/projects/:id/sentry/test", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const client = store.client(id);
        if (!client) throw new HttpError(404, "Sentry is not connected to this project");
        try {
            await assertAllowedTarget(store.get(id)!.baseUrl);
            return { ok: true, message: await client.verify() };
        } catch (e) {
            if (e instanceof TrackerError) return { ok: false, code: e.code, message: e.message };
            if (e instanceof HttpError) return { ok: false, code: "blocked", message: e.message };
            throw e;
        }
    });

    /** Issues that might be related to this test's failed run. Always 200 once the test exists. */
    app.get("/api/tests/:id/sentry", async (req) => {
        const { id } = req.params as { id: string };
        const { refresh } = z.object({ refresh: z.enum(["1", "true"]).optional() }).parse(req.query ?? {});
        const answer = await relatedErrors({ repo, artifacts: p.store, sentry: store }, id, { refresh: Boolean(refresh) });
        if (!answer) throw new HttpError(404, "Test not found");
        return answer;
    });
}
