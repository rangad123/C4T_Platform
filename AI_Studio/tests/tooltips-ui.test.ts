/**
 * Tooltips in a real browser (round 19, TT-CORE; round 21: three engines): the shared Tooltip, HelpTip and the ui.tsx components that
 * use them, on a harness page made only of those components (tests/fixtures/tooltip-harness, built here with Vite into a temporary
 * folder).
 *
 * Checks: hover delay, keyboard focus opens at once, moving between tooltips is instant, Escape closes the tooltip and not the dialog
 * around it, the panel is portalled (never clipped by a scroll container; inside the open dialog's top layer), it never takes a click,
 * icon-only buttons show their name, tap on HelpTip (and no hover tips on touch), a menu and a dialog still work, 375 px with no
 * sideways scroll, reduced motion, axe in light and dark with tooltips open. Round 21: a disabled Button with a tip is reachable by
 * keyboard (aria-disabled) and still does nothing, not even submit its form; a list explains its badges with one "?" (BadgeKey).
 *
 * The whole set runs in Chromium, Firefox and WebKit, each only when Playwright's build of it is installed on this computer (the test
 * says so in the name of the skipped group otherwise; nothing is downloaded). Touch: Firefox has no mobile emulation in Playwright
 * (`isMobile` is Chromium and WebKit only), so its phone context is a 375 px touch screen without it.
 *
 * Run inside the browser lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/tooltips-ui.test.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { chromium, firefox, webkit, type Browser, type BrowserContext, type BrowserType, type Locator, type Page } from "playwright";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PORT = 7230;
const BASE = `http://127.0.0.1:${PORT}`;
const HARNESS = path.resolve(__dirname, "fixtures/tooltip-harness");
let outDir = "";
let server: http.Server;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const pageErrors: string[] = [];

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

/** The engines, and whether Playwright's build of each is on this computer (never downloaded by a test). */
const ENGINES: Array<{ name: "Chromium" | "Firefox" | "WebKit"; type: BrowserType; installed: boolean }> = [
    { name: "Chromium", type: chromium },
    { name: "Firefox", type: firefox },
    { name: "WebKit", type: webkit },
].map((e) => {
    let installed = false;
    try {
        installed = fs.existsSync(e.type.executablePath());
    } catch {
        installed = false;
    }
    return { ...(e as { name: "Chromium" | "Firefox" | "WebKit"; type: BrowserType }), installed };
});

beforeAll(async () => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-harness-"));
    await build({ configFile: false, root: HARNESS, logLevel: "warn", publicDir: false, plugins: [react()], build: { outDir, emptyOutDir: true, sourcemap: false } });
    server = http.createServer((req, res) => {
        const rel = decodeURIComponent((req.url ?? "/").split("?")[0]!.split("#")[0]!);
        const file = path.join(outDir, rel === "/" ? "index.html" : rel);
        if (!file.startsWith(outDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void res.writeHead(404).end();
        res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(fs.readFileSync(file));
    });
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
}, 180_000);

afterAll(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
});

