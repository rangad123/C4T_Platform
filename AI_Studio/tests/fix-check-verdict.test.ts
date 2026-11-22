/**
 * Fixed / Reproduced given partial, mixed or dirty-account attempts. Real platform, scripted executor.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { verdictOf } from "../src/engine/findings/reproduce.js";
import type { Attempt } from "../src/engine/findings/view.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { checkFix, claimFix } from "../src/platform/findings/regression-service.js";
import { harvestExecutionFindings, type VerifyDeps } from "../src/platform/findings/verify-service.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";

let platform: Platform;
let dir = "";
let store: CandidateFindingStore;
beforeAll(() => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-verify-hardening-fix-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "verify-hardening-secret-key-0123456789abc", SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    store = new CandidateFindingStore(platform.sql);
});
afterAll(() => {
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const check = { action: "assert", check: "exactText", locator: { by: "testId", value: "total" }, expected: "$21.00", source: "R-2" };
const run = (outcome: "pass" | "fail", note: string, at = 1): ScriptRun => ({
    testId: "WEB-001",
    status: outcome === "pass" ? "passed" : "failed",
    durationMs: 1,
    failedStepIndex: outcome === "pass" ? -1 : at,
    steps: [
        ...Array.from({ length: at }, (_, i) => ({ index: i, title: `${i + 1}. step`, status: "passed" as const })),
        { index: at, title: `${at + 1}. check`, status: outcome === "pass" ? "passed" : "failed", ...(outcome === "fail" ? { error: 'Error: expected "$21.00", received "$16.75"' } : {}) },
    ],
    artifacts: [],
    responses: [],
    notes: [note],
});

async function confirmedFinding(name: string, steps: unknown[] = [{ action: "navigate", url: "/cart" }, check]) {
    const projectId = String(platform.repo.createProject({ name }).id);
    const appId = platform.repo.createApplication(projectId, "http://127.0.0.1:5591", { ...DEFAULT_JOB_OPTIONS });
    const suiteId = platform.repo.getOrCreateSuite(projectId, "Cart", "cart");
    const spec = TestSpecSchema.parse({ testId: "WEB-001", title: "Cart total", kind: "web", category: "Cart", source: { origin: "browser-agent", requirements: ["R-2"] }, steps });
    const bug = platform.repo.insertTest({ projectId, suiteId, jobId: null, spec, framework: "playwright", validationStatus: "VALIDATED" });
    const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [bug] });
    const t = platform.repo.getTest(bug)!;
    const [f] = await harvestExecutionFindings(store, { projectId, jobId: job.id, failed: [{ test: { id: t.id, title: t.title, spec: t.spec, meta: t.generationMeta, testKey: t.testKey, framework: t.framework }, run: run("fail", "x", steps.length - 1) }] });
    platform.repo.setJobStatus(job.id, "COMPLETED");
    await store.transition(projectId, f!.id, { to: "verification_pending", by: "engine" });
    await store.transition(projectId, f!.id, { to: "reproduced", by: "engine", set: { confidence: { confidence: "high", factors: [] } as never } });
    await store.transition(projectId, f!.id, { to: "confirmed", by: "engine" });
    const claimed = await claimFix(platform, projectId, { findingIds: [f!.id], by: "person", source: "Dana" });
    return { projectId, findingId: f!.id, job: platform.repo.getJob(claimed.jobId!)! };
}

describe("check the fix", () => {
    it("a runner that returns 1 run when 3 attempts were asked is not Fixed", async () => {
        const s = await confirmedFinding("Short runner shop");
        const asked: Array<{ attempts?: number }> = [];
        const execute: VerifyDeps["execute"] = async (_a, _b, _e, opts) => (asked.push(opts), [run("pass", "Attempt 1 of 3: the test never signs in")]);
        const out = await checkFix(platform, s.job, { execute });
        const state = (await store.get(s.projectId, s.findingId))!.state;
        expect(state).not.toBe("fixed");
    });

    it("attempts that all ran on the shared (dirty) account, as their notes say, are not Fixed", async () => {
        // A test that signs in: the plan registers a fresh account per attempt where allowed; here every attempt fell back to the shared one.
        const s = await confirmedFinding("Dirty account shop", [
            { action: "navigate", url: "/login" },
            { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}" },
            { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" },
            { action: "navigate", url: "/cart" },
            check,
        ]);
        const execute: VerifyDeps["execute"] = async () => [1, 2, 3].map((i) => run("pass", `Attempt ${i} of 3: the test runs as given`));
        const out = await checkFix(platform, s.job, { execute });
        const state = (await store.get(s.projectId, s.findingId))!.state;
        expect(state).not.toBe("fixed");
    });
});

describe("verdictOf", () => {
    const f = { expected: { text: "Total is $21.00", source: "R-2", stated: "explicit" as const }, layer: undefined };
    const clean = { clean: true, note: "on a newly registered account each time" };
    const a = (x: Partial<Attempt>): Attempt => ({ outcome: "failed", requests: [], stack: [], ...x }) as Attempt;

    it("the test's own step failing twice plus one application failure is not Reproduced", () => {
        const tried = [
            a({ failedStep: 2, check: "exactText", target: "total", value: "$21.00", error: "locator.textContent: Timeout 5000ms exceeded.", stepFault: "The step points at an element that is not on the page." }),
            a({ failedStep: 2, check: "exactText", target: "total", value: "$21.00", error: "locator.textContent: Timeout 5000ms exceeded.", stepFault: "The step points at an element that is not on the page." }),
            a({ failedStep: 2, check: "exactText", target: "total", value: "$21.00", error: 'expected "$21.00", received "$16.75"' }),
        ];
        const v = verdictOf(f, tried, clean);
        expect(v.to).not.toBe("reproduced");
    });

    it("whole-run failures with unrelated errors (no failing step) are not 'the same check failing the same way'", () => {
        const tried = [a({ error: "Error: Cannot read properties of undefined (reading 'id')" }), a({ error: "Error: expected 3 items, got 0" }), a({ error: "Error: page.title() returned 'Maintenance'" })];
        const v = verdictOf(f, tried, clean);
        expect(v.to).not.toBe("reproduced");
    });
});
