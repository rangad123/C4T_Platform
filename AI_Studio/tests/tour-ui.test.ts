/**
 * The guided tour in a real browser, over a real platform (seeded through the repo and the API; the page talks to it over HTTP).
 * One project has everything the tour can show (tests, a failing one, a run, a release, a phone app, security assessment with an
 * authorized application and a finished assessment); a second has only tests, so the chapters it leaves out can be seen.
 *
 * What is checked: every step's element is there on its page (none is passed over in the full project), the tour only opens pages
 * (no request other than GET while it runs, and nothing is clicked for the person), the chapter list, Skip chapter, the chapter
 * menu in the card, starting at a chapter from the Guide, continuing where the person stopped, the keyboard (arrows, Escape, focus
 * on the card), a step whose element went missing, a 375 px phone (card above or below the element, never off screen, no sideways
 * scroll), and axe in light and dark.
 * Ports: 7250 platform + UI.
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/tour-ui.test.ts
 */
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
import { ROUTE_ROLES } from "../src/platform/auth/roles.js";
import { securityStoreFor } from "../src/security/store.js";
import { CHAPTERS, chaptersOf, stepsFor, type TourHave, type TourStep } from "../web/src/features/guide/tour-steps.js";
import { addTest, seedProject, seedRun, type Seed } from "./fixtures/dashboard-seed.js";

const PORT = 7250;
const BASE = `http://127.0.0.1:${PORT}`;

let dataDir = "";
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let full: Seed;
let plain: Seed;
/** What the tour should find in each project (the same rules the tour uses, fed with what was seeded). */
let fullHave: TourHave;
let plainHave: TourHave;
const consoleErrors: string[] = [];

const api = async (method: string, url: string, payload?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { "content-type": "application/json" }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    return { status: res.status, body: await res.json().catch(() => null) };
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-tour-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });

    // Everything the tour can show.
    full = seedProject(platform, "Atlas shop", "http://127.0.0.1:7259");
    for (const k of ["alpha", "beta", "gamma"]) addTest(platform, full, k);
    const job = await seedRun(platform, full, { alpha: "pass", beta: "pass", gamma: "fail" }, { daysAgo: 1 });
    const release = (await api("POST", `/api/projects/${full.projectId}/releases`, { name: "Release 1.0" })).body.id as string;
    expect((await api("PUT", `/api/projects/${full.projectId}/mobile-app`, { appPackage: "com.example.atlas", iosBundleId: null })).status).toBeLessThan(300);
    const store = securityStoreFor(platform.db);
    store.setTestingType(full.projectId, "both");
    const app = store.createApplication(full.projectId, { name: "Atlas web", targetUrl: "https://atlas.example.test/", environment: "staging" });
    const auth = store.addAuthorization(app.id, { basis: "owner", approverName: "Olga", statement: "I confirm.", confirmedByName: "Olga" }).id;
    const a = store.createAssessment({ applicationId: app.id, authorizationId: auth, startedBy: "Eve" });
    store.updateAssessment(a.id, { state: "COMPLETED", finishedAt: new Date().toISOString(), error: null });
    fullHave = { project: full.projectId, test: full.tests.get("alpha"), failing: full.tests.get("gamma"), job: job.id, release, phone: true, module: true, security: true };

    // Tests only.
    plain = seedProject(platform, "Plain shop", "http://127.0.0.1:7258");
    for (const k of ["one", "two"]) addTest(platform, plain, k);
    plainHave = { project: plain.projectId, test: plain.tests.get("one"), module: true };

    browser = await chromium.launch();
}, 180_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

// ── harness ─────────────────────────────────────────────────────────────────

async function freshPage(opts: { viewport?: { width: number; height: number } } = {}): Promise<{ ctx: BrowserContext; p: Page }> {
    const ctx = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    p.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    p.on("pageerror", (e) => consoleErrors.push(String(e)));
    return { ctx, p };
}
const card = (p: Page) => p.getByRole("region", { name: "Guided tour", exact: true });
const btn = (p: Page, name: string) => card(p).getByRole("button", { name, exact: true });
const hash = (p: Page) => p.evaluate(() => location.hash);
const count = async (p: Page) => (await card(p).locator(".tour-count").innerText()).replace(/\s+/g, " ").trim();
const stored = (p: Page, key: string) => p.evaluate((k) => localStorage.getItem(k), key);

