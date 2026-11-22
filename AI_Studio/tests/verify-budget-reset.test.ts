import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { checkFix, claimFix } from "../src/platform/findings/regression-service.js";
import { harvestExecutionFindings, verifyAfterJob, type VerifyDeps } from "../src/platform/findings/verify-service.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { resetHookProblem, withinBudget } from "../src/engine/findings/reproduce.js";
import { resetTarget } from "../src/platform/test-data-reset-store.js";

let platform: Platform;
let dir = "";
let store: CandidateFindingStore;
beforeAll(() => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-verify-hardening-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "verify-hardening-secret-key-0123456789", SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    store = new CandidateFindingStore(platform.sql);
});
afterAll(() => {
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const check = { action: "assert", check: "exactText", locator: { by: "testId", value: "total" }, expected: "$21.00", source: "R-2" };
const web = (testId: string) => TestSpecSchema.parse({ testId, title: `T ${testId}`, kind: "web", category: "Cart", source: { origin: "browser-agent", requirements: ["R-2"] }, steps: [{ action: "navigate", url: "/cart" }, check] });
const run = (testId: string, outcome: "pass" | "fail", i = 1, n = 1): ScriptRun => ({
    testId,
    status: outcome === "pass" ? "passed" : "failed",
    durationMs: 1,
    failedStepIndex: outcome === "pass" ? -1 : 1,
    steps: [
        { index: 0, title: "1. navigate", status: "passed" },
        { index: 1, title: "2. check", status: outcome === "pass" ? "passed" : "failed", ...(outcome === "fail" ? { error: 'Error: expect(locator).toHaveText(expected) failed. Expected "$21.00", received "$16.75"' } : {}) },
    ],
    artifacts: [],
    responses: [],
    notes: [`Attempt ${i} of ${n}: the test never signs in`],
});

async function project(name: string, n: number) {
    const projectId = String(platform.repo.createProject({ name }).id);
    const appId = platform.repo.createApplication(projectId, "http://127.0.0.1:5591", { ...DEFAULT_JOB_OPTIONS }) as string;
    const suiteId = platform.repo.getOrCreateSuite(projectId, "Cart", "cart");
    const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] });
    const failed = [];
    for (let i = 0; i < n; i++) {
        const id = platform.repo.insertTest({ projectId, suiteId, jobId: null, spec: web(`WEB-${100 + i}`), framework: "playwright", validationStatus: "VALIDATED" });
        const t = platform.repo.getTest(id)!;
        failed.push({ test: { id: t.id, title: t.title, spec: t.spec, meta: t.generationMeta, testKey: t.testKey, framework: t.framework }, run: run(t.testKey, "fail") });
    }
    const fs_ = await harvestExecutionFindings(store, { projectId, jobId: job.id, failed });
    platform.repo.setJobStatus(job.id, "COMPLETED");
    return { projectId, appId, job: platform.repo.getJob(job.id)!, findings: fs_ };
}

describe("fix check (regression-service checkFix) and the verification budget", () => {
    it("runs at most 30 findings, each with a 10-minute limit", async () => {
        const s = await project("Fix many", 31);
        for (const f of s.findings) {
            await store.transition(s.projectId, f.id, { to: "verification_pending", by: "engine" });
            await store.transition(s.projectId, f.id, { to: "reproduced", by: "engine", set: { confidence: { confidence: "high", factors: [] } as never } });
            await store.transition(s.projectId, f.id, { to: "confirmed", by: "engine" });
        }
        const claimed = await claimFix(platform, s.projectId, { findingIds: s.findings.map((f) => f.id), by: "person", source: "Dana" });
        const job = platform.repo.getJob(claimed.jobId!)!;
        const outer = new AbortController();
        const signals: AbortSignal[] = [];
        const execute: VerifyDeps["execute"] = async (_a, batch, _e, opts) => {
            signals.push(opts.signal!);
            return [1, 2, 3].map((i) => run(batch.scripts[0]!.testId, "fail", i, 3));
        };
        const out = await checkFix(platform, job, { execute, signal: outer.signal });
        expect(signals.length).toBe(30);
        expect(signals.some((x) => x === outer.signal)).toBe(false);
        // The 31st keeps its state, with why.
        const last = s.findings.at(-1)!;
        expect((await store.get(s.projectId, last.id))!.state).toBe("confirmed");
        expect(out.find((x) => x.id === last.id)?.reason).toMatch(/not checked: The verification budget of 30 findings per run was used/);
    });
});

describe("a finding whose attempts are cut by the job's signal", () => {
    it("does not stay in Verification pending without a reason", async () => {
        const s = await project("Cut short", 1);
        const outer = new AbortController();
        const execute: VerifyDeps["execute"] = async () => {
            outer.abort(new Error("job time limit"));
            throw new Error("Job cancelled");
        };
        const r = await verifyAfterJob(platform, s.job, { execute, signal: outer.signal, harvested: true }).then((x) => ({ ok: x }), (e) => ({ threw: String(e) }));
        const f = (await store.get(s.projectId, s.findings[0]!.id))!;
        const last = (await store.history(s.projectId, f.id)).at(-1);
        expect(r).toHaveProperty("threw");
        expect(f.state).toBe("unconfirmed");
        expect(last?.reason).toMatch(/stopped before its attempts finished/);
    });
});

