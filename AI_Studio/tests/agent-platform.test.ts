/**
 * Runner agent, platform side, against a real platform on real HTTP and a FAKE AGENT written in the test (it speaks the protocol with
 * plain fetch and runs nothing: it returns canned results and uploads canned artifact bytes).
 *
 * Covers: tokens (shown once, hashed, revoked = 404), the exact-match API-key exemption with path tricks, the registry, routing and
 * refusals (no agent, missing capability), the task flow (claim, heartbeat, download, upload, result), who may touch a task, caps,
 * cancel, a lost agent, an infrastructure failure, the cleanup ledger the agent reports, private targets for agent runs only, and
 * one validation job end to end through the worker (stored executions, artifacts, evidence, no secrets anywhere).
 *
 * Browser-free (no Playwright is started: the fixture is on a private address, so the platform's own browser is skipped for agent runs).
 * Ports: platform 5850, fixture application 5851.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExecutionBatch, ExecutionEnv } from "../src/engine/frameworks/types.js";
import { loadConfig } from "../src/config.js";
import { getAgentServices, RunnerAgentError } from "../src/platform/agent-services.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS, type JobRow } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { defaultCaps, failedRun, FakeAgent, passedRun, sha256, viaFetch, type Reply } from "./fixtures/fake-agent.js";

const PLATFORM_PORT = 5850;
const APP_PORT = 5851;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;
const API_KEY = "af-admin-key-5c19e7a2";
const PASSWORD = "AFLEAK-Password-71c4a2";
const API_TOKEN = "AFLEAK-ApiToken-b83e19";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_MAX_FILE_BYTES", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS", "BLOCK_PRIVATE_TARGETS", "AGENT_MAX_TOKENS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker | undefined;
let dataDir: string;
let appServer: http.Server;
const appHits: string[] = [];

const admin = async (method: string, url: string, body?: unknown, headers: Record<string, string> = { "x-api-key": API_KEY }) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; text: string; body: any };
};

/** A request with a path exactly as written (fetch would tidy `..` and `//` away). */
const raw = (method: string, rawPath: string, headers: Record<string, string> = {}, body?: Buffer) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port: PLATFORM_PORT, method, path: rawPath, headers }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        });
        // A connection the server drops (a request it will not parse) counts as refused: status 0.
        req.on("error", () => resolve({ status: 0, text: "" }));
        req.end(body);
    });

