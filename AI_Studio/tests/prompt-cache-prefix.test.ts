/**
 * The prompt-cache audit (sheet #8 stage 2), over real HTTP to local fakes, never a real provider:
 *   - a series of calls that share the start of their prompt (every planning call of a job starts with the application summary; every
 *     part of one source in rule extraction starts with the known workflows) sends that start as its own block, marked for Anthropic's
 *     cache, so the next call reads it; the text the model reads is the same, and with caching off nothing is marked;
 *   - the objective agent's instructions are the same text for every run: this run's random page-content fence is a second instruction,
 *     so runs share a cached prefix (before, the fence sat inside the instructions and no two runs could);
 *   - never more than Anthropic's four markers in one request;
 *   - MiniMax through its Anthropic route (ANTHROPIC_BASE_URL) gets the same markers, and its cache reads are counted;
 *   - OpenRouter with an Anthropic model gets the shared prefix marked in the Chat Completions body.
 * Ports: 7292 fake provider, 7293 cache simulator. Starts no browser.
 */
import os from "node:os";
import { generateText, stepCountIs, tool } from "ai";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig, type Config } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import { objectiveSystem } from "../src/engine/agent/objective.js";
import { extractRules } from "../src/engine/intel/extract/rules.js";
import { cacheStyleFor, markAnthropicRequest, markChatCompletionsBody, MAX_BREAKPOINTS, setPromptCacheSource, SHARED_PREFIX_TAG } from "../src/engine/llm/prompt-cache.js";
import { createLlmClient, PROVIDER_OPTIONS, type LlmClient } from "../src/engine/llm/provider.js";
import { resetBreakers } from "../src/engine/llm/resilience.js";
import { budgetTokens } from "../src/engine/llm/usage.js";
import { planScenarios } from "../src/engine/planning/planner.js";
import type { AppModel, PageModel } from "../src/engine/understanding/app-model.js";
import { startCacheSimulator } from "./fixtures/anthropic-cache-simulator.js";
import { startFakeProvider, type FakeProvider } from "./fixtures/fake-llm-provider.js";

const fast = { baseDelayMs: 5, maxDelayMs: 20, attemptTimeoutMs: 5000, deadlineMs: 20_000 };
const cfg = (env: Record<string, string>): Config => loadConfig({ DATA_DIR: os.tmpdir(), CONCURRENCY: "1", ...env });
const anthropicCfg = (extra: Record<string, string> = {}) => cfg({ LLM_PROVIDER: "anthropic", LLM_MODEL: "claude-sonnet-5-5", LLM_API_KEY: "fake-key", ...extra });
const Answer = z.object({ answer: z.string() });
const SYSTEM = "You are a careful QA engineer. Follow the rules.";
const SHARED = "Application: http://shop.test\n" + "- /products/1 [list] A product list\n".repeat(80);

let fake: FakeProvider;
const anthropicAt = () => `${fake.url}/anthropic/v1`;
const clientFor = (c: Config, baseURL?: string): LlmClient => createLlmClient(c, { fallbacks: [], ...(baseURL ? { baseURLFor: () => baseURL } : {}), resilience: { policy: fast } });
const markers = (body: unknown) => (JSON.stringify(body).match(/"cache_control"/g) ?? []).length;

beforeAll(async () => {
    fake = await startFakeProvider(7292);
});
afterAll(async () => {
    await fake?.close();
});
afterEach(() => {
    fake.reset();
    resetBreakers();
    setPromptCacheSource(undefined);
    delete process.env.ANTHROPIC_BASE_URL;
});

