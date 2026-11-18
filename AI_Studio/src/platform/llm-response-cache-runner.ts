/**
 * The AI response cache (llm-response-cache.ts) for an exploration on a runner: the runner's engine sends each model call to the platform
 * (explore-llm.ts), and an allowed one is answered here from the project's stored answers, or by the model and then kept when it may be.
 *
 * The runner's word is a hint only. A call is looked up only for an allowed id (engine/llm/response-cache-calls.ts) on a structured call
 * without tools, tool messages or images, at no sampling temperature; an answer is kept only when it is whole (finished, not refused or
 * cut), plain text, JSON that the call's own schema here reads, and needs no masking. The key is made from the call as the platform runs
 * it, so a runner can only ever get back the answer to the exact question it asks, in its own job's project.
 */
import type { z } from "zod";
import { PageDocumentation } from "../engine/discovery/docs.js";
import { ExtractionAnswerSchema } from "../engine/intel/extract/rules.js";
import { isResponseCacheCall, type ResponseCacheCall } from "../engine/llm/response-cache-calls.js";
import type { LlmPurpose } from "../engine/llm/usage.js";
import { NormalisedSchema } from "../engine/requirements/parse.js";
import { AnalysisSchema, LinkedAnalysisSchema } from "../engine/understanding/app-model.js";
import type { JobResponseCache } from "./llm-response-cache.js";

/** The schemas an allowed call's answer is checked with when it comes through a runner (the runner's own check is not trusted). */
const RUNNER_SCHEMAS: Record<ResponseCacheCall, readonly z.ZodTypeAny[]> = {
    understanding: [LinkedAnalysisSchema, AnalysisSchema],
    rules: [ExtractionAnswerSchema],
    docs: [PageDocumentation],
    requirements: [NormalisedSchema],
};

/** The options of one runner model call (the AI SDK's call options, without the abort signal and headers). */
export interface RunnerCallOptions {
    prompt: ReadonlyArray<{ role: string; content: unknown }>;
    tools?: unknown[];
    toolChoice?: unknown;
    temperature?: number;
    responseFormat?: { type: string };
    [k: string]: unknown;
}

/** The answer of a runner model call, in the parts the cache looks at. */
export interface RunnerResult {
    content: ReadonlyArray<{ type: string; text?: string }>;
    finishReason: { unified: string };
    usage: { inputTokens: { total?: number | null }; outputTokens: { total?: number | null } };
}

/** A stored answer as a runner model call's result: the text only, nothing spent. */
export interface CachedRunnerResult {
    content: Array<{ type: "text"; text: string }>;
    finishReason: { unified: "stop" };
    usage: { inputTokens: { total: 0; noCache: 0; cacheRead: 0; cacheWrite: 0 }; outputTokens: { total: 0; text: 0; reasoning: 0 } };
    warnings: [];
}

/** A runner call the cache may answer: structured, no tools, no tool messages, no files (images), no sampling temperature above 0. */
export function runnerCacheable(o: RunnerCallOptions): boolean {
    if (o.responseFormat?.type !== "json") return false;
    if (Array.isArray(o.tools) && o.tools.length > 0) return false;
    if (o.toolChoice !== undefined) return false;
    if (typeof o.temperature === "number" && o.temperature > 0) return false;
    for (const m of o.prompt) {
        if (m.role === "tool") return false;
        if (Array.isArray(m.content) && m.content.some((c: { type?: string } | null) => c?.type !== "text")) return false;
    }
    return true;
}

/** The text is JSON that one of the call's schemas reads. */
function answerValid(call: ResponseCacheCall, text: string): unknown {
    let v: unknown;
    try {
        v = JSON.parse(text);
    } catch {
        return undefined;
    }
    return RUNNER_SCHEMAS[call].some((s) => s.safeParse(v).success) ? v : undefined;
}

/**
 * One model call of a runner's exploration through the cache: the stored answer (`hit`), or the model's answer from `generate`, kept when it
 * may be. With no cache (off for this run) or a call the cache does not take, it is `generate` alone.
 */
export async function runnerCall<R extends RunnerResult>(
    cache: JobResponseCache | null,
    hint: string | undefined,
    purpose: LlmPurpose,
    options: RunnerCallOptions,
    generate: () => Promise<R>,
): Promise<{ hit: false; result: R } | { hit: true; result: CachedRunnerResult }> {
    if (!cache || !isResponseCacheCall(hint) || !runnerCacheable(options)) return { hit: false, result: await generate() };
    const call = hint;
    let key: string;
    try {
        key = cache.key(call, "runner", options);
    } catch {
        return { hit: false, result: await generate() };
    }
    const found = await cache.lookup(key);
    if (found && typeof found.answer === "string" && answerValid(call, found.answer) !== undefined) {
        cache.used(call, purpose, found);
        return {
            hit: true,
            result: {
                content: [{ type: "text", text: found.answer }],
                finishReason: { unified: "stop" },
                usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } },
                warnings: [],
            },
        };
    }
    // A failed or refused call throws here and keeps nothing.
    const result = await generate();
    const texts = result.content.filter((c) => c.type === "text");
    const others = result.content.filter((c) => c.type !== "text" && c.type !== "reasoning");
    // Only a whole, plain answer: finished (not cut short, filtered or refused), no tool call, something there.
    if (result.finishReason.unified === "stop" && others.length === 0 && texts.length > 0) {
        const text = texts.map((c) => c.text ?? "").join("");
        const value = answerValid(call, text);
        if (value !== undefined && cache.clean(value)) await cache.keep(key, call, text, { input: result.usage.inputTokens.total ?? 0, output: result.usage.outputTokens.total ?? 0 });
    }
    return { hit: false, result };
}
