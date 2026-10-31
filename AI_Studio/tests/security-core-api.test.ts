/**
 * Security Assessment, CORE through the real platform server (Fastify inject, no network, no browser): roles per route (viewer reads,
 * editor registers, owner records/revokes authorizations and deletes), plain validation messages, the authorization becoming stale,
 * revoking it stops a running assessment, tenant isolation between two projects, the audit trail AND the platform Activity (with who,
 * including a refused attempt), the testing type, and the switch: with SECURITY_ASSESSMENT=off the module answers 404 (status says off)
 * and functional testing routes are untouched.
 *
 * No ports (inject only). Run:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/security-core-api.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { AUTHORIZATION_WORDS } from "../src/security/authorization.js";
import { securityStoreFor } from "../src/security/store.js";

const KEY = "sec-core-key-0123456789";
const API = "/api/v1/security";
const dirs: string[] = [];
const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sec-api-"));
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

describe("security assessment CORE API", () => {
    let platform: Platform;
    let app: FastifyInstance;
    let key: Call;
    let owner: Call;
    let editor: Call;
    let viewer: Call;
    let pA: string;
    let pB: string;

    beforeAll(async () => {
        platform = bootstrap(loadConfig({ DATA_DIR: tmp(), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY }));
        app = await buildServer(platform);
        await app.ready();
        const users = accessControlOf(app).users;
        const person = (name: string, role: "owner" | "editor" | "viewer") => {
            const u = users.create({ email: `${name.toLowerCase()}@example.com`, name, role });
            return caller(app, users.createToken(u.id, { name: "t", role }).token);
        };
        key = caller(app, KEY);
        owner = person("Olga", "owner");
        editor = person("Eve", "editor");
        viewer = person("Vic", "viewer");
        pA = (await key("POST", "/api/projects", { name: "Client A" })).body.id;
        pB = (await key("POST", "/api/projects", { name: "Client B" })).body.id;
    }, 60_000);
    afterAll(async () => {
        await app?.close();
        platform?.db.close();
        for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    });

    const shop = { name: "Shop", targetUrl: "https://shop.example.com/#top", environment: "staging", scope: ["https://API.example.com", "*.cdn.example.net"], excludedPaths: ["/admin/billing"], maxRequestsPerSecond: 3, notes: "Main site" };
    const authBody = { basis: "client-permission", approverName: "Dana Client", approverEmail: "dana@client.example", documentReference: "SOW-12", restrictions: "Weekdays only", confirm: true };

    it("says it is on, with its limits", async () => {
        const r = await viewer("GET", `${API}/status`);
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ enabled: true, limits: expect.objectContaining({ maxRequestsPerSecond: { min: 1, max: 10, default: 2 }, maxRequestsPerAssessment: 2000, retentionDays: 365, privateTargetsAllowed: false, assessmentMinutes: 30 }) });
    });

    let appId: string;
    it("registers an application (editor), normalized, and refuses viewers", async () => {
        expect((await viewer("POST", `${API}/projects/${pA}/applications`, shop)).status).toBe(403);
        const r = await editor("POST", `${API}/projects/${pA}/applications`, shop);
        expect(r.status).toBe(201);
        appId = r.body.application.id;
        expect(r.body.application).toMatchObject({ projectId: pA, targetUrl: "https://shop.example.com/", scope: ["https://api.example.com", "*.cdn.example.net"], excludedPaths: ["/admin/billing"], maxRequestsPerSecond: 3, notes: "Main site", apiSpecUrl: null, activeAssessmentId: null });
        expect(r.body.authorization).toEqual({ state: "none", message: AUTHORIZATION_WORDS.none, authorizationId: null });
        expect(r.body.statement).toMatch(/^I confirm that Client A owns https:\/\/shop\.example\.com\/ or that its owner has given documented permission to assess it, within the scope listed\./);
        const list = await viewer("GET", `${API}/projects/${pA}/applications`);
        expect(list.body.applications.map((a: { id: string }) => a.id)).toEqual([appId]);
    });

    it("says in plain words what is wrong with an application", async () => {
        const bad = async (patch: Record<string, unknown>) => (await editor("POST", `${API}/projects/${pA}/applications`, { ...shop, ...patch })).body.error as string;
        expect(await bad({ targetUrl: "not a url" })).toMatch(/not a web address/);
        expect(await bad({ targetUrl: "ftp://shop.example.com/" })).toMatch(/http:\/\/ or https:\/\//);
        expect(await bad({ targetUrl: "https://user:pw@shop.example.com/" })).toMatch(/user name and password/);
        expect(await bad({ targetUrl: "http://169.254.169.254/latest/" })).toMatch(/metadata/);
        expect(await bad({ targetUrl: "http://127.0.0.1:3000/" })).toMatch(/SECURITY_ALLOW_PRIVATE_TARGETS/);
        expect(await bad({ scope: ["https://api.example.com/v1"] })).toMatch(/without a path/);
        expect(await bad({ scope: ["*.com"] })).toMatch(/two name parts/);
        expect(await bad({ scope: ["10.0.0.0"] })).toMatch(/private or local/);
        expect(await bad({ scope: ["metadata.google.internal"] })).toMatch(/metadata/);
        expect(await bad({ excludedPaths: ["admin"] })).toMatch(/starts with \//);
        expect(await bad({ maxRequestsPerSecond: 50 })).toMatch(/at most 10/);
        expect(await bad({ environment: "prod" })).toMatch(/Choose the environment/);
        expect(await bad({ name: "" })).toMatch(/name/);
        expect((await editor("POST", `${API}/projects/${pA}/applications`, { ...shop, extra: 1 })).status).toBe(400);
        expect((await editor("POST", `${API}/projects/no-such/applications`, shop)).status).toBe(404);
    });

    it("records the client authorization (owner only, with the box ticked) and shows it", async () => {
        expect((await editor("POST", `${API}/applications/${appId}/authorizations`, authBody)).status).toBe(403);
        expect((await owner("POST", `${API}/applications/${appId}/authorizations`, { ...authBody, confirm: false })).body.error).toBe("Tick the box to confirm the statement.");
        expect((await owner("POST", `${API}/applications/${appId}/authorizations`, { ...authBody, approverEmail: "nope" })).body.error).toMatch(/email address does not look right/);
        const r = await owner("POST", `${API}/applications/${appId}/authorizations`, authBody);
        expect(r.status).toBe(201);
        expect(r.body.authorization).toMatchObject({ applicationId: appId, basis: "client-permission", approverName: "Dana Client", approverEmail: "dana@client.example", documentReference: "SOW-12", restrictions: "Weekdays only", confirmedByName: "Olga", revokedAt: null });
        expect(r.body.authorization.confirmedByUserId).toBeTruthy();
        expect(r.body.authorization.statement).toMatch(/Client A owns https:\/\/shop\.example\.com\/.*Also in scope: https:\/\/api\.example\.com, \*\.cdn\.example\.net\. Never requested: \/admin\/billing\./);
        expect(r.body.state.state).toBe("current");
        const got = await viewer("GET", `${API}/applications/${appId}`);
        expect(got.body).toMatchObject({ authorization: { state: "current" }, currentAuthorization: { id: r.body.authorization.id } });
        const list = await viewer("GET", `${API}/applications/${appId}/authorizations`);
        expect(list.body.authorizations).toHaveLength(1);
    });

    it("keeps the authorization through a rename, makes it stale when the scope changes", async () => {
        const renamed = await editor("PATCH", `${API}/applications/${appId}`, { name: "Shop (EU)", notes: null });
        expect(renamed.status).toBe(200);
        expect(renamed.body).toMatchObject({ application: { name: "Shop (EU)", notes: null }, authorization: { state: "current" }, changed: ["name", "notes"] });
        const scoped = await editor("PATCH", `${API}/applications/${appId}`, { excludedPaths: ["/admin/billing", "/checkout"] });
        expect(scoped.body.authorization).toEqual({ state: "stale", message: AUTHORIZATION_WORDS.stale, authorizationId: expect.any(String) });
        expect(scoped.body.application.authorization.state).toBe("stale");
        // Recording again makes it current; the old one is kept, revoked as replaced.
        const again = await owner("POST", `${API}/applications/${appId}/authorizations`, { ...authBody, basis: "owner" });
        expect(again.body.state.state).toBe("current");
        const list = await viewer("GET", `${API}/applications/${appId}/authorizations`);
        expect(list.body.authorizations.map((a: { revokedAt: string | null }) => a.revokedAt === null)).toEqual([true, false]);
    });

    it("revoking asks a running assessment to stop; scope changes and deletion wait for it", async () => {
        const store = securityStoreFor(platform.db);
        const current = store.currentAuthorization(store.getApplication(appId)!)!;
        const running = store.createAssessment({ applicationId: appId, authorizationId: current.id, startedBy: "Eve" });
        expect((await editor("PATCH", `${API}/applications/${appId}`, { maxRequestsPerSecond: 4 })).status).toBe(409);
        expect((await owner("DELETE", `${API}/applications/${appId}`)).status).toBe(409);
        // A name change is fine while it runs.
        expect((await editor("PATCH", `${API}/applications/${appId}`, { name: "Shop" })).status).toBe(200);
        expect((await editor("DELETE", `${API}/authorizations/${current.id}`)).status).toBe(403);
        const r = await owner("DELETE", `${API}/authorizations/${current.id}`);
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ authorization: { id: current.id, revokedBy: "Olga" }, state: { state: "revoked", message: AUTHORIZATION_WORDS.revoked }, stoppedAssessmentId: running.id });
        expect(store.cancelRequested(running.id)).toBe(true);
        // Revoking twice changes nothing.
        expect((await owner("DELETE", `${API}/authorizations/${current.id}`)).body.stoppedAssessmentId).toBeNull();
        store.updateAssessment(running.id, { state: "CANCELLED", finishedAt: new Date().toISOString() });
    });

    let appB: string;
    it("keeps projects apart: a second project cannot see or touch the first one's objects", async () => {
        appB = (await editor("POST", `${API}/projects/${pB}/applications`, { ...shop, name: "B site", targetUrl: "https://b.example.com/" })).body.application.id;
        expect((await viewer("GET", `${API}/projects/${pB}/applications`)).body.applications.map((a: { id: string }) => a.id)).toEqual([appB]);
        // Addressed through the other project, every object is "not found".
        const authA = securityStoreFor(platform.db).listAuthorizations(appId)[0]!;
        expect((await viewer("GET", `${API}/applications/${appId}?projectId=${pB}`)).status).toBe(404);
        expect((await editor("PATCH", `${API}/applications/${appId}?projectId=${pB}`, { name: "Taken" })).status).toBe(404);
        expect((await viewer("GET", `${API}/applications/${appId}/authorizations?projectId=${pB}`)).status).toBe(404);
        expect((await owner("POST", `${API}/applications/${appId}/authorizations?projectId=${pB}`, authBody)).status).toBe(404);
        expect((await owner("DELETE", `${API}/authorizations/${authA.id}?projectId=${pB}`)).status).toBe(404);
        expect((await owner("DELETE", `${API}/applications/${appId}?projectId=${pB}`)).status).toBe(404);
        expect((await viewer("GET", `${API}/applications/${appId}?projectId=${pA}`)).status).toBe(200);
        // Unknown ids are 404 too.
        expect((await viewer("GET", `${API}/applications/nope`)).status).toBe(404);
        expect((await owner("DELETE", `${API}/authorizations/nope`)).status).toBe(404);
        // Each project's activity lists its own events only.
        const actB = (await viewer("GET", `${API}/projects/${pB}/activity`)).body.events as Array<{ applicationId: string | null }>;
        expect(actB.length).toBeGreaterThan(0);
        expect(actB.every((e) => e.applicationId === appB)).toBe(true);
        expect((await viewer("GET", `${API}/applications/${appId}`)).body.application.name).toBe("Shop");
    });

    it("records every change in the security trail and in Activity, with who; refused attempts too", async () => {
        const events = (await viewer("GET", `${API}/projects/${pA}/activity?limit=50`)).body.events as Array<{ action: string; actor: { name: string }; summary: string }>;
        const seen = events.map((e) => `${e.actor.name}: ${e.action}`).reverse();
        expect(seen).toEqual([
            "Eve: application.created",
            "Olga: authorization.recorded",
            "Eve: application.changed",
            "Eve: application.changed",
            "Olga: authorization.recorded",
            "Eve: application.changed",
            "Olga: authorization.revoked",
        ]);
        expect(events.find((e) => e.action === "authorization.revoked")!.summary).toBe("Revoked the authorization to assess “Shop”. The running assessment was asked to stop.");
        expect(events.find((e) => e.action === "application.created")!.summary).toBe("Added the application “Shop” (https://shop.example.com/, staging) to “Client A”.");
        // No approver email in a summary.
        expect(JSON.stringify(events)).not.toContain("dana@client.example");

        const activity = (await key("GET", "/api/activity?limit=200")).body as { activity?: unknown[] } | unknown[];
        const rows = (Array.isArray(activity) ? activity : ((activity as { activity?: unknown[]; rows?: unknown[] }).activity ?? (activity as { rows?: unknown[] }).rows ?? [])) as Array<{ action: string; projectId: string | null; actor: { name: string }; status: number | null; detail: string | null }>;
        const security = rows.filter((r) => r.action.startsWith("security:"));
        expect(security.filter((r) => r.projectId === pA)).toHaveLength(7);
        expect(security.find((r) => r.action === "security:authorization.recorded")).toMatchObject({ actor: { name: "Olga" }, projectId: pA, detail: expect.stringContaining("approved by Dana Client") });
        // The generic "METHOD /route" line is not written for audited changes, only for refused ones (with the status).
        const generic = rows.filter((r) => r.action.includes("/api/v1/security/"));
        expect(generic.length).toBeGreaterThan(0);
        // ... or for a call that changed nothing (revoking an authorization that was already revoked).
        expect(generic.filter((r) => r.status === null || r.status < 400).map((r) => r.action)).toEqual(["DELETE /api/v1/security/authorizations/:authId"]);
        expect(generic.find((r) => r.action === "POST /api/v1/security/projects/:id/applications" && r.status === 403)).toMatchObject({ actor: { name: "Vic" }, projectId: pA });
    });

    it("stores the project's testing type (functional until set; editor changes it; audited)", async () => {
        expect((await viewer("GET", `${API}/projects/${pA}/testing-type`)).body).toEqual({ testingType: "functional" });
        expect((await viewer("PUT", `${API}/projects/${pA}/testing-type`, { testingType: "both" })).status).toBe(403);
        expect((await editor("PUT", `${API}/projects/${pA}/testing-type`, { testingType: "everything" })).body.error).toBe("Choose functional, security or both.");
        expect((await editor("PUT", `${API}/projects/${pA}/testing-type`, { testingType: "both" })).body).toEqual({ testingType: "both" });
        expect((await viewer("GET", `${API}/projects/${pA}/testing-type`)).body).toEqual({ testingType: "both" });
        expect((await viewer("GET", `${API}/projects/${pB}/testing-type`)).body).toEqual({ testingType: "functional" });
        expect((await viewer("GET", `${API}/projects/nope/testing-type`)).status).toBe(404);
        const [last] = (await viewer("GET", `${API}/projects/${pA}/activity?limit=1`)).body.events;
        expect(last).toMatchObject({ action: "testing-type.changed", actor: { name: "Eve" }, summary: "Set the testing type of “Client A” to functional testing and security assessment (was functional testing)." });
    });

    it("deletes an application (owner) with what belongs to it, and says so in the trail", async () => {
        expect((await editor("DELETE", `${API}/applications/${appB}`)).status).toBe(403);
        expect((await owner("DELETE", `${API}/applications/${appB}`)).body).toEqual({ deleted: true });
        expect((await viewer("GET", `${API}/applications/${appB}`)).status).toBe(404);
        const [last] = (await viewer("GET", `${API}/projects/${pB}/activity?limit=1`)).body.events;
        expect(last).toMatchObject({ action: "application.deleted", actor: { name: "Olga" }, summary: "Deleted the application “B site” (https://b.example.com/) with its authorizations, assessments and 0 findings." });
    });

    it("needs a credential like every other route", async () => {
        const r = await app.inject({ method: "GET", url: `${API}/status` });
        expect(r.statusCode).toBe(401);
    });
});

describe("the switch: SECURITY_ASSESSMENT=off", () => {
    let platform: Platform;
    let app: FastifyInstance;
    let key: Call;
    beforeAll(async () => {
        platform = bootstrap(loadConfig({ DATA_DIR: tmp(), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECURITY_ASSESSMENT: "off" }));
        app = await buildServer(platform);
        await app.ready();
        key = caller(app, KEY);
    }, 60_000);
    afterAll(async () => {
        await app?.close();
        platform?.db.close();
    });

    it("answers 404 everywhere but the status, which says off; functional testing is untouched", async () => {
        expect((await key("GET", `${API}/status`)).body).toMatchObject({ enabled: false });
        const p = await key("POST", "/api/projects", { name: "Functional only" });
        expect(p.status).toBe(201);
        expect((await key("GET", "/api/projects")).body.map((x: { id: string }) => x.id)).toContain(p.body.id);
        expect((await key("GET", `/api/projects/${p.body.id}`)).status).toBe(200);
        for (const [m, u, b] of [
            ["GET", `${API}/projects/${p.body.id}/applications`],
            ["POST", `${API}/projects/${p.body.id}/applications`, { name: "x", targetUrl: "https://x.example.com/", environment: "other" }],
            ["GET", `${API}/projects/${p.body.id}/activity`],
            ["GET", `${API}/projects/${p.body.id}/testing-type`],
            ["PUT", `${API}/projects/${p.body.id}/testing-type`, { testingType: "both" }],
            ["GET", `${API}/applications/whatever`],
        ] as Array<[string, string, unknown?]>) {
            const r = await key(m, u, b);
            expect(r.status, `${m} ${u}`).toBe(404);
        }
        expect(securityStoreFor(platform.db).listApplications(p.body.id)).toEqual([]);
    });
});
