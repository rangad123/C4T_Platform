/**
 * UX-D in a real browser: explain in place, AI transparency, the decided vocabulary and honest numbers on screen.
 *
 * The platform underneath is real (a seeded project; the failure facts, `failure` block, scripts and controls come from the real
 * test-detail answer; the repair is applied and undone through the real healing and step-editor routes). Only two things are
 * stood in for: a run's finish (no worker runs here, so the test marks the queued job finished the way the worker would) and the
 * runner list/status answer of the phone-tests check (an agent that is online with no phone), which is shaped exactly as the
 * platform answers it. A front server forwards everything else.
 * Ports: 6430 front (the address the browser uses), 6431 platform.
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/ux-explain-ui.test.ts
 * Set UXD_SHOTS=<folder> to also write screenshots.
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
import { MISSING_API_TOKEN_REASON } from "../src/engine/evidence/failure-facts.js";
import { renderWithAdapter } from "../src/engine/frameworks/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { HealingStore } from "../src/platform/healing-store.js";
import { TERMINAL_STATES } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { addTest, seedProject, seedRun, type Seed } from "./fixtures/dashboard-seed.js";

const FRONT_PORT = 6430;
const PLATFORM_PORT = 6431;
const BASE = `http://127.0.0.1:${FRONT_PORT}`;
const ORIGIN = "http://127.0.0.1:6439";

let dataDir = "";
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let frontServer: http.Server;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let shop: Seed;
let second: Seed;
const ids: Record<string, string> = {};
const consoleErrors: string[] = [];

/** What the runner answers say when the front stands in for an online runner that has no phone. */
const runnerStandIn = { on: false };

async function front(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", BASE);
    const method = req.method ?? "GET";
    const json = (data: unknown) => void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(data));
    if (runnerStandIn.on && method === "GET") {
        if (/^\/api\/projects\/[^/]+\/agents$/.test(url.pathname)) {
            return json([
                {
                    id: "a1", name: "Maya’s laptop", version: "1.0.0", tokenId: "t1", os: "win32", arch: "x64", node: "v24", online: true, lastSeenAt: new Date().toISOString(), firstSeenAt: new Date().toISOString(), activeTasks: 0, concurrency: 1,
                    capabilities: { browsers: ["chromium"], android: { adb: true, devices: [], avds: [], state: "none", summary: "Android: no devices connected" } },
                },
            ]);
        }
        if (/^\/api\/projects\/[^/]+\/runner$/.test(url.pathname)) {
            return json({ runOn: "agent", agentId: "a1", status: "Runs on Maya’s laptop (online).", canRunWeb: true, canRunMobile: false, phones: { canRun: false, text: "Phone tests can’t run: it has no Android phone connected and no emulator set up." }, unavailableReason: null });
        }
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "connection", "content-length"].includes(k)) headers[k] = v;
    const upstream = await fetch(`http://127.0.0.1:${PLATFORM_PORT}${req.url}`, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : new Uint8Array(raw) });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" }).end(buf);
}

// ── seeding ─────────────────────────────────────────────────────────────────

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const apiSteps = [{ action: "request", method: "GET", path: "/api/products/1" }, { action: "assertResponse", check: "status", expected: 200 }];
const webSteps = [
    { action: "navigate", url: "/products/1" },
    { action: "click", locator: { by: "role", role: "button", value: "Add to cart" } },
    { action: "assert", check: "text", expected: "Added to the cart" },
];

