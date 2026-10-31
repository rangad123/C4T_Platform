/**
 * Runbooks end to end with real work: a real platform, the real worker validating imported tests under Playwright against a fixture
 * app that can be broken on demand, a local alert receiver, schedules and deploy tokens that start runbooks, caps and cancels.
 * Runs a browser: node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/runbook.test.ts
 * Ports: fixture app 5690, alert receiver 5691, 5699 is left closed on purpose.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { getRunbookServices, type RunbookServices } from "../src/platform/runbook-runner.js";
import { getScheduleServices, type ScheduleServices } from "../src/platform/schedule-services.js";
import { buildServer } from "../src/platform/server.js";
import { getTriggerServices } from "../src/platform/trigger-services.js";
import { Worker } from "../src/platform/worker.js";

const API_KEY = "test-api-key-runbooks-0123";
const FIXTURE_PORT = 5690;
const RECEIVER_PORT = 5691;
const DEAD_PORT = 5699;
const FIXTURE = `http://127.0.0.1:${FIXTURE_PORT}`;
const HOOK = `http://127.0.0.1:${RECEIVER_PORT}/hook/very-secret-runbook-token`;

let dataDir: string;
let dataDir2: string;
let platform: Platform;
let svc: ScheduleServices;
let rb: RunbookServices;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let fixture: http.Server;
let receiver: http.Server;
let clockNow = Date.now();

/** What the fixture app does on demand. */
let toggle: "ok" | "fail" = "ok";
let flakyMode: "ok" | "alternate" = "ok";
let flakyCalls = 0;
let slowMs = 6000;
const received: any[] = [];

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-runbook-"));
    dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-runbook2-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", API_KEY, CONCURRENCY: "2", PUBLIC_URL: "https://qa.example.test" }));
    // Injected before the server is built, like the other features' tests: quick polls, short "seconds", fast alert retries.
    svc = getScheduleServices(platform, { clock: () => clockNow, delivery: { backoffMs: [20, 20], timeoutMs: 2_000 } });
    getTriggerServices(platform, { minGapMs: 50 });
    rb = getRunbookServices(platform, { pollMs: 60, waitUnitMs: 100, heartbeatMs: 400 });
    server = await buildServer(platform);
    worker = new Worker({ ...platform, onJobFinished: svc.onJobFinished }, 100);
    worker.start();

    fixture = http.createServer((req, res) => {
        const json = (status: number, body: unknown) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(body)));
        if (req.url === "/api/ok" || req.url === "/api/ok2") return json(200, { ok: true });
        if (req.url === "/api/toggle") return toggle === "fail" ? json(500, { error: "boom" }) : json(200, { ok: true });
        if (req.url === "/api/flaky") {
            const fail = flakyMode === "alternate" && ++flakyCalls % 2 === 1;
            return fail ? json(500, { error: "boom" }) : json(200, { ok: true });
        }
        if (req.url === "/api/slow") {
            const timer = setTimeout(() => json(200, { ok: true }), slowMs);
            res.on("close", () => clearTimeout(timer));
            return;
        }
        json(404, { error: "not found" });
    });
    receiver = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            received.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
            res.writeHead(200).end("ok");
        });
    });
    await Promise.all([new Promise<void>((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r)), new Promise<void>((r) => receiver.listen(RECEIVER_PORT, "127.0.0.1", r))]);
}, 30_000);

afterAll(async () => {
    await rb?.stop();
    await worker?.stop();
    await svc?.flush();
    await server?.close();
    fixture?.close();
    receiver?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(dataDir2, { recursive: true, force: true });
});

const call = async (method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH", url: string, payload?: unknown, key = true) => {
    const res = await server.inject({ method, url, payload: payload as never, headers: key ? { "x-api-key": API_KEY } : {} });
    return { status: res.statusCode, body: res.body && /^[{[]/.test(res.body) ? JSON.parse(res.body) : res.body } as { status: number; body: any };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FINAL = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];

async function jobDone(jobId: string, timeoutMs = 90_000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const job = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (FINAL.includes(job.status)) return job;
        if (Date.now() > until) throw new Error(`job ${jobId} did not finish`);
        await sleep(200);
    }
}

async function idle(projectId: string, timeoutMs = 90_000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const jobs = (await call("GET", `/api/projects/${projectId}/jobs`)).body as Array<{ status: string }>;
        if (jobs.every((j) => FINAL.includes(j.status))) return;
        if (Date.now() > until) throw new Error("project never became idle");
        await sleep(250);
    }
}

async function getRun(projectId: string, runId: string) {
    return (await call("GET", `/api/projects/${projectId}/runbook-runs/${runId}`)).body;
}

async function runDone(projectId: string, runId: string, timeoutMs = 120_000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const run = await getRun(projectId, runId);
        if (run.finished) return run;
        if (Date.now() > until) throw new Error(`run ${runId} did not finish: ${JSON.stringify(run.steps?.map((s: any) => s.status))}`);
        await sleep(150);
    }
}

const spec = (title: string, path: string, tags: string[] = []) => ({ title, kind: "api", category: "API", tags, steps: [{ action: "request", method: "GET", path }, { action: "assertResponse", check: "status", expected: 200 }] });
const run = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "run", scope: "all", ...extra });
const def = (name: string, steps: unknown[]) => ({ version: 1, name, steps });
const createRunbook = async (projectId: string, definition: unknown) => {
    const r = await call("POST", `/api/projects/${projectId}/runbooks`, definition);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as string;
};
const start = (projectId: string, rid: string) => call("POST", `/api/projects/${projectId}/runbooks/${rid}/run`);
const startAndWait = async (projectId: string, rid: string) => {
    const s = await start(projectId, rid);
    expect(s.status, JSON.stringify(s.body)).toBe(202);
    return runDone(projectId, s.body.runId);
};
const statuses = (r: any) => r.steps.map((s: any) => s.status);

let projectA: string;
let channelId: string;
const testId: Record<string, string> = {};

