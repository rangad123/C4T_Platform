/**
 * Version history in the step editor, in a real browser against a real platform (worker, sample app, real API):
 * edit twice and save, open the history, compare versions step by step, restore the first one with the keyboard and follow the run
 * to Passed, the unsaved-changes warning, the empty state, axe in light and dark, 375 px.
 * Ports: 6190 sample app, 6191 platform (it serves web/dist too).
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/builder-history-ui.test.ts
 * Set BUILDER_SHOTS=<folder> to also write screenshots.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
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

const APP_PORT = 6190;
const PORT = 6191;
const APP = `http://127.0.0.1:${APP_PORT}`;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let sample: ChildProcess;
let platform: Platform;
let worker: Worker;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let projectId = "";
let webId = "";
let apiId = "";
const consoleErrors: string[] = [];

const api = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never, headers: payload !== undefined ? { "content-type": "application/json" } : {} });
    return { status: res.statusCode, body: res.body && (res.body.startsWith("{") || res.body.startsWith("[")) ? JSON.parse(res.body) : res.body };
};

const searchSpec = {
    title: "Search finds products",
    kind: "web",
    category: "Shop",
    steps: [
        { action: "navigate", url: "/products" },
        { action: "fill", locator: { by: "label", value: "Search products" }, value: "boot" },
        { action: "click", locator: { by: "role", role: "button", value: "Search" } },
        { action: "assert", check: "text", expected: "products" },
    ],
};
const apiSpec = { title: "List products answers", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/api/products" }, { action: "assertResponse", check: "status", expected: 200 }] };

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    sample = spawn(process.execPath, [path.join(REPO_ROOT, "examples/sample-app/server.mjs"), String(APP_PORT)], { stdio: "ignore" });
    for (let i = 0; i < 40; i++) {
        try {
            if ((await fetch(APP + "/")).ok) break;
        } catch {
            await sleep(150);
        }
    }
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-builder-history-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0", HOST: "127.0.0.1", PORT: String(PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 200);
    worker.start();

    projectId = (await api("POST", "/api/projects", { name: "Atlas shop" })).body.id;
    const imp = await api("POST", `/api/projects/${projectId}/specs`, { specs: [searchSpec, apiSpec], baseUrl: APP, validate: false });
    expect(imp.status).toBe(202);
    webId = imp.body.tests[0].id;
    apiId = imp.body.tests[1].id;

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    sample?.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const shots = process.env.BUILDER_SHOTS;
async function shot(name: string) {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
}
async function visit(hash: string) {
    await page.goto("about:blank");
    await page.goto(`${BASE}/${hash}`);
}
const builderHash = (id = webId) => `#/tests/${id}/steps`;
const historyHash = (id = webId) => `#/tests/${id}/history`;
const unsaved = () => page.getByTestId("unsaved-bar");
const resultsRail = () => page.getByRole("complementary", { name: "Results and script" });
const heads = () => page.locator(".bld-head");
async function noOverflow() {
    const wide = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".content *"))
            .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !el.closest(".code-wrap"))
            .slice(0, 5)
            .map((el) => `${el.tagName.toLowerCase()}.${el.className}`),
    );
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect({ overflow, wide }).toEqual({ overflow: 0, wide: [] });
}
async function axeNow() {
    const result = await new AxeBuilder({ page }).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
async function axeBoth(name: string) {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(400);
        await shot(`${name}-${scheme}`);
        await axeNow();
    }
    await page.emulateMedia({ colorScheme: null });
}
const specNow = async (id = webId) => (await api("GET", `/api/tests/${id}/spec`)).body;
const addStep = async (group: string, name: string) => {
    await page.getByRole("button", { name: "Add a step", exact: true }).click();
    await page.getByRole("group", { name: group, exact: true }).getByRole("button", { name, exact: true }).click();
};
// The version history is the History tab: steps and code versions, runs and repairs in one list; these are the rows of step versions.
const versionRows = () => page.locator("[data-testid=history] li.wb-hist").filter({ has: page.getByRole("checkbox", { name: /^Compare steps version/ }) });
const compare = (v: number) => page.getByLabel(`Compare steps version ${v}`, { exact: true });
/** Waits for the run a save started to end (no run left going and the test passing), then for the results column to say so on the same page. */
async function waitPassed() {
    for (let i = 0; i < 300; i++) {
        const active = platform.db.all("SELECT id FROM generation_jobs WHERE project_id = ? AND status NOT IN ('COMPLETED','PARTIALLY_COMPLETED','FAILED')", projectId);
        if (active.length === 0 && (await specNow()).validationStatus === "VALIDATED") break;
        await new Promise((r) => setTimeout(r, 400));
    }
    await pwExpect(resultsRail().getByText("This test is passing")).toBeVisible({ timeout: 30_000 });
}

