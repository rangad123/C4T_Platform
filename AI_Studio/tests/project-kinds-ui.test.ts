/**
 * The two kinds of project in a real browser (round 38): an AI agent project, a code project and a mixed one (made with both
 * testing modes before a project had one). Each one's tabs and their order, the projects list row (the kind's tile, the type chip,
 * the platform, the agent tiles with "+N", a code row's status), the legend under the list, the project header above the tabs,
 * the code dashboard's empty state with nothing about exploring, and an old Agent runs link that still opens.
 *
 * The platform underneath is real (seeded through the repo and the HTTP API). Port 7801.
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/project-kinds-ui.test.ts
 * Set KINDS_SHOTS=<folder> to also write screenshots.
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
import { routes } from "../web/src/lib/router.js";
import { addTest, seedRun, type Seed } from "./fixtures/dashboard-seed.js";

const PORT = 7801;
const BASE = `http://127.0.0.1:${PORT}`;

let dataDir = "";
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let page: Page;
let agent = "";
let code = "";
let ran = "";
let mixed = "";
const consoleErrors: string[] = [];

const api = async (method: string, url: string, payload?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { "content-type": "application/json" }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    return { status: res.status, body: await res.json().catch(() => null) };
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-project-kinds-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });

    const repo = platform.repo;
    agent = repo.createProject({ name: "Kestrel agents", platforms: ["web"], testingModes: ["agent"] }).id as string;
    repo.createApplication(agent, "http://127.0.0.1:7809", {});
    // Four agents: three tiles and "+1".
    expect((await api("PUT", `/api/projects/${agent}/testing-agents`, { agents: ["api", "accessibility", "security", "ux"] })).status).toBe(200);
    code = repo.createProject({ name: "Lynx code", platforms: ["android"], testingModes: ["code"] }).id as string;
    // A code project with test scripts and a run: its row shows the result, never "Not explored yet".
    ran = repo.createProject({ name: "Marten code", platforms: ["web"], testingModes: ["code"] }).id as string;
    const seed: Seed = { projectId: ran, appId: repo.createApplication(ran, "http://127.0.0.1:7808", {}), tests: new Map(), scripts: new Map() };
    for (const k of ["alpha", "beta"]) addTest(platform, seed, k);
    await seedRun(platform, seed, { alpha: "pass", beta: "fail" }, { daysAgo: 1 });
    mixed = repo.createProject({ name: "Newt mixed", platforms: ["ios"], testingModes: ["agent", "code"] }).id as string;
    // The widest row: an agent project with agent tiles, tests and a run. Its name must still show in full.
    const osprey = repo.createProject({ name: "Osprey agents", platforms: ["web"], testingModes: ["agent"] }).id as string;
    const wide: Seed = { projectId: osprey, appId: repo.createApplication(osprey, "http://127.0.0.1:7807", {}), tests: new Map(), scripts: new Map() };
    for (const k of ["one", "two", "three"]) addTest(platform, wide, k);
    await seedRun(platform, wide, { one: "pass", two: "pass", three: "fail" }, { daysAgo: 2 });
    expect((await api("PUT", `/api/projects/${osprey}/testing-agents`, { agents: ["api", "accessibility", "security", "ux", "performance"] })).status).toBe(200);

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

const shots = process.env.KINDS_SHOTS;
async function shot(name: string) {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
}
async function visit(hash: string) {
    await page.goto("about:blank");
    await page.goto(`${BASE}/${hash}`);
    await pwExpect(page.locator("h1").first()).toBeVisible();
}
const tabs = () => page.getByRole("navigation", { name: "Project sections", exact: true });
const tabNames = async () => {
    await pwExpect(tabs().locator("a.tab").first()).toBeVisible();
    return (await tabs().locator("a.tab").allTextContents()).map((t) => t.replace(/\d+$/, "").trim());
};
const row = (name: string) => page.locator("a.list-row", { hasText: name });
async function axe() {
    const r = await new AxeBuilder({ page }).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

const AGENT_TABS = ["Dashboard", "Runs", "Requirements", "Settings"];
const CODE_TABS = ["Dashboard", "Requirements", "Test cases", "Test scripts", "Test suites", "Runs", "Settings"];

describe("the projects list shows each project's kind", () => {
    it("an agent row: the robot tile, the Agent chip, the platform, three agent tiles and +1 naming the rest", async () => {
        await visit(routes.home);
        const r = row("Kestrel agents");
        await pwExpect(r.locator(".pk-tile")).toHaveAttribute("data-kind", "agent");
        await pwExpect(r.getByTestId("kind-chips")).toHaveText("Agent");
        await pwExpect(r.locator(".pk-platform")).toHaveAttribute("data-platform", "web");
        await pwExpect(r.locator(".pk-platform")).toHaveText("Web");
        const tiles = r.getByTestId("row-agents");
        await pwExpect(tiles.locator(".pk-agent")).toHaveCount(3);
        expect(await tiles.locator(".pk-agent").evaluateAll((els) => els.map((e) => e.getAttribute("data-agent")))).toEqual(["api", "accessibility", "security"]);
        await pwExpect(r.getByTestId("row-agents-more")).toContainText("+1");
        await pwExpect(r.getByTestId("row-agents-more")).toContainText("and 1 more: UX");
        await r.getByTestId("row-agents-more").hover();
        await pwExpect(page.locator(".tt.is-open").filter({ hasText: "UX" })).toBeVisible();
        await pwExpect(r).toContainText("Not explored yet");
        // No folder icon is left on any row: every lead tile is a kind.
        await pwExpect(page.locator("a.list-row .lead")).toHaveCount(0);
    });

    it("a code row: the code tile and chip, the platform, no agents, and what its test scripts have instead of exploring", async () => {
        const empty = row("Lynx code");
        await pwExpect(empty.locator(".pk-tile")).toHaveAttribute("data-kind", "code");
        await pwExpect(empty.getByTestId("kind-chips")).toHaveText("Code");
        await pwExpect(empty.locator(".pk-platform")).toHaveText("Android");
        await pwExpect(empty.getByTestId("row-agents")).toHaveCount(0);
        await pwExpect(empty).toContainText("No test scripts yet");
        await pwExpect(empty).not.toContainText("Not explored yet");
        const withTests = row("Marten code");
        await pwExpect(withTests).toContainText("1 of 2 tests passing");
        await pwExpect(withTests.locator(".badge").last()).not.toHaveText(/Not explored yet|No test scripts yet/);
        await pwExpect(withTests.getByTestId("row-agents")).toHaveCount(0);
    });

    it("a mixed row shows both chips, with a tip saying how to choose one", async () => {
        const r = row("Newt mixed");
        await pwExpect(r.locator(".pk-tile")).toHaveAttribute("data-kind", "mixed");
        await pwExpect(r.getByTestId("kind-chips").locator(".badge")).toHaveText(["Agent", "Code"]);
        await pwExpect(r.locator(".pk-platform")).toHaveText("iOS");
        await r.getByTestId("kind-chips").hover();
        await pwExpect(page.locator(".tt.is-open").filter({ hasText: "Choose one in Settings → General" })).toBeVisible();
    });

    it("the legend under the list names the project types, the platforms and every agent", async () => {
        const legend = page.getByRole("region", { name: "What the icons mean" });
        await pwExpect(legend.getByRole("heading")).toHaveText(["Project type", "Platforms", "Agents"]);
        await pwExpect(legend).toContainText("Agent");
        await pwExpect(legend).toContainText("Code");
        for (const w of ["Web", "Android", "iOS", "API", "Accessibility", "Security", "Chatbot", "Responsive UI", "UX", "Performance", "Test Case Generation"]) await pwExpect(legend).toContainText(w);
        await pwExpect(legend.locator(".ta-avatar")).toHaveCount(8);
        // On a laptop no project's name is cut short, even on the widest row (agents, a ribbon and a status).
        await pwExpect(row("Osprey agents").getByTestId("row-agents-more")).toContainText("+2");
        await pwExpect(row("Osprey agents")).toContainText("2 of 3 tests passing");
        const cut = await page.locator("a.list-row .title").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
        expect(cut).toEqual([]);
        await shot("list-1280");
        await axe();
    });

    it("on a phone the rows do not overflow and the agent tiles are dropped first", async () => {
        await page.setViewportSize({ width: 375, height: 800 });
        try {
            await visit(routes.home);
            await pwExpect(row("Kestrel agents")).toBeVisible();
            await pwExpect(row("Kestrel agents").getByTestId("row-agents")).toBeHidden();
            await pwExpect(row("Kestrel agents").locator(".pk-platform-word")).toBeHidden();
            expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
            await shot("list-375");
        } finally {
            await page.setViewportSize({ width: 1280, height: 900 });
        }
    });
});

describe("the tabs follow the project's kind", () => {
    it("an agent project has Dashboard, Runs, Requirements, Settings, on every place", async () => {
        for (const h of [routes.project(agent), routes.runs(agent), routes.requirements(agent), routes.projectSettings(agent)]) {
            await visit(h);
            expect(await tabNames(), h).toEqual(AGENT_TABS);
            await pwExpect(tabs().locator('[aria-current="page"]')).toHaveCount(1);
        }
    });

    it("a code project and a mixed project have Dashboard, Requirements, Test cases, Test scripts (count), Test suites, Runs, Settings", async () => {
        for (const id of [code, ran, mixed]) {
            for (const h of [routes.project(id), routes.scripts(id), routes.suites(id)]) {
                await visit(h);
                expect(await tabNames(), h).toEqual(CODE_TABS);
            }
        }
        await visit(routes.suites(ran));
        await pwExpect(tabs().getByRole("link", { name: /^Test scripts/ }).locator(".count")).toHaveText("2");
    });

    it("no project has an Agent runs tab, and an old Agent runs link still opens with no tab highlighted", async () => {
        for (const id of [agent, code, mixed]) {
            await visit(routes.project(id));
            await pwExpect(tabs().locator("a.tab").first()).toBeVisible();
            await pwExpect(tabs().getByRole("link", { name: "Agent runs" })).toHaveCount(0);
        }
        await visit(routes.agentRuns(agent));
        await pwExpect(page.getByRole("heading", { name: "Agent runs", level: 2 })).toBeVisible();
        expect(await tabNames()).toEqual(AGENT_TABS);
        await pwExpect(tabs().locator('[aria-current="page"]')).toHaveCount(0);
        // So does a place an agent project has no tab for.
        await visit(routes.scripts(agent));
        await pwExpect(page.getByRole("heading", { name: "Test scripts", level: 2 })).toBeVisible();
        await pwExpect(tabs().locator('[aria-current="page"]')).toHaveCount(0);
    });
});

describe("the project header sits above the tabs on every place", () => {
    it("the kind's tile beside the name as the one h1, no second type chip (only a mixed project shows its two); the place's title is an h2 under the tab bar", async () => {
        for (const [id, kind, label, chips] of [[agent, "agent", "Agent project", []], [code, "code", "Code project", []], [mixed, "mixed", "Agent and code project", ["Agent", "Code"]]] as const) {
            for (const [h, title] of [[routes.requirements(id), "Requirements"], [routes.runs(id), "Runs"], [routes.projectSettings(id), "Settings"]] as const) {
                await visit(h);
                const head = page.getByTestId("project-head");
                await pwExpect(head).toHaveAttribute("data-kind", kind);
                await pwExpect(page.locator("h1")).toHaveCount(1);
                await pwExpect(head.locator("h1")).not.toHaveText("…");
                await pwExpect(head.getByRole("img", { name: label })).toBeVisible();
                await pwExpect(head.getByTestId("kind-chips").locator(".badge")).toHaveText([...chips]);
                await pwExpect(page.getByTestId("place-head").locator("h2")).toHaveText(title);
                // Header, then the tab bar, then the place's title.
                const order = await page.evaluate(() => {
                    const at = (sel: string) => document.querySelector(sel);
                    const before = (a: Element | null, b: Element | null) => Boolean(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
                    return before(at('[data-testid="project-head"]'), at("nav.tabs")) && before(at("nav.tabs"), at('[data-testid="place-head"]'));
                });
                expect(order, h).toBe(true);
            }
        }
        await visit(routes.requirements(agent));
        await pwExpect(page.locator("h1")).toHaveText("Kestrel agents");
        await pwExpect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Kestrel agents");
        await pwExpect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Requirements");
    });
});

describe("the dashboard follows the project's kind", () => {
    it("an agent project offers exploring: Explore again in the header, Not explored yet with Start exploring", async () => {
        await visit(routes.project(agent));
        const head = page.getByTestId("project-head");
        await pwExpect(head.locator("h1")).toHaveText("Kestrel agents");
        await pwExpect(head.getByRole("link", { name: "Explore again" })).toBeVisible();
        await pwExpect(page.getByRole("heading", { name: "Not explored yet" })).toBeVisible();
        await pwExpect(page.getByRole("link", { name: "Start exploring" })).toBeVisible();
        await shot("dashboard-agent-1280");
    });

    it("a code project with no test scripts: Set up your code-based tests, Add test scripts opens Test scripts, nothing about exploring", async () => {
        await visit(routes.project(code));
        const empty = page.getByTestId("code-empty");
        await pwExpect(empty.getByRole("heading", { name: "Set up your code-based tests" })).toBeVisible();
        await pwExpect(empty).toContainText("Add your test scripts, configure the runner and start a test run.");
        await pwExpect(empty.getByRole("link", { name: "Add test scripts" })).toHaveAttribute("href", routes.scripts(code));
        await pwExpect(page.getByTestId("project-head")).toContainText("No application yet");
        const text = (await page.locator(".content").textContent()) ?? "";
        expect(text).not.toMatch(/Explore again|Not explored yet|Start exploring/);
        await shot("dashboard-code-1280");
        await axe();
        await empty.getByRole("link", { name: "Add test scripts" }).click();
        await pwExpect(page.getByRole("heading", { name: "Test scripts", level: 2 })).toBeVisible();
        await pwExpect(tabs().locator('[aria-current="page"]')).toHaveText(/^Test scripts/);
        await shot("place-code-scripts-1280");
    });

    it("a code project with test scripts shows its results and View tests, still with nothing about exploring", async () => {
        await visit(routes.project(ran));
        await pwExpect(page.getByRole("link", { name: "View tests" })).toBeVisible();
        await pwExpect(page.getByText("Last run", { exact: true })).toBeVisible();
        await pwExpect(page.getByTestId("code-empty")).toHaveCount(0);
        const text = (await page.locator(".content").textContent()) ?? "";
        expect(text).not.toMatch(/Explore again|Not explored yet|Start exploring|Last explored/);
    });

    it("a mixed project keeps exploring as before", async () => {
        await visit(routes.project(mixed));
        await pwExpect(page.getByTestId("project-head").getByRole("link", { name: "Explore again" })).toBeVisible();
        await pwExpect(page.getByRole("heading", { name: "Not explored yet" })).toBeVisible();
    });

    it("logged no errors in the browser console", () => {
        expect(consoleErrors).toEqual([]);
    });
});
