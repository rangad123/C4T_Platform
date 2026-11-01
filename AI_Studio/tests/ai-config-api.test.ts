/**
 * AI configuration per project (AD-10, AD-11, AI-02 to AI-05, FL-E), against a stand-in Crowd4Test sign-in (port 7825), a stand-in
 * OpenAI-compatible provider that records which key each call carried (port 7826) and a real platform through inject. No real provider is
 * ever called. Covers: the key is encrypted and write-only; a project on its own key uses that key and never the server's, with no
 * fallback; managed AI uses the server's key; "Test this key"; usage rows carry who pays; permissions (a tester sees only availability, a
 * customer stays inside their organisation); budgets; and what the hosted preview says.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { AI_NOT_AVAILABLE, AI_REFUSED, clientOfConfiguration, resolveProjectAi } from "../src/platform/ai-config.js";
import { AiConfigStore } from "../src/platform/ai-config-store.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { runJob } from "../src/platform/job-runner.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { resetKeyTests } from "../src/platform/routes/ai-config.js";
import { buildServer } from "../src/platform/server.js";
import { SecretBox } from "../src/platform/secrets.js";
import { usageStoreFor } from "../src/platform/usage-store.js";
import { unavailableLlmClient } from "../src/engine/llm/provider.js";

const C4T_PORT = 7825;
const PROVIDER_PORT = 7826;
const PROVIDER = `http://127.0.0.1:${PROVIDER_PORT}/v1`;
const KEY = "ai-config-owner-key-5e21";
const SECRET = "ai-config-test-secret-key-0123456789";
const SERVER_KEY = "SERVER-managed-key-0000";
const GOOD = "ORG-own-key-sentinel-1234";
const BAD = "BAD-own-key-sentinel-9999";
const PAGE = { "x-requested-with": "ai-studio" };

const me = (id: string, role: string, permissions: readonly string[], organisationId: string | null = null) => ({
    data: { user: { id, email: `${id}@people.example`, role, status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions, organisationId } },
});
const ACCOUNTS: Record<string, unknown> = {
    "t-admin": me("ada", "ADMIN", []),
    "t-cora": me("cora", "CUSTOMER", PERMISSIONS, "org-a"),
    "t-rita": me("rita", "CUSTOMER", ["ai_studio.access", "ai_studio.usage.view"], "org-a"),
    "t-bob": me("bob", "CUSTOMER", PERMISSIONS, "org-b"),
    // Asking for a tester to hold these: AI Studio ignores them.
    "t-tim": me("tim", "TESTER", ["ai_studio.access", "ai_studio.ai_keys.manage", "ai_studio.usage.view"]),
};

let c4t: http.Server;
let fakeProvider: http.Server;
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
/** Every Authorization key the stand-in provider received, in order. */
let seen: string[] = [];

const call = async (headers: Record<string, string>, method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as "GET", url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: r.statusCode, text: r.body, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body } as { status: number; text: string; body: any };
};
const asKey = (method: string, url: string, payload?: unknown) => call({ "x-api-key": KEY }, method, url, payload);
const as = (token: string, method: string, url: string, payload?: unknown) => call({ cookie: `c4t_access=${token}`, ...(method === "GET" ? {} : PAGE) }, method, url, payload);
const personOf = async (token: string): Promise<string> => (await as(token, "GET", "/api/auth/state")).body.me.id;
const addMember = async (projectId: string, token: string) => accessControlOf(app).projects.store.addMember(projectId, await personOf(token), { role: "owner", projectAdmin: true, source: "added", addedBy: "test" } as never);
const newProject = async (token: string, name: string) => (await as(token, "POST", "/api/projects", { name })).body.id as string;
const FIELDS = { provider: "openai-compatible", model: "stand-in-main", baseUrl: PROVIDER };
const orgConfig = async (token: string, label: string, apiKey: string) => (await as(token, "POST", "/api/ai-configurations", { ...FIELDS, label, apiKey, owner: "organization" })).body as { id: string; keyEnding: string };
const useOwn = (token: string, id: string, configurationId: string) => as(token, "PUT", `/api/projects/${id}/ai`, { mode: "own", configurationId });
const deps = () => ({ sql: platform.sql, config: platform.config });
const usageRows = (projectId: string) => platform.db.all<{ job_id: string; billing_owner: string; billing_organization_id: string | null; model: string; calls: number }>("SELECT job_id, billing_owner, billing_organization_id, model, calls FROM ai_usage WHERE project_id = ?", projectId);

