/**
 * The live view of a run on a runner, in a real browser against a real platform: the task's phase, the runner (yours, with a link),
 * the test and step it is on, steps done, passed and failed so far, the failure text (its stack stays in the final result), a screenshot as it arrives and
 * the runner's log, all as they happen (the run's live stream, no reload); a refresh mid-run rebuilds the same picture from the stored
 * events and keeps following; the strip on another page says where the run is; after the result, and when coming back later, the
 * final report. A protocol-1 runner (text lines only) is said to be one. Axe in light and dark, no sideways scroll at phone width.
 *
 * The runner is a FAKE AGENT speaking the real protocol (hello, poll, accept, events, file upload, heartbeat, result: protocol 2,
 * and protocol 1 for the old one); the platform, its worker, the job pipeline and the stream are real. Only the list of runner
 * choices is stood in for with a browser route, so the runner is "yours" whoever the open platform takes the viewer to be.
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/run-live-ui.test.ts
 * Ports: platform 8140, the app under test 8141.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { defaultCaps, failedRun, FakeAgent, passedRun, viaFetch } from "./fixtures/fake-agent.js";

const PORT = 8140;
const APP_PORT = 8141;
const BASE = `http://127.0.0.1:${PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;

let dataDir: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let app: http.Server;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let projectId = "";
let jobId = "";
let runnerId = "";
let picture: Buffer;
let secret = "";
const consoleErrors: string[] = [];
const saved = { poll: process.env.AGENT_POLL_SECONDS, watch: process.env.AGENT_WATCH_MS };

const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: /^[{[]/.test(text) ? JSON.parse(text) : text } as { status: number; body: any };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The runner of these tests: a fake agent that speaks protocol 2 (accept, live events, attempt ids). */
class LiveAgent extends FakeAgent {
    attemptId = "";
    taskId = "";
    private seq = 0;
    private beat: NodeJS.Timeout | undefined;
    private post(p: string, body: unknown) {
        return this.send("POST", p, { headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    }
    async take(): Promise<void> {
        const offer = (await this.next(30_000))!;
        expect(offer, "the runner was offered the run").toBeTruthy();
        this.taskId = offer.taskId;
        this.attemptId = (offer as { attemptId?: string }).attemptId ?? "";
        expect(this.attemptId, "a protocol-2 offer names its attempt").not.toBe("");
        const ok = await this.post(`/api/agent/tasks/${this.taskId}/accept`, { attemptId: this.attemptId });
        expect(ok.status, ok.text).toBe(200);
        // Keeps the task's lease while the browser looks (the platform would otherwise offer the run again).
        this.beat = setInterval(() => void this.post(`/api/agent/tasks/${this.taskId}/heartbeat`, { attemptId: this.attemptId }).catch(() => undefined), 3000);
    }
    async events(...list: Array<Record<string, unknown>>): Promise<void> {
        const events = list.map((e) => ({ seq: this.seq++, at: new Date().toISOString(), ...e }));
        const r = await this.post(`/api/agent/tasks/${this.taskId}/events`, { attemptId: this.attemptId, events });
        expect(r.status, r.text).toBe(200);
        expect(r.json.stored).toBe(events.length);
    }
    async picture(name: string, bytes: Buffer): Promise<void> {
        const r = await this.upload(this.taskId, name, bytes, { "x-attempt-id": this.attemptId });
        expect(r.status, r.text).toBe(200);
    }
    async finish(runs: unknown[]): Promise<void> {
        clearInterval(this.beat);
        const r = await this.result(this.taskId, { ok: true, runs, attemptId: this.attemptId } as never);
        expect(r.status, r.text).toBe(200);
    }
    stop(): void {
        clearInterval(this.beat);
    }
}
let maya: LiveAgent;

const addTest = (n: number, title: string) => {
    const spec = TestSpecSchema.parse({ testId: `WEB-00${n}`, title, kind: "web", category: "Shop", steps: [{ action: "navigate", url: "/" }] });
    const suite = platform.repo.getOrCreateSuite(projectId, "Shop", "shop");
    return platform.repo.insertTest({ projectId, suiteId: suite, jobId: null, spec, framework: "playwright", validationStatus: "PENDING" });
};

async function jobDone(id: string, timeoutMs = 60_000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const job = (await call("GET", `/api/test-generation/${id}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) return job;
        if (Date.now() > until) throw new Error(`job ${id} did not finish: ${job.status}`);
        await sleep(200);
    }
}

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_WATCH_MS: "50" });
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-run-live-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT), CONCURRENCY: "1" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 100);
    worker.start();
    app = http.createServer((_req, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end("<!doctype html><title>Shop</title><h1>Shop</h1><button>Pay</button>")));
    await new Promise<void>((r) => app.listen(APP_PORT, "127.0.0.1", r));

    projectId = (await call("POST", "/api/projects", { name: "Live shop" })).body.id;
    platform.repo.createApplication(projectId, APP, { ...DEFAULT_JOB_OPTIONS });
    // Only approved versions run: these tests start approved.
    expect((await call("PUT", `/api/projects/${projectId}/review-policy`, { aiGenerated: false, edits: false })).status).toBe(200);
    addTest(1, "Sign in");
    addTest(2, "Checkout");
    addTest(3, "Profile");
    const made = await call("POST", `/api/projects/${projectId}/agent-tokens`, { label: "maya-laptop" });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    runnerId = made.body.token.id;
    secret = made.body.secret;
    maya = new LiveAgent(viaFetch(BASE), made.body.secret, { name: "maya-laptop", capabilities: defaultCaps({ browsers: ["chromium"] }) });
    const hi = await maya.hello({ protocols: [1, 2] });
    expect(hi.status, hi.text).toBe(200);
    expect(hi.json.protocol).toBe(2);
    getAgentServices(platform).store.setRunner(projectId, { runOn: "agent", agentId: null });

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    // A real picture for the runner to send: the app under test, as a browser shows it.
    const shooter = await context.newPage();
    await shooter.goto(APP);
    picture = await shooter.screenshot({ type: "png" });
    await shooter.close();
    page = await context.newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    // Which runners this viewer may choose (GET /runner-choices): stood in for, so the runner is theirs.
    await page.route("**/api/projects/*/runner-choices", (route) =>
        route.fulfill({ json: { runners: [{ id: runnerId, name: "maya-laptop", kind: "personal", mine: true, online: true, busy: true, machine: { os: "linux", arch: "x64" }, canRunWeb: true, canRunMobile: false, codeScripts: true, problem: null }], allowPersonal: true, defaultRunnerId: null } }),
    );
}, 180_000);

afterAll(async () => {
    maya?.stop();
    await browser?.close();
    await worker?.stop();
    await server?.close();
    app?.closeAllConnections?.();
    app?.close();
    platform?.db.close();
    if (saved.poll === undefined) delete process.env.AGENT_POLL_SECONDS;
    else process.env.AGENT_POLL_SECONDS = saved.poll;
    if (saved.watch === undefined) delete process.env.AGENT_WATCH_MS;
    else process.env.AGENT_WATCH_MS = saved.watch;
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const visit = async (hash: string) => {
    await page.goto("about:blank");
    await page.goto(`${BASE}/${hash}`);
};
const panel = () => page.getByTestId("run-live");
const row = (title: string) => page.locator(".run-tests .run-test", { hasText: title });
const axe = async () => {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(400);
        const r = await new AxeBuilder({ page }).analyze();
        expect(r.violations.map((v) => `${scheme}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
};
const noSidewaysScroll = async () => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
};

describe("a run on a runner, live", () => {
    it("shows the phase, the runner, the test and step, results so far, the failure, a screenshot and the log as they happen", async () => {
        const started = await call("POST", `/api/projects/${projectId}/runs`, {});
        expect(started.status, JSON.stringify(started.body)).toBe(202);
        jobId = started.body.jobId;
        await maya.take();

        await visit(`#/projects/${projectId}/runs/${jobId}`);
        await pwExpect(panel().getByRole("heading", { name: "Progress on the runner" })).toBeVisible({ timeout: 20_000 });
        await pwExpect(panel().getByText("Your computer", { exact: true })).toBeVisible();
        await pwExpect(panel().getByTestId("run-live-runner")).toHaveAttribute("href", `#/runners/${runnerId}`);
        await pwExpect(panel().getByTestId("run-live-phase")).toHaveText("maya-laptop accepted the run.");
        // Nothing below is a page load: the same document follows the run.
        await page.evaluate(() => ((window as unknown as { __same: number }).__same = 1));

        await maya.events({ type: "phase", phase: "preparing" });
        await pwExpect(panel().getByTestId("run-live-phase")).toHaveText("maya-laptop is getting ready: it fetches the tests and the files they need.");
        await pwExpect(panel().getByRole("list", { name: "Where the run is" }).locator("[aria-current=step]")).toContainText("Getting ready");

        await maya.events({ type: "phase", phase: "running" }, { type: "test_started", testId: "WEB-001", title: "Sign in" }, { type: "step_started", testId: "WEB-001", index: 0, title: "Open the shop" });
        await pwExpect(panel().getByTestId("run-live-current")).toHaveText("Sign in (WEB-001), step 1: Open the shop");
        await pwExpect(row("Sign in")).toHaveAttribute("data-state", "running");
        await pwExpect(row("Sign in")).toContainText("Step 1: Open the shop");

        await maya.events(
            { type: "step_finished", testId: "WEB-001", index: 0, title: "Open the shop", status: "passed", durationMs: 420 },
            { type: "test_finished", testId: "WEB-001", title: "Sign in", status: "passed", durationMs: 900 },
            { type: "test_started", testId: "WEB-002", title: "Checkout" },
            { type: "step_finished", testId: "WEB-002", index: 0, title: "Click Pay", status: "failed", durationMs: 5000, error: "Timed out waiting for the Pay button" },
        );
        await maya.picture("WEB-002-step1.png", picture);
        await maya.events(
            { type: "screenshot", testId: "WEB-002", ref: "WEB-002-step1.png", step: 0 },
            { type: "test_finished", testId: "WEB-002", title: "Checkout", status: "failed", durationMs: 5100, error: "Timed out waiting for the Pay button", stack: "at checkout.spec.ts:12:5" },
            { type: "log", line: "Closing the browser" },
        );
        await pwExpect(panel().getByTestId("run-live-counts")).toHaveText("1 passed, 1 failed");
        await pwExpect(panel().getByTestId("run-live-steps")).toHaveText("2");
        await pwExpect(panel().getByTestId("run-live-current")).toHaveText("Between tests");
        const failures = panel().getByTestId("run-live-failures");
        await pwExpect(failures).toContainText("Checkout (WEB-002)");
        await pwExpect(failures).toContainText("Step 1: Click Pay");
        await pwExpect(failures).toContainText("Timed out waiting for the Pay button");
        // The runner sent a stack, but live events do not keep one (it is in the final result only), so the live card shows none.
        await pwExpect(failures.getByText("Stack trace")).toHaveCount(0);
        await pwExpect(failures).not.toContainText("at checkout.spec.ts:12:5");
        const shot = panel().getByTestId("run-live-shots").getByRole("img", { name: "WEB-002 Checkout, step 1: Click Pay" });
        await pwExpect(shot).toBeVisible();
        await pwExpect.poll(() => shot.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
        await pwExpect(panel().getByTestId("run-live-log")).toContainText("maya-laptop: Closing the browser");
        await pwExpect(row("Sign in")).toHaveAttribute("data-state", "passed");
        await pwExpect(row("Checkout")).toHaveAttribute("data-state", "failed");
        await pwExpect(row("Checkout")).toContainText("Timed out waiting for the Pay button");
        expect(await page.evaluate(() => (window as unknown as { __same?: number }).__same)).toBe(1);
    }, 120_000);

    it("a refresh mid-run rebuilds the same picture from the stored events, and keeps following", async () => {
        await maya.events({ type: "test_started", testId: "WEB-003", title: "Profile" }, { type: "step_started", testId: "WEB-003", index: 0, title: "Open the profile" });
        await pwExpect(panel().getByTestId("run-live-current")).toHaveText("Profile (WEB-003), step 1: Open the profile");
        await page.reload();
        await pwExpect(panel().getByTestId("run-live-current")).toHaveText("Profile (WEB-003), step 1: Open the profile", { timeout: 20_000 });
        await pwExpect(panel().getByTestId("run-live-phase")).toHaveText("Running on maya-laptop.");
        await pwExpect(panel().getByTestId("run-live-counts")).toHaveText("1 passed, 1 failed, 1 running");
        await pwExpect(panel().getByTestId("run-live-failures")).toContainText("Timed out waiting for the Pay button");
        await pwExpect(panel().getByTestId("run-live-shots").getByRole("img")).toHaveCount(1);
        await pwExpect(panel().getByTestId("run-live-log")).toContainText("maya-laptop: Closing the browser");
        await pwExpect(row("Profile")).toContainText("Step 1: Open the profile");
        await axe();
        await noSidewaysScroll();

        // Still live after the refresh.
        await maya.events({ type: "step_finished", testId: "WEB-003", index: 0, title: "Open the profile", status: "passed", durationMs: 300 }, { type: "step_started", testId: "WEB-003", index: 1, title: "Change the name" });
        await pwExpect(panel().getByTestId("run-live-current")).toHaveText("Profile (WEB-003), step 2: Change the name");
        await pwExpect(panel().getByTestId("run-live-steps")).toHaveText("3");
    }, 120_000);

    it("the strip on another page says which test and step the runner is on", async () => {
        await visit(`#/projects/${projectId}/scripts`);
        const strip = page.getByTestId("run-strip");
        await pwExpect(strip).toBeVisible({ timeout: 20_000 });
        await pwExpect(strip.getByTestId("run-strip-now")).toHaveText("Now: Profile (WEB-003), step 2: Change the name");
        await pwExpect(strip).toContainText("maya-laptop");
        await pwExpect(strip).toContainText("1 failing");
    }, 60_000);

    it("after the result: the phase is done, the stored results are the report, and coming back later shows the same", async () => {
        await visit(`#/projects/${projectId}/runs/${jobId}`);
        await pwExpect(panel().getByTestId("run-live-current")).toHaveText("Profile (WEB-003), step 2: Change the name", { timeout: 20_000 });
        await maya.events({ type: "step_finished", testId: "WEB-003", index: 1, title: "Change the name", status: "passed", durationMs: 200 }, { type: "test_finished", testId: "WEB-003", title: "Profile", status: "passed", durationMs: 700 }, { type: "phase", phase: "uploading" });
        await pwExpect(panel().getByTestId("run-live-phase")).toHaveText("maya-laptop is sending the results.");
        await maya.finish([passedRun("WEB-001"), failedRun("WEB-002", "Timed out waiting for the Pay button"), passedRun("WEB-003")]);
        await jobDone(jobId);

        await pwExpect(panel().getByRole("heading", { name: "On the runner" })).toBeVisible({ timeout: 20_000 });
        await pwExpect(panel().getByTestId("run-live-phase")).toHaveText("Finished on maya-laptop.");
        await pwExpect(page.getByTestId("run-summary")).toHaveText("2 of 3 that ran passed, 1 failing.");

        await visit(`#/projects/${projectId}/runs/${jobId}`);
        await pwExpect(panel().getByRole("heading", { name: "On the runner" })).toBeVisible({ timeout: 20_000 });
        await pwExpect(panel().getByTestId("run-live-phase")).toHaveText("Finished on maya-laptop.");
        await pwExpect(panel().getByRole("list", { name: "Where the run is" }).locator("li.is-done")).toHaveCount(7);
        await pwExpect(panel().getByTestId("run-live-counts")).toHaveText("2 passed, 1 failed");
        await pwExpect(panel().getByTestId("run-live-duration")).not.toHaveText("Not known");
        await pwExpect(panel().getByTestId("run-live-failures")).toContainText("Timed out waiting for the Pay button");
        await pwExpect(panel().getByTestId("run-live-shots").getByRole("img")).toHaveCount(1);
        await pwExpect(row("Sign in")).toHaveAttribute("data-state", "passed");
        await pwExpect(row("Checkout")).toHaveAttribute("data-state", "failed");
        await pwExpect(row("Profile")).toHaveAttribute("data-state", "passed");
        await axe();
        await noSidewaysScroll();
    }, 120_000);

    it("a protocol-1 runner: its phase and its text lines, and a plain note that steps come with the results", async () => {
        // The same computer comes back with an older runner program that speaks only protocol 1 (installed, not updated yet).
        const old = new FakeAgent(viaFetch(BASE), secret, { name: "maya-laptop", capabilities: defaultCaps({ browsers: ["chromium"] }) });
        const hi = await old.hello();
        expect(hi.status, hi.text).toBe(200);
        // A protocol-1 agent gets exactly the old answer (no protocol field, or 1).
        expect(hi.json.protocol ?? 1).toBe(1);
        const run = await call("POST", `/api/projects/${projectId}/runs`, {});
        expect(run.status, JSON.stringify(run.body)).toBe(202);
        const offer = (await old.next(30_000))!;
        expect(offer).toBeTruthy();
        expect((await old.heartbeat(offer.taskId, { done: 1, total: 3, log: ["Finished 1 of 3"] })).status).toBe(200);

        await visit(`#/projects/${projectId}/runs/${run.body.jobId}`);
        await pwExpect(panel().getByTestId("run-live-text-only")).toHaveText("This runner reports its progress as text lines only, so steps and screenshots appear when the results arrive.", { timeout: 20_000 });
        await pwExpect(panel().getByTestId("run-live-log")).toContainText("maya-laptop: Finished 1 of 3");
        await pwExpect(panel().getByTestId("run-live-counts")).toHaveCount(0);
        expect((await old.result(offer.taskId, { ok: true, runs: offer.scripts.map((s) => passedRun(s.testId)) })).status).toBe(200);
        await jobDone(run.body.jobId);
        await pwExpect(panel().getByTestId("run-live-phase")).toHaveText("Finished on maya-laptop.", { timeout: 20_000 });
        expect(consoleErrors).toEqual([]);
    }, 120_000);

    it("a test held back from a run says why, under Waiting for approval", async () => {
        // The run's answer is the platform's, plus one held-back test with a reason (as approval checks give it): stood in for here.
        const held = { id: "t-held", testId: "WEB-009", title: "Coupon", version: 2, reason: "A shared step it uses changed after approval; approve it again to run it." };
        await page.route(`**/api/projects/${projectId}/runs/${jobId}`, async (route) => {
            const real = await route.fetch();
            await route.fulfill({ response: real, json: { ...(await real.json()), heldBack: [held] } });
        });
        await visit(`#/projects/${projectId}/runs/${jobId}`);
        const section = page.getByTestId("run-held-back");
        await pwExpect(section.getByRole("heading", { name: "Waiting for approval (1)" })).toBeVisible({ timeout: 20_000 });
        await pwExpect(section.getByTestId("run-held-reason")).toHaveText(held.reason);
        await page.unroute(`**/api/projects/${projectId}/runs/${jobId}`);
    }, 60_000);
});
