/**
 * AI model reliability routes (Settings, AI model). Behind the API key like every /api route.
 *
 *   GET  /api/llm/health        the main model, the fallback chain (and whether each can be used here), recent health per model, paused providers
 *   PUT  /api/llm/fallbacks     { models: string[] | null }   save the fallback list in the app (null = use LLM_FALLBACK_MODELS again)
 *   POST /api/llm/check         one tiny request to the main model; counts as AI usage
 */
import { z } from "zod";
import { MAX_FALLBACK_MODELS } from "../engine/llm/provider.js";
import { HttpError } from "./http-error.js";
import { checkConnection, CheckRefused, llmHealthView, saveFallbacks } from "./llm-health.js";
import type { RouteCtx } from "./routes/types.js";

const ModelName = z
    .string()
    .trim()
    .min(1, "A model name cannot be empty")
    .max(220, "A model name is at most 200 characters")
    .regex(/^[^\s,\u0000-\u001f<>]+$/, "A model name has no spaces or commas (one model per entry, like openai:gpt-5.4)");
const FallbackBody = z.object({ models: z.array(ModelName).max(MAX_FALLBACK_MODELS, `At most ${MAX_FALLBACK_MODELS} fallback models`).nullable() }).strict();

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
        try {
            return await checkConnection(p.db, p.config);
        } catch (e) {
            if (e instanceof CheckRefused) throw new HttpError(e.status, e.message);
            throw e;
        }
    });
}
