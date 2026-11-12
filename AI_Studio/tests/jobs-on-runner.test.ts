/**
 * Round 52: the rest of AI Studio's job kinds run on the person's runner in runners mode (docs/features/explore-on-runner.md): an exploration a
 * schedule or a deploy trigger starts (on its creator's runner), a test described in words (mode "plain") and an AI agent run (mode "agent"),
 * all as the round-51 explore task, with the AI and the saving on the platform.
 *
 * A real platform on real HTTP in runners mode with its dispatch worker. Hand-driven protocol-2 agents prove the dispatch rules: a schedule's and
 * a trigger's exploration go to the creator's runner, never another person's, and wait while it is offline; an older runner is never offered
 * the new modes; an agent run's approvals are the platform's to decide. Then the REAL agent from source builds a described test (and rebuilds it)
 * and does an agent run against a small local site, every model call answered on the platform by a scripted model double, and the server's
 * guard refused nothing (no browser opened, no script run here).
 *
 * Browser-launching: node scripts/with-lock.mjs browser -- npx vitest run tests/jobs-on-runner.test.ts
 * Ports: platform 9100, sample site 9101. No real model, no network beyond 127.0.0.1.
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
import { getAgentServices } from "../src/platform/agent-services.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { modeNeedsUpdate } from "../src/platform/explore-task.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { removeServerExecutionGuard, serverRunRefusals } from "../src/platform/runner-only.js";
import { getScheduleServices } from "../src/platform/schedule-services.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { personalRunner, testPerson } from "./helpers/personal-runner.js";

const PORT = 9100;
const SITE_PORT = 9101;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const API_KEY = "jobs-runner-admin-key-7c21";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS", "AGENT_ACCEPT_SECONDS", "BLOCK_PRIVATE_TARGETS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const caps = (modes = true) => ({ os: "linux", arch: "x64", node: "v24.0.0", browsers: ["chromium"], runnerSwitches: true, explore: true, ...(modes ? { exploreModes: ["plain", "agent"] } : {}) });

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dispatch: Worker;
let dataDir: string;
let site: http.Server;
const work: string[] = [];

// ── the scripted model on the platform ───────────────────────────────────────
const usage = { inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
/** Tool calls the next AI agent makes (the authoring agent of a described test, or an agent run), in order. */
const toolQueue: Array<{ tool: string; input: Record<string, unknown> }> = [];
let modelCalls = 0;
const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] });
const model = new MockLanguageModelV3({
    provider: "scripted-provider",
    modelId: "scripted-model",
    doGenerate: async (o) => {
        modelCalls++;
        if (o.tools?.length) {
            const names = o.tools.map((t) => t.name);
            // The objective agent finishes with passed, the authoring agent with complete.
            const next = toolQueue.shift() ?? { tool: "finish", input: names.includes("seeWholePage") || !names.includes("click") ? { result: "complete", explanation: "checked" } : { result: "passed", explanation: "checked" } };
            return { content: [{ type: "tool-call" as const, toolCallId: `c${modelCalls}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
        }
        return json({});
    },
});
const heading = (value: string) => ({ tool: "assert", input: { check: "visible", target: { by: "role", role: "heading", value } } });

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
const SETTINGS = { targets: ["web"], maxPages: 2, accessibility: false, healthChecks: false, securityChecks: false, inputChecks: false, contractChecks: false, accessChecks: false, useMemory: false };

/** A person with their own API token and a project they own, with the sample site as its application. */
async function person(name: string) {
    const who = testPerson(platform);
    const project = (await call("POST", "/api/projects", { name }, who.token)).body.id as string;
    const appId = platform.repo.createApplication(project, SITE, { ...SETTINGS } as never, undefined) as string;
    return { ...who, project, appId };
}
type Raw = { token: string; agentId: string; modes: boolean };
/** A hand-driven protocol-2 agent saying hello for this runner token. */
async function hello(token: string, name: string, modes = true): Promise<Raw> {
    const r = await agentApi(token, "POST", "/api/agent/hello", { protocol: 1, protocols: [1, 2], name, version: "52.0.0", concurrency: 1, capabilities: caps(modes) });
    expect(r.status).toBe(200);
    return { token, agentId: r.body.agentId as string, modes };
}
const pollOnce = async (a: Raw) => {
    const r = await agentApi(a.token, "POST", "/api/agent/poll", { agentId: a.agentId, freeSlots: 1, capabilities: caps(a.modes) });
    return r.status === 200 ? r.body : undefined;
};
const poll = async (a: Raw) => {
    for (let i = 0; i < 30; i++) {
        const offer = await pollOnce(a);
        if (offer) return offer;
    }
    throw new Error("no offer");
};
const stop = async (jobId: string) => {
    platform.repo.requestCancel(jobId);
    return jobDone(jobId);
};

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
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-jobs-runner-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY, EXECUTION_MODE: "runners", WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false", SECRET_KEY: "jobs-on-runner-secret-0123456789ab", DISPATCH_CONCURRENCY: "4", MAX_REPAIR_ATTEMPTS: "0", LLM_PROVIDER: "anthropic" }));
    // The platform's own model: what the AI gates of the start routes ask about (the jobs' model is the dispatch worker's, below).
    platform.llm = llmClientFromModel(model as unknown as LanguageModel, "scripted-model");
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

describe("an exploration a schedule or a deploy trigger starts goes to its creator's runner", () => {
    it("a schedule's: waits while the creator's runner is offline, is never offered to another person's, then goes to the creator's", async () => {
        const maya = await person("Maya's nightly shop");
        const omar = await person("Omar's shop");
        const theirs = await hello(personalRunner(platform, { ownerId: omar.id, label: "Omar laptop" }).secret, "Omar laptop");
        // Maya's runner is set up but not running.
        const mine = personalRunner(platform, { ownerId: maya.id, label: "Maya laptop" });
        const made = await call("POST", `/api/projects/${maya.project}/schedules`, { kind: "generate", cadence: { type: "daily", time: "03:00" } }, maya.token);
        expect(made.status, made.text).toBe(201);
        platform.db.run("UPDATE schedules SET next_run_at = ? WHERE id = ?", Date.now() - 1000, made.body.id);
        const fired = (await getScheduleServices(platform).scheduler.tick()).find((x) => x.scheduleId === made.body.id)!;
        expect(fired.result, JSON.stringify(fired)).toBe("started");
        const job = platform.repo.getJob(fired.jobId!)!;
        expect(job.options).toMatchObject({ mode: "generate", trigger: "schedule", startedBy: { kind: "schedule", ownerId: maya.id }, runOn: "agent" });
        // It waits, holding no dispatch place, and Omar's runner never sees it.
        for (let i = 0; i < 3; i++) expect(await pollOnce(theirs)).toBeUndefined();
        expect(svc().jobsWaitingForRunner()).toContain(job.id);
        expect(platform.repo.getJob(job.id)!.status).toBe("QUEUED");
        // Maya's computer comes on: the exploration is handed to it.
        const a = await hello(mine.secret, "Maya laptop");
        const offer = await poll(a);
        expect(offer).toMatchObject({ kind: "explore", jobId: job.id, adapterId: "explore", env: { baseUrl: SITE } });
        expect(offer.explore.mode ?? "generate").toBe("generate");
        expect(await pollOnce(theirs)).toBeUndefined();
        expect((await stop(job.id)).status).toBe("FAILED");
    }, 90_000);

    it("a deploy trigger's: the same, on the trigger's creator's runner", async () => {
        const lena = await person("Lena's shop");
        const other = await person("Other shop");
        const theirs = await hello(personalRunner(platform, { ownerId: other.id, label: "Other laptop" }).secret, "Other laptop");
        const mine = personalRunner(platform, { ownerId: lena.id, label: "Lena laptop" });
        // A deploy trigger's exploration (a runbook's explore step a pipeline starts): made outside any person's request.
        const job = await platform.repo.createJob(lena.project, lena.appId, { ...DEFAULT_JOB_OPTIONS, ...SETTINGS, mode: "generate", trigger: "deploy", startedBy: { kind: "trigger", id: "trigger-token-1", ownerId: lena.id } } as never);
        expect(job.options.runOn).toBe("agent");
        for (let i = 0; i < 3; i++) expect(await pollOnce(theirs)).toBeUndefined();
        expect(svc().jobsWaitingForRunner()).toContain(job.id);
        const a = await hello(mine.secret, "Lena laptop");
        const offer = await poll(a);
        expect(offer).toMatchObject({ kind: "explore", jobId: job.id });
        expect((await stop(job.id)).status).toBe("FAILED");
    }, 90_000);
});

describe("a described test and an agent run on a runner: the rules", () => {
    it("an older runner is refused at the start with the update sentence, and is never offered a queued one", async () => {
        const p = await person("Old runner");
        const old = await hello(personalRunner(platform, { ownerId: p.id, label: "Old laptop" }).secret, "Old laptop", false);
        const plain = await call("POST", `/api/projects/${p.project}/plain-tests`, { description: "Open the home page and check that Sample shop is shown" }, p.token);
        expect(plain).toMatchObject({ status: 409, body: { error: modeNeedsUpdate("Old laptop", "plain"), details: { code: "RUNNER_CANNOT_RUN", link: "#/settings#runner" } } });
        const agent = await call("POST", `/api/projects/${p.project}/agent-runs`, { objective: "Open the shop and check its heading" }, p.token);
        expect(agent).toMatchObject({ status: 409, body: { error: modeNeedsUpdate("Old laptop", "agent"), details: { code: "RUNNER_CANNOT_RUN" } } });
        expect((await call("GET", "/api/me/runner", undefined, p.token)).body.runner.can).toMatchObject({ explore: { ok: true }, plain: { ok: false }, agent: { ok: false } });
        // A runner that could when the job was made and polls as an older program now: never offered it; the job says to update.
        const now = await hello(personalRunner(platform, { ownerId: p.id, label: "Old laptop" }).secret, "Old laptop");
        const started = await call("POST", `/api/projects/${p.project}/plain-tests`, { description: "Open the home page and check that Sample shop is shown" }, p.token);
        expect(started.status, started.text).toBe(202);
        for (let i = 0; i < 3; i++) expect(await pollOnce({ ...now, modes: false })).toBeUndefined();
        const job = await jobDone(started.body.jobId);
        expect(job.status).toBe("FAILED");
        expect(job.error).toContain(modeNeedsUpdate("Old laptop", "plain"));
        expect(old.agentId).toEqual(expect.any(String));
    }, 90_000);

    it("an agent run's records go to the job's own run; its approvals are the platform's to decide", async () => {
        const p = await person("Agent rules");
        const a = await hello(personalRunner(platform, { ownerId: p.id, label: "Agent laptop" }).secret, "Agent laptop");
        const started = await call("POST", `/api/projects/${p.project}/agent-runs`, { objective: "Open the shop and check its heading", limits: { approvalSeconds: 60 } }, p.token);
        expect(started.status, started.text).toBe(202);
        const offer = await poll(a);
        expect(offer).toMatchObject({ kind: "explore", jobId: started.body.jobId, explore: { mode: "agent", request: { url: SITE, objective: "Open the shop and check its heading" } } });
        expect((await agentApi(a.token, "POST", `/api/agent/tasks/${offer.taskId}/accept`, { attemptId: offer.attemptId })).status).toBe(200);
        const sink = async (calls: unknown[]) => agentApi(a.token, "POST", `/api/agent/tasks/${offer.taskId}/explore/sink`, { calls }, { "x-attempt-id": offer.attemptId });
        const step = await sink([{ method: "agentStep", s: { seq: 1, tool: "navigate", summary: "Open the shop", status: "done", url: `${SITE}/`, step: { action: "navigate", url: `${SITE}/`, description: "Open the shop" }, picture: { name: "x.jpg", data: Buffer.from("jpeg-bytes").toString("base64") } } }]);
        expect(step.status, JSON.stringify(step.body)).toBe(200);
        const asked = await sink([{ method: "agentApproval", r: { action: "Submit the order", kind: "submit", why: "It submits a form", url: `${SITE}/`, seconds: 60 } }]);
        const approvalId = asked.body.results[0] as string;
        expect((await sink([{ method: "approvalState", id: approvalId }])).body.results).toEqual(["pending"]);
        // An approval of another run is not answered.
        expect((await sink([{ method: "approvalState", id: "not-an-approval-of-this-run" }])).status).toBe(400);
        const detail = await call("GET", `/api/projects/${p.project}/agent-runs/${started.body.id}`, undefined, p.token);
        expect(detail.body.steps).toMatchObject([{ seq: 1, tool: "navigate", status: "done", screenshotId: expect.any(String) }]);
        expect(detail.body.state).toBe("waiting_approval");
        expect((await call("POST", `/api/projects/${p.project}/agent-runs/${started.body.id}/approvals/${approvalId}`, { approve: true }, p.token)).status).toBe(200);
        expect((await sink([{ method: "approvalState", id: approvalId }])).body.results).toEqual(["approved"]);
        // The end: what the runner sends is what the run says.
        await sink([{ method: "agentOutcome", o: { state: "finished", verdict: "passed", reasoning: "The heading is shown.", inputTokens: 7, outputTokens: 5 } }]);
        const result = await agentApi(a.token, "POST", `/api/agent/tasks/${offer.taskId}/result`, { ok: true, runs: [], attemptId: offer.attemptId, explore: { testsGenerated: 0, testsValidated: 0, testsFailedValidation: 0, testsNeedingReview: 0, errors: [] } });
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        const job = await jobDone(started.body.jobId);
        expect(job.status, job.error).toBe("COMPLETED");
        const end = (await call("GET", `/api/projects/${p.project}/agent-runs/${started.body.id}`, undefined, p.token)).body;
        expect(end).toMatchObject({ state: "finished", verdict: "passed", inputTokens: 7, outputTokens: 5 });
        expect((await call("GET", `/api/test-generation/${started.body.jobId}`, undefined, p.token)).body.ranOn).toMatchObject({ kind: "agent", name: "Agent laptop" });
    }, 90_000);
});

describe("the real runner builds a described test and does an agent run; the AI and what they save stay on the platform", () => {
    function realAgent(token: string, name: string) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-jobs-agent-"));
        work.push(dir);
        const { log, lines } = memoryLogger();
        const agent = new Agent({ config: { baseUrl: BASE, token, name, concurrency: 1, workDir: dir, allowInsecure: false, cacheBytes: 64 * 1024 * 1024, tokenSource: "env" }, log, heartbeatMs: 500, backoff: { baseMs: 100, maxMs: 500 }, liveBatch: { maxDelayMs: 200 }, outboxMaxDelayMs: 2000 });
        return { agent, lines, done: agent.run() };
    }

    it("Describe it makes a validated test on the platform (and rebuilds it as the same test); an agent run passes; the server opened nothing", async () => {
        const p = await person("Real runner work");
        const { secret } = personalRunner(platform, { ownerId: p.id, label: "Real laptop" });
        const real = realAgent(secret, "Real laptop");
        const refusedBefore = serverRunRefusals();
        try {
            await until("the runner to connect", () => Boolean(svc().store.runnerOf(p.id)?.online && svc().store.runnerOf(p.id)?.agent?.capabilities.exploreModes?.includes("plain")));
            // (c) A test described in words: built in the runner's browser, saved and validated on the platform.
            toolQueue.length = 0;
            toolQueue.push(heading("Sample shop"), { tool: "finish", input: { result: "complete", explanation: "checked" } });
            const callsBefore = modelCalls;
            const plain = await call("POST", `/api/projects/${p.project}/plain-tests`, { description: "Open the home page and check that Sample shop is shown" }, p.token);
            expect(plain.status, plain.text).toBe(202);
            const built = await jobDone(plain.body.jobId, 240_000);
            const events = platform.repo.listEvents(plain.body.jobId);
            expect(built.status, JSON.stringify(events.filter((e) => e.level !== "info").map((e) => e.message))).toBe("COMPLETED");
            expect(events.find((e) => e.kind === "explore_on_runner")?.message).toBe("Building the test on your runner “Real laptop”.");
            const tests = (await call("GET", `/api/projects/${p.project}/tests`, undefined, p.token)).body as Array<{ id: string; validationStatus: string }>;
            expect(tests).toHaveLength(1);
            expect(tests[0]!.validationStatus).toBe("VALIDATED");
            expect(modelCalls).toBeGreaterThan(callsBefore);
            expect((await call("GET", `/api/test-generation/${plain.body.jobId}`, undefined, p.token)).body.ranOn).toMatchObject({ kind: "agent", name: "Real laptop" });

            // Rebuilt from a changed description: the same test, through a handle of the task (never its id).
            toolQueue.push(heading("Sample shop"), { tool: "finish", input: { result: "complete", explanation: "checked again" } });
            const again = await call("POST", `/api/tests/${tests[0]!.id}/plain-rewrite`, { description: "Open the home page and check that the Sample shop heading is shown" }, p.token);
            expect(again.status, again.text).toBe(202);
            const rebuilt = await jobDone(again.body.jobId, 240_000);
            expect(rebuilt.status, JSON.stringify(platform.repo.listEvents(again.body.jobId).filter((e) => e.level !== "info").map((e) => e.message))).toBe("COMPLETED");
            const after = (await call("GET", `/api/projects/${p.project}/tests`, undefined, p.token)).body as Array<{ id: string }>;
            expect(after.map((t) => t.id)).toEqual([tests[0]!.id]);

            // (d) An agent run: the objective pursued in the runner's browser; its steps and verdict are the platform's run.
            toolQueue.push(heading("Sample shop"), { tool: "finish", input: { result: "passed", explanation: "The heading is shown." } });
            const run = await call("POST", `/api/projects/${p.project}/agent-runs`, { objective: "Open the shop and check that its heading is shown" }, p.token);
            expect(run.status, run.text).toBe(202);
            const ran = await jobDone(run.body.jobId, 240_000);
            expect(ran.status, JSON.stringify(platform.repo.listEvents(run.body.jobId).filter((e) => e.level !== "info").map((e) => e.message))).toBe("COMPLETED");
            const detail = (await call("GET", `/api/projects/${p.project}/agent-runs/${run.body.id}`, undefined, p.token)).body;
            expect(detail).toMatchObject({ state: "finished", verdict: "passed" });
            expect(detail.steps.map((s: { tool: string }) => s.tool)).toEqual(expect.arrayContaining(["navigate", "assert"]));
            // (f) The server's guard refused nothing: no browser was opened and no script was run here.
            expect(serverRunRefusals()).toBe(refusedBefore);
        } finally {
            real.agent.stop();
            await real.done;
        }
    }, 600_000);
});
