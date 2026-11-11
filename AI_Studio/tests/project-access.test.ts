/**
 * Per-project access through the real API (Fastify inject, real database): a person limited to "only these projects" gets 404 for
 * everything of another project and the same answers as an unlimited owner inside their own. The route sweep is built from the
 * routes the server really registers (like the route-to-role table test), so a new route cannot be forgotten: every route must be
 * classified (auth/project-scope.ts), every project or object route is called with another project's ids, and every GET route with
 * the person's own ids is compared with the access key's answer. Also: roles per project under the platform role, personal API
 * tokens and sessions, the projects list and dashboard counts, live-update tickets, security objects, the People API rules, and that
 * existing people keep access to all projects.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { accessControlOf, registeredRoutes } from "../src/platform/auth/access.js";
import { hashPassword } from "../src/platform/auth/password.js";
import { ALL_PROJECTS_NEEDED, classifyRoute, NOT_FOUND, type ObjectKind } from "../src/platform/auth/project-scope.js";
import { ruleFor } from "../src/platform/auth/roles.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { Db } from "../src/platform/db.js";
import { HttpError } from "../src/platform/http-error.js";
import { ProjectAccessStore } from "../src/platform/project-access-store.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { recorderOf } from "../src/platform/routes/recorder.js";
import { buildServer } from "../src/platform/server.js";
import { UserStore } from "../src/platform/user-store.js";

type App = Awaited<ReturnType<typeof buildServer>>;
const KEY = "acc-owner-key-3b7e91d2";
const dirs: string[] = [];
const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-acc-"));
    dirs.push(d);
    return d;
};
afterAll(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

let platform: Platform;
let app: App;

interface Seed {
    project: string;
    test: string;
    job: string;
    artifact: string;
    recording: string;
    integration: string;
    "security-application": string;
    "security-assessment": string;
    "security-finding": string;
    "security-authorization": string;
}
let A: Seed;
let B: Seed;

/** Everything a project can hold that a route finds by its own id. Written directly: this test is about who may reach it. */
async function seed(name: string): Promise<Seed> {
    const { repo, db } = platform;
    const project = repo.createProject({ name }).id as string;
    const appId = repo.createApplication(project, "http://127.0.0.1:7131/", {});
    const job = (await repo.createJob(project, appId, { ...DEFAULT_JOB_OPTIONS })).id;
    const now = new Date().toISOString();
    // Finished, so the project has no active job (streams of a project end at once, and runs can still be asked for).
    db.run("UPDATE generation_jobs SET status = 'COMPLETED', finished_at = ? WHERE id = ?", now, job);
    const spec = TestSpecSchema.parse({ testId: "API-001", title: `Cart of ${name}`, kind: "api", category: "Checkout", priority: "high", steps: [{ action: "request", method: "GET", path: "/api/cart" }] });
    const test = repo.insertTest({ projectId: project, suiteId: repo.getOrCreateSuite(project, "Checkout", "checkout"), jobId: null, spec, framework: "playwright-api", validationStatus: "PENDING" });
    const stored = await platform.store.put(`${project}/shot.png`, "png");
    const artifact = repo.addArtifact({ projectId: project, testId: test, kind: "screenshot", path: stored.key, size: stored.size });
    const integration = randomUUID();
    db.run("INSERT INTO integrations (id, project_id, kind, name, config_json, secret_enc, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)", integration, project, "github", "Tracker", "{}", "x", now, now);
    const secApp = randomUUID();
    db.run(
        "INSERT INTO security_applications (id, project_id, name, target_url, environment, scope_json, excluded_paths_json, max_rps, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        secApp, project, `${name} site`, "http://127.0.0.1:7131/", "staging", "[]", "[]", 2, now, now,
    );
    const secAuth = randomUUID();
    db.run(
        "INSERT INTO security_authorizations (id, application_id, basis, approver_name, statement, confirmed_by_name, confirmed_at, scope_fingerprint) VALUES (?,?,?,?,?,?,?,?)",
        secAuth, secApp, "owner", "Olga", "We own this.", "Olga", now, "fp",
    );
    const secAssessment = randomUUID();
    db.run("INSERT INTO security_assessments (id, application_id, project_id, authorization_id, state, started_by, created_at, finished_at) VALUES (?,?,?,?,?,?,?,?)", secAssessment, secApp, project, secAuth, "completed", "Olga", now, now);
    const secFinding = randomUUID();
    db.run(
        `INSERT INTO security_findings (id, project_id, application_id, first_assessment_id, last_assessment_id, fingerprint, title, category, severity, confidence, location, description, impact, remediation, evidence_json, source, validation, first_seen_at, last_seen_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        secFinding, project, secApp, secAssessment, secAssessment, `fp-${name}`, "Missing header", "headers", "low", "high", "/", "d", "i", "r", "[]", "manual", "new", now, now, now,
    );
    // A recording lives in memory: a stand-in driver joins the real recorder service (no browser).
    const recording = randomUUID();
    const refuse = async () => {
        throw new HttpError(409, "Not available in this test");
    };
    recorderOf(app)!.register(project, () => ({
        id: recording,
        projectId: project,
        snapshot: () => ({ id: recording, projectId: project, status: "recording", startUrl: "http://127.0.0.1:7131/", headed: false, steps: [], inspect: { on: false, mode: "locator" }, startedAt: now, canSave: false, notes: [] }) as never,
        setInspect: refuse,
        patchStep: refuse,
        deleteStep: () => undefined,
        setRef: () => undefined,
        step: () => {
            throw new HttpError(404, "No such step");
        },
        stop: async () => undefined,
        discard: async () => undefined,
        markSaved: () => undefined,
        act: refuse as never,
        liveSnapshot: refuse as never,
        settled: async () => undefined,
        pid: () => undefined,
        dispose: async () => undefined,
    }));
    return { project, test, job, artifact, recording, integration, "security-application": secApp, "security-assessment": secAssessment, "security-finding": secFinding, "security-authorization": secAuth };
}

const call = (method: string, url: string, headers: Record<string, string>, body?: unknown) =>
    app.inject({ method: method as "GET", url, headers, ...(body !== undefined ? { payload: body as object } : {}) }).then((r) => ({ status: r.statusCode, body: r.body && (r.body.startsWith("{") || r.body.startsWith("[")) ? JSON.parse(r.body) : r.body }));
const asKey = { "x-api-key": KEY };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** A person with a platform role, limited (or not) to projects, and a personal token of theirs. */
function person(email: string, role: "owner" | "editor" | "viewer", access: { mode: "all" } | { mode: "only"; projects: Array<{ projectId: string; role: "owner" | "editor" | "viewer" }> }) {
    const control = accessControlOf(app);
    const u = control.users.create({ email, name: email.split("@")[0]!, role });
    control.projects.store.set(u.id, access);
    return { id: u.id, token: control.users.createToken(u.id, { name: "t", role }).token };
}

/** The route template with the ids of one seeded project filled in (other parameters get a harmless placeholder). */
function fill(template: string, s: Seed): string {
    const scope = classifyRoute("GET", template, undefined);
    const objectId = scope?.kind === "object" ? s[scope.object as ObjectKind] : undefined;
    return template.replace(/:([A-Za-z]+)/g, (_m, name: string) => {
        if (scope?.kind === "project" && name === "id") return s.project;
        if (scope?.kind === "object" && name === scope.param) return objectId!;
        if (name === "jobId") return s.job;
        return "x";
    });
}

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    platform = bootstrap(loadConfig({ DATA_DIR: tmp(), SCHEDULER_ENABLED: "false", API_KEY: KEY, SECRET_KEY: "acc-test-secret-key-0123456789", SECURITY_ASSESSMENT: "on" }));
    app = await buildServer(platform);
    await app.ready();
    A = await seed("Alpha");
    B = await seed("Bravo");
}, 60_000);
afterAll(async () => {
    await app?.close();
    platform?.db.close();
});

describe("every registered route is placed", () => {
    it("classifies each route: a project, an object, a narrowed list, nothing of a project, or platform-wide", () => {
        const routes = registeredRoutes(app).filter((r) => r.method !== "HEAD");
        expect(routes.length).toBeGreaterThan(200);
        const unplaced = [...new Set(routes.filter((r) => !classifyRoute(r.method, r.url, ruleFor(r.method, r.url))).map((r) => `${r.method} ${r.url}`))].sort();
        expect(unplaced, `Routes without a project scope in src/platform/auth/project-scope.ts (EXPLICIT_SCOPES or PATTERNS):\n${unplaced.join("\n")}`).toEqual([]);
    });
});

describe("a person limited to one project, route by route", () => {
    let lena: { id: string; token: string };
    let routes: Array<{ method: string; url: string }>;
    beforeAll(() => {
        // Owner on the platform and in Alpha, so roles never get in the way: only the project decides.
        lena = person("lena@example.com", "owner", { mode: "only", projects: [{ projectId: A.project, role: "owner" }] });
        const seen = new Set<string>();
        routes = registeredRoutes(app).filter((r) => r.method !== "HEAD" && !seen.has(`${r.method} ${r.url}`) && seen.add(`${r.method} ${r.url}`));
    });

    it("answers 404 for every route about another project or one of its objects, with the words of a missing one", async () => {
        const scoped = routes.filter((r) => ["project", "object"].includes(classifyRoute(r.method, r.url, ruleFor(r.method, r.url))?.kind ?? ""));
        expect(scoped.length).toBeGreaterThan(250);
        const wrong: string[] = [];
        for (const r of scoped) {
            const scope = classifyRoute(r.method, r.url, ruleFor(r.method, r.url))!;
            const res = await call(r.method, fill(r.url, B), bearer(lena.token), r.method === "GET" || r.method === "DELETE" ? undefined : {});
            const words = scope.kind === "object" ? NOT_FOUND[scope.object] : NOT_FOUND.project;
            if (res.status !== 404 || res.body?.error !== words) wrong.push(`${r.method} ${r.url}: ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
        }
        expect(wrong, wrong.join("\n")).toEqual([]);
    }, 120_000);

    it("gives the same answer as the access key for every GET route of their own project", async () => {
        const gets = routes.filter((r) => r.method === "GET" && ["project", "object"].includes(classifyRoute(r.method, r.url, ruleFor(r.method, r.url))?.kind ?? ""));
        // Streams stay open by design (the stream test covers them); the B sweep above already refused them before any byte.
        const reads = gets.filter((r) => !r.url.endsWith("/stream"));
        expect(reads.length).toBeGreaterThan(100);
        const differ: string[] = [];
        for (const r of reads) {
            const url = fill(r.url, A);
            const mine = await call("GET", url, bearer(lena.token));
            const key = await call("GET", url, asKey);
            if (mine.status !== key.status) differ.push(`GET ${r.url}: ${mine.status} (limited) vs ${key.status} (key) ${JSON.stringify(mine.body).slice(0, 120)}`);
            if (mine.status === 404 && typeof mine.body === "object" && mine.body?.error && Object.values(NOT_FOUND).includes(mine.body.error) && key.status !== 404) differ.push(`GET ${r.url}: hidden from its own project`);
        }
        expect(differ, differ.join("\n")).toEqual([]);
    }, 120_000);

    it("refuses every platform-wide route with a plain sentence, and leaves routes without project data alone", async () => {
        const wide = routes.filter((r) => (classifyRoute(r.method, r.url, ruleFor(r.method, r.url))?.kind ?? "all") === "all");
        expect(wide.map((r) => `${r.method} ${r.url}`)).toEqual(expect.arrayContaining(["GET /api/users", "PUT /api/users/:userId/projects", "GET /api/activity", "GET /api/storage", "POST /api/projects", "POST /api/projects/restore", "GET /api/eval/runs"]));
        for (const r of wide) {
            const res = await call(r.method, r.url.replace(/:([A-Za-z]+)/g, "x"), bearer(lena.token), r.method === "GET" || r.method === "DELETE" ? undefined : {});
            expect(res.status, `${r.method} ${r.url}`).toBe(403);
            expect(res.body.error).toBe(ALL_PROJECTS_NEEDED);
        }
        expect((await call("GET", "/api/config", bearer(lena.token))).status).toBe(200);
        expect((await call("GET", "/api/me/tokens", bearer(lena.token))).status).toBe(200);
        expect((await call("GET", "/api/v1/security/status", bearer(lena.token))).status).toBe(200);
    }, 60_000);

    it("hides an object of another project exactly like an object that does not exist", async () => {
        for (const [url, unknown] of [
            [`/api/tests/${B.test}`, `/api/tests/${randomUUID()}`],
            [`/api/v1/security/findings/${B["security-finding"]}`, `/api/v1/security/findings/${randomUUID()}`],
            [`/api/projects/${B.project}`, `/api/projects/${randomUUID()}`],
        ] as const) {
            const hidden = await call("GET", url, bearer(lena.token));
            const missing = await call("GET", unknown, bearer(lena.token));
            expect(hidden).toEqual(missing);
        }
        // A security object asked for with the person's own project in ?projectId= is still another project's object.
        expect((await call("GET", `/api/v1/security/findings/${B["security-finding"]}?projectId=${A.project}`, bearer(lena.token))).status).toBe(404);
    });

    it("lists only the allowed projects, and counts only them on the dashboard", async () => {
        const mine = await call("GET", "/api/projects", bearer(lena.token));
        expect(mine.body.map((p: { id: string }) => p.id)).toEqual([A.project]);
        const all = await call("GET", "/api/projects", asKey);
        expect(all.body.map((p: { id: string }) => p.id).sort()).toEqual([A.project, B.project].sort());
        const dash = await call("GET", "/api/dashboard", bearer(lena.token));
        expect(dash.body.projects.map((p: { id: string }) => p.id)).toEqual([A.project]);
        expect(dash.body.summary).toMatchObject({ total: 1, sentence: "1 project: 1 needs attention" });
        expect((await call("GET", "/api/dashboard", asKey)).body.summary.total).toBe(2);
    });

    it("lets the usage page ask about an allowed project only", async () => {
        expect((await call("GET", `/api/usage?projectId=${A.project}`, bearer(lena.token))).status).toBe(200);
        expect((await call("GET", `/api/usage?projectId=${B.project}`, bearer(lena.token)))).toMatchObject({ status: 404, body: { error: "Project not found" } });
        expect((await call("GET", "/api/usage", bearer(lena.token)))).toMatchObject({ status: 403, body: { error: ALL_PROJECTS_NEEDED } });
    });

    it("makes live-update tickets only for their own project's runs", async () => {
        expect((await call("POST", "/api/stream-tickets", bearer(lena.token), { path: `/api/projects/${A.project}/stream` })).status).toBe(201);
        expect((await call("POST", "/api/stream-tickets", bearer(lena.token), { path: `/api/test-generation/${A.job}/stream` })).status).toBe(201);
        expect((await call("POST", "/api/stream-tickets", bearer(lena.token), { path: `/api/projects/${B.project}/stream` }))).toMatchObject({ status: 404, body: { error: "Project not found" } });
        expect((await call("POST", "/api/stream-tickets", bearer(lena.token), { path: `/api/test-generation/${B.job}/stream` }))).toMatchObject({ status: 404, body: { error: "Job not found" } });
    });

    it("keeps a run of another project out of a route of their own project", async () => {
        expect((await call("GET", `/api/projects/${A.project}/runs/${B.job}`, bearer(lena.token))).status).toBe(404);
        expect((await call("GET", `/api/projects/${A.project}/runs/${A.job}`, bearer(lena.token))).status).toBe(200);
    });
});

