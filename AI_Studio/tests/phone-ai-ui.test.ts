/**
 * AI phone tests, the screens, in a real browser (MX-C). Start (three entry points, one panel), watch the phone, approve the plan, see the tests.
 *
 * The API underneath is a FAKE (tests/fixtures/phone-fake-api.ts): a small server that serves the built web UI and answers the routes these screens
 * use from state each test sets. The screens, their requests and their words are real; what a phone exploration really does is MX-A and MX-B's work and is
 * exercised by tests/phone-ai-real.test.ts (which says why it is skipped while their routes are missing). Nothing here touches an emulator, adb, a model or ./data.
 *
 *   start: Settings, Mobile app (not New test script), the welcome page; no app, iPhone only, no phone or runner, runner offline or out of date, no AI model, refused starts
 *   watch: phone-shaped picture, activity line, counters, calm list of what was skipped, Stop exploring, the last picture kept
 *   plan: found sentence, per kind and per idea edits, screens found, create, discard; then the tests as they appear and the Tests page
 *   the bar: keyboard only, 375 px without sideways scroll, 44 px targets, axe in light and dark, no retired word; screenshots in .scratch/phone-ai/shots
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/phone-ai-ui.test.ts
 * Port: fake API and UI 6690.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.js";
import { DEFAULT_CONFIG, startPhoneFake, type PhoneFake } from "./fixtures/phone-fake-api.js";

const PORT = 6690;
const SHOTS = path.join(REPO_ROOT, ".scratch", "phone-ai", "shots");
const APP = "com.example.shop";

let fake: PhoneFake;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let camera: Page;
let tmp: string;
const consoleErrors: string[] = [];

// ── helpers ───────────────────────────────────────────────────────────────────
const dialog = () => page.getByRole("dialog", { name: "Explore the phone app (AI)", exact: true });
async function visit(hash: string) {
    // A full load every time: the page keeps what it fetched once (the platform settings) for as long as it lives, and each test sets its own.
    await page.goto("about:blank");
    await page.goto(`${fake.base}/${hash}`);
}
async function shot(name: string) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}
async function settle(scheme: "light" | "dark" | null) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(400);
}
async function axe(scope?: string) {
    let b = new AxeBuilder({ page });
    if (scope) b = b.include(scope);
    const result = await b.analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
async function axeBoth(open: () => Promise<void>, scope?: string) {
    for (const scheme of ["light", "dark"] as const) {
        await settle(scheme);
        await open();
        await page.waitForTimeout(400);
        await axe(scope);
    }
    await settle(null);
}
async function noOverflow() {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const wide = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".content *, dialog[open] *"))
            .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !el.closest(".tabs, .subtabs, pre, code"))
            .filter((el) => !Array.from(el.children).some((c) => c.getBoundingClientRect().right > document.documentElement.clientWidth + 1))
            .slice(0, 5)
            .map((el) => `${el.tagName.toLowerCase()}.${el.className} "${(el.textContent ?? "").trim().slice(0, 40)}"`),
    );
    expect({ overflow, wide }, page.url()).toEqual({ overflow: 0, wide: [] });
}
async function tallEnough(loc: ReturnType<Page["locator"]>, what: string) {
    const box = await loc.boundingBox();
    expect(box?.height ?? 0, `${what} is at least 44 px tall`).toBeGreaterThanOrEqual(43.5);
}
async function narrow<T>(fn: () => Promise<T>): Promise<T> {
    await page.setViewportSize({ width: 375, height: 800 });
    try {
        return await fn();
    } finally {
        await page.setViewportSize({ width: 1280, height: 900 });
    }
}

/** A real portrait picture (what a phone screen looks like), taken by the real browser, as base64 JPEG. */
async function phoneJpeg(title: string, tone = "#0d9488"): Promise<string> {
    await camera.setContent(
        `<!doctype html><body style="margin:0;width:360px;height:640px;font:22px sans-serif;background:#f4f7f7;display:flex;flex-direction:column"><div style="background:${tone};color:#fff;padding:36px 20px 16px;font-size:26px">${title}</div><div style="padding:24px 20px;display:grid;gap:16px"><div style="padding:14px;background:#fff;border:1px solid #cfd8d8;border-radius:10px">Search products</div><div style="padding:14px;background:${tone};color:#fff;border-radius:10px;text-align:center">Sign in</div><div style="padding:14px;background:#fff;border:1px solid #cfd8d8;border-radius:10px">Cart</div></div></body>`,
    );
    return (await camera.screenshot({ type: "jpeg", quality: 60 })).toString("base64");
}
let frameTick = 0;
async function showFrame(jobId: string, title: string, note: string, over: Record<string, unknown> = {}) {
    fake.frames.set(jobId, { imageBase64: await phoneJpeg(title), url: `android-app://${APP}`, title, note, phase: "exploring", pagesSeen: 4, at: new Date(Date.now() + frameTick++).toISOString(), ...over });
}

const FAMILY = { signIn: "Signing in", navigation: "Moving between screens", forms: "Forms", lists: "Lists and details" } as const;
type Fam = keyof typeof FAMILY;
const PHONE_IDEAS: Array<{ id: string; family: Fam; title: string; goal: string; priority: string; path: string[] }> = [
    { id: "M-01", family: "signIn", title: "Sign in with a test account", goal: "A user with a valid account reaches the home screen.", priority: "critical", path: ["Home", "Sign in", "Home"] },
    { id: "M-02", family: "signIn", title: "Sign in with an empty password", goal: "The app asks for the password.", priority: "high", path: ["Home", "Sign in"] },
    { id: "M-03", family: "navigation", title: "Open the cart from Home", goal: "The cart screen opens.", priority: "medium", path: ["Home", "Cart"] },
    { id: "M-04", family: "navigation", title: "Go back from the cart", goal: "Back returns to Home.", priority: "medium", path: ["Home", "Cart", "Home"] },
    { id: "M-05", family: "navigation", title: "Open the product list", goal: "Products are listed.", priority: "medium", path: ["Home", "Product list"] },
    { id: "M-06", family: "navigation", title: "Open a product", goal: "The product screen opens.", priority: "low", path: ["Home", "Product list", "Product"] },
    { id: "M-07", family: "navigation", title: "Switch between tabs", goal: "Every tab opens.", priority: "low", path: ["Home"] },
    { id: "M-08", family: "forms", title: "Search with a word", goal: "Results appear.", priority: "medium", path: ["Home"] },
    { id: "M-09", family: "forms", title: "Search with nothing typed", goal: "The app does not fail.", priority: "low", path: ["Home"] },
    { id: "M-10", family: "forms", title: "Fill in the address form", goal: "The form accepts a valid address.", priority: "low", path: ["Home", "Cart"] },
    { id: "M-11", family: "lists", title: "Scroll the product list", goal: "More products load.", priority: "low", path: ["Home", "Product list"] },
    { id: "M-12", family: "lists", title: "Open the first product in the list", goal: "Its details show.", priority: "medium", path: ["Home", "Product list", "Product"] },
];
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
const ID = Object.fromEntries(PHONE_IDEAS.map((i) => [i.title, i.id])) as Record<string, string>;