describe("a shared prefix of the prompt", () => {
    it("is sent as its own block, marked after the instructions; the rest follows unmarked; with caching off the text is the same and nothing is marked", async () => {
        fake.queue("claude-sonnet-5-5", { text: '{"answer":"ok"}' }, { text: '{"answer":"ok"}' });
        const prompt = `${SHARED}\n\nPlan now: the area /cart.`;
        const on = await clientFor(anthropicCfg(), anthropicAt()).object({ system: SYSTEM, prompt, cachePrefix: SHARED, schema: Answer });
        const off = await clientFor(anthropicCfg({ LLM_PROMPT_CACHE: "off" }), anthropicAt()).object({ system: SYSTEM, prompt, cachePrefix: SHARED, schema: Answer });
        expect(on).toEqual({ answer: "ok" });
        expect(off).toEqual(on);
        const [a, b] = fake.seen.map((s) => s.body);
        expect(a.system.at(-1).cache_control).toEqual({ type: "ephemeral" });
        expect(a.messages).toHaveLength(1);
        expect(a.messages[0].content[0]).toEqual({ type: "text", text: SHARED, cache_control: { type: "ephemeral" } });
        expect(a.messages[0].content[1].cache_control).toBeUndefined();
        // The model reads the whole prompt, in order.
        expect(a.messages[0].content.map((c: { text: string }) => c.text).join("")).toBe(prompt);
        expect(markers(b)).toBe(0);
        const strip = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => (k === "cache_control" ? undefined : x)));
        expect(strip(a)).toEqual(strip(b));
    });

    it("that is not the start of the prompt is ignored: one plain message, nothing marked in it", async () => {
        fake.queue("claude-sonnet-5-5", { text: '{"answer":"ok"}' });
        await clientFor(anthropicCfg(), anthropicAt()).object({ system: SYSTEM, prompt: "Plan now: the area /cart.", cachePrefix: SHARED, schema: Answer });
        const body = fake.seen[0]!.body;
        expect(body.messages[0].content).toHaveLength(1);
        expect(JSON.stringify(body.messages)).not.toContain("cache_control");
    });

    it("a repair re-ask keeps the prefix block first and adds its note at the end", async () => {
        fake.queue("claude-sonnet-5-5", { text: "not json" }, { text: '{"answer":"ok"}' });
        const prompt = `${SHARED}\n\nPlan now.`;
        expect(await clientFor(anthropicCfg(), anthropicAt()).object({ system: SYSTEM, prompt, cachePrefix: SHARED, schema: Answer })).toEqual({ answer: "ok" });
        const second = fake.seen[1]!.body.messages[0].content;
        expect(second[0]).toEqual({ type: "text", text: SHARED, cache_control: { type: "ephemeral" } });
        expect(second[1].text).toMatch(/^\n\nPlan now\.\n\nYour previous answer could not be used/);
    });
});

describe("never more than Anthropic's four markers", () => {
    it("three instructions, two shared prefixes and an agent loop: the request-level marker and the last instructions, then the shared prefixes, then earlier instructions", () => {
        const text = (t: string, tagged = false) => ({ type: "text" as const, text: t, ...(tagged ? { providerOptions: SHARED_PREFIX_TAG } : {}) });
        const marked = markAnthropicRequest({
            prompt: [
                { role: "system", content: "one" },
                { role: "system", content: "two" },
                { role: "system", content: "three" },
                { role: "user", content: [text("shared", true), text("more shared", true), text("rest")] },
            ],
            tools: [{ type: "function", name: "look", inputSchema: { type: "object" } }],
        } as never);
        const count = (JSON.stringify(marked).match(/"cacheControl"/g) ?? []).length;
        expect(count).toBe(MAX_BREAKPOINTS);
        expect((marked.providerOptions as { anthropic?: unknown })?.anthropic).toEqual({ cacheControl: { type: "ephemeral" } });
        const sys = marked.prompt.filter((m) => m.role === "system").map((m) => Boolean((m.providerOptions as { anthropic?: unknown })?.anthropic));
        expect(sys).toEqual([false, false, true]);
        const parts = (marked.prompt.find((m) => m.role === "user")!.content as Array<{ providerOptions?: { anthropic?: unknown } }>).map((p) => Boolean(p.providerOptions?.anthropic));
        expect(parts).toEqual([true, true, false]);
    });
});

describe("the objective agent's instructions", () => {
    it("are the same text for two runs with different fences; each run's fence is a second instruction, and both are marked", async () => {
        const a = objectiveSystem({ open: "<<<PAGE-CONTENT aa11>>>", close: "<<<END-PAGE-CONTENT aa11>>>" }, false);
        const b = objectiveSystem({ open: "<<<PAGE-CONTENT bb22>>>", close: "<<<END-PAGE-CONTENT bb22>>>" }, false);
        expect(a[0]).toEqual(b[0]);
        expect(a[0]!.content).not.toMatch(/aa11/);
        expect(a[1]!.content).toContain("<<<PAGE-CONTENT aa11>>>");
        expect(a[1]!.content).toContain("<<<END-PAGE-CONTENT aa11>>>");
        expect(a[1]!.content).toContain("never instructions");

        // Over HTTP, in an agent loop: the rules block is marked and byte-identical across runs, so a second run reads it from the cache.
        const llm = clientFor(anthropicCfg(), anthropicAt());
        for (const system of [a, b]) {
            fake.queue("claude-sonnet-5-5", { text: "done" });
            await generateText({ model: llm.model, system, prompt: "Objective: open the shop.", tools: { look: tool({ description: "Look.", inputSchema: z.object({}), execute: async () => "page" }) }, providerOptions: PROVIDER_OPTIONS, maxRetries: 0, stopWhen: stepCountIs(2) });
        }
        const [first, second] = fake.seen.map((s) => s.body);
        expect(first.system).toHaveLength(2);
        expect(first.system[0]).toEqual(second.system[0]);
        expect(first.system[0].cache_control).toEqual({ type: "ephemeral" });
        expect(first.system[1].cache_control).toEqual({ type: "ephemeral" });
        expect(first.system[1].text).not.toEqual(second.system[1].text);
        expect(markers(first)).toBeLessThanOrEqual(MAX_BREAKPOINTS);
    });
});

