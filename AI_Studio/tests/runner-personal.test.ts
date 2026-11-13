/**
 * Round 45: one runner per person, set up in Settings and used for every run they start, against real HTTP (stand-in Crowd4Test sign-in
 * on 8760, the platform on 8761). Covers GET/PATCH /api/me/runner, the enrollment status, setting up a computer again retiring the one
 * before, "Remove this computer", the admins' list, routing by owner only (the claim itself refuses a colleague's task), the owner's three
 * switches, the up-front refusals (not set up, offline, the shared key), and a team or project credential refused at hello with a 401 and
 * the sentence that sends its person to Settings.
 */
import { exploreNeedsUpdate } from "../src/platform/explore-task.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskOffer } from "../src/agent-protocol/schema.js";
import { loadConfig } from "../src/config.js";
import { getAgentServices, KEY_HAS_NO_RUNNER, noRunnerWaitMs, RUNNER_NOT_SET_UP, RUNNER_OFFLINE, RUNNER_TOKEN_GONE } from "../src/platform/agent-services.js";
import { hashToken, newAgentToken, QUEUE_MAX_MS } from "../src/platform/agent-store.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { runAs } from "../src/platform/auth/actor.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import type { JobOptions } from "../src/platform/repo.js";
import { getScheduleServices } from "../src/platform/schedule-services.js";
import { farmStoreFor } from "../src/platform/device-farm-run.js";
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
    svc().store.setRunner(projectId, { runOn: "agent" });
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
        expect((await as("t-tess", "GET", "/api/me/runner")).body).toEqual({ runner: null });
        expect((await as("t-ada", "GET", "/api/me/runner")).body).toEqual({ runner: null });
        expect(refusal(() => gate(ids["t-tess"]!))).toMatchObject({ status: 409, message: RUNNER_NOT_SET_UP, code: "RUNNER_NOT_SET_UP" });
        // Someone with no runner has nothing to change; the shared key has none.
        expect((await as("t-vic", "PATCH", "/api/me/runner", { name: "x" })).status).toBe(404);
        expect((await asKey("GET", "/api/me/runner")).body).toEqual({ runner: null });
        expect((await asKey("POST", "/api/me/runner/retire")).status).toBe(403);
    });

    it("set up: connected, with the contract's fields, the switches at their defaults, and the enrollment says connected", async () => {
        tess = await setUp("t-tess");
        tom = await setUp("t-tom");
        const r = (await as("t-tess", "GET", "/api/me/runner")).body.runner;
        expect(r).toMatchObject({ id: tess.runnerId, status: "online", os: "linux", arch: "x64", switches: { codeScripts: true, privateTargets: false, realPhone: false, showBrowser: false } });
        expect(typeof r.lastSeenAt).toBe("string");
        // `can`: what it can start now, in the words the server's up-front refusals use.
        const name = r.hostname as string;
        expect(r.can).toEqual({
            web: { ok: true },
            phone: { ok: false, why: "Your runner cannot run phone tests: it has no Android tools (adb) installed." },
            ios: { ok: false, why: expect.stringMatching(new RegExp(`^iOS tests need a runner on a Mac with Xcode\\. Your runner “${name}” can't run them: `)) },
            windows: { ok: false, why: "Your runner cannot run desktop tests: it is not a Windows computer." },
            record: { ok: false, why: expect.stringMatching(new RegExp(`^${name} can't record: `)) },
            recordHeaded: { ok: false, why: expect.stringMatching(new RegExp(`^${name} can't record: `)) },
            phoneSession: { ok: false, why: expect.stringMatching(new RegExp(`^${name} can't be used to explore a phone: `)) },
            // Round 51: this stand-in runner does not report `explore`, as a runner from before it.
            explore: { ok: false, why: exploreNeedsUpdate(name) },
            // Round 52: nor the newer modes.
            plain: { ok: false, why: `Your runner “${name}” is too old to build a test from your description. Update your runner in Settings, Your runner, then try again.` },
            agent: { ok: false, why: `Your runner “${name}” is too old to do an agent run. Update your runner in Settings, Your runner, then try again.` },
            phoneExplore: { ok: false, why: `Your runner “${name}” is too old to explore a phone app. Update your runner in Settings, Your runner, then try again.` },
            assessment: { ok: false, why: `Your runner “${name}” is too old to run a security assessment. Update your runner in Settings, Your runner, then try again.` },
        });
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

    it("Show the browser while exploring: off by default, only the owner changes it, it is kept and noted, and a run's offer is unchanged", async () => {
        const turned = await as("t-tess", "PATCH", "/api/me/runner", { switches: { showBrowser: true } });
        expect(turned.status, JSON.stringify(turned.body)).toBe(200);
        expect(turned.body.runner.switches).toMatchObject({ showBrowser: true, codeScripts: true });
        expect(svc().store.getToken(tess.runnerId)!.showBrowser).toBe(true);
        expect((await as("t-tess", "GET", "/api/me/runner")).body.runner.switches.showBrowser).toBe(true);
        expect((await as("t-tom", "GET", "/api/me/runner")).body.runner.switches.showBrowser).toBe(false);
        expect(accessControlOf(app).users.activity({ action: "runner-switches-changed", limit: 5 }).map((r) => r.detail)).toContain("Their runner: the browser is shown while exploring.");
        const t = queue(ids["t-tess"]!);
        const offer = (await tess.agent!.poll(1)).offer;
        expect(offer?.taskId).toBe(t);
        expect(offer?.explore).toBeUndefined();
        await tess.agent!.result(t, { ok: true, runs: [] });
        expect((await as("t-tess", "PATCH", "/api/me/runner", { switches: { showBrowser: false } })).body.runner.switches.showBrowser).toBe(false);
        expect((await as("t-tess", "PATCH", "/api/me/runner", { switches: { showBrowser: "yes" } })).status).toBe(400);
    });

    it("a run done by the person's runner names it exactly as Settings does", async () => {
        // Renamed in Settings: the run says that name, not the computer's own.
        expect((await as("t-tom", "PATCH", "/api/me/runner", { name: "Tom's laptop" })).body.runner.name).toBe("Tom's laptop");
        const job = await platform.repo.createJob(projectId, appId, { ...options({ kind: "user", id: ids["t-tom"]! }) });
        const running = svc()
            .executorFor({ projectId, jobId: job.id })
            .execute("playwright-api", { scratchDir: path.join(tmp, "scratch"), scripts: [{ testId: "API-001", filename: "API-001.spec.ts", content: "// script" }] }, { run: { baseUrl: "https://app.example", headless: true } }, { workers: 1 });
        const offer = await tom.agent!.next(10_000);
        expect(offer?.jobId).toBe(job.id);
        await tom.agent!.answer(offer!, { runs: [{ testId: "API-001", status: "passed", durationMs: 5, failedStepIndex: -1, steps: [], artifacts: [], responses: [] }] });
        await running;
        const settings = (await as("t-tom", "GET", "/api/me/runner")).body.runner;
        const ranOn = svc().ranOn(platform.repo.getJob(job.id)!);
        expect(settings.name).toBe("Tom's laptop");
        expect(ranOn).toMatchObject({ kind: "agent", name: settings.name, runnerId: tom.runnerId });
        expect((await as("t-tom", "GET", `/api/test-generation/${job.id}`)).body.ranOn).toMatchObject({ name: settings.name });
        // After the day's task prune, from what was kept with the job.
        platform.db.run("DELETE FROM agent_tasks WHERE job_id = ?", job.id);
        expect(svc().ranOn(platform.repo.getJob(job.id)!)).toMatchObject({ name: settings.name });
        platform.repo.setJobStatus(job.id, "COMPLETED");
    });

    it("a project on a device farm: Android tests need no adb on the runner (the farm runs them); without the farm they do; still a person's run", async () => {
        const phone = (owner: string | null) => ({ maxPages: 1, maxDepth: 1, maxScenarios: 1, targets: ["mobile"], allowMutatingApiTests: false, ...(owner ? { startedBy: { kind: "user", id: owner } } : {}) }) as JobOptions;
        // Tess's runner reports no Android tools.
        expect(refusal(() => svc().assertJobAllowed(projectId, phone(ids["t-tess"]!)))).toMatchObject({ code: "RUNNER_CANNOT_RUN", message: "Your runner cannot run phone tests: it has no Android tools (adb) installed." });
        expect((await as("t-tess", "GET", `/api/projects/${projectId}/runner`)).body).toMatchObject({ canRunMobile: false });
        const farms = farmStoreFor(platform.repo, platform.config);
        const f = farms.create(projectId, { provider: "browserstack", label: "Team BS", devices: [{ name: "Google Pixel 8", osVersion: "14" }], username: "maya_ab12", accessKey: "bs-key-0123456789" });
        farms.setChoice(projectId, { runOn: "farm", farmId: f.id, parallel: 1, matrix: false });
        try {
            expect(refusal(() => svc().assertJobAllowed(projectId, phone(ids["t-tess"]!))).message).toBe("");
            expect((await as("t-tess", "GET", `/api/projects/${projectId}/runner`)).body).toMatchObject({ canRunMobile: true, phones: { canRun: true, text: "Phone tests run on the project's device farm." } });
            // Still somebody's run, on a runner that is set up: the shared key's run and someone with no runner are refused as before.
            expect(runAs({ kind: "key", name: "Access key", role: "owner" }, () => refusal(() => svc().assertJobAllowed(projectId, phone(null))))).toMatchObject({ message: KEY_HAS_NO_RUNNER });
            expect(refusal(() => svc().assertJobAllowed(projectId, phone(ids["t-vic"]!)))).toMatchObject({ code: "RUNNER_NOT_SET_UP" });
        } finally {
            farms.setChoice(projectId, { runOn: "device", farmId: null, parallel: 1, matrix: false });
            farms.delete(projectId, f.id);
        }
        expect(refusal(() => svc().assertJobAllowed(projectId, phone(ids["t-tess"]!)))).toMatchObject({ code: "RUNNER_CANNOT_RUN" });
    });

    it("dispatch: schedule runs waiting for a sleeping computer hold no place; a person's run on an online runner starts; past the queue limit they fail with the sentence", () => {
        const insert = (startedBy: Record<string, unknown>, createdAt = new Date().toISOString()) => {
            const id = randomUUID();
            platform.db.run("INSERT INTO generation_jobs (id, project_id, application_id, status, options_json, progress_json, counters_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", id, projectId, appId, "QUEUED", JSON.stringify({ ...options(startedBy as JobOptions["startedBy"]), runOn: "agent" }), "{}", "{}", createdAt, createdAt);
            return id;
        };
        const seen = platform.db.get<{ ms: number }>("SELECT last_seen_ms AS ms FROM agents WHERE token_id = ?", tess.runnerId)!.ms;
        platform.db.run("UPDATE agents SET last_seen_ms = ? WHERE token_id = ?", Date.now() - 10 * 60_000, tess.runnerId);
        const made: string[] = [];
        try {
            const old = new Date(Date.now() - 1000).toISOString();
            for (let i = 0; i < 9; i++) made.push(insert({ kind: "schedule", id: `s${i}`, ownerId: ids["t-tess"]! }, old));
            const stale = insert({ kind: "trigger", id: "t1", ownerId: ids["t-tess"]! }, new Date(Date.now() - QUEUE_MAX_MS - 1000).toISOString());
            const person = insert({ kind: "user", id: ids["t-tom"]! });
            // Re-queued after a restart or a lost lease (claimed once, its runner task may still run): skipped, never failed, however old.
            const requeued = insert({ kind: "schedule", id: "s-again", ownerId: ids["t-tess"]! }, new Date(Date.now() - QUEUE_MAX_MS - 1000).toISOString());
            platform.db.run("UPDATE generation_jobs SET attempts = 1 WHERE id = ?", requeued);
            made.push(stale, person, requeued);
            const skip = svc().jobsWaitingForRunner();
            expect(skip.sort()).toEqual([...made.slice(0, 9), requeued].sort());
            expect(platform.repo.getJob(requeued)).toMatchObject({ status: "QUEUED" });
            // The worker claims past them: the person's run starts although nine older schedule runs are queued.
            expect(platform.repo.claimNextJob(60_000, "test-dispatch", ["validate", "variants", "environment"], skip)?.id).toBe(person);
            expect(platform.repo.getJob(stale)).toMatchObject({ status: "FAILED", error: "tess Person's runner was offline or could not run these tests while this deploy trigger waited for it." });
            // Back online: they are claimable again.
            platform.db.run("UPDATE agents SET last_seen_ms = ? WHERE token_id = ?", Date.now(), tess.runnerId);
            expect(svc().jobsWaitingForRunner()).toEqual([]);
            // ...and the re-queued one is the oldest the worker can take now.
            expect(platform.repo.claimNextJob(60_000, "test-dispatch", ["validate", "variants", "environment"], [])?.id).toBe(requeued);
        } finally {
            platform.db.run("UPDATE agents SET last_seen_ms = ? WHERE token_id = ?", seen, tess.runnerId);
            for (const id of made) platform.db.run("DELETE FROM generation_jobs WHERE id = ?", id);
        }
    });

    it("offline: a person's run is refused up front; a schedule's waits for the computer", async () => {
        platform.db.run("UPDATE agents SET last_seen_ms = ? WHERE token_id = ?", Date.now() - 10 * 60_000, tess.runnerId);
        const off = (await as("t-tess", "GET", "/api/me/runner")).body.runner;
        expect(off.status).toBe("offline");
        expect(Object.values(off.can)).toEqual(Array(12).fill({ ok: false, why: RUNNER_OFFLINE }));
        expect(refusal(() => gate(ids["t-tess"]!))).toMatchObject({ status: 409, message: RUNNER_OFFLINE, code: "RUNNER_OFFLINE" });
        // As the scheduler fires it (the "Schedule" actor); Run now is a person acting, and is told now like any run of theirs.
        const fired = runAs({ kind: "schedule", name: "Schedule", role: "editor" }, () => refusal(() => svc().assertJobAllowed(projectId, options({ kind: "schedule", id: "s1", ownerId: ids["t-tess"]! }))));
        expect(fired.message).toBe("");
        const clicked = runAs({ kind: "user", id: ids["t-tess"]!, name: "Tess", role: "editor" }, () => refusal(() => svc().assertJobAllowed(projectId, options({ kind: "schedule", id: "s1", ownerId: ids["t-tess"]! }))));
        expect(clicked).toMatchObject({ code: "RUNNER_OFFLINE" });
        await tess.agent!.hello({ machineId: tess.machineId });
    });

    it("the schedules list names whose runner each schedule runs on, by name and never by email", async () => {
        const store = getScheduleServices(platform).store;
        const made = store.create({ projectId, name: "Nightly", kind: "validate", cadence: { type: "daily", time: "03:00" }, createdBy: ids["t-tess"]! });
        const nobody = store.create({ projectId, name: "Old", kind: "validate", cadence: { type: "daily", time: "04:00" } });
        const listed = (await as("t-tess", "GET", `/api/projects/${projectId}/schedules`)).body.schedules as Array<{ id: string; ownerName?: string }>;
        const name = platform.db.get<{ name: string }>("SELECT name FROM users WHERE id = ?", ids["t-tess"]!)!.name;
        expect(name).not.toContain("@");
        expect(listed.find((x) => x.id === made.id)?.ownerName).toBe(name);
        expect(listed.find((x) => x.id === nobody.id)).not.toHaveProperty("ownerName");
        // A name that is an email is never shown (signing in sets the name again, so this asks the rule directly).
        platform.db.run("UPDATE users SET name = email WHERE id = ?", ids["t-tess"]!);
        expect(svc().personName(ids["t-tess"]!)).toBeUndefined();
        platform.db.run("UPDATE users SET name = ? WHERE id = ?", name, ids["t-tess"]!);
        store.delete(made.id);
        store.delete(nobody.id);
    });

    it("a schedule's or trigger's run waits for its owner's computer to the queue limit; a person's run keeps the short grace; one sentence", () => {
        expect(noRunnerWaitMs("schedule", 90_000)).toBe(QUEUE_MAX_MS);
        expect(noRunnerWaitMs("trigger", 90_000)).toBe(QUEUE_MAX_MS);
        expect(noRunnerWaitMs("user", 90_000)).toBe(90_000);
        expect(noRunnerWaitMs(undefined, 90_000)).toBe(90_000);
        const jobId = randomUUID();
        const t = new Date().toISOString();
        platform.db.run("INSERT INTO generation_jobs (id, project_id, application_id, status, options_json, progress_json, counters_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", jobId, projectId, appId, "VALIDATING", JSON.stringify(options({ kind: "schedule", id: "s1", ownerId: ids["t-tess"]! })), "{}", "{}", t, t);
        expect(svc().noRunnerSentence(jobId)).toMatch(/^tess Person's runner was offline or could not run these tests while this schedule waited for it\.$/);
        platform.db.run("DELETE FROM generation_jobs WHERE id = ?", jobId);
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
        expect(svc().store.getToken(tess.runnerId)).toBeUndefined();
        expect((await tess.agent!.hello({ machineId: tess.machineId })).status).toBe(404);
        expect((await as("t-tess", "GET", "/api/me/runner")).body.runner.id).toBe(again.runnerId);
        expect((await as("t-tess", "GET", `/api/me/runner/enrollments/${tess.enrollmentId}`)).body).toEqual({ status: "used" });
        tess = again;
    });

    it("an admin sees only their own runner: nobody's runner is listed for, or removable by, anyone else", async () => {
        expect((await as("t-ada", "GET", "/api/me/runner")).body).toEqual({ runner: null });
        expect((await as("t-tom", "GET", "/api/me/runner")).body.runner.id).toBe(tom.runnerId);
        expect((await as("t-tess", "GET", "/api/me/runner")).body.runner.id).toBe(tess.runnerId);
        expect((await as("t-ada", "GET", "/api/admin/runners")).status).toBe(404);
        expect((await as("t-ada", "POST", `/api/admin/runners/${tom.runnerId}/retire`, {})).status).toBe(404);
        expect((await tom.agent!.hello({ machineId: tom.machineId })).status).toBe(200);
        expect((await as("t-tom", "POST", "/api/me/runner/retire")).body).toEqual({ runner: null });
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
        expect(svc().store.getToken(vic.runnerId)).toBeUndefined();
    });

    it("a credential from before the update (removed by migration 57) is refused at hello with a 404 and what to do", async () => {
        const old = new FakeAgent(viaFetch(BASE), newAgentToken(), { name: "lab-pc" });
        const h = await old.hello();
        expect(h.status).toBe(404);
        expect(h.text).toContain(RUNNER_TOKEN_GONE);
        expect(h.text).toContain("Download the new runner in Settings, Your runner");
        expect((await old.poll(1)).status).toBe(404);
    });

    it("the removed routes are gone", async () => {
        for (const [m, u] of [["GET", "/api/runners"], ["POST", "/api/runners/enroll"], ["GET", `/api/projects/${projectId}/agent-tokens`], ["GET", `/api/projects/${projectId}/runner-access`], ["GET", `/api/projects/${projectId}/runner-choices`]] as const) {
            expect((await asKey(m, u)).status, `${m} ${u}`).toBe(404);
        }
    });
});
