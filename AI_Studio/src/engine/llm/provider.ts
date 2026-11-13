/**
 * LLM access for the engine.
 *
 * Provider factory adapted from autospec (MIT, Copyright (c) 2024 Zach Blume — src/ai.ts),
 * extended with env-driven provider/model selection and an OpenAI-compatible endpoint
 * (so self-hosted models can be used). See THIRD_PARTY_LICENSES.md.
 *
 * The engine only ever talks to the model through `LlmClient`; there is no mock mode.
 * If no credentials are configured, `assertConfigured()` fails the job with a clear error.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output, type LanguageModel } from "ai";
import type { z } from "zod";
import type { Config } from "../../config.js";
import type { EngineEvent } from "../context.js";
import { classifyLlmError, LlmCallError, scrubDetail } from "./errors.js";
import { isResilientModel, ResilientModel, type ChainEntry, type ModelV3, type OwnKeyHandling, type ResiliencePolicy, type ResilientOptions } from "./resilience.js";
import type { LlmPurpose } from "./usage.js";
import { addUsage, cachePlan, promptCacheSetting } from "./prompt-cache.js";

export type LlmProviderId = Config["LLM_PROVIDER"];
export const LLM_PROVIDERS: readonly LlmProviderId[] = ["anthropic", "openai", "google", "openai-compatible"];

const DEFAULT_MODELS: Record<string, string> = {
    anthropic: "claude-sonnet-5-5",
    openai: "gpt-5.4",
    google: "gemini-2.5-flash",
    "openai-compatible": "llama3.1",
};

/** The model a provider starts with when none is named. */
export const defaultModelOf = (provider: LlmProviderId): string => DEFAULT_MODELS[provider]!;

/**
 * OpenAI's structured outputs default to strict mode, which forbids optional properties; the
 * engine's schemas (specs, steps, locators) use them. Non-strict keeps OpenAI and
 * OpenAI-compatible providers working; other providers ignore this key.
 */
export const PROVIDER_OPTIONS = { openai: { strictJsonSchema: false } } as const;

/**
 * Retries for every model call (the SDK backs off exponentially from ~2s, so 5 retries ride out about a
 * minute of network/DNS/rate-limit trouble). The SDK default of 2 lost whole scenarios to a short DNS
 * outage in a real run.
 */
export const LLM_MAX_RETRIES = 5;
/**
 * The longest answer one step of an agent loop (test writing, agent runs) may give: a few tool calls or a short report. Without a limit
 * the request asks for the model's whole output window (64,000 tokens and more), and OpenRouter refuses it with 402 "requires more credits,
 * or fewer max_tokens" as soon as the balance could not pay for that much, although a step really costs a small part of it.
 */
export const AGENT_STEP_MAX_OUTPUT_TOKENS = 4096;

export interface Usage {
    /** All input tokens, cache reads and writes included (as every provider reports them). */
    inputTokens: number;
    outputTokens: number;
    /** Of the input: read from the provider's prompt cache. Present once a provider reported any (prompt-cache.ts). */
    cacheReadTokens?: number;
    /** Of the input: written to the provider's prompt cache. */
    cacheWriteTokens?: number;
}

export interface LlmClient {
    readonly modelName: string;
    readonly model: LanguageModel;
    usage: Usage;
    /** Structured generation validated against a zod schema. */
    object<T extends z.ZodTypeAny>(args: {
        system: string;
        prompt: string;
        schema: T;
        maxOutputTokens?: number;
        /** What the call is for; only used to label AI usage (see usage.ts). Never changes what is sent to the model. */
        purpose?: LlmPurpose;
    }): Promise<z.infer<T>>;
    text(args: { system: string; prompt: string; maxOutputTokens?: number; purpose?: LlmPurpose }): Promise<string>;
    /**
     * Structured generation about one or more images (vision judgement). Optional so that a client without it counts as
     * "cannot look at images": callers must treat a missing method as unavailable, never as a pass.
     */
    imageObject?<T extends z.ZodTypeAny>(args: {
        system: string;
        prompt: string;
        images: LlmImage[];
        schema: T;
        /** Sent as 0 for judgements, so the same picture gets the same answer as far as the provider allows. */
        temperature?: number;
        maxOutputTokens?: number;
        purpose?: LlmPurpose;
    }): Promise<z.infer<T>>;
    /**
     * Where the client tells the job about retries, fallbacks, paused providers and which model answered (ai-model-reliability.md).
     * Optional: scripted doubles and clients without a fallback chain have nothing to tell.
     */
    setEventSink?(emit: ((e: EngineEvent) => void) | undefined): void;
}

