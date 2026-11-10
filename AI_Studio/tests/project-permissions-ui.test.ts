/**
 * Controls follow the person's permissions in THIS project, not only their platform-wide ones, in a real browser against a real
 * platform (port 8720, nothing runs, no AI). Vic may write tests on the platform but is only a viewer of the project: on the main
 * pages every control the server would refuse is shown switched off with the reason, or left out, and the server does refuse it.
 * Olga, an owner, gets every one of those controls. Requires `web/dist` (vite build).
 *
 *   TAQWRIGHT_HOME=/nonexistent-taqwright node scripts/with-lock.mjs browser -- npx vitest run tests/project-permissions-ui.test.ts
 */
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
import { buildServer } from "../src/platform/server.js";
import { NO_PERMISSION_HERE } from "../web/src/features/auth/project-access-rules.js";

const PORT = 8720;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "proj-perm-ui-key-7d21c4";
const WRITE = NO_PERMISSION_HERE["ai_studio.tests.write"]!;
const SETTINGS = NO_PERMISSION_HERE["ai_studio.project.settings"]!;
let browser: Browser;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir = "";
let projectId = "";
let requirementId = "";

async function call(method: string, url: string, payload?: unknown) {
    const r = await server.inject({ method: method as never, url, payload: payload as never, headers: { "x-api-key": KEY, ...(payload !== undefined ? { "content-type": "application/json" } : {}) } });
    if (r.statusCode >= 300) throw new Error(`${method} ${url}: ${r.statusCode} ${r.body}`);
    return r.json();
}

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-proj-perm-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY: KEY, HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", ALLOW_CUSTOM_SCRIPTS: "true" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    projectId = platform.repo.createProject({ name: "Look only shop", platforms: ["web"], testingModes: ["code"] }).id as string;
    platform.repo.createApplication(projectId, "https://shop.example.com", {} as never);
    requirementId = (await call("POST", `/api/projects/${projectId}/requirements`, { title: "People can sign in" })).id;
    await call("POST", `/api/projects/${projectId}/manual-cases`, { title: "Verify sign in", automation: "manual", area: "Accounts", steps: [{ action: "Sign in", expected: "Welcome is shown" }] });
    await call("POST", `/api/projects/${projectId}/blocks`, { name: "Wait a moment", kind: "web", params: [], steps: [{ action: "wait", ms: 100 }] });
    await call("POST", `/api/projects/${projectId}/objects`, { name: "Header / Logo", kind: "web", locator: { by: "css", value: "#logo" } });
    await call("POST", `/api/projects/${projectId}/environments`, { name: "staging", baseUrl: "https://staging.shop.example.com" });
    await call("PUT", `/api/projects/${projectId}/roles`, { roles: [{ name: "admin", username: "admin@shop.example.com", password: "a long test password" }] });
    await call("PUT", `/api/projects/${projectId}/helpers/cart-tools`, { content: "export const cartTotal = (n: number): number => n * 2;\n" });
    const users = accessControlOf(server).users;
    // Vic may write tests on this platform, but is only a viewer of this project (the permissions that count there).
    const vic = users.create({ email: "vic@example.com", name: "Vic Viewer", role: "editor" });
    users.setPassword(vic.id, await hashPassword("vic's long password"));
    const scope = accessControlOf(server).projects.store;
    scope.setMode(vic.id, "only");
    scope.addMember(projectId, vic.id, { role: "viewer", projectAdmin: false, source: "added", addedBy: "test" });
    const olga = users.create({ email: "olga@example.com", name: "Olga Owner", role: "owner" });
    users.setPassword(olga.id, await hashPassword("olga's long password"));
    browser = await chromium.launch();
}, 90_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

async function signIn(email: string, password: string): Promise<Page> {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await page.goto(BASE);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await pwExpect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    return page;
}

/** The pages walked, each with something that shows once it has loaded. */
const PAGES: Array<{ hash: () => string; ready: string }> = [
    { hash: () => `#/projects/${projectId}/requirements`, ready: "People can sign in" },
    { hash: () => `#/projects/${projectId}/requirements/${requirementId}`, ready: "Test cases that cover it" },
    { hash: () => `#/projects/${projectId}/tests`, ready: "Verify sign in" },
    { hash: () => `#/projects/${projectId}/scripts`, ready: "Scripts" },
    { hash: () => `#/projects/${projectId}/scripts?section=steps`, ready: "Wait a moment" },
    { hash: () => `#/projects/${projectId}/scripts?section=elements`, ready: "Logo" },
    { hash: () => `#/projects/${projectId}/scripts?section=helpers`, ready: "Helpers in this project" },
    { hash: () => `#/projects/${projectId}/runs?section=schedules`, ready: "Scheduled runs" },
    { hash: () => `#/projects/${projectId}/runs?section=deploys`, ready: "Run after a deploy" },
    { hash: () => `#/projects/${projectId}/settings?section=environments`, ready: "staging" },
    { hash: () => `#/projects/${projectId}/settings?section=data`, ready: "Import a table" },
    { hash: () => `#/projects/${projectId}/settings?section=accounts`, ready: "Test accounts" },
    { hash: () => `#/projects/${projectId}/settings?section=alerts`, ready: "Alerts" },
    { hash: () => `#/projects/${projectId}/settings?section=issues`, ready: "Issue tracker" },
];

