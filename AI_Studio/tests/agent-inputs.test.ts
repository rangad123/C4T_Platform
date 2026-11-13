/**
 * What a project's testing agents need (routes/agent-inputs.ts), against a stand-in Crowd4Test sign-in (port 7820): saving and
 * reading back with no secret ever in an answer, keeping and removing secrets, exploring with the saved inputs (and keeping the
 * sign-in on the next exploration), the project's own requirements planned for when no document is given, the refusal of an
 * exploration whose chosen agents miss a mandatory input, none for a project without a saved choice, and who may read and change them.
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
import { buildServer } from "../src/platform/server.js";
import { missingInputs, missingInputsMessage, NO_APPLICATION_YET, NOT_AN_AGENT_PROJECT, REQUIRED_INPUTS, sameSite } from "../src/platform/routes/agent-inputs.js";
import { createRequire } from "node:module";
import { AgentInputsStore } from "../src/platform/agent-inputs-store.js";
import { buildBackup, restoreBackup } from "../src/platform/backup.js";
import { createDatabaseAtVersion, Db, knownSchemaVersion } from "../src/platform/db.js";
import { startHeartbeat, writeHeartbeat } from "../src/platform/ops/heartbeat.js";
let stopBeat: (() => void) | undefined;
import { agentInputsStoreOf, savedCredentialsElsewhere } from "../src/platform/routes/agent-inputs.js";
import { SecretBox } from "../src/platform/secrets.js";

type App = Awaited<ReturnType<typeof buildServer>>;
const KEY = "agent-inputs-key-5d20b7";
const PAGE = { "x-requested-with": "ai-studio" };
const API_PORT = 7820;
const SITE = "https://shop.example/";
/** Distinct, greppable values: none may appear in any answer. */
const S = { password: "AGINPUT-Password-81c2e4", totp: "JBSWY3DPEHPK3PXP", token: "AGINPUT-Token-3f9a07", clientSecret: "AGINPUT-Client-6b1d55", newPassword: "AGINPUT-NewPw-90e3aa" };

const me = (id: string, role: string, permissions: readonly string[], organisationId: string | null = null) => ({
    data: { user: { id, email: `${id}@people.example`, role, status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions, organisationId } },
});
const ACCOUNTS: Record<string, unknown> = {
    "t-cora": me("cora", "CUSTOMER", PERMISSIONS, "org-a"),
    // Writes, generates and runs tests, but may not change the project's settings.
    "t-tess": me("tess", "CUSTOMER", ["ai_studio.access", "ai_studio.tests.write", "ai_studio.tests.generate", "ai_studio.tests.run"], "org-a"),
    "t-bob": me("bob", "CUSTOMER", PERMISSIONS, "org-b"),
};

let api: http.Server;
let platform: Platform;
let app: App;
let dataDir = "";
const answers: string[] = [];

const call = (headers: Record<string, string>, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as "GET", url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) }).then((r) => {
        answers.push(r.body);
        return { status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body };
    });
const asKey = (method: string, url: string, payload?: unknown) => call({ "x-api-key": KEY }, method, url, payload);
const as = (token: string, method: string, url: string, payload?: unknown) => call({ cookie: `c4t_access=${token}`, ...(method === "GET" ? {} : PAGE) }, method, url, payload);

/** A web project tested by the AI agent with these agents saved (none: no saved choice), and its address set. */
async function agentProject(name: string, agents?: string[], who = "t-cora"): Promise<string> {
    const r = await as(who, "POST", "/api/projects", { name, platforms: ["web"], testingModes: ["agent"], ...(agents ? { agents } : {}) });
    expect(r.status).toBe(201);
    const id = r.body.id as string;
    expect((await as(who, "PUT", `/api/projects/${id}/app-details`, { webUrl: SITE })).status).toBe(200);
    return id;
}
/** The exploration just queued stops (there is no worker here), so the next one may start. */
const finishJobs = (projectId: string) => platform.db.run("UPDATE generation_jobs SET status = 'FAILED' WHERE project_id = ?", projectId);
const latestJob = (projectId: string) => platform.repo.listJobs(projectId)[0]!;
const applicationOf = (projectId: string) => platform.repo.getApplication(latestJob(projectId).applicationId)!;

