/**
 * Round 20 (SIGN), really executed: a real Chromium and real HTTP against the local fixture app WE own (its signed-in area is reached
 * only with a cookie we put in a saved sign-in), through the platform's routes and the assessment loop.
 *
 * Proves: a signed-in assessment loads the saved sign-in (no password typed, no form submitted) and looks at the signed-in pages; the
 * cookie goes with the browser's requests and the plain read-only requests to the app's own origin; sign-out links (by address and by
 * their words) and the sign-out operation are never requested; a sensitive workflow is never requested (page links and the API document);
 * the uploaded API document's GET operations without required parameters are requested and nothing else from it; no cookie or storage
 * value is stored anywhere (every table), answered, reported or exported; an expired saved sign-in makes the assessment carry on signed
 * out with the plain sentence; a saved sign-in the app rejects is said so; the fields, their validation and the authorization staleness.
 *
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/security-signin.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { launchChromium } from "../src/engine/discovery/browser.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { IdentityStore } from "../src/platform/identity-store.js";
import { SecretBox } from "../src/platform/secrets.js";
import { buildServer } from "../src/platform/server.js";
import { FINISHED_STATES, type SecurityAssessment } from "../src/security/contract.js";
import { AssessmentLoop, type RunnerDeps } from "../src/security/assessment/runner.js";
import { loopDeps } from "../src/security/routes/assessments.js";
import { securitySettings } from "../src/security/settings.js";
import { SecurityStore } from "../src/security/store.js";
import { FIXTURE_ACCOUNT_EMAIL, FIXTURE_API_DOCUMENT, FIXTURE_SESSION_COOKIE, FIXTURE_SESSION_VALUE, FIXTURE_STORAGE_TOKEN, startSecurityFixture, type SecurityFixture } from "./fixtures/security-fixture-app.js";

type Inject = Awaited<ReturnType<typeof buildServer>>;
const API = "/api/v1/security";

let dir: string;
let platform: Platform;
let server: Inject;
let fixture: SecurityFixture;
let store: SecurityStore;
let projectId: string;
let appId: string;
let deps: RunnerDeps;
let signedRun: SecurityAssessment;
let signedRequests: SecurityFixture["requests"];
const launched: Browser[] = [];
const SECRETS = [FIXTURE_SESSION_VALUE, FIXTURE_STORAGE_TOKEN];

async function api(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
    const r = await server.inject({ method, url, ...(body !== undefined ? { payload: body as object } : {}) });
    let json: any;
    try {
        json = r.json();
    } catch {
        json = undefined;
    }
    return { status: r.statusCode, json, text: r.body };
}

async function waitFor<T>(fn: () => T | undefined | false, ms: number, what: string): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 150));
    }
}

/** Starts an assessment of the application and runs the loop until it has finished; returns it with the requests the app received meanwhile. */
async function assess(id: string): Promise<{ a: SecurityAssessment; requests: SecurityFixture["requests"] }> {
    const from = fixture.requests.length;
    const started = await api("POST", `${API}/applications/${id}/assessments`, {});
    expect(started.status, JSON.stringify(started.json)).toBe(201);
    const aid = started.json.assessment.id as string;
    const loop = new AssessmentLoop(deps, 100);
    loop.start();
    try {
        const a = await waitFor(() => {
            const x = store.getAssessment(aid)!;
            return FINISHED_STATES.includes(x.state) ? x : undefined;
        }, 150_000, `assessment ${aid}`);
        return { a, requests: fixture.requests.slice(from) };
    } finally {
        await loop.stop();
    }
}

const storageState = (value = FIXTURE_SESSION_VALUE, expires = Math.floor(Date.now() / 1000) + 3600) => ({
    cookies: [{ name: FIXTURE_SESSION_COOKIE, value, domain: "127.0.0.1", path: "/", expires, httpOnly: true, secure: false, sameSite: "Lax" }],
    origins: [{ origin: fixture.origin, localStorage: [{ name: "token", value: FIXTURE_STORAGE_TOKEN }] }],
});

const authorize = async (id: string) => {
    const r = await api("POST", `${API}/applications/${id}/authorizations`, { basis: "owner", approverName: "Test Owner", confirm: true });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json;
};

const withCookie = (r: SecurityFixture["requests"][number]) => String(r.headers.cookie ?? "").includes(`${FIXTURE_SESSION_COOKIE}=${FIXTURE_SESSION_VALUE}`);

