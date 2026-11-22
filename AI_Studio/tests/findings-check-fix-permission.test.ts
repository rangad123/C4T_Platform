/** check_fix starts a verification job (runs the finding's test on the app); does it need ai_studio.tests.run like a run? */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startHeartbeat } from "../src/platform/ops/heartbeat.js";
import { loadConfig } from "../src/config.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { harvestExecutionFindings } from "../src/platform/findings/verify-service.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";

const KEY = "check-fix-owner-key-77a1c3";
const PAGE = { "x-requested-with": "ai-studio" };
const API_PORT = 7763;
let api: http.Server;
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let stopBeat: (() => void) | undefined;
let dir = "";
const me = (id: string, permissions: string[]) => ({ data: { user: { id, email: `${id}@people.example`, role: "CUSTOMER", status: "ACTIVE", firstName: id, lastName: "P", emailVerified: true, permissions, organisationId: "org-a" } } });
const ACCOUNTS: Record<string, unknown> = { "t-wes": me("wes", ["ai_studio.access", "ai_studio.tests.write"]), "t-ann": me("ann", [...PERMISSIONS]) };
const as = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as "GET", url, headers: { cookie: `c4t_access=${token}`, ...PAGE }, ...(payload !== undefined ? { payload: payload as object } : {}) }).then((r) => ({ status: r.statusCode, body: r.body }));

beforeAll(async () => {
    api = http.createServer((req, res) => {
        const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        res.writeHead(ACCOUNTS[auth] ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ACCOUNTS[auth] ?? { error: { message: "Invalid access token" } }));
    });
    await new Promise<void>((r) => api.listen(API_PORT, "127.0.0.1", r));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-verify-hardening-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECRET_KEY: "verify-hardening-secret-key-0123456789", C4T_API_ORIGIN: `http://127.0.0.1:${API_PORT}`, C4T_SITE_URL: "https://crowd4test.example" }));
    stopBeat = startHeartbeat(platform.db);
    app = await buildServer(platform);
    await app.ready();
}, 60_000);

afterAll(async () => {
    stopBeat?.();
    await app?.close();
    platform?.db.close();
    await new Promise((r) => api?.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
});

it("a person without ai_studio.tests.run cannot start a run, nor a fix check that runs the test", async () => {
    const projectId = String(JSON.parse((await as("t-ann", "POST", "/api/projects", { name: "Shop" })).body).id);
    const appId = platform.repo.createApplication(projectId, "http://127.0.0.1:5591", { ...DEFAULT_JOB_OPTIONS });
    const suiteId = platform.repo.getOrCreateSuite(projectId, "Cart", "cart");
    const spec = TestSpecSchema.parse({ testId: "WEB-001", title: "Cart total", kind: "web", category: "Cart", source: { origin: "browser-agent", requirements: [] }, steps: [{ action: "navigate", url: "/cart" }, { action: "assert", check: "exactText", locator: { by: "testId", value: "total" }, expected: "$21.00" }] });
    const bug = platform.repo.insertTest({ projectId, suiteId, jobId: null, spec, framework: "playwright", validationStatus: "VALIDATED" });
    const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [bug] });
    const t = platform.repo.getTest(bug)!;
    const store = new CandidateFindingStore(platform.sql);
    const run = { testId: "WEB-001", status: "failed" as const, durationMs: 1, failedStepIndex: 1, steps: [{ index: 0, title: "1", status: "passed" as const }, { index: 1, title: "2", status: "failed" as const, error: 'Expected "$21.00", received "$16.75"' }], artifacts: [], responses: [] };
    const [f] = await harvestExecutionFindings(store, { projectId, jobId: job.id, failed: [{ test: { id: t.id, title: t.title, spec: t.spec, meta: t.generationMeta, testKey: t.testKey, framework: t.framework }, run }] });
    platform.repo.setJobStatus(job.id, "COMPLETED");
    await store.transition(projectId, f!.id, { to: "verification_pending", by: "engine" });
    await store.transition(projectId, f!.id, { to: "reproduced", by: "engine", set: { confidence: { confidence: "high", factors: [] } as never } });
    await store.transition(projectId, f!.id, { to: "confirmed", by: "engine" });

    const wesId = JSON.parse((await as("t-wes", "GET", "/api/auth/state")).body).me.id;
    await accessControlOf(app).projects.store.addMember(projectId, wesId, { role: "owner", projectAdmin: false, source: "added", addedBy: "test" });

    const runRes = await as("t-wes", "POST", `/api/projects/${projectId}/runs`, {});
    const before = platform.db.all<{ id: string }>("SELECT id FROM generation_jobs WHERE project_id = ?", projectId).length;
    const fix = await as("t-wes", "POST", `/api/projects/${projectId}/findings/${f!.id}/transition`, { action: "check_fix" });
    const jobs = platform.db.all<{ id: string; options_json: string; status: string }>("SELECT id, options_json, status FROM generation_jobs WHERE project_id = ?", projectId);
    expect(runRes.status).toBe(403);
    expect(fix.status).toBe(403);
    expect(jobs.length).toBe(before);
});
