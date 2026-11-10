/**
 * The visual builder's platform side, for real: a real platform with its worker and real Chromium run against the sample app.
 * Edit a generated test (change, add, reorder) and watch the script follow and the run pass; a wrong edit fails honestly;
 * invalid, secret, address and shared-element cases; the refusals (hand-written test, run in progress); previews store nothing;
 * a test built from nothing; API key; per-project isolation. Ports: 6130 sample app.
 *
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/builder-api.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const PORT = 6130;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "builder-key-0123456789";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DONE = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];

let sample: ChildProcess;
let platform: Platform;
let worker: Worker;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let locked: { platform: Platform; server: Awaited<ReturnType<typeof buildServer>>; dir: string };

const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, srv = server, headers: Record<string, string> = {}) => {
    const res = await srv.inject({ method, url, payload: payload as never, headers: { ...headers, ...(payload !== undefined ? { "content-type": "application/json" } : {}) } });
    const text = res.body;
    return { status: res.statusCode, body: text && (text.startsWith("{") || text.startsWith("[")) ? JSON.parse(text) : text || null };
};

async function waitJob(jobId: string) {
    for (let i = 0; i < 300; i++) {
        const j = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (DONE.includes(j.status)) return j;
        await sleep(400);
    }
    throw new Error("job did not finish");
}
const detail = async (id: string) => (await call("GET", `/api/tests/${id}`)).body;
const script = async (id: string) => String((await call("GET", `/api/tests/${id}/script`)).body);
const specOf = async (id: string) => (await call("GET", `/api/tests/${id}/spec`)).body;

const searchSpec = {
    title: "Search finds products",
    kind: "web",
    category: "Shop",
    priority: "high",
    steps: [
        { action: "navigate", url: "/products" },
        { action: "fill", locator: { by: "label", value: "Search products" }, value: "boot" },
        { action: "click", locator: { ref: "Search button" } },
        { action: "assert", check: "text", expected: "products" },
    ],
};
const apiSpec = { title: "List products answers", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/api/products" }, { action: "assertResponse", check: "status", expected: 200 }] };

let projectId = "";
let webId = "";
let apiId = "";

beforeAll(async () => {
    sample = spawn(process.execPath, [path.join(REPO_ROOT, "examples/sample-app/server.mjs"), String(PORT)], { stdio: "ignore" });
    for (let i = 0; i < 40; i++) {
        try {
            if ((await fetch(BASE + "/")).ok) break;
        } catch {
            await sleep(150);
        }
    }
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-builder-"));
    const cfg = { SECRET_KEY: "test-secret-key-0123456789", CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0", LLM_PROVIDER: "anthropic" };
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, ...cfg }));
    server = await buildServer(platform);
    worker = new Worker(platform, 200);
    worker.start();
    // A second platform that needs the API key (no worker: it only has to refuse).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-builder-key-"));
    const p2 = bootstrap(loadConfig({ DATA_DIR: dir, API_KEY: KEY, ...cfg }));
    locked = { platform: p2, server: await buildServer(p2), dir };

    projectId = (await call("POST", "/api/projects", { name: "Builder" })).body.id;
    expect((await call("POST", `/api/projects/${projectId}/objects`, { name: "Search button", kind: "web", page: "Products", locator: { by: "role", role: "button", value: "Search" } })).status).toBe(201);
    const imp = await call("POST", `/api/projects/${projectId}/specs`, { specs: [searchSpec, apiSpec], baseUrl: BASE, validate: true });
    expect(imp.status).toBe(202);
    await waitJob(imp.body.jobId);
    webId = imp.body.tests[0].id;
    apiId = imp.body.tests[1].id;
}, 180_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    await locked?.server.close();
    locked?.platform.db.close();
    sample?.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (locked) fs.rmSync(locked.dir, { recursive: true, force: true });
});

describe("reading the steps", () => {
    it("answers with the spec as stored (shared element still a reference), what the editor may offer, and that it is editable", async () => {
        const r = await call("GET", `/api/tests/${webId}/spec`);
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ editable: true, kind: "web", key: "WEB-001", versions: 0 });
        expect(r.body.spec.steps[2].locator).toEqual({ ref: "Search button" });
        expect(r.body.kinds.actions.web).toContain("fill");
        expect(r.body.kinds.actions.api).toEqual(["request", "assertResponse"]);
        expect(r.body.kinds.assertChecks).toContain("text");
        expect(r.body.placeholders.credentials).toContain("credentials.password");
    });

    it("renders the untouched spec to exactly the stored script, and saving it unchanged does nothing", async () => {
        const stored = await script(webId);
        const s = await specOf(webId);
        const preview = await call("POST", `/api/tests/${webId}/spec/preview`, { spec: s.spec });
        expect(preview.body).toMatchObject({ ok: true });
        expect(preview.body.script).toBe(stored);
        const before = (await detail(webId)).scripts.length;
        const put = await call("PUT", `/api/tests/${webId}/spec`, { spec: s.spec });
        expect(put.status).toBe(200);
        expect(put.body).toMatchObject({ changed: false, jobId: null });
        expect((await detail(webId)).scripts.length).toBe(before);
        expect((await specOf(webId)).versions).toBe(0);
    });
});

describe("editing generated steps", () => {
    it("a preview shows the new script and stores nothing", async () => {
        const s = await specOf(webId);
        const edited = { ...s.spec, steps: s.spec.steps.map((x: any, i: number) => (i === 1 ? { ...x, value: "alpenglow" } : x)) };
        const r = await call("POST", `/api/tests/${webId}/spec/preview`, { spec: edited });
        expect(r.body.script).toContain("alpenglow");
        expect(await script(webId)).not.toContain("alpenglow");
        expect((await specOf(webId)).spec.steps[1].value).toBe("boot");
        expect((await specOf(webId)).versions).toBe(0);
        // a spec that cannot be rendered comes back as diagnostics, not an error status, and no script
        const bad = await call("POST", `/api/tests/${webId}/spec/preview`, { spec: { ...s.spec, steps: [...s.spec.steps, { action: "request", method: "GET", path: "/x" }] } });
        expect(bad.status).toBe(200);
        expect(bad.body).toMatchObject({ ok: false, script: null });
        expect(bad.body.diagnostics[0]).toMatchObject({ stepIndex: 4, severity: "error" });
    });

    it("change a text, add a step and reorder: saved, script re-rendered, shared element kept, validation passes", async () => {
        const s = await specOf(webId);
        const [nav, fill, click, assertText] = s.spec.steps;
        const edited = { ...s.spec, steps: [nav, { action: "assert", check: "title", expected: "Products" }, { ...fill, value: "alpenglow" }, click, assertText] };
        const put = await call("PUT", `/api/tests/${webId}/spec`, { spec: edited, note: "check the title first" });
        expect(put.status).toBe(200);
        expect(put.body).toMatchObject({ changed: true });
        expect(typeof put.body.jobId).toBe("string");
        expect((await detail(webId)).validationStatus).toBe("PENDING");

        const job = await waitJob(put.body.jobId);
        expect(job.status).toBe("COMPLETED");
        const t = await detail(webId);
        expect(t.validationStatus).toBe("VALIDATED");
        const code = await script(webId);
        expect(code).toContain("alpenglow");
        expect(code).toContain("toHaveTitle");
        // the stored spec keeps the reference; the script has the element's real locator, never the name
        expect(t.spec.steps[3].locator).toEqual({ ref: "Search button" });
        expect(code).toContain('getByRole("button", { name: "Search" })');
        expect(code).not.toContain("Search button");
        // what was not edited stays as it was
        expect(t.spec.priority).toBe("high");
        expect(t.spec.source.origin).toBe("imported");
        // history: the test as it was, and this version
        const versions = (await call("GET", `/api/tests/${webId}/spec-versions`)).body;
        expect(versions.map((v: any) => v.version)).toEqual([2, 1]);
        expect(versions[0].note).toBe("check the title first");
        const first = (await call("GET", `/api/tests/${webId}/spec-versions/1`)).body;
        expect(first.spec.steps[1].value).toBe("boot");
        expect((await call("GET", `/api/tests/${webId}/spec-versions/9`)).status).toBe(404);
    }, 120_000);

    it("an edit with no spec says the test is missing", async () => {
        const put = await call("PUT", `/api/tests/${webId}/spec`, {});
        expect(put.status).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(put.body)).toContain("The test is missing.");
    });

    it("a deliberately wrong edit is saved but fails validation honestly", async () => {
        const s = await specOf(webId);
        const edited = { ...s.spec, steps: [...s.spec.steps, { action: "assert", check: "text", expected: "A sentence nobody wrote anywhere" }] };
        const put = await call("PUT", `/api/tests/${webId}/spec`, { spec: edited });
        expect(put.status).toBe(200);
        await waitJob(put.body.jobId);
        const t = await detail(webId);
        expect(t.validationStatus).toBe("FAILED_VALIDATION");
        expect(t.validationReason).toMatch(/nobody wrote|Expected|toContainText|Timeout/i);
    }, 120_000);

    it("edits an API test the same way", async () => {
        const s = await specOf(apiId);
        const edited = { ...s.spec, steps: [...s.spec.steps, { action: "assertResponse", check: "jsonType", expected: "array" }] };
        const put = await call("PUT", `/api/tests/${apiId}/spec`, { spec: edited });
        expect(put.status).toBe(200);
        await waitJob(put.body.jobId);
        expect((await detail(apiId)).validationStatus).toBe("VALIDATED");
        expect(await script(apiId)).toContain("array");
    }, 120_000);
});

describe("what is refused, and nothing is stored when it is", () => {
    const rejected = async (steps: unknown[], extra: Record<string, unknown> = {}) => {
        const s = await specOf(webId);
        const before = JSON.stringify((await specOf(webId)).spec);
        const r = await call("PUT", `/api/tests/${webId}/spec`, { spec: { ...s.spec, steps, ...extra } });
        expect(JSON.stringify((await specOf(webId)).spec)).toBe(before);
        return r;
    };

    it("an invalid spec is a 422 with a message per step, and nothing is saved", async () => {
        const r = await rejected([{ action: "navigate", url: "/" }, { action: "click", locator: { by: "role", role: "", value: "" } }, { action: "assert", check: "text", expected: "" }]);
        expect(r.status).toBe(422);
        expect(r.body.error).toMatch(/not saved/);
        expect(r.body.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ stepIndex: 1, severity: "error" }), expect.objectContaining({ stepIndex: 2, severity: "error" })]));
        expect((await rejected([{ action: "fill", locator: { by: "label", value: "x" } }])).body.diagnostics[0]).toMatchObject({ stepIndex: 0, message: expect.stringMatching(/Step 1: the text is missing/) });
        expect((await rejected([])).body.diagnostics[0].message).toMatch(/at least one step/);
    });

    it("refuses a literal password or key, and accepts the saved sign-in placeholder", async () => {
        const nav = { action: "navigate", url: "/login" };
        const typed = (value: string) => ({ action: "fill", locator: { by: "label", value: "Password" }, value });
        const r = await rejected([nav, typed("hunter2")]);
        expect(r.status).toBe(422);
        expect(r.body.diagnostics[0]).toMatchObject({ stepIndex: 1, message: expect.stringContaining("{{credentials.password}}") });
        expect((await rejected([nav, { action: "fill", locator: { by: "label", value: "Email" }, value: "sk-" + "x".repeat(32) }])).status).toBe(422);
        const ok = await call("POST", `/api/tests/${webId}/spec/preview`, { spec: { ...(await specOf(webId)).spec, steps: [nav, typed("{{credentials.password}}")] } });
        expect(ok.body.ok).toBe(true);
        expect(ok.body.script).toContain("process.env.TEST_PASSWORD");
    });

    it("applies the address guard to a navigate address", async () => {
        process.env.BLOCK_PRIVATE_TARGETS = "true";
        try {
            const r = await rejected([{ action: "navigate", url: "http://169.254.169.254/latest/meta-data" }]);
            expect(r.status).toBe(422);
            expect(r.body.diagnostics[0]).toMatchObject({ stepIndex: 0, message: expect.stringMatching(/Step 1: .*private\/loopback/) });
            // an address on the application itself is fine
            const ok = await call("POST", `/api/tests/${webId}/spec/preview`, { spec: { ...(await specOf(webId)).spec, steps: [{ action: "navigate", url: "/cart" }] } });
            expect(ok.body.ok).toBe(true);
        } finally {
            delete process.env.BLOCK_PRIVATE_TARGETS;
        }
    });

    it("keeps shared elements of other projects out of this one", async () => {
        const other = (await call("POST", "/api/projects", { name: "Elsewhere" })).body.id;
        expect((await call("POST", `/api/projects/${other}/objects`, { name: "Only elsewhere", kind: "web", locator: { by: "text", value: "Hi" } })).status).toBe(201);
        const r = await rejected([{ action: "navigate", url: "/" }, { action: "click", locator: { ref: "Only elsewhere" } }]);
        expect(r.status).toBe(422);
        expect(r.body.diagnostics[0]).toMatchObject({ stepIndex: 1, message: expect.stringMatching(/'Only elsewhere'.*not in the object repository/) });
    });

    it("steps of the wrong kind of test are refused", async () => {
        const r = await rejected([{ action: "navigate", url: "/" }, { action: "request", method: "GET", path: "/x" }]);
        expect(r.status).toBe(422);
        expect(r.body.diagnostics[0].message).toMatch(/belongs in an API test/);
    });

    it("refuses while a run is in progress (and says so when asked for the steps)", async () => {
        const app = platform.repo.getLatestApplicationPublic(projectId)!;
        const job = await platform.repo.createJob(projectId, app.id as string, { ...(await import("../src/platform/repo.js")).DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] });
        platform.repo.setJobStatus(job.id, "VALIDATING");
        try {
            const s = await call("GET", `/api/tests/${webId}/spec`);
            expect(s.body).toMatchObject({ editable: false, busy: true });
            expect(s.body.reason).toMatch(/run is in progress/);
            const put = await call("PUT", `/api/tests/${webId}/spec`, { spec: { ...s.body.spec, title: "A new name for it" } });
            expect(put.status).toBe(409);
        } finally {
            platform.repo.setJobStatus(job.id, "COMPLETED");
        }
        expect((await specOf(webId)).editable).toBe(true);
        expect((await specOf(webId)).spec.title).toBe("Search finds products");
    });

    it("does not edit a hand-written test: it points to the script editor", async () => {
        const take = await call("POST", `/api/tests/${apiId}/take-over`, { confirm: true });
        expect(take.status).toBe(200);
        const s = await call("GET", `/api/tests/${apiId}/spec`);
        expect(s.body).toMatchObject({ editable: false, custom: true });
        expect(s.body.reason).toMatch(/code test/);
        const put = await call("PUT", `/api/tests/${apiId}/spec`, { spec: s.body.spec });
        expect(put.status).toBe(409);
        expect(put.body.error).toMatch(/Edit the code/);
    });
});

describe("building a test from nothing", () => {
    it("creates a valid first step, opens for editing, and the first save runs", async () => {
        const made = await call("POST", `/api/projects/${projectId}/built-tests`, { title: "Cart page opens", kind: "web", category: "Built" });
        expect(made.status).toBe(201);
        const s = await specOf(made.body.testId);
        expect(s).toMatchObject({ editable: true, kind: "web" });
        expect(s.spec.steps).toEqual([expect.objectContaining({ action: "navigate", url: "/" })]);
        expect(s.spec.category).toBe("Built");
        expect((await detail(made.body.testId)).validationStatus).toBe("PENDING");

        const edited = { ...s.spec, steps: [{ action: "navigate", url: "/cart" }, { action: "assert", check: "text", locator: { by: "role", role: "heading", value: "Your cart" }, expected: "Your cart" }] };
        const put = await call("PUT", `/api/tests/${made.body.testId}/spec`, { spec: edited });
        expect(put.status).toBe(200);
        await waitJob(put.body.jobId);
        expect((await detail(made.body.testId)).validationStatus).toBe("VALIDATED");

        const api = await call("POST", `/api/projects/${projectId}/built-tests`, { title: "Health answers", kind: "api" });
        expect(api.status).toBe(201);
        expect((await specOf(api.body.testId)).spec.steps).toEqual([expect.objectContaining({ action: "request", method: "GET", path: "/" })]);
    }, 120_000);

    it("checks the title and the kind, and the project", async () => {
        expect((await call("POST", `/api/projects/${projectId}/built-tests`, { title: "ab", kind: "web" })).status).toBe(400);
        expect((await call("POST", `/api/projects/${projectId}/built-tests`, { title: "A fine title", kind: "mobile" })).status).toBe(400);
        expect((await call("POST", `/api/projects/nope/built-tests`, { title: "A fine title", kind: "web" })).status).toBe(404);
        const empty = (await call("POST", "/api/projects", { name: "No app" })).body.id;
        const r = await call("POST", `/api/projects/${empty}/built-tests`, { title: "A fine title", kind: "web" });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/no application yet/);
    });
});

describe("access", () => {
    it("needs the API key like everything else", async () => {
        for (const [m, u, b] of [
            ["GET", "/api/tests/x/spec"],
            ["PUT", "/api/tests/x/spec", { spec: {} }],
            ["POST", "/api/tests/x/spec/preview", { spec: {} }],
            ["GET", "/api/tests/x/spec-versions"],
            ["POST", "/api/projects/x/built-tests", { title: "abc", kind: "web" }],
        ] as const) {
            expect((await call(m, u, b, locked.server)).status, `${m} ${u}`).toBe(401);
            expect((await call(m, u, b, locked.server, { "x-api-key": KEY })).status, `${m} ${u} with key`).not.toBe(401);
        }
    });

    it("an unknown test is a 404", async () => {
        expect((await call("GET", "/api/tests/nope/spec")).status).toBe(404);
        expect((await call("PUT", "/api/tests/nope/spec", { spec: {} })).status).toBe(404);
    });
});
