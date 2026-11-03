/**
 * Phase 1 project work (US-010, US-011; ACCESS_MODEL.md, D-12, D-14, D-27), against a stand-in Crowd4Test API that serves
 * `/v1/auth/me` and the service endpoints `/v1/ai-studio/*`, as tests/permissions.test.ts does for sign-in: platforms, testing modes
 * and engines (defaults, backfill, validation, PATCH), the setup check, Crowd4Test's service off, on and unreachable (organisations,
 * people search), customers kept in their organisation while staff choose one, and the Crowd4Test project link, which grants nothing.
 */
import { zipSync } from "fflate";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { accessControlOf, registeredRoutes } from "../src/platform/auth/access.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { classifyRoute } from "../src/platform/auth/project-scope.js";
import { permissionRuleFor } from "../src/platform/auth/roles.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { C4T_SERVICE_OFF, C4T_SERVICE_UNREACHABLE } from "../src/platform/c4t-service.js";
import { Db } from "../src/platform/db.js";
import { PROJECT_SETUP_MIGRATION } from "../src/platform/project-setup.js";
import { C4T_SEARCH_NOTICE, OTHER_ORGANIZATION } from "../src/platform/routes/members.js";
import { OTHER_ORGANIZATION_PROJECT } from "../src/platform/routes/project-settings.js";
import { buildBackup, restoreBackup, unpackBackup } from "../src/platform/backup.js";
import { buildServer } from "../src/platform/server.js";

type App = Awaited<ReturnType<typeof buildServer>>;
const KEY = "phase1-owner-key-9b2e41";
const TOKEN = "service-token-for-tests-0123456789abcdef";
const SITE = "https://crowd4test.example";
const PAGE = { "x-requested-with": "ai-studio" };
const API_PORT = 7312;
const DOWN_PORT = 7313; // nothing listens here: Crowd4Test unreachable
const dirs: string[] = [];

const ORGS = [
    { id: "org-a", name: "Acme", status: "ACTIVE" },
    { id: "org-b", name: "Bravo Ltd", status: "ACTIVE" },
    { id: "org-s", name: "Sleepy", status: "SUSPENDED" },
];
const C4T_PROJECTS: Record<string, Array<{ id: string; reference: string; title: string; status: string }>> = {
    "org-a": [{ id: "c4p-1", reference: "PRJ-001", title: "Checkout crowd test", status: "IN_PROGRESS" }],
    "org-b": [{ id: "c4p-2", reference: "PRJ-002", title: "Bravo app", status: "APPROVED" }],
    "org-s": [],
};
const PEOPLE = [
    { id: "newbie", name: "New Person", email: "newbie@people.example", kind: "TESTER", organisationId: null },
    { id: "alice2", name: "Alice Two", email: "alice2@people.example", kind: "CUSTOMER", organisationId: "org-a" },
    { id: "bob-b", name: "Bob Bravo", email: "bob-b@people.example", kind: "CUSTOMER", organisationId: "org-b" },
];
const me = (id: string, role: string, permissions: readonly string[], organisationId: string | null = null) => ({
    data: { user: { id, email: `${id}@people.example`, role, status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions, organisationId } },
});
const ACCOUNTS: Record<string, unknown> = {
    "t-admin": me("ada", "ADMIN", []),
    "t-cust": me("cora", "CUSTOMER", PERMISSIONS, "org-a"),
    "t-cust-read": me("rita", "CUSTOMER", ["ai_studio.access", "ai_studio.tests.write"], "org-a"),
    "t-tester": me("tim", "TESTER", PERMISSIONS),
};
const seen: Array<{ url: string; auth: string; ip: string }> = [];

let api: http.Server;
let on: { platform: Platform; app: App };
let off: { platform: Platform; app: App };
let down: { platform: Platform; app: App };

const start = async (extra: Record<string, string>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-phase1-"));
    dirs.push(dir);
    const platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", API_KEY: KEY, SECRET_KEY: "phase1-test-secret-key-0123456789", ...extra }));
    const app = await buildServer(platform);
    await app.ready();
    return { platform, app };
};
const call = (app: App, headers: Record<string, string>, method: string, url: string, payload?: unknown) =>
    app
        .inject({ method: method as "GET", url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) })
        .then((r) => ({ status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body }));
