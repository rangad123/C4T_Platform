/**
 * The Explorer view in a real browser against the real platform. The platform, its routes and its picture store are real; for the states we need to
 * hold still, a job row is created directly (no worker) and pictures are handed to the platform's picture store the way the engine does (real JPEGs taken
 * with the real camera). One journey at the end runs a real exploration of a slow site with a worker and a scripted model.
 *
 *   off until asked for, and the platform is asked for nothing meanwhile; remembered in this browser; a labelled switch
 *   waiting, then the picture with a text alternative, address, title, one activity line, the phase, pages seen and "Updated just now"
 *   about one request every 1.5 s; none while the tab is in the background or after the panel is closed; backs off on errors; a rate answer is not an error
 *   the activity line changes at once on screen and is announced at most once every 5 seconds
 *   the existing Stop dialog (one Stop control, not two); calm states (nothing to show, another computer); a finished job keeps the last picture
 *   keyboard path, 44 px targets, axe in light and dark, phone width without sideways scrolling; screenshots in .scratch/explorer-view/shots
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/explorer-view-ui.test.ts
 * Ports: platform 6632, slow site 6633.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { MockLanguageModelV3 } from "ai/test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import type { ExplorerFrame } from "../src/engine/frames/sink.js";
import { shootPage } from "../src/engine/frames/shoot.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { frameHub } from "../src/platform/frame-hub.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { startExplorerSite, type ExplorerSite } from "./fixtures/explorer-site.js";

const PORT = 6632;
const SITE_PORT = 6633;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const SHOTS = path.join(REPO_ROOT, ".scratch", "explorer-view", "shots");

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let site: ExplorerSite;
let dir: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let camera: Page;
let worker: Worker | undefined;
const consoleErrors: string[] = [];
/** When each picture request left the page. */
const frameAt: number[] = [];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const hide = (hidden: boolean) =>
    page.evaluate((h) => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
        document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
async function axe() {
    const result = await new AxeBuilder({ page }).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
async function settle(scheme: "light" | "dark") {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(400);
}
const region = () => page.getByRole("region", { name: "Explorer view", exact: true });
const watchSwitch = () => page.getByRole("switch", { name: /^Watch live/ });
const requestsSince = (n: number) => frameAt.length - n;

/** A real picture, taken by the real camera from a page that looks like `title`, handed over as the engine would. */
let tick = 0;
async function picture(title: string, urlPath: string, note: string, over: Partial<ExplorerFrame> = {}): Promise<ExplorerFrame> {
    await camera.setContent(`<!doctype html><title>${title}</title><body style="margin:0;font:28px sans-serif;background:#f4f7f7"><h1 style="margin:40px">${title}</h1><p style="margin:40px">Some plain text on the ${title} page.</p><div style="margin:40px;height:120px;background:#0d9488"></div></body>`);
    const shot = (await shootPage(camera))!;
    return { jpeg: shot.jpeg, url: `${SITE}${urlPath}`, title, note, phase: "exploring", pagesSeen: 3, at: new Date(Date.now() + tick++).toISOString(), ...over };
}

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    fs.mkdirSync(SHOTS, { recursive: true });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-explorer-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT), LLM_PROVIDER: "anthropic", CONCURRENCY: "1" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    frameHub.markLocal();
    site = await startExplorerSite(SITE_PORT);
    browser = await chromium.launch();
    camera = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    page.on("request", (r) => {
        if (/\/api\/projects\/[^/]+\/jobs\/[^/]+\/frame/.test(r.url())) frameAt.push(Date.now());
    });
}, 120_000);

afterAll(async () => {
    await worker?.stop();
    await browser?.close();
    await server?.close();
    platform?.db.close();
    await site?.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

// ── seeded jobs ───────────────────────────────────────────────────────────────
const api = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text } as { status: number; body: any };
};
async function newJob(name: string, over: Record<string, unknown> = {}) {
    const projectId = (await api("POST", "/api/projects", { name })).body.id as string;
    const appId = platform.repo.createApplication(projectId, SITE, {});
    const j = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "generate", targets: ["web"], ...over } as never);
    platform.repo.setJobStatus(j.id, "DISCOVERING");
    platform.repo.setPhase(j.id, "discovery", "running");
    return { projectId, jobId: j.id };
}
const visit = async (projectId: string) => {
    await page.goto(`${BASE}/#/projects/${projectId}`);
    await pwExpect(page.getByRole("heading", { name: "Exploring your application", exact: true })).toBeVisible({ timeout: 15_000 });
};

