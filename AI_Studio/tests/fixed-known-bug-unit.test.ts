/**
 * A Fixed finding closes its issue's expected failure (Phase 6 G6). A test with an issue link runs as `test.fail()`: it stays green
 * while the bug is there. Once the regression service marks the test's finding Fixed, the link is resolved: it is kept, its history
 * names the fix commit, and the test runs normally again, so a bug that comes back fails it and reopens the finding. The reopen makes
 * the link count again. Browser-free: the real platform (SQLite), with scripted verification attempts.
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
import { checkFix, claimFix, reopenReturned } from "../src/platform/findings/regression-service.js";
import { harvestExecutionFindings, type VerifyDeps } from "../src/platform/findings/verify-service.js";
import { knownBugsOf } from "../src/platform/job-runner.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";

const HEAD = "b".repeat(40);
let platform: Platform;
let dir = "";
let store: CandidateFindingStore;

beforeAll(() => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-fixed-known-bug-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "fixed-known-bug-secret-key-0123456789", API_KEY: "k-fixed-known-bug", SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    store = new CandidateFindingStore(platform.sql);
});
afterAll(() => {
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const run = (testId: string, outcome: "pass" | "fail"): ScriptRun => ({
    testId,
    status: outcome === "pass" ? "passed" : "failed",
    durationMs: 1,
    failedStepIndex: outcome === "pass" ? -1 : 1,
    steps: [
        { index: 0, title: "1. request", status: "passed" },
        { index: 1, title: "2. check", status: outcome === "pass" ? "passed" : "failed", ...(outcome === "fail" ? { error: "Error: expect(received).toEqual(expected) Expected 3775 Received 2925" } : {}) },
    ],
    artifacts: [],
    responses: [],
    notes: [],
});
const attempts = (outcome: "pass" | "fail"): VerifyDeps["execute"] => async (_a, batch) => [1, 2, 3].map(() => run(batch.scripts[0]!.testId, outcome));

async function bugWithIssue() {
    const projectId = String(platform.repo.createProject({ name: `Shop ${Math.random()}` }).id);
    const appId = platform.repo.createApplication(projectId, "http://127.0.0.1:5591", { ...DEFAULT_JOB_OPTIONS });
    const suiteId = platform.repo.getOrCreateSuite(projectId, "Cart", "cart");
    const spec = TestSpecSchema.parse({ testId: "API-016", title: "The subtotal is the sum of the line totals", kind: "api", category: "Cart", steps: [{ action: "request", method: "GET", path: "/api/cart" }, { action: "assertResponse", check: "jsonPath", path: "subtotal", expected: 3775 }] });
    const testId = platform.repo.insertTest({ projectId, suiteId, jobId: null, spec, framework: "playwright-api", validationStatus: "VALIDATED" });
    const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [testId] });
    const t = platform.repo.getTest(testId)!;
    const [f] = await harvestExecutionFindings(store, { projectId, jobId: job.id, failed: [{ test: { id: t.id, title: t.title, spec: t.spec, meta: t.generationMeta, testKey: t.testKey, framework: t.framework }, run: run("API-016", "fail") }] });
    platform.repo.setJobStatus(job.id, "COMPLETED");
    await store.transition(projectId, f!.id, { to: "verification_pending", by: "engine" });
    await store.transition(projectId, f!.id, { to: "reproduced", by: "engine", set: { confidence: { confidence: "high", factors: [] } as never } });
    await store.transition(projectId, f!.id, { to: "confirmed", by: "engine" });
    platform.db.run("INSERT INTO issue_links (id, test_case_id, integration_id, provider, external_id, url, title, created_at) VALUES (?,?,?,?,?,?,?,?)", `link-${projectId}`, testId, null, "github", "#12", "https://github.example/acme/shop/issues/12", "Subtotal", new Date().toISOString());
    return { projectId, appId, testId, findingId: f!.id };
}
const known = (testId: string) => knownBugsOf(platform.db, [{ handle: { id: testId, testId: "API-016" } } as never]).knownBugs ?? {};

describe("a Fixed finding and its issue link", () => {
    it("the link stops marking the test as an expected failure once the fix passes, is kept, and the history names the fix commit", async () => {
        const b = await bugWithIssue();
        expect(known(b.testId)).toEqual({ "API-016": "#12 https://github.example/acme/shop/issues/12" });
        const claim = await claimFix(platform, b.projectId, { findingIds: [b.findingId], by: "issue", source: "pull request #5", headSha: HEAD });
        await checkFix(platform, platform.repo.getJob(claim.jobId!)!, { execute: attempts("pass") });
        expect((await store.get(b.projectId, b.findingId))!.state).toBe("fixed");
        expect(known(b.testId)).toEqual({});
        expect(platform.db.all("SELECT external_id FROM issue_links WHERE test_case_id = ?", b.testId)).toEqual([{ external_id: "#12" }]);
        const said = (await store.history(b.projectId, b.findingId)).map((e) => e.reason ?? "");
        expect(said).toContainEqual("Its issue #12 no longer marks API-016 as expected to fail: resolved by the fix in bbbbbbb. A reopen makes it count again.");
    });

    it("another open finding of the same test keeps the link counting", async () => {
        const b = await bugWithIssue();
        const claim = await claimFix(platform, b.projectId, { findingIds: [b.findingId], by: "issue", source: "pull request #8", headSha: HEAD });
        await checkFix(platform, platform.repo.getJob(claim.jobId!)!, { execute: attempts("pass") });
        expect(known(b.testId)).toEqual({});
        const t = new Date().toISOString();
        platform.db.run(
            "INSERT INTO candidate_findings (id, project_id, test_id, fingerprint, status, confidence, capture, finding_json, first_seen_at, last_seen_at, created_at, updated_at, state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            `other-${b.projectId}`, b.projectId, b.testId, `fp-other-${b.projectId}`, "candidate", "high", "captured", "{}", t, t, t, t, "confirmed",
        );
        expect(known(b.testId)).toEqual({ "API-016": "#12 https://github.example/acme/shop/issues/12" });
    });

    it("a fix that still reproduces keeps the expected failure", async () => {
        const b = await bugWithIssue();
        const claim = await claimFix(platform, b.projectId, { findingIds: [b.findingId], by: "issue", source: "pull request #6", headSha: HEAD });
        await checkFix(platform, platform.repo.getJob(claim.jobId!)!, { execute: attempts("fail") });
        expect((await store.get(b.projectId, b.findingId))!.state).toBe("confirmed");
        expect(known(b.testId)).toEqual({ "API-016": "#12 https://github.example/acme/shop/issues/12" });
    });

    it("when the bug comes back, the run fails, the finding reopens and the link counts again", async () => {
        const b = await bugWithIssue();
        const claim = await claimFix(platform, b.projectId, { findingIds: [b.findingId], by: "issue", source: "pull request #7", headSha: HEAD });
        await checkFix(platform, platform.repo.getJob(claim.jobId!)!, { execute: attempts("pass") });
        const back = await platform.repo.createJob(b.projectId, b.appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [b.testId] });
        platform.db.run("INSERT INTO test_executions (id, job_id, test_case_id, status, attempt, started_at) VALUES (?,?,?,?,?,?)", `ex-${back.id}`, back.id, b.testId, "failed", 1, new Date().toISOString());
        expect((await reopenReturned(platform, platform.repo.getJob(back.id)!)).map((f) => f.id)).toEqual([b.findingId]);
        expect(known(b.testId)).toEqual({ "API-016": "#12 https://github.example/acme/shop/issues/12" });
    });
});
