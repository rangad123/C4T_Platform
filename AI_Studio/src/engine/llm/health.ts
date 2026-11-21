/**
 * Recent health of the AI models: every request to a model (each attempt, including retries and fallbacks) leaves one small sample:
 * when, which model, worked or not, how long, and the error class in words. Settings shows a summary (success rate, last error,
 * average time to answer).
 *
 * Samples live in memory per process; the platform installs a sink (platform/llm-health.ts) that also writes them to the database
 * so the API process sees what a separate worker process saw. Only counts, times and error classes are kept: never a prompt or an answer.
 */
import { CLASS_RULES, type LlmErrorClass } from "./errors.js";

export interface HealthSample {
    at: number;
    model: string;
    provider: string;
    ok: boolean;
    ms: number;
    cls?: LlmErrorClass;
    /** The plain sentence of the failure (already scrubbed of anything key-like). */
    message?: string;
}

/** Samples kept per model (the newest win). */
export const SAMPLES_PER_MODEL = 100;
/** "Recent" means the last day. */
export const HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000;

export type HealthSink = (s: HealthSample) => void;

class HealthLog {
    private readonly byModel = new Map<string, HealthSample[]>();
    private sink?: HealthSink;

    record(s: HealthSample): void {
        const list = this.byModel.get(s.model) ?? [];
        list.push(s);
        if (list.length > SAMPLES_PER_MODEL) list.splice(0, list.length - SAMPLES_PER_MODEL);
        this.byModel.set(s.model, list);
        try {
            this.sink?.(s);
        } catch {
            // Health is a convenience: a failing store never breaks a model call.
        }
    }
    samples(): HealthSample[] {
        return [...this.byModel.values()].flat();
    }
    setSink(fn: HealthSink | undefined): void {
        this.sink = fn;
    }
    clear(): void {
        this.byModel.clear();
    }
}

/** The process-wide log (model clients are made per job; their health belongs to the platform). */
export const healthLog = new HealthLog();

export interface ModelHealth {
    model: string;
    provider: string;
    calls: number;
    failures: number;
    /** Whole percent of requests that worked, or null with no requests in the window. */
    successRate: number | null;
    /** Average time to answer of the requests that worked, in milliseconds. */
    avgLatencyMs: number | null;
    lastOkAt: string | null;
    lastError: { cls: LlmErrorClass; label: string; message: string; at: string } | null;
}

/** Summaries per model over the window, newest activity first. */
export function summariseHealth(samples: readonly HealthSample[], now: number = Date.now(), windowMs: number = HEALTH_WINDOW_MS): ModelHealth[] {
    const groups = new Map<string, HealthSample[]>();
    for (const s of samples) {
        if (now - s.at > windowMs || s.at > now + 60_000) continue;
        const g = groups.get(s.model) ?? [];
        g.push(s);
        groups.set(s.model, g);
    }
    const out: Array<ModelHealth & { latest: number }> = [];
    for (const [model, list] of groups) {
        list.sort((a, b) => a.at - b.at);
        const ok = list.filter((s) => s.ok);
        const failed = list.filter((s) => !s.ok);
        const last = failed[failed.length - 1];
        out.push({
            model,
            provider: list[list.length - 1]!.provider,
            calls: list.length,
            failures: failed.length,
            successRate: list.length ? Math.round((ok.length / list.length) * 100) : null,
            avgLatencyMs: ok.length ? Math.round(ok.reduce((t, s) => t + s.ms, 0) / ok.length) : null,
            lastOkAt: ok.length ? new Date(ok[ok.length - 1]!.at).toISOString() : null,
            lastError: last ? { cls: last.cls ?? "unknown", label: CLASS_RULES[last.cls ?? "unknown"].label, message: last.message ?? CLASS_RULES[last.cls ?? "unknown"].sentence, at: new Date(last.at).toISOString() } : null,
            latest: list[list.length - 1]!.at,
        });
    }
    return out.sort((a, b) => b.latest - a.latest).map(({ latest: _latest, ...h }) => h);
}

// ── per-job call telemetry (task R, R4) ──────────────────────────────────────

/** One AI call of a job as the meter saw it: what for, how long, how much it wrote, and how its answer was repaired. No prompt or answer. */
export interface CallSample {
    purpose: string;
    ms: number;
    outputTokens: number;
    ok: boolean;
    /** metered.ts `RepairKind`; missing = the answer was fine as it came. */
    repair?: string;
    itemsDropped?: number;
}

/** A job's calls of one purpose: latency and output tokens as median and 95th percentile, and how many answers needed which repair. */
export interface PurposeCalls {
    calls: number;
    failed: number;
    latencyMs: { p50: number; p95: number };
    outputTokens: { p50: number; p95: number; total: number };
    repairs: Record<string, number>;
    itemsDropped: number;
}

/** The nearest-rank percentile (`p` in 0-100) of the values; 0 for none. */
export function percentile(values: readonly number[], p: number): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

/** The samples summed per purpose. */
export function summariseCalls(samples: readonly CallSample[]): Record<string, PurposeCalls> {
    const out: Record<string, PurposeCalls> = {};
    const by = new Map<string, CallSample[]>();
    for (const s of samples) by.set(s.purpose, [...(by.get(s.purpose) ?? []), s]);
    for (const [purpose, list] of by) {
        const ms = list.map((s) => s.ms);
        const tokens = list.map((s) => s.outputTokens);
        const repairs: Record<string, number> = {};
        for (const s of list) if (s.repair) repairs[s.repair] = (repairs[s.repair] ?? 0) + 1;
        out[purpose] = {
            calls: list.length,
            failed: list.filter((s) => !s.ok).length,
            latencyMs: { p50: percentile(ms, 50), p95: percentile(ms, 95) },
            outputTokens: { p50: percentile(tokens, 50), p95: percentile(tokens, 95), total: tokens.reduce((a, b) => a + b, 0) },
            repairs,
            itemsDropped: list.reduce((a, s) => a + (s.itemsDropped ?? 0), 0),
        };
    }
    return out;
}
