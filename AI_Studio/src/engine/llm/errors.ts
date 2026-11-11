/**
 * What went wrong with an AI model call, in words a person can act on.
 *
 * Every supported provider (Anthropic, OpenAI, Google, OpenRouter and local OpenAI-compatible servers) fails in its own dialect:
 * a status code, a JSON error body and sometimes a header that says when to try again. `classifyLlmError` turns any of them into
 * one of a few classes, each with a plain sentence and the decisions that follow from it (try again? try the fallback model?
 * count towards pausing the provider?). Pure functions only, so every rule is covered by fast unit tests.
 *
 * OpenRouter wraps the real provider's failure in a generic "Provider returned error" with the original answer in
 * `error.metadata.raw` and the upstream name in `error.metadata.provider_name`: both are read so the sentence says what really happened.
 */

export type LlmErrorClass =
    | "rate_limited"
    | "overloaded"
    | "server"
    | "timeout"
    | "network"
    | "auth"
    | "credit"
    | "model"
    | "refused"
    | "bad_output"
    | "bad_request"
    | "paused"
    | "unknown";

interface ClassRule {
    /** A short label for lists ("Rate limited"). */
    label: string;
    /** The sentence a job event or Settings shows. */
    sentence: string;
    /** Worth asking the same model again after a wait. */
    retryable: boolean;
    /** Worth asking the next model of the fallback chain. */
    fallback: boolean;
    /** Counts towards pausing calls to the provider (the circuit breaker). */
    breaker: boolean;
}

export const CLASS_RULES: Record<LlmErrorClass, ClassRule> = {
    rate_limited: { label: "Rate limited", sentence: "The AI provider is limiting how many requests it accepts (rate limited).", retryable: true, fallback: true, breaker: true },
    overloaded: { label: "Overloaded", sentence: "The AI provider is overloaded right now.", retryable: true, fallback: true, breaker: true },
    server: { label: "Provider error", sentence: "The AI provider had an internal error.", retryable: true, fallback: true, breaker: true },
    timeout: { label: "No answer in time", sentence: "The AI provider did not answer in time.", retryable: true, fallback: true, breaker: true },
    network: { label: "Cannot reach the provider", sentence: "The AI provider could not be reached (network problem).", retryable: true, fallback: true, breaker: true },
    auth: { label: "Key refused", sentence: "The AI provider refused the API key. Check the key set on the server.", retryable: false, fallback: true, breaker: true },
    credit: { label: "Out of credit", sentence: "The AI provider is out of credit. Add credit or raise the spending limit with the provider.", retryable: false, fallback: true, breaker: true },
    model: { label: "Unknown model", sentence: "The AI provider does not offer this model, or the address is wrong. Check the model name.", retryable: false, fallback: true, breaker: false },
    refused: { label: "Answer refused", sentence: "The AI declined to answer this request (content refused).", retryable: false, fallback: false, breaker: false },
    bad_output: { label: "Unusable answer", sentence: "The AI's answer could not be used: no structured output in the expected format, even after asking again.", retryable: false, fallback: false, breaker: false },
    bad_request: { label: "Request rejected", sentence: "The AI provider rejected the request as invalid.", retryable: false, fallback: false, breaker: false },
    paused: { label: "Paused", sentence: "Calls to this AI provider are paused after repeated failures.", retryable: false, fallback: true, breaker: false },
    unknown: { label: "Failed", sentence: "The AI call failed.", retryable: false, fallback: false, breaker: false },
};

export interface LlmErrorInfo {
    cls: LlmErrorClass;
    /** HTTP status, when the provider answered with one (OpenRouter's inner code wins over its outer one). */
    status?: number;
    /** The provider's own words, shortened and with anything key-like hidden. */
    detail?: string;
    /** OpenRouter: the provider that really failed ("Google AI Studio"). */
    upstream?: string;
    /** How long the provider asked us to wait before trying again. */
    retryAfterMs?: number;
}

/** The typed failure every resilient call ends with. `message` is the plain sentence plus the provider's own short detail. */
export class LlmCallError extends Error {
    readonly cls: LlmErrorClass;
    readonly info: LlmErrorInfo;
    /** The model this failure is about (the last one tried). */
    readonly modelName?: string;
    constructor(info: LlmErrorInfo, opts: { modelName?: string; cause?: unknown; sentence?: string } = {}) {
        super(describeLlmError(info, opts.sentence), opts.cause === undefined ? undefined : { cause: opts.cause });
        this.name = "LlmCallError";
        this.cls = info.cls;
        this.info = info;
        this.modelName = opts.modelName;
    }
}

