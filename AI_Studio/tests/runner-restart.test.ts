/**
 * A restart of the platform does not lose a run that is going on a runner, and never makes the runner run it twice.
 *
 * The real program (`node --import tsx src/main.ts`, EXECUTION_MODE=runners, port 8420) is started, stopped and started again on the same
 * data folder, while a FAKE RUNNER (tests/fixtures/fake-agent.ts: plain fetch, canned results, runs nothing) holds a task:
 *  - a deploy (SIGTERM): the platform stops in seconds, not after SHUTDOWN_GRACE_SECONDS; the runner is not told to stop; the next process
 *    takes the job up again from the same task (protocol 1);
 *  - a crash (SIGKILL) while a protocol-2 runner runs the task: the next process re-attaches to the same task and the same attempt;
 *  - a crash after which the runner's result arrives before the job is taken up again: the stored result is used.
 * In every case: one task for the job, one offer to the runner, no cancel in any heartbeat answer, the job ends with the runner's results.
 * The 60 s job lease of a killed process is ended in its database row instead of waited for (the process is gone; only the wait is skipped).
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaskOffer } from "../src/agent-protocol/schema.js";
import { Db } from "../src/platform/db.js";
import { AgentStore } from "../src/platform/agent-store.js";
import { UserStore } from "../src/platform/user-store.js";
import { HANDED_OVER } from "../src/platform/runner-handover.js";
import { FakeAgent, passedRun, viaFetch } from "./fixtures/fake-agent.js";

const PORT = 8420;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "restart-admin-key-5d02c1aa";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-runner-restart-"));
const dataDir = path.join(root, "data");

let child: ChildProcess | undefined;
let out = "";

const cleanEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {};
    // No credentials of this machine reach the program (no model is ever called).
    for (const [k, v] of Object.entries(process.env)) if (!/KEY|TOKEN|SECRET|PASSWORD|LLM_|ANTHROPIC|OPENAI|GOOGLE|BACKUP|LOG_|METRICS|READY_|VITEST|NODE_OPTIONS|AGENT_|EXECUTION_MODE|WORKER_|SCHEDULER_/i.test(k)) env[k] = v;
    return {
        ...env,
        DATA_DIR: dataDir,
        PORT: String(PORT),
        HOST: "127.0.0.1",
        API_KEY: KEY,
        SECRET_KEY: "runner-restart-secret-key-0123456789abcdef",
        EXECUTION_MODE: "runners",
        WORKER_EMBEDDED: "false",
        SCHEDULER_ENABLED: "false",
        WORKER_POLL_MS: "200",
        SHUTDOWN_GRACE_SECONDS: "30",
        READY_MIN_FREE_MB: "1",
        AGENT_POLL_SECONDS: "1",
        AGENT_WATCH_MS: "100",
        AGENT_LEASE_SECONDS: "30",
        AGENT_NO_AGENT_GRACE_SECONDS: "60",
        TAQWRIGHT_HOME: "/nonexistent-taqwright",
        LLM_PROVIDER: "anthropic",
    };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(what: string, fn: () => Promise<T | undefined> | T | undefined, ms = 60_000): Promise<T> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const v = await Promise.resolve().then(fn).catch(() => undefined);
        if (v !== undefined && v !== false) return v as T;
        await sleep(150);
    }
    throw new Error(`timed out waiting for ${what}; platform output: ${out.slice(-2000)}`);
};

async function startPlatform(): Promise<void> {
    child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], { cwd: REPO_ROOT, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout!.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.stderr!.on("data", (b: Buffer) => (out += b.toString("utf8")));
    await until("the platform to be ready", async () => ((await fetch(`${BASE}/readyz`)).status === 200 ? true : undefined), 120_000);
}

/** Stop the program this test started (only that process, by its own handle); resolves with its exit code and how long it took. */
async function stopPlatform(signal: "SIGTERM" | "SIGKILL"): Promise<{ code: number | null; ms: number }> {
    const c = child!;
    const t0 = Date.now();
    const exited = new Promise<number | null>((r) => c.once("exit", (code) => r(code)));
    c.kill(signal);
    const code = await exited;
    child = undefined;
    return { code, ms: Date.now() - t0 };
}

const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { "x-api-key": RUN_AS, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text } as { status: number; body: any };
};
/** Read the platform's database directly (between processes, or beside a running one: SQLite WAL). */
const withDb = <T>(fn: (db: Db) => T): T => {
    const db = new Db(path.join(dataDir, "platform.db"));
    try {
        return fn(db);
    } finally {
        db.close();
    }
};
const tasksOf = (jobId: string) => withDb((db) => db.all<{ id: string; status: string; cancel_requested: number; attempt_id: string | null }>("SELECT id, status, cancel_requested, attempt_id FROM agent_tasks WHERE job_id = ?", jobId));
const kinds = async (jobId: string) => ((await call("GET", `/api/test-generation/${jobId}/events`)).body as Array<{ kind: string }>).map((e) => String(e.kind));
const finished = (jobId: string) => until(`job ${jobId.slice(0, 8)} to finish`, async () => {
    const j = (await call("GET", `/api/test-generation/${jobId}`)).body as { status: string };
    return ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status) ? j : undefined;
});