const newProject = async (name: string) => (await admin("POST", "/api/projects", { name })).body.id as string;
const newToken = async (projectId: string, label?: string) => (await admin("POST", `/api/projects/${projectId}/agent-tokens`, label ? { label } : {})).body.secret as string;
const connect = async (projectId: string, name: string, caps = defaultCaps(), concurrency = 1) => {
    const agent = new FakeAgent(viaFetch(BASE), await newToken(projectId, name), { name, capabilities: caps, concurrency });
    const r = await agent.hello();
    expect(r.status).toBe(200);
    return agent;
};
const svc = () => getAgentServices(platform);
const appOf = (projectId: string) => platform.repo.createApplication(projectId, APP, { ...DEFAULT_JOB_OPTIONS }, undefined);
const jobFor = (projectId: string, testIds: string[] = []): Promise<JobRow> => platform.repo.createJob(projectId, appOf(projectId), { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds });
const endJob = (job: JobRow) => platform.repo.setJobStatus(job.id, "FAILED", "test over");
const script = (testId: string, content = "// script body") => ({ testId, filename: `${testId}.spec.ts`, content });
const runEnv = (over: Partial<ExecutionEnv["run"]> = {}): ExecutionEnv => ({ run: { baseUrl: APP, apiBaseUrl: APP, credentials: { username: "demo", password: PASSWORD }, apiToken: API_TOKEN, headless: true, ...over } });
const batch = (...ids: string[]): ExecutionBatch => ({ scratchDir: path.join(dataDir, "scratch"), scripts: ids.map((i) => script(i)) });
const apiExec = (projectId: string, job: JobRow, b: ExecutionBatch, env = runEnv(), opts: { signal?: AbortSignal; timeoutMs?: number } = {}) => svc().executorFor({ projectId, jobId: job.id }).execute("playwright-api", b, env, { workers: 1, ...opts });
const png = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(n, n)]);
const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e: e as Error }));

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "3", AGENT_MAX_FILE_BYTES: "200000", AGENT_WATCH_MS: "50", AGENT_NO_AGENT_GRACE_SECONDS: "2" });
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    appServer = http.createServer((req, res) => {
        appHits.push(`${req.method} ${req.url}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => appServer.listen(APP_PORT, "127.0.0.1", r));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-agent-"));
    // These tests exercise multi-agent routing and token isolation, which the platform still supports; raise the per-project runner limit
    // (one by default; maxTokensFrom reads process.env) so several runners can be registered for one project here.
    process.env.AGENT_MAX_TOKENS = "25";
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY, LLM_PROVIDER: "anthropic", CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0" }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
}, 60_000);

afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    await new Promise((r) => appServer.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("tokens and who may call the agent routes", () => {
    let projectId: string;
    beforeAll(async () => {
        projectId = await newProject("Tokens");
    });

    it("a token is shown once, listed without its secret or hash, and belongs to its project", async () => {
        const made = await admin("POST", `/api/projects/${projectId}/agent-tokens`, { label: "Maya's laptop" });
        expect(made.status).toBe(201);
        expect(made.body.secret).toMatch(/^aitg_[A-Za-z0-9_-]{43}$/);
        expect(Object.keys(made.body.token).sort()).toEqual(["createdAt", "hint", "id", "label", "lastUsedAt", "revokedAt"]);
        expect(made.body.token).toMatchObject({ label: "Maya's laptop", lastUsedAt: null, revokedAt: null });
        expect(made.body.token.hint).toBe(`aitg_…${made.body.secret.slice(-4)}`);
        const list = await admin("GET", `/api/projects/${projectId}/agent-tokens`);
        expect(list.body).toHaveLength(1);
        expect(list.text).not.toContain(made.body.secret);
        expect(list.text).not.toMatch(/token_hash|tokenHash|[0-9a-f]{64}/);
        // not in the database in clear either
        expect(JSON.stringify(platform.db.all("SELECT * FROM agent_tokens"))).not.toContain(made.body.secret);
        expect((await admin("POST", `/api/projects/${projectId}/agent-tokens`, { label: "x".repeat(61) })).status).toBe(400);
        expect((await admin("GET", "/api/projects/nope/agent-tokens")).status).toBe(404);
    });

    it("the admin routes need the API key; the agent routes need the token and an API key does not stand in for it", async () => {
        expect((await admin("GET", `/api/projects/${projectId}/agent-tokens`, undefined, {})).status).toBe(401);
        expect((await admin("GET", `/api/projects/${projectId}/agents`, undefined, {})).status).toBe(401);
        expect((await admin("GET", `/api/projects/${projectId}/runner`, undefined, { "x-api-key": "wrong" })).status).toBe(401);
        expect((await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "platform" }, {})).status).toBe(401);
        // no token
        const none = await admin("POST", "/api/agent/hello", {}, {});
        expect(none.status).toBe(401);
        // the API key is not a token
        expect((await admin("POST", "/api/agent/hello", {}, { "x-api-key": API_KEY })).status).toBe(401);
        expect((await admin("POST", "/api/agent/poll", {}, { authorization: `Bearer ${API_KEY}` })).status).toBe(401);
        // malformed and unknown tokens
        expect((await admin("POST", "/api/agent/hello", {}, { authorization: "Bearer aitg_short" })).status).toBe(401);
        expect((await admin("POST", "/api/agent/hello", {}, { authorization: `Basic ${"A".repeat(40)}` })).status).toBe(401);
        expect((await admin("POST", "/api/agent/hello", {}, { authorization: `Bearer aitg_${"A".repeat(43)}` })).status).toBe(404);
    });

    it("a revoked token is a 404 at the agent's next request, and revoking is per project", async () => {
        const other = await newProject("Other");
        const made = (await admin("POST", `/api/projects/${projectId}/agent-tokens`, { label: "to revoke" })).body;
        const agent = new FakeAgent(viaFetch(BASE), made.secret, { name: "revoked-one" });
        expect((await agent.hello()).status).toBe(200);
        expect((await admin("DELETE", `/api/projects/${other}/agent-tokens/${made.token.id}`)).status).toBe(404);
        expect((await agent.poll()).status).not.toBe(404);
        expect((await admin("DELETE", `/api/projects/${projectId}/agent-tokens/${made.token.id}`)).body).toEqual({ ok: true });
        expect((await agent.hello()).status).toBe(404);
        expect((await agent.poll()).status).toBe(404);
        expect((await admin("DELETE", `/api/projects/${projectId}/agent-tokens/${made.token.id}`)).status).toBe(404);
        const listed = (await admin("GET", `/api/projects/${projectId}/agent-tokens`)).body.find((t: { id: string }) => t.id === made.token.id);
        expect(listed.revokedAt).toBeTruthy();
        expect(listed.lastUsedAt).toBeTruthy();
    });

    it("path tricks never get past the API key: only the six exact routes skip it", async () => {
        const secret = await newToken(projectId, "tricks");
        const bearer = { authorization: `Bearer ${secret}`, "content-type": "application/json" };
        const id = "0b9e3c2a-1d4f-4a67-9d52-7c1e8a3b5f10";
        const tricks: Array<[string, string]> = [
            ["POST", "/api/agent/hello/"],
            ["POST", "/API/agent/hello"],
            ["POST", "/api/AGENT/hello"],
            ["POST", "/api/agent/Hello"],
            ["POST", "/api/agent/hello%2F"],
            ["POST", "/api/agent/hello%00"],
            ["POST", "/api/agent/%2e%2e/projects"],
            ["POST", "/api/agent/hello/../poll/"],
            ["GET", "/api/agent/hello"],
            ["PUT", "/api/agent/poll"],
            ["POST", `/api/agent/tasks/${id}/heartbeat/`],
            ["POST", `/api/agent/tasks/${id}/Result`],
            ["GET", `/api/agent/tasks/${id}/files/..%2f..%2f..%2fsecret`],
            ["PUT", `/api/agent/tasks/${id}/files/%2e%2e%2fescape.png`],
            ["PUT", `/api/agent/tasks/${id}/files/.hidden`],
            ["PUT", `/api/agent/tasks/${id}/files/a%5Cb.png`],
            ["DELETE", `/api/agent/tasks/${id}/files/a.png`],
            ["POST", "/api/agent"],
            ["POST", "/api/agent/"],
        ];
        for (const [m, p] of tricks) {
            // with the token alone (no API key): the route is not exempt, so the key check refuses it
            const r = await raw(m, p, bearer, Buffer.from("{}"));
            // A path that is not /api/... at all (a different case) is the web app's page, never an agent answer.
            const isPage = r.status === 200 && r.text.startsWith("<!doctype html>");
            expect(isPage || [0, 400, 401, 404].includes(r.status), `${m} ${p} -> ${r.status} ${r.text.slice(0, 80)}`).toBe(true);
            expect(r.text.includes("agentId"), `${m} ${p}`).toBe(false);
        }
        // the decoded form of an exact route is the route (the router decodes the same way)
        const encoded = await raw("POST", "/api/agent/%68ello", bearer, Buffer.from(JSON.stringify({ protocol: 1, name: "enc", version: "1", capabilities: defaultCaps(), concurrency: 1 })));
        expect([200, 404]).toContain(encoded.status);
        // double slashes are not served at all
        const doubled = await raw("POST", "//api/agent/hello", bearer, Buffer.from("{}"));
        expect(doubled.text.includes("agentId")).toBe(false);
        expect((await raw("POST", "/api//agent/hello", bearer, Buffer.from("{}"))).status).toBe(401);
    });

    it("hello answers with the protocol's shape; wrong protocol is a plain 409; bad bodies are a plain 400", async () => {
        const secret = await newToken(projectId, "hello");
        const a = new FakeAgent(viaFetch(BASE), secret, { name: "shape" });
        const r = await a.hello();
        expect(r.status).toBe(200);
        expect(r.json).toMatchObject({ projectId, protocol: 1, pollSeconds: 1, heartbeatSeconds: 10, maxFileBytes: 200000 });
        // Round 39 adds `runner` (what it is and what its switches allow; an older agent ignores it).
        expect(Object.keys(r.json).sort()).toEqual(["agentId", "heartbeatSeconds", "maxFileBytes", "pollSeconds", "projectId", "protocol", "runner", "serverTime"]);
        // Protocol 2 is spoken too (runner-protocol-2.md); a version neither side knows is a plain 409.
        const wrong = await a.hello({ protocol: 9 });
        expect(wrong.status).toBe(409);
        expect(wrong.json.error).toMatch(/protocol 9.*protocol 2.*Update the agent/);
        const bad = await a.hello({ concurrency: 99 });
        expect(bad.status).toBe(400);
        expect(bad.json.error).toMatch(/not in the expected format/);
        // a second machine on the same token is refused while the first is online
        const twin = new FakeAgent(viaFetch(BASE), secret, { name: "twin" });
        const refused = await twin.hello();
        expect(refused.status).toBe(409);
        expect(refused.json.error).toMatch(/already used by the agent “shape”/);
    });

    it("hello is limited to 6 a minute per token", async () => {
        const a = new FakeAgent(viaFetch(BASE), await newToken(projectId, "limited"), { name: "limited" });
        const answers: number[] = [];
        for (let i = 0; i < 8; i++) answers.push((await a.hello()).status);
        expect(answers.slice(0, 6).every((s) => s === 200)).toBe(true);
        expect(answers.slice(6)).toEqual([429, 429]);
    });
});

describe("the registry and where a project's tests run", () => {
    it("lists agents with their capabilities, online first, and never any token", async () => {
        const projectId = await newProject("Registry");
        const phone = { android: { adb: true, devices: [{ serial: "R58M", model: "Pixel 7", state: "device", emulator: false }], avds: ["Pixel_7"] } };
        const a = await connect(projectId, "maya-laptop", defaultCaps({ browsers: ["chromium", "firefox"], ...phone, ios: { xcode: false, simulators: [] } }), 2);
        const list = await admin("GET", `/api/projects/${projectId}/agents`);
        expect(list.status).toBe(200);
        expect(list.body).toHaveLength(1);
        const [row] = list.body;
        expect(Object.keys(row).sort()).toEqual(["activeTasks", "arch", "capabilities", "concurrency", "firstSeenAt", "id", "lastSeenAt", "name", "node", "online", "os", "tokenId", "version"]);
        expect(row).toMatchObject({ id: a.agentId, name: "maya-laptop", version: "0.0.0-test", os: "linux", arch: "x64", node: "v24.0.0", online: true, activeTasks: 0, concurrency: 2 });
        expect(Date.parse(row.lastSeenAt)).not.toBeNaN();
        expect(row.capabilities).toEqual({ browsers: ["chromium", "firefox"], android: { adb: true, devices: [{ serial: "R58M", model: "Pixel 7", state: "device", emulator: false }], avds: ["Pixel_7"], state: "phone", summary: "Android: 1 device" }, ios: { xcode: false, simulators: [] } });
        expect(list.text).not.toMatch(/aitg_[A-Za-z0-9_-]{20}/);
        // another project sees none of it
        const empty = await newProject("Empty");
        expect((await admin("GET", `/api/projects/${empty}/agents`)).body).toEqual([]);
    });

    it("the setting defaults to the platform; choosing an agent needs one online, none running jobs, and one of this project", async () => {
        const projectId = await newProject("Runner");
        const first = await admin("GET", `/api/projects/${projectId}/runner`);
        expect(first.body).toMatchObject({ runOn: "platform", agentId: null, status: "Runs on this platform.", canRunWeb: true });
        expect(Object.keys(first.body).sort()).toEqual(["agentId", "allowPersonal", "canRunIos", "canRunMobile", "canRunWeb", "canRunWindows", "phones", "runOn", "status", "unavailableReason"]);
        const refused = await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent" });
        expect(refused.status).toBe(409);
        expect(refused.body.error).toMatch(/No runner agent is online/);
        const agent = await connect(projectId, "maya-laptop");
        const set = await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent" });
        expect(set.status).toBe(200);
        expect(set.body).toMatchObject({ runOn: "agent", agentId: null, status: "Runs on any connected agent (1 online).", canRunWeb: true, canRunMobile: false });
        expect(set.body.unavailableReason).toMatch(/Mobile tests can't run: it has no Android tools/);
        expect((await admin("GET", `/api/projects/${projectId}/runner`)).body).toEqual(set.body);
        // a specific agent
        const named = await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent", agentId: agent.agentId });
        expect(named.body).toMatchObject({ agentId: agent.agentId, status: "Runs on maya-laptop (online)." });
        // an agent of another project cannot be chosen
        const elsewhere = await newProject("Elsewhere");
        const stranger = await connect(elsewhere, "stranger");
        expect((await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent", agentId: stranger.agentId })).status).toBe(404);
        expect((await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent", agentId: "nope" })).status).toBe(404);
        expect((await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "elsewhere" })).status).toBe(400);
        // not while a job is running
        const job = await jobFor(projectId);
        const busy = await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "platform" });
        expect(busy.status).toBe(409);
        endJob(job);
        expect((await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "platform" })).body).toMatchObject({ runOn: "platform", agentId: null });
    });

    it("/api/config names the protocol version", async () => {
        expect((await admin("GET", "/api/config")).body.agentProtocol).toBe(2);
    });
});

describe("routing a run and refusing it", () => {
    it("with no agent online, starting a run is a plain 409 for every way a job is made", async () => {
        const projectId = await newProject("NoAgent");
        const imp = await admin("POST", `/api/projects/${projectId}/specs`, { baseUrl: APP, validate: false, specs: [{ title: "Health answers", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/health" }, { action: "assertResponse", check: "status", expected: 200 }] }] });
        expect(imp.status).toBe(202);
        const testId = imp.body.tests[0].id as string;
        // forced: the setting says agent, nobody is connected (agents that were seen long ago are offline)
        svc().store.setRunner(projectId, { runOn: "agent", agentId: null });
        const message = "No runner agent is connected for this project. Start one, or switch the project back to running here.";
        const one = await admin("POST", `/api/tests/${testId}/validate`);
        expect(one.status).toBe(409);
        expect(one.body.error).toBe(message);
        // an import that starts a run, a re-run, a trigger: all go through job creation
        expect((await admin("POST", `/api/projects/${projectId}/specs`, { baseUrl: APP, specs: [{ title: "Another", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/x" }] }] })).body.error).toBe(message);
        const trig = (await admin("POST", `/api/projects/${projectId}/triggers`, { label: "ci" })).body;
        const run = await admin("POST", `/api/triggers/${trig.token}/run`, {}, {});
        expect(run.status).toBe(409);
        expect(run.body.error).toBe(message);
        await expect(platform.repo.createJob(projectId, appOf(projectId), { ...DEFAULT_JOB_OPTIONS, mode: "generate" })).rejects.toThrow(message);
        // nothing was queued
        expect((await admin("GET", `/api/projects/${projectId}/jobs`)).body.filter((j: { status: string }) => j.status === "QUEUED")).toEqual([]);
        // back on the platform: the setting is honoured again
        svc().store.setRunner(projectId, { runOn: "platform", agentId: null });
        endJob(await platform.repo.createJob(projectId, appOf(projectId), { ...DEFAULT_JOB_OPTIONS, mode: "generate" }));
    });

    it("an agent that lacks what the tests need is named in the refusal", async () => {
        const projectId = await newProject("Capabilities");
        await connect(projectId, "no-browsers", defaultCaps({ browsers: [] }));
        const imp = await admin("POST", `/api/projects/${projectId}/specs`, { baseUrl: APP, validate: false, specs: [{ title: "Health answers", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/health" }, { action: "assertResponse", check: "status", expected: 200 }] }] });
        const apiTest = imp.body.tests[0].id as string;
        expect((await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent" })).status).toBe(200);
        const web = await admin("POST", `/api/tests/${apiTest}/validate`);
        expect(web.status).toBe(409);
        expect(web.body.error).toBe("The connected runner agent “no-browsers” can't run API tests: it has no browsers installed (run `npx playwright install` on that machine).");
        const status = (await admin("GET", `/api/projects/${projectId}/runner`)).body;
        expect(status).toMatchObject({ canRunWeb: false, canRunMobile: false });
        expect(status.unavailableReason).toMatch(/Web and API tests can't run: it has no browsers installed/);
        // a mobile test needs an Android phone or emulator on the agent
        expect((await admin("PUT", `/api/projects/${projectId}/mobile-app`, { appPackage: "com.example.shop" })).status).toBe(200);
        svc().store.setRunner(projectId, { runOn: "platform", agentId: null });
        const mob = await admin("POST", `/api/projects/${projectId}/specs`, { validate: false, mobile: { appPackage: "com.example.shop" }, specs: [{ title: "Shop opens", kind: "mobile", category: "Mobile", steps: [{ action: "assert", check: "visible", locator: { by: "text", value: "Shop" } }] }] });
        expect(mob.status).toBe(202);
        await connect(projectId, "with-browser", defaultCaps());
        svc().store.setRunner(projectId, { runOn: "agent", agentId: null });
        const m = await admin("POST", `/api/tests/${mob.body.tests[0].id}/validate`);
        expect(m.status).toBe(409);
        expect(m.body.error).toMatch(/run mobile tests: it has no Android tools/);
        // with a phone attached to one of them it is accepted
        const phone = await connect(projectId, "with-phone", defaultCaps({ android: { adb: true, devices: [{ serial: "R58M", state: "device", emulator: false }], avds: [] } }));
        const ok = await admin("POST", `/api/tests/${mob.body.tests[0].id}/validate`);
        expect(ok.status).toBe(202);
        await platform.repo.requestCancel(ok.body.jobId);
        void phone;
    });
});

describe("a task, from claim to result", () => {
    let projectId: string;
    let agent: FakeAgent;
    beforeAll(async () => {
        projectId = await newProject("Tasks");
        agent = await connect(projectId, "worker-1");
        svc().store.setRunner(projectId, { runOn: "agent", agentId: null });
    });

    it("the agent gets the scripts, the credentials, baselines and cleanup on the agent; uploads come back as local files; the run looks like a local one", async () => {
        const job = await jobFor(projectId);
        const baseline = path.join(dataDir, "home-baseline.png");
        fs.writeFileSync(baseline, png(40));
        const b = batch("API-001", "API-002");
        b.scripts[0]!.baselines = [{ name: "home.png", path: baseline }];
        const pending = settle(apiExec(projectId, job, b, runEnv({ cleanup: "platform", roles: [{ name: "admin", username: "a", password: "AFLEAK-RolePw-1d2c3b", apiToken: "AFLEAK-RoleTok-9a8b7c" }] })));
        const offer = (await agent.next())!;
        expect(offer).toBeTruthy();
        // the offer
        expect(offer).toMatchObject({ jobId: job.id, adapterId: "playwright-api", leaseSeconds: 3, workers: 1 });
        expect(offer.scripts.map((s) => [s.testId, s.filename, s.content])).toEqual([["API-001", "API-001.spec.ts", "// script body"], ["API-002", "API-002.spec.ts", "// script body"]]);
        expect(offer.env).toMatchObject({ baseUrl: APP, apiBaseUrl: APP, apiToken: API_TOKEN, credentials: { username: "demo", password: PASSWORD }, cleanup: "agent", headless: true });
        expect(offer.env.roles).toEqual([{ name: "admin", username: "a", password: "AFLEAK-RolePw-1d2c3b", apiToken: "AFLEAK-RoleTok-9a8b7c" }]);
        const ref = offer.scripts[0]!.baselines![0]!;
        expect(ref).toMatchObject({ name: "home.png", file: { size: png(40).length, sha256: sha256(png(40)) } });
        // the baseline is a file the agent downloads, byte for byte
        const dl = await agent.download(offer.taskId, ref.file.ref);
        expect(dl.status).toBe(200);
        expect(dl.bytes.equals(png(40))).toBe(true);
        expect(dl.headers["x-content-sha256"]).toBe(ref.file.sha256);
        // heartbeat
        expect((await agent.heartbeat(offer.taskId, { done: 1, total: 2, log: ["warming up"] })).json).toEqual({ cancel: false, leaseSeconds: 3 });
        // artifacts, hashed here
        const shot = png(300);
        const up = await agent.upload(offer.taskId, "API-002-failure.png", shot, { "x-content-sha256": sha256(shot) });
        expect(up.json).toEqual({ ref: "API-002-failure.png", size: shot.length, sha256: sha256(shot) });
        const created = [
            { testId: "API-001", method: "POST", path: "/things", id: "41", deletePath: "/things/41", status: "removed", createdAt: new Date().toISOString() },
            { path: "/things", id: "42", status: "failed", reason: `The application refused ${PASSWORD}` },
        ];
        const res = await agent.result(offer.taskId, {
            ok: true,
            runs: [
                passedRun("API-001", { created: created as never }),
                failedRun("API-002", `Login failed for demo with ${PASSWORD} and ${API_TOKEN}`, { artifacts: [{ kind: "screenshot", ref: "API-002-failure.png" }, { kind: "trace", ref: "never-uploaded.zip" }], responses: [{ method: "GET", path: "/health", status: 500, obs: { echoed: PASSWORD } }], notes: [`note ${API_TOKEN}`] }),
            ],
        });
        expect(res.json).toEqual({ ok: true });
        const out = await pending;
        if (!out.ok) throw out.e;
        const [r1, r2] = out.v;
        expect(r1).toMatchObject({ testId: "API-001", status: "passed", failedStepIndex: -1 });
        expect(r2).toMatchObject({ testId: "API-002", status: "failed", failedStepIndex: 0 });
        // credentials are hidden in everything the agent sent back
        const all = JSON.stringify(out.v);
        for (const secret of [PASSWORD, API_TOKEN]) expect(all).not.toContain(secret);
        expect(r2!.error).toBe("Login failed for demo with [hidden] and [hidden]");
        expect(r2!.responses[0]!.obs).toEqual({ echoed: "[hidden]" });
        // the uploaded file is a local file with the bytes the agent sent; the one never uploaded is simply absent
        expect(r2!.artifacts).toHaveLength(1);
        expect(r2!.artifacts[0]!.kind).toBe("screenshot");
        expect(fs.readFileSync(r2!.artifacts[0]!.path).equals(shot)).toBe(true);
        expect(path.resolve(r2!.artifacts[0]!.path).startsWith(path.resolve(platform.config.artifactsDir, projectId, "_agent"))).toBe(true);
        // the platform removed nothing itself: the agent's ledger (not the raw lines) is what was stored
        const ledger = (await admin("GET", `/api/projects/${projectId}/cleanup`)).body;
        expect(ledger.latest?.items ?? ledger.items ?? []).toHaveLength(2);
        const rows = platform.db.all<{ record_id: string; status: string; reason: string | null }>("SELECT record_id, status, reason FROM cleanup_ledger WHERE job_id = ? ORDER BY seq", job.id);
        expect(rows.map((r) => [r.record_id, r.status])).toEqual([["41", "removed"], ["42", "failed"]]);
        expect(rows[1]!.reason).toBe("The application refused [hidden]");
        expect(appHits.filter((h) => h.startsWith("DELETE"))).toEqual([]);
        // the task is kept (encrypted) for a day and shows in the registry as finished
        const task = svc().store.tasksOfJob(job.id)[0]!;
        expect(task.status).toBe("done");
        expect(task.payloadEnc).not.toContain(PASSWORD);
        expect(task.resultEnc).not.toContain("Login failed");
        endJob(job);
    });

    it("a mobile run: the app file is offered by hash from the platform's own storage; a path outside it is refused", async () => {
        const job = await jobFor(projectId);
        const apkRel = path.join(projectId, "_apps", "app.apk");
        const apkAbs = path.join(platform.config.artifactsDir, apkRel);
        fs.mkdirSync(path.dirname(apkAbs), { recursive: true });
        const apk = Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(5000, 7)]);
        fs.writeFileSync(apkAbs, apk);
        const phone = await connect(projectId, "phone-host", defaultCaps({ android: { adb: true, devices: [{ serial: "R58M", state: "device", emulator: false }], avds: ["Pixel_7"] } }));
        svc().store.setRunner(projectId, { runOn: "agent", agentId: phone.agentId });
        const mobile = { target: { appPackage: "com.example.shop", apkPath: apkAbs }, avd: "Pixel_7", keepEmulator: true };
        const logged: string[] = [];
        const pending = settle(svc().executorFor({ projectId, jobId: job.id }).execute("taqwright", { scratchDir: batch().scratchDir, scripts: [script("MOB-001")] }, { ...runEnv(), mobile: { ...mobile, log: (m) => logged.push(m) } }, { workers: 1 }));
        const offer = (await phone.next())!;
        expect(offer.adapterId).toBe("taqwright");
        expect(offer.mobile).toMatchObject({ appPackage: "com.example.shop", avd: "Pixel_7", keepEmulator: true, apk: { size: apk.length, sha256: sha256(apk) } });
        // a device framework never gets the web credentials (as the local mobile runner never passes them)
        expect(offer.env).toEqual({ baseUrl: APP, headless: true });
        expect((await phone.download(offer.taskId, offer.mobile!.apk!.ref)).bytes.equals(apk)).toBe(true);
        await phone.heartbeat(offer.taskId, { log: ["Emulator booting"] });
        await new Promise((r) => setTimeout(r, 250));
        expect((await phone.answer(offer, { runs: [passedRun("MOB-001")] })).status).toBe(200);
        const out = await pending;
        expect(out.ok).toBe(true);
        expect(logged).toContain("Emulator booting");
        // the file must live in the platform's store
        const elsewhere = path.join(dataDir, "outside.apk");
        fs.writeFileSync(elsewhere, apk);
        const refused = await settle(svc().executorFor({ projectId, jobId: job.id }).execute("taqwright", batch("MOB-002"), { ...runEnv(), mobile: { ...mobile, target: { appPackage: "com.example.shop", apkPath: elsewhere } } }, { workers: 1 }));
        expect(refused.ok).toBe(false);
        expect((refused as { e: Error }).e).toBeInstanceOf(RunnerAgentError);
        expect((refused as { e: Error }).e.message).toMatch(/not in this project's storage/);
        // no device in the run: the same plain answer a local run gives
        const none = await svc().executorFor({ projectId, jobId: job.id }).execute("taqwright", batch("MOB-003"), runEnv(), { workers: 1 });
        expect(none[0]).toMatchObject({ status: "error", error: "No Android device is set up for this run." });
        svc().store.setRunner(projectId, { runOn: "agent", agentId: null });
        endJob(job);
    });

    it("only the claiming agent can touch a task: another agent of the project, an agent of another project, and the API key are all refused", async () => {
        const job = await jobFor(projectId);
        const pending = settle(apiExec(projectId, job, batch("API-010")));
        const offer = (await agent.next())!;
        const mate = await connect(projectId, "worker-2");
        const stranger = await connect(await newProject("Stranger"), "stranger");
        for (const other of [mate, stranger]) {
            // nothing for them to claim, and everything about the task is "not found"
            expect((await other.poll()).status).toBe(204);
            expect((await other.heartbeat(offer.taskId)).status).toBe(404);
            expect((await other.download(offer.taskId, "anything.png")).status).toBe(404);
            expect((await other.upload(offer.taskId, "x.png", png(3))).status).toBe(404);
            expect((await other.result(offer.taskId, { ok: true, runs: [passedRun("API-010")] })).status).toBe(404);
        }
        // the API key is not a way in
        expect((await agent.send("POST", `/api/agent/tasks/${offer.taskId}/result`, { headers: { "x-api-key": API_KEY, "content-type": "application/json" }, body: "{}" })).status).toBe(401);
        expect((await agent.send("POST", `/api/agent/tasks/${offer.taskId}/heartbeat`, { headers: { "x-api-key": API_KEY } })).status).toBe(401);
        // the task is untouched and the owner can still finish it
        expect(svc().store.getTask(offer.taskId)!.status).toBe("running");
        expect((await agent.answer(offer, { runs: [passedRun("API-010")] })).status).toBe(200);
        expect((await pending).ok).toBe(true);
        endJob(job);
    });

    it("uploads are capped, hashed here, named safely, and only while the task runs; a result is accepted once; downloads are only what the task names", async () => {
        const job = await jobFor(projectId);
        const pending = settle(apiExec(projectId, job, batch("API-020")));
        const offer = (await agent.next())!;
        // too large (the platform accepts 200000 bytes here)
        const big = png(300_000);
        const tooBig = await agent.upload(offer.taskId, "big.png", big).catch(() => ({ status: 0 }) as Reply);
        expect([413, 0]).toContain(tooBig.status);
        expect(svc().store.getFile(offer.taskId, "out", "big.png")).toBeUndefined();
        expect(fs.existsSync(path.join(platform.config.artifactsDir, projectId, "_agent", offer.taskId, "out", "big.png"))).toBe(false);
        // a claimed hash that is wrong
        const wrong = await agent.upload(offer.taskId, "wrong.png", png(10), { "x-content-sha256": "0".repeat(64) });
        expect(wrong.status).toBe(400);
        expect(wrong.json.error).toMatch(/do not match the hash/);
        expect((await agent.upload(offer.taskId, "wrong.png", png(10), { "x-content-sha256": "nothex" })).status).toBe(400);
        // no half-written leftovers
        const outDir = path.join(platform.config.artifactsDir, projectId, "_agent", offer.taskId, "out");
        expect(fs.readdirSync(outDir).filter((f) => f.includes(".part-"))).toEqual([]);
        // names: odd but valid names stay inside the task's own folder
        expect((await agent.upload(offer.taskId, "a..b.png", png(5))).status).toBe(200);
        expect(fs.readdirSync(outDir)).toContain("a..b.png");
        expect(svc().store.getFile(offer.taskId, "out", "a..b.png")!.path).toBe(`${projectId}/_agent/${offer.taskId}/out/a..b.png`);
        // the same name again replaces it (a retried upload)
        const again = png(6);
        expect((await agent.upload(offer.taskId, "a..b.png", again)).json.sha256).toBe(sha256(again));
        expect(fs.readFileSync(path.join(outDir, "a..b.png")).equals(again)).toBe(true);
        // downloads: only files the task names; an upload of its own is not downloadable
        expect((await agent.download(offer.taskId, "a..b.png")).status).toBe(404);
        expect((await agent.download(offer.taskId, "nothing.png")).status).toBe(404);
        expect((await agent.download(offer.taskId, "..")).status).toBe(401); // not an agent route at all
        // a result
        const first = await agent.result(offer.taskId, { ok: true, runs: [passedRun("API-020")] });
        expect(first.status).toBe(200);
        const second = await agent.result(offer.taskId, { ok: true, runs: [passedRun("API-020")] });
        expect(second.status).toBe(409);
        expect(second.json.error).toMatch(/already received/);
        // nothing more can be uploaded once it is over, and the heartbeat tells the agent to stop
        expect((await agent.upload(offer.taskId, "late.png", png(2))).status).toBe(409);
        expect((await agent.heartbeat(offer.taskId)).json.cancel).toBe(true);
        expect((await pending).ok).toBe(true);
        endJob(job);
    });

    it("malformed and oversized JSON are plain 400 and 413", async () => {
        const job = await jobFor(projectId);
        const pending = settle(apiExec(projectId, job, batch("API-030")));
        const offer = (await agent.next())!;
        const mal = await agent.send("POST", `/api/agent/tasks/${offer.taskId}/heartbeat`, { headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" }, body: "{not json" });
        expect(mal.status).toBe(400);
        const bad = await agent.result(offer.taskId, { ok: "yes" });
        expect(bad.status).toBe(400);
        expect(bad.json.error).toMatch(/result is not in the expected format/);
        const huge = await agent.send("POST", `/api/agent/tasks/${offer.taskId}/heartbeat`, { headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" }, body: JSON.stringify({ log: ["x".repeat(299)], pad: "y".repeat(2_100_000) }) }).catch(() => ({ status: 0 }) as Reply);
        expect([413, 0]).toContain(huge.status);
        expect((await agent.answer(offer, { runs: [passedRun("API-030")] })).status).toBe(200);
        await pending;
        endJob(job);
    });

    it("cancelling the run stops the task: the agent hears it on its next heartbeat, and its answer changes nothing", async () => {
        const job = await jobFor(projectId);
        const abort = new AbortController();
        const pending = settle(apiExec(projectId, job, batch("API-040"), runEnv(), { signal: abort.signal }));
        const offer = (await agent.next())!;
        expect((await agent.heartbeat(offer.taskId)).json.cancel).toBe(false);
        abort.abort();
        const out = await pending;
        expect(out.ok).toBe(false);
        expect((out as { e: Error }).e.message).toBe("Job cancelled");
        expect((await agent.heartbeat(offer.taskId)).json.cancel).toBe(true);
        expect((await agent.result(offer.taskId, { ok: false, error: "The run was cancelled.", runs: [] })).status).toBe(200);
        expect(svc().store.getTask(offer.taskId)!.status).toBe("cancelled");
        // a run cancelled before it was sent never reaches an agent
        const early = new AbortController();
        early.abort();
        await expect(apiExec(projectId, job, batch("API-041"), runEnv(), { signal: early.signal })).rejects.toThrow("Job cancelled");
        expect(svc().store.tasksOfJob(job.id)).toHaveLength(1);
        endJob(job);
    });

    it("an agent that stops answering gets the task taken back once, then the run fails as a runner problem (no test verdict is invented)", async () => {
        const job = await jobFor(projectId);
        const pending = settle(apiExec(projectId, job, batch("API-050")));
        const first = (await agent.next())!;
        // silence: no heartbeat. The lease (3 s) ends, the task is offered again, here to the very same agent.
        const again = (await agent.next(15_000))!;
        expect(again.taskId).toBe(first.taskId);
        expect(svc().store.getTask(first.taskId)!.offers).toBe(2);
        // silent again: now the run fails, with plain words
        const out = await pending;
        expect(out.ok).toBe(false);
        expect((out as { e: Error }).e).toBeInstanceOf(RunnerAgentError);
        expect((out as { e: Error }).e.message).toBe("The runner agent stopped responding while it was running these tests.");
        expect(svc().store.getTask(first.taskId)!.status).toBe("failed");
        // a late answer is refused
        expect((await agent.result(first.taskId, { ok: true, runs: [passedRun("API-050")] })).status).toBe(409);
        endJob(job);
    }, 40_000);

    it("a heartbeat keeps a slow task alive past its lease", async () => {
        const job = await jobFor(projectId);
        const pending = settle(apiExec(projectId, job, batch("API-055")));
        const offer = (await agent.next())!;
        for (let i = 0; i < 8; i++) {
            await new Promise((r) => setTimeout(r, 600));
            expect((await agent.heartbeat(offer.taskId)).status).toBe(200);
        }
        expect(svc().store.getTask(offer.taskId)).toMatchObject({ status: "running", offers: 1 });
        await agent.answer(offer, { runs: [passedRun("API-055")] });
        expect((await pending).ok).toBe(true);
        endJob(job);
    }, 30_000);

    it("a result of ok=false is a runner problem with the agent's words (secrets hidden), never a failing test", async () => {
        const job = await jobFor(projectId);
        const pending = settle(apiExec(projectId, job, batch("API-060")));
        const offer = (await agent.next())!;
        expect((await agent.answer(offer, { ok: false, error: `Playwright is not installed here (token ${API_TOKEN})` })).status).toBe(200);
        const out = await pending;
        expect(out.ok).toBe(false);
        expect((out as { e: Error }).e).toBeInstanceOf(RunnerAgentError);
        expect((out as { e: Error }).e.message).toBe("Playwright is not installed here (token [hidden])");
        expect(svc().store.getTask(offer.taskId)!.status).toBe("failed");
        endJob(job);
    });

    it("a run for which no capable agent shows up is given up after a short wait", async () => {
        const lonely = await newProject("Lonely");
        const job = await jobFor(lonely);
        svc().store.setRunner(lonely, { runOn: "agent", agentId: null });
        const started = Date.now();
        const out = await settle(apiExec(lonely, job, batch("API-070")));
        expect(out.ok).toBe(false);
        expect((out as { e: Error }).e.message).toBe("No runner agent that can run these tests is connected. Start one, or switch the project back to running here.");
        expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
        endJob(job);
    });

    it("tasks go to the agent that is allowed and has a free slot, one task per slot, oldest first", async () => {
        const proj = await newProject("Slots");
        const a = await connect(proj, "a", defaultCaps(), 1);
        const b = await connect(proj, "b", defaultCaps(), 1);
        svc().store.setRunner(proj, { runOn: "agent", agentId: b.agentId });
        const job = await jobFor(proj);
        const p1 = settle(apiExec(proj, job, batch("API-081")));
        await new Promise((r) => setTimeout(r, 150));
        const p2 = settle(apiExec(proj, job, batch("API-082")));
        await new Promise((r) => setTimeout(r, 150));
        // agent a is not the chosen one
        expect((await a.poll()).status).toBe(204);
        // no free slot: nothing offered
        expect((await b.poll(0)).status).toBe(204);
        const first = (await b.next())!;
        expect(first.scripts[0]!.testId).toBe("API-081");
        // b has one slot and it is taken
        expect((await b.poll(1)).status).toBe(204);
        await b.answer(first, {});
        const second = (await b.next())!;
        expect(second.scripts[0]!.testId).toBe("API-082");
        await b.answer(second, {});
        expect((await p1).ok && (await p2).ok).toBe(true);
        endJob(job);
    }, 30_000);
});

describe("addresses: private targets are for agent runs only", () => {
    const spec = { title: "Health answers", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/health" }, { action: "assertResponse", check: "status", expected: 200 }] };
    it("with the guard on, a run here refuses a private address, a run on an agent accepts it (http/https only, no credentials in the address)", async () => {
        process.env.BLOCK_PRIVATE_TARGETS = "true";
        try {
            const here = await newProject("Guarded");
            const refused = await admin("POST", `/api/projects/${here}/specs`, { baseUrl: APP, validate: false, specs: [spec] });
            expect(refused.status).toBe(400);
            expect(refused.body.error).toMatch(/private\/loopback/);

            const there = await newProject("Agent-run");
            await connect(there, "inside-the-network");
            expect((await admin("PUT", `/api/projects/${there}/runner`, { runOn: "agent" })).status).toBe(200);
            const ok = await admin("POST", `/api/projects/${there}/specs`, { baseUrl: APP, validate: false, specs: [spec] });
            expect(ok.status).toBe(202);
            expect((await admin("POST", `/api/projects/${there}/specs`, { baseUrl: `http://user:pass@127.0.0.1:${APP_PORT}`, validate: false, specs: [{ ...spec, title: "Other" }] })).body.error).toMatch(/must not contain a user name or password/);
            expect((await admin("POST", `/api/projects/${there}/specs`, { baseUrl: "ftp://127.0.0.1/x", validate: false, specs: [{ ...spec, title: "Other 2" }] })).status).toBe(400);
            // everything the platform itself does keeps the guard: analysis browses from here, plain-English tests are written from here
            const gen = await admin("POST", `/api/projects/${there}/test-generation`, { url: APP });
            expect(gen.status).toBe(400);
            expect(gen.body.error).toMatch(/private\/loopback/);
        } finally {
            delete process.env.BLOCK_PRIVATE_TARGETS;
        }
    });
});

