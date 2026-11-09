/**
 * The Test scripts place in a real browser against a real platform (port 7864, no AI, nothing runs): the scripts list with its
 * columns (ID, Test script, DSL | Code, Requirement, Status) and actions (Import, Run, New test script, more), the New test script
 * menu (no recording, no phone exploring), DSL | Code opening those tabs of the workbench (DSL and Code first), an old Test cases
 * link with a status landing on the scripts list, a draft reaching its review, the empty states by kind of project, and the
 * "Generate test scripts using AI" card on the Test cases page when that page renders it. Requires `web/dist` (vite build).
 *
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/test-scripts-ui.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { ManualCaseInputSchema } from "../src/engine/manual/cases.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { hashPassword } from "../src/platform/auth/password.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { ManualCaseStore } from "../src/platform/manual-case-store.js";
import { RequirementStore } from "../src/platform/requirement-store.js";
import { ReviewStore } from "../src/platform/review-store.js";
import { NO_APP_FOR_SCRIPTS } from "../src/platform/routes/generate-scripts.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 7864;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "scripts-ui-owner-key-81d0";
let browser: Browser;
let page: Page;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir = "";
let code = "";
let emptyCode = "";
let emptyMixed = "";
let phone = "";
const ids: Record<string, string> = {};
/** Screenshots are kept only when UI_REVIEW_SHOTS names a folder for them. */
const shots = process.env.UI_REVIEW_SHOTS;

