/**
 * Read-only cross-account checks, really executed: a real Chromium (the assessment's discovery) and real HTTP against a local notes app
 * this test owns (two users, alice and bob; some addresses check the owner, others deliberately do not), through the platform's routes
 * and the passive assessment loop.
 *
 * Proves: the designation's rules (non-production only, known accounts, in scope, no sign-out, no GraphQL mutation); B's item, nested item
 * and list read by A are findings in the existing security findings (category access-control) and the protected, own, shared and public
 * ones are not; findings keep none of bob's data and no sign-in value; the app received only GET/HEAD/OPTIONS; the guard itself refuses a
 * write; an application without a designation gets no cross-account step (passive assessments unchanged); another project cannot read it.
 *
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/security-cross-account.test.ts
 */
import fs from "node:fs";
import http from "node:http";
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
import { guardFor } from "../src/security/assessment/guard.js";
import { AssessmentLoop, type RunnerDeps } from "../src/security/assessment/runner.js";
import { loopDeps } from "../src/security/routes/assessments.js";
import { securitySettings } from "../src/security/settings.js";
import { SecurityStore } from "../src/security/store.js";

const API = "/api/v1/security";
const PORT = 9501;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SESSIONS: Record<string, string> = { "alice-session-cookie-4471": "user-alice-11", "bob-session-cookie-9902": "user-bob-77" };
const NOTES = [
    { id: 40111, ownerId: "user-alice-11", title: "Alice shopping list", body: "Milk, bread and tomatoes", sharedWith: [] as string[] },
    { id: 50123, ownerId: "user-bob-77", title: "Bob quarterly salary review", body: "Confidential raise approved for March", sharedWith: [] as string[] },
    { id: 70001, ownerId: "user-bob-77", title: "Team offsite agenda", body: "Room booked on the third floor", sharedWith: ["user-alice-11"] },
];
const BOB_SECRETS = ["Bob quarterly salary review", "Confidential raise approved for March"];
const received: Array<{ method: string; url: string }> = [];

function fixtureApp(): http.Server {
    return http.createServer((req, res) => {
        received.push({ method: req.method ?? "", url: req.url ?? "" });
        const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
        const me = sid ? SESSIONS[sid] : undefined;
        const send = (status: number, body: unknown, type = "application/json") => {
            res.writeHead(status, { "content-type": type });
            res.end(typeof body === "string" ? body : JSON.stringify(body));
        };
        const u = new URL(req.url ?? "/", ORIGIN);
        if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") return send(405, { error: "read-only fixture" });
        if (u.pathname === "/") return send(200, `<!doctype html><title>Notes</title><h1>Notes</h1>${me ? "<p>Signed in</p>" : '<a href="/login">Sign in</a>'}`, "text/html");
        if (u.pathname === "/login") return send(200, "<!doctype html><title>Sign in</title><form method=post><input type=password name=p></form>", "text/html");
        if (u.pathname === "/api/public/info") return send(200, { app: "Notes service", version: "release-2026-11" });
        if (!me) return send(401, { error: "Sign in first" });
        const note = (id: string) => NOTES.find((n) => String(n.id) === id);
        let m: RegExpExecArray | null;
        // Deliberately broken: any signed-in user reads any note, its comments and the whole list.
        if ((m = /^\/api\/notes\/(\d+)$/.exec(u.pathname))) return note(m[1]!) ? send(200, note(m[1]!)) : send(404, { error: "No such note" });
        if ((m = /^\/api\/notes\/(\d+)\/comments\/(\d+)$/.exec(u.pathname))) {
            const n = note(m[1]!);
            return n ? send(200, { id: Number(m[2]), noteId: n.id, author: n.ownerId, text: `Comment on ${n.title}` }) : send(404, {});
        }
        if (u.pathname === "/api/notes") return send(200, { items: NOTES });
        // Correct: the owner (or someone it is shared with) only.
        if ((m = /^\/api\/secure\/notes\/(\d+)$/.exec(u.pathname))) {
            const n = note(m[1]!);
            return n && (n.ownerId === me || n.sharedWith.includes(me)) ? send(200, n) : send(404, { error: "No such note" });
        }
        if (u.pathname === "/api/my-notes") return send(200, { items: NOTES.filter((n) => n.ownerId === me) });
        return send(404, { error: "Not found" });
    });
}

type Inject = Awaited<ReturnType<typeof buildServer>>;
let dir: string;
let platform: Platform;
let server: Inject;
let fixture: http.Server;
let store: SecurityStore;
let projectId: string;
let otherProjectId: string;
let appId: string;
let plainAppId: string;
let deps: RunnerDeps;
let run: SecurityAssessment;
const launched: Browser[] = [];

async function api(method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: unknown) {
    const r = await server.inject({ method, url, ...(body !== undefined ? { payload: body as object } : {}) });
    let json: any;
    try {
        json = r.json();
    } catch {
        json = undefined;
    }
    return { status: r.statusCode, json };
}

