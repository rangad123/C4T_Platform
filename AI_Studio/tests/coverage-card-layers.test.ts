/**
 * Phase 4 T26: the "Checked layers" line in a finished exploration's card "How the exploration went" (ObjectivesPanel.tsx, layers.ts).
 * The pure line: each checked layer with its tests (and the database's checks), each other layer with why. In a real browser against a
 * real platform: a finished exploration with a layer report (the job's `layer-report` artifact, as job-runner.ts saves it) shows the
 * line, also without a coverage record; an exploration from before has no line; a report that is not one is not shown. Axe in light
 * and dark, no sideways scroll at phone width.
 *
 * Requires web/dist (build inside the lock):
 *   node scripts/with-lock.mjs build,browser -- sh -c "npx vite build web && npx vitest run tests/coverage-card-layers.test.ts"
 * Port 9891. SHOTS_DIR=<dir> saves screenshots at desktop and phone widths.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { layerReport } from "../src/engine/validation/layers.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { putText } from "../src/platform/object-store.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { layersLine } from "../web/src/features/runs/layers.js";

const PORT = 9891;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS_DIR;

/** A run that made page, API and database tests, with data changes on, and no stored-data read-back. */
const REPORT = layerReport({ page: 4, api: 6, database: 2 }, { web: true, api: true, apiEndpoints: 9, dataChanges: true, database: { checks: 7 } });
/** A run without database access set up. */
const NO_DB = layerReport({ page: 1, api: 1 }, { web: true, api: true, apiEndpoints: 3, dataChanges: false });

describe("the line (no browser)", () => {
    it("names each checked layer with its tests and each other layer with why", () => {
        expect(layersLine(REPORT)).toEqual({ checked: "Page (4 tests), API (6 tests), Database (2 tests, 7 checks)", notChecked: [{ layer: "Stored data", reason: "no write was read back through the API." }] });
        expect(layersLine(NO_DB)).toEqual({
            checked: "Page (1 test), API (1 test)",
            notChecked: [
                { layer: "Stored data", reason: "data changes are off, so nothing is written and read back." },
                { layer: "Database", reason: "no read-only database access is set up." },
            ],
        });
        expect(layersLine(layerReport({}, { web: false, api: false, apiEndpoints: 0, dataChanges: false })).checked).toBe("None");
    });
});

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let browser: Browser;
let page: Page;
let projectId: string;
const jobs: Record<string, string> = {};
const consoleErrors: string[] = [];

async function finishedRun(layers?: string): Promise<string> {
    const appId = platform.repo.createApplication(projectId, "https://shop.example.test", { ...DEFAULT_JOB_OPTIONS });
    const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "generate" });
    platform.repo.setJobStatus(job.id, "COMPLETED");
    if (layers !== undefined) {
        const rel = path.posix.join(projectId, "_artifacts", job.id, "layers.json");
        const saved = await putText(platform.store, rel, layers);
        platform.repo.addArtifact({ projectId, jobId: job.id, kind: "layer-report", path: rel, size: saved.size });
    }
    return job.id;
}

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-coverage-layers-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "coverage-layers-secret-0123456789", HOST: "127.0.0.1", PORT: String(PORT), WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    const res = await fetch(`${BASE}/api/projects`, { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "ai-studio" }, body: JSON.stringify({ name: "Layer shop", platforms: ["web"], testingModes: ["code"] }) });
    projectId = ((await res.json()) as { id: string }).id;
    jobs.layers = await finishedRun(JSON.stringify(REPORT));
    jobs.older = await finishedRun();
    jobs.broken = await finishedRun(JSON.stringify({ page: { status: "ran", tests: 1, rows: ["user@example.test"] } }));

    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    await page.route("**/api/me/runner", (route) => route.fulfill({ json: { runner: null } }));
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const openRun = async (jobId: string) => {
    await page.goto("about:blank");
    await page.goto(`${BASE}/#/projects/${projectId}/runs/${jobId}`);
    await pwExpect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 20_000 });
};
const line = () => page.getByTestId("run-checked-layers");

describe("on a finished exploration's page", () => {
    it("shows Checked layers with the tests per layer, and why a layer was not checked", async () => {
        const api = (await (await fetch(`${BASE}/api/projects/${projectId}/jobs/${jobs.layers}/coverage`)).json()) as { available: boolean; layers?: unknown };
        expect(api).toMatchObject({ available: false, layers: REPORT });
        await openRun(jobs.layers!);
        await pwExpect(line()).toContainText("Checked layers: Page (4 tests), API (6 tests), Database (2 tests, 7 checks)");
        await pwExpect(line().getByRole("list", { name: "Layers not checked" })).toHaveText("Stored data: not checked, no write was read back through the API.");
        // This project does not explore by objectives: no coverage record, and no sentence about one.
        await pwExpect(page.getByTestId("run-coverage-unavailable")).toHaveCount(0);
        if (SHOTS) {
            await page.getByTestId("run-coverage").screenshot({ path: path.join(SHOTS, "checked-layers-desktop.png") });
            await page.setViewportSize({ width: 375, height: 800 });
            await page.waitForTimeout(300);
            await page.getByTestId("run-coverage").screenshot({ path: path.join(SHOTS, "checked-layers-phone.png") });
            await page.setViewportSize({ width: 1280, height: 900 });
        }
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.waitForTimeout(300);
            const r = await new AxeBuilder({ page }).include('[data-testid="run-coverage"]').withTags(["wcag2a", "wcag2aa"]).analyze();
            expect(r.violations.map((v) => `${scheme}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
        }
        await page.emulateMedia({ colorScheme: "light" });
        await page.setViewportSize({ width: 375, height: 800 });
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        await page.setViewportSize({ width: 1280, height: 900 });
    }, 90_000);

    it("an exploration from before, or one whose report is not a layer report, has no line", async () => {
        for (const j of [jobs.older!, jobs.broken!]) {
            const api = (await (await fetch(`${BASE}/api/projects/${projectId}/jobs/${j}/coverage`)).json()) as Record<string, unknown>;
            expect(api.layers).toBeUndefined();
            await openRun(j);
            await page.waitForTimeout(1000);
            await pwExpect(line()).toHaveCount(0);
        }
        expect(consoleErrors).toEqual([]);
    }, 60_000);
});
