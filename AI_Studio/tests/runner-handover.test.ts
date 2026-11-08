/**
 * Taking a run on a runner up again after a restart of the platform, and handing it over at a deploy (docs/features/runner-restarts.md).
 *
 * A real platform in this process, its routes reached through Fastify's `inject` (no port), and a FAKE RUNNER (tests/fixtures/fake-agent.ts:
 * canned results, runs nothing). Each "attempt" of a job is a new runner executor, as the next platform process makes one. Covers:
 *  - the pick-up never attaches an earlier result to a script that did not run: a changed script, flag, baseline or helper sends a new
 *    task; only exactly the same work is picked up;
 *  - a new attempt stops only the earlier tasks that hold the tests it sends; an earlier task for another test is picked up later, not run
 *    a second time;
 *  - a finished task picked up again stores its cleanup ledger once, and its withheld trace is not reported as never uploaded;
 *  - a run sequence stopped by a deploy leaves its step's runner job alone (it finishes on the runner) and says so;
 *  - the hand-over of a job with two tests going at once is atomic: the writes already going are stored before the lease is released,
 *    and nothing of that attempt is written after it (the job's closed write queue and the engine's fenced sink, also on their own).
 * No browser, no model, no network.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { ExecutionBatch, ExecutionEnv, RunnerProject, ScriptRun } from "../src/engine/frameworks/types.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import type { TaskRecord } from "../src/platform/agent-store.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { fenceSink, runJob } from "../src/platform/job-runner.js";
import { JobWriteQueue } from "../src/platform/job-write-queue.js";
import { DEFAULT_JOB_OPTIONS, type JobRow } from "../src/platform/repo.js";
import { getRunbookServices } from "../src/platform/runbook-runner.js";
import { HANDED_OVER, handOver, LEASE_LOST, whenParked } from "../src/platform/runner-handover.js";
import { buildServer } from "../src/platform/server.js";
import type { ObjectStore } from "../src/platform/object-store.js";
import { defaultCaps, failedRun, FakeAgent, passedRun, viaInject } from "./fixtures/fake-agent.js";

const API_KEY = "handover-admin-key-7e21c4d0";
const APP = "http://127.0.0.1:8461"; // never contacted: the fake runner runs nothing
const PASSWORD = "HOLEAK-Password-29d1f7";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS", "AGENT_MAX_TOKENS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e: e as Error }));
const until = async <T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 15_000): Promise<T> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const v = await fn();
        if (v !== undefined && v !== false) return v as T;
        await sleep(20);
    }
    throw new Error(`timed out waiting for ${what}`);
};
const call = async (method: string, url: string, body?: unknown) => {
    const r = await server.inject({ method: method as "GET", url, headers: { "x-api-key": API_KEY, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, payload: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.statusCode, body: r.body.startsWith("{") || r.body.startsWith("[") ? r.json() : r.body } as { status: number; body: any };
};
const svc = () => getAgentServices(platform);
const kinds = (jobId: string) => platform.repo.listEvents(jobId, 0, 5000).map((e) => String(e.kind));

/** A project whose tests run on its own fake runner. */
async function setup(name: string, concurrency = 2) {
    const projectId = (await call("POST", "/api/projects", { name })).body.id as string;
    const token = (await call("POST", `/api/projects/${projectId}/agent-tokens`, { label: `${name} pc` })).body.secret as string;
    const agent = new FakeAgent(viaInject(server), token, { name: `${name} pc`, capabilities: defaultCaps(), concurrency });
    expect((await agent.hello()).status).toBe(200);
    svc().store.setRunner(projectId, { runOn: "agent", agentId: null });
    return { projectId, agent };
}
const jobFor = (projectId: string, over: Partial<typeof DEFAULT_JOB_OPTIONS> = {}): Promise<JobRow> =>
    platform.repo.createJob(projectId, platform.repo.createApplication(projectId, APP, { ...DEFAULT_JOB_OPTIONS }, undefined), { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [], ...over });
