/**
 * Text tests in a real browser against a real platform (worker, sample app, real API): the Steps | Text switch of the step editor,
 * live problems with a jump to the line, Save and run, changes carried between the two views (and the warning when the text does not
 * read), a test that has no text form, the "Write as text" dialog, the phrase list, copy and download, the keyboard path,
 * 375 px and axe in both themes. Ports: 6300 sample app, 6301 platform (it serves web/dist too).
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/dsl-ui.test.ts
 * Set DSL_SHOTS=<folder> to also write screenshots.
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
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const APP_PORT = 6300;
const PORT = 6301;
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
const consoleErrors: string[] = [];

const api = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never, headers: payload !== undefined ? { "content-type": "application/json" } : {} });
    return { status: res.statusCode, body: res.body && (res.body.startsWith("{") || res.body.startsWith("[")) ? JSON.parse(res.body) : res.body };
};
async function waitIdle() {
    for (let i = 0; i < 300; i++) {
        const jobs = platform.repo.listJobs(projectId);
        if (jobs.every((j) => DONE.includes(j.status))) return;
        await sleep(400);
    }
    throw new Error("a job did not finish");
}

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
const stuckSpec = { title: "Accessibility with a number", kind: "web", category: "Shop", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "a11y", expected: 100 }] };

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
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-dsl-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0", HOST: "127.0.0.1", PORT: String(PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 200);
    worker.start();

    projectId = (await api("POST", "/api/projects", { name: "Atlas shop" })).body.id;
    const imp = await api("POST", `/api/projects/${projectId}/specs`, { specs: [searchSpec, stuckSpec], baseUrl: APP, validate: false });
    expect(imp.status).toBe(202);
    webId = imp.body.tests[0].id;
    stuckId = imp.body.tests[1].id;

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
    page = await context.newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    sample?.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const shots = process.env.DSL_SHOTS;
async function shot(name: string) {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
}
async function visit(hash: string) {
    await page.goto("about:blank");
    await page.goto(`${BASE}/${hash}`);
}
const builderHash = (id = webId) => `#/tests/${id}/steps`;
const unsaved = () => page.getByTestId("unsaved-bar");
const editor = () => page.getByRole("textbox", { name: "Test text", exact: true });
// textContent, not innerText: an empty line holds a <br>, which innerText turns into an extra line.
const lines = async () => page.locator(".cm-line").evaluateAll((els) => els.map((e) => e.textContent ?? ""));
const textNow = async () => (await lines()).join("\n");
/** Replaces the whole text the way a person would: select all, then type line by line. */
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
async function openText(id = webId) {
    await visit(builderHash(id));
    await page.getByRole("tab", { name: "Text", exact: true }).click();
    await pwExpect(editor()).toBeVisible({ timeout: 15_000 });
}
async function noOverflow() {
    const wide = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".content *"))
            .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !el.closest(".code-wrap") && !el.closest(".cm-scroller") && !el.closest(".tabs"))
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
async function axeBoth(name: string) {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(400);
        await shot(`${name}-${scheme}-1280`);
        await axe();
    }
    await page.emulateMedia({ colorScheme: null });
}

