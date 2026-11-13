/**
 * AI keys (round 57, docs/features/ai-keys.md): two kinds, organisational (Crowd4Test admins add them and assign them to admins and
 * sub-admins) and personal (a person's own), and one chosen key per person that all their AI work uses. Against a stand-in Crowd4Test sign-in
 * (port 7825), a stand-in OpenAI-compatible provider that records which key each call carried (port 7826) and a real platform through inject.
 * No real provider is ever called. Covers: a key is encrypted and write-only; who sees which key, through every route; assignment only to
 * admins and sub-admins; resolution (chosen personal, chosen organisational, assignment taken away, key removed, no key, the open server,
 * a schedule's maker) and that the server's key is never used for a signed-in person; usage rows say who pays; "Test this key".
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { jobOwnerId, makerIdOfActor, OPEN_OWNER_ID } from "../src/platform/agent-store.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { RepoSink } from "../src/platform/repo-sink.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { PERSONAL_KEY_MODEL } from "../src/platform/usage-store.js";
import { ACCESS_KEY_OWNER, aiGate, aiOwnerOfJob, KEY_NOT_AVAILABLE, mayHoldOrganisational, PERSON_INACTIVE, NO_AI_KEY, NO_PERSON, personLlm, resolveAiFor } from "../src/platform/ai-config.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
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
const CORA_KEY = "CORA-own-key-sentinel-1234";
const ORG_KEY = "ORG-shared-key-sentinel-5678";
const BAD = "BAD-own-key-sentinel-9999";
const PAGE = { "x-requested-with": "ai-studio" };

const me = (id: string, role: string, permissions: readonly string[], organisationId: string | null = null) => ({
    data: { user: { id, email: `${id}@people.example`, role, status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions, organisationId } },
});
const ACCOUNTS: Record<string, unknown> = {
    "t-admin": me("ada", "ADMIN", PERMISSIONS),
    "t-sam": me("sam", "SUB_ADMIN", PERMISSIONS),
    "t-cora": me("cora", "CUSTOMER", PERMISSIONS, "org-a"),
    "t-bob": me("bob", "CUSTOMER", PERMISSIONS, "org-b"),
    // A tester who may use the AI, and one who may not.
    "t-tia": me("tia", "TESTER", ["ai_studio.access", "ai_studio.tests.generate"]),
    "t-tim": me("tim", "TESTER", ["ai_studio.access"]),
};

let c4t: http.Server;
let fakeProvider: http.Server;
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
/** Every Authorization key the stand-in provider received, in order. */
let seen: string[] = [];
const ids: Record<string, string> = {};

const call = async (headers: Record<string, string>, method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as "GET", url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: r.statusCode, text: r.body, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body } as { status: number; text: string; body: any };
};
const asKey = (method: string, url: string, payload?: unknown) => call({ "x-api-key": KEY }, method, url, payload);
const as = (token: string, method: string, url: string, payload?: unknown) => call({ cookie: `c4t_access=${token}`, ...(method === "GET" ? {} : PAGE) }, method, url, payload);
const FIELDS = { provider: "openai-compatible", model: "stand-in-main", baseUrl: PROVIDER };
const personalKey = async (token: string, label: string, apiKey: string) => {
    const r = await as(token, "POST", "/api/me/ai/keys", { ...FIELDS, label, apiKey });
    expect(r.status, r.text).toBe(201);
    return r.body.key as { id: string; keyHint: string; chosen: boolean; kind: string };
};
const orgKey = async (label: string, apiKey: string) => {
    const r = await as("t-admin", "POST", "/api/admin/ai-keys", { ...FIELDS, label, apiKey });
    expect(r.status, r.text).toBe(201);
    return r.body.key as { id: string };
};
const assign = (keyId: string, people: string[]) => as("t-admin", "PUT", `/api/admin/ai-keys/${keyId}/assignees`, { personIds: people.map((t) => ids[t]!) });
const deps = () => ({ sql: platform.sql, config: platform.config });
const reset = () => {
    platform.db.run("DELETE FROM ai_key_choices");
    platform.db.run("DELETE FROM ai_key_assignees");
    platform.db.run("DELETE FROM ai_configurations");
};

