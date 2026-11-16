/**
 * Renaming, deleting and ordering a project's test scripts (routes/test-manage.ts), without a browser or a worker:
 *  - rename changes the name everywhere it is read, refuses an empty or too long name in a sentence, and makes no new version;
 *  - delete takes the script with its runs, history and links, refuses while it runs, and needs ai_studio.tests.delete;
 *  - the order is kept on the server, read by the list, the review list and "run all", and new scripts go to the end;
 *  - another project's script reads as unknown (404), and a viewer can change none of it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { defaultFramework } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { permissionRuleFor } from "../src/platform/auth/roles.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CustomScriptStore } from "../src/platform/custom-script-store.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { ReviewStore, trackTestVersion } from "../src/platform/review-store.js";
import { buildServer } from "../src/platform/server.js";

const KEY = "test-manage-owner-key-5d2e";
type App = Awaited<ReturnType<typeof buildServer>>;

let dir: string;
let platform: Platform;
let app: App;
let A: string;
let B: string;
let testB: string;

const call = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = { "x-api-key": KEY }) => {
    const res = await app.inject({ method: method as "GET", url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: res.statusCode, body: res.body && /^[{[]/.test(res.body) ? JSON.parse(res.body) : res.body } as { status: number; body: any };
};

function addTest(projectId: string, key: string, area = "Shop"): string {
    const spec = TestSpecSchema.parse({ testId: key, title: `Check ${key}`, kind: "api", category: area, steps: [{ action: "request", method: "GET", path: `/api/${key.toLowerCase()}` }, { action: "assertResponse", check: "status", expected: 200 }] });
    const suite = platform.repo.getOrCreateSuite(projectId, area, area.toLowerCase());
    return platform.repo.insertTest({ projectId, suiteId: suite, jobId: null, spec, framework: defaultFramework("api"), validationStatus: "PENDING" });
}

const listed = async (projectId: string) => (await call("GET", `/api/projects/${projectId}/tests`)).body.map((t: { id: string }) => t.id) as string[];
const finishJobs = () => platform.db.run("UPDATE generation_jobs SET status = 'COMPLETED', finished_at = ? WHERE status NOT IN ('COMPLETED','PARTIALLY_COMPLETED','FAILED')", new Date().toISOString());

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-manage-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", API_KEY: KEY, SECRET_KEY: "test-manage-secret-key-0123456789" }));
    app = await buildServer(platform);
    await app.ready();
    A = (await call("POST", "/api/projects", { name: "Alpha" })).body.id;
    B = (await call("POST", "/api/projects", { name: "Bravo" })).body.id;
    for (const pid of [A, B]) new ReviewStore(platform.db).setPolicy(pid, { aiGenerated: false, edits: false, healing: false }, "test");
    platform.repo.createApplication(A, "http://127.0.0.1:7727", { ...DEFAULT_JOB_OPTIONS });
    testB = addTest(B, "API-900");
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("renaming a script", () => {
    it("changes its name in the list, its page and its steps, and makes no new version", async () => {
        const id = addTest(A, "API-101");
        const versions = () => platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM test_versions WHERE test_case_id = ?", id)!.n;
        const before = versions();
        const r = await call("PATCH", `/api/tests/${id}`, { title: "  Checkout keeps the basket  " });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ id, title: "Checkout keeps the basket" });
        expect((await call("GET", `/api/tests/${id}`)).body).toMatchObject({ title: "Checkout keeps the basket", spec: { title: "Checkout keeps the basket" } });
        expect((await call("GET", `/api/projects/${A}/tests`)).body.find((t: { id: string }) => t.id === id).title).toBe("Checkout keeps the basket");
        // A name is not a step: nothing new waits for review, also when the next change check looks at the test.
        trackTestVersion(platform.db, id);
        expect(versions()).toBe(before);
    });

    it("renames a code test too, whose steps are never rewritten", async () => {
        const id = addTest(A, "API-102");
        new CustomScriptStore(platform.db).mark(id, A, { origin: "written" });
        const r = await call("PATCH", `/api/tests/${id}`, { title: "Sign-in by hand" });
        expect(r.status).toBe(200);
        expect((await call("GET", `/api/tests/${id}`)).body.title).toBe("Sign-in by hand");
    });

    it("refuses an empty, too short or too long name in a sentence", async () => {
        const id = addTest(A, "API-103");
        for (const [title, said] of [["   ", /at least 3 characters/], ["ab", /at least 3 characters/], ["x".repeat(201), /at most 200 characters/]] as const) {
            const r = await call("PATCH", `/api/tests/${id}`, { title });
            expect(r.status, JSON.stringify(title)).toBe(400);
            expect(r.body.message ?? r.body.error).toMatch(said);
        }
        expect((await call("GET", `/api/tests/${id}`)).body.title).toBe("Check API-103");
    });

    it("answers 404 for an unknown script", async () => {
        expect((await call("PATCH", `/api/tests/nope`, { title: "Anything" })).status).toBe(404);
    });
});

describe("deleting a script", () => {
    it("takes its runs, versions, suite places and requirement links with it", async () => {
        const id = addTest(A, "API-201");
        const keep = addTest(A, "API-202");
        const suite = (await call("POST", `/api/projects/${A}/test-suites`, { name: "Smoke", testIds: [id, keep] })).body.id;
        platform.db.run("INSERT INTO test_executions (id, test_case_id, attempt, status, started_at) VALUES (?, ?, 1, 'PASSED', ?)", "exec-201", id, new Date().toISOString());
        const r = await call("DELETE", `/api/tests/${id}`);
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ deleted: true });
        expect((await call("GET", `/api/tests/${id}`)).status).toBe(404);
        expect(await listed(A)).not.toContain(id);
        expect(platform.db.get("SELECT 1 AS x FROM test_executions WHERE id = 'exec-201'")).toBeUndefined();
        expect(platform.db.get("SELECT 1 AS x FROM test_versions WHERE test_case_id = ?", id)).toBeUndefined();
        expect((await call("GET", `/api/projects/${A}/test-suites/${suite}`)).body.tests.map((t: { id: string }) => t.id)).toEqual([keep]);
    });

    it("refuses while the script is running", async () => {
        const id = addTest(A, "API-203");
        platform.db.run("UPDATE test_cases SET validation_status = 'VALIDATING' WHERE id = ?", id);
        const r = await call("DELETE", `/api/tests/${id}`);
        expect(r.status).toBe(409);
        expect(r.body.message ?? r.body.error).toMatch(/running/);
        expect((await call("GET", `/api/tests/${id}`)).status).toBe(200);
    });

    it("answers 404 for an unknown script", async () => {
        expect((await call("DELETE", `/api/tests/nope`)).status).toBe(404);
    });
});

describe("the order of the scripts", () => {
    let ids: string[];
    beforeAll(() => {
        // Its own project, so the scripts above do not take part.
        ids = ["ORD-001", "ORD-002", "ORD-003"].map((k) => addTest(B, k, "Orders"));
    });

    it("lists by ID until someone orders them, then in the order kept on the server", async () => {
        expect(await listed(B)).toEqual([testB, ...ids].sort((a, b) => keyOf(a).localeCompare(keyOf(b))));
        const wanted = [ids[2]!, testB, ids[0]!, ids[1]!];
        const r = await call("PUT", `/api/projects/${B}/tests/order`, { testIds: wanted });
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ testIds: wanted });
        expect(await listed(B)).toEqual(wanted);
        // The review list reads the same order.
        expect((await call("GET", `/api/projects/${B}/scripts`)).body.scripts.map((s: { testId: string }) => s.testId)).toEqual(wanted);
    });

    it("keeps the order when the engine replaces what it noted about a script", async () => {
        const before = await listed(B);
        platform.repo.updateTest(before[0]!, { meta: { model: "scripted" } });
        expect(await listed(B)).toEqual(before);
    });

    it("puts a new script at the end", async () => {
        const before = await listed(B);
        const fresh = addTest(B, "AAA-000", "Orders");
        expect(await listed(B)).toEqual([...before, fresh]);
    });

    it("runs every script in the same order", async () => {
        platform.repo.createApplication(B, "http://127.0.0.1:7727", { ...DEFAULT_JOB_OPTIONS });
        const order = await listed(B);
        const r = await call("POST", `/api/projects/${B}/runs`, {});
        expect(r.status).toBe(202);
        expect(platform.repo.getJob(r.body.jobId)!.options.testIds).toEqual(order);
        finishJobs();
    });

    it("refuses a list that misses a script or names one twice", async () => {
        const all = await listed(B);
        const missing = await call("PUT", `/api/projects/${B}/tests/order`, { testIds: all.slice(1) });
        expect(missing.status).toBe(409);
        expect(missing.body.message ?? missing.body.error).toMatch(/Reload/);
        const twice = await call("PUT", `/api/projects/${B}/tests/order`, { testIds: [...all, all[0]] });
        expect(twice.status).toBe(400);
        expect(await listed(B)).toEqual(all);
    });

    it("answers 404 for another project's script", async () => {
        const all = await listed(B);
        const foreign = (await listed(A))[0]!;
        expect((await call("PUT", `/api/projects/${B}/tests/order`, { testIds: [...all.slice(1), foreign] })).status).toBe(404);
        expect(await listed(B)).toEqual(all);
    });
});

const keyOf = (id: string) => platform.repo.getTest(id)!.testKey;

describe("who may", () => {
    it("names the permission each route needs", () => {
        expect(permissionRuleFor("PATCH", "/api/tests/:id")).toBe("ai_studio.tests.write");
        expect(permissionRuleFor("DELETE", "/api/tests/:id")).toBe("ai_studio.tests.delete");
        expect(permissionRuleFor("PUT", "/api/projects/:id/tests/order")).toBe("ai_studio.tests.write");
    });

    it("lets a viewer change nothing, and an editor rename, order and delete", async () => {
        const users = accessControlOf(app).users;
        const viewer = users.create({ email: "vic@example.com", name: "Vic", role: "viewer" });
        const editor = users.create({ email: "eve@example.com", name: "Eve", role: "editor" });
        const v = { authorization: `Bearer ${users.createToken(viewer.id, { name: "t", role: "viewer" }).token}` };
        const e = { authorization: `Bearer ${users.createToken(editor.id, { name: "t", role: "editor" }).token}` };
        const id = addTest(A, "API-301");
        const order = await listed(A);
        expect((await call("PATCH", `/api/tests/${id}`, { title: "Viewer was here" }, v)).status).toBe(403);
        expect((await call("DELETE", `/api/tests/${id}`, undefined, v)).status).toBe(403);
        expect((await call("PUT", `/api/projects/${A}/tests/order`, { testIds: [...order].reverse() }, v)).status).toBe(403);
        expect((await call("GET", `/api/tests/${id}`)).body.title).toBe("Check API-301");
        expect(await listed(A)).toEqual(order);
        expect((await call("PATCH", `/api/tests/${id}`, { title: "Editor was here" }, e)).status).toBe(200);
        expect((await call("PUT", `/api/projects/${A}/tests/order`, { testIds: [...order].reverse() }, e)).status).toBe(200);
        expect((await call("DELETE", `/api/tests/${id}`, undefined, e)).status).toBe(200);
    });
});