interface Add {
    key: string;
    title: string;
    kind?: "api" | "web";
    type?: string;
    status: "VALIDATED" | "FAILED_VALIDATION" | "NEEDS_REVIEW" | "PENDING";
    reason?: string;
    steps?: unknown[];
    origin?: string;
    category?: string;
    tags?: string[];
    meta?: Record<string, unknown>;
    attempts?: number;
    description?: string;
    /** Executions, newest first. The failed ones carry the error of their failed step (index 1 unless `failedStep` says otherwise). */
    runs?: Array<{ status: "passed" | "failed"; error?: string; failedStep?: number }>;
}
function add(a: Add): string {
    const kind = a.kind ?? "api";
    const spec = TestSpecSchema.parse({
        testId: `${kind === "api" ? "API" : "WEB"}-${String(Object.keys(ids).length + 101)}`,
        title: a.title,
        kind,
        category: a.category ?? (kind === "api" ? "API" : "Shop pages"),
        type: a.type ?? "functional",
        priority: "high",
        description: a.description,
        tags: a.tags ?? [],
        steps: a.steps ?? (kind === "api" ? apiSteps : webSteps),
        source: { origin: a.origin ?? (kind === "api" ? "openapi" : "browser-agent") },
    });
    const framework = kind === "api" ? "playwright-api" : "playwright";
    const repo = platform.repo;
    const suite = repo.getOrCreateSuite(shop.projectId, spec.category, spec.category.toLowerCase().replace(/\W+/g, "-"));
    const id = repo.insertTest({ projectId: shop.projectId, suiteId: suite, jobId: null, spec, framework, validationStatus: "PENDING", ...(a.meta ? { meta: a.meta } : {}) });
    const script = renderWithAdapter(spec, framework, { baseUrl: ORIGIN });
    const scriptId = repo.addScript(id, { framework, filename: script.filename, content: script.content, hash: `h-${a.key}`, storagePath: `x/${a.key}`, executable: true });
    repo.updateTest(id, { validationStatus: a.status, reason: a.reason ?? null, attempts: a.attempts ?? 1 });
    (a.runs ?? []).slice().reverse().forEach((r, n, all) => {
        const attempt = n + 1;
        const failedStep = r.failedStep ?? 1;
        repo.addExecution({
            testId: id,
            scriptId,
            jobId: null,
            attempt,
            status: r.status,
            durationMs: 40,
            ...(r.error ? { error: r.error } : {}),
            startedAt: iso((all.length - n) * 60_000),
            steps: spec.steps.map((s, i) => ({ index: i, title: `step ${i + 1}`, status: r.status === "failed" && i === failedStep ? "failed" : "passed", ...(r.status === "failed" && i === failedStep && r.error ? { error: r.error } : {}) })),
        });
    });
    ids[a.key] = id;
    return id;
}

const STATUS_401 = "Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: 200\nReceived: 401";
const TEXT_MISMATCH = 'Error: expect(locator).toContainText(expected)\n\nExpected substring: "Added to the cart"\nReceived string:    "Added"';

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-ux-explain-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    frontServer = http.createServer((req, res) => void front(req, res).catch((e) => res.writeHead(500).end(String(e))));
    await new Promise<void>((r) => frontServer.listen(FRONT_PORT, "127.0.0.1", r));

    shop = seedProject(platform, "Atlas shop", ORIGIN);
    second = seedProject(platform, "Second shop", "http://127.0.0.1:6438");

    // Provenance
    add({ key: "openapi", title: "Read one product", status: "VALIDATED", meta: { endpoint: "GET /api/products/{id}" }, runs: [{ status: "passed" }] });
    add({
        key: "explored",
        title: "Add a product to the cart",
        kind: "web",
        status: "VALIDATED",
        meta: { model: "scripted-model", scenario: { title: "Cart", description: "A shopper puts a product in the cart and sees it confirmed", priority: "high", startPath: "/products/1", journey: "Checkout" }, explanation: "The cart badge changes after the click." },
        runs: [{ status: "passed" }],
    });
    ids["explored-journey"] = ids["explored"]!;
    add({ key: "plain", title: "Search for a mug", kind: "web", status: "VALIDATED", origin: "plain-english", meta: { model: "scripted-model", plain: { description: "Search for a mug and check that a result is listed" } }, runs: [{ status: "passed" }] });
    add({ key: "recorded", title: "Open the pricing page", kind: "web", status: "VALIDATED", origin: "recorded", runs: [{ status: "passed" }] });
    add({
        key: "autofixed",
        title: "Add a mug to the cart",
        kind: "web",
        status: "VALIDATED",
        attempts: 2,
        runs: [{ status: "passed" }, { status: "failed", error: "locator.click: Timeout 5000ms exceeded.\n  waiting for getByRole('button', { name: 'Add to basket' })" }],
    });
    // Failures
    add({ key: "status-401", title: "Reads the cart", status: "FAILED_VALIDATION", reason: "The application did not behave as expected: " + STATUS_401, runs: [{ status: "failed", error: STATUS_401 }] });
    add({ key: "no-facts", title: "Lists the orders", status: "FAILED_VALIDATION", reason: "The application did not behave as expected: the page said something unusual", runs: [{ status: "failed", error: "Error: the page said something unusual" }] });
    add({ key: "text", title: "Cart shows a confirmation", kind: "web", status: "FAILED_VALIDATION", reason: "The application did not behave as expected: " + TEXT_MISMATCH, runs: [{ status: "failed", error: TEXT_MISMATCH, failedStep: 2 }] });
    add({ key: "token", title: "Reads the profile", status: "FAILED_VALIDATION", reason: MISSING_API_TOKEN_REASON, runs: [{ status: "failed", error: STATUS_401 }] });
    add({
        key: "finding",
        title: "Browser security headers are set",
        type: "security",
        origin: "security-check",
        category: "Security checks",
        tags: ["security"],
        status: "NEEDS_REVIEW",
        reason: "Security check failed:\n- [medium] The page does not send a Content-Security-Policy header",
        steps: [{ action: "request", method: "GET", path: "/" }, { action: "assertResponse", check: "securityHeaders" }],
        runs: [{ status: "failed", error: "Security check failed:\n- [medium] The page does not send a Content-Security-Policy header" }],
    });
    add({ key: "cart-controls", title: "Add a product to the cart through the API", status: "VALIDATED", steps: [{ action: "request", method: "POST", path: "/api/cart" }, { action: "assertResponse", check: "status", expected: 201 }], runs: [{ status: "passed" }] });
    // Repair
    const heal = add({ key: "heal", title: "Add to cart works", kind: "web", status: "FAILED_VALIDATION", reason: "The element couldn’t be found", runs: [{ status: "failed", error: "locator.click: Timeout 5000ms exceeded." }] });
    new HealingStore(platform.db).record(heal, null, {
        stepIndex: 1,
        oldLocator: { by: "role", role: "button", value: "Add to cart" },
        newLocator: { by: "role", role: "button", value: "Add to basket" },
        confidence: 0.9,
        confidenceLabel: "high",
        reason: "The button was renamed: the same place on the page now says “Add to basket”.",
        oldDescription: "the “Add to cart” button",
        newDescription: "the “Add to basket” button",
    });
    // Numbers
    addTest(platform, shop, "alpha");
    addTest(platform, shop, "beta");
    addTest(platform, shop, "gamma");
    await seedRun(platform, shop, { alpha: "pass", beta: "pass", gamma: "fail" }, { daysAgo: 1 });
    addTest(platform, second, "one");
    await seedRun(platform, second, { one: "pass" }, { daysAgo: 1 });

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
    page = await context.newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
}, 180_000);

