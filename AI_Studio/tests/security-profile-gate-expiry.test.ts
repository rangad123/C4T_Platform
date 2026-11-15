/**
 * The approved expiry policy: the client's authorization lasts 90 days and a Crowd4Test admin's profile approval 30 days
 * from when each is recorded; both stop counting at once when the application's target, scope, exclusions, request limit, environment,
 * saved sign-in account, sensitive workflows, the project's test-account list (when a test account is used), the cross-account designation or the profile's wording
 * change. Judged on the server at start, at approval and when shown. An authorization recorded before the authorizer details (no authorizer role or
 * authority) never allows anything above passive and expires 90 days after the release was deployed (more in the -legacy test file). A fake clock (Date only) moves time.
 *
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/security-profile-gate-expiry.test.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { bootstrap } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { isolationReady } from "../src/security/egress/isolation.js";
import { AUTHORIZATION_WORDS } from "../src/security/authorization.js";
import { GATE_WORDS } from "../src/security/profile-gate.js";
import { LEGACY_AUTHORIZATION_RELEASE_AT } from "../src/security/release.js";
import { SCAN_PROFILES } from "../src/security/scanners/profiles.js";
import { securityStoreFor } from "../src/security/store.js";

const KEY = "sec-expiry-key-0123456789";
const API = "/api/v1/security";
const DAY = 86_400_000;
const T0 = Date.parse("2026-01-10T09:00:00.000Z");
const dirs: string[] = [];

type Call = (method: string, url: string, body?: unknown) => Promise<{ status: number; body: any }>;
const parse = (raw: string): unknown => {
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
};
const caller =
    (app: FastifyInstance, headers: Record<string, string>): Call =>
    async (method, url, body) => {
        const r = await app.inject({ method: method as never, url, headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
        return { status: r.statusCode, body: parse(r.body) };
    };

const ADMIN = { data: { user: { id: "ada", email: "ada@people.example", role: "ADMIN", status: "ACTIVE", firstName: "Ada", lastName: "Person", emailVerified: true, permissions: PERMISSIONS, organisationId: null } } };

async function serve(c4tPort: number) {
    const c4t = http.createServer((req, res) => {
        const ok = String(req.headers.authorization ?? "") === "Bearer t-admin";
        res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ok ? ADMIN : { error: { message: "Invalid access token" } }));
    });
    await new Promise<void>((r) => c4t.listen(c4tPort, "127.0.0.1", r));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sec-expiry-"));
    dirs.push(dir);
    const platform = bootstrap(
        loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECURITY_ACTIVE_PROFILES: "on", C4T_API_ORIGIN: `http://127.0.0.1:${c4tPort}`, C4T_SITE_URL: "https://crowd4test.example" } as never),
    );
    const app = await buildServer(platform);
    await app.ready();
    // With profiles above passive on, the server checks this machine's isolation in the background once ready (a start meanwhile is
    // refused as still checking): wait for that real check, as an operator would, before starting anything.
    await isolationReady();
    const users = accessControlOf(app).users;
    const person = (name: string, role: "owner" | "editor") => {
        const u = users.create({ email: `${name.toLowerCase()}@example.com`, name, role });
        return caller(app, { "x-api-key": users.createToken(u.id, { name: "t", role }).token });
    };
    const close = async () => {
        await app.close();
        platform.db.close();
        await new Promise((r) => c4t.close(r));
    };
    return { platform, close, key: caller(app, { "x-api-key": KEY }), owner: person("Olga", "owner"), editor: person("Eve", "editor"), admin: caller(app, { cookie: "c4t_access=t-admin", "x-requested-with": "ai-studio" }) };
}

const authBody = { basis: "client-permission", approverName: "Dana Client", approverRole: "Head of Engineering", approverEmail: "dana@client.example", documentReference: "SOW-12", authority: "Signed SOW-12 as the owner's CTO.", confirm: true };
const at = (ms: number) => vi.setSystemTime(new Date(ms));

afterEach(() => {
    vi.useRealTimers();
});
afterAll(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("expiry (fake clock): authorization 90 days, approval 30 days", () => {
    let s: Awaited<ReturnType<typeof serve>>;
    let appId: string;
    beforeAll(async () => {
        s = await serve(9523);
        const projectId = (await s.key("POST", "/api/projects", { name: "Client" })).body.id;
        appId = (await s.editor("POST", `${API}/projects/${projectId}/applications`, { name: "Shop", targetUrl: "https://staging.shop.example.com/", environment: "staging", maxRequestsPerSecond: 2 })).body.application.id;
    }, 60_000);
    afterAll(async () => {
        await s?.close();
    });

    /** Starts at this profile; a created assessment is cancelled at once (nothing runs: no loop). Returns the status and refusal. */
    const start = async (kind: string) => {
        const r = await s.editor("POST", `${API}/applications/${appId}/assessments`, { kind });
        if (r.status === 201) await s.editor("POST", `${API}/assessments/${r.body.assessment.id}/cancel`, {});
        return { status: r.status, error: r.body.error as string | undefined };
    };

    it("an approval counts on day 29 and not on day 31; the authorization on day 89 and not on day 91", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        at(T0);
        expect((await s.owner("POST", `${API}/applications/${appId}/authorizations`, { ...authBody, maxProfile: "advanced" })).status).toBe(201);
        const ok = await s.admin("POST", `${API}/applications/${appId}/approvals`, { profile: "conservative-active", confirm: true });
        expect(ok.status, JSON.stringify(ok.body)).toBe(201);
        expect(Date.parse(ok.body.approval.expiresAt)).toBe(T0 + 30 * DAY);

        at(T0 + 29 * DAY);
        expect(await start("conservative-active")).toEqual({ status: 201, error: undefined });
        expect((await s.key("GET", `${API}/applications/${appId}/approvals`)).body.approvals[0].current.state).toBe("current");

        at(T0 + 31 * DAY);
        expect(await start("conservative-active")).toEqual({ status: 409, error: GATE_WORDS.approvalExpired("Conservative active checks") });
        const shown = (await s.key("GET", `${API}/applications/${appId}/approvals`)).body.approvals[0];
        expect(shown.current).toEqual({ state: "expired", message: GATE_WORDS.approvalExpired("Conservative active checks") });
        expect(await start("passive")).toEqual({ status: 201, error: undefined });
        // A new approval (the authorization is still current) counts again.
        expect((await s.admin("POST", `${API}/applications/${appId}/approvals`, { profile: "conservative-active", confirm: true })).status).toBe(201);
        expect(await start("conservative-active")).toEqual({ status: 201, error: undefined });

        at(T0 + 89 * DAY);
        expect((await s.key("GET", `${API}/applications/${appId}`)).body.authorization.state).toBe("current");
        expect(await start("passive")).toEqual({ status: 201, error: undefined });

        at(T0 + 91 * DAY);
        const got = (await s.key("GET", `${API}/applications/${appId}`)).body;
        expect(got.authorization).toMatchObject({ state: "expired", message: AUTHORIZATION_WORDS.expired });
        expect(got.currentAuthorization).toBeNull();
        expect(await start("passive")).toEqual({ status: 409, error: AUTHORIZATION_WORDS.expired });
        // At approval too: no approval against an expired authorization.
        const refused = await s.admin("POST", `${API}/applications/${appId}/approvals`, { profile: "conservative-active", confirm: true });
        expect(refused.status).toBe(409);
        expect(refused.body.error).toBe(GATE_WORDS.approvalNeedsAuthorization("Conservative active checks"));
        // Recording a new authorization makes it current again.
        expect((await s.owner("POST", `${API}/applications/${appId}/authorizations`, authBody)).status).toBe(201);
        expect(await start("passive")).toEqual({ status: 201, error: undefined });
    });

    it("revocation is immediate", async () => {
        const auth = securityStoreFor(s.platform.db).listAuthorizations(appId)[0]!;
        expect((await s.owner("DELETE", `${API}/authorizations/${auth.id}`)).status).toBe(200);
        expect(await start("passive")).toEqual({ status: 409, error: AUTHORIZATION_WORDS.revoked });
    });
});

