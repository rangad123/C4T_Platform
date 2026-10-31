/**
 * Reusable steps in a real browser against a real platform (worker, fixture app, real API): the Blocks page (empty, add, change, delete
 * refused while used), the step editor (choose reusable steps with a value, read what is inside, link to change them, save steps of a test
 * as reusable steps), the test page, phone width, keyboard, axe in light and dark.
 * Ports: 6252 fixture app, 6253 platform (it serves web/dist too).
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/blocks-ui.test.ts
 * Set BLOCKS_SHOTS=<folder> to also write screenshots.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { startBlocksApp } from "./fixtures/blocks-app.js";

const APP_PORT = 6252;
const PORT = 6253;
const APP = `http://127.0.0.1:${APP_PORT}`;
const BASE = `http://127.0.0.1:${PORT}`;

let notes: http.Server;
let platform: Platform;
let worker: Worker;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let projectId = "";
let plainId = "";
let linusId = "";
const consoleErrors: string[] = [];

const api = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never, headers: payload !== undefined ? { "content-type": "application/json" } : {} });
    return { status: res.statusCode, body: res.body && (res.body.startsWith("{") || res.body.startsWith("[")) ? JSON.parse(res.body) : res.body };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const nick = { by: "label", value: "Nickname" };
const button = (name: string) => ({ by: "role", role: "button", value: name, exact: true });
const status = { by: "role", role: "status" };
const plainSpec = { title: "The notes page opens", kind: "web", category: "Notes", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Notes" } }] };
const linusSpec = {
    title: "Linus signs in and adds a note",
    kind: "web",
    category: "Notes",
    steps: [
        { action: "navigate", url: "/" },
        { action: "fill", locator: nick, value: "Linus" },
        { action: "click", locator: button("Sign in") },
        { action: "assert", check: "text", locator: status, expected: "Signed in as Linus" },
        { action: "click", locator: button("Add note") },
    ],
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    ({ server: notes } = await startBlocksApp(APP_PORT));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-blocks-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0", HOST: "127.0.0.1", PORT: String(PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 200);
    worker.start();

    projectId = (await api("POST", "/api/projects", { name: "Notes app" })).body.id;
    const imp = await api("POST", `/api/projects/${projectId}/specs`, { specs: [plainSpec, linusSpec], baseUrl: APP, validate: false });
    expect(imp.status, JSON.stringify(imp.body)).toBe(202);
    plainId = imp.body.tests[0].id;
    linusId = imp.body.tests[1].id;

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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
    notes?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const shots = process.env.BLOCKS_SHOTS;
async function shot(name: string) {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
}
async function visit(hash: string) {
    await page.goto("about:blank");
    await page.goto(`${BASE}/${hash}`);
}
const blocksHash = (edit?: string) => `#/projects/${projectId}/blocks${edit ? `?edit=${encodeURIComponent(edit)}` : ""}`;
const builderHash = (id: string) => `#/tests/${id}/steps`;
const heads = () => page.locator(".bld-head");
const headTexts = async () => (await heads().allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
async function noOverflow() {
    const wide = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".content *"))
            // The project's tab row and a place's section row scroll sideways on their own (INFORMATION_ARCHITECTURE.md, Responsive).
            .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !el.closest(".code-wrap, .tabs, .subtabs"))
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
/** Touch targets: every control in the area is at least 44 px high (and not a narrow icon button). */
async function targets(selector: string) {
    const small = await page.evaluate((sel) =>
        Array.from(document.querySelectorAll<HTMLElement>(sel))
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 0 && (r.height < 43.5 || (r.width < 43.5 && !(r.width > 100))))
            .map(({ el }) => `${el.tagName.toLowerCase()}.${el.className}[${el.getAttribute("aria-label") ?? el.textContent?.slice(0, 20)}]`), selector);
    expect(small).toEqual([]);
}
const addStep = async (group: string, name: string) => {
    const palette = page.locator("#blk-palette, #bld-palette");
    if ((await palette.count()) === 0) await page.getByRole("button", { name: "Add a step", exact: true }).click();
    await page.getByRole("group", { name: group, exact: true }).getByRole("button", { name, exact: true }).click();
};

