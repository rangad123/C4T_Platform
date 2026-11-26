/**
 * The Test Case Generation agent on the local bench apps, end to end, with a scripted model (PLAN.md B1, founder 2026-11-19; no paid
 * AI, no network). For examples/bench-shop and examples/bench-rbac, each with its requirements document (src/eval/bench/inputs/) imported
 * as the project's requirements, a TCG project is explored twice. Per app:
 *   - the tree has at least 5 nodes after run 1, and run 2's nodes include run 1's (SPEC R10);
 *   - at least 5 test cases, each with a title, type Automated with no steps, a page that is a tree node, and a requirement that is a
 *     numbered line of the app's requirements document (SPEC R3, R7, D1);
 *   - the workbook opens with the repo's own reader (src/engine/manual/xlsx-read.ts): sheets "Test cases", "Pages", "Tree" in that
 *     order with the Q3 headers, one row per case, and it imports into a new code project with no row refused (SPEC R6, R9);
 *   - nothing runs: no job other than the two plan-only explorations, no test, no runner task, no execution, and "create the tests"
 *     from the plan is refused (SPEC P2, Q4).
 * The scripted planner cites only requirement ids it was shown in the planning prompt, and plans on the apps' public pages.
 * Ports 6611–6612. Run under the browser lock (the explorations start a browser):
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/case-agent-bench.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ExtractionAnswerSchema } from "../src/engine/intel/extract/rules.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { readSheet } from "../src/engine/manual/xlsx-read.js";
import { NormalisedSchema } from "../src/engine/requirements/parse.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";
import { BENCH_APPS, BenchAppHost } from "../src/eval/bench/apps.js";
import { INPUTS_DIR } from "../src/eval/bench/understanding/answer-key.js";
import { requirementsOf } from "../src/eval/bench/understanding/run.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CASE_AGENT_PLAN_REFUSED } from "../src/platform/case-agent.js";
import { startHeartbeat } from "../src/platform/ops/heartbeat.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const KEY = "case-agent-bench-key-5e0b";
const PORT = 6611;
/** Pages both apps show to a visitor, so a planned case always starts on a page the crawl reaches. */
const START_PATHS = ["/", "/login", "/register"];
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
let stopBeat: (() => void) | undefined;
let worker: Worker | undefined;

const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, headers: { "x-api-key": KEY }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body, raw: r.rawPayload } as { status: number; body: any; raw: Buffer };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The scripted model: no rules or journeys of its own; the planner gets one test case per requirement id shown in its prompt.
const scripted: LlmClient = {
    modelName: "scripted",
    model: undefined as never,
    usage: { inputTokens: 0, outputTokens: 0 },
    text: async () => "",
    object: (async ({ system, prompt, schema }: { system: string; prompt: string; schema: unknown }) => {
        if (schema === ExtractionAnswerSchema) return { rules: [], workflows: [], roles: [], transitions: [], entities: [] };
        if (schema === NormalisedSchema) return { requirements: [] };
        if (/analysing a web application/.test(system)) return { siteType: "other", purpose: "A bench app", features: [], pagePurposes: [], journeys: [], authenticationMechanisms: [] };
        if (prompt.includes("Already covered by the plan")) return { scenarios: [] };
        const block = /<<<REQUIREMENTS([\s\S]*?)REQUIREMENTS>>>/.exec(prompt)?.[1] ?? "";
        const ids = [...block.matchAll(/^- \[([^\]]+)\]/gm)].map((m) => m[1]!);
        return {
            scenarios: ids.map((id, i) =>
                ScenarioSchema.omit({ scenarioId: true }).parse({ title: `Requirement ${id} holds`, description: `Check requirement ${id}`, category: "Requirements", priority: "high", startPath: START_PATHS[i % START_PATHS.length], requirements: [id], expectedResults: [`Requirement ${id} holds`] }),
            ),
        };
    }) as LlmClient["object"],
};

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-case-bench-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, LLM_PROVIDER: "anthropic", CONCURRENCY: "1", SECRET_KEY: "case-agent-bench-secret-0123456789abcdef" } as never));
    stopBeat = startHeartbeat(platform.db);
    app = await buildServer(platform);
    await app.ready();
    worker = new Worker({ ...platform, makeLlm: () => scripted }, 100);
    worker.start();
}, 60_000);