describe("definitions through the API", () => {
    it("every runbook route is behind the API key", async () => {
        projectA = (await call("POST", "/api/projects", { name: "Shop" })).body.id;
        expect((await call("GET", `/api/projects/${projectA}/runbooks`, undefined, false)).status).toBe(401);
        expect((await call("POST", `/api/projects/${projectA}/runbooks`, def("x", [run("a")]), false)).status).toBe(401);
        const list = await call("GET", `/api/projects/${projectA}/runbooks`);
        expect(list.status).toBe(200);
        expect(list.body.runbooks).toEqual([]);
        expect(list.body.limits).toMatchObject({ maxSteps: 12, maxWaitSeconds: 300, maxNameLength: 80 });
        expect(list.body.templates.map((t: any) => t.id)).toEqual(["smoke-then-full", "release-gate", "nightly-with-alert"]);
    });

    it("rejects what could never run, with the reason in plain words", async () => {
        const post = (d: unknown) => call("POST", `/api/projects/${projectA}/runbooks`, d);
        const loop = await post(def("Loop", [run("a"), run("b", { onFail: "a" })]));
        expect(loop.status).toBe(400);
        expect(loop.body.error).toMatch(/comes before this step.*never loop/);
        expect((await post(def("Forward", [run("a", { onFail: "zzz" })]))).body.error).toMatch(/no step with the id “zzz”/);
        expect((await post(def("Placeholder", [{ id: "n", type: "notify", channelId: "x", message: "Hi {{user}}" }]))).body.error).toMatch(/not a placeholder you can use/);
        expect((await post(def("Many", Array.from({ length: 13 }, (_, i) => run(`s${i}`))))).body.error).toMatch(/up to 12 steps/);
        expect((await post(def("N".repeat(81), [run("a")]))).body.error).toMatch(/up to 80 characters/);
        expect((await post(def("Wait", [{ id: "w", type: "wait", seconds: 301 }]))).status).toBe(400);
        expect((await post({ version: 1, name: "No steps", steps: [] })).body.error).toMatch(/at least one step/);
        expect((await post(def("Ghost channel", [{ id: "n", type: "notify", channelId: "no-such-channel", message: "hi" }]))).body.error).toMatch(/no alert channel/);
        expect((await post(def("Ghost env", [run("a", { environment: "qa" })]))).body.error).toMatch(/no environment called “qa”/);
        expect((await call("GET", `/api/projects/${projectA}/runbooks`)).body.runbooks).toEqual([]);
    });
});

describe("the project and its tests", () => {
    it("imports the tests the runbooks run (one tagged smoke) and validates them", async () => {
        const imp = await call("POST", `/api/projects/${projectA}/specs`, { baseUrl: FIXTURE, specs: [spec("Smoke: toggle endpoint", "/api/toggle", ["smoke"]), spec("Ok endpoint", "/api/ok"), spec("Second ok endpoint", "/api/ok2"), spec("Flaky endpoint", "/api/flaky")] });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        expect((await jobDone(imp.body.jobId)).status).toBe("COMPLETED");
        for (const t of (await call("GET", `/api/projects/${projectA}/tests`)).body) testId[t.title] = t.id;
        expect(Object.keys(testId)).toHaveLength(4);
        const ch = await call("POST", `/api/projects/${projectA}/alert-channels`, { kind: "webhook", url: HOOK, name: "Team hook" });
        expect(ch.status).toBe(201);
        channelId = ch.body.id;
    }, 180_000);
});

describe("run smoke, check, run everything, tell the team", () => {
    let rid: string;
    it("executes the real jobs in order and records each step", async () => {
        rid = await createRunbook(
            projectA,
            def("Release gate", [
                run("smoke", { title: "Run the smoke tests", scope: { tag: "smoke" } }),
                { id: "rate", type: "condition", condition: { check: "passRate", atLeast: 100 } },
                run("everything", { title: "Run all tests" }),
                { id: "tell", type: "notify", channelId, message: "{{project}}: the run {{status}}. {{passRate}} passed, {{failed}} failing. {{runUrl}}" },
            ]),
        );
        const done = await startAndWait(projectA, rid);
        expect(done).toMatchObject({ status: "passed", passed: true, finished: true, trigger: "manual", reason: "All steps finished." });
        expect(statuses(done)).toEqual(["passed", "passed", "passed", "passed"]);
        const [smoke, rate, everything, tell] = done.steps;
        expect(smoke.title).toBe("Run the smoke tests");
        expect(rate).toMatchObject({ jobId: null, measured: "100% passed (1 of 1)" });
        expect(tell.reason).toMatch(/Sent to “Team hook”/);

        // Two different real jobs, the first only for the smoke test, the second for everything, one after the other.
        expect(smoke.jobId).toBeTruthy();
        expect(everything.jobId).toBeTruthy();
        expect(everything.jobId).not.toBe(smoke.jobId);
        const j1 = (await call("GET", `/api/test-generation/${smoke.jobId}`)).body;
        const j2 = (await call("GET", `/api/test-generation/${everything.jobId}`)).body;
        expect(j1).toMatchObject({ mode: "validate", status: "COMPLETED", runbookRunId: done.runId, trigger: "manual", testsGenerated: 1, testsValidated: 1 });
        expect(j2).toMatchObject({ mode: "validate", status: "COMPLETED", runbookRunId: done.runId, testsGenerated: 4, testsValidated: 4 });
        expect(new Date(j2.createdAt).getTime()).toBeGreaterThanOrEqual(new Date(j1.finishedAt).getTime());
        expect(smoke.detail).toMatchObject({ total: 1, passed: 1, failed: 0, passRate: 100 });

        // The message went to the receiver with the template filled in, and a link back to the run.
        await svc.flush();
        const msg = received.filter((m) => m.body.event === "runbook").at(-1);
        expect(msg.path).toBe("/hook/very-secret-runbook-token");
        expect(msg.body.summary).toBe(`Shop: the run passed. 100% passed, 0 failing. https://qa.example.test/#/projects/${projectA}/schedule?run=${done.runId}`);
        expect(msg.body.runbook).toMatchObject({ name: "Release gate", status: "passed", runId: done.runId });
        expect(msg.body.project).toMatchObject({ name: "Shop" });
    }, 240_000);

    it("lists the run with its steps, shows it as the last run, and never shows the channel's address", async () => {
        const runs = (await call("GET", `/api/projects/${projectA}/runbooks/${rid}/runs`)).body.runs;
        expect(runs).toHaveLength(1);
        expect(runs[0].ticks).toEqual(["passed", "passed", "passed", "passed"]);
        const detail = (await call("GET", `/api/projects/${projectA}/runbooks/${rid}/runs/${runs[0].runId}`)).body;
        expect(detail.steps).toHaveLength(4);
        const one = (await call("GET", `/api/projects/${projectA}/runbooks/${rid}`)).body;
        expect(one.lastRun).toMatchObject({ status: "passed", ticks: ["passed", "passed", "passed", "passed"] });
        expect(one.titles).toEqual(["Run the smoke tests", "Check that at least 100% passed", "Run all tests", "Tell the team"]);
        expect(JSON.stringify([runs, detail, one, (await call("GET", `/api/projects/${projectA}/alert-channels`)).body])).not.toContain("very-secret-runbook-token");
        // The run is also found by another project's id? No.
        const other = (await call("POST", "/api/projects", { name: "Other" })).body.id;
        expect((await call("GET", `/api/projects/${other}/runbook-runs/${detail.runId}`)).status).toBe(404);
        expect((await call("GET", `/api/projects/${other}/runbooks/${rid}`)).status).toBe(404);
    });
});

