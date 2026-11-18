/**
 * Phase 3 (P3-24): exploring by objectives on the run page. In a real browser against a real platform: while a run explores on a
 * runner, the live view lists the objectives with their priority sentence and state (waiting, exploring, done, skipped with why) as the
 * run's events arrive, with Stop for a person who may run tests (the existing stop) and without it for one who may only look; a runner
 * too old to explore by objectives gets the platform's one sentence; on a finished run, the stop reason and the coverage record, with
 * each operator that did not run and why; an older run without a record says so; a refusal from the server is shown as its sentence.
 * Axe in light and dark, no sideways scroll at phone width. Also the pure rules.
 *
 * Stand-ins (browser routes, no runner and no worker here): the run's answer and events for a run on a runner, the project's
 * objectives and the run's coverage record (their shapes are the routes' of 1dc6674), the person's access to the project, and
 * GET /api/me/runner. The older run, its coverage answer and the "no analysed model" answer are the real platform's.
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs build,browser -- node node_modules/vite/bin/vite.js build web
 *   TAQWRIGHT_HOME=/nonexistent-taqwright node scripts/with-lock.mjs build,browser -- npx vitest run tests/explore-objectives-ui.test.ts
 * Ports: platform 9907. SHOTS_DIR=<dir> saves screenshots.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { objectivesNeedRunner } from "../src/platform/explore-task.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { WRITER_STOPPED as ENGINE_WRITER_STOPPED } from "../src/engine/web/author.js";
import { explorationNote, objectiveRows, pursuitOf, WRITER_STOPPED, type CoverageAnswer, type ObjectivePreview } from "../web/src/features/runs/objectives.js";

const PORT = 9907;
const BASE = `http://127.0.0.1:${PORT}`;
const JOB = "obj-job";
const SHOTS = process.env.SHOTS_DIR;

const A: ObjectivePreview = {
    id: "OBJ-aaaaaaaaaaaaaaaa",
    kind: "rule",
    source: "R-checkout-total",
    question: "Does the order total include the delivery fee?",
    expected: "The total is the items plus the delivery fee.",
    operators: ["as_stated", "invalid_input"],
    priority: 90,
    reason: "A stated rule about money, on the checkout page.",
};
const B: ObjectivePreview = {
    id: "OBJ-bbbbbbbbbbbbbbbb",
    kind: "workflow",
    source: "WF-checkout",
    question: "Can a signed-in shopper place an order?",
    expected: "The order is confirmed with a number.",
    operators: ["as_stated", "double_submit"],
    priority: 70,
    reason: "A stated workflow that changes data.",
};
const C: ObjectivePreview = {
    id: "OBJ-cccccccccccccccc",
    kind: "constraint",
    source: "checkout/form/email",
    question: "Is an email without @ refused?",
    expected: "The form says the email is not valid.",
    operators: ["invalid_input"],
    priority: 40,
    reason: "A required field with a stated format.",
};
// Listed out of order: the session pursues the highest priority first, and so does the list.
const OBJECTIVES = [C, A, B];

const at = new Date().toISOString();
const ev = (id: number, kind: string, message: string, stage = "generation") => ({ id, stage, kind, level: "info", message, createdAt: at });
const QUEUED = ev(10, "explore_queued", "Sent the exploration to your runner.", "orchestration");
const PLANNED = ev(20, "objectives_planned", "3 objective(s) to explore as 5 pursuit(s); 1 operator(s) not run.");
const A_ENDED = ev(30, "objective_not_written", `${A.id}-as_stated: no test was saved (the page did not load).`);
const B_SAVED = ev(40, "script_generated", "WEB-001 Submit twice: workflow WF-checkout (4 steps)");
const STOPPED = ev(50, "exploration_stopped", "Exploring by objectives stopped: The session was stopped by a person.");
const TOO_OLD = objectivesNeedRunner("Office laptop");
/** Row 173: a pursuit's start or end as the engine emits it (orchestrator.ts onPursuit): ids and the operator, and how it ended. */
const pursuit = (id: number, o: ObjectivePreview, operator: string, outcome?: string) => ({
    ...ev(id, outcome === undefined ? "objective_started" : "objective_finished", `${o.id} ${operator}: ${outcome === undefined ? "started" : `finished (${outcome})`}`),
    data: { objectiveId: o.id, operator, ...(outcome === undefined ? {} : { outcome }) },
});

