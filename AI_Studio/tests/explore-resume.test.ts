/**
 * Stopping an exploration and continuing it (sheet #5, #6), through real jobs on the embedded worker: HTTP API -> queue -> worker -> a real
 * crawl of a small local site -> a scripted model double for reading, planning and writing tests -> the plan -> the tests.
 *
 * - A stop is a stop: once a creation is stopped, nothing more is created (no checks are made after it) and the ideas it came before are not
 *   counted as skipped or failed.
 * - Continue carries on instead of starting again: a plan-only exploration stopped while planning does not crawl or read the application
 *   again; one stopped while crawling starts again and says why; a creation stopped while writing makes only the ideas and checks it had not
 *   made, runs the tests that had no result, and ends with exactly the tests an uninterrupted creation makes, none twice.
 * - Continue is refused for a job that was not stopped, and for one already continued.
 *
 * node scripts/with-lock.mjs browser -- npx vitest run tests/explore-resume.test.ts
 * Ports: fixture site 6731.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { getScheduleServices } from "../src/platform/schedule-services.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const PORT = 6731;
const SITE = `http://127.0.0.1:${PORT}`;

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let site: http.Server;
let dir: string;
let svc: ReturnType<typeof getScheduleServices>;

/** Milliseconds every page waits before answering (a slow crawl a stop can land in). */
let pageDelay = 0;
const pageHits: string[] = [];
const PAGES: Record<string, string> = {
    "/": `<h1>Shop</h1><nav><a href="/products">Products</a> <a href="/about">About</a> <a href="/contact">Contact</a> <a href="/faq">FAQ</a></nav>`,
    "/products": `<h1>Products</h1><a href="/">Home</a>`,
    "/about": `<h1>About us</h1><a href="/">Home</a>`,
    "/contact": `<h1>Contact</h1><a href="/">Home</a>`,
    "/faq": `<h1>Questions</h1><a href="/">Home</a>`,
};

