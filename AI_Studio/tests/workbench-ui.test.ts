/**
 * The test workbench in a real browser against a real platform (worker, sample app, real runs): one page per test with Steps, Text,
 * Code and History as tabs (and routes), the last run always in view, Save and Save and run apart, an unsaved bar with a preview,
 * Undo, text for every generated test, the way to code and back, one history, alias routes, read-only states, the keyboard tab
 * strip, a phone, both colour schemes. Ports: 6470 sample app, 6471 platform (it serves web/dist too).
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/workbench-ui.test.ts
 * Set WORKBENCH_SHOTS=<folder> to also write screenshots (light and dark, 1280 and 390 wide).
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

const APP_PORT = 6470;
const PORT = 6471;
const APP = `http://127.0.0.1:${APP_PORT}`;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DONE = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];

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
let stuckId = "";
let codeId = "";
let plainId = "";
const consoleErrors: string[] = [];

const api = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never, headers: payload !== undefined ? { "content-type": "application/json" } : {} });
    return { status: res.statusCode, body: res.body && (res.body.startsWith("{") || res.body.startsWith("[")) ? JSON.parse(res.body) : res.body };
};
async function waitJob(jobId: string) {
    for (let i = 0; i < 300; i++) {
        const j = (await api("GET", `/api/test-generation/${jobId}`)).body;
        if (DONE.includes(j.status)) return j;
        await sleep(400);
    }
    throw new Error("a job did not finish");
}
const runAndWait = async (id: string) => waitJob((await api("POST", `/api/tests/${id}/validate`)).body.jobId);
const specNow = async (id = webId) => (await api("GET", `/api/tests/${id}/spec`)).body;

const searchSpec = {
    title: "Search finds products",
    kind: "web",
    category: "Shop",
    priority: "high",
    steps: [
        { action: "navigate", url: "/products" },
        { action: "fill", locator: { by: "label", value: "Search products" }, value: "boot" },
        { action: "click", locator: { by: "role", role: "button", value: "Search" } },
        { action: "assert", check: "text", expected: "products" },
    ],
};
// a step with a setting no text phrase has: the text shows the closest version and says so
const stuckSpec = { title: "Accessibility with a number", kind: "web", category: "Shop", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "a11y", expected: 100 }] };
const apiSpec = { title: "List products answers", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/api/products" }, { action: "assertResponse", check: "status", expected: 200 }] };
const plainSpec = { title: "Orders answer", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/api/products" }, { action: "assertResponse", check: "status", expected: 200 }, { action: "assertResponse", check: "bodyContains", expected: "products" }] };

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
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-workbench-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0", HOST: "127.0.0.1", PORT: String(PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 200);
    worker.start();

    projectId = (await api("POST", "/api/projects", { name: "Atlas shop" })).body.id;
    const imp = await api("POST", `/api/projects/${projectId}/specs`, { specs: [searchSpec, stuckSpec, apiSpec, plainSpec], baseUrl: APP, validate: false });
    expect(imp.status).toBe(202);
    [webId, stuckId, codeId, plainId] = imp.body.tests.map((t: { id: string }) => t.id);
    expect((await api("POST", `/api/tests/${codeId}/take-over`, { confirm: true })).status).toBe(200);
    // the search test passes once before anything is edited, so a later failure has an earlier success to compare with
    expect((await runAndWait(webId)).status).not.toBe("FAILED");
    expect((await api("GET", `/api/tests/${webId}`)).body.validationStatus).toBe("VALIDATED");

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
}, 240_000);

afterAll(async () => {
    await browser?.close();
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    sample?.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const shots = process.env.WORKBENCH_SHOTS;
async function shot(name: string) {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
}
async function visit(hash: string) {
    await page.goto("about:blank");
    await page.goto(`${BASE}/${hash}`);
}
const tab = (name: string) => page.getByRole("tab", { name, exact: true });
const heads = () => page.locator(".bld-head");
const headTexts = async () => (await heads().allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
const bar = () => page.getByTestId("unsaved-bar");
const editor = () => page.getByRole("textbox", { name: "Test text", exact: true });
const lines = async () => page.locator(".cm-line").evaluateAll((els) => els.map((e) => e.textContent ?? ""));
const textNow = async () => (await lines()).join("\n");
async function writeText(text: string) {
    await editor().click();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    const rows = text.split("\n");
    for (let i = 0; i < rows.length; i++) {
        if (rows[i]) await page.keyboard.insertText(rows[i]!);
        if (i < rows.length - 1) await page.keyboard.press("Enter");
    }
}
async function noOverflow() {
    const wide = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".content *"))
            .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !el.closest(".code-wrap") && !el.closest(".cm-scroller") && !el.closest(".wb-tabs") && !el.closest("[data-testid=page-evidence]"))
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
async function axeBoth(name: string, setup: () => Promise<void> = async () => undefined) {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(400);
        await setup();
        await shot(`${name}-${scheme}-1280`);
        await axe();
    }
    await page.emulateMedia({ colorScheme: null });
}

describe("one page per test", () => {
    it("opens on Steps with the steps, the generated script beside them and the last run's marks", async () => {
        await visit(`#/tests/${webId}`);
        await pwExpect(page.getByRole("heading", { level: 1, name: "Search finds products" })).toBeVisible();
        await pwExpect(tab("Steps")).toHaveAttribute("aria-selected", "true");
        await pwExpect(page.getByTestId("test-meta")).toContainText("Web");
        // the header says the verdict in the decided words
        await pwExpect(page.locator(".page-head").getByText("Passing", { exact: true })).toBeVisible();
        // the steps, each with the mark the last run left
        expect(await headTexts()).toEqual([expect.stringContaining("Step 1 Open /products"), expect.stringContaining("Step 2 Type"), expect.stringContaining("Step 3 Click"), expect.stringContaining("Step 4")]);
        await pwExpect(page.getByTestId("step-mark")).toHaveCount(4);
        expect(await page.getByTestId("step-mark").evaluateAll((els) => els.map((e) => e.getAttribute("data-status")))).toEqual(["passed", "passed", "passed", "passed"]);
        // the script is on the right, the test first, the platform's setup folded
        const rail = page.getByRole("complementary", { name: "Results and script" });
        await pwExpect(rail.locator("pre.code").first()).toContainText("page.goto");
        await pwExpect(rail.getByText(/^Show setup code \(\d+ lines\)$/)).toBeVisible();
        await pwExpect(rail.getByText("This test is passing")).toBeVisible();
        // the page says where it came from, and the compliance noise is not on a plain test
        await pwExpect(page.getByTestId("origin-strip")).toBeVisible();
        await pwExpect(page.getByRole("heading", { name: "What this test checks" })).toBeVisible();
        // the script sits to the right of the steps on a wide screen
        const [steps, script] = await Promise.all([page.locator(".bld-steps").boundingBox(), rail.locator("pre.code").first().boundingBox()]);
        expect(script!.x).toBeGreaterThan(steps!.x + steps!.width - 1);
    });

    it("keeps the old routes working: /builder is the Steps tab and /code the Code tab", async () => {
        await visit(`#/tests/${webId}/builder`);
        await pwExpect(tab("Steps")).toHaveAttribute("aria-selected", "true");
        await pwExpect(page.locator(".bld-head").first()).toBeVisible();
        expect(page.url()).toContain(`#/tests/${webId}/steps`);
        expect(page.url()).not.toContain("/builder");
        await visit(`#/tests/${webId}/code`);
        await pwExpect(tab("Code")).toHaveAttribute("aria-selected", "true");
        await pwExpect(page.getByRole("heading", { name: "Script", exact: true })).toBeVisible();
        // tabs are routes: Back goes to the tab before
        await tab("History").click();
        await pwExpect(page).toHaveURL(new RegExp(`#/tests/${webId}/history$`));
        await page.goBack();
        await pwExpect(tab("Code")).toHaveAttribute("aria-selected", "true");
    });

    it("has a real tablist that arrow keys, Home and End move through (DSL and Code first)", async () => {
        await visit(`#/tests/${webId}/steps`);
        await pwExpect(page.getByRole("tablist", { name: "Views of this test" })).toBeVisible();
        await pwExpect(page.getByRole("tablist", { name: "Views of this test" }).getByRole("tab")).toHaveText(["DSL", "Code", "Steps", "History"]);
        await pwExpect(tab("Steps")).toHaveAttribute("tabindex", "0");
        await pwExpect(tab("DSL")).toHaveAttribute("tabindex", "-1");
        await tab("Steps").focus();
        await page.keyboard.press("ArrowLeft");
        await pwExpect(tab("Code")).toHaveAttribute("aria-selected", "true");
        await pwExpect(tab("Code")).toBeFocused();
        await pwExpect(page).toHaveURL(new RegExp(`#/tests/${webId}/code$`));
        await page.keyboard.press("End");
        await pwExpect(tab("History")).toHaveAttribute("aria-selected", "true");
        await pwExpect(tab("History")).toBeFocused();
        await pwExpect(page).toHaveURL(new RegExp(`#/tests/${webId}/history$`));
        // arrow keys wrap around
        await page.keyboard.press("ArrowRight");
        await pwExpect(tab("DSL")).toHaveAttribute("aria-selected", "true");
        await pwExpect(tab("DSL")).toBeFocused();
        await pwExpect(page).toHaveURL(new RegExp(`#/tests/${webId}/text$`));
        await page.keyboard.press("ArrowLeft");
        await pwExpect(tab("History")).toHaveAttribute("aria-selected", "true");
        await pwExpect(tab("History")).toBeFocused();
        await page.keyboard.press("Home");
        await pwExpect(tab("DSL")).toHaveAttribute("aria-selected", "true");
        await pwExpect(tab("DSL")).toBeFocused();
        await tab("Steps").click();
        // the panel is named by its tab
        await pwExpect(page.getByRole("tabpanel", { name: "Steps" })).toBeVisible();
    });
});

describe("unsaved changes, Save and Save and run", () => {
    it("counts the changes, previews them step by step and discards after asking", async () => {
        await visit(`#/tests/${webId}/steps`);
        await pwExpect(bar()).toHaveCount(0);
        await heads().nth(1).click();
        await page.getByLabel("Text to type", { exact: true }).fill("alpenglow");
        await pwExpect(bar()).toContainText("1 unsaved change");
        await pwExpect(bar().getByRole("button", { name: "Save", exact: true })).toBeEnabled();
        await pwExpect(bar().getByRole("button", { name: "Save and run", exact: true })).toBeEnabled();
        // a second change
        await page.getByRole("button", { name: "Delete step 4", exact: true }).click();
        await pwExpect(bar()).toContainText("2 unsaved changes");
        await bar().getByRole("button", { name: "Preview changes", exact: true }).click();
        const diff = page.getByTestId("step-diff");
        await pwExpect(diff).toContainText("1 step changed");
        await pwExpect(diff).toContainText("1 step removed");
        await pwExpect(diff).toContainText("boot");
        await pwExpect(diff).toContainText("alpenglow");
        // the stored test is untouched until a save
        expect((await specNow()).spec.steps[1].value).toBe("boot");
        await bar().getByRole("button", { name: "Discard changes", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Discard your changes?" });
        await dialog.getByRole("button", { name: "Keep editing", exact: true }).click();
        await pwExpect(bar()).toBeVisible();
        await bar().getByRole("button", { name: "Discard changes", exact: true }).click();
        await dialog.getByRole("button", { name: "Discard changes", exact: true }).click();
        await pwExpect(bar()).toHaveCount(0);
        expect(await headTexts()).toHaveLength(4);
    });

    it("the unsaved bar stays when another tab is open, and a link asks before it throws the work away", async () => {
        await heads().nth(1).click();
        await page.getByLabel("Text to type", { exact: true }).fill("alpenglow");
        await tab("History").click();
        await pwExpect(page.getByRole("heading", { name: "Everything that happened to this test" })).toBeVisible();
        await pwExpect(bar()).toContainText("1 unsaved change");
        await tab("Steps").click();
        await pwExpect(page.getByLabel("Text to type", { exact: true })).toHaveValue("alpenglow");
        // a link to another page asks first
        await page.getByRole("link", { name: "Test scripts", exact: true }).first().click();
        const dialog = page.getByRole("dialog", { name: "Leave without saving?" });
        await pwExpect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Stay and keep editing", exact: true }).click();
        expect(await page.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })).toBe(true);
    });

    it("Save stores a version and runs nothing; the bar says so and Undo takes it back", async () => {
        await bar().getByRole("button", { name: "Save", exact: true }).click();
        const saved = page.getByTestId("saved-bar");
        await pwExpect(saved).toContainText(/Saved version [0-9]+[.]/);
        await pwExpect(saved).toContainText("has not been run");
        await pwExpect(bar()).toHaveCount(0);
        const s = await specNow();
        expect(s.spec.steps[1].value).toBe("alpenglow");
        expect(s.validationStatus).toBe("PENDING");
        // the header and the results say it has not run since
        await pwExpect(page.locator(".page-head").getByText("Not run yet", { exact: true })).toBeVisible();
        await saved.getByRole("button", { name: "Undo", exact: true }).click();
        await pwExpect(saved).toContainText(/Went back to version [0-9]+[.]/, { timeout: 20_000 });
        expect((await specNow()).spec.steps[1].value).toBe("boot");
        await pwExpect(heads().nth(1)).toContainText("boot");
    });
});

describe("the Text tab", () => {
    it("shows the same test as text, keeps unsaved steps when it reads, and says plainly when it does not", async () => {
        await visit(`#/tests/${webId}/steps`);
        await heads().nth(1).click();
        await page.getByLabel("Text to type", { exact: true }).fill("alpenglow");
        await tab("DSL").click();
        await pwExpect(tab("DSL")).toHaveAttribute("aria-selected", "true");
        await pwExpect(editor()).toBeVisible({ timeout: 15_000 });
        expect(await textNow()).toContain('Type "alpenglow" into the "Search products" field');
        await pwExpect(bar()).toContainText("unsaved change");
        // text that reads comes back as steps
        await writeText((await textNow()) + 'Expect the page title to contain "Products"\n');
        await pwExpect(page.getByText("No problems found.")).toBeVisible({ timeout: 10_000 });
        await tab("Steps").click();
        await pwExpect(tab("Steps")).toHaveAttribute("aria-selected", "true");
        expect(await headTexts()).toHaveLength(5);
        // text that does not read stays where it is, names the line, and the route does not move
        await tab("DSL").click();
        await pwExpect(editor()).toBeVisible({ timeout: 15_000 });
        await writeText((await textNow()).replace('Click the "Search" button', 'Frobnicate the "Search" button'));
        await tab("Steps").click();
        await pwExpect(page.getByText("The text does not read yet", { exact: true })).toBeVisible();
        await pwExpect(tab("DSL")).toHaveAttribute("aria-selected", "true");
        await pwExpect(page).toHaveURL(new RegExp(`#/tests/${webId}/text$`));
        await shot("text-blocked");
        await page.getByRole("button", { name: "Discard the text and show the steps", exact: true }).click();
        await pwExpect(tab("Steps")).toHaveAttribute("aria-selected", "true");
        // back to how the stored test was for the next tests
        await bar().getByRole("button", { name: "Discard changes", exact: true }).click();
        await page.getByRole("dialog", { name: "Discard your changes?" }).getByRole("button", { name: "Discard changes", exact: true }).click();
        await pwExpect(bar()).toHaveCount(0);
    });

    it("never refuses to show a test: a step with no phrase becomes a marked line and Save explains why it is off", async () => {
        await visit(`#/tests/${stuckId}/text`);
        await pwExpect(editor()).toBeVisible({ timeout: 15_000 });
        expect(await textNow()).toContain("# not expressible: step 2");
        await pwExpect(page.getByText("Part of this test has no text form.", { exact: false })).toBeVisible();
        await pwExpect(page.getByRole("list", { name: "What has no text form" })).toContainText("Step 2");
        await pwExpect(page.getByText("Read-only", { exact: true })).toBeVisible();
        // two ways on, never a dead end
        await pwExpect(page.getByRole("button", { name: "Edit the steps", exact: true })).toBeVisible();
        await pwExpect(page.getByRole("button", { name: "Switch to code", exact: true })).toBeVisible();
        await pwExpect(page.getByText("Saving the text would lose the steps it cannot show, so Save is off here.", { exact: false })).toBeVisible();
        await page.getByRole("button", { name: "Edit the steps", exact: true }).click();
        await pwExpect(tab("Steps")).toHaveAttribute("aria-selected", "true");
        await pwExpect(page.locator(".bld-head").first()).toBeVisible();
        await tab("DSL").click();
        await page.getByRole("button", { name: "Switch to code", exact: true }).click();
        await pwExpect(page.getByRole("dialog", { name: "Switch this test to code?" })).toBeVisible();
        await page.keyboard.press("Escape");
    });

    it("a plain generated test opens in Text and saves from there, with Save and Save and run apart", async () => {
        await visit(`#/tests/${plainId}/text`);
        await pwExpect(editor()).toBeVisible({ timeout: 15_000 });
        expect(await textNow()).toContain("Send a GET request to /api/products");
        await pwExpect(page.getByText("Part of this test has no text form.", { exact: false })).toHaveCount(0);
        await writeText((await textNow()).replace("/api/products", "/api/products?limit=2"));
        await pwExpect(page.getByText("No problems found.")).toBeVisible({ timeout: 10_000 });
        await pwExpect(bar()).toContainText("unsaved change");
        await bar().getByRole("button", { name: "Preview changes", exact: true }).click();
        await pwExpect(page.getByTestId("diff")).toContainText("limit=2");
        await bar().getByRole("button", { name: "Save", exact: true }).click();
        await pwExpect(page.getByTestId("saved-bar")).toContainText("has not been run", { timeout: 20_000 });
        expect((await specNow(plainId)).spec.steps[0].path).toBe("/api/products?limit=2");
        expect((await specNow(plainId)).validationStatus).toBe("PENDING");
        // after the save the text is shown again from what was saved
        await pwExpect(editor()).toBeVisible();
        await pwExpect(bar()).toHaveCount(0);
    });
});

describe("a failing run, in view", () => {
    it("Save and run shows the result on the same page: the failing step, expected and got, and a way back", async () => {
        await visit(`#/tests/${webId}/steps`);
        await heads().nth(3).click();
        await page.getByLabel("Text it should contain", { exact: true }).fill("no such words anywhere");
        await bar().getByRole("button", { name: "Save and run", exact: true }).click();
        await pwExpect(page.getByTestId("saved-bar")).toContainText(/Saved version [0-9]+[.]/);
        // the live strip, then the verdict in the results column, without leaving the page
        await pwExpect(page.getByTestId("run-strip")).toBeVisible({ timeout: 30_000 });
        const rail = page.getByRole("complementary", { name: "Results and script" });
        await pwExpect(rail.getByText("This test is failing")).toBeVisible({ timeout: 90_000 });
        expect(page.url()).toContain(`#/tests/${webId}/steps`);
        const failure = rail.getByTestId("failure-summary");
        await pwExpect(failure).toContainText("Step 4");
        // what it expected is said in words, with the text the tester typed
        await pwExpect(failure).toContainText("no such words anywhere");
        // the failing step is marked and highlighted in the list, the others passed
        await pwExpect(page.locator(".bld-step.is-failed")).toHaveCount(1);
        await pwExpect(page.locator(".bld-step.is-failed")).toContainText("Step 4");
        expect(await page.getByTestId("step-mark").evaluateAll((els) => els.map((e) => e.getAttribute("data-status")))).toEqual(["passed", "passed", "passed", "failed"]);
        // the runs of this test as a strip, newest first
        const strip = rail.getByRole("list", { name: "Recent runs, newest first" });
        await pwExpect(strip.locator("li").first()).toContainText("Did not pass");
        await pwExpect(strip).toContainText("Passed");
        await shot("failing-steps");
        // the edit that came before the failure can be undone, and the page says why it offers it
        const undo = rail.getByRole("button", { name: "Undo my last edit", exact: true });
        await pwExpect(undo).toBeVisible();
        await pwExpect(rail).toContainText("after a run that passed");
        await undo.click();
        await page.getByRole("dialog", { name: /^Go back to version [0-9]+[?]$/ }).getByRole("button", { name: "Undo my last edit", exact: true }).click();
        await pwExpect(rail.getByText("This test is passing")).toBeVisible({ timeout: 90_000 });
        expect((await specNow()).spec.steps[3].expected).toBe("products");
        await pwExpect(rail.getByRole("button", { name: "Undo my last edit", exact: true })).toHaveCount(0);
    }, 240_000);

    it("a marks-free page after an edit: the last run's marks are not shown on steps that changed since", async () => {
        await visit(`#/tests/${webId}/steps`);
        await pwExpect(page.getByTestId("step-mark")).toHaveCount(4);
        await heads().nth(1).click();
        await page.getByLabel("Text to type", { exact: true }).fill("tent");
        // the edited step says it was edited since that run; the others keep what the run said
        await pwExpect(page.getByText("edited since that run")).toBeVisible();
        await bar().getByRole("button", { name: "Discard changes", exact: true }).click();
        await page.getByRole("dialog", { name: "Discard your changes?" }).getByRole("button", { name: "Discard changes", exact: true }).click();
        await pwExpect(page.getByText("edited since that run")).toHaveCount(0);
    });
});

describe("the Code tab and the way to code and back", () => {
    it("a generated test shows its script read-only and offers Switch to code with what stops", async () => {
        await visit(`#/tests/${webId}/code`);
        await pwExpect(page.getByRole("heading", { name: "Script", exact: true })).toBeVisible();
        await pwExpect(page.locator("pre.code").first()).toContainText("test(");
        await pwExpect(page.getByText("Want to change the code itself?")).toBeVisible();
        expect(await page.locator(".cm-editor").count()).toBe(0);
        await page.getByRole("button", { name: "Switch to code", exact: true }).first().click();
        const dialog = page.getByRole("dialog", { name: "Switch this test to code?" });
        await pwExpect(dialog.getByTestId("takeover-losses")).toBeVisible();
        await pwExpect(dialog).toContainText("You can go back to the generated version later.");
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        // View technical details is here, with the test as JSON
        await page.getByText("View technical details", { exact: true }).click();
        await pwExpect(page.getByText("This test as JSON")).toBeVisible();
    });

    it("after switching, the editor opens in this page, a save is a version, History lists it, and going back restores the generated version", async () => {
        await visit(`#/tests/${plainId}/code`);
        await page.getByRole("button", { name: "Switch to code", exact: true }).first().click();
        await page.getByRole("dialog", { name: "Switch this test to code?" }).getByRole("button", { name: "Switch to code", exact: true }).click();
        await pwExpect(page).toHaveURL(new RegExp(`#/tests/${plainId}/code`));
        await pwExpect(page.getByText("This is a code test", { exact: true })).toBeVisible({ timeout: 15_000 });
        await pwExpect(page.locator(".page-head").getByText("Code test", { exact: true })).toBeVisible();
        await pwExpect(page.locator(".cm-editor")).toBeVisible({ timeout: 15_000 });
        await page.locator(".cm-content").click();
        await page.keyboard.press("Control+End");
        await page.keyboard.insertText("\n// a note from the tester\n");
        await pwExpect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();
        await page.getByLabel("Note for this version (optional)").fill("Added a note");
        await page.getByRole("button", { name: "Save and run", exact: true }).click();
        await pwExpect(page.getByTestId("saved-version")).toBeVisible({ timeout: 20_000 });
        // the steps tab says why there is nothing to edit and links to the code
        await tab("Steps").click();
        await pwExpect(page.getByText("This is a code test, so it has no steps to edit")).toBeVisible();
        await pwExpect(page.getByRole("link", { name: "Edit the code", exact: true }).first()).toHaveAttribute("href", `#/tests/${plainId}/code`);
        // and the DSL tab says the script is code only, with a way to the code
        await tab("DSL").click();
        await pwExpect(page.getByText("This script is code only: it has no DSL")).toBeVisible();
        // History shows what happened: the switch and the edit
        await tab("History").click();
        const history = page.getByTestId("history");
        await pwExpect(history).toContainText("Switched to code");
        await pwExpect(history).toContainText("Code edited");
        await pwExpect(history).toContainText("Added a note");
        // compare the two code versions: a line difference
        const picks = history.getByRole("checkbox");
        await picks.nth(0).check();
        await picks.nth(1).check();
        await pwExpect(page.getByTestId("history-compare")).toContainText("Code version 1 compared with version 2");
        await pwExpect(page.getByTestId("diff")).toContainText("a note from the tester");
        // go back to the generated version from the Code tab
        await tab("Code").click();
        await page.getByRole("button", { name: "Go back to the generated version", exact: true }).click();
        await page.getByRole("dialog").getByRole("button", { name: /Go back/ }).last().click();
        await pwExpect(page.getByText("Want to change the code itself?")).toBeVisible({ timeout: 20_000 });
        await tab("Steps").click();
        await pwExpect(page.locator(".bld-head").first()).toBeVisible({ timeout: 15_000 });
    }, 120_000);
});

describe("History: everything that happened to the test", () => {
    it("lists versions of the steps, runs with their evidence and the restore, newest first, and compares two versions", async () => {
        await visit(`#/tests/${webId}/history`);
        const history = page.getByTestId("history");
        await pwExpect(history.getByRole("list", { name: "History of this test" })).toBeVisible();
        await pwExpect(history).toContainText("The steps as they were before the first edit");
        await pwExpect(history).toContainText("Steps edited");
        await pwExpect(history).toContainText("Undid version");
        await pwExpect(history).toContainText("Run did not pass");
        await pwExpect(history).toContainText("Run passed");
        await pwExpect(history.getByRole("link", { name: /See the screenshot/ })).toHaveCount(1);
        // the newest version of the steps is marked current and has no restore button
        await pwExpect(history.locator("li", { hasText: "Current" })).toHaveCount(1);
        // compare the original with the edit that failed: a step difference
        const failV = await versionWithText("no such words anywhere");
        await history.getByRole("checkbox", { name: "Compare steps version 1" }).check();
        await history.getByRole("checkbox", { name: `Compare steps version ${failV}` }).check();
        await pwExpect(page.getByTestId("history-compare")).toContainText(`Steps version 1 compared with version ${failV}`);
        await pwExpect(page.getByTestId("step-diff")).toContainText("no such words anywhere");
        await shot("history");
        // restoring version 2 (the failing one) is a real save: a new version, the test runs
        await history.getByRole("button", { name: `Restore steps version ${failV}`, exact: true }).click();
        await page.getByRole("dialog", { name: `Restore steps version ${failV}?` }).getByRole("button", { name: "Restore this version", exact: true }).click();
        await pwExpect(page.getByText(`Steps version ${failV} is restored`)).toBeVisible({ timeout: 20_000 });
        expect((await specNow()).spec.steps[3].expected).toBe("no such words anywhere");
        await waitForQuiet();
        // put the test back as it was (version 1) so the next tests start from a passing test
        await history.getByRole("button", { name: "Restore steps version 1", exact: true }).click();
        await page.getByRole("dialog", { name: "Restore steps version 1?" }).getByRole("button", { name: "Restore this version", exact: true }).click();
        await pwExpect(page.getByText("Steps version 1 is restored")).toBeVisible({ timeout: 20_000 });
        expect((await specNow()).spec.steps[3].expected).toBe("products");
        await waitForQuiet();
    }, 240_000);
});

/** The number of the newest saved version of the steps that has the given text in its last step. */
async function versionWithText(text: string): Promise<number> {
    const list = (await api("GET", `/api/tests/${webId}/spec-versions`)).body as Array<{ version: number }>;
    for (const v of [...list].sort((a, b) => b.version - a.version)) {
        const body = (await api("GET", `/api/tests/${webId}/spec-versions/${v.version}`)).body;
        if (body.spec.steps.some((st: { expected?: string }) => st.expected === text)) return v.version;
    }
    throw new Error("no version has that text");
}

