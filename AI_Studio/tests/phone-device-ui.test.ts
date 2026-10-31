/**
 * Round 24, DEVICE: the phone screens in a real browser against a fake API (tests/fixtures/phone-fake-api.ts with this file's routes; the real
 * routes are exercised by tests/phone-device-api.test.ts): "Is this phone ready?" with a OnePlus that needs a look, turning animations off and back,
 * the maker's tips, the phone test settings (where, how thorough, already signed in, the clean-start conflict), the sign-in pause on a running
 * exploration (Continue), the counters and the stop reason, and the plan's coverage line. Keyboard, 44 px targets, 375 px without sideways scroll,
 * axe in light and dark.
 * Needs web/dist. Run under the lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/phone-device-ui.test.ts
 */
import fs from "node:fs";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.js";
import { startPhoneFake, type PhoneFake } from "./fixtures/phone-fake-api.js";

const PORT = 7431;
const APP = "com.linkedin.android";
const SHOTS = path.join(REPO_ROOT, ".scratch", "phone-device", "shots");

let fake: PhoneFake;
let browser: Browser;
let page: Page;
const consoleErrors: string[] = [];

type Json = Record<string, any>;
const ONEPLUS = (animationsOff = false): Json => ({
    serial: "R58N20ABCDE",
    emulator: false,
    model: "CPH2467",
    manufacturer: "OnePlus",
    maker: "oneplus",
    androidVersion: "15",
    sdk: 35,
    state: animationsOff ? "ready" : "attention",
    summary: animationsOff ? "CPH2467 is ready for tests" : "CPH2467: animations are on",
    checks: [
        { id: "authorized", status: "ok", title: "USB debugging is allowed for this computer" },
        { id: "android", status: "ok", title: "Android 15 (API 35)" },
        animationsOff
            ? { id: "animations", status: "ok", title: "Animations are off, so tests do not wait for them", action: "animations-restore" }
            : { id: "animations", status: "attention", title: "Animations are on", detail: "Moving screens make tests slower and less steady.", steps: ["Open Developer options and set the three animation scales to Animation off, or choose Turn animations off for tests here."], action: "animations-off" },
        { id: "app", status: "ok", title: `${APP} is installed for the phone’s main user` },
        { id: "users", status: "info", title: "This phone has another user: MultiApp (user 999)", detail: "Tests and the AI use the phone’s current user only." },
    ],
    tips: [{ title: "Turn on Disable permission monitoring", why: "OnePlus phones refuse setting changes until this is on.", steps: ["Open Developer options.", "Turn on Disable permission monitoring."] }],
});

let animationsOff = false;
let settings: Json;
const depths = [
    { id: "quick", label: "Quick", screens: 40, actions: 150, minutes: 10, ideas: 15, line: "About 40 screens, 150 actions or 10 minutes. Good for a first look." },
    { id: "standard", label: "Standard", screens: 150, actions: 600, minutes: 30, ideas: 40, line: "About 150 screens, 600 actions or 30 minutes. Covers the main parts of most apps." },
    { id: "thorough", label: "Thorough", screens: 300, actions: 1200, minutes: 60, ideas: 80, line: "About 300 screens, 1,200 actions or 60 minutes. For large apps; uses more AI." },
];
const freshSettings = (over: Json = {}): Json => ({
    hasApp: true,
    appPackage: APP,
    runsOn: null,
    effective: { kind: "explored" },
    sentence: "Phone tests run on the phone the AI explored on, CPH2467 (R58N20ABCDE).",
    exploredOn: { serial: "R58N20ABCDE", model: "CPH2467", emulator: false },
    depth: "standard",
    depths,
    keepSignedIn: false,
    cleanStart: false,
    farm: { connections: [], chosen: null },
    ...over,
});