describe("the Blocks page", () => {
    it("is two clicks away from the Test cases page: Test scripts, then Reusable steps", async () => {
        await visit(`#/projects/${projectId}/tests`);
        await page.getByRole("navigation", { name: "Project sections", exact: true }).getByRole("link", { name: "Test scripts", exact: true }).click();
        await page.getByRole("navigation", { name: "Test scripts sections", exact: true }).getByRole("link", { name: "Reusable steps", exact: true }).click();
        await pwExpect(page.getByRole("heading", { name: "Reusable steps", exact: true })).toBeVisible();
        expect(page.url()).toContain(`#/projects/${projectId}/scripts?section=steps`);
    });

    it("starts empty and invites one action; accessible in both themes", async () => {
        await visit(blocksHash());
        await pwExpect(page.getByText("No reusable steps yet", { exact: true })).toBeVisible();
        await pwExpect(page.getByRole("button", { name: "Add reusable steps", exact: true })).toHaveCount(2);
        await axeBoth("blocks-empty");
    });

    it("adds reusable steps with a value, using the same editor as the builder, with mouse and keyboard", async () => {
        await page.getByRole("button", { name: "Add reusable steps", exact: true }).first().click();
        await pwExpect(page.getByRole("heading", { name: "Add reusable steps", exact: true }).first()).toBeVisible();
        await page.getByLabel("Name", { exact: true }).fill("Sign in");
        await page.getByLabel("Description (optional)", { exact: true }).fill("Sign in with a nickname");
        await page.getByRole("button", { name: "Add a value", exact: true }).click();
        await page.getByLabel("Name of value 1", { exact: true }).fill("nickname");
        await page.getByLabel("Default for value 1", { exact: true }).fill("Ada");

        // the palette is open for an empty list; adding a step moves the keyboard into its form
        await page.getByRole("group", { name: "Go to", exact: true }).getByRole("button", { name: "Open a page", exact: true }).click();
        await pwExpect(page.getByLabel("Address", { exact: true })).toBeFocused();
        await page.getByLabel("Address", { exact: true }).fill("/");

        // keyboard only: Tab to "Add a step", Enter, Tab to the first choice of the "Interact" group, Enter
        await page.getByRole("button", { name: "Add a step", exact: true }).focus();
        await page.keyboard.press("Enter");
        await pwExpect(page.getByRole("group", { name: "Interact", exact: true })).toBeVisible();
        await page.getByRole("group", { name: "Interact", exact: true }).getByRole("button", { name: "Type text", exact: true }).focus();
        await page.keyboard.press("Enter");
        await pwExpect(page.getByLabel("How to find it", { exact: true })).toBeFocused();
        await page.getByLabel("Label text", { exact: true }).fill("Nickname");
        // the value's name is offered to insert into a text
        await page.getByLabel("Insert a value into text to type").selectOption("nickname");
        await pwExpect(page.getByLabel("Text to type", { exact: true })).toHaveValue("{{nickname}}");

        await addStep("Interact", "Click");
        await page.getByLabel("Name (what it says)", { exact: true }).fill("Sign in");
        await page.getByLabel("Match the whole text exactly").check();
        await axeBoth("blocks-editor");

        await page.getByRole("button", { name: "Add reusable steps", exact: true }).click();
        await pwExpect(page.getByText("Reusable steps added", { exact: true })).toBeVisible();
        const row = page.getByTestId("block-list").locator("li", { hasText: "Sign in" });
        await pwExpect(row).toContainText("Web tests");
        await pwExpect(row).toContainText("3 steps, values: nickname");
        await pwExpect(row).toContainText("Not used by any test yet");
        const saved = (await api("GET", `/api/projects/${projectId}/blocks/Sign%20in`)).body;
        expect(saved.steps.map((s: { action: string }) => s.action)).toEqual(["navigate", "fill", "click"]);
        expect(saved.steps[1].value).toBe("{{nickname}}");
        expect(saved.params).toEqual([{ name: "nickname", default: "Ada" }]);
        await shot("blocks-list");
    });

    it("says what is wrong in plain words and keeps what was typed", async () => {
        await page.getByRole("button", { name: "Add reusable steps", exact: true }).first().click();
        await page.getByLabel("Name", { exact: true }).fill("sign in");
        // the add-a-step list is open for an empty list of steps
        await page.getByRole("group", { name: "Wait", exact: true }).getByRole("button", { name: "Wait a moment", exact: true }).click();
        await page.getByRole("button", { name: "Add reusable steps", exact: true }).click();
        await pwExpect(page.getByText("The reusable steps were not saved", { exact: true })).toBeVisible();
        await pwExpect(page.getByRole("alert")).toContainText("already has reusable steps called");
        await pwExpect(page.getByLabel("Name", { exact: true })).toHaveValue("sign in");
        // cancelling after typing asks before leaving through a link
        await page.getByRole("link", { name: /^Test cases/ }).first().click();
        const dialog = page.getByRole("dialog", { name: "Leave without saving?" });
        await pwExpect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Stay and keep editing", exact: true }).click();
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await pwExpect(page.getByTestId("block-list")).toBeVisible();
    });
});

