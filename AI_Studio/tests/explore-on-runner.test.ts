/**
 * Round 51: an exploration runs on the runner of the person who started it, the AI staying on the platform (docs/features/explore-on-runner.md).
 *
 * A real platform on real HTTP in runners mode with its dispatch worker. Hand-driven protocol-2 agents (plain HTTP) prove the dispatch rules:
 * the starter's runner only, the refusals with their codes, an older runner never offered it, attempt fencing on the explore routes, cancel,
 * and a runner that goes away. Then the REAL agent from source explores a small local site: the engine runs in the runner's child process,
 * every model call is answered on the platform by a scripted model double, tests are created on the platform, and the server's own guard
 * refused nothing (it opened no browser and ran no script). A cancel during an exploration stops the child.
 *
 * Browser-launching: node scripts/with-lock.mjs browser -- npx vitest run tests/explore-on-runner.test.ts
 * Ports: platform 9050, sample site 9051. No real model, no network beyond 127.0.0.1.
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
import { EXPLORE_RUNNER_GONE, exploreNeedsUpdate } from "../src/platform/explore-task.js";
import { EXPLORING_ON_RUNNERS_MESSAGE, removeServerExecutionGuard, RUNNER_NOT_SET_UP, RUNNER_OFFLINE, serverRunRefusals } from "../src/platform/runner-only.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { personalRunner, testPerson } from "./helpers/personal-runner.js";

const PORT = 9050;
const SITE_PORT = 9051;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const API_KEY = "explore-runner-admin-key-5e19";
const PASSWORD = "Explore-Pass word/42&z";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS", "AGENT_ACCEPT_SECONDS", "BLOCK_PRIVATE_TARGETS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const caps = (explore = true) => ({ os: "linux", arch: "x64", node: "v24.0.0", browsers: ["chromium"], runnerSwitches: true, ...(explore ? { explore: true } : {}) });

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dispatch: Worker;
let dataDir: string;
let site: http.Server;
const work: string[] = [];

// ── the scripted model on the platform ───────────────────────────────────────
const usage = { inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
/** Tool calls the authoring agent makes, queued when the plan is produced. */
const toolQueue: Array<{ tool: string; input: Record<string, unknown> }> = [];
/** Set to hold every model call until released (the cancel test). */
let hold: Promise<void> | undefined;
let modelCalls = 0;
const systemOf = (prompt: Array<{ role: string; content: unknown }>) => prompt.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] });
const model = new MockLanguageModelV3({
    provider: "scripted-provider",
    modelId: "scripted-model",
    doGenerate: async (o) => {
        modelCalls++;
        if (hold) await hold;
        if (o.tools?.length) {
            const next = toolQueue.shift() ?? { tool: "finish", input: { result: "complete", explanation: "checked" } };
            return { content: [{ type: "tool-call" as const, toolCallId: `c${modelCalls}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
        }
        const system = systemOf(o.prompt as Array<{ role: string; content: unknown }>);
        if (/analysing a web application/.test(system)) {
            return json({
                siteType: "ecommerce",
                purpose: "A small shop",
                features: ["Browse products"],
                pagePurposes: [],
                journeys: [{ name: "Browse products", description: "Look at products", steps: ["Open products"], priority: "high", pages: ["/", "/products"], requiresAuth: false }],
                authenticationMechanisms: [],
            });
        }
        if (/planning a web test suite/.test(system)) {
            toolQueue.push({ tool: "assert", input: { check: "visible", target: { by: "role", role: "heading", value: "Products" } } }, { tool: "finish", input: { result: "complete", explanation: "checked" } });
            return json({ scenarios: [ScenarioSchema.omit({ scenarioId: true }).parse({ title: "Browse the product list", description: "Browse the product list", category: "Browsing", priority: "high", journey: "Browse products", startPath: "/products", expectedResults: ["Products is shown"] })] });
        }
        return json({});
    },
});

// ── helpers ──────────────────────────────────────────────────────────────────
const call = async (method: string, url: string, body?: unknown, key = API_KEY) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { "x-api-key": key, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; text: string; body: any };
};
const agentApi = async (token: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as any) : undefined };
};
const svc = () => getAgentServices(platform);
const until = async (what: string, check: () => boolean | Promise<boolean>, ms = 60_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
};
const jobDone = async (jobId: string, ms = 120_000) => {
    let j: any;
    await until("the job to finish", () => ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes((j = platform.repo.getJob(jobId)!).status), ms);
    return j;
};
const kinds = (jobId: string) => platform.repo.listEvents(jobId).map((e) => String(e.kind));

/** A person with their own API token (they start explorations) and a project they own. */
async function person(name: string) {
    const who = testPerson(platform);
    const project = (await call("POST", "/api/projects", { name }, who.token)).body.id as string;
    return { ...who, project };
}
/** A hand-driven protocol-2 agent for this person's runner. */
async function rawAgent(ownerId: string, name: string, explore = true) {
    const { secret } = personalRunner(platform, { ownerId, label: name });
    const hello = await agentApi(secret, "POST", "/api/agent/hello", { protocol: 1, protocols: [1, 2], name, version: "51.0.0", concurrency: 1, capabilities: caps(explore) });
    expect(hello.status).toBe(200);
    expect(hello.body.protocol).toBe(2);
    return { token: secret, agentId: hello.body.agentId as string, explore };
}
const pollOnce = async (a: { token: string; agentId: string; explore: boolean }) => {
    const r = await agentApi(a.token, "POST", "/api/agent/poll", { agentId: a.agentId, freeSlots: 1, capabilities: caps(a.explore) });
    return r.status === 200 ? r.body : undefined;
};
const poll = async (a: { token: string; agentId: string; explore: boolean }) => {
    for (let i = 0; i < 20; i++) {
        const offer = await pollOnce(a);
        if (offer) return offer;
    }
    throw new Error("no offer");
};
const explore = (p: { token: string; project: string }, over: Record<string, unknown> = {}) =>
    call("POST", `/api/projects/${p.project}/test-generation`, { url: SITE, targets: ["web"], maxPages: 3, credentials: { username: "shopper@example.test", password: PASSWORD }, accessibility: false, healthChecks: false, securityChecks: false, inputChecks: false, contractChecks: false, accessChecks: false, useMemory: false, ...over }, p.token);

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "60", AGENT_WATCH_MS: "50", AGENT_NO_AGENT_GRACE_SECONDS: "30", AGENT_ACCEPT_SECONDS: "20" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = http.createServer((req, res) => {
        const page = (title: string, body: string) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="en"><head><title>${title}</title></head><body><main>${body}</main></body></html>`);
        if (req.url === "/products") return page("Products", `<h1>Products</h1><ul><li>Backpack</li><li>Tent</li></ul><a href="/">Home</a>`);
        if (req.url === "/" || req.url === "") return page("Sample shop", `<h1>Sample shop</h1><a href="/products">Products</a>`);
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    });
    await new Promise<void>((r) => site.listen(SITE_PORT, "127.0.0.1", () => r()));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-explore-runner-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY, EXECUTION_MODE: "runners", WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false", SECRET_KEY: "explore-on-runner-secret-0123456789", DISPATCH_CONCURRENCY: "4", MAX_REPAIR_ATTEMPTS: "0", LLM_PROVIDER: "anthropic" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    dispatch = Worker.dispatch({ ...platform, makeLlm: () => llmClientFromModel(model as unknown as LanguageModel, "scripted-model") }, 100);
    dispatch.start();
}, 60_000);

afterAll(async () => {
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

describe("an exploration goes to its starter's runner", () => {
    it("is offered to the starter's runner, never another person's, with what the child needs; the job says where it runs", async () => {
        const maya = await person("Maya's shop");
        const omar = await person("Omar's shop");
        const mine = await rawAgent(maya.id, "Maya laptop");
        const theirs = await rawAgent(omar.id, "Omar laptop");
        const started = await explore(maya);
        expect(started.status, started.text).toBe(202);
        // Omar's runner looks at Omar's work only.
        for (let i = 0; i < 3; i++) expect(await pollOnce(theirs)).toBeUndefined();
        const offer = await poll(mine);
        expect(offer).toMatchObject({ kind: "explore", jobId: started.body.jobId, adapterId: "explore", scripts: [], env: { baseUrl: SITE, headless: true } });
        expect(offer.attemptId).toEqual(expect.any(String));
        expect(offer.explore.request).toMatchObject({ url: SITE, targets: ["web"], credentials: { username: "shopper@example.test", password: PASSWORD } });
        expect(offer.explore.request).not.toHaveProperty("cleanup.guard");
        expect(offer.explore.secrets).toContain(PASSWORD);
        expect(offer.explore.modelName).toBe("scripted-model");
        expect((await call("GET", `/api/test-generation/${started.body.jobId}`, undefined, maya.token)).body.ranOn).toMatchObject({ kind: "agent", name: "Maya laptop" });
        // Accepted and running: the person's page hears where.
        expect((await agentApi(mine.token, "POST", `/api/agent/tasks/${offer.taskId}/accept`, { attemptId: offer.attemptId })).status).toBe(200);
        await until("the job to say where it explores", () => kinds(started.body.jobId).includes("explore_on_runner"));
        expect(platform.repo.listEvents(started.body.jobId).find((e) => e.kind === "explore_on_runner")!.message).toBe("Exploring on your runner “Maya laptop”.");
        // A runner whose task this is not cannot write into it or spend its AI.
        expect((await agentApi(theirs.token, "POST", `/api/agent/tasks/${offer.taskId}/explore/sink`, { calls: [] }, { "x-attempt-id": offer.attemptId })).status).toBe(404);
        expect((await call("DELETE", `/api/test-generation/${started.body.jobId}`, undefined, maya.token)).status).toBe(202);
        await jobDone(started.body.jobId);
    }, 60_000);

    it("is refused with the run's codes when the person has no runner or it is offline, and an older runner is told to update", async () => {
        const noRunner = await person("No runner");
        const none = await explore(noRunner);
        expect(none).toMatchObject({ status: 409, body: { error: RUNNER_NOT_SET_UP, details: { code: "RUNNER_NOT_SET_UP", link: "#/settings#runner" } } });
        const offline = await person("Offline runner");
        personalRunner(platform, { ownerId: offline.id, label: "Sleeping desktop" });
        expect(await explore(offline)).toMatchObject({ status: 409, body: { error: RUNNER_OFFLINE, details: { code: "RUNNER_OFFLINE" } } });
        const old = await person("Old runner");
        await rawAgent(old.id, "Old laptop", false);
        expect(await explore(old)).toMatchObject({ status: 409, body: { error: exploreNeedsUpdate("Old laptop"), details: { code: "RUNNER_CANNOT_RUN" } } });
        // The page's readiness check says the same before anything is started.
        expect((await call("GET", "/api/me/runner", undefined, old.token)).body.runner.can.explore).toEqual({ ok: false, why: exploreNeedsUpdate("Old laptop") });
        expect((await call("GET", "/api/me/runner", undefined, offline.token)).body.runner.can.explore).toEqual({ ok: false, why: RUNNER_OFFLINE });
        // Still refused for now: a scheduled one and a phone app.
        const app = platform.repo.createApplication(old.project, SITE, {} as never, undefined);
        await expect(platform.repo.createJob(old.project, app, { targets: ["web"], trigger: "schedule" } as never)).rejects.toMatchObject({ status: 409, message: EXPLORING_ON_RUNNERS_MESSAGE });
        for (const p of [noRunner, offline, old]) expect(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM generation_jobs WHERE project_id = ?", p.project)!.n).toBe(0);
    });

    it("is never offered to a runner that stopped reporting the explore capability; the job ends telling the person to update", async () => {
        const p = await person("Downgraded");
        const a = await rawAgent(p.id, "Downgraded laptop");
        const started = await explore(p);
        expect(started.status, started.text).toBe(202);
        // The same computer now polls as an older runner program (it was replaced by one without `explore`).
        const older = { ...a, explore: false };
        for (let i = 0; i < 3; i++) expect(await pollOnce(older)).toBeUndefined();
        const job = await jobDone(started.body.jobId);
        expect(job.status).toBe("FAILED");
        expect(job.error).toContain(exploreNeedsUpdate("Downgraded laptop"));
    }, 60_000);

    it("fences the explore routes to the running attempt; a cancel stops the task", async () => {
        const p = await person("Fenced");
        const a = await rawAgent(p.id, "Fenced laptop");
        const started = await explore(p);
        const offer = await poll(a);
        const sink = (attempt: string | undefined, body: unknown = { calls: [{ method: "counters", patch: { pagesDiscovered: 1 } }] }) => agentApi(a.token, "POST", `/api/agent/tasks/${offer.taskId}/explore/sink`, body, attempt ? { "x-attempt-id": attempt } : {});
        expect((await agentApi(a.token, "POST", `/api/agent/tasks/${offer.taskId}/accept`, { attemptId: offer.attemptId })).status).toBe(200);
        expect((await sink(undefined)).status).toBe(409);
        const wrong = await sink("not-this-attempt-0001");
        expect(wrong.status).toBe(409);
        expect(wrong.body.details).toMatchObject({ code: "superseded" });
        expect((await sink(offer.attemptId)).status).toBe(200);
        const llm = await agentApi(a.token, "POST", `/api/agent/tasks/${offer.taskId}/explore/llm`, { options: { prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] } }, { "x-attempt-id": offer.attemptId });
        expect(llm.status).toBe(200);
        expect(JSON.stringify(llm.body)).not.toContain("scripted-provider");
        // The person stops it: the runner's next heartbeat says cancel, and nothing more is accepted from it.
        expect((await call("DELETE", `/api/test-generation/${started.body.jobId}`, undefined, p.token)).status).toBe(202);
        await until("the heartbeat to say cancel", async () => (await agentApi(a.token, "POST", `/api/agent/tasks/${offer.taskId}/heartbeat`, { attemptId: offer.attemptId, phase: "running" })).body?.cancel === true);
        expect((await sink(offer.attemptId)).status).toBe(409);
        const job = await jobDone(started.body.jobId);
        expect(job).toMatchObject({ status: "FAILED", error: "Cancelled" });
    }, 60_000);

    it("a runner that goes away fails the job plainly, and it is not offered to the runner again", async () => {
        const p = await person("Gone");
        const a = await rawAgent(p.id, "Gone laptop");
        const started = await explore(p);
        const offer = await poll(a);
        expect((await agentApi(a.token, "POST", `/api/agent/tasks/${offer.taskId}/accept`, { attemptId: offer.attemptId })).status).toBe(200);
        // The runner stops answering: its lease runs out (moved to the past here rather than waited for).
        platform.db.run("UPDATE agent_tasks SET lease_until = 1 WHERE id = ?", offer.taskId);
        const job = await jobDone(started.body.jobId);
        expect(job.status).toBe("FAILED");
        expect(job.error).toBe(EXPLORE_RUNNER_GONE);
        expect(await pollOnce(a)).toBeUndefined();
    }, 60_000);
});

describe("the real runner explores; the AI and what it saves stay on the platform", () => {
    function realAgent(token: string, name: string) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-explore-agent-"));
        work.push(dir);
        const { log, lines } = memoryLogger();
        const agent = new Agent({ config: { baseUrl: BASE, token, name, concurrency: 1, workDir: dir, allowInsecure: false, cacheBytes: 64 * 1024 * 1024, tokenSource: "env" }, log, heartbeatMs: 500, backoff: { baseMs: 100, maxMs: 500 }, liveBatch: { maxDelayMs: 200 }, outboxMaxDelayMs: 2000 });
        return { agent, lines, done: agent.run() };
    }

    it("Explore my app on the runner creates tests on the platform, and the server opened nothing; a cancel stops the child", async () => {
        const p = await person("Real explore");
        const { secret } = personalRunner(platform, { ownerId: p.id, label: "Real laptop" });
        const real = realAgent(secret, "Real laptop");
        const refusedBefore = serverRunRefusals();
        try {
            await until("the runner to connect", () => Boolean(svc().store.runnerOf(p.id)?.online && svc().store.runnerOf(p.id)?.agent?.capabilities.explore));
            const callsBefore = modelCalls;
            const started = await explore(p);
            expect(started.status, started.text).toBe(202);
            const job = await jobDone(started.body.jobId, 240_000);
            const events = platform.repo.listEvents(started.body.jobId);
            expect(job.status, JSON.stringify(events.filter((e) => e.level !== "info").map((e) => e.message))).toMatch(/COMPLETED/);
            // The tests are the platform's, made through the sink, and the authored one was validated on the runner.
            const tests = (await call("GET", `/api/projects/${p.project}/tests`, undefined, p.token)).body as Array<{ title: string; validationStatus: string }>;
            expect(tests.map((t) => t.title)).toContain("Browse the product list");
            expect(tests.find((t) => t.title === "Browse the product list")!.validationStatus).toBe("VALIDATED");
            // Every model call was answered here by the job's model; the engine's events are the job's own.
            expect(modelCalls).toBeGreaterThan(callsBefore);
            expect(kinds(started.body.jobId)).toEqual(expect.arrayContaining(["explore_on_runner"]));
            expect(job.ranOn ?? (await call("GET", `/api/test-generation/${started.body.jobId}`, undefined, p.token)).body.ranOn).toMatchObject({ kind: "agent", name: "Real laptop" });
            // Nothing secret in what the job stored.
            expect(JSON.stringify(events)).not.toContain(PASSWORD);
            // The server's guard refused nothing: no browser was opened and no script was run here.
            expect(serverRunRefusals()).toBe(refusedBefore);

            // A cancel during an exploration reaches the child: the model holds the first call, the person stops the job, the process is gone.
            let release!: () => void;
            hold = new Promise<void>((r) => (release = r));
            const second = await explore(p);
            expect(second.status, second.text).toBe(202);
            const held = modelCalls;
            await until("the child to ask the AI", () => modelCalls > held && real.agent.status().running.length > 0, 120_000);
            const pid = real.agent.status().running[0]!.pid!;
            expect((await call("DELETE", `/api/test-generation/${second.body.jobId}`, undefined, p.token)).status).toBe(202);
            const stopped = await jobDone(second.body.jobId);
            expect(stopped).toMatchObject({ status: "FAILED", error: "Cancelled" });
            await until("the child process to end", () => {
                try {
                    process.kill(pid, 0);
                    return false;
                } catch {
                    return true;
                }
            }, 20_000);
            hold = undefined;
            release();
            expect(serverRunRefusals()).toBe(refusedBefore);
        } finally {
            hold = undefined;
            real.agent.stop();
            await real.done;
        }
    }, 360_000);
});
