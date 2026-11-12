/**
 * Per-project framework settings against a REAL platform on real HTTP: the API (protection, validation, clamping, change log, the 409
 * while a job runs, isolation), switched-off frameworks (import and run refused with a plain reason while web tests still really run in
 * Chromium), and tasks for a runner agent (a fake agent written in tests/fixtures/fake-agent.ts claims them): the time limit, workers,
 * a visible window and the emulator choice land in the task, and a project that never changed anything gets exactly today's task.
 * The real Playwright config and the real agent program are covered in framework-settings-agent.test.ts.
 *
 * Browser-launching (the platform host run uses Chromium): run with
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/framework-settings.test.ts
 * Ports: platform 5950, fixture application 5951.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { DEFAULT_FRAMEWORK_SETTINGS } from "../src/engine/frameworks/settings.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { personalRunner, runOwner, testPerson } from "./helpers/personal-runner.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { defaultCaps, FakeAgent, viaFetch } from "./fixtures/fake-agent.js";

const PLATFORM_PORT = 5950;
const APP_PORT = 5951;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;
const API_KEY = "ak-admin-key-7d21c9e4";
let RUN_AS = API_KEY;
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS", "BLOCK_PRIVATE_TARGETS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker | undefined;
let dataDir: string;
let appServer: http.Server;

const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = { "x-api-key": RUN_AS }) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; text: string; body: any };
};
// The test acts as a person (round 45), whose changes would wait for approval: these tests are about running them.
const newProject = async (name: string) => {
    const id = (await call("POST", "/api/projects", { name })).body.id as string;
    await call("PUT", `/api/projects/${id}/review-policy`, { edits: false });
    return id;
};
const putSettings = (projectId: string, settings: unknown, by?: string) => call("PUT", `/api/projects/${projectId}/framework-settings`, { settings, ...(by ? { by } : {}) });
const getSettings = async (projectId: string) => (await call("GET", `/api/projects/${projectId}/framework-settings`)).body;

const WEB = { title: "The home page greets people", kind: "web", category: "Web", steps: [{ action: "navigate", url: `${APP}/` }, { action: "assert", check: "visible", locator: { by: "text", value: "Welcome to the fixture" } }] };
const API = { title: "The health endpoint answers", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/api/health" }, { action: "assertResponse", check: "status", expected: 200 }] };
const MOBILE = { title: "Shop opens", kind: "mobile", category: "Mobile", steps: [{ action: "assert", check: "visible", locator: { by: "text", value: "Shop" } }] };

async function jobDone(jobId: string): Promise<any> {
    for (let i = 0; i < 400; i++) {
        const j = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) return j;
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("job did not finish");
}
const eventsOf = async (jobId: string): Promise<Array<{ kind: string; message: string }>> => (await call("GET", `/api/test-generation/${jobId}/events`)).body;

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "20", AGENT_WATCH_MS: "50", AGENT_NO_AGENT_GRACE_SECONDS: "5" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    appServer = http.createServer((req, res) => {
        if (req.url === "/api/health") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok" }));
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><html lang="en"><head><title>Fixture</title></head><body><main><h1>Welcome to the fixture</h1></main></body></html>`);
    });
    await new Promise<void>((r) => appServer.listen(APP_PORT, "127.0.0.1", () => r()));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-fwset-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0" }));
    // Round 45: runs started with the shared key have no owner, so the test acts as a person whose runner takes them.
    RUN_AS = testPerson(platform).token;
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
}, 60_000);

afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    await new Promise((r) => appServer.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("the API", () => {
    let projectId = "";
    beforeAll(async () => {
        projectId = await newProject("Settings API");
    });

    it("an empty body is not refused and keeps the defaults", async () => {
        const other = await newProject("Settings empty body");
        expect((await call("PUT", `/api/projects/${other}/framework-settings`, {})).status).toBe(200);
        expect((await getSettings(other)).settings).toEqual(JSON.parse(JSON.stringify(DEFAULT_FRAMEWORK_SETTINGS)));
    });

    it("needs the API key", async () => {
        expect((await call("GET", `/api/projects/${projectId}/framework-settings`, undefined, {})).status).toBe(401);
        expect((await call("GET", `/api/projects/${projectId}/framework-settings`, undefined, { "x-api-key": "wrong" })).status).toBe(401);
        expect((await call("PUT", `/api/projects/${projectId}/framework-settings`, { settings: { web: { testTimeoutSeconds: 90 } } }, {})).status).toBe(401);
        expect((await getSettings(projectId)).settings.web.testTimeoutSeconds).toBe(60);
        expect((await call("GET", "/api/projects/nope/framework-settings")).status).toBe(404);
    });

    it("a project that never changed anything gets the defaults, what a run would use, and where each framework can run", async () => {
        const r = await getSettings(projectId);
        expect(r.settings).toEqual(JSON.parse(JSON.stringify(DEFAULT_FRAMEWORK_SETTINGS)));
        expect(r.effective.web).toEqual({ headless: true, workers: 2, workersLimit: null, testTimeoutSeconds: 60 });
        expect(r.effective.notes).toEqual([]);
        expect(r.changes).toEqual([]);
        expect(r.runner).toMatchObject({ runOn: "platform" });
        expect(r.limits).toMatchObject({ timeoutSeconds: { min: 30, max: 300 }, platformWorkers: 2 });
        expect(r.adapters.map((a: { id: string }) => a.id)).toEqual(["playwright", "playwright-api", "taqwright", "windows-uia", "taqwright-ios"]);
        const web = r.adapters.find((a: { id: string }) => a.id === "playwright");
        expect(web).toMatchObject({ label: "Playwright (TypeScript)", enabled: true, available: { platform: true, agent: null } });
        // nothing was stored for it
        expect(platform.db.all("SELECT * FROM framework_settings WHERE project_id = ?", projectId)).toEqual([]);
    });

    it("saves a partial update, clamps numbers and says so, and refuses what it cannot understand", async () => {
        const ok = await putSettings(projectId, { web: { testTimeoutSeconds: 900, workers: 1 }, api: { testTimeoutSeconds: 120 } }, "Maya");
        expect(ok.status, ok.text).toBe(200);
        expect(ok.body.settings.web).toEqual({ headless: true, workers: 1, testTimeoutSeconds: 300 });
        expect(ok.body.settings.api.testTimeoutSeconds).toBe(120);
        expect(ok.body.adjusted).toEqual(["The web test time limit was set to 300 seconds, the most allowed."]);
        expect(ok.body.effective.web).toMatchObject({ workers: 1, workersLimit: 1, testTimeoutSeconds: 300 });
        expect(ok.body.changes[0]).toMatchObject({ by: "Maya", summary: "Workers platform value to 1; Web time limit 60 s to 300 s; API time limit 60 s to 120 s" });
        // the next read says the same thing
        expect((await getSettings(projectId)).settings.web.testTimeoutSeconds).toBe(300);

        const bad = [
            [{ web: { testTimeoutSeconds: "soon" } }, "The web test time limit must be a number."],
            [{ enabled: { taqwright: "no" } }, "Android tests must be on or off."],
            // retries are deliberately not offered: they hide flaky tests
            [{ web: { retries: 2 } }, "Unknown setting: retries."],
            [{ retries: 2 }, "Unknown setting: retries."],
        ] as const;
        for (const [settings, message] of bad) {
            const r = await putSettings(projectId, settings);
            expect(r.status, JSON.stringify(settings)).toBe(400);
            expect(r.body.error).toBe(message);
        }
        expect((await call("PUT", `/api/projects/${projectId}/framework-settings`, "nonsense")).status).toBe(400);
        // none of the refused updates changed anything
        expect((await getSettings(projectId)).settings.web.testTimeoutSeconds).toBe(300);
    });

    it("refuses a visible browser while the project runs on this server, and an emulator nobody knows", async () => {
        const headed = await putSettings(projectId, { web: { headless: false } });
        expect(headed.status).toBe(400);
        expect(headed.body.error).toMatch(/only opens when this project's tests run on a runner, where/);
        const avd = await putSettings(projectId, { android: { defaultAvd: "Pixel_Nobody_Has" } });
        expect(avd.status).toBe(400);
        expect(avd.body.error).toContain("Pixel_Nobody_Has");
        expect((await getSettings(projectId)).settings.web.headless).toBe(true);
    });

    it("keeps the last changes in an append-only log, newest first, ten at most", async () => {
        const id = await newProject("Settings log");
        for (let n = 31; n <= 42; n++) expect((await putSettings(id, { web: { testTimeoutSeconds: n } })).status).toBe(200);
        // saving the same values again adds nothing
        await putSettings(id, { web: { testTimeoutSeconds: 42 } });
        const r = await getSettings(id);
        expect(r.changes).toHaveLength(10);
        expect(r.changes[0].summary).toBe("Web time limit 41 s to 42 s");
        expect(r.changes[9].summary).toBe("Web time limit 32 s to 33 s");
        expect(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM framework_settings_log WHERE project_id = ?", id)!.n).toBe(12);
        // the log can only grow: there is no route to change or remove a line
        expect((await call("DELETE", `/api/projects/${id}/framework-settings`)).status).toBe(404);
    });

    it("one project's settings never reach another's", async () => {
        const other = await newProject("Somebody else");
        expect((await getSettings(other)).settings).toEqual(JSON.parse(JSON.stringify(DEFAULT_FRAMEWORK_SETTINGS)));
        expect((await getSettings(projectId)).settings.web.testTimeoutSeconds).toBe(300);
        expect((await getSettings(other)).changes).toEqual([]);
    });

    it("is refused with a 409 while a job of the project is running", async () => {
        const id = await newProject("Busy");
        const app = platform.repo.createApplication(id, APP, { ...DEFAULT_JOB_OPTIONS }, undefined);
        const job = await platform.repo.createJob(id, app, { ...DEFAULT_JOB_OPTIONS, startedBy: { kind: "user", id: runOwner() }, mode: "validate", testIds: [] });
        const busy = await putSettings(id, { web: { testTimeoutSeconds: 90 } });
        expect(busy.status).toBe(409);
        expect(busy.body.error).toMatch(/running|job/i);
        expect((await getSettings(id)).settings.web.testTimeoutSeconds).toBe(60);
        platform.repo.setJobStatus(job.id, "FAILED", "test over");
        expect((await putSettings(id, { web: { testTimeoutSeconds: 90 } })).status).toBe(200);
    });
});

describe("frameworks a project switched off, on this server", () => {
    let projectId = "";
    const ids: Record<string, string> = {};

    beforeAll(async () => {
        worker = new Worker(platform, 150);
        worker.start();
        projectId = await newProject("Switched off");
        const imp = await call("POST", `/api/projects/${projectId}/specs`, { baseUrl: APP, validate: false, specs: [WEB, API] });
        expect(imp.status, imp.text).toBe(202);
        [ids.web, ids.api] = imp.body.tests.map((t: { id: string }) => t.id);
    }, 60_000);

    it("refuses to import and to run API tests with a plain reason, while web tests are accepted", async () => {
        expect((await putSettings(projectId, { enabled: { "playwright-api": false }, web: { testTimeoutSeconds: 120 } })).status).toBe(200);
        const message = "API tests are turned off for this project. Turn them on under Runners, Frameworks.";
        const before = (await call("GET", `/api/projects/${projectId}/tests`)).body.length;
        const imp = await call("POST", `/api/projects/${projectId}/specs`, { baseUrl: APP, validate: false, specs: [{ ...API, title: "Another API check" }] });
        expect(imp.status).toBe(409);
        expect(imp.body.error).toBe(message);
        // an import is all or nothing: a web test in the same file is not stored either
        const mixed = await call("POST", `/api/projects/${projectId}/specs`, { baseUrl: APP, validate: false, specs: [{ ...WEB, title: "Another web check" }, { ...API, title: "Another API check" }] });
        expect(mixed.status).toBe(409);
        expect((await call("GET", `/api/projects/${projectId}/tests`)).body).toHaveLength(before);
        const web = await call("POST", `/api/projects/${projectId}/specs`, { baseUrl: APP, validate: false, specs: [{ ...WEB, title: "Another web check" }] });
        expect(web.status).toBe(202);

        const run = await call("POST", `/api/tests/${ids.api}/validate`);
        expect(run.status).toBe(409);
        expect(run.body.error).toBe(message);
        // nothing was queued
        expect((await call("GET", `/api/projects/${projectId}/jobs`)).body.filter((j: { status: string }) => j.status === "QUEUED")).toEqual([]);
    });

    it("a run with both leaves the API test out, says so, and really runs the web test in Chromium with the project's limit", async () => {
        const appId = platform.repo.createApplication(projectId, APP, { ...DEFAULT_JOB_OPTIONS }, undefined);
        const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, startedBy: { kind: "user", id: runOwner() }, mode: "validate", testIds: [ids.web!, ids.api!] });
        const done = await jobDone(job.id);
        expect(done.status).toBe("COMPLETED");
        const events = await eventsOf(job.id);
        expect(events.find((e) => e.kind === "framework_settings")?.message).toBe("Running with api tests turned off, a 120 s test timeout for web tests.");
        expect(events.find((e) => e.kind === "validation_not_executed")?.message).toContain("API tests are turned off for this project");
        expect((await call("GET", `/api/tests/${ids.web}/executions`)).body[0]).toMatchObject({ status: "passed" });
        expect((await call("GET", `/api/tests/${ids.api}/executions`)).body).toEqual([]);
        const tests = (await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; validationStatus: string }>;
        expect(tests.find((t) => t.id === ids.web)!.validationStatus).toBe("VALIDATED");
        expect(tests.find((t) => t.id === ids.api)!.validationStatus).not.toBe("VALIDATED");
    }, 180_000);

    it("schedules, triggers and runbooks leave the switched-off tests out", async () => {
        const { runnableTestIds } = await import("../src/platform/scheduler.js");
        const ran = await runnableTestIds(platform.repo, projectId);
        expect(ran).toContain(ids.web);
        expect(ran).not.toContain(ids.api);
        expect((await putSettings(projectId, { enabled: { "playwright-api": true } })).status).toBe(200);
        expect(await runnableTestIds(platform.repo, projectId)).toContain(ids.api);
    });

    it("a project that turned everything it has off cannot start an analysis, and one that turned off one kind gets only the other", async () => {
        const id = await newProject("Analysis");
        const appId = platform.repo.createApplication(id, APP, { ...DEFAULT_JOB_OPTIONS }, undefined);
        await putSettings(id, { enabled: { "playwright-api": false } });
        const job = await platform.repo.createJob(id, appId, { ...DEFAULT_JOB_OPTIONS, startedBy: { kind: "user", id: runOwner() }, mode: "generate" });
        expect(job.options.targets).toEqual(["web"]);
        platform.repo.setJobStatus(job.id, "FAILED", "test over");
        await putSettings(id, { enabled: { playwright: false } });
        await expect(platform.repo.createJob(id, appId, { ...DEFAULT_JOB_OPTIONS, startedBy: { kind: "user", id: runOwner() }, mode: "generate" })).rejects.toThrow("Web tests are turned off for this project");
    });
});

describe("tasks for a runner agent", () => {
    let projectId = "";
    let phone: FakeAgent;
    const ids: Record<string, string> = {};

    /** Run one test on the agent and hand back the task the platform offered. */
    async function runOnAgent(testId: string) {
        const started = await call("POST", `/api/tests/${testId}/validate`);
        expect(started.status, started.text).toBe(202);
        const offer = await phone.next();
        expect(offer, "the platform offered no task").toBeDefined();
        expect((await phone.answer(offer!, {})).status).toBe(200);
        await jobDone(started.body.jobId);
        return { offer: offer!, jobId: started.body.jobId as string };
    }
    const normal = (o: unknown) => JSON.stringify({ ...(o as object), taskId: "-", jobId: "-" });

    beforeAll(async () => {
        projectId = await newProject("On an agent");
        const token = personalRunner(platform, { label: "maya", replace: true }).secret;
        phone = new FakeAgent(viaFetch(BASE), token, { name: "Maya's laptop", capabilities: defaultCaps({ android: { adb: true, devices: [], avds: ["Pixel_6", "Pixel_7"] } }), concurrency: 1 });
        expect((await phone.hello()).status).toBe(200);
        const imp = await call("POST", `/api/projects/${projectId}/specs`, { baseUrl: APP, validate: false, mobile: { appPackage: "com.example.shop" }, specs: [WEB, API, MOBILE] });
        expect(imp.status, imp.text).toBe(202);
        [ids.web, ids.api, ids.mobile] = imp.body.tests.map((t: { id: string }) => t.id);
        expect((await call("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent" })).status).toBe(200);
    }, 60_000);

    it("an untouched project gets exactly the task it always got, and no settings event", async () => {
        const { offer, jobId } = await runOnAgent(ids.web!);
        // golden: the keys of today's task for a web test (nothing about time limits, no browser choice beyond env.headless)
        expect(Object.keys(offer).sort()).toEqual(["adapterId", "env", "jobId", "leaseSeconds", "scripts", "taskId", "workers"]);
        expect(offer).toMatchObject({ adapterId: "playwright", workers: 2, env: { headless: true } });
        expect((await eventsOf(jobId)).filter((e) => e.kind.startsWith("framework_settings"))).toEqual([]);
        // a project that changed things and put them all back gets the same task again
        expect((await putSettings(projectId, { web: { testTimeoutSeconds: 120, workers: 1 } })).status).toBe(200);
        expect((await putSettings(projectId, JSON.parse(JSON.stringify(DEFAULT_FRAMEWORK_SETTINGS)))).status).toBe(200);
        const again = await runOnAgent(ids.web!);
        expect(normal(again.offer)).toBe(normal(offer));
        expect((await eventsOf(again.jobId)).filter((e) => e.kind.startsWith("framework_settings"))).toEqual([]);
    }, 120_000);

    it("carries the web time limit, a worker cap and a visible window in the task, and states them in the run's events", async () => {
        // a visible window is allowed here: the project runs on an agent
        const put = await putSettings(projectId, { web: { testTimeoutSeconds: 120, workers: 1, headless: false } });
        expect(put.status, put.text).toBe(200);
        expect(put.body.effective.web).toMatchObject({ headless: false, workers: 1, testTimeoutSeconds: 120 });
        expect(put.body.runner).toMatchObject({ runOn: "agent", agentName: "Maya's laptop" });
        const { offer, jobId } = await runOnAgent(ids.web!);
        expect(offer).toMatchObject({ adapterId: "playwright", workers: 1, testTimeoutMs: 120_000, env: { headless: false } });
        expect(offer.startTimeoutMs).toBeUndefined();
        const events = await eventsOf(jobId);
        expect(events.find((e) => e.kind === "framework_settings")?.message).toBe("Running with a visible browser window, at most 1 browser worker, a 120 s test timeout for web tests.");
        // the API test is a different framework with its own limit: the web limit does not leak into it
        const api = await runOnAgent(ids.api!);
        expect(api.offer.testTimeoutMs).toBeUndefined();
        expect(api.offer.workers).toBe(1);
    }, 120_000);

    it("carries the Android limit, the kept emulator and the default emulator the project chose from its agent's emulators", async () => {
        const unknown = await putSettings(projectId, { android: { defaultAvd: "Pixel_9" } });
        expect(unknown.status).toBe(400);
        expect(unknown.body.error).toBe("The emulator “Pixel_9” is not one of the known emulators (Pixel_6, Pixel_7).");
        const put = await putSettings(projectId, { android: { defaultAvd: "Pixel_7", keepEmulator: true, testTimeoutSeconds: 240 } });
        expect(put.status, put.text).toBe(200);
        expect(put.body.avds).toEqual(["Pixel_6", "Pixel_7"]);
        const { offer } = await runOnAgent(ids.mobile!);
        expect(offer).toMatchObject({ adapterId: "taqwright", testTimeoutMs: 240_000, mobile: { appPackage: "com.example.shop", avd: "Pixel_7", keepEmulator: true } });
        // the web credentials never go to a device run, with or without settings
        expect(offer.env.credentials).toBeUndefined();
    }, 120_000);

    it("a switched-off framework is not offered to the agent at all", async () => {
        expect((await putSettings(projectId, { enabled: { taqwright: false } })).status).toBe(200);
        const run = await call("POST", `/api/tests/${ids.mobile}/validate`);
        expect(run.status).toBe(409);
        expect(run.body.error).toBe("Android tests are turned off for this project. Turn them on under Runners, Frameworks.");
        expect((await phone.poll()).status).toBe(204);
        await putSettings(projectId, { enabled: { taqwright: true } });
    }, 60_000);

    it("moving the project back to this server runs headless, keeps what was chosen, and says why", async () => {
        expect((await call("PUT", `/api/projects/${projectId}/runner`, { runOn: "platform" })).status).toBe(200);
        const r = await getSettings(projectId);
        expect(r.settings.web.headless).toBe(false); // the choice is kept for when it runs on an agent again
        expect(r.effective.web.headless).toBe(true);
        expect(r.effective.notes[0]).toMatch(/Headed browsers only open on a runner agent/);
        // other changes are still accepted; only asking for a window is refused
        expect((await putSettings(projectId, { web: { testTimeoutSeconds: 90 } })).status).toBe(200);
        expect((await putSettings(projectId, { web: { headless: false } })).status).toBe(400);
    });
});
