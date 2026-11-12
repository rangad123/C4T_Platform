/**
 * The wire format of one model call made by an exploration on a runner (round 51, docs/features/runner-protocol-2.md).
 *
 * The runner's engine talks to an ordinary AI SDK model whose `doGenerate` posts the call options here; the platform runs them on the job's
 * own model and answers with the result. What crosses the wire:
 *  - the call options of `LanguageModelV3CallOptions` without `abortSignal` and `headers` (the request is cancelled by closing it, and the
 *    runner never chooses headers for the provider);
 *  - bytes (screenshots, files) as `{ $bytes: base64 }`; a file part never carries a URL, so the platform never fetches an address a runner names;
 *  - the result's `content`, `finishReason`, `usage`, `warnings` and `providerMetadata`, never the raw request or response, its headers, or
 *    the provider's own usage record;
 *  - a failure as a typed error the runner turns back into the same error class (`LlmCallError`, `BudgetExceeded`, `LlmNotConfiguredError`),
 *    with the plain sentence only: never the key, the provider's name, the configuration's label or the provider's own words.
 */
import { z } from "zod";

/** The largest call body the platform accepts: a vision call carries a few screenshots, base64 adds a third. */
export const EXPLORE_LLM_MAX_BYTES = 16 * 1024 * 1024;
/** Model calls one task attempt may make (an exploration makes a few hundred; this only stops a runaway loop). */
export const EXPLORE_LLM_MAX_CALLS = 5000;

/** The one piece of a provider's words that crosses the wire: the engine retries a vision call without a temperature on it (provider.ts). */
export const TEMPERATURE_DETAIL = "temperature is not accepted";

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
const Bytes = z.object({ $bytes: z.string().regex(B64) });
/** Bytes, or base64 text (a provider reads a string as base64). Never a URL. */
const Data = z.union([Bytes, z.string().regex(B64)]);
const ProviderOptions = z.record(z.string().max(100), z.record(z.string(), z.unknown())).optional();

const TextPart = z.looseObject({
    type: z.literal("text"),
    text: z.string(),
    providerOptions: ProviderOptions,
});
const FilePart = z.looseObject({
    type: z.literal("file"),
    data: Data,
    mediaType: z.string().max(200),
    filename: z.string().max(500).optional(),
    providerOptions: ProviderOptions,
});
const ReasoningPart = z.looseObject({
    type: z.literal("reasoning"),
    text: z.string(),
    providerOptions: ProviderOptions,
});
const ToolCallPart = z.looseObject({
    type: z.literal("tool-call"),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    providerOptions: ProviderOptions,
});
const ToolResultPart = z.looseObject({
    type: z.literal("tool-result"),
    toolCallId: z.string(),
    toolName: z.string(),
    output: z.unknown(),
    providerOptions: ProviderOptions,
});
const ApprovalPart = z.looseObject({
    type: z.literal("tool-approval-response"),
    approvalId: z.string(),
    approved: z.boolean(),
});

const Message = z.discriminatedUnion("role", [
    z.looseObject({
        role: z.literal("system"),
        content: z.string(),
        providerOptions: ProviderOptions,
    }),
    z.looseObject({
        role: z.literal("user"),
        content: z.array(z.discriminatedUnion("type", [TextPart, FilePart])),
        providerOptions: ProviderOptions,
    }),
    z.looseObject({
        role: z.literal("assistant"),
        content: z.array(z.discriminatedUnion("type", [TextPart, FilePart, ReasoningPart, ToolCallPart, ToolResultPart])),
        providerOptions: ProviderOptions,
    }),
    z.looseObject({
        role: z.literal("tool"),
        content: z.array(z.discriminatedUnion("type", [ToolResultPart, ApprovalPart])),
        providerOptions: ProviderOptions,
    }),
]);

const Tool = z.looseObject({
    type: z.enum(["function", "provider"]),
    name: z.string().max(200),
});

/** One `doGenerate` call's options. */
export const ExploreCallOptionsSchema = z.object({
    prompt: z.array(Message).max(2000),
    maxOutputTokens: z.number().int().positive().optional(),
    temperature: z.number().optional(),
    stopSequences: z.array(z.string()).max(20).optional(),
    topP: z.number().optional(),
    topK: z.number().optional(),
    presencePenalty: z.number().optional(),
    frequencyPenalty: z.number().optional(),
    responseFormat: z
        .union([
            z.object({ type: z.literal("text") }),
            z.looseObject({
                type: z.literal("json"),
                schema: z.unknown().optional(),
                name: z.string().optional(),
                description: z.string().optional(),
            }),
        ])
        .optional(),
    seed: z.number().int().optional(),
    tools: z.array(Tool).max(200).optional(),
    toolChoice: z
        .looseObject({
            type: z.enum(["auto", "none", "required", "tool"]),
            toolName: z.string().optional(),
        })
        .optional(),
    providerOptions: ProviderOptions,
});