describe("roles per project, tokens and sessions", () => {
    it("lets the lower of the project role and the platform role count", async () => {
        // Viewer in Alpha (an editor on the platform): reads, but cannot change.
        const vera = person("vera@example.com", "editor", { mode: "only", projects: [{ projectId: A.project, role: "viewer" }] });
        expect((await call("GET", `/api/projects/${A.project}/tests`, bearer(vera.token))).status).toBe(200);
        const refused = await call("POST", `/api/projects/${A.project}/schedules`, bearer(vera.token), {});
        expect(refused.status).toBe(403);
        expect(refused.body.error).toBe("This needs the Editor role in this project, and you have Viewer there. Ask an owner of this platform if you need it.");
        // Owner chosen in Alpha but only an editor on the platform: editor counts, so an owner-only route is refused.
        const eli = person("eli@example.com", "editor", { mode: "only", projects: [{ projectId: A.project, role: "owner" }] });
        expect((await call("PUT", `/api/projects/${A.project}/retention`, bearer(eli.token), { enabled: false })).status).toBe(403);
        expect((await call("GET", "/api/admin/runners", bearer(eli.token))).status).toBe(403);
    });

    it("limits a personal token the same way as its person, and a token's own lower role still counts", async () => {
        const control = accessControlOf(app);
        const tom = person("tom@example.com", "editor", { mode: "only", projects: [{ projectId: A.project, role: "editor" }] });
        const viewerToken = control.users.createToken(tom.id, { name: "read only", role: "viewer" }).token;
        expect((await call("GET", `/api/projects/${A.project}/tests`, { "x-api-key": viewerToken })).status).toBe(200);
        expect((await call("GET", `/api/projects/${B.project}/tests`, { "x-api-key": viewerToken })).status).toBe(404);
        expect((await call("POST", `/api/projects/${A.project}/schedules`, { "x-api-key": viewerToken }, {})).status).toBe(403);
        // Allowing Bravo later takes effect on the next request, for the token too.
        control.projects.store.set(tom.id, { mode: "only", projects: [{ projectId: A.project, role: "editor" }, { projectId: B.project, role: "viewer" }] });
        expect((await call("GET", `/api/projects/${B.project}/tests`, { "x-api-key": viewerToken })).status).toBe(200);
    });

    it("limits a signed-in browser session the same way", async () => {
        const control = accessControlOf(app);
        const sam = person("sam@example.com", "viewer", { mode: "only", projects: [{ projectId: B.project, role: "viewer" }] });
        control.users.setPassword(sam.id, await hashPassword("a fine long password"));
        const signIn = await app.inject({ method: "POST", url: "/api/auth/sign-in", headers: { host: "localhost:80", origin: "http://localhost:80" }, payload: { email: "sam@example.com", password: "a fine long password" } });
        expect(signIn.statusCode).toBe(200);
        const cookie = (Array.isArray(signIn.headers["set-cookie"]) ? signIn.headers["set-cookie"] : [String(signIn.headers["set-cookie"])]).map((c) => c.split(";")[0]).join("; ");
        const get = (url: string) => app.inject({ method: "GET", url, headers: { host: "localhost:80", cookie } });
        expect((await get(`/api/projects/${B.project}`)).statusCode).toBe(200);
        expect((await get(`/api/projects/${A.project}`)).statusCode).toBe(404);
        expect((await get(`/api/tests/${A.test}`)).statusCode).toBe(404);
        const state = JSON.parse((await get("/api/auth/state")).body);
        expect(state).toMatchObject({ projectAccess: "only", me: { kind: "user", role: "viewer" } });
        expect(JSON.parse((await get("/api/projects")).body).map((p: { id: string }) => p.id)).toEqual([B.project]);
    });

    it("leaves people with access to all projects, the access key and new people exactly as before", async () => {
        const ann = person("ann@example.com", "viewer", { mode: "all" });
        expect((await call("GET", `/api/projects/${B.project}`, bearer(ann.token))).status).toBe(200);
        expect((await call("GET", "/api/projects", bearer(ann.token))).body).toHaveLength(2);
        const fresh = accessControlOf(app).users.create({ email: "new@example.com", name: "New", role: "editor" });
        expect(accessControlOf(app).projects.store.accessOf(fresh.id)).toEqual({ mode: "all" });
        expect((await call("GET", "/api/auth/state", asKey)).body.projectAccess).toBe("all");
    });
});

