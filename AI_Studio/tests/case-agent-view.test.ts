/**
 * Test Case Generation projects, one rule on both sides (founder 2026-11-19, SPEC D3 and owner decision Q6; FX12 and FX14):
 *   - FX14: the web reads whether a project is one from the server (GET /api/projects/:id/testing-agents answers `caseAgent`, worked
 *     out by src/platform/case-agent.ts), so the web view, the testing-agents answer, the outcome's `caseAgent` and the server rule
 *     agree on mixed, agent-only TCG, TCG with other agents (Q6), code, other-agent and no-choice projects;
 *   - FX12: in a TCG project that also chose the API Testing Agent, a test case exploration is not refused for the OpenAPI document
 *     (that run is Test Case Generation's, Q6); the agent-inputs answer names the API agent's need as its Workspace card does (D1, a3). An OpenAPI document already saved stays saved.
 *     A project of the API agent alone still misses it and is refused, as before.
 * In-process (app.inject), no browser:  node scripts/with-lock.mjs tsc -- npx vitest run tests/case-agent-view.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { isCaseAgentProject } from "../src/platform/case-agent.js";
import { startHeartbeat } from "../src/platform/ops/heartbeat.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { testingAgentsOf } from "../src/platform/routes/testing-agents.js";
import { buildServer } from "../src/platform/server.js";
import { projectAgentView } from "../web/src/features/testing-agents/case-agent-view.js";

const KEY = "case-agent-view-key-3f91";
const SITE = "http://127.0.0.1:7673";
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
let stopBeat: (() => void) | undefined;

const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, headers: { "x-api-key": KEY }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body } as { status: number; body: any };
};

async function project(name: string, testingModes: string[], agents?: string[]): Promise<string> {
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

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-case-agent-view-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, LLM_PROVIDER: "anthropic", SECRET_KEY: "case-agent-view-secret-0123456789" } as never));
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

describe("the web and the server agree which projects are Test Case Generation projects (FX14)", () => {
    const kinds: Array<[string, string[], string[] | undefined, boolean]> = [
        ["agent-only, Test Case Generation alone", ["agent"], ["test-generation"], true],
        ["agent-only, Test Case Generation with other agents (Q6)", ["agent"], ["test-generation", "api", "accessibility"], true],
        ["mixed (agent and code) with Test Case Generation", ["agent", "code"], ["test-generation"], false],
        ["code", ["code"], undefined, false],
        ["agent-only, other agents", ["agent"], ["accessibility"], false],
        ["agent-only, no choice saved", ["agent"], undefined, false],
    ];
    for (const [name, modes, agents, expected] of kinds) {
        it(`${name}: ${expected}`, async () => {
            const pid = await project(name, modes, agents);
            const server = await isCaseAgentProject(platform.repo, pid);
            const agentsAnswer = (await call("GET", `/api/projects/${pid}/testing-agents`)).body;
            const projectAnswer = (await call("GET", `/api/projects/${pid}`)).body;
            const outcome = (await call("GET", `/api/projects/${pid}/outcome`)).body;
            expect(server).toBe(expected);
            expect(agentsAnswer.caseAgent).toBe(expected);
            expect(outcome.caseAgent).toBe(expected);
            expect(projectAgentView(projectAnswer, agentsAnswer).caseAgent).toBe(expected);
        });
    }

    it("the web follows the server's answer, not its own reading of modes and agents", () => {
        // The answer of an agent-only project that chose the agent, but with the server saying it is not one: the web says not one.
        const agents = { applies: true, agents: ["test-generation"] as never, source: "chosen" as const, switches: {}, caseAgent: false };
        expect(projectAgentView({ testingModes: ["agent"] }, agents).caseAgent).toBe(false);
        expect(projectAgentView({ testingModes: ["agent", "code"] }, { ...agents, caseAgent: true }).caseAgent).toBe(true);
        expect(projectAgentView(undefined, undefined).caseAgent).toBe(false);
    });
});

describe("a Test Case Generation project that also chose the API Testing Agent is not refused a test case run for the OpenAPI document (FX12)", () => {
    it("a test case exploration starts; the API agent's own need is said as its Workspace card says it (one run = one agent, D1; a3)", async () => {
        const pid = await project("Cases and API", ["agent"], ["test-generation", "api"]);
        const inputs = await call("GET", `/api/projects/${pid}/agent-inputs`);
        expect(inputs.status).toBe(200);
        // The API Testing Agent runs on its own from the Workspace, where its card says it needs the document: the Requirements tab says the same.
        expect(inputs.body.missing).toEqual([expect.objectContaining({ agent: "api", input: "openApiUrl" })]);
        const card = (await call("GET", `/api/projects/${pid}/workspace?agent=api`)).body.agents[0];
        expect(card.needs).toEqual([inputs.body.missing[0].text]);
        const started = await call("POST", `/api/projects/${pid}/test-generation`, { url: SITE, plan: true });
        expect(started.status, JSON.stringify(started.body)).toBe(202);
    });

    it("an OpenAPI document saved before stays saved", async () => {
        const pid = await project("Cases and API, saved", ["agent"], ["api"]);
        const saved = await call("PUT", `/api/projects/${pid}/agent-inputs`, { openApiUrl: `${SITE}/openapi.json` });
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        expect((await call("PUT", `/api/projects/${pid}/testing-agents`, { agents: ["test-generation", "api"] })).status).toBe(200);
        const inputs = (await call("GET", `/api/projects/${pid}/agent-inputs`)).body;
        expect(inputs.openApiUrl).toBe(`${SITE}/openapi.json`);
        expect(inputs.missing).toEqual([]);
    });

    it("a project of the API Testing Agent alone still misses it and is refused", async () => {
        const pid = await project("API only", ["agent"], ["api"]);
        const inputs = (await call("GET", `/api/projects/${pid}/agent-inputs`)).body;
        expect(inputs.missing).toEqual([expect.objectContaining({ agent: "api", input: "openApiUrl" })]);
        const started = await call("POST", `/api/projects/${pid}/test-generation`, { url: SITE, plan: true });
        expect(started.status).toBe(409);
        expect(started.body.error).toMatch(/OpenAPI document/);
    });
});