describe("history before any edit", () => {
    it("says there is nothing yet", async () => {
        await visit(historyHash(apiId));
        await pwExpect(page.getByTestId("history")).toBeVisible();
        // no version of the steps exists before the first edit: nothing to compare or restore
        await pwExpect(versionRows()).toHaveCount(0);
        await pwExpect(page.getByRole("button", { name: /^Restore/ })).toHaveCount(0);
        // what exists is listed in the same place: how the test came to be
        await pwExpect(page.getByTestId("history")).toContainText("Imported from a file");
    });
});

describe("edit twice, compare, restore", () => {
    it("saves two edits and lists three versions with the newest marked current", async () => {
        await visit(builderHash());
        await heads().nth(1).click();
        await page.getByLabel("Text to type", { exact: true }).fill("alpenglow");
        await unsaved().getByRole("button", { name: "Save and run", exact: true }).click();
        await waitPassed();

        await addStep("Check", "The page title contains");
        await page.getByLabel("Text the title should contain", { exact: true }).fill("Products");
        await unsaved().getByRole("button", { name: "Save and run", exact: true }).click();
        await pwExpect(page.getByTestId("saved-bar")).toContainText("Saved version 3.");
        await waitPassed();

        await page.getByRole("tab", { name: "History", exact: true }).click();
        await pwExpect(versionRows()).toHaveCount(3);
        const rows = (await versionRows().allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
        expect(rows[0]).toContain("Steps, version 3");
        expect(rows[0]).toMatch(/current/i);
        expect(rows[2]).toContain("Steps, version 1");
        expect(rows[2]).toContain("The steps as they were before the first edit");
        // the newest has no Restore button, the older ones do
        await pwExpect(page.getByRole("button", { name: "Restore steps version 3", exact: true })).toHaveCount(0);
        await pwExpect(page.getByRole("button", { name: "Restore steps version 1", exact: true })).toBeVisible();
        // the runs these saves started are in the same list
        await pwExpect(page.getByTestId("history").locator("li[data-kind=run]").first()).toBeVisible();
    }, 240_000);

    it("compares one version with the newest, step by step, in words and marks", async () => {
        await compare(1).check();
        await pwExpect(page.getByRole("heading", { name: "Steps version 1 compared with version 3", exact: true })).toBeVisible();
        await pwExpect(page.getByTestId("step-diff-summary")).toHaveText("1 step added, 1 step changed");
        const changed = page.locator("[data-change=changed]");
        await pwExpect(changed).toHaveCount(1);
        await pwExpect(changed).toContainText("Type “boot” into the “Search products” field");
        await pwExpect(changed).toContainText("Type “alpenglow” into the “Search products” field");
        await pwExpect(changed).toContainText("Changed: Text to type");
        const added = page.locator("[data-change=added]");
        await pwExpect(added).toHaveCount(1);
        await pwExpect(added).toContainText("Added");
        await pwExpect(added).toContainText("page title contains");
        await shot("history-diff");
        // two ticked: those two, oldest first
        await compare(2).check();
        await pwExpect(page.getByRole("heading", { name: "Steps version 1 compared with version 2", exact: true })).toBeVisible();
        await pwExpect(page.getByTestId("step-diff-summary")).toHaveText("1 step changed");
        // one ticked: against the newest
        await compare(1).uncheck();
        await pwExpect(page.getByRole("heading", { name: "Steps version 2 compared with version 3", exact: true })).toBeVisible();
        await pwExpect(page.getByTestId("step-diff-summary")).toHaveText("1 step added");
        await compare(2).uncheck();
        await pwExpect(page.getByTestId("step-diff")).toHaveCount(0);
    });

    it("looks right in both themes with a difference open", async () => {
        await compare(1).check();
        await pwExpect(page.getByTestId("step-diff")).toBeVisible();
        await axeBoth("history-diff");
    });

    it("works with the keyboard alone: tick with Space, open Restore with Enter, Escape cancels", async () => {
        await compare(1).uncheck();
        await compare(2).focus();
        await page.keyboard.press("Space");
        await pwExpect(compare(2)).toBeChecked();
        await pwExpect(page.getByTestId("step-diff-summary")).toBeVisible();
        await compare(2).uncheck();
        await page.getByRole("button", { name: "Restore steps version 1", exact: true }).focus();
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog", { name: "Restore steps version 1?" });
        await pwExpect(dialog).toBeVisible();
        await pwExpect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
        await page.keyboard.press("Escape");
        await pwExpect(dialog).toHaveCount(0);
        expect((await specNow()).versions).toBe(3); // nothing was saved
    });

    it("warns that unsaved changes are replaced, then restores version 1 and follows the run to passed", async () => {
        await page.getByRole("tab", { name: "Steps", exact: true }).click();
        await heads().nth(0).click();
        await page.getByLabel("Address", { exact: true }).fill("/products?x=1");
        await pwExpect(unsaved()).toContainText("1 unsaved change");
        await page.getByRole("tab", { name: "History", exact: true }).click();
        await pwExpect(unsaved()).toContainText("1 unsaved change"); // the bar follows the tester to the other tab
        await page.getByRole("button", { name: "Restore steps version 1", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Restore steps version 1?" });
        await pwExpect(dialog).toContainText("The changes you have not saved are replaced.");
        // keyboard: Tab from Cancel to the confirm button, Enter
        await page.keyboard.press("Tab");
        await pwExpect(dialog.getByRole("button", { name: "Restore this version", exact: true })).toBeFocused();
        await page.keyboard.press("Enter");
        await pwExpect(page.getByText("Steps version 1 is restored", { exact: true })).toBeVisible({ timeout: 15_000 });
        await waitPassed();

        // the editor shows the restored steps and nothing is left unsaved
        await pwExpect(unsaved()).toHaveCount(0);
        await page.getByRole("tab", { name: "Steps", exact: true }).click();
        await pwExpect(heads()).toHaveCount(4);
        await pwExpect(heads().nth(1)).toContainText("Type “boot”");
        // the platform has it as the newest version, with a note, and the script follows
        const s = await specNow();
        expect(s.versions).toBe(4);
        expect(s.spec.steps).toHaveLength(4);
        expect(s.spec.steps[1].value).toBe("boot");
        expect(s.spec.steps[0].url).toBe("/products");
        expect(s.validationStatus).toBe("VALIDATED");
        expect(String((await api("GET", `/api/tests/${webId}/script`)).body)).not.toContain("alpenglow");
        // the history lists the new version first
        await page.getByRole("tab", { name: "History", exact: true }).click();
        await pwExpect(versionRows()).toHaveCount(4);
        const first = (await versionRows().first().innerText()).replace(/\s+/g, " ");
        expect(first).toContain("Steps, version 4");
        expect(first).toMatch(/current/i);
        expect(first).toContain("Restored version 1");
        // old versions are untouched: version 3 still has five steps
        expect((await api("GET", `/api/tests/${webId}/spec-versions/3`)).body.spec.steps).toHaveLength(5);
        await shot("history-restored");
    }, 240_000);

    it("restoring steps that are already current is a no-op that says so", async () => {
        // version 1 and the newest (4) are the same steps now
        await compare(1).check();
        await pwExpect(page.getByTestId("step-diff-same")).toContainText("identical");
        await compare(1).uncheck();
        await page.getByRole("button", { name: "Restore steps version 1", exact: true }).click();
        await page.getByRole("dialog", { name: "Restore steps version 1?" }).getByRole("button", { name: "Restore this version", exact: true }).click();
        await pwExpect(page.getByText("These were already the current steps")).toBeVisible({ timeout: 15_000 });
        expect((await specNow()).versions).toBe(4);
    });

    it("links work after a restore without an unsaved-changes question", async () => {
        await page.getByRole("link", { name: "Test scripts", exact: true }).first().click();
        await pwExpect(page.getByRole("dialog")).toHaveCount(0);
        expect(page.url()).toContain(`/projects/${projectId}/scripts`);
    });
});

describe("looks and works everywhere", () => {
    it("fits a phone: no sideways scroll, targets of at least 44 px, rows stack", async () => {
        await page.setViewportSize({ width: 375, height: 800 });
        await visit(historyHash());
        await pwExpect(page.getByTestId("history")).toBeVisible();
        await compare(2).check();
        await pwExpect(page.getByTestId("step-diff")).toBeVisible();
        await noOverflow();
        await shot("history-375");
        const small = await page.evaluate(() =>
            Array.from(document.querySelectorAll<HTMLElement>("[data-testid=history] button, [data-testid=history] .wb-hist-pick"))
                .map((el) => ({ el, r: el.getBoundingClientRect() }))
                .filter(({ r }) => r.width > 0 && (r.height < 43.5 || r.width < 43.5))
                .map(({ el }) => `${el.tagName.toLowerCase()}.${el.className}[${el.getAttribute("aria-label") ?? el.textContent?.slice(0, 20)}]`),
        );
        expect(small).toEqual([]);
        await page.emulateMedia({ colorScheme: "dark" });
        await page.waitForTimeout(400);
        await axeNow();
        await page.emulateMedia({ colorScheme: null });
        await page.setViewportSize({ width: 1280, height: 900 });
    });

    it("never wrote to the browser console as an error", () => {
        expect(consoleErrors).toEqual([]);
    });
});
