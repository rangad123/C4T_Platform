/**
 * Site memory through real jobs: HTTP API -> queue -> worker -> real discovery of a local site that CHANGES between two
 * analyses -> understanding and planning with a scripted model double -> real authoring and validation in a browser.
 * Checks that the second analysis's prompts carry the "previously known" section, that the change summary is exactly
 * right, that `useMemory: false` and a forgotten project get no memory, that projects are isolated, that a corrupted
 * record only produces a warning, and that nothing from the site or the credentials reaches the stored memory.
 *
 * Fixture site: port 5490 (tests/fixtures/memory-site.ts). The platform is driven through `server.inject`.
 * Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/memory-pipeline.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { MEMORY_HEADING } from "../src/engine/memory/context.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { loadMemory } from "../src/platform/memory-store.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { MEMORY_SITE_TEXT, MEMORY_SITE_USER, startMemorySite, type MemorySite } from "./fixtures/memory-site.js";

const PORT = 5490;
const URL = `http://127.0.0.1:${PORT}`;
const ORIGIN = URL;

let site: MemorySite;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dir: string;

// ── the scripted model ────────────────────────────────────────────────────────
const prompts = { analysis: [] as string[], plan: [] as string[] };
let version: 1 | 2 = 1;
/** Tool calls the authoring agent will make, queued when the plan is produced (one scenario after another). */
const toolQueue: Array<{ tool: string; input: Record<string, unknown> }> = [];

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const model = new MockLanguageModelV3({
    doGenerate: async () => {
        const next = toolQueue.shift();
        if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
        return { content: [{ type: "tool-call" as const, toolCallId: `c${Math.random()}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
    },
});

const PLANS = {
    1: [
        { title: "Browse the product list", journey: "Browse products", startPath: "/products", heading: "Products" },
        { title: "Read the about page", journey: "Read about us", startPath: "/about", heading: "About us" },
    ],
    2: [{ title: "Browse the product list", journey: "Browse products", startPath: "/products", heading: "All products" }],
} as const;

const scripted: LlmClient = {
    modelName: "scripted",
    model,
    usage: { inputTokens: 0, outputTokens: 0 },
    text: async () => "",
    object: (async ({ system, prompt }: { system: string; prompt: string }) => {
        if (/analysing a web application/.test(system)) {
            prompts.analysis.push(prompt);
            return {
                siteType: "ecommerce",
                // The model writes the visitor's e-mail and password into its summary: memory must scrub them.
                purpose: `A small shop where ${MEMORY_SITE_USER.email} signs in with ${MEMORY_SITE_USER.password}`,
                features: ["Browse products"],
                pagePurposes: [],
                journeys:
                    version === 1
                        ? [
                              { name: "Browse products", description: "Look at products", steps: ["Open products"], priority: "high", pages: ["/", "/products"], requiresAuth: false },
                              { name: "Read about us", description: "Read the about page", steps: ["Open about"], priority: "low", pages: ["/about"], requiresAuth: false },
                          ]
                        : [
                              { name: "Browse products", description: "Look at products", steps: ["Open products"], priority: "high", pages: ["/", "/products"], requiresAuth: false },
                              { name: "Read the news", description: "Read the news", steps: ["Open news"], priority: "low", pages: ["/news"], requiresAuth: false },
                          ],
                authenticationMechanisms: [],
            };
        }
        prompts.plan.push(prompt);
        const plan = PLANS[version];
        for (const s of plan) {
            toolQueue.push({ tool: "assert", input: { check: "visible", target: { by: "role", role: "heading", value: s.heading } } });
            toolQueue.push({ tool: "finish", input: { result: "complete", explanation: "checked" } });
        }
        return {
            scenarios: plan.map((s) =>
                ScenarioSchema.omit({ scenarioId: true }).parse({ title: s.title, description: s.title, category: "Browsing", priority: "high", journey: s.journey, startPath: s.startPath, expectedResults: [`${s.heading} is shown`] }),
            ),
        };
    }) as LlmClient["object"],
};

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = await startMemorySite(PORT);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-memory-pipeline-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", CONCURRENCY: "1" }));
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

// ── helpers ───────────────────────────────────────────────────────────────────
const call = async (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body.startsWith("{") || res.body.startsWith("[") ? JSON.parse(res.body) : res.body };
};
const newProject = async (name: string) => (await call("POST", "/api/projects", { name })).body.id as string;

interface RunResult {
    jobId: string;
    status: string;
    analysisPrompt: string;
    planPrompt: string;
    events: Array<{ kind: string; level: string; message: string; data: Record<string, number> | null }>;
    pagesDiscovered: number;
}
/** Run one real analysis of the fixture (at `v`) and wait for it. */
async function analyse(projectId: string, v: 1 | 2, options: Record<string, unknown> = {}): Promise<RunResult> {
    version = v;
    site.setVersion(v);
    toolQueue.length = 0;
    const before = { analysis: prompts.analysis.length, plan: prompts.plan.length };
    const queued = await call("POST", `/api/projects/${projectId}/test-generation`, {
        url: URL,
        targets: ["web"],
        maxPages: 10,
        credentials: { username: MEMORY_SITE_USER.email, password: MEMORY_SITE_USER.password },
        accessibility: false,
        healthChecks: false,
        securityChecks: false,
        inputChecks: false,
        contractChecks: false,
        accessChecks: false,
        ...options,
    });
    expect(queued.status).toBe(202);
    let job: { status: string; counters: { pagesDiscovered: number } } | undefined;
    for (let i = 0; i < 480; i++) {
        job = (await call("GET", `/api/test-generation/${queued.body.jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job!.status)) break;
        await new Promise((r) => setTimeout(r, 500));
    }
    const events = (await call("GET", `/api/test-generation/${queued.body.jobId}/events`)).body as RunResult["events"];
    return {
        jobId: queued.body.jobId,
        status: job!.status,
        analysisPrompt: prompts.analysis.slice(before.analysis).join("\n---\n"),
        planPrompt: prompts.plan.slice(before.plan).join("\n---\n"),
        events,
        pagesDiscovered: job!.counters.pagesDiscovered,
    };
}
const storedJson = (projectId: string) => platform.db.all<{ knowledge_json: string; changes_json: string | null }>("SELECT knowledge_json, changes_json FROM site_memory WHERE project_id = ?", projectId).map((r) => r.knowledge_json + (r.changes_json ?? "")).join("\n");

// ── the journey ───────────────────────────────────────────────────────────────
describe("site memory across two real analyses", () => {
    let a: string;
    let b: string;
    let first: RunResult;
    let second: RunResult;
    let off: RunResult;
    let updatedAfterSecond: string;

    it("first analysis: no memory in the prompts; what was learned is saved and no site text or credential is stored", async () => {
        a = await newProject("memory A");
        b = await newProject("memory B");
        first = await analyse(a, 1);
        expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(first.status);
        expect(first.analysisPrompt).not.toContain(MEMORY_HEADING);
        expect(first.planPrompt).not.toContain(MEMORY_HEADING);
        expect(first.events.some((e) => e.kind === "memory_used")).toBe(false);
        expect(first.events.find((e) => e.kind === "memory_saved")!.message).toMatch(/^Saved what was learned about this site for next time/);

        const mem = (await call("GET", `/api/projects/${a}/memory`)).body;
        expect(mem).toMatchObject({ remembered: true, origin: ORIGIN, siteType: "ecommerce", changes: null });
        expect(mem.pages.map((p: { path: string }) => p.path).sort()).toEqual(["/", "/account", "/about", "/login", "/products"].sort());
        expect(mem.loginPath).toBe("/login");
        expect(mem.journeys).toEqual([{ name: "Browse products", priority: "high", validatedTests: 1 }, { name: "Read about us", priority: "low", validatedTests: 1 }]);

        const json = storedJson(a);
        for (const secret of [...Object.values(MEMORY_SITE_TEXT), MEMORY_SITE_USER.email, MEMORY_SITE_USER.password, "shopper", "Signed in as", "Sentinel-Pass"]) expect(json, secret).not.toContain(secret);
        expect(json).toContain("/api/items");
        expect(json).toContain("/api/legacy");
    }, 240_000);

    it("second analysis of the changed site: prompts carry the memory, and the change summary is exactly right", async () => {
        second = await analyse(a, 2);
        expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(second.status);

        for (const prompt of [second.analysisPrompt, second.planPrompt]) {
            expect(prompt).toContain(MEMORY_HEADING);
            expect(prompt).toContain("/about [");
            expect(prompt).toContain(`"Read about us"`);
            expect(prompt).toContain("GET /api/legacy");
        }
        // The early comparison is what tells the model where to look.
        expect(second.analysisPrompt).toContain("new pages: /news");
        expect(second.analysisPrompt).toContain("pages whose structure changed: /products");
        expect(second.analysisPrompt).toContain("not found in this crawl: /about");
        expect(second.analysisPrompt).toContain("endpoints not seen now: GET /api/legacy");
        expect(second.planPrompt).toContain(`validated tests: "Browse the product list"`);
        // No credential, site text or e-mail address went into the model through memory either.
        const memorySection = second.analysisPrompt.slice(second.analysisPrompt.indexOf(MEMORY_HEADING));
        for (const secret of [MEMORY_SITE_TEXT.link, MEMORY_SITE_USER.password]) expect(memorySection).not.toContain(secret);

        const used = second.events.find((e) => e.kind === "memory_used")!;
        expect(used.data).toMatchObject({ pages: 5 });

        const changes = second.events.find((e) => e.kind === "memory_changes")!;
        expect(changes.message).toBe("Since the last analysis: 1 new page, 1 page changed, 1 page no longer found, 1 endpoint gone, 1 journey no longer validating.");
        expect(changes.data).toEqual({ pagesAdded: 1, pagesRemoved: 1, pagesChanged: 1, endpointsAdded: 0, endpointsRemoved: 1, journeysNoLongerValidating: 1 });

        const mem = (await call("GET", `/api/projects/${a}/memory`)).body;
        expect(mem.changes).toMatchObject({
            pagesAdded: ["/news"],
            pagesRemoved: ["/about"],
            pagesChanged: ["/products"],
            endpointsAdded: [],
            endpointsRemoved: ["GET /api/legacy"],
            journeysNoLongerValidating: ["Read about us"],
            text: changes.message,
        });
        expect(mem.pages.map((p: { path: string }) => p.path).sort()).toEqual(["/", "/account", "/login", "/news", "/products"].sort());
        expect(mem.journeys.map((j: { name: string }) => j.name)).toEqual(["Browse products", "Read the news"]);
        updatedAfterSecond = mem.updatedAt;
        for (const secret of [...Object.values(MEMORY_SITE_TEXT), MEMORY_SITE_USER.email, MEMORY_SITE_USER.password]) expect(storedJson(a), secret).not.toContain(secret);
    }, 240_000);

    it("memory never suppresses discovery: the same pages are crawled with memory off", async () => {
        off = await analyse(a, 2, { useMemory: false });
        expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(off.status);
        expect(off.pagesDiscovered).toBe(second.pagesDiscovered);
        expect(off.pagesDiscovered).toBe(5);
    }, 240_000);

    it("useMemory:false gives the model no memory, and leaves what is remembered untouched", () => {
        expect(off.analysisPrompt).not.toContain(MEMORY_HEADING);
        expect(off.planPrompt).not.toContain(MEMORY_HEADING);
        expect(off.events.some((e) => e.kind === "memory_used" || e.kind === "memory_changes" || e.kind === "memory_saved")).toBe(false);
        const row = platform.db.get<{ updated_at: string }>("SELECT updated_at FROM site_memory WHERE project_id = ?", a)!;
        expect(row.updated_at).toBe(updatedAfterSecond);
    });

    it("another project analysing the same site starts without memory, and forgetting one project leaves the other", async () => {
        const other = await analyse(b, 2);
        expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(other.status);
        expect(other.analysisPrompt).not.toContain(MEMORY_HEADING);
        expect(other.planPrompt).not.toContain(MEMORY_HEADING);
        expect((await call("GET", `/api/projects/${b}/memory`)).body.changes).toBeNull();

        const forgotten = await call("DELETE", `/api/projects/${a}/memory`);
        expect(forgotten.body).toEqual({ forgotten: true });
        expect((await call("GET", `/api/projects/${a}/memory`)).body.remembered).toBe(false);
        expect(loadMemory(platform.db, a, ORIGIN).knowledge).toBeNull();
        expect((await call("GET", `/api/projects/${b}/memory`)).body.remembered).toBe(true);
    }, 240_000);

    it("a corrupted record is dropped with a warning event and the job still completes", async () => {
        platform.db.run("UPDATE site_memory SET knowledge_json = ? WHERE project_id = ?", '{"version":1,"pages":', b);
        const run = await analyse(b, 1);
        expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(run.status);
        const warning = run.events.find((e) => e.kind === "memory_warning");
        expect(warning).toMatchObject({ level: "warn" });
        expect(warning!.message).toMatch(/damaged or too large/);
        expect(run.analysisPrompt).not.toContain(MEMORY_HEADING);
        // and fresh notes were saved in its place
        expect(loadMemory(platform.db, b, ORIGIN).knowledge!.pages.map((p) => p.path)).toContain("/about");
    }, 240_000);
});
