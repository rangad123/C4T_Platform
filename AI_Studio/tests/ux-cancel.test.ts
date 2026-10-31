/**
 * UXP item 1: cancelling a run must not rewrite results. A real platform and worker validate six imported API tests under
 * Playwright against a fixture that answers the first two at once and makes the others hang; the run is cancelled while the
 * third waits. The two tests that finished keep their new results, the four that did not run keep their old status, reason and
 * history, the job says how many of each in words made from those facts, and nothing about the cancelled run feeds flakiness.
 * Also the building blocks, run for real: the partial-results reporter of a killed Playwright run, and the summary sentences.
 * Runs a browser engine (Playwright test runner): node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/ux-cancel.test.ts
 * Ports: fixture app 6351.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { markUnfinishedAsNotRun, runScripts, type RunEnv, type ScriptRun } from "../src/engine/validation/runner.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { cancelSummary } from "../src/platform/cancel-summary.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { getScheduleServices, type ScheduleServices } from "../src/platform/schedule-services.js";
import { buildServer } from "../src/platform/server.js";
import { detectFlaky } from "../src/platform/trends.js";
import { Worker } from "../src/platform/worker.js";

const PORT = 6351;
const APP = `http://127.0.0.1:${PORT}`;

let dataDir: string;
let platform: Platform;
let svc: ScheduleServices;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let fixture: http.Server;
/** "easy": everything answers at once with what the tests expect. "hang": see the handler. */
let mode: "easy" | "hang" = "easy";
let slowHits = 0;

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-ux-cancel-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", CONCURRENCY: "1" }));
    svc = getScheduleServices(platform);
    server = await buildServer(platform);
    worker = new Worker({ ...platform, onJobFinished: svc.onJobFinished }, 100);
    worker.start();
    fixture = http.createServer((req, res) => {
        const json = (status: number, body: unknown) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(body)));
        const url = req.url ?? "";
        if (url === "/api/broken") return json(500, { error: "boom" }); // always: a finding
        if (url === "/api/missing") return json(404, { error: "gone" }); // always: a plain failure
        if (mode === "hang" && url.startsWith("/api/fast")) return json(404, { error: "changed" }); // finished tests get a NEW result
        if (mode === "hang" && url.startsWith("/api/slow")) {
            slowHits++; // the third test is waiting on the application: the run can be cancelled now
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

describe("cancel keeps the results of what finished and leaves the rest alone", () => {
    let projectId: string;
    const idOf: Record<string, string> = {};
    const before: Record<string, { status: string; reason: string | null; executions: number }> = {};
    let cancelledJob: any;

    const snapshot = async (id: string) => {
        const t = (await call("GET", `/api/tests/${id}`)).body;
        return { status: t.validationStatus as string, reason: t.validationReason as string | null, executions: (t.executions as unknown[]).length };
    };

    it("sets up six tests with different earlier results", async () => {
        projectId = (await call("POST", "/api/projects", { name: "Cancel shop" })).body.id;
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
        const tests = (await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; title: string }>;
        for (const t of tests) idOf[t.title] = t.id;
        for (const [title] of titles) before[title] = await snapshot(idOf[title]!);
        expect(before["Fast one"]!.status).toBe("VALIDATED");
        expect(before["Slow three"]!.status).toBe("VALIDATED");
        expect(before["Broken five"]!.status).toBe("NEEDS_REVIEW");
        expect(before["Missing six"]!.status).toBe("FAILED_VALIDATION");
    }, 180_000);

    it("a run cancelled while the third test waits: two new results, four tests exactly as they were", async () => {
        mode = "hang";
        slowHits = 0;
        const token = (await call("POST", `/api/projects/${projectId}/triggers`, { label: "CI" })).body.token as string;
        const run = await call("POST", `/api/triggers/${token}/run`, {});
        expect(run.status, JSON.stringify(run.body)).toBe(202);
        const jobId = run.body.jobId as string;
        for (let i = 0; i < 400 && slowHits === 0; i++) await sleep(100);
        expect(slowHits, "the run reached the third test").toBeGreaterThan(0);
        expect((await call("DELETE", `/api/test-generation/${jobId}`)).status).toBe(202);
        cancelledJob = await jobDone(jobId);
        expect(cancelledJob).toMatchObject({ status: "FAILED", error: "Cancelled" });

        // The two that finished have their new result (the application changed under them) ...
        for (const title of ["Fast one", "Fast two"]) {
            const now = await snapshot(idOf[title]!);
            expect(now.status, title).toBe("FAILED_VALIDATION");
            expect(now.executions, title).toBe(before[title]!.executions + 1);
        }
        // ... and the four that did not run are exactly as they were: status, reason, history.
        for (const title of ["Slow three", "Slow four", "Broken five", "Missing six"]) {
            expect(await snapshot(idOf[title]!), title).toEqual(before[title]);
        }
    }, 180_000);

    it("the run says what happened, from the facts", async () => {
        expect(cancelledJob.cancelled).toMatchObject({ planned: 6, ran: 2, notRun: 4 });
        expect(cancelledJob.cancelled.note).toBe("The run was cancelled. 2 of 6 tests had finished and keep their new results. 4 did not run and keep the results they had before.");
        expect(cancelledJob.cancelled.note).not.toMatch(/nothing was changed/i);
        // The same facts reach the run's event list.
        const events = (await call("GET", `/api/test-generation/${cancelledJob.jobId}/events`)).body as Array<{ kind: string; message: string }>;
        expect(events.find((e) => e.kind === "cancel_summary")?.message).toBe(cancelledJob.cancelled.note);
        // The old text is gone from a run that was not cancelled: no `cancelled` block at all.
        const finished = (await call("GET", `/api/projects/${projectId}/jobs`)).body as Array<{ cancelled?: unknown; error: string | null }>;
        expect(finished.filter((j) => j.cancelled).length).toBe(1);
    });

    it("a cancelled run is not a run: no summary, no trend point, and its results never count as unreliable", async () => {
        const summary = await call("GET", `/api/projects/${projectId}/runs/${cancelledJob.jobId}/summary`);
        expect(summary.status).toBe(404);
        // The two new failures sit next to earlier passes of the same script: flaky if they counted. They do not.
        expect(detectFlaky(platform.db, projectId).map((f) => f.title)).not.toContain("Fast one");
        expect(detectFlaky(platform.db, projectId).map((f) => f.title)).not.toContain("Fast two");
    });

    it("a normal run afterwards works as before, and a second cancel before anything started changes nothing", async () => {
        mode = "easy";
        const r = await call("POST", `/api/tests/${idOf["Slow three"]}/validate`, {});
        await jobDone(r.body.jobId);
        expect((await snapshot(idOf["Slow three"]!)).status).toBe("VALIDATED");
        // Cancel a job that has not started: it never touches a test.
        const queued = await platform.repo.createJob(projectId, platform.repo.getLatestApplicationPublic(projectId)!.id as string, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [idOf["Broken five"]!] });
        platform.repo.requestCancel(queued.id);
        expect((await snapshot(idOf["Broken five"]!)).status).toBe("NEEDS_REVIEW");
    }, 120_000);
});

