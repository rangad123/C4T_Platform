/**
 * Protocol 2 against the REAL platform: the real agent program (src/agent) runs real Playwright, and hand-driven agents (plain HTTP)
 * exercise the rules no real agent would break on purpose: accept, reject and re-offer, the accept time-out, fencing (a late message from
 * an older attempt), duplicate live events, a result posted twice, and a heartbeat line carrying a password.
 *
 * Browser-launching: node scripts/with-lock.mjs browser -- npx vitest run tests/runner-protocol2.test.ts
 * Ports: platform 8040, fixture application 8041.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { memoryLogger } from "../src/agent/log.js";
import { requestStop } from "../src/agent/stop-file.js";
import { loadConfig } from "../src/config.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { OPEN_OWNER_ID } from "../src/platform/agent-store.js";
import { personalRunner } from "./helpers/personal-runner.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { SseClient } from "./fixtures/sse-client.js";

const PORT = 8040;
const APP_PORT = 8041;
const BASE = `http://127.0.0.1:${PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;
const API_KEY = "p2-admin-key-7d1e40";
const PASSWORD = "P2-Pass word/9&x";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS", "AGENT_ACCEPT_SECONDS", "BLOCK_PRIVATE_TARGETS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const caps = { os: "linux", arch: "x64", node: "v24.0.0", browsers: ["chromium"] };

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dataDir: string;
let appServer: http.Server;
const work: string[] = [];

const admin = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { "x-api-key": API_KEY, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; text: string; body: any };
};
const agentApi = async (token: string, method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
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
const jobDone = async (jobId: string, ms = 240_000) => {
    let j: any;
    await until("the job to finish", async () => ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes((j = (await admin("GET", `/api/test-generation/${jobId}`)).body).status), ms);
    return j;
};
const events = (jobId: string) => platform.db.all<{ id: number; kind: string; message: string; data_json: string | null }>("SELECT id, kind, message, data_json FROM agent_events WHERE job_id = ? ORDER BY id", jobId);

/** A project with one passing and one failing web test, set to run on runners. Runners are made per project so tests do not share them. */
async function project(name: string): Promise<{ id: string; pass: string; fail: string }> {
    const id = (await admin("POST", "/api/projects", { name })).body.id as string;
    const imp = await admin("POST", `/api/projects/${id}/specs`, {
        baseUrl: APP,
        validate: false,
        credentials: { username: "demo@example.com", password: PASSWORD },
        specs: [
            { title: "The home page greets people", kind: "web", category: "Web", steps: [{ action: "navigate", url: `${APP}/` }, { action: "assert", check: "visible", locator: { by: "text", value: "Welcome to the fixture" } }] },
            { title: "A missing heading is reported", kind: "web", category: "Web", steps: [{ action: "navigate", url: `${APP}/` }, { action: "assert", check: "visible", locator: { by: "text", value: "Nothing like this" } }] },
        ],
    });
    expect(imp.status, imp.text).toBe(202);
    svc().store.setRunner(id, { runOn: "agent" });
    return { id, pass: imp.body.tests[0].id, fail: imp.body.tests[1].id };
}

/** A hand-driven agent: a token of the project, a hello offering protocols 1 and 2 (or only 1). */
async function rawAgent(projectId: string, name: string, protocols: number[] = [1, 2]) {
    const { secret } = personalRunner(platform, { label: name, replace: true });
    const hello = await agentApi(secret, "POST", "/api/agent/hello", { protocol: 1, ...(protocols.length > 1 ? { protocols } : {}), name, version: "1.0.0", concurrency: 1, capabilities: caps });
    expect(hello.status).toBe(200);
    return { token: secret, agentId: hello.body.agentId as string, protocol: hello.body.protocol as number };
}
const poll = async (a: { token: string; agentId: string }) => {
    for (let i = 0; i < 40; i++) {
        const r = await agentApi(a.token, "POST", "/api/agent/poll", { agentId: a.agentId, freeSlots: 1, capabilities: caps });
        if (r.status === 200) return r.body;
    }
    throw new Error("no offer");
};

