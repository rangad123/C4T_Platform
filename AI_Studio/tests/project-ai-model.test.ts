/**
 * A project's AI model (docs/features/ai-keys.md): a project may name a provider and model for its AI work, chosen from the models of the
 * AI keys the saving person may use (personal, or organisational and assigned to them). Every piece of AI work checks again for the person
 * doing it: one who may not use the model gets their default key, and the job says so. The project never holds a key.
 * Against a stand-in Crowd4Test sign-in (port 7944) and a stand-in OpenAI-compatible provider that records each call's key and model
 * (port 7945); no real provider is called.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { modelChoicesOf, personLlm, PROJECT_MODEL_FALLBACK, PROJECT_MODEL_FALLBACK_YOU, PROJECT_MODEL_NOT_YOURS, resolveAiFor } from "../src/platform/ai-config.js";
import { defaultFramework } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { runJob } from "../src/platform/job-runner.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { resetKeyTests } from "../src/platform/routes/ai-config.js";
import { buildServer } from "../src/platform/server.js";
import { unavailableLlmClient } from "../src/engine/llm/provider.js";

const C4T_PORT = 7944;
const PROVIDER_PORT = 7945;
const PROVIDER = `http://127.0.0.1:${PROVIDER_PORT}/v1`;
const SECRET = "project-ai-model-secret-0123456789";
const CORA_A = "CORA-key-a-sentinel-1111";
const CORA_B = "CORA-key-b-sentinel-2222";
const DAN_KEY = "DAN-key-sentinel-3333";
const SAM_OWN = "SAM-own-key-sentinel-4444";
const ORG_KEY = "ORG-key-sentinel-5555";
const SAM_ORG_MODEL = "SAM-own-org-model-sentinel-6666";
const ALL_KEYS = [CORA_A, CORA_B, DAN_KEY, SAM_OWN, ORG_KEY, SAM_ORG_MODEL];
const PAGE = { "x-requested-with": "ai-studio" };

const me = (id: string, role: string, permissions: readonly string[], organisationId: string | null = null) => ({
    data: { user: { id, email: `${id}@people.example`, role, status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions, organisationId } },
});
const ACCOUNTS: Record<string, unknown> = {
    "t-admin": me("ada", "ADMIN", PERMISSIONS),
    "t-sam": me("sam", "SUB_ADMIN", PERMISSIONS),
    "t-cora": me("cora", "CUSTOMER", PERMISSIONS, "org-a"),
    "t-dan": me("dan", "CUSTOMER", PERMISSIONS, "org-a"),
    // On the project, but may not change its settings.
    "t-vic": me("vic", "CUSTOMER", PERMISSIONS.filter((c) => c !== "ai_studio.project.settings"), "org-a"),
};

let c4t: http.Server;
let fakeProvider: http.Server;
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
/** The key and model of every call the stand-in provider received. */
let seen: Array<{ key: string; model: string }> = [];
/** What the stand-in provider answers. */
let replyText = "OK";
const ids: Record<string, string> = {};
let pid = "";
let appId = "";

const call = async (headers: Record<string, string>, method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as "GET", url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: r.statusCode, text: r.body, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body } as { status: number; text: string; body: any };
};
const as = (token: string, method: string, url: string, payload?: unknown) => call({ cookie: `c4t_access=${token}`, ...(method === "GET" ? {} : PAGE) }, method, url, payload);
const deps = () => ({ sql: platform.sql, config: platform.config });
const personalKey = async (token: string, label: string, model: string, apiKey: string) => {
    const r = await as(token, "POST", "/api/me/ai/keys", { provider: "openai-compatible", model, baseUrl: PROVIDER, label, apiKey });
    expect(r.status, r.text).toBe(201);
    return r.body.key as { id: string };
};
const pick = (model: string) => ({ provider: "openai-compatible", model });
const choose = (token: string, model: string | null) => as(token, "PUT", `/api/projects/${pid}/ai-model`, { model: model ? pick(model) : null });
const ask = async (ownerId: string) => {
    const r = await personLlm(deps(), ownerId, pid);
    await r.llm.text({ system: "s", prompt: "p", maxOutputTokens: 8, purpose: "other" });
    return r;
};
/** Runs a job of the project started by this person; returns the settings its model client was built with and its events. */
const runAs = async (personId: string, worker: string) => {
    const queued = await platform.repo.createJob(pid, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [], startedBy: { kind: "user", id: personId } } as never);
    const job = platform.repo.claimNextJob(60_000, worker)!;
    expect(job.id).toBe(queued.id);
    const cfgs: Config[] = [];
    await runJob({ repo: platform.repo, store: platform.store, config: platform.config, llm: platform.llm, makeLlm: (cfg) => (cfgs.push(cfg), unavailableLlmClient("double")) }, job, worker);
    return { cfgs, events: platform.repo.listEvents(job.id) as Array<{ kind: string; message: string }> };
};

