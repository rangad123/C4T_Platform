/**
 * Failure evidence end to end, with real work: a fixture app with pages that fail in different ways, the real worker running the
 * specs under Playwright, the real API, a local GitHub-shaped server for issues. No model is configured (and none is used).
 * Runs a browser: node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/evidence.test.ts
 * Ports: fixture app 5650, issue tracker 5651.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { renderScript } from "../src/engine/generators/index.js";
import { EVIDENCE_MAX_REQUESTS } from "../src/engine/evidence/capture.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { runScripts } from "../src/engine/validation/runner.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { EVIDENCE_SENTINELS, startEvidenceApp } from "./fixtures/evidence-app.js";

const APP_PORT = 5650;
const GH_PORT = 5651;
const APP = `http://127.0.0.1:${APP_PORT}`;
const PASSWORD = "EVID-Password-b7e312";
const GH_TOKEN = "ghp_evidenceTokenForTests1234567890";
/** Everything that must never be found in anything stored. */
const FORBIDDEN = [...Object.values(EVIDENCE_SENTINELS), PASSWORD, encodeURIComponent(PASSWORD), GH_TOKEN];

let dataDir: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let app: http.Server;
let tracker: http.Server;
let startedAt = 0;
const issuesSent: Array<{ title: string; body: string }> = [];
let projectId = "";
const ids: Record<string, string> = {};

beforeAll(async () => {
    startedAt = Date.now() - 1000;
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-evidence-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", CONCURRENCY: "3" }));
    server = await buildServer(platform);
    worker = new Worker({ ...platform }, 100);
    worker.start();
    app = await startEvidenceApp(APP_PORT);
    // A GitHub-shaped issue tracker: it keeps what it was sent.
    tracker = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (d) => (raw += d));
        req.on("end", () => {
            res.setHeader("content-type", "application/json");
            if (req.method === "POST" && req.url === "/repos/acme/shop/issues") {
                const sent = JSON.parse(raw) as { title: string; body: string };
                issuesSent.push(sent);
                res.writeHead(201).end(JSON.stringify({ number: issuesSent.length, html_url: `https://github.example/acme/shop/issues/${issuesSent.length}` }));
            } else res.writeHead(200).end(JSON.stringify({ full_name: "acme/shop", has_issues: true, archived: false }));
        });
    });
    await new Promise<void>((r) => tracker.listen(GH_PORT, "127.0.0.1", r));
}, 30_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    app?.close();
    tracker?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, text: res.body, body: res.body && res.headers["content-type"]?.toString().includes("json") ? JSON.parse(res.body) : null };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitJob(jobId: string) {
    for (let i = 0; i < 600; i++) {
        const job = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) return job;
        await sleep(300);
    }
    throw new Error(`job ${jobId} did not finish`);
}

