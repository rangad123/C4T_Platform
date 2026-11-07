/**
 * Round 39: a person's own computer (personal runner) against real HTTP (stand-in Crowd4Test sign-in on 8024, the platform on 8025). It takes
 * only its owner's runs, in projects that allow people's own computers; nobody else sees or uses it; code scripts follow its owner's switch;
 * the per-run choice is honoured and an ineligible choice refused; the claim itself refuses another person's task.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskOffer } from "../src/agent-protocol/schema.js";
import { loadConfig } from "../src/config.js";
import { getAgentServices, PERSONAL_NOT_ALLOWED } from "../src/platform/agent-services.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import type { JobOptions } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { defaultCaps, FakeAgent, viaFetch } from "./fixtures/fake-agent.js";

const C4T_PORT = 8024;
const PORT = 8025;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "personal-owner-key-51c7d2";
const PAGE = { "x-requested-with": "ai-studio" };
const RUN = ["ai_studio.access", "ai_studio.tests.run"];
const me = (id: string, role: string, permissions: readonly string[], organisationId: string | null = null) => ({
    data: { user: { id, email: `${id}@people.example`, role, status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions, organisationId } },
});
const ACCOUNTS: Record<string, unknown> = {
    "t-ada": me("ada", "ADMIN", []),
    "t-tess": me("tess", "TESTER", RUN),
    "t-tom": me("tom", "TESTER", RUN),
    "t-vic": me("vic", "TESTER", ["ai_studio.access"]),
    "t-cora": me("cora", "CUSTOMER", PERMISSIONS, "org-a"),
};

let c4t: http.Server;
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let tmp = "";
let projectId = "";
let appId = "";
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

/** Add a person's computer: a code, traded once, and a runner that says hello with its install id. */
async function addComputer(who: string, connect = true): Promise<{ runnerId: string; agent?: FakeAgent; machineId: string }> {
    const code = (await as(who, "POST", "/api/runners/enroll", { kind: "personal" })).body.code as string;
    const machineId = `${randomUUID()}`;
    const res = await fetch(`${BASE}/api/agent/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: `${who}-pc-${++n}`, machineId }) });
    const got = (await res.json()) as { token: string; runnerId: string };
    if (!connect) return { runnerId: got.runnerId, machineId };
    const agent = new FakeAgent(viaFetch(BASE), got.token, { name: `${who}-pc-${n}`, capabilities: defaultCaps({ runnerSwitches: true }) });
    const h = await agent.hello({ machineId });
    expect(h.status).toBe(200);
    return { runnerId: got.runnerId, agent, machineId };
}

/** A queued task of a job started by `owner` (optionally with a runner chosen for it). */
function queue(owner: string, extra: { custom?: boolean; runnerId?: string; baseUrl?: string } = {}): string {
    const jobId = randomUUID();
    const options = { maxPages: 1, maxDepth: 1, maxScenarios: 1, targets: ["web"], allowMutatingApiTests: false, mode: "validate", testIds: [], startedBy: { kind: "user", id: owner }, ...(extra.runnerId ? { runner: { id: extra.runnerId } } : {}) };
    const t = new Date().toISOString();
    platform.db.run("INSERT INTO generation_jobs (id, project_id, application_id, status, options_json, progress_json, counters_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", jobId, projectId, appId, "VALIDATING", JSON.stringify(options), "{}", "{}", t, t);
    const taskId = randomUUID();
    const offer = TaskOffer.parse({ taskId, jobId, adapterId: "playwright", leaseSeconds: 60, workers: 1, scripts: [{ testId: "t1", filename: "t1.spec.ts", content: "//", ...(extra.custom ? { custom: true } : {}) }], env: { baseUrl: extra.baseUrl ?? "https://app.example", headless: true } });
    svc().store.enqueue({ id: taskId, projectId, jobId, adapterId: "playwright", payloadEnc: svc().encrypt(offer), files: [] });
    return taskId;
}
const gate = (owner: string, runnerId?: string) => svc().assertJobAllowed(projectId, { maxPages: 1, maxDepth: 1, maxScenarios: 1, targets: ["web"], allowMutatingApiTests: false, mode: "validate", testIds: [], startedBy: { kind: "user", id: owner }, ...(runnerId ? { runner: { id: runnerId } } : {}) } as JobOptions);
const refusal = (fn: () => void): { status?: number; message: string } => {
    try {
        fn();
        return { message: "" };
    } catch (e) {
        return { status: (e as { status?: number }).status, message: (e as Error).message };
    }
};

beforeAll(async () => {
    process.env.AGENT_POLL_SECONDS = "1";
    c4t = http.createServer((req, res) => {
        const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        res.writeHead(ACCOUNTS[auth] ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ACCOUNTS[auth] ?? { error: { message: "Invalid access token" } }));
    });
    await new Promise<void>((r) => c4t.listen(C4T_PORT, "127.0.0.1", r));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-personal-"));
    platform = bootstrap(loadConfig({ DATA_DIR: tmp, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECRET_KEY: "personal-test-secret-key-0123456789", C4T_API_ORIGIN: `http://127.0.0.1:${C4T_PORT}`, C4T_SITE_URL: "https://crowd4test.example" }));
    app = await buildServer(platform);
    await app.listen({ port: PORT, host: "127.0.0.1" });
    projectId = (await asKey("POST", "/api/projects", { name: "Shared shop" })).body.id as string;
    appId = randomUUID();
    platform.db.run("INSERT INTO applications (id, project_id, url, origin, config_json, created_at) VALUES (?,?,?,?,?,?)", appId, projectId, "https://app.example", "https://app.example", "{}", new Date().toISOString());
    for (const who of ["t-tess", "t-tom", "t-vic"]) {
        ids[who] = (await as(who, "GET", "/api/auth/state")).body.me.id as string;
        accessControlOf(app).projects.store.addMember(projectId, ids[who]!, { role: "owner", projectAdmin: false, source: "added", addedBy: "test" });
    }
    svc().store.setRunner(projectId, { runOn: "agent", agentId: null });
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    await new Promise((r) => c4t?.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
    if (savedPoll === undefined) delete process.env.AGENT_POLL_SECONDS;
    else process.env.AGENT_POLL_SECONDS = savedPoll;
});

describe("a person's own computer", () => {
    let tess: { runnerId: string; agent?: FakeAgent; machineId: string };
    let tom: { runnerId: string; agent?: FakeAgent; machineId: string };

    it("anyone who runs tests may add one (testers included); the answers say what the caller may do", async () => {
        const list = (await as("t-tess", "GET", "/api/runners")).body;
        expect(list).toMatchObject({ canAddPersonal: true, canAddTeam: false, personal: { count: 0, max: 5 } });
        expect((await as("t-vic", "GET", "/api/runners")).body.canAddPersonal).toBe(false);
        expect((await as("t-vic", "POST", "/api/runners/enroll", { kind: "personal" })).status).toBe(403);
        expect((await as("t-tess", "POST", "/api/runners/enroll", { kind: "team" })).status).toBe(403);
        tess = await addComputer("t-tess");
        tom = await addComputer("t-tom");
        const view = (await as("t-tess", "GET", `/api/runners/${tess.runnerId}`)).body;
        expect(view).toMatchObject({ kind: "personal", mine: true, canManage: true, ownerName: "You", settings: { codeScripts: true, privateAddresses: false, privateAddressesSwitch: true } });
        const h = await tess.agent!.hello({ machineId: tess.machineId });
        expect(h.json.runner).toMatchObject({ kind: "personal", customScripts: true, privateTargets: false });
    });

    it("takes only its owner's runs, and the claim itself refuses a colleague's task", async () => {
        const mine = queue(ids["t-tess"]!);
        const theirs = queue(ids["t-tom"]!);
        expect((await tess.agent!.poll(1)).offer?.taskId).toBe(mine);
        expect((await tess.agent!.poll(1)).offer).toBeUndefined();
        expect(svc().store.claimFor(theirs, { id: tess.agent!.agentId, tokenId: tess.runnerId }, 60_000)).toBeUndefined();
        expect((await tom.agent!.poll(1)).offer?.taskId).toBe(theirs);
        for (const [a, t] of [[tess, mine], [tom, theirs]] as const) await a.agent!.result(t, { ok: true, runs: [] });
    });

    it("nobody else sees, changes or pins it; it is never given to a project", async () => {
        expect((await as("t-tom", "GET", `/api/runners/${tess.runnerId}`)).status).toBe(404);
        expect((await as("t-tom", "PATCH", `/api/runners/${tess.runnerId}`, { name: "Mine now" })).status).toBe(404);
        expect((await as("t-cora", "GET", `/api/runners/${tess.runnerId}`)).status).toBe(404);
        expect((await as("t-tom", "GET", "/api/runners")).body.runners.map((r: { id: string }) => r.id)).not.toContain(tess.runnerId);
        expect((await as("t-ada", "GET", `/api/runners/${tess.runnerId}`)).status).toBe(200);
        expect((await asKey("GET", `/api/projects/${projectId}/agents`)).body.map((a: { tokenId: string }) => a.tokenId)).not.toContain(tess.runnerId);
        // (The runs above are over; the setting refuses changes while a run is going.)
        platform.db.run("UPDATE generation_jobs SET status = 'COMPLETED' WHERE project_id = ?", projectId);
        expect((await asKey("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent", agentId: tess.agent!.agentId })).status).toBe(404);
        expect((await asKey("GET", `/api/projects/${projectId}/runner-access`)).body.available.map((r: { id: string }) => r.id)).not.toContain(tess.runnerId);
        expect((await as("t-ada", "PUT", `/api/projects/${projectId}/runner-access/${tess.runnerId}`)).status).toBe(409);
    });

    it("the project switch off: their runs do not go to their computer, and choosing it is refused with a sentence", async () => {
        expect((await asKey("PUT", `/api/projects/${projectId}/runner`, { allowPersonal: false })).body.allowPersonal).toBe(false);
        const t = queue(ids["t-tess"]!);
        expect((await tess.agent!.poll(1)).offer).toBeUndefined();
        expect(refusal(() => gate(ids["t-tess"]!, tess.runnerId))).toEqual({ status: 409, message: PERSONAL_NOT_ALLOWED });
        expect(refusal(() => gate(ids["t-tess"]!)).message).toContain("does not allow people's own computers");
        expect((await as("t-tess", "GET", `/api/projects/${projectId}/runner-choices`)).body).toMatchObject({ allowPersonal: false });
        expect((await asKey("PUT", `/api/projects/${projectId}/runner`, { allowPersonal: true })).body.allowPersonal).toBe(true);
        expect((await tess.agent!.poll(1)).offer?.taskId).toBe(t);
        await tess.agent!.result(t, { ok: true, runs: [] });
    });

    it("code scripts follow the owner's switch", async () => {
        expect((await as("t-tess", "PATCH", `/api/runners/${tess.runnerId}`, { codeScripts: false })).body.settings.codeScripts).toBe(false);
        const t = queue(ids["t-tess"]!, { custom: true });
        expect((await tess.agent!.poll(1)).offer).toBeUndefined();
        expect((await as("t-tess", "PATCH", `/api/runners/${tess.runnerId}`, { codeScripts: true })).status).toBe(200);
        expect((await tess.agent!.poll(1)).offer?.taskId).toBe(t);
        await tess.agent!.result(t, { ok: true, runs: [] });
        // Private addresses: a switch of a person's own computer only.
        expect((await as("t-tess", "PATCH", `/api/runners/${tess.runnerId}`, { privateAddresses: true })).body.settings.privateAddresses).toBe(true);
        expect((await tess.agent!.hello({ machineId: tess.machineId })).json.runner.privateTargets).toBe(true);
        expect((await as("t-tess", "PATCH", `/api/runners/${tess.runnerId}`, { privateAddresses: false })).status).toBe(200);
        const local = queue(ids["t-tess"]!, { baseUrl: "http://localhost:3000" });
        expect((await tess.agent!.poll(1)).offer).toBeUndefined();
        svc().store.requestCancel(local);
    });

    it("the per-run choice is honoured, and an ineligible choice is refused (another person's computer: 404)", async () => {
        const reg = await asKey("POST", "/api/runners", { name: "Team box" });
        await asKey("PUT", `/api/projects/${projectId}/runner-access/${reg.body.runner.id}`);
        const team = new FakeAgent(viaFetch(BASE), reg.body.secret, { name: "team-box" });
        await team.hello();
        const forTeam = queue(ids["t-tess"]!, { runnerId: reg.body.runner.id });
        expect((await tess.agent!.poll(1)).offer).toBeUndefined();
        expect((await team.poll(1)).offer?.taskId).toBe(forTeam);
        const forMine = queue(ids["t-tess"]!, { runnerId: tess.runnerId });
        expect((await team.poll(1)).offer).toBeUndefined();
        expect((await tess.agent!.poll(1)).offer?.taskId).toBe(forMine);
        expect(refusal(() => gate(ids["t-tess"]!, tom.runnerId)).status).toBe(404);
        const ungranted = await asKey("POST", "/api/runners", { name: "Elsewhere" });
        expect(refusal(() => gate(ids["t-tess"]!, ungranted.body.runner.id)).status).toBe(404);
        const sleeping = await addComputer("t-tess", false);
        expect(refusal(() => gate(ids["t-tess"]!, sleeping.runnerId))).toMatchObject({ status: 409 });
        expect(refusal(() => gate(ids["t-tess"]!, tess.runnerId)).message).toBe("");
        const choices = (await as("t-tess", "GET", `/api/projects/${projectId}/runner-choices`)).body;
        const listed = choices.runners.map((r: { id: string }) => r.id);
        expect(listed[0]).toBe(tess.runnerId);
        expect(listed).toContain(reg.body.runner.id);
        expect(listed).not.toContain(tom.runnerId);
        expect(choices.runners.find((r: { id: string }) => r.id === sleeping.runnerId)).toMatchObject({ kind: "personal", online: false, problem: "It has not connected yet." });
        expect((await as("t-vic", "GET", `/api/projects/${projectId}/runner-choices`)).status).toBe(403);
    });

    it("at most five per person, and retiring is its owner's", async () => {
        while ((await as("t-tess", "GET", "/api/runners")).body.personal.count < 5) await addComputer("t-tess", false);
        const sixth = await as("t-tess", "POST", "/api/runners/enroll", { kind: "personal" });
        expect(sixth.status).toBe(409);
        expect(sixth.body.error ?? sixth.body.message).toContain("the most one person can have");
        expect((await as("t-tom", "POST", `/api/runners/${tess.runnerId}/retire`)).status).toBe(404);
        expect((await as("t-tess", "POST", `/api/runners/${tess.runnerId}/retire`)).status).toBe(200);
        expect((await tess.agent!.hello({ machineId: tess.machineId })).status).toBe(404);
    });
});
