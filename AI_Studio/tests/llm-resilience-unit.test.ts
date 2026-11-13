/**
 * AI model reliability, the pure parts: error classes for every provider's error shapes, Retry-After, backoff, the circuit breaker,
 * fallback lists, the health summary, and the resilient model's retry / fallback / pause decisions with scripted model doubles
 * (no network, no real provider). The same behaviour over real HTTP is in llm-resilience.test.ts.
 */
import { readFileSync } from "node:fs";
import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import type { EngineEvent } from "../src/engine/context.js";
import { classifyLlmError, CLASS_RULES, describeLlmError, LlmCallError, LOW_CREDIT_SENTENCE, retryAfterMs, scrubDetail, toLlmCallError } from "../src/engine/llm/errors.js";
import { healthLog, summariseHealth } from "../src/engine/llm/health.js";
import { JobMeter, type MeterBackend } from "../src/engine/llm/metered.js";
import { AGENT_STEP_MAX_OUTPUT_TOKENS, describeFallbacks, llmClientFromModel, parseFallbackModels, policyFromConfig } from "../src/engine/llm/provider.js";
import { backoffDelay, CircuitBreaker, resetBreakers, ResilientModel, type ChainEntry, type ModelV3 } from "../src/engine/llm/resilience.js";

const api = (statusCode: number | undefined, body: unknown, headers: Record<string, string> = {}, message = "API error") =>
    new APICallError({ message, url: "http://fake.invalid/v1", requestBodyValues: {}, statusCode, responseHeaders: headers, responseBody: typeof body === "string" ? body : JSON.stringify(body), isRetryable: false });