export interface LlmImage {
    data: Uint8Array;
    /** image/png or image/jpeg */
    mediaType: string;
}

export class LlmNotConfiguredError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "LlmNotConfiguredError";
    }
}

function resolveApiKey(cfg: Config): string | undefined {
    if (cfg.LLM_API_KEY) return cfg.LLM_API_KEY;
    switch (cfg.LLM_PROVIDER) {
        case "anthropic":
            return process.env.ANTHROPIC_API_KEY;
        case "openai":
            return process.env.OPENAI_API_KEY;
        case "google":
            return process.env.GOOGLE_GENERATIVE_AI_API_KEY;
        case "openai-compatible":
            return process.env.OPENAI_API_KEY ?? "not-needed";
    }
}

export function assertLlmConfigured(cfg: Config): void {
    if (!resolveApiKey(cfg)) {
        const envName = {
            anthropic: "ANTHROPIC_API_KEY",
            openai: "OPENAI_API_KEY",
            google: "GOOGLE_GENERATIVE_AI_API_KEY",
            "openai-compatible": "LLM_BASE_URL",
        }[cfg.LLM_PROVIDER];
        throw new LlmNotConfiguredError(
            `No credentials for LLM provider "${cfg.LLM_PROVIDER}". Set ${envName} (or LLM_API_KEY) before starting the platform.`,
        );
    }
    if (cfg.LLM_PROVIDER === "openai-compatible" && !cfg.LLM_BASE_URL) {
        throw new LlmNotConfiguredError("LLM_PROVIDER=openai-compatible requires LLM_BASE_URL.");
    }
}

/**
 * Client used when no credentials are configured: every call fails with a clear error. This lets
 * LLM-free work (OpenAPI-driven API tests, validation of existing specs) proceed while anything
 * that genuinely needs a model fails loudly instead of producing fake output.
 */
export function unavailableLlmClient(reason: string): LlmClient {
    const fail = (): never => {
        throw new LlmNotConfiguredError(reason);
    };
    return {
        modelName: "unavailable",
        get model(): LanguageModel {
            return fail();
        },
        usage: { inputTokens: 0, outputTokens: 0 },
        object: async () => fail(),
        text: async () => fail(),
        imageObject: async () => fail(),
    };
}

export function createLlmClientOrUnavailable(cfg: Config): LlmClient {
    try {
        return createLlmClient(cfg);
    } catch (e) {
        if (e instanceof LlmNotConfiguredError) return unavailableLlmClient(e.message);
        throw e;
    }
}

/**
 * The SDK model for one provider and model name. `baseURL` overrides the provider's address (custom endpoints, and tests' local fake).
 * `promptCache` (the switch, read at every call) adds the prompt-caching markers where the provider needs them (prompt-cache.ts).
 */
export function buildProviderModel(provider: LlmProviderId, modelName: string, o: { apiKey?: string; baseURL?: string; promptCache?: () => boolean; fetch?: typeof fetch }): LanguageModel {
    if (!o.promptCache) return sdkModel(provider, modelName, o);
    const plan = cachePlan(provider, modelName, o.promptCache, o.fetch);
    return plan.wrap(sdkModel(provider, modelName, { ...o, fetch: plan.fetch ?? o.fetch }));
}