/** The fake runner keeps its task alive every second, whether the platform answers or not, and remembers every answer. */
function keepBeating(agent: FakeAgent, offer: TaskOffer, attemptId?: string) {
    const answers: Array<{ status: number; cancel?: boolean }> = [];
    let on = true;
    const loop = (async () => {
        while (on) {
            try {
                const r = await agent.heartbeat(offer.taskId, { done: 0, total: offer.scripts.length, ...(attemptId ? { attemptId, phase: "running" } : {}) });
                answers.push({ status: r.status, ...(r.status === 200 ? { cancel: Boolean(r.json?.cancel) } : {}) });
            } catch {
                answers.push({ status: 0 }); // the platform is not there
            }
            await sleep(1000);
        }
    })();
    return { answers, stop: async () => ((on = false), await loop) };
}

let projectId = "";
let token = "";
/** Round 45: runs started with the shared key have no owner, so the test acts as a person (an owner here) whose runner takes them. */
let RUN_AS = KEY;
let ownerId = "";
/** The person's runner, written straight into the platform's database (the platform runs in another process); setting one up retires the one before. */
const runnerOfPerson = (label: string): string =>
    withDb((db) => {
        const store = new AgentStore(db);
        const made = store.createPersonalToken({ ownerId, label, createdBy: "test" });
        store.setTokenSwitches(made.record.id, { allowPrivateTargets: true });
        return made.secret;
    });
let tests: Array<{ id: string; testId: string }> = [];