const asKey = (app: App, method: string, url: string, payload?: unknown) => call(app, { "x-api-key": KEY }, method, url, payload);
const as = (token: string, method: string, url: string, payload?: unknown) =>
    call(on.app, { cookie: `c4t_access=${token}`, "x-forwarded-for": "203.0.113.9", ...(method === "GET" ? {} : PAGE) }, method, url, payload);
const personOf = async (token: string): Promise<string> => (await as(token, "GET", "/api/auth/state")).body.me.id;

beforeAll(async () => {
    api = http.createServer((req, res) => {
        const u = new URL(req.url ?? "/", "http://x");
        const auth = String(req.headers.authorization ?? "");
        seen.push({ url: u.pathname + u.search, auth, ip: String(req.headers["x-c4t-client-ip"] ?? "") });
        const send = (status: number, body: unknown) => {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify(body));
        };
        if (u.pathname === "/v1/auth/me") {
            const answer = ACCOUNTS[auth.replace(/^Bearer /, "")];
            return answer ? send(200, answer) : send(401, { error: { message: "Invalid access token" } });
        }
        if (auth !== `Bearer ${TOKEN}`) return send(401, { error: { message: "A valid service token is required" } });
        if (u.pathname === "/v1/ai-studio/organisations") return send(200, { data: ORGS });
        const m = /^\/v1\/ai-studio\/organisations\/([^/]+)\/projects$/.exec(u.pathname);
        if (m) return C4T_PROJECTS[m[1]!] ? send(200, { data: C4T_PROJECTS[m[1]!] }) : send(404, { error: { message: "Organisation not found" } });
        if (u.pathname === "/v1/ai-studio/people") {
            const q = (u.searchParams.get("q") ?? "").toLowerCase();
            return send(200, { data: PEOPLE.filter((p) => !q || p.name.toLowerCase().includes(q) || p.email.includes(q)) });
        }
        send(404, { error: { message: "Not found" } });
    });
    await new Promise<void>((r) => api.listen(API_PORT, "127.0.0.1", r));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    on = await start({ C4T_API_ORIGIN: `http://127.0.0.1:${API_PORT}`, C4T_SITE_URL: SITE, C4T_SERVICE_TOKEN: TOKEN });
    off = await start({});
    down = await start({ C4T_API_ORIGIN: `http://127.0.0.1:${DOWN_PORT}`, C4T_SITE_URL: SITE, C4T_SERVICE_TOKEN: TOKEN });
}, 60_000);

