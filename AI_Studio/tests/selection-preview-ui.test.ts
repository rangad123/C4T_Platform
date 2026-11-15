/**
 * The test-selection preview on Runs, After a deploy, in a real browser against the real built UI (web/dist) and a real platform:
 * the counts, the reasons and their source, unknown coverage shown as proposed, the "recommendation only" sentence, detected changes,
 * axe in both colour schemes and phone width. No worker runs, so nothing could be started even by mistake; the test also checks that
 * no job was created.
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

const PLATFORM_PORT = 9653;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;

let browser: Browser;
let page: Page;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let projectId: string;

const call = async (method: "GET" | "POST", url: string, body?: unknown) => {
    const res = await fetch(BASE + url, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null } as { status: number; body: any };
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-selui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    projectId = (await call("POST", "/api/projects", { name: "Shop" })).body.id;
    const imp = await call("POST", `/api/projects/${projectId}/specs`, {
        baseUrl: "http://127.0.0.1:9654",
        validate: false,
        specs: [
            { title: "Create an order", kind: "api", category: "API", steps: [{ action: "request", method: "POST", path: "/orders" }, { action: "assertResponse", check: "status", expected: 201 }] },
            { title: "Health answers", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/health" }, { action: "assertResponse", check: "status", expected: 200 }] },
            { title: "Cart opens", kind: "web", category: "Shop", steps: [{ action: "navigate", url: "/cart" }, { action: "assert", check: "visible", locator: { by: "text", value: "Cart" } }] },
            { title: "Broken one", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/x" }, { action: "assertResponse", check: "status", expected: 200 }] },
        ],
    });
    expect(imp.status, JSON.stringify(imp.body)).toBe(202);
    // The API tests passed yesterday on their current version: they count as covered only with such a run.
    for (const title of ["Create an order", "Health answers"]) {
        const t = platform.repo.listTests(projectId).find((x) => x.title === title)!;
        const exec = platform.repo.addExecution({ testId: t.id, scriptId: (platform.repo.getCurrentScript(t.id) as { id: string } | undefined)?.id ?? null, jobId: null, attempt: 1, status: "passed", durationMs: 500, startedAt: new Date(Date.now() - 86_400_000).toISOString(), steps: [] });
        platform.db.run("UPDATE test_executions SET test_version_id = (SELECT id FROM test_versions WHERE test_case_id = ? AND state = 'approved' ORDER BY version DESC LIMIT 1) WHERE id = ?", t.id, exec);
    }
    // A test whose stored steps cannot be read: shown under "Cannot run", never hidden.
    const broken = platform.repo.listTests(projectId).find((t) => t.title === "Broken one")!;
    platform.db.run("UPDATE test_cases SET spec_json = ? WHERE id = ?", "{not json", broken.id);
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const card = () => page.getByTestId("selection-preview");
async function axeBoth() {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(300);
        const result = await new AxeBuilder({ page }).include('[data-testid="selection-preview"]').analyze();
        expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: null });
}

describe("which tests a change calls for", () => {
    it("shows proposed, unknown and not-matched tests with reasons, and says nothing was run or skipped", async () => {
        const jobsBefore = platform.db.all("SELECT id FROM generation_jobs").length;
        await page.goto(`${BASE}/#/projects/${projectId}/runs?section=deploys`);
        await pwExpect(card()).toBeVisible({ timeout: 20_000 });
        const preview = card().getByRole("button", { name: "Preview the tests" });
        await pwExpect(preview).toBeDisabled();
        await card().getByLabel("Changed endpoints, one per line (a method and a path)").fill("POST /orders\nFETCH /nope");
        await preview.click();
        const result = card().getByTestId("selection-result");
        await pwExpect(result).toContainText("This is a recommendation only. No test was skipped or run, and deploy triggers still run every runnable test.");
        await pwExpect(card().getByTestId("selection-matched")).toContainText("Create an order");
        await pwExpect(card().getByTestId("selection-matched")).toContainText("The change names POST /orders, and its steps call POST /orders (step 1).");
        await pwExpect(card().getByTestId("selection-matched").getByText("Declared")).toBeVisible();
        await pwExpect(card().getByTestId("selection-unknown")).toContainText("Cart opens");
        await pwExpect(card().getByTestId("selection-unknown")).toContainText("Proposed because what it touches is not fully known");
        // One entry could not be read, so no test is "not matched": the complete API test is proposed, with why.
        await pwExpect(card().getByTestId("selection-unknown")).toContainText("Health answers");
        await pwExpect(card().getByTestId("selection-unknown")).toContainText("Proposed because the change list was not read in full");
        await pwExpect(card().getByTestId("selection-not-matched")).toHaveCount(0);
        await pwExpect(result).toContainText("FETCH /nope");
        await pwExpect(result.getByText("tests proposed")).toBeVisible();
        // Coverage of "Cart opens" is not fully known, and one entry could not be read: a full run is required, with the reasons.
        const fullRun = card().getByTestId("selection-full-run");
        await pwExpect(fullRun).toContainText("only running every test is safe");
        await pwExpect(fullRun).toContainText("1 entry is not a page or an endpoint");
        await pwExpect(fullRun).toContainText("What 1 test touches is not fully known");
        await pwExpect(card().getByTestId("selection-cannot-run")).toContainText("Broken one");
        await pwExpect(card().getByTestId("selection-cannot-run")).toContainText("Cannot run: its stored steps cannot be read. Open it to fix or delete it.");
        // With every entry read, the complete API test that touches none of them is "not matched", with its own reason.
        await card().getByLabel("Changed endpoints, one per line (a method and a path)").fill("POST /orders");
        await preview.click();
        await pwExpect(card().getByTestId("selection-full-run")).not.toContainText("not a page or an endpoint");
        await card().getByTestId("selection-not-matched").getByText("Not matched (1)").click();
        await pwExpect(card().getByTestId("selection-not-matched")).toContainText("Health answers");
        await pwExpect(card().getByTestId("selection-not-matched")).toContainText("Not proposed: what it touches is fully known from its steps (1 page or endpoint), and none of it is in the change.");
        expect(platform.db.all("SELECT id FROM generation_jobs").length).toBe(jobsBefore);
        await axeBoth();
    }, 90_000);

    it("fills in detected changes, or says plainly that none were detected yet", async () => {
        await card().getByRole("button", { name: "Use detected changes" }).click();
        await pwExpect(card().getByTestId("selection-detected-note")).toContainText("No change has been detected yet");
        await pwExpect(card().getByRole("button", { name: "Preview the tests" })).toBeDisabled();
    }, 60_000);

    it("fits a phone screen without sideways scrolling", async () => {
        await page.setViewportSize({ width: 375, height: 800 });
        await page.goto(`${BASE}/#/projects/${projectId}/runs?section=deploys`);
        await pwExpect(card()).toBeVisible({ timeout: 20_000 });
        await card().getByLabel("Changed pages, one per line").fill("/cart");
        await card().getByRole("button", { name: "Preview the tests" }).click();
        await pwExpect(card().getByTestId("selection-result")).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        await page.setViewportSize({ width: 1200, height: 900 });
    }, 60_000);

    it("says when recorded coverage is out of date and which deploy triggers run the same tests or cannot be compared", async () => {
        // "Cart opens" ran its current version yesterday and failed: what it touches now is not known.
        const cart = platform.repo.listTests(projectId).find((t) => t.title === "Cart opens")!;
        const startedAt = new Date(Date.now() - 86_400_000).toISOString();
        const exec = platform.repo.addExecution({ testId: cart.id, scriptId: (platform.repo.getCurrentScript(cart.id) as { id: string } | undefined)?.id ?? null, jobId: null, attempt: 1, status: "failed", durationMs: 1000, startedAt, steps: [] });
        platform.db.run("UPDATE test_executions SET test_version_id = (SELECT id FROM test_versions WHERE test_case_id = ? AND state = 'approved' ORDER BY version DESC LIMIT 1) WHERE id = ?", cart.id, exec);
        // A trigger made here (same runner as the viewer) and an older one with no recorded maker.
        expect((await call("POST", `/api/projects/${projectId}/triggers`, { label: "CI" })).status).toBe(201);
        platform.db.run("INSERT INTO trigger_tokens (id, project_id, label, token_hash, hint, allow_url, created_at, created_by) VALUES (?,?,?,?,?,?,?,?)", "tok-legacy", projectId, "Legacy", "hash-legacy", "acy1", 0, new Date().toISOString(), null);
        await page.goto(`${BASE}/#/projects/${projectId}/runs?section=deploys`);
        await pwExpect(card()).toBeVisible({ timeout: 20_000 });
        await card().getByLabel("Changed pages, one per line").fill("/checkout");
        await card().getByRole("button", { name: "Preview the tests" }).click();
        await pwExpect(card().getByTestId("selection-unknown")).toContainText(`Proposed because its recorded coverage is out of date: its latest run (${startedAt.slice(0, 10)}) failed, so earlier passing runs no longer show what it touches.`);
        const fullRun = card().getByTestId("selection-full-run");
        await pwExpect(fullRun).toContainText("1 test's recorded coverage is out of date");
        await pwExpect(fullRun).toContainText("The deploy trigger “Legacy” (…acy1) cannot be compared with your runner");
        await pwExpect(card().getByTestId("selection-triggers-same")).toContainText("“CI”");
        await pwExpect(card().getByTestId("selection-result")).toContainText("within the last 14 days");
        await axeBoth();
    }, 90_000);
});
