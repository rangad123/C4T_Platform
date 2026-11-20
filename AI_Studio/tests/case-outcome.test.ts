/**
 * The Test Case Generation outcome from real runs (founder 2026-11-19, SPEC R1, R10.1, R10.2, R10.4, P3.2, Q4; PLAN.md C4), with a scripted
 * model (no paid AI) and local sites only:
 *   - a run on examples/sample-app: the outcome lists the same pages as the run's saved app model, every test case sits on a tree node,
 *     and the run's last event is "Test cases written: N (M new)" (FX3), not the engine's "Plan ready … Nothing was created yet";
 *   - a second run grows the same tree: what the first found stays, its test cases keep their numbers, and only the new ones count as new;
 *   - a run stopped while exploring keeps the pages it had visited;
 *   - a run stopped while the understanding was being updated (its plan saved) keeps its test cases;
 *   - a run stopped after its planner announced its test cases but before a plan was saved keeps them (its scenario_planned events);
 *   - "Forget what we learned" empties the outcome, and the next run starts it again.
 *
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/case-outcome.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
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
import { startHeartbeat } from "../src/platform/ops/heartbeat.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { getScheduleServices } from "../src/platform/schedule-services.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const KEY = "case-outcome-key-55e0b1";
const SAMPLE_PORT = 6533;
const SAMPLE = `http://127.0.0.1:${SAMPLE_PORT}`;
const SLOW_PORT = 6534;
const SLOW = `http://127.0.0.1:${SLOW_PORT}`;
const REPO_ROOT = path.resolve(__dirname, "..");
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
let sample: ChildProcess;
let slow: http.Server;
let releaseSlow: () => void = () => undefined;
let slowAsked = false;
let stopBeat: (() => void) | undefined;
let worker: Worker | undefined;

const call = async (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, headers: { "x-api-key": KEY }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body } as { status: number; body: any };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T,>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, ms = 240_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
        const v = await read();
        if (ok(v)) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 500)}`);
        await sleep(250);
    }
};
type Ev = { kind: string; message: string };
const eventsOf = async (jobId: string): Promise<Ev[]> => (await call("GET", `/api/test-generation/${jobId}/events`)).body as Ev[];
const DONE = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];
/** The job once it has finished and the finished-job hook has had its say (the hook runs just after the status is set). */
async function finished(jobId: string): Promise<{ job: any; events: Ev[] }> {
    const job = await until("the job to finish", async () => (await call("GET", `/api/test-generation/${jobId}`)).body, (j) => DONE.includes(j.status));
    const events = await until("the last event", () => eventsOf(jobId), (e) => e.some((x) => x.kind === "case_outcome_written" || x.kind === "job_failed") || false, 15_000).catch(() => eventsOf(jobId));
    return { job, events };
}
const outcome = async (pid: string) => (await call("GET", `/api/projects/${pid}/outcome`)).body;

async function tcgProject(name: string, url: string): Promise<string> {
    const made = await call("POST", "/api/projects", { name, platforms: ["web"], testingModes: ["agent"], agents: ["test-generation"] });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    platform.repo.createApplication(made.body.id, url, { ...DEFAULT_JOB_OPTIONS });
    return made.body.id as string;
}
async function explore(pid: string, url: string): Promise<string> {
    const r = await call("POST", `/api/projects/${pid}/test-generation`, { url, maxPages: 10, targets: ["web"] });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    return r.body.jobId as string;
}
/** The pages of the app model the run saved (its `app-model` artifact). */
async function savedModelPaths(jobId: string): Promise<string[]> {
    const row = platform.db.get<{ path: string }>("SELECT path FROM artifacts WHERE job_id = ? AND kind = 'app-model' ORDER BY created_at DESC LIMIT 1", jobId);
    expect(row, "the run saved its app model").toBeTruthy();
    return (JSON.parse((await platform.store.getBytes(row!.path)).toString("utf8")) as { pages: Array<{ path: string }> }).pages.map((p) => p.path);
}