async function assess(id: string): Promise<SecurityAssessment> {
    const started = await api("POST", `${API}/applications/${id}/assessments`, {});
    expect(started.status, JSON.stringify(started.json)).toBe(201);
    const aid = started.json.assessment.id as string;
    const loop = new AssessmentLoop(deps, 100);
    loop.start();
    try {
        const end = Date.now() + 150_000;
        for (;;) {
            const a = store.getAssessment(aid)!;
            if (FINISHED_STATES.includes(a.state)) return a;
            if (Date.now() > end) throw new Error("assessment did not finish");
            await new Promise((r) => setTimeout(r, 150));
        }
    } finally {
        await loop.stop();
    }
}

const stateFor = (value: string) => ({ cookies: [{ name: "sid", value, domain: "127.0.0.1", path: "/", expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] });
const DESIGNATION = {
    accountA: "alice",
    accountB: "bob",
    ownerField: "ownerId",
    ownerValueA: "user-alice-11",
    ownerValueB: "user-bob-77",
    resources: [
        { path: "/api/notes/40111", kind: "item", owner: "A", label: "Alice's note" },
        { path: "/api/public/info", kind: "item", owner: "public" },
        { path: "/api/notes/70001", kind: "item", owner: "shared" },
        { path: "/api/notes/50123", kind: "item", owner: "B", label: "Bob's private note" },
        { path: "/api/notes/50123/comments/88001", kind: "nested", owner: "B" },
        { path: "/api/notes", kind: "list", owner: "B" },
        { path: "/api/secure/notes/50123", kind: "item", owner: "B" },
        { path: "/api/my-notes", kind: "list", owner: "B" },
    ],
};

beforeAll(async () => {
    fixture = fixtureApp();
    await new Promise<void>((r) => fixture.listen(PORT, "127.0.0.1", () => r()));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-xacct-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", WORKER_EMBEDDED: "false", SECURITY_ALLOW_PRIVATE_TARGETS: "true" }));
    server = await buildServer(platform);
    store = new SecurityStore(platform.db);
    projectId = platform.repo.createProject({ name: "Cross-account client" }).id as string;
    otherProjectId = platform.repo.createProject({ name: "Someone else" }).id as string;
    new IdentityStore(platform.db, new SecretBox(platform.config.dataDir, platform.config.SECRET_KEY)).set(projectId, [
        { name: "alice", username: "alice@example.test", password: "never-typed-1" },
        { name: "bob", username: "bob@example.test", password: "never-typed-2" },
    ]);
    deps = {
        ...loopDeps({ p: platform, settings: securitySettings(platform.config) }),
        limits: { maxPages: 5 },
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
    await new Promise((r) => fixture?.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("the designation (routes)", () => {
    it("is refused for a production application, unknown accounts, out-of-scope, sign-out and mutation addresses", async () => {
        const base = { targetUrl: `${ORIGIN}/`, maxRequestsPerSecond: 10 };
        const prod = await api("POST", `${API}/projects/${projectId}/applications`, { ...base, name: "Prod notes", environment: "production" });
        expect(prod.status).toBe(201);
        const refusedProd = await api("PUT", `${API}/applications/${prod.json.application.id}/cross-account`, DESIGNATION);
        expect(refusedProd.status).toBe(400);
        expect(refusedProd.json.error).toMatch(/marked “production”.*never checked/);

        const r = await api("POST", `${API}/projects/${projectId}/applications`, { ...base, name: "Notes (staging)", environment: "staging" });
        appId = r.json.application.id;
        expect((await api("PUT", `${API}/applications/${appId}/cross-account`, { ...DESIGNATION, accountB: "carol" })).json.error).toMatch(/no test account named “carol”/);
        expect((await api("PUT", `${API}/applications/${appId}/cross-account`, { ...DESIGNATION, resources: [{ path: "/logout", kind: "item", owner: "B" }] })).json.error).toMatch(/sign-out/);
        expect((await api("PUT", `${API}/applications/${appId}/cross-account`, { ...DESIGNATION, resources: [{ path: "/graphql?query=mutation%20%7Bx%7D", kind: "item", owner: "B" }] })).json.error).toMatch(/mutation/);
        expect((await api("PUT", `${API}/applications/${appId}/cross-account`, { ...DESIGNATION, resources: [{ path: "/api/notes/1", kind: "item", owner: "B", method: "DELETE" }] })).status).toBe(400);

        for (const [account, value] of [["alice", "alice-session-cookie-4471"], ["bob", "bob-session-cookie-9902"]] as const) {
            const saved = await api("PUT", `${API}/applications/${appId}/saved-sign-in`, { account, storageState: stateFor(value) });
            expect(saved.status, JSON.stringify(saved.json)).toBe(200);
        }
        const ok = await api("PUT", `${API}/applications/${appId}/cross-account`, DESIGNATION);
        expect(ok.status, JSON.stringify(ok.json)).toBe(200);
        expect(ok.json.ready.ok).toBe(true);
        expect(JSON.stringify(ok.json)).not.toContain("session-cookie");
        // 12: another project's address for it is a 404.
        expect((await api("GET", `${API}/applications/${appId}/cross-account?projectId=${otherProjectId}`)).status).toBe(404);
    });
});

let unnamed: SecurityAssessment;

describe("the assessment with the designation", () => {
    beforeAll(async () => {
        // First under an authorization that does not name the cross-account test accounts: the step is not made (profile-gate.ts).
        expect((await api("POST", `${API}/applications/${appId}/authorizations`, { basis: "owner", approverName: "Test Owner", approverRole: "Head of Engineering", approverEmail: "owner@client.example", documentReference: "SOW-1", authority: "Signed SOW-1 for the application's owner.", confirm: true })).status).toBe(201);
        unnamed = await assess(appId);
        // Then under one that names both: the step runs.
        const named = await api("POST", `${API}/applications/${appId}/authorizations`, { basis: "owner", approverName: "Test Owner", approverRole: "Head of Engineering", approverEmail: "owner@client.example", documentReference: "SOW-1", authority: "Signed SOW-1 for the application's owner.", confirm: true, crossAccounts: ["alice", "bob"] });
        expect(named.status, JSON.stringify(named.json)).toBe(201);
        expect(named.json.authorization.crossAccounts).toEqual(["alice", "bob"]);
        expect(named.json.authorization.statement).toMatch(/signs in, read-only, as the test account “alice” and the test account “bob”/);
        received.length = 0;
        run = await assess(appId);
    }, 300_000);

    it("does not make the cross-account checks under an authorization that does not name their accounts", () => {
        expect(unnamed.coverage!.notInspected.join("\n")).toMatch(/Cross-account checks were not made: the current authorization does not name the test account “alice” and the test account “bob”/);
    });

    it("reports B's item, nested item and list read by A as access-control findings, and nothing for the protected, own, shared and public ones", () => {
        expect(run.state, run.error ?? "").toMatch(/COMPLETED/);
        const findings = store.listFindings({ projectId, applicationId: appId, categories: ["access-control"] });
        const locations = findings.map((f) => f.location).sort();
        expect(findings.every((f) => f.title === "One account can read another account's data" && f.severity === "high")).toBe(true);
        // B's item, its nested comment and the whole list (the location text goes through the findings' own redaction, which can hide
        // the digits of a long numeric path).
        expect(findings).toHaveLength(3);
        expect(locations).toEqual(expect.arrayContaining([`${ORIGIN}/api/notes`, `${ORIGIN}/api/notes/50123`]));
        expect(locations.some((l) => l.includes("/api/secure") || l.includes("/api/my-notes") || l.includes("/api/public"))).toBe(false);
        const lines = run.coverage!.notInspected.join("\n");
        expect(lines).toMatch(/Cross-account \(read-only, signed in as the test account “alice”, against resources of the test account “bob”\): 8 of 8 designated resources checked; 3 readable by the test account “alice”, 0 readable signed out, 2 protected, 0 inconclusive/);
    });

    it("13: keeps none of bob's data and no sign-in value in any security table", () => {
        const dump = JSON.stringify(
            ["security_findings", "security_finding_history", "security_finding_sightings", "security_assessments", "security_audit", "security_cross_account"].map((t) => platform.db.all(`SELECT * FROM ${t}`)),
        );
        for (const s of [...BOB_SECRETS, "alice-session-cookie-4471", "bob-session-cookie-9902"]) expect(dump).not.toContain(s);
    });

    it("10/11: the app received only read requests, and the guard itself refuses a write", async () => {
        expect(received.length).toBeGreaterThan(0);
        expect(received.filter((r) => !["GET", "HEAD", "OPTIONS"].includes(r.method))).toEqual([]);
        const app = store.getApplication(appId)!;
        const g = guardFor(app, securitySettings(platform.config), new AbortController().signal);
        await expect(g.fetch(`${ORIGIN}/api/notes/50123`, { method: "POST" as "GET" })).rejects.toThrow(/Only GET, HEAD and OPTIONS/);
        expect(received.filter((r) => r.method === "POST")).toEqual([]);
    });

    it("an application without a designation gets no cross-account step (passive assessments unchanged)", async () => {
        const r = await api("POST", `${API}/projects/${projectId}/applications`, { targetUrl: `${ORIGIN}/`, maxRequestsPerSecond: 10, name: "Notes (plain)", environment: "development" });
        plainAppId = r.json.application.id;
        expect((await api("POST", `${API}/applications/${plainAppId}/authorizations`, { basis: "owner", approverName: "Test Owner", approverRole: "Head of Engineering", approverEmail: "owner@client.example", documentReference: "SOW-1", authority: "Signed SOW-1 for the application's owner.", confirm: true })).status).toBe(201);
        received.length = 0;
        const plain = await assess(plainAppId);
        expect(plain.state).toMatch(/COMPLETED/);
        expect(plain.coverage!.notInspected.join("\n")).not.toMatch(/Cross-account/);
        expect(received.some((x) => x.url.startsWith("/api/notes/50123"))).toBe(false);
    }, 200_000);
});