/** What GET /plans/:jobId answers for a phone app: the same shape as for a website, with the phone's own facts in `phone`. */
const PHONE_PLAN = (jobId: string, over: Record<string, unknown> = {}) => ({
    ready: true,
    jobId,
    status: "COMPLETED",
    createdAt: new Date().toISOString(),
    url: `android-app://${APP}`,
    targets: ["mobile"],
    found: { pages: 0, apiEndpoints: 0, forms: 2, journeys: 0, screens: 9 },
    about: null,
    pages: [],
    ideas: PHONE_IDEAS.map((i) => ({ id: i.id, title: i.title, journey: FAMILY[i.family], priority: i.priority, type: "functional" })),
    phone: {
        appPackage: APP,
        appName: "Shop",
        screens: [
            { id: "S1", title: "Home", kind: "start", elements: 9, visits: 4 },
            { id: "S2", title: "Sign in", kind: "signin", elements: 5, visits: 2 },
            { id: "S3", title: "Product list", kind: "list", elements: 12, visits: 2 },
            { id: "S4", title: "Cart", kind: "other", elements: 6, visits: 1 },
        ],
        ideas: PHONE_IDEAS.map((i) => ({ id: i.id, title: i.title, goal: i.goal, family: i.family, familyLabel: FAMILY[i.family], priority: i.priority, path: i.path, usesSignIn: i.family === "signIn", steps: 4 })),
        couldNotWrite: [],
        skipped: [
            { message: "Skipped “Delete account” because it looks destructive", why: "destructive" },
            { message: "Skipped “Place order” because it looks like paying", why: "payment" },
        ],
        signInNeeded: false,
        signedIn: true,
        stats: { actions: 31, modelCalls: 12, durationMs: 90_000, stoppedBecause: "done" },
    },
    families: (Object.keys(FAMILY) as Fam[]).map((k) => ({ id: `phone${cap(k)}`, label: FAMILY[k], about: "x", count: PHONE_IDEAS.filter((i) => i.family === k).length, on: true, option: "mobile", needs: "mobile" })),
    total: 12,
    warnings: [],
    signInDetails: true,
    used: null,
    ...over,
});

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-phone-ui-"));
    fake = await startPhoneFake(PORT);
    browser = await chromium.launch();
    camera = await (await browser.newContext({ viewport: { width: 360, height: 640 } })).newPage();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await fake?.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
    fake.requests.length = 0;
    fake.config = DEFAULT_CONFIG();
    fake.agents.length = 0;
    fake.startError = undefined;
    fake.planError = undefined;
    fake.delayMs = 0;
});

// ── start ─────────────────────────────────────────────────────────────────────

describe("start: Settings, Mobile app (round 38: not a way of making a test script)", () => {
    it("is not an entry of New test script", async () => {
        const p = fake.addProject("No app yet", null);
        await visit(`#/projects/${p.id}/scripts`);
        await page.getByRole("button", { name: "New test script", exact: true }).first().click();
        await pwExpect(page.getByRole("menuitem", { name: "Build steps by hand", exact: true })).toBeVisible();
        await pwExpect(page.getByRole("menuitem", { name: "Explore the phone app (AI)", exact: true })).toHaveCount(0);
        await page.keyboard.press("Escape");
        expect(await dialog().count()).toBe(0);
    });

    it("with an app, Explore with AI in Settings, Mobile app opens the start panel", async () => {
        const p = fake.addProject("Shop");
        await visit(`#/projects/${p.id}/settings?section=mobile`);
        await page.getByRole("button", { name: "Explore with AI", exact: true }).first().click();
        await pwExpect(dialog()).toBeVisible();
        await pwExpect(dialog()).toContainText(`The AI will open ${APP} on a phone or emulator, tap through it like a careful user, and plan tests.`);
        expect(fake.unhandled).toEqual([]);
    });
});

// ── start: the panel ──────────────────────────────────────────────────────────

const startHash = (id: string) => `#/projects/${id}/settings?section=mobile&start=phone`;
const post = (re: RegExp) => fake.called("POST", re);

