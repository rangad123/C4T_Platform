/**
 * Test suites a person builds (routes/suites.ts, suite-store.ts, suite-run.ts), without a browser or a worker:
 *  - the store and routes: create, rename, describe, add (once each, at a position), remove, reorder, duplicate, delete;
 *  - another project's suite or test reads as unknown (404 / 400), and each route needs the permission it says;
 *  - a run queues exactly the suite's tests in the suite's order with its settings, and says plainly when nothing would pick it up;
 *  - a schedule can run a suite, and a suite a schedule runs cannot be deleted from under it.
 * Drafts never run: a test with no approved version is held back by name. Most projects here switch approval off, so the rest is about suites.
 * Stopping at the first failure is proven with real runs in tests/suites-run.test.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { defaultFramework } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { permissionRuleFor } from "../src/platform/auth/roles.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { ReviewStore } from "../src/platform/review-store.js";
import { getScheduleServices } from "../src/platform/schedule-services.js";
import { buildServer } from "../src/platform/server.js";
import { NO_WORKER_MESSAGE, runsCanStartHere } from "../src/platform/suite-run.js";

const SCRATCH = os.tmpdir();
const KEY = "suites-owner-key-7a1c";
const APP_URL = "http://127.0.0.1:7726";
type App = Awaited<ReturnType<typeof buildServer>>;

let dir: string;
let platform: Platform;
let app: App;
let A: string;
let B: string;
const testsA: string[] = [];
let testB: string;

const call = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = { "x-api-key": KEY }) => {
    const res = await app.inject({ method: method as "GET", url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: res.statusCode, body: res.body && /^[{[]/.test(res.body) ? JSON.parse(res.body) : res.body } as { status: number; body: any };
};

function addTest(projectId: string, key: string): string {
    const spec = TestSpecSchema.parse({ testId: key, title: `Check ${key}`, kind: "api", category: "Shop", steps: [{ action: "request", method: "GET", path: `/api/${key.toLowerCase()}` }, { action: "assertResponse", check: "status", expected: 200 }] });
    const suite = platform.repo.getOrCreateSuite(projectId, "Shop", "shop");
    return platform.repo.insertTest({ projectId, suiteId: suite, jobId: null, spec, framework: defaultFramework("api"), validationStatus: "PENDING" });
}

/** Every change counts as approved in this project (the review policy), so its tests run. */
const noApprovalNeeded = (p: Platform, projectId: string) => new ReviewStore(p.db).setPolicy(projectId, { aiGenerated: false, edits: false, healing: false }, "test");

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(SCRATCH, "suites-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", API_KEY: KEY, SECRET_KEY: "suites-test-secret-key-0123456789" }));
    app = await buildServer(platform);
    await app.ready();
    A = (await call("POST", "/api/projects", { name: "Alpha" })).body.id;
    B = (await call("POST", "/api/projects", { name: "Bravo" })).body.id;
    for (const pid of [A, B]) noApprovalNeeded(platform, pid);
    platform.repo.createApplication(A, APP_URL, { ...DEFAULT_JOB_OPTIONS });
    platform.repo.createApplication(B, APP_URL, { ...DEFAULT_JOB_OPTIONS });
    for (const k of ["API-001", "API-002", "API-003", "API-004"]) testsA.push(addTest(A, k));
    testB = addTest(B, "API-900");
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const [t1, t2, t3, t4] = [0, 1, 2, 3].map((i) => () => testsA[i]!);
const order = async (projectId: string, sid: string) => (await call("GET", `/api/projects/${projectId}/test-suites/${sid}`)).body.tests.map((t: { id: string }) => t.id);
/** No job left active, so the next run may start (one active job per project). */
const finishJobs = () => platform.db.run("UPDATE generation_jobs SET status = 'COMPLETED', finished_at = ? WHERE status NOT IN ('COMPLETED','PARTIALLY_COMPLETED','FAILED')", new Date().toISOString());

