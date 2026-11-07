/**
 * Approved tests stay as approved (approval-deps.ts, review-store.ts `toRun`): a run holds back an approved test whose reusable steps,
 * shared elements or helpers changed after its approval, says so plainly, and makes a version to approve again. Renames and an
 * element's notes are not changes; putting a part back as it was runs the approved version again; a project whose policy does not
 * ask for approval of people's changes approves it again at once; versions approved before the record existed get one at their
 * first run. Driven in-process (no ports).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { changedParts, DEPENDENCY_CHANGED, DepsReader, readDeps } from "../src/platform/approval-deps.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import type { Actor } from "../src/platform/auth/actor.js";
import { BlockStore } from "../src/platform/block-store.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { Db } from "../src/platform/db.js";
import { runJob } from "../src/platform/job-runner.js";
import { startHeartbeat } from "../src/platform/ops/heartbeat.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { pinRunVersions, ReviewStore } from "../src/platform/review-store.js";
import { buildServer } from "../src/platform/server.js";
import { chooseVersionsToRun } from "../src/platform/suite-run.js";

type App = Awaited<ReturnType<typeof buildServer>>;
const KEY = "approval-deps-owner-key-5c1e9a";
const dirs: string[] = [];
let platform: Platform;
let app: App;
let stopBeat: (() => void) | undefined;

const call = (method: string, url: string, payload?: unknown) =>
    app
        .inject({ method: method as "GET", url, headers: { "x-api-key": KEY }, ...(payload !== undefined ? { payload: payload as object } : {}) })
        .then((r) => ({ status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body }));

const spec = (testId: string, title: string, steps: unknown[]): TestSpec => TestSpecSchema.parse({ testId, title, kind: "web", category: "Smoke", priority: "high", steps });
const newTest = (projectId: string, s: TestSpec, source: "ai" | "person" = "ai") =>
    platform.repo.insertTest({ projectId, suiteId: platform.repo.getOrCreateSuite(projectId, "Smoke", "smoke"), jobId: null, spec: s, framework: "playwright", validationStatus: "PENDING", versionSource: source });
const use = (block: string) => ({ action: "useBlock", block });
const button = (value: string) => ({ by: "role", role: "button", value, exact: true });
const loginSteps = (label = "Log in") => [{ action: "navigate", url: "/login" }, { action: "click", locator: button(label) }];
const reviews = () => new ReviewStore(platform.db);
/** Nothing here runs jobs: the revalidation runs the shared pages start are put aside, so they never get in the way of the next pin. */
const clearQueue = () => platform.db.run("UPDATE generation_jobs SET status = 'FAILED', error = 'test only' WHERE status IN ('QUEUED', 'RUNNING')");
const pin = async (projectId: string, appId: string, testIds: string[]) => {
    clearQueue();
    const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds });
    const pins = pinRunVersions(platform.db, job.id, testIds);
    clearQueue();
    return { job, pins, recorded: reviews().runVersions(job.id) };
};
const approveRoute = async (testId: string, version: number) => {
    const v = await call("GET", `/api/tests/${testId}/review/${version}`);
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    const r = await call("POST", `/api/tests/${testId}/review/${version}/approve`, { seen: v.body.updatedAt });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const putBlock = async (projectId: string, name: string, body: Record<string, unknown>) => {
    const r = await call("PUT", `/api/projects/${projectId}/blocks/${encodeURIComponent(name)}`, body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const putElement = async (projectId: string, id: string, body: Record<string, unknown>) => {
    const r = await call("PUT", `/api/projects/${projectId}/objects/${id}`, body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const ADA: Actor = { kind: "user", id: "u-ada", name: "Ada", role: "owner" };
/** A flagged Project Admin: changes made with the access key then wait for review (they are approved at once only in a project with none). */
const addAdmin = (projectId: string) => accessControlOf(app).projects.store.addMember(projectId, ADA.id!, { role: "owner", projectAdmin: true, source: "added", addedBy: "test" });
const newProject = async (name: string, admin = true) => {
    const projectId = (await call("POST", "/api/projects", { name })).body.id as string;
    const appId = platform.repo.createApplication(projectId, "http://127.0.0.1:9/", {}) as string;
    if (admin) addAdmin(projectId);
    return { projectId, appId };
};
/** A change made outside the project's pages (nothing tells the review): only a run's check finds it. */
const changeBlockQuietly = (projectId: string, name: string, steps: unknown[]) => {
    const store = new BlockStore(platform.db);
    const b = store.get(projectId, name)!;
    store.update(projectId, b.id, { name: b.name, kind: b.kind, params: b.params, steps: steps as never });
};

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-approval-deps-"));
    dirs.push(dataDir);
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECRET_KEY: "approval-deps-secret-key-0123456789", ALLOW_CUSTOM_SCRIPTS: "true" }));
    // A worker in another process says it is alive, so runs are queued (and nothing here runs them).
    stopBeat = startHeartbeat(platform.db);
    app = await buildServer(platform);
    await app.ready();
    platform.db.run("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)", ADA.id!, "ada@people.example", new Date().toISOString());
}, 60_000);