describe("the pieces", () => {
    it("says what a cancel did in plain words, only for a cancelled job", () => {
        const job = (counters: Partial<Record<string, number>>, extra: Record<string, unknown> = {}) => ({ status: "FAILED", error: "Cancelled", options: { mode: "validate" }, counters: { testsGenerated: 0, testsValidated: 0, testsFailedValidation: 0, testsNeedingReview: 0, ...counters }, ...extra }) as never;
        expect(cancelSummary(job({}))?.note).toBe("The run was cancelled before any test started. No test was changed.");
        expect(cancelSummary(job({ testsGenerated: 23 }))?.note).toBe("The run was cancelled before any test ran. All 23 tests keep the result they had before.");
        expect(cancelSummary(job({ testsGenerated: 23, testsValidated: 10, testsFailedValidation: 2, testsNeedingReview: 1 }))).toMatchObject({ planned: 23, ran: 13, notRun: 10 });
        expect(cancelSummary(job({ testsGenerated: 1, testsValidated: 1 }))?.note).toBe("The run was cancelled after all 1 test had finished, so every result is kept.");
        expect(cancelSummary(job({ testsGenerated: 4 }, { options: { mode: "generate" } }))?.note).toBe("The run was cancelled before any test ran. The 4 tests that were created have not been run yet.");
        expect(cancelSummary({ status: "FAILED", error: "No tests could be generated", options: {}, counters: {} } as never)).toBeUndefined();
        expect(cancelSummary({ status: "COMPLETED", error: null, options: {}, counters: {} } as never)).toBeUndefined();
    });

    it("a run that produced nothing after a cancel is not run; one that has steps is kept", () => {
        const base = { durationMs: 0, failedStepIndex: -1, artifacts: [], responses: [] };
        const empty: ScriptRun = { testId: "A", status: "error", error: "x", steps: [], ...base };
        const real: ScriptRun = { testId: "B", status: "failed", steps: [{ index: 0, title: "1. a", status: "failed" }], ...base };
        const controller = new AbortController();
        markUnfinishedAsNotRun([empty, real], controller.signal);
        expect(empty.notRun).toBeUndefined(); // no cancel: a plain error stays an error
        controller.abort();
        markUnfinishedAsNotRun([empty, real], controller.signal);
        expect(empty.notRun).toBe(true);
        expect(real.notRun).toBeUndefined();
    });

    it("a killed Playwright run still reports the tests that had finished", async () => {
        const slowServer = http.createServer((req, res) => {
            if (req.url === "/slow") {
                slowHits++;
                return void res.on("close", () => undefined);
            }
            res.writeHead(200, { "content-type": "application/json" }).end("{}");
        });
        await new Promise<void>((r) => slowServer.listen(6352, "127.0.0.1", r));
        const script = (title: string, p: string) => ({
            testId: title,
            filename: `${title}.spec.ts`,
            content: `import { test, expect } from "@playwright/test";\ntest("${title}", async ({ request }) => {\n    await test.step("1. get ${p}", async () => {\n        const r = await request.get(process.env.BASE_URL + "${p}");\n        expect(r.status()).toBe(200);\n    });\n});\n`,
        });
        const env: RunEnv = { baseUrl: "http://127.0.0.1:6352", headless: true };
        // Scripts must sit inside the repo tree to find @playwright/test: use the platform's own scratch folder, with a folder name of its own.
        const scratch = path.join(loadConfig({ DATA_DIR: dataDir }).scratchDir, "ux-cancel-partial");
        fs.mkdirSync(scratch, { recursive: true });
        const controller = new AbortController();
        try {
            slowHits = 0;
            const running = runScripts(scratch, [script("A-fast", "/fast"), script("B-slow", "/slow"), script("C-later", "/fast")], env, { workers: 1, signal: controller.signal });
            for (let i = 0; i < 600 && slowHits === 0; i++) await sleep(100);
            expect(slowHits).toBeGreaterThan(0);
            controller.abort();
            const runs = await running;
            markUnfinishedAsNotRun(runs, controller.signal);
            expect(runs.map((r) => [r.testId, r.status, r.notRun ?? false])).toEqual([
                ["A-fast", "passed", false],
                ["B-slow", "error", true],
                ["C-later", "error", true],
            ]);
            expect(runs[0]!.steps).toEqual([{ index: 0, title: "1. get /fast", status: "passed", error: undefined }]);
        } finally {
            slowServer.closeAllConnections?.();
            slowServer.close();
            fs.rmSync(scratch, { recursive: true, force: true });
        }
    }, 120_000);
});