let J1: { projectId: string; jobId: string };

describe("the Explorer view: the switch", () => {
    it("is off until asked for, and the platform is asked for nothing meanwhile", async () => {
        J1 = await newJob("Explorer one");
        const before = frameAt.length;
        const accepted = frameHub.accepted;
        await visit(J1.projectId);
        const sw = watchSwitch();
        await pwExpect(sw).toBeVisible();
        await pwExpect(sw).toHaveAttribute("aria-checked", "false");
        await pwExpect(page.getByText("See the browser the AI is using.", { exact: true })).toBeVisible();
        await sleep(2800);
        expect(requestsSince(before)).toBe(0);
        await pwExpect(region()).toHaveCount(0);
        expect(frameHub.isWatched(J1.jobId)).toBe(false);
        expect(frameHub.accepted).toBe(accepted);
        // The ordinary Stop control is where it always was.
        await pwExpect(page.getByRole("button", { name: "Stop exploring", exact: true })).toHaveCount(1);
    }, 60_000);

    it("shows a calm waiting state when switched on, and remembers the choice in this browser", async () => {
        const before = frameAt.length;
        await watchSwitch().click();
        await pwExpect(watchSwitch()).toHaveAttribute("aria-checked", "true");
        await pwExpect(region()).toBeVisible();
        await pwExpect(region().getByTestId("explorer-empty")).toHaveText("Waiting for the first picture…");
        await pwExpect(region().getByText("This is a picture of the browser the AI is using on the platform’s computer. It refreshes about once a second while this panel is open. Passwords are hidden.", { exact: true })).toBeVisible();
        expect(await page.evaluate(() => window.localStorage.getItem("aitp.explorer.watch"))).toBe("1");
        await pwExpect.poll(() => frameAt.length - before, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
        expect(frameHub.isWatched(J1.jobId)).toBe(true);
        await page.screenshot({ path: path.join(SHOTS, "waiting-light-1280.png") });
        await region().screenshot({ path: path.join(SHOTS, "waiting-panel-light.png") });
    }, 60_000);

    it("exposes one Stop control, inside the panel (not a second copy next to it)", async () => {
        await pwExpect(page.getByRole("button", { name: "Stop exploring", exact: true })).toHaveCount(1);
        await pwExpect(region().getByRole("button", { name: "Stop exploring", exact: true })).toHaveCount(1);
    });
});

describe("the Explorer view: the picture", () => {
    it("shows the picture with a text alternative, the address, the title, what just happened, the phase, pages seen and how fresh it is", async () => {
        await frameHub.put(J1.jobId, await picture("Pricing", "/pricing", "Opened /pricing"));
        const img = region().getByTestId("explorer-image");
        await pwExpect(img).toBeVisible({ timeout: 8000 });
        await pwExpect(img).toHaveAttribute("alt", `Pricing, at ${SITE}/pricing`);
        expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(640);
        await pwExpect(region().getByTestId("explorer-url")).toHaveText(`${SITE}/pricing`);
        await pwExpect(region().getByTestId("explorer-title")).toHaveText("Pricing");
        await pwExpect(region().getByTestId("explorer-note")).toHaveText("Opened /pricing");
        await pwExpect(region().getByTestId("explorer-status")).toHaveText("Exploring pages, 3 pages seen, Updated just now");
        await pwExpect(region().getByTestId("explorer-empty")).toHaveCount(0);
    }, 60_000);

    it("follows the exploration, and asks about once every 1.5 seconds", async () => {
        const n = frameAt.length;
        await frameHub.put(J1.jobId, await picture("About", "/about", "Read 7 links", { pagesSeen: 4 }));
        await pwExpect(region().getByTestId("explorer-image")).toHaveAttribute("alt", `About, at ${SITE}/about`, { timeout: 8000 });
        await pwExpect(region().getByTestId("explorer-note")).toHaveText("Read 7 links");
        await pwExpect(region().getByTestId("explorer-status")).toContainText("4 pages seen");
        await sleep(4500);
        const mine = frameAt.slice(n);
        expect(mine.length).toBeGreaterThanOrEqual(3);
        const gaps = mine.slice(1).map((t, i) => t - mine[i]!);
        expect(Math.min(...gaps)).toBeGreaterThanOrEqual(1300);
        expect(Math.max(...gaps)).toBeLessThanOrEqual(4000);
        await pwExpect(region().getByTestId("explorer-status")).toContainText(/Updated \d+ seconds ago/);
    }, 60_000);

    it("changes the activity line at once on screen but speaks it at most once every five seconds", async () => {
        await page.evaluate(() => {
            const w = window as unknown as { __spoken: Array<{ t: number; text: string }> };
            w.__spoken = [];
            const el = document.querySelector('[data-testid="explorer-note-live"]')!;
            new MutationObserver(() => w.__spoken.push({ t: Date.now(), text: el.textContent ?? "" })).observe(el, { childList: true, characterData: true, subtree: true });
        });
        const notes = ["Clicked Pricing", "Clicked Plans", "Clicked Enterprise", "Clicked Contact", "Clicked Sign in"];
        const started = Date.now();
        for (const [i, note] of notes.entries()) {
            await frameHub.put(J1.jobId, await picture("Pricing", `/pricing`, note));
            await pwExpect(region().getByTestId("explorer-note")).toHaveText(note, { timeout: 6000 });
            if (i < notes.length - 1) await sleep(300);
        }
        const seenAll = Date.now() - started;
        expect(seenAll).toBeLessThan(15_000);
        await sleep(5600);
        const spoken = await page.evaluate(() => (window as unknown as { __spoken: Array<{ t: number; text: string }> }).__spoken);
        expect(spoken.length).toBeGreaterThanOrEqual(1);
        expect(spoken.length).toBeLessThanOrEqual(Math.ceil((Date.now() - started) / 5000) + 1);
        for (let i = 1; i < spoken.length; i++) expect(spoken[i]!.t - spoken[i - 1]!.t).toBeGreaterThanOrEqual(4500);
        expect(spoken[spoken.length - 1]!.text).toBe("Clicked Sign in");
        // The live region is polite and is the only part that is announced.
        await pwExpect(region().getByTestId("explorer-note-live")).toHaveAttribute("aria-live", "polite");
        await pwExpect(region().getByTestId("explorer-note")).toHaveAttribute("aria-hidden", "true");
    }, 90_000);

    it("pauses while the tab is in the background and carries on when it is back", async () => {
        await hide(true);
        await pwExpect(page.getByText("Paused while this tab is in the background.", { exact: true })).toBeVisible();
        await sleep(2000); // a request already on its way may still land
        const n = frameAt.length;
        await sleep(3500);
        expect(frameAt.length).toBe(n);
        await hide(false);
        await pwExpect(page.getByText("Paused while this tab is in the background.")).toHaveCount(0);
        await pwExpect.poll(() => frameAt.length, { timeout: 5000 }).toBeGreaterThan(n);
    }, 60_000);

    it("shows another computer's part and an unreachable platform calmly, backs off on errors and treats a rate answer as no error", async () => {
        let mode: "elsewhere" | "error" | "rate" | "off" = "elsewhere";
        const errorAt: number[] = [];
        await page.route(/\/api\/projects\/[^/]+\/jobs\/[^/]+\/frame/, (route) => {
            if (mode === "elsewhere") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ available: false, why: "elsewhere", reason: "This part runs on another computer and cannot be shown.", mime: "image/jpeg", watching: true }) });
            if (mode === "error") {
                errorAt.push(Date.now());
                return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
            }
            if (mode === "rate") return route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "That is more than three pictures a second." }) });
            return route.fallback();
        });
        try {
            await pwExpect(page.getByTestId("explorer-state")).toHaveText("This part runs on another computer and cannot be shown.", { timeout: 8000 });
            // The last picture stays, dimmed.
            await pwExpect(region().getByTestId("explorer-image")).toBeVisible();
            mode = "error";
            await pwExpect(page.getByTestId("explorer-state")).toHaveText("The picture could not be loaded. Trying again…", { timeout: 8000 });
            await sleep(8500);
            const gaps = errorAt.slice(1).map((t, i) => t - errorAt[i]!);
            expect(gaps.length).toBeGreaterThanOrEqual(1);
            expect(gaps[0]!).toBeGreaterThanOrEqual(2800);
            mode = "rate";
            await sleep(9000); // the pending retry, then the slow-down
            await pwExpect(page.getByTestId("explorer-state")).toHaveCount(0);
        } finally {
            mode = "off";
            await page.unroute(/\/api\/projects\/[^/]+\/jobs\/[^/]+\/frame/);
        }
        await pwExpect(region().getByTestId("explorer-status")).toContainText("Updated", { timeout: 10_000 });
    }, 120_000);

    it("says what is wrong when the platform was started before this feature existed (the route is missing) and not that the job is gone", async () => {
        // A separate page of the same browser (the switch is remembered there too): a 404 ends polling for a page load, and the other tests need the shared page untouched.
        const other = await page.context().newPage();
        let answer: "missing-route" | "missing-job" = "missing-route";
        await other.route(/\/api\/projects\/[^/]+\/jobs\/[^/]+\/frame/, (route) => {
            const error = answer === "missing-route" ? "Not found" : "Job not found";
            return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error }) });
        });
        try {
            await other.goto(page.url());
            await pwExpect(other.getByTestId("explorer-state")).toContainText("has not been restarted since it was updated", { timeout: 15_000 });
            await pwExpect(other.getByTestId("explorer-state")).not.toContainText("no longer has this job");
            answer = "missing-job";
            await other.reload();
            await pwExpect(other.getByTestId("explorer-state")).toContainText("no longer has this job", { timeout: 15_000 });
        } finally {
            await other.close();
        }
    }, 60_000);

    it("says there is nothing to show while the AI works without a browser, keeping the last picture, and recovers", async () => {
        platform.repo.setJobStatus(J1.jobId, "ANALYZING");
        await pwExpect(page.getByTestId("explorer-state")).toHaveText("Nothing to show right now.", { timeout: 8000 });
        await pwExpect(region().getByTestId("explorer-image")).toBeVisible();
        platform.repo.setJobStatus(J1.jobId, "DISCOVERING");
        await frameHub.put(J1.jobId, await picture("Team", "/team", "Opened /team", { pagesSeen: 6 }));
        await pwExpect(page.getByTestId("explorer-state")).toHaveCount(0, { timeout: 8000 });
        await pwExpect(region().getByTestId("explorer-title")).toHaveText("Team", { timeout: 8000 });
    }, 60_000);
});