beforeAll(async () => {
    c4t = http.createServer((req, res) => {
        const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        res.writeHead(ACCOUNTS[auth] ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ACCOUNTS[auth] ?? { error: { message: "Invalid access token" } }));
    });
    await new Promise<void>((r) => c4t.listen(C4T_PORT, "127.0.0.1", r));
    fakeProvider = http.createServer((req, res) => {
        req.resume();
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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-aikeys-"));
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
    for (const t of Object.keys(ACCOUNTS)) ids[t] = (await as(t, "GET", "/api/auth/state")).body.me.id;
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
    reset();
});

describe("a key is stored once and never comes back", () => {
    it("is encrypted at rest, shown only by its ending, and never returned by any route", async () => {
        const k = await personalKey("t-cora", "Cora's key", CORA_KEY);
        expect(k).toMatchObject({ keyHint: "1234", kind: "personal", chosen: true });
        const o = await orgKey("Crowd4Test key", ORG_KEY);
        await assign(o.id, ["t-sam"]);
        const raw = platform.db.all<{ key_enc: string }>("SELECT key_enc FROM ai_configurations");
        for (const r of raw) {
            expect(r.key_enc).not.toContain(CORA_KEY);
            expect(r.key_enc).not.toContain(ORG_KEY);
        }
        expect(new SecretBox(dir, SECRET).decrypt(raw.find(() => true)!.key_enc)).toMatch(/sentinel/);
        const answers = [
            await as("t-cora", "GET", "/api/me/ai"),
            await as("t-sam", "GET", "/api/me/ai"),
            await as("t-admin", "GET", "/api/admin/ai-keys"),
            await as("t-cora", "PATCH", `/api/me/ai/keys/${k.id}`, { label: "Renamed" }),
            await as("t-admin", "PATCH", `/api/admin/ai-keys/${o.id}`, { label: "Renamed too" }),
            await as("t-admin", "GET", "/api/config"),
            await as("t-cora", "GET", "/api/config"),
        ];
        for (const a of answers) {
            expect(a.status, a.text).toBeLessThan(300);
            expect(a.text).not.toContain(CORA_KEY);
            expect(a.text).not.toContain(ORG_KEY);
        }
    });

    it("needs the key entered again when the provider or the address changes, and refuses an address with a password in it", async () => {
        const k = await personalKey("t-cora", "Moving", CORA_KEY);
        expect((await as("t-cora", "PATCH", `/api/me/ai/keys/${k.id}`, { baseUrl: "http://127.0.0.1:1/v1" })).status).toBe(400);
        expect((await as("t-cora", "PATCH", `/api/me/ai/keys/${k.id}`, { baseUrl: `${PROVIDER}/`, apiKey: CORA_KEY })).status).toBe(200);
        const r = await as("t-cora", "POST", "/api/me/ai/keys", { ...FIELDS, baseUrl: "http://user:pw@127.0.0.1:1/v1", label: "x", apiKey: CORA_KEY });
        expect(r.status).toBe(400);
        expect(r.body.error).toBe("Put the key in the key field, not in the address.");
    });
});

describe("who sees which key", () => {
    it("a personal key exists only for its person: not for another person, not for an admin, through every route", async () => {
        const k = await personalKey("t-cora", "Cora only", CORA_KEY);
        for (const t of ["t-bob", "t-admin", "t-sam"]) {
            const mine = (await as(t, "GET", "/api/me/ai")).body;
            expect(JSON.stringify(mine)).not.toContain(k.id);
            expect((await as(t, "PATCH", `/api/me/ai/keys/${k.id}`, { label: "x" })).status).toBe(404);
            expect((await as(t, "DELETE", `/api/me/ai/keys/${k.id}`)).status).toBe(404);
            expect((await as(t, "POST", `/api/me/ai/keys/${k.id}/test`, {})).status).toBe(404);
            expect((await as(t, "PUT", "/api/me/ai/chosen", { keyId: k.id })).status).toBe(404);
        }
        // Admins manage organisational keys only: a personal key is not one of them.
        expect(JSON.stringify((await as("t-admin", "GET", "/api/admin/ai-keys")).body)).not.toContain(k.id);
        expect((await as("t-admin", "PATCH", `/api/admin/ai-keys/${k.id}`, { label: "x" })).status).toBe(404);
        expect((await as("t-admin", "DELETE", `/api/admin/ai-keys/${k.id}`)).status).toBe(404);
        expect((await as("t-cora", "GET", "/api/me/ai")).body).toMatchObject({ chosen: { id: k.id, kind: "personal" }, personal: [{ id: k.id }], organisational: [], problem: null, canManageOrganisational: false, openServer: null });
    });

    it("an organisational key exists only for the people it is assigned to; admins see all of them", async () => {
        const o = await orgKey("Team key", ORG_KEY);
        // Not assigned yet: the sub-admin does not see it and cannot choose it.
        expect((await as("t-sam", "GET", "/api/me/ai")).body.organisational).toEqual([]);
        expect((await as("t-sam", "PUT", "/api/me/ai/chosen", { keyId: o.id })).status).toBe(404);
        expect((await as("t-admin", "GET", "/api/admin/ai-keys")).body.keys).toEqual([expect.objectContaining({ id: o.id, kind: "organisational", assignees: [] })]);
        expect((await assign(o.id, ["t-sam"])).body.key.assignees).toEqual([expect.objectContaining({ id: ids["t-sam"], role: "Sub-admin" })]);
        const sam = (await as("t-sam", "GET", "/api/me/ai")).body;
        expect(sam.organisational).toEqual([expect.objectContaining({ id: o.id, kind: "organisational", chosen: false })]);
        expect(sam.problem).toBe(NO_AI_KEY);
        // Assigned people may use and test it, not change or remove it.
        expect((await as("t-sam", "PUT", "/api/me/ai/chosen", { keyId: o.id })).body).toMatchObject({ chosen: { id: o.id }, problem: null });
        expect((await as("t-sam", "PATCH", `/api/me/ai/keys/${o.id}`, { label: "x" })).status).toBe(404);
        expect((await as("t-sam", "POST", `/api/me/ai/keys/${o.id}/test`, {})).body).toMatchObject({ ok: true });
        // Another admin not assigned does not see it among their own.
        expect((await as("t-admin", "GET", "/api/me/ai")).body.organisational).toEqual([]);
        expect((await as("t-cora", "GET", "/api/me/ai")).body.organisational).toEqual([]);
    });

    it("only admins and sub-admins can be assigned, and only Crowd4Test admins manage organisational keys", async () => {
        const o = await orgKey("Staff only", ORG_KEY);
        const refused = await assign(o.id, ["t-sam", "t-cora"]);
        expect(refused.status).toBe(400);
        expect(refused.body.error).toBe("Organisational keys can be assigned only to Crowd4Test admins and sub-admins.");
        expect((await assign(o.id, ["t-tia"])).status).toBe(400);
        const list = (await as("t-admin", "GET", "/api/admin/ai-keys")).body.people.map((p: { id: string }) => p.id);
        expect(list).toEqual(expect.arrayContaining([ids["t-admin"], ids["t-sam"]]));
        expect(list).not.toContain(ids["t-cora"]);
        expect(list).not.toContain(ids["t-tia"]);
        // A sub-admin (and anyone else who is not a Crowd4Test admin) is refused the management routes.
        for (const t of ["t-sam", "t-cora", "t-tia"]) {
            expect((await as(t, "GET", "/api/admin/ai-keys")).status).toBe(403);
            expect((await as(t, "POST", "/api/admin/ai-keys", { ...FIELDS, label: "x", apiKey: ORG_KEY })).status).toBe(403);
            expect((await as(t, "PUT", `/api/admin/ai-keys/${o.id}/assignees`, { personIds: [] })).status).toBe(403);
        }
        expect((await as("t-admin", "GET", "/api/me/ai")).body.canManageOrganisational).toBe(true);
        expect((await as("t-sam", "GET", "/api/me/ai")).body.canManageOrganisational).toBe(false);
    });

    it("every account that may use AI has keys of its own; the shared access key and a tester without AI permission do not", async () => {
        const t = await personalKey("t-tia", "Tester's own", CORA_KEY);
        expect((await as("t-tia", "GET", "/api/me/ai")).body.chosen).toMatchObject({ id: t.id });
        expect((await as("t-tim", "GET", "/api/me/ai")).status).toBe(403);
        expect((await as("t-tim", "POST", "/api/me/ai/keys", { ...FIELDS, label: "x", apiKey: CORA_KEY })).status).toBe(403);
        const key = await asKey("GET", "/api/me/ai");
        expect(key.status).toBe(403);
        expect(key.body.error).toBe("Sign in with your own account to add and use AI keys.");
    });
});

describe("which key the work uses", () => {
    it("the chosen personal key, never the server's, and its usage names the person", async () => {
        const k = await personalKey("t-cora", "Cora", CORA_KEY);
        const r = await personLlm(deps(), ids["t-cora"]!);
        expect(r.billing).toEqual({ owner: "personal", personId: ids["t-cora"] });
        await r.llm.text({ system: "s", prompt: "p", maxOutputTokens: 8, purpose: "other" });
        expect(seen).toEqual([CORA_KEY]);
        expect(await resolveAiFor(deps(), ids["t-cora"]!)).toMatchObject({ source: "configuration", configuration: { id: k.id } });
    });

    it("the chosen organisational key: Crowd4Test pays; taking the assignment away or removing the key stops it, with a sentence", async () => {
        const o = await orgKey("Shared", ORG_KEY);
        await assign(o.id, ["t-sam"]);
        await as("t-sam", "PUT", "/api/me/ai/chosen", { keyId: o.id });
        const r = await personLlm(deps(), ids["t-sam"]!);
        expect(r.billing).toEqual({ owner: "crowd4test" });
        await r.llm.text({ system: "s", prompt: "p", maxOutputTokens: 8, purpose: "other" });
        expect(seen).toEqual([ORG_KEY]);
        // Taken away: the choice goes with it, and the person is told.
        await assign(o.id, []);
        expect((await resolveAiFor(deps(), ids["t-sam"]!)).blocked).toBe(NO_AI_KEY);
        // Assigned again and chosen, then the person stops being staff: no longer usable.
        await assign(o.id, ["t-sam"]);
        await as("t-sam", "PUT", "/api/me/ai/chosen", { keyId: o.id });
        platform.db.run("UPDATE users SET c4t_role = 'CUSTOMER' WHERE id = ?", ids["t-sam"]!);
        expect((await resolveAiFor(deps(), ids["t-sam"]!)).blocked).toBe(KEY_NOT_AVAILABLE);
        platform.db.run("UPDATE users SET c4t_role = 'SUB_ADMIN' WHERE id = ?", ids["t-sam"]!);
        // Removed by an admin while chosen: the choice clears.
        expect((await as("t-admin", "DELETE", `/api/admin/ai-keys/${o.id}`)).status).toBe(204);
        expect((await as("t-sam", "GET", "/api/me/ai")).body).toMatchObject({ chosen: null, problem: NO_AI_KEY, organisational: [] });
    });

    it("no key: AI work is refused with the sentence, and nothing reaches the provider; no person behind it: refused too", async () => {
        expect(await aiGate({ ...deps(), llm: platform.llm }, ids["t-bob"]!)).toEqual({ ok: false, reason: NO_AI_KEY });
        const r = await personLlm(deps(), ids["t-bob"]!);
        expect(r.blocked).toBe(NO_AI_KEY);
        await expect(r.llm.text({ system: "s", prompt: "p", maxOutputTokens: 8, purpose: "other" })).rejects.toThrow();
        expect((await resolveAiFor(deps(), null)).blocked).toBe(NO_PERSON);
        // The connection check is of the person's own key (an admin with none: there is nothing to check).
        const check = await as("t-admin", "POST", "/api/llm/check", {});
        expect(check.status).toBe(409);
        expect(check.body.error).toBe(NO_AI_KEY);
        expect(seen).toEqual([]);
    });

    it("the open server uses its chosen key if it has one, else the server's own key; so does the shared access key, never a person", async () => {
        expect(await resolveAiFor(deps(), OPEN_OWNER_ID)).toMatchObject({ source: "server", billing: { owner: "crowd4test" } });
        expect(await resolveAiFor(deps(), ACCESS_KEY_OWNER)).toMatchObject({ source: "server", billing: { owner: "crowd4test" } });
        expect((await resolveAiFor(deps(), ids["t-admin"]!)).source).toBe("blocked");
    });

    it("a job uses its starter's key; a schedule's job its maker's; a job without a usable key fails in neutral words", async () => {
        await personalKey("t-cora", "Cora", CORA_KEY);
        const pid = (await as("t-cora", "POST", "/api/projects", { name: "Jobs" })).body.id as string;
        const app1 = platform.repo.createApplication(pid, "http://127.0.0.1:9/", {});
        const runWith = async (startedBy: object, worker: string) => {
            const queued = await platform.repo.createJob(pid, app1, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [], startedBy } as never);
            const job = platform.repo.claimNextJob(60_000, worker)!;
            expect(job.id).toBe(queued.id);
            const cfgs: Config[] = [];
            await runJob({ repo: platform.repo, store: platform.store, config: { ...platform.config, LLM_FALLBACK_MODELS: "server-backup", LLM_MODEL_FAST: "server-fast" }, llm: platform.llm, makeLlm: (cfg) => (cfgs.push(cfg), unavailableLlmClient("double")) }, job, worker);
            return { cfgs, job: platform.repo.getJob(job.id)! };
        };
        const byCora = await runWith({ kind: "user", id: ids["t-cora"] }, "w1");
        expect(byCora.cfgs).toHaveLength(1);
        expect(byCora.cfgs[0]).toMatchObject({ LLM_API_KEY: CORA_KEY, LLM_MODEL: "stand-in-main", LLM_BASE_URL: PROVIDER });
        expect(byCora.cfgs[0]!.LLM_FALLBACK_MODELS).toBeUndefined();
        expect(byCora.cfgs[0]!.LLM_MODEL_FAST).toBeUndefined();
        const bySchedule = await runWith({ kind: "schedule", id: "s1", ownerId: ids["t-cora"] }, "w2");
        expect(bySchedule.cfgs[0]).toMatchObject({ LLM_API_KEY: CORA_KEY });
        // Bob has no key: his schedule's job never builds a client, and says so without naming anyone.
        const queued = await platform.repo.createJob(pid, app1, { ...DEFAULT_JOB_OPTIONS, mode: "generate", startedBy: { kind: "schedule", id: "s2", ownerId: ids["t-bob"] } } as never);
        const job = platform.repo.claimNextJob(60_000, "w3")!;
        expect(job.id).toBe(queued.id);
        const cfgs: Config[] = [];
        await runJob({ repo: platform.repo, store: platform.store, config: platform.config, llm: platform.llm, makeLlm: (cfg) => (cfgs.push(cfg), unavailableLlmClient("double")) }, job, "w3");
        expect(cfgs).toEqual([]);
        expect(platform.repo.getJob(job.id)).toMatchObject({ status: "FAILED", error: expect.stringContaining("the person who started it has no AI key") });
        expect(seen).not.toContain(SERVER_KEY);
    });
});

