/**
 * Smaller page snapshots, the platform side: the switch's routes (GET/PUT /api/llm/compact-snapshots, saved in Settings, wins over
 * LLM_COMPACT_SNAPSHOTS), the per-job usage answer counting what the snapshots saved (from the job's events), and one browser journey in
 * Settings, AI model (the checkbox, saved and handed back to the server; axe-clean in light and dark; fits a phone). No model is called. Port 7316.
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/snapshot-settings.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { SnapshotView, snapshotSavingsEvent } from "../src/engine/snapshots/compact.js";
import { compactSnapshotSetting, setCompactSnapshotSource } from "../src/engine/snapshots/setting.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 7316;
const base = `http://127.0.0.1:${PORT}`;
let dataDir: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let page: Page;

const call = async (method: "GET" | "PUT", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.json() as any };
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-snapshots-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", LLM_MODEL: "claude-sonnet-5-5", LLM_API_KEY: "fake-key-never-used", LLM_COMPACT_SNAPSHOTS: "off", HOST: "127.0.0.1", PORT: String(PORT), SECRET_KEY: "test-secret-key-0123456789" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    setCompactSnapshotSource(undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("the switch's routes", () => {
    it("GET/PUT /api/llm/compact-snapshots: the server's setting, a saved choice that wins, and back to the server's", async () => {
        expect((await call("GET", "/api/llm/compact-snapshots")).body).toEqual({ enabled: false, source: "environment", environment: false });
        const on = await call("PUT", "/api/llm/compact-snapshots", { enabled: true });
        expect(on.body).toEqual({ enabled: true, source: "app", environment: false });
        // The engine of this process reads the same choice.
        expect(compactSnapshotSetting(platform.config)).toEqual({ enabled: true, source: "app" });
        expect((await call("PUT", "/api/llm/compact-snapshots", { enabled: null })).body).toEqual({ enabled: false, source: "environment", environment: false });
        expect((await call("PUT", "/api/llm/compact-snapshots", { enabled: "yes" })).status).toBe(400);
        expect((await call("PUT", "/api/llm/compact-snapshots", { enabled: true, extra: 1 })).status).toBe(400);
    });

    it("a job's usage counts what smaller snapshots saved, and says nothing for a job that did not use them", async () => {
        const projectId = platform.repo.createProject({ name: "Snapshot shop" }).id as string;
        const app = platform.repo.createApplication(projectId, "http://example.test", { ...DEFAULT_JOB_OPTIONS }, undefined);
        const job = await platform.repo.createJob(projectId, app, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] });
        const plain = await platform.repo.createJob(projectId, app, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] });
        const view = new SnapshotView();
        const big = ["- main:", ...Array.from({ length: 40 }, (_, i) => `  - listitem:\n    - link "Item ${i}":\n      - /url: /item/${i}\n    - button "Add"`)].join("\n");
        view.show("http://example.test/", big, 9_000);
        view.modelStep();
        view.show("http://example.test/", big, 7_000);
        view.modelStep();
        const ev = snapshotSavingsEvent("S-001", view.totals);
        platform.repo.addEvent(job.id, ev);
        platform.repo.addEvent(job.id, snapshotSavingsEvent("S-002", view.totals));
        const u = (await call("GET", `/api/jobs/${job.id}/usage`)).body;
        const saved = 2 * (ev.data!.savedTokens as number);
        expect(u.snapshotSavings).toMatchObject({ sessions: 2, savedTokens: saved, wholePageLooks: 0 });
        expect(u.snapshotSavings.summary).toBe(`Smaller page snapshots saved about ${saved.toLocaleString("en-US")} tokens (${Math.round((saved / u.snapshotSavings.baselineTokens) * 100)}% of the snapshot text)`);
        expect((await call("GET", `/api/jobs/${plain.id}/usage`)).body.snapshotSavings).toBeNull();
    });
});

const setting = () => page.getByTestId("compact-snapshots-setting");
const openSettings = async () => {
    await page.goto(`${base}/#/settings`);
    await page.reload();
    await pwExpect(setting()).toBeVisible();
};

describe("Settings, AI model", () => {
    it("shows the switch as the server sets it, saves a choice here, and hands it back to the server", async () => {
        await openSettings();
        const box = setting().getByRole("checkbox", { name: /Send smaller page snapshots to the AI/ });
        await pwExpect(box).not.toBeChecked();
        await pwExpect(setting().getByTestId("compact-snapshots-source")).toHaveText("Taken from the server’s settings (LLM_COMPACT_SNAPSHOTS).");

        await box.check();
        await pwExpect(box).toBeChecked();
        await pwExpect(setting().getByTestId("compact-snapshots-source")).toContainText("Saved here.");
        expect((await call("GET", "/api/llm/compact-snapshots")).body).toMatchObject({ enabled: true, source: "app" });
        await page.reload();
        await pwExpect(setting().getByRole("checkbox")).toBeChecked();

        await setting().getByRole("button", { name: "Use the server’s setting (off)", exact: true }).click();
        await pwExpect(setting().getByRole("checkbox")).not.toBeChecked();
        expect((await call("GET", "/api/llm/compact-snapshots")).body).toMatchObject({ enabled: false, source: "environment" });
    }, 60_000);

    it("has no serious accessibility problems in light or dark, and fits a phone", async () => {
        await openSettings();
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.waitForTimeout(400); // colours ease over 140ms when the scheme flips; audit the settled state
            const result = await new AxeBuilder({ page }).include('[data-testid="compact-snapshots-setting"]').analyze();
            expect(result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.help}`), scheme).toEqual([]);
        }
        await page.emulateMedia({ colorScheme: "light" });
        const row = await setting().locator("label.check").boundingBox();
        expect(row!.height).toBeGreaterThanOrEqual(44);
        await page.setViewportSize({ width: 375, height: 800 });
        await openSettings();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        const box = await setting().boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    }, 60_000);
});
