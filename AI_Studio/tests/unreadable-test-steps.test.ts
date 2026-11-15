/**
 * A test whose stored steps cannot be read (an old or damaged record) is left out of runs and shown as such; it never breaks the
 * deploy trigger, the Tests list or the runs of the other tests. No browser, no worker: a started run simply stays queued.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { runnableTestIds } from "../src/platform/scheduler.js";
import { buildDashboard } from "../src/platform/dashboard.js";
import { LocatorStore } from "../src/platform/locator-store.js";

const API_KEY = "test-api-key-0123456789";
const FIXTURE = "http://127.0.0.1:9561";

let dataDir: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let projectId: string;
let goodId: string;
let badId: string;
let badKey: string;

type Method = "GET" | "POST" | "DELETE";
const send = async (method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const res = await server.inject({ method, url, payload: payload as never, headers });
    return { status: res.statusCode, body: res.body && /^[{[]/.test(res.body) ? JSON.parse(res.body) : res.body };
};
const withKey = (method: Method, url: string, payload?: unknown) => send(method, url, payload, { "x-api-key": API_KEY });
const settle = () => {
    for (const j of platform.repo.listJobs(projectId)) if (!["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) platform.repo.setJobStatus(j.id, "COMPLETED");
};

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-unreadable-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", API_KEY }));
    server = await buildServer(platform);
    projectId = (await withKey("POST", "/api/projects", { name: "Damaged record" })).body.id;
    const step = (p: string) => [{ action: "request", method: "GET", path: p }, { action: "assertResponse", check: "status", expected: 200 }];
    const imp = await withKey("POST", `/api/projects/${projectId}/specs`, {
        baseUrl: FIXTURE,
        validate: false,
        specs: [
            { title: "Still fine", kind: "api", category: "API", steps: step("/api/ok") },
            { title: "Damaged", kind: "api", category: "API", steps: step("/api/other") },
        ],
    });
    expect(imp.status, JSON.stringify(imp.body)).toBe(202);
    settle();
    const rows = platform.db.all<{ id: string; title: string; test_key: string }>("SELECT id, title, test_key FROM test_cases WHERE project_id = ?", projectId);
    goodId = rows.find((r) => r.title === "Still fine")!.id;
    const bad = rows.find((r) => r.title === "Damaged")!;
    badId = bad.id;
    badKey = bad.test_key;
    platform.db.run("UPDATE test_cases SET spec_json = ? WHERE id = ?", '{"title": "Damaged", "steps": [', badId);
}, 30_000);

afterAll(async () => {
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("a test whose stored steps cannot be read", () => {
    it("is not runnable, and the other tests still are", async () => {
        const ids = await runnableTestIds(platform.repo, projectId);
        expect(ids).toEqual([goodId]);
    });

    it("the Tests list shows it as unreadable instead of failing", async () => {
        const list = await withKey("GET", `/api/projects/${projectId}/tests`);
        expect(list.status, JSON.stringify(list.body).slice(0, 300)).toBe(200);
        const bad = (list.body as Array<{ id: string; unreadable?: boolean; validationReason?: string | null }>).find((t) => t.id === badId)!;
        expect(bad.unreadable).toBe(true);
        expect((list.body as Array<{ id: string; unreadable?: boolean }>).find((t) => t.id === goodId)!.unreadable).toBeUndefined();
        const one = await withKey("GET", `/api/tests/${badId}`);
        expect(one.status).toBe(200);
        expect(one.body.unreadable).toBe(true);
    });

    it("a deploy trigger runs every readable test and says which one could not be read", async () => {
        const t = (await withKey("POST", `/api/projects/${projectId}/triggers`, { label: "deploy" })).body as { token: string };
        const run = await send("POST", `/api/triggers/${t.token}/run`, {});
        expect(run.status, JSON.stringify(run.body)).toBe(202);
        const job = platform.repo.getJob(run.body.jobId)!;
        expect(job.options.testIds).toEqual([goodId]);
        const events = platform.repo.listEvents(job.id).map((e) => e.message).join("\n");
        expect(events).toContain(badKey);
        expect(events).not.toContain('"steps"');
        settle();
    });

    it("the dashboard says the project's data could not be read, and the locator usage rebuild reads past it", () => {
        platform.db.run("UPDATE test_cases SET validation_status = 'NEEDS_REVIEW' WHERE id = ?", badId);
        const d = buildDashboard(platform.db);
        expect(d.projects.find((x) => x.id === projectId)?.readiness.state).toBe("unknown");
        expect(() => new LocatorStore(platform.db).rebuildProject(projectId)).not.toThrow();
        platform.db.run("UPDATE test_cases SET validation_status = 'PENDING' WHERE id = ?", badId);
    });

    it("running everything from the Runs page leaves it out too, and asking for it alone says why", async () => {
        const all = await withKey("POST", `/api/projects/${projectId}/runs`, {});
        expect(all.status, JSON.stringify(all.body)).toBe(202);
        expect(platform.repo.getJob(all.body.jobId)!.options.testIds ?? [goodId]).not.toContain(badId);
        settle();
        const alone = await withKey("POST", `/api/projects/${projectId}/runs`, { testIds: [badId] });
        expect(alone.status).toBeGreaterThanOrEqual(400);
        expect(alone.status).toBeLessThan(500);
        expect(JSON.stringify(alone.body)).toMatch(/cannot be read/i);
    });
});
