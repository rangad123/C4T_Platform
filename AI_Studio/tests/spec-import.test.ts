/**
 * User-supplied specs: import → validation-only job (queue + worker + real Playwright) → stored results;
 * export round-trip; on-demand re-validation. No LLM involved.
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

const PORT = 5121;
const BASE = `http://127.0.0.1:${PORT}`;
let sample: ChildProcess;
let platform: Platform;
let worker: Worker;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;

beforeAll(async () => {
    sample = spawn(process.execPath, [path.join(REPO_ROOT, "examples/sample-app/server.mjs"), String(PORT)], { stdio: "ignore" });
    for (let i = 0; i < 40; i++) {
        try {
            if ((await fetch(BASE + "/")).ok) break;
        } catch {
            await new Promise((r) => setTimeout(r, 150));
        }
    }
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-import-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic" }));
    server = await buildServer(platform);
    worker = new Worker(platform, 200);
    worker.start();
}, 30_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    sample?.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

async function waitForJob(jobId: string) {
    for (let i = 0; i < 240; i++) {
        const j = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) return j;
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("job did not finish");
}

const loginSpec = {
    title: "Login succeeds with valid credentials",
    kind: "web",
    category: "Authentication",
    priority: "critical",
    steps: [
        { action: "navigate", url: "/login" },
        { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}" },
        { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" },
        { action: "click", locator: { by: "role", role: "button", value: "Log in" } },
        { action: "assert", check: "url", expected: "/account" },
    ],
};
const apiSpec = {
    title: "List products returns an array",
    kind: "api",
    category: "API · Products",
    steps: [
        { action: "request", method: "GET", path: "/api/products" },
        { action: "assertResponse", check: "status", expected: 200 },
        { action: "assertResponse", check: "jsonType", expected: "array" },
    ],
};
const brokenSpec = {
    title: "Click a button that does not exist",
    kind: "web",
    steps: [
        { action: "navigate", url: "/products" },
        { action: "click", locator: { by: "role", role: "button", value: "Nonexistent" } },
    ],
};

describe("user-supplied specs", () => {
    let projectId = "";

    it("imports, validates with real execution, and stores results", async () => {
        projectId = (await call("POST", "/api/projects", { name: "Imported" })).body.id;
        const res = await call("POST", `/api/projects/${projectId}/specs`, {
            specs: [loginSpec, apiSpec, brokenSpec],
            baseUrl: BASE,
            credentials: { username: "demo@example.com", password: "Password123!" },
        });
        expect(res.status).toBe(202);
        expect(res.body.tests.map((t: { testId: string }) => t.testId)).toEqual(["WEB-001", "API-001", "WEB-002"]);

        const job = await waitForJob(res.body.jobId);
        expect(job.progress.discovery).toBe("skipped");
        expect(job.status).toBe("PARTIALLY_COMPLETED");

        const tests = (await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; testId: string; validationStatus: string; validationReason: string | null }>;
        const by = Object.fromEntries(tests.map((t) => [t.testId, t]));
        expect(by["WEB-001"]!.validationStatus).toBe("VALIDATED");
        expect(by["API-001"]!.validationStatus).toBe("VALIDATED");
        expect(by["WEB-002"]!.validationStatus).toBe("FAILED_VALIDATION");
        expect(by["WEB-002"]!.validationReason).toMatch(/Nonexistent|Timeout/);

        const detail = (await call("GET", `/api/tests/${by["WEB-001"]!.id}`)).body;
        expect(detail.spec.source.origin).toBe("imported");
        expect(detail.executions[0].status).toBe("passed");
        expect(detail.scripts[0].content).toContain("process.env.TEST_PASSWORD");
    }, 180_000);

    it("rejects invalid specs all-or-nothing with per-spec issues", async () => {
        const before = (await call("GET", `/api/projects/${projectId}/tests`)).body.length;
        const res = await call("POST", `/api/projects/${projectId}/specs`, { specs: [apiSpec, { title: "x", kind: "web", steps: [] }] });
        expect(res.status).toBe(400);
        expect(res.body.details[0].index).toBe(1);
        expect((await call("GET", `/api/projects/${projectId}/tests`)).body.length).toBe(before);
    });

    it("rejects duplicate testIds", async () => {
        const res = await call("POST", `/api/projects/${projectId}/specs`, { specs: [{ ...apiSpec, testId: "API-001" }], validate: false });
        expect(res.status).toBe(409);
    });

    it("exports specs that round-trip into another project", async () => {
        const exported = (await call("GET", `/api/projects/${projectId}/specs`)).body.specs;
        expect(exported).toHaveLength(3);
        const other = (await call("POST", "/api/projects", { name: "Copy" })).body.id;
        const res = await call("POST", `/api/projects/${other}/specs`, { specs: exported, baseUrl: BASE, validate: false });
        expect(res.status).toBe(202);
        expect(res.body.jobId).toBeNull();
        const tests = (await call("GET", `/api/projects/${other}/tests`)).body as Array<{ testId: string; validationStatus: string }>;
        expect(tests.map((t) => t.testId).sort()).toEqual(["API-001", "WEB-001", "WEB-002"]);
        expect(tests.every((t) => t.validationStatus === "PENDING")).toBe(true);
    });

    it("reports the latest validation results as JUnit XML", async () => {
        const res = await server.inject({ method: "GET", url: `/api/projects/${projectId}/junit` });
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toContain("application/xml");
        const xml = res.body;
        expect(xml).toMatch(/<testsuites name="Imported" tests="3" failures="1" skipped="0"/);
        expect(xml).toContain('name="WEB-001: Login succeeds with valid credentials"');
        expect(xml).toMatch(/<failure type="test-failure" message="[^"]*(Nonexistent|Timeout)/);
    });

    it("re-validates a single test on demand", async () => {
        const tests = (await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; testId: string }>;
        const api = tests.find((t) => t.testId === "API-001")!;
        // As browsers and curl send it: JSON content-type with an empty body must be accepted.
        const raw = await server.inject({ method: "POST", url: `/api/tests/${api.id}/validate`, headers: { "content-type": "application/json" }, payload: "" });
        const res = { status: raw.statusCode, body: JSON.parse(raw.body) };
        expect(res.status).toBe(202);
        const job = await waitForJob(res.body.jobId);
        expect(job.status).toBe("COMPLETED");
        const detail = (await call("GET", `/api/tests/${api.id}`)).body;
        expect(detail.executions.length).toBeGreaterThanOrEqual(2);
    }, 120_000);
});