const runEnv = (over: Partial<ExecutionEnv["run"]> = {}): ExecutionEnv => ({ run: { baseUrl: APP, apiBaseUrl: APP, credentials: { username: "demo", password: PASSWORD }, headless: true, ...over } });
const batchOf = (scripts: ExecutionBatch["scripts"], helpers?: ExecutionBatch["helpers"]): ExecutionBatch => ({ scratchDir: path.join(dataDir, "scratch"), scripts, ...(helpers ? { helpers } : {}) });
const newTaskOf = (jobId: string, before: ReadonlySet<string>) => svc().store.tasksOfJob(jobId).find((t) => !before.has(t.id));
const idsOf = (jobId: string) => new Set(svc().store.tasksOfJob(jobId).map((t) => t.id));

/** Finish a task as the runner would (claimed by its agent, then the result stored), without the runner's long poll. */
function finishAs(agent: FakeAgent, taskId: string, runs: ScriptRun[] | ReturnType<typeof passedRun>[]): void {
    const a = svc().store.getAgent(agent.agentId)!;
    if (svc().store.getTask(taskId)!.status === "queued") expect(svc().store.claimFor(taskId, { id: a.id, tokenId: a.tokenId }, 60_000)).toBeTruthy();
    expect(svc().store.finish(taskId, a.id, { status: "done", resultEnc: svc().encrypt({ ok: true, runs }) })).toBe(true);
}

/**
 * One new attempt of the job sending `b`: it either picks up an earlier task (and answers with its runs at once) or sends a new task,
 * which is then stopped. Returns which.
 */
async function attemptOnce(projectId: string, job: JobRow, b: ExecutionBatch, env = runEnv(), o: { adapter?: string; projects?: RunnerProject[] } = {}): Promise<{ sent?: TaskRecord; runs?: ScriptRun[]; resumedEvents: number }> {
    const before = idsOf(job.id);
    const resumedBefore = kinds(job.id).filter((k) => k === "runner_task_resumed").length;
    const abort = new AbortController();
    const outcome = settle(svc().executorFor({ projectId, jobId: job.id }).execute(o.adapter ?? "playwright-api", b, env, { workers: 1, signal: abort.signal, ...(o.projects ? { projects: o.projects } : {}) }));
    let finished = false;
    void outcome.then(() => (finished = true));
    const sent = await until("the attempt to send a task or pick one up", () => newTaskOf(job.id, before) ?? (finished ? ({} as TaskRecord) : undefined));
    abort.abort();
    const r = await outcome;
    return { ...(sent.id ? { sent } : {}), ...(r.ok ? { runs: r.v } : {}), resumedEvents: kinds(job.id).filter((k) => k === "runner_task_resumed").length - resumedBefore };
}

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "30", AGENT_WATCH_MS: "25", AGENT_NO_AGENT_GRACE_SECONDS: "60", AGENT_MAX_TOKENS: "25" });
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-handover-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY, SECRET_KEY: "runner-handover-secret-key-0123456789", LLM_PROVIDER: "anthropic", CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0" }));
    server = await buildServer(platform);
    fs.mkdirSync(path.join(dataDir, "scratch"), { recursive: true });
}, 60_000);

afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("the pick-up after a restart compares what actually runs", () => {
    it("a changed script, flag, baseline or helper sends a new task; exactly the same work is picked up with its stored result", async () => {
        const { projectId, agent } = await setup("Exact pick-up");
        const job = await jobFor(projectId);
        const shotA = path.join(dataDir, "shot-a.png");
        const shotB = path.join(dataDir, "shot-b.png");
        fs.writeFileSync(shotA, Buffer.from("png-bytes-of-the-approved-baseline"));
        fs.writeFileSync(shotB, Buffer.from("png-bytes-of-a-newer-baseline"));
        const web = (over: Partial<ExecutionBatch["scripts"][number]> = {}) => ({ testId: "WEB-001", filename: "WEB-001.spec.ts", content: "test('a', async () => { /* version A */ });", baselines: [{ name: "home.png", path: shotA }], ...over });
        const code = (helper: string) => batchOf([{ testId: "WEB-002", filename: "WEB-002.spec.ts", content: "import { login } from './helpers/login';", custom: true }], [{ name: "login", content: helper }]);

        // The earlier attempt: both batches ran on the runner and their results are stored.
        for (const [b, testId] of [[batchOf([web()]), "WEB-001"], [code("export const login = 1;"), "WEB-002"]] as const) {
            const before = idsOf(job.id);
            const first = svc().executorFor({ projectId, jobId: job.id }).execute("playwright-api", b, runEnv(), { workers: 1 });
            finishAs(agent, (await until("the first task", () => newTaskOf(job.id, before))).id, [passedRun(testId)]);
            expect((await first)[0]).toMatchObject({ testId, status: "passed" });
        }
        const done = svc().store.tasksOfJob(job.id);
        expect(done.map((t) => t.status)).toEqual(["done", "done"]);

        // The next attempt with something different each time: never the earlier result, always a new task.
        const changed: Array<[string, ExecutionBatch]> = [
            ["the script's content", batchOf([web({ content: "test('a', async () => { /* version B */ });" })])],
            ["a baseline's bytes", batchOf([web({ baselines: [{ name: "home.png", path: shotB }] })])],
            ["the code-script flag", batchOf([web({ custom: true })])],
            ["the signed-in flag", batchOf([web({ session: true })])],
            ["a helper's content", code("export const login = 2;")],
        ];
        for (const [what, b] of changed) {
            const r = await attemptOnce(projectId, job, b);
            expect({ what, picked: r.resumedEvents, sent: Boolean(r.sent), runs: r.runs }).toEqual({ what, picked: 0, sent: true, runs: undefined });
        }
        // The earlier tasks were left as they were (finished; nothing stopped them).
        expect(done.map((t) => svc().store.getTask(t.id)!.status)).toEqual(["done", "done"]);

        // Exactly the same work: picked up, its stored result used, nothing sent.
        for (const [b, testId] of [[batchOf([web()]), "WEB-001"], [code("export const login = 1;"), "WEB-002"]] as const) {
            const same = await attemptOnce(projectId, job, b);
            expect(same.sent).toBeUndefined();
            expect(same.resumedEvents).toBe(1);
            expect(same.runs?.[0]).toMatchObject({ testId, status: "passed" });
        }
        platform.repo.setJobStatus(job.id, "FAILED", "test over");
    }, 60_000);

    it("a changed variable, account name, address, headed setting or variant sends a new task; a new password or token is the same work", async () => {
        const { projectId, agent } = await setup("Environment pick-up");
        const job = await jobFor(projectId);
        const b = batchOf([{ testId: "WEB-003", filename: "WEB-003.spec.ts", content: "test('plans', async () => {});" }]);
        const phone: RunnerProject[] = [{ name: "phone", device: "Pixel 7" }];
        const env = (over: Partial<ExecutionEnv["run"]> = {}) => runEnv({ vars: { PLAN: "basic" }, apiToken: "HOLEAK-ApiToken-attempt-1", ...over });
        const before = idsOf(job.id);
        const first = svc().executorFor({ projectId, jobId: job.id }).execute("playwright", b, env(), { workers: 1, projects: phone });
        finishAs(agent, (await until("the first task", () => newTaskOf(job.id, before))).id, [passedRun("WEB-003")]);
        expect((await first)[0]).toMatchObject({ testId: "WEB-003", status: "passed" });

        const changed: Array<[string, ExecutionEnv, RunnerProject[]]> = [
            ["a variable", env({ vars: { PLAN: "pro" } }), phone],
            ["the account's user name", env({ credentials: { username: "someone-else", password: PASSWORD } }), phone],
            ["the API address", env({ apiBaseUrl: "http://127.0.0.1:8462" }), phone],
            ["headed or not", env({ headless: false }), phone],
            ["a variant's device", env(), [{ name: "phone", device: "iPhone 13" }]],
            ["a variant's screen size", env(), [{ name: "phone", device: "Pixel 7", viewport: { width: 400, height: 800 } }]],
        ];
        for (const [what, e, projects] of changed) {
            const r = await attemptOnce(projectId, job, b, e, { adapter: "playwright", projects });
            expect({ what, picked: r.resumedEvents, sent: Boolean(r.sent) }).toEqual({ what, picked: 0, sent: true });
        }
        // Secret values differ from one attempt to the next (a fetched token, a changed password): still the same work, picked up.
        const same = await attemptOnce(projectId, job, b, env({ apiToken: "HOLEAK-ApiToken-attempt-2", credentials: { username: "demo", password: "HOLEAK-Password-rotated" } }), { adapter: "playwright", projects: phone });
        expect(same.sent).toBeUndefined();
        expect(same.resumedEvents).toBe(1);
        expect(same.runs?.[0]).toMatchObject({ testId: "WEB-003", status: "passed" });
        platform.repo.setJobStatus(job.id, "FAILED", "test over");
    }, 60_000);
});

