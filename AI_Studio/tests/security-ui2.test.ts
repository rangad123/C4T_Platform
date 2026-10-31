/**
 * Security Assessment screens of round 20 (UI2), in a real browser against the FAKE security API (tests/fixtures/security-fake-api.ts,
 * the real routes' answer shapes: CORE's activity, OPS's notifications, SIGN's application fields, the functional hard sign-ins).
 * The real platform behind the same screens: tests/security-ui2-real.test.ts.
 *
 *   activity: newest first, who, when, what, links; filters (application on the server, what and who on the page) in the address; older events
 *   notifications: the three switches and their defaults, every channel or chosen ones, no channel yet, recent messages, a viewer cannot change
 *   applications: the saved sign-in to load (with a missing or expired one said plainly), sensitive workflows with their checks, the body sent,
 *                 the detail page, a change making the authorization out of date; the API document upload, replace and remove
 *   reports: the Excel download
 *   the bar: keyboard, 375 px without sideways scroll, 44 px targets, axe in light and dark
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/security-ui2.test.ts
 * Port: 7190 (UI2's range 7190-7209).
 */
import fs from "node:fs";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.js";
import { startSecurityFake, type SecurityFake } from "./fixtures/security-fake-api.js";

const PORT = 7190;
let fake: SecurityFake;
let browser: Browser;
let page: Page;
const consoleErrors: string[] = [];

