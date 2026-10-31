/**
 * Round 20 (SIGN) without a browser: signed-in assessments' building blocks (which saved sign-in is used and why not, cookies only to
 * their own hosts, sign-out addresses refused by the guard, every saved value scrubbed), the uploaded API document (which operations may
 * be requested: GET without required parameters only), sensitive workflows (excluded like exclusions, part of the authorization's
 * fingerprint and statement), the slot-33 tables, the coverage sentences and the report lines. One plain HTTP server WE start (port 7152)
 * proves the cookies a plain request carries.
 *
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/security-signin-unit.test.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StorageState } from "../src/engine/auth/storage-state.js";
import { Db } from "../src/platform/db.js";
import { IdentityStore } from "../src/platform/identity-store.js";
import { Repo } from "../src/platform/repo.js";
import { SecretBox } from "../src/platform/secrets.js";
import { SessionStore } from "../src/platform/session-store.js";
import { ApiDocumentError, baseUrlOf, planOperations, readApiDocument } from "../src/security/api-document.js";
import { apiDocumentCoverage } from "../src/security/assessment/api-operations.js";
import { emptyDiscovery } from "../src/security/assessment/discover.js";
import { guardFor } from "../src/security/assessment/guard.js";
import { judgeCookies } from "../src/security/assessment/judge.js";
import { notInspected, withSensitiveExclusions } from "../src/security/assessment/runner.js";
import { RefusedError } from "../src/security/assessment/types.js";
import { AUTHORIZATION_WORDS, authorizationStatement, scopeFingerprint } from "../src/security/authorization.js";
import type { SecurityApplication } from "../src/security/contract.js";
import { apiDocumentSummary, saveApiDocument } from "../src/security/extras.js";
import { ingest } from "../src/security/findings/ingest.js";
import { buildReport, renderReportHtml } from "../src/security/findings/report.js";
import { securitySettings } from "../src/security/settings.js";
import { cookieHeaderFor, isSignOut, judgeSignedInPage, limitToScope, resolveSignIn, scrubSecrets, SIGN_OUT_REASON, signInChoices, signInStatus } from "../src/security/signin.js";
import { SecurityStore } from "../src/security/store.js";
import { FIXTURE_API_DOCUMENT } from "./fixtures/security-fixture-app.js";

const PORT = 7152;
const SECRET = "signed-in-secret-token-777";
const LS = "local-storage-token-888abc";
const dirs: string[] = [];
const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sec-sign-"));
    dirs.push(d);
    return d;
};
const hits: Array<{ path: string; cookie: string }> = [];
let server: http.Server;
let second: http.Server;

beforeAll(async () => {
    const handler: http.RequestListener = (req, res) => {
        hits.push({ path: req.url ?? "", cookie: String(req.headers.cookie ?? "") });
        if (req.url === "/hop-out") return res.writeHead(302, { location: `http://127.0.0.1:${PORT + 1}/landing` }).end();
        if (req.url === "/bounce") return res.writeHead(302, { location: "/logout" }).end();
        res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    };
    // The second server is another origin (another port) in scope: a redirect to it must not carry the first origin's cookies.
    server = http.createServer(handler);
    second = http.createServer(handler);
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
    await new Promise<void>((r) => second.listen(PORT + 1, "127.0.0.1", r));
});
afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => second.close(() => r()));
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const state = (over: Partial<StorageState["cookies"][number]> = {}, extra: StorageState["cookies"] = []): StorageState => ({
    cookies: [{ name: "fixture_auth", value: SECRET, domain: "127.0.0.1", path: "/", expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: true, secure: false, sameSite: "Lax", ...over }, ...extra],
    origins: [{ origin: `http://127.0.0.1:${PORT}`, localStorage: [{ name: "token", value: LS }] }],
});

const appShape = (over: Partial<SecurityApplication> = {}): SecurityApplication => ({
    id: "a1",
    projectId: "p1",
    name: "Shop",
    targetUrl: `http://127.0.0.1:${PORT}/`,
    environment: "development",
    scope: [],
    excludedPaths: ["/admin"],
    maxRequestsPerSecond: 10,
    apiSpecUrl: null,
    notes: null,
    createdAt: "",
    updatedAt: "",
    ...over,
});

describe("sign-out addresses and links", () => {
    it("are recognised by their address or their words, and only those", () => {
        for (const u of ["http://x.test/logout", "http://x.test/log-out", "http://x.test/account/sign-out", "http://x.test/api/logout?all=1", "http://x.test/users/sign_out", "http://x.test/end-session", "http://x.test/auth/logoff"]) expect(isSignOut(u), u).toBe(true);
        for (const u of ["http://x.test/blog-offers", "http://x.test/catalog/outdoor", "http://x.test/account", "http://x.test/signup", "http://x.test/login"]) expect(isSignOut(u), u).toBe(false);
        expect(isSignOut("http://x.test/session/end", "Sign out")).toBe(true);
        expect(isSignOut("http://x.test/bye", "Log off")).toBe(true);
        expect(isSignOut("http://x.test/help", "Signing out of meetings: a guide")).toBe(false);
    });

    it("the scope guard refuses them, also as a redirect hop, when the assessment is signed in", async () => {
        const settings = securitySettings({ SECURITY_ALLOW_PRIVATE_TARGETS: "true" });
        const guard = guardFor(appShape(), settings, new AbortController().signal, {}, { state: state(), refuseSignOut: true });
        expect(await guard.refusal(`http://127.0.0.1:${PORT}/logout`)).toBe(SIGN_OUT_REASON);
        await expect(guard.fetch(`http://127.0.0.1:${PORT}/api/logout`)).rejects.toBeInstanceOf(RefusedError);
        const before = hits.length;
        const r = await guard.fetch(`http://127.0.0.1:${PORT}/bounce`);
        expect(r.status).toBe(302);
        expect(r.blockedRedirect?.reason).toBe(SIGN_OUT_REASON);
        expect(hits.slice(before).map((h) => h.path)).toEqual(["/bounce"]);
        // Signed out (anonymous) assessments keep today's rule: only links are skipped, the guard itself does not judge words.
        const anon = guardFor(appShape(), settings, new AbortController().signal);
        expect(await anon.refusal(`http://127.0.0.1:${PORT}/logout`)).toBeUndefined();
    });
});

describe("cookies of the saved sign-in", () => {
    it("go only to their own host and path, Secure only over https, never expired ones", () => {
        const s = state({}, [
            { name: "dom", value: "domain-cookie-value", domain: ".example.com", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" },
            { name: "sec", value: "secure-only-value", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: true, sameSite: "Lax" },
            { name: "old", value: "expired-value-123", domain: "127.0.0.1", path: "/", expires: 1000, httpOnly: false, secure: false, sameSite: "Lax" },
            { name: "deep", value: "deep-path-value", domain: "127.0.0.1", path: "/account", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" },
        ]);
        expect(cookieHeaderFor(s, "http://127.0.0.1:9/")).toBe(`fixture_auth=${SECRET}`);
        expect(cookieHeaderFor(s, "http://127.0.0.1:9/account/orders")).toBe(`fixture_auth=${SECRET}; deep=deep-path-value`);
        expect(cookieHeaderFor(s, "http://127.0.0.1:9/accounting")).toBe(`fixture_auth=${SECRET}`);
        expect(cookieHeaderFor(s, "https://127.0.0.1/")).toBe(`fixture_auth=${SECRET}; sec=secure-only-value`);
        expect(cookieHeaderFor(s, "http://shop.example.com/")).toBe("dom=domain-cookie-value");
        expect(cookieHeaderFor(s, "http://example.com/")).toBe("dom=domain-cookie-value");
        expect(cookieHeaderFor(s, "http://127.0.0.2/")).toBe("");
        expect(cookieHeaderFor(s, "http://evil-example.com/")).toBe("");
    });

    it("only the hosts in the authorized scope go into the assessment", () => {
        const s = state({}, [{ name: "other", value: "other-site-cookie", domain: "tracker.test", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }]);
        s.origins.push({ origin: "https://tracker.test", localStorage: [{ name: "x", value: "tracker-storage-value" }] });
        const limited = limitToScope(s, appShape());
        expect(limited.cookies.map((c) => c.name)).toEqual(["fixture_auth"]);
        expect(limited.origins.map((o) => o.origin)).toEqual([`http://127.0.0.1:${PORT}`]);
        expect(limitToScope(s, appShape({ scope: ["tracker.test"] })).cookies.map((c) => c.name)).toEqual(["fixture_auth", "other"]);
    });

    it("plain requests through the guard carry them; the browser's own Cookie header wins; another origin gets none", async () => {
        const settings = securitySettings({ SECURITY_ALLOW_PRIVATE_TARGETS: "true" });
        const guard = guardFor(appShape({ scope: [`http://127.0.0.1:${PORT + 1}`] }), settings, new AbortController().signal, {}, { state: state(), refuseSignOut: true });
        const before = hits.length;
        await guard.fetch(`http://127.0.0.1:${PORT}/plain`);
        await guard.fetch(`http://127.0.0.1:${PORT}/from-browser`, { headers: { cookie: "browser=own" } });
        await guard.fetch(`http://127.0.0.1:${PORT}/no-jar`, { savedCookies: false });
        await guard.fetch(`http://127.0.0.1:${PORT}/hop-out`);
        const seen = hits.slice(before);
        expect(seen.find((h) => h.path === "/plain")!.cookie).toBe(`fixture_auth=${SECRET}`);
        expect(seen.find((h) => h.path === "/from-browser")!.cookie).toBe("browser=own");
        expect(seen.find((h) => h.path === "/no-jar")!.cookie).toBe("");
        expect(seen.find((h) => h.path === "/landing")!.cookie).toBe("");
    });

    it("every saved value is scrubbed from what the assessment keeps, also URL-encoded and in keys", () => {
        const kept = scrubSecrets({ text: `ref ${SECRET} and ${encodeURIComponent("a b+c/d=efgh")}`, list: [LS, 3, null], [SECRET]: true }, [SECRET, LS, "a b+c/d=efgh", "short"]);
        const json = JSON.stringify(kept);
        expect(json).not.toContain(SECRET);
        expect(json).not.toContain(LS);
        expect(json).not.toContain(encodeURIComponent("a b+c/d=efgh"));
        expect(json).toContain("[hidden]");
        expect(kept.list[1]).toBe(3);
    });

    it("judges the signed-in page: 401/403, a password field or a move to a sign-in address mean signed out", () => {
        expect(judgeSignedInPage({ status: 200, finalUrl: "http://x.test/account", hasPasswordField: false }, "http://x.test/account").ok).toBe(true);
        expect(judgeSignedInPage({ status: 401, finalUrl: "http://x.test/account", hasPasswordField: true }, "http://x.test/account")).toEqual({ ok: false, reason: "answered HTTP 401" });
        expect(judgeSignedInPage({ status: 200, finalUrl: "http://x.test/account", hasPasswordField: true }, "http://x.test/account").reason).toBe("asked for a password again");
        expect(judgeSignedInPage({ status: 200, finalUrl: "http://x.test/login?next=/account", hasPasswordField: false }, "http://x.test/account").reason).toMatch(/sign-in address \/login/);
    });
});

describe("the saved sign-in an application names", () => {
    let db: Db;
    let dir: string;
    let store: SecurityStore;
    let sessions: SessionStore;
    let p1: string;
    let p2: string;
    beforeAll(() => {
        dir = tmp();
        db = new Db(path.join(dir, "t.db"));
        const repo = new Repo(db, new SecretBox(dir));
        p1 = repo.createProject({ name: "Client A" }).id;
        p2 = repo.createProject({ name: "Client B" }).id;
        store = new SecurityStore(db);
        sessions = new SessionStore(db, new SecretBox(dir));
        new IdentityStore(db, new SecretBox(dir)).set(p1, [{ name: "admin", username: "root", password: "never-typed-password" }]);
    });
    afterAll(() => db.close());
    const cfg = () => ({ dataDir: dir, SECRET_KEY: undefined });

    it("slot 33 makes its tables; the fields are stored apart and go with the application", () => {
        const names = new Set(db.all<{ name: string }>("SELECT name FROM sqlite_master").map((r) => r.name));
        expect(names.has("security_application_extras") && names.has("security_api_documents")).toBe(true);
        expect(db.get<{ v: number }>("SELECT MAX(version) AS v FROM schema_version")!.v).toBeGreaterThanOrEqual(33);
        const plain = store.createApplication(p1, { name: "Plain", targetUrl: "https://shop.example.com/", environment: "staging" });
        expect(plain).toMatchObject({ signInAccount: null, sensitiveWorkflows: [], apiDocument: null });
        expect(db.get("SELECT 1 AS x FROM security_application_extras WHERE application_id = ?", plain.id)).toBeUndefined();
        const a = store.createApplication(p1, { name: "Shop", targetUrl: `http://127.0.0.1:${PORT}/`, environment: "staging", signInAccount: "main", sensitiveWorkflows: [{ name: "Payments", pathPrefixes: ["/account/payments"], note: "Real cards" }] });
        expect(store.getApplication(a.id)).toMatchObject({ signInAccount: "main", sensitiveWorkflows: [{ name: "Payments", pathPrefixes: ["/account/payments"], note: "Real cards" }] });
        expect(store.updateApplication(a.id, { notes: "x" })).toMatchObject({ signInAccount: "main" });
        expect(store.updateApplication(a.id, { signInAccount: null })).toMatchObject({ signInAccount: null, sensitiveWorkflows: [{ name: "Payments" }] });
        saveApiDocument(db, a.id, { fileName: "api.yaml", format: "yaml", sizeBytes: 10, sha256: "x", title: "T", version: "1", operations: 3, requestable: 1, uploadedBy: "Ana", content: "openapi: 3.0.0" });
        expect(store.getApplication(a.id)!.apiDocument).toMatchObject({ fileName: "api.yaml", operations: 3, requestable: 1, uploadedBy: "Ana" });
        expect(JSON.stringify(store.listApplications(p1))).not.toContain("openapi: 3.0.0");
        store.deleteApplication(a.id);
        expect(db.get("SELECT 1 AS x FROM security_application_extras WHERE application_id = ?", a.id)).toBeUndefined();
        expect(apiDocumentSummary(db, a.id)).toBeNull();
    });

    it("missing, ready, other site, expired: plain states and coverage sentences, never a value", () => {
        const app = store.createApplication(p1, { name: "Signed", targetUrl: `http://127.0.0.1:${PORT}/`, environment: "development", signInAccount: "main" });
        expect(signInStatus(db, cfg(), p1, "main", app)).toMatchObject({ state: "missing" });
        expect(resolveSignIn(db, cfg(), app)).toMatchObject({ problem: "Signed-in pages were not inspected: no sign-in is saved for the project's own account. Save one in Settings (Test accounts, Saved sign-ins).", secrets: [] });

        sessions.saveSession(p1, "main", { state: state(), appUrl: `http://127.0.0.1:${PORT}/`, checkUrl: `http://127.0.0.1:${PORT}/account`, how: "file" });
        const ready = resolveSignIn(db, cfg(), app)!;
        expect(ready.problem).toBeUndefined();
        expect(ready.state!.cookies.map((c) => c.name)).toEqual(["fixture_auth"]);
        expect(ready.checkUrl).toBe(`http://127.0.0.1:${PORT}/account`);
        expect(ready.secrets).toEqual(expect.arrayContaining([SECRET, LS]));
        const choices = signInChoices(db, cfg(), p1, app);
        expect(choices.map((c) => [c.account, c.state])).toEqual([
            ["main", "ready"],
            ["admin", "missing"],
        ]);
        expect(JSON.stringify(choices)).not.toContain(SECRET);
        expect(JSON.stringify(choices)).not.toContain("never-typed-password");
        // Another project never sees this project's sign-ins.
        expect(signInChoices(db, cfg(), p2).map((c) => [c.account, c.state])).toEqual([["main", "missing"]]);

        const elsewhere = store.createApplication(p1, { name: "Elsewhere", targetUrl: "https://other.example.org/", environment: "development", signInAccount: "main" });
        expect(resolveSignIn(db, cfg(), elsewhere)!.problem).toMatch(/belongs to http:\/\/127\.0\.0\.1:7152, outside this application's scope/);

        sessions.saveSession(p1, "main", { state: state({ expires: Math.floor(Date.now() / 1000) - 60 }), appUrl: `http://127.0.0.1:${PORT}/`, checkUrl: `http://127.0.0.1:${PORT}/account`, how: "file" });
        expect(signInStatus(db, cfg(), p1, "main", app).state).toBe("expired");
        const expired = resolveSignIn(db, cfg(), app)!;
        expect(expired.state).toBeUndefined();
        expect(expired.problem).toBe("Signed-in pages were not inspected: the saved sign-in for the project's own account has expired. Sign in again in Settings.");
        // A session a check found signed out is expired as well.
        sessions.saveSession(p1, "main", { state: state(), appUrl: `http://127.0.0.1:${PORT}/`, checkUrl: `http://127.0.0.1:${PORT}/account`, how: "file" });
        sessions.recordCheck(p1, "main", false, "asks for a password");
        expect(resolveSignIn(db, cfg(), app)!.problem).toMatch(/has expired/);
    });
});

describe("sensitive workflows and the saved sign-in are part of the authorization", () => {
    const base = appShape();
    it("the fingerprint of an application without them is unchanged; adding or changing them makes it stale", () => {
        const fp = scopeFingerprint(base);
        expect(scopeFingerprint({ ...base, signInAccount: null, sensitiveWorkflows: [] })).toBe(fp);
        const withWf = { ...base, sensitiveWorkflows: [{ name: "Payments", pathPrefixes: ["/pay", "/checkout"], note: null }] };
        expect(scopeFingerprint(withWf)).not.toBe(fp);
        // Order of prefixes and a changed note do not matter; a changed prefix does.
        expect(scopeFingerprint({ ...base, sensitiveWorkflows: [{ name: "Payments", pathPrefixes: ["/checkout", "/pay"], note: "x" }] })).toBe(scopeFingerprint(withWf));
        expect(scopeFingerprint({ ...base, sensitiveWorkflows: [{ name: "Payments", pathPrefixes: ["/pay"], note: null }] })).not.toBe(scopeFingerprint(withWf));
        expect(scopeFingerprint({ ...base, signInAccount: "main" })).not.toBe(fp);
        expect(scopeFingerprint({ ...base, signInAccount: "main" })).not.toBe(scopeFingerprint({ ...base, signInAccount: "admin" }));
        expect(AUTHORIZATION_WORDS.stale).toMatch(/saved sign-in or sensitive workflows changed/);
    });

    it("the statement names them; without them it is the same sentence as before", () => {
        expect(authorizationStatement("Acme", base)).toBe(`I confirm that Acme owns http://127.0.0.1:${PORT}/ or that its owner has given documented permission to assess it, within the scope listed. Never requested: /admin. The assessment is passive: it only sends the ordinary requests a visitor's browser makes.`);
        const s = authorizationStatement("Acme", { ...base, signInAccount: "admin", sensitiveWorkflows: [{ name: "Payments", pathPrefixes: ["/pay"], note: null }] });
        expect(s).toContain("Sensitive workflows, never requested: Payments (/pay).");
        expect(s).toContain("It visits signed in with the saved sign-in of the test account “admin” (no password is typed and no form is submitted; sign-out links are not followed).");
    });

    it("the guard refuses their paths like exclusions", async () => {
        const scoped = withSensitiveExclusions({ ...base, sensitiveWorkflows: [{ name: "Payments", pathPrefixes: ["/account/payments"], note: null }] });
        expect(scoped.excludedPaths).toEqual(["/admin", "/account/payments"]);
        const guard = guardFor(scoped, securitySettings({ SECURITY_ALLOW_PRIVATE_TARGETS: "true" }), new AbortController().signal);
        expect(await guard.refusal(`http://127.0.0.1:${PORT}/ACCOUNT//payments/new`)).toMatch(/excluded path \/account\/payments/);
        expect(withSensitiveExclusions(base)).toBe(base);
    });
});

describe("the uploaded API document", () => {
    it("reads OpenAPI 3 YAML and JSON and Swagger 2; refuses what is not one, with plain words", () => {
        const y = readApiDocument(FIXTURE_API_DOCUMENT, "fixture-api.yaml");
        expect(y).toMatchObject({ format: "yaml", title: "Fixture shop API", version: "1.0" });
        expect(readApiDocument(JSON.stringify({ swagger: "2.0", info: { title: "S" }, paths: {} }), "s.json").format).toBe("json");
        expect(() => readApiDocument("", "x.json")).toThrow(ApiDocumentError);
        expect(() => readApiDocument("{ not json", "x.json")).toThrow("The API document is not valid JSON.");
        expect(() => readApiDocument("title: just yaml", "x.yaml")).toThrow(/not an OpenAPI or Swagger document/);
        expect(() => readApiDocument(JSON.stringify({ openapi: "3.0.0" }))).toThrow(/has no “paths”/);
        expect(() => readApiDocument(" ".repeat(2 * 1024 * 1024 + 1))).toThrow(/larger than 2 MB/);
    });

    it("only GET operations without required parameters may be requested; every other one says why", () => {
        const plan = planOperations(readApiDocument(FIXTURE_API_DOCUMENT).doc, `http://127.0.0.1:${PORT}/`);
        expect(plan.total).toBe(11);
        const by = Object.fromEntries(plan.operations.map((o) => [`${o.method} ${o.path}`, o]));
        expect(plan.operations.filter((o) => o.request).map((o) => o.url)).toEqual([`http://127.0.0.1:${PORT}/api/items`, `http://127.0.0.1:${PORT}/api/me`, `http://127.0.0.1:${PORT}/api/orders`, `http://127.0.0.1:${PORT}/account/payments/history`, `http://127.0.0.1:${PORT}/admin/stats`]);
        expect(plan.requestable).toBe(5);
        expect(by["POST /api/items"]).toMatchObject({ request: false, kind: "not-get", reason: "POST could change data, so it is never called." });
        expect(by["DELETE /api/orders/{id}"]!.kind).toBe("not-get");
        expect(by["GET /api/orders/{id}"]).toMatchObject({ kind: "needs-values", reason: "It needs values in its address (path parameters), so it is not called." });
        // A required parameter behind a $ref is found.
        expect(by["GET /api/search"]).toMatchObject({ kind: "needs-values", reason: "It needs parameters (q), so it is not called." });
        expect(by["GET /api/logout"]).toMatchObject({ kind: "sign-out", request: false });
        // An unreadable $ref is not guessed at.
        const odd = planOperations({ openapi: "3.0.0", paths: { "/a": { get: { parameters: [{ $ref: "#/nowhere" }] } }, "/b": { get: { requestBody: { required: true } } }, "/c": { head: {} } } }, "https://x.test/");
        expect(odd.operations.map((o) => o.reason)).toEqual(["One of its parameters could not be read, so it is not called.", "It needs a request body, so it is not called.", "Only GET operations are requested; HEAD is not called."]);
    });

    it("the base address comes from servers (variables filled), Swagger host and basePath, or the target", () => {
        expect(baseUrlOf({ openapi: "3", servers: [{ url: "/v1" }] }, "https://shop.test/app/")).toBe("https://shop.test/v1");
        expect(baseUrlOf({ openapi: "3", servers: [{ url: "https://{env}.shop.test/api", variables: { env: { default: "staging" } } }] }, "https://shop.test/")).toBe("https://staging.shop.test/api");
        expect(baseUrlOf({ swagger: "2.0", host: "api.shop.test:8443", basePath: "/v2", schemes: ["https"] }, "https://shop.test/")).toBe("https://api.shop.test:8443/v2");
        expect(baseUrlOf({ swagger: "2.0" }, "http://127.0.0.1:9/x")).toBe("http://127.0.0.1:9");
        expect(baseUrlOf({ openapi: "3" }, "https://shop.test/a/b")).toBe("https://shop.test");
    });

    it("the coverage sentence says what was requested and why the rest was not", () => {
        expect(
            apiDocumentCoverage({ fileName: "fixture-api.yaml", operations: 11, requested: [{ path: "/api/items", status: 200 }, { path: "/api/me", status: 200 }, { path: "/api/orders", status: 200 }], notRequested: { notGet: 3, needValues: 2, signOut: 1, refused: [{ path: "/account/payments/history", reason: "x" }, { path: "/admin/stats", reason: "y" }], overLimit: 0 } }),
        ).toBe(
            "The API document “fixture-api.yaml” lists 11 operations; 3 GET operations were requested read-only, the rest were not called (3 could change data or are not GET; 2 need values the assessment does not invent; 1 look like sign-out addresses; 2 are excluded, sensitive, outside the scope or could not be requested, for example /account/payments/history).",
        );
        expect(apiDocumentCoverage({ fileName: "a.json", operations: 1, requested: [{ path: "/", status: 200 }], notRequested: { notGet: 0, needValues: 0, signOut: 0, refused: [], overLimit: 0 } })).toBe("The API document “a.json” lists 1 operation; each is a GET without required parameters and was requested read-only.");
    });
});

describe("coverage and the report", () => {
    it("says signed in, signed in but rejected, why not signed in, sign-out links skipped and sensitive workflows", () => {
        const d = emptyDiscovery("http://x.test/");
        d.signInSeen = true;
        d.signOutSkipped = ["/logout", "/session/end"];
        const lim = { maxPages: 30, maxDepth: 3 };
        const sensitive = [{ name: "Payments", pathPrefixes: ["/pay"], note: "Real cards." }];
        const used = notInspected(d, [], [], lim, { signIn: { label: "the project's own account", used: true }, sensitive }).join("\n");
        expect(used).toContain("Signed in with the saved sign-in for the project's own account: pages behind the sign-in");
        expect(used).not.toContain("no account was given");
        expect(used).toContain("Sign-out links were not followed, so the session was not ended: /logout, /session/end.");
        expect(used).toContain("Sensitive workflow “Payments” (/pay) was never requested: Real cards.");
        d.signedInCheck = { url: "/account", ok: false, reason: "answered HTTP 401" };
        expect(notInspected(d, [], [], lim, { signIn: { label: "the test account “admin”", used: true } }).join("\n")).toContain(
            "Signed-in pages may not have been inspected: with the saved sign-in for the test account “admin”, the signed-in page /account answered HTTP 401. Sign in again in Settings.",
        );
        const why = "Signed-in pages were not inspected: the saved sign-in for the project's own account has expired. Sign in again in Settings.";
        expect(notInspected(d, [], [], lim, { signIn: { label: "x", used: false, problem: why } })).toContain(why);
        // Without a sign-in nothing changes.
        expect(notInspected(emptyDiscovery("http://x.test/"), [], [], lim)[0]).toBe("Signed-in areas: the assessment visits as an anonymous visitor, so pages that need signing in were not inspected.");
    });

    it("cookie values seen while signed in never reach a finding; the report names the sign-in, workflows and document, never a value", async () => {
        const dir = tmp();
        const db = new Db(path.join(dir, "r.db"));
        const repo = new Repo(db, new SecretBox(dir));
        const p = repo.createProject({ name: "Client R" }).id;
        const store = new SecurityStore(db);
        const app = store.createApplication(p, { name: "Shop", targetUrl: "http://shop.test/", environment: "staging", signInAccount: "main", sensitiveWorkflows: [{ name: "Payments", pathPrefixes: ["/pay"], note: "Cards" }] });
        saveApiDocument(db, app.id, { fileName: "api.yaml", format: "yaml", sizeBytes: 10, sha256: "x", title: "T", version: "1", operations: 11, requestable: 3, uploadedBy: "Ana", content: FIXTURE_API_DOCUMENT });
        const a = store.createAssessment({ applicationId: app.id, authorizationId: "auth", startedBy: "Ana" });
        const results = await judgeCookies([{ url: "http://shop.test/account", status: 200, headers: { "content-type": "text/html" }, text: "", setCookies: [`sessionid=${SECRET}; Path=/`] }]);
        expect(results.length).toBeGreaterThan(0);
        await ingest(store, a, results);
        const findings = JSON.stringify(store.listFindings({ projectId: p }));
        expect(findings).toContain("sessionid");
        expect(findings).not.toContain(SECRET);
        const html = renderReportHtml(buildReport(db, { projectId: p })!);
        expect(html).toContain("Sensitive workflow, never requested:</b> Payments (<code>/pay</code>): Cards");
        expect(html).toContain("<b>Signed in with:</b> the saved sign-in of the project&#39;s own account");
        expect(html).toContain("<b>API document:</b> api.yaml, 11 operations, of which 3 GET without required parameters may be requested");
        expect(html).not.toContain(SECRET);
        expect(html).not.toContain("openapi: 3.0.3");
        db.close();
    });
});
