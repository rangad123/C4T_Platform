/**
 * Prompt caching (docs/features/prompt-caching.md) over real HTTP, never a real provider:
 *   - the real provider SDKs talk to a local fake Anthropic and a fake OpenRouter (tests/fixtures/fake-llm-provider.ts): the request
 *     bodies carry the cache markers in the right place, the answers are unchanged, and the off switch (Settings and LLM_PROMPT_CACHE) removes them;
 *   - cached tokens from the providers' usage answers are counted separately, kept in the usage store, shown by the usage routes, priced,
 *     and weighed by the budget check;
 *   - a simulated Anthropic prompt cache (the documented prefix rules: breakpoints, a 20-block lookback, a minimum length) measures what
 *     an agent loop and a phone exploration send with caching on and off.
 * Ports: 7290 fake provider, 7291 cache simulator. Starts no browser.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { generateText, stepCountIs, tool } from "ai";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig, type Config } from "../src/config.js";
import { JobMeter, type MeterBackend } from "../src/engine/llm/metered.js";
import { addUsage, cacheStyleFor, envPromptCache, markAnthropicRequest, markChatCompletionsBody, promptCacheSetting, setPromptCacheSource } from "../src/engine/llm/prompt-cache.js";
import { createLlmClient, PROVIDER_OPTIONS, type LlmClient, type LlmProviderId, type Usage } from "../src/engine/llm/provider.js";
import { resetBreakers } from "../src/engine/llm/resilience.js";
import { budgetTokens, costOf, decideBudget, totalsOf } from "../src/engine/llm/usage.js";
import { EXPLORE_SYSTEM } from "../src/engine/mobile/explore/prompts.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { UsageStore } from "../src/platform/usage-store.js";
import { startFakeProvider, type FakeProvider } from "./fixtures/fake-llm-provider.js";

const fast = { baseDelayMs: 5, maxDelayMs: 20, attemptTimeoutMs: 5000, deadlineMs: 20_000 };
const cfg = (env: Record<string, string>): Config => loadConfig({ DATA_DIR: os.tmpdir(), ...env });
const anthropicCfg = (extra: Record<string, string> = {}) => cfg({ LLM_PROVIDER: "anthropic", LLM_MODEL: "claude-sonnet-5-5", LLM_API_KEY: "fake-key", ...extra });
const routerCfg = (model: string, extra: Record<string, string> = {}) => cfg({ LLM_PROVIDER: "openai-compatible", LLM_BASE_URL: "http://unused.invalid/v1", LLM_MODEL: model, LLM_API_KEY: "fake-key", ...extra });

let fake: FakeProvider;
const base = (p: LlmProviderId) => (p === "anthropic" ? `${fake.url}/anthropic/v1` : p === "google" ? `${fake.url}/google/v1beta` : `${fake.url}/openai/v1`);
const clientFor = (c: Config, baseURL = base): LlmClient => createLlmClient(c, { fallbacks: [], baseURLFor: baseURL, resilience: { policy: fast } });

const SYSTEM = "You are a careful QA engineer. Follow the rules.";
const Answer = z.object({ answer: z.string() });

/** A meter backend in memory: every row the meter writes. */
function memory() {
    const rows: Array<Parameters<MeterBackend["addUsage"]>[0]> = [];
    const backend: MeterBackend = { addUsage: (d) => void rows.push(d), totalsFor: () => ({ job: 0, project: 0, month: 0 }), capsFor: () => ({ caps: {}, warnPercent: 80 }), recordStop: () => {} };
    return { rows, backend };
}

/** The tool loop the authoring agent runs (author.ts): generateText over `client.model` with tools, usage added per step. */
async function agentLoop(llm: LlmClient, steps: number, toolOutput: (i: number) => string = (i) => `snapshot ${i}`) {
    const calls: number[] = [];
    const res = await generateText({
        model: llm.model,
        system: SYSTEM,
        prompt: "Scenario: open the shop. Accessibility snapshot:\n- heading \"Shop\"",
        tools: {
            look: tool({ description: "Look at the page again.", inputSchema: z.object({ step: z.number() }), execute: async ({ step }) => (calls.push(step), toolOutput(step)) }),
        },
        providerOptions: PROVIDER_OPTIONS,
        maxRetries: 0,
        stopWhen: stepCountIs(steps + 1),
        onStepFinish: (e) => addUsage(llm.usage, e.usage),
    });
    return { text: res.text, calls };
}

