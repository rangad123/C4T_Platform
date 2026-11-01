/**
 * The Requirements place in a real browser against the real built UI (`web/dist`) and a real platform (no model, no worker): add a
 * requirement, link a test case from the picker and see its latest result, coverage on the list with search and filters, import
 * pasted text with a preview before saving, the coverage panel on the project dashboard, the requirements a test covers on its page,
 * deleting, axe in light mode, phone width and a clean console. Port 7700.
 *
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/requirements-ui.test.ts
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
import { addTest, seedProject, seedRun, type Seed } from "./fixtures/dashboard-seed.js";

const PORT = 7700;
const BASE = `http://127.0.0.1:${PORT}`;

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let page: Page;
let dir = "";
let shop: Seed;
let empty: Seed;
const consoleErrors: string[] = [];
const listUrl = () => `${BASE}/#/projects/${shop.projectId}/requirements`;

/** A hash-only navigation keeps component state: go through a blank page so each step starts clean. */
const open = async (url: string) => {
    await page.goto("about:blank");
    await page.goto(url);
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-req-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    shop = seedProject(platform, "Atlas shop", "https://atlas.example.test");
    for (const k of ["pay", "basket"]) addTest(platform, shop, k);
    await seedRun(platform, shop, { pay: "pass", basket: "fail" }, { daysAgo: 1 });
    // A project with nothing in it: the empty page must fit a phone too.
    empty = seedProject(platform, "Empty shop", null);

    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
}, 90_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("requirements in the browser", () => {
    it("starts empty with no planned card, and adds a requirement", async () => {
        await open(listUrl());
        await pwExpect(page.getByText("No requirements yet")).toBeVisible();
        await pwExpect(page.getByTestId("planned-requirements")).toHaveCount(0);
        await page.getByRole("button", { name: "Add requirement" }).first().click();
        const form = page.getByRole("form", { name: "New requirement" });
        await form.getByLabel("Title").fill("A shopper can pay by card");
        await form.getByLabel("Priority").selectOption("high");
        await form.getByLabel("Acceptance criteria (optional)").fill("The card is charged once\nThe order number is shown");
        await form.getByRole("button", { name: "Add requirement" }).click();
        await pwExpect(page.getByRole("heading", { name: "REQ-1 A shopper can pay by card" })).toBeVisible();
        await pwExpect(page.getByRole("list").filter({ hasText: "The card is charged once" })).toBeVisible();
        await pwExpect(page.getByText("Not covered").first()).toBeVisible();
    });

    it("links a test case from the picker and shows its latest result", async () => {
        await page.getByRole("button", { name: "Link test cases" }).click();
        const picker = page.getByRole("region", { name: "Link test cases" });
        await picker.getByLabel("Check pay").check();
        await picker.getByRole("button", { name: "Link 1 test case" }).click();
        await pwExpect(page.getByText("Linked 1 test case.")).toBeVisible();
        const linked = page.getByRole("list", { name: "Linked test cases" });
        await pwExpect(linked.getByText("Check pay")).toBeVisible();
        await pwExpect(linked.getByText("Passed")).toBeVisible();
        await pwExpect(page.getByText("Passing").first()).toBeVisible();
    });

    it("imports pasted text after a preview, leaving out a reference that exists", async () => {
        await open(listUrl());
        await page.getByRole("button", { name: "Import" }).click();
        await page.getByLabel("Requirements text").fill("# Basket\n- REQ-1: Duplicate of the first.\n- REQ-2: The basket keeps its items after signing in.\n- REQ-3: A coupon lowers the total.");
        await page.getByRole("button", { name: "Read requirements" }).click();
        await pwExpect(page.getByTestId("import-preview-summary")).toContainText("Found 3 requirements");
        await pwExpect(page.getByText("Already here")).toBeVisible();
        await page.getByLabel(/REQ-3/).uncheck();
        await page.getByRole("button", { name: "Save 1 requirement" }).click();
        await pwExpect(page.getByText("Imported 1 requirement.")).toBeVisible();
        const list = page.getByRole("list", { name: "Requirements" });
        await pwExpect(list.getByRole("link")).toHaveCount(2);
        await pwExpect(page.getByTestId("requirements-summary")).toContainText("2 requirements: 1 passing, 0 failing, 0 covered without a full result, 1 not covered.");
    });

    it("filters by coverage and status, and searches", async () => {
        const list = page.getByRole("list", { name: "Requirements" });
        await page.getByRole("group", { name: "Filter by coverage" }).getByRole("button", { name: /Not covered/ }).click();
        await pwExpect(list.getByRole("link")).toHaveCount(1);
        await pwExpect(list).toContainText("REQ-2");
        await page.getByRole("group", { name: "Filter by coverage" }).getByRole("button", { name: /^All/ }).click();
        await page.getByLabel("Search requirements").fill("card");
        await pwExpect(list.getByRole("link")).toHaveCount(1);
        await pwExpect(list).toContainText("REQ-1");
        await page.getByLabel("Search requirements").fill("");
        await page.getByLabel("Filter by status").selectOption("retired");
        await pwExpect(page.getByText("Nothing matches")).toBeVisible();
    });

    it("shows the coverage panel on the project dashboard", async () => {
        await open(`${BASE}/#/projects/${shop.projectId}`);
        const panel = page.getByTestId("requirements-coverage");
        await pwExpect(panel).toBeVisible();
        await pwExpect(panel).toContainText("1 passing");
        await pwExpect(panel).toContainText("1 not covered");
    });

    it("shows the requirements a test covers on its page, with a link", async () => {
        await open(`${BASE}/#/tests/${shop.tests.get("pay")}`);
        const box = page.getByTestId("test-requirements");
        await pwExpect(box).toBeVisible();
        await box.getByRole("link", { name: /REQ-1/ }).click();
        await pwExpect(page.getByRole("heading", { name: "REQ-1 A shopper can pay by card" })).toBeVisible();
    });

    it("has no accessibility violations on the list, the import preview and a requirement", async () => {
        const check = async (what: string) => {
            await page.waitForTimeout(400);
            const result = await new AxeBuilder({ page }).analyze();
            expect(result.violations.map((v) => `${what}: ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
        };
        await open(listUrl());
        await pwExpect(page.getByRole("list", { name: "Requirements" })).toBeVisible();
        await check("list");
        await page.getByRole("button", { name: "Import" }).click();
        await page.getByLabel("Requirements text").fill("- REQ-9: Orders can be cancelled within an hour.");
        await page.getByRole("button", { name: "Read requirements" }).click();
        await pwExpect(page.getByTestId("import-preview-summary")).toBeVisible();
        await check("import preview");
        await page.getByRole("list", { name: "Requirements" }).getByRole("link", { name: /REQ-1/ }).click();
        await pwExpect(page.getByRole("list", { name: "Linked test cases" })).toBeVisible();
        await check("requirement");
        await page.getByRole("button", { name: "Link test cases" }).click();
        await check("picker");
    });

    it("fits a phone without sideways scrolling", async () => {
        await page.setViewportSize({ width: 375, height: 812 });
        for (const url of [listUrl(), `${BASE}/#/projects/${shop.projectId}`, `${BASE}/#/projects/${empty.projectId}/requirements`]) {
            await open(url);
            await page.waitForTimeout(700);
            const wide = await page.evaluate(() =>
                Array.from(document.querySelectorAll("body *"))
                    .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !el.closest(".tabs, .subtabs"))
                    .filter((el) => !Array.from(el.children).some((c) => c.getBoundingClientRect().right > document.documentElement.clientWidth + 1))
                    .slice(0, 5)
                    .map((el) => `${el.tagName.toLowerCase()}.${el.className} "${(el.textContent ?? "").trim().slice(0, 40)}"`),
            );
            const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            expect({ over, wide }, url).toEqual({ over: 0, wide: [] });
        }
        await page.setViewportSize({ width: 1280, height: 900 });
    });

    it("deletes a requirement after confirming; the test stays", async () => {
        await open(listUrl());
        await page.getByRole("list", { name: "Requirements" }).getByRole("link", { name: /REQ-1/ }).click();
        await page.getByRole("button", { name: "Delete", exact: true }).click();
        await pwExpect(page.getByText("1 test case covers it.", { exact: false })).toBeVisible();
        await page.getByRole("button", { name: "Delete REQ-1" }).click();
        await pwExpect(page.getByRole("list", { name: "Requirements" }).getByRole("link")).toHaveCount(1);
        expect(platform.repo.getTest(shop.tests.get("pay")!)).toBeTruthy();
    });

    it("kept the browser console clean", () => {
        expect(consoleErrors).toEqual([]);
    });
});
