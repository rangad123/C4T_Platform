/**
 * Renaming, deleting and ordering test scripts in a real browser (pages/ProjectTests.tsx, features/scripts/ScriptManage.tsx, the
 * test page's header), in a code project: rename in place (with what is wrong said under the field), delete after the app's own
 * confirmation, Move up / Move down kept after a reload, the same on a script's own page, a viewer who sees none of the buttons, and
 * accessibility in light and dark. No worker.
 * Needs web/dist (build it first, inside the lock):
 *   node scripts/with-lock.mjs build,browser -- sh -c "npx vite build web && npx vitest run tests/test-manage-ui.test.ts"
 * Ports: platform 9800.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { defaultFramework } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { hashPassword } from "../src/platform/auth/password.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { ReviewStore } from "../src/platform/review-store.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 9800;
const BASE = `http://127.0.0.1:${PORT}`;

let browser: Browser;
let page: Page;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let projectId: string;
const ids: Record<string, string> = {};
/** Set TEST_MANAGE_UI_SHOTS=<folder> to keep screenshots of the row menu for a visual check. */
async function shot(name: string) {
    if (process.env.TEST_MANAGE_UI_SHOTS) await page.screenshot({ path: path.join(process.env.TEST_MANAGE_UI_SHOTS, `${name}.png`) });
}

/** The titles of the scripts as the server lists them (the order everything else follows). */
const serverOrder = () => platform.repo.listTests(projectId).map((t) => t.title);
const rows = () => page.getByRole("list", { name: "Test scripts in Checkout" }).getByTestId("script-row");
const titles = async () => (await rows().locator(".sr-title").allTextContents()).map((s) => s.trim());