export const isLlmCallError = (e: unknown): e is LlmCallError => e instanceof LlmCallError || (e instanceof Error && e.name === "LlmCallError" && typeof (e as { cls?: unknown }).cls === "string");

/** "The AI provider is out of credit. ... (via OpenRouter, upstream Google AI Studio: Insufficient credits)" */
export function describeLlmError(info: LlmErrorInfo, sentence?: string): string {
    const base = sentence ?? CLASS_RULES[info.cls].sentence;
    const parts = [info.upstream ? `upstream ${info.upstream}` : "", info.detail ?? ""].filter(Boolean);
    return parts.length ? `${base} (${parts.join(": ")})` : base;
}

// ── reading an error ─────────────────────────────────────────────────────────

interface ErrorLike {
    name?: string;
    message?: string;
    statusCode?: number;
    responseBody?: string;
    responseHeaders?: Record<string, string>;
    finishReason?: unknown;
    code?: string;
    cause?: unknown;
    lastError?: unknown;
    reason?: string;
}

const asObj = (e: unknown): ErrorLike => (e && typeof e === "object" ? (e as ErrorLike) : { message: String(e) });

/** Hide anything that looks like a key, collapse space, cap the length: provider texts go into job events and Settings. */
export function scrubDetail(s: string, n = 200): string {
    return s
        .replace(/\b(?:sk|pk|rk|key|AIza)[-_A-Za-z0-9]{12,}/g, "[hidden]")
        .replace(/Bearer\s+\S+/gi, "Bearer [hidden]")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, n);
}

/** The pieces of a provider's JSON error body that say something: message, type/status/code, OpenRouter's metadata. */
export function readErrorBody(body: string | undefined): { message?: string; code?: number; type?: string; raw?: string; upstream?: string; reasons?: string[] } {
    if (!body) return {};
    let json: unknown;
    try {
        json = JSON.parse(body);
    } catch {
        return { message: body.slice(0, 500) };
    }
    const root = (Array.isArray(json) ? json[0] : json) as Record<string, unknown> | undefined;
    const err = (root?.error && typeof root.error === "object" ? root.error : root) as Record<string, unknown> | undefined;
    if (!err) return {};
    const meta = (err.metadata && typeof err.metadata === "object" ? err.metadata : undefined) as Record<string, unknown> | undefined;
    const raw = meta?.raw === undefined ? undefined : typeof meta.raw === "string" ? meta.raw : JSON.stringify(meta.raw);
    const type = [err.type, err.status, typeof err.code === "string" ? err.code : undefined].filter((v): v is string => typeof v === "string").join(" ") || undefined;
    return {
        message: typeof err.message === "string" ? err.message : undefined,
        code: typeof err.code === "number" ? err.code : undefined,
        type,
        raw,
        upstream: typeof meta?.provider_name === "string" ? meta.provider_name : undefined,
        reasons: Array.isArray(meta?.reasons) ? meta.reasons.filter((r): r is string => typeof r === "string") : undefined,
    };
}

/** OpenRouter's `metadata.raw` is the upstream answer as text, often JSON itself: its message is what a person needs. */
function innerMessage(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    const inner = readErrorBody(raw);
    return inner.message ?? raw;
}

/** Retry-After as milliseconds: `retry-after-ms` (OpenAI), `retry-after` in seconds or as a date, or Google's `retryDelay` in the body. */
export function retryAfterMs(headers: Record<string, string> | undefined, body?: string, now: number = Date.now()): number | undefined {
    const h = Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const ms = Number(h["retry-after-ms"]);
    if (h["retry-after-ms"] !== undefined && Number.isFinite(ms) && ms >= 0) return Math.round(ms);
    const ra = h["retry-after"];
    if (ra !== undefined) {
        const s = Number(ra);
        if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000);
        const at = Date.parse(ra);
        if (!Number.isNaN(at)) return Math.max(0, at - now);
    }
    const m = body ? /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body) : null;
    if (m) return Math.round(Number(m[1]) * 1000);
    return undefined;
}

const NETWORK_CODES = /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|ECONNABORTED)$/;

/** Walk `cause` chains (fetch failed -> ECONNREFUSED) and the SDK's RetryError to the innermost useful error. */
function unwrap(e: unknown): { top: ErrorLike; chain: ErrorLike[] } {
    const chain: ErrorLike[] = [];
    let cur: unknown = e;
    for (let i = 0; i < 6 && cur; i++) {
        const o = asObj(cur);
        chain.push(o);
        cur = o.name === "AI_RetryError" && o.lastError ? o.lastError : o.cause;
    }
    // The SDK's RetryError only says "Failed after N attempts": the error it wraps is the one to read.
    const top = chain.find((c) => c.name !== "AI_RetryError") ?? chain[0]!;
    return { top, chain };
}