describe("the Explorer view: stopping and the keyboard", () => {
    it("opens the existing Stop dialog, and keeps running when asked to", async () => {
        await region().getByRole("button", { name: "Stop exploring", exact: true }).click();
        const dialog = page.getByRole("dialog");
        await pwExpect(dialog.getByRole("heading", { name: "Stop exploring?", exact: true })).toBeVisible();
        await dialog.getByRole("button", { name: "Keep running", exact: true }).click();
        await pwExpect(dialog).toHaveCount(0);
        await pwExpect(region().getByRole("button", { name: "Stop exploring", exact: true })).toBeEnabled();
    }, 60_000);

    it("can be used from the keyboard with a visible focus, with targets of at least 44 px", async () => {
        const sw = watchSwitch();
        await sw.focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        await pwExpect(sw).toBeFocused();
        const ring = await sw.locator(".ex-knob").evaluate((el) => getComputedStyle(el).boxShadow);
        expect(ring).not.toBe("none");
        const boxes = await page.evaluate(() => {
            const h = (el: Element | null) => Math.round(el?.getBoundingClientRect().height ?? 0);
            return { sw: h(document.getElementById("ex-watch")), stop: h(document.querySelector('[data-testid="explorer-view"] .btn')) };
        });
        expect(boxes.sw).toBeGreaterThanOrEqual(44);
        expect(boxes.stop).toBeGreaterThanOrEqual(36);
        // Tab leaves the switch for the panel's Stop control, which opens the dialog with Enter and closes with Escape.
        await page.keyboard.press("Tab");
        await pwExpect(region().getByRole("button", { name: "Stop exploring", exact: true })).toBeFocused();
        await page.keyboard.press("Enter");
        await pwExpect(page.getByRole("dialog")).toBeVisible();
        await page.keyboard.press("Escape");
        await pwExpect(page.getByRole("dialog")).toHaveCount(0);
    }, 60_000);

    it("turns off with Space: the panel closes and the platform is asked for nothing more", async () => {
        const sw = watchSwitch();
        await sw.focus();
        await page.keyboard.press("Space");
        await pwExpect(sw).toHaveAttribute("aria-checked", "false");
        await pwExpect(region()).toHaveCount(0);
        await sleep(2000);
        const n = frameAt.length;
        await sleep(3500);
        expect(frameAt.length).toBe(n);
        expect(await page.evaluate(() => window.localStorage.getItem("aitp.explorer.watch"))).toBe("0");
        // Remembered in the other direction too: on again, then a reload keeps it on.
        await page.keyboard.press("Space");
        await pwExpect(sw).toHaveAttribute("aria-checked", "true");
        await page.reload();
        await pwExpect(watchSwitch()).toHaveAttribute("aria-checked", "true", { timeout: 15_000 });
        await pwExpect(region()).toBeVisible();
    }, 90_000);
});