function realAgent(token: string, name: string, extra: Partial<ConstructorParameters<typeof Agent>[0]> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-p2-agent-"));
    work.push(dir);
    const { log, lines } = memoryLogger();
    const agent = new Agent({
        config: { baseUrl: BASE, token, name, concurrency: 1, workDir: dir, allowInsecure: false, cacheBytes: 64 * 1024 * 1024, tokenSource: "env" },
        log,
        heartbeatMs: 500,
        backoff: { baseMs: 100, maxMs: 500 },
        liveBatch: { maxDelayMs: 200 },
        outboxMaxDelayMs: 2000,
        ...extra,
    });
    return { agent, lines, dir, done: agent.run() };
}

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "60", AGENT_WATCH_MS: "100", AGENT_NO_AGENT_GRACE_SECONDS: "20", AGENT_ACCEPT_SECONDS: "2" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    appServer = http.createServer((req, res) => {
        if (req.url === "/slow") return void setTimeout(() => res.writeHead(200, { "content-type": "text/html" }).end("<h1>Slow</h1>"), 15_000).unref();
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><html lang="en"><head><title>Fixture</title></head><body><main><h1>Welcome to the fixture</h1></main></body></html>`);
    });
    await new Promise<void>((r) => appServer.listen(APP_PORT, "127.0.0.1", () => r()));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-p2-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PORT), CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 150);
    worker.start();
}, 60_000);

afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    await worker?.stop();
    server?.server.closeAllConnections();
    await server?.close();
    platform?.db.close();
    await new Promise((r) => appServer.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
    for (const d of work) fs.rmSync(d, { recursive: true, force: true });
});

describe("protocol 2 with the real agent", () => {
    it("live steps and the failure screenshot arrive before the result, and a reconnect with Last-Event-ID replays them", async () => {
        const p = await project("Live events");
        const { secret } = personalRunner(platform, { label: "Live laptop", replace: true });
        const a = realAgent(secret, "Live laptop");
        try {
            await until("the agent to say hello", () => Boolean(svc().store.runnerOf(OPEN_OWNER_ID)?.online));
            const started = await admin("POST", `/api/tests/${p.fail}/validate`);
            expect(started.status, started.text).toBe(202);
            const jobId = started.body.jobId as string;
            const job = await jobDone(jobId);
            expect(job.ranOn).toMatchObject({ kind: "agent", name: "Live laptop", phase: "completed", attempt: 1 });
            const ev = events(jobId);
            const kinds = ev.map((e) => e.kind);
            expect(kinds).toEqual(expect.arrayContaining(["runner_phase", "runner_test_started", "runner_step", "runner_test_finished", "runner_screenshot", "runner_log"]));
            const steps = ev.filter((e) => e.kind === "runner_step").map((e) => JSON.parse(e.data_json!));
            expect(steps).toEqual(expect.arrayContaining([expect.objectContaining({ state: "started", index: 0 }), expect.objectContaining({ state: "finished", status: "failed" })]));
            // before the result: every live test event was stored before the platform recorded the run as completed
            const completed = ev.find((e) => e.kind === "runner_phase" && JSON.parse(e.data_json!).phase === "completed")!;
            expect(ev.filter((e) => e.kind.startsWith("runner_test") || e.kind === "runner_screenshot").every((e) => e.id < completed.id)).toBe(true);
            // the live picture is served to a person of the project, and it is a PNG
            const shot = JSON.parse(ev.find((e) => e.kind === "runner_screenshot")!.data_json!) as { ref: string; taskId: string };
            const img = await fetch(`${BASE}/api/projects/${p.id}/runs/${jobId}/runner-files/${shot.taskId}/${shot.ref}`, { headers: { "x-api-key": API_KEY } });
            expect(img.status).toBe(200);
            expect(Buffer.from(await img.arrayBuffer()).subarray(1, 4).toString()).toBe("PNG");
            expect((await fetch(`${BASE}/api/projects/${p.id}/runs/${jobId}/runner-files/${shot.taskId}/..%2Fx.png`, { headers: { "x-api-key": API_KEY } })).status).toBe(404);
            // nothing secret in what was stored
            expect(JSON.stringify(ev)).not.toContain(PASSWORD);
            // a reconnect after an early event replays the rest, with the structured part
            const ticket = async () => (await admin("POST", "/api/stream-tickets", { path: `/api/test-generation/${jobId}/stream` })).body.ticket as string;
            const firstLive = ev.find((e) => e.kind === "runner_test_started")!;
            const c = await SseClient.open(PORT, `/api/test-generation/${jobId}/stream?ticket=${await ticket()}`, { "last-event-id": String(firstLive.id) });
            await c.untilClosed(20_000);
            const replayed = c.logs() as Array<{ id: number; kind: string; data?: any }>;
            expect(replayed[0]!.id).toBeGreaterThan(firstLive.id);
            // testId is the script's test id, the same one the result's runs carry
            const stepData = replayed.find((e) => e.kind === "runner_step")?.data;
            expect(stepData).toMatchObject({ testId: steps[0]!.testId, taskId: shot.taskId, attempt: 1 });
            expect(replayed.find((e) => e.kind === "runner_screenshot")?.data).toMatchObject({ ref: shot.ref });
            expect(replayed.filter((e) => e.kind === "agent_task_queued")).toEqual([]); // older than the resume point: not sent again
        } finally {
            a.agent.stop();
            await a.done;
        }
    }, 300_000);

    it("a result the platform could not take for more than 30 s is kept on disk and delivered once", async () => {
        const p = await project("Durable result");
        const { secret } = personalRunner(platform, { label: "spool", replace: true });
        let blockedUntil = 0;
        let resultOk = 0;
        const fetchImpl: typeof fetch = async (input, init) => {
            const url = String(input);
            if (Date.now() < blockedUntil) throw new TypeError("fetch failed");
            if (url.endsWith("/result") && blockedUntil === 0) {
                blockedUntil = Date.now() + 35_000; // the platform is away from the first result on, for 35 s
                throw new TypeError("fetch failed");
            }
            const res = await fetch(input, init);
            if (url.endsWith("/result") && res.ok) resultOk++;
            return res;
        };
        const a = realAgent(secret, "Spool laptop", { fetchImpl });
        try {
            await until("the agent to say hello", () => Boolean(svc().store.runnerOf(OPEN_OWNER_ID)?.online));
            const started = await admin("POST", `/api/tests/${p.pass}/validate`);
            expect(started.status, started.text).toBe(202);
            await until("the platform to go away", () => blockedUntil > 0, 120_000);
            await until("the result to be kept on disk", () => fs.existsSync(path.join(a.dir, "outbox")) && fs.readdirSync(path.join(a.dir, "outbox")).some((f) => f.endsWith(".json")), 30_000);
            const job = await jobDone(started.body.jobId, 120_000);
            expect(job.status).toBe("COMPLETED");
            expect(Date.now()).toBeGreaterThanOrEqual(blockedUntil);
            expect(resultOk).toBe(1);
            expect(fs.readdirSync(path.join(a.dir, "outbox")).filter((f) => f.endsWith(".json"))).toEqual([]);
            expect(a.lines.join("\n")).toMatch(/kept on this computer/);
            expect((await admin("GET", `/api/tests/${p.pass}/executions`)).body[0]).toMatchObject({ status: "passed" });
        } finally {
            a.agent.stop();
            await a.done;
        }
    }, 240_000);

    it("an agent whose newer protocol is refused says hello again with protocol 1, and still completes a run (as protocol 1)", async () => {
        const p = await project("Protocol one");
        const { secret } = personalRunner(platform, { label: "Old platform", replace: true });
        let refusedOnce = false;
        const fetchImpl: typeof fetch = async (input, init) => {
            // A platform that speaks only protocol 1 and refuses anything else (today's platform answers a mismatch with 409).
            if (String(input).endsWith("/api/agent/hello") && JSON.parse(String(init?.body)).protocols) {
                refusedOnce = true;
                return new Response(JSON.stringify({ error: "This runner agent speaks protocol 2 and the platform speaks protocol 1. Update the agent." }), { status: 409, headers: { "content-type": "application/json" } });
            }
            return fetch(input, init);
        };
        const a = realAgent(secret, "Old platform", { fetchImpl });
        try {
            await until("the agent to say hello", () => Boolean(svc().store.runnerOf(OPEN_OWNER_ID)?.online));
            expect(refusedOnce).toBe(true);
            const agentId = svc().store.runnerOf(OPEN_OWNER_ID)!.agent!.id;
            expect(svc().store.agentProtocol(agentId)).toBe(1);
            const started = await admin("POST", `/api/tests/${p.pass}/validate`);
            const job = await jobDone(started.body.jobId);
            expect(job.status).toBe("COMPLETED");
            expect(job.ranOn).toMatchObject({ kind: "agent", name: "Old platform", phase: "completed" });
            const kinds = events(started.body.jobId).map((e) => e.kind);
            expect(kinds).toContain("agent_progress"); // protocol 1: lines come with heartbeats
            expect(kinds.filter((k) => k === "runner_step" || k === "runner_log")).toEqual([]);
            expect(a.lines.join("\n")).toMatch(/connecting again with protocol 1/);
            // A plain protocol-1 hello (no list) is answered with protocol 1, exactly as before.
            const raw = await rawAgent(p.id, "plain v1", [1]);
            expect(raw.protocol).toBe(1);
        } finally {
            a.agent.stop();
            await a.done;
        }
    }, 300_000);
});

describe("stopping the agent with the stop file", () => {
    it("stop.request in its folder stops it like SIGTERM: the running task is reported as stopped, and the agent exits 0", async () => {
        const id = (await admin("POST", "/api/projects", { name: "Stop file" })).body.id as string;
        const imp = await admin("POST", `/api/projects/${id}/specs`, { baseUrl: APP, validate: false, specs: [{ title: "A slow page", kind: "web", category: "Web", steps: [{ action: "navigate", url: `${APP}/slow` }] }] });
        svc().store.setRunner(id, { runOn: "agent" });
        const { secret } = personalRunner(platform, { label: "stop", replace: true });
        const stopDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-p2-stop-"));
        work.push(stopDir);
        requestStop(stopDir); // left from an earlier session: cleared at start, it must not stop this one
        const a = realAgent(secret, "Stop laptop", { stopDir });
        await until("the agent to say hello", () => Boolean(svc().store.runnerOf(OPEN_OWNER_ID)?.online));
        expect(fs.existsSync(path.join(stopDir, "stop.request"))).toBe(false);
        const started = await admin("POST", `/api/tests/${imp.body.tests[0].id}/validate`);
        await until("the run to be running on the agent", () => svc().store.tasksOfJob(started.body.jobId).some((t) => t.phase === "running"), 60_000);
        requestStop(stopDir);
        expect(await a.done).toBe(0);
        const task = svc().store.tasksOfJob(started.body.jobId)[0]!;
        expect(task.error).toBe("The agent was stopped.");
        expect(a.lines.join("\n")).toMatch(/A stop was asked for/);
        const job = await jobDone(started.body.jobId, 60_000);
        expect(job.status).toBe("FAILED");
    }, 120_000);
});

describe("protocol 2 rules, with hand-driven agents", () => {
    it("a reject is never offered to that runner again; with no other runner of its owner, the run fails with the reason (round 45: one runner per person)", async () => {
        const p = await project("Rejects");
        const first = await rawAgent(p.id, "No browser");
        expect(first.protocol).toBe(2);
        const started = await admin("POST", `/api/tests/${p.pass}/validate`);
        expect(started.status, started.text).toBe(202);
        const o1 = await poll(first);
        expect(o1.attemptId).toBeTruthy();
        expect(o1.attempt).toBe(1);
        expect((await agentApi(first.token, "POST", `/api/agent/tasks/${o1.taskId}/reject`, { attemptId: o1.attemptId, reason: "missing-browser", message: "This computer has no browser ready." })).status).toBe(200);
        // never offered to that runner again
        expect((await agentApi(first.token, "POST", "/api/agent/poll", { agentId: first.agentId, freeSlots: 1 })).status).toBe(204);
        expect(svc().store.getTask(o1.taskId)!.offers).toBe(0);
        const job = await jobDone(started.body.jobId, 60_000);
        expect(job.status).toBe("FAILED");
        const ev = events(started.body.jobId);
        expect(ev.filter((e) => e.kind === "runner_rejected").map((e) => e.message)).toEqual(["No browser did not take the run: This computer has no browser ready."]);
        expect(svc().store.getTask(o1.taskId)).toMatchObject({ status: "failed", phase: "rejected" });
        expect(svc().store.getTask(o1.taskId)!.error).toMatch(/no browser ready/);
    }, 120_000);

    it("accept time-out, fencing, duplicate events, a scrubbed heartbeat, and a result posted twice", async () => {
        const p = await project("Fencing");
        const a = await rawAgent(p.id, "Hand agent");
        const started = await admin("POST", `/api/tests/${p.pass}/validate`);
        const jobId = started.body.jobId as string;
        const o1 = await poll(a);
        // not accepted within AGENT_ACCEPT_SECONDS (2 s): back to the queue without using up an offer, and the run says so
        await until("the accept time-out", () => svc().store.getTask(o1.taskId)!.status === "queued", 20_000);
        expect(svc().store.getTask(o1.taskId)!.offers).toBe(0);
        expect(events(jobId).map((e) => e.message)).toContain("The runner “Hand agent” did not accept the run in time; offering it again.");
        const o2 = await poll(a);
        expect(o2.attempt).toBe(2);
        // every message of the old attempt is refused as superseded
        for (const [route, body] of [["accept", { attemptId: o1.attemptId }], ["heartbeat", { attemptId: o1.attemptId }], ["events", { attemptId: o1.attemptId, events: [{ type: "log", seq: 0, at: "x", line: "late" }] }], ["result", { attemptId: o1.attemptId, ok: true, runs: [] }]] as const) {
            const r = await agentApi(a.token, "POST", `/api/agent/tasks/${o2.taskId}/${route}`, body);
            expect(r.status, route).toBe(409);
            expect(r.body.details).toEqual({ code: "superseded" });
        }
        expect((await agentApi(a.token, "POST", `/api/agent/tasks/${o2.taskId}/accept`, { attemptId: o2.attemptId })).status).toBe(200);
        expect(svc().store.getTask(o2.taskId)!.phase).toBe("accepted");
        // a heartbeat line with the password (in plain and URL-encoded form) is kept scrubbed
        expect((await agentApi(a.token, "POST", `/api/agent/tasks/${o2.taskId}/heartbeat`, { attemptId: o2.attemptId, phase: "running", log: [`signing in with ${PASSWORD}`, `GET /login?pw=${encodeURIComponent(PASSWORD)}`] })).status).toBe(200);
        const t = svc().store.getTask(o2.taskId)!;
        expect(t.phase).toBe("running");
        expect(JSON.stringify(t.log)).not.toContain(PASSWORD);
        expect(JSON.stringify(t.log)).not.toContain(encodeURIComponent(PASSWORD));
        expect(t.log.join("\n")).toContain("[hidden]");
        // the same batch twice: stored once
        const batch = { attemptId: o2.attemptId, events: [{ type: "test_started", seq: 0, at: new Date().toISOString(), testId: p.pass, title: "Home" }, { type: "step_finished", seq: 1, at: new Date().toISOString(), testId: p.pass, index: 0, title: "1. Open", status: "passed", durationMs: 12 }] };
        expect((await agentApi(a.token, "POST", `/api/agent/tasks/${o2.taskId}/events`, batch)).body).toEqual({ ok: true, stored: 2, duplicates: 0 });
        expect((await agentApi(a.token, "POST", `/api/agent/tasks/${o2.taskId}/events`, batch)).body).toEqual({ ok: true, stored: 0, duplicates: 2 });
        expect(events(jobId).filter((e) => e.kind === "runner_test_started" || e.kind === "runner_step")).toHaveLength(2);
        // a screenshot event that names no uploaded file is not kept
        expect((await agentApi(a.token, "POST", `/api/agent/tasks/${o2.taskId}/events`, { attemptId: o2.attemptId, events: [{ type: "screenshot", seq: 2, at: "x", testId: p.pass, ref: "never.png" }] })).body).toMatchObject({ stored: 0 });
        // the result, then the same result again: 200 both times, the second says it was already received
        const result = { attemptId: o2.attemptId, ok: true, runs: [{ testId: o2.scripts[0].testId, status: "passed", durationMs: 5, failedStepIndex: -1, steps: [], artifacts: [{ kind: "screenshot", ref: "missing.png" }], responses: [] }] };
        expect((await agentApi(a.token, "POST", `/api/agent/tasks/${o2.taskId}/result`, result)).body).toEqual({ ok: true });
        expect((await agentApi(a.token, "POST", `/api/agent/tasks/${o2.taskId}/result`, result)).body).toEqual({ ok: true, alreadyReceived: true });
        const job = await jobDone(jobId, 60_000);
        expect(job.status).not.toBe("FAILED"); // a hand-made result with no steps; how the platform judges it is not this test's business
        expect(job.ranOn).toMatchObject({ kind: "agent", name: "Hand agent", phase: "completed", attempt: 2 });
        // a file named in the result but never uploaded is said, not dropped silently
        expect(events(jobId).find((e) => e.kind === "runner_file_missing")?.message).toMatch(/never uploaded/);
    }, 120_000);
});
