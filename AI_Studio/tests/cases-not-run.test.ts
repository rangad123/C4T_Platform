/**
 * The Test Case Generation Agent writes test cases and does not run them. Through real jobs: HTTP API -> queue -> worker -> real
 * discovery of a local site -> planning and authoring with a scripted model double -> the plan confirmed (the path the web app takes).
 *
 * Checks that the journeys the plan creates are saved as written test cases with steps and are not run (no execution, no run job,
 * status "Not run yet"), that the job says so, and that the person's own Run (POST /api/projects/:id/runs) still runs them. The
 * requirements route (POST /requirements/generate-cases) is covered in tests/generate-cases.test.ts.
 *
 * Fixture site: port 6493 (tests/fixtures/memory-site.ts). The platform is driven through `server.inject`.
 * Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/cases-not-run.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { startMemorySite, type MemorySite } from "./fixtures/memory-site.js";

const PORT = 6493;
const URL = `http://127.0.0.1:${PORT}`;

let site: MemorySite;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dir: string;

const toolQueue: Array<{ tool: string; input: Record<string, unknown> }> = [];
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const model = new MockLanguageModelV3({
    doGenerate: async () => {
        const next = toolQueue.shift();
        if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
        return { content: [{ type: "tool-call" as const, toolCallId: `c${Math.random()}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
    },
});

const IDEAS = [
    { title: "Browse the product list", journey: "Browse products", startPath: "/products", heading: "Products" },
    { title: "Read the about page", journey: "Read about us", startPath: "/about", heading: "About us" },
] as const;

const scripted: LlmClient = {
    modelName: "scripted",
    model,
    usage: { inputTokens: 0, outputTokens: 0 },
    text: async () => "",
    object: (async ({ system, prompt }: { system: string; prompt: string }) => {
        if (prompt.includes("Already covered by the plan")) return { scenarios: [] };
        if (/list what they state about its intended behaviour/.test(system)) return { rules: [], workflows: [], roles: [], transitions: [], entities: [] };
        if (/analysing a web application/.test(system)) {
            return {
                siteType: "ecommerce",
                purpose: "A small shop",
                features: ["Browse products"],
                pagePurposes: [],
                journeys: [
                    { name: "Browse products", description: "Look at products", steps: ["Open products"], priority: "high", pages: ["/", "/products"], requiresAuth: false },
                    { name: "Read about us", description: "Read the about page", steps: ["Open about"], priority: "low", pages: ["/about"], requiresAuth: false },
                ],
                authenticationMechanisms: [],
            };
        }
        for (const s of IDEAS) {
            toolQueue.push({ tool: "assert", input: { check: "visible", target: { by: "role", role: "heading", value: s.heading } } });
            toolQueue.push({ tool: "finish", input: { result: "complete", explanation: "checked" } });
        }
        return {
            scenarios: IDEAS.map((s) => ScenarioSchema.omit({ scenarioId: true }).parse({ title: s.title, description: s.title, category: "Browsing", priority: "high", journey: s.journey, startPath: s.startPath, expectedResults: [`${s.heading} is shown`] })),
        };
    }) as LlmClient["object"],
};

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = await startMemorySite(PORT);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-cases-not-run-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", CONCURRENCY: "1", MAX_REPAIR_ATTEMPTS: "1", SECRET_KEY: "test-secret-key-0123456789" }));
    server = await buildServer(platform);
    worker = new Worker({ ...platform, makeLlm: () => scripted }, 100);
    worker.start();
}, 60_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    site?.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body.startsWith("{") || res.body.startsWith("[") ? JSON.parse(res.body) : res.body };
};
const DONE = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];
async function finished(jobId: string): Promise<any> {
    for (let i = 0; i < 600; i++) {
        const job = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (DONE.includes(job.status)) return job;
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("the job did not finish");
}
const executionsOf = (projectId: string) => platform.db.all("SELECT e.id FROM test_executions e JOIN test_cases t ON t.id = e.test_case_id WHERE t.project_id = ?", projectId);
/** A Project Admin approves the AI's draft (drafts never run until approved, review-store.ts). */
const approve = async (testId: string) => {
    const v = await call("GET", `/api/tests/${testId}/review/1`);
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    const r = await call("POST", `/api/tests/${testId}/review/1/approve`, { seen: v.body.updatedAt });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const testsOf = async (projectId: string) => (await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; testId: string; title: string; validationStatus: string }>;

describe("the Test Case Generation Agent only writes the test cases", () => {
    let projectId = "";
    let journeys: Array<{ id: string; testId: string; title: string; validationStatus: string }> = [];

    it("confirming a plan writes its journeys as test cases and runs none of them", async () => {
        projectId = (await call("POST", "/api/projects", { name: "Cases only" })).body.id as string;
        const planJob = (await call("POST", `/api/projects/${projectId}/test-generation`, { url: URL, maxPages: 10, targets: ["web"], plan: true })).body.jobId as string;
        expect((await finished(planJob)).status).toBe("COMPLETED");

        // Only the journeys: every check off, so whatever runs here could only be a test case.
        const created = await call("POST", `/api/projects/${projectId}/plans/${planJob}/create`, { accessibility: false, healthChecks: false, inputChecks: false, securityChecks: false });
        expect(created.status, JSON.stringify(created.body)).toBe(202);
        const job = await finished(created.body.jobId);
        expect(job.status, JSON.stringify(job)).toBe("COMPLETED");

        // Written, with their steps.
        journeys = (await testsOf(projectId)).filter((t) => t.testId.startsWith("WEB-"));
        expect(journeys.map((t) => t.title).sort()).toEqual(IDEAS.map((i) => i.title).sort());
        for (const t of journeys) {
            const full = (await call("GET", `/api/tests/${t.id}`)).body;
            expect(full.spec.steps.length).toBeGreaterThan(0);
        }
        // Not run: no result, no execution, no run job, and the job's validation phase did nothing.
        expect(journeys.map((t) => t.validationStatus)).toEqual(["PENDING", "PENDING"]);
        expect(executionsOf(projectId)).toEqual([]);
        expect(platform.repo.listJobs(projectId).filter((j) => j.options.mode === "validate" || j.options.mode === "environment" || j.options.mode === "variants")).toEqual([]);
        expect(job.progress).toMatchObject({ generation: "done", validation: "skipped" });
        expect(job.testsValidated).toBe(0);
        const events = (await call("GET", `/api/test-generation/${created.body.jobId}/events`)).body as Array<{ kind: string; message: string }>;
        const kinds = events.map((e) => e.kind);
        expect(kinds).not.toContain("validation_passed");
        expect(kinds).not.toContain("validation_failed");
        // The job says why they were not run, and where running is.
        const note = events.find((e) => e.kind === "test_cases_not_run");
        expect(note?.message).toMatch(/2 test cases were written and not run/);
    }, 240_000);

    it("the person's own Run still runs them, once their drafts are approved", async () => {
        for (const t of journeys) await approve(t.id);
        const started = await call("POST", `/api/projects/${projectId}/runs`, { testIds: journeys.map((t) => t.id) });
        expect(started.status, JSON.stringify(started.body)).toBe(202);
        expect(started.body.testCount).toBe(2);
        const job = await finished(started.body.jobId);
        expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(job.status);
        expect(executionsOf(projectId).length).toBeGreaterThanOrEqual(2);
        const after = (await testsOf(projectId)).filter((t) => t.testId.startsWith("WEB-"));
        expect(after.map((t) => t.validationStatus)).toEqual(["VALIDATED", "VALIDATED"]);
    }, 240_000);
});