describe("the Text view of a generated test", () => {
    it("has a Steps and a Text tab, and shows the test as one line per step", async () => {
        await visit(builderHash());
        await pwExpect(page.locator(".bld-head").first()).toBeVisible();
        const tabs = page.getByRole("tablist", { name: "Views of this test", exact: true });
        await pwExpect(tabs.getByRole("tab", { name: "Steps", exact: true })).toHaveAttribute("aria-selected", "true");
        await tabs.getByRole("tab", { name: "Text", exact: true }).click();
        await pwExpect(editor()).toBeVisible({ timeout: 15_000 });
        await pwExpect(tabs.getByRole("tab", { name: "Text", exact: true })).toHaveAttribute("aria-selected", "true");
        await pwExpect(page).toHaveURL(new RegExp(`#/tests/${webId}/text$`));
        const text = await textNow();
        expect(text).toContain("Test: Search finds products");
        expect(text).toContain("Priority: high");
        expect(text).toContain("Go to /products");
        expect(text).toContain('Type "boot" into the "Search products" field');
        expect(text).toContain('Click the "Search" button');
        expect(text).toContain('Expect the page to contain the text "products"');
        await pwExpect(unsaved()).toHaveCount(0);
        await shot("text-view");
    });

    it("says what is wrong while you type, with the line and a suggestion, and jumps to the line", async () => {
        const text = (await textNow()).replace('Click the "Search" button', 'Clik the "Search" button');
        await writeText(text);
        await pwExpect(unsaved()).toContainText("unsaved change");
        const problems = page.getByRole("list", { name: "Problems in the text" });
        await pwExpect(problems).toBeVisible({ timeout: 10_000 });
        await pwExpect(problems).toContainText("I do not understand this step");
        await pwExpect(problems).toContainText("Did you mean: Click the");
        await pwExpect(problems.getByRole("button").first()).toContainText("Line 8, column 1");
        await pwExpect(page.locator(".cm-lintRange-error").first()).toBeVisible();
        await pwExpect(unsaved().getByRole("button", { name: "Save and run", exact: true })).toBeDisabled();
        await pwExpect(page.getByTestId("unsaved-why")).toContainText("The text does not read yet");
        await shot("text-problem");
        // the jump
        await problems.getByRole("button").first().click();
        await pwExpect(page.locator(".cm-activeLine")).toContainText('Clik the "Search" button');
        await pwExpect(editor()).toBeFocused();
    });

    it("fixing the line clears the problem", async () => {
        const text = (await textNow()).replace('Clik the', 'Click the');
        await writeText(text);
        await pwExpect(page.getByText("No problems found.")).toBeVisible({ timeout: 10_000 });
        // the text is the stored test again, so there is nothing to save
        await pwExpect(unsaved()).toHaveCount(0);
    });

    it("discards the changes after asking", async () => {
        await writeText((await textNow()) + "\nWait 100 ms\n");
        await pwExpect(unsaved()).toContainText("unsaved change");
        await pwExpect(unsaved().getByRole("button", { name: "Save and run", exact: true })).toBeEnabled({ timeout: 10_000 });
        await unsaved().getByRole("button", { name: "Discard changes", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Discard your changes?" });
        await pwExpect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Discard changes", exact: true }).click();
        await pwExpect(unsaved()).toHaveCount(0);
        expect(await textNow()).toContain('Click the "Search" button');
    });

    it("lists the phrases you can use, made from the platform's grammar", async () => {
        await page.locator("summary", { hasText: "Phrases you can use" }).click();
        await pwExpect(page.getByRole("heading", { name: "Lines at the top", exact: true })).toBeVisible({ timeout: 10_000 });
        await pwExpect(page.locator(".dsl-phrases code", { hasText: 'Click the "Sign in" button' })).toBeVisible();
        await pwExpect(page.getByRole("heading", { name: "Call an API", exact: true })).toBeVisible();
        await page.locator("summary", { hasText: "Phrases you can use" }).click();
    });

    it("copies the text and downloads it as a .txt file", async () => {
        const text = await textNow();
        await page.getByRole("button", { name: "Copy text", exact: true }).click();
        await pwExpect(page.getByText("Copied.", { exact: true })).toBeVisible();
        // Windows turns the line ends of the clipboard into CR LF.
        expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe(text);
        const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download as .txt", exact: true }).click()]);
        expect(download.suggestedFilename()).toBe("search-finds-products.txt");
        const file = fs.readFileSync(await download.path(), "utf8");
        expect(file.replace(/\r\n/g, "\n")).toBe(text);
    });

    it("leaves the editor with the keyboard: Escape, then Tab", async () => {
        await pwExpect(page.getByText("press Escape, then Tab", { exact: false })).toBeVisible();
        await editor().click();
        await page.keyboard.press("Escape");
        await page.keyboard.press("Tab");
        const inside = await page.evaluate(() => !!document.activeElement?.closest(".cm-editor"));
        expect(inside).toBe(false);
        // and Tab alone does not trap the person in the other direction either: Shift+Tab goes back into it
        await page.keyboard.press("Shift+Tab");
        await pwExpect(editor()).toBeFocused();
    });
});

describe("carrying changes between the two views", () => {
    it("steps changed but not saved show up in the text", async () => {
        await visit(builderHash());
        await page.locator(".bld-head").nth(1).click();
        await page.getByLabel("Text to type", { exact: true }).fill("alpenglow");
        await pwExpect(unsaved()).toContainText("unsaved change");
        await page.getByRole("tab", { name: "Text", exact: true }).click();
        await pwExpect(editor()).toBeVisible({ timeout: 15_000 });
        expect(await textNow()).toContain('Type "alpenglow" into the "Search products" field');
        // saving from the text view saves those steps too (the button is on because the steps carry unsaved changes)
        await pwExpect(unsaved().getByRole("button", { name: "Save and run", exact: true })).toBeEnabled();
        await pwExpect(unsaved()).toContainText("unsaved change");
    });

    it("text that reads is shown as steps, with the change unsaved", async () => {
        const text = (await textNow()).replace("Priority: high", "Priority: low") + '\nExpect the page title to contain "Products"\n';
        await writeText(text);
        await pwExpect(page.getByText("No problems found.")).toBeVisible({ timeout: 10_000 });
        await page.getByRole("tab", { name: "Steps", exact: true }).click();
        await pwExpect(page.locator(".bld-head").first()).toBeVisible();
        const heads = (await page.locator(".bld-head").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
        expect(heads).toHaveLength(5);
        expect(heads[1]).toContain("alpenglow");
        expect(heads[4]).toContain("Check that the page title contains “Products”");
        await pwExpect(unsaved()).toContainText("unsaved change");
        // the priority that only the text carries rides along: back in the text it is still there
        await page.getByRole("tab", { name: "Text", exact: true }).click();
        await pwExpect(editor()).toBeVisible();
        expect(await textNow()).toContain("Priority: low");
    });

    it("text that does not read yet stays where it is, says why, and can be dropped", async () => {
        const text = (await textNow()).replace('Click the "Search" button', 'Frobnicate the "Search" button');
        await writeText(text);
        await page.getByRole("tab", { name: "Steps", exact: true }).click();
        await pwExpect(page.getByText("The text does not read yet", { exact: true })).toBeVisible();
        await pwExpect(page.getByText("I do not understand this step", { exact: false }).first()).toBeVisible();
        await pwExpect(editor()).toBeVisible();
        await shot("text-blocked");
        await page.getByRole("button", { name: "Discard the text and show the steps", exact: true }).click();
        await pwExpect(page.locator(".bld-head").first()).toBeVisible();
        await pwExpect(page.getByRole("button", { name: "Add a step", exact: true })).toBeVisible();
    });

    it("leaving with unsaved text asks first", async () => {
        await page.getByRole("tab", { name: "Text", exact: true }).click();
        await pwExpect(editor()).toBeVisible({ timeout: 15_000 });
        await writeText((await textNow()) + "\nWait 100 ms\n");
        await page.getByRole("link", { name: "Test cases", exact: true }).first().click();
        const dialog = page.getByRole("dialog", { name: "Leave without saving?" });
        await pwExpect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Stay and keep editing", exact: true }).click();
        await pwExpect(dialog).toHaveCount(0);
        expect(page.url()).toContain("/text");
    });
});

describe("saving from the text", () => {
    it("saves and runs: the run passes, the stored test and script follow, and the view stays on the text", async () => {
        await openText();
        const text = (await textNow()).replace('Type "boot" into', 'Type "tent" into').replace("Priority: high", "Priority: low");
        await writeText(text);
        await pwExpect(page.getByText("No problems found.")).toBeVisible({ timeout: 10_000 });
        await unsaved().getByRole("button", { name: "Save and run", exact: true }).click();
        await pwExpect(page.getByRole("complementary", { name: "Results and script" }).getByText("This test is passing")).toBeVisible({ timeout: 90_000 });
        await pwExpect(unsaved()).toHaveCount(0);
        await pwExpect(editor()).toBeVisible();
        expect(await textNow()).toContain('Type "tent" into');
        const stored = (await api("GET", `/api/tests/${webId}/spec`)).body;
        expect(stored.spec.steps[1].value).toBe("tent");
        expect(stored.spec.priority).toBe("low");
        expect(stored.validationStatus).toBe("VALIDATED");
        expect(String((await api("GET", `/api/tests/${webId}/script`)).body)).toContain("tent");
        await shot("text-saved");
        // links work again without a question
        await page.getByRole("link", { name: "Test cases", exact: true }).first().click();
        await pwExpect(page.getByRole("dialog")).toHaveCount(0);
        expect(page.url()).toContain(`/projects/${projectId}/tests`);
    }, 120_000);

    it("the platform's own refusal comes back on the line, and the text is still there", async () => {
        await openText();
        const text = (await textNow()).replace('Click the "Search" button', 'Type "hunter2" into the "Password" field');
        await writeText(text);
        await pwExpect(page.getByText("No problems found.")).toBeVisible({ timeout: 10_000 });
        await unsaved().getByRole("button", { name: "Save and run", exact: true }).click();
        await pwExpect(page.getByText("That didn’t save", { exact: true })).toBeVisible();
        const problems = page.getByRole("list", { name: "Problems in the text" });
        await pwExpect(problems).toContainText("{{credentials.password}}");
        await pwExpect(problems.getByRole("button").first()).toContainText("Line 8");
        expect(await textNow()).toContain('Type "hunter2" into the "Password" field');
        expect(((await api("GET", `/api/tests/${webId}/spec`)).body.spec.steps as Array<{ value?: string }>).some((s) => s.value === "hunter2")).toBe(false);
        await shot("text-refused");
        await unsaved().getByRole("button", { name: "Discard changes", exact: true }).click();
        await page.getByRole("dialog", { name: "Discard your changes?" }).getByRole("button", { name: "Discard changes", exact: true }).click();
    });
});

describe("a test that has no text form", () => {
    it("is shown as read-only text with the reasons, and cannot be saved", async () => {
        await openText(stuckId);
        // the closest text is shown, never a refusal; the step with no phrase is a marked line and the text is read-only
        await pwExpect(page.getByText("Part of this test has no text form.", { exact: false })).toBeVisible();
        await pwExpect(page.getByRole("list", { name: "What has no text form" })).toContainText("Step 2");
        await pwExpect(page.getByText("Read-only", { exact: true })).toBeVisible();
        expect(await textNow()).toContain("# not expressible: step 2");
        await pwExpect(unsaved()).toHaveCount(0);
        await pwExpect(page.getByRole("button", { name: "Switch to code", exact: true })).toBeVisible();
        await shot("text-not-expressible");
        await axeBoth("text-readonly");
    });

    it("a hand-written test has no text: the Text tab says so and points to the Code tab", async () => {
        const imp = await api("POST", `/api/projects/${projectId}/specs`, { specs: [{ title: "Taken over", kind: "api", steps: [{ action: "request", method: "GET", path: "/api/products" }] }], validate: false });
        const id = imp.body.tests[0].id as string;
        expect((await api("POST", `/api/tests/${id}/take-over`, { confirm: true })).status).toBe(200);
        await visit(`#/tests/${id}/text`);
        await pwExpect(page.getByText("A code test has no text form")).toBeVisible();
        await pwExpect(page.getByRole("link", { name: "Open the Code tab", exact: true })).toHaveAttribute("href", `#/tests/${id}/code`);
        expect(await editor().count()).toBe(0);
    });
});

describe("writing a test as text from the Tests page", () => {
    it("starts from an example, shows problems, and creates the test", async () => {
        await visit(`#/projects/${projectId}/tests`);
        await page.getByRole("button", { name: "New test", exact: true }).click();
        await page.getByRole("menuitem", { name: "Write it as text", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Write a test as text" });
        await pwExpect(dialog).toBeVisible();
        await pwExpect(editor()).toBeVisible({ timeout: 15_000 });
        expect(await textNow()).toContain("Test: The home page opens");
        // the example follows the kind while it is still the example
        await dialog.getByLabel("Starting example", { exact: true }).selectOption("api");
        await pwExpect(page.locator(".cm-line", { hasText: "Send a GET request to /" })).toBeVisible();
        await dialog.getByLabel("Starting example", { exact: true }).selectOption("web");
        // the person's own words are not replaced
        await writeText('Test: Home page greets visitors\nKind: web\n\nGo to /\nExpect the pgae to show "Welcome to DemoShop"\n');
        await dialog.getByLabel("Starting example", { exact: true }).selectOption("api");
        expect(await textNow()).toContain("Home page greets visitors");
        const problems = dialog.getByRole("list", { name: "Problems in the text" });
        await pwExpect(problems).toContainText("Line 5", { timeout: 10_000 });
        await pwExpect(dialog.getByRole("button", { name: "Create test", exact: true })).toBeDisabled();
        await shot("write-as-text-problem");
        await axeBoth("write-as-text");
        await writeText('Test: Home page greets visitors\nKind: web\n\nGo to /\nExpect the page to show "Welcome to DemoShop"\n');
        await pwExpect(dialog.getByText("No problems found.")).toBeVisible({ timeout: 10_000 });
        await dialog.getByRole("button", { name: "Create test", exact: true }).click();
        await pwExpect(page.getByRole("heading", { name: "Home page greets visitors", exact: false }).first()).toBeVisible({ timeout: 15_000 });
        const made = platform.repo.listTests(projectId).find((t) => t.title === "Home page greets visitors");
        expect(made).toBeDefined();
        expect(page.url()).toContain(`#/tests/${made!.id}`);
        await waitIdle();
        expect(platform.repo.getTest(made!.id)!.validationStatus).toBe("VALIDATED");
    }, 120_000);

    it("the platform's refusal is shown on the line and nothing is created", async () => {
        const before = platform.repo.listTests(projectId).length;
        await visit(`#/projects/${projectId}/tests`);
        await page.getByRole("button", { name: "New test", exact: true }).click();
        await page.getByRole("menuitem", { name: "Write it as text", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Write a test as text" });
        await pwExpect(editor()).toBeVisible({ timeout: 15_000 });
        await writeText('Test: Types a secret\nGo to /login\nType "hunter2" into the "Password" field\n');
        await pwExpect(dialog.getByText("No problems found.")).toBeVisible({ timeout: 10_000 });
        await dialog.getByRole("button", { name: "Create test", exact: true }).click();
        await pwExpect(dialog.getByText("The test was not created.", { exact: false })).toBeVisible();
        await pwExpect(dialog.getByRole("list", { name: "Problems in the text" })).toContainText("{{credentials.password}}");
        expect(await textNow()).toContain("hunter2");
        expect(platform.repo.listTests(projectId).length).toBe(before);
        await page.keyboard.press("Escape");
        await pwExpect(dialog).toHaveCount(0);
    });
});

describe("looks and works everywhere", () => {
    it("has no accessibility violations in both themes: the text view with a problem and the phrases open", async () => {
        await openText();
        await writeText((await textNow()).replace('Click the "Search" button', 'Clik the "Search" button'));
        await pwExpect(page.getByRole("list", { name: "Problems in the text" })).toBeVisible({ timeout: 10_000 });
        await page.locator("summary", { hasText: "Phrases you can use" }).click();
        await pwExpect(page.getByRole("heading", { name: "Lines at the top", exact: true })).toBeVisible({ timeout: 10_000 });
        await axeBoth("text-view-problem");
    });

    it("fits a phone: no sideways scroll and targets of at least 44 px", async () => {
        await page.setViewportSize({ width: 375, height: 800 });
        await openText();
        await noOverflow();
        await shot("text-view-390");
        const small = await page.evaluate(() =>
            Array.from(document.querySelectorAll<HTMLElement>(".wb-tab, .wb-unsaved button, .code-toolbar button, .code-diag, .dsl-linkbtn, summary"))
                .map((el) => ({ el, r: el.getBoundingClientRect() }))
                .filter(({ r }) => r.width > 0 && (r.height < 43.5 || r.width < 43.5))
                .map(({ el }) => `${el.tagName.toLowerCase()}.${el.className}[${el.textContent?.slice(0, 24)}]`),
        );
        expect(small).toEqual([]);
        await page.emulateMedia({ colorScheme: "dark" });
        await page.waitForTimeout(400);
        await shot("text-view-390-dark");
        await axe();
        await page.emulateMedia({ colorScheme: null });
        // the dialog on a phone
        await visit(`#/projects/${projectId}/tests`);
        await page.getByRole("button", { name: "New test", exact: true }).click();
        await page.getByRole("menuitem", { name: "Write it as text", exact: true }).click();
        await pwExpect(editor()).toBeVisible({ timeout: 15_000 });
        await noOverflow();
        await shot("write-as-text-390");
        await page.keyboard.press("Escape");
        await page.setViewportSize({ width: 1280, height: 900 });
    });

    it("never wrote to the browser console as an error", () => {
        expect(consoleErrors).toEqual([]);
    });
});
