/**
 * Project folders, archiving and deleting a project, the one-name-per-organisation check, and personal preferences (NAV-02,
 * US-012), against a stand-in Crowd4Test sign-in (port 7775): who may change folders and in which organisation, what each person
 * sees, an archived project refusing every change and every run while it stays readable, delete removing rows and files but
 * keeping the audit and AI usage, and email preferences leaving people out of alert emails.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { AlertStore } from "../src/platform/alerts.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { Db } from "../src/platform/db.js";
import {
    ALREADY_ARCHIVED,
    FOLDERS_MIGRATION,
    NAME_TO_CONFIRM,
    NEEDS_PROJECT_ADMIN,
    NOT_ARCHIVED,
    OTHER_ORGANIZATION_FOLDER,
    PROJECT_ARCHIVED,
    projectTables,
    wantedRecipients,
} from "../src/platform/project-folders.js";
import { NO_PREFERENCES } from "../src/platform/routes/project-folders.js";
import { getRunbookServices } from "../src/platform/runbook-runner.js";
import { ScheduleStore } from "../src/platform/schedule-store.js";
import { SecretBox } from "../src/platform/secrets.js";
import { buildServer } from "../src/platform/server.js";

type App = Awaited<ReturnType<typeof buildServer>>;
const KEY = "folders-owner-key-5d1c90";
const PAGE = { "x-requested-with": "ai-studio" };
const API_PORT = 7775;
const dirs: string[] = [];

const me = (id: string, role: string, permissions: readonly string[], organisationId: string | null = null) => ({
    data: { user: { id, email: `${id}@people.example`, role, status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions, organisationId } },
});
const ACCOUNTS: Record<string, unknown> = {
    "t-admin": me("ada", "ADMIN", []),
    "t-cora": me("cora", "CUSTOMER", PERMISSIONS, "org-a"),
    "t-cleo": me("cleo", "CUSTOMER", PERMISSIONS, "org-a"),
    "t-rita": me("rita", "CUSTOMER", ["ai_studio.access", "ai_studio.tests.write"], "org-a"),
    "t-bob": me("bob", "CUSTOMER", PERMISSIONS, "org-b"),
    "t-tim": me("tim", "TESTER", PERMISSIONS),
};

let api: http.Server;
let platform: Platform;
let app: App;
let dataDir = "";

const call = (headers: Record<string, string>, method: string, url: string, payload?: unknown) =>
    app
        .inject({ method: method as "GET", url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) })
        .then((r) => ({ status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body }));
const asKey = (method: string, url: string, payload?: unknown) => call({ "x-api-key": KEY }, method, url, payload);
const as = (token: string, method: string, url: string, payload?: unknown) => call({ cookie: `c4t_access=${token}`, ...(method === "GET" ? {} : PAGE) }, method, url, payload);
const personOf = async (token: string): Promise<string> => (await as(token, "GET", "/api/auth/state")).body.me.id;
const addMember = async (projectId: string, token: string, projectAdmin = false) =>
    accessControlOf(app).projects.store.addMember(projectId, await personOf(token), { role: "owner", projectAdmin, source: "added", addedBy: "test" });
const folderNames = async (token: string) => ((await as(token, "GET", "/api/folders")).body.folders as Array<{ name: string }>).map((f) => f.name).sort();

beforeAll(async () => {
    api = http.createServer((req, res) => {
        const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        res.writeHead(ACCOUNTS[auth] ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ACCOUNTS[auth] ?? { error: { message: "Invalid access token" } }));
    });
    await new Promise<void>((r) => api.listen(API_PORT, "127.0.0.1", r));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-folders-"));
    dirs.push(dataDir);
    platform = bootstrap(
        loadConfig({ DATA_DIR: dataDir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECRET_KEY: "folders-test-secret-key-0123456789", C4T_API_ORIGIN: `http://127.0.0.1:${API_PORT}`, C4T_SITE_URL: "https://crowd4test.example" }),
    );
    app = await buildServer(platform);
    await app.ready();
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    await new Promise((r) => api?.close(r));
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("one project name per organisation", () => {
    it("refuses a name already used in the same organisation, ignoring case, but not in another one", async () => {
        expect((await as("t-cora", "POST", "/api/projects", { name: "Storefront" })).status).toBe(201);
        const again = await as("t-cleo", "POST", "/api/projects", { name: "  storefront " });
        expect(again.status).toBe(409);
        expect(again.body.error).toMatch(/already exists in this organisation/);
        expect((await as("t-bob", "POST", "/api/projects", { name: "Storefront" })).status).toBe(201);
        // Projects without an organisation (made with the access key) are one group of their own.
        expect((await asKey("POST", "/api/projects", { name: "Storefront" })).status).toBe(201);
        expect((await asKey("POST", "/api/projects", { name: "STOREFRONT" })).status).toBe(409);
        // A name the page made from the address gets a number; a typed one stays refused.
        expect((await asKey("POST", "/api/projects", { name: "storefront", autoName: true })).body.name).toBe("storefront 2");
        expect((await asKey("POST", "/api/projects", { name: "storefront", autoName: true })).body.name).toBe("storefront 3");
        expect((await asKey("POST", "/api/projects", { name: "A free name", autoName: true })).body.name).toBe("A free name");
    });

    it("checks a rename too, and lets a project keep or re-case its own name", async () => {
        const a = (await asKey("POST", "/api/projects", { name: "Rename me" })).body.id as string;
        expect((await asKey("PATCH", `/api/projects/${a}`, { name: "storefront" })).status).toBe(409);
        expect(await asKey("PATCH", `/api/projects/${a}`, { name: "RENAME ME" })).toMatchObject({ status: 200, body: { name: "RENAME ME" } });
        expect(await asKey("PATCH", `/api/projects/${a}`, { name: "Renamed" })).toMatchObject({ status: 200, body: { name: "Renamed" } });
    });
});

describe("folders", () => {
    let shop = "";
    let hidden = "";
    let clients = "";
    let internal = "";

    it("lets a customer who creates projects make folders in their own organisation only", async () => {
        shop = (await as("t-cora", "POST", "/api/projects", { name: "Shop" })).body.id;
        hidden = (await as("t-cora", "POST", "/api/projects", { name: "Hidden" })).body.id;
        const made = await as("t-cora", "POST", "/api/folders", { name: "Clients" });
        expect(made).toMatchObject({ status: 201, body: { name: "Clients", organizationId: "org-a" } });
        clients = made.body.id;
        expect((await as("t-cora", "POST", "/api/folders", { name: " clients " })).status).toBe(409);
        expect((await as("t-cora", "POST", "/api/folders", { name: "Theirs", organizationId: "org-b" })).status).toBe(403);
        internal = (await as("t-cora", "POST", "/api/folders", { name: "Internal" })).body.id;
        expect((await as("t-cora", "PUT", `/api/projects/${shop}/folder`, { folderId: clients })).body).toEqual({ folderId: clients });
        expect((await as("t-cora", "PUT", `/api/projects/${hidden}/folder`, { folderId: internal })).status).toBe(200);
        const list = (await as("t-cora", "GET", "/api/folders")).body;
        expect(list.canCreate).toBe(true);
        expect(list.organizations).toEqual([{ id: "org-a", name: null }]);
        expect(list.folders.find((f: { id: string }) => f.id === clients)).toMatchObject({ canManage: true, projects: [{ id: shop, name: "Shop", archived: false }] });
        // The project list carries the folder too, for grouping.
        expect((await as("t-cora", "GET", "/api/projects")).body.find((p: { id: string }) => p.id === shop).folder_id).toBe(clients);
    });

    it("never shows a customer another organisation's folders, and answers 404 for them", async () => {
        expect(await folderNames("t-bob")).toEqual([]);
        expect((await as("t-bob", "PATCH", `/api/folders/${clients}`, { name: "Mine now" })).status).toBe(404);
        expect((await as("t-bob", "DELETE", `/api/folders/${clients}`)).status).toBe(404);
        const bobs = (await as("t-bob", "POST", "/api/projects", { name: "Bravo app" })).body.id;
        expect((await as("t-bob", "PUT", `/api/projects/${bobs}/folder`, { folderId: clients })).status).toBe(404);
        expect((await as("t-bob", "PUT", `/api/projects/${shop}/folder`, { folderId: null })).status).toBe(404);
    });

    it("shows someone who cannot change folders only those holding a project they reach, read-only", async () => {
        await addMember(shop, "t-rita");
        const list = (await as("t-rita", "GET", "/api/folders")).body;
        expect(list.folders.map((f: { name: string }) => f.name)).toEqual(["Clients"]);
        expect(list.folders[0]).toMatchObject({ canManage: false, projects: [{ id: shop }] });
        expect(list.canCreate).toBe(false);
        expect((await as("t-rita", "POST", "/api/folders", { name: "Rita's" })).status).toBe(403);
        expect((await as("t-rita", "PUT", `/api/projects/${shop}/folder`, { folderId: null })).status).toBe(403);
        // A tester with every permission reaches no project here and changes no folder.
        expect(await folderNames("t-tim")).toEqual([]);
        expect((await as("t-tim", "POST", "/api/folders", { name: "Tim's" })).status).toBe(403);
        expect(await as("t-rita", "POST", "/api/folders", { name: "Rita's" })).toMatchObject({ status: 403 });
    });

    it("lets Crowd4Test staff organise any organisation, keeping each project to its own organisation's folders", async () => {
        expect(await folderNames("t-admin")).toEqual(expect.arrayContaining(["Clients", "Internal"]));
        const bravo = await as("t-admin", "POST", "/api/folders", { name: "Clients", organizationId: "org-b" });
        expect(bravo).toMatchObject({ status: 201, body: { organizationId: "org-b" } });
        expect(await as("t-admin", "PUT", `/api/projects/${shop}/folder`, { folderId: bravo.body.id })).toMatchObject({ status: 409, body: { error: OTHER_ORGANIZATION_FOLDER } });
        // The org-b customer now sees that folder, and still none of org-a's.
        expect(await folderNames("t-bob")).toEqual(["Clients"]);
        expect((await as("t-bob", "GET", "/api/folders")).body.folders[0].organizationId).toBe("org-b");
    });

    it("renames, and removing a folder moves its projects out without deleting them", async () => {
        expect((await as("t-cora", "PATCH", `/api/folders/${internal}`, { name: "Clients" })).status).toBe(409);
        expect(await as("t-cora", "PATCH", `/api/folders/${internal}`, { name: "In-house" })).toMatchObject({ status: 200, body: { name: "In-house" } });
        expect(await as("t-cora", "DELETE", `/api/folders/${internal}`)).toMatchObject({ status: 200, body: { removed: true, projectsMovedOut: 1 } });
        const row = (await as("t-cora", "GET", `/api/projects/${hidden}`)).body;
        expect(row).toMatchObject({ name: "Hidden", folder_id: null });
    });

    it("works on a local install, where folders have no organisation", async () => {
        const local = (await asKey("POST", "/api/projects", { name: "Local one" })).body.id;
        const f = await asKey("POST", "/api/folders", { name: "Team" });
        expect(f).toMatchObject({ status: 201, body: { organizationId: null } });
        expect((await asKey("PUT", `/api/projects/${local}/folder`, { folderId: f.body.id })).status).toBe(200);
        expect((await asKey("PUT", `/api/projects/${shop}/folder`, { folderId: f.body.id })).body.error).toBe(OTHER_ORGANIZATION_FOLDER);
    });
});

describe("archiving a project (US-012)", () => {
    let id = "";
    const spec = TestSpecSchema.parse({ testId: "WEB-001", title: "Home", kind: "web", category: "Smoke", priority: "high", steps: [{ action: "navigate", url: "/" }] });

    it("needs change-settings and Project Admin, and refuses while something runs", async () => {
        id = (await as("t-cora", "POST", "/api/projects", { name: "Archive me" })).body.id;
        await addMember(id, "t-cleo", false);
        await addMember(id, "t-rita", false);
        expect((await as("t-rita", "POST", `/api/projects/${id}/archive`)).status).toBe(403);
        expect(await as("t-cleo", "POST", `/api/projects/${id}/archive`)).toMatchObject({ status: 403, body: { error: NEEDS_PROJECT_ADMIN } });
        expect((await as("t-bob", "POST", `/api/projects/${id}/archive`)).status).toBe(404);
        const { repo } = platform;
        const appId = repo.createApplication(id, "https://shop.example/", {});
        const job = await repo.createJob(id, appId, { maxPages: 1, maxDepth: 1, maxScenarios: 1, targets: ["web"], allowMutatingApiTests: false } as never);
        const busy = await as("t-cora", "POST", `/api/projects/${id}/archive`);
        expect(busy.status).toBe(409);
        expect(busy.body.error).toMatch(/^Stop the running test first/);
        platform.db.run("UPDATE generation_jobs SET status = 'COMPLETED' WHERE id = ?", job.id);
        repo.insertTest({ projectId: id, suiteId: repo.getOrCreateSuite(id, "Smoke", "smoke"), jobId: null as unknown as string, spec, framework: "playwright", validationStatus: "PENDING" });
    });

    it("makes it read-only, out of the lists and the dashboard, with no runs or schedules, but still readable", async () => {
        const done = await as("t-cora", "POST", `/api/projects/${id}/archive`);
        expect(done.status).toBe(200);
        expect(done.body.archived_at).toBeTruthy();
        expect((await as("t-cora", "POST", `/api/projects/${id}/archive`)).body.error).toBe(ALREADY_ARCHIVED);
        expect((await as("t-cora", "GET", "/api/projects")).body.some((p: { id: string }) => p.id === id)).toBe(false);
        expect((await as("t-cora", "GET", "/api/projects?archived=include")).body.find((p: { id: string }) => p.id === id)?.archived_at).toBeTruthy();
        expect((await asKey("GET", "/api/dashboard")).body.projects.some((p: { id: string }) => p.id === id)).toBe(false);
        // Reading still works; every change is refused with the same plain words, on the project and on its tests.
        expect((await as("t-cora", "GET", `/api/projects/${id}`)).status).toBe(200);
        expect(await as("t-cora", "PATCH", `/api/projects/${id}`, { description: "x" })).toMatchObject({ status: 409, body: { error: PROJECT_ARCHIVED } });
        expect(await as("t-cora", "POST", `/api/projects/${id}/test-generation`, { url: "https://shop.example/" })).toMatchObject({ status: 409, body: { error: PROJECT_ARCHIVED } });
        const testId = platform.db.get<{ id: string }>("SELECT id FROM test_cases WHERE project_id = ?", id)!.id;
        expect(await asKey("POST", `/api/tests/${testId}/validate`, {})).toMatchObject({ status: 409, body: { error: PROJECT_ARCHIVED } });
        expect((await asKey("GET", `/api/tests/${testId}`)).status).toBe(200);
        // A run asked for any other way (a schedule, a deploy trigger) is refused where every run is made.
        const appId = platform.db.get<{ id: string }>("SELECT id FROM applications WHERE project_id = ?", id)!.id;
        await expect(platform.repo.createJob(id, appId, { maxPages: 1, maxDepth: 1, maxScenarios: 1, targets: ["web"], allowMutatingApiTests: false } as never)).rejects.toThrow(PROJECT_ARCHIVED);
        const schedules = new ScheduleStore(platform.db);
        platform.db.run("INSERT INTO schedules (id, project_id, name, kind, cadence_json, enabled, next_run_at, created_at, updated_at) VALUES ('s-arch', ?, 'Nightly', 'validate', '{\"type\":\"daily\",\"time\":\"02:00\"}', 1, 1, 'x', 'x')", id);
        expect(schedules.due(Date.now()).some((s) => s.id === "s-arch")).toBe(false);
        // A runbook, which a deploy trigger can start without passing the access hook, is refused before it creates a run.
        const runbooks = getRunbookServices(platform);
        const rb = runbooks.store.create(id, { name: "Release", steps: [] } as never);
        await expect(runbooks.start(rb.id, { kind: "manual" } as never)).rejects.toThrow(PROJECT_ARCHIVED);
        expect(platform.db.get("SELECT 1 AS x FROM runbook_runs WHERE project_id = ?", id)).toBeUndefined();
        // Restoring brings everything back.
        expect((await as("t-cora", "POST", `/api/projects/${id}/unarchive`)).body.archived_at).toBeNull();
        expect(schedules.due(Date.now()).some((s) => s.id === "s-arch")).toBe(true);
        expect((await as("t-cora", "PATCH", `/api/projects/${id}`, { description: "x" })).status).toBe(200);
        platform.db.run("DELETE FROM schedules WHERE id = 's-arch'");
    });
});

describe("deleting a project (US-012)", () => {
    it("refuses a project that is not archived, and a name typed wrong", async () => {
        const id = (await asKey("POST", "/api/projects", { name: "Keep me" })).body.id;
        expect(await asKey("DELETE", `/api/projects/${id}`, { name: "Keep me" })).toMatchObject({ status: 409, body: { error: NOT_ARCHIVED } });
        await asKey("POST", `/api/projects/${id}/archive`);
        expect(await asKey("DELETE", `/api/projects/${id}`, { name: "keep me" })).toMatchObject({ status: 400, body: { error: NAME_TO_CONFIRM } });
        // A job left running (archived some other way) still blocks it.
        platform.db.run("INSERT INTO applications (id, project_id, url, origin, config_json, created_at) VALUES ('app-keep', ?, 'https://k.example/', 'https://k.example', '{}', 'x')", id);
        platform.db.run("INSERT INTO generation_jobs (id, project_id, application_id, status, options_json, progress_json, counters_json, created_at, updated_at) VALUES ('job-keep', ?, 'app-keep', 'QUEUED', '{}', '{}', '{}', 'x', 'x')", id);
        expect((await asKey("DELETE", `/api/projects/${id}`, { name: "Keep me" })).body.error).toMatch(/^Stop the running test first/);
        expect((await asKey("GET", `/api/projects/${id}`)).status).toBe(200);
    });

    it("removes its rows and stored files, and keeps the Activity list and AI usage", async () => {
        const id = (await as("t-cora", "POST", "/api/projects", { name: "Remove me" })).body.id;
        const { repo, store, db } = platform;
        const spec = TestSpecSchema.parse({ testId: "WEB-001", title: "Home", kind: "web", category: "Smoke", priority: "high", steps: [{ action: "navigate", url: "/" }] });
        const testId = repo.insertTest({ projectId: id, suiteId: repo.getOrCreateSuite(id, "Smoke", "smoke"), jobId: null as unknown as string, spec, framework: "playwright", validationStatus: "PENDING" });
        await store.put(`${id}/_artifacts/run-1/shot.png`, Buffer.from("png bytes"));
        await store.put(`${id}/smoke/home.spec.ts`, "test()");
        await store.put("elsewhere/old-shot.png", Buffer.from("old"));
        await store.put("someone-else/keep.png", Buffer.from("keep"));
        const neighbour = (await asKey("POST", "/api/projects", { name: "Neighbour" })).body.id as string;
        await store.put(`${neighbour}/_artifacts/theirs.png`, Buffer.from("theirs"));
        db.run("INSERT INTO artifacts (id, project_id, test_case_id, kind, path, created_at) VALUES ('art-1', ?, ?, 'screenshot', ?, 'x')", id, testId, `${id}/_artifacts/run-1/shot.png`);
        db.run("INSERT INTO artifacts (id, project_id, test_case_id, kind, path, created_at) VALUES ('art-2', ?, ?, 'screenshot', 'elsewhere/old-shot.png', 'x')", id, testId);
        // A row that names a file in another project's folder must not cost that project the file.
        db.run("INSERT INTO artifacts (id, project_id, test_case_id, kind, path, created_at) VALUES ('art-3', ?, ?, 'screenshot', ?, 'x')", id, testId, `${neighbour}/_artifacts/theirs.png`);
        db.run("INSERT INTO ai_usage (job_id, project_id, purpose, model, day, calls) VALUES ('job-gone', ?, 'generate', 'm', '2026-10-31', 1)", id);
        await as("t-cora", "POST", `/api/projects/${id}/archive`);
        const r = await as("t-cora", "DELETE", `/api/projects/${id}`, { name: "Remove me" });
        expect(r.status).toBe(200);
        expect(r.body.report).toMatchObject({ tests: 1, files: 3, kept: ["activity", "ai_usage", "security_audit"] });
        expect(r.body.report.rows).toMatchObject({ test_cases: 1, artifacts: 3, test_suites: 1 });
        expect((await as("t-cora", "GET", `/api/projects/${id}`)).status).toBe(404);
        expect(await store.list(id)).toEqual([]);
        expect(fs.existsSync(path.join(dataDir, "generated-tests", id))).toBe(false);
        expect(await store.exists("elsewhere/old-shot.png")).toBe(false);
        expect(await store.exists("someone-else/keep.png")).toBe(true);
        expect(await store.exists(`${neighbour}/_artifacts/theirs.png`)).toBe(true);
        for (const t of projectTables(db)) expect(db.get(`SELECT 1 AS x FROM ${t} WHERE project_id = ?`, id), t).toBeUndefined();
        expect(db.get("SELECT 1 AS x FROM test_cases WHERE id = ?", testId)).toBeUndefined();
        expect(db.get("SELECT 1 AS x FROM ai_usage WHERE project_id = ?", id)).toBeTruthy();
        expect(db.get<{ detail: string }>("SELECT detail FROM activity WHERE project_id = ? AND action = 'deleted the project'", id)?.detail).toMatch(/^Remove me: 1 tests/);
    });

    it("every table that points at projects cascades, so a delete never leaves rows behind or fails", () => {
        const db = platform.db;
        for (const t of db.dialect.listTables(db)) {
            for (const fk of db.dialect.listForeignKeys(db, t).filter((f) => f.table === "projects")) expect(["CASCADE", "SET NULL"], `${t}.${fk.from}`).toContain(fk.onDelete.toUpperCase());
        }
    });
});

describe("preferences (Profile)", () => {
    it("are saved per person, and the access key has none", async () => {
        expect((await as("t-cora", "GET", "/api/me/preferences")).body).toMatchObject({ preferences: { runAlertEmails: true, securityEmails: true, projectsView: "dashboard" }, saved: true, crowd4test: true });
        expect((await as("t-cora", "PUT", "/api/me/preferences", { runAlertEmails: false, projectsView: "list" })).body.preferences).toEqual({ runAlertEmails: false, securityEmails: true, projectsView: "list" });
        expect((await as("t-cora", "GET", "/api/me/preferences")).body.preferences).toEqual({ runAlertEmails: false, securityEmails: true, projectsView: "list" });
        expect((await as("t-bob", "GET", "/api/me/preferences")).body.preferences.projectsView).toBe("dashboard");
        expect((await as("t-cora", "PUT", "/api/me/preferences", { projectsView: "grid" })).status).toBe(400);
        expect(await asKey("PUT", "/api/me/preferences", { projectsView: "list" })).toMatchObject({ status: 409, body: { error: NO_PREFERENCES } });
        expect((await asKey("GET", "/api/me/preferences")).body.saved).toBe(false);
    });

    it("leave a person out of alert emails of the kind they turned off, and only that kind", async () => {
        const id = (await asKey("POST", "/api/projects", { name: "Alerts" })).body.id;
        const store = new AlertStore(platform.db, new SecretBox(dataDir, "folders-test-secret-key-0123456789"), () => undefined);
        const ch = store.createEmail({ projectId: id, name: "Team", recipients: ["Cora@People.example", "dev@team.example"], events: ["run_failed"] });
        expect(store.wantedRecipients(ch.id, "runAlertEmails")).toEqual(["dev@team.example"]);
        expect(store.wantedRecipients(ch.id, "securityEmails")).toEqual(["Cora@People.example", "dev@team.example"]);
        expect(wantedRecipients(platform.db, "runAlertEmails", ["cora@people.example"])).toEqual([]);
    });
});

describe("migration slot 41", () => {
    it("adds the folder, archive and preference columns and tables", () => {
        expect(FOLDERS_MIGRATION).toMatch(/CREATE TABLE project_folders/);
        const db = new Db(":memory:");
        const cols = db.dialect.listColumns(db, "projects").map((c) => c.name);
        expect(cols).toEqual(expect.arrayContaining(["folder_id", "archived_at", "archived_by"]));
        expect(db.dialect.tableExists(db, "user_preferences")).toBe(true);
        db.close();
    });
});
