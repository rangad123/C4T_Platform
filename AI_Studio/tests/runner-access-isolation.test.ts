/**
 * Round 40: a task belongs to the runner that claimed it, for every route of protocol 2 too. Another person's runner (round 45: every runner
 * is one person's), and the claiming runner itself once it is removed get nothing: no offer, and "not found" for accept, reject,
 * heartbeat, live events, download, upload and result. The run's live pictures (runner-files) are served only for a task of that run of that
 * project, and only as an image. (Claim eligibility is in runner-personal.test.ts.) No browser, no port: everything through the server's inject.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskOffer } from "../src/agent-protocol/schema.js";
import { loadConfig } from "../src/config.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { UserStore } from "../src/platform/user-store.js";
import { personalRunner } from "./helpers/personal-runner.js";
import { defaultCaps, FakeAgent, passedRun, viaInject } from "./fixtures/fake-agent.js";

const KEY = "isolation-admin-key-3b8e51";
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let tmp = "";
const savedPoll = process.env.AGENT_POLL_SECONDS;

const asKey = async (method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as "GET", url, headers: { "x-api-key": KEY }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body, raw: r.rawPayload, headers: r.headers } as { status: number; body: any; raw: Buffer; headers: Record<string, unknown> };
};
const svc = () => getAgentServices(platform);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3]);

async function project(name: string): Promise<{ id: string; appId: string }> {
    const id = (await asKey("POST", "/api/projects", { name })).body.id as string;
    const appId = randomUUID();
    platform.db.run("INSERT INTO applications (id, project_id, url, origin, config_json, created_at) VALUES (?,?,?,?,?,?)", appId, id, "https://app.example", "https://app.example", "{}", new Date().toISOString());
    svc().store.setRunner(id, { runOn: "agent" });
    return { id, appId };
}
/** A person (an account of this server) and their own runner. */
const people = new Map<string, string>();
async function runner(name: string): Promise<{ agent: FakeAgent; tokenId: string; ownerId: string }> {
    const ownerId = people.get(name) ?? new UserStore(platform.db).create({ email: `${name.replace(/\W/g, "")}@people.example`, name, role: "editor" }).id;
    people.set(name, ownerId);
    const made = personalRunner(platform, { ownerId, label: name });
    const agent = new FakeAgent(viaInject(app), made.secret, { name, capabilities: defaultCaps() });
    expect((await agent.hello({ protocol: 2 })).status).toBe(200);
    return { agent, tokenId: made.id, ownerId };
}
function queue(p: { id: string; appId: string }, owner: string): { taskId: string; jobId: string } {
    const jobId = randomUUID();
    const options = { maxPages: 1, maxDepth: 1, maxScenarios: 1, targets: ["web"], allowMutatingApiTests: false, mode: "validate", testIds: [], startedBy: { kind: "user", id: owner } };
    const t = new Date().toISOString();
    platform.db.run("INSERT INTO generation_jobs (id, project_id, application_id, status, options_json, progress_json, counters_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", jobId, p.id, p.appId, "VALIDATING", JSON.stringify(options), "{}", "{}", t, t);
    const taskId = randomUUID();
    const offer = TaskOffer.parse({ taskId, jobId, adapterId: "playwright", leaseSeconds: 60, workers: 1, scripts: [{ testId: "t1", filename: "t1.spec.ts", content: "//" }], env: { baseUrl: "https://app.example", headless: true } });
    svc().store.enqueue({ id: taskId, projectId: p.id, jobId, adapterId: "playwright", payloadEnc: svc().encrypt(offer), files: [] });
    return { taskId, jobId };
}
const json = (agent: FakeAgent, url: string, body: unknown) => agent.send("POST", url, { headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
/** Every task route, as `who`, for a task they did not claim. */
async function everyRoute(who: FakeAgent, taskId: string, attemptId: string): Promise<Record<string, number>> {
    const event = { seq: 1, at: new Date().toISOString(), type: "log", line: "hello" };
    return {
        accept: (await json(who, `/api/agent/tasks/${taskId}/accept`, { attemptId })).status,
        reject: (await json(who, `/api/agent/tasks/${taskId}/reject`, { attemptId, reason: "busy", message: "Busy." })).status,
        heartbeat: (await who.heartbeat(taskId, { attemptId, done: 0, total: 1 })).status,
        events: (await json(who, `/api/agent/tasks/${taskId}/events`, { attemptId, events: [event] })).status,
        download: (await who.download(taskId, "anything.png")).status,
        upload: (await who.upload(taskId, "x.png", PNG, { "x-attempt-id": attemptId })).status,
        result: (await who.result(taskId, { ok: true, runs: [passedRun("t1")], attemptId })).status,
    };
}

beforeAll(async () => {
    process.env.AGENT_POLL_SECONDS = "1";
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-isolation-"));
    platform = bootstrap(loadConfig({ DATA_DIR: tmp, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECRET_KEY: "isolation-test-secret-key-0123456789" }));
    app = await buildServer(platform);
}, 60_000);
afterAll(async () => {
    await app?.close();
    platform?.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    if (savedPoll === undefined) delete process.env.AGENT_POLL_SECONDS;
    else process.env.AGENT_POLL_SECONDS = savedPoll;
});

describe("a task is its claiming runner's alone (protocol 2)", () => {
    it("another person's runner, in this project or elsewhere, gets no offer and 'not found' on every task route", async () => {
        const a = await project("Isolation A");
        const owner = await runner("owner");
        const { taskId } = queue(a, owner.ownerId);
        const offer = (await owner.agent.poll(1)).offer!;
        expect(offer.taskId).toBe(taskId);
        expect(offer.attemptId).toBeTruthy();
        const mate = await runner("mate");
        const stranger = await runner("stranger");
        for (const other of [mate, stranger]) {
            expect((await other.agent.poll(1)).status).toBe(204);
            expect(await everyRoute(other.agent, taskId, offer.attemptId!)).toEqual({ accept: 404, reject: 404, heartbeat: 404, events: 404, download: 404, upload: 404, result: 404 });
        }
        // Untouched: the owner still accepts, sends an event and a picture, and finishes it.
        expect((await json(owner.agent, `/api/agent/tasks/${taskId}/accept`, { attemptId: offer.attemptId })).status).toBe(200);
        expect((await owner.agent.upload(taskId, "live-1-t1.png", PNG, { "x-attempt-id": offer.attemptId! })).status).toBe(200);
        expect((await owner.agent.result(taskId, { ok: true, runs: [passedRun("t1")], attemptId: offer.attemptId })).status).toBe(200);
    });

    it("a runner removed while it holds a task can no longer touch it, or get another", async () => {
        const a = await project("Isolation revoked");
        const owner = await runner("soon revoked");
        const { taskId } = queue(a, owner.ownerId);
        const offer = (await owner.agent.poll(1)).offer!;
        expect((await json(owner.agent, `/api/agent/tasks/${taskId}/accept`, { attemptId: offer.attemptId })).status).toBe(200);
        expect(svc().store.retire(owner.ownerId)).toBe(true);
        queue(a, owner.ownerId);
        expect((await owner.agent.poll(1)).status).toBe(404);
        const after = await everyRoute(owner.agent, taskId, offer.attemptId!);
        // Every route refuses the revoked credential (404 for a credential the platform no longer knows; never a 2xx).
        expect(Object.values(after).every((s) => s === 401 || s === 404)).toBe(true);
        expect(svc().store.filesOf(taskId, "out")).toEqual([]);
    });

    it("live pictures (runner-files): only a task of that run of that project, only images", async () => {
        const a = await project("Pictures A");
        const b = await project("Pictures B");
        const owner = await runner("pictures");
        const { taskId, jobId } = queue(a, owner.ownerId);
        const other = queue(a, owner.ownerId); // another run of the same project
        const offer = (await owner.agent.poll(1)).offer!;
        expect((await json(owner.agent, `/api/agent/tasks/${taskId}/accept`, { attemptId: offer.attemptId })).status).toBe(200);
        expect((await owner.agent.upload(taskId, "live-1-t1.png", PNG, { "x-attempt-id": offer.attemptId! })).status).toBe(200);
        expect((await owner.agent.upload(taskId, "t1-trace.zip", Buffer.from("PK\x03\x04trace"), { "x-attempt-id": offer.attemptId! })).status).toBe(200);
        const url = (p: string, j: string, t: string, n: string) => `/api/projects/${p}/runs/${j}/runner-files/${t}/${n}`;
        const ok = await asKey("GET", url(a.id, jobId, taskId, "live-1-t1.png"));
        expect(ok.status).toBe(200);
        expect(ok.headers["content-type"]).toBe("image/png");
        expect(ok.headers["x-content-type-options"]).toBe("nosniff");
        expect((await asKey("GET", url(b.id, jobId, taskId, "live-1-t1.png"))).status).toBe(404); // another project
        expect((await asKey("GET", url(a.id, other.jobId, taskId, "live-1-t1.png"))).status).not.toBe(200); // another run of the project
        expect((await asKey("GET", url(a.id, jobId, taskId, "t1-trace.zip"))).status).toBe(404); // a trace is never served here
        expect((await asKey("GET", url(a.id, jobId, taskId, "..%2Flive-1-t1.png"))).status).toBe(404);
    });
});
