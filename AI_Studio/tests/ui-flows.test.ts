/**
 * Two UI flows that the main journey test does not reach, driven in a real browser:
 *  1. A server protected by an API key: the key screen, a wrong key, the right key, and no data leaking before it.
 *  2. Visual change review: a changed page shows the diff, "Accept new screenshot" is clicked in the UI and the
 *     test ends up passing again.
 * Requires `npm run build:web`.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { expect as pwExpect } from "@playwright/test";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright";

/** UI_BROWSER=chromium|firefox|webkit (default chromium). The platform's own validation runs always use Chromium. */
const uiBrowser = { chromium, firefox, webkit }[(process.env.UI_BROWSER ?? "chromium") as "chromium"];
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { loadDriftRuntime } from "../src/engine/contracts/drift.js";
import { recordObservations } from "../src/platform/drift-store.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { recordMetrics } from "../src/platform/perf-store.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const KEY = "correct-horse-battery";
const FIXTURE_PORT = 8791;
const KEYED_PORT = 8792;
const OPEN_PORT = 8793;

let browser: Browser;
const cleanup: Array<() => Promise<void> | void> = [];

async function start(port: number, extra: Record<string, string>, withWorker: boolean) {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-uiflow-"));
    const platform: Platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(port), ...extra }));
    const server = await buildServer(platform);
    await server.listen({ port, host: "127.0.0.1" });
    const worker = withWorker ? new Worker(platform, 200) : undefined;
    worker?.start();
    cleanup.push(async () => {
        await worker?.stop();
        await server.close();
        platform.db.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });
    return { platform, base: `http://127.0.0.1:${port}` };
}

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: run `npm run build:web` first");
    // UI_CHANNEL=chrome|msedge: the installed Google Chrome or Microsoft Edge instead of Playwright's Chromium (scripts/ui-browsers.mjs).
    browser = await uiBrowser.launch(process.env.UI_CHANNEL ? { channel: process.env.UI_CHANNEL } : {});
}, 30_000);
afterAll(async () => {
    await browser?.close();
    for (const c of cleanup.reverse()) await c();
});

describe("API-key protected server", () => {
    let page: Page;
    let base: string;
    beforeAll(async () => {
        ({ base } = await start(KEYED_PORT, { API_KEY: KEY }, false));
        page = await browser.newPage();
    });

    it("asks for the key before showing anything, and explains a wrong key", async () => {
        await page.goto(base);
        await pwExpect(page.getByRole("heading", { name: "Enter the access key" })).toBeVisible();
        await pwExpect(page.getByText("Projects", { exact: true })).toHaveCount(0); // no app chrome or data before the key
        await page.getByLabel("Access key").fill("wrong-key");
        await page.getByRole("button", { name: "Continue" }).click();
        await pwExpect(page.getByText("That access key wasn’t accepted")).toBeVisible();
    });

    it("opens the app with the right key and remembers it", async () => {
        await page.getByLabel("Access key").fill(KEY);
        await page.getByRole("button", { name: "Continue" }).click();
        await pwExpect(page.getByRole("heading", { name: "Test any web application automatically" })).toBeVisible();
        await page.reload();
        await pwExpect(page.getByRole("heading", { name: "Test any web application automatically" })).toBeVisible();
        // Settings has no second place to enter the key: the sign-in screen is where it goes.
        await page.getByRole("link", { name: "Settings", exact: true }).click();
        await pwExpect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
        await pwExpect(page.getByText("Access to this platform")).toHaveCount(0);
    });
});