beforeAll(async () => {
    await startPlatform();
    projectId = (await call("POST", "/api/projects", { name: "Restarts" })).body.id;
    const r = await call("POST", `/api/projects/${projectId}/specs`, { baseUrl: "https://shop.example.test", validate: false, specs: ["Health answers", "Items are listed"].map((title) => ({ title, kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/health" }, { action: "assertResponse", check: "status", expected: 200 }] })) });
    expect(r.status).toBe(202);
    tests = r.body.tests;
    // After the import (made with the key, so the tests are approved): the person who starts the runs, and their runner.
    withDb((db) => {
        const users = new UserStore(db);
        ownerId = users.create({ email: "restart-owner@people.example", name: "Restart owner", role: "owner" }).id;
        RUN_AS = users.createToken(ownerId, { name: "test", role: "owner" }).token;
    });
    token = runnerOfPerson("restart-pc");
}, 180_000);

afterAll(async () => {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
});

const newToken = async (label: string) => runnerOfPerson(label);
const startRun = async () => {
    const r = await call("POST", `/api/projects/${projectId}/runs`, { testIds: tests.map((t) => t.id) });
    expect(r.status).toBe(202);
    return r.body.jobId as string;
};

describe("a deploy (SIGTERM) while a protocol-1 runner runs the job", () => {
    it("stops in seconds without stopping the runner; the next process takes the job up from the same task", async () => {
        const agent = new FakeAgent(viaFetch(BASE), token, { name: "restart-pc" });
        expect((await agent.hello()).status).toBe(200);
        const jobId = await startRun();
        const offer = (await agent.next(15_000))!;
        expect(offer.jobId).toBe(jobId);
        const beats = keepBeating(agent, offer);
        await until("a heartbeat", () => beats.answers.some((a) => a.status === 200));

        const stopped = await stopPlatform("SIGTERM");
        expect(stopped.code).toBe(0);
        expect(stopped.ms).toBeLessThan(15_000); // SHUTDOWN_GRACE_SECONDS is 30: nothing waited for the runner's run
        expect(out).toContain("Stopped cleanly.");
        // Handed over, not failed: the task is still running and nobody asked the runner to stop.
        const job = withDb((db) => db.get<{ status: string; lease_owner: string | null; attempts: number }>("SELECT status, lease_owner, attempts FROM generation_jobs WHERE id = ?", jobId))!;
        expect(job).toMatchObject({ status: "VALIDATING", lease_owner: HANDED_OVER, attempts: 0 });
        expect(tasksOf(jobId)).toEqual([expect.objectContaining({ id: offer.taskId, status: "running", cancel_requested: 0 })]);
        const tests0 = withDb((db) => db.all<{ validation_status: string }>("SELECT validation_status FROM test_cases WHERE project_id = ?", projectId));
        expect(tests0.every((t) => t.validation_status !== "VALIDATING")).toBe(true); // back to what they were while nobody looks after them

        await startPlatform();
        await until("the job to be taken up again", async () => (await kinds(jobId)).includes("runner_task_resumed"));
        await until("a heartbeat to the new process", () => beats.answers.slice(-1)[0]?.status === 200);
        await beats.stop(); // a beat after the result would rightly be told to stop: the task is finished
        expect((await agent.answer(offer, { runs: tests.map((t) => passedRun(t.testId)) })).status).toBe(200);
        expect((await finished(jobId)).status).toBe("COMPLETED");
        expect(beats.answers.some((a) => a.cancel)).toBe(false);
        expect(beats.answers.some((a) => a.status === 0)).toBe(true); // it did beat into the gap
        expect(tasksOf(jobId)).toEqual([expect.objectContaining({ id: offer.taskId, status: "done" })]);
        expect((await agent.poll(1)).status).toBe(204); // no second offer
        const k = await kinds(jobId);
        expect(k).toEqual(expect.arrayContaining(["job_handed_over", "runner_job_resumed", "runner_task_resumed"]));
        expect(k).not.toContain("runner_attempt_cancelled");
        const after = (await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ validationStatus: string }>;
        expect(after.every((t) => t.validationStatus === "VALIDATED")).toBe(true);
        expect(withDb((db) => db.get<{ attempts: number }>("SELECT attempts FROM generation_jobs WHERE id = ?", jobId))!.attempts).toBe(1);
    }, 240_000);
});

describe("a crash (SIGKILL) while a protocol-2 runner runs the job", () => {
    it("re-attaches the next process to the same task and the same attempt: no second task, no second execution", async () => {
        token = await newToken("restart-pc-2");
        const agent = new FakeAgent(viaFetch(BASE), token, { name: "restart-pc-2" });
        expect((await agent.hello({ protocol: 2 })).status).toBe(200);
        const jobId = await startRun();
        const offer = (await agent.next(15_000)) as TaskOffer & { attemptId: string };
        expect(offer.attemptId).toBeTruthy();
        const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
        expect((await agent.send("POST", `/api/agent/tasks/${offer.taskId}/accept`, { headers, body: JSON.stringify({ attemptId: offer.attemptId }) })).status).toBe(200);
        const beats = keepBeating(agent, offer, offer.attemptId);
        await until("a heartbeat", () => beats.answers.some((a) => a.status === 200));

        expect((await stopPlatform("SIGKILL")).code).toBeNull();
        // The killed process's job lease (60 s) is ended here instead of waited for.
        withDb((db) => db.run("UPDATE generation_jobs SET lease_until = ? WHERE id = ?", Date.now() - 1, jobId));
        await startPlatform();
        await until("the job to be taken up again", async () => (await kinds(jobId)).includes("runner_task_resumed"));
        const k = await kinds(jobId);
        expect(k).toContain("runner_attempt_kept");
        expect(k).not.toContain("runner_attempt_cancelled");
        await until("a heartbeat to the new process", () => beats.answers.slice(-1)[0]?.status === 200);
        await beats.stop();
        const result = await agent.send("POST", `/api/agent/tasks/${offer.taskId}/result`, { headers, body: JSON.stringify({ ok: true, attemptId: offer.attemptId, runs: tests.map((t) => passedRun(t.testId)) }) });
        expect(result.status).toBe(200);
        expect((await finished(jobId)).status).toBe("COMPLETED");
        expect(beats.answers.some((a) => a.cancel)).toBe(false);
        expect(beats.answers.filter((a) => a.status !== 0 && a.status !== 200)).toEqual([]); // never superseded or gone
        expect(tasksOf(jobId)).toEqual([expect.objectContaining({ id: offer.taskId, status: "done", attempt_id: offer.attemptId })]);
        expect((await agent.poll(1)).status).toBe(204);
    }, 240_000);
});

describe("a crash, and the runner's result arrives before the job is taken up again", () => {
    it("the stored result is used: the job finishes from it, nothing is sent again", async () => {
        token = await newToken("restart-pc-3");
        const agent = new FakeAgent(viaFetch(BASE), token, { name: "restart-pc-3" });
        expect((await agent.hello()).status).toBe(200);
        const jobId = await startRun();
        const offer = (await agent.next(15_000))!;
        expect((await agent.heartbeat(offer.taskId, { done: 0, total: 2 })).status).toBe(200);
        await stopPlatform("SIGKILL");
        await startPlatform();
        // The killed process still holds the job's lease: the result is stored first (as a runner's kept result is sent after a restart).
        expect((await agent.answer(offer, { runs: tests.map((t) => passedRun(t.testId)) })).status).toBe(200);
        expect(tasksOf(jobId)).toEqual([expect.objectContaining({ status: "done" })]);
        expect((await call("GET", `/api/test-generation/${jobId}`)).body.status).toBe("VALIDATING");
        withDb((db) => db.run("UPDATE generation_jobs SET lease_until = ? WHERE id = ?", Date.now() - 1, jobId));
        expect((await finished(jobId)).status).toBe("COMPLETED");
        expect(await kinds(jobId)).toContain("runner_task_resumed");
        expect(tasksOf(jobId)).toHaveLength(1);
        expect((await agent.poll(1)).status).toBe(204);
        await stopPlatform("SIGTERM");
    }, 240_000);
});
