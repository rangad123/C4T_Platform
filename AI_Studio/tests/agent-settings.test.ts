/**
 * Each testing agent's own Settings (owner request 2026-11-25; .scratch/agent-workspace/SETTINGS-SPLIT.md): saved defaults per project and
 * agent, only the options that agent's run uses, and every run of that agent starting from them.
 *
 *   - GET/PUT /api/projects/:id/workspace/:agentId/settings: the keys each agent has (Test Case Generation: level and model only), a key
 *     another agent has is refused, a model the saver may not use is refused, an agent the project did not choose is a 404;
 *   - a run started with nothing said uses the agent's saved level (with its limits), sizes, screen review and model; what the run says wins;
 *   - a schedule of that agent uses them too; saving the project's choice of agents again keeps them;
 *   - the agent page's Setup tab became Settings: an old `?tab=setup` link opens Settings.
 *
 * Browser-free: node scripts/with-lock.mjs tsc -- npx vitest run tests/agent-settings.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { LEVEL_SETTINGS } from "../src/engine/levels.js";
import { PROJECT_MODEL_NOT_YOURS } from "../src/platform/ai-config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { startHeartbeat } from "../src/platform/ops/heartbeat.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { getScheduleServices } from "../src/platform/schedule-services.js";
import { startScheduledJob } from "../src/platform/scheduler.js";
import { testingAgentsOf } from "../src/platform/routes/testing-agents.js";
import { buildServer } from "../src/platform/server.js";
import { agentTabOf, routes } from "../web/src/lib/router.js";

const KEY = "agent-settings-key-7c2a";
const SITE = "http://127.0.0.1:6533";
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
let stopBeat: (() => void) | undefined;

const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, headers: { "x-api-key": KEY }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body } as { status: number; body: any };
};
async function project(name: string, agents: string[]): Promise<string> {
    const pid = platform.repo.createProject({ name, platforms: ["web"], testingModes: ["agent"] }).id as string;
    await testingAgentsOf(platform).set(pid, agents as never, "test");
    platform.repo.createApplication(pid, SITE, { ...DEFAULT_JOB_OPTIONS });
    return pid;
}
const settingsUrl = (pid: string, agent: string) => `/api/projects/${pid}/workspace/${agent}/settings`;
const lastJob = (pid: string) => platform.repo.listJobs(pid)[0]!;
const finish = (pid: string) => platform.repo.setJobStatus(lastJob(pid).id, "COMPLETED");

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-agent-settings-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, LLM_PROVIDER: "anthropic", SECRET_KEY: "agent-settings-secret-0123456789" } as never));
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

describe("an agent's own settings: only the options its run uses", () => {
    it("says which defaults each agent has; Test Case Generation has the level and the model only", async () => {
        const pid = await project("Keys", ["test-generation", "responsive-ui", "ux", "performance", "security"]);
        const keys = async (a: string) => (await call("GET", settingsUrl(pid, a))).body.keys;
        expect(await keys("test-generation")).toEqual(["level", "model"]);
        expect(await keys("responsive-ui")).toEqual(["level", "model", "variants"]);
        expect(await keys("ux")).toEqual(["level", "model", "visionChecks"]);
        // The load check sends real load: a choice per run, never a saved default.
        expect(await keys("performance")).toEqual(["level", "model"]);
        expect(await keys("security")).toEqual(["level", "model"]);
        expect((await call("GET", settingsUrl(pid, "test-generation"))).body.settings).toEqual({});
    });

    it("saves and answers them; a key of another agent, a bad value or a model the saver may not use is refused and nothing changes", async () => {
        const pid = await project("Save", ["test-generation", "responsive-ui"]);
        const saved = await call("PUT", settingsUrl(pid, "responsive-ui"), { level: "deep", variants: ["phone-375"] });
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        expect(saved.body.settings).toEqual({ level: "deep", variants: ["phone-375"] });
        expect((await call("GET", settingsUrl(pid, "responsive-ui"))).body.settings).toEqual({ level: "deep", variants: ["phone-375"] });
        // Test Case Generation checks no screen sizes.
        expect(await call("PUT", settingsUrl(pid, "test-generation"), { variants: ["phone-375"] })).toMatchObject({ status: 400, body: { error: 'The Test Case Generation Agent has no setting "variants".' } });
        expect((await call("PUT", settingsUrl(pid, "responsive-ui"), { level: "huge" })).status).toBe(400);
        expect((await call("PUT", settingsUrl(pid, "responsive-ui"), { variants: ["desktop-4k"] })).status).toBe(400);
        // The access key's person has no AI keys: no model is theirs to choose.
        expect(await call("PUT", settingsUrl(pid, "responsive-ui"), { model: { provider: "openai", model: "gpt-x" } })).toMatchObject({ status: 403, body: { error: PROJECT_MODEL_NOT_YOURS } });
        expect((await call("GET", settingsUrl(pid, "responsive-ui"))).body.settings).toEqual({ level: "deep", variants: ["phone-375"] });
        // Not one of this project's agents, or not an agent at all.
        expect((await call("GET", settingsUrl(pid, "ux"))).status).toBe(404);
        expect((await call("PUT", settingsUrl(pid, "nope"), {})).status).toBe(404);
    });

    it("saving the project's choice of agents again keeps each agent's settings", async () => {
        const pid = await project("Keep", ["test-generation", "ux"]);
        expect((await call("PUT", settingsUrl(pid, "ux"), { visionChecks: false })).status).toBe(200);
        expect((await call("PUT", `/api/projects/${pid}/testing-agents`, { agents: ["test-generation"] })).status).toBe(200);
        expect((await call("PUT", `/api/projects/${pid}/testing-agents`, { agents: ["test-generation", "ux"] })).status).toBe(200);
        expect((await call("GET", settingsUrl(pid, "ux"))).body.settings).toEqual({ visionChecks: false });
    });
});

describe("every run of the agent starts from its settings", () => {
    it("a run that says nothing uses the saved level with its limits, sizes and model; what the run says wins", async () => {
        const pid = await project("Runs", ["test-generation", "responsive-ui"]);
        await call("PUT", settingsUrl(pid, "responsive-ui"), { level: "deep", variants: ["tablet-768"] });
        // A model is saved by a person who may use it; here straight into the store (the route's check is above).
        await testingAgentsOf(platform).setSettings(pid, "test-generation", { level: "everything", model: { provider: "openai", model: "gpt-agent" } }, "test");

        expect((await call("POST", `/api/projects/${pid}/test-generation`, { url: SITE, agentId: "responsive-ui" })).status).toBe(202);
        expect(lastJob(pid).options).toMatchObject({ agentId: "responsive-ui", level: "deep", maxPages: LEVEL_SETTINGS.deep.maxPages, variants: ["tablet-768"] });
        expect(lastJob(pid).options.aiModel).toBeUndefined();
        finish(pid);

        expect((await call("POST", `/api/projects/${pid}/test-generation`, { url: SITE, agentId: "responsive-ui", level: "thorough", variants: ["phone-375", "tablet-768"] })).status).toBe(202);
        expect(lastJob(pid).options).toMatchObject({ level: "thorough", maxPages: LEVEL_SETTINGS.thorough.maxPages, variants: ["phone-375", "tablet-768"] });
        finish(pid);

        expect((await call("POST", `/api/projects/${pid}/test-generation`, { url: SITE, agentId: "test-generation", plan: true })).status).toBe(202);
        expect(lastJob(pid).options).toMatchObject({ agentId: "test-generation", level: "everything", aiModel: { provider: "openai", model: "gpt-agent" } });
        // The model is the run's alone: never kept on the application, so no later run inherits it.
        expect(platform.repo.getLatestApplicationPublic(pid)!.config).not.toHaveProperty("aiModel");
        finish(pid);
    });

    it("the UX agent's saved screen review is used unless the run says otherwise", async () => {
        const pid = await project("Review", ["ux"]);
        await call("PUT", settingsUrl(pid, "ux"), { visionChecks: false });
        expect((await call("POST", `/api/projects/${pid}/test-generation`, { url: SITE, agentId: "ux" })).status).toBe(202);
        expect(lastJob(pid).options.visionChecks).toBe(false);
        finish(pid);
        expect((await call("POST", `/api/projects/${pid}/test-generation`, { url: SITE, agentId: "ux", visionChecks: true })).status).toBe(202);
        expect(lastJob(pid).options.visionChecks).toBe(true);
        finish(pid);
    });

    it("a schedule of the agent uses its settings too", async () => {
        const pid = await project("Scheduled", ["ux", "accessibility"]);
        await call("PUT", settingsUrl(pid, "ux"), { level: "deep", visionChecks: true });
        const made = await call("POST", `/api/projects/${pid}/schedules`, { kind: "generate", cadence: { type: "daily", time: "02:00" }, agentId: "ux" });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        const job = await startScheduledJob(platform.repo, getScheduleServices(platform).store.get(made.body.id)!);
        expect(job.options).toMatchObject({ agentId: "ux", level: "deep", maxPages: LEVEL_SETTINGS.deep.maxPages, visionChecks: true });
    });
});

describe("the agent page's tabs", () => {
    it("Setup became Settings: the old ?tab=setup link opens Settings, an unknown tab the Outcome", () => {
        expect(agentTabOf("setup")).toBe("settings");
        expect(agentTabOf("settings")).toBe("settings");
        expect(agentTabOf("runs")).toBe("runs");
        expect(agentTabOf("nothing")).toBe("outcome");
        expect(agentTabOf(null)).toBe("outcome");
        expect(routes.projectAgent("p1", "ux", "settings")).toBe("#/projects/p1/agents/ux?tab=settings");
    });
});
