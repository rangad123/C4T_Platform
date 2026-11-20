/**
 * A Test Case Generation project (SPEC D3, owner decisions Q4 and Q6: agent mode only, and its chosen agents include
 * test-generation) explores plan-only and makes no test scripts and runs no tests (src/platform/case-agent.ts).
 *
 *   - every path that starts an exploration makes it plan-only: the explore route (even with plan: false or runTestCases), a
 *     scheduled "Explore again" and a runbook's analyze step;
 *   - every path that makes test scripts or runs tests refuses with a 409 and a sentence, and creates no job: creating tests from a
 *     plan, the Run route, a test's own run, an environment run, other browsers, the CI validation, a described test, a hand-written
 *     test, importing specs, a validate schedule, a deploy trigger, a suite run, an agent run, a runbook's run step, and the
 *     scripts made from test cases;
 *   - old test scripts saved in such a project stay readable;
 *   - mixed projects, and agent projects without the Test Case Generation agent, behave as before.
 * A last part runs a real plan-only exploration of a local fixture site with a scripted model: no tests, no run jobs, no runner tasks.
 *
 * Run under the browser lock (the last part starts a browser):
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/case-agent-plan-only.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import type { StoredPlan } from "../src/engine/planning/preview.js";
import { ScenarioSchema, TestSpecSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CASE_AGENT_PLAN_REFUSED, CASE_AGENT_RUN_REFUSED, isCaseAgentProject } from "../src/platform/case-agent.js";
import { startHeartbeat } from "../src/platform/ops/heartbeat.js";
import { PLAN_ARTIFACT } from "../src/platform/plan-store.js";
import { testingAgentsOf } from "../src/platform/routes/testing-agents.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { startMemorySite, type MemorySite } from "./fixtures/memory-site.js";

const KEY = "case-agent-plan-only-key-71c2";
const PORT = 6497;
const SITE = `http://127.0.0.1:${PORT}`;
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
let site: MemorySite;
let stopBeat: (() => void) | undefined;
let worker: Worker | undefined;

const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, key = true) => {
    const r = await app.inject({ method, url, headers: key ? { "x-api-key": KEY } : {}, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body } as { status: number; body: any };
};
const jobsOf = (pid: string) => platform.repo.listJobs(pid);
/** Finish a queued job here (no worker runs in the first parts), so the next start is not refused as "still running". */
const settle = (jobId: string) => platform.repo.setJobStatus(jobId, "COMPLETED");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function project(name: string, testingModes: string[], agents?: string[]) {
    let pid: string;
    if (testingModes.length > 1) {
        // A mixed project (agent and code, as older projects are) cannot be made through the API any more.
        pid = platform.repo.createProject({ name, platforms: ["web"], testingModes: testingModes as never }).id as string;
        if (agents) await testingAgentsOf(platform).set(pid, agents as never, "test");
    } else {
        const made = await call("POST", "/api/projects", { name, platforms: ["web"], testingModes, ...(agents ? { agents } : {}) });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        pid = made.body.id as string;
    }
    platform.repo.createApplication(pid, SITE, { ...DEFAULT_JOB_OPTIONS });
    return pid;
}
/** An old WEB test saved before the project became a Test Case Generation project. */
function oldTest(pid: string): string {
    const spec = TestSpecSchema.parse({ testId: "WEB-001", title: "Open the home page", kind: "web", category: "Browsing", priority: "medium", steps: [{ action: "navigate", url: "/" }] });
    const suite = platform.repo.getOrCreateSuite(pid, "Web", "web");
    return platform.repo.insertTest({ projectId: pid, suiteId: suite, jobId: null, spec, framework: "playwright", validationStatus: "PENDING" });
}
const PLAN: StoredPlan = {
    version: 1,
    createdAt: new Date().toISOString(),
    model: { url: SITE, origin: SITE, pages: [], navigation: [], apis: [], authentication: { required: false, mechanisms: [], loggedIn: false }, externalDependencies: [], documentedTestCases: [], stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 1 }, siteType: "ecommerce", purpose: "A shop", features: [], journeys: [] } as never,
    scenarios: [ScenarioSchema.parse({ scenarioId: "S-1", title: "Browse the products", description: "Browse the products", category: "Browsing", expectedResults: ["They are shown"] })],
    analysed: true,
    specBaseTrusted: false,
    accessReach: [],
    apiAccess: [],
    warnings: [],
};
async function finishedPlan(pid: string): Promise<string> {
    const appId = platform.repo.getLatestApplicationPublic(pid)!.id as string;
    const job = await platform.repo.createJob(pid, appId, { ...DEFAULT_JOB_OPTIONS, planOnly: true, targets: ["web"], functionalTests: true });
    settle(job.id);
    const rel = `${pid}/_artifacts/${job.id}/plan.json`;
    const body = JSON.stringify(PLAN);
    await platform.store.put(rel, body);
    platform.repo.addArtifact({ projectId: pid, jobId: job.id, kind: PLAN_ARTIFACT, path: rel, size: body.length });
    return job.id;
}
async function runbookRun(pid: string, steps: unknown[]): Promise<string> {
    const made = await call("POST", `/api/projects/${pid}/runbooks`, { version: 1, name: `Book ${Math.random()}`, steps });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const started = await call("POST", `/api/projects/${pid}/runbooks/${made.body.id}/run`);
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    return started.body.runId as string;
}
async function runbookUntil(pid: string, runId: string, done: (run: any) => boolean): Promise<any> {
    for (let i = 0; i < 400; i++) {
        const run = (await call("GET", `/api/projects/${pid}/runbook-runs/${runId}`)).body;
        if (done(run)) return run;
        await sleep(100);
    }
    throw new Error("the runbook run did not get there");
}

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = await startMemorySite(PORT);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-case-agent-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, LLM_PROVIDER: "anthropic", CONCURRENCY: "1", MAX_REPAIR_ATTEMPTS: "1", SECRET_KEY: "case-agent-plan-only-secret-0123456789" } as never));
    // A worker in another process says it is alive, so runs are not refused for that reason (nothing runs them until the last part).
    stopBeat = startHeartbeat(platform.db);
    app = await buildServer(platform);
    await app.ready();
}, 60_000);

