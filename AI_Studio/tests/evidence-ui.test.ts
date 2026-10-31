/**
 * One browser journey through failure evidence in the real UI: a failed web test shows "What the page did" (the sentence, the
 * failing request, the console error, all requests with a filter), a passing test shows nothing, a failed run from before this
 * feature explains why there is nothing to show. Everything underneath is real: a real platform runs imported web tests against
 * the fixture app under Playwright (ports 5652 fixture, 5653 platform).
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/evidence-ui.test.ts
 */
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { startEvidenceApp } from "./fixtures/evidence-app.js";

const FX_PORT = 5652;
const PLATFORM_PORT = 5653;
const FX = `http://127.0.0.1:${FX_PORT}`;

let browser: Browser;
let context: BrowserContext;
let page: Page;
let fx: http.Server;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dataDir: string;
let base: string;
let projectId: string;
const ids: Record<string, string> = {};

const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${base}${url}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text } as { status: number; body: any };
};

const role = (r: string, value?: string) => ({ by: "role", role: r, ...(value ? { value, exact: true } : {}) });
const SPECS = [
    { title: "Adding to the cart works", kind: "web", category: "Shop", steps: [{ action: "navigate", url: "/cart" }, { action: "click", locator: role("button", "Add to cart") }, { action: "assert", check: "text", locator: role("status"), expected: "Added" }] },
    { title: "The boom page shows its heading", kind: "web", category: "Shop", steps: [{ action: "navigate", url: "/boom" }, { action: "assert", check: "visible", expected: "Never shown anywhere" }] },
    { title: "The home page loads", kind: "web", category: "Shop", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "text", locator: role("heading"), expected: "Evidence home" }] },
];

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    fx = await startEvidenceApp(FX_PORT);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-evidence-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "1" }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 200);
    worker.start();
    base = `http://127.0.0.1:${PLATFORM_PORT}`;

    projectId = (await call("POST", "/api/projects", { name: "Evidence UI" })).body.id;
    const imported = await call("POST", `/api/projects/${projectId}/specs`, { specs: SPECS, baseUrl: FX });
    expect(imported.status).toBe(202);
    (imported.body.tests as Array<{ id: string }>).forEach((t, i) => (ids[["cart", "boom", "home"][i]!] = t.id));
    for (let i = 0; i < 360; i++) {
        const j = (await call("GET", `/api/test-generation/${imported.body.jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) break;
        await new Promise((r) => setTimeout(r, 500));
    }
    // The boom test stands for a failed run from before evidence existed: its evidence row is removed.
    platform.db.run("DELETE FROM artifacts WHERE kind = 'evidence' AND test_case_id = ?", ids.boom);
    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
}, 240_000);

afterAll(async () => {
    await browser?.close();
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    fx?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const section = () => page.getByRole("region", { name: "What the page did", exact: true });

describe("failure evidence in the UI", () => {
    it("a failed test explains what the page did: the sentence, the failing request, the console error", async () => {
        await page.goto(`${base}/#/tests/${ids.cart}`);
        await pwExpect(section()).toBeVisible();
        await pwExpect(section().getByTestId("evidence-summary")).toContainText("1 request failed: POST /api/cart answered 500");
        await pwExpect(section().getByTestId("evidence-summary")).toContainText("the page made");
        const failed = section().getByRole("table", { name: "Requests that failed or were slow", exact: true });
        await pwExpect(failed.getByRole("row", { name: /POST \/api\/cart/ })).toContainText("Answered 500");
        await pwExpect(failed.getByRole("row", { name: /POST \/api\/cart/ })).toContainText("During step 2, just before it failed");
        const errors = section().getByRole("list", { name: "Console errors", exact: true });
        await pwExpect(errors).toContainText("Could not add to cart: the server answered 500");
        // never a body: the request body the page sent is not on the screen
        await pwExpect(page.getByText("EVID-RequestBody")).toHaveCount(0);
    });

    it("lists all requests behind a disclosure, with a filter", async () => {
        await section().getByText("Show all requests", { exact: false }).click();
        const all = section().getByRole("table", { name: "All recorded requests", exact: true });
        await pwExpect(all).toBeVisible();
        const before = await all.getByRole("row").count();
        expect(before).toBeGreaterThan(2);
        await section().getByRole("searchbox", { name: "Filter requests", exact: true }).fill("/api/cart");
        await pwExpect(all.getByRole("row")).toHaveCount(2); // header + the one request
        await section().getByRole("searchbox", { name: "Filter requests", exact: true }).fill("no-such-address");
        await pwExpect(section().getByText("No request matches.")).toBeVisible();
        await section().getByRole("searchbox", { name: "Filter requests", exact: true }).fill("");
        await section().getByRole("button", { name: /^Failed/ }).click();
        await pwExpect(all.getByRole("row", { name: /POST \/api\/cart/ })).toBeVisible();
        await pwExpect(section().getByRole("button", { name: /^Failed/ })).toHaveAttribute("aria-pressed", "true");
    });

    it("has no serious accessibility problems in light and dark, and fits a phone screen", async () => {
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.waitForTimeout(400); // colours ease over 140ms when the scheme flips; audit the settled state
            const result = await new AxeBuilder({ page }).include('[data-testid="page-evidence"]').analyze();
            expect(result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.help}`), scheme).toEqual([]);
        }
        await page.emulateMedia({ colorScheme: "light" });
        await page.setViewportSize({ width: 375, height: 800 });
        await pwExpect(section()).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await page.setViewportSize({ width: 1280, height: 900 });
    });

    it("a failed run without recorded details says why there is nothing to show", async () => {
        await page.goto(`${base}/#/tests/${ids.boom}`);
        await pwExpect(section()).toBeVisible();
        await pwExpect(section().getByTestId("evidence-empty")).toContainText("No network or console details were recorded for this run");
        await pwExpect(section().getByTestId("evidence-summary")).toHaveCount(0);
    });

    it("a passing test has no such section", async () => {
        await page.goto(`${base}/#/tests/${ids.home}`);
        await pwExpect(page.getByRole("heading", { name: "The home page loads", exact: true })).toBeVisible();
        await pwExpect(section()).toHaveCount(0);
    });
});
