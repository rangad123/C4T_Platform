/**
 * A project's AI model (docs/features/ai-keys.md):
 *
 *   GET /api/projects/:id/ai-model   → { selected: { provider, model } | null, selectedYours, choices: [{ provider, providerWords, model }] }
 *   PUT /api/projects/:id/ai-model   { model: { provider, model } | null } → the same answer
 *
 * The choices are the models the asking person may use, through their personal keys or the organisational keys assigned to them; saving
 * one they may not use is refused. The project keeps a provider and a model name only, never a key. Whoever runs the project's AI work is
 * checked again when it runs (resolveAiFor in ai-config.ts): a person who may not use the model gets their default AI, and the job says so.
 */
import { z } from "zod";
import { aiOwnerOfActor, modelChoicesOf, projectModelOf, PROJECT_MODEL_NOT_YOURS, type AiModelPick } from "../ai-config.js";
import { accessControlOf, actorOf } from "../auth/access.js";
import { currentActor } from "../auth/actor.js";
import { HttpError } from "../http-error.js";
import { PROVIDER_WORDS } from "./ai-config.js";
import { parsePlain } from "./project-settings.js";
import type { RouteCtx } from "./types.js";

const PutBody = z
    .object({
        model: z
            .object({
                provider: z.string().min(1, "Choose an AI model.").max(64, "Choose an AI model."),
                model: z.string().min(1, "Choose an AI model.").max(200, "Choose an AI model."),
            })
            .strict()
            .nullable(),
    })
    .strict();

const same = (a: AiModelPick, b: AiModelPick) => a.provider === b.provider && a.model === b.model;

export function registerProjectAiModelRoutes(ctx: RouteCtx): void {
    const { app, p, project } = ctx;
    const control = accessControlOf(app);
    const deps = { sql: p.sql, config: p.config };

    const answer = async (projectId: string) => {
        const choices = await modelChoicesOf(deps, aiOwnerOfActor(currentActor()));
        const selected = await projectModelOf(p.sql, projectId);
        return {
            selected,
            selectedYours: selected ? choices.some((c) => same(c, selected)) : true,
            choices: choices.map((c) => ({ ...c, providerWords: (PROVIDER_WORDS as Record<string, string>)[c.provider] ?? c.provider })),
        };
    };

    app.get("/api/projects/:id/ai-model", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        return answer(id);
    });

    app.put("/api/projects/:id/ai-model", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        const { model } = parsePlain(PutBody, req.body);
        if (model && !(await modelChoicesOf(deps, aiOwnerOfActor(currentActor()))).some((c) => same(c, model))) throw new HttpError(403, PROJECT_MODEL_NOT_YOURS);
        await p.sql.run("UPDATE projects SET ai_provider = ?, ai_model = ?, updated_at = ? WHERE id = ?", model?.provider ?? null, model?.model ?? null, new Date().toISOString(), id);
        const actor = actorOf(req) ?? currentActor();
        control.users.addActivity({
            actorKind: actor.kind,
            actorId: actor.id ?? null,
            actorName: actor.name,
            action: model ? "chose the project's AI model" : "set the project's AI model back to each person's default",
            projectId: id,
            path: `/api/projects/${id}/ai-model`,
            status: 200,
            detail: model ? model.model.slice(0, 200) : null,
        });
        return answer(id);
    });
}
