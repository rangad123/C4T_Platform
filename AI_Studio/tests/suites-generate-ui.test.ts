/**
 * Suites made from test scripts, in a real browser: "Create suite from selection" in the Test scripts selection bar, and the Test
 * suites page's "Generate suites" menu, by requirement (says what it will make, then makes it) and using AI (a local fake AI provider,
 * never a real model: the proposal is edited — renamed, a script moved, a suite removed — and nothing is saved until it is approved).
 * Needs web/dist (build it first, inside the lock). Runs a browser:
 *   TAQWRIGHT_HOME=/nonexistent-taqwright node scripts/with-lock.mjs browser -- npx vitest run tests/suites-generate-ui.test.ts
 * Ports: platform 8545, fake AI provider 8546.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { defaultFramework } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { startFakeProvider, type FakeProvider } from "./fixtures/fake-llm-provider.js";

const PORT = 8545;
const BASE = `http://127.0.0.1:${PORT}`;

let browser: Browser;
let page: Page;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let fake: FakeProvider;
let dataDir: string;
let projectId: string;
const ids: Record<string, string> = {};

const api = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(BASE + url, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return (res.status === 204 ? null : res.json()) as Promise<any>;
};
/** The project's suites by name (suites made in the same millisecond have no fixed order). */
const suites = async () => ((await api("GET", `/api/projects/${projectId}/test-suites`)).suites as Array<{ id: string; name: string; testCount: number }>).sort((a, b) => a.name.localeCompare(b.name));
const keysOf = async (sid: string) => ((await api("GET", `/api/projects/${projectId}/test-suites/${sid}`)).tests as Array<{ testId: string }>).map((t) => t.testId);

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    fake = await startFakeProvider(8546);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "suites-gen-ui-"));
    platform = bootstrap(
        loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "suites-gen-ui-secret-0123456789", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", LLM_PROVIDER: "openai-compatible", LLM_BASE_URL: `${fake.url}/openai/v1`, LLM_MODEL: "m", LLM_API_KEY: "fake-key" }),
    );
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    projectId = (await api("POST", "/api/projects", { name: "Suite maker shop", platforms: ["web"], testingModes: ["code"] })).id;
    platform.repo.createApplication(projectId, "http://127.0.0.1:8547", { ...DEFAULT_JOB_OPTIONS });
    for (const [key, title, area] of [
        ["API-001", "Cart opens", "Checkout"],
        ["API-002", "Pay by card", "Checkout"],
        ["API-003", "Search finds shoes", "Search"],
    ] as const) {
        const spec = TestSpecSchema.parse({ testId: key, title, kind: "api", category: area, steps: [{ action: "request", method: "GET", path: "/api/x" }, { action: "assertResponse", check: "status", expected: 200 }] });
        ids[title] = platform.repo.insertTest({ projectId, suiteId: platform.repo.getOrCreateSuite(projectId, area, area.toLowerCase()), jobId: null, spec, framework: defaultFramework("api"), validationStatus: "PENDING" });
    }
    const r = await api("POST", `/api/projects/${projectId}/requirements`, { ref: "REQ-1", title: "People can pay" });
    await api("POST", `/api/projects/${projectId}/manual-cases`, { title: "Verify paying", automation: "automated", requirementId: r.id, linkedTestIds: [ids["Cart opens"], ids["Pay by card"]], steps: [{ action: "Pay", expected: "Paid" }] });
    await api("POST", `/api/projects/${projectId}/requirements`, { ref: "REQ-2", title: "Nothing checks this yet" });
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1200, height: 1000 } })).newPage();
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    await fake?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("create suite from selection, on Test scripts", () => {
    it("names a suite of the selected scripts and opens it", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/scripts`);
        await page.getByRole("button", { name: "Select scripts" }).click();
        const bar = page.getByRole("region", { name: "Selected scripts" });
        // Nothing chosen yet: the button says why it does nothing.
        await pwExpect(bar.getByRole("button", { name: "Create suite from selection" })).toHaveAttribute("aria-disabled", "true");
        await page.getByLabel("Select Search finds shoes").check();
        await page.getByLabel("Select Cart opens").check();
        await bar.getByRole("button", { name: "Create suite from selection" }).click();
        const dialog = page.getByRole("dialog", { name: "Create suite from selection" });
        await pwExpect(dialog.getByText("The suite holds the 2 selected scripts")).toBeVisible();
        await pwExpect(dialog.getByLabel("Suite name")).toBeFocused();
        await dialog.getByLabel("Suite name").fill("Quick look");
        await dialog.getByRole("button", { name: "Create suite" }).click();
        await pwExpect(page.getByRole("heading", { name: "Quick look" })).toBeVisible();
        const made = (await suites()).find((s) => s.name === "Quick look")!;
        expect(page.url()).toContain(`/suites/${made.id}`);
        expect(await keysOf(made.id)).toEqual(["API-003", "API-001"]);
    });
});

describe("generate suites, on Test suites", () => {
    it("by requirement: says what it will make, then makes it", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/suites`);
        await page.getByRole("button", { name: "Generate suites" }).click();
        await page.getByRole("menuitem", { name: "By requirement" }).click();
        const panel = page.getByRole("region", { name: "Suites by requirement" });
        const plan = panel.getByRole("list", { name: "Suites by requirement" });
        await pwExpect(plan.getByText("REQ-1: People can pay")).toBeVisible();
        await pwExpect(plan.getByText("New suite with 2 scripts")).toBeVisible();
        await pwExpect(panel.getByText("1 requirement without a suite or with scripts left out")).toBeVisible();
        // Nothing is saved before the person says so.
        expect((await suites()).map((s) => s.name)).toEqual(["Quick look"]);
        await panel.getByRole("button", { name: "Create 1 suite" }).click();
        await pwExpect(panel.getByText("Suites generated")).toBeVisible();
        await pwExpect(page.getByRole("list", { name: "Suites you build" }).getByText("REQ-1: People can pay")).toBeVisible();
        const made = (await suites()).find((s) => s.name === "REQ-1: People can pay")!;
        expect(await keysOf(made.id)).toEqual(["API-001", "API-002"]);
        await panel.getByRole("button", { name: "Close" }).click();

        // Again: every requirement with scripts has its suite, so nothing is made.
        await page.getByRole("button", { name: "Generate suites" }).click();
        await page.getByRole("menuitem", { name: "By requirement" }).click();
        await pwExpect(page.getByText("Nothing to generate")).toBeVisible();
        await pwExpect(page.getByText("Up to date: no script is new to this requirement")).toBeVisible();
        await page.getByRole("region", { name: "Suites by requirement" }).getByRole("button", { name: "Close" }).click();
        expect((await suites()).length).toBe(2);

        // A person takes a script out, a schedule runs the suite, and the requirement gets a new script: the plan says all of it.
        await api("DELETE", `/api/projects/${projectId}/test-suites/${made.id}/tests/${ids["Cart opens"]}`);
        await api("POST", `/api/projects/${projectId}/schedules`, { name: "Nightly pay", kind: "validate", cadence: { type: "daily", time: "02:00" }, suiteId: made.id });
        const spec = TestSpecSchema.parse({ testId: "API-004", title: "Pay twice", kind: "api", category: "Checkout", steps: [{ action: "request", method: "GET", path: "/api/x" }, { action: "assertResponse", check: "status", expected: 200 }] });
        ids["Pay twice"] = platform.repo.insertTest({ projectId, suiteId: platform.repo.getOrCreateSuite(projectId, "Checkout", "checkout"), jobId: null, spec, framework: defaultFramework("api"), validationStatus: "PENDING" });
        const req1 = (await api("GET", `/api/projects/${projectId}/requirements`)).requirements.find((r: { ref: string }) => r.ref === "REQ-1");
        await api("POST", `/api/projects/${projectId}/manual-cases`, { title: "Verify paying twice", automation: "automated", requirementId: req1.id, linkedTestIds: [ids["Pay twice"]], steps: [{ action: "Pay twice", expected: "Paid once" }] });
        await page.getByRole("button", { name: "Generate suites" }).click();
        await page.getByRole("menuitem", { name: "By requirement" }).click();
        const again = page.getByRole("region", { name: "Suites by requirement" });
        await pwExpect(again.getByText("Adds 1 new script to this suite. 1 script you took out stays out.")).toBeVisible();
        await pwExpect(again.getByText("The schedule “Nightly pay” runs this suite: its next run includes the added scripts.")).toBeVisible();
        await again.getByRole("button", { name: "Update 1 suite" }).click();
        await pwExpect(again.getByText("Suites generated")).toBeVisible();
        expect(await keysOf(made.id)).toEqual(["API-002", "API-004"]);
        await again.getByRole("button", { name: "Close" }).click();
    });

    it("using AI: the proposal is edited and saved only when approved", async () => {
        fake.reset();
        fake.queue("*", {
            text: JSON.stringify({
                suites: [
                    { name: "Smoke", description: "The main paths, quickly.", scripts: ["S1", "S2"] },
                    { name: "Search", description: "Finding products.", scripts: ["S3"] },
                    { name: "Quick look", description: "A name the project has.", scripts: ["S1"] },
                ],
            }),
        });
        await page.getByRole("button", { name: "Generate suites" }).click();
        await page.getByRole("menuitem", { name: "Using AI" }).click();
        const panel = page.getByRole("region", { name: "Suites proposed by the AI" });
        await pwExpect(panel.getByLabel("Name of suite 1")).toHaveValue("Smoke");
        expect(fake.seen).toHaveLength(1);
        // A name the project has is said before saving, and blocks the save until it changes.
        await pwExpect(panel.getByText("This project already has a suite with this name.")).toBeVisible();
        await pwExpect(panel.getByRole("button", { name: "Save 3 suites" })).toHaveAttribute("aria-disabled", "true");
        await panel.getByRole("button", { name: "Remove the suite Quick look" }).click();
        // Move "Pay by card" from Smoke to Search, and rename Search.
        await panel.getByLabel("Move Pay by card to another suite").selectOption({ label: "Search" });
        await panel.getByLabel("Name of suite 2").fill("Search and paying");
        await pwExpect(panel.getByRole("list", { name: "Scripts in Search and paying" }).getByText("Pay by card")).toBeVisible();
        await pwExpect(panel.getByRole("list", { name: "Scripts in Smoke" }).getByText("Pay by card")).toHaveCount(0);
        const axe = await new AxeBuilder({ page }).include(".suite-gen").analyze();
        expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
        // Still nothing saved.
        expect((await suites()).length).toBe(2);

        await panel.getByRole("button", { name: "Save 2 suites" }).click();
        await pwExpect(panel.getByText("Suites saved", { exact: true })).toBeVisible();
        const list = await suites();
        expect(list.map((s) => s.name)).toEqual(["Quick look", "REQ-1: People can pay", "Search and paying", "Smoke"]);
        expect(await keysOf(list.find((s) => s.name === "Smoke")!.id)).toEqual(["API-001"]);
        expect(await keysOf(list.find((s) => s.name === "Search and paying")!.id)).toEqual(["API-003", "API-002"]);
        await pwExpect(page.getByRole("list", { name: "Suites you build" }).getByText("Search and paying")).toBeVisible();
        await panel.getByRole("button", { name: "Close" }).click();
        await pwExpect(panel).toHaveCount(0);
    });

    it("fits a phone-sized screen", async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${BASE}/#/projects/${projectId}/suites`);
        await page.reload();
        await page.getByRole("button", { name: "Generate suites" }).click();
        await page.getByRole("menuitem", { name: "By requirement" }).click();
        await pwExpect(page.getByText("Nothing to generate")).toBeVisible();
        const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        expect(wide).toBe(false);
        await page.setViewportSize({ width: 1200, height: 1000 });
    });
});
