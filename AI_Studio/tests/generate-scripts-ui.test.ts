/**
 * Generating test scripts from test cases in a real browser against a real platform (port 8521, the local fake AI provider on 8522,
 * never a real model, nothing runs). It lives on Test cases only (the card under the list): the New test script menu on Test scripts
 * does not repeat it. The card works on the cases chosen in the list; for an Android project the AI's phone script is saved as a
 * draft that Test scripts shows, saying it needs checking on the device. A project the AI cannot write for (iOS only, Android without
 * its app, web without its address) is told so on the card, before the click. A web script is built, not run (sheet #27): the card says
 * so, and while the scripts are built the case list and Test scripts fill by themselves, with the count (sheet #26). Requires `web/dist`
 * (vite build).
 *
 *   TAQWRIGHT_HOME=/nonexistent-taqwright node scripts/with-lock.mjs browser -- npx vitest run tests/generate-scripts-ui.test.ts */
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
import { afterCaseJob } from "../src/platform/case-scripts.js";
import { ManualCaseStore } from "../src/platform/manual-case-store.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { RequirementStore } from "../src/platform/requirement-store.js";
import { ReviewStore } from "../src/platform/review-store.js";
import { IOS_PROJECT, NO_ADDRESS_FOR_SCRIPTS, NO_APP_FOR_SCRIPTS } from "../src/platform/routes/generate-scripts.js";
import { buildServer } from "../src/platform/server.js";
import { NO_PERMISSION_HERE } from "../web/src/features/auth/project-access-rules.js";
import { givePersonalKeys } from "./fixtures/ai-key.js";
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
let web = "";
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
        loadConfig({ DATA_DIR: dataDir, API_KEY: KEY, HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "true", LLM_PROVIDER: "openai-compatible", LLM_BASE_URL: `${fake.url}/openai/v1`, LLM_MODEL: MODEL, LLM_API_KEY: "fake-key" }),
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
    // A web project (its application is never opened here: no worker runs the jobs, the test plays their end).
    web = repo.createProject({ name: "Web shop", platforms: ["web"], testingModes: ["code"] }).id as string;
    repo.createApplication(web, "http://127.0.0.1:8523", { ...DEFAULT_JOB_OPTIONS });
    cases.webSignIn = (({ id, ref }) => ({ id, ref }))(store.createCase(web, ManualCaseInputSchema.parse({ title: "Sign in with valid credentials", automation: "automated", area: "Accounts", steps: [{ action: "Sign in with the saved account", expected: "The user is signed in" }] })));
    iphone = repo.createProject({ name: "iPhone shop", platforms: ["ios"], testingModes: ["code"] }).id as string;
    noApp = repo.createProject({ name: "Phone shop without its app", platforms: ["android"], testingModes: ["code"] }).id as string;
    noAddress = repo.createProject({ name: "Web shop without its address", platforms: ["web"], testingModes: ["code"] }).id as string;
    // The card shows under a list that has cases.
    for (const pid of [iphone, noApp, noAddress]) store.createCase(pid, ManualCaseInputSchema.parse({ title: "Verify sign in", automation: "automated", area: "Accounts", steps: [{ action: "Sign in", expected: "Welcome is shown" }] }));
    const users = accessControlOf(server).users;
    // Pat may write tests on this platform, but is only a viewer of the phone project (the permissions that count there).
    const pat = users.create({ email: "pat@example.com", name: "Pat Viewer", role: "editor" });
    users.setPassword(pat.id, await hashPassword("pat's long password"));
    const scope = accessControlOf(server).projects.store;
    scope.setMode(pat.id, "only");
    scope.addMember(phone, pat.id, { role: "viewer", projectAdmin: false, source: "added", addedBy: "test" });
    const olga = users.create({ email: "olga@example.com", name: "Olga Owner", role: "owner" });
    users.setPassword(olga.id, await hashPassword("olga's long password"));
    // Olga's AI work uses her own key on the stand-in provider (round 57: never the server's key).
    await givePersonalKeys(platform, [olga.id], { baseUrl: `${fake.url}/openai/v1`, model: MODEL });
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

