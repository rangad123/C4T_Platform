/**
 * The healing suggestion and the deploy-trigger panel in a real browser, against the real platform, worker and a fixture shop
 * whose button is renamed. Requires `npm run build:web`; runs a browser, so use the lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/healing-triggers-ui.test.ts
 */
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { startHealingApp, type ShopMode } from "./fixtures/healing-app.js";

const SHOP_PORT = 5535;
const PLATFORM_PORT = 5536;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;

let browser: Browser;
let page: Page;
let platform: Platform;
let worker: Worker;
let server: Awaited<ReturnType<typeof buildServer>>;
let shop: http.Server;
let setMode: (m: ShopMode) => void;
let dataDir: string;
let projectId: string;
const tests: Record<string, string> = {};

const api = async (method: "GET" | "POST" | "PUT", url: string, body?: unknown) => {
    const res = await fetch(BASE + url, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null } as { status: number; body: any };
};
async function waitForJob(jobId: string) {
    for (let i = 0; i < 400; i++) {
        const j = (await api("GET", `/api/test-generation/${jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) return j;
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("job did not finish");
}

const addButton = { by: "role", role: "button", value: "Add to cart", exact: true };
const addToCart = (title: string) => ({ title, kind: "web", category: "Shop", steps: [{ action: "navigate", url: "/" }, { action: "click", locator: addButton }, { action: "assert", check: "text", locator: { by: "role", role: "status" }, expected: "Cart: 1 item" }] });

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    ({ server: shop, setMode } = await startHealingApp(SHOP_PORT));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-healui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), CONCURRENCY: "2" }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    worker = new Worker({ ...platform }, 100);
    worker.start();

    // Two tests that pass while the button is called "Add to cart", then the shop renames it and both are run again.
    projectId = (await api("POST", "/api/projects", { name: "Renamed shop" })).body.id;
    // This file is about applying a fix and seeing it run: with the default policy a fix is a draft and waits for approval (tests/reviews-api.test.ts).
    await api("PUT", `/api/projects/${projectId}/review-policy`, { healing: false });
    const imp = await api("POST", `/api/projects/${projectId}/specs`, { baseUrl: `http://127.0.0.1:${SHOP_PORT}`, specs: [addToCart("Add an item to the cart"), addToCart("Add another item to the cart")] });
    expect(imp.status, JSON.stringify(imp.body)).toBe(202);
    imp.body.tests.forEach((t: { id: string }, i: number) => (tests[`T${i + 1}`] = t.id));
    expect((await waitForJob(imp.body.jobId)).status).toBe("COMPLETED");
    setMode("renamed");
    const app = platform.repo.getLatestApplicationPublic(projectId)!;
    const rerun = await platform.repo.createJob(projectId, app.id as string, { ...(await import("../src/platform/repo.js")).DEFAULT_JOB_OPTIONS, mode: "validate", testIds: Object.values(tests) });
    await waitForJob(rerun.id);

    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
}, 240_000);

afterAll(async () => {
    await browser?.close();
    await worker?.stop();
    await server?.close();
    shop?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("healing suggestion on the test page", () => {
    it("says in plain words what was found, how sure we are, and what would change", async () => {
        await page.goto(`${BASE}/#/tests/${tests.T1}`);
        await pwExpect(page.getByText("This test is failing")).toBeVisible();
        const box = page.getByTestId("healing-suggestion");
        await pwExpect(box.getByRole("heading", { name: "We found a likely replacement for the “Add to cart” button" })).toBeVisible();
        await pwExpect(box).toContainText("It is now “Add to basket”");
        await pwExpect(box).toContainText("high confidence");
        await pwExpect(box).toContainText("means the same thing");
        await pwExpect(box.getByRole("group", { name: "What would change" })).toContainText("button called “Add to cart”");
        await pwExpect(box.getByRole("group", { name: "What would change" })).toContainText("button called “Add to basket”");
        await pwExpect(box).toContainText("What the test does and checks stays the same");
        // nothing has been changed yet
        expect((await api("GET", `/api/tests/${tests.T1}`)).body.spec.steps[1].locator.value).toBe("Add to cart");
    });

    it("fits a phone-sized screen", async () => {
        await page.setViewportSize({ width: 390, height: 800 });
        await pwExpect(page.getByTestId("healing-suggestion")).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBe(0);
        await page.setViewportSize({ width: 1200, height: 900 });
    });

    it("Apply and run again changes the locator, runs the test and it passes", async () => {
        await page.getByRole("button", { name: "Apply and run again" }).click();
        await pwExpect(page.getByText("This test is passing")).toBeVisible({ timeout: 120_000 });
        await pwExpect(page.getByTestId("healing-suggestion")).toHaveCount(0);
        const t = (await api("GET", `/api/tests/${tests.T1}`)).body;
        expect(t.validationStatus).toBe("VALIDATED");
        expect(t.spec.steps[1].locator).toEqual({ by: "role", role: "button", value: "Add to basket", exact: true });
        // the step list shows the new name
        await pwExpect(page.getByText("Add to basket").first()).toBeVisible();
    });

    it("Dismiss closes the suggestion and leaves the test as it was", async () => {
        await page.goto(`${BASE}/#/tests/${tests.T2}`);
        await pwExpect(page.getByTestId("healing-suggestion")).toBeVisible();
        await page.getByRole("button", { name: "Dismiss" }).click();
        await pwExpect(page.getByTestId("healing-suggestion")).toHaveCount(0);
        await pwExpect(page.getByTestId("healing-history")).toContainText("You dismissed a suggestion for the “Add to cart” button");
        expect((await api("GET", `/api/tests/${tests.T2}`)).body.spec.steps[1].locator.value).toBe("Add to cart");
    });
});

describe("deploy triggers panel", () => {
    let token = "";

    it("starts empty and explains what a token is for", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/runs?section=deploys`);
        const panel = page.getByRole("region", { name: "Run after a deploy" });
        await pwExpect(panel.getByText("No deploy tokens yet")).toBeVisible();
        await pwExpect(panel).toContainText("start a re-run of all tests as soon as a release is live");
    });

    it("creates a token, shows it once, and keeps only its end afterwards", async () => {
        const panel = page.getByRole("region", { name: "Run after a deploy" });
        await panel.getByRole("button", { name: "Create a token" }).click();
        const form = page.getByRole("form", { name: "New deploy token" });
        await form.getByLabel("Name (optional)").fill("GitHub Actions");
        await form.getByRole("button", { name: "Create token" }).click();

        const fresh = page.getByRole("region", { name: "Your new token" });
        await pwExpect(fresh.getByText("This is the only time it is shown")).toBeVisible();
        token = (await fresh.getByTestId("new-token").innerText()).trim();
        expect(token).toMatch(/^aitt_[A-Za-z0-9_-]{43}$/);
        await pwExpect(fresh).toContainText(`/api/triggers/${token}/run`); // the ready-to-paste example
        await fresh.getByRole("button", { name: "I have copied it" }).click();

        await pwExpect(page.getByText(token)).toHaveCount(0);
        const row = page.locator("[data-token]");
        await pwExpect(row).toContainText("GitHub Actions");
        await pwExpect(row).toContainText(`ends in ${token.slice(-4)}`);
        await pwExpect(row).toContainText("Last used never");
    });

    it("a run started with the token is marked as started by a deploy in Runs", async () => {
        const run = await fetch(`${BASE}/api/triggers/${token}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commit: "9b1f0c2e55", environment: "staging" }) });
        expect(run.status).toBe(202);
        const { jobId } = (await run.json()) as { jobId: string };
        await waitForJob(jobId);

        await page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Runs", exact: true }).click();
        await pwExpect(page.getByRole("heading", { name: "Runs", exact: true })).toBeVisible();
        const card = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Run", exact: true }) }).filter({ hasText: "After a deploy" });
        await pwExpect(card).toHaveCount(1);
        await pwExpect(card.getByText("After a deploy · 9b1f0c2e")).toBeVisible();
    });

    it("Revoke stops the token working and removes it from the list", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/runs?section=deploys`);
        await page.getByRole("button", { name: "Revoke: GitHub Actions" }).click();
        await page.getByRole("button", { name: "Yes, revoke it" }).click();
        await pwExpect(page.locator("[data-token]")).toHaveCount(0);
        await pwExpect(page.getByText("1 revoked token no longer works.")).toBeVisible();
        const after = await fetch(`${BASE}/api/triggers/${token}/run`, { method: "POST" });
        expect(after.status).toBe(404);
    });

    it("fits a phone-sized screen", async () => {
        await page.setViewportSize({ width: 390, height: 800 });
        await page.goto(`${BASE}/#/projects/${projectId}/runs?section=deploys`);
        await pwExpect(page.getByRole("heading", { name: "Run after a deploy" })).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBe(0);
    });
});
