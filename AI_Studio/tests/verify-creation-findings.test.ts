/**
 * Phase 4 layer findings reach Phase 5 (eng-all 3b): a creation job (mode "generate") runs the tests it makes, and the ones it leaves
 * as findings (NEEDS_REVIEW) are written as candidate findings and verified, as a run's failed tests are. A test the job could not
 * make pass for its own reasons (FAILED_VALIDATION) is not a finding. Browser-free: the attempts come from a scripted executor.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { verifyAfterJob, type VerifyDeps } from "../src/platform/findings/verify-service.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";

let platform: Platform;
let dir = "";
beforeAll(() => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-verify-creation-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "verify-creation-secret-key-0123456789", SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
});
afterAll(() => {
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const api = (testId: string) =>
    TestSpecSchema.parse({
        testId,
        title: `Check ${testId}`,
        kind: "api",
        category: "API",
        source: { origin: "openapi", requirements: ["4.1"] },
        steps: [
            { action: "request", method: "GET", path: "/api/cart" },
            { action: "assertResponse", check: "relation", expression: "discount == round(subtotal * 0.10)", source: "4.1" },
        ],
    });
const failing = (testId: string): ScriptRun => ({
    testId,
    status: "failed",
    durationMs: 1,
    failedStepIndex: 1,
    steps: [
        { index: 0, title: "1. request", status: "passed" },
        { index: 1, title: "2. relation", status: "failed", error: "Relation check failed (4.1): discount == round(subtotal * 0.10). Values: discount = 0, subtotal = 100" },
    ],
    artifacts: [],
    responses: [],
});

describe("a creation job's findings are verified", () => {
    it("writes its NEEDS_REVIEW layer check as a layer finding, verifies it 3 times, and leaves its own broken test alone", async () => {
        const projectId = String(platform.repo.createProject({ name: "Layer shop" }).id);
        const appId = platform.repo.createApplication(projectId, "http://127.0.0.1:5592", { ...DEFAULT_JOB_OPTIONS }) as string;
        const suiteId = platform.repo.getOrCreateSuite(projectId, "API", "api");
        const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "generate" });
        const finding = platform.repo.insertTest({ projectId, suiteId, jobId: job.id, spec: api("API-001"), framework: "playwright-api", validationStatus: "NEEDS_REVIEW", meta: { layer: "api" } });
        const broken = platform.repo.insertTest({ projectId, suiteId, jobId: job.id, spec: api("API-002"), framework: "playwright-api", validationStatus: "FAILED_VALIDATION", meta: { layer: "api" } });
        for (const [id, key] of [[finding, "API-001"], [broken, "API-002"]] as const) {
            const r = failing(key);
            platform.repo.addExecution({ testId: id, scriptId: null, jobId: job.id, attempt: 1, status: "failed", durationMs: 1, error: r.steps[1]!.error, startedAt: new Date().toISOString(), steps: r.steps });
        }
        platform.repo.setJobStatus(job.id, "COMPLETED");

        const ran: string[] = [];
        const execute: VerifyDeps["execute"] = async (_a, batch, _e, opts) => {
            ran.push(...batch.scripts.map((s) => s.testId));
            return Array.from({ length: opts.attempts ?? 1 }, () => failing(batch.scripts[0]!.testId));
        };
        await verifyAfterJob(platform, platform.repo.getJob(job.id)!, { execute, attempts: 3 });

        const rows = await new CandidateFindingStore(platform.sql).list(projectId);
        expect(rows.map((r) => r.testId)).toEqual([finding]);
        expect(ran).toEqual(["API-001"]);
        // Three attempts, failing the same way each time: reproduced and classified an app defect.
        expect(rows[0]!.attempts).toHaveLength(3);
        expect(["reproduced", "confirmed", "classified"]).toContain(rows[0]!.state);
        expect(rows[0]!.findingClass).toBe("app_defect");
    });

    it("takes the job's findings from the caller when their statuses changed since (the benchmark reruns and replays its tests first)", async () => {
        const projectId = String(platform.repo.createProject({ name: "Rerun shop" }).id);
        const appId = platform.repo.createApplication(projectId, "http://127.0.0.1:5593", { ...DEFAULT_JOB_OPTIONS }) as string;
        const suiteId = platform.repo.getOrCreateSuite(projectId, "API", "api");
        const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "generate" });
        // Both were findings when the job ended; a later replay moved them on.
        const kept = platform.repo.insertTest({ projectId, suiteId, jobId: job.id, spec: api("API-011"), framework: "playwright-api", validationStatus: "VALIDATED", meta: { layer: "api" } });
        const other = platform.repo.insertTest({ projectId, suiteId, jobId: job.id, spec: api("API-012"), framework: "playwright-api", validationStatus: "VALIDATED", meta: { layer: "api" } });
        for (const [id, key] of [[kept, "API-011"], [other, "API-012"]] as const) {
            const r = failing(key);
            platform.repo.addExecution({ testId: id, scriptId: null, jobId: job.id, attempt: 1, status: "failed", durationMs: 1, error: r.steps[1]!.error, startedAt: new Date().toISOString(), steps: r.steps });
        }
        platform.repo.setJobStatus(job.id, "COMPLETED");
        const execute: VerifyDeps["execute"] = async (_a, batch, _e, opts) => Array.from({ length: opts.attempts ?? 1 }, () => failing(batch.scripts[0]!.testId));
        await verifyAfterJob(platform, platform.repo.getJob(job.id)!, { execute, attempts: 3, findingTests: new Set([kept]) });
        const rows = await new CandidateFindingStore(platform.sql).list(projectId);
        expect(rows.map((r) => r.testId)).toEqual([kept]);
        expect(rows[0]!.attempts).toHaveLength(3);
    });

    it("confirms a reproduced finding at high confidence, leaves a lower one Reproduced, and groups two sightings of one failure", async () => {
        const projectId = String(platform.repo.createProject({ name: "Confirm shop" }).id);
        const appId = platform.repo.createApplication(projectId, "http://127.0.0.1:5594", { ...DEFAULT_JOB_OPTIONS }) as string;
        const suiteId = platform.repo.getOrCreateSuite(projectId, "API", "api");
        const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "generate" });
        // Two checks of the same stated rule on the same request, and one whose failing check states no source (inferred: low confidence).
        const unsourced = TestSpecSchema.parse({ ...api("API-023"), steps: [{ action: "request", method: "GET", path: "/api/orders" }, { action: "assertResponse", check: "status", expected: 200 }] });
        const ids = [
            platform.repo.insertTest({ projectId, suiteId, jobId: job.id, spec: api("API-021"), framework: "playwright-api", validationStatus: "NEEDS_REVIEW", meta: { layer: "api" } }),
            platform.repo.insertTest({ projectId, suiteId, jobId: job.id, spec: api("API-022"), framework: "playwright-api", validationStatus: "NEEDS_REVIEW", meta: { layer: "api" } }),
            platform.repo.insertTest({ projectId, suiteId, jobId: job.id, spec: unsourced, framework: "playwright-api", validationStatus: "NEEDS_REVIEW", meta: { layer: "api" } }),
        ];
        const fail = (key: string): ScriptRun =>
            key === "API-023"
                ? { ...failing(key), steps: [{ index: 0, title: "1. request", status: "passed" }, { index: 1, title: "2. status", status: "failed", error: "Expected status 200, received 500" }] }
                : failing(key);
        for (const [id, key] of ids.map((id, i) => [id, `API-02${i + 1}`] as const)) {
            const r = fail(key);
            platform.repo.addExecution({ testId: id, scriptId: null, jobId: job.id, attempt: 1, status: "failed", durationMs: 1, error: r.steps[1]!.error, startedAt: new Date().toISOString(), steps: r.steps });
        }
        platform.repo.setJobStatus(job.id, "COMPLETED");
        const execute: VerifyDeps["execute"] = async (_a, batch, _e, opts) => Array.from({ length: opts.attempts ?? 1 }, () => fail(batch.scripts[0]!.testId));
        await verifyAfterJob(platform, platform.repo.getJob(job.id)!, { execute, attempts: 3 });
        const store = new CandidateFindingStore(platform.sql);
        const byTest = new Map((await store.list(projectId)).map((r) => [r.testId, r]));
        const [a, b, c] = ids.map((id) => byTest.get(id)!);
        expect([a!.state, b!.state]).toEqual(["confirmed", "confirmed"]);
        expect(c!.state).toBe("reproduced");
        expect(c!.confidenceDetail?.confidence).not.toBe("high");
        expect(a!.groupId).toBeTruthy();
        expect(b!.groupId).toBe(a!.groupId);
        expect(c!.groupId).not.toBe(a!.groupId);
        expect((await store.history(projectId, a!.id)).at(-1)).toMatchObject({ to: "confirmed", by: "engine" });
    });
});
