/**
 * The Schedule panel of a security application (web/src/features/security/SchedulePanel.tsx) against the real platform: off until set,
 * a weekly time saved and shown in UTC with its maker, switched off again, and no axe violation in light and dark. Requires web/dist:
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/security-schedule-ui.test.ts
 * Port 9591. No application is requested (nothing is assessed here).
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
import { buildServer } from "../src/platform/server.js";

const PORT = 9591;
const BASE = `http://localhost:${PORT}`;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let page: Page;
let dataDir: string;
let projectId: string;
let appId: string;

const json = async (method: string, url: string, body?: unknown) => {
    const r = await fetch(`${BASE}${url}`, { method, headers: body ? { "content-type": "application/json" } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sec-sched-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    projectId = (await json("POST", "/api/projects", { name: "Schedules" })).body.id;
    expect((await json("PUT", `/api/v1/security/projects/${projectId}/testing-type`, { testingType: "both" })).status).toBe(200);
    appId = (await json("POST", `/api/v1/security/projects/${projectId}/applications`, { name: "Shop", targetUrl: "https://shop.example.com/", environment: "staging", scope: [], excludedPaths: [], maxRequestsPerSecond: 2, notes: "" })).body.application.id;
    const auth = await json("POST", `/api/v1/security/applications/${appId}/authorizations`, { basis: "client-permission", approverName: "Dana Client", approverRole: "Head of Engineering", approverEmail: "dana@client.example", documentReference: "SOW-12", authority: "Signed SOW-12 for the application's owner.", restrictions: "", confirm: true });
    expect(auth.status).toBe(201);
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const axe = async (scheme: "light" | "dark") => {
    await page.emulateMedia({ colorScheme: scheme });
    const r = await new AxeBuilder({ page }).include('[data-testid="sa-schedule"]').analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.help}`), scheme).toEqual([]);
};

describe("the Schedule panel", () => {
    it("is off until set, saves a weekly time in UTC with its maker, and switches off again", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/security/applications/${appId}`);
        const panel = page.getByTestId("sa-schedule");
        await pwExpect(panel).toBeVisible({ timeout: 15_000 }).catch(async (e) => {
            throw new Error(`${e}\nPage: ${(await page.locator("main").innerText().catch(() => "")).slice(0, 600)}`);
        });
        await pwExpect(panel).toContainText("always passive");
        await pwExpect(page.getByTestId("sa-schedule-words")).toHaveText("Off");
        await axe("light");

        await panel.getByLabel("How often").selectOption("weekly");
        await panel.getByLabel("Day").selectOption("1");
        await panel.getByLabel("Time (UTC)").fill("03:30");
        await panel.getByRole("button", { name: "Save schedule" }).click();
        await pwExpect(panel).toContainText("Saved. Scheduled assessments run in your name.");
        await pwExpect(page.getByTestId("sa-schedule-words")).toContainText("Every Monday at 03:30 UTC");
        await pwExpect(page.getByTestId("sa-schedule-words")).toContainText("set by");
        expect((await json("GET", `/api/v1/security/applications/${appId}/schedule`)).body.schedule).toMatchObject({ enabled: true, cadence: { type: "weekly", weekday: 1, time: "03:30" } });
        await axe("dark");

        await panel.getByLabel("How often").selectOption("off");
        await panel.getByRole("button", { name: "Save schedule" }).click();
        await pwExpect(panel).toContainText("The schedule is off.");
        await pwExpect(page.getByTestId("sa-schedule-words")).toHaveText("Off");
        expect((await json("GET", `/api/v1/security/applications/${appId}/schedule`)).body.schedule.enabled).toBe(false);
    }, 120_000);

    it("fits a phone screen without sideways scrolling", async () => {
        await page.setViewportSize({ width: 375, height: 800 });
        await page.goto(`${BASE}/#/projects/${projectId}/security/applications/${appId}`);
        await pwExpect(page.getByTestId("sa-schedule")).toBeVisible();
        const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        expect(wide).toBe(false);
    }, 60_000);
});
