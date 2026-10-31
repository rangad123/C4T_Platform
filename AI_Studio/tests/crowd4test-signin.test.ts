/**
 * Signing in with the crowd4test.com session (auth/crowd4test.ts), against a stand-in Crowd4Test API on a local port: the API
 * is asked who an access cookie belongs to; a Crowd4Test admin arrives as an owner of everything, a customer or tester as an
 * editor of no projects; an expired cookie asks the page to renew, a missing one to sign in on crowd4test.com; a suspended
 * account, an unfinished one and an unreachable API are refused with reasons; changes need the page's own header; a Crowd4Test
 * role that goes down lowers the role here; answers are cached briefly; and an access key still works beside all this.
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CUSTOM_SCRIPTS_NOT_WITH_CROWD4TEST, loadConfig } from "../src/config.js";
import { customRunDecision } from "../src/platform/custom-policy.js";
import { accessControlOf, C4T_RENEW, C4T_SIGN_IN, C4T_UNREACHABLE, CSRF_REFUSED } from "../src/platform/auth/access.js";
import { SESSION_COOKIE } from "../src/platform/auth/cookies.js";
import { hashPassword } from "../src/platform/auth/password.js";
import { C4T_OWN_SIGN_IN } from "../src/platform/routes/auth.js";
import { EVERY_PROJECT_NEEDED } from "../src/platform/routes/users.js";
import { crowd4testFromConfig } from "../src/platform/auth/crowd4test.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

type App = Awaited<ReturnType<typeof buildServer>>;
const KEY = "c4t-owner-key-71b2e0aa";
const SITE = "https://crowd4test.example";
const dirs: string[] = [];

/** Access tokens the stand-in API knows, and what it answers for each. */
const accounts = new Map<string, { status: number; body: unknown }>();
const asked: Array<{ token: string; ip?: string }> = [];
let api: http.Server;
let platform: Platform;
let app: App;

/** A Crowd4Test account as `/v1/auth/me` answers; it may open AI Studio (`ai_studio.access`) unless `permissions` says otherwise. */
const user = (id: string, role: string, extra: Record<string, unknown> = {}) => ({
    status: 200,
    body: { data: { user: { id, email: `${id}@people.example`, role, status: "ACTIVE", firstName: id[0]!.toUpperCase() + id.slice(1), lastName: "Tester", emailVerified: true, permissions: ["ai_studio.access"], organisationId: null, ...extra } } },
});

const as = (token: string | null, init: { method?: string; url: string; headers?: Record<string, string>; payload?: unknown; refresh?: boolean }) =>
    app.inject({
        method: (init.method ?? "GET") as "GET",
        url: init.url,
        payload: init.payload as never,
        headers: { ...(init.headers ?? {}), cookie: [token ? `c4t_access=${token}` : "", init.refresh ? "c4t_refresh=r-1" : ""].filter(Boolean).join("; ") },
    });

beforeAll(async () => {
    api = http.createServer((req, res) => {
        const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        asked.push({ token, ip: req.headers["x-c4t-client-ip"] as string | undefined });
        const answer = req.url === "/v1/auth/me" ? accounts.get(token) : undefined;
        if (answer?.status === 599) return req.socket.destroy();
        res.writeHead(answer?.status ?? 401, { "content-type": "application/json" });
        res.end(JSON.stringify(answer?.body ?? { error: { message: "Invalid access token" } }));
    });
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
    const port = (api.address() as AddressInfo).port;
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-c4t-"));
    dirs.push(dir);
    platform = bootstrap(
        loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", API_KEY: KEY, SECRET_KEY: "c4t-test-secret-key-0123456789", C4T_API_ORIGIN: `http://127.0.0.1:${port}`, C4T_SITE_URL: SITE }),
    );
    app = await buildServer(platform);
    await app.ready();
});

