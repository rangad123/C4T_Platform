/**
 * Round 52: a security assessment runs on the person's runner in runners mode (docs/features/explore-on-runner.md). The assessment loop stays
 * on the platform (lease, authorization, cancel, judging, findings, report); the steps that touch the application run on the starter's runner as
 * an explore task of mode "assessment", so its probes leave from the runner and none from the server.
 *
 * A real platform on real HTTP in runners mode. Hand-driven protocol-2 agents prove the start refusals (no runner, offline, too old, a private
 * address the runner does not open, the server's key, no authorization), what the offer carries, that a waiting assessment sent nothing, that
 * another person's runner and a downgraded runner are never offered it, and that a cancel stops the task. Then the REAL agent from source runs
 * a whole assessment of the local security fixture: the deliberate problems are found and stored on the platform, nothing outside the scope or
 * under an excluded path was requested, only reads, and the server's guard refused nothing (no browser opened here).
 *
 * Browser-launching: node scripts/with-lock.mjs browser -- npx vitest run tests/assessment-on-runner.test.ts
 * Ports: platform 9170, fixture 9171, the fixture's "outside" host 9172. No model, no network beyond 127.0.0.1.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { memoryLogger } from "../src/agent/log.js";
import { loadConfig } from "../src/config.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { modeNeedsUpdate } from "../src/platform/explore-task.js";
import { KEY_HAS_NO_RUNNER, removeServerExecutionGuard, RUNNER_NOT_SET_UP, RUNNER_OFFLINE, serverRunRefusals } from "../src/platform/runner-only.js";
import { buildServer } from "../src/platform/server.js";
import { ASSESSMENT_PRIVATE_REFUSED, assessmentTaskJobId, checkedOutcome } from "../src/security/assessment/on-runner.js";
import { FINISHED_STATES } from "../src/security/contract.js";
import { SecurityStore } from "../src/security/store.js";
import { startSecurityFixture, type SecurityFixture } from "./fixtures/security-fixture-app.js";
import { personalRunner, testPerson } from "./helpers/personal-runner.js";

const PORT = 9170;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = "assess-runner-admin-key-5e19";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS", "AGENT_ACCEPT_SECONDS", "BLOCK_PRIVATE_TARGETS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const MODES_NOW = ["plain", "agent", "mobile", "assessment"];
const caps = (modes: string[] = MODES_NOW) => ({ os: "linux", arch: "x64", node: "v24.0.0", browsers: ["chromium"], runnerSwitches: true, explore: true, exploreModes: modes });

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let fixture: SecurityFixture;
let store: SecurityStore;
const work: string[] = [];

const call = async (method: string, url: string, body?: unknown, key = API_KEY) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { "x-api-key": key, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; text: string; body: any };
};
const agentApi = async (token: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as any) : undefined };
};
const svc = () => getAgentServices(platform);
const until = async (what: string, check: () => boolean | Promise<boolean>, ms = 60_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
};
const finished = async (id: string, ms = 120_000) => {
    await until("the assessment to finish", () => FINISHED_STATES.includes(store.getAssessment(id)!.state), ms);
    return store.getAssessment(id)!;
};
const taskOf = (assessmentId: string) => svc().store.tasksOfJob(assessmentTaskJobId(assessmentId))[0];

/** A person with their own API token, a project they own, and an authorized application of the fixture (excluding /admin). */
async function person(name: string) {
    const who = testPerson(platform);
    const project = (await call("POST", "/api/projects", { name }, who.token)).body.id as string;
    const made = await call("POST", `/api/v1/security/projects/${project}/applications`, { name: `${name} shop`, targetUrl: `${fixture.origin}/`, environment: "development", excludedPaths: ["/admin"], maxRequestsPerSecond: 10 }, who.token);
    expect(made.status, made.text).toBe(201);
    const appId = made.body.application.id as string;
    const auth = await call("POST", `/api/v1/security/applications/${appId}/authorizations`, { basis: "owner", approverName: "Test Owner", confirm: true }, who.token);
    expect(auth.status, auth.text).toBe(201);
    return { ...who, project, appId };
}
const start = (p: { appId: string; token: string }, key = p.token) => call("POST", `/api/v1/security/applications/${p.appId}/assessments`, {}, key);