describe("error classes for each provider", () => {
    it("Anthropic", () => {
        expect(classifyLlmError(api(429, { type: "error", error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your per-minute rate limit" } }, { "retry-after": "7" })).cls).toBe("rate_limited");
        expect(classifyLlmError(api(429, {}, { "retry-after": "7" })).retryAfterMs).toBe(7000);
        expect(classifyLlmError(api(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } })).cls).toBe("overloaded");
        expect(classifyLlmError(api(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })).cls).toBe("auth");
        expect(classifyLlmError(api(400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } })).cls).toBe("credit");
        expect(classifyLlmError(api(404, { type: "error", error: { type: "not_found_error", message: "model: claude-nope" } })).cls).toBe("model");
        expect(classifyLlmError(api(500, { type: "error", error: { type: "api_error", message: "Internal server error" } })).cls).toBe("server");
        expect(classifyLlmError(api(400, { type: "error", error: { type: "invalid_request_error", message: "max_tokens: too large" } })).cls).toBe("bad_request");
    });

    it("OpenAI", () => {
        expect(classifyLlmError(api(429, { error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" } })).cls).toBe("credit");
        expect(classifyLlmError(api(429, { error: { message: "Rate limit reached for gpt-5.4", type: "requests", code: "rate_limit_exceeded" } }, { "retry-after-ms": "250" })).retryAfterMs).toBe(250);
        expect(classifyLlmError(api(401, { error: { message: "Incorrect API key provided: sk-abcdefghijklmnopqrstuvwxyz", type: "invalid_request_error", code: "invalid_api_key" } })).cls).toBe("auth");
        expect(classifyLlmError(api(404, { error: { message: "The model `gpt-9` does not exist", code: "model_not_found" } })).cls).toBe("model");
        expect(classifyLlmError(api(400, { error: { message: "Your request was rejected as a result of our safety system.", code: "content_policy_violation" } })).cls).toBe("refused");
        expect(classifyLlmError(api(503, { error: { message: "The engine is currently overloaded, please try again later" } })).cls).toBe("overloaded");
    });

    it("Google", () => {
        const quota = api(429, { error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "12s" }] } });
        expect(classifyLlmError(quota)).toMatchObject({ cls: "rate_limited", retryAfterMs: 12_000 });
        expect(classifyLlmError(api(400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } })).cls).toBe("auth");
        expect(classifyLlmError(api(503, { error: { code: 503, message: "The model is overloaded. Please try again later.", status: "UNAVAILABLE" } })).cls).toBe("overloaded");
        expect(classifyLlmError(api(504, { error: { code: 504, message: "Deadline expired", status: "DEADLINE_EXCEEDED" } })).cls).toBe("timeout");
        expect(classifyLlmError(api(400, { error: { code: 400, message: "Billing is not enabled for this project", status: "FAILED_PRECONDITION" } })).cls).toBe("credit");
    });

    it("OpenRouter's 'can only afford' answer says credit is low, not gone, in its own words", () => {
        const e = toLlmCallError(api(402, { error: { code: 402, message: "This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 2950. To increase, visit https://openrouter.ai/settings/credits" } }));
        expect(e.cls).toBe("credit");
        expect(e.message.startsWith(LOW_CREDIT_SENTENCE)).toBe(true);
        expect(e.message).toContain("can only afford 2950");
        // A plain "out of credit" keeps the plain sentence.
        expect(toLlmCallError(api(402, { error: { code: 402, message: "Insufficient credits" } })).message.startsWith(CLASS_RULES.credit.sentence)).toBe(true);
    });

    it("every agent loop caps one step's answer, so a request never asks for the model's whole output window", () => {
        for (const f of ["src/engine/web/author.ts", "src/engine/agent/objective.ts"]) {
            const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
            const calls = src.split("await generateText({").slice(1);
            expect(calls.length, f).toBeGreaterThan(0);
            for (const c of calls) expect(c.slice(0, c.indexOf("});")), f).toContain("maxOutputTokens: AGENT_STEP_MAX_OUTPUT_TOKENS");
        }
        expect(AGENT_STEP_MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(8192);
    });

    it("OpenRouter, including the bare 'Provider returned error'", () => {
        expect(classifyLlmError(api(402, { error: { code: 402, message: "Insufficient credits. Add more using https://openrouter.ai/settings/credits" } })).cls).toBe("credit");
        // The real-run case: a generic message, the upstream answer in metadata.raw.
        const wrapped = api(
            502,
            { error: { code: 429, message: "Provider returned error", metadata: { raw: JSON.stringify({ error: { message: "gemini-2.5-flash is temporarily rate-limited upstream" } }), provider_name: "Google AI Studio" } } },
            {},
            "Provider returned error",
        );
        const info = classifyLlmError(wrapped);
        expect(info).toMatchObject({ cls: "rate_limited", status: 429, upstream: "Google AI Studio" });
        const msg = describeLlmError(info);
        expect(msg).toContain("rate limited");
        expect(msg).toContain("upstream Google AI Studio");
        expect(msg).toContain("temporarily rate-limited upstream");
        expect(msg).not.toMatch(/^Provider returned error$/);
        // No inner code: the raw text decides.
        const raw = api(502, { error: { message: "Provider returned error", metadata: { raw: "upstream connect error: overloaded", provider_name: "Anthropic" } } });
        expect(classifyLlmError(raw)).toMatchObject({ cls: "overloaded", upstream: "Anthropic" });
        expect(classifyLlmError(api(503, { error: { code: 503, message: "No available model provider that meets your routing requirements" } })).cls).toBe("overloaded");
        expect(classifyLlmError(api(403, { error: { code: 403, message: "Input was flagged", metadata: { reasons: ["violence"], flagged_input: "..." } } })).cls).toBe("refused");
        expect(classifyLlmError(api(408, { error: { code: 408, message: "Request timed out" } })).cls).toBe("timeout");
    });

    it("local servers, networks, time limits and unusable answers", () => {
        const refused = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" }) });
        expect(classifyLlmError(refused)).toMatchObject({ cls: "network", detail: "ECONNREFUSED" });
        expect(classifyLlmError(new Error("This operation was aborted"), { timedOut: true }).cls).toBe("timeout");
        const bad = Object.assign(new Error("No object generated: could not parse the response."), { name: "AI_NoObjectGeneratedError" });
        expect(classifyLlmError(bad).cls).toBe("bad_output");
        const filtered = Object.assign(new Error("No object generated"), { name: "AI_NoObjectGeneratedError", finishReason: "content-filter" });
        expect(classifyLlmError(filtered).cls).toBe("refused");
        expect(classifyLlmError(new Error("boom: model unavailable")).cls).toBe("unknown");
        // A RetryError from the SDK is read through to the error it wraps.
        const retryErr = Object.assign(new Error("Failed after 3 attempts"), { name: "AI_RetryError", lastError: api(529, { error: { type: "overloaded_error", message: "Overloaded" } }) });
        expect(classifyLlmError(retryErr).cls).toBe("overloaded");
    });

    it("every class has a plain sentence and keys never reach it", () => {
        for (const rule of Object.values(CLASS_RULES)) expect(rule.sentence).toMatch(/^The |^Calls /);
        expect(CLASS_RULES.credit.sentence).toContain("out of credit");
        const info = classifyLlmError(api(401, { error: { message: "Incorrect API key provided: sk-proj-abcdefghijklmnop1234" } }));
        expect(describeLlmError(info)).not.toContain("abcdefghijklmnop1234");
        expect(scrubDetail("key AIzaSyA1234567890abcdefg and Bearer xyz.abc")).toBe("key [hidden] and Bearer [hidden]");
    });

    it("Retry-After as seconds, milliseconds or a date", () => {
        expect(retryAfterMs({ "Retry-After": "2" })).toBe(2000);
        expect(retryAfterMs({ "retry-after-ms": "40" })).toBe(40);
        expect(retryAfterMs({ "retry-after": new Date(10_000).toUTCString() }, undefined, 4_000)).toBe(6000);
        expect(retryAfterMs({})).toBeUndefined();
    });
});

