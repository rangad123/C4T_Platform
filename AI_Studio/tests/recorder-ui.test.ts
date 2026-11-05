/**
 * The Record a test page in a real browser: the start form and its errors, a live step list that grows while the page polls,
 * changing a locator, editing a value, deleting, sharing, the inspector, stopping, saving, discarding, a failed session, the
 * keyboard-only path, a phone-width layout and accessibility in light and dark.
 *
 * The platform underneath is real (a seeded project and tests, the real UI bundle). The recorder API is a small in-memory
 * stand-in that follows .scratch/briefs/RECORDER-API-SHAPES.md, served by a front server that forwards everything else to the
 * platform; it exists so this file does not depend on the platform half landing and so a test can push steps, picked
 * elements, a 409, a 422 and a failed session. The last journey runs against the real platform when its recorder routes exist.
 * Ports: 6010 front (the address the browser uses), 6011 platform, 6012 fixture application.
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/recorder-ui.test.ts
 * Set AN_SHOTS=<folder> to also write screenshots (start, recording with steps and the picked element, save form; light and dark; 1280 and 390 wide).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { recorderOptions } from "../src/platform/routes/recorder.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { addTest, seedProject, seedRun, type Seed } from "./fixtures/dashboard-seed.js";

const FRONT_PORT = 6010;
const PLATFORM_PORT = 6011;
const APP_PORT = 6012;
const BASE = `http://127.0.0.1:${FRONT_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}/`;

// ── the stand-in recorder API ───────────────────────────────────────────────

type Loc = { strategy: string; value: string; name?: string };
interface FakeStep {
    index: number; kind: string; url?: string; locator?: Loc; alternatives?: Array<{ locator: Loc; matches: number }>; matches?: number;
    value?: string; secret?: boolean; assert?: { check: string; expected?: string | number }; ref?: string; describe: string; at: string;
}
interface FakeRec {
    id: string; projectId: string; status: "starting" | "recording" | "stopped" | "failed" | "saved"; startUrl: string; currentUrl?: string; headed: boolean;
    environment?: string; steps: FakeStep[]; inspect: { on: boolean; mode: "locator" | "assertion"; assertCheck?: unknown };
    picked?: { locator: Loc; alternatives: Array<{ locator: Loc; matches: number }>; tag: string; text?: string; at: string };
    startedAt: string; stoppedAt?: string; error?: string; savedTestId?: string;
}
const fake = {
    /** false: the front only forwards, and the real platform answers the recorder routes. */
    enabled: true,
    rec: null as FakeRec | null,
    start: "ok" as "ok" | "409" | "409-no-id" | "422" | "500",
    save: "ok" as "ok" | "no-job" | "fail" | "note",
    share: "ok" as "ok" | "404",
    calls: [] as string[],
    bodies: [] as Array<{ call: string; body: unknown }>,
    polls: 0,
    testId: "",
};
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
let projectIdForRec = "";

function resetFake() {
    Object.assign(fake, { rec: null, start: "ok", save: "ok", share: "ok", calls: [], bodies: [], polls: 0 });
}
const newRec = (over: Partial<FakeRec> = {}): FakeRec => ({
    id: "rec-1", projectId: projectIdForRec, status: "recording", startUrl: APP, currentUrl: APP, headed: true, steps: [], inspect: { on: false, mode: "locator" }, startedAt: iso(5000), ...over,
});
const view = (r: FakeRec) => ({ ...r, canSave: r.steps.some((s) => s.kind !== "goto") });
const reindex = (r: FakeRec) => r.steps.forEach((s, i) => (s.index = i));

const STEP = {
    goto: (i: number): FakeStep => ({ index: i, kind: "goto", url: APP, describe: `Open ${APP}`, at: iso(4000) }),
    click: (i: number): FakeStep => ({
        index: i, kind: "click", locator: { strategy: "role", value: "button", name: "Add to cart" }, matches: 1, describe: "Click the button “Add to cart”", at: iso(3000),
        alternatives: [{ locator: { strategy: "text", value: "Add to cart" }, matches: 3 }, { locator: { strategy: "css", value: "#add" }, matches: 1 }],
    }),
    many: (i: number): FakeStep => ({
        index: i, kind: "click", locator: { strategy: "text", value: "Remove" }, matches: 3, describe: "Click the text “Remove”", at: iso(2500),
        alternatives: [{ locator: { strategy: "role", value: "button", name: "Remove first item" }, matches: 1 }],
    }),
    fill: (i: number): FakeStep => ({
        index: i, kind: "fill", locator: { strategy: "label", value: "Email" }, matches: 1, value: "maya@example.com", describe: "Type “maya@example.com” into the field “Email”", at: iso(2000),
        alternatives: [{ locator: { strategy: "placeholder", value: "you@example.com" }, matches: 2 }],
    }),
    password: (i: number): FakeStep => ({
        index: i, kind: "fill", locator: { strategy: "label", value: "Password" }, matches: 1, value: "{{credentials.password}}", secret: true, describe: "Type the password into the field “Password”", at: iso(1500),
    }),
    check: (i: number): FakeStep => ({
        index: i, kind: "assert", locator: { strategy: "text", value: "Order placed" }, matches: 1, assert: { check: "text", expected: "Order placed" }, describe: "Check that “Order placed” has the text “Order placed”", at: iso(800),
    }),
};
const PICKED = () => ({
    locator: { strategy: "role", value: "button", name: "Add to cart" }, tag: "button", text: "Add to cart", at: iso(0),
    alternatives: [{ locator: { strategy: "role", value: "button", name: "Add to cart" }, matches: 1 }, { locator: { strategy: "text", value: "Add to cart" }, matches: 3 }, { locator: { strategy: "css", value: "#add" }, matches: 1 }],
});

