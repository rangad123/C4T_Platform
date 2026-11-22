/**
 * Verification attempts on the runner protocol (Phase 5 hook H1): an optional `attempts` field (with `freshAccount` and `video`) on the
 * task, and the runner capability `verifyAttempts: 1`. Old offers parse exactly as before; a task with attempts goes only to a runner that
 * reports the capability, and a run sent to an older runner ends at once with the sentence instead of a single recorded run. No browser:
 * the runner here is only a hello, and the task that is sent is read from the queue.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Capabilities, TaskOffer } from "../src/agent-protocol/schema.js";
import { loadConfig } from "../src/config.js";
import { getAgentServices, verifyNeedsUpdate, verifyProblem } from "../src/platform/agent-services.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { removeServerExecutionGuard } from "../src/platform/runner-only.js";
import { personalRunner, runOwner } from "./helpers/personal-runner.js";

const base = { taskId: "t-1", jobId: "j-1", adapterId: "playwright", leaseSeconds: 60, workers: 1, scripts: [{ testId: "WEB-001", filename: "WEB-001.spec.ts", content: "x" }], env: { baseUrl: "http://127.0.0.1:1", headless: true } };
const caps = { os: "linux" as const, arch: "x64", node: "22.0.0", browsers: ["chromium" as const] };

describe("the task and the capability", () => {
    it("an offer without the new fields parses exactly as before; the fields are optional and bounded", () => {
        expect(TaskOffer.parse(base)).toEqual(base);
        const v = TaskOffer.parse({ ...base, attempts: 3, freshAccount: { signupPath: "/register", loginPath: "/login" }, video: false });
        expect(v).toMatchObject({ attempts: 3, freshAccount: { signupPath: "/register", loginPath: "/login" }, video: false });
        expect(TaskOffer.safeParse({ ...base, attempts: 6 }).success).toBe(false);
        expect(TaskOffer.safeParse({ ...base, attempts: 0 }).success).toBe(false);
        expect(TaskOffer.safeParse({ ...base, video: true }).success).toBe(false);
        expect(Capabilities.parse({ ...caps, verifyAttempts: 1 }).verifyAttempts).toBe(1);
        expect(Capabilities.parse(caps).verifyAttempts).toBeUndefined();
    });

    it("an older runner gets the sentence for a task with attempts; any other task is unaffected", () => {
        const old = { name: "Laptop", capabilities: {} };
        expect(verifyProblem(old, { attempts: 3 })).toBe(verifyNeedsUpdate("Laptop"));
        expect(verifyProblem(old, { video: false })).toBe(verifyNeedsUpdate("Laptop"));
        expect(verifyProblem(old, {})).toBeUndefined();
        expect(verifyProblem({ name: "Laptop", capabilities: { verifyAttempts: 1 } }, { attempts: 3, video: false })).toBeUndefined();
        expect(verifyNeedsUpdate("Laptop")).toMatch(/Your runner “Laptop” is too old to verify findings.*Update your runner in Settings/);
    });
});

let platform: Platform;
let dataDir: string;
const ENV_KEYS = ["BLOCK_PRIVATE_TARGETS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeAll(() => {
    delete process.env.BLOCK_PRIVATE_TARGETS;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-verify-attempts-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, EXECUTION_MODE: "runners", WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false", SECRET_KEY: "verify-attempts-unit-secret-0123456789" }));
});
afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    platform?.db.close();
    removeServerExecutionGuard();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("the runner executor", () => {
    it("sends attempts, the sign-up page and no video to a runner that runs them, and refuses an older one with the sentence", async () => {
        const svc = getAgentServices(platform);
        const { secret } = personalRunner(platform, { label: "Laptop" });
        const token = svc.authenticate(`Bearer ${secret}`);
        const hello = (c: Record<string, unknown>) => svc.hello(token, { protocol: 1, protocols: [1, 2], name: "Laptop", version: "test", capabilities: { ...caps, ...c }, concurrency: 1 });
        hello({});
        const project = String(platform.repo.createProject({ name: "Verify attempts" }).id);
        const appId = platform.repo.createApplication(project, "http://127.0.0.1:1", { ...DEFAULT_JOB_OPTIONS }, undefined) as string;
        const job = await platform.repo.createJob(project, appId, { ...DEFAULT_JOB_OPTIONS, startedBy: { kind: "user", id: runOwner() }, mode: "validate", testIds: [] });
        const batch = { scratchDir: path.join(dataDir, "scratch"), scripts: [{ testId: "WEB-001", filename: "WEB-001.spec.ts", content: "import { test } from '@playwright/test'; test('x', async () => {});" }] };
        const env = { run: { baseUrl: "http://127.0.0.1:1", headless: true } };
        const opts = { workers: 1, attempts: 3, freshAccount: { signupPath: "/register" }, video: false as const };

        await expect(svc.executorFor({ projectId: project, jobId: job.id }).execute("playwright", batch, env, opts)).rejects.toThrow(verifyNeedsUpdate("Laptop"));
        expect(svc.store.tasksOfJob(job.id)).toEqual([]);

        hello({ verifyAttempts: 1 });
        const stop = new AbortController();
        const sent = svc.executorFor({ projectId: project, jobId: job.id }).execute("playwright", batch, env, { ...opts, signal: stop.signal });
        sent.catch(() => undefined);
        let tasks = svc.store.tasksOfJob(job.id);
        for (let i = 0; i < 100 && tasks.length === 0; i++) {
            await new Promise((r) => setTimeout(r, 20));
            tasks = svc.store.tasksOfJob(job.id);
        }
        expect(tasks).toHaveLength(1);
        expect(svc.decrypt<TaskOffer>(tasks[0]!.payloadEnc)).toMatchObject({ attempts: 3, freshAccount: { signupPath: "/register" }, video: false });
        stop.abort();
        await expect(sent).rejects.toThrow();
        platform.repo.setJobStatus(job.id, "FAILED", "test over");
    }, 30_000);
});