async function signIn(p: Page, email: string, password: string) {
    await p.goto(BASE);
    await p.getByLabel("Email").fill(email);
    await p.getByLabel("Password").fill(password);
    await p.getByRole("button", { name: "Sign in" }).click();
    await pwExpect(p.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
}

/** A menu entry is wholly on the screen and nothing covers or clips its middle (a clipped point hits what lies under it). */
/** true when the menu item is wholly on screen and on top; otherwise where it is and what covers its middle (said in the failure). */
const shown = (name: string) =>
    page.getByRole("menuitem", { name }).evaluate((el) => {
        const r = el.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (r.left >= 0 && r.right <= document.documentElement.clientWidth && r.top >= 0 && r.bottom <= window.innerHeight && !!at && el.contains(at)) return true;
        const what = at ? `${at.tagName.toLowerCase()}${at.id ? `#${at.id}` : ""}.${String(at.className).replace(/\s+/g, ".")} "${(at.textContent ?? "").trim().slice(0, 40)}"` : "nothing";
        return `at ${Math.round(r.left)},${Math.round(r.top)}-${Math.round(r.right)},${Math.round(r.bottom)} in ${document.documentElement.clientWidth}x${window.innerHeight}; covered by ${what}`;
    });

async function axeBoth(p: Page) {
    for (const scheme of ["light", "dark"] as const) {
        await p.emulateMedia({ colorScheme: scheme });
        await p.waitForTimeout(300);
        const r = await new AxeBuilder({ page: p }).analyze();
        expect(r.violations.map((v) => `${scheme} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    await p.emulateMedia({ colorScheme: null });
}

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-manage-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-manage-ui-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    const { repo } = platform;
    projectId = repo.createProject({ name: "Code shop", platforms: ["web"], testingModes: ["code"] }).id as string;
    new ReviewStore(platform.db).setPolicy(projectId, { aiGenerated: false, edits: false, healing: false }, "test");
    repo.createApplication(projectId, "http://127.0.0.1:9801", { ...DEFAULT_JOB_OPTIONS });
    for (const [key, title] of [
        ["API-001", "Cart opens"],
        ["API-002", "Pay by card"],
        ["API-003", "Coupon applies"],
        ["API-004", "Receipt is sent"],
    ] as const) {
        const spec = TestSpecSchema.parse({ testId: key, title, kind: "api", category: "Checkout", steps: [{ action: "request", method: "GET", path: "/api/x" }, { action: "assertResponse", check: "status", expected: 200 }] });
        ids[title] = repo.insertTest({ projectId, suiteId: repo.getOrCreateSuite(projectId, "Checkout", "checkout"), jobId: null, spec, framework: defaultFramework("api"), validationStatus: "PENDING" });
    }
    const users = accessControlOf(server).users;
    const olga = users.create({ email: "olga@example.com", name: "Olga Owner", role: "owner" });
    users.setPassword(olga.id, await hashPassword("olga's long password"));
    const vic = users.create({ email: "vic@example.com", name: "Vic Viewer", role: "viewer" });
    users.setPassword(vic.id, await hashPassword("vic's long password"));
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await signIn(page, "olga@example.com", "olga's long password");
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("the Test scripts list", () => {
    it("renames a script in place, and says what is wrong with a name it cannot keep", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/scripts`);
        await pwExpect(rows()).toHaveCount(4);
        await page.getByRole("button", { name: "Actions for Pay by card" }).click();
        await page.getByRole("menuitem", { name: "Rename" }).click();
        const field = page.getByRole("textbox", { name: "New name of the script" });
        await pwExpect(field).toBeFocused();
        await field.fill("  ");
        await page.keyboard.press("Enter");
        await pwExpect(page.getByRole("alert").filter({ hasText: "A script needs a name of at least 3 characters." })).toBeVisible();
        await pwExpect(field).toHaveAttribute("aria-invalid", "true");
        // Escape leaves the name as it was.
        await page.keyboard.press("Escape");
        await pwExpect(field).toHaveCount(0);
        expect(await titles()).toContain("Pay by card");
        await page.getByRole("button", { name: "Actions for Pay by card" }).click();
        await page.getByRole("menuitem", { name: "Rename" }).click();
        await page.getByRole("textbox", { name: "New name of the script" }).fill("Pay by card and see the total");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await pwExpect(rows().locator(".sr-title", { hasText: "Pay by card and see the total" })).toBeVisible();
        expect(platform.repo.getTest(ids["Pay by card"]!)!.title).toBe("Pay by card and see the total");
    });

    it("moves scripts up and down with the keyboard, kept after a reload", async () => {
        expect(await titles()).toEqual(["Cart opens", "Pay by card and see the total", "Coupon applies", "Receipt is sent"]);
        await pwExpect(page.getByRole("button", { name: "Move Cart opens up" })).toBeDisabled();
        await pwExpect(page.getByRole("button", { name: "Move Receipt is sent down" })).toBeDisabled();
        const down = page.getByRole("button", { name: "Move Cart opens down" });
        await down.focus();
        await page.keyboard.press("Enter");
        await pwExpect.poll(titles).toEqual(["Pay by card and see the total", "Cart opens", "Coupon applies", "Receipt is sent"]);
        await pwExpect(page.getByTestId("move-said")).toHaveText("Moved “Cart opens” down, to place 2 of 4.");
        // The focus stays on the button that moved it, so pressing again keeps going.
        await pwExpect(page.getByRole("button", { name: "Move Cart opens down" })).toBeFocused();
        await page.keyboard.press("Enter");
        await pwExpect.poll(titles).toEqual(["Pay by card and see the total", "Coupon applies", "Cart opens", "Receipt is sent"]);
        await page.getByRole("button", { name: "Move Receipt is sent up" }).click();
        await pwExpect.poll(titles).toEqual(["Pay by card and see the total", "Coupon applies", "Receipt is sent", "Cart opens"]);
        expect(serverOrder()).toEqual(["Pay by card and see the total", "Coupon applies", "Receipt is sent", "Cart opens"]);
        await page.reload();
        await pwExpect.poll(titles).toEqual(["Pay by card and see the total", "Coupon applies", "Receipt is sent", "Cart opens"]);
    });

    it("deletes a script only after the app's own confirmation, which says what goes with it", async () => {
        let browserDialog = false;
        page.on("dialog", (d) => ((browserDialog = true), void d.dismiss()));
        await page.getByRole("button", { name: "Actions for Coupon applies" }).click();
        await page.getByRole("menuitem", { name: "Delete…" }).click();
        const dialog = page.getByTestId("delete-script-dialog");
        await pwExpect(dialog.getByRole("heading", { name: "Delete “Coupon applies”?" })).toBeVisible();
        await pwExpect(dialog).toContainText("run history");
        await pwExpect(dialog).toContainText("cannot be undone");
        const axe = await new AxeBuilder({ page }).include("dialog").analyze();
        expect(axe.violations.map((v) => v.id)).toEqual([]);
        // Keep it: nothing changes.
        await dialog.getByRole("button", { name: "Keep it" }).click();
        await pwExpect(dialog).toHaveCount(0);
        expect(platform.repo.getTest(ids["Coupon applies"]!)).toBeDefined();
        await page.getByRole("button", { name: "Actions for Coupon applies" }).click();
        await page.getByRole("menuitem", { name: "Delete…" }).click();
        await page.getByTestId("delete-script-dialog").getByRole("button", { name: "Delete script" }).click();
        await pwExpect(page.getByText("Deleted “Coupon applies”.")).toBeVisible();
        await pwExpect.poll(titles).toEqual(["Pay by card and see the total", "Receipt is sent", "Cart opens"]);
        expect(platform.repo.getTest(ids["Coupon applies"]!)).toBeUndefined();
        expect(browserDialog).toBe(false);
    });

    it("Rename and Delete in the last row's menu are fully on screen and reachable by keyboard, on a desktop and at 375 px", async () => {
        // The list's card clips what overflows it, and a menu hanging from a button at the row's left edge (375 px) ran off the screen.
        for (const width of [1280, 375]) {
            await page.setViewportSize({ width, height: width === 375 ? 740 : 900 });
            await page.goto(`${BASE}/#/projects/${projectId}/scripts`);
            await pwExpect.poll(titles).toEqual(["Pay by card and see the total", "Receipt is sent", "Cart opens"]);
            const button = page.getByRole("button", { name: "Actions for Cart opens" });
            await button.scrollIntoViewIfNeeded();
            await button.focus();
            await page.keyboard.press("Enter");
            await pwExpect(page.getByRole("menu")).toBeVisible();
            expect([width, await shown("Rename"), await shown("Delete…")]).toEqual([width, true, true]);
            for (const scheme of ["light", "dark"] as const) {
                await page.emulateMedia({ colorScheme: scheme });
                await page.waitForTimeout(300);
                await shot(`scripts-row-menu-${width}-${scheme}`);
            }
            await axeBoth(page);
            await pwExpect(page.getByRole("menu")).toBeVisible();
            // The keyboard reaches both entries in order; Delete still asks first.
            await page.keyboard.press("Tab");
            await pwExpect(page.getByRole("menuitem", { name: "Rename" })).toBeFocused();
            await page.keyboard.press("Tab");
            await pwExpect(page.getByRole("menuitem", { name: "Delete…" })).toBeFocused();
            await page.keyboard.press("Enter");
            const dialog = page.getByTestId("delete-script-dialog");
            await pwExpect(dialog.getByRole("heading", { name: "Delete “Cart opens”?" })).toBeVisible();
            await dialog.getByRole("button", { name: "Keep it" }).click();
            await pwExpect(dialog).toHaveCount(0);
            expect(platform.repo.getTest(ids["Cart opens"]!)).toBeDefined();
        }
        await page.setViewportSize({ width: 1280, height: 900 });
    });

    it("passes accessibility checks in light and dark", async () => {
        await axeBoth(page);
    });
});

