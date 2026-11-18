/**
 * The AI response cache (sheet #8 b2): a call that reads something and describes it (engine/llm/response-cache-calls.ts), asked again in
 * the same project with exactly the same question, gets the answer kept from the first time instead of a new model call.
 *
 * Where it sits: around a job's model client, outside the usage meter (job-runner.ts `jobLlm`), so a stored answer is never a model call,
 * never counts against a limit and is counted on its own (`ai_usage.cached_calls`, with the tokens it saved). An exploration on a runner
 * sends its calls to the platform (explore-llm.ts), which answers from the same cache; the runner never sees a key or a stored answer of
 * another project.
 *
 * The rules:
 *  - only the allowed calls (response-cache-calls.ts), and on a runner only a structured call without tools and without images;
 *  - the key is a sha256 over the project, the AI in use (provider, endpoint, model, fast model, and for a key its id and last change),
 *    the call and its version, the system text, the prompt, the answer's schema and the answer size; any byte different misses;
 *  - rows are read and written by project id: one project never reads another's, even for the same bytes;
 *  - only an answer that passed its schema is kept, never a failed, refused, cut or empty one; and only when the run's secrets and the
 *    shared redaction patterns (redact-text.ts) find nothing in it: an answer that would need masking is not kept at all, so a stored
 *    answer is always exactly the answer the model gave;
 *  - 14 days from when it was made, then asked again; per project at most RESPONSE_CACHE_LIMITS (least recently used go first);
 *  - removed with the project and by "Forget what we learned" (memory-store.ts); off for the server with LLM_RESPONSE_CACHE=false and
 *    for a run with `responseCache: false` or "Explore everything again" (`fullExploration`).
 * Nothing here may break a job: a cache that cannot be read or written is a miss. A runner's calls: llm-response-cache-runner.ts.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Config } from "../config.js";
import type { EngineEvent } from "../engine/context.js";
import type { LlmClient } from "../engine/llm/provider.js";
import { isResponseCacheCall, RESPONSE_CACHE_CALLS, type ResponseCacheCall } from "../engine/llm/response-cache-calls.js";
import { envSwitch } from "../engine/llm/without-ai.js";
import type { UsageBilling } from "../engine/llm/usage.js";
import { maskValue } from "./redact-text.js";
import type { Sql } from "./sql.js";

/** Migration slot 68. */
export const RESPONSE_CACHE_MIGRATION = `
CREATE TABLE llm_response_cache (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    cache_key TEXT NOT NULL,              -- sha256 (hex) of the project, the AI in use and the whole question: never the question itself
    call_id TEXT NOT NULL,                -- which allowed call (response-cache-calls.ts)
    answer_json TEXT NOT NULL,            -- the answer as the schema read it, after the redaction check
    bytes INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,   -- what the answer took when it was made: the tokens a later use saves
    output_tokens INTEGER NOT NULL DEFAULT 0,
    hits INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    PRIMARY KEY (project_id, cache_key)
);
CREATE INDEX idx_llm_response_cache_used ON llm_response_cache(project_id, last_used_at);
ALTER TABLE ai_usage ADD COLUMN cached_calls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN saved_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN saved_output_tokens INTEGER NOT NULL DEFAULT 0;
`;

/** How long an answer is given again, from when it was made. */
export const RESPONSE_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Per project: an exploration at the Thorough level makes up to about 130 allowed calls (one understanding call, the rule reading of up
 * to three sources, documentation pages, the requirements), most of them a few KB to a few tens of KB. 1,000 answers and 20 MB keep about
 * seven explorations' worth of different questions for the 14 days; one answer over 512 KB is not kept.
 */
export const RESPONSE_CACHE_LIMITS = { entries: 1000, bytes: 20 * 1024 * 1024, entryBytes: 512 * 1024 } as const;

/** Bumped when the key's make-up changes, so keys of the old make-up are never matched. */
const KEY_FORMAT = 1;

/** The server's switch: on unless LLM_RESPONSE_CACHE says off. */
export const responseCacheOn = (cfg: Partial<Pick<Config, "LLM_RESPONSE_CACHE">> | undefined): boolean => envSwitch(cfg?.LLM_RESPONSE_CACHE);

/** The event a used answer writes (the knowledge view and the repeat-run benchmark count it). */
export const RESPONSE_CACHE_HIT = "response_cache_hit";

