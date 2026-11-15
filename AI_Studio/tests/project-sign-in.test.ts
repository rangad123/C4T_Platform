/**
 * The project's sign-in (routes/project-sign-in.ts), against a stand-in Crowd4Test sign-in (port 9790): any project kind (code, agent,
 * both) saves a user name, password and authenticator secret; the answer never carries a secret; secrets are kept when left out and
 * removed with `clear`; what is saved is what runs read for {{credentials.*}} (the latest application row) and what the Requirements
 * tab's "What the agents need" shows and explores with (one value, not two); refusals are plain sentences; reading needs project
 * access and saving needs the project-settings permission.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { startHeartbeat } from "../src/platform/ops/heartbeat.js";
import { agentInputsStoreOf } from "../src/platform/routes/agent-inputs.js";
import { buildServer } from "../src/platform/server.js";

type App = Awaited<ReturnType<typeof buildServer>>;
const PAGE = { "x-requested-with": "ai-studio" };
const API_PORT = 9790;
const SITE = "https://shop.example/";
/** Distinct, greppable values: none may appear in any answer. */
const S = { password: "PSIGNIN-Password-4e81c2", totp: "JBSWY3DPEHPK3PXP", newPassword: "PSIGNIN-NewPw-0e3aa9" };

const me = (id: string, permissions: readonly string[], organisationId: string) => ({
    data: { user: { id, email: `${id}@people.example`, role: "CUSTOMER", status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions, organisationId } },
});
const ACCOUNTS: Record<string, unknown> = {
    "t-cora": me("cora", PERMISSIONS, "org-a"),
    // Writes and runs tests, but may not change the project's settings.
    "t-tess": me("tess", ["ai_studio.access", "ai_studio.tests.write", "ai_studio.tests.run"], "org-a"),
    "t-bob": me("bob", PERMISSIONS, "org-b"),
};

let api: http.Server;
let platform: Platform;
let app: App;
let dataDir = "";
let stopBeat: (() => void) | undefined;
const answers: string[] = [];

const as = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as "GET", url, headers: { cookie: `c4t_access=${token}`, ...(method === "GET" ? {} : PAGE) }, ...(payload !== undefined ? { payload: payload as object } : {}) }).then((r) => {
        answers.push(r.body);
        return { status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body };
    });

async function newProject(name: string, testingModes: string[], url: string | null = SITE): Promise<string> {
    const r = await as("t-cora", "POST", "/api/projects", { name, platforms: ["web"], testingModes });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.id as string;
    if (url) expect((await as("t-cora", "PUT", `/api/projects/${id}/app-details`, { webUrl: url })).status).toBe(200);
    return id;
}
/** What a run of this project reads for {{credentials.*}}: the latest application row. */
const runCredentials = (projectId: string) => platform.repo.getApplication(String(platform.repo.getLatestApplicationPublic(projectId)!.id))!.credentials;

