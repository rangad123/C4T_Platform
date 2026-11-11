/**
 * The REAL runner agent against the real platform, watched through the live stream: its progress lines (what it is doing, each test as it
 * finishes) become job events as the heartbeat arrives, named after the agent, long before the run is over, with no credential in them.
 *
 * Browser-free (API tests). Ports: platform 5978, fixture application 5979.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { memoryLogger } from "../src/agent/log.js";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { personalRunner } from "./helpers/personal-runner.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { SseClient } from "./fixtures/sse-client.js";

const PORT = 5978;
const APP_PORT = 5979;
const APP = `http://127.0.0.1:${APP_PORT}`;
const API_KEY = "al-agent-admin-key-61d2";
const PASSWORD = "ALAGENT-Password-0c9e41";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS", "BLOCK_PRIVATE_TARGETS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dataDir: string;
let agentWork: string;
let appServer: http.Server;
let agent: Agent;
let agentDone: Promise<number>;

const admin = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, headers: { "x-api-key": API_KEY, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; text: string; body: any };
};

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "30", AGENT_WATCH_MS: "100", AGENT_NO_AGENT_GRACE_SECONDS: "5" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    appServer = http.createServer((req, res) => {
        // slow enough that the three tests finish one after another, not all at once
        setTimeout(() => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
        }, 400);
        void req;
    });
    await new Promise<void>((r) => appServer.listen(APP_PORT, "127.0.0.1", () => r()));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-streamagent-"));
    agentWork = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-streamagent-work-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PORT), CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 100);
    worker.start();
}, 60_000);

afterAll(async () => {
    agent?.stop();
    await agentDone;
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    await worker?.stop();
    // The agent's last long-poll may still be held by the platform for a moment; do not wait for it.
    server?.server.closeAllConnections();
    await server?.close();
    platform?.db.close();
    await new Promise((r) => appServer.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(agentWork, { recursive: true, force: true });
});

describe("a real agent run, watched live", () => {
    it("shows what the agent is doing as it happens, test by test, long before the heartbeat interval", async () => {
        const projectId = (await admin("POST", "/api/projects", { name: "Live agent" })).body.id as string;
        const made = { status: 201, body: { secret: personalRunner(platform, { label: "live", replace: true }).secret } };
        const { log } = memoryLogger();
        // A 6 s heartbeat: without early beats, nothing but the first (empty) beat would reach the platform before the run is over.
        agent = new Agent({
            config: { baseUrl: `http://127.0.0.1:${PORT}`, token: made.body.secret, name: "Maya's laptop", concurrency: 1, workDir: agentWork, allowInsecure: false, cacheBytes: 64 * 1024 * 1024, tokenSource: "env" },
            log,
            heartbeatMs: 6000,
            backoff: { baseMs: 100, maxMs: 500 },
        });
        agentDone = agent.run();
        for (let i = 0; i < 100; i++) {
            const list = (await admin("GET", `/api/projects/${projectId}/agents`)).body as Array<{ online: boolean }>;
            if (list.some((a) => a.online)) break;
            await new Promise((r) => setTimeout(r, 200));
        }
        const imp = await admin("POST", `/api/projects/${projectId}/specs`, {
            baseUrl: APP,
            validate: false,
            credentials: { username: "demo@example.com", password: PASSWORD },
            specs: ["One", "Two", "Three"].map((n) => ({ title: `Check ${n}`, kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: `/${n.toLowerCase()}` }, { action: "assertResponse", check: "status", expected: 200 }] })),
        });
        expect(imp.status, imp.text).toBe(202);
        const testIds = (imp.body.tests as Array<{ id: string }>).map((t) => t.id);
        expect((await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent" })).status).toBe(200);

        const appId = platform.repo.createApplication(projectId, APP, { ...DEFAULT_JOB_OPTIONS }, undefined);
        // Round 45: the open server's run (this platform has no API_KEY and no accounts), so its runner takes it.
        const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds, startedBy: { kind: "open", id: null } });
        const ticket = (await admin("POST", "/api/stream-tickets", { path: `/api/test-generation/${job.id}/stream` })).body.ticket as string;
        const c = await SseClient.open(PORT, `/api/test-generation/${job.id}/stream?ticket=${ticket}`);
        await c.untilClosed(120_000);

        const logs = c.logs();
        // A protocol-2 agent sends its lines as live events (runner_log); a protocol-1 agent with its heartbeats (agent_progress). Same sentence either way.
        const progress = logs.filter((l) => l.kind === "agent_progress" || l.kind === "runner_log");
        const messages = progress.map((l) => l.message);
        // plain sentences, named after the agent
        expect(messages.every((m) => m.startsWith("Maya's laptop: "))).toBe(true);
        expect(messages).toContain("Maya's laptop: Running 3 scripts");
        const finished = messages.filter((m) => /Finished \d of 3 tests/.test(m));
        expect(finished.map((m) => /Finished (\d) of 3/.exec(m)![1])).toEqual(["1", "2", "3"]);
        expect(finished[0]).toMatch(/Check (One|Two|Three) \(passed\)$/);
        // promptly: the first line reached the viewer within a few seconds of the agent starting, far before the 6 s heartbeat
        const started = c.frames.find((f) => f.event === "log" && f.data.kind === "agent_task_started")!;
        const firstLine = c.frames.find((f) => f.event === "log" && (f.data.kind === "agent_progress" || f.data.kind === "runner_log"))!;
        expect(firstLine.at - started.at).toBeLessThan(4000);
        // and they came in the order they happened, before the job ended
        const order = c.frames.map((f) => (f.event === "log" ? f.data.message : f.event));
        expect(order.findIndex((m) => String(m).includes("Finished 3 of 3"))).toBeLessThan(order.indexOf("end"));
        expect(c.frames.at(-1)!.event).toBe("end");
        expect(c.logIds()).toEqual((platform.repo.listEvents(job.id, 0, 100_000) as Array<{ id: number }>).map((r) => r.id));
        expect(c.text).not.toContain(PASSWORD);
        expect(c.text).not.toContain(API_KEY);
        expect(c.text).not.toContain(made.body.secret);
    }, 180_000);
});