const COVERAGE: CoverageAnswer = {
    available: true,
    stopReason: "cancelled",
    stopDetail: "The session was stopped by a person.",
    budgets: { objectives: 4, actions: 50, aiCalls: 60, tokens: 400_000, minutes: 20, depth: 3, steps: 30 },
    usage: { objectives: 2, actions: 17, aiCalls: 21, tokens: 90_000, minutes: 6.4 },
    coverage: {
        pages: { total: 5, exercised: 2, notExercised: ["/account", "/help", "/orders"], more: 0, unknown: [] },
        states: 4,
        elements: { total: 10, exercised: 3, notExercised: [], more: 0 },
        workflowSteps: { total: 4, exercised: 2, notExercised: [], more: 0 },
        transitions: { total: 0, exercised: 0, notExercised: [], more: 0 },
        inputClasses: { total: 3, exercised: 0, notExercised: [], more: 0 },
        rules: { total: 2, exercised: 1, notExercised: [], more: 0 },
        endpoints: { total: 6, exercised: 2, notExercised: [], more: 0 },
        uniqueScenarios: 3,
        unexplored: [{ objectiveId: C.id, kind: "constraint", source: C.source, priority: 40, reason: C.reason, status: "not run: The session stopped first: The session was stopped by a person." }],
        unexploredMore: 0,
        notRun: [{ objectiveId: B.id, operator: "double_submit", reason: "not run: data changes off" }],
        notRunMore: 0,
    },
    actionLog: Array.from({ length: 17 }, (_, i) => ({ seq: i })),
    actionLogOmitted: 0,
};

