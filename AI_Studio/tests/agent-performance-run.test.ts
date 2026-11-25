/**
 * Agent Workspace W2a (lead 2026-11-24): a Performance agent run keeps the API target for its speed and load checks, and makes none of
 * the API agent's tests; an API agent run tests the API only (owner 2026-11-25). Really run by the worker against a local fixture (two pages, an OpenAPI
 * document, two safe reads and one write) with the scripted model of the free bench trial (eval/bench/layers-only.ts): no AI spend.
 * Then each agent's outcome shows it: the Performance agent's API call timings and load result, the API agent's PASS/FAIL table.
 * Fixture port 7650. Starts browsers, so under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/agent-performance-run.test.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { layersOnlyLlm } from "../src/eval/bench/layers-only.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import type { TestRow } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const PORT = 7650;
const SITE = `http://127.0.0.1:${PORT}`;
const OPENAPI = {
    openapi: "3.0.3",
    info: { title: "Fixture", version: "1" },
    paths: {
        "/api/items": {
            get: { responses: { "200": { description: "The items", content: { "application/json": { schema: { type: "array", items: { type: "object", required: ["id"], properties: { id: { type: "integer" } } } } } } } } },
            post: { requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } } }, responses: { "201": { description: "Made" } } },
        },
        "/api/items/{id}": {
            get: { parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", example: 1 } }], responses: { "200": { description: "One item", content: { "application/json": { schema: { type: "object", required: ["id"], properties: { id: { type: "integer" } } } } } } } },
        },
        "/api/status": { get: { responses: { "200": { description: "Up", content: { "application/json": { schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } } } } } } },
    },
};
const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const fixture = http.createServer((req, res) => {
    const p = (req.url ?? "/").split("?")[0];
    const json = (status: number, v: unknown) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(v)));
    if (p === "/openapi.json") return json(200, OPENAPI);
    if (p === "/api/items") return req.method === "GET" ? json(200, [{ id: 1 }, { id: 2 }]) : json(201, { id: 3 });
    if (p === "/api/status") return json(200, { ok: true });
    if (/^\/api\/items\/\d+$/.test(p)) return json(200, { id: Number(p.split("/").at(-1)) });
    res.writeHead(200, { "content-type": "text/html" });
    res.end(p === "/about" ? page("About", "<p>About the shop.</p><a href='/'>Home</a>") : page("Home", "<p>Welcome.</p><a href='/about'>About</a>"));
});

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dir = "";
let pid = "";
const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
    const r = await server.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });
    return { status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body } as { status: number; body: any };
};
async function run(agentId: string, extra: Record<string, unknown> = {}): Promise<{ jobId: string; tests: TestRow[] }> {
    const started = await call("POST", `/api/projects/${pid}/test-generation`, { url: SITE, agentId, ...extra });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const jobId = started.body.jobId as string;
    for (let i = 0; i < 600; i++) {
        const j = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) break;
        await new Promise((r) => setTimeout(r, 500));
    }
    return { jobId, tests: platform.repo.listTests(pid, { jobId }) };
}
const meta = (t: TestRow) => t.generationMeta ?? {};

beforeAll(async () => {
    await new Promise<void>((r) => fixture.listen(PORT, "127.0.0.1", r));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-perf-run-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", SCHEDULER_ENABLED: "false", EXECUTION_MODE: "local", SECRET_KEY: "perf-run-secret-0123456789abcdef" } as never));
    platform.llm = layersOnlyLlm();
    server = await buildServer(platform);
    worker = new Worker({ ...platform, makeLlm: () => layersOnlyLlm() } as never, 200);
    worker.start();
    pid = platform.repo.createProject({ name: "Speed fixture", platforms: ["web"], testingModes: ["agent"] }).id as string;
    platform.repo.createApplication(pid, SITE, {});
    expect((await call("PUT", `/api/projects/${pid}/testing-agents`, { agents: ["api", "performance"] })).status).toBe(200);
    expect((await call("PUT", `/api/projects/${pid}/agent-inputs`, { openApiUrl: `${SITE}/openapi.json` })).status).toBe(200);
}, 60_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    await new Promise((r) => fixture.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("a Performance agent run on the API target", () => {
    it("times the safe API calls and runs the allowed load check, and makes none of the API agent's tests", async () => {
        const { jobId, tests } = await run("performance", { loadChecks: true, loadBudgets: "users:2 seconds:2 requests:12" });
        const job = platform.repo.getJob(jobId)!;
        expect(job.status, job.error ?? "").toMatch(/COMPLETED/);
        const titles = tests.map((t) => `${t.kind} ${t.title} ${JSON.stringify(meta(t))}`);
        expect(tests.filter((t) => t.kind === "api" && meta(t).performance && !meta(t).load).length, titles.join("\n")).toBeGreaterThan(0);
        expect(tests.filter((t) => meta(t).load).length, titles.join("\n")).toBeGreaterThan(0);
        expect(tests.filter((t) => t.kind === "web" && meta(t).performance).length, titles.join("\n")).toBeGreaterThan(0);
        // Every test of the run is one of its speed or load checks: no API case, contract check, workflow or other agent's check.
        expect(tests.filter((t) => !meta(t).performance).map((t) => t.title)).toEqual([]);
        const o = (await call("GET", `/api/projects/${pid}/workspace/performance/outcome`)).body;
        expect(o.calls.length).toBeGreaterThan(0);
        expect(o.calls.every((c: any) => c.metrics.some((m: any) => m.metric === "p95"))).toBe(true);
        expect(o.load.length).toBeGreaterThan(0);
        expect(o.load[0].metrics.some((m: any) => m.metric === "load_requests")).toBe(true);
        expect(o.pages.map((p: any) => p.path)).toContain("/");
    }, 400_000);

    it("an API agent run tests the API only: its API tests with contract checks, no page tests, and no speed or load checks", async () => {
        const { jobId, tests } = await run("api");
        expect(platform.repo.getJob(jobId)!.status).toMatch(/COMPLETED/);
        expect(platform.repo.getJob(jobId)!.options.targets).toEqual(["api"]);
        expect(tests.filter((t) => t.kind !== "api").map((t) => t.title)).toEqual([]);
        const own = tests.filter((t) => typeof meta(t).endpoint === "string" && !meta(t).performance);
        expect(own.map((t) => meta(t).endpoint)).toEqual(expect.arrayContaining(["GET /api/items", "GET /api/status"]));
        expect(own.some((t) => t.spec.steps.some((s) => (s as { check?: string }).check === "matchesSchema"))).toBe(true);
        // The fixture's list and detail reads make a workflow: the API agent's own, which a Performance run must not make.
        expect(tests.some((t) => meta(t).workflow), tests.map((t) => t.title).join("\n")).toBe(true);
        expect(tests.filter((t) => meta(t).performance)).toEqual([]);
        const o = (await call("GET", `/api/projects/${pid}/workspace/api/outcome`)).body;
        expect(o.tests.map((e: any) => `${e.method} ${e.path}`)).toEqual(expect.arrayContaining(["GET /api/items", "GET /api/status"]));
        expect(o.tests.every((e: any) => ["pass", "fail"].includes(e.result))).toBe(true);
    }, 400_000);
});