beforeAll(async () => {
    api = http.createServer((req, res) => {
        const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        res.writeHead(ACCOUNTS[auth] ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ACCOUNTS[auth] ?? { error: { message: "Invalid access token" } }));
    });
    await new Promise<void>((r) => api.listen(API_PORT, "127.0.0.1", r));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-project-sign-in-"));
    platform = bootstrap(
        loadConfig({ DATA_DIR: dataDir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", SECRET_KEY: "project-sign-in-secret-key-0123456789", C4T_API_ORIGIN: `http://127.0.0.1:${API_PORT}`, C4T_SITE_URL: "https://crowd4test.example" }),
    );
    stopBeat = startHeartbeat(platform.db);
    app = await buildServer(platform);
    await app.ready();
}, 60_000);

afterAll(async () => {
    stopBeat?.();
    await app?.close();
    platform?.db.close();
    await new Promise((r) => api?.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("the project's sign-in", () => {
    it("a code project saves it, and the answer says only the user name and what is saved", async () => {
        const id = await newProject("Code sign-in", ["code"]);
        expect((await as("t-cora", "GET", `/api/projects/${id}/sign-in`)).body).toEqual({ username: null, hasPassword: false, hasTotp: false, site: SITE });
        const saved = await as("t-cora", "PUT", `/api/projects/${id}/sign-in`, { username: " qa@shop.example ", password: S.password, totpSecret: S.totp });
        expect(saved).toEqual({ status: 200, body: { username: "qa@shop.example", hasPassword: true, hasTotp: true, site: SITE } });
        expect((await as("t-cora", "GET", `/api/projects/${id}/sign-in`)).body).toEqual(saved.body);
        // What every run reads for {{credentials.username}}, {{credentials.password}} and {{credentials.totp}}.
        expect(runCredentials(id)).toMatchObject({ username: "qa@shop.example", password: S.password, totpSecret: S.totp });
    });

    it("works for an agent project, and is the same value 'What the agents need' shows and explores with", async () => {
        {
            const id = await newProject("Agent sign-in", ["agent"]);
            expect((await as("t-cora", "PUT", `/api/projects/${id}/sign-in`, { username: "agent@shop.example", password: S.password })).status).toBe(200);
            const inputs = (await as("t-cora", "GET", `/api/projects/${id}/agent-inputs`)).body;
            expect(inputs.signIn).toEqual({ username: "agent@shop.example", hasPassword: true, hasTotpSecret: false });
            expect(agentInputsStoreOf(platform).get(id)?.credentials).toMatchObject({ username: "agent@shop.example", password: S.password });
            // Saved from the agents' form: the sign-in page shows it, and runs use it.
            expect((await as("t-cora", "PUT", `/api/projects/${id}/agent-inputs`, { username: "other@shop.example", password: S.newPassword })).status).toBe(200);
            expect((await as("t-cora", "GET", `/api/projects/${id}/sign-in`)).body).toMatchObject({ username: "other@shop.example", hasPassword: true });
            expect(runCredentials(id)).toMatchObject({ username: "other@shop.example", password: S.newPassword });
        }
    });

    it("keeps what is left out, changes only the sign-in, and clears on request", async () => {
        const id = await newProject("Keep and clear", ["agent"]);
        // An API token saved on the agents' form stays when the sign-in changes.
        expect((await as("t-cora", "PUT", `/api/projects/${id}/agent-inputs`, { apiToken: "PSIGNIN-Token-77aa01" })).status).toBe(200);
        await as("t-cora", "PUT", `/api/projects/${id}/sign-in`, { username: "a@shop.example", password: S.password, totpSecret: S.totp });
        // Left out (or empty): kept.
        expect((await as("t-cora", "PUT", `/api/projects/${id}/sign-in`, { username: "b@shop.example", password: "" })).body).toEqual({ username: "b@shop.example", hasPassword: true, hasTotp: true, site: SITE });
        expect(runCredentials(id)).toMatchObject({ username: "b@shop.example", password: S.password, totpSecret: S.totp, apiToken: "PSIGNIN-Token-77aa01" });
        expect((await as("t-cora", "PUT", `/api/projects/${id}/sign-in`, { clear: ["totpSecret"] })).body).toMatchObject({ hasPassword: true, hasTotp: false });
        expect((await as("t-cora", "PUT", `/api/projects/${id}/sign-in`, { clear: ["password"] })).body).toMatchObject({ username: "b@shop.example", hasPassword: false });
        expect(runCredentials(id)?.password).toBeUndefined();
        // "all" removes the whole sign-in (not the API token); new values in the same request are saved after it.
        await as("t-cora", "PUT", `/api/projects/${id}/sign-in`, { password: S.password });
        expect((await as("t-cora", "PUT", `/api/projects/${id}/sign-in`, { clear: ["all"] })).body).toEqual({ username: null, hasPassword: false, hasTotp: false, site: SITE });
        expect(runCredentials(id)).toEqual({ apiToken: "PSIGNIN-Token-77aa01" });
        expect((await as("t-cora", "PUT", `/api/projects/${id}/sign-in`, { clear: ["all"], username: "c@shop.example", password: S.newPassword })).body).toMatchObject({ username: "c@shop.example", hasPassword: true });
        expect((await as("t-cora", "GET", `/api/projects/${id}/agent-inputs`)).body.signIn).toEqual({ username: "c@shop.example", hasPassword: true, hasTotpSecret: false });
        // Empty user name removes it.
        expect((await as("t-cora", "PUT", `/api/projects/${id}/sign-in`, { username: "" })).body.username).toBeNull();
    });

    it("a project that never saved one shows what its runs use, and the first save starts from it", async () => {
        const id = await newProject("Imported sign-in", ["code"], null);
        // As a spec import with credentials leaves it: only on the application row runs read.
        platform.repo.createApplication(id, SITE, {}, { username: "legacy@shop.example", password: S.password });
        expect((await as("t-cora", "GET", `/api/projects/${id}/sign-in`)).body).toEqual({ username: "legacy@shop.example", hasPassword: true, hasTotp: false, site: SITE });
        expect((await as("t-cora", "PUT", `/api/projects/${id}/sign-in`, { username: "new@shop.example" })).body).toEqual({ username: "new@shop.example", hasPassword: true, hasTotp: false, site: SITE });
        expect(runCredentials(id)).toEqual({ username: "new@shop.example", password: S.password });
        expect(agentInputsStoreOf(platform).get(id)?.credentials).toEqual({ username: "new@shop.example", password: S.password });
    });

    it("refuses in plain sentences", async () => {
        const bare = await newProject("No address", ["code"], null);
        expect((await as("t-cora", "GET", `/api/projects/${bare}/sign-in`)).body).toEqual({ username: null, hasPassword: false, hasTotp: false, site: null });
        const none = await as("t-cora", "PUT", `/api/projects/${bare}/sign-in`, { username: "x@shop.example" });
        expect(none.status).toBe(409);
        expect(none.body.error).toBe("This project has no application address yet. Add it in Settings → General, then save the sign-in.");
        const id = await newProject("Refusals", ["code"]);
        const bad: Array<[unknown, RegExp]> = [
            [{ password: "x".repeat(301) }, /^The password is too long: at most 300 characters\.$/],
            [{ username: "x".repeat(301) }, /^The user name is too long: at most 300 characters\.$/],
            [{ totpSecret: "not base32 !!" }, /authenticator secret/],
            [{ username: 5 }, /^The user name must be text\.$/],
            [{ clear: ["apiToken"] }, /^clear lists what to remove: "password", "totpSecret" or "all"\.$/],
            [{ apiToken: "x" }, /^Only the user name, password and authenticator secret are saved here/],
        ];
        for (const [body, message] of bad) {
            const r = await as("t-cora", "PUT", `/api/projects/${id}/sign-in`, body);
            expect(r.status, JSON.stringify(body)).toBe(400);
            expect(r.body.error).toMatch(message);
        }
        expect((await as("t-cora", "GET", `/api/projects/${id}/sign-in`)).body.username).toBeNull();
    });

    it("reading needs project access, saving needs the project-settings permission", async () => {
        const id = await newProject("Who may", ["code"]);
        await as("t-cora", "PUT", `/api/projects/${id}/sign-in`, { username: "qa@shop.example", password: S.password });
        const tess = (await as("t-tess", "GET", "/api/auth/state")).body.me.id as string;
        accessControlOf(app).projects.store.addMember(id, tess, { role: "editor", projectAdmin: false, source: "added", addedBy: "test" });
        expect((await as("t-tess", "GET", `/api/projects/${id}/sign-in`)).body).toMatchObject({ username: "qa@shop.example", hasPassword: true });
        expect((await as("t-tess", "PUT", `/api/projects/${id}/sign-in`, { username: "mallory@shop.example" })).status).toBe(403);
        // Another organisation's person does not see the project at all.
        expect([403, 404]).toContain((await as("t-bob", "GET", `/api/projects/${id}/sign-in`)).status);
        expect([403, 404]).toContain((await as("t-bob", "PUT", `/api/projects/${id}/sign-in`, { username: "mallory@shop.example" })).status);
        expect(runCredentials(id)).toMatchObject({ username: "qa@shop.example", password: S.password });
    });

    it("never answers a secret", () => {
        for (const body of answers) for (const secret of Object.values(S)) expect(body).not.toContain(secret);
    });
});
