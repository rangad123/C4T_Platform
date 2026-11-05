/**
 * Requirements → test cases in a real browser against the real built UI (`web/dist`) and a real platform whose AI is a local fake
 * provider (tests/fixtures/fake-llm-provider.ts; never a real model), for a code-based project: the "Generate test cases using AI"
 * card, its choosing list (all or some requirements; one that has test cases says so), the plain refusal when nothing is chosen,
 * the success banner and View test cases; the Test cases list (type pills with counts, the columns, adding one by hand, opening
 * one, no Run or New test); an old `?section=manual` link; an AI agent project shows no card and its cases to read only. Axe on
 * both pages, a clean console. Set CASES_SHOTS=<folder> for screenshots. Port 7842, fake provider 7843.
 *
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/test-cases-ui.test.ts
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { seedProject, type Seed } from "./fixtures/dashboard-seed.js";
import { startFakeProvider, type FakeProvider } from "./fixtures/fake-llm-provider.js";

const PORT = 7842;
const BASE = `http://127.0.0.1:${PORT}`;

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let fake: FakeProvider;
let browser: Browser;
let page: Page;
let dir = "";
let shop: Seed;
let agentShop: Seed;
const reqIds: Record<string, string> = {};
const consoleErrors: string[] = [];
const requirementsUrl = (s: Seed = shop) => `${BASE}/#/projects/${s.projectId}/requirements`;
const casesUrl = (s: Seed = shop, q = "") => `${BASE}/#/projects/${s.projectId}/tests${q}`;
const shot = async (name: string) => {
    if (process.env.CASES_SHOTS) await page.screenshot({ path: path.join(process.env.CASES_SHOTS, `${name}.png`), fullPage: true });
};
const api = async (method: string, url: string, payload?: unknown) => {
    const res = await server.inject({ method: method as never, url, payload: payload as never });
    expect(res.statusCode, res.body).toBeLessThan(300);
    return JSON.parse(res.body);
};
/** A hash-only navigation keeps component state: go through a blank page so each step starts clean. */
const open = async (url: string) => {
    await page.goto("about:blank");
    await page.goto(url);
};
const axe = async (what: string) => {
    await page.waitForTimeout(400);
    const result = await new AxeBuilder({ page }).analyze();
    expect(result.violations.map((v) => `${what}: ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    fake = await startFakeProvider(7843);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-cases-ui-"));
    platform = bootstrap(
        loadConfig({
            DATA_DIR: dir,
            SECRET_KEY: "test-secret-key-0123456789",
            HOST: "127.0.0.1",
            PORT: String(PORT),
            SCHEDULER_ENABLED: "false",
            LLM_PROVIDER: "openai-compatible",
            LLM_BASE_URL: `${fake.url}/openai/v1`,
            LLM_MODEL: "case-model",
            LLM_API_KEY: "fake-key",
        }),
    );
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });

    shop = seedProject(platform, "Atlas shop", "https://atlas.example.test");
    platform.repo.updateProject(shop.projectId, { testingModes: ["code"] });
    for (const [key, title] of [["pay", "A shopper can pay by card"], ["basket", "The basket keeps its items"]] as const) {
        reqIds[key] = (await api("POST", `/api/projects/${shop.projectId}/requirements`, { title })).id;
    }
    // A case written before: it comes from the first requirement.
    await api("POST", `/api/projects/${shop.projectId}/manual-cases`, { title: "Check the printed receipt", requirementId: reqIds.pay, steps: [{ action: "Print the receipt", expected: "It shows the order number" }] });
    agentShop = seedProject(platform, "Agent shop", "https://agent.example.test");
    platform.repo.updateProject(agentShop.projectId, { testingModes: ["agent"] });
    await api("POST", `/api/projects/${agentShop.projectId}/requirements`, { title: "Pages load" });
    await api("POST", `/api/projects/${agentShop.projectId}/manual-cases`, { title: "An older written case" });

    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
}, 90_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    await fake?.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("generating test cases from requirements", () => {
    it("shows the card in place of the old one, and turns the list into a choosing list", async () => {
        await open(requirementsUrl());
        const card = page.getByTestId("generate-cases");
        await pwExpect(card.getByRole("heading", { name: "Generate test cases using AI" })).toBeVisible();
        await pwExpect(card).toContainText("Automatically create test cases from your added requirements using AI.");
        await pwExpect(page.getByText("Tests from a requirements document")).toHaveCount(0);
        await pwExpect(page.getByRole("button", { name: "Add requirement" }).first()).toBeVisible();
        await pwExpect(page.getByRole("button", { name: "Import", exact: true })).toBeVisible();
        await card.getByRole("button", { name: "Generate test cases" }).click();
        const choose = page.getByRole("list", { name: "Requirements to choose from" });
        await pwExpect(choose).toBeVisible();
        await pwExpect(choose.getByRole("listitem").filter({ hasText: "A shopper can pay by card" })).toContainText("Has 1 test case already");
        await pwExpect(choose.getByRole("listitem").filter({ hasText: "The basket keeps its items" })).toContainText("No test cases yet");
        // Nothing chosen: said plainly, nothing sent.
        fake.reset();
        await card.getByRole("button", { name: "Generate test cases" }).click();
        await pwExpect(page.getByText("Choose at least one requirement to write test cases for.")).toBeVisible();
        expect(fake.seen).toHaveLength(0);
        await page.getByRole("group", { name: "Choose requirements" }).getByLabel(/Choose all/).check();
        await pwExpect(page.getByTestId("requirements-chosen")).toHaveText("2 requirements chosen");
        await axe("choosing list");
        await shot("requirements-choosing");
    });

    it("writes the cases, says how many in a banner, and View test cases opens them", async () => {
        fake.queue("*", {
            delayMs: 300,
            text: JSON.stringify({
                cases: [
                    { requirement: "REQ-1", title: "Verify paying by card", priority: "high", type: "automated", steps: [{ action: "Pay with a test card", expected: "The order is confirmed" }] },
                    { requirement: "REQ-1", title: "Check the bank statement shows one charge", priority: "critical", type: "manual", steps: [{ action: "Open the statement", expected: "One charge" }] },
                    { requirement: "REQ-2", title: "Verify the basket after signing in", priority: "medium", type: "automated", steps: [{ action: "Add an item and sign in", expected: "The item is still there" }] },
                ],
            }),
        });
        const tab = page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: /^Test cases/ });
        await pwExpect(tab).toContainText("1");
        await page.getByTestId("generate-cases").getByRole("button", { name: "Generate test cases for 2 requirements" }).click();
        await pwExpect(page.getByText("Writing test cases", { exact: true })).toBeVisible();
        // The outcome shows in the card where the person clicked, as a status that takes the focus.
        const outcome = page.getByTestId("generate-cases").getByTestId("generate-cases-outcome");
        await pwExpect(outcome).toHaveAttribute("role", "status");
        const banner = outcome.getByTestId("cases-generated");
        await pwExpect(banner).toContainText("Test cases generated");
        await pwExpect(banner).toContainText("3 test cases have been created from your requirements.");
        await pwExpect(outcome).toBeFocused();
        // The Test cases tab counts the new cases without a reload.
        await pwExpect(tab).toContainText("4");
        await pwExpect(page.getByRole("list", { name: "Requirements to choose from" })).toHaveCount(0);
        await shot("requirements-generated");
        await banner.getByRole("link", { name: "View test cases" }).click();
        await pwExpect(page.getByRole("heading", { name: "Test cases", exact: true })).toBeVisible();
    });
});

describe("the Test cases list", () => {
    it("shows one list with type pills, the columns, and no running", async () => {
        await open(casesUrl());
        const table = page.getByRole("table");
        await pwExpect(table.getByRole("row")).toHaveCount(5);
        await pwExpect(table.getByRole("columnheader")).toHaveText(["Choose every test case shown", "ID", "Test case", "Requirement", "Type", "Status", "Open"].map((t) => (t.startsWith("Choose") ? "" : t)));
        const pills = page.getByRole("group", { name: "Filter by type" });
        await pwExpect(pills.getByRole("button", { name: /All/ })).toHaveText("All 4");
        await pwExpect(pills.getByRole("button", { name: /Automated/ })).toHaveText("Automated 2");
        await pwExpect(pills.getByRole("button", { name: /Manual/ })).toHaveText("Manual 2");
        const row = table.getByRole("row").filter({ hasText: "Verify paying by card" });
        await pwExpect(row).toContainText("TC-002");
        await pwExpect(row.getByRole("link", { name: "REQ-1" })).toBeVisible();
        await pwExpect(row).toContainText("Automated");
        await pwExpect(row).toContainText("No script yet");
        await pwExpect(table.getByRole("row").filter({ hasText: "Check the printed receipt" })).toContainText("By hand");
        // Running belongs to Test scripts.
        await pwExpect(page.getByRole("button", { name: /^Run/ })).toHaveCount(0);
        await pwExpect(page.getByRole("button", { name: "New test" })).toHaveCount(0);
        await pwExpect(page.getByRole("link", { name: "New test" })).toHaveCount(0);
        await axe("test cases list");
        await shot("test-cases-list");
        await pills.getByRole("button", { name: /Manual/ }).click();
        await pwExpect(page).toHaveURL(/section=manual/);
        await pwExpect(table.getByRole("row")).toHaveCount(3);
    });

    it("adds one by hand from the menu, with its type and requirement", async () => {
        await open(casesUrl());
        await page.getByRole("button", { name: "Add test case (manual)" }).click();
        await pwExpect(page.getByRole("menuitem", { name: /Generate from requirements/ })).toBeVisible();
        await page.getByRole("menuitem", { name: /Write one by hand/ }).click();
        const form = page.getByRole("form", { name: "New test case" });
        await form.getByLabel("Title", { exact: true }).fill("Verify the basket total");
        await form.getByRole("radio", { name: /Automated/ }).check();
        await form.getByLabel("Requirement", { exact: true }).selectOption({ label: "REQ-2 The basket keeps its items" });
        await form.getByLabel("Step 1, what to do").fill("Add two items");
        await form.getByLabel("Step 1, what should happen").fill("The total adds up");
        await form.getByRole("button", { name: "Add test case" }).click();
        await pwExpect(page.getByText("Added TC-005 “Verify the basket total”.")).toBeVisible();
        const row = page.getByRole("table").getByRole("row").filter({ hasText: "Verify the basket total" });
        await pwExpect(row.getByRole("link", { name: "REQ-2" })).toBeVisible();
        await pwExpect(row).toContainText("Automated");
    });

    it("opens a case to change it, and choosing cases counts them", async () => {
        await page.getByRole("link", { name: "Open TC-003" }).click();
        const panel = page.getByTestId("case-open");
        await pwExpect(panel).toContainText("Check the bank statement shows one charge");
        await pwExpect(panel).toContainText("Done by hand, so it has no test script");
        await panel.getByLabel("Title", { exact: true }).fill("Check the statement shows one charge");
        await panel.getByRole("button", { name: "Save changes" }).click();
        await pwExpect(page.getByText("Saved TC-003 “Check the statement shows one charge”.")).toBeVisible();
        await page.getByLabel("Choose TC-001").check();
        await page.getByLabel("Choose TC-002").check();
        await pwExpect(page.getByTestId("cases-chosen")).toContainText("2 test cases chosen");
    });

    it("lands an old ?section=manual link on the list with Manual chosen", async () => {
        await open(casesUrl(shop, "?section=manual"));
        await pwExpect(page.getByRole("group", { name: "Filter by type" }).getByRole("button", { name: /Manual/ })).toHaveAttribute("aria-pressed", "true");
        await pwExpect(page.getByRole("table").getByRole("row").filter({ hasText: "Verify paying by card" })).toHaveCount(0);
        await pwExpect(page.getByRole("table").getByRole("row").filter({ hasText: "Check the printed receipt" })).toHaveCount(1);
    });
});

describe("an AI agent project", () => {
    it("shows no generate card on Requirements, and its cases to read only", async () => {
        await open(requirementsUrl(agentShop));
        await pwExpect(page.getByRole("list", { name: "Requirements" })).toBeVisible();
        await pwExpect(page.getByTestId("generate-cases")).toHaveCount(0);
        await open(casesUrl(agentShop));
        await pwExpect(page.getByText("Test cases are for code-based projects.")).toBeVisible();
        // The read-only line leads to the tests the agents made.
        await pwExpect(page.getByTestId("agent-project-tests")).toHaveAttribute("href", `#/projects/${agentShop.projectId}/scripts`);
        await pwExpect(page.getByRole("table")).toContainText("An older written case");
        await pwExpect(page.getByRole("button", { name: "Add test case (manual)" })).toHaveCount(0);
    });

    it("kept the browser console clean", () => {
        expect(consoleErrors).toEqual([]);
    });
});
