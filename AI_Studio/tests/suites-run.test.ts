/**
 * A suite run for real: a platform and its worker run API tests (Playwright test runner) against a local fixture, in the suite's
 * order. With "stop at the first failure" the test after the failing one is not run and keeps what it had; without it every test runs.
 * Runs a browser engine (Playwright test runner): node scripts/with-lock.mjs browser -- npx vitest run tests/suites-run.test.ts
 * Ports: fixture app 7727.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { ReviewStore } from "../src/platform/review-store.js";
import { getScheduleServices, type ScheduleServices } from "../src/platform/schedule-services.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const PORT = 7727;
const APP = `http://127.0.0.1:${PORT}`;

let dataDir: string;
let platform: Platform;
let svc: ScheduleServices;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let fixture: http.Server;
let broken = false;
const hits: string[] = [];

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "suites-run-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "suites-run-secret-key-0123456789", CONCURRENCY: "2", SCHEDULER_ENABLED: "false" }));
    svc = getScheduleServices(platform);
    server = await buildServer(platform);
    worker = new Worker({ ...platform, onJobFinished: svc.onJobFinished }, 100);
    worker.start();
    fixture = http.createServer((req, res) => {
        const url = req.url ?? "";
        hits.push(url);
        const status = broken && url.startsWith("/api/second") ? 404 : 200;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: status === 200 }));
    });
    await new Promise<void>((r) => fixture.listen(PORT, "127.0.0.1", r));
}, 30_000);

afterAll(async () => {
    await worker?.stop();
    await svc?.flush();
    await server?.close();
    fixture?.closeAllConnections?.();
    fixture?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = async (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body && /^[{[]/.test(res.body) ? JSON.parse(res.body) : res.body } as { status: number; body: any };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function jobDone(jobId: string, timeoutMs = 150_000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const job = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) return job;
        if (Date.now() > until) throw new Error(`job ${jobId} did not finish`);
        await sleep(250);
    }
}
const spec = (title: string, p: string) => ({ title, kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: p }, { action: "assertResponse", check: "status", expected: 200 }] });

describe("a suite run, for real", () => {
    let projectId: string;
    let suiteId: string;
    const idOf: Record<string, string> = {};
    const status = async (title: string) => (await call("GET", `/api/tests/${idOf[title]}`)).body as { validationStatus: string; executions: unknown[] };

    it("sets up three passing tests and a suite of them in a chosen order", async () => {
        projectId = (await call("POST", "/api/projects", { name: "Suite shop" })).body.id;
        // Every change counts as approved here (the review policy), so the imported tests run.
        new ReviewStore(platform.db).setPolicy(projectId, { aiGenerated: false, edits: false, healing: false }, "test");
        const imp = await call("POST", `/api/projects/${projectId}/specs`, { baseUrl: APP, specs: [spec("First", "/api/first"), spec("Second", "/api/second"), spec("Third", "/api/third")] });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        const imported = await jobDone(imp.body.jobId);
        for (const t of (await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; title: string }>) idOf[t.title] = t.id;
        expect((await status("Third")).validationStatus, JSON.stringify(imported)).toBe("VALIDATED");
        const made = await call("POST", `/api/projects/${projectId}/test-suites`, { name: "Checkout", testIds: [idOf["First"], idOf["Second"], idOf["Third"]], settings: { stopOnFirstFailure: true } });
        expect(made.status).toBe(201);
        suiteId = made.body.id;
    }, 180_000);

    it("stops at the first failure: the test after it is not run and keeps what it had", async () => {
        broken = true;
        const before = (await status("Third")).executions.length;
        hits.length = 0;
        const r = await call("POST", `/api/projects/${projectId}/test-suites/${suiteId}/run`, {});
        expect(r.status, JSON.stringify(r.body)).toBe(202);
        const job = await jobDone(r.body.jobId);
        expect((await status("First")).validationStatus).toBe("VALIDATED");
        expect((await status("Second")).validationStatus).toBe("FAILED_VALIDATION");
        const third = await status("Third");
        expect(third.validationStatus).toBe("VALIDATED");
        expect(third.executions.length).toBe(before);
        expect(hits.some((h) => h.startsWith("/api/third"))).toBe(false);
        // In order: the first test was called before the second.
        expect(hits.findIndex((h) => h.startsWith("/api/first"))).toBeLessThan(hits.findIndex((h) => h.startsWith("/api/second")));
        const events = (await call("GET", `/api/test-generation/${job.jobId ?? r.body.jobId}/events`)).body as Array<{ kind: string; message: string }> | { events: Array<{ kind: string; message: string }> };
        const list = Array.isArray(events) ? events : events.events;
        expect(list.find((e) => e.kind === "stopped_on_failure")?.message).toMatch(/Stopped at the first failure \(API-\d+\): 1 test\(s\) after it were not run/);
        // The suite page shows the run with what came of it.
        const runs = (await call("GET", `/api/projects/${projectId}/test-suites/${suiteId}`)).body.runs;
        expect(runs[0]).toMatchObject({ jobId: r.body.jobId, trigger: "manual", testCount: 3 });
        expect(runs[0].job.counters).toMatchObject({ testsValidated: 1, testsFailedValidation: 1 });
    }, 180_000);

    it("without stopping, every test runs", async () => {
        expect((await call("PATCH", `/api/projects/${projectId}/test-suites/${suiteId}`, { settings: { stopOnFirstFailure: false } })).status).toBe(200);
        hits.length = 0;
        const r = await call("POST", `/api/projects/${projectId}/test-suites/${suiteId}/run`, {});
        await jobDone(r.body.jobId);
        expect(hits.some((h) => h.startsWith("/api/third"))).toBe(true);
        expect((await status("Second")).validationStatus).toBe("FAILED_VALIDATION");
        expect((await status("Third")).validationStatus).toBe("VALIDATED");
    }, 180_000);
});