describe("backoff and the circuit breaker", () => {
    it("waits double each time, with jitter between half and all, and a cap", () => {
        const p = { baseDelayMs: 1000, maxDelayMs: 30_000 };
        expect(backoffDelay(0, p, () => 0)).toBe(500);
        expect(backoffDelay(0, p, () => 1)).toBe(1000);
        expect(backoffDelay(3, p, () => 1)).toBe(8000);
        expect(backoffDelay(10, p, () => 1)).toBe(30_000);
        for (let i = 0; i < 50; i++) {
            const d = backoffDelay(2, p);
            expect(d).toBeGreaterThanOrEqual(2000);
            expect(d).toBeLessThanOrEqual(4000);
        }
    });

    it("opens after N failures in a row, lets one trial through after the pause, closes on success", () => {
        let t = 1000;
        const b = new CircuitBreaker("p", 3, 60_000, () => t);
        expect(b.failure()).toBe(false);
        b.success();
        expect(b.failure()).toBe(false);
        expect(b.failure()).toBe(false);
        expect(b.failure("Overloaded")).toBe(true);
        expect(b.check()).toEqual({ ok: false, until: 61_000 });
        expect(b.state()).toMatchObject({ open: true, failuresInARow: 3, lastError: "Overloaded" });
        t = 61_000;
        expect(b.check()).toEqual({ ok: true, trial: true });
        // Only one trial at a time.
        expect(b.check().ok).toBe(false);
        expect(b.failure()).toBe(true);
        expect(b.check()).toEqual({ ok: false, until: 121_000 });
        t = 121_000;
        expect(b.check().ok).toBe(true);
        b.success();
        expect(b.check()).toEqual({ ok: true, trial: false });
        expect(b.state().open).toBe(false);
    });
});

describe("fallback lists and settings", () => {
    it("reads [provider:]model entries and keeps OpenRouter names with a colon whole", () => {
        expect(parseFallbackModels("gpt-5.4, anthropic:claude-haiku-4-5\nmeta-llama/llama-3.1-8b-instruct:free,, gpt-5.4", "openai")).toEqual([
            { provider: "openai", model: "gpt-5.4" },
            { provider: "anthropic", model: "claude-haiku-4-5" },
            { provider: "openai", model: "meta-llama/llama-3.1-8b-instruct:free" },
        ]);
        expect(parseFallbackModels(["a", "b", "c", "d", "e", "f", "g"], "google")).toHaveLength(5);
        expect(parseFallbackModels(["has space", "ok"], "google")).toEqual([{ provider: "google", model: "ok" }]);
        expect(parseFallbackModels(undefined, "google")).toEqual([]);
    });

    it("says which fallbacks this server can use, without showing a key", () => {
        const cfg = loadConfig({ LLM_PROVIDER: "anthropic", LLM_API_KEY: "secret-primary-key", LLM_MODEL: "claude-a", DATA_DIR: "unused" });
        const env = { ...process.env };
        delete process.env.OPENAI_API_KEY;
        delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
        try {
            const out = describeFallbacks(cfg, parseFallbackModels("claude-b, claude-a, openai:gpt-5.4, openai-compatible:local", "anthropic"));
            expect(out.map((f) => f.ready)).toEqual([true, false, false, false]);
            expect(out[1]!.reason).toBe("This is the main model already.");
            expect(out[2]!.reason).toContain("OPENAI_API_KEY");
            expect(out[3]!.reason).toContain("LLM_BASE_URL");
            expect(JSON.stringify(out)).not.toContain("secret-primary-key");
        } finally {
            process.env = env;
        }
    });

    it("time limits and retries from the environment, clamped; typos keep the defaults", () => {
        expect(policyFromConfig(loadConfig({ LLM_RETRY_ATTEMPTS: "3", LLM_TIMEOUT_MS: "5000", LLM_CALL_DEADLINE_MS: "20000", DATA_DIR: "unused" }))).toEqual({ attempts: 3, attemptTimeoutMs: 5000, deadlineMs: 20_000 });
        expect(policyFromConfig(loadConfig({ LLM_RETRY_ATTEMPTS: "99", LLM_TIMEOUT_MS: "soon", DATA_DIR: "unused" }))).toEqual({ attempts: 10 });
        expect(policyFromConfig(loadConfig({ DATA_DIR: "unused" }))).toEqual({});
    });
});

