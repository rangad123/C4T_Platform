/**
 * The usage meter: wraps one job's `LlmClient` so that every model call is counted and every call is checked against the
 * budgets first. The engine keeps talking to an ordinary `LlmClient`; nothing about the call signatures changes.
 *
 *  - before a call: the job, project and month totals are compared with the caps (`decideBudget`). A call that would pass a cap is
 *    refused with a typed `BudgetExceeded` error and never reaches the model. Nothing is truncated.
 *  - after a call: the tokens the client reported (its `usage` counters moved) are added to the store, labelled with the
 *    call's purpose. A client that reports nothing is counted with an estimate (characters / 4) and flagged as estimated.
 *  - the agent that authors web tests talks to `client.model` directly, so that model is wrapped too (one check per step).
 *
 * The meter counts from the client's own cumulative `usage` object, so it needs no knowledge of the model SDK. With several calls
 * in flight at once the split between purposes can be off by a call (the totals stay exact).
 *
 * Counters: the totals live in memory, seeded from the store at the first call and re-read every `refreshEvery` calls, which
 * is how a worker and the API process (or two workers) sharing one database see each other's spending. Between re-reads another
 * process's usage is not visible, and one call already running when a cap is reached still finishes, so a cap can be passed
 * by about one call per running process. Accounting errors never break a job: if the store cannot be read, calls go ahead.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { wrapLanguageModel, type LanguageModel } from "ai";
import type { EngineEvent } from "../context.js";
import type { LlmClient, Usage } from "./provider.js";
import { answeredSlot } from "./resilience.js";
import { BudgetExceeded, budgetTokens, capDetail, capMessage, decideBudget, estimateTokens, monthOf, normalisePurpose, warningMessage, type CapHit, type Caps, type LlmPurpose, type Used, type UsageBilling } from "./usage.js";

/** What the meter needs from the store (implemented by `platform/usage-store.ts`, replaced by plain objects in unit tests). */
export interface MeterBackend {
    /** `cacheReadTokens`/`cacheWriteTokens`: of the input tokens, prompt-cache reads and writes (prompt-cache.ts); missing = none. */
    addUsage(d: { jobId: string; projectId: string; purpose: string; model: string; at: Date; calls: number; failedCalls: number; inputTokens: number; outputTokens: number; images: number; estimatedCalls: number; cacheReadTokens?: number; cacheWriteTokens?: number; billing?: UsageBilling }): void;
    totalsFor(jobId: string, projectId: string, month: string): Used;
    capsFor(projectId: string, billing?: UsageBilling): { caps: Caps; warnPercent: number };
    recordStop(s: { jobId: string; projectId: string; cap: string; used: number; limit: number; at: string }): void;
}

export interface MeterOptions {
    backend: MeterBackend;
    jobId: string;
    projectId: string;
    emit?: (e: EngineEvent) => void;
    now?: () => Date;
    /** Re-read the stored totals and caps after this many calls (default 5). */
    refreshEvery?: number;
    /** Who pays for this job's calls, written on every usage row; left out, Crowd4Test. */
    billing?: UsageBilling;
}

/**
 * The purpose of a direct model call (`client.model`), when the caller knows it: a model call an exploration on a runner proxies through the
 * platform says what it was for (platform/explore-llm.ts). Left unset, a direct call is the authoring agent's.
 */
export const modelCallPurpose = new AsyncLocalStorage<LlmPurpose>();

export class JobMeter {
    private readonly backend: MeterBackend;
    private readonly now: () => Date;
    private readonly refreshEvery: number;
    /** Totals as of the last read, plus what this meter has added since. */
    private used: Used = { job: 0, project: 0, month: 0 };
    private caps: Caps = {};
    private warnPercent = 80;
    private seededMonth = "";
    private callsSinceRefresh = Number.POSITIVE_INFINITY;
    private lastPurpose: LlmPurpose = "other";
    private inflight = 0;
    private starts = 0;
    private readonly warned = new Set<string>();
    private stopped?: CapHit;
    private brokenWarned = false;
    /** The client's cumulative usage as of the last flush. */
    private seen: Usage = { inputTokens: 0, outputTokens: 0 };
    private client?: LlmClient;
    private modelName = "unknown";

    constructor(private readonly opts: MeterOptions) {
        this.backend = opts.backend;
        this.now = opts.now ?? (() => new Date());
        this.refreshEvery = Math.max(1, opts.refreshEvery ?? 5);
    }

    /** The cap that stopped this job, if one did. */
    get stop(): CapHit | undefined {
        return this.stopped;
    }