describe("Test this key, and usage", () => {
    it("says plainly that a good key worked, and records the call for whoever pays", async () => {
        const k = await personalKey("t-cora", "Good", CORA_KEY);
        const t = await as("t-cora", "POST", `/api/me/ai/keys/${k.id}/test`, {});
        expect(t.body).toMatchObject({ ok: true, key: { id: k.id, status: "working" } });
        const rows = platform.db.all<{ billing_owner: string; billing_person_id: string | null }>("SELECT billing_owner, billing_person_id FROM ai_usage WHERE job_id = ?", `key-test-${k.id}`);
        expect(rows).toEqual([{ billing_owner: "personal", billing_person_id: ids["t-cora"] }]);
    });

    it("says plainly that a bad key did not work, never repeats the key, and asks to wait before testing again", async () => {
        const k = await personalKey("t-cora", "Bad", BAD);
        const t = await as("t-cora", "POST", `/api/me/ai/keys/${k.id}/test`, {});
        expect(t.body.ok).toBe(false);
        expect(t.text).not.toContain(BAD);
        expect((await as("t-cora", "POST", `/api/me/ai/keys/${k.id}/test`, {})).status).toBe(429);
        // A failing chosen key is told on the person's answer.
        expect((await as("t-cora", "GET", "/api/me/ai")).body.problem).toMatch(/^Your chosen AI key cannot be used: /);
    });

    it("work on a personal key is not held to the platform's monthly cap, which counts only what Crowd4Test pays for", async () => {
        const usage = usageStoreFor(platform.db, platform.config);
        const month = new Date().toISOString().slice(0, 7);
        const base = usage.monthTokens(month);
        const row = { projectId: "p-any", purpose: "other", model: "m", at: new Date(), calls: 1, failedCalls: 0, inputTokens: 1000, outputTokens: 0, images: 0, estimatedCalls: 0 };
        usage.addUsage({ ...row, jobId: "personal-job", billing: { owner: "personal", personId: "someone" } });
        usage.addUsage({ ...row, jobId: "crowd4test-job" });
        expect(usage.monthTokens(month)).toBe(base + 1000);
        usage.setPlatformBudget({ monthlyTokens: 1, jobTokens: 1 });
        try {
            expect(usage.capsFor("p-any", { owner: "personal", personId: "someone" }).caps.month).toBeNull();
            expect(usage.capsFor("p-any").caps.month).toBe(1);
        } finally {
            usage.setPlatformBudget({ monthlyTokens: null, jobTokens: null });
        }
        expect(platform.db.get("SELECT billing_owner, billing_person_id FROM ai_usage WHERE job_id = 'personal-job'")).toEqual({ billing_owner: "personal", billing_person_id: "someone" });
    });

    it("every change is in Activity", async () => {
        const o = await orgKey("Noted", ORG_KEY);
        await assign(o.id, ["t-sam"]);
        await as("t-sam", "PUT", "/api/me/ai/chosen", { keyId: o.id });
        const actions = platform.db.all<{ action: string }>("SELECT action FROM activity ORDER BY rowid DESC LIMIT 30").map((r) => r.action);
        expect(actions).toEqual(expect.arrayContaining(["ai-key-added", "ai-key-assigned", "ai-key-chosen"]));
    });
});