async function visit(hash: string) {
    await page.goto("about:blank");
    await page.goto(`${fake.base}/${hash}`);
}
async function settle(scheme: "light" | "dark" | null) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(400);
}
async function axeBoth(scope: string) {
    for (const scheme of ["light", "dark"] as const) {
        await settle(scheme);
        const r = await new AxeBuilder({ page }).include(scope).analyze();
        expect(r.violations.map((v) => `${scheme} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    await settle(null);
}
async function noOverflow() {
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
}
async function tall(loc: ReturnType<Page["locator"]>, what: string) {
    const box = await loc.boundingBox();
    expect(box?.height ?? 0, `${what} is at least 44 px tall`).toBeGreaterThanOrEqual(43.5);
}
async function shot(name: string) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    fake = await startPhoneFake(PORT);
    fake.extraRoutes = (method, p, body) => {
        let m: RegExpMatchArray | null;
        if ((m = p.match(/^\/projects\/[^/]+\/phones$/)) && method === "GET") return { body: { available: true, phones: [ONEPLUS(animationsOff)] } };
        if ((m = p.match(/^\/projects\/[^/]+\/phones\/R58N20ABCDE\/animations$/)) && method === "POST") {
            animationsOff = body?.off === true;
            return { body: { phone: ONEPLUS(animationsOff) } };
        }
        if ((m = p.match(/^\/projects\/[^/]+\/phone-settings$/))) {
            if (method === "GET") return { body: settings };
            if (method === "PUT") {
                if (body?.depth) settings.depth = body.depth;
                if (body?.runsOn) settings.runsOn = body.runsOn;
                if (body?.keepSignedIn !== undefined) settings.keepSignedIn = body.keepSignedIn === true;
                return { body: settings };
            }
        }
        if ((m = p.match(/^\/projects\/[^/]+\/jobs\/([^/]+)\/phone-sign-in$/)) && method === "POST") {
            const evs = fake.events.get(m[1]!) ?? [];
            const waiting = [...evs].reverse().find((e) => e.kind === "mobile_sign_in_waiting");
            evs.push({ id: 900 + evs.length, stage: "discovery", kind: "mobile_sign_in_answer", level: "info", message: "A person chose Continue.", createdAt: new Date().toISOString(), data: { requestId: waiting?.data?.requestId, choice: body?.choice } });
            return { body: { answered: body?.choice } };
        }
        return undefined;
    };
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on("console", (msg) => {
        if (msg.type() === "error" && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text());
    });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    await fake?.stop();
});

describe("Settings, Mobile app: is this phone ready, and the phone test settings", () => {
    it("shows the phone, what needs doing, turns animations off and back, and the maker's tips", async () => {
        animationsOff = false;
        settings = freshSettings();
        const p = fake.addProject("LinkedIn", { appPackage: APP, apk: null, avd: null, appActivity: ".authenticator.LaunchActivity" });
        await visit(`#/projects/${p.id}/settings?section=mobile`);
        const card = page.getByTestId("phone-card");
        await pwExpect(card).toBeVisible();
        await pwExpect(card.getByRole("heading", { name: "CPH2467 (R58N20ABCDE)", exact: true })).toBeVisible();
        await pwExpect(card).toContainText("OnePlus, Android 15");
        await pwExpect(card.getByTestId("phone-summary")).toHaveText("CPH2467: animations are on.");
        const turnOff = card.getByRole("button", { name: "Turn animations off for tests", exact: true });
        await tall(turnOff, "Turn animations off for tests");
        await shot("ready-light-1280");
        await turnOff.click();
        await pwExpect(card.getByText("Animations are off on this phone. Restore animations puts them back.")).toBeVisible();
        await pwExpect(card.getByTestId("phone-summary")).toHaveText("CPH2467 is ready for tests.");
        expect(fake.requests.filter((r) => r.path.endsWith("/animations")).map((r) => r.body)).toEqual([{ off: true }]);
        // Everything that was checked, with the undo.
        await card.locator("summary", { hasText: "Everything that was checked (5)" }).click();
        await card.getByRole("button", { name: "Restore animations", exact: true }).click();
        expect(fake.requests.filter((r) => r.path.endsWith("/animations")).map((r) => r.body)).toEqual([{ off: true }, { off: false }]);
        await pwExpect(card.getByRole("button", { name: "Turn animations off for tests", exact: true }).first()).toBeVisible();
        // The maker's settings, with the exact menus.
        await card.locator("summary", { hasText: "Settings OnePlus phones need (1)" }).click();
        await pwExpect(card.getByTestId("phone-tips")).toContainText("Turn on Disable permission monitoring");
        await axeBoth('[data-testid="phone-device-section"]');
        // The screen that opens the app, as the last run resolved it (read-only).
        await page.getByRole("button", { name: "Change mobile app", exact: true }).click();
        await pwExpect(page.getByTestId("app-activity")).toHaveText("Opens with .authenticator.LaunchActivity, as the phone said on the last run. Each run checks it again on its own phone.");
    });

    it("saves where phone tests run, how thorough and already signed in, sending only what changed", async () => {
        animationsOff = false;
        settings = freshSettings();
        const p = fake.addProject("LinkedIn 2", { appPackage: APP, apk: null, avd: null });
        await visit(`#/projects/${p.id}/settings?section=mobile`);
        const box = page.getByTestId("phone-settings");
        await pwExpect(box.getByTestId("phone-where-sentence")).toHaveText("Phone tests run on the phone the AI explored on, CPH2467 (R58N20ABCDE).");
        const save = box.getByRole("button", { name: "Save phone settings", exact: true });
        await pwExpect(save).toBeDisabled();
        // Keyboard: the radios of a group move with the arrow keys.
        await box.getByRole("radio", { name: /^Standard/ }).focus();
        await page.keyboard.press("ArrowUp");
        await pwExpect(box.getByRole("radio", { name: /^Quick/ })).toBeChecked();
        await box.getByRole("radio", { name: /^CPH2467 \(R58N20ABCDE\)/ }).check();
        await box.getByRole("checkbox", { name: /^Already signed in on this phone/ }).check();
        await tall(save, "Save phone settings");
        await save.click();
        await pwExpect(box.getByText("Saved. The next exploration and run use these settings.")).toBeVisible();
        expect(fake.requests.filter((r) => r.method === "PUT" && r.path.endsWith("/phone-settings")).map((r) => r.body)).toEqual([{ runsOn: { kind: "phone", serial: "R58N20ABCDE", model: "CPH2467" }, depth: "quick", keepSignedIn: true }]);
        await pwExpect(box.getByRole("radio", { name: /^A device farm/ })).toBeDisabled();
        await axeBoth('[data-testid="phone-settings"]');
    });

    it("says that Already signed in cannot go with a clean start, and keeps Save off", async () => {
        settings = freshSettings({ cleanStart: true });
        const p = fake.addProject("Clean", { appPackage: APP, apk: null, avd: null, cleanStart: true });
        await visit(`#/projects/${p.id}/settings?section=mobile`);
        const box = page.getByTestId("phone-settings");
        await box.getByRole("checkbox", { name: /^Already signed in on this phone/ }).check();
        await pwExpect(box.getByRole("alert")).toHaveText(/Turn off “Start every test from a fresh install of the app’s data”/);
        await pwExpect(box.getByRole("button", { name: "Save phone settings", exact: true })).toBeDisabled();
    });

    it("fits a 375 px phone screen without sideways scroll", async () => {
        settings = freshSettings();
        const p = fake.addProject("Narrow", { appPackage: APP, apk: null, avd: null });
        await page.setViewportSize({ width: 375, height: 800 });
        try {
            await visit(`#/projects/${p.id}/settings?section=mobile`);
            await pwExpect(page.getByTestId("phone-card")).toBeVisible();
            await pwExpect(page.getByTestId("phone-settings")).toBeVisible();
            await noOverflow();
            await shot("ready-375");
            await settle("dark");
            await shot("ready-375-dark");
            await settle(null);
        } finally {
            await page.setViewportSize({ width: 1280, height: 900 });
        }
    });
});

