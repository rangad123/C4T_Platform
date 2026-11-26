/**
 * Importing the test case workbook on a code project's Test cases tab (founder 2026-11-19, SPEC R6.4; task C7), in a real browser
 * against the real platform (no model):
 *   - Import takes only the workbook (.xlsx): no CSV, and no JSON (F3 L2: JSON stays in the API, for backups); its tooltip names the workbook;
 *   - Export is one button that downloads the test case workbook (FX16); a list of 5,000 test cases shows quickly (FX15);
 *   - the reply is said plainly: created, already here, skipped rows with their reason, steps ignored on Automated rows;
 *   - a refusal is shown as the server's sentence (a workbook without a Test cases sheet; a CSV or JSON file, which is not a workbook);
 *   - an imported case shows its page, preconditions and expected result in the edit form; the New test case form offers them too;
 *   - no axe violations, no sideways scrolling on a phone, in light and dark.
 *
 * Set CASE_IMPORT_SHOTS=<folder> to write screenshots there. Port 5738. Needs a web build; run under the browser lock:
 *   TAQWRIGHT_HOME=/nonexistent-taqwright node scripts/with-lock.mjs browser -- npx vitest run tests/case-import-ui.test.ts
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { readTable } from "../src/engine/manual/xlsx-read.js";
import { buildXlsx } from "../src/shared/xlsx.js";
import { seedProject, type Seed } from "./fixtures/dashboard-seed.js";

const PORT = 5738;
const BASE = `http://127.0.0.1:${PORT}`;
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const HEADER = ["ID", "Title", "Type", "Priority", "Page", "Preconditions", "Steps", "Expected result", "Requirement"];
const ROWS = [
    ["TC-001", "Sign in with a valid password", "Automated", "High", "/login", "An account exists\nIt is active", "", "The account page opens", ""],
    ["TC-002", "Add an item to the basket", "Automated", "Medium", "/shop", "", "", "The basket shows 1 item", ""],
    ["TC-003", "The logo looks sharp on a large screen", "Manual", "Low", "/", "", "Open the home page => The logo is sharp", "", ""],
];

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let page: Page;
let dir = "";
let shop: Seed;
const consoleErrors: string[] = [];
const casesUrl = () => `${BASE}/#/projects/${shop.projectId}/tests`;
const workbook = (rows: string[][], sheet = "Test cases") => Buffer.from(buildXlsx([{ name: sheet, header: true, rows: [HEADER, ...rows] }]));
const choose = (name: string, mimeType: string, buffer: Buffer) => page.locator('input[type="file"]').setInputFiles({ name, mimeType, buffer });
/** The tooltip on show (it is aria-hidden: the control describes itself with it through aria-describedby). */
const openTip = () => page.locator('[role="tooltip"].is-open');
const casesNow = async () => JSON.parse((await server.inject({ method: "GET", url: `/api/projects/${shop.projectId}/manual-cases` })).body).cases as Array<{ title: string }>;