beforeAll(async () => {
    c4t = http.createServer((req, res) => {
        const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        res.writeHead(ACCOUNTS[auth] ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ACCOUNTS[auth] ?? { error: { message: "Invalid access token" } }));
    });
    await new Promise<void>((r) => c4t.listen(C4T_PORT, "127.0.0.1", r));
    fakeProvider = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            seen.push({ key: String(req.headers.authorization ?? "").replace(/^Bearer /, ""), model: (JSON.parse(body || "{}") as { model?: string }).model ?? "" });
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "stand-in", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: replyText } }], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } }));
        });
    });
    await new Promise<void>((r) => fakeProvider.listen(PROVIDER_PORT, "127.0.0.1", r));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-project-ai-model-"));
    platform = bootstrap(
        loadConfig({
            DATA_DIR: dir,
            SCHEDULER_ENABLED: "false",
            WORKER_EMBEDDED: "false",
            API_KEY: "project-ai-model-access-key-1",
            SECRET_KEY: SECRET,
            C4T_API_ORIGIN: `http://127.0.0.1:${C4T_PORT}`,
            C4T_SITE_URL: "https://crowd4test.example",
            LLM_RETRY_ATTEMPTS: "1",
        } as never),
    );
    app = await buildServer(platform);
    await app.ready();
    for (const t of Object.keys(ACCOUNTS)) ids[t] = (await as(t, "GET", "/api/auth/state")).body.me.id;
    pid = (await as("t-cora", "POST", "/api/projects", { name: "AI model project" })).body.id as string;
    appId = platform.repo.createApplication(pid, "http://127.0.0.1:9/", {});
    for (const t of ["t-sam", "t-dan", "t-vic"]) expect((await as("t-admin", "POST", `/api/projects/${pid}/members`, { personId: ids[t] })).status, t).toBe(201);
    // Cora: two keys of her own, the first one chosen. Dan: one. Sam: one of his own, and the organisational key assigned to him.
    await personalKey("t-cora", "Cora A", "model-a", CORA_A);
    await personalKey("t-cora", "Cora B", "model-b", CORA_B);
    await personalKey("t-dan", "Dan", "model-dan", DAN_KEY);
    await personalKey("t-sam", "Sam", "model-sam", SAM_OWN);
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    await new Promise((r) => c4t?.close(r));
    await new Promise((r) => fakeProvider?.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
    seen = [];
    replyText = "OK";
    resetKeyTests();
    platform.db.run("UPDATE projects SET ai_provider = NULL, ai_model = NULL WHERE id = ?", pid);
    platform.db.run("DELETE FROM ai_configurations WHERE owner_kind = 'organisational'");
});

const orgKeyForSam = async () => {
    const r = await as("t-admin", "POST", "/api/admin/ai-keys", { provider: "openai-compatible", model: "model-org", baseUrl: PROVIDER, label: "Shared", apiKey: ORG_KEY });
    expect(r.status, r.text).toBe(201);
    expect((await as("t-admin", "PUT", `/api/admin/ai-keys/${r.body.key.id}/assignees`, { personIds: [ids["t-sam"]!] })).status).toBe(200);
    return r.body.key.id as string;
};