/** Open a page of the app and start the tour from the Help panel: the chapter list comes first. */
async function openTour(p: Page, at: string) {
    await p.goto(`${BASE}/#${at.replace(/^#/, "")}`);
    await pwExpect(p.locator("h1").first()).toBeVisible();
    await p.locator(".topbar").getByRole("button", { name: "Help", exact: true }).click();
    const panelOrSheet = p.getByRole("complementary", { name: "Help", exact: true }).or(p.getByRole("dialog", { name: "Help", exact: true }));
    await panelOrSheet.getByRole("button", { name: "Take the tour" }).click();
    await pwExpect(card(p).getByRole("heading", { name: "Take the tour" })).toBeVisible({ timeout: 8000 });
}
/** The step on screen now: its counter line and title, once its element is outlined (or it is a plain card). */
async function current(p: Page, s: TourStep) {
    await pwExpect(card(p).getByRole("heading", { name: s.title, exact: true })).toBeVisible({ timeout: 10_000 });
    if (s.target) await pwExpect(p.locator(".tour-target")).toHaveCount(1, { timeout: 5000 });
}
async function noOverflow(p: Page, label: string) {
    expect(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), label).toBe(0);
}
async function axe(p: Page, label: string) {
    const r = await new AxeBuilder({ page: p }).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), label).toEqual([]);
}

// ── the whole tour ──────────────────────────────────────────────────────────

describe("the whole tour on a project that has everything", () => {
    it("shows every step on its own page, pointing at its element, and sends nothing that could change data", async () => {
        const steps = stepsFor(fullHave);
        expect(steps.length).toBeGreaterThanOrEqual(55);
        const { ctx, p } = await freshPage();
        const writes: string[] = [];
        p.on("request", (r) => {
            if (r.url().startsWith(BASE) && r.method() !== "GET") writes.push(`${r.method()} ${r.url()}`);
        });
        try {
            await openTour(p, `/projects/${full.projectId}`);
            // The chapter list: every chapter of this project, with its size.
            const list = card(p).getByRole("list", { name: "Chapters" });
            for (const c of chaptersOf(steps)) await pwExpect(list).toContainText(`${c.title}`);
            await pwExpect(list.getByRole("button")).toHaveCount(CHAPTERS.length);
            await btn(p, "Start from the beginning").click();
            const usedAlt: string[] = [];
            for (let i = 0; i < steps.length; i++) {
                const s = steps[i]!;
                await current(p, s);
                const chapter = CHAPTERS.find((c) => c.id === s.chapter)!.title;
                expect(await count(p), s.id).toBe(`Step ${i + 1} of ${steps.length} · ${chapter}`);
                if (s.target) {
                    const mark = await p.locator(".tour-target").getAttribute("data-tour");
                    expect([s.target, s.alt], s.id).toContain(mark);
                    if (mark !== s.target) usedAlt.push(s.id);
                    // The card is inside the window and beside its element (above or below), unless the element is too tall for that.
                    const t = (await p.locator(".tour-target").boundingBox())!;
                    const c = (await card(p).boundingBox())!;
                    expect(c.x >= 0 && c.y >= 0 && c.x + c.width <= 1281 && c.y + c.height <= 901, `${s.id}: card on screen`).toBe(true);
                    if (t.height < 400) expect(c.y >= t.y + t.height - 1 || c.y + c.height <= t.y + 1, `${s.id}: card beside its element (element ${JSON.stringify(t)}, card ${JSON.stringify(c)})`).toBe(true);
                }
                await pwExpect(btn(p, i === steps.length - 1 ? "Finish" : "Next")).toBeFocused({ timeout: 5000 });
                await btn(p, i === steps.length - 1 ? "Finish" : "Next").click();
            }
            await pwExpect(card(p)).toHaveCount(0);
            expect(await stored(p, "guide.tour")).toBe("done");
            expect(await stored(p, "guide.tour.at")).toBeNull();
            // Only the steps that wait for something live use their stand-in: no run going, no exploration going.
            expect(usedAlt.filter((id) => !["explorer-view", "run-strip"].includes(id))).toEqual([]);
            // The tour itself sends only GET requests. A few pages it opens ask the server with a POST that only reads or converts (the
            // script preview of the Code tab, the Text tab turning steps into lines and back, a ticket for the live event stream): those are
            // the requests a viewer, the read-only role, may make. Nothing that a viewer may not do is sent, so nothing can change.
            const readOnly = Object.entries(ROUTE_ROLES)
                .filter(([k, rule]) => rule === "viewer" && !k.startsWith("GET "))
                .map(([k]) => { const [m, t] = k.split(" "); return { m: m!, re: new RegExp(`^${t!.replace(/:[^/]+/g, "[^/]+")}$`) }; });
            const changing = writes.filter((w) => { const [m, url] = w.split(" "); const p = new URL(url!).pathname; return !readOnly.some((r) => r.m === m && r.re.test(p)); });
            expect(changing, "the tour only reads").toEqual([]);
            expect(await p.getByRole("dialog").count(), "no dialog was opened").toBe(0);
        } finally {
            await ctx.close();
        }
    }, 300_000);
});

