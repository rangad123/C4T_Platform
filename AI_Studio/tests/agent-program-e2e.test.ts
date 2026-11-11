/**
 * The real agent against the REAL platform: a project whose runner is set to "agent", a token created through the API, the
 * real worker, and a local fixture application. A validation job goes through the platform's remote executor to this agent,
 * which runs the scripts with Playwright and uploads the artifacts; the platform stores what a local run would store.
 *
 * Browser-launching: run with  node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/agent-program-e2e.test.ts
 * Ports: platform 5884, fixture application 5885.
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
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const PLATFORM_PORT = 5884;
const APP_PORT = 5885;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;
const API_KEY = "ag-e2e-admin-key-31c8";
const PASSWORD = "AGE2E-Password-5b1d77";
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
let agentLines: string[];
let token = "";

const admin = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { "x-api-key": API_KEY, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; text: string; body: any };
};

async function jobDone(jobId: string): Promise<any> {
    for (let i = 0; i < 300; i++) {
        const j = (await admin("GET", `/api/test-generation/${jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) return j;
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("job did not finish");
}

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "20", AGENT_WATCH_MS: "100", AGENT_NO_AGENT_GRACE_SECONDS: "5" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    appServer = http.createServer((req, res) => {
        if (req.url === "/api/health") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok" }));
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><html lang="en"><head><title>Fixture</title></head><body><main><h1>Welcome to the fixture</h1></main></body></html>`);
    });
    await new Promise<void>((r) => appServer.listen(APP_PORT, "127.0.0.1", () => r()));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-age2e-"));
    agentWork = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-age2e-agent-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0" }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 150);
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
    // The stopped agent can leave connections waiting for an answer; close() waits for those, so end them first.
    server?.server.closeAllConnections();
    await server?.close();
    platform?.db.close();
    await new Promise((r) => appServer.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(agentWork, { recursive: true, force: true });
});

describe("a validation job that runs on a real agent", () => {
    let projectId = "";
    const ids: Record<string, string> = {};

    it("connects with a token made through the API and shows up as online", async () => {
        projectId = (await admin("POST", "/api/projects", { name: "Agent end to end" })).body.id;
        // Round 45: the open server's own runner (a platform without API_KEY and accounts acts as one person).
        token = personalRunner(platform, { label: "e2e" }).secret;
        const { log, lines } = memoryLogger();
        agentLines = lines;
        agent = new Agent({
            config: { baseUrl: BASE, token, name: "e2e agent", concurrency: 1, workDir: agentWork, allowInsecure: false, cacheBytes: 64 * 1024 * 1024, tokenSource: "env" },
            log,
            heartbeatMs: 500,
            backoff: { baseMs: 100, maxMs: 500 },
        });
        agentDone = agent.run();
        for (let i = 0; i < 100; i++) {
            const list = (await admin("GET", `/api/projects/${projectId}/agents`)).body as Array<{ name: string; online: boolean }>;
            if (list.some((a) => a.online)) break;
            await new Promise((r) => setTimeout(r, 200));
        }
        const list = (await admin("GET", `/api/projects/${projectId}/agents`)).body as Array<{ name: string; online: boolean; capabilities: { browsers: string[] } }>;
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ name: "e2e agent", online: true });
        expect(list[0]!.capabilities.browsers).toContain("chromium");
        expect(JSON.stringify(list)).not.toContain(token);
    }, 60_000);

    it("imports tests and sends the project's runs to the agent", async () => {
        const imp = await admin("POST", `/api/projects/${projectId}/specs`, {
            baseUrl: APP,
            validate: false,
            credentials: { username: "demo@example.com", password: PASSWORD },
            specs: [
                { title: "The home page greets people", kind: "web", category: "Web", steps: [{ action: "navigate", url: `${APP}/` }, { action: "assert", check: "visible", locator: { by: "text", value: "Welcome to the fixture" } }] },
                { title: "A missing heading is reported", kind: "web", category: "Web", steps: [{ action: "navigate", url: `${APP}/` }, { action: "assert", check: "visible", locator: { by: "text", value: "Nothing like this" } }] },
                { title: "The health endpoint answers", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/api/health" }, { action: "assertResponse", check: "status", expected: 200 }] },
            ],
        });
        expect(imp.status).toBe(202);
        const made = imp.body.tests as Array<{ id: string }>;
        [ids["home"], ids["missing"], ids["health"]] = [made[0]!.id, made[1]!.id, made[2]!.id];
        expect(Object.keys(ids)).toHaveLength(3);
        const set = await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent" });
        expect(set.status, set.text).toBe(200);
    });

    it("a passing web test and an API test are VALIDATED, run on the agent, with no artifacts", async () => {
        for (const title of ["home", "health"]) {
            const started = await admin("POST", `/api/tests/${ids[title]}/validate`);
            expect(started.status, started.text).toBe(202);
            const job = await jobDone(started.body.jobId);
            expect(job.ranOn).toMatchObject({ kind: "agent", name: "e2e agent" });
            const exec = (await admin("GET", `/api/tests/${ids[title]}/executions`)).body;
            expect(exec[0]).toMatchObject({ status: "passed" });
        }
        const tests = (await admin("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; validationStatus: string }>;
        expect(tests.find((t) => t.id === ids["home"])!.validationStatus).toBe("VALIDATED");
        expect(tests.find((t) => t.id === ids["health"])!.validationStatus).toBe("VALIDATED");
        expect(platform.db.all("SELECT kind FROM artifacts WHERE project_id = ? AND kind IN ('screenshot','trace','video')", projectId)).toEqual([]);
    }, 180_000);

    it("a failing web test is not VALIDATED and its screenshot, trace and evidence are stored like a local run's", async () => {
        const id = ids["missing"]!;
        const started = await admin("POST", `/api/tests/${id}/validate`);
        expect(started.status, started.text).toBe(202);
        await jobDone(started.body.jobId);
        const exec = (await admin("GET", `/api/tests/${id}/executions`)).body;
        expect(exec[0].status).not.toBe("passed");
        expect(exec[0].error).toMatch(/Nothing like this|toBeVisible/);
        const tests = (await admin("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; validationStatus: string }>;
        expect(tests.find((t) => t.id === id)!.validationStatus).not.toBe("VALIDATED");

        const artifacts = platform.db.all<{ id: string; kind: string }>("SELECT id, kind FROM artifacts WHERE project_id = ? AND test_case_id = ?", projectId, id);
        const kinds = artifacts.map((a) => a.kind);
        expect(kinds).toEqual(expect.arrayContaining(["screenshot", "trace"]));
        const shot = artifacts.find((a) => a.kind === "screenshot")!;
        const served = await fetch(`${BASE}/api/artifacts/${shot.id}?key=${API_KEY}`);
        expect(Buffer.from(await served.arrayBuffer()).subarray(1, 4).toString()).toBe("PNG");
        if (kinds.includes("evidence")) {
            const ev = await admin("GET", `/api/tests/${id}/evidence`);
            expect(ev.status).toBe(200);
        }
    }, 180_000);

    it("the password reaches the test process only: not the agent's output, its folder, or what the platform stores", async () => {
        const text = agentLines.join("\n");
        expect(text).toMatch(/Task .* finished/);
        for (const s of [PASSWORD, token]) {
            expect(text, s).not.toContain(s);
        }
        // wait for the agent's scratch folders to go, then look at everything left on its disk
        for (let i = 0; i < 50 && fs.readdirSync(path.join(agentWork, "tasks")).length > 0; i++) await new Promise((r) => setTimeout(r, 100));
        const leaks: string[] = [];
        const scan = (dir: string, root: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isSymbolicLink()) continue;
                if (e.isDirectory()) scan(full, root);
                else {
                    const bytes = fs.readFileSync(full);
                    for (const s of [PASSWORD, token]) if (bytes.toString("latin1").includes(s) || bytes.toString("utf16le").includes(s)) leaks.push(`${s.slice(0, 10)} in ${path.relative(root, full)}`);
                }
            }
        };
        scan(agentWork, agentWork);
        platform.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        scan(dataDir, dataDir);
        expect(leaks).toEqual([]);
    });
});
