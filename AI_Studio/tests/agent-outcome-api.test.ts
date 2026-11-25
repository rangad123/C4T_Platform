/**
 * Agent Workspace W2a: the API Testing Agent's outcome (SPEC §3; owner 2026-11-25: one table of its API tests with method, path, the
 * expected status and contract, PASS or FAIL and a failure's evidence, plus its verified API findings; nothing else), computed on read from what its runs saved: the API tests (meta.endpoint), the statuses the
 * API answered (api_snapshots) and the findings of its tests (candidate_findings, verified states only).
 *
 *   GET /api/projects/:id/workspace/api/outcome[?run=]   and the card's headline in GET /api/projects/:id/workspace
 *
 * Browser-free: node scripts/with-lock.mjs tsc -- npx vitest run tests/agent-outcome-api.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { CONTRACT_FAILURE_PREFIX } from "../src/engine/contracts/check.js";
import { findingFingerprint, type CandidateFindingInput } from "../src/engine/explore/finding.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { recordObservations } from "../src/platform/drift-store.js";
import { DEFAULT_JOB_OPTIONS, type JobStatus } from "../src/platform/repo.js";
import { testingAgentsOf } from "../src/platform/routes/testing-agents.js";
import { buildServer } from "../src/platform/server.js";

const KEY = "agent-outcome-api-key-7c2e";
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
let pid = "";
let appId = "";
let n = 0;
const ids: Record<string, string> = {};
const tests: Record<string, string> = {};

const get = async (url: string) => {
    const r = await app.inject({ method: "GET", url, headers: { "x-api-key": KEY } });
    return { status: r.statusCode, body: JSON.parse(r.body) as any };
};
const wait = () => new Promise((r) => setTimeout(r, 5));

async function job(agentId: string | undefined, status: JobStatus, error?: string, extra: Record<string, unknown> = {}) {
    await wait();
    const j = await platform.repo.createJob(pid, appId, { ...DEFAULT_JOB_OPTIONS, ...(agentId ? { agentId: agentId as never } : {}), ...extra });
    platform.repo.setJobStatus(j.id, status, error);
    return j.id;
}

/** A test the engine saved in this run: `endpoint` and the other meta as orchestrator.ts persistNew writes them. */
function test(jobId: string, name: string, o: { endpoint?: string; schema?: boolean; meta?: Record<string, unknown>; status: "VALIDATED" | "NEEDS_REVIEW" | "FAILED_VALIDATION" | "PENDING"; reason?: string }) {
    const [method, p] = (o.endpoint ?? "GET /x").split(" ");
    const spec = TestSpecSchema.parse({
        testId: `API-${String(++n).padStart(3, "0")}`,
        title: `${o.endpoint ?? name}: succeeds with a valid request`,
        kind: "api",
        category: "API",
        steps: [{ action: "request", method, path: p }, { action: "assertResponse", check: "status", expected: 200 }, ...(o.schema ? [{ action: "assertResponse", check: "matchesSchema", schema: { type: "object" } }] : [])],
    });
    const suite = platform.repo.getOrCreateSuite(pid, "API", "api");
    const id = platform.repo.insertTest({ projectId: pid, suiteId: suite, jobId, spec, framework: "playwright-api", validationStatus: "PENDING", meta: { ...(o.endpoint ? { endpoint: o.endpoint } : {}), ...o.meta, layer: "api" } });
    platform.repo.updateTest(id, { validationStatus: o.status, reason: o.reason ?? null });
    tests[name] = id;
    return id;
}
const answered = (jobId: string, calls: Array<[string, string, number]>) =>
    recordObservations(platform.db, { projectId: pid, jobId, responses: calls.map(([method, p, status]) => ({ method, path: p, status, obs: null })) });

