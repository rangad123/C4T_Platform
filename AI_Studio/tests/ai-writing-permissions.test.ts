/**
 * The two AI routes that write and save (POST …/requirements/generate-cases, POST …/manual-cases/generate-scripts) need both the AI's
 * permission (ai_studio.tests.generate, as every AI route) and adding tests (ai_studio.tests.write), against a stand-in Crowd4Test
 * sign-in (port 7962) and a local fake AI provider (port 7963; never a real model). An account missing either is refused before the AI
 * is asked; one holding both is let through.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { PERMISSION_WORDS, PERMISSIONS } from "../src/platform/auth/permissions.js";
import { permissionRuleFor } from "../src/platform/auth/roles.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { startFakeProvider, type FakeProvider } from "./fixtures/fake-llm-provider.js";

type App = Awaited<ReturnType<typeof buildServer>>;
const PAGE = { "x-requested-with": "ai-studio" };
const API_PORT = 7962;
const me = (id: string, permissions: readonly string[]) => ({
    data: { user: { id, email: `${id}@people.example`, role: "CUSTOMER", status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions, organisationId: "org-a" } },
});
const BASE = ["ai_studio.access"];
const ACCOUNTS: Record<string, unknown> = {
    "t-cora": me("cora", PERMISSIONS),
    // Adds and edits tests, but may not use the AI to write them.
    "t-wren": me("wren", [...BASE, "ai_studio.tests.write"]),
    // May use the AI, but may not add tests.
    "t-gail": me("gail", [...BASE, "ai_studio.tests.generate"]),
    "t-both": me("both", [...BASE, "ai_studio.tests.write", "ai_studio.tests.generate"]),
};
const SCRIPT = `Test: Verify search\nCategory: Search\n\nGo to /\nExpect the page to contain the text "Boots"\n`;

let api: http.Server;
let fake: FakeProvider;
let platform: Platform;
let app: App;
let dir = "";
let projectId = "";
let reqId = "";
let reqRef = "";

const as = (token: string, method: string, url: string, payload?: unknown) =>
    app
        .inject({ method: method as "GET", url, headers: { cookie: `c4t_access=${token}`, ...(method === "GET" ? {} : PAGE) }, ...(payload !== undefined ? { payload: payload as object } : {}) })
        .then((r) => ({ status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body }));
const casesAnswer = () => ({ text: JSON.stringify({ cases: [{ requirement: reqRef, title: "Verify search", priority: "high", type: "automated", steps: [{ action: "Search boots", expected: "Boots show" }] }] }) });

beforeAll(async () => {
    api = http.createServer((req, res) => {
        const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        res.writeHead(ACCOUNTS[auth] ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ACCOUNTS[auth] ?? { error: { message: "Invalid access token" } }));
    });
    await new Promise<void>((r) => api.listen(API_PORT, "127.0.0.1", r));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    fake = await startFakeProvider(7963);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-ai-writing-"));
    platform = bootstrap(
        loadConfig({
            DATA_DIR: dir,
            SCHEDULER_ENABLED: "false",
            WORKER_EMBEDDED: "false",
            SECRET_KEY: "ai-writing-secret-key-0123456789ab",
            C4T_API_ORIGIN: `http://127.0.0.1:${API_PORT}`,
            C4T_SITE_URL: "https://crowd4test.example",
            LLM_PROVIDER: "openai-compatible",
            LLM_BASE_URL: `${fake.url}/openai/v1`,
            LLM_MODEL: "m",
            LLM_API_KEY: "fake-key",
        }),
    );
    app = await buildServer(platform);
    await app.ready();
    const made = await as("t-cora", "POST", "/api/projects", { name: "Boot shop", platforms: ["web"], testingModes: ["code"] });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    projectId = made.body.id;
    platform.repo.createApplication(projectId, "http://127.0.0.1:7964", { ...DEFAULT_JOB_OPTIONS });
    for (const t of ["t-wren", "t-gail", "t-both"]) {
        const id = (await as(t, "GET", "/api/auth/state")).body.me.id as string;
        accessControlOf(app).projects.store.addMember(projectId, id, { role: "editor", projectAdmin: false, source: "added", addedBy: "test" });
    }
    const r = await as("t-cora", "POST", `/api/projects/${projectId}/requirements`, { title: "Search finds boots" });
    reqId = r.body.id;
    reqRef = r.body.ref;
    expect((await as("t-cora", "POST", `/api/projects/${projectId}/manual-cases`, { title: "Verify search", automation: "automated", steps: [{ action: "Search boots", expected: "Boots show" }] })).status).toBe(201);
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    await fake?.close();
    await new Promise((r) => api?.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("the AI routes that write and save", () => {
    const cases = () => `/api/projects/${projectId}/requirements/generate-cases`;
    const scripts = () => `/api/projects/${projectId}/manual-cases/generate-scripts`;

    it("ask for the AI's permission in the route table, like refining an import", () => {
        expect(permissionRuleFor("POST", "/api/projects/:id/requirements/generate-cases")).toBe("ai_studio.tests.generate");
        expect(permissionRuleFor("POST", "/api/projects/:id/manual-cases/generate-scripts")).toBe("ai_studio.tests.generate");
        expect(permissionRuleFor("POST", "/api/projects/:id/requirements/import/refine")).toBe("ai_studio.tests.generate");
    });

    it("refuse an account that may add tests but not use the AI, before the AI is asked", async () => {
        fake.reset();
        for (const url of [cases(), scripts()]) {
            const r = await as("t-wren", "POST", url, url === cases() ? { requirementIds: [reqId] } : { dryRun: true });
            expect(r.status).toBe(403);
            expect(r.body.error).toBe(`You don't have permission to ${PERMISSION_WORDS["ai_studio.tests.generate"]}. Ask your Crowd4Test administrator.`);
        }
        expect((await as("t-wren", "POST", `/api/projects/${projectId}/requirements/import/refine`, { text: "- Search finds boots" })).status).toBe(403);
        expect(fake.seen).toHaveLength(0);
    });

    it("refuse an account that may use the AI but not add tests, before the AI is asked", async () => {
        fake.reset();
        for (const url of [cases(), scripts()]) {
            const r = await as("t-gail", "POST", url, url === cases() ? { requirementIds: [reqId] } : {});
            expect(r.status).toBe(403);
            expect(r.body.error).toBe(`You don't have permission to ${PERMISSION_WORDS["ai_studio.tests.write"]}. Ask your Crowd4Test administrator.`);
        }
        expect(fake.seen).toHaveLength(0);
        expect((await as("t-cora", "GET", `/api/projects/${projectId}/manual-cases`)).body.total).toBe(1);
    });

    it("let an account holding both write cases and scripts", async () => {
        fake.reset();
        fake.queue("*", casesAnswer());
        const c = await as("t-both", "POST", cases(), { requirementIds: [reqId] });
        expect(c.status, JSON.stringify(c.body)).toBe(201);
        expect(c.body.created).toBe(1);
        fake.reset();
        fake.queue("*", { text: SCRIPT }, { text: SCRIPT });
        const s = await as("t-both", "POST", scripts(), {});
        expect(s.status, JSON.stringify(s.body)).toBe(200);
        expect(s.body.created.length).toBeGreaterThan(0);
    });
});