describe("a change to any detail invalidates the authorization and the approval at once", () => {
    let s: Awaited<ReturnType<typeof serve>>;
    let projectId: string;
    let appId: string;
    const db = () => s.platform.db;
    beforeAll(async () => {
        s = await serve(9524);
        projectId = (await s.key("POST", "/api/projects", { name: "Client" })).body.id;
        appId = (await s.editor("POST", `${API}/projects/${projectId}/applications`, { name: "Shop", targetUrl: "https://staging.shop.example.com/", environment: "staging", maxRequestsPerSecond: 2 })).body.application.id;
        // Saved sign-ins for two test accounts (the rows only: nothing signs in here), and a test-account list.
        for (const account of ["alice", "bob"])
            db().run("INSERT INTO saved_sessions (project_id, account, state_enc, app_url, check_url, saved_at, how) VALUES (?,?,?,?,?,?,?)", projectId, account, "x", "https://staging.shop.example.com/", "https://staging.shop.example.com/me", new Date().toISOString(), "manual");
        db().run("INSERT INTO project_roles (project_id, roles_enc, updated_at) VALUES (?,?,?)", projectId, "x", "2026-01-01T00:00:00.000Z");
        db().run("INSERT INTO security_cross_account (application_id, designation_json, updated_by, updated_at) VALUES (?,?,?,?)", appId, JSON.stringify({ accountA: "alice", accountB: "bob", resources: [] }), "Eve", new Date().toISOString());
        expect((await s.editor("PATCH", `${API}/applications/${appId}`, { signInAccount: "alice" })).status).toBe(200);
    }, 60_000);
    afterAll(async () => {
        await s?.close();
    });

    const start = async (kind: string) => {
        const r = await s.editor("POST", `${API}/applications/${appId}/assessments`, { kind });
        if (r.status === 201) await s.editor("POST", `${API}/assessments/${r.body.assessment.id}/cancel`, {});
        return { status: r.status, error: r.body.error as string | undefined };
    };
    /** Records the authorization (naming the cross-account accounts) and the approval, and proves both count. */
    const authorizeAndApprove = async () => {
        expect((await s.owner("POST", `${API}/applications/${appId}/authorizations`, { ...authBody, maxProfile: "conservative-active", crossAccounts: ["alice", "bob"] })).status).toBe(201);
        const ok = await s.admin("POST", `${API}/applications/${appId}/approvals`, { profile: "conservative-active", confirm: true });
        expect(ok.status, JSON.stringify(ok.body)).toBe(201);
        expect(await start("conservative-active")).toEqual({ status: 201, error: undefined });
    };
    const approvalState = async () => (await s.key("GET", `${API}/applications/${appId}/approvals`)).body.approvals[0].current.state as string;

    const changes: Array<[string, () => Promise<unknown> | unknown, string]> = [
        ["target", () => s.editor("PATCH", `${API}/applications/${appId}`, { targetUrl: "https://staging2.shop.example.com/" }), AUTHORIZATION_WORDS.stale],
        ["scope", () => s.editor("PATCH", `${API}/applications/${appId}`, { scope: ["https://api.shop.example.com"] }), AUTHORIZATION_WORDS.stale],
        ["exclusions", () => s.editor("PATCH", `${API}/applications/${appId}`, { excludedPaths: ["/billing"] }), AUTHORIZATION_WORDS.stale],
        ["request limit", () => s.editor("PATCH", `${API}/applications/${appId}`, { maxRequestsPerSecond: 3 }), AUTHORIZATION_WORDS.stale],
        ["sensitive workflows", () => s.editor("PATCH", `${API}/applications/${appId}`, { sensitiveWorkflows: [{ name: "Checkout", pathPrefixes: ["/checkout"], note: null }] }), AUTHORIZATION_WORDS.stale],
        ["saved sign-in account", () => s.editor("PATCH", `${API}/applications/${appId}`, { signInAccount: "bob" }), AUTHORIZATION_WORDS.stale],
        ["environment", () => s.editor("PATCH", `${API}/applications/${appId}`, { environment: "development" }), AUTHORIZATION_WORDS.staleDetails],
        ["test-account credentials", () => db().run("UPDATE project_roles SET updated_at = ? WHERE project_id = ?", "2026-02-02T00:00:00.000Z", projectId), AUTHORIZATION_WORDS.staleDetails],
        ["cross-account designation", () => db().run("UPDATE security_cross_account SET designation_json = ? WHERE application_id = ?", JSON.stringify({ accountA: "alice", accountB: "bob", resources: [{ path: "/orders/1", kind: "order", owner: "B", label: "Order 1" }] }), appId), AUTHORIZATION_WORDS.staleDetails],
    ];

    for (const [field, change, words] of changes) {
        it(`the ${field}`, async () => {
            await authorizeAndApprove();
            await change();
            const state = (await s.key("GET", `${API}/applications/${appId}`)).body.authorization;
            expect(state).toMatchObject({ state: "stale", message: words });
            expect(await start("passive")).toEqual({ status: 409, error: words });
            expect(await approvalState()).toMatch(/^(changed|other-environment)$/);
        });
    }

    it("but saving the named account's sign-in again (fresh cookies) is a refresh, not a change", async () => {
        await authorizeAndApprove();
        db().run("UPDATE saved_sessions SET check_url = ?, saved_at = ? WHERE project_id = ? AND account = 'bob'", "https://staging2.shop.example.com/account", new Date().toISOString(), projectId);
        expect((await s.key("GET", `${API}/applications/${appId}`)).body.authorization.state).toBe("current");
        expect(await approvalState()).toBe("current");
        expect(await start("conservative-active")).toEqual({ status: 201, error: undefined });
    });

    it("the wording of the profile", async () => {
        await authorizeAndApprove();
        const original = SCAN_PROFILES["conservative-active"];
        (SCAN_PROFILES as Record<string, unknown>)["conservative-active"] = { ...original, description: `${original.description} Changed.` };
        try {
            expect((await s.key("GET", `${API}/applications/${appId}`)).body.authorization).toMatchObject({ state: "stale", message: AUTHORIZATION_WORDS.staleDetails });
            expect(await approvalState()).toBe("changed");
            // A new authorization against the new wording; the approval still does not count until a Crowd4Test admin approves again.
            expect((await s.owner("POST", `${API}/applications/${appId}/authorizations`, { ...authBody, maxProfile: "conservative-active", crossAccounts: ["alice", "bob"] })).status).toBe(201);
            expect(await start("conservative-active")).toEqual({ status: 409, error: GATE_WORDS.approvalChanged("Conservative active checks") });
        } finally {
            (SCAN_PROFILES as Record<string, unknown>)["conservative-active"] = original;
        }
    });

    it("an authorization recorded without the authorizer's role and authority stays passive-only and expires 90 days after the release was deployed", async () => {
        const recorded = Date.now() + 60_000; // after every earlier record, so it is the latest
        vi.useFakeTimers({ toFake: ["Date"] });
        at(recorded);
        const store = securityStoreFor(db());
        const a = store.getApplication(appId)!;
        const release = Date.parse(LEGACY_AUTHORIZATION_RELEASE_AT); // shipped with the code (release.ts), before the record
        expect(release).toBeLessThanOrEqual(recorded);
        const expiresAt = new Date(release + 90 * DAY).toISOString();
        const old = store.addAuthorization(appId, { basis: "owner", approverName: "Dana", statement: "I confirm.", confirmedByName: "Olga", maxProfile: "conservative-active" });
        expect(old).toMatchObject({ approverRole: null, authority: null, detailsRecorded: false, expiresAt });
        at(release + 89 * DAY);
        expect(store.authorizationState(a)).toMatchObject({ state: "current", detailsRecorded: false, expiresAt });
        expect((await s.key("GET", `${API}/applications/${appId}`)).body.authorization).toMatchObject({ state: "current", detailsRecorded: false, expiresAt });
        expect(await start("passive")).toEqual({ status: 201, error: undefined });
        expect(await start("conservative-active")).toEqual({ status: 409, error: GATE_WORDS.detailsNotRecorded });
        // Nor can an approval be recorded against it.
        expect((await s.admin("POST", `${API}/applications/${appId}/approvals`, { profile: "conservative-active", confirm: true })).body.error).toBe(GATE_WORDS.approvalNeedsAuthorization("Conservative active checks"));

        at(release + 91 * DAY);
        const shown = (await s.key("GET", `${API}/applications/${appId}`)).body;
        expect(shown.authorization).toMatchObject({ state: "expired", message: AUTHORIZATION_WORDS.legacyExpired, detailsRecorded: false, expiresAt });
        expect(shown.currentAuthorization).toBeNull();
        expect(await start("passive")).toEqual({ status: 409, error: AUTHORIZATION_WORDS.legacyExpired });
        expect((await s.admin("POST", `${API}/applications/${appId}/approvals`, { profile: "conservative-active", confirm: true })).body.error).toBe(GATE_WORDS.approvalNeedsAuthorization("Conservative active checks"));
    });
});
