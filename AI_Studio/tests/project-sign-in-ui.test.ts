/**
 * Settings → Sign-in, in a real browser against a real platform (port 9781, nothing runs, no AI): the section sits before
 * Environments; an owner saves a user name, password and authenticator secret and reads them back as "Saved" (never the values),
 * replaces the password and removes the secret; a project with no address yet says to add one first; the links to Environments and Test accounts; a project viewer sees it read-only.
 * A test that types {{credentials.username}} in a project with no sign-in says where to add one; with one saved it does not. An agent
 * project's "What the agents need" card shows what Settings saved and links here; its API access is on the main account. Each account
 * appears once with its own "Signed in by hand" part, then the test mailbox; a test account can't be named "main". Axe in light and dark.
 * Requires `web/dist` (vite build).
 *
 *   node scripts/with-lock.mjs build,browser -- sh -c "npx vite build web && npx vitest run tests/project-sign-in-ui.test.ts"
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { hashPassword } from "../src/platform/auth/password.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { testingAgentsOf } from "../src/platform/routes/testing-agents.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 9781;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "project-sign-in-ui-key-41c9";
const PASSWORD = "SignInUi-first-pass-7f2a";
const NEW_PASSWORD = "SignInUi-second-pass-9b4e";
const TOTP = "JBSWY3DPEHPK3PXP";
let browser: Browser;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir = "";
let shop = "";
let bare = "";
let agentShop = "";
let noAddress = "";
let shopTest = "";
let bareTest = "";
let namedTest = "";
let codeTest = "";
let halfTest = "";
let half = "";

async function call(method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
    const r = await server.inject({ method, url, payload: payload as never, headers: { "x-api-key": KEY, ...(payload !== undefined ? { "content-type": "application/json" } : {}) } });
    if (r.statusCode >= 300) throw new Error(`${method} ${url}: ${r.statusCode} ${r.body}`);
    return r.json();
}
const signInOf = (id: string) => call("GET", `/api/projects/${id}/sign-in`);

const signInSpec = {
    title: "Sign in shows the account",
    kind: "web",
    category: "Accounts",
    steps: [
        { action: "navigate", url: "/login" },
        { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}" },
        { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" },
        { action: "click", locator: { by: "role", role: "button", value: "Sign in" } },
    ],
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-project-sign-in-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY: KEY, HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", ALLOW_CUSTOM_SCRIPTS: "true" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    // A code project, and another with no sign-in; each has a test that types the sign-in.
    shop = platform.repo.createProject({ name: "Code shop", platforms: ["web"], testingModes: ["code"] }).id as string;
    platform.repo.createApplication(shop, "https://shop.example/", {} as never);
    bare = platform.repo.createProject({ name: "No sign-in shop", platforms: ["web"], testingModes: ["code"] }).id as string;
    platform.repo.createApplication(bare, "https://bare.example/", {} as never);
    shopTest = (await call("POST", `/api/projects/${shop}/specs`, { specs: [signInSpec], baseUrl: "https://shop.example/", validate: false })).tests[0].id;
    bareTest = (await call("POST", `/api/projects/${bare}/specs`, { specs: [signInSpec], baseUrl: "https://bare.example/", validate: false })).tests[0].id;
    noAddress = platform.repo.createProject({ name: "No address yet", platforms: ["web"], testingModes: ["code"] }).id as string;
    // In the project with no sign-in: a test that signs in only as a named test account (not the project's sign-in), and a code
    // test that reads TEST_PASSWORD (what a code test gets the project's password as).
    const named = { ...signInSpec, title: "Admin sees the dashboard", steps: [{ action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.admin.password}}" }] };
    const plain = { title: "Home page opens", kind: "web", category: "Pages", steps: [{ action: "navigate", url: "/" }] };
    [namedTest, codeTest] = (await call("POST", `/api/projects/${bare}/specs`, { specs: [named, plain], baseUrl: "https://bare.example/", validate: false })).tests.map((t: { id: string }) => t.id);
    const taken = await call("POST", `/api/tests/${codeTest}/take-over`, { confirm: true });
    const code = taken.scripts[0].content as string;
    await call("PUT", `/api/tests/${codeTest}/script`, { content: `// Signs in with process.env.TEST_PASSWORD.\n${code}` });
    // A project with a user name saved but no password: not a sign-in runs can use.
    half = platform.repo.createProject({ name: "Half sign-in shop", platforms: ["web"], testingModes: ["code"] }).id as string;
    platform.repo.createApplication(half, "https://half.example/", {} as never);
    await call("PUT", `/api/projects/${half}/sign-in`, { username: "only-a-name@half.example" });
    halfTest = (await call("POST", `/api/projects/${half}/specs`, { specs: [signInSpec], baseUrl: "https://half.example/", validate: false })).tests[0].id;
    // An agent project, explored at an address, so its "What the agents need" card can be edited.
    agentShop = platform.repo.createProject({ name: "Agent shop", platforms: ["web"], testingModes: ["agent"] }).id as string;
    platform.repo.createApplication(agentShop, "https://agent.example/", {} as never);
    await testingAgentsOf(platform).set(agentShop, ["test-generation"], "test");

    const users = accessControlOf(server).users;
    const olga = users.create({ email: "olga@example.com", name: "Olga Owner", role: "owner" });
    users.setPassword(olga.id, await hashPassword("olga's long password"));
    // Vic may work on the platform but only views this project.
    const vic = users.create({ email: "vic@example.com", name: "Vic Viewer", role: "editor" });
    users.setPassword(vic.id, await hashPassword("vic's long password"));
    const scope = accessControlOf(server).projects.store;
    scope.setMode(vic.id, "only");
    scope.addMember(shop, vic.id, { role: "viewer", projectAdmin: false, source: "added", addedBy: "test" });
    browser = await chromium.launch();
}, 90_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

async function signIn(email: string, password: string): Promise<Page> {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await page.goto(BASE);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await pwExpect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    return page;
}

async function axeBoth(page: Page) {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(300);
        const r = await new AxeBuilder({ page }).analyze();
        expect(r.violations.map((v) => `${scheme} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: null });
}

describe("Settings → Sign-in", () => {
    let page: Page;
    const card = () => page.getByTestId("project-sign-in");
    /** The PUT bodies the page sent, to check what Replace and Remove ask for. */
    const sent: unknown[] = [];

    it("is a tab of Settings, before Environments and Test data", async () => {
        page = await signIn("olga@example.com", "olga's long password");
        page.on("request", (r) => {
            if (r.method() === "PUT" && r.url().endsWith(`/api/projects/${shop}/sign-in`)) sent.push(r.postDataJSON());
        });
        await page.goto(`${BASE}/#/projects/${shop}/settings`);
        const names = (await page.getByRole("navigation", { name: "Settings sections" }).locator("a").allTextContents()).map((t) => t.trim());
        expect(names.slice(names.indexOf("Sign-in"), names.indexOf("Sign-in") + 3)).toEqual(["Sign-in", "Environments", "Test data"]);
        // Test accounts is no tab of its own any more: it is on the Sign-in tab.
        expect(names).not.toContain("Test accounts");
        await page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Sign-in" }).click();
        await page.waitForURL((u) => u.hash === `#/projects/${shop}/settings?section=signin`);
        await pwExpect(card().getByRole("heading", { name: "Main account" })).toBeVisible();
        await pwExpect(card()).toContainText("Tests type these where a step uses {{credentials.username}} and {{credentials.password}}.");
    });

    it("has the other test accounts below it on the same tab, and an old Test accounts link opens them there", async () => {
        await pwExpect(page.getByRole("heading", { name: "Test accounts" })).toBeVisible();
        // The sign-in card comes first, the accounts after it.
        expect(await card().evaluate((c) => !!(c.compareDocumentPosition(document.getElementById("accounts")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
        await page.goto(`${BASE}/#/projects/${shop}/settings?section=accounts`);
        await page.waitForURL((u) => u.hash === `#/projects/${shop}/settings?section=signin#accounts`);
        await pwExpect(page.locator("#accounts")).toBeFocused();
        await pwExpect(page.locator("#accounts").getByRole("heading", { name: "Test accounts" })).toBeInViewport();
        await page.goto(`${BASE}/#/projects/${shop}/settings?section=signin`);
        await pwExpect(card()).toBeVisible();
    });

    it("shows each account once, each with its own “Signed in by hand” part, then the test mailbox; no separate list of saved sign-ins", async () => {
        await call("PUT", `/api/projects/${shop}/roles`, { roles: [{ name: "admin", username: "admin@shop.example", password: "SignInUi-admin-pass-3c1d" }] });
        await page.reload();
        await pwExpect(card()).toBeVisible();
        await pwExpect(page.getByRole("heading", { name: "Saved sign-ins" })).toHaveCount(0);
        // The main account's part is in its own card; the test account's under its row; nothing else lists the accounts again.
        await pwExpect(card().getByTestId("signed-in-by-hand-main")).toHaveCount(1);
        await pwExpect(page.locator("#accounts").getByTestId("signed-in-by-hand-admin")).toHaveCount(1);
        await pwExpect(page.locator("[data-testid^='signed-in-by-hand-']")).toHaveCount(2);
        await pwExpect(card().getByTestId("signed-in-by-hand-main").getByRole("button", { name: "Sign in once yourself" })).toBeVisible();
        await pwExpect(card().getByTestId("signed-in-by-hand-main").getByText("Upload a saved sign-in file")).toBeVisible();
        const mailbox = page.getByRole("heading", { name: "Test mailbox" });
        await pwExpect(mailbox).toBeVisible();
        expect(await page.locator("#accounts").evaluate((a) => !!(a.compareDocumentPosition(Array.from(document.querySelectorAll("h2")).find((h) => h.textContent === "Test mailbox")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
        // A project tested by code has no agents' API access: no token field on the main account.
        await pwExpect(card().getByTestId("sign-in-api-access")).toHaveCount(0);
        await axeBoth(page);
        await call("PUT", `/api/projects/${shop}/roles`, { roles: [] });
        await page.reload();
        await pwExpect(card()).toBeVisible();
    });

    it("a test account can't be named “main”: the page says so before saving, and the server refuses it", async () => {
        await page.locator("#accounts").getByRole("button", { name: "Add an account" }).click();
        await page.locator("#accounts").getByLabel("Name", { exact: true }).fill("main");
        await pwExpect(page.locator("#accounts").getByText("“main” is the project’s own account (Main account above): choose another name.")).toBeVisible();
        await pwExpect(page.locator("#accounts").getByRole("button", { name: "Save accounts" })).toBeDisabled();
        const r = await server.inject({ method: "PUT", url: `/api/projects/${shop}/roles`, payload: { roles: [{ name: "main", username: "m@shop.example", password: "SignInUi-main-pass-5e2a" }] }, headers: { "x-api-key": KEY, "content-type": "application/json" } });
        expect(r.statusCode).toBe(400);
        expect(r.body).toContain("“main” is the project’s own account");
        await page.reload();
        await pwExpect(card()).toBeVisible();
    });

    it("saves the user name, password and authenticator secret, and reads them back masked", async () => {
        await card().getByLabel("User name or email").fill("tester@shop.example");
        await card().getByLabel("Password").fill(PASSWORD);
        await card().getByLabel("Authenticator secret (optional)").fill(TOTP);
        await card().getByRole("button", { name: "Save sign-in" }).click();
        await pwExpect(card().getByText("Saved. Tests use this sign-in from their next run.")).toBeVisible();
        expect(await signInOf(shop)).toMatchObject({ username: "tester@shop.example", hasPassword: true, hasTotp: true });
        await page.reload();
        await pwExpect(card().getByLabel("User name or email")).toHaveValue("tester@shop.example");
        for (const [group, name] of [["Password", "password"], ["Authenticator secret (optional)", "authenticator secret"]] as const) {
            const g = card().getByRole("group", { name: group });
            await pwExpect(g.getByText("Saved", { exact: true })).toBeVisible();
            await pwExpect(g.getByRole("button", { name: `Replace the ${name}` })).toBeVisible();
            await pwExpect(g.getByRole("button", { name: `Remove the ${name}` })).toBeVisible();
        }
        // Secrets are never put back in a field or on the page.
        await pwExpect(card().locator("input#si-pass, input#si-totp")).toHaveCount(0);
        const html = await page.content();
        expect(html).not.toContain(PASSWORD);
        expect(html).not.toContain(TOTP);
        await axeBoth(page);
    });

    it("replaces the password, keeping the rest", async () => {
        sent.length = 0;
        await card().getByRole("button", { name: "Replace the password" }).click();
        await card().getByLabel("Password").fill(NEW_PASSWORD);
        await card().getByRole("button", { name: "Save sign-in" }).click();
        await pwExpect(card().getByText("Saved. Tests use this sign-in from their next run.")).toBeVisible();
        expect(sent).toEqual([{ username: "tester@shop.example", password: NEW_PASSWORD }]);
        expect(await signInOf(shop)).toMatchObject({ username: "tester@shop.example", hasPassword: true, hasTotp: true });
        await pwExpect(card().getByRole("group", { name: "Password" }).getByText("Saved", { exact: true })).toBeVisible();
        expect(await page.content()).not.toContain(NEW_PASSWORD);
    });

    it("removes the authenticator secret", async () => {
        sent.length = 0;
        await card().getByRole("button", { name: "Remove the authenticator secret" }).click();
        await pwExpect(card().getByText("Removed when you save")).toBeVisible();
        await card().getByRole("button", { name: "Save sign-in" }).click();
        await pwExpect(card().getByText("Saved. Tests use this sign-in from their next run.")).toBeVisible();
        expect(sent).toEqual([{ username: "tester@shop.example", clear: ["totpSecret"] }]);
        expect(await signInOf(shop)).toMatchObject({ username: "tester@shop.example", hasPassword: true, hasTotp: false });
        // Nothing saved: an empty field to add one again.
        // The form re-reads the saved sign-in after saving; wait for the empty field itself (the label names the "Saved" group until then).
        await pwExpect(card().locator("input").and(card().getByLabel("Authenticator secret (optional)"))).toHaveValue("");
        await pwExpect(card().getByRole("group", { name: "Password" }).getByText("Saved", { exact: true })).toBeVisible();
    });

    it("a test that types the sign-in says nothing while one is saved, and where to add one when none is", async () => {
        await page.goto(`${BASE}/#/tests/${shopTest}/steps`);
        await pwExpect(page.getByRole("tab", { name: "Steps" })).toBeVisible();
        await pwExpect(page.getByText("Sign in shows the account").first()).toBeVisible();
        await page.waitForTimeout(500);
        await pwExpect(page.getByTestId("missing-sign-in")).toHaveCount(0);

        await page.goto(`${BASE}/#/tests/${bareTest}/steps`);
        const hint = page.getByTestId("missing-sign-in");
        await pwExpect(hint).toContainText("its user name and password are not both saved yet");
        await pwExpect(hint.getByRole("link", { name: "Settings → Sign-in" })).toHaveAttribute("href", `#/projects/${bare}/settings?section=signin`);
        await axeBoth(page);
        await hint.getByRole("link", { name: "Settings → Sign-in" }).click();
        await pwExpect(page.getByTestId("project-sign-in").getByLabel("User name or email")).toHaveValue("");
    });

    it("the hint counts only the project's own sign-in: not a named test account; yes for TEST_PASSWORD in code; yes for a user name alone", async () => {
        await page.goto(`${BASE}/#/tests/${namedTest}/steps`);
        await pwExpect(page.getByText("Admin sees the dashboard").first()).toBeVisible();
        await page.waitForTimeout(500);
        await pwExpect(page.getByTestId("missing-sign-in")).toHaveCount(0);

        await page.goto(`${BASE}/#/tests/${codeTest}/code`);
        await pwExpect(page.getByTestId("missing-sign-in").getByRole("link", { name: "Settings → Sign-in" })).toHaveAttribute("href", `#/projects/${bare}/settings?section=signin`);

        await page.goto(`${BASE}/#/tests/${halfTest}/steps`);
        await pwExpect(page.getByTestId("missing-sign-in").getByRole("link", { name: "Settings → Sign-in" })).toHaveAttribute("href", `#/projects/${half}/settings?section=signin`);
    });

    it("a project with no address yet says to add it first, and offers nothing to save", async () => {
        await page.goto(`${BASE}/#/projects/${noAddress}/settings?section=signin`);
        await pwExpect(card().getByText("Add the application’s address first")).toBeVisible();
        await pwExpect(card().getByRole("link", { name: "Settings → General" })).toHaveAttribute("href", `#/projects/${noAddress}/settings`);
        await pwExpect(card().getByLabel("User name or email")).toBeDisabled();
        await pwExpect(card().getByRole("button", { name: "Save sign-in" })).toHaveCount(0);
    });

    it("an agent project's “What the agents need” shows the same sign-in and links here to change it", async () => {
        await page.goto(`${BASE}/#/projects/${agentShop}/settings?section=signin`);
        // An agent project's main account also has its API access here.
        await pwExpect(card().getByTestId("sign-in-api-access").getByLabel("Bearer token")).toBeVisible();
        await card().getByLabel("User name or email").fill("agent@agent.example");
        await card().getByLabel("Password").fill(PASSWORD);
        await card().getByRole("button", { name: "Save sign-in" }).click();
        await pwExpect(card().getByText("Saved. Tests use this sign-in from their next run.")).toBeVisible();

        await page.goto(`${BASE}/#/projects/${agentShop}/requirements?inputs=open`);
        const agents = page.getByTestId("agent-inputs");
        await pwExpect(agents.getByTestId("agent-inputs-sign-in")).toContainText("Signs in as agent@agent.example.");
        await pwExpect(agents.getByLabel("Username or email")).toHaveCount(0);
        await pwExpect(agents.getByTestId("agent-inputs-sign-in").getByRole("link", { name: "Settings → Sign-in" })).toHaveAttribute("href", `#/projects/${agentShop}/settings?section=signin`);
        await page.context().close();
    });
});

describe("Settings → Sign-in without the permission to change settings", () => {
    it("shows what is saved, read-only", async () => {
        const page = await signIn("vic@example.com", "vic's long password");
        await page.goto(`${BASE}/#/projects/${shop}/settings?section=signin`);
        const card = page.getByTestId("project-sign-in");
        await pwExpect(card.getByLabel("User name or email")).toHaveValue("tester@shop.example");
        await pwExpect(card.getByLabel("User name or email")).toBeDisabled();
        await pwExpect(card.getByRole("group", { name: "Password" }).getByText("Saved", { exact: true })).toBeVisible();
        await pwExpect(card.getByRole("group", { name: "Authenticator secret (optional)" }).getByText("Not set", { exact: true })).toBeVisible();
        await pwExpect(card.getByRole("button")).toHaveCount(0);
        await pwExpect(card.getByText("Only people who may change this project’s settings can change the sign-in.")).toBeVisible();
        await axeBoth(page);
        await page.context().close();
    });
});