type Raw = { token: string; agentId: string; modes: string[] };
async function hello(token: string, name: string, modes = MODES_NOW): Promise<Raw> {
    const r = await agentApi(token, "POST", "/api/agent/hello", { protocol: 1, protocols: [1, 2], name, version: "52.0.0", concurrency: 1, capabilities: caps(modes) });
    expect(r.status).toBe(200);
    return { token, agentId: r.body.agentId as string, modes };
}
const pollOnce = async (a: Raw) => {
    const r = await agentApi(a.token, "POST", "/api/agent/poll", { agentId: a.agentId, freeSlots: 1, capabilities: caps(a.modes) });
    return r.status === 200 ? r.body : undefined;
};
const poll = async (a: Raw) => {
    for (let i = 0; i < 40; i++) {
        const offer = await pollOnce(a);
        if (offer) return offer;
    }
    throw new Error("no offer");
};

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "60", AGENT_WATCH_MS: "50", AGENT_NO_AGENT_GRACE_SECONDS: "30", AGENT_ACCEPT_SECONDS: "20" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    fixture = await startSecurityFixture(9171, 9172);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-assess-runner-"));
    // The platform's own private-address setting stays off: in runners mode the runner's switch decides (the fixture listens on 127.0.0.1).
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY, EXECUTION_MODE: "runners", WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false", SECRET_KEY: "assessment-on-runner-secret-0123456789", LLM_PROVIDER: "anthropic" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    store = new SecurityStore(platform.db);
}, 60_000);

afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    server?.server.closeAllConnections();
    await server?.close();
    platform?.db.close();
    removeServerExecutionGuard();
    await fixture?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    for (const d of work) fs.rmSync(d, { recursive: true, force: true });
});