/** Waits until no run is in progress for the project (a restore starts one). */
async function waitForQuiet() {
    for (let i = 0; i < 300; i++) {
        const active = platform.db.all("SELECT id FROM generation_jobs WHERE project_id = ? AND status NOT IN ('COMPLETED','PARTIALLY_COMPLETED','FAILED')", projectId);
        if (active.length === 0) return;
        await sleep(400);
    }
    throw new Error("a run did not finish");
}

describe("read-only states say why", () => {
    it("a run in progress explains that the steps cannot change now and Try again works once it ends", async () => {
        const app = platform.repo.getLatestApplicationPublic(projectId)!;
        const job = await platform.repo.createJob(projectId, app.id as string, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] });
        platform.repo.setJobStatus(job.id, "VALIDATING");
        try {
            await visit(`#/tests/${webId}/steps`);
            await pwExpect(page.getByText("A run is in progress", { exact: true })).toBeVisible();
            await pwExpect(page.getByRole("button", { name: "Add a step", exact: true })).toHaveCount(0);
            await shot("read-only-running");
        } finally {
            platform.repo.setJobStatus(job.id, "COMPLETED");
        }
        await page.getByRole("button", { name: "Try again", exact: true }).click();
        await pwExpect(page.getByRole("button", { name: "Add a step", exact: true })).toBeVisible();
    });

    it("a test that is not found offers Try again, and a slow answer shows a skeleton first", async () => {
        await visit(`#/tests/does-not-exist/steps`);
        await pwExpect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
        await page.route(`**/api/tests/${webId}`, async (route) => {
            await sleep(1200);
            await route.continue();
        });
        await visit(`#/tests/${webId}/steps`);
        await pwExpect(page.getByLabel("Loading the test")).toBeVisible();
        await pwExpect(page.getByRole("heading", { level: 1, name: "Search finds products" })).toBeVisible();
        await page.unroute(`**/api/tests/${webId}`);
    });

    it("an error from the platform offers Try again and the page recovers", async () => {
        let fail = true;
        await page.route(`**/api/tests/${webId}`, async (route) => {
            if (fail) await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "The platform had a problem." }) });
            else await route.continue();
        });
        await visit(`#/tests/${webId}/history`);
        await pwExpect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
        fail = false;
        await page.getByRole("button", { name: "Try again", exact: true }).click();
        await pwExpect(page.getByRole("heading", { level: 1, name: "Search finds products" })).toBeVisible();
        await page.unroute(`**/api/tests/${webId}`);
    });
});