beforeAll(async () => {
    fixture = await startSecurityFixture(7154, 7155);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-secsign-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", WORKER_EMBEDDED: "false", SECURITY_ALLOW_PRIVATE_TARGETS: "true" }));
    server = await buildServer(platform);
    store = new SecurityStore(platform.db);
    projectId = platform.repo.createProject({ name: "Signed client" }).id as string;
    // A test account exists by name; its password is never typed by the assessment (only its saved sign-in would be used).
    new IdentityStore(platform.db, new SecretBox(platform.config.dataDir, platform.config.SECRET_KEY)).set(projectId, [{ name: "admin", username: "root", password: "admin-password-never-typed" }]);
    deps = {
        ...loopDeps({ p: platform, settings: securitySettings(platform.config) }),
        limits: { maxPages: 10 },
        launch: async () => {
            const b = await launchChromium(true);
            launched.push(b);
            return b;
        },
    };
}, 60_000);

afterAll(async () => {
    for (const b of launched) await b.close().catch(() => undefined);
    await server?.close();
    platform?.db.close?.();
    await fixture?.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("the application's sign-in, sensitive workflows and API document (API)", () => {
    it("registers a signed-in application with a sensitive workflow; plain refusals", async () => {
        const base = { name: "Fixture shop", targetUrl: `${fixture.origin}/`, environment: "development", excludedPaths: ["/admin"], maxRequestsPerSecond: 10 };
        expect((await api("POST", `${API}/projects/${projectId}/applications`, { ...base, signInAccount: "nobody" })).json.error).toMatch(/There is no test account named “nobody”/);
        expect((await api("POST", `${API}/projects/${projectId}/applications`, { ...base, signInAccount: "Not Valid" })).status).toBe(400);
        const noPath = await api("POST", `${API}/projects/${projectId}/applications`, { ...base, sensitiveWorkflows: [{ name: "Payments", pathPrefixes: [] }] });
        expect(noPath.status).toBe(400);
        expect(noPath.json.error).toMatch(/at least one path/);

        const r = await api("POST", `${API}/projects/${projectId}/applications`, { ...base, signInAccount: "main", sensitiveWorkflows: [{ name: "Payments", pathPrefixes: ["/account/payments"], note: "Real card payments." }] });
        expect(r.status, JSON.stringify(r.json)).toBe(201);
        appId = r.json.application.id;
        expect(r.json.application).toMatchObject({ signInAccount: "main", sensitiveWorkflows: [{ name: "Payments", pathPrefixes: ["/account/payments"], note: "Real card payments." }], apiDocument: null });
        expect(r.json.statement).toContain("Sensitive workflows, never requested: Payments (/account/payments).");
        expect(r.json.statement).toContain("It visits signed in with the saved sign-in of the project's own account");
        const got = await api("GET", `${API}/applications/${appId}`);
        expect(got.json.signIn).toMatchObject({ account: "main", state: "missing" });
    });

    it("saves a sign-in for the application (never shown back) and lists the accounts that could be used", async () => {
        const bad = await api("PUT", `${API}/applications/${appId}/saved-sign-in`, { account: "main", storageState: storageState(), checkUrl: "/logout" });
        expect(bad.status).toBe(400);
        expect(bad.json.error).toMatch(/looks like a sign-out address/);
        expect((await api("PUT", `${API}/applications/${appId}/saved-sign-in`, { account: "main", storageState: { cookies: "no" } })).status).toBe(400);
        const saved = await api("PUT", `${API}/applications/${appId}/saved-sign-in`, { account: "main", storageState: storageState(), checkUrl: "/account" });
        expect(saved.status, JSON.stringify(saved.json)).toBe(200);
        expect(saved.json.signIn).toMatchObject({ account: "main", state: "ready", site: fixture.origin });
        const list = await api("GET", `${API}/projects/${projectId}/sign-ins?applicationId=${appId}`);
        expect(list.json.signIns.map((s: { account: string; state: string }) => [s.account, s.state])).toEqual([
            ["main", "ready"],
            ["admin", "missing"],
        ]);
        const events = (await api("GET", `${API}/projects/${projectId}/activity`)).json.events as Array<{ action: string; summary: string }>;
        expect(events.find((e) => e.action === "sign-in.saved")!.summary).toMatch(/Saved a sign-in for the project's own account from a file, for “Fixture shop” \(1 cookie; values are never shown\)\./);
        for (const s of SECRETS) for (const t of [saved.text, list.text, JSON.stringify(events)]) expect(t).not.toContain(s);
    });

    it("uploads the API document: counted and previewed, its text never returned; bad documents refused in plain words", async () => {
        const bad = await api("PUT", `${API}/applications/${appId}/api-document`, { fileName: "notes.yaml", content: "title: not an api" });
        expect(bad.status).toBe(400);
        expect(bad.json.error).toMatch(/not an OpenAPI or Swagger document/);
        const big = await api("PUT", `${API}/applications/${appId}/api-document`, { fileName: "big.json", content: `{"openapi":"3.0.0","paths":{},"x":"${"a".repeat(2 * 1024 * 1024)}"}` });
        expect(big.status).toBe(400);
        expect(big.json.error).toMatch(/larger than 2 MB/);
        const up = await api("PUT", `${API}/applications/${appId}/api-document`, { fileName: "fixture-api.yaml", content: FIXTURE_API_DOCUMENT });
        expect(up.status, JSON.stringify(up.json)).toBe(200);
        expect(up.json.document).toMatchObject({ fileName: "fixture-api.yaml", format: "yaml", title: "Fixture shop API", operations: 11, requestable: 3 });
        const ops = Object.fromEntries((up.json.operations as Array<{ method: string; path: string; request: boolean; reason: string | null }>).map((o) => [`${o.method} ${o.path}`, o]));
        expect(ops["GET /api/me"]!.request).toBe(true);
        expect(ops["GET /account/payments/history"]).toMatchObject({ request: false, reason: "It is under an excluded path or a sensitive workflow, so it is never called." });
        expect(ops["GET /admin/stats"]!.request).toBe(false);
        expect(ops["GET /api/search"]!.reason).toBe("It needs parameters (q), so it is not called.");
        const read = await api("GET", `${API}/applications/${appId}/api-document`);
        expect(read.json.document.operations).toBe(11);
        expect(read.text).not.toContain("components:");
        expect((await api("GET", `${API}/applications/${appId}`)).json.application.apiDocument).toMatchObject({ fileName: "fixture-api.yaml", requestable: 3 });
    });

    it("a change of the sensitive workflows or the sign-in needs a new authorization; a changed note does not", async () => {
        await authorize(appId);
        const note = await api("PATCH", `${API}/applications/${appId}`, { sensitiveWorkflows: [{ name: "Payments", pathPrefixes: ["/account/payments"], note: "Card payments, never touched." }] });
        expect(note.json.authorization.state).toBe("current");
        const more = await api("PATCH", `${API}/applications/${appId}`, { sensitiveWorkflows: [{ name: "Payments", pathPrefixes: ["/account/payments", "/checkout"], note: null }] });
        expect(more.json.authorization.state).toBe("stale");
        expect(more.json.authorization.message).toMatch(/saved sign-in or sensitive workflows changed/);
        const back = await api("PATCH", `${API}/applications/${appId}`, { sensitiveWorkflows: [{ name: "Payments", pathPrefixes: ["/account/payments"], note: "Real card payments." }] });
        expect(back.json.authorization.state).toBe("current");
        expect((await api("PATCH", `${API}/applications/${appId}`, { signInAccount: null })).json.authorization.state).toBe("stale");
        expect((await api("PATCH", `${API}/applications/${appId}`, { signInAccount: "main" })).json.authorization.state).toBe("current");
    });
});

describe("a signed-in assessment (real browser)", () => {
    beforeAll(async () => {
        const r = await assess(appId);
        signedRun = r.a;
        signedRequests = r.requests;
    }, 200_000);

    it("finishes and looks at the signed-in pages with the saved cookie", () => {
        expect(["COMPLETED", "PARTIALLY_COMPLETED"], JSON.stringify(signedRun)).toContain(signedRun.state);
        const account = signedRequests.filter((r) => r.path === "/account");
        expect(account.length).toBeGreaterThan(0);
        expect(account.every(withCookie)).toBe(true);
        expect(signedRequests.some((r) => r.path === "/account/orders" && withCookie(r))).toBe(true);
        // Plain read-only requests to the app's own origin carry it too (a sensitive-file check, the API document's operations).
        expect(signedRequests.some((r) => r.path === "/.env" && withCookie(r))).toBe(true);
        expect(signedRequests.some((r) => r.path === "/api/me" && withCookie(r))).toBe(true);
    });

    it("never signs out, never touches the sensitive workflow, never sends anything but reads, never leaves the scope", () => {
        const paths = signedRequests.map((r) => r.path);
        for (const p of paths) {
            expect(p, p).not.toMatch(/^\/(logout|session\/end|api\/logout)/);
            expect(p, p).not.toMatch(/^\/account\/payments/);
            expect(p, p).not.toMatch(/^\/admin/);
            expect(p, p).not.toMatch(/^\/login/);
        }
        expect(signedRequests.every((r) => ["GET", "HEAD", "OPTIONS"].includes(r.method))).toBe(true);
        expect(fixture.outsideRequests).toEqual([]);
    });

    it("requests only the API document's GET operations without required parameters", () => {
        const paths = signedRequests.map((r) => r.path);
        for (const p of ["/api/items", "/api/me", "/api/orders"]) expect(paths).toContain(p);
        expect(paths.some((p) => p.startsWith("/api/search"))).toBe(false);
        expect(paths.some((p) => /^\/api\/orders\/./.test(p))).toBe(false);
    });

    it("says in its coverage what it did and did not do", () => {
        const text = signedRun.coverage!.notInspected.join("\n");
        expect(text).toContain("Signed in with the saved sign-in for the project's own account: pages behind the sign-in that are linked from the pages seen were looked at read-only. No password was typed and no form was submitted.");
        expect(text).toMatch(/Sign-out links were not followed, so the session was not ended: .*\/logout/);
        expect(text).toMatch(/Sign-out links were not followed, so the session was not ended: .*\/session\/end/);
        expect(text).toContain("Sensitive workflow “Payments” (/account/payments) was never requested: Real card payments.");
        expect(text).toMatch(/The API document “fixture-api\.yaml” lists 11 operations; 3 GET operations were requested read-only, the rest were not called \(3 could change data or are not GET; 2 need values the assessment does not invent; 1 look like sign-out addresses; 2 are excluded, sensitive, outside the scope or could not be requested/);
        expect(text).not.toMatch(/no account was given/);
    });

    it("stores, answers, reports and exports no cookie or storage value (every table, every answer)", async () => {
        const tables = platform.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name);
        const everything = JSON.stringify(tables.map((t) => platform.db.all(`SELECT * FROM "${t}"`)));
        for (const s of SECRETS) expect(everything, s).not.toContain(s);
        const answers = [
            (await api("GET", `${API}/projects/${projectId}/findings?limit=500`)).text,
            (await api("GET", `${API}/assessments/${signedRun.id}`)).text,
            (await api("GET", `${API}/projects/${projectId}/activity`)).text,
            (await api("GET", `${API}/applications/${appId}`)).text,
            (await api("GET", `${API}/assessments/${signedRun.id}/report?format=html`)).text,
            (await api("GET", `${API}/assessments/${signedRun.id}/report?format=csv`)).text,
            (await api("GET", `${API}/projects/${projectId}/report?format=html`)).text,
        ];
        for (const s of SECRETS) for (const t of answers) expect(t).not.toContain(s);
        // The signed-in account's e-mail shown on its pages never reaches a finding or a report (FIND's redaction).
        for (const t of answers) expect(t).not.toContain(FIXTURE_ACCOUNT_EMAIL);
        const report = answers[4]!;
        expect(report).toContain("Sensitive workflow, never requested:</b> Payments");
        expect(report).toContain("<b>Signed in with:</b> the saved sign-in of the project&#39;s own account");
    });
});

describe("when the saved sign-in cannot be used", () => {
    it("an expired one: the assessment carries on signed out and says so in plain words", async () => {
        const saved = await api("PUT", `${API}/applications/${appId}/saved-sign-in`, { account: "main", storageState: storageState(FIXTURE_SESSION_VALUE, Math.floor(Date.now() / 1000) - 60), checkUrl: "/account" });
        expect(saved.json.signIn).toMatchObject({ state: "expired", message: "The saved sign-in for the project's own account has expired. Sign in again in Settings." });
        const { a, requests } = await assess(appId);
        expect(a.state).not.toBe("FAILED");
        expect(a.coverage!.notInspected).toContain("Signed-in pages were not inspected: the saved sign-in for the project's own account has expired. Sign in again in Settings.");
        expect(requests.length).toBeGreaterThan(0);
        expect(requests.some(withCookie)).toBe(false);
        expect(requests.some((r) => r.path === "/account")).toBe(false);
        expect(requests.every((r) => ["GET", "HEAD", "OPTIONS"].includes(r.method))).toBe(true);
    }, 200_000);

    it("one the application rejects (a test account's stale session): said so, nothing signed out, nothing submitted", async () => {
        await api("PATCH", `${API}/applications/${appId}`, { signInAccount: "admin" });
        await authorize(appId);
        const saved = await api("PUT", `${API}/applications/${appId}/saved-sign-in`, { account: "admin", storageState: storageState("no-longer-valid-session-000"), checkUrl: "/account" });
        expect(saved.json.signIn).toMatchObject({ account: "admin", state: "ready" });
        const { a, requests } = await assess(appId);
        expect(a.state).not.toBe("FAILED");
        expect(a.coverage!.notInspected.join("\n")).toContain("Signed-in pages may not have been inspected: with the saved sign-in for the test account “admin”, the signed-in page /account answered HTTP 401. Sign in again in Settings.");
        expect(requests.some((r) => r.path === "/account" && String(r.headers.cookie ?? "").includes("no-longer-valid-session-000"))).toBe(true);
        expect(requests.some((r) => r.path.startsWith("/login"))).toBe(false);
        expect(requests.every((r) => ["GET", "HEAD", "OPTIONS"].includes(r.method))).toBe(true);
        const everything = JSON.stringify(platform.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => platform.db.all(`SELECT * FROM "${t.name}"`)));
        expect(everything).not.toContain("no-longer-valid-session-000");
        expect(everything).not.toContain("admin-password-never-typed");
    }, 200_000);
});
