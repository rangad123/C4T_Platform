/**
 * A background findings verification (mode "verify", VERIFY_FINDINGS) never makes a person's Run, a schedule or a trigger fail with
 * "Job … is still QUEUED" (seen by the runner smoke check 2026-11-23): the Run is accepted and queued, and the two never run at the
 * same time (claimNextJob): a run waits behind a verification already running, and a verification still queued waits behind the run.
 * Every other job still keeps the one-active-job rule.
 *
 *   node scripts/with-lock.mjs tsc -- npx vitest run tests/verify-yields.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { TestSpec } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { startHeartbeat } from "../src/platform/ops/heartbeat.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { startScheduledJob } from "../src/platform/scheduler.js";
import { buildServer } from "../src/platform/server.js";

const KEY = "verify-yields-key-3c81d2";
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let stopBeat: (() => void) | undefined;
const dirs: string[] = [];

const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, headers: { "x-api-key": KEY }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body } as { status: number; body: any };
};

const SPEC = { testId: "API-001", title: "The list answers", kind: "api", category: "Items", type: "functional", priority: "medium", tags: ["api"], steps: [{ action: "request", method: "GET", path: "/", auth: "default", description: "" }] } as unknown as TestSpec;

async function project(name: string) {
    const projectId = (await call("POST", "/api/projects", { name })).body.id as string;
    const appId = platform.repo.createApplication(projectId, "http://127.0.0.1:9/", {}) as string;
    const suiteId = platform.repo.getOrCreateSuite(projectId, "Main", "main");
    const testId = platform.repo.insertTest({ projectId, suiteId, jobId: null, spec: SPEC, framework: "playwright" as never, validationStatus: "PENDING" });
    const verify = async () => (await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "verify", verifyJobId: "earlier-job", testIds: [testId] })).id;
    return { projectId, appId, testId, verify };
}
const statusOf = (id: string) => platform.repo.getJob(id)!.status;
const finish = (id: string) => platform.db.run("UPDATE generation_jobs SET status = 'COMPLETED', finished_at = ?, lease_until = NULL WHERE id = ?", new Date().toISOString(), id);
/** Claims as a worker would until nothing is left to claim, and returns the ids claimed in this pass. */
const claimAll = () => {
    const out: string[] = [];
    for (let j = platform.repo.claimNextJob(60_000, "w"); j; j = platform.repo.claimNextJob(60_000, "w")) out.push(j.id);
    return out;
};

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-verify-yields-"));
    dirs.push(dataDir);
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECRET_KEY: "verify-yields-secret-key-0123456789" }));
    // A worker in another process says it is alive, so runs are queued (nothing here runs them; the test claims them itself).
    stopBeat = startHeartbeat(platform.db);
    app = await buildServer(platform);
    await app.ready();
}, 60_000);

afterAll(async () => {
    stopBeat?.();
    await app?.close();
    platform?.db.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("a verification yields to a person's Run", () => {
    it("Run is accepted while a verification is still queued, and the run is claimed before it", async () => {
        const p = await project("Verify queued");
        const v = await p.verify();
        const run = await call("POST", `/api/tests/${p.testId}/validate`);
        expect(run.status, JSON.stringify(run.body)).toBe(202);
        expect(run.body.status).toBe("QUEUED");
        // The run goes first; the verification is not started next to it.
        expect(claimAll()).toEqual([run.body.jobId]);
        expect(statusOf(v)).toBe("QUEUED");
        finish(run.body.jobId);
        expect(claimAll()).toEqual([v]);
        finish(v);
    });

    it("Run is accepted while a verification is running, and waits queued until it ends", async () => {
        const p = await project("Verify running");
        const v = await p.verify();
        expect(claimAll()).toEqual([v]);
        const run = await call("POST", `/api/tests/${p.testId}/validate`);
        expect(run.status, JSON.stringify(run.body)).toBe(202);
        expect(claimAll()).toEqual([]);
        expect(statusOf(run.body.jobId)).toBe("QUEUED");
        finish(v);
        expect(claimAll()).toEqual([run.body.jobId]);
        finish(run.body.jobId);
    });

    it("a schedule's run is started while a verification holds the project", async () => {
        const p = await project("Verify schedule");
        const v = await p.verify();
        const job = await startScheduledJob(platform.repo, { id: "sched-1", projectId: p.projectId, kind: "validate", createdBy: null, retryFailures: false } as never);
        expect(job.status).toBe("QUEUED");
        expect(claimAll()).toEqual([job.id]);
        finish(job.id);
        expect(claimAll()).toEqual([v]);
        finish(v);
    });

    it("keeps the one-active-job rule for every other job", async () => {
        const p = await project("Other job");
        const other = await platform.repo.createJob(p.projectId, p.appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [p.testId] });
        const run = await call("POST", `/api/tests/${p.testId}/validate`);
        expect(run.status).toBe(409);
        expect(String(run.body.message ?? run.body.error ?? run.body)).toContain(other.id);
        await expect(startScheduledJob(platform.repo, { id: "sched-2", projectId: p.projectId, kind: "validate", createdBy: null, retryFailures: false } as never)).rejects.toThrow(/still/);
        finish(other.id);
    });

    it("two jobs of other projects, or a verification of another project, are still claimed side by side", async () => {
        const a = await project("Side A");
        const b = await project("Side B");
        const va = await a.verify();
        const rb = await call("POST", `/api/tests/${b.testId}/validate`);
        expect(claimAll().sort()).toEqual([va, rb.body.jobId].sort());
        finish(va);
        finish(rb.body.jobId);
    });
});
