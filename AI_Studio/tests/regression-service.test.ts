/**
 * Regression intelligence (Phase 6 X1, spec G6), browser-free: the attempts are a scripted executor, everything else is the real platform
 * (SQLite, routes by inject). G6: Fixed only after passing attempts on the fixed build; a "Fixes #n" pull request that does not fix is not
 * Fixed ("Fix claimed — still reproduces"); a fixed Confirmed finding's test is added to the Regression suite; reopen on return. Also:
 * only an issue reference or a person links a fix (a mention or a change near the finding does not), the related tests are a
 * recommendation (nothing selected or run), and only the engine makes a finding Fixed.
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
import type { CodeHostStore } from "../src/platform/code-host/store.js";
import { checkFix, checkFixesOfDeployment, claimFix, findingsFixedBy, fixReferences, reopenReturned, REGRESSION_SUITE, STILL_REPRODUCES } from "../src/platform/findings/regression-service.js";
import { harvestExecutionFindings, type VerifyDeps } from "../src/platform/findings/verify-service.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { getScheduleServices } from "../src/platform/schedule-services.js";
import { RECOMMENDATION_NOTE } from "../src/platform/selection/preview.js";
import { buildServer } from "../src/platform/server.js";
import { SuiteStore } from "../src/platform/suite-store.js";

const KEY = "regression-owner-key-5e6f7a8b";
const HEAD = "a".repeat(40);
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
let store: CandidateFindingStore;

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-regression-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "regression-test-secret-key-0123456789", API_KEY: KEY, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.ready();
    store = new CandidateFindingStore(platform.sql);
});

afterAll(async () => {
    await server?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const check = { action: "assert", check: "exactText", locator: { by: "testId", value: "total" }, expected: "$21.00", source: "R-2" };
const web = (testId: string, title: string, page: string) =>
    TestSpecSchema.parse({ testId, title, kind: "web", category: "Cart", source: { origin: "browser-agent", requirements: ["R-2"] }, steps: [{ action: "navigate", url: page }, check] });

const run = (testId: string, outcome: "pass" | "fail", i: number, n: number): ScriptRun => ({
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
/** The attempts' outcomes, in order; records what each call was asked. */
const scripted = (outcomes: Array<"pass" | "fail">, asked: unknown[] = []): VerifyDeps["execute"] => async (_a, batch, _e, opts) => {
    asked.push(opts);
    const id = batch.scripts[0]!.testId;
    return outcomes.map((o, i) => run(id, o, i + 1, outcomes.length));
};

interface Seed {
    projectId: string;
    bug: string;
    related: string;
    findingId: string;
}

/** A project with a confirmed bug (its test failed in a run), a test of the same page, one of another page, and an issue #12 filed from it. */
async function seed(name: string, repo = "acme/shop"): Promise<Seed> {
    const projectId = String(platform.repo.createProject({ name }).id);
    const appId = platform.repo.createApplication(projectId, "http://127.0.0.1:5591", { ...DEFAULT_JOB_OPTIONS });
    const suiteId = platform.repo.getOrCreateSuite(projectId, "Cart", "cart");
    const add = (spec: ReturnType<typeof web>) => platform.repo.insertTest({ projectId, suiteId, jobId: null, spec, framework: "playwright", validationStatus: "VALIDATED" });
    const bugSpec = web("WEB-001", "Cart total of two lines", "/cart");
    const bug = add(bugSpec);
    const related = add(web("WEB-002", "Cart shows its lines", "/cart"));
    add(web("WEB-003", "About page", "/about"));
    const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [bug] });
    const t = platform.repo.getTest(bug)!;
    const [f] = await harvestExecutionFindings(store, { projectId, jobId: job.id, failed: [{ test: { id: t.id, title: t.title, spec: t.spec, meta: t.generationMeta, testKey: t.testKey, framework: t.framework }, run: run("WEB-001", "fail", 1, 1) }] });
    platform.repo.setJobStatus(job.id, "COMPLETED");
    await store.transition(projectId, f!.id, { to: "verification_pending", by: "engine" });
    await store.transition(projectId, f!.id, { to: "reproduced", by: "engine", set: { confidence: { confidence: "high", factors: [] } as never } });
    await store.transition(projectId, f!.id, { to: "confirmed", by: "engine" });
    platform.db.run("INSERT INTO issue_links (id, test_case_id, integration_id, provider, external_id, url, title, created_at) VALUES (?,?,?,?,?,?,?,?)", `link-${projectId}`, bug, null, "github", "#12", `https://github.com/${repo}/issues/12`, "Cart total", new Date().toISOString());
    return { projectId, bug, related, findingId: f!.id };
}

/** A connected repository whose pull request #5 (head HEAD) has these commit messages. */
const codeHost = (messages: string[], title = "Cart fixes"): CodeHostStore =>
    ({ client: () => ({ pr: async () => ({ number: 5, title }), commits: async () => messages.map((message, i) => ({ sha: String(i).repeat(40), message })) }), get: () => ({ owner: "acme", repo: "shop" }) }) as never;
