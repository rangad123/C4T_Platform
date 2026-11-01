/**
 * Test development in a real browser against a real platform (port 7901): a launcher, not a place of its own. For a project a person
 * picks it opens each way of writing a test (the AI exploring, a description in words, the recorder, the step builder), and below that
 * sits the review queue of drafts across projects. A person who may only read sees no tool they could not use. Requires `web/dist`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { hashPassword } from "../src/platform/auth/password.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 7901;
const BASE = `http://127.0.0.1:${PORT}`;
let browser: Browser;
let page: Page;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir = "";
let projectId = "";

const signIn = async (p: Page, email: string, password: string) => {
    await p.goto(BASE);
    await p.getByLabel("Email").fill(email);
    await p.getByLabel("Password").fill(password);
    await p.getByRole("button", { name: "Sign in" }).click();
    await pwExpect(p.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-develop-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY: "develop-ui-owner-key-61c2", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    const { repo } = platform;
    projectId = repo.createProject({ name: "Launch shop" }).id as string;
    repo.createApplication(projectId, "http://127.0.0.1:9/", {});
    const spec = TestSpecSchema.parse({ testId: "WEB-001", title: "A draft to review", kind: "web", category: "Smoke", priority: "high", steps: [{ action: "navigate", url: "/" }] });
    repo.insertTest({ projectId, suiteId: repo.getOrCreateSuite(projectId, "Smoke", "smoke"), jobId: null, spec, framework: "playwright", validationStatus: "PENDING", versionSource: "ai" });
    const users = accessControlOf(server).users;
    for (const [email, name, role] of [["olga@example.com", "Olga Owner", "owner"], ["vera@example.com", "Vera Viewer", "viewer"]] as const) {
        const u = users.create({ email, name, role });
        users.setPassword(u.id, await hashPassword(`${name}'s long password`));
    }
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await signIn(page, "olga@example.com", "Olga Owner's long password");
}, 90_000);
afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const row = () => page.getByRole("list", { name: "Your projects" }).getByRole("listitem").filter({ hasText: "Launch shop" });
const open = async () => {
    await page.goto("about:blank");
    await page.goto(`${BASE}/#/develop`);
    await pwExpect(page.getByRole("heading", { name: "Test development", level: 1 })).toBeVisible();
};

describe("Test development", () => {
    it("lists the project with every authoring tool, and the review queue below", async () => {
        await open();
        for (const tool of ["Explore with AI", "Describe in words", "Record", "Build steps", "Test cases"]) await pwExpect(row().getByRole("link", { name: tool, exact: true })).toBeVisible();
        await pwExpect(page.getByRole("region", { name: "Drafts waiting for review" }).getByRole("link", { name: /WEB-001 A draft to review/ })).toBeVisible();
        expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id)).toEqual([]);
    });

    it("opens the AI exploration for that project", async () => {
        await open();
        await row().getByRole("link", { name: "Explore with AI", exact: true }).click();
        expect(page.url()).toContain(`#/new?project=${projectId}`);
        await pwExpect(page.getByRole("heading", { level: 1 })).toBeVisible();
    });

    it("opens the description dialog on that project's test cases", async () => {
        await open();
        await row().getByRole("link", { name: "Describe in words", exact: true }).click();
        await pwExpect(page.getByRole("dialog")).toBeVisible();
        await pwExpect(page.getByRole("dialog").getByRole("heading", { level: 2 }).first()).toContainText(/describe|write/i);
        expect(page.url()).toContain(`#/projects/${projectId}/tests`);
    });

    it("opens the recorder", async () => {
        await open();
        await row().getByRole("link", { name: "Record", exact: true }).click();
        expect(page.url()).toContain(`#/projects/${projectId}/record`);
        await pwExpect(page.getByRole("heading", { level: 1 })).toBeVisible();
    });

    it("opens the step builder, which leads to a new test", async () => {
        await open();
        await row().getByRole("link", { name: "Build steps", exact: true }).click();
        const dialog = page.getByRole("dialog");
        await pwExpect(dialog).toBeVisible();
        await dialog.getByLabel(/name|title/i).first().fill("Built by hand");
        await dialog.getByRole("button", { name: /start|create|build/i }).first().click();
        await pwExpect(page).toHaveURL(/#\/tests\/[^/]+\/steps/);
    });

    it("offers a person who may only read no tool they cannot use, and keeps the way to the test cases", async () => {
        const viewer = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
        await signIn(viewer, "vera@example.com", "Vera Viewer's long password");
        await viewer.goto(`${BASE}/#/develop`);
        const list = viewer.getByRole("list", { name: "Your projects" });
        await pwExpect(list.getByRole("link", { name: "Test cases", exact: true })).toBeVisible();
        for (const tool of ["Explore with AI", "Describe in words", "Record", "Build steps"]) await pwExpect(list.getByRole("link", { name: tool, exact: true })).toHaveCount(0);
        await viewer.close();
    });
});
