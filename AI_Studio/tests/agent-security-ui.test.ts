/**
 * The Security Testing Agent's page in a real browser (Agent Workspace W2c, .scratch/agent-workspace/SPEC.md §3, CONTRACT.md):
 *
 *   - Outcome: the verified findings with their reproduction, then its checks by area (access control; headers, cookies and HTTPS;
 *     exposure), a problem still being verified named on its check; the link to the Security Assessment; nothing of another agent;
 *   - Runs: its runs only, each opening that run's part (a stopped run's checks kept);
 *   - Setup: the address and the test accounts, where each is kept;
 *   - axe with the colour scheme light and dark, and no sideways scroll at 375 px.
 *
 * The platform is real; the runs are seeded as the engine leaves them (tests with meta, findings walked along the lifecycle). Port 7811.
 * Requires web/dist:
 *   node scripts/with-lock.mjs build -- npm run build:web
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/agent-security-ui.test.ts
 * Screenshots go to AGENT_SHOTS (default c4t-scratch/agent-ws/security beside the repository).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { executionFinding } from "../src/platform/findings/adapters.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { routes } from "../web/src/lib/router.js";

const PORT = 7811;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.AGENT_SHOTS ?? "/home/aadhaar/projects/c4t-scratch/agent-ws/security";
let dataDir = "";
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let page: Page;
let pid = "";
let empty = "";
const ids: Record<string, string> = {};
const consoleErrors: string[] = [];

const spec = (testId: string, title: string, steps: unknown[], kind: "api" | "web" = "api") =>
    TestSpecSchema.parse({ testId, title, kind, type: kind === "api" ? "security" : "visual", priority: "high", steps, expectedResults: [`${title}.`] });
const failed = (error: string) => ({ testId: "x", status: "failed", durationMs: 10, failedStepIndex: 1, steps: [{ index: 1, title: "check", status: "failed", error }], artifacts: [], responses: [] }) as unknown as ScriptRun;

async function project(name: string): Promise<{ id: string; appId: string }> {
    const id = platform.repo.createProject({ name, platforms: ["web"], testingModes: ["agent"] }).id as string;
    const appId = platform.repo.createApplication(id, "http://127.0.0.1:7819", { ...DEFAULT_JOB_OPTIONS });
    const r = await fetch(`${BASE}/api/projects/${id}/testing-agents`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ agents: ["security", "responsive-ui"] }) });
    expect(r.status).toBe(200);
    return { id, appId };
}

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-agent-sec-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "agent-security-ui-secret-0123456789", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });

    const repo = platform.repo;
    const p = await project("Secure Store");
    pid = p.id;
    empty = (await project("Quiet Store")).id;
    const suite = repo.getOrCreateSuite(pid, "General", "general");
    const job = async (agentId: string) => (await repo.createJob(pid, p.appId, { ...DEFAULT_JOB_OPTIONS, agentId } as never)).id;
    ids.first = await job("security");
    ids.stopped = await job("security");
    ids.other = await job("responsive-ui");
    const add = (jobId: string, s: ReturnType<typeof spec>, status: "VALIDATED" | "NEEDS_REVIEW" | "PENDING", meta: Record<string, unknown>, reason?: string) => {
        const id = repo.insertTest({ projectId: pid, suiteId: suite, jobId, spec: s, framework: s.kind === "api" ? "playwright-api" : "playwright", validationStatus: status, meta });
        if (reason) repo.updateTest(id, { reason });
        return id;
    };
    const headers = spec("API-001", "Browser security headers are set (/)", [
        { action: "request", method: "GET", path: "/", auth: "none", description: "Request / (read-only)" },
        { action: "assertResponse", check: "securityHeaders", expected: "csp,frame,nosniff,referrer", description: "Security headers are present" },
    ]);
    ids.headers = add(ids.first, headers, "NEEDS_REVIEW", { security: true }, "Security check failed: 2 browser protections are missing.\n- [medium] No Content-Security-Policy. Add one.\n- [low] No Referrer-Policy. Add one.");
    add(ids.first, spec("API-002", "Secret and source-control files cannot be downloaded", [{ action: "request", method: "GET", path: "/.env" }, { action: "assertResponse", check: "noExposedFiles" }]), "VALIDATED", { security: true });
    add(ids.first, spec("API-003", "The server does not reveal software versions or list folders", [{ action: "request", method: "GET", path: "/" }, { action: "assertResponse", check: "noInfoDisclosure" }]), "VALIDATED", { security: true });
    const access = spec("WEB-001", "A visitor cannot open /admin", [{ action: "navigate", url: "/admin", description: "Open /admin signed out" }, { action: "assert", check: "url", expected: "/login", description: "The visitor is sent to sign in" }], "web");
    ids.access = add(ids.first, access, "NEEDS_REVIEW", { access: true }, "A visitor could open /admin: it answered the admin page instead of sending them to sign in.");
    add(ids.stopped, spec("API-004", "Session cookies are protected (/)", [{ action: "request", method: "GET", path: "/" }, { action: "assertResponse", check: "cookieFlags" }]), "PENDING", { security: true });
    add(ids.other, spec("WEB-002", "Home page looks the same as its approved baseline (/)", [{ action: "navigate", url: "/" }, { action: "assert", check: "screenshot", expected: 100 }], "web"), "VALIDATED", { visual: true });
    repo.setJobStatus(ids.first, "COMPLETED");
    repo.setJobStatus(ids.stopped, "FAILED", "Cancelled");
    repo.setJobStatus(ids.other, "COMPLETED");

    const store = new CandidateFindingStore(platform.sql);
    const finding = async (testId: string, s: ReturnType<typeof spec>, error: string, verified: boolean) => {
        const f = (await store.upsert({ projectId: pid, jobId: ids.first, testId, finding: executionFinding({ id: testId, title: s.title, spec: s }, failed(error)) })).finding;
        await store.transition(pid, f.id, { to: "verification_pending", by: "engine" });
        if (verified) {
            const a = { outcome: "failed", failedStep: 2, check: "securityHeaders", error };
            await store.transition(pid, f.id, { to: "reproduced", by: "engine", set: { severity: "medium", attempts: [a, a, a] } });
        }
    };
    await finding(ids.headers, headers, "Security check failed: 2 browser protections are missing.", true);
    await finding(ids.access, access, "Expected /login, got /admin", false);

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
    await pwExpect(page.getByTestId("place-head").locator("h2")).toHaveText("Security Testing Agent");
}
async function shot(name: string) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(SHOTS, name), fullPage: true, animations: "disabled" });
}
async function axe(what: string) {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(400);
        const r = await new AxeBuilder({ page }).analyze();
        expect(r.violations.map((v) => `${what} (${scheme}): ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
}
async function at375(name: string) {
    await page.setViewportSize({ width: 375, height: 800 });
    try {
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
        await shot(name);
    } finally {
        await page.setViewportSize({ width: 1280, height: 900 });
    }
}
const tabs = () => page.getByRole("navigation", { name: "Security Testing Agent sections" });

describe("the Security Testing Agent's page (W2c)", () => {
    it("Outcome: the verified finding with its reproduction, the checks by area, the Security Assessment link, nothing else", async () => {
        await visit(routes.projectAgent(pid, "security"));
        const out = page.getByTestId("security-outcome");
        await pwExpect(out).toContainText("2 of 5 checks passed over 2 runs");
        const f = page.getByTestId("security-finding");
        await pwExpect(f).toHaveCount(1);
        await pwExpect(f).toContainText("Browser security headers are set (/)");
        await pwExpect(f).toContainText("Reproduced");
        await pwExpect(f).toContainText("Medium severity");
        await pwExpect(f.locator("ol li")).toHaveText(["Request / (read-only)", "Security headers are present"]);
        await pwExpect(f).toContainText("Failed the same way in 3 of 3 verification replays");
        await pwExpect(page.getByTestId("security-area-access")).toContainText("Finding: Verification pending");
        await pwExpect(page.getByTestId("security-area-headers").getByTestId("security-check")).toHaveCount(2);
        await pwExpect(page.getByTestId("security-area-exposure").getByTestId("security-check")).toHaveCount(2);
        await pwExpect(page.getByTestId("security-area-exposure")).toContainText("Passed");
        await pwExpect(page.getByTestId("security-assessment-link").getByRole("link", { name: "Security Assessment" })).toHaveAttribute("href", `#/projects/${pid}/security`);
        // Not another agent's: the Responsive UI run's visual check is absent.
        expect(await out.textContent()).not.toContain("approved baseline");
        await axe("security outcome");
        await shot("outcome.png");
        await at375("outcome-375.png");
    });

    it("Runs: its runs only, each opening that run's part; a stopped run's checks are kept", async () => {
        await visit(routes.projectAgent(pid, "security", "runs"));
        await pwExpect(page.getByTestId("agent-runs").locator("li")).toHaveCount(2);
        await shot("runs.png");
        await visit(routes.projectAgentRun(pid, "security", ids.stopped));
        await pwExpect(page.getByTestId("security-outcome")).toContainText("0 of 1 checks passed in this run");
        await pwExpect(page.getByTestId("security-check")).toHaveText([/Session cookies are protected/]);
        await pwExpect(page.getByTestId("security-finding")).toHaveCount(0);
        await visit(routes.projectAgentRun(pid, "security", ids.first));
        await pwExpect(page.getByTestId("security-check")).toHaveCount(4);
        await pwExpect(page.getByTestId("security-finding")).toHaveCount(1);
        await axe("security run");
        await shot("run.png");
        await at375("run-375.png");
    });

    it("Setup: the address and the test accounts, where each is kept; a project not run yet offers to run", async () => {
        await visit(routes.projectAgent(pid, "security", "setup"));
        const s = page.getByTestId("agent-setup");
        await pwExpect(s).toContainText("http://127.0.0.1:7819");
        await pwExpect(s).toContainText("None: the access checks are left out");
        await pwExpect(s.getByRole("link", { name: "Settings → Sign-in" })).toBeVisible();
        await axe("security setup");
        await shot("setup.png");
        await at375("setup-375.png");
        await visit(routes.projectAgent(empty, "security"));
        await pwExpect(page.getByText("Not run yet").last()).toBeVisible();
        await pwExpect(page.getByRole("link", { name: "Run the checks" })).toHaveAttribute("href", routes.newProject({ project: empty, agent: "security" }));
        await tabs().getByRole("link", { name: "Outcome" }).isVisible();
        expect(consoleErrors).toEqual([]);
    });
});