describe("visual change review in the UI", () => {
    let page: Page;
    let base: string;
    let variant = "a";
    const fixture = http.createServer((_req, res) => {
        const b = variant === "b";
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><body style="margin:0;font:28px sans-serif"><header style="background:${b ? "#b91c1c" : "#1f2937"};color:#fff;padding:24px">${b ? "Spring SALE" : "Welcome to the shop"}</header><p style="padding:24px">Static content.</p></body>`);
    });

    beforeAll(async () => {
        await new Promise<void>((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r));
        cleanup.push(() => void fixture.close());
        ({ base } = await start(OPEN_PORT, {}, true));
        page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    });

    /** The platform runs one job per project; wait until the previous one has fully closed. */
    async function waitIdle(projectId: string) {
        for (let i = 0; i < 60; i++) {
            const jobs = (await (await fetch(`${base}/api/projects/${projectId}/jobs`)).json()) as Array<{ status: string }>;
            if (jobs.every((j) => ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status))) return;
            await new Promise((r) => setTimeout(r, 250));
        }
        throw new Error("project never became idle");
    }

    async function runAgain(projectId: string) {
        await waitIdle(projectId);
        await page.getByRole("button", { name: "Run again" }).click();
        // The run strip says it is running (this replaced the old "Running…" button label), then how it ended.
        await pwExpect(page.getByTestId("run-strip")).toBeVisible();
        await pwExpect(page.getByRole("region", { name: "Run finished" })).toBeVisible({ timeout: 60_000 });
    }

    it("captures a baseline, flags a change with evidence, and accepts the new screenshot", async () => {
        // a visual test imported into a fresh project
        const spec = { title: "Home looks unchanged", kind: "web", category: "Visual", type: "visual", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "screenshot", expected: 100 }] };
        // start from an empty project: create it via the API, then import through the UI
        const project = (await (await fetch(`${base}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Visual UI" }) })).json()) as { id: string };
        await page.goto(`${base}/?x=1#/projects/${project.id}/scripts`);
        await pwExpect(page.getByRole("heading", { name: "Scripts", exact: true })).toBeVisible();
        const res = await fetch(`${base}/api/projects/${project.id}/specs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ specs: [spec], baseUrl: `http://127.0.0.1:${FIXTURE_PORT}` }) });
        expect(res.status).toBe(202);
        await page.reload();
        const row = page.locator(".script-row", { hasText: "Home looks unchanged" });
        await pwExpect(row.getByText("Passing", { exact: true })).toBeVisible({ timeout: 60_000 }); // baseline captured + stability check
        await row.locator("a.sr-title").click();

        variant = "b"; // the page changes
        await runAgain(project.id);
        await pwExpect(page.getByText("This test found something that needs a look")).toBeVisible();
        await pwExpect(page.getByText("Low severity").first()).toBeVisible();
        await pwExpect(page.getByRole("img", { name: "Differences highlighted in red" })).toBeVisible();
        await pwExpect(page.getByText("New screenshot", { exact: true })).toBeVisible();

        await page.getByRole("button", { name: "Accept new screenshot" }).click();
        await pwExpect(page.getByText("This test is passing")).toBeVisible({ timeout: 60_000 });
        await pwExpect(page.getByRole("button", { name: "Accept new screenshot" })).toHaveCount(0);
    }, 180_000);
});

describe("large suites", () => {
    it("pages long areas, keeps counts honest, and stays quick", async () => {
        const { base } = await start(4193, {}, false);
        const project = (await (await fetch(`${base}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Big" }) })).json()) as { id: string };
        const specs = Array.from({ length: 120 }, (_, i) => ({
            title: `Endpoint ${String(i + 1).padStart(3, "0")} responds`,
            kind: "api",
            category: "API · Bulk",
            steps: [{ action: "request", method: "GET", path: `/api/item/${i}` }, { action: "assertResponse", check: "statusClass", expected: "2xx" }],
        }));
        const res = await fetch(`${base}/api/projects/${project.id}/specs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ specs, baseUrl: "http://127.0.0.1:9", validate: false }) });
        expect(res.status).toBe(202);

        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await page.goto(`${base}/#/projects/${project.id}/scripts`);
        await pwExpect(page.getByText("120 tests", { exact: false }).first()).toBeVisible();
        await pwExpect(page.locator(".script-row")).toHaveCount(50);
        await pwExpect(page.getByText("Showing 50 of 120")).toBeVisible();
        await page.getByRole("button", { name: "Show 50 more" }).click();
        await pwExpect(page.locator(".script-row")).toHaveCount(100);
        await page.getByRole("button", { name: "Show 20 more" }).click();
        await pwExpect(page.locator(".script-row")).toHaveCount(120);
        await pwExpect(page.getByRole("button", { name: /Show \d+ more/ })).toHaveCount(0);
        // the area header still reports the full count
        await pwExpect(page.getByText("120 tests · 0 passing").first()).toBeVisible();
        // searching narrows within all 120, not just the visible page
        await page.getByPlaceholder("Search scripts").fill("Endpoint 119");
        await pwExpect(page.locator(".script-row")).toHaveCount(1);
        await page.close();
    }, 60_000);
});

