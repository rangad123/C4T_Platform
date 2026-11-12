/**
 * EXECUTION_MODE=runners (the hosted platform): tests run only on runners and nothing runs on the server.
 *
 * A real platform on real HTTP in runners mode, its dispatch worker (as src/main.ts starts it, with WORKER_EMBEDDED=false), and an
 * unchanged protocol-1 FAKE AGENT (tests/fixtures/fake-agent.ts: plain fetch, canned results, runs nothing). Covers: a run queued,
 * handed to the runner and finished with results while the stored project setting stays "this server"; several runs at once; no
 * runner online is a plain 409; work that needs the server's browser is refused when it is made; the last-line guard (no browser
 * launch, no local script run, proven by its counter and by trying); a schedule firing to the runner with its owner; Run now with no
 * runner refused and nothing queued; a re-queued job keeping the earlier attempt's runner task (cancelled when it is given up); a runner failure leaving the
 * tests as they were; the third worker loss giving the job up without failing tests; and local mode unchanged.
 *
 * No browser, no model, no network beyond 127.0.0.1. Ports: platform 8000, local-mode platform 8002, fixture application 8001.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { localExecutor } from "../src/engine/frameworks/executor.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { personalRunner } from "./helpers/personal-runner.js";
import { DEFAULT_JOB_OPTIONS, WORKER_LOST_GIVE_UP } from "../src/platform/repo.js";
import { PLATFORM_SETTING_REFUSED, DISPATCH_DOWN_MESSAGE, removeServerExecutionGuard, serverRunRefusals, SERVER_RUN_REFUSED } from "../src/platform/runner-only.js";
import { getScheduleServices } from "../src/platform/schedule-services.js";
import { SecretBox } from "../src/platform/secrets.js";
import { MAIN_ACCOUNT, SessionStore } from "../src/platform/session-store.js";
import { ResetHookStore } from "../src/platform/test-data-reset-store.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { defaultCaps, failedRun, FakeAgent, passedRun, viaFetch } from "./fixtures/fake-agent.js";

const PORT = 8000;
const APP_PORT = 8001;
const LOCAL_PORT = 8002;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = "ro-admin-key-41c7e2b9";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dispatch: Worker | undefined;
let dataDir: string;
let appServer: http.Server;

const call = async (method: string, url: string, body?: unknown, base = BASE) => {
    const res = await fetch(`${base}${url}`, { method, headers: { "x-api-key": API_KEY, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text } as { status: number; body: any };
};
const jobCount = (projectId: string) => platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM generation_jobs WHERE project_id = ?", projectId)!.n;
const newProject = async (name: string) => (await call("POST", "/api/projects", { name })).body.id as string;
/** The person's runner (one per person: a new one replaces the one before). */
const connect = async (projectId: string, name: string, concurrency = 1) => {
    const token = personalRunner(platform, { label: name }).secret;
    const agent = new FakeAgent(viaFetch(BASE), token, { name, capabilities: defaultCaps(), concurrency });
    expect((await agent.hello()).status).toBe(200);
    return agent;
};
const apiSpec = (title: string) => ({ title, kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/health" }, { action: "assertResponse", check: "status", expected: 200 }] });
const importTests = async (projectId: string, titles: string[]) => {
    const r = await call("POST", `/api/projects/${projectId}/specs`, { baseUrl: `http://127.0.0.1:${APP_PORT}`, validate: false, specs: titles.map(apiSpec) });
    expect(r.status).toBe(202);
    return r.body.tests as Array<{ id: string; testId: string }>;
};
const waitForJob = async (jobId: string, ms = 30_000) => {
    const end = Date.now() + ms;
    for (;;) {
        const j = platform.repo.getJob(jobId)!;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status) || Date.now() > end) return j;
        await new Promise((r) => setTimeout(r, 100));
    }
};
const startDispatch = () => {
    dispatch = Worker.dispatch({ ...platform }, 100);
    dispatch.start();
};

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "3", AGENT_WATCH_MS: "50", AGENT_NO_AGENT_GRACE_SECONDS: "2" });
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    appServer = http.createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end("{}"));
    await new Promise<void>((r) => appServer.listen(APP_PORT, "127.0.0.1", r));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-runners-only-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, EXECUTION_MODE: "runners", WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false", SECRET_KEY: "runner-only-mode-secret-key-0123456789", DISPATCH_CONCURRENCY: "4", MAX_REPAIR_ATTEMPTS: "0" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
}, 60_000);

afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    await dispatch?.stop();
    await server?.close();
    platform?.db.close();
    removeServerExecutionGuard();
    await new Promise((r) => appServer.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("runners only: before the dispatch worker runs", () => {
    it("says so in /api/config and refuses a run plainly, queueing nothing", async () => {
        const pid = await newProject("Before dispatch");
        const [t] = await importTests(pid, ["Health answers"]);
        const cfg = (await call("GET", "/api/config")).body;
        expect(cfg.executionMode).toBe("runners");
        expect(cfg.runsHere).toBe(false);
        const r = await call("POST", `/api/projects/${pid}/runs`, { testIds: [t!.id] });
        expect(r.status).toBe(409);
        expect(r.body.error).toBe(DISPATCH_DOWN_MESSAGE);
        expect(jobCount(pid)).toBe(0);
        startDispatch();
        expect((await call("GET", "/api/config")).body.runsHere).toBe(true);
    });
});

describe("runners only: what is refused", () => {
    it("no runner online is a plain 409 and nothing is queued", async () => {
        const pid = await newProject("No runner");
        const [t] = await importTests(pid, ["Health answers"]);
        const r = await call("POST", `/api/projects/${pid}/runs`, { testIds: [t!.id] });
        expect(r.status).toBe(409);
        expect(r.body.error).toMatch(/runner/i);
        expect(r.body.error).not.toMatch(/running here|this server|own installation/);
        expect(jobCount(pid)).toBe(0);
    });

    it("an exploration, a described test and an agent run need the starter's runner; the project cannot be set to run here", async () => {
        const pid = await newProject("Server work");
        // Round 51: an exploration goes to the starter's runner, so without one it is refused as a run is (explore-on-runner.test.ts has the rest).
        // Round 52: so do a described test and an agent run (jobs-on-runner.test.ts).
        const explore = await call("POST", `/api/projects/${pid}/test-generation`, { url: "https://shop.example.test" });
        expect(explore.status).toBe(409);
        expect(explore.body.details).toMatchObject({ code: "RUNNER_NOT_SET_UP" });
        const plain = await call("POST", `/api/projects/${pid}/plain-tests`, { description: "Open the home page and check the title" });
        // No AI model on this test platform: that is what stops it now, not the mode (the job gate below says the runner).
        expect(plain.status).toBe(422);
        expect(plain.body.details).toMatchObject({ modelMissing: true });
        // Every other way a job is made goes through createJob's gate.
        const app = platform.repo.createApplication(pid, "https://shop.example.test", { ...DEFAULT_JOB_OPTIONS }, undefined);
        for (const mode of ["generate", "plain", "agent"] as const) {
            await expect(platform.repo.createJob(pid, app, { ...DEFAULT_JOB_OPTIONS, mode })).rejects.toMatchObject({ status: 409 });
        }
        expect(jobCount(pid)).toBe(0);
        const put = await call("PUT", `/api/projects/${pid}/runner`, { runOn: "platform" });
        expect(put.status).toBe(409);
        expect(put.body.error).toBe(PLATFORM_SETTING_REFUSED);
    });
});

describe("runners only: a run goes to the runner", () => {
    it("is queued, handed to the runner and finishes with results; the stored setting is untouched and the server ran nothing", async () => {
        const pid = await newProject("Shop");
        const agent = await connect(pid, "maya-laptop");
        const [t1, t2] = await importTests(pid, ["Health answers", "Items are listed"]);
        // Never set to "on a runner": the effective setting is, the stored one is not rewritten.
        expect(platform.db.get("SELECT run_on FROM runner_settings WHERE project_id = ?", pid)).toBeUndefined();
        expect((await call("GET", `/api/projects/${pid}/runner`)).body.runOn).toBe("agent");
        const before = serverRunRefusals();
        const started = await call("POST", `/api/projects/${pid}/runs`, { testIds: [t1!.id, t2!.id] });
        expect(started.status).toBe(202);
        const offer = await agent.next(10_000);
        expect(offer?.jobId).toBe(started.body.jobId);
        await agent.answer(offer!, { runs: [passedRun(t1!.testId), failedRun(t2!.testId, "Expected 200 but got 500")] });
        const job = await waitForJob(started.body.jobId);
        expect(job.status).toBe("PARTIALLY_COMPLETED");
        expect(job.options.runOn).toBe("agent");
        const tests = (await call("GET", `/api/projects/${pid}/tests`)).body as Array<{ id: string; validationStatus: string }>;
        expect(tests.find((t) => t.id === t1!.id)!.validationStatus).toBe("VALIDATED");
        expect((await call("GET", `/api/tests/${t2!.id}/executions`)).body[0]).toMatchObject({ status: "failed" });
        expect((await call("GET", `/api/test-generation/${job.id}`)).body.ranOn).toMatchObject({ kind: "agent", name: "maya-laptop" });
        expect(serverRunRefusals()).toBe(before); // nothing even tried to open a browser or run a script here
    }, 60_000);

    it("looks after several runs at once: a slow run does not hold up another project's run", async () => {
        const [a, b] = [await newProject("Slow"), await newProject("Quick")];
        // One runner per person: one computer with two slots takes both runs.
        const slow = await connect(a, "two-slot-pc", 2);
        const quick = slow;
        const [ta] = await importTests(a, ["Health answers"]);
        const [tb] = await importTests(b, ["Health answers"]);
        const ja = (await call("POST", `/api/projects/${a}/runs`, { testIds: [ta!.id] })).body.jobId as string;
        const slowOffer = await slow.next(10_000);
        expect(slowOffer).toBeDefined();
        const jb = (await call("POST", `/api/projects/${b}/runs`, { testIds: [tb!.id] })).body.jobId as string;
        const quickOffer = await quick.next(10_000);
        expect(quickOffer?.jobId).toBe(jb);
        await quick.answer(quickOffer!, { runs: [passedRun(tb!.testId)] });
        expect((await waitForJob(jb)).status).toBe("COMPLETED");
        expect(platform.repo.getJob(ja)!.status).toBe("VALIDATING"); // still waiting for its runner, in its own slot
        await slow.answer(slowOffer!, { runs: [passedRun(ta!.testId)] });
        expect((await waitForJob(ja)).status).toBe("COMPLETED");
    }, 60_000);

    it("a runner failure leaves the tests as they were and says why", async () => {
        const pid = await newProject("Runner fails");
        const agent = await connect(pid, "flaky-pc");
        const [t] = await importTests(pid, ["Health answers"]);
        const first = (await call("POST", `/api/projects/${pid}/runs`, { testIds: [t!.id] })).body.jobId as string;
        await agent.answer((await agent.next(10_000))!, { runs: [passedRun(t!.testId)] });
        expect((await waitForJob(first)).status).toBe("COMPLETED");
        expect(platform.repo.getTest(t!.id)!.validationStatus).toBe("VALIDATED");
        const second = (await call("POST", `/api/projects/${pid}/runs`, { testIds: [t!.id] })).body.jobId as string;
        await agent.answer((await agent.next(10_000))!, { ok: false, error: "Chromium could not start on this computer." });
        const job = await waitForJob(second);
        expect(job.status).toBe("FAILED");
        expect(job.error).toContain("Chromium could not start");
        // Not FAILED_VALIDATION: the runner failed, not the test.
        expect(platform.repo.getTest(t!.id)!.validationStatus).toBe("VALIDATED");
        const kinds = platform.repo.listEvents(job.id).map((e) => String(e.kind));
        expect(kinds).toContain("runner_failed_tests_restored");
    }, 60_000);

    it("a schedule fires to the runner, and its run carries the schedule and its owner", async () => {
        const pid = await newProject("Scheduled");
        const agent = await connect(pid, "nightly-pc");
        const [t] = await importTests(pid, ["Health answers"]);
        const made = await call("POST", `/api/projects/${pid}/schedules`, { kind: "validate", cadence: { type: "daily", time: "03:00" } });
        expect(made.status).toBe(201);
        const listed = (await call("GET", `/api/projects/${pid}/schedules`)).body;
        expect(listed.executionMode).toBe("runners");
        expect(listed.schedulesFire).toBe(false); // SCHEDULER_ENABLED=false in this test platform: said, not hidden
        // Made on the open server: nobody's name to show.
        expect(listed.schedules[0]).not.toHaveProperty("ownerName");
        // Round 52: "Explore again" goes to the schedule's creator's runner, so it may be made here too (jobs-on-runner.test.ts runs one).
        const explore = await call("POST", `/api/projects/${pid}/schedules`, { kind: "generate", cadence: { type: "daily", time: "03:00" }, enabled: false });
        expect(explore.status, JSON.stringify(explore.body)).toBe(201);
        platform.db.run("UPDATE schedules SET next_run_at = ? WHERE id = ?", Date.now() - 1000, made.body.id);
        const ticked = await getScheduleServices(platform).scheduler.tick();
        const fired = ticked.find((x) => x.scheduleId === made.body.id)!;
        expect(fired.result).toBe("started");
        const offer = await agent.next(10_000);
        expect(offer?.jobId).toBe(fired.jobId);
        await agent.answer(offer!, { runs: [passedRun(t!.testId)] });
        const job = await waitForJob(fired.jobId!);
        expect(job.status).toBe("COMPLETED");
        // Made on an open server (round 45: it acts as one person), so the open server owns it and its runner takes the run.
        expect(job.options.startedBy).toEqual({ kind: "schedule", id: made.body.id, ownerId: "open" });
        expect(job.options.trigger).toBe("schedule");
    }, 60_000);

    it("Run now with no runner online is refused and nothing is queued", async () => {
        const pid = await newProject("Run now, nobody home");
        await importTests(pid, ["Health answers"]);
        const made = await call("POST", `/api/projects/${pid}/schedules`, { kind: "validate", cadence: { type: "daily", time: "03:00" } });
        // The open server's runners of the tests above were last seen long ago: offline. Run now is a person's click, so it is told now.
        const seen = platform.db.all<{ id: string; last_seen_ms: number }>("SELECT id, last_seen_ms FROM agents");
        platform.db.run("UPDATE agents SET last_seen_ms = 0");
        const r = await call("POST", `/api/projects/${pid}/schedules/${made.body.id}/run`);
        for (const a of seen) platform.db.run("UPDATE agents SET last_seen_ms = ? WHERE id = ?", a.last_seen_ms, a.id);
        expect(r.status).toBe(409);
        expect(r.body.error).toBe("Your runner is offline. Start it on your computer, then try again.");
        expect(jobCount(pid)).toBe(0);
    });
});

describe("runners only: the server's own browser and network inside a runner job", () => {
    it("a saved sign-in goes unchecked, a failing web test gets no repair browser, and a reset to a private address stops the run plainly", async () => {
        const pid = await newProject("Signed-in shop");
        const agent = await connect(pid, "web-pc");
        const SITE = "https://shop.example.test";
        const imp = await call("POST", `/api/projects/${pid}/specs`, { baseUrl: SITE, validate: false, specs: [{ testId: "WEB-001", title: "Home shows the shop", kind: "web", category: "Imported", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "visible", expected: "Shop" }] }] });
        expect(imp.status).toBe(202);
        const t = imp.body.tests[0] as { id: string; testId: string };
        new SessionStore(platform.db, new SecretBox(platform.config.dataDir, platform.config.SECRET_KEY)).saveSession(pid, MAIN_ACCOUNT, { state: { cookies: [], origins: [] }, appUrl: SITE, checkUrl: `${SITE}/account`, how: "file" });
        const before = serverRunRefusals();
        const jobId = (await call("POST", `/api/projects/${pid}/runs`, { testIds: [t.id] })).body.jobId as string;
        const offer = await agent.next(10_000);
        expect(offer?.scripts[0]?.session).toBe(true); // the saved sign-in still travels with the test
        await agent.answer(offer!, { runs: [failedRun(t.testId, "Shop was not visible")] });
        const job = await waitForJob(jobId);
        expect(job.status).not.toBe("VALIDATING");
        const kinds = platform.repo.listEvents(jobId).map((e) => String(e.kind));
        expect(kinds).toContain("sign_in_unchecked");
        expect(kinds).toContain("repair_browser_skipped");
        expect(serverRunRefusals()).toBe(before); // nothing tried to open a browser here

        // The reset is sent from the server: only to a public address. A local one stops the run before any test, in plain words.
        new ResetHookStore(platform.db, new SecretBox(platform.config.dataDir, platform.config.SECRET_KEY)).save(pid, "", { enabled: true, method: "POST", url: "http://127.0.0.1:8001/reset", expectedStatus: 200, headers: [] });
        platform.db.run("UPDATE applications SET url = ? WHERE project_id = ?", "http://127.0.0.1:8001", pid);
        const reset = (await call("POST", `/api/projects/${pid}/runs`, { testIds: [t.id] })).body.jobId as string;
        const stopped = await waitForJob(reset);
        expect(stopped.status).toBe("FAILED");
        expect(stopped.error).toMatch(/^The test data cannot be reset from here: .*127\.0\.0\.1, a private or local address/);
        expect(platform.repo.getTest(t.id)!.validationStatus).not.toBe("VALIDATING");
    }, 60_000);
});