/** JSON with object keys in order, so equal values always give equal text. Undefined members are left out, as JSON does. */
export function canonicalJson(v: unknown): string {
    const walk = (x: unknown): unknown => {
        if (x instanceof Uint8Array) return { $bytes: Buffer.from(x).toString("base64") };
        if (Array.isArray(x)) return x.map(walk);
        if (x && typeof x === "object") {
            const o = x as Record<string, unknown>;
            return Object.fromEntries(
                Object.keys(o)
                    .filter((k) => o[k] !== undefined)
                    .sort()
                    .map((k) => [k, walk(o[k])]),
            );
        }
        return x;
    };
    return JSON.stringify(walk(v)) ?? "null";
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

interface Row {
    answer_json: string;
    input_tokens: number;
    output_tokens: number;
    created_at: string;
}

/** The stored answers, always by project. */
export class ResponseCacheStore {
    constructor(
        private readonly sql: Sql,
        private readonly now: () => number = Date.now,
        private readonly limits: { entries: number; bytes: number; entryBytes: number } = RESPONSE_CACHE_LIMITS,
    ) {}

    /** The answer under this key in this project, if it is younger than the time limit (an older one is removed). */
    async get(projectId: string, key: string): Promise<{ answer: unknown; inputTokens: number; outputTokens: number } | undefined> {
        const r = await this.sql.get<Row>("SELECT answer_json, input_tokens, output_tokens, created_at FROM llm_response_cache WHERE project_id = ? AND cache_key = ?", projectId, key);
        if (!r) return undefined;
        if (!(this.now() - Date.parse(r.created_at) < RESPONSE_CACHE_TTL_MS)) {
            await this.sql.run("DELETE FROM llm_response_cache WHERE project_id = ? AND cache_key = ?", projectId, key);
            return undefined;
        }
        await this.sql.run("UPDATE llm_response_cache SET hits = hits + 1, last_used_at = ? WHERE project_id = ? AND cache_key = ?", new Date(this.now()).toISOString(), projectId, key);
        return { answer: JSON.parse(r.answer_json), inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens) };
    }

    /** Keep an answer; then the project's expired answers go, and the least recently used ones until it is within its limits. */
    async put(projectId: string, key: string, call: ResponseCacheCall, answer: unknown, tokens: { input: number; output: number }): Promise<boolean> {
        const json = JSON.stringify(answer);
        const bytes = Buffer.byteLength(json);
        if (bytes > this.limits.entryBytes) return false;
        const at = new Date(this.now()).toISOString();
        await this.sql.run(
            `INSERT INTO llm_response_cache (project_id, cache_key, call_id, answer_json, bytes, input_tokens, output_tokens, hits, created_at, last_used_at)
             VALUES (?,?,?,?,?,?,?,0,?,?)
             ON CONFLICT (project_id, cache_key) DO UPDATE SET call_id = excluded.call_id, answer_json = excluded.answer_json, bytes = excluded.bytes,
                input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, created_at = excluded.created_at, last_used_at = excluded.last_used_at`,
            projectId,
            key,
            call,
            json,
            bytes,
            Math.max(0, Math.round(tokens.input)),
            Math.max(0, Math.round(tokens.output)),
            at,
            at,
        );
        await this.trim(projectId);
        return true;
    }

    private async trim(projectId: string): Promise<void> {
        await this.sql.run("DELETE FROM llm_response_cache WHERE project_id = ? AND created_at < ?", projectId, new Date(this.now() - RESPONSE_CACHE_TTL_MS).toISOString());
        const rows = await this.sql.all<{ cache_key: string; bytes: number }>("SELECT cache_key, bytes FROM llm_response_cache WHERE project_id = ? ORDER BY last_used_at DESC, created_at DESC, cache_key", projectId);
        let count = 0;
        let bytes = 0;
        const drop: string[] = [];
        for (const r of rows) {
            count++;
            bytes += Number(r.bytes);
            if (count > this.limits.entries || bytes > this.limits.bytes) drop.push(r.cache_key);
        }
        for (const key of drop) await this.sql.run("DELETE FROM llm_response_cache WHERE project_id = ? AND cache_key = ?", projectId, key);
    }

    /** Every answer kept for a project ("Forget what we learned"). Returns how many went. */
    async clear(projectId: string): Promise<number> {
        return (await this.sql.run("DELETE FROM llm_response_cache WHERE project_id = ?", projectId)).changes;
    }

    async count(projectId: string): Promise<number> {
        return Number((await this.sql.get<{ n: number }>("SELECT COUNT(*) AS n FROM llm_response_cache WHERE project_id = ?", projectId))?.n ?? 0);
    }
}

/** What identifies the AI a job uses, for the key: a different provider, endpoint, model or key configuration never shares an answer. */
export type AiIdentity = Record<string, string | null | undefined>;

export interface JobResponseCacheOptions {
    store: ResponseCacheStore;
    projectId: string;
    jobId: string;
    ai: AiIdentity;
    /** The run's own secrets (sign-in passwords, tokens): an answer that holds one is not kept. */
    secrets: readonly string[];
    /** Writes the cached-call counts (usage-store.ts addUsage). */
    addUsage?: (d: { jobId: string; projectId: string; purpose: string; model: string; at: Date; calls: number; failedCalls: number; inputTokens: number; outputTokens: number; images: number; estimatedCalls: number; cachedCalls: number; savedInputTokens: number; savedOutputTokens: number; billing?: UsageBilling }) => void;
    billing?: UsageBilling;
    emit?: (e: EngineEvent) => void;
    /** The model name usage rows carry. */
    modelName: string;
}

