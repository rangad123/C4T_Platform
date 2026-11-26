/**
 * The outcome report of a Test Case Generation project in a real browser (founder 2026-11-19 P3, P7, R8, R15; PLAN.md U3). The
 * components are not wired into a page yet (that is U4 and U5), so this file bundles a test page with esbuild
 * (tests/fixtures/outcome-harness.tsx) and renders fixture outcomes (tests/fixtures/outcome-fixtures.ts):
 *
 * - one summary line, and one page count: the header's pages equal the tree's nodes; the failed addresses are one note apart from the tree;
 * - every node's number equals the test cases listed when it is selected, and the numbers add up to the total;
 * - the tree by keyboard (one tab stop, arrows open, close and move, Home and End, Enter selects) and by pointer (expand and collapse);
 * - Automated rows show preconditions and the expected result, Manual rows their steps;
 * - the empty, still-running and stopped states, no download button without the export permission, a phone-sized screen;
 * - no accessibility violations (axe), with the colour scheme set to light and to dark.
 *
 * Run: node scripts/with-lock.mjs browser -- npx vitest run tests/outcome-report-ui.test.ts (no web build needed).
 * Screenshots: $OUTCOME_SHOTS (when set).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.js";
import { FULL, STOPPED } from "./fixtures/outcome-fixtures.js";

const SHOTS = process.env.OUTCOME_SHOTS;
let dir: string;
let server: http.Server;
let base: string;
let browser: Browser;
let page: Page;
const consoleErrors: string[] = [];

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Outcome report</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@500;600&display=swap">
<link rel="stylesheet" href="/outcome-harness.css"></head><body><div id="root"></div><script type="module" src="/outcome-harness.js"></script></body></html>`;

beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-outcome-ui-"));
    await build({
        entryPoints: [path.join(REPO_ROOT, "tests/fixtures/outcome-harness.tsx")],
        bundle: true,
        outdir: dir,
        format: "esm",
        jsx: "automatic",
        loader: { ".png": "dataurl", ".svg": "dataurl" },
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
        logLevel: "silent",
    });
    fs.writeFileSync(path.join(dir, "index.html"), HTML);
    server = http.createServer((req, res) => {
        const name = new URL(req.url ?? "/", "http://x").pathname;
        const file = name === "/" ? "index.html" : name.slice(1);
        const full = path.join(dir, file);
        if (!/^[\w.-]+$/.test(file) || !fs.existsSync(full)) return res.writeHead(404).end("not found");
        const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
        res.writeHead(200, { "content-type": `${type}; charset=utf-8` }).end(fs.readFileSync(full));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://localhost:${(server.address() as { port: number }).port}`;
    browser = await chromium.launch();
    // AxeBuilder needs a page from a context made by the test.
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on("console", (m) => m.type() === "error" && !/fonts\.(googleapis|gstatic)/.test(m.text()) && consoleErrors.push(m.text()));
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    await new Promise((r) => server?.close(r));
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

async function open(fixture: string, extra = "") {
    await page.goto(`${base}/?fixture=${fixture}${extra}`);
    await page.getByTestId("case-outcome").waitFor();
}
const items = () => page.getByRole("treeitem");
const focusedName = () => page.evaluate(() => document.activeElement?.querySelector(".ot-title")?.textContent ?? null);
async function expandAll() {
    for (let i = 0; i < 50; i++) {
        const closed = page.locator('.ot-item[aria-expanded="false"] > .ot-row .ot-chev');
        if ((await closed.count()) === 0) return;
        await closed.first().click();
    }
}
/** A full-page screenshot with the pointer moved off the page and animations finished. */
async function shot(name: string) {
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(SHOTS!, name), fullPage: true, animations: "disabled" });
}
const shown = () => page.locator(".oc-list > .oc-case");