describe("start: the panel", () => {
    it("says what will happen, what it will not do and where it runs, and starts a plan-only exploration", async () => {
        const p = fake.addProject("Shop");
        await visit(startHash(p.id));
        await pwExpect(dialog()).toBeVisible();
        await pwExpect(dialog()).toContainText(`The AI will open ${APP} on a phone or emulator, tap through it like a careful user, and plan tests. Nothing is created until you approve the plan. It never taps buttons that look like paying, deleting or sending, and passwords are hidden.`);
        expect(await dialog().getByTestId("phone-wont").locator("li").allTextContents()).toEqual(["Pay for anything or subscribe", "Delete accounts or data", "Send messages or money, or make calls", "Use a fingerprint or face check", "Get past captchas", "Explore games"]);
        const server = dialog().getByRole("radio", { name: /This server/ });
        await pwExpect(server).toBeChecked();
        await pwExpect(dialog()).toContainText("An Android emulator is ready here (Pixel_6).");
        await pwExpect(dialog().getByTestId("phone-account-note")).toHaveText("If the app needs a login, add a test account under Advanced options.");
        await pwExpect(dialog().getByRole("button", { name: "Start exploring", exact: true })).toBeEnabled();
        await shot("start-light-1280");
        await dialog().getByRole("button", { name: "Start exploring", exact: true }).click();
        await pwExpect(page).toHaveURL(new RegExp(`#/projects/${p.id}$`));
        // It stops at a plan, names the phone target and sends nothing else; the runner choice was already this server, so it is not saved again.
        const sent = post(new RegExp(`/projects/${p.id}/test-generation$`));
        expect(sent.map((r) => r.body)).toEqual([{ targets: ["mobile"], plan: true }]);
        expect(fake.called("PUT", /\/runner$/)).toEqual([]);
        await pwExpect(page.getByRole("heading", { name: "Exploring your phone app", exact: true })).toBeVisible();
    });

    it("sends a test account only when one is typed, and keeps the password hidden", async () => {
        const p = fake.addProject("Shop with login");
        await visit(startHash(p.id));
        await pwExpect(dialog()).toBeVisible();
        await dialog().locator("summary", { hasText: "Advanced options" }).click();
        await pwExpect(dialog().getByLabel("Password")).toHaveAttribute("type", "password");
        await dialog().getByLabel("Username or email").fill("tester@example.com");
        await dialog().getByLabel("Password").fill("not-a-real-password-1");
        await dialog().getByRole("button", { name: "Start exploring", exact: true }).click();
        await pwExpect(page).toHaveURL(new RegExp(`#/projects/${p.id}$`));
        expect(post(new RegExp(`/projects/${p.id}/test-generation$`)).map((r) => r.body)).toEqual([{ targets: ["mobile"], plan: true, credentials: { username: "tester@example.com", password: "not-a-real-password-1" } }]);
        // The password is in no text of the page afterwards.
        expect(await page.evaluate(() => document.body.innerText)).not.toContain("not-a-real-password-1");
    });

    it("with no phone, emulator or runner: the places are off, the reason is plain, and Start is off", async () => {
        fake.config.mobile = { available: false, reason: "There is no Android emulator on this server", avds: [], toolchain: "none" };
        const p = fake.addProject("Shop");
        await visit(startHash(p.id));
        await pwExpect(dialog()).toBeVisible();
        await pwExpect(dialog().getByRole("radio", { name: /This server/ })).toBeDisabled();
        await pwExpect(dialog()).toContainText("There is no Android emulator on this server.");
        await pwExpect(dialog()).toContainText("No phone or emulator is ready");
        await pwExpect(dialog()).toContainText("Connect a runner on a computer with an Android emulator or phone: open Runners and add that computer. For a real phone, turn on USB debugging first.");
        await pwExpect(dialog().getByRole("link", { name: "Open Runners", exact: true })).toHaveAttribute("href", `#/runners?project=${p.id}`); // round 37: runners are machine-level, on the Runners page
        await pwExpect(dialog().getByRole("button", { name: "Start exploring", exact: true })).toBeDisabled();
        await shot("start-no-device-light-1280");
    });

    it("lists runners honestly: offline and out of date are off, one with a phone works, and choosing it is saved first and said so", async () => {
        fake.config.mobile = { available: false, reason: "No Android emulator is set up here", avds: [], toolchain: "none" };
        fake.addAgent({ id: "a-off", name: "Old laptop", online: false, lastSeenAt: new Date(Date.now() - 3 * 3600_000).toISOString() });
        const stale = fake.addAgent({ id: "a-old", name: "Build box" });
        delete stale.capabilities.deviceSession;
        fake.addAgent({ id: "a-ok", name: "Maya’s laptop" });
        fake.addAgent({ id: "a-none", name: "Desk PC", capabilities: { browsers: ["chromium"], deviceSession: true, android: { adb: true, devices: [], avds: [], state: "none", summary: "Android: no devices connected" } } });
        const p = fake.addProject("Shop");
        await visit(startHash(p.id));
        await pwExpect(dialog()).toBeVisible();
        const radio = (n: string) => dialog().getByRole("radio", { name: new RegExp(n) });
        await pwExpect(radio("Old laptop")).toBeDisabled();
        await pwExpect(dialog()).toContainText("Offline, last seen 3 hours ago.");
        await pwExpect(radio("Build box")).toBeDisabled();
        await pwExpect(dialog()).toContainText("This runner is out of date and cannot explore phone apps. Update it from its page in Runners.");
        await pwExpect(radio("Desk PC")).toBeDisabled();
        await pwExpect(dialog()).toContainText("Android: no devices connected.");
        // The one that can is chosen without being asked, and says where it will run from now on.
        await pwExpect(radio("Maya’s laptop")).toBeChecked();
        await pwExpect(dialog()).toContainText("Android: 1 emulator ready.");
        await pwExpect(dialog().getByTestId("phone-runner-change")).toHaveText("Phone tests for this project will run there from now on. You can change it on the Runners page.");
        await dialog().getByRole("button", { name: "Start exploring", exact: true }).click();
        await pwExpect(page).toHaveURL(new RegExp(`#/projects/${p.id}$`));
        const order = fake.requests.filter((r) => (r.method === "PUT" && /\/runner$/.test(r.path)) || (r.method === "POST" && /test-generation$/.test(r.path))).slice(-2);
        expect(order.map((r) => `${r.method} ${r.path.split("/").pop()}`)).toEqual(["PUT runner", "POST test-generation"]);
        expect(order[0]!.body).toEqual({ runOn: "agent", agentId: "a-ok" });
    });

    it("when the AI model is not set up it says so, links to Settings and does not start", async () => {
        fake.config.llm = { provider: "anthropic", model: "unavailable", configured: false };
        const p = fake.addProject("Shop");
        await visit(startHash(p.id));
        await pwExpect(dialog()).toBeVisible();
        await pwExpect(dialog()).toContainText("The AI model isn’t set up on this server. Exploring a phone app needs it.");
        await pwExpect(dialog().getByRole("link", { name: "Open Settings", exact: true })).toHaveAttribute("href", "#/settings");
        await pwExpect(dialog().getByRole("button", { name: "Start exploring", exact: true })).toBeDisabled();
    });

    it("for an app file without a package name: asks for the name, with no way to start, and the menu opens Setup", async () => {
        const p = fake.addProject("File only", { appPackage: null, apk: "shop.apk", avd: null });
        await visit(startHash(p.id));
        await pwExpect(dialog()).toBeVisible();
        await pwExpect(dialog()).toContainText("The app’s package name is missing");
        await pwExpect(dialog()).toContainText("Phone exploration needs the app’s package name, for example com.example.shop. Add it under Settings, Mobile app.");
        expect(await dialog().getByRole("button", { name: "Start exploring", exact: true }).count()).toBe(0);
    });

    it("for an iPhone app only: Android only, import tests, no way to start", async () => {
        const p = fake.addProject("iPhone app", { appPackage: null, apk: null, avd: null, iosBundleId: "com.apple.Preferences" });
        await visit(startHash(p.id));
        await pwExpect(dialog()).toBeVisible();
        await pwExpect(dialog()).toContainText("Phone exploration works on Android only. For iPhone apps, import tests.");
        expect(await dialog().getByRole("button", { name: "Start exploring", exact: true }).count()).toBe(0);
        await pwExpect(dialog().getByRole("link", { name: "Open Mobile app", exact: true })).toBeVisible();
    });

    it("shows the platform's refusal in plain words, keeps the panel open and lets the person try again", async () => {
        const p = fake.addProject("Shop");
        await visit(startHash(p.id));
        await pwExpect(dialog()).toBeVisible();
        fake.startError = { status: 409, error: "Another job is already running for this project. Wait for it to finish or stop it first." };
        await dialog().getByRole("button", { name: "Start exploring", exact: true }).click();
        await pwExpect(dialog()).toContainText("We couldn’t start the exploration");
        await pwExpect(dialog()).toContainText("Another job is already running for this project. Wait for it to finish or stop it first.");
        await pwExpect(dialog().getByRole("button", { name: "Start exploring", exact: true })).toBeEnabled();
        fake.startError = { status: 422, error: "Phone tests need an app to test. Add one under Settings, Mobile app." };
        await dialog().getByRole("button", { name: "Start exploring", exact: true }).click();
        await pwExpect(dialog()).toContainText("Phone tests need an app to test. Add one under Settings, Mobile app.");
        await dialog().getByRole("button", { name: "Start exploring", exact: true }).click();
        await pwExpect(page).toHaveURL(new RegExp(`#/projects/${p.id}$`));
    });

    it("shows a loading state, and an error with Try again when the project cannot be read", async () => {
        const p = fake.addProject("Shop");
        fake.delayMs = 700;
        await visit(startHash(p.id));
        await pwExpect(dialog().getByLabel("Loading")).toBeVisible();
        await pwExpect(dialog().getByRole("button", { name: "Start exploring", exact: true })).toBeVisible();
        fake.delayMs = 0;
        // Now the project cannot be read until the person tries again.
        let failing = true;
        const re = new RegExp(`/api/projects/${p.id}$`);
        await page.route(re, async (route) => {
            if (failing) return route.fulfill({ status: 500, json: { error: "The database is busy" } });
            return route.continue();
        });
        try {
            await page.reload();
            await pwExpect(dialog()).toBeVisible();
            await pwExpect(dialog().getByRole("button", { name: "Try again", exact: true })).toBeVisible();
            failing = false;
            await dialog().getByRole("button", { name: "Try again", exact: true }).click();
            await pwExpect(dialog().getByRole("button", { name: "Start exploring", exact: true })).toBeVisible();
        } finally {
            await page.unroute(re);
        }
    });

    it("Settings, Mobile app has Explore with AI next to Change; Cancel and Escape close the panel", async () => {
        const p = fake.addProject("Shop");
        await visit(`#/projects/${p.id}/settings?section=mobile`);
        const row = page.getByTestId("setting-mobile");
        await pwExpect(row).toContainText(`Phone tests use ${APP}. The AI can explore it and plan tests.`);
        await pwExpect(row.getByRole("button", { name: "Explore with AI", exact: true })).toBeVisible();
        await pwExpect(row.getByRole("button", { name: "Change mobile app", exact: true })).toBeVisible();
        await row.getByRole("button", { name: "Explore with AI", exact: true }).click();
        await pwExpect(dialog()).toBeVisible();
        await dialog().getByRole("button", { name: "Cancel", exact: true }).click();
        await pwExpect(dialog()).toHaveCount(0);
        await row.getByRole("button", { name: "Explore with AI", exact: true }).click();
        await page.keyboard.press("Escape");
        await pwExpect(dialog()).toHaveCount(0);
        expect(post(/test-generation$/)).toEqual([]);
    });
});