describe("building a suite", () => {
    let sid: string;

    it("creates a suite with tests in the order given, and lists it beside the groups by area", async () => {
        const made = await call("POST", `/api/projects/${A}/test-suites`, { name: "Smoke", description: "The quick check", testIds: [t3(), t1()] });
        expect(made.status).toBe(201);
        expect(made.body).toMatchObject({ name: "Smoke", description: "The quick check", testCount: 2, settings: { environment: null, browsers: [], retries: 0, stopOnFirstFailure: false } });
        sid = made.body.id;
        expect(await order(A, sid)).toEqual([t3(), t1()]);
        const list = (await call("GET", `/api/projects/${A}/test-suites`)).body;
        expect(list.suites.map((s: { name: string }) => s.name)).toEqual(["Smoke"]);
        expect(list.automatic.map((s: { name: string }) => s.name)).toEqual(["Shop"]);
        expect(list.canRun).toEqual({ ok: true });
        // The automatic groups keep their own route and shape.
        expect((await call("GET", `/api/projects/${A}/suites`)).body[0]).toMatchObject({ name: "Shop" });
    });

    it("refuses a second suite of the same name, an empty name and unknown fields", async () => {
        expect((await call("POST", `/api/projects/${A}/test-suites`, { name: "smoke" })).status).toBe(409);
        expect((await call("POST", `/api/projects/${A}/test-suites`, { name: "  " })).status).toBe(400);
        expect((await call("POST", `/api/projects/${A}/test-suites`, { name: "X", colour: "red" })).status).toBe(400);
    });

    it("adds tests once each, at the end or at a position, and removes one", async () => {
        const add = await call("POST", `/api/projects/${A}/test-suites/${sid}/tests`, { testIds: [t2(), t1()] });
        expect(add.body).toMatchObject({ added: 1, alreadyIn: 1 });
        expect(await order(A, sid)).toEqual([t3(), t1(), t2()]);
        await call("POST", `/api/projects/${A}/test-suites/${sid}/tests`, { testIds: [t4()], position: 0 });
        expect(await order(A, sid)).toEqual([t4(), t3(), t1(), t2()]);
        expect((await call("DELETE", `/api/projects/${A}/test-suites/${sid}/tests/${t3()}`)).body.testIds).toEqual([t4(), t1(), t2()]);
        expect((await call("DELETE", `/api/projects/${A}/test-suites/${sid}/tests/${t3()}`)).status).toBe(404);
    });

    it("reorders only to an order of exactly the suite's tests", async () => {
        expect((await call("PUT", `/api/projects/${A}/test-suites/${sid}/order`, { testIds: [t1(), t2(), t4()] })).body.testIds).toEqual([t1(), t2(), t4()]);
        for (const bad of [[t1(), t2()], [t1(), t2(), t4(), t3()], [t1(), t1(), t2()]]) expect((await call("PUT", `/api/projects/${A}/test-suites/${sid}/order`, { testIds: bad })).status).toBe(400);
        expect(await order(A, sid)).toEqual([t1(), t2(), t4()]);
    });

    it("renames and describes, keeping names unique", async () => {
        const other = (await call("POST", `/api/projects/${A}/test-suites`, { name: "Full" })).body.id;
        expect((await call("PATCH", `/api/projects/${A}/test-suites/${other}`, { name: "SMOKE" })).status).toBe(409);
        expect((await call("PATCH", `/api/projects/${A}/test-suites/${sid}`, { name: "Smoke check", description: "" })).body).toMatchObject({ name: "Smoke check", description: "" });
        expect((await call("DELETE", `/api/projects/${A}/test-suites/${other}`)).status).toBe(204);
        expect((await call("GET", `/api/projects/${A}/test-suites/${other}`)).status).toBe(404);
    });

    it("duplicates with the same tests, order and settings under a new name", async () => {
        await call("PATCH", `/api/projects/${A}/test-suites/${sid}`, { settings: { retries: 1, browsers: ["firefox"] } });
        const copy = await call("POST", `/api/projects/${A}/test-suites/${sid}/duplicate`, {});
        expect(copy.status).toBe(201);
        expect(copy.body).toMatchObject({ name: "Copy of Smoke check", testCount: 3, settings: { retries: 1, browsers: ["firefox"] } });
        expect(await order(A, copy.body.id)).toEqual([t1(), t2(), t4()]);
        expect((await call("POST", `/api/projects/${A}/test-suites/${sid}/duplicate`, {})).body.name).toBe("Copy of Smoke check (2)");
    });

    it("a deleted test leaves the suite", async () => {
        const extra = addTest(A, "API-005");
        await call("POST", `/api/projects/${A}/test-suites/${sid}/tests`, { testIds: [extra] });
        platform.db.run("DELETE FROM test_cases WHERE id = ?", extra);
        expect(await order(A, sid)).toEqual([t1(), t2(), t4()]);
    });
});

