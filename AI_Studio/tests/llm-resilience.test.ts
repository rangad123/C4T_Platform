/**
 * AI model reliability over real HTTP: the real provider SDKs (OpenAI-compatible/OpenRouter, Anthropic, Google) talk to a local fake
 * provider that answers with each error class; the platform's Settings routes (health, fallback list, connection check) run on a real
 * platform with a temporary database. Never a real provider. Ports: 6870-6889.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig, type Config } from "../src/config.js";
import type { EngineEvent } from "../src/engine/context.js";
import { LlmCallError } from "../src/engine/llm/errors.js";
import { healthLog } from "../src/engine/llm/health.js";
import { JobMeter, type MeterBackend } from "../src/engine/llm/metered.js";
import { createLlmClient, setFallbackModelSource, type LlmProviderId } from "../src/engine/llm/provider.js";
import { resetBreakers } from "../src/engine/llm/resilience.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CONNECTION_CHECK_PROJECT, flushLlmHealth, resetConnectionCheck } from "../src/platform/llm-health.js";
import { buildServer } from "../src/platform/server.js";
import { UsageStore } from "../src/platform/usage-store.js";
import { startFakeProvider, type FakeProvider } from "./fixtures/fake-llm-provider.js";

let fake: FakeProvider;
const fast = { baseDelayMs: 5, maxDelayMs: 20, attemptTimeoutMs: 3000, deadlineMs: 20_000, breakerFailures: 4, breakerCooldownMs: 60_000 };

const cfg = (env: Record<string, string>): Config => loadConfig({ DATA_DIR: os.tmpdir(), ...env });
const compat = (extra: Record<string, string> = {}) => cfg({ LLM_PROVIDER: "openai-compatible", LLM_BASE_URL: `${fake.url}/openai/v1`, LLM_MODEL: "main-model", LLM_API_KEY: "fake-key", ...extra });
const base = (p: LlmProviderId) => (p === "anthropic" ? `${fake.url}/anthropic/v1` : p === "google" ? `${fake.url}/google/v1beta` : `${fake.url}/openai/v1`);

function client(c: Config, events: EngineEvent[] = [], policy: Record<string, number> = {}) {
    const llm = createLlmClient(c, { baseURLFor: base, resilience: { policy: { ...fast, ...policy } } });
    llm.setEventSink?.((e) => events.push(e));
    return llm;
}

beforeAll(async () => {
    fake = await startFakeProvider(6871);
});
afterAll(async () => {
    await fake?.close();
});
afterEach(() => {
    fake.reset();
    resetBreakers();
    healthLog.clear();
});

describe("OpenAI-compatible endpoint (OpenRouter, local servers)", () => {
    it("rides out a rate limit, waiting as long as Retry-After says", async () => {
        fake.queue("main-model", { status: 429, body: { error: { message: "Rate limit exceeded: free-models-per-min", code: 429 } }, headers: { "retry-after-ms": "300" } }, { text: "hello" });
        const events: EngineEvent[] = [];
        const t0 = Date.now();
        expect(await client(compat(), events).text({ system: "s", prompt: "p" })).toBe("hello");
        expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
        expect(fake.seen.map((s) => s.model)).toEqual(["main-model", "main-model"]);
        expect(events.map((e) => e.kind)).toEqual(["ai_model_retry", "ai_model_answered"]);
    });

    it("out of credit (402): the fallback model answers, the job is told, usage is recorded per model", async () => {
        fake.queue("main-model", { status: 402, body: { error: { code: 402, message: "Insufficient credits. Add more using https://openrouter.ai/settings/credits" } } });
        fake.queue("backup-model", { text: "from backup" });
        const events: EngineEvent[] = [];
        const rows: Array<{ model: string; inputTokens: number }> = [];
        const backend: MeterBackend = { addUsage: (d) => void rows.push({ model: d.model, inputTokens: d.inputTokens }), totalsFor: () => ({ job: 0, project: 0, month: 0 }), capsFor: () => ({ caps: {}, warnPercent: 80 }), recordStop: () => {} };
        const raw = client(compat({ LLM_FALLBACK_MODELS: "backup-model" }), events);
        const llm = new JobMeter({ backend, jobId: "j1", projectId: "p1" }).wrap(raw);
        expect(await llm.text({ system: "s", prompt: "p" })).toBe("from backup");
        expect(fake.seen.map((s) => s.model)).toEqual(["main-model", "backup-model"]);
        expect(events.map((e) => e.message)).toEqual(["main-model is unavailable (out of credit); asking the fallback model backup-model.", "The fallback AI model backup-model answered."]);
        expect(rows).toEqual([{ model: "backup-model", inputTokens: 11 }]);
    });

    it("the 'Provider returned error' answer becomes a sentence that says what happened upstream", async () => {
        const body = { error: { code: 502, message: "Provider returned error", metadata: { raw: JSON.stringify({ error: { code: 529, message: "Overloaded" } }), provider_name: "Anthropic" } } };
        fake.queue("main-model", { status: 502, body }, { status: 502, body });
        const err = await client(compat(), [], { attempts: 2 })
            .text({ system: "s", prompt: "p" })
            .catch((e) => e);
        expect(err).toBeInstanceOf(LlmCallError);
        expect(err.cls).toBe("overloaded");
        expect(err.message).toBe("The AI provider is overloaded right now. (upstream Anthropic: Overloaded)");
        expect(fake.seen).toHaveLength(2);
    });

    it("a request with no answer is ended by its time limit, and an unreachable server is a network problem", async () => {
        fake.queue("main-model", { hang: true });
        await expect(client(compat(), [], { attempts: 1, attemptTimeoutMs: 400 }).text({ system: "s", prompt: "p" })).rejects.toMatchObject({ cls: "timeout" });
        // Nothing listens on this port of the range.
        const down = cfg({ LLM_PROVIDER: "openai-compatible", LLM_BASE_URL: "http://127.0.0.1:6889/v1", LLM_MODEL: "x", LLM_API_KEY: "k" });
        const err = await createLlmClient(down, { resilience: { policy: { ...fast, attempts: 2 } } })
            .text({ system: "s", prompt: "p" })
            .catch((e) => e);
        expect(err).toMatchObject({ cls: "network" });
        expect(err.message).toMatch(/could not be reached.*ECONNREFUSED/);
    });

    it("a refused key is not retried; a filtered answer is reported as refused", async () => {
        fake.queue("main-model", { status: 401, body: { error: { message: "No auth credentials found", code: 401 } } });
        await expect(client(compat()).text({ system: "s", prompt: "p" })).rejects.toMatchObject({ cls: "auth" });
        expect(fake.seen).toHaveLength(1);
        fake.queue("main-model", { text: "", finish: "content_filter" });
        await expect(client(compat()).text({ system: "s", prompt: "p" })).rejects.toMatchObject({ cls: "refused" });
    });

    it("an answer that is not the requested JSON is asked for once more with the problem, then fails plainly", async () => {
        const schema = z.object({ name: z.string(), count: z.number() });
        fake.queue("main-model", { text: "Sure! Here it is: name=a" }, { text: JSON.stringify({ name: "a", count: 2 }) });
        const llm = client(compat());
        expect(await llm.object({ system: "s", prompt: "give me JSON", schema })).toEqual({ name: "a", count: 2 });
        expect(fake.seen).toHaveLength(2);
        const second = JSON.stringify(fake.seen[1]!.body.messages);
        expect(second).toContain("Your previous answer could not be used: it was not valid JSON");

        fake.reset();
        fake.queue("main-model", { text: JSON.stringify({ name: "a" }) }, { text: JSON.stringify({ name: "a", count: "two" }) });
        const err = await llm.object({ system: "s", prompt: "give me JSON", schema }).catch((e) => e);
        expect(err).toMatchObject({ cls: "bad_output" });
        expect(JSON.stringify(fake.seen[1]!.body.messages)).toContain("count");
        expect(err.message).toContain("count");
    });

    it("pauses a failing provider: later calls send nothing until the pause ends", async () => {
        for (let i = 0; i < 4; i++) fake.queue("main-model", { status: 503, body: { error: { message: "Service temporarily unavailable" } } });
        const events: EngineEvent[] = [];
        await expect(client(compat(), events, { attempts: 4 }).text({ system: "s", prompt: "p" })).rejects.toMatchObject({ cls: "overloaded" });
        expect(fake.seen).toHaveLength(4);
        expect(events.find((e) => e.kind === "ai_provider_paused")?.message).toMatch(/failed 4 times in a row \(overloaded\); calls to it are paused for 60 s/);
        // A new job's client: refused at once, no request reaches the provider.
        const err = await client(compat()).text({ system: "s", prompt: "p" }).catch((e) => e);
        expect(err).toMatchObject({ cls: "paused" });
        expect(err.message).toMatch(/^Calls to this AI provider are paused after repeated failures\. \(until \d\d:\d\d UTC, last: Overloaded\)$/);
        expect(fake.seen).toHaveLength(4);
    });
});

describe("Anthropic and Google over HTTP", () => {
    it("Anthropic: overloaded (529) is retried; a low credit balance moves to the Google fallback", async () => {
        const prev = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
        process.env.GOOGLE_GENERATIVE_AI_API_KEY = "fake-google-key";
        try {
            const c = cfg({ LLM_PROVIDER: "anthropic", LLM_API_KEY: "fake-anthropic", LLM_MODEL: "claude-test", LLM_FALLBACK_MODELS: "google:gemini-test" });
            fake.queue("claude-test", { status: 529, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } }, { text: "claude says hi" });
            expect(await client(c).text({ system: "s", prompt: "p" })).toBe("claude says hi");
            expect(fake.seen.map((s) => s.path)).toEqual(["/anthropic/v1/messages", "/anthropic/v1/messages"]);

            fake.reset();
            fake.queue("claude-test", { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } } });
            fake.queue("gemini-test", { text: "gemini says hi" });
            const events: EngineEvent[] = [];
            expect(await client(c, events).text({ system: "s", prompt: "p" })).toBe("gemini says hi");
            expect(fake.seen.map((s) => s.path)).toEqual(["/anthropic/v1/messages", "/google/v1beta/models/gemini-test:generateContent"]);
            expect(events[0]!.message).toBe("claude-test is unavailable (out of credit); asking the fallback model gemini-test.");
        } finally {
            if (prev === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
            else process.env.GOOGLE_GENERATIVE_AI_API_KEY = prev;
        }
    });

    it("Google: RESOURCE_EXHAUSTED with a retry delay is waited out", async () => {
        const c = cfg({ LLM_PROVIDER: "google", LLM_API_KEY: "fake-google", LLM_MODEL: "gemini-main" });
        fake.queue("gemini-main", { status: 429, body: { error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0.3s" }] } } }, { text: "ok now" });
        const t0 = Date.now();
        expect(await client(c).text({ system: "s", prompt: "p" })).toBe("ok now");
        expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
        fake.queue("gemini-main", { status: 400, body: { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } } });
        await expect(client(c).text({ system: "s", prompt: "p" })).rejects.toMatchObject({ cls: "auth" });
    });
});

describe("Settings: health, fallback list and the connection check", () => {
    let dir: string;
    let platform: Platform;
    let server: Awaited<ReturnType<typeof buildServer>>;
    const call = async (method: "GET" | "PUT" | "POST", url: string, payload?: unknown) => {
        const r = await server.inject({ method, url, payload: payload as never, headers: { "x-api-key": "llm-test-key" } });
        return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined };
    };

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-llm-"));
        platform = bootstrap(
            loadConfig({
                DATA_DIR: dir,
                API_KEY: "llm-test-key",
                SECRET_KEY: "test-secret-key-0123456789",
                LLM_PROVIDER: "openai-compatible",
                LLM_BASE_URL: `${fake.url}/openai/v1`,
                LLM_MODEL: "main-model",
                LLM_API_KEY: "secret-provider-key-123",
                LLM_FALLBACK_MODELS: "env-backup",
                WORKER_EMBEDDED: "false",
                SCHEDULER_ENABLED: "false",
            }),
        );
        server = await buildServer(platform);
    });
    afterAll(async () => {
        await server?.close();
        setFallbackModelSource(undefined);
        platform?.db.close?.();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("needs the API key", async () => {
        const r = await server.inject({ method: "GET", url: "/api/llm/health" });
        expect(r.statusCode).toBe(401);
    });

    it("shows the fallback chain from the environment, then the list saved in Settings, and back", async () => {
        const h = await call("GET", "/api/llm/health");
        expect(h.status).toBe(200);
        expect(h.body).toMatchObject({ configured: true, provider: "openai-compatible", model: "main-model", fallbackSource: "environment", fallbacks: [{ model: "env-backup", ready: true }] });
        expect(JSON.stringify(h.body)).not.toContain("secret-provider-key-123");
        expect(JSON.stringify(h.body)).not.toContain(fake.url);

        const saved = await call("PUT", "/api/llm/fallbacks", { models: ["app-backup", "google:gemini-x"] });
        expect(saved.status).toBe(200);
        expect(saved.body.fallbackSource).toBe("app");
        expect(saved.body.fallbacks.map((f: { model: string; ready: boolean }) => [f.model, f.ready])).toEqual([
            ["app-backup", true],
            ["gemini-x", !!process.env.GOOGLE_GENERATIVE_AI_API_KEY],
        ]);
        // A new client (a new job) uses the saved list.
        fake.queue("main-model", { status: 503, body: { error: { message: "overloaded" } } });
        fake.queue("app-backup", { text: "saved list works" });
        expect(await createLlmClient(platform.config, { resilience: { policy: { ...fast, attempts: 1 } } }).text({ system: "s", prompt: "p" })).toBe("saved list works");

        expect((await call("PUT", "/api/llm/fallbacks", { models: ["has space"] })).status).toBe(400);
        expect((await call("PUT", "/api/llm/fallbacks", { models: ["a", "b", "c", "d", "e", "f"] })).status).toBe(400);
        expect((await call("PUT", "/api/llm/fallbacks", { models: null })).body.fallbackSource).toBe("environment");
    });

    it("checks the connection with one tiny call, counted as usage, and reports health", async () => {
        resetConnectionCheck();
        fake.queue("main-model", { text: "OK" });
        const ok = await call("POST", "/api/llm/check");
        expect(ok.status).toBe(200);
        expect(ok.body).toMatchObject({ ok: true, model: "main-model" });
        expect(fake.seen).toHaveLength(1);
        expect(fake.seen[0]!.body.max_tokens ?? fake.seen[0]!.body.max_completion_tokens).toBe(16);
        // Too soon after the last one: refused, nothing sent.
        expect((await call("POST", "/api/llm/check")).status).toBe(429);
        expect(fake.seen).toHaveLength(1);

        resetConnectionCheck();
        fake.queue("main-model", { status: 402, body: { error: { code: 402, message: "Insufficient credits" } } });
        const bad = await call("POST", "/api/llm/check");
        expect(bad.body).toMatchObject({ ok: false, error: { cls: "credit", label: "Out of credit" } });
        expect(bad.body.error.message).toContain("out of credit");
        // One attempt only, no fallback.
        expect(fake.seen).toHaveLength(2);

        const usage = new UsageStore(platform.db);
        const rows = usage.rows("2000-01-01", "2999-12-31", CONNECTION_CHECK_PROJECT);
        expect(rows.reduce((t, r) => t + r.calls, 0)).toBe(2);
        expect(rows.reduce((t, r) => t + r.failedCalls, 0)).toBe(1);
        expect(rows.reduce((t, r) => t + r.inputTokens, 0)).toBe(11);
        const named = await call("GET", "/api/usage?groupBy=project");
        expect(named.body.groups.find((g: { key: string }) => g.key === CONNECTION_CHECK_PROJECT)?.label).toBe("Connection checks");

        flushLlmHealth(platform.db);
        const h = await call("GET", "/api/llm/health");
        const m = h.body.models.find((x: { model: string }) => x.model === "main-model");
        expect(m).toMatchObject({ calls: 2, failures: 1, successRate: 50, lastError: { cls: "credit", label: "Out of credit" } });
        expect(m.avgLatencyMs).toBeGreaterThanOrEqual(0);
        // Written for other processes too (one row per process in ai_settings).
        const stored = platform.db.all("SELECT key FROM ai_settings WHERE key LIKE 'llm_health:%'");
        expect(stored.length).toBe(1);
    });
});