afterAll(async () => {
    await app?.close();
    await new Promise((r) => api?.close(r));
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("signing in with Crowd4Test", () => {
    it("sends a visitor with no Crowd4Test cookie to sign in on crowd4test.com", async () => {
        const state = (await as(null, { url: "/api/auth/state" })).json();
        expect(state.me).toBeNull();
        expect(state.mode).toBe("protected");
        expect(state.crowd4test).toEqual({ status: "none", signInUrl: `${SITE}/app/ai-studio`, refreshUrl: `${SITE}/app/ai-studio/refresh`, portalUrl: `${SITE}/app` });
        const res = await as(null, { url: "/api/projects" });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toMatchObject({ error: C4T_SIGN_IN, details: { crowd4test: "sign-in", signInUrl: `${SITE}/app/ai-studio` } });
    });

    it("lets a Crowd4Test admin in as an owner of every project, named as on Crowd4Test", async () => {
        accounts.set("t-admin", user("ada", "ADMIN"));
        const state = (await as("t-admin", { url: "/api/auth/state" })).json();
        expect(state.me).toMatchObject({ kind: "user", name: "Ada Tester", role: "owner", email: "ada@people.example", via: "crowd4test" });
        expect(state.projectAccess).toBe("all");
        expect(state.crowd4test.status).toBe("user");
        const made = await as("t-admin", { method: "POST", url: "/api/projects", headers: { "x-requested-with": "ai-studio" }, payload: { name: "From Crowd4Test" } });
        expect(made.statusCode).toBeLessThan(300);
        expect((await as("t-admin", { url: "/api/projects" })).json().map((p: { name: string }) => p.name)).toContain("From Crowd4Test");
    });

    it("lets a customer and a tester in as editors of no projects until an owner adds them", async () => {
        accounts.set("t-customer", user("cora", "CUSTOMER"));
        accounts.set("t-tester", user("tim", "TESTER"));
        for (const t of ["t-customer", "t-tester"]) {
            const state = (await as(t, { url: "/api/auth/state" })).json();
            expect(state.me.role).toBe("editor");
            expect(state.projectAccess).toBe("only");
            expect((await as(t, { url: "/api/projects" })).json()).toEqual([]);
            expect((await as(t, { method: "POST", url: "/api/projects", headers: { "x-requested-with": "ai-studio" }, payload: { name: "Mine" } })).statusCode).toBe(403);
        }
        const people = accessControlOf(app).users.list();
        expect(people.filter((p) => p.sso).map((p) => p.email).sort()).toEqual(["ada@people.example", "cora@people.example", "tim@people.example"]);
    });

    it("refuses a change without the page's own header, or from another address", async () => {
        const bare = await as("t-admin", { method: "POST", url: "/api/projects", payload: { name: "Forged" } });
        expect(bare.statusCode).toBe(403);
        expect(bare.json().error).toBe(CSRF_REFUSED);
        const elsewhere = await as("t-admin", { method: "POST", url: "/api/projects", headers: { "x-requested-with": "ai-studio", origin: "https://hrms.crowd4test.example" }, payload: { name: "Forged" } });
        expect(elsewhere.statusCode).toBe(403);
    });

    it("asks the page to renew when only the refresh cookie is left, without spending it", async () => {
        const before = asked.length;
        const state = (await as(null, { url: "/api/auth/state", refresh: true })).json();
        expect(state.me).toBeNull();
        expect(state.crowd4test.status).toBe("expired");
        const res = await as(null, { url: "/api/projects", refresh: true });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toMatchObject({ error: C4T_RENEW, details: { crowd4test: "renew", refreshUrl: `${SITE}/app/ai-studio/refresh` } });
        expect(asked.length).toBe(before); // nothing to ask the API, and never a refresh from here
        // A dead access token with the refresh cookie still there: renew too.
        expect((await as("t-unknown", { url: "/api/projects", refresh: true })).json().details.crowd4test).toBe("renew");
    });

    it("asks the page to renew on crowd4test.com's c4t_shared marker alone, once the refresh cookie stays there", async () => {
        const before = asked.length;
        const shared = (token: string | null, url: string) => app.inject({ method: "GET", url, headers: { cookie: [token ? `c4t_access=${token}` : "", "c4t_shared=1"].filter(Boolean).join("; ") } });
        expect((await shared(null, "/api/auth/state")).json().crowd4test.status).toBe("expired");
        expect((await shared(null, "/api/projects")).json()).toMatchObject({ error: C4T_RENEW, details: { crowd4test: "renew" } });
        expect(asked.length).toBe(before);
        expect((await shared("t-unknown", "/api/projects")).json().details.crowd4test).toBe("renew");
    });

    it("refuses suspended and unfinished accounts with the reason, and says when Crowd4Test cannot be reached", async () => {
        accounts.set("t-suspended", { status: 403, body: { error: { message: "This account is suspended" } } });
        const s = await as("t-suspended", { url: "/api/projects" });
        expect(s.statusCode).toBe(403);
        expect(s.json()).toMatchObject({ error: "This account is suspended", details: { crowd4test: "refused" } });
        expect((await as("t-suspended", { url: "/api/auth/state" })).json().crowd4test).toMatchObject({ status: "refused", message: "This account is suspended" });

        accounts.set("t-onboarding", user("una", "USER"));
        const u = await as("t-onboarding", { url: "/api/projects" });
        expect(u.statusCode).toBe(403);
        expect(u.json().error).toContain("Finish setting up your Crowd4Test account");

        accounts.set("t-down", { status: 599, body: null });
        const d = await as("t-down", { url: "/api/projects" });
        expect(d.statusCode).toBe(503);
        expect(d.json().error).toBe(C4T_UNREACHABLE);
    });

    it("lowers the role here when the Crowd4Test role goes down", async () => {
        accounts.set("t-demoted", user("ada", "CUSTOMER"));
        const state = (await as("t-demoted", { url: "/api/auth/state" })).json();
        expect(state.me.role).toBe("editor");
        const ada = accessControlOf(app).users.list().find((p) => p.email === "ada@people.example")!;
        expect(ada.role).toBe("editor");
        // Back to admin on Crowd4Test: the ceiling rises, but an owner here decides whether the role does.
        accounts.set("t-admin-again", user("ada", "ADMIN"));
        expect((await as("t-admin-again", { url: "/api/auth/state" })).json().me.role).toBe("editor");
    });

    it("asks Crowd4Test once per cookie for a while, and passes the visitor's address on", async () => {
        accounts.set("t-cached", user("cleo", "TESTER"));
        const before = asked.length;
        for (let i = 0; i < 5; i++) await as("t-cached", { url: "/api/projects", headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" } });
        const calls = asked.slice(before);
        expect(calls.map((c) => c.token)).toEqual(["t-cached"]);
        expect(calls[0]!.ip).toBe("203.0.113.9");
    });

    it("refuses personal API tokens for Crowd4Test sign-ins, and still takes the access key", async () => {
        const tok = await as("t-customer", { method: "POST", url: "/api/me/tokens", headers: { "x-requested-with": "ai-studio" }, payload: { name: "ci" } });
        expect(tok.statusCode).toBe(403);
        const key = await app.inject({ method: "GET", url: "/api/auth/state", headers: { "x-api-key": KEY } });
        expect(key.json().me).toMatchObject({ kind: "key", role: "owner" });
    });
});

describe("a Crowd4Test account has no way in but Crowd4Test", () => {
    const page = { "x-requested-with": "ai-studio" };
    const PASSWORD = "Correct-horse-battery-9!";
    const cookiesOf = (res: { headers: Record<string, unknown> }) => ([] as string[]).concat((res.headers["set-cookie"] as string[] | string | undefined) ?? []).map((c) => c.split(";")[0]!);

    it("refuses a password, a password sign-in and a token for a tester, so a suspension on Crowd4Test holds here (the audit's scenario)", async () => {
        accounts.set("t-pw", user("pia", "TESTER"));
        expect((await as("t-pw", { url: "/api/auth/state" })).json().me.via).toBe("crowd4test");
        // 1. the tester sets a password here
        const pw = await as("t-pw", { method: "PUT", url: "/api/me/password", headers: page, payload: { next: PASSWORD } });
        expect(pw.statusCode).toBe(403);
        expect(pw.json().error).toBe(C4T_OWN_SIGN_IN);
        // 2. a password that got there anyway (set before the account was linked) signs nobody in
        const users = accessControlOf(app).users;
        const pia = users.byEmail("pia@people.example")!;
        users.setPassword(pia.id, await hashPassword(PASSWORD));
        const si = await app.inject({ method: "POST", url: "/api/auth/sign-in", payload: { email: "pia@people.example", password: PASSWORD } });
        expect(si.statusCode).toBe(403);
        expect(si.json().error).toBe(C4T_OWN_SIGN_IN);
        expect(cookiesOf(si).some((c) => c.startsWith(`${SESSION_COOKIE}=`) && c.length > SESSION_COOKIE.length + 1)).toBe(false);
        // 3. a session and a token made before the link (or slipped in) are not an identity once suspended on Crowd4Test
        const { token: session } = users.createSession(pia.id, "password", "test");
        const { token } = users.createToken(pia.id, { name: "ci", role: "editor" });
        accounts.set("t-pw", { status: 403, body: { error: { message: "This account is suspended" } } });
        expect((await app.inject({ method: "GET", url: "/api/auth/state", headers: { authorization: `Bearer ${token}` } })).json().me).toBeNull();
        expect((await app.inject({ method: "GET", url: "/api/projects", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
        expect((await app.inject({ method: "GET", url: "/api/auth/state", headers: { cookie: `${SESSION_COOKIE}=${session}` } })).json().me).toBeNull();
    });

    it("refuses an invite or reset link for someone linked to Crowd4Test", async () => {
        const users = accessControlOf(app).users;
        const pia = users.byEmail("pia@people.example")!;
        const { token } = users.createInvite(pia.id, "reset");
        expect((await app.inject({ method: "POST", url: "/api/auth/invite/check", payload: { token } })).statusCode).toBe(404);
        const accept = await app.inject({ method: "POST", url: "/api/auth/invite/accept", payload: { token, password: PASSWORD } });
        expect(accept.statusCode).toBe(404);
        // and nobody, not even the access key, makes one
        expect((await app.inject({ method: "POST", url: `/api/users/${pia.id}/reset-link`, headers: { "x-api-key": KEY } })).statusCode).toBe(409);
    });

    it("does not let a made-up aitp_session cookie skip the Crowd4Test check", async () => {
        accounts.set("t-junk", user("jude", "TESTER"));
        const res = await app.inject({ method: "GET", url: "/api/auth/state", headers: { cookie: `c4t_access=t-junk; ${SESSION_COOKIE}=made-up-value` } });
        expect(res.json().me).toMatchObject({ email: "jude@people.example", via: "crowd4test" });
    });
});

describe("people and access are handed out only by someone who reaches every project", () => {
    const page = { "x-requested-with": "ai-studio" };
    it("refuses a sub-admin with platform settings new people, roles, project access and reset links; an ADMIN still can", async () => {
        accounts.set("t-sub", user("sam", "SUB_ADMIN", { permissions: ["ai_studio.access", "ai_studio.platform.settings"] }));
        accounts.set("t-boss", user("bo", "ADMIN"));
        await as("t-sub", { url: "/api/auth/state" });
        await as("t-boss", { url: "/api/auth/state" });
        const users = accessControlOf(app).users;
        const target = users.byEmail("tim@people.example")!;

        const made = await as("t-sub", { method: "POST", url: "/api/users", headers: page, payload: { email: "shadow@people.example", role: "owner" } });
        expect(made.statusCode).toBe(403);
        expect(made.json().error).toBe(EVERY_PROJECT_NEEDED);
        expect(users.byEmail("shadow@people.example")).toBeUndefined();
        expect((await as("t-sub", { method: "PATCH", url: `/api/users/${target.id}`, headers: page, payload: { role: "owner" } })).statusCode).toBe(403);
        expect((await as("t-sub", { method: "PUT", url: `/api/users/${target.id}/projects`, headers: page, payload: { access: "all" } })).statusCode).toBe(403);
        const local = users.create({ email: "local@people.example", name: "Local", role: "viewer" });
        expect((await as("t-sub", { method: "POST", url: `/api/users/${local.id}/reset-link`, headers: page })).statusCode).toBe(403);

        // The Crowd4Test ADMIN reaches every project, so these work for them as before.
        expect((await as("t-boss", { method: "POST", url: "/api/users", headers: page, payload: { email: "new@people.example", role: "viewer" } })).statusCode).toBe(201);
        expect((await as("t-boss", { method: "POST", url: `/api/users/${local.id}/reset-link`, headers: page })).statusCode).toBe(200);
    });
});

describe("Crowd4Test settings", () => {
    it("is off with neither address, and needs both", () => {
        expect(crowd4testFromConfig({})).toBeUndefined();
        expect(crowd4testFromConfig({ C4T_API_ORIGIN: "", C4T_SITE_URL: " " })).toBeUndefined();
        expect(() => crowd4testFromConfig({ C4T_API_ORIGIN: "http://127.0.0.1:4000" })).toThrow(/both C4T_API_ORIGIN and C4T_SITE_URL/);
        expect(() => crowd4testFromConfig({ C4T_API_ORIGIN: "127.0.0.1:4000", C4T_SITE_URL: SITE })).toThrow(/C4T_API_ORIGIN must be an address/);
        expect(crowd4testFromConfig({ C4T_API_ORIGIN: "http://127.0.0.1:4000/", C4T_SITE_URL: `${SITE}/` })!.signInUrl).toBe(`${SITE}/app/ai-studio`);
    });

    it("refuses ALLOW_CUSTOM_SCRIPTS with Crowd4Test sign-in on, and says why", () => {
        const base = { DATA_DIR: "./data", API_KEY: KEY, ALLOW_CUSTOM_SCRIPTS: "true" };
        expect(loadConfig(base).ALLOW_CUSTOM_SCRIPTS).toBe(true);
        const c = loadConfig({ ...base, C4T_API_ORIGIN: "http://127.0.0.1:4000", C4T_SITE_URL: SITE });
        expect(c.ALLOW_CUSTOM_SCRIPTS).toBe(false);
        expect(c.customScriptsRequested).toBe(true);
        expect(c.customScriptsReason).toBe(CUSTOM_SCRIPTS_NOT_WITH_CROWD4TEST);
        // the platform's run policy then refuses code tests on this server, with that reason
        const d = customRunDecision({ hostAllowed: c.ALLOW_CUSTOM_SCRIPTS, hostNote: c.customScriptsReason, runsOnAgent: false, agents: [] });
        expect(d.allowed).toBe(false);
        if (!d.allowed) expect(d.message).toContain("Crowd4Test sign-in is on");
    });
});
