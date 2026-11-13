/**
 * What the page showed at a failing check (Playwright's error context) crosses the runner protocol: the real runner agent from
 * source runs a failing web test, masks the snapshot with the run's secrets before it sends it, and the platform rebuilds the run
 * with it (what repair reads). Runner-only platform, local site, no AI.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { memoryLogger } from "../src/agent/log.js";
import { WireRun } from "../src/agent-protocol/schema.js";
import { loadConfig } from "../src/config.js";
import { playwrightGenerator } from "../src/engine/generators/playwright.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { removeServerExecutionGuard } from "../src/platform/runner-only.js";
import { buildServer } from "../src/platform/server.js";
import { personalRunner, runOwner } from "./helpers/personal-runner.js";

const PORT = 9334;
const SITE_PORT = 9335;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const PASSWORD = "Runner-Secret-54x";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "BLOCK_PRIVATE_TARGETS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let site: http.Server;
let dataDir: string;
let agentDir: string;

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "60", AGENT_WATCH_MS: "50" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    site = http.createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Pay</title><h1>Checkout</h1><p>Key ${PASSWORD}</p><button>Pay now</button>`));
    await new Promise<void>((r) => site.listen(SITE_PORT, "127.0.0.1", () => r()));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-errctx-"));
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-errctx-agent-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, EXECUTION_MODE: "runners", WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false", SECRET_KEY: "runner-error-context-secret-0123456789" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
}, 60_000);

afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    server?.server.closeAllConnections();
    await server?.close();
    platform?.db.close();
    removeServerExecutionGuard();
    await new Promise((r) => site.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
});

describe("error context over the runner protocol", () => {
    it("is optional and capped on the wire", () => {
        const base = { testId: "WEB-001", status: "failed", durationMs: 1, failedStepIndex: 0, steps: [], artifacts: [], responses: [] };
        expect(WireRun.safeParse(base).success).toBe(true); // an older runner sends none
        expect(WireRun.safeParse({ ...base, errorContext: "x".repeat(6000) }).success).toBe(true);
        expect(WireRun.safeParse({ ...base, errorContext: "x".repeat(6001) }).success).toBe(false);
    });

    it("the real runner sends the masked snapshot of a failing test, and the platform's run carries it", async () => {
        const { secret } = personalRunner(platform, { label: "Laptop" });
        const { log } = memoryLogger();
        const agent = new Agent({ config: { baseUrl: BASE, token: secret, name: "Laptop", concurrency: 1, workDir: agentDir, allowInsecure: false, cacheBytes: 64 * 1024 * 1024, tokenSource: "env" }, log, heartbeatMs: 500, backoff: { baseMs: 100, maxMs: 500 }, liveBatch: { maxDelayMs: 200 }, outboxMaxDelayMs: 2000 });
        const done = agent.run();
        try {
            for (let i = 0; i < 300 && !(getAgentServices(platform).store.runnerOf(runOwner())?.online && getAgentServices(platform).store.runnerOf(runOwner())?.agent); i++) await new Promise((r) => setTimeout(r, 100));
            const project = String(platform.repo.createProject({ name: "Error context" }).id);
            const appId = platform.repo.createApplication(project, SITE, { ...DEFAULT_JOB_OPTIONS }, undefined) as string;
            const job = await platform.repo.createJob(project, appId, { ...DEFAULT_JOB_OPTIONS, startedBy: { kind: "user", id: runOwner() }, mode: "validate", testIds: [] });
            const spec = TestSpecSchema.parse({ testId: "WEB-001", title: "Pay", kind: "web", category: "Checkout", source: { origin: "browser-agent" }, steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "visible", locator: { by: "role", role: "button", value: "Pay later", exact: true } }] });
            const script = playwrightGenerator.render(spec, { baseUrl: SITE });
            const [run] = await getAgentServices(platform).executorFor({ projectId: project, jobId: job.id }).execute(
                "playwright",
                { scratchDir: path.join(dataDir, "scratch"), scripts: [{ testId: "WEB-001", filename: script.filename, content: script.content }] },
                { run: { baseUrl: SITE, credentials: { username: "buyer", password: PASSWORD }, headless: true } },
                { workers: 1 },
            );
            expect(run!.status, run!.error).toBe("failed");
            expect(run!.errorContext).toContain('button "Pay now"');
            expect(run!.errorContext).not.toContain(PASSWORD);
            platform.repo.setJobStatus(job.id, "FAILED", "test over");
        } finally {
            agent.stop();
            await done;
        }
    }, 240_000);
});