describe("settings", () => {
    let sid: string;
    beforeAll(async () => {
        sid = (await call("POST", `/api/projects/${A}/test-suites`, { name: "Settings", testIds: [t1()] })).body.id;
        expect((await call("POST", `/api/projects/${A}/environments`, { name: "staging", baseUrl: APP_URL })).status).toBe(201);
        expect((await call("POST", `/api/projects/${A}/environments`, { name: "live", baseUrl: APP_URL, production: true })).status).toBe(201);
    });

    it("needs an environment that exists, and a confirmation for production", async () => {
        expect((await call("PATCH", `/api/projects/${A}/test-suites/${sid}`, { settings: { environment: "nowhere" } })).status).toBe(404);
        const prod = await call("PATCH", `/api/projects/${A}/test-suites/${sid}`, { settings: { environment: "live" } });
        expect(prod.status).toBe(409);
        expect(prod.body.details).toMatchObject({ requiresConfirmation: true });
        expect((await call("PATCH", `/api/projects/${A}/test-suites/${sid}`, { settings: { environment: "live", confirmProduction: true } })).body.settings).toMatchObject({ environment: "live", confirmProduction: true });
        // Another environment needs its own confirmation; the project's own address needs none.
        expect((await call("PATCH", `/api/projects/${A}/test-suites/${sid}`, { settings: { environment: "staging" } })).body.settings).toMatchObject({ environment: "staging", confirmProduction: false });
        expect((await call("PATCH", `/api/projects/${A}/test-suites/${sid}`, { settings: { environment: null } })).body.settings).toMatchObject({ environment: null, confirmProduction: false });
    });

    it("refuses options an environment run cannot honour, in words", async () => {
        const r = await call("PATCH", `/api/projects/${A}/test-suites/${sid}`, { settings: { environment: "staging", stopOnFirstFailure: true } });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/environment/);
        expect((await call("PATCH", `/api/projects/${A}/test-suites/${sid}`, { settings: { retries: 3 } })).status).toBe(400);
        expect((await call("PATCH", `/api/projects/${A}/test-suites/${sid}`, { settings: { browsers: ["netscape"] } })).status).toBe(400);
    });
});

describe("another project's suites and tests", () => {
    let sid: string;
    beforeAll(async () => {
        sid = (await call("POST", `/api/projects/${A}/test-suites`, { name: "Private", testIds: [t1()] })).body.id;
    });

    it("answers 404 for a suite reached through another project", async () => {
        for (const [m, u, body] of [
            ["GET", "", undefined],
            ["PATCH", "", { name: "Mine" }],
            ["DELETE", "", undefined],
            ["POST", "/tests", { testIds: [testB] }],
            ["DELETE", `/tests/${t1()}`, undefined],
            ["PUT", "/order", { testIds: [t1()] }],
            ["POST", "/duplicate", {}],
            ["POST", "/run", {}],
        ] as const) {
            const r = await call(m, `/api/projects/${B}/test-suites/${sid}${u}`, body);
            expect(r.status, `${m} ${u}`).toBe(404);
            expect(r.body.error).toBe("Suite not found");
        }
        expect((await call("GET", `/api/projects/${A}/test-suites/${sid}`)).body.suite.name).toBe("Private");
    });

    it("treats another project's test as unknown", async () => {
        expect((await call("POST", `/api/projects/${A}/test-suites/${sid}/tests`, { testIds: [testB] })).status).toBe(400);
        expect((await call("POST", `/api/projects/${A}/test-suites`, { name: "Mixed", testIds: [t1(), testB] })).status).toBe(400);
        expect(await order(A, sid)).toEqual([t1()]);
    });
});

