/**
 * UX-A run control, platform side. A real platform and worker run real API tests (Playwright test runner) against a local fixture:
 *  - POST /api/projects/:id/runs starts a run of exactly the chosen tests (and refuses an empty, unknown or second run in words);
 *  - GET /api/projects/:id/runs/:jobId reads a run test by test: failures first, a reason line, counts with denominators, the tests
 *    that did not run when it was stopped, "running" while it goes, and what changed since each test last ran;
 *  - an environment run reads the same way.
 * Runs a browser engine (Playwright test runner): node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/runs-api.test.ts
 * Ports: fixture app 6410.
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

const PORT = 6410;
const APP = `http://127.0.0.1:${PORT}`;

let dataDir: string;
let platform: Platform;
let svc: ScheduleServices;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let fixture: http.Server;
/** "easy": everything answers as the tests expect (except the two that are always wrong). "changed": /api/fast1 breaks and /api/missing works. "hang": see the handler. */
let mode: "easy" | "changed" | "hang" = "easy";
let slowHits = 0;

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-runs-api-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", CONCURRENCY: "1" }));
    svc = getScheduleServices(platform);
    server = await buildServer(platform);
    worker = new Worker({ ...platform, onJobFinished: svc.onJobFinished }, 100);
    worker.start();
    fixture = http.createServer((req, res) => {
        const json = (status: number, body: unknown) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(body)));
        const url = req.url ?? "";
        if (url === "/api/broken") return json(500, { error: "boom" }); // always: a finding
        if (url === "/api/missing") return json(mode === "changed" ? 200 : 404, { error: "gone" }); // wrong until the application changes
        if (mode === "changed" && url.startsWith("/api/fast1")) return json(404, { error: "changed" });
        if (mode === "hang" && url.startsWith("/api/fast")) return json(404, { error: "changed" });
        if (mode === "hang" && url.startsWith("/api/slow")) {
            slowHits++; // the run is waiting on the application: it can be stopped now
            const timer = setTimeout(() => json(200, { ok: true }), 45_000);
            res.on("close", () => clearTimeout(timer));
            return;
        }
        json(200, { ok: true });
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

const call = async (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body && /^[{[]/.test(res.body) ? JSON.parse(res.body) : res.body } as { status: number; body: any };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FINAL = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];
async function jobDone(jobId: string, timeoutMs = 120_000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const job = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (FINAL.includes(job.status)) return job;
        if (Date.now() > until) throw new Error(`job ${jobId} did not finish`);
        await sleep(200);
    }
}
const spec = (title: string, p: string) => ({ title, kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: p }, { action: "assertResponse", check: "status", expected: 200 }] });