describe("outcome report", () => {
    it("says one summary line whose page count is the tree's nodes, with the failed addresses once and apart", async () => {
        await open("full");
        await expect.poll(() => page.getByTestId("outcome-summary").textContent()).toBe("12 pages, 16 test cases, from 3 runs");
        await expandAll();
        expect(await items().count()).toBe(FULL.tree.length);
        expect(await items().count()).toBe(12);
        // Failed addresses: one note, outside the tree, never a node.
        await expect.poll(() => page.getByTestId("outcome-not-opened").textContent()).toContain("5 addresses could not be opened");
        expect(await page.getByRole("tree").getByText(/could not be opened/).count()).toBe(0);
        expect(await page.getByTestId("outcome-not-opened").evaluate((el) => !!el.closest('[role="tree"]'))).toBe(false);
        // What is missing, and the one download.
        expect(await page.getByTestId("outcome-missing").getByRole("listitem").count()).toBe(2);
        const dl = page.getByTestId("outcome-download");
        expect(await dl.textContent()).toBe("Download test cases");
        expect(await dl.getAttribute("href")).toBe("/api/projects/p1/outcome/workbook");
        expect(await dl.getAttribute("download")).not.toBeNull();
        expect(await page.getByRole("link").count()).toBe(1);
        // No pass or fail, no runs of tests, no second list of pages.
        const text = (await page.getByTestId("case-outcome").textContent()) ?? "";
        for (const banned of ["Passing", "Not passing", "Run all tests", "What we found", "Site map", "What the explorer knows", "Screens found", "Show all 41", "checks"]) expect(text).not.toContain(banned);
        if (SHOTS) await shot("outcome-light-desktop.png");
    });

    it("gives every node the number of test cases it lists, and the numbers add up to the total", async () => {
        await open("full");
        await expandAll();
        let sum = 0;
        const n = await items().count();
        for (let i = 0; i < n; i++) {
            const item = items().nth(i);
            const badge = Number(await item.locator(":scope > .ot-row .ot-count").textContent());
            await item.locator(":scope > .ot-row .ot-title").click();
            expect(await item.getAttribute("aria-selected")).toBe("true");
            const title = await item.locator(":scope > .ot-row .ot-title").textContent();
            await expect.poll(() => page.getByTestId("outcome-cases").locator("h3").textContent()).toBe(`Test cases on ${title}${badge}`);
            expect(await shown().count()).toBe(badge);
            sum += badge;
        }
        expect(sum).toBe(FULL.cases.length);
        // Selecting the selected node again, or Show all, lists every case.
        await page.getByRole("button", { name: "Show all" }).click();
        expect(await shown().count()).toBe(16);
        expect(await page.locator('[role="treeitem"][aria-selected="true"]').count()).toBe(0);
    });

    it("moves through the tree by keyboard: one tab stop, arrows open, close and move, Home and End, Enter selects", async () => {
        await open("full");
        // Only the roots start open.
        expect(await items().count()).toBe(6);
        expect(await page.locator('[role="treeitem"][tabindex="0"]').count()).toBe(1);
        await page.getByRole("tree").locator('[tabindex="0"]').focus();
        expect(await focusedName()).toBe("Home");
        await page.keyboard.press("ArrowDown");
        expect(await focusedName()).toBe("Products");
        const products = page.locator('[role="treeitem"][data-path="/products"]');
        expect(await products.getAttribute("aria-expanded")).toBe("false");
        await page.keyboard.press("ArrowRight");
        expect(await products.getAttribute("aria-expanded")).toBe("true");
        expect(await focusedName()).toBe("Products");
        await page.keyboard.press("ArrowRight");
        expect(await focusedName()).toBe("Product: Travel mug");
        expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-level"))).toBe("3");
        await page.keyboard.press("ArrowLeft");
        expect(await focusedName()).toBe("Products");
        await page.keyboard.press("ArrowLeft");
        expect(await products.getAttribute("aria-expanded")).toBe("false");
        await page.keyboard.press("ArrowLeft");
        expect(await focusedName()).toBe("Home");
        await page.keyboard.press("End");
        expect(await focusedName()).toBe("About us");
        await page.keyboard.press("Home");
        expect(await focusedName()).toBe("Home");
        // Enter selects and lists the node's cases; the tab stop follows; Space on it again shows every case.
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        expect(await products.getAttribute("aria-selected")).toBe("true");
        expect(await shown().count()).toBe(3);
        expect(await page.locator('[role="treeitem"][tabindex="0"]').getAttribute("data-path")).toBe("/products");
        await page.keyboard.press(" ");
        expect(await shown().count()).toBe(16);
        // Tab leaves the tree in one press.
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => document.activeElement?.closest('[role="tree"]') === null)).toBe(true);
    });

    it("opens and closes a branch with the pointer", async () => {
        await open("full");
        const home = page.locator('[role="treeitem"][data-path="/"]');
        await home.locator(":scope > .ot-row .ot-chev").click();
        expect(await home.getAttribute("aria-expanded")).toBe("false");
        expect(await items().count()).toBe(1);
        // Opening or closing a branch does not select it.
        expect(await home.getAttribute("aria-selected")).toBe("false");
        await home.locator(":scope > .ot-row .ot-chev").click();
        expect(await items().count()).toBe(6);
    });

    it("shows an Automated case's preconditions and expected result, and a Manual case's steps", async () => {
        await open("full");
        const auto = page.locator('[data-case="TC-010"]');
        expect(await auto.locator(".badge").textContent()).toBe("Automated");
        expect(await auto.locator(".oc-prio").textContent()).toBe("Critical priority");
        expect(await auto.locator(".oc-case-page").textContent()).toBe("Checkout");
        expect(await auto.locator(".oc-detail").isVisible()).toBe(false);
        await auto.getByRole("button").click();
        expect(await auto.getByRole("button").getAttribute("aria-expanded")).toBe("true");
        const autoText = (await auto.locator(".oc-detail").textContent()) ?? "";
        expect(autoText).toContain("Before you start");
        expect(autoText).toContain("Signed in as a customer.");
        expect(autoText).toContain("Expected result");
        expect(autoText).toContain("REQ-8 Customers can place an order");
        expect(await auto.locator(".oc-steps").count()).toBe(0);

        const manual = page.locator('[data-case="TC-011"]');
        expect(await manual.locator(".badge").textContent()).toBe("Manual");
        await manual.getByRole("button").click();
        expect(await manual.locator(".oc-steps > li").count()).toBe(2);
        expect(await manual.locator(".oc-steps").textContent()).toContain("Expected: Every field is announced with its label.");
        if (SHOTS) await shot("outcome-case-open.png");
    });

    it("shows every case's numbered steps, its test data with a missing value highlighted, what the check flagged, and the requirements with no case (sheet items 31-33)", async () => {
        await open("checked");
        const uncovered = page.getByTestId("outcome-uncovered");
        expect(await uncovered.locator("h3").textContent()).toBe("2 requirements with no test case");
        expect(await uncovered.locator("li").allTextContents()).toEqual(["REQ-4 Customers can save a wish list", "REQ-9 Refunds reach the card in five days"]);
        const auto = page.locator('[data-case="TC-010"]');
        expect(await auto.locator(".oc-flag-count").textContent()).toBe("Needs a look");
        await auto.getByRole("button").click();
        expect(await auto.locator(".oc-steps > li").count()).toBe(2);
        expect(await auto.locator(".oc-data > li").allTextContents()).toEqual(["Valid Postcode: SW1A 1AA", "Invalid Postcode: 12", "Valid Gift card number: Missing, fill in before running"]);
        expect(await auto.locator("mark.oc-data-missing").count()).toBe(1);
        expect(await auto.getByTestId("case-flags").textContent()).toBe("Test data “Coupon” has no value and is not marked missing");
        expect(await page.locator('[data-case="TC-009"] .oc-flag-count').count()).toBe(0);
        const axe = await new AxeBuilder({ page }).include('[data-testid="case-outcome"]').analyze();
        expect(axe.violations.map((v) => v.id)).toEqual([]);
        if (SHOTS) await shot("outcome-case-checked.png");
    });

    it("says a stopped run kept what it found", async () => {
        await open("stopped");
        expect(await page.getByTestId("outcome-run-note").textContent()).toBe("The last run was stopped. It kept the 3 pages and 4 test cases it found before then.");
        expect(await page.getByTestId("outcome-summary").textContent()).toBe(`12 pages, 16 test cases, from ${STOPPED.runs.length} runs`);
        expect(await page.getByTestId("outcome-missing").count()).toBe(0);
        if (SHOTS) await shot("outcome-stopped.png");
    });

    it("shows a calm empty state before any run, while the first run explores and when it stopped with nothing", async () => {
        await open("empty");
        expect(await page.getByTestId("case-outcome").getByRole("heading", { name: "Not explored yet" }).count()).toBe(1);
        expect(await page.getByRole("tree").count()).toBe(0);
        expect(await page.getByTestId("outcome-download").count()).toBe(0);
        expect(await page.getByTestId("outcome-summary").count()).toBe(0);
        expect(await page.getByRole("button", { name: "Explore" }).count()).toBe(1);
        if (SHOTS) await shot("outcome-empty.png");

        await open("running-empty");
        expect(await page.getByRole("heading", { name: "Exploring the application" }).count()).toBe(1);
        expect(await page.getByTestId("outcome-download").count()).toBe(0);

        await open("stopped-empty");
        expect(await page.getByRole("heading", { name: "The run was stopped before it found a page" }).count()).toBe(1);
        expect(await page.getByRole("button", { name: "Explore" }).count()).toBe(1);
    });

    it("has no download button for a person who may not export", async () => {
        await open("full", "&download=0");
        expect(await page.getByTestId("outcome-download").count()).toBe(0);
        expect(await page.getByTestId("outcome-summary").count()).toBe(1);
    });

    it("fits a phone-sized screen: one column, no sideways scrolling, touch-sized rows", async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        try {
            await open("full");
            await page.locator('[role="treeitem"][data-path="/products"] > .ot-row .ot-title').click();
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
            const tree = await page.locator(".oc-pages").boundingBox();
            const cases = await page.getByTestId("outcome-cases").boundingBox();
            expect(cases!.y).toBeGreaterThanOrEqual(tree!.y + tree!.height - 1);
            for (const h of await page.locator(".ot-row").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(44);
            const dl = await page.getByTestId("outcome-download").boundingBox();
            expect(dl!.height).toBeGreaterThanOrEqual(44);
            if (SHOTS) {
                await page.emulateMedia({ colorScheme: "light" });
                await shot("outcome-light-phone.png");
                await page.emulateMedia({ colorScheme: "dark" });
                await shot("outcome-dark-phone.png");
            }
        } finally {
            await page.emulateMedia({ colorScheme: null });
            await page.setViewportSize({ width: 1280, height: 900 });
        }
    });

    it("has no accessibility violations in light and dark, with a node selected and a case open, and when empty", async () => {
        try {
            for (const scheme of ["light", "dark"] as const) {
                await page.emulateMedia({ colorScheme: scheme });
                await open("full");
                await expandAll();
                await page.locator('[role="treeitem"][data-path="/checkout"] > .ot-row .ot-title').click();
                await page.locator('[data-case="TC-011"] button').click();
                if (SHOTS) await shot(`outcome-${scheme}-desktop-selected.png`);
                const full = await new AxeBuilder({ page }).analyze();
                expect(full.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
                await open("empty");
                const empty = await new AxeBuilder({ page }).analyze();
                expect(empty.violations.map((v) => v.id)).toEqual([]);
                if (SHOTS && scheme === "dark") {
                    await open("full");
                    await shot("outcome-dark-desktop.png");
                }
            }
        } finally {
            await page.emulateMedia({ colorScheme: null });
        }
    });

    it("names requirement areas as areas, never as pages, and shows an area's name once (F3 round 2 M5, L11)", async () => {
        for (const width of [1280, 390]) {
            await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
            await open("requirements");
            expect(await page.getByTestId("outcome-summary").textContent()).toBe("6 test cases in 3 requirement areas, from 1 run");
            expect(await page.locator(".oc-pages > .oc-subhead").textContent()).toBe("Requirement areas");
            expect(await page.locator(".oc-head h2").textContent()).toBe("Test cases");
            expect(await page.getByRole("tree").getAttribute("aria-label")).toBe("Requirement areas");
            const area = page.locator('[role="treeitem"][data-path="REQ-1 Sign in"] > .ot-row');
            expect(await area.locator(".ot-title").textContent()).toBe("REQ-1 Sign in");
            expect(await area.locator(".ot-path").count()).toBe(0);
            await area.locator(".ot-title").click();
            expect(await page.locator(".oc-page-line").count()).toBe(0);
            // A case in an area names the area, not "No page".
            expect(await page.locator('[data-case="TC-001"] .oc-case-page').textContent()).toBe("REQ-1 Sign in");
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
            if (SHOTS) await shot(`requirements-areas-${width === 390 ? "phone" : "desktop"}.png`);
        }
        await page.setViewportSize({ width: 1280, height: 900 });
        // A page-only outcome keeps its Pages heading.
        await open("full");
        expect(await page.locator(".oc-pages > .oc-subhead").textContent()).toBe("Pages");
        expect(await page.locator(".oc-head h2").textContent()).toBe("Pages and test cases");
    });

    it("tells two cases with one title apart by their own start page (F3 round 2 L10)", async () => {
        for (const width of [1280, 390]) {
            await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
            await open("same-title");
            expect(await page.locator('[data-case="TC-001"] .oc-case-start').textContent()).toBe("/basket");
            expect(await page.locator('[data-case="TC-002"] .oc-case-start').textContent()).toBe("/basket/mini");
            expect(await page.locator('[data-case="TC-003"] .oc-case-start').count()).toBe(0);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
            if (SHOTS) await shot(`same-title-${width === 390 ? "phone" : "desktop"}.png`);
        }
        await page.setViewportSize({ width: 1280, height: 900 });
        const axe = await new AxeBuilder({ page }).analyze();
        expect(axe.violations.map((v) => v.id)).toEqual([]);
    });

    it("logged no errors in the page", () => {
        expect(consoleErrors).toEqual([]);
    });
});