// ── chapters ────────────────────────────────────────────────────────────────

describe("chapters", () => {
    it("Skip chapter goes to the next chapter's first step; the card's chapter list jumps; the last chapter has no Skip chapter", async () => {
        const steps = stepsFor(fullHave);
        const ch = chaptersOf(steps);
        const { ctx, p } = await freshPage();
        try {
            await openTour(p, `/projects/${full.projectId}`);
            await btn(p, "Start from the beginning").click();
            await current(p, steps[0]!);
            await btn(p, "Skip chapter").click();
            await current(p, steps[ch[1]!.first]!);
            expect(await count(p)).toBe(`Step ${ch[1]!.first + 1} of ${steps.length} · Making tests`);
            // Back from a chapter's first step goes to the previous chapter's last.
            await btn(p, "Back").click();
            await current(p, steps[ch[1]!.first - 1]!);
            // The card's own chapter list.
            await card(p).locator("summary", { hasText: "Chapters" }).click();
            await card(p).locator(".tour-chapters").getByRole("button", { name: "Help", exact: true }).click();
            const help = ch.find((c) => c.id === "help")!;
            await current(p, steps[help.first]!);
            expect(await count(p)).toContain("· Help");
            await pwExpect(btn(p, "Skip chapter")).toHaveCount(0);
            await pwExpect(btn(p, "End tour")).toBeVisible();
        } finally {
            await ctx.close();
        }
    }, 90_000);

    it("starts at one chapter from the Guide page, and says so when a chapter does not apply to the project", async () => {
        const { ctx, p } = await freshPage();
        try {
            // In the full project: Running and results starts at its first step.
            await p.goto(`${BASE}/#/projects/${full.projectId}/tests`);
            await pwExpect(p.locator("h1").first()).toBeVisible();
            await p.goto(`${BASE}/#/guide`);
            await pwExpect(p.getByRole("heading", { name: "The guided tour", level: 2 })).toBeVisible();
            await p.locator(".guide-tour-chapters").getByRole("button", { name: "Running and results", exact: true }).click();
            const steps = stepsFor(fullHave);
            const first = steps.find((s) => s.chapter === "running")!;
            await current(p, first);
            expect(await count(p)).toBe(`Step ${steps.indexOf(first) + 1} of ${steps.length} · Running and results`);
            expect(await hash(p)).toBe(`#/projects/${full.projectId}/tests`);
            await p.keyboard.press("Escape");
            await pwExpect(card(p)).toHaveCount(0);

            // In the plain project there is no phone app: the chapter list says Phones is left out.
            await p.goto(`${BASE}/#/projects/${plain.projectId}/tests`);
            await pwExpect(p.locator("h1").first()).toBeVisible();
            await p.goto(`${BASE}/#/guide`);
            await p.locator(".guide-tour-chapters").getByRole("button", { name: "Phones", exact: true }).click();
            await pwExpect(card(p).getByRole("heading", { name: "Take the tour" })).toBeVisible({ timeout: 8000 });
            await pwExpect(card(p)).toContainText("Phones does not apply to this project, so it is left out.");
            const plainSteps = stepsFor(plainHave);
            await pwExpect(card(p)).toContainText(`${plainSteps.length} steps in ${chaptersOf(plainSteps).length} chapters`);
            await pwExpect(card(p).getByRole("list", { name: "Chapters" }).getByRole("button", { name: "Phones" })).toHaveCount(0);
            await pwExpect(card(p).getByRole("list", { name: "Chapters" }).getByRole("button", { name: "Security assessment" })).toHaveCount(0);
            await btn(p, "Not now").click();
            await pwExpect(card(p)).toHaveCount(0);
        } finally {
            await ctx.close();
        }
    }, 90_000);
});

// ── remembering, keyboard, a missing element ────────────────────────────────

