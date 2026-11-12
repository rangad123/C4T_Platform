/**
 * Round 39 review fixes, against real HTTP (stand-in Crowd4Test sign-in on 8766, the platform on 8767): "Run now" and editing a schedule
 * make the clicker / editor the run's owner (never the maker's own computer); a person's own computer's switches are the owner's alone;
 * a schedule left without an owner is refused at its next fire (round 45); rotation is in
 * Activity; live events are capped per attempt (and keep no stack); a task never accepted is not offered forever.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskOffer, type LiveEvent } from "../src/agent-protocol/schema.js";
import { loadConfig } from "../src/config.js";
import { getAgentServices, LIVE_EVENTS_MAX, LIVE_EVENTS_TRUNCATED } from "../src/platform/agent-services.js";
import { AgentStore, MAX_ACCEPT_TIMEOUTS, NEVER_ACCEPTED } from "../src/platform/agent-store.js";
import { liveEventData } from "../src/platform/agent-routing.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { writeHeartbeat } from "../src/platform/ops/heartbeat.js";
import { getScheduleServices } from "../src/platform/schedule-services.js";
import { buildServer } from "../src/platform/server.js";
import { defaultCaps, FakeAgent, viaFetch } from "./fixtures/fake-agent.js";

const C4T_PORT = 8766;
const PORT = 8767;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "review-fixes-key-8f2a61";
const PAGE = { "x-requested-with": "ai-studio" };
const RUN = ["ai_studio.access", "ai_studio.tests.run"];
const me = (id: string, role: string, permissions: readonly string[], organisationId: string | null = null) => ({
    data: { user: { id, email: `${id}@people.example`, role, status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions, organisationId } },
});
const ACCOUNTS: Record<string, unknown> = {
    "t-ada": me("ada", "ADMIN", []),
    "t-tess": me("tess", "TESTER", RUN),
    "t-tom": me("tom", "TESTER", RUN),
    "t-cora": me("cora", "CUSTOMER", PERMISSIONS, "org-a"),
};

let c4t: http.Server;
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let tmp = "";
let projectId = "";
const ids: Record<string, string> = {};
let n = 0;
const savedPoll = process.env.AGENT_POLL_SECONDS;

const call = async (headers: Record<string, string>, method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as "GET", url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body } as { status: number; body: any };
};
const as = (token: string, method: string, url: string, payload?: unknown) => call({ cookie: `c4t_access=${token}`, ...(method === "GET" ? {} : PAGE) }, method, url, payload);
const asKey = (method: string, url: string, payload?: unknown) => call({ "x-api-key": KEY }, method, url, payload);
const svc = () => getAgentServices(platform);

async function addComputer(who: string): Promise<{ runnerId: string; agent: FakeAgent; machineId: string }> {
    const { code } = svc().store.createPersonalEnrollment({ ownerId: ids[who]!, createdBy: who });
    const machineId = randomUUID();
    const res = await fetch(`${BASE}/api/agent/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: `${who}-pc-${++n}`, machineId }) });
    const got = (await res.json()) as { token: string; runnerId: string };
    const agent = new FakeAgent(viaFetch(BASE), got.token, { name: `${who}-pc-${n}`, capabilities: defaultCaps({ runnerSwitches: true }) });
    expect((await agent.hello({ machineId })).status).toBe(200);
    return { runnerId: got.runnerId, agent, machineId };
}

/** The runner task of a job (what the dispatch would queue for it): its owner is read from the job. */
function taskFor(jobId: string): string {
    platform.db.run("UPDATE generation_jobs SET status = 'VALIDATING' WHERE id = ?", jobId);
    const taskId = randomUUID();
    const offer = TaskOffer.parse({ taskId, jobId, adapterId: "playwright", leaseSeconds: 60, workers: 1, scripts: [{ testId: "t1", filename: "t1.spec.ts", content: "//" }], env: { baseUrl: "https://app.example", headless: true } });
    svc().store.enqueue({ id: taskId, projectId, jobId, adapterId: "playwright", payloadEnc: svc().encrypt(offer), files: [] });
    return taskId;
}
const finishJob = (jobId: string) => platform.db.run("UPDATE generation_jobs SET status = 'COMPLETED' WHERE id = ?", jobId);