describe("a failing step routes to the message and stops", () => {
    it("failing smoke tests skip the full run, tell the team and end as stopped", async () => {
        const before = received.length;
        const rid = await createRunbook(
            projectA,
            def("Smoke first", [
                run("smoke", { scope: { tag: "smoke" }, retries: 0, onFail: "tell" }),
                run("everything"),
                { id: "tell", type: "notify", channelId, message: "{{project}} {{status}}: {{passRate}} passed, {{failed}} failing", onPass: "stop" },
            ]),
        );
        toggle = "fail";
        const done = await startAndWait(projectA, rid);
        toggle = "ok";
        expect(done).toMatchObject({ status: "stopped", passed: false });
        expect(done.reason).toMatch(/^Stopped after “.+” failed: 0 of 1 test passed; 1 failed or need review\.$/);
        expect(statuses(done)).toEqual(["failed", "skipped", "passed"]);
        expect(done.steps[0].reason).toMatch(/0 of 1 test passed; 1 failed or need review/);
        expect(done.steps[1].reason).toMatch(/Skipped: the run went from/);
        // Only the smoke job was started: the full run never happened.
        const jobs = ((await call("GET", `/api/projects/${projectA}/jobs`)).body as any[]).filter((j) => j.runbookRunId === done.runId);
        expect(jobs).toHaveLength(1);
        await svc.flush();
        const msgs = received.slice(before).filter((m) => m.body.event === "runbook");
        expect(msgs).toHaveLength(1);
        expect(msgs[0].body.summary).toBe("Shop failed: 0% passed, 1 failing");
        await idle(projectA);
    }, 240_000);

    it("the default after a failure is to stop; a failure routed around still makes the run failed", async () => {
        toggle = "fail";
        const stopDefault = await startAndWait(projectA, await createRunbook(projectA, def("Stops by default", [run("smoke", { scope: { tag: "smoke" }, retries: 0 }), { id: "w", type: "wait", seconds: 1 }])));
        expect(stopDefault).toMatchObject({ status: "stopped" });
        expect(statuses(stopDefault)).toEqual(["failed", "skipped"]);
        const routed = await startAndWait(projectA, await createRunbook(projectA, def("Carries on", [run("smoke", { scope: { tag: "smoke" }, retries: 0, onFail: "next" }), { id: "w", type: "wait", seconds: 1 }])));
        toggle = "ok";
        expect(routed).toMatchObject({ status: "failed", passed: false });
        expect(routed.reason).toMatch(/^Finished, but “/);
        expect(statuses(routed)).toEqual(["failed", "passed"]);
        await idle(projectA);
    }, 240_000);
});

describe("checks on a real run", () => {
    it("pass rate, no failures, no high severity, no API change and readiness are measured from the run", async () => {
        const done = await startAndWait(
            projectA,
            await createRunbook(projectA, def("Checks", [run("all", { retries: 0 }), ...(["noFailures", "noHighSeverity", "noApiBreakingChange", "readiness"] as const).map((check) => ({ id: check.toLowerCase(), type: "condition", condition: { check }, onFail: "next" }))])),
        );
        const [, noFailures, noHigh, noApi, readiness] = done.steps;
        expect(noFailures).toMatchObject({ status: "passed", measured: "no failing tests" });
        expect(noHigh).toMatchObject({ status: "passed", measured: "no high-severity findings" });
        expect(noApi.status).toBe("passed");
        expect(noApi.measured).toMatch(/no breaking API changes|nothing to compare yet/);
        // The project's readiness is the dashboard's own answer, with its label.
        expect(readiness.measured).toMatch(/Ready|Needs attention|Blocked|Unknown/);
        const dash = (await call("GET", "/api/dashboard")).body.projects.find((p: any) => p.id === projectA);
        expect(readiness.measured).toBe(dash.readiness.label);
    }, 240_000);

    it("a failing run makes the checks after it fail, with the measured numbers", async () => {
        toggle = "fail";
        const done = await startAndWait(projectA, await createRunbook(projectA, def("Gate fails", [run("all", { retries: 0, onFail: "next" }), { id: "rate", type: "condition", condition: { check: "passRate", atLeast: 100 }, onFail: "next" }, { id: "nof", type: "condition", condition: { check: "noFailures" }, onFail: "next" }])));
        toggle = "ok";
        expect(statuses(done)).toEqual(["failed", "failed", "failed"]);
        expect(done.steps[1].measured).toBe("75% passed (3 of 4)");
        expect(done.steps[1].reason).toMatch(/75% passed, below the 100% needed/);
        expect(done.steps[2].measured).toBe("1 failing test");
        expect(done.status).toBe("failed");
        await idle(projectA);
    }, 240_000);
});

