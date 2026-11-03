/**
 * Integrations set up once for an organisation (routes/shared-integrations.ts), against a stand-in Crowd4Test sign-in (port 7640), a
 * stand-in Jira (7641) and a stand-in Slack (7642), and a real platform through inject. Nothing outside this computer is called.
 *
 * Covers: the token is checked before saving, stored encrypted, never answered; a project that uses the connection gets a working row of
 * its own (the project's tracker check passes with the shared token); a change reaches every project; a new address needs the secret again;
 * a project cannot change or remove a shared row from its own settings; a customer stays inside their organisation (another's connection and
 * projects answer 404); a tester sees nothing and sets up nothing; an alert channel keeps the project's own choices; "Test the connection"
 * follows no redirect; removing is refused while projects use it; existing per-project connections are untouched.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { resetSharedChecks } from "../src/platform/routes/shared-integrations.js";
import { buildServer } from "../src/platform/server.js";

const C4T_PORT = 7640;
const JIRA_PORT = 7641;
const SLACK_PORT = 7642;
const JIRA = `http://127.0.0.1:${JIRA_PORT}`;
const SLACK = `http://127.0.0.1:${SLACK_PORT}`;
const KEY = "shared-int-owner-key-71c0";
const SECRET = "shared-integrations-secret-key-0123456789";
const TOKEN = "SHARED-jira-token-a1b2c3";
const TOKEN2 = "SHARED-jira-token-rotated-d4e5f6";
const HOOK = "SHARED-slack-hook-778899";
const PAGE = { "x-requested-with": "ai-studio" };

const me = (id: string, role: string, permissions: readonly string[], organisationId: string | null = null) => ({
    data: { user: { id, email: `${id}@people.example`, role, status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions, organisationId } },
});
const ACCOUNTS: Record<string, unknown> = {
    "t-cora": me("cora", "CUSTOMER", PERMISSIONS, "org-a"),
    // Project settings without "manage keys and connections": may choose what a project uses, may not set one up.
    "t-pete": me("pete", "CUSTOMER", ["ai_studio.access", "ai_studio.project.settings"], "org-a"),
    "t-bob": me("bob", "CUSTOMER", PERMISSIONS, "org-b"),
    "t-tim": me("tim", "TESTER", ["ai_studio.access", "ai_studio.ai_keys.manage", "ai_studio.project.settings"]),
};

let c4t: http.Server;
let jira: http.Server;
let slack: http.Server;
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
const jiraAuth: string[] = [];
const slackHits: Array<{ url: string; body: string }> = [];
const answers: string[] = [];

const call = async (headers: Record<string, string>, method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as "GET", url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
    answers.push(r.body);
    return { status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body } as { status: number; body: any };
};
const as = (token: string, method: string, url: string, payload?: unknown) => call({ cookie: `c4t_access=${token}`, ...(method === "GET" ? {} : PAGE) }, method, url, payload);
const personOf = async (token: string): Promise<string> => (await as(token, "GET", "/api/auth/state")).body.me.id;
const newProject = async (token: string, name: string) => (await as(token, "POST", "/api/projects", { name })).body.id as string;
const jiraBody = (token = TOKEN) => ({ kind: "jira", baseUrl: JIRA, projectKey: "SHOP", email: "qa@example.com", token });

let a1 = "";
let a2 = "";
let b1 = "";

beforeAll(async () => {
    c4t = http.createServer((req, res) => {
        const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        res.writeHead(ACCOUNTS[auth] ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ACCOUNTS[auth] ?? { error: { message: "Invalid access token" } }));
    });
    // Jira: GET /rest/api/3/project/SHOP with Basic auth (email:token); TOKEN and TOKEN2 are good, anything else is refused.
    jira = http.createServer((req, res) => {
        const auth = String(req.headers.authorization ?? "");
        const token = Buffer.from(auth.replace(/^Basic /, ""), "base64").toString().split(":").slice(1).join(":");
        jiraAuth.push(token);
        res.setHeader("content-type", "application/json");
        if (token !== TOKEN && token !== TOKEN2) return res.writeHead(401).end(JSON.stringify({ errorMessages: ["You are not authenticated."] }));
        res.end(JSON.stringify({ key: "SHOP", name: "Shop" }));
    });
    // Slack: /redirect answers 302 to /landed (which must never be reached); everything else accepts the message.
    slack = http.createServer((req, res) => {
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => {
            slackHits.push({ url: req.url!, body });
            if (req.url!.startsWith("/redirect")) return res.writeHead(302, { location: `${SLACK}/landed` }).end();
            res.writeHead(200, { "content-type": "text/plain" }).end("ok");
        });
    });
    await Promise.all([
        new Promise<void>((r) => c4t.listen(C4T_PORT, "127.0.0.1", r)),
        new Promise<void>((r) => jira.listen(JIRA_PORT, "127.0.0.1", r)),
        new Promise<void>((r) => slack.listen(SLACK_PORT, "127.0.0.1", r)),
    ]);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-shared-int-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECRET_KEY: SECRET, C4T_API_ORIGIN: `http://127.0.0.1:${C4T_PORT}`, C4T_SITE_URL: "https://crowd4test.example" } as never));
    app = await buildServer(platform);
    await app.ready();
    a1 = await newProject("t-cora", "Shop web");
    a2 = await newProject("t-cora", "Shop app");
    b1 = await newProject("t-bob", "Other org");
    // Pete works on both of org A's projects with project settings only.
    for (const pid of [a1, a2]) accessControlOf(app).projects.store.addMember(pid, await personOf("t-pete"), { role: "editor", projectAdmin: false, source: "added", addedBy: "test" } as never);
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    for (const s of [c4t, jira, slack]) await new Promise((r) => s?.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("a shared issue tracker", () => {
    let sid = "";

    it("is checked before it is saved: a wrong token saves nothing", async () => {
        const bad = await as("t-cora", "POST", "/api/shared-integrations", jiraBody("SHARED-wrong-token"));
        expect(bad.status).toBe(502);
        expect(bad.body.error).toMatch(/did not accept the token/);
        expect(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM shared_integrations")!.n).toBe(0);
    });

    it("is set up once for the organisation, encrypted, and never answered with its token", async () => {
        const made = await as("t-cora", "POST", "/api/shared-integrations", jiraBody());
        expect(made.status).toBe(201);
        sid = made.body.id;
        expect(made.body).toMatchObject({ kind: "jira", name: "Jira SHOP", organizationId: "org-a", status: "working", canManage: true, projects: [] });
        expect(made.body.config).toEqual({ baseUrl: JIRA, projectKey: "SHOP", email: "qa@example.com", issueType: "Bug" });
        expect(made.body.linkable.map((p: { id: string }) => p.id).sort()).toEqual([a1, a2].sort());
        const row = platform.db.get<{ secret_enc: string }>("SELECT secret_enc FROM shared_integrations WHERE id = ?", sid)!;
        expect(row.secret_enc).not.toContain(TOKEN);
    });

    it("is chosen per project by someone with project settings; the project's own row works with the shared token", async () => {
        expect((await as("t-pete", "POST", "/api/shared-integrations", jiraBody())).status).toBe(403);
        const seen = await as("t-pete", "GET", "/api/shared-integrations");
        expect(seen.body.connections.map((c: { id: string; canManage: boolean }) => [c.id, c.canManage])).toEqual([[sid, false]]);
        for (const pid of [a1, a2]) expect((await as("t-pete", "PUT", `/api/projects/${pid}/shared-integrations/${sid}`)).status).toBe(200);
        // Using it again is harmless.
        expect((await as("t-pete", "PUT", `/api/projects/${a1}/shared-integrations/${sid}`)).status).toBe(200);
        const list = await as("t-cora", "GET", `/api/projects/${a1}/integrations`);
        expect(list.body).toHaveLength(1);
        expect(list.body[0]).toMatchObject({ kind: "jira", name: "Jira SHOP", config: { kind: "jira", projectKey: "SHOP" } });
        const check = await as("t-cora", "POST", `/api/integrations/${list.body[0].id}/test`);
        expect(check.body.ok).toBe(true);
        expect(jiraAuth.at(-1)).toBe(TOKEN);
        const marks = await as("t-cora", "GET", `/api/projects/${a1}/shared-integrations`);
        expect(marks.body).toEqual([{ integrationId: sid, kind: "jira", kindName: "Jira", name: "Jira SHOP", targetId: list.body[0].id, present: true }]);
        const view = (await as("t-cora", "GET", "/api/shared-integrations")).body.connections[0];
        expect(view.projects.map((p: { name: string }) => p.name).sort()).toEqual(["Shop app", "Shop web"]);
        expect(view.linkable).toEqual([]);
    });

    it("cannot be changed or removed from a project's own settings", async () => {
        const row = (await as("t-cora", "GET", `/api/projects/${a1}/integrations`)).body[0];
        const patch = await as("t-cora", "PATCH", `/api/integrations/${row.id}`, { token: "SHARED-other" });
        expect(patch.status).toBe(409);
        expect(patch.body.error).toMatch(/shared from Integrations/);
        expect((await as("t-cora", "DELETE", `/api/integrations/${row.id}`)).status).toBe(409);
    });

    it("a new token reaches every project; a new address without the token again is refused", async () => {
        const moved = await as("t-cora", "PATCH", `/api/shared-integrations/${sid}`, { baseUrl: "http://127.0.0.1:7643" });
        expect(moved.status).toBe(400);
        expect(moved.body.error).toMatch(/Enter the token/);
        const changed = await as("t-cora", "PATCH", `/api/shared-integrations/${sid}`, { token: TOKEN2, name: "Shop Jira" });
        expect(changed.status).toBe(200);
        expect(changed.body).toMatchObject({ name: "Shop Jira", status: "unchecked" });
        for (const pid of [a1, a2]) {
            const row = (await as("t-cora", "GET", `/api/projects/${pid}/integrations`)).body[0];
            expect(row.name).toBe("Shop Jira");
            expect((await as("t-cora", "POST", `/api/integrations/${row.id}/test`)).body.ok).toBe(true);
            expect(jiraAuth.at(-1)).toBe(TOKEN2);
        }
        resetSharedChecks();
        const tested = await as("t-cora", "POST", `/api/shared-integrations/${sid}/test`);
        expect(tested.body).toMatchObject({ ok: true });
        expect(tested.body.connection.status).toBe("working");
    });

    it("stays inside its organisation: another customer sees nothing and reaches nothing", async () => {
        const theirs = await as("t-bob", "GET", "/api/shared-integrations");
        expect(theirs.body.connections).toEqual([]);
        expect(theirs.body.organizations).toEqual([{ id: "org-b", name: null }]);
        expect((await as("t-bob", "PUT", `/api/projects/${b1}/shared-integrations/${sid}`)).status).toBe(404);
        expect((await as("t-bob", "PATCH", `/api/shared-integrations/${sid}`, { name: "Mine" })).status).toBe(404);
        expect((await as("t-bob", "POST", `/api/shared-integrations/${sid}/test`)).status).toBe(404);
        expect((await as("t-bob", "DELETE", `/api/shared-integrations/${sid}`)).status).toBe(404);
        // Cora cannot use it in a project of another organisation, nor set one up for it.
        expect((await as("t-cora", "PUT", `/api/projects/${b1}/shared-integrations/${sid}`)).status).toBe(404);
        expect((await as("t-cora", "POST", "/api/shared-integrations", { ...jiraBody(), organizationId: "org-b" })).status).toBe(403);
    });

    it("a tester sees no connection and sets none up, whatever they were granted", async () => {
        const seen = await as("t-tim", "GET", "/api/shared-integrations");
        expect(seen.body.connections).toEqual([]);
        expect(seen.body.canManage).toBe(false);
        expect((await as("t-tim", "POST", "/api/shared-integrations", jiraBody())).status).toBe(403);
    });

    it("is not removed while projects use it; stopping in one project leaves the other", async () => {
        expect((await as("t-cora", "DELETE", `/api/shared-integrations/${sid}`)).status).toBe(409);
        expect((await as("t-pete", "DELETE", `/api/projects/${a1}/shared-integrations/${sid}`)).status).toBe(204);
        expect((await as("t-cora", "GET", `/api/projects/${a1}/integrations`)).body).toEqual([]);
        expect((await as("t-cora", "GET", `/api/projects/${a2}/integrations`)).body).toHaveLength(1);
        expect((await as("t-pete", "DELETE", `/api/projects/${a2}/shared-integrations/${sid}`)).status).toBe(204);
        expect((await as("t-cora", "DELETE", `/api/shared-integrations/${sid}`)).status).toBe(204);
    });
});

describe("a shared alert channel", () => {
    it("keeps each project's own choices, refuses a new address from the project, and follows no redirect when tested", async () => {
        const made = await as("t-cora", "POST", "/api/shared-integrations", { kind: "slack", url: `${SLACK}/services/${HOOK}` });
        expect(made.status).toBe(201);
        expect(made.body).toMatchObject({ kind: "slack", status: "unchecked", config: { host: `127.0.0.1:${SLACK_PORT}` } });
        const sid = made.body.id;
        resetSharedChecks();
        const tested = await as("t-cora", "POST", `/api/shared-integrations/${sid}/test`);
        expect(tested.body.ok).toBe(true);
        expect(slackHits.at(-1)!.url).toBe(`/services/${HOOK}`);
        expect(JSON.parse(slackHits.at(-1)!.body).text).toMatch(/test message/);

        // A project that already had its own channel keeps it.
        const own = await as("t-cora", "POST", `/api/projects/${a1}/alert-channels`, { kind: "webhook", url: `${SLACK}/own` });
        expect(own.status).toBe(201);
        expect((await as("t-cora", "PUT", `/api/projects/${a1}/shared-integrations/${sid}`)).status).toBe(200);
        const channels = (await as("t-cora", "GET", `/api/projects/${a1}/alert-channels`)).body as Array<{ id: string; kind: string; events: string[] }>;
        expect(channels.map((c) => c.kind).sort()).toEqual(["slack", "webhook"]);
        const shared = channels.find((c) => c.kind === "slack")!;
        expect(shared.events).toEqual(["run_failed", "regression", "recovered", "flaky"]);
        expect((await as("t-cora", "PATCH", `/api/projects/${a1}/alert-channels/${shared.id}`, { events: ["regression"], enabled: false })).status).toBe(200);
        expect((await as("t-cora", "PATCH", `/api/projects/${a1}/alert-channels/${shared.id}`, { url: `${SLACK}/elsewhere` })).status).toBe(409);
        expect((await as("t-cora", "DELETE", `/api/projects/${a1}/alert-channels/${shared.id}`)).status).toBe(409);
        // The project's channel test sends to the shared address.
        expect((await as("t-cora", "POST", `/api/projects/${a1}/alert-channels/${shared.id}/test`)).body.ok).toBe(true);
        expect(slackHits.at(-1)!.url).toBe(`/services/${HOOK}`);

        // A new address reaches the project; the project's choices stay.
        expect((await as("t-cora", "PATCH", `/api/shared-integrations/${sid}`, { url: `${SLACK}/redirect/${HOOK}` })).status).toBe(200);
        const after = (await as("t-cora", "GET", `/api/projects/${a1}/alert-channels`)).body.find((c: { id: string }) => c.id === shared.id);
        expect(after).toMatchObject({ events: ["regression"], enabled: false });
        resetSharedChecks();
        const hits = slackHits.length;
        const redirected = await as("t-cora", "POST", `/api/shared-integrations/${sid}/test`);
        expect(redirected.body.ok).toBe(false);
        expect(redirected.body.message).toMatch(/redirect/i);
        expect(slackHits.slice(hits).map((h) => h.url)).toEqual([`/redirect/${HOOK}`]);
        expect(redirected.body.connection.status).toBe("failed");
    });

    it("a project's own connections show on the page under their kind", async () => {
        const page = await as("t-cora", "GET", "/api/shared-integrations");
        expect(page.body.ownUses.webhook).toEqual([{ id: a1, name: "Shop web" }]);
        expect(page.body.ownUses.slack).toBeUndefined();
    });
});

describe("secrets", () => {
    it("no answer ever carried a token or a webhook address", () => {
        for (const a of answers) for (const s of [TOKEN, TOKEN2, HOOK]) expect(a).not.toContain(s);
    });
});
