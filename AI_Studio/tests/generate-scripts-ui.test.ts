/**
 * "Generate from test cases" on Test scripts in a real browser against a real platform (port 8521, the local fake AI provider on 8522,
 * never a real model, nothing runs): the New test script menu offers it, the dialog lists the written test cases with the Test cases
 * list's checkboxes (Manual cases and cases with a script cannot be chosen, and say why), and for an Android project the AI's phone
 * script is saved as a draft that the list behind the dialog shows at once, saying it needs checking on the device. A project the AI
 * cannot write for (iOS only, Android without its app) is told so in the menu, before the click. Requires `web/dist` (vite build).
 *
 *   TAQWRIGHT_HOME=/nonexistent-taqwright node scripts/with-lock.mjs browser -- npx vitest run tests/generate-scripts-ui.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { CHECK_ON_DEVICE } from "../src/engine/authoring/case-phone-script.js";
import { ManualCaseInputSchema } from "../src/engine/manual/cases.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { hashPassword } from "../src/platform/auth/password.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { ManualCaseStore } from "../src/platform/manual-case-store.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { RequirementStore } from "../src/platform/requirement-store.js";
import { ReviewStore } from "../src/platform/review-store.js";
import { IOS_PROJECT, NO_ADDRESS_FOR_SCRIPTS, NO_APP_FOR_SCRIPTS } from "../src/platform/routes/generate-scripts.js";
import { buildServer } from "../src/platform/server.js";
import { NO_PERMISSION_HERE } from "../web/src/features/auth/project-access-rules.js";
import { startFakeProvider, type FakeProvider } from "./fixtures/fake-llm-provider.js";

const PORT = 8521;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "gen-scripts-ui-key-5e19a0";
const MODEL = "ui-script-model";
let fake: FakeProvider;
let browser: Browser;
let page: Page;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir = "";
let phone = "";
let iphone = "";
let noApp = "";
let noAddress = "";
const cases: Record<string, { id: string; ref: string }> = {};
const shots = process.env.UI_REVIEW_SHOTS;

const PHONE_ANSWER = JSON.stringify({
    steps: [
        { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}" },
        { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" },
        { action: "click", locator: { by: "text", value: "Sign in" } },
        { action: "assert", check: "visible", locator: { by: "text", value: "Welcome" } },
    ],
});

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    fake = await startFakeProvider(8522);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-genscripts-ui-"));
    platform = bootstrap(
        loadConfig({ DATA_DIR: dataDir, API_KEY: KEY, HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", LLM_PROVIDER: "openai-compatible", LLM_BASE_URL: `${fake.url}/openai/v1`, LLM_MODEL: MODEL, LLM_API_KEY: "fake-key" }),
    );
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    const { repo } = platform;
    phone = repo.createProject({ name: "Phone shop", platforms: ["android"], testingModes: ["code"] }).id as string;
    repo.createApplication(phone, "android-app://com.example.shop", { ...DEFAULT_JOB_OPTIONS, mobile: { appPackage: "com.example.shop" } });
    const req = await new RequirementStore(platform.sql).create(phone, { ref: "REQ-01", title: "People can sign in" } as never, "manual" as never);
    const store = new ManualCaseStore(platform.db);
    const add = (title: string, automation: "automated" | "manual", extra: Record<string, unknown> = {}) => store.createCase(phone, ManualCaseInputSchema.parse({ title, automation, area: "Accounts", steps: [{ action: "Sign in with the test account", expected: "Welcome is shown" }], ...extra }));
    for (const [k, c] of Object.entries({ signIn: add("Verify sign in on the phone", "automated", { requirementId: req.id }), splash: add("Verify the splash screen looks right", "manual"), search: add("Verify search finds boots", "automated") })) cases[k] = { id: c.id, ref: c.ref };
    iphone = repo.createProject({ name: "iPhone shop", platforms: ["ios"], testingModes: ["code"] }).id as string;
    noApp = repo.createProject({ name: "Phone shop without its app", platforms: ["android"], testingModes: ["code"] }).id as string;
    noAddress = repo.createProject({ name: "Web shop without its address", platforms: ["web"], testingModes: ["code"] }).id as string;
    const users = accessControlOf(server).users;
    // Pat may write tests on this platform, but is only a viewer of the phone project (the permissions that count there).
    const pat = users.create({ email: "pat@example.com", name: "Pat Viewer", role: "editor" });
    users.setPassword(pat.id, await hashPassword("pat's long password"));
    const scope = accessControlOf(server).projects.store;
    scope.setMode(pat.id, "only");
    scope.addMember(phone, pat.id, { role: "viewer", projectAdmin: false, source: "added", addedBy: "test" });
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
    await fake?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("Generate from test cases, on Test scripts", () => {
    it("lists the test cases to choose from, Manual ones not choosable, and writes a phone script for the chosen one as a draft", async () => {
        await page.goto(`${BASE}/#/projects/${phone}/scripts`);
        await pwExpect(page.getByRole("heading", { name: "Test scripts", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "New test script", exact: true }).click();
        const entry = page.getByRole("menuitem", { name: /Generate from test cases/ });
        await pwExpect(entry).toBeEnabled();
        await pwExpect(entry).toContainText("The AI writes a script for each Automated test case you choose. Uses the AI model.");
        await entry.click();

        const dialog = page.getByRole("dialog", { name: "Generate test scripts from test cases" });
        await pwExpect(dialog).toBeVisible();
        await pwExpect(dialog).toContainText("This project tests an Android app, so the AI writes phone test scripts.");
        const rows = dialog.getByTestId("gen-case-row");
        await pwExpect(rows).toHaveCount(3);
        await pwExpect(rows.filter({ hasText: "Verify sign in on the phone" })).toContainText("REQ-01");
        await pwExpect(dialog.getByLabel(`Choose ${cases.splash!.ref}`)).toBeDisabled();
        await pwExpect(rows.filter({ hasText: "Verify the splash screen" })).toContainText("Manual: a person does it");
        const go = dialog.getByRole("button", { name: /^Generate/ });
        await pwExpect(go).toBeDisabled();
        await dialog.getByLabel(`Choose ${cases.signIn!.ref}`).check();
        await pwExpect(dialog.getByRole("button", { name: "Generate 1 test script", exact: true })).toBeEnabled();
        if (shots) await page.screenshot({ path: path.join(shots, "generate-from-cases-dialog.png") });
        const axe = await new AxeBuilder({ page }).include("dialog").analyze();
        expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);

        fake.reset();
        fake.queue(MODEL, { text: PHONE_ANSWER });
        await dialog.getByRole("button", { name: "Generate 1 test script", exact: true }).click();
        await pwExpect(dialog.getByText("Test scripts generated")).toBeVisible();
        await pwExpect(dialog).toContainText("1 phone test script has been created from your test cases. The AI wrote it without seeing the app: check it on the device, then approve it to run it.");
        // The case got its script, so it cannot be chosen again.
        await pwExpect(dialog.getByLabel(`Choose ${cases.signIn!.ref}`)).toBeDisabled();
        await pwExpect(rows.filter({ hasText: "Verify sign in on the phone" })).toContainText("Has its script");
        expect(fake.seen).toHaveLength(1);
        if (shots) await page.screenshot({ path: path.join(shots, "generate-from-cases-done.png") });
        await dialog.getByRole("button", { name: "Close", exact: true }).click();
        await pwExpect(dialog).toHaveCount(0);

        // The list behind the dialog shows the new script at once, as a draft waiting for review, linked to the case's requirement.
        const row = page.getByTestId("script-row").filter({ hasText: "Verify sign in on the phone" });
        await pwExpect(row).toBeVisible();
        await pwExpect(row.getByTestId("script-review-link")).toHaveText("Draft, waiting for review");
        await pwExpect(row.getByRole("link", { name: "REQ-01" })).toBeVisible();
        const made = platform.repo.listTests(phone).find((t) => t.title === "Verify sign in on the phone")!;
        expect(made.spec).toMatchObject({ kind: "mobile", platform: "android", description: CHECK_ON_DEVICE });
        expect(new ReviewStore(platform.db).latest(made.id)).toMatchObject({ source: "ai", state: "draft" });
        expect(platform.repo.listJobs(phone)).toHaveLength(0);
    });

    it("says before the click why it cannot write here: an iOS-only project, an Android project without its app", async () => {
        for (const [pid, why] of [
            [iphone, IOS_PROJECT],
            [noApp, NO_APP_FOR_SCRIPTS],
            // A web project without its address is told before the dry run, not after it (review R5, L6b).
            [noAddress, NO_ADDRESS_FOR_SCRIPTS],
        ] as const) {
            await page.goto(`${BASE}/#/projects/${pid}/scripts`);
            await page.getByRole("button", { name: "New test script", exact: true }).click();
            const entry = page.getByRole("menuitem", { name: /Generate from test cases/ });
            await pwExpect(entry).toBeDisabled();
            await pwExpect(entry).toContainText(why);
            await page.keyboard.press("Escape");
        }
    });

    it("follows the person's permissions in this project, not the platform's: a project viewer sees it disabled, with why (review R5, L6a)", async () => {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const p2 = await ctx.newPage();
        try {
            await p2.goto(BASE);
            await p2.getByLabel("Email").fill("pat@example.com");
            await p2.getByLabel("Password").fill("pat's long password");
            await p2.getByRole("button", { name: "Sign in" }).click();
            await pwExpect(p2.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
            await p2.goto(`${BASE}/#/projects/${phone}/scripts`);
            // Every way in makes a test script, which a viewer of this project may not: the menu itself is switched off with the reason.
            const menu = p2.getByRole("button", { name: "New test script", exact: true });
            await pwExpect(menu).toHaveAttribute("aria-disabled", "true");
            await menu.hover();
            await pwExpect(p2.locator(".tt:not([hidden])").filter({ hasText: NO_PERMISSION_HERE["ai_studio.tests.write"]! })).toBeVisible();
            await menu.click({ force: true });
            await pwExpect(p2.getByRole("menuitem", { name: /Generate from test cases/ })).toHaveCount(0);
            // The card under the Test cases list is not offered either.
            await p2.goto(`${BASE}/#/projects/${phone}/tests`);
            await pwExpect(p2.getByRole("heading", { name: "Test cases", exact: true })).toBeVisible();
            await pwExpect(p2.getByRole("link", { name: "Verify search finds boots" })).toBeVisible();
            await p2.waitForTimeout(500);
            await pwExpect(p2.getByTestId("generate-scripts")).toHaveCount(0);
        } finally {
            await ctx.close();
        }
    });
});