beforeAll(async () => {
    c4t = http.createServer((req, res) => {
        const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        res.writeHead(ACCOUNTS[auth] ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ACCOUNTS[auth] ?? { error: { message: "Invalid access token" } }));
    });
    await new Promise<void>((r) => c4t.listen(C4T_PORT, "127.0.0.1", r));
    fakeProvider = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const key = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
            seen.push(key);
            res.setHeader("content-type", "application/json");
            if (key.startsWith("BAD")) {
                res.statusCode = 401;
                // A provider that repeats the key it refused: nothing of it may reach an answer.
                return res.end(JSON.stringify({ error: { message: `Invalid API key ${key}`, type: "invalid_request_error", code: "invalid_api_key" } }));
            }
            res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "stand-in", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } }));
        });
    });
    await new Promise<void>((r) => fakeProvider.listen(PROVIDER_PORT, "127.0.0.1", r));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-aiconfig-"));
    platform = bootstrap(
        loadConfig({
            DATA_DIR: dir,
            SCHEDULER_ENABLED: "false",
            WORKER_EMBEDDED: "false",
            API_KEY: KEY,
            SECRET_KEY: SECRET,
            C4T_API_ORIGIN: `http://127.0.0.1:${C4T_PORT}`,
            C4T_SITE_URL: "https://crowd4test.example",
            // The server's own key and model, on the same stand-in, so a call that reached it would show.
            LLM_PROVIDER: "openai-compatible",
            LLM_BASE_URL: PROVIDER,
            LLM_API_KEY: SERVER_KEY,
            LLM_MODEL: "server-main",
            LLM_RETRY_ATTEMPTS: "1",
        } as never),
    );
    app = await buildServer(platform);
    await app.ready();
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    await new Promise((r) => c4t?.close(r));
    await new Promise((r) => fakeProvider?.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
    seen = [];
    resetKeyTests();
});

describe("a key is stored once and never comes back", () => {
    it("is encrypted at rest, shown only by its ending, and never returned by any route", async () => {
        const pid = await newProject("t-cora", "Write-only");
        const created = await as("t-cora", "POST", `/api/projects/${pid}/ai/configurations`, { ...FIELDS, label: "Write-only key", apiKey: GOOD });
        expect(created.status).toBe(201);
        expect(created.body.keyEnding).toBe("1234");
        await useOwn("t-cora", pid, created.body.id);
        const answers = [created, await as("t-cora", "GET", `/api/projects/${pid}/ai`), await as("t-cora", "GET", "/api/ai-configurations"), await as("t-admin", "GET", "/api/ai-configurations"), await asKey("GET", "/api/ai-configurations")];
        for (const a of answers) {
            expect(a.status).toBeLessThan(300);
            expect(a.text).not.toContain(GOOD);
            expect(a.text).not.toMatch(/key_?enc/i);
        }
        const row = platform.db.get<{ key_enc: string; key_hint: string }>("SELECT key_enc, key_hint FROM ai_configurations WHERE id = ?", created.body.id)!;
        expect(row.key_enc).not.toContain(GOOD);
        expect(row.key_hint).toBe("1234");
        expect(await new AiConfigStore(platform.sql, new SecretBox(dir, SECRET)).keyOf(created.body.id)).toBe(GOOD);
        // Nowhere in the database files in readable form.
        for (const f of fs.readdirSync(dir).filter((n) => /\.(db|sqlite)/.test(n))) expect(fs.readFileSync(path.join(dir, f)).includes(Buffer.from(GOOD))).toBe(false);
        // Nor in the Activity list.
        expect(JSON.stringify(platform.db.all("SELECT * FROM activity"))).not.toContain(GOOD);
    });

    it("needs the key entered again when the provider or the address changes, so a stored key only goes where it was meant to", async () => {
        const c = await orgConfig("t-cora", "Moves", GOOD);
        const moved = await as("t-cora", "PATCH", `/api/ai-configurations/${c.id}`, { baseUrl: "https://elsewhere.example/v1" });
        expect(moved.status).toBe(400);
        expect(moved.body.error).toMatch(/Enter the key again/);
        const renamed = await as("t-cora", "PATCH", `/api/ai-configurations/${c.id}`, { label: "Renamed" });
        expect(renamed.status).toBe(200);
        expect(renamed.body).toMatchObject({ label: "Renamed", keyEnding: "1234" });
        const rekeyed = await as("t-cora", "PATCH", `/api/ai-configurations/${c.id}`, { baseUrl: "https://elsewhere.example/v1", apiKey: "new-key-for-there-5678" });
        expect(rekeyed.body).toMatchObject({ keyEnding: "5678", status: "untested", baseUrl: "https://elsewhere.example/v1" });
    });

    it("refuses an address with a password in it, one for a provider that has none, and a private one where private addresses are blocked", async () => {
        const pid = await newProject("t-cora", "Addresses");
        const post = (body: object) => as("t-cora", "POST", `/api/projects/${pid}/ai/configurations`, { label: "x", model: "m", apiKey: GOOD, ...body });
        expect((await post({ provider: "openai-compatible", baseUrl: "https://me:pw@llm.example/v1" })).status).toBe(400);
        expect((await post({ provider: "openai-compatible" })).status).toBe(400);
        expect((await post({ provider: "anthropic", baseUrl: "https://llm.example/v1" })).status).toBe(400);
        expect((await post({ provider: "anthropic", apiKey: "short" })).status).toBe(400);
        const saved = process.env.BLOCK_PRIVATE_TARGETS;
        process.env.BLOCK_PRIVATE_TARGETS = "true";
        try {
            const r = await post({ provider: "openai-compatible", baseUrl: "http://169.254.169.254/v1" });
            expect(r.status).toBe(400);
            expect(r.body.error).toMatch(/private/i);
        } finally {
            if (saved === undefined) delete process.env.BLOCK_PRIVATE_TARGETS;
            else process.env.BLOCK_PRIVATE_TARGETS = saved;
        }
    });
});

