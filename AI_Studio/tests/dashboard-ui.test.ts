/**
 * The projects dashboard in a real browser against the real built UI (`web/dist`) and a real platform with three seeded
 * projects in different states (no model, no worker: only stored results are shown):
 *   dashboard and fleet sentence, filter chips, search, links, rules, phone width, keyboard focus, axe in light and dark,
 *   and the one-project page staying exactly the plain list.
 * Set DASHBOARD_SHOTS=<folder> to also write screenshots (light, dark, phone) there. Ports 5590 and 5591.
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
import { addTest, seedProject, seedRun } from "./fixtures/dashboard-seed.js";

const PORT = 5590;
const SOLO_PORT = 5591;
const BASE = `http://127.0.0.1:${PORT}`;

let platform: Platform;
let solo: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let soloServer: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let page: Page;
const dirs: string[] = [];
const ids: Record<string, string> = {};
const consoleErrors: string[] = [];

const boot = async (port: number) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-dash-ui-"));
    dirs.push(dir);
    const p = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(port) }));
    const s = await buildServer(p);
    await s.listen({ port, host: "127.0.0.1" });
    return { p, s };
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    ({ p: platform, s: server } = await boot(PORT));
    ({ p: solo, s: soloServer } = await boot(SOLO_PORT));

    // Ready: everything passes, three runs.
    const ready = seedProject(platform, "Atlas shop", "https://atlas.example.test");
    for (const k of ["a", "b", "c", "d"]) addTest(platform, ready, k);
    await seedRun(platform, ready, { a: "pass", b: "pass", c: "fail", d: "pass" }, { daysAgo: 3 });
    await seedRun(platform, ready, { a: "pass", b: "pass", c: "pass", d: "pass" }, { daysAgo: 2 });
    await seedRun(platform, ready, { a: "pass", b: "pass", c: "pass", d: "pass" }, { daysAgo: 1 });
    ids["Atlas shop"] = ready.projectId;

    // Needs attention: a medium finding and a failing test.
    const billing = seedProject(platform, "Billing API", "https://billing.example.test");
    for (const k of ["a", "b", "c"]) addTest(platform, billing, k);
    await seedRun(platform, billing, { a: "pass", b: "review:Totals differ from the invoice page", c: "fail" }, { daysAgo: 1 });
    ids["Billing API"] = billing.projectId;

    // Blocked: a server error on a critical journey.
    const checkout = seedProject(platform, "Checkout", "https://checkout.example.test");
    addTest(platform, checkout, "a", "critical");
    addTest(platform, checkout, "b");
    await seedRun(platform, checkout, { a: "review:Server error: POST /api/pay returned 500", b: "pass" }, { daysAgo: 0.2 });
    ids.Checkout = checkout.projectId;

    // The single-project platform.
    const only = seedProject(solo, "Only project", "https://only.example.test");
    addTest(solo, only, "a");
    await seedRun(solo, only, { a: "pass" });

    browser = await chromium.launch();
    // A page made through a context: axe-core refuses pages that were not.
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
}, 90_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    await soloServer?.close();
    platform?.db.close();
    solo?.db.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

// Direct children only: each row also holds its own list of reasons.
const rows = () => page.locator("ul.dash-list > li");
const open = async () => {
    await page.goto("about:blank"); // a hash-only navigation would keep the previous filters
    await page.goto(`${BASE}/#/`);
    await pwExpect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await pwExpect(rows()).toHaveCount(3);
};

describe("Projects dashboard", () => {
    it("shows the fleet in one sentence and every project with its verdict, reasons, ribbon and trend", async () => {
        await open();
        await pwExpect(page.getByText("3 projects: 1 ready, 1 needs attention, 1 blocked")).toBeVisible();
        // Blocked first, then needs attention, then ready.
        await pwExpect(rows().nth(0)).toContainText("Checkout");
        await pwExpect(rows().nth(1)).toContainText("Billing API");
        await pwExpect(rows().nth(2)).toContainText("Atlas shop");

        const checkout = rows().nth(0);
        await pwExpect(checkout).toContainText("Blocked");
        await pwExpect(checkout).toContainText("1 critical finding");
        await pwExpect(checkout.getByRole("img", { name: /2 tests: 1 passing, 1 need a look/ })).toBeVisible();

        const billing = rows().nth(1);
        await pwExpect(billing).toContainText("Needs attention");
        await pwExpect(billing).toContainText("1 test failing in the last run");
        await pwExpect(billing).toContainText("1 medium-severity finding");

        const atlas = rows().nth(2);
        await pwExpect(atlas).toContainText("Ready");
        await pwExpect(atlas).toContainText("Nothing needs attention.");
        await pwExpect(atlas).toContainText("atlas.example.test");
        await pwExpect(atlas).toContainText("4 of 4 tests passing");
        await pwExpect(atlas).toContainText("Last run: 4 of 4 tests that ran passed (100%).");
        await pwExpect(atlas.getByRole("img", { name: "Pass rate of the last 3 runs: 75%, 100%, 100%" })).toBeVisible();
        await pwExpect(atlas).toContainText("No schedule");
    });

    it("filters with the readiness chips and the search box, and clears both", async () => {
        await open();
        const chips = page.getByRole("group", { name: "Filter by readiness" });
        await pwExpect(chips.getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");
        await chips.getByRole("button", { name: /^Blocked/ }).click();
        await pwExpect(rows()).toHaveCount(1);
        await pwExpect(rows().first()).toContainText("Checkout");
        await pwExpect(chips.getByRole("button", { name: /^Blocked/ })).toHaveAttribute("aria-pressed", "true");
        await pwExpect(page.getByText("Showing 1 of 3 projects.")).toBeVisible();

        await chips.getByRole("button", { name: /^Ready/ }).click();
        await pwExpect(rows()).toHaveCount(1);
        await pwExpect(rows().first()).toContainText("Atlas shop");
        // No chip for a state nobody is in.
        await pwExpect(chips.getByRole("button", { name: /^Unknown/ })).toHaveCount(0);

        await chips.getByRole("button", { name: /^All/ }).click();
        await page.getByLabel("Search projects").fill("billing.example");
        await pwExpect(rows()).toHaveCount(1);
        await pwExpect(rows().first()).toContainText("Billing API");

        await page.getByLabel("Search projects").fill("zzz");
        await pwExpect(page.getByRole("heading", { name: "No projects match" })).toBeVisible();
        await page.getByRole("button", { name: "Clear filters" }).click();
        await pwExpect(rows()).toHaveCount(3);
    });

    it("explains how readiness is decided", async () => {
        await open();
        await page.locator("summary", { hasText: "How readiness is decided" }).click();
        await pwExpect(page.getByText("Any open critical or high-severity finding")).toBeVisible();
        await pwExpect(page.getByText("Do not release until this is dealt with.")).toBeVisible();
    });

    it("links to the project, its attention list and its runs", async () => {
        await open();
        await rows().nth(1).getByRole("link", { name: "Attention list" }).click();
        await page.waitForURL(new RegExp(`#/projects/${ids["Billing API"]}/tests\\?status=review`));
        await pwExpect(page.getByRole("button", { name: /^Needs a look/ })).toHaveAttribute("aria-pressed", "true");

        await open();
        await rows().nth(0).getByRole("link", { name: "Runs" }).click();
        await page.waitForURL(new RegExp(`#/projects/${ids.Checkout}/runs`));

        await open();
        await rows().nth(2).getByRole("link", { name: "Atlas shop" }).click();
        await page.waitForURL(new RegExp(`#/projects/${ids["Atlas shop"]}$`));
        await pwExpect(page.getByRole("heading", { name: "Atlas shop", exact: true })).toBeVisible();
    });

    it("can be used with the keyboard and shows where the focus is", async () => {
        await open();
        const chip = page.getByRole("group", { name: "Filter by readiness" }).getByRole("button", { name: /^Blocked/ });
        for (let i = 0; i < 30; i++) {
            await page.keyboard.press("Tab");
            if (await chip.evaluate((el) => el === document.activeElement)) break;
        }
        expect(await chip.evaluate((el) => el === document.activeElement)).toBe(true);
        // the design system draws focus as a 2px outline (text fields use a soft ring instead)
        expect(await chip.evaluate((el) => { const c = getComputedStyle(el); return c.outlineStyle !== "none" && parseFloat(c.outlineWidth) >= 2; })).toBe(true);
        await page.keyboard.press("Enter");
        await pwExpect(rows()).toHaveCount(1);
    });

    it("fits a phone without sideways scrolling", async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await open();
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(over).toBeLessThanOrEqual(0);
        await pwExpect(rows().first()).toBeVisible();
        await page.waitForTimeout(800);
        if (process.env.DASHBOARD_SHOTS) await page.screenshot({ path: path.join(process.env.DASHBOARD_SHOTS, "dashboard-phone.png"), fullPage: true });
        await page.setViewportSize({ width: 1280, height: 900 });
    });

    it("has no accessibility violations in light and dark", async () => {
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.waitForTimeout(400); // colours ease over 140ms when the scheme flips; audit the settled state
            await open();
            await page.locator("summary", { hasText: "How readiness is decided" }).click();
            await pwExpect(page.getByText("Any open critical or high-severity finding")).toBeVisible();
            await page.waitForTimeout(800); // let the ribbon finish drawing in
            if (process.env.DASHBOARD_SHOTS) await page.screenshot({ path: path.join(process.env.DASHBOARD_SHOTS, `dashboard-${scheme}.png`), fullPage: true });
            const result = await new AxeBuilder({ page }).analyze();
            expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
        }
        await page.emulateMedia({ colorScheme: null });
    });

    it("leaves the one-project page as the plain list", async () => {
        const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        try {
            await p.goto(`http://127.0.0.1:${SOLO_PORT}/#/`);
            await pwExpect(p.getByText("Each project is one application we generate and maintain tests for.")).toBeVisible();
            await pwExpect(p.getByRole("link", { name: /Only project/ })).toBeVisible();
            await pwExpect(p.getByRole("group", { name: "Filter by readiness" })).toHaveCount(0);
            await pwExpect(p.getByRole("list", { name: "Projects" })).toHaveCount(0);
        } finally {
            await p.close();
        }
    });

    it("kept the browser console clean", () => {
        expect(consoleErrors).toEqual([]);
    });
});
