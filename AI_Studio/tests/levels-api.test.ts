/**
 * Round 53, exploration levels on the platform: a request without a level is stored as thorough's limits, a level and "Explore every
 * page again" round-trip from the Explore page's request, project Settings saves the level, and a schedule's exploration carries it.
 * No worker runs: the jobs are only queued and read back. No network beyond app.inject.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { startScheduledJob } from "../src/platform/scheduler.js";
import type { Schedule } from "../src/platform/schedule-store.js";
import { startHeartbeat } from "../src/platform/ops/heartbeat.js";
import { buildServer } from "../src/platform/server.js";

const KEY = "levels-api-key-4c81e2";
const SITE = "https://shop.example/";
let dataDir = "";
let platform: Platform;
let stopBeat: (() => void) | undefined;
let app: Awaited<ReturnType<typeof buildServer>>;

const call = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as "GET", url, headers: { "x-api-key": KEY }, ...(payload !== undefined ? { payload: payload as object } : {}) }).then((r) => ({ status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body }));
const finishJobs = (projectId: string) => platform.db.run("UPDATE generation_jobs SET status = 'FAILED' WHERE project_id = ?", projectId);
const latestJob = (projectId: string) => platform.repo.listJobs(projectId)[0]!;

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-levels-api-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY: KEY, WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false", SECRET_KEY: "levels-api-secret-0123456789abcdef" }));
    // A worker in another process says it is alive, so explorations are queued (and nothing here runs them).
    stopBeat = startHeartbeat(platform.db);
    app = await buildServer(platform);
});
afterAll(async () => {
    stopBeat?.();
    await app?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

async function newProject(name: string): Promise<string> {
    const r = await call("POST", "/api/projects", { name });
    expect(r.status).toBe(201);
    return r.body.id as string;
}

describe("exploration levels through the API", () => {
    it("a request without a level runs with thorough's 60 pages, 4 deep, 50 tests", async () => {
        const id = await newProject("Levels default");
        const r = await call("POST", `/api/projects/${id}/test-generation`, { url: SITE, plan: true });
        expect(r.status, JSON.stringify(r.body)).toBe(202);
        const o = latestJob(id).options;
        expect(o).toMatchObject({ maxPages: 60, maxDepth: 4, maxScenarios: 50 });
        expect(o.level).toBeUndefined();
        expect(o.fullExploration).toBeUndefined();
        // Numbers below thorough's are raised to it.
        finishJobs(id);
        expect((await call("POST", `/api/projects/${id}/test-generation`, { url: SITE, plan: true, maxPages: 10, maxDepth: 1, maxScenarios: 5 })).status).toBe(202);
        expect(latestJob(id).options).toMatchObject({ maxPages: 60, maxDepth: 4, maxScenarios: 50 });
    });

    it("the Explore page's level and \"Explore every page again\" round-trip, and the schema takes everything's numbers", async () => {
        const id = await newProject("Levels chosen");
        expect((await call("POST", `/api/projects/${id}/test-generation`, { url: SITE, plan: true, level: "deep", fullExploration: true })).status).toBe(202);
        expect(latestJob(id).options).toMatchObject({ level: "deep", maxPages: 120, maxDepth: 5, maxScenarios: 100, fullExploration: true });
        expect((await call("GET", `/api/projects/${id}`)).body.application.config).toMatchObject({ level: "deep", maxPages: 120 });
        finishJobs(id);
        expect((await call("POST", `/api/projects/${id}/test-generation`, { url: SITE, plan: true, maxPages: 250, maxDepth: 6, maxScenarios: 150 })).status).toBe(202);
        expect(latestJob(id).options).toMatchObject({ maxPages: 250, maxDepth: 6, maxScenarios: 150 });
        finishJobs(id);
        expect((await call("POST", `/api/projects/${id}/test-generation`, { url: SITE, level: "huge" })).status).toBe(400);
        expect((await call("POST", `/api/projects/${id}/test-generation`, { url: SITE, maxPages: 251 })).status).toBe(400);
    });

    it("project Settings saves the level; a schedule's exploration then carries it", async () => {
        const id = await newProject("Levels settings");
        expect((await call("PUT", `/api/projects/${id}/explore-level`, { level: "deep" })).status).toBe(409);
        expect((await call("POST", `/api/projects/${id}/test-generation`, { url: SITE, plan: true })).status).toBe(202);
        finishJobs(id);
        const put = await call("PUT", `/api/projects/${id}/explore-level`, { level: "everything" });
        expect(put.status, JSON.stringify(put.body)).toBe(200);
        expect((await call("GET", `/api/projects/${id}`)).body.application.config).toMatchObject({ level: "everything", maxPages: 250, maxDepth: 6, maxScenarios: 150 });
        expect((await call("PUT", `/api/projects/${id}/explore-level`, { level: "lots" })).status).toBe(400);

        const schedule = { id: "s-levels", projectId: id, name: "Nightly", kind: "generate", retryFailures: 0, createdBy: null } as unknown as Schedule;
        const job = await startScheduledJob(platform.repo, schedule);
        expect(job.options).toMatchObject({ level: "everything", maxPages: 250, maxDepth: 6, maxScenarios: 150, trigger: "schedule" });
    });
});