async function front(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", BASE);
    const p = url.pathname;
    const method = req.method ?? "GET";
    const json = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
    };
    if (!fake.enabled) return forward(req, res, body, url);
    let m: RegExpMatchArray | null;
    const parsed = (): Record<string, unknown> => {
        try {
            return JSON.parse(body.toString() || "{}");
        } catch {
            return {};
        }
    };
    const log = (call: string) => {
        fake.calls.push(call);
        fake.bodies.push({ call, body: body.length ? parsed() : undefined });
    };

    if ((m = p.match(/^\/api\/projects\/([^/]+)\/recordings$/)) && method === "POST") {
        log("start");
        projectIdForRec = m[1]!;
        if (fake.start === "409") return json(409, { error: "A recording is already running for this project.", id: fake.rec?.id ?? "rec-active" });
        if (fake.start === "409-no-id") return json(409, { error: "A recording is already running for this project." });
        if (fake.start === "422") return json(422, { error: "This computer has no screen to show a browser window on. Turn off “Show the browser window”, or run the platform on a machine with a screen." });
        if (fake.start === "500") return json(500, { error: "The recorder could not start. Try again in a moment." });
        const b = parsed() as { url: string; headed?: boolean; environment?: string };
        fake.rec = newRec({ projectId: m[1]!, startUrl: b.url, currentUrl: b.url, headed: b.headed !== false, ...(b.environment ? { environment: b.environment } : {}), status: "recording" });
        return json(201, view(fake.rec));
    }
    if ((m = p.match(/^\/api\/recordings\/([^/]+)$/))) {
        const r = fake.rec;
        if (method === "GET") {
            fake.polls++;
            return !r || r.id !== m[1] ? json(404, { error: "That recording does not exist." }) : json(200, view(r));
        }
        if (method === "DELETE") {
            log("discard");
            fake.rec = null;
            return json(200, { ok: true });
        }
    }
    if ((m = p.match(/^\/api\/recordings\/([^/]+)\/(inspect|stop|save)$/)) && method === "POST") {
        const r = fake.rec;
        if (!r) return json(404, { error: "That recording does not exist." });
        log(m[2]!);
        if (m[2] === "inspect") {
            const b = parsed() as { on: boolean; mode?: "locator" | "assertion"; check?: string };
            r.inspect = { on: b.on, mode: b.mode ?? "locator", ...(b.check ? { assertCheck: { check: b.check } } : {}) };
            return json(200, view(r));
        }
        if (m[2] === "stop") {
            r.status = "stopped";
            r.stoppedAt = iso();
            r.inspect.on = false;
            return json(200, view(r));
        }
        if (fake.save === "fail") return json(500, { error: "The test could not be stored. Try again." });
        r.status = "saved";
        r.savedTestId = fake.testId;
        return json(201, { testId: fake.testId, jobId: fake.save === "no-job" ? null : "job-fake-rec", ...(fake.save === "note" ? { note: "This recording signs in with a stand-in for the password. Save the project’s sign-in details so the test can run." } : {}) });
    }
    if ((m = p.match(/^\/api\/recordings\/([^/]+)\/steps\/(\d+)(\/share)?$/))) {
        const r = fake.rec;
        const i = Number(m[2]);
        const s = r?.steps[i];
        if (!r || !s) return json(404, { error: "That step does not exist." });
        if (m[3] && method === "POST") {
            log("share");
            if (fake.share === "404") return json(404, { error: "Not found" });
            s.ref = (parsed() as { name: string }).name;
            return json(200, view(r));
        }
        if (method === "PATCH") {
            log("patch");
            const b = parsed() as { locator?: Loc; value?: string; assert?: FakeStep["assert"] };
            if (b.locator) {
                const alt = s.alternatives?.find((a) => a.locator.strategy === b.locator!.strategy && a.locator.value === b.locator!.value);
                const old = { locator: s.locator!, matches: s.matches ?? 1 };
                s.alternatives = [...(s.alternatives ?? []).filter((a) => a !== alt), old];
                s.locator = b.locator;
                s.matches = alt?.matches ?? 1;
                s.describe = `Click the ${b.locator.strategy} “${b.locator.name ?? b.locator.value}”`;
            }
            if (b.value !== undefined) {
                s.value = b.value;
                s.describe = `Type “${b.value}” into the field “Email”`;
            }
            if (b.assert) s.assert = b.assert;
            return json(200, view(r));
        }
        if (method === "DELETE") {
            log("delete");
            r.steps.splice(i, 1);
            reindex(r);
            return json(200, view(r));
        }
    }
    return forward(req, res, body, url);
}

async function forward(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer, url: URL) {
    const method = req.method ?? "GET";
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "connection", "content-length"].includes(k)) headers[k] = v;
    const upstream = await fetch(`http://127.0.0.1:${PLATFORM_PORT}${req.url}`, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : new Uint8Array(body) });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" }).end(buf);
    void url;
}

// ── harness ─────────────────────────────────────────────────────────────────

let browser: Browser;
let context: BrowserContext;
let page: Page;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let frontServer: http.Server;
let appServer: http.Server;
let dataDir: string;
let seed: Seed;
let projectId: string;
let testId: string;
/** The browser the real platform recorded in (the test hands it over so it can play the person). */
let recBrowser: Browser | undefined;
let worker: Worker;
/** True when the platform half answers the recorder routes. */
let realAvailable = false;
const consoleErrors: string[] = [];

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-recorder-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT) }));
    // The platform records in a Chromium the test launched, so the test can click in it like a person; it may open only the fixture application.
    recorderOptions.launch = async (headless) => (recBrowser = await chromium.launch({ headless }));
    recorderOptions.guard = async (u) => {
        if (!u.startsWith(`http://127.0.0.1:${APP_PORT}/`)) throw new Error("Only the fixture application may be opened in this test.");
    };
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 200); // runs the validation job the real journey queues
    worker.start();
    frontServer = http.createServer((req, res) => void front(req, res).catch((e) => res.writeHead(500).end(String(e))));
    await new Promise<void>((r) => frontServer.listen(FRONT_PORT, "127.0.0.1", r));
    appServer = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html" }).end(APP_PAGE);
    });
    await new Promise<void>((r) => appServer.listen(APP_PORT, "127.0.0.1", r));

    seed = seedProject(platform, "Atlas shop", APP);
    testId = addTest(platform, seed, "home page");
    await seedRun(platform, seed, { "home page": "pass" }, { daysAgo: 1 });
    projectId = seed.projectId;
    projectIdForRec = projectId;
    fake.testId = testId;
    const probe = await fetch(`http://127.0.0.1:${PLATFORM_PORT}/api/projects/${projectId}/recordings`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    realAvailable = probe.status !== 404;

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); // axe-core refuses pages that were not made through a context
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
    page = await context.newPage();
    page.on("console", (m) => {
        // A 409 or 404 the page shows on purpose is logged by the browser as a failed load; that is not a page error.
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
}, 120_000);

