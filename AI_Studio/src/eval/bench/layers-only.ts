/**
 * `bench --layers-only` (Phase 4 T10): a free trial of the deterministic layers. No AI key is needed: the scripted model below answers
 * every AI call from fixed answers (no journeys, no requirements, a plain application summary), so what the trial finds comes only from the
 * deterministic checks (API cases with their contract checks, access checks) and the replays (seeded, clean, single).
 */
import type { z } from "zod";
import type { LlmClient } from "../../engine/llm/provider.js";

/** The check families of a layers-only trial: the deterministic API and access layers on, everything else off. */
export const LAYERS_ONLY_EXPLORATION: Record<string, unknown> = {
    targets: ["web", "api"],
    accessChecks: true,
    contractChecks: true,
    accessibility: false,
    healthChecks: false,
    securityChecks: false,
    inputChecks: false,
    performanceChecks: false,
    loadChecks: false,
    visual: false,
    visionChecks: false,
};

/** The fixed answers, tried in order: the first the call's schema accepts is the answer (scenarios, requirements, the app summary). */
const ANSWERS: unknown[] = [{ scenarios: [] }, { requirements: [] }, { siteType: "other", purpose: "A benchmark application", features: [], pagePurposes: [], journeys: [], authenticationMechanisms: [] }];

export function layersOnlyLlm(): LlmClient {
    return {
        modelName: "scripted",
        model: undefined as never,
        usage: { inputTokens: 0, outputTokens: 0 },
        text: async () => "",
        object: (async (args: { schema: z.ZodTypeAny }) => {
            for (const a of ANSWERS) {
                const r = args.schema.safeParse(a);
                if (r.success) return r.data;
            }
            throw new Error("Layers-only trial: no scripted answer for this AI call.");
        }) as LlmClient["object"],
    };
}
