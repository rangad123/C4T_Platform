/**
 * A project's database checks (docs/features/database-checks.md; db-probe-store.ts):
 *
 *   GET /api/projects/:id/db-probe   → { enabled, url, tokenSaved }   off by default; the token is never returned
 *   PUT /api/projects/:id/db-probe   { enabled, url, token? } → the same answer
 *
 * Changing it needs ai_studio.ai_keys.manage (auth/roles.ts), as every connection holding another system's secret. `token` left out
 * keeps the saved one; an empty `url` removes the setting. Switching it on needs an address and a token. The address is
 * the customer's own probe: https:// (plain http:// only on a loopback address), no user name or query, and with BLOCK_PRIVATE_TARGETS
 * on it must resolve to a public address (as an application's address must).
 */
import { z } from "zod";
import { probeUrlProblem } from "../../engine/database/remote.js";
import { accessControlOf, actorOf } from "../auth/access.js";
import { currentActor } from "../auth/actor.js";
import { DbProbeStore } from "../db-probe-store.js";
import { HttpError } from "../http-error.js";
import { assertAllowedTarget } from "../net-guard.js";
import { SecretBox } from "../secrets.js";
import { parsePlain } from "./project-settings.js";
import type { RouteCtx } from "./types.js";

const PutBody = z
    .object({
        enabled: z.boolean({ message: "Say whether database checks are on." }),
        url: z.string().trim().max(500, "The probe address is at most 500 characters."),
        token: z.string().trim().min(24, "The probe token has at least 24 characters.").max(500, "The probe token is at most 500 characters.").optional(),
    })
    .strict();

export function registerDbProbeRoutes(ctx: RouteCtx): void {
    const { app, p, project } = ctx;
    const control = accessControlOf(app);
    const store = new DbProbeStore(p.sql, new SecretBox(p.config.dataDir, p.config.SECRET_KEY));

    app.get("/api/projects/:id/db-probe", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        return store.get(id);
    });

    app.put("/api/projects/:id/db-probe", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        const body = parsePlain(PutBody, req.body);
        if (body.url) {
            const problem = probeUrlProblem(body.url);
            if (problem) throw new HttpError(400, problem);
            await assertAllowedTarget(body.url);
        }
        const saved = await store.get(id);
        if (body.enabled && (!body.url || (!body.token && !saved.tokenSaved))) throw new HttpError(400, "Database checks need the probe's address and its token.");
        // The saved token belongs to the probe it was given for: a probe on another host gets its own, never the saved one.
        if (body.url && !body.token && saved.tokenSaved && new URL(body.url).origin !== new URL(saved.url).origin) throw new HttpError(400, "A probe at a new address needs its token again.");
        await store.set(id, body);
        const actor = actorOf(req) ?? currentActor();
        control.users.addActivity({
            actorKind: actor.kind,
            actorId: actor.id ?? null,
            actorName: actor.name,
            action: !body.url ? "removed the project's database checks" : body.enabled ? "turned the project's database checks on" : "turned the project's database checks off",
            projectId: id,
            path: `/api/projects/${id}/db-probe`,
            status: 200,
            // The address only (never the token).
            detail: body.url ? body.url.slice(0, 200) : null,
        });
        return store.get(id);
    });
}