describe("compliance coverage", () => {
    it("shows the mapping per framework and the relevant controls on a test", async () => {
        const { base } = await start(4194, {}, false);
        const project = (await (await fetch(`${base}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Compliance UI" }) })).json()) as { id: string };
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

        await page.goto(`${base}/#/projects/${project.id}/compliance`);
        await pwExpect(page.getByText("No tests to map yet")).toBeVisible(); // empty state

        const spec = { title: "Login rejects a wrong password", kind: "api", category: "API · Authentication", steps: [{ action: "request", method: "POST", path: "/api/auth/login" }, { action: "assertResponse", check: "statusClass", expected: "4xx" }] };
        const res = await fetch(`${base}/api/projects/${project.id}/specs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ specs: [spec], baseUrl: "http://127.0.0.1:9", validate: false }) });
        expect(res.status).toBe(202);

        await page.reload();
        await pwExpect(page.getByText("not a compliance assessment or certification")).toBeVisible();
        await pwExpect(page.getByRole("button", { name: /NIST 800-53/ })).toHaveAttribute("aria-pressed", "true");
        const control = page.locator('[data-control="NIST-IA-2"]');
        await pwExpect(control.getByText("No tests yet", { exact: true })).toBeVisible(); // mapped, but not validated yet
        await pwExpect(control.getByRole("link", { name: "Login rejects a wrong password" })).toBeVisible();

        await page.getByRole("button", { name: /HIPAA/ }).click();
        await pwExpect(page.getByRole("button", { name: /HIPAA/ })).toHaveAttribute("aria-pressed", "true");
        await pwExpect(page.locator('[data-control="NIST-IA-2"]')).toHaveCount(0);

        await page.getByRole("button", { name: /NIST 800-53/ }).click();
        await control.getByRole("link", { name: "Login rejects a wrong password" }).click();
        // a functional test's own page no longer lists generic controls; the Compliance tab is the place for them
        await pwExpect(page.getByTestId("controls")).toHaveCount(0);
        await page.close();
    }, 60_000);
});

describe("mobile testing", () => {
    it("explains the missing emulator, saves the app (package and APK), and lets a mobile test be run", async () => {
        // Hide any Android toolchain on this machine so the "not set up" states are what is tested.
        const keep = { h: process.env.TAQWRIGHT_HOME, a: process.env.ANDROID_AVD_HOME, s: process.env.ANDROID_HOME };
        const nowhere = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-nomobile-"));
        process.env.TAQWRIGHT_HOME = path.join(nowhere, "none");
        process.env.ANDROID_AVD_HOME = path.join(nowhere, "avd");
        process.env.ANDROID_HOME = "";
        try {
            const { base } = await start(4195, {}, false);
            const project = (await (await fetch(`${base}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Mobile UI" }) })).json()) as { id: string };
            const spec = { title: "Network settings are listed", kind: "mobile", category: "Mobile · Settings", steps: [{ action: "assert", check: "visible", locator: { by: "text", value: "Network & internet" } }] };
            const res = await fetch(`${base}/api/projects/${project.id}/specs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ specs: [spec], validate: false, mobile: { appPackage: "com.android.settings" } }) });
            expect(res.status).toBe(202);

            const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

            // Settings explains what is missing and how to fix it (round 45: the emulator panel is back in Settings, the Runners page is gone)
            await page.goto(`${base}/#/settings`);
            await pwExpect(page.getByTestId("mobile-tooling").getByRole("heading", { name: "Mobile tooling on this computer" })).toBeVisible();
            // A one-step setup download for each kind of computer, with the command line as the alternative.
            const setup = page.getByTestId("emulator-setup");
            await pwExpect(setup.getByRole("button", { name: "Download for Windows" })).toBeVisible();
            await pwExpect(setup.getByRole("button", { name: "Download for Mac or Linux" })).toBeVisible();
            await pwExpect(setup.getByText("npx @taqwright/taqwright install --with-avd")).toBeVisible();
            await pwExpect(page.getByText("isn’t set up on this computer yet")).toBeVisible();

            // The app panel opens from Settings > Mobile app (behind "Change"), shows the saved package, and saves changes
            await page.goto(`${base}/#/projects/${project.id}/settings?section=mobile`);
            await page.getByRole("button", { name: "Change mobile app", exact: true }).click();
            const panel = page.getByRole("region", { name: "Mobile app" });
            await pwExpect(panel.getByText("This computer can’t run mobile tests yet")).toBeVisible();
            await pwExpect(panel.getByLabel("App package")).toHaveValue("com.android.settings");
            await panel.getByLabel("App package").fill("com.example.shop");
            await panel.getByRole("button", { name: "Save" }).click();
            await pwExpect(panel.getByText("Saved. Mobile tests will use this app.")).toBeVisible();

            // An APK is uploaded through the same panel
            const apk = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40), Buffer.from("AndroidManifest.xml"), Buffer.alloc(60)]);
            await panel.locator("#app-apk").setInputFiles({ name: "shop.apk", mimeType: "application/vnd.android.package-archive", buffer: apk });
            await panel.getByRole("button", { name: "Save" }).click();
            await pwExpect(panel.getByText("Uploaded app: app.apk")).toBeVisible();
            const detail = (await (await fetch(`${base}/api/projects/${project.id}`)).json()) as { mobile: { appPackage: string; apk: string } };
            expect(detail.mobile).toMatchObject({ appPackage: "com.example.shop", apk: "app.apk" });

            // A non-APK is refused with a plain explanation
            await panel.locator("#app-apk").setInputFiles({ name: "notes.apk", mimeType: "application/octet-stream", buffer: Buffer.from("hello") });
            await panel.getByRole("button", { name: "Save" }).click();
            await pwExpect(panel.getByText("doesn't look like an Android app")).toBeVisible();

            // The mobile test page can be run and says what it needs
            await page.goto(`${base}/#/projects/${project.id}/scripts`);
            await page.locator("a.sr-title", { hasText: "Network settings are listed" }).click();
            await pwExpect(page.getByText("This mobile test hasn’t been run yet.")).toBeVisible();
            await pwExpect(page.getByRole("button", { name: "Run again" })).toBeVisible();
            await page.getByRole("button", { name: "Run again" }).click();
            // no emulator here: the server says why instead of pretending
            await pwExpect(page.getByText(/taqwright install/)).toBeVisible();
            await page.close();
        } finally {
            for (const [k, v] of [["TAQWRIGHT_HOME", keep.h], ["ANDROID_AVD_HOME", keep.a], ["ANDROID_HOME", keep.s]] as const) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
            fs.rmSync(nowhere, { recursive: true, force: true });
        }
    }, 90_000);
});

describe("weak tests", () => {
    it("badges tests that check very little, filters them, and explains why on the test page", async () => {
        const { base } = await start(4196, {}, false);
        const project = (await (await fetch(`${base}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Weak UI" }) })).json()) as { id: string };
        const click = { action: "click", locator: { by: "role", role: "button", value: "Add to cart" } };
        const specs = [
            { title: "Cart count updates", kind: "web", category: "Cart", steps: [{ action: "navigate", url: "/" }, click, { action: "assert", check: "text", locator: { by: "css", value: "#count" }, expected: "1" }] },
            { title: "Opens the shop page", kind: "web", category: "Cart", steps: [{ action: "navigate", url: "/" }] },
        ];
        const res = await fetch(`${base}/api/projects/${project.id}/specs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ specs, baseUrl: "http://127.0.0.1:9", validate: false }) });
        expect(res.status).toBe(202);

        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await page.goto(`${base}/#/projects/${project.id}/scripts`);
        await pwExpect(page.locator(".script-row")).toHaveCount(2);
        await pwExpect(page.locator(".script-row", { hasText: "Opens the shop page" }).getByText("Weak checks", { exact: true })).toBeVisible();
        await pwExpect(page.locator(".script-row", { hasText: "Cart count updates" }).getByText("Weak checks", { exact: true })).toHaveCount(0);

        await page.getByRole("button", { name: /Weak checks/ }).click();
        await pwExpect(page.locator(".script-row")).toHaveCount(1);
        await page.locator("a.sr-title").click();
        // Round 38: the title opens the DSL tab; the note about weak checks is on the Steps tab.
        await page.getByRole("tab", { name: "Steps", exact: true }).click();
        await pwExpect(page.getByText("This test checks very little")).toBeVisible();
        await pwExpect(page.getByTestId("quality-reasons")).toContainText("never checks anything");

        // the same filter opens straight from a link
        await page.goto(`${base}/#/projects/${project.id}/scripts?quality=weak`);
        await pwExpect(page.locator(".script-row")).toHaveCount(1);
        await page.close();
    }, 60_000);
});

