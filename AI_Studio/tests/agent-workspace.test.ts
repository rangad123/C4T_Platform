/**
 * Agent Workspace W1 (.scratch/agent-workspace/SPEC.md, PLAN.md; owner decisions D1–D4): one run = one agent.
 *
 *   - a run started in an agent project with a saved choice carries `agentId`, and its options turn on that agent's switches only
 *     (one test per agent id); the Test Case Generation run stays plan-only, a check agent's run is not (the Workspace has no plan step);
 *   - an agent id that is not chosen is refused (409), an unknown one too (400), and a project of several agents asks which one (400);
 *   - GET /api/projects/:id/workspace: each chosen agent's status, from its own runs and the inputs it misses;
 *   - GET /api/projects/:id/workspace/:agentId/outcome: Test Case Generation answers the case outcome, each other agent its own (W2), and an
 *     agent whose outcome is not built yet answers 501;
 *   - GET /api/projects/:id/workspace/:agentId/runs: that agent's runs only;
 *   - code and mixed projects start runs exactly as before and have no Workspace.
 *
 * Browser-free: node scripts/with-lock.mjs tsc -- npx vitest run tests/agent-workspace.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { startHeartbeat } from "../src/platform/ops/heartbeat.js";
import { DEFAULT_JOB_OPTIONS, type JobOptions } from "../src/platform/repo.js";
import { testingAgentsOf } from "../src/platform/routes/testing-agents.js";
import { buildServer } from "../src/platform/server.js";

const KEY = "agent-workspace-key-5d1e";
const SITE = "http://127.0.0.1:6531";
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
let stopBeat: (() => void) | undefined;

const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, headers: { "x-api-key": KEY }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body } as { status: number; body: any };
};

async function project(name: string, testingModes: Array<"agent" | "code">, agents?: string[]): Promise<string> {
    const pid = platform.repo.createProject({ name, platforms: ["web"], testingModes }).id as string;
    if (agents) await testingAgentsOf(platform).set(pid, agents as never, "test");
    platform.repo.createApplication(pid, SITE, { ...DEFAULT_JOB_OPTIONS });
    return pid;
}
const onlyJob = (pid: string) => {
    const jobs = platform.repo.listJobs(pid);
    expect(jobs).toHaveLength(1);
    return jobs[0]!;
};
/** The switches a job's options turn on, by the catalogue's switch names (testing-agents.ts AGENT_SWITCHES). */
function switchesOn(o: JobOptions): string[] {
    const bag = o as unknown as Record<string, unknown>;
    const on: string[] = [];
    if (o.functionalTests !== false) on.push("functionalTests");
    // A Performance agent run keeps the API target for its speed and load checks only (apiTests false): that is not the API tests switch.
    if (o.targets.includes("api") && o.apiTests !== false) on.push("apiTests");
    if (o.variants?.length) on.push("variants");
    for (const k of ["inputChecks", "contractChecks", "accessibility", "securityChecks", "accessChecks", "visual", "healthChecks", "visionChecks", "performanceChecks", "loadChecks"]) if (bag[k] === true) on.push(k);
    return on.sort();
}

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-agent-ws-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, LLM_PROVIDER: "anthropic", SECRET_KEY: "agent-workspace-secret-0123456789" } as never));
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