describe("Generate test scripts, on Test cases", () => {
    it("is not repeated in the New test script menu on Test scripts", async () => {
        await page.goto(`${BASE}/#/projects/${phone}/scripts`);
        await pwExpect(page.getByRole("heading", { name: "Test scripts", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "New test script", exact: true }).click();
        await pwExpect(page.getByRole("menuitem", { name: "Build steps by hand", exact: true })).toBeVisible();
        await pwExpect(page.getByRole("menuitem", { name: /Generate from test cases/ })).toHaveCount(0);
        await page.keyboard.press("Escape");
    });

    it("writes a phone script for the chosen Automated case as a draft, which Test scripts shows", async () => {
        await page.goto(`${BASE}/#/projects/${phone}/tests`);
        await pwExpect(page.getByRole("heading", { name: "Test cases", exact: true })).toBeVisible();
        const card = page.getByTestId("generate-scripts");
        await pwExpect(card).toContainText("This project tests an Android app, so the AI writes phone test scripts.");
        await page.getByLabel(`Choose ${cases.signIn!.ref}`, { exact: true }).check();
        await card.getByRole("button", { name: "Generate test scripts", exact: true }).click();
        await pwExpect(card.getByText("Generate 1 phone test script?")).toBeVisible();
        if (shots) await page.screenshot({ path: path.join(shots, "generate-scripts-confirm.png") });
        const axe = await new AxeBuilder({ page }).include("[data-testid=generate-scripts]").analyze();
        expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);

        fake.reset();
        fake.queue(MODEL, { text: PHONE_ANSWER });
        await card.getByRole("button", { name: "Generate 1 script", exact: true }).click();
        await pwExpect(card.getByText("Test scripts generated")).toBeVisible();
        await pwExpect(card).toContainText("1 phone test script has been created from your test cases. The AI wrote it without seeing the app: check it on the device, then approve it to run it.");
        expect(fake.seen).toHaveLength(1);
        if (shots) await page.screenshot({ path: path.join(shots, "generate-scripts-done.png") });

        // The card leads to Test scripts, where the new script is a draft waiting for review, linked to the case's requirement.
        await card.getByRole("link", { name: "View test scripts", exact: true }).click();
        const row = page.getByTestId("script-row").filter({ hasText: "Verify sign in on the phone" });
        await pwExpect(row).toBeVisible();
        await pwExpect(row.getByTestId("script-review-link")).toHaveText("Draft, waiting for review");
        await pwExpect(row.getByRole("link", { name: "REQ-01" })).toBeVisible();
        const made = platform.repo.listTests(phone).find((t) => t.title === "Verify sign in on the phone")!;
        expect(made.spec).toMatchObject({ kind: "mobile", platform: "android", description: CHECK_ON_DEVICE });
        expect(new ReviewStore(platform.db).latest(made.id)).toMatchObject({ source: "ai", state: "draft" });
        expect(platform.repo.listJobs(phone)).toHaveLength(0);
    });

    it("builds a web project's scripts as Describe it builds a test, and follows them until each case has its script", async () => {
        await page.goto(`${BASE}/#/projects/${web}/tests`);
        const card = page.getByTestId("generate-scripts");
        await card.getByRole("button", { name: "Generate test scripts", exact: true }).click();
        await pwExpect(card.getByText("Generate 1 test script?")).toBeVisible();
        await pwExpect(card).toContainText("The AI does each test case's steps in a real browser on the application, signed in with the project's sign-in");
        await pwExpect(card).toContainText("The scripts are not run: you run them with Run when you are ready.");
        fake.reset();
        await card.getByRole("button", { name: "Generate 1 script", exact: true }).click();
        await pwExpect(card.getByTestId("generate-scripts-building")).toContainText("Building test scripts: 0 of 1");
        if (shots) await page.screenshot({ path: path.join(shots, "generate-web-scripts-building.png") });
        // Nothing was written without the application: the job builds it.
        expect(fake.seen).toHaveLength(0);
        const [job] = platform.repo.listJobs(web);
        expect(job!.options).toMatchObject({ mode: "plain", plainCaseId: cases.webSignIn!.id });

        // The job's end, played here: it made a test, and that test becomes the case's script.
        const imported = await server.inject({ method: "POST", url: `/api/projects/${web}/specs`, headers: { "x-api-key": KEY }, payload: { validate: false, specs: [{ title: "Sign in with valid credentials", kind: "web", category: "Plain English", steps: [{ action: "navigate", url: "/" }] }] } });
        expect(imported.statusCode, imported.body).toBe(202);
        platform.db.run("UPDATE test_cases SET job_id = ? WHERE id = ?", job!.id, JSON.parse(imported.body).tests[0].id);
        platform.repo.setJobStatus(job!.id, "COMPLETED");
        expect(await afterCaseJob(platform.repo, job!)).toBeNull();
        await pwExpect(card.getByText("Test scripts generated")).toBeVisible({ timeout: 15_000 });
        await pwExpect(card).toContainText("1 test script has been created from your test cases. It is ready to run and has not been run yet: run it from Test scripts with Run when you are ready.");
        if (shots) await page.screenshot({ path: path.join(shots, "generate-web-scripts-done.png") });
    });

    it("writes 8 phone scripts in one click, a few at a time with the progress, and names the cases left when a request is refused (sheet #12)", async () => {
        const { repo } = platform;
        const store = new ManualCaseStore(platform.db);
        const pid = repo.createProject({ name: "Eight phone shop", platforms: ["android"], testingModes: ["code"] }).id as string;
        repo.createApplication(pid, "android-app://com.example.eight", { ...DEFAULT_JOB_OPTIONS, mobile: { appPackage: "com.example.eight" } });
        const eight = Array.from({ length: 8 }, (_, i) => store.createCase(pid, ManualCaseInputSchema.parse({ title: `Verify screen ${i + 1}`, automation: "automated", area: "Screens", steps: [{ action: "Open it", expected: "Welcome is shown" }] })));
        await page.goto(`${BASE}/#/projects/${pid}/tests`);
        const card = page.getByTestId("generate-scripts");
        await card.getByRole("button", { name: "Generate test scripts", exact: true }).click();
        await pwExpect(card.getByText("Generate 8 phone test scripts?")).toBeVisible();
        fake.reset();
        fake.queue(MODEL, ...Array.from({ length: 5 }, () => ({ text: PHONE_ANSWER, delayMs: 400 })));
        // The second request (the last three) is refused as a whole, as the AI limit refuses it.
        const LIMIT = "The AI token limit was reached, so the AI cannot write test scripts now. You can still write them by hand.";
        let posts = 0;
        await page.route(`**/api/projects/${pid}/manual-cases/generate-scripts`, async (route) => {
            if (route.request().method() === "POST" && !JSON.parse(route.request().postData() ?? "{}").dryRun && ++posts === 2) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: LIMIT }) });
            return route.fallback();
        });
        await card.getByRole("button", { name: "Generate 8 scripts", exact: true }).click();
        await pwExpect(card.getByText("Writing test scripts: 0 of 8")).toBeVisible();
        await pwExpect(card.getByText("Test scripts generated")).toBeVisible({ timeout: 20_000 });
        await pwExpect(card).toContainText("5 phone test scripts have been created");
        const left = card.getByTestId("scripts-not-written");
        await pwExpect(left.getByRole("listitem")).toHaveCount(3);
        for (const c of eight.slice(5)) await pwExpect(left).toContainText(`${c.ref} got no script: ${LIMIT}`);
        if (shots) await page.screenshot({ path: path.join(shots, "generate-scripts-left.png") });
        await page.unroute(`**/api/projects/${pid}/manual-cases/generate-scripts`);
        fake.reset();
        fake.queue(MODEL, ...Array.from({ length: 3 }, () => ({ text: PHONE_ANSWER })));
        await card.getByRole("button", { name: "Try these 3 again", exact: true }).click();
        await pwExpect(card).toContainText("3 phone test scripts have been created");
        expect(fake.seen).toHaveLength(3);
        expect(store.listCases(pid).filter((c) => c.linkedTestIds.length === 1)).toHaveLength(8);
    });

    it("follows a web project's chain past a case that got no script, names it with its run's reason, and builds only that one again", async () => {
        const { repo } = platform;
        const store = new ManualCaseStore(platform.db);
        const pid = repo.createProject({ name: "Chain web shop", platforms: ["web"], testingModes: ["code"] }).id as string;
        repo.createApplication(pid, "http://127.0.0.1:8523", { ...DEFAULT_JOB_OPTIONS });
        const three = ["Verify the home page", "Verify the search", "Verify the basket"].map((title) => store.createCase(pid, ManualCaseInputSchema.parse({ title, automation: "automated", area: "Shop", steps: [{ action: "Open it", expected: "It shows" }] })));
        await page.goto(`${BASE}/#/projects/${pid}/tests`);
        const card = page.getByTestId("generate-scripts");
        await card.getByRole("button", { name: "Generate test scripts", exact: true }).click();
        await card.getByRole("button", { name: "Generate 3 scripts", exact: true }).click();
        await pwExpect(card.getByTestId("generate-scripts-building")).toContainText("Building test scripts: 0 of 3");
        /** The job's end, played here: with a test it made, or failed with a reason. */
        const end = async (job: any, made: boolean, error?: string) => {
            if (made) {
                const imported = await server.inject({ method: "POST", url: `/api/projects/${pid}/specs`, headers: { "x-api-key": KEY }, payload: { validate: false, specs: [{ title: job.options.plainDescription.split("\n")[0], kind: "web", category: "Plain English", steps: [{ action: "navigate", url: "/" }] }] } });
                platform.db.run("UPDATE test_cases SET job_id = ? WHERE id = ?", job.id, JSON.parse(imported.body).tests[0].id);
                repo.setJobStatus(job.id, "COMPLETED");
            } else repo.setJobStatus(job.id, "FAILED", error);
            return afterCaseJob(repo, job);
        };
        const first = repo.listJobs(pid)[0]!;
        const second = (await end(first, true))!;
        await pwExpect(card.getByTestId("generate-scripts-building")).toContainText("Building test scripts: 1 of 3 generated", { timeout: 10_000 });
        // The case list shows the first script while the others are still being built, without a reload (sheet #26).
        await pwExpect(page.getByRole("link", { name: new RegExp(`^Test script \\S+: ${three[0]!.title}$`) })).toBeVisible({ timeout: 10_000 });
        await pwExpect(page.getByRole("link", { name: new RegExp(`^Test script \\S+: ${three[0]!.title}$`) })).toContainText("Not run yet");
        const third = (await end(second, false, "The search box could not be found"))!;
        expect(third.options.plainCaseId).toBe(three[2]!.id);
        expect(await end(third, true)).toBeNull();
        await pwExpect(card.getByText("Test scripts generated")).toBeVisible({ timeout: 15_000 });
        await pwExpect(card).toContainText("2 test scripts have been created");
        await pwExpect(card.getByTestId("scripts-not-written")).toContainText(`${three[1]!.ref} got no script: The search box could not be found.`);
        if (shots) await page.screenshot({ path: path.join(shots, "generate-web-scripts-left.png") });
        await card.getByRole("button", { name: "Try it again", exact: true }).click();
        await pwExpect(card.getByTestId("generate-scripts-building")).toContainText("Building test scripts: 0 of 1");
        const again = repo.listJobs(pid)[0]!;
        expect(again.options).toMatchObject({ plainCaseId: three[1]!.id, plainCaseQueue: [] });
        expect(await end(again, true)).toBeNull();
        await pwExpect(card).toContainText("1 test script has been created", { timeout: 15_000 });
    });

    it("Test scripts fills by itself while scripts are made from test cases, also across the gap between two cases' jobs (sheet #26)", async () => {
        const { repo } = platform;
        const store = new ManualCaseStore(platform.db);
        const pid = repo.createProject({ name: "Gap web shop", platforms: ["web"], testingModes: ["code"] }).id as string;
        repo.createApplication(pid, "http://127.0.0.1:8523", { ...DEFAULT_JOB_OPTIONS });
        const two = ["Verify the gap home page", "Verify the gap search"].map((title) => store.createCase(pid, ManualCaseInputSchema.parse({ title, automation: "automated", area: "Shop", steps: [{ action: "Open it", expected: "It shows" }] })));
        const started = await server.inject({ method: "POST", url: `/api/projects/${pid}/manual-cases/generate-scripts`, headers: { "x-api-key": KEY }, payload: {} });
        expect(started.statusCode, started.body).toBe(200);
        await page.goto(`${BASE}/#/projects/${pid}/scripts`);
        await pwExpect(page.getByText("Test scripts are being made from your test cases")).toBeVisible();
        await pwExpect(page.getByText("They are not run: run them with Run when you are ready. 1 more test case after this one.")).toBeVisible();
        if (shots) await page.screenshot({ path: path.join(shots, "test-scripts-being-made.png") });
        const made = async (job: any) => {
            const imported = await server.inject({ method: "POST", url: `/api/projects/${pid}/specs`, headers: { "x-api-key": KEY }, payload: { validate: false, specs: [{ title: job.options.plainDescription.split("\n")[0], kind: "web", category: "Plain English", steps: [{ action: "navigate", url: "/" }] }] } });
            platform.db.run("UPDATE test_cases SET job_id = ? WHERE id = ?", job.id, JSON.parse(imported.body).tests[0].id);
            repo.setJobStatus(job.id, "COMPLETED");
        };
        const first = repo.listJobs(pid)[0]!;
        await made(first);
        // The page looks while no job is going (the next case's job starts just after), then the next one starts.
        await page.waitForTimeout(3500);
        const second = (await afterCaseJob(repo, first))!;
        expect(second.options.plainCaseId).toBe(two[1]!.id);
        await made(second);
        expect(await afterCaseJob(repo, second)).toBeNull();
        const rows = page.getByTestId("script-row");
        for (const c of two) await pwExpect(rows.filter({ hasText: c.title })).toBeVisible({ timeout: 15_000 });
        await pwExpect(page.getByTestId("scripts-counts")).toHaveText("2 test scripts, 0 passing");
        if (shots) await page.screenshot({ path: path.join(shots, "test-scripts-filled.png") });
        await page.setViewportSize({ width: 375, height: 800 });
        if (shots) await page.screenshot({ path: path.join(shots, "test-scripts-filled-375.png") });
        await page.setViewportSize({ width: 1280, height: 900 });
    });

    it("says before the click why it cannot write here: an iOS-only project, an Android project without its app", async () => {
        for (const [pid, why] of [
            [iphone, IOS_PROJECT],
            [noApp, NO_APP_FOR_SCRIPTS],
            // A web project without its address is told before the dry run, not after it (review R5, L6b).
            [noAddress, NO_ADDRESS_FOR_SCRIPTS],
        ] as const) {
            await page.goto(`${BASE}/#/projects/${pid}/tests`);
            const card = page.getByTestId("generate-scripts");
            await pwExpect(card.getByTestId("generate-scripts-why")).toHaveText(why);
            await pwExpect(card.getByRole("button", { name: "Generate test scripts", exact: true })).toBeDisabled();
        }
    });

    it("follows the person's permissions in this project, not the platform's: a project viewer is not offered it (review R5, L6a)", async () => {
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
            // The card under the Test cases list is not offered.
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