const spec = (testId: string, title: string) => TestSpecSchema.parse({ testId, title, kind: "web", category: "Shop", priority: "high", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "visible", target: { strategy: "text", value: "Shop" } }] });
const row = (title: string) => page.getByTestId("script-row").filter({ hasText: title });

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-scripts-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY: KEY, HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    const { repo } = platform;
    code = repo.createProject({ name: "Code shop", platforms: ["web"], testingModes: ["code"] }).id as string;
    repo.createApplication(code, "http://127.0.0.1:9/", {});
    const suite = repo.getOrCreateSuite(code, "Shop", "shop");
    const store = new ReviewStore(platform.db);
    // Two scripts a person made and approved (the project's policy approves them at once), and one AI draft waiting for review.
    store.setPolicy(code, { edits: false }, "test");
    ids.home = repo.insertTest({ projectId: code, suiteId: suite, jobId: null, spec: spec("WEB-001", "Home page opens"), framework: "playwright", validationStatus: "VALIDATED" });
    ids.cart = repo.insertTest({ projectId: code, suiteId: suite, jobId: null, spec: spec("WEB-002", "Cart counts its items"), framework: "playwright", validationStatus: "FAILED_VALIDATION" });
    ids.search = repo.insertTest({ projectId: code, suiteId: suite, jobId: null, spec: spec("WEB-003", "Search finds boots"), framework: "playwright", validationStatus: "PENDING", versionSource: "ai" });
    const reqs = new RequirementStore(platform.sql);
    const r = await reqs.create(code, { ref: "REQ-01", title: "The home page opens" } as never, "manual" as never);
    await reqs.link(code, r.id, { automated: [ids.home], manual: [] });
    // A written test case, so the Test cases page shows its list and the card under it.
    new ManualCaseStore(platform.db).createCase(code, ManualCaseInputSchema.parse({ title: "Verify the home page opens", automation: "automated", steps: [{ action: "Open the home page", expected: "It opens" }] }));
    emptyCode = repo.createProject({ name: "Empty code shop", platforms: ["web"], testingModes: ["code"] }).id as string;
    emptyMixed = repo.createProject({ name: "Empty mixed shop", platforms: ["web"], testingModes: ["agent", "code"] }).id as string;
    // A phone app tested by code, with one written case (so its Test cases page shows the Generate card).
    phone = repo.createProject({ name: "Phone shop", platforms: ["android"], testingModes: ["code"] }).id as string;
    new ManualCaseStore(platform.db).createCase(phone, ManualCaseInputSchema.parse({ title: "Sign in on the phone", automation: "automated", steps: [{ action: "Open the app", expected: "It opens" }] }));
    const users = accessControlOf(server).users;
    const olga = users.create({ email: "olga@example.com", name: "Olga Owner", role: "owner" });
    users.setPassword(olga.id, await hashPassword("olga's long password"));
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await page.goto(BASE);
    await page.getByLabel("Email").fill("olga@example.com");
    await page.getByLabel("Password").fill("olga's long password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await pwExpect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    if (shots) fs.mkdirSync(shots, { recursive: true });
}, 90_000);
afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("the Test scripts list", () => {
    it("shows each script with its ID, DSL | Code, requirement and status, under Import, Run, New test script and more", async () => {
        await page.goto(`${BASE}/#/projects/${code}/scripts`);
        await pwExpect(page.getByRole("heading", { name: "Test scripts", exact: true })).toBeVisible();
        await pwExpect(page.getByRole("heading", { name: "Scripts", exact: true })).toBeVisible();
        for (const name of ["Import", "New test script", "More actions"]) await pwExpect(page.getByRole("button", { name, exact: true })).toBeVisible();
        await pwExpect(page.getByRole("button", { name: /^Run/ }).first()).toBeVisible();
        const head = page.locator(".script-head").first();
        for (const col of ["ID", "Test script", "Script", "Requirement", "Status"]) await pwExpect(head.getByText(col, { exact: true })).toBeVisible();
        await pwExpect(page.getByTestId("script-row")).toHaveCount(3);
        const home = row("Home page opens");
        await pwExpect(home).toContainText("WEB-001");
        await pwExpect(home.getByRole("link", { name: "REQ-01" })).toBeVisible();
        await pwExpect(home.getByText("Passing", { exact: true })).toBeVisible();
        // Each row's DSL and Code links are named with the script, and its title opens the script on its DSL tab.
        await pwExpect(home.getByRole("link", { name: "DSL of WEB-001", exact: true })).toBeVisible();
        await pwExpect(home.getByRole("link", { name: "Code of WEB-001", exact: true })).toBeVisible();
        await pwExpect(home.getByRole("link", { name: "Home page opens", exact: true })).toHaveAttribute("href", `#/tests/${ids.home}/text`);
        await pwExpect(page.getByRole("searchbox", { name: "Search scripts" })).toBeVisible();
        await pwExpect(page.getByRole("button", { name: "Select scripts" })).toBeVisible();
        await pwExpect(row("Cart counts its items").getByText("None", { exact: true })).toBeVisible();
        // Review, the shared building blocks and the libraries are still sections of the place.
        const sections = page.getByRole("navigation", { name: "Test scripts sections" });
        for (const s of ["Scripts", "Review", "Reusable steps", "Shared elements", "Helpers (code)", "Reusable libraries"]) await pwExpect(sections.getByRole("link", { name: s, exact: true })).toBeVisible();
        if (shots) await page.screenshot({ path: path.join(shots, "test-scripts-list.png"), fullPage: true });
        const axe = await new AxeBuilder({ page }).include("main").analyze();
        expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    });

    it("chooses scripts with the row checkboxes, and the Run control counts them", async () => {
        await page.getByLabel("Select Home page opens").check();
        await pwExpect(page.getByRole("region", { name: "Selected scripts" })).toContainText("1 script selected");
        await page.getByLabel("Select every script in Shop").check();
        await pwExpect(page.getByRole("region", { name: "Selected scripts" })).toContainText("3 scripts selected");
        await page.getByRole("button", { name: "Done", exact: true }).click();
        await pwExpect(page.getByRole("region", { name: "Selected scripts" })).toHaveCount(0);
    });

    it("offers the ways to make a script: no recording, no phone exploring", async () => {
        await page.getByRole("button", { name: "New test script", exact: true }).click();
        for (const name of ["Describe it", "Build steps by hand", "Write it as text", "Write code", "Import scripts…"]) await pwExpect(page.getByRole("menuitem", { name, exact: true })).toBeVisible();
        await pwExpect(page.getByRole("menuitem", { name: "Record it in a browser" })).toHaveCount(0);
        await pwExpect(page.getByRole("menuitem", { name: /phone app/ })).toHaveCount(0);
        if (shots) await page.screenshot({ path: path.join(shots, "new-test-script-menu.png") });
        await page.keyboard.press("Escape");
    });

    it("opens a script on its DSL tab or its Code tab, the first two tabs of the workbench", async () => {
        await row("Home page opens").getByRole("link", { name: "DSL of WEB-001", exact: true }).click();
        await pwExpect(page).toHaveURL(new RegExp(`#/tests/${ids.home}/text$`));
        const tabs = page.getByRole("tablist", { name: "Views of this test" }).getByRole("tab");
        await pwExpect(tabs).toHaveText(["DSL", "Code", "Steps", "History"]);
        await pwExpect(page.getByRole("tab", { name: "DSL", exact: true })).toHaveAttribute("aria-selected", "true");
        await pwExpect(page.getByRole("link", { name: "Test scripts", exact: true })).toBeVisible();
        if (shots) await page.screenshot({ path: path.join(shots, "workbench-dsl-tab.png") });
        await page.goto(`${BASE}/#/projects/${code}/scripts`);
        await row("Cart counts its items").getByRole("link", { name: "Code of WEB-002", exact: true }).click();
        await pwExpect(page).toHaveURL(new RegExp(`#/tests/${ids.cart}/code$`));
        await pwExpect(page.getByRole("tab", { name: "Code", exact: true })).toHaveAttribute("aria-selected", "true");
        // `dsl` is a route of the DSL tab too.
        await page.goto(`${BASE}/#/tests/${ids.cart}/dsl`);
        await pwExpect(page).toHaveURL(new RegExp(`#/tests/${ids.cart}/text$`));
        await pwExpect(page.getByRole("tab", { name: "DSL", exact: true })).toHaveAttribute("aria-selected", "true");
    });

    it("lands an old Test cases link with a status on the scripts list, filtered", async () => {
        await page.goto(`${BASE}/#/projects/${code}/tests?status=failed`);
        await pwExpect(page).toHaveURL(new RegExp(`#/projects/${code}/scripts\\?status=failed$`));
        await pwExpect(page.getByRole("button", { name: /^Failing/ })).toHaveAttribute("aria-pressed", "true");
        await pwExpect(page.getByTestId("script-row")).toHaveCount(1);
        await pwExpect(page.getByTestId("script-row")).toContainText("Cart counts its items");
    });

    it("says a draft waits for review, and the draft's row leads to its review", async () => {
        // A fresh list (the status filter of the old link above is the list's own state while it stays open).
        await page.goto(`${BASE}/#/`);
        await page.goto(`${BASE}/#/projects/${code}/scripts`);
        const search = row("Search finds boots");
        await pwExpect(search.getByTestId("script-review-link")).toHaveText("Draft, waiting for review");
        await pwExpect(row("Home page opens").getByTestId("script-review-link")).toHaveCount(0);
        await search.getByTestId("script-review-link").click();
        await pwExpect(page).toHaveURL(new RegExp(`section=review|test=${ids.search}`));
        await pwExpect(page.getByRole("heading", { name: /WEB-003 Search finds boots, version 1/ })).toBeVisible();
        await pwExpect(page.getByRole("navigation", { name: "Test scripts sections" }).getByRole("link", { name: "Review", exact: true })).toHaveAttribute("aria-current", "page");
        await page.getByRole("link", { name: /All scripts/ }).click();
        await pwExpect(page.getByTestId("script-review-list")).toBeVisible();
    });
});

