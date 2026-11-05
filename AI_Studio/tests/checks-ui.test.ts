/**
 * The UI side of the health + security checks, driven in a real browser against a real platform:
 *  1. findings: the weak fixture's health and security tests are validated for real, then the Tests tab
 *     and a test page show them in plain language with the right severity (no jargon, no raw tags);
 *  2. the "New project" form: both toggles exist, default to on, and what the user chooses reaches the job.
 * Requires `npm run build:web` (run inside the shared "browser" lock).
 *
 * Ports: fixture 5224 (examples/checks-app, weak), platform 5228.
 */
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { generateHealthSpecs } from "../src/engine/health/specs.js";
import { generateSecuritySpecs } from "../src/engine/security/specs.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { modelFor, startChecksApp } from "./fixtures/checks-app.js";

const FIXTURE = "http://127.0.0.1:5224";
const PLATFORM_PORT = 5228;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;

let browser: Browser;
let page: Page;
let platform: Platform;
let worker: Worker;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let fixture: ChildProcess;

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: run `npm run build:web` first");
    fixture = await startChecksApp(5224, "weak");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-checksui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 200);
    worker.start();
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    fixture?.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Set CHECKS_SHOTS=<dir> to also save screenshots of what the tests look at (for a human to eyeball). */
const shot = async (name: string) => {
    if (process.env.CHECKS_SHOTS) await page.screenshot({ path: path.join(process.env.CHECKS_SHOTS, `${name}.png`), fullPage: true });
};

const api = async (method: "GET" | "POST", url: string, body?: unknown) => {
    const res = await fetch(`${BASE}/api${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
};

async function waitIdle(projectId: string) {
    for (let i = 0; i < 240; i++) {
        const jobs = (await api("GET", `/projects/${projectId}/jobs`)).body as Array<{ status: string }>;
        if (jobs.length && jobs.every((j) => ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status))) return;
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("job never finished");
}

describe("findings in the UI", () => {
    let projectId: string;

    beforeAll(async () => {
        projectId = (await api("POST", "/projects", { name: "Checks UI" })).body.id;
        const model = modelFor(FIXTURE, [{ path: "/", type: "home" }]);
        const drafts = [...generateHealthSpecs(model, { maxPages: 1 }), ...generateSecuritySpecs(model).filter((d) => /^(Secret|Session|Browser)/.test(d.title))];
        const res = await api("POST", `/projects/${projectId}/specs`, { specs: drafts, baseUrl: FIXTURE });
        expect(res.status).toBe(202);
        await waitIdle(projectId);
    }, 240_000);

    it("lists the checks in their own areas with their findings flagged", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/scripts`);
        await pwExpect(page.getByRole("heading", { name: "Scripts", exact: true })).toBeVisible();
        const health = page.locator("section.group", { hasText: "Health checks" });
        const security = page.locator("section.group", { hasText: "Security checks" });
        await pwExpect(health.locator(".script-row")).toHaveCount(1);
        await pwExpect(security.locator(".script-row")).toHaveCount(3);
        await pwExpect(health.getByText("1 not passing")).toBeVisible();
        const row = security.locator(".script-row", { hasText: "Secret and source-control" });
        await pwExpect(row.getByText("Critical severity")).toBeVisible();
        await pwExpect(row.locator(".sr-id")).toHaveText(/API-\d{3}/);
        await pwExpect(row.locator(".meta").first()).toContainText("Security"); // type label
        // the one-line reason is plain words: no raw severity tags, no internal check names
        const line = (await row.locator(".meta").last().innerText()).replace(/\s+/g, " ");
        expect(line).toMatch(/Security check: 2 sensitive files are publicly readable/);
        expect(line).not.toMatch(/\[critical\]|securityHeaders|noExposedFiles/);
        await shot("tests-tab");
    });

    it("shows a security finding with its severity, the problem, how to fix it and plain steps", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/scripts`);
        // A row opens its script on the DSL tab; this checks the test's own page (the bare route).
        const href = await page.locator("a.sr-title", { hasText: "Secret and source-control" }).getAttribute("href");
        expect(href).toMatch(/\/text$/);
        await page.goto(`${BASE}/${href!.replace(/\/text$/, "")}`);
        await pwExpect(page.getByText("This test found something that needs a look")).toBeVisible();
        await pwExpect(page.getByText("Critical severity: sensitive file readable by anyone.")).toBeVisible();
        const callout = page.locator(".callout", { hasText: "This test found something that needs a look" });
        await pwExpect(callout).toContainText("/.env can be downloaded by anyone");
        await pwExpect(callout).toContainText("Remove it from the web server");
        await pwExpect(callout).not.toContainText("[critical]");
        const steps = page.locator("ol.bld-steps > li.bld-step");
        await pwExpect(steps.last()).toContainText("None of these files can be read");
        await pwExpect(steps.last()).toHaveClass(/is-failed/);
        await pwExpect(steps.first()).toContainText("Request /.env (read-only)");
        await pwExpect(steps.first()).not.toHaveClass(/is-failed/);
        await shot("security-finding");
    });

    it("shows a health finding: every kind of problem on one page, worst severity first", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/scripts`);
        // A row opens its script on the DSL tab; this checks the test's own page (the bare route).
        const href = await page.locator("a.sr-title", { hasText: "Home page is healthy" }).getAttribute("href");
        expect(href).toMatch(/\/text$/);
        await page.goto(`${BASE}/${href!.replace(/\/text$/, "")}`);
        await pwExpect(page.getByText("High severity: request to the site failed.")).toBeVisible();
        const callout = page.locator(".callout", { hasText: "This test found something that needs a look" });
        await pwExpect(callout).toContainText("Page health check: 2 JavaScript errors were reported on this page");
        await pwExpect(callout).toContainText("GET /api/boom returned HTTP 500");
        await pwExpect(callout).toContainText("/missing-page returned HTTP 404");
        await pwExpect(callout).toContainText("How to fix:");
        const steps = page.locator("ol.bld-steps > li.bld-step");
        await pwExpect(steps).toHaveCount(6);
        await pwExpect(steps.nth(1)).toContainText("No JavaScript errors are reported");
        // navigation passed; script errors, failed requests and broken links failed; the rest passed
        for (const [i, failed] of [[0, false], [1, true], [2, true], [3, true], [4, false], [5, false]] as const) {
            if (failed) await pwExpect(steps.nth(i)).toHaveClass(/is-failed/);
            else await pwExpect(steps.nth(i)).not.toHaveClass(/is-failed/);
        }
        await pwExpect(page.getByTestId("test-meta")).toContainText("Health check"); // type label
        await shot("health-finding");
    });
});

