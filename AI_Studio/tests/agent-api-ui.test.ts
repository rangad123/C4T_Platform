/**
 * Agent Workspace W2a: the API Testing Agent's page in a real browser (SPEC §3). Outcome: the endpoint table (method, path, status,
 * contract) and the verified findings, nothing of another agent's; Runs: its runs only, each opening what that run tested; Setup: its
 * inputs only, with Needs input while the OpenAPI document is missing. Axe with the colour scheme light and dark, no sideways scroll at
 * 375 px. Runs are seeded as the worker leaves them (tests, the API snapshot, findings); no AI and no exploring browser. Port 7611.
 * Screenshots: c4t-scratch/agent-ws/api/. Requires web/dist:
 *   node scripts/with-lock.mjs build -- npm run build:web
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/agent-api-ui.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { CONTRACT_FAILURE_PREFIX } from "../src/engine/contracts/check.js";
import { findingFingerprint } from "../src/engine/explore/finding.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { recordObservations } from "../src/platform/drift-store.js";
import { DEFAULT_JOB_OPTIONS, type JobStatus } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { routes } from "../web/src/lib/router.js";

const PORT = 7611;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.resolve(REPO_ROOT, "../../c4t-scratch/agent-ws/api");

let dataDir = "";
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let page: Page;
let pid = "";
let appId = "";
let n = 0;
const jobs: Record<string, string> = {};
const tests: Record<string, string> = {};
const consoleErrors: string[] = [];

async function job(agentId: string, status: JobStatus, error?: string) {
    await new Promise((r) => setTimeout(r, 5));
    const j = await platform.repo.createJob(pid, appId, { ...DEFAULT_JOB_OPTIONS, agentId: agentId as never });
    platform.repo.setJobStatus(j.id, status, error);
    return j.id;
}
function test(jobId: string, name: string, endpoint: string, o: { schema?: boolean; meta?: Record<string, unknown>; status: "VALIDATED" | "NEEDS_REVIEW"; reason?: string; kind?: "api" | "web" }) {
    const [method, p] = endpoint.split(" ");
    const spec = TestSpecSchema.parse({ testId: `API-${String(++n).padStart(3, "0")}`, title: `${endpoint}: succeeds with a valid request`, kind: o.kind ?? "api", category: "API", steps: [{ action: "request", method, path: p }, ...(o.schema ? [{ action: "assertResponse", check: "matchesSchema", schema: { type: "object" } }] : [])] });
    const id = platform.repo.insertTest({ projectId: pid, suiteId: platform.repo.getOrCreateSuite(pid, "API", "api"), jobId, spec, framework: "playwright-api", validationStatus: "PENDING", meta: { endpoint, ...o.meta } });
    platform.repo.updateTest(id, { validationStatus: o.status, reason: o.reason ?? null });
    tests[name] = id;
}
const answered = (jobId: string, calls: Array<[string, string, number]>) => recordObservations(platform.db, { projectId: pid, jobId, responses: calls.map(([method, p, status]) => ({ method, path: p, status, obs: null })) });

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-agent-api-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });

    pid = platform.repo.createProject({ name: "Atlas API", platforms: ["web"], testingModes: ["agent"] }).id as string;
    appId = platform.repo.createApplication(pid, "http://127.0.0.1:7619", { ...DEFAULT_JOB_OPTIONS });
    expect((await fetch(`${BASE}/api/projects/${pid}/testing-agents`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ agents: ["api", "security"] }) })).status).toBe(200);

    jobs.first = await job("api", "COMPLETED");
    test(jobs.first, "users", "GET /api/users/{id}", { schema: true, status: "VALIDATED" });
    test(jobs.first, "orders", "POST /api/orders", { schema: true, status: "NEEDS_REVIEW", reason: `${CONTRACT_FAILURE_PREFIX} the field "total" is missing [high]\nHow to fix: update the document` });
    answered(jobs.first, [["GET", "/api/users/42", 200], ["POST", "/api/orders", 201]]);
    jobs.security = await job("security", "COMPLETED");
    test(jobs.security, "admin", "GET /api/admin", { meta: { security: true }, status: "NEEDS_REVIEW", reason: "Missing header" });
    jobs.second = await job("api", "FAILED", "Cancelled");
    test(jobs.second, "health", "GET /api/health", { status: "NEEDS_REVIEW", reason: "Server error: GET /api/health returned 500" });
    answered(jobs.second, [["GET", "/api/health", 500]]);
    const store = new CandidateFindingStore(platform.sql);
    const fid = (
        await store.upsert({
            projectId: pid,
            jobId: jobs.second,
            testId: tests.health,
            finding: {
                objective: null,
                actions: { stepCount: 1 },
                expected: { text: "Answers 200 with the health document.", source: "openapi:GET /api/health" },
                observed: "Answered 500 Internal Server Error.",
                evidence: { screenshots: [], requests: ["GET /api/health -> 500"], console: [] },
                capture: "captured",
                independence: "independent",
                confidence: "high",
                fingerprint: findingFingerprint({ source: "openapi:GET /api/health", expected: "Answers 200 with the health document.", scenario: "health" }),
                modelVersion: null,
                replays: [],
            },
        })
    ).finding.id;
    await store.transition(pid, fid, { to: "verification_pending", by: "engine" });
    await store.transition(pid, fid, { to: "reproduced", by: "engine", set: { severity: "high", confidence: { confidence: "high", factors: [] } as never, attempts: [{ outcome: "failed", error: "500" }, { outcome: "failed", error: "500" }, { outcome: "failed", error: "500" }] } });
    await store.transition(pid, fid, { to: "confirmed", by: "engine" });

    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

async function visit(hash: string) {
    await page.goto("about:blank");
    await page.goto(`${BASE}/${hash}`);
    await pwExpect(page.locator("h1").first()).toBeVisible();
}
async function shot(name: string) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(SHOTS, name), fullPage: true, animations: "disabled" });
}
/** Axe with the colour scheme light, then dark (a 400 ms settle: colours ease). */
async function axe(what: string) {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(400);
        const r = await new AxeBuilder({ page }).analyze();
        expect(r.violations.map((v) => `${what} (${scheme}): ${v.id}: ${v.nodes.map((x) => x.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: null });
}
async function narrow(name: string) {
    await page.setViewportSize({ width: 375, height: 800 });
    try {
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
        await shot(name);
    } finally {
        await page.setViewportSize({ width: 1280, height: 900 });
    }
}
const tabs = () => page.getByRole("navigation", { name: "API Testing Agent sections" });
const cells = async () => (await pwExpect(page.getByTestId("api-endpoints")).toBeVisible(), await page.getByTestId("api-endpoints").locator("tbody tr").all()).map(async (r) => (await r.locator("td").allTextContents()).map((t) => t.trim()));

describe("the API Testing Agent's page", () => {
    it("Outcome: the endpoint table and the verified findings, and nothing of another agent's", async () => {
        await visit(routes.projectAgent(pid, "api"));
        await pwExpect(page.getByTestId("api-outcome")).toBeVisible();
        expect(await page.getByTestId("api-endpoints").locator("thead th").allTextContents()).toEqual(["Method", "Path", "Status", "Contract"]);
        expect(await Promise.all(await cells())).toEqual([
            ["GET", "/api/health", "500", "Not checked"],
            ["POST", "/api/orders", "201", 'Differsthe field "total" is missing'],
            ["GET", "/api/users/{id}", "200", "Matches"],
        ]);
        const findings = page.getByTestId("api-findings").locator("li");
        await pwExpect(findings).toHaveCount(1);
        await pwExpect(findings.first()).toContainText("GET /api/health: succeeds with a valid request");
        await pwExpect(findings.first()).toContainText("High severity");
        await pwExpect(findings.first()).toContainText("Confirmed");
        await pwExpect(findings.first()).toContainText("Answers 200 with the health document.");
        await pwExpect(findings.first()).toContainText("Answered 500 Internal Server Error.");
        await pwExpect(findings.first()).toContainText("Failed the same way 3 of 3 times");
        const text = (await page.locator(".content").textContent()) ?? "";
        for (const other of ["/api/admin", "Missing header", "Test cases", "Passing", "Page speed", "Accessibility"]) expect(text).not.toContain(other);
        await axe("api outcome");
        await shot("outcome.png");
        await narrow("outcome-375.png");
    });

    it("Runs: its runs only, each opening what that run tested, a stopped run's part included", async () => {
        await visit(routes.projectAgent(pid, "api", "runs"));
        const list = page.getByTestId("agent-runs").locator("li");
        await pwExpect(list).toHaveCount(2);
        await list.nth(1).getByRole("link", { name: "Run 1" }).click();
        await pwExpect(page.getByTestId("agent-run")).toContainText("Run 1");
        expect((await Promise.all(await cells())).map((r) => r[1])).toEqual(["/api/orders", "/api/users/{id}"]);
        await pwExpect(page.getByTestId("api-findings")).toHaveCount(0);
        await axe("api run");
        await shot("run.png");
        await visit(routes.projectAgentRun(pid, "api", jobs.second));
        await pwExpect(page.getByTestId("agent-run")).toContainText("Run 2");
        expect((await Promise.all(await cells())).map((r) => r[1])).toEqual(["/api/health"]);
        await pwExpect(page.getByTestId("api-findings").locator("li")).toHaveCount(1);
        await narrow("run-375.png");
    });

    it("Setup: its own inputs, with Needs input while the OpenAPI document is missing", async () => {
        await visit(routes.projectAgent(pid, "api", "setup"));
        const setup = page.getByTestId("agent-setup");
        await pwExpect(setup.locator(".callout")).toContainText("The API Testing Agent needs the API documentation");
        await pwExpect(setup).toContainText("OpenAPI document");
        await pwExpect(setup).toContainText("API access");
        await pwExpect(setup).toContainText("Calls that change data");
        await pwExpect(setup.getByRole("link", { name: "Requirements" }).first()).toHaveAttribute("href", /requirements\?inputs=open/);
        await axe("api setup");
        await shot("setup.png");
        await narrow("setup-375.png");
        await pwExpect(tabs()).toBeVisible();
        expect(consoleErrors).toEqual([]);
    });
});