const prOpened = (projectId: string) =>
    platform.db.run("INSERT INTO pr_events (id, project_id, delivery_id, event, action, pr, head_sha, received_at) VALUES (?,?,?,?,?,?,?,?)", `ev-${projectId}`, projectId, `d-${projectId}`, "pull_request", "opened", 5, HEAD, new Date().toISOString());
const jobsOf = (projectId: string) => platform.db.all<{ id: string; options_json: string }>("SELECT id, options_json FROM generation_jobs WHERE project_id = ? ORDER BY created_at", projectId);
const reasons = async (s: Seed) => (await store.history(s.projectId, s.findingId)).map((e) => e.reason ?? "");
const regressionTests = async (projectId: string) => {
    const suite = await new SuiteStore(platform.sql).findByName(projectId, REGRESSION_SUITE);
    return suite ? new SuiteStore(platform.sql).testIds(suite.id) : [];
};

describe("fix references", () => {
    it("reads Fixes, Closes and Resolves #n, not a plain mention", () => {
        expect(fixReferences("Fixes #12\ncloses #3, resolved: #3. See #40; fix #7")).toEqual(["#12", "#3", "#7"]);
        expect(fixReferences("Refactor the cart, see #12 and PR #9")).toEqual([]);
    });
});

describe("a pull request that says it fixes a filed bug", () => {
    it("is checked on the deployed build: Fixed only when every attempt passes, and its test joins the Regression suite", async () => {
        const s = await seed("Fixed shop");
        prOpened(s.projectId);
        const claimed = await checkFixesOfDeployment(platform, codeHost(["Recount the last line", "Fixes #12"]), s.projectId, HEAD);
        expect(claimed.jobId, JSON.stringify(claimed)).toBeTruthy();
        const job = platform.repo.getJob(claimed.jobId!)!;
        expect(job.options).toMatchObject({ mode: "verify", testIds: [s.bug], fixCheck: { findingIds: [s.findingId], by: "issue", source: "pull request #5", headSha: HEAD } });
        expect((await store.get(s.projectId, s.findingId))!.state).toBe("confirmed");

        const asked: unknown[] = [];
        const done = await checkFix(platform, job, { execute: scripted(["pass", "pass", "pass"], asked) });
        expect(done).toMatchObject([{ id: s.findingId, fixed: true, related: [s.related] }]);
        expect(asked).toMatchObject([{ attempts: 3, video: false }]);
        expect((await store.get(s.projectId, s.findingId))!.state).toBe("fixed");
        const said = await reasons(s);
        expect(said).toContainEqual(expect.stringMatching(/^Fix claimed by pull request #5: it is checked on the fixed build/));
        expect(said).toContainEqual(expect.stringMatching(/^Fixed: it passed in 3 of 3 attempts .* on the build of aaaaaaa, after the fix pull request #5 claimed\.$/));
        expect(said.at(-1)).toContain(`Its test WEB-001 is in the “${REGRESSION_SUITE}” suite now. Tests of the same area to run next: WEB-002. ${RECOMMENDATION_NOTE}`);
        expect(await regressionTests(s.projectId)).toEqual([s.bug]);
        // The related tests are a recommendation: no run was started for them, and nothing is selected.
        expect(jobsOf(s.projectId)).toHaveLength(2);
        expect(platform.db.all("SELECT id FROM pr_selections WHERE project_id = ?", s.projectId)).toHaveLength(0);
        // Fixed is closed: another claim is refused.
        expect((await claimFix(platform, s.projectId, { findingIds: [s.findingId], by: "person", source: "Dana" })).refused[0]!.why).toMatch(/this one is Fixed/);

        // The bug comes back: a run in which its test fails reopens it (onJobFinished), and the channels hear of it; a passing run does not.
        const appId = platform.repo.getLatestApplicationPublic(s.projectId)!.id as string;
        const again = async (status: "passed" | "failed") => {
            const r = await platform.repo.createJob(s.projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [s.bug] });
            platform.repo.addExecution({ testId: s.bug, scriptId: null, jobId: r.id, attempt: 1, status, durationMs: 1, startedAt: new Date().toISOString(), steps: [] });
            platform.repo.setJobStatus(r.id, "COMPLETED");
            return platform.repo.getJob(r.id)!;
        };
        expect(await reopenReturned(platform, await again("passed"))).toEqual([]);
        expect((await store.get(s.projectId, s.findingId))!.state).toBe("fixed");
        const back = await again("failed");
        await getScheduleServices(platform).onJobFinished(back);
        await getScheduleServices(platform).flush();
        expect((await store.get(s.projectId, s.findingId))!.state).toBe("verification_pending");
        expect((await reasons(s)).at(-1)).toBe(`Reopened: the bug came back (WEB-001 failed again in run ${back.id.slice(0, 8)}).`);
    });

    it("that does not fix it leaves it Confirmed: Fix claimed — still reproduces, and no Regression test", async () => {
        const s = await seed("Still broken shop");
        prOpened(s.projectId);
        const claimed = await checkFixesOfDeployment(platform, codeHost([], "Fixes #12: recount the cart"), s.projectId, HEAD);
        const done = await checkFix(platform, platform.repo.getJob(claimed.jobId!)!, { execute: scripted(["pass", "fail", "pass"]) });
        expect(done).toMatchObject([{ fixed: false }]);
        expect((await store.get(s.projectId, s.findingId))!.state).toBe("confirmed");
        expect((await reasons(s)).at(-1)).toMatch(new RegExp(`^${STILL_REPRODUCES}: it failed in 1 of 3 attempts on the build of aaaaaaa \\(pull request #5\\)\\.`));
        expect(await regressionTests(s.projectId)).toEqual([]);
    });

    it("whose attempts cannot run is not Fixed either", async () => {
        const s = await seed("Runner off shop");
        const claimed = await claimFix(platform, s.projectId, { findingIds: [s.findingId], by: "issue", source: "pull request #5", headSha: HEAD });
        const done = await checkFix(platform, platform.repo.getJob(claimed.jobId!)!, { execute: async () => { throw new Error("The runner is offline."); } });
        expect(done).toMatchObject([{ fixed: false, reason: "Fix claimed — not checked: The runner is offline." }]);
        expect((await store.get(s.projectId, s.findingId))!.state).toBe("confirmed");
    });
});

describe("what links a fix", () => {
    it("only a Fixes reference to an issue of this repository filed from the finding; a mention, another issue or another repository does not", async () => {
        const s = await seed("Linked shop");
        const other = await seed("Other repository shop", "someone/else");
        expect((await findingsFixedBy(platform, s.projectId, "Fixes #12", { owner: "acme", repo: "shop" })).map((f) => f.id)).toEqual([s.findingId]);
        expect(await findingsFixedBy(platform, s.projectId, "Touches /cart, the page of #12", { owner: "acme", repo: "shop" })).toEqual([]);
        expect(await findingsFixedBy(platform, s.projectId, "Fixes #13", { owner: "acme", repo: "shop" })).toEqual([]);
        expect(await findingsFixedBy(platform, other.projectId, "Fixes #12", { owner: "acme", repo: "shop" })).toEqual([]);
        // A pull request that only changes the finding's area (the impact analysis lists it) claims nothing: no check is queued.
        prOpened(s.projectId);
        expect(await checkFixesOfDeployment(platform, codeHost(["Rework the cart page"]), s.projectId, HEAD)).toEqual({ skipped: "Pull request #5 names no issue filed from a confirmed finding (“Fixes #n”)." });
        expect(jobsOf(s.projectId)).toHaveLength(1);
        // A deployment of a commit that is no pull request's head is not traced.
        expect((await checkFixesOfDeployment(platform, codeHost(["Fixes #12"]), s.projectId, "b".repeat(40))).skipped).toMatch(/No pull request/);
    });

    it("a person's Check the fix queues the same check; nobody but the engine makes a finding Fixed", async () => {
        const s = await seed("Person shop");
        const call = (fid: string, body: unknown) => server.inject({ method: "POST", url: `/api/projects/${s.projectId}/findings/${fid}/transition`, headers: { "x-api-key": KEY }, payload: body as object });
        const res = await call(s.findingId, { action: "check_fix" });
        expect(res.statusCode, res.body).toBe(200);
        const jobId = (JSON.parse(res.body) as { fixCheck: { jobId: string } }).fixCheck.jobId;
        expect(platform.repo.getJob(jobId)!.options.fixCheck).toMatchObject({ findingIds: [s.findingId], by: "person" });
        expect((await store.history(s.projectId, s.findingId)).at(-1)).toMatchObject({ by: "person", from: "confirmed", to: "confirmed", reason: expect.stringMatching(/^Fix claimed by .*: it is checked on the fixed build/) });
        expect((await call(s.findingId, { action: "fixed" })).statusCode).toBe(400);
        await expect(store.transition(s.projectId, s.findingId, { to: "fixed", by: "person" })).rejects.toThrow(/Only the engine/);
        // A finding nobody stands behind yet is not checked for a fix.
        const fresh = (await store.upsert({ projectId: s.projectId, testId: s.related, finding: { ...(await store.get(s.projectId, s.findingId))!.finding, fingerprint: "f".repeat(64) } })).finding.id;
        const refused = await call(fresh, { action: "check_fix" });
        expect(refused.statusCode).toBe(409);
        expect(JSON.parse(refused.body).error).toMatch(/A fix is checked on a confirmed finding; this one is Candidate/);
    });
});