    /** Wrap a client. A client with no model behind it (`unavailable`) is returned as it is: nothing to count, and callers test its name. */
    wrap(inner: LlmClient): LlmClient {
        if (inner.modelName === "unavailable") return inner;
        this.client = inner;
        this.modelName = inner.modelName;
        this.seen = { ...inner.usage };
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const meter = this;
        let wrappedModel: LanguageModel | undefined;

        const wrapped: LlmClient = {
            modelName: inner.modelName,
            // The same counters object on purpose: the engine reads it for the job totals and the authoring agent adds to it.
            usage: inner.usage,
            get model(): LanguageModel {
                if (wrappedModel) return wrappedModel;
                const real = inner.model;
                // A model given as a plain id string cannot be wrapped; its calls are then counted through `usage` at the next call.
                wrappedModel = typeof real === "string" || real.specificationVersion !== "v3" ? real : wrapLanguageModel({ model: real, middleware: meter.middleware() });
                return wrappedModel;
            },
            object: (async (args: Parameters<LlmClient["object"]>[0]) =>
                meter.call(normalisePurpose(args.purpose), estimateTokens(args.system + args.prompt), 0, () => inner.object(args), (r) => estimateTokens(JSON.stringify(r) ?? ""))) as LlmClient["object"],
            text: async (args) => meter.call(normalisePurpose(args.purpose), estimateTokens(args.system + args.prompt), 0, () => inner.text(args), (r) => estimateTokens(r)),
        };
        if (typeof inner.setEventSink === "function") wrapped.setEventSink = (fn) => inner.setEventSink!(fn);
        // "Can this client look at images" must stay true or false exactly as the inner client says.
        if (typeof inner.imageObject === "function") {
            wrapped.imageObject = (async (args: Parameters<NonNullable<LlmClient["imageObject"]>>[0]) =>
                meter.call(normalisePurpose(args.purpose ?? "vision"), estimateTokens(args.system + args.prompt), args.images.length, () => inner.imageObject!(args), (r) => estimateTokens(JSON.stringify(r) ?? ""))) as NonNullable<LlmClient["imageObject"]>;
        }
        return wrapped;
    }

    /** Write what the client has used since the last flush (call when the job ends, so a last agent step is not lost). */
    finish(): void {
        this.guard(() => this.flush(this.lastPurpose));
    }

    // ── the middleware for the authoring agent's direct model use ────────────

    private middleware() {
        return {
            specificationVersion: "v3" as const,
            wrapGenerate: async ({ doGenerate }: { doGenerate: () => PromiseLike<any> }) => {
                const purpose = modelCallPurpose.getStore() ?? "authoring";
                const token = this.enter(purpose, 0);
                const slot: { model?: string } = {};
                try {
                    const out = await answeredSlot.run(slot, () => doGenerate());
                    this.answered(slot);
                    // Tokens arrive through the client's `usage` (the agent adds each step's numbers); only the call is counted here.
                    this.leave(token, purpose, { ok: true, images: 0, count: true, estimate: false });
                    return out;
                } catch (e) {
                    this.answered(slot);
                    this.leave(token, purpose, { ok: false, images: 0, count: true, estimate: false });
                    throw e;
                }
            },
        };
    }

    // ── one wrapped call ─────────────────────────────────────────────────────

    private async call<R>(purpose: LlmPurpose, incoming: number, images: number, run: () => Promise<R>, outputEstimate: (r: R) => number): Promise<R> {
        const token = this.enter(purpose, incoming);
        // The resilient model writes which model answered (a fallback, perhaps) into this slot: usage and cost are recorded per model.
        const slot: { model?: string } = {};
        try {
            const result = await answeredSlot.run(slot, run);
            this.answered(slot);
            this.leave(token, purpose, { ok: true, images, count: true, estimate: true, incoming, outputEstimate: safe(() => outputEstimate(result)) });
            return result;
        } catch (e) {
            this.answered(slot);
            this.leave(token, purpose, { ok: false, images, count: true, estimate: false });
            throw e;
        }
    }

    /** The model of the call that just ended becomes the one its tokens (and later flushed agent tokens) are recorded under. */
    private answered(slot: { model?: string }): void {
        if (slot.model) this.modelName = slot.model;
    }

    /** Check the budgets; throws BudgetExceeded. Returns a token identifying the call for `leave`. */
    private enter(purpose: LlmPurpose, incoming: number): { overlapped: boolean; startNo: number } {
        this.guard(() => {
            // What earlier calls used is counted first, so the check below sees it.
            this.flush(this.lastPurpose);
            this.refreshIfDue();
        });
        const decision = decideBudget(this.used, this.caps, { incoming, warnPercent: this.warnPercent });
        if (!decision.allowed) throw this.refuse(decision.blocked!);
        this.warn(decision.warnings);
        this.lastPurpose = purpose;
        const overlapped = this.inflight > 0;
        this.inflight++;
        this.starts++;
        return { overlapped, startNo: this.starts };
    }

    private leave(
        token: { overlapped: boolean; startNo: number },
        purpose: LlmPurpose,
        r: { ok: boolean; images: number; count: boolean; estimate: boolean; incoming?: number; outputEstimate?: number },
    ): void {
        this.inflight--;
        this.guard(() => {
            const delta = this.delta();
            const overlapped = token.overlapped || this.starts !== token.startNo;
            // No usage reported by the client for a call that worked: count an estimate, unless other calls ran at the same time
            // (their numbers may have been taken by whichever call finished first).
            const estimated = r.ok && r.estimate && delta.inputTokens + delta.outputTokens === 0 && !overlapped;
            const inputTokens = estimated ? (r.incoming ?? 0) : delta.inputTokens;
            const outputTokens = estimated ? (r.outputEstimate ?? 0) : delta.outputTokens;
            this.seen = { ...this.client!.usage };
            this.record(purpose, { calls: r.count ? 1 : 0, failedCalls: r.ok ? 0 : 1, inputTokens, outputTokens, images: r.images, estimatedCalls: estimated ? 1 : 0, ...cacheOf(delta) });
            this.callsSinceRefresh++;
            // A cap can be reached by this very call: say so now rather than at the next one.
            const d = decideBudget(this.used, this.caps, { warnPercent: this.warnPercent });
            this.warn(d.blocked ? [...d.warnings, d.blocked] : d.warnings);
        });
    }