afterAll(async () => {
    await browser?.close();
    // Live-update streams the page opened can keep a connection alive; end them so closing the servers cannot wait on them.
    frontServer?.closeAllConnections?.();
    frontServer?.close();
    server?.server?.closeAllConnections?.();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

// ── harness ─────────────────────────────────────────────────────────────────

const shots = process.env.UXD_SHOTS;
async function shot(name: string) {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
}
/** A fresh load of a page (a hash change alone would not re-run the page's loads). */
async function visit(hash: string) {
    await page.goto("about:blank");
    await page.goto(`${BASE}/${hash}`);
    await pwExpect(page.locator("h1").first()).toBeVisible();
}
const testHash = (key: string) => `#/tests/${ids[key]}`;
async function noOverflow() {
    const wide = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".content *"))
            .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !el.closest(".tabs") && !el.closest("pre"))
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
/** Audit in both colour schemes after the 400 ms settle. */
async function axeBoth(hash: string) {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await visit(hash);
        await page.waitForTimeout(400);
        await axe();
    }
    await page.emulateMedia({ colorScheme: null });
}
/** The text of the page's content area, without the tab strip, code and preformatted text. */
async function contentText(): Promise<string> {
    return page.evaluate(() => {
        const root = document.querySelector(".content")?.cloneNode(true) as HTMLElement | undefined;
        if (!root) return "";
        root.querySelectorAll(".tabs, pre, code, script, style").forEach((e) => e.remove());
        return root.textContent ?? "";
    });
}
/** Finish the project's queued job the way the worker would. */
function finishQueuedJobs() {
    for (const j of platform.repo.listJobs(shop.projectId)) if (!TERMINAL_STATES.includes(j.status)) platform.repo.setJobStatus(j.id, "COMPLETED");
}
const api = async (method: string, url: string, payload?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { "content-type": "application/json" }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    return { status: res.status, body: await res.json().catch(() => null) };
};

// ── tests ───────────────────────────────────────────────────────────────────

