/**
 * Quarantine in a real browser against the real built UI (`web/dist`) and a real platform with seeded results (no model, no worker):
 * the unreliable-tests card suggests a test, the dialog (reason prefilled, days, name) puts it in quarantine, the Tests list shows the
 * badge, the reason and the "Quarantined" filter, the Overview says how many tests are not counted, the test page shows the callout and
 * the history and releases it, then offers quarantine again. Ordinary tests look exactly as before. Axe in light and dark, phone width.
 * Run: node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/quarantine-ui.test.ts
 * Port 5792. Set QUARANTINE_SHOTS=<folder> to also write screenshots there.
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

const PORT = 5792;
const BASE = `http://127.0.0.1:${PORT}`;
const MARKUP = '<img src=x onerror="window.__pwned=1">';

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let page: Page;
let dir: string;
let shop: Seed;
const consoleErrors: string[] = [];
const shot = async (name: string) => {
    if (process.env.QUARANTINE_SHOTS) await page.screenshot({ path: path.join(process.env.QUARANTINE_SHOTS, `${name}.png`), fullPage: true });
};
const testUrl = (key: string) => `${BASE}/#/tests/${shop.tests.get(key)}`;
const testsUrl = () => `${BASE}/#/projects/${shop.projectId}/tests`;
const scheduleUrl = () => `${BASE}/#/projects/${shop.projectId}/runs?section=trends`;
const overviewUrl = () => `${BASE}/#/projects/${shop.projectId}`;

/** A hash-only navigation keeps component state: go through a blank page so each test starts clean. */
const open = async (url: string, ready: () => Promise<void>) => {
    await page.goto("about:blank");
    await page.goto(url);
    await ready();
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-quar-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });

    shop = seedProject(platform, "Atlas shop", "https://atlas.example.test");
    for (const k of ["wobbly", "steady"]) addTest(platform, shop, k);
    await seedRun(platform, shop, { wobbly: "flaky", steady: "pass" });
    await seedRun(platform, shop, { wobbly: "flaky", steady: "pass" });
    await seedRun(platform, shop, { wobbly: "fail", steady: "pass" });

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

