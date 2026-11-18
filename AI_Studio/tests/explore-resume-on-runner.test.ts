/**
 * Sheet #5 on a runner (docs/features/explore-on-runner.md): a real platform in runners mode with the REAL runner from source
 * explores a small local site, every model call answered on the platform by a scripted model double.
 *
 * Explore (a plan), create its tests, stop the creation while it writes the second idea: from the stop on, the platform answers no AI call
 * and takes no save for the job, so the runner's child stops and nothing more is made (no further idea, no checks).
 *
 * Browser-launching: node scripts/with-lock.mjs browser -- npx vitest run tests/explore-resume-on-runner.test.ts
 * Ports: platform 6741, sample site 6742. No real model, no network beyond 127.0.0.1.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { memoryLogger } from "../src/agent/log.js";
import { loadConfig } from "../src/config.js";
import { llmClientFromModel } from "../src/engine/llm/provider.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { removeServerExecutionGuard, serverRunRefusals } from "../src/platform/runner-only.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { personalRunner, testPerson } from "./helpers/personal-runner.js";

const PORT = 6741;
const SITE_PORT = 6742;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const API_KEY = "explore-resume-runner-admin-key-77";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS", "AGENT_ACCEPT_SECONDS", "BLOCK_PRIVATE_TARGETS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const IDEAS = [
    { title: "Browse the product list", startPath: "/products", heading: "Products" },
    { title: "Read the about page", startPath: "/about", heading: "About us" },
    { title: "Open the contact page", startPath: "/contact", heading: "Contact" },
] as const;

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dispatch: Worker;
let dataDir: string;
let site: http.Server;
const work: string[] = [];

// ── the scripted model on the platform ───────────────────────────────────────
const usage = { inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
const authored: string[] = [];
let holdAt: string | null = null;
let holding = false;
let held: (() => void) | null = null;
const release = () => {
    held?.();
    held = null;
};
const systemOf = (prompt: Array<{ role: string; content: unknown }>) => prompt.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] });
const tool = (name: string, input: unknown) => ({ content: [{ type: "tool-call" as const, toolCallId: `c${Math.random()}`, toolName: name, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] });
const model = new MockLanguageModelV3({
    provider: "scripted-provider",
    modelId: "scripted-model",
    doGenerate: async (o) => {
        const prompt = o.prompt as Array<{ role: string; content: unknown }>;
        if (o.tools?.length) {
            const all = JSON.stringify(prompt);
            const idea = IDEAS.find((i) => all.includes(i.title));
            const first = prompt.filter((m) => m.role === "assistant").length === 0;
            if (idea && first) {
                authored.push(idea.title);
                if (holdAt === idea.heading) {
                    holdAt = null;
                    holding = true;
                    await new Promise<void>((r) => (held = r));
                    holding = false;
                }
                return tool("assert", { check: "visible", target: { by: "role", role: "heading", value: idea.heading } });
            }
            return tool("finish", { result: "complete", explanation: "checked" });
        }
        const system = systemOf(prompt);
        if (/analysing a web application/.test(system)) {
            return json({ siteType: "ecommerce", purpose: "A small shop", features: ["Browse products"], pagePurposes: [], journeys: [{ name: "Browse products", description: "Look at products", steps: ["Open products"], priority: "high", pages: ["/", "/products"], requiresAuth: false }], authenticationMechanisms: [] });
        }
        if (/planning a web test suite/.test(system) && !JSON.stringify(prompt).includes("Already covered by the plan")) {
            return json({ scenarios: IDEAS.map((s) => ScenarioSchema.omit({ scenarioId: true }).parse({ title: s.title, description: s.title, category: "Browsing", priority: "high", journey: "Browse products", startPath: s.startPath, expectedResults: [`${s.heading} is shown`] })) });
        }
        if (/planning a web test suite/.test(system)) return json({ scenarios: [] });
        return json({ rules: [], workflows: [], roles: [], transitions: [], entities: [] });
    },
});

const call = async (method: string, url: string, body?: unknown, key = API_KEY) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { "x-api-key": key, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; text: string; body: any };
};
const until = async (what: string, check: () => boolean | Promise<boolean>, ms = 120_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
};
const jobDone = async (jobId: string, ms = 300_000) => {
    try {
        await until("the job to finish", () => ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(platform.repo.getJob(jobId)!.status), ms);
    } catch (e) {
        const j = platform.repo.getJob(jobId)!;
        throw new Error(`${(e as Error).message}: ${j.status} ${JSON.stringify(j.progress)} ${platform.repo.listEvents(jobId, 0, 5000).map((x) => `${String(x.kind)}: ${String(x.message).slice(0, 160)}`).join(" | ")}`);
    }
    return (await call("GET", `/api/test-generation/${jobId}`)).body;
};

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "60", AGENT_WATCH_MS: "50", AGENT_NO_AGENT_GRACE_SECONDS: "30", AGENT_ACCEPT_SECONDS: "20" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    const PAGES: Record<string, string> = {
        "/": `<h1>Shop</h1><nav><a href="/products">Products</a> <a href="/about">About</a> <a href="/contact">Contact</a></nav>`,
        "/products": `<h1>Products</h1><a href="/">Home</a>`,
        "/about": `<h1>About us</h1><a href="/">Home</a>`,
        "/contact": `<h1>Contact</h1><a href="/">Home</a>`,
    };
    site = http.createServer((req, res) => {
        const body = PAGES[new URL(req.url ?? "/", "http://x").pathname];
        if (!body) return void res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="en"><head><title>Shop</title></head><body><main>${body}</main></body></html>`);
    });
    await new Promise<void>((r) => site.listen(SITE_PORT, "127.0.0.1", () => r()));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-explore-resume-runner-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY, EXECUTION_MODE: "runners", WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false", SECRET_KEY: "explore-resume-runner-secret-0123456789", DISPATCH_CONCURRENCY: "4", MAX_REPAIR_ATTEMPTS: "0", LLM_PROVIDER: "anthropic" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    dispatch = Worker.dispatch({ ...platform, makeLlm: () => llmClientFromModel(model as unknown as LanguageModel, "scripted-model") }, 100);
    dispatch.start();
}, 60_000);

afterAll(async () => {
    release();
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    await dispatch?.stop();
    server?.server.closeAllConnections();
    await server?.close();
    platform?.db.close();
    removeServerExecutionGuard();
    await new Promise((r) => site.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
    for (const d of work) fs.rmSync(d, { recursive: true, force: true });
});

describe("stop on the runner", () => {
    it("a stopped creation makes nothing more, by AI or without it", async () => {
        const who = testPerson(platform);
        const projectId = (await call("POST", "/api/projects", { name: "Runner resume" }, who.token)).body.id as string;
        const { secret } = personalRunner(platform, { ownerId: who.id, label: "Resume laptop" });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-explore-resume-agent-"));
        work.push(dir);
        const { log } = memoryLogger();
        const agent = new Agent({ config: { baseUrl: BASE, token: secret, name: "Resume laptop", concurrency: 1, workDir: dir, allowInsecure: false, cacheBytes: 64 * 1024 * 1024, tokenSource: "env" }, log, heartbeatMs: 500, backoff: { baseMs: 100, maxMs: 500 }, liveBatch: { maxDelayMs: 200 }, outboxMaxDelayMs: 2000 });
        const done = agent.run();
        const refusedBefore = serverRunRefusals();
        try {
            await until("the runner to connect", () => Boolean(getAgentServices(platform).store.runnerOf(who.id)?.online));
            const s = await call("POST", `/api/projects/${projectId}/test-generation`, { url: SITE, targets: ["web"], maxPages: 5, plan: true, useMemory: false }, who.token);
            expect(s.status, s.text).toBe(202);
            const plan = await jobDone(s.body.jobId);
            expect(["COMPLETED", "PARTIALLY_COMPLETED"], JSON.stringify(plan)).toContain(plan.status);

            holdAt = IDEAS[1].heading;
            const c = await call("POST", `/api/projects/${projectId}/plans/${s.body.jobId}/create`, {}, who.token);
            expect(c.status, c.text).toBe(202);
            const tests = async () => (await call("GET", `/api/projects/${projectId}/tests`, undefined, who.token)).body as Array<{ title: string; validationStatus: string }>;
            // The runner writes ideas side by side: the stop comes once the first one is saved, while the second is held in the AI.
            await until("the second idea to be written", () => holding);
            await until("the first idea's test to be saved", async () => (await tests()).some((t) => t.title === IDEAS[0].title));
            expect((await call("DELETE", `/api/test-generation/${c.body.jobId}`, undefined, who.token)).status).toBe(202);
            const atStop = (await tests()).map((t) => t.title).sort();
            await new Promise((r) => setTimeout(r, 4000));
            release();
            const stopped = await jobDone(c.body.jobId);
            expect(stopped).toMatchObject({ status: "FAILED", error: "Cancelled" });
            // Nothing is made after the stop, by AI or without it: no further idea and no check (the AI's and the saving calls are refused).
            await new Promise((r) => setTimeout(r, 3000));
            const made = (await tests()).map((t) => t.title).sort();
            expect(made).toEqual(atStop);
            expect(made.every((t) => IDEAS.some((i) => i.title === t))).toBe(true);
            expect(made).not.toContain(IDEAS[1].title);
            expect(serverRunRefusals()).toBe(refusedBefore);
        } finally {
            release();
            agent.stop();
            await done;
        }
    }, 480_000);
});
