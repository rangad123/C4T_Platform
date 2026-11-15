/**
 * The cross-account settings through the real platform server (Fastify inject, no network, no browser, no assessment): the round trip the
 * settings card makes (save, read back with readiness, change, remove) and who may do it, enforced by the server per role.
 *
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/security-cross-account-settings.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { IdentityStore } from "../src/platform/identity-store.js";
import { SecretBox } from "../src/platform/secrets.js";
import { buildServer } from "../src/platform/server.js";

const KEY = "sec-xacct-settings-key-0123456789";
const API = "/api/v1/security";
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

const DESIGNATION = {
    accountA: "alice",
    accountB: "bob",
    resources: [
        { path: "/api/notes/50123", kind: "item", owner: "B", label: "Bob's note" },
        { path: "/api/notes", kind: "list", owner: "B" },
    ],
    ownerField: "ownerId",
    ownerValueA: "user-a",
    ownerValueB: "user-b",
};
const stateFor = (value: string) => ({ cookies: [{ name: "sid", value, domain: "staging.notes.example.com", path: "/", expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] });

let dir: string;
let platform: Platform;
let app: FastifyInstance;
let owner: Call, editor: Call, viewer: Call, key: Call;
let projectId: string;
let appId: string;

beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-xacct-settings-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY } as never));
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
    projectId = (await key("POST", "/api/projects", { name: "Notes client" })).body.id;
    new IdentityStore(platform.db, new SecretBox(platform.config.dataDir, platform.config.SECRET_KEY)).set(projectId, [
        { name: "alice", username: "alice@example.test", password: "never-typed-1" },
        { name: "bob", username: "bob@example.test", password: "never-typed-2" },
    ]);
    appId = (await editor("POST", `${API}/projects/${projectId}/applications`, { name: "Notes (staging)", targetUrl: "https://staging.notes.example.com/", environment: "staging", maxRequestsPerSecond: 2 })).body.application.id;
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close?.();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("the cross-account settings (routes)", () => {
    it("round trip: nothing set, saved by an editor, read back with readiness, changed by an owner, removed", async () => {
        const empty = await viewer("GET", `${API}/applications/${appId}/cross-account`);
        expect(empty.status).toBe(200);
        expect(empty.body).toMatchObject({ designation: null, ready: { ok: false } });

        const saved = await editor("PUT", `${API}/applications/${appId}/cross-account`, DESIGNATION);
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        expect(saved.body.designation).toEqual(DESIGNATION);
        // No saved sign-in yet for either account: both named as problems, in words.
        expect(saved.body.ready.ok).toBe(false);
        expect(saved.body.ready.problems.join(" ")).toMatch(/Account A .*alice/);
        expect(saved.body.ready.problems.join(" ")).toMatch(/Account B .*bob/);

        for (const [account, value] of [["alice", "alice-cookie-4471"], ["bob", "bob-cookie-9902"]] as const) {
            expect((await editor("PUT", `${API}/applications/${appId}/saved-sign-in`, { account, storageState: stateFor(value) })).status).toBe(200);
        }
        const read = await viewer("GET", `${API}/applications/${appId}/cross-account`);
        expect(read.status).toBe(200);
        expect(read.body.designation).toEqual(DESIGNATION);
        expect(read.body.ready).toEqual({ ok: true, problems: [] });
        expect(JSON.stringify(read.body)).not.toContain("cookie-");

        const changed = { accountA: "bob", accountB: "alice", resources: [{ path: "/api/notes/40111", kind: "item", owner: "B" }] };
        const c = await owner("PUT", `${API}/applications/${appId}/cross-account`, changed);
        expect(c.status, JSON.stringify(c.body)).toBe(200);
        expect((await viewer("GET", `${API}/applications/${appId}/cross-account`)).body.designation).toEqual(changed);

        const activity = await viewer("GET", `${API}/projects/${projectId}/activity?limit=100`);
        expect(JSON.stringify(activity.body)).toContain("Set the read-only cross-account check of “Notes (staging)”");

        const del = await editor("DELETE", `${API}/applications/${appId}/cross-account`);
        expect(del.status).toBe(200);
        expect(del.body).toEqual({ deleted: true });
        expect((await viewer("GET", `${API}/applications/${appId}/cross-account`)).body.designation).toBeNull();
    });

    it("refuses a viewer's change and removal on the server, and changes nothing", async () => {
        expect((await editor("PUT", `${API}/applications/${appId}/cross-account`, DESIGNATION)).status).toBe(200);
        const put = await viewer("PUT", `${API}/applications/${appId}/cross-account`, { ...DESIGNATION, accountA: "main" });
        expect(put.status).toBe(403);
        const del = await viewer("DELETE", `${API}/applications/${appId}/cross-account`);
        expect(del.status).toBe(403);
        expect((await viewer("GET", `${API}/applications/${appId}/cross-account`)).body.designation).toEqual(DESIGNATION);
    });

    it("refuses what the form cannot prevent: the same account twice, an unknown account, an address outside the scope", async () => {
        expect((await editor("PUT", `${API}/applications/${appId}/cross-account`, { ...DESIGNATION, accountB: "alice" })).body.error).toMatch(/two different test accounts/);
        expect((await editor("PUT", `${API}/applications/${appId}/cross-account`, { ...DESIGNATION, accountB: "carol" })).body.error).toMatch(/no test account named “carol”/);
        const r = await editor("PUT", `${API}/applications/${appId}/cross-account`, { ...DESIGNATION, resources: [{ path: "/logout", kind: "item", owner: "B" }] });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/sign-out/);
    });
});
