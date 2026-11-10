/**
 * Text tests on a real platform: a real worker and real Chromium run against the sample app.
 * Create a test from text (every import rule applies), edit it through the text (history, script rendered again, validation passes),
 * wrong text is a 422 with line diagnostics and stores nothing, the refusals (secrets, sign-in details sent elsewhere, hand-written
 * tests, tests text cannot show, other projects' reusable steps, a run in progress), the parse endpoint stores nothing, API key.
 * Ports: 6290 sample app.
 *
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/dsl-api.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { parseDsl, printSpec } from "../src/engine/dsl/index.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CustomScriptStore } from "../src/platform/custom-script-store.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const PORT = 6290;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "dsl-key-0123456789abcdef";
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
const dslOf = async (id: string) => (await call("GET", `/api/tests/${id}/dsl`)).body;
const count = (pid: string) => platform.repo.listTests(pid).length;

const SEARCH_TEXT = `Test: Search finds boots
Category: Shop
Priority: high
Tag: smoke
Result: The product list is shown

Go to /products
Type "boot" into the "Search products" field
Click the "Search" button
Expect the page to contain the text "products"
`;
const API_TEXT = `Test: Products answer as a list
Kind: api

Send a GET request to /api/products
Expect the status to be 200
Expect the response to be of type "array"
`;

let projectId = "";
let otherId = "";
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
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-dsl-"));
    const cfg = { SECRET_KEY: "test-secret-key-0123456789", CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0", LLM_PROVIDER: "anthropic" };
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, ...cfg }));
    server = await buildServer(platform);
    worker = new Worker(platform, 200);
    worker.start();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-dsl-key-"));
    const p2 = bootstrap(loadConfig({ DATA_DIR: dir, API_KEY: KEY, ...cfg }));
    locked = { platform: p2, server: await buildServer(p2), dir };

    // Two projects that each know the application (a stored test is imported without running it).
    for (const name of ["Text tests", "Somewhere else"]) {
        const id = (await call("POST", "/api/projects", { name })).body.id as string;
        const imp = await call("POST", `/api/projects/${id}/specs`, { specs: [{ title: "Starter page opens", kind: "web", steps: [{ action: "navigate", url: "/" }] }], baseUrl: BASE, validate: false });
        expect(imp.status).toBe(202);
        if (name === "Text tests") projectId = id;
        else otherId = id;
    }
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

describe("reading text (nothing is stored)", () => {
    it("parses the text into a test and lists nothing in the project", async () => {
        const before = count(projectId);
        const r = await call("POST", "/api/dsl/parse", { text: SEARCH_TEXT });
        expect(r.status).toBe(200);
        expect(r.body.diagnostics).toEqual([]);
        expect(r.body.spec).toMatchObject({ title: "Search finds boots", kind: "web", category: "Shop", priority: "high", tags: ["smoke"] });
        expect(r.body.spec.steps).toHaveLength(4);
        expect(r.body.stepLines).toEqual([7, 8, 9, 10]);
        expect(count(projectId)).toBe(before);
    });

    it("answers a text with mistakes as line diagnostics and no test", async () => {
        const r = await call("POST", "/api/dsl/parse", { text: "Test: Broken\nGo to /\nClik the \"Save\" button\nWait lots ms\n" });
        expect(r.status).toBe(200);
        expect(r.body.spec).toBeNull();
        expect(r.body.diagnostics.map((d: any) => d.line)).toEqual([3, 4]);
        expect(r.body.diagnostics[0]).toMatchObject({ column: 1, suggestion: expect.stringContaining("Click") });
    });

    it("lists the phrases from the same table the parser uses", async () => {
        const r = await call("GET", "/api/dsl/phrases");
        expect(r.status).toBe(200);
        expect(r.body.phrases.length).toBeGreaterThan(40);
        expect(r.body.phrases.map((p: any) => p.example)).toContain('Click the "Sign in" button');
        expect(r.body.headers.map((h: any) => h.key)).toContain("test");
    });

    it("is rate limited and recovers", async () => {
        await sleep(1100);
        const codes: number[] = [];
        for (let i = 0; i < 8; i++) codes.push((await call("POST", "/api/dsl/parse", { text: "Test: Rate limit\nGo to /\n" })).status);
        expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
        expect(codes).toContain(429);
        await sleep(1100);
        expect((await call("POST", "/api/dsl/parse", { text: "Test: Rate limit\nGo to /\n" })).status).toBe(200);
    });

    it("writes a test (for example unsaved steps) as text, and stores nothing", async () => {
        await sleep(1100);
        const before = count(projectId);
        const spec = { testId: "WEB-001", title: "Printed from steps", kind: "web", steps: [{ action: "navigate", url: "/" }, { action: "click", locator: { by: "role", role: "button", value: "Go" } }] };
        const r = await call("POST", "/api/dsl/print", { spec });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ expressible: true, reasons: [] });
        expect(r.body.text).toContain('Click the "Go" button');
        expect((await call("POST", "/api/dsl/print", { spec: { title: 5 } })).status).toBe(422);
        // No spec at all gets the same plain sentence as an invalid one, not a generic refusal.
        const none = await call("POST", "/api/dsl/print", {});
        expect(none.status).toBe(422);
        expect(none.body.error).toBe("These steps cannot be written as text yet: they are not a valid test.");
        expect(count(projectId)).toBe(before);
    });

    it("refuses a body that is not text", async () => {
        await sleep(1100);
        expect((await call("POST", "/api/dsl/parse", { text: 5 })).status).toBe(400);
        expect((await call("POST", "/api/dsl/parse", {})).status).toBe(400);
    });
});

describe("creating a test from text", () => {
    it("goes through the platform's own import and the first run passes", async () => {
        const made = await call("POST", `/api/projects/${projectId}/dsl-tests`, { text: SEARCH_TEXT });
        expect(made.status).toBe(201);
        expect(typeof made.body.jobId).toBe("string");
        expect(made.body.key).toMatch(/^WEB-\d+$/);
        webId = made.body.testId;
        const job = await waitJob(made.body.jobId);
        expect(job.status).toBe("COMPLETED");
        const t = await detail(webId);
        expect(t.validationStatus).toBe("VALIDATED");
        expect(t.spec).toMatchObject({ title: "Search finds boots", category: "Shop", priority: "high", tags: ["smoke"], expectedResults: ["The product list is shown"] });
        expect(t.spec.source.origin).toBe("imported");
        expect(await script(webId)).toContain("Search products");
        expect(new CustomScriptStore(platform.db).auditTrail(projectId).map((a) => a.action)).toContain("write-text");
    }, 120_000);

    it("the text of the new test is the same text, printed once and the same ever after", async () => {
        const d = await dslOf(webId);
        expect(d).toMatchObject({ expressible: true, reasons: [], editable: true, kind: "web" });
        const canonical = printSpec(parseDsl(SEARCH_TEXT).spec!).text;
        expect(d.text).toBe(canonical);
        // reading it and printing it again changes nothing
        expect(printSpec(parseDsl(d.text).spec!).text).toBe(d.text);
        expect((await dslOf(webId)).text).toBe(d.text);
    });

    it("creates an API test, and a test without a category goes under a default one", async () => {
        const made = await call("POST", `/api/projects/${projectId}/dsl-tests`, { text: API_TEXT });
        expect(made.status).toBe(201);
        apiId = made.body.testId;
        await waitJob(made.body.jobId);
        const t = await detail(apiId);
        expect(t.validationStatus).toBe("VALIDATED");
        expect(t.spec.kind).toBe("api");
        expect(t.spec.category).toBe("Written as text");
        expect(String(await script(apiId))).toContain("array");
    }, 120_000);

    it("a wrong text is a 422 with line diagnostics and creates nothing", async () => {
        const before = count(projectId);
        const r = await call("POST", `/api/projects/${projectId}/dsl-tests`, { text: "Test: Not good\nGo to /products\nClick teh \"Search\" button\nExpect the page to shwo \"x\"\n" });
        expect(r.status).toBe(422);
        expect(r.body.error).toMatch(/not created.*line 3/);
        expect(r.body.diagnostics.map((d: any) => [d.line, d.severity])).toEqual([[3, "error"], [4, "error"]]);
        expect(count(projectId)).toBe(before);
    });

    it("refuses a typed-in password, naming the line, and creates nothing", async () => {
        const before = count(projectId);
        const r = await call("POST", `/api/projects/${projectId}/dsl-tests`, { text: 'Test: Login with a secret\nGo to /login\nType "hunter2" into the "Password" field\n' });
        expect(r.status).toBe(422);
        expect(r.body.diagnostics[0]).toMatchObject({ line: 3, message: expect.stringContaining("{{credentials.password}}") });
        expect(count(projectId)).toBe(before);
        // a key-looking value in an API header is refused too
        const k = await call("POST", `/api/projects/${projectId}/dsl-tests`, { text: `Test: Key in a header\nKind: api\nSend a GET request to /api/products with the header "X-Token" = "sk-${"a".repeat(30)}"\n` });
        expect(k.status).toBe(422);
        expect(count(projectId)).toBe(before);
    });

    it("refuses sign-in details that would go to another site, and creates nothing", async () => {
        const before = count(projectId);
        const web = await call("POST", `/api/projects/${projectId}/dsl-tests`, { text: 'Test: Sends the password away\nGo to http://127.0.0.2:6299/login\nType "{{credentials.password}}" into the "Password" field\n' });
        expect(web.status).toBe(422);
        expect(JSON.stringify(web.body)).toContain("Stored sign-in details can only be used on the application's own site");
        const api = await call("POST", `/api/projects/${projectId}/dsl-tests`, { text: "Test: Sends the token away\nKind: api\nSend a GET request to http://127.0.0.2:6299/api/products\n" });
        expect(api.status).toBe(422);
        expect(JSON.stringify(api.body)).toContain("Stored sign-in details");
        expect(count(projectId)).toBe(before);
    });

    it("applies the address guard", async () => {
        process.env.BLOCK_PRIVATE_TARGETS = "true";
        try {
            const before = count(projectId);
            const r = await call("POST", `/api/projects/${projectId}/dsl-tests`, { text: "Test: Cloud metadata\nGo to http://169.254.169.254/latest/meta-data\n" });
            // The sample application itself is on loopback, so with private targets blocked the platform's import refuses the project's
            // address first (400); the point here is that the guard is the import's own and nothing is created.
            expect([400, 422]).toContain(r.status);
            expect(JSON.stringify(r.body)).toMatch(/private|loopback/);
            expect(count(projectId)).toBe(before);
        } finally {
            delete process.env.BLOCK_PRIVATE_TARGETS;
        }
    });

    it("keeps reusable steps and shared elements of other projects out", async () => {
        const made = await call("POST", `/api/projects/${otherId}/blocks`, { name: "Open the products", kind: "web", params: [], steps: [{ action: "navigate", url: "/products" }] });
        expect(made.status).toBe(201);
        expect((await call("POST", `/api/projects/${otherId}/objects`, { name: "Only elsewhere", kind: "web", locator: { by: "text", value: "Hi" } })).status).toBe(201);
        const before = count(projectId);
        const r = await call("POST", `/api/projects/${projectId}/dsl-tests`, { text: 'Test: Uses a block of another project\nRun the reusable steps "Open the products"\n' });
        expect(r.status).toBe(422);
        expect(r.body.diagnostics[0]).toMatchObject({ line: 2, message: expect.stringMatching(/Open the products/) });
        const s = await call("POST", `/api/projects/${projectId}/dsl-tests`, { text: 'Test: Uses an element of another project\nGo to /\nClick the shared element "Only elsewhere"\n' });
        expect(s.status).toBe(422);
        expect(s.body.diagnostics[0]).toMatchObject({ line: 3 });
        expect(count(projectId)).toBe(before);
        // in its own project the same text works
        const ok = await call("POST", `/api/projects/${otherId}/dsl-tests`, { text: 'Test: Uses its own block\nRun the reusable steps "Open the products"\nExpect the page to contain the text "Products"\n' });
        expect(ok.status).toBe(201);
        await waitJob(ok.body.jobId);
        expect((await detail(ok.body.testId)).validationStatus).toBe("VALIDATED");
        expect((await detail(ok.body.testId)).spec.steps[0]).toMatchObject({ action: "useBlock", block: "Open the products" });
    }, 120_000);

    it("a project that does not exist is a 404, a project without an application says so", async () => {
        expect((await call("POST", "/api/projects/nope/dsl-tests", { text: API_TEXT })).status).toBe(404);
        const empty = (await call("POST", "/api/projects", { name: "No application" })).body.id;
        const r = await call("POST", `/api/projects/${empty}/dsl-tests`, { text: API_TEXT });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/no application yet/);
    });

    it("while another run is in progress the test is saved, not run, and the answer says why", async () => {
        const app = platform.repo.getLatestApplicationPublic(projectId)!;
        const job = await platform.repo.createJob(projectId, app.id as string, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] });
        platform.repo.setJobStatus(job.id, "VALIDATING");
        try {
            const r = await call("POST", `/api/projects/${projectId}/dsl-tests`, { text: "Test: Saved while busy\nGo to /cart\n" });
            expect(r.status).toBe(201);
            expect(r.body.jobId).toBeNull();
            expect(r.body.note).toMatch(/run is in progress/);
            expect((await detail(r.body.testId)).validationStatus).toBe("PENDING");
        } finally {
            platform.repo.setJobStatus(job.id, "COMPLETED");
        }
    });
});

describe("editing a test through its text", () => {
    it("a change is saved as a new version, the script is rendered again and the run passes", async () => {
        const text = (await dslOf(webId)).text.replace('Type "boot" into', 'Type "alpenglow" into').replace('Expect the page to contain the text "products"', 'Expect the page title to contain "Products"\nExpect the page to contain the text "products"');
        const put = await call("PUT", `/api/tests/${webId}/dsl`, { text, note: "title check first" });
        expect(put.status).toBe(200);
        expect(put.body).toMatchObject({ changed: true });
        expect(typeof put.body.jobId).toBe("string");
        expect((await detail(webId)).validationStatus).toBe("PENDING");
        expect((await waitJob(put.body.jobId)).status).toBe("COMPLETED");
        const t = await detail(webId);
        expect(t.validationStatus).toBe("VALIDATED");
        const code = await script(webId);
        expect(code).toContain("alpenglow");
        expect(code).toContain("toHaveTitle");
        // what the text does not carry stays as it was
        expect(t.spec.source.origin).toBe("imported");
        expect(t.spec.category).toBe("Shop");
        expect(t.spec.steps).toHaveLength(5);
        // history: the test as it was, and this version
        const versions = (await call("GET", `/api/tests/${webId}/spec-versions`)).body;
        expect(versions.map((v: any) => v.version)).toEqual([2, 1]);
        expect(versions[0].note).toBe("title check first");
        // the text now reads as the new test
        expect((await dslOf(webId)).text).toContain('Type "alpenglow" into');
        expect(new CustomScriptStore(platform.db).auditTrail(projectId).map((a) => a.action)).toContain("edit-steps");
    }, 120_000);

    it("saving the same text again changes nothing and runs nothing", async () => {
        const text = (await dslOf(webId)).text;
        const before = (await detail(webId)).scripts.length;
        const put = await call("PUT", `/api/tests/${webId}/dsl`, { text });
        expect(put.status).toBe(200);
        expect(put.body).toMatchObject({ changed: false, jobId: null });
        expect((await detail(webId)).scripts.length).toBe(before);
        expect((await call("GET", `/api/tests/${webId}/spec-versions`)).body).toHaveLength(2);
    });

    it("wrong text is a 422 with line diagnostics and nothing is saved", async () => {
        const stored = JSON.stringify((await detail(webId)).spec);
        const versions = (await call("GET", `/api/tests/${webId}/spec-versions`)).body.length;
        const text = (await dslOf(webId)).text.replace('Click the "Search" button', 'Clik the "Search" button');
        const r = await call("PUT", `/api/tests/${webId}/dsl`, { text });
        expect(r.status).toBe(422);
        expect(r.body.error).toMatch(/not saved/);
        expect(r.body.diagnostics).toEqual([expect.objectContaining({ line: 10, column: 1, severity: "error", suggestion: expect.stringContaining("Click") })]);
        expect(JSON.stringify((await detail(webId)).spec)).toBe(stored);
        expect((await call("GET", `/api/tests/${webId}/spec-versions`)).body.length).toBe(versions);
    });

    it("the step editor's rules apply, with the line named: a typed-in password, sign-in details sent elsewhere, an element of another project", async () => {
        const stored = JSON.stringify((await detail(webId)).spec);
        const base = (await dslOf(webId)).text;
        const withLine = (line: string) => base.replace('Click the "Search" button', line);
        const secret = await call("PUT", `/api/tests/${webId}/dsl`, { text: withLine('Type "hunter2" into the "Password" field') });
        expect(secret.status).toBe(422);
        expect(secret.body.diagnostics[0]).toMatchObject({ line: 10, message: expect.stringContaining("{{credentials.password}}") });
        const away = await call("PUT", `/api/tests/${webId}/dsl`, { text: base + 'Go to http://127.0.0.2:6299/login\nType "{{credentials.password}}" into the "Password" field\n' });
        expect(away.status).toBe(422);
        expect(JSON.stringify(away.body)).toContain("Stored sign-in details can only be used on the application's own site");
        const other = await call("PUT", `/api/tests/${webId}/dsl`, { text: withLine('Click the shared element "Only elsewhere"') });
        expect(other.status).toBe(422);
        expect(other.body.diagnostics[0]).toMatchObject({ line: 10 });
        const block = await call("PUT", `/api/tests/${webId}/dsl`, { text: withLine('Run the reusable steps "Open the products"') });
        expect(block.status).toBe(422);
        expect(JSON.stringify((await detail(webId)).spec)).toBe(stored);
    });

    it("cannot change what text does not own: the kind and the category", async () => {
        const base = (await dslOf(webId)).text;
        const kind = await call("PUT", `/api/tests/${webId}/dsl`, { text: base.replace("Kind: web", "Kind: api") });
        expect(kind.status).toBe(422);
        const cat = await call("PUT", `/api/tests/${webId}/dsl`, { text: base.replace("Category: Shop", "Category: Elsewhere") });
        expect(cat.status).toBe(422);
        expect(cat.body.diagnostics[0].message).toMatch(/category/);
        // leaving the Category line out keeps the stored one
        const without = await call("PUT", `/api/tests/${webId}/dsl`, { text: base.replace("Category: Shop\n", "") });
        expect(without.status).toBe(200);
        expect(without.body.changed).toBe(false);
    });

    it("edits an API test the same way", async () => {
        const text = (await dslOf(apiId)).text + 'Expect the response body to contain "name"\n';
        const put = await call("PUT", `/api/tests/${apiId}/dsl`, { text });
        expect(put.status).toBe(200);
        await waitJob(put.body.jobId);
        expect((await detail(apiId)).validationStatus).toBe("VALIDATED");
        expect(await script(apiId)).toContain("toContain");
    }, 120_000);

    it("refuses while a run is in progress, and says so when asked for the text", async () => {
        const app = platform.repo.getLatestApplicationPublic(projectId)!;
        const job = await platform.repo.createJob(projectId, app.id as string, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] });
        platform.repo.setJobStatus(job.id, "VALIDATING");
        try {
            const d = await dslOf(webId);
            expect(d).toMatchObject({ editable: false, busy: true });
            expect(d.editReason).toMatch(/run is in progress/);
            const put = await call("PUT", `/api/tests/${webId}/dsl`, { text: d.text.replace("Search finds boots", "Search finds more boots") });
            expect(put.status).toBe(409);
        } finally {
            platform.repo.setJobStatus(job.id, "COMPLETED");
        }
        expect((await detail(webId)).title).toBe("Search finds boots");
    });
});

describe("what text cannot show", () => {
    let stuckId = "";
    it("a test with a setting no phrase has is shown read-only, with the reasons, and its text is refused on save", async () => {
        const imp = await call("POST", `/api/projects/${projectId}/specs`, {
            specs: [{ title: "Accessibility with a number", kind: "web", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "a11y", expected: 100 }] }],
            validate: false,
        });
        expect(imp.status).toBe(202);
        stuckId = imp.body.tests[0].id;
        const d = await dslOf(stuckId);
        expect(d.expressible).toBe(false);
        expect(d.editable).toBe(false);
        expect(d.reasons[0]).toMatch(/^Step 2/);
        expect(d.text).toContain("# not expressible: step 2");
        expect(d.editReason).toMatch(/cannot be edited as text/);
        const before = JSON.stringify((await detail(stuckId)).spec);
        const put = await call("PUT", `/api/tests/${stuckId}/dsl`, { text: d.text.replace("Accessibility with a number", "Accessibility without the number") });
        expect(put.status).toBe(409);
        expect(put.body.error).toMatch(/not fully expressible/);
        expect(JSON.stringify((await detail(stuckId)).spec)).toBe(before);
    });

    it("a hand-written test has no text form: it points to the code editor", async () => {
        const imp = await call("POST", `/api/projects/${projectId}/specs`, { specs: [{ title: "To be taken over", kind: "api", steps: [{ action: "request", method: "GET", path: "/api/products" }] }], validate: false });
        const id = imp.body.tests[0].id as string;
        expect((await call("POST", `/api/tests/${id}/take-over`, { confirm: true })).status).toBe(200);
        const get = await call("GET", `/api/tests/${id}/dsl`);
        expect(get.status).toBe(409);
        expect(get.body.error).toMatch(/code editor/);
        const put = await call("PUT", `/api/tests/${id}/dsl`, { text: API_TEXT });
        expect(put.status).toBe(409);
        expect(put.body.error).toMatch(/code editor|script/);
    });

    it("an unknown test is a 404", async () => {
        expect((await call("GET", "/api/tests/nope/dsl")).status).toBe(404);
        expect((await call("PUT", "/api/tests/nope/dsl", { text: API_TEXT })).status).toBe(404);
    });
});

describe("access", () => {
    it("needs the API key like everything else", async () => {
        for (const [m, u, b] of [
            ["GET", "/api/dsl/phrases"],
            ["POST", "/api/dsl/parse", { text: API_TEXT }],
            ["POST", "/api/dsl/print", { spec: {} }],
            ["POST", "/api/projects/x/dsl-tests", { text: API_TEXT }],
            ["GET", "/api/tests/x/dsl"],
            ["PUT", "/api/tests/x/dsl", { text: API_TEXT }],
        ] as const) {
            expect((await call(m, u, b, locked.server)).status, `${m} ${u}`).toBe(401);
            expect((await call(m, u, b, locked.server, { "x-api-key": KEY })).status, `${m} ${u} with key`).not.toBe(401);
        }
    });

    it("creating a test with the key reaches the platform's import with the same key", async () => {
        const id = (await call("POST", "/api/projects", { name: "Keyed" }, locked.server, { "x-api-key": KEY })).body.id as string;
        const imp = await call("POST", `/api/projects/${id}/specs`, { specs: [{ title: "Starter page opens", kind: "web", steps: [{ action: "navigate", url: "/" }] }], baseUrl: BASE, validate: false }, locked.server, { "x-api-key": KEY });
        expect(imp.status).toBe(202);
        const made = await call("POST", `/api/projects/${id}/dsl-tests`, { text: "Test: Made with a key\nGo to /cart\n" }, locked.server, { "x-api-key": KEY });
        // the test is stored (the inner import accepted the forwarded key); the run is not started because this platform has no worker
        expect(made.status).toBe(201);
        expect(made.body.key).toMatch(/^WEB-/);
    });
});