async function visit(hash: string) {
    await page.goto("about:blank");
    await page.goto(`${fake.base}/${hash}`);
}
async function settle(scheme: "light" | "dark" | null) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(400);
}
async function axeBoth(open: () => Promise<void>) {
    for (const scheme of ["light", "dark"] as const) {
        await settle(scheme);
        await open();
        await page.waitForTimeout(400);
        const r = await new AxeBuilder({ page }).exclude('[data-testid="sec-report-frame"]').analyze();
        expect(r.violations.map((v) => `${scheme} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), page.url()).toEqual([]);
    }
    await settle(null);
}
async function noOverflow() {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const wide = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".content *, dialog[open] *"))
            .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !el.closest(".tabs, .subtabs, pre, code"))
            .filter((el) => !Array.from(el.children).some((c) => c.getBoundingClientRect().right > document.documentElement.clientWidth + 1))
            .slice(0, 5)
            .map((el) => `${el.tagName.toLowerCase()}.${el.className} "${(el.textContent ?? "").trim().slice(0, 40)}"`),
    );
    expect({ overflow, wide }, page.url()).toEqual({ overflow: 0, wide: [] });
}
async function tall(loc: ReturnType<Page["locator"]>, what: string) {
    const box = await loc.boundingBox();
    expect(box?.height ?? 0, `${what} is at least 44 px tall`).toBeGreaterThanOrEqual(43.5);
}

// SIGN's judged saved sign-ins (src/security/signin.ts statusOf words).
const READY_MAIN = { account: "main", state: "ready", message: "The assessment loads the saved sign-in for the project's own account." };
const MISSING_MAIN = { account: "main", state: "missing", message: "No sign-in is saved for the project's own account. Save one in Settings (Test accounts, Saved sign-ins) or upload one here; until then the assessment visits signed out." };
const MISSING_ADMIN = { account: "admin", state: "missing", message: "No sign-in is saved for the test account “admin”. Save one in Settings (Test accounts, Saved sign-ins) or upload one here; until then the assessment visits signed out." };

/** A security project with one authorized application, a finished assessment and a few events in its trail. */
function seeded() {
    const p = fake.addProject("Acme", "security");
    const app = fake.addApp(p.id, { name: "Customer portal" });
    const other = fake.addApp(p.id, { name: "Admin site", targetUrl: "https://admin.example.com/" });
    fake.authorize(app.id);
    const done = fake.addAssessment(app.id);
    const f = fake.addFinding(app.id, { title: "Content Security Policy is missing" });
    fake.addEvent(p.id, { applicationId: app.id, action: "application.created", objectType: "application", objectId: app.id, summary: "Added the application “Customer portal” (https://staging.example.com/).", actor: { kind: "user", id: "u1", name: "Dana Owner" } });
    fake.addEvent(p.id, { applicationId: app.id, action: "authorization.recorded", objectType: "authorization", objectId: "auth9", summary: "Recorded the authorization of “Customer portal”, approved by Dana Client.", actor: { kind: "user", id: "u1", name: "Dana Owner" } });
    fake.addEvent(p.id, { applicationId: app.id, action: "assessment.started", objectType: "assessment", objectId: done.id, summary: "Started a passive assessment of “Customer portal”.", actor: { kind: "user", id: "u2", name: "Eli Editor" } });
    fake.addEvent(p.id, { applicationId: app.id, action: "finding.validation-changed", objectType: "finding", objectId: f.id, summary: "Changed “Content Security Policy is missing” from needs-review to confirmed.", actor: { kind: "user", id: "u2", name: "Eli Editor" } });
    fake.addEvent(p.id, { applicationId: other.id, action: "application.deleted", objectType: "application", objectId: "gone1", summary: "Deleted the application “Old site”.", actor: { kind: "user", id: "u1", name: "Dana Owner" } });
    fake.addEvent(p.id, { applicationId: null, action: "report.exported", objectType: "report", objectId: p.id, summary: "Exported the project's security report as XLSX (1 finding).", actor: { kind: "user", id: "u2", name: "Eli Editor" } });
    return { p, app, other, done, f };
}

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    fake = await startSecurityFake(PORT);
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    page = await context.newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text()) && !/^Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await fake?.stop();
});

beforeEach(() => {
    fake.enabled = true;
    fake.role = "owner";
    fake.requests.length = 0;
});

// ── activity ──────────────────────────────────────────────────────────────────

describe("the security activity page", () => {
    it("lists who did what and when, newest first, with links to what still exists; filters live in the address", async () => {
        const { p, app, done, f } = seeded();
        await visit(`#/projects/${p.id}/security`);
        await page.getByRole("navigation", { name: "Security assessment sections" }).getByRole("link", { name: "Activity", exact: true }).click();
        await pwExpect(page).toHaveURL(new RegExp(`#/projects/${p.id}/security/activity$`));
        const list = page.getByTestId("sec-activity");
        await pwExpect(list.locator("li")).toHaveCount(6);
        await pwExpect(list.locator("li").first()).toContainText("Exported the project's security report as XLSX (1 finding).");
        await pwExpect(list.locator("li").first()).toContainText("Eli Editor");
        await pwExpect(list.locator("li").first()).toContainText("Reports");
        await pwExpect(list.locator("li").last()).toContainText("Added the application “Customer portal”");
        expect(fake.requests.some((r) => r.path === `/v1/security/projects/${p.id}/activity?limit=100`)).toBe(true);
        await pwExpect(list.getByRole("link", { name: "Open the assessment" })).toHaveAttribute("href", `#/projects/${p.id}/security/assessments/${done.id}`);
        await pwExpect(list.getByRole("link", { name: "Open the finding" })).toHaveAttribute("href", `#/projects/${p.id}/security/findings/${f.id}`);
        // A deleted application has nothing to open.
        await pwExpect(list.locator("li").filter({ hasText: "Deleted the application" }).getByRole("link")).toHaveCount(0);

        await page.getByLabel("What", { exact: true }).selectOption("assessment");
        await pwExpect(page).toHaveURL(/kind=assessment/);
        await pwExpect(list.locator("li")).toHaveCount(1);
        await pwExpect(page.getByRole("status").filter({ hasText: "loaded" })).toHaveText("1 of 6 loaded events");
        await page.getByLabel("What", { exact: true }).selectOption("");
        await page.getByLabel("Who", { exact: true }).selectOption("Dana Owner");
        await pwExpect(page).toHaveURL(/person=Dana(\+|%20)Owner/);
        await pwExpect(list.locator("li")).toHaveCount(3);
        // The application filter is the server's.
        await page.getByLabel("Application", { exact: true }).selectOption(app.id);
        await pwExpect(list.locator("li")).toHaveCount(2);
        expect(fake.requests.some((r) => r.path === `/v1/security/projects/${p.id}/activity?limit=100&applicationId=${app.id}`)).toBe(true);
        await page.getByRole("button", { name: "Clear filters", exact: true }).click();
        await pwExpect(list.locator("li")).toHaveCount(6);
    });

    it("older events load on request; a project without events says what will appear", async () => {
        const p = fake.addProject("Busy", "security");
        for (let i = 1; i <= 130; i++) fake.addEvent(p.id, { summary: `Event number ${i}.` });
        await visit(`#/projects/${p.id}/security/activity`);
        const list = page.getByTestId("sec-activity");
        await pwExpect(list.locator("li")).toHaveCount(100);
        await pwExpect(list.locator("li").first()).toContainText("Event number 130.");
        await page.getByRole("button", { name: "Show older events", exact: true }).click();
        await pwExpect(list.locator("li")).toHaveCount(130);
        await pwExpect(list.locator("li").last()).toContainText("Event number 1.");
        expect(fake.requests.some((r) => /\/activity\?limit=100&before=\d+$/.test(r.path))).toBe(true);
        await pwExpect(page.getByRole("button", { name: "Show older events", exact: true })).toHaveCount(0);
        const quiet = fake.addProject("Quiet", "security");
        await visit(`#/projects/${quiet.id}/security/activity`);
        await pwExpect(page.getByText("No activity yet", { exact: true })).toBeVisible();
    });
});

