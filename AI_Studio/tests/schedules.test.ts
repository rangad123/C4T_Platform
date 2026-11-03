/**
 * Schedules, run summaries, flaky detection, trends and alerts — everything that needs no browser:
 *  - the scheduler with an injected clock (due / not due / disabled / busy project / restart catch-up / two instances);
 *  - alert delivery to a local fake receiver (payloads, Slack shape, retries, de-duplication, encryption, SSRF);
 *  - run diffs, trends and flaky detection from executions stored the way the worker stores them;
 *  - the HTTP API. Real validation jobs are in schedules-jobs.test.ts.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { defaultFramework } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { Db } from "../src/platform/db.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { getScheduleServices, type ScheduleServices } from "../src/platform/schedule-services.js";
import { describeCadence, nextRunAfter, ScheduleStore } from "../src/platform/schedule-store.js";
import { Scheduler, startScheduledJob } from "../src/platform/scheduler.js";
import { buildServer } from "../src/platform/server.js";
import { detectFlaky } from "../src/platform/trends.js";

const RECEIVER_PORT = 5250;
const RECEIVER = `http://127.0.0.1:${RECEIVER_PORT}`;
const PUBLIC_URL = "https://qa.example.test";
const HOOK_PATH = "/hook/very-secret-token-abc123";

let dataDir: string;
let platform: Platform;
let svc: ScheduleServices;
let server: Awaited<ReturnType<typeof buildServer>>;
let receiver: http.Server;
let clockNow = Date.now();

/** What the fake receiver saw, and how it answers (status per request number). */
const received: Array<{ url: string; body: any; headers: http.IncomingHttpHeaders }> = [];
let answer: (n: number) => number = () => 200;

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sched-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", PUBLIC_URL: `${PUBLIC_URL}/`, ALERT_MIN_SEVERITY: "low" }));
    svc = getScheduleServices(platform, { clock: () => clockNow, delivery: { backoffMs: [5, 5], timeoutMs: 2_000 } });
    server = await buildServer(platform);
    receiver = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            let body: unknown = null;
            try {
                body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
                /* not JSON */
            }
            received.push({ url: req.url ?? "", body, headers: req.headers });
            res.writeHead(answer(received.length), { "content-type": "text/plain" });
            res.end("ok");
        });
    });
    await new Promise<void>((r) => receiver.listen(RECEIVER_PORT, "127.0.0.1", r));
}, 30_000);

afterAll(async () => {
    receiver?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
    received.length = 0;
    answer = () => 200;
    delete process.env.BLOCK_PRIVATE_TARGETS;
});

const call = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, raw: res.body };
};

// ── seeding: rows exactly as the worker writes them ─────────────────────────

const repo = () => platform.repo;
const framework = defaultFramework("api");
let seq = 0;
const T0 = Date.now() - 10 * 86_400_000;
const at = (n: number) => new Date(T0 + n * 60_000).toISOString();

interface Seed {
    projectId: string;
    appId: string;
    tests: Map<string, string>;
    scripts: Map<string, string>;
}

function seedProject(name: string, withApp = true): Seed {
    const project = repo().createProject({ name });
    const appId = withApp ? repo().createApplication(project.id, `http://127.0.0.1:${RECEIVER_PORT}`, { ...DEFAULT_JOB_OPTIONS }) : "";
    return { projectId: project.id, appId, tests: new Map(), scripts: new Map() };
}