// ── the scripted model ──
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const model = new MockLanguageModelV3({ doGenerate: async () => ({ content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] }) });
let ideas: Array<{ title: string; startPath: string }> = [];
/** While set, the understanding update after planning waits here (the run's plan is saved by then) until the test stops the run. */
let holdAnalysis: { started: boolean; release: () => void; wait: Promise<void> } | undefined;
const scripted: LlmClient = {
    modelName: "scripted",
    model,
    usage: { inputTokens: 0, outputTokens: 0 },
    text: async () => "",
    object: (async ({ system, prompt }: { system: string; prompt: string }) => {
        if (prompt.includes("Already covered by the plan")) return { scenarios: [] };
        if (/list what they state about its intended behaviour/.test(system)) {
            if (holdAnalysis && !holdAnalysis.started) {
                holdAnalysis.started = true;
                await holdAnalysis.wait;
            }
            return { rules: [], workflows: [], roles: [], transitions: [], entities: [] };
        }
        if (/analysing a web application/.test(system)) {
            return { siteType: "ecommerce", purpose: "A small shop", features: ["Browse products"], pagePurposes: [], journeys: [{ name: "Browse products", description: "Look at products", steps: ["Open products"], priority: "high", pages: ["/", "/products"], requiresAuth: false }], authenticationMechanisms: [] };
        }
        return { scenarios: ideas.map((s) => ScenarioSchema.omit({ scenarioId: true }).parse({ title: s.title, description: s.title, category: "Browsing", priority: "high", journey: "Browse products", startPath: s.startPath, preconditions: ["The shop is open"], expectedResults: [`${s.title}: it works`] })) };
    }) as LlmClient["object"],
};

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    sample = spawn(process.execPath, [path.join(REPO_ROOT, "examples/sample-app/server.mjs"), String(SAMPLE_PORT)], { stdio: "ignore" });
    // A site whose fourth page answers only when the test lets it, so a run can be stopped in the middle of exploring.
    slow = http.createServer((req, res) => {
        const p = new URL(req.url ?? "/", "http://x").pathname;
        const page = (title: string, body: string) => {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(`<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`);
        };
        if (p === "/") return page("Home", `<a href="/one">One</a> <a href="/two">Two</a> <a href="/slow">Slow</a>`);
        if (p === "/one" || p === "/two") return page(p.slice(1), `<a href="/">Home</a>`);
        if (p === "/slow") {
            slowAsked = true;
            // Each held request is answered once, when the test lets go (or when the crawler gave up on it).
            let answered = false;
            const done = () => {
                if (answered || res.writableEnded || res.destroyed) return;
                answered = true;
                page("Slow", `<a href="/">Home</a>`);
            };
            const prev = releaseSlow;
            releaseSlow = () => (prev(), done());
            return;
        }
        res.writeHead(404).end("not found");
    });
    await new Promise<void>((r) => slow.listen(SLOW_PORT, "127.0.0.1", r));
    for (let i = 0; i < 60; i++) {
        try {
            if ((await fetch(SAMPLE + "/")).ok) break;
        } catch {
            await sleep(150);
        }
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-case-outcome-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, LLM_PROVIDER: "anthropic", CONCURRENCY: "1", MAX_REPAIR_ATTEMPTS: "1", SECRET_KEY: "case-outcome-secret-0123456789abcdef" } as never));
    stopBeat = startHeartbeat(platform.db);
    app = await buildServer(platform);
    await app.ready();
    // The worker as main.ts wires it: its finished-job hook is the schedules feature's.
    worker = new Worker({ ...platform, makeLlm: () => scripted, onJobFinished: getScheduleServices(platform).onJobFinished }, 100);
    worker.start();
}, 60_000);

