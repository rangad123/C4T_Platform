/**
 * Risky saved checks on a REAL runner (VERIFY-P3-P4 gap 8): the real agent from source, the real platform and worker, and a small local
 * application that counts the orders it receives. A Run of a saved check that sends three orders at once:
 *  - on a project with a current client authorization for the application, the runner runs it: the application receives the three orders;
 *  - on a project without one, it skips itself with its sentence and sends nothing, although this runner's own environment sets
 *    TEST_RISKY_CHECKS=1 and TEST_RISKY_GATE=authorization (a runner cannot switch the checks on by itself).
 * The message-level claims (hello, poll) are in runner-risky-gate-unit.test.ts.
 *
 * Runs the test tool (no browser window): node scripts/with-lock.mjs browser -- npx vitest run tests/runner-risky-gate.test.ts
 * Ports: platform 7850, application 7851. No model, no network beyond 127.0.0.1.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { memoryLogger } from "../src/agent/log.js";
import { loadConfig } from "../src/config.js";
import { RISKY_SKIPPED } from "../src/engine/validation/risky.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { hasCurrentAuthorization } from "../src/security/authorization-gate.js";
import { securityStoreFor } from "../src/security/store.js";
import { personalRunner, runOwner } from "./helpers/personal-runner.js";

const PLATFORM_PORT = 7850;
const APP_PORT = 7851;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;
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
/** Orders the application received, by path. */
const orders = new Map<string, number>();

const admin = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; text: string; body: any };
};

async function jobDone(jobId: string) {
    for (let i = 0; i < 400; i++) {
        const j = platform.repo.getJob(jobId)!;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED", "CANCELLED"].includes(j.status)) return j;
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("job did not finish");
}

/** A Run, data changes on, of one saved check that sends three orders at once to `ordersPath`, on the project's runner. */
async function runRisky(name: string, ordersPath: string, authorized: boolean) {
    const projectId = (await admin("POST", "/api/projects", { name })).body.id as string;
    if (authorized) {
        const sec = securityStoreFor(platform.db);
        const target = sec.createApplication(projectId, { name, targetUrl: `${APP}/`, environment: "staging", scope: [], excludedPaths: [], maxRequestsPerSecond: 10 });
        sec.addAuthorization(target.id, { basis: "owner", approverName: "Owner", documentReference: null, restrictions: null, statement: "I confirm.", confirmedByName: "Tester" });
    }
    const imp = await admin("POST", `/api/projects/${projectId}/specs`, {
        baseUrl: APP,
        validate: false,
        specs: [{ title: "Three orders at once", kind: "api", category: "API", steps: [{ action: "request", method: "POST", path: ordersPath, parallel: 3 }, { action: "assertResponse", check: "relation", expression: "ok == 3" }] }],
    });
    expect(imp.status, imp.text).toBe(202);
    const testId = (imp.body.tests as Array<{ id: string }>)[0]!.id;
    const set = await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent" });
    expect(set.status, set.text).toBe(200);
    for (let i = 0; i < 150 && !((await admin("GET", `/api/projects/${projectId}/agents`)).body as Array<{ online: boolean }>).some((a) => a.online); i++) await new Promise((r) => setTimeout(r, 200));
    const appId = platform.repo.createApplication(projectId, APP, { ...DEFAULT_JOB_OPTIONS }, undefined) as string;
    const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [testId], allowMutatingApiTests: true, startedBy: { kind: "user", id: runOwner() } });
    const ended = await jobDone(job.id);
    const events = platform.repo.listEvents(job.id, 0, 5000).map((e) => ({ kind: String(e.kind), message: String(e.message) }));
    return { ended, events, test: platform.repo.getTest(testId)!, ranOnAgent: events.some((e) => e.kind === "agent_task_queued") };
}

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "20", AGENT_WATCH_MS: "100", AGENT_NO_AGENT_GRACE_SECONDS: "5" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    appServer = http.createServer((req, res) => {
        if (req.method === "POST") orders.set(req.url ?? "", (orders.get(req.url ?? "") ?? 0) + 1);
        res.writeHead(req.method === "POST" ? 201 : 200, { "content-type": "application/json" }).end(JSON.stringify({ id: orders.size }));
    });
    await new Promise<void>((r) => appServer.listen(APP_PORT, "127.0.0.1", () => r()));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-risky-real-"));
    agentWork = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-risky-real-agent-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), CONCURRENCY: "1", MAX_REPAIR_ATTEMPTS: "0" }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    // The platform's own wiring (schedule-services.ts): the gate's "authorization" is read from the project's records.
    worker = new Worker({ ...platform, hasCurrentAuthorization: (p, u) => hasCurrentAuthorization(platform.db, p, u) }, 150);
    worker.start();
    const { log } = memoryLogger();
    // This runner tries to switch the risky checks on by itself, through its own environment.
    const env = { ...process.env, TEST_RISKY_CHECKS: "1", TEST_RISKY_GATE: "authorization" };
    agent = new Agent({ config: { baseUrl: BASE, token: personalRunner(platform, { label: "risky" }).secret, name: "risky agent", concurrency: 1, workDir: agentWork, allowInsecure: false, cacheBytes: 64 * 1024 * 1024, tokenSource: "env" }, log, env, heartbeatMs: 500, backoff: { baseMs: 100, maxMs: 500 } });
    agentDone = agent.run();
}, 60_000);

afterAll(async () => {
    agent?.stop();
    await agentDone;
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
    fs.rmSync(agentWork, { recursive: true, force: true });
});

describe("risky saved checks on a real runner", () => {
    it("an authorized project's Run on the runner runs the risky check: the application receives the three orders", async () => {
        const r = await runRisky("Authorized shop", "/orders-authorized", true);
        expect(r.ranOnAgent, JSON.stringify(r.events)).toBe(true);
        expect(orders.get("/orders-authorized")).toBe(3);
        expect(r.events.some((e) => e.kind === "risky_check_skipped")).toBe(false);
        expect(r.test.validationStatus, JSON.stringify(r.events)).toBe("VALIDATED");
    }, 180_000);

    it("an unauthorized project's Run skips it with its sentence and sends nothing, although the runner's own environment asks for it", async () => {
        const r = await runRisky("Unauthorized shop", "/orders-unauthorized", false);
        expect(r.ranOnAgent, JSON.stringify(r.events)).toBe(true);
        expect(orders.get("/orders-unauthorized") ?? 0).toBe(0);
        expect(r.events.find((e) => e.kind === "risky_check_skipped")?.message, JSON.stringify(r.events)).toContain(RISKY_SKIPPED);
        expect(r.test.validationStatus).not.toBe("VALIDATED");
    }, 180_000);
});