function addTest(s: Seed, key: string, title = `Check ${key}`, scriptBody = "v1"): string {
    const spec = TestSpecSchema.parse({ testId: key, title, kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/api/x" }, { action: "assertResponse", check: "status", expected: 200 }] });
    const suite = repo().getOrCreateSuite(s.projectId, "API", "api");
    const id = repo().insertTest({ projectId: s.projectId, suiteId: suite, jobId: null, spec, framework, validationStatus: "PENDING" });
    s.tests.set(key, id);
    newScript(s, key, scriptBody);
    return id;
}

function newScript(s: Seed, key: string, body: string): void {
    const id = repo().addScript(s.tests.get(key)!, { framework, filename: `${key}.spec.ts`, content: body, hash: `h-${key}-${body}`, storagePath: `x/${key}-${body}`, executable: true });
    s.scripts.set(key, id);
}

type Outcome = "pass" | "fail" | "flaky" | `review:${string}`;

/** A finished validation job with executions and test statuses, summarized through the real worker hook. */
async function seedRun(s: Seed, outcomes: Record<string, Outcome>, opts: { trigger?: "manual" | "schedule"; mode?: "validate" } = {}) {
    const ids = Object.keys(outcomes).map((k) => s.tests.get(k)!);
    const job = await repo().createJob(s.projectId, s.appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: ids, trigger: opts.trigger ?? "manual" });
    const failing = Object.values(outcomes).some((o) => o === "fail" || o.startsWith("review"));
    repo().setJobStatus(job.id, failing ? "PARTIALLY_COMPLETED" : "COMPLETED");
    const start = ++seq * 10;
    repo().db.run("UPDATE generation_jobs SET started_at = ?, finished_at = ? WHERE id = ?", at(start), at(start + 5), job.id);
    let tick = start;
    const exec = (key: string, attempt: number, status: "passed" | "failed") => {
        const id = repo().addExecution({ testId: s.tests.get(key)!, scriptId: s.scripts.get(key)!, jobId: job.id, attempt, status, durationMs: 5, error: status === "failed" ? "boom" : undefined, startedAt: at(tick), steps: [] });
        repo().db.run("UPDATE test_executions SET started_at = ?, finished_at = ? WHERE id = ?", at(tick), at(tick), id);
        tick++;
    };
    for (const [key, o] of Object.entries(outcomes)) {
        const id = s.tests.get(key)!;
        if (o === "pass") (exec(key, 1, "passed"), repo().updateTest(id, { validationStatus: "VALIDATED", reason: null }));
        else if (o === "flaky") (exec(key, 1, "failed"), exec(key, 2, "passed"), repo().updateTest(id, { validationStatus: "VALIDATED", reason: null }));
        else if (o === "fail") (exec(key, 1, "failed"), repo().updateTest(id, { validationStatus: "FAILED_VALIDATION", reason: "Step failed: element not found" }));
        else (exec(key, 1, "failed"), repo().updateTest(id, { validationStatus: "NEEDS_REVIEW", reason: o.slice("review:".length) }));
    }
    await svc.onJobFinished(repo().getJob(job.id)!);
    await svc.flush();
    return repo().getJob(job.id)!;
}

const summaryOf = async (s: Seed, jobId: string) => (await call("GET", `/api/projects/${s.projectId}/runs/${jobId}/summary`)).body;
const channelFor = async (s: Seed, extra: Record<string, unknown> = {}) => {
    const r = await call("POST", `/api/projects/${s.projectId}/alert-channels`, { kind: "webhook", url: `${RECEIVER}${HOOK_PATH}`, ...extra });
    expect(r.status, r.raw).toBe(201);
    return r.body as { id: string };
};

// ───────────────────────────────────────────────────────────────────────────

describe("cadence", () => {
    const D = (y: number, m: number, d: number, h: number, mi: number) => new Date(y, m - 1, d, h, mi).getTime();

    it("computes the next run in server local time", () => {
        expect(nextRunAfter({ type: "interval", every: 90, unit: "minutes" }, 1_000)).toBe(1_000 + 90 * 60_000);
        expect(nextRunAfter({ type: "interval", every: 2, unit: "hours" }, 0)).toBe(2 * 3_600_000);
        expect(nextRunAfter({ type: "daily", time: "02:00" }, D(2026, 3, 10, 1, 59))).toBe(D(2026, 3, 10, 2, 0));
        expect(nextRunAfter({ type: "daily", time: "02:00" }, D(2026, 3, 10, 2, 0))).toBe(D(2026, 3, 11, 2, 0)); // strictly after
        // 2026-03-11 is a Wednesday; the next Monday is the 16th
        expect(nextRunAfter({ type: "weekly", weekday: 1, time: "09:30" }, D(2026, 3, 11, 12, 0))).toBe(D(2026, 3, 16, 9, 30));
        expect(nextRunAfter({ type: "weekly", weekday: 3, time: "09:30" }, D(2026, 3, 11, 9, 0))).toBe(D(2026, 3, 11, 9, 30));
        expect(nextRunAfter({ type: "weekly", weekday: 3, time: "09:30" }, D(2026, 3, 11, 9, 30))).toBe(D(2026, 3, 18, 9, 30));
    });

    it("describes cadences in plain words", () => {
        expect(describeCadence({ type: "daily", time: "02:00" })).toBe("Every day at 02:00");
        expect(describeCadence({ type: "weekly", weekday: 1, time: "09:30" })).toBe("Every Monday at 09:30");
        expect(describeCadence({ type: "interval", every: 1, unit: "hours" })).toBe("Every hour");
        expect(describeCadence({ type: "interval", every: 30, unit: "minutes" })).toBe("Every 30 minutes");
    });
});

describe("scheduler (injected clock)", () => {
    const HOUR = 3_600_000;
    // Every tick looks at all due schedules of the database, so each test starts from none.
    beforeEach(() => void platform.db.run("DELETE FROM schedules"));

    /** A scheduler whose job creation is a counter, so these tests are about *when*, not *what*. */
    function rig(store: ScheduleStore, db = platform.db) {
        const started: string[] = [];
        const scheduler = new Scheduler({
            store,
            repo: platform.repo,
            clock: () => clockNow,
            startRun: async (s) => {
                started.push(s.id);
                return await platform.repo.createJob(s.projectId, platform.repo.getLatestApplicationPublic(s.projectId)!.id as string, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [], trigger: "schedule", scheduleId: s.id });
            },
        });
        void db;
        return { started, scheduler };
    }

    it("runs a schedule only when it is due, then moves it to the next slot", async () => {
        const s = seedProject("Due");
        clockNow = new Date(2026, 5, 1, 12, 0).getTime();
        const sched = svc.store.create({ projectId: s.projectId, name: "daily", kind: "validate", cadence: { type: "daily", time: "02:00" } });
        expect(new Date(sched.nextRunAt!).getHours()).toBe(2);
        const { started, scheduler } = rig(svc.store);

        expect(await scheduler.tick()).toEqual([]); // before 02:00 tomorrow: nothing due
        expect(started).toHaveLength(0);

        clockNow = sched.nextRunAt! + 1_000; // 02:00:01
        const r = await scheduler.tick();
        expect(r.map((x) => x.result)).toEqual(["started"]);
        expect(started).toEqual([sched.id]);
        const after = svc.store.get(sched.id)!;
        expect(after.nextRunAt).toBe(nextRunAfter(sched.cadence, clockNow)); // tomorrow 02:00
        expect(after.lastOutcome).toBe("started");
        expect(after.lastJobId).toBe(r[0]!.jobId);

        // Finish the job, then tick again at the same moment: it is no longer due.
        platform.repo.setJobStatus(r[0]!.jobId!, "COMPLETED");
        expect(await scheduler.tick()).toEqual([]);
        expect(started).toHaveLength(1);
    });

    it("never runs a disabled schedule, and restarts the clock when it is enabled again", async () => {
        const s = seedProject("Disabled");
        clockNow = Date.UTC(2026, 6, 1, 0, 0);
        const sched = svc.store.create({ projectId: s.projectId, name: "off", kind: "validate", cadence: { type: "interval", every: 1, unit: "hours" }, enabled: false });
        expect(sched.nextRunAt).toBeNull();
        const { started, scheduler } = rig(svc.store);
        clockNow += 5 * HOUR;
        expect(await scheduler.tick()).toEqual([]);
        const on = svc.store.update(sched.id, { enabled: true })!;
        expect(on.nextRunAt).toBe(clockNow + HOUR); // from now, not from the past
        expect(started).toHaveLength(0);
    });

    it("skips a schedule while the project has a running job, says why, and runs it at the next tick once the job is done", async () => {
        const s = seedProject("Busy");
        clockNow = Date.UTC(2026, 6, 2, 0, 0);
        const sched = svc.store.create({ projectId: s.projectId, name: "hourly", kind: "validate", cadence: { type: "interval", every: 1, unit: "hours" } });
        const due = sched.nextRunAt!;
        const running = await platform.repo.createJob(s.projectId, s.appId, { ...DEFAULT_JOB_OPTIONS });
        platform.repo.setJobStatus(running.id, "VALIDATING");
        const { started, scheduler } = rig(svc.store);

        clockNow = due + 1_000;
        const r1 = await scheduler.tick();
        expect(r1[0]).toMatchObject({ result: "skipped" });
        expect(r1[0]!.note).toMatch(/still validating/i);
        const skipped = svc.store.get(sched.id)!;
        expect(skipped.nextRunAt).toBe(due); // not advanced: still due
        expect(skipped.lastOutcome).toBe("skipped");
        expect(skipped.lastNote).toMatch(/tried again/i);
        expect(started).toHaveLength(0);

        platform.repo.setJobStatus(running.id, "COMPLETED");
        clockNow += 30_000; // next tick
        const r2 = await scheduler.tick();
        expect(r2.map((x) => x.result)).toEqual(["started"]);
        expect(started).toHaveLength(1);
        expect(svc.store.get(sched.id)!.nextRunAt).toBe(clockNow + HOUR);
    });

    it("after downtime runs a missed schedule once and does not replay the missed slots", async () => {
        const s = seedProject("CatchUp");
        clockNow = Date.UTC(2026, 6, 3, 0, 0);
        const sched = svc.store.create({ projectId: s.projectId, name: "every 15 min", kind: "validate", cadence: { type: "interval", every: 15, unit: "minutes" } });
        const { started, scheduler } = rig(svc.store);
        clockNow += 3 * 24 * HOUR; // the platform was off for three days (288 missed slots)
        const r = await scheduler.tick();
        expect(r.map((x) => x.result)).toEqual(["started"]);
        platform.repo.setJobStatus(r[0]!.jobId!, "COMPLETED");
        expect(await scheduler.tick()).toEqual([]); // not due again until a full interval from the catch-up run
        expect(started).toHaveLength(1);
        expect(svc.store.get(sched.id)!.nextRunAt).toBe(clockNow + 15 * 60_000);
    });

    it("lets only one of two scheduler processes act on a due schedule", async () => {
        const s = seedProject("TwoProcesses");
        clockNow = Date.UTC(2026, 6, 4, 0, 0);
        const sched = svc.store.create({ projectId: s.projectId, name: "x", kind: "validate", cadence: { type: "interval", every: 10, unit: "minutes" } });
        // A second connection to the same database file, as a separate process would have.
        const db2 = new Db(path.join(dataDir, "platform.db"));
        try {
            const store2 = new ScheduleStore(db2, () => clockNow);
            const due = sched.nextRunAt!;
            // Both saw the schedule as due with the same `next_run_at`; the atomic update lets exactly one win.
            const wins = [svc.store.claim(sched.id, due, due + 600_000), store2.claim(sched.id, due, due + 600_000)];
            expect(wins.filter(Boolean)).toHaveLength(1);
            expect(svc.store.get(sched.id)!.nextRunAt).toBe(due + 600_000);

            // And end to end: two schedulers ticking at the same moment start the job once.
            clockNow = due + 700_000;
            const a = rig(svc.store);
            const b = rig(store2, db2);
            const [ra, rb] = await Promise.all([a.scheduler.tick(), b.scheduler.tick()]);
            expect([...ra, ...rb].filter((x) => x.result === "started")).toHaveLength(1);
            expect(a.started.length + b.started.length).toBe(1);
        } finally {
            db2.close();
        }
    });

    it("creates the real job: re-run schedules take every runnable test and are labelled as scheduled", async () => {
        const s = seedProject("RealJob");
        addTest(s, "API-001");
        addTest(s, "API-002");
        const sched = svc.store.create({ projectId: s.projectId, name: "re-run", kind: "validate", cadence: { type: "daily", time: "03:00" }, retryFailures: 2 });
        const job = await startScheduledJob(platform.repo, sched);
        expect(job.options).toMatchObject({ mode: "validate", trigger: "schedule", scheduleId: sched.id, retryFailures: 2 });
        expect([...job.options.testIds!].sort()).toEqual([...s.tests.values()].sort());
        // A second one is refused while the first is queued
        await expect(startScheduledJob(platform.repo, sched)).rejects.toThrow(/still queued/i);
    });

    it("an 'analyze again' schedule reuses the application's saved settings", async () => {
        const s = seedProject("Analyze");
        const project = platform.repo.getLatestApplicationPublic(s.projectId)!;
        void project;
        const appId = platform.repo.createApplication(s.projectId, `http://127.0.0.1:${RECEIVER_PORT}`, { ...DEFAULT_JOB_OPTIONS, targets: ["api"], maxPages: 7, scope: "only the shop" });
        const sched = svc.store.create({ projectId: s.projectId, name: "again", kind: "generate", cadence: { type: "weekly", weekday: 1, time: "06:00" } });
        const job = await startScheduledJob(platform.repo, sched);
        expect(job.applicationId).toBe(appId);
        expect(job.options).toMatchObject({ mode: "generate", targets: ["api"], maxPages: 7, scope: "only the shop", trigger: "schedule", scheduleId: sched.id });
    });

    it("records a plain-language error when there is nothing to run, and still advances", async () => {
        const s = seedProject("NoTests");
        clockNow = Date.UTC(2026, 6, 5, 0, 0);
        const sched = svc.store.create({ projectId: s.projectId, name: "nothing", kind: "validate", cadence: { type: "interval", every: 1, unit: "hours" } });
        const scheduler = new Scheduler({ store: svc.store, repo: platform.repo, clock: () => clockNow });
        clockNow = sched.nextRunAt! + 1;
        const r = await scheduler.tick();
        expect(r[0]).toMatchObject({ result: "error" });
        const after = svc.store.get(sched.id)!;
        expect(after.lastOutcome).toBe("error");
        expect(after.lastNote).toMatch(/no tests/i);
        expect(after.nextRunAt).toBeGreaterThan(clockNow);
    });
});

