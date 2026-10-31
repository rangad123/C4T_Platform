/**
 * Prompt caching (docs/features/prompt-caching.md): the part of a request that is the same from one call to the next (instructions,
 * tool definitions, and in an agent loop the conversation so far) is marked so the provider can serve it from its cache instead of
 * reading it again at the full price. Nothing about what is asked changes: the same text, in the same order, reaches the model.
 *
 * Who caches how:
 *   - Anthropic (direct): explicit markers. The instructions (system) get a breakpoint, which also covers the tool definitions because
 *     Anthropic renders tools before the system text. A call with tools (an agent loop that resends everything each step) also gets the
 *     request-level automatic marker, which caches the whole conversation up to its last block, so each step reads the previous step's prefix.
 *   - OpenRouter (or another OpenAI-compatible gateway) asked for an Anthropic model (`anthropic/...` or a `claude` name): Anthropic's
 *     `cache_control` passed through in the Chat Completions body, on the system message and, for agent loops, on the first user message
 *     (the long scenario + first page snapshot that every later step repeats). The SDK has no option for this, so a `fetch` wrapper adds it.
 *   - OpenAI, Google (Gemini 2.5 and later) and OpenRouter's other models cache repeated prefixes on their own: nothing is sent.
 *   - Other OpenAI-compatible endpoints (local servers): nothing is sent (unknown fields could be refused).
 *
 * The switch (`LLM_PROMPT_CACHE`, Settings, AI model) is read at every call, so turning it off applies to the next request of a running job.
 * Usage: providers report cache reads and writes inside the input tokens; `addUsage` keeps them as separate counters next to the total.
 */
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import type { Config } from "../../config.js";
import type { LlmProviderId, Usage } from "./provider.js";
import type { ModelV3 } from "./resilience.js";

type CallOptions = Parameters<ModelV3["doGenerate"]>[0];
type PromptMessage = CallOptions["prompt"][number];

/** How one model's requests are marked for caching. */
export type CacheStyle = "anthropic" | "anthropic-passthrough" | "automatic" | "none";

/** The marker Anthropic understands; 5 minutes, the default and cheapest write. */
export const EPHEMERAL = { type: "ephemeral" } as const;

/** An OpenAI-compatible model name that is an Anthropic model behind a gateway (OpenRouter `anthropic/claude-...`, LiteLLM `anthropic/...`). */
export function isAnthropicBehindGateway(modelName: string): boolean {
    return /^anthropic\//i.test(modelName) || /(^|\/)claude[-.\w]*$/i.test(modelName);
}

export function cacheStyleFor(provider: LlmProviderId, modelName: string): CacheStyle {
    switch (provider) {
        case "anthropic":
            return "anthropic";
        case "openai":
        case "google":
            return "automatic";
        case "openai-compatible":
            return isAnthropicBehindGateway(modelName) ? "anthropic-passthrough" : "none";
    }
}

/** One plain sentence on what caching does for this model (Settings shows it under the switch). */
export function describeCacheStyle(style: CacheStyle): string {
    switch (style) {
        case "anthropic":
            return "The instructions and tool descriptions are marked for Anthropic’s prompt cache, and so is the conversation of a test being written step by step.";
        case "anthropic-passthrough":
            return "The instructions, and the first message of a test being written step by step, are marked for the Anthropic model’s prompt cache through the endpoint.";
        case "automatic":
            return "This provider caches repeated instructions on its own; nothing extra is sent.";
        case "none":
            return "This endpoint has no prompt cache the platform knows of, so nothing extra is sent.";
    }
}

// ── the switch ───────────────────────────────────────────────────────────────

/** `LLM_PROMPT_CACHE` from the environment: on unless it says off. */
export function envPromptCache(value: string | undefined): boolean {
    return !/^\s*(false|off|0|no)\s*$/i.test(value ?? "");
}

/**
 * Where the Settings value comes from. The platform installs it (platform/prompt-cache-store.ts); `undefined` means nobody set it in
 * the app, and LLM_PROMPT_CACHE is used.
 */
let appSource: (() => boolean | undefined) | undefined;
export function setPromptCacheSource(fn: (() => boolean | undefined) | undefined): void {
    appSource = fn;
}

/** Whether caching markers are sent now, and where that comes from. */
export function promptCacheSetting(cfg: Pick<Config, "LLM_PROMPT_CACHE">): { enabled: boolean; source: "app" | "environment" | "default" } {
    let fromApp: boolean | undefined;
    try {
        fromApp = appSource?.();
    } catch {
        fromApp = undefined;
    }
    if (fromApp !== undefined) return { enabled: fromApp, source: "app" };
    if ((cfg.LLM_PROMPT_CACHE ?? "").trim()) return { enabled: envPromptCache(cfg.LLM_PROMPT_CACHE), source: "environment" };
    return { enabled: true, source: "default" };
}

// ── marking a request ────────────────────────────────────────────────────────

const withAnthropicCache = (po: CallOptions["providerOptions"]): NonNullable<CallOptions["providerOptions"]> => ({ ...po, anthropic: { ...po?.anthropic, cacheControl: EPHEMERAL } });

/**
 * The Anthropic markers for one request: the last system message, and for calls with tools the request-level automatic marker. Pure, and
 * the prompt's text is never touched (only `providerOptions` of a message are added), so the model sees the same request as without it.
 */