describe("findings past the per-run budget", () => {
    it("are verified by later runs, after each run's own new findings, oldest first, never past the budget", async () => {
        const s = await project("Over budget", 3);
        const ran: string[][] = [];
        let now: string[] = [];
        const execute: VerifyDeps["execute"] = async (_a, b) => (now.push(b.scripts[0]!.testId), [1, 2, 3].map((i) => run(b.scripts[0]!.testId, "fail", i, 3)));
        const budget = { findingsPerRun: 1, minutesEach: 10 };
        const state = async (id: string) => (await store.get(s.projectId, id))!.state;
        const verifyRun = async (job: typeof s.job) => {
            now = [];
            const r = await verifyAfterJob(platform, job, { execute, harvested: true, budget });
            ran.push(now);
            return r;
        };
        const r1 = await verifyRun(s.job);
        expect(r1?.stopped).toBe("The verification budget of 1 finding per run was used: 2 more are not verified in this run.");
        const waiting = (await Promise.all(s.findings.map(async (f) => ({ f, st: await state(f.id) })))).filter((x) => x.st === "candidate").map((x) => x.f);
        expect(waiting).toHaveLength(2);
        const oldest = [...waiting].sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id));

        // A later run with a new finding of its own: that one goes first, and the budget leaves the older ones waiting.
        const later = await platform.repo.createJob(s.projectId, s.appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] });
        const suiteId = platform.repo.getOrCreateSuite(s.projectId, "Cart", "cart");
        const id = platform.repo.insertTest({ projectId: s.projectId, suiteId, jobId: null, spec: web("WEB-200"), framework: "playwright", validationStatus: "VALIDATED" });
        const t = platform.repo.getTest(id)!;
        const [mine] = await harvestExecutionFindings(store, { projectId: s.projectId, jobId: later.id, failed: [{ test: { id: t.id, title: t.title, spec: t.spec, meta: t.generationMeta, testKey: t.testKey, framework: t.framework }, run: run(t.testKey, "fail") }] });
        platform.repo.setJobStatus(later.id, "COMPLETED");
        await verifyRun(platform.repo.getJob(later.id)!);
        // Reproduced 3 of 3 against a stated rule: high confidence, so the engine confirms it.
        expect(await state(mine!.id)).toBe("confirmed");
        expect((await Promise.all(oldest.map((f) => state(f.id))))).toEqual(["candidate", "candidate"]);

        // Runs with nothing new pick up the waiting ones, oldest first, one per run.
        for (const f of oldest) {
            const next = await platform.repo.createJob(s.projectId, s.appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] });
            platform.repo.setJobStatus(next.id, "COMPLETED");
            await verifyRun(platform.repo.getJob(next.id)!);
            expect(await state(f.id)).toBe("confirmed");
        }
        expect(ran.every((r) => r.length <= budget.findingsPerRun)).toBe(true);
        expect(ran.map((r) => r.length)).toEqual([1, 1, 1, 1]);
    });
});

describe("withinBudget when the work ignores the abort", () => {
    it("ends the finding at minutesEach", async () => {
        const t0 = Date.now();
        const p = withinBudget([1], () => new Promise<number>(() => undefined), { findingsPerRun: 30, minutesEach: 0.001 });
        const r = await Promise.race([p.then((x) => JSON.stringify(x)), new Promise<string>((res) => setTimeout(() => res("still pending after 1500 ms"), 1500))]);
        expect(Date.now() - t0).toBeLessThan(1500);
        expect(JSON.parse(r).timedOut).toHaveLength(1);
    });
});

describe("reset hook: checked origin equals sent origin", () => {
    it("for tricky addresses", () => {
        const app = "http://127.0.0.1:5591/app/";
        const urls = ["/reset", "reset", "//evil.test/reset", "\\\\evil.test/reset", "/\\evil.test/reset", "http:evil.test/reset", "http:/evil.test", "HTTP://127.0.0.1:5591/r", "http://127.0.0.1:5591./r", "http://127.0.0.1:80/r", "http://[::1]:5591/r", "http://0x7f.1:5591/r", "http://2130706433:5591/r", "http://user@127.0.0.1:5591/r", "http://:@127.0.0.1:5591/r", "http://127.0.0.1:5591@evil.test/r", "http://evil.test#@127.0.0.1:5591/r", "http://127.0.0.1:05591/r", "http://127.0.0.1:5591\t/r", " http://evil.test/r", "\nhttp://evil.test/r", "?x", "#y", "", "javascript:alert(1)", "data:text/plain,x", "blob:http://127.0.0.1:5591/x", "ws://127.0.0.1:5591/r", "https://127.0.0.1:5591/r"];
        const bad: string[] = [];
        for (const u of urls) {
            const why = resetHookProblem({ method: "POST", url: u }, app);
            if (why) continue;
            let sent = "";
            try { sent = resetTarget(u, app).toString(); } catch (e) { sent = `refused: ${String(e)}`; }
            if (!sent.startsWith("http://127.0.0.1:5591/")) bad.push(`${JSON.stringify(u)} -> ${sent}`);
        }
        expect(bad).toEqual([]);
        expect(resetHookProblem({ method: "POST", url: "blob:http://127.0.0.1:5591/x" }, app)).toMatch(/not an http\(s\) address/);
    });
});
