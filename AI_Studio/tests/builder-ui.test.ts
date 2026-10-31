/**
 * The step editor (the Steps tab of the test workbench) in a real browser against a real platform (worker, sample app, real API): add / edit / reorder / delete steps with
 * mouse and keyboard, the live script preview, save and run, problems, unsaved-changes protection, the read-only states, building a
 * test from the Tests page, 375 px, axe in light and dark. Ports: 6140 sample app, 6141 platform (it serves web/dist too).
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/builder-ui.test.ts
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
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const APP_PORT = 6140;
const PORT = 6141;
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
    return { status: res.statusCode, body: res.body && res.body.startsWith("{") ? JSON.parse(res.body) : res.body.startsWith("[") ? JSON.parse(res.body) : res.body };
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
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-builder-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0", HOST: "127.0.0.1", PORT: String(PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 200);
    worker.start();

    projectId = (await api("POST", "/api/projects", { name: "Atlas shop" })).body.id;
    await api("POST", `/api/projects/${projectId}/objects`, { name: "Search button", kind: "web", page: "Products", locator: { by: "role", role: "button", value: "Search" } });
    const imp = await api("POST", `/api/projects/${projectId}/specs`, { specs: [searchSpec, apiSpec], baseUrl: APP, validate: false });
    expect(imp.status).toBe(202);
    webId = imp.body.tests[0].id;
    apiId = imp.body.tests[1].id;
    expect((await api("POST", `/api/tests/${apiId}/take-over`, { confirm: true })).status).toBe(200);

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
const unsaved = () => page.getByTestId("unsaved-bar");
/** A step header without its number and the problem badge, to compare order. */
const words = (t: string) => t.replace(/^Step [0-9]+ /, "").replace(/ [0-9]+ problems?$/i, "");
const heads = () => page.locator(".bld-head");
const headTexts = async () => (await heads().allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
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
async function axe() {
    const result = await new AxeBuilder({ page }).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
async function axeBoth(setup: () => Promise<void>, name: string) {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(400);
        await setup();
        await shot(`${name}-${scheme}-1280`);
        await axe();
    }
    await page.emulateMedia({ colorScheme: null });
}
const specNow = async (id = webId) => (await api("GET", `/api/tests/${id}/spec`)).body;
const addStep = async (group: string, name: string) => {
    await page.getByRole("button", { name: "Add a step", exact: true }).click();
    await page.getByRole("group", { name: group, exact: true }).getByRole("button", { name, exact: true }).click();
};

describe("opening the editor", () => {
    it("is the page a generated test opens on, and lists the steps in plain words", async () => {
        // the Steps tab is where a test opens (the old "Edit steps" button and the /builder address lead here too)
        await visit(`#/tests/${webId}`);
        await pwExpect(page.getByRole("tab", { name: "Steps", exact: true })).toHaveAttribute("aria-selected", "true");
        await pwExpect(heads().first()).toBeVisible();
        expect(await headTexts()).toEqual([
            expect.stringContaining("Step 1 Open /products"),
            expect.stringContaining("Step 2 Type “boot” into the “Search products” field"),
            expect.stringContaining("Step 3 Click the “Search” button"),
            expect.stringContaining("Step 4"),
        ]);
        // the script is shown beside the steps and is the stored one
        await pwExpect(page.locator(".bld-script code").first()).toContainText("page.goto");
        await pwExpect(page.getByText("Up to date")).toBeVisible();
        // a hand-written test has no steps to edit: the tab says so
        await visit(`#/tests/${apiId}`);
        await pwExpect(page.getByText("This is a code test, so it has no steps to edit")).toBeVisible();
        expect(await page.getByRole("button", { name: "Add a step", exact: true }).count()).toBe(0);
    });
});

describe("editing with the mouse", () => {
    it("adds a step, edits it, and the script preview follows", async () => {
        await visit(builderHash());
        await pwExpect(heads().first()).toBeVisible();
        await heads().nth(0).click(); // select step 1 so the new step goes after it
        await addStep("Check", "The page title contains");
        await pwExpect(page.getByLabel("What to check", { exact: true })).toBeFocused();
        await page.getByLabel("Text the title should contain", { exact: true }).fill("Products");
        await pwExpect(unsaved()).toContainText("unsaved change");
        expect((await headTexts())[1]).toContain("Check that the page title contains “Products”");
        await pwExpect(page.locator(".bld-script code").first()).toContainText("toHaveTitle", { timeout: 10_000 });
        // the stored test is not touched by editing
        expect((await specNow()).spec.steps).toHaveLength(4);
    });

    it("edits a text field and offers the project's values to insert", async () => {
        await heads().nth(2).click();
        const typed = page.getByLabel("Text to type", { exact: true });
        await typed.fill("");
        await page.getByLabel("Insert a value into text to type").selectOption("unique");
        await pwExpect(typed).toHaveValue("{{unique}}");
        await typed.fill("tent");
        await pwExpect(page.locator(".bld-script code").first()).toContainText("tent", { timeout: 10_000 });
    });

    it("switches a locator to a shared element from the object repository", async () => {
        await heads().nth(3).click();
        await page.getByLabel("How to find it", { exact: true }).selectOption("ref");
        await page.getByLabel("Shared element", { exact: true }).selectOption("Search button");
        expect((await headTexts())[3]).toContain("shared element “Search button”");
        await pwExpect(page.locator(".bld-script code").first()).toContainText('getByRole("button", { name: "Search" })');
    });

    it("moves steps with the buttons and with the keyboard, keeping focus on the step", async () => {
        const before = await headTexts();
        await page.getByRole("button", { name: "Move step 1 down", exact: true }).click();
        const after = await headTexts();
        expect(words(after[0]!)).toBe(words(before[1]!));
        expect(words(after[1]!)).toBe(words(before[0]!));
        // the first step cannot move up, the last cannot move down
        await pwExpect(page.getByRole("button", { name: "Move step 1 up", exact: true })).toBeDisabled();
        await pwExpect(page.getByRole("button", { name: `Move step ${after.length} down`, exact: true })).toBeDisabled();
        // keyboard: Alt+ArrowUp on the step header moves it back and focus follows it
        await heads().nth(1).focus();
        await page.keyboard.press("Alt+ArrowUp");
        await pwExpect(heads().first()).toBeFocused();
        expect((await headTexts()).map(words)).toEqual(before.map(words));
    });

    it("moves a step by dragging its handle", async () => {
        const before = await headTexts();
        const from = page.locator(".bld-grip").nth(0);
        const to = page.locator(".bld-step").nth(2);
        await from.dragTo(to);
        const after = await headTexts();
        expect(words(after[2]!)).toBe(words(before[0]!));
        // and back
        await page.getByRole("button", { name: "Move step 3 up", exact: true }).click();
        await page.getByRole("button", { name: "Move step 2 up", exact: true }).click();
    });

    it("duplicates and deletes a step, and undoes the delete", async () => {
        const n = (await headTexts()).length;
        await page.getByRole("button", { name: "Duplicate step 1", exact: true }).click();
        expect((await headTexts()).length).toBe(n + 1);
        await page.getByRole("button", { name: "Delete step 2", exact: true }).click();
        expect((await headTexts()).length).toBe(n);
        await pwExpect(page.getByRole("status").filter({ hasText: "Step 2 removed." })).toBeVisible();
        await page.getByRole("button", { name: "Undo", exact: true }).click();
        expect((await headTexts()).length).toBe(n + 1);
        await page.getByRole("button", { name: "Delete step 2", exact: true }).click(); // the duplicate goes again
        expect((await headTexts()).length).toBe(n);
    });

    it("says what is wrong, jumps to the step, and refuses to save it", async () => {
        await addStep("Interact", "Hover");
        await pwExpect(page.getByRole("heading", { name: "Problems to fix", exact: true })).toBeVisible({ timeout: 10_000 });
        const link = page.getByRole("button", { name: /^Go to step \d+$/ }).first();
        await pwExpect(link).toBeVisible();
        await shot("problems");
        // a step with a problem cannot be saved: the bar says why and both buttons are off
        await pwExpect(unsaved().getByRole("button", { name: "Save and run", exact: true })).toBeDisabled();
        await pwExpect(unsaved().getByRole("button", { name: "Save", exact: true })).toBeDisabled();
        await pwExpect(page.getByTestId("unsaved-why")).toContainText("Fix the problems listed first");
        expect((await specNow()).spec.steps).toHaveLength(4); // nothing was stored
        await link.click();
        await pwExpect(page.getByLabel("How to find it", { exact: true })).toBeFocused();
        await page.getByLabel("Text", { exact: true }).fill("Search");
        await pwExpect(page.getByRole("heading", { name: "Problems to fix", exact: true })).toHaveCount(0, { timeout: 10_000 });
    });
});

describe("saving", () => {
    it("protects unsaved changes: a link asks first, closing the tab shows the browser warning", async () => {
        await page.getByRole("link", { name: "Test cases", exact: true }).first().click();
        const dialog = page.getByRole("dialog", { name: "Leave without saving?" });
        await pwExpect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Stay and keep editing", exact: true }).click();
        await pwExpect(dialog).toHaveCount(0);
        expect(page.url()).toContain("/steps");
        const prevented = await page.evaluate(() => {
            const e = new Event("beforeunload", { cancelable: true });
            window.dispatchEvent(e);
            return e.defaultPrevented;
        });
        expect(prevented).toBe(true);
    });

    it("discards changes after asking", async () => {
        await unsaved().getByRole("button", { name: "Discard changes", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Discard your changes?" });
        await pwExpect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Discard changes", exact: true }).click();
        expect(await headTexts()).toHaveLength(4);
        // nothing is unsaved any more: the bar with the save buttons is gone
        await pwExpect(unsaved()).toHaveCount(0);
    });

    it("saves and runs: the status goes to passed, the stored test and script follow", async () => {
        await heads().nth(1).click();
        await page.getByLabel("Text to type", { exact: true }).fill("alpenglow");
        await addStep("Check", "The page title contains");
        await page.getByLabel("Text the title should contain", { exact: true }).fill("Products");
        await unsaved().getByRole("button", { name: "Save and run", exact: true }).click();
        // the result arrives in the results column of the same page
        await pwExpect(page.getByRole("complementary", { name: "Results and script" }).getByText("This test is passing")).toBeVisible({ timeout: 90_000 });
        await pwExpect(unsaved()).toHaveCount(0);
        const s = await specNow();
        expect(s.spec.steps[1].value).toBe("alpenglow");
        expect(s.spec.steps.some((x: { check?: string }) => x.check === "title")).toBe(true);
        expect(String((await api("GET", `/api/tests/${webId}/script`)).body)).toContain("alpenglow");
        expect(s.validationStatus).toBe("VALIDATED");
        await shot("saved");
        // links work again without a question
        await page.getByRole("link", { name: "Test cases", exact: true }).first().click();
        await pwExpect(page.getByRole("dialog")).toHaveCount(0);
        expect(page.url()).toContain(`/projects/${projectId}/tests`);
    }, 120_000);
});

describe("read-only states", () => {
    it("a hand-written test points to the Code tab and shows its steps without controls", async () => {
        await visit(builderHash(apiId));
        await pwExpect(page.getByText("This is a code test, so it has no steps to edit")).toBeVisible();
        await pwExpect(page.getByRole("link", { name: "Edit the code", exact: true }).first()).toHaveAttribute("href", `#/tests/${apiId}/code`);
        expect(await page.getByRole("button", { name: /^Move step/ }).count()).toBe(0);
        expect(await page.locator(".bld-n").count()).toBeGreaterThan(0);
    });

    it("a run in progress says so, and Try again works once it has finished", async () => {
        const app = platform.repo.getLatestApplicationPublic(projectId)!;
        const job = await platform.repo.createJob(projectId, app.id as string, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] });
        platform.repo.setJobStatus(job.id, "VALIDATING");
        try {
            await visit(builderHash());
            await pwExpect(page.getByText("A run is in progress", { exact: true })).toBeVisible();
            await pwExpect(page.getByRole("button", { name: "Add a step", exact: true })).toHaveCount(0);
        } finally {
            platform.repo.setJobStatus(job.id, "COMPLETED");
        }
        await page.getByRole("button", { name: "Try again", exact: true }).click();
        await pwExpect(page.getByRole("button", { name: "Add a step", exact: true })).toBeVisible();
    });

    it("a test that is not found offers Try again", async () => {
        await visit(builderHash("does-not-exist"));
        await pwExpect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    });
});

describe("building a test from the Tests page", () => {
    it("asks for a title and opens the editor with the first step, then the empty list invites one action", async () => {
        await visit(`#/projects/${projectId}/tests`);
        await page.getByRole("button", { name: "New test", exact: true }).click();
        await page.getByRole("menuitem", { name: "Build steps by hand", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Build a test" });
        await dialog.getByRole("button", { name: "Start building", exact: true }).click();
        await pwExpect(dialog.getByText("Give the test a title of at least 3 characters.")).toBeVisible();
        await dialog.getByLabel("Title", { exact: true }).fill("Cart page opens");
        await dialog.getByRole("button", { name: "Start building", exact: true }).click();
        await pwExpect(page.getByRole("tab", { name: "Steps", exact: true })).toHaveAttribute("aria-selected", "true");
        expect(await headTexts()).toEqual([expect.stringContaining("Step 1 Open /")]);
        // remove the only step: the list asks for one action
        await page.getByRole("button", { name: "Delete step 1", exact: true }).click();
        await pwExpect(page.getByText("This test has no steps yet")).toBeVisible();
        await pwExpect(unsaved().getByRole("button", { name: "Save and run", exact: true })).toBeDisabled();
        await pwExpect(page.getByTestId("unsaved-why")).toContainText("A test needs at least one step.");
        await page.getByRole("button", { name: "Undo", exact: true }).click();
        await pwExpect(heads()).toHaveCount(1);
    });
});

describe("looks and works everywhere", () => {
    it("has no accessibility violations in both themes, with a form and the palette open", async () => {
        await visit(builderHash());
        await pwExpect(heads().first()).toBeVisible();
        await heads().nth(1).click();
        await page.getByRole("button", { name: "Add a step", exact: true }).click();
        await pwExpect(page.getByRole("group", { name: "Interact", exact: true })).toBeVisible();
        await axeBoth(async () => undefined, "builder-palette");
        await page.getByRole("group", { name: "Check", exact: true }).locator("summary").click();
        await axeBoth(async () => undefined, "builder-palette-more");
        await page.getByRole("button", { name: "Add a step", exact: true }).click(); // close it
        await heads().filter({ hasText: "Click" }).first().click();
        await page.getByLabel("How to find it", { exact: true }).selectOption("role");
        await axeBoth(async () => undefined, "builder-form");
        // an API test's form: request with rows, JSON and map fields
        await visit(`#/projects/${projectId}/tests`);
        const made = await api("POST", `/api/projects/${projectId}/built-tests`, { title: "Products list answers", kind: "api" });
        await visit(builderHash(made.body.testId));
        await heads().first().click();
        await page.getByRole("button", { name: "Add a row", exact: true }).first().click();
        await axeBoth(async () => undefined, "builder-api");
    });

    it("fits a phone: no sideways scroll, targets of at least 44 px, steps stack", async () => {
        await page.setViewportSize({ width: 375, height: 800 });
        await visit(builderHash());
        await pwExpect(heads().first()).toBeVisible();
        await heads().nth(1).click();
        await noOverflow();
        await shot("builder-390");
        const small = await page.evaluate(() =>
            Array.from(document.querySelectorAll<HTMLElement>(".bld-steps button, .bld-toolbar button, .bld-form select, .bld-form input:not([type=checkbox]), .bld-check"))
                .map((el) => ({ el, r: el.getBoundingClientRect() }))
                .filter(({ r }) => r.width > 0 && (r.height < 43.5 || (r.width < 43.5 && !(r.width > 100))))
                .map(({ el }) => `${el.tagName.toLowerCase()}.${el.className}[${el.getAttribute("aria-label") ?? el.textContent?.slice(0, 20)}]`),
        );
        expect(small).toEqual([]);
        await page.getByRole("button", { name: "Add a step", exact: true }).click();
        await noOverflow();
        await shot("builder-palette-390");
        await page.emulateMedia({ colorScheme: "dark" });
        await page.waitForTimeout(400);
        await shot("builder-390-dark");
        await axe();
        await page.emulateMedia({ colorScheme: null });
        await page.setViewportSize({ width: 1280, height: 900 });
    });

    it("never wrote to the browser console as an error", () => {
        expect(consoleErrors).toEqual([]);
    });
});