describe("choosing a project's AI model", () => {
    it("offers only the models the asking person may use, and empty means each person's default", async () => {
        await orgKeyForSam();
        const cora = await as("t-cora", "GET", `/api/projects/${pid}/ai-model`);
        expect(cora.status, cora.text).toBe(200);
        expect(cora.body).toEqual({ selected: null, selectedYours: true, choices: [{ ...pick("model-a"), providerWords: "Custom endpoint" }, { ...pick("model-b"), providerWords: "Custom endpoint" }] });
        // Sam may use his own key and the organisational one assigned to him; nobody else's.
        const sam = (await as("t-sam", "GET", `/api/projects/${pid}/ai-model`)).body;
        expect(sam.choices.map((c: { model: string }) => c.model).sort()).toEqual(["model-org", "model-sam"]);
        // Nothing chosen: Cora's work uses her chosen key, with nothing said.
        const r = await ask(ids["t-cora"]!);
        expect(r.note).toBeUndefined();
        expect(seen).toEqual([{ key: CORA_A, model: "model-a" }]);
    });

    it("an allowed model is saved and used by routes and jobs, through the key that has it", async () => {
        const saved = await choose("t-cora", "model-b");
        expect(saved.status, saved.text).toBe(200);
        expect(saved.body.selected).toEqual(pick("model-b"));
        const r = await ask(ids["t-cora"]!);
        expect(r.note).toBeUndefined();
        expect(r.billing).toEqual({ owner: "personal", personId: ids["t-cora"] });
        expect(seen).toEqual([{ key: CORA_B, model: "model-b" }]);
        const job = await runAs(ids["t-cora"]!, "w-allowed");
        expect(job.cfgs[0]).toMatchObject({ LLM_API_KEY: CORA_B, LLM_MODEL: "model-b" });
        expect(job.events.map((e) => e.kind)).not.toContain("ai_model_fallback");
        // An organisational model assigned to the person: Crowd4Test pays.
        await orgKeyForSam();
        expect((await choose("t-sam", "model-org")).status).toBe(200);
        seen = [];
        expect((await ask(ids["t-sam"]!)).billing).toEqual({ owner: "crowd4test" });
        expect(seen).toEqual([{ key: ORG_KEY, model: "model-org" }]);
        // Back to empty.
        expect((await choose("t-sam", null)).body.selected).toBeNull();
    });

    it("a model the person may not use is refused at save with its sentence, and nothing changes", async () => {
        await orgKeyForSam();
        for (const model of ["model-org", "model-dan", "no-such-model"]) {
            const r = await choose("t-cora", model);
            expect(r.status, model).toBe(403);
            expect(r.body.error).toBe(PROJECT_MODEL_NOT_YOURS);
        }
        // Another provider with the same model name is not the same model.
        expect((await as("t-cora", "PUT", `/api/projects/${pid}/ai-model`, { model: { provider: "openai", model: "model-a" } })).status).toBe(403);
        // Without "Change project settings": refused before anything is looked at.
        expect((await as("t-vic", "PUT", `/api/projects/${pid}/ai-model`, { model: null })).status, "without the permission").toBe(403);
        expect(platform.db.get("SELECT ai_provider, ai_model FROM projects WHERE id = ?", pid)).toEqual({ ai_provider: null, ai_model: null });
        // A person who is no longer an admin or sub-admin may not use the organisational key still assigned to them.
        platform.db.run("UPDATE users SET c4t_role = 'CUSTOMER' WHERE id = ?", ids["t-sam"]!);
        try {
            expect((await modelChoicesOf(deps(), ids["t-sam"]!)).map((c) => c.model)).toEqual(["model-sam"]);
        } finally {
            platform.db.run("UPDATE users SET c4t_role = 'SUB_ADMIN' WHERE id = ?", ids["t-sam"]!);
        }
    });

    it("at run time a person who may not use the model gets their default AI, and the job says so in one sentence", async () => {
        expect((await choose("t-cora", "model-b")).status).toBe(200);
        // Another person runs the project's work: their own key, never Cora's.
        const r = await ask(ids["t-dan"]!);
        expect(r.note).toBe(PROJECT_MODEL_FALLBACK_YOU);
        expect(seen).toEqual([{ key: DAN_KEY, model: "model-dan" }]);
        const job = await runAs(ids["t-dan"]!, "w-dan");
        expect(job.cfgs[0]).toMatchObject({ LLM_API_KEY: DAN_KEY, LLM_MODEL: "model-dan" });
        expect(job.events.filter((e) => e.kind === "ai_model_fallback").map((e) => e.message)).toEqual([PROJECT_MODEL_FALLBACK]);
        // The key behind the model was removed: Cora falls back to her chosen key, and is told.
        const b = platform.db.get<{ id: string }>("SELECT id FROM ai_configurations WHERE label = 'Cora B'")!;
        expect((await as("t-cora", "DELETE", `/api/me/ai/keys/${b.id}`)).status).toBe(204);
        seen = [];
        expect((await ask(ids["t-cora"]!)).note).toBe(PROJECT_MODEL_FALLBACK_YOU);
        expect(seen).toEqual([{ key: CORA_A, model: "model-a" }]);
        await personalKey("t-cora", "Cora B", "model-b", CORA_B);
        // The assignment was taken away: Sam's work goes back to his own key, never the organisational one.
        const org = await orgKeyForSam();
        expect((await choose("t-sam", "model-org")).status).toBe(200);
        expect((await as("t-admin", "PUT", `/api/admin/ai-keys/${org}/assignees`, { personIds: [] })).status).toBe(200);
        seen = [];
        expect((await ask(ids["t-sam"]!)).note).toBe(PROJECT_MODEL_FALLBACK_YOU);
        expect(seen).toEqual([{ key: SAM_OWN, model: "model-sam" }]);
        const samJob = await runAs(ids["t-sam"]!, "w-sam");
        expect(samJob.cfgs[0]).toMatchObject({ LLM_API_KEY: SAM_OWN });
        expect(samJob.events.some((e) => e.kind === "ai_model_fallback")).toBe(true);
        // The sentence names no key, label, provider or person.
        for (const word of ["Cora", "Sam", "Shared", "model-org", "openai", ...ALL_KEYS]) for (const sentence of [PROJECT_MODEL_FALLBACK, PROJECT_MODEL_FALLBACK_YOU]) expect(sentence).not.toContain(word);
        expect((await resolveAiFor(deps(), ids["t-dan"]!, pid)).configuration?.ownerPersonId).toBe(ids["t-dan"]);
    });

    it("the project keeps a provider and model only: no key is stored on it or returned by the project API", async () => {
        await orgKeyForSam();
        expect((await choose("t-cora", "model-b")).status).toBe(200);
        // A key sent along is refused, not stored.
        const withKey = await as("t-cora", "PUT", `/api/projects/${pid}/ai-model`, { model: { ...pick("model-b"), apiKey: CORA_B } });
        expect(withKey.status).toBe(400);
        expect((await as("t-cora", "PUT", `/api/projects/${pid}/ai-model`, { model: pick("model-b"), apiKey: CORA_B })).status).toBe(400);
        const row = JSON.stringify(platform.db.get("SELECT * FROM projects WHERE id = ?", pid));
        expect(row).toContain('"ai_model":"model-b"');
        const answers = [
            row,
            (await as("t-cora", "GET", `/api/projects/${pid}`)).text,
            (await as("t-cora", "GET", "/api/projects")).text,
            (await as("t-cora", "GET", `/api/projects/${pid}/ai-model`)).text,
            (await as("t-sam", "GET", `/api/projects/${pid}/ai-model`)).text,
        ];
        for (const text of answers) for (const k of ALL_KEYS) expect(text).not.toContain(k);
        // Nor any key's id: the project names a model, not a key.
        const keyIds = platform.db.all<{ id: string }>("SELECT id FROM ai_configurations").map((r) => r.id);
        for (const k of keyIds) expect(row).not.toContain(k);
    });

    it("with several keys of the model: the chosen key first, then an organisational key assigned to the person, then a personal one", async () => {
        const org = await orgKeyForSam();
        const own = await personalKey("t-sam", "Sam org model", "model-org", SAM_ORG_MODEL);
        expect((await choose("t-sam", "model-org")).status).toBe(200);
        // Sam's chosen key is his first one (model-sam): of the two with the project's model, Crowd4Test's is used, so Sam does not pay.
        let r = await ask(ids["t-sam"]!);
        expect(r.billing).toEqual({ owner: "crowd4test" });
        expect(seen).toEqual([{ key: ORG_KEY, model: "model-org" }]);
        expect((await resolveAiFor(deps(), ids["t-sam"]!, pid)).configuration?.id).toBe(org);
        // His own key of that model chosen: the chosen key is used.
        expect((await as("t-sam", "PUT", "/api/me/ai/chosen", { keyId: own.id })).status).toBe(200);
        seen = [];
        r = await ask(ids["t-sam"]!);
        expect(r.billing).toEqual({ owner: "personal", personId: ids["t-sam"] });
        expect(seen).toEqual([{ key: SAM_ORG_MODEL, model: "model-org" }]);
        // Back to his first key and the assignment taken away: with no organisational key of the model left, his personal one is used.
        expect((await as("t-sam", "PUT", "/api/me/ai/chosen", { keyId: platform.db.get<{ id: string }>("SELECT id FROM ai_configurations WHERE label = 'Sam'")!.id })).status).toBe(200);
        expect((await as("t-admin", "PUT", `/api/admin/ai-keys/${org}/assignees`, { personIds: [] })).status).toBe(200);
        seen = [];
        r = await ask(ids["t-sam"]!);
        expect(r.note).toBeUndefined();
        expect(seen).toEqual([{ key: SAM_ORG_MODEL, model: "model-org" }]);
        expect((await as("t-sam", "DELETE", `/api/me/ai/keys/${own.id}`)).status).toBe(204);
    });
});