function sdkModel(provider: LlmProviderId, modelName: string, o: { apiKey?: string; baseURL?: string; fetch?: typeof fetch }): LanguageModel {
    const extra = { ...(o.baseURL ? { baseURL: o.baseURL } : {}), ...(o.fetch ? { fetch: o.fetch } : {}) };
    switch (provider) {
        case "anthropic":
            return createAnthropic({ apiKey: o.apiKey, ...extra })(modelName);
        case "openai":
            return createOpenAI({ apiKey: o.apiKey, ...extra })(modelName);
        case "google":
            return createGoogleGenerativeAI({ apiKey: o.apiKey, ...extra })(modelName);
        case "openai-compatible":
            // Chat Completions, not the Responses API the default factory uses: third-party
            // OpenAI-compatible gateways (OpenRouter, vLLM, Ollama, LM Studio) implement /chat/completions.
            return createOpenAI({ apiKey: o.apiKey, baseURL: o.baseURL, ...(o.fetch ? { fetch: o.fetch } : {}) }).chat(modelName);
    }
}

// ── fallback models ──────────────────────────────────────────────────────────

/** At most this many fallback models (each one can add a full set of retries to a bad call). */
export const MAX_FALLBACK_MODELS = 5;

export interface FallbackModel {
    provider: LlmProviderId;
    model: string;
    /** Whether the server has what this model needs (a key for its provider, an address for a custom endpoint). */
    ready: boolean;
    reason?: string;
}

const KEY_ENV: Record<LlmProviderId, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GOOGLE_GENERATIVE_AI_API_KEY", "openai-compatible": "OPENAI_API_KEY" };
const PROVIDER_LABEL: Record<LlmProviderId, string> = { anthropic: "Anthropic", openai: "OpenAI", google: "Google", "openai-compatible": "the custom endpoint" };

/**
 * `[provider:]model` entries separated by commas or new lines. The provider prefix is read only when it names a known provider, so
 * OpenRouter names with a colon ("meta-llama/llama-3.1-8b-instruct:free") stay whole. Without a prefix the primary's provider is meant.
 */
export function parseFallbackModels(input: string | readonly string[] | undefined, primary: LlmProviderId): Array<{ provider: LlmProviderId; model: string }> {
    const items = (typeof input === "string" ? input.split(/[,\n]/) : (input ?? [])).map((s) => s.trim()).filter(Boolean);
    const out: Array<{ provider: LlmProviderId; model: string }> = [];
    for (const item of items) {
        const i = item.indexOf(":");
        const prefix = i > 0 ? item.slice(0, i) : "";
        const known = (LLM_PROVIDERS as readonly string[]).includes(prefix);
        const entry = { provider: known ? (prefix as LlmProviderId) : primary, model: known ? item.slice(i + 1).trim() : item };
        if (!entry.model || entry.model.length > 200 || /[\s\u0000-\u001f]/.test(entry.model)) continue;
        if (out.some((o) => o.provider === entry.provider && o.model === entry.model)) continue;
        out.push(entry);
        if (out.length >= MAX_FALLBACK_MODELS) break;
    }
    return out;
}

/** The key for a provider: the primary's own key, or that provider's usual environment variable. */
function keyFor(cfg: Config, provider: LlmProviderId, env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (provider === cfg.LLM_PROVIDER) return resolveApiKey(cfg);
    if (provider === "openai-compatible") return env.OPENAI_API_KEY ?? "not-needed";
    return env[KEY_ENV[provider]];
}