afterAll(async () => {
    for (const x of [on, off, down]) await x?.app.close();
    await new Promise((r) => api?.close(r));
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("platforms, testing modes and engines (US-010)", () => {
    it("defaults to web with agent mode (round 37: one mode), and adds the camelCase fields beside every existing one", async () => {
        const made = await asKey(off.app, "POST", "/api/projects", { name: "Plain", description: "Old client" });
        expect(made.status).toBe(201);
        expect(made.body).toMatchObject({ name: "Plain", description: "Old client", platforms: ["web"], testingModes: ["agent"], codeEngines: { web: "playwright" } });
        expect(made.body).toHaveProperty("created_at");
        expect(made.body).toHaveProperty("test_count", 0);
        const one = (await asKey(off.app, "GET", `/api/projects/${made.body.id}`)).body;
        expect(one).toMatchObject({ description: "Old client", platforms: ["web"], testingModes: ["agent"], codeEngines: { web: "playwright" }, c4tProject: null });
        expect(one).toHaveProperty("suites");
        const listed = (await asKey(off.app, "GET", "/api/projects")).body.find((p: { id: string }) => p.id === made.body.id);
        expect(listed).toMatchObject({ platforms: ["web"], testingModes: ["agent"], codeEngines: { web: "playwright" }, test_count: 0 });
    });

    it("backfills existing projects: web, both modes, and Android or iOS with Taqwright when a mobile app is set", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-phase1-db-"));
        dirs.push(dir);
        const file = path.join(dir, "x.db");
        const db = new Db(file);
        db.run("INSERT INTO users (id, email, name, created_at) VALUES ('u', 'u@x', 'u', '2026-01-01')");
        const t = "2026-01-01T00:00:00.000Z";
        for (const id of ["p-web", "p-android", "p-ios", "p-both"]) db.run("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?, 'u', ?, ?, ?)", id, id, t, t);
        const app = (id: string, at: string, config: unknown) =>
            db.run("INSERT INTO applications (id, project_id, url, origin, config_json, created_at) VALUES (?,?,?,?,?,?)", `${id}-${at}`, id, "https://x.example/", "https://x.example", JSON.stringify(config), at);
        app("p-web", "2026-01-02", { maxPages: 5 });
        app("p-android", "2026-01-02", { mobile: { appPackage: "com.example.shop" } });
        app("p-ios", "2026-01-02", { mobile: { iosBundleId: "com.example.ios" } });
        app("p-both", "2026-01-02", { mobile: { apkPath: "/data/app.apk", iosBundleId: "com.example.ios" } });
        // Back to before slot 35, then the slot's SQL on these rows (later slots stay as they are).
        for (const c of ["platforms", "testing_modes", "code_engines", "c4t_project_id"]) db.run(`ALTER TABLE projects DROP COLUMN ${c}`);
        db.raw.exec(PROJECT_SETUP_MIGRATION);
        db.close();
        const again = new Db(file);
        const row = (id: string) => again.get<{ platforms: string; testing_modes: string; code_engines: string; c4t_project_id: string | null }>("SELECT * FROM projects WHERE id = ?", id)!;
        expect(row("p-web")).toMatchObject({ platforms: '["web"]', testing_modes: '["agent","code"]', code_engines: '{"web":"playwright"}', c4t_project_id: null });
        expect(row("p-android")).toMatchObject({ platforms: '["web","android"]', code_engines: '{"web":"playwright","mobile":"taqwright"}' });
        expect(row("p-ios")).toMatchObject({ platforms: '["web","ios"]', code_engines: '{"web":"playwright","mobile":"taqwright"}' });
        expect(row("p-both").platforms).toBe('["web","android","ios"]');
        again.close();
    });

    it("refuses unknown and empty lists in plain words", async () => {
        expect(await asKey(off.app, "POST", "/api/projects", { name: "X", platforms: ["web", "windows"] })).toMatchObject({ status: 400, body: { error: '"windows" is not a platform. Choose web, android or ios.' } });
        expect(await asKey(off.app, "POST", "/api/projects", { name: "X", platforms: [] })).toMatchObject({ status: 400, body: { error: "Choose at least one platform." } });
        expect(await asKey(off.app, "POST", "/api/projects", { name: "X", testingModes: [] })).toMatchObject({ status: 400, body: { error: "Choose at least one testing mode." } });
        expect(await asKey(off.app, "POST", "/api/projects", { name: "X", testingModes: ["live"] })).toMatchObject({ status: 400, body: { error: '"live" is not a testing mode. Choose agent or code.' } });
        // Round 37: one platform (a repeat counts once); more than one is refused (tests/project-basics.test.ts).
        const mobile = await asKey(off.app, "POST", "/api/projects", { name: "Phones", platforms: ["ios", "ios"], testingModes: ["code"] });
        expect(mobile.body).toMatchObject({ platforms: ["ios"], testingModes: ["code"], codeEngines: { mobile: "taqwright" } });
    });

    it("PATCH changes what is given, recomputes the engines, and narrowing keeps every test", async () => {
        const id = (await asKey(off.app, "POST", "/api/projects", { name: "Narrow" })).body.id as string;
        const { repo } = off.platform;
        const spec = TestSpecSchema.parse({ testId: "WEB-001", title: "Home", kind: "web", category: "Smoke", priority: "high", steps: [{ action: "navigate", url: "/" }] });
        repo.insertTest({ projectId: id, suiteId: repo.getOrCreateSuite(id, "Smoke", "smoke"), jobId: null as unknown as string, spec, framework: "playwright", validationStatus: "PENDING" });
        const patched = await asKey(off.app, "PATCH", `/api/projects/${id}`, { platforms: ["android"], testingModes: ["code"], description: "Now mobile" });
        expect(patched.status).toBe(200);
        expect(patched.body).toMatchObject({ name: "Narrow", description: "Now mobile", platforms: ["android"], testingModes: ["code"], codeEngines: { mobile: "taqwright" } });
        expect(patched.body.codeEngines).not.toHaveProperty("web");
        expect((await asKey(off.app, "GET", `/api/projects/${id}/tests`)).body.map((t: { title: string }) => t.title)).toEqual(["Home"]);
        expect((await asKey(off.app, "PATCH", `/api/projects/${id}`, { name: "Renamed" })).body).toMatchObject({ name: "Renamed", platforms: ["android"] });
        expect(await asKey(off.app, "PATCH", `/api/projects/${id}`, { platforms: [] })).toMatchObject({ status: 400, body: { error: "Choose at least one platform." } });
        expect((await asKey(off.app, "PATCH", `/api/projects/${id}`, { owner_id: "someone" })).status).toBe(400);
        expect((await asKey(off.app, "PATCH", "/api/projects/nope", { name: "Y" })).status).toBe(404);
    });

    it("a backup keeps the platforms and testing modes, and an older backup without them restores as the defaults", async () => {
        // An older project with two platforms (as production has them): the backup keeps both.
        const id = (await asKey(off.app, "POST", "/api/projects", { name: "Kept in backup", platforms: ["ios"], testingModes: ["code"] })).body.id as string;
        off.platform.repo.updateProject(id, { platforms: ["web", "ios"] });
        const { bytes } = await buildBackup(off.platform, id, { evidence: false, maxEvidenceMB: 0 });
        const restored = await restoreBackup(off.platform, bytes, { name: "Kept in backup (restored)" });
        expect((await asKey(off.app, "GET", `/api/projects/${restored.project.id}`)).body).toMatchObject({ platforms: ["web", "ios"], testingModes: ["code"], codeEngines: { web: "playwright", mobile: "taqwright" } });
        // An older backup: project.json without the two lists.
        const files = unpackBackup(bytes);
        const doc = JSON.parse(new TextDecoder().decode(files.get("project.json")!)) as Record<string, unknown>;
        expect(doc).toMatchObject({ platforms: ["web", "ios"], testingModes: ["code"] });
        delete doc.platforms;
        delete doc.testingModes;
        files.set("project.json", new TextEncoder().encode(JSON.stringify(doc)));
        const older = await restoreBackup(off.platform, zipSync(Object.fromEntries(files)), { name: "From an older backup" });
        expect((await asKey(off.app, "GET", `/api/projects/${older.project.id}`)).body).toMatchObject({ platforms: ["web"], testingModes: ["agent", "code"] });
    });
});

describe("the setup check", () => {
    it("lists one item per need of the chosen platforms and modes, ok or not", async () => {
        // An older project with every platform and both modes (round 37 no longer makes these, but keeps them).
        const id = (await asKey(off.app, "POST", "/api/projects", { name: "Everything" })).body.id as string;
        off.platform.repo.updateProject(id, { platforms: ["web", "android", "ios"], testingModes: ["agent", "code"] });
        const items = (await asKey(off.app, "GET", `/api/projects/${id}/setup-check`)).body.items as Array<{ key: string; ok: boolean; text: string }>;
        expect(items.map((i) => i.key)).toEqual(["web-address", "android-app", "ios-app", "ios-runner", "ai-model", "runner"]);
        const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
        expect(byKey["web-address"]!.ok).toBe(false);
        expect(byKey["android-app"]!.ok).toBe(false);
        expect(byKey["ios-runner"]).toEqual({ key: "ios-runner", ok: false, text: "iOS tests need a runner on a Mac with Xcode." });
        expect(byKey["ai-model"]!.ok).toBe(off.platform.llm.modelName !== "unavailable");
        expect(byKey.runner).toMatchObject({ ok: true, text: "Tests run on this server." });
        for (const i of items) expect(i.text).toMatch(/^[A-Za-z].*\.$/);

        expect((await asKey(off.app, "PUT", `/api/projects/${id}/mobile-app`, { appPackage: "com.example.shop" })).status).toBe(200);
        off.platform.repo.createApplication(id, "https://shop.example/", {});
        const after = Object.fromEntries(((await asKey(off.app, "GET", `/api/projects/${id}/setup-check`)).body.items as Array<{ key: string; ok: boolean }>).map((i) => [i.key, i.ok]));
        expect(after).toMatchObject({ "web-address": true });
        const code = (await asKey(off.app, "POST", "/api/projects", { name: "Code only", platforms: ["android"], testingModes: ["code"] })).body.id as string;
        expect((await asKey(off.app, "GET", `/api/projects/${code}/setup-check`)).body.items.map((i: { key: string }) => i.key)).toEqual(["android-app", "runner"]);
    });
});

describe("Crowd4Test's service", () => {
    it("off: organisations come from the mirror, people from those signed in, and linking says why it cannot", async () => {
        const id = (await asKey(off.app, "POST", "/api/projects", { name: "Off", organizationId: "org-q" })).body.id as string;
        expect((await asKey(off.app, "GET", "/api/organizations")).body).toEqual({ organizations: [{ id: "org-q", name: null, status: null }], source: "mirror" });
        expect((await asKey(off.app, "GET", `/api/projects/${id}/members/candidates`)).body.source).toBe("signed-in");
        expect((await asKey(off.app, "GET", `/api/projects/${id}/c4t-projects`)).body).toEqual({ available: false, projects: [], c4tProjectId: null, message: C4T_SERVICE_OFF });
        expect(await asKey(off.app, "PATCH", `/api/projects/${id}`, { c4tProjectId: "c4p-1" })).toMatchObject({ status: 409, body: { error: C4T_SERVICE_OFF } });
    });

    it("on: organisations by side, with the token and the visitor's address, and the mirror filled", async () => {
        const all = (await as("t-admin", "GET", "/api/organizations")).body;
        expect(all).toEqual({ organizations: ORGS, source: "crowd4test" });
        expect((await as("t-cust", "GET", "/api/organizations")).body.organizations).toEqual([ORGS[0]]);
        expect((await as("t-tester", "GET", "/api/organizations")).body.organizations).toEqual([]);
        const asked = seen.filter((s) => s.url.startsWith("/v1/ai-studio/organisations"));
        expect(asked.length).toBe(1); // cached for 5 minutes
        expect(asked[0]).toMatchObject({ auth: `Bearer ${TOKEN}`, ip: "203.0.113.9" });
        expect(accessControlOf(on.app).projects.store.organization("org-a")).toMatchObject({ name: "Acme", status: "ACTIVE" });
    });

    it("on: people search from Crowd4Test, with someone new here added as a member and nothing more", async () => {
        const pa = (await as("t-admin", "POST", "/api/projects", { name: "Alpha", organizationId: "org-a" })).body.id as string;
        const found = (await as("t-admin", "GET", `/api/projects/${pa}/members/candidates`)).body;
        expect(found.source).toBe("crowd4test");
        const emails = found.people.map((p: { email: string }) => p.email);
        expect(emails).toEqual(expect.arrayContaining(["newbie@people.example", "alice2@people.example"]));
        expect(emails).not.toContain("bob-b@people.example");
        const newbie = found.people.find((p: { email: string }) => p.email === "newbie@people.example");
        expect(newbie).toMatchObject({ personId: "crowd4test:newbie", kind: "tester", newHere: true, organizationId: null });
        const users = accessControlOf(on.app).users;
        // Refused before anything is made: another organisation's customer.
        const pb = (await as("t-admin", "POST", "/api/projects", { name: "Bravo", organizationId: "org-b" })).body.id as string;
        expect(await as("t-admin", "POST", `/api/projects/${pa}/members`, { personId: "crowd4test:bob-b" })).toMatchObject({ status: 403, body: { error: OTHER_ORGANIZATION } });
        expect(users.byEmail("bob-b@people.example")).toBeUndefined();
        expect((await as("t-admin", "POST", `/api/projects/${pb}/members`, { personId: "crowd4test:bob-b" })).status).toBe(201);

        const added = await as("t-admin", "POST", `/api/projects/${pa}/members`, { personId: "crowd4test:newbie" });
        expect(added.status).toBe(201);
        expect(added.body.member).toMatchObject({ email: "newbie@people.example", kind: "tester", projectAdmin: false });
        const person = users.byEmail("newbie@people.example")!;
        const reach = accessControlOf(on.app).projects.store.accessOf(person.id);
        expect(reach.mode).toBe("only");
        expect([...(reach as { projects: Map<string, string> }).projects.keys()]).toEqual([pa]);
        // A member now: no longer offered, under their own person id.
        const again = (await as("t-admin", "GET", `/api/projects/${pa}/members/candidates`)).body.people.map((p: { personId: string }) => p.personId);
        expect(again).not.toContain(person.id);
        expect(again).not.toContain("crowd4test:newbie");
        expect(await as("t-admin", "POST", `/api/projects/${pa}/members`, { personId: "crowd4test:nobody" })).toMatchObject({ status: 404 });
    });

    it("unreachable: plain words, the mirror and the signed-in people instead, and no hanging", async () => {
        const id = (await asKey(down.app, "POST", "/api/projects", { name: "Down" })).body.id as string;
        accessControlOf(down.app).projects.store.setProjectOrganization(id, "org-a");
        const started = Date.now();
        const people = (await asKey(down.app, "GET", `/api/projects/${id}/members/candidates`)).body;
        expect(people).toMatchObject({ source: "signed-in", notice: C4T_SEARCH_NOTICE });
        expect((await asKey(down.app, "GET", "/api/organizations")).body).toMatchObject({ source: "mirror", notice: C4T_SERVICE_UNREACHABLE });
        expect(await asKey(down.app, "GET", `/api/projects/${id}/c4t-projects`)).toMatchObject({ status: 503, body: { error: C4T_SERVICE_UNREACHABLE } });
        expect(await asKey(down.app, "POST", "/api/projects", { name: "Staff", organizationId: "org-a" })).toMatchObject({ status: 503, body: { error: C4T_SERVICE_UNREACHABLE } });
        expect(Date.now() - started).toBeLessThan(15_000);
    });
});

describe("organisations of new projects", () => {
    it("keeps customers in their own; staff choose one that exists and is active", async () => {
        expect((await as("t-cust", "POST", "/api/projects", { name: "Elsewhere", organizationId: "org-b" })).status).toBe(403);
        expect((await as("t-cust", "POST", "/api/projects", { name: "Mine", platforms: ["android"] })).body).toMatchObject({ organization_id: "org-a", platforms: ["android"] });
        expect(await as("t-admin", "POST", "/api/projects", { name: "Sleepy", organizationId: "org-s" })).toMatchObject({ status: 409, body: { error: "That organisation is suspended on Crowd4Test, so projects cannot be created in it." } });
        expect(await as("t-admin", "POST", "/api/projects", { name: "Ghost", organizationId: "org-zzz" })).toMatchObject({ status: 404, body: { error: "Crowd4Test has no organisation with that id." } });
        expect((await as("t-admin", "POST", "/api/projects", { name: "For Bravo", organizationId: "org-b" })).body.organization_id).toBe("org-b");
        expect((await asKey(on.app, "POST", "/api/projects", { name: "Key", organizationId: "org-zzz" })).status).toBe(404);
    });
});

describe("linking a Crowd4Test project (US-011, D-27)", () => {
    it("links only the same organisation's projects, shows the reference, unlinks, is audited, and grants nobody anything", async () => {
        const id = (await as("t-admin", "POST", "/api/projects", { name: "Linked", organizationId: "org-a" })).body.id as string;
        expect((await as("t-admin", "GET", `/api/projects/${id}/c4t-projects`)).body).toEqual({ available: true, projects: C4T_PROJECTS["org-a"], c4tProjectId: null });
        expect(await as("t-admin", "PATCH", `/api/projects/${id}`, { c4tProjectId: "c4p-2" })).toMatchObject({ status: 403, body: { error: OTHER_ORGANIZATION_PROJECT } });
        const linked = await as("t-admin", "PATCH", `/api/projects/${id}`, { c4tProjectId: "c4p-1" });
        expect(linked.status).toBe(200);
        expect(linked.body).toMatchObject({ c4t_project_id: "c4p-1", c4tProject: { id: "c4p-1", reference: "PRJ-001", title: "Checkout crowd test" } });
        expect((await as("t-admin", "GET", `/api/projects/${id}`)).body.c4tProject).toEqual({ id: "c4p-1", reference: "PRJ-001", title: "Checkout crowd test" });

        // Nobody reaches it through the link: not a customer of the organisation, not a tester.
        await personOf("t-tester");
        for (const t of ["t-cust", "t-tester", "t-cust-read"]) {
            expect((await as(t, "GET", `/api/projects/${id}`)).status).toBe(404);
            expect((await as(t, "GET", "/api/projects")).body.map((p: { id: string }) => p.id)).not.toContain(id);
        }
        // A member without ai_studio.project.settings cannot change the link or list the choices.
        expect((await as("t-admin", "POST", `/api/projects/${id}/members`, { personId: await personOf("t-cust-read") })).status).toBe(201);
        expect((await as("t-cust-read", "PATCH", `/api/projects/${id}`, { c4tProjectId: null })).status).toBe(403);
        expect((await as("t-cust-read", "GET", `/api/projects/${id}/c4t-projects`)).status).toBe(403);
        expect((await as("t-cust-read", "GET", `/api/projects/${id}/setup-check`)).status).toBe(200);
        // A tester on the project never gets the organisation's list of Crowd4Test projects, whatever they hold.
        expect((await as("t-admin", "POST", `/api/projects/${id}/members`, { personId: await personOf("t-tester") })).status).toBe(201);
        expect((await as("t-tester", "GET", `/api/projects/${id}/c4t-projects`)).status).toBe(403);

        const unlinked = await as("t-admin", "PATCH", `/api/projects/${id}`, { c4tProjectId: null });
        expect(unlinked.body).toMatchObject({ c4t_project_id: null, c4tProject: null });
        const actions = accessControlOf(on.app).users.activity({ projectId: id, limit: 50 }).map((r) => r.action);
        expect(actions).toEqual(expect.arrayContaining(["linked a Crowd4Test project", "unlinked the Crowd4Test project"]));
    });
});

describe("every new route is classified", () => {
    it("has a permission rule and a scope", () => {
        const routes = ["PATCH /api/projects/:id", "GET /api/projects/:id/setup-check", "GET /api/projects/:id/c4t-projects", "GET /api/organizations"];
        const registered = new Set(registeredRoutes(on.app).map((r) => `${r.method} ${r.url}`));
        expect(permissionRuleFor("PATCH", "/api/projects/:id")).toBe("ai_studio.project.settings");
        expect(permissionRuleFor("GET", "/api/projects/:id/c4t-projects")).toBe("ai_studio.project.settings");
        expect(permissionRuleFor("GET", "/api/organizations")).toBe("read");
        for (const r of routes) {
            expect(registered.has(r)).toBe(true);
            const [method, url] = r.split(" ") as [string, string];
            expect(permissionRuleFor(method, url)).toBeDefined();
            expect(classifyRoute(method, url, permissionRuleFor(method, url))).toBeDefined();
        }
        expect(classifyRoute("GET", "/api/organizations", "read")).toEqual({ kind: "none" });
        expect(classifyRoute("PATCH", "/api/projects/:id", "ai_studio.project.settings")).toEqual({ kind: "project", param: "id" });
    });
});
