/**
 * What the round 37 review found about reach and secrets, against a stand-in Crowd4Test sign-in (port 7720), a stand-in alert receiver
 * (7721), a receiver that must never be reached (7722) and a stand-in Sentry at a new address (7723). A real platform through inject.
 *
 * Covers: a person who may manage connections, but cannot open every project that uses a shared one, can't change where it goes, test
 * it or remove it (canManage says false, the refusal counts the projects), may still link a project of their own, and a Crowd4Test
 * administrator can; a shared tracker's project key needs the token again; a crowd tester reads only the library items their projects
 * use; helper code with a secret is refused on create, new version and publish; a project's own tracker and Sentry need the token again
 * for a new address, and Sentry's check never sends the stored token there.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { NEW_SECRET_NEEDED, resetSharedChecks } from "../src/platform/routes/shared-integrations.js";
import { buildServer } from "../src/platform/server.js";

const C4T = 7720;
const HOOK = 7721;
const EVIL = 7722;
const NEW_SENTRY = 7723;
const PAGE = { "x-requested-with": "ai-studio" };
const me = (id: string, role: string, permissions: readonly string[], organisationId: string | null = null) => ({
    data: { user: { id, email: `${id}@people.example`, role, status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions, organisationId } },
});
const ACCOUNTS: Record<string, unknown> = {
    "t-ada": me("ada", "ADMIN", []),
    "t-cora": me("cora", "CUSTOMER", PERMISSIONS, "org-a"),
    // Manages keys and connections in org-a, member of no project of it.
    "t-carl": me("carl", "CUSTOMER", PERMISSIONS, "org-a"),
    "t-tim": me("tim", "TESTER", ["ai_studio.access", "ai_studio.tests.run"]),
};
const TOKEN = "REVIEW-jira-token-71ab";
const SENTRY_TOKEN = "REVIEW-sentry-token-93cd";

const servers: http.Server[] = [];
const hits = { hook: [] as string[], evil: [] as string[], newSentry: [] as string[] };
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
const answers: string[] = [];

const as = async (token: string, method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as "GET", url, headers: { cookie: `c4t_access=${token}`, ...(method === "GET" ? {} : PAGE) }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    answers.push(r.body);
    return { status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body } as { status: number; body: any };
};
const listen = (port: number, h: http.RequestListener) =>
    new Promise<void>((r) => {
        const s = http.createServer(h);
        servers.push(s);
        s.listen(port, "127.0.0.1", r);
    });
const personOf = async (token: string): Promise<string> => (await as(token, "GET", "/api/auth/state")).body.me.id;
const newProject = async (token: string, name: string) => (await as(token, "POST", "/api/projects", { name })).body.id as string;

beforeAll(async () => {
    await listen(C4T, (req, res) => {
        const a = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        res.writeHead(ACCOUNTS[a] ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify(ACCOUNTS[a] ?? {}));
    });
    await listen(HOOK, (req, res) => {
        hits.hook.push(req.url!);
        req.resume();
        res.writeHead(200).end("ok");
    });
    await listen(EVIL, (req, res) => {
        hits.evil.push(req.url!);
        req.resume();
        res.writeHead(200).end("ok");
    });
    await listen(NEW_SENTRY, (req, res) => {
        hits.newSentry.push(String(req.headers.authorization ?? ""));
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-review-fixes-"));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: "review-fixes-key-1234567890", SECRET_KEY: "review-fixes-secret-key-0123456789", C4T_API_ORIGIN: `http://127.0.0.1:${C4T}`, C4T_SITE_URL: "https://crowd4test.example" } as never));
    app = await buildServer(platform);
    await app.ready();
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    for (const s of servers) await new Promise((r) => s.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("a shared connection used by a project the person cannot open", () => {
    let a2 = "";
    let hook = "";

    it("can't be pointed elsewhere, tested or removed by them, and says so", async () => {
        a2 = await newProject("t-cora", "A2");
        expect((await as("t-carl", "GET", `/api/projects/${a2}`)).status).toBe(404);
        const made = await as("t-cora", "POST", "/api/shared-integrations", { kind: "webhook", url: `http://127.0.0.1:${HOOK}/a2` });
        expect(made.status).toBe(201);
        hook = made.body.id;
        expect((await as("t-cora", "PUT", `/api/projects/${a2}/shared-integrations/${hook}`)).status).toBe(200);

        // Carl still sees it (viewing is unchanged), but may not manage it.
        const seen = (await as("t-carl", "GET", "/api/shared-integrations")).body.connections.find((c: { id: string }) => c.id === hook);
        expect(seen).toMatchObject({ canManage: false, otherProjects: 1, projects: [] });
        const moved = await as("t-carl", "PATCH", `/api/shared-integrations/${hook}`, { url: `http://127.0.0.1:${EVIL}/mine` });
        expect(moved.status).toBe(403);
        expect(moved.body.error).toMatch(/A project you cannot open uses this integration/);
        expect((await as("t-carl", "PATCH", `/api/shared-integrations/${hook}`, { name: "Mine" })).status).toBe(403);
        resetSharedChecks();
        expect((await as("t-carl", "POST", `/api/shared-integrations/${hook}/test`)).status).toBe(403);
        expect((await as("t-carl", "DELETE", `/api/shared-integrations/${hook}`)).status).toBe(403);

        // A2's own channel still posts to the address Cora entered.
        const ch = (await as("t-cora", "GET", `/api/projects/${a2}/alert-channels`)).body[0];
        expect((await as("t-cora", "POST", `/api/projects/${a2}/alert-channels/${ch.id}/test`)).body.ok).toBe(true);
        expect(hits.hook.at(-1)).toBe("/a2");
        expect(hits.evil).toEqual([]);
    });

    it("counts every project out of reach, still lets them link a project of their own", async () => {
        const a3 = await newProject("t-cora", "A3");
        expect((await as("t-cora", "PUT", `/api/projects/${a3}/shared-integrations/${hook}`)).status).toBe(200);
        const c1 = await newProject("t-carl", "Carl's");
        expect((await as("t-carl", "PUT", `/api/projects/${c1}/shared-integrations/${hook}`)).status).toBe(200);
        const seen = (await as("t-carl", "GET", "/api/shared-integrations")).body.connections.find((c: { id: string }) => c.id === hook);
        expect(seen).toMatchObject({ canManage: false, otherProjects: 2, projects: [{ id: c1, name: "Carl's" }] });
        expect((await as("t-carl", "PATCH", `/api/shared-integrations/${hook}`, { url: `http://127.0.0.1:${EVIL}/mine` })).body.error).toMatch(/^2 projects you cannot open use this integration/);
        // Stopping in their own project stays theirs to do.
        expect((await as("t-carl", "DELETE", `/api/projects/${c1}/shared-integrations/${hook}`)).status).toBe(204);
    });

    it("is managed by someone who reaches every project that uses it: its creator, and a Crowd4Test administrator", async () => {
        const cora = (await as("t-cora", "GET", "/api/shared-integrations")).body.connections.find((c: { id: string }) => c.id === hook);
        expect(cora).toMatchObject({ canManage: true, otherProjects: 0 });
        expect((await as("t-cora", "PATCH", `/api/shared-integrations/${hook}`, { name: "Alerts" })).status).toBe(200);
        expect((await as("t-ada", "PATCH", `/api/shared-integrations/${hook}`, { url: `http://127.0.0.1:${HOOK}/moved` })).status).toBe(200);
        expect(hits.evil).toEqual([]);
    });

    it("a tracker's project key, not only its address, needs the token again", async () => {
        const made = await as("t-cora", "POST", "/api/shared-integrations", { kind: "jira", baseUrl: `http://127.0.0.1:${HOOK}`, projectKey: "SHOP", email: "qa@example.com", token: TOKEN, verify: false });
        expect(made.status).toBe(201);
        const key = await as("t-cora", "PATCH", `/api/shared-integrations/${made.body.id}`, { projectKey: "THEIRS" });
        expect(key).toMatchObject({ status: 400, body: { error: NEW_SECRET_NEEDED } });
        expect((await as("t-cora", "PATCH", `/api/shared-integrations/${made.body.id}`, { issueType: "Task" })).status).toBe(200);
        const again = await as("t-cora", "PATCH", `/api/shared-integrations/${made.body.id}`, { projectKey: "THEIRS", token: TOKEN });
        expect(again).toMatchObject({ status: 200, body: { config: { projectKey: "THEIRS", issueType: "Task" } } });
    });
});

describe("a crowd tester and the organisation's library", () => {
    it("reads only the items their own projects use", async () => {
        const a4 = await newProject("t-cora", "A4");
        accessControlOf(app).projects.store.addMember(a4, await personOf("t-tim"), { role: "editor", projectAdmin: false, source: "added", addedBy: "test" } as never);
        const folder = (await as("t-cora", "POST", "/api/libraries/folders", { organizationId: "org-a", name: "Shared" })).body.id;
        await as("t-cora", "POST", "/api/libraries/folders", { organizationId: "org-a", name: "Private" });
        const helper = (word: string) => `import type { Page } from "@playwright/test";\nexport async function open(page: Page) {\n  await page.goto("/${word}");\n}\n`;
        const used = await as("t-cora", "POST", "/api/libraries/items", { organizationId: "org-a", folderId: folder, kind: "helper", name: "open-used", content: { content: helper("a") } });
        const unused = await as("t-cora", "POST", "/api/libraries/items", { organizationId: "org-a", kind: "helper", name: "open-other", content: { content: helper("b") } });
        expect([used.status, unused.status]).toEqual([201, 201]);
        expect((await as("t-cora", "POST", `/api/projects/${a4}/library/use`, { itemId: used.body.item.id })).status).toBe(201);

        expect((await as("t-tim", "GET", `/api/libraries/items/${unused.body.item.id}`)).status).toBe(404);
        expect((await as("t-tim", "GET", `/api/libraries/items/${unused.body.item.id}/versions/1`)).status).toBe(404);
        expect((await as("t-tim", "GET", `/api/libraries/items/${used.body.item.id}`)).status).toBe(200);
        const lib = (await as("t-tim", "GET", "/api/libraries")).body;
        expect(lib.items.map((i: { name: string }) => i.name)).toEqual(["open-used"]);
        expect(lib.folders.map((f: { name: string }) => f.name)).toEqual(["Shared"]);
        const inProject = (await as("t-tim", "GET", `/api/projects/${a4}/library`)).body;
        expect(inProject.items.map((i: { name: string }) => i.name)).toEqual(["open-used"]);
        // A customer of the organisation still reads all of it.
        expect((await as("t-cora", "GET", "/api/libraries")).body.items.map((i: { name: string }) => i.name).sort()).toEqual(["open-other", "open-used"]);
    });
});

describe("helper code in a library", () => {
    const LEAK = 'export const ADMIN = { user: "root", password: "S3cr3t-Pa55w0rd!" };\n';

    it("is refused with a secret on create, on a new version and on publish from a project", async () => {
        const made = await as("t-cora", "POST", "/api/libraries/items", { organizationId: "org-a", kind: "helper", name: "login-admin", content: { content: LEAK } });
        expect(made.status).toBe(400);
        expect(made.body.error).toMatch(/looks like a real secret.*“password”/);
        const key = await as("t-cora", "POST", "/api/libraries/items", { organizationId: "org-a", kind: "helper", name: "gh-key", content: { content: `export const KEY = "ghp_${"a".repeat(30)}";\n` } });
        expect(key.status).toBe(400);

        const clean = await as("t-cora", "POST", "/api/libraries/items", { organizationId: "org-a", kind: "helper", name: "login-env", content: { content: 'export const ADMIN = { user: "root", password: process.env.TEST_PASSWORD ?? "" };\n' } });
        expect(clean.status, JSON.stringify(clean.body)).toBe(201);
        expect((await as("t-cora", "PUT", `/api/libraries/items/${clean.body.item.id}/content`, { content: { content: LEAK } })).status).toBe(400);

        const pid = await newProject("t-cora", "A5");
        expect((await as("t-cora", "PUT", `/api/projects/${pid}/helpers/login-local`, { content: LEAK })).status).toBeLessThan(300);
        const published = await as("t-cora", "POST", `/api/projects/${pid}/library/publish`, { kind: "helper", name: "login-local" });
        expect(published.status).toBe(400);
        expect(published.body.error).toMatch(/looks like a real secret/);
        expect((await as("t-cora", "GET", "/api/libraries")).body.items.map((i: { name: string }) => i.name)).not.toContain("login-local");
    });
});

describe("a project's own connections at a new address", () => {
    it("a tracker keeps its token only where it was entered for", async () => {
        const pid = await newProject("t-cora", "A6");
        const made = await as("t-cora", "POST", `/api/projects/${pid}/integrations`, { kind: "jira", baseUrl: `http://127.0.0.1:${HOOK}`, projectKey: "SHOP", email: "qa@example.com", token: TOKEN, verify: false });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        expect(await as("t-cora", "PATCH", `/api/integrations/${made.body.id}`, { baseUrl: `http://127.0.0.1:${EVIL}` })).toMatchObject({ status: 400, body: { error: NEW_SECRET_NEEDED } });
        // The same address with a trailing slash, or other settings, need nothing.
        expect((await as("t-cora", "PATCH", `/api/integrations/${made.body.id}`, { baseUrl: `http://127.0.0.1:${HOOK}/`, issueType: "Task" })).status).toBe(200);
        expect((await as("t-cora", "PATCH", `/api/integrations/${made.body.id}`, { baseUrl: `http://127.0.0.1:${EVIL}`, token: TOKEN })).status).toBe(200);
    });

    it("Sentry never sends the stored token to a new address, even to check it", async () => {
        const pid = await newProject("t-cora", "A7");
        const made = await as("t-cora", "PUT", `/api/projects/${pid}/sentry`, { baseUrl: `http://127.0.0.1:${HOOK}`, organization: "acme", project: "shop", token: SENTRY_TOKEN, verify: false });
        expect(made.status).toBe(201);
        const moved = await as("t-cora", "PUT", `/api/projects/${pid}/sentry`, { baseUrl: `http://127.0.0.1:${NEW_SENTRY}`, organization: "acme", project: "shop", verify: true });
        expect(moved).toMatchObject({ status: 400, body: { error: NEW_SECRET_NEEDED } });
        expect(hits.newSentry).toEqual([]);
        expect((await as("t-cora", "GET", `/api/projects/${pid}/sentry`)).body.connection.baseUrl).toBe(`http://127.0.0.1:${HOOK}`);
        // Renaming the Sentry project at the same address keeps the token.
        expect((await as("t-cora", "PUT", `/api/projects/${pid}/sentry`, { baseUrl: `http://127.0.0.1:${HOOK}`, organization: "acme", project: "shop-2", verify: false })).status).toBe(200);
    });
});

describe("secrets", () => {
    it("no answer carried a token", () => {
        for (const a of answers) for (const s of [TOKEN, SENTRY_TOKEN]) expect(a).not.toContain(s);
    });
});