describe("one validation job through the worker, end to end", () => {
    it("runs on the agent, stores what a local run stores, says where it ran, and leaves no secret behind", async () => {
        const projectId = await newProject("End to end");
        const agent = await connect(projectId, "maya-laptop");
        const imp = await admin("POST", `/api/projects/${projectId}/specs`, {
            baseUrl: APP,
            validate: false,
            credentials: { username: "demo@example.com", password: PASSWORD, apiToken: API_TOKEN },
            specs: [
                { title: "Health answers", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/health" }, { action: "assertResponse", check: "status", expected: 200 }] },
                { title: "Items are listed", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/items" }, { action: "assertResponse", check: "status", expected: 200 }] },
            ],
        });
        expect(imp.status).toBe(202);
        const [t1, t2] = imp.body.tests as Array<{ id: string; testId: string }>;
        expect((await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent" })).status).toBe(200);

        worker = new Worker({ ...platform }, 100);
        worker.start();
        const done = { v: false };
        const seen: Array<{ env: unknown }> = [];
        const serving = agent.serve(
            async (offer) => {
                seen.push({ env: offer.env });
                // the first test passes, the second fails with a screenshot and the password in its message
                return {
                    uploads: { [`${t2!.testId}-failure.png`]: png(222) },
                    runs: [
                        passedRun(t1!.testId, { responses: [{ method: "GET", path: "/health", status: 200 }] }),
                        failedRun(t2!.testId, `Expected 200 but got 500 (signed in with ${PASSWORD})`, { artifacts: [{ kind: "screenshot", ref: `${t2!.testId}-failure.png` }], created: [{ path: "/items", id: "9", deletePath: "/items/9", status: "removed" }] as never }),
                    ],
                };
            },
            () => done.v,
        );
        const started = await admin("POST", `/api/tests/${t1!.id}/validate`);
        expect(started.status).toBe(202);
        // t1 only: wait, then run t2 as well so both are executed by the same fake
        let job = started.body.jobId as string;
        for (let i = 0; i < 100; i++) {
            const j = (await admin("GET", `/api/test-generation/${job}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) break;
            await new Promise((r) => setTimeout(r, 200));
        }
        const second = await admin("POST", `/api/tests/${t2!.id}/validate`);
        expect(second.status).toBe(202);
        job = second.body.jobId;
        let last: any;
        for (let i = 0; i < 100; i++) {
            last = (await admin("GET", `/api/test-generation/${job}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(last.status)) break;
            await new Promise((r) => setTimeout(r, 200));
        }
        done.v = true;
        await serving;
        await worker.stop();
        worker = undefined;

        // where it ran
        expect(last.ranOn).toEqual({ kind: "agent", agentId: agent.agentId, name: "maya-laptop", runnerId: expect.any(String), phase: "completed", attempt: 1 });
        const jobs = (await admin("GET", `/api/projects/${projectId}/jobs`)).body as Array<{ ranOn?: unknown }>;
        expect(jobs.every((j) => (j.ranOn as { kind: string }).kind === "agent")).toBe(true);
        // the stored results look like a local run's
        const exec1 = (await admin("GET", `/api/tests/${t1!.id}/executions`)).body;
        const exec2 = (await admin("GET", `/api/tests/${t2!.id}/executions`)).body;
        expect(exec1[0]).toMatchObject({ status: "passed", attempt: 1 });
        expect(exec2[0]).toMatchObject({ status: "failed" });
        expect(exec2[0].error).toBe("Expected 200 but got 500 (signed in with [hidden])");
        const tests = (await admin("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; validationStatus: string }>;
        expect(tests.find((t) => t.id === t1!.id)!.validationStatus).toBe("VALIDATED");
        expect(tests.find((t) => t.id === t2!.id)!.validationStatus).not.toBe("VALIDATED");
        // the screenshot is an ordinary stored artifact with the agent's bytes
        const artifacts = platform.db.all<{ id: string; kind: string; path: string }>("SELECT id, kind, path FROM artifacts WHERE project_id = ? AND test_case_id = ?", projectId, t2!.id);
        const shot = artifacts.find((a) => a.kind === "screenshot")!;
        expect(shot.path).toContain(`${projectId}/_artifacts/${t2!.testId}/`);
        const served = await fetch(`${BASE}/api/artifacts/${shot.id}?key=${API_KEY}`);
        expect(Buffer.from(await served.arrayBuffer()).equals(png(222))).toBe(true);
        // the cleanup the agent did is in the ledger, and the platform sent no DELETE of its own
        const events = (await admin("GET", `/api/test-generation/${job}/events`)).body;
        expect(JSON.stringify(events)).toMatch(/runner agent/);
        expect(platform.db.all("SELECT status FROM cleanup_ledger WHERE project_id = ?", projectId).map((r: any) => r.status)).toEqual(["removed"]);
        expect(appHits.filter((h) => h.startsWith("DELETE"))).toEqual([]);
        // the agent received the credentials; nothing the platform keeps holds them in clear
        expect(JSON.stringify(seen)).toContain(PASSWORD);
        platform.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const leaks: string[] = [];
        const scan = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) scan(full);
                else {
                    const bytes = fs.readFileSync(full);
                    const forms = [bytes.toString("latin1"), bytes.toString("utf16le")];
                    for (const s of [PASSWORD, API_TOKEN, agent.token]) if (forms.some((f) => f.includes(s))) leaks.push(`${s.slice(0, 12)} in ${path.relative(dataDir, full)}`);
                }
            }
        };
        scan(dataDir);
        expect(leaks).toEqual([]);
        for (const a of [events, exec1, exec2, tests, jobs]) expect(JSON.stringify(a)).not.toContain(PASSWORD);
    }, 90_000);
});