describe("nobody else learns about a personal key", () => {
    it("no Activity row, admin list, usage page or job log names a personal key, its provider, model or address", async () => {
        const LABEL = "Cora-private-label-7f3a";
        const MODEL = "cora-private-model-x9";
        const ADDRESS = `${PROVIDER}/cora-private-path`;
        const r = await as("t-cora", "POST", "/api/me/ai/keys", { provider: "openai-compatible", model: MODEL, baseUrl: ADDRESS, label: LABEL, apiKey: CORA_KEY });
        expect(r.status, r.text).toBe(201);
        const id = r.body.key.id as string;
        await as("t-cora", "PATCH", `/api/me/ai/keys/${id}`, { label: `${LABEL}-2` });
        await as("t-cora", "POST", `/api/me/ai/keys/${id}/test`, {});
        await as("t-cora", "PUT", "/api/me/ai/chosen", { keyId: id });
        const pid = (await as("t-cora", "POST", "/api/projects", { name: "Private shop" })).body.id as string;
        const app1 = platform.repo.createApplication(pid, "http://127.0.0.1:9/", {});
        await platform.repo.createJob(pid, app1, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [], startedBy: { kind: "user", id: ids["t-cora"] } } as never);
        const job = platform.repo.claimNextJob(60_000, "w-private")!;
        await runJob({ repo: platform.repo, store: platform.store, config: platform.config, llm: platform.llm, makeLlm: () => unavailableLlmClient("double") }, job, "w-private");
        await as("t-cora", "DELETE", `/api/me/ai/keys/${id}`);
        const secret = [LABEL, MODEL, "cora-private-path"];
        const rows = JSON.stringify(platform.db.all("SELECT * FROM activity"));
        const seenByAdmin = [
            rows,
            (await as("t-admin", "GET", "/api/admin/ai-keys")).text,
            (await as("t-admin", "GET", "/api/activity?limit=200")).text,
            (await as("t-admin", "GET", "/api/usage?groupBy=model")).text,
            (await as("t-admin", "GET", "/api/usage?groupBy=billing")).text,
            (await as("t-admin", "GET", `/api/test-generation/${job.id}/events`)).text,
            (await as("t-admin", "GET", `/api/test-generation/${job.id}`)).text,
        ];
        for (const text of seenByAdmin) for (const s of secret) expect(text).not.toContain(s);
        expect(platform.db.all<{ detail: string }>("SELECT detail FROM activity WHERE action LIKE 'ai-key-%'").map((x) => x.detail)).toEqual(
            expect.arrayContaining(["Their own AI key was added.", "Their own AI key was changed.", "Their AI work now uses their own key.", "Their own AI key was removed."]),
        );
    });
});