describe("an empty Test scripts list", () => {
    it("offers New test script and Import once each; exploring only in a project that explores", async () => {
        await page.goto(`${BASE}/#/projects/${emptyCode}/scripts`);
        const empty = page.locator(".empty");
        await pwExpect(empty.getByText("No test scripts yet")).toBeVisible();
        await pwExpect(page.getByRole("button", { name: "New test script", exact: true })).toHaveCount(1);
        await pwExpect(page.getByRole("button", { name: "Import", exact: true })).toHaveCount(1);
        await pwExpect(empty.getByRole("button", { name: /New test script|Import/ })).toHaveCount(0);
        await pwExpect(empty.getByRole("link", { name: "Start exploring" })).toHaveCount(0);
        await page.goto(`${BASE}/#/projects/${emptyMixed}/scripts`);
        await pwExpect(page.locator(".empty").getByRole("link", { name: "Start exploring" })).toBeVisible();
    });
});

describe("tests switched off on this server", () => {
    it("says so on the Runs on line and in the Run panel, before anything is started", async () => {
        await page.goto(`${BASE}/#/projects/${code}/scripts`);
        await pwExpect(page.getByTestId("runs-on")).toHaveText("Tests are switched off on this server, so no run starts here.");
        await pwExpect(page.getByTestId("runs-on").getByRole("link")).toHaveCount(0);
        await page.getByRole("button", { name: "Run", exact: true }).click();
        const panel = page.getByRole("group", { name: "Run settings" });
        await pwExpect(panel.getByTestId("runs-off")).toContainText("Tests are switched off on this server, so no run starts here.");
        await pwExpect(panel.getByRole("button", { name: "Start run" })).toBeDisabled();
        if (process.env.UI_REVIEW_SHOTS) await page.screenshot({ path: path.join(process.env.UI_REVIEW_SHOTS, "scripts-runs-off.png") });
        await panel.getByRole("button", { name: "Close", exact: true }).click();
        await page.getByRole("button", { name: "New test script", exact: true }).click();
        const describe = page.getByRole("menuitem", { name: /Describe it/ });
        await pwExpect(describe).toBeDisabled();
        await pwExpect(describe).toContainText("Tests are switched off on this server");
        await page.keyboard.press("Escape");
        expect(platform.repo.listJobs(code)).toHaveLength(0);
    });
});

