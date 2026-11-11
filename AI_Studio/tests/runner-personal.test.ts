/**
 * Round 45: one runner per person, set up in Settings and used for every run they start, against real HTTP (stand-in Crowd4Test sign-in
 * on 8760, the platform on 8761). Covers GET/PATCH /api/me/runner, the enrollment status, setting up a computer again retiring the one
 * before, "Remove this computer", the admins' list, routing by owner only (the claim itself refuses a colleague's task), the owner's three
 * switches, the up-front refusals (not set up, offline, the shared key), and a team or project credential refused at hello with a 401 and
 * the sentence that sends its person to Settings.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskOffer } from "../src/agent-protocol/schema.js";
import { loadConfig } from "../src/config.js";
import { getAgentServices, KEY_HAS_NO_RUNNER, RUNNER_NOT_SET_UP, RUNNER_OFFLINE, TEAM_RUNNER_REFUSED } from "../src/platform/agent-services.js";
import { hashToken, newAgentToken } from "../src/platform/agent-store.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { runAs } from "../src/platform/auth/actor.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import type { JobOptions } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { defaultCaps, FakeAgent, viaFetch } from "./fixtures/fake-agent.js";

const C4T_PORT = 8760;
const PORT = 8761;
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

/** Set up a person's computer: a one-time code (as the download carries it), traded once, and a runner that says hello with its install id. */
async function setUp(who: string, connect = true): Promise<{ runnerId: string; agent?: FakeAgent; machineId: string; enrollmentId: string; token: string }> {
    const { code, record } = svc().store.createPersonalEnrollment({ ownerId: ids[who]!, createdBy: who });
    const machineId = randomUUID();
    const res = await fetch(`${BASE}/api/agent/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: `${who}-pc-${++n}`, machineId }) });
    expect(res.status).toBe(201);
    const got = (await res.json()) as { token: string; runnerId: string; kind: string };
    expect(got.kind).toBe("personal");
    if (!connect) return { runnerId: got.runnerId, machineId, enrollmentId: record.id, token: got.token };
    const agent = new FakeAgent(viaFetch(BASE), got.token, { name: `${who}-pc-${n}`, capabilities: defaultCaps({ runnerSwitches: true }) });
    const h = await agent.hello({ machineId });
    expect(h.status).toBe(200);
    return { runnerId: got.runnerId, agent, machineId, enrollmentId: record.id, token: got.token };
}

/** A queued task of a job started by `owner`. */
function queue(owner: string, extra: { custom?: boolean; baseUrl?: string; secret?: string } = {}): string {
    const jobId = randomUUID();
    const options = { maxPages: 1, maxDepth: 1, maxScenarios: 1, targets: ["web"], allowMutatingApiTests: false, mode: "validate", testIds: [], startedBy: { kind: "user", id: owner } };
    const t = new Date().toISOString();
    platform.db.run("INSERT INTO generation_jobs (id, project_id, application_id, status, options_json, progress_json, counters_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", jobId, projectId, appId, "VALIDATING", JSON.stringify(options), "{}", "{}", t, t);
    const taskId = randomUUID();
    const offer = TaskOffer.parse({ taskId, jobId, adapterId: "playwright", leaseSeconds: 60, workers: 1, scripts: [{ testId: "t1", filename: "t1.spec.ts", content: "//", ...(extra.custom ? { custom: true } : {}) }], env: { baseUrl: extra.baseUrl ?? "https://app.example", headless: true, ...(extra.secret ? { credentials: { username: "u", password: extra.secret } } : {}) } });
    svc().store.enqueue({ id: taskId, projectId, jobId, adapterId: "playwright", payloadEnc: svc().encrypt(offer), files: [] });
    return taskId;
}
const options = (startedBy?: JobOptions["startedBy"]) => ({ maxPages: 1, maxDepth: 1, maxScenarios: 1, targets: ["web"], allowMutatingApiTests: false, mode: "validate", testIds: [], ...(startedBy ? { startedBy } : {}) }) as JobOptions;
const gate = (owner: string) => svc().assertJobAllowed(projectId, options({ kind: "user", id: owner }));
const refusal = (fn: () => void): { status?: number; message: string; code?: string } => {
    try {
        fn();
        return { message: "" };
    } catch (e) {
        return { status: (e as { status?: number }).status, message: (e as Error).message, code: ((e as { details?: { code?: string } }).details ?? {}).code };
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
    for (const who of ["t-tess", "t-tom", "t-vic", "t-ada"]) {
        ids[who] = (await as(who, "GET", "/api/auth/state")).body.me.id as string;
        if (who !== "t-ada") accessControlOf(app).projects.store.addMember(projectId, ids[who]!, { role: "owner", projectAdmin: false, source: "added", addedBy: "test" });
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

describe("one runner per person", () => {
    let tess: Awaited<ReturnType<typeof setUp>>;
    let tom: Awaited<ReturnType<typeof setUp>>;

    it("not set up: GET /api/me/runner says so, and a run is refused with the typed code that links to Settings", async () => {
        expect((await as("t-tess", "GET", "/api/me/runner")).body).toEqual({ runner: null, canSeeEveryone: false });
        expect((await as("t-ada", "GET", "/api/me/runner")).body).toMatchObject({ canSeeEveryone: true });
        expect(refusal(() => gate(ids["t-tess"]!))).toMatchObject({ status: 409, message: RUNNER_NOT_SET_UP, code: "RUNNER_NOT_SET_UP" });
        // Someone with no runner has nothing to change; the shared key has none.
        expect((await as("t-vic", "PATCH", "/api/me/runner", { name: "x" })).status).toBe(404);
        expect((await asKey("GET", "/api/me/runner")).body).toEqual({ runner: null, canSeeEveryone: false });
        expect((await asKey("POST", "/api/me/runner/retire")).status).toBe(403);
    });

    it("set up: connected, with the contract's fields, the switches at their defaults, and the enrollment says connected", async () => {
        tess = await setUp("t-tess");
        tom = await setUp("t-tom");
        const r = (await as("t-tess", "GET", "/api/me/runner")).body.runner;
        expect(r).toMatchObject({ id: tess.runnerId, status: "online", os: "linux", arch: "x64", switches: { codeScripts: true, privateTargets: false, realPhone: false } });
        expect(typeof r.lastSeenAt).toBe("string");
        expect((await as("t-tess", "GET", `/api/me/runner/enrollments/${tess.enrollmentId}`)).body).toEqual({ status: "connected" });
        // Another person's code is "not found".
        expect((await as("t-tom", "GET", `/api/me/runner/enrollments/${tess.enrollmentId}`)).status).toBe(404);
        const waiting = svc().store.createPersonalEnrollment({ ownerId: ids["t-tess"]!, createdBy: "t-tess" });
        expect((await as("t-tess", "GET", `/api/me/runner/enrollments/${waiting.record.id}`)).body).toEqual({ status: "waiting" });
        const h = await tess.agent!.hello({ machineId: tess.machineId });
        // The wire format is kept: hello's projectId string and runner.kind "personal".
        expect(h.json).toMatchObject({ projectId: "shared", runner: { kind: "personal", customScripts: true, privateTargets: false } });
        expect(refusal(() => gate(ids["t-tess"]!)).message).toBe("");
    });

    it("takes only its owner's runs; the claim itself refuses a colleague's task; a task's secrets reach only its owner's runner", async () => {
        const mine = queue(ids["t-tess"]!, { secret: "TESS-SECRET-81f2" });
        const theirs = queue(ids["t-tom"]!, { secret: "TOM-SECRET-29c4" });
        const offered = await tess.agent!.poll(1);
        expect(offered.offer?.taskId).toBe(mine);
        expect(JSON.stringify(offered.offer)).not.toContain("TOM-SECRET-29c4");
        expect((await tess.agent!.poll(1)).offer).toBeUndefined();
        expect(svc().store.claimFor(theirs, { id: tess.agent!.agentId, tokenId: tess.runnerId }, 60_000)).toBeUndefined();
        expect((await tom.agent!.poll(1)).offer?.taskId).toBe(theirs);
        for (const [a, t] of [[tess, mine], [tom, theirs]] as const) await a.agent!.result(t, { ok: true, runs: [] });
        // A project shows the caller's own computer only.
        const seen = (await as("t-tom", "GET", `/api/projects/${projectId}/agents`)).body.map((a: { tokenId: string }) => a.tokenId);
        expect(seen).toEqual([tom.runnerId]);
        expect((await asKey("GET", `/api/projects/${projectId}/agents`)).body).toEqual([]);
    });

    it("the owner's switches: code scripts and private addresses follow them, and only the owner changes them", async () => {
        expect((await as("t-tess", "PATCH", "/api/me/runner", { switches: { codeScripts: false } })).body.runner.switches.codeScripts).toBe(false);
        const t = queue(ids["t-tess"]!, { custom: true });
        expect((await tess.agent!.poll(1)).offer).toBeUndefined();
        expect((await as("t-tess", "PATCH", "/api/me/runner", { switches: { codeScripts: true } })).status).toBe(200);
        expect((await tess.agent!.poll(1)).offer?.taskId).toBe(t);
        await tess.agent!.result(t, { ok: true, runs: [] });
        const local = queue(ids["t-tess"]!, { baseUrl: "http://localhost:3000" });
        expect((await tess.agent!.poll(1)).offer).toBeUndefined();
        expect((await as("t-tess", "PATCH", "/api/me/runner", { switches: { privateTargets: true }, name: "Tess laptop" })).body.runner).toMatchObject({ name: "Tess laptop", switches: { privateTargets: true } });
        expect((await tess.agent!.hello({ machineId: tess.machineId })).json.runner.privateTargets).toBe(true);
        expect((await tess.agent!.poll(1)).offer?.taskId).toBe(local);
        await tess.agent!.result(local, { ok: true, runs: [] });
        expect((await as("t-tess", "PATCH", "/api/me/runner", { switches: { privateTargets: false } })).status).toBe(200);
        expect((await as("t-tess", "PATCH", "/api/me/runner", { switches: { nonsense: true } })).status).toBe(400);
    });

    it("offline: a person's run is refused up front; a schedule's waits for the computer", async () => {
        platform.db.run("UPDATE agents SET last_seen_ms = ? WHERE token_id = ?", Date.now() - 10 * 60_000, tess.runnerId);
        expect((await as("t-tess", "GET", "/api/me/runner")).body.runner.status).toBe("offline");
        expect(refusal(() => gate(ids["t-tess"]!))).toMatchObject({ status: 409, message: RUNNER_OFFLINE, code: "RUNNER_OFFLINE" });
        // As the scheduler fires it (the "Schedule" actor); Run now is a person acting, and is told now like any run of theirs.
        const fired = runAs({ kind: "schedule", name: "Schedule", role: "editor" }, () => refusal(() => svc().assertJobAllowed(projectId, options({ kind: "schedule", id: "s1", ownerId: ids["t-tess"]! }))));
        expect(fired.message).toBe("");
        const clicked = runAs({ kind: "user", id: ids["t-tess"]!, name: "Tess", role: "editor" }, () => refusal(() => svc().assertJobAllowed(projectId, options({ kind: "schedule", id: "s1", ownerId: ids["t-tess"]! }))));
        expect(clicked).toMatchObject({ code: "RUNNER_OFFLINE" });
        await tess.agent!.hello({ machineId: tess.machineId });
    });

    it("nobody's run is refused with a sentence: the shared key, a schedule or a deploy trigger with no recorded owner", async () => {
        const viaKey = runAs({ kind: "key", name: "Access key", role: "owner" }, () => refusal(() => svc().assertJobAllowed(projectId, options())));
        expect(viaKey).toMatchObject({ status: 409, message: KEY_HAS_NO_RUNNER, code: "RUNNER_NOT_SET_UP" });
        expect(refusal(() => svc().assertJobAllowed(projectId, options({ kind: "schedule", id: "s0", ownerId: null }))).message).toBe("This schedule has no owner. Open it and save it again to run it on your computer.");
        expect(refusal(() => svc().assertJobAllowed(projectId, options({ kind: "trigger", id: "t0", ownerId: null }))).message).toContain("This deploy trigger has no owner");
        expect(refusal(() => svc().assertJobAllowed(projectId, options({ kind: "trigger", id: "t1", ownerId: ids["t-tom"]! }))).message).toBe("");
    });

    it("setting up a computer again retires the one before (one runner per person), and the old one is refused at hello", async () => {
        const again = await setUp("t-tess");
        expect(svc().store.getToken(tess.runnerId)!.revokedAt).not.toBeNull();
        expect((await tess.agent!.hello({ machineId: tess.machineId })).status).toBe(404);
        expect((await as("t-tess", "GET", "/api/me/runner")).body.runner.id).toBe(again.runnerId);
        expect((await as("t-tess", "GET", `/api/me/runner/enrollments/${tess.enrollmentId}`)).body).toEqual({ status: "used" });
        tess = again;
    });

    it("admins see everyone's runners and may remove one; nobody else may", async () => {
        expect((await as("t-tom", "GET", "/api/admin/runners")).status).toBe(403);
        const list = (await as("t-ada", "GET", "/api/admin/runners")).body.runners as Array<{ id: string; ownerName: string; status: string }>;
        expect(list.map((r) => r.id).sort()).toEqual([tess.runnerId, tom.runnerId].sort());
        expect(list.find((r) => r.id === tom.runnerId)).toMatchObject({ status: "online" });
        expect((await as("t-tom", "POST", `/api/admin/runners/${tess.runnerId}/retire`)).status).toBe(403);
        expect((await as("t-ada", "POST", `/api/admin/runners/${tom.runnerId}/retire`)).status).toBe(200);
        expect((await tom.agent!.hello({ machineId: tom.machineId })).status).toBe(404);
        expect((await as("t-tom", "GET", "/api/me/runner")).body).toMatchObject({ runner: null });
    });

    it("Remove this computer: the credential stops working at once", async () => {
        expect((await as("t-tess", "POST", "/api/me/runner/retire")).body).toEqual({ runner: null });
        expect((await tess.agent!.hello({ machineId: tess.machineId })).status).toBe(404);
        expect((await as("t-tess", "GET", "/api/me/runner")).body).toMatchObject({ runner: null });
        expect((await as("t-tess", "POST", "/api/me/runner/retire")).status).toBe(404);
    });

    it("a person who lost the right to run tests can still remove their own computer", async () => {
        // Vic may not run tests (so the download refuses him), but a computer of his set up before is still his to remove.
        const vic = await setUp("t-vic", false);
        expect((await as("t-vic", "GET", "/api/me/runner")).body.runner.id).toBe(vic.runnerId);
        expect((await as("t-vic", "POST", "/api/me/runner/retire")).status).toBe(200);
        expect(svc().store.getToken(vic.runnerId)!.revokedAt).not.toBeNull();
    });

    it("a team or project credential installed before is refused at hello with a 401 and the sentence; a team code cannot be traded", async () => {
        const secret = newAgentToken();
        platform.db.run("INSERT INTO agent_tokens (id, project_id, organization_id, label, token_hash, hint, created_at, kind) VALUES (?,?,?,?,?,?,?,?)", randomUUID(), projectId, null, "Lab PC", hashToken(secret), secret.slice(-4), new Date().toISOString(), "team");
        const team = new FakeAgent(viaFetch(BASE), secret, { name: "lab-pc" });
        const h = await team.hello();
        expect(h.status).toBe(401);
        expect(h.text).toContain(TEAM_RUNNER_REFUSED);
        expect((await team.poll(1)).status).toBe(401);
        const code = `aite_${"x".repeat(43)}`;
        platform.db.run("INSERT INTO runner_enrollments (id, code_hash, hint, kind, created_at, expires_ms) VALUES (?,?,?,?,?,?)", randomUUID(), hashToken(code), "xxxx", "team", new Date().toISOString(), Date.now() + 60_000);
        const res = await fetch(`${BASE}/api/agent/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "lab-pc", machineId: randomUUID() }) });
        expect(res.status).toBe(410);
        expect(await res.text()).toContain(TEAM_RUNNER_REFUSED);
    });

    it("the removed routes are gone", async () => {
        for (const [m, u] of [["GET", "/api/runners"], ["POST", "/api/runners/enroll"], ["GET", `/api/projects/${projectId}/agent-tokens`], ["GET", `/api/projects/${projectId}/runner-access`], ["GET", `/api/projects/${projectId}/runner-choices`]] as const) {
            expect((await asKey(m, u)).status, `${m} ${u}`).toBe(404);
        }
    });
});