describe("retries", () => {
    it("a test that fails once and then passes fails the step with 0 retries and passes with 1", async () => {
        const only = { testIds: [testId["Flaky endpoint"]] };
        flakyMode = "alternate";
        flakyCalls = 0;
        const none = await startAndWait(projectA, await createRunbook(projectA, def("No retries", [run("flaky", { scope: only, retries: 0 })])));
        expect(statuses(none)).toEqual(["failed"]);
        flakyCalls = 0;
        const one = await startAndWait(projectA, await createRunbook(projectA, def("One retry", [run("flaky", { scope: only, retries: 1 })])));
        flakyMode = "ok";
        expect(statuses(one)).toEqual(["passed"]);
        const job = (await call("GET", `/api/test-generation/${one.steps[0].jobId}`)).body;
        expect(job.testsValidated).toBe(1);
        // The test really ran twice in that job: it failed, then passed.
        const execs = ((await call("GET", `/api/tests/${testId["Flaky endpoint"]}/executions`)).body as any[]).filter((e) => e.startedAt >= job.createdAt).sort((a, b) => a.attempt - b.attempt);
        expect(execs.map((e) => e.status)).toEqual(["failed", "passed"]);
        await idle(projectA);
    }, 240_000);
});

describe("a second start, and jobs that somebody else started", () => {
    let projectB: string;
    let slowTest: string;
    it("sets up a project whose only test takes a while", async () => {
        projectB = (await call("POST", "/api/projects", { name: "Slow shop" })).body.id;
        slowMs = 2200;
        const imp = await call("POST", `/api/projects/${projectB}/specs`, { baseUrl: FIXTURE, specs: [spec("Slow endpoint", "/api/slow")] });
        expect((await jobDone(imp.body.jobId)).status).toBe("COMPLETED");
        slowTest = (await call("GET", `/api/projects/${projectB}/tests`)).body[0].id;
    }, 120_000);

    it("a second start while a runbook runs is refused (409) and a cancel ends the wait at once", async () => {
        const first = await createRunbook(projectB, def("Long wait", [{ id: "w", type: "wait", seconds: 200 }]));
        const other = await createRunbook(projectB, def("Another", [{ id: "w", type: "wait", seconds: 1 }]));
        const s = await start(projectB, first);
        expect(s.status).toBe(202);
        const again = await start(projectB, first);
        expect(again.status).toBe(409);
        expect(again.body.error).toMatch(/“Long wait” is still running/);
        expect((await start(projectB, other)).status).toBe(409);
        expect((await call("GET", `/api/projects/${projectB}/runbooks/${first}`)).body.running).toBe(true);
        // Deleting a runbook that is running is refused too.
        expect((await call("DELETE", `/api/projects/${projectB}/runbooks/${first}`)).status).toBe(409);

        const cancel = await call("POST", `/api/projects/${projectB}/runbooks/${first}/runs/${s.body.runId}/cancel`);
        expect(cancel.status).toBe(202);
        const done = await runDone(projectB, s.body.runId, 10_000);
        expect(done).toMatchObject({ status: "cancelled", passed: null });
        expect(statuses(done)).toEqual(["stopped"]);
        expect((await call("POST", `/api/projects/${projectB}/runbooks/${first}/runs/${s.body.runId}/cancel`)).status).toBe(409);
        // The project is free again.
        expect((await call("GET", `/api/projects/${projectB}/runbooks/${first}`)).body.running).toBe(false);
    });

    it("a job somebody else is running blocks a start (409), and one that starts mid-run is waited for, never overlapped", async () => {
        const manual = await call("POST", `/api/tests/${slowTest}/validate`);
        expect(manual.status).toBe(202);
        const quick = await createRunbook(projectB, def("Quick", [run("all", { retries: 0 })]));
        const blocked = await start(projectB, quick);
        expect(blocked.status).toBe(409);
        expect(blocked.body.error).toMatch(/Job .* is still/);
        await jobDone(manual.body.jobId);

        // A runbook that waits first; a person starts a job in the gap; the run step waits for it.
        const rid = await createRunbook(projectB, def("Waits then runs", [{ id: "w", type: "wait", seconds: 3 }, run("all", { retries: 0 })]));
        const s = await start(projectB, rid);
        expect(s.status).toBe(202);
        const foreign = await call("POST", `/api/tests/${slowTest}/validate`);
        expect(foreign.status, JSON.stringify(foreign.body)).toBe(202);
        const done = await runDone(projectB, s.body.runId);
        expect(statuses(done)).toEqual(["passed", "passed"]);
        const foreignJob = (await call("GET", `/api/test-generation/${foreign.body.jobId}`)).body;
        const ownJob = (await call("GET", `/api/test-generation/${done.steps[1].jobId}`)).body;
        expect(ownJob.runbookRunId).toBe(done.runId);
        expect(new Date(ownJob.createdAt).getTime()).toBeGreaterThanOrEqual(new Date(foreignJob.finishedAt).getTime());
        await idle(projectB);
    }, 240_000);

    it("cancelling a step that is running asks its job to stop", async () => {
        slowMs = 9000;
        const rid = await createRunbook(projectB, def("Cancel me", [run("all", { retries: 0 }), { id: "w", type: "wait", seconds: 1 }]));
        const s = await start(projectB, rid);
        let jobId: string | null = null;
        for (let i = 0; i < 300 && !jobId; i++) {
            jobId = (await getRun(projectB, s.body.runId)).steps[0].jobId;
            if (!jobId) await sleep(100);
        }
        expect(jobId).toBeTruthy();
        // Wait until the worker has really picked it up.
        for (let i = 0; i < 100; i++) {
            if ((await call("GET", `/api/test-generation/${jobId}`)).body.status !== "QUEUED") break;
            await sleep(100);
        }
        expect((await call("POST", `/api/projects/${projectB}/runbooks/${rid}/runs/${s.body.runId}/cancel`)).status).toBe(202);
        const done = await runDone(projectB, s.body.runId, 20_000);
        expect(done.status).toBe("cancelled");
        expect(statuses(done)).toEqual(["stopped", "skipped"]);
        const job = await jobDone(jobId!, 60_000);
        expect(job).toMatchObject({ status: "FAILED", error: "Cancelled" });
        slowMs = 2200;
        await idle(projectB);
    }, 240_000);

    it("a step that takes longer than the step cap ends the run as timed out and stops its job; the whole run has a cap too", async () => {
        slowMs = 9000;
        rb.limits.stepCapMs = 1500;
        const rid = await createRunbook(projectB, def("Step cap", [run("all", { retries: 0 }), { id: "w", type: "wait", seconds: 1 }]));
        const done = await startAndWait(projectB, rid);
        rb.limits.stepCapMs = 30 * 60_000;
        expect(done).toMatchObject({ status: "timed_out", passed: false });
        expect(statuses(done)).toEqual(["timed_out", "skipped"]);
        expect(done.reason).toMatch(/took longer than 1\.5 seconds/);
        expect(done.steps[1].reason).toMatch(/ran out of time/);
        const job = await jobDone(done.steps[0].jobId, 60_000);
        expect(job).toMatchObject({ status: "FAILED", error: "Cancelled" });
        await idle(projectB);

        // A wait longer than the step's own cap is cut off.
        rb.limits.stepCapMs = 150;
        const slowWait = await startAndWait(projectB, await createRunbook(projectB, def("Wait cap", [{ id: "w", type: "wait", seconds: 20 }])));
        rb.limits.stepCapMs = 30 * 60_000;
        expect(slowWait).toMatchObject({ status: "timed_out" });
        expect(slowWait.steps[0].status).toBe("timed_out");

        // The whole run's cap: three short waits do not fit in it.
        rb.limits.totalCapMs = 450;
        const total = await startAndWait(projectB, await createRunbook(projectB, def("Total cap", [{ id: "a", type: "wait", seconds: 2 }, { id: "b", type: "wait", seconds: 2 }, { id: "c", type: "wait", seconds: 2 }, { id: "d", type: "wait", seconds: 2 }])));
        rb.limits.totalCapMs = 60 * 60_000;
        expect(total.status).toBe("timed_out");
        expect(total.reason).toMatch(/took longer than 450 ms/);
        // The first wait fits; whichever wait ran out of time ended the run and the rest were never reached.
        expect(statuses(total)[0]).toBe("passed");
        expect(statuses(total)).toContain("timed_out");
        expect(statuses(total).at(-1)).toBe("skipped");
        slowMs = 2200;
    }, 240_000);

    it("a chosen test that has been deleted fails its step in plain words, before any job starts", async () => {
        const imp = await call("POST", `/api/projects/${projectB}/specs`, { baseUrl: FIXTURE, specs: [spec("Doomed", "/api/ok")] });
        await jobDone(imp.body.jobId);
        const doomed = (await call("GET", `/api/projects/${projectB}/tests`)).body.find((t: any) => t.title === "Doomed");
        const rid = await createRunbook(projectB, def("Names a test", [run("only", { scope: { testIds: [doomed.id] } })]));
        platform.db.run("DELETE FROM test_cases WHERE id = ?", doomed.id);
        const done = await startAndWait(projectB, rid);
        expect(done.status).toBe("stopped");
        expect(done.steps[0].status).toBe("failed");
        expect(done.steps[0].reason).toMatch(/no longer exists/);
        expect(done.steps[0].jobId).toBeNull();
        const listed = (await call("GET", `/api/projects/${projectB}/runbooks/${rid}`)).body;
        expect(listed.warnings.join(" ")).toMatch(/no longer exists|No tests match/);
    }, 120_000);
});

