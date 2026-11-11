/**
 * The platform's side of "which browser did the runner use": the runner list shows the browser a runner reports (and the Chrome and Edge it
 * found), a runner with no browser ready is refused with its own sentence, a result that names its browser becomes one plain event of the
 * run and the run's `ranOn.browser`, and an older runner's answers stay exactly as they were. A FAKE AGENT (plain protocol calls) stands in
 * for the runner; the platform is real, reached through Fastify's inject (no port, no browser).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Capabilities } from "../src/agent-protocol/schema.js";
import { loadConfig } from "../src/config.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { personalRunner } from "./helpers/personal-runner.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { defaultCaps, FakeAgent, passedRun, viaInject } from "./fixtures/fake-agent.js";

const API_KEY = "br-admin-key-6e21c0f4";
const APP = "http://127.0.0.1:6935";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS", "AGENT_MAX_TOKENS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const EDGE = { name: "msedge" as const, version: "155.0.4283.62", source: "installed" as const };

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;

const admin = async (method: string, url: string, body?: unknown) => {
    const res = await server.inject({ method: method as "GET", url, headers: { "x-api-key": API_KEY, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined } as { status: number; body: any };
};
const newProject = async (name: string) => (await admin("POST", "/api/projects", { name })).body.id as string;
const connect = async (projectId: string, name: string, caps: Capabilities) => {
    const secret = personalRunner(platform, { label: name, replace: true }).secret;
    const agent = new FakeAgent(viaInject(server), secret, { name, capabilities: caps });
    expect((await agent.hello()).status).toBe(200);
    return agent;
};
const svc = () => getAgentServices(platform);

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "5", AGENT_WATCH_MS: "50", AGENT_NO_AGENT_GRACE_SECONDS: "5", AGENT_MAX_TOKENS: "25" }); // one project, several runners
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-browsers-platform-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", CONCURRENCY: "1", MAX_REPAIR_ATTEMPTS: "0" }));
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

describe("the runner list", () => {
    it("shows the browser a runner uses and the browsers it found; an older runner's entry is unchanged", async () => {
        const projectId = await newProject("Runner browsers");
        await connect(projectId, "maya-laptop", defaultCaps({ os: "win32", browsers: ["chromium", "firefox"], browser: EDGE, installedBrowsers: [{ name: "chrome", version: "120.0.6099.71", usable: false, reason: "Google Chrome 120 is too old" }, { name: "msedge", version: EDGE.version, usable: true }] }));
        // Round 45: a project shows the person's own runner (one per person).
        const list = (await admin("GET", `/api/projects/${projectId}/agents`)).body as Array<{ name: string; capabilities: Record<string, unknown> }>;
        const maya = list.find((a) => a.name === "maya-laptop")!;
        expect(maya.capabilities).toMatchObject({ browsers: ["chromium", "firefox"], browser: EDGE, installedBrowsers: [{ name: "chrome", usable: false, reason: "Google Chrome 120 is too old" }, { name: "msedge", usable: true }] });
        // An older runner set up instead: its entry is unchanged.
        await connect(projectId, "old-runner", defaultCaps());
        const again = (await admin("GET", `/api/projects/${projectId}/agents`)).body as Array<{ name: string; capabilities: Record<string, unknown> }>;
        expect(again.find((a) => a.name === "old-runner")!.capabilities).toEqual({ browsers: ["chromium"] });
    });

    it("a runner without a ready browser is refused for web tests with its own sentence", async () => {
        const projectId = await newProject("No browser ready");
        await connect(projectId, "kiosk", defaultCaps({ browsers: [], browserNote: "The runner is downloading Chromium for web tests." }));
        expect((await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent" })).status).toBe(200);
        const runner = (await admin("GET", `/api/projects/${projectId}/runner`)).body;
        expect(runner.canRunWeb).toBe(false);
        expect(runner.unavailableReason).toContain("Web and API tests can't run: it has no browser ready (The runner is downloading Chromium for web tests).");
    });
});

describe("a run's browser", () => {
    let projectId: string;
    let agent: FakeAgent;
    beforeAll(async () => {
        projectId = await newProject("Run browsers");
        agent = await connect(projectId, "maya-laptop", defaultCaps({ browser: EDGE }));
        svc().store.setRunner(projectId, { runOn: "agent", agentId: null });
    });

    const runOnce = async (browser: unknown) => {
        const app = platform.repo.createApplication(projectId, APP, { ...DEFAULT_JOB_OPTIONS }, undefined);
        const job = await platform.repo.createJob(projectId, app, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] });
        const pending = svc()
            .executorFor({ projectId, jobId: job.id })
            .execute("playwright", { scratchDir: path.join(dataDir, "scratch"), scripts: [{ testId: "WEB-001", filename: "WEB-001.spec.ts", content: "// script" }] }, { run: { baseUrl: APP, headless: true } }, { workers: 1 });
        const offer = (await agent.next())!;
        expect(offer).toBeTruthy();
        const sent = await agent.result(offer.taskId, { ok: true, runs: [passedRun("WEB-001")], ...(browser !== undefined ? { browser } : {}) });
        expect(sent.status).toBe(200);
        const runs = await pending;
        expect(runs.map((r) => r.status)).toEqual(["passed"]);
        platform.repo.setJobStatus(job.id, "COMPLETED");
        return job;
    };

    it("becomes one plain event and the job's ranOn.browser", async () => {
        const job = await runOnce(EDGE);
        const events = platform.repo.listEvents(job.id).filter((e) => e.kind === "agent_browser");
        expect(events.map((e) => [e.message, e.data])).toEqual([["Ran in Microsoft Edge 155, installed on maya-laptop.", { browser: EDGE }]]);
        const shown = (await admin("GET", `/api/test-generation/${job.id}`)).body;
        expect(shown.ranOn).toMatchObject({ kind: "agent", agentId: agent.agentId, name: "maya-laptop", browser: EDGE });
        // Kept with the run's events: it is still there when the task itself is gone.
        platform.db.run("DELETE FROM agent_tasks WHERE job_id = ?", job.id);
        expect((await admin("GET", `/api/test-generation/${job.id}`)).body.ranOn.browser).toEqual(EDGE);
    });

    it("a runner that does not say (an older one) leaves the run exactly as before", async () => {
        const job = await runOnce(undefined);
        expect(platform.repo.listEvents(job.id).filter((e) => e.kind === "agent_browser")).toEqual([]);
        const ranOn = (await admin("GET", `/api/test-generation/${job.id}`)).body.ranOn;
        expect(ranOn).toMatchObject({ kind: "agent", agentId: agent.agentId, name: "maya-laptop" });
        expect(ranOn).not.toHaveProperty("browser");
    });

    it("a browser the protocol does not know is refused with the rest of the result", async () => {
        const app = platform.repo.createApplication(projectId, APP, { ...DEFAULT_JOB_OPTIONS }, undefined);
        const job = await platform.repo.createJob(projectId, app, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] });
        const pending = svc()
            .executorFor({ projectId, jobId: job.id })
            .execute("playwright", { scratchDir: path.join(dataDir, "scratch"), scripts: [{ testId: "WEB-002", filename: "WEB-002.spec.ts", content: "// script" }] }, { run: { baseUrl: APP, headless: true } }, { workers: 1, timeoutMs: 20_000 })
            .catch((e: Error) => e);
        const offer = (await agent.next())!;
        expect((await agent.result(offer.taskId, { ok: true, runs: [passedRun("WEB-002")], browser: { name: "opera", source: "installed" } })).status).toBe(400);
        // The agent can still answer properly.
        expect((await agent.result(offer.taskId, { ok: true, runs: [passedRun("WEB-002")] })).status).toBe(200);
        await pending;
        platform.repo.setJobStatus(job.id, "COMPLETED");
    });
});
