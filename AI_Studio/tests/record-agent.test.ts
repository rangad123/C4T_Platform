/**
 * Recording on a runner agent, platform side, against a real platform on real HTTP and a FAKE AGENT written in the test (plain fetch, it runs no browser):
 * refusals, the record task and who may touch it, the push route (validation, caps, secrets, rate), the commands in the heartbeat replies and their
 * acknowledgement, lost contact, an agent that never answers, discard, defaults from the runner setting, and stop-then-save.
 *
 * Browser-free. Ports: platform 6030.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaskOffer } from "../src/agent-protocol/schema.js";
import { TaskOffer as TaskOfferSchema } from "../src/agent-protocol/schema.js";
import { loadConfig } from "../src/config.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { personalRunner, runOwner, testPerson } from "./helpers/personal-runner.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { recorderOptions } from "../src/platform/routes/recorder.js";
import { buildServer } from "../src/platform/server.js";
import { defaultCaps, FakeAgent, viaFetch } from "./fixtures/fake-agent.js";

const PORT = 6030;
const BASE = `http://127.0.0.1:${PORT}`;
const APP = "http://localhost:6031";
const API_KEY = "ao-admin-key-93d1b6e0";
let RUN_AS = API_KEY;
const PASSWORD = "AOLEAK-Password-4e82c1";
const TYPED = "AOLEAK-TypedSecret-77aa3f";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "BLOCK_PRIVATE_TARGETS", "AGENT_MAX_TOKENS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
/** Everything the platform ever answered to the page (for the secrets check). */
const answers: string[] = [];

const admin = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { "x-api-key": RUN_AS, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    answers.push(text);
    return { status: res.status, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; text: string; body: any };
};
const raw = (method: string, rawPath: string, headers: Record<string, string> = {}, body?: Buffer) =>
    new Promise<{ status: number; text: string }>((resolve) => {
        const req = http.request({ host: "127.0.0.1", port: PORT, method, path: rawPath, headers }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        });
        req.on("error", () => resolve({ status: 0, text: "" }));
        req.end(body);
    });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async <T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, ms = 8000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v as T;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(50);
    }
};

const svc = () => getAgentServices(platform);
// The test acts as a person (round 45), whose changes would wait for approval: these tests are about running them.
const newProject = async (name: string) => {
    const id = (await admin("POST", "/api/projects", { name })).body.id as string;
    await admin("PUT", `/api/projects/${id}/review-policy`, { edits: false });
    return id;
};
/** A runner of the test's person (round 45: every runner is one person's), or of someone else with `ownerId`. */
const connect = async (projectId: string, name: string, caps = defaultCaps({ record: true, recordHeaded: true }), ownerId?: string) => {
    void projectId;
    const secret = personalRunner(platform, { label: name, ...(ownerId ? { ownerId } : {}) }).secret;
    const agent = new FakeAgent(viaFetch(BASE), secret, { name, capabilities: caps });
    expect((await agent.hello()).status).toBe(200);
    return agent;
};
const start = (projectId: string, body: Record<string, unknown> = {}) => admin("POST", `/api/projects/${projectId}/recordings`, { url: `${APP}/shop`, on: "agent", headed: false, ...body });
const get = async (rid: string) => (await admin("GET", `/api/recordings/${rid}`)).body;

const wstep = (index: number, over: Record<string, unknown> = {}) => ({ index, kind: "click", locator: { strategy: "testId", value: `b${index}` }, matches: 1, describe: `Click b${index}`, at: `2026-10-11T10:00:${String(index).padStart(2, "0")}.000Z`, ...over });
const gotoStep = () => ({ index: 0, kind: "goto", url: `${APP}/shop`, describe: "Open the page", at: "2026-10-11T10:00:00.000Z" });
const push = (agent: FakeAgent, taskId: string, over: Record<string, unknown> = {}) => agent.recording(taskId, { status: "recording", currentUrl: `${APP}/shop`, steps: [gotoStep(), wstep(1)], ...over });

