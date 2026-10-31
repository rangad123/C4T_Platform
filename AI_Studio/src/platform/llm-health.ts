/**
 * The platform side of AI model reliability (docs/features/ai-model-reliability.md):
 *  - the fallback model list saved in Settings (wins over LLM_FALLBACK_MODELS),
 *  - the recent health of each model, shared between the API process and separate worker processes through the database,
 *  - the "Check the connection" call (one tiny request, counted as AI usage).
 *
 * Storage: the key/value table `ai_settings` of the AI usage feature (no migration of its own). Each process writes its own health
 * row (`llm_health:<process id>`), so two processes never overwrite each other; readers merge the rows and ignore old ones.
 * Only counts, times, model names and error classes are stored: never a prompt, an answer or a key.
 */
import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { CLASS_RULES, isLlmCallError, toLlmCallError, type LlmErrorClass } from "../engine/llm/errors.js";
import { healthLog, HEALTH_WINDOW_MS, summariseHealth, type HealthSample, type ModelHealth } from "../engine/llm/health.js";
import { configuredFallbacks, createLlmClient, describeFallbacks, LlmNotConfiguredError, parseFallbackModels, setFallbackModelSource, type FallbackModel, type LlmProviderId } from "../engine/llm/provider.js";
import { breakerStates } from "../engine/llm/resilience.js";
import type { Db } from "./db.js";
import { SettingsCache } from "./settings-cache.js";
import { usageStoreFor } from "./usage-store.js";

const FALLBACK_KEY = "llm_fallback_models";
const HEALTH_PREFIX = "llm_health:";
/** Health rows of processes silent for this long are removed. */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
/** Samples one process keeps in its row. */
const MAX_STORED = 400;
const WRITE_EVERY_MS = 1000;

/** The usage of connection checks is recorded under this project id (the usage page names it "Connection checks"). */
export const CONNECTION_CHECK_PROJECT = "_connection_check";
export const CONNECTION_CHECK_JOB = "connection-check";

const instanceKey = `${HEALTH_PREFIX}${randomUUID()}`;

