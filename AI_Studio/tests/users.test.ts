/**
 * People and access through the real API (Fastify inject, real database, real scrypt): the open platform and its first owner,
 * the access key as an owner-level key, sign-in with cookies and CSRF, roles enforced per route, invite and reset links,
 * personal API tokens, lockout, sessions ending, the Activity list and the actor in audit rows. Single sign-on runs against a
 * local OpenID Connect provider (a real HTTP server on port 6810 signing real RS256 ID tokens), including the refusals.
 */
import { createHash, generateKeyPairSync, sign as signRaw, type KeyObject } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { clearSsoCaches } from "../src/platform/auth/oidc.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

type App = Awaited<ReturnType<typeof buildServer>>;
const KEY = "usr-owner-key-7f3a9c21";
const IDP_PORT = 6810;
const IDP = `http://127.0.0.1:${IDP_PORT}`;
const SSO_SECRET = "usr-sso-client-secret-SENTINEL-41c9";
const dirs: string[] = [];

async function platformWith(extra: Record<string, string>): Promise<{ platform: Platform; app: App }> {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-usr-"));
    dirs.push(dir);
    const platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", SECRET_KEY: "usr-test-secret-key-0123456789", ...extra }));
    const app = await buildServer(platform);
    await app.ready();
    return { platform, app };
}

/** A tiny browser: keeps the cookies the platform sets and echoes the CSRF cookie on changes, like the web page does. */
let nextIp = 1;
class Browser {
    jar = new Map<string, string>();
    /** Each browser comes from its own address, so the per-address sign-in limit only counts what one browser does. */
    private readonly ip = `10.9.${Math.floor(nextIp / 250)}.${(nextIp++ % 250) + 1}`;
    constructor(
        private readonly app: App,
        private readonly origin = "http://localhost:80",
    ) {}
    async call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
        const cookie = [...this.jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
        const csrf = this.jar.get("aitp_csrf");
        const res = await this.app.inject({
            method: method as "GET",
            url,
            remoteAddress: this.ip,
            headers: { host: "localhost:80", ...(cookie ? { cookie } : {}), ...(csrf && method !== "GET" ? { "x-csrf-token": csrf } : {}), ...(method !== "GET" ? { origin: this.origin } : {}), ...headers },
            ...(body !== undefined ? { payload: body as object } : {}),
        });
        const set = res.headers["set-cookie"];
        for (const c of Array.isArray(set) ? set : set ? [set] : []) {
            const [pair] = c.split(";");
            const i = pair!.indexOf("=");
            const v = decodeURIComponent(pair!.slice(i + 1));
            if (/Max-Age=0/.test(c) || !v) this.jar.delete(pair!.slice(0, i));
            else this.jar.set(pair!.slice(0, i), v);
        }
        return { status: res.statusCode, body: res.body ? (res.body.startsWith("{") || res.body.startsWith("[") ? JSON.parse(res.body) : res.body) : null, headers: res.headers };
    }
}

const withKey = (app: App, method: string, url: string, body?: unknown, key = KEY) =>
    app.inject({ method: method as "GET", url, headers: { "x-api-key": key }, ...(body !== undefined ? { payload: body as object } : {}) }).then((r) => ({ status: r.statusCode, body: r.body ? JSON.parse(r.body) : null }));