type ObjectArgs = Parameters<LlmClient["object"]>[0];

/** One job's view of the cache: its project, its AI, its secrets. */
export class JobResponseCache {
    constructor(private readonly o: JobResponseCacheOptions) {}

    key(call: ResponseCacheCall, kind: "client" | "runner", question: unknown): string {
        return sha256(canonicalJson({ format: KEY_FORMAT, project: this.o.projectId, ai: this.o.ai, call, version: RESPONSE_CACHE_CALLS[call].version, kind, question }));
    }

    /** Kept only when nothing in it needs masking: a stored answer is always exactly what the model said. */
    clean(value: unknown): boolean {
        try {
            return canonicalJson(maskValue(value, this.o.secrets)) === canonicalJson(value);
        } catch {
            return false;
        }
    }

    async lookup(key: string): Promise<{ answer: unknown; inputTokens: number; outputTokens: number } | undefined> {
        try {
            return await this.o.store.get(this.o.projectId, key);
        } catch (e) {
            console.warn("[ai-cache] read failed:", e instanceof Error ? e.message : e);
            return undefined;
        }
    }

    async keep(key: string, call: ResponseCacheCall, answer: unknown, tokens: { input: number; output: number }): Promise<void> {
        try {
            await this.o.store.put(this.o.projectId, key, call, answer, tokens);
        } catch (e) {
            console.warn("[ai-cache] write failed:", e instanceof Error ? e.message : e);
        }
    }

    used(call: ResponseCacheCall, purpose: string, hit: { inputTokens: number; outputTokens: number }): void {
        try {
            this.o.addUsage?.({ jobId: this.o.jobId, projectId: this.o.projectId, purpose, model: this.o.modelName, at: new Date(), calls: 0, failedCalls: 0, inputTokens: 0, outputTokens: 0, images: 0, estimatedCalls: 0, cachedCalls: 1, savedInputTokens: hit.inputTokens, savedOutputTokens: hit.outputTokens, ...(this.o.billing ? { billing: this.o.billing } : {}) });
        } catch {
            // Counting must never break a job.
        }
        try {
            this.o.emit?.({ stage: "analysis", kind: RESPONSE_CACHE_HIT, message: `The AI's answer about ${RESPONSE_CACHE_CALLS[call].label} was the same question as an earlier one, so that answer was used and no AI call was made.`, data: { call } });
        } catch {
            // Telling the job is best effort.
        }
    }

    /** A job's model client whose allowed structured calls are answered from the cache when they can be. */
    wrap(inner: LlmClient): LlmClient {
        if (inner.modelName === "unavailable") return inner;
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const cache = this;
        const wrapped: LlmClient = {
            modelName: inner.modelName,
            usage: inner.usage,
            get model() {
                return inner.model;
            },
            text: (args) => inner.text(args),
            object: (async (args: ObjectArgs) => {
                const call = args.cacheAs;
                if (!isResponseCacheCall(call)) return inner.object(args);
                let key: string;
                try {
                    key = cache.key(call, "client", { system: args.system, prompt: args.prompt, schema: z.toJSONSchema(args.schema, { unrepresentable: "any", io: "output" }), maxOutputTokens: args.maxOutputTokens ?? null });
                } catch {
                    return inner.object(args);
                }
                const hit = await cache.lookup(key);
                if (hit) {
                    const read = args.schema.safeParse(hit.answer);
                    if (read.success) {
                        cache.used(call, args.purpose ?? "other", hit);
                        return read.data;
                    }
                }
                const before = { input: inner.usage.inputTokens, output: inner.usage.outputTokens };
                // A failed or refused call throws here and keeps nothing.
                const answer = await inner.object(args);
                // Kept only when reading the stored text with the schema gives back this same answer, and nothing in it needs masking.
                let again: unknown;
                try {
                    const read = args.schema.safeParse(JSON.parse(JSON.stringify(answer)));
                    again = read.success ? read.data : undefined;
                } catch {
                    again = undefined;
                }
                if (again !== undefined && canonicalJson(again) === canonicalJson(answer) && cache.clean(answer)) {
                    await cache.keep(key, call, answer, { input: inner.usage.inputTokens - before.input, output: inner.usage.outputTokens - before.output });
                }
                return answer;
            }) as LlmClient["object"],
        };
        if (typeof inner.imageObject === "function") wrapped.imageObject = (args) => inner.imageObject!(args);
        if (typeof inner.setEventSink === "function") wrapped.setEventSink = (fn) => inner.setEventSink!(fn);
        return wrapped;
    }
}
