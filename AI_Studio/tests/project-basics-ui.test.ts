/**
 * Round 37, project basics, in a real browser against a real platform (port 8788, no access key): Create a project asks for a
 * typed name, one platform and one testing mode, and the app for that platform; an older project with several platforms and
 * both modes shows them and asks for one of each on save; the project's tabs in their new order with no Runners in Settings; old
 * runner links land on Your runner in Settings; the Projects page in pages of 20
 * with the page in the address, View all and search; no Security assessment in the sidebar. Requires `web/dist` (vite build).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;
let browser: Browser;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir = "";
let page: Page;
const consoleErrors: string[] = [];

const api = async (method: string, url: string, body?: unknown) => {
    const r = await fetch(`${BASE}${url}`, { method, headers: { "content-type": "application/json", "x-requested-with": "ai-studio" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    return { status: r.status, body: text && /^[[{]/.test(text) ? JSON.parse(text) : text };
};
const visit = async (hash: string) => {
    await page.goto("about:blank");
    await page.goto(`${BASE}/${hash}`);
    await pwExpect(page.locator("h1").first()).toBeVisible();
};
const hash = () => page.evaluate(() => location.hash);

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-basics-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", SECRET_KEY: "basics-ui-secret-key-0123456789" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    platform.repo.createProject({ name: "Atlas shop" });
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
}, 60_000);
afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const byName = (name: string) => platform.repo.listProjects().find((p) => p.name === name);

describe("Create a project", () => {
    it("asks for a name, one platform, one mode and the web address, never filling the name from it", async () => {
        await visit("#/create");
        const form = page.getByTestId("create-project");
        await pwExpect(form.getByRole("radio", { name: /^Web/ })).toBeChecked();
        await pwExpect(form.getByRole("checkbox")).toHaveCount(0);
        await form.getByLabel("Application URL").fill("https://gifts.example.com/");
        await form.getByRole("button", { name: "Create project" }).click();
        await pwExpect(form.getByText("Give the project a name.")).toBeVisible();
        await pwExpect(form.getByLabel("Project name")).toHaveValue("");
        await form.getByLabel("Project name").fill("Gift shop");
        await form.getByRole("button", { name: "Create project" }).click();
        await pwExpect(form.getByText("Choose how the project is tested: AI agent or code.")).toBeVisible();
        await form.getByRole("radio", { name: /^AI agent/ }).check();
        await form.getByRole("button", { name: "Create project" }).click();
        await page.waitForURL((u) => /^#\/projects\/[^/]+$/.test(u.hash));
        const id = byName("Gift shop")!.id as string;
        expect((await api("GET", `/api/projects/${id}`)).body).toMatchObject({ platforms: ["web"], testingModes: ["agent"] });
        expect((await api("GET", `/api/projects/${id}/app-details`)).body.webUrl).toBe("https://gifts.example.com/");
        // A taken name is refused in plain words.
        await visit("#/create");
        await page.getByLabel("Project name").fill("gift shop");
        await page.getByLabel("Application URL").fill("https://other.example.com/");
        await page.getByRole("radio", { name: /^Code/ }).check();
        await page.getByRole("button", { name: "Create project" }).click();
        await pwExpect(page.getByText(/already exists in this organisation/)).toBeVisible();
    });

    it("asks for the phone app by platform: a file, a store link, or later; a bad link is refused", async () => {
        await visit("#/create");
        await page.getByLabel("Project name").fill("Gift app");
        await page.getByRole("radio", { name: /^Android/ }).check();
        await pwExpect(page.getByLabel("Application URL")).toHaveCount(0);
        const android = page.getByTestId("app-android");
        await pwExpect(android.getByRole("radio", { name: "Upload an .apk" })).toBeChecked();
        await pwExpect(android.getByRole("button", { name: "Choose .apk" })).toBeVisible();
        await page.getByRole("radio", { name: /^Code/ }).check();
        await page.getByRole("button", { name: "Create project" }).click();
        await pwExpect(page.getByText("Choose the app’s .apk file, give its Google Play link, or choose Add it later.")).toBeVisible();
        await android.getByRole("radio", { name: "Google Play link" }).check();
        await page.getByLabel("Link to the app on Google Play").fill("https://play.google.com/store/apps/details?id=nodots");
        await page.getByRole("button", { name: "Create project" }).click();
        await pwExpect(page.getByText(/A Google Play link looks like/)).toBeVisible();
        expect(byName("Gift app")).toBeUndefined();
        await page.getByLabel("Link to the app on Google Play").fill("https://play.google.com/store/apps/details?id=com.example.gifts");
        await page.getByRole("button", { name: "Create project" }).click();
        await page.waitForURL((u) => /^#\/projects\/[^/]+$/.test(u.hash));
        const id = byName("Gift app")!.id as string;
        expect((await api("GET", `/api/projects/${id}/app-details`)).body.android).toMatchObject({ appPackage: "com.example.gifts", playStoreUrl: "https://play.google.com/store/apps/details?id=com.example.gifts" });
        // iOS: the same three ways, with an App Store link.
        await visit("#/create");
        await page.getByRole("radio", { name: /^iOS/ }).check();
        const ios = page.getByTestId("app-ios");
        await pwExpect(ios.getByRole("radio", { name: "Upload an .ipa" })).toBeChecked();
        await ios.getByRole("radio", { name: "App Store link" }).check();
        await pwExpect(page.getByLabel("Link to the app on the App Store")).toBeVisible();
        await ios.getByRole("radio", { name: "Add it later" }).check();
        await pwExpect(page.getByLabel("Link to the app on the App Store")).toHaveCount(0);
    });
});

describe("one platform and one mode in Settings", () => {
    it("shows an older project's several platforms and modes, and asks for one of each on save", async () => {
        const id = platform.repo.createProject({ name: "From before" }).id as string;
        platform.repo.updateProject(id, { platforms: ["web", "android"], testingModes: ["agent", "code"] });
        await visit(`#/projects/${id}/settings`);
        const general = page.getByTestId("project-general");
        await pwExpect(general.getByText("This project was set up for Web, Android.", { exact: false })).toBeVisible();
        await pwExpect(general.getByText("This project uses both AI agent and Code.", { exact: false })).toBeVisible();
        for (const name of [/^Web$/, /^Android$/, /^iOS$/, /^AI agent$/, /^Code$/]) await pwExpect(general.getByRole("radio", { name })).not.toBeChecked();
        // Both platforms' app details show.
        await pwExpect(page.getByTestId("project-app").getByLabel("Application URL")).toBeVisible();
        await pwExpect(page.getByTestId("project-app").getByTestId("app-android")).toBeVisible();
        await general.getByRole("button", { name: "Save changes" }).click();
        await pwExpect(general.getByText("Choose the one platform this project tests. Tests of the others stay.")).toBeVisible();
        expect(platform.repo.getProject(id)!.platforms).toBe('["web","android"]');
        await general.getByRole("radio", { name: /^Android$/ }).check();
        await general.getByRole("radio", { name: /^Code$/ }).check();
        await general.getByRole("button", { name: "Save changes" }).click();
        await pwExpect(general.getByText("Saved.")).toBeVisible();
        expect((await api("GET", `/api/projects/${id}`)).body).toMatchObject({ platforms: ["android"], testingModes: ["code"] });
        await pwExpect(general.getByText("Choose one platform")).toHaveCount(0);
        // A code-mode project has no Agent runs tab (round 38: no project has one), and its header's tile says Code (no second chip).
        await pwExpect(page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Test scripts" })).toBeVisible();
        await pwExpect(page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Agent runs" })).toHaveCount(0);
        await pwExpect(page.getByTestId("project-head").getByRole("img", { name: "Code project" })).toBeVisible();
        await pwExpect(page.getByTestId("project-head").getByTestId("kind-chips")).toHaveCount(0);
    });

    it("saves the web address from Settings, General", async () => {
        const id = byName("Atlas shop")!.id as string;
        await visit(`#/projects/${id}/settings`);
        const app = page.getByTestId("project-app");
        await pwExpect(app.getByText("No address is saved yet.")).toBeVisible();
        await app.getByLabel("Application URL").fill("https://atlas.example.com/");
        await app.getByRole("button", { name: "Save the app" }).click();
        await pwExpect(app.getByText("Now: https://atlas.example.com/")).toBeVisible();
    });
});

describe("the project menu and runners", () => {
    it("orders an AI agent project's tabs Dashboard, Runs, Requirements, Settings, with no Runners in Settings", async () => {
        // Round 38: Gift shop was made with the AI agent mode, so it has an agent project's four tabs (a code project's are in project-kinds-ui).
        const id = byName("Gift shop")!.id as string;
        await visit(`#/projects/${id}`);
        const tabs = page.getByRole("navigation", { name: "Project sections" }).locator("a.tab");
        await pwExpect(tabs.first()).toBeVisible();
        expect((await tabs.allTextContents()).map((t) => t.replace(/\d+$/, "").trim())).toEqual(["Dashboard", "Runs", "Requirements", "Settings"]);
        await visit(`#/projects/${id}/settings`);
        expect(await page.locator(".subtabs a").allTextContents()).not.toContain("Runners");
    });

    it("lands an old project runners link on Your runner in Settings (round 45: one runner per person, no project runners)", async () => {
        const id = byName("Gift shop")!.id as string;
        await visit(`#/projects/${id}/settings?section=runners`);
        await pwExpect.poll(hash).toBe("#/settings#runner");
        await pwExpect(page.getByTestId("your-runner")).toBeVisible();
        await visit(`#/runners?project=${id}`);
        await pwExpect.poll(hash).toBe("#/settings#runner");
    });

    it("has no Security assessment in the sidebar", async () => {
        await visit("#/");
        const side = page.getByRole("complementary", { name: "Main navigation" });
        await pwExpect(side.getByRole("link", { name: "Projects", exact: true })).toBeVisible();
        await pwExpect(side.getByRole("link", { name: "Security assessment" })).toHaveCount(0);
    });
});

describe("the Projects page in pages", () => {
    it("shows 20 a page with the page in the address, Back returns, View all shows every one, and search pages too", async () => {
        for (let i = 1; i <= 22; i++) platform.repo.createProject({ name: `Paged ${String(i).padStart(2, "0")}` });
        const total = platform.repo.listProjects().length;
        await visit("#/");
        const rows = page.locator("ul.card.list > li");
        await pwExpect(rows).toHaveCount(20);
        const pager = page.getByTestId("projects-pager");
        await pwExpect(pager).toContainText(`Page 1 of 2 · 1–20 of ${total} projects`);
        await pager.getByRole("link", { name: "Next" }).click();
        await pwExpect(pager).toContainText(`Page 2 of 2 · 21–${total} of ${total} projects`);
        expect(await hash()).toBe("#/?page=2");
        await pwExpect(rows).toHaveCount(total - 20);
        await page.goBack();
        await pwExpect(pager).toContainText("Page 1 of 2");
        await pager.getByRole("link", { name: "View all" }).click();
        expect(await hash()).toBe("#/?page=all");
        await pwExpect(rows).toHaveCount(total);
        await pwExpect(pager).toContainText(`All ${total} projects`);
        await pager.getByRole("link", { name: "Show 20 per page" }).click();
        await pwExpect(rows).toHaveCount(20);
        // Search is asked of the server, page by page.
        await page.getByLabel("Search projects").fill("paged 1");
        await pwExpect(rows).toHaveCount(10);
        await pwExpect(pager).toContainText("Page 1 of 1 · 1–10 of 10 projects");
        await page.getByLabel("Search projects").fill("no such project");
        await pwExpect(page.getByText("No projects match. Clear the search or the folder to see every project.")).toBeVisible();
        await pwExpect(page.getByRole("link", { name: "Open the dashboard" })).toHaveAttribute("href", "#/dashboard");
    });

    it("kept the browser console clean", () => {
        expect(consoleErrors).toEqual([]);
    });
});