/**
 * Turn any failure of a model call into a class and a sentence. `timedOut` is set by the caller when its own deadline aborted the
 * request (an abort caused by the job being stopped is not a provider failure and never reaches here).
 */
export function classifyLlmError(e: unknown, opts: { timedOut?: boolean; now?: number } = {}): LlmErrorInfo {
    if (isLlmCallError(e)) return e.info;
    const { top, chain } = unwrap(e);
    const body = readErrorBody(top.responseBody);
    // OpenRouter repeats the upstream status in the body; it is the more precise of the two.
    const status = body.code && body.code >= 400 && body.code < 600 ? body.code : top.statusCode;
    const upstream = body.upstream;
    const inner = innerMessage(body.raw);
    const providerWords = scrubDetail(
        [body.message && !(inner && /provider returned error/i.test(body.message)) ? body.message : "", inner ?? "", body.reasons?.length ? `reasons: ${body.reasons.join(", ")}` : ""].filter(Boolean).join(" - ") ||
            top.message ||
            "",
    );
    const text = [top.message, body.message, body.type, inner, top.responseBody, ...chain.map((c) => `${c.name ?? ""} ${c.code ?? ""} ${c.message ?? ""}`)].filter(Boolean).join(" ").toLowerCase();
    const retryAfter = retryAfterMs(top.responseHeaders, top.responseBody, opts.now);
    const info = (cls: LlmErrorClass, detail = providerWords): LlmErrorInfo => ({
        cls,
        ...(status !== undefined ? { status } : {}),
        ...(detail ? { detail } : {}),
        ...(upstream ? { upstream } : {}),
        ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
    });

    // Our own deadline: the provider never answered.
    if (opts.timedOut) return info("timeout", providerWords && !/abort/i.test(providerWords) ? providerWords : "");

    // The answer arrived but was not what was asked for.
    const finish = typeof top.finishReason === "string" ? top.finishReason : (top.finishReason as { unified?: string } | undefined)?.unified;
    if (finish === "content-filter") return info("refused", "");
    if (["AI_NoObjectGeneratedError", "AI_JSONParseError", "AI_TypeValidationError", "AI_NoOutputGeneratedError"].includes(top.name ?? "") || /no structured output/.test(text)) {
        return info("bad_output", scrubDetail(top.message ?? ""));
    }

    if (status === 402 || /credit balance|insufficient[_ ]quota|insufficient credits|out of credits?|requires more credits|payment required|billing|exceeded your current quota|spend(ing)? limit/.test(text)) return info("credit");
    if (status === 451 || ((status === 400 || status === 403) && /content[_ ]policy|content[_ ]filter|safety|moderation|flagged|refus/.test(text))) return info("refused");
    if (status === 401 || status === 403 || /invalid[_ ]api[_ ]key|incorrect api key|api key not valid|api_key_invalid|authentication[_ ]error|permission[_ ]error|permission_denied|unauthori[sz]ed/.test(text)) return info("auth");
    if (status === 404 || /model[_ ]not[_ ]found|no such model|not_found_error|is not a valid model|model .{0,80} does not exist/.test(text)) return info("model");
    if (status === 429 || /rate[_ ]limit|too many requests|resource[_ ]exhausted/.test(text)) return info("rate_limited");
    if (status === 408 || status === 504 || /timed? ?out|deadline[_ ]exceeded|etimedout|und_err_headers_timeout|und_err_body_timeout/.test(text)) return info("timeout");
    if (status === 503 || status === 529 || /overloaded|no available (model )?provider|over capacity|at capacity|temporarily unavailable|service unavailable/.test(text)) return info("overloaded");
    if (status !== undefined && status >= 500) return info("server");
    if (chain.some((c) => typeof c.code === "string" && NETWORK_CODES.test(c.code)) || /fetch failed|socket hang up|econnrefused|econnreset|enotfound|eai_again|network error|getaddrinfo/.test(text)) {
        return info("network", scrubDetail(chain.map((c) => c.code).find((c) => c && NETWORK_CODES.test(c)) ?? providerWords));
    }
    if (status !== undefined && status >= 400) return info("bad_request");
    return info("unknown");
}

/** Wrap anything thrown by a provider into the typed failure (an error already classified is returned as it is). */
export function toLlmCallError(e: unknown, opts: { modelName?: string; timedOut?: boolean; now?: number } = {}): LlmCallError {
    if (isLlmCallError(e)) return e;
    return new LlmCallError(classifyLlmError(e, opts), { modelName: opts.modelName, cause: e });
}
