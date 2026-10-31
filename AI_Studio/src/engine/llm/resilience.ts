/**
 * Model calls that survive a bad minute at the provider.
 *
 * `ResilientModel` is an ordinary AI SDK language model (so the engine, the usage meter and the web authoring agent use it unchanged)
 * that stands in front of a chain of real models: the primary first, then the fallback models in order.
 *  - each request gets its own time limit, and the whole call a deadline (retries and fallbacks included);
 *  - a failure is classified (errors.ts); the retryable ones (rate limited, overloaded, provider error, no answer in time, network)
 *    are asked again after an exponential wait with jitter, at least as long as the provider's Retry-After;
 *  - when a model stays unavailable (or is out of credit, or its key is refused) the next model of the chain is asked;
 *  - a circuit breaker per provider stops calling a provider for a while after several failures in a row, so a dead provider does
 *    not cost every job minutes of waiting; after the pause one trial request decides whether it is back;
 *  - what happened is told to the job (retries, fallbacks, pauses, which model answered) and to the health log.
 *
 * Retries live here, not in the SDK: the client sets the SDK's own retries to zero, and the error this model throws is never one the
 * SDK would retry, so a call is never retried twice over.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { LanguageModel } from "ai";
import type { EngineEvent } from "../context.js";
import { CLASS_RULES, LlmCallError, classifyLlmError, describeLlmError, scrubDetail, type LlmErrorInfo } from "./errors.js";
import { healthLog } from "./health.js";

export type ModelV3 = Extract<LanguageModel, { specificationVersion: "v3" }>;
type CallOptions = Parameters<ModelV3["doGenerate"]>[0];

export interface ResiliencePolicy {
    /** Requests per model for one call (1 = no retry). */
    attempts: number;
    /** First wait between retries; doubles each time. */
    baseDelayMs: number;
    maxDelayMs: number;
    /** A provider asking for a longer wait than this is treated as unavailable for this call (the next model is asked). */
    maxRetryAfterMs: number;
    /** Time limit of one request. */
    attemptTimeoutMs: number;
    /** Time limit of the whole call, retries and fallbacks included. */
    deadlineMs: number;
    /** Failures in a row that pause a provider. */
    breakerFailures: number;
    /** How long a paused provider is left alone. */
    breakerCooldownMs: number;
}

export const DEFAULT_POLICY: ResiliencePolicy = {
    // Five waits of 1, 2, 4, 8 and 16 s (with jitter) ride out about half a minute of network or rate-limit trouble.
    attempts: 6,
    baseDelayMs: 1000,
    maxDelayMs: 30_000,
    maxRetryAfterMs: 60_000,
    attemptTimeoutMs: 120_000,
    deadlineMs: 600_000,
    breakerFailures: 5,
    breakerCooldownMs: 60_000,
};

/** The wait before retry number `retry` (0-based): exponential, capped, with jitter between half and all of it. */
export function backoffDelay(retry: number, policy: Pick<ResiliencePolicy, "baseDelayMs" | "maxDelayMs">, random: () => number = Math.random): number {
    const full = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** retry);
    return Math.round(full * (0.5 + 0.5 * random()));
}

// ── circuit breaker ──────────────────────────────────────────────────────────

export type BreakerGate = { ok: true; trial: boolean } | { ok: false; until: number };

/**
 * closed: calls go through, failures in a row are counted. open: no calls until `until`. After that one trial call is let through
 * (half-open): success closes the breaker, failure opens it again for another cooldown.
 */
export class CircuitBreaker {
    private failures = 0;
    private openUntil = 0;
    private trialRunning = false;
    lastError?: string;

    constructor(
        readonly key: string,
        private readonly threshold: number,
        private readonly cooldownMs: number,
        private readonly now: () => number = Date.now,
    ) {}

    check(): BreakerGate {
        if (this.openUntil === 0) return { ok: true, trial: false };
        if (this.now() < this.openUntil) return { ok: false, until: this.openUntil };
        if (this.trialRunning) return { ok: false, until: this.openUntil };
        this.trialRunning = true;
        return { ok: true, trial: true };
    }
    success(): void {
        this.failures = 0;
        this.openUntil = 0;
        this.trialRunning = false;
    }
    /** Counts a failure; true when this failure opened (or re-opened) the breaker. */
    failure(message?: string): boolean {
        this.lastError = message;
        this.failures++;
        if (this.trialRunning || (this.openUntil === 0 && this.failures >= this.threshold)) {
            this.trialRunning = false;
            this.openUntil = this.now() + this.cooldownMs;
            return true;
        }
        return false;
    }
    /** A trial call that ended without a verdict on the provider (for example a refused answer) lets the next one try. */
    release(): void {
        this.trialRunning = false;
    }
    state(): { key: string; open: boolean; until: string | null; failuresInARow: number; lastError: string | null } {
        const open = this.openUntil !== 0 && this.now() < this.openUntil;
        return { key: this.key, open, until: this.openUntil ? new Date(this.openUntil).toISOString() : null, failuresInARow: this.failures, lastError: this.lastError ?? null };
    }
}