describe("the tour remembers, works by keyboard, and passes over what is missing", () => {
    it("remembers the step where the person stopped and offers to continue there; finishing forgets it", async () => {
        const steps = stepsFor(plainHave);
        const { ctx, p } = await freshPage();
        try {
            await openTour(p, `/projects/${plain.projectId}`);
            await pwExpect(btn(p, "Continue where you stopped")).toHaveCount(0);
            await btn(p, "Start from the beginning").click();
            for (let i = 0; i < 3; i++) {
                await current(p, steps[i]!);
                await btn(p, "Next").click();
            }
            await current(p, steps[3]!);
            await btn(p, "End tour").click();
            await pwExpect(card(p)).toHaveCount(0);
            expect(await stored(p, "guide.tour")).toBe("skipped");
            expect(await stored(p, "guide.tour.at")).toBe(steps[3]!.id);
            // Later: the chapter list offers to go on, and does.
            await openTour(p, `/projects/${plain.projectId}`);
            await pwExpect(card(p)).toContainText(`${steps[3]!.title}, in ${CHAPTERS.find((c) => c.id === steps[3]!.chapter)!.title}`);
            await pwExpect(btn(p, "Continue where you stopped")).toBeFocused();
            await btn(p, "Continue where you stopped").click();
            await current(p, steps[3]!);
            expect(await count(p)).toContain(`Step 4 of ${steps.length}`);
            // Escape also remembers the step.
            await btn(p, "Next").click();
            await current(p, steps[4]!);
            await p.keyboard.press("Escape");
            expect(await stored(p, "guide.tour.at")).toBe(steps[4]!.id);
            // Finishing forgets it.
            await openTour(p, `/projects/${plain.projectId}`);
            await card(p).getByRole("list", { name: "Chapters" }).getByRole("button", { name: "Help", exact: true }).click();
            const helpSteps = steps.filter((s) => s.chapter === "help");
            for (const s of helpSteps) {
                await current(p, s);
                await btn(p, s === helpSteps[helpSteps.length - 1] ? "Finish" : "Next").click();
            }
            await pwExpect(card(p)).toHaveCount(0);
            expect(await stored(p, "guide.tour.at")).toBeNull();
        } finally {
            await ctx.close();
        }
    }, 120_000);

    it("by keyboard: focus is on the card, the arrows go on and back, Escape ends", async () => {
        const steps = stepsFor(plainHave);
        const { ctx, p } = await freshPage();
        try {
            await openTour(p, `/projects/${plain.projectId}`);
            await pwExpect(btn(p, "Start from the beginning")).toBeFocused();
            await p.keyboard.press("Enter");
            await current(p, steps[0]!);
            await pwExpect(btn(p, "Next")).toBeFocused({ timeout: 5000 });
            await p.keyboard.press("ArrowRight");
            await current(p, steps[1]!);
            await pwExpect(btn(p, "Next")).toBeFocused({ timeout: 5000 });
            await p.keyboard.press("ArrowRight");
            await current(p, steps[2]!);
            await p.keyboard.press("ArrowLeft");
            await current(p, steps[1]!);
            expect(await count(p)).toContain("Step 2 of");
            // Tab stays among the card's controls for its buttons; Enter on Next goes on.
            await p.keyboard.press("Enter");
            await current(p, steps[2]!);
            await p.keyboard.press("Escape");
            await pwExpect(card(p)).toHaveCount(0);
            expect(await p.locator(".tour-target").count()).toBe(0);
        } finally {
            await ctx.close();
        }
    }, 60_000);

    it("passes over a step whose element went missing, quietly, and the counter says the real number", async () => {
        const steps = stepsFor(plainHave);
        const { ctx, p } = await freshPage();
        try {
            await openTour(p, `/projects/${plain.projectId}`);
            await btn(p, "Start from the beginning").click();
            const at = steps.findIndex((s) => s.id === "tab-tests");
            for (let i = 0; i < at; i++) {
                await current(p, steps[i]!);
                await btn(p, "Next").click();
            }
            await current(p, steps[at]!);
            // The next step's element goes away (as if the page had no such tab).
            await p.evaluate((t) => document.querySelector(`[data-tour="${t}"]`)?.removeAttribute("data-tour"), steps[at + 1]!.target!);
            await btn(p, "Next").click();
            await current(p, steps[at + 2]!);
            expect(await count(p)).toContain(`Step ${at + 2} of ${steps.length - 1}`);
            expect(await p.locator('[role="alert"]').count()).toBe(0);
            // Back passes over it too.
            await btn(p, "Back").click();
            await current(p, steps[at]!);
            expect(await count(p)).toContain(`Step ${at + 1} of ${steps.length - 1}`);
            await btn(p, "End tour").click();
        } finally {
            await ctx.close();
        }
    }, 60_000);
});

