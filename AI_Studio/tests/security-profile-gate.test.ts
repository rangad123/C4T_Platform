/**
 * The profile gate through the real platform server (Fastify inject, no network, no browser, no assessment loop): an assessment starts
 * passive exactly as before; above passive it is refused at START, on the server, until the current authorization names the profile, an
 * approval for the application's environment exists, the profile's own refusal does not apply and the server allows active profiles.
 * Approvals are a sign-off by a Crowd4Test admin only (no fallback without Crowd4Test sign-in); the authorization sentence names the profile and the cross-account accounts; permissions per route.
 * Nothing active runs here: no scanner is configured and no loop is started.
 *
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/security-profile-gate.test.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { permissionRuleFor } from "../src/platform/auth/roles.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { isolationReady } from "../src/security/egress/isolation.js";
import { addApproval, GATE_WORDS } from "../src/security/profile-gate.js";
import { securityStoreFor } from "../src/security/store.js";

const KEY = "sec-gate-key-0123456789";
const API = "/api/v1/security";
const dirs: string[] = [];
const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sec-gate-"));
    dirs.push(d);
    return d;
};

type Call = (method: string, url: string, body?: unknown) => Promise<{ status: number; body: any }>;
const caller =
    (app: FastifyInstance, key: string): Call =>
    async (method, url, body) => {
        const r = await app.inject({ method: method as never, url, headers: { "x-api-key": key, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
        let parsed: unknown = r.body;
        try {
            parsed = JSON.parse(r.body);
        } catch {
            /* not JSON */
        }
        return { status: r.statusCode, body: parsed };
    };