// ── notifications ─────────────────────────────────────────────────────────────

describe("notification settings", () => {
    it("no alert channel yet: says messages go nowhere and where to add one", async () => {
        const p = fake.addProject("Lonely", "security");
        await visit(`#/projects/${p.id}/security/notifications`);
        await pwExpect(page.getByText("No alert channels yet", { exact: true })).toBeVisible();
        // Alerts are a section of the project's Settings (round 25; the place was called Settings, as the link's words still say).
        await pwExpect(page.getByRole("link", { name: "Open Settings, Alerts", exact: true })).toHaveAttribute("href", `#/projects/${p.id}/settings?section=alerts`);
        await pwExpect(page.getByRole("checkbox", { name: /New critical or high findings/ })).toBeChecked();
        await pwExpect(page.getByRole("checkbox", { name: /An assessment fails/ })).toBeChecked();
        await pwExpect(page.getByRole("checkbox", { name: /Every assessment that ends/ })).not.toBeChecked();
        await pwExpect(page.getByText("No messages sent yet", { exact: true })).toBeVisible();
    });

    it("change when and where, save: the request carries exactly the setting; the recent messages are listed", async () => {
        const p = fake.addProject("Noisy", "security");
        fake.channels.set(p.id, [
            { id: "c1", name: "Security team", kind: "email", enabled: true },
            { id: "c2", name: "#alerts", kind: "slack", enabled: true },
            { id: "c3", name: "Old hook", kind: "webhook", enabled: false },
        ]);
        fake.recent.set(p.id, [
            { at: new Date().toISOString(), channelName: "#alerts", channelKind: "slack", status: "failed", reasons: ["new-critical-high"], error: "The channel answered 500.", summary: "New critical or high findings: Customer portal" },
            { at: new Date().toISOString(), channelName: "Security team", channelKind: "email", status: "sent", reasons: ["failed"], error: null, summary: "Security assessment failed: Customer portal" },
        ]);
        await visit(`#/projects/${p.id}/security/notifications`);
        const save = page.getByRole("button", { name: "Save notification settings", exact: true });
        await pwExpect(save).toBeDisabled();
        await page.getByRole("checkbox", { name: /Every assessment that ends/ }).check();
        await page.getByRole("radio", { name: /Only the channels chosen here/ }).check();
        const chosen = page.getByRole("list", { name: "Alert channels" });
        await pwExpect(chosen.getByRole("checkbox", { name: /Old hook/ })).toBeDisabled();
        await chosen.getByRole("checkbox", { name: /#alerts/ }).uncheck();
        await save.click();
        await pwExpect(page.getByRole("status").filter({ hasText: "Saved" })).toHaveText("Saved. The next assessment that ends uses these settings.");
        expect(fake.called("PUT", /\/notifications$/).map((r) => r.body)).toEqual([{ newCriticalHigh: true, failed: true, everyFinish: true, channelIds: ["c1"] }]);
        await pwExpect(save).toBeDisabled();
        // Unticking the last chosen channel says no one would hear.
        await chosen.getByRole("checkbox", { name: /Security team/ }).uncheck();
        await pwExpect(page.getByText("No channel would receive these messages", { exact: true })).toBeVisible();
        const recent = page.getByTestId("sn-recent");
        await pwExpect(recent.locator("li").first()).toContainText("The channel answered 500.");
        await pwExpect(recent.locator("li").first()).toContainText("Not delivered");
        await pwExpect(recent.locator("li").nth(1)).toContainText("Sent");
        await pwExpect(recent.locator("li").nth(1)).toContainText("Because: it failed");
    });

    it("a viewer sees the setting but cannot change it", async () => {
        const p = fake.addProject("Watched", "security");
        fake.channels.set(p.id, [{ id: "c1", name: "Security team", kind: "email", enabled: true }]);
        fake.role = "viewer";
        await visit(`#/projects/${p.id}/security/notifications`);
        await pwExpect(page.getByRole("checkbox", { name: /New critical or high findings/ })).toBeDisabled();
        await pwExpect(page.getByRole("button", { name: "Save notification settings", exact: true })).toBeDisabled();
        await pwExpect(page.getByText("Editors and owners can change these settings.", { exact: true })).toBeVisible();
        expect(fake.requests.filter((r) => r.method !== "GET")).toEqual([]);
    });
});

// ── applications: saved sign-in and sensitive workflows ─────────────────────

describe("the application form: saved sign-in and sensitive workflows", () => {
    it("register with a saved sign-in and two sensitive workflows: checks, the body sent, the detail page", async () => {
        const p = fake.addProject("Initrode", "security");
        fake.signIns.set(p.id, [READY_MAIN, MISSING_ADMIN]);
        await visit(`#/projects/${p.id}/security/applications/new`);
        const form = page.getByTestId("sec-app-form");
        await form.getByLabel("Name", { exact: true }).fill("Portal");
        await form.getByLabel("Target address", { exact: true }).fill("https://portal.initrode.test");
        const signIn = form.getByLabel("Signed-in assessment (optional)", { exact: true });
        await pwExpect(signIn.locator("option")).toHaveText(["No sign-in: visit as an anonymous visitor", "The project’s own sign-in, saved sign-in ready", "Test account “admin”, no saved sign-in yet"]);
        await signIn.selectOption("admin");
        await pwExpect(page.getByTestId("sa-signin-warning")).toContainText(MISSING_ADMIN.message);
        await pwExpect(page.getByTestId("sa-signin-warning").getByRole("link", { name: "Open Test accounts" })).toHaveAttribute("href", `#/projects/${p.id}/settings?section=accounts`);
        await signIn.selectOption("main");
        await pwExpect(page.getByTestId("sa-signin-warning")).toHaveCount(0);
        await pwExpect(page.getByTestId("sa-signin-state")).toHaveText(READY_MAIN.message);

        await form.locator("summary", { hasText: "Advanced" }).click();
        const wf = page.getByTestId("sa-workflows");
        await wf.getByRole("button", { name: "Add a sensitive workflow", exact: true }).click();
        await wf.getByRole("button", { name: "Add a sensitive workflow", exact: true }).click();
        await wf.getByLabel("Paths never requested").first().fill("checkout/pay");
        await wf.getByLabel("Workflow name").nth(1).fill("Delete account");
        await form.getByRole("button", { name: "Register application", exact: true }).click();
        await pwExpect(wf.getByText("Give the workflow a name, for example “Payments”.", { exact: true })).toBeVisible();
        await pwExpect(wf.getByText("Add at least one path, for example /checkout/pay.", { exact: true })).toBeVisible();
        expect(fake.called("POST", /\/applications$/)).toHaveLength(0);
        await wf.getByLabel("Workflow name").first().fill("Payments");
        await pwExpect(form.getByRole("button", { name: "Register application", exact: true })).toBeEnabled();
        await form.getByRole("button", { name: "Register application", exact: true }).click();
        await pwExpect(wf.getByText("Each path starts with “/”: “checkout/pay” does not.", { exact: true })).toBeVisible();
        await wf.getByLabel("Paths never requested").first().fill("/checkout/pay\n/billing/card");
        await wf.getByLabel("Workflow note (optional)").first().fill("Real card payments");
        await wf.getByLabel("Paths never requested").nth(1).fill("/account/delete");
        // A third, empty row is ignored; one removed is gone.
        await wf.getByRole("button", { name: "Add a sensitive workflow", exact: true }).click();
        await wf.getByRole("button", { name: "Remove workflow", exact: true }).nth(2).click();
        await form.getByRole("button", { name: "Register application", exact: true }).click();
        await pwExpect(page.getByTestId("sec-auth-form")).toBeVisible();
        expect(fake.called("POST", /\/applications$/)[0]!.body).toEqual({
            name: "Portal",
            targetUrl: "https://portal.initrode.test/",
            environment: "staging",
            scope: [],
            excludedPaths: [],
            maxRequestsPerSecond: 2,
            apiSpecUrl: null,
            notes: null,
            signInAccount: "main",
            sensitiveWorkflows: [
                { name: "Payments", pathPrefixes: ["/checkout/pay", "/billing/card"], note: "Real card payments" },
                { name: "Delete account", pathPrefixes: ["/account/delete"], note: null },
            ],
        });
        await pwExpect(page.getByTestId("sa-signin")).toHaveText("The project’s own sign-in: its saved sign-in is loaded, no password is typed");
        await pwExpect(page.getByTestId("sa-sensitive")).toContainText("Payments: /checkout/pay, /billing/card. Real card payments");
        await pwExpect(page.getByTestId("sa-sensitive")).toContainText("Delete account: /account/delete");
    });

    it("changing the saved sign-in of an authorized application sends only that and makes the authorization out of date", async () => {
        const p = fake.addProject("Vandelay", "security");
        fake.signIns.set(p.id, [{ account: "main", state: "expired", message: "The saved sign-in for the project's own account has expired. Sign in again in Settings." }]);
        const app = fake.addApp(p.id, { sensitiveWorkflows: [{ name: "Payments", pathPrefixes: ["/pay"], note: null }] });
        fake.authorize(app.id);
        await visit(`#/projects/${p.id}/security/applications/${app.id}`);
        await pwExpect(page.locator(".page-head")).toContainText("Authorized");
        await pwExpect(page.getByTestId("sa-signin")).toHaveText("Nobody: it visits as an anonymous visitor");
        await page.getByRole("button", { name: "Change", exact: true }).click();
        const form = page.getByTestId("sec-app-form");
        // Existing workflows open the advanced part and are listed.
        await pwExpect(form.getByLabel("Workflow name")).toHaveValue("Payments");
        await form.getByLabel("Signed-in assessment (optional)", { exact: true }).selectOption("main");
        await pwExpect(page.getByTestId("sa-signin-warning")).toContainText("The saved sign-in for the project's own account has expired.");
        await form.getByRole("button", { name: "Save changes", exact: true }).click();
        await pwExpect(page.locator(".page-head")).toContainText("Authorization out of date");
        const body = fake.called("PATCH", /\/applications\//)[0]!.body;
        expect(body.signInAccount).toBe("main");
        expect("sensitiveWorkflows" in body).toBe(false);
    });
});

describe("the application page: saved sign-in and API document", () => {
    it("upload a saved sign-in from a file: the state comes back in words, the cookie value is never shown", async () => {
        const p = fake.addProject("Hooli", "security");
        fake.signIns.set(p.id, [MISSING_MAIN]);
        const app = fake.addApp(p.id, { signInAccount: "main" });
        await visit(`#/projects/${p.id}/security/applications/${app.id}`);
        const panel = page.getByTestId("sa-signin-panel");
        await pwExpect(panel.getByTestId("sa-signin-status")).toHaveText(MISSING_MAIN.message);
        await panel.locator("summary", { hasText: "Upload a saved sign-in from a file" }).click();
        await panel.getByRole("button", { name: "Save the sign-in", exact: true }).click();
        await pwExpect(panel.getByText("Choose the saved sign-in file first.", { exact: true })).toBeVisible();
        const state = JSON.stringify({ cookies: [{ name: "sid", value: "COOKIE-VALUE-SENTINEL-77", domain: "staging.example.com", path: "/" }], origins: [] });
        await page.setInputFiles("#sa-signin-file", { name: "signed-in.json", mimeType: "application/json", buffer: Buffer.from(state) });
        await panel.getByLabel("Signed-in page (optional)", { exact: true }).fill("/account");
        await panel.getByRole("button", { name: "Save the sign-in", exact: true }).click();
        await pwExpect(panel.getByRole("status")).toContainText("The assessment loads the saved sign-in for the project's own account. It has not been checked yet");
        await pwExpect(panel.getByTestId("sa-signin-status")).toContainText("It has not been checked yet");
        expect(fake.called("PUT", /\/saved-sign-in$/).map((r) => r.body)).toEqual([{ account: "main", storageState: state, checkUrl: "/account" }]);
        expect(await page.locator("body").innerText()).not.toContain("COOKIE-VALUE-SENTINEL-77");
    });

    it("upload, read, replace and remove the API document; what each operation would get is listed", async () => {
        const p = fake.addProject("Pied Piper", "security");
        const app = fake.addApp(p.id);
        await visit(`#/projects/${p.id}/security/applications/${app.id}`);
        const panel = page.getByTestId("sa-apidoc");
        await pwExpect(panel).toContainText("None uploaded.");
        const upload = panel.getByRole("button", { name: "Upload API document", exact: true });
        await pwExpect(upload).toBeDisabled();
        await page.setInputFiles("#sa-apidoc-file", { name: "broken.json", mimeType: "application/json", buffer: Buffer.from("{ not json") });
        await upload.click();
        await pwExpect(panel.getByText("The API document is not valid JSON.", { exact: true })).toBeVisible();
        const doc = { openapi: "3.0.0", info: { title: "Shop API", version: "2.1" }, paths: { "/health": { get: {} }, "/users/{id}": { get: {} }, "/orders": { post: {}, get: {} } } };
        await page.setInputFiles("#sa-apidoc-file", { name: "openapi.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)) });
        await upload.click();
        const summary = panel.getByTestId("sa-apidoc-summary");
        await pwExpect(summary).toContainText("openapi.json");
        await pwExpect(summary).toContainText("Shop API, version 2.1");
        await pwExpect(summary).toContainText("4 listed; 2 are GETs without required parameters and may be requested read-only. The rest are never called.");
        expect(fake.called("PUT", /\/api-document$/).at(-1)!.body).toEqual({ fileName: "openapi.json", content: JSON.stringify(doc) });
        await panel.locator("summary", { hasText: "What an assessment would do with each operation (4)" }).click();
        const ops = panel.getByTestId("sa-apidoc-ops");
        await pwExpect(ops.locator("li").filter({ hasText: "GET /health" })).toContainText("Requested read-only.");
        await pwExpect(ops.locator("li").filter({ hasText: "POST /orders" })).toContainText("It is a POST operation, which could change data, so it is never called.");
        await pwExpect(ops.locator("li").filter({ hasText: "GET /users/{id}" })).toContainText("none are ever made up");
        await pwExpect(panel.getByRole("button", { name: "Replace API document", exact: true })).toBeVisible();
        await panel.getByRole("button", { name: "Remove API document", exact: true }).click();
        const dlg = page.getByRole("dialog", { name: "Remove the API document?" });
        await pwExpect(dlg.getByRole("button", { name: "Keep it", exact: true })).toBeFocused();
        await dlg.getByRole("button", { name: "Remove", exact: true }).click();
        await pwExpect(panel).toContainText("None uploaded.");
        expect(fake.called("DELETE", /\/api-document$/)).toHaveLength(1);
    });

    it("a viewer reads the sign-in state and the document but is offered no upload", async () => {
        const p = fake.addProject("Read only", "security");
        fake.signIns.set(p.id, [READY_MAIN]);
        const app = fake.addApp(p.id, { signInAccount: "main" });
        fake.role = "viewer";
        await visit(`#/projects/${p.id}/security/applications/${app.id}`);
        await pwExpect(page.getByTestId("sa-signin-status")).toHaveText(READY_MAIN.message);
        await pwExpect(page.getByTestId("sa-apidoc")).toContainText("None uploaded.");
        expect(await page.getByText("Upload a saved sign-in from a file").count()).toBe(0);
        expect(await page.getByRole("button", { name: "Upload API document" }).count()).toBe(0);
    });
});

// ── reports ───────────────────────────────────────────────────────────────────

describe("reports", () => {
    it("the findings and summary as an Excel workbook", async () => {
        const { p, done } = seeded();
        await visit(`#/projects/${p.id}/security/reports?assessment=${done.id}`);
        const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download as Excel", exact: true }).click()]);
        expect(download.suggestedFilename()).toBe("security-report.xlsx");
        expect(fake.requests.some((r) => r.path === `/v1/security/assessments/${done.id}/report?format=xlsx`)).toBe(true);
    });
});

// ── the bar ───────────────────────────────────────────────────────────────────

describe("the bar: keyboard, phone width, targets, contrast", () => {
    it("keyboard only: tick a notification switch and save", async () => {
        const p = fake.addProject("Keys", "security");
        fake.channels.set(p.id, [{ id: "c1", name: "Security team", kind: "email", enabled: true }]);
        await visit(`#/projects/${p.id}/security/notifications`);
        await page.getByRole("checkbox", { name: /Every assessment that ends/ }).focus();
        await page.keyboard.press("Space");
        let reached = false;
        for (let i = 0; i < 12 && !reached; i++) {
            await page.keyboard.press("Tab");
            reached = (await page.evaluate(() => document.activeElement?.textContent?.trim())) === "Save notification settings";
        }
        expect(reached).toBe(true);
        await page.keyboard.press("Enter");
        await pwExpect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
        expect(fake.called("PUT", /\/notifications$/).at(-1)!.body.everyFinish).toBe(true);
    });

    it("at 375 px nothing scrolls sideways and the new choices are at least 44 px tall", async () => {
        const { p, app } = seeded();
        fake.channels.set(p.id, [{ id: "c1", name: "Security team with a rather long channel name", kind: "email", enabled: true }]);
        fake.signIns.set(p.id, [MISSING_MAIN, MISSING_ADMIN]);
        await page.setViewportSize({ width: 375, height: 800 });
        try {
            for (const hash of [`#/projects/${p.id}/security/activity`, `#/projects/${p.id}/security/notifications`, `#/projects/${p.id}/security/applications/${app.id}`, `#/projects/${p.id}/security/reports`]) {
                await visit(hash);
                await pwExpect(page.locator(".page-head")).toBeVisible();
                await page.waitForTimeout(300);
                await noOverflow();
            }
            await visit(`#/projects/${p.id}/security/notifications`);
            await tall(page.locator("label.check").filter({ hasText: "Every assessment that ends" }), "a notification switch");
            await page.getByRole("radio", { name: /Only the channels chosen here/ }).check();
            await tall(page.getByRole("list", { name: "Alert channels" }).locator("label.check").first(), "a channel choice");
            await noOverflow();
            await visit(`#/projects/${p.id}/security/applications/new`);
            await page.getByLabel("Signed-in assessment (optional)", { exact: true }).selectOption("admin");
            await page.locator("summary", { hasText: "Advanced" }).click();
            await page.getByRole("button", { name: "Add a sensitive workflow", exact: true }).click();
            await tall(page.getByRole("button", { name: "Remove workflow", exact: true }), "Remove workflow");
            await tall(page.getByRole("button", { name: "Add a sensitive workflow", exact: true }), "Add a sensitive workflow");
            await noOverflow();
        } finally {
            await page.setViewportSize({ width: 1280, height: 900 });
        }
    });

    it("axe finds nothing in light or dark: activity, notifications, the application form with a sign-in and a workflow, the application page", async () => {
        const { p, app } = seeded();
        fake.channels.set(p.id, [{ id: "c1", name: "Security team", kind: "email", enabled: true }]);
        fake.recent.set(p.id, [{ at: new Date().toISOString(), channelName: "Security team", channelKind: "email", status: "failed", reasons: ["failed"], error: "The mail server refused the message.", summary: "Security assessment failed: Customer portal" }]);
        fake.signIns.set(p.id, [MISSING_MAIN, MISSING_ADMIN]);
        fake.apps.get(app.id)!.sensitiveWorkflows = [{ name: "Payments", pathPrefixes: ["/pay"], note: "Card payments" }];
        fake.apps.get(app.id)!.signInAccount = "main";
        const pages: Array<[string, (() => Promise<void>)?]> = [
            [`#/projects/${p.id}/security/activity`],
            [`#/projects/${p.id}/security/notifications`, async () => void (await page.getByRole("radio", { name: /Only the channels chosen here/ }).check())],
            [
                `#/projects/${p.id}/security/applications/new`,
                async () => {
                    await page.getByLabel("Signed-in assessment (optional)", { exact: true }).selectOption("admin");
                    await page.locator("summary", { hasText: "Advanced" }).click();
                    await page.getByRole("button", { name: "Add a sensitive workflow", exact: true }).click();
                    await page.getByRole("button", { name: "Register application", exact: true }).click();
                },
            ],
            [`#/projects/${p.id}/security/applications/${app.id}`],
        ];
        for (const [hash, then] of pages) {
            await axeBoth(async () => {
                await visit(hash);
                await pwExpect(page.locator(".page-head")).toBeVisible();
                await then?.();
            });
        }
    }, 480_000);

    it("round 22: each new '?' explains only the words its list shows, and the keyboard reaches it", async () => {
        const open = page.locator(".tt:not([hidden])");
        /** Tab-style focus on the key's button opens its panel at once (keyboard focus); its text is read, then Escape closes it. */
        const readKey = async (name: string) => {
            const key = page.getByRole("button", { name: `About ${name}`, exact: true });
            await key.focus();
            await page.keyboard.press("Shift+Tab");
            await page.keyboard.press("Tab");
            await pwExpect(key).toBeFocused();
            await pwExpect(open).toHaveCount(1);
            const text = (await open.textContent()) ?? "";
            await page.keyboard.press("Escape");
            await pwExpect(open).toHaveCount(0);
            return text;
        };
        // Activity: the kinds of the events listed (applications, authorizations, assessments, findings, reports), not the others.
        const { p, app } = seeded();
        await visit(`#/projects/${p.id}/security/activity`);
        await pwExpect(page.getByTestId("sec-activity").locator("li")).toHaveCount(6);
        const kinds = await readKey("the kinds in this list");
        for (const w of ["Applications:", "Authorizations:", "Assessments:", "Findings:", "Reports:"]) expect(kinds).toContain(w);
        expect(kinds).not.toContain("Settings and upkeep:");
        expect(kinds).toContain("their API documents and saved sign-ins");

        // The saved sign-in choice: the two states it lists, with help.ts's definitions.
        fake.signIns.set(p.id, [READY_MAIN, MISSING_ADMIN]);
        await visit(`#/projects/${p.id}/security/applications/new`);
        await pwExpect(page.getByLabel("Signed-in assessment (optional)", { exact: true }).locator("option")).toHaveCount(3);
        const states = await readKey("the sign-in states in this list");
        expect(states).toContain("Saved sign-in ready:");
        expect(states).toContain("No saved sign-in yet: No sign-in is saved for this account yet.");
        expect(states).not.toContain("Saved sign-in expired:");

        // The uploaded API document: what happens to each kind of operation it has.
        await visit(`#/projects/${p.id}/security/applications/${app.id}`);
        const doc = { openapi: "3.0.0", info: { title: "Shop API", version: "2.1" }, paths: { "/health": { get: {} }, "/users/{id}": { get: {} }, "/orders": { post: {} } } };
        await page.setInputFiles("#sa-apidoc-file", { name: "openapi.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)) });
        await page.getByTestId("sa-apidoc").getByRole("button", { name: "Upload API document", exact: true }).click();
        await pwExpect(page.getByTestId("sa-apidoc-summary")).toContainText("3 listed");
        const ops = await readKey("what happens to each operation");
        expect(ops).toContain("Requested read-only: A GET operation without required parameters.");
        expect(ops).toContain("Needs values:");
        expect(ops).toContain("Not a GET operation:");
        expect(ops).not.toContain("Sign-out address:");

        // Recent messages: the delivery results and the reasons they were sent for.
        const q = fake.addProject("Told", "security");
        fake.recent.set(q.id, [
            { at: new Date().toISOString(), channelName: "#alerts", channelKind: "slack", status: "sent", reasons: ["reopened-critical-high"], error: null, summary: "Critical or high findings came back: Customer portal" },
        ]);
        await visit(`#/projects/${q.id}/security/notifications`);
        await pwExpect(page.getByTestId("sn-recent").locator("li")).toHaveCount(1);
        const reasons = await readKey("the delivery results and reasons");
        expect(reasons).toContain("Sent:");
        expect(reasons).toContain("Because critical or high findings came back: Critical or high findings that were marked fixed were seen again");
        expect(reasons).not.toContain("Not delivered:");
        expect(reasons).not.toContain("Because it failed:");
    });

    it("the browser reported no errors, and the fake API was asked for nothing it did not know", async () => {
        expect(consoleErrors).toEqual([]);
        expect(fake.unhandled).toEqual([]);
    });
});