/** Names of the controls that make, change or delete something, as the pages say them. */
const CHANGE = /^(Add|New|Import|Edit|Delete|Remove|Create|Connect|Write your own|Save|Link test cases|From a template|Make default)\b/;

/** The enabled, visible buttons inside the page (not the shell) whose name says they change something. */
async function enabledChangeControls(page: Page): Promise<string[]> {
    const names = await page.locator("main button:visible").evaluateAll((els) =>
        els.filter((b) => !b.matches(":disabled") && b.getAttribute("aria-disabled") !== "true").map((b) => (b.getAttribute("aria-label") || b.textContent || "").trim()),
    );
    return names.filter((n) => CHANGE.test(n));
}

async function open(page: Page, hash: string, ready: string) {
    await page.goto(`${BASE}/${hash}`);
    await pwExpect(page.locator("main").getByText(ready, { exact: false }).first()).toBeVisible();
    // The project's answer (with its `access`) and the lists arrive in any order: give them a moment.
    await page.waitForTimeout(400);
}

describe("controls that follow the permissions in this project", () => {
    it("a viewer of the project gets no enabled control the server refuses on the main pages", async () => {
        const page = await signIn("vic@example.com", "vic's long password");
        try {
            const offered: string[] = [];
            for (const p of PAGES) {
                await open(page, p.hash(), p.ready);
                for (const n of await enabledChangeControls(page)) offered.push(`${p.hash()}: ${n}`);
            }
            expect(offered).toEqual([]);

            // The main actions are there, switched off, and say why when reached by keyboard.
            await open(page, `#/projects/${projectId}/requirements`, "People can sign in");
            const add = page.getByRole("button", { name: "Add requirement" });
            await pwExpect(add).toHaveAttribute("aria-disabled", "true");
            await add.hover();
            await pwExpect(page.locator(".tt:not([hidden])").filter({ hasText: WRITE })).toBeVisible();
            await add.click({ force: true });
            await pwExpect(page.getByLabel("Title")).toHaveCount(0);

            await open(page, `#/projects/${projectId}/scripts`, "Scripts");
            await pwExpect(page.getByRole("button", { name: "New test script", exact: true })).toHaveAttribute("aria-disabled", "true");
            await pwExpect(page.getByRole("button", { name: "Import", exact: true })).toHaveAttribute("aria-disabled", "true");
            await pwExpect(page.getByRole("button", { name: "Run", exact: true })).toHaveAttribute("aria-disabled", "true");

            await open(page, `#/projects/${projectId}/settings?section=environments`, "staging");
            const addEnv = page.getByRole("button", { name: "Add an environment" });
            await pwExpect(addEnv).toHaveAttribute("aria-disabled", "true");
            await addEnv.hover();
            await pwExpect(page.locator(".tt:not([hidden])").filter({ hasText: SETTINGS })).toBeVisible();
            await pwExpect(page.getByRole("button", { name: "Edit staging" })).toHaveCount(0);

            // Reading stays open: View shows a helper's code, a set of reusable steps and an element, with nothing to change.
            await open(page, `#/projects/${projectId}/scripts?section=helpers`, "cart-tools");
            await page.getByRole("button", { name: "View cart-tools" }).click();
            await pwExpect(page.getByRole("heading", { name: /Viewing: cart-tools/ })).toBeVisible();
            await pwExpect(page.locator("main").getByText("cartTotal").first()).toBeVisible();
            await pwExpect(page.getByText("Read-only", { exact: true })).toBeVisible();
            await pwExpect(page.getByRole("button", { name: "Save helper" })).toBeDisabled();
            await open(page, `#/projects/${projectId}/scripts?section=steps`, "Wait a moment");
            await page.getByRole("button", { name: "View Wait a moment" }).click();
            await pwExpect(page.getByTestId("block-view").getByRole("listitem")).toHaveCount(1);
            await open(page, `#/projects/${projectId}/scripts?section=elements`, "Logo");
            await page.getByRole("button", { name: "View Header / Logo" }).click();
            const dialog = page.getByRole("dialog", { name: "Element" });
            await pwExpect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Header / Logo");
            await pwExpect(dialog.getByLabel("Name", { exact: true })).toBeDisabled();
            await pwExpect(dialog.getByRole("button", { name: "Save changes" })).toHaveCount(0);
            await dialog.getByRole("button", { name: "Close" }).click();

            // The fields are switched off one by one, so the help beside them still opens.
            await open(page, `#/projects/${projectId}/settings?section=accounts`, "Test accounts");
            await pwExpect(page.getByLabel("Username or email")).toHaveValue("admin@shop.example.com");
            await pwExpect(page.getByLabel("Username or email")).toBeDisabled();
            const totpHelp = page.getByRole("button", { name: "About Authenticator secret" });
            await pwExpect(totpHelp).toBeEnabled();
            await totpHelp.click();
            await pwExpect(page.locator(".tt:not([hidden])").filter({ hasText: "secret key behind this account" })).toBeVisible();
            await open(page, `#/projects/${projectId}/settings?section=data`, "Expected answer");
            await pwExpect(page.locator("#wp-url")).toBeDisabled();
            await pwExpect(page.getByRole("button", { name: "About Expected answer" })).toBeEnabled();

            // Storage: the backup needs platform settings in this project; it is not offered.
            await open(page, `#/projects/${projectId}/settings?section=storage`, "Storage and backup");
            await page.getByRole("button", { name: "Change storage and backup" }).click();
            await pwExpect(page.getByTestId("storage-card")).toBeVisible();
            await pwExpect(page.getByRole("button", { name: "Download backup" })).toHaveCount(0);
            await pwExpect(page.getByRole("button", { name: "Save settings" })).toHaveAttribute("aria-disabled", "true");

            // The server agrees: what was switched off is refused.
            const status = await page.evaluate(async (id) => {
                const r = await fetch(`/api/projects/${id}/requirements`, { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "ai-studio", "x-csrf-token": decodeURIComponent(/(?:^|;\s*)aitp_csrf=([^;]+)/.exec(document.cookie)?.[1] ?? "") }, body: JSON.stringify({ title: "Not allowed" }) });
                return r.status;
            }, projectId);
            expect(status).toBe(403);
        } finally {
            await page.context().close();
        }
    }, 120_000);

    it("an owner gets every one of those controls", async () => {
        const page = await signIn("olga@example.com", "olga's long password");
        try {
            const want: Array<[string, string, string[]]> = [
                [`#/projects/${projectId}/requirements`, "People can sign in", ["Import", "Add requirement"]],
                [`#/projects/${projectId}/requirements/${requirementId}`, "Test cases that cover it", ["Edit", "Delete", "Link test cases"]],
                [`#/projects/${projectId}/tests`, "Verify sign in", ["Import", "Add test case (manual)"]],
                [`#/projects/${projectId}/scripts`, "Scripts", ["Import", "New test script"]],
                [`#/projects/${projectId}/scripts?section=steps`, "Wait a moment", ["Add reusable steps", "Edit Wait a moment", "Delete Wait a moment"]],
                [`#/projects/${projectId}/scripts?section=elements`, "Logo", ["Add element", "Import"]],
                [`#/projects/${projectId}/scripts?section=helpers`, "Helpers in this project", ["Add a helper"]],
                [`#/projects/${projectId}/runs?section=schedules`, "Scheduled runs", ["New schedule", "Write your own"]],
                [`#/projects/${projectId}/runs?section=deploys`, "Run after a deploy", ["Create a token"]],
                [`#/projects/${projectId}/settings?section=environments`, "staging", ["Add an environment", "Edit staging", "Remove staging"]],
                [`#/projects/${projectId}/settings?section=data`, "Import a table", ["Add file"]],
                [`#/projects/${projectId}/settings?section=accounts`, "Test accounts", ["Add an account", "Save accounts"]],
                [`#/projects/${projectId}/settings?section=alerts`, "Alerts", ["Add a channel"]],
                [`#/projects/${projectId}/settings?section=issues`, "Issue tracker", ["Connect an issue tracker", "Connect Sentry"]],
            ];
            const missing: string[] = [];
            for (const [hash, ready, names] of want) {
                await open(page, hash, ready);
                const shown = await page.locator("main button:visible").evaluateAll((els) => els.filter((b) => b.getAttribute("aria-disabled") !== "true").map((b) => (b.getAttribute("aria-label") || b.textContent || "").trim()));
                for (const n of names) if (!shown.includes(n)) missing.push(`${hash}: ${n}`);
            }
            expect(missing).toEqual([]);
            await open(page, `#/projects/${projectId}/settings?section=storage`, "Storage and backup");
            await page.getByRole("button", { name: "Change storage and backup" }).click();
            await pwExpect(page.getByRole("button", { name: "Download backup" })).toBeVisible();
        } finally {
            await page.context().close();
        }
    }, 120_000);
});