// A stand-in Crowd4Test sign-in (no network beyond loopback): a Crowd4Test admin and a sub-admin, both holding every permission.
const me = (id: string, role: string) => ({ data: { user: { id, email: `${id}@people.example`, role, status: "ACTIVE", firstName: id === "ada" ? "Ada" : "Sam", lastName: "Person", emailVerified: true, permissions: PERMISSIONS, organisationId: null } } });
const C4T_ACCOUNTS: Record<string, unknown> = { "t-admin": me("ada", "ADMIN"), "t-sam": me("sam", "SUB_ADMIN") };
const c4tCaller =
    (app: FastifyInstance, token: string): Call =>
    async (method, url, body) => {
        const r = await app.inject({ method: method as never, url, headers: { cookie: `c4t_access=${token}`, ...(method === "GET" ? {} : { "x-requested-with": "ai-studio" }), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
        let parsed: unknown = r.body;
        try {
            parsed = JSON.parse(r.body);
        } catch {
            /* not JSON */
        }
        return { status: r.statusCode, body: parsed };
    };

/** A platform; with `c4tPort`, Crowd4Test sign-in on, against a stand-in on that port (9520-9529). */
async function serve(extra: Record<string, string> = {}, c4tPort?: number) {
    let c4t: http.Server | undefined;
    if (c4tPort) {
        c4t = http.createServer((req, res) => {
            const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
            res.writeHead(C4T_ACCOUNTS[auth] ? 200 : 401, { "content-type": "application/json" });
            res.end(JSON.stringify(C4T_ACCOUNTS[auth] ?? { error: { message: "Invalid access token" } }));
        });
        await new Promise<void>((r) => c4t!.listen(c4tPort, "127.0.0.1", r));
    }
    const platform = bootstrap(loadConfig({ DATA_DIR: tmp(), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, ...(c4tPort ? { C4T_API_ORIGIN: `http://127.0.0.1:${c4tPort}`, C4T_SITE_URL: "https://crowd4test.example" } : {}), ...extra } as never));
    const app = await buildServer(platform);
    await app.ready();
    // With profiles above passive on, the server checks this machine's isolation in the background once ready (a start meanwhile is
    // refused as still checking): wait for that real check, as an operator would, before starting anything.
    await isolationReady();
    const users = accessControlOf(app).users;
    const person = (name: string, role: "owner" | "editor" | "viewer") => {
        const u = users.create({ email: `${name.toLowerCase()}@example.com`, name, role });
        return caller(app, users.createToken(u.id, { name: "t", role }).token);
    };
    // The local owner holds every permission, the platform settings among them: never an approver.
    const close = async () => {
        await app.close();
        platform.db.close();
        if (c4t) await new Promise((r) => c4t!.close(r));
    };
    return { platform, app, close, key: caller(app, KEY), owner: person("Olga", "owner"), editor: person("Eve", "editor"), viewer: person("Vic", "viewer"), admin: c4tCaller(app, "t-admin"), subAdmin: c4tCaller(app, "t-sam") };
}

const authBody = { basis: "owner", approverName: "Dana Client", approverRole: "Head of Engineering", approverEmail: "dana@client.example", documentReference: "SOW-12", authority: "Signed SOW-12 for the application's owner.", confirm: true };
const shop = (environment: string) => ({ name: `Shop ${environment}`, targetUrl: `https://${environment}.shop.example.com/`, environment, maxRequestsPerSecond: 2 });

describe("the profile gate (SECURITY_ACTIVE_PROFILES off, the default)", () => {
    let s: Awaited<ReturnType<typeof serve>>;
    let projectId: string;
    let appId: string;
    let prodId: string;
    beforeAll(async () => {
        s = await serve({}, 9521);
        projectId = (await s.key("POST", "/api/projects", { name: "Client A" })).body.id;
        appId = (await s.editor("POST", `${API}/projects/${projectId}/applications`, shop("staging"))).body.application.id;
        prodId = (await s.editor("POST", `${API}/projects/${projectId}/applications`, shop("production"))).body.application.id;
    }, 60_000);
    afterAll(async () => {
        await s?.close();
    });

    it("a passive start is exactly as before: needs a current authorization and nothing else, and is stored as passive", async () => {
        expect((await s.editor("POST", `${API}/applications/${appId}/assessments`, {})).status).toBe(409);
        expect((await s.owner("POST", `${API}/applications/${appId}/authorizations`, authBody)).status).toBe(201);
        const r = await s.editor("POST", `${API}/applications/${appId}/assessments`, {});
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(r.body.assessment.kind).toBe("passive");
        expect(r.body.assessment.approval).toBeNull();
        await s.editor("POST", `${API}/assessments/${r.body.assessment.id}/cancel`, {});
        const explicit = await s.editor("POST", `${API}/applications/${appId}/assessments`, { kind: "passive" });
        expect(explicit.status).toBe(201);
        await s.editor("POST", `${API}/assessments/${explicit.body.assessment.id}/cancel`, {});
    });

    it("an old (passive) authorization never covers a profile above passive: refused at start", async () => {
        const auth = securityStoreFor(s.platform.db).currentAuthorization(securityStoreFor(s.platform.db).getApplication(appId)!)!;
        expect(auth.maxProfile).toBe("passive");
        expect(auth.crossAccounts).toEqual([]);
        expect(auth.statement).toMatch(/The assessment is passive/);
        const r = await s.editor("POST", `${API}/applications/${appId}/assessments`, { kind: "conservative-active" });
        expect(r.status).toBe(409);
        expect(r.body.error).toBe(GATE_WORDS.notAuthorized("Conservative active checks"));
        expect((await s.editor("POST", `${API}/applications/${appId}/assessments`, { kind: "bogus" })).status).toBe(400);
    });

    it("an authorization naming the profile still needs an approval; the approval is a Crowd4Test admin's sign-off", async () => {
        const preview = await s.viewer("GET", `${API}/applications/${appId}/authorization-statement?maxProfile=conservative-active`);
        expect(preview.status).toBe(200);
        expect(preview.body.statement).toMatch(/may run at most the Conservative active checks profile/);
        const rec = await s.owner("POST", `${API}/applications/${appId}/authorizations`, { ...authBody, maxProfile: "conservative-active" });
        expect(rec.status, JSON.stringify(rec.body)).toBe(201);
        expect(rec.body.authorization.maxProfile).toBe("conservative-active");
        expect(rec.body.authorization.statement).toBe(preview.body.statement);

        const noApproval = await s.editor("POST", `${API}/applications/${appId}/assessments`, { kind: "conservative-active" });
        expect(noApproval.status).toBe(409);
        expect(noApproval.body.error).toBe(GATE_WORDS.notApproved("Conservative active checks", "staging"));

        // An editor may not approve, nor a local owner holding the platform settings; a Crowd4Test admin may, and must tick the box.
        expect((await s.editor("POST", `${API}/applications/${appId}/approvals`, { profile: "conservative-active", confirm: true })).status).toBe(403);
        const byOwner = await s.owner("POST", `${API}/applications/${appId}/approvals`, { profile: "conservative-active", confirm: true });
        expect(byOwner.status).toBe(403);
        expect(byOwner.body.error).toBe(GATE_WORDS.onlyAdmins);
        expect((await s.admin("POST", `${API}/applications/${appId}/approvals`, { profile: "conservative-active" })).status).toBe(400);
        const ok = await s.admin("POST", `${API}/applications/${appId}/approvals`, { profile: "conservative-active", confirm: true });
        expect(ok.status, JSON.stringify(ok.body)).toBe(201);
        expect(ok.body.approval).toMatchObject({ profile: "conservative-active", environment: "staging", approvedByName: expect.stringMatching(/^Ada/), withdrawnAt: null });
        expect(ok.body.approval.statement).toMatch(/^As a Crowd4Test admin, I approve the Conservative active checks profile for “Shop staging”/);
        const list = await s.viewer("GET", `${API}/applications/${appId}/approvals`);
        expect(list.body.approvals).toHaveLength(1);
        expect(list.body.activeProfilesOn).toBe(false);

        // Authorized and approved, but the server does not allow active profiles: still refused, and nothing was created.
        const before = securityStoreFor(s.platform.db).listAssessments({ applicationId: appId }).length;
        const off = await s.editor("POST", `${API}/applications/${appId}/assessments`, { kind: "conservative-active" });
        expect(off.status).toBe(409);
        expect(off.body.error).toBe(GATE_WORDS.switchedOff);
        expect(securityStoreFor(s.platform.db).listAssessments({ applicationId: appId })).toHaveLength(before);

        // Withdrawn: the approval no longer counts (the refusal goes back to "needs an approval").
        expect((await s.editor("DELETE", `${API}/applications/${appId}/approvals/${ok.body.approval.id}`)).status).toBe(403);
        expect((await s.owner("DELETE", `${API}/applications/${appId}/approvals/${ok.body.approval.id}`)).status).toBe(403);
        expect((await s.admin("DELETE", `${API}/applications/${appId}/approvals/${ok.body.approval.id}`)).body.approval.withdrawnAt).toBeTruthy();
        expect((await s.editor("POST", `${API}/applications/${appId}/assessments`, { kind: "conservative-active" })).body.error).toBe(GATE_WORDS.notApproved("Conservative active checks", "staging"));
    });

    it("no profile above passive is ever approved or started for production", async () => {
        for (const profile of ["conservative-active", "advanced"]) {
            const r = await s.admin("POST", `${API}/applications/${prodId}/approvals`, { profile, confirm: true });
            expect(r.status).toBe(409);
            expect(r.body.error).toBe(GATE_WORDS.wrongEnvironment("production"));
        }
        await s.owner("POST", `${API}/applications/${prodId}/authorizations`, { ...authBody, maxProfile: "advanced" });
        const start = await s.editor("POST", `${API}/applications/${prodId}/assessments`, { kind: "conservative-active" });
        expect(start.status).toBe(409);
        expect(start.body.error).toBe(GATE_WORDS.wrongEnvironment("production"));
        expect((await s.viewer("GET", `${API}/applications/${prodId}/approvals`)).body.environmentAllowed).toBe(false);
    });

    it("only a Crowd4Test admin approves: not a local owner with the platform settings, not a sub-admin, not the access key", async () => {
        expect((await s.admin("GET", `${API}/applications/${appId}/approvals`)).body.mayApprove).toBe(true);
        const byOwner = await s.owner("GET", `${API}/applications/${appId}/approvals`);
        expect(byOwner.body).toMatchObject({ mayApprove: false, approveRefusal: GATE_WORDS.onlyAdmins });
        expect((await s.viewer("GET", `${API}/applications/${appId}/approvals`)).body.mayApprove).toBe(false);
        // The sub-admin is a Project Admin of this project (so the refusal below is the approver rule, not visibility) and holds every permission.
        const samId = (await s.subAdmin("GET", "/api/auth/state")).body.me.id as string;
        accessControlOf(s.app).projects.store.addMember(projectId, samId, { role: "owner", projectAdmin: true, source: "added", addedBy: null });
        const subList = await s.subAdmin("GET", `${API}/applications/${appId}/approvals`);
        expect(subList.body.mayApprove, JSON.stringify(subList)).toBe(false);
        const bySub = await s.subAdmin("POST", `${API}/applications/${appId}/approvals`, { profile: "conservative-active", confirm: true });
        expect(bySub.status).toBe(403);
        expect(bySub.body.error).toBe(GATE_WORDS.onlyAdmins);
        // The shared access key is no person: never an approver.
        const byKey = await s.key("POST", `${API}/applications/${appId}/approvals`, { profile: "conservative-active", confirm: true });
        expect(byKey.status).toBe(403);
        expect(byKey.body.error).toBe(GATE_WORDS.onlyAdmins);
    });

    it("cross-account accounts: two different known test accounts, named in the sentence", async () => {
        expect((await s.owner("POST", `${API}/applications/${appId}/authorizations`, { ...authBody, crossAccounts: ["main"] })).status).toBe(400);
        expect((await s.owner("POST", `${API}/applications/${appId}/authorizations`, { ...authBody, crossAccounts: ["main", "main"] })).status).toBe(400);
        const unknown = await s.owner("POST", `${API}/applications/${appId}/authorizations`, { ...authBody, crossAccounts: ["main", "nobody"] });
        expect(unknown.status).toBe(400);
        expect(unknown.body.error).toMatch(/no test account named “nobody”/);
        const preview = await s.viewer("GET", `${API}/applications/${appId}/authorization-statement?crossAccounts=alice,bob`);
        expect(preview.body.statement).toMatch(/signs in, read-only, as the test account “alice” and the test account “bob”/);
        expect(preview.body.statement).toMatch(/The assessment is passive/);
    });

    it("another project cannot read or approve this application's profile", async () => {
        const other = (await s.key("POST", "/api/projects", { name: "Client B" })).body.id;
        expect((await s.key("GET", `${API}/applications/${appId}/approvals?projectId=${other}`)).status).toBe(404);
    });

    it("the store and the start check the approver again: an approval whose approver is no longer a Crowd4Test admin does not count", async () => {
        await s.owner("POST", `${API}/applications/${appId}/authorizations`, { ...authBody, maxProfile: "conservative-active" });
        const ok = await s.admin("POST", `${API}/applications/${appId}/approvals`, { profile: "conservative-active", confirm: true });
        expect(ok.status, JSON.stringify(ok.body)).toBe(201);
        // Approved: the refusal is the server switch, not the approval.
        expect((await s.editor("POST", `${API}/applications/${appId}/assessments`, { kind: "conservative-active" })).body.error).toBe(GATE_WORDS.switchedOff);
        const adminId = ok.body.approval.approvedByUserId as string;
        s.platform.db.run("UPDATE users SET c4t_role = 'SUB_ADMIN' WHERE id = ?", adminId);
        try {
            expect((await s.editor("POST", `${API}/applications/${appId}/assessments`, { kind: "conservative-active" })).body.error).toBe(GATE_WORDS.notApproved("Conservative active checks", "staging"));
            // The store itself refuses a non-admin approver, whatever a caller passes.
            const ownerId = s.platform.db.get<{ id: string }>("SELECT id FROM users WHERE email = ?", "olga@example.com")!.id;
            expect(() => addApproval(s.platform.db, appId, { profile: "conservative-active", environment: "staging", statement: "x", byUserId: ownerId, byName: "Olga" })).toThrow(GATE_WORDS.onlyAdmins);
        } finally {
            s.platform.db.run("UPDATE users SET c4t_role = 'ADMIN' WHERE id = ?", adminId);
        }
    });

    it("the routes' permissions: reading is reading, approving is a sign-off", () => {
        expect(permissionRuleFor("GET", "/api/v1/security/applications/:appId/authorization-statement")).toBe("read");
        expect(permissionRuleFor("GET", "/api/v1/security/applications/:appId/approvals")).toBe("read");
        expect(permissionRuleFor("POST", "/api/v1/security/applications/:appId/approvals")).toBe("ai_studio.tests.approve");
        expect(permissionRuleFor("DELETE", "/api/v1/security/applications/:appId/approvals/:approvalId")).toBe("ai_studio.tests.approve");
    });
});

describe("the profile gate with SECURITY_ACTIVE_PROFILES on (an operator's explicit choice)", () => {
    it("an authorized and approved profile starts, stored with its approval; nothing else changes", async () => {
        const s = await serve({ SECURITY_ACTIVE_PROFILES: "on" }, 9522);
        try {
            const projectId = (await s.key("POST", "/api/projects", { name: "Client" })).body.id;
            const appId = (await s.editor("POST", `${API}/projects/${projectId}/applications`, shop("staging"))).body.application.id;
            await s.owner("POST", `${API}/applications/${appId}/authorizations`, { ...authBody, maxProfile: "conservative-active" });
            expect((await s.editor("POST", `${API}/applications/${appId}/assessments`, { kind: "advanced" })).body.error).toMatch(/client's current authorization does not allow the Advanced assessment/);
            expect((await s.editor("POST", `${API}/applications/${appId}/assessments`, { kind: "conservative-active" })).body.error).toBe(GATE_WORDS.notApproved("Conservative active checks", "staging"));
            expect((await s.admin("POST", `${API}/applications/${appId}/approvals`, { profile: "conservative-active", confirm: true })).status).toBe(201);
            const r = await s.editor("POST", `${API}/applications/${appId}/assessments`, { kind: "conservative-active" });
            expect(r.status, JSON.stringify(r.body)).toBe(201);
            expect(r.body.assessment.kind).toBe("conservative-active");
            expect(r.body.assessment.approval).toMatchObject({ profile: "conservative-active", environment: "staging", approvedByName: expect.stringMatching(/^Ada/) });
        } finally {
            await s.close();
        }
    });
});

describe("without Crowd4Test sign-in nobody can approve (no platform-settings fallback)", () => {
    it("a local owner holding the platform settings is refused with the plain sentence, and an active profile cannot start", async () => {
        const s = await serve({ SECURITY_ACTIVE_PROFILES: "on" });
        try {
            const projectId = (await s.key("POST", "/api/projects", { name: "Client" })).body.id;
            const appId = (await s.editor("POST", `${API}/projects/${projectId}/applications`, shop("staging"))).body.application.id;
            await s.owner("POST", `${API}/applications/${appId}/authorizations`, { ...authBody, maxProfile: "conservative-active" });
            expect((await s.owner("GET", `${API}/applications/${appId}/approvals`)).body).toMatchObject({ mayApprove: false, approveRefusal: GATE_WORDS.noCrowd4Test });
            for (const who of [s.owner, s.key]) {
                const r = await who("POST", `${API}/applications/${appId}/approvals`, { profile: "conservative-active", confirm: true });
                expect(r.status).toBe(403);
                expect(r.body.error).toBe(GATE_WORDS.noCrowd4Test);
            }
            const start = await s.editor("POST", `${API}/applications/${appId}/assessments`, { kind: "conservative-active" });
            expect(start.status).toBe(409);
            expect(start.body.error).toBe(GATE_WORDS.noCrowd4Test);
            // Passive is untouched.
            expect((await s.editor("POST", `${API}/applications/${appId}/assessments`, {})).status).toBe(201);
        } finally {
            await s.close();
        }
    });
});

afterAll(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