    // ── counters ─────────────────────────────────────────────────────────────

    private delta(): Usage {
        const u = this.client!.usage;
        return {
            inputTokens: Math.max(0, u.inputTokens - this.seen.inputTokens),
            outputTokens: Math.max(0, u.outputTokens - this.seen.outputTokens),
            // Prompt-cache counters (prompt-cache.ts) move with the input tokens they are part of.
            cacheReadTokens: Math.max(0, (u.cacheReadTokens ?? 0) - (this.seen.cacheReadTokens ?? 0)),
            cacheWriteTokens: Math.max(0, (u.cacheWriteTokens ?? 0) - (this.seen.cacheWriteTokens ?? 0)),
        };
    }

    /** Store tokens the client has used since the last flush (steps of the authoring agent arrive this way). */
    private flush(purpose: LlmPurpose): void {
        if (!this.client) return;
        const d = this.delta();
        if (d.inputTokens + d.outputTokens === 0) return;
        this.seen = { ...this.client.usage };
        this.record(purpose, { calls: 0, failedCalls: 0, inputTokens: d.inputTokens, outputTokens: d.outputTokens, images: 0, estimatedCalls: 0, ...cacheOf(d) });
    }

    private record(purpose: LlmPurpose, c: { calls: number; failedCalls: number; inputTokens: number; outputTokens: number; images: number; estimatedCalls: number; cacheReadTokens?: number; cacheWriteTokens?: number }): void {
        // What the limits count: prompt-cache reads and writes at their weight (usage.ts `budgetTokens`); input + output without caching.
        const tokens = budgetTokens(c);
        // In memory first: the totals stay right even if the store write fails.
        this.used = { job: this.used.job + tokens, project: this.used.project + tokens, month: this.used.month + tokens };
        this.backend.addUsage({ jobId: this.opts.jobId, projectId: this.opts.projectId, purpose, model: this.modelName, at: this.now(), ...c, ...(this.opts.billing ? { billing: this.opts.billing } : {}) });
    }

    private refreshIfDue(): void {
        const month = monthOf(this.now());
        if (this.callsSinceRefresh < this.refreshEvery && month === this.seededMonth) return;
        this.used = this.backend.totalsFor(this.opts.jobId, this.opts.projectId, month);
        const c = this.backend.capsFor(this.opts.projectId, this.opts.billing);
        this.caps = c.caps;
        this.warnPercent = c.warnPercent;
        this.seededMonth = month;
        this.callsSinceRefresh = 0;
    }

    // ── events and the stop ──────────────────────────────────────────────────

    private warn(hits: CapHit[]): void {
        for (const h of hits) {
            if (this.warned.has(h.cap)) continue;
            this.warned.add(h.cap);
            this.opts.emit?.({ stage: "orchestration", kind: "ai_budget_warning", level: "warn", message: warningMessage(h), data: { cap: h.cap, used: h.used, limit: h.limit } });
        }
    }

    private refuse(hit: CapHit): BudgetExceeded {
        if (!this.stopped) {
            this.stopped = hit;
            this.guard(() => this.backend.recordStop({ jobId: this.opts.jobId, projectId: this.opts.projectId, cap: hit.cap, used: hit.used, limit: hit.limit, at: this.now().toISOString() }));
            this.opts.emit?.({
                stage: "orchestration",
                kind: "ai_budget_stop",
                level: "warn",
                message: `${capMessage(hit.cap)}. ${capDetail(hit)} AI work stops here; what was already created is kept.`,
                data: { cap: hit.cap, used: hit.used, limit: hit.limit },
            });
        }
        return new BudgetExceeded(hit);
    }

    /** Accounting must never break a job: a failure here is logged once and the call goes ahead. */
    private guard(fn: () => void): void {
        try {
            fn();
        } catch (e) {
            if (!this.brokenWarned) {
                this.brokenWarned = true;
                console.error("[usage] AI usage could not be recorded:", e instanceof Error ? e.message : e);
            }
        }
    }
}

/** The prompt-cache counts of a delta, only when there are any (so rows of a client that never caches look exactly as before). */
function cacheOf(d: Usage): { cacheReadTokens?: number; cacheWriteTokens?: number } {
    return { ...(d.cacheReadTokens ? { cacheReadTokens: d.cacheReadTokens } : {}), ...(d.cacheWriteTokens ? { cacheWriteTokens: d.cacheWriteTokens } : {}) };
}

function safe(fn: () => number): number {
    try {
        return fn();
    } catch {
        return 0;
    }
}