describe("the step editor", () => {
    it("offers the project's reusable steps with their values, adds a use, shows what is inside and links to the steps", async () => {
        await visit(builderHash(plainId));
        await pwExpect(heads().first()).toBeVisible();
        await page.getByRole("button", { name: "Add a step", exact: true }).click();
        const group = page.getByRole("group", { name: "Reusable steps", exact: true });
        await pwExpect(group.getByRole("button", { name: /Sign in/ })).toContainText("1 value");
        await axeBoth("builder-palette-blocks");
        await group.getByRole("button", { name: /Sign in/ }).click();
        const form = page.getByRole("form", { name: "Values for Sign in" });
        await pwExpect(form).toBeVisible();
        await form.getByLabel("nickname", { exact: true }).fill("Grace");
        await form.getByRole("button", { name: "Add these steps", exact: true }).click();

        // the step is a collapsed row in plain words; the new step is open with its form
        expect(await headTexts()).toEqual([expect.stringContaining("Step 1 Open /"), expect.stringContaining("Step 2"), expect.stringContaining("Step 3")]);
        await pwExpect(heads().nth(2)).toContainText("Run the reusable steps “Sign in”");
        await pwExpect(page.getByLabel("Reusable steps", { exact: true })).toHaveValue("Sign in");
        await pwExpect(page.getByLabel("nickname", { exact: true })).toHaveValue("Grace");
        await page.getByText("Show the steps inside", { exact: true }).click();
        const inside = page.getByRole("list", { name: "Steps inside Sign in" });
        await pwExpect(inside).toContainText("Open /");
        await pwExpect(inside).toContainText("{{nickname}}");
        await pwExpect(page.getByRole("link", { name: "Edit the reusable steps", exact: true })).toHaveAttribute("href", `#/projects/${projectId}/scripts?section=steps&edit=Sign+in`);
        // the script preview has the steps written out
        await pwExpect(page.locator(".bld-script code").first()).toContainText("Grace", { timeout: 10_000 });
        await axeBoth("builder-block-step");
    });

    it("saves and runs: the test uses the reusable steps and passes", async () => {
        await page.getByTestId("unsaved-bar").getByRole("button", { name: "Save and run", exact: true }).click();
        await pwExpect(page.getByRole("complementary", { name: "Results and script" }).getByText("This test is passing")).toBeVisible({ timeout: 90_000 });
        const t = (await api("GET", `/api/tests/${plainId}`)).body;
        expect(t.spec.steps.map((s: { action: string }) => s.action)).toEqual(["navigate", "assert", "useBlock"]);
        expect(t.spec.steps[2]).toMatchObject({ block: "Sign in", args: { nickname: "Grace" } });
        expect(t.validationStatus).toBe("VALIDATED");
        expect(t.scripts[0].content).toContain("Grace");
        expect(t.scripts[0].content).not.toMatch(/useBlock|reusable/i);
    }, 120_000);

    it("saves steps of a test as reusable steps: the test keeps its script and still shows its steps", async () => {
        const before = (await api("GET", `/api/tests/${linusId}`)).body.scripts[0].content as string;
        await visit(builderHash(linusId));
        await pwExpect(heads().first()).toBeVisible();
        await page.getByRole("button", { name: "Save steps as reusable steps", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Save steps as reusable steps" });
        await pwExpect(dialog).toBeVisible();
        await dialog.getByLabel("Name", { exact: true }).fill("Greet");
        await dialog.getByLabel("First step", { exact: true }).selectOption("1");
        await dialog.getByLabel("Last step", { exact: true }).selectOption("3");
        await pwExpect(dialog.getByText("3 steps will be saved.")).toBeVisible();
        await dialog.getByRole("button", { name: "Add a value", exact: true }).click();
        await dialog.getByLabel("Name of value 1", { exact: true }).fill("who");
        await dialog.getByLabel("Text it stands for", { exact: true }).fill("Linus");
        await axeBoth("builder-save-as-block");
        await dialog.getByRole("button", { name: "Save reusable steps", exact: true }).click();
        await pwExpect(page.getByText("Reusable steps saved", { exact: true })).toBeVisible();
        await pwExpect(page.getByText("Those steps are now “Greet”.", { exact: false })).toBeVisible();
        expect(await headTexts()).toEqual([expect.stringContaining("Step 1 Open /"), expect.stringContaining("Run the reusable steps “Greet”"), expect.stringContaining("Step 3")]);
        const t = (await api("GET", `/api/tests/${linusId}`)).body;
        expect(t.spec.steps[1]).toMatchObject({ action: "useBlock", block: "Greet", args: { who: "Linus" } });
        expect(t.scripts[0].content).toBe(before);
        await shot("builder-after-save-as-block");
    });

    it("shows a reusable-steps use on the Steps tab with the steps inside, after a run", async () => {
        const app = platform.repo.getLatestApplicationPublic(projectId)!;
        const job = await platform.repo.createJob(projectId, app.id as string, { ...(await import("../src/platform/repo.js")).DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [linusId] });
        for (let i = 0; i < 300; i++) {
            const j = (await api("GET", `/api/test-generation/${job.id}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) break;
            await sleep(300);
        }
        await visit(`#/tests/${linusId}`);
        await pwExpect(heads()).toHaveCount(3);
        await pwExpect(heads().nth(1)).toContainText("Run the reusable steps “Greet”");
        // the last run's mark for the use of reusable steps: it passed when all the steps inside it passed
        await pwExpect(heads().nth(1).getByTestId("step-mark")).toHaveAttribute("data-status", "passed");
        await heads().nth(1).click();
        await page.getByText("Show the steps inside", { exact: true }).click();
        await pwExpect(page.getByRole("list", { name: "Steps inside Greet" })).toContainText("Signed in as {{who}}");
        await pwExpect(page.getByRole("link", { name: "Edit the reusable steps", exact: true })).toHaveAttribute("href", `#/projects/${projectId}/scripts?section=steps&edit=Greet`);
        await axeBoth("test-with-block");
    }, 120_000);
});

describe("changing and deleting", () => {
    it("opens the steps from the link in the editor, changes them and says what happened to the tests", async () => {
        await visit(blocksHash("Sign in"));
        await pwExpect(page.getByRole("heading", { name: "Change reusable steps", exact: true }).first()).toBeVisible();
        await pwExpect(page.getByLabel("Name", { exact: true })).toHaveValue("Sign in");
        await pwExpect(page.getByText("1 test uses these steps.", { exact: false })).toBeVisible();
        await page.getByLabel("Description (optional)", { exact: true }).fill("Sign in with any nickname");
        await page.getByRole("button", { name: "Save changes", exact: true }).click();
        await pwExpect(page.getByText("Changes saved", { exact: true })).toBeVisible();
        await pwExpect(page.getByText(/1 test uses these steps/)).toBeVisible();
        expect((await api("GET", `/api/projects/${projectId}/blocks/Sign%20in`)).body.description).toBe("Sign in with any nickname");
    });

    it("refuses to delete reusable steps that are used, and deletes ones that are not", async () => {
        await visit(blocksHash());
        const used = page.getByTestId("block-list").locator("li", { hasText: "Sign in" });
        await used.getByRole("button", { name: "Delete Sign in", exact: true }).click();
        await pwExpect(used.getByText("These steps are in use and can’t be deleted.")).toBeVisible();
        expect(await used.getByRole("button", { name: "Delete reusable steps", exact: true }).count()).toBe(0);
        await used.getByRole("button", { name: "Keep them", exact: true }).click();
        // a set nothing uses
        expect((await api("POST", `/api/projects/${projectId}/blocks`, { name: "Spare", kind: "web", params: [], steps: [{ action: "wait", ms: 100 }] })).status).toBe(201);
        await visit(blocksHash());
        const spare = page.getByTestId("block-list").locator("li", { hasText: "Spare" });
        await spare.getByRole("button", { name: "Delete Spare", exact: true }).click();
        await spare.getByRole("button", { name: "Delete reusable steps", exact: true }).click();
        await pwExpect(page.getByText("Reusable steps deleted", { exact: true })).toBeVisible();
        await pwExpect(page.getByTestId("block-list").locator("li", { hasText: "Spare" })).toHaveCount(0);
        await axeBoth("blocks-list-used");
    });

    it("shows a problem with an error and Try again when the list cannot be loaded", async () => {
        await page.route("**/api/projects/*/blocks", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Internal server error" }) }));
        await visit(blocksHash());
        await pwExpect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
        await page.unroute("**/api/projects/*/blocks");
        await page.getByRole("button", { name: "Try again", exact: true }).click();
        await pwExpect(page.getByTestId("block-list")).toBeVisible();
    });
});

describe("a phone", () => {
    it("has no sideways scroll and big enough targets on the list, the editor and the builder", async () => {
        await page.setViewportSize({ width: 375, height: 800 });
        await visit(blocksHash());
        await pwExpect(page.getByTestId("block-list")).toBeVisible();
        await noOverflow();
        await targets(".blk-row button, .page-actions button, .page-actions a");
        await shot("blocks-list-390");

        await page.getByRole("button", { name: "Edit Sign in", exact: true }).click();
        await pwExpect(page.getByLabel("Name", { exact: true })).toHaveValue("Sign in");
        await heads().first().click();
        await noOverflow();
        await targets(".blk-editor button, .blk-editor select, .blk-editor input:not([type=checkbox])");
        await shot("blocks-editor-390");
        await page.emulateMedia({ colorScheme: "dark" });
        await page.waitForTimeout(400);
        await shot("blocks-editor-390-dark");
        await axe();
        await page.emulateMedia({ colorScheme: null });

        await visit(builderHash(linusId));
        await pwExpect(heads().first()).toBeVisible();
        await heads().nth(1).click();
        await noOverflow();
        await targets(".bld-steps button, .bld-toolbar button, .bld-form select, .bld-form input:not([type=checkbox])");
        await shot("builder-block-390");
        await page.getByRole("button", { name: "Save steps as reusable steps", exact: true }).click();
        await noOverflow();
        await shot("save-as-block-390");
        await page.keyboard.press("Escape");
        await page.setViewportSize({ width: 1280, height: 900 });
    });

    it("never wrote to the browser console as an error", () => {
        expect(consoleErrors).toEqual([]);
    });
});
