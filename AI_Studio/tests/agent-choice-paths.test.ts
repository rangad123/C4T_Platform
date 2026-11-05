/**
 * The project's current choice of testing agents on every path that starts an exploration's work, not only the explore form:
 * a scheduled exploration (scheduler.ts), creating tests from a plan (routes/plans.ts) and the engine creating them (orchestrator.ts).
 * A check whose agent was removed since is left out quietly and named in the job's events, never refused. No browser is started:
 * the engine's browser is a stand-in, and the plan has no pages.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startHeartbeat } from "../src/platform/ops/heartbeat.js";
let stopBeat: (() => void) | undefined;

vi.mock("../src/engine/discovery/browser.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/engine/discovery/browser.js")>()),
    launchChromium: async () => ({ close: async () => undefined }),
}));

import { loadConfig } from "../src/config.js";
import type { EngineEvent } from "../src/engine/context.js";
import { createLlmClientOrUnavailable } from "../src/engine/llm/provider.js";
import { runGeneration, type GenerationRequest, type GenerationSink } from "../src/engine/orchestrator.js";
import type { StoredPlan } from "../src/engine/planning/preview.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { PLAN_ARTIFACT } from "../src/platform/plan-store.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import type { Schedule } from "../src/platform/schedule-store.js";
import { startScheduledJob } from "../src/platform/scheduler.js";
import { buildServer } from "../src/platform/server.js";
import { narrowToChoice } from "../src/platform/testing-agents.js";

const KEY = "agent-choice-paths-key-5e1f";
const SITE = "http://127.0.0.1:7730";
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";

const asKey = async (method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as "GET", url, headers: { "x-api-key": KEY }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body } as { status: number; body: any };
};
const IDEAS = ["Browse the products", "Read the about page"].map((title, i) => ScenarioSchema.parse({ scenarioId: `S-${i + 1}`, title, description: title, category: "Browsing", expectedResults: ["It is shown"] }));
const PLAN: StoredPlan = {
    version: 1,
    createdAt: new Date().toISOString(),
    model: { url: SITE, origin: SITE, pages: [], navigation: [], apis: [], authentication: { required: false, mechanisms: [], loggedIn: false }, externalDependencies: [], documentedTestCases: [], stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 1 }, siteType: "ecommerce", purpose: "A shop", features: [], journeys: [] } as never,
    scenarios: IDEAS,
    analysed: true,
    specBaseTrusted: false,
    accessReach: [],
    apiAccess: [],
    warnings: [],
};
const eventsOf = (jobId: string) => platform.db.all<{ kind: string; message: string }>("SELECT kind, message FROM agent_events WHERE job_id = ? ORDER BY id", jobId);

/** A project in agent mode with these agents, and a finished plan-only exploration made while `planned` were on. */
async function projectWithPlan(name: string, agents: string[], planned: Record<string, unknown>) {
    const made = await asKey("POST", "/api/projects", { name, platforms: ["web"], testingModes: ["agent"], agents });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const pid = made.body.id as string;
    const appId = platform.repo.createApplication(pid, SITE, { ...DEFAULT_JOB_OPTIONS });
    const job = await platform.repo.createJob(pid, appId, { ...DEFAULT_JOB_OPTIONS, planOnly: true, targets: ["web"], ...planned });
    platform.repo.setJobStatus(job.id, "COMPLETED");
    const rel = `${pid}/_artifacts/${job.id}/plan.json`;
    const body = JSON.stringify(PLAN);
    await platform.store.put(rel, body);
    platform.repo.addArtifact({ projectId: pid, jobId: job.id, kind: PLAN_ARTIFACT, path: rel, size: body.length });
    return { pid, planJob: job.id };
}

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-agent-paths-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECRET_KEY: "agent-choice-paths-secret-0123456789" } as never));
    // A worker in another process says it is alive, so runs and explorations are queued (and nothing here runs them).
    stopBeat = startHeartbeat(platform.db);
    app = await buildServer(platform);
    await app.ready();
}, 60_000);

