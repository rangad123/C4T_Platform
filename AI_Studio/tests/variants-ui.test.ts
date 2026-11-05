/**
 * One browser journey through the cross-browser / responsive feature in the real UI:
 *  pick browsers on the Tests tab -> the list shows "Fails on Firefox" -> open the test -> the matrix says where and why
 *  -> check again on Safari from the test page; plus the "not installed" explanation.
 * Everything underneath is real: the platform validates two imported tests on Chromium, then the variants really run
 * on Firefox / a phone / WebKit against the local fixture app (port 5231; platform on 5232).
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/variants-ui.test.ts
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
import { VARIANT_UI } from "../web/src/features/variants/variants.js";
import { VARIANTS, EXTRA_VARIANT_IDS } from "../src/engine/validation/variants.js";
import { FIXTURE_SPECS, startVariantsApp } from "./fixtures/variants-app.js";

const FIXTURE_PORT = 5231;
const PLATFORM_PORT = 5232;

let browser: Browser;
let fixture: http.Server;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dataDir: string;
let base: string;
let page: Page;
let projectId: string;
const saved = process.env.INSTALLED_BROWSERS_OVERRIDE;

const post = async (url: string, body: unknown) => {
    const res = await fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    delete process.env.INSTALLED_BROWSERS_OVERRIDE;
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    fixture = await startVariantsApp(FIXTURE_PORT);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-variants-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), CONCURRENCY: "2" }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 200);
    worker.start();
    base = `http://127.0.0.1:${PLATFORM_PORT}`;

    // Two tests that really validate on desktop Chrome: one works everywhere, one is hidden in Firefox.
    projectId = (await post("/api/projects", { name: "Variants UI" })).body.id;
    const specs = [FIXTURE_SPECS[0], FIXTURE_SPECS[2]];
    const imported = await post(`/api/projects/${projectId}/specs`, { specs, baseUrl: `http://127.0.0.1:${FIXTURE_PORT}` });
    expect(imported.status).toBe(202);
    await waitIdle();
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
}, 180_000);

afterAll(async () => {
    if (saved === undefined) delete process.env.INSTALLED_BROWSERS_OVERRIDE;
    else process.env.INSTALLED_BROWSERS_OVERRIDE = saved;
    await browser?.close();
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    fixture?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

async function waitIdle() {
    for (let i = 0; i < 360; i++) {
        const jobs = (await (await fetch(`${base}/api/projects/${projectId}/jobs`)).json()) as Array<{ status: string }>;
        if (jobs.length && jobs.every((j) => ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status))) return;
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("project never became idle");
}

describe("the UI's browser names match the server's", () => {
    it("lists the same variants with the same plain-language names", () => {
        expect(VARIANT_UI.map((v) => v.id)).toEqual([...EXTRA_VARIANT_IDS]);
        for (const v of VARIANT_UI) expect(v.label).toBe(VARIANTS[v.id].label);
    });
});

describe("cross-browser check in the UI", () => {
    it("runs a check from the Tests tab and flags the test that breaks on Firefox", async () => {
        await page.goto(`${base}/#/projects/${projectId}/scripts`);
        await pwExpect(page.getByRole("heading", { name: "Scripts", exact: true })).toBeVisible();
        await pwExpect(page.locator(".script-row", { hasText: "A special offer can be claimed" }).getByText("Passing", { exact: true })).toBeVisible();
        // Nothing has been checked yet: no badge, no filter chip.
        await pwExpect(page.getByText(/^Fails on/)).toHaveCount(0);
        await pwExpect(page.getByRole("button", { name: /Differs by browser/ })).toHaveCount(0);

        await page.getByRole("button", { name: "More actions" }).click();
        await page.getByRole("menuitem", { name: /Check other browsers & screen sizes/ }).click();
        const panel = page.getByRole("region", { name: "Check other browsers and screen sizes" });
        await pwExpect(panel).toBeVisible();
        const run = panel.getByRole("button", { name: "Run checks" });
        await pwExpect(run).toBeDisabled(); // nothing chosen: off by default
        await panel.getByRole("checkbox", { name: /^Firefox/ }).check();
        await panel.getByRole("checkbox", { name: /^Phone/ }).check();
        await run.click();
        await pwExpect(panel.getByText("Checking now")).toBeVisible();
        await pwExpect(panel.getByText(/2 tests will be checked on Firefox, Phone/)).toBeVisible();

        // The list refreshes when the job finishes: the broken test is badged, the healthy one is not.
        const broken = page.locator(".script-row", { hasText: "A special offer can be claimed" });
        await pwExpect(broken.getByText("Fails on Firefox")).toBeVisible({ timeout: 150_000 });
        await pwExpect(page.locator(".script-row", { hasText: "Add to cart updates the cart" }).getByText(/^Fails on/)).toHaveCount(0);
        await pwExpect(broken.getByText("Passing", { exact: true })).toBeVisible(); // its own status never changed

        // "Differs by browser" narrows the list to the tests that break somewhere.
        await page.getByRole("button", { name: /Differs by browser/ }).click();
        await pwExpect(page.locator(".script-row")).toHaveCount(1);
        await pwExpect(page.locator(".script-row")).toContainText("A special offer can be claimed");
    }, 240_000);

    it("shows where and why on the test page, then checks again on Safari from there", async () => {
        await page.locator("a.sr-title", { hasText: "A special offer can be claimed" }).click();
        await pwExpect(page.getByRole("heading", { name: "Other browsers & screen sizes" })).toBeVisible();
        await pwExpect(page.getByText("This doesn’t behave the same everywhere")).toBeVisible();
        await pwExpect(page.getByText("Medium severity").first()).toBeVisible();

        const matrix = page.getByRole("list", { name: "Result on each browser and screen size" });
        const row = (name: string) => matrix.getByRole("listitem").filter({ hasText: name });
        await pwExpect(row("Chrome (desktop)")).toContainText("Passed");
        await pwExpect(row("Firefox")).toContainText("Fails here");
        await pwExpect(row("Firefox")).toContainText("Fails at step 2: Click");
        await pwExpect(row("Firefox").getByRole("img", { name: /Screenshot on Firefox/ })).toBeVisible();
        await pwExpect(row("Firefox").getByRole("link", { name: "Recording" })).toBeVisible();
        await pwExpect(row("Phone")).toContainText("Passed");
        await pwExpect(row("Safari (WebKit)")).toContainText("Not checked");
        await pwExpect(row("Tablet")).toContainText("Not checked");
        // The failure screenshot really is an image the server can serve.
        const src = await row("Firefox").getByRole("img").getAttribute("src");
        const img = await fetch(`${base}${src}`);
        expect(img.headers.get("content-type")).toBe("image/png");

        await page.getByText("Check again", { exact: true }).click();
        const check = page.getByRole("button", { name: "Check on other browsers" });
        await pwExpect(check).toBeDisabled();
        await page.getByRole("checkbox", { name: /^Safari/ }).check();
        await page.getByRole("button", { name: "Check on Safari (WebKit)" }).click();
        await pwExpect(row("Safari (WebKit)")).toContainText("Passed", { timeout: 120_000 }); // the offer exists in WebKit
        await pwExpect(row("Firefox")).toContainText("Fails here"); // earlier results are kept
    }, 240_000);

    it("explains a browser that is not installed instead of offering it", async () => {
        process.env.INSTALLED_BROWSERS_OVERRIDE = "chromium"; // a machine like the Docker image: Chromium only
        // The Explore page no longer offers other browsers (the project's agents decide the checks); the Tests tab's panel says it.
        await page.goto(`${base}/?x=3#/projects/${projectId}/scripts`); // a fresh page load fetches the server's capabilities again
        await page.getByRole("button", { name: "More actions" }).click();
        await page.getByRole("menuitem", { name: /Check other browsers & screen sizes/ }).click();
        await pwExpect(page.getByRole("checkbox", { name: /^Safari/ })).toBeDisabled();
        delete process.env.INSTALLED_BROWSERS_OVERRIDE;
    }, 60_000);
});