beforeAll(async () => {
    process.env.AGENT_POLL_SECONDS = "1";
    c4t = http.createServer((req, res) => {
        // The people service (c4t-service.ts): a schedule's tick asks it whether its maker is still active. Tess and Tom are.
        if (req.url?.startsWith("/v1/ai-studio/people")) {
            const q = new URL(req.url, "http://x").searchParams.get("q") ?? "";
            const id = q.split("@")[0]!;
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(JSON.stringify({ data: ["tess", "tom"].includes(id) ? [{ id, name: id, email: q, kind: "TESTER", organisationId: null }] : [] }));
        }
        const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        res.writeHead(ACCOUNTS[auth] ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ACCOUNTS[auth] ?? { error: { message: "Invalid access token" } }));
    });
    await new Promise<void>((r) => c4t.listen(C4T_PORT, "127.0.0.1", r));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-review-fixes-"));
    platform = bootstrap(loadConfig({ DATA_DIR: tmp, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECRET_KEY: "review-fixes-secret-key-0123456789", C4T_API_ORIGIN: `http://127.0.0.1:${C4T_PORT}`, C4T_SITE_URL: "https://crowd4test.example", C4T_SERVICE_TOKEN: "review-fixes-service-token-0123456789abcdef" }));
    app = await buildServer(platform);
    await app.listen({ port: PORT, host: "127.0.0.1" });
    projectId = (await asKey("POST", "/api/projects", { name: "Shared shop" })).body.id as string;
    svc().store.setRunner(projectId, { runOn: "agent", agentId: null });
    const spec = { title: "Health answers", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/health" }, { action: "assertResponse", check: "status", expected: 200 }] };
    expect((await asKey("POST", `/api/projects/${projectId}/specs`, { baseUrl: "https://app.example", validate: false, specs: [spec] })).status).toBe(202);
    for (const who of ["t-tess", "t-tom", "t-cora", "t-ada"]) ids[who] = (await as(who, "GET", "/api/auth/state")).body.me.id as string;
    for (const who of ["t-tess", "t-tom"]) accessControlOf(app).projects.store.addMember(projectId, ids[who]!, { role: "owner", projectAdmin: false, source: "added", addedBy: "test" });
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    await new Promise((r) => c4t?.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
    if (savedPoll === undefined) delete process.env.AGENT_POLL_SECONDS;
    else process.env.AGENT_POLL_SECONDS = savedPoll;
});

describe("review fixes", () => {
    let tess: Awaited<ReturnType<typeof addComputer>>;
    let tom: Awaited<ReturnType<typeof addComputer>>;
    let sid = "";

    it("H1: Run now on someone else's schedule belongs to the clicker; the maker's own Run now still goes to the maker's computer", async () => {
        tess = await addComputer("t-tess");
        tom = await addComputer("t-tom");
        const made = await as("t-tess", "POST", `/api/projects/${projectId}/schedules`, { kind: "validate", cadence: { type: "daily", time: "03:00" } });
        expect(made.status).toBe(201);
        sid = made.body.id as string;

        // Tom clicks Run now on Tess's schedule: his run, never offered to Tess's computer.
        writeHeartbeat(platform.db);
        const byTom = await as("t-tom", "POST", `/api/projects/${projectId}/schedules/${sid}/run`);
        expect(byTom.status).toBe(202);
        expect(platform.repo.getJob(byTom.body.jobId)!.options.startedBy).toEqual({ kind: "schedule", id: sid, ownerId: ids["t-tom"] });
        const tomTask = taskFor(byTom.body.jobId);
        expect((await tess.agent.poll(1)).offer).toBeUndefined();
        expect(svc().store.claimFor(tomTask, { id: tess.agent.agentId, tokenId: tess.runnerId }, 60_000)).toBeUndefined();
        expect((await tom.agent.poll(1)).offer?.taskId).toBe(tomTask);
        await tom.agent.result(tomTask, { ok: true, runs: [] });
        finishJob(byTom.body.jobId);

        // Naming Tess's computer for it does not help either (round 45: a chosen runner is ignored): the run is Tom's.
        expect(svc().jobStarter(byTom.body.jobId).ownerId).toBe(ids["t-tom"]);

        // Tess's own Run now still goes to her computer; the schedule still names her.
        writeHeartbeat(platform.db);
        const byTess = await as("t-tess", "POST", `/api/projects/${projectId}/schedules/${sid}/run`);
        expect(byTess.status).toBe(202);
        expect(platform.repo.getJob(byTess.body.jobId)!.options.startedBy).toMatchObject({ ownerId: ids["t-tess"] });
        expect(getScheduleServices(platform).store.get(sid)!.createdBy).toBe(ids["t-tess"]);
        const tessTask = taskFor(byTess.body.jobId);
        expect((await tom.agent.poll(1)).offer).toBeUndefined();
        expect((await tess.agent.poll(1)).offer?.taskId).toBe(tessTask);
        await tess.agent.result(tessTask, { ok: true, runs: [] });
        finishJob(byTess.body.jobId);
    }, 60_000);

    it("H1: a schedule's own runs follow its maker; once Tom edits it they are his, never silently Tess's", async () => {
        const fire = async () => {
            platform.db.run("UPDATE schedules SET next_run_at = ? WHERE id = ?", Date.now() - 1000, sid);
            writeHeartbeat(platform.db);
            const fired = (await getScheduleServices(platform).scheduler.tick()).find((x) => x.scheduleId === sid)!;
            expect(fired.result).toBe("started");
            return fired.jobId!;
        };
        const before = await fire();
        expect(platform.repo.getJob(before)!.options.startedBy).toMatchObject({ ownerId: ids["t-tess"] });
        const tessTask = taskFor(before);
        expect((await tess.agent.poll(1)).offer?.taskId).toBe(tessTask);
        await tess.agent.result(tessTask, { ok: true, runs: [] });
        finishJob(before);

        expect((await as("t-tom", "PATCH", `/api/projects/${projectId}/schedules/${sid}`, { retryFailures: 1 })).status).toBe(200);
        expect(getScheduleServices(platform).store.get(sid)!.createdBy).toBe(ids["t-tom"]);
        const after = await fire();
        expect(platform.repo.getJob(after)!.options.startedBy).toEqual({ kind: "schedule", id: sid, ownerId: ids["t-tom"] });
        const tomTask = taskFor(after);
        expect((await tess.agent.poll(1)).offer).toBeUndefined();
        expect((await tom.agent.poll(1)).offer?.taskId).toBe(tomTask);
        await tom.agent.result(tomTask, { ok: true, runs: [] });
        finishJob(after);
        // An edit with the access key (no person): the schedule has no owner from then on, and its next fire is refused with a sentence.
        expect((await asKey("PATCH", `/api/projects/${projectId}/schedules/${sid}`, { retryFailures: 0 })).status).toBe(200);
        expect(getScheduleServices(platform).store.get(sid)!.createdBy).toBeNull();
        platform.db.run("UPDATE schedules SET next_run_at = ? WHERE id = ?", Date.now() - 1000, sid);
        writeHeartbeat(platform.db);
        const orphan = (await getScheduleServices(platform).scheduler.tick()).find((x) => x.scheduleId === sid)!;
        expect(orphan.result).not.toBe("started");
        expect(JSON.stringify(orphan)).toContain("This schedule has no owner. Open it and save it again to run it on your computer.");
        // Tess saves it again: hers once more.
        expect((await as("t-tess", "PATCH", `/api/projects/${projectId}/schedules/${sid}`, { retryFailures: 1 })).status).toBe(200);
    }, 60_000);

    it("M1: a person's runner's switches are its owner's alone: nobody else reaches them", async () => {
        // The routes are the caller's own runner only (round 45): an admin has none here, and cannot name Tess's.
        expect((await as("t-ada", "PATCH", "/api/me/runner", { switches: { codeScripts: false } })).status).toBe(404);
        expect((await as("t-tom", "PATCH", "/api/me/runner", { switches: { privateTargets: true } })).body.runner.id).toBe(tom.runnerId);
        expect(svc().store.getToken(tess.runnerId)).toMatchObject({ allowCodeScripts: true, allowPrivateTargets: false });
        expect((await as("t-tess", "PATCH", "/api/me/runner", { name: "Tess laptop", switches: { privateTargets: true } })).body.runner).toMatchObject({ name: "Tess laptop", switches: { privateTargets: true } });
        expect((await as("t-tess", "PATCH", "/api/me/runner", { switches: { privateTargets: false } })).status).toBe(200);
        expect((await as("t-tom", "PATCH", "/api/me/runner", { switches: { privateTargets: false } })).status).toBe(200);
    });

    it("L7: rotating a credential leaves an Activity entry, without the credential", async () => {
        const res = await fetch(`${BASE}/api/agent/rotate`, { method: "POST", headers: { authorization: `Bearer ${tom.agent.token}`, "content-type": "application/json" }, body: "{}" });
        expect(res.status).toBe(200);
        const fresh = ((await res.json()) as { token: string }).token;
        const rows = accessControlOf(app).users.activity({ action: "runner-credential-rotated" });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ actor: { kind: "runner" } });
        expect(rows[0]!.detail).toContain("changed its credential");
        for (const secret of [fresh, tom.agent.token]) expect(JSON.stringify(rows)).not.toContain(secret);
    });

    it("M3: live events are capped per attempt with one note, dropped quietly after it; no stack is kept", async () => {
        const jobId = (await (async () => {
            writeHeartbeat(platform.db);
            const r = await as("t-tess", "POST", `/api/projects/${projectId}/schedules/${sid}/run`);
            expect(r.status).toBe(202);
            return r.body.jobId as string;
        })()) as string;
        const taskId = taskFor(jobId);
        expect((await tess.agent.poll(1)).offer?.taskId).toBe(taskId);
        const attemptId = svc().store.getTask(taskId)!.attemptId!;
        const token = svc().store.getToken(tess.runnerId)!;
        const finished = { type: "test_finished", seq: 0, at: new Date().toISOString(), testId: "t1", status: "failed", durationMs: 5, error: "Expected 200", stack: "at x (a.ts:1)" } as LiveEvent;
        expect(liveEventData(finished)).not.toHaveProperty("stack");
        expect(svc().events(token, taskId, { attemptId, events: [finished] })).toMatchObject({ stored: 1 });
        const kept = platform.repo.listEvents(jobId).filter((e) => e.kind === "runner_test_finished");
        expect(kept).toHaveLength(1);
        expect(JSON.stringify(kept[0])).not.toContain("a.ts:1");
        let seq = 1;
        while (seq < LIVE_EVENTS_MAX + 150) {
            const events = Array.from({ length: 100 }, () => ({ type: "log", seq: seq++, at: "t", line: "line" }) as LiveEvent);
            svc().events(token, taskId, { attemptId, events });
        }
        expect(svc().store.liveEventCount(taskId, attemptId)).toBe(LIVE_EVENTS_MAX);
        const count = () => Number(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_events WHERE job_id = ? AND kind LIKE 'runner_%'", jobId)!.n);
        const stored = count();
        expect(platform.db.all<{ message: string }>("SELECT message FROM agent_events WHERE job_id = ? AND kind = 'runner_events_truncated'", jobId).map((e) => e.message)).toEqual([LIVE_EVENTS_TRUNCATED]);
        // Past the cap: answered 200 over HTTP, nothing stored, so the runner does not send them again.
        const res = await fetch(`${BASE}/api/agent/tasks/${taskId}/events`, { method: "POST", headers: { authorization: `Bearer ${tess.agent.token}`, "content-type": "application/json" }, body: JSON.stringify({ attemptId, events: [{ type: "log", seq: seq + 1, at: "t", line: "more" }] }) });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { stored: number }).stored).toBe(0);
        expect(count()).toBe(stored);
        await tess.agent.result(taskId, { ok: true, runs: [] });
        finishJob(jobId);
    }, 120_000);

    it(`L3: a task never accepted fails after ${MAX_ACCEPT_TIMEOUTS} offers with a sentence, and the runner is not treated as having said no`, () => {
        let now = 1_800_000_000_000;
        const store = new AgentStore(platform.db, () => now);
        const { record } = store.createPersonalToken({ ownerId: ids["t-tess"]!, label: "slow-box", createdBy: "test" });
        const agent = store.upsertAgent(record, { name: "slow-box", version: "1", capabilities: { os: "linux", arch: "x64", node: "v24.0.0", browsers: ["chromium"] }, concurrency: 1 });
        store.setAgentProtocol(agent.id, 2);
        const id = randomUUID();
        store.enqueue({ id, projectId, jobId: `job-${id}`, adapterId: "playwright", payloadEnc: "enc", files: [], ownerId: ids["t-tess"]! });
        for (let i = 1; i <= MAX_ACCEPT_TIMEOUTS; i++) {
            expect(store.claimFor(id, agent, 60_000)).toBeDefined();
            store.beginAttempt(id, agent.id, { protocol: 2, acceptMs: 30_000 });
            now += 30_001;
            const swept = store.sweep();
            const kind = i < MAX_ACCEPT_TIMEOUTS ? "accept_timeout" : "never_accepted";
            expect(swept.changes).toEqual(expect.arrayContaining([expect.objectContaining({ kind, taskId: id })]));
            if (i < MAX_ACCEPT_TIMEOUTS) expect(store.getTask(id)).toMatchObject({ status: "queued", phase: "queued" });
        }
        expect(store.getTask(id)).toMatchObject({ status: "failed", phase: "failed", error: NEVER_ACCEPTED });
    });
});
