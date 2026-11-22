/**
 * Verification attempts on a real runner (Phase 5 hook H1, browser lock): the runner agent from source takes a task with `attempts: 2`,
 * a sign-up page and `video: false`, registers a new account on bench-shop before each attempt, runs the test twice in fresh browsers and
 * sends back one result per attempt, each saying which attempt and on what account, with no video. Runner-only platform, local site, no AI.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { memoryLogger } from "../src/agent/log.js";
import { loadConfig } from "../src/config.js";
import { playwrightGenerator } from "../src/engine/generators/playwright.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { parseAttemptNote } from "../src/engine/validation/runner.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { removeServerExecutionGuard } from "../src/platform/runner-only.js";
import { buildServer } from "../src/platform/server.js";
import { personalRunner, runOwner } from "./helpers/personal-runner.js";

const PORT = 9874;
const SHOP_PORT = 9875;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOP = `http://127.0.0.1:${SHOP_PORT}`;
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "BLOCK_PRIVATE_TARGETS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let shop: ChildProcess;
let dataDir: string;
let agentDir: string;

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "60", AGENT_WATCH_MS: "50" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    shop = spawn(process.execPath, ["examples/bench-shop/server.mjs", String(SHOP_PORT)], { env: { ...process.env, BENCH_DEFECTS: "BS-02" }, stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
        if (await fetch(`${SHOP}/`).then((r) => r.ok, () => false)) break;
        await new Promise((r) => setTimeout(r, 100));
    }
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-verify-runner-"));
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-verify-runner-agent-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, EXECUTION_MODE: "runners", WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false", SECRET_KEY: "verify-attempts-runner-secret-0123456789" }));
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
    shop?.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
});

describe("verification attempts on a runner", () => {
    it("runs the test once per attempt as a newly registered account, with no video, and says which attempt each result is", async () => {
        const { secret } = personalRunner(platform, { label: "Laptop" });
        const { log } = memoryLogger();
        const agent = new Agent({ config: { baseUrl: BASE, token: secret, name: "Laptop", concurrency: 1, workDir: agentDir, allowInsecure: false, cacheBytes: 64 * 1024 * 1024, tokenSource: "env" }, log, heartbeatMs: 500, backoff: { baseMs: 100, maxMs: 500 }, liveBatch: { maxDelayMs: 200 }, outboxMaxDelayMs: 2000 });
        const done = agent.run();
        try {
            const svc = getAgentServices(platform);
            for (let i = 0; i < 300 && !(svc.store.runnerOf(runOwner())?.online && svc.store.runnerOf(runOwner())?.agent?.capabilities.verifyAttempts); i++) await new Promise((r) => setTimeout(r, 100));
            expect(svc.store.runnerOf(runOwner())?.agent?.capabilities.verifyAttempts).toBe(1);
            const project = String(platform.repo.createProject({ name: "Verify on a runner" }).id);
            const appId = platform.repo.createApplication(project, SHOP, { ...DEFAULT_JOB_OPTIONS }, undefined) as string;
            const job = await platform.repo.createJob(project, appId, { ...DEFAULT_JOB_OPTIONS, startedBy: { kind: "user", id: runOwner() }, mode: "validate", testIds: [] });
            const spec = TestSpecSchema.parse({
                testId: "WEB-021",
                title: "Subtotal of two lines",
                kind: "web",
                category: "Cart",
                source: { origin: "browser-agent" },
                steps: [
                    { action: "navigate", url: "/login" },
                    { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}" },
                    { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" },
                    { action: "click", locator: { by: "role", role: "button", value: "Sign in" } },
                    { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Products" } },
                    { action: "navigate", url: "/products/p1" },
                    { action: "click", locator: { by: "role", role: "button", value: "Add to cart" } },
                    { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Your cart" } },
                    { action: "navigate", url: "/products/p3" },
                    { action: "fill", locator: { by: "label", value: "Quantity" }, value: "2" },
                    { action: "click", locator: { by: "role", role: "button", value: "Add to cart" } },
                    { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Your cart" } },
                    { action: "assert", check: "exactText", locator: { by: "testId", value: "subtotal" }, expected: "$21.00", source: "R-2" },
                ],
            });
            const script = playwrightGenerator.render(spec, { baseUrl: SHOP });
            const runs = await svc.executorFor({ projectId: project, jobId: job.id }).execute(
                "playwright",
                { scratchDir: path.join(dataDir, "scratch"), scripts: [{ testId: "WEB-021", filename: script.filename, content: script.content }] },
                // The shared account's sign-in is wrong on purpose: only a newly registered account gets as far as the cart.
                { run: { baseUrl: SHOP, credentials: { username: "nobody@example.test", password: "Wrong-password-1" }, headless: true } },
                { workers: 1, attempts: 2, freshAccount: { signupPath: "/register", loginPath: "/login" }, video: false },
            );
            expect(runs).toHaveLength(2);
            expect(runs.map((r) => parseAttemptNote(r.notes?.[0]))).toEqual([
                { attempt: 1, of: 2, clean: true, note: "as a newly registered account" },
                { attempt: 2, of: 2, clean: true, note: "as a newly registered account" },
            ]);
            for (const r of runs) {
                expect(r.status, r.error).toBe("failed");
                expect(r.failedStepIndex).toBe(spec.steps.length - 1);
                expect(r.artifacts.some((a) => a.kind === "video")).toBe(false);
            }
            platform.repo.setJobStatus(job.id, "FAILED", "test over");
        } finally {
            agent.stop();
            await done;
        }
    }, 300_000);
});
