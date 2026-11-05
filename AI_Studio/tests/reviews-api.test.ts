/**
 * Review and approval of test versions, against a stand-in Crowd4Test
 * sign-in (port 7750): which changes start as drafts under the project's policy, who may approve (Project Admin with the
 * permission, never their own change unless they are the only one and the policy allows it, testers included), rejecting and asking
 * for changes, the activity log, sync status, the review queue, drafts left out of runs and schedules, the run recording the
 * version it ran, and the upgrade marking existing tests approved.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHeartbeat } from "../src/platform/ops/heartbeat.js";
let stopBeat: (() => void) | undefined;
import { loadConfig } from "../src/config.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { runAs, type Actor } from "../src/platform/auth/actor.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { customRunInputs } from "../src/platform/custom-run.js";
import { CustomScriptStore } from "../src/platform/custom-script-store.js";
import { Db } from "../src/platform/db.js";
import { runJob } from "../src/platform/job-runner.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { RepoSink } from "../src/platform/repo-sink.js";
import { triggeredEvents } from "../src/platform/alerts.js";
import { draftRunNote, isNothingRan, pinRunVersions, REVIEW_MIGRATION, ReviewStore } from "../src/platform/review-store.js";
import { summarizeJob } from "../src/platform/trends.js";
import { CHANGED_WHILE_READING, NOT_A_REVIEWER, OWN_CHANGE } from "../src/platform/routes/reviews.js";
import { buildServer } from "../src/platform/server.js";

type App = Awaited<ReturnType<typeof buildServer>>;
const KEY = "reviews-owner-key-77a1c3";
const PAGE = { "x-requested-with": "ai-studio" };
const API_PORT = 7750;
const dirs: string[] = [];

const me = (id: string, role: string, permissions: readonly string[], organisationId: string | null = null) => ({
    data: { user: { id, email: `${id}@people.example`, role, status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions, organisationId } },
});
const ACCOUNTS: Record<string, unknown> = {
    "t-ann": me("ann", "CUSTOMER", PERMISSIONS, "org-a"),
    "t-ben": me("ben", "CUSTOMER", PERMISSIONS, "org-a"),
    "t-cat": me("cat", "CUSTOMER", PERMISSIONS, "org-a"),
    "t-wes": me("wes", "CUSTOMER", ["ai_studio.access", "ai_studio.tests.write"], "org-a"),
    "t-tom": me("tom", "TESTER", PERMISSIONS),
    "t-sol": me("sol", "CUSTOMER", PERMISSIONS, "org-b"),
};

let api: http.Server;
let platform: Platform;
let app: App;

const call = (headers: Record<string, string>, method: string, url: string, payload?: unknown) =>
    app
        .inject({ method: method as "GET", url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) })
        .then((r) => ({ status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body }));
const asKey = (method: string, url: string, payload?: unknown) => call({ "x-api-key": KEY }, method, url, payload);
const as = (token: string, method: string, url: string, payload?: unknown) => call({ cookie: `c4t_access=${token}`, ...(method === "GET" ? {} : PAGE) }, method, url, payload);
const ids = new Map<string, string>();
const personOf = async (token: string): Promise<string> => {
    if (!ids.has(token)) ids.set(token, (await as(token, "GET", "/api/auth/state")).body.me.id);
    return ids.get(token)!;
};
const addMember = async (projectId: string, token: string, projectAdmin = false) =>
    accessControlOf(app).projects.store.addMember(projectId, await personOf(token), { role: "owner", projectAdmin, source: "added", addedBy: "test" });
const actorFor = async (token: string): Promise<Actor> => ({ kind: "user", id: await personOf(token), name: token.slice(2), role: "owner" });

const spec = (testId: string, title: string, path = "/"): TestSpec => TestSpecSchema.parse({ testId, title, kind: "web", category: "Smoke", priority: "high", steps: [{ action: "navigate", url: path }] });
const newTest = (projectId: string, s: TestSpec, source: "ai" | "person" | "upgrade" = "ai") =>
    platform.repo.insertTest({ projectId, suiteId: platform.repo.getOrCreateSuite(projectId, "Smoke", "smoke"), jobId: null, spec: s, framework: "playwright", validationStatus: "PENDING", versionSource: source });
const review = (token: string, testId: string) => as(token, "GET", `/api/tests/${testId}/review`);
const version = (token: string, testId: string, v: number) => as(token, "GET", `/api/tests/${testId}/review/${v}`);
const activity = (projectId: string) => platform.db.all<{ action: string; detail: string; actor_name: string }>("SELECT action, detail, actor_name FROM activity WHERE project_id = ? ORDER BY id", projectId);

beforeAll(async () => {
    api = http.createServer((req, res) => {
        const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        res.writeHead(ACCOUNTS[auth] ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ACCOUNTS[auth] ?? { error: { message: "Invalid access token" } }));
    });
    await new Promise<void>((r) => api.listen(API_PORT, "127.0.0.1", r));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-reviews-"));
    dirs.push(dataDir);
    platform = bootstrap(
        loadConfig({ DATA_DIR: dataDir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECRET_KEY: "reviews-test-secret-key-0123456789", C4T_API_ORIGIN: `http://127.0.0.1:${API_PORT}`, C4T_SITE_URL: "https://crowd4test.example" }),
    );
    // A worker in another process says it is alive, so runs and explorations are queued (and nothing here runs them).
    stopBeat = startHeartbeat(platform.db);
    app = await buildServer(platform);
    await app.ready();
}, 60_000);

afterAll(async () => {
    stopBeat?.();
    await app?.close();
    platform?.db.close();
    await new Promise((r) => api?.close(r));
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("the upgrade", () => {
    it("marks every existing test approved, with a person's code and the script made from the steps", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-reviews-upgrade-"));
        dirs.push(dir);
        const db = new Db(path.join(dir, "u.db"));
        const t = "2026-01-01T00:00:00.000Z";
        db.run("INSERT INTO users (id, email, created_at) VALUES ('u1', 'u1@x', ?)", t);
        db.run("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES ('p1', 'u1', 'Old', ?, ?)", t, t);
        db.run("INSERT INTO test_suites (id, project_id, name, slug, created_at) VALUES ('s1', 'p1', 'S', 's', ?)", t);
        for (const id of ["t1", "t2"]) {
            db.run("INSERT INTO test_cases (id, project_id, suite_id, test_key, title, kind, type, priority, validation_status, framework, spec_json, created_at, updated_at) VALUES (?, 'p1', 's1', ?, 'T', 'web', 'functional', 'high', 'VALIDATED', 'playwright', '{\"a\":1}', ?, ?)", id, id.toUpperCase(), t, t);
            db.run("INSERT INTO generated_scripts (id, test_case_id, framework, filename, content, content_hash, version, is_current, executable, created_at) VALUES (?, ?, 'playwright', 'f.ts', ?, 'h', 1, 1, 1, ?)", `sc-${id}`, id, `code of ${id}`, t);
        }
        db.run("INSERT INTO custom_tests (test_case_id, project_id, origin, since) VALUES ('t2', 'p1', 'taken-over', ?)", t);
        // The new tables exist on this fresh database: what the upgrade adds is its INSERT, run as on an existing one.
        db.raw.exec(REVIEW_MIGRATION.slice(REVIEW_MIGRATION.indexOf("INSERT INTO test_versions")));
        const store = new ReviewStore(db);
        expect(store.approved("t1")).toMatchObject({ version: 1, state: "approved", source: "upgrade", code: null, scriptId: "sc-t1", auto: true });
        expect(store.approved("t2")).toMatchObject({ version: 1, state: "approved", code: "code of t2", scriptId: null });
        expect(store.sync(store.approved("t1")!)).toBe("in_sync");
        // Unchanged content is not a new version.
        expect(store.track("t1")?.version).toBe(1);
        db.close();
    });
});

describe("policy and states", () => {
    let projectId = "";
    let testId = "";

    it("starts with everything needing approval, and only someone who approves here may change it (recorded in the activity log)", async () => {
        projectId = (await as("t-ann", "POST", "/api/projects", { name: "Reviewed shop" })).body.id;
        platform.repo.createApplication(projectId, "http://127.0.0.1:9/", {});
        await addMember(projectId, "t-ben", true);
        await addMember(projectId, "t-cat", false);
        await addMember(projectId, "t-wes", false);
        await addMember(projectId, "t-tom", false);
        expect((await as("t-ann", "GET", `/api/projects/${projectId}/review-policy`)).body).toEqual({ aiGenerated: true, edits: true, healing: true, soleAdminSelfApprove: true });
        expect((await as("t-wes", "PUT", `/api/projects/${projectId}/review-policy`, { edits: false })).status).toBe(403);
        // Project settings alone is not enough: a member who is not a Project Admin, and a tester, cannot switch review off.
        expect((await as("t-cat", "PUT", `/api/projects/${projectId}/review-policy`, { edits: false })).status).toBe(403);
        expect((await as("t-tom", "PUT", `/api/projects/${projectId}/review-policy`, { aiGenerated: false, edits: false, healing: false })).status).toBe(403);
        expect((await as("t-ben", "GET", `/api/projects/${projectId}/review-policy`)).body.edits).toBe(true);
        expect((await as("t-ann", "PUT", `/api/projects/${projectId}/review-policy`, { healing: false })).body.healing).toBe(false);
        expect((await as("t-ann", "PUT", `/api/projects/${projectId}/review-policy`, { healing: true })).body.healing).toBe(true);
        expect(activity(projectId).filter((a) => a.action === "changed the review policy").map((a) => a.detail)).toEqual(["repairs after a failed run: off", "repairs after a failed run: on"]);
    });

    it("makes an AI-written test a draft, and a draft is brought up to date while nobody looked at it", async () => {
        testId = newTest(projectId, spec("WEB-001", "Home page"));
        platform.repo.updateTest(testId, { spec: spec("WEB-001", "Home page", "/home"), versionSource: "ai" });
        const r = (await review("t-ann", testId)).body;
        expect(r.approvedVersion).toBeNull();
        expect(r.versions).toHaveLength(1);
        expect(r.versions[0]).toMatchObject({ version: 1, state: "draft", source: "ai", author: "AI", sync: "text_changed" });
    });

    it("lets nobody but a Project Admin with the permission decide: testers, plain members and writers are refused", async () => {
        const v = (await version("t-ann", testId, 1)).body;
        expect(v.text).toMatch(/Home page/);
        expect(v.code).toMatch(/goto/);
        expect(v.actions).toMatchObject({ approve: true, reject: true, requestChanges: true, comment: true });
        for (const who of ["t-cat", "t-tom"]) {
            const r = await as(who, "POST", `/api/tests/${testId}/review/1/approve`, { seen: v.updatedAt });
            expect(r).toMatchObject({ status: 403, body: { error: NOT_A_REVIEWER } });
            expect((await version(who, testId, 1)).body.actions).toMatchObject({ approve: false, reject: false });
        }
        expect((await as("t-wes", "POST", `/api/tests/${testId}/review/1/approve`, { seen: v.updatedAt })).status).toBe(403);
        // Someone of another organisation does not even see it.
        expect((await as("t-sol", "GET", `/api/tests/${testId}/review/1`)).status).toBe(404);
        // A tester may still comment and send a draft to review (they may edit tests).
        expect((await as("t-tom", "POST", `/api/tests/${testId}/review/1/comments`, { body: "Looks fine to me" })).body.comments).toHaveLength(1);
        expect((await as("t-tom", "POST", `/api/tests/${testId}/review/1/submit`, {})).body.state).toBe("in_review");
    });

    it("refuses an approval of a draft that changed since it was read, then approves; the activity log has it", async () => {
        expect((await as("t-ann", "POST", `/api/tests/${testId}/review/1/approve`, { seen: "2000-01-01T00:00:00.000Z" })).body.error).toBe(CHANGED_WHILE_READING);
        const v = (await version("t-ann", testId, 1)).body;
        const ok = await as("t-ann", "POST", `/api/tests/${testId}/review/1/approve`, { seen: v.updatedAt, note: "Checked the steps" });
        expect(ok.body).toMatchObject({ state: "approved", decision: { by: "ann Person", note: "Checked the steps" } });
        expect((await as("t-ben", "POST", `/api/tests/${testId}/review/1/reject`, { reason: "late" })).status).toBe(409);
        expect(activity(projectId).find((a) => a.action === "approved a test version")).toMatchObject({ actor_name: "ann Person", detail: "WEB-001 version 1. Checked the steps" });
    });

    it("never lets a person approve their own edit while another Project Admin exists", async () => {
        const saved = await as("t-ann", "PUT", `/api/tests/${testId}/spec`, { spec: spec("WEB-001", "Home page, edited", "/home"), run: false });
        expect(saved.status).toBe(200);
        const r = (await review("t-ann", testId)).body;
        expect(r.versions.map((x: { version: number; state: string }) => [x.version, x.state])).toEqual([
            [2, "draft"],
            [1, "approved"],
        ]);
        expect(r.versions[0]).toMatchObject({ source: "person", author: "ann Person" });
        const v = (await version("t-ann", testId, 2)).body;
        expect(v.actions).toMatchObject({ approve: false, approveBlocked: OWN_CHANGE });
        expect(v.approved.version).toBe(1);
        expect(v.text).toMatch(/edited/);
        expect((await as("t-ann", "POST", `/api/tests/${testId}/review/2/approve`, { seen: v.updatedAt })).body.error).toBe(OWN_CHANGE);
        // Another Project Admin asks for changes: back to draft with the comment.
        expect((await as("t-ben", "POST", `/api/tests/${testId}/review/2/request-changes`, { comment: "" })).status).toBe(400);
        expect((await as("t-ben", "POST", `/api/tests/${testId}/review/2/request-changes`, { comment: "Name the page" })).body.state).toBe("draft");
        expect((await version("t-ann", testId, 2)).body.comments.map((c: { kind: string; body: string }) => [c.kind, c.body])).toEqual([["changes", "Name the page"]]);
        // A rejection needs a reason.
        expect((await as("t-ben", "POST", `/api/tests/${testId}/review/2/reject`, { reason: " " })).status).toBe(400);
        expect((await as("t-ben", "POST", `/api/tests/${testId}/review/2/reject`, { reason: "Wrong page" })).body).toMatchObject({ state: "rejected", decision: { note: "Wrong page" } });
        expect(activity(projectId).filter((a) => /test version$/.test(a.action) && a.action !== "approved a test version").map((a) => a.action)).toEqual(["asked for changes to a test version", "rejected a test version"]);
        // Version 1 is still the one that runs.
        expect(new ReviewStore(platform.db).approved(testId)?.version).toBe(1);
    });

    it("lets the only Project Admin approve their own change when the policy allows it, and not when it does not", async () => {
        const solo = (await as("t-ann", "POST", "/api/projects", { name: "Solo shop" })).body.id;
        const t = await runAs(await actorFor("t-ann"), async () => newTest(solo, spec("WEB-001", "Solo"), "person"));
        const v = (await version("t-ann", t, 1)).body;
        expect(v).toMatchObject({ state: "draft", source: "person", actions: { approve: true } });
        await as("t-ann", "PUT", `/api/projects/${solo}/review-policy`, { soleAdminSelfApprove: false });
        expect((await as("t-ann", "POST", `/api/tests/${t}/review/1/approve`, { seen: v.updatedAt })).body.error).toBe(OWN_CHANGE);
        await as("t-ann", "PUT", `/api/projects/${solo}/review-policy`, { soleAdminSelfApprove: true });
        expect((await as("t-ann", "POST", `/api/tests/${t}/review/1/approve`, { seen: v.updatedAt })).body.state).toBe("approved");
    });

    it("approves at once what the policy does not ask about, and a newer approval supersedes the one before", async () => {
        await as("t-ann", "PUT", `/api/projects/${projectId}/review-policy`, { aiGenerated: false });
        const t = newTest(projectId, spec("WEB-002", "Cart"));
        expect((await review("t-ann", t)).body.versions[0]).toMatchObject({ state: "approved", auto: true });
        platform.repo.updateTest(t, { spec: spec("WEB-002", "Cart", "/cart"), versionSource: "ai" });
        expect((await review("t-ann", t)).body.versions.map((x: { state: string }) => x.state)).toEqual(["approved", "superseded"]);
        await as("t-ann", "PUT", `/api/projects/${projectId}/review-policy`, { aiGenerated: true });
    });
});

describe("sync status of a person's code", () => {
    it("is in sync after a take-over, code changed after an edit, and needs regeneration when a change to the steps was refused", async () => {
        const projectId = (await as("t-ann", "POST", "/api/projects", { name: "Code shop" })).body.id;
        await as("t-ann", "PUT", `/api/projects/${projectId}/review-policy`, { aiGenerated: false });
        const t = newTest(projectId, spec("WEB-001", "Code test"));
        const script = (content: string) => platform.repo.addScript(t, { framework: "playwright", filename: "w.spec.ts", content, hash: content, storagePath: "x", executable: true });
        script("generated code");
        const custom = new CustomScriptStore(platform.db);
        custom.mark(t, projectId, { origin: "taken-over", specArchive: platform.repo.getTest(t)!.spec });
        custom.addVersion(t, { content: "generated code", kind: "taken-over", force: true });
        const store = new ReviewStore(platform.db);
        store.track(t, "takeover");
        expect(store.latest(t)).toMatchObject({ version: 2, state: "approved", source: "takeover", code: "generated code" });
        expect(store.sync(store.latest(t)!)).toBe("in_sync");
        await runAs(await actorFor("t-ben"), async () => script("edited code"));
        expect(store.latest(t)).toMatchObject({ version: 3, state: "draft", source: "person", code: "edited code" });
        expect(store.sync(store.latest(t)!)).toBe("code_changed");
        // A repair tries to change the steps: the code is not touched, and the version says so.
        platform.repo.updateTest(t, { spec: spec("WEB-001", "Code test", "/elsewhere"), versionSource: "healing" });
        expect(store.latest(t)).toMatchObject({ version: 3, code: "edited code" });
        expect(store.sync(store.latest(t)!)).toBe("needs_regeneration");
        const list = (await as("t-ann", "GET", `/api/projects/${projectId}/scripts`)).body;
        expect(list.scripts[0]).toMatchObject({ testKey: "WEB-001", custom: true, approvedVersion: 2, waiting: false, latest: { version: 3, state: "draft", sync: "needs_regeneration", author: "ben" } });
    });
});

describe("the review queue", () => {
    it("lists drafts across the projects the person may approve in, says which are theirs, and is empty for others", async () => {
        const reviewed = (await as("t-ann", "GET", "/api/projects")).body.find((p: { name: string }) => p.name === "Reviewed shop").id;
        await runAs(await actorFor("t-ann"), async () => newTest(reviewed, spec("WEB-009", "Checkout"), "person"));
        const mine = (await as("t-ben", "GET", "/api/reviews")).body;
        expect(mine.reviewer).toBe(true);
        const titles = mine.items.map((i: { title: string; projectName: string }) => `${i.projectName}: ${i.title}`);
        expect(titles).toContain("Reviewed shop: Checkout");
        expect(mine.items.find((i: { title: string }) => i.title === "Checkout")).toMatchObject({ yours: false, canApprove: true, author: "ann", state: "draft", testKey: "WEB-009" });
        expect(titles.some((t: string) => t.startsWith("Solo shop"))).toBe(false); // ben is not on that project
        expect(mine.items.every((i: { state: string }) => i.state === "draft" || i.state === "in_review")).toBe(true);
        const ann = (await as("t-ann", "GET", "/api/reviews")).body;
        expect(ann.items.find((i: { title: string }) => i.title === "Home page, edited")).toBeUndefined(); // rejected: no longer open
        expect(ann.items.find((i: { title: string }) => i.title === "Checkout")).toMatchObject({ yours: true, canApprove: false });
        expect((await as("t-wes", "GET", "/api/reviews")).body).toEqual({ reviewer: false, items: [] });
        expect((await as("t-tom", "GET", "/api/reviews")).body).toEqual({ reviewer: false, items: [] });
        expect((await as("t-sol", "GET", "/api/reviews")).body.items).toEqual([]);
    });
});

describe("drafts never run", () => {
    let projectId = "";
    let appId = "";
    let approvedThenEdited = "";
    let draftOnly = "";

    it("pins each test's approved version, leaves out a test with none, and keeps a newer draft's steps", async () => {
        projectId = (await asKey("POST", "/api/projects", { name: "Run shop" })).body.id;
        appId = platform.repo.createApplication(projectId, "http://127.0.0.1:9/", {});
        await asKey("PUT", `/api/projects/${projectId}/review-policy`, { aiGenerated: false });
        approvedThenEdited = newTest(projectId, spec("WEB-001", "Approved"));
        await asKey("PUT", `/api/projects/${projectId}/review-policy`, { aiGenerated: true });
        platform.repo.updateTest(approvedThenEdited, { spec: spec("WEB-001", "Approved", "/draft"), versionSource: "ai" });
        draftOnly = newTest(projectId, spec("WEB-002", "Draft only"));
        const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [approvedThenEdited, draftOnly] });
        const pins = pinRunVersions(platform.db, job.id, [approvedThenEdited, draftOnly]);
        expect(pins.waiting).toEqual([draftOnly]);
        expect([...pins.stale]).toEqual([approvedThenEdited]);
        const t = pins.test(platform.repo.getTest(approvedThenEdited)!);
        expect((t.spec.steps[0] as { url: string }).url).toBe("/");
        // A run of the approved version never writes its steps over the newer draft.
        const sink = new RepoSink(platform.repo, platform.store, { id: job.id, projectId, applicationId: appId, mode: "validate" });
        sink.keepSteps = pins.stale;
        await sink.updateTest({ id: approvedThenEdited, testId: "WEB-001" }, { spec: t.spec, validation: "VALIDATED" });
        expect((platform.repo.getTest(approvedThenEdited)!.spec.steps[0] as { url: string }).url).toBe("/draft");
        // Each execution then names the version it ran.
        const exec = platform.repo.addExecution({ testId: approvedThenEdited, scriptId: null, jobId: job.id, attempt: 1, status: "passed", durationMs: 1, startedAt: new Date().toISOString(), steps: [] });
        new ReviewStore(platform.db).finishRun(job.id);
        const v1 = new ReviewStore(platform.db).get(approvedThenEdited, 1)!;
        expect(platform.db.get<{ test_version_id: string }>("SELECT test_version_id FROM test_executions WHERE id = ?", exec)!.test_version_id).toBe(v1.id);
        expect((await asKey("GET", `/api/jobs/${job.id}/test-versions`)).body.tests).toEqual(
            expect.arrayContaining([
                { testId: approvedThenEdited, version: 1, outcome: "ran" },
                { testId: draftOnly, version: null, outcome: "waiting" },
            ]),
        );
        platform.repo.setJobStatus(job.id, "FAILED", "test only");
    });

    it("a run of only drafts runs nothing and says why", async () => {
        const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [draftOnly] });
        const claimed = platform.repo.claimNextJob(60_000, "w-reviews")!;
        expect(claimed.id).toBe(job.id);
        await runJob({ ...platform }, claimed, "w-reviews");
        expect(platform.repo.getJob(job.id)).toMatchObject({ status: "FAILED", error: "Nothing ran: the test is waiting for approval." });
        expect(platform.repo.listEvents(job.id).some((e) => e.kind === "waiting_for_approval" && /WEB-002: not run/.test(e.message as string))).toBe(true);
        expect(platform.repo.listExecutions(draftOnly)).toEqual([]);
        // The run page lists it with what to do, and it is held back, not a failure: no alert, and nothing a release should stop for.
        const run = (await asKey("GET", `/api/projects/${projectId}/runs/${job.id}`)).body;
        expect(run.heldBack).toEqual([{ id: draftOnly, testId: "WEB-002", title: "Draft only", version: 1 }]);
        expect(run.tests).toEqual([expect.objectContaining({ id: draftOnly, state: "not_run", reason: "Waiting for approval: only approved versions run." })]);
        const finished = platform.repo.getJob(job.id)!;
        expect(isNothingRan(finished)).toBe(true);
        expect(isNothingRan({ status: "FAILED", error: "Cancelled" })).toBe(false);
        const summary = summarizeJob(platform.repo, finished, "low");
        expect(summary.jobError).toBeNull();
        expect([...triggeredEvents(summary, "low").keys()]).toEqual([]);
    }, 60_000);

    it("a scheduled run leaves drafts out the same way", async () => {
        const sch = await asKey("POST", `/api/projects/${projectId}/schedules`, { kind: "validate", cadence: { type: "daily", time: "02:00" } });
        expect(sch.status).toBe(201);
        await asKey("PUT", `/api/projects/${projectId}/review-policy`, {});
        platform.db.run("DELETE FROM test_cases WHERE id = ?", approvedThenEdited); // only the draft is left
        const run = await asKey("POST", `/api/projects/${projectId}/schedules/${sch.body.id}/run`);
        if (run.status !== 202) throw new Error(JSON.stringify(run.body));
        const claimed = platform.repo.claimNextJob(60_000, "w-reviews")!;
        expect(claimed).toMatchObject({ id: run.body.jobId, options: { trigger: "schedule" } });
        await runJob({ ...platform }, claimed, "w-reviews");
        expect(platform.repo.getJob(claimed.id)).toMatchObject({ status: "FAILED", error: "Nothing ran: the test is waiting for approval." });
    }, 60_000);
});

describe("a person's code that is only a draft", () => {
    it("never runs: the approved steps run instead, also when the code test is in the run's list", async () => {
        const projectId = (await as("t-ann", "POST", "/api/projects", { name: "Draft code shop" })).body.id;
        await as("t-ann", "PUT", `/api/projects/${projectId}/review-policy`, { aiGenerated: false });
        const t = newTest(projectId, spec("WEB-001", "Approved steps"));
        await as("t-ann", "PUT", `/api/projects/${projectId}/review-policy`, { aiGenerated: true });
        platform.repo.updateTest(t, { spec: spec("WEB-001", "Approved steps", "/draft"), versionSource: "ai" });
        // Queued before the code exists: this server does not run code tests, and the gate is what is being checked here.
        const job = await platform.repo.createJob(projectId, platform.repo.createApplication(projectId, "http://127.0.0.1:9/", {}), { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [t] });
        const custom = new CustomScriptStore(platform.db);
        custom.mark(t, projectId, { origin: "taken-over", specArchive: platform.repo.getTest(t)!.spec });
        platform.repo.addScript(t, { framework: "playwright", filename: "w.spec.ts", content: "unapproved code", hash: "h", storagePath: "x", executable: true });
        const store = new ReviewStore(platform.db);
        expect(store.approved(t)).toMatchObject({ version: 1, code: null });
        expect(store.latest(t)).toMatchObject({ state: "draft", code: "unapproved code" });
        const pins = pinRunVersions(platform.db, job.id, [t]);
        const inputs = customRunInputs(platform.repo, projectId, [t]);
        expect(inputs.byTest.get(t)?.content).toBe("unapproved code");
        pins.applyCustom(inputs);
        expect(inputs.byTest.has(t)).toBe(false);
        expect((pins.test(platform.repo.getTest(t)!).spec.steps[0] as { url: string }).url).toBe("/");
        // The script of that run is its record only: the person's draft stays what the test holds, and stays the draft.
        const appId = platform.repo.getLatestApplicationPublic(projectId)!.id as string;
        const sink = new RepoSink(platform.repo, platform.store, { id: job.id, projectId, applicationId: appId, mode: "validate" });
        sink.keepSteps = pins.stale;
        const made = await sink.saveScript({ id: t, testId: "WEB-001" }, { framework: "playwright", filename: "w.spec.ts", content: "made from the approved steps", language: "typescript" }, true);
        expect(platform.repo.getCurrentScript(t)?.content).toBe("unapproved code");
        expect(platform.db.get<{ is_current: number }>("SELECT is_current FROM generated_scripts WHERE id = ?", made)?.is_current).toBe(0);
        expect(store.latest(t)).toMatchObject({ state: "draft", code: "unapproved code" });
        platform.repo.setJobStatus(job.id, "FAILED", "test only");
    });
});

describe("the run-time check", () => {
    const start = async (projectId: string, appId: string, testId: string) => {
        const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [testId] });
        return job.id;
    };
    const sneak = (testId: string, url: string) => platform.db.run("UPDATE test_cases SET spec_json = ? WHERE id = ?", JSON.stringify(spec("WEB-001", "Sneaked", url)), testId);

    it.each([
        ["the access key", { kind: "key", name: "Access key", role: "owner" }],
        ["open access", { kind: "open", name: "Open access", role: "owner" }],
        ["the platform", { kind: "system", name: "Platform", role: "owner" }],
    ] as Array<[string, Actor]>)("holds back a change that went round the hooks when %s starts the run, in a project with no Project Admin", async (name, actor) => {
        const projectId = (await asKey("POST", "/api/projects", { name: `Bypass by ${name}` })).body.id;
        const appId = platform.repo.createApplication(projectId, "http://127.0.0.1:9/", {});
        const t = newTest(projectId, spec("WEB-001", "Sneaked"), "upgrade");
        sneak(t, "/sneaked");
        const job = await start(projectId, appId, t);
        const pins = runAs(actor, () => pinRunVersions(platform.db, job, [t]));
        const store = new ReviewStore(platform.db);
        expect(store.latest(t)).toMatchObject({ version: 2, state: "draft", auto: false, author: { kind: "system" } });
        expect(store.approved(t)?.version).toBe(1);
        expect([...pins.stale]).toEqual([t]);
        expect((pins.test(platform.repo.getTest(t)!).spec.steps[0] as { url: string }).url).toBe("/");
        platform.repo.setJobStatus(job, "FAILED", "test only");
    });

    it("holds it back even when the policy asks for no approval at all", async () => {
        const projectId = (await asKey("POST", "/api/projects", { name: "No policy shop" })).body.id;
        const appId = platform.repo.createApplication(projectId, "http://127.0.0.1:9/", {});
        await asKey("PUT", `/api/projects/${projectId}/review-policy`, { aiGenerated: false, edits: false, healing: false });
        const t = newTest(projectId, spec("WEB-001", "Sneaked"), "upgrade");
        sneak(t, "/sneaked");
        const job = await start(projectId, appId, t);
        expect(pinRunVersions(platform.db, job, [t]).waiting).toEqual([]);
        expect(new ReviewStore(platform.db).latest(t)).toMatchObject({ version: 2, state: "draft" });
        expect(new ReviewStore(platform.db).approved(t)?.version).toBe(1);
        platform.repo.setJobStatus(job, "FAILED", "test only");
    });

    it("the platform's own edit gets no exception; only an explicit edit by the key or open access does", () => {
        const store = new ReviewStore(platform.db);
        const projectId = platform.repo.createProject({ name: "Own edit shop" }).id as string;
        const t = newTest(projectId, spec("WEB-001", "Edited"), "upgrade");
        sneak(t, "/by-the-platform");
        expect(runAs({ kind: "system", name: "Platform", role: "owner" }, () => store.track(t))).toMatchObject({ version: 2, state: "draft" });
        sneak(t, "/by-the-key");
        expect(store.track(t, undefined, { kind: "key", name: "Access key", role: "owner" })).toMatchObject({ version: 3, state: "approved", auto: true });
        sneak(t, "/by-open-access");
        expect(store.track(t, undefined, { kind: "open", name: "Open access", role: "owner" })).toMatchObject({ version: 4, state: "approved", auto: true });
    });
});

describe("an edit that queues a run", () => {
    it("says the run uses the approved version, not the draft, and that a test with no approved version is left out", async () => {
        const projectId = (await as("t-ann", "POST", "/api/projects", { name: "Edit and run shop" })).body.id;
        platform.repo.createApplication(projectId, "http://127.0.0.1:9/", {});
        const t = newTest(projectId, spec("WEB-001", "Edited"), "upgrade");
        const saved = await as("t-ann", "PUT", `/api/tests/${t}/spec`, { spec: spec("WEB-001", "Edited", "/changed") });
        expect(saved.status).toBe(200);
        expect(saved.body.jobId).toBeTruthy();
        expect(saved.body.note).toBe("The run uses approved version 1, not this draft. A draft runs once a Project Admin approves it.");
        platform.repo.setJobStatus(saved.body.jobId, "FAILED", "test only");

        const neverApproved = newTest(projectId, spec("WEB-002", "Never approved"));
        expect(draftRunNote(platform.db, [neverApproved])).toBe("The run leaves this test out: it has no approved version yet. A draft runs once a Project Admin approves it.");
        expect(draftRunNote(platform.db, [t, neverApproved])).toMatch(/^2 of these 2 tests have a draft\./);
        const approved = newTest(projectId, spec("WEB-003", "Approved"), "upgrade");
        expect(draftRunNote(platform.db, [approved])).toBeUndefined();
    });
});

describe("changes nobody else could review", () => {
    it("approves an edit made with the access key in a project with no Project Admin, and not once the project has one", async () => {
        const projectId = (await asKey("POST", "/api/projects", { name: "Key shop" })).body.id;
        platform.repo.createApplication(projectId, "http://127.0.0.1:9/", {});
        const t = newTest(projectId, spec("WEB-001", "Keyed"), "upgrade");
        await asKey("PUT", `/api/tests/${t}/spec`, { spec: spec("WEB-001", "Keyed", "/a"), run: false });
        expect((await asKey("GET", `/api/tests/${t}/review`)).body.versions[0]).toMatchObject({ version: 2, state: "approved", source: "person", auto: true });
        await addMember(projectId, "t-ben", true);
        await asKey("PUT", `/api/tests/${t}/spec`, { spec: spec("WEB-001", "Keyed", "/b"), run: false });
        expect((await asKey("GET", `/api/tests/${t}/review`)).body.versions[0]).toMatchObject({ version: 3, state: "draft" });
    });
});