describe("environments", () => {
    it("a step can run against a named environment; the environment's rules apply, production needs the confirmation", async () => {
        expect((await call("POST", `/api/projects/${projectA}/environments`, { name: "staging", baseUrl: FIXTURE })).status).toBe(201);
        expect((await call("POST", `/api/projects/${projectA}/environments`, { name: "production", baseUrl: FIXTURE, production: true })).status).toBe(201);
        const scope = { tag: "smoke" };

        // Saved only with the confirmation.
        const unconfirmed = await call("POST", `/api/projects/${projectA}/runbooks`, def("Prod unconfirmed", [run("p", { scope, environment: "production" })]));
        expect(unconfirmed.status).toBe(409);
        expect(unconfirmed.body.error).toMatch(/production environment/);
        expect(unconfirmed.body.details).toMatchObject({ requiresConfirmation: true });
        expect((await call("GET", `/api/projects/${projectA}/runbooks`)).body.runbooks.some((r: any) => r.name === "Prod unconfirmed")).toBe(false);

        const staging = await startAndWait(projectA, await createRunbook(projectA, def("On staging", [run("s", { scope, environment: "staging" })])));
        expect(statuses(staging)).toEqual(["passed"]);
        const stagingJob = (await call("GET", `/api/test-generation/${staging.steps[0].jobId}`)).body;
        expect(stagingJob).toMatchObject({ mode: "environment", environment: "staging", runbookRunId: staging.runId });

        const prod = await startAndWait(projectA, await createRunbook(projectA, def("On production", [run("p", { scope, environment: "production", confirmProduction: true })])));
        expect(statuses(prod)).toEqual(["passed"]);
        expect((await call("GET", `/api/test-generation/${prod.steps[0].jobId}`)).body).toMatchObject({ mode: "environment", environment: "production" });
        const results = (await call("GET", `/api/projects/${projectA}/environments/production/results`)).body;
        expect(JSON.stringify(results)).toContain("Smoke: toggle endpoint");
        await idle(projectA);
    }, 240_000);

    it("an environment that became production after the save is not run without the confirmation; a deleted one fails its step", async () => {
        expect((await call("POST", `/api/projects/${projectA}/environments`, { name: "preprod", baseUrl: FIXTURE })).status).toBe(201);
        expect((await call("POST", `/api/projects/${projectA}/environments`, { name: "doomed", baseUrl: FIXTURE })).status).toBe(201);
        const preprod = await createRunbook(projectA, def("Preprod", [run("p", { scope: { tag: "smoke" }, environment: "preprod" })]));
        const doomed = await createRunbook(projectA, def("Doomed env", [run("d", { scope: { tag: "smoke" }, environment: "doomed" })]));
        expect((await call("PUT", `/api/projects/${projectA}/environments/preprod`, { production: true })).status).toBe(200);
        expect((await call("DELETE", `/api/projects/${projectA}/environments/doomed`)).status).toBeLessThan(300);

        const a = await startAndWait(projectA, preprod);
        expect(a.steps[0]).toMatchObject({ status: "failed", jobId: null });
        expect(a.steps[0].reason).toMatch(/production environment and this step was not confirmed/);
        const b = await startAndWait(projectA, doomed);
        expect(b.steps[0]).toMatchObject({ status: "failed", jobId: null });
        expect(b.steps[0].reason).toMatch(/“doomed” no longer exists/);
    }, 120_000);
});