describe("page speed", () => {
    it("shows what was measured against the budgets on the test page, and the slowest pages on the overview", async () => {
        const fixture = http.createServer((req, res) => {
            const slow = req.url?.startsWith("/slow");
            setTimeout(() => {
                res.writeHead(200, { "content-type": "text/html" });
                res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${slow ? "Slow" : "Fast"}</title></head><body><h1>${slow ? "Slow page" : "Fast page"}</h1></body></html>`);
            }, slow ? 700 : 0);
        });
        await new Promise<void>((r) => fixture.listen(5301, "127.0.0.1", r));
        cleanup.push(() => void fixture.close());
        const { base } = await start(4197, {}, true);
        const project = (await (await fetch(`${base}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Speed UI" }) })).json()) as { id: string };
        const speed = (title: string, p: string, budgets: string) => ({ title, kind: "web", category: "Performance", type: "performance", priority: "high", source: { origin: "performance-check" }, steps: [{ action: "navigate", url: p }, { action: "assert", check: "pageSpeed", expected: budgets }] });
        const res = await fetch(`${base}/api/projects/${project.id}/specs`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ specs: [speed("Fast page loads quickly", "/fast", "ttfb:500"), speed("Slow page loads quickly", "/slow", "ttfb:300")], baseUrl: "http://127.0.0.1:5301" }),
        });
        expect(res.status).toBe(202);

        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await page.goto(`${base}/#/projects/${project.id}/scripts`);
        const slowRow = page.locator(".script-row", { hasText: "Slow page loads quickly" });
        await pwExpect(slowRow.getByText("Needs a look", { exact: true })).toBeVisible({ timeout: 120_000 });
        await pwExpect(page.locator(".script-row", { hasText: "Fast page loads quickly" }).getByText("Passing", { exact: true })).toBeVisible();

        await slowRow.locator("a.sr-title").click();
        const card = page.getByTestId("page-speed");
        await pwExpect(card.getByText("Page speed", { exact: true })).toBeVisible();
        const ttfb = card.locator('[data-metric="ttfb"]');
        await pwExpect(ttfb.getByText("Server starts responding")).toBeVisible();
        await pwExpect(ttfb.getByText("Over budget")).toBeVisible(); // words, not only colour
        await pwExpect(ttfb.getByText("budget 300 ms")).toBeVisible();
        await pwExpect(page.getByText("The server takes").first()).toBeVisible(); // the finding in plain language

        await page.goto(`${base}/#/projects/${project.id}`);
        const slowest = page.getByTestId("slowest-pages");
        await pwExpect(slowest.getByText("Slowest pages")).toBeVisible();
        await pwExpect(slowest.locator("a.list-row").first()).toContainText("Slow page loads quickly");
        await page.close();
    }, 180_000);
});

describe("project report download", () => {
    it("downloads the report as a PDF and as a web page from the Tests menu", async () => {
        const { base } = await start(4199, {}, false);
        const project = (await (await fetch(`${base}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Report UI" }) })).json()) as { id: string };
        const spec = { title: "Cart count updates", kind: "web", category: "Cart", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "text", locator: { by: "css", value: "#count" }, expected: "1" }] };
        await fetch(`${base}/api/projects/${project.id}/specs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ specs: [spec], baseUrl: "http://127.0.0.1:9", validate: false }) });

        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await page.goto(`${base}/#/projects/${project.id}/scripts`);
        await pwExpect(page.locator(".script-row")).toHaveCount(1);

        // Every download is in one place now: More actions > Export…
        const open = async () => {
            await page.getByRole("button", { name: "More actions" }).click();
            await page.getByRole("menuitem", { name: "Export…", exact: true }).click();
        };
        await open();
        const [pdf] = await Promise.all([page.waitForEvent("download"), page.getByRole("dialog", { name: "Export", exact: true }).getByRole("button", { name: "Download PDF", exact: true }).click()]);
        // Saved under the name the server gives it: report-<project>-<date>.pdf.
        expect(pdf.suggestedFilename()).toMatch(/^report-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.pdf$/);
        const pdfBytes = fs.readFileSync((await pdf.path())!);
        expect(pdfBytes.subarray(0, 5).toString()).toBe("%PDF-");

        await open();
        const [html] = await Promise.all([page.waitForEvent("download"), page.getByRole("dialog", { name: "Export", exact: true }).getByRole("button", { name: "Download web page", exact: true }).click()]);
        expect(fs.readFileSync((await html.path())!, "utf8")).toContain("<title>Report UI — test report</title>");
        await page.close();
    }, 90_000);
});