describe("quarantine in the UI", () => {
    it("leaves an ordinary test page and the Tests list as they were: no quarantine words anywhere", async () => {
        await open(testUrl("steady"), async () => pwExpect(page.getByRole("heading", { name: "Check steady" })).toBeVisible());
        await page.waitForTimeout(500);
        await pwExpect(page.getByText(/quarantine/i)).toHaveCount(0);
        await open(testsUrl(), async () => pwExpect(page.getByRole("link", { name: /Check wobbly/ })).toBeVisible());
        await pwExpect(page.getByRole("button", { name: /^Quarantined/ })).toHaveCount(0);
        await pwExpect(page.getByText(/quarantine/i)).toHaveCount(0);
    });

    it("suggests the unreliable test on the schedule page and puts it in quarantine after the person confirms", async () => {
        await open(scheduleUrl(), async () => pwExpect(page.getByRole("heading", { name: "Unreliable tests" })).toBeVisible());
        const row = page.getByTestId("flaky-API-001");
        await pwExpect(row).toContainText("Check wobbly");
        await pwExpect(row).toContainText("passed on re-run twice");
        // nothing was quarantined by itself
        await pwExpect(row.getByText("Quarantined", { exact: true })).toHaveCount(0);
        await shot("flaky-suggestion");
        await row.getByRole("button", { name: "Quarantine", exact: true }).click();

        const dialog = page.getByRole("dialog", { name: "Put this test in quarantine" });
        await pwExpect(dialog).toBeVisible();
        // the reason is prefilled; an empty name is explained, not sent
        await pwExpect(dialog.getByLabel("Why is it in quarantine?")).toHaveValue(/^Passed and failed on identical runs \d+ times$/);
        await dialog.getByRole("button", { name: "Put in quarantine" }).click();
        await pwExpect(dialog.getByText("Enter your name so the decision can be traced to you.")).toBeVisible();
        await dialog.getByLabel("Your name").fill("Dana");
        await dialog.getByLabel("Keep it in quarantine for (days)").fill("99");
        await dialog.getByRole("button", { name: "Put in quarantine" }).click();
        await pwExpect(dialog.getByText("Enter a number of days from 1 to 60.")).toBeVisible();
        await dialog.getByLabel("Keep it in quarantine for (days)").fill("7");
        await dialog.getByLabel("Why is it in quarantine?").fill(`Waits on the carousel ${MARKUP}`);
        await dialog.getByRole("button", { name: "Put in quarantine" }).click();
        await pwExpect(dialog).toBeHidden();
        await pwExpect(row.getByText("Quarantined", { exact: true })).toBeVisible();
        await pwExpect(row).toContainText("It still runs but does not count.");
        await pwExpect(row.getByRole("button", { name: "Quarantine", exact: true })).toHaveCount(0);

        const q = await server.inject({ method: "GET", url: `/api/projects/${shop.projectId}/quarantine` });
        const entry = JSON.parse(q.body).active[0];
        expect(entry).toMatchObject({ by: "Dana", source: "manual", reason: `Waits on the carousel ${MARKUP}`, daysLeft: 7 });
    });

    it("shows the badge, the reason and a Quarantined filter on the Tests page", async () => {
        await open(testsUrl(), async () => pwExpect(page.getByRole("link", { name: /Check wobbly/ })).toBeVisible());
        const wobbly = page.getByRole("link", { name: /Check wobbly/ });
        await pwExpect(wobbly).toContainText("Quarantined");
        await pwExpect(wobbly.getByTestId("quarantine-reason")).toContainText("In quarantine, not counted: Waits on the carousel");
        // markup in a reason is text, never page content
        await pwExpect(page.locator("img[src='x']")).toHaveCount(0);
        expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
        await pwExpect(page.getByRole("link", { name: /Check steady/ })).toBeVisible();
        const chip = page.getByRole("button", { name: /^Quarantined/ });
        await pwExpect(chip).toContainText("1");
        await chip.click();
        await pwExpect(page.getByRole("link", { name: /Check steady/ })).toHaveCount(0);
        await pwExpect(page.getByRole("link", { name: /Check wobbly/ })).toBeVisible();
        await pwExpect(page.getByText("Showing 1 of 2 tests.")).toBeVisible();
        await shot("tests-filter");
    });

    it("says on the Overview how many tests are not counted, and links to the filter", async () => {
        await open(overviewUrl(), async () => pwExpect(page.getByTestId("quarantine-line")).toBeVisible());
        await pwExpect(page.getByTestId("quarantine-line")).toContainText("1 test is in quarantine and not counted.");
        await page.getByTestId("quarantine-line").getByRole("link", { name: "See them" }).click();
        await pwExpect(page.getByRole("button", { name: /^Quarantined/ })).toHaveAttribute("aria-pressed", "true");
        await pwExpect(page.getByRole("link", { name: /Check steady/ })).toHaveCount(0);
    });

    it("shows the callout and the history on the test page, then releases it", async () => {
        await open(testUrl("wobbly"), async () => pwExpect(page.getByTestId("quarantine-callout")).toBeVisible());
        const callout = page.getByTestId("quarantine-callout");
        await pwExpect(callout).toContainText("In quarantine: this test runs but does not count");
        await pwExpect(callout).toContainText("Waits on the carousel");
        await pwExpect(callout).toContainText("Put there by Dana");
        await pwExpect(callout).toContainText("7 days left");
        await page.getByText("Quarantine history (1)").click();
        await pwExpect(page.getByTestId("quarantine-history")).toContainText("Dana put it in quarantine");
        await shot("test-callout");

        await callout.getByRole("button", { name: "Release from quarantine" }).click();
        const dialog = page.getByRole("dialog", { name: "Release this test from quarantine" });
        await pwExpect(dialog).toBeVisible();
        // the name typed before is remembered
        await pwExpect(dialog.getByLabel("Your name")).toHaveValue("Dana");
        await dialog.getByLabel("Note (optional)").fill("Fixed the wait");
        await dialog.getByRole("button", { name: "Release from quarantine" }).click();
        await pwExpect(dialog).toBeHidden();
        await pwExpect(page.getByText("Quarantine ended; this test counts again", { exact: true })).toBeVisible();
        await pwExpect(page.getByTestId("quarantine-callout")).toHaveCount(0);
        await pwExpect(page.getByText("Quarantine history (2)")).toBeVisible();
        // it still looks unreliable, so quarantine is offered again, never applied by itself
        await pwExpect(page.getByText("This test is unreliable")).toBeVisible();
    });

    it("puts it back in quarantine from its own page, with the reason prefilled", async () => {
        await open(testUrl("wobbly"), async () => pwExpect(page.getByText("This test is unreliable")).toBeVisible());
        await page.getByRole("button", { name: "Quarantine", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Put this test in quarantine" });
        await pwExpect(dialog.getByLabel("Why is it in quarantine?")).toHaveValue(/^Passed and failed on identical runs \d+ times$/);
        await pwExpect(dialog.getByLabel("Your name")).toHaveValue("Dana");
        await dialog.getByRole("button", { name: "Put in quarantine" }).click();
        await pwExpect(page.getByTestId("quarantine-callout")).toContainText("14 days left");
        const q = JSON.parse((await server.inject({ method: "GET", url: `/api/projects/${shop.projectId}/quarantine` })).body);
        expect(q.active).toHaveLength(1);
        expect(q.active[0].source).toBe("suggested");
    });

    it("has no accessibility violations in light and dark, on the test page, the dialog, the list and the card", async () => {
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.waitForTimeout(400); // colours ease over 140ms when the scheme flips; audit the settled state
            // No rule is skipped: inline links inside sentences are underlined (link-in-text-block) and every region has its own name (landmark-unique).
            const check = async (what: string) => {
                await page.waitForTimeout(600);
                const result = await new AxeBuilder({ page }).analyze();
                expect(result.violations.map((v) => `${what}: ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
            };
            await open(testUrl("wobbly"), async () => pwExpect(page.getByTestId("quarantine-callout")).toBeVisible());
            await check("test page");
            await page.getByRole("button", { name: "Release from quarantine" }).click();
            await pwExpect(page.getByRole("dialog", { name: "Release this test from quarantine" })).toBeVisible();
            await check("dialog");
            await page.keyboard.press("Escape");
            await open(testsUrl(), async () => pwExpect(page.getByRole("link", { name: /Check wobbly/ })).toBeVisible());
            await check("tests list");
            await open(scheduleUrl(), async () => pwExpect(page.getByTestId("flaky-API-001")).toBeVisible());
            await check("unreliable tests");
            await open(overviewUrl(), async () => pwExpect(page.getByTestId("quarantine-line")).toBeVisible());
            await check("overview");
        }
        await page.emulateMedia({ colorScheme: null });
    });

    it("fits a phone without sideways scrolling", async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        for (const [name, url, ready] of [
            ["test page", testUrl("wobbly"), async () => pwExpect(page.getByTestId("quarantine-callout")).toBeVisible()],
            ["tests", testsUrl(), async () => pwExpect(page.getByRole("link", { name: /Check wobbly/ })).toBeVisible()],
            ["unreliable tests", scheduleUrl(), async () => pwExpect(page.getByTestId("flaky-API-001")).toBeVisible()],
        ] as const) {
            await open(url, ready);
            await page.waitForTimeout(500);
            const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            expect(over, name).toBeLessThanOrEqual(0);
            await shot(`phone-${name.replace(/ /g, "-")}`);
        }
        await open(testUrl("wobbly"), async () => pwExpect(page.getByTestId("quarantine-callout")).toBeVisible());
        await page.getByRole("button", { name: "Release from quarantine" }).click();
        const box = await page.getByRole("dialog", { name: "Release this test from quarantine" }).boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(390);
        await page.keyboard.press("Escape");
        await page.setViewportSize({ width: 1280, height: 900 });
    });

    it("kept the browser console clean", () => {
        expect(consoleErrors).toEqual([]);
    });
});