const breakers = new Map<string, CircuitBreaker>();

/** One breaker per provider and address, shared by every job of this process. */
export function breakerFor(key: string, policy: Pick<ResiliencePolicy, "breakerFailures" | "breakerCooldownMs">, now?: () => number): CircuitBreaker {
    let b = breakers.get(key);
    if (!b) breakers.set(key, (b = new CircuitBreaker(key, policy.breakerFailures, policy.breakerCooldownMs, now)));
    return b;
}
export function breakerStates(): ReturnType<CircuitBreaker["state"]>[] {
    return [...breakers.values()].map((b) => b.state());
}
/** Tests only. */
export function resetBreakers(): void {
    breakers.clear();
}

// ── which model answered ─────────────────────────────────────────────────────

/**
 * The usage meter runs each call inside a slot; the resilient model writes the name of the model that answered (or was tried last)
 * into it. AsyncLocalStorage keeps concurrent calls of one job apart.
 */
export const answeredSlot = new AsyncLocalStorage<{ model?: string }>();

// ── the chain ────────────────────────────────────────────────────────────────

export interface ChainEntry {
    /** The model name as people know it (used for usage, prices and events). */
    name: string;
    /** anthropic | openai | google | openai-compatible */
    provider: string;
    /** Breaker key: the provider and, for custom endpoints, its address. */
    breakerKey: string;
    model: ModelV3;
}

/** Events a job is told about one resilient model; more than this per job are dropped (a dead provider must not flood the log). */
const MAX_EVENTS = 40;