const role = (r: string, value?: string) => ({ by: "role", role: r, ...(value ? { value, exact: true } : {}) });
const web = (title: string, steps: unknown[]) => ({ title, kind: "web", category: "Evidence", steps });
const SPECS = {
    cart: web("Adding to the cart works", [{ action: "navigate", url: "/cart" }, { action: "click", locator: role("button", "Add to cart") }, { action: "assert", check: "text", locator: role("status"), expected: "Added" }]),
    boom: web("The boom page shows its heading", [{ action: "navigate", url: "/boom" }, { action: "assert", check: "visible", expected: "Never shown anywhere" }]),
    login: web("The password check accepts the password", [
        { action: "navigate", url: "/login" },
        { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" },
        { action: "click", locator: role("button", "Check") },
        { action: "assert", check: "text", locator: role("status"), expected: "Accepted" },
    ]),
    many: web("The busy page finishes loading", [{ action: "navigate", url: "/many" }, { action: "assert", check: "text", locator: role("status"), expected: "Done" }]),
    home: web("The home page loads", [{ action: "navigate", url: "/" }, { action: "assert", check: "text", locator: role("heading"), expected: "Evidence home" }]),
    api: { title: "The hello endpoint answers", kind: "api", category: "Evidence API", steps: [{ action: "request", method: "GET", path: "/api/hello" }, { action: "assertResponse", check: "status", expected: 200 }] },
};
const evidence = async (key: string, query = "") => (await call("GET", `/api/tests/${ids[key]}/evidence${query}`)).body;

describe("evidence from real failing runs", () => {
    it("runs the fixture app's tests through the platform: four fail, two pass", async () => {
        projectId = (await call("POST", "/api/projects", { name: "Evidence" })).body.id;
        const imp = await call("POST", `/api/projects/${projectId}/specs`, { baseUrl: APP, credentials: { username: "someone@example.com", password: PASSWORD }, specs: Object.values(SPECS) });
        expect(imp.status, imp.text).toBe(202);
        Object.keys(SPECS).forEach((k, i) => (ids[k] = imp.body.tests[i].id));
        const job = await waitJob(imp.body.jobId);
        expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(job.status);
        const status = async (k: string) => (await call("GET", `/api/tests/${ids[k]}`)).body.validationStatus;
        expect(await status("home")).toBe("VALIDATED");
        expect(await status("api")).toBe("VALIDATED");
        for (const k of ["cart", "boom", "login", "many"]) expect(await status(k), k).not.toBe("VALIDATED");
    }, 240_000);

    it("a failed fetch: the failing request and the console error are in the evidence, with the plain-language summary", async () => {
        const e = await evidence("cart");
        expect(e.available).toBe(true);
        expect(e.execution).toMatchObject({ status: "failed", failedStep: 3 });
        const cart = e.evidence.requests.find((r: any) => r.method === "POST" && r.path === "/api/cart");
        expect(cart).toMatchObject({ status: 500, type: "fetch", step: 2 });
        expect(cart.host).toBeUndefined(); // the application's own address is implied
        expect(e.evidence.console.some((c: any) => c.type === "error" && c.text === "Could not add to cart: the server answered 500")).toBe(true);
        expect(e.summary.sentence).toMatch(/^1 request failed: POST \/api\/cart answered 500; \d+ console errors?; the page made \d+ requests\.$/);
        expect(e.summary).toMatchObject({ failedRequests: 1, uncaughtErrors: 0 });
        // the entries closest to the failing step are called out
        expect(e.highlights.failed[0]).toMatchObject({ path: "/api/cart", status: 500 });
        expect(e.highlights.nearFailure.requests.some((r: any) => r.path === "/api/cart")).toBe(true);
        expect(e.highlights.errors.length).toBeGreaterThan(0);
    });

    it("an uncaught exception is reported as such", async () => {
        const e = await evidence("boom");
        expect(e.available).toBe(true);
        expect(e.evidence.console.find((c: any) => c.type === "pageerror")?.text).toBe("Boom: the checkout widget crashed");
        expect(e.summary.uncaughtErrors).toBe(1);
        expect(e.summary.sentence).toContain("1 uncaught exception: “Boom: the checkout widget crashed”");
    });

    it("a page that makes 1000 requests keeps 300, keeps the failing one, and says so", async () => {
        const e = await evidence("many");
        expect(e.evidence.counts.requests).toBeGreaterThanOrEqual(1000);
        expect(e.evidence.requests).toHaveLength(EVIDENCE_MAX_REQUESTS);
        expect(e.evidence.counts.requestsKept).toBe(EVIDENCE_MAX_REQUESTS);
        expect(e.evidence.requests.some((r: any) => r.path === "/api/fail" && r.status === 500)).toBe(true);
        expect(e.summary.sentence).toContain(`Only ${EVIDENCE_MAX_REQUESTS} of them were kept`);
        expect(JSON.stringify(e.evidence).length).toBeLessThan(600_000);
    });

    it("redaction: query values by name, the run's password in any form, tokens in the console; harmless values stay", async () => {
        const e = await evidence("login");
        const check = e.evidence.requests.find((r: any) => r.path.startsWith("/api/check"));
        expect(check.status).toBe(401);
        expect(check.path).toBe("/api/check?mode=quick&token=[hidden]&u=[hidden]&page=login&session=[hidden]");
        const texts = e.evidence.console.map((c: any) => c.text) as string[];
        expect(texts).toContain("checked with [hidden]");
        expect(texts).toContain("Authorization: [hidden] [hidden]");
        expect(texts).toContain("session jwt [hidden] and digest [hidden]");
        expect(texts).toContain("retrying with password=[hidden] and mode=quick");
        for (const k of ["cart", "boom", "login", "many"]) {
            const raw = JSON.stringify((await evidence(k)).evidence);
            for (const secret of FORBIDDEN) expect(raw.includes(secret), `${secret} in ${k}`).toBe(false);
        }
    });

    it("a passing test stores no evidence, and the API says so in words", async () => {
        const detail = (await call("GET", `/api/tests/${ids.home}`)).body;
        expect(detail.executions[0].status).toBe("passed");
        expect(detail.executions[0].artifacts.some((a: any) => a.kind === "evidence")).toBe(false);
        expect(await evidence("home")).toMatchObject({ available: false, message: "The latest run passed, so there is no failure to explain." });
        // asking for that very run by id: also a plain answer
        const byId = await evidence("home", `?executionId=${detail.executions[0].id}`);
        expect(byId).toMatchObject({ available: false });
        expect(byId.message).toContain("No network or console details were recorded for this run");
        const rows = platform.db.all<{ test_case_id: string }>("SELECT test_case_id FROM artifacts WHERE kind = 'evidence'");
        expect(rows.length).toBeGreaterThanOrEqual(4);
        expect(rows.some((r) => r.test_case_id === ids.home || r.test_case_id === ids.api)).toBe(false);
    });

    it("API tests and unknown tests or runs get clear answers", async () => {
        expect(await evidence("api")).toMatchObject({ available: false, message: "Network calls and console messages are recorded for web tests only." });
        expect((await call("GET", "/api/tests/nope/evidence")).status).toBe(404);
        expect((await call("GET", `/api/tests/${ids.cart}/evidence?executionId=nope`)).status).toBe(404);
        // a run that belongs to another test is not found for this one
        const other = (await call("GET", `/api/tests/${ids.home}`)).body.executions[0].id;
        expect((await call("GET", `/api/tests/${ids.cart}/evidence?executionId=${other}`)).status).toBe(404);
        // the earlier run of the same test can be asked for by id
        const cart = (await call("GET", `/api/tests/${ids.cart}`)).body;
        expect((await evidence("cart", `?executionId=${cart.executions[0].id}`)).available).toBe(true);
    });

    it("a test whose latest run has no evidence (a run from before this feature) is a normal answer", async () => {
        const noEvidence = platform.repo.addExecution({ testId: ids.cart!, scriptId: null, jobId: null, attempt: 1, status: "failed", durationMs: 5, error: "old", startedAt: new Date(Date.now() + 60_000).toISOString(), steps: [{ index: 0, title: "1. Open", status: "failed" }] });
        const e = await evidence("cart");
        expect(e.available).toBe(false);
        expect(e.execution.id).toBe(noEvidence);
        expect(e.message).toContain("Runs made before this was added do not have them");
        platform.db.run("DELETE FROM test_executions WHERE id = ?", noEvidence);
    });
});

describe("issues and reports carry the summary", () => {
    it("the issue text for a failing test includes the one-paragraph summary, no tables, no secrets", async () => {
        const conn = await call("POST", `/api/projects/${projectId}/integrations`, { kind: "github", owner: "acme", repo: "shop", token: GH_TOKEN, apiUrl: `http://127.0.0.1:${GH_PORT}` });
        expect(conn.status, conn.text).toBe(201);
        const made = await call("POST", `/api/tests/${ids.cart}/issue`, { integrationId: conn.body.id });
        expect(made.status, made.text).toBe(201);
        const sent = issuesSent.at(-1)!;
        expect(sent.body).toContain("What the page did");
        expect(sent.body).toMatch(/1 request failed: POST \/api\/cart answered 500; \d+ console errors?; the page made \d+ requests\./);
        expect(sent.body).not.toContain("| ");
        for (const secret of FORBIDDEN.filter((s) => s !== GH_TOKEN)) expect(sent.body).not.toContain(secret);
    });

    it("the shareable report shows the same sentence for failing tests", async () => {
        const res = await call("GET", `/api/projects/${projectId}/report?format=html`);
        expect(res.status).toBe(200);
        expect(res.text).toMatch(/What the page did: 1 request failed: POST \/api\/cart answered 500; \d+ console errors?; the page made \d+ requests\./);
        expect(res.text).toContain("What the page did: 1 uncaught exception");
        for (const secret of FORBIDDEN) expect(res.text.includes(secret), secret).toBe(false);
    });
});

describe("nothing secret is stored anywhere", () => {
    const filesUnder = (dir: string, since = 0): string[] =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
            const full = path.join(dir, e.name);
            return e.isDirectory() ? filesUnder(full, since) : fs.statSync(full).mtimeMs >= since ? [full] : [];
        });
    const leaks = (bytes: Buffer) => FORBIDDEN.filter((s) => s !== GH_TOKEN).filter((s) => bytes.includes(Buffer.from(s, "latin1")) || bytes.includes(Buffer.from(s, "utf16le")));

    it("the database, its journal and every stored file are free of the sentinels", () => {
        platform.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const files = filesUnder(dataDir);
        expect(files.some((f) => f.endsWith("evidence.json"))).toBe(true);
        const found = files.flatMap((f) => leaks(fs.readFileSync(f)).map((s) => `${s} in ${path.relative(dataDir, f)}`));
        expect(found).toEqual([]);
    });

    it("the evidence files and the Playwright reports the scripts wrote are clean too", () => {
        const scratch = path.join(REPO_ROOT, ".validation");
        const files = filesUnder(scratch, startedAt).filter((f) => /(-evidence\.json|report\.json)$/.test(f));
        expect(files.some((f) => f.endsWith("-evidence.json"))).toBe(true);
        const found = files.flatMap((f) => leaks(fs.readFileSync(f)).map((s) => `${s} in ${path.relative(scratch, f)}`));
        expect(found).toEqual([]);
    });
});