describe("health summary", () => {
    it("success rate, average time of the requests that worked, and the last error in words", () => {
        const now = 10_000_000;
        const s = [
            { at: now - 5000, model: "m", provider: "openai", ok: true, ms: 100 },
            { at: now - 4000, model: "m", provider: "openai", ok: false, ms: 50, cls: "credit" as const, message: "The AI provider is out of credit." },
            { at: now - 3000, model: "m", provider: "openai", ok: true, ms: 300 },
            { at: now - 2000, model: "m", provider: "openai", ok: true, ms: 200 },
            { at: now - 90_000_000, model: "old", provider: "openai", ok: false, ms: 1 },
        ];
        const [h, ...rest] = summariseHealth(s, now);
        expect(rest).toEqual([]);
        expect(h).toMatchObject({ model: "m", calls: 4, failures: 1, successRate: 75, avgLatencyMs: 200, lastError: { cls: "credit", label: "Out of credit", message: "The AI provider is out of credit." } });
    });
});

// ── the resilient model with scripted doubles ────────────────────────────────

const reply = (text: string, finish: "stop" | "content-filter" = "stop") => ({
    content: [{ type: "text" as const, text }],
    finishReason: { unified: finish, raw: finish },
    usage: { inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } },
    warnings: [],
});

type Step = ReturnType<typeof reply> | Error;
function scripted(name: string, steps: Step[], calls: string[]): ModelV3 {
    return new MockLanguageModelV3({
        provider: name,
        modelId: name,
        doGenerate: async () => {
            calls.push(name);
            const s = steps.shift() ?? reply("OK");
            if (s instanceof Error) throw s;
            return s;
        },
    }) as unknown as ModelV3;
}
const entry = (name: string, steps: Step[], calls: string[], provider = name): ChainEntry => ({ name, provider, breakerKey: provider, model: scripted(name, steps, calls) });
const fast = { baseDelayMs: 1, maxDelayMs: 2, attemptTimeoutMs: 2000, deadlineMs: 10_000, breakerFailures: 3, breakerCooldownMs: 60_000 };