describe("owners set a person's projects", () => {
    it("shows the access in the people list and changes it with plain refusals", async () => {
        const control = accessControlOf(app);
        const olga = person("olga@example.com", "owner", { mode: "all" });
        const pia = control.users.create({ email: "pia@example.com", name: "Pia", role: "editor" });
        const list = await call("GET", "/api/users", bearer(olga.token));
        expect(list.body.people.find((p: { id: string }) => p.id === pia.id).access).toEqual({ mode: "all" });

        const put = (userId: string, body: unknown, who = olga.token) => call("PUT", `/api/users/${userId}/projects`, bearer(who), body);
        const set = await put(pia.id, { access: "only", projects: [{ projectId: A.project, role: "editor" }] });
        expect(set.status).toBe(200);
        expect(set.body.access).toEqual({ mode: "only", projects: [{ projectId: A.project, name: "Alpha", role: "editor", effectiveRole: "editor" }] });
        expect((await put(pia.id, { access: "only", projects: [{ projectId: A.project, role: "owner" }] }))).toMatchObject({ status: 400, body: { error: "A role in a project cannot be above the person’s own role (Editor). Choose Editor or lower." } });
        expect((await put(pia.id, { access: "only", projects: [{ projectId: randomUUID(), role: "viewer" }] })).status).toBe(400);
        expect((await put(pia.id, { access: "only", projects: [{ projectId: A.project, role: "viewer" }, { projectId: A.project, role: "viewer" }] })).status).toBe(400);
        expect((await put(pia.id, { access: "some" })).status).toBe(400);
        expect((await put(randomUUID(), { access: "all" })).status).toBe(404);
        expect((await put(olga.id, { access: "only", projects: [] }))).toMatchObject({ status: 409, body: { error: "You cannot change your own project access. Ask another owner." } });
        // Lowering Pia's platform role later: the role that counts in Alpha follows it down.
        await call("PATCH", `/api/users/${pia.id}`, bearer(olga.token), { role: "viewer" });
        expect((await call("GET", "/api/users", bearer(olga.token))).body.people.find((p: { id: string }) => p.id === pia.id).access.projects[0]).toMatchObject({ role: "editor", effectiveRole: "viewer" });
        expect((await put(pia.id, { access: "all" })).body.access).toEqual({ mode: "all" });
    });

    it("keeps at least one active owner with access to all projects", async () => {
        const solo = bootstrap(loadConfig({ DATA_DIR: tmp(), SCHEDULER_ENABLED: "false", API_KEY: KEY, SECRET_KEY: "acc-test-secret-key-0123456789" }));
        const soloApp = await buildServer(solo);
        await soloApp.ready();
        try {
            const users = accessControlOf(soloApp).users;
            const only = users.create({ email: "only@example.com", name: "Only", role: "owner" });
            const res = await soloApp.inject({ method: "PUT", url: `/api/users/${only.id}/projects`, headers: asKey, payload: { access: "only", projects: [] } });
            expect(res.statusCode).toBe(409);
            expect(JSON.parse(res.body).error).toBe("This is the only owner with access to all projects. Give another owner access to all projects first.");
            const second = users.create({ email: "second@example.com", name: "Second", role: "owner" });
            expect((await soloApp.inject({ method: "PUT", url: `/api/users/${second.id}/projects`, headers: asKey, payload: { access: "only", projects: [] } })).statusCode).toBe(200);
            // Now "Only" is the last owner who sees every project: demoting them is refused too.
            expect((await soloApp.inject({ method: "PATCH", url: `/api/users/${only.id}`, headers: asKey, payload: { role: "editor" } })).statusCode).toBe(409);
        } finally {
            await soloApp.close();
            solo.db.close();
        }
    });
});

describe("the store and its migration", () => {
    it("gives every person, existing ones included, access to all projects until an owner limits them", () => {
        const db = new Db(path.join(tmp(), "m.db"));
        try {
            db.run("INSERT INTO users (id, email, name, created_at) VALUES ('builtin','admin@localhost','Default user','2020-01-01T00:00:00Z')");
            const users = new UserStore(db);
            const p = users.create({ email: "x@example.com", name: "X", role: "viewer" });
            expect(db.get<{ project_access: string }>("SELECT project_access FROM users WHERE id = ?", p.id)?.project_access).toBe("all");
            const store = new ProjectAccessStore(db);
            expect(store.accessOf(p.id)).toEqual({ mode: "all" });
            expect(store.accessOf("builtin")).toEqual({ mode: "all" });
            db.run("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES ('p1','builtin','P','x','x')");
            store.set(p.id, { mode: "only", projects: [{ projectId: "p1", role: "editor" }] });
            expect(store.accessOf(p.id)).toEqual({ mode: "only", projects: new Map([["p1", "editor"]]) });
            // Removing a person or a project removes their rows.
            users.remove(p.id);
            expect(db.all("SELECT * FROM user_projects")).toEqual([]);
        } finally {
            db.close();
        }
    });
});