describe("the rules (no browser)", () => {
    const states = (events: Parameters<typeof objectiveRows>[1], active = true, coverage?: CoverageAnswer) => objectiveRows(OBJECTIVES, events, { active, ...(coverage ? { coverage } : {}) }).map((r) => [r.objective.id, r.state, r.why ?? ""]);
    it("waits until the objectives are planned, then follows the session, highest priority first", () => {
        expect(states([QUEUED])).toEqual([[A.id, "waiting", ""], [B.id, "waiting", ""], [C.id, "waiting", ""]]);
        expect(states([QUEUED, PLANNED])).toEqual([[A.id, "running", ""], [B.id, "waiting", ""], [C.id, "waiting", ""]]);
        expect(states([QUEUED, PLANNED, A_ENDED])).toEqual([[A.id, "running", ""], [B.id, "waiting", ""], [C.id, "waiting", ""]]);
        // A saved test names its objective by "kind source" in its title.
        expect(states([QUEUED, PLANNED, A_ENDED, B_SAVED])).toEqual([[A.id, "done", ""], [B.id, "running", ""], [C.id, "waiting", ""]]);
        expect(states([QUEUED, PLANNED, A_ENDED, B_SAVED, STOPPED])).toEqual([[A.id, "done", ""], [B.id, "done", ""], [C.id, "skipped", "Not reached: The session was stopped by a person."]]);
    });
    // Row 186: an objective whose every pursuit ended with the test writer stopping is "not finished" with that sentence, never "done".
    it("an objective whose test writer stopped before finishing is not finished, live and after the run", () => {
        expect(WRITER_STOPPED).toBe(ENGINE_WRITER_STOPPED);
        const stoppedA = (id: number, op: string) => ev(id, "objective_not_written", `${A.id}-${op}: no test was saved (${WRITER_STOPPED}).`);
        const live = states([QUEUED, PLANNED, stoppedA(30, "as_stated"), stoppedA(31, "invalid_input"), B_SAVED]);
        expect(live[0]).toEqual([A.id, "unfinished", WRITER_STOPPED]);
        expect(live[1]).toEqual([B.id, "running", ""]);
        // One pursuit stopped, the other ended otherwise: the objective was pursued.
        expect(states([QUEUED, PLANNED, stoppedA(30, "as_stated"), A_ENDED, B_SAVED])[0]).toEqual([A.id, "done", ""]);
        const cov: CoverageAnswer = { ...COVERAGE, coverage: { ...(COVERAGE as Extract<CoverageAnswer, { available: true }>).coverage, unexplored: [{ objectiveId: A.id, kind: "rule", source: A.source, priority: 90, reason: A.reason, status: `not finished: ${WRITER_STOPPED}` }] } };
        const after = objectiveRows(OBJECTIVES, [PLANNED], { active: false, coverage: cov });
        expect([after[0]!.state, after[0]!.why]).toEqual(["unfinished", `Not finished: ${WRITER_STOPPED}`]);
    });
    it("a test saved before the objectives were planned names none of them", () => {
        expect(states([ev(5, "script_generated", "WEB-001 Submit twice: workflow WF-checkout (4 steps)"), PLANNED])[1]).toEqual([B.id, "waiting", ""]);
    });
    it("after the run, the coverage record says what was skipped and which operators did not run, with why", () => {
        const rows = objectiveRows(OBJECTIVES, [PLANNED], { active: false, coverage: COVERAGE });
        expect(rows.map((r) => [r.objective.id, r.state])).toEqual([[A.id, "done"], [B.id, "done"], [C.id, "skipped"]]);
        expect(rows[2]!.why).toBe("Not run: The session stopped first: The session was stopped by a person.");
        expect(rows[1]!.notRun).toEqual([{ operator: "double_submit", reason: "Not run: data changes off" }]);
    });
    it("prefers the session's own start and end events over the estimate (row 173)", () => {
        const startA = pursuit(31, A, "as_stated");
        const endA = pursuit(32, A, "as_stated", "completed");
        const startA2 = pursuit(33, A, "invalid_input");
        const endA2 = pursuit(34, A, "invalid_input", "completed");
        const startC = pursuit(35, C, "invalid_input");
        expect(states([QUEUED, PLANNED, startA])).toEqual([[A.id, "running", ""], [B.id, "waiting", ""], [C.id, "waiting", ""]]);
        // Between two operators of one objective it is done; while the next one runs, running again.
        expect(states([QUEUED, PLANNED, startA, endA])[0]).toEqual([A.id, "done", ""]);
        expect(states([QUEUED, PLANNED, startA, endA, startA2])[0]).toEqual([A.id, "running", ""]);
        // C pursued before B: the estimate would call B done; the events say it still waits.
        const live = [QUEUED, PLANNED, startA, endA, startA2, endA2, startC];
        expect(states(live)).toEqual([[A.id, "done", ""], [B.id, "waiting", ""], [C.id, "running", ""]]);
        expect(states([...live, pursuit(36, C, "invalid_input", "environment_failure")])[2]).toEqual([C.id, "unfinished", "Not finished: the application or the browser failed."]);
        // The session stopped: never started is not reached, started and never ended is not finished.
        expect(states([...live, STOPPED])).toEqual([
            [A.id, "done", ""],
            [B.id, "skipped", "Not reached: The session was stopped by a person."],
            [C.id, "unfinished", "Not finished: The session was stopped by a person."],
        ]);
        // After the run, the coverage record still decides.
        expect(states([...live, STOPPED], false, COVERAGE).map((r) => r[1])).toEqual(["done", "done", "skipped"]);
    });
    it("reads only ids and the operator from a pursuit event; one without them is not a pursuit", () => {
        expect(pursuitOf({ ...pursuit(1, A, "as_stated", "completed"), data: { objectiveId: A.id, operator: "as_stated", outcome: "completed", page: "Welcome, Maya" } })).toEqual({ objectiveId: A.id, operator: "as_stated", outcome: "completed" });
        expect(pursuitOf({ ...pursuit(1, A, "as_stated"), data: { objectiveId: A.id } })).toBeNull();
        expect(pursuitOf({ ...pursuit(1, A, "as_stated"), data: undefined })).toBeNull();
        expect(pursuitOf({ ...A_ENDED, data: { objectiveId: A.id, operator: "as_stated" } })).toBeNull();
        // Without any, the estimate as before.
        expect(states([QUEUED, PLANNED, { ...pursuit(31, A, "as_stated"), data: undefined }, B_SAVED])).toEqual([[A.id, "done", ""], [B.id, "running", ""], [C.id, "waiting", ""]]);
    });
    it("an older runner or no model gets the platform's sentence instead of the list", () => {
        expect(explorationNote([QUEUED, ev(11, "objectives_need_runner", TOO_OLD, "orchestration")])).toEqual({ kind: "need_runner", text: TOO_OLD });
        expect(explorationNote([QUEUED, PLANNED])).toBeNull();
    });
});

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let browser: Browser;
let page: Page;
let projectId: string;
let olderRun: string;
const consoleErrors: string[] = [];
const stops: string[] = [];