afterAll(async () => {
    stopBeat?.();
    await app?.close();
    platform?.db.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("the record (slot 54)", () => {
    it("is made by the migration, and again for a database that recorded the slot while it was still a placeholder", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-approval-deps-db-"));
        dirs.push(dir);
        const file = path.join(dir, "a.db");
        const has = (db: Db) => Boolean(db.get("SELECT name FROM sqlite_master WHERE name = 'test_version_deps'"));
        const first = new Db(file);
        expect(has(first)).toBe(true);
        first.raw.exec("DROP TABLE test_version_deps");
        first.close();
        const again = new Db(file);
        expect(has(again)).toBe(true);
        again.close();
    });

    it("names what changed by content, so a rename is not a change", () => {
        expect(changedParts([{ kind: "steps", name: "A", hash: "1" }], [{ kind: "steps", name: "B", hash: "1" }])).toEqual([]);
        expect(changedParts([{ kind: "steps", name: "A", hash: "1" }], [{ kind: "steps", name: "A", hash: "2" }])).toEqual([{ kind: "steps", name: "A", hash: "2" }]);
        expect(changedParts([{ kind: "helper", name: "h", hash: "1" }], [])).toEqual([{ kind: "helper", name: "h", hash: "missing" }]);
    });
});

describe("reusable steps", () => {
    let projectId = "";
    let appId = "";
    let t = "";

    it("records what a person approved, and runs it while nothing it uses changed", async () => {
        ({ projectId, appId } = await newProject("Shared steps shop"));
        expect((await call("POST", `/api/projects/${projectId}/blocks`, { name: "Log in", kind: "web", params: [], steps: loginSteps() })).status).toBe(201);
        t = newTest(projectId, spec("WEB-001", "Checkout", [use("Log in"), { action: "navigate", url: "/cart" }]));
        expect(reviews().latest(t)).toMatchObject({ version: 1, state: "draft" });
        await approveRoute(t, 1);
        const v1 = reviews().get(t, 1)!;
        const rec = readDeps(platform.db, v1.id)!;
        expect(rec.recorded).toBe("approval");
        expect(rec.covers).toEqual([{ kind: "steps", name: "Log in", hash: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
        // The same parts always give the same fingerprint.
        expect(new DepsReader(platform.db).of(v1).hash).toBe(rec.hash);
        const { pins, recorded } = await pin(projectId, appId, [t]);
        expect(pins.waiting).toEqual([]);
        expect(recorded).toEqual([{ testId: t, version: 1, outcome: "ran" }]);
    });

    it("holds the test back when the steps change, says why, and makes one version to approve again", async () => {
        await putBlock(projectId, "Log in", { steps: loginSteps("Sign in now") });
        const first = await pin(projectId, appId, [t]);
        expect(first.pins.waiting).toEqual([t]);
        expect(first.pins.held.get(t)).toBe(`${DEPENDENCY_CHANGED} Changed: the reusable steps “Log in”.`);
        expect(first.recorded).toEqual([{ testId: t, version: null, outcome: "changed" }]);
        const v2 = reviews().latest(t)!;
        // Made when the steps were saved, as the change of whoever saved them (here the access key).
        expect(v2).toMatchObject({ version: 2, state: "draft", source: "dependency", author: { kind: "key" } });
        expect(v2.spec).toEqual(reviews().get(t, 1)!.spec);
        expect(reviews().comments(v2.id)[0]!.body).toMatch(/^The reusable steps “Log in” changed after version 1 was approved\./);
        expect(reviews().get(t, 1)!.state).toBe("approved");
        // A second run finds the same change and makes no second version.
        await pin(projectId, appId, [t]);
        expect(reviews().list(t).map((v) => v.version)).toEqual([2, 1]);
        // It is in the review queue, with a plain source (who may approve it follows the usual rules for the key's own changes).
        const queue = (await call("GET", "/api/reviews")).body.items as Array<{ testId: string; source: string }>;
        expect(queue.find((i) => i.testId === t)).toMatchObject({ source: "dependency" });
    });

    it("runs the approved version again when the steps are put back as they were", async () => {
        await putBlock(projectId, "Log in", { steps: loginSteps() });
        const { pins } = await pin(projectId, appId, [t]);
        expect(pins.waiting).toEqual([]);
        expect([...pins.stale]).toEqual([t]); // version 2 still waits; the run used version 1
        await putBlock(projectId, "Log in", { steps: loginSteps("Sign in now") });
        expect((await pin(projectId, appId, [t])).pins.held.has(t)).toBe(true);
        expect(reviews().list(t).map((v) => v.version)).toEqual([2, 1]);
    });

    it("runs again once the new version is approved, with the steps as they are now", async () => {
        reviews().approve(reviews().get(t, 2)!, ADA, null);
        expect(readDeps(platform.db, reviews().get(t, 2)!.id)!.recorded).toBe("approval");
        const { pins, recorded } = await pin(projectId, appId, [t]);
        expect(pins.waiting).toEqual([]);
        expect(recorded).toEqual([{ testId: t, version: 2, outcome: "ran" }]);
    });

    it("a rename of the steps, also of steps used inside other steps, is not a change", async () => {
        expect((await call("POST", `/api/projects/${projectId}/blocks`, { name: "Buy", kind: "web", params: [], steps: [use("Log in"), { action: "navigate", url: "/buy" }] })).status).toBe(201);
        await call("PUT", `/api/projects/${projectId}/review-policy`, { aiGenerated: false });
        const buyer = newTest(projectId, spec("WEB-002", "Buys", [use("Buy"), use("Log in")]));
        expect(reviews().latest(buyer)).toMatchObject({ version: 1, state: "approved" });
        expect(readDeps(platform.db, reviews().latest(buyer)!.id)!.recorded).toBe("approval");
        await putBlock(projectId, "Log in", { name: "Sign in" });
        expect(platform.repo.getTest(buyer)!.spec.steps[1]).toMatchObject({ action: "useBlock", block: "Sign in" });
        const after = reviews().latest(buyer)!;
        expect(after).toMatchObject({ version: 2, state: "approved", source: "shared" });
        expect(readDeps(platform.db, after.id)!.recorded).toBe("carried");
        const { pins } = await pin(projectId, appId, [t, buyer]);
        expect(pins.waiting).toEqual([]);
    });
});

describe("shared elements", () => {
    let projectId = "";
    let appId = "";
    let t = "";
    let pay = "";

    it("an element's notes and a rename are not changes; its locator is", async () => {
        ({ projectId, appId } = await newProject("Shared elements shop"));
        await call("PUT", `/api/projects/${projectId}/review-policy`, { aiGenerated: false });
        const made = await call("POST", `/api/projects/${projectId}/objects`, { name: "Pay button", kind: "web", locator: button("Pay") });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        pay = made.body.id;
        expect((await call("POST", `/api/projects/${projectId}/blocks`, { name: "Pay", kind: "web", params: [], steps: [{ action: "navigate", url: "/pay" }, { action: "click", locator: { ref: "Pay button" } }] })).status).toBe(201);
        // The element is used directly and through reusable steps.
        t = newTest(projectId, spec("WEB-001", "Pays", [{ action: "navigate", url: "/" }, { action: "click", locator: { ref: "Pay button" } }, use("Pay")]));
        expect(reviews().latest(t)).toMatchObject({ version: 1, state: "approved" });
        expect(readDeps(platform.db, reviews().latest(t)!.id)!.covers.map((c) => `${c.kind}:${c.name}`)).toEqual(["steps:Pay", "element:Pay button"]);

        await putElement(projectId, pay, { notes: "The big one at the bottom" });
        expect((await pin(projectId, appId, [t])).pins.waiting).toEqual([]);
        await putElement(projectId, pay, { name: "Pay now button" });
        expect(platform.repo.getTest(t)!.spec.steps[1]).toMatchObject({ locator: { ref: "Pay now button" } });
        expect((await pin(projectId, appId, [t])).pins.waiting).toEqual([]);

        await putElement(projectId, pay, { locator: button("Pay now") });
        const { pins } = await pin(projectId, appId, [t]);
        expect(pins.held.get(t)).toBe(`${DEPENDENCY_CHANGED} Changed: the shared element “Pay now button”.`);
    });

    it("a run of only such tests runs nothing, says why in the log and on the run page, and is held back, not failed", async () => {
        clearQueue();
        const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [t] });
        const claimed = platform.repo.claimNextJob(60_000, "w-approval-deps")!;
        expect(claimed.id).toBe(job.id);
        await runJob({ ...platform }, claimed, "w-approval-deps");
        expect(platform.repo.getJob(job.id)).toMatchObject({ status: "FAILED", error: "Nothing ran: the test is waiting for approval." });
        const events = platform.repo.listEvents(job.id).filter((e) => e.kind === "shared_part_changed");
        expect(events.map((e) => e.message)).toEqual([`WEB-001: not run. ${DEPENDENCY_CHANGED} Changed: the shared element “Pay now button”.`]);
        expect(platform.repo.listExecutions(t)).toEqual([]);
        const run = (await call("GET", `/api/projects/${projectId}/runs/${job.id}`)).body;
        expect(run.heldBack).toEqual([{ id: t, testId: "WEB-001", title: "Pays", version: 3, reason: DEPENDENCY_CHANGED }]);
        expect(run.tests).toEqual([expect.objectContaining({ id: t, state: "not_run", reason: DEPENDENCY_CHANGED })]);
    }, 60_000);

    it("a suite run leaves it out with the same reason", async () => {
        const chosen = await chooseVersionsToRun(platform.repo, projectId, [platform.repo.getTest(t)!]);
        expect(chosen.run).toEqual([]);
        expect(chosen.held).toEqual([{ id: t, testId: "WEB-001", reason: `WEB-001: ${DEPENDENCY_CHANGED} Changed: the shared element “Pay now button”.` }]);
    });
});

describe("helpers of code tests", () => {
    it("a change to a helper the code imports holds it back", async () => {
        const { projectId, appId } = await newProject("Code shop", false);
        const helper = await call("PUT", `/api/projects/${projectId}/helpers/login-steps`, { content: "export async function signIn(page: any) {\n    await page.goto('/login');\n}\n" });
        expect(helper.status, JSON.stringify(helper.body)).toBe(200);
        const code = "import { test } from '@playwright/test';\nimport { signIn } from './helpers/login-steps';\n\ntest('signs in', async ({ page }) => {\n    await signIn(page);\n});\n";
        const made = await call("POST", `/api/projects/${projectId}/custom-tests`, { title: "Signs in", kind: "web", content: code });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        const t = platform.db.get<{ id: string }>("SELECT id FROM test_cases WHERE project_id = ?", projectId)!.id;
        const v = reviews().approved(t)!;
        expect(v.code).toBe(code);
        expect(readDeps(platform.db, v.id)!.covers).toEqual([{ kind: "helper", name: "login-steps", hash: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
        expect((await pin(projectId, appId, [t])).pins.waiting).toEqual([]);
        addAdmin(projectId);
        await call("PUT", `/api/projects/${projectId}/helpers/login-steps`, { content: "export async function signIn(page: any) {\n    await page.goto('/sign-in');\n}\n" });
        const { pins } = await pin(projectId, appId, [t]);
        expect(pins.held.get(t)).toBe(`${DEPENDENCY_CHANGED} Changed: the helper “login-steps”.`);
        expect(reviews().latest(t)).toMatchObject({ state: "draft", source: "dependency", code });
    });
});

describe("the project's policy and older approvals", () => {
    it("a project that does not ask for approval of people's changes approves it again at once, and says so", async () => {
        const { projectId, appId } = await newProject("No review shop");
        await call("PUT", `/api/projects/${projectId}/review-policy`, { aiGenerated: false, edits: false });
        await call("POST", `/api/projects/${projectId}/blocks`, { name: "Log in", kind: "web", params: [], steps: loginSteps() });
        const t = newTest(projectId, spec("WEB-001", "Checkout", [use("Log in")]));
        const v1 = reviews().approved(t)!;
        await putBlock(projectId, "Log in", { steps: loginSteps("Sign in now") });
        const { pins } = await pin(projectId, appId, [t]);
        expect(pins.waiting).toEqual([]);
        expect(reviews().latest(t)!.id).toBe(v1.id);
        expect(readDeps(platform.db, v1.id)!.recorded).toBe("policy");
        expect(reviews().comments(v1.id).at(-1)!.body).toMatch(/^Approved again by the project's review policy: the reusable steps “Log in” changed after approval/);
        expect((await pin(projectId, appId, [t])).pins.waiting).toEqual([]);
    });

    it("a version approved before the record existed gets one at its first run and runs; a later change holds it back", async () => {
        const { projectId, appId } = await newProject("Older shop");
        await call("PUT", `/api/projects/${projectId}/review-policy`, { aiGenerated: false });
        await call("POST", `/api/projects/${projectId}/blocks`, { name: "Log in", kind: "web", params: [], steps: loginSteps() });
        const t = newTest(projectId, spec("WEB-001", "Checkout", [use("Log in")]));
        const v1 = reviews().approved(t)!;
        platform.db.run("DELETE FROM test_version_deps WHERE version_id = ?", v1.id); // as it is for every version approved before this change
        changeBlockQuietly(projectId, "Log in", loginSteps("Sign in now"));
        expect((await pin(projectId, appId, [t])).pins.waiting).toEqual([]);
        expect(readDeps(platform.db, v1.id)!.recorded).toBe("first_check");
        // A change nobody reported is found by the run, and the version to approve again is the platform's.
        changeBlockQuietly(projectId, "Log in", loginSteps("Enter"));
        expect((await pin(projectId, appId, [t])).pins.held.get(t)).toBe(`${DEPENDENCY_CHANGED} Changed: the reusable steps “Log in”.`);
        expect(reviews().latest(t)).toMatchObject({ version: 2, state: "draft", source: "dependency", author: { kind: "system", name: "Platform" } });
    });

    it("a version with no record whose part is changed on the project's pages is held back, since what it was approved with is unknown", async () => {
        const { projectId, appId } = await newProject("Older shop two");
        await call("PUT", `/api/projects/${projectId}/review-policy`, { aiGenerated: false });
        await call("POST", `/api/projects/${projectId}/blocks`, { name: "Log in", kind: "web", params: [], steps: loginSteps() });
        const t = newTest(projectId, spec("WEB-001", "Checkout", [use("Log in")]));
        platform.db.run("DELETE FROM test_version_deps WHERE version_id = ?", reviews().approved(t)!.id);
        await putBlock(projectId, "Log in", { steps: loginSteps("Sign in now") });
        expect((await pin(projectId, appId, [t])).pins.held.has(t)).toBe(true);
        expect(reviews().comments(reviews().latest(t)!.id)[0]!.body).toMatch(/^The reusable steps “Log in” changed after version 1 was approved\./);
    });

    it("a change with the access key in a project with no Project Admin is approved again at once, like the key's other changes", async () => {
        const { projectId, appId } = await newProject("Local shop", false);
        await call("PUT", `/api/projects/${projectId}/review-policy`, { aiGenerated: false });
        await call("POST", `/api/projects/${projectId}/blocks`, { name: "Log in", kind: "web", params: [], steps: loginSteps() });
        const t = newTest(projectId, spec("WEB-001", "Checkout", [use("Log in")]));
        const v1 = reviews().approved(t)!;
        await putBlock(projectId, "Log in", { steps: loginSteps("Sign in now") });
        expect(readDeps(platform.db, v1.id)!.recorded).toBe("policy");
        expect(reviews().comments(v1.id).at(-1)!.body).toMatch(/changed with the access key or open access, in a project with no Project Admin\.$/);
        expect((await pin(projectId, appId, [t])).pins.waiting).toEqual([]);
    });

    it("a test with no shared parts is never held back", async () => {
        const { projectId, appId } = await newProject("Plain shop");
        await call("PUT", `/api/projects/${projectId}/review-policy`, { aiGenerated: false });
        const t = newTest(projectId, spec("WEB-001", "Home", [{ action: "navigate", url: "/" }]));
        expect(readDeps(platform.db, reviews().approved(t)!.id)!.covers).toEqual([]);
        expect((await pin(projectId, appId, [t])).pins.waiting).toEqual([]);
    });
});