describe("a run is one agent's, with that agent's switches only (D1)", () => {
    // From the spec's table and the catalogue's words: what each agent runs, and nothing else.
    const OWN: Record<string, string[]> = {
        "test-generation": ["functionalTests"],
        api: ["apiTests", "contractChecks"],
        accessibility: ["accessibility"],
        security: ["accessChecks", "securityChecks"],
        // Its phone and tablet sizes are on by default (W2c): the run repeats its visual checks on them.
        "responsive-ui": ["variants", "visual"],
        ux: ["healthChecks"],
        performance: ["performanceChecks"],
    };
    const ALL = Object.keys(OWN);

    for (const agentId of ALL) {
        it(`${agentId}: the job says whose it is and turns on only that agent's switches`, async () => {
            const pid = await project(`Shop ${agentId}`, ["agent"], ALL);
            const r = await call("POST", `/api/projects/${pid}/test-generation`, { url: SITE, plan: true, agentId, openApiUrl: `${SITE}/openapi.json` });
            expect(r.status, JSON.stringify(r.body)).toBe(202);
            const job = onlyJob(pid);
            expect(job.options.agentId).toBe(agentId);
            expect(switchesOn(job.options)).toEqual([...OWN[agentId]!].sort());
            // Every run starts from and grows the project's saved knowledge of the application (the shared tree).
            expect(job.options.useMemory).not.toBe(false);
            if (agentId === "test-generation") expect(job.options).toMatchObject({ mode: "generate", planOnly: true });
            else expect(job.options.planOnly).toBeUndefined();
            // The application keeps the run's settings, never whose run it was (a later schedule or Explore again is not that agent's).
            expect(platform.repo.getLatestApplicationPublic(pid)!.config).not.toHaveProperty("agentId");
        });
    }

    it("a performance run keeps the API target for its speed and load checks, without the API tests; API and Test Case Generation runs are as before", async () => {
        const start = async (name: string, agentId: string, extra: Record<string, unknown> = {}) => {
            const pid = await project(name, ["agent"], ALL);
            const r = await call("POST", `/api/projects/${pid}/test-generation`, { url: SITE, agentId, openApiUrl: `${SITE}/openapi.json`, ...extra });
            expect(r.status, JSON.stringify(r.body)).toBe(202);
            return onlyJob(pid).options;
        };
        expect(await start("Speed", "performance", { loadChecks: true })).toMatchObject({ targets: ["web", "api"], apiTests: false, performanceChecks: true, loadChecks: true, contractChecks: false });
        // Asked for the web alone, it stays on the web: the API target is never added.
        const web = await start("Speed web", "performance", { targets: ["web"] });
        expect(web.targets).toEqual(["web"]);
        // The API agent's run and a test case run carry no such option: they run as they did.
        const api = await start("Api as before", "api");
        expect(api.targets).toEqual(["web", "api"]);
        expect(api).not.toHaveProperty("apiTests");
        expect(await start("Cases as before", "test-generation")).not.toHaveProperty("apiTests");
    });

    it("refuses an agent the project did not choose, and an unknown one, and creates no job", async () => {
        const pid = await project("Picky", ["agent"], ["accessibility", "ux"]);
        expect(await call("POST", `/api/projects/${pid}/test-generation`, { url: SITE, agentId: "security" })).toMatchObject({ status: 409, body: { error: "The Security Testing Agent is not one of this project's testing agents. Add it in the project's Settings → General first." } });
        expect((await call("POST", `/api/projects/${pid}/test-generation`, { url: SITE, agentId: "nope" })).status).toBe(400);
        expect((await call("POST", `/api/projects/${pid}/test-generation`, { url: SITE, agentId: "chatbot" })).status).toBe(409);
        expect(platform.repo.listJobs(pid)).toHaveLength(0);
    });

    it("asks which agent runs when several are chosen; one chosen agent, or Test Case Generation among them, is the run's when none is named", async () => {
        const two = await project("Two", ["agent"], ["accessibility", "ux"]);
        expect(await call("POST", `/api/projects/${two}/test-generation`, { url: SITE })).toMatchObject({ status: 400, body: { error: "Choose which testing agent runs: the Accessibility Testing Agent or the UX Testing Agent." } });
        const one = await project("One", ["agent"], ["ux"]);
        expect((await call("POST", `/api/projects/${one}/test-generation`, { url: SITE, plan: true })).status).toBe(202);
        expect(onlyJob(one).options.agentId).toBe("ux");
        // Older callers of a Test Case Generation project (the CLI, MCP, an old link) keep getting a test case run (owner decision Q6).
        const tcg = await project("Cases and more", ["agent"], ["test-generation", "accessibility"]);
        expect((await call("POST", `/api/projects/${tcg}/test-generation`, { url: SITE, plan: false })).status).toBe(202);
        expect(onlyJob(tcg).options).toMatchObject({ agentId: "test-generation", planOnly: true, accessibility: false });
    });

    it("a check agent's run of a Test Case Generation project runs its checks, not a test case run (D1)", async () => {
        const pid = await project("Cases and checks", ["agent"], ["test-generation", "accessibility"]);
        expect((await call("POST", `/api/projects/${pid}/test-generation`, { url: SITE, plan: true, agentId: "accessibility" })).status).toBe(202);
        const job = onlyJob(pid);
        expect(job.options).toMatchObject({ agentId: "accessibility", accessibility: true, functionalTests: false });
        expect(job.options.planOnly).toBeUndefined();
        // Only the agent of the run is asked for what it needs: no address is refused for a check agent, requirements or not.
        const noUrl = await project("No address", ["agent"], ["test-generation", "accessibility"]);
        expect((await call("POST", `/api/projects/${noUrl}/test-generation`, { agentId: "accessibility" })).status).toBe(400);
    });

    it("asks only the run's agent for its inputs: the API agent's missing document refuses its own run, not another agent's", async () => {
        const pid = await project("Api and ux", ["agent"], ["api", "ux"]);
        const refused = await call("POST", `/api/projects/${pid}/test-generation`, { url: SITE, agentId: "api" });
        expect(refused.status).toBe(409);
        expect(refused.body.error).toMatch(/OpenAPI document/);
        expect((await call("POST", `/api/projects/${pid}/test-generation`, { url: SITE, agentId: "ux" })).status).toBe(202);
    });
});

