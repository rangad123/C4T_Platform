/**
 * The AI response cache (platform/llm-response-cache.ts, sheet #8 b2), through a job's model client as a job builds it (`jobLlm`) and through
 * the runner's AI calls (platform/explore-llm.ts): a repeated allowed reading call is answered without the model, is counted as a cached
 * call and not as a call, and is never given across projects, models, prompt versions, after 14 days, when switched off, or for a call
 * that is not allowed, failed, was refused or held a secret. Scripted models only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ExplorePost } from "../src/agent/explore-transport.js";
import { remoteLlmClient } from "../src/agent/remote-llm.js";
import { loadConfig } from "../src/config.js";
import type { EngineEvent } from "../src/engine/context.js";
import { LlmCallError } from "../src/engine/llm/errors.js";
import { llmClientFromModel, type LlmClient } from "../src/engine/llm/provider.js";
import { RESPONSE_CACHE_CALLS } from "../src/engine/llm/response-cache-calls.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { forgetExploreLlm, handleExploreLlm } from "../src/platform/explore-llm.js";
import type { ExploreTaskRef } from "../src/platform/explore-task.js";
import { jobLlm } from "../src/platform/job-runner.js";
import { JobResponseCache, RESPONSE_CACHE_HIT, RESPONSE_CACHE_LIMITS, RESPONSE_CACHE_TTL_MS, ResponseCacheStore } from "../src/platform/llm-response-cache.js";
import { forgetMemory } from "../src/platform/memory-store.js";
import { DEFAULT_JOB_OPTIONS, type JobOptions, type JobRow } from "../src/platform/repo.js";
import { usageStoreFor } from "../src/platform/usage-store.js";

const Answer = z.object({ pages: z.array(z.object({ path: z.string(), purpose: z.string() })) });
const ANSWER = { pages: [{ path: "/cart", purpose: "Shows what is in the basket" }] };
const ask = (o: Partial<Parameters<LlmClient["object"]>[0]> = {}) => ({ system: "You read pages.", prompt: "Pages: /cart", schema: Answer, purpose: "analysis" as const, cacheAs: "understanding" as const, ...o });

/** The provider: counts calls, answers `next`, and reports 100 input / 20 output tokens a call. */
let providerCalls = 0;
let next: (args: { prompt: string }) => unknown = () => ANSWER;
function scripted(name = "main-model"): LlmClient {
    const usage = { inputTokens: 0, outputTokens: 0 };
    const call = async (args: { prompt: string }) => {
        providerCalls++;
        usage.inputTokens += 100;
        usage.outputTokens += 20;
        return next(args);
    };
    return {
        modelName: name,
        model: undefined as never,
        usage,
        text: async (a) => String(await call(a)),
        object: (async (a: { prompt: string }) => call(a)) as LlmClient["object"],
        imageObject: (async (a: { prompt: string }) => call(a)) as NonNullable<LlmClient["imageObject"]>,
    };
}

let dir: string;
let platform: Platform;
const events: EngineEvent[] = [];

