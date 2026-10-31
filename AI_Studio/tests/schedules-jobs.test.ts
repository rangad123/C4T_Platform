/**
 * Scheduled runs end to end with real work: a schedule fires on an injected clock, the real worker validates
 * the project's tests under Playwright against a fixture endpoint that misbehaves on demand, and the results
 * flow into run summaries, flaky detection, trends and alerts delivered to a local fake receiver.
 * Runs a browser: use `node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/schedules-jobs.test.ts`.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { getScheduleServices, type ScheduleServices } from "../src/platform/schedule-services.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const RECEIVER_PORT = 5250;
const FIXTURE_PORT = 5251;
const FIXTURE = `http://127.0.0.1:${FIXTURE_PORT}`;

let dataDir: string;
let platform: Platform;
let svc: ScheduleServices;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let fixture: http.Server;
let receiver: http.Server;
let clockNow = Date.now();

/** How /api/flip behaves: always fine, failing on every other call (starting with a failure), or down. */
let flip: "ok" | "alternate" | "down" = "ok";
let flipCalls = 0;
const received: any[] = [];

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-schedjobs-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", CONCURRENCY: "2", PUBLIC_URL: "https://qa.example.test" }));
    svc = getScheduleServices(platform, { clock: () => clockNow, delivery: { backoffMs: [20, 20], timeoutMs: 2_000 } });
    server = await buildServer(platform);
    worker = new Worker({ ...platform, onJobFinished: svc.onJobFinished }, 100);
    worker.start();

    fixture = http.createServer((req, res) => {
        const json = (status: number, body: unknown) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(body)));
        if (req.url === "/api/stable") return json(200, { ok: true });
        if (req.url === "/api/flip") {
            const n = ++flipCalls;
            const fail = flip === "down" || (flip === "alternate" && n % 2 === 1);
            return fail ? json(500, { error: "boom" }) : json(200, { ok: true });
        }
        json(404, { error: "not found" });
    });
    receiver = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            res.writeHead(200).end("ok");
        });
    });
    await Promise.all([new Promise<void>((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r)), new Promise<void>((r) => receiver.listen(RECEIVER_PORT, "127.0.0.1", r))]);
}, 30_000);