/**
 * What the runner knows about the call that the platform needs for routing to the fast or main model (engine/llm/routing.ts): the task of
 * the agent loop it runs in or the call's purpose, how the job log names that work, and whether that work has moved to the main model already.
 */
export const ExploreRouteHintSchema = z.object({
    task: z.string().max(40).optional(),
    what: z.string().max(200).optional(),
    escalated: z.boolean().optional(),
    /** Why that work moved to the main model, when the runner's own agent loop decided it (the platform tells the job once). */
    reason: z.string().max(300).optional(),
});

export const ExploreLlmRequestSchema = z.object({
    options: ExploreCallOptionsSchema,
    hint: ExploreRouteHintSchema.optional(),
    /** What the engine's call is for (engine/llm/usage.ts purposes), so the usage row says so; anything else is counted as authoring. */
    purpose: z.string().max(40).optional(),
});
export type ExploreLlmRequest = z.infer<typeof ExploreLlmRequestSchema>;

const Count = z.number().nullable().optional();
export const ExploreLlmResultSchema = z.object({
    content: z.array(z.looseObject({ type: z.string() })),
    finishReason: z.object({
        unified: z.enum(["stop", "length", "content-filter", "tool-calls", "error", "other"]),
        raw: z.string().optional(),
    }),
    usage: z.object({
        inputTokens: z.object({
            total: Count,
            noCache: Count,
            cacheRead: Count,
            cacheWrite: Count,
        }),
        outputTokens: z.object({ total: Count, text: Count, reasoning: Count }),
    }),
    warnings: z.array(z.object({ type: z.string(), feature: z.string().optional() })),
    providerMetadata: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

export const ExploreLlmErrorSchema = z.discriminatedUnion("kind", [
    /** A model call that failed after the platform's retries and fallbacks: its class (errors.ts) and, for a project's own key, its sentence. */
    z.object({
        kind: z.literal("llm"),
        cls: z.string(),
        status: z.number().int().optional(),
        retryAfterMs: z.number().optional(),
        sentence: z.string().max(500).optional(),
        detail: z.literal(TEMPERATURE_DETAIL).optional(),
    }),
    /** An AI budget was reached (engine/llm/usage.ts). */
    z.object({
        kind: z.literal("budget"),
        hit: z.object({
            cap: z.string(),
            used: z.number(),
            limit: z.number(),
            percent: z.number(),
        }),
    }),
    /** No AI can be used for this job (none set up, or the project's configuration cannot be used). */
    z.object({ kind: z.literal("unavailable"), message: z.string().max(500) }),
]);
export type ExploreLlmError = z.infer<typeof ExploreLlmErrorSchema>;

export const ExploreLlmAnswerSchema = z.discriminatedUnion("ok", [
    /** `escalated`: the platform moved this work to the main model during the call, and why (the runner's route scope follows). */
    z.object({
        ok: z.literal(true),
        result: ExploreLlmResultSchema,
        escalated: z.string().max(300).optional(),
    }),
    z.object({ ok: z.literal(false), error: ExploreLlmErrorSchema }),
]);
export type ExploreLlmAnswer = z.infer<typeof ExploreLlmAnswerSchema>;

/** Bytes anywhere in a value as `{ $bytes: base64 }`; a URL as its text (which the platform's schema then refuses as file data). */
export function encodeBytes(v: unknown): unknown {
    if (v instanceof Uint8Array)
        return {
            $bytes: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64"),
        };
    if (v instanceof URL) return v.href;
    if (Array.isArray(v)) return v.map(encodeBytes);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encodeBytes(x)]));
    return v;
}

/** The reverse of `encodeBytes`. */
export function decodeBytes(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(decodeBytes);
    if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        const keys = Object.keys(o);
        if (keys.length === 1 && keys[0] === "$bytes" && typeof o.$bytes === "string") return new Uint8Array(Buffer.from(o.$bytes, "base64"));
        return Object.fromEntries(keys.map((k) => [k, decodeBytes(o[k])]));
    }
    return v;
}