describe("a new attempt stops only the earlier tasks of the tests it sends", () => {
    it("an earlier task for another test keeps running and is picked up later: that test does not run a second time", async () => {
        const { projectId, agent } = await setup("Other tests kept");
        const job = await jobFor(projectId);
        const a = (content: string) => batchOf([{ testId: "API-001", filename: "API-001.spec.ts", content }]);
        const b = batchOf([{ testId: "API-002", filename: "API-002.spec.ts", content: "// API-002 as it was" }]);
        const ag = svc().store.getAgent(agent.agentId)!;

        // Attempt 1 sends both tests (two at once); the runner takes both; then the platform loses the job (its lease).
        const first = svc().executorFor({ projectId, jobId: job.id });
        const lost = new AbortController();
        const before = idsOf(job.id);
        const firstA = settle(first.execute("playwright-api", a("// API-001 as it was"), runEnv(), { workers: 1, signal: lost.signal }));
        const taskA = await until("API-001's task", () => newTaskOf(job.id, before));
        const firstB = settle(first.execute("playwright-api", b, runEnv(), { workers: 1, signal: lost.signal }));
        const taskB = await until("API-002's task", () => newTaskOf(job.id, new Set([...before, taskA.id])));
        for (const t of [taskA, taskB]) expect(svc().store.claimFor(t.id, { id: ag.id, tokenId: ag.tokenId }, 60_000)).toBeTruthy();
        lost.abort(LEASE_LOST);
        expect((await firstA).ok).toBe(false);
        expect((await firstB).ok).toBe(false);
        expect([taskA, taskB].map((t) => svc().store.getTask(t.id)).map((t) => [t!.status, t!.cancelRequested])).toEqual([["running", false], ["running", false]]);

        // Attempt 2 reaches API-001 first, and its script changed meanwhile: only API-001's earlier task is stopped.
        const second = svc().executorFor({ projectId, jobId: job.id });
        const before2 = idsOf(job.id);
        const secondA = second.execute("playwright-api", a("// API-001 repaired"), runEnv(), { workers: 1 });
        await until("API-001's earlier task to be told to stop", () => svc().store.getTask(taskA.id)!.cancelRequested);
        expect(svc().store.getTask(taskB.id)!.cancelRequested).toBe(false);
        // The runner stops it (its answer after a stop counts as stopped), and only then is API-001 sent again.
        expect(newTaskOf(job.id, before2)).toBeUndefined();
        svc().store.finish(taskA.id, ag.id, { status: "done", resultEnc: svc().encrypt({ ok: true, runs: [] }) });
        const retryA = await until("API-001's new task", () => newTaskOf(job.id, before2));
        finishAs(agent, retryA.id, [passedRun("API-001")]);
        expect((await secondA)[0]).toMatchObject({ testId: "API-001", status: "passed" });
        expect(svc().store.getTask(taskA.id)!.status).toBe("cancelled");

        // API-002 is reached next: its earlier task is still going and is picked up; the runner finishes it once.
        expect(svc().store.getTask(taskB.id)).toMatchObject({ status: "running", cancelRequested: false });
        const before3 = idsOf(job.id);
        const secondB = second.execute("playwright-api", b, runEnv(), { workers: 1 });
        await until("API-002's earlier task to be picked up", () => kinds(job.id).filter((k) => k === "runner_task_resumed").length === 1);
        finishAs(agent, taskB.id, [failedRun("API-002", "Expected 200 but got 500")]);
        expect((await secondB)[0]).toMatchObject({ testId: "API-002", status: "failed" });
        expect(newTaskOf(job.id, before3)).toBeUndefined();
        // Three tasks in all: API-001 twice (its script changed), API-002 once.
        expect(svc().store.tasksOfJob(job.id).map((t) => t.id)).toEqual([taskA.id, taskB.id, retryA.id]);
        platform.repo.setJobStatus(job.id, "FAILED", "test over");
    }, 60_000);
});