/** The same state at desktop and phone width, in light and dark: no axe violation, no sideways scrolling, a screenshot of each. */
async function everyLook(name: string) {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        for (const [width, height, label] of [[1280, 900, "desktop"], [390, 844, "phone"]] as const) {
            await page.setViewportSize({ width, height });
            await page.waitForTimeout(500); // colours ease over 140ms when the scheme flips; check the settled state
            const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            expect(over, `${name} ${label} ${scheme}`).toBeLessThanOrEqual(0);
            const result = await new AxeBuilder({ page }).analyze();
            expect(result.violations.map((v) => `${name} ${label} ${scheme}: ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
            if (process.env.CASE_IMPORT_SHOTS) await page.screenshot({ path: path.join(process.env.CASE_IMPORT_SHOTS, `${name}-${label}-${scheme}.png`), fullPage: true });
        }
    }
    await page.emulateMedia({ colorScheme: null });
    await page.setViewportSize({ width: 1280, height: 900 });
}

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    if (process.env.CASE_IMPORT_SHOTS) fs.mkdirSync(process.env.CASE_IMPORT_SHOTS, { recursive: true });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-case-import-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    shop = seedProject(platform, "Atlas shop", "https://atlas.example.test");
    platform.repo.updateProject(shop.projectId, { testingModes: ["code"] });

    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    // The refused imports are expected 400 and 410 answers (the browser logs every failed request as a console error).
    page.on("console", (m) => m.type() === "error" && !/status of 4(00|10)/.test(m.text()) && consoleErrors.push(m.text()));
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
}, 90_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Import on the Test cases tab", () => {
    it("takes only the workbook, not CSV or JSON, and its tooltip names the workbook", async () => {
        await page.goto(casesUrl());
        await pwExpect(page.getByRole("heading", { name: "No test cases yet" })).toBeVisible();
        const accept = (await page.locator('input[type="file"]').getAttribute("accept")) ?? "";
        expect(accept.split(",")).toEqual(expect.arrayContaining([".xlsx"]));
        expect(accept).not.toMatch(/csv|json/i);
        await page.getByRole("button", { name: "Import", exact: true }).hover();
        await pwExpect(openTip()).toContainText("The test case workbook (.xlsx) that Export here or a Test Case Generation project downloads");
    });

    it("says what it imported, and an imported Automated case shows its page, preconditions and expected result", async () => {
        await choose("Atlas shop test cases.xlsx", XLSX, workbook(ROWS));
        const notice = page.getByText("Imported 3 test cases.", { exact: true });
        await pwExpect(notice).toBeVisible();
        await pwExpect(page.getByRole("heading", { name: "Test cases (3)" })).toBeVisible();
        await pwExpect(page.getByRole("list", { name: "Rows that were not imported" })).toHaveCount(0);
        await everyLook("import-success");
        if (process.env.CASE_IMPORT_SHOTS) await page.screenshot({ path: path.join(process.env.CASE_IMPORT_SHOTS, "import-done.png"), fullPage: true });

        await page.getByRole("link", { name: "Sign in with a valid password", exact: true }).click();
        const form = page.getByRole("form", { name: "Edit test case" });
        await pwExpect(form.getByLabel("Preconditions (optional)")).toHaveValue("An account exists\nIt is active");
        await pwExpect(form.getByLabel("Expected result (optional)")).toHaveValue("The account page opens");
        // The page is with the area, opened because the case has one.
        await pwExpect(form.getByLabel("Page (optional)")).toHaveValue("/login");
        await everyLook("imported-case");

        // An edit sends the fields as they are in the form.
        await form.getByLabel("Expected result (optional)").fill("The account page opens\nIts name shows");
        await form.getByRole("button", { name: "Save changes" }).click();
        await pwExpect(page.getByText("Saved TC-001 “Sign in with a valid password”.")).toBeVisible();
        const saved = JSON.parse((await server.inject({ method: "GET", url: `/api/projects/${shop.projectId}/manual-cases` })).body).cases[0];
        expect(saved).toMatchObject({ preconditions: ["An account exists", "It is active"], expected: "The account page opens\nIts name shows", page: "/login", sourceRef: "TC-001" });
    });

    it("names what was already here and the rows it skipped with their reason; an Automated row's steps are imported (owner decision 2026-11-26)", async () => {
        await page.goto("about:blank");
        await page.goto(casesUrl());
        await pwExpect(page.getByRole("heading", { name: "Test cases (3)" })).toBeVisible();
        await choose(
            "Atlas shop test cases.xlsx",
            XLSX,
            workbook([
                ...ROWS,
                ["TC-004", "Search finds a product", "Automated", "High", "/shop", "", "Type a name => It is listed", "The product is listed", ""],
                ["TC-005", "Sort by price", "Automated", "Urgent", "/shop", "", "", "", ""],
            ]),
        );
        await pwExpect(
            page.getByText(
                "Imported 1 test case. 3 test cases were already here and left out. 1 row could not be imported.",
                { exact: true },
            ),
        ).toBeVisible();
        await pwExpect(page.getByRole("list", { name: "Rows that were not imported" })).toHaveText("Row 6: Priority “Urgent” is not one of critical, high, medium or low");
        await pwExpect(page.getByRole("heading", { name: "Test cases (4)" })).toBeVisible();
        await everyLook("import-partial");
    });

    it("shows a refusal as the server's sentence, and imports nothing", async () => {
        await choose("Other workbook.xlsx", XLSX, workbook(ROWS, "Sheet1"));
        const alert = page.getByRole("alert");
        await pwExpect(alert).toContainText("Nothing was imported");
        await pwExpect(alert).toContainText("The workbook has no sheet named “Test cases”. Its sheets are “Sheet1”. Import the test case workbook, whose first sheet is “Test cases”.");
        await everyLook("import-refused");
        expect(await casesNow()).toHaveLength(4);

        // A CSV file (from before the workbook) or a JSON backup chosen anyway is read as a workbook and refused with that sentence.
        const notWorkbook = "This file is not an Excel workbook (.xlsx). Import the test case workbook downloaded from a Test Case Generation project, or a copy of it saved as “Excel Workbook (.xlsx)”.";
        await choose("cases.csv", "text/csv", Buffer.from("title,area\nPrint the invoice,Billing\n"));
        await pwExpect(alert).toContainText(notWorkbook);
        await everyLook("import-refused-csv");
        await choose("backup.json", "application/json", Buffer.from(JSON.stringify([{ title: "Print the invoice" }])));
        await pwExpect(alert).toContainText(notWorkbook);
        expect(await casesNow()).toHaveLength(4);
    });

    it("the New test case form offers Preconditions and Expected result for both types, and numbered Steps for both (SPEC P10, owner decision 2026-11-26)", async () => {
        await page.goto("about:blank");
        await page.goto(casesUrl());
        await page.getByRole("button", { name: "Add test case" }).first().click();
        await page.getByRole("menuitem", { name: /Write one by hand/ }).click();
        const form = page.getByRole("form", { name: "New test case" });
        await pwExpect(form.getByLabel("Preconditions (optional)")).toBeVisible();
        await pwExpect(form.getByLabel("Expected result (optional)")).toBeVisible();
        await pwExpect(form.getByLabel("Step 1, what to do")).toBeVisible();
        await form.getByRole("radio", { name: /Automated/ }).check();
        await pwExpect(form.getByLabel("Step 1, what to do")).toBeVisible();
        await pwExpect(form.getByText("Its test script is made from these steps.")).toBeVisible();
        await pwExpect(form.getByLabel("Preconditions (optional)")).toBeVisible();
        await form.getByLabel("Title", { exact: true }).fill("Search shows no result for nonsense");
        await form.getByLabel("Preconditions (optional)").fill("The catalogue has products\n\nSearch is on");
        await form.getByLabel("Expected result (optional)").fill("The page says nothing was found");
        await form.getByText("More: area, page, source, linked test scripts").click();
        await form.getByLabel("Page (optional)").fill("/search");
        await everyLook("form-automated-fields");
        const sent = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/manual-cases"));
        await form.getByRole("button", { name: "Add test case" }).click();
        expect((await sent).postDataJSON()).toMatchObject({ automation: "automated", steps: [], preconditions: ["The catalogue has products", "Search is on"], expected: "The page says nothing was found", page: "/search" });
        await pwExpect(page.getByText("Added TC-005 “Search shows no result for nonsense”.")).toBeVisible();
    });

    it("Export is one button, and it downloads the test case workbook (FX16): no JSON or CSV choice on the screen", async () => {
        const exportButton = page.getByRole("button", { name: "Export", exact: true });
        await pwExpect(exportButton).toHaveCount(1);
        await exportButton.hover();
        await pwExpect(openTip()).toContainText("the test case workbook (.xlsx)");
        await pwExpect(openTip()).not.toContainText("JSON");
        const [download] = await Promise.all([page.waitForEvent("download"), exportButton.click()]);
        expect(download.suggestedFilename()).toBe("Atlas shop test cases.xlsx");
        const bytes = fs.readFileSync((await download.path())!);
        const titles = readTable(new Uint8Array(bytes), "Test cases", { columns: ["Title"], required: ["Title"] }).map((r) => r.values.Title);
        expect(titles).toEqual((await casesNow()).map((c) => c.title));
        await pwExpect(page.getByRole("menuitem")).toHaveCount(0);
        await pwExpect(page.getByRole("button", { name: /JSON|CSV/ })).toHaveCount(0);
        await everyLook("export-workbook");
    });

    it("lists 5,000 test cases quickly (FX15)", async () => {
        const big = seedProject(platform, "Big shop", "https://big.example.test");
        platform.repo.updateProject(big.projectId, { testingModes: ["code"] });
        const many = Array.from({ length: 5000 }, (_, i) => ({ title: `Check case number ${i + 1}`, area: `Area ${i % 40}`, priority: "medium", steps: [{ action: "Open the page", expected: "It opens" }] }));
        const r = await server.inject({ method: "POST", url: `/api/projects/${big.projectId}/manual-cases/import`, headers: { "x-requested-with": "ai-studio" }, payload: { format: "json", content: JSON.stringify(many) } });
        expect(r.statusCode, r.body).toBe(201);
        await page.goto("about:blank");
        const times: number[] = [];
        for (let i = 0; i < 3; i++) {
            const t0 = Date.now();
            await page.goto(`${BASE}/#/projects/${big.projectId}/tests`);
            await pwExpect(page.getByRole("heading", { name: "Test cases (5000)" })).toBeVisible({ timeout: 30_000 });
            await pwExpect(page.getByRole("link", { name: "Check case number 1", exact: true })).toBeVisible();
            times.push(Date.now() - t0);
            await page.goto("about:blank");
        }
        times.sort((a, b) => a - b);
        console.log(`FX15 5,000 cases: list shown in ${times.join(", ")} ms (median ${times[1]})`);
        expect(times[1]).toBeLessThan(1500);
        // The list draws 50 rows at a time, as Test scripts does; "Show 50 more" draws the next ones.
        await page.goto(`${BASE}/#/projects/${big.projectId}/tests`);
        const list = page.getByRole("region", { name: "Test cases list" });
        await pwExpect(list.locator("tbody tr")).toHaveCount(50);
        await pwExpect(page.getByText("Showing 50 of 5000")).toBeVisible();
        await page.getByRole("button", { name: "Show 50 more" }).click();
        await pwExpect(list.locator("tbody tr")).toHaveCount(100);
        await page.getByRole("searchbox", { name: "Search test cases" }).fill("Check case number 4999");
        await pwExpect(list.getByRole("link", { name: "Check case number 4999", exact: true })).toBeVisible();
        // The paged list at both widths (an axe pass over it is in everyLook above, on the small project).
        await page.getByRole("searchbox", { name: "Search test cases" }).fill("");
        await pwExpect(page.getByRole("heading", { name: "Test cases (5000)" })).toBeVisible({ timeout: 30_000 });
        for (const [width, height, label] of [[1280, 900, "desktop"], [390, 844, "phone"]] as const) {
            await page.setViewportSize({ width, height });
            expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), label).toBeLessThanOrEqual(0);
            if (process.env.CASE_IMPORT_SHOTS) await page.screenshot({ path: path.join(process.env.CASE_IMPORT_SHOTS, `list-5000-${label}.png`), fullPage: true });
        }
        await page.setViewportSize({ width: 1280, height: 900 });
    });

    it("kept the browser console clean", () => {
        expect(consoleErrors).toEqual([]);
    });
});