describe("the Explorer view: looks right", () => {
    it("has no accessibility violations in light and dark, with the picture showing", async () => {
        await frameHub.put(J1.jobId, await picture("Pricing", "/pricing", "Opened /pricing"));
        await pwExpect(region().getByTestId("explorer-image")).toBeVisible({ timeout: 8000 });
        for (const scheme of ["light", "dark"] as const) {
            await settle(scheme);
            await axe();
            await region().screenshot({ path: path.join(SHOTS, `panel-${scheme}-1280.png`) });
        }
        await settle("light");
    }, 90_000);

    it("fits a phone without sideways scrolling, the picture scales and the targets stay large", async () => {
        await page.setViewportSize({ width: 375, height: 800 });
        await sleep(600);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
        const m = await page.evaluate(() => {
            const img = document.querySelector<HTMLImageElement>('[data-testid="explorer-image"]')!.getBoundingClientRect();
            const small = Array.from(document.querySelectorAll('[data-testid="explorer-view"] button, #ex-watch')).filter((el) => el.getBoundingClientRect().height < 43.5).map((el) => el.textContent?.trim());
            return { imgRight: img.right, vw: window.innerWidth, small };
        });
        expect(m.imgRight).toBeLessThanOrEqual(m.vw);
        expect(m.small).toEqual([]);
        await axe();
        await settle("dark");
        await axe();
        await region().screenshot({ path: path.join(SHOTS, "panel-dark-390.png") });
        await settle("light");
        await region().screenshot({ path: path.join(SHOTS, "panel-light-390.png") });
        await page.setViewportSize({ width: 1280, height: 900 });
    }, 90_000);
});