// ── the scripted model ────────────────────────────────────────────────────────
const IDEAS = [
    { title: "Browse the product list", startPath: "/products", heading: "Products" },
    { title: "Read the about page", startPath: "/about", heading: "About us" },
    { title: "Open the contact page", startPath: "/contact", heading: "Contact" },
] as const;
const prompts = { analysis: 0, plan: 0 };
/** Each authoring agent's model calls, by the scenario it writes. */
const authored: string[] = [];
/** Hold the model at a point: "analysis", "plan" or an idea's heading (its authoring). Released by `release()`. */
let holdAt: string | null = null;
let held: (() => void) | null = null;
let holding = false;
const waitIfHeld = async (at: string) => {
    if (holdAt !== at) return;
    holdAt = null;
    holding = true;
    await new Promise<void>((r) => (held = r));
    holding = false;
};
const release = () => {
    held?.();
    held = null;
};

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const textOf = (prompt: unknown) => JSON.stringify(prompt);
const model = new MockLanguageModelV3({
    doGenerate: async (o) => {
        const all = textOf(o.prompt);
        const idea = IDEAS.find((i) => all.includes(i.title));
        // First call of an agent (one user message): which scenario, and maybe hold there.
        const firstCall = (o.prompt as Array<{ role: string }>).filter((m) => m.role === "assistant").length === 0;
        if (idea && firstCall) {
            authored.push(idea.title);
            await waitIfHeld(idea.heading);
        }
        if (firstCall && idea) {
            return { content: [{ type: "tool-call" as const, toolCallId: `c${Math.random()}`, toolName: "assert", input: JSON.stringify({ check: "visible", target: { by: "role", role: "heading", value: idea.heading } }) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
        }
        return { content: [{ type: "tool-call" as const, toolCallId: `c${Math.random()}`, toolName: "finish", input: JSON.stringify({ result: "complete", explanation: "checked" }) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
    },
});

const scripted: LlmClient = {
    modelName: "scripted",
    model,
    usage: { inputTokens: 0, outputTokens: 0 },
    text: async () => "",
    object: (async ({ system, prompt }: { system: string; prompt: string }) => {
        if (prompt.includes("Already covered by the plan")) return { scenarios: [] };
        if (/list what they state about its intended behaviour/.test(system)) return { rules: [], workflows: [], roles: [], transitions: [], entities: [] };
        if (/analysing a web application/.test(system)) {
            prompts.analysis++;
            await waitIfHeld("analysis");
            return {
                siteType: "ecommerce",
                purpose: "A small shop",
                features: ["Browse products"],
                pagePurposes: [],
                journeys: [{ name: "Browse products", description: "Look at products", steps: ["Open products"], priority: "high", pages: ["/", "/products"], requiresAuth: false }],
                authenticationMechanisms: [],
            };
        }
        prompts.plan++;
        await waitIfHeld("plan");
        return { scenarios: IDEAS.map((s) => ScenarioSchema.omit({ scenarioId: true }).parse({ title: s.title, description: s.title, category: "Browsing", priority: "high", journey: "Browse products", startPath: s.startPath, expectedResults: [`${s.heading} is shown`] })) };
    }) as LlmClient["object"],
};

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = http.createServer((req, res) => {
        const p = new URL(req.url ?? "/", "http://x").pathname;
        const body = PAGES[p];
        pageHits.push(p);
        setTimeout(() => {
            if (!body) return void res.writeHead(404, { "content-type": "text/plain" }).end("not found");
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="en"><head><title>Shop</title></head><body><main>${body}</main></body></html>`);
        }, PAGES[p] ? pageDelay : 0);
    });
    await new Promise<void>((r) => site.listen(PORT, "127.0.0.1", () => r()));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-explore-resume-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", CONCURRENCY: "1", MAX_REPAIR_ATTEMPTS: "0", SECRET_KEY: "test-secret-key-0123456789" }));
    svc = getScheduleServices(platform);
    server = await buildServer(platform);
    worker = new Worker({ ...platform, makeLlm: () => scripted, onJobFinished: svc.onJobFinished }, 100);
    worker.start();
}, 60_000);

afterAll(async () => {
    release();
    await svc?.scheduler.stop();
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    site?.close();
    fs.rmSync(dir, { recursive: true, force: true });
}, 180_000);

const call = async (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body.startsWith("{") || res.body.startsWith("[") ? JSON.parse(res.body) : res.body };
};
const until = async (what: string, check: () => boolean | Promise<boolean>, ms = 60_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timed out waiting for ${what}`);
};
const DONE = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];
const finished = async (jobId: string) => {
    let j: any;
    await until("the job to finish", async () => DONE.includes((j = (await call("GET", `/api/test-generation/${jobId}`)).body).status), 420_000);
    return j;
};
const events = async (jobId: string) => (await call("GET", `/api/test-generation/${jobId}/events`)).body as Array<{ kind: string; level: string; message: string; data?: any }>;
const testsOf = async (projectId: string) => (await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; testId: string; title: string; validationStatus: string }>;
const START = { url: SITE, maxPages: 10, targets: ["web"], plan: true, useMemory: false };
const _dump = async (label: string, jobId: string, projectId: string) => {
    const j = (await call("GET", `/api/test-generation/${jobId}`)).body;
    const ev = await events(jobId);
    const tests = await testsOf(projectId);
    console.log(`\n===== ${label}\n job: ${JSON.stringify({ status: j.status, error: j.error, progress: j.progress, counters: j.counters, cancelled: j.cancelled })}\n events: ${ev.map((e) => `${e.level[0]} ${e.kind}: ${e.message.slice(0, 140)}`).join("\n   ")}\n tests: ${tests.map((t) => `${t.testId} ${t.title} ${t.validationStatus}`).join("; ")}`);
    return { j, ev, tests };
};

const create = (projectId: string, planJob: string, body: unknown = {}) => call("POST", `/api/projects/${projectId}/plans/${planJob}/create`, body);
const cont = (projectId: string, jobId: string) => call("POST", `/api/projects/${projectId}/explorations/${jobId}/continue`);
const kinds = async (jobId: string) => (await events(jobId)).map((e) => e.kind);
async function planned(name: string): Promise<{ projectId: string; planJob: string }> {
    const projectId = (await call("POST", "/api/projects", { name })).body.id as string;
    const s = await call("POST", `/api/projects/${projectId}/test-generation`, START);
    expect(s.status, JSON.stringify(s.body)).toBe(202);
    const j = await finished(s.body.jobId);
    expect(j.status, JSON.stringify(j)).toBe("COMPLETED");
    return { projectId, planJob: s.body.jobId };
}
/** Stop a job once `ready` holds, then let the held model go: the job ends cancelled. */
async function stopWhen(jobId: string, ready: () => boolean) {
    await until("the point to stop at", ready);
    expect((await call("DELETE", `/api/test-generation/${jobId}`)).status).toBe(202);
    await until("the stop to reach the job", () => Boolean(platform.repo.getJob(jobId)?.cancelRequested));
    // The worker's lease beat sees the stop within a few seconds; the held call is let go after it.
    await new Promise((r) => setTimeout(r, 4000));
    release();
    const j = await finished(jobId);
    expect(j).toMatchObject({ status: "FAILED", error: "Cancelled" });
    return j;
}

let uninterrupted: string[] = [];

describe("an exploration that is stopped, then continued", () => {
    it("an uninterrupted creation, to compare with", async () => {
        const { projectId, planJob } = await planned("Uninterrupted");
        const c = await create(projectId, planJob);
        expect(c.status, JSON.stringify(c.body)).toBe(202);
        const j = await finished(c.body.jobId);
        expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(j.status);
        uninterrupted = (await testsOf(projectId)).map((t) => t.title).sort();
        expect(uninterrupted).toEqual(expect.arrayContaining(IDEAS.map((i) => i.title)));
        expect(uninterrupted.length).toBeGreaterThan(IDEAS.length);
        // The tree's events: each idea is queued, started and written, with the test it made.
        const ev = await events(c.body.jobId);
        expect(ev.find((e) => e.kind === "scenarios_queued")?.data.scenarios.map((x: any) => x.title)).toEqual(IDEAS.map((i) => i.title));
        expect(ev.filter((e) => e.kind === "scenario_started").map((e) => e.data.scenarioId)).toEqual(["S-001", "S-002", "S-003"]);
        expect(ev.filter((e) => e.kind === "script_generated").every((e) => /^S-\d+$/.test(e.data.scenarioId) && /^WEB-\d+$/.test(e.data.testId))).toBe(true);
        // Nothing to continue: it was not stopped.
        const r = await cont(projectId, c.body.jobId);
        expect(r.status).toBe(409);
        expect(r.body.error).toMatch(/Only a stopped exploration can be continued/);
        expect((await call("GET", `/api/test-generation/${c.body.jobId}`)).body.canContinue).toBeUndefined();
    }, 600_000);

    it("a creation stopped while writing makes nothing more; Continue makes only the rest, and nothing twice", async () => {
        const { projectId, planJob } = await planned("Creation stopped");
        authored.length = 0;
        holdAt = IDEAS[1].heading;
        const c = await create(projectId, planJob);
        expect(c.status).toBe(202);
        const stopped = await stopWhen(c.body.jobId, () => holding);
        const afterStop = await testsOf(projectId);
        // Only the first idea had been written: no check was made after the stop, and the ideas it came before are not called skipped.
        expect(afterStop.map((t) => t.title)).toEqual([IDEAS[0].title]);
        expect(afterStop[0]!.validationStatus).toBe("PENDING");
        expect(stopped.counters.scenariosSkipped).toBe(0);
        const ks = await kinds(c.body.jobId);
        expect(ks).not.toContain("scenario_failed");
        expect(ks).not.toContain("security_tests_generated");
        expect(stopped.canContinue).toBe(true);

        // Continue: the first idea is not written again, the rest are; its test is run now.
        authored.length = 0;
        const r = await cont(projectId, c.body.jobId);
        expect(r.status, JSON.stringify(r.body)).toBe(202);
        expect(r.body.from).toBe("tests");
        const j = await finished(r.body.jobId);
        expect(["COMPLETED", "PARTIALLY_COMPLETED"], JSON.stringify(j)).toContain(j.status);
        expect(j.continues).toBe(c.body.jobId);
        expect([...new Set(authored)]).toEqual([IDEAS[1].title, IDEAS[2].title]);
        const tests = await testsOf(projectId);
        // Exactly what an uninterrupted creation makes: every idea and every check once.
        expect(tests.map((t) => t.title).sort()).toEqual(uninterrupted);
        expect(new Set(tests.map((t) => t.title)).size).toBe(tests.length);
        expect(tests.every((t) => t.validationStatus !== "PENDING" && t.validationStatus !== "VALIDATING"), JSON.stringify(tests)).toBe(true);
        expect(j.counters.testsCarried).toBe(1);
        expect(j.counters.testsGenerated).toBe(tests.length - 1);
        expect(await kinds(r.body.jobId)).toContain("creation_resumed");
        // The continuing run lists the kept test it ran with its own.
        const view = (await call("GET", `/api/projects/${projectId}/runs/${r.body.jobId}`)).body;
        expect(view.tests.map((t: any) => t.title)).toContain(IDEAS[0].title);
        expect(view.counts.planned).toBe(tests.length);
        // A stopped job is continued once.
        const again = await cont(projectId, c.body.jobId);
        expect(again.status).toBe(409);
        expect(again.body.error).toMatch(/already continued/);
    }, 900_000);

    it("a creation stopped while running its tests: Continue makes no test twice and runs only the ones without a result", async () => {
        const { projectId, planJob } = await planned("Validation stopped");
        const c = await create(projectId, planJob);
        expect(c.status).toBe(202);
        await until("the tests to run", () => platform.repo.getJob(c.body.jobId)?.progress.validation === "running", 400_000);
        // Every page now answers slowly: the stop lands while tests are running.
        pageDelay = 2500;
        await new Promise((r) => setTimeout(r, 1500));
        expect((await call("DELETE", `/api/test-generation/${c.body.jobId}`)).status).toBe(202);
        const stopped = await finished(c.body.jobId);
        pageDelay = 0;
        expect(stopped).toMatchObject({ status: "FAILED", error: "Cancelled", canContinue: true });
        const before = await testsOf(projectId);
        expect(before.map((t) => t.title).sort()).toEqual(uninterrupted);
        const waiting = before.filter((t) => t.validationStatus === "PENDING");
        expect(waiting.length, JSON.stringify(before)).toBeGreaterThan(0);
        expect(before.some((t) => t.validationStatus === "VALIDATING")).toBe(false);

        authored.length = 0;
        const r = await cont(projectId, c.body.jobId);
        expect(r.status, JSON.stringify(r.body)).toBe(202);
        const j = await finished(r.body.jobId);
        expect(["COMPLETED", "PARTIALLY_COMPLETED"], JSON.stringify(j)).toContain(j.status);
        // Nothing was written or made again: the same tests, and the ones that had no result now have one.
        expect(authored).toEqual([]);
        const after = await testsOf(projectId);
        expect(after.map((t) => t.id).sort()).toEqual(before.map((t) => t.id).sort());
        expect(after.filter((t) => t.validationStatus === "PENDING")).toEqual([]);
        expect(j.counters.testsGenerated).toBe(0);
        expect(j.counters.testsCarried).toBe(waiting.length);
    }, 900_000);

    it("a plan-only exploration stopped while planning continues without crawling or reading the application again", async () => {
        const projectId = (await call("POST", "/api/projects", { name: "Plan stopped" })).body.id as string;
        holdAt = "plan";
        const s = await call("POST", `/api/projects/${projectId}/test-generation`, START);
        await stopWhen(s.body.jobId, () => holding);
        expect((await call("GET", `/api/projects/${projectId}/plans/${s.body.jobId}`)).status).toBe(409);
        // A stop is not a failed stage: no error is recorded for it.
        const stoppedEvents = await events(s.body.jobId);
        expect(stoppedEvents.filter((e) => e.level === "error").map((e) => e.message)).toEqual([]);
        const hits = pageHits.length;
        const read = prompts.analysis;
        const plans = prompts.plan;
        const r = await cont(projectId, s.body.jobId);
        expect(r.status, JSON.stringify(r.body)).toBe(202);
        expect(r.body.from).toBe("reading");
        const j = await finished(r.body.jobId);
        expect(j.status, JSON.stringify(j)).toBe("COMPLETED");
        expect(j.planOnly).toBe(true);
        // No page was loaded again and the application was not read again; planning ran once more (its unfinished answer was not kept).
        expect(pageHits.length).toBe(hits);
        expect(prompts.analysis).toBe(read);
        expect(prompts.plan).toBe(plans + 1);
        expect(await kinds(r.body.jobId)).toEqual(expect.arrayContaining(["exploration_resumed", "understanding_resumed", "plan_ready"]));
        const plan = (await call("GET", `/api/projects/${projectId}/plans/${r.body.jobId}`)).body;
        expect(plan.ideas.map((i: any) => i.title)).toEqual(IDEAS.map((i) => i.title));
        expect(plan.found.pages).toBe(Object.keys(PAGES).length);
    }, 600_000);

    it("a plan-only exploration stopped while crawling starts again from the beginning, and says why", async () => {
        const projectId = (await call("POST", "/api/projects", { name: "Crawl stopped" })).body.id as string;
        pageDelay = 1500;
        pageHits.length = 0;
        const s = await call("POST", `/api/projects/${projectId}/test-generation`, START);
        await until("two pages", () => pageHits.filter((p) => PAGES[p]).length >= 2);
        expect((await call("DELETE", `/api/test-generation/${s.body.jobId}`)).status).toBe(202);
        const stopped = await finished(s.body.jobId);
        pageDelay = 0;
        expect(stopped).toMatchObject({ status: "FAILED", error: "Cancelled", canContinue: true });
        const r = await cont(projectId, s.body.jobId);
        expect(r.status).toBe(202);
        expect(r.body.from).toBe("start");
        const j = await finished(r.body.jobId);
        expect(j.status).toBe("COMPLETED");
        expect(await kinds(r.body.jobId)).toEqual(expect.arrayContaining(["resume_from_start", "application_discovered", "plan_ready"]));
    }, 600_000);
});