describe("which key a project's work uses", () => {
    const refine = (token: string, pid: string) => as(token, "POST", `/api/projects/${pid}/requirements/import/refine`, { text: "The system shall let a user sign in with an email address and a password." });

    it("a project on its own key uses that key, and its usage names the organisation", async () => {
        const pid = await newProject("t-cora", "Own key");
        const c = await orgConfig("t-cora", "Org key", GOOD);
        expect((await useOwn("t-cora", pid, c.id)).body).toMatchObject({ mode: "own", billingOwner: "organization" });
        const r = await refine("t-cora", pid);
        expect(r.status).toBe(200);
        expect(seen.length).toBeGreaterThan(0);
        expect(new Set(seen)).toEqual(new Set([GOOD]));
        const rows = usageRows(pid);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((x) => x.billing_owner === "organization" && x.billing_organization_id === "org-a" && x.model === "stand-in-main")).toBe(true);
    });

    it("a managed project uses the server's key, and its usage names Crowd4Test", async () => {
        const pid = await newProject("t-cora", "Managed");
        expect((await as("t-cora", "GET", `/api/projects/${pid}/ai`)).body).toMatchObject({ mode: "managed", billingOwner: "crowd4test", available: false, ready: true });
        expect((await refine("t-cora", pid)).status).toBe(200);
        expect(new Set(seen)).toEqual(new Set([SERVER_KEY]));
        const rows = usageRows(pid);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((x) => x.billing_owner === "crowd4test" && x.billing_organization_id === null)).toBe(true);
    });

    it("an own key that fails stops with a clear message, never reaches the server's key, and shows on the configuration", async () => {
        const pid = await newProject("t-cora", "Own key fails");
        const c = await orgConfig("t-cora", "Bad org key", BAD);
        await useOwn("t-cora", pid, c.id);
        const ai = await resolveProjectAi(deps(), pid);
        const client = clientOfConfiguration(deps(), ai);
        const ask = () => client.text({ system: "s", prompt: "p" });
        await expect(ask()).rejects.toThrow(AI_REFUSED);
        const after = seen.length;
        expect(after).toBe(1);
        expect(seen).not.toContain(SERVER_KEY);
        // The key is known to be bad: the next call stops here, in the same words, without another request.
        await expect(ask()).rejects.toThrow(AI_REFUSED);
        expect(seen.length).toBe(after);
        await expect.poll(async () => (await as("t-cora", "GET", `/api/projects/${pid}/ai`)).body.configuration.status).toBe("failed");
        expect((await as("t-cora", "GET", `/api/projects/${pid}/ai`)).body).toMatchObject({ available: false, ready: false });
        // Words for testers too: no key, no provider detail.
        expect(AI_REFUSED).not.toMatch(/key|Bad org/i);
        // The configuration's failure does not pause the provider for a project on the server's key.
        const other = await newProject("t-cora", "Still managed");
        expect((await refine("t-cora", other)).status).toBe(200);
        expect(seen).toContain(SERVER_KEY);
    });

    it("a project on its own key has no way to the server: none chosen, removed, another organisation's, or unreadable all stop it", async () => {
        const pid = await newProject("t-cora", "Blocked");
        const none = await useOwn("t-cora", pid, "");
        expect(none.status).toBe(400);
        const c = await orgConfig("t-cora", "Will go", GOOD);
        await useOwn("t-cora", pid, c.id);
        // Unreadable: the stored key does not decrypt.
        platform.db.run("UPDATE ai_configurations SET key_enc = 'broken' WHERE id = ?", c.id);
        let ai = await resolveProjectAi(deps(), pid);
        expect(ai).toMatchObject({ mode: "own", source: "blocked", blocked: AI_NOT_AVAILABLE });
        expect(ai.problem).toMatch(/could not be read/);
        await expect(clientOfConfiguration(deps(), ai).text({ system: "s", prompt: "p" })).rejects.toThrow(AI_NOT_AVAILABLE);
        expect((await refine("t-cora", pid)).status).toBe(422);
        expect((await as("t-cora", "GET", `/api/projects/${pid}/ai`)).body).toMatchObject({ ready: false, problem: expect.stringMatching(/could not be read/) });
        expect(seen).toEqual([]);

        // A project moved to another organisation stops using the old one's key at once.
        const c2 = await orgConfig("t-cora", "Org A", GOOD);
        await useOwn("t-cora", pid, c2.id);
        expect((await resolveProjectAi(deps(), pid)).source).toBe("configuration");
        accessControlOf(app).projects.store.ensureOrganization("org-b");
        platform.db.run("UPDATE projects SET organization_id = 'org-b' WHERE id = ?", pid);
        ai = await resolveProjectAi(deps(), pid);
        expect(ai.source).toBe("blocked");
        expect(ai.problem).toMatch(/another organisation/);
    });

    it("a managed project with a platform configuration uses it, and falls back to the server's key when it fails", async () => {
        const c = (await asKey("POST", "/api/ai-configurations", { ...FIELDS, label: "Platform bad", apiKey: BAD, owner: "platform" })).body;
        const pid = await newProject("t-cora", "Managed with config");
        expect((await as("t-cora", "PUT", `/api/projects/${pid}/ai`, { mode: "managed", configurationId: c.id })).status).toBe(200);
        const ai = await resolveProjectAi(deps(), pid);
        expect(ai).toMatchObject({ mode: "managed", source: "configuration", billing: { owner: "crowd4test" } });
        // The customer knows its name, and nothing about Crowd4Test's key.
        const view = await as("t-cora", "GET", `/api/projects/${pid}/ai`);
        expect(view.body).toMatchObject({ configurationId: c.id, configuration: null, managedOptions: expect.arrayContaining([{ id: c.id, label: "Platform bad", model: "stand-in-main", providerName: "Custom endpoint" }]) });
        expect(view.body.managedOptions.find((o: { id: string }) => o.id === c.id)).not.toHaveProperty("keyEnding");
        expect((await as("t-cora", "POST", `/api/ai-configurations/${c.id}/test`)).status).toBe(404);
        await expect(clientOfConfiguration(deps(), ai).text({ system: "s", prompt: "p" })).resolves.toBe("OK");
        expect(seen).toEqual([BAD, SERVER_KEY]);
        // Marked as failed, or unreadable: the server's key from the start.
        platform.db.run("UPDATE ai_configurations SET status = 'failed' WHERE id = ?", c.id);
        expect((await resolveProjectAi(deps(), pid)).source).toBe("server");
    });

    it("a job uses its project's configuration, with its usage rows, and the server's fallback and fast models never apply", async () => {
        const pid = await newProject("t-cora", "Job");
        const c = await orgConfig("t-cora", "Job key", GOOD);
        await useOwn("t-cora", pid, c.id);
        const cfgs: Config[] = [];
        const makeLlm = (cfg: Config) => {
            cfgs.push(cfg);
            return unavailableLlmClient("double");
        };
        const app1 = platform.repo.createApplication(pid, "http://127.0.0.1:9/", {});
        const queued = await platform.repo.createJob(pid, app1, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] });
        const job = platform.repo.claimNextJob(60_000, "w1")!;
        expect(job.id).toBe(queued.id);
        await runJob({ repo: platform.repo, store: platform.store, config: { ...platform.config, LLM_FALLBACK_MODELS: "server-backup", LLM_MODEL_FAST: "server-fast" }, llm: platform.llm, makeLlm }, job, "w1");
        expect(cfgs).toHaveLength(1);
        expect(cfgs[0]).toMatchObject({ LLM_API_KEY: GOOD, LLM_MODEL: "stand-in-main", LLM_PROVIDER: "openai-compatible", LLM_BASE_URL: PROVIDER });
        expect(cfgs[0]!.LLM_FALLBACK_MODELS).toBeUndefined();
        expect(cfgs[0]!.LLM_MODEL_FAST).toBeUndefined();
    });

    it("a job of a project whose own key cannot be used fails in plain words, without touching the server's key", async () => {
        const pid = await newProject("t-cora", "Job blocked");
        const c = await orgConfig("t-cora", "Gone", GOOD);
        await useOwn("t-cora", pid, c.id);
        platform.db.run("UPDATE ai_configurations SET key_enc = 'broken' WHERE id = ?", c.id);
        const app1 = platform.repo.createApplication(pid, "http://127.0.0.1:9/", {});
        const queued = await platform.repo.createJob(pid, app1, { ...DEFAULT_JOB_OPTIONS, mode: "generate" });
        const job = platform.repo.claimNextJob(60_000, "w2")!;
        expect(job.id).toBe(queued.id);
        const cfgs: Config[] = [];
        await runJob({ repo: platform.repo, store: platform.store, config: platform.config, llm: platform.llm, makeLlm: (cfg) => (cfgs.push(cfg), unavailableLlmClient("double")) }, job, "w2");
        expect(cfgs).toEqual([]);
        expect(platform.repo.getJob(job.id)).toMatchObject({ status: "FAILED", error: AI_NOT_AVAILABLE });
        expect(seen).toEqual([]);
    });
});