// ── phone width, accessibility ──────────────────────────────────────────────

describe("on a 375 px phone and for everyone", () => {
    it("keeps the card on screen, above or below its element, with no sideways scroll; the hidden sidebar's steps are passed over", async () => {
        const steps = stepsFor(plainHave);
        const { ctx, p } = await freshPage({ viewport: { width: 375, height: 667 } });
        try {
            await openTour(p, `/projects/${plain.projectId}`);
            await noOverflow(p, "chapter list on a phone");
            const box = (await card(p).boundingBox())!;
            expect(box.y + box.height).toBeLessThanOrEqual(667);
            await btn(p, "Start from the beginning").click();
            // The sidebar is behind the menu on a phone: its steps are passed over and the counter leaves them out.
            const sidebar = steps.filter((s) => s.target?.startsWith("nav-")).length;
            const firstSeen = steps.find((s) => !s.target?.startsWith("nav-"))!;
            await current(p, firstSeen);
            expect(await count(p)).toBe(`Step 1 of ${steps.length - sidebar} · Getting around`);
            const upTo = steps.findIndex((s) => s.chapter === "making") + 3;
            for (let i = steps.indexOf(firstSeen); i < upTo; i++) {
                const s = steps[i]!;
                await current(p, s);
                const c = (await card(p).boundingBox())!;
                expect(c.x, s.id).toBeGreaterThanOrEqual(0);
                expect(c.y, s.id).toBeGreaterThanOrEqual(0);
                expect(c.x + c.width, s.id).toBeLessThanOrEqual(375);
                expect(c.y + c.height, s.id).toBeLessThanOrEqual(667);
                if (s.target) {
                    const t = (await p.locator(".tour-target").boundingBox())!;
                    if (t.height < 200) expect(c.y >= t.y + t.height - 1 || c.y + c.height <= t.y + 1, `${s.id}: card does not cover its element`).toBe(true);
                }
                await noOverflow(p, `${s.id} on a phone`);
                await btn(p, "Next").click();
            }
            await btn(p, "End tour").click();
        } finally {
            await ctx.close();
        }
    }, 120_000);

    it("touch targets in the card are at least 44 px", async () => {
        const { ctx, p } = await freshPage();
        try {
            await openTour(p, `/projects/${plain.projectId}`);
            const small = async () =>
                p.evaluate(() =>
                    Array.from(document.querySelectorAll<HTMLElement>(".tour-card button, .tour-card summary"))
                        .filter((el) => el.offsetParent !== null)
                        .map((el) => ({ name: el.textContent?.trim(), h: el.getBoundingClientRect().height }))
                        .filter((x) => x.h < 43.5),
                );
            expect(await small(), "chapter list").toEqual([]);
            await btn(p, "Start from the beginning").click();
            await pwExpect(card(p).locator(".tour-count")).toBeVisible({ timeout: 8000 });
            await card(p).locator("summary", { hasText: "Chapters" }).click();
            expect(await small(), "a step, chapters open").toEqual([]);
        } finally {
            await ctx.close();
        }
    }, 60_000);

    it("is accessible in light and dark: the chapter list, a step, a step with its chapters open", async () => {
        for (const scheme of ["light", "dark"] as const) {
            const { ctx, p } = await freshPage();
            try {
                await p.emulateMedia({ colorScheme: scheme });
                await openTour(p, `/projects/${full.projectId}`);
                await p.waitForTimeout(400);
                await axe(p, `chapter list (${scheme})`);
                await btn(p, "Start from the beginning").click();
                await current(p, stepsFor(fullHave)[0]!);
                await btn(p, "Next").click();
                await current(p, stepsFor(fullHave)[1]!);
                await p.waitForTimeout(400);
                await axe(p, `a step (${scheme})`);
                await card(p).locator("summary", { hasText: "Chapters" }).click();
                await axe(p, `chapters open (${scheme})`);
            } finally {
                await ctx.close();
            }
        }
    }, 90_000);
});

describe("the whole run", () => {
    it("raised no browser errors", () => {
        expect(consoleErrors).toEqual([]);
    });
});