describe("a running phone exploration", () => {
    it("pauses for a one-time code: says what to do and how long, Continue answers it; the counters come from the explorer", async () => {
        const p = fake.addProject("Exploring", { appPackage: APP, apk: null, avd: null });
        const j = fake.addJob(p.id, { targets: ["mobile"] });
        const at = new Date().toISOString();
        fake.events.get(j.jobId)!.push(
            { id: 1, stage: "discovery", kind: "mobile_progress", level: "info", message: "12 screens, 4 activities, 40 actions, 3 AI calls", createdAt: at, data: { screens: 12, activities: 4, actions: 40, aiCalls: 3 } },
            { id: 2, stage: "discovery", kind: "mobile_sign_in_waiting", level: "warn", message: "The app asks for a one-time code. Enter the code on the phone, then choose Continue.", createdAt: at, data: { requestId: "r1", kind: "code", deadline: new Date(Date.now() + 4 * 60_000 + 30_000).toISOString(), screen: "Verify" } },
        );
        await visit(`#/projects/${p.id}`);
        const pause = page.getByTestId("signin-pause");
        await pwExpect(pause).toBeVisible();
        await pwExpect(pause).toContainText("The app asks for a one-time code");
        await pwExpect(pause).toContainText("Enter the code on the phone, then choose Continue.");
        await pwExpect(pause).toContainText(/On “Verify”\. The exploration waits, 4 min \d\d s left/);
        await pwExpect(page.getByTestId("phone-counts")).toHaveText("12 screens seen, 4 activities, 40 actions, 3 AI calls");
        const go = pause.getByRole("button", { name: "Continue", exact: true });
        await tall(go, "Continue");
        await axeBoth('[data-testid="signin-pause"]');
        await shot("pause-1280");
        await go.click();
        await pwExpect(pause).toHaveCount(0);
        expect(fake.requests.filter((r) => r.path.endsWith("/phone-sign-in")).map((r) => r.body)).toEqual([{ choice: "continue" }]);
    });

    it("says why the exploration stopped, and the plan says how much it explored", async () => {
        const p = fake.addProject("Explored", { appPackage: APP, apk: null, avd: null });
        const j = fake.addJob(p.id, { targets: ["mobile"], status: "DISCOVERING" });
        fake.events.get(j.jobId)!.push({ id: 1, stage: "discovery", kind: "mobile_exploration_done", level: "info", message: "Exploration ended", createdAt: new Date().toISOString(), data: { screens: 142, activitiesSeen: Array.from({ length: 31 }, (_, i) => `A${i}`), activitiesListed: 40, actions: 588, aiCalls: 9, stoppedBecause: "No new screens after 80 actions: the app looks fully explored" } });
        await visit(`#/projects/${p.id}`);
        await pwExpect(page.getByTestId("phone-counts")).toHaveText("142 screens seen, 31 activities of 40, 588 actions, 9 AI calls");
        await pwExpect(page.getByTestId("phone-stop-reason")).toHaveText("Stopped because no new screens after 80 actions: the app looks fully explored.");

        const done = fake.addJob(p.id, { targets: ["mobile"], status: "COMPLETED", progress: { discovery: "done", understanding: "done", planning: "done", generation: "skipped", validation: "skipped" }, finishedAt: new Date().toISOString() });
        fake.setPlan(done.jobId, {
            ready: true, jobId: done.jobId, status: "COMPLETED", createdAt: new Date().toISOString(), url: `android-app://${APP}`, targets: ["mobile"],
            found: { pages: 0, apiEndpoints: 0, forms: 1, journeys: 0, screens: 142 }, about: null, pages: [], ideas: [{ id: "M-01", title: "Open the Jobs tab", journey: "Moving between screens", priority: "high", type: "functional" }],
            phone: { appPackage: APP, appName: "LinkedIn", screens: [{ id: "S1", title: "Home", kind: "start" }], ideas: [{ id: "M-01", title: "Open the Jobs tab", goal: "The Jobs tab opens.", family: "navigation", priority: "high", path: ["Home", "Jobs"] }], couldNotWrite: [], skipped: [], signInNeeded: false, signedIn: true, coverage: { screens: 142, activitiesSeen: Array.from({ length: 31 }, (_, i) => `A${i}`), activitiesListed: 40, actions: 588, aiCalls: 9, stoppedBecause: "No new screens after 80 actions: the app looks fully explored" } },
            families: [{ id: "phoneNavigation", label: "Moving between screens", about: "x", count: 1, on: true, option: "mobile", needs: "mobile" }], total: 1, warnings: [], signInDetails: true, used: null,
        });
        await visit(`#/projects/${p.id}`);
        await pwExpect(page.getByTestId("plan-coverage")).toHaveText("Explored 142 screens across 31 activities (the phone lists 40 for the app); stopped because no new screens after 80 actions: the app looks fully explored.");
        expect(consoleErrors).toEqual([]);
    });
});
