/**
 * Round 52: a graceful platform restart while an exploration runs on a runner does not end it (docs/features/explore-on-runner.md).
 *
 * A real platform on real HTTP in runners mode with its dispatch worker, and a hand-driven protocol-2 runner (plain HTTP) that saves through
 * explore/sink and asks explore/llm as the runner's child would. The platform is drained and its worker hands the job over, as a deploy
 * does; then a second platform opens the same data folder on the same port (one process playing both, as the hand-over tests do). The runner
 * sends its last batch again (its answer was lost), carries on with the next one, and posts its summary: the job ends COMPLETED from the
 * same task, with every test made once.
 *
 * Ports: platform 9110. No real model (a scripted double), no network beyond 127.0.0.1.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { llmClientFromModel } from "../src/engine/llm/provider.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { Db } from "../src/platform/db.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { RepoSink } from "../src/platform/repo-sink.js";
import { HANDED_OVER } from "../src/platform/runner-handover.js";
import { removeServerExecutionGuard } from "../src/platform/runner-only.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { personalRunner, testPerson } from "./helpers/personal-runner.js";

const PORT = 9110;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = "explore-restart-admin-key-7a31";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS", "AGENT_ACCEPT_SECONDS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const caps = { os: "linux", arch: "x64", node: "v24.0.0", browsers: ["chromium"], runnerSwitches: true, explore: true };

const model = new MockLanguageModelV3({
    provider: "scripted-provider",
    modelId: "scripted-model",
    doGenerate: async () => ({ content: [{ type: "text" as const, text: "ok" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage: { inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } }, warnings: [] }),
});

let dataDir: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>> | undefined;
let dispatch: Worker | undefined;

function config() {
    return loadConfig({ DATA_DIR: dataDir, API_KEY, EXECUTION_MODE: "runners", WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false", SECRET_KEY: "explore-restart-secret-0123456789", DISPATCH_CONCURRENCY: "4", LLM_PROVIDER: "anthropic" });
}
async function start(): Promise<void> {
    platform = bootstrap(config());
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    dispatch = Worker.dispatch({ ...platform, makeLlm: () => llmClientFromModel(model as unknown as LanguageModel, "scripted-model") }, 100);
    dispatch.start();
}
/** A deploy: nothing new to runners, the waiting job handed over, the server closed, the database closed. */
async function restartGracefully(): Promise<void> {
    getAgentServices(platform).drain();
    await dispatch!.stop({ handOver: true });
    server!.server.closeAllConnections();
    await server!.close();
    platform.db.close();
}

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
const until = async (what: string, check: () => boolean | Promise<boolean>, ms = 60_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await Promise.resolve().then(check).catch(() => false)) return;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
};
const kinds = (jobId: string) => platform.repo.listEvents(jobId).map((e) => String(e.kind));

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "60", AGENT_WATCH_MS: "50", AGENT_NO_AGENT_GRACE_SECONDS: "30", AGENT_ACCEPT_SECONDS: "20" });
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-explore-restart-"));
    await start();
}, 60_000);

afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    await Promise.race([dispatch?.stop(), new Promise((r) => setTimeout(r, 5_000))]);
    server?.server.closeAllConnections();
    await server?.close();
    platform?.db.close();
    removeServerExecutionGuard();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("a platform restart while a runner explores", () => {
    it("hands the exploration over; the next process takes it up from the same task and applies every save once", async () => {
        const who = testPerson(platform);
        const project = (await call("POST", "/api/projects", { name: "Restart shop" }, who.token)).body.id as string;
        const { secret } = personalRunner(platform, { ownerId: who.id, label: "Restart laptop" });
        const hello = await agentApi(secret, "POST", "/api/agent/hello", { protocol: 1, protocols: [1, 2], name: "Restart laptop", version: "52.0.0", concurrency: 1, capabilities: caps });
        expect(hello.body.protocol).toBe(2);
        const agentId = hello.body.agentId as string;
        const started = await call("POST", `/api/projects/${project}/test-generation`, { url: "http://127.0.0.1:9111", targets: ["web"], maxPages: 3, accessibility: false, healthChecks: false, securityChecks: false, inputChecks: false, contractChecks: false, accessChecks: false, useMemory: false }, who.token);
        expect(started.status, started.text).toBe(202);
        const jobId = started.body.jobId as string;
        let offer: any;
        await until("the offer", async () => {
            const r = await agentApi(secret, "POST", "/api/agent/poll", { agentId, freeSlots: 1, capabilities: caps });
            if (r.status === 200) offer = r.body;
            return !!offer;
        });
        const headers = { "x-attempt-id": offer.attemptId as string };
        expect((await agentApi(secret, "POST", `/api/agent/tasks/${offer.taskId}/accept`, { attemptId: offer.attemptId })).status).toBe(200);
        const sink = (body: unknown) => agentApi(secret, "POST", `/api/agent/tasks/${offer.taskId}/explore/sink`, body, headers);
        const llm = () => agentApi(secret, "POST", `/api/agent/tasks/${offer.taskId}/explore/llm`, { options: { prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }, purpose: "planning" }, headers);
        const spec = { testId: "WEB-001", title: "Home", kind: "web", category: "Smoke", priority: "high", steps: [{ action: "navigate", url: "/" }] };
        const batch1 = { seq: 1, calls: [{ method: "createTest", spec, framework: "playwright", validation: "PENDING" }] };
        const first = await sink(batch1);
        expect(first.status).toBe(200);
        const h = first.body.results[0];
        expect((await llm()).body.ok).toBe(true);
        await until("the job to say where it explores", () => kinds(jobId).includes("explore_on_runner"));

        await restartGracefully();
        // Handed over, not failed: the lease is released with the mark, the task still runs, nobody asked the runner to stop.
        const db = new Db(path.join(dataDir, "platform.db"));
        try {
            expect(db.get("SELECT lease_owner AS o FROM generation_jobs WHERE id = ?", jobId)).toEqual({ o: HANDED_OVER });
            expect(db.all("SELECT status, cancel_requested AS c FROM agent_tasks WHERE job_id = ?", jobId)).toEqual([{ status: "running", c: 0 }]);
            expect(JSON.parse(db.get<{ s: string }>("SELECT sink_json AS s FROM explore_task_state WHERE task_id = ?", offer.taskId)!.s).seq).toBe(1);
        } finally {
            db.close();
        }
        // While the platform is away the runner's call does not get through (it tries again: explore-transport.ts).
        await expect(fetch(`${BASE}/readyz`)).rejects.toThrow();

        await start();
        // The next process did not clear what the exploration had saved (Repo.reclaimStaleJobs keeps a handed-over exploration's tests).
        await until("the job to be taken up again", () => kinds(jobId).includes("explore_resumed"));
        expect(platform.repo.listTests(project)).toHaveLength(1);
        // The answer to batch 1 was lost: sent again, it is answered the same and makes nothing new.
        const again = await sink(batch1);
        expect(again.status, JSON.stringify([again.body, platform.db.all("SELECT status, phase, attempt_id, cancel_requested FROM agent_tasks WHERE job_id = ?", jobId), offer.attemptId, kinds(jobId)])).toBe(200);
        expect(again.body.results[0]).toEqual(h);
        const batch2 = await sink({ seq: 2, calls: [{ method: "updateTest", h, patch: { validation: "VALIDATED" } }, { method: "counters", patch: { pagesDiscovered: 2 } }] });
        expect(batch2.status, JSON.stringify(batch2.body)).toBe(200);
        expect((await llm()).body.ok).toBe(true);
        const result = await agentApi(secret, "POST", `/api/agent/tasks/${offer.taskId}/result`, { ok: true, attemptId: offer.attemptId, runs: [], explore: { testsGenerated: 1, testsValidated: 1, testsFailedValidation: 0, testsNeedingReview: 0, errors: [] } });
        expect(result.status).toBe(200);
        await until("the job to finish", () => ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(platform.repo.getJob(jobId)!.status));
        const job = platform.repo.getJob(jobId)!;
        expect(job.status, job.error ?? "").toBe("COMPLETED");
        expect(platform.db.all("SELECT id FROM agent_tasks WHERE job_id = ?", jobId)).toHaveLength(1);
        const tests = platform.repo.listTests(project);
        expect(tests).toHaveLength(1);
        expect(platform.repo.getTest(tests[0]!.id)!.validationStatus).toBe("VALIDATED");
        expect(kinds(jobId)).toContain("job_handed_over");
        // Both AI calls were metered for the job, with their purpose.
        expect(platform.db.get("SELECT SUM(calls) AS n FROM ai_usage WHERE job_id = ? AND purpose = 'planning'", jobId)).toEqual({ n: 2 });
        // The task's saved state is cleared once it ended.
        expect(platform.db.get("SELECT sink_json AS s, llm_json AS l FROM explore_task_state WHERE task_id = ?", offer.taskId)).toEqual({ s: null, l: null });
    }, 120_000);
});

describe("what a re-queued exploration keeps", () => {
    it("a handed-over one with its runner task keeps its tests; after a crash they are cleared as before", async () => {
        const p = bootstrap(loadConfig({ DATA_DIR: fs.mkdtempSync(path.join(dataDir, "requeue-")), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", SECRET_KEY: "explore-restart-secret-0123456789", LLM_PROVIDER: "anthropic" }));
        try {
            const svc = getAgentServices(p);
            const project = p.repo.createProject({ name: "Requeue" }).id as string;
            const app = p.repo.createApplication(project, "http://127.0.0.1:9111", { ...DEFAULT_JOB_OPTIONS }, undefined);
            let n = 0;
            const jobWithTest = async (owner: string) => {
                const job = await p.repo.createJob(project, app, { ...DEFAULT_JOB_OPTIONS });
                const spec = { testId: `WEB-00${++n}`, title: "Home", kind: "web", category: "Smoke", priority: "high", steps: [{ action: "navigate", url: "/" }] };
                await new RepoSink(p.repo, p.store, { id: job.id, projectId: project, applicationId: app }).createTest({ spec: TestSpecSchema.parse(spec), framework: "playwright", validation: "PENDING" });
                svc.store.enqueue({ id: `task-${job.id}`, projectId: project, jobId: job.id, adapterId: "explore", payloadEnc: svc.encrypt({}), files: [], ownerId: null });
                p.db.run("UPDATE generation_jobs SET status = 'VALIDATING', lease_owner = ?, lease_until = ? WHERE id = ?", owner, Date.now() - 1, job.id);
                return job.id;
            };
            const handed = await jobWithTest(HANDED_OVER);
            const crashed = await jobWithTest("a-worker-that-died");
            p.repo.reclaimStaleJobs();
            const testsOf = (jobId: string) => p.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM test_cases WHERE job_id = ?", jobId)!.n;
            expect(testsOf(handed)).toBe(1);
            expect(testsOf(crashed)).toBe(0);
        } finally {
            p.db.close();
        }
    });
});
