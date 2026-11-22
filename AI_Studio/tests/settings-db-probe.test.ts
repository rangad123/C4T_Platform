/**
 * Phase 4 T26: Settings, Test data, Database checks (web/src/features/dbprobe/DbProbeCard.tsx). In a real browser against a real
 * platform: off by default with an empty address; a person who may manage connections switches it on with the probe's address
 * and token and saves; after a reload the token field is empty and says a token is saved (the token is never sent back); a refusal
 * from the server (an address that is not https://) is shown as its sentence; a person who may only look sees the setting read-only.
 * Axe in light and dark, no sideways scroll at phone width.
 *
 * Requires web/dist (build inside the lock):
 *   node scripts/with-lock.mjs build,browser -- sh -c "npx vite build web && npx vitest run tests/settings-db-probe.test.ts"
 * Port 9889. SHOTS_DIR=<dir> saves screenshots at desktop and phone widths.
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

const PORT = 9889;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS_DIR;
const TOKEN = "probe-ui-token-sentinel-0123456789abcdef";

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let browser: Browser;
let page: Page;
let projectId: string;
const consoleErrors: string[] = [];
/** The person's access to the project (null: as the platform answers). */
let access: null | { projectAdmin: boolean; permissions: string[] } = null;

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-settings-db-probe-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "settings-db-probe-secret-0123456789", HOST: "127.0.0.1", PORT: String(PORT), WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    const res = await fetch(`${BASE}/api/projects`, { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "ai-studio" }, body: JSON.stringify({ name: "Probe shop", platforms: ["web"], testingModes: ["agent"] }) });
    projectId = ((await res.json()) as { id: string }).id;

    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    await page.route("**/api/me/runner", (route) => route.fulfill({ json: { runner: null } }));
    await page.route(`**/api/projects/${projectId}`, async (route) => {
        if (route.request().method() !== "GET" || !access) return route.continue();
        const r = await route.fetch();
        await route.fulfill({ response: r, json: { ...(await r.json()), access } });
    });
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const open = async () => {
    await page.goto("about:blank");
    await page.goto(`${BASE}/#/projects/${projectId}/settings?section=data`);
    await pwExpect(card()).toBeVisible({ timeout: 20_000 });
};
const card = () => page.getByTestId("db-probe");
const shot = async (name: string) => {
    if (!SHOTS) return;
    await card().scrollIntoViewIfNeeded();
    await card().screenshot({ path: path.join(SHOTS, `${name}-desktop.png`) });
    await page.setViewportSize({ width: 375, height: 800 });
    await page.waitForTimeout(300);
    await card().scrollIntoViewIfNeeded();
    await card().screenshot({ path: path.join(SHOTS, `${name}-phone.png`) });
    await page.setViewportSize({ width: 1280, height: 900 });
};
async function axeBoth() {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(300);
        const r = await new AxeBuilder({ page }).include('[data-testid="db-probe"]').withTags(["wcag2a", "wcag2aa"]).analyze();
        expect(r.violations.map((v) => `${scheme}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
}

describe("Settings, Test data, Database checks", () => {
    it("is off by default, with an empty address and no token saved", async () => {
        await open();
        await pwExpect(card().getByRole("heading", { name: "Database checks" })).toBeVisible();
        await pwExpect(card().getByRole("checkbox", { name: /Check the database after tests that change data/ })).not.toBeChecked();
        await pwExpect(card().getByLabel("Probe address")).toHaveValue("");
        await pwExpect(card().getByLabel("Probe token")).toHaveValue("");
        await pwExpect(card().getByTestId("db-probe-token-state")).toContainText("at least 24 characters");
        await pwExpect(card().getByRole("button", { name: "Save" })).toBeDisabled();
        await shot("db-probe-off");
        await axeBoth();
        await page.setViewportSize({ width: 375, height: 800 });
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        await page.setViewportSize({ width: 1280, height: 900 });
    }, 60_000);

    it("shows the server's refusal as its sentence", async () => {
        await open();
        await card().getByRole("checkbox").check();
        await card().getByLabel("Probe address").fill("http://probe.example.com");
        await card().getByLabel("Probe token").fill(TOKEN);
        await card().getByRole("button", { name: "Save" }).click();
        await pwExpect(card()).toContainText("The probe address starts with https://");
        expect((await (await fetch(`${BASE}/api/projects/${projectId}/db-probe`)).json()) as unknown).toEqual({ enabled: false, url: "", tokenSaved: false });
    }, 60_000);

    it("saves the address and the token; after a reload the token is not sent back and the field says one is saved", async () => {
        await open();
        await card().getByRole("checkbox").check();
        await card().getByLabel("Probe address").fill("https://db-probe.example.com");
        await card().getByLabel("Probe token").fill(TOKEN);
        await card().getByRole("button", { name: "Save" }).click();
        await pwExpect(card()).toContainText("Saved. Runs check the stored data through your probe.");
        const saved = await (await fetch(`${BASE}/api/projects/${projectId}/db-probe`)).text();
        expect(JSON.parse(saved)).toEqual({ enabled: true, url: "https://db-probe.example.com", tokenSaved: true });
        expect(saved).not.toContain(TOKEN);

        await open();
        await pwExpect(card().getByRole("checkbox")).toBeChecked();
        await pwExpect(card().getByLabel("Probe address")).toHaveValue("https://db-probe.example.com");
        await pwExpect(card().getByLabel("Probe token")).toHaveValue("");
        await pwExpect(card().getByLabel("Probe token")).toHaveAttribute("type", "password");
        await pwExpect(card().getByTestId("db-probe-token-state")).toContainText("A token is saved");
        expect(await page.content()).not.toContain(TOKEN);
        await shot("db-probe-on");
        await axeBoth();
    }, 60_000);

    it("is read-only for a person who may not manage connections", async () => {
        access = { projectAdmin: false, permissions: ["ai_studio.access"] };
        try {
            await open();
            await pwExpect(card().getByRole("checkbox")).toBeDisabled();
            await pwExpect(card().getByLabel("Probe address")).toBeDisabled();
            await pwExpect(card().getByLabel("Probe token")).toBeDisabled();
            await pwExpect(card().getByRole("button", { name: "Save" })).toHaveCount(0);
        } finally {
            access = null;
        }
        expect(consoleErrors).toEqual([]);
    }, 60_000);
});