describe("a script's own page", () => {
    it("at 375 px, More actions shows Rename and Delete wholly on screen", async () => {
        await page.setViewportSize({ width: 375, height: 740 });
        try {
            await page.goto(`${BASE}/#/tests/${ids["Cart opens"]}`);
            await pwExpect(page.getByRole("heading", { name: "Cart opens" })).toBeVisible();
            await page.getByRole("button", { name: "More actions" }).click();
            expect([await shown("Rename"), await shown("Delete…")]).toEqual([true, true]);
            for (const scheme of ["light", "dark"] as const) {
                await page.emulateMedia({ colorScheme: scheme });
                await page.waitForTimeout(300);
                await shot(`script-page-menu-375-${scheme}`);
            }
            await axeBoth(page);
            await page.keyboard.press("Escape");
        } finally {
            await page.setViewportSize({ width: 1280, height: 900 });
        }
    });

    it("renames and deletes from More actions", async () => {
        await page.goto(`${BASE}/#/tests/${ids["Cart opens"]}`);
        await pwExpect(page.getByRole("heading", { name: "Cart opens" })).toBeVisible();
        await page.getByRole("button", { name: "More actions" }).click();
        await page.getByRole("menuitem", { name: "Rename" }).click();
        await page.getByRole("textbox", { name: "New name of the script" }).fill("Cart opens with one item");
        await page.keyboard.press("Enter");
        await pwExpect(page.getByRole("heading", { name: "Cart opens with one item" })).toBeVisible();
        await page.getByRole("button", { name: "More actions" }).click();
        await page.getByRole("menuitem", { name: "Delete…" }).click();
        await page.getByTestId("delete-script-dialog").getByRole("button", { name: "Delete script" }).click();
        await pwExpect(page).toHaveURL(/\/scripts/);
        await pwExpect.poll(titles).toEqual(["Pay by card and see the total", "Receipt is sent"]);
        expect(platform.repo.getTest(ids["Cart opens"]!)).toBeUndefined();
    });
});

describe("a viewer", () => {
    it("sees the scripts and none of the buttons that change them", async () => {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const p2 = await ctx.newPage();
        try {
            await signIn(p2, "vic@example.com", "vic's long password");
            await p2.goto(`${BASE}/#/projects/${projectId}/scripts`);
            await pwExpect(p2.getByRole("list", { name: "Test scripts in Checkout" }).getByTestId("script-row")).toHaveCount(2);
            await pwExpect(p2.getByRole("button", { name: /^Move .* (up|down)$/ })).toHaveCount(0);
            await pwExpect(p2.getByRole("button", { name: /^Actions for / })).toHaveCount(0);
            await p2.goto(`${BASE}/#/tests/${ids["Receipt is sent"]}`);
            await pwExpect(p2.getByRole("heading", { name: "Receipt is sent" })).toBeVisible();
            await p2.getByRole("button", { name: "More actions" }).click();
            await pwExpect(p2.getByRole("menuitem").first()).toBeVisible();
            await pwExpect(p2.getByRole("menuitem", { name: "Rename" })).toHaveCount(0);
            await pwExpect(p2.getByRole("menuitem", { name: "Delete…" })).toHaveCount(0);
            await p2.keyboard.press("Escape");
            await axeBoth(p2);
        } finally {
            await ctx.close();
        }
    });
});