function platformWith(extra: Record<string, string> = {}): Platform {
    const d = fs.mkdtempSync(path.join(dir, "p-"));
    return bootstrap(loadConfig({ DATA_DIR: d, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", LLM_PROVIDER: "anthropic", LLM_API_KEY: "sk-test-not-real-0123456789", LLM_MODEL: "main-model", SECRET_KEY: "response-cache-secret-0123456789", ...extra } as never));
}

let n = 0;
async function jobOn(p: Platform, o: Partial<JobOptions> = {}, projectId?: string, credentials?: { username: string; password: string }): Promise<JobRow> {
    const pid = projectId ?? (p.repo.createProject({ name: `p${++n}` }) as { id: string }).id;
    const app = p.repo.createApplication(pid, "http://shop.test", { ...DEFAULT_JOB_OPTIONS }, credentials as never);
    return p.repo.createJob(pid, app, { ...DEFAULT_JOB_OPTIONS, startedBy: { kind: "open", id: null }, ...o });
}

async function clientFor(p: Platform, job: JobRow, model = "main-model"): Promise<LlmClient> {
    return (await jobLlm({ repo: p.repo, config: p.config, makeLlm: () => scripted(model) }, job, (e) => events.push(e))).llm;
}

const usageOf = (p: Platform, jobId: string) => {
    const rows = usageStoreFor(p.db, p.config).jobRows(jobId);
    return { calls: rows.reduce((s, r) => s + r.calls, 0), cached: rows.reduce((s, r) => s + (r.cachedCalls ?? 0), 0), savedIn: rows.reduce((s, r) => s + (r.savedInputTokens ?? 0), 0) };
};
const stored = (p: Platform, projectId: string) => p.db.all<{ call_id: string; answer_json: string }>("SELECT call_id, answer_json FROM llm_response_cache WHERE project_id = ?", projectId);

beforeAll(() => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY", "LLM_RESPONSE_CACHE"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-response-cache-"));
    platform = platformWith();
});
afterAll(() => {
    platform.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("a job's model client", () => {
    it("a repeated allowed call gets the stored answer without a provider call, counted as a cached call and not a call", async () => {
        const first = await jobOn(platform);
        next = () => ANSWER;
        providerCalls = 0;
        expect(await (await clientFor(platform, first)).object(ask())).toEqual(ANSWER);
        expect(providerCalls).toBe(1);
        // The next exploration of the same project asks the same.
        const second = await jobOn(platform, {}, first.projectId);
        events.length = 0;
        expect(await (await clientFor(platform, second)).object(ask())).toEqual(ANSWER);
        expect(providerCalls).toBe(1);
        expect(usageOf(platform, second.id)).toEqual({ calls: 0, cached: 1, savedIn: 100 });
        expect(usageOf(platform, first.id)).toMatchObject({ calls: 1, cached: 0 });
        expect(events.map((e) => e.kind)).toContain(RESPONSE_CACHE_HIT);
        // Budgets count real calls only.
        expect(usageStoreFor(platform.db, platform.config).jobTokens(second.id)).toBe(0);
    });

    it("misses for another prompt, system text, schema or model, and for another version of the call", async () => {
        const job = await jobOn(platform);
        const llm = await clientFor(platform, job);
        providerCalls = 0;
        await llm.object(ask());
        await llm.object(ask());
        expect(providerCalls).toBe(1);
        await llm.object(ask({ prompt: "Pages: /cart /checkout" }));
        await llm.object(ask({ system: "You read pages carefully." }));
        await llm.object(ask({ schema: Answer.extend({ note: z.string().optional() }) }));
        expect(providerCalls).toBe(4);
        await (await clientFor(platform, await jobOn(platform, {}, job.projectId), "other-model")).object(ask());
        expect(providerCalls).toBe(5);
        const call = RESPONSE_CACHE_CALLS.understanding as { version: number };
        const was = call.version;
        call.version = was + 1;
        try {
            await llm.object(ask());
            expect(providerCalls).toBe(6);
        } finally {
            call.version = was;
        }
        await llm.object(ask());
        expect(providerCalls).toBe(6);
    });

    it("never gives one project's answer to another, even for the same bytes", async () => {
        const a = await jobOn(platform);
        const b = await jobOn(platform);
        providerCalls = 0;
        next = () => ANSWER;
        await (await clientFor(platform, a)).object(ask());
        next = () => ({ pages: [{ path: "/cart", purpose: "Project B's own reading" }] });
        expect(await (await clientFor(platform, b)).object(ask())).toEqual({ pages: [{ path: "/cart", purpose: "Project B's own reading" }] });
        expect(providerCalls).toBe(2);
        expect(stored(platform, a.projectId)).toHaveLength(1);
        expect(JSON.parse(stored(platform, b.projectId)[0]!.answer_json).pages[0].purpose).toBe("Project B's own reading");
        next = () => ANSWER;
    });

    it("never keeps a call that is not on the allow-list, a text or image call, or a planning call", async () => {
        const job = await jobOn(platform);
        const llm = await clientFor(platform, job);
        providerCalls = 0;
        for (let i = 0; i < 2; i++) {
            await llm.object(ask({ cacheAs: undefined }));
            await llm.object(ask({ cacheAs: "verdict" as never, purpose: "review" }));
            // A name every object has is no allowed call either.
            await llm.object(ask({ cacheAs: "constructor" as never, purpose: "review" }));
            await llm.object(ask({ cacheAs: undefined, purpose: "planning" }));
            await llm.text({ system: "s", prompt: "p", purpose: "review" });
            await llm.imageObject!({ system: "s", prompt: "p", images: [], schema: Answer, purpose: "vision" });
        }
        expect(providerCalls).toBe(12);
        expect(stored(platform, job.projectId)).toEqual([]);
    });

    it("never keeps a failed or refused call, an answer that does not fit its schema, or one holding the run's secret", async () => {
        const job = await jobOn(platform, {}, undefined, { username: "shopper", password: "Sekret-Pass-4417" });
        const llm = await clientFor(platform, job);
        next = () => {
            throw new LlmCallError({ cls: "refused" }, { modelName: "main-model" });
        };
        await expect(llm.object(ask())).rejects.toThrow();
        next = () => ({ pages: "not a list" });
        await llm.object(ask({ prompt: "bad shape" }));
        next = () => ({ pages: [{ path: "/login", purpose: "Signs in with Sekret-Pass-4417" }] });
        await llm.object(ask({ prompt: "secret" }));
        next = () => ({ pages: [{ path: "/contact", purpose: "Write to help@shop.example" }] });
        await llm.object(ask({ prompt: "email" }));
        expect(stored(platform, job.projectId)).toEqual([]);
        next = () => ANSWER;
    });

    it("is off for a run with responseCache false, for Explore everything again, and for the server with LLM_RESPONSE_CACHE=false", async () => {
        const first = await jobOn(platform);
        await (await clientFor(platform, first)).object(ask());
        providerCalls = 0;
        await (await clientFor(platform, await jobOn(platform, { responseCache: false }, first.projectId))).object(ask());
        await (await clientFor(platform, await jobOn(platform, { fullExploration: true }, first.projectId))).object(ask());
        expect(providerCalls).toBe(2);
        const off = platformWith({ LLM_RESPONSE_CACHE: "false" });
        try {
            const j = await jobOn(off);
            await (await clientFor(off, j)).object(ask());
            await (await clientFor(off, await jobOn(off, {}, j.projectId))).object(ask());
            expect(providerCalls).toBe(4);
            expect(stored(off, j.projectId)).toEqual([]);
        } finally {
            off.db.close();
        }
    });

    it("Forget what we learned removes the project's stored answers", async () => {
        const job = await jobOn(platform);
        await (await clientFor(platform, job)).object(ask());
        expect(stored(platform, job.projectId)).toHaveLength(1);
        expect(forgetMemory(platform.db, job.projectId)).toBe(1);
        expect(stored(platform, job.projectId)).toEqual([]);
    });
});

describe("the store", () => {
    const pid = () => (platform.repo.createProject({ name: `s${++n}` }) as { id: string }).id;

    it("an answer is given for 14 days from when it was made, then asked again", async () => {
        let now = Date.parse("2026-11-01T00:00:00Z");
        const store = new ResponseCacheStore(platform.db.sql, () => now);
        const p = pid();
        await store.put(p, "k", "understanding", ANSWER, { input: 1, output: 1 });
        now += RESPONSE_CACHE_TTL_MS - 60_000;
        expect((await store.get(p, "k"))?.answer).toEqual(ANSWER);
        now += 120_000;
        expect(await store.get(p, "k")).toBeUndefined();
        expect(await store.count(p)).toBe(0);
        expect(RESPONSE_CACHE_TTL_MS).toBe(14 * 24 * 3600 * 1000);
    });

    it("keeps a project within its entry and byte limits, dropping the least recently used first", async () => {
        let now = Date.parse("2026-11-01T00:00:00Z");
        const store = new ResponseCacheStore(platform.db.sql, () => (now += 1000), { entries: 3, bytes: 10_000, entryBytes: 2_000 });
        const p = pid();
        const other = pid();
        await store.put(other, "o", "rules", ANSWER, { input: 0, output: 0 });
        for (const k of ["a", "b", "c"]) await store.put(p, k, "rules", ANSWER, { input: 0, output: 0 });
        await store.get(p, "a");
        await store.put(p, "d", "rules", ANSWER, { input: 0, output: 0 });
        const keys = async (q: string) => (await platform.db.sql.all<{ cache_key: string }>("SELECT cache_key FROM llm_response_cache WHERE project_id = ? ORDER BY cache_key", q)).map((r) => r.cache_key);
        // b was used least recently.
        expect(await keys(p)).toEqual(["a", "c", "d"]);
        expect(await keys(other)).toEqual(["o"]);
        // Too large to keep at all.
        expect(await store.put(p, "big", "rules", { text: "x".repeat(3_000) }, { input: 0, output: 0 })).toBe(false);
        // Bytes: four answers of 3,000 bytes do not fit in 10,000.
        const q = pid();
        const s2 = new ResponseCacheStore(platform.db.sql, () => (now += 1000), { entries: 100, bytes: 10_000, entryBytes: 5_000 });
        for (const k of ["w", "x", "y", "z"]) await s2.put(q, k, "rules", { text: "x".repeat(2_990) }, { input: 0, output: 0 });
        expect(await keys(q)).toEqual(["x", "y", "z"]);
        expect(RESPONSE_CACHE_LIMITS).toEqual({ entries: 1000, bytes: 20 * 1024 * 1024, entryBytes: 512 * 1024 });
    });

    it("a key from one project is never read in another", async () => {
        const store = new ResponseCacheStore(platform.db.sql);
        const a = pid();
        const b = pid();
        const cache = new JobResponseCache({ store, projectId: a, jobId: "j", ai: { model: "m" }, secrets: [], modelName: "m" });
        const key = cache.key("understanding", "client", { prompt: "p" });
        expect(new JobResponseCache({ store, projectId: b, jobId: "j", ai: { model: "m" }, secrets: [], modelName: "m" }).key("understanding", "client", { prompt: "p" })).not.toBe(key);
        await store.put(a, key, "understanding", ANSWER, { input: 0, output: 0 });
        expect(await store.get(b, key)).toBeUndefined();
        expect((await store.get(a, key))?.answer).toEqual(ANSWER);
    });
});

describe("an exploration on a runner", () => {
    const REQS = { requirements: [{ id: "R-1", text: "A shopper can empty the basket", kind: "functional" }] };
    let runnerProviderCalls = 0;
    let answer: () => Awaited<ReturnType<MockLanguageModelV3["doGenerate"]>> = () => ({
        content: [{ type: "text", text: JSON.stringify(REQS) }],
        finishReason: { unified: "stop", raw: "end_turn" },
        usage: { inputTokens: { total: 300, noCache: 300, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 40, text: 40, reasoning: 0 } },
        warnings: [],
    });
    const mock = new MockLanguageModelV3({ provider: "prov", modelId: "main-model", doGenerate: async () => (runnerProviderCalls++, answer()) });
    const Reqs = z.object({ requirements: z.array(z.object({ id: z.string(), text: z.string(), section: z.string().optional(), kind: z.string() })) });

    let t = 0;
    async function runnerClient(job: JobRow): Promise<LlmClient> {
        const task: ExploreTaskRef = { taskId: `rt${++t}`, attempt: 1, jobId: job.id, projectId: job.projectId, agentId: "a1" };
        const deps = { repo: platform.repo, config: platform.config, makeLlm: () => llmClientFromModel(mock as unknown as LanguageModel, "main-model") };
        const post: ExplorePost = async (_route, body) => JSON.parse(JSON.stringify(await handleExploreLlm(deps, task, JSON.parse(JSON.stringify(body)))));
        return remoteLlmClient({ post, modelName: "main-model" });
    }
    const reqAsk = { system: "You normalise requirements.", prompt: "Candidate requirements: [R-1] empty the basket", schema: Reqs, purpose: "planning" as const, cacheAs: "requirements" as const };

    it("is answered on the platform from the project's stored answers, counted as cached", async () => {
        const first = await jobOn(platform);
        runnerProviderCalls = 0;
        expect(await (await runnerClient(first)).object(reqAsk)).toEqual(REQS);
        const second = await jobOn(platform, {}, first.projectId);
        const llm = await runnerClient(second);
        expect(await llm.object(reqAsk)).toEqual(REQS);
        expect(runnerProviderCalls).toBe(1);
        // The runner's engine counts nothing for it; the platform counts a cached call.
        expect(llm.usage.inputTokens).toBe(0);
        await forgetExploreLlm(`rt${t}`);
        await forgetExploreLlm(`rt${t - 1}`);
        expect(usageOf(platform, second.id)).toEqual({ calls: 0, cached: 1, savedIn: 300 });
        // Another project asks the same: its own call.
        await (await runnerClient(await jobOn(platform))).object(reqAsk);
        expect(runnerProviderCalls).toBe(2);
    });

    it("keeps nothing for a call without the hint, a call the runner marks but the platform does not allow, a cut or refused answer, or one that fails the call's schema", async () => {
        const job = await jobOn(platform);
        const llm = await runnerClient(job);
        await llm.object({ ...reqAsk, cacheAs: undefined });
        await llm.object({ ...reqAsk, cacheAs: "verdict" as never, prompt: "marked" });
        const good = answer;
        answer = () => ({ ...good(), finishReason: { unified: "length", raw: "max_tokens" } });
        await llm.object({ ...reqAsk, prompt: "cut" }).catch(() => undefined);
        answer = () => ({ ...good(), content: [], finishReason: { unified: "content-filter", raw: "refusal" } });
        await llm.object({ ...reqAsk, prompt: "refused" }).catch(() => undefined);
        // Valid for the runner's lax schema, not for the requirements schema the platform checks with.
        answer = () => ({ ...good(), content: [{ type: "text", text: JSON.stringify({ requirements: [{ id: "R-1", text: "t", kind: "not-a-kind" }] }) }] });
        await llm.object({ ...reqAsk, prompt: "wrong shape" });
        answer = good;
        expect(stored(platform, job.projectId)).toEqual([]);
    });

    it("is off for a run with responseCache false", async () => {
        const first = await jobOn(platform);
        await (await runnerClient(first)).object(reqAsk);
        runnerProviderCalls = 0;
        await (await runnerClient(await jobOn(platform, { responseCache: false }, first.projectId))).object(reqAsk);
        expect(runnerProviderCalls).toBe(1);
    });
});