describe("permissions", () => {
    it("reads with access, changes with tests.write and runs with tests.run", () => {
        expect(permissionRuleFor("GET", "/api/projects/:id/test-suites")).toBe("read");
        expect(permissionRuleFor("GET", "/api/projects/:id/test-suites/:sid")).toBe("read");
        for (const [m, t] of [
            ["POST", ""],
            ["PATCH", "/:sid"],
            ["DELETE", "/:sid"],
            ["POST", "/:sid/tests"],
            ["DELETE", "/:sid/tests/:testId"],
            ["PUT", "/:sid/order"],
            ["POST", "/:sid/duplicate"],
        ]) expect(permissionRuleFor(m!, `/api/projects/:id/test-suites${t}`), `${m} ${t}`).toBe("ai_studio.tests.write");
        expect(permissionRuleFor("POST", "/api/projects/:id/test-suites/:sid/run")).toBe("ai_studio.tests.run");
    });

    it("lets a viewer look but not change or run, and an editor change", async () => {
        const users = accessControlOf(app).users;
        const viewer = users.create({ email: "vic@example.com", name: "Vic", role: "viewer" });
        const editor = users.create({ email: "eve@example.com", name: "Eve", role: "editor" });
        const v = { authorization: `Bearer ${users.createToken(viewer.id, { name: "t", role: "viewer" }).token}` };
        const e = { authorization: `Bearer ${users.createToken(editor.id, { name: "t", role: "editor" }).token}` };
        const sid = (await call("POST", `/api/projects/${A}/test-suites`, { name: "Perm", testIds: [t1()] })).body.id;
        expect((await call("GET", `/api/projects/${A}/test-suites`, undefined, v)).status).toBe(200);
        expect((await call("GET", `/api/projects/${A}/test-suites/${sid}`, undefined, v)).status).toBe(200);
        expect((await call("POST", `/api/projects/${A}/test-suites`, { name: "Nope" }, v)).status).toBe(403);
        expect((await call("PUT", `/api/projects/${A}/test-suites/${sid}/order`, { testIds: [t1()] }, v)).status).toBe(403);
        expect((await call("POST", `/api/projects/${A}/test-suites/${sid}/run`, {}, v)).status).toBe(403);
        expect((await call("POST", `/api/projects/${A}/test-suites`, { name: "By Eve" }, e)).status).toBe(201);
        expect(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM generation_jobs WHERE project_id = ?", A)!.n).toBe(0);
    });
});

describe("running a suite", () => {
    let sid: string;
    beforeAll(async () => {
        sid = (await call("POST", `/api/projects/${A}/test-suites`, { name: "Ordered", testIds: [t4(), t2(), t1()], settings: { retries: 2, browsers: ["tablet", "firefox"], stopOnFirstFailure: true } })).body.id;
    });

    it("queues exactly the suite's tests, in its order, with its settings", async () => {
        const r = await call("POST", `/api/projects/${A}/test-suites/${sid}/run`, {});
        expect(r.status).toBe(202);
        expect(r.body).toMatchObject({ testCount: 3, skipped: [] });
        const job = platform.repo.getJob(r.body.jobId)!;
        expect(job.status).toBe("QUEUED");
        expect(job.options).toMatchObject({ mode: "validate", testIds: [t4(), t2(), t1()], retryFailures: 2, variants: ["firefox", "tablet"], stopOnFirstFailure: true });
        expect(job.options.trigger).toBeUndefined();
        const detail = (await call("GET", `/api/projects/${A}/test-suites/${sid}`)).body;
        expect(detail.runs).toHaveLength(1);
        expect(detail.runs[0]).toMatchObject({ jobId: job.id, trigger: "manual", testCount: 3, job: { status: "QUEUED" } });
        // One active job per project, as for every run.
        expect((await call("POST", `/api/projects/${A}/test-suites/${sid}/run`, {})).status).toBe(409);
        finishJobs();
    });

    it("runs against the suite's environment through the environment run", async () => {
        const env = (await call("POST", `/api/projects/${A}/test-suites`, { name: "On staging", testIds: [t2(), t1()], settings: { environment: "staging" } })).body.id;
        const r = await call("POST", `/api/projects/${A}/test-suites/${env}/run`, {});
        expect(r.status).toBe(202);
        expect(platform.repo.getJob(r.body.jobId)!.options).toMatchObject({ mode: "environment", environment: "staging", testIds: [t2(), t1()] });
        finishJobs();
    });

    it("holds back a test that waits for approval, by name, and runs the rest", async () => {
        const reviews = new ReviewStore(platform.db);
        reviews.setPolicy(A, { edits: true, soleAdminSelfApprove: false }, "test");
        const draft = addTest(A, "API-010");
        reviews.setPolicy(A, { edits: false }, "test");
        expect(reviews.approved(draft)).toBeUndefined();
        const s = (await call("POST", `/api/projects/${A}/test-suites`, { name: "With a draft", testIds: [draft, t1()] })).body.id;
        const r = await call("POST", `/api/projects/${A}/test-suites/${s}/run`, {});
        expect(r.status).toBe(202);
        expect(r.body.skipped).toEqual([{ id: draft, testId: "API-010", reason: expect.stringMatching(/waiting for approval/) }]);
        expect(platform.repo.getJob(r.body.jobId)!.options.testIds).toEqual([t1()]);
        finishJobs();
        const only = (await call("POST", `/api/projects/${A}/test-suites`, { name: "Only a draft", testIds: [draft] })).body.id;
        const none = await call("POST", `/api/projects/${A}/test-suites/${only}/run`, {});
        expect(none.status).toBe(422);
        expect(none.body.error).toMatch(/waiting for approval/);
        platform.db.run("DELETE FROM test_cases WHERE id = ?", draft);
    });

    it("refuses an empty suite in words", async () => {
        const empty = (await call("POST", `/api/projects/${A}/test-suites`, { name: "Empty" })).body.id;
        const r = await call("POST", `/api/projects/${A}/test-suites/${empty}/run`, {});
        expect(r.status).toBe(422);
        expect(r.body.error).toMatch(/no tests yet/);
    });

    it("says plainly that tests cannot run here when nothing picks up a run, and queues nothing", async () => {
        const offDir = fs.mkdtempSync(path.join(SCRATCH, "suites-noworker-"));
        const off = bootstrap(loadConfig({ DATA_DIR: offDir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", SECRET_KEY: "suites-test-secret-key-0123456789" }));
        const offApp = await buildServer(off);
        try {
            const inj = async (method: string, url: string, payload?: unknown) => {
                const res = await offApp.inject({ method: method as "GET", url, ...(payload !== undefined ? { payload: payload as object } : {}) });
                return { status: res.statusCode, body: JSON.parse(res.body || "null") };
            };
            const pid = (await inj("POST", "/api/projects", { name: "Hosted" })).body.id;
            noApprovalNeeded(off, pid);
            off.repo.createApplication(pid, APP_URL, { ...DEFAULT_JOB_OPTIONS });
            const spec = TestSpecSchema.parse({ testId: "API-001", title: "One", kind: "api", category: "Shop", steps: [{ action: "request", method: "GET", path: "/api/x" }] });
            const tid = off.repo.insertTest({ projectId: pid, suiteId: off.repo.getOrCreateSuite(pid, "Shop", "shop"), jobId: null, spec, framework: defaultFramework("api"), validationStatus: "PENDING" });
            const s = (await inj("POST", `/api/projects/${pid}/test-suites`, { name: "Smoke", testIds: [tid] })).body.id;
            expect((await inj("GET", `/api/projects/${pid}/test-suites`)).body.canRun).toEqual({ ok: false, reason: NO_WORKER_MESSAGE });
            const r = await inj("POST", `/api/projects/${pid}/test-suites/${s}/run`, {});
            expect(r.status).toBe(409);
            expect(r.body.error).toBe(NO_WORKER_MESSAGE);
            expect(off.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM generation_jobs")!.n).toBe(0);
            // A worker in another process that said it is alive just now is enough.
            off.db.run("INSERT INTO ops_heartbeats (name, at, pid) VALUES ('worker', ?, 1)", Date.now());
            expect(runsCanStartHere(off)).toEqual({ ok: true });
            expect(runsCanStartHere(off, Date.now() + 120_000).ok).toBe(false);
        } finally {
            await offApp.close();
            off.db.close();
            fs.rmSync(offDir, { recursive: true, force: true });
        }
    });
});

describe("schedules on suites", () => {
    let sid: string;
    let schedId: string;
    beforeAll(async () => {
        finishJobs();
        sid = (await call("POST", `/api/projects/${A}/test-suites`, { name: "Nightly", testIds: [t2(), t4()], settings: { retries: 1 } })).body.id;
    });

    it("creates a schedule that runs the suite, and shows it on both sides", async () => {
        const r = await call("POST", `/api/projects/${A}/schedules`, { kind: "validate", cadence: { type: "daily", time: "02:00" }, suiteId: sid });
        expect(r.status).toBe(201);
        expect(r.body).toMatchObject({ suiteId: sid, suiteName: "Nightly", runbookId: null });
        schedId = r.body.id;
        expect((await call("GET", `/api/projects/${A}/schedules`)).body.schedules.find((s: { id: string }) => s.id === schedId)).toMatchObject({ suiteName: "Nightly" });
        expect((await call("GET", `/api/projects/${A}/test-suites/${sid}`)).body.schedules).toEqual([{ id: schedId, name: r.body.name, enabled: true }]);
    });

    it("runs exactly the suite's tests, in order, with its settings, as a scheduled run", async () => {
        const job = await getScheduleServices(platform).runNow(schedId);
        if ("runbookRunId" in job) throw new Error("expected a job");
        expect(job.options).toMatchObject({ mode: "validate", testIds: [t2(), t4()], retryFailures: 1, trigger: "schedule", scheduleId: schedId });
        const runs = (await call("GET", `/api/projects/${A}/test-suites/${sid}`)).body.runs;
        expect(runs[0]).toMatchObject({ jobId: job.id, trigger: "schedule", scheduleId: schedId });
        finishJobs();
    });

    it("refuses a suite of another project, an analysis, or a suite with a run sequence", async () => {
        const otherSuite = (await call("POST", `/api/projects/${B}/test-suites`, { name: "B suite", testIds: [testB] })).body.id;
        expect((await call("POST", `/api/projects/${A}/schedules`, { kind: "validate", cadence: { type: "daily", time: "03:00" }, suiteId: otherSuite })).status).toBe(404);
        expect((await call("POST", `/api/projects/${A}/schedules`, { kind: "generate", cadence: { type: "daily", time: "03:00" }, suiteId: sid })).status).toBe(400);
        const empty = (await call("POST", `/api/projects/${A}/test-suites`, { name: "Nothing yet" })).body.id;
        expect((await call("POST", `/api/projects/${A}/schedules`, { kind: "validate", cadence: { type: "daily", time: "03:00" }, suiteId: empty })).status).toBe(409);
    });

    it("keeps a scheduled suite from being deleted, and a plain schedule working after the link is removed", async () => {
        const del = await call("DELETE", `/api/projects/${A}/test-suites/${sid}`);
        expect(del.status).toBe(409);
        expect(del.body.error).toMatch(/schedule/);
        const unlinked = await call("PATCH", `/api/projects/${A}/schedules/${schedId}`, { suiteId: null });
        expect(unlinked.body).toMatchObject({ suiteId: null, suiteName: null });
        const job = await getScheduleServices(platform).runNow(schedId);
        if ("runbookRunId" in job) throw new Error("expected a job");
        // A plain "re-run all tests" schedule again: every test of the project.
        expect([...(job.options.testIds ?? [])].sort()).toEqual([...testsA].sort());
        finishJobs();
        expect((await call("DELETE", `/api/projects/${A}/test-suites/${sid}`)).status).toBe(204);
    });

    it("leaves existing schedules as they were", async () => {
        const plain = await call("POST", `/api/projects/${A}/schedules`, { kind: "validate", cadence: { type: "daily", time: "04:00" } });
        expect(plain.status).toBe(201);
        expect(plain.body).toMatchObject({ suiteId: null, suiteName: null, kind: "validate" });
    });
});