function setting(db: Db, key: string): string | null | undefined {
    try {
        const row = db.get<{ value: string | null }>("SELECT value FROM ai_settings WHERE key = ?", key);
        return row ? row.value : undefined;
    } catch {
        return undefined;
    }
}
function putSetting(db: Db, key: string, value: string | null): void {
    db.run("INSERT INTO ai_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
}

// ── fallback models saved in Settings ────────────────────────────────────────

/** The list saved in the app, or undefined when nobody saved one (then the environment's list is used). */
export function savedFallbacks(db: Db): string[] | undefined {
    const raw = setting(db, FALLBACK_KEY);
    if (raw === undefined || raw === null) return undefined;
    try {
        const v = JSON.parse(raw) as unknown;
        return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : undefined;
    } catch {
        return undefined;
    }
}

/** Save the list (`null` = forget it and use the environment's again). Returns the entries as they will be used. */
export function saveFallbacks(db: Db, config: Config, models: string[] | null): Array<{ provider: LlmProviderId; model: string }> {
    if (models === null) {
        db.run("DELETE FROM ai_settings WHERE key = ?", FALLBACK_KEY);
        void fallbackCache?.refresh();
        return configuredFallbacks(config).entries;
    }
    const entries = parseFallbackModels(models, config.LLM_PROVIDER);
    putSetting(db, FALLBACK_KEY, JSON.stringify(entries.map((e) => (e.provider === config.LLM_PROVIDER ? e.model : `${e.provider}:${e.model}`))));
    void fallbackCache?.refresh();
    return entries;
}

/** What the engine reads (settings-cache.ts): a save here is seen at once, one on another process within the refresh interval. */
let fallbackCache: SettingsCache<string[] | undefined> | undefined;

// ── health shared between processes ──────────────────────────────────────────

let installedDb: Db | undefined;
let writeTimer: NodeJS.Timeout | undefined;

/** Write this process's recent samples to its own row now. */
export function flushLlmHealth(db: Db | undefined = installedDb): void {
    if (writeTimer) {
        clearTimeout(writeTimer);
        writeTimer = undefined;
    }
    if (!db) return;
    try {
        const now = Date.now();
        const samples = healthLog
            .samples()
            .filter((s) => now - s.at <= HEALTH_WINDOW_MS)
            .sort((a, b) => a.at - b.at)
            .slice(-MAX_STORED);
        putSetting(db, instanceKey, JSON.stringify({ updatedAt: now, samples, breakers: breakerStates() }));
    } catch {
        // Health is a convenience: never a reason for a model call to fail.
    }
}

function scheduleWrite(): void {
    if (writeTimer || !installedDb) return;
    writeTimer = setTimeout(() => flushLlmHealth(), WRITE_EVERY_MS);
    writeTimer.unref?.();
}

interface StoredHealth {
    updatedAt: number;
    samples: HealthSample[];
    breakers: ReturnType<typeof breakerStates>;
}

/** Samples and provider pauses of every process: this one from memory, the others from their rows. Old rows are removed. */
function allHealth(db: Db, now: number): { samples: HealthSample[]; breakers: ReturnType<typeof breakerStates> } {
    const samples: HealthSample[] = [...healthLog.samples()];
    const breakers = [...breakerStates()];
    let rows: Array<{ key: string; value: string | null }> = [];
    try {
        rows = db.all("SELECT key, value FROM ai_settings WHERE key LIKE ?", `${HEALTH_PREFIX}%`) as Array<{ key: string; value: string | null }>;
    } catch {
        rows = [];
    }
    for (const r of rows) {
        if (r.key === instanceKey || !r.value) continue;
        let h: StoredHealth | undefined;
        try {
            h = JSON.parse(r.value) as StoredHealth;
        } catch {
            h = undefined;
        }
        if (!h || typeof h.updatedAt !== "number" || now - h.updatedAt > STALE_MS) {
            try {
                db.run("DELETE FROM ai_settings WHERE key = ?", r.key);
            } catch {
                /* another process may have removed it */
            }
            continue;
        }
        if (Array.isArray(h.samples)) samples.push(...h.samples.filter((s) => s && typeof s.at === "number" && typeof s.model === "string"));
        if (Array.isArray(h.breakers)) breakers.push(...h.breakers.filter((b) => b && b.open));
    }
    return { samples, breakers };
}

export interface LlmHealthView {
    configured: boolean;
    provider: string;
    model: string;
    fallbacks: FallbackModel[];
    /** app = saved in Settings, environment = LLM_FALLBACK_MODELS, none = no fallback. */
    fallbackSource: "app" | "environment" | "none";
    environmentFallbacks: string[];
    windowHours: number;
    models: ModelHealth[];
    /** Providers whose calls are paused right now (circuit breaker). */
    paused: Array<{ provider: string; until: string; lastError: string | null }>;
    errorClasses: Record<LlmErrorClass, string>;
}

export function llmHealthView(db: Db, config: Config, modelName: string, now: number = Date.now()): LlmHealthView {
    const { entries, source } = configuredFallbacks(config);
    const { samples, breakers } = allHealth(db, now);
    const paused = new Map<string, { provider: string; until: string; lastError: string | null }>();
    for (const b of breakers) {
        if (!b.open || !b.until) continue;
        const prev = paused.get(b.key);
        // The provider name only: a custom endpoint's address is server configuration and stays on the server.
        const provider = b.key.split(" ")[0]!;
        if (!prev || prev.until < b.until) paused.set(b.key, { provider, until: b.until, lastError: b.lastError });
    }
    return {
        configured: modelName !== "unavailable",
        provider: config.LLM_PROVIDER,
        model: modelName,
        fallbacks: describeFallbacks(config, entries),
        fallbackSource: source,
        environmentFallbacks: parseFallbackModels(config.LLM_FALLBACK_MODELS, config.LLM_PROVIDER).map((e) => (e.provider === config.LLM_PROVIDER ? e.model : `${e.provider}:${e.model}`)),
        windowHours: HEALTH_WINDOW_MS / 3_600_000,
        models: summariseHealth(samples, now),
        paused: [...paused.values()],
        errorClasses: Object.fromEntries(Object.entries(CLASS_RULES).map(([k, v]) => [k, v.label])) as Record<LlmErrorClass, string>,
    };
}

// ── the connection check ─────────────────────────────────────────────────────

export interface CheckResult {
    ok: boolean;
    model: string;
    latencyMs: number;
    /** What went wrong, in words (never the key or the server's address). */
    error?: { cls: LlmErrorClass; label: string; message: string };
}

let checkRunning = false;
let lastCheckAt = 0;
/** Two checks closer together than this are refused: each one is a paid request. */
export const CHECK_MIN_INTERVAL_MS = 5000;

export class CheckRefused extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

/**
 * One tiny request to the main model alone (no fallback, one attempt), sent even while the provider is paused. It counts as AI usage
 * and respects the monthly AI limit.
 */
export async function checkConnection(db: Db, config: Config, opts: { baseURLFor?: (p: LlmProviderId) => string | undefined; now?: () => number } = {}): Promise<CheckResult> {
    const now = opts.now ?? Date.now;
    if (checkRunning) throw new CheckRefused(409, "A connection check is already running.");
    if (now() - lastCheckAt < CHECK_MIN_INTERVAL_MS) throw new CheckRefused(429, "Wait a few seconds before checking again.");
    const usage = usageStoreFor(db, config);
    const block = usage.monthlyBlock(CONNECTION_CHECK_PROJECT);
    if (block) throw new CheckRefused(409, "The AI token limit for this month was reached, so the connection was not checked. Raise the limit in Settings or wait until next month.");
    let client;
    try {
        client = createLlmClient(config, { fallbacks: [], baseURLFor: opts.baseURLFor, resilience: { probe: true, policy: { attempts: 1, attemptTimeoutMs: 20_000, deadlineMs: 25_000 } } });
    } catch (e) {
        if (e instanceof LlmNotConfiguredError) throw new CheckRefused(409, "No AI model is set up on this server yet, so there is nothing to check.");
        throw e;
    }
    checkRunning = true;
    lastCheckAt = now();
    const t0 = now();
    let result: CheckResult;
    try {
        await client.text({ system: "You answer connection checks.", prompt: "Reply with the single word OK.", maxOutputTokens: 16, purpose: "other" });
        result = { ok: true, model: client.modelName, latencyMs: now() - t0 };
    } catch (e) {
        const err = isLlmCallError(e) ? e : toLlmCallError(e, { modelName: client.modelName });
        result = { ok: false, model: client.modelName, latencyMs: now() - t0, error: { cls: err.cls, label: CLASS_RULES[err.cls].label, message: err.message } };
    } finally {
        checkRunning = false;
    }
    try {
        usage.addUsage({
            jobId: CONNECTION_CHECK_JOB,
            projectId: CONNECTION_CHECK_PROJECT,
            purpose: "other",
            model: client.modelName,
            at: new Date(now()),
            calls: 1,
            failedCalls: result.ok ? 0 : 1,
            inputTokens: client.usage.inputTokens,
            outputTokens: client.usage.outputTokens,
            images: 0,
            estimatedCalls: 0,
        });
    } catch {
        // Counting must not hide the answer of the check.
    }
    flushLlmHealth(db);
    return result;
}

/** Tests only: forget the last check time. */
export function resetConnectionCheck(): void {
    checkRunning = false;
    lastCheckAt = 0;
}

/**
 * Called once per process (bootstrap): the Settings list becomes the fallback source and model health is written to the database
 * (throttled to one write a second) so every process sees it.
 */
export function installLlmHealth(db: Db): void {
    installedDb = db;
    const c = (fallbackCache = new SettingsCache(() => savedFallbacks(db)));
    setFallbackModelSource(() => c.get());
    healthLog.setSink(() => scheduleWrite());
}