describe("input handling option", () => {
    it("is no longer a switch on the form: the exploration keeps it on by default (the Test Case Generation Agent runs it)", async () => {
        const { base } = await start(4200, {}, false);
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await page.goto(`${base}/#/new?url=http://example.com`);
        await pwExpect(page.getByRole("heading", { name: "Create a test project" })).toBeVisible();
        await pwExpect(page.getByLabel(/^Focus/)).toBeVisible();
        await pwExpect(page.getByRole("checkbox", { name: /Check how forms handle unusual input/ })).toHaveCount(0);
        await pwExpect(page.locator("summary", { hasText: "Advanced options" })).toHaveCount(0);
        expect(DEFAULT_JOB_OPTIONS.inputChecks).toBe(true);
        await page.close();
    }, 60_000);
});

describe("API response speed", () => {
    it("shows typical, 95th-percentile and slowest response times against the budget on an API test's page", async () => {
        const { platform, base } = await start(4202, {}, false);
        const { repo } = platform;
        const projectId = repo.createProject({ name: "API speed UI" }).id as string;
        repo.createApplication(projectId, "http://127.0.0.1:9", {});
        const spec = TestSpecSchema.parse({
            testId: "API-001",
            title: "GET /api/slow: responds quickly",
            kind: "api",
            category: "Performance",
            type: "performance",
            steps: [{ action: "request", method: "GET", path: "/api/slow", auth: "default" }, { action: "assertResponse", check: "latency", expected: "p95:130" }],
            source: { origin: "performance-check" },
        });
        const id = repo.insertTest({ projectId, suiteId: repo.getOrCreateSuite(projectId, "Performance", "performance"), jobId: null, spec, framework: "playwright-api", validationStatus: "NEEDS_REVIEW" });
        repo.updateTest(id, { validationStatus: "NEEDS_REVIEW", reason: "API speed check failed: 1 measurement is over budget for this endpoint (4 requests, one at a time)\n- [medium] 95% of responses arrive within 317 ms (budget 130 ms); typically 284 ms, slowest 317 ms" });
        const exec = repo.addExecution({ testId: id, scriptId: null, jobId: null, attempt: 1, status: "failed", durationMs: 1500, startedAt: new Date().toISOString(), steps: [] });
        await recordMetrics(repo.db.sql, { projectId, testId: id, executionId: exec, samples: [{ metric: "p50", value: 284, unit: "ms" }, { metric: "p95", value: 317, unit: "ms", budget: 130 }, { metric: "max", value: 317, unit: "ms" }] });

        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await page.goto(`${base}/#/tests/${id}`);
        const card = page.getByTestId("page-speed");
        await pwExpect(card.getByText("Response speed", { exact: true })).toBeVisible();
        await pwExpect(card.getByText("one request at a time")).toBeVisible();
        await pwExpect(card.locator('[data-metric="p50"]').getByText("Typical response time")).toBeVisible();
        const p95 = card.locator('[data-metric="p95"]');
        await pwExpect(p95.getByText("95% of responses within")).toBeVisible();
        await pwExpect(p95.getByText("317 ms")).toBeVisible();
        await pwExpect(p95.getByText("budget 130 ms")).toBeVisible();
        await pwExpect(p95.getByText("Over budget")).toBeVisible();
        await pwExpect(card.locator('[data-metric="max"]').getByText("Slowest response")).toBeVisible();
        await pwExpect(page.getByText("API speed:").first()).toBeVisible(); // the finding in plain words
        await page.close();
    }, 60_000);
});