describe("the script itself", () => {
    const spec = (s: unknown, testId: string) => TestSpecSchema.parse({ ...(s as object), testId });
    const scratch = loadConfig({}).scratchDir;

    it("AITP_EVIDENCE=always keeps evidence for a passing test as well (and nothing else changes)", async () => {
        const r = renderScript(spec(SPECS.home, "WEB-901"), "playwright", { baseUrl: APP });
        const run = async (always: boolean) => {
            if (always) process.env.AITP_EVIDENCE = "always";
            try {
                return await runScripts(scratch, [{ testId: "WEB-901", filename: r.filename, content: r.content }], { baseUrl: APP, headless: true }, { workers: 1 });
            } finally {
                delete process.env.AITP_EVIDENCE;
            }
        };
        const normal = (await run(false))[0]!;
        expect(normal.status).toBe("passed");
        expect(normal.artifacts.some((a) => a.kind === "evidence")).toBe(false);
        const kept = (await run(true))[0]!;
        expect(kept.status).toBe("passed");
        const file = kept.artifacts.find((a) => a.kind === "evidence");
        expect(file).toBeTruthy();
        const stored = JSON.parse(fs.readFileSync(file!.path, "utf8"));
        expect(stored.requests.some((q: any) => q.path === "/api/hello?page=home" && q.status === 200)).toBe(true);
        expect(stored.console.some((c: any) => c.text === "home ready")).toBe(true);
    }, 120_000);

    it("a downloaded script is self-contained: run with plain Playwright it records evidence and masks the credentials from its own environment", async () => {
        const r = renderScript(spec(SPECS.login, "WEB-902"), "playwright", { baseUrl: APP });
        expect(r.content).not.toContain(PASSWORD);
        const dir = fs.mkdtempSync(path.join(scratch, "standalone-"));
        fs.writeFileSync(path.join(dir, r.filename), r.content);
        fs.writeFileSync(path.join(dir, "playwright.config.ts"), 'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: ".", timeout: 30000, expect: { timeout: 3000 }, reporter: [["json", { outputFile: "out.json" }]] });\n');
        const cli = path.join(REPO_ROOT, "node_modules/@playwright/test/cli.js");
        try {
            const code = await new Promise<number | null>((resolve) => {
                const child = spawn(process.execPath, [cli, "test", "--config", "playwright.config.ts"], { cwd: dir, env: { ...process.env, BASE_URL: APP, TEST_PASSWORD: PASSWORD, FORCE_COLOR: "0" }, stdio: "ignore" });
                child.on("close", resolve);
            });
            expect(code).toBe(1); // the password check is rejected: the test fails, as designed
            const report = JSON.parse(fs.readFileSync(path.join(dir, "out.json"), "utf8"));
            const attachments: Array<{ name: string; body?: string }> = report.suites[0].specs[0].tests[0].results[0].attachments;
            const raw = Buffer.from(attachments.find((a) => a.name === "evidence")!.body!, "base64").toString("utf8");
            expect(raw).toContain("checked with [hidden]");
            expect(raw).toContain("/api/check?mode=quick&token=[hidden]&u=[hidden]");
            expect(raw).not.toContain(PASSWORD);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 120_000);
});