describe("a finished task picked up again", () => {
    it("stores its cleanup ledger once, and its withheld trace is not reported as a file never uploaded", async () => {
        const { projectId, agent } = await setup("Collected twice");
        const job = await jobFor(projectId);
        const b = batchOf([{ testId: "API-010", filename: "API-010.spec.ts", content: "// creates an item" }]);
        const env = runEnv({ cleanup: "platform" });
        const ag = svc().store.getAgent(agent.agentId)!;
        // A trace that holds the password in a part that is not text cannot be cleaned: it is not kept.
        const trace = Buffer.concat([Buffer.from([0, 1, 2, 0xff, 0xfe, 0]), Buffer.from(PASSWORD), Buffer.alloc(32, 0)]);

        const before = idsOf(job.id);
        const first = svc().executorFor({ projectId, jobId: job.id }).execute("playwright-api", b, env, { workers: 1 });
        const task = await until("the task", () => newTaskOf(job.id, before));
        expect(svc().store.claimFor(task.id, { id: ag.id, tokenId: ag.tokenId }, 60_000)).toBeTruthy();
        expect((await agent.upload(task.id, "API-010-trace.zip", trace)).status).toBe(200);
        const run = failedRun("API-010", "Expected 201 but got 500", { artifacts: [{ kind: "trace", ref: "API-010-trace.zip" }], created: [{ path: "/items", id: "41", deletePath: "/items/41", status: "removed" }] } as never);
        expect((await agent.result(task.id, { ok: true, runs: [run] })).status).toBe(200);
        expect((await first)[0]).toMatchObject({ testId: "API-010", status: "failed", artifacts: [] });
        const ledgerRows = () => platform.db.all<{ record_id: string }>("SELECT record_id FROM cleanup_ledger WHERE job_id = ?", job.id).map((r) => r.record_id);
        expect(ledgerRows()).toEqual(["41"]);
        expect(kinds(job.id).filter((k) => ["cleanup_finished", "runner_trace_withheld", "runner_file_missing"].includes(k))).toEqual(["cleanup_finished", "runner_trace_withheld"]);

        // The next attempt picks the finished task up and collects it again.
        const again = await attemptOnce(projectId, job, b, env);
        expect(again.sent).toBeUndefined();
        expect(again.runs?.[0]).toMatchObject({ testId: "API-010", status: "failed" });
        expect(ledgerRows()).toEqual(["41"]);
        expect(kinds(job.id).filter((k) => ["cleanup_finished", "runner_trace_withheld", "runner_file_missing"].includes(k))).toEqual(["cleanup_finished", "runner_trace_withheld"]);
        platform.repo.setJobStatus(job.id, "FAILED", "test over");
    }, 60_000);
});

