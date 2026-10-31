/**
 * One browser journey through storage, retention and backup in the real UI (platform on port 5750, no model):
 *  Settings -> Storage (sizes, bar, table by project) -> project page -> "Storage and backup" (usage, retention form, preview sentence,
 *  save, remove with a confirm dialog, files really gone) -> download a backup (a real zip without secrets) -> restore it as a new
 *  project (summary, what to enter again) -> a removed file's page says so -> axe-clean and no sideways scroll at phone width.
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/retention-ui.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { unzipSync } from "fflate";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { securityStoreFor } from "../src/security/store.js";
import { addRun, addTest, exists, seedProject, type Seed, type SeedFile } from "./fixtures/retention-seed.js";

const PORT = 5750;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = "LEAKCHECK-UiPassword-6c2d41";

let browser: Browser;
let context: BrowserContext;
let page: Page;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let seed: Seed;
const old: SeedFile[] = [];
const recent: SeedFile[] = [];

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-retention-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });

    seed = seedProject(platform, "Storage UI");
    platform.repo.createApplication(seed.projectId, `${BASE}/`, {}, { username: "ui@example.com", password: SECRET });
    const t = addTest(platform, seed, "The home page answers");
    for (const d of [100, 101, 102]) old.push(...addRun(platform, seed, t, { daysAgo: d, files: [{ kind: "video", size: 40_000 }, { kind: "screenshot", size: 4000 }] }).files);
    recent.push(...addRun(platform, seed, t, { daysAgo: 1, files: [{ kind: "screenshot", size: 4000 }] }).files);

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    page = await context.newPage();
}, 60_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const card = () => page.getByRole("region", { name: "Storage and backup", exact: true });

describe("storage, retention and backup in the UI", () => {
    it("Settings shows what the platform uses, by kind of file and by project", async () => {
        await page.goto(`${BASE}/#/settings`);
        const section = page.getByRole("region", { name: "Storage", exact: true });
        await pwExpect(section.getByRole("heading", { name: "Storage", exact: true })).toBeVisible();
        await pwExpect(section.getByText("Test files use", { exact: false })).toBeVisible();
        await pwExpect(section.getByRole("img", { name: /Test files by kind/ })).toBeVisible();
        await pwExpect(section.getByRole("list", { name: "Files by kind" }).getByText("Recordings", { exact: true })).toBeVisible();
        await pwExpect(section.getByRole("link", { name: "Storage UI", exact: true })).toBeVisible();
        await pwExpect(section.getByRole("cell", { name: "Kept", exact: true }).first()).toBeVisible();
        const scan = await new AxeBuilder({ page }).include("[aria-label='Storage']").analyze();
        expect(scan.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    });

    it("the project page shows usage and a retention form that is off by default", async () => {
        // Storage and backup is in the project's Settings now, a titled row with a summary; the form opens with "Change".
        await page.goto(`${BASE}/#/projects/${seed.projectId}/settings?section=storage`);
        await pwExpect(page.getByTestId("setting-storage")).toContainText("This project’s files use");
        await page.getByRole("button", { name: "Change storage and backup", exact: true }).click();
        await pwExpect(card().getByRole("heading", { name: "Storage and backup", exact: true })).toBeVisible();
        await pwExpect(card().getByTestId("storage-summary")).toContainText("This project’s files use");
        await pwExpect(card().getByText("Old files are kept", { exact: true })).toBeVisible();
        await pwExpect(card().getByLabel("Remove old files automatically")).not.toBeChecked();
        await pwExpect(card().getByRole("button", { name: "Remove old files now", exact: true })).toBeDisabled();
        await pwExpect(card().getByText("Turn on automatic removal and save to remove files.", { exact: true })).toBeVisible();
    });

    it("a preview says what would go and removes nothing; invalid values are explained", async () => {
        await card().getByLabel("Always keep the latest runs of each test").fill("1");
        await card().getByRole("button", { name: "Preview", exact: true }).click();
        const sentence = card().getByText(/^This would remove 6 files \(/);
        await pwExpect(sentence).toBeVisible();
        await pwExpect(sentence).toContainText("older than 30 days (90 for failed runs)");
        expect(old.every(exists)).toBe(true);

        await card().getByLabel("Keep files of passed runs for (days)").fill("3");
        await card().getByRole("button", { name: "Preview", exact: true }).click();
        await pwExpect(card().getByRole("alert")).toContainText("at least 7");
        await card().getByLabel("Keep files of passed runs for (days)").fill("30");
    });

    it("turning it on and saving still removes nothing; removing asks first, and Cancel keeps the files", async () => {
        await card().getByLabel("Remove old files automatically").check();
        await card().getByRole("button", { name: "Save settings", exact: true }).click();
        await pwExpect(card().getByText(/^Saved\. Old files will be removed once a day/)).toBeVisible();
        expect(old.every(exists)).toBe(true);
        await card().getByRole("button", { name: "Remove old files now", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Remove old files?" });
        await pwExpect(dialog).toBeVisible();
        await pwExpect(dialog.getByText(/^This would remove 6 files/)).toBeVisible();
        const scan = await new AxeBuilder({ page }).include("dialog").analyze();
        expect(scan.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await pwExpect(dialog).toBeHidden();
        expect(old.every(exists)).toBe(true);
    });

    it("confirming removes exactly those files from the disk and says so", async () => {
        await card().getByRole("button", { name: "Remove old files now", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Remove old files?" });
        await dialog.getByRole("button", { name: /^Remove 6 files/ }).click();
        await pwExpect(card().getByText(/^Removed 6 files \([^)]*\)\.$/)).toBeVisible();
        expect(old.some(exists)).toBe(false);
        expect(recent.every(exists)).toBe(true);
        await pwExpect(card().getByTestId("storage-summary")).toContainText("6 files");
        await card().getByText("Recent clean-ups", { exact: true }).click();
        await pwExpect(card().getByText(/^Removed 6 files \(.*\), by you/)).toBeVisible();
    });

    it("a removed file answers with a plain sentence instead of a broken download", async () => {
        const res = await fetch(`${BASE}/api/artifacts/${old[0]!.id}`);
        expect(res.status).toBe(410);
        expect(((await res.json()) as { error: string }).error).toMatch(/^This (recording|screenshot) was removed to save space on /);
    });

    it("Download backup saves a real zip with no secret in it", async () => {
        const [download] = await Promise.all([page.waitForEvent("download"), card().getByRole("button", { name: "Download backup", exact: true }).click()]);
        expect(download.suggestedFilename()).toMatch(/^backup-storage-ui-\d{4}-\d{2}-\d{2}\.zip$/);
        const file = path.join(dataDir, "ui-backup.zip");
        await download.saveAs(file);
        const entries = unzipSync(new Uint8Array(fs.readFileSync(file)));
        expect(Object.keys(entries)).toContain("manifest.json");
        for (const [name, bytes] of Object.entries(entries)) expect(Buffer.from(bytes).toString("latin1"), name).not.toContain(SECRET);
        expect(Buffer.from(fs.readFileSync(file)).includes("ui@example.com")).toBe(false);
        await pwExpect(card().getByText(/^The backup was downloaded/)).toBeVisible();
    });

    it("Restore creates a new project, says what to enter again, and runs nothing", async () => {
        const file = path.join(dataDir, "ui-backup.zip");
        await page.locator("#st-restore").setInputFiles(file);
        await card().getByRole("button", { name: "Restore as a new project", exact: true }).click();
        const done = card().getByText(/^Restored 1 test into a new project, “Storage UI \(restored\)”/);
        await pwExpect(done).toBeVisible();
        await pwExpect(card().getByText(/Enter these again: .*Sign-in details for the application/)).toBeVisible();
        const projects = (await (await fetch(`${BASE}/api/projects`)).json()) as Array<{ id: string; name: string }>;
        const copy = projects.find((p) => p.name === "Storage UI (restored)")!;
        expect(projects.filter((p) => p.name === "Storage UI")).toHaveLength(1);
        await card().getByRole("link", { name: "Open the new project", exact: true }).click();
        await page.waitForURL(`**/#/projects/${copy.id}`);
        // The Dashboard says it needs a person; the form and the "I have entered them" button are in Settings > Storage and backup.
        await pwExpect(page.getByText("Some details need entering again", { exact: true })).toBeVisible();
        await page.getByRole("link", { name: "Open Storage and backup", exact: true }).click();
        await page.getByRole("button", { name: "Change storage and backup", exact: true }).click();
        await pwExpect(card().getByLabel("Remove old files automatically")).not.toBeChecked();
        await pwExpect(card().getByText(/Sign-in details for the application/)).toBeVisible();
        await card().getByRole("button", { name: "I have entered them", exact: true }).click();
        await pwExpect(card().getByText("Enter these again, they are not in a backup", { exact: true })).toBeHidden();
        const tests = (await (await fetch(`${BASE}/api/projects/${copy.id}/tests`)).json()) as Array<{ validationStatus: string }>;
        expect(tests.every((t) => t.validationStatus === "PENDING")).toBe(true);
    });

    it("refuses a file that is not a backup, in words", async () => {
        await page.goto(`${BASE}/#/projects/${seed.projectId}/settings?section=storage`);
        await page.getByRole("button", { name: "Change storage and backup", exact: true }).click();
        const bad = path.join(dataDir, "not-a-backup.zip");
        fs.writeFileSync(bad, "this is not a zip file");
        await page.locator("#st-restore").setInputFiles(bad);
        await card().getByRole("button", { name: "Restore as a new project", exact: true }).click();
        await pwExpect(card().getByRole("alert")).toContainText("does not look like a backup");
    });

    // Round 21 (FX-S): a project with security assessment data can be backed up without it, for a platform from before round 20.
    it("offers to leave out the security assessment data only when the project has some; the download has none and is recorded", async () => {
        await pwExpect(card().getByLabel("Leave out the security assessment data")).toHaveCount(0);
        securityStoreFor(platform.db).createApplication(seed.projectId, { name: "Shop", targetUrl: "https://shop.example.com/", environment: "staging" });
        await page.reload();
        await page.getByRole("button", { name: "Change storage and backup", exact: true }).click();
        const leaveOut = card().getByLabel("Leave out the security assessment data");
        await pwExpect(leaveOut).not.toBeChecked();
        await leaveOut.check();
        const [download] = await Promise.all([page.waitForEvent("download"), card().getByRole("button", { name: "Download backup", exact: true }).click()]);
        const file = path.join(dataDir, "ui-backup-older.zip");
        await download.saveAs(file);
        const entries = unzipSync(new Uint8Array(fs.readFileSync(file)));
        expect(Object.keys(entries)).toContain("tests.json");
        expect(Object.keys(entries)).not.toContain("security.json");
        const trail = platform.db.all<{ action: string }>("SELECT action FROM security_audit WHERE project_id = ?", seed.projectId).map((r) => r.action);
        expect(trail).toContain("project.backup-without-security");
        // Without the tick the backup carries it, as before.
        await leaveOut.uncheck();
        const [full] = await Promise.all([page.waitForEvent("download"), card().getByRole("button", { name: "Download backup", exact: true }).click()]);
        const fullFile = path.join(dataDir, "ui-backup-full.zip");
        await full.saveAs(fullFile);
        expect(Object.keys(unzipSync(new Uint8Array(fs.readFileSync(fullFile))))).toContain("security.json");
    });

    it("is axe-clean on the project page and fits a phone screen without sideways scrolling", async () => {
        await page.goto(`${BASE}/#/projects/${seed.projectId}/settings?section=storage`);
        await page.reload(); // the same address again: start from the closed row
        await page.getByRole("button", { name: "Change storage and backup", exact: true }).click();
        await pwExpect(card()).toBeVisible();
        const scan = await new AxeBuilder({ page }).include("[aria-label='Storage and backup']").analyze();
        expect(scan.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
        for (const route of [`#/projects/${seed.projectId}`, `#/projects/${seed.projectId}/settings?section=storage`, "#/settings"]) {
            await page.setViewportSize({ width: 375, height: 800 });
            await page.goto(`${BASE}/${route}`);
            await page.waitForTimeout(300);
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            expect(overflow, route).toBeLessThanOrEqual(1);
        }
        await page.setViewportSize({ width: 1280, height: 900 });
    });
});