describe("the resilient model", () => {
    afterEach(() => {
        resetBreakers();
        healthLog.clear();
    });

    it("asks again after a retryable failure, honouring Retry-After, and tells the job", async () => {
        const calls: string[] = [];
        const waits: number[] = [];
        const events: EngineEvent[] = [];
        const model = new ResilientModel([entry("main", [api(429, { error: { message: "slow down" } }, { "retry-after-ms": "40" }), reply("hi")], calls)], { policy: fast, sleep: async (ms) => void waits.push(ms) });
        model.setEventSink((e) => events.push(e));
        const client = llmClientFromModel(model, "main");
        expect(await client.text({ system: "s", prompt: "p" })).toBe("hi");
        expect(calls).toEqual(["main", "main"]);
        expect(waits[0]).toBeGreaterThanOrEqual(40);
        expect(events.map((e) => e.kind)).toEqual(["ai_model_retry", "ai_model_answered"]);
        expect(events[0]!.message).toMatch(/rate limited.*Asking main again/);
        expect(client.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    });

    it("does not retry what a retry cannot fix, and moves to the fallback model when out of credit", async () => {
        const calls: string[] = [];
        const events: EngineEvent[] = [];
        const model = new ResilientModel([entry("main", [api(402, { error: { code: 402, message: "Insufficient credits" } })], calls), entry("backup", [reply("from backup")], calls)], { policy: fast, sleep: async () => {} });
        model.setEventSink((e) => events.push(e));
        expect(await llmClientFromModel(model, "main").text({ system: "s", prompt: "p" })).toBe("from backup");
        expect(calls).toEqual(["main", "backup"]);
        expect(events.map((e) => [e.kind, e.message])).toEqual([
            ["ai_model_fallback", "main is unavailable (out of credit); asking the fallback model backup."],
            ["ai_model_answered", "The fallback AI model backup answered."],
        ]);
        expect(summariseHealth(healthLog.samples()).map((h) => [h.model, h.successRate, h.lastError?.cls ?? null])).toEqual(
            expect.arrayContaining([
                ["main", 0, "credit"],
                ["backup", 100, null],
            ]),
        );
    });

    it("a refused answer or an invalid request is not sent to the fallback", async () => {
        const calls: string[] = [];
        const model = new ResilientModel([entry("main", [api(400, { error: { message: "max_tokens is too large" } })], calls), entry("backup", [], calls)], { policy: fast, sleep: async () => {} });
        const err = await llmClientFromModel(model, "main").text({ system: "s", prompt: "p" }).catch((e) => e);
        expect(err).toBeInstanceOf(LlmCallError);
        expect(err.cls).toBe("bad_request");
        expect(err.message).toContain("max_tokens is too large");
        expect(calls).toEqual(["main"]);

        const filtered = new ResilientModel([entry("main2", [reply("", "content-filter")], calls)], { policy: fast });
        await expect(llmClientFromModel(filtered, "main2").text({ system: "s", prompt: "p" })).rejects.toMatchObject({ cls: "refused" });
    });

    it("pauses a provider after N failures in a row; later calls skip it without a request, then a trial call closes it", async () => {
        let t = 0;
        const calls: string[] = [];
        const events: EngineEvent[] = [];
        const down = () => api(503, { error: { message: "overloaded" } });
        const policy = { ...fast, attempts: 2, breakerFailures: 3, breakerCooldownMs: 60_000 };
        const mk = () => new ResilientModel([entry("main", steps, calls, "prov"), entry("other", [], calls, "prov2")], { policy, sleep: async () => {}, now: () => t });
        const steps: Step[] = [down(), down(), down(), down()];
        const m1 = mk();
        m1.setEventSink((e) => events.push(e));
        const client = llmClientFromModel(m1, "main");
        // Call 1: two attempts fail, the fallback answers. Call 2: the third failure opens the breaker, the fallback answers.
        expect(await client.text({ system: "s", prompt: "p" })).toBe("OK");
        expect(await client.text({ system: "s", prompt: "p" })).toBe("OK");
        expect(events.some((e) => e.kind === "ai_provider_paused" && /failed 3 times in a row/.test(e.message))).toBe(true);
        // Call 3, from another job's client: the paused provider gets no request at all.
        calls.length = 0;
        const m2 = mk();
        const events2: EngineEvent[] = [];
        m2.setEventSink((e) => events2.push(e));
        expect(await llmClientFromModel(m2, "main").text({ system: "s", prompt: "p" })).toBe("OK");
        expect(calls).toEqual(["other"]);
        expect(events2[0]!.message).toMatch(/paused until .* the next model is asked instead/);
        // After the pause, one trial request; it works and the provider is used again.
        t = 61_000;
        steps.length = 0;
        calls.length = 0;
        expect(await llmClientFromModel(mk(), "main").text({ system: "s", prompt: "p" })).toBe("OK");
        expect(calls).toEqual(["main"]);
    });

    it("ends a request that takes too long and treats it as a timeout", async () => {
        const slow = new MockLanguageModelV3({
            doGenerate: (o) =>
                new Promise((_, reject) => {
                    o.abortSignal?.addEventListener("abort", () => reject(o.abortSignal!.reason));
                }),
        }) as unknown as ModelV3;
        const model = new ResilientModel([{ name: "slow", provider: "x", breakerKey: "x", model: slow }], { policy: { ...fast, attempts: 1, attemptTimeoutMs: 50 } });
        await expect(llmClientFromModel(model, "slow").text({ system: "s", prompt: "p" })).rejects.toMatchObject({ cls: "timeout" });
    });

    it("a stopped job is not a provider failure: no retry, no health sample, the abort goes through", async () => {
        const calls: string[] = [];
        const ctrl = new AbortController();
        const m = new MockLanguageModelV3({
            doGenerate: (o) =>
                new Promise((_, reject) => {
                    calls.push("x");
                    o.abortSignal?.addEventListener("abort", () => reject(new Error("aborted by caller")));
                    setTimeout(() => ctrl.abort(), 10);
                }),
        }) as unknown as ModelV3;
        const model = new ResilientModel([{ name: "m", provider: "x", breakerKey: "x", model: m }], { policy: fast });
        await expect(model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "p" }] }], abortSignal: ctrl.signal })).rejects.toThrow("aborted by caller");
        expect(calls).toHaveLength(1);
        expect(healthLog.samples()).toHaveLength(0);
    });
});