describe("starting an assessment in runners mode", () => {
    it("is refused with the runs' codes when the runner cannot take it, keeps its own safety refusals, and nothing is queued or requested", async () => {
        const none = await person("No runner");
        expect(await start(none)).toMatchObject({ status: 409, body: { error: RUNNER_NOT_SET_UP, details: { code: "RUNNER_NOT_SET_UP", link: "#/settings#runner" } } });
        // The server's shared key is nobody's: no runner may take it.
        expect(await start(none, API_KEY)).toMatchObject({ status: 409, body: { error: KEY_HAS_NO_RUNNER, details: { code: "RUNNER_NOT_SET_UP" } } });

        const offline = await person("Offline runner");
        personalRunner(platform, { ownerId: offline.id, label: "Sleeping desktop" });
        expect(await start(offline)).toMatchObject({ status: 409, body: { error: RUNNER_OFFLINE, details: { code: "RUNNER_OFFLINE" } } });

        const old = await person("Old runner");
        await hello(personalRunner(platform, { ownerId: old.id, label: "Old laptop" }).secret, "Old laptop", ["plain", "agent"]);
        expect(await start(old)).toMatchObject({ status: 409, body: { error: modeNeedsUpdate("Old laptop", "assessment"), details: { code: "RUNNER_CANNOT_RUN", link: "#/settings#runner" } } });
        // The page's readiness check says the same before the click.
        expect((await call("GET", "/api/me/runner", undefined, old.token)).body.runner.can.assessment).toEqual({ ok: false, why: modeNeedsUpdate("Old laptop", "assessment") });

        const closed = await person("Private off");
        await hello(personalRunner(platform, { ownerId: closed.id, label: "Closed laptop", privateTargets: false }).secret, "Closed laptop");
        expect(await start(closed)).toMatchObject({ status: 409, body: { error: ASSESSMENT_PRIVATE_REFUSED, details: { code: "RUNNER_CANNOT_RUN" } } });
        expect((await call("GET", "/api/me/runner", undefined, closed.token)).body.runner.can.assessment).toEqual({ ok: true });

        // The assessment's own rules still come first: without a current authorization it is refused as before.
        const who = testPerson(platform);
        const project = (await call("POST", "/api/projects", { name: "Not authorized" }, who.token)).body.id as string;
        await hello(personalRunner(platform, { ownerId: who.id, label: "Ready laptop" }).secret, "Ready laptop");
        const app = (await call("POST", `/api/v1/security/projects/${project}/applications`, { name: "Unauthorized", targetUrl: `${fixture.origin}/`, environment: "development" }, who.token)).body.application.id as string;
        const noAuth = await call("POST", `/api/v1/security/applications/${app}/assessments`, {}, who.token);
        expect(noAuth.status).toBe(409);
        expect(noAuth.body.error).toMatch(/No authorization is recorded yet/);

        for (const p of [none, offline, old, closed]) expect(store.listAssessments({ projectId: p.project })).toEqual([]);
        expect(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_tasks")!.n).toBe(0);
        expect(fixture.requests).toEqual([]);
    });

    it("goes to the starter's runner only, with the scope and caps in the offer; the platform sent nothing while it waited; a cancel stops the task", async () => {
        const maya = await person("Maya");
        const omar = await person("Omar");
        const theirs = await hello(personalRunner(platform, { ownerId: omar.id, label: "Omar laptop" }).secret, "Omar laptop");
        const mine = await hello(personalRunner(platform, { ownerId: maya.id, label: "Maya laptop" }).secret, "Maya laptop");
        const started = await start(maya);
        expect(started.status, started.text).toBe(201);
        const id = started.body.assessment.id as string;
        // One at a time per application, as before.
        expect((await start(maya)).status).toBe(409);
        for (let i = 0; i < 3; i++) expect(await pollOnce(theirs)).toBeUndefined();
        const offer = await poll(mine);
        expect(offer).toMatchObject({
            kind: "explore",
            jobId: assessmentTaskJobId(id),
            adapterId: "explore",
            env: { baseUrl: `${fixture.origin}/` },
            explore: { mode: "assessment", request: { url: `${fixture.origin}/`, app: { id: maya.appId, excludedPaths: ["/admin"], maxRequestsPerSecond: 10 }, settings: { maxRequestsPerAssessment: expect.any(Number) }, limits: { maxPages: expect.any(Number) } } },
        });
        expect(await pollOnce(theirs)).toBeUndefined();
        // Waiting for the runner, the platform requested nothing of the application.
        expect(fixture.requests).toEqual([]);
        expect((await call("POST", `/api/v1/security/assessments/${id}/cancel`, {}, maya.token)).status).toBe(202);
        const end = await finished(id);
        expect(end.state).toBe("CANCELLED");
        await until("the task to be stopped", () => Boolean(taskOf(id)?.cancelRequested) || taskOf(id)?.status === "cancelled");
        expect(fixture.requests).toEqual([]);
    }, 60_000);

    it("is never offered to a runner that now polls as an older program; the assessment ends telling the person to update", async () => {
        const p = await person("Downgraded");
        const a = await hello(personalRunner(platform, { ownerId: p.id, label: "Downgraded laptop" }).secret, "Downgraded laptop");
        const started = await start(p);
        expect(started.status, started.text).toBe(201);
        const older = { ...a, modes: ["plain", "agent"] };
        for (let i = 0; i < 3; i++) expect(await pollOnce(older)).toBeUndefined();
        const end = await finished(started.body.assessment.id);
        expect(end.state).toBe("FAILED");
        expect(end.error).toContain(modeNeedsUpdate("Downgraded laptop", "assessment"));
    }, 60_000);

    it("refuses a result from the runner that is not an assessment's", () => {
        expect(() => checkedOutcome(undefined)).toThrow(/did not say what it found/);
        expect(() => checkedOutcome({ work: { discovery: { startUrl: "x" } } })).toThrow(/did not say what it found/);
        expect(() => checkedOutcome({ work: { discovery: { startUrl: "x", notVisited: 0, pages: [], documents: [], apiAnswers: [], apiCalls: [], forms: [], technologies: [], outOfScope: [], excluded: [], blockedWrites: [], failures: [] } } })).toThrow(/did not say what it found/);
    });
});

describe("the real runner runs the assessment; findings are stored on the platform", () => {
    it("finds the fixture's problems from the runner, keeps to the scope, only reads, and the server opened nothing", async () => {
        const p = await person("Real runner");
        const { secret } = personalRunner(platform, { ownerId: p.id, label: "Real laptop" });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-assess-agent-"));
        work.push(dir);
        const { log } = memoryLogger();
        const agent = new Agent({ config: { baseUrl: BASE, token: secret, name: "Real laptop", concurrency: 1, workDir: dir, allowInsecure: false, cacheBytes: 64 * 1024 * 1024, tokenSource: "env" }, log, heartbeatMs: 500, backoff: { baseMs: 100, maxMs: 500 }, liveBatch: { maxDelayMs: 200 }, outboxMaxDelayMs: 2000 });
        const done = agent.run();
        const refusedBefore = serverRunRefusals();
        try {
            await until("the runner to connect", () => Boolean(svc().store.runnerOf(p.id)?.online && svc().store.runnerOf(p.id)?.agent?.capabilities.exploreModes?.includes("assessment")));
            fixture.requests.length = 0;
            const started = await start(p);
            expect(started.status, started.text).toBe(201);
            const id = started.body.assessment.id as string;
            // The page shows its progress live (the assessment's own record), as when it ran on the platform.
            const seen = new Set<string>();
            await until("the assessment to finish", () => {
                const now = store.getAssessment(id)!;
                seen.add(`${now.state} ${now.progressText ?? ""}`);
                return FINISHED_STATES.includes(now.state);
            }, 240_000);
            const end = store.getAssessment(id)!;
            expect([...seen].some((x) => /^DISCOVERING .*your runner “Real laptop”/.test(x)), JSON.stringify([...seen])).toBe(true);
            expect([...seen].some((x) => /^(DISCOVERING Looking at page|SCANNING )/.test(x)), JSON.stringify([...seen])).toBe(true);
            expect(["COMPLETED", "PARTIALLY_COMPLETED"], `${end.state}: ${end.error}`).toContain(end.state);
            expect(end.coverage?.pagesSeen).toBeGreaterThanOrEqual(3);
            // The task ran on this person's runner.
            expect(taskOf(id)).toMatchObject({ status: "done", agentId: svc().store.runnerOf(p.id)!.agent!.id });
            // Found from the runner, stored on the platform.
            const { body } = await call("GET", `/api/v1/security/projects/${p.project}/findings?limit=200`, undefined, p.token);
            const findings = body.findings as Array<{ title: string; category: string; location: string }>;
            const has = (category: string, re: RegExp) => findings.some((f) => f.category === category && re.test(`${f.title} ${f.location}`));
            expect(has("headers", /Content-Security-Policy/i), JSON.stringify(findings.map((f) => f.title))).toBe(true);
            expect(has("exposed-files", /\.env/)).toBe(true);
            expect(has("cookies", /sessionid/)).toBe(true);
            // The scope, the exclusions and read-only held on the runner.
            expect(fixture.outsideRequests).toEqual([]);
            const paths = fixture.requests.map((r) => r.path);
            expect(paths).toContain("/.env");
            expect(paths.some((x) => x.startsWith("/admin"))).toBe(false);
            expect(fixture.requests.filter((r) => !["GET", "HEAD", "OPTIONS"].includes(r.method))).toEqual([]);
            // The report can be built on the platform.
            expect((await call("GET", `/api/v1/security/assessments/${id}`, undefined, p.token)).body.assessment.state).toBe(end.state);
            // The server's guard refused nothing: no browser was opened and no script was run here.
            expect(serverRunRefusals()).toBe(refusedBefore);
        } finally {
            agent.stop();
            await done;
        }
    }, 300_000);
});