describe("run summaries, changes between runs and trends", () => {
    it("records what a run says and what changed since the last one", async () => {
        const s = seedProject("Diff");
        for (const k of ["API-001", "API-002", "API-003", "API-004", "API-005"]) addTest(s, k);

        const r1 = await seedRun(s, { "API-001": "pass", "API-002": "pass", "API-003": "fail", "API-004": "pass", "API-005": "pass" });
        const s1 = await summaryOf(s, r1.id);
        expect(s1).toMatchObject({ total: 5, validated: 4, failed: 1, needsReview: 0, flaky: 0, passRate: 80, mode: "validate", trigger: "manual" });
        expect(s1.diff.firstRun).toBe(true);

        const r2 = await seedRun(s, { "API-001": "fail", "API-002": "review:Server error: GET /api/x returned 500", "API-003": "pass", "API-004": "fail", "API-005": "flaky" }, { trigger: "schedule" });
        const s2 = await summaryOf(s, r2.id);
        expect(s2).toMatchObject({ total: 5, validated: 2, failed: 2, needsReview: 1, flaky: 1, passRate: 40, trigger: "schedule" });
        const keys = (xs: Array<{ key: string }>) => xs.map((x) => x.key).sort();
        expect(s2.diff.firstRun).toBe(false);
        expect(keys(s2.diff.newlyFailing)).toEqual(["API-001", "API-002", "API-004"]);
        expect(keys(s2.diff.fixed)).toEqual(["API-003"]);
        expect(keys(s2.diff.newFindings)).toEqual(["API-002"]);
        expect(s2.diff.newFindings[0].severity).toBe("high");
        expect(keys(s2.diff.flakyPasses)).toEqual(["API-005"]);
        expect(keys(s2.diff.stillFailing)).toEqual([]);

        // A flaky pass is not a regression: API-005 passed in the end.
        expect(keys(s2.diff.newlyFailing)).not.toContain("API-005");

        const r3 = await seedRun(s, { "API-001": "fail", "API-002": "review:Server error: GET /api/x returned 500" });
        const s3 = await summaryOf(s, r3.id);
        expect(keys(s3.diff.stillFailing)).toEqual(["API-001", "API-002"]);
        expect(s3.diff.newlyFailing).toEqual([]);
        expect(s3.diff.newFindings).toEqual([]); // same finding, unchanged

        // A smaller run later keeps remembering the tests it did not include: API-004 failed in r2 and was not in r3.
        const r4 = await seedRun(s, { "API-004": "pass" });
        expect(keys((await summaryOf(s, r4.id)).diff.fixed)).toEqual(["API-004"]);
    });

    it("serves pass rate, counts and duration per run, with the overall delta", async () => {
        const s = seedProject("Trends");
        for (const k of ["API-001", "API-002", "API-003", "API-004"]) addTest(s, k);
        await seedRun(s, { "API-001": "pass", "API-002": "pass", "API-003": "pass", "API-004": "fail" }); // 75
        await seedRun(s, { "API-001": "pass", "API-002": "fail", "API-003": "fail", "API-004": "fail" }); // 25
        await seedRun(s, { "API-001": "pass", "API-002": "pass", "API-003": "pass", "API-004": "pass" }); // 100

        const t = (await call("GET", `/api/projects/${s.projectId}/trends?days=30`)).body;
        expect(t.days).toBe(30);
        expect(t.runs.map((r: any) => r.passRate)).toEqual([75, 25, 100]);
        expect(t.runs[0]).toMatchObject({ total: 4, validated: 3, failed: 1, needsReview: 0, durationMs: 5 * 60_000, mode: "validate" });
        expect(t.summary).toMatchObject({ runs: 3, firstPassRate: 75, latestPassRate: 100, passRateDelta: 25, averagePassRate: 66.7 });

        const narrow = (await call("GET", `/api/projects/${s.projectId}/trends?days=1`)).body; // seeded runs are ~10 days old
        expect(narrow.runs).toEqual([]);
        expect(narrow.summary.passRateDelta).toBeNull();
        expect((await call("GET", `/api/projects/${s.projectId}/trends?days=0`)).status).toBe(400);
        expect((await call("GET", "/api/projects/nope/trends")).status).toBe(404);
    });

    it("does not summarize cancelled jobs", async () => {
        const s = seedProject("Cancelled");
        addTest(s, "API-001");
        const job = await platform.repo.createJob(s.projectId, s.appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [s.tests.get("API-001")!] });
        platform.repo.setJobStatus(job.id, "FAILED", "Cancelled");
        await svc.onJobFinished(platform.repo.getJob(job.id)!);
        expect((await call("GET", `/api/projects/${s.projectId}/trends`)).body.runs).toEqual([]);
    });
});