describe("Test this key", () => {
    it("says plainly that a good key worked and records it, as a call its owner pays for", async () => {
        const c = await orgConfig("t-cora", "Good", GOOD);
        const r = await as("t-cora", "POST", `/api/ai-configurations/${c.id}/test`);
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ ok: true, configuration: { status: "working", statusNote: null } });
        expect(r.body.message).toMatch(/It worked/);
        expect(r.body.configuration.lastValidatedAt).toBeTruthy();
        expect(seen).toEqual([GOOD]);
        expect(platform.db.get("SELECT billing_owner, billing_organization_id FROM ai_usage WHERE job_id = ?", `key-test-${c.id}`)).toMatchObject({ billing_owner: "organization", billing_organization_id: "org-a" });
    });

    it("says plainly that a bad key did not work, never repeats the key, and asks to wait before hammering the provider", async () => {
        const c = await orgConfig("t-cora", "Bad", BAD);
        const r = await as("t-cora", "POST", `/api/ai-configurations/${c.id}/test`);
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ ok: false, configuration: { status: "failed" } });
        expect(r.body.message).toMatch(/did not work.*refused this key/);
        expect(r.text).not.toContain(BAD);
        expect(r.body.configuration.statusNote).not.toContain(BAD);
        expect((await as("t-cora", "POST", `/api/ai-configurations/${c.id}/test`)).status).toBe(429);
        expect(seen).toEqual([BAD]);
    });
});

