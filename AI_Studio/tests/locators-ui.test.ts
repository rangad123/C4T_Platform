/**
 * The Objects tab in a real browser against the real built UI (`web/dist`) and a real platform (no model, no worker): empty
 * state, adding an element through the dialog, "Applies to N tests" when a used element is edited, delete refused while used, the
 * preview of shared locators and its confirmation, the chip and "Make shared" on a test's steps, markup in text shown as text,
 * axe in light and dark, phone width. Run:
 * node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/locators-ui.test.ts
 * Port 5931. Set OBJECTS_SHOTS=<folder> to also write screenshots there.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 5931;
const BASE = `http://127.0.0.1:${PORT}`;
const MARKUP = '<img src=x onerror="window.__pwned=1">';

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let page: Page;
let dir: string;
let projectId: string;
const testIds: Record<string, string> = {};
const consoleErrors: string[] = [];

const shot = async (name: string) => {
    if (process.env.OBJECTS_SHOTS) await page.screenshot({ path: path.join(process.env.OBJECTS_SHOTS, `${name}.png`), fullPage: true });
};
const objectsUrl = () => `${BASE}/#/projects/${projectId}/scripts?section=elements`;
const testUrl = (k: string) => `${BASE}/#/tests/${testIds[k]}`;
const open = async (url: string, ready: () => Promise<void>) => {
    await page.goto("about:blank");
    await page.goto(url);
    await ready();
};
const api = async (method: string, url: string, payload?: unknown) => {
    const r = await server.inject({ method: method as never, url, payload: payload as never });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};

const addTest = (key: string, title: string, steps: unknown[]) => {
    const n = Object.keys(testIds).length + 1;
    const spec = TestSpecSchema.parse({ testId: `WEB-00${n}`, title, kind: "web", category: "Shop", steps });
    const suite = platform.repo.getOrCreateSuite(projectId, "Shop", "shop");
    testIds[key] = platform.repo.insertTest({ projectId, suiteId: suite, jobId: null, spec, framework: "playwright", validationStatus: "PENDING" });
};
const pay = { by: "role", role: "button", value: "Pay now", exact: true };
const nav = { action: "navigate", url: "/cart" };

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-obj-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    projectId = platform.repo.createProject({ name: "Atlas shop" }).id as string;
    platform.repo.createApplication(projectId, "http://127.0.0.1:5931", { ...DEFAULT_JOB_OPTIONS });
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

describe("the Objects tab", () => {
    it("says what it is for when there are no elements, and sits in the project tabs", async () => {
        await open(objectsUrl(), async () => pwExpect(page.getByRole("heading", { name: "No shared elements yet" })).toBeVisible());
        await pwExpect(page.getByText("Name the buttons and fields your tests use once, and fix them in one place.").first()).toBeVisible();
        // Shared elements is a section of the Test scripts place now (round 25; it was the Library).
        await pwExpect(page.getByRole("navigation", { name: "Test scripts sections" }).getByRole("link", { name: "Shared elements" })).toHaveAttribute("aria-current", "page");
        await pwExpect(page.getByRole("button", { name: "Export" })).toBeDisabled();
        await shot("empty");
    });

    it("adds an element through the dialog and shows the locator in words", async () => {
        await page.getByRole("button", { name: "Add element" }).first().click();
        const dialog = page.getByRole("dialog", { name: "Add element" });
        await pwExpect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Add element" }).click();
        await pwExpect(dialog.getByText("Give the element a name.")).toBeVisible();
        await dialog.getByLabel("Name", { exact: true }).fill("Cart / Pay button");
        await dialog.getByLabel("Page (optional)", { exact: true }).fill("Cart");
        await dialog.getByLabel("Find it by").selectOption("role");
        await dialog.getByLabel("Role", { exact: true }).fill("button");
        await dialog.getByLabel("Name (optional)").fill("Pay now");
        await dialog.getByLabel("Match the whole text exactly").check();
        await dialog.getByRole("button", { name: "Add element" }).click();
        await pwExpect(page.getByRole("dialog")).toHaveCount(0);
        await pwExpect(page.getByText("Element added")).toBeVisible();
        const row = page.getByTestId("element-list").locator("li", { hasText: "Cart / Pay button" });
        await pwExpect(row).toContainText('Button "Pay now"');
        await pwExpect(row).toContainText("Web");
        await pwExpect(row).toContainText("Not used yet");
        await pwExpect(page.getByRole("heading", { name: "Cart", exact: true })).toBeVisible();
        // the same name again is refused with a plain sentence
        await page.getByRole("button", { name: "Add element" }).first().click();
        const again = page.getByRole("dialog", { name: "Add element" });
        await again.getByLabel("Name", { exact: true }).fill("cart / PAY button");
        await again.getByLabel("Find it by").selectOption("testId");
        await again.getByLabel("Test id", { exact: true }).fill("pay");
        await again.getByRole("button", { name: "Add element" }).click();
        await pwExpect(again.getByText(/already has an element called/)).toBeVisible();
        await page.keyboard.press("Escape");
        await pwExpect(page.getByRole("dialog")).toHaveCount(0);
    });

    it("tells how many tests an edit applies to, and shows markup in text as text", async () => {
        addTest("a", "Pay for a mug", [nav, { action: "click", locator: { ref: "Cart / Pay button" } }]);
        addTest("b", "Pay for a cap", [nav, { action: "click", locator: { ref: "Cart / Pay button" } }]);
        await open(objectsUrl(), async () => pwExpect(page.getByText("Used by 2 tests")).toBeVisible());
        const row = page.getByTestId("element-list").locator("li", { hasText: "Cart / Pay button" });
        await pwExpect(row).toContainText("Pay for a mug");
        await row.getByRole("button", { name: "Edit Cart / Pay button" }).click();
        const dialog = page.getByRole("dialog", { name: "Edit element" });
        await pwExpect(dialog.getByText("Applies to 2 tests.")).toBeVisible();
        await dialog.getByLabel("Notes (optional)").fill(MARKUP);
        await dialog.getByLabel("Page (optional)", { exact: true }).fill(MARKUP);
        await dialog.getByLabel("Name (optional)").fill("Pay with card");
        await dialog.getByRole("button", { name: "Save changes" }).click();
        await pwExpect(page.getByText("Changes saved")).toBeVisible();
        await pwExpect(page.getByText(/Applies to 2 tests\./).first()).toBeVisible();
        await pwExpect(page.getByTestId("element-list").locator("li", { hasText: "Cart / Pay button" })).toContainText('Button "Pay with card"');
        await pwExpect(page.getByText(MARKUP).first()).toBeVisible(); // shown as text
        expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
        // the specs still hold the reference, the element holds the locator
        expect((await api("GET", `/api/tests/${testIds.a}`)).body.spec.steps[1].locator).toEqual({ ref: "Cart / Pay button" });
        await shot("list");
        // put the page back to a plain word for the rest
        await row.getByRole("button", { name: "Edit Cart / Pay button" }).click();
        await page.getByRole("dialog", { name: "Edit element" }).getByLabel("Page (optional)", { exact: true }).fill("Cart");
        await page.getByRole("dialog", { name: "Edit element" }).getByLabel("Notes (optional)").fill("");
        await page.getByRole("dialog", { name: "Edit element" }).getByRole("button", { name: "Save changes" }).click();
        await pwExpect(page.getByRole("heading", { name: "Cart", exact: true })).toBeVisible();
    });

    it("will not delete an element that is used, and deletes one that is not", async () => {
        const created = await api("POST", `/api/projects/${projectId}/objects`, { name: "Scratch / Unused", kind: "web", locator: { by: "css", value: "#nothing" } });
        expect(created.status).toBe(201);
        await open(objectsUrl(), async () => pwExpect(page.getByText("Scratch / Unused")).toBeVisible());
        const used = page.getByTestId("element-list").locator("li", { hasText: "Cart / Pay button" });
        await used.getByRole("button", { name: "Delete Cart / Pay button" }).click();
        await pwExpect(used.getByText("This element is in use and can’t be deleted.")).toBeVisible();
        await pwExpect(used.getByRole("button", { name: "Delete element" })).toHaveCount(0);
        await used.getByRole("button", { name: "Keep it" }).click();
        const unused = page.getByTestId("element-list").locator("li", { hasText: "Scratch / Unused" });
        await unused.getByRole("button", { name: "Delete Scratch / Unused" }).click();
        await unused.getByRole("button", { name: "Delete element" }).click();
        await pwExpect(page.getByTestId("element-list").getByText("Scratch / Unused")).toHaveCount(0);
        await pwExpect(page.getByText("Element deleted")).toBeVisible();
    });
});

describe("shared locators", () => {
    it("previews proposals, changes nothing until confirmed, then the steps use the new element", async () => {
        const login = { by: "label", value: "Email" };
        addTest("c", "Sign in one", [{ action: "navigate", url: "/login" }, { action: "fill", locator: login, value: "a@b.c" }]);
        addTest("d", "Sign in two", [{ action: "navigate", url: "/login" }, { action: "fill", locator: login, value: "d@b.c" }]);
        await open(objectsUrl(), async () => pwExpect(page.getByRole("heading", { name: "Find elements to share" })).toBeVisible());
        await page.getByRole("button", { name: "Find elements to share" }).click();
        const item = page.getByRole("list", { name: "Proposed shared elements" }).getByRole("listitem");
        await pwExpect(item).toHaveCount(1);
        await pwExpect(item).toContainText('Field labelled "Email"');
        await pwExpect(item).toContainText("2 places in 2 tests");
        await pwExpect(item.getByLabel("Name")).toHaveValue("Login / Email field");
        await shot("extract-preview");
        // nothing has changed yet
        expect((await api("GET", `/api/tests/${testIds.c}`)).body.spec.steps[1].locator).toEqual(login);
        await item.getByLabel("Name").fill("Login / Email box");
        await page.getByRole("button", { name: "Create shared elements" }).click();
        await pwExpect(page.getByText("Shared elements are ready")).toBeVisible();
        await pwExpect(page.getByTestId("element-list").locator("li", { hasText: "Login / Email box" })).toContainText("Used by 2 tests");
        expect((await api("GET", `/api/tests/${testIds.c}`)).body.spec.steps[1].locator).toEqual({ ref: "Login / Email box" });
    });

    it("says so when nothing is shared more than once", async () => {
        await page.getByRole("button", { name: "Find elements to share" }).click();
        await pwExpect(page.getByTestId("no-proposals")).toBeVisible();
    });
});

describe("a test's steps", () => {
    it("show a chip for a shared element and offer to share a step that spells its locator out", async () => {
        addTest("e", "Pay with a coupon", [nav, { action: "click", locator: pay }, { action: "click", locator: { ref: "Cart / Pay button" } }]);
        await open(testUrl("e"), async () => pwExpect(page.getByRole("heading", { name: "Pay with a coupon" })).toBeVisible());
        const chip = page.getByTestId("shared-chip");
        await pwExpect(chip).toHaveCount(1);
        await pwExpect(chip).toHaveText("Shared: Cart / Pay button");
        await pwExpect(chip).toHaveAttribute("href", `#/projects/${projectId}/scripts?section=elements`);
        await pwExpect(page.getByText("Click the shared element “Cart / Pay button”")).toBeVisible();
        await shot("test-steps");
        await page.getByRole("button", { name: "Use step 2 as a shared element" }).click();
        const form = page.getByRole("form", { name: "Use step 2 as a shared element" });
        await form.getByLabel("Name for the element").fill("Cart / Pay again");
        await form.getByRole("button", { name: "Use as shared element" }).click();
        await pwExpect(page.getByTestId("shared-chip")).toHaveCount(2);
        await pwExpect(page.getByText("Shared: Cart / Pay again")).toBeVisible();
        expect((await api("GET", `/api/tests/${testIds.e}`)).body.spec.steps[1].locator).toEqual({ ref: "Cart / Pay again" });
        // a step with no locator has no share action
        await pwExpect(page.getByRole("button", { name: "Use step 1 as a shared element" })).toHaveCount(0);
    });

    it("leaves a test without shared elements exactly as it was: no chip, only the extra action", async () => {
        addTest("f", "Plain test", [nav, { action: "click", locator: { by: "text", value: "Unique thing" } }]);
        await open(testUrl("f"), async () => pwExpect(page.getByRole("heading", { name: "Plain test" })).toBeVisible());
        await pwExpect(page.getByTestId("shared-chip")).toHaveCount(0);
        await pwExpect(page.getByText(/shared element/i)).toHaveCount(1); // only the action "Use as shared element"
        await pwExpect(page.getByRole("button", { name: /Use step \d as a shared element/ })).toHaveCount(1);
    });
});

describe("elements reached through reusable steps", () => {
    it("names the reusable steps a test reaches an element through, and treats an element a set holds as in use", async () => {
        const other = platform.repo.createProject({ name: "Blocks shop" }).id as string;
        platform.repo.createApplication(other, "http://127.0.0.1:5931", { ...DEFAULT_JOB_OPTIONS });
        const make = async (url: string, body: unknown) => expect((await api("POST", `/api/projects/${other}/${url}`, body)).status).toBe(201);
        await make("objects", { name: "Cart / Pay button", kind: "web", locator: pay, page: "Cart" });
        await make("objects", { name: "Cart / Total", kind: "web", locator: { by: "text", value: "Total" }, page: "Cart" });
        await make("blocks", { name: "Pay", kind: "web", params: [], steps: [{ action: "click", locator: { ref: "Cart / Pay button" } }] });
        await make("blocks", { name: "Read total", kind: "web", params: [], steps: [{ action: "assert", check: "visible", locator: { ref: "Cart / Total" } }] });
        const spec = TestSpecSchema.parse({ testId: "WEB-001", title: "Checkout through blocks", kind: "web", category: "Shop", steps: [nav, { action: "useBlock", block: "Pay" }] });
        platform.repo.insertTest({ projectId: other, suiteId: platform.repo.getOrCreateSuite(other, "Shop", "shop"), jobId: null, spec, framework: "playwright", validationStatus: "PENDING" });
        await open(`${BASE}/#/projects/${other}/objects`, async () => pwExpect(page.getByTestId("element-list").first()).toBeVisible());
        const pay1 = page.getByTestId("element-list").locator("li", { hasText: "Cart / Pay button" });
        await pwExpect(pay1).toContainText("Used by 1 test: Checkout through blocks (through the reusable steps “Pay”)");
        const total = page.getByTestId("element-list").locator("li", { hasText: "Cart / Total" });
        await pwExpect(total).toContainText("Not used by a test yet. Held in the reusable steps “Read total”");
        await total.getByRole("button", { name: "Delete Cart / Total" }).click();
        await pwExpect(total.getByText("This element is in use and can’t be deleted.")).toBeVisible();
        await pwExpect(total.getByRole("button", { name: "Delete element" })).toHaveCount(0);
        // editing the used element says how many tests follow it, the one that reaches it through a set included
        await pay1.getByRole("button", { name: "Edit Cart / Pay button" }).click();
        await pwExpect(page.getByRole("dialog").getByText("Applies to 1 test.")).toBeVisible();
        await page.keyboard.press("Escape");
    });
});

describe("accessibility and phones", () => {
    it("has no accessibility violations in light and dark: list, dialog, preview, test page", async () => {
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.waitForTimeout(400);
            const check = async (what: string) => {
                await page.waitForTimeout(600);
                const result = await new AxeBuilder({ page }).analyze();
                expect(result.violations.map((v) => `${what}: ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
            };
            await open(objectsUrl(), async () => pwExpect(page.getByTestId("element-list").first()).toBeVisible());
            await check("objects");
            await shot(`objects-${scheme}`);
            await page.getByRole("button", { name: "Add element" }).first().click();
            await pwExpect(page.getByRole("dialog", { name: "Add element" })).toBeVisible();
            await check("dialog");
            await page.keyboard.press("Escape");
            await open(testUrl("e"), async () => pwExpect(page.getByTestId("shared-chip").first()).toBeVisible());
            await check("test page");
        }
        await page.emulateMedia({ colorScheme: null });
    });

    it("fits a phone without sideways scrolling, and the dialog stays on screen", async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await open(objectsUrl(), async () => pwExpect(page.getByTestId("element-list").first()).toBeVisible());
        await page.waitForTimeout(500);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
        await pwExpect(page.getByRole("navigation", { name: "Test scripts sections" }).getByRole("link", { name: "Shared elements" })).toBeInViewport();
        await shot("phone-list");
        await page.emulateMedia({ colorScheme: "dark" });
        await page.waitForTimeout(400);
        await shot("phone-list-dark");
        await page.emulateMedia({ colorScheme: null });
        await page.waitForTimeout(400);
        await page.getByRole("button", { name: "Add element" }).first().click();
        const box = await page.getByRole("dialog", { name: "Add element" }).boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(390);
        await shot("phone-dialog");
        await page.keyboard.press("Escape");
        await open(testUrl("e"), async () => pwExpect(page.getByTestId("shared-chip").first()).toBeVisible());
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
        await page.setViewportSize({ width: 1280, height: 900 });
    });

    it("kept the browser console clean", () => {
        // The one 409 is the refused duplicate name from the add test (the browser logs every failed request).
        expect(consoleErrors.filter((e) => !/status of 409/.test(e))).toEqual([]);
    });
});