afterAll(async () => {
    await worker?.stop();
    stopBeat?.();
    await app?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

async function explore(pid: string, url: string, credentials: { username: string; password: string }): Promise<string> {
    const r = await call("POST", `/api/projects/${pid}/test-generation`, { url, maxPages: 20, targets: ["web"], credentials });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.plan).toBe(true);
    let job: any;
    for (let i = 0; i < 600; i++) {
        job = (await call("GET", `/api/test-generation/${r.body.jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) break;
        await sleep(500);
    }
    expect(job.status, JSON.stringify(job)).toBe("COMPLETED");
    return r.body.jobId as string;
}

describe.each(BENCH_APPS.map((a, i) => [a.id, a, PORT + i] as const))("the Test Case Generation agent on %s", (id, bench, port) => {
    const host = new BenchAppHost(bench, port);
    const doc = fs.readFileSync(path.join(INPUTS_DIR, `${id}-requirements.md`), "utf8");
    const lines = new Map(requirementsOf(doc).map((r) => [r.ref, r.description]));
    beforeAll(() => host.start("none"), 30_000);
    afterAll(() => host.stop());

    it("writes the tree and the test cases, each traced to a requirement line, exports the workbook, and runs nothing", async () => {
        expect(lines.size).toBeGreaterThan(20);
        const made = await call("POST", "/api/projects", { name: `TCG ${id}`, platforms: ["web"], testingModes: ["agent"], agents: ["test-generation"] });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        const pid = made.body.id as string;
        const imported = await call("POST", `/api/projects/${pid}/requirements/import`, { requirements: requirementsOf(doc) });
        expect(imported.status, JSON.stringify(imported.body)).toBeLessThan(300);
        const signIn = bench.understanding?.credentials ?? bench.credentials!;

        const run1 = await explore(pid, host.url, signIn);
        const first = (await call("GET", `/api/projects/${pid}/outcome`)).body;
        const nodes1 = first.tree.map((n: { node: string }) => n.node);
        expect(nodes1.length, JSON.stringify(nodes1)).toBeGreaterThanOrEqual(5);

        const run2 = await explore(pid, host.url, signIn);
        const outcome = (await call("GET", `/api/projects/${pid}/outcome`)).body;
        expect(outcome.caseAgent).toBe(true);
        expect(outcome.runs.map((r: { jobId: string }) => r.jobId).sort()).toEqual([run1, run2].sort());
        const nodes = new Set<string>(outcome.tree.map((n: { node: string }) => n.node));
        for (const n of nodes1) expect(nodes).toContain(n);

        // The test cases: plain Automated cases on tree pages, each citing a numbered line of the requirements document.
        expect(outcome.cases.length, JSON.stringify(outcome.cases.map((c: any) => [c.title, c.page, c.requirement]))).toBeGreaterThanOrEqual(5);
        const treePages = new Set<string>(outcome.tree.map((n: { page: string }) => n.page).filter(Boolean));
        for (const c of outcome.cases) {
            expect(c.title).toBeTruthy();
            expect(c.type).toBe("automated");
            expect(c.steps).toEqual([]);
            expect(treePages, `${c.title} on ${c.page}`).toContain(c.page);
            const refs = String(c.requirement).split(/,\s*/).filter(Boolean);
            expect(refs.length, c.title).toBeGreaterThan(0);
            for (const ref of refs) expect(lines.has(ref), `${c.title} cites ${ref}`).toBe(true);
        }

        // The workbook: three sheets in order with the standard columns, read back with the repo's own reader.
        const wb = await call("GET", `/api/projects/${pid}/outcome/workbook`);
        expect(wb.status).toBe(200);
        const bytes = new Uint8Array(wb.raw);
        const names = [...strFromU8(unzipSync(bytes)["xl/workbook.xml"]!).matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
        expect(names).toEqual(["Test cases", "Pages", "Tree"]);
        const cases = readSheet(bytes, "Test cases");
        expect(cases[0]).toEqual(["ID", "Title", "Type", "Priority", "Page", "Preconditions", "Steps", "Expected result", "Requirement", "Test data", "Check"]);
        expect(readSheet(bytes, "Pages")[0]).toEqual(["Page", "Address", "Purpose"]);
        expect(readSheet(bytes, "Tree")[0]).toEqual(["Node", "Parent", "Page"]);
        const rows = cases.slice(1).filter((r) => r.some(Boolean));
        expect(rows.length).toBe(outcome.cases.length);
        for (const r of rows) {
            expect(r[2]).toBe("Automated");
            expect(r[6] ?? "").toBe("");
            for (const ref of r[8]!.split(/,\s*/)) expect(lines.has(ref), `workbook row ${r[0]} cites ${ref}`).toBe(true);
        }
        const code = await call("POST", "/api/projects", { name: `Code ${id}`, platforms: ["web"], testingModes: ["code"] });
        expect(code.status, JSON.stringify(code.body)).toBe(201);
        const into = await call("POST", `/api/projects/${code.body.id}/manual-cases/import`, { format: "xlsx", content: Buffer.from(bytes).toString("base64") });
        expect(into.status, JSON.stringify(into.body)).toBeLessThan(300);
        expect(into.body).toMatchObject({ created: rows.length, skipped: [] });

        // Nothing ran: only the two plan-only explorations, no test, no runner task, no execution; making tests from the plan is refused.
        const jobs = platform.repo.listJobs(pid);
        expect(jobs.map((j) => j.id).sort()).toEqual([run1, run2].sort());
        for (const j of jobs) expect(j.options).toMatchObject({ planOnly: true });
        for (const j of jobs) expect(j.options.mode ?? "generate").toBe("generate");
        expect(platform.repo.listTests(pid)).toEqual([]);
        expect(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_tasks WHERE project_id = ?", pid)!.n).toBe(0);
        expect(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM test_executions e JOIN test_cases t ON t.id = e.test_case_id WHERE t.project_id = ?", pid)!.n).toBe(0);
        const create = await call("POST", `/api/projects/${pid}/plans/${run2}/create`, {});
        expect({ status: create.status, error: create.body.error }).toEqual({ status: 409, error: CASE_AGENT_PLAN_REFUSED });
        expect(platform.repo.listJobs(pid).length).toBe(2);
    }, 600_000);
});
