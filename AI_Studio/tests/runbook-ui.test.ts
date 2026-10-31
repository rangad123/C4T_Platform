/**
 * Runbooks in a real browser, on the Schedule tab: start from a template, write one in the form editor (forward-only routes),
 * run it and watch the steps and the ribbon, cancel a run, open a run from a link, and check accessibility and a phone-sized
 * screen. The platform, worker, fixture application and alert receiver are real and local.
 * Needs web/dist (build it first, inside the lock). Runs a browser:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/runbook-ui.test.ts
 * Ports: platform 5700, fixture 5701, receiver 5702.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { getRunbookServices, type RunbookServices } from "../src/platform/runbook-runner.js";
import { getScheduleServices } from "../src/platform/schedule-services.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const PLATFORM_PORT = 5700;
const FIXTURE_PORT = 5701;
const RECEIVER_PORT = 5702;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;

let browser: Browser;
let context: BrowserContext;
let page: Page;
let platform: Platform;
let rb: RunbookServices;
let worker: Worker;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let projectId: string;
const fixture = http.createServer((req, res) => {
    res.writeHead(req.url?.startsWith("/api/") ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
});
const received: any[] = [];
const receiver = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(200).end("ok");
    });
});
const post = async (url: string, body: unknown) => (await fetch(BASE + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<any>;

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    await Promise.all([new Promise<void>((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r)), new Promise<void>((r) => receiver.listen(RECEIVER_PORT, "127.0.0.1", r))]);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-runbookui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), CONCURRENCY: "2", PUBLIC_URL: BASE }));
    const svc = getScheduleServices(platform, { delivery: { backoffMs: [20], timeoutMs: 2_000 } });
    rb = getRunbookServices(platform, { pollMs: 100 });
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    worker = new Worker({ ...platform, onJobFinished: svc.onJobFinished }, 100);
    worker.start();

    projectId = (await post("/api/projects", { name: "Tracked shop" })).id;
    const spec = (title: string, p: string, tags: string[] = []) => ({ title, kind: "api", category: "API", tags, steps: [{ action: "request", method: "GET", path: p }, { action: "assertResponse", check: "status", expected: 200 }] });
    const imp = await post(`/api/projects/${projectId}/specs`, { baseUrl: `http://127.0.0.1:${FIXTURE_PORT}`, specs: [spec("Home answers", "/api/home", ["smoke"]), spec("Other answers", "/api/other")] });
    await waitForJob(imp.jobId);
    await post(`/api/projects/${projectId}/alert-channels`, { kind: "webhook", url: `http://127.0.0.1:${RECEIVER_PORT}/hook`, name: "Team chat" });
    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
    page = await context.newPage();
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await rb?.stop();
    await worker?.stop();
    await server?.close();
    fixture.close();
    receiver.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

async function waitForJob(jobId: string) {
    for (let i = 0; i < 300; i++) {
        const j = (await (await fetch(`${BASE}/api/test-generation/${jobId}`)).json()) as { status: string };
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) return;
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("job did not finish");
}

const panel = () => page.getByRole("region", { name: "Run sequences", exact: true });
const rows = () => panel().locator("[data-runbook]");
const open = async () => {
    await page.goto(`${BASE}/#/projects/${projectId}/schedule`);
    // Going to the address the page is already on changes nothing; reload so the lists are read afresh.
    await page.reload();
    await pwExpect(page.getByRole("heading", { name: "Run sequences", exact: true })).toBeVisible();
};

describe("Runbooks on the Schedule tab", () => {
    it("starts with a plain invitation and three templates", async () => {
        await open();
        await pwExpect(panel().getByText("No run sequences yet")).toBeVisible();
        await pwExpect(panel().getByText("Chain runs together, for example run the smoke tests, then everything, then tell the team.")).toBeVisible();
        for (const name of ["Smoke then full run", "Release gate", "Nightly with alert"]) await pwExpect(panel().getByRole("button", { name, exact: true })).toBeVisible();
        await pwExpect(panel().getByRole("button", { name: "Write your own" })).toBeVisible();
    });

    it("creates a runbook from a template, asking who to tell", async () => {
        await panel().getByRole("button", { name: "Nightly with alert", exact: true }).click();
        const form = panel().getByRole("form", { name: "Create “Nightly with alert”" });
        await form.getByLabel("Who to tell").selectOption({ label: "Team chat" });
        await form.getByRole("button", { name: "Create run sequence" }).click();
        await pwExpect(rows()).toHaveCount(1);
        const row = rows().first();
        await pwExpect(row).toContainText("Nightly with alert");
        await pwExpect(row).toContainText("Run all tests, then tell the team.");
        await pwExpect(row).toContainText("Not run yet");
    });

    it("Run now follows the real run step by step and leaves a ribbon with one tick per step", async () => {
        const row = rows().first();
        await row.getByRole("button", { name: /Run now: Nightly with alert/ }).click();
        const run = row.getByRole("region", { name: /Run of Nightly with alert/ });
        await pwExpect(run).toBeVisible();
        await pwExpect(run.getByText("Passed", { exact: true }).first()).toBeVisible({ timeout: 90_000 });
        await pwExpect(run.locator("[data-step-status='passed']")).toHaveCount(1);
        await pwExpect(run.locator("[data-step-status='skipped']")).toHaveCount(1);
        await pwExpect(run).toContainText("All 2 tests passed.");
        await pwExpect(run).toContainText("Finished early at");
        // The row's mini ribbon: a passed step and a step that was not needed.
        await pwExpect(row.getByRole("img", { name: /Last run, 2 steps: 1 passed, 1 skipped/ })).toBeVisible();
        await pwExpect(row.getByText("Passed", { exact: true }).first()).toBeVisible();
        expect(received).toHaveLength(0); // the message step was skipped, because everything passed
    });

    it("writes a runbook in the form: forward-only routes, reordering, a check and a message", async () => {
        await panel().getByRole("button", { name: "New run sequence" }).click();
        const form = panel().getByRole("form", { name: "New run sequence" });
        await form.getByLabel("Name", { exact: true }).fill("Quick check");

        // Step 1: run only the tests tagged smoke.
        const step1 = form.locator("fieldset[data-step]").nth(0);
        await step1.getByLabel("Which tests").selectOption("tag");
        await step1.getByLabel("Tag", { exact: true }).fill("smoke");

        // Step 2: a check; step 3: a message.
        await form.getByLabel("Add a step").selectOption("condition");
        await form.getByRole("button", { name: "Add step" }).click();
        await form.getByLabel("Add a step").selectOption("notify");
        await form.getByRole("button", { name: "Add step" }).click();
        const step2 = form.locator("fieldset[data-step]").nth(1);
        const step3 = form.locator("fieldset[data-step]").nth(2);
        await step2.getByLabel("Percent of tests that passed").fill("100");
        await step3.getByLabel("Send to").selectOption({ label: "Team chat" });
        await step3.getByLabel("Message").fill("{{project}}: quick check {{status}}, {{passRate}} passed. {{runUrl}}");

        // Routes only go forward: step 1 can skip ahead to 2 and 3, step 3 has nothing after it.
        const fail1 = step1.getByLabel("If it fails");
        await pwExpect(fail1.locator("option")).toHaveText(["Go to the next step", "Stop here", "Skip ahead to step 2: Check that at least 100% passed", "Skip ahead to step 3: Tell the team"]);
        await fail1.selectOption({ label: "Skip ahead to step 3: Tell the team" });
        await pwExpect(step3.getByText("This step always moves on.")).toBeVisible();

        // Moving the message step above the check makes step 1's route to it point at step 2 ... which is still ahead: kept.
        await step3.getByRole("button", { name: "Move step 3 up" }).click();
        await pwExpect(form.locator("fieldset[data-step]").nth(1).getByLabel("Send to")).toBeVisible();
        // Move it back; the first step's route still reaches it.
        await form.locator("fieldset[data-step]").nth(1).getByRole("button", { name: "Move step 2 down" }).click();
        await pwExpect(form.locator("fieldset[data-step]").nth(2).getByLabel("Send to")).toBeVisible();
        await pwExpect(form.locator("fieldset[data-step]").nth(0).getByLabel("If it fails")).toHaveValue(/step-3/);

        // A message placeholder that does not exist is refused with the reason, and nothing is saved.
        await form.locator("fieldset[data-step]").nth(2).getByLabel("Message").fill("Hello {{nobody}}");
        await form.getByRole("button", { name: "Save run sequence" }).click();
        await pwExpect(form.getByText(/is not a placeholder you can use/)).toBeVisible();
        await form.locator("fieldset[data-step]").nth(2).getByLabel("Message").fill("{{project}}: quick check {{status}}, {{passRate}} passed. {{runUrl}}");
        await form.getByRole("button", { name: "Save run sequence" }).click();
        await pwExpect(rows()).toHaveCount(2);
        await pwExpect(panel().getByText("Run sequence saved. Press Run now to try it.")).toBeVisible();
        const row = rows().filter({ hasText: "Quick check" });
        await pwExpect(row).toContainText("Run tests tagged “smoke”, then check that at least 100% passed, then tell the team.");
    });

    it("a run that goes all the way tells the team: the message really arrives with a link back to the run", async () => {
        const row = rows().filter({ hasText: "Quick check" });
        await row.getByRole("button", { name: /Run now: Quick check/ }).click();
        const run = row.getByRole("region", { name: /Run of Quick check/ });
        await pwExpect(run.locator("[data-step-status='passed']")).toHaveCount(3, { timeout: 90_000 });
        await pwExpect(run).toContainText("100% passed (1 of 1)");
        await pwExpect(run).toContainText("Sent to “Team chat”.");
        await pwExpect(row.getByRole("img", { name: /Last run, 3 steps: 3 passed/ })).toBeVisible();
        await expect.poll(() => received.length, { timeout: 10_000 }).toBe(1);
        expect(received[0]).toMatchObject({ event: "runbook", summary: expect.stringMatching(/^Tracked shop: quick check passed, 100% passed\. http:\/\/127\.0\.0\.1:5700\/#\/projects\/.+\/schedule\?run=/) });
    });

    it("keeps earlier runs and opens one from a link", async () => {
        const row = rows().filter({ hasText: "Quick check" });
        await row.getByRole("button", { name: /Earlier runs: Quick check/ }).click();
        await pwExpect(row.getByRole("list", { name: "Earlier runs" }).getByRole("listitem")).toHaveCount(1);
        const link = new URL(received[0].link);
        await page.goto(BASE + "/" + link.hash);
        await pwExpect(page.getByRole("region", { name: /Run of Quick check/ })).toBeVisible();
        await pwExpect(page.getByRole("region", { name: /Run of Quick check/ }).locator("[data-step-status='passed']")).toHaveCount(3);
    });

    it("a runbook can be started by a schedule or a deploy token from its own card", async () => {
        await open();
        const row = rows().filter({ hasText: "Quick check" });
        await post(`/api/projects/${projectId}/schedules`, { kind: "validate", cadence: { type: "daily", time: "03:00" } });
        await row.locator("summary", { hasText: "Start automatically" }).click();
        const box = row.getByRole("checkbox", { name: /^Schedule: / });
        await pwExpect(box).toBeVisible();
        // The box follows the server's answer, so click and wait for it rather than asking Playwright to verify at once.
        await box.click();
        await pwExpect(box).toBeChecked();
        await pwExpect(row).toContainText("Started by schedule");
        await pwExpect(page.locator("[data-schedule]")).toContainText("Runs the run sequence “Quick check”");
        // A runbook that something starts cannot be deleted from under it.
        await row.getByRole("button", { name: "Delete: Quick check" }).click();
        await row.getByRole("button", { name: "Yes, delete" }).click();
        await pwExpect(row.getByText(/is started by the schedule/)).toBeVisible();
        await box.click();
        await pwExpect(box).not.toBeChecked();
        await pwExpect(row).not.toContainText("Started by schedule");
    });

    it("cancelling a run that is waiting ends it at once", async () => {
        const made = await post(`/api/projects/${projectId}/runbooks`, { version: 1, name: "Patient", steps: [{ id: "w", type: "wait", seconds: 120 }, { id: "after", type: "wait", seconds: 1 }] });
        expect(made.id).toBeTruthy();
        await open();
        const row = rows().filter({ hasText: "Patient" });
        await row.getByRole("button", { name: /Run now: Patient/ }).click();
        const run = row.getByRole("region", { name: /Run of Patient/ });
        await pwExpect(run.getByText("Running", { exact: true }).first()).toBeVisible();
        await run.getByRole("button", { name: "Cancel the run" }).click();
        await pwExpect(run.getByText("Cancelled", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
        await pwExpect(run.locator("[data-step-status='stopped']")).toHaveCount(1);
        await pwExpect(run.locator("[data-step-status='skipped']")).toHaveCount(1);
        await pwExpect(run.getByRole("button", { name: "Cancel the run" })).toHaveCount(0);
    });

    it("has no serious accessibility problems, with the editor open too, in light and dark", async () => {
        await open();
        await panel().getByRole("button", { name: /Edit: Quick check/ }).click();
        await pwExpect(panel().getByRole("form", { name: "Edit run sequence" })).toBeVisible();
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.waitForTimeout(400); // colours ease over 140ms when the scheme flips; audit the settled state
            const result = await new AxeBuilder({ page }).include("#runbooks").analyze();
            expect(result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.help} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`), scheme).toEqual([]);
        }
        await page.emulateMedia({ colorScheme: "light" });
        await panel().getByRole("button", { name: "Cancel", exact: true }).click();
    });

    it("fits a phone-sized screen without sideways scrolling, editor open", async () => {
        await page.setViewportSize({ width: 390, height: 800 });
        await open();
        await panel().getByRole("button", { name: /Edit: Quick check/ }).click();
        await pwExpect(panel().getByRole("form", { name: "Edit run sequence" })).toBeVisible();
        const wide = await page.evaluate(() =>
            Array.from(document.querySelectorAll(".content *"))
                .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !el.closest(".tabs"))
                .slice(0, 5)
                .map((el) => `${el.tagName.toLowerCase()}.${el.className}`),
        );
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect({ overflow, wide }).toEqual({ overflow: 0, wide: [] });
    });
});