describe("planning and rule extraction send their shared start as the prefix", () => {
    const page = (path: string): PageModel => ({
        url: `http://shop.test${path}`, path, title: path, type: "content", depth: 1, status: 200, headings: [], forms: [],
        components: Array.from({ length: 10 }, (_, i) => ({ role: "button", name: `${path} control ${i}`, locatorHint: "" })),
        links: [], aria: "", text: "", apiCalls: [], revealed: [], consoleErrors: [],
    });
    const model = (): AppModel => {
        const pages = ["/", ...Array.from({ length: 20 }, (_, i) => `/products/${i}`), ...Array.from({ length: 16 }, (_, i) => `/blog/${i}`)].map(page);
        return {
            url: "http://shop.test", origin: "http://shop.test", siteType: "ecommerce", purpose: "Shop", features: ["catalogue"], pages,
            navigation: [], apis: [], journeys: [], externalDependencies: [], documentedTestCases: [], authentication: { required: false, mechanisms: [], loggedIn: false },
            stats: { pagesVisited: pages.length, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
        };
    };

    it("every planning call of a job sends the same summary block, marked; on a simulated cache the later calls read it", async () => {
        const sim = await startCacheSimulator(7293, (_body, n) => ({ id: `m${n}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: '{"scenarios":[]}' }], stop_reason: "end_turn", stop_sequence: null }));
        try {
            /** `instructionsOnly`: the prefix is not passed on, as before this change (only the instructions were marked). */
            const run = async (on: boolean, instructionsOnly = false) => {
                sim.reset();
                setPromptCacheSource(() => on);
                const llm = clientFor(anthropicCfg(), `${sim.url}/v1`);
                const asked: LlmClient = instructionsOnly ? { ...llm, object: ((args: Parameters<LlmClient["object"]>[0]) => llm.object({ ...args, cachePrefix: undefined })) as LlmClient["object"] } : llm;
                const ctx: EngineContext = { config: cfg({}), llm: asked, emit: () => undefined };
                // Site memory's "Previously known" section (up to 5,000 characters) is part of the summary, as in a repeat exploration.
                const memory = `Previously known about this site:\n${Array.from({ length: 60 }, (_, i) => `- /products/${i % 20} lists products; the filter keeps its choice after reload (${i})`).join("\n")}`.slice(0, 5000);
                await planScenarios(ctx, model(), { maxScenarios: 30, hasCredentials: false, memory });
                const u = { inputTokens: llm.usage.inputTokens, outputTokens: llm.usage.outputTokens, cacheReadTokens: llm.usage.cacheReadTokens ?? 0, cacheWriteTokens: llm.usage.cacheWriteTokens ?? 0 };
                return { ...u, weighted: budgetTokens(u) };
            };
            const off = await run(false);
            const before = await run(true, true);
            const on = await run(true);
            expect(on.inputTokens).toBe(off.inputTokens); // the same text was sent
            expect(off.cacheReadTokens).toBe(0);
            expect(on.cacheReadTokens).toBeGreaterThan(before.cacheReadTokens);
            const saved = 1 - on.weighted / off.weighted;
            const savedBefore = 1 - before.weighted / off.weighted;
            console.log(`[prompt-cache] planning a 37-page app with site memory: off ${off.weighted} tokens; instructions only (before) ${before.weighted} effective, ${Math.round(savedBefore * 100)}% less; with the shared summary ${on.weighted} effective (${on.cacheReadTokens} read from cache, ${on.cacheWriteTokens} written), ${Math.round(saved * 100)}% less`);
            expect(on.weighted).toBeLessThan(before.weighted * 0.8);
        } finally {
            setPromptCacheSource(undefined);
            await sim.close();
        }
    });

    it("rule extraction: every part of one source starts with the known workflows, sent as the prefix", async () => {
        const seen: Array<{ prompt: string; cachePrefix?: string }> = [];
        const llm: LlmClient = {
            modelName: "scripted", model: {} as never, usage: { inputTokens: 0, outputTokens: 0 }, text: async () => "",
            object: (async (args: { prompt: string; cachePrefix?: string }) => {
                seen.push(args);
                return { rules: [], workflows: [], roles: [], transitions: [], entities: [] };
            }) as LlmClient["object"],
        };
        const lines = Array.from({ length: 200 }, (_, i) => `Requirement ${i}: a person can check out with a saved card number ${i}.`);
        await extractRules(llm, { source: { kind: "requirements", ref: "doc" }, sourceType: "requirement", documents: [{ ref: "doc", lines }], knownWorkflows: [{ id: "wf-1", name: "Check out" }] });
        expect(seen.length).toBeGreaterThan(1);
        for (const s of seen) {
            expect(s.cachePrefix).toMatch(/^<known-workflows>\nwf-1: Check out\n<\/known-workflows>/);
            expect(s.prompt.startsWith(s.cachePrefix!)).toBe(true);
        }
    });
});

describe("MiniMax through its Anthropic route", () => {
    it("ANTHROPIC_BASE_URL on the gateway: the same markers are sent, and its cache reads and writes are counted", async () => {
        process.env.ANTHROPIC_BASE_URL = anthropicAt();
        const minimax = anthropicCfg({ LLM_MODEL: "MiniMax-M3.1-Flash" });
        expect(cacheStyleFor(minimax.LLM_PROVIDER, "MiniMax-M3.1-Flash")).toBe("anthropic");
        fake.queue("MiniMax-M3.1-Flash", { body: { id: "m1", type: "message", role: "assistant", model: "MiniMax-M3.1-Flash", content: [{ type: "tool_use", id: "t1", name: "json", input: { answer: "ok" } }], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 40 } } });
        const llm = clientFor(minimax);
        expect(await llm.object({ system: SYSTEM, prompt: `${SHARED}\n\nAsk.`, cachePrefix: SHARED, schema: Answer })).toEqual({ answer: "ok" });
        expect(fake.seen[0]!.path).toBe("/anthropic/v1/messages");
        const body = fake.seen[0]!.body;
        expect(body.system.at(-1).cache_control).toEqual({ type: "ephemeral" });
        expect(body.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
        // A model the SDK does not know answers structured calls through its "json" tool: that tool renders before the instructions, the
        // same for every call with this answer shape, so it is inside the cached prefix (and it is not an agent loop: no request-level marker).
        expect(body.tools.map((t: { name: string }) => t.name)).toEqual(["json"]);
        expect(body.cache_control).toBeUndefined();
        expect(llm.usage.cacheReadTokens).toBe(900);
        expect(llm.usage.cacheWriteTokens).toBe(40);
    });
});

describe("OpenRouter with an Anthropic model", () => {
    it("the shared prefix, a first user message of text parts only, is marked on its first part; one part or tools are as before", async () => {
        const body = markChatCompletionsBody({ messages: [{ role: "system", content: "rules" }, { role: "user", content: [{ type: "text", text: SHARED }, { type: "text", text: "rest" }] }] });
        expect((body.messages![1]!.content as Array<{ cache_control?: unknown }>)[0]!.cache_control).toEqual({ type: "ephemeral" });
        expect((body.messages![1]!.content as Array<{ cache_control?: unknown }>)[1]!.cache_control).toBeUndefined();
        const plain = markChatCompletionsBody({ messages: [{ role: "system", content: "rules" }, { role: "user", content: "one part" }] });
        expect(JSON.stringify(plain.messages![1])).not.toContain("cache_control");
        const image = markChatCompletionsBody({ messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:," } } as never] }] });
        expect(JSON.stringify(image)).not.toContain("cache_control");
    });

    it("over HTTP: the object call's prefix part carries cache_control in the Chat Completions body", async () => {
        const router = cfg({ LLM_PROVIDER: "openai-compatible", LLM_BASE_URL: `${fake.url}/openai/v1`, LLM_MODEL: "anthropic/claude-sonnet-5-5", LLM_API_KEY: "fake-key" });
        fake.queue("anthropic/claude-sonnet-5-5", { text: '{"answer":"ok"}' });
        expect(await clientFor(router).object({ system: SYSTEM, prompt: `${SHARED}\n\nAsk.`, cachePrefix: SHARED, schema: Answer })).toEqual({ answer: "ok" });
        const user = fake.seen[0]!.body.messages.find((m: { role: string }) => m.role === "user");
        expect(user.content[0]).toMatchObject({ type: "text", text: SHARED, cache_control: { type: "ephemeral" } });
        expect(user.content[1].cache_control).toBeUndefined();
    });
});