describe("messages that cannot be sent never fail the run", () => {
    it("a deleted channel, a paused channel and a receiver that is down are reported on the step and the run carries on", async () => {
        const gone = (await call("POST", `/api/projects/${projectA}/alert-channels`, { kind: "webhook", url: `${HOOK}-gone`, name: "Gone soon" })).body.id;
        const paused = (await call("POST", `/api/projects/${projectA}/alert-channels`, { kind: "webhook", url: `${HOOK}-paused`, name: "Paused", enabled: false })).body.id;
        const down = (await call("POST", `/api/projects/${projectA}/alert-channels`, { kind: "webhook", url: `http://127.0.0.1:${DEAD_PORT}/nobody`, name: "Nobody home" })).body.id;
        const rid = await createRunbook(projectA, def("Messages", [
            { id: "a", type: "notify", channelId: gone, message: "to the deleted one" },
            { id: "b", type: "notify", channelId: paused, message: "to the paused one" },
            { id: "c", type: "notify", channelId: down, message: "to nobody" },
            { id: "d", type: "notify", channelId, message: "to the team" },
        ]));
        expect((await call("DELETE", `/api/projects/${projectA}/alert-channels/${gone}`)).status).toBe(204);
        const before = received.length;
        const done = await startAndWait(projectA, rid);
        expect(done).toMatchObject({ status: "passed", passed: true });
        expect(statuses(done)).toEqual(["failed", "failed", "failed", "passed"]);
        expect(done.steps[0].reason).toMatch(/no longer exists, so nothing was sent/);
        expect(done.steps[1].reason).toMatch(/“Paused” is paused/);
        expect(done.steps[2].reason).toMatch(/was not delivered: Could not reach the receiver.*The run carried on/);
        await svc.flush();
        // Only the live channel heard anything.
        expect(received.slice(before).map((m) => m.body.summary)).toEqual(["to the team"]);
        // The failed delivery is in the alert log like any other.
        const log = (await call("GET", `/api/projects/${projectA}/alert-log`)).body as any[];
        expect(log.find((l) => l.channelName === "Nobody home")).toMatchObject({ event: "runbook", status: "failed" });
    }, 120_000);
});

