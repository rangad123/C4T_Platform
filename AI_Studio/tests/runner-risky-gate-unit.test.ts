/**
 * Risky saved checks on a runner (VERIFY-P3-P4 gap 8, the P4-CP3 runner note): the platform decides the risky-checks gate for each Run, from
 * the project's own authorization (job-runner.ts), and the runner task carries that decision (TaskOffer.env.riskyChecks). The runner only
 * passes it to the test process. Nothing a runner says or has can switch the checks on: not its hello, not its poll, not its own environment.
 *
 * A real platform in this process, its routes reached through Fastify's `inject` (no port), a real Run job, and a FAKE RUNNER
 * (tests/fixtures/fake-agent.ts) that reads the task it is given. No browser, no model, no network.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskOffer, WireRunEnv } from "../src/agent-protocol/schema.js";
import { toRunEnv } from "../src/agent/mapping.js";
import { childEnvFrom } from "../src/agent/task-process.js";
import { loadConfig } from "../src/config.js";
import { riskyEnv } from "../src/engine/validation/runner.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import { toWireEnv } from "../src/platform/agent-routing.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { runJob } from "../src/platform/job-runner.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { UserStore } from "../src/platform/user-store.js";
import { hasCurrentAuthorization } from "../src/security/authorization-gate.js";
import { securityStoreFor } from "../src/security/store.js";
import { personalRunner } from "./helpers/personal-runner.js";
import { defaultCaps, FakeAgent, viaInject } from "./fixtures/fake-agent.js";

const API_KEY = "risky-runner-admin-key-5d02";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const GATE_LINE = 'test.skip(process.env.TEST_RISKY_CHECKS !== "1"';

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let port = 8470; // never contacted: the fake runner runs nothing

const call = async (method: string, url: string, body?: unknown) => {
    const r = await server.inject({ method: method as "GET", url, headers: { "x-api-key": API_KEY, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, payload: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.statusCode, body: r.body.startsWith("{") || r.body.startsWith("[") ? r.json() : r.body } as { status: number; body: any };
};

/** What a runner that claims the authorization for itself adds to every message it sends. */
const CLAIM = { riskyChecks: "authorization", riskyChecksGate: "authorization", authorized: true, authorization: true };

/**
 * A Run of one risky saved test (requests sent three at once), data changes on, on the project's own fake runner. Returns the task the
 * runner was given. `authorized`: the project holds a current client authorization for the application's address. `claims`: the runner
 * claims the authorization in its hello and its polls.
 */
async function runnerTaskOf(o: { authorized: boolean; claims?: boolean }): Promise<TaskOffer> {
    const app = `http://127.0.0.1:${port++}`;
    const name = `Risky ${randomUUID().slice(0, 8)}`;
    const projectId = (await call("POST", "/api/projects", { name })).body.id as string;
    const ownerId = new UserStore(platform.db).create({ email: `${randomUUID()}@people.example`, name, role: "editor" }).id;
    const token = personalRunner(platform, { ownerId, label: `${name} pc` }).secret;
    const agent = new FakeAgent(viaInject(server), token, { name: `${name} pc`, capabilities: o.claims ? ({ ...defaultCaps(), ...CLAIM } as never) : defaultCaps(), concurrency: 1 });
    expect((await agent.hello(o.claims ? CLAIM : {})).status).toBe(200);
    getAgentServices(platform).store.setRunner(projectId, { runOn: "agent" });
    if (o.authorized) {
        const sec = securityStoreFor(platform.db);
        const target = sec.createApplication(projectId, { name: "Shop", targetUrl: `${app}/`, environment: "staging", scope: [], excludedPaths: [], maxRequestsPerSecond: 10 });
        sec.addAuthorization(target.id, { basis: "owner", approverName: "Owner", documentReference: null, restrictions: null, statement: "I confirm.", confirmedByName: "Tester" });
    }
    expect(hasCurrentAuthorization(platform.db, projectId, app)).toBe(o.authorized);

    const risky = { title: "Three orders at once", kind: "api", category: "API", steps: [{ action: "request", method: "POST", path: "/orders", parallel: 3 }, { action: "assertResponse", check: "relation", expression: "ok == 3" }] };
    const imported = await call("POST", `/api/projects/${projectId}/specs`, { baseUrl: app, validate: false, specs: [risky] });
    expect(imported.status, JSON.stringify(imported.body)).toBe(202);
    const [test] = imported.body.tests as Array<{ id: string; testId: string }>;
    const appId = platform.repo.createApplication(projectId, app, { ...DEFAULT_JOB_OPTIONS }, undefined) as string;
    const created = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [test!.id], allowMutatingApiTests: true, startedBy: { kind: "user", id: ownerId } });
    // Only this job is waiting (no worker runs in this file).
    platform.db.run("UPDATE generation_jobs SET status = 'FAILED' WHERE status = 'QUEUED' AND id <> ?", created.id);
    const owner = `risky-runner-${randomUUID().slice(0, 6)}`;
    const job = platform.repo.claimNextJob(60_000, owner)!;
    expect(job.id).toBe(created.id);
    // The platform's own wiring (schedule-services.ts): the gate's "authorization" is read from the project's records.
    const done = runJob({ ...platform, hasCurrentAuthorization: (p, u) => hasCurrentAuthorization(platform.db, p, u) }, job, owner);

    let offer: TaskOffer | undefined;
    for (const end = Date.now() + 20_000; !offer && Date.now() < end; ) {
        const r = await agent.poll(1, o.claims ? CLAIM : {});
        if (r.offer) offer = r.offer;
        else expect(r.status, r.text).toBe(204);
    }
    expect(offer, "the runner was given a task").toBeDefined();
    expect(offer!.scripts[0]!.content).toContain(GATE_LINE);
    await agent.answer(offer!, {});
    await done;
    return offer!;
}

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "30", AGENT_WATCH_MS: "25", AGENT_NO_AGENT_GRACE_SECONDS: "60" });
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-risky-runner-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY, SECRET_KEY: "risky-runner-secret-key-0123456789ab", LLM_PROVIDER: "anthropic", CONCURRENCY: "1", MAX_REPAIR_ATTEMPTS: "0" }));
    server = await buildServer(platform);
}, 60_000);

afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("the risky-checks gate on a runner is the platform's decision, per task", () => {
    it("an authorized project's runner task carries the gate, and the runner hands it to the test process: the risky checks run", async () => {
        const offer = await runnerTaskOf({ authorized: true });
        expect(offer.env.riskyChecks).toBe("authorization");
        // The runner side: the task's environment reaches the test process as TEST_RISKY_CHECKS=1, so the script's gate line lets it run.
        expect(riskyEnv(toRunEnv(offer.env), "/run")).toMatchObject({ TEST_RISKY_CHECKS: "1", TEST_RISKY_GATE: "authorization" });
    }, 60_000);

    it("an unauthorized project's runner task carries no gate: the risky checks skip", async () => {
        const offer = await runnerTaskOf({ authorized: false });
        expect(offer.env.riskyChecks).toBeUndefined();
        expect(riskyEnv(toRunEnv(offer.env), "/run")).toEqual({});
    }, 60_000);

    it("a runner that claims the authorization in its own messages is ignored", async () => {
        const offer = await runnerTaskOf({ authorized: false, claims: true });
        expect(offer.env.riskyChecks).toBeUndefined();
        expect(riskyEnv(toRunEnv(offer.env), "/run")).toEqual({});
    }, 60_000);

    it("nor can a runner switch them on from its own environment: the test process never inherits TEST_RISKY_*", () => {
        const own = { PATH: "/usr/bin", TEST_RISKY_CHECKS: "1", TEST_RISKY_GATE: "authorization", TEST_RISKY_DIR: "/tmp/x" };
        expect(Object.keys(childEnvFrom(own))).toEqual(["PATH"]);
    });
});

describe("the gate on the wire", () => {
    const base = { baseUrl: "http://127.0.0.1:1", headless: true };
    it("travels in the task's environment as one of the gate's three values; an older task parses exactly as before", () => {
        for (const g of ["bench", "fixture", "authorization"] as const) {
            expect(toWireEnv({ ...base, riskyChecks: g }).riskyChecks).toBe(g);
            expect(toRunEnv(WireRunEnv.parse({ ...base, riskyChecks: g })).riskyChecks).toBe(g);
        }
        expect(toWireEnv(base)).toEqual(base);
        expect(WireRunEnv.parse(base)).toEqual(base);
        expect(WireRunEnv.safeParse({ ...base, riskyChecks: "yes" }).success).toBe(false);
        expect(WireRunEnv.safeParse({ ...base, riskyChecks: true }).success).toBe(false);
    });
});