describe("run control: start, read and stop a run of chosen tests", () => {
    let projectId: string;
    let otherProject: string;
    const idOf: Record<string, string> = {};
    const detail = async (jobId: string) => (await call("GET", `/api/projects/${projectId}/runs/${jobId}`)).body;
    const snapshot = async (id: string) => {
        const t = (await call("GET", `/api/tests/${id}`)).body;
        return { status: t.validationStatus as string, reason: t.validationReason as string | null, executions: (t.executions as unknown[]).length };
    };

    it("sets up six tests: four passing, one finding, one failing", async () => {
        projectId = (await call("POST", "/api/projects", { name: "Run control shop" })).body.id;
        otherProject = (await call("POST", "/api/projects", { name: "Another shop" })).body.id;
        const titles: Array<[string, string]> = [
            ["Fast one", "/api/fast1"],
            ["Fast two", "/api/fast2"],
            ["Slow three", "/api/slow3"],
            ["Slow four", "/api/slow4"],
            ["Broken five", "/api/broken"],
            ["Missing six", "/api/missing"],
        ];
        const imp = await call("POST", `/api/projects/${projectId}/specs`, { baseUrl: APP, specs: titles.map(([t, p]) => spec(t, p)) });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        await jobDone(imp.body.jobId);
        for (const t of (await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; title: string }>) idOf[t.title] = t.id;
        expect((await snapshot(idOf["Broken five"]!)).status).toBe("NEEDS_REVIEW");
        expect((await snapshot(idOf["Missing six"]!)).status).toBe("FAILED_VALIDATION");
    }, 180_000);

    it("refuses what cannot be run, in words", async () => {
        const unknown = await call("POST", `/api/projects/${projectId}/runs`, { testIds: ["nope"] });
        expect(unknown.status).toBe(400);
        expect(unknown.body.error).toMatch(/Unknown test/);
        expect((await call("POST", `/api/projects/${projectId}/runs`, { testIds: [] })).status).toBe(400);
        expect((await call("POST", `/api/projects/${projectId}/runs`, { testIds: [idOf["Fast one"]], variants: ["netscape"] })).status).toBe(400);
        expect((await call("POST", `/api/projects/${projectId}/runs`, { surprise: true })).status).toBe(400);
        // A test of another project is not a test of this one.
        const foreign = await call("POST", `/api/projects/${otherProject}/runs`, { testIds: [idOf["Fast one"]] });
        expect(foreign.status).toBe(400);
        const empty = await call("POST", `/api/projects/${otherProject}/runs`, {});
        expect(empty.status).toBe(422);
        expect(empty.body.error).toBe("There are no tests to run yet.");
        expect((await call("POST", `/api/projects/nope/runs`, {})).status).toBe(404);
    });

    it("runs exactly the chosen tests and reads them back: failures first, a reason, counts with their denominators", async () => {
        const started = await call("POST", `/api/projects/${projectId}/runs`, { testIds: [idOf["Missing six"], idOf["Broken five"], idOf["Fast one"]] });
        expect(started.status, JSON.stringify(started.body)).toBe(202);
        expect(started.body).toMatchObject({ testCount: 3, skipped: [] });
        // One run at a time, said in words.
        const second = await call("POST", `/api/projects/${projectId}/runs`, { testIds: [idOf["Fast two"]] });
        expect(second.status).toBe(409);
        expect(second.body.error).toMatch(/still/);
        const job = await jobDone(started.body.jobId);
        expect(job.mode).toBe("validate");

        const d = await detail(started.body.jobId);
        expect(d.counts).toEqual({ planned: 3, ran: 3, passed: 1, failed: 1, findings: 1, running: 0, waiting: 0, notRun: 0 });
        expect(d.active).toBe(false);
        expect(d.job.jobId).toBe(started.body.jobId);
        // Failures first, then findings, then passes.
        expect(d.tests.map((t: any) => t.state)).toEqual(["failed", "finding", "passed"]);
        expect(d.tests[0]).toMatchObject({ title: "Missing six", state: "failed" });
        expect(d.tests[0].reason).toBeTruthy();
        expect(d.tests[1]).toMatchObject({ title: "Broken five", state: "finding" });
        expect(d.tests[2]).toMatchObject({ title: "Fast one", state: "passed" });
        expect(d.startedBy).toEqual({ kind: "person" });
        // The tests that were not chosen did not run: no result of theirs is in this run.
        expect(JSON.stringify(d.tests)).not.toContain("Fast two");
        // The same failure is not a surprise: it failed before too.
        expect(d.changes.newlyFailing).toEqual([]);
        expect(d.changes.newlyPassing).toEqual([]);
    }, 180_000);

    it("says what changed since each test last ran", async () => {
        mode = "changed"; // Fast one now breaks, Missing six now works
        const started = await call("POST", `/api/projects/${projectId}/runs`, { testIds: [idOf["Missing six"], idOf["Fast one"], idOf["Fast two"]] });
        expect(started.status, JSON.stringify(started.body)).toBe(202);
        await jobDone(started.body.jobId);
        const d = await detail(started.body.jobId);
        expect(d.changes.newlyFailing.map((c: any) => c.title)).toEqual(["Fast one"]);
        expect(d.changes.newlyFailing[0].reason).toBeTruthy();
        expect(d.changes.newlyPassing.map((c: any) => c.title)).toEqual(["Missing six"]);
        expect(d.changes.comparedWith.at).toBeTruthy();
        expect(d.counts).toMatchObject({ planned: 3, ran: 3, passed: 2, failed: 1 });
        mode = "easy";
    }, 180_000);

    it("a run of every test (no list) reads as 'ran'; another project cannot read it", async () => {
        const started = await call("POST", `/api/projects/${projectId}/runs`, {});
        expect(started.status).toBe(202);
        expect(started.body.testCount).toBe(6);
        await jobDone(started.body.jobId);
        expect((await detail(started.body.jobId)).counts.planned).toBe(6);
        expect((await call("GET", `/api/projects/${otherProject}/runs/${started.body.jobId}`)).status).toBe(404);
        expect((await call("GET", `/api/projects/${projectId}/runs/nope`)).status).toBe(404);
    }, 180_000);

    it("a run that is stopped says which tests ran and which did not, and the others keep their results", async () => {
        // Put everything in a known state first.
        mode = "easy";
        const warm = await call("POST", `/api/projects/${projectId}/runs`, {});
        await jobDone(warm.body.jobId);
        const before: Record<string, Awaited<ReturnType<typeof snapshot>>> = {};
        for (const [title, id] of Object.entries(idOf)) before[title] = await snapshot(id);

        mode = "hang";
        slowHits = 0;
        const started = await call("POST", `/api/projects/${projectId}/runs`, {});
        expect(started.status).toBe(202);
        for (let i = 0; i < 400 && slowHits === 0; i++) await sleep(100);
        expect(slowHits, "the run reached a slow test").toBeGreaterThan(0);

        // While it goes: tests are running (no result yet), counted as such, and the answer says the run is active.
        const mid = await detail(started.body.jobId);
        expect(mid.active).toBe(true);
        expect(mid.counts.planned).toBe(6);
        expect(mid.counts.running + mid.counts.ran).toBe(6);
        expect(mid.counts.running).toBeGreaterThan(0);

        expect((await call("DELETE", `/api/test-generation/${started.body.jobId}`)).status).toBe(202);
        const stopped = await jobDone(started.body.jobId);
        expect(stopped).toMatchObject({ status: "FAILED", error: "Cancelled" });
        const d = await detail(started.body.jobId);
        expect(d.active).toBe(false);
        expect(d.counts.planned).toBe(6);
        expect(d.counts.ran).toBe(stopped.cancelled.ran);
        expect(d.counts.notRun).toBe(stopped.cancelled.notRun);
        expect(d.counts.notRun).toBeGreaterThan(0);
        expect(d.counts.running + d.counts.waiting).toBe(0);
        // Tests that did not run are said so, last in the list, and exactly as they were.
        const notRun = d.tests.filter((t: any) => t.state === "not_run");
        expect(notRun.length).toBe(d.counts.notRun);
        for (const t of notRun) expect(await snapshot(t.id), t.title).toEqual(before[t.title]);
        mode = "easy";
    }, 240_000);

    it("an environment run reads test by test too", async () => {
        const env = await call("POST", `/api/projects/${projectId}/environments`, { name: "staging", baseUrl: APP });
        expect(env.status, JSON.stringify(env.body)).toBe(201);
        const started = await call("POST", `/api/projects/${projectId}/environments/staging/runs`, { testIds: [idOf["Fast one"], idOf["Missing six"]] });
        expect(started.status, JSON.stringify(started.body)).toBe(202);
        await jobDone(started.body.jobId);
        const d = await detail(started.body.jobId);
        expect(d.mode).toBe("environment");
        expect(d.job.environment).toBe("staging");
        expect(d.counts).toMatchObject({ planned: 2, ran: 2, passed: 1, failed: 1 });
        expect(d.tests[0]).toMatchObject({ title: "Missing six", state: "failed" });
        // An environment run never says "since the last run": its results are kept apart from the test's own.
        expect(d.changes).toBeNull();
    }, 180_000);
});