describe("test accounts", () => {
    it("adds accounts, keeps secrets write-only, and lets a saved secret be removed", async () => {
        const { base } = await start(4203, {}, false);
        const project = (await (await fetch(`${base}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Accounts UI" }) })).json()) as { id: string };
        const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
        await page.goto(`${base}/#/projects/${project.id}/scripts`);
        const open = async () => {
            await page.goto(`${base}/#/projects/${project.id}/settings?section=accounts`);
            return page.getByRole("region", { name: "Test accounts" });
        };
        let panel = await open();
        await pwExpect(panel.getByText("No test accounts yet.")).toBeVisible();
        await pwExpect(panel.getByRole("button", { name: "Save accounts" })).toBeEnabled(); // nothing to save is fine

        await panel.getByRole("button", { name: "Add an account" }).click();
        await pwExpect(panel.getByText("Every account needs a username.")).toBeVisible(); // plain-language hints, not a failed save
        await pwExpect(panel.getByRole("button", { name: "Save accounts" })).toBeDisabled();
        await panel.getByLabel("Name", { exact: true }).fill("user");
        await panel.getByLabel("Username or email").fill("user@example.com");
        await panel.getByLabel("Password", { exact: true }).fill("pw-user-1");

        await panel.getByRole("button", { name: "Add an account" }).click();
        const second = panel.locator("fieldset").nth(1);
        await second.getByLabel("Name", { exact: true }).fill("admin");
        await second.getByLabel("Username or email").fill("admin@example.com");
        await second.getByLabel("Password", { exact: true }).fill("pw-admin-1");
        await second.getByLabel("Authenticator secret (optional)").fill("JBSWY3DPEHPK3PXP");
        await panel.getByRole("button", { name: "Save accounts" }).click();
        await pwExpect(panel.getByText("Saved. The next exploration uses these accounts for access-control checks.")).toBeVisible();

        // what the server holds: names and flags only
        const roles = (await (await fetch(`${base}/api/projects/${project.id}/roles`)).json()) as { roles: Array<Record<string, unknown>> };
        expect(roles.roles).toEqual([
            { name: "user", username: "user@example.com", hasPassword: true, hasTotp: false, hasApiToken: false },
            { name: "admin", username: "admin@example.com", hasPassword: true, hasTotp: true, hasApiToken: false },
        ]);

        // reopening: the fields show that a secret is saved, never the secret
        await page.reload();
        panel = await open();
        const admin = panel.locator("fieldset").nth(1);
        await pwExpect(admin.getByLabel("Name", { exact: true })).toHaveValue("admin");
        await pwExpect(admin.getByLabel("Password", { exact: true })).toHaveValue("");
        await pwExpect(admin.getByLabel("Password", { exact: true })).toHaveAttribute("placeholder", "Saved — leave empty to keep");
        await pwExpect(admin.getByLabel("Authenticator secret (optional)")).toHaveValue("");
        expect(await page.content()).not.toMatch(/pw-admin-1|pw-user-1|JBSWY3DPEHPK3PXP/);

        // remove the admin's saved authenticator secret, keep its password
        await admin.getByRole("button", { name: "Remove the authenticator secret" }).click();
        await panel.getByRole("button", { name: "Save accounts" }).click();
        await pwExpect(panel.getByText("Saved. The next exploration")).toBeVisible();
        const after = (await (await fetch(`${base}/api/projects/${project.id}/roles`)).json()) as { roles: Array<{ name: string; hasPassword: boolean; hasTotp: boolean }> };
        expect(after.roles.find((r) => r.name === "admin")).toMatchObject({ hasPassword: true, hasTotp: false });

        // remove an account
        await panel.getByRole("button", { name: "Remove account user" }).click();
        await panel.getByRole("button", { name: "Save accounts" }).click();
        await pwExpect(panel.getByText("Saved. The next exploration")).toBeVisible();
        expect(((await (await fetch(`${base}/api/projects/${project.id}/roles`)).json()) as { roles: unknown[] }).roles).toHaveLength(1);
        await page.close();
    }, 90_000);
});

describe("API changes on the overview", () => {
    it("lists what the API changed since the previous run: breaking first, a short list that expands, calm when nothing changed, and an error that can be retried", async () => {
        const { platform, base } = await start(5438, {}, false);
        const rt = loadDriftRuntime();
        const fields = (names: string[]) => Object.fromEntries(names.map((n) => [n, "value"]));
        const eight = Array.from({ length: 8 }, (_, i) => `field${i + 1}`);
        const before = [{ id: 1, ...fields(eight) }];
        const after = [{ id: 1, nickname: "n" }];

        /** A finished project whose runs (oldest first) answered with the given bodies for GET /api/users. */
        async function projectWith(name: string, bodies: unknown[]) {
            const project = (await (await fetch(`${base}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) })).json()) as { id: string };
            const app = platform.repo.createApplication(project.id, "http://127.0.0.1:9", {});
            for (const body of bodies) {
                const job = await platform.repo.createJob(project.id, app, { ...DEFAULT_JOB_OPTIONS, targets: ["api"] });
                platform.db.run("UPDATE generation_jobs SET status = 'COMPLETED', finished_at = ? WHERE id = ?", new Date().toISOString(), job.id);
                recordObservations(platform.db, { projectId: project.id, jobId: job.id, responses: [{ method: "GET", path: "/api/users", status: 200, obs: rt.driftShape(body) }] });
            }
            return project.id;
        }
        const open = async (page: Page, id: string) => {
            const answered = page.waitForResponse((r) => r.url().includes("/api-changes"));
            await page.goto(`${base}/#/projects/${id}`);
            await pwExpect(page.getByText("Last explored", { exact: true })).toBeVisible();
            await answered;
        };

        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

        // one run only: nothing to compare, so no card at all
        const single = await projectWith("One run", [before]);
        await open(page, single);
        await pwExpect(page.getByTestId("api-changes")).toHaveCount(0);

        // two runs with changes
        const changed = await projectWith("Changed API", [before, after]);
        await open(page, changed);
        const card = page.getByTestId("api-changes");
        await pwExpect(card.getByRole("heading", { name: "API changes", exact: true })).toBeVisible();
        await pwExpect(card.getByText("8 changes that can break existing clients", { exact: true })).toBeVisible();
        const breaking = card.getByTestId("api-changes-breaking");
        await pwExpect(breaking.locator("li.api-change >> visible=true")).toHaveCount(6); // a short list first (the rest sits in a closed section)
        await pwExpect(breaking.getByText("response field [].field1 was removed", { exact: true })).toBeVisible();
        await breaking.locator("summary", { hasText: "Show 2 more" }).click();
        await pwExpect(breaking.locator("li.api-change >> visible=true")).toHaveCount(8);
        await pwExpect(breaking.getByText("response field [].field8 was removed", { exact: true })).toBeVisible();
        await pwExpect(card.getByTestId("api-changes-other").getByText("new response field [].nickname", { exact: true })).toBeVisible();
        await pwExpect(card.getByTestId("api-changes-other").locator("code").first()).toHaveText("GET /api/users");

        // small screens: no sideways scrolling
        await page.setViewportSize({ width: 390, height: 800 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.setViewportSize({ width: 1280, height: 900 });

        // two runs, nothing changed
        const same = await projectWith("Same API", [before, before]);
        await open(page, same);
        await pwExpect(page.getByTestId("api-changes").getByText("The API answered the same way as in the previous run", { exact: false })).toBeVisible();
        await pwExpect(page.getByTestId("api-changes").getByText("can break existing clients")).toHaveCount(0);

        // the comparison cannot be loaded: say so and let the person retry
        await page.route("**/api-changes", (route) => route.abort());
        await page.goto(`${base}/#/projects/${changed}`);
        await page.reload();
        await pwExpect(page.getByText("Could not check the API for changes", { exact: true })).toBeVisible();
        await page.unroute("**/api-changes");
        await page.getByRole("button", { name: "Try again", exact: true }).click();
        await pwExpect(page.getByTestId("api-changes-breaking")).toBeVisible();
        await page.close();
    }, 120_000);
});