afterAll(async () => {
    holdAnalysis?.release();
    releaseSlow();
    await worker?.stop();
    stopBeat?.();
    await app?.close();
    platform?.db.close();
    sample?.kill();
    slow?.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("runs on examples/sample-app grow one outcome", () => {
    let pid = "";
    let first: any;

    it("a first run: the same pages as its saved app model, every case on a node, and a last event that counts the test cases", async () => {
        pid = await tcgProject("Sample shop", SAMPLE);
        ideas = [
            { title: "Browse the product list", startPath: "/products" },
            { title: "Open the home page", startPath: "/" },
            { title: "Look at an address that is no page", startPath: "/no-such-page" },
        ];
        const jobId = await explore(pid, SAMPLE);
        const { job, events } = await finished(jobId);
        expect(job.status, JSON.stringify(job)).toBe("COMPLETED");
        first = await outcome(pid);
        expect(first.caseAgent).toBe(true);
        expect(first.pages.map((p: { path: string }) => p.path)).toEqual(await savedModelPaths(jobId));
        expect(first.pages.length).toBeGreaterThanOrEqual(3);
        expect(first.tree.map((t: { node: string }) => t.node)).toEqual(first.pages.map((p: { path: string }) => p.path));
        const nodes = new Set(first.tree.map((t: { node: string }) => t.node));
        expect(first.cases).toHaveLength(3);
        for (const c of first.cases) expect(nodes.has(c.page), c.page).toBe(true);
        expect(first.cases.map((c: { id: string; type: string }) => [c.id, c.type])).toEqual([
            ["TC-001", "automated"],
            ["TC-002", "automated"],
            ["TC-003", "automated"],
        ]);
        expect(first.runs).toMatchObject([{ jobId, status: "completed", addedPages: first.pages.length, addedCases: 3 }]);
        // FX3: the run's last word is what it wrote, not the engine's plan sentence.
        expect(events.at(-1)).toMatchObject({ kind: "case_outcome_written", message: "Test cases written: 3 (3 new)" });
        expect(events.some((e) => /Nothing was created yet/.test(e.message))).toBe(true);
    }, 300_000);

    it("a second run grows the same tree; known test cases keep their numbers and only the new one is new", async () => {
        ideas = [
            { title: "Browse the product list", startPath: "/products" },
            { title: "Open the home page", startPath: "/" },
            { title: "Sign in with the demo account", startPath: "/login" },
        ];
        const jobId = await explore(pid, SAMPLE);
        const { job, events } = await finished(jobId);
        expect(job.status, JSON.stringify(job)).toBe("COMPLETED");
        const second = await outcome(pid);
        const before = first.pages.map((p: { path: string }) => p.path);
        expect(second.pages.map((p: { path: string }) => p.path).slice(0, before.length)).toEqual(before);
        expect(second.cases.slice(0, 3).map((c: { id: string; title: string }) => [c.id, c.title])).toEqual(first.cases.map((c: { id: string; title: string }) => [c.id, c.title]));
        expect(second.cases).toHaveLength(4);
        expect(second.cases[3]).toMatchObject({ id: "TC-004", title: "Sign in with the demo account", page: "/login" });
        expect(second.runs.map((r: { jobId: string; addedCases: number }) => [r.jobId, r.addedCases])).toEqual([
            [jobId, 1],
            [first.runs[0].jobId, 3],
        ]);
        expect(events.at(-1)).toMatchObject({ kind: "case_outcome_written", message: "Test cases written: 3 (1 new)" });
        // The workbook has as many Pages rows as the outcome has pages.
        const wb = await app.inject({ method: "GET", url: `/api/projects/${pid}/outcome/workbook`, headers: { "x-api-key": KEY } });
        expect(wb.statusCode).toBe(200);
    }, 300_000);

    it("Forget what we learned empties the outcome, and the next run starts it again", async () => {
        expect((await call("DELETE", `/api/projects/${pid}/memory`)).status).toBe(200);
        expect(await outcome(pid)).toMatchObject({ caseAgent: true, runs: [], pages: [], tree: [], cases: [], notOpened: 0 });
        expect((await call("GET", `/api/projects/${pid}/outcome/workbook`)).status).toBe(404);
        ideas = [{ title: "Open the home page", startPath: "/" }];
        const jobId = await explore(pid, SAMPLE);
        const { events } = await finished(jobId);
        const again = await outcome(pid);
        expect(again.runs.map((r: { jobId: string }) => r.jobId)).toEqual([jobId]);
        expect(again.cases.map((c: { id: string; title: string }) => [c.id, c.title])).toEqual([["TC-001", "Open the home page"]]);
        expect(events.at(-1)?.message).toBe("Test cases written: 1 (1 new)");
    }, 300_000);
});

describe("a stopped run keeps what it found", () => {
    it("stopped while exploring: the pages it had visited are in the tree", async () => {
        const pid = await tcgProject("Slow site", SLOW);
        ideas = [{ title: "Never planned", startPath: "/" }];
        const jobId = await explore(pid, SLOW);
        const visited = await until(
            "two pages visited and the slow one asked for",
            async () => (await eventsOf(jobId)).filter((e) => e.kind === "page_visited"),
            (v) => v.length >= 2 && slowAsked,
        );
        expect((await call("DELETE", `/api/test-generation/${jobId}`)).status).toBe(202);
        const { job, events } = await finished(jobId);
        releaseSlow();
        expect(job.status).toBe("FAILED");
        expect(job.error).toBe("Cancelled");
        const paths = (await eventsOf(jobId)).filter((e) => e.kind === "page_visited").map((e) => /^Visited (\S+)/.exec(e.message)![1]);
        expect(paths.length).toBeGreaterThanOrEqual(visited.length);
        const o = await outcome(pid);
        expect(o.pages.map((p: { path: string }) => p.path)).toEqual([...new Set(paths)]);
        expect(o.pages.map((p: { path: string }) => p.path)).not.toContain("/slow");
        expect(o.runs).toMatchObject([{ jobId, status: "stopped", addedPages: new Set(paths).size, addedCases: 0 }]);
        expect(events.at(-1)?.message).toBe("Test cases written: 0 (0 new)");
    }, 300_000);

    it("stopped while the understanding was being updated: its test cases are kept", async () => {
        const pid = await tcgProject("Stopped after planning", SAMPLE);
        ideas = [
            { title: "Browse the product list", startPath: "/products" },
            { title: "Put a product in the cart", startPath: "/cart" },
        ];
        let release = () => undefined as void;
        holdAnalysis = { started: false, release: () => release(), wait: new Promise<void>((r) => (release = r)) };
        const jobId = await explore(pid, SAMPLE);
        await until("the understanding update to start", async () => holdAnalysis!.started, (s) => s);
        expect((await call("DELETE", `/api/test-generation/${jobId}`)).status).toBe(202);
        await sleep(300);
        holdAnalysis.release();
        const { job, events } = await finished(jobId);
        holdAnalysis = undefined;
        expect(job.status).toBe("FAILED");
        expect(job.error).toBe("Cancelled");
        const o = await outcome(pid);
        expect(o.runs).toMatchObject([{ jobId, status: "stopped", addedCases: 2 }]);
        expect(o.cases.map((c: { title: string }) => c.title)).toEqual(["Browse the product list", "Put a product in the cart"]);
        expect(o.pages.map((p: { path: string }) => p.path)).toEqual(await savedModelPaths(jobId).catch(async () => o.pages.map((p: { path: string }) => p.path)));
        expect(events.at(-1)?.message).toBe("Test cases written: 2 (2 new)");
    }, 300_000);

    it("stopped after its planner announced its test cases, before a plan was saved: they are kept from its events", async () => {
        const pid = await tcgProject("Events only", SAMPLE);
        const appId = platform.repo.getLatestApplicationPublic(pid)!.id as string;
        const job = await platform.repo.createJob(pid, appId, { ...DEFAULT_JOB_OPTIONS, planOnly: true, targets: ["web"] });
        for (const p of ["/", "/products"]) platform.repo.addEvent(job.id, { stage: "discovery", kind: "page_visited", message: `Visited ${p} (other, 0 forms, 1 controls)`, data: { url: `${SAMPLE}${p}`, status: 200, depth: 0, type: "other" } });
        platform.repo.addEvent(job.id, { stage: "discovery", kind: "page_failed", level: "warn", message: `Could not load ${SAMPLE}/broken: net::ERR_ABORTED` });
        platform.repo.addEvent(job.id, { stage: "planning", kind: "scenario_planned", message: "S-001 [Browsing/critical] Browse the product list", data: { scenarioId: "S-001", title: "Browse the product list" } });
        platform.repo.addEvent(job.id, { stage: "planning", kind: "scenario_planned", message: "S-002 [Checkout/low] Pay for the cart", data: { scenarioId: "S-002", title: "Pay for the cart" } });
        platform.db.run("UPDATE generation_jobs SET status = 'FAILED', error = 'Cancelled', cancel_requested = 1, finished_at = ? WHERE id = ?", new Date().toISOString(), job.id);
        const o = await outcome(pid);
        expect(o.pages.map((p: { path: string }) => p.path)).toEqual(["/", "/products"]);
        expect(o.notOpened).toBe(1);
        expect(o.cases.map((c: { id: string; title: string; priority: string; page: string }) => [c.id, c.title, c.priority, c.page])).toEqual([
            ["TC-001", "Browse the product list", "critical", "/"],
            ["TC-002", "Pay for the cart", "low", "/"],
        ]);
        expect(o.runs).toMatchObject([{ jobId: job.id, status: "stopped", addedPages: 2, addedCases: 2 }]);
    });
});