afterAll(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("an open platform (no access key) and its first owner", () => {
    let app: App;
    let platform: Platform;
    beforeAll(async () => ({ app, platform } = await platformWith({})), 60_000);
    afterAll(async () => {
        await app.close();
        platform.db.close();
    });

    it("stays open until the first owner exists, then everyone signs in", async () => {
        const b = new Browser(app);
        expect((await b.call("GET", "/api/auth/state")).body).toMatchObject({ mode: "open", hasPeople: false, me: { kind: "open", role: "owner" } });
        expect((await b.call("POST", "/api/projects", { name: "Before accounts" })).status).toBe(201);
        const weak = await b.call("POST", "/api/auth/setup", { email: "owner@example.com", name: "Olga", password: "short" });
        expect(weak.status).toBe(400);
        const made = await b.call("POST", "/api/auth/setup", { email: "owner@example.com", name: "Olga", password: "a fine long password" });
        expect(made.status).toBe(201);
        expect(made.body.me).toMatchObject({ kind: "user", role: "owner", name: "Olga" });
        expect((await b.call("GET", "/api/projects")).status).toBe(200);
        // Someone without a session is now refused, with a plain sentence.
        const stranger = new Browser(app);
        expect((await stranger.call("GET", "/api/auth/state")).body).toMatchObject({ mode: "protected", hasPeople: true, me: null });
        const refused = await stranger.call("GET", "/api/projects");
        expect(refused.status).toBe(401);
        expect(refused.body.error).toMatch(/Sign in first/);
        expect((await stranger.call("POST", "/api/auth/setup", { email: "x@example.com", name: "X", password: "a fine long password" })).status).toBe(409);
    });
});

describe("a platform with an access key and people", () => {
    let app: App;
    let platform: Platform;
    const owner = () => new Browser(app);
    let olga: Browser;
    let editorId = "";
    let viewerId = "";
    let projectId = "";

    beforeAll(async () => {
        ({ app, platform } = await platformWith({ API_KEY: KEY }));
        olga = owner();
    }, 60_000);
    afterAll(async () => {
        await app.close();
        platform.db.close();
    });

    it("keeps the access key working as an owner-level key, and refuses a wrong one as before", async () => {
        expect((await withKey(app, "GET", "/api/projects")).status).toBe(200);
        const wrong = await withKey(app, "GET", "/api/projects", undefined, "nope");
        expect(wrong).toEqual({ status: 401, body: { error: "Missing or invalid x-api-key" } });
        expect((await app.inject({ method: "GET", url: "/api/projects" })).statusCode).toBe(401);
        expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
        // A public route ignores a wrong key instead of refusing (the sign-in page must still load).
        expect((await withKey(app, "GET", "/api/auth/state", undefined, "nope")).body).toMatchObject({ mode: "protected", hasPeople: false, me: null });
    });

    it("lets only the access-key holder create the first owner", async () => {
        const anon = new Browser(app);
        const refused = await anon.call("POST", "/api/auth/setup", { email: "olga@example.com", name: "Olga", password: "olga's long password" });
        expect(refused.status).toBe(401);
        const made = await olga.call("POST", "/api/auth/setup", { email: "olga@example.com", name: "Olga", password: "olga's long password" }, { "x-api-key": KEY });
        expect(made.status).toBe(201);
        const cookies = String(made.headers["set-cookie"]);
        expect(cookies).toMatch(/aitp_session=[^;]+; Path=\/; Max-Age=604800; SameSite=Lax; HttpOnly/);
        expect(cookies).toMatch(/aitp_csrf=[^;]+; Path=\/; Max-Age=604800; SameSite=Lax(?!; HttpOnly)/);
        expect(cookies).not.toMatch(/Secure/);
    });

    it("signs in with email and password, rotates the session, and checks CSRF on changes", async () => {
        const b = new Browser(app);
        const wrong = await b.call("POST", "/api/auth/sign-in", { email: "olga@example.com", password: "not the password" });
        expect(wrong.status).toBe(401);
        expect(wrong.body.error).toBe("That email and password don’t match an account. Check them and try again.");
        const unknown = await b.call("POST", "/api/auth/sign-in", { email: "nobody@example.com", password: "not the password" });
        expect(unknown.body.error).toBe(wrong.body.error); // the same words: no way to tell which emails exist
        const ok = await b.call("POST", "/api/auth/sign-in", { email: "OLGA@example.com", password: "olga's long password" });
        expect(ok.status).toBe(200);
        const first = b.jar.get("aitp_session")!;
        await b.call("POST", "/api/auth/sign-in", { email: "olga@example.com", password: "olga's long password" });
        expect(b.jar.get("aitp_session")).not.toBe(first);
        // The earlier session ended with the rotation.
        expect((await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: `aitp_session=${first}` } })).statusCode).toBe(401);

        const made = await b.call("POST", "/api/projects", { name: "Shop" });
        expect(made.status).toBe(201);
        projectId = made.body.id;
        // Without the CSRF header, or from another site, a cookie is not enough to change anything.
        const noCsrf = await app.inject({ method: "POST", url: "/api/projects", headers: { host: "localhost:80", cookie: `aitp_session=${b.jar.get("aitp_session")}` }, payload: { name: "x" } });
        expect(noCsrf.statusCode).toBe(403);
        const foreign = await new Browser(app, "https://evil.example").call("POST", "/api/projects", { name: "x" }, { cookie: `aitp_session=${b.jar.get("aitp_session")}; aitp_csrf=${b.jar.get("aitp_csrf")}`, "x-csrf-token": b.jar.get("aitp_csrf")! });
        expect(foreign.status).toBe(403);
        expect(foreign.body.error).toMatch(/did not come from the platform's own page/);
        olga = b;
    });

    it("adds people with invite links, and each role gets what its role allows", async () => {
        const ed = await olga.call("POST", "/api/users", { email: "eve@example.com", name: "Eve", role: "editor" });
        expect(ed.status).toBe(201);
        expect(ed.body.inviteLink).toMatch(/^http:\/\/localhost:80\/#\/invite\/[\w-]{20,}$/);
        editorId = ed.body.person.id;
        const vw = await olga.call("POST", "/api/users", { email: "vic@example.com", name: "Vic", role: "viewer" });
        viewerId = vw.body.person.id;
        expect((await olga.call("POST", "/api/users", { email: "EVE@example.com", name: "Eve 2", role: "viewer" })).status).toBe(409);
        expect((await olga.call("POST", "/api/users", { email: "admin@localhost", name: "x", role: "viewer" })).status).toBe(400);

        const eve = new Browser(app);
        const token = ed.body.inviteLink.split("/").pop();
        expect((await eve.call("POST", "/api/auth/invite/check", { token })).body).toEqual({ email: "eve@example.com", name: "Eve", purpose: "invite" });
        expect((await eve.call("POST", "/api/auth/invite/accept", { token, password: "short" })).status).toBe(400);
        expect((await eve.call("POST", "/api/auth/invite/accept", { token, password: "eve's long password" })).status).toBe(200);
        expect((await eve.call("POST", "/api/auth/invite/accept", { token, password: "eve's long password" })).status).toBe(404); // once only

        const vic = new Browser(app);
        await vic.call("POST", "/api/auth/invite/accept", { token: vw.body.inviteLink.split("/").pop(), password: "vic's long password" });

        // Viewer: reads, never changes.
        expect((await vic.call("GET", `/api/projects/${projectId}`)).status).toBe(200);
        const vicPost = await vic.call("POST", "/api/projects", { name: "Nope" });
        expect(vicPost.status).toBe(403);
        expect(vicPost.body.error).toBe("This needs the Editor role, and you have Viewer. Ask an owner of this platform if you need it.");
        // Editor: works on tests and projects, not on people or runner tokens.
        expect((await eve.call("PUT", `/api/projects/${projectId}/helpers/util`, { content: "export const greet = () => 'hi';\n" })).status).toBeLessThan(300);
        expect((await eve.call("GET", "/api/users")).status).toBe(403);
        expect((await eve.call("GET", "/api/admin/runners")).status).toBe(403);
        expect((await eve.call("GET", "/api/activity")).status).toBe(403);
        // The helper's audit row says who saved it.
        const audit = platform.db.all("SELECT actor FROM custom_audit WHERE project_id = ?", projectId);
        expect(audit.map((r) => r.actor)).toEqual([`Eve (${editorId})`]);
        // Who am I, for the page.
        expect((await eve.call("GET", "/api/auth/state")).body.me).toMatchObject({ kind: "user", id: editorId, email: "eve@example.com", role: "editor", via: "session" });
    });

    it("never leaves the platform without an active owner, and turning someone off ends their sessions", async () => {
        const me = (await olga.call("GET", "/api/auth/state")).body.me;
        expect((await olga.call("PATCH", `/api/users/${me.id}`, { role: "editor" })).status).toBe(409);
        expect((await olga.call("PATCH", `/api/users/${me.id}`, { status: "disabled" })).status).toBe(409);
        expect((await olga.call("DELETE", `/api/users/${me.id}`)).status).toBe(409);

        const eve = new Browser(app);
        await eve.call("POST", "/api/auth/sign-in", { email: "eve@example.com", password: "eve's long password" });
        expect((await eve.call("GET", "/api/projects")).status).toBe(200);
        expect((await olga.call("PATCH", `/api/users/${editorId}`, { status: "disabled" })).status).toBe(200);
        expect((await eve.call("GET", "/api/projects")).status).toBe(401);
        expect((await eve.call("POST", "/api/auth/sign-in", { email: "eve@example.com", password: "eve's long password" })).status).toBe(401);
        await olga.call("PATCH", `/api/users/${editorId}`, { status: "active" });
        // A reset link: the new password ends every earlier session.
        const reset = await olga.call("POST", `/api/users/${editorId}/reset-link`);
        expect(reset.body.purpose).toBe("reset");
        const eve2 = new Browser(app);
        await eve2.call("POST", "/api/auth/sign-in", { email: "eve@example.com", password: "eve's long password" });
        await new Browser(app).call("POST", "/api/auth/invite/accept", { token: reset.body.link.split("/").pop(), password: "eve's new long password" });
        expect((await eve2.call("GET", "/api/projects")).status).toBe(401);
    });

    it("locks an email after five wrong passwords, even for the right one", async () => {
        const b = new Browser(app);
        for (let i = 0; i < 5; i++) expect((await b.call("POST", "/api/auth/sign-in", { email: "vic@example.com", password: `wrong ${i} password` })).status).toBe(401);
        const locked = await b.call("POST", "/api/auth/sign-in", { email: "vic@example.com", password: "vic's long password" });
        expect(locked.status).toBe(429);
        expect(locked.body.error).toMatch(/Too many wrong passwords for this email\. Wait 15 minutes/);
    });

    it("gives each person API tokens that act as them with at most their role", async () => {
        const made = await olga.call("POST", "/api/me/tokens", { name: "read-only CI", role: "viewer", expiresInDays: 30 });
        expect(made.status).toBe(201);
        const token: string = made.body.token;
        expect(token.startsWith("aitpu_")).toBe(true);
        expect(JSON.stringify((await olga.call("GET", "/api/me/tokens")).body)).not.toContain(token);
        // As x-api-key (MCP, ai-test) and as a bearer token.
        expect((await withKey(app, "GET", "/api/projects", undefined, token)).status).toBe(200);
        expect((await app.inject({ method: "GET", url: "/api/projects", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
        expect((await withKey(app, "POST", "/api/projects", { name: "x" }, token)).status).toBe(403);
        // A token cannot make tokens, and a removed token stops working.
        expect((await withKey(app, "POST", "/api/me/tokens", { name: "chain" }, token)).status).toBe(403);
        expect((await olga.call("DELETE", `/api/me/tokens/${made.body.info.id}`)).status).toBe(200);
        expect((await withKey(app, "GET", "/api/projects", undefined, token)).status).toBe(401);
        // A viewer cannot make an owner token.
        const vic = new Browser(app);
        const reset = await olga.call("POST", `/api/users/${viewerId}/reset-link`);
        await vic.call("POST", "/api/auth/invite/accept", { token: reset.body.link.split("/").pop(), password: "vic's second password" });
        expect((await vic.call("POST", "/api/me/tokens", { name: "x", role: "owner" })).status).toBe(400);
        // The access key has no account of its own.
        expect((await withKey(app, "GET", "/api/me/tokens")).status).toBe(400);
    });

    it("ends idle sessions, and signs out here or everywhere", async () => {
        const b = new Browser(app);
        await b.call("POST", "/api/auth/sign-in", { email: "olga@example.com", password: "olga's long password" });
        platform.db.run("UPDATE user_sessions SET last_seen_at = ? WHERE user_id = (SELECT id FROM users WHERE email = 'olga@example.com')", Date.now() - 13 * 3600_000);
        expect((await b.call("GET", "/api/projects")).status).toBe(401);
        expect((await olga.call("GET", "/api/projects")).status).toBe(401); // olga's earlier session went idle too
        olga = new Browser(app);
        await olga.call("POST", "/api/auth/sign-in", { email: "olga@example.com", password: "olga's long password" });
        const other = new Browser(app);
        await other.call("POST", "/api/auth/sign-in", { email: "olga@example.com", password: "olga's long password" });
        expect((await other.call("POST", "/api/auth/sign-out")).status).toBe(200);
        expect(other.jar.has("aitp_session")).toBe(false);
        expect((await olga.call("GET", "/api/projects")).status).toBe(200);
        const third = new Browser(app);
        await third.call("POST", "/api/auth/sign-in", { email: "olga@example.com", password: "olga's long password" });
        expect((await olga.call("POST", "/api/me/sign-out-everywhere")).body.sessionsEnded).toBeGreaterThanOrEqual(2);
        expect((await third.call("GET", "/api/projects")).status).toBe(401);
        olga = new Browser(app);
        await olga.call("POST", "/api/auth/sign-in", { email: "olga@example.com", password: "olga's long password" });
    });

    it("lists who did what in Activity, with filters, and never records secrets", async () => {
        const all = (await olga.call("GET", "/api/activity?limit=200")).body.activity as Array<{ actor: { kind: string; name: string }; action: string; projectId: string | null; status: number }>;
        expect(all.some((a) => a.actor.name === "Eve" && a.action === "PUT /api/projects/:id/helpers/:name" && a.projectId === projectId)).toBe(true);
        expect(all.some((a) => a.actor.name === "Vic" && a.action === "POST /api/projects" && a.status === 403)).toBe(true);
        expect(all.some((a) => a.action === "sign-in failed" && a.actor.name === "vic@example.com")).toBe(true);
        expect(all.some((a) => a.action === "first owner created" && a.actor.kind === "key")).toBe(true);
        const keyOnly = (await olga.call("GET", "/api/activity?kind=key&limit=200")).body.activity as Array<{ actor: { kind: string } }>;
        expect(keyOnly.length).toBeGreaterThan(0);
        expect(keyOnly.every((a) => a.actor.kind === "key")).toBe(true);
        const dump = JSON.stringify(platform.db.all("SELECT * FROM activity"));
        for (const secret of ["olga's long password", "eve's long password", "aitpu_", KEY]) expect(dump).not.toContain(secret);
        expect(JSON.stringify(platform.db.all("SELECT * FROM user_sessions"))).not.toContain(olga.jar.get("aitp_session")!);
    });

    it("sets Secure cookies when the platform is reached over https", async () => {
        process.env.PUBLIC_URL = "https://tests.example.com";
        try {
            const r = await new Browser(app, "https://tests.example.com").call("POST", "/api/auth/sign-in", { email: "olga@example.com", password: "olga's long password" });
            expect(r.status).toBe(200);
            expect(String(r.headers["set-cookie"])).toMatch(/HttpOnly; Secure/);
        } finally {
            delete process.env.PUBLIC_URL;
        }
    });

    // ── single sign-on against a local provider ──
    describe("single sign-on (OpenID Connect)", () => {
        let idp: http.Server;
        const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const otherKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
        /** What the next token answer carries; the test sets it per case. */
        let next: { claims?: Record<string, unknown>; alg?: string; key?: KeyObject } = {};
        let lastTokenRequest = new URLSearchParams();
        let lastAuthorize = new URL(IDP);

        const jwt = (claims: Record<string, unknown>, alg = "RS256", key: KeyObject = keys.privateKey) => {
            const h = Buffer.from(JSON.stringify({ alg, kid: "k1", typ: "JWT" })).toString("base64url");
            const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
            return `${h}.${p}.${signRaw("RSA-SHA256", Buffer.from(`${h}.${p}`), key).toString("base64url")}`;
        };

        beforeAll(async () => {
            clearSsoCaches();
            idp = http.createServer((req, res) => {
                const u = new URL(req.url!, IDP);
                const json = (v: unknown, status = 200) => {
                    res.writeHead(status, { "content-type": "application/json" });
                    res.end(JSON.stringify(v));
                };
                if (u.pathname === "/.well-known/openid-configuration")
                    return json({ issuer: IDP, authorization_endpoint: `${IDP}/authorize`, token_endpoint: `${IDP}/token`, jwks_uri: `${IDP}/jwks`, token_endpoint_auth_methods_supported: ["client_secret_post"] });
                if (u.pathname === "/jwks") return json({ keys: [{ ...(keys.publicKey.export({ format: "jwk" }) as object), kid: "k1", use: "sig", alg: "RS256" }] });
                if (u.pathname === "/token") {
                    let body = "";
                    req.on("data", (c) => (body += c));
                    req.on("end", () => {
                        lastTokenRequest = new URLSearchParams(body);
                        if (lastTokenRequest.get("client_secret") !== SSO_SECRET) return json({ error: "invalid_client" }, 401);
                        const nonce = lastAuthorize.searchParams.get("nonce");
                        const now = Math.floor(Date.now() / 1000);
                        const claims = { iss: IDP, aud: "platform-client", sub: "sub-123", email: "sam@corp.example", email_verified: true, name: "Sam", nonce, iat: now, exp: now + 300, ...next.claims };
                        json({ access_token: "at", token_type: "Bearer", id_token: jwt(claims, next.alg, next.key) });
                    });
                    return;
                }
                json({ error: "not found" }, 404);
            });
            await new Promise<void>((r) => idp.listen(IDP_PORT, "127.0.0.1", r));
        });
        afterAll(() => new Promise<void>((r) => idp.close(() => r())));

        /** One full round trip in a fresh browser: start, the provider "signs in", the callback. */
        const roundTrip = async (n: typeof next) => {
            next = n;
            const b = new Browser(app);
            const start = await b.call("GET", "/api/auth/sso/start");
            expect(start.status).toBe(302);
            lastAuthorize = new URL(String(start.headers.location));
            const cb = await b.call("GET", `/api/auth/sso/callback?code=the-code&state=${lastAuthorize.searchParams.get("state")}`);
            return { b, cb, location: decodeURIComponent(String(cb.headers.location)) };
        };

        it("checks the provider before saving, and keeps the client secret write-only", async () => {
            const bad = await olga.call("PUT", "/api/sso-settings", { issuer: "http://login.example.com", clientId: "c", clientSecret: "s", allowedDomain: "corp.example" });
            expect(bad.status).toBe(400);
            expect(bad.body.error).toMatch(/must start with https/);
            const saved = await olga.call("PUT", "/api/sso-settings", { issuer: IDP, clientId: "platform-client", clientSecret: SSO_SECRET, allowedDomain: "corp.example", defaultRole: "viewer", label: "Sign in with Corp" });
            expect(saved.status).toBe(200);
            expect(saved.body).toMatchObject({ configured: true, hasSecret: true, redirectUri: "http://localhost:80/api/auth/sso/callback" });
            expect(JSON.stringify(saved.body)).not.toContain(SSO_SECRET);
            expect(JSON.stringify(platform.db.all("SELECT * FROM auth_settings"))).not.toContain(SSO_SECRET);
            expect((await new Browser(app).call("GET", "/api/auth/state")).body.sso).toEqual({ enabled: true, label: "Sign in with Corp" });
        });

        it("signs a new person in with PKCE and a verified RS256 ID token, as the default role", async () => {
            const { b, cb, location } = await roundTrip({});
            expect(location).toBe("http://localhost:80/#/");
            expect(cb.headers["set-cookie"]).toBeDefined();
            expect(lastAuthorize.searchParams.get("code_challenge_method")).toBe("S256");
            expect(createHash("sha256").update(lastTokenRequest.get("code_verifier")!).digest("base64url")).toBe(lastAuthorize.searchParams.get("code_challenge"));
            expect(lastTokenRequest.get("redirect_uri")).toBe("http://localhost:80/api/auth/sso/callback");
            const me = (await b.call("GET", "/api/auth/state")).body.me;
            expect(me).toMatchObject({ kind: "user", name: "Sam", email: "sam@corp.example", role: "viewer" });
            // The second time, the same person (now linked) signs in again.
            const again = await roundTrip({});
            expect(again.location).toBe("http://localhost:80/#/");
            expect((await olga.call("GET", "/api/users")).body.people.filter((p: { email: string }) => p.email === "sam@corp.example")).toHaveLength(1);
        });

        it("refuses tokens it cannot trust, in words", async () => {
            const cases: Array<[typeof next, RegExp]> = [
                [{ key: otherKeys.privateKey }, /signature is not valid/],
                [{ alg: "HS256" }, /only RS256 is accepted/],
                [{ claims: { aud: "someone-else" } }, /different application/],
                [{ claims: { iss: "http://127.0.0.1:1" } }, /different issuer/],
                [{ claims: { exp: Math.floor(Date.now() / 1000) - 3600 } }, /expired/],
                [{ claims: { nonce: "another" } }, /does not belong to this sign-in/],
                [{ claims: { email: "mallory@other.example", sub: "m" } }, /Only addresses at corp\.example/],
                [{ claims: { email: "una@corp.example", email_verified: false, sub: "u" } }, /not verified/],
                [{ claims: { sub: "a-different-subject" } }, /linked to a different single sign-on identity/],
            ];
            for (const [n, words] of cases) {
                const { cb, location } = await roundTrip(n);
                expect(cb.status).toBe(302);
                expect(location, JSON.stringify(n.claims ?? n.alg ?? "key")).toMatch(words);
                expect(location).toContain("/#/?ssoError=");
                expect(cb.headers["set-cookie"]).toBeUndefined();
            }
            // A callback that was not started here, or is replayed, is refused too.
            const replay = await new Browser(app).call("GET", `/api/auth/sso/callback?code=x&state=${lastAuthorize.searchParams.get("state")}`);
            expect(decodeURIComponent(String(replay.headers.location))).toMatch(/was not started here/);
        });
    });
});