describe("where a test came from", () => {
    it("shows the title first and the test id as grey meta after the type, priority and kind", async () => {
        await visit(testHash("openapi"));
        await pwExpect(page.locator("h1")).toHaveText("Read one product");
        const meta = (await page.getByTestId("test-meta").textContent())!.replace(/\s+/g, " ").trim();
        expect(meta).toMatch(/^Functional\s*High priority\s*API\s*API-\d+$/);
        // The status badge is sentence case.
        await pwExpect(page.locator(".badge", { hasText: "Passing" })).toBeVisible();
        expect(await page.locator(".badge", { hasText: "Passing" }).evaluate((el) => getComputedStyle(el).textTransform)).toBe("none");
    });

    it("names the OpenAPI document and the endpoint, and nothing it was not told", async () => {
        await visit(testHash("openapi"));
        const line = page.getByTestId("origin-line");
        await pwExpect(line).toContainText("Created from the OpenAPI document");
        await pwExpect(line).toContainText("GET /api/products/{id}");
        await pwExpect(line).not.toContainText("model");
        await pwExpect(page.getByTestId("origin-strip").getByText("Why this test?")).toHaveCount(0);
        await pwExpect(page.getByTestId("origin-autofix")).toHaveCount(0);
    });

    it("says an exploration test was made by exploration, with the journey, the page, the model and a date, and explains it on request", async () => {
        await visit(testHash("explored"));
        const line = page.getByTestId("origin-line");
        await pwExpect(line).toContainText("Created by exploration");
        await pwExpect(line).toContainText("starting at /products/1");
        await pwExpect(line).toContainText("model scripted-model");
        await pwExpect(line).toContainText(new Date().toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }));
        await page.getByText("Why this test?", { exact: true }).click();
        await pwExpect(page.getByTestId("origin-why")).toContainText("A shopper puts a product in the cart and sees it confirmed");
        await pwExpect(page.getByTestId("origin-why")).toContainText("The cart badge changes after the click.");
        await pwExpect(page.getByTestId("origin-why")).toContainText("Functional test, high priority.");
        await shot("origin-explored-light-1280");
    });

    it("covers a test written from a description and one that was recorded", async () => {
        await visit(testHash("plain"));
        await pwExpect(page.getByTestId("origin-line")).toContainText("Written from your description");
        await visit(testHash("recorded"));
        await pwExpect(page.getByTestId("origin-line")).toContainText("Recorded in a browser");
    });

    it("lists what happened before a test passed on a later attempt, and says plainly that no step difference is kept", async () => {
        await visit(testHash("autofixed"));
        await pwExpect(page.getByTestId("origin-autofix")).toContainText("Auto-fixed during creation: it passed on attempt 2.");
        await page.getByText("What happened before it passed (1)").click();
        await pwExpect(page.getByTestId("origin-attempts")).toContainText("Attempt 1 did not pass");
        await pwExpect(page.getByTestId("origin-attempts")).toContainText("the element couldn’t be found in time");
        await pwExpect(page.getByText("no step-by-step difference to show")).toBeVisible();
        // The old "automatic correction" sentence is gone from the status callout.
        await pwExpect(page.getByText("It needed an automatic correction")).toHaveCount(0);
    });
});

