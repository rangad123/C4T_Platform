/**
 * Reusable libraries in a real browser against a real platform (port 7662): the sidebar place, nested folders, adding a helper and a
 * new version of it, the project's Test scripts → Reusable libraries section adding the item, updating it when the library moves on,
 * and publishing the project's own reusable steps. Light-mode accessibility of both pages. Requires `web/dist` (vite build).
 * Runs a browser: node scripts/with-lock.mjs browser -- npx vitest run tests/libraries-ui.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { hashPassword } from "../src/platform/auth/password.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 7662;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "libraries-ui-owner-key-81fe";
let browser: Browser;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir = "";
let shop = "";

const helper = (word: string) => `import type { Page } from "@playwright/test";\nexport async function open(page: Page) {\n  await page.goto("/${word}");\n}\n`;
const asKey = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
    const r = await server.inject({ method, url, headers: { "x-api-key": KEY }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-libraries-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY: KEY, HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    shop = platform.repo.createProject({ name: "Shop" }).id as string;
    const users = accessControlOf(server).users;
    const olga = users.create({ email: "olga@example.com", name: "Olga Owner", role: "owner" });
    users.setPassword(olga.id, await hashPassword("olga's long password"));
    browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const axeClean = async (page: Page) => {
    const r = await new AxeBuilder({ page }).analyze();
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
};

describe("reusable libraries in the web app", () => {
    let owner: Page;
    let itemId = "";

    it("opens from the sidebar, makes nested folders and adds a helper with a second version", async () => {
        owner = await (await browser.newContext()).newPage();
        await owner.goto(BASE);
        await owner.getByLabel("Email").fill("olga@example.com");
        await owner.getByLabel("Password").fill("olga's long password");
        await owner.getByRole("button", { name: "Sign in" }).click();
        await pwExpect(owner.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
        await owner.getByRole("complementary", { name: "Main navigation" }).getByRole("link", { name: "Reusable libraries" }).click();
        await pwExpect(owner.getByRole("heading", { name: "Reusable libraries", level: 1 })).toBeVisible();
        await pwExpect(owner.getByText("Nothing in the library yet")).toBeVisible();

        await owner.getByRole("button", { name: "New folder" }).click();
        await owner.getByLabel("Folder name").fill("Checkout");
        await owner.getByRole("button", { name: "Make folder" }).click();
        await pwExpect(owner.getByText("Folder “Checkout” made.")).toBeVisible();
        await owner.getByRole("navigation", { name: "Library folders" }).getByRole("link", { name: "Checkout" }).click();
        await pwExpect(owner.getByRole("heading", { name: "Checkout", level: 2 })).toBeVisible();
        await owner.getByRole("button", { name: "New folder" }).click();
        await owner.getByLabel("Folder name").fill("Payments");
        await owner.getByRole("button", { name: "Make folder" }).click();
        await pwExpect(owner.getByRole("navigation", { name: "Library folders" }).getByRole("link", { name: "Payments" })).toBeVisible();

        await owner.getByRole("button", { name: "Add item" }).click();
        await owner.getByLabel("Name", { exact: true }).fill("open-shop");
        await owner.getByLabel("Code", { exact: true }).fill(helper("a"));
        await owner.getByRole("button", { name: "Add to library" }).click();
        await pwExpect(owner.getByText("“open-shop” added to the library as version 1.")).toBeVisible();
        const detail = owner.getByTestId("library-item-detail");
        await pwExpect(detail.getByRole("heading", { name: "open-shop" })).toBeVisible();
        await pwExpect(detail.locator(".badge", { hasText: "Version 1" })).toBeVisible();
        itemId = new URL(owner.url().replace("#/", "")).searchParams.get("item") ?? "";
        expect(itemId).not.toBe("");
        expect(await axeClean(owner)).toEqual([]);

        await detail.getByRole("button", { name: "New version" }).click();
        await owner.getByLabel("Code", { exact: true }).fill(helper("b"));
        await owner.getByLabel("What changed").fill("Opens the new path");
        await owner.getByRole("button", { name: "Save version" }).click();
        await pwExpect(owner.getByText("Saved as a new version.")).toBeVisible();
        await pwExpect(detail.locator(".badge", { hasText: "Version 2" })).toBeVisible();
        await pwExpect(detail.getByRole("list", { name: "Versions" }).getByRole("listitem")).toHaveCount(2);
        await pwExpect(detail.getByText("Version 2: Opens the new path")).toBeVisible();
    });

    it("adds the item to a project, which updates only when someone there chooses to", async () => {
        await owner.goto(`${BASE}/#/projects/${shop}/scripts?section=library`);
        const row = owner.getByTestId("project-library-item").filter({ hasText: "open-shop" });
        await row.getByRole("button", { name: "Add to project" }).click();
        await pwExpect(owner.getByText("“open-shop” added to this project.")).toBeVisible();
        await pwExpect(row.getByText("Up to date")).toBeVisible();
        expect((await asKey("GET", `/api/projects/${shop}/helpers/open-shop`)).body.content).toBe(helper("b"));
        expect(await axeClean(owner)).toEqual([]);

        expect((await asKey("PUT", `/api/libraries/items/${itemId}/content`, { content: { content: helper("c") } })).status).toBe(200);
        await owner.reload();
        await pwExpect(row.getByRole("button", { name: "Update to version 3" })).toBeVisible();
        expect((await asKey("GET", `/api/projects/${shop}/helpers/open-shop`)).body.content).toBe(helper("b"));
        await row.getByRole("button", { name: "Update to version 3" }).click();
        await pwExpect(owner.getByText(/“open-shop” in this project is now the library's latest version/)).toBeVisible();
        expect((await asKey("GET", `/api/projects/${shop}/helpers/open-shop`)).body.content).toBe(helper("c"));
    });

    it("publishes the project's own reusable steps to the library, and the library shows who uses them", async () => {
        expect((await asKey("POST", `/api/projects/${shop}/blocks`, { name: "Search", kind: "web", params: [], steps: [{ action: "fill", locator: { by: "label", value: "Search" }, value: "shoes" }] })).status).toBe(201);
        await owner.reload();
        const local = owner.getByTestId("project-local-item").filter({ hasText: "Search" });
        await local.getByRole("button", { name: "Publish to library" }).click();
        await pwExpect(owner.getByText("“Search” published to the library.")).toBeVisible();
        await pwExpect(local.getByRole("button", { name: "Publish as new version" })).toBeVisible();
        await owner.getByRole("link", { name: "Open the library" }).click();
        await owner.getByTestId("library-item").filter({ hasText: "Search" }).click();
        const detail = owner.getByTestId("library-item-detail");
        await pwExpect(detail.getByRole("list", { name: "Steps" }).getByRole("listitem")).toHaveCount(1);
        await pwExpect(detail.getByRole("list", { name: "Projects that use it" }).getByRole("link", { name: "Shop" })).toBeVisible();
        await pwExpect(detail.getByText(/published from Shop/)).toBeVisible();
    });

    it("sends an old Folders link to Reusable libraries, and keeps project folders a click away from Projects", async () => {
        await owner.goto(`${BASE}/#/folders`);
        await pwExpect(owner.getByRole("heading", { name: "Reusable libraries", level: 1 })).toBeVisible();
        expect(new URL(owner.url()).hash).toBe("#/libraries");
        await owner.goto(`${BASE}/#/project-folders`);
        await pwExpect(owner.getByRole("heading", { name: "Project folders", level: 1 })).toBeVisible();
    });
});
