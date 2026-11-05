/**
 * The Releases tab in a real browser against the real built UI (`web/dist`) and a real platform with seeded results (no model, no worker):
 * create manual cases (form and CSV import), open a release, see what blocks the approval, mark the checks (mouse and keyboard),
 * be refused by the server, approve, see the history, download the report, reopen. Escaping, axe in light and dark, phone width.
 * Set MANUAL_SHOTS=<folder> to also write screenshots there. Port 5711.
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
import { addTest, seedProject, seedRun, type Seed } from "./fixtures/dashboard-seed.js";

const PORT = 5711;
const BASE = `http://127.0.0.1:${PORT}`;
const XSS_TITLE = '<img src=x onerror="window.__pwned=1">';

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let page: Page;
let dir: string;
let shop: Seed;
let releaseId = "";
const consoleErrors: string[] = [];
const shot = async (name: string) => {
    if (process.env.MANUAL_SHOTS) await page.screenshot({ path: path.join(process.env.MANUAL_SHOTS, `${name}.png`), fullPage: true });
};

const api = async (method: string, url: string, payload?: unknown) => {
    const res = await server.inject({ method: method as never, url, payload: payload as never });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};
const releasesUrl = () => `${BASE}/#/projects/${shop.projectId}/runs?section=releases`;
const releaseUrl = () => `${BASE}/#/projects/${shop.projectId}/release/${releaseId}`;
const group = (title: string) => page.getByRole("group", { name: `Result for ${title}` });
const sentence = () => page.getByTestId("release-sentence");

/** A hash-only navigation keeps component state: go through a blank page so each test starts clean. */
const open = async (url: string, ready: () => Promise<void>) => {
    await page.goto("about:blank");
    await page.goto(url);
    await ready();
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-manual-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });

    shop = seedProject(platform, "Atlas shop", "https://atlas.example.test");
    for (const k of ["a", "b", "c", "d"]) addTest(platform, shop, k);
    await seedRun(platform, shop, { a: "pass", b: "pass", c: "pass", d: "pass" }, { daysAgo: 1 });

    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    // The refused approval is an expected 409 (the browser logs every failed request as a console error).
    page.on("console", (m) => m.type() === "error" && !/status of 409/.test(m.text()) && consoleErrors.push(m.text()));
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
}, 90_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("Releases tab", () => {
    it("explains what a release is when there is none, and the tab is in the project's tab bar", async () => {
        await open(releasesUrl(), async () => {
            await pwExpect(page.getByRole("heading", { name: "Releases", exact: true })).toBeVisible();
            await pwExpect(page.getByRole("heading", { name: "No releases yet" })).toBeVisible();
        });
        await pwExpect(page.getByText("A release is a checkpoint.")).toBeVisible();
        // Releases is a section of the Runs place (round 25; it was the first section of the Release place).
        const tabs = page.getByRole("navigation", { name: "Project sections" });
        await pwExpect(tabs.getByRole("link", { name: "Runs", exact: true })).toHaveAttribute("aria-current", "page");
        await pwExpect(page.getByRole("navigation", { name: "Runs sections" }).getByRole("link", { name: "Releases", exact: true })).toHaveAttribute("aria-current", "page");
        await shot("releases-empty");
    });

    it("adds test cases with the form and imports a CSV file, naming the row that could not be imported", async () => {
        await page.getByRole("link", { name: "Add test cases" }).click();
        await pwExpect(page.getByRole("heading", { name: "No test cases yet" })).toBeVisible();
        const row = (title: string) => page.getByRole("table").getByRole("row").filter({ hasText: title });

        const openForm = async () => {
            await page.getByRole("button", { name: "Add test case (manual)" }).first().click();
            await page.getByRole("menuitem", { name: /Write one by hand/ }).click();
            return page.getByRole("form", { name: "New test case" });
        };
        const add = async (ref: string, title: string, area: string, priority: string, action: string, expected: string) => {
            const form = await openForm();
            await form.getByLabel("Title", { exact: true }).fill(title);
            await form.getByText("More: area, source, linked test scripts").click();
            await form.getByLabel("Area", { exact: true }).fill(area);
            await form.getByLabel("Priority", { exact: true }).selectOption(priority);
            await form.getByLabel("Step 1, what to do").fill(action);
            await form.getByLabel("Step 1, what should happen").fill(expected);
            await form.getByRole("button", { name: "Add test case" }).click();
            await pwExpect(page.getByText(`Added ${ref} “${title}”.`)).toBeVisible();
        };
        await add("TC-001", "Pay by card", "Checkout", "critical", "Pay with a test card", "The order is confirmed");
        await add("TC-002", "Export the orders", "Reports", "high", "Export last month", "The file has a date column");
        await pwExpect(row("Pay by card")).toContainText("Critical priority");

        // an empty title is explained, not sent
        const form = await openForm();
        await form.getByRole("button", { name: "Add test case" }).click();
        await pwExpect(page.getByText("Give the test case a title")).toBeVisible();
        await page.getByRole("button", { name: "Close the form" }).click();

        const csv = 'title,area,priority,steps\nPrint the invoice,Billing,low,"Print => One page comes out"\n,Billing,low,\n';
        await page.locator('input[type="file"]').setInputFiles({ name: "cases.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
        await pwExpect(page.getByText("Imported 1 test case. 1 row could not be imported.")).toBeVisible();
        await pwExpect(page.getByRole("list", { name: "Rows that were not imported" })).toContainText("Row 3: The title is required");
        await pwExpect(row("Print the invoice")).toContainText("TC-003");

        // two more through the API: a medium check and one whose title is markup
        expect((await api("POST", `/api/projects/${shop.projectId}/manual-cases`, { title: "Dark mode", area: "Display", priority: "medium" })).status).toBe(201);
        expect((await api("POST", `/api/projects/${shop.projectId}/manual-cases`, { title: XSS_TITLE, area: "Display", priority: "low", steps: [{ action: XSS_TITLE, expected: "<script>window.__pwned=1</script>" }] })).status).toBe(201);
        await page.reload();
        await pwExpect(page.getByRole("heading", { name: "Test cases (5)" })).toBeVisible();
        // markup is shown as text and never runs
        await pwExpect(page.getByText(XSS_TITLE, { exact: true }).first()).toBeVisible();
        expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
        expect(await page.locator('img[src="x"]').count()).toBe(0);
        await shot("manual-cases");
    });

    it("edits and deletes a case", async () => {
        await page.getByRole("link", { name: "Dark mode", exact: true }).click();
        const form = page.getByRole("form", { name: "Edit test case" });
        await form.getByLabel("Title", { exact: true }).fill("Dark mode on the dashboard");
        await form.getByRole("button", { name: "Save changes" }).click();
        await pwExpect(page.getByText("Saved TC-004 “Dark mode on the dashboard”.")).toBeVisible();
        await page.getByRole("link", { name: "Open TC-004" }).click();
        await page.getByRole("button", { name: "Delete", exact: true }).click();
        await page.getByRole("button", { name: "Keep" }).click();
        await pwExpect(page.getByRole("table")).toContainText("Dark mode on the dashboard");
        await page.getByRole("button", { name: "Delete", exact: true }).click();
        await page.getByRole("button", { name: "Delete TC-004" }).click();
        await pwExpect(page.getByText("Deleted TC-004 “Dark mode on the dashboard”.")).toBeVisible();
        await pwExpect(page.getByText("Dark mode on the dashboard", { exact: true })).toHaveCount(0);
        expect((await api("POST", `/api/projects/${shop.projectId}/manual-cases`, { title: "Dark mode", area: "Display", priority: "medium" })).status).toBe(201);
    });

    it("exports the cases as CSV", async () => {
        await page.goto("about:blank");
        await page.goto(`${BASE}/#/projects/${shop.projectId}/manual-cases`);
        await pwExpect(page.getByRole("heading", { name: "Test cases", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Export", exact: true }).click();
        const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: /Export as CSV/ }).click()]);
        const text = fs.readFileSync((await download.path())!, "utf8");
        expect(text.split("\r\n")[0]).toBe("title,area,priority,steps");
        expect(text).toContain("Pay by card,Checkout,critical");
        expect(text).toContain("Print the invoice,Billing,low");
    });

    it("opens a release from the tab and sums it up in one sentence", async () => {
        await open(releasesUrl(), async () => pwExpect(page.getByRole("heading", { name: "No releases yet" })).toBeVisible());
        await pwExpect(page.getByRole("link", { name: /Test cases \(5\)/ })).toBeVisible();
        await page.getByRole("button", { name: "New release" }).first().click();
        await page.getByRole("form", { name: "New release" }).getByRole("button", { name: "Open release" }).click();
        await pwExpect(page.getByText("Give the release a name")).toBeVisible();
        await page.getByLabel("Release name").fill("2.4");
        await page.getByLabel("Notes (optional)").fill("The October release");
        await page.getByRole("button", { name: "Open release" }).click();
        await pwExpect(page.getByRole("heading", { name: "2.4", exact: true })).toBeVisible();
        releaseId = new URL(page.url()).hash.split("/").pop()!;
        await pwExpect(sentence()).toHaveText("Release 2.4: 5 of 5 manual checks left, automated tests ready");
        await pwExpect(page.getByText("The October release")).toBeVisible();
        // the automated ribbon: four passing tests
        await pwExpect(page.getByRole("img", { name: /4 automated tests: 4 passing/ })).toBeVisible();
        await pwExpect(page.getByRole("img", { name: /5 manual checks: 0 passed, 0 failed, 0 blocked, 0 skipped, 5 not run/ })).toBeVisible();
        // What a new release lists, in the page's words.
        await pwExpect(page.getByTestId("rel-includes")).toHaveText("This release lists the Manual test cases, and the Automated test cases that have no test script yet. An Automated case with a test script is covered by that script’s run, under Automated tests.");
        await shot("release-open");
    });

    it("says what blocks the approval and asks for an override with a real comment", async () => {
        await pwExpect(page.getByRole("list", { name: "Reasons this release cannot be approved" })).toContainText("2 critical or high-priority manual checks not finished (not run or blocked)");
        await page.getByRole("button", { name: "Approve", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Approve this release" });
        await pwExpect(dialog).toBeVisible();
        await pwExpect(dialog.getByRole("list", { name: "Why this release is blocked" })).toContainText("2 critical or high-priority manual checks");
        await dialog.getByLabel("Your name").fill("Dana Lee");
        await dialog.getByLabel("Why does the release go ahead anyway?").fill("too short");
        await dialog.getByRole("button", { name: "Approve anyway" }).click();
        await pwExpect(dialog.getByText("Explain in at least 10 characters")).toBeVisible();
        await shot("signoff-dialog");
        await page.keyboard.press("Escape");
        await pwExpect(dialog).toHaveCount(0);
        expect((await api("GET", `/api/projects/${shop.projectId}/releases/${releaseId}`)).body.audit).toEqual([]);
    });

    it("marks checks with the mouse and with the keyboard, keeps notes, and updates the sentence and the reasons", async () => {
        await pwExpect(page.getByLabel("Your name (recorded with each result)")).toBeVisible();
        await page.getByLabel("Your name (recorded with each result)").fill("Dana Lee");
        await group("Pay by card").getByRole("radio", { name: "Passed" }).check();
        await pwExpect(sentence()).toHaveText("Release 2.4: 4 of 5 manual checks left, automated tests ready");

        await group("Export the orders").getByRole("radio", { name: "Failed" }).check();
        await pwExpect(page.getByRole("list", { name: "Reasons this release cannot be approved" })).toContainText("1 manual check failed");
        // no issue tracker is connected, so no issue button
        await pwExpect(page.getByRole("button", { name: /Create issue/ })).toHaveCount(0);

        await page.getByRole("button", { name: "Add a note to Export the orders" }).click();
        await page.getByLabel("Note for “Export the orders”").fill("The date column is missing");
        await page.getByLabel("Note for “Export the orders”").blur();
        await pwExpect.poll(async () => (await api("GET", `/api/projects/${shop.projectId}/releases/${releaseId}`)).body.manual.items.find((i: { title: string }) => i.title === "Export the orders").note).toBe("The date column is missing");

        await group("Export the orders").getByRole("radio", { name: "Passed" }).check();
        await pwExpect(page.getByText("Nothing blocks this approval")).toBeVisible();
        await pwExpect(page.getByLabel("Note for “Export the orders”")).toHaveValue("The date column is missing");
        await pwExpect(page.getByText("Passed by Dana Lee")).toHaveCount(2);

        // the keyboard: focus a group, arrow to the next choice
        const notRun = group("Print the invoice").getByRole("radio", { name: "Not run" });
        await notRun.focus();
        await page.keyboard.press("ArrowRight");
        await pwExpect(group("Print the invoice").getByRole("radio", { name: "Passed" })).toBeChecked();
        await pwExpect(sentence()).toHaveText("Release 2.4: 2 of 5 manual checks left, automated tests ready");
        await pwExpect(page.getByRole("list", { name: "Warnings" })).toContainText("2 medium or low-priority manual checks not finished");
        // a failed check changes what is blocked; the server saved it
        const view = (await api("GET", `/api/projects/${shop.projectId}/releases/${releaseId}`)).body;
        expect(view.manual.rollup).toMatchObject({ passed: 3, notRun: 2, left: 2 });
        await shot("release-marked");
    });

    it("shows the server's reasons when the page was out of date, then approves once it is fixed", async () => {
        await page.getByRole("button", { name: "Approve", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Approve this release" });
        await dialog.getByLabel("Your name").fill("Dana Lee");
        // someone else marks a check as failed while the dialog is open
        expect((await api("PUT", `/api/projects/${shop.projectId}/releases/${releaseId}/results/${(await findCase("Print the invoice"))}`, { result: "failed", by: "Priya" })).status).toBe(200);
        await dialog.getByRole("button", { name: "Approve release" }).click();
        await pwExpect(dialog.getByText("This release cannot be approved yet: 1 manual check failed.")).toBeVisible();
        await pwExpect(dialog.getByRole("list", { name: "Why this release is blocked" })).toContainText("1 manual check failed");
        await pwExpect(dialog.getByRole("button", { name: "Approve anyway" })).toBeVisible();
        await dialog.getByRole("button", { name: "Cancel" }).click();

        await page.reload();
        await pwExpect(group("Print the invoice").getByRole("radio", { name: "Failed" })).toBeChecked();
        await group("Print the invoice").getByRole("radio", { name: "Passed" }).check();
        await pwExpect(page.getByText("Nothing blocks this approval")).toBeVisible();

        await page.getByRole("button", { name: "Approve", exact: true }).click();
        const again = page.getByRole("dialog", { name: "Approve this release" });
        await pwExpect(again.getByLabel("Your name")).toHaveValue("Dana Lee"); // remembered
        await again.getByLabel("Comment (optional)").fill("Looks good");
        await again.getByRole("button", { name: "Approve release" }).click();
        await pwExpect(page.getByRole("dialog")).toHaveCount(0);

        await pwExpect(page.getByText("Approved by Dana Lee").first()).toBeVisible();
        const history = page.getByRole("list", { name: "History of decisions" });
        await pwExpect(history).toContainText("Dana Lee approved this release");
        await pwExpect(history).toContainText("Looks good");
        await pwExpect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
        await pwExpect(page.getByRole("button", { name: "Reopen" })).toBeVisible();
        await pwExpect(group("Pay by card").getByRole("radio", { name: "Passed" })).toBeDisabled();
        await shot("release-approved");
    });

    it("downloads the sign-off report, with every typed text escaped", async () => {
        // a title with markup is on the sheet, as text
        await pwExpect(page.getByText(XSS_TITLE, { exact: true }).first()).toBeVisible();
        expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
        const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download report" }).click()]);
        expect(download.suggestedFilename()).toBe("sign-off-2-4.html");
        const html = fs.readFileSync((await download.path())!, "utf8");
        expect(html).toContain("Approved");
        expect(html).toContain("Dana Lee");
        expect(html).toContain("&lt;img src=x onerror=&quot;window.__pwned=1&quot;&gt;");
        expect(html).not.toContain("<img");
        // opened with scripts allowed, nothing runs
        const p = await (await browser.newContext()).newPage();
        await p.setContent(html);
        expect(await p.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
        expect(await p.locator("img").count()).toBe(0);
        await p.close();
    });

    it("reopens only with a name and a reason, and records it", async () => {
        await page.getByRole("button", { name: "Reopen" }).click();
        const dialog = page.getByRole("dialog", { name: "Reopen this release" });
        await dialog.getByRole("button", { name: "Reopen release" }).click();
        await pwExpect(dialog.getByText("Say why this release is being reopened.")).toBeVisible();
        await dialog.getByLabel("Why reopen it?").fill("A critical bug was reported");
        await dialog.getByRole("button", { name: "Reopen release" }).click();
        await pwExpect(page.getByRole("dialog")).toHaveCount(0);
        const history = page.getByRole("list", { name: "History of decisions" });
        await pwExpect(history.getByRole("listitem")).toHaveCount(2);
        await pwExpect(history).toContainText("Dana Lee reopened this release");
        await pwExpect(history).toContainText("A critical bug was reported");
        await pwExpect(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
        await pwExpect(group("Pay by card").getByRole("radio", { name: "Passed" })).toBeEnabled();
    });

    it("lists the release with its state", async () => {
        await open(releasesUrl(), async () => pwExpect(page.getByRole("list", { name: "Releases" })).toBeVisible());
        const row = page.getByRole("list", { name: "Releases" }).getByRole("listitem").first();
        await pwExpect(row).toContainText("2.4");
        await pwExpect(row).toContainText("Open");
        await pwExpect(row).toContainText("automated tests ready");
        // approve it through the API and see the badge change
        const r = await api("POST", `/api/projects/${shop.projectId}/releases/${releaseId}/signoff`, { decision: "approved", by: "Dana Lee", comment: "Second look done" });
        expect(r.status).toBe(200);
        await page.reload();
        await pwExpect(page.getByRole("list", { name: "Releases" }).getByRole("listitem").first()).toContainText("Approved");
        await pwExpect(page.getByRole("list", { name: "Releases" }).getByRole("listitem").first()).toContainText("Approved by Dana Lee");
        await shot("releases-list");
    });

    it("links to Releases from the dashboard row once there are two projects", async () => {
        seedProject(platform, "Second project", "https://second.example.test");
        // Round 37: the fleet rows are on the Dashboard; the Projects page is the plain list.
        await open(`${BASE}/#/dashboard`, async () => pwExpect(page.getByRole("list", { name: "Projects" })).toBeVisible());
        const row = page.getByRole("list", { name: "Projects" }).getByRole("listitem").filter({ hasText: "Atlas shop" });
        await row.getByRole("link", { name: "Releases" }).click();
        await pwExpect(page.getByRole("heading", { name: "Releases", exact: true })).toBeVisible();
        await pwExpect(page).toHaveURL(new RegExp(`/#/projects/${shop.projectId}/runs\\?section=releases$`));
    });

    it("has no accessibility violations in light and dark, on the list, the release, the dialog and the cases", async () => {
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.waitForTimeout(400); // colours ease over 140ms when the scheme flips; audit the settled state
            const check = async (what: string) => {
                await page.waitForTimeout(700); // let the ribbons finish drawing in
                const result = await new AxeBuilder({ page }).analyze();
                expect(result.violations.map((v) => `${what}: ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
            };
            await open(releasesUrl(), async () => pwExpect(page.getByRole("list", { name: "Releases" })).toBeVisible());
            await check("list");
            await open(releaseUrl(), async () => pwExpect(sentence()).toBeVisible());
            await pwExpect(page.getByRole("list", { name: "History of decisions" })).toBeVisible();
            await shot(`release-${scheme}`);
            await check("release");
            await page.getByRole("button", { name: "Reopen" }).click();
            await pwExpect(page.getByRole("dialog", { name: "Reopen this release" })).toBeVisible();
            await check("dialog");
            await page.keyboard.press("Escape");
            await open(`${BASE}/#/projects/${shop.projectId}/manual-cases`, async () => pwExpect(page.getByRole("heading", { name: "Test cases", exact: true })).toBeVisible());
            await pwExpect(page.getByRole("table").getByRole("row").filter({ hasText: "Pay by card" })).toBeVisible();
            await check("cases");
            await page.getByRole("link", { name: "Pay by card", exact: true }).click();
            await pwExpect(page.getByRole("form", { name: "Edit test case" })).toBeVisible();
            await shot(`manual-cases-form-${scheme}`);
            await check("case form");
        }
        await page.emulateMedia({ colorScheme: null });
    });

    it("fits a phone without sideways scrolling", async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        for (const [name, url, ready] of [
            ["list", releasesUrl(), async () => pwExpect(page.getByRole("list", { name: "Releases" })).toBeVisible()],
            ["release", releaseUrl(), async () => pwExpect(sentence()).toBeVisible()],
            ["cases", `${BASE}/#/projects/${shop.projectId}/manual-cases`, async () => pwExpect(page.getByRole("table").getByRole("row").filter({ hasText: "Pay by card" })).toBeVisible()],
        ] as const) {
            await open(url, ready);
            await page.waitForTimeout(700);
            const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            expect(over, name).toBeLessThanOrEqual(0);
            await shot(`phone-${name}`);
        }
        await page.setViewportSize({ width: 1280, height: 900 });
    });

    it("kept the browser console clean", () => {
        expect(consoleErrors).toEqual([]);
    });
});

async function findCase(title: string): Promise<string> {
    const list = (await api("GET", `/api/projects/${shop.projectId}/manual-cases`)).body.cases as Array<{ id: string; title: string }>;
    return list.find((c) => c.title === title)!.id;
}