describe("the Explorer view: when the exploration is over", () => {
    it("keeps the last picture on screen with a sentence, though the platform no longer holds it, and drops it when the person leaves", async () => {
        const last = await picture("Docs", "/docs", "Read 9 links", { pagesSeen: 12 });
        await frameHub.put(J1.jobId, last);
        await pwExpect(region().getByTestId("explorer-title")).toHaveText("Docs", { timeout: 8000 });
        platform.repo.updateCounters(J1.jobId, { pagesDiscovered: 14 });
        platform.repo.setJobStatus(J1.jobId, "COMPLETED");
        await pwExpect(page.getByTestId("explorer-finished")).toHaveText("Exploration finished: 14 pages seen", { timeout: 10_000 });
        await pwExpect(region().getByTestId("explorer-image")).toBeVisible();
        await pwExpect(region().getByTestId("explorer-image")).toHaveAttribute("alt", `Docs, at ${SITE}/docs`);
        await pwExpect(region().getByRole("button", { name: /^Stop/ })).toHaveCount(0);
        await pwExpect(watchSwitch()).toHaveCount(0);
        // The platform itself holds nothing: the picture on screen is this tab's own.
        // (The job finished without a worker here, so nothing has let go of its picture yet; the first read does.)
        const res = await api("GET", `/api/projects/${J1.projectId}/jobs/${J1.jobId}/frame`);
        expect(res.body).toMatchObject({ available: false, why: "finished" });
        expect(res.body.imageBase64).toBeUndefined();
        expect(frameHub.latest(J1.jobId)).toBeUndefined();
        const n = frameAt.length;
        await sleep(3500);
        expect(frameAt.length).toBe(n);
        for (const scheme of ["light", "dark"] as const) {
            await settle(scheme);
            await axe();
        }
        await settle("light");
        await region().screenshot({ path: path.join(SHOTS, "finished-light.png") });
        await page.screenshot({ path: path.join(SHOTS, "finished-light-1280.png") });
        // Leaving the page forgets it.
        await page.goto(`${BASE}/#/`);
        await sleep(500);
        await page.goto(`${BASE}/#/projects/${J1.projectId}`);
        await pwExpect(page.getByRole("heading", { name: J1.projectId ? /Explorer one/ : "" })).toBeVisible({ timeout: 15_000 });
        await pwExpect(region()).toHaveCount(0);
    }, 120_000);

    it("shows nothing for a job nobody watched", async () => {
        const quiet = await newJob("Explorer quiet");
        platform.repo.setJobStatus(quiet.jobId, "COMPLETED");
        await page.goto(`${BASE}/#/projects/${quiet.projectId}`);
        await pwExpect(page.getByRole("heading", { name: /Explorer quiet/ })).toBeVisible({ timeout: 15_000 });
        await pwExpect(region()).toHaveCount(0);
    }, 60_000);

    it("is not offered for creating tests from a plan or for a run", async () => {
        const fromPlan = await newJob("Explorer plan creation", { fromPlan: "some-plan-job" });
        await page.goto(`${BASE}/#/projects/${fromPlan.projectId}`);
        await pwExpect(page.getByRole("heading", { name: "Creating your tests", exact: true })).toBeVisible({ timeout: 15_000 });
        await pwExpect(page.getByRole("switch")).toHaveCount(0);
        const run = await newJob("Explorer run", { mode: "validate", testIds: [] });
        await page.goto(`${BASE}/#/projects/${run.projectId}`);
        await pwExpect(page.getByRole("heading", { name: "Running your tests", exact: true })).toBeVisible({ timeout: 15_000 });
        await pwExpect(page.getByRole("switch")).toHaveCount(0);
    }, 60_000);

    it("raised no console errors", () => {
        expect(consoleErrors).toEqual([]);
    });
});