afterAll(async () => {
    await browser?.close();
    frontServer?.close();
    appServer?.close();
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const APP_PAGE = `<!doctype html><html lang="en"><head><title>Fixture shop</title></head><body>
<h1>Fixture shop</h1>
<label>Email <input id="email" type="text"></label>
<label>Password <input id="pw" type="password"></label>
<button id="add" onclick="document.getElementById('out').textContent='Added'">Add to cart</button>
<p id="out" role="status"></p></body></html>`;

const recordUrl = (session?: string) => `${BASE}/#/projects/${projectId}/record${session ? `?session=${session}` : ""}`;
async function openStart() {
    await page.evaluate(() => sessionStorage.clear()).catch(() => undefined);
    await page.goto(recordUrl());
    await page.reload(); // a hash change alone would not re-run the page's loads
    await pwExpect(page.getByRole("heading", { name: "Record a test", exact: true })).toBeVisible();
    await pwExpect(page.getByRole("button", { name: "Start recording", exact: true })).toBeVisible();
}
/** Start a recording through the form and return when the session view shows. */
async function startRecording(steps: FakeStep[] = []) {
    await openStart();
    await page.getByLabel("Address to start from").fill(APP);
    await page.getByRole("button", { name: "Start recording", exact: true }).click();
    await pwExpect(page.getByTestId("rec-state")).toHaveText("Recording");
    if (steps.length) {
        fake.rec!.steps.push(...steps);
        await pwExpect(page.locator("[data-step]")).toHaveCount(steps.length, { timeout: 8000 });
    }
}
const row = (i: number) => page.locator(`[data-step="${i}"]`);
const shots = process.env.AN_SHOTS;
async function shot(name: string) {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
}

async function noOverflow() {
    const wide = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".content *"))
            .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !el.closest(".tabs, .rec-scroll"))
            .slice(0, 5)
            .map((el) => `${el.tagName.toLowerCase()}.${el.className}`),
    );
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect({ overflow, wide }).toEqual({ overflow: 0, wide: [] });
}
/** Every button, link-button, text field and select, and the whole row of each checkbox or radio, is at least 44px tall. */
async function bigTargets() {
    const small = await page.evaluate(() => {
        const out: string[] = [];
        const check = (el: Element, label: string) => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return;
            if (r.height < 43.5) out.push(`${label} ${Math.round(r.height)}px: ${(el.textContent ?? "").trim().slice(0, 40) || el.getAttribute("aria-label") || el.id}`);
        };
        document.querySelectorAll(".content button, .content a.btn, .content input:not([type=checkbox]):not([type=radio]):not([type=hidden]), .content select").forEach((el) => check(el, el.tagName.toLowerCase()));
        document.querySelectorAll(".content .check, .content .rec-choice").forEach((el) => check(el, "row"));
        return out;
    });
    expect(small).toEqual([]);
}
async function axe() {
    const result = await new AxeBuilder({ page }).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
async function settle(scheme: "light" | "dark") {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(400); // colours ease over 140ms when the scheme flips; audit the settled state
}

// ── journeys ────────────────────────────────────────────────────────────────

describe("Record a test: start", () => {
    it("is reached from Test development's Record, and is not a way of making a test script any more", async () => {
        resetFake();
        await page.goto(`${BASE}/#/projects/${projectId}/scripts`);
        await page.reload();
        await page.getByRole("button", { name: "New test script", exact: true }).click();
        await pwExpect(page.getByRole("menuitem", { name: "Build steps by hand", exact: true })).toBeVisible();
        await pwExpect(page.getByRole("menuitem", { name: "Record it in a browser" })).toHaveCount(0);
        await page.keyboard.press("Escape");
        await page.goto(`${BASE}/#/develop`);
        await page.locator("li", { hasText: "Atlas shop" }).getByRole("link", { name: "Record", exact: true }).click();
        await pwExpect(page.getByRole("heading", { name: "Record a test", exact: true })).toBeVisible();
        await pwExpect(page.getByText("We open a browser window on the computer that runs this platform.")).toBeVisible();
        expect(page.url()).toContain(`/#/projects/${projectId}/record`);
        // the empty state of a project without tests offers New test script, without recording
        const empty = seedProject(platform, "Empty shop", APP);
        await page.goto(`${BASE}/#/projects/${empty.projectId}/scripts`);
        await page.reload();
        await pwExpect(page.getByRole("heading", { name: "No test scripts yet" })).toBeVisible();
        await page.getByRole("button", { name: "New test script", exact: true }).last().click();
        await pwExpect(page.getByRole("menuitem", { name: "Write it as text", exact: true })).toBeVisible();
        await pwExpect(page.getByRole("menuitem", { name: "Record it in a browser" })).toHaveCount(0);
    });

    it("explains the page, prefills the project address and warns about personal data", async () => {
        resetFake();
        await openStart();
        await pwExpect(page.getByLabel("Address to start from")).toHaveValue(APP);
        await pwExpect(page.getByLabel("Show the browser window")).toBeChecked();
        await pwExpect(page.getByText("Don’t type real personal data or secrets while recording. Password fields are never recorded.")).toBeVisible();
        await pwExpect(page.getByText("Click through your application as a user would. We write down each step.")).toBeVisible();
        await pwExpect(page.getByLabel("Environment (optional)")).toHaveCount(0); // the project has no environments
        await shot("start-light-1280");
    });

    it("warns a person who uses the platform from another computer that the window opens on the platform's computer, and points to adding a runner", async () => {
        resetFake();
        const warning = () => page.getByText("This opens the browser on the platform’s computer, not on yours");
        // On the platform's own computer there is no warning.
        await openStart();
        await pwExpect(warning()).toHaveCount(0);
        // Opened through another address (forced with ?remote=1): the warning, with the way out.
        await page.goto(`${BASE}/#/projects/${projectId}/record?remote=1`);
        await page.reload();
        await pwExpect(warning()).toBeVisible();
        await pwExpect(page.getByText("where you cannot click in it")).toBeVisible();
        await shot("start-remote-warning-light-1280");
        await page.getByRole("button", { name: "Add a runner on your computer" }).click();
        // Round 37: runners are machine-level; the link opens the Runners page on this project.
        await pwExpect(page).toHaveURL(/#\/runners\?project=[^&]+$/);
    });

    it("says what is wrong with the address in plain words and sends nothing", async () => {
        resetFake();
        await openStart();
        const url = page.getByLabel("Address to start from");
        const start = page.getByRole("button", { name: "Start recording", exact: true });
        await url.fill("");
        await start.click();
        await pwExpect(page.getByText("Enter the address of the application you want to test.")).toBeVisible();
        await pwExpect(url).toHaveAttribute("aria-invalid", "true");
        await url.fill("ftp://files.example.com");
        await start.click();
        await pwExpect(page.getByText("Only web addresses starting with http:// or https:// can be tested.")).toBeVisible();
        await url.fill("nonsense");
        await start.click();
        await pwExpect(page.getByText("That doesn’t look like a complete address.", { exact: false })).toBeVisible();
        expect(fake.calls).toEqual([]);
    });

    it("sends the address, the window choice and the environment, then opens the session", async () => {
        resetFake();
        await openStart();
        await page.getByLabel("Address to start from").fill("127.0.0.1:6012/shop");
        await page.getByLabel("Show the browser window").uncheck();
        await page.getByRole("button", { name: "Start recording", exact: true }).click();
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Recording");
        expect(fake.bodies[0]).toEqual({ call: "start", body: { url: "http://127.0.0.1:6012/shop", headed: false } });
        expect(page.url()).toContain("?session=rec-1");
        await pwExpect(page.getByText("Your steps appear here as you click in the browser window.")).toBeVisible();
        await pwExpect(page.getByTestId("rec-count")).toHaveText("0 steps");
    });

    it("shows the no-screen answer in a callout and keeps what was typed", async () => {
        resetFake();
        fake.start = "422";
        await openStart();
        await page.getByLabel("Address to start from").fill("http://127.0.0.1:6012/keep-me");
        await page.getByLabel("Show the browser window").uncheck();
        await page.getByRole("button", { name: "Start recording", exact: true }).click();
        await pwExpect(page.getByText("We can’t open the browser window")).toBeVisible();
        await pwExpect(page.getByText("This computer has no screen to show a browser window on.", { exact: false })).toBeVisible();
        await pwExpect(page.getByLabel("Address to start from")).toHaveValue("http://127.0.0.1:6012/keep-me");
        await pwExpect(page.getByLabel("Show the browser window")).not.toBeChecked();
        await pwExpect(page.getByRole("button", { name: "Start recording", exact: true })).toBeEnabled();
    });

    it("shows any other failure plainly and lets the person try again", async () => {
        resetFake();
        fake.start = "500";
        await openStart();
        await page.getByRole("button", { name: "Start recording", exact: true }).click();
        await pwExpect(page.getByText("The recorder could not start. Try again in a moment.")).toBeVisible();
        fake.start = "ok";
        await page.getByRole("button", { name: "Start recording", exact: true }).click();
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Recording");
    });

    it("offers the project environments, supplies their address, and asks before recording on a live site", async () => {
        resetFake();
        const envShop = seedProject(platform, "Env shop", APP);
        const mk = async (name: string, production: boolean) => {
            const r = await fetch(`http://127.0.0.1:${PLATFORM_PORT}/api/projects/${envShop.projectId}/environments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, baseUrl: `http://127.0.0.1:${APP_PORT}`, production }) });
            expect(r.status).toBeLessThan(300);
        };
        await mk("staging", false);
        await mk("live", true);
        await page.goto(`${BASE}/#/projects/${envShop.projectId}/record`);
        await page.reload();
        const select = page.getByLabel("Environment (optional)");
        await pwExpect(select.getByRole("option")).toHaveText(["None, use the address above", "staging", "live (production)"]);
        await select.selectOption("live");
        await pwExpect(page.getByLabel("This is a live site")).not.toBeChecked();
        await page.getByRole("button", { name: "Start recording", exact: true }).click();
        await pwExpect(page.getByText("Confirm before recording on a live site")).toBeVisible();
        expect(fake.calls).toEqual([]);
        await page.getByLabel("This is a live site").check();
        await page.getByRole("button", { name: "Start recording", exact: true }).click();
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Recording");
        const sent = fake.bodies[0]!.body as { url: string };
        expect(sent.url).toMatch(/^http:\/\/127\.0\.0\.1:6012\/?$/);
        expect(fake.bodies[0]).toEqual({ call: "start", body: { url: sent.url, headed: true, environment: "live", confirmProduction: true } });
    });

    it("offers to resume a recording that is already running", async () => {
        resetFake();
        fake.rec = newRec({ id: "rec-active", steps: [STEP.goto(0), STEP.click(1)] });
        fake.start = "409";
        await openStart();
        await page.getByRole("button", { name: "Start recording", exact: true }).click();
        await pwExpect(page.getByText("A recording is already running for this project", { exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Resume watching", exact: true }).click();
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Recording");
        await pwExpect(page.locator("[data-step]")).toHaveCount(2);
        expect(page.url()).toContain("?session=rec-active");
    });

    it("explains a conflict that does not name the session, without a button that cannot work", async () => {
        resetFake();
        fake.start = "409-no-id";
        await openStart();
        await page.getByRole("button", { name: "Start recording", exact: true }).click();
        await pwExpect(page.getByText("A recording is already running for this project", { exact: true })).toBeVisible();
        await pwExpect(page.getByText("so we can’t open it from here", { exact: false })).toBeVisible();
        await pwExpect(page.getByRole("button", { name: "Resume watching" })).toHaveCount(0);
    });
});

describe("Record a test: while recording", () => {
    it("shows steps as they arrive with their kind, words, locator badge and secret badge, and announces each one", async () => {
        resetFake();
        await startRecording();
        await pwExpect(page.getByTestId("rec-url")).toHaveText(APP);
        await pwExpect(page.getByTestId("rec-elapsed")).toHaveText(/^\d+:\d\d$/);
        fake.rec!.steps.push(STEP.goto(0), STEP.click(1));
        await pwExpect(page.locator("[data-step]")).toHaveCount(2, { timeout: 8000 });
        await pwExpect(page.getByTestId("rec-announce")).toHaveText("Step 2 recorded");
        fake.rec!.steps.push(STEP.many(2), STEP.fill(3), STEP.password(4));
        await pwExpect(page.locator("[data-step]")).toHaveCount(5, { timeout: 8000 });
        await pwExpect(page.getByTestId("rec-count")).toHaveText("5 steps");
        await pwExpect(page.getByTestId("rec-announce")).toHaveText("Step 5 recorded");

        await pwExpect(row(0)).toContainText(`Open ${APP}`);
        await pwExpect(row(0).getByText("Unique")).toHaveCount(0); // a page visit has no locator
        await pwExpect(row(1)).toContainText("Click the button “Add to cart”");
        await pwExpect(row(1).getByText("Unique", { exact: true })).toBeVisible();
        await pwExpect(row(1)).toContainText("Button named “Add to cart”");
        await pwExpect(row(2).getByText("Matches 3 elements", { exact: true })).toBeVisible();
        await pwExpect(row(3)).toContainText("Type “maya@example.com”");
        await pwExpect(row(4).getByText("Secret", { exact: true })).toBeVisible();
        await pwExpect(row(4).getByRole("button", { name: /Edit value/ })).toHaveCount(0); // a secret has no value to edit
        const kinds = await page.locator("[data-step]").evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
        expect(kinds).toEqual(["goto", "click", "click", "fill", "fill"]);
        // every step has an icon drawn by the icon set, and the list is a real ordered list
        await pwExpect(page.getByRole("list", { name: "Recorded steps" }).locator("svg")).not.toHaveCount(0);
        await shot("recording-steps-light-1280");
    });

    it("changes a locator by choosing one of the other ways to find the element", async () => {
        resetFake();
        await startRecording([STEP.goto(0), STEP.many(1)]);
        await row(1).getByRole("button", { name: "Change locator for step 2" }).click();
        const group = row(1).getByRole("group", { name: "Locator for step 2" });
        await pwExpect(group.getByRole("radio")).toHaveCount(2);
        await pwExpect(group).toContainText("Text “Remove”, 3 matches");
        await pwExpect(group.getByRole("radio", { name: /Text “Remove”/ })).toBeChecked();
        await group.getByRole("radio", { name: /Button named “Remove first item”, unique/ }).click();
        await pwExpect(row(1).getByText("Unique", { exact: true })).toBeVisible();
        expect(fake.bodies.find((b) => b.call === "patch")?.body).toEqual({ locator: { strategy: "role", value: "button", name: "Remove first item" } });
        await pwExpect(group).toHaveCount(0); // closes once done
        await pwExpect(row(1).getByText("Matches 3 elements")).toHaveCount(0);
    });

    it("edits a typed value and shows a plain error when it cannot be saved", async () => {
        resetFake();
        await startRecording([STEP.goto(0), STEP.fill(1)]);
        await row(1).getByRole("button", { name: "Edit value of step 2" }).click();
        const field = row(1).getByLabel("Text to type");
        await pwExpect(field).toHaveValue("maya@example.com");
        await field.fill("sam@example.com");
        await row(1).getByRole("button", { name: "Save value", exact: true }).click();
        await pwExpect(row(1)).toContainText("Type “sam@example.com”");
        expect(fake.bodies.find((b) => b.call === "patch")?.body).toEqual({ value: "sam@example.com" });
        // a step that vanished on the platform: the error says so and the form stays
        fake.rec!.steps.pop();
        await row(1).getByRole("button", { name: "Edit value of step 2" }).click();
        await row(1).getByLabel("Text to type").fill("x");
        await row(1).getByRole("button", { name: "Save value", exact: true }).click();
        await pwExpect(row(1).getByRole("alert")).toContainText("That step does not exist.");
        await pwExpect(row(1).getByLabel("Text to type")).toHaveValue("x");
    });

    it("edits what a check expects", async () => {
        resetFake();
        await startRecording([STEP.goto(0), STEP.check(1)]);
        await row(1).getByRole("button", { name: "Edit value of step 2" }).click();
        await pwExpect(row(1).getByLabel("Expected value")).toHaveValue("Order placed");
        await row(1).getByLabel("Expected value").fill("Thank you");
        await row(1).getByRole("button", { name: "Save value", exact: true }).click();
        expect(fake.bodies.find((b) => b.call === "patch")?.body).toEqual({ assert: { check: "text", expected: "Thank you" } });
    });

    it("deletes a step and the numbers close up", async () => {
        resetFake();
        await startRecording([STEP.goto(0), STEP.click(1), STEP.fill(2)]);
        await row(1).getByRole("button", { name: "Delete step 2" }).click();
        await pwExpect(page.locator("[data-step]")).toHaveCount(2);
        await pwExpect(row(1)).toContainText("Type “maya@example.com”");
        await pwExpect(row(1)).toContainText("Step 2");
        expect(fake.calls).toContain("delete");
    });

    it("makes a step a shared element, and stops offering it when the platform has no such feature", async () => {
        resetFake();
        await startRecording([STEP.goto(0), STEP.click(1), STEP.fill(2)]);
        await row(1).getByRole("button", { name: "Use step 2 as a shared element" }).click();
        await row(1).getByRole("button", { name: "Use as shared element", exact: true }).click(); // submitted empty
        await pwExpect(row(1).getByRole("alert")).toContainText("Give the element a name");
        await row(1).getByLabel("Name for the shared element").fill("Add to cart button");
        await row(1).getByRole("button", { name: "Use as shared element", exact: true }).click();
        await pwExpect(row(1)).toContainText("Shared: Add to cart button");
        expect(fake.bodies.find((b) => b.call === "share")?.body).toEqual({ name: "Add to cart button" });
        await pwExpect(row(1).getByRole("button", { name: "Change locator for step 2" })).toHaveCount(0);

        fake.share = "404";
        await row(2).getByRole("button", { name: "Use step 3 as a shared element" }).click();
        await row(2).getByLabel("Name for the shared element").fill("Email field");
        await row(2).getByRole("button", { name: "Use as shared element", exact: true }).click();
        await pwExpect(page.getByRole("button", { name: /Make step \d shared/ })).toHaveCount(0);
        await pwExpect(row(2).getByRole("alert")).toHaveCount(0); // not an error: the feature is simply not there
    });

    it("never shows a password: the step carries the placeholder only", async () => {
        resetFake();
        await startRecording([STEP.goto(0), STEP.password(1)]);
        await pwExpect(row(1)).toContainText("Secret");
        const text = await page.locator(".content").innerText();
        const html = await page.content();
        for (const real of ["hunter2", "P@ssw0rd!"]) {
            expect(text).not.toContain(real);
            expect(html).not.toContain(real);
        }
        await pwExpect(row(1).getByRole("textbox")).toHaveCount(0);
    });

    it("keeps the newest step in view only while the person is at the bottom of the list", async () => {
        resetFake();
        const many = Array.from({ length: 14 }, (_, i) => (i === 0 ? STEP.goto(0) : { ...STEP.click(i), at: iso(3000 - i) }));
        await startRecording(many);
        const list = page.getByRole("region", { name: "Recorded steps, scrollable" });
        await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
        fake.rec!.steps.push({ ...STEP.fill(14), at: iso(10) });
        await pwExpect(page.locator("[data-step]")).toHaveCount(15, { timeout: 8000 });
        await pwExpect.poll(() => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(40);
        // scrolled up: a new step must not drag the list away
        await list.evaluate((el) => (el.scrollTop = 0));
        await page.waitForTimeout(150);
        fake.rec!.steps.push({ ...STEP.fill(15), at: iso(5) });
        await pwExpect(page.locator("[data-step]")).toHaveCount(16, { timeout: 8000 });
        expect(await list.evaluate((el) => el.scrollTop)).toBeLessThan(10);
    });
});

describe("Record a test: inspector", () => {
    it("arms picking, shows the picked element in words, copies a locator and arms a check from it", async () => {
        resetFake();
        await startRecording([STEP.goto(0), STEP.click(1)]);
        const pick = page.getByRole("button", { name: "Pick an element", exact: true });
        await pwExpect(pick).toHaveAttribute("aria-pressed", "false");
        await pick.click();
        await pwExpect(pick).toHaveAttribute("aria-pressed", "true");
        await pwExpect(page.getByText("Click an element in the browser window. Your click won’t act on the page.")).toBeVisible();
        expect(fake.bodies.find((b) => b.call === "inspect")?.body).toEqual({ on: true, mode: "locator" });

        fake.rec!.picked = PICKED();
        const panel = page.getByRole("region", { name: "Picked element" });
        await pwExpect(panel).toBeVisible({ timeout: 8000 });
        await pwExpect(panel).toContainText("button");
        await pwExpect(panel).toContainText("“Add to cart”");
        const list = panel.getByRole("list", { name: "Ways to find this element" });
        await pwExpect(list.getByRole("listitem")).toHaveCount(3);
        await pwExpect(list.getByRole("listitem").nth(0)).toContainText("Button named “Add to cart”, unique");
        await pwExpect(list.getByRole("listitem").nth(1)).toContainText("Text “Add to cart”, 3 matches");
        await list.getByRole("button", { name: "Copy: Text “Add to cart”, 3 matches" }).click();
        await pwExpect(list.getByRole("button", { name: "Copy: Text “Add to cart”, 3 matches" })).toHaveText("Copied");
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Text “Add to cart”, 3 matches");

        await panel.getByRole("button", { name: "Use for a check", exact: true }).click();
        await pwExpect(page.getByRole("button", { name: "Add a check", exact: true })).toHaveAttribute("aria-pressed", "true");
        expect(fake.bodies.filter((b) => b.call === "inspect").pop()?.body).toEqual({ on: true, mode: "assertion", check: "visible" });
        // pick mode is no longer the armed one
        await pwExpect(pick).toHaveAttribute("aria-pressed", "false");
        await shot("recording-picked-light-1280");
    });

    it("arms a chosen kind of check and turns inspecting off to click normally again", async () => {
        resetFake();
        await startRecording([STEP.goto(0)]);
        await page.getByLabel("Check", { exact: true }).selectOption("text");
        await page.getByRole("button", { name: "Add a check", exact: true }).click();
        expect(fake.bodies.find((b) => b.call === "inspect")?.body).toEqual({ on: true, mode: "assertion", check: "text" });
        await pwExpect(page.getByText("Adding a check: has this text")).toBeVisible();
        await page.getByLabel("Check", { exact: true }).selectOption("hidden"); // re-arms with the new kind
        await pwExpect.poll(() => (fake.bodies.filter((b) => b.call === "inspect").pop()?.body as { check?: string }).check).toBe("hidden");
        await page.getByRole("button", { name: "Stop adding checks", exact: true }).click();
        await pwExpect(page.getByText("Click an element in the browser window.")).toHaveCount(0);
        expect(fake.bodies.filter((b) => b.call === "inspect").pop()?.body).toMatchObject({ on: false });
        await pwExpect(page.getByRole("button", { name: "Add a check", exact: true })).toHaveAttribute("aria-pressed", "false");
    });

    it("lets a check that the recorder added show up as a step", async () => {
        resetFake();
        await startRecording([STEP.goto(0)]);
        fake.rec!.steps.push(STEP.check(1));
        await pwExpect(row(1)).toContainText("Check that “Order placed” has the text “Order placed”", { timeout: 8000 });
        await pwExpect(row(1)).toHaveAttribute("data-kind", "assert");
    });
});

describe("Record a test: stop, save, discard", () => {
    it("stops, stops polling, and keeps the steps editable", async () => {
        resetFake();
        await startRecording([STEP.goto(0), STEP.click(1)]);
        await page.getByRole("button", { name: "Stop recording", exact: true }).click();
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Stopped");
        await pwExpect(page.getByRole("button", { name: "Stop recording" })).toHaveCount(0);
        await pwExpect(page.getByRole("button", { name: "Change locator for step 2" })).toBeVisible();
        await pwExpect(page.getByRole("button", { name: "Pick an element", exact: true })).toHaveCount(0); // the inspector needs a running recording
        await page.waitForTimeout(1500); // let any poll already on its way land
        const before = fake.polls;
        await page.waitForTimeout(2600);
        expect(fake.polls).toBe(before);
        // editing after the stop still works
        await row(1).getByRole("button", { name: "Delete step 2" }).click();
        await pwExpect(page.locator("[data-step]")).toHaveCount(1);
    });

    it("validates the name, keeps the form when saving fails, then saves and links to the test and the run", async () => {
        resetFake();
        await startRecording([STEP.goto(0), STEP.click(1)]);
        await page.getByRole("button", { name: "Stop recording", exact: true }).click();
        const title = page.getByLabel("Test name");
        const save = page.getByRole("button", { name: "Save as a test", exact: true });
        await save.click();
        await pwExpect(page.getByText("Give the test a name of at least 3 characters.")).toBeVisible();
        await pwExpect(title).toHaveAttribute("aria-invalid", "true");
        await title.fill("x".repeat(161));
        await save.click();
        await pwExpect(page.getByText("Keep the name under 160 characters.")).toBeVisible();
        expect(fake.calls).not.toContain("save");

        fake.save = "fail";
        await title.fill("Add a product to the cart");
        await page.getByLabel("Category (optional)").fill("Checkout");
        await save.click();
        await pwExpect(page.getByText("We couldn’t save the test")).toBeVisible();
        await pwExpect(page.getByText("The test could not be stored. Try again.", { exact: false })).toBeVisible();
        await pwExpect(title).toHaveValue("Add a product to the cart");
        await pwExpect(page.getByLabel("Category (optional)")).toHaveValue("Checkout");
        await pwExpect(page.locator("[data-step]")).toHaveCount(2);

        fake.save = "ok";
        await shot("save-light-1280");
        await save.click();
        await pwExpect(page.getByText("We’re running it now to make sure it passes.")).toBeVisible();
        expect(fake.bodies.find((b) => b.call === "save")?.body).toEqual({ title: "Add a product to the cart", category: "Checkout" });
        const open = page.getByRole("link", { name: "Open the test", exact: true });
        await pwExpect(open).toHaveAttribute("href", `#/tests/${testId}`);
        await pwExpect(page.getByRole("link", { name: "Watch the run", exact: true })).toHaveAttribute("href", `#/projects/${projectId}/runs`);
        await open.click();
        await pwExpect(page.getByRole("heading", { level: 1 })).toBeVisible();
        expect(page.url()).toContain(`#/tests/${testId}`);
    });

    it("says so when no run was queued", async () => {
        resetFake();
        fake.save = "no-job";
        await startRecording([STEP.goto(0), STEP.click(1)]);
        await page.getByRole("button", { name: "Stop recording", exact: true }).click();
        await page.getByLabel("Test name").fill("Quiet save");
        await page.getByRole("button", { name: "Save as a test", exact: true }).click();
        await pwExpect(page.getByText("No run was queued because this project can’t run tests right now.", { exact: false })).toBeVisible();
        await pwExpect(page.getByRole("link", { name: "Watch the run" })).toHaveCount(0);
        await pwExpect(page.getByRole("link", { name: "Open the test", exact: true })).toBeVisible();
        // Record again starts over with the same address
        await page.getByRole("button", { name: "Record again", exact: true }).click();
        await pwExpect(page.getByRole("button", { name: "Start recording", exact: true })).toBeVisible();
        await pwExpect(page.getByLabel("Address to start from")).toHaveValue(APP);
    });

    it("shows why a session ended, the recorder’s notes, and the platform’s note after saving", async () => {
        resetFake();
        await startRecording([STEP.goto(0), STEP.click(1)]);
        fake.rec!.status = "stopped";
        fake.rec!.stoppedAt = iso();
        fake.rec!.error = "Recording stopped after 20 minutes without activity. Your steps are kept.";
        (fake.rec as unknown as { notes: string[] }).notes = ["Step 2 uses text because the button has no stable name."];
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Stopped", { timeout: 8000 });
        await pwExpect(page.getByText("Recording stopped after 20 minutes without activity. Your steps are kept.")).toBeVisible();
        await pwExpect(page.getByText("Notes from the recorder")).toBeVisible();
        await pwExpect(page.getByText("Step 2 uses text because the button has no stable name.")).toBeVisible();
        fake.save = "note";
        await page.getByLabel("Test name").fill("With a note");
        await page.getByRole("button", { name: "Save as a test", exact: true }).click();
        await pwExpect(page.getByText("Save the project’s sign-in details so the test can run.", { exact: false })).toBeVisible();
    });

    it("cannot save a recording that holds only page visits", async () => {
        resetFake();
        await startRecording([STEP.goto(0)]);
        await page.getByRole("button", { name: "Stop recording", exact: true }).click();
        await pwExpect(page.getByText("There is nothing to save yet.", { exact: false })).toBeVisible();
        await pwExpect(page.getByRole("button", { name: "Save as a test", exact: true })).toBeDisabled();
        await pwExpect(page.getByLabel("Test name")).toBeDisabled();
    });

    it("asks before discarding, keeps the session on Keep it, and drops it on Discard", async () => {
        resetFake();
        await startRecording([STEP.goto(0), STEP.click(1)]);
        await page.getByRole("button", { name: "Discard", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Discard this recording?" });
        await pwExpect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Keep it", exact: true }).click();
        await pwExpect(dialog).toHaveCount(0);
        expect(fake.calls).not.toContain("discard");
        await pwExpect(page.locator("[data-step]")).toHaveCount(2);
        // Escape closes it too
        await page.getByRole("button", { name: "Discard", exact: true }).click();
        await pwExpect(dialog).toBeVisible();
        await page.keyboard.press("Escape");
        await pwExpect(dialog).toHaveCount(0);
        expect(fake.calls).not.toContain("discard");

        await page.getByRole("button", { name: "Discard", exact: true }).click();
        await dialog.getByRole("button", { name: "Discard recording", exact: true }).click();
        await pwExpect(page.getByRole("button", { name: "Start recording", exact: true })).toBeVisible();
        expect(fake.calls).toContain("discard");
        expect(fake.rec).toBeNull();
        await pwExpect(page.getByLabel("Address to start from")).toHaveValue(APP);
    });
});

describe("Record a test: failure states", () => {
    it("shows why a session failed and starts again from the same address", async () => {
        resetFake();
        await startRecording([STEP.goto(0), STEP.click(1)]);
        fake.rec!.status = "failed";
        fake.rec!.error = "The browser window was closed before anything could be saved.";
        await pwExpect(page.getByText("The recording stopped")).toBeVisible({ timeout: 8000 });
        await pwExpect(page.getByText("The browser window was closed before anything could be saved.")).toBeVisible();
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Failed");
        await pwExpect(page.getByRole("button", { name: "Stop recording" })).toHaveCount(0);
        await pwExpect(page.getByRole("button", { name: "Change locator for step 2" })).toHaveCount(0); // a failed session is read-only
        await page.getByRole("button", { name: "Start again", exact: true }).click();
        await pwExpect(page.getByRole("button", { name: "Start recording", exact: true })).toBeVisible();
        await pwExpect(page.getByLabel("Address to start from")).toHaveValue(APP);
    });

    it("says a recording is gone when the platform no longer knows it", async () => {
        resetFake();
        await page.goto(recordUrl("rec-missing"));
        await page.reload();
        await pwExpect(page.getByText("This recording no longer exists")).toBeVisible();
        await page.getByRole("button", { name: "Start again", exact: true }).click();
        await pwExpect(page.getByRole("button", { name: "Start recording", exact: true })).toBeVisible();
    });

    it("keeps the steps on screen when the platform drops the session", async () => {
        resetFake();
        await startRecording([STEP.goto(0), STEP.click(1)]);
        fake.rec = null; // the platform restarted
        await page.waitForTimeout(1800);
        // the steps already on screen stay: nothing is thrown away on a hiccup
        await pwExpect(page.locator("[data-step]")).toHaveCount(2);
    });

    it("shows an error callout with Try again when the session cannot be loaded", async () => {
        resetFake();
        await page.route("**/api/recordings/rec-flaky", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "The platform had a problem. Try again." }) }));
        await page.goto(recordUrl("rec-flaky"));
        await page.reload();
        await pwExpect(page.getByText("We couldn’t open this recording")).toBeVisible();
        await pwExpect(page.getByText("The platform had a problem. Try again.")).toBeVisible();
        await pwExpect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
        await page.unroute("**/api/recordings/rec-flaky");
    });
});

describe("Record a test: against the real platform", () => {
    const SECRET = "hunter2-secret-xyz";
    const appPages = () => recBrowser?.contexts().flatMap((c) => c.pages()).filter((p) => p.url().startsWith(APP)) ?? [];

    it("records a real page, keeps the password out of sight, picks an element, saves, and the test is really run", async () => {
        if (!realAvailable) {
            console.warn("recorder-ui: the platform has no recorder routes yet, so the real-platform journey was skipped");
            return;
        }
        fake.enabled = false; // the front now only forwards: the platform's own recorder answers
        try {
            await openStart();
            await page.getByLabel("Show the browser window").uncheck(); // headless: nobody sits at this machine
            await page.getByRole("button", { name: "Start recording", exact: true }).click();
            await pwExpect(page.getByTestId("rec-state")).toHaveText("Recording", { timeout: 60_000 });

            // play the person in the browser the platform opened
            await pwExpect.poll(() => appPages().length, { timeout: 30_000 }).toBeGreaterThan(0);
            const target = appPages()[0]!;
            await target.waitForLoadState("load");
            await target.getByLabel("Email").fill("maya@example.com");
            await target.keyboard.press("Tab");
            await target.getByLabel("Password").fill(SECRET);
            await target.keyboard.press("Tab");
            await target.getByRole("button", { name: "Add to cart" }).click();
            await pwExpect(target.locator("#out")).toHaveText("Added");

            await pwExpect(page.locator("[data-step]").filter({ hasText: "maya@example.com" })).toHaveCount(1, { timeout: 15_000 });
            await pwExpect(page.locator("[data-step]").getByText("Secret", { exact: true })).toHaveCount(1);
            await pwExpect(page.locator("[data-step][data-kind=click]")).toHaveCount(1);
            const shown = (await page.locator(".content").innerText()) + (await page.content());
            expect(shown).not.toContain(SECRET);

            // pick mode: the click does not act on the page, and the panel describes the element
            await target.evaluate(() => (document.getElementById("out")!.textContent = ""));
            await page.getByRole("button", { name: "Pick an element", exact: true }).click();
            await pwExpect(page.getByRole("button", { name: "Pick an element", exact: true })).toHaveAttribute("aria-pressed", "true");
            await target.getByRole("button", { name: "Add to cart" }).click();
            const panel = page.getByRole("region", { name: "Picked element" });
            await pwExpect(panel).toContainText("Add to cart", { timeout: 15_000 });
            await pwExpect(panel.getByRole("list", { name: "Ways to find this element" }).getByRole("listitem").first()).toContainText("unique");
            await pwExpect(target.locator("#out")).toHaveText(""); // the click was not a click
            // use it for a check: the next click adds a check step instead of a click
            await panel.getByRole("button", { name: "Use for a check", exact: true }).click();
            await target.getByRole("button", { name: "Add to cart" }).click();
            await pwExpect(page.locator("[data-step][data-kind=assert]")).toHaveCount(1, { timeout: 15_000 });
            await pwExpect(target.locator("#out")).toHaveText("");

            // stop, then save: the platform builds the test and really runs it
            await page.getByRole("button", { name: "Stop recording", exact: true }).click();
            await pwExpect(page.getByTestId("rec-state")).toHaveText("Stopped", { timeout: 30_000 });
            await page.getByLabel("Test name").fill("Recorded shop journey");
            await page.getByRole("button", { name: "Save as a test", exact: true }).click();
            const open = page.getByRole("link", { name: "Open the test", exact: true });
            await pwExpect(open).toBeVisible({ timeout: 30_000 });
            const href = (await open.getAttribute("href"))!;
            expect(href).toMatch(/^#\/tests\//);

            const api = (p: string) => fetch(`http://127.0.0.1:${PLATFORM_PORT}/api${p}`).then((r) => r.json() as Promise<any>);
            await pwExpect.poll(async () => (await api(`/projects/${projectId}/jobs`)).some((j: { status: string }) => !["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)), { timeout: 180_000, intervals: [2000] }).toBe(false);
            const tests = (await api(`/projects/${projectId}/tests`)) as Array<{ id: string; title: string; validationStatus: string }>;
            const mine = tests.find((x) => x.id === href.replace("#/tests/", ""));
            expect(mine?.title).toBe("Recorded shop journey");
            // the replay is honest: it ran and has an outcome, whatever it was
            expect(["VALIDATED", "NEEDS_REVIEW", "FAILED_VALIDATION"]).toContain(mine?.validationStatus);
            await page.goto(`${BASE}/${href}`);
            await pwExpect(page.getByRole("heading", { level: 1 })).toContainText("Recorded shop journey");
        } finally {
            fake.enabled = true;
            await recBrowser?.close().catch(() => undefined); // our own browser: the platform already closed it, this is only a guard
        }
    }, 360_000);
});

describe("Record a test: keyboard, phone, accessibility", () => {
    it("can be done from the keyboard alone", async () => {
        resetFake();
        await openStart();
        await page.getByLabel("Address to start from").focus();
        await page.keyboard.press("Control+A");
        await page.keyboard.type(APP);
        await page.keyboard.press("Tab"); // the window checkbox
        await pwExpect(page.getByLabel("Show the browser window")).toBeFocused();
        await page.keyboard.press("Space");
        await pwExpect(page.getByLabel("Show the browser window")).not.toBeChecked();
        await page.keyboard.press("Space");
        await page.keyboard.press("Tab"); // Start recording
        await pwExpect(page.getByRole("button", { name: "Start recording", exact: true })).toBeFocused();
        await page.keyboard.press("Enter");
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Recording");
        fake.rec!.steps.push(STEP.goto(0), STEP.click(1));
        await pwExpect(page.locator("[data-step]")).toHaveCount(2, { timeout: 8000 });

        const change = page.getByRole("button", { name: "Change locator for step 2" });
        await change.focus();
        await page.keyboard.press("Enter");
        const radios = row(1).getByRole("radio");
        await radios.first().focus();
        await page.keyboard.press("ArrowDown"); // moves to the next way of finding it and chooses it
        await pwExpect(row(1).getByText("Matches 3 elements", { exact: true })).toBeVisible();

        await page.getByRole("button", { name: "Stop recording", exact: true }).focus();
        await page.keyboard.press("Enter");
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Stopped");
        await page.getByLabel("Test name").focus();
        await page.keyboard.type("Keyboard test");
        await page.keyboard.press("Enter"); // submits the form
        await pwExpect(page.getByRole("link", { name: "Open the test", exact: true })).toBeVisible();
        // focus is visible on the buttons we used
        await page.getByRole("button", { name: "Record again", exact: true }).focus();
        const ring = await page.getByRole("button", { name: "Record again", exact: true }).evaluate((el) => getComputedStyle(el).boxShadow + getComputedStyle(el).outlineStyle);
        expect(ring).not.toMatch(/^none ?none$/);
    });

    it("fits a phone without sideways scrolling and keeps targets at least 44px", async () => {
        resetFake();
        await page.setViewportSize({ width: 375, height: 800 });
        try {
            await openStart();
            await noOverflow();
            await bigTargets();
            await startRecording([STEP.goto(0), STEP.many(1), STEP.fill(2), STEP.password(3)]);
            fake.rec!.picked = PICKED();
            await page.getByRole("button", { name: "Pick an element", exact: true }).click();
            await pwExpect(page.getByRole("region", { name: "Picked element" })).toBeVisible({ timeout: 8000 });
            await row(1).getByRole("button", { name: "Change locator for step 2" }).click();
            await row(2).getByRole("button", { name: "Edit value of step 3" }).click();
            await noOverflow();
            await bigTargets();
            await page.getByRole("button", { name: "Stop recording", exact: true }).click();
            await pwExpect(page.getByRole("button", { name: "Save as a test", exact: true })).toBeVisible();
            await noOverflow();
            await bigTargets();
            await shot("recording-picked-light-375");
        } finally {
            await page.setViewportSize({ width: 1280, height: 900 });
        }
    });

    it("has no accessibility violations in light and dark on every state", async () => {
        for (const scheme of ["light", "dark"] as const) {
            resetFake();
            await settle(scheme);
            await openStart();
            await axe(); // start
            fake.start = "422";
            await page.getByRole("button", { name: "Start recording", exact: true }).click();
            await pwExpect(page.getByText("We can’t open the browser window")).toBeVisible();
            await axe(); // with a callout and an error
            fake.start = "ok";
            await page.getByLabel("Address to start from").fill("");
            await page.getByRole("button", { name: "Start recording", exact: true }).click();
            await pwExpect(page.getByText("Enter the address of the application")).toBeVisible();
            await axe();

            await startRecording([STEP.goto(0), STEP.many(1), STEP.fill(2), STEP.password(3), STEP.check(4)]);
            fake.rec!.picked = PICKED();
            await page.getByRole("button", { name: "Pick an element", exact: true }).click();
            await pwExpect(page.getByRole("region", { name: "Picked element" })).toBeVisible({ timeout: 8000 });
            await row(1).getByRole("button", { name: "Change locator for step 2" }).click();
            await row(2).getByRole("button", { name: "Edit value of step 3" }).click();
            await settle(scheme);
            await axe(); // recording with steps, picked element and open editors
            await shot(`recording-picked-${scheme}-1280`);
            await page.getByRole("button", { name: "Discard", exact: true }).click();
            await pwExpect(page.getByRole("dialog", { name: "Discard this recording?" })).toBeVisible();
            await axe(); // the dialog
            await page.keyboard.press("Escape");
            await page.getByRole("button", { name: "Stop recording", exact: true }).click();
            await pwExpect(page.getByRole("button", { name: "Save as a test", exact: true })).toBeVisible();
            await axe(); // stopped, with the save form
            await page.getByLabel("Test name").fill("A named test");
            await page.getByRole("button", { name: "Save as a test", exact: true }).click();
            await pwExpect(page.getByText("We’re running it now")).toBeVisible();
            await axe(); // saved

            resetFake();
            await startRecording([STEP.goto(0), STEP.click(1)]);
            fake.rec!.status = "failed";
            fake.rec!.error = "The browser window was closed.";
            await pwExpect(page.getByText("The recording stopped")).toBeVisible({ timeout: 8000 });
            await axe(); // failed
        }
        await page.emulateMedia({ colorScheme: null });
    });

    it("writes the screenshots when asked", async () => {
        if (!shots) return;
        for (const scheme of ["light", "dark"] as const) {
            for (const [w, h] of [[1280, 900], [390, 844]] as const) {
                resetFake();
                await settle(scheme);
                await page.setViewportSize({ width: w, height: h });
                await openStart();
                await shot(`start-${scheme}-${w}`);
                await startRecording([STEP.goto(0), STEP.click(1), STEP.many(2), STEP.fill(3), STEP.password(4), STEP.check(5)]);
                fake.rec!.picked = PICKED();
                await page.getByRole("button", { name: "Pick an element", exact: true }).click();
                await pwExpect(page.getByRole("region", { name: "Picked element" })).toBeVisible({ timeout: 8000 });
                await row(2).getByRole("button", { name: "Change locator for step 3" }).click();
                await shot(`recording-${scheme}-${w}`);
                await page.getByRole("button", { name: "Stop recording", exact: true }).click();
                await page.getByLabel("Test name").fill("Add a product to the cart");
                await shot(`save-${scheme}-${w}`);
            }
        }
        await page.emulateMedia({ colorScheme: null });
        await page.setViewportSize({ width: 1280, height: 900 });
    });

    it("kept the browser console clean", () => {
        expect(consoleErrors).toEqual([]);
    });
});
