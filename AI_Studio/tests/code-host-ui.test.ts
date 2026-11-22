/**
 * Connect GitHub on Integrations (P7-3 follow-up), in a real browser against the real built UI (web/dist) and a real platform (port 9631,
 * no worker, no AI, no sign-in). The card asks only for the repository, the token and pull request feedback; the save is sent with
 * `verify: false` by the test (so nothing calls GitHub), and the connection test's answer is a stand-in. The webhook address and the
 * secret the page made are shown once, after the save that made them; the stored connection never sends back the token or the secret.
 * Disconnect removes it. Axe in both colour schemes, and a phone width without sideways scrolling.
 *
 *   node scripts/with-lock.mjs build,browser -- sh -c "npx vite build web && npx vitest run tests/code-host-ui.test.ts"
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 9631;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "ghp_codeHostUiToken0123456789abcdef";
const SHOTS = process.env.SHOTS_DIR;

let browser: Browser;
let page: Page;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let projectId: string;
const sent: Array<Record<string, unknown>> = [];

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-codehostui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "code-host-ui-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    projectId = String(platform.repo.createProject({ name: "Repo shop" }).id);
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
    // The save goes to the real platform without its check against GitHub; nothing here reaches GitHub.
    await page.route("**/api/projects/*/code-host", async (route) => {
        if (route.request().method() !== "PUT") return route.continue();
        const body = route.request().postDataJSON() as Record<string, unknown>;
        sent.push(body);
        await route.continue({ postData: JSON.stringify({ ...body, verify: false }) });
    });
    await page.route("**/api/projects/*/code-host/test", (route) => route.fulfill({ json: { ok: true, message: "Connected to acme/shop." } }));
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

async function axeBoth() {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(300);
        const result = await new AxeBuilder({ page }).include('[data-testid="integration-code-host"]').analyze();
        expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: null });
}

const card = () => page.getByTestId("integration-code-host");

describe("Connect GitHub", () => {
    it("asks only for the repository, the token and pull request feedback", async () => {
        await page.goto(`${BASE}/#/integrations`);
        await pwExpect(card().getByRole("heading", { name: "Connect GitHub" })).toBeVisible({ timeout: 20_000 });
        await pwExpect(card()).toContainText("Not connected");
        const form = card().getByRole("form", { name: "Connect GitHub" });
        await pwExpect(form.locator("input")).toHaveCount(3);
        await pwExpect(form.getByLabel("Repository")).toBeVisible();
        await pwExpect(form.getByLabel(/^Access token/)).toHaveAttribute("type", "password");
        await pwExpect(form.getByRole("checkbox", { name: /Pull request feedback/ })).not.toBeChecked();
        await axeBoth();
    }, 60_000);

    it("says what is wrong before sending anything", async () => {
        await card().getByLabel("Repository").fill("acme");
        await card().getByRole("button", { name: "Connect GitHub" }).click();
        await pwExpect(card().getByText("Enter the repository as owner/name, for example acme/shop.")).toBeVisible();
        await card().getByLabel("Repository").fill("acme/shop");
        await card().getByRole("button", { name: "Connect GitHub" }).click();
        await pwExpect(card().getByText("Enter the access token.")).toBeVisible();
        expect(sent).toEqual([]);
    }, 60_000);

    it("connects, and shows the webhook address and its secret once", async () => {
        await card().getByLabel(/^Access token/).fill(TOKEN);
        await card().getByRole("checkbox", { name: /Pull request feedback/ }).check();
        await card().getByRole("button", { name: "Connect GitHub" }).click();
        const hook = card().getByTestId("code-host-webhook");
        await pwExpect(hook).toContainText(`Payload URL: ${BASE}/api/code-host/github/aith_`);
        await pwExpect(hook).toContainText(/Secret: [0-9a-f]{48}/);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ owner: "acme", repo: "shop", token: TOKEN, feedback: true });
        expect(String(sent[0]!.webhookSecret)).toMatch(/^[0-9a-f]{48}$/);
        expect(await hook.innerText()).toContain(String(sent[0]!.webhookSecret));
        const conn = card().getByTestId("code-host-connection");
        await pwExpect(conn).toContainText("acme/shop");
        await pwExpect(conn).toContainText("pull request feedback on");
        await pwExpect(card()).toContainText("Connected");
        // The stored connection never sends the token or the secret back.
        const got = (await server.inject({ method: "GET", url: `/api/projects/${projectId}/code-host` })).json();
        expect(got).toMatchObject({ connected: true, connection: { owner: "acme", repo: "shop", feedback: true, webhookSecretSet: true } });
        expect(JSON.stringify(got)).not.toContain(TOKEN);
        expect(JSON.stringify(got)).not.toContain(String(sent[0]!.webhookSecret));
        if (SHOTS) await card().screenshot({ path: path.join(SHOTS, "connect-github-saved.png") });
        await axeBoth();
        // Shown once: after a reload the address is gone.
        await page.reload();
        await pwExpect(card().getByTestId("code-host-connection")).toBeVisible({ timeout: 20_000 });
        await pwExpect(card().getByTestId("code-host-webhook")).toHaveCount(0);
    }, 60_000);

    it("tests the connection, changes feedback without the token again, and fits a phone", async () => {
        await card().getByRole("button", { name: "Test the connection" }).click();
        await pwExpect(card().getByRole("status")).toHaveText("Connected to acme/shop.");
        await card().getByRole("button", { name: "Change" }).click();
        await card().getByRole("checkbox", { name: /Pull request feedback/ }).uncheck();
        await card().getByRole("button", { name: "Save changes" }).click();
        await pwExpect(card().getByTestId("code-host-connection")).toContainText("pull request feedback off");
        expect(sent[1]).toEqual({ owner: "acme", repo: "shop", feedback: false });
        await page.setViewportSize({ width: 390, height: 844 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
        await page.setViewportSize({ width: 1200, height: 900 });
    }, 60_000);

    it("disconnects", async () => {
        page.once("dialog", (d) => void d.accept());
        await card().getByRole("button", { name: "Disconnect" }).click();
        await pwExpect(card().getByRole("form", { name: "Connect GitHub" })).toBeVisible();
        expect((await server.inject({ method: "GET", url: `/api/projects/${projectId}/code-host` })).json()).toEqual({ connected: false });
    }, 60_000);
});
