/**
 * The paid understanding series: one Anthropic model (claude-haiku-5-5) on both sides, at low effort, within an approved budget.
 *
 * The key is read from BENCH_ANTHROPIC_API_KEY only and lives in the model client built here: the benchmark's platforms get no key in
 * their settings, so nothing else on them (the analysis started from the API, for example) can make a paid call. Every request that
 * client sends goes through the SpendGuard: it asks for low effort (`output_config.effort`, what the Anthropic SDK sends for its
 * `effort` option), refuses a request whose worst case (its whole body as input tokens, its `max_tokens` as output), added to what was
 * spent and to the worst cases of requests still in flight, could take the run past the budget, and adds the real cost from the answer's
 * usage. A refused request is answered as a provider refusal, so the job fails
 * at once and the run stops with the series incomplete.
 */
import fs from "node:fs";
import { z } from "zod";
import type { Config } from "../../../config.js";
import { createLlmClient, type LlmClient } from "../../../engine/llm/provider.js";

export const PAID_PROVIDER = "anthropic";
export const PAID_MODEL = "claude-haiku-5-5";
export const PAID_KEY_ENV = "BENCH_ANTHROPIC_API_KEY";

const Tier = z.object({ inputPerMTok: z.number().min(0), outputPerMTok: z.number().min(0) }).strict();
export const PaidPricesSchema = z
    .object({
        provider: z.literal(PAID_PROVIDER),
        model: z.literal(PAID_MODEL),
        /** Prices per million tokens for a call whose prompt is at most `upToInputTokens`, and for longer prompts. */
        tiers: z.tuple([Tier.extend({ upToInputTokens: z.number().int().min(1) }).strict(), Tier]),
        note: z.string().max(500).optional(),
    })
    .strict();
export type PaidPrices = z.infer<typeof PaidPricesSchema>;

/** The paid price table in the file, or undefined when the file is another kind (the free model's price rows). */
export function paidPricesIn(file: string): PaidPrices | undefined {
    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return undefined;
    }
    const p = PaidPricesSchema.safeParse(raw);
    return p.success ? p.data : undefined;
}

/** What one call costs in dollars: the higher tier for the whole call when its prompt is longer than the first tier allows. */
export function callCost(prices: PaidPrices, inputTokens: number, outputTokens: number): number {
    const [low, high] = prices.tiers;
    const t = inputTokens > low.upToInputTokens ? high : low;
    return (inputTokens * t.inputPerMTok + outputTokens * t.outputPerMTok) / 1_000_000;
}

/** The output limit the SDK asks for when a call sets none (it caps an unknown model at this). */
const DEFAULT_MAX_TOKENS = 128_000;

export class SpendGuard {
    spent = 0;
    /** The worst cases of requests sent and not answered yet: requests in flight at once count against the budget together. */
    reserved = 0;
    calls = 0;
    refused = 0;
    /** Why the run must stop: set by the first refused request. */
    stopped?: string;

    constructor(
        readonly budget: number,
        readonly prices: PaidPrices,
    ) {}

    /** A fetch for the model client: low effort, the budget check before, the real cost after. */
    fetch(inner: typeof fetch = fetch): typeof fetch {
        return async (input, init) => {
            if (typeof init?.body !== "string") return inner(input, init);
            let body: Record<string, unknown>;
            try {
                body = JSON.parse(init.body) as Record<string, unknown>;
            } catch {
                return inner(input, init);
            }
            const out = { ...body, output_config: { ...((body.output_config as object | undefined) ?? {}), effort: "low" } };
            const text = JSON.stringify(out);
            const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : DEFAULT_MAX_TOKENS;
            const worst = callCost(this.prices, Buffer.byteLength(text, "utf8"), maxTokens);
            if (this.spent + this.reserved + worst > this.budget) {
                this.refused++;
                this.stopped ??= `Stopped before a call that could take the spend past the approved $${this.budget.toFixed(2)} (spent $${this.spent.toFixed(4)}, that call could cost up to $${worst.toFixed(4)}).`;
                return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "The benchmark's approved budget would be crossed by this call; it was not sent." } }), { status: 400, headers: { "content-type": "application/json" } });
            }
            this.reserved += worst;
            let res: Response;
            try {
                res = await inner(input, { ...init, body: text });
            } finally {
                this.reserved -= worst;
            }
            if (res.ok) {
                try {
                    const u = ((await res.clone().json()) as { usage?: Record<string, number> }).usage ?? {};
                    // Cache reads and writes are charged as ordinary input here: never less than the real cost.
                    const inputTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
                    this.spent += callCost(this.prices, inputTokens, u.output_tokens ?? 0);
                    this.calls++;
                } catch {
                    // An answer without readable usage: charge its worst case.
                    this.spent += worst;
                    this.calls++;
                }
            }
            return res;
        };
    }
}

/** The key from the environment, without surrounding quotes or spaces; undefined when it is not set. */
export function paidKeyFrom(env: NodeJS.ProcessEnv): string | undefined {
    const k = env[PAID_KEY_ENV]?.trim().replace(/^(['"])(.*)\1$/, "$2").trim();
    return k ? k : undefined;
}

/** Settings for the benchmark's platforms in the paid series: the one model named, no key and no other model or provider key. */
export function paidPlatformEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = { ...env };
    for (const k of Object.keys(out)) if (/_API_KEY$|^LLM_/.test(k) || k === PAID_KEY_ENV) delete out[k];
    return { ...out, LLM_PROVIDER: PAID_PROVIDER, LLM_MODEL: PAID_MODEL };
}

/** The model client of the paid series: the key only here, no fallback models, every request through the guard. */
export function paidLlm(key: string, guard: SpendGuard, inner?: typeof fetch): (config: Config) => LlmClient {
    return (config) => createLlmClient({ ...config, LLM_PROVIDER: PAID_PROVIDER, LLM_MODEL: PAID_MODEL, LLM_API_KEY: key, LLM_BASE_URL: undefined }, { fallbacks: [], fetch: guard.fetch(inner) });
}