describe("review fixes", () => {
    it("with Crowd4Test sign-in, a local owner account neither manages organisational keys nor can be assigned one", async () => {
        const users = accessControlOf(app).users;
        const local = users.create({ email: "local-owner@people.example", name: "Local owner", role: "owner" });
        const token = users.createToken(local.id, { name: "t", role: "owner" }).token;
        const r = await call({ authorization: `Bearer ${token}` }, "GET", "/api/admin/ai-keys");
        expect(r.status).toBe(403);
        expect(await mayHoldOrganisational(deps(), local.id)).toBe(false);
        expect((await as("t-admin", "GET", "/api/admin/ai-keys")).body.people.map((x: { id: string }) => x.id)).not.toContain(local.id);
        const o = await orgKey("Staff only", ORG_KEY);
        expect((await as("t-admin", "PUT", `/api/admin/ai-keys/${o.id}/assignees`, { personIds: [local.id] })).status).toBe(400);
    });

    it("without Crowd4Test sign-in, the server's owners manage organisational keys and can be assigned them", async () => {
        const localDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-aikeys-local-"));
        const lp = bootstrap(loadConfig({ DATA_DIR: localDir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECRET_KEY: SECRET, LLM_PROVIDER: "anthropic", LLM_API_KEY: "" } as never));
        const la = await buildServer(lp);
        try {
            const users = accessControlOf(la).users;
            const owner = users.create({ email: "owner@people.example", name: "Owner", role: "owner" });
            const token = users.createToken(owner.id, { name: "t", role: "owner" }).token;
            const go = async (method: string, url: string, payload?: object) => {
                const r = await la.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
                return { status: r.statusCode, body: JSON.parse(r.body || "{}") };
            };
            const made = await go("POST", "/api/admin/ai-keys", { ...FIELDS, label: "Local org key", apiKey: ORG_KEY });
            expect(made.status).toBe(201);
            expect((await go("PUT", `/api/admin/ai-keys/${made.body.key.id}/assignees`, { personIds: [owner.id] })).status).toBe(200);
            expect(await mayHoldOrganisational({ sql: lp.sql, config: lp.config }, owner.id)).toBe(true);
        } finally {
            await la.close();
            lp.db.close();
            fs.rmSync(localDir, { recursive: true, force: true });
        }
    });

    it("a schedule or trigger made with the shared access key uses the server's key and has no runner owner; an old one without a maker is refused", async () => {
        expect(makerIdOfActor({ kind: "key" })).toBe(ACCESS_KEY_OWNER);
        const fromKey = { startedBy: { kind: "schedule", id: "s1", ownerId: ACCESS_KEY_OWNER } };
        expect(jobOwnerId(fromKey)).toBeNull();
        expect(aiOwnerOfJob(fromKey)).toBe(ACCESS_KEY_OWNER);
        expect(await resolveAiFor(deps(), aiOwnerOfJob(fromKey))).toMatchObject({ source: "server" });
        expect(aiOwnerOfJob({ startedBy: { kind: "trigger", id: "t1", ownerId: ACCESS_KEY_OWNER } })).toBe(ACCESS_KEY_OWNER);
        expect((await resolveAiFor(deps(), aiOwnerOfJob({ startedBy: { kind: "schedule", id: "s0", ownerId: null } }))).blocked).toBe(NO_PERSON);
    });

    it("a person turned off here: their keys and assignments no longer serve their work", async () => {
        await personalKey("t-cora", "Cora", CORA_KEY);
        platform.db.run("UPDATE users SET status = 'disabled' WHERE id = ?", ids["t-cora"]!);
        try {
            expect((await resolveAiFor(deps(), ids["t-cora"]!)).blocked).toBe(PERSON_INACTIVE);
            expect(await mayHoldOrganisational(deps(), ids["t-cora"]!)).toBe(false);
        } finally {
            platform.db.run("UPDATE users SET status = 'active' WHERE id = ?", ids["t-cora"]!);
        }
    });

    it("a test made on a personal key does not name its model in its provenance", async () => {
        const pid = (await as("t-cora", "POST", "/api/projects", { name: "Provenance" })).body.id as string;
        const app1 = platform.repo.createApplication(pid, "http://127.0.0.1:9/", {});
        const job = await platform.repo.createJob(pid, app1, { ...DEFAULT_JOB_OPTIONS, mode: "generate" });
        const sink = new RepoSink(platform.repo, platform.store, { id: job.id, projectId: pid, applicationId: app1, mode: "generate" });
        sink.modelShownAs = PERSONAL_KEY_MODEL;
        const spec = TestSpecSchema.parse({ testId: "WEB-901", title: "Provenance", kind: "web", category: "Smoke", priority: "high", steps: [{ action: "navigate", url: "/" }] });
        const h = await sink.createTest({ spec, framework: "playwright", validation: "PENDING", meta: { model: "cora-private-model-x9", authoring: "authored" } });
        await sink.updateTest(h, { meta: { model: "cora-private-model-x9", authoring: "repaired" } } as never);
        const t = platform.repo.getTest(h.id)!;
        expect(t.generationMeta).toMatchObject({ model: PERSONAL_KEY_MODEL });
        expect(JSON.stringify(t)).not.toContain("cora-private-model-x9");
    });
});

describe("no AI on projects", () => {
    it("the project AI routes are gone", async () => {
        const pid = (await as("t-cora", "POST", "/api/projects", { name: "No AI choice" })).body.id as string;
        expect((await as("t-cora", "GET", `/api/projects/${pid}/ai`)).status).toBe(404);
        expect((await as("t-cora", "PUT", `/api/projects/${pid}/ai`, { mode: "own" })).status).toBe(404);
        expect((await as("t-cora", "GET", "/api/ai-configurations")).status).toBe(404);
        expect(platform.db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_ai_settings'")).toBeUndefined();
    });
});
