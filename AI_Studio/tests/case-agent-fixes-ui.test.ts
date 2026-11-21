/**
 * Founder 2026-11-19 fixes FX11 to FX14 in a real browser against a real platform, no worker:
 * - FX12: a Test Case Generation project that also chose the API Testing Agent opens its explore form without the "Add what the
 *   agents need first" pop-up (that agent does not run, owner decision Q6); a project of the API agent alone still gets it;
 * - FX13: "How much to explore" says "about N test cases from the AI" in such a project (explore form and Settings, General) and
 *   "about N tests from the AI" in other projects;
 * - FX11: Settings, General says what the Test Case Generation Agent does (explores or reads requirements, builds a tree, writes test
 *   cases) instead of "which checks run"; an Accessibility project keeps the checks wording;
 * - FX14: all of the above read the server's `caseAgent` (GET /api/projects/:id/testing-agents).
 * Axe in light and dark, and a phone width (390 px) with no sideways scrolling.
 *
 * Requires web/dist: node scripts/with-lock.mjs build,browser -- sh -c "npx vite build web && npx vitest run tests/case-agent-fixes-ui.test.ts"
 * Screenshots: $SHOTS_DIR (when set). Port: platform 7671.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { LEVEL_SETTINGS } from "../src/engine/levels.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 7671;
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.SHOTS_DIR;
const SITE = "http://127.0.0.1:7672";
const N = LEVEL_SETTINGS.thorough.maxScenarios;

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let browser: Browser;
let page: Page;
const consoleErrors: string[] = [];
const ids = { tcg: "", tcgApi: "", apiOnly: "", a11y: "" };

async function agentProject(name: string, agents: string[]): Promise<string> {
    const made = await server.inject({ method: "POST", url: "/api/projects", payload: { name, platforms: ["web"], testingModes: ["agent"], agents } });
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json().id as string;
    platform.repo.createApplication(id, SITE, { ...DEFAULT_JOB_OPTIONS });
    return id;
}

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-case-agent-fixes-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "case-agent-fixes-ui-secret-0123456789", HOST: "127.0.0.1", PORT: String(PORT), WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    ids.tcg = await agentProject("Case shop", ["test-generation"]);
    ids.tcgApi = await agentProject("Case shop with its API", ["test-generation", "api"]);
    ids.apiOnly = await agentProject("API shop", ["api"]);
    ids.a11y = await agentProject("Accessible shop", ["accessibility"]);

    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const shot = async (name: string) => {
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
};
async function axeBoth() {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(300);
        const r = await new AxeBuilder({ page }).analyze();
        expect(r.violations.map((v) => `${scheme} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: null });
}
async function onPhone(name: string) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await shot(name);
    await page.setViewportSize({ width: 1280, height: 900 });
}
const dialog = () => page.getByRole("dialog", { name: "Add what the agents need first" });

describe("the explore form (FX12, FX13)", () => {
    it("a Test Case Generation project with the API agent too: no pop-up for the OpenAPI document, and test cases per level", async () => {
        await page.goto(`${BASE}/#/new?project=${ids.tcgApi}`);
        const level = page.getByTestId("explore-level");
        await pwExpect(level).toContainText(`about ${N} test cases from the AI.`);
        await pwExpect(page.getByTestId("explore-agents")).toHaveText("The Test Case Generation Agent writes this project’s test cases. The API Testing Agent comes back in a later update.");
        await page.waitForTimeout(500);
        await pwExpect(dialog()).toHaveCount(0);
        expect(await level.innerText()).not.toMatch(/\btests from the AI/);
        // F3 M2: P4.1 bans the check family, and the agent turns screen review off.
        expect(await level.innerText()).not.toMatch(/screen review/i);
        await pwExpect(level).toContainText("Up to 120 pages in the tree, 5 clicks deep, about 100 test cases from the AI. Uses more AI and takes longer.");
        await shot("fx12-explore-tcg-api.png");
        await axeBoth();
        await onPhone("fx12-explore-tcg-api-phone.png");
    });

    it("a project of the API agent alone still asks for it, and counts tests", async () => {
        await page.goto(`${BASE}/#/new?project=${ids.apiOnly}`);
        await pwExpect(dialog()).toBeVisible();
        await pwExpect(dialog()).toContainText("OpenAPI document");
        await page.keyboard.press("Escape");
        await pwExpect(page.getByTestId("explore-level")).toContainText(`about ${N} tests from the AI.`);
    });
});

describe("Settings, General (FX11, FX13)", () => {
    it("a Test Case Generation project: what the agent does, and test cases per level", async () => {
        await page.goto(`${BASE}/#/projects/${ids.tcg}/settings`);
        const panel = page.getByTestId("project-agents");
        await pwExpect(panel.getByTestId("project-agents-about")).toContainText("The Test Case Generation Agent explores this project’s application or reads its requirements, builds a tree and writes test cases.");
        await pwExpect(panel.getByTestId("agent-picker")).toContainText("The Test Case Generation Agent explores the application or reads its requirements, builds a tree and writes test cases.");
        expect(await panel.getByTestId("project-agents-about").innerText()).not.toMatch(/checks/);
        await pwExpect(page.getByTestId("explore-level-setting")).toContainText(`about ${N} test cases from the AI.`);
        expect(await page.getByTestId("explore-level-setting").innerText()).not.toMatch(/screen review/i);
        await panel.scrollIntoViewIfNeeded();
        await shot("fx11-settings-tcg.png");
        await axeBoth();
        await onPhone("fx11-settings-tcg-phone.png");
    });

    it("an Accessibility project keeps the checks wording and tests per level", async () => {
        await page.goto(`${BASE}/#/projects/${ids.a11y}/settings`);
        await pwExpect(page.getByTestId("project-agents-about")).toContainText("The agents decide which checks run when the AI explores this project’s application.");
        await pwExpect(page.getByTestId("explore-level-setting")).toContainText(`about ${N} tests from the AI.`);
    });

    it("logged no script errors", () => {
        expect(consoleErrors).toEqual([]);
    });
});
