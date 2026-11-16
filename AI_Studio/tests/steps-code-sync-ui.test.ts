/**
 * A Steps save in a real browser, signed in, where a person's edit waits for review (the default policy): a test imported from a
 * JSON file through "Import", its last step deleted on the Steps tab, saved and run. The run uses the approved version (the review
 * rule), the page says so plainly, and the Steps, the DSL and the Code tab keep showing the saved steps after that run (it used to
 * put the approved version's script back on the Code tab). Ports: 7764 platform (serves web/dist), 7765 the sample app as the site.
 * Requires web/dist (build inside the lock): node scripts/with-lock.mjs build,browser -- sh -c "npx vite build web && npx vitest run tests/steps-code-sync-ui.test.ts"
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { hashPassword } from "../src/platform/auth/password.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { ReviewStore } from "../src/platform/review-store.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const PORT = 7764;
const APP_PORT = 7765;
const BASE = `http://127.0.0.1:${PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DONE = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];

let sample: ChildProcess;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dataDir = "";
let browser: Browser;
let page: Page;
let projectId = "";
let testId = "";

const loginSpec = {
    testId: "WEB-002",
    title: "Verify login with valid credentials",
    kind: "web",
    category: "Imported from a file",
    priority: "high",
    steps: [
        { action: "navigate", url: "/login" },
        { action: "fill", locator: { by: "label", value: "Email" }, value: "demo@example.com" },
        { action: "fill", locator: { by: "label", value: "Password" }, value: "demo-password" },
        { action: "click", locator: { by: "role", role: "button", value: "Log in" } },
        { action: "assert", check: "visible", locator: { by: "text", value: "Dashboard" } },
    ],
};

const repo = () => platform.repo;
async function waitIdle() {
    for (let i = 0; i < 300; i++) {
        if (repo().listJobs(projectId).every((j) => DONE.includes(j.status as string))) return;
        await sleep(300);
    }
    throw new Error("a run did not finish");
}
const tab = (name: string) => page.getByRole("tab", { name, exact: true });

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
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-steps-sync-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY: "steps-sync-ui-key-5d1e", SECRET_KEY: "steps-sync-ui-secret-0123456789", MAX_REPAIR_ATTEMPTS: "0", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 200);
    worker.start();
    projectId = repo().createProject({ name: "Workbench Web Testing" }).id as string;
    repo().createApplication(projectId, APP, {});
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
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    sample?.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("deleting the last step of an imported test on the Steps tab", () => {
    it("imports the test from a JSON file and runs its approved version once: it fails at the last step", async () => {
        // The first version is approved by the policy (edits switched off for the import only); later edits wait for review again.
        const store = new ReviewStore(platform.db);
        store.setPolicy(projectId, { edits: false }, "test");
        await page.goto(`${BASE}/#/projects/${projectId}/scripts`);
        await page.getByRole("button", { name: "Import", exact: true }).click();
        const chooser = page.waitForEvent("filechooser");
        await page.getByRole("button", { name: "Choose a JSON file", exact: true }).click();
        await (await chooser).setFiles({ name: "web-002.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify([loginSpec])) });
        await pwExpect(page.getByText(/Imported 1 test/)).toBeVisible({ timeout: 20_000 });
        testId = repo().listTests(projectId)[0]!.id;
        await waitIdle();
        store.setPolicy(projectId, { edits: true }, "test");
        expect(store.approved(testId)?.version).toBe(1);
        expect(repo().listExecutions(testId)[0]?.status).not.toBe("passed");
    }, 120_000);

    it("after Save and run, the page says the run uses the approved version, and Steps, DSL and Code keep the saved steps", async () => {
        await page.goto(`${BASE}/#/tests/${testId}/steps`);
        await page.getByRole("button", { name: "Delete step 5", exact: true }).click();
        await page.getByTestId("unsaved-bar").getByRole("button", { name: "Save and run", exact: true }).click();
        await pwExpect(page.getByTestId("saved-bar")).toContainText("The run uses approved version 1, not this draft.");
        await waitIdle();
        // The run used version 1 (the review rule): the page says so in words, on every tab.
        await page.reload();
        const notice = page.getByText("Version 2 is a draft: runs do not use it yet");
        await pwExpect(notice).toBeVisible();
        await pwExpect(page.getByText("Runs use approved version 1 until a Project Admin approves version 2")).toBeVisible();
        await pwExpect(page.locator(".bld-head")).toHaveCount(4);

        await tab("Code").click();
        await pwExpect(page.getByRole("heading", { name: "Script", exact: true })).toBeVisible();
        const code = page.getByRole("tabpanel", { name: "Code" });
        await pwExpect(code).toContainText("4. Click");
        await pwExpect(code).not.toContainText("Dashboard");
        await pwExpect(notice).toBeVisible();

        await tab("DSL").click();
        await pwExpect(page.locator(".cm-content")).toBeVisible();
        await pwExpect(page.locator(".cm-content")).not.toContainText("Dashboard");
        // The download is the same script.
        const download = await page.request.get(`${BASE}/api/tests/${testId}/script`);
        expect(await download.text()).not.toMatch(/Dashboard/);
    }, 180_000);

    it("Switch to code after that run takes the saved steps' script, and the old steps are labelled as no longer run", async () => {
        // Only a confirmed "Switch to code" makes a code test; it takes the test's current script, which must be the saved steps' one.
        await page.goto(`${BASE}/#/tests/${testId}/code`);
        await page.getByRole("button", { name: "Switch to code", exact: true }).first().click();
        const dialog = page.getByRole("dialog", { name: "Switch this test to code?" });
        await dialog.getByRole("button", { name: "Switch to code", exact: true }).click();
        await pwExpect(page.getByText("Code test").first()).toBeVisible();
        const code = (await page.request.get(`${BASE}/api/tests/${testId}/script`)).text();
        expect(await code).not.toMatch(/Dashboard/);
        expect(await code).toMatch(/Log in/);
        await tab("Steps").click();
        await pwExpect(page.getByText("This is a code test, so it has no steps to edit")).toBeVisible();
        await pwExpect(page.getByRole("heading", { name: "Steps before the switch to code", exact: true })).toBeVisible();
        await pwExpect(page.getByText("4 in all, no longer run: the code is what runs")).toBeVisible();
    }, 120_000);
});