describe("permissions", () => {
    it("a tester sees only whether AI is available, and is refused everything about keys", async () => {
        const pid = await newProject("t-cora", "Tester view");
        await addMember(pid, "t-tim");
        const c = await orgConfig("t-cora", "Org key", GOOD);
        await useOwn("t-cora", pid, c.id);
        const view = await as("t-tim", "GET", `/api/projects/${pid}/ai`);
        expect(view.status).toBe(200);
        expect(Object.keys(view.body).sort()).toEqual(["available", "ready", "runsHere"]);
        expect((await as("t-tim", "GET", "/api/ai-configurations")).status).toBe(403);
        expect((await as("t-tim", "PUT", `/api/projects/${pid}/ai`, { mode: "managed" })).status).toBe(403);
        expect((await as("t-tim", "POST", `/api/projects/${pid}/ai/configurations`, { ...FIELDS, label: "x", apiKey: GOOD })).status).toBe(403);
        expect((await as("t-tim", "POST", "/api/ai-configurations", { ...FIELDS, label: "x", apiKey: GOOD, owner: "organization" })).status).toBe(403);
        expect((await as("t-tim", "POST", `/api/ai-configurations/${c.id}/test`)).status).toBe(403);
        expect((await as("t-tim", "DELETE", `/api/ai-configurations/${c.id}`)).status).toBe(403);
    });

    it("someone with usage but not keys sees who pays and the budget, and no configuration", async () => {
        const pid = await newProject("t-cora", "Usage only");
        await addMember(pid, "t-rita");
        const view = (await as("t-rita", "GET", `/api/projects/${pid}/ai`)).body;
        expect(view).toMatchObject({ mode: "managed", billingOwner: "crowd4test", canManage: false, budget: { monthlyTokens: null } });
        for (const k of ["configuration", "ownOptions", "managedOptions", "providers"]) expect(view).not.toHaveProperty(k);
    });

    it("a customer stays inside their organisation", async () => {
        const a = await orgConfig("t-cora", "Org A key", GOOD);
        const pidB = await newProject("t-bob", "Org B project");
        // The configuration of another organisation answers as if it did not exist.
        expect((await as("t-bob", "GET", "/api/ai-configurations")).body.configurations.some((c: { id: string }) => c.id === a.id)).toBe(false);
        for (const [m, u, b] of [["PATCH", `/api/ai-configurations/${a.id}`, { label: "Mine now" }], ["POST", `/api/ai-configurations/${a.id}/test`, undefined], ["DELETE", `/api/ai-configurations/${a.id}`, undefined]] as const) {
            const r = await as("t-bob", m, u, b);
            expect(r.status).toBe(404);
            expect(r.body.error).toBe("AI configuration not found");
        }
        expect((await useOwn("t-bob", pidB, a.id)).status).toBe(404);
        // A project of another organisation is not reachable at all.
        const pidA = await newProject("t-cora", "Org A project");
        expect((await as("t-bob", "GET", `/api/projects/${pidA}/ai`)).status).toBe(404);
        expect((await as("t-bob", "PUT", `/api/projects/${pidA}/ai`, { mode: "managed" })).status).toBe(404);
        // Nor can a customer put a configuration on another organisation or the platform.
        expect((await as("t-bob", "POST", "/api/ai-configurations", { ...FIELDS, label: "x", apiKey: GOOD, owner: "organization", organizationId: "org-a" })).status).toBe(403);
        expect((await as("t-bob", "POST", "/api/ai-configurations", { ...FIELDS, label: "x", apiKey: GOOD, owner: "platform" })).status).toBe(403);
        // A project's own configuration is that project's alone: another project of the same organisation cannot pick it.
        const pidA2 = await newProject("t-cora", "Org A second");
        const own = (await as("t-cora", "POST", `/api/projects/${pidA}/ai/configurations`, { ...FIELDS, label: "Project key", apiKey: GOOD })).body;
        expect((await useOwn("t-cora", pidA2, own.id)).status).toBe(404);
    });

    it("every change of who pays is in Activity, and a configuration in use cannot be removed", async () => {
        const pid = await newProject("t-cora", "Audited");
        const c = await orgConfig("t-cora", "In use", GOOD);
        await useOwn("t-cora", pid, c.id);
        await as("t-cora", "PUT", `/api/projects/${pid}/ai`, { mode: "managed" });
        const rows = platform.db.all<{ action: string; detail: string }>("SELECT action, detail FROM activity WHERE project_id = ? AND action = 'ai-configuration-changed'", pid);
        expect(rows.map((r) => r.detail)).toEqual([expect.stringMatching(/organisation pays/), expect.stringMatching(/Crowd4Test pays/)]);

        await useOwn("t-cora", pid, c.id);
        const refused = await as("t-cora", "DELETE", `/api/ai-configurations/${c.id}`);
        expect(refused.status).toBe(409);
        expect(refused.body.error).toMatch(/A project uses this configuration/);
        await as("t-cora", "PUT", `/api/projects/${pid}/ai`, { mode: "managed" });
        expect((await as("t-cora", "DELETE", `/api/ai-configurations/${c.id}`)).status).toBe(204);
    });
});