const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 100) / 10} s`);

export interface ResilientOptions {
    policy?: Partial<ResiliencePolicy>;
    now?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    random?: () => number;
    /**
     * A deliberate connection check: it is sent even while the provider is paused (a success ends the pause), and it is the person's
     * own request, so nothing about it is told to a job.
     */
    probe?: boolean;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const t = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(t);
            reject(signal!.reason);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

export class ResilientModel implements ModelV3 {
    readonly specificationVersion = "v3" as const;
    readonly provider: string;
    readonly modelId: string;
    readonly policy: ResiliencePolicy;
    private readonly now: () => number;
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    private readonly random: () => number;
    private readonly probe: boolean;
    private sink?: (e: EngineEvent) => void;
    private events = 0;
    private readonly answeredOnce = new Set<string>();
    private readonly pausedTold = new Set<string>();
    /** The last model that answered (for callers without a slot). */
    lastAnswered?: string;

    constructor(
        readonly chain: readonly ChainEntry[],
        opts: ResilientOptions = {},
    ) {
        if (chain.length === 0) throw new Error("A model chain needs at least one model");
        this.provider = chain[0]!.model.provider;
        this.modelId = chain[0]!.model.modelId;
        this.policy = { ...DEFAULT_POLICY, ...opts.policy };
        this.now = opts.now ?? Date.now;
        this.sleep = opts.sleep ?? defaultSleep;
        this.random = opts.random ?? Math.random;
        this.probe = opts.probe ?? false;
    }

    get supportedUrls() {
        return this.chain[0]!.model.supportedUrls;
    }

    /** Where this model tells the job what happened (retries, fallbacks, pauses, which model answered). */
    setEventSink(fn: ((e: EngineEvent) => void) | undefined): void {
        this.sink = fn;
    }

    private emit(kind: string, level: "info" | "warn", message: string, data: Record<string, unknown>): void {
        if (!this.sink || this.events >= MAX_EVENTS) return;
        this.events++;
        try {
            this.sink({ stage: "orchestration", kind, level, message, data });
        } catch {
            // Telling the job is best effort.
        }
    }

    private answered(entry: ChainEntry, index: number): void {
        this.lastAnswered = entry.name;
        const slot = answeredSlot.getStore();
        if (slot) slot.model = entry.name;
        if (this.answeredOnce.has(entry.name)) return;
        this.answeredOnce.add(entry.name);
        this.emit("ai_model_answered", "info", index === 0 ? `The AI model ${entry.name} answered.` : `The fallback AI model ${entry.name} answered.`, { model: entry.name, provider: entry.provider, fallback: index > 0 });
    }

    async doGenerate(options: CallOptions): Promise<Awaited<ReturnType<ModelV3["doGenerate"]>>> {
        return this.run(options, (entry, opts) => entry.model.doGenerate(opts), true);
    }

    /** Streams are only retried or moved to a fallback before the first part arrives. */
    async doStream(options: CallOptions): Promise<Awaited<ReturnType<ModelV3["doStream"]>>> {
        return this.run(options, (entry, opts) => entry.model.doStream(opts), false);
    }

    private async run<R>(options: CallOptions, call: (entry: ChainEntry, opts: CallOptions) => PromiseLike<R>, retry: boolean): Promise<R> {
        const callerSignal = options.abortSignal;
        const started = this.now();
        const deadline = started + this.policy.deadlineMs;
        let last: LlmCallError | undefined;
        const p = this.policy;

        for (let i = 0; i < this.chain.length; i++) {
            const entry = this.chain[i]!;
            const breaker = breakerFor(entry.breakerKey, p, this.now);
            const attempts = retry ? Math.max(1, p.attempts) : 1;
            let info: LlmErrorInfo | undefined;
            for (let attempt = 0; attempt < attempts; attempt++) {
                if (callerSignal?.aborted) throw callerSignal.reason ?? new Error("aborted");
                const gate: BreakerGate = this.probe ? { ok: true, trial: false } : breaker.check();
                if (!gate.ok) {
                    info = { cls: "paused", detail: `until ${new Date(gate.until).toISOString().slice(11, 16)} UTC${breaker.lastError ? `, last: ${breaker.lastError}` : ""}` };
                    last = new LlmCallError(info, { modelName: entry.name });
                    if (!this.pausedTold.has(entry.breakerKey)) {
                        this.pausedTold.add(entry.breakerKey);
                        this.emit("ai_provider_paused", "warn", `Calls to the AI provider of ${entry.name} are paused until ${new Date(gate.until).toISOString().slice(11, 16)} UTC after repeated failures${i + 1 < this.chain.length ? "; the next model is asked instead" : ""}.`, {
                            model: entry.name,
                            provider: entry.provider,
                            until: new Date(gate.until).toISOString(),
                        });
                    }
                    break;
                }
                const remaining = deadline - this.now();
                if (remaining <= 0) {
                    throw new LlmCallError({ cls: "timeout", detail: `the call took longer than its ${seconds(p.deadlineMs)} limit` }, { modelName: entry.name });
                }
                const slot = answeredSlot.getStore();
                if (slot) slot.model = entry.name;
                const ctrl = new AbortController();
                let timedOut = false;
                const timer = setTimeout(() => {
                    timedOut = true;
                    ctrl.abort(new Error(`No answer within ${seconds(Math.min(p.attemptTimeoutMs, remaining))}`));
                }, Math.min(p.attemptTimeoutMs, remaining));
                const onCallerAbort = () => ctrl.abort(callerSignal?.reason);
                callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
                const t0 = this.now();
                try {
                    const res = await call(entry, { ...options, abortSignal: ctrl.signal });
                    breaker.success();
                    healthLog.record({ at: this.now(), model: entry.name, provider: entry.provider, ok: true, ms: this.now() - t0 });
                    this.answered(entry, i);
                    return res;
                } catch (err) {
                    // The job was stopped: not a provider failure, nothing to retry or record.
                    if (callerSignal?.aborted && !timedOut) {
                        breaker.release();
                        throw err;
                    }
                    info = classifyLlmError(err, { timedOut, now: this.now() });
                    last = new LlmCallError(info, { modelName: entry.name, cause: err });
                    const rule = CLASS_RULES[info.cls];
                    healthLog.record({ at: this.now(), model: entry.name, provider: entry.provider, ok: false, ms: this.now() - t0, cls: info.cls, message: scrubDetail(describeLlmError(info), 300) });
                    if (rule.breaker) {
                        if (breaker.failure(rule.label)) {
                            this.emit("ai_provider_paused", "warn", `The AI provider of ${entry.name} failed ${p.breakerFailures} times in a row (${rule.label.toLowerCase()}); calls to it are paused for ${seconds(p.breakerCooldownMs)}.`, {
                                model: entry.name,
                                provider: entry.provider,
                                cls: info.cls,
                            });
                        }
                    } else {
                        breaker.release();
                    }
                    if (!rule.retryable || attempt === attempts - 1) break;
                    const wait = Math.max(backoffDelay(attempt, p, this.random), info.retryAfterMs ?? 0);
                    // A provider asking for a long pause, or a wait past the deadline: this model is unavailable for this call.
                    if ((info.retryAfterMs ?? 0) > p.maxRetryAfterMs || this.now() + wait >= deadline) break;
                    this.emit("ai_model_retry", "info", `${rule.sentence} Asking ${entry.name} again in ${seconds(wait)} (attempt ${attempt + 2} of ${attempts}).`, { model: entry.name, cls: info.cls, waitMs: wait, attempt: attempt + 2 });
                    await this.sleep(wait, callerSignal);
                } finally {
                    clearTimeout(timer);
                    callerSignal?.removeEventListener("abort", onCallerAbort);
                }
            }
            // A failure no other model would fix (a refused answer, an invalid request) ends the call here.
            if (!info || !CLASS_RULES[info.cls].fallback) throw last!;
            const next = this.chain[i + 1];
            if (next) {
                this.emit("ai_model_fallback", "warn", `${entry.name} is unavailable (${CLASS_RULES[info.cls].label.toLowerCase()}); asking the fallback model ${next.name}.`, { from: entry.name, to: next.name, cls: info.cls });
            }
        }
        throw last!;
    }
}

export const isResilientModel = (m: unknown): m is ResilientModel => m instanceof ResilientModel;