describe("runners only: a job whose worker was lost", () => {
    it("is re-queued with the earlier attempt's runner task kept for the next attempt; the third loss cancels it and gives the job up without failing tests", async () => {
        const pid = await newProject("Lost worker");
        await connect(pid, "lost-pc");
        const [t] = await importTests(pid, ["Health answers"]);
        await dispatch!.stop(); // nothing claims the job again while this test plays the lost worker
        const app = platform.repo.getLatestApplicationPublic(pid)!.id as string;
        const job = await platform.repo.createJob(pid, app, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [t!.id], startedBy: { kind: "open", id: null } });
        expect(platform.repo.claimNextJob(60_000, "lost-worker", ["validate"])?.id).toBe(job.id);
        const svc = getAgentServices(platform);
        svc.store.enqueue({ id: "task-of-attempt-1", projectId: pid, jobId: job.id, adapterId: "playwright-api", payloadEnc: svc.encrypt({}), files: [] });
        platform.db.run("UPDATE generation_jobs SET lease_until = ? WHERE id = ?", Date.now() - 1, job.id);
        platform.db.run("UPDATE test_cases SET validation_status = 'VALIDATING' WHERE id = ?", t!.id);
        expect(platform.repo.reclaimStaleJobs()).toBe(1);
        // Kept: the next attempt picks it up instead of sending the run a second time (runner-restart.test.ts runs that end to end).
        expect(svc.store.getTask("task-of-attempt-1")!.status).toBe("queued");
        expect(platform.repo.getJob(job.id)!.status).toBe("QUEUED");
        expect(platform.repo.listEvents(job.id).map((e) => String(e.kind))).toContain("runner_attempt_kept");
        // Third loss: given up, the test is back to not run yet (never failed by it).
        platform.db.run("UPDATE generation_jobs SET status = 'VALIDATING', attempts = 3, lease_until = ?, lease_owner = 'lost-worker' WHERE id = ?", Date.now() - 1, job.id);
        platform.db.run("UPDATE test_cases SET validation_status = 'VALIDATING' WHERE id = ?", t!.id);
        platform.repo.reclaimStaleJobs();
        expect(platform.repo.getJob(job.id)).toMatchObject({ status: "FAILED", error: WORKER_LOST_GIVE_UP });
        expect(svc.store.getTask("task-of-attempt-1")!.status).toBe("cancelled");
        expect(platform.repo.listEvents(job.id).map((e) => String(e.kind))).toContain("runner_attempt_cancelled");
        expect(platform.repo.getTest(t!.id)!.validationStatus).toBe("PENDING");
        startDispatch();
    });
});