describe("budgets and usage", () => {
    it("a project on its own key is held to its own limits, and the platform's monthly total counts only what Crowd4Test pays for", async () => {
        const own = await newProject("t-cora", "Budget own");
        const managed = await newProject("t-cora", "Budget managed");
        const c = await orgConfig("t-cora", "Budget key", GOOD);
        await useOwn("t-cora", own, c.id);
        const usage = usageStoreFor(platform.db, platform.config);
        const month = new Date().toISOString().slice(0, 7);
        const base = usage.monthTokens(month);
        const row = { purpose: "other", model: "m", at: new Date(), calls: 1, failedCalls: 0, inputTokens: 1000, outputTokens: 0, images: 0, estimatedCalls: 0 };
        usage.addUsage({ ...row, jobId: "own-job", projectId: own, billing: { owner: "organization", organizationId: "org-a" } });
        usage.addUsage({ ...row, jobId: "managed-job", projectId: managed });
        expect(usage.monthTokens(month)).toBe(base + 1000);
        expect(usage.monthTokens(month, own)).toBe(1000);

        usage.setPlatformBudget({ monthlyTokens: 1, jobTokens: 1 });
        usage.setProjectBudget(own, { monthlyTokens: 5000, jobTokens: 900 });
        try {
            expect(usage.capsFor(own).caps).toEqual({ month: null, project: 5000, job: 900 });
            expect(usage.monthlyBlock(own)).toBeNull();
            expect(usage.monthlyBlock(managed)?.cap).toBe("month");
        } finally {
            usage.setPlatformBudget({ monthlyTokens: null, jobTokens: null });
        }
        const view = (await as("t-cora", "GET", `/api/projects/${own}/ai`)).body;
        expect(view.budget).toMatchObject({ monthlyTokens: 5000, jobTokens: 900, usedTokens: 1000 });
        expect(view.usageByOwner).toEqual([expect.objectContaining({ owner: "organization", totalTokens: 1000 })]);
        const grouped = (await asKey("GET", `/api/usage?groupBy=billing&projectId=${own}`)).body;
        expect(grouped.groups.map((g: { key: string }) => g.key)).toEqual(["organization"]);
        expect((await asKey("GET", `/api/jobs/own-job/usage`)).status).toBe(404);
    });
});

