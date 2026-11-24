/**
 * Verification on a runner (Phase 5, browser lock): a project whose tests run on runners gets its run's findings verified by a job of its own
 * (mode "verify"), whose attempts go to the starter's runner through hook H1. A runner-only platform with its dispatch worker, the real runner
 * agent from source and bench-shop with seed BS-02 from a dirty start (the shared account's cart holds leftovers):
 *  - after the run, verifyAfterJob writes the failed tests as findings and queues a verification job instead of leaving them waiting;
 *  - the dispatch worker runs that job on the runner: the seed is Reproduced 3 of 3 (then Confirmed at high confidence), the state-bound test Unconfirmed, with the reasons;
 *  - nothing ran on the server (its guard refused nothing).
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { memoryLogger } from "../src/agent/log.js";
import { loadConfig } from "../src/config.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { verifyAfterJob } from "../src/platform/findings/verify-service.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { removeServerExecutionGuard, serverRunRefusals } from "../src/platform/runner-only.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { personalRunner, runOwner } from "./helpers/personal-runner.js";

const PORT = 9876;
const SHOP_PORT = 9877;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOP = `http://127.0.0.1:${SHOP_PORT}`;
const ALICE = { username: "alice@example.test", password: "Password1!" };
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "BLOCK_PRIVATE_TARGETS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dispatch: Worker | undefined;
let shop: ChildProcess;
let dataDir: string;
let agentDir: string;

async function call(pathname: string, body: unknown, cookie?: string): Promise<{ status: number; cookie?: string }> {
    const res = await fetch(`${SHOP}${pathname}`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body), redirect: "manual" });
    await res.arrayBuffer();
    return { status: res.status, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "60", AGENT_WATCH_MS: "50" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    shop = spawn(process.execPath, ["examples/bench-shop/server.mjs", String(SHOP_PORT)], { env: { ...process.env, BENCH_DEFECTS: "BS-02" }, stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
        if (await fetch(`${SHOP}/`).then((r) => r.ok, () => false)) break;
        await new Promise((r) => setTimeout(r, 100));
    }
    const signedIn = await call("/api/login", { email: ALICE.username, password: ALICE.password });
    expect(signedIn.status).toBe(200);
    expect((await call("/api/cart/items", { productId: "p4", quantity: 3 }, signedIn.cookie)).status).toBeLessThan(300);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-verify-on-runner-"));
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-verify-on-runner-agent-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, EXECUTION_MODE: "runners", WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false", SECRET_KEY: "verify-on-runner-secret-0123456789" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
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
    shop?.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
});

const signIn = [
    { action: "navigate", url: "/login" },
    { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}" },
    { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" },
    { action: "click", locator: { by: "role", role: "button", value: "Sign in" } },
    { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Products" } },
];
const add = (product: string, quantity: string) => [
    { action: "navigate", url: `/products/${product}` },
    { action: "fill", locator: { by: "label", value: "Quantity" }, value: quantity },
    { action: "click", locator: { by: "role", role: "button", value: "Add to cart" } },
    { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Your cart" } },
];
const spec = (testId: string, title: string, steps: unknown[]) =>
    TestSpecSchema.parse({ testId, title, kind: "web", category: "Cart", source: { origin: "browser-agent", requirements: ["R-2"] }, expectedResults: ["The cart adds up its lines: $21.00 for one p1 and two p3, $17.50 for one p1 with shipping"], steps });
const seed = spec("WEB-021", "Subtotal of two lines", [...signIn, ...add("p1", "1"), ...add("p3", "2"), { action: "assert", check: "exactText", locator: { by: "testId", value: "subtotal" }, expected: "$21.00", source: "R-2" }]);
const stateBound = spec("WEB-022", "Total of one line", [...signIn, ...add("p1", "1"), { action: "assert", check: "exactText", locator: { by: "testId", value: "total" }, expected: "$17.50", source: "R-2" }]);

describe("verification of a runner project's findings", () => {
    it("queues a verification job whose attempts run on the runner: the seed Reproduced, the state-bound test Unconfirmed", async () => {
        const { secret } = personalRunner(platform, { label: "Laptop" });
        const { log } = memoryLogger();
        const agent = new Agent({ config: { baseUrl: BASE, token: secret, name: "Laptop", concurrency: 1, workDir: agentDir, allowInsecure: false, cacheBytes: 64 * 1024 * 1024, tokenSource: "env" }, log, heartbeatMs: 500, backoff: { baseMs: 100, maxMs: 500 }, liveBatch: { maxDelayMs: 200 }, outboxMaxDelayMs: 2000 });
        const done = agent.run();
        try {
            const svc = getAgentServices(platform);
            for (let i = 0; i < 300 && !(svc.store.runnerOf(runOwner())?.online && svc.store.runnerOf(runOwner())?.agent?.capabilities.verifyAttempts); i++) await new Promise((r) => setTimeout(r, 100));
            const project = String(platform.repo.createProject({ name: "Bench shop on a runner" }).id);
            const appId = platform.repo.createApplication(project, SHOP, { ...DEFAULT_JOB_OPTIONS, allowMutatingApiTests: true }, ALICE) as string;
            platform.repo.setAppModel(appId, { origin: SHOP, pages: [{ path: "/register", type: "register" }], apis: [], authentication: { signupPath: "/register", loginPath: "/login" } } as never);
            const run = await platform.repo.createJob(project, appId, { ...DEFAULT_JOB_OPTIONS, startedBy: { kind: "user", id: runOwner() }, mode: "validate", testIds: [] });
            const suiteId = platform.repo.getOrCreateSuite(project, "Cart", "cart");
            const at = new Date().toISOString();
            for (const [s, error] of [[seed, 'Expected "$21.00", received "$23.25"'], [stateBound, 'Expected "$17.50", received "$192.47"']] as const) {
                const testId = platform.repo.insertTest({ projectId: project, suiteId, jobId: run.id, spec: s, framework: "playwright", validationStatus: "FAILED_VALIDATION" });
                const last = s.steps.length - 1;
                platform.repo.addExecution({ testId, scriptId: null, jobId: run.id, attempt: 1, status: "failed", durationMs: 1, error: `Error: expect(locator).toHaveText(expected) failed. ${error}`, startedAt: at, steps: [{ index: last, title: `${last + 1}. check`, status: "failed", error: `Error: expect(locator).toHaveText(expected) failed. ${error}` }] });
            }
            platform.repo.setJobStatus(run.id, "COMPLETED");

            const queued = await verifyAfterJob(platform, platform.repo.getJob(run.id)!);
            expect(queued?.queuedJobId, JSON.stringify(queued)).toBeTruthy();
            const store = new CandidateFindingStore(platform.sql);
            expect((await store.list(project)).map((f) => f.state).sort()).toEqual(["candidate", "candidate"]);
            expect(platform.repo.getJob(queued!.queuedJobId!)?.options).toMatchObject({ mode: "verify", verifyJobId: run.id, startedBy: { kind: "user", id: runOwner() } });

            const refusedBefore = serverRunRefusals();
            dispatch = Worker.dispatch(platform, 100);
            dispatch.start();
            let job = platform.repo.getJob(queued!.queuedJobId!)!;
            for (let i = 0; i < 2400 && !["COMPLETED", "FAILED", "PARTIALLY_COMPLETED"].includes(job.status); i++) {
                await new Promise((r) => setTimeout(r, 250));
                job = platform.repo.getJob(job.id)!;
            }
            expect(job.status, job.error ?? "").toBe("COMPLETED");

            const findings = await store.list(project);
            const byKey = (k: string) => findings.find((f) => platform.repo.getTest(f.testId!)?.testKey === k)!;
            const s = (await store.get(project, byKey("WEB-021").id))!;
            const b = (await store.get(project, byKey("WEB-022").id))!;
            expect(s).toMatchObject({ state: "confirmed", findingClass: "app_defect" });
            expect(s.attempts).toHaveLength(3);
            expect((await store.history(project, s.id)).at(-1)!.reason).toMatch(/3 of 3 attempts, on a newly registered account each time/);
            expect(b.state).toBe("unconfirmed");
            // The verification job does not write the run's failures again: each finding was seen once, in the run.
            expect([s.seenCount, b.seenCount]).toEqual([1, 1]);
            expect((await store.history(project, b.id)).at(-1)!.reason).toMatch(/passed in 3 of 3 attempts on a newly registered account each time/);
            // The attempts ran on the runner: one runner task per finding in the verification job, and nothing ran on the server.
            expect(svc.store.tasksOfJob(job.id).length).toBeGreaterThanOrEqual(2);
            expect(serverRunRefusals()).toBe(refusedBefore);
            const events = platform.repo.db.all<{ message: string }>("SELECT message FROM agent_events WHERE job_id = ? AND kind = 'finding_verification'", job.id);
            expect(events.map((e) => e.message).join("\n")).toMatch(/Findings verified: .*1 reproduced.*1 unconfirmed|Findings verified: .*1 unconfirmed.*1 reproduced/);
        } finally {
            agent.stop();
            await done;
        }
    }, 600_000);
});