describe("what failed", () => {
    it("shows the step in plain words with expected and got, and the actions that exist", async () => {
        await visit(testHash("status-401"));
        const box = page.getByTestId("failure-summary");
        await pwExpect(box.getByRole("heading", { name: "What failed" })).toBeVisible();
        await pwExpect(box.getByTestId("failure-step")).toContainText("Step 2");
        await pwExpect(box.getByTestId("failure-step")).toContainText("did not pass");
        await pwExpect(box.getByTestId("failure-facts")).toContainText("Expected");
        await pwExpect(box.getByTestId("failure-facts")).toContainText("HTTP 200");
        await pwExpect(box.getByTestId("failure-facts")).toContainText("Got");
        await pwExpect(box.getByTestId("failure-facts")).toContainText("HTTP 401");
        await pwExpect(box.getByRole("link", { name: "Edit steps", exact: true })).toHaveAttribute("href", `#/tests/${ids["status-401"]}/steps`);
        await pwExpect(box.getByRole("button", { name: "Switch to code", exact: true })).toBeVisible();
        await pwExpect(box.getByRole("button", { name: "Run this test again", exact: true })).toBeVisible();
        // Actions that do not apply are not offered: nothing to repair, nothing unreliable.
        await pwExpect(box.getByRole("button", { name: "Apply the repair" })).toHaveCount(0);
        await pwExpect(box.getByRole("button", { name: /quarantine/i })).toHaveCount(0);
        // The stale advice is gone.
        await pwExpect(page.getByText(/import it again/i)).toHaveCount(0);
        await shot("failing-light-1280");
    });

    it("says what the page showed for a text check, in the step's own plain words", async () => {
        await visit(testHash("text"));
        const box = page.getByTestId("failure-summary");
        await pwExpect(box.getByTestId("failure-step")).toContainText("Step 3");
        await pwExpect(box.getByTestId("failure-step")).toContainText("Check that the page contains “Added to the cart”");
        await pwExpect(box.getByTestId("failure-facts")).toContainText("Added to the cart");
        await pwExpect(box.getByTestId("failure-facts")).toContainText("Added");
    });

    it("falls back to the message the run stored when there are no expected and actual values", async () => {
        await visit(testHash("no-facts"));
        const box = page.getByTestId("failure-summary");
        await pwExpect(box.getByTestId("failure-facts")).toHaveCount(0);
        await pwExpect(page.locator(".callout", { hasText: "This test is failing" })).toContainText("the page said something unusual");
        await pwExpect(box.getByRole("button", { name: "Run this test again", exact: true })).toBeVisible();
    });

    it("names a missing API token as the cause and links to where it is added", async () => {
        await visit(testHash("token"));
        const box = page.getByTestId("failure-summary");
        await pwExpect(box.getByTestId("failure-cause")).toContainText("No API token is saved for this project.");
        await pwExpect(box.getByTestId("failure-step")).toHaveCount(0);
        await pwExpect(box.getByRole("link", { name: "Add an API token" })).toHaveAttribute("href", new RegExp(`#/new\\?project=${shop.projectId}`));
    });

    it("keeps a finding a finding: it needs a look, with its severity and one sentence of what that means", async () => {
        await visit(testHash("finding"));
        await pwExpect(page.locator(".badge", { hasText: "Needs a look" })).toBeVisible();
        await pwExpect(page.getByText("This test found something that needs a look")).toBeVisible();
        await pwExpect(page.getByTestId("failure-summary").getByRole("heading", { name: "What was found" })).toBeVisible();
        await pwExpect(page.getByText("not a broken test")).toBeVisible();
    });

    it("offers “Run again” from the summary and it starts a run", async () => {
        await visit(testHash("status-401"));
        await page.getByTestId("failure-summary").getByRole("button", { name: "Run this test again", exact: true }).click();
        await pwExpect.poll(() => platform.repo.listJobs(shop.projectId).some((j) => !TERMINAL_STATES.includes(j.status))).toBe(true);
        finishQueuedJobs();
        await pwExpect(page.getByRole("button", { name: "Run again" }).first()).toBeEnabled({ timeout: 15_000 });
    });

    it("opens the dialog that says what stops when a generated test is switched to code, and can be left", async () => {
        await visit(testHash("status-401"));
        await page.getByTestId("failure-summary").getByRole("button", { name: "Switch to code", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Switch this test to code?" });
        await pwExpect(dialog).toBeVisible();
        await pwExpect(dialog.getByRole("button", { name: "Switch to code", exact: true })).toBeVisible();
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await pwExpect(dialog).toHaveCount(0);
    });
});

describe("Term: a word with its explanation one press away", () => {
    it("opens with Enter, stays open, closes with Escape, and is reachable with the keyboard", async () => {
        await visit(testHash("finding"));
        const term = page.getByRole("button", { name: /^finding/ });
        await term.focus();
        await pwExpect(term).toHaveAttribute("aria-expanded", "false");
        await page.keyboard.press("Enter");
        await pwExpect(term).toHaveAttribute("aria-expanded", "true");
        const note = page.getByRole("note");
        await pwExpect(note).toContainText("Something the test noticed that may be a problem in your application");
        // Not hover-only: the note stays while the pointer is somewhere else.
        await page.mouse.move(5, 5);
        await pwExpect(note).toBeVisible();
        await page.keyboard.press("Escape");
        await pwExpect(term).toHaveAttribute("aria-expanded", "false");
        await pwExpect(note).toHaveCount(0);
        await pwExpect(term).toBeFocused();
        // A press anywhere else closes it too.
        await term.click();
        await pwExpect(note).toBeVisible();
        await page.locator("h1").click();
        await pwExpect(note).toHaveCount(0);
    });
});

describe("the script shows the test first", () => {
    it("folds the platform's setup code behind one line and still copies the whole script", async () => {
        await visit(testHash("explored"));
        // the script sits in the results column of the Steps tab: no button to open it
        const preview = page.getByTestId("script-preview");
        await pwExpect(preview).toBeVisible();
        const first = preview.locator("pre.code").first();
        await pwExpect(first).toContainText("test(");
        await pwExpect(first).not.toContainText("EVIDENCE_MAX_REQUESTS");
        const summary = preview.getByText(/^Show setup code \(\d+ lines\)$/);
        await pwExpect(summary).toBeVisible();
        const lines = Number(/\((\d+) lines\)/.exec((await summary.textContent())!)![1]);
        expect(lines).toBeGreaterThanOrEqual(20);
        // Closed: the setup code is in the page but not shown.
        const setup = preview.locator("details pre.code");
        await pwExpect(setup).toBeHidden();
        await summary.click();
        await pwExpect(setup).toBeVisible();
        await pwExpect(setup).toContainText("EVIDENCE_MAX_REQUESTS");
        // Copy (the first one, next to the test) copies the whole script.
        await preview.getByRole("button", { name: "Copy" }).first().click();
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        expect(copied).toContain("EVIDENCE_MAX_REQUESTS");
        expect(copied).toContain("test(");
        expect(copied.startsWith("// WEB-")).toBe(true);
        await shot("script-preview-light-1280");
    });

    it("an API script has a shorter setup and is folded the same way", async () => {
        await visit(testHash("openapi"));
        // the script sits in the results column of the Steps tab: no button to open it
        const preview = page.getByTestId("script-preview");
        await pwExpect(preview.locator("pre.code").first()).toContainText("test(");
        await pwExpect(preview.getByText(/^Show setup code \(\d+ lines\)$/)).toBeVisible();
    });
});

describe("compliance only where it says something", () => {
    it("puts the controls of a security test behind a Compliance line that says why", async () => {
        const controls = (await api("GET", `/api/tests/${ids["finding"]}`)).body.controls as unknown[];
        expect(controls.length).toBeGreaterThan(0);
        await visit(testHash("finding"));
        await pwExpect(page.getByText("Relevant controls")).toHaveCount(0);
        await page.getByText("Compliance", { exact: true }).click();
        await pwExpect(page.getByTestId("controls")).toContainText("This test maps to these controls, so it counts as evidence for them");
    });

    it("shows nothing about controls on a cart test, even though the platform maps some", async () => {
        const controls = (await api("GET", `/api/tests/${ids["cart-controls"]}`)).body.controls as unknown[];
        expect(controls.length).toBeGreaterThan(0);
        await visit(testHash("cart-controls"));
        await pwExpect(page.getByText("Compliance", { exact: true })).toHaveCount(0);
        await pwExpect(page.getByText("Relevant controls")).toHaveCount(0);
        await pwExpect(page.getByTestId("controls")).toHaveCount(0);
    });
});

describe("less noise", () => {
    it("shows one line and one action, not a card, when no issue tracker is connected", async () => {
        await visit(testHash("status-401"));
        const line = page.getByTestId("issue-empty");
        await pwExpect(line).toContainText("No issue tracker is connected");
        await pwExpect(line.getByRole("link")).toHaveCount(1);
        await pwExpect(page.getByRole("heading", { name: "Issue tracker" })).toHaveCount(0);
        await pwExpect(page.getByText(/Want this in your issue tracker/)).toHaveCount(0);
    });

    it("does not show the site-memory card until something is remembered", async () => {
        await visit(`#/projects/${shop.projectId}`);
        await pwExpect(page.getByRole("heading", { name: "Result", exact: false }).first().or(page.locator("h1").first())).toBeVisible();
        await page.waitForTimeout(500);
        await pwExpect(page.getByTestId("site-memory")).toHaveCount(0);
        await pwExpect(page.getByText("What we remember about this site")).toHaveCount(0);
    });
});

describe("a repair can be seen and undone", () => {
    it("says what changed after Apply, offers Undo, and Undo puts the old way of finding the element back as a saved version", async () => {
        await visit(testHash("heal"));
        const card = page.getByTestId("healing-suggestion");
        await pwExpect(card).toContainText("We found a likely replacement for the “Add to cart” button");
        await card.getByRole("button", { name: "Apply and run again" }).click();
        // The real apply route started a run; no worker runs here, so finish it the way the worker would.
        await pwExpect.poll(() => platform.repo.listJobs(shop.projectId).some((j) => !TERMINAL_STATES.includes(j.status))).toBe(true);
        finishQueuedJobs();
        const applied = page.getByTestId("healing-applied");
        await pwExpect(applied).toBeVisible({ timeout: 20_000 });
        await pwExpect(applied.getByRole("heading", { name: "Repair applied" })).toBeVisible();
        await pwExpect(applied).toContainText("the “Add to cart” button is now found as the “Add to basket” button");
        await pwExpect(applied).toContainText("Only that step changed.");
        await applied.getByText("See what changed").click();
        await pwExpect(applied.getByRole("group", { name: "What changed" })).toContainText("button called “Add to cart”");
        await pwExpect(applied.getByRole("group", { name: "What changed" })).toContainText("button called “Add to basket”");
        expect((await api("GET", `/api/tests/${ids["heal"]}/spec`)).body.spec.steps[1].locator.value).toBe("Add to basket");
        await shot("repair-applied-light-1280");

        await applied.getByRole("button", { name: "Undo this repair" }).click();
        await pwExpect.poll(async () => (await api("GET", `/api/tests/${ids["heal"]}/spec`)).body.spec.steps[1].locator.value, { timeout: 20_000 }).toBe("Add to cart");
        finishQueuedJobs();
        await pwExpect(page.getByText("Repair undone")).toBeVisible({ timeout: 20_000 });
        // Only that step went back, and the undo is in the test's history like any other edit.
        const spec = (await api("GET", `/api/tests/${ids["heal"]}/spec`)).body.spec;
        expect(spec.steps).toHaveLength(3);
        expect(spec.steps[2].expected).toBe("Added to the cart");
        const versions = (await api("GET", `/api/tests/${ids["heal"]}/spec-versions`)).body as Array<{ note: string | null }>;
        expect(versions.some((v) => /Undid the repair of the “Add to cart” button/.test(v.note ?? ""))).toBe(true);
        // The script was made again from the restored steps.
        const script = (await api("GET", `/api/tests/${ids["heal"]}`)).body.scripts[0].content as string;
        expect(script).toContain("Add to cart");
        expect(script).not.toContain("Add to basket");
    });
});

describe("honest numbers on screen", () => {
    it("the projects dashboard states what its pass rate is made of", async () => {
        // Round 37: the fleet view is on the Dashboard; the Projects page is the plain list.
        await visit("#/dashboard");
        // The dashboard first shows "Checking every project…": wait for the sentence before reading the page text.
        await pwExpect(page.getByText(/Last run: 2 of 3 tests that ran passed/)).toBeVisible();
        const text = await contentText();
        expect(text).toMatch(/Last run: 2 of 3 tests that ran passed, 1 could not be run/);
        expect(text).not.toMatch(/\d+% of the tests that ran passed in the last run/);
        expect(text).toMatch(/tests passing/);
        await shot("dashboard-light-1280");
    });

    it("the release page repeats the sentence and does not say “Release” twice", async () => {
        const made = await api("POST", `/api/projects/${shop.projectId}/releases`, { name: "Release 1.4" });
        expect(made.status).toBe(201);
        await visit(`#/projects/${shop.projectId}/releases/${made.body.id}`);
        await pwExpect(page.getByTestId("rel-last-run")).toContainText("2 of 3 tests that ran passed");
        const view = (await api("GET", `/api/projects/${shop.projectId}/releases/${made.body.id}`)).body;
        expect([view.name, view.sentence]).toEqual(["Release 1.4", expect.stringMatching(/^Release Release 1\.4: /)]);
        const sentence = (await page.getByTestId("release-sentence").textContent())!;
        expect(sentence).toMatch(/^Release 1.4: /);
        expect(sentence).not.toMatch(/Release Release/);
    });

    it("the runner card and the phone setting say the same thing, in the platform's words", async () => {
        runnerStandIn.on = true;
        try {
            await visit(`#/projects/${shop.projectId}/runners`);
            await pwExpect(page.getByTestId("runner-phones")).toHaveText("Phone tests can’t run: it has no Android phone connected and no emulator set up.");
            await pwExpect(page.getByTestId("agent-capabilities")).toContainText("Android: no devices connected");
            await pwExpect(page.getByText("Phone tests cannot run")).toBeVisible();
            await pwExpect(page.getByText("Phone tests can run")).toHaveCount(0);
        } finally {
            runnerStandIn.on = false;
        }
    });
});

describe("the decided vocabulary, on the screens a tester reaches", () => {
    // Words the tester should no longer meet. The tab strip is left out (it belongs to the navigation work) and so is code.
    const RETIRED = /(?<!could not be )\bvalidated\b|\bvalidation failed\b|\bneeds review\b|\bnot yet validated\b|\bre-validation\b|\banaly[sz](is|e|ed)\b|\bhand-written\b|\btake over\b|\brunner agents?\b|\brunbooks?\b|\bmake shared\b|\bshared locators?\b|\bscenarios?\b|\bspecification\b/i;
    const screens: Array<[string, () => string]> = [
        ["a passing test", () => testHash("openapi")],
        ["an exploration test", () => testHash("explored")],
        ["an auto-fixed test", () => testHash("autofixed")],
        ["a failing test", () => testHash("status-401")],
        ["a web test that failed on text", () => testHash("text")],
        ["a test that needs a look", () => testHash("finding")],
        ["a test with a repair suggestion", () => testHash("heal")],
        ["the projects dashboard", () => "#/"],
        ["the shared elements page", () => `#/projects/${shop.projectId}/objects`],
        ["the runners page", () => `#/projects/${shop.projectId}/runners`],
        ["the schedule page", () => `#/projects/${shop.projectId}/schedule`],
        ["the new project page", () => "#/new"],
        ["explore again", () => `#/new?project=${shop.projectId}`],
    ];
    for (const [name, hash] of screens) {
        it(`${name} uses none of the retired words`, async () => {
            await visit(hash());
            await page.waitForTimeout(500);
            const text = await contentText();
            expect(text.length).toBeGreaterThan(40);
            const hit = RETIRED.exec(text);
            expect(hit ? text.slice(Math.max(0, hit.index - 60), hit.index + 60) : null, `retired word on ${name}`).toBeNull();
        });
    }

    it("a test page uses the decided status words", async () => {
        for (const [key, label] of [["openapi", "Passing"], ["status-401", "Failing"], ["finding", "Needs a look"]] as const) {
            await visit(testHash(key));
            await pwExpect(page.locator(".page-head .badge", { hasText: label }).first()).toBeVisible();
        }
    });
});

describe("accessible and usable on a phone", () => {
    it("failing test: axe-clean in light and dark", async () => {
        await axeBoth(testHash("status-401"));
        await axeBoth(testHash("finding"));
        await axeBoth(testHash("openapi"));
    });

    it("with a repair applied and with the Term note open: axe-clean in light and dark", async () => {
        await axeBoth(testHash("heal"));
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await visit(testHash("finding"));
            await page.waitForTimeout(400);
            await page.getByRole("button", { name: /^finding/ }).click();
            await pwExpect(page.getByRole("note")).toBeVisible();
            await axe();
        }
        await page.emulateMedia({ colorScheme: null });
    });

    it("375 px: nothing scrolls sideways and every button of the failure summary is at least 44 px tall", async () => {
        await page.setViewportSize({ width: 375, height: 800 });
        try {
            for (const key of ["status-401", "token", "finding", "autofixed", "heal", "openapi"]) {
                await visit(testHash(key));
                await page.waitForTimeout(300);
                await noOverflow();
            }
            await visit(testHash("status-401"));
            const small = await page.evaluate(() =>
                Array.from(document.querySelectorAll<HTMLElement>(".fail-acts .btn, .fail-files .chip"))
                    .map((el) => ({ n: el.textContent?.trim(), h: Math.round(el.getBoundingClientRect().height) }))
                    .filter((x) => x.h < 44),
            );
            expect(small).toEqual([]);
            await shot("failing-light-375");
            await page.emulateMedia({ colorScheme: "dark" });
            await visit(testHash("status-401"));
            await page.waitForTimeout(400);
            await shot("failing-dark-375");
        } finally {
            await page.emulateMedia({ colorScheme: null });
            await page.setViewportSize({ width: 1280, height: 900 });
        }
    });

    it("screenshots of the pages the audit named, in light and dark (only when UXD_SHOTS is set)", async () => {
        if (!shots) return;
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            for (const [name, hash] of [["failing", testHash("status-401")], ["passing", testHash("openapi")], ["finding", testHash("finding")], ["dashboard", "#/"]] as const) {
                await visit(hash);
                await page.waitForTimeout(400);
                await shot(`${name}-${scheme}-1280`);
            }
        }
        await page.emulateMedia({ colorScheme: null });
    });

    it("never logged an error in the console", () => {
        expect(consoleErrors).toEqual([]);
    });
});