afterAll(async () => {
    await svc?.scheduler.stop();
    await worker?.stop();
    await server?.close();
    fixture?.close();
    receiver?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until the job is finished AND the worker hook has stored its run summary. */
async function finished(projectId: string, jobId: string) {
    for (let i = 0; i < 400; i++) {
        const job = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) {
            const s = await call("GET", `/api/projects/${projectId}/runs/${jobId}/summary`);
            if (s.status === 200) return { job, summary: s.body };
        }
        await sleep(300);
    }
    throw new Error(`job ${jobId} did not finish`);
}

const spec = (title: string, path: string) => ({ title, kind: "api", category: "API", steps: [{ action: "request", method: "GET", path }, { action: "assertResponse", check: "status", expected: 200 }] });

describe("scheduled re-runs with real validation", () => {
    let projectId: string;
    let scheduleId: string;
    let flipTestId: string;

    it("imports two tests and validates them once (the baseline)", async () => {
        projectId = (await call("POST", "/api/projects", { name: "Scheduled shop" })).body.id;
        const imp = await call("POST", `/api/projects/${projectId}/specs`, { baseUrl: FIXTURE, specs: [spec("Stable endpoint answers", "/api/stable"), spec("Flip endpoint answers", "/api/flip")] });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        const { job, summary } = await finished(projectId, imp.body.jobId);
        expect(job.status).toBe("COMPLETED");
        expect(summary).toMatchObject({ total: 2, validated: 2, failed: 0, needsReview: 0, flaky: 0, passRate: 100, trigger: "manual" });
        flipTestId = (await call("GET", `/api/projects/${projectId}/tests`)).body.find((t: any) => t.title.startsWith("Flip")).id;

        // Alerts go to the local receiver
        const ch = await call("POST", `/api/projects/${projectId}/alert-channels`, { kind: "webhook", url: `http://127.0.0.1:${RECEIVER_PORT}/alerts` });
        expect(ch.status).toBe(201);
        expect(received).toHaveLength(0);
    }, 120_000);

    it("a due schedule starts a labelled job that re-runs everything; a failure that passes on the immediate re-run is a flaky pass, not a regression", async () => {
        const created = await call("POST", `/api/projects/${projectId}/schedules`, { kind: "validate", cadence: { type: "daily", time: "02:00" }, retryFailures: 1 });
        expect(created.status).toBe(201);
        scheduleId = created.body.id;

        flip = "alternate";
        flipCalls = 0; // the next call to /api/flip fails, the one after passes
        clockNow = new Date(created.body.nextRunAt).getTime() + 5_000;
        const ticked = await svc.scheduler.tick();
        expect(ticked.map((t) => t.result)).toEqual(["started"]);

        const { job, summary } = await finished(projectId, ticked[0]!.jobId!);
        expect(job).toMatchObject({ status: "COMPLETED", mode: "validate", trigger: "schedule", scheduleId });
        expect(summary).toMatchObject({ total: 2, validated: 2, flaky: 1, passRate: 100, trigger: "schedule", scheduleId });
        expect(summary.diff.flakyPasses.map((c: any) => c.key)).toHaveLength(1);
        expect(summary.diff.newlyFailing).toEqual([]);

        // The flip test really ran twice: it failed, then passed on the immediate re-run
        const execs = (await call("GET", `/api/tests/${flipTestId}/executions`)).body as any[];
        const thisJob = execs.filter((e) => e.startedAt >= job.createdAt).sort((a, b) => a.attempt - b.attempt);
        expect(thisJob.map((e) => [e.attempt, e.status])).toEqual([[1, "failed"], [2, "passed"]]);
        expect((await call("GET", `/api/projects/${projectId}/jobs`)).body[0]).toMatchObject({ jobId: job.jobId, trigger: "schedule" });

        // It is listed as flaky with its evidence
        const flaky = (await call("GET", `/api/projects/${projectId}/flaky`)).body.tests;
        expect(flaky).toHaveLength(1);
        expect(flaky[0]).toMatchObject({ id: flipTestId, flakyPasses: 1, executions: 3, flips: 2, lastStatus: "passed" });

        // The alert says "flaky", and nothing about a regression or failure
        await svc.flush();
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({ event: "flaky", events: ["flaky"], project: { name: "Scheduled shop" }, newlyFailing: [], run: { trigger: "schedule", passed: 2, total: 2 } });

        // The schedule remembers its run and moved on to the next day
        const sch = (await call("GET", `/api/projects/${projectId}/schedules`)).body.schedules[0];
        expect(sch).toMatchObject({ lastJobId: job.jobId, lastOutcome: "started" });
        expect(new Date(sch.nextRunAt).getTime()).toBeGreaterThan(clockNow);
    }, 180_000);

    it("a real failure (still failing on the re-run) is reported once as a regression and run failure", async () => {
        flip = "down";
        const run = await call("POST", `/api/projects/${projectId}/schedules/${scheduleId}/run`);
        expect(run.status).toBe(202);
        const { job, summary } = await finished(projectId, run.body.jobId);
        expect(job.status).toBe("PARTIALLY_COMPLETED");
        expect(summary).toMatchObject({ total: 2, validated: 1, needsReview: 1, flaky: 0, passRate: 50 });
        expect(summary.diff.newlyFailing.map((c: any) => c.key)).toHaveLength(1);
        expect(summary.diff.newFindings[0]).toMatchObject({ severity: "high" });

        const execs = ((await call("GET", `/api/tests/${flipTestId}/executions`)).body as any[]).filter((e) => e.startedAt >= job.createdAt);
        expect(execs.map((e) => e.status)).toEqual(["failed", "failed"]); // retried once, failed again

        await svc.flush();
        expect(received).toHaveLength(2);
        expect(received[1]).toMatchObject({ event: "regression", events: expect.arrayContaining(["regression", "run_failed"]), run: { passed: 1, needsReview: 1, total: 2 } });
        expect(received[1].newlyFailing[0].reason).toMatch(/Server error/);
        expect(received[1].link).toBe(`https://qa.example.test/#/projects/${projectId}`);
    }, 180_000);

    it("the same failure on the next run is not announced again; the fix is announced once", async () => {
        const again = await call("POST", `/api/projects/${projectId}/schedules/${scheduleId}/run`);
        const second = await finished(projectId, again.body.jobId);
        expect(second.summary.diff.stillFailing).toHaveLength(1);
        expect(second.summary.diff.newlyFailing).toEqual([]);
        await svc.flush();
        expect(received).toHaveLength(2);

        flip = "ok";
        const fix = await call("POST", `/api/projects/${projectId}/schedules/${scheduleId}/run`);
        const third = await finished(projectId, fix.body.jobId);
        expect(third.job.status).toBe("COMPLETED");
        expect(third.summary.diff.fixed).toHaveLength(1);
        await svc.flush();
        expect(received).toHaveLength(3);
        expect(received[2]).toMatchObject({ event: "recovered", run: { passed: 2, total: 2 } });

        const log = (await call("GET", `/api/projects/${projectId}/alert-log`)).body as any[];
        expect(log.map((l) => [l.event, l.status])).toEqual([["recovered", "sent"], ["regression,run_failed", "sent"], ["flaky", "sent"]]);
    }, 180_000);

    it("trends show every run with its pass rate and counts", async () => {
        const t = (await call("GET", `/api/projects/${projectId}/trends?days=7`)).body;
        expect(t.runs.map((r: any) => r.passRate)).toEqual([100, 100, 50, 50, 100]);
        expect(t.runs.map((r: any) => r.trigger)).toEqual(["manual", "schedule", "schedule", "schedule", "schedule"]);
        expect(t.runs[2]).toMatchObject({ total: 2, validated: 1, needsReview: 1, failed: 0 });
        expect(t.runs.every((r: any) => r.durationMs > 0)).toBe(true);
        expect(t.summary).toMatchObject({ runs: 5, firstPassRate: 100, latestPassRate: 100, passRateDelta: 0, averagePassRate: 80 });
    });
});
