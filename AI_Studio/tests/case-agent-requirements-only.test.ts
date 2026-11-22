/**
 * A Test Case Generation run from a requirements document alone (founder 2026-11-19 R16, owner decision Q7; PLAN.md C8), with a
 * scripted model (no paid AI, no browser):
 *   - R16.1: a TCG project with active requirements and no address starts a run; it writes test cases from the requirements with the
 *     requirements generator (Automated without steps, Manual with steps); the outcome has them with Page empty, the tree has one node
 *     per requirement area, and the workbook's Page column is empty while its Tree sheet names the areas;
 *   - R16.2: no address and no active requirements: refused with "Add the application's address or a requirements document first.",
 *     and no job is made; another kind of project keeps its own refusal.
 * FX25: a scheduled or runbook Explore again on such a project runs the same way (case-agent.ts requirementsOnlyRun).
 * Also (F3 review L1, L5): the stop question promises only what a stopped run keeps, and a TCG project's setup checklist has no test or
 * run line.
 *
 *   node scripts/with-lock.mjs tsc -- npx vitest run tests/case-agent-requirements-only.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { readSheet } from "../src/engine/manual/xlsx-read.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { NO_ADDRESS_OR_REQUIREMENTS } from "../src/platform/case-agent.js";
import { mergeCaseRuns } from "../src/platform/case-outcome.js";
import { projectSetupOf, setupItems } from "../src/platform/project-setup.js";
import { CASE_STOP_QUESTION } from "../web/src/features/runs/run-text.js";
import { startHeartbeat } from "../src/platform/ops/heartbeat.js";
import { getScheduleServices } from "../src/platform/schedule-services.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const KEY = "case-agent-requirements-only-key-3f1a";
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
async function project(name: string, agents: string[]): Promise<string> {
    const made = await call("POST", "/api/projects", { name, platforms: ["web"], testingModes: ["agent"], agents });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    return made.body.id as string;
}

// The scripted model answers the requirements generator: per requirement, one Automated case (with steps it must drop) and one Manual case.
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const model = new MockLanguageModelV3({ doGenerate: async () => ({ content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] }) });
const scripted: LlmClient = {
    modelName: "scripted",
    model,
    usage: { inputTokens: 0, outputTokens: 0 },
    text: async () => "",
    object: (async ({ prompt }: { prompt: string }) => {
        const refs = [...prompt.matchAll(/^Reference: (\S+)$/gm)].map((m) => m[1]);
        return {
            cases: refs.flatMap((ref) => [
                { requirement: ref, title: `Verify ${ref} works`, priority: "high", type: "automated", steps: [{ action: "Should be dropped", expected: "-" }] },
                { requirement: ref, title: `Check ${ref} by hand`, priority: "low", type: "manual", steps: [{ action: `Open ${ref}`, expected: "It opens" }] },
            ]),
        };
    }) as LlmClient["object"],
};

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-case-req-only-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, LLM_PROVIDER: "anthropic", CONCURRENCY: "1", SECRET_KEY: "case-agent-requirements-only-secret-0123456789" } as never));
    stopBeat = startHeartbeat(platform.db);
    app = await buildServer(platform);
    await app.ready();
    worker = new Worker({ ...platform, makeLlm: () => scripted, onJobFinished: getScheduleServices(platform).onJobFinished }, 100);
    worker.start();
}, 60_000);

afterAll(async () => {
    await worker?.stop();
    stopBeat?.();
    await app?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("R16.2: neither an address nor a requirements document", () => {
    it("a Test Case Generation project is refused with the sentence, and no job is made", async () => {
        const pid = await project("Nothing to read", ["test-generation"]);
        // A retired or draft requirement is not one the run reads.
        expect((await call("POST", `/api/projects/${pid}/requirements`, { title: "An old rule", status: "retired" })).status).toBe(201);
        const r = await call("POST", `/api/projects/${pid}/test-generation`, { plan: true });
        expect(r.status, JSON.stringify(r.body)).toBe(400);
        expect(r.body.error).toBe("Add the application's address or a requirements document first.");
        expect(NO_ADDRESS_OR_REQUIREMENTS).toBe("Add the application's address or a requirements document first.");
        expect(platform.repo.listJobs(pid)).toEqual([]);
    });

    it("another kind of project keeps its own refusal", async () => {
        const pid = await project("Accessibility only", ["accessibility"]);
        expect((await call("POST", `/api/projects/${pid}/requirements`, { title: "Sign in works" })).status).toBe(201);
        const r = await call("POST", `/api/projects/${pid}/test-generation`, { plan: true });
        expect(r.status).toBe(400);
        expect(r.body.error).toBe("Give the address of the website or API to test");
        expect(platform.repo.listJobs(pid)).toEqual([]);
    });
});

describe("R16.1: a run from the requirements alone", () => {
    it("writes the test cases from the active requirements; Page is empty and the tree has the requirement areas", async () => {
        const pid = await project("Requirements only", ["test-generation"]);
        for (const title of ["Sign in", "Search the products", "Pay for an order"]) expect((await call("POST", `/api/projects/${pid}/requirements`, { title, description: `${title} as a shopper` })).status).toBe(201);
        expect((await call("POST", `/api/projects/${pid}/requirements`, { title: "Not yet agreed", status: "draft" })).status).toBe(201);

        const r = await call("POST", `/api/projects/${pid}/test-generation`, { plan: true });
        expect(r.status, JSON.stringify(r.body)).toBe(202);
        let job: any;
        for (let i = 0; i < 200; i++) {
            job = (await call("GET", `/api/test-generation/${r.body.jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) break;
            await sleep(100);
        }
        expect(job.status, JSON.stringify(job)).toBe("COMPLETED");
        let events: Array<{ kind: string; message: string }> = [];
        for (let i = 0; i < 100 && !events.some((e) => e.kind === "case_outcome_written"); i++, await sleep(100)) events = (await call("GET", `/api/test-generation/${r.body.jobId}/events`)).body;
        expect(events.at(-1)).toMatchObject({ kind: "case_outcome_written", message: "Test cases written: 6 (6 new)" });

        const o = (await call("GET", `/api/projects/${pid}/outcome`)).body;
        expect(o.caseAgent).toBe(true);
        expect(o.pages).toEqual([]);
        expect(o.cases).toHaveLength(6);
        expect(o.cases.every((c: { page: string }) => c.page === "")).toBe(true);
        const auto = o.cases.find((c: { title: string }) => c.title === "Verify REQ-1 works");
        expect(auto).toMatchObject({ type: "automated", priority: "high", steps: [], requirement: "REQ-1" });
        expect(o.cases.find((c: { title: string }) => c.title === "Check REQ-2 by hand")).toMatchObject({ type: "manual", priority: "low", steps: [{ action: "Open REQ-2", expected: "It opens" }], requirement: "REQ-2" });
        expect(o.tree).toEqual([
            { node: "REQ-1 Sign in", parent: null, page: "", title: "REQ-1 Sign in", cases: 2 },
            { node: "REQ-2 Search the products", parent: null, page: "", title: "REQ-2 Search the products", cases: 2 },
            { node: "REQ-3 Pay for an order", parent: null, page: "", title: "REQ-3 Pay for an order", cases: 2 },
        ]);

        // The workbook: Page column empty, the Tree sheet names the areas, no Pages rows.
        const wb = await call("GET", `/api/projects/${pid}/outcome/workbook`);
        expect(wb.status).toBe(200);
        const cases = readSheet(wb.raw, "Test cases");
        const pageCol = cases[0]!.indexOf("Page");
        expect(cases.slice(1)).toHaveLength(6);
        expect(cases.slice(1).every((row) => (row[pageCol] ?? "") === "")).toBe(true);
        expect(readSheet(wb.raw, "Tree").slice(1).map((row) => row[0])).toEqual(["REQ-1 Sign in", "REQ-2 Search the products", "REQ-3 Pay for an order"]);
        expect(readSheet(wb.raw, "Pages").slice(1)).toEqual([]);

        // F3 round 2 M5: the areas are not pages. The Projects row's counts and the run page agree with the workbook: 0 pages.
        expect((await call("GET", `/api/projects/${pid}/outcome?counts=1`)).body.counts).toEqual({ cases: 6, pages: 0, areas: 3 });
        const one = (await call("GET", `/api/projects/${pid}/outcome?run=${r.body.jobId}`)).body;
        expect(one.pages).toEqual([]);
        expect(one.runs[0]).toMatchObject({ addedPages: 0, addedCases: 6 });
        // The run page groups its cases on the same areas as the Dashboard (none is left "not tied to a page").
        expect(one.tree).toEqual(o.tree);
        // L9: with the cases written from the requirements, the address item of the setup checklist is done.
        const check = (await call("GET", `/api/projects/${pid}/setup-check`)).body;
        expect(check.items.find((i: { key: string }) => i.key === "web-address")).toEqual({ key: "web-address", ok: true, text: "The test cases are written from the requirements." });

        // Nothing is made or run: no test scripts, no saved written cases, no other job.
        expect(platform.repo.listTests(pid)).toEqual([]);
        expect(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM manual_cases WHERE project_id = ?", pid)!.n).toBe(0);
        expect(platform.repo.listJobs(pid)).toHaveLength(1);
    }, 60_000);
});

describe("wording in a Test Case Generation project (F3 review L1, L5)", () => {
    it("the stop question keeps its promise: pages so far, test cases once written", () => {
        expect(CASE_STOP_QUESTION.body).toBe("Pages found so far are kept. Test cases are kept once they have been written. You can explore again at any time, and the next run adds to it.");
    });

    it("the setup checklist says nothing about tests or runs", () => {
        const facts = { setup: projectSetupOf({}), hasWebAddress: true, hasAndroidApp: false, hasIosApp: false, canRunIos: false, aiConfigured: true, runner: { runOn: "platform" as const }, runsHere: true, caseAgent: true };
        expect(setupItems(facts).map((i) => i.text)).toEqual(["The application has an address to explore.", "Your AI key is set up."]);
        expect(setupItems({ ...facts, hasWebAddress: false })[0]!.text).toBe("Add the application's address, or write the test cases from the requirements.");
        // L9: active requirements are the other input, so the item is done.
        expect(setupItems({ ...facts, hasWebAddress: false, hasRequirements: true })[0]).toEqual({ key: "web-address", ok: true, text: "The test cases are written from the requirements." });
        expect(setupItems({ ...facts, hasRequirements: true })[0]!.text).toBe("The application has an address to explore.");
        // Another kind of project still needs its address.
        expect(setupItems({ ...facts, caseAgent: false, hasWebAddress: false, hasRequirements: true })[0]!.ok).toBe(false);
        // Other projects keep theirs.
        expect(setupItems({ ...facts, caseAgent: false }).map((i) => i.text)).toEqual(["Web tests have an address to test.", "Your AI key is set up.", "Tests run on this server."]);
    });
});

describe("merging a requirements-only run with an exploration", () => {
    it("its cases keep an empty page even when the tree has pages, and the areas follow the pages", () => {
        const base = { type: "automated" as const, priority: "medium" as const, preconditions: [], steps: [], expected: [], requirement: "" };
        const m = mergeCaseRuns([
            { run: { jobId: "a", startedAt: "1", status: "completed" }, part: { pages: [{ path: "/", url: "http://x/", title: "Home", purpose: "" }], edges: [], cases: [{ ...base, title: "Open home", page: "/" }], failed: [] } },
            { run: { jobId: "b", startedAt: "2", status: "completed" }, part: { pages: [], edges: [], cases: [{ ...base, title: "Sign in", page: "", area: "REQ-1 Sign in", requirement: "REQ-1" }, { ...base, title: "Sign in", page: "", area: "REQ-2 Sign out" }], failed: [] } },
        ]);
        expect(m.cases.map((c) => [c.id, c.title, c.page])).toEqual([["TC-001", "Open home", "/"], ["TC-002", "Sign in", ""], ["TC-003", "Sign in", ""]]);
        expect(m.cases.map((c) => c.area)).toEqual([undefined, "REQ-1 Sign in", "REQ-2 Sign out"]);
        expect(m.tree.map((t) => [t.node, t.page, t.cases])).toEqual([["/", "/", 1], ["REQ-1 Sign in", "", 1], ["REQ-2 Sign out", "", 1]]);
    });
});

describe("FX25: a scheduled or runbook Explore again with no address runs from the requirements, as the explore route does", () => {
    async function fromRequirements(name: string): Promise<string> {
        const pid = await project(name, ["test-generation"]);
        expect((await call("POST", `/api/projects/${pid}/requirements`, { title: "Sign in", description: "Sign in as a shopper" })).status).toBe(201);
        platform.repo.createApplication(pid, "", {});
        return pid;
    }
    async function finished(jobId: string): Promise<string> {
        for (let i = 0; i < 200; i++) {
            const s = platform.repo.getJob(jobId)!.status;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED", "CANCELLED"].includes(s)) return s;
            await sleep(100);
        }
        return "still running";
    }

    it("a schedule", async () => {
        const pid = await fromRequirements("Scheduled from requirements");
        const made = await call("POST", `/api/projects/${pid}/schedules`, { kind: "generate", cadence: { type: "daily", time: "03:00" }, enabled: false });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        const r = await call("POST", `/api/projects/${pid}/schedules/${made.body.id}/run`);
        expect(r.status, JSON.stringify(r.body)).toBe(202);
        expect(platform.repo.getJob(r.body.jobId)!.options).toMatchObject({ mode: "generate", planOnly: true, requirementsOnly: true, trigger: "schedule" });
        // A schedule made with the API key has no person's AI key behind it, so the job stops there (an older rule), never on the address.
        expect(await finished(r.body.jobId)).toBe("FAILED");
        expect(platform.repo.getJob(r.body.jobId)!.error).toMatch(/^AI is not available for this work/);
    }, 60_000);

    it("a runbook's analyze step", async () => {
        const pid = await fromRequirements("Runbook from requirements");
        const book = await call("POST", `/api/projects/${pid}/runbooks`, { version: 1, name: "Explore again", steps: [{ id: "a", type: "analyze" }] });
        expect(book.status, JSON.stringify(book.body)).toBe(201);
        const started = await call("POST", `/api/projects/${pid}/runbooks/${book.body.id}/run`);
        expect(started.status, JSON.stringify(started.body)).toBe(202);
        let run: any;
        for (let i = 0; i < 300 && !run?.finished; i++, await sleep(100)) run = (await call("GET", `/api/projects/${pid}/runbook-runs/${started.body.runId}`)).body;
        const jobId = run.steps[0].jobId as string;
        expect(jobId, JSON.stringify(run)).toBeTruthy();
        expect(platform.repo.getJob(jobId)!.options).toMatchObject({ mode: "generate", planOnly: true, requirementsOnly: true });
        expect(platform.repo.getJob(jobId)!.status).toBe("COMPLETED");
    }, 60_000);
});
