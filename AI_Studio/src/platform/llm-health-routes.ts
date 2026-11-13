/**
 * AI model reliability routes (Settings, AI model). Behind the API key like every /api route.
 *
 *   GET  /api/llm/health        the main model, the fallback chain (and whether each can be used here), recent health per model, paused providers
 *   PUT  /api/llm/fallbacks     { models: string[] | null }   save the fallback list in the app (null = use LLM_FALLBACK_MODELS again)
 *   POST /api/llm/check         one tiny request with the asking person's chosen AI key (the open server: the server's own key); counts as AI usage
 */
import { z } from "zod";
import { MAX_FALLBACK_MODELS } from "../engine/llm/provider.js";
import { aiOwnerOfActor, resolveAiFor, testConfiguration } from "./ai-config.js";
import { currentActor } from "./auth/actor.js";
import { HttpError } from "./http-error.js";
import { CHECK_MIN_INTERVAL_MS, checkConnection, CheckRefused, llmHealthView, saveFallbacks } from "./llm-health.js";
import type { RouteCtx } from "./routes/types.js";

const ModelName = z
    .string()
    .trim()
    .min(1, "A model name cannot be empty")
    .max(220, "A model name is at most 200 characters")
    .regex(/^[^\s,\u0000-\u001f<>]+$/, "A model name has no spaces or commas (one model per entry, like openai:gpt-5.4)");
const FallbackBody = z.object({ models: z.array(ModelName).max(MAX_FALLBACK_MODELS, `At most ${MAX_FALLBACK_MODELS} fallback models`).nullable() }).strict();

/** The last connection check per AI key (a person's chosen key). */
const keyChecks = new Map<string, number>();

export function registerLlmHealthRoutes(ctx: RouteCtx): void {
    const { app, p } = ctx;

    app.get("/api/llm/health", async () => llmHealthView(p.db, p.config, p.llm.modelName));

    app.put("/api/llm/fallbacks", async (req) => {
        const parsed = FallbackBody.safeParse(req.body ?? {});
        if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Send { models: [...] } or { models: null }");
        saveFallbacks(p.db, p.config, parsed.data.models);
        return llmHealthView(p.db, p.config, p.llm.modelName);
    });

    app.post("/api/llm/check", async () => {
        // A person's check is of their own chosen key: the server's key answers for nobody but the open server.
        const ai = await resolveAiFor(p, aiOwnerOfActor(currentActor()));
        if (ai.source === "blocked") throw new HttpError(409, ai.blocked ?? "There is no AI key to check.");
        if (ai.source === "configuration") {
            // Each check is a paid call on that key: at most one every few seconds per key.
            const last = keyChecks.get(ai.configuration!.id) ?? 0;
            if (Date.now() - last < CHECK_MIN_INTERVAL_MS) throw new HttpError(429, "Wait a few seconds before checking again.");
            keyChecks.set(ai.configuration!.id, Date.now());
            const r = await testConfiguration(p, ai.configuration!);
            return r.ok ? { ok: true, model: r.model, latencyMs: r.latencyMs } : { ok: false, model: r.model, latencyMs: r.latencyMs, error: { cls: "unknown", label: "Did not work", message: r.message } };
        }
        try {
            return await checkConnection(p.db, p.config);
        } catch (e) {
            if (e instanceof CheckRefused) throw new HttpError(e.status, e.message);
            throw e;
        }
    });
}