describe("schedules and deploy tokens start runbooks", () => {
    let quick: string;
    it("a due schedule linked to a runbook starts a run of it instead of a plain job; a busy runbook skips the tick", async () => {
        quick = await createRunbook(projectA, def("Quick smoke", [run("smoke", { scope: { tag: "smoke" } })]));
        const created = await call("POST", `/api/projects/${projectA}/schedules`, { kind: "validate", cadence: { type: "daily", time: "02:00" }, runbookId: quick });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        expect(created.body).toMatchObject({ runbookId: quick, runbookName: "Quick smoke" });
        const sid = created.body.id;
        expect((await call("POST", `/api/projects/${projectA}/schedules`, { kind: "validate", cadence: { type: "daily", time: "02:00" }, runbookId: "nope" })).status).toBe(404);
        expect((await call("GET", `/api/projects/${projectA}/runbooks/${quick}`)).body.usedBy.schedules).toEqual([{ id: sid, name: created.body.name }]);

        clockNow = new Date(created.body.nextRunAt).getTime() + 5_000;
        const ticked = await svc.scheduler.tick();
        expect(ticked.map((t) => t.result)).toEqual(["started"]);
        expect(ticked[0]!.jobId).toBeUndefined();
        const runId = ticked[0]!.runbookRunId!;
        expect(runId).toBeTruthy();
        const sch = (await call("GET", `/api/projects/${projectA}/schedules`)).body.schedules.find((s: any) => s.id === sid);
        expect(sch).toMatchObject({ lastOutcome: "started", lastNote: "Started the runbook “Quick smoke”", lastJobId: null });

        const done = await runDone(projectA, runId);
        expect(done).toMatchObject({ status: "passed", trigger: "schedule" });
        const job = (await call("GET", `/api/test-generation/${done.steps[0].jobId}`)).body;
        expect(job).toMatchObject({ trigger: "schedule", scheduleId: sid, runbookRunId: runId });

        // Run now starts the runbook too; a deleted-while-linked runbook cannot be removed.
        const now = await call("POST", `/api/projects/${projectA}/schedules/${sid}/run`);
        expect(now.status, JSON.stringify(now.body)).toBe(202);
        expect(now.body).toMatchObject({ runbook: "Quick smoke" });
        // While it runs, the next due tick is skipped with a plain reason and the slot is given back.
        clockNow += 24 * 3_600_000 + 10_000;
        const skipped = await svc.scheduler.tick();
        expect(skipped[0]).toMatchObject({ result: "skipped" });
        expect(skipped[0]!.note).toMatch(/runbook|job is still/i);
        await runDone(projectA, now.body.runbookRunId);
        const del = await call("DELETE", `/api/projects/${projectA}/runbooks/${quick}`);
        expect(del.status).toBe(409);
        expect(del.body.error).toMatch(/started by the schedule/);

        // Unlinking returns the schedule to its plain job.
        expect((await call("PATCH", `/api/projects/${projectA}/schedules/${sid}`, { runbookId: null })).body).toMatchObject({ runbookId: null, runbookName: null });
        await idle(projectA);
    }, 240_000);

    it("a deploy token linked to a runbook starts a run, answers with the run's status, keeps its rate limit and stays private to its project", async () => {
        const made = await call("POST", `/api/projects/${projectA}/triggers`, { label: "CI", runbookId: quick });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        expect(made.body).toMatchObject({ runbookId: quick, runbookName: "Quick smoke" });
        const token = made.body.token as string;

        const started = await call("POST", `/api/triggers/${token}/run`, { commit: "9b1f0c2", environment: "staging", callbackUrl: `http://127.0.0.1:${RECEIVER_PORT}/cb` }, false);
        expect(started.status, JSON.stringify(started.body)).toBe(202);
        expect(started.body).toMatchObject({ kind: "runbook", runbook: "Quick smoke", state: "running", commit: "9b1f0c2", environment: "staging" });
        expect(started.body.ignored.join(" ")).toMatch(/callbackUrl ignored/);
        const runId = started.body.runId as string;

        // The token is the credential: the same run twice is refused while it is going; a stranger's token sees nothing.
        const second = await call("POST", `/api/triggers/${token}/run`, {}, false);
        expect([409, 429]).toContain(second.status);
        const live = await call("GET", `/api/triggers/${token}/status/${runId}`, undefined, false);
        expect(live.status).toBe(200);
        expect(live.body).toMatchObject({ kind: "runbook", runId, runbook: "Quick smoke" });
        const otherProject = (await call("POST", "/api/projects", { name: "Elsewhere" })).body.id;
        const strangerToken = (await call("POST", `/api/projects/${otherProject}/triggers`, { label: "Other" })).body.token;
        expect((await call("GET", `/api/triggers/${strangerToken}/status/${runId}`, undefined, false)).status).toBe(404);

        const done = await runDone(projectA, runId);
        expect(done).toMatchObject({ status: "passed", trigger: "deploy" });
        const final = (await call("GET", `/api/triggers/${token}/status/${runId}`, undefined, false)).body;
        expect(final).toMatchObject({ state: "passed", finished: true, passed: true });
        expect(final.steps[0]).toMatchObject({ id: "smoke", status: "passed" });
        const job = (await call("GET", `/api/test-generation/${done.steps[0].jobId}`)).body;
        expect(job).toMatchObject({ trigger: "deploy", deploy: { commit: "9b1f0c2", environment: "staging", label: "CI" }, runbookRunId: runId });

        // After the rate limit, a revoked token no longer works.
        await sleep(80);
        const tokenId = made.body.id;
        expect((await call("DELETE", `/api/projects/${projectA}/triggers/${tokenId}`)).status).toBe(200);
        expect((await call("POST", `/api/triggers/${token}/run`, {}, false)).status).toBe(404);
        expect((await call("GET", `/api/triggers/${token}/status/${runId}`, undefined, false)).status).toBe(404);
        await idle(projectA);
    }, 240_000);

    it("a token without a runbook still starts the plain re-run", async () => {
        const made = await call("POST", `/api/projects/${projectA}/triggers`, { label: "Plain" });
        expect(made.body.runbookId).toBeNull();
        const started = await call("POST", `/api/triggers/${made.body.token}/run`, {}, false);
        expect(started.status).toBe(202);
        expect(started.body.state).toBe("queued");
        expect(started.body.jobId).toBeTruthy();
        await jobDone(started.body.jobId);
        // Linking it later, and unlinking, through the project route.
        expect((await call("PUT", `/api/projects/${projectA}/triggers/${made.body.id}/runbook`, { runbookId: quick })).body).toMatchObject({ runbookId: quick });
        expect((await call("PUT", `/api/projects/${projectA}/triggers/${made.body.id}/runbook`, { runbookId: null })).body).toMatchObject({ runbookId: null });
        expect((await call("PUT", `/api/projects/${projectA}/triggers/${made.body.id}/runbook`, { runbookId: "nope" })).status).toBe(404);
    }, 120_000);
});

describe("templates and housekeeping", () => {
    it("creates the three presets from a button, with and without a channel to tell", async () => {
        const gate = await call("POST", `/api/projects/${projectA}/runbooks/from-template`, { template: "release-gate", channelId });
        expect(gate.status, JSON.stringify(gate.body)).toBe(201);
        expect(gate.body).toMatchObject({ name: "Release gate", note: null });
        expect(gate.body.definition.steps.map((s: any) => s.type)).toEqual(["run", "condition", "condition", "condition", "condition", "notify"]);
        const smoke = await call("POST", `/api/projects/${projectA}/runbooks/from-template`, { template: "smoke-then-full" });
        expect(smoke.status).toBe(201);
        expect(smoke.body.definition.steps.some((s: any) => s.type === "notify")).toBe(false);
        expect(smoke.body.note).toMatch(/no message step/);
        // The smoke preset picks tests of the kind "smoke": say so up front when this project has none.
        expect(smoke.body.warnings.join(" ")).toMatch(/Step 1: No tests match/);
        const nightly = await call("POST", `/api/projects/${projectA}/runbooks/from-template`, { template: "nightly-with-alert", channelId, name: "Every night" });
        expect(nightly.body.name).toBe("Every night");
        expect((await call("POST", `/api/projects/${projectA}/runbooks/from-template`, { template: "nope" })).status).toBe(404);
        expect((await call("POST", `/api/projects/${projectA}/runbooks/from-template`, { template: "release-gate", channelId: "other" })).status).toBe(404);
    });

    it("edits and deletes a runbook; editing keeps earlier runs as they were", async () => {
        const id = await createRunbook(projectA, def("To edit", [{ id: "w", type: "wait", seconds: 1 }]));
        const done = await startAndWait(projectA, id);
        const put = await call("PUT", `/api/projects/${projectA}/runbooks/${id}`, def("Edited", [{ id: "w", type: "wait", seconds: 2 }, { id: "x", type: "wait", seconds: 1 }]));
        expect(put.status).toBe(200);
        expect(put.body).toMatchObject({ name: "Edited", titles: ["Wait 2 seconds", "Wait 1 second"] });
        expect((await call("PUT", `/api/projects/${projectA}/runbooks/${id}`, def("Bad", [run("a", { onPass: "a" })]))).status).toBe(400);
        const old = (await call("GET", `/api/projects/${projectA}/runbooks/${id}/runs/${done.runId}`)).body;
        expect(old.steps).toHaveLength(1);
        expect(old.runbookName).toBe("To edit");
        expect((await call("DELETE", `/api/projects/${projectA}/runbooks/${id}`)).status).toBe(204);
        expect((await call("GET", `/api/projects/${projectA}/runbooks/${id}`)).status).toBe(404);
    });

    it("keeps to 20 runbooks per project", async () => {
        const p = (await call("POST", "/api/projects", { name: "Many" })).body.id;
        for (let i = 0; i < 20; i++) await createRunbook(p, def(`Runbook ${i}`, [{ id: "w", type: "wait", seconds: 1 }]));
        const over = await call("POST", `/api/projects/${p}/runbooks`, def("One too many", [{ id: "w", type: "wait", seconds: 1 }]));
        expect(over.status).toBe(409);
        expect(over.body.error).toMatch(/up to 20 runbooks/);
    });
});

