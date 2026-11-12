/**
 * Security Assessment, the screens (round 18, UI), in a real browser against a FAKE security API (tests/fixtures/security-fake-api.ts): a small
 * server that serves the built web UI and answers the routes these screens use, in the real routes' shapes, from state each test sets. The screens,
 * their requests and their words are real; what an assessment really does is CORE, RUN and FIND's work, exercised end to end by
 * tests/security-ui-real.test.ts. Nothing here touches ./data, an external site or a model.
 *
 *   the switch: off hides the nav, the testing-type choice and the section; on names the two capabilities apart
 *   testing type: New project (security only, both), Settings on an existing project, the project tab and summary card, turning it on in place
 *   applications: register (checks), the authorization step (statement, checkbox), out of date after a scope change, withdraw
 *   assessments: what it does and does not do, limits, start refused without a current authorization, progress, stop, emergency stop
 *   findings: filters in the address and the request, detail (evidence, steps, AI note apart), state change with a reason and history, manual entry
 *   overview and reports: cards, risk rules, lists, HTML view, CSV download; roles: a viewer sees but cannot act
 *   the bar: keyboard, 375 px without sideways scroll, 44 px targets, axe in light and dark
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/security-ui.test.ts
 * Port: 7070 (UI builder's range 7070-7089).
 */
import fs from "node:fs";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.js";
import { RISK_RULES, startSecurityFake, type SecurityFake } from "./fixtures/security-fake-api.js";

const PORT = 7070;
let fake: SecurityFake;
let browser: Browser;
let page: Page;
const consoleErrors: string[] = [];

