/**
 * Runners shared across projects (AD-08, AD-09, RU-06), against real HTTP, a stand-in Crowd4Test sign-in (port 7800), a platform on
 * 7801 and fake runners that speak protocol 1 unchanged: a runner registered before the change still connects and gets its project's
 * tasks; organisations and projects stay apart; a task goes only to a runner the project may use and whose capabilities fit; a phone is
 * held by one task at a time across projects and is released when the task ends or the runner is lost; the permissions; the health views.
 * A second platform on an old-shaped database proves the migration.
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
import { AGENTS_MIGRATION, hashToken, newAgentToken } from "../src/platform/agent-store.js";
import { deviceNeedOf } from "../src/platform/agent-routing.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { Db } from "../src/platform/db.js";
import { buildServer } from "../src/platform/server.js";
import { defaultCaps, FakeAgent, viaFetch, type Reply } from "./fixtures/fake-agent.js";

const C4T_PORT = 7800;
const PORT = 7801;
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
const register = async (token: string, name: string, organizationId?: string | null) => (await as(token, "POST", "/api/runners", { name, ...(organizationId !== undefined ? { organizationId } : {}) })).body as { runner: { id: string }; secret: string };
const connect = async (secret: string, name: string, capabilities = defaultCaps(), concurrency = 1) => {
    const a = new FakeAgent(viaFetch(BASE), secret, { name, capabilities, concurrency });
    expect((await a.hello()).status).toBe(200);
    return a;
};
const queue = (projectId: string, adapterId = "playwright", extra: Record<string, unknown> = {}, p = platform) => {
    const taskId = randomUUID();
    const jobId = randomUUID();
    const offer = TaskOffer.parse({ taskId, jobId, adapterId, leaseSeconds: 60, workers: 1, scripts: [], env: { baseUrl: "http://app.example", headless: true }, ...extra });
    getAgentServices(p).store.enqueue({ id: taskId, projectId, jobId, adapterId, payloadEnc: getAgentServices(p).encrypt(offer), files: [] });
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

describe("a runner registered before the change", () => {
    it("keeps its token, joins its project's organisation, still polls and gets its project's tasks, and nothing of another project", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-runners-old-"));
        dirs.push(dir);
        const file = path.join(dir, "platform.db");
        // A database as it was: the old tables, one runner of a project, and slot 42 recorded while it was still empty.
        const db = new Db(file);
        const old = AGENTS_MIGRATION.slice(0, AGENTS_MIGRATION.indexOf("CREATE TABLE runner_settings"));
        const secret = newAgentToken();
        const at = new Date().toISOString();
        db.raw.exec(`DROP TABLE device_reservations; DROP TABLE runner_access; DROP TABLE agents; DROP TABLE agent_tokens; ${old}`);
        db.run("INSERT INTO users (id, email, created_at) VALUES ('u1','u1@example.com',?)", at);
        db.run("INSERT INTO organizations (id, synced_at) VALUES ('org-old', ?)", at);
        db.run("INSERT INTO projects (id, owner_id, name, created_at, updated_at, organization_id) VALUES ('p-old','u1','Old',?,?,'org-old')", at, at);
        db.run("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES ('p-other','u1','Other',?,?)", at, at);
        db.run("INSERT INTO agent_tokens (id, project_id, label, token_hash, hint, created_at) VALUES ('tok-old','p-old','Old laptop',?,?,?)", hashToken(secret), secret.slice(-4), at);
        db.run("INSERT INTO agents (id, project_id, token_id, name, version, os, arch, node, capabilities_json, concurrency, first_seen_ms, last_seen_ms) VALUES ('agent-old','p-old','tok-old','Old laptop','1.0','linux','x64','v24',?,1,1,1)", JSON.stringify(defaultCaps()));
        db.close();

        const old2 = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECRET_KEY: SECRET }));
        const server = await buildServer(old2);
        await server.listen({ port: PORT + 1, host: "127.0.0.1" });
        try {
            const store = getAgentServices(old2).store;
            expect(store.getToken("tok-old")).toMatchObject({ projectId: "p-old", organizationId: "org-old", label: "Old laptop" });
            expect(store.projectsOf("tok-old").map((x) => x.projectId)).toEqual(["p-old"]);
            const agent = new FakeAgent(viaFetch(`http://127.0.0.1:${PORT + 1}`), secret, { name: "Old laptop" });
            const hello = await agent.hello();
            expect(hello.json).toMatchObject({ agentId: "agent-old", projectId: "p-old", protocol: 1 });
            queue("p-other", "playwright", {}, old2);
            const mine = queue("p-old", "playwright", {}, old2);
            expect(await pollOnce(agent)).toBe(mine);
            expect((await finish(agent, mine)).status).toBe(200);
            expect((await agent.poll()).status).toBe(204);
        } finally {
            await server.close();
            old2.db.close();
        }
    }, 30_000);
});

describe("who sees and manages a runner", () => {
    let shop = "";
    let bank = "";
    let lab = "";
    let rig = { runner: { id: "" }, secret: "" };

    beforeAll(async () => {
        shop = await newProject("t-cora", "Shop");
        bank = await newProject("t-cora", "Internal");
        lab = await newProject("t-bob", "Lab");
    });

    it("lets a customer register in their own organisation only, and shows the token once", async () => {
        rig = await register("t-cora", "Rig one");
        expect(rig.secret).toMatch(/^aitg_/);
        expect(await as("t-cora", "GET", "/api/runners")).toMatchObject({ status: 200, body: { canRegister: true, canRegisterShared: false, runners: [{ id: rig.runner.id, name: "Rig one", organizationId: "org-a", status: "not-connected", canManage: true }] } });
        expect(JSON.stringify((await as("t-cora", "GET", "/api/runners")).body)).not.toContain(rig.secret);
        expect((await as("t-cora", "POST", "/api/runners", { name: "Theirs", organizationId: "org-b" })).status).toBe(403);
        expect((await as("t-rita", "POST", "/api/runners", { name: "Nope" })).status).toBe(403);
        expect((await as("t-tim", "POST", "/api/runners", { name: "Nope" })).status).toBe(403);
    });

    it("never shows a customer another organisation's runner, and answers 404 for it", async () => {
        expect((await as("t-bob", "GET", "/api/runners")).body.runners).toEqual([]);
        expect((await as("t-bob", "GET", `/api/runners/${rig.runner.id}`)).status).toBe(404);
        expect((await as("t-bob", "PATCH", `/api/runners/${rig.runner.id}`, { name: "Mine" })).status).toBe(404);
        expect((await as("t-bob", "POST", `/api/runners/${rig.runner.id}/retire`)).status).toBe(404);
        expect((await as("t-bob", "PUT", `/api/projects/${lab}/runner-access/${rig.runner.id}`)).status).toBe(404);
    });

    it("gives access within the organisation only, and a project never reaches another organisation's runner", async () => {
        expect((await as("t-cora", "PUT", `/api/projects/${shop}/runner-access/${rig.runner.id}`)).status).toBe(200);
        expect((await as("t-rita", "PUT", `/api/projects/${bank}/runner-access/${rig.runner.id}`)).status).toBe(403);
        expect((await as("t-admin", "PUT", `/api/projects/${lab}/runner-access/${rig.runner.id}`)).status).toBe(409);
        expect((await as("t-cora", "GET", `/api/projects/${lab}/runner-access`)).status).toBe(404);
        const access = (await as("t-cora", "GET", `/api/projects/${shop}/runner-access`)).body;
        expect(access).toMatchObject({ canManage: true, available: [], runners: [{ id: rig.runner.id, name: "Rig one" }] });
        const other = (await as("t-cora", "GET", `/api/projects/${bank}/runner-access`)).body;
        expect(other.available.map((x: { id: string }) => x.id)).toEqual([rig.runner.id]);
    });

    it("shows a project's people the runners it uses, without managing them", async () => {
        await addMember(shop, "t-tim");
        expect((await as("t-tim", "GET", "/api/runners")).body.runners).toMatchObject([{ id: rig.runner.id, canManage: false }]);
        expect((await as("t-tim", "PATCH", `/api/runners/${rig.runner.id}`, { name: "Mine" })).status).toBe(403);
        expect((await as("t-tim", "DELETE", `/api/projects/${shop}/runner-access/${rig.runner.id}`)).status).toBe(403);
        expect((await as("t-rita", "PATCH", `/api/runners/${rig.runner.id}`, { name: "Mine" })).status).toBe(403);
    });

    it("keeps Crowd4Test's shared machines with Crowd4Test: a customer may use one, never change it", async () => {
        const made = await register("t-admin", "Shared Mac", null);
        expect((await as("t-cora", "POST", "/api/runners", { name: "Shared", organizationId: null })).body.runner.organizationId).toBe("org-a");
        expect((await as("t-cora", "GET", `/api/runners/${made.runner.id}`)).status).toBe(404);
        expect((await as("t-cora", "PUT", `/api/projects/${shop}/runner-access/${made.runner.id}`)).status).toBe(404);
        expect((await as("t-admin", "PUT", `/api/projects/${shop}/runner-access/${made.runner.id}`)).status).toBe(200);
        expect((await as("t-cora", "GET", `/api/runners/${made.runner.id}`)).body).toMatchObject({ ownerName: "Crowd4Test (shared)", canManage: false, projects: [{ id: shop }] });
        expect((await as("t-cora", "POST", `/api/runners/${made.runner.id}/retire`)).status).toBe(403);
        expect((await as("t-cora", "DELETE", `/api/projects/${shop}/runner-access/${made.runner.id}`)).status).toBe(403);
        expect((await as("t-cora", "DELETE", `/api/projects/${shop}/agent-tokens/${made.runner.id}`)).status).toBe(403);
        // The admin sees the projects of every side; a customer's project is one more project to them.
        expect((await as("t-admin", "PUT", `/api/projects/${lab}/runner-access/${made.runner.id}`)).status).toBe(200);
        expect((await as("t-cora", "GET", `/api/runners/${made.runner.id}`)).body).toMatchObject({ projects: [{ id: shop }], otherProjects: 1 });
    });

    it("renames and retires: a retired runner cannot connect or be given to a project", async () => {
        expect((await as("t-cora", "PATCH", `/api/runners/${rig.runner.id}`, { name: "Rig renamed" })).body.name).toBe("Rig renamed");
        const a = await connect(rig.secret, "rig-host");
        expect((await as("t-cora", "POST", `/api/runners/${rig.runner.id}/retire`)).body.status).toBe("retired");
        expect((await as("t-cora", "POST", `/api/runners/${rig.runner.id}/retire`)).status).toBe(409);
        expect((await a.poll()).status).toBe(404);
        expect((await as("t-cora", "PUT", `/api/projects/${bank}/runner-access/${rig.runner.id}`)).status).toBe(409);
    });
});

describe("scheduling a shared runner", () => {
    let one = "";
    let two = "";
    let three = "";

    beforeAll(async () => {
        one = await newProject("t-cora", "Sched one");
        two = await newProject("t-cora", "Sched two");
        three = await newProject("t-cora", "Sched three");
    });

    it("serves every project with access, oldest first, and no other", async () => {
        const r = await register("t-cora", "Web box");
        for (const p of [one, two]) await as("t-cora", "PUT", `/api/projects/${p}/runner-access/${r.runner.id}`);
        const a = await connect(r.secret, "web-box");
        const hidden = queue(three);
        const first = queue(two);
        const second = queue(one);
        expect(await pollOnce(a)).toBe(first);
        await finish(a, first);
        expect(await pollOnce(a)).toBe(second);
        await finish(a, second);
        expect((await a.poll()).status).toBe(204);
        // Taking access away stops it at once; the work stays queued.
        await as("t-cora", "DELETE", `/api/projects/${two}/runner-access/${r.runner.id}`);
        const later = queue(two);
        expect((await a.poll()).status).toBe(204);
        expect(svc().store.getTask(later)?.status).toBe("queued");
        // Giving access to the third picks up what waited.
        await as("t-cora", "PUT", `/api/projects/${three}/runner-access/${r.runner.id}`);
        expect(await pollOnce(a)).toBe(hidden);
        await finish(a, hidden);
        svc().store.requestCancel(later);
        await as("t-cora", "POST", `/api/runners/${r.runner.id}/retire`);
    }, 20_000);

    it("sends a phone task to the runner with a phone, and a project may use several runners", async () => {
        const p = await newProject("t-cora", "Two machines");
        const web = await register("t-cora", "Browser only");
        const phone = await register("t-cora", "With phone");
        for (const r of [web, phone]) await as("t-cora", "PUT", `/api/projects/${p}/runner-access/${r.runner.id}`);
        const w = await connect(web.secret, "browser-only");
        const m = await connect(phone.secret, "with-phone", defaultCaps({ ...android("ph1") }));
        const task = queue(p, "taqwright");
        expect((await w.poll()).status).toBe(204);
        expect(await pollOnce(m)).toBe(task);
        await finish(m, task);
        const agents = (await as("t-cora", "GET", `/api/projects/${p}/agents`)).body as Array<{ name: string }>;
        expect(agents.map((a) => a.name).sort()).toEqual(["browser-only", "with-phone"]);
        for (const r of [web, phone]) await as("t-cora", "POST", `/api/runners/${r.runner.id}/retire`);
    }, 20_000);

    it("keeps to the runner a project chose, among those it may use, and refuses one it may not", async () => {
        const p = await newProject("t-cora", "Pinned");
        const q = await newProject("t-cora", "Not given");
        const picked = await register("t-cora", "Picked");
        const other = await register("t-cora", "Other");
        for (const r of [picked, other]) await as("t-cora", "PUT", `/api/projects/${p}/runner-access/${r.runner.id}`);
        const a = await connect(picked.secret, "picked");
        const b = await connect(other.secret, "other");
        expect((await as("t-cora", "PUT", `/api/projects/${q}/runner`, { runOn: "agent", agentId: a.agentId })).status).toBe(404);
        expect((await as("t-cora", "PUT", `/api/projects/${p}/runner`, { runOn: "agent", agentId: a.agentId })).status).toBe(200);
        const task = queue(p);
        expect((await b.poll()).status).toBe(204);
        expect(await pollOnce(a)).toBe(task);
        await finish(a, task);
        // Removing the chosen runner goes back to "any runner this project may use".
        await as("t-cora", "DELETE", `/api/projects/${p}/runner-access/${picked.runner.id}`);
        expect(svc().store.getRunner(p)).toEqual({ runOn: "agent", agentId: null });
        for (const r of [picked, other]) await as("t-cora", "POST", `/api/runners/${r.runner.id}/retire`);
    }, 20_000);
});

describe("a phone is held by one task at a time, across projects", () => {
    let a = "";
    let b = "";
    let runnerId = "";
    let agent: FakeAgent;
    const health = async () => (await as("t-cora", "GET", `/api/runners/${runnerId}`)).body;

    beforeAll(async () => {
        a = await newProject("t-cora", "Phones A");
        b = await newProject("t-cora", "Phones B");
        const r = await register("t-cora", "Phone rig");
        runnerId = r.runner.id;
        for (const p of [a, b]) await as("t-cora", "PUT", `/api/projects/${p}/runner-access/${runnerId}`);
        agent = await connect(r.secret, "phone-rig", defaultCaps({ ...android("ph1", "ph2") }), 4);
    });

    it("keeps a second task waiting for the same phone, lets other work past it, and releases it when the task ends", async () => {
        const first = queue(a, "taqwright", { mobile: { deviceSerial: "ph1" } });
        const second = queue(b, "taqwright", { mobile: { deviceSerial: "ph1" } });
        const browser = queue(b);
        expect(await pollOnce(agent, 4)).toBe(first);
        expect(await pollOnce(agent, 4)).toBe(browser);
        expect((await agent.poll(4)).status).toBe(204);
        expect(svc().store.getTask(second)?.status).toBe("queued");
        expect((await health()).devices.find((d: { key: string }) => d.key === "ph1")).toMatchObject({ heldBy: { projectName: "Phones A" } });
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

describe("runner health", () => {
    it("reports status, work, waits and failures, and keeps another project's names and errors out", async () => {
        const mine = await newProject("t-cora", "Health mine");
        const staff = await newProject("t-bob", "Health other org");
        const r = await register("t-admin", "Health shared", null);
        for (const p of [mine, staff]) await as("t-admin", "PUT", `/api/projects/${p}/runner-access/${r.runner.id}`);
        const a = await connect(r.secret, "health-host", defaultCaps({ ...android("hp1"), kitVersion: "1.2.3" }), 2);
        const failed = queue(staff);
        expect(await pollOnce(a, 2)).toBe(failed);
        expect((await a.result(failed, { ok: false, runs: [], error: "The secret other-org page broke" })).status).toBe(200);
        const running = queue(staff);
        expect(await pollOnce(a, 2)).toBe(running);

        const seen = (await as("t-cora", "GET", `/api/runners/${r.runner.id}`)).body;
        expect(seen).toMatchObject({ status: "busy", machineName: "health-host", version: "0.0.0-test", currentTasks: [{ kind: "Web and API tests", projectName: null, projectId: null }], recentFailures: { count: 1 }, otherProjects: 1 });
        expect(seen.agent.capabilities.browsers).toEqual(["chromium"]);
        expect(seen.agent.update).toBeDefined();
        expect(JSON.stringify(seen)).not.toContain("secret other-org");
        expect(JSON.stringify(seen)).not.toContain("Health other org");
        expect((await as("t-admin", "GET", `/api/runners/${r.runner.id}`)).body.recentFailures.items[0]).toMatchObject({ projectName: "Health other org", error: "The secret other-org page broke" });

        const summary = (await as("t-cora", "GET", "/api/runners/summary")).body;
        expect(summary).toMatchObject({ browsers: ["chromium"], recentFailures: 1 });
        expect(summary.phones).toBeGreaterThanOrEqual(1);
        expect(summary.busy).toBeGreaterThanOrEqual(1);
        expect((await as("t-bob", "GET", "/api/runners/summary")).body.total).toBeGreaterThanOrEqual(1);
        await finish(a, running);
        await as("t-admin", "POST", `/api/runners/${r.runner.id}/retire`);
    }, 20_000);
});
