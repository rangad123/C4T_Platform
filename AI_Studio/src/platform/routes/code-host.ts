import { z } from "zod";
import { GithubCodeHost, GithubCodeSettings, allowedApiBase } from "../code-host/github.js";
import { CodeHostStore } from "../code-host/store.js";
import { HttpError } from "../http-error.js";
import { TrackerError } from "../issues/http.js";
import { SecretBox } from "../secrets.js";
import { registerCodeHostWebhook, webhookPath } from "../code-host/webhook.js";
import { NEW_SECRET_NEEDED } from "./shared-integrations.js";
import type { RouteCtx } from "./types.js";

/**
 * A project's code repository on GitHub (Phase 6): connect, look, test, remove. The answers never hold the token or the webhook secret.
 * Reading the pull requests themselves is for the impact analysis (code-host/github.ts); no route here passes GitHub's data through.
 */
export function registerCodeHostRoutes(ctx: RouteCtx): void {
    const { app, p } = ctx;
    const store = new CodeHostStore(p.db, new SecretBox(p.config.dataDir, p.config.SECRET_KEY));

    const upstream = (e: unknown): never => {
        if (e instanceof TrackerError && e.code === "blocked") throw new HttpError(400, e.message, { code: e.code });
        if (e instanceof TrackerError) throw new HttpError(502, e.message, { code: e.code, upstreamStatus: e.upstreamStatus });
        throw e;
    };

    app.get("/api/projects/:id/code-host", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const c = store.get(id);
        return c ? { connected: true, connection: c } : { connected: false };
    });

    // The token may be left out when changing the repository of an existing connection on the same host.
    // `feedback` is the project's switch for the pull request comment and check (code-host/feedback.ts); off until turned on.
    const Body = GithubCodeSettings.extend({ token: z.string().min(1).max(500).optional(), feedback: z.boolean().optional(), verify: z.boolean().default(true) });
    app.put("/api/projects/:id/code-host", async (req, reply) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const { verify, ...settings } = Body.parse(req.body);
        let apiUrl: string;
        try {
            apiUrl = allowedApiBase(settings.apiUrl);
        } catch (e) {
            return upstream(e);
        }
        const before = store.get(id);
        if (!settings.token && !before) throw new HttpError(400, "Enter the token to connect the repository.");
        // A stored token is only sent where it was entered for.
        if (!settings.token && before && apiUrl !== before.apiUrl) throw new HttpError(400, NEW_SECRET_NEEDED);
        if (verify) {
            const cfg = { owner: settings.owner, repo: settings.repo, apiUrl };
            try {
                await (settings.token ? new GithubCodeHost(cfg, settings.token) : store.clientWith(id, cfg)!).verify();
            } catch (e) {
                upstream(e);
            }
        }
        const { connection, hookToken } = store.save(id, { ...settings, apiUrl });
        // The webhook address is shown only by the save that made it (only its token's hash is kept); remove and connect again for a new one.
        const webhookUrl = hookToken ? `${p.config.PUBLIC_URL?.trim().replace(/\/+$/, "") ?? ""}${webhookPath(hookToken)}` : undefined;
        return reply.code(before ? 200 : 201).send({ connected: true, connection, ...(webhookUrl ? { webhookUrl } : {}) });
    });

    app.delete("/api/projects/:id/code-host", async (req, reply) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        if (!store.remove(id)) throw new HttpError(404, "No repository is connected to this project");
        return reply.code(204).send();
    });

    /** A real call to GitHub. A failed check is an answer, not a server error. */
    app.post("/api/projects/:id/code-host/test", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        if (!store.get(id)) throw new HttpError(404, "No repository is connected to this project");
        try {
            return { ok: true, message: await store.client(id)!.verify() };
        } catch (e) {
            if (e instanceof TrackerError) return { ok: false, code: e.code, message: e.message };
            throw e;
        }
    });
    // GitHub's deliveries for the connected repository (the address's token and the signature are the credentials; code-host/webhook.ts).
    registerCodeHostWebhook(ctx, store);
}