/** A start that the fake agent claims. */
async function startAndClaim(projectId: string, agent: FakeAgent, body: Record<string, unknown> = {}): Promise<{ rid: string; offer: TaskOffer }> {
    const r = await start(projectId, { agentId: agent.agentId, ...body });
    expect(r.status, r.text).toBe(201);
    const offer = await agent.next(10_000);
    expect(offer?.kind).toBe("record");
    return { rid: r.body.id as string, offer: offer! };
}
async function endRecording(rid: string): Promise<void> {
    await admin("DELETE", `/api/recordings/${rid}`);
}

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "3", AGENT_WATCH_MS: "50", AGENT_MAX_TOKENS: "25" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    Object.assign(recorderOptions, { remote: { lostContactMs: 1500, claimWaitMs: 2500, settleMs: 700 } });
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-recagent-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY, LLM_PROVIDER: "anthropic", CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0" }));
    // Round 45: runs started with the shared key have no owner, so the test acts as a person whose runner takes them.
    RUN_AS = testPerson(platform).token;
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
}, 60_000);

afterAll(async () => {
    delete recorderOptions.remote;
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("routing and refusals", () => {
    let projectId: string;
    let other: string;
    it("says what is missing: no agent online, no record ability, no display, wrong agent, bad address", async () => {
        projectId = await newProject("Record on agent");
        other = await newProject("Other project");
        platform.repo.createApplication(projectId, APP, { ...DEFAULT_JOB_OPTIONS }, { username: "tester", password: PASSWORD });
        expect(await start(projectId)).toMatchObject({ status: 409, body: { error: "Set up your runner in Settings to run tests." } });

        const old = await connect(projectId, "Old agent", defaultCaps());
        expect(await start(projectId)).toMatchObject({ status: 422, body: { error: expect.stringMatching(/Old agent can't record/) } });
        const nodisplay = await connect(projectId, "Maya's laptop", defaultCaps({ record: true }));
        expect(await start(projectId, { agentId: nodisplay.agentId, headed: true })).toMatchObject({
            status: 422,
            body: { error: "Maya's laptop has no display, so it can't show the browser window. Turn off “Show the browser window”, or use another agent." },
        });
        expect(old.agentId).not.toBe(nodisplay.agentId);
        const foreign = await connect(other, "Foreign", undefined, "someone-else");
        expect((await start(projectId, { agentId: foreign.agentId })).status).toBe(404);
        expect((await start(projectId, { agentId: "no-such-agent" })).status).toBe(404);
        expect((await start(projectId, { agentId: nodisplay.agentId, url: "ftp://x/" })).status).toBe(400);
        expect((await start(projectId, { agentId: nodisplay.agentId, url: "http://user:pw@localhost:6031/" })).status).toBe(400);
        // Nothing was queued by any refusal.
        expect(svc().store.queued(projectId)).toHaveLength(0);
    });

    it("with no agent chosen, the project's runner setting decides, and an explicit choice wins", async () => {
        const a = await connect(projectId, "Capable");
        expect((await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent", agentId: a.agentId })).status).toBe(200);
        const r = await admin("POST", `/api/projects/${projectId}/recordings`, { url: `${APP}/shop`, headed: false });
        expect(r.status, r.text).toBe(201);
        expect(r.body.runner).toEqual({ kind: "agent", agentId: a.agentId, name: "Capable" });
        await endRecording(r.body.id);
        expect((await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "platform" })).status).toBe(200);
        // A project that runs on the platform and says nothing records on the platform (checked in tests/recorder.test.ts); asking for the agent still works.
        const r2 = await start(projectId, { agentId: a.agentId });
        expect(r2.status, r2.text).toBe(201);
        await endRecording(r2.body.id);
    });
});

describe("a recording on an agent", () => {
    let projectId: string;
    let agent: FakeAgent;
    let bystander: FakeAgent;
    let rid = "";
    let offer: TaskOffer;

    it("queues a record task for the chosen agent only, with no job and no credentials, and names the agent in the answer", async () => {
        projectId = await newProject("Agent recording");
        platform.repo.createApplication(projectId, APP, { ...DEFAULT_JOB_OPTIONS }, { username: "tester", password: PASSWORD });
        agent = await connect(projectId, "Maya's laptop");
        bystander = await connect(projectId, "Bystander");
        const r = await start(projectId, { agentId: agent.agentId });
        expect(r.status, r.text).toBe(201);
        rid = r.body.id;
        expect(r.body).toMatchObject({ status: "starting", headed: false, startUrl: `${APP}/shop`, runner: { kind: "agent", agentId: agent.agentId, name: "Maya's laptop" }, pendingCommands: 0, steps: [], canSave: false });
        // The other agent of the project never sees it.
        expect((await bystander.poll()).status).toBe(204);
        offer = (await agent.next(10_000))!;
        const parsed = TaskOfferSchema.parse(offer);
        expect(parsed).toMatchObject({ kind: "record", jobId: `rec-${rid}`, adapterId: `record:${agent.agentId}`, scripts: [], record: { recordingId: rid, startUrl: `${APP}/shop`, headed: false, idleMinutes: 20, totalMinutes: 60, maxSteps: 300 } });
        expect(parsed.env.credentials).toBeUndefined();
        expect(JSON.stringify(offer)).not.toContain(PASSWORD);
        // There is no job behind it, and no listing of jobs knows it.
        expect(platform.repo.getJob(offer.jobId)).toBeUndefined();
        expect(svc().store.tasksOfJob(offer.jobId)).toHaveLength(1);
        const list = (await admin("GET", `/api/projects/${projectId}/agents`)).body as Array<{ name: string; capabilities: { record?: boolean; recordHeaded?: boolean } }>;
        expect(list.find((a) => a.name === "Maya's laptop")!.capabilities).toMatchObject({ record: true, recordHeaded: true });
        // One recording per project.
        const again = await start(projectId, { agentId: agent.agentId });
        expect(again).toMatchObject({ status: 409, body: { details: { recordingId: rid } } });
    });

    it("only the claiming agent may push, and only to a record task; the route is an exact match", async () => {
        const foreign = await connect(await newProject("Foreign"), "Foreign agent");
        const body = JSON.stringify({ status: "recording", steps: [gotoStep()] });
        const json = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
        expect((await push(foreign, offer.taskId)).status).toBe(404);
        expect((await push(bystander, offer.taskId)).status).toBe(404); // same project, not the agent that claimed it
        expect((await raw("POST", `/api/agent/tasks/${offer.taskId}/recording`, { "content-type": "application/json" }, Buffer.from(body))).status).toBe(401);
        expect((await raw("POST", `/api/agent/tasks/${offer.taskId}/recording`, { authorization: "Bearer aitg_notarealtoken0000000000000000", "content-type": "application/json" }, Buffer.from(body))).status).toBe(404);
        // An admin API key is not an agent token.
        expect((await raw("POST", `/api/agent/tasks/${offer.taskId}/recording`, { "x-api-key": RUN_AS, "content-type": "application/json" }, Buffer.from(body))).status).toBe(401);
        // Path tricks fall through to the API-key check: with only an agent token they are refused.
        const secret = (agent as unknown as { token: string }).token;
        for (const [method, p] of [
            ["POST", `/api/agent/tasks/${offer.taskId}/recording/`],
            ["POST", `/api/agent/tasks/${offer.taskId}/Recording`],
            ["POST", `/api/agent/tasks/%2e%2e/recording`],
            ["POST", `//api/agent/tasks/${offer.taskId}/recording`],
            ["POST", `/api//agent/tasks/${offer.taskId}/recording`],
            ["POST", `/API/agent/tasks/${offer.taskId}/recording`],
            ["PUT", `/api/agent/tasks/${offer.taskId}/recording`],
            ["GET", `/api/agent/tasks/${offer.taskId}/recording`],
            ["POST", `/api/agent/tasks/${offer.taskId}/recording/x`],
        ] as const) {
            const r = await raw(method, p, json(secret), Buffer.from(body));
            // A path that is not /api/... after tidying is the web app's page, never the push route's answer.
            const isPage = r.status === 200 && r.text.startsWith("<!doctype html>");
            expect(isPage || [0, 400, 401, 404, 405].includes(r.status), `${method} ${p} answered ${r.status}`).toBe(true);
            expect(r.text.includes('"ok":true'), `${method} ${p}`).toBe(false);
        }
        expect((await get(rid)).steps).toHaveLength(0);
        // A run task is not a recording.
        const runId = randomUUID();
        svc().store.enqueue({
            id: runId, projectId, jobId: "run-job-x", adapterId: "playwright", files: [], ownerId: runOwner(),
            payloadEnc: svc().encrypt(TaskOfferSchema.parse({ taskId: runId, jobId: "run-job-x", adapterId: "playwright", leaseSeconds: 3, workers: 1, scripts: [{ testId: "t", filename: "t.spec.ts", content: "x" }], env: { baseUrl: APP, headless: true } })),
        });
        const run = await bystander.next(5000);
        expect(run?.adapterId).toBe("playwright");
        expect((await push(bystander, run!.taskId)).status).toBe(409);
        svc().store.failQueuedOrRunning(runId, "test over");
    });

    it("validates every push: shape, size, and the secrets rules; never stores or serves a typed secret or a known credential", async () => {
        expect((await agent.recording(offer.taskId, { status: "saved", steps: [] })).status).toBe(400);
        expect((await agent.recording(offer.taskId, { status: "recording", steps: "no" })).status).toBe(400);
        const many = Array.from({ length: 1001 }, (_, i) => wstep(i));
        expect((await agent.recording(offer.taskId, { status: "recording", steps: many })).status).toBe(400);
        const huge = JSON.stringify({ status: "recording", steps: [], notes: ["x".repeat(300)], pad: "y".repeat(1_100_000) });
        expect((await agent.send("POST", `/api/agent/tasks/${offer.taskId}/recording`, { headers: { authorization: `Bearer ${(agent as unknown as { token: string }).token}`, "content-type": "application/json" }, body: huge })).status).toBe(413);
        expect((await get(rid)).steps).toHaveLength(0);

        await sleep(300);
        const ok = await push(agent, offer.taskId, {
            steps: [
                gotoStep(),
                wstep(1),
                wstep(2, { kind: "fill", value: TYPED, secret: true, describe: `Type ${TYPED} into the password field`, locator: { strategy: "label", value: "Password" } }),
                wstep(3, { kind: "fill", value: PASSWORD, describe: `Type ${PASSWORD} into the box` }),
                { ...wstep(4), kind: "goto", url: "javascript:alert(1)" },
            ],
            notes: [`Saw ${PASSWORD}`],
        });
        expect(ok.status, ok.text).toBe(200);
        const rec = await get(rid);
        expect(rec).toMatchObject({ status: "recording", currentUrl: `${APP}/shop`, canSave: true });
        expect(rec.steps.map((s: { kind: string }) => s.kind)).toEqual(["goto", "click", "fill", "fill"]);
        expect(rec.steps[2]).toMatchObject({ secret: true, value: "{{credentials.password}}" });
        const everything = [...answers, JSON.stringify(platform.db.all("SELECT * FROM agent_tasks")), JSON.stringify(platform.db.all("SELECT * FROM generation_jobs"))].join("\n");
        expect(everything).not.toContain(TYPED);
        expect(everything).not.toContain(PASSWORD);
    });

    it("commands from the page are queued in order, answered with the known state, delivered in the heartbeat replies and removed when the agent confirms", async () => {
        await sleep(300);
        const a = await admin("POST", `/api/recordings/${rid}/inspect`, { on: true, mode: "assertion", check: "text" });
        expect(a).toMatchObject({ status: 200, body: { pendingCommands: 1, inspect: { on: false } } });
        const b = await admin("PATCH", `/api/recordings/${rid}/steps/1`, { locator: { strategy: "css", value: "#b1" } });
        expect(b).toMatchObject({ status: 200, body: { pendingCommands: 2 } });
        const c = await admin("DELETE", `/api/recordings/${rid}/steps/3`);
        expect(c).toMatchObject({ status: 200, body: { pendingCommands: 3 } });
        expect(c.body.steps).toHaveLength(4); // nothing is applied before the agent confirms
        expect((await admin("PATCH", `/api/recordings/${rid}/steps/99`, { value: "x" })).status).toBe(404);
        expect((await admin("PATCH", `/api/recordings/${rid}/steps/2`, { value: "x" })).status).toBe(400); // a secret step
        expect((await admin("PATCH", `/api/recordings/${rid}/steps/0`, { locator: { strategy: "css", value: "a" } })).status).toBe(400);

        const beat1 = await agent.heartbeat(offer.taskId);
        expect(beat1.status).toBe(200);
        expect(beat1.json.cancel).toBe(false);
        const cmds = beat1.json.commands as Array<{ id: string; type: string }>;
        expect(cmds.map((x) => x.type)).toEqual(["inspect", "patch", "delete"]);
        expect(new Set(cmds.map((x) => x.id)).size).toBe(3);
        // Not confirmed yet: the same commands come again.
        expect(((await agent.heartbeat(offer.taskId)).json.commands as unknown[]).length).toBe(3);

        await sleep(300);
        const confirmed = await push(agent, offer.taskId, { acked: [cmds[0]!.id, cmds[1]!.id], inspect: { on: true, mode: "assertion", check: "text" }, steps: [gotoStep(), wstep(1, { locator: { strategy: "css", value: "#b1" } }), wstep(2, { kind: "fill", value: "{{credentials.password}}", secret: true, locator: { strategy: "label", value: "Password" } }), wstep(3, { kind: "fill", value: "x" })] });
        expect(confirmed.status, confirmed.text).toBe(200);
        const mid = await get(rid);
        expect(mid).toMatchObject({ pendingCommands: 1, inspect: { on: true, mode: "assertion", assertCheck: "text" } });
        expect(mid.steps[1].locator).toEqual({ strategy: "css", value: "#b1" });
        expect(((await agent.heartbeat(offer.taskId)).json.commands as Array<{ type: string }>).map((x) => x.type)).toEqual(["delete"]);

        const stop = await admin("POST", `/api/recordings/${rid}/stop`);
        expect(stop).toMatchObject({ status: 200, body: { status: "recording", pendingCommands: 2 } });
        expect(((await agent.heartbeat(offer.taskId)).json.commands as Array<{ type: string }>).map((x) => x.type)).toEqual(["delete", "stop"]);
    });

    it("the agent ends it: the final push and the normal result leave it stopped with its steps, and later news is refused", async () => {
        await sleep(300);
        const beat = (await agent.heartbeat(offer.taskId)).json.commands as Array<{ id: string }>;
        const fin = await push(agent, offer.taskId, { status: "stopped", acked: beat.map((x) => x.id), steps: [gotoStep(), wstep(1), wstep(2, { kind: "fill", value: "x" })] });
        expect(fin.status).toBe(200);
        const done = await get(rid);
        expect(done).toMatchObject({ status: "stopped", pendingCommands: 0, canSave: true });
        expect(done.stoppedAt).toBeDefined();
        await sleep(300);
        expect((await push(agent, offer.taskId)).status).toBe(409);
        expect((await agent.result(offer.taskId, { ok: true, runs: [] })).status).toBe(200);
        expect(svc().store.getTask(offer.taskId)!.status).toBe("done");
        expect((await admin("POST", `/api/recordings/${rid}/inspect`, { on: true })).status).toBe(409);
        // A stopped recording can still be edited (the agent is gone, so the platform's copy takes the edit) and saved.
        const after = await admin("DELETE", `/api/recordings/${rid}/steps/1`);
        expect(after).toMatchObject({ status: 200, body: { pendingCommands: 0 } });
        expect(after.body.steps.map((s: { index: number }) => s.index)).toEqual([0, 1]);
        const edited = await admin("PATCH", `/api/recordings/${rid}/steps/1`, { value: "edited value" });
        expect(edited.status).toBe(200);
        expect(edited.body.steps[1].value).toBe("edited value");
    });

    it("pushes are limited to a few per second", async () => {
        const { rid: r2, offer: o2 } = await startAndClaim(projectId, agent);
        await sleep(1100);
        const codes: number[] = [];
        for (let i = 0; i < 10; i++) codes.push((await push(agent, o2.taskId)).status);
        expect(codes.filter((c) => c === 200).length).toBeGreaterThanOrEqual(1);
        expect(codes.filter((c) => c === 200).length).toBeLessThanOrEqual(5);
        expect(codes).toContain(429);
        await endRecording(r2);
    });

    it("lost contact: 45 s becomes 1.5 s here; it stops with the plain sentence, keeps the steps, the lease sweep does not re-offer it, and the steps can be saved", async () => {
        const { rid: r3, offer: o3 } = await startAndClaim(projectId, agent);
        expect((await push(agent, o3.taskId)).status).toBe(200);
        const lost = await until(async () => {
            const r = await get(r3);
            return r.status === "stopped" ? r : undefined;
        }, "the lost contact stop");
        expect(lost.error).toBe("Lost contact with Maya's laptop. The steps recorded so far are kept.");
        expect(lost.steps).toHaveLength(2);
        expect(lost.canSave).toBe(true);
        await sleep(3300); // the lease (3 s) runs out
        svc().store.sweep();
        const task = svc().store.getTask(o3.taskId)!;
        expect(["failed", "cancelled"]).toContain(task.status);
        expect(task.status).not.toBe("queued");
        expect((await agent.heartbeat(o3.taskId)).json.cancel).toBe(true);
        const saved = await admin("POST", `/api/recordings/${r3}/save`, { title: "Recorded on the agent" });
        expect(saved.status, saved.text).toBe(201);
        expect(saved.body.testId).toBeTruthy();
        expect((await get(r3)).status).toBe("saved");
    });

    it("an agent that never takes the task: the recording fails with a plain sentence and the task is cancelled", async () => {
        const r = await start(projectId, { agentId: agent.agentId });
        expect(r.status).toBe(201);
        const failed = await until(async () => {
            const x = await get(r.body.id);
            return x.status === "failed" ? x : undefined;
        }, "the claim timeout");
        expect(failed.error).toMatch(/Maya's laptop did not start the recording/);
        expect(svc().store.queued(projectId)).toHaveLength(0);
        // The agent that wakes up later is not handed a dead task.
        expect((await agent.poll()).status).toBe(204);
    });

    it("discard answers at once even when the agent says nothing, drops the session, and tells the agent to give the task up", async () => {
        const { rid: r4, offer: o4 } = await startAndClaim(projectId, agent);
        expect((await push(agent, o4.taskId)).status).toBe(200);
        const t0 = Date.now();
        expect((await admin("DELETE", `/api/recordings/${r4}`)).status).toBe(200);
        expect(Date.now() - t0).toBeLessThan(3000);
        expect((await get(r4)).status).toBe("failed"); // gone (the stand-in for an id the platform no longer has)
        expect((await agent.heartbeat(o4.taskId)).json.cancel).toBe(true);
        // A new recording can start right away.
        const next = await start(projectId, { agentId: agent.agentId });
        expect(next.status).toBe(201);
        await endRecording(next.body.id);
    });

    it("stop then save: the platform asks the agent to stop, waits for its confirmation, then saves the final steps", async () => {
        const { rid: r5, offer: o5 } = await startAndClaim(projectId, agent);
        // A cooperative fake agent: it applies a stop command and confirms with the final push and the result.
        let running = true;
        const beating = (async () => {
            while (running) {
                const hb = await agent.heartbeat(o5.taskId);
                const cmds = (hb.json?.commands ?? []) as Array<{ id: string; type: string }>;
                if (cmds.some((c) => c.type === "stop")) {
                    await push(agent, o5.taskId, { status: "stopped", acked: cmds.map((c) => c.id), steps: [gotoStep(), wstep(1), wstep(2, { kind: "fill", value: "final value" })] });
                    await agent.result(o5.taskId, { ok: true, runs: [] });
                    return;
                }
                await sleep(100);
            }
        })();
        await sleep(300);
        expect((await push(agent, o5.taskId)).status).toBe(200);
        const saved = await admin("POST", `/api/recordings/${r5}/save`, { title: "Stopped on the agent then saved" });
        running = false;
        await beating;
        expect(saved.status, saved.text).toBe(201);
        const test = (await admin("GET", `/api/tests/${saved.body.testId}`)).body;
        expect(JSON.stringify(test)).toContain("final value");
        expect((await get(r5)).status).toBe("saved");
    });
});