describe("structured answers: one repair re-ask", () => {
    const schema = z.object({ title: z.string(), steps: z.array(z.string()).min(1) });

    it("asks once more with what was wrong, then succeeds", async () => {
        const prompts: string[] = [];
        const answers = ["not json at all", JSON.stringify({ title: "t", steps: [] }), JSON.stringify({ title: "t", steps: ["a"] })];
        const m = new MockLanguageModelV3({
            doGenerate: async (o) => {
                prompts.push(JSON.stringify(o.prompt));
                return reply(answers.shift()!);
            },
        });
        const client = llmClientFromModel(new ResilientModel([{ name: "m", provider: "x", breakerKey: "x", model: m as unknown as ModelV3 }], { policy: fast }), "m");
        const err = await client.object({ system: "s", prompt: "make a test", schema }).catch((e) => e);
        // Two unusable answers in a row: a plain failure that says so.
        expect(err).toBeInstanceOf(LlmCallError);
        expect(err.cls).toBe("bad_output");
        expect(err.message).toContain("no structured output");
        expect(err.message).toContain("steps");
        expect(prompts).toHaveLength(2);
        expect(prompts[1]).toContain("Your previous answer could not be used: it was not valid JSON");
        // Tokens of the unusable answers still count.
        expect(client.usage.inputTokens).toBe(14);

        // Now one bad answer then a good one.
        prompts.length = 0;
        answers.push(JSON.stringify({ title: "t", steps: ["a"] }));
        answers.unshift(JSON.stringify({ title: "t", steps: [] }));
        expect(await client.object({ system: "s", prompt: "make a test", schema })).toEqual({ title: "t", steps: ["a"] });
        expect(prompts[1]).toMatch(/steps: .*(at least|>=|too small)/i);
    });
});

describe("usage per model with a fallback", () => {
    it("records the tokens under the model that answered", async () => {
        const rows: Array<{ model: string; calls: number; failedCalls: number; inputTokens: number }> = [];
        const backend: MeterBackend = {
            addUsage: (d) => void rows.push({ model: d.model, calls: d.calls, failedCalls: d.failedCalls, inputTokens: d.inputTokens }),
            totalsFor: () => ({ job: 0, project: 0, month: 0 }),
            capsFor: () => ({ caps: {}, warnPercent: 80 }),
            recordStop: () => {},
        };
        const calls: string[] = [];
        const model = new ResilientModel([entry("main", [api(402, { error: { message: "Insufficient credits" } }), reply("a")], calls, "p1"), entry("backup", [reply("b")], calls, "p2")], { policy: fast, sleep: async () => {} });
        const meter = new JobMeter({ backend, jobId: "j", projectId: "p" });
        const client = meter.wrap(llmClientFromModel(model, "main"));
        await client.text({ system: "s", prompt: "p" });
        await client.text({ system: "s", prompt: "p" });
        expect(rows).toEqual([
            { model: "backup", calls: 1, failedCalls: 0, inputTokens: 7 },
            { model: "main", calls: 1, failedCalls: 0, inputTokens: 7 },
        ]);
        expect(typeof client.setEventSink).toBe("function");
    });
});