describe("the hosted preview", () => {
    it("says that nothing runs here and that the server has no key, and a project's own key still counts as ready", async () => {
        const hostedDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-aiconfig-hosted-"));
        const hosted = bootstrap(loadConfig({ DATA_DIR: hostedDir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECRET_KEY: SECRET, LLM_PROVIDER: "anthropic", LLM_API_KEY: "" } as never));
        const server = await buildServer(hosted);
        try {
            const h = { "x-api-key": KEY };
            const req = async (method: string, url: string, payload?: object) => JSON.parse((await server.inject({ method: method as "GET", url, headers: h, ...(payload ? { payload } : {}) })).body);
            const pid = (await req("POST", "/api/projects", { name: "Hosted" })).id;
            expect(await req("GET", "/api/ai-configurations")).toMatchObject({ server: { hasKey: false, runsHere: false } });
            expect(await req("GET", `/api/projects/${pid}/ai`)).toMatchObject({ available: false, ready: false, runsHere: false, serverHasKey: false, mode: "managed" });
            const c = await req("POST", `/api/projects/${pid}/ai/configurations`, { ...FIELDS, label: "Own", apiKey: GOOD });
            await req("PUT", `/api/projects/${pid}/ai`, { mode: "own", configurationId: c.id });
            expect(await req("GET", `/api/projects/${pid}/ai`)).toMatchObject({ available: false, ready: true, runsHere: false, mode: "own" });
        } finally {
            await server.close();
            hosted.db.close();
            fs.rmSync(hostedDir, { recursive: true, force: true });
        }
    });
});
