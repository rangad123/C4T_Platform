/**
 * Device reservations (kept in round 45): a phone, emulator or simulator of a runner is held by one running task at a time, whichever project
 * it is for, and released when the task ends, is taken back, or the runner is lost. Against real HTTP (a stand-in Crowd4Test sign-in on
 * 8764, the platform on 8765) and a fake runner: one person's computer with two phones.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskOffer } from "../src/agent-protocol/schema.js";
import { loadConfig } from "../src/config.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import { deviceNeedOf } from "../src/platform/agent-routing.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { defaultCaps, FakeAgent, viaFetch, type Reply } from "./fixtures/fake-agent.js";
import { personalRunner } from "./helpers/personal-runner.js";

const C4T_PORT = 8764;
const PORT = 8765;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "runners-owner-key-7a11c2";
const SECRET = "runners-test-secret-key-0123456789";
const PAGE = { "x-requested-with": "ai-studio" };
const me = (id: string, role: string, permissions: readonly string[], organisationId: string | null = null) => ({
    data: { user: { id, email: `${id}@people.example`, role, status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions, organisationId } },
});
const ACCOUNTS: Record<string, unknown> = {
    "t-admin": me("ada", "ADMIN", []),
    "t-cora": me("cora", "CUSTOMER", PERMISSIONS, "org-a"),
    "t-rita": me("rita", "CUSTOMER", ["ai_studio.access", "ai_studio.tests.write"], "org-a"),
    "t-bob": me("bob", "CUSTOMER", PERMISSIONS, "org-b"),
    "t-tim": me("tim", "TESTER", ["ai_studio.access", "ai_studio.runners.manage"]),
};
const android = (...serials: string[]) => ({ android: { adb: true, devices: serials.map((serial) => ({ serial, state: "device", emulator: false })), avds: [] } });

let c4t: http.Server;
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
const dirs: string[] = [];
const savedPoll = process.env.AGENT_POLL_SECONDS;

const call = async (headers: Record<string, string>, method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as "GET", url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body } as { status: number; body: any };
};
const asKey = (method: string, url: string, payload?: unknown) => call({ "x-api-key": KEY }, method, url, payload);
const as = (token: string, method: string, url: string, payload?: unknown) => call({ cookie: `c4t_access=${token}`, ...(method === "GET" ? {} : PAGE) }, method, url, payload);
const personOf = async (token: string): Promise<string> => (await as(token, "GET", "/api/auth/state")).body.me.id;
const addMember = async (projectId: string, token: string) => accessControlOf(app).projects.store.addMember(projectId, await personOf(token), { role: "owner", projectAdmin: false, source: "added", addedBy: "test" });
const svc = () => getAgentServices(platform);
const newProject = async (token: string, name: string) => (await as(token, "POST", "/api/projects", { name })).body.id as string;
const connect = async (secret: string, name: string, capabilities = defaultCaps(), concurrency = 1) => {
    const a = new FakeAgent(viaFetch(BASE), secret, { name, capabilities, concurrency });
    expect((await a.hello()).status).toBe(200);
    return a;
};
let ownerId = "";
const queue = (projectId: string, adapterId = "playwright", extra: Record<string, unknown> = {}, p = platform) => {
    const taskId = randomUUID();
    const jobId = randomUUID();
    const offer = TaskOffer.parse({ taskId, jobId, adapterId, leaseSeconds: 60, workers: 1, scripts: [], env: { baseUrl: "http://app.example", headless: true }, ...extra });
    getAgentServices(p).store.enqueue({ id: taskId, projectId, jobId, adapterId, payloadEnc: getAgentServices(p).encrypt(offer), files: [], ownerId });
    return taskId;
};
const pollOnce = async (a: FakeAgent, slots = 1): Promise<string | undefined> => (await a.poll(slots)).offer?.taskId;
const finish = async (a: FakeAgent, taskId: string): Promise<Reply> => a.result(taskId, { ok: true, runs: [] });

beforeAll(async () => {
    process.env.AGENT_POLL_SECONDS = "1";
    c4t = http.createServer((req, res) => {
        const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        res.writeHead(ACCOUNTS[auth] ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ACCOUNTS[auth] ?? { error: { message: "Invalid access token" } }));
    });
    await new Promise<void>((r) => c4t.listen(C4T_PORT, "127.0.0.1", r));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-runners-"));
    dirs.push(dir);
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECRET_KEY: SECRET, C4T_API_ORIGIN: `http://127.0.0.1:${C4T_PORT}`, C4T_SITE_URL: "https://crowd4test.example" }));
    app = await buildServer(platform);
    await app.listen({ port: PORT, host: "127.0.0.1" });
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    await new Promise((r) => c4t?.close(r));
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    if (savedPoll === undefined) delete process.env.AGENT_POLL_SECONDS;
    else process.env.AGENT_POLL_SECONDS = savedPoll;
});

describe("a phone is held by one task at a time, across projects", () => {
    let a = "";
    let b = "";
    let agent: FakeAgent;

    beforeAll(async () => {
        a = await newProject("t-cora", "Phones A");
        b = await newProject("t-cora", "Phones B");
        // Cora's own computer with two phones (round 45: a person's runner, used for their runs in every project).
        ownerId = await personOf("t-cora");
        agent = await connect(personalRunner(platform, { ownerId, label: "Phone rig", realPhone: true }).secret, "phone-rig", defaultCaps({ ...android("ph1", "ph2") }), 4);
    });

    it("keeps a second task waiting for the same phone, lets other work past it, and releases it when the task ends", async () => {
        const first = queue(a, "taqwright", { mobile: { deviceSerial: "ph1" } });
        const second = queue(b, "taqwright", { mobile: { deviceSerial: "ph1" } });
        const browser = queue(b);
        expect(await pollOnce(agent, 4)).toBe(first);
        expect(await pollOnce(agent, 4)).toBe(browser);
        expect((await agent.poll(4)).status).toBe(204);
        expect(svc().store.getTask(second)?.status).toBe("queued");
        expect(svc().store.reservations()).toMatchObject([{ device: "ph1", projectId: a }]);
        await finish(agent, first);
        await finish(agent, browser);
        expect(await pollOnce(agent, 4)).toBe(second);
        await finish(agent, second);
        expect(svc().store.reservations()).toEqual([]);
    }, 20_000);

    it("two different phones run side by side; a task that lets the runner pick waits for both", async () => {
        const one = queue(a, "taqwright", { mobile: { deviceSerial: "ph1" } });
        const two = queue(b, "taqwright", { mobile: { deviceSerial: "ph2" } });
        const any = queue(b, "taqwright");
        expect(await pollOnce(agent, 4)).toBe(one);
        expect(await pollOnce(agent, 4)).toBe(two);
        expect((await agent.poll(4)).status).toBe(204);
        await finish(agent, one);
        expect((await agent.poll(4)).status).toBe(204);
        await finish(agent, two);
        expect(await pollOnce(agent, 4)).toBe(any);
        // While it holds them all, a named phone waits.
        const named = queue(a, "taqwright", { mobile: { deviceSerial: "ph2" } });
        expect((await agent.poll(4)).status).toBe(204);
        await finish(agent, any);
        expect(await pollOnce(agent, 4)).toBe(named);
        await finish(agent, named);
    }, 20_000);

    it("releases the phone when the runner is lost, and when the task is taken back", async () => {
        const t = queue(a, "taqwright", { mobile: { deviceSerial: "ph1" } });
        expect(await pollOnce(agent, 4)).toBe(t);
        expect(svc().store.reservations()).toHaveLength(1);
        platform.db.run("UPDATE agents SET last_seen_ms = 1 WHERE id = ?", agent.agentId);
        svc().store.sweep();
        expect(svc().store.reservations()).toEqual([]);
        expect(await agent.hello()).toMatchObject({ status: 200 });
        await finish(agent, t);

        const back = queue(a, "taqwright", { mobile: { deviceSerial: "ph1" } });
        expect(await pollOnce(agent, 4)).toBe(back);
        platform.db.run("UPDATE agent_tasks SET lease_until = 1 WHERE id = ?", back);
        svc().store.sweep();
        expect(svc().store.getTask(back)?.status).toBe("queued");
        expect(svc().store.reservations()).toEqual([]);
        expect(await pollOnce(agent, 4)).toBe(back);
        await finish(agent, back);
    }, 20_000);

    it("reads the device from the offer: a named phone, an emulator, a simulator, or whichever the runner picks", () => {
        expect(deviceNeedOf({ adapterId: "playwright" })).toBeUndefined();
        expect(deviceNeedOf({ adapterId: "taqwright", mobile: { deviceSerial: "s1" } })).toEqual({ family: "android", device: "s1" });
        expect(deviceNeedOf({ adapterId: "taqwright", mobile: { runsOn: { kind: "explored" }, exploredOn: { serial: "s2" } } })).toEqual({ family: "android", device: "s2" });
        expect(deviceNeedOf({ adapterId: "taqwright", mobile: { avd: "Pixel" } })).toEqual({ family: "android", device: "avd:Pixel" });
        expect(deviceNeedOf({ adapterId: "taqwright-ios", ios: { defaultSimulator: "iPhone 15" } })).toEqual({ family: "ios", device: "iPhone 15" });
        expect(deviceNeedOf({ adapterId: "device:x", kind: "device", device: { deviceSerial: "s3" } })).toEqual({ family: "android", device: "s3" });
        expect(deviceNeedOf({ adapterId: "device:x", kind: "device", device: {} })).toEqual({ family: "android", device: "*" });
    });
});