/** Each fallback with whether it can be used on this server and, if not, why (never the key itself). */
export function describeFallbacks(cfg: Config, entries: ReadonlyArray<{ provider: LlmProviderId; model: string }>): FallbackModel[] {
    const primaryModel = cfg.LLM_MODEL ?? DEFAULT_MODELS[cfg.LLM_PROVIDER]!;
    return entries.map((e) => {
        if (e.provider === cfg.LLM_PROVIDER && e.model === primaryModel) return { ...e, ready: false, reason: "This is the main model already." };
        if (e.provider === "openai-compatible" && !cfg.LLM_BASE_URL) return { ...e, ready: false, reason: "A custom endpoint needs LLM_BASE_URL on the server." };
        if (!keyFor(cfg, e.provider)) return { ...e, ready: false, reason: `The server has no key for ${PROVIDER_LABEL[e.provider]} (set ${KEY_ENV[e.provider]}).` };
        return { ...e, ready: true };
    });
}

/**
 * Where the fallback list comes from. The platform installs the Settings value (platform/llm-health.ts); `undefined` from it means
 * "nobody set one in the app", and LLM_FALLBACK_MODELS from the environment is used.
 */
let fallbackSource: (() => string[] | undefined) | undefined;
export function setFallbackModelSource(fn: (() => string[] | undefined) | undefined): void {
    fallbackSource = fn;
}

/** The fallback list in force: Settings first, then the environment. */
export function configuredFallbacks(cfg: Config): { entries: Array<{ provider: LlmProviderId; model: string }>; source: "app" | "environment" | "none" } {
    let fromApp: string[] | undefined;
    try {
        fromApp = fallbackSource?.();
    } catch {
        fromApp = undefined;
    }
    if (fromApp !== undefined) return { entries: parseFallbackModels(fromApp, cfg.LLM_PROVIDER), source: "app" };
    const env = parseFallbackModels(cfg.LLM_FALLBACK_MODELS, cfg.LLM_PROVIDER);
    return { entries: env, source: env.length ? "environment" : "none" };
}

const intSetting = (v: string | undefined, min: number, max: number): number | undefined => {
    const n = Number((v ?? "").trim());
    return (v ?? "").trim() && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : undefined;
};

/** Time limits and retries from the server's settings (an empty or unreadable value keeps the default). */
export function policyFromConfig(cfg: Config): Partial<ResiliencePolicy> {
    const p: Partial<ResiliencePolicy> = {};
    const attempts = intSetting(cfg.LLM_RETRY_ATTEMPTS, 1, 10);
    const timeout = intSetting(cfg.LLM_TIMEOUT_MS, 1000, 900_000);
    const deadline = intSetting(cfg.LLM_CALL_DEADLINE_MS, 1000, 3_600_000);
    if (attempts !== undefined) p.attempts = attempts;
    if (timeout !== undefined) p.attemptTimeoutMs = timeout;
    if (deadline !== undefined) p.deadlineMs = deadline;
    return p;
}

const breakerKeyOf = (provider: LlmProviderId, baseURL?: string) => (provider === "openai-compatible" || baseURL ? `${provider} ${baseURL ?? ""}`.trim() : provider);

export interface CreateClientOptions {
    /** Fallback models instead of the configured ones (the connection check passes [] to test the main model alone). */
    fallbacks?: ReadonlyArray<{ provider: LlmProviderId; model: string }>;
    resilience?: ResilientOptions;
    /** Address for every provider (tests point it at a local fake provider). Default: LLM_BASE_URL for custom endpoints only. */
    baseURLFor?: (provider: LlmProviderId) => string | undefined;
    /**
     * A key that is not the server's (a person's or an organisational AI key, platform/ai-config.ts): `id` keeps its failures from pausing the
     * provider for everyone else, and resilience.ts says the rest. Such a client is built with `fallbacks: []`.
     */
    ownKey?: OwnKeyHandling & { id: string };
    /** After this client's own models, the chain of these settings: a managed project's configuration, then the server's key. */
    thenServer?: Config;
    /** The `fetch` of this client's own models (an AI configuration's: no redirects, address checked at connection; platform/guarded-fetch.ts). */
    fetch?: typeof fetch;
}

