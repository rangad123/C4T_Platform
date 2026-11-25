/**
 * Evidence on the finding record when it is first written (Phase 3 E7, Phase 4 L13): a failed API run's requests and answers reach the
 * finding written after the job from the stored run, a write the API accepted that the read-back then contradicts names both layers, and
 * the layers a finding names are what its confidence counts ("no layer comparison recorded" only when none is).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { confidenceScore } from "../src/engine/findings/score.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { executionFinding, fromCandidate } from "../src/platform/findings/adapters.js";
import { verifyAfterJob } from "../src/platform/findings/verify-service.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { RepoSink } from "../src/platform/repo-sink.js";

const spec = TestSpecSchema.parse({
    testId: "API-021",
    title: "A new order is in the order list",
    kind: "api",
    source: { origin: "openapi" },
    expectedResults: ["The list contains the new order"],
    steps: [
        { action: "request", method: "POST", path: "/api/orders", body: { item: "pen" } },
        { action: "assertResponse", check: "status", expected: 201 },
        { action: "request", method: "GET", path: "/api/orders" },
        { action: "assertResponse", check: "bodyContains", expected: "pen" },
    ],
});
const failed = (responses: ScriptRun["responses"]): ScriptRun => ({
    testId: "API-021",
    status: "failed",
    durationMs: 3,
    error: 'Expected the body to contain "pen"',
    failedStepIndex: 3,
    steps: [0, 1, 2, 3].map((index) => ({ index, title: `${index + 1}. step`, status: index === 3 ? ("failed" as const) : ("passed" as const), ...(index === 3 ? { error: 'Expected the body to contain "pen"' } : {}) })),
    artifacts: [],
    responses,
});
const ANSWERS = [
    { method: "POST", path: "/api/orders", status: 201 },
    { method: "GET", path: "/api/orders", status: 200 },
];
const test = { id: "t-1", title: spec.title, spec, meta: { layer: "storedData" }, testKey: "API-021", framework: "playwright" };

describe("an execution finding names the layers that disagreed", () => {
    it("a write the API accepted, then a read-back that fails: the API and the stored data, counted by its confidence", () => {
        const f = executionFinding(test, failed(ANSWERS));
        expect(f.evidence.requests).toEqual(["POST /api/orders -> 201", "GET /api/orders -> 200"]);
        expect(f.evidence.layers).toEqual([
            { layer: "api", observed: "POST /api/orders answered 201" },
            { layer: "stored data", observed: 'Expected the body to contain "pen"' },
        ]);
        const record = { id: "f-1", projectId: "p", testId: "t-1", state: "candidate", firstSeenAt: "2026-11-25T00:00:00.000Z", attempts: [], fingerprint: f.fingerprint, finding: f } as never;
        const view = fromCandidate(record, test);
        expect(view.correlated).toEqual({ disagreed: ["api", "stored data"] });
        expect(confidenceScore(view).factors.signals).toEqual({ value: 2, reason: "2 layers disagreed" });
    });

    it("an API check of one layer, or a write the API refused, names no layers", () => {
        expect(executionFinding({ ...test, meta: { layer: "api" } }, failed(ANSWERS)).evidence.layers).toBeUndefined();
        expect(executionFinding(test, failed([{ method: "POST", path: "/api/orders", status: 500 }])).evidence.layers).toBeUndefined();
    });
});

let platform: Platform;
let dir = "";
beforeAll(() => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-detection-evidence-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "detection-evidence-secret-key-0123456789", SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
});
afterAll(() => {
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("a failed API run's answers reach the finding written after the job", () => {
    it("the run is stored with its request summaries, and the finding made from the stored run carries them", async () => {
        const projectId = String(platform.repo.createProject({ name: "Orders" }).id);
        const appId = platform.repo.createApplication(projectId, "http://127.0.0.1:5592", { ...DEFAULT_JOB_OPTIONS }) as string;
        const suiteId = platform.repo.getOrCreateSuite(projectId, "Orders", "orders");
        const id = platform.repo.insertTest({ projectId, suiteId, jobId: null, spec, framework: "playwright", validationStatus: "VALIDATED" });
        const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [id] });
        const sink = new RepoSink(platform.repo, platform.store, { id: job.id, projectId, applicationId: appId, mode: "validate" });
        await sink.recordExecution({ id, testId: "API-021" } as never, null, 1, failed(ANSWERS), new Date().toISOString());
        platform.repo.setJobStatus(job.id, "COMPLETED");
        await verifyAfterJob(platform, platform.repo.getJob(job.id)!, { attempts: 1, execute: async () => [failed(ANSWERS)] });
        const [f] = await new CandidateFindingStore(platform.sql).list(projectId, { jobId: job.id });
        expect(f?.finding.evidence.requests).toEqual(["POST /api/orders -> 201", "GET /api/orders -> 200"]);
    });
});