afterAll(async () => {
    await worker?.stop();
    stopBeat?.();
    await app?.close();
    platform?.db.close();
    site?.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("which projects are Test Case Generation projects", () => {
    it("agent mode with test-generation, alone or with other agents; never a mixed or code project, nor one without it", async () => {
        expect(await isCaseAgentProject(platform.repo, await project("TCG only", ["agent"], ["test-generation"]))).toBe(true);
        expect(await isCaseAgentProject(platform.repo, await project("TCG and more", ["agent"], ["test-generation", "accessibility"]))).toBe(true);
        expect(await isCaseAgentProject(platform.repo, await project("Mixed with TCG", ["agent", "code"], ["test-generation"]))).toBe(false);
        expect(await isCaseAgentProject(platform.repo, await project("Accessibility only", ["agent"], ["accessibility"]))).toBe(false);
        expect(await isCaseAgentProject(platform.repo, await project("No choice saved", ["agent"]))).toBe(false);
        expect(await isCaseAgentProject(platform.repo, await project("Code", ["code"]))).toBe(false);
        expect(await isCaseAgentProject(platform.repo, "no-such-project")).toBe(false);
    });
});

describe("every exploration of a Test Case Generation project is plan-only", () => {
    it("the explore route, even when the body asks plan: false or to run the test cases", async () => {
        for (const agents of [["test-generation"], ["test-generation", "accessibility"]]) {
            const pid = await project(`Explore ${agents.join("+")}`, ["agent"], agents);
            for (const body of [{ url: SITE }, { url: SITE, plan: false }, { url: SITE, plan: false, runTestCases: true }]) {
                const r = await call("POST", `/api/projects/${pid}/test-generation`, body);
                expect(r.status, JSON.stringify(r.body)).toBe(202);
                expect(r.body.plan).toBe(true);
                const o = platform.repo.getJob(r.body.jobId)!.options;
                expect(o.planOnly).toBe(true);
                expect(o.runTestCases).toBeUndefined();
                expect(o.fromPlan).toBeUndefined();
                settle(r.body.jobId);
            }
        }
    });

    it("leaves other projects' explorations as they were", async () => {
        for (const [name, modes, agents] of [["Mixed explore", ["agent", "code"], ["test-generation"]], ["A11y explore", ["agent"], ["accessibility"]]] as const) {
            const pid = await project(name, [...modes], [...agents]);
            const full = await call("POST", `/api/projects/${pid}/test-generation`, { url: SITE });
            expect(full.status, JSON.stringify(full.body)).toBe(202);
            expect(full.body.plan).toBeUndefined();
            expect(platform.repo.getJob(full.body.jobId)!.options.planOnly).toBeUndefined();
            settle(full.body.jobId);
            const plan = await call("POST", `/api/projects/${pid}/test-generation`, { url: SITE, plan: true });
            expect(plan.body.plan).toBe(true);
            expect(platform.repo.getJob(plan.body.jobId)!.options.planOnly).toBe(true);
            settle(plan.body.jobId);
        }
    });

    it("a scheduled Explore again, even when the saved settings were a full exploration", async () => {
        const pid = await project("Scheduled explore", ["agent"], ["test-generation"]);
        const made = await call("POST", `/api/projects/${pid}/schedules`, { kind: "generate", cadence: { type: "daily", time: "03:00" }, enabled: false });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        const r = await call("POST", `/api/projects/${pid}/schedules/${made.body.id}/run`);
        expect(r.status, JSON.stringify(r.body)).toBe(202);
        const o = platform.repo.getJob(r.body.jobId)!.options;
        expect(o).toMatchObject({ mode: "generate", planOnly: true, trigger: "schedule" });
        expect(o.runTestCases).toBeUndefined();
        settle(r.body.jobId);
    });

    it("a runbook's analyze step", async () => {
        const pid = await project("Runbook explore", ["agent"], ["test-generation"]);
        const runId = await runbookRun(pid, [{ id: "a", type: "analyze" }]);
        const run = await runbookUntil(pid, runId, (r) => Boolean(r.steps?.[0]?.jobId) || r.finished);
        const jobId = run.steps[0].jobId as string;
        expect(platform.repo.getJob(jobId)!.options).toMatchObject({ mode: "generate", planOnly: true });
        platform.repo.setJobStatus(jobId, "FAILED", "Cancelled");
        await runbookUntil(pid, runId, (r) => r.finished);
    });
});

describe("making test scripts or running tests in a Test Case Generation project is refused", () => {
    let pid = "";
    let testId = "";
    beforeAll(async () => {
        pid = await project("Refusals", ["agent"], ["test-generation", "accessibility"]);
        testId = oldTest(pid);
    });

    it("refuses each start with a 409 and its sentence, and queues nothing", async () => {
        const planJob = await finishedPlan(pid);
        const schedule = (await call("POST", `/api/projects/${pid}/schedules`, { kind: "validate", cadence: { type: "daily", time: "04:00" }, enabled: false })).body.id as string;
        const suite = await call("POST", `/api/projects/${pid}/test-suites`, { name: "Smoke", testIds: [testId] });
        expect(suite.status, JSON.stringify(suite.body)).toBe(201);
        const token = (await call("POST", `/api/projects/${pid}/triggers`, { label: "CI" })).body.token as string;
        expect(token).toBeTruthy();
        const before = jobsOf(pid).length;
        const tests = platform.repo.listTests(pid).length;
        const refused: Array<[string, string, unknown, string, boolean?]> = [
            ["create from a plan", `/api/projects/${pid}/plans/${planJob}/create`, {}, CASE_AGENT_PLAN_REFUSED],
            ["the Run route", `/api/projects/${pid}/runs`, {}, CASE_AGENT_RUN_REFUSED],
            ["a test's own run", `/api/tests/${testId}/validate`, {}, CASE_AGENT_RUN_REFUSED],
            ["an environment run", `/api/projects/${pid}/environments/staging/runs`, {}, CASE_AGENT_RUN_REFUSED],
            ["other browsers", `/api/projects/${pid}/variants`, { variants: ["firefox"] }, CASE_AGENT_RUN_REFUSED],
            ["the CI validation", `/api/projects/${pid}/validation`, {}, CASE_AGENT_RUN_REFUSED],
            ["a described test", `/api/projects/${pid}/plain-tests`, { description: "Open the home page and check the title" }, CASE_AGENT_PLAN_REFUSED],
            ["a hand-written test", `/api/projects/${pid}/custom-tests`, { title: "Hand made", kind: "web", content: "test('x', async () => {});" }, CASE_AGENT_PLAN_REFUSED],
            ["importing specs", `/api/projects/${pid}/specs`, { specs: [{ title: "Imported", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/api/x" }, { action: "assertResponse", check: "status", expected: 200 }] }] }, CASE_AGENT_PLAN_REFUSED],
            ["a validate schedule's Run now", `/api/projects/${pid}/schedules/${schedule}/run`, undefined, CASE_AGENT_RUN_REFUSED],
            ["a suite run", `/api/projects/${pid}/test-suites/${suite.body.id}/run`, {}, CASE_AGENT_RUN_REFUSED],
            ["an agent run", `/api/projects/${pid}/agent-runs`, { objective: "A customer can reach the shop" }, CASE_AGENT_RUN_REFUSED],
            ["a deploy trigger", `/api/triggers/${token}/run`, {}, CASE_AGENT_RUN_REFUSED, false],
        ];
        for (const [what, url, body, message, key] of refused) {
            const r = await call("POST", url, body, key ?? true);
            expect({ what, status: r.status, error: r.body?.error }).toEqual({ what, status: 409, error: message });
        }
        expect(jobsOf(pid).length).toBe(before);
        expect(platform.repo.listTests(pid).length).toBe(tests);
        // Scripts from test cases were already for code projects only; still refused here.
        const cases = await call("POST", `/api/projects/${pid}/manual-cases/generate-scripts`, {});
        expect(cases.status).toBe(409);
        expect(jobsOf(pid).length).toBe(before);
    });

    it("a runbook's run step fails with the sentence and starts no job", async () => {
        const before = jobsOf(pid).length;
        const runId = await runbookRun(pid, [{ id: "r", type: "run", scope: "all", retries: 0 }]);
        const done = await runbookUntil(pid, runId, (r) => r.finished);
        expect(done.steps[0]).toMatchObject({ status: "failed", reason: CASE_AGENT_RUN_REFUSED });
        expect(jobsOf(pid).length).toBe(before);
    });

    it("keeps the old test scripts readable", async () => {
        const r = await call("GET", `/api/tests/${testId}`);
        expect(r.status).toBe(200);
        expect(r.body.spec.title).toBe("Open the home page");
        expect((await call("GET", `/api/projects/${pid}/tests`)).body.map((t: { id: string }) => t.id)).toContain(testId);
    });

    it("a mixed project still runs and creates as before", async () => {
        const mixed = await project("Mixed refusals", ["agent", "code"], ["test-generation"]);
        const t = oldTest(mixed);
        const run = await call("POST", `/api/projects/${mixed}/runs`, { testIds: [t] });
        expect(run.status, JSON.stringify(run.body)).toBe(202);
        settle(run.body.jobId);
        const own = await call("POST", `/api/tests/${t}/validate`, {});
        expect(own.status, JSON.stringify(own.body)).toBe(202);
        settle(own.body.jobId);
        const planJob = await finishedPlan(mixed);
        const created = await call("POST", `/api/projects/${mixed}/plans/${planJob}/create`, {});
        expect(created.status, JSON.stringify(created.body)).toBe(202);
        expect(platform.repo.getJob(created.body.jobId)!.options.fromPlan).toBe(planJob);
        settle(created.body.jobId);
    });
});

// ── a real plan-only exploration, with a scripted model (no paid AI) ─────────

const toolQueue: Array<{ tool: string; input: Record<string, unknown> }> = [];
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const model = new MockLanguageModelV3({
    doGenerate: async () => {
        const next = toolQueue.shift();
        if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
        return { content: [{ type: "tool-call" as const, toolCallId: `c${Math.random()}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
    },
});
const IDEAS = [
    { title: "Browse the product list", journey: "Browse products", startPath: "/products", heading: "Products" },
    { title: "Read the about page", journey: "Read about us", startPath: "/about", heading: "About us" },
] as const;
const scripted: LlmClient = {
    modelName: "scripted",
    model,
    usage: { inputTokens: 0, outputTokens: 0 },
    text: async () => "",
    object: (async ({ system, prompt }: { system: string; prompt: string }) => {
        if (prompt.includes("Already covered by the plan")) return { scenarios: [] };
        if (/list what they state about its intended behaviour/.test(system)) return { rules: [], workflows: [], roles: [], transitions: [], entities: [] };
        if (/analysing a web application/.test(system)) {
            return {
                siteType: "ecommerce",
                purpose: "A small shop",
                features: ["Browse products"],
                pagePurposes: [],
                journeys: [
                    { name: "Browse products", description: "Look at products", steps: ["Open products"], priority: "high", pages: ["/", "/products"], requiresAuth: false },
                    { name: "Read about us", description: "Read the about page", steps: ["Open about"], priority: "low", pages: ["/about"], requiresAuth: false },
                ],
                authenticationMechanisms: [],
            };
        }
        return { scenarios: IDEAS.map((s) => ScenarioSchema.omit({ scenarioId: true }).parse({ title: s.title, description: s.title, category: "Browsing", priority: "high", journey: s.journey, startPath: s.startPath, expectedResults: [`${s.heading} is shown`] })) };
    }) as LlmClient["object"],
};

describe("a full exploration of a Test Case Generation project", () => {
    it("plans its test cases, and creates no test, no run job and no runner task", async () => {
        const pid = await project("Full run", ["agent"], ["test-generation"]);
        worker = new Worker({ ...platform, makeLlm: () => scripted }, 100);
        worker.start();
        const r = await call("POST", `/api/projects/${pid}/test-generation`, { url: SITE, maxPages: 10, targets: ["web"], plan: false });
        expect(r.status, JSON.stringify(r.body)).toBe(202);
        let job: any;
        for (let i = 0; i < 600; i++) {
            job = (await call("GET", `/api/test-generation/${r.body.jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) break;
            await sleep(500);
        }
        expect(job.status, JSON.stringify(job)).toBe("COMPLETED");
        const events = (await call("GET", `/api/test-generation/${r.body.jobId}/events`)).body as Array<{ kind: string; message: string }>;
        expect(events.filter((e) => e.kind === "scenario_planned").length).toBe(IDEAS.length);
        expect(platform.repo.listTests(pid)).toEqual([]);
        expect(jobsOf(pid).filter((j) => (j.options.mode ?? "generate") !== "generate" || j.options.fromPlan)).toEqual([]);
        expect(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_tasks WHERE project_id = ?", pid)!.n).toBe(0);
        expect(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM test_executions e JOIN test_cases t ON t.id = e.test_case_id WHERE t.project_id = ?", pid)!.n).toBe(0);
        // The plan's "Create the tests" is refused afterwards too.
        const create = await call("POST", `/api/projects/${pid}/plans/${r.body.jobId}/create`, {});
        expect(create.status).toBe(409);
        expect(create.body.error).toBe(CASE_AGENT_PLAN_REFUSED);
    }, 300_000);
});