describe("analyze steps", () => {
    it("start the analysis again with data-changing tests and the load check off, whatever the saved settings say, and only on when the step says so", async () => {
        const project = (await call("POST", "/api/projects", { name: "Analyzed" })).body.id;
        // The application's saved settings from its last analysis have the risky options on.
        platform.repo.createApplication(project, FIXTURE, { ...DEFAULT_JOB_OPTIONS, allowMutatingApiTests: true, loadChecks: true, performanceChecks: true }, undefined);
        const plain = await startAndWait(project, await createRunbook(project, def("Analyze", [{ id: "a", type: "analyze" }])));
        const job1 = platform.repo.getJob(plain.steps[0].jobId)!;
        expect(job1.options).toMatchObject({ mode: "generate", allowMutatingApiTests: false, loadChecks: false, performanceChecks: true, runbookRunId: plain.runId });
        expect(plain.steps[0].jobId).toBeTruthy();
        // No model is configured here, so the analysis cannot finish; the step says so in the job's own words.
        expect(plain.steps[0].status).toBe("failed");
        expect(plain.steps[0].reason).toMatch(/analysis|job/i);
        await idle(project);

        const explicit = await startAndWait(project, await createRunbook(project, def("Analyze with data changes", [{ id: "a", type: "analyze", allowMutatingApiTests: true }])));
        const job2 = platform.repo.getJob(explicit.steps[0].jobId)!;
        expect(job2.options).toMatchObject({ allowMutatingApiTests: true, loadChecks: false });
        await idle(project);
    }, 240_000);
});

describe("restarts", () => {
    it("a run found going after a restart is marked interrupted, never resumed; a graceful shutdown does the same at once", async () => {
        // A second platform on its own database: "the process that was running a runbook" and "the process that starts afterwards".
        const configFor = () => loadConfig({ DATA_DIR: dataDir2, SECRET_KEY: "test-secret-key-0123456789", API_KEY, CONCURRENCY: "2" });
        const before = bootstrap(configFor());
        const beforeRb = getRunbookServices(before, { waitUnitMs: 100 });
        const beforeServer = await buildServer(before);
        const headers = { "x-api-key": API_KEY };
        const projectId = (await beforeServer.inject({ method: "POST", url: "/api/projects", payload: { name: "Restarted" }, headers })).json().id;
        const rid = (await beforeServer.inject({ method: "POST", url: `/api/projects/${projectId}/runbooks`, payload: def("Long", [{ id: "w", type: "wait", seconds: 250 }, { id: "x", type: "wait", seconds: 1 }]), headers })).json().id;
        const started = (await beforeServer.inject({ method: "POST", url: `/api/projects/${projectId}/runbooks/${rid}/run`, headers })).json();
        expect(started.runId).toBeTruthy();
        await sleep(300);
        expect(beforeRb.store.getRun(started.runId)!.status).toBe("running");

        // Shutting down marks the run interrupted at once: nothing will drive it any more.
        await beforeRb.stop();
        const stopped = beforeRb.store.getRun(started.runId)!;
        expect(stopped.status).toBe("interrupted");
        expect(stopped.reason).toMatch(/shut down.*not resumed/);
        expect(beforeRb.store.runSteps(started.runId).map((s) => s.status)).toEqual(["stopped", "skipped"]);
        await beforeServer.close();
        before.db.close();

        // The process that starts next: a run its dead predecessor left "running" (a crash, so no shutdown code ran).
        const after = bootstrap(configFor());
        const afterRb = getRunbookServices(after, { staleMs: 0 });
        const runbook = afterRb.store.list(projectId)[0]!;
        const crashed = afterRb.store.createRun({ runbook, trigger: "schedule", triggerRef: "s", owner: "a-process-that-died", titles: ["Wait 250 seconds", "Wait 1 second"] });
        afterRb.store.startStep(crashed.id, 0);
        expect(afterRb.store.getRun(crashed.id)!.status).toBe("running");
        const ended = afterRb.recover();
        expect(ended.map((r) => r.id)).toEqual([crashed.id]);
        const row = afterRb.store.getRun(crashed.id)!;
        expect(row.status).toBe("interrupted");
        expect(row.reason).toMatch(/restarted.*not resumed/);
        // Nothing carried on by itself.
        await sleep(400);
        expect(afterRb.store.runSteps(crashed.id).map((s) => s.status)).toEqual(["stopped", "skipped"]);
        expect(after.repo.listJobs(projectId)).toEqual([]);
        // The project is free for a new run.
        expect((await afterRb.start(runbook.id, { kind: "manual" })).status).toBe("running");
        await afterRb.stop();
        after.db.close();
    }, 60_000);
});
