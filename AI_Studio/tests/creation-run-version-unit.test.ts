/**
 * A creation job (it pins no versions: the AI tries its own drafts) records the version each execution ran, as an ordinary Run does
 * (review-store.ts finishRun), so change-aware selection does not treat every test of a creation as out of date (FREE-B #4: all 262 N2F
 * executions had no version and 253 of 261 tests were stale). Only executions of the test's current script are linked, and only to a
 * version that holds exactly the steps the test holds and existed when they ran. Real platform (SQLite), no browser, no AI.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { ReviewStore } from "../src/platform/review-store.js";
import { projectCoverage } from "../src/platform/selection/facts.js";

let platform: Platform;
let dir = "";
beforeAll(() => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-creation-version-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "creation-version-secret-key-0123456789", API_KEY: "k-creation-version", SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
});
afterAll(() => {
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const spec = (title: string, path: string) =>
    TestSpecSchema.parse({ testId: "API-001", title, kind: "api", category: "API", steps: [{ action: "request", method: "GET", path }, { action: "assertResponse", check: "status", expected: 200 }] });

async function creation() {
    const repo = platform.repo;
    const projectId = String(repo.createProject({ name: `Shop ${Math.random()}` }).id);
    const appId = repo.createApplication(projectId, "http://127.0.0.1:5591", { ...DEFAULT_JOB_OPTIONS });
    const job = await repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS });
    const suiteId = repo.getOrCreateSuite(projectId, "API", "api");
    const testId = repo.insertTest({ projectId, suiteId, jobId: job.id, spec: spec("Health answers", "/health"), framework: "playwright-api", validationStatus: "VALIDATED", versionSource: "ai" });
    const script = (n: number) => repo.addScript(testId, { framework: "playwright-api", filename: `t${n}.spec.ts`, content: `// ${n}`, hash: `h${n}`, storagePath: `s/${n}`, executable: true });
    return { projectId, jobId: job.id, testId, script };
}
const run = (testId: string, jobId: string, scriptId: string, attempt: number, status: string) => platform.repo.addExecution({ testId, scriptId, jobId, attempt, status, durationMs: 100, startedAt: new Date(Date.now() + attempt).toISOString(), steps: [] });
const linked = (id: string) => platform.db.get<{ v: string | null }>("SELECT test_version_id AS v FROM test_executions WHERE id = ?", id)?.v ?? null;

describe("a creation job's executions name the version they ran", () => {
    it("links the current script's executions to the version holding the test's steps; the test's coverage is then fresh once approved", async () => {
        const { projectId, jobId, testId, script } = await creation();
        const first = script(1);
        const failed = run(testId, jobId, first, 1, "failed");
        const current = script(2); // the repaired script, made from the steps the test holds now
        const passed = run(testId, jobId, current, 2, "passed");
        const reviews = new ReviewStore(platform.db);
        reviews.finishRun(jobId);
        const v = reviews.latest(testId)!;
        expect(linked(passed)).toBe(v.id);
        expect(linked(failed)).toBeNull();
        expect(platform.db.get<{ s: string }>("SELECT script_id AS s FROM test_versions WHERE id = ?", v.id)?.s).toBe(current);
        // Approved as it is (same version): the creation's passing run vouches for the test's coverage.
        platform.db.run("UPDATE test_versions SET state = 'approved' WHERE id = ?", v.id);
        const cov = await projectCoverage(platform.repo, platform.store, projectId);
        const t = cov.tests.find((x) => x.testId === testId)!;
        expect(t).toBeDefined();
        expect(t.stale).toBeUndefined();
    });

    it("leaves the executions unlinked when the test's steps changed after the run, and never touches a run that pinned versions", async () => {
        const changed = await creation();
        const e = run(changed.testId, changed.jobId, changed.script(1), 1, "passed");
        platform.db.run("UPDATE test_cases SET spec_json = ? WHERE id = ?", JSON.stringify(spec("Health answers", "/health?changed=1")), changed.testId);
        new ReviewStore(platform.db).finishRun(changed.jobId);
        expect(linked(e)).toBeNull();

        const pinned = await creation();
        const p = run(pinned.testId, pinned.jobId, pinned.script(1), 1, "passed");
        platform.db.run("INSERT INTO test_run_versions (job_id, test_case_id, version_id, version, outcome) VALUES (?,?,?,?,?)", pinned.jobId, pinned.testId, null, null, "waiting");
        new ReviewStore(platform.db).finishRun(pinned.jobId);
        expect(linked(p)).toBeNull();
    });
});