beforeAll(async () => {
    api = http.createServer((req, res) => {
        const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        res.writeHead(ACCOUNTS[auth] ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ACCOUNTS[auth] ?? { error: { message: "Invalid access token" } }));
    });
    await new Promise<void>((r) => api.listen(API_PORT, "127.0.0.1", r));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-agent-inputs-"));
    platform = bootstrap(
        loadConfig({ DATA_DIR: dataDir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECRET_KEY: "agent-inputs-secret-key-0123456789ab", C4T_API_ORIGIN: `http://127.0.0.1:${API_PORT}`, C4T_SITE_URL: "https://crowd4test.example" }),
    );
    // A worker in another process says it is alive, so runs and explorations are queued (and nothing here runs them).
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

describe("saving what the agents need", () => {
    let id = "";

    it("waits for the application's address, and is only for projects tested by the AI agent", async () => {
        const bare = (await as("t-cora", "POST", "/api/projects", { name: "No address", platforms: ["web"], testingModes: ["agent"] })).body.id;
        expect((await as("t-cora", "GET", `/api/projects/${bare}/agent-inputs`)).body).toMatchObject({ applies: true, application: null, missing: [] });
        expect(await as("t-cora", "PUT", `/api/projects/${bare}/agent-inputs`, { username: "qa@shop.example" })).toMatchObject({ status: 409, body: { error: NO_APPLICATION_YET } });
        const code = (await as("t-cora", "POST", "/api/projects", { name: "Code only", platforms: ["web"], testingModes: ["code"] })).body.id;
        expect((await as("t-cora", "GET", `/api/projects/${code}/agent-inputs`)).body.applies).toBe(false);
        expect(await as("t-cora", "PUT", `/api/projects/${code}/agent-inputs`, { username: "x" })).toMatchObject({ status: 409, body: { error: NOT_AN_AGENT_PROJECT } });
    });

    it("saves every input and answers only non-secret values and saved flags", async () => {
        id = await agentProject("Gift shop", ["accessibility", "test-generation"]);
        const before = platform.repo.getLatestApplicationPublic(id)!;
        const r = await as("t-cora", "PUT", `/api/projects/${id}/agent-inputs`, {
            username: "qa@shop.example",
            password: S.password,
            totpSecret: S.totp,
            apiToken: S.token,
            oauth2: { tokenUrl: "https://auth.shop.example/token", clientId: "shop-client", clientSecret: S.clientSecret, scope: "read" },
            openApiUrl: "https://shop.example/openapi.json",
            allowMutatingApiTests: true,
            cleanupAfter: false,
        });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({
            applies: true,
            application: { url: SITE },
            signIn: { username: "qa@shop.example", hasPassword: true, hasTotpSecret: true },
            apiAccess: { hasToken: true, oauth2: { tokenUrl: "https://auth.shop.example/token", clientId: "shop-client", scope: "read", hasClientSecret: true } },
            openApiUrl: "https://shop.example/openapi.json",
            allowMutatingApiTests: true,
            cleanupAfter: false,
            agents: { ids: ["accessibility", "test-generation"], source: "chosen" },
            missing: [],
        });
        expect((await as("t-cora", "GET", `/api/projects/${id}/agent-inputs`)).body).toEqual(r.body);
        // Kept where exploring keeps them: a new application row on the same address, settings carried over, secrets encrypted.
        const latest = platform.repo.getLatestApplicationPublic(id)!;
        expect(latest.id).not.toBe(before.id);
        expect(latest.url).toBe(SITE);
        const full = platform.repo.getApplication(String(latest.id))!;
        expect(full.credentials).toMatchObject({ username: "qa@shop.example", password: S.password, totpSecret: S.totp, apiToken: S.token, oauth2: { clientSecret: S.clientSecret } });
        expect(full.config).toMatchObject({ maxPages: 60, openApiUrl: "https://shop.example/openapi.json", allowMutatingApiTests: true });
        const raw = platform.db.get<{ c: string; j: string }>("SELECT credentials_enc AS c, config_json AS j FROM applications WHERE id = ?", latest.id);
        for (const v of Object.values(S)) expect(`${raw!.c}${raw!.j}`).not.toContain(v);
        expect((await as("t-cora", "GET", `/api/projects/${id}/cleanup`)).body.enabled).toBe(false);
    });

    it("keeps a secret left empty, replaces one given, and removes one cleared", async () => {
        const kept = await as("t-cora", "PUT", `/api/projects/${id}/agent-inputs`, { username: "qa@shop.example", password: "", apiToken: "" });
        expect(kept.body.signIn).toEqual({ username: "qa@shop.example", hasPassword: true, hasTotpSecret: true });
        expect(platform.repo.getApplication(String(platform.repo.getLatestApplicationPublic(id)!.id))!.credentials!.password).toBe(S.password);
        await as("t-cora", "PUT", `/api/projects/${id}/agent-inputs`, { password: S.newPassword });
        expect(platform.repo.getApplication(String(platform.repo.getLatestApplicationPublic(id)!.id))!.credentials!.password).toBe(S.newPassword);
        // The saved client secret is only sent where it was saved for: another token site needs it again, another path on the same site does not.
        const elsewhere = await as("t-cora", "PUT", `/api/projects/${id}/agent-inputs`, { oauth2: { tokenUrl: "https://collector.example/token", clientId: "shop-client" } });
        expect(elsewhere.status).toBe(400);
        expect(elsewhere.body.error).toBe("The token URL is on another site now: enter the OAuth2 client secret again.");
        expect(platform.repo.getApplication(String(platform.repo.getLatestApplicationPublic(id)!.id))!.credentials!.oauth2).toMatchObject({ tokenUrl: "https://auth.shop.example/token", clientSecret: S.clientSecret });
        const samePlace = await as("t-cora", "PUT", `/api/projects/${id}/agent-inputs`, { oauth2: { tokenUrl: "https://auth.shop.example/oauth/token", clientId: "shop-client" } });
        expect(samePlace.body.apiAccess.oauth2).toMatchObject({ tokenUrl: "https://auth.shop.example/oauth/token", hasClientSecret: true });
        const cleared = await as("t-cora", "PUT", `/api/projects/${id}/agent-inputs`, { clear: ["apiToken", "oauth2", "totpSecret"] });
        expect(cleared.body.apiAccess).toEqual({ hasToken: false, oauth2: null });
        expect(cleared.body.signIn).toEqual({ username: "qa@shop.example", hasPassword: true, hasTotpSecret: false });
        // An OAuth2 client needs its secret; a bad address or authenticator secret is refused in plain words.
        expect((await as("t-cora", "PUT", `/api/projects/${id}/agent-inputs`, { oauth2: { tokenUrl: "https://auth.shop.example/token", clientId: "c" } })).body.error).toBe("Enter the OAuth2 client secret.");
        expect((await as("t-cora", "PUT", `/api/projects/${id}/agent-inputs`, { openApiUrl: "not an address" })).body.error).toMatch(/OpenAPI document URL as a full address/);
        expect((await as("t-cora", "PUT", `/api/projects/${id}/agent-inputs`, { totpSecret: "not base32!" })).status).toBe(400);
        // The OpenAPI address and the data-changing choice are removed by saving them empty and off.
        const off = await as("t-cora", "PUT", `/api/projects/${id}/agent-inputs`, { openApiUrl: "", allowMutatingApiTests: false });
        expect(off.body).toMatchObject({ openApiUrl: null, allowMutatingApiTests: false });
        await as("t-cora", "PUT", `/api/projects/${id}/agent-inputs`, { openApiUrl: "https://shop.example/openapi.json", apiToken: S.token });
    });

    it("exploring uses the saved inputs, and the next exploration still has the sign-in", async () => {
        const first = await as("t-cora", "POST", `/api/projects/${id}/test-generation`, { url: SITE, plan: true });
        expect(first.status).toBe(202);
        let a = applicationOf(id);
        expect(a.credentials).toMatchObject({ username: "qa@shop.example", password: S.newPassword, apiToken: S.token });
        expect(a.config).toMatchObject({ openApiUrl: "https://shop.example/openapi.json" });
        expect(latestJob(id).options).toMatchObject({ openApiUrl: "https://shop.example/openapi.json", planOnly: true });
        finishJobs(id);
        // The exploration's own application row is now the latest: a second exploration keeps the sign-in.
        expect((await as("t-cora", "POST", `/api/projects/${id}/test-generation`, { url: SITE, plan: true })).status).toBe(202);
        a = applicationOf(id);
        expect(a.credentials).toMatchObject({ username: "qa@shop.example", password: S.newPassword });
        expect((await as("t-cora", "GET", `/api/projects/${id}/agent-inputs`)).body.signIn).toEqual({ username: "qa@shop.example", hasPassword: true, hasTotpSecret: false });
        finishJobs(id);
        // What a request gives wins over what is saved.
        expect((await as("t-cora", "POST", `/api/projects/${id}/test-generation`, { url: SITE, plan: true, credentials: { username: "other@shop.example", password: "x" } })).status).toBe(202);
        expect(applicationOf(id).credentials).toEqual({ username: "other@shop.example", password: "x" });
        finishJobs(id);
        // Another site never gets them.
        expect((await as("t-cora", "POST", `/api/projects/${id}/test-generation`, { url: "https://elsewhere.example/", plan: true })).status).toBe(202);
        expect(applicationOf(id).credentials).toBeUndefined();
        expect(latestJob(id).options.openApiUrl).toBeUndefined();
        finishJobs(id);
    });

    it("plans for the project's active requirements when no document is given", async () => {
        const rid = await agentProject("Requirements shop");
        expect((await as("t-cora", "POST", `/api/projects/${rid}/test-generation`, { url: SITE, plan: true })).status).toBe(202);
        expect(latestJob(rid).options.requirementsText).toBeUndefined();
        finishJobs(rid);
        for (const r of [
            { ref: "REQ-1", title: "Visitors can search the catalogue", acceptanceCriteria: "Results show within two seconds" },
            { ref: "REQ-2", title: "Visitors can pay by card", description: "Visa and Mastercard." },
            { ref: "REQ-3", title: "A draft idea", status: "draft" },
        ])
            expect((await as("t-cora", "POST", `/api/projects/${rid}/requirements`, r)).status).toBe(201);
        expect((await as("t-cora", "GET", `/api/projects/${rid}/agent-inputs`)).body.requirements).toEqual({ active: 2 });
        expect((await as("t-cora", "POST", `/api/projects/${rid}/test-generation`, { url: SITE, plan: true })).status).toBe(202);
        const o = latestJob(rid).options;
        expect(o.requirementsName).toBe("The project's requirements");
        expect(o.requirementsText).toContain("REQ-1: Visitors can search the catalogue Acceptance criteria: Results show within two seconds");
        expect(o.requirementsText).toContain("REQ-2: Visitors can pay by card Visa and Mastercard.");
        expect(o.requirementsText).not.toContain("A draft idea");
        // The application row keeps the settings, not the (possibly large) text.
        expect(JSON.stringify(applicationOf(rid).config)).not.toContain("Visitors can search");
        finishJobs(rid);
        // A document given with the request is used instead.
        const doc = { filename: "spec.md", contentBase64: Buffer.from("# Spec\n\n- FR-1: The basket keeps its items\n").toString("base64") };
        expect((await as("t-cora", "POST", `/api/projects/${rid}/test-generation`, { url: SITE, plan: true, requirements: doc })).status).toBe(202);
        expect(latestJob(rid).options).toMatchObject({ requirementsName: "spec.md" });
        expect(latestJob(rid).options.requirementsText).not.toContain("REQ-1");
        finishJobs(rid);
    });
});

describe("mandatory inputs", () => {
    it("the rule table: the API agent needs the API documentation, the others nothing they cannot do without", () => {
        expect(Object.keys(REQUIRED_INPUTS)).toEqual(["api"]);
        expect(missingInputs(["api", "accessibility"], {})).toEqual([{ agent: "api", agentName: "API Testing Agent", input: "openApiUrl", inputName: "OpenAPI document URL", text: REQUIRED_INPUTS.api![0]!.text }]);
        expect(missingInputs(["api"], { openApiUrl: "https://x.example/openapi.json" })).toEqual([]);
        expect(missingInputs(["api"], {}, ["web"])).toEqual([]);
        expect(missingInputs(["security", "ux", "performance", "responsive-ui", "test-generation", "accessibility"], {})).toEqual([]);
        expect(sameSite("https://a.example/x", "https://a.example/y")).toBe(true);
        expect(sameSite("https://a.example/", "https://b.example/")).toBe(false);
        expect(sameSite("android-app://com.shop", "android-app://com.shop")).toBe(true);
    });

    it("an exploration whose chosen agents miss one is refused with the pop-up's words, until it is saved", async () => {
        const id = await agentProject("API shop", ["api", "test-generation"]);
        const got = await as("t-cora", "GET", `/api/projects/${id}/agent-inputs`);
        expect(got.body.missing).toEqual([expect.objectContaining({ agent: "api", input: "openApiUrl", agentName: "API Testing Agent" })]);
        const refused = await as("t-cora", "POST", `/api/projects/${id}/test-generation`, { url: SITE, plan: true });
        expect(refused).toMatchObject({ status: 409, body: { error: missingInputsMessage(got.body.missing) } });
        expect(refused.body.error).toMatch(/^The API Testing Agent needs the API documentation: the address of the OpenAPI document\. Add it on the project's Requirements tab/);
        expect(platform.repo.listJobs(id)).toHaveLength(0);
        // The same through the access key (the CLI and MCP): one rule for every caller.
        expect((await asKey("POST", `/api/projects/${id}/test-generation`, { url: SITE })).status).toBe(409);
        // Given with the request, or an exploration without the API, is not refused.
        expect((await asKey("POST", `/api/projects/${id}/test-generation`, { url: SITE, plan: true, openApiUrl: "https://shop.example/v2/openapi.json" })).status).toBe(202);
        finishJobs(id);
        expect((await asKey("POST", `/api/projects/${id}/test-generation`, { url: SITE, plan: true, targets: ["web"] })).status).toBe(202);
        finishJobs(id);
        // Saved on the Requirements tab: nothing is missing any more.
        const saved = await as("t-cora", "PUT", `/api/projects/${id}/agent-inputs`, { openApiUrl: "https://shop.example/openapi.json" });
        expect(saved.body.missing).toEqual([]);
        expect((await as("t-cora", "POST", `/api/projects/${id}/test-generation`, { url: SITE, plan: true })).status).toBe(202);
        finishJobs(id);
    });

    it("a project with no saved choice of agents is never refused", async () => {
        const id = await agentProject("Older shop");
        const got = await as("t-cora", "GET", `/api/projects/${id}/agent-inputs`);
        expect(got.body.agents.source).toBe("matched");
        expect(got.body.agents.ids).toContain("api");
        expect(got.body.missing).toEqual([]);
        expect((await as("t-cora", "POST", `/api/projects/${id}/test-generation`, { url: SITE, plan: true })).status).toBe(202);
        // It explores as before: the usual checks, web and API.
        expect(latestJob(id).options).toMatchObject({ targets: ["web", "api"], healthChecks: true, securityChecks: true, inputChecks: true, contractChecks: true, useMemory: true });
        finishJobs(id);
    });
});

describe("who may read and change them", () => {
    it("a person who may not change settings sees what is set but cannot change it; another organisation's project answers 404", async () => {
        const id = await agentProject("Permissions shop", ["accessibility"]);
        expect((await as("t-cora", "PUT", `/api/projects/${id}/agent-inputs`, { username: "qa@shop.example", password: S.password })).status).toBe(200);
        const tess = (await as("t-tess", "GET", "/api/auth/state")).body.me.id as string;
        accessControlOf(app).projects.store.addMember(id, tess, { role: "editor", projectAdmin: false, source: "added", addedBy: "test" });
        const seen = await as("t-tess", "GET", `/api/projects/${id}/agent-inputs`);
        expect(seen.status).toBe(200);
        expect(seen.body.signIn).toEqual({ username: "qa@shop.example", hasPassword: true, hasTotpSecret: false });
        expect((await as("t-tess", "PUT", `/api/projects/${id}/agent-inputs`, { username: "mallory@shop.example" })).status).toBe(403);
        expect((await as("t-bob", "GET", `/api/projects/${id}/agent-inputs`)).status).toBe(404);
        expect((await as("t-bob", "PUT", `/api/projects/${id}/agent-inputs`, { username: "x" })).status).toBe(404);
        expect((await as("t-cora", "GET", "/api/projects/no-such-project/agent-inputs")).status).toBe(404);
        expect(platform.repo.getApplication(String(platform.repo.getLatestApplicationPublic(id)!.id))!.credentials!.username).toBe("qa@shop.example");
    });

    it("no secret appears in any answer this file received", () => {
        expect(answers.length).toBeGreaterThan(20);
        for (const v of Object.values(S)) expect(answers.join("\n")).not.toContain(v);
    });
});

describe("saved inputs stay where they were saved, and go only where they may", () => {
    /** Distinct, greppable values of this block: none may appear in any answer either. */
    const T = { header: "X-Api-Key: AGINPUT-Header-5e71c0", newToken: "AGINPUT-NewToken-c40d19", tessToken: "AGINPUT-Tess-77ab02" };
    const COLLECTOR = "https://collector.example/";
    const addTess = async (id: string) => {
        const tess = (await as("t-tess", "GET", "/api/auth/state")).body.me.id as string;
        accessControlOf(app).projects.store.addMember(id, tess, { role: "editor", projectAdmin: false, source: "added", addedBy: "test" });
    };
    // The explorations below need a worker that could pick them up (none runs here: they are queued and stopped).
    beforeAll(() => writeHeartbeat(platform.db));

    it("refuses an exploration that would send the saved credentials to an API address or OpenAPI document nobody saved them for", async () => {
        const id = await agentProject("Collector shop", ["api", "test-generation"]);
        expect((await as("t-cora", "PUT", `/api/projects/${id}/agent-inputs`, { apiToken: S.token, openApiUrl: "https://shop.example/openapi.json", oauth2: { tokenUrl: "https://auth.shop.example/token", clientId: "shop", clientSecret: S.clientSecret } })).status).toBe(200);
        await addTess(id);
        // Tess may explore but not change settings: her own API address, or her own OpenAPI document, would receive the saved token.
        const elsewhere = await as("t-tess", "POST", `/api/projects/${id}/test-generation`, { url: SITE, apiBaseUrl: COLLECTOR, openApiUrl: `${COLLECTOR}openapi.json`, targets: ["api"] });
        expect(elsewhere).toMatchObject({ status: 409, body: { error: savedCredentialsElsewhere(SITE, "API address", COLLECTOR) } });
        expect(elsewhere.body.error).toMatch(/^The saved sign-in and API access are only sent to shop\.example and the addresses saved with them, and this exploration's API address is on collector\.example\./);
        const document = await as("t-tess", "POST", `/api/projects/${id}/test-generation`, { url: SITE, openApiUrl: `${COLLECTOR}openapi.json`, plan: true });
        expect(document).toMatchObject({ status: 409, body: { error: savedCredentialsElsewhere(SITE, "OpenAPI document URL", `${COLLECTOR}openapi.json`) } });
        // Through the access key too: one rule for every caller. Nothing was queued, and the project's latest application is unchanged.
        expect((await asKey("POST", `/api/projects/${id}/test-generation`, { url: SITE, apiBaseUrl: COLLECTOR, plan: true })).status).toBe(409);
        expect(platform.repo.listJobs(id)).toHaveLength(0);
        expect(platform.repo.getLatestApplicationPublic(id)!.config.apiBaseUrl).toBeUndefined();
        // On the saved site, or on an address saved with them (the token URL's site), the saved credentials go with the exploration.
        for (const apiBaseUrl of ["https://shop.example/api/", "https://auth.shop.example/"]) {
            expect((await as("t-tess", "POST", `/api/projects/${id}/test-generation`, { url: SITE, apiBaseUrl, plan: true })).status).toBe(202);
            expect(applicationOf(id).credentials).toMatchObject({ apiToken: S.token });
            expect(latestJob(id).options.apiBaseUrl).toBe(apiBaseUrl);
            finishJobs(id);
        }
        // Credentials sent with the request are the caller's own: they go where the caller says, and the saved ones stay out of it.
        expect((await as("t-tess", "POST", `/api/projects/${id}/test-generation`, { url: SITE, apiBaseUrl: COLLECTOR, plan: true, credentials: { apiToken: T.tessToken } })).status).toBe(202);
        expect(applicationOf(id).credentials).toEqual({ apiToken: T.tessToken });
        finishJobs(id);
        // That exploration left the collector as the latest application's API address, which runs read. Saving again on the Requirements
        // tab puts the saved token on a new latest application without that address, so a run never sends it there.
        expect((await as("t-cora", "PUT", `/api/projects/${id}/agent-inputs`, { username: "qa@shop.example" })).status).toBe(200);
        const latest = platform.repo.getApplication(String(platform.repo.getLatestApplicationPublic(id)!.id))!;
        expect(latest.credentials).toMatchObject({ apiToken: S.token, username: "qa@shop.example" });
        expect(latest.config.apiBaseUrl).toBeUndefined();
    });

    it("an exploration never changes what is saved: not the sign-in, the OpenAPI document or tests that change data", async () => {
        const id = await agentProject("Rewrite shop", ["test-generation"]);
        const saved = await as("t-cora", "PUT", `/api/projects/${id}/agent-inputs`, { username: "qa@shop.example", password: S.password, openApiUrl: "https://shop.example/openapi.json", allowMutatingApiTests: false });
        expect(saved.status).toBe(200);
        await addTess(id);
        // Tess explores with her own sign-in, her own OpenAPI document and data-changing tests on.
        expect((await as("t-tess", "POST", `/api/projects/${id}/test-generation`, { url: SITE, plan: true, credentials: { username: "tess@shop.example", password: "x" }, openApiUrl: "https://shop.example/v2/openapi.json", allowMutatingApiTests: true })).status).toBe(202);
        expect(applicationOf(id).credentials).toEqual({ username: "tess@shop.example", password: "x" });
        finishJobs(id);
        // What the Requirements tab shows is still what Cora saved.
        expect((await as("t-cora", "GET", `/api/projects/${id}/agent-inputs`)).body).toEqual(saved.body);
        // And the next exploration that brings nothing uses what is saved, not what Tess sent.
        expect((await as("t-cora", "POST", `/api/projects/${id}/test-generation`, { url: SITE, plan: true })).status).toBe(202);
        expect(applicationOf(id).credentials).toEqual({ username: "qa@shop.example", password: S.password });
        expect(latestJob(id).options.openApiUrl).toBe("https://shop.example/openapi.json");
        expect(latestJob(id).options.allowMutatingApiTests).not.toBe(true);
        finishJobs(id);
        // Saved for this site: exploring another site neither uses nor removes them.
        expect((await as("t-tess", "POST", `/api/projects/${id}/test-generation`, { url: "https://elsewhere.example/", plan: true })).status).toBe(202);
        expect(applicationOf(id).credentials).toBeUndefined();
        finishJobs(id);
        expect(agentInputsStoreOf(platform).get(id)).toMatchObject({ site: SITE, credentials: { username: "qa@shop.example", password: S.password }, openApiUrl: "https://shop.example/openapi.json", allowMutatingApiTests: false });
    });

    it("refuses an address with a user name or password in it", async () => {
        const id = await agentProject("Userinfo shop", ["accessibility"]);
        const doc = await as("t-cora", "PUT", `/api/projects/${id}/agent-inputs`, { openApiUrl: "https://qa:pw@shop.example/openapi.json" });
        expect(doc).toMatchObject({ status: 400, body: { error: "Enter the OpenAPI document URL without a user name or password: sign-in details go in their own fields." } });
        const token = await as("t-cora", "PUT", `/api/projects/${id}/agent-inputs`, { oauth2: { tokenUrl: "https://client@auth.shop.example/token", clientId: "c", clientSecret: S.clientSecret } });
        expect(token).toMatchObject({ status: 400, body: { error: "Enter the OAuth2 token URL without a user name or password: sign-in details go in their own fields." } });
        expect(agentInputsStoreOf(platform).get(id)).toBeUndefined();
    });

    it("a custom API header saved before this tab shows as the saved token, is replaced by a new token and cleared with it", async () => {
        const id = await agentProject("Header shop", ["accessibility"]);
        const store = agentInputsStoreOf(platform);
        // As an earlier exploration left it (carried over by migration slot 50).
        store.save(id, { site: SITE, credentials: { username: "qa@shop.example", apiAuthHeader: T.header } });
        const view = async () => (await as("t-cora", "GET", `/api/projects/${id}/agent-inputs`)).body;
        expect((await view()).apiAccess).toEqual({ hasToken: true, oauth2: null });
        // Saving something else keeps it.
        expect((await as("t-cora", "PUT", `/api/projects/${id}/agent-inputs`, { username: "qa2@shop.example" })).body.apiAccess.hasToken).toBe(true);
        expect(store.get(id)!.credentials).toEqual({ username: "qa2@shop.example", apiAuthHeader: T.header });
        // Clearing the token clears it, here and on the application row runs read.
        expect((await as("t-cora", "PUT", `/api/projects/${id}/agent-inputs`, { clear: ["apiToken"] })).body.apiAccess.hasToken).toBe(false);
        expect(store.get(id)!.credentials).toEqual({ username: "qa2@shop.example" });
        expect(platform.repo.getApplication(String(platform.repo.getLatestApplicationPublic(id)!.id))!.credentials).toEqual({ username: "qa2@shop.example" });
        // A new token replaces it.
        store.save(id, { site: SITE, credentials: { apiAuthHeader: T.header } });
        expect((await as("t-cora", "PUT", `/api/projects/${id}/agent-inputs`, { apiToken: T.newToken })).body.apiAccess.hasToken).toBe(true);
        expect(store.get(id)!.credentials).toEqual({ apiToken: T.newToken });
    });

    it("migration slot 50: each existing project starts with what its latest application holds", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-slot50-"));
        const file = path.join(dir, "studio.db");
        try {
            // A database as slot 49 left it.
            createDatabaseAtVersion(file, 49);
            const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
            const raw = new DatabaseSync(file);
            const box = new SecretBox(dir, "slot-fifty-secret-key-0123456789");
            const t = "2026-10-01T00:00:00.000Z";
            raw.exec(`INSERT INTO users (id, email, created_at) VALUES ('u', 'u@example.com', '${t}')`);
            for (const pid of ["p1", "p2", "p3"]) raw.exec(`INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES ('${pid}', 'u', '${pid}', '${t}', '${t}')`);
            const app = raw.prepare("INSERT INTO applications (id, project_id, url, origin, config_json, credentials_enc, created_at) VALUES (?,?,?,?,?,?,?)");
            // p1: an older row, then the latest with the sign-in, the token, the OpenAPI document and data-changing tests on.
            app.run("a1", "p1", "https://old.example/", "https://old.example", JSON.stringify({ maxPages: 25 }), box.encrypt({ username: "old@old.example", password: S.password }), "2026-09-01T00:00:00.000Z");
            app.run("a2", "p1", SITE, "https://shop.example", JSON.stringify({ maxPages: 25, openApiUrl: "https://shop.example/openapi.json", allowMutatingApiTests: true, apiBaseUrl: "https://api.shop.example/" }), box.encrypt({ username: "qa@shop.example", password: S.password, apiToken: S.token }), "2026-10-02T00:00:00.000Z");
            // p2: one row, nothing saved with it. p3: no application at all.
            app.run("b1", "p2", "https://plain.example/", "https://plain.example", JSON.stringify({ maxPages: 25 }), null, t);
            raw.close();

            const db = new Db(file);
            try {
                expect(db.get<{ v: number }>("SELECT MAX(version) AS v FROM schema_version")!.v).toBe(knownSchemaVersion());
                const store = new AgentInputsStore(db, box);
                expect(store.get("p1")).toEqual({ site: SITE, credentials: { username: "qa@shop.example", password: S.password, apiToken: S.token }, openApiUrl: "https://shop.example/openapi.json", allowMutatingApiTests: true, updatedAt: "2026-10-02T00:00:00.000Z" });
                expect(store.get("p2")).toEqual({ site: "https://plain.example/", updatedAt: t });
                expect(store.get("p3")).toBeUndefined();
                // The ciphertext was copied as it was, and the applications are untouched.
                const enc = (sql: string) => db.get<{ c: string }>(sql)!.c;
                expect(enc("SELECT credentials_enc AS c FROM project_agent_inputs WHERE project_id = 'p1'")).toBe(enc("SELECT credentials_enc AS c FROM applications WHERE id = 'a2'"));
                expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM applications")!.n).toBe(3);
            } finally {
                db.close();
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("a project restored from a backup keeps the OpenAPI address and the data-changing choice; the secrets are typed again", async () => {
        const id = await agentProject("Backup shop", ["accessibility"]);
        expect((await as("t-cora", "PUT", `/api/projects/${id}/agent-inputs`, { username: "qa@shop.example", password: S.password, apiToken: S.token, openApiUrl: "https://shop.example/openapi.json", allowMutatingApiTests: true })).status).toBe(200);
        const { bytes } = await buildBackup(platform, id, { evidence: false, maxEvidenceMB: 0 });
        expect(Buffer.from(bytes).includes(Buffer.from(S.password))).toBe(false);
        const restored = await restoreBackup(platform, bytes, { name: "Backup shop restored" });
        expect(restored.needsSecrets.map((n) => n.kind)).toContain("application-sign-in");
        const view = (await asKey("GET", `/api/projects/${restored.project.id}/agent-inputs`)).body;
        expect(view).toMatchObject({ openApiUrl: "https://shop.example/openapi.json", allowMutatingApiTests: true, signIn: { username: null, hasPassword: false, hasTotpSecret: false }, apiAccess: { hasToken: false, oauth2: null } });
    });

    it("no secret of this block appears in any answer either", () => {
        for (const v of [...Object.values(S), ...Object.values(T)]) expect(answers.join("\n")).not.toContain(v);
    });
});