const finding = (scenario: string): CandidateFindingInput => ({
    objective: null,
    actions: { stepCount: 2 },
    expected: { text: "Answers 200 with the health document.", source: "openapi:GET /health" },
    observed: "Answered 500.",
    evidence: { screenshots: [], requests: ["GET /health -> 500"], console: [] },
    capture: "captured",
    independence: "independent",
    confidence: "high",
    fingerprint: findingFingerprint({ source: "openapi:GET /health", expected: "Answers 200 with the health document.", scenario }),
    modelVersion: null,
    replays: [],
});
/** A finding of this test, walked along the engine's path to `to`. */
async function findingOf(testName: string, jobId: string, to: "candidate" | "confirmed") {
    const store = new CandidateFindingStore(platform.sql);
    const id = (await store.upsert({ projectId: pid, jobId, testId: tests[testName], finding: finding(testName) })).finding.id;
    if (to === "confirmed") {
        await store.transition(pid, id, { to: "verification_pending", by: "engine" });
        await store.transition(pid, id, { to: "reproduced", by: "engine", set: { severity: "high", confidence: { confidence: "high", factors: [] } as never } });
        await store.transition(pid, id, { to: "confirmed", by: "engine" });
    }
    return id;
}

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-outcome-api-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECRET_KEY: "agent-outcome-api-secret-0123456789" } as never));
    app = await buildServer(platform);
    await app.ready();
    pid = platform.repo.createProject({ name: "API Store", platforms: ["web"], testingModes: ["agent"] }).id as string;
    await testingAgentsOf(platform).set(pid, ["api", "security", "performance"], "test");
    appId = platform.repo.createApplication(pid, "http://127.0.0.1:6533", { ...DEFAULT_JOB_OPTIONS });

    // An older exploration that named no agent, with API, speed and security checks on (it counts for each of those agents): only its
    // endpoint test is the API agent's.
    ids.old = await job(undefined, "COMPLETED", undefined, { performanceChecks: true, securityChecks: true });
    test(ids.old, "items", { endpoint: "GET /items/{id}", status: "VALIDATED" });
    test(ids.old, "oldSlow", { endpoint: "GET /slow", meta: { performance: true }, status: "VALIDATED" });
    test(ids.old, "oldAdmin", { endpoint: "GET /admin", meta: { security: true }, status: "NEEDS_REVIEW", reason: "Missing header" });
    answered(ids.old, [["GET", "/items/sku-a", 200], ["GET", "/slow", 200], ["GET", "/admin", 200]]);
    await findingOf("oldAdmin", ids.old, "confirmed");

    // Run 1 (done): the users read matches its contract, the order create does not.
    ids.first = await job("api", "COMPLETED");
    test(ids.first, "users", { endpoint: "GET /users/{id}", schema: true, status: "VALIDATED" });
    test(ids.first, "orders", { endpoint: "POST /orders", schema: true, status: "NEEDS_REVIEW", reason: `${CONTRACT_FAILURE_PREFIX} the field "total" is missing [high]\nHow to fix: update the document` });
    // A second test of the same endpoint whose contract check passed: one answer that differed is still the row's word.
    test(ids.first, "orders2", { endpoint: "POST /orders", schema: true, status: "VALIDATED" });
    answered(ids.first, [["GET", "/users/42", 200], ["POST", "/orders", 201]]);

    // Another agent's runs in the same project: never in the API agent's outcome.
    ids.security = await job("security", "COMPLETED");
    test(ids.security, "admin", { endpoint: "GET /admin", meta: { security: true }, status: "NEEDS_REVIEW", reason: "Missing header" });
    await findingOf("admin", ids.security, "confirmed");
    ids.perf = await job("performance", "COMPLETED");
    test(ids.perf, "slow", { endpoint: "GET /slow", meta: { performance: true }, status: "VALIDATED" });

    // Run 2 (stopped): the users read again, this time without a contract check, and a health check whose 500 was verified.
    ids.second = await job("api", "FAILED", "Cancelled");
    test(ids.second, "users2", { endpoint: "GET /users/{id}", status: "VALIDATED" });
    test(ids.second, "health", { endpoint: "GET /health", status: "NEEDS_REVIEW", reason: "Server error: GET /health returned 500" });
    answered(ids.second, [["GET", "/users/7", 200], ["GET", "/users/8", 404], ["GET", "/health", 500]]);
    ids.verified = await findingOf("health", ids.second, "confirmed");
    await findingOf("users2", ids.second, "candidate");
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

/** The table's rows of one endpoint ("GET /users/{id}"), by test. */
const rows = (o: any, key: string) => (o.tests as any[]).filter((t) => `${t.method} ${t.path}` === key);
const keys = (o: any) => [...new Set((o.tests as any[]).map((t) => `${t.method} ${t.path}`))];