async function fresh(p: Page = page) {
    await p.goto(`${BASE}/`);
    await pwExpect(p.getByRole("heading", { name: "Tooltip harness" })).toBeVisible();
    await p.mouse.move(1, 1);
}
/** The tooltip panel an element points at with aria-describedby (the last id). */
async function tipOf(el: Locator, p: Page = page): Promise<Locator> {
    const ids = (await el.getAttribute("aria-describedby")) ?? "";
    const id = ids.split(/\s+/).filter(Boolean).at(-1);
    expect(id, "aria-describedby").toBeTruthy();
    return p.locator(`[id="${id}"]`);
}
const box = async (l: Locator) => (await l.boundingBox())!;
async function axe(p: Page = page) {
    const result = await new AxeBuilder({ page: p }).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
/**
 * Keyboard focus on `el`: focus by script is not keyboard focus (no :focus-visible), so step away with the keyboard and back to it.
 * Backwards then forwards, or, for the first stop on the page (Firefox moves focus out of the page on Shift+Tab there), forwards then
 * backwards. WebKit, like Safari, does not stop at links on Tab (Safari's Option+Tab does; Playwright's WebKit on Windows has no
 * equivalent): there a link is focused right after a key press, which the browser treats as keyboard focus too.
 */
async function tabTo(el: Locator, p: Page = page, engine = "") {
    if (engine === "WebKit" && (await el.evaluate((n) => n.tagName)) === "A") {
        await p.keyboard.press("Shift");
        await el.focus();
        await pwExpect(el).toBeFocused();
        return;
    }
    await el.focus();
    await p.keyboard.press("Shift+Tab");
    await p.keyboard.press("Tab");
    if (await el.evaluate((n) => n === document.activeElement)) return;
    await el.focus();
    await p.keyboard.press("Tab");
    await p.keyboard.press("Shift+Tab");
    await pwExpect(el).toBeFocused();
}

for (const engine of ENGINES) {
    const skipped = engine.installed ? "" : ` (skipped: Playwright's ${engine.name} is not installed on this computer)`;
    describe.skipIf(!engine.installed)(`${engine.name}${skipped}`, () => {
        beforeAll(async () => {
            browser = await engine.type.launch();
            context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
            page = await context.newPage();
            pageErrors.length = 0;
            page.on("pageerror", (e) => pageErrors.push(String(e)));
        }, 120_000);
        afterAll(async () => {
            await browser?.close();
        });

        describe("Tooltip on a desktop", () => {
            it("opens after the hover delay, says its sentence, and is described by the element", async () => {
                await fresh();
                const run = page.getByRole("button", { name: "Run all", exact: true });
                const tip = await tipOf(run);
                await pwExpect(tip).toHaveAttribute("role", "tooltip");
                await pwExpect(tip).toHaveText("Starts a run of every test in this project.");
                // Screen readers get it as the button's description, closed or open.
                await pwExpect(run).toHaveAccessibleDescription("Starts a run of every test in this project.");
                // The delay is measured in the page, from the pointer arriving to the tip showing: a cold browser can return from hover()
                // several hundred milliseconds after the pointer arrived, so the test's own clock cannot see the 400 ms delay reliably.
                const tipId = (await tip.getAttribute("id"))!;
                await run.evaluate((el, id) => {
                    const w = window as unknown as { __tipTiming?: { entered?: number; shown?: number } };
                    const timing: { entered?: number; shown?: number } = {};
                    w.__tipTiming = timing;
                    el.addEventListener("pointerenter", () => (timing.entered ??= performance.now()), { once: true });
                    const panel = document.getElementById(id)!;
                    const watch = () => {
                        if (timing.entered !== undefined && !panel.hidden && getComputedStyle(panel).visibility !== "hidden") timing.shown = performance.now();
                        else requestAnimationFrame(watch);
                    };
                    requestAnimationFrame(watch);
                }, tipId);
                await run.hover();
                await pwExpect(tip).toBeVisible({ timeout: 3000 });
                const timing = await page.evaluate(() => (window as unknown as { __tipTiming: { entered?: number; shown?: number } }).__tipTiming);
                expect(timing.entered, "the pointer reached the button").toBeDefined();
                expect(timing.shown, "the tip was seen opening").toBeDefined();
                // Not at once (the delay is 400 ms) ... but soon after.
                expect(timing.shown! - timing.entered!).toBeGreaterThanOrEqual(300);
                expect(timing.shown! - timing.entered!).toBeLessThan(2000);
                const t = await box(tip);
                const b = await box(run);
                expect(t.y + t.height).toBeLessThanOrEqual(b.y);
                expect(t.width).toBeLessThanOrEqual(281);
                // Leaving closes it.
                await page.mouse.move(1, 1);
                await pwExpect(tip).toBeHidden({ timeout: 1000 });
            });

            it("moving from one tooltip to the next opens the next without the delay", async () => {
                await fresh();
                const run = page.getByRole("button", { name: "Run all", exact: true });
                const exp = page.getByRole("button", { name: "Export", exact: true });
                await run.hover();
                await pwExpect(await tipOf(run)).toBeVisible({ timeout: 2000 });
                await exp.hover();
                // Well under the 400 ms delay: one tip at a time, and the second follows at once.
                await pwExpect(await tipOf(exp)).toBeVisible({ timeout: 250 });
                await pwExpect(await tipOf(run)).toBeHidden();
                expect(await page.locator(".tt:not([hidden])").count()).toBe(1);
            });

            it("keyboard focus opens it at once and Escape closes it; a press closes it too", async () => {
                await fresh();
                const run = page.getByRole("button", { name: "Run all", exact: true });
                await page.getByRole("heading", { name: "Tooltip harness" }).click();
                await tabTo(run, page, engine.name);
                const tip = await tipOf(run);
                await pwExpect(tip).toBeVisible({ timeout: 300 });
                await page.keyboard.press("Escape");
                await pwExpect(tip).toBeHidden();
                await pwExpect(run).toBeFocused();
                // Tab on: the next tip opens, the first stays closed.
                await page.keyboard.press("Tab");
                await pwExpect(await tipOf(page.getByRole("button", { name: "Export", exact: true }))).toBeVisible({ timeout: 300 });
                // Pressing the button does its job and the tip gets out of the way.
                await page.keyboard.press("Enter");
                await pwExpect(page.locator("#out")).toHaveText("export");
                await pwExpect(page.locator(".tt:not([hidden])")).toHaveCount(0);
            });

            it("an icon-only button shows its name, then what it does; the tip never takes a click", async () => {
                await fresh();
                const del = page.getByRole("button", { name: "Delete step 1", exact: true });
                await del.hover();
                const tip = await tipOf(del);
                await pwExpect(tip).toBeVisible({ timeout: 2000 });
                await pwExpect(tip.locator(".tt-name")).toHaveText("Delete step 1");
                await pwExpect(tip).toContainText("Removes this step; Undo brings it back.");
                const t = await box(tip);
                const under = await page.evaluate(([x, y]) => {
                    const el = document.elementFromPoint(x!, y!);
                    return el ? (el.closest(".tt") ? "tooltip" : el.tagName) : "none";
                }, [t.x + t.width / 2, t.y + t.height / 2]);
                expect(under).not.toBe("tooltip");
                expect(await tip.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
            });

            it("badges and metrics explain themselves from help.ts", async () => {
                await fresh();
                const badge = page.locator(".badge", { hasText: "Needs a look" });
                await badge.hover();
                const tip = await tipOf(badge);
                await pwExpect(tip).toBeVisible({ timeout: 2000 });
                await pwExpect(tip).toContainText("found something in your application");
                // tipFocusable: the keyboard reaches it too.
                await pwExpect(badge).toHaveAttribute("tabindex", "0");
                const sev = page.locator(".badge", { hasText: "High severity" });
                await pwExpect(await tipOf(sev)).toHaveText(/Fix soon\..*Rated from: missing security header\./);
                await pwExpect(sev).not.toHaveAttribute("tabindex", "0");
                await pwExpect(await tipOf(page.locator(".badge", { hasText: "Run finished" }))).toHaveText("The run finished and every test that ran passed.");
                const about = page.getByRole("button", { name: "About Latest pass rate", exact: true });
                await about.focus();
                await page.keyboard.press("Enter");
                await pwExpect(await tipOf(about)).toBeVisible();
                await pwExpect(await tipOf(about)).toContainText("most recent finished run");
                await page.keyboard.press("Escape");
                await pwExpect(await tipOf(about)).toBeHidden();
            });

            it("a list explains the badges it shows with one keyboard stop, and only those", async () => {
                await fresh();
                const list = page.getByRole("region", { name: "List with badges" });
                // The badges in the rows are not tab stops ...
                for (const b of await list.locator(".badge").all()) await pwExpect(b).not.toHaveAttribute("tabindex", "0");
                // ... the key beside the heading is.
                const key = list.getByRole("button", { name: "About the badges in this list", exact: true });
                await tabTo(key, page, engine.name);
                const tip = await tipOf(key);
                await pwExpect(tip).toBeVisible({ timeout: 300 });
                await pwExpect(tip).toContainText("Passing: The last run of this test passed");
                await pwExpect(tip).toContainText("Failing: The last run did not pass");
                await pwExpect(tip).toContainText("Low severity: Minor.");
                // Only what the list shows: no "Needs a look", no other severity.
                await pwExpect(tip).not.toContainText("Needs a look");
                await pwExpect(tip).not.toContainText("High severity");
                // Passing comes before Failing (the order the definitions are read in), each word once.
                const text = (await tip.textContent()) ?? "";
                expect(text.indexOf("Passing:")).toBeLessThan(text.indexOf("Failing:"));
                expect(text.split("Failing:").length).toBe(2);
                await pwExpect(key).toHaveAccessibleDescription(/Passing: .*Failing: .*Low severity: /);
                // It stays inside the window, wider than an ordinary tip.
                const t = await box(tip);
                expect(t.x).toBeGreaterThanOrEqual(0);
                expect(t.x + t.width).toBeLessThanOrEqual(1280);
                expect(t.width).toBeLessThanOrEqual(361);
                await page.keyboard.press("Escape");
                await pwExpect(tip).toBeHidden();
            });

            it("a disabled button with a reason: Tab reaches it, it says why, and nothing happens, not even a form submit", async () => {
                await fresh();
                const publish = page.getByRole("button", { name: "Publish", exact: true });
                const plain = page.getByRole("button", { name: "No reason given", exact: true });
                // Disabled for assistive technology and for Playwright alike, but not with the attribute that removes it from the tab order.
                await pwExpect(publish).toBeDisabled();
                await pwExpect(publish).toHaveAttribute("aria-disabled", "true");
                expect(await publish.evaluate((el) => (el as HTMLButtonElement).disabled)).toBe(false);
                // Without a reason to show, a disabled button keeps the attribute (as before).
                expect(await plain.evaluate((el) => (el as HTMLButtonElement).disabled)).toBe(true);
                // Looks the same as a disabled one.
                expect(await publish.evaluate((el) => getComputedStyle(el).opacity)).toBe(await plain.evaluate((el) => getComputedStyle(el).opacity));

                const name = page.getByLabel("Release name", { exact: true });
                await name.focus();
                await page.keyboard.press("Tab");
                await pwExpect(publish).toBeFocused();
                const tip = await tipOf(publish);
                await pwExpect(tip).toBeVisible({ timeout: 300 });
                await pwExpect(tip).toHaveText("Save or discard your changes first.");
                await pwExpect(publish).toHaveAccessibleDescription("Save or discard your changes first.");
                // Enter and Space do nothing.
                await page.keyboard.press("Enter");
                await page.keyboard.press(" ");
                await pwExpect(page.locator("#out")).toHaveText("nothing yet");
                // Tab goes on past the button without a reason (it is not a tab stop).
                await page.keyboard.press("Tab");
                await pwExpect(plain).not.toBeFocused();
                // A click (forced past Playwright's own disabled check) does nothing either.
                await publish.click({ force: true });
                await pwExpect(page.locator("#out")).toHaveText("nothing yet");
                // Enter in the form's field would submit it through its submit button: it does not.
                await name.focus();
                await page.keyboard.press("Enter");
                await page.waitForTimeout(200);
                await pwExpect(page.locator("#out")).toHaveText("nothing yet");
                // Hovering shows the reason too.
                await page.mouse.move(1, 1);
                await publish.hover();
                await pwExpect(await tipOf(publish)).toBeVisible({ timeout: 2000 });
            });

            it("is portalled: a scroll container does not clip it", async () => {
                await fresh();
                const scroller = page.locator("#scroller");
                await scroller.evaluate((el) => (el.scrollTop = 70));
                const inside = page.getByRole("button", { name: "Inside the list", exact: true });
                await inside.hover();
                const tip = await tipOf(inside);
                await pwExpect(tip).toBeVisible({ timeout: 2000 });
                expect(await tip.evaluate((el) => el.parentElement === document.body)).toBe(true);
                const s = await box(scroller);
                const t = await box(tip);
                // It sticks out of the list's box and is fully drawn.
                expect(t.y < s.y || t.y + t.height > s.y + s.height).toBe(true);
                const visible = await tip.evaluate((el) => {
                    const r = el.getBoundingClientRect();
                    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
                });
                expect(visible).toBe(true);
                // Scrolling closes it.
                await page.mouse.wheel(0, 40);
                await pwExpect(tip).toBeHidden({ timeout: 1000 });
            });

            it("a menu still opens and works, and no tip covers it", async () => {
                await fresh();
                const trigger = page.getByRole("button", { name: "More actions", exact: true });
                await trigger.hover();
                await pwExpect(await tipOf(trigger)).toBeVisible({ timeout: 2000 });
                await pwExpect(await tipOf(trigger)).toHaveText("More actions");
                await trigger.click();
                const menu = page.getByRole("menu");
                await pwExpect(menu).toBeVisible();
                await pwExpect(await tipOf(trigger)).toBeHidden();
                const item = page.getByRole("menuitem", { name: "Download report", exact: true });
                await item.hover();
                const tip = await tipOf(item);
                await pwExpect(tip).toBeVisible({ timeout: 2000 });
                const m = await box(menu);
                const t = await box(tip);
                const overlaps = t.x < m.x + m.width && t.x + t.width > m.x && t.y < m.y + m.height && t.y + t.height > m.y;
                expect(overlaps).toBe(false);
                await item.click();
                await pwExpect(page.locator("#out")).toHaveText("menu: report");
                await pwExpect(menu).toBeHidden();
                // Escape still closes a menu when no tip is open.
                await trigger.click();
                await pwExpect(menu).toBeVisible();
                await page.keyboard.press("Escape");
                await pwExpect(menu).toBeHidden();
                await pwExpect(trigger).toBeFocused();
            });

            it("inside a dialog: drawn in the dialog's top layer, Escape closes the tip and not the dialog, the dialog still works", async () => {
                await fresh();
                await page.getByRole("button", { name: "Open dialog", exact: true }).click();
                const dialog = page.getByRole("dialog", { name: "Save the changes" });
                await pwExpect(dialog).toBeVisible();
                const save = dialog.getByRole("button", { name: "Save", exact: true });
                // Keyboard: Tab to Save.
                await dialog.getByRole("button", { name: "Cancel", exact: true }).focus();
                await page.keyboard.press("Tab");
                await pwExpect(save).toBeFocused();
                const tip = await tipOf(save);
                await pwExpect(tip).toBeVisible({ timeout: 300 });
                expect(await tip.evaluate((el) => el.parentElement?.tagName)).toBe("DIALOG");
                await page.keyboard.press("Escape");
                await pwExpect(tip).toBeHidden();
                await pwExpect(dialog).toBeVisible();
                await pwExpect(page.locator("#out")).toHaveText("nothing yet");
                // The HelpTip inside the dialog, then the dialog's own Escape.
                const about = dialog.getByRole("button", { name: "About saving", exact: true });
                await about.click();
                await pwExpect(await tipOf(about)).toBeVisible();
                await page.keyboard.press("Escape");
                await pwExpect(await tipOf(about)).toBeHidden();
                await pwExpect(dialog).toBeVisible();
                await page.keyboard.press("Escape");
                await pwExpect(dialog).toBeHidden();
                await pwExpect(page.locator("#out")).toHaveText("dialog: cancelled");
                // Open again and press Save with the mouse: its handler runs.
                await page.getByRole("button", { name: "Open dialog", exact: true }).click();
                await save.hover();
                await pwExpect(await tipOf(save)).toBeVisible({ timeout: 2000 });
                await save.click();
                await pwExpect(page.locator("#out")).toHaveText("dialog: saved");
                await pwExpect(dialog).toBeHidden();
            });

            it("FieldHelp: the hint stays visible, the HelpTip explains, the input is described by the hint", async () => {
                await fresh();
                await pwExpect(page.getByText("Between 1 and 10.", { exact: true })).toBeVisible();
                await pwExpect(page.getByLabel("Requests per second", { exact: true })).toHaveAttribute("aria-describedby", "rps-hint");
                const about = page.getByRole("button", { name: "About Requests per second", exact: true });
                const r = await box(about);
                expect(Math.min(r.width, r.height)).toBeGreaterThanOrEqual(44);
                await about.click();
                await pwExpect(about).toHaveAttribute("aria-expanded", "true");
                await pwExpect(await tipOf(about)).toBeVisible();
                // A pinned HelpTip stays while the pointer moves away; a second press closes it.
                await page.mouse.move(1, 1);
                await page.waitForTimeout(300);
                await pwExpect(await tipOf(about)).toBeVisible();
                await about.click();
                await pwExpect(await tipOf(about)).toBeHidden();
            });

            it("appears fully opaque at once, with no motion (with or without reduced motion)", async () => {
                for (const reducedMotion of ["reduce", "no-preference"] as const) {
                    await page.emulateMedia({ reducedMotion });
                    await fresh();
                    const run = page.getByRole("button", { name: "Run all", exact: true });
                    await run.hover();
                    const tip = await tipOf(run);
                    await pwExpect(tip).toBeVisible({ timeout: 2000 });
                    expect(await tip.evaluate((el) => [getComputedStyle(el).animationName, getComputedStyle(el).opacity])).toEqual(["none", "1"]);
                }
                await page.emulateMedia({ reducedMotion: null });
            });

            it("axe finds nothing in light and dark, with tips open", async () => {
                for (const scheme of ["light", "dark"] as const) {
                    await page.emulateMedia({ colorScheme: scheme });
                    await fresh();
                    await page.waitForTimeout(400);
                    // A pinned HelpTip, then a hover tip (one at a time: the second replaces the first).
                    await page.getByRole("button", { name: "About Requests per second", exact: true }).click();
                    await pwExpect(page.locator(".tt:not([hidden])")).toHaveCount(1);
                    await axe();
                    await page.getByRole("button", { name: "Run all", exact: true }).hover();
                    await pwExpect(page.locator(".tt:not([hidden])")).toHaveText("Starts a run of every test in this project.", { timeout: 2000 });
                    await axe();
                    const tip = page.locator(".tt:not([hidden])");
                    const colors = await tip.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor]);
                    expect(colors[0]).not.toBe(colors[1]);
                    // The badge key's wide panel too.
                    await page.getByRole("button", { name: "About the badges in this list", exact: true }).click();
                    await pwExpect(page.locator(".tt:not([hidden])")).toContainText("Low severity");
                    await axe();
                }
                await page.emulateMedia({ colorScheme: null });
                expect(pageErrors).toEqual([]);
            });
        });

        describe("Tooltip on a phone (375 px, touch)", () => {
            let phone: BrowserContext;
            let p: Page;
            beforeAll(async () => {
                // Playwright has no mobile emulation for Firefox (isMobile is Chromium and WebKit only): a touch screen at phone width instead.
                phone = await browser.newContext({ viewport: { width: 375, height: 740 }, hasTouch: true, ...(engine.name === "Firefox" ? {} : { isMobile: true }) });
                p = await phone.newPage();
            });
            afterAll(async () => phone?.close());

            it("tapping a button shows no hover tip; tapping a HelpTip opens it, a second tap or a tap elsewhere closes it", async () => {
                await fresh(p);
                await p.getByRole("button", { name: "Run all", exact: true }).tap();
                await pwExpect(p.locator("#out")).toHaveText("run all");
                await p.waitForTimeout(600);
                await pwExpect(p.locator(".tt:not([hidden])")).toHaveCount(0);

                const about = p.getByRole("button", { name: "About Requests per second", exact: true });
                await about.scrollIntoViewIfNeeded();
                await about.tap();
                const tip = await tipOf(about, p);
                await pwExpect(tip).toBeVisible();
                await about.tap();
                await pwExpect(tip).toBeHidden();
                await about.tap();
                await pwExpect(tip).toBeVisible();
                await p.getByRole("heading", { name: "Tooltip harness" }).tap();
                await pwExpect(tip).toBeHidden();
            });

            it("stays inside the narrow window with no sideways scroll", async () => {
                await fresh(p);
                const edge = p.getByRole("link", { name: "Edge link", exact: true });
                await edge.scrollIntoViewIfNeeded();
                // Keyboard focus works on a phone layout too (a keyboard attached to a tablet).
                await tabTo(edge, p, engine.name);
                const tip = await tipOf(edge, p);
                await pwExpect(tip).toBeVisible({ timeout: 500 });
                const t = await box(tip);
                expect(t.x).toBeGreaterThanOrEqual(0);
                expect(t.x + t.width).toBeLessThanOrEqual(375);
                // The wide badge key also fits.
                const key = p.getByRole("button", { name: "About the badges in this list", exact: true });
                await key.scrollIntoViewIfNeeded();
                await key.tap();
                const k = await box(await tipOf(key, p));
                expect(k.x).toBeGreaterThanOrEqual(0);
                expect(k.x + k.width).toBeLessThanOrEqual(375);
                const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
                expect(overflow).toBe(0);
                await axe(p);
            });
        });
    });
}