function modelChain(cfg: Config, opts: CreateClientOptions): ChainEntry[] {
    const modelName = cfg.LLM_MODEL ?? DEFAULT_MODELS[cfg.LLM_PROVIDER]!;
    const baseURLFor = opts.baseURLFor ?? ((p: LlmProviderId) => (p === "openai-compatible" ? cfg.LLM_BASE_URL : undefined));
    const entry = (provider: LlmProviderId, name: string): ChainEntry => {
        const baseURL = baseURLFor(provider);
        // Prompt caching (prompt-cache.ts): the switch is read at every call, so Settings applies without rebuilding the client.
        const promptCache = () => promptCacheSetting(cfg).enabled;
        return { name, provider, breakerKey: opts.ownKey ? `own ${opts.ownKey.id}` : breakerKeyOf(provider, baseURL), model: buildProviderModel(provider, name, { apiKey: keyFor(cfg, provider), baseURL, promptCache, ...(opts.fetch ? { fetch: opts.fetch } : {}) }) as ModelV3 };
    };
    const fallbacks = opts.fallbacks ?? configuredFallbacks(cfg).entries;
    // Fallbacks the server cannot use (no key, no address) are left out rather than failing every call that reaches them.
    const usable = describeFallbacks(cfg, fallbacks).filter((f) => f.ready);
    return [entry(cfg.LLM_PROVIDER, modelName), ...usable.map((f) => entry(f.provider, f.model))];
}

export function createLlmClient(cfg: Config, opts: CreateClientOptions = {}): LlmClient {
    assertLlmConfigured(cfg);
    const modelName = cfg.LLM_MODEL ?? DEFAULT_MODELS[cfg.LLM_PROVIDER]!;
    const chain = [...modelChain(cfg, opts), ...(opts.thenServer ? modelChain(opts.thenServer, {}) : [])];
    const model = new ResilientModel(chain, { ...opts.resilience, ownKey: opts.ownKey, policy: { ...policyFromConfig(cfg), ...opts.resilience?.policy } });
    return llmClientFromModel(model, modelName);
}

/** The note added to a prompt when an answer did not match the requested format: the one repair re-ask. */
export function repairNote(problem: string): string {
    return `Your previous answer could not be used: ${problem}. Answer again with only the JSON object in the requested format, nothing else.`;
}

/** What was wrong with an unusable structured answer, in one short line for the re-ask. */
export function describeBadOutput(err: unknown): string {
    const e = err as { cause?: { issues?: Array<{ path?: unknown[]; message?: string }>; message?: string; cause?: { issues?: Array<{ path?: unknown[]; message?: string }> } }; message?: string };
    const issues = e?.cause?.issues ?? e?.cause?.cause?.issues;
    if (Array.isArray(issues) && issues.length) {
        return scrubDetail(
            issues
                .slice(0, 3)
                .map((i) => `${(i.path ?? []).join(".") || "answer"}: ${i.message ?? "invalid"}`)
                .join("; "),
            300,
        );
    }
    const msg = e?.cause?.message ?? e?.message ?? "";
    return scrubDetail(/json/i.test(msg) ? "it was not valid JSON" : msg || "it did not match the requested format", 300);
}

const isBadOutput = (err: unknown): boolean => classifyLlmError(err).cls === "bad_output";

