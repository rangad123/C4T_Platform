/**
 * A Steps save and what follows it agree: the steps, the DSL text, the script on the Code tab, the download and the next run.
 * Signed in through a stand-in Crowd4Test sign-in (port 7760), where a person's edit starts as a draft under the default review
 * policy: the run then uses the approved version, and the page says so, but the test's current script stays the one made from the
 * saved steps (a run of the approved version used to store its script as the current one, so the Code tab went back to the old
 * steps). Stand-in site: the sample app on port 7761.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { runJob } from "../src/platform/job-runner.js";
import { startHeartbeat } from "../src/platform/ops/heartbeat.js";
import { buildServer } from "../src/platform/server.js";

const API_PORT = 7760;
const APP_PORT = 7761;
const APP = `http://127.0.0.1:${APP_PORT}`;
const PAGE = { "x-requested-with": "ai-studio" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const me = (id: string) => ({ data: { user: { id, email: `${id}@people.example`, role: "CUSTOMER", status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions: PERMISSIONS, organisationId: "org-a" } } });
const ACCOUNTS: Record<string, unknown> = { "t-ann": me("ann"), "t-ben": me("ben") };

let api: http.Server;
let sample: ChildProcess;
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dataDir = "";
let stopBeat: (() => void) | undefined;

const as = (token: string, method: string, url: string, payload?: unknown) =>
    app
        .inject({ method: method as "GET", url, headers: { cookie: `c4t_access=${token}`, ...(method === "GET" ? {} : PAGE) }, ...(payload !== undefined ? { payload: payload as object } : {}) })
        .then((r) => ({ status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body }));

/** The test as imported from a file: the last step checks for a word the stand-in site never shows, so it fails there. */
const loginSpec = {
    testId: "WEB-002",
    title: "Verify login with valid credentials",
    kind: "web",
    category: "Imported from a file",
    priority: "high",
    steps: [
        { action: "navigate", url: "/login" },
        { action: "fill", locator: { by: "label", value: "Email" }, value: "demo@example.com" },
        { action: "fill", locator: { by: "label", value: "Password" }, value: "demo-password" },
        { action: "click", locator: { by: "role", role: "button", value: "Log in" } },
        { action: "assert", check: "visible", locator: { by: "text", value: "Dashboard" } },
    ],
};

/** Runs the queued job of the project (the test runs it itself: no worker). */
async function runQueued(jobId: string) {
    const claimed = platform.repo.claimNextJob(60_000, "w-sync")!;
    expect(claimed.id).toBe(jobId);
    await runJob({ ...platform }, claimed, "w-sync");
    return platform.repo.getJob(jobId)!;
}