describe("looks and works everywhere", () => {
    it("has no accessibility violations in either colour scheme on every tab, with a failing run and unsaved changes", async () => {
        // a failing run to look at: edit the check, run, wait
        await visit(`#/tests/${webId}/steps`);
        await heads().nth(3).click();
        await page.getByLabel("Text it should contain", { exact: true }).fill("no such words anywhere");
        await bar().getByRole("button", { name: "Save and run", exact: true }).click();
        await pwExpect(page.getByRole("complementary", { name: "Results and script" }).getByText("This test is failing")).toBeVisible({ timeout: 90_000 });
        await heads().nth(1).click();
        await page.getByLabel("Text to type", { exact: true }).fill("tent");
        await pwExpect(bar()).toBeVisible();
        await axeBoth("steps-failing-unsaved");
        await bar().getByRole("button", { name: "Preview changes", exact: true }).click();
        await axeBoth("steps-preview");
        await tab("DSL").click();
        await pwExpect(editor()).toBeVisible({ timeout: 15_000 });
        await axeBoth("text");
        await tab("Code").click();
        await pwExpect(page.getByRole("heading", { name: "Script", exact: true })).toBeVisible();
        await axeBoth("code");
        await tab("History").click();
        await pwExpect(page.getByTestId("history")).toBeVisible();
        await axeBoth("history");
    }, 240_000);

    it("fits a phone: tabs scroll, the results stack under the work, targets are at least 44 px, no sideways scroll", async () => {
        await page.setViewportSize({ width: 375, height: 800 });
        await tab("Steps").click();
        await pwExpect(heads().first()).toBeVisible();
        await page.waitForTimeout(400); // the panel that was hidden has settled
        await noOverflow();
        const rail = await page.getByRole("complementary", { name: "Results and script" }).boundingBox();
        const main = await page.locator(".wb-main").boundingBox();
        expect(rail!.y).toBeGreaterThan(main!.y + main!.height - 4);
        const small = await page.evaluate(() =>
            Array.from(document.querySelectorAll<HTMLElement>(".wb-tab, .wb-unsaved button, .wb-saved button, .bld-toolbar button"))
                .map((el) => ({ el, r: el.getBoundingClientRect() }))
                .filter(({ r }) => r.width > 0 && (r.height < 43.5 || r.width < 43.5))
                .map(({ el }) => `${el.tagName.toLowerCase()}.${el.className}[${el.textContent?.slice(0, 20)}]`),
        );
        expect(small).toEqual([]);
        await shot("steps-390-light");
        await page.emulateMedia({ colorScheme: "dark" });
        await page.waitForTimeout(400);
        await shot("steps-390-dark");
        await axe();
        await tab("History").click();
        await pwExpect(page.getByTestId("history")).toBeVisible();
        await noOverflow();
        await page.emulateMedia({ colorScheme: null });
        await page.setViewportSize({ width: 1280, height: 900 });
    });

    it("never wrote to the browser console as an error", () => {
        expect(consoleErrors).toEqual([]);
    });
});