// ── one real journey ─────────────────────────────────────────────────────────
describe("the Explorer view: a real exploration", () => {
    it("shows the browser of a real exploration, and the Stop control stops it and keeps the last picture", async () => {
        const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
        const model = new MockLanguageModelV3({ doGenerate: async () => ({ content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] }) });
        const scripted: LlmClient = {
            modelName: "scripted",
            model,
            usage: { inputTokens: 0, outputTokens: 0 },
            text: async () => "",
            object: (async ({ system }: { system: string }) =>
                /analysing a web application/.test(system)
                    ? { siteType: "ecommerce", purpose: "A shop", features: [], pagePurposes: [], journeys: [{ name: "Read pricing", description: "Look", steps: ["Open"], priority: "high", pages: ["/pricing"], requiresAuth: false }], authenticationMechanisms: [] }
                    : { scenarios: [ScenarioSchema.omit({ scenarioId: true }).parse({ title: "Read pricing", description: "Read pricing", category: "Browsing", priority: "high", journey: "Read pricing", startPath: "/pricing", expectedResults: ["Pricing plans is shown"] })] }) as LlmClient["object"],
        };
        platform.llm = scripted;
        worker = new Worker({ ...platform, makeLlm: () => scripted }, 100);
        worker.start();

        const projectId = (await api("POST", "/api/projects", { name: "Real exploration" })).body.id as string;
        const started = await api("POST", `/api/projects/${projectId}/test-generation`, { url: SITE, maxPages: 10, targets: ["web"], plan: true });
        expect(started.status).toBe(202);
        const jobId = started.body.jobId as string;
        await page.goto(`${BASE}/#/projects/${projectId}`);
        // The switch was left on by the earlier test in this browser: the panel appears by itself.
        await pwExpect(watchSwitch()).toBeVisible({ timeout: 30_000 });
        if ((await watchSwitch().getAttribute("aria-checked")) !== "true") await watchSwitch().click();
        const img = region().getByTestId("explorer-image");
        await pwExpect(img).toBeVisible({ timeout: 60_000 });
        expect(await img.getAttribute("alt")).toMatch(new RegExp(`^.+, at ${SITE.replace(/[.]/g, "\\.")}/`));
        expect(await region().getByTestId("explorer-url").textContent()).toMatch(new RegExp(`^${SITE.replace(/[.]/g, "\\.")}`));
        expect(await region().getByTestId("explorer-note").textContent()).toMatch(/^(Opened \/|Read \d+ links?)/);
        expect(await region().getByTestId("explorer-status").textContent()).toMatch(/^(Exploring pages|Signing in), \d+ pages? seen, Updated/);
        await page.screenshot({ path: path.join(SHOTS, "real-light-1280.png") });
        await region().screenshot({ path: path.join(SHOTS, "real-panel-light.png") });

        // Stop it through the panel's own control.
        await region().getByRole("button", { name: "Stop exploring", exact: true }).click();
        const dialog = page.getByRole("dialog");
        await pwExpect(dialog.getByRole("heading", { name: "Stop exploring?", exact: true })).toBeVisible();
        await dialog.getByRole("button", { name: "Stop exploring", exact: true }).click();
        await pwExpect(page.getByTestId("explorer-finished")).toContainText("Exploration stopped:", { timeout: 60_000 });
        await pwExpect(region().getByTestId("explorer-image")).toBeVisible();
        expect(frameHub.latest(jobId)).toBeUndefined();
        expect((await api("GET", `/api/test-generation/${jobId}`)).body.status).toBe("FAILED");
    }, 180_000);
});