describe("code and mixed projects start runs as before", () => {
    it("a mixed project with a saved choice and a code project: no agent on the job, the usual switches, and no agentId accepted", async () => {
        const mixed = await project("Mixed", ["agent", "code"], ["accessibility", "ux"]);
        expect((await call("POST", `/api/projects/${mixed}/test-generation`, { url: SITE, plan: true })).status).toBe(202);
        const job = onlyJob(mixed);
        expect(job.options.agentId).toBeUndefined();
        expect(job.options).toMatchObject({ planOnly: true, accessibility: true, healthChecks: true });
        const code = await project("Code", ["code"]);
        expect(await call("POST", `/api/projects/${code}/test-generation`, { url: SITE, agentId: "ux" })).toMatchObject({ status: 400 });
        expect((await call("GET", `/api/projects/${code}/workspace`)).body).toEqual({ workspace: false, agents: [] });
        expect((await call("GET", `/api/projects/${mixed}/workspace`)).body).toEqual({ workspace: false, agents: [] });
    });

    it("an agent project with no choice saved (older projects, CLI, MCP) runs as before, with no agent on the job and no Workspace", async () => {
        const old = await project("Old", ["agent"]);
        expect((await call("POST", `/api/projects/${old}/test-generation`, { url: SITE, plan: true })).status).toBe(202);
        expect(onlyJob(old).options.agentId).toBeUndefined();
        expect((await call("GET", `/api/projects/${old}/workspace`)).body.workspace).toBe(false);
    });
});