describe("the API Testing Agent's outcome", () => {
    it("is one table of its API tests (method, path, expected status and contract, PASS or FAIL), the newest run's tests per endpoint", async () => {
        const r = await get(`/api/projects/${pid}/workspace/api/outcome`);
        expect(r.status).toBe(200);
        expect(r.body.runs).toBe(3);
        expect(keys(r.body)).toEqual(["GET /health", "GET /items/{id}", "POST /orders", "GET /users/{id}"]);
        // The stopped run is the newest: its read of the users replaces run 1's.
        expect(rows(r.body, "GET /users/{id}")).toEqual([expect.objectContaining({ testId: tests.users2, expectedStatus: "200", contract: "not-checked", result: "pass", jobId: ids.second, evidence: null })]);
        // Both of run 1's order tests: the one whose answer differed from the document fails, the other passes.
        const orders = rows(r.body, "POST /orders");
        expect(orders.map((t: any) => [t.testId, t.result, t.contract])).toEqual([[tests.orders, "fail", "differs"], [tests.orders2, "pass", "matches"]]);
        expect(orders[0].contractNote).toBe('the field "total" is missing');
        expect(rows(r.body, "GET /health")[0]).toMatchObject({ result: "fail", expectedStatus: "200", contract: "not-checked" });
        expect(rows(r.body, "GET /items/{id}")[0]).toMatchObject({ result: "pass", jobId: ids.old });
        expect(r.body.summary).toEqual({ tests: 5, passed: 3, failed: 2, notRun: 0 });
    });

    it("opens a failed test's evidence: the request it sent and the response it got; a passed test has none", async () => {
        const r = await get(`/api/projects/${pid}/workspace/api/outcome`);
        expect(rows(r.body, "GET /health")[0].evidence).toEqual({ request: { method: "GET", path: "/health", query: null, body: null }, response: { statuses: [500], reason: "Server error: GET /health returned 500" } });
        const order = rows(r.body, "POST /orders")[0];
        expect(order.evidence.request).toMatchObject({ method: "POST", path: "/orders" });
        expect(order.evidence.response.statuses).toEqual([201]);
        expect(order.evidence.response.reason).toContain('the field "total" is missing');
        for (const t of (r.body.tests as any[]).filter((x) => x.result === "pass")) expect(t.evidence).toBeNull();
    });

    it("holds only this agent's items: no other agent's tests or findings, no pages, page checks or test cases", async () => {
        const r = await get(`/api/projects/${pid}/workspace/api/outcome`);
        expect(Object.keys(r.body).sort()).toEqual(["findings", "headline", "runs", "summary", "tests"]);
        expect(rows(r.body, "GET /admin")).toEqual([]);
        expect(rows(r.body, "GET /slow")).toEqual([]);
        expect((r.body.findings as any[]).map((f) => f.testId)).toEqual([tests.health]);
    });

    it("shows verified findings only, with what was expected and what happened", async () => {
        const r = await get(`/api/projects/${pid}/workspace/api/outcome`);
        expect(r.body.findings).toHaveLength(1);
        expect(r.body.findings[0]).toMatchObject({ id: ids.verified, testId: tests.health, endpoint: "GET /health", state: "confirmed", stateLabel: "Confirmed", severity: "high", expected: "Answers 200 with the health document.", observed: "Answered 500." });
    });

    it("answers one run's part with ?run=, a stopped run's items included; another agent's run is a 404", async () => {
        const first = await get(`/api/projects/${pid}/workspace/api/outcome?run=${ids.first}`);
        expect(first.status).toBe(200);
        expect(first.body.runs).toBe(1);
        expect(keys(first.body)).toEqual(["POST /orders", "GET /users/{id}"]);
        expect(rows(first.body, "GET /users/{id}")[0]).toMatchObject({ result: "pass", contract: "matches" });
        expect(first.body.findings).toEqual([]);
        const stopped = await get(`/api/projects/${pid}/workspace/api/outcome?run=${ids.second}`);
        expect(keys(stopped.body)).toEqual(["GET /health", "GET /users/{id}"]);
        expect(stopped.body.findings.map((f: any) => f.id)).toEqual([ids.verified]);
        expect((await get(`/api/projects/${pid}/workspace/api/outcome?run=${ids.security}`)).status).toBe(404);
    });

    it("gives the card the same line the Outcome tab says, and none before a run", async () => {
        const ws = await get(`/api/projects/${pid}/workspace`);
        expect(ws.body.agents.find((a: any) => a.id === "api").headline).toBe("5 API tests: 3 passed, 2 failed, 1 verified finding");
        expect((await get(`/api/projects/${pid}/workspace/api/outcome`)).body.headline).toBe("5 API tests: 3 passed, 2 failed, 1 verified finding");
        const bare = platform.repo.createProject({ name: "No runs", platforms: ["web"], testingModes: ["agent"] }).id as string;
        await testingAgentsOf(platform).set(bare, ["api"], "test");
        const empty = await get(`/api/projects/${bare}/workspace`);
        expect(empty.body.agents[0]).toMatchObject({ id: "api", status: "needs-input", headline: null });
        expect((await get(`/api/projects/${bare}/workspace/api/outcome`)).body).toEqual({ runs: 0, headline: "0 API tests: 0 passed, 0 failed", summary: { tests: 0, passed: 0, failed: 0, notRun: 0 }, tests: [], findings: [] });
    });
});
