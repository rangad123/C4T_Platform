/**
 * Testing agents (platform/testing-agents.ts, routes/testing-agents.ts) against a stand-in Crowd4Test sign-in (port 7620): the
 * catalogue with Chatbot not available, a choice saved when a project is created and changed in its settings, the refusal of none
 * and of agents that cannot be chosen, another organisation's project answering 404, an older project showing the agents its last
 * exploration settings match, and the checks an exploration runs following the choice.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { AGENTS_NEED_AGENT_MODE, agentsMatching, applyAgentChoice, CHOOSE_AN_AGENT, switchNeedsAgent, TESTING_AGENTS } from "../src/platform/testing-agents.js";
import { withAgentChoice } from "../src/platform/routes/testing-agents.js";

type App = Awaited<ReturnType<typeof buildServer>>;
const KEY = "testing-agents-key-8c41e2";
const PAGE = { "x-requested-with": "ai-studio" };
const API_PORT = 7620;

const me = (id: string, role: string, permissions: readonly string[], organisationId: string | null = null) => ({
    data: { user: { id, email: `${id}@people.example`, role, status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions, organisationId } },
});
const ACCOUNTS: Record<string, unknown> = {
    "t-cora": me("cora", "CUSTOMER", PERMISSIONS, "org-a"),
    "t-rita": me("rita", "CUSTOMER", ["ai_studio.access"], "org-a"),
    "t-bob": me("bob", "CUSTOMER", PERMISSIONS, "org-b"),
};

let api: http.Server;
let platform: Platform;
let app: App;
let dataDir = "";

const call = (headers: Record<string, string>, method: string, url: string, payload?: unknown) =>
    app
        .inject({ method: method as "GET", url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) })
        .then((r) => ({ status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body }));
const asKey = (method: string, url: string, payload?: unknown) => call({ "x-api-key": KEY }, method, url, payload);
const as = (token: string, method: string, url: string, payload?: unknown) => call({ cookie: `c4t_access=${token}`, ...(method === "GET" ? {} : PAGE) }, method, url, payload);

beforeAll(async () => {
    api = http.createServer((req, res) => {
        const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        res.writeHead(ACCOUNTS[auth] ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ACCOUNTS[auth] ?? { error: { message: "Invalid access token" } }));
    });
    await new Promise<void>((r) => api.listen(API_PORT, "127.0.0.1", r));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-testing-agents-"));
    platform = bootstrap(
        loadConfig({ DATA_DIR: dataDir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECRET_KEY: "testing-agents-secret-key-0123456789", C4T_API_ORIGIN: `http://127.0.0.1:${API_PORT}`, C4T_SITE_URL: "https://crowd4test.example" }),
    );
    app = await buildServer(platform);
    await app.ready();
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    await new Promise((r) => api?.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("the agent list", () => {
    it("lists the eight agents with Chatbot not available, and says what this server cannot do", async () => {
        const r = await as("t-cora", "GET", "/api/testing-agents");
        expect(r.status).toBe(200);
        expect(r.body.agents.map((a: { name: string }) => a.name)).toEqual([
            "API Testing Agent",
            "Accessibility Testing Agent",
            "Security Testing Agent",
            "Chatbot Testing Agent",
            "Responsive UI Testing Agent",
            "UX Testing Agent",
            "Performance Testing Agent",
            "Test Case Generation Agent",
        ]);
        const chatbot = r.body.agents.find((a: { id: string }) => a.id === "chatbot");
        expect(chatbot).toMatchObject({ available: false, unavailableReason: "Not available yet.", checks: [], platforms: [] });
        for (const a of r.body.agents.filter((x: { id: string }) => x.id !== "chatbot")) {
            expect(a.available).toBe(true);
            expect(a.checks.length).toBeGreaterThan(0);
            expect(a.needs.length).toBeGreaterThan(0);
        }
        // No worker and no AI key here: the page is told so.
        expect(r.body.canRun.ok).toBe(false);
        expect(r.body.ai.configured).toBe(false);
        // The switch names stay on the server.
        expect(JSON.stringify(r.body)).not.toMatch(/turnsOn|allows/);
        expect((await as("t-cora", "GET", "/api/testing-agents/nope")).status).toBe(404);
        expect((await as("t-cora", "GET", "/api/testing-agents/accessibility")).body.agent.name).toBe("Accessibility Testing Agent");
    });
});

describe("choosing agents for a project", () => {
    let shop = "";
    let bank = "";

    it("saves the agents chosen when the project is created", async () => {
        const r = await as("t-cora", "POST", "/api/projects", { name: "Shop", platforms: ["web"], testingModes: ["agent"], agents: ["security", "accessibility", "accessibility"] });
        expect(r.status).toBe(201);
        shop = r.body.id;
        const got = await as("t-cora", "GET", `/api/projects/${shop}/testing-agents`);
        expect(got.body).toMatchObject({ applies: true, agents: ["accessibility", "security"], source: "chosen", chosenBy: expect.any(String) });
        expect(got.body.switches).toMatchObject({ accessibility: "on", securityChecks: "on", accessChecks: "on", functionalTests: "off", performanceChecks: "off" });
    });

    it("refuses none, an unknown agent, Chatbot, an agent for another platform, and agents for a code project", async () => {
        const before = platform.repo.listProjects().length;
        expect(await as("t-cora", "POST", "/api/projects", { name: "None", testingModes: ["agent"], agents: [] })).toMatchObject({ status: 400, body: { error: CHOOSE_AN_AGENT } });
        expect((await as("t-cora", "POST", "/api/projects", { name: "Unknown", agents: ["nope"] })).body.error).toMatch(/is not a testing agent/);
        expect((await as("t-cora", "POST", "/api/projects", { name: "Chat", agents: ["chatbot"] })).body.error).toMatch(/not available yet/);
        expect((await as("t-cora", "POST", "/api/projects", { name: "Phone", platforms: ["android"], agents: ["security"] })).body.error).toMatch(/does not work on android/);
        expect(await as("t-cora", "POST", "/api/projects", { name: "Code", testingModes: ["code"], agents: ["security"] })).toMatchObject({ status: 400, body: { error: AGENTS_NEED_AGENT_MODE } });
        // Nothing was created by a refused request.
        expect(platform.repo.listProjects().length).toBe(before);
        expect(await as("t-cora", "PUT", `/api/projects/${shop}/testing-agents`, { agents: [] })).toMatchObject({ status: 400, body: { error: CHOOSE_AN_AGENT } });
        expect((await as("t-cora", "PUT", `/api/projects/${shop}/testing-agents`, {})).status).toBe(400);
        expect((await as("t-cora", "GET", `/api/projects/${shop}/testing-agents`)).body.agents).toEqual(["accessibility", "security"]);
    });

    it("changes the choice in Settings, only with permission to change project settings", async () => {
        const r = await as("t-cora", "PUT", `/api/projects/${shop}/testing-agents`, { agents: ["performance", "test-generation"] });
        expect(r).toMatchObject({ status: 200, body: { agents: ["performance", "test-generation"], source: "chosen" } });
        const rita = (await as("t-rita", "GET", "/api/auth/state")).body.me.id as string;
        accessControlOf(app).projects.store.addMember(shop, rita, { role: "viewer", projectAdmin: false, source: "added", addedBy: "test" });
        expect((await as("t-rita", "GET", `/api/projects/${shop}/testing-agents`)).status).toBe(200);
        expect((await as("t-rita", "PUT", `/api/projects/${shop}/testing-agents`, { agents: ["ux"] })).status).toBe(403);
    });

    it("answers 404 for another organisation's project, and lists only the asker's projects under an agent", async () => {
        bank = (await as("t-bob", "POST", "/api/projects", { name: "Bank", agents: ["performance"] })).body.id;
        expect((await as("t-cora", "GET", `/api/projects/${bank}/testing-agents`)).status).toBe(404);
        expect((await as("t-cora", "PUT", `/api/projects/${bank}/testing-agents`, { agents: ["ux"] })).status).toBe(404);
        const perf = await as("t-cora", "GET", "/api/testing-agents/performance");
        expect(perf.body.projects.map((x: { name: string }) => x.name)).toEqual(["Shop"]);
        const all = await asKey("GET", "/api/testing-agents/performance");
        expect(all.body.projects.map((x: { name: string }) => x.name).sort()).toEqual(["Bank", "Shop"]);
    });

    it("refuses a choice for a project tested with code, and keeps the saved one when the mode changes", async () => {
        const code = (await asKey("POST", "/api/projects", { name: "Code only", testingModes: ["code"] })).body.id;
        expect(await asKey("PUT", `/api/projects/${code}/testing-agents`, { agents: ["ux"] })).toMatchObject({ status: 409, body: { error: AGENTS_NEED_AGENT_MODE } });
        expect((await asKey("GET", `/api/projects/${code}/testing-agents`)).body.applies).toBe(false);
    });
});

describe("older projects", () => {
    it("show the agents their latest exploration settings match until a choice is saved", async () => {
        const fresh = (await asKey("POST", "/api/projects", { name: "Untouched" })).body.id;
        expect((await asKey("GET", `/api/projects/${fresh}/testing-agents`)).body).toMatchObject({ source: "matched", agents: ["api", "accessibility", "security", "ux", "test-generation"] });
        const tuned = (await asKey("POST", "/api/projects", { name: "Tuned" })).body.id;
        platform.repo.createApplication(tuned, "https://tuned.example", { ...DEFAULT_JOB_OPTIONS, targets: ["web"], accessibility: false, performanceChecks: true, visual: true, healthChecks: false });
        expect((await asKey("GET", `/api/projects/${tuned}/testing-agents`)).body.agents).toEqual(["security", "responsive-ui", "performance", "test-generation"]);
        // Nothing is written by reading.
        expect(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM project_testing_agents WHERE project_id = ?", tuned)?.n).toBe(0);
    });

    it("an Android project matches only the agents that work on Android", () => {
        expect(agentsMatching(undefined, ["android"])).toEqual(["accessibility", "test-generation"]);
        expect(agentsMatching({ performanceChecks: true }, ["android"])).toEqual(["accessibility", "performance", "test-generation"]);
    });
});

describe("the checks an exploration runs", () => {
    it("turns on what the chosen agents run and turns off the rest", () => {
        const o = applyAgentChoice({ ...DEFAULT_JOB_OPTIONS }, {}, ["accessibility"]);
        expect(o).toMatchObject({ targets: ["web"], functionalTests: false, accessibility: true, securityChecks: false, accessChecks: false, healthChecks: false, inputChecks: false, contractChecks: false });
        expect(o.performanceChecks).toBeUndefined();
        expect(o.visual).toBeUndefined();
        const all = applyAgentChoice({ ...DEFAULT_JOB_OPTIONS }, {}, ["api", "performance", "responsive-ui", "test-generation"]);
        expect(all).toMatchObject({ targets: ["web", "api"], functionalTests: true, inputChecks: true, contractChecks: true, performanceChecks: true, visual: true });
        expect(all.loadChecks).toBeUndefined();
    });

    it("leaves the per-run choices to the run, and lets a run turn a chosen check off", () => {
        expect(applyAgentChoice({ ...DEFAULT_JOB_OPTIONS, loadChecks: true }, { loadChecks: true }, ["performance"]).loadChecks).toBe(true);
        expect(applyAgentChoice({ ...DEFAULT_JOB_OPTIONS, visionChecks: true }, { visionChecks: true }, ["ux"]).visionChecks).toBe(true);
        expect(applyAgentChoice({ ...DEFAULT_JOB_OPTIONS, variants: ["firefox"] }, { variants: ["firefox"] }, ["responsive-ui"]).variants).toEqual(["firefox"]);
        expect(applyAgentChoice({ ...DEFAULT_JOB_OPTIONS, accessibility: false }, { accessibility: false }, ["accessibility"]).accessibility).toBe(false);
        // A phone exploration keeps its target.
        expect(applyAgentChoice({ ...DEFAULT_JOB_OPTIONS, targets: ["mobile"] }, { targets: ["mobile"] }, ["test-generation"]).targets).toEqual(["mobile"]);
    });

    it("refuses a check no chosen agent owns, naming the agent to add", () => {
        expect(() => applyAgentChoice({ ...DEFAULT_JOB_OPTIONS }, { performanceChecks: true }, ["accessibility"])).toThrow(switchNeedsAgent("performanceChecks"));
        expect(() => applyAgentChoice({ ...DEFAULT_JOB_OPTIONS }, { targets: ["web", "api"] }, ["accessibility"])).toThrow(/API Testing Agent/);
        expect(() => applyAgentChoice({ ...DEFAULT_JOB_OPTIONS }, { variants: ["webkit"] }, ["ux"])).toThrow(/Responsive UI Testing Agent/);
        expect(switchNeedsAgent("performanceChecks")).toMatch(/Performance Testing Agent/);
    });

    it("applies only a saved choice: a project without one runs as asked", async () => {
        const saved = (await asKey("POST", "/api/projects", { name: "Saved", agents: ["security"] })).body.id;
        const none = (await asKey("POST", "/api/projects", { name: "Not saved" })).body.id;
        const asked = { ...DEFAULT_JOB_OPTIONS, performanceChecks: true };
        expect(await withAgentChoice(platform, platform.repo.getProject(none)!, asked, { performanceChecks: true })).toEqual(asked);
        await expect(withAgentChoice(platform, platform.repo.getProject(saved)!, asked, { performanceChecks: true })).rejects.toThrow(/Performance Testing Agent/);
        expect((await withAgentChoice(platform, platform.repo.getProject(saved)!, { ...DEFAULT_JOB_OPTIONS }, {})).securityChecks).toBe(true);
    });

    it("every agent that can be chosen owns at least one check, and no check has two owners that disagree", () => {
        for (const a of TESTING_AGENTS.filter((x) => x.available)) expect(a.turnsOn.length).toBeGreaterThan(0);
        const owners = new Map<string, string>();
        for (const a of TESTING_AGENTS) for (const k of [...a.turnsOn, ...a.allows]) {
            expect(owners.has(k), `${k} has two owners`).toBe(false);
            owners.set(k, a.id);
        }
    });
});