describe("the Workspace: each agent's status, outcome and runs", () => {
    let pid = "";
    const ids: Record<string, string> = {};
    const appId = () => platform.repo.getLatestApplicationPublic(pid)!.id as string;
    const job = async (agentId: string | undefined, status: Parameters<Platform["repo"]["setJobStatus"]>[1], extra: Partial<JobOptions> = {}, error?: string) => {
        const j = await platform.repo.createJob(pid, appId(), { ...DEFAULT_JOB_OPTIONS, ...(agentId ? { agentId: agentId as never } : {}), ...extra });
        platform.repo.setJobStatus(j.id, status, error);
        return j.id;
    };

    beforeAll(async () => {
        pid = await project("Workspace Store", ["agent"], ["test-generation", "api", "accessibility", "security", "ux", "performance"]);
        // An older test case run (before runs said whose they were) counts as Test Case Generation's; then a newer one, done.
        ids.oldCase = await job(undefined, "COMPLETED", { planOnly: true });
        ids.case = await job("test-generation", "COMPLETED", { planOnly: true });
        ids.a11yOld = await job("accessibility", "COMPLETED");
        ids.a11y = await job("accessibility", "GENERATING");
        ids.security = await job("security", "FAILED", {}, "Cancelled");
        ids.ux = await job("ux", "FAILED", {}, "The browser could not start");
    });

    it("says each chosen agent's status from its own runs and the inputs it misses", async () => {
        const r = await call("GET", `/api/projects/${pid}/workspace`);
        expect(r.status).toBe(200);
        expect(r.body.workspace).toBe(true);
        const by = Object.fromEntries((r.body.agents as any[]).map((a) => [a.id, a]));
        expect(Object.keys(by)).toEqual(["api", "accessibility", "security", "ux", "performance", "test-generation"]);
        expect(by["test-generation"]).toMatchObject({ status: "done", runs: 2, lastRun: { jobId: ids.case } });
        expect(by.accessibility).toMatchObject({ status: "running", runs: 2, lastRun: { jobId: ids.a11y, progress: expect.any(Object) } });
        expect(by.security).toMatchObject({ status: "stopped", lastRun: { jobId: ids.security } });
        expect(by.ux).toMatchObject({ status: "failed", lastRun: { jobId: ids.ux } });
        expect(by.performance).toMatchObject({ status: "not-run", runs: 0, lastRun: null, headline: null });
        // No OpenAPI document saved: the API agent cannot run, said in the words of its refusal.
        expect(by.api).toMatchObject({ status: "needs-input", needs: ["The API Testing Agent needs the API documentation: the address of the OpenAPI document."] });
        expect(by["test-generation"].headline).toEqual(expect.any(String));
        expect(by.accessibility.name).toBe("Accessibility Testing Agent");
    });

    it("a Test Case Generation project with no address and no requirements needs one of them", async () => {
        const bare = platform.repo.createProject({ name: "Bare", platforms: ["web"], testingModes: ["agent"] }).id as string;
        await testingAgentsOf(platform).set(bare, ["test-generation"], "test");
        const tcg = (await call("GET", `/api/projects/${bare}/workspace`)).body.agents[0];
        expect(tcg).toMatchObject({ id: "test-generation", status: "needs-input", needs: ["Add the application's address or a requirements document first."] });
        // A run that is going is said first, even when the agent now misses an input (its document was removed after it started).
        const going = await project("Going", ["agent"], ["api"]);
        const j = await platform.repo.createJob(going, platform.repo.getLatestApplicationPublic(going)!.id as string, { ...DEFAULT_JOB_OPTIONS, agentId: "api" });
        platform.repo.setJobStatus(j.id, "DISCOVERING");
        expect((await call("GET", `/api/projects/${going}/workspace`)).body.agents[0]).toMatchObject({ id: "api", status: "running", needs: [expect.stringContaining("OpenAPI")] });
    });

    it("lists one agent's runs only, newest first; an older test case run is Test Case Generation's", async () => {
        const a11y = await call("GET", `/api/projects/${pid}/workspace/accessibility/runs`);
        expect(a11y.status).toBe(200);
        expect((a11y.body as any[]).map((j) => j.jobId)).toEqual([ids.a11y, ids.a11yOld]);
        const tcg = await call("GET", `/api/projects/${pid}/workspace/test-generation/runs`);
        expect((tcg.body as any[]).map((j) => j.jobId)).toEqual([ids.case, ids.oldCase]);
        expect((tcg.body as any[])[0].agentId).toBe("test-generation");
        expect((await call("GET", `/api/projects/${pid}/workspace/responsive-ui/runs`)).status).toBe(404);
        expect((await call("GET", `/api/projects/${pid}/workspace/nope/runs`)).status).toBe(404);
    });

    it("dispatches the outcome: Test Case Generation's is the case outcome, the Accessibility agent's its own (W2b)", async () => {
        const tcg = await call("GET", `/api/projects/${pid}/workspace/test-generation/outcome`);
        expect(tcg.status).toBe(200);
        expect(tcg.body).toMatchObject({ caseAgent: true, runs: expect.any(Array), tree: expect.any(Array), cases: expect.any(Array) });
        expect(tcg.body.runs.map((r: any) => r.jobId)).toEqual([ids.case, ids.oldCase]);
        const one = await call("GET", `/api/projects/${pid}/workspace/test-generation/outcome?run=${ids.case}`);
        expect(one.status).toBe(200);
        expect(one.body.runs.map((r: any) => r.jobId)).toEqual([ids.case]);
        expect((await call("GET", `/api/projects/${pid}/workspace/test-generation/outcome?run=${ids.a11y}`)).status).toBe(404);
        const a11y = await call("GET", `/api/projects/${pid}/workspace/accessibility/outcome`);
        expect(a11y).toMatchObject({ status: 200, body: { runs: 2, pages: [], rules: [] } });
        expect((await call("GET", `/api/projects/${pid}/workspace/responsive-ui/outcome`)).status).toBe(404);
    });
});
