/**
 * Folders, archive and delete, and Profile in a real browser against a real platform (port 7776; a stand-in Crowd4Test sign-in on
 * 7777): an owner makes a folder, moves a project in, groups the project list by it and removes it; archives a project (gone from
 * the list, back with "Show archived projects"), then deletes it after typing its name; saves preferences that change how the
 * Projects page opens. A Crowd4Test customer's Profile (a second platform on 7778) shows the account read-only with the link to crowd4test.com. Light-mode
 * accessibility of both pages. Requires `web/dist` (vite build).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { hashPassword } from "../src/platform/auth/password.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 7776;
const C4T_PORT = 7777;
const C4T_PLATFORM_PORT = 7778;
const BASE = `http://127.0.0.1:${PORT}`;
const C4T_BASE = `http://127.0.0.1:${C4T_PLATFORM_PORT}`;
const KEY = "folders-ui-owner-key-3a7e";
let browser: Browser;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let c4t: http.Server;
let c4tPlatform: Platform;
let c4tServer: Awaited<ReturnType<typeof buildServer>>;
let dataDir = "";
let c4tDir = "";
let alpha = "";
let cargo = "";

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    c4t = http.createServer((req, res) => {
        const ok = String(req.headers.authorization ?? "") === "Bearer t-cora";
        res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
        res.end(
            JSON.stringify(
                ok
                    ? { data: { user: { id: "cora", email: "cora@people.example", role: "CUSTOMER", status: "ACTIVE", firstName: "Cora", lastName: "Customer", emailVerified: true, permissions: PERMISSIONS, organisationId: "org-a" } } }
                    : { error: { message: "Invalid access token" } },
            ),
        );
    });
    await new Promise<void>((r) => c4t.listen(C4T_PORT, "127.0.0.1", r));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-folders-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY: KEY, HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    c4tDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-folders-ui-c4t-"));
    c4tPlatform = bootstrap(
        loadConfig({ DATA_DIR: c4tDir, API_KEY: KEY, HOST: "127.0.0.1", PORT: String(C4T_PLATFORM_PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", C4T_API_ORIGIN: `http://127.0.0.1:${C4T_PORT}`, C4T_SITE_URL: "https://crowd4test.example" }),
    );
    c4tServer = await buildServer(c4tPlatform);
    await c4tServer.listen({ port: C4T_PLATFORM_PORT, host: "127.0.0.1" });
    alpha = platform.repo.createProject({ name: "Alpha shop" }).id as string;
    platform.repo.createProject({ name: "Bravo bank" });
    cargo = platform.repo.createProject({ name: "Cargo app" }).id as string;
    const users = accessControlOf(server).users;
    const olga = users.create({ email: "olga@example.com", name: "Olga Owner", role: "owner" });
    users.setPassword(olga.id, await hashPassword("olga's long password"));
    browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    await c4tServer?.close();
    c4tPlatform?.db.close();
    await new Promise((r) => c4t?.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(c4tDir, { recursive: true, force: true });
});

const axeClean = async (page: Page) => {
    const r = await new AxeBuilder({ page }).analyze();
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
};

describe("folders, archive and delete, and Profile in the web app", () => {
    let owner: Page;

    it("makes a folder, moves a project in, renames it, and groups the project list by it", async () => {
        owner = await (await browser.newContext()).newPage();
        await owner.goto(BASE);
        await owner.getByLabel("Email").fill("olga@example.com");
        await owner.getByLabel("Password").fill("olga's long password");
        await owner.getByRole("button", { name: "Sign in" }).click();
        await pwExpect(owner.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
        await owner.goto(`${BASE}/#/folders`);
        await pwExpect(owner.getByRole("heading", { name: "Folders", level: 1 })).toBeVisible();
        await pwExpect(owner.getByText("No folders yet")).toBeVisible();
        await pwExpect(owner.getByTestId("planned-folders")).toHaveCount(0);
        await owner.getByLabel("Folder name").fill("Clients");
        await owner.getByRole("button", { name: "Make folder" }).click();
        await pwExpect(owner.getByText("Folder “Clients” made.")).toBeVisible();
        await owner.getByLabel("Move a project into Clients").selectOption({ label: "Alpha shop" });
        await pwExpect(owner.getByText("Alpha shop moved into “Clients”.")).toBeVisible();
        await pwExpect(owner.getByRole("list", { name: "Projects in Clients" }).getByRole("link", { name: "Alpha shop" })).toBeVisible();
        expect(await axeClean(owner)).toEqual([]);
        await owner.getByRole("button", { name: "Rename" }).click();
        await owner.getByLabel("New name for Clients").fill("Key clients");
        await owner.getByRole("button", { name: "Save name" }).click();
        await pwExpect(owner.getByRole("heading", { name: "Key clients" })).toBeVisible();
        // The project list: three projects open on the dashboard; the list groups them by folder.
        await owner.goto(`${BASE}/#/`);
        await owner.getByRole("button", { name: /Show as a list/ }).click();
        await owner.getByLabel("Folder", { exact: true }).selectOption("grouped");
        await pwExpect(owner.getByRole("region", { name: "Key clients" }).getByText("Alpha shop")).toBeVisible();
        await pwExpect(owner.getByRole("region", { name: "Not in a folder" }).getByText("Bravo bank")).toBeVisible();
        // Removing the folder keeps its project.
        await owner.goto(`${BASE}/#/folders`);
        await owner.getByRole("button", { name: "Remove folder" }).click();
        await owner.getByRole("button", { name: "Remove", exact: true }).click();
        await pwExpect(owner.getByText("Folder “Key clients” removed. Its projects are still in Projects.")).toBeVisible();
        await pwExpect(owner.getByRole("region", { name: "Not in a folder" }).getByRole("link", { name: "Alpha shop" })).toBeVisible();
        expect(platform.repo.getProject(alpha)).toBeTruthy();
    });

    it("archives a project, which leaves the list until asked for, then deletes it after its name is typed", async () => {
        await owner.goto(`${BASE}/#/projects/${cargo}/settings`);
        const box = owner.getByTestId("project-archive");
        await pwExpect(owner.getByTestId("planned-project-archive")).toHaveCount(0);
        await box.getByRole("button", { name: "Archive project" }).click();
        await box.getByRole("button", { name: "Archive", exact: true }).click();
        await pwExpect(box.getByText("This project is archived")).toBeVisible();
        await pwExpect(owner.getByLabel("Name", { exact: true })).toBeDisabled();
        // The project's Dashboard says so too, like every other place of the project.
        await owner.goto(`${BASE}/#/projects/${cargo}`);
        await pwExpect(owner.getByTestId("archived-note")).toContainText("It is read-only and starts no runs.");
        await owner.goto(`${BASE}/#/`);
        await owner.getByRole("button", { name: /Show as a list/ }).click();
        await pwExpect(owner.getByText("Bravo bank")).toBeVisible();
        await pwExpect(owner.getByText("Cargo app")).toHaveCount(0);
        await owner.getByLabel("Show archived projects").check();
        await pwExpect(owner.getByRole("link", { name: /Cargo app/ })).toContainText("Archived");
        // Delete: only with the name typed exactly.
        await owner.goto(`${BASE}/#/projects/${cargo}/settings`);
        const del = owner.getByRole("button", { name: "Delete project" });
        await owner.getByLabel("Type Cargo app to confirm").fill("cargo app");
        await pwExpect(del).toBeDisabled();
        await owner.getByLabel("Type Cargo app to confirm").fill("Cargo app");
        await del.click();
        await pwExpect(owner.getByText("Cargo app was deleted.")).toBeVisible();
        expect(platform.repo.getProject(cargo)).toBeUndefined();
    });

    it("saves preferences per person, and the Projects page opens the way they chose", async () => {
        await owner.goto(`${BASE}/#/profile`);
        const prefs = owner.getByRole("region", { name: "Preferences" });
        await pwExpect(owner.getByTestId("planned-profile-preferences")).toHaveCount(0);
        await pwExpect(owner.getByRole("region", { name: "Your account" })).toBeVisible();
        await prefs.getByLabel(/Run alert emails/).uncheck();
        await prefs.getByLabel(/^List/).check();
        await prefs.getByRole("button", { name: "Save preferences" }).click();
        await pwExpect(prefs.getByText("Preferences saved.")).toBeVisible();
        expect(await axeClean(owner)).toEqual([]);
        await owner.reload();
        await pwExpect(prefs.getByLabel(/Run alert emails/)).not.toBeChecked();
        await owner.goto(`${BASE}/#/`);
        await pwExpect(owner.getByLabel("Show archived projects")).toBeVisible();
        await pwExpect(owner.getByRole("button", { name: "Show the dashboard" })).toBeVisible();
    });

    it("shows a Crowd4Test account read-only, with the link to change it on crowd4test.com", async () => {
        const ctx = await browser.newContext();
        await ctx.addCookies([{ name: "c4t_access", value: "t-cora", url: C4T_BASE }]);
        const cora = await ctx.newPage();
        await cora.goto(`${C4T_BASE}/#/profile`);
        await pwExpect(cora.getByRole("heading", { name: "Your Crowd4Test account" })).toBeVisible();
        await pwExpect(cora.getByRole("link", { name: /Edit your account on crowd4test.com/ })).toHaveAttribute("href", "https://crowd4test.example/app");
        await pwExpect(cora.getByText(/Personal API tokens are not available/)).toBeVisible();
        await pwExpect(cora.getByRole("button", { name: "Save preferences" })).toBeVisible();
        await ctx.close();
    });
});