describe("New project form", () => {
    it("has no check list: the exploration runs the usual checks, page health and basic security among them", async () => {
        // A port nothing listens on: the job is accepted (and its options stored) but ends at once.
        const dead = "http://127.0.0.1:5229/";
        await page.goto(`${BASE}/#/new?url=${encodeURIComponent(dead)}`);
        await pwExpect(page.getByLabel("Application URL")).toHaveValue(dead);
        // Round 37: a new project's name is always typed (a taken name is refused, so each form gets its own).
        await page.getByLabel("Project name").fill("Checks project 1");
        await pwExpect(page.getByRole("checkbox", { name: /Page health checks/ })).toHaveCount(0);
        await pwExpect(page.getByRole("checkbox", { name: /Basic security checks/ })).toHaveCount(0);
        await shot("new-project-options");

        const sent: Array<Record<string, unknown>> = [];
        await page.route("**/api/projects/*/test-generation", (route) => {
            sent.push(route.request().postDataJSON());
            return route.continue();
        });
        await page.getByRole("button", { name: "Start exploring" }).click();
        await page.waitForURL((u) => u.hash.startsWith("#/projects/"));
        await pwExpect.poll(() => sent.length).toBe(1);
        expect(sent[0]).not.toHaveProperty("healthChecks");
        expect(sent[0]).not.toHaveProperty("securityChecks");

        // and the job really runs them
        const projects = (await api("GET", "/projects")).body as Array<{ id: string; name: string }>;
        const options: Array<Record<string, unknown>> = [];
        for (const p of projects) for (const j of platform.repo.listJobs(p.id)) options.push(j.options as unknown as Record<string, unknown>);
        expect(options.some((o) => o.healthChecks === true && o.securityChecks === true)).toBe(true);
        for (const p of projects) await waitIdle(p.id).catch(() => undefined);
    }, 120_000);
});