describe("flaky tests", () => {
    it("ranks tests whose results flip without the test changing", async () => {
        const s = seedProject("Flaky");
        for (const k of ["API-001", "API-002", "API-003", "API-004"]) addTest(s, k);
        // API-001 flips every run; API-002 flipped once and stayed failed (a regression); API-003 is steady; API-004 flips twice.
        await seedRun(s, { "API-001": "pass", "API-002": "pass", "API-003": "pass", "API-004": "pass" });
        await seedRun(s, { "API-001": "fail", "API-002": "fail", "API-003": "pass", "API-004": "fail" });
        await seedRun(s, { "API-001": "pass", "API-002": "fail", "API-003": "pass", "API-004": "pass" });
        await seedRun(s, { "API-001": "fail", "API-002": "fail", "API-003": "pass", "API-004": "pass" });
        await seedRun(s, { "API-001": "pass", "API-002": "fail", "API-003": "pass", "API-004": "pass" });

        const f = (await call("GET", `/api/projects/${s.projectId}/flaky`)).body.tests as any[];
        expect(f.map((x) => x.testKey)).toEqual(["API-001", "API-004"]);
        expect(f[0]).toMatchObject({ executions: 5, passes: 3, fails: 2, flips: 4, flipRate: 1, lastStatus: "passed" });
        expect(f[1]).toMatchObject({ executions: 5, passes: 4, fails: 1, flips: 2, flipRate: 0.5 });
    });

    it("counts a pass on an immediate re-run as flaky evidence, and forgets history when the test changes", async () => {
        const s = seedProject("FlakyRetry");
        addTest(s, "API-001");
        await seedRun(s, { "API-001": "flaky" });
        let f = detectFlaky(platform.db, s.projectId);
        expect(f).toHaveLength(1);
        expect(f[0]).toMatchObject({ testKey: "API-001", flakyPasses: 1, flips: 1, executions: 2 });

        // The test is edited (new script version): the old results no longer say anything about it.
        newScript(s, "API-001", "v2");
        await seedRun(s, { "API-001": "pass" });
        expect(detectFlaky(platform.db, s.projectId)).toEqual([]);
    });
});

