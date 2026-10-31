/**
 * Platform end-to-end (no LLM): HTTP API → queue → worker → discovery → OpenAPI-driven API test
 * generation → real Playwright validation → SQLite + artifact storage → download.
 * The LLM-driven web path needs credentials and is exercised by scripts/e2e.ts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const PORT = 5072;
const BASE = `http://127.0.0.1:${PORT}`;
let app: ChildProcess;
let platform: Platform;
let worker: Worker;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;

beforeAll(async () => {
    app = spawn(process.execPath, [path.join(REPO_ROOT, "examples/sample-app/server.mjs"), String(PORT)], { stdio: "ignore" });
    for (let i = 0; i < 40; i++) {
        try {
            if ((await fetch(BASE + "/")).ok) break;
        } catch {
            await new Promise((r) => setTimeout(r, 150));
        }
    }
    // make the "no LLM" assertions independent of the developer's shell
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, CONCURRENCY: "3" }));
    server = await buildServer(platform);
    worker = new Worker(platform, 200);
    worker.start();
}, 30_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    app?.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const json = async (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as any });
    return { status: res.statusCode, body: res.body.startsWith("{") || res.body.startsWith("[") ? JSON.parse(res.body) : res.body, raw: res };
};

describe("platform e2e (API-only job)", () => {
    it("runs the full job lifecycle and stores validated tests", async () => {
        const project = await json("POST", "/api/projects", { name: "DemoShop" });
        expect(project.status).toBe(201);

        const queued = await json("POST", `/api/projects/${project.body.id}/test-generation`, {
            url: BASE,
            targets: ["api"],
            securityChecks: false, // default-on passive security checks have their own tests (security-checks.test.ts)
            credentials: { apiToken: "demo-token-123" },
        });
        expect(queued.status).toBe(202);
        expect(queued.body.status).toBe("QUEUED");
        const jobId = queued.body.jobId as string;

        // a second job for the same project is refused while one is active
        const dup = await json("POST", `/api/projects/${project.body.id}/test-generation`, { url: BASE, targets: ["api"] });
        expect(dup.status).toBe(409);

        let job: any;
        // The worker can claim the job before the first poll, so the state it was created in is taken from the response.
        const seen = new Set<string>([queued.body.status]);
        for (let i = 0; i < 240; i++) {
            job = (await json("GET", `/api/test-generation/${jobId}`)).body;
            seen.add(job.status);
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        expect(job.status, JSON.stringify(job)).toBe("COMPLETED");
        expect(job.testsGenerated).toBeGreaterThan(5);
        expect(job.testsValidated).toBe(job.testsGenerated);
        expect(job.testsFailedValidation).toBe(0);
        expect(job.progress.validation).toBe("done");
        expect(job.progress.planning).toBe("skipped"); // web target not requested

        const tests = (await json("GET", `/api/projects/${project.body.id}/tests?kind=api`)).body as any[];
        expect(tests.length).toBe(job.testsGenerated);
        expect(tests.every((t) => t.validationStatus === "VALIDATED" && t.testId.startsWith("API-"))).toBe(true);
        // mutating endpoint (POST /api/login) must not have been exercised in safe mode
        expect(tests.some((t) => t.title.startsWith("POST /api/login"))).toBe(false);

        const detail = (await json("GET", `/api/tests/${tests[0].id}`)).body;
        expect(detail.spec.steps.length).toBeGreaterThan(0);
        expect(detail.scripts[0].content).toContain('import { test, expect');
        expect(detail.executions[0].status).toBe("passed");
        expect(detail.executions[0].steps.length).toBeGreaterThan(0);

        const script = await json("GET", `/api/tests/${tests[0].id}/script`);
        expect(script.status).toBe(200);
        expect(String(script.body)).toContain("API_BASE_URL");

        // stored on disk in the documented layout
        const first = fs.readdirSync(path.join(dataDir, "generated-tests", project.body.id));
        expect(first.some((d) => d.startsWith("api-"))).toBe(true);

        // events are recorded for observability
        const events = (await json("GET", `/api/test-generation/${jobId}/events`)).body as any[];
        const kinds = new Set(events.map((e) => e.kind));
        expect(kinds.has("api_discovered")).toBe(true);
        expect(kinds.has("validation_passed")).toBe(true);

        // application model persisted
        const model = (await json("GET", `/api/projects/${project.body.id}/application-model`)).body;
        expect(model.openApi.operationCount).toBe(4);

        // API specs cannot be rendered as a mobile UI test
        const bad = await json("POST", `/api/tests/${tests[0].id}/scripts`, { framework: "taqwright" });
        expect(bad.status).toBe(422);

        // download zip
        const zip = await server.inject({ method: "GET", url: `/api/projects/${project.body.id}/download` });
        expect(zip.statusCode).toBe(200);
        const files = Object.keys(unzipSync(new Uint8Array(zip.rawPayload)));
        expect(files).toContain("manifest.json");
        expect(files.some((f) => f.startsWith("tests/") && f.endsWith(".spec.ts"))).toBe(true);
        expect([...seen]).toContain("QUEUED");
    }, 180_000);

    it("fails a web job clearly when no LLM is configured", async () => {
        // wait for the previous follow-up job to settle so the project isn't busy
        const project = await json("POST", "/api/projects", { name: "WebNoLLM" });
        const queued = await json("POST", `/api/projects/${project.body.id}/test-generation`, { url: BASE, targets: ["web"], maxPages: 4 });
        let job: any;
        for (let i = 0; i < 120; i++) {
            job = (await json("GET", `/api/test-generation/${queued.body.jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        // The AI web path cannot run, but deterministic accessibility audits still do: the job is
        // partial (never COMPLETED) and records why.
        expect(job.status).toBe("PARTIALLY_COMPLETED");
        expect(job.error).toMatch(/No credentials for LLM provider/);
        expect(job.counters.testsGenerated).toBeGreaterThan(0);
        expect(job.counters.pagesDiscovered).toBeGreaterThan(2); // discovery itself worked without an LLM
    }, 120_000);

    it("rejects invalid input and unknown resources", async () => {
        expect((await json("POST", "/api/projects", {})).status).toBe(400);
        expect((await json("GET", "/api/test-generation/nope")).status).toBe(404);
        const p = await json("POST", "/api/projects", { name: "x" });
        expect((await json("POST", `/api/projects/${p.body.id}/test-generation`, { url: "ftp://x.test" })).status).toBe(400);
    });
});