const anthropicToolUse = (i: number, usage: Record<string, number> = { input_tokens: 50, output_tokens: 5 }) => ({
    body: { id: `msg_${i}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "tool_use", id: `toolu_${i}`, name: "look", input: { step: i } }], stop_reason: "tool_use", stop_sequence: null, usage },
});
const anthropicText = (text: string, usage: Record<string, number> = { input_tokens: 50, output_tokens: 5 }) => ({
    body: { id: "msg_end", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage },
});
const chatToolCall = (model: string, i: number) => ({
    body: { id: `c${i}`, object: "chat.completion", created: 1, model, choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "look", arguments: JSON.stringify({ step: i }) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 } },
});

beforeAll(async () => {
    fake = await startFakeProvider(7290);
});
afterAll(async () => {
    await fake?.close();
});
afterEach(() => {
    fake.reset();
    resetBreakers();
    setPromptCacheSource(undefined);
});

// ── rules (pure) ─────────────────────────────────────────────────────────────

describe("which providers get markers", () => {
    it("Anthropic gets explicit markers, an Anthropic model behind an OpenAI-compatible gateway gets the passthrough, the rest cache on their own or not at all", () => {
        expect(cacheStyleFor("anthropic", "claude-sonnet-5-5")).toBe("anthropic");
        expect(cacheStyleFor("openai-compatible", "anthropic/claude-sonnet-5.5")).toBe("anthropic-passthrough");
        expect(cacheStyleFor("openai-compatible", "claude-sonnet-5-5")).toBe("anthropic-passthrough");
        expect(cacheStyleFor("openai-compatible", "meta-llama/llama-3.1-8b-instruct:free")).toBe("none");
        expect(cacheStyleFor("openai-compatible", "llama3.1")).toBe("none");
        expect(cacheStyleFor("openai", "gpt-5.4")).toBe("automatic");
        expect(cacheStyleFor("google", "gemini-2.5-flash")).toBe("automatic");
    });

    it("the switch: on by default, LLM_PROMPT_CACHE turns it off, a choice saved in Settings wins over both", () => {
        expect(promptCacheSetting({ LLM_PROMPT_CACHE: undefined })).toEqual({ enabled: true, source: "default" });
        for (const off of ["false", "off", "0", "no", " OFF "]) expect(envPromptCache(off)).toBe(false);
        for (const on of ["true", "on", "1", "", "yes"]) expect(envPromptCache(on)).toBe(true);
        expect(promptCacheSetting({ LLM_PROMPT_CACHE: "off" })).toEqual({ enabled: false, source: "environment" });
        setPromptCacheSource(() => true);
        expect(promptCacheSetting({ LLM_PROMPT_CACHE: "off" })).toEqual({ enabled: true, source: "app" });
        setPromptCacheSource(() => undefined);
        expect(promptCacheSetting({ LLM_PROMPT_CACHE: "off" })).toEqual({ enabled: false, source: "environment" });
        setPromptCacheSource(() => {
            throw new Error("database closed");
        });
        expect(promptCacheSetting({ LLM_PROMPT_CACHE: undefined }).enabled).toBe(true);
    });

    it("marking never changes the text that is sent: only provider options are added", () => {
        const params = {
            prompt: [
                { role: "system" as const, content: "rules" },
                { role: "user" as const, content: [{ type: "text" as const, text: "the page" }] },
            ],
        };
        const single = markAnthropicRequest(params as never);
        expect(single.prompt.map((m: any) => m.content)).toEqual(params.prompt.map((m) => m.content));
        expect((single.prompt[0] as any).providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
        expect((single.prompt[1] as any).providerOptions).toBeUndefined();
        expect((single as any).providerOptions).toBeUndefined();
        const loop = markAnthropicRequest({ ...params, tools: [{ type: "function", name: "look", inputSchema: {} }] } as never);
        expect((loop as any).providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
        expect(params.prompt[0]).toEqual({ role: "system", content: "rules" }); // the input is not mutated

        const body = { model: "anthropic/claude", messages: [{ role: "system", content: "rules" }, { role: "user", content: "page" }, { role: "assistant", content: "ok" }] };
        expect(markChatCompletionsBody(body).messages).toEqual([{ role: "system", content: [{ type: "text", text: "rules", cache_control: { type: "ephemeral" } }] }, { role: "user", content: "page" }, { role: "assistant", content: "ok" }]);
        const withTools = markChatCompletionsBody({ ...body, tools: [{}] });
        expect(withTools.messages![1]).toEqual({ role: "user", content: [{ type: "text", text: "page", cache_control: { type: "ephemeral" } }] });
        expect(markChatCompletionsBody({ prompt: "not chat" } as never)).toEqual({ prompt: "not chat" });
    });

    it("usage counters: cache fields appear only once a provider reports them", () => {
        const u: Usage = { inputTokens: 0, outputTokens: 0 };
        addUsage(u, { inputTokens: 7, outputTokens: 3, inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: undefined } });
        expect(u).toEqual({ inputTokens: 7, outputTokens: 3 });
        addUsage(u, { inputTokens: 1000, outputTokens: 10, inputTokenDetails: { cacheReadTokens: 800, cacheWriteTokens: 150 } });
        addUsage(u, { inputTokens: 100, outputTokens: 1, cachedInputTokens: 90 });
        expect(u).toEqual({ inputTokens: 1107, outputTokens: 14, cacheReadTokens: 890, cacheWriteTokens: 150 });
    });

    it("budget weight and cost: reads count a tenth, writes a quarter more; without cache tokens nothing changes", () => {
        expect(budgetTokens({ inputTokens: 1000, outputTokens: 200 })).toBe(1200);
        // 100 plain + 800 read at 0.1 + 100 written at 1.25 = 100 + 80 + 125 = 305 input, + 200 output
        expect(budgetTokens({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 800, cacheWriteTokens: 100 })).toBe(505);
        // over-reported cache numbers never make the count negative
        expect(budgetTokens({ inputTokens: 10, outputTokens: 0, cacheReadTokens: 50, cacheWriteTokens: 50 })).toBe(1);
        const price = { inputPerMTok: 3, outputPerMTok: 15 };
        expect(costOf(1_000_000, 0, price, { read: 800_000, write: 100_000 })).toBeCloseTo(3, 6); // no cache prices: input price for all
        expect(costOf(1_000_000, 0, { ...price, cachedInputPerMTok: 0.3, cacheWritePerMTok: 3.75 }, { read: 800_000, write: 100_000 })).toBeCloseTo(0.3 + 0.24 + 0.375, 6);
        const t = totalsOf([{ day: "2026-10-01", projectId: "p", purpose: "authoring", model: "m", calls: 2, failedCalls: 0, inputTokens: 1000, outputTokens: 200, images: 0, estimatedCalls: 0, cacheReadTokens: 800, cacheWriteTokens: 100 }]);
        expect(t).toMatchObject({ inputTokens: 1000, totalTokens: 1200, cacheReadTokens: 800, cacheWriteTokens: 100, budgetTokens: 505 });
    });
});

// ── what reaches a fake Anthropic ────────────────────────────────────────────

describe("Anthropic: markers in the request body", () => {
    it("a single structured call: the instructions carry cache_control, the answer is the same as with caching off", async () => {
        fake.queue("claude-sonnet-5-5", { text: '{"answer":"ok"}' }, { text: '{"answer":"ok"}' });
        const on = await clientFor(anthropicCfg()).object({ system: SYSTEM, prompt: "page one", schema: Answer });
        const off = await clientFor(anthropicCfg({ LLM_PROMPT_CACHE: "off" })).object({ system: SYSTEM, prompt: "page one", schema: Answer });
        expect(on).toEqual({ answer: "ok" });
        expect(off).toEqual(on);
        const [a, b] = fake.seen.map((s) => s.body);
        expect(a.system.at(-1)).toEqual({ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } });
        // No request-level marker on a one-off call: its prompt is different every time, and a cache write costs more than a plain read.
        expect(a.cache_control).toBeUndefined();
        expect(JSON.stringify(a.messages)).not.toContain("cache_control");
        expect(JSON.stringify(b)).not.toContain("cache_control");
        // Apart from the markers the two requests are byte-for-byte the same.
        const strip = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => (k === "cache_control" ? undefined : x)));
        expect(strip(a)).toEqual(strip(b));
    });

    it("an agent loop: every step marks the instructions (tools render before them) and asks for the conversation to be cached", async () => {
        fake.queue("claude-sonnet-5-5", anthropicToolUse(1), anthropicToolUse(2), anthropicText("done"));
        const llm = clientFor(anthropicCfg());
        const out = await agentLoop(llm, 3);
        expect(out).toEqual({ text: "done", calls: [1, 2] });
        expect(fake.seen).toHaveLength(3);
        for (const s of fake.seen) {
            expect(s.body.cache_control).toEqual({ type: "ephemeral" });
            expect(s.body.system.at(-1).cache_control).toEqual({ type: "ephemeral" });
            expect(s.body.tools.map((t: any) => t.name)).toEqual(["look"]);
            expect(s.body.tools[0].cache_control).toBeUndefined();
        }
        // The conversation grows by appending only, so each step's prefix is the previous step's whole request.
        const msgs = fake.seen.map((s) => JSON.stringify(s.body.messages));
        expect(msgs[1]!.startsWith(msgs[0]!.slice(0, -1))).toBe(true);
        expect(msgs[2]!.startsWith(msgs[1]!.slice(0, -1))).toBe(true);
    });

    it("turning it off in Settings applies to the next request of a client that already exists", async () => {
        const llm = clientFor(anthropicCfg());
        fake.queue("claude-sonnet-5-5", anthropicToolUse(1), anthropicText("done"), anthropicToolUse(1), anthropicText("done"));
        await agentLoop(llm, 2);
        setPromptCacheSource(() => false);
        const out = await agentLoop(llm, 2);
        expect(out.text).toBe("done");
        expect(fake.seen.slice(0, 2).every((s) => JSON.stringify(s.body).includes("cache_control"))).toBe(true);
        expect(fake.seen.slice(2).some((s) => JSON.stringify(s.body).includes("cache_control"))).toBe(false);
    });

    it("cache reads and writes from Anthropic's usage answer are counted apart from the total, per step and per call", async () => {
        fake.queue(
            "claude-sonnet-5-5",
            anthropicToolUse(1, { input_tokens: 20, output_tokens: 6, cache_creation_input_tokens: 1500, cache_read_input_tokens: 0 }),
            anthropicText("done", { input_tokens: 30, output_tokens: 4, cache_creation_input_tokens: 60, cache_read_input_tokens: 1500 }),
        );
        const { rows, backend } = memory();
        const llm = new JobMeter({ backend, jobId: "j1", projectId: "p1" }).wrap(clientFor(anthropicCfg()));
        await agentLoop(llm, 2);
        // Anthropic reports uncached input apart; the SDK's total (and ours) includes the cached part.
        expect(llm.usage).toEqual({ inputTokens: 20 + 1500 + 30 + 60 + 1500, outputTokens: 10, cacheReadTokens: 1500, cacheWriteTokens: 1560 });
        fake.queue("claude-sonnet-5-5", { body: { ...anthropicText('{"answer":"ok"}').body, usage: { input_tokens: 40, output_tokens: 8, cache_read_input_tokens: 900 } } });
        await llm.object({ system: SYSTEM, prompt: "page", schema: Answer, purpose: "analysis" });
        const sum = (k: "inputTokens" | "cacheReadTokens" | "cacheWriteTokens") => rows.reduce((n, r) => n + (r[k] ?? 0), 0);
        expect([sum("inputTokens"), sum("cacheReadTokens"), sum("cacheWriteTokens")]).toEqual([3110 + 940, 2400, 1560]);
        expect(rows.find((r) => r.purpose === "analysis")).toMatchObject({ inputTokens: 940, cacheReadTokens: 900, calls: 1 });
    });
});

// ── what reaches a fake OpenRouter ───────────────────────────────────────────

describe("OpenRouter (OpenAI-compatible) asked for an Anthropic model", () => {
    const MODEL = "anthropic/claude-sonnet-5.5";

    it("cache_control rides along on the system message, and on the first user message in an agent loop", async () => {
        fake.queue(MODEL, { text: '{"answer":"ok"}' }, chatToolCall(MODEL, 1), { text: "done" });
        const llm = clientFor(routerCfg(MODEL));
        expect(await llm.object({ system: SYSTEM, prompt: "page", schema: Answer })).toEqual({ answer: "ok" });
        const single = fake.seen[0]!.body;
        expect(single.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }] });
        expect(single.messages[1]).toEqual({ role: "user", content: "page" });

        expect((await agentLoop(llm, 2)).text).toBe("done");
        for (const s of fake.seen.slice(1)) {
            expect(s.body.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
            expect(s.body.messages[1].role).toBe("user");
            expect(s.body.messages[1].content.at(-1).cache_control).toEqual({ type: "ephemeral" });
            expect(JSON.stringify(s.body.messages.slice(2))).not.toContain("cache_control");
        }
    });

    it("another model on the same endpoint, and the off switch, send the body exactly as before", async () => {
        fake.queue("meta-llama/llama-3.1-8b-instruct", { text: "a" });
        await clientFor(routerCfg("meta-llama/llama-3.1-8b-instruct")).text({ system: SYSTEM, prompt: "page" });
        fake.queue(MODEL, { text: "b" });
        await clientFor(routerCfg(MODEL, { LLM_PROMPT_CACHE: "false" })).text({ system: SYSTEM, prompt: "page" });
        for (const s of fake.seen) expect(s.body.messages).toEqual([{ role: "system", content: SYSTEM }, { role: "user", content: "page" }]);
    });

    it("OpenRouter's cached_tokens and cache_write_tokens are read from the usage answer", async () => {
        fake.queue(MODEL, { body: { id: "c", object: "chat.completion", created: 1, model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 2000, completion_tokens: 10, total_tokens: 2010, prompt_tokens_details: { cached_tokens: 1800, cache_write_tokens: 150 } } } });
        const { rows, backend } = memory();
        const llm = new JobMeter({ backend, jobId: "j2", projectId: "p1" }).wrap(clientFor(routerCfg(MODEL)));
        expect(await llm.text({ system: SYSTEM, prompt: "page" })).toBe("hi");
        expect(llm.usage).toEqual({ inputTokens: 2000, outputTokens: 10, cacheReadTokens: 1800, cacheWriteTokens: 150 });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ inputTokens: 2000, outputTokens: 10, cacheReadTokens: 1800, cacheWriteTokens: 150, model: MODEL });
    });

    it("OpenAI direct and Google get nothing extra (they cache on their own)", async () => {
        fake.queue("gpt-5.4", { body: { id: "r1", object: "response", created_at: 1, model: "gpt-5.4", output: [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "x", annotations: [] }] }], usage: { input_tokens: 5, output_tokens: 1 } } });
        await clientFor(cfg({ LLM_PROVIDER: "openai", LLM_MODEL: "gpt-5.4", LLM_API_KEY: "fake-key" })).text({ system: SYSTEM, prompt: "page" }).catch(() => undefined);
        fake.queue("gemini-2.5-flash", { text: "x" });
        await clientFor(cfg({ LLM_PROVIDER: "google", LLM_MODEL: "gemini-2.5-flash", LLM_API_KEY: "fake-key" })).text({ system: SYSTEM, prompt: "page" });
        expect(fake.seen.length).toBe(2);
        for (const s of fake.seen) expect(JSON.stringify(s.body)).not.toMatch(/cache_control|prompt_cache_breakpoint/);
    });
});

// ── budgets and the usage store ──────────────────────────────────────────────

describe("budgets count cached tokens at their weight", () => {
    it("a call that fits because most of its input came from the cache is allowed; the same tokens uncached would be refused", () => {
        const weighted = budgetTokens({ inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 9_000 });
        expect(weighted).toBe(10_000 - 8_100 + 500);
        expect(decideBudget({ job: weighted, project: 0, month: 0 }, { job: 5_000 }).allowed).toBe(true);
        expect(decideBudget({ job: 10_500, project: 0, month: 0 }, { job: 5_000 }).allowed).toBe(false);
    });

    it("the meter and the store agree on the weighted totals, so a limit means the same before and after a re-read", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-cache-store-"));
        const p = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "test-secret-key-0123456789" }));
        try {
            const store = new UsageStore(p.db);
            const meter = new JobMeter({ backend: store, jobId: "job-c", projectId: "proj-c", refreshEvery: 1 });
            fake.queue(
                "claude-sonnet-5-5",
                { body: { ...anthropicText('{"answer":"ok"}').body, usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 2000 } } },
                { body: { ...anthropicText('{"answer":"ok"}').body, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 2000 } } },
            );
            const llm = meter.wrap(clientFor(anthropicCfg()));
            await llm.object({ system: SYSTEM, prompt: "a", schema: Answer, purpose: "analysis" });
            await llm.object({ system: SYSTEM, prompt: "b", schema: Answer, purpose: "analysis" });
            meter.finish();
            // call 1: 100 + 2000 x 1.25 + 50 = 2650; call 2: 100 + 2000 x 0.1 + 50 = 350
            expect(store.jobTokens("job-c")).toBe(3000);
            expect(store.monthTokens(new Date().toISOString().slice(0, 7), "proj-c")).toBe(3000);
            const t = totalsOf(store.jobRows("job-c"));
            expect(t).toMatchObject({ inputTokens: 4200, outputTokens: 100, totalTokens: 4300, cacheReadTokens: 2000, cacheWriteTokens: 2000, budgetTokens: 3000 });
            // A database written before this feature (no cache columns yet) gains them when it opens again; the numbers stay.
            p.db.raw.exec("ALTER TABLE ai_usage DROP COLUMN cache_write_tokens");
            const again = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "test-secret-key-0123456789" }));
            expect(new UsageStore(again.db).jobRows("job-c")[0]).toMatchObject({ cacheReadTokens: 2000 });
            again.db.close();
        } finally {
            p.db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("Settings and the usage routes", () => {
    let dir: string;
    let platform: Platform;
    let server: Awaited<ReturnType<typeof buildServer>>;
    const call = async (method: "GET" | "PUT", url: string, payload?: unknown) => {
        const res = await server.inject({ method, url, payload: payload as never });
        return { status: res.statusCode, body: res.json() as any };
    };
    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-cache-api-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", LLM_API_KEY: "fake-key", LLM_PROMPT_CACHE: "off", SECRET_KEY: "test-secret-key-0123456789" }));
        server = await buildServer(platform);
    });
    afterAll(async () => {
        await server?.close();
        platform?.db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("GET/PUT /api/llm/prompt-cache: the server's setting, a saved choice that wins, and back to the server's", async () => {
        const first = await call("GET", "/api/llm/prompt-cache");
        expect(first.body).toMatchObject({ enabled: false, source: "environment", environment: false, provider: "anthropic", style: "anthropic" });
        expect(first.body.explanation).toContain("Anthropic");
        const on = await call("PUT", "/api/llm/prompt-cache", { enabled: true });
        expect(on.body).toMatchObject({ enabled: true, source: "app", environment: false });
        // The engine of this process reads the same choice.
        expect(promptCacheSetting(platform.config)).toEqual({ enabled: true, source: "app" });
        expect((await call("PUT", "/api/llm/prompt-cache", { enabled: null })).body).toMatchObject({ enabled: false, source: "environment" });
        expect((await call("PUT", "/api/llm/prompt-cache", { enabled: "yes" })).status).toBe(400);
        expect((await call("PUT", "/api/llm/prompt-cache", { enabled: true, extra: 1 })).status).toBe(400);
    });

    it("a job's usage shows what came from the cache; prices take a cached-input price and the cost uses it", async () => {
        const projectId = platform.repo.createProject({ name: "Cache shop" }).id as string;
        const job = await platform.repo.createJob(projectId, platform.repo.createApplication(projectId, "http://example.test", { ...DEFAULT_JOB_OPTIONS }, undefined), { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] });
        const store = new UsageStore(platform.db);
        store.addUsage({ jobId: job.id, projectId, purpose: "authoring", model: "claude-sonnet-5-5", at: new Date(), calls: 4, failedCalls: 0, inputTokens: 40_000, outputTokens: 2_000, images: 0, estimatedCalls: 0, cacheReadTokens: 30_000, cacheWriteTokens: 6_000 });
        const u = (await call("GET", `/api/jobs/${job.id}/usage`)).body;
        expect(u.summary).toBe("40K in, 2K out, 4 calls, 30K of the input read from the prompt cache and 6K written to it");
        expect(u.totals).toMatchObject({ cacheReadTokens: 30_000, cacheWriteTokens: 6_000, budgetTokens: 4_000 + 3_000 + 7_500 + 2_000 });

        const put = await call("PUT", "/api/usage/prices", { model: "claude-sonnet-5-5", inputPerMTok: 2, outputPerMTok: 10, cachedInputPerMTok: 0.2, cacheWritePerMTok: 2.5 });
        expect(put.body.prices).toEqual([{ model: "claude-sonnet-5-5", inputPerMTok: 2, outputPerMTok: 10, cachedInputPerMTok: 0.2, cacheWritePerMTok: 2.5 }]);
        const priced = (await call("GET", `/api/jobs/${job.id}/usage`)).body;
        // 4,000 x 2 + 30,000 x 0.2 + 6,000 x 2.5 + 2,000 x 10, per million
        expect(priced.totals.cost).toBeCloseTo((8_000 + 6_000 + 15_000 + 20_000) / 1_000_000, 9);
        expect((await call("PUT", "/api/usage/prices", { currency: "USD", cachedInputPerMTok: 1 })).status).toBe(400);
        // Saving the two prices only clears the cache prices again.
        expect((await call("PUT", "/api/usage/prices", { model: "claude-sonnet-5-5", inputPerMTok: 2, outputPerMTok: 10 })).body.prices).toEqual([{ model: "claude-sonnet-5-5", inputPerMTok: 2, outputPerMTok: 10 }]);
        const month = (await call("GET", `/api/usage?groupBy=model`)).body;
        expect(month.totals).toMatchObject({ cacheReadTokens: 30_000, cacheWriteTokens: 6_000 });
        expect(month.month.usedTokens).toBe(16_500); // the limit counts the weighted tokens
    });
});

// ── the measured effect, on a simulated Anthropic prompt cache ───────────────

/**
 * A fake Anthropic Messages endpoint that bills like Anthropic's prompt cache as documented: blocks in the order tools, system,
 * messages; a prefix is cached at each breakpoint (block cache_control, or the request-level marker on the last block) once it is at
 * least MIN tokens; a later request reads the longest cached prefix found at or up to 20 blocks before one of its breakpoints. Tokens
 * are characters / 4. The answers are scripted, so the same conversation runs with caching on and off.
 */
async function startCacheSimulator(port: number, answer: (body: any, n: number) => unknown) {
    const MIN = 512;
    const cache = new Set<string>();
    const strip = (b: unknown) => JSON.stringify(b, (k, v) => (k === "cache_control" ? undefined : v));
    let n = 0;
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const blocks: any[] = [...(body.tools ?? []), ...(Array.isArray(body.system) ? body.system : body.system ? [{ type: "text", text: body.system }] : [])];
            for (const m of body.messages) for (const c of typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content) blocks.push({ role: m.role, ...c });
            const tokens = blocks.map((b) => Math.ceil(strip(b).length / 4));
            const cum: number[] = [];
            tokens.reduce((s, t, i) => (cum[i] = s + t), 0);
            const key = (i: number) => crypto.createHash("sha1").update(blocks.slice(0, i + 1).map(strip).join("\u0001")).digest("hex");
            const bps = blocks.map((b, i) => (b.cache_control ? i : -1)).filter((i) => i >= 0);
            if (body.cache_control) bps.push(blocks.length - 1);
            let read = 0;
            for (const bp of [...new Set(bps)].sort((a, b) => b - a)) {
                for (let j = bp; j >= Math.max(0, bp - 20) && !read; j--) if (cache.has(key(j))) read = cum[j]!;
                if (read) break;
            }
            let write = 0;
            for (const bp of bps) {
                if (cum[bp]! < MIN) continue;
                if (!cache.has(key(bp))) write = Math.max(write, cum[bp]! - read);
                cache.add(key(bp));
            }
            const total = cum[cum.length - 1] ?? 0;
            const out: any = answer(body, n++);
            out.usage = { input_tokens: total - read - write, output_tokens: 20, cache_read_input_tokens: read, cache_creation_input_tokens: write };
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(out));
        });
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
    return { url: `http://127.0.0.1:${port}`, reset: () => ((n = 0), cache.clear()), close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("measured: tokens with caching on and off (simulated Anthropic cache)", () => {
    // A page snapshot of about 2,400 characters, like the sample shop's product list.
    const snapshot = (i: number) => `- heading "Products, view ${i}"\n` + Array.from({ length: 40 }, (_, k) => `- link "Product ${k + 1}, ${(k + 1) * 3} EUR" [ref=e${k + 10}]`).join("\n");
    const AGENT_SYSTEM = EXPLORE_SYSTEM; // a real instruction text of the platform (about 650 tokens)
    let sim: Awaited<ReturnType<typeof startCacheSimulator>>;
    const STEPS = 10;
    beforeAll(async () => {
        sim = await startCacheSimulator(7291, (body, n) =>
            !body.tools?.length
                ? { id: `m${n}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: '{"kind":"back"}' }], stop_reason: "end_turn", stop_sequence: null }
                : n % (STEPS + 1) < STEPS
                ? { id: `m${n}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "tool_use", id: `t${n}`, name: "look", input: { step: n % (STEPS + 1) } }], stop_reason: "tool_use", stop_sequence: null }
                : { id: `m${n}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: "done" }], stop_reason: "end_turn", stop_sequence: null },
        );
    });
    afterAll(async () => {
        await sim?.close();
    });

    async function run(on: boolean, kind: "agent" | "turns") {
        sim.reset();
        setPromptCacheSource(() => on);
        const { rows, backend } = memory();
        const llm = new JobMeter({ backend, jobId: `m-${kind}-${on}`, projectId: "p" }).wrap(createLlmClient(anthropicCfg(), { fallbacks: [], baseURLFor: () => `${sim.url}/v1`, resilience: { policy: fast } }));
        let result: unknown;
        if (kind === "agent") {
            result = await generateText({
                model: llm.model,
                system: AGENT_SYSTEM,
                prompt: `Scenario: browse the product list and open one product.\nAccessibility snapshot:\n${snapshot(0)}`,
                tools: { look: tool({ description: "Look at the page again.", inputSchema: z.object({ step: z.number() }), execute: async ({ step }) => snapshot(step + 1) }) },
                providerOptions: PROVIDER_OPTIONS,
                maxRetries: 0,
                stopWhen: stepCountIs(STEPS + 1),
                onStepFinish: (e) => addUsage(llm.usage, e.usage),
            }).then((r) => [r.text, r.steps.length]);
        } else {
            // A phone exploration: one structured call per screen, the same instructions every time, a different screen each time.
            const answers: unknown[] = [];
            for (let i = 0; i < STEPS; i++) answers.push(await llm.text({ system: AGENT_SYSTEM, prompt: `This is screen S${i}.\n${snapshot(i).slice(0, 1200)}\nChoose the next action.`, purpose: "analysis" }));
            result = answers;
        }
        const sum = (k: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens") => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
        const u = { inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), cacheReadTokens: sum("cacheReadTokens"), cacheWriteTokens: sum("cacheWriteTokens") };
        return { result, ...u, weighted: budgetTokens(u) };
    }

    it("an agent loop of 10 steps (the web authoring agent's shape) sends the same conversation for far fewer effective tokens", async () => {
        const off = await run(false, "agent");
        const on = await run(true, "agent");
        expect(on.result).toEqual(off.result);
        expect(on.inputTokens).toBe(off.inputTokens); // the same text was sent
        expect(off.cacheReadTokens + off.cacheWriteTokens).toBe(0);
        const saved = 1 - on.weighted / off.weighted;
        console.log(`[prompt-cache] agent loop, ${STEPS} steps: off ${off.weighted} tokens; on ${on.weighted} effective (${on.inputTokens} in, ${on.cacheReadTokens} read from cache, ${on.cacheWriteTokens} written), ${Math.round(saved * 100)}% less`);
        expect(saved).toBeGreaterThan(0.5);
    });

    it("ten one-off calls with the same instructions (the phone explorer's shape): only the instructions are cached", async () => {
        const off = await run(false, "turns");
        const on = await run(true, "turns");
        expect(on.result).toEqual(off.result);
        expect(on.inputTokens).toBe(off.inputTokens);
        expect(on.cacheWriteTokens).toBeGreaterThan(0);
        expect(on.cacheReadTokens).toBe(on.cacheWriteTokens * (STEPS - 1));
        const saved = 1 - on.weighted / off.weighted;
        console.log(`[prompt-cache] ${STEPS} one-off calls: off ${off.weighted} tokens; on ${on.weighted} effective (${on.cacheReadTokens} read from cache, ${on.cacheWriteTokens} written), ${Math.round(saved * 100)}% less`);
        expect(saved).toBeGreaterThan(0.2);
    });
});