async function visit(hash: string) {
    // A full load each time: the page keeps the module status and testing types it read for as long as it lives.
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
        // The report frame is sandboxed with no scripts, so axe cannot run inside it (it would wait for it forever); its content is FIND's report.
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

/** A project for security assessment with one authorized application, a finished assessment and three findings. */
function seeded(type: "security" | "both" = "security") {
    const p = fake.addProject("Acme", type);
    const app = fake.addApp(p.id, { name: "Customer portal", targetUrl: "https://staging.example.com/" });
    fake.authorize(app.id);
    const done = fake.addAssessment(app.id);
    const high = fake.addFinding(app.id, { title: "Session cookie can be read by page scripts", category: "cookies", severity: "high", validation: "probable", location: "https://staging.example.com/login", firstAssessmentId: done.id, lastAssessmentId: done.id, aiNote: "Probably set by the sign-in framework." });
    const med = fake.addFinding(app.id, { firstAssessmentId: done.id, lastAssessmentId: done.id });
    const fixed = fake.addFinding(app.id, { title: "Directory listing at /uploads/", category: "exposed-files", severity: "low", validation: "fixed", fixedByRetest: true, location: "https://staging.example.com/uploads/" });
    return { p, app, done, high, med, fixed };
}

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    fake = await startSecurityFake(PORT);
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    page = await context.newPage();
    page.on("console", (m) => {
        // axe (and Playwright's frame queries) try to run in the report frame, which is sandboxed precisely so that nothing runs there.
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
    fake.testingTypeRoute = true;
    fake.requests.length = 0;
    fake.runnersMode = false;
    fake.me = null;
});

// ── the switch ────────────────────────────────────────────────────────────────

describe("the switch", () => {
    it("off: no Security nav, no testing-type choice, the section says it is off, Settings and the project tabs are as before", async () => {
        fake.enabled = false;
        const p = fake.addProject("Functional only", "functional");
        await visit("#/new");
        await pwExpect(page.getByRole("heading", { name: "Create a test project", exact: true })).toBeVisible();
        const sidebar = page.getByRole("complementary", { name: "Main navigation" });
        await pwExpect(sidebar.locator(".nav-label").first()).toHaveText("Workspace");
        expect(await sidebar.getByRole("link", { name: "Security assessment", exact: true }).count()).toBe(0);
        expect(await page.getByTestId("testing-type").count()).toBe(0);
        await visit(`#/projects/${p.id}/settings?section=storage`);
        await pwExpect(page.getByTestId("setting-storage")).toBeVisible();
        // The testing type sits under Settings > General since round 25 (it was beside Storage in Settings).
        await visit(`#/projects/${p.id}/settings?section=general`);
        await pwExpect(page.getByTestId("project-general")).toBeVisible();
        expect(await page.getByTestId("setting-testing-type").count()).toBe(0);
        expect(await page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Security assessment" }).count()).toBe(0);
        await visit("#/security");
        await pwExpect(page.getByText("Security assessment is turned off on this server", { exact: true })).toBeVisible();
        await visit(`#/projects/${p.id}/security`);
        await pwExpect(page.getByText("Security assessment is turned off on this server", { exact: true })).toBeVisible();
        // Off, only the status is asked: no other security route.
        expect(fake.requests.filter((r) => r.path.startsWith("/v1/security") && r.path !== "/v1/security/status")).toEqual([]);
    });

    it("on: the sidebar names the two capabilities apart and the Security assessment place lists the projects that include it", async () => {
        const { p } = seeded("both");
        fake.addProject("Only functional", "functional");
        await visit("#/");
        const sidebar = page.getByRole("complementary", { name: "Main navigation" });
        // Round 37: Security assessment is no longer in the left panel, even with the module on; #/security still lists the projects.
        await pwExpect(sidebar.locator(".nav-label")).toHaveText(["Workspace", "Operations", "System"]);
        expect(await sidebar.getByRole("link", { name: "Security assessment", exact: true }).count()).toBe(0);
        await visit("#/security");
        const list = page.getByTestId("sec-projects");
        await pwExpect(list.getByRole("link", { name: /Acme/ })).toHaveAttribute("href", `#/projects/${p.id}/security`);
        expect(await list.getByRole("link", { name: /Only functional/ }).count()).toBe(0);
        await pwExpect(page.getByText(/for functional testing only\. To add security assessment to one, open its Settings/)).toBeVisible();
    });
});

// ── testing type ──────────────────────────────────────────────────────────────

describe("testing type", () => {
    it("New project, Security assessment: a name, then Register application; the type is stored", async () => {
        await visit("#/new");
        const choice = page.getByTestId("testing-type");
        await pwExpect(choice.getByRole("radio", { name: /Functional testing/ })).toBeChecked();
        await choice.getByRole("radio", { name: /Security assessment/ }).check();
        // The ways to start a functional project make room for the security one.
        expect(await page.getByRole("heading", { name: "Explore my app", exact: true }).count()).toBe(0);
        await page.getByRole("button", { name: "Create project", exact: true }).click();
        await pwExpect(page.getByText("Enter a name for the project, for example the client’s name.", { exact: true })).toBeVisible();
        await page.getByLabel("Project name", { exact: true }).fill("Globex");
        await page.getByRole("button", { name: "Create project", exact: true }).click();
        await pwExpect(page.getByRole("heading", { name: "Register application", exact: true })).toBeVisible();
        const id = [...fake.projects.values()].find((x) => x.name === "Globex")!.id;
        expect(fake.called("PUT", /testing-type$/).map((r) => [r.path, r.body])).toEqual([[`/v1/security/projects/${id}/testing-type`, { testingType: "security" }]]);
        await pwExpect(page).toHaveURL(new RegExp(`#/projects/${id}/security/applications/new$`));
    });

    it("New project, Both: whichever way the person starts, the new project also gets the security section", async () => {
        await visit("#/new");
        await page.getByTestId("testing-type").getByRole("radio", { name: /^Both/ }).check();
        await pwExpect(page.getByRole("heading", { name: "Start from tests I have", exact: true })).toBeVisible();
        await page.getByLabel("Project name", { exact: true }).fill("Initech");
        await page.getByRole("button", { name: "Write a test by hand", exact: true }).click();
        await pwExpect.poll(() => fake.called("PUT", /testing-type$/).length).toBe(1);
        const id = [...fake.projects.values()].find((x) => x.name === "Initech")!.id;
        expect(fake.called("PUT", /testing-type$/)[0]!.body).toEqual({ testingType: "both" });
        expect(fake.called("PUT", /testing-type$/)[0]!.path).toBe(`/v1/security/projects/${id}/testing-type`);
        // The Tests page it opens belongs to functional testing, which this fake does not serve: those requests are not this file's concern.
        await page.goto("about:blank");
        fake.unhandled.length = 0;
    });

    it("Settings of an existing functional project: change to Both without recreating it; the project gets a Security tab and a summary card", async () => {
        const p = fake.addProject("Existing", "functional");
        await visit(`#/projects/${p.id}/settings?section=general`);
        const row = page.getByTestId("setting-testing-type");
        await pwExpect(row).toContainText("Functional testing.");
        await row.getByRole("button", { name: "Change testing type", exact: true }).click();
        await pwExpect(row.getByRole("button", { name: "Save testing type", exact: true })).toBeDisabled();
        await row.getByRole("radio", { name: /^Both/ }).check();
        await row.getByRole("button", { name: "Save testing type", exact: true }).click();
        await pwExpect(row.getByRole("status")).toHaveText("Saved. The Security assessment section is on for this project.");
        expect(fake.called("PUT", /testing-type$/)[0]!.body).toEqual({ testingType: "both" });
        await pwExpect(row).toContainText("Both.");
        const tab = page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Security assessment" });
        await pwExpect(tab).toHaveAttribute("href", `#/projects/${p.id}/security`);
        await visit(`#/projects/${p.id}`);
        await pwExpect(page.getByTestId("security-summary")).toContainText("0 open critical or high, 0 awaiting review.");
        await pwExpect(page.getByTestId("security-summary").getByRole("link", { name: "Open security assessment" })).toHaveAttribute("href", `#/projects/${p.id}/security`);
    });

    it("a security-only project opens its security overview; a functional project's security section offers to turn it on", async () => {
        const { p } = seeded("security");
        await visit(`#/projects/${p.id}`);
        await pwExpect(page).toHaveURL(new RegExp(`#/projects/${p.id}/security$`));
        await pwExpect(page.getByRole("heading", { name: "Security assessment", exact: true, level: 1 })).toBeVisible();
        const f = fake.addProject("Functional", "functional");
        await visit(`#/projects/${f.id}/security`);
        await pwExpect(page.getByText("Security assessment is not turned on for this project", { exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Turn on security assessment", exact: true }).click();
        await pwExpect(page.getByText("No assessments yet. Add an application and run your first passive assessment.", { exact: true })).toBeVisible();
        expect(fake.called("PUT", /testing-type$/)[0]!.body).toEqual({ testingType: "both" });
    });

    it("a platform without the testing-type route: the section still opens and says the type could not be read", async () => {
        fake.testingTypeRoute = false;
        const p = fake.addProject("Old server", "security");
        await visit(`#/projects/${p.id}/security`);
        await pwExpect(page.getByText("We couldn’t read this project’s testing type", { exact: true })).toBeVisible();
        fake.unhandled.length = 0;
    });
});

// ── applications and authorization ──────────────────────────────────────────

describe("applications and the authorization", () => {
    it("register: checks the fields, sends the contract's shape, then asks for the authorization with the server's statement", async () => {
        const p = fake.addProject("Hooli", "security");
        await visit(`#/projects/${p.id}/security`);
        await pwExpect(page.getByText("No assessments yet. Add an application and run your first passive assessment.", { exact: true })).toBeVisible();
        await page.getByRole("link", { name: "Add an application", exact: true }).first().click();
        const form = page.getByTestId("sec-app-form");
        await form.getByRole("button", { name: "Register application", exact: true }).click();
        await pwExpect(form.getByText("Enter a name, for example “Customer portal”.", { exact: true })).toBeVisible();
        await form.getByLabel("Name", { exact: true }).fill("Shop");
        await form.getByLabel("Target address", { exact: true }).fill("staging.hooli.test");
        await form.getByLabel("Also in scope (optional)").fill("https://api.hooli.test\n*.cdn.hooli.test");
        await form.locator("summary", { hasText: "Advanced" }).click();
        await form.getByLabel("Never request these paths").fill("admin/billing");
        await form.getByLabel("Most requests per second").fill("12");
        await form.getByRole("button", { name: "Register application", exact: true }).click();
        await pwExpect(form.getByText("Enter a whole number from 1 to 10.", { exact: true })).toBeVisible();
        await pwExpect(form.getByText("Each excluded path starts with “/”: “admin/billing” does not.", { exact: true })).toBeVisible();
        await form.getByLabel("Never request these paths").fill("/admin/billing\n/logout");
        await form.getByLabel("Most requests per second").fill("3");
        await form.getByRole("button", { name: "Register application", exact: true }).click();
        await pwExpect(page.getByTestId("sec-auth-form")).toBeVisible();
        expect(fake.called("POST", /\/applications$/)[0]!.body).toEqual({ name: "Shop", targetUrl: "https://staging.hooli.test/", environment: "staging", scope: ["https://api.hooli.test", "*.cdn.hooli.test"], excludedPaths: ["/admin/billing", "/logout"], maxRequestsPerSecond: 3, apiSpecUrl: null, notes: null });
        await pwExpect(page.getByTestId("sec-statement")).toContainText("I confirm that Hooli owns https://staging.hooli.test/ or that its owner has given documented permission to assess it, within the scope listed.");
        await pwExpect(page.getByRole("heading", { name: "Shop", exact: true })).toBeVisible();
        await pwExpect(page.locator(".page-head")).toContainText("Not authorized yet");

        const auth = page.getByTestId("sec-auth-form");
        await auth.getByRole("button", { name: "Record authorization", exact: true }).click();
        await pwExpect(auth.getByText("Enter the name of the person who approved the assessment.", { exact: true })).toBeVisible();
        await pwExpect(auth.getByText("Tick the box to confirm the statement.", { exact: true })).toBeVisible();
        await auth.getByLabel("Approved by").fill("Gavin Client");
        await auth.getByLabel("Permission document (optional)").fill("Engagement letter 7");
        await auth.getByRole("checkbox", { name: /I confirm the statement above/ }).check();
        await auth.getByRole("button", { name: "Record authorization", exact: true }).click();
        await pwExpect(page.locator(".page-head")).toContainText("Authorized");
        expect(fake.called("POST", /authorizations$/)[0]!.body).toEqual({ basis: "client-permission", approverName: "Gavin Client", approverEmail: null, documentReference: "Engagement letter 7", restrictions: null, confirm: true });
        await pwExpect(page.getByTestId("sec-authorization")).toContainText("Gavin Client");
    });

    it("a change to the scope makes the authorization out of date: it says so and asks again; withdrawing needs a confirmation", async () => {
        const { p, app } = seeded();
        await visit(`#/projects/${p.id}/security/applications/${app.id}`);
        await pwExpect(page.locator(".page-head")).toContainText("Authorized");
        await page.getByRole("button", { name: "Change", exact: true }).click();
        await page.getByTestId("sec-app-form").getByLabel("Also in scope (optional)").fill("https://api.example.com");
        await page.getByRole("button", { name: "Save changes", exact: true }).click();
        await pwExpect(page.locator(".page-head")).toContainText("Authorization out of date");
        await pwExpect(page.getByText("The target, scope, exclusions or request limit changed after the authorization was recorded. Confirm it again before the next assessment.").first()).toBeVisible();
        await pwExpect(page.getByTestId("sec-auth-form")).toBeVisible();
        await page.getByTestId("sec-auth-form").getByRole("button", { name: "Cancel", exact: true }).click();
        await page.getByRole("button", { name: "Withdraw authorization", exact: true }).click();
        const dlg = page.getByRole("dialog", { name: "Withdraw the authorization?" });
        await pwExpect(dlg).toBeVisible();
        await pwExpect(dlg.getByRole("button", { name: "Keep it", exact: true })).toBeFocused();
        await dlg.getByRole("button", { name: "Withdraw", exact: true }).click();
        await pwExpect(page.locator(".page-head")).toContainText("Authorization withdrawn");
        expect(fake.called("DELETE", /^\/v1\/security\/authorizations\//)).toHaveLength(1);
    });
});

// ── assessments ───────────────────────────────────────────────────────────────

describe("assessments", () => {
    it("New assessment says what it does and does not do, with the limits; it will not start without a current authorization", async () => {
        const p = fake.addProject("Stale", "security");
        const app = fake.addApp(p.id);
        fake.authorize(app.id, { scopeFingerprint: "something else" });
        await visit(`#/projects/${p.id}/security/new?app=${app.id}`);
        await pwExpect(page.getByRole("heading", { name: "What the passive assessment does", exact: true })).toBeVisible();
        await pwExpect(page.getByText("Never submits forms, signs in, or clicks anything that changes data.", { exact: true })).toBeVisible();
        await pwExpect(page.getByText("Never sends attack payloads, guesses passwords or tries to break in.", { exact: true })).toBeVisible();
        await pwExpect(page.getByTestId("na-limits")).toContainText("At most 2 per second, 2000 in all, stops after 30 minutes");
        await pwExpect(page.getByTestId("na-limits")).toContainText("/admin/billing");
        await pwExpect(page.getByRole("button", { name: "Start assessment", exact: true })).toBeDisabled();
        await pwExpect(page.getByRole("link", { name: "Open the authorization", exact: true })).toHaveAttribute("href", `#/projects/${p.id}/security/applications/${app.id}?authorize=1`);
    });

    it("runners mode (round 52): says which runner it runs on, or what to fix with a link to Settings, before the click", async () => {
        const { p, app } = seeded();
        fake.runnersMode = true;
        const ok = { ok: true };
        const why = "Your runner “Maya’s laptop” is too old to run a security assessment. Update your runner in Settings, Your runner, then try again.";
        const mine = (assessment: { ok: boolean; why?: string }) => ({ id: "r1", name: "Maya’s laptop", status: "online", lastSeenAt: new Date().toISOString(), os: "linux", arch: "x64", switches: { codeScripts: true, privateTargets: true, realPhone: false }, can: { web: ok, phone: ok, ios: ok, windows: ok, record: ok, recordHeaded: ok, phoneSession: ok, assessment } });
        fake.me = mine({ ok: false, why });
        await visit(`#/projects/${p.id}/security/new?app=${app.id}`);
        await pwExpect(page.getByText(why, { exact: true })).toBeVisible();
        await pwExpect(page.getByRole("link", { name: "Open Your runner in Settings", exact: true })).toHaveAttribute("href", "#/settings#runner");
        await pwExpect(page.getByRole("button", { name: "Start assessment", exact: true })).toBeDisabled();
        fake.me = null;
        await visit(`#/projects/${p.id}/security/new?app=${app.id}`);
        await pwExpect(page.getByText("Set up your runner in Settings to run tests.", { exact: true })).toBeVisible();
        await pwExpect(page.getByRole("button", { name: "Start assessment", exact: true })).toBeDisabled();
        fake.me = mine(ok);
        await visit(`#/projects/${p.id}/security/new?app=${app.id}`);
        await pwExpect(page.getByTestId("na-runner")).toHaveText("Runs on your runner, Maya’s laptop. Its browser and every check are sent from that computer, never from the platform.");
        await pwExpect(page.getByRole("button", { name: "Start assessment", exact: true })).toBeEnabled();
    });

    it("start, watch the progress in plain words, stop: what was found is kept", async () => {
        const { p, app } = seeded();
        await visit(`#/projects/${p.id}/security/new?app=${app.id}`);
        await page.getByRole("button", { name: "Start assessment", exact: true }).click();
        await pwExpect(page.getByTestId("sec-progress")).toBeVisible();
        const a = [...fake.assessments.values()].find((x) => x.state === "QUEUED")!;
        expect(fake.called("POST", /assessments$/)[0]!.body).toEqual({});
        await pwExpect(page).toHaveURL(new RegExp(`/security/assessments/${a.id}$`));
        fake.advance(a.id, { state: "SCANNING", progress: 45, progressText: "Checking 4 pages for headers and cookies.", startedAt: new Date().toISOString() });
        await pwExpect(page.getByTestId("sec-progress")).toContainText("Checking 4 pages for headers and cookies.", { timeout: 8000 });
        await pwExpect(page.getByTestId("sec-progress").getByRole("heading")).toHaveText("Checking");
        await pwExpect(page.getByRole("progressbar", { name: "Assessment progress" })).toHaveAttribute("aria-valuenow", "45");
        await page.getByRole("button", { name: "Stop assessment", exact: true }).click();
        const dlg = page.getByRole("dialog", { name: "Stop this assessment?" });
        await pwExpect(dlg.getByRole("button", { name: "Keep running", exact: true })).toBeFocused();
        await dlg.getByRole("button", { name: "Stop assessment", exact: true }).click();
        await pwExpect(page.locator(".callout").filter({ hasText: "It was stopped before the end. What it found until then is kept" })).toBeVisible({ timeout: 8000 });
        expect(fake.called("POST", /\/cancel$/)).toHaveLength(1);
    });

    it("the emergency stop asks first, then stops every running assessment of the project", async () => {
        const { p, app } = seeded();
        fake.addAssessment(app.id, { state: "DISCOVERING", progress: 10, progressText: "Finding pages.", finishedAt: null });
        await visit(`#/projects/${p.id}/security/assessments`);
        await pwExpect(page.getByTestId("sec-assessments")).toContainText("Finding pages");
        await page.getByRole("button", { name: "Emergency stop", exact: true }).click();
        const dlg = page.getByRole("dialog", { name: "Stop every running assessment?" });
        await pwExpect(dlg).toContainText("What each one found before the stop is kept.");
        await dlg.getByRole("button", { name: "Stop them all", exact: true }).click();
        await pwExpect(page.getByTestId("stop-all-result")).toHaveText("1 running assessment was stopped.");
        expect(fake.called("POST", /stop-all$/).map((r) => r.path)).toEqual([`/v1/security/projects/${p.id}/stop-all`]);
    });

    it("a finished assessment shows its coverage and what was not inspected, and offers the report and a retest", async () => {
        const { p, done } = seeded();
        await visit(`#/projects/${p.id}/security/assessments/${done.id}`);
        const cov = page.getByTestId("sec-coverage");
        await pwExpect(cov).toContainText("Signed-in areas: no account was given.");
        await pwExpect(page.getByRole("link", { name: "Retest", exact: true })).toHaveAttribute("href", `#/projects/${p.id}/security/new?app=${done.applicationId}&retest=${done.id}`);
        await page.getByRole("link", { name: "Retest", exact: true }).click();
        await pwExpect(page.getByText("It re-checks only the locations of the earlier assessment’s open findings.", { exact: false })).toBeVisible();
        await page.getByRole("button", { name: "Start retest", exact: true }).click();
        await pwExpect(page.getByTestId("sec-progress")).toBeVisible();
        expect(fake.called("POST", /assessments$/)[0]!.body).toEqual({ retestOf: done.id });
    });
});

// ── findings ──────────────────────────────────────────────────────────────────

describe("findings", () => {
    it("filters live in the address and the request; clearing them shows everything", async () => {
        const { p } = seeded();
        await visit(`#/projects/${p.id}/security/findings`);
        await pwExpect(page.getByTestId("sec-findings").locator("li")).toHaveCount(3);
        await page.getByLabel("Severity", { exact: true }).selectOption("high");
        await pwExpect(page).toHaveURL(/severity=high/);
        await pwExpect(page.getByTestId("sec-findings").locator("li")).toHaveCount(1);
        expect(fake.requests.some((r) => r.path === `/v1/security/projects/${p.id}/findings?severity=high`)).toBe(true);
        await page.getByLabel("Search", { exact: true }).fill("cookie");
        await page.getByRole("button", { name: "Apply filters", exact: true }).click();
        await pwExpect(page).toHaveURL(/q=cookie/);
        await pwExpect(page.getByRole("status").filter({ hasText: "finding" })).toHaveText("1 finding");
        await page.getByLabel("Search", { exact: true }).fill("nothing like this");
        await page.getByRole("button", { name: "Apply filters", exact: true }).click();
        await pwExpect(page.getByText("No findings match these filters", { exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Clear filters", exact: true }).first().click();
        await pwExpect(page.getByTestId("sec-findings").locator("li")).toHaveCount(3);
    });

    it("a finding: evidence, steps to see it, the AI note kept apart; a state change needs a reason and is kept in the history", async () => {
        const { p, high } = seeded();
        await visit(`#/projects/${p.id}/security/findings/${high.id}`);
        await pwExpect(page.getByRole("heading", { name: "Session cookie can be read by page scripts", level: 1 })).toBeVisible();
        await pwExpect(page.getByTestId("fd-evidence")).toContainText("server: nginx");
        await pwExpect(page.getByRole("heading", { name: "See it yourself" })).toBeVisible();
        await pwExpect(page.getByText("Open the developer tools, Network", { exact: true })).toBeVisible();
        await pwExpect(page.getByText("An AI suggestion is not evidence and never confirms a finding.", { exact: true })).toBeVisible();
        const v = page.getByTestId("fd-validation");
        await v.getByLabel("Change the state to").selectOption("confirmed");
        await v.getByRole("button", { name: "Save state", exact: true }).click();
        await pwExpect(v.getByText("Say why, in a sentence. It is kept in the history.", { exact: true })).toBeVisible();
        await v.getByLabel("Why").fill("Checked in a browser: HttpOnly is missing.");
        await v.getByRole("button", { name: "Save state", exact: true }).click();
        await pwExpect(v.getByRole("status")).toHaveText("Saved as confirmed.");
        expect(fake.called("PATCH", /\/findings\//)[0]!.body).toEqual({ validation: "confirmed", comment: "Checked in a browser: HttpOnly is missing." });
        await pwExpect(page.getByTestId("fd-history")).toContainText("Probable to Confirmed");
        await pwExpect(page.getByTestId("fd-history")).toContainText("“Checked in a browser: HttpOnly is missing.”");
        await pwExpect(page.locator(".page-head")).toContainText("Confirmed");
    });

    it("a finding entered by hand: required fields, then the contract's shape with the observation as evidence", async () => {
        const { p, app } = seeded();
        await visit(`#/projects/${p.id}/security/findings`);
        await page.getByRole("link", { name: "Add a finding by hand", exact: true }).click();
        const form = page.getByTestId("sec-manual-form");
        await form.getByRole("button", { name: "Add finding", exact: true }).click();
        await pwExpect(form.getByText("Enter a short title.", { exact: true })).toBeVisible();
        await pwExpect(form.getByText("Say how to fix it.", { exact: true })).toBeVisible();
        await form.getByLabel("Title", { exact: true }).fill("Old TLS version accepted");
        await form.getByLabel("Severity", { exact: true }).selectOption("high");
        await form.getByLabel("Category", { exact: true }).selectOption("tls");
        await form.getByLabel("Location", { exact: true }).fill("staging.example.com:443");
        await form.getByLabel("What was found", { exact: true }).fill("The client's scanner reports TLS 1.0 is accepted.");
        await form.getByLabel("Why it matters", { exact: true }).fill("Old versions have known weaknesses.");
        await form.getByLabel("How to fix it", { exact: true }).fill("Turn off TLS 1.0 and 1.1.");
        await form.getByLabel("What you observed (optional)").fill("Scanner report 3 May, row 12, sent by ops@example.com");
        await form.getByRole("button", { name: "Add finding", exact: true }).click();
        await pwExpect(page.getByRole("heading", { name: "Old TLS version accepted", level: 1 })).toBeVisible();
        const body = fake.called("POST", /\/findings$/)[0]!.body;
        expect(fake.called("POST", /\/findings$/)[0]!.path).toBe(`/v1/security/applications/${app.id}/findings`);
        expect({ ...body, evidence: body.evidence.map((e: any) => ({ ...e, observedAt: typeof e.observedAt })) }).toEqual({
            title: "Old TLS version accepted",
            category: "tls",
            severity: "high",
            confidence: "medium",
            location: "staging.example.com:443",
            description: "The client's scanner reports TLS 1.0 is accepted.",
            impact: "Old versions have known weaknesses.",
            remediation: "Turn off TLS 1.0 and 1.1.",
            reproduction: null,
            evidence: [{ kind: "note", label: "Observed by hand", value: "Scanner report 3 May, row 12, sent by ops@example.com", observedAt: "string" }],
        });
        // What the server stored (redacted) is what the page shows.
        await pwExpect(page.getByTestId("fd-evidence")).toContainText("[email hidden]");
        await pwExpect(page.getByText("Entered by hand", { exact: true })).toBeVisible();
    });
});

// ── overview, reports, roles ────────────────────────────────────────────────

describe("overview, reports and roles", () => {
    it("the overview: four cards, the risk line with its rules, what needs attention and what a retest fixed", async () => {
        const { p, high, fixed } = seeded();
        await visit(`#/projects/${p.id}/security`);
        const cards = page.getByTestId("sec-metrics");
        await pwExpect(cards).toContainText("1Application assessed");
        await pwExpect(cards).toContainText("1Assessment completed");
        await pwExpect(cards).toContainText("1Open critical or high");
        await pwExpect(cards).toContainText("2Awaiting review");
        const risk = page.getByTestId("sec-risk");
        await pwExpect(risk.getByRole("heading", { level: 2 })).toHaveText("Risk overview: High risk");
        for (const r of RISK_RULES) await pwExpect(risk.getByText(r, { exact: true })).toBeVisible();
        await pwExpect(risk).toContainText("never a promise that an application is secure");
        await pwExpect(page.getByTestId("sec-attention-list").getByRole("link").first()).toHaveAttribute("href", `#/projects/${p.id}/security/findings/${high.id}`);
        await pwExpect(page.getByTestId("sec-fixed-list").getByRole("link")).toHaveAttribute("href", `#/projects/${p.id}/security/findings/${fixed.id}`);
    });

    it("reports: the HTML report in a frame that runs no script, the CSV as a download, one assessment's report on request", async () => {
        const { p, done } = seeded();
        await visit(`#/projects/${p.id}/security/reports`);
        const frame = page.getByTestId("sec-report-frame");
        await pwExpect(frame).toHaveAttribute("sandbox", "");
        await pwExpect(page.frameLocator('[data-testid="sec-report-frame"]').getByRole("heading", { name: "Security assessment report" })).toBeVisible();
        const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download findings as CSV", exact: true }).click()]);
        expect(download.suggestedFilename()).toBe("security-report.csv");
        expect(fake.requests.some((r) => r.path === `/v1/security/projects/${p.id}/report?format=csv`)).toBe(true);
        await page.getByLabel("Report on", { exact: true }).selectOption(done.id);
        await pwExpect(page.frameLocator('[data-testid="sec-report-frame"]').getByText(`Report of the assessment ${done.id}.`)).toBeVisible();
        const [pdf] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download PDF", exact: true }).click()]);
        expect(pdf.suggestedFilename()).toBe("security-report.pdf");
        expect(fake.requests.some((r) => r.path === `/v1/security/assessments/${done.id}/report?format=pdf`)).toBe(true);
    });

    it("a viewer sees everything but is not offered what the server would refuse", async () => {
        const { p, app, high } = seeded();
        fake.role = "viewer";
        await visit(`#/projects/${p.id}/security`);
        await pwExpect(page.getByTestId("sec-metrics")).toBeVisible();
        expect(await page.getByRole("link", { name: "Add an application", exact: true }).count()).toBe(0);
        await pwExpect(page.getByRole("button", { name: "Emergency stop", exact: true })).toBeDisabled();
        await visit(`#/projects/${p.id}/security/new?app=${app.id}`);
        await pwExpect(page.getByRole("button", { name: "Start assessment", exact: true })).toBeDisabled();
        await pwExpect(page.getByText("Editors and owners can start assessments.", { exact: true })).toBeVisible();
        await visit(`#/projects/${p.id}/security/applications/${app.id}`);
        await pwExpect(page.getByText("Only a project owner can record or withdraw an authorization.", { exact: true })).toBeVisible();
        await visit(`#/projects/${p.id}/security/findings/${high.id}`);
        await pwExpect(page.getByText("Editors and owners can change the state.", { exact: true })).toBeVisible();
        expect(fake.requests.filter((r) => r.method !== "GET")).toEqual([]);
    });

    it("an editor cannot choose Risk accepted (an owner's decision); the option says so", async () => {
        const { p, med } = seeded();
        fake.role = "editor";
        await visit(`#/projects/${p.id}/security/findings/${med.id}`);
        const opt = page.getByTestId("fd-validation").locator("option", { hasText: "Risk accepted" });
        await pwExpect(opt).toHaveText("Risk accepted (owners only)");
        await pwExpect(opt).toBeDisabled();
    });
});

// ── the bar ───────────────────────────────────────────────────────────────────

describe("the bar: keyboard, phone width, targets, contrast", () => {
    it("keyboard only: choose the testing type with arrow keys; start an assessment with Enter", async () => {
        await visit("#/new");
        const functional = page.getByTestId("testing-type").getByRole("radio", { name: /Functional testing/ });
        await functional.focus();
        await page.keyboard.press("ArrowDown");
        await pwExpect(page.getByTestId("testing-type").getByRole("radio", { name: /Security assessment/ })).toBeChecked();
        await pwExpect(page.getByLabel("Project name", { exact: true })).toBeVisible();
        const { p, app } = seeded();
        await visit(`#/projects/${p.id}/security/new?app=${app.id}`);
        await page.getByLabel("Application", { exact: true }).focus();
        let reached = false;
        for (let i = 0; i < 12 && !reached; i++) {
            await page.keyboard.press("Tab");
            reached = (await page.evaluate(() => document.activeElement?.textContent?.trim())) === "Start assessment";
        }
        expect(reached).toBe(true);
        const focusRing = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle !== "none" || getComputedStyle(document.activeElement!).boxShadow !== "none");
        expect(focusRing).toBe(true);
        await page.keyboard.press("Enter");
        await pwExpect(page.getByTestId("sec-progress")).toBeVisible();
    });

    it("at 375 px nothing scrolls sideways and the choices are at least 44 px tall", async () => {
        const { p, app, high } = seeded();
        await page.setViewportSize({ width: 375, height: 800 });
        try {
            for (const hash of [`#/projects/${p.id}/security`, `#/projects/${p.id}/security/applications/${app.id}?authorize=1`, `#/projects/${p.id}/security/new?app=${app.id}`, `#/projects/${p.id}/security/findings`, `#/projects/${p.id}/security/findings/${high.id}`, `#/projects/${p.id}/security/reports`, "#/security"]) {
                await visit(hash);
                await pwExpect(page.locator(".page-head")).toBeVisible();
                await page.waitForTimeout(300);
                await noOverflow();
            }
            await visit("#/new");
            await pwExpect(page.getByTestId("testing-type")).toBeVisible();
            await noOverflow();
            for (const name of [/Functional testing/, /Security assessment/, /^Both/]) await tall(page.getByTestId("testing-type").locator("label.check").filter({ has: page.getByRole("radio", { name }) }), `the ${name} choice`);
            await visit(`#/projects/${p.id}/security/applications/${app.id}?authorize=1`);
            await tall(page.getByRole("button", { name: "Record a new authorization", exact: true }), "Record a new authorization");
            await page.getByRole("button", { name: "Record a new authorization", exact: true }).click();
            await tall(page.getByTestId("sec-auth-form").locator("label.check").filter({ hasText: "I confirm the statement above" }), "the confirmation checkbox row");
        } finally {
            await page.setViewportSize({ width: 1280, height: 900 });
        }
    });

    it("axe finds nothing in light or dark: overview, applications, authorization, register, new assessment, assessments, one assessment", async () => {
        const { p, app, done } = seeded();
        for (const hash of [
            `#/projects/${p.id}/security`,
            `#/projects/${p.id}/security/applications`,
            `#/projects/${p.id}/security/applications/${app.id}?authorize=1`,
            `#/projects/${p.id}/security/applications/new`,
            `#/projects/${p.id}/security/new?app=${app.id}`,
            `#/projects/${p.id}/security/assessments`,
            `#/projects/${p.id}/security/assessments/${done.id}`,
        ]) {
            await axeBoth(async () => {
                await visit(hash);
                await pwExpect(page.locator(".page-head")).toBeVisible();
            });
        }
    }, 480_000);

    it("axe finds nothing in light or dark: findings, one finding, manual entry, reports, the Security place, the testing-type choice", async () => {
        const { p, high } = seeded();
        const fn = fake.addProject("Plain", "functional");
        for (const hash of [
            `#/projects/${p.id}/security/findings`,
            `#/projects/${p.id}/security/findings/${high.id}`,
            `#/projects/${p.id}/security/findings/new`,
            `#/projects/${p.id}/security/reports`,
            "#/security",
            "#/new",
            `#/projects/${fn.id}/settings?section=general`,
        ]) {
            await axeBoth(async () => {
                await visit(hash);
                await pwExpect(page.locator(".page-head").first()).toBeVisible();
                if (hash.endsWith("settings?section=general")) await page.getByRole("button", { name: "Change testing type", exact: true }).click();
            });
        }
    }, 480_000);

    it("the browser reported no errors, and the fake API was asked for nothing it did not know", async () => {
        expect(consoleErrors).toEqual([]);
        expect(fake.unhandled).toEqual([]);
    });
});