afterAll(async () => {
    stopBeat?.();
    await app?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("narrowing to the current choice", () => {
    it("leaves out what no chosen agent owns and names it, instead of refusing", () => {
        const n = narrowToChoice({ targets: ["web", "api"], securityChecks: true, accessibility: true, variants: ["firefox"], functionalTests: true }, ["accessibility"]);
        expect(n.asked).toMatchObject({ targets: ["web"], accessibility: true });
        expect(n.asked.securityChecks).toBeUndefined();
        expect(n.asked.variants).toBeUndefined();
        expect(n.dropped).toEqual(["functionalTests", "apiTests", "securityChecks", "variants"]);
        // followChoice: a chosen agent's check is on whatever the earlier settings said; nothing is dropped that was off.
        const f = narrowToChoice({ accessibility: false, securityChecks: false }, ["accessibility", "test-generation"], { followChoice: true });
        expect(f.asked.accessibility).toBeUndefined();
        expect(f.dropped).toEqual([]);
    });
});

describe("a scheduled exploration", () => {
    it("runs the project's current choice, not only the last exploration's settings", async () => {
        const pid = (await asKey("POST", "/api/projects", { name: "Scheduled", platforms: ["web"], testingModes: ["agent"], agents: ["accessibility"] })).body.id as string;
        platform.repo.createApplication(pid, SITE, { ...DEFAULT_JOB_OPTIONS, targets: ["web"], accessibility: false, securityChecks: true, performanceChecks: true, functionalTests: false });
        const job = await startScheduledJob(platform.repo, { id: "sched-agent-paths", projectId: pid, kind: "generate", retryFailures: 0 } as unknown as Schedule);
        const o = platform.repo.getJob(job.id)!.options;
        expect(o).toMatchObject({ mode: "generate", accessibility: true, securityChecks: false, functionalTests: false, loadChecks: false, trigger: "schedule" });
        expect(o.performanceChecks).toBeUndefined();
        const note = eventsOf(job.id).find((e) => e.kind === "agent_checks_dropped");
        expect(note?.message).toMatch(/Basic security checks.*Page speed checks/);
    });
});

describe("creating tests from a plan", () => {
    it("leaves out a check whose agent was removed since the plan, and says so in the job's events", async () => {
        const { pid, planJob } = await projectWithPlan("Planned", ["security", "test-generation"], { securityChecks: true, accessChecks: true, functionalTests: true });
        expect((await asKey("PUT", `/api/projects/${pid}/testing-agents`, { agents: ["accessibility", "test-generation"] })).status).toBe(200);
        const r = await asKey("POST", `/api/projects/${pid}/plans/${planJob}/create`, {});
        expect(r.status, JSON.stringify(r.body)).toBe(202);
        const o = platform.repo.getJob(r.body.jobId)!.options;
        expect(o).toMatchObject({ fromPlan: planJob, securityChecks: false, accessChecks: false, accessibility: true, functionalTests: true, targets: ["web"] });
        expect(eventsOf(r.body.jobId).find((e) => e.kind === "agent_checks_dropped")?.message).toMatch(/Basic security checks, Access checks/);
    });

    it("counts no journeys without the Test Case Generation Agent, and says why when nothing is left", async () => {
        const { pid, planJob } = await projectWithPlan("Journeys only", ["test-generation"], { functionalTests: true });
        expect((await asKey("PUT", `/api/projects/${pid}/testing-agents`, { agents: ["accessibility"] })).status).toBe(200);
        const r = await asKey("POST", `/api/projects/${pid}/plans/${planJob}/create`, {});
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/Nothing is left to create.*Functional test cases/);
    });
});

describe("the engine creating tests from a plan", () => {
    it("creates none of the plan's journeys when functional test cases are off", async () => {
        const events: EngineEvent[] = [];
        const created: unknown[] = [];
        let keys = 0;
        const sink = new Proxy({} as GenerationSink, {
            get: (_t, k) => {
                if (k === "then" || k === "loadMemory" || k === "saveMemory" || k === "restoreTest" || k === "rememberPhone") return undefined;
                if (k === "agentAction") return () => undefined;
                return async (...args: unknown[]) => {
                    if (k === "createTest") created.push(args[0]);
                    if (k === "nextTestKey") return `${String(args[0])}-${String(++keys).padStart(3, "0")}`;
                    if (k === "createTest") return { id: `t${created.length}`, testId: `T-${created.length}` };
                    if (k === "startAgentRun") return "run-1";
                    if (k === "loadBaselines") return [];
                    return undefined;
                };
            },
        });
        const cfg = loadConfig({ DATA_DIR: dir, SECRET_KEY: "agent-choice-paths-secret-0123456789" } as never);
        const req = { url: SITE, maxPages: 5, maxDepth: 1, maxScenarios: 5, targets: ["web"], allowMutatingApiTests: false, plan: PLAN, functionalTests: false, useMemory: false, securityChecks: false, healthChecks: false, accessibility: false, accessChecks: false, inputChecks: false, contractChecks: false } as unknown as GenerationRequest;
        await runGeneration({ config: cfg, llm: createLlmClientOrUnavailable(cfg), emit: (e) => events.push(e) }, req, sink);
        expect(events.find((e) => e.kind === "functional_tests_off")?.message).toMatch(/2 test idea/);
        expect(created).toEqual([]);
    });
});