describe("AI started from a route tells the person when the project's model was not theirs", () => {
    it("writing test cases, test scripts and suites and reading requirements: the answer carries the sentence, only when it applies", async () => {
        platform.repo.updateProject(pid, { platforms: ["web"], testingModes: ["code"] });
        platform.db.run("UPDATE applications SET url = 'http://127.0.0.1:9/' WHERE project_id = ?", pid);
        const req = await as("t-cora", "POST", `/api/projects/${pid}/requirements`, { ref: "REQ-1", title: "People can sign in" });
        expect(req.status, req.text).toBe(201);
        const kase = await as("t-cora", "POST", `/api/projects/${pid}/manual-cases`, { title: "Sign in works", priority: "high", automation: "automated", steps: [{ action: "Sign in", expected: "The dashboard shows" }] });
        expect(kase.status, kase.text).toBe(201);
        const spec = TestSpecSchema.parse({ testId: "API-001", title: "A script", kind: "api", category: "X", steps: [{ action: "request", method: "GET", path: "/" }] });
        platform.repo.insertTest({ projectId: pid, suiteId: platform.repo.getOrCreateSuite(pid, "X", "x"), jobId: null, spec, framework: defaultFramework("api"), validationStatus: "PENDING" });
        expect((await choose("t-cora", "model-b")).status).toBe(200);
        const routes = async (token: string) => {
            replyText = JSON.stringify({ cases: [{ requirement: "REQ-1", title: `Check sign in ${token}`, priority: "high", type: "automated", steps: [{ action: "Open the page", expected: "The form shows" }] }] });
            const cases = await as(token, "POST", `/api/projects/${pid}/requirements/generate-cases`, { requirementIds: [req.body.id] });
            replyText = "OK";
            // A web case's script is built by a run in the browser (src/platform/case-scripts.ts), whose AI the job says; the route
            // itself asks the AI for phone scripts only, so the project is an Android app for this one call.
            platform.repo.updateProject(pid, { platforms: ["android"] });
            const phoneApp = platform.repo.createApplication(pid, "android-app://com.example.shop", { ...DEFAULT_JOB_OPTIONS, mobile: { appPackage: "com.example.shop" } });
            const scripts = await as(token, "POST", `/api/projects/${pid}/manual-cases/generate-scripts`, { caseIds: [kase.body.id] });
            platform.db.run("DELETE FROM applications WHERE id = ?", phoneApp);
            platform.repo.updateProject(pid, { platforms: ["web"] });
            const refine = await as(token, "POST", `/api/projects/${pid}/requirements/import/refine`, { text: "- People can sign in" });
            replyText = JSON.stringify({ suites: [{ name: `Smoke ${token}`, description: "Quick.", scripts: ["API-001"] }] });
            const suites = await as(token, "POST", `/api/projects/${pid}/test-suites/propose`, {});
            return { cases, scripts, refine, suites };
        };
        // Dan may not use Cora's model: each answer says so, and his own key did the work.
        const dan = await routes("t-dan");
        for (const [name, r] of Object.entries(dan)) {
            expect(r.status, `${name}: ${r.text}`).toBeLessThan(300);
            expect(r.body.aiNote, name).toBe(PROJECT_MODEL_FALLBACK_YOU);
        }
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.every((s) => s.key === DAN_KEY)).toBe(true);
        // Cora may: no sentence.
        seen = [];
        const cora = await routes("t-cora");
        for (const [name, r] of Object.entries(cora)) {
            expect(r.status, `${name}: ${r.text}`).toBeLessThan(300);
            expect(r.body.aiNote, name).toBeUndefined();
        }
        expect(seen.every((s) => s.key === CORA_B)).toBe(true);
    });
});