/** The client around an already-built model (also how tests wrap a scripted model double). */
export function llmClientFromModel(model: LanguageModel, modelName: string): LlmClient {
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    // Cache reads and writes are counted next to the totals (prompt-cache.ts).
    const track = (u: { inputTokens?: number; outputTokens?: number } | undefined) => addUsage(usage, u);
    // A resilient model retries, falls back and classifies on its own: no second layer of retries around it.
    const resilient = isResilientModel(model);
    const retry = <T>(fn: () => Promise<T>) => (resilient ? fn() : withRetry(fn));
    const maxRetries = resilient ? 0 : LLM_MAX_RETRIES;

    /**
     * Structured output with one repair re-ask: an answer that is not valid JSON or does not match the schema is asked for once more,
     * with what was wrong; a second unusable answer fails plainly. The tokens of the unusable answer are counted too.
     */
    async function structured<R extends { output: unknown; usage: { inputTokens?: number; outputTokens?: number } }>(call: (note?: string) => Promise<R>): Promise<R> {
        const once = async (note?: string): Promise<R> => {
            const res = await call(note);
            track(res.usage);
            if (res.output === undefined || res.output === null) throw new LlmCallError({ cls: "bad_output", detail: "the answer was empty" }, { modelName });
            return res;
        };
        try {
            return await once();
        } catch (err) {
            if (!isBadOutput(err)) throw err;
            track((err as { usage?: { inputTokens?: number; outputTokens?: number } }).usage);
            const problem = describeBadOutput(err);
            try {
                return await once(problem);
            } catch (err2) {
                if (!isBadOutput(err2)) throw err2;
                track((err2 as { usage?: { inputTokens?: number; outputTokens?: number } }).usage);
                throw new LlmCallError({ cls: "bad_output", detail: describeBadOutput(err2) }, { modelName, cause: err2 });
            }
        }
    }

    const client: LlmClient = {
        modelName,
        model,
        usage,
        async object({ system, prompt, schema, maxOutputTokens }) {
            const res = await structured((note) =>
                retry(() =>
                    generateText({
                        model,
                        system,
                        prompt: note ? `${prompt}\n\n${repairNote(note)}` : prompt,
                        maxOutputTokens,
                        providerOptions: PROVIDER_OPTIONS,
                        maxRetries,
                        output: Output.object({ schema }),
                    }),
                ),
            );
            return res.output as z.infer<typeof schema>;
        },
        async text({ system, prompt, maxOutputTokens }) {
            const res = await retry(() => generateText({ model, system, prompt, maxOutputTokens, providerOptions: PROVIDER_OPTIONS, maxRetries }));
            track(res.usage);
            // A filtered answer is not an empty answer: say so instead of handing on "".
            if (res.finishReason === "content-filter" && !res.text) throw new LlmCallError({ cls: "refused" }, { modelName });
            return res.text;
        },
        async imageObject({ system, prompt, images, schema, temperature, maxOutputTokens }) {
            const messages = (note?: string) => [
                {
                    role: "user" as const,
                    content: [
                        { type: "text" as const, text: prompt },
                        ...images.map((i) => ({ type: "image" as const, image: i.data, mediaType: i.mediaType })),
                        ...(note ? [{ type: "text" as const, text: repairNote(note) }] : []),
                    ],
                },
            ];
            const call = (withTemperature: boolean) =>
                structured((note) =>
                    retry(() =>
                        generateText({
                            model,
                            system,
                            messages: messages(note),
                            maxOutputTokens,
                            ...(withTemperature && temperature !== undefined ? { temperature } : {}),
                            providerOptions: PROVIDER_OPTIONS,
                            maxRetries,
                            output: Output.object({ schema }),
                        }),
                    ),
                );
            let res;
            try {
                res = await call(true);
            } catch (err) {
                // Some newer models refuse a temperature setting: "where possible" means one retry without it.
                if (temperature === undefined || !/temperature/i.test(err instanceof Error ? err.message : String(err))) throw err;
                res = await call(false);
            }
            return res.output as z.infer<typeof schema>;
        },
    };
    if (resilient) client.setEventSink = (fn) => model.setEventSink(fn);
    return client;
}

/** Retry transient failures (rate limits, 5xx, network) with exponential backoff. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            const msg = err instanceof Error ? err.message : String(err);
            const transient = /429|rate|overload|timeout|ECONN|ETIMEDOUT|5\d\d|fetch failed/i.test(msg);
            if (!transient || i === attempts - 1) throw err;
            await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
        }
    }
    throw lastErr;
}