describe("runners only: the last-line guard", () => {
    it("refuses a browser on the server and a local script run, and counts both", async () => {
        const before = serverRunRefusals();
        await expect(chromium.launch({ headless: true })).rejects.toThrow(SERVER_RUN_REFUSED);
        await expect(localExecutor.execute("playwright-api", { scratchDir: path.join(dataDir, "scratch"), scripts: [] }, { run: { baseUrl: "https://shop.example.test", headless: true } }, { workers: 1 })).rejects.toThrow(SERVER_RUN_REFUSED);
        expect(serverRunRefusals()).toBe(before + 2);
    });
});

describe("local mode is unchanged", () => {
    let local: Platform;
    let localServer: Awaited<ReturnType<typeof buildServer>>;
    let localDir: string;
    beforeAll(async () => {
        localDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-runners-local-"));
        local = bootstrap(loadConfig({ DATA_DIR: localDir, WORKER_EMBEDDED: "true", SCHEDULER_ENABLED: "false", SECRET_KEY: "runner-only-local-secret-key-0123456789" }));
        localServer = await buildServer(local);
        await localServer.listen({ port: LOCAL_PORT, host: "127.0.0.1" });
    });
    afterAll(async () => {
        await localServer?.close();
        local?.db.close();
        fs.rmSync(localDir, { recursive: true, force: true });
    });

    it("runs here by default, may be set to run here, and allows an exploration job", async () => {
        const base = `http://127.0.0.1:${LOCAL_PORT}`;
        const cfg = (await call("GET", "/api/config", undefined, base)).body;
        expect(cfg.executionMode).toBe("local");
        expect(cfg.runsHere).toBe(true);
        const pid = (await call("POST", "/api/projects", { name: "Local" }, base)).body.id as string;
        expect((await call("GET", `/api/projects/${pid}/runner`, undefined, base)).body.runOn).toBe("platform");
        expect((await call("PUT", `/api/projects/${pid}/runner`, { runOn: "platform" }, base)).status).toBe(200);
        const app = local.repo.createApplication(pid, "https://shop.example.test", { ...DEFAULT_JOB_OPTIONS }, undefined);
        const job = await local.repo.createJob(pid, app, { ...DEFAULT_JOB_OPTIONS, mode: "generate" });
        expect(job.status).toBe("QUEUED");
    });
});
