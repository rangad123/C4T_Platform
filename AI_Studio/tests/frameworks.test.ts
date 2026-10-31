/**
 * Framework adapters inside the platform: the adapter list in GET /api/config, a real validation job whose scripts go through
 * the executor seam (real Playwright against the sample app), and a dummy framework showing up without any change to the core.
 * No model is involved. Fixture port: 5810.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { listAdapters, localExecutor, registerAdapter, setExecutorResolver, unregisterAdapter, type ScriptExecutor } from "../src/engine/frameworks/index.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const PORT = 5810;
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
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-frameworks-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic" }));
    server = await buildServer(platform);
    worker = new Worker(platform, 200);
    worker.start();
}, 30_000);

afterAll(async () => {
    setExecutorResolver(undefined);
    unregisterAdapter("noop");
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

const webSpec = {
    title: "Products page lists products",
    kind: "web",
    category: "Catalogue",
    steps: [{ action: "navigate", url: "/products" }, { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Products" } }],
};
const apiSpec = {
    title: "List products returns an array",
    kind: "api",
    category: "API · Products",
    steps: [{ action: "request", method: "GET", path: "/api/products" }, { action: "assertResponse", check: "status", expected: 200 }, { action: "assertResponse", check: "jsonType", expected: "array" }],
};

describe("GET /api/config", () => {
    it("lists the adapters with what each one needs, and keeps the older frameworks list", async () => {
        const { status, body } = await call("GET", "/api/config");
        expect(status).toBe(200);
        expect(body.adapters.map((a: { id: string }) => a.id)).toEqual(["playwright", "playwright-api", "taqwright", "windows-uia", "taqwright-ios"]);
        expect(body.adapters[0]).toEqual({ id: "playwright", label: "Playwright (TypeScript)", kinds: ["web"], executable: true, runtime: "playwright", needs: { node: true, browsers: ["chromium"] }, traits: { visionJudgement: true, cleanupLedger: true, browserRepair: true } });
        expect(body.adapters[2].needs).toEqual({ node: true, android: true });
        expect(body.frameworks).toEqual([
            { framework: "playwright", kind: "web", executable: true },
            { framework: "playwright-api", kind: "api", executable: true },
            { framework: "taqwright", kind: "mobile", executable: true },
            { framework: "windows-uia", kind: "desktop", executable: true },
            { framework: "taqwright-ios", kind: "mobile", executable: true },
        ]);
    });

    it("shows a framework registered at start-up without any change to the platform", async () => {
        registerAdapter({
            id: "noop",
            label: "No-op",
            kinds: ["web"],
            executable: false,
            runtime: "noop",
            needs: { node: true },
            traits: { visionJudgement: false, cleanupLedger: false, browserRepair: false },
            render: (spec) => ({ framework: "noop", filename: `${spec.testId}.txt`, content: "", language: "typescript" }),
            execute: async () => [],
            describe: () => ({ id: "noop", label: "No-op", kinds: ["web"], executable: false, runtime: "noop", needs: { node: true }, traits: { visionJudgement: false, cleanupLedger: false, browserRepair: false } }),
        });
        const body = (await call("GET", "/api/config")).body;
        expect(body.adapters.map((a: { id: string }) => a.id)).toContain("noop");
        expect(body.frameworks.map((f: { framework: string }) => f.framework)).toContain("noop");
        expect(unregisterAdapter("noop")).toBe(true);
        expect(listAdapters().map((a) => a.id)).toEqual(["playwright", "playwright-api", "taqwright", "windows-uia", "taqwright-ios"]);
    });
});

describe("scripts really run through the executor seam", () => {
    it("a validation job hands its Playwright web and API scripts to the executor as one batch and records the real results", async () => {
        const seen: Array<{ adapter: string; files: string[]; baseUrl: string }> = [];
        const recording: ScriptExecutor = {
            name: "recording-local",
            async execute(adapterId, batch, env, opts) {
                seen.push({ adapter: adapterId, files: batch.scripts.map((s) => s.filename), baseUrl: env.run.baseUrl });
                return localExecutor.execute(adapterId, batch, env, opts);
            },
        };
        const asked: Array<{ projectId?: string; mode?: string }> = [];
        setExecutorResolver((scope) => {
            asked.push({ projectId: scope.projectId, mode: scope.mode });
            return recording;
        });

        const projectId = (await call("POST", "/api/projects", { name: "Adapters" })).body.id;
        const res = await call("POST", `/api/projects/${projectId}/specs`, { specs: [webSpec, apiSpec], baseUrl: BASE });
        expect(res.status).toBe(202);
        const job = await waitForJob(res.body.jobId);
        expect(job.status).toBe("COMPLETED");

        expect(asked).toEqual([{ projectId, mode: "validate" }]);
        expect(seen).toEqual([{ adapter: "playwright", files: ["WEB-001.spec.ts", "API-001.spec.ts"], baseUrl: BASE }]);
        const tests = (await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ testId: string; validationStatus: string }>;
        expect(tests.map((t) => [t.testId, t.validationStatus]).sort()).toEqual([["API-001", "VALIDATED"], ["WEB-001", "VALIDATED"]]);
    }, 120_000);

    it("rendering another framework for a test still works and an unknown framework is a plain 400", async () => {
        const projectId = (await call("POST", "/api/projects", { name: "Scripts" })).body.id;
        const imported = await call("POST", `/api/projects/${projectId}/specs`, { specs: [webSpec], baseUrl: BASE, validate: false });
        expect(imported.status).toBe(202);
        const testId = imported.body.tests[0].id;
        const mobile = await call("POST", `/api/tests/${testId}/scripts`, { framework: "taqwright" });
        expect(mobile.status).toBe(201);
        expect(mobile.body).toMatchObject({ framework: "taqwright", filename: "WEB-001.mobile.spec.ts", executable: true });
        const bad = await call("POST", `/api/tests/${testId}/scripts`, { framework: "selenium" });
        expect(bad.status).toBe(400);
    });
});
