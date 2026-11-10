/**
 * The Run control for a person who may look at a project but not run its tests (no ai_studio.tests.run there): Run is shown switched
 * off with the reason, reachable by keyboard, instead of a button that only answers with a refusal. The project's answer is stood in
 * for with a browser route (the server sends the same `access` field for a Crowd4Test customer); the server's own refusal is
 * covered by the permission tests. Port 8660. Requires `web/dist` (vite build).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { NO_RUN_PERMISSION } from "../web/src/features/runs/runs-here.js";

const PORT = 8660;
const BASE = `http://localhost:${PORT}`;
let browser: Browser;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir = "";
let projectId = "";
let runStarts = 0;

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-run-perm-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    projectId = platform.repo.createProject({ name: "Look only shop" }).id as string;
    browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

async function openRuns(permissions: string[]): Promise<Page> {
    const page = await (await browser.newContext()).newPage();
    await page.route(`**/api/projects/${projectId}`, async (route) => {
        // A read still on its way when the test closes the page has nobody to answer: let it go.
        try {
            const res = await route.fetch();
            const body = (await res.json()) as Record<string, unknown>;
            await route.fulfill({ response: res, json: { ...body, access: { projectAdmin: false, permissions } } });
        } catch {
            /* the page was closed */
        }
    });
    await page.route(`**/api/projects/${projectId}/runs`, (route) => {
        if (route.request().method() === "POST") runStarts++;
        return route.continue();
    });
    await page.goto(`${BASE}/#/projects/${projectId}/runs`);
    await pwExpect(page.getByRole("heading", { name: "All runs" })).toBeVisible();
    return page;
}

describe("Run for a person without permission to run tests", () => {
    it("is switched off and says why, and starts nothing", async () => {
        const page = await openRuns(["ai_studio.access", "ai_studio.reports.export"]);
        const run = page.getByRole("button", { name: "Run", exact: true });
        await pwExpect(run).toHaveAttribute("aria-disabled", "true");
        await run.focus();
        await pwExpect(page.getByText(NO_RUN_PERMISSION)).toBeVisible();
        await run.click({ force: true });
        await pwExpect(page.locator(".run-pop")).toHaveCount(0);
        expect(runStarts).toBe(0);
        await page.context().close();
    });

    it("stays available to a person who may run tests", async () => {
        const page = await openRuns(["ai_studio.access", "ai_studio.tests.run"]);
        const run = page.getByRole("button", { name: "Run", exact: true });
        await pwExpect(run).toBeVisible();
        await pwExpect(run).not.toHaveAttribute("aria-disabled", "true");
        await page.context().close();
    });
});