// ── start: the welcome page ───────────────────────────────────────────────────

describe("start: the welcome page", () => {
    it("the first card offers a website or API, or an Android app; an app is saved and the panel opens", async () => {
        fake.projects.clear();
        await visit("#/");
        const card = page.getByRole("group", { name: "Ways to start", exact: true }).locator(".welcome-card").nth(0);
        await pwExpect(card.getByRole("radio", { name: "A website or API" })).toBeChecked();
        await pwExpect(card.getByLabel("Application URL")).toBeVisible();
        expect(await page.getByRole("group", { name: "Ways to start", exact: true }).getByRole("heading", { level: 2 }).allTextContents()).toEqual(["Explore my app", "Record a test", "Start from tests I have"]);
        await card.getByRole("radio", { name: "An Android app" }).check();
        // Round 37: the project's name is typed (above the cards), never made from the app's package.
        await page.getByLabel("Project name").fill("Shop app");
        await pwExpect(card.getByLabel("App package")).toBeVisible();
        expect(await card.getByLabel("Application URL").count()).toBe(0);
        await pwExpect(card.getByTestId("ai-note")).toContainText("Android only");
        await shot("welcome-android-light-1280");
        // Nothing, then something that is not a package, then a package.
        await card.getByRole("button", { name: "Explore my app", exact: true }).click();
        await pwExpect(card).toContainText("Enter the app’s package name, for example com.example.shop.");
        await card.getByLabel("App package").fill("shop");
        await card.getByRole("button", { name: "Explore my app", exact: true }).click();
        await pwExpect(card).toContainText("That doesn’t look like an app package. It has at least two parts joined by dots, for example com.example.shop.");
        await pwExpect(card.getByLabel("App package")).toHaveAttribute("aria-invalid", "true");
        expect(fake.called("POST", /^\/projects$/)).toEqual([]);
        await card.getByLabel("App package").fill(APP);
        await card.getByRole("button", { name: "Explore my app", exact: true }).click();
        await pwExpect(page).toHaveURL(/#\/projects\/[^/]+\/settings\?section=mobile&start=phone/);
        await pwExpect(dialog()).toBeVisible();
        await pwExpect(dialog()).toContainText(`The AI will open ${APP}`);
        const made = [...fake.projects.values()].at(-1)!;
        expect(made.mobile).toMatchObject({ appPackage: APP });
        expect(fake.called("PUT", /\/mobile-app$/).at(-1)!.body).toEqual({ appPackage: APP, iosBundleId: null });
        // Nothing was explored yet: the person still has to press Start exploring.
        expect(post(/test-generation$/)).toEqual([]);
    });

    it("an .apk file, with the package name, is uploaded before the app is saved", async () => {
        fake.projects.clear();
        await visit("#/");
        const card = page.getByRole("group", { name: "Ways to start", exact: true }).locator(".welcome-card").nth(0);
        await card.getByRole("radio", { name: "An Android app" }).check();
        const apk = path.join(tmp, "shop.apk");
        fs.writeFileSync(apk, "not really an app");
        await page.getByLabel("Project name").fill("Shop app");
        await card.getByLabel("App package").fill(APP);
        await page.locator("#w-apk").setInputFiles(apk);
        await pwExpect(card).toContainText("shop.apk");
        await card.getByRole("button", { name: "Explore my app", exact: true }).click();
        await pwExpect(page).toHaveURL(/section=mobile&start=phone/);
        const made = [...fake.projects.values()].at(-1)!;
        expect(made.mobile).toMatchObject({ apk: "shop.apk", appPackage: APP });
        const seq = fake.requests.map((r) => `${r.method} ${r.path.replace(/\?.*$/, "").replace(/\/projects\/[^/]+/, "/projects/:id")}`);
        expect(seq.lastIndexOf("POST /projects/:id/mobile-app/apk")).toBeLessThan(seq.lastIndexOf("PUT /projects/:id/mobile-app"));
    });

    it("without the AI model the Android choice says so and links to Settings", async () => {
        fake.projects.clear();
        fake.config.llm = { provider: "anthropic", model: "unavailable", configured: false };
        await visit("#/");
        const card = page.getByRole("group", { name: "Ways to start", exact: true }).locator(".welcome-card").nth(0);
        await card.getByRole("radio", { name: "An Android app" }).check();
        await pwExpect(card).toContainText("Exploring a phone app needs it. The other two ways to start work without it.");
        await pwExpect(card.getByRole("link", { name: "Open Settings", exact: true })).toHaveAttribute("href", "#/settings");
    });
});

// ── watch the phone ───────────────────────────────────────────────────────────

/**
 * A project whose AI is in the middle of exploring the phone app, as the platform reports it: events named mobile_* (it says when it finds a screen and when it
 * leaves something alone, not each tap), no counters yet, and a picture whose address is android-app://<package>.
 */
async function exploring(name = "Shop") {
    const p = fake.addProject(name);
    const j = fake.addJob(p.id);
    fake.log(j.jobId, `Opened ${APP} on emulator-5554`, "mobile_started");
    for (const [i, t] of ["Home", "Sign in", "Product list", "Cart"].entries()) fake.log(j.jobId, `Found screen S${i + 1} “${t}”`, "mobile_screen_found");
    fake.log(j.jobId, "Skipped “Delete account” because it looks destructive", "mobile_action_skipped");
    fake.log(j.jobId, "Skipped “Delete account” because it looks destructive", "mobile_action_skipped");
    fake.log(j.jobId, "Skipped “Pay now” because it looks like paying", "mobile_action_skipped");
    await showFrame(j.jobId, "Sign in", "Tapped “Sign in”");
    return { p, j };
}
async function watchOn(on: boolean) {
    await page.evaluate((v) => localStorage.setItem("aitp.explorer.watch", v ? "1" : "0"), on);
}
const switchBtn = () => page.getByRole("switch", { name: /^Watch live/ });
const panel = () => page.getByRole("region", { name: "Explorer view", exact: true });

describe("watch the phone", () => {
    it("the progress card speaks of the phone app, counts the screens seen, and lists what was left alone once each", async () => {
        const { p } = await exploring();
        await visit(`#/projects/${p.id}`);
        await pwExpect(page.getByRole("heading", { name: "Exploring your phone app", exact: true })).toBeVisible();
        await pwExpect(page.getByText("The AI is using the app on a phone or emulator and planning tests. Nothing is created yet. You can leave this page.")).toBeVisible();
        await pwExpect(page.getByTestId("phone-counts")).toHaveText("4 screens seen");
        await pwExpect(page.getByText("Exploring your phone app…", { exact: true })).toBeVisible();
        // The badge in the page header says it too, although the job answer does not say what the job explored.
        await pwExpect(page.getByText("Exploring your phone app", { exact: true }).first()).toBeVisible();
        const skipped = page.getByTestId("phone-skipped");
        await pwExpect(skipped.locator("li")).toHaveText(["Skipped “Delete account” because it looks destructive", "Skipped “Pay now” because it looks like paying"]);
        await pwExpect(page.getByRole("heading", { name: "What the AI left alone", exact: true })).toBeVisible();
        // Watching is off until asked for: no picture is requested.
        await pwExpect(switchBtn()).toHaveAttribute("aria-checked", "false");
        await pwExpect(page.getByText("See the phone screen the AI is using.")).toBeVisible();
        expect(fake.called("GET", /\/frame/)).toEqual([]);
    });

    it("Watch live shows a portrait phone picture with the app, the screen and what the AI just did, and follows the AI", async () => {
        const { p, j } = await exploring();
        await visit(`#/projects/${p.id}`);
        await watchOn(false);
        await switchBtn().click();
        await pwExpect(panel()).toBeVisible();
        const img = panel().getByTestId("explorer-image");
        await pwExpect(img).toBeVisible();
        await pwExpect(img).toHaveAttribute("alt", `${APP}, Sign in`);
        const box = (await img.boundingBox())!;
        expect(box.height, "the picture is portrait").toBeGreaterThan(box.width * 1.4);
        expect(box.height, "and fits on the screen").toBeLessThan(560);
        expect(await img.evaluate((el: HTMLImageElement) => el.naturalHeight > el.naturalWidth)).toBe(true);
        await pwExpect(panel().getByTestId("explorer-app")).toHaveText(APP);
        await pwExpect(panel().getByTestId("explorer-title")).toHaveText("Sign in");
        await pwExpect(panel().getByTestId("explorer-note")).toHaveText("Tapped “Sign in”");
        expect(await panel().getByText("Address", { exact: true }).count()).toBe(0);
        await pwExpect(panel().getByTestId("explorer-status")).toContainText("Exploring the app");
        await pwExpect(panel()).toContainText("This is a picture of the phone screen the AI is using, on a runner or on the platform’s computer. It refreshes about once a second while this panel is open. Passwords are hidden.");
        await shot("explorer-phone-light-1280");
        await settle("dark");
        await shot("explorer-phone-dark-1280");
        await settle(null);
        // The AI moves on: the picture follows.
        await showFrame(j.jobId, "Product list", "Opened Product list");
        await pwExpect(img).toHaveAttribute("alt", `${APP}, Product list`, { timeout: 8000 });
        await pwExpect(panel().getByTestId("explorer-note")).toHaveText("Opened Product list");
        // The skipped list is under the picture's panel, not inside it, and stays when the switch is off.
        await pwExpect(page.getByTestId("phone-skipped")).toBeVisible();
    });

    it("on a phone-width screen the picture is above the lists and nothing scrolls sideways", async () => {
        const { p } = await exploring();
        await visit(`#/projects/${p.id}`);
        await watchOn(true);
        await narrow(async () => {
            await visit(`#/projects/${p.id}`);
            await pwExpect(panel().getByTestId("explorer-image")).toBeVisible();
            await noOverflow();
            const img = (await panel().getByTestId("explorer-image").boundingBox())!;
            const list = (await page.getByTestId("phone-skipped").boundingBox())!;
            expect(img.y + img.height, "the picture is above the skipped list").toBeLessThanOrEqual(list.y);
            await shot("explorer-phone-light-375");
        });
    });

    it("Stop exploring asks first, says what is kept, stops, and the last picture stays on the page", async () => {
        const { p, j } = await exploring();
        await visit(`#/projects/${p.id}`);
        await watchOn(true);
        await page.reload();
        await pwExpect(panel().getByTestId("explorer-image")).toBeVisible();
        await panel().getByRole("button", { name: "Stop exploring", exact: true }).click();
        const ask = page.getByRole("dialog", { name: "Stop exploring?", exact: true });
        await pwExpect(ask).toBeVisible();
        await pwExpect(ask.getByTestId("stop-body")).toContainText("No plan is made and nothing is created.");
        await shot("stop-light-1280");
        await ask.getByRole("button", { name: "Keep running", exact: true }).click();
        expect(fake.called("DELETE", /test-generation/)).toEqual([]);
        await panel().getByRole("button", { name: "Stop exploring", exact: true }).click();
        await ask.getByRole("button", { name: "Stop exploring", exact: true }).click();
        await pwExpect.poll(() => fake.called("DELETE", new RegExp(`test-generation/${j.jobId}$`)).length).toBe(1);
        await pwExpect(page.getByText("Exploring was stopped", { exact: true })).toBeVisible();
        await pwExpect(page.getByText("No plan was made and nothing was created.")).toBeVisible();
        // The last picture is still there, with the words of a stopped phone exploration.
        await pwExpect(page.getByTestId("explorer-finished")).toHaveText("Exploration stopped: 4 screens seen");
        await pwExpect(page.getByTestId("explorer-image")).toBeVisible();
        // "Explore again" opens the phone start panel, not the website form.
        await pwExpect(page.getByRole("link", { name: "Explore again", exact: true }).first()).toHaveAttribute("href", `#/projects/${p.id}/settings?section=mobile&start=phone`);
    });

    it("says when the picture cannot be shown (a runner that cannot send one)", async () => {
        const { p, j } = await exploring();
        fake.frames.set(j.jobId, { available: false, why: "elsewhere", reason: "This part runs on another computer and cannot be shown." });
        await visit(`#/projects/${p.id}`);
        await watchOn(true);
        await page.reload();
        await pwExpect(panel().getByTestId("explorer-empty")).toHaveText("This part runs on another computer and cannot be shown.");
        // The progress card still counts and lists, picture or not.
        await pwExpect(page.getByTestId("phone-counts")).toHaveText("4 screens seen");
    });
});

// ── approve the plan ──────────────────────────────────────────────────────────

async function planReady(over: Record<string, unknown> = {}, jobOver: Record<string, unknown> = {}) {
    const p = fake.addProject("Shop");
    const j = fake.addJob(p.id, { status: "COMPLETED", progress: { discovery: "done", understanding: "done", planning: "done", generation: "skipped", validation: "skipped" }, counters: { pagesDiscovered: 9, scenariosPlanned: 12 }, finishedAt: new Date().toISOString(), ...jobOver });
    fake.log(j.jobId, "Skipped “Delete account” because it looks destructive", "mobile_action_skipped");
    fake.log(j.jobId, "Skipped “Place order” because it looks like paying", "mobile_action_skipped");
    fake.setPlan(j.jobId, PHONE_PLAN(j.jobId, over));
    return { p, j };
}
const planBox = () => page.getByTestId("plan-preview");

describe("approve the plan", () => {
    it("says what was found and what it will create, in phone words, with nothing created yet", async () => {
        const { p } = await planReady();
        await visit(`#/projects/${p.id}`);
        await pwExpect(planBox()).toBeVisible();
        await pwExpect(page.getByTestId("plan-found")).toHaveText("We found 9 screens, with 2 forms.");
        await pwExpect(page.getByTestId("plan-sentence")).toHaveText("We will create about 12 phone tests: signing in 2, moving between screens 5, forms 3 and lists and details 2.");
        await pwExpect(planBox()).toContainText("Nothing has been created or run yet.");
        await pwExpect(planBox().getByRole("button", { name: "Create the tests", exact: true })).toBeEnabled();
        await pwExpect(planBox().getByRole("button", { name: "Discard the plan", exact: true })).toBeVisible();
        await pwExpect(planBox().locator("summary", { hasText: "Edit the plan" })).toBeVisible();
        expect(await planBox().getByTestId("plan-login-hint").count()).toBe(0);
        await shot("plan-light-1280");
        await settle("dark");
        await shot("plan-dark-1280");
        await settle(null);
    });

    it("lists the screens found (names, and a picture only when the platform gave one) and what the AI left alone", async () => {
        const thumb = `data:image/jpeg;base64,${await phoneJpeg("Home")}`;
        const { p } = await planReady({ screens: [{ name: "Home", path: ["Home"], thumbnail: thumb }, { name: "Sign in", path: ["Home", "Sign in"] }] });
        await visit(`#/projects/${p.id}`);
        await pwExpect(planBox()).toBeVisible();
        await planBox().locator("summary", { hasText: "What we found (9 screens)" }).click();
        const list = page.getByTestId("plan-screens");
        await pwExpect(list.locator("li")).toHaveCount(2);
        await pwExpect(list.locator("li").nth(0)).toContainText("Home");
        await pwExpect(list.locator("li").nth(1)).toContainText("Sign in");
        await pwExpect(list.locator("li").nth(1)).toContainText("Reached by Home → Sign in");
        await pwExpect(list.getByRole("img", { name: "The Home screen" })).toBeVisible();
        expect(await list.getByRole("img").count()).toBe(1);
        await pwExpect(planBox()).toContainText("Showing the first 2.");
        await planBox().locator("summary", { hasText: "What the AI left alone (2)" }).click();
        await pwExpect(planBox().getByTestId("phone-skipped").locator("li")).toHaveText(["Skipped “Delete account” because it looks destructive", "Skipped “Place order” because it looks like paying"]);
    });

    it("lets the person leave out a whole kind or a single idea, shows the new total, and creates exactly that", async () => {
        const { p, j } = await planReady();
        await visit(`#/projects/${p.id}`);
        await planBox().locator("summary", { hasText: "Edit the plan" }).click();
        const edit = planBox();
        await pwExpect(edit.getByRole("checkbox", { name: /^Signing in/ })).toBeChecked();
        for (const k of ["Signing in", "Moving between screens", "Forms", "Lists and details"]) await pwExpect(edit.getByRole("checkbox", { name: new RegExp(`^${k}`) }).first()).toBeVisible();
        // One idea out of Moving between screens, with the screens it goes through shown.
        await pwExpect(edit.getByRole("list", { name: "Test ideas: Moving between screens" }).getByTestId("idea-path").first()).toContainText("Path: Home → Cart");
        await edit.getByRole("checkbox", { name: /^Go back from the cart/ }).uncheck();
        await pwExpect(page.getByTestId("plan-sentence")).toHaveText("We will create about 11 phone tests: signing in 2, moving between screens 4, forms 3 and lists and details 2.");
        // A whole kind out.
        await edit.getByRole("checkbox", { name: /^Lists and details/ }).uncheck();
        await pwExpect(page.getByTestId("plan-sentence")).toHaveText("We will create about 9 phone tests: signing in 2, moving between screens 4 and forms 3.");
        await edit.getByRole("checkbox", { name: /^Lists and details/ }).check();
        await pwExpect(page.getByTestId("plan-sentence")).toHaveText("We will create about 11 phone tests: signing in 2, moving between screens 4, forms 3 and lists and details 2.");
        await edit.getByRole("checkbox", { name: /^Search with nothing typed/ }).uncheck();
        await planBox().getByRole("button", { name: "Create the tests", exact: true }).click();
        await pwExpect.poll(() => post(new RegExp(`plans/${j.jobId}/create$`)).length).toBe(1);
        expect(post(new RegExp(`plans/${j.jobId}/create$`))[0]!.body).toEqual({ targets: ["mobile"], excludeIdeas: ["M-04", "M-09"] });
        await pwExpect(page.getByRole("heading", { name: "Creating your tests", exact: true })).toBeVisible();
    });

    it("shows the platform's notes as they are and says which ideas could not be written and why", async () => {
        const { p } = await planReady({
            warnings: ["The app has a sign-in screen and no test account was given, so screens behind it were not explored. Add one under Advanced options and explore again."],
            phone: { ...PHONE_PLAN("x").phone, couldNotWrite: [{ title: "Pay for an order", reason: "It needs a payment screen, which the AI never opens" }, { title: "Change the language", reason: "The language list has no names a test could use" }] },
        });
        await visit(`#/projects/${p.id}`);
        await pwExpect(planBox().getByText("Worth knowing", { exact: true })).toBeVisible();
        await pwExpect(planBox()).toContainText("The app has a sign-in screen and no test account was given, so screens behind it were not explored.");
        expect(await planBox().getByText("Something went wrong").count()).toBe(0);
        await planBox().locator("summary", { hasText: "Ideas left out (2)" }).click();
        await pwExpect(planBox().getByTestId("plan-dropped").locator("li")).toHaveText(["Pay for an order: It needs a payment screen, which the AI never opens.", "Change the language: The language list has no names a test could use."]);
    });

    it("discard throws the plan away and offers to explore again from the phone panel", async () => {
        const { p, j } = await planReady();
        await visit(`#/projects/${p.id}`);
        await planBox().getByRole("button", { name: "Discard the plan", exact: true }).click();
        await pwExpect(page.getByText("The plan was discarded", { exact: true })).toBeVisible();
        await pwExpect(page.getByText("Nothing was created. Explore again whenever you like.")).toBeVisible();
        expect(fake.called("DELETE", new RegExp(`plans/${j.jobId}$`))).toHaveLength(1);
        await pwExpect(page.getByRole("link", { name: "Explore again", exact: true }).last()).toHaveAttribute("href", `#/projects/${p.id}/settings?section=mobile&start=phone`);
    });

    it("tells the truth when nothing was found, when the app asked for a sign-in, and when the plan is gone", async () => {
        const a = await planReady({ found: { pages: 0, apiEndpoints: 0, forms: 0, journeys: 0, screens: 0 }, phone: { appPackage: APP, appName: "Shop", screens: [], ideas: [], couldNotWrite: [], skipped: [], signInNeeded: false, signedIn: false }, ideas: [], families: [], total: 0 });
        await visit(`#/projects/${a.p.id}`);
        await pwExpect(page.getByText("Nothing to test was found", { exact: true })).toBeVisible();
        await pwExpect(planBox()).toContainText("We could not find screens in the app. Check that it starts on the phone or emulator, then explore again.");
        await pwExpect(planBox().getByRole("button", { name: "Create the tests", exact: true })).toBeDisabled();

        // The platform says the app has a sign-in screen and no account was given (in its phone part).
        const b = await planReady({ signInDetails: false, phone: { ...PHONE_PLAN("x").phone, signInNeeded: true, signedIn: false } });
        await visit(`#/projects/${b.p.id}`);
        await pwExpect(page.getByTestId("plan-login-hint")).toHaveText("The app asks for a sign-in. Screens behind it are not part of this plan. Add a test account under Advanced options when you explore again.");

        const c = await planReady();
        fake.planError = { status: 410, error: "The plan was kept for a day and is gone." };
        await visit(`#/projects/${c.p.id}`);
        await pwExpect(page.getByText("This plan is no longer available", { exact: true })).toBeVisible();
        await pwExpect(page.getByRole("link", { name: "Explore again", exact: true }).last()).toHaveAttribute("href", `#/projects/${c.p.id}/settings?section=mobile&start=phone`);
    });
});

// ── after creation: the tests appear, run, and are listed ──────────────────────

describe("the tests", () => {
    it("appear as they are created and run, then sit in the Tests list as phone tests of the app; a failing one says why", async () => {
        const { p, j } = await planReady();
        // The person approves: the platform starts creation as a new job that is working.
        const c = fake.addJob(p.id, { planOnly: false, fromPlan: j.jobId, status: "GENERATING", progress: { discovery: "done", understanding: "done", planning: "done", generation: "running", validation: "pending" }, counters: { pagesDiscovered: 9, scenariosPlanned: 3, testsGenerated: 2 } });
        fake.runTests.set(c.jobId, [
            { id: "t-a", testId: "MOB-001", title: "Sign in with a test account", suite: "Phone", state: "passed", durationMs: 4200 },
            { id: "t-b", testId: "MOB-002", title: "Open the cart from Home", suite: "Phone", state: "running" },
            { id: "t-c", testId: "MOB-003", title: "Search with a word", suite: "Phone", state: "waiting" },
        ]);
        await visit(`#/projects/${p.id}`);
        await pwExpect(page.getByRole("heading", { name: "Creating your tests", exact: true })).toBeVisible();
        const live = page.getByTestId("created-tests");
        await pwExpect(live.getByTestId("created-count")).toHaveText("3 tests created, 1 run so far.");
        await pwExpect(live.getByRole("list", { name: "Tests in this run" }).locator("li")).toHaveCount(3);
        await pwExpect(live).toContainText("Passing");
        await shot("created-live-light-1280");
        // It finishes: one passes, one fails with the platform's reason.
        const a = fake.addTest(p.id, { id: "t-a", testId: "MOB-001", title: "Sign in with a test account" });
        const b = fake.addTest(p.id, { id: "t-b", testId: "MOB-002", title: "Open the cart from Home", validationStatus: "FAILED_VALIDATION", validationReason: "Expected the Cart screen to be visible, but it was not found within 10 s." });
        fake.runTests.set(c.jobId, [
            { id: a.id, testId: a.testId, title: a.title, suite: "Phone", state: "passed", durationMs: 4200 },
            { id: b.id, testId: b.testId, title: b.title, suite: "Phone", state: "failed", reason: b.validationReason, durationMs: 11000 },
        ]);
        fake.update(c.jobId, { status: "PARTIALLY_COMPLETED", finishedAt: new Date().toISOString(), progress: { generation: "done", validation: "done" }, counters: { testsGenerated: 2, testsValidated: 1, testsFailedValidation: 1 } });
        await pwExpect(page.getByRole("heading", { name: "Needs your attention", exact: true })).toBeVisible({ timeout: 15_000 });
        await pwExpect(page.getByRole("link", { name: /Open the cart from Home/ }).first()).toContainText("Expected the Cart screen to be visible");
        await visit(`#/projects/${p.id}/scripts`);
        await pwExpect(page.getByRole("link", { name: /Sign in with a test account/ })).toBeVisible();
        // Phone tests are called Phone, with the app they belong to.
        const row = page.getByTestId("script-row").filter({ hasText: /Sign in with a test account/ });
        await pwExpect(row).toContainText(`Phone, ${APP}`);
        expect(await row.textContent()).not.toMatch(/Mobile/);
        await shot("tests-phone-light-1280");
        expect(fake.unhandled).toEqual([]);
    });
});

// ── the bar: keyboard, phone width, targets, contrast, words ───────────────────

const RETIRED = /(?<!could not be )\bvalidated\b|\bvalidation failed\b|\bneeds review\b|\bnot yet validated\b|\bre-validation\b|\banaly[sz](is|e|ed)\b|\bhand-written\b|\btake over\b|\brunner agents?\b|\brunbooks?\b|\bmake shared\b|\bshared locators?\b|\bscenarios?\b|\bspecification\b|\bmobile tests?\b|!/i;

describe("the bar", () => {
    it("the whole path is on the keyboard: open the panel from Settings, Mobile app, pick where, start; Escape gives the focus back", async () => {
        const p = fake.addProject("Shop");
        await visit(`#/projects/${p.id}/settings?section=mobile`);
        const menu = page.getByRole("button", { name: "Explore with AI", exact: true }).first();
        await menu.focus();
        await page.keyboard.press("Enter");
        await pwExpect(dialog()).toBeVisible();
        // Everything in the panel is reachable by Tab, in reading order, and the focus can be seen.
        const order: string[] = [];
        for (let i = 0; i < 12; i++) {
            const name = await page.evaluate(() => {
                const el = document.activeElement as HTMLElement | null;
                return el && el.closest("dialog") ? (el.getAttribute("aria-label") || el.textContent?.trim() || el.id || el.tagName) : "";
            });
            if (name) order.push(name.slice(0, 40));
            await page.keyboard.press("Tab");
        }
        expect(order.join("|")).toMatch(/Advanced options/);
        expect(order.join("|")).toMatch(/Cancel/);
        expect(order.join("|")).toMatch(/Start exploring/);
        const start = dialog().getByRole("button", { name: "Start exploring", exact: true });
        await start.focus();
        expect(await start.evaluate((el) => getComputedStyle(el).outlineStyle + "|" + getComputedStyle(el).boxShadow)).not.toBe("none|none");
        await page.keyboard.press("Escape");
        await pwExpect(dialog()).toHaveCount(0);
        await pwExpect(menu).toBeFocused();
        // And Enter on Start exploring starts it.
        await menu.focus();
        await page.keyboard.press("Enter");
        await dialog().getByRole("button", { name: "Start exploring", exact: true }).focus();
        await page.keyboard.press("Enter");
        await pwExpect(page).toHaveURL(new RegExp(`#/projects/${p.id}$`));
        expect(post(new RegExp(`/projects/${p.id}/test-generation$`))).toHaveLength(1);
    });

    it("every control is at least 44 px tall: the places, the buttons, the welcome choice, the switch and Stop", async () => {
        const p = fake.addProject("Shop");
        fake.addAgent({ id: "a1", name: "Maya’s laptop" });
        await visit(startHash(p.id));
        await pwExpect(dialog()).toBeVisible();
        for (const r of await dialog().locator(".ph-where label.check").all()) await tallEnough(r, "a place row");
        await tallEnough(dialog().getByRole("button", { name: "Start exploring", exact: true }), "Start exploring");
        await tallEnough(dialog().getByRole("button", { name: "Cancel", exact: true }), "Cancel");
        await tallEnough(dialog().locator("summary", { hasText: "Advanced options" }), "Advanced options");
        fake.projects.clear();
        await visit("#/");
        const card = page.getByRole("group", { name: "Ways to start", exact: true }).locator(".welcome-card").nth(0);
        for (const r of await card.locator("label.check").all()) await tallEnough(r, "a welcome choice");
        await card.getByRole("radio", { name: "An Android app" }).check();
        await tallEnough(card.getByLabel("App package"), "App package");
        await tallEnough(card.getByRole("button", { name: "Explore my app", exact: true }), "Explore my app");
        const { p: q } = await exploring("Another");
        await visit(`#/projects/${q.id}`);
        await watchOn(true);
        await page.reload();
        await tallEnough(switchBtn(), "Watch live");
        await tallEnough(panel().getByRole("button", { name: "Stop exploring", exact: true }), "Stop exploring");
    });

    it("axe finds nothing in light or dark: the panel, the welcome choice, the watching page, the plan, the tests", async () => {
        const p = fake.addProject("Shop");
        fake.addAgent({ id: "a1", name: "Maya’s laptop" });
        await axeBoth(async () => {
            await visit(startHash(p.id));
            await pwExpect(dialog().getByRole("button", { name: "Start exploring", exact: true })).toBeVisible();
        });
        fake.config.mobile = { available: false, reason: "No emulator here", avds: [], toolchain: "none" };
        fake.agents.length = 0;
        await axeBoth(async () => {
            await visit(startHash(p.id));
            await pwExpect(dialog().getByText("No phone or emulator is ready")).toBeVisible();
        });
        fake.config = DEFAULT_CONFIG();
        fake.projects.clear();
        await axeBoth(async () => {
            await visit("#/");
            await page.getByRole("radio", { name: "An Android app" }).check();
            await page.getByLabel("App package").fill("shop");
            await page.getByRole("button", { name: "Explore my app", exact: true }).click();
            await pwExpect(page.getByText("That doesn’t look like an app package.")).toBeVisible();
        });
        const { p: w } = await exploring("Watched");
        await axeBoth(async () => {
            await visit(`#/projects/${w.id}`);
            await watchOn(true);
            await page.reload();
            await pwExpect(panel().getByTestId("explorer-image")).toBeVisible();
            await pwExpect(page.getByTestId("phone-skipped")).toBeVisible();
        });
        const { p: q } = await planReady({ signInDetails: false, phone: { ...PHONE_PLAN("x").phone, signInNeeded: true, signedIn: false } });
        await axeBoth(async () => {
            await visit(`#/projects/${q.id}`);
            await planBox().locator("summary", { hasText: "Edit the plan" }).click();
            await planBox().locator("summary", { hasText: "What we found" }).click();
            await planBox().locator("summary", { hasText: "What the AI left alone" }).click();
            await pwExpect(planBox().getByTestId("plan-screens")).toBeVisible();
        });
        const t = fake.addProject("Tests");
        fake.addTest(t.id, { title: "Sign in with a test account" });
        fake.addTest(t.id, { title: "Open the cart", validationStatus: "FAILED_VALIDATION", validationReason: "Expected the Cart screen to be visible." });
        await axeBoth(async () => {
            await visit(`#/projects/${t.id}/scripts`);
            await pwExpect(page.getByRole("link", { name: /Sign in with a test account/ })).toBeVisible();
        });
    });

    it("at 375 px nothing scrolls sideways: the panel, the welcome choice, the plan, the tests", async () => {
        const p = fake.addProject("Shop");
        fake.addAgent({ id: "a1", name: "Maya’s laptop with a very long name that goes on" });
        await narrow(async () => {
            await visit(startHash(p.id));
            await pwExpect(dialog()).toBeVisible();
            await noOverflow();
            await shot("start-light-375");
            await settle("dark");
            await shot("start-dark-375");
            await settle(null);
            fake.projects.clear();
            await visit("#/");
            await page.getByRole("radio", { name: "An Android app" }).check();
            await pwExpect(page.getByLabel("App package")).toBeVisible();
            await noOverflow();
            await shot("welcome-android-light-375");
            const { p: q } = await planReady();
            await visit(`#/projects/${q.id}`);
            await planBox().locator("summary", { hasText: "Edit the plan" }).click();
            await planBox().locator("summary", { hasText: "What we found" }).click();
            await pwExpect(planBox().getByTestId("plan-screens")).toBeVisible();
            await noOverflow();
            await shot("plan-light-375");
            await settle("dark");
            await shot("plan-dark-375");
            await settle(null);
            const t = fake.addProject("Tests");
            fake.addTest(t.id, { title: "Sign in with a test account that has a rather long title to see it wrap" });
            await visit(`#/projects/${t.id}/scripts`);
            await pwExpect(page.getByRole("link", { name: /Sign in with a test account/ })).toBeVisible();
            await noOverflow();
        });
    });

    it("no retired word and no exclamation mark on any of the new screens", async () => {
        const hits: string[] = [];
        const look = async (what: string, scope: string) => {
            const text = await page.evaluate((s) => {
                const root = document.querySelector(s)?.cloneNode(true) as HTMLElement | undefined;
                root?.querySelectorAll("pre, code, script, style").forEach((e) => e.remove());
                return root?.textContent ?? "";
            }, scope);
            const m = RETIRED.exec(text);
            if (m) hits.push(`${what}: …${text.slice(Math.max(0, m.index - 40), m.index + 40)}…`);
            expect(text.length, `${what} has text`).toBeGreaterThan(20);
        };
        const p = fake.addProject("Shop");
        fake.addAgent({ id: "a1", name: "Maya’s laptop" });
        await visit(startHash(p.id));
        await pwExpect(dialog()).toBeVisible();
        await look("start panel", "dialog[open]");
        fake.config.mobile = { available: false, reason: "No emulator here", avds: [], toolchain: "none" };
        fake.agents.length = 0;
        await visit(startHash(p.id));
        await pwExpect(dialog().getByText("No phone or emulator is ready")).toBeVisible();
        await look("start panel, no device", "dialog[open]");
        fake.config = DEFAULT_CONFIG();
        fake.projects.clear();
        await visit("#/");
        await page.getByRole("radio", { name: "An Android app" }).check();
        await look("welcome, Android", ".content");
        const { p: w } = await exploring("Words");
        await visit(`#/projects/${w.id}`);
        await watchOn(true);
        await page.reload();
        await pwExpect(panel().getByTestId("explorer-image")).toBeVisible();
        await look("watching", ".content");
        const { p: q } = await planReady();
        await visit(`#/projects/${q.id}`);
        await planBox().locator("summary", { hasText: "Edit the plan" }).click();
        await look("plan", ".content");
        const t = fake.addProject("Tests");
        fake.addTest(t.id, { title: "Sign in with a test account" });
        await visit(`#/projects/${t.id}/settings?section=mobile`);
        await pwExpect(page.getByTestId("setting-mobile")).toContainText("The AI can explore it");
        await look("Settings, Mobile app", ".content");
        expect(hits).toEqual([]);
    });

    it("screenshots at 390 px, light and dark, of the panel, the phone Explorer view and the plan (viewed by hand)", async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        try {
            const p = fake.addProject("Shop");
            const { p: w } = await exploring("Shots");
            const { p: q } = await planReady();
            for (const scheme of ["light", "dark"] as const) {
                await settle(scheme);
                await visit(startHash(p.id));
                await pwExpect(dialog()).toBeVisible();
                await page.waitForTimeout(300);
                await shot(`start-${scheme}-390`);
                await visit(`#/projects/${w.id}`);
                await watchOn(true);
                await page.reload();
                await pwExpect(panel().getByTestId("explorer-image")).toBeVisible();
                await panel().scrollIntoViewIfNeeded();
                await shot(`explorer-phone-${scheme}-390`);
                await visit(`#/projects/${q.id}`);
                await planBox().locator("summary", { hasText: "Edit the plan" }).click();
                await page.waitForTimeout(300);
                await shot(`plan-edit-${scheme}-390`);
            }
        } finally {
            await settle(null);
            await page.setViewportSize({ width: 1280, height: 900 });
        }
    });

    it("the browser reported no errors, and the fake API was asked for nothing it did not know", async () => {
        expect(consoleErrors).toEqual([]);
        expect(fake.unhandled).toEqual([]);
    });
});