describe("a run sequence stopped by a deploy", () => {
    it("leaves its step's job on the runner alone (it is handed over and finishes there) and says so", async () => {
        const { projectId } = await setup("Sequence at a deploy", 1);
        const imported = await call("POST", `/api/projects/${projectId}/specs`, { baseUrl: APP, validate: false, specs: [{ title: "Health answers", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/health" }, { action: "assertResponse", check: "status", expected: 200 }] }] });
        expect(imported.status).toBe(202);
        const rb = getRunbookServices(platform, { pollMs: 50 });
        const made = await call("POST", `/api/projects/${projectId}/runbooks`, { version: 1, name: "Nightly", steps: [{ id: "r", type: "run", scope: "all" }, { id: "w", type: "wait", seconds: 1 }] });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        const run = await rb.start(made.body.id, { kind: "manual" });
        const jobId = await until("the step's job", () => rb.store.runSteps(run.id)[0]?.jobId ?? undefined);
        const job = platform.repo.getJob(jobId)!;
        expect(job.options.runOn).toBe("agent");
        // A worker has taken it (no worker runs in this file).
        platform.repo.setJobStatus(jobId, "VALIDATING");

        await rb.stop();
        expect(platform.repo.isCancelRequested(jobId)).toBe(false);
        const ended = rb.store.getRun(run.id)!;
        expect(ended.status).toBe("interrupted");
        const steps = rb.store.runSteps(run.id);
        expect(steps.map((s) => s.status)).toEqual(["stopped", "skipped"]);
        expect(steps[0]!.reason).toMatch(/carries on on its runner and finishes on its own/);
        platform.repo.setJobStatus(jobId, "FAILED", "test over");
    }, 60_000);
});

describe("the hand-over fence on a job's writes", () => {
    it("a closed write queue makes no write; the engine's sink makes none once the job is handed over, and knows the calls still going", async () => {
        const q = new JobWriteQueue();
        const wrote: string[] = [];
        q.push(() => wrote.push("before"));
        q.close();
        q.push(() => wrote.push("pushed after"));
        let settled = false;
        void q.run(() => wrote.push("run after")).then(
            () => (settled = true),
            () => (settled = true),
        );
        await q.flush();
        await sleep(20);
        expect(wrote).toEqual(["before"]);
        expect(settled).toBe(false);

        let closed = false;
        const going = new Set<Promise<unknown>>();
        let release!: () => void;
        const target = {
            calls: [] as string[],
            event(e: string) {
                this.calls.push(`event ${e}`);
            },
            async save(x: string) {
                await new Promise<void>((r) => (release = r));
                this.calls.push(`save ${x}`);
                return x;
            },
        };
        const fenced = fenceSink(target, () => closed, going);
        fenced.event("a");
        const saving = fenced.save("one");
        expect(going.size).toBe(1);
        closed = true;
        expect(fenced.event("b")).toBeUndefined();
        let late = false;
        void fenced.save("two").then(() => (late = true));
        release();
        expect(await saving).toBe("one");
        await sleep(20);
        expect(going.size).toBe(0);
        expect(late).toBe(false);
        expect(target.calls).toEqual(["event a", "save one"]);
    });
});

describe("the hand-over of a job with two tests going at once (last: it drains this platform for good)", () => {
    it("waits for the writes already going, then releases the lease; nothing of that attempt is written after it", async () => {
        const { projectId, agent } = await setup("Atomic hand-over");
        const spec = (title: string) => ({ title, kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/health" }, { action: "assertResponse", check: "status", expected: 200 }] });
        const imported = await call("POST", `/api/projects/${projectId}/specs`, { baseUrl: APP, validate: false, specs: [spec("Health answers"), spec("Items are listed")] });
        expect(imported.status).toBe(202);
        const [ta, tb] = imported.body.tests as Array<{ id: string; testId: string }>;
        const created = await jobFor(projectId, { testIds: [ta!.id, tb!.id], retryFailures: 1 });
        const owner = "handover-test-worker";
        // Only this job is waiting (no worker runs in this file; an earlier test that failed may have left its job queued).
        platform.db.run("UPDATE generation_jobs SET status = 'FAILED' WHERE status = 'QUEUED' AND id <> ?", created.id);
        const job = platform.repo.claimNextJob(60_000, owner)!;
        expect(job.id).toBe(created.id);

        // The job's evidence store holds the second test's screenshot until the test lets it go: that write is "going" at the hand-over.
        let reached!: () => void;
        const atGate = new Promise<void>((r) => (reached = r));
        let open!: () => void;
        const gate = new Promise<void>((r) => (open = r));
        const store = new Proxy(platform.store, {
            get(target, prop, receiver) {
                const v = Reflect.get(target, prop, receiver) as unknown;
                if (prop === "putFile") {
                    return async (key: string, file: string) => {
                        if (key.includes(`/_artifacts/${tb!.testId}/`)) {
                            reached();
                            await gate;
                        }
                        return (v as ObjectStore["putFile"]).call(target, key, file);
                    };
                }
                return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
            },
        });
        void runJob({ ...platform, store }, job, owner);

        // One task with both tests: both fail; the second has a screenshot. Each test then runs again on its own (retryFailures).
        const offer = (await agent.next(15_000, 2))!;
        expect(offer.scripts.map((s) => s.testId)).toEqual([ta!.testId, tb!.testId]);
        await agent.answer(offer, { uploads: { "b-shot.png": Buffer.from("png-of-the-failure") }, runs: [failedRun(ta!.testId, "Expected 200 but got 500"), failedRun(tb!.testId, "Expected 200 but got 503", { artifacts: [{ kind: "screenshot", ref: "b-shot.png" }] })] });
        // The first test's re-run is on the runner; the second test is storing its screenshot.
        const retry = (await agent.next(15_000, 2))!;
        expect(retry.scripts.map((s) => s.testId)).toEqual([ta!.testId]);
        await atGate;

        // A deploy: the first test's branch parks (its runner task stays), and the job is handed over while the second one is mid-write.
        svc().drain();
        await whenParked(job.id);
        const handing = handOver(job.id);
        setTimeout(open, 300);
        expect(await handing).toBe(true);

        const snapshot = () => ({
            job: platform.db.get<{ status: string; lease_owner: string }>("SELECT status, lease_owner FROM generation_jobs WHERE id = ?", job.id),
            events: platform.repo.listEvents(job.id, 0, 5000).map((e) => String(e.kind)),
            executions: platform.db.all<{ status: string; attempt: number }>("SELECT test_case_id, status, attempt FROM test_executions WHERE job_id = ? ORDER BY test_case_id, attempt", job.id),
            artifacts: platform.db.all<{ kind: string }>("SELECT kind FROM artifacts WHERE job_id = ?", job.id).map((a) => a.kind),
            tests: platform.db.all<{ validation_status: string; attempts: number }>("SELECT validation_status, attempts FROM test_cases WHERE project_id = ? ORDER BY test_key", projectId),
        });
        const atHandOver = snapshot();
        expect(atHandOver.job).toEqual({ status: "VALIDATING", lease_owner: HANDED_OVER });
        // The write that was going is stored, before the lease was released.
        expect(atHandOver.artifacts).toEqual(["screenshot"]);
        expect(atHandOver.events.at(-1)).toBe("job_handed_over");
        // Nothing of that attempt lands afterwards (the second test's branch went on to its next write).
        await sleep(1500);
        expect(snapshot()).toEqual(atHandOver);
        // The first test's re-run is still on the runner, for the next process to pick up.
        expect(svc().store.getTask(retry.taskId)).toMatchObject({ status: "running", cancelRequested: false });
    }, 60_000);
});
