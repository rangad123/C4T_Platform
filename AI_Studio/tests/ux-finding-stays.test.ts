/**
 * UXP item 2: a finding stays a finding on every path that runs a test. The security-headers check of a weak application is
 * "Needs review, medium severity" on the first analysis; this file runs the same test again through a manual re-run, a schedule
 * with an immediate retry, a deploy trigger, a runbook step with retries and a named environment, with the repair budget set to
 * one attempt (the setting that used to turn a retried finding into "Validation failed").
 * Runs a browser (the analysis crawls the page): node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/ux-finding-stays.test.ts
 * Ports: weak fixture app 6350.
 */
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { getRunbookServices, type RunbookServices } from "../src/platform/runbook-runner.js";
import { getScheduleServices, type ScheduleServices } from "../src/platform/schedule-services.js";
import { buildServer } from "../src/platform/server.js";
import { getTriggerServices } from "../src/platform/trigger-services.js";
import { Worker } from "../src/platform/worker.js";
import { startChecksApp } from "./fixtures/checks-app.js";

const APP = "http://127.0.0.1:6350";
const children: ChildProcess[] = [];
let platform: Platform;
let svc: ScheduleServices;
let rb: RunbookServices;
let worker: Worker;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let projectId: string;
let headersId: string;

beforeAll(async () => {
    children.push(await startChecksApp(6350, "weak"));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-ux-finding-"));
    // One repair attempt: with the old order a failure that was retried had used it up before it could be called a finding.
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", CONCURRENCY: "3", MAX_REPAIR_ATTEMPTS: "1" }));
    svc = getScheduleServices(platform);
    getTriggerServices(platform, { minGapMs: 50 });
    rb = getRunbookServices(platform, { pollMs: 60, waitUnitMs: 100, heartbeatMs: 400 });
    server = await buildServer(platform);
    worker = new Worker({ ...platform, onJobFinished: svc.onJobFinished }, 100);
    worker.start();
}, 60_000);

afterAll(async () => {
    await rb?.stop();
    await worker?.stop();
    await svc?.flush();
    await server?.close();
    platform?.db.close();
    for (const c of children) c.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body && /^[{[]/.test(res.body) ? JSON.parse(res.body) : res.body } as { status: number; body: any };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FINAL = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];
async function jobDone(jobId: string, timeoutMs = 180_000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const job = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (FINAL.includes(job.status)) return job;
        if (Date.now() > until) throw new Error(`job ${jobId} did not finish`);
        await sleep(250);
    }
}
const headers = async () => (await call("GET", `/api/tests/${headersId}`)).body;
/** Same class and same severity as the first analysis gave. */
async function expectStillAFinding(label: string) {
    const t = await headers();
    expect(t.validationStatus, `${label}: ${t.validationReason}`).toBe("NEEDS_REVIEW");
    expect(t.severity?.severity, label).toBe("medium");
    expect(t.validationReason).toContain("Security check failed");
}

describe("a finding stays a finding", () => {
    it("is Needs review, medium severity, on the first analysis", async () => {
        projectId = (await call("POST", "/api/projects", { name: "Weak shop" })).body.id;
        // This file runs the tests the AI wrote: with the default policy they are drafts and wait for approval (tests/reviews-api.test.ts).
        await call("PUT", `/api/projects/${projectId}/review-policy`, { aiGenerated: false });
        const queued = await call("POST", `/api/projects/${projectId}/test-generation`, { url: APP, maxPages: 3, targets: ["web"] });
        expect(queued.status).toBe(202);
        await jobDone(queued.body.jobId);
        const tests = (await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; title: string }>;
        headersId = tests.find((t) => t.title.startsWith("Browser security headers"))!.id;
        await expectStillAFinding("analysis");
    }, 300_000);

    it("on a manual re-run of the test", async () => {
        const r = await call("POST", `/api/tests/${headersId}/validate`, {});
        expect(r.status).toBe(202);
        await jobDone(r.body.jobId);
        await expectStillAFinding("re-run");
    }, 120_000);

    it("on a schedule that retries a failure straight away (the old order lost it here)", async () => {
        const created = await call("POST", `/api/projects/${projectId}/schedules`, { kind: "validate", cadence: { type: "daily", time: "02:00" }, retryFailures: 1 });
        expect(created.status).toBe(201);
        const run = await call("POST", `/api/projects/${projectId}/schedules/${created.body.id}/run`);
        expect(run.status, JSON.stringify(run.body)).toBeLessThan(300);
        await jobDone(run.body.jobId ?? run.body.job?.id);
        await expectStillAFinding("schedule");
        // The immediate retry really happened, so the test above is about the case it names.
        const executions = (await call("GET", `/api/tests/${headersId}/executions`)).body as Array<{ jobId?: string; attempt: number }>;
        expect(Math.max(...executions.map((e) => e.attempt))).toBeGreaterThanOrEqual(2);
    }, 180_000);

    it("on a deploy trigger", async () => {
        const token = (await call("POST", `/api/projects/${projectId}/triggers`, { label: "CI" })).body.token as string;
        const run = await call("POST", `/api/triggers/${token}/run`, {});
        expect(run.status, JSON.stringify(run.body)).toBeLessThan(300);
        await jobDone(run.body.jobId);
        await expectStillAFinding("trigger");
    }, 180_000);

    it("on a runbook step that retries", async () => {
        const made = await call("POST", `/api/projects/${projectId}/runbooks`, { version: 1, name: "Gate", steps: [{ id: "all", type: "run", scope: "all", retries: 2 }] });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        const started = await call("POST", `/api/projects/${projectId}/runbooks/${made.body.id}/run`);
        expect(started.status).toBe(202);
        for (let i = 0; i < 600; i++) {
            const r = (await call("GET", `/api/projects/${projectId}/runbook-runs/${started.body.runId}`)).body;
            if (r.finished) break;
            await sleep(300);
        }
        await expectStillAFinding("runbook");
    }, 240_000);

    it("in a named environment it is a finding too, with the same severity", async () => {
        expect((await call("POST", `/api/projects/${projectId}/environments`, { name: "staging", baseUrl: APP })).status).toBe(201);
        const run = await call("POST", `/api/projects/${projectId}/environments/staging/runs`, { testIds: [headersId] });
        expect(run.status, JSON.stringify(run.body)).toBe(202);
        await jobDone(run.body.jobId);
        const res = (await call("GET", `/api/projects/${projectId}/environments/staging/results`)).body;
        const mine = res.tests.find((t: any) => t.id === headersId);
        expect(mine.result.status).toBe("finding");
        expect(mine.result.severity.severity).toBe("medium");
    }, 120_000);
});
