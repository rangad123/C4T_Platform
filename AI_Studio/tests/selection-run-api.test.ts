/**
 * Focused and full runs from the same selection view and from the deploy trigger (G5), against a real platform (no browser, no worker,
 * no AI): the full run is every runnable test and stays the default; focused is only ever an explicit choice; the preview carries the
 * risk score of each proposed test.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { runnableTestIds } from "../src/platform/scheduler.js";
import { buildServer } from "../src/platform/server.js";
import { getTriggerServices } from "../src/platform/trigger-services.js";

const API_KEY = "test-api-key-0123456789";
const APP = "http://127.0.0.1:9655";

let dataDir: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let projectId: string;
let token: string;
const ids: Record<string, string> = {};

const send = async (method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = { "x-api-key": API_KEY }) => {
    const res = await server.inject({ method, url, payload: payload as never, headers });
    return { status: res.statusCode, body: res.body && /^[{[]/.test(res.body) ? JSON.parse(res.body) : res.body };
};
const api = (title: string, method: string, p: string, priority = "medium") => ({ title, kind: "api", category: "API", priority, steps: [{ action: "request", method, path: p }, { action: "assertResponse", check: "status", expected: 200 }] });
/** A finished run of the test's current version, so its declared coverage counts as complete. */
function recordRun(testId: string, status: string, daysAgo: number) {
    const scriptId = (platform.repo.getCurrentScript(testId) as { id: string } | undefined)?.id ?? null;
    const execId = platform.repo.addExecution({ testId, scriptId, jobId: null, attempt: 1, status, durationMs: 500, startedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(), steps: [] });
    platform.db.run("UPDATE test_executions SET test_version_id = (SELECT id FROM test_versions WHERE test_case_id = ? AND state = 'approved' ORDER BY version DESC LIMIT 1) WHERE id = ?", testId, execId);
}
const jobTests = (jobId: string) => [...(platform.repo.getJob(jobId)!.options.testIds ?? [])].sort();

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-selrun-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", API_KEY }));
    getTriggerServices(platform, { minGapMs: 0 });
    server = await buildServer(platform);
    projectId = (await send("POST", "/api/projects", { name: "Shop" })).body.id;
    const res = await send("POST", `/api/projects/${projectId}/specs`, {
        baseUrl: APP,
        validate: false,
        specs: [{ ...api("Create an order", "POST", "/orders/{{id}}", "critical"), testData: { id: "41" } }, api("Health answers", "GET", "/health"), api("List orders", "GET", "/orders")],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    for (const t of platform.repo.listTests(projectId)) ids[t.title] = t.id;
    recordRun(ids["Create an order"]!, "failed", 2);
    recordRun(ids["Create an order"]!, "passed", 1);
    recordRun(ids["Health answers"]!, "passed", 1);
    recordRun(ids["List orders"]!, "passed", 1);
    token = (await send("POST", `/api/projects/${projectId}/triggers`, { label: "CI" })).body.token as string;
});

afterAll(async () => {
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

// One active job per project: end the previous one before the next start.
beforeEach(() => void platform.db.run("UPDATE generation_jobs SET status = 'FAILED', error = 'Cancelled' WHERE project_id = ?", projectId));

describe("from the selection view", () => {
    it("runs the full suite by default: every runnable test", async () => {
        const r = await send("POST", `/api/projects/${projectId}/selection-run`, {});
        expect(r.status, JSON.stringify(r.body)).toBe(202);
        expect(r.body.selection).toBe("full");
        expect(jobTests(r.body.jobId)).toEqual((await runnableTestIds(platform.repo, projectId, "validate", null)).sort());
        expect(r.body.testCount).toBe(3);
    });

    it("runs the focused set when a person chooses it: the tests the preview proposes", async () => {
        const preview = await send("POST", `/api/projects/${projectId}/selection-preview`, { endpoints: ["POST /orders/{id}"] });
        const proposed = [...preview.body.matched, ...preview.body.unknown].map((t: any) => t.testId).sort();
        const r = await send("POST", `/api/projects/${projectId}/selection-run`, { selection: "focused", endpoints: ["POST /orders/{id}"] });
        expect(r.status, JSON.stringify(r.body)).toBe(202);
        expect(r.body.selection).toBe("focused");
        expect(jobTests(r.body.jobId)).toEqual(proposed);
        expect(proposed).toEqual([ids["Create an order"]]);
    });

    it("refuses a focused run without a change, and one that proposes nothing", async () => {
        expect((await send("POST", `/api/projects/${projectId}/selection-run`, { selection: "focused" })).status).toBe(400);
        const none = await send("POST", `/api/projects/${projectId}/selection-run`, { selection: "focused", endpoints: ["DELETE /nothing"] });
        expect(none.status).toBe(409);
        expect(none.body.error ?? none.body.message).toMatch(/Run the full suite instead/);
        expect((await send("POST", `/api/projects/${projectId}/selection-run`, { selection: "some" })).status).toBe(400);
    });

    it("the preview scores each proposed test with every factor named", async () => {
        const p = await send("POST", `/api/projects/${projectId}/selection-preview`, { endpoints: ["POST /orders/{id}", "GET /orders"] });
        const order = p.body.matched.find((t: any) => t.title === "Create an order");
        expect(order.risk.factors.map((f: any) => [f.factor, f.points])).toEqual([
            ["change impact", 3],
            ["business criticality", 4],
            ["failure rate", 2],
            ["previous defects", 0],
            ["workflow dependency", 0],
            ["reliability", -1], // its two runs disagree (failed, then passed): unreliable
        ]);
        expect(p.body.matched[0].title).toBe("Create an order");
    });
});

describe("from the deploy trigger", () => {
    it("without `selection` runs every runnable test, and answers as before", async () => {
        const r = await send("POST", `/api/triggers/${token}/run`, { commit: "abc1234" }, {});
        expect(r.status, JSON.stringify(r.body)).toBe(202);
        expect(jobTests(r.body.jobId)).toEqual((await runnableTestIds(platform.repo, projectId, "validate", null)).sort());
        expect(Object.keys(r.body).sort()).toEqual(["commit", "environment", "jobId", "state", "testCount"]);
    });

    it("`selection: full` is the same full run", async () => {
        const r = await send("POST", `/api/triggers/${token}/run`, { selection: "full", endpoints: ["POST /orders/{id}"] }, {});
        expect(r.status).toBe(202);
        expect(r.body.testCount).toBe(3);
    });

    it("`selection: focused` runs only the proposed tests, and needs the change", async () => {
        const r = await send("POST", `/api/triggers/${token}/run`, { selection: "focused", endpoints: ["GET /orders"] }, {});
        expect(r.status, JSON.stringify(r.body)).toBe(202);
        expect(r.body.selection).toBe("focused");
        const titles = jobTests(r.body.jobId).map((id) => platform.repo.getTest(id)!.title);
        expect(titles, JSON.stringify(r.body)).toEqual(["List orders"]);
        expect((await send("POST", `/api/triggers/${token}/run`, { selection: "focused" }, {})).status).toBe(400);
    });
});
