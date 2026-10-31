/**
 * Exploration reuse through real jobs: HTTP API -> queue -> worker -> real discovery of a local site -> understanding with a scripted model
 * double that records every prompt (never a real model).
 *   - a second exploration of an unchanged site sends no page snapshot to the AI again: every page gets one line with what was understood
 *     about it last time; the job log says so and the job's AI usage counts the pages;
 *   - "send every page to the AI again" (fullExploration) and the switch in Settings turn it off;
 *   - a page whose structure changed is sent in full again, the unchanged ones are not.
 * Fixture site: port 7351 (tests/fixtures/memory-site.ts). Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/exploration-reuse.test.ts
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
import { MEMORY_SITE_TEXT, MEMORY_SITE_USER, startMemorySite, type MemorySite } from "./fixtures/memory-site.js";

const PORT = 7351;
const URL = `http://127.0.0.1:${PORT}`;

let site: MemorySite;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dir: string;

const analysisPrompts: string[] = [];
const toolQueue: Array<{ tool: string; input: Record<string, unknown> }> = [];
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const model = new MockLanguageModelV3({
    doGenerate: async () => {
        const next = toolQueue.shift();
        if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
        return { content: [{ type: "tool-call" as const, toolCallId: `c${Math.random()}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
    },
});
const scripted: LlmClient = {
    modelName: "scripted",
    model,
    usage: { inputTokens: 0, outputTokens: 0 },
    text: async () => "",
    object: (async ({ system, prompt }: { system: string; prompt: string }) => {
        if (/analysing a web application/.test(system)) {
            analysisPrompts.push(prompt);
            return {
                siteType: "ecommerce",
                purpose: "A small shop",
                features: ["Browse products"],
                // Only the first exploration names the home page's purpose; later ones leave it to what was understood then.
                pagePurposes: analysisPrompts.length === 1 ? [{ path: "/", type: "home", purpose: "The shop's front page" }] : [],
                journeys: [{ name: "Browse products", description: "Look at products", steps: ["Open products"], priority: "high", pages: ["/", "/products"], requiresAuth: false }],
                authenticationMechanisms: [],
            };
        }
        toolQueue.push({ tool: "assert", input: { check: "visible", target: { by: "role", role: "heading", value: "Products" } } });
        toolQueue.push({ tool: "finish", input: { result: "complete", explanation: "checked" } });
        return { scenarios: [ScenarioSchema.omit({ scenarioId: true }).parse({ title: "Browse the product list", description: "Browse", category: "Browsing", priority: "high", journey: "Browse products", startPath: "/products", expectedResults: ["Products is shown"] })] };
    }) as LlmClient["object"],
};

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = await startMemorySite(PORT);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-reuse-"));
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

const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body.startsWith("{") || res.body.startsWith("[") ? JSON.parse(res.body) : res.body };
};

interface Explored {
    jobId: string;
    status: string;
    prompt: string;
    events: Array<{ kind: string; message: string; data: Record<string, number> | null }>;
    pages: number;
}
async function explore(projectId: string, v: 1 | 2, options: Record<string, unknown> = {}): Promise<Explored> {
    site.setVersion(v);
    toolQueue.length = 0;
    const before = analysisPrompts.length;
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
    expect(queued.status, JSON.stringify(queued.body)).toBe(202);
    let job: { status: string; counters: { pagesDiscovered: number } } | undefined;
    for (let i = 0; i < 480; i++) {
        job = (await call("GET", `/api/test-generation/${queued.body.jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job!.status)) break;
        await new Promise((r) => setTimeout(r, 400));
    }
    return {
        jobId: queued.body.jobId,
        status: job!.status,
        prompt: analysisPrompts.slice(before).join("\n---\n"),
        events: (await call("GET", `/api/test-generation/${queued.body.jobId}/events`)).body,
        pages: job!.counters.pagesDiscovered,
    };
}
const reusedEvent = (e: Explored) => e.events.find((x) => x.kind === "understanding_reused");

describe("exploration reuse across real explorations", () => {
    let projectId: string;
    let first: Explored;

    it("first exploration: everything is sent, and what was understood is remembered", async () => {
        projectId = (await call("POST", "/api/projects", { name: "Reuse" })).body.id;
        first = await explore(projectId, 1);
        expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(first.status);
        expect(first.pages).toBe(5);
        expect(reusedEvent(first)).toBeUndefined();
        expect(first.prompt).toContain(MEMORY_SITE_TEXT.page);
        expect(first.prompt).not.toContain("unchanged since");
    }, 300_000);

    it("the same site again: no page is sent to the AI again; the log and AI usage say so", async () => {
        const again = await explore(projectId, 1, { plan: true });
        expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(again.status);
        const e = reusedEvent(again)!;
        expect(e.data).toEqual({ pages: 5, of: 5 });
        expect(e.message).toMatch(/^5 of 5 pages have not changed since the exploration of \d{4}-\d{2}-\d{2}: what the AI understood about them then is used, and they are not sent to the AI again \(/);
        expect(again.prompt.match(/unchanged since the exploration of/g)).toHaveLength(5);
        expect(again.prompt).toContain("understood then as: The shop's front page");
        // No snapshot of any page: the page text the snapshots carry is not in the prompt.
        expect(again.prompt).not.toContain(MEMORY_SITE_TEXT.page);
        expect(again.prompt.length).toBeLessThan(first.prompt.length);
        console.log(`[exploration-reuse] understanding prompt: ${first.prompt.length} characters on the first exploration, ${again.prompt.length} when nothing changed`);
        const u = (await call("GET", `/api/jobs/${again.jobId}/usage`)).body;
        expect(u.withoutAi).toMatchObject({ pagesReused: 5, repairs: 0 });
    }, 300_000);

    it("“send every page to the AI again” and the switch in Settings send everything", async () => {
        const full = await explore(projectId, 1, { plan: true, fullExploration: true });
        expect(reusedEvent(full)).toBeUndefined();
        expect(full.events.find((x) => x.kind === "full_exploration")?.message).toBe("Exploring every page again, as asked: nothing is reused from the last exploration.");
        expect(full.prompt).toContain(MEMORY_SITE_TEXT.page);
        expect((await call("POST", `/api/projects/${projectId}/test-generation`, { url: URL, fullExploration: "yes" })).status).toBe(400);

        expect((await call("PUT", "/api/llm/without-ai", { explorationReuse: false })).status).toBe(200);
        const off = await explore(projectId, 1, { plan: true });
        expect(reusedEvent(off)).toBeUndefined();
        expect(off.events.some((x) => x.kind === "full_exploration")).toBe(false);
        expect(off.prompt).not.toContain("unchanged since");
        await call("PUT", "/api/llm/without-ai", { explorationReuse: null });
    }, 300_000);

    it("a changed site: changed and new pages are sent in full, unchanged ones are not", async () => {
        const v2 = await explore(projectId, 2, { plan: true });
        const e = reusedEvent(v2)!;
        expect(e).toBeDefined();
        expect(e.data!.pages).toBeLessThan(v2.pages);
        expect(e.message).not.toMatch(/\/products|\/news/);
        expect(v2.prompt).toMatch(/### \/products [^\n]*status=200\n/);
        expect(v2.prompt).toMatch(/### \/news [^\n]*status=200\n/);
        expect(v2.prompt).toMatch(/### \/login [^\n]*unchanged since/);
    }, 300_000);
});