describe("alerts", () => {
    it("tells the channel about a regression once, includes a link and the top findings, and stays quiet while nothing changes", async () => {
        const s = seedProject("Shop");
        for (const k of ["API-001", "API-002", "API-003"]) addTest(s, k, `Login works ${k}`);
        const ch = await channelFor(s);
        await seedRun(s, { "API-001": "pass", "API-002": "pass", "API-003": "pass" });
        expect(received).toHaveLength(0); // all green: nothing to say

        await seedRun(s, { "API-001": "pass", "API-002": "review:Server error: GET /api/x returned 500", "API-003": "fail" }, { trigger: "schedule" });
        expect(received).toHaveLength(1);
        const m = received[0]!;
        expect(m.url).toBe(HOOK_PATH);
        expect(m.headers["content-type"]).toBe("application/json");
        expect(m.body).toMatchObject({
            event: "regression",
            events: expect.arrayContaining(["regression", "run_failed"]),
            test: false,
            project: { id: s.projectId, name: "Shop" },
            link: `${PUBLIC_URL}/#/projects/${s.projectId}`,
            run: { status: "PARTIALLY_COMPLETED", trigger: "schedule", total: 3, passed: 1, failed: 1, needsReview: 1, flaky: 0, passRate: 33.3 },
            error: null,
        });
        expect(m.body.summary).toContain("Shop: 2 tests newly failing");
        expect(m.body.summary).toContain("1 of 3 tests passed (33.3%)");
        expect(m.body.newlyFailing.map((x: any) => x.testKey).sort()).toEqual(["API-002", "API-003"]);
        // top findings: worst first (the server error is high severity; the broken test has none)
        expect(m.body.findings[0]).toMatchObject({ testKey: "API-002", severity: "high" });
        expect(typeof m.body.sentAt).toBe("string");

        // Same failure again (and again): not announced twice.
        await seedRun(s, { "API-001": "pass", "API-002": "review:Server error: GET /api/x returned 500", "API-003": "fail" }, { trigger: "schedule" });
        await seedRun(s, { "API-001": "pass", "API-002": "review:Server error: GET /api/x returned 500", "API-003": "fail" }, { trigger: "schedule" });
        expect(received).toHaveLength(1);

        // One test recovers: told once as "recovered", and the remaining failure is a changed situation for run_failed.
        await seedRun(s, { "API-001": "pass", "API-002": "pass", "API-003": "fail" }, { trigger: "schedule" });
        expect(received).toHaveLength(2);
        expect(received[1]!.body.events).toEqual(expect.arrayContaining(["recovered", "run_failed"]));
        expect(received[1]!.body.recovered.map((x: any) => x.testKey)).toEqual(["API-002"]);

        // Everything green, then the same failure comes back: announced again.
        await seedRun(s, { "API-001": "pass", "API-002": "pass", "API-003": "pass" }, { trigger: "schedule" });
        expect(received).toHaveLength(3);
        expect(received[2]!.body.event).toBe("recovered");
        await seedRun(s, { "API-001": "pass", "API-002": "pass", "API-003": "fail" }, { trigger: "schedule" });
        expect(received).toHaveLength(4);
        expect(received[3]!.body.event).toBe("regression");

        const log = (await call("GET", `/api/projects/${s.projectId}/alert-log`)).body as any[];
        expect(log).toHaveLength(4);
        expect(log.every((l) => l.status === "sent" && l.httpStatus === 200 && l.channelId === ch.id)).toBe(true);
        expect(log[0].summary).toContain("Shop");
    });

    it("reports a flaky pass as flaky — and not as a regression", async () => {
        const s = seedProject("FlakyAlert");
        addTest(s, "API-001");
        addTest(s, "API-002");
        await channelFor(s, { events: ["flaky", "regression"] });
        await seedRun(s, { "API-001": "pass", "API-002": "pass" });
        await seedRun(s, { "API-001": "flaky", "API-002": "pass" }, { trigger: "schedule" });
        expect(received).toHaveLength(1);
        expect(received[0]!.body).toMatchObject({ event: "flaky", events: ["flaky"] });
        expect(received[0]!.body.flaky.map((x: any) => x.testKey)).toEqual(["API-001"]);
        expect(received[0]!.body.newlyFailing).toEqual([]);
    });

    it("sends only the events a channel subscribed to, and respects its minimum severity", async () => {
        const s = seedProject("Subscriptions");
        addTest(s, "API-001");
        addTest(s, "API-002");
        await channelFor(s, { events: ["run_failed"], minSeverity: "high" });
        await seedRun(s, { "API-001": "pass", "API-002": "pass" });
        // a low-severity finding (visual change) is below the channel's bar
        await seedRun(s, { "API-001": "review:Visual change: the header differs by 4000 px", "API-002": "pass" }, { trigger: "schedule" });
        expect(received).toHaveLength(0);
        // a high-severity one is not; "regression" is not subscribed, so only run_failed is reported
        await seedRun(s, { "API-001": "review:Server error: GET /api/x returned 500", "API-002": "pass" }, { trigger: "schedule" });
        expect(received).toHaveLength(1);
        expect(received[0]!.body.events).toEqual(["run_failed"]);
    });

    it("does not alert for a hand-run single test, but does for a scheduled one", async () => {
        const s = seedProject("Single");
        addTest(s, "API-001");
        await channelFor(s);
        await seedRun(s, { "API-001": "pass" });
        await seedRun(s, { "API-001": "fail" }); // manual, one test
        expect(received).toHaveLength(0);
        await seedRun(s, { "API-001": "pass" });
        await seedRun(s, { "API-001": "fail" }, { trigger: "schedule" });
        expect(received).toHaveLength(1);
    });

    it("sends Slack messages in Slack's incoming-webhook shape", async () => {
        const s = seedProject("Slacky <&>");
        addTest(s, "API-001", "Checkout <works> & pays");
        const ch = await call("POST", `/api/projects/${s.projectId}/alert-channels`, { kind: "slack", url: `${RECEIVER}${HOOK_PATH}`, name: "#qa" });
        expect(ch.status).toBe(201);
        await seedRun(s, { "API-001": "pass" });
        await seedRun(s, { "API-001": "review:Server error: GET /api/x returned 500" }, { trigger: "schedule" });
        expect(received).toHaveLength(1);
        const b = received[0]!.body;
        expect(typeof b.text).toBe("string");
        expect(b.text).toContain("Slacky <&>"); // plain-text fallback is not escaped
        expect(b.blocks[0]).toMatchObject({ type: "header", text: { type: "plain_text" } });
        expect(b.blocks[0].text.text).toContain("Regression found");
        const section = b.blocks.find((x: any) => x.type === "section" && x.text?.text?.includes("Top findings"));
        expect(section.text.type).toBe("mrkdwn");
        expect(section.text.text).toContain("Checkout &lt;works&gt; &amp; pays"); // mrkdwn is escaped
        const actions = b.blocks.find((x: any) => x.type === "actions");
        expect(actions.elements[0]).toMatchObject({ type: "button", url: `${PUBLIC_URL}/#/projects/${s.projectId}` });
        expect(b.event).toBeUndefined(); // Slack bodies carry no custom fields
    });

    it("retries a failing receiver with backoff and records the outcome; the job is never affected", async () => {
        const s = seedProject("Retries");
        addTest(s, "API-001");
        await channelFor(s);
        await seedRun(s, { "API-001": "pass" });

        answer = (n) => (n <= 2 ? 503 : 200); // two failures, then success
        const job = await seedRun(s, { "API-001": "fail" }, { trigger: "schedule" });
        expect(received).toHaveLength(3);
        expect(job.status).toBe("PARTIALLY_COMPLETED");
        let log = (await call("GET", `/api/projects/${s.projectId}/alert-log`)).body as any[];
        expect(log[0]).toMatchObject({ status: "sent", attempts: 3, httpStatus: 200 });

        // Receiver permanently down: three attempts, a failed log entry with the reason, and the next run tries again.
        received.length = 0;
        answer = () => 500;
        await seedRun(s, { "API-001": "pass" }, { trigger: "schedule" }); // recovered (delivered? no: 500)
        expect(received).toHaveLength(3);
        log = (await call("GET", `/api/projects/${s.projectId}/alert-log`)).body as any[];
        expect(log[0]).toMatchObject({ status: "failed", attempts: 3, httpStatus: 500 });
        expect(log[0].error).toMatch(/HTTP 500/);

        // A 4xx other than 429/408 is final: no retries.
        received.length = 0;
        answer = () => 404;
        await seedRun(s, { "API-001": "fail" }, { trigger: "schedule" });
        expect(received).toHaveLength(1);
        log = (await call("GET", `/api/projects/${s.projectId}/alert-log`)).body as any[];
        expect(log[0]).toMatchObject({ status: "failed", attempts: 1, httpStatus: 404 });
    });

    it("stores the URL encrypted and never returns it", async () => {
        const s = seedProject("Secrets");
        const ch = await channelFor(s, { name: "Ops hook" });
        const list = await call("GET", `/api/projects/${s.projectId}/alert-channels`);
        expect(list.status).toBe(200);
        expect(list.body).toEqual([expect.objectContaining({ id: ch.id, name: "Ops hook", kind: "webhook", host: `127.0.0.1:${RECEIVER_PORT}`, enabled: true })]);
        for (const text of [list.raw, (await call("POST", `/api/projects/${s.projectId}/alert-channels/${ch.id}/test`)).raw, JSON.stringify((await call("PATCH", `/api/projects/${s.projectId}/alert-channels/${ch.id}`, { enabled: true })).body), JSON.stringify((await call("GET", `/api/projects/${s.projectId}/alert-log`)).body)]) {
            expect(text).not.toContain("very-secret-token");
            expect(text).not.toContain("http://127.0.0.1");
        }
        const row = platform.db.get("SELECT url_enc, url_host FROM alert_channels WHERE id = ?", ch.id)!;
        expect(row.url_enc).not.toContain("very-secret-token");
        expect(row.url_enc).not.toContain("127.0.0.1");
        expect(row.url_host).toBe(`127.0.0.1:${RECEIVER_PORT}`);
        // The whole database file holds the secret nowhere in plain text
        platform.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        expect(fs.readFileSync(path.join(dataDir, "platform.db")).includes("very-secret-token")).toBe(false);
    });

    it("the test button sends a real message and reports what the receiver really answered", async () => {
        const s = seedProject("TestButton");
        const ch = await channelFor(s);
        const ok = (await call("POST", `/api/projects/${s.projectId}/alert-channels/${ch.id}/test`)).body;
        expect(ok).toEqual({ ok: true, httpStatus: 200, attempts: 1, error: null });
        expect(received[0]!.body).toMatchObject({ event: "test", test: true, project: { name: "TestButton" } });
        expect(received[0]!.body.summary).toContain("test message");

        answer = () => 500;
        const bad = (await call("POST", `/api/projects/${s.projectId}/alert-channels/${ch.id}/test`)).body;
        expect(bad).toMatchObject({ ok: false, httpStatus: 500, attempts: 1 });
        expect(bad.error).toMatch(/HTTP 500/);

        // A receiver that is not there at all
        const dead = await call("POST", `/api/projects/${s.projectId}/alert-channels`, { kind: "webhook", url: "http://127.0.0.1:5269/nothing-here" });
        const res = (await call("POST", `/api/projects/${s.projectId}/alert-channels/${dead.body.id}/test`)).body;
        expect(res).toMatchObject({ ok: false, httpStatus: null, attempts: 1 });
        expect(res.error).toMatch(/could not reach/i);

        const log = (await call("GET", `/api/projects/${s.projectId}/alert-log`)).body as any[];
        expect(log.map((l) => [l.event, l.status])).toEqual([["test", "failed"], ["test", "failed"], ["test", "sent"]]);
    });

    it("refuses private/loopback destinations when BLOCK_PRIVATE_TARGETS is on, when saving and when sending", async () => {
        const s = seedProject("Ssrf");
        const ch = await channelFor(s); // saved while allowed
        process.env.BLOCK_PRIVATE_TARGETS = "true";
        const refused = await call("POST", `/api/projects/${s.projectId}/alert-channels`, { kind: "webhook", url: "http://127.0.0.1:5250/x" });
        expect(refused.status).toBe(400);
        expect(refused.body.error).toMatch(/private/i);
        expect((await call("POST", `/api/projects/${s.projectId}/alert-channels`, { kind: "slack", url: "http://169.254.169.254/latest" })).status).toBe(400);
        expect((await call("PATCH", `/api/projects/${s.projectId}/alert-channels/${ch.id}`, { url: "http://localhost:5250/x" })).status).toBe(400);
        // Already saved, but the rule changed since: nothing is sent.
        const sent = (await call("POST", `/api/projects/${s.projectId}/alert-channels/${ch.id}/test`)).body;
        expect(sent.ok).toBe(false);
        expect(sent.error).toMatch(/private/i);
        expect(received).toHaveLength(0);
    });

    it("does not follow redirects", async () => {
        const redirector = http.createServer((_req, res) => {
            res.writeHead(302, { location: `${RECEIVER}/elsewhere` });
            res.end();
        });
        await new Promise<void>((r) => redirector.listen(5251, "127.0.0.1", r));
        try {
            const s = seedProject("Redirect");
            const ch = await call("POST", `/api/projects/${s.projectId}/alert-channels`, { kind: "webhook", url: "http://127.0.0.1:5251/hook" });
            const r = (await call("POST", `/api/projects/${s.projectId}/alert-channels/${ch.body.id}/test`)).body;
            // Not followed (nothing reached the receiver), and the person reads why in plain words.
            expect(r).toMatchObject({ ok: false, httpStatus: 302, error: "The address redirects (HTTP 302); use the final URL" });
            expect(received).toHaveLength(0);
        } finally {
            redirector.close();
        }
    });

    it("alerts when a whole run could not complete (e.g. the application is unreachable)", async () => {
        const s = seedProject("Down");
        addTest(s, "API-001");
        await channelFor(s);
        const job = await platform.repo.createJob(s.projectId, s.appId, { ...DEFAULT_JOB_OPTIONS, mode: "generate", trigger: "schedule" });
        platform.repo.setJobStatus(job.id, "FAILED", "Could not open the application: connection refused");
        await svc.onJobFinished(platform.repo.getJob(job.id)!);
        await svc.flush();
        expect(received).toHaveLength(1);
        expect(received[0]!.body).toMatchObject({ event: "run_failed", error: "Could not open the application: connection refused", run: { total: 0, passRate: null } });
        expect(received[0]!.body.summary).toContain("could not complete");
        // The same outage on the next run is not announced again.
        const again = await platform.repo.createJob(s.projectId, s.appId, { ...DEFAULT_JOB_OPTIONS, mode: "generate", trigger: "schedule" });
        platform.repo.setJobStatus(again.id, "FAILED", "Could not open the application: connection refused");
        await svc.onJobFinished(platform.repo.getJob(again.id)!);
        await svc.flush();
        expect(received).toHaveLength(1);
    });

    it("a disabled channel stays silent", async () => {
        const s = seedProject("Muted");
        addTest(s, "API-001");
        const ch = await channelFor(s, { enabled: false });
        await seedRun(s, { "API-001": "pass" });
        await seedRun(s, { "API-001": "fail" }, { trigger: "schedule" });
        expect(received).toHaveLength(0);
        expect((await call("PATCH", `/api/projects/${s.projectId}/alert-channels/${ch.id}`, { enabled: true })).body.enabled).toBe(true);
    });
});