beforeAll(async () => {
    api = http.createServer((req, res) => {
        const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        res.writeHead(ACCOUNTS[auth] ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ACCOUNTS[auth] ?? { error: { message: "Invalid access token" } }));
    });
    await new Promise<void>((r) => api.listen(API_PORT, "127.0.0.1", r));
    sample = spawn(process.execPath, [path.join(REPO_ROOT, "examples/sample-app/server.mjs"), String(APP_PORT)], { stdio: "ignore" });
    for (let i = 0; i < 40; i++) {
        try {
            if ((await fetch(APP + "/")).ok) break;
        } catch {
            await sleep(150);
        }
    }
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-steps-sync-"));
    platform = bootstrap(
        loadConfig({ DATA_DIR: dataDir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", MAX_REPAIR_ATTEMPTS: "0", SECRET_KEY: "steps-sync-secret-key-0123456789", C4T_API_ORIGIN: `http://127.0.0.1:${API_PORT}`, C4T_SITE_URL: "https://crowd4test.example" }),
    );
    stopBeat = startHeartbeat(platform.db);
    app = await buildServer(platform);
    await app.ready();
}, 60_000);

afterAll(async () => {
    stopBeat?.();
    await app?.close();
    platform?.db.close();
    sample?.kill();
    await new Promise((r) => api?.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("a Steps save of an imported test, where edits wait for review", () => {
    let projectId = "";
    let testId = "";
    const current = () => platform.repo.getCurrentScript(testId)!.content as string;

    it("imports, approves and runs the test: it fails at its last step", async () => {
        projectId = (await as("t-ann", "POST", "/api/projects", { name: "Workbench Web Testing" })).body.id;
        const ann = (await as("t-ann", "GET", "/api/auth/state")).body.me.id;
        accessControlOf(app).projects.store.addMember(projectId, ann, { role: "owner", projectAdmin: true, source: "added", addedBy: "test" });
        const imp = await as("t-ann", "POST", `/api/projects/${projectId}/specs`, { specs: [loginSpec], baseUrl: APP, validate: false });
        expect(imp.status).toBe(202);
        testId = imp.body.tests[0].id;
        const v1 = (await as("t-ann", "GET", `/api/tests/${testId}/review/1`)).body;
        expect(v1.state).toBe("draft");
        expect((await as("t-ann", "POST", `/api/tests/${testId}/review/1/approve`, { seen: v1.updatedAt })).body.state).toBe("approved");
        const job = await runQueued((await as("t-ann", "POST", `/api/tests/${testId}/validate`)).body.jobId);
        expect(job.status).not.toBe("RUNNING");
        expect(platform.repo.listExecutions(testId)[0]!.status).not.toBe("passed");
        expect(current()).toMatch(/Dashboard/);
    }, 120_000);

    it("deleting the last step: the save is a draft, the answer and the test page say the run uses the approved version", async () => {
        const spec = (await as("t-ann", "GET", `/api/tests/${testId}/spec`)).body.spec;
        const saved = await as("t-ann", "PUT", `/api/tests/${testId}/spec`, { spec: { ...spec, steps: spec.steps.slice(0, 4) } });
        expect(saved.status).toBe(200);
        expect(saved.body.note).toMatch(/approved version 1, not this draft/);
        // Right after the save everything shows the saved steps.
        expect(current()).not.toMatch(/Dashboard/);
        const dsl = (await as("t-ann", "GET", `/api/tests/${testId}/dsl`)).body;
        expect(JSON.stringify(dsl)).not.toMatch(/Dashboard/);

        const job = await runQueued(saved.body.jobId);
        expect(["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"]).toContain(job.status);
        // The run used the approved version (it still has the check): that is the review rule, kept.
        expect(platform.repo.listEvents(job.id).some((e) => e.kind === "approved_version_ran")).toBe(true);

        // After the run, the steps, the DSL, the Code tab's script and the download still agree with the save.
        const detail = (await as("t-ann", "GET", `/api/tests/${testId}`)).body;
        expect(detail.spec.steps).toHaveLength(4);
        const code = detail.scripts.find((s: { framework: string }) => s.framework === detail.framework).content as string;
        expect(code).not.toMatch(/Dashboard/);
        expect(current()).not.toMatch(/Dashboard/);
        expect(JSON.stringify((await as("t-ann", "GET", `/api/tests/${testId}/dsl`)).body)).not.toMatch(/Dashboard/);
        // The test page says which version runs.
        expect(detail.review).toMatchObject({ state: "draft", version: 2, runsVersion: 1 });
    }, 120_000);

    it("once the draft is approved, the next run uses the saved steps and passes", async () => {
        // ann made the change; ben, another Project Admin, approves it.
        const ben = (await as("t-ben", "GET", "/api/auth/state")).body.me.id;
        accessControlOf(app).projects.store.addMember(projectId, ben, { role: "owner", projectAdmin: true, source: "added", addedBy: "test" });
        const v2 = (await as("t-ben", "GET", `/api/tests/${testId}/review/2`)).body;
        expect((await as("t-ben", "POST", `/api/tests/${testId}/review/2/approve`, { seen: v2.updatedAt })).body.state).toBe("approved");
        const job = await runQueued((await as("t-ann", "POST", `/api/tests/${testId}/validate`)).body.jobId);
        expect(job.status).toBe("COMPLETED");
        expect(platform.repo.listExecutions(testId)[0]!.status).toBe("passed");
        expect(current()).not.toMatch(/Dashboard/);
        expect((await as("t-ann", "GET", `/api/tests/${testId}`)).body.review ?? null).toBeNull();
    }, 120_000);
});
