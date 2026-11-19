/**
 * Reuse earlier runs (sheet #8 (a)) through real jobs: HTTP API -> queue -> worker -> real discovery of a local site (behind the benchmark's
 * change proxy) -> understanding and planning with a scripted model double -> real authoring in a browser.
 *   - a plan-only exploration saves site memory and dates its probe results;
 *   - the next exploration starts from the project's known pages and takes the probe results of unchanged pages (one event says so);
 *     the page changed between the runs is read again, and the change is reported;
 *   - another AI model reads every page again; "explore everything again" reuses nothing;
 *   - another project exploring the same site gets nothing of this project's;
 *   - a person's Run of a journey test updates the site memory.
 * Fixture site: port 7471, change proxy 7472 (tests/fixtures/reuse-site.ts). Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/probe-reuse-pipeline.test.ts
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
import { loadMemory, saveMemory } from "../src/platform/memory-store.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { ChangeProxy } from "../src/eval/bench/repeat/change-proxy.js";
import { startReuseSite, type ReuseSite } from "./fixtures/reuse-site.js";

const PORT = 7471;
let site: ReuseSite;
let proxy: ChangeProxy;
let URL = "";
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dir: string;

const analysisPrompts: string[] = [];
const toolQueue: Array<{ tool: string; input: Record<string, unknown> }> = [];
let modelName = "scripted-one";
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const model = new MockLanguageModelV3({
    doGenerate: async () => {
        const next = toolQueue.shift();
        if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
        return { content: [{ type: "tool-call" as const, toolCallId: `c${Math.random()}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
    },
});
const JOURNEY = "Read page a";
const SCENARIO = "Open page a";
const scripted = (): LlmClient => ({
    modelName,
    model,
    usage: { inputTokens: 0, outputTokens: 0 },
    text: async () => "",
    object: (async ({ system, prompt }: { system: string; prompt: string }) => {
        if (/analysing a web application/.test(system)) {
            analysisPrompts.push(prompt);
            return {
                siteType: "content",
                purpose: "A few pages",
                features: ["Read pages"],
                pagePurposes: [{ path: "/a", type: "content", purpose: "Page a" }],
                journeys: [{ name: JOURNEY, description: "Read page a", steps: ["Open page a"], priority: "high", pages: ["/a"], requiresAuth: false }],
                authenticationMechanisms: [],
            };
        }
        toolQueue.push({ tool: "assert", input: { check: "visible", target: { by: "role", role: "heading", value: "Page a" } } });
        toolQueue.push({ tool: "finish", input: { result: "complete", explanation: "checked" } });
        return { scenarios: [ScenarioSchema.omit({ scenarioId: true }).parse({ title: SCENARIO, description: "Open", category: "Browsing", priority: "high", journey: JOURNEY, startPath: "/a", expectedResults: ["Page a is shown"] })] };
    }) as LlmClient["object"],
});

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = await startReuseSite(PORT);
    proxy = new ChangeProxy(`http://127.0.0.1:${PORT}`, { id: "c-email-removed", path: "/c", find: /<label for="email">Contact e-mail<\/label><input id="email" name="email" type="email" aria-describedby="email-msg">/g, replace: "", what: "Page c lost its e-mail field." });
    await proxy.start(PORT + 1);
    URL = proxy.url;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-probe-reuse-pipeline-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", CONCURRENCY: "1" }));
    server = await buildServer(platform);
    worker = new Worker({ ...platform, makeLlm: () => scripted() }, 100);
    worker.start();
}, 60_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    await proxy?.stop();
    site?.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body.startsWith("{") || res.body.startsWith("[") ? JSON.parse(res.body) : res.body };
};
type Ev = { kind: string; level: string; message: string; data: Record<string, unknown> | null };
interface Explored {
    jobId: string;
    status: string;
    prompt: string;
    events: Ev[];
    opened: Record<string, number>;
}
async function waitJob(jobId: string): Promise<string> {
    for (let i = 0; i < 600; i++) {
        const job = (await call("GET", `/api/test-generation/${jobId}`)).body as { status: string };
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) return job.status;
        await new Promise((r) => setTimeout(r, 400));
    }
    return "TIMEOUT";
}
async function explore(projectId: string, options: Record<string, unknown> = {}): Promise<Explored> {
    toolQueue.length = 0;
    site.more.clear();
    const before = analysisPrompts.length;
    const queued = await call("POST", `/api/projects/${projectId}/test-generation`, {
        url: URL,
        targets: ["web"],
        maxPages: 10,
        accessibility: false,
        healthChecks: false,
        securityChecks: false,
        performanceChecks: false,
        inputChecks: false,
        contractChecks: false,
        accessChecks: false,
        visionChecks: false,
        ...options,
    });
    expect(queued.status, JSON.stringify(queued.body)).toBe(202);
    const status = await waitJob(queued.body.jobId);
    return {
        jobId: queued.body.jobId,
        status,
        prompt: analysisPrompts.slice(before).join("\n---\n"),
        events: (await call("GET", `/api/test-generation/${queued.body.jobId}/events`)).body,
        opened: Object.fromEntries([...site.more.entries()].sort()),
    };
}
const ev = (e: Explored, kind: string) => e.events.find((x) => x.kind === kind);
const ALL_OPENED = { a: 1, b: 1, c: 1, d: 1, e: 1, home: 1 };
const newProject = async (name: string) => (await call("POST", "/api/projects", { name })).body.id as string;

describe("reuse earlier runs across real explorations", () => {
    let projectId: string;
    let first: Explored;

    it("a plan-only exploration saves site memory and dates its probe results", async () => {
        projectId = await newProject("reuse A");
        // The journey test is run by a person later on: AI-written tests run without waiting for a review here.
        expect((await call("PUT", `/api/projects/${projectId}/review-policy`, { aiGenerated: false })).status).toBe(200);
        first = await explore(projectId, { plan: true });
        expect(first.status, JSON.stringify(first.events.filter((e) => e.level !== "info"))).not.toBe("FAILED");
        expect(first.opened).toEqual(ALL_OPENED);
        expect(ev(first, "plan_ready")).toBeTruthy();
        const mem = loadMemory(platform.db, projectId, URL).knowledge;
        expect(mem, "plan-only memory").not.toBeNull();
        expect(mem!.pages.map((p) => p.path).sort()).toEqual(["/", "/a", "/b", "/c", "/d", "/e"]);
        expect(mem!.pages.every((p) => p.model === "scripted-one")).toBe(true);
        expect(platform.repo.getLatestAppModel(projectId)!.pages.every((p) => p.probedAt)).toBe(true);
    }, 300_000);

    let second: Explored;
    it("the next exploration takes the probe results of unchanged pages; the page changed in between is read again and reported", async () => {
        proxy.changed = true;
        try {
            // It also runs its test cases (runTestCases; an exploration writes them without running by default), so the journey's saved
            // test is seen running beside the reuse.
            second = await explore(projectId, { runTestCases: true });
        } finally {
            proxy.changed = false;
        }
        expect(second.status).not.toBe("FAILED");
        expect(proxy.hits).toBeGreaterThan(0);
        const reused = ev(second, "probes_reused")!;
        expect(reused.message).toMatch(/^reused: \d pages unchanged since \d{4}-\d\d-\d\d/);
        expect(reused.data!.paths).not.toContain("/c");
        // "/c" was probed again (its toggle opened), and so were the spot checks; the reused pages were not.
        expect(second.opened.c).toBe(1);
        for (const p of reused.data!.paths as string[]) expect(second.opened[p === "/" ? "home" : p.slice(1)], p).toBeUndefined();
        const stored = platform.repo.getLatestAppModel(projectId)!;
        expect(stored.pages.find((p) => p.path === "/c")!.reusedFrom).toBeUndefined();
        expect(stored.pages.find((p) => p.path === "/c")!.forms.flatMap((f) => f.fields).some((f) => f.name === "email")).toBe(false);
        for (const p of reused.data!.paths as string[]) expect(stored.pages.find((x) => x.path === p)!.reusedFrom, p).toBeTruthy();
        // Reported: the change summary names the changed page.
        expect(ev(second, "memory_changes")!.message).toMatch(/1 page changed/);
        const changes = JSON.parse(platform.db.get<{ c: string }>("SELECT changes_json AS c FROM site_memory WHERE project_id = ?", projectId)!.c);
        expect(changes.pagesChanged).toEqual(["/c"]);
        // The understanding of unchanged pages was reused by the same model; the AI still read the changed one.
        expect(ev(second, "understanding_reused")).toBeTruthy();
        // The saved test of the journey still ran: reuse never skips a check.
        const ran = platform.db.get<{ v: string }>("SELECT validation_status AS v FROM test_cases WHERE project_id = ? AND title = ? AND job_id = ?", projectId, SCENARIO, second.jobId);
        expect(ran?.v).toBe("VALIDATED");
    }, 300_000);

    it("another AI model reads every page again (its understanding is not reused)", async () => {
        modelName = "scripted-two";
        try {
            const third = await explore(projectId, { plan: true });
            expect(third.status).not.toBe("FAILED");
            expect(ev(third, "understanding_reused")).toBeUndefined();
            expect(loadMemory(platform.db, projectId, URL).knowledge!.pages.every((p) => p.model === "scripted-two")).toBe(true);
        } finally {
            modelName = "scripted-one";
        }
    }, 300_000);

    it("“explore everything again” reuses nothing: every page is probed and no reuse is said", async () => {
        const full = await explore(projectId, { plan: true, fullExploration: true });
        expect(full.status).not.toBe("FAILED");
        expect(full.opened).toEqual(ALL_OPENED);
        expect(ev(full, "probes_reused")).toBeUndefined();
        expect(platform.repo.getLatestAppModel(projectId)!.pages.some((p) => p.reusedFrom)).toBe(false);
    }, 300_000);

    it("another project exploring the same site gets nothing of this one's", async () => {
        const other = await newProject("reuse B");
        const b = await explore(other, { plan: true });
        expect(b.status).not.toBe("FAILED");
        expect(b.opened).toEqual(ALL_OPENED);
        for (const kind of ["memory_used", "probes_reused", "understanding_reused", "pages_from_memory"]) expect(ev(b, kind), kind).toBeUndefined();
        expect(platform.repo.getLatestAppModel(other)!.pages.some((p) => p.reusedFrom)).toBe(false);
    }, 300_000);

    it("a person's Run of the journey's test updates the site memory", async () => {
        // What the memory knew is taken back, so only the Run can put it there.
        const stored = loadMemory(platform.db, projectId, URL).knowledge!;
        saveMemory(platform.db, { projectId, knowledge: { ...stored, journeys: stored.journeys.map((j) => ({ ...j, validated: [] })) }, changes: null });
        const test = platform.db.get<{ id: string }>("SELECT id FROM test_cases WHERE project_id = ? AND title = ? ORDER BY created_at DESC", projectId, SCENARIO);
        expect(test, "the journey test written by the second exploration").toBeTruthy();
        const queued = await call("POST", `/api/tests/${test!.id}/validate`);
        expect(queued.status, JSON.stringify(queued.body)).toBe(202);
        const status = await waitJob(queued.body.jobId);
        const events = (await call("GET", `/api/test-generation/${queued.body.jobId}/events`)).body as Ev[];
        expect(status, JSON.stringify(events.filter((e) => e.level !== "info"))).not.toBe("FAILED");
        expect(events.find((e) => e.kind === "memory_run_noted")!.message).toMatch(/Site memory updated from this run: 1 journey test now known to pass/);
        expect(loadMemory(platform.db, projectId, URL).knowledge!.journeys.find((j) => j.name === JOURNEY)!.validated).toEqual([SCENARIO]);
    }, 300_000);
});