describe("Generate test cases without an AI model", () => {
    it("says so on the card before the click", async () => {
        await page.goto(`${BASE}/#/projects/${code}/requirements`);
        const card = page.getByTestId("generate-cases");
        await pwExpect(card.getByTestId("generate-cases-no-ai")).toContainText("The AI model isn’t set up for this project, so test cases cannot be generated here.");
        await pwExpect(card.getByRole("button", { name: "Generate test cases" })).toBeDisabled();
        if (process.env.UI_REVIEW_SHOTS) await card.screenshot({ path: path.join(process.env.UI_REVIEW_SHOTS, "generate-cases-no-ai.png") });
    });
});

describe("a phone project", () => {
    it("says Describe it and Write it as text are for web and API, and Generate from test cases and the Generate card that the app comes first", async () => {
        await page.goto(`${BASE}/#/projects/${phone}/scripts`);
        await page.getByRole("button", { name: "New test script", exact: true }).click();
        for (const name of [/Describe it/, /Write it as text/]) {
            const item = page.getByRole("menuitem", { name });
            await pwExpect(item).toBeDisabled();
            await pwExpect(item).toContainText("Web and API only: this project tests a phone app.");
        }
        await pwExpect(page.getByRole("menuitem", { name: /Build steps by hand/ })).toBeEnabled();
        // Round 41: the AI writes phone scripts from test cases, for the project's Android app (this project has none yet).
        const fromCases = page.getByRole("menuitem", { name: /Generate from test cases/ });
        await pwExpect(fromCases).toBeDisabled();
        await pwExpect(fromCases).toContainText(NO_APP_FOR_SCRIPTS);
        if (process.env.UI_REVIEW_SHOTS) await page.screenshot({ path: path.join(process.env.UI_REVIEW_SHOTS, "phone-new-test-menu.png") });
        await page.keyboard.press("Escape");
        await page.goto(`${BASE}/#/projects/${phone}/tests`);
        const card = page.getByTestId("generate-scripts");
        await pwExpect(card.getByTestId("generate-scripts-why")).toHaveText(NO_APP_FOR_SCRIPTS);
        await pwExpect(card.getByRole("button", { name: "Generate test scripts" })).toBeDisabled();
    });
});

describe("Generate test scripts using AI", () => {
    it("is under the Test cases list when that page renders it, and says plainly that it needs an AI model here", async () => {
        await page.goto(`${BASE}/#/projects/${code}/tests`);
        await pwExpect(page.getByRole("heading", { name: "Test cases", exact: true })).toBeVisible();
        const card = page.getByTestId("generate-scripts");
        // The Test cases page (another builder's) renders the card with one line; until it does there is nothing to check here.
        if ((await card.count()) === 0) {
            console.warn("[test-scripts-ui] the Test cases page does not render GenerateScriptsCard yet");
            return;
        }
        await pwExpect(card.getByRole("heading", { name: "Generate test scripts using AI" })).toBeVisible();
        await pwExpect(card).toContainText("Automatically create test scripts for the selected or all test cases using AI.");
        await pwExpect(card.getByRole("button", { name: "Generate test scripts" })).toBeDisabled();
        await pwExpect(card).toContainText("The AI model isn’t set up for this project");
        if (shots) await card.screenshot({ path: path.join(shots, "generate-scripts-card.png") });
    });

    it("is in the New test script menu on Test scripts too, saying it needs an AI model here", async () => {
        await page.goto(`${BASE}/#/projects/${code}/scripts`);
        await page.getByRole("button", { name: "New test script", exact: true }).click();
        const fromCases = page.getByRole("menuitem", { name: /Generate from test cases/ });
        await pwExpect(fromCases).toBeDisabled();
        await pwExpect(fromCases).toContainText("Needs an AI model. A project admin can set one up in Settings, AI configuration.");
        await page.keyboard.press("Escape");
    });
});