export function markAnthropicRequest(params: CallOptions): CallOptions {
    const prompt = [...params.prompt];
    let lastSystem = -1;
    prompt.forEach((m, i) => {
        if (m.role === "system") lastSystem = i;
    });
    if (lastSystem >= 0) {
        const m = prompt[lastSystem]!;
        prompt[lastSystem] = { ...m, providerOptions: withAnthropicCache(m.providerOptions) } as PromptMessage;
    }
    const loop = (params.tools?.length ?? 0) > 0;
    return { ...params, prompt, ...(loop ? { providerOptions: withAnthropicCache(params.providerOptions) } : {}) };
}

function anthropicMiddleware(isOn: () => boolean): LanguageModelMiddleware {
    return {
        specificationVersion: "v3",
        transformParams: async ({ params }) => (isOn() ? markAnthropicRequest(params) : params),
    };
}

type ChatPart = { type: string; text?: string; cache_control?: unknown; [k: string]: unknown };
type ChatMessage = { role: string; content?: string | ChatPart[] | null; [k: string]: unknown };

/** The message with `cache_control` on its last text part (a plain string becomes one text part). Messages without text are left alone. */
function markChatMessage(m: ChatMessage): ChatMessage {
    if (typeof m.content === "string") return m.content ? { ...m, content: [{ type: "text", text: m.content, cache_control: EPHEMERAL }] } : m;
    if (!Array.isArray(m.content)) return m;
    let last = -1;
    m.content.forEach((p, i) => {
        if (p?.type === "text") last = i;
    });
    if (last < 0) return m;
    return { ...m, content: m.content.map((p, i) => (i === last ? { ...p, cache_control: EPHEMERAL } : p)) };
}

/**
 * Anthropic's `cache_control` in an OpenAI Chat Completions body (OpenRouter passes it to Anthropic): on the system message (the
 * instructions; tools render before it) and, when the request has tools, on the first user message. At most two breakpoints, under
 * Anthropic's four. Returns the body unchanged when it is not a chat request.
 */
export function markChatCompletionsBody(body: { messages?: ChatMessage[]; tools?: unknown[]; [k: string]: unknown }): typeof body {
    if (!Array.isArray(body.messages)) return body;
    const messages = [...body.messages];
    const sys = messages.findIndex((m) => m?.role === "system" || m?.role === "developer");
    if (sys >= 0) messages[sys] = markChatMessage(messages[sys]!);
    if (Array.isArray(body.tools) && body.tools.length > 0) {
        const user = messages.findIndex((m) => m?.role === "user");
        if (user >= 0) messages[user] = markChatMessage(messages[user]!);
    }
    return { ...body, messages };
}

/** A fetch that adds the passthrough markers to Chat Completions requests while the switch is on; every other request goes out as it was. */
export function passthroughCacheFetch(isOn: () => boolean, inner: typeof fetch = globalThis.fetch): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!isOn() || !init || typeof init.body !== "string" || !/\/chat\/completions(\?|$)/.test(url)) return inner(input, init);
        let parsed: unknown;
        try {
            parsed = JSON.parse(init.body);
        } catch {
            return inner(input, init);
        }
        if (!parsed || typeof parsed !== "object") return inner(input, init);
        return inner(input, { ...init, body: JSON.stringify(markChatCompletionsBody(parsed as Parameters<typeof markChatCompletionsBody>[0])) });
    }) as typeof fetch;
}

/** What `buildProviderModel` needs for one model: an optional fetch for the provider factory, and a wrap for the built model. */
export interface CachePlan {
    style: CacheStyle;
    fetch?: typeof fetch;
    wrap<M>(model: M): M;
}

export function cachePlan(provider: LlmProviderId, modelName: string, isOn: () => boolean): CachePlan {
    const style = cacheStyleFor(provider, modelName);
    if (style === "anthropic")
        return {
            style,
            wrap: <M>(model: M): M => {
                const m = model as unknown as ModelV3;
                return (typeof m === "object" && m?.specificationVersion === "v3" ? wrapLanguageModel({ model: m, middleware: anthropicMiddleware(isOn) }) : model) as M;
            },
        };
    if (style === "anthropic-passthrough") return { style, fetch: passthroughCacheFetch(isOn), wrap: (m) => m };
    return { style, wrap: (m) => m };
}

// ── counting ─────────────────────────────────────────────────────────────────

/** The part of an SDK usage answer the counters read (LanguageModelUsage from `ai`, or a step's usage in an agent loop). */
export interface UsageLike {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
    /** Older SDK field for cache reads. */
    cachedInputTokens?: number;
}

/** Cache reads and writes of one answer (both are part of its input tokens). */
export function cacheTokensOf(u: UsageLike | undefined): { read: number; write: number } {
    const read = u?.inputTokenDetails?.cacheReadTokens ?? u?.cachedInputTokens ?? 0;
    const write = u?.inputTokenDetails?.cacheWriteTokens ?? 0;
    return { read: Number.isFinite(read) ? Math.max(0, read) : 0, write: Number.isFinite(write) ? Math.max(0, write) : 0 };
}

/**
 * Add one answer's tokens to a client's counters. The cache counters appear only once a provider reported any, so a client that never
 * caches keeps exactly `{ inputTokens, outputTokens }`.
 */
export function addUsage(into: Usage, u: UsageLike | undefined): void {
    into.inputTokens += u?.inputTokens ?? 0;
    into.outputTokens += u?.outputTokens ?? 0;
    const c = cacheTokensOf(u);
    if (c.read) into.cacheReadTokens = (into.cacheReadTokens ?? 0) + c.read;
    if (c.write) into.cacheWriteTokens = (into.cacheWriteTokens ?? 0) + c.write;
}