const fake = {
    events: [] as Array<ReturnType<typeof ev> & { data?: unknown }>,
    active: true,
    /** The person's access to the project (null: as the platform answers). */
    access: null as null | { projectAdmin: boolean; permissions: string[] },
    /** The objectives answer (null: the real platform's). */
    objectives: { status: 200, json: { available: true, objectives: OBJECTIVES, overCap: 1 } as Record<string, unknown> } as null | { status: number; json: Record<string, unknown> },
    coverage: { available: false, message: "stand-in" } as CoverageAnswer,
};

const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text && /^[{[]/.test(text) ? JSON.parse(text) : text } as { status: number; body: any };
};

const runAnswer = () => {
    const job = {
        jobId: JOB,
        projectId,
        status: fake.active ? "GENERATING" : "COMPLETED",
        mode: "generate",
        targets: ["web"],
        ranOn: { kind: "agent", agentId: "tok-mine", name: "Office laptop" },
        progress: { discovery: "done", understanding: "done", planning: "done", generation: fake.active ? "running" : "done", validation: fake.active ? "pending" : "done" },
        counters: { pagesDiscovered: 5, apisDiscovered: 0, journeysIdentified: 0, scenariosPlanned: 3, testsGenerated: 1, testsValidated: 0, testsFailedValidation: 0, testsNeedingReview: 0, scenariosSkipped: 0 },
        error: null,
        cancelled: null,
        createdAt: at,
        startedAt: at,
        finishedAt: fake.active ? null : new Date().toISOString(),
    };
    return { job, jobId: JOB, projectId, mode: "generate", active: fake.active, counts: { planned: 1, ran: 0, passed: 0, failed: 0, findings: 0, notRun: 0 }, tests: [], heldBack: [], startedBy: { kind: "person", label: "Maya" }, changes: null };
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-explore-objectives-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "explore-objectives-ui-secret-0123456789", HOST: "127.0.0.1", PORT: String(PORT), WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    projectId = (await call("POST", "/api/projects", { name: "Objective shop", platforms: ["web"], testingModes: ["agent"] })).body.id;
    // An exploration from before coverage was recorded: a real job of this project, finished, without a record.
    const appId = platform.repo.createApplication(projectId, "https://shop.example.test", { ...DEFAULT_JOB_OPTIONS });
    olderRun = (await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "generate" })).id;
    platform.repo.setJobStatus(olderRun, "COMPLETED");

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));

    await page.route("**/api/me/runner", (route) => route.fulfill({ json: { runner: null } }));
    await page.route(`**/api/projects/${projectId}/runs/${JOB}`, (route) => route.fulfill({ json: runAnswer() }));
    await page.route(`**/api/test-generation/${JOB}/events?*`, (route) => {
        const after = Number(new URL(route.request().url()).searchParams.get("after") ?? 0);
        return route.fulfill({ json: fake.events.filter((e) => e.id > after) });
    });
    await page.route(`**/api/test-generation/${JOB}/stream*`, (route) => route.fulfill({ status: 404, json: { error: "Job not found" } }));
    await page.route(`**/api/test-generation/${JOB}`, (route) => {
        if (route.request().method() !== "DELETE") return route.continue();
        stops.push(JOB);
        return route.fulfill({ json: { ok: true } });
    });
    await page.route(`**/api/projects/${projectId}/objectives`, (route) => (fake.objectives ? route.fulfill({ status: fake.objectives.status, json: fake.objectives.json }) : route.continue()));
    await page.route(`**/api/projects/${projectId}/jobs/${JOB}/coverage`, (route) => route.fulfill({ json: fake.coverage }));
    await page.route(`**/api/projects/${projectId}`, async (route) => {
        if (route.request().method() !== "GET" || !fake.access) return route.continue();
        const res = await route.fetch();
        await route.fulfill({ response: res, json: { ...(await res.json()), access: fake.access } });
    });
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const visit = async (hash: string) => {
    await page.goto("about:blank");
    await page.goto(`${BASE}/${hash}`);
};
const openRun = () => visit(`#/projects/${projectId}/runs/${JOB}`);
const live = () => page.getByTestId("objectives-live");
const item = (o: ObjectivePreview) => live().getByTestId("objective").filter({ hasText: o.question });
const shot = async (name: string) => {
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
};
async function axeBoth() {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(300);
        const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
        expect(r.violations.map((v) => `${scheme}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
}
async function noSidewaysScroll() {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
}

describe("while the run explores", () => {
    it("lists the objectives with their priority sentence and state, following the run's events", async () => {
        fake.active = true;
        fake.events = [QUEUED];
        await openRun();
        await pwExpect(live().getByTestId("objective")).toHaveCount(3);
        // Highest priority first, each with why it has its priority, and all waiting until the objectives are planned.
        await pwExpect(live().getByTestId("objective").first()).toContainText(A.question);
        await pwExpect(item(A).getByTestId("objective-reason")).toHaveText(A.reason);
        await pwExpect(item(A)).toContainText(`Expected: ${A.expected}`);
        for (const o of [A, B, C]) await pwExpect(item(o)).toHaveAttribute("data-state", "waiting");
        await pwExpect(live()).toContainText("1 more objective left out: over this session’s limit.");

        fake.events = [QUEUED, PLANNED, A_ENDED];
        await pwExpect(item(A)).toHaveAttribute("data-state", "running", { timeout: 10_000 });
        await pwExpect(item(A)).toContainText("Exploring");
        fake.events = [QUEUED, PLANNED, A_ENDED, B_SAVED];
        await pwExpect(item(B)).toHaveAttribute("data-state", "running", { timeout: 10_000 });
        await pwExpect(item(A)).toHaveAttribute("data-state", "done");
        await pwExpect(item(A)).toContainText("Done");
        await pwExpect(item(C)).toHaveAttribute("data-state", "waiting");
        await shot("live-objectives");
        await axeBoth();
        await noSidewaysScroll();

        fake.events = [QUEUED, PLANNED, A_ENDED, B_SAVED, STOPPED];
        await pwExpect(item(C)).toHaveAttribute("data-state", "skipped", { timeout: 10_000 });
        await pwExpect(item(C).getByTestId("objective-why")).toHaveText("Not reached: The session was stopped by a person.");
    }, 120_000);

    it("follows the session's start and end events when the run sends them (row 173)", async () => {
        fake.active = true;
        // C is pursued before B: only the events' facts can say B still waits (C's start names C, which the estimate reads as B done).
        fake.events = [QUEUED, PLANNED, pursuit(31, A, "as_stated"), pursuit(32, A, "as_stated", "completed"), pursuit(35, C, "invalid_input")];
        await openRun();
        await pwExpect(item(C)).toHaveAttribute("data-state", "running", { timeout: 10_000 });
        await pwExpect(item(A)).toHaveAttribute("data-state", "done");
        await pwExpect(item(B)).toHaveAttribute("data-state", "waiting");
    }, 60_000);

    it("Stop is the run's own stop, for a person who may run tests", async () => {
        fake.active = true;
        fake.events = [QUEUED, PLANNED];
        await openRun();
        const stop = live().getByRole("button", { name: "Stop exploring" });
        await pwExpect(stop).toBeVisible();
        await stop.click();
        const dialog = page.getByRole("dialog");
        await pwExpect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Stop exploring" }).click();
        await pwExpect.poll(() => stops.length).toBe(1);
    }, 60_000);

    it("a person who may only look sees the same list, and no Stop anywhere", async () => {
        fake.active = true;
        fake.events = [QUEUED, PLANNED, A_ENDED, B_SAVED];
        fake.access = { projectAdmin: false, permissions: ["ai_studio.access", "ai_studio.reports.export"] };
        try {
            await openRun();
            await pwExpect(item(B)).toHaveAttribute("data-state", "running");
            await pwExpect(live().getByTestId("objective")).toHaveCount(3);
            await pwExpect(page.getByRole("button", { name: "Stop exploring" })).toHaveCount(0);
            await shot("live-objectives-viewer");
        } finally {
            fake.access = null;
        }
    }, 60_000);

    it("with a runner too old to explore by objectives, says so in the platform's sentence instead of the list", async () => {
        fake.active = true;
        fake.events = [ev(9, "objectives_need_runner", TOO_OLD, "orchestration"), QUEUED];
        await openRun();
        await pwExpect(page.getByTestId("objectives-note")).toContainText(TOO_OLD);
        await pwExpect(live()).toHaveCount(0);
        await shot("live-older-runner");
        await axeBoth();
    }, 60_000);

    it("a refusal from the server is shown as its sentence; no analysed model gets the platform's sentence", async () => {
        fake.active = true;
        fake.events = [QUEUED];
        const saved = fake.objectives;
        try {
            fake.objectives = { status: 403, json: { error: "You no longer have access to this project's objectives." } };
            await openRun();
            await pwExpect(live().getByRole("alert")).toContainText("You no longer have access to this project's objectives.");
            fake.objectives = null;
            await openRun();
            await pwExpect(live().getByTestId("objectives-unavailable")).toHaveText("This project has no analysed model of the application yet, so there are no objectives to show; explore the application first.");
        } finally {
            fake.objectives = saved;
        }
    }, 60_000);
});

describe("after the run", () => {
    it("shows the stop reason, the limits used and the coverage record, and each objective's outcome with what did not run", async () => {
        fake.active = false;
        fake.events = [QUEUED, PLANNED, A_ENDED, B_SAVED, STOPPED];
        fake.coverage = COVERAGE;
        await openRun();
        const cov = page.getByTestId("run-coverage");
        await pwExpect(cov.getByTestId("run-stop-reason")).toHaveText("Cancelled The session was stopped by a person.");
        await pwExpect(cov.getByRole("definition").filter({ hasText: "17 of 50" })).toHaveCount(1);
        const tallies = cov.getByTestId("run-coverage-tallies");
        await pwExpect(tallies).toContainText("Pages2 of 5");
        await pwExpect(tallies).toContainText("Status changesNone in the model");
        await pwExpect(tallies).toContainText("Different scenarios3");
        await cov.getByText("Not run (1)").click();
        await pwExpect(cov.getByTestId("run-coverage-not-run")).toContainText("Submit twice OBJ-bbbbbbbbbbbbbbbb: not run: data changes off");
        await cov.getByText(/^Left unexplored \(1\)/).click();
        await pwExpect(cov.getByTestId("run-coverage-unexplored")).toContainText(`Form field ${C.source}: not run: The session stopped first`);
        await pwExpect(cov).toContainText("17 actions recorded on 4 page states.");
        // The list takes the record's word over the events: skipped with why, and the operator that did not run under its objective.
        await pwExpect(item(C)).toHaveAttribute("data-state", "skipped");
        await pwExpect(item(C).getByTestId("objective-why")).toHaveText("Not run: The session stopped first: The session was stopped by a person.");
        await pwExpect(item(B).getByTestId("objective-not-run")).toHaveText("Submit twice: Not run: data changes off");
        await pwExpect(page.getByRole("button", { name: "Stop exploring" })).toHaveCount(0);
        await shot("run-coverage");
        await axeBoth();
        await noSidewaysScroll();
    }, 120_000);

    it("an older run without a coverage record says so in one sentence", async () => {
        await visit(`#/projects/${projectId}/runs/${olderRun}`);
        await pwExpect(page.getByTestId("run-coverage-unavailable")).toHaveText("This run has no coverage record: it did not explore by objectives, or it ran before coverage was recorded.");
        await shot("older-run");
    }, 60_000);

    it("left no console errors", () => {
        expect(consoleErrors).toEqual([]);
    });
});