describe("schedules and alert channels API", () => {
    it("creates, lists, edits, runs and deletes schedules", async () => {
        const s = seedProject("Api");
        addTest(s, "API-001");
        const base = `/api/projects/${s.projectId}/schedules`;

        const created = await call("POST", base, { kind: "validate", cadence: { type: "daily", time: "02:00" } });
        expect(created.status, created.raw).toBe(201);
        expect(created.body).toMatchObject({ kind: "validate", kindLabel: "Re-run all tests", cadenceText: "Every day at 02:00", enabled: true, retryFailures: 1, lastRunAt: null, lastJobId: null });
        expect(created.body.name).toBe("Re-run all tests · every day at 02:00");
        expect(new Date(created.body.nextRunAt).getHours()).toBe(2);
        const id = created.body.id as string;

        const listed = (await call("GET", base)).body;
        expect(listed.schedules).toHaveLength(1);
        expect(typeof listed.timezone.name).toBe("string");
        expect(typeof listed.timezone.utcOffsetMinutes).toBe("number");
        expect(listed.schedulerEnabled).toBe(true);

        const edited = (await call("PATCH", `${base}/${id}`, { cadence: { type: "weekly", weekday: 5, time: "17:45" } })).body;
        expect(edited.cadenceText).toBe("Every Friday at 17:45");
        expect(edited.name).toBe("Re-run all tests · every Friday at 17:45"); // an automatic name follows the settings
        expect((await call("PATCH", `${base}/${id}`, { name: "Friday check" })).body.name).toBe("Friday check");
        expect((await call("PATCH", `${base}/${id}`, { cadence: { type: "daily", time: "01:00" } })).body.name).toBe("Friday check");
        const off = (await call("PATCH", `${base}/${id}`, { enabled: false })).body;
        expect(off).toMatchObject({ enabled: false, nextRunAt: null });

        // Run now works even when disabled; the run is labelled as a scheduled one
        const run = await call("POST", `${base}/${id}/run`);
        expect(run.status, run.raw).toBe(202);
        expect(run.body.job).toMatchObject({ trigger: "schedule", scheduleId: id, mode: "validate" });
        expect((await call("GET", base)).body.schedules[0]).toMatchObject({ lastJobId: run.body.jobId, lastOutcome: "started" });
        const jobs = (await call("GET", `/api/projects/${s.projectId}/jobs`)).body as any[];
        expect(jobs[0]).toMatchObject({ jobId: run.body.jobId, trigger: "schedule" });
        // ...but not while that job is still going
        const again = await call("POST", `${base}/${id}/run`);
        expect(again.status).toBe(409);
        expect(again.body.error).toMatch(/still/i);

        expect((await call("DELETE", `${base}/${id}`)).status).toBe(204);
        expect((await call("GET", base)).body.schedules).toEqual([]);
        expect((await call("DELETE", `${base}/${id}`)).status).toBe(404);
    });

    it("validates input and refuses schedules that could never run", async () => {
        const s = seedProject("ApiBad");
        const base = `/api/projects/${s.projectId}/schedules`;
        expect((await call("POST", base, { kind: "validate", cadence: { type: "daily", time: "02:00" } })).status).toBe(409); // no tests yet
        addTest(s, "API-001");
        const bad = [
            { kind: "validate", cadence: { type: "daily", time: "25:00" } },
            { kind: "validate", cadence: { type: "daily", time: "2am" } },
            { kind: "validate", cadence: { type: "interval", every: 2, unit: "minutes" } },
            { kind: "validate", cadence: { type: "interval", every: 0, unit: "hours" } },
            { kind: "validate", cadence: { type: "weekly", weekday: 7, time: "10:00" } },
            { kind: "nope", cadence: { type: "daily", time: "02:00" } },
            { kind: "validate", cadence: { type: "monthly" } },
            { kind: "validate", cadence: { type: "daily", time: "02:00" }, retryFailures: 9 },
            { cadence: { type: "daily", time: "02:00" } },
        ];
        for (const b of bad) expect((await call("POST", base, b)).status, JSON.stringify(b)).toBe(400);
        expect((await call("POST", `/api/projects/nope/schedules`, { kind: "validate", cadence: { type: "daily", time: "02:00" } })).status).toBe(404);
        expect((await call("PATCH", `${base}/does-not-exist`, { enabled: false })).status).toBe(404);
        // A schedule of another project is not reachable through this one
        const other = seedProject("Other");
        addTest(other, "API-001");
        const mine = (await call("POST", base, { kind: "validate", cadence: { type: "daily", time: "02:00" } })).body;
        expect((await call("DELETE", `/api/projects/${other.projectId}/schedules/${mine.id}`)).status).toBe(404);
        // "analyze again" needs an earlier analysis
        const bare = seedProject("NoApp", false);
        expect((await call("POST", `/api/projects/${bare.projectId}/schedules`, { kind: "generate", cadence: { type: "daily", time: "02:00" } })).status).toBe(409);
    });

    it("manages alert channels with validation", async () => {
        const s = seedProject("ApiChannels");
        const base = `/api/projects/${s.projectId}/alert-channels`;
        const created = await call("POST", base, { kind: "slack", url: `${RECEIVER}/slack-hook`, events: ["regression", "regression", "recovered"], minSeverity: "high" });
        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({ kind: "slack", name: `Slack · 127.0.0.1:${RECEIVER_PORT}`, events: ["regression", "recovered"], minSeverity: "high", enabled: true });
        expect(created.body.url).toBeUndefined();
        const id = created.body.id as string;
        const patched = (await call("PATCH", `${base}/${id}`, { name: "#alerts", events: ["flaky"], minSeverity: null, enabled: false })).body;
        expect(patched).toMatchObject({ name: "#alerts", events: ["flaky"], minSeverity: null, enabled: false });
        for (const b of [{ kind: "email", url: `${RECEIVER}/x` }, { kind: "webhook", url: "not a url" }, { kind: "webhook", url: "ftp://example.com/x" }, { kind: "webhook", url: `${RECEIVER}/x`, events: [] }, { kind: "webhook", url: `${RECEIVER}/x`, events: ["boom"] }, { kind: "webhook", url: `${RECEIVER}/x`, minSeverity: "urgent" }]) {
            expect((await call("POST", base, b)).status, JSON.stringify(b)).toBe(400);
        }
        expect((await call("PATCH", `${base}/${id}`, { surprise: 1 })).status).toBe(400);
        expect((await call("POST", `${base}/nope/test`)).status).toBe(404);
        expect((await call("DELETE", `${base}/${id}`)).status).toBe(204);
        expect((await call("GET", base)).body).toEqual([]);
        expect((await call("DELETE", `${base}/${id}`)).status).toBe(404);
    });
});
