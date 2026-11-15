/**
 * The cross-account settings card on the application's page, in a real browser against the REAL platform: set up through the screen
 * (two test accounts, addresses with their owner), the server's readiness problems shown in words, a server refusal shown on the form,
 * removal; axe in light and dark; 375 px without sideways scroll. No assessment runs, so nothing is requested from the target address.
 * The legacy authorization's expiry date on the authorization card.
 * Temp data directory only. Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- sh -c "npx vite build web && npx vitest run tests/security-ui-cross-account.test.ts"
 * Port: 9790 (port range 9790-9799).
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
import { IdentityStore } from "../src/platform/identity-store.js";
import { SecretBox } from "../src/platform/secrets.js";
import { buildServer } from "../src/platform/server.js";
import { securityStoreFor } from "../src/security/store.js";

const PORT = 9790;
const BASE = `http://localhost:${PORT}`;
const TARGET = "http://127.0.0.1:9791/";
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let page: Page;
let dataDir: string;
let projectId: string;
let appId: string;
const consoleErrors: string[] = [];

async function apiCall(method: string, url: string, body?: unknown) {
    const res = await fetch(`${BASE}${url}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json().catch(() => undefined)) as any };
}
async function axeBoth() {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(400);
        const r = await new AxeBuilder({ page }).include('[data-testid="sa-xacct"]').analyze();
        expect(r.violations.map((v) => `${scheme} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: null });
}
async function noOverflow() {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, page.url()).toBe(0);
}
const stateFor = (value: string) => ({ cookies: [{ name: "sid", value, domain: "127.0.0.1", path: "/", expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] });

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sec-ui-xacct-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "ui-xacct-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", SECURITY_ALLOW_PRIVATE_TARGETS: "true" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    projectId = String(platform.repo.createProject({ name: "Notes client" }).id);
    securityStoreFor(platform.db).setTestingType(projectId, "security");
    new IdentityStore(platform.db, new SecretBox(platform.config.dataDir, platform.config.SECRET_KEY)).set(projectId, [
        { name: "alice", username: "alice@example.test", password: "never-typed-1" },
        { name: "bob", username: "bob@example.test", password: "never-typed-2" },
    ]);
    const r = await apiCall("POST", `/api/v1/security/projects/${projectId}/applications`, { name: "Notes (staging)", targetUrl: TARGET, environment: "staging", maxRequestsPerSecond: 2 });
    expect(r.status).toBe(201);
    appId = r.body.application.id;
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
    platform?.db.close?.();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("the cross-account settings card", () => {
    it("is set up on the application's page, shows the server's readiness problems, shows a refusal, and is removed", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/security/applications/${appId}`);
        const card = page.getByTestId("sa-xacct");
        await pwExpect(card).toContainText("Not set up.");
        await axeBoth();

        await card.getByRole("button", { name: "Set up cross-account checks", exact: true }).click();
        const form = card.getByTestId("sa-xacct-form");
        await pwExpect(form.getByLabel("Account A", { exact: true }).locator("option", { hasText: "alice" })).toHaveText("Test account “alice”, no saved sign-in yet");
        await form.getByLabel("Account A", { exact: true }).selectOption("alice");
        await form.getByLabel("Account B", { exact: true }).selectOption("bob");
        // A sign-out address: the server refuses it and the form says why.
        await form.getByLabel("Path", { exact: true }).fill("/logout");
        await form.getByRole("button", { name: "Save cross-account checks", exact: true }).click();
        await pwExpect(form.getByText("We couldn’t save the cross-account checks")).toBeVisible();
        await pwExpect(form).toContainText("sign-out");
        expect((await apiCall("GET", `/api/v1/security/applications/${appId}/cross-account`)).body.designation).toBeNull();

        await form.getByLabel("Path", { exact: true }).fill("/api/notes/50123");
        await form.getByLabel("Note (optional)", { exact: true }).fill("Bob's note");
        await form.getByRole("button", { name: "Add an address", exact: true }).click();
        await form.getByRole("group", { name: "Address 2" }).getByLabel("Path", { exact: true }).fill("/api/notes");
        await form.getByRole("group", { name: "Address 2" }).getByLabel("What it is", { exact: true }).selectOption("list");
        await form.locator("summary", { hasText: "How the application names an owner" }).click();
        await form.getByLabel("Owner field", { exact: true }).fill("ownerId");
        await axeBoth();
        await form.getByRole("button", { name: "Save cross-account checks", exact: true }).click();

        const summary = card.getByTestId("sa-xacct-summary");
        await pwExpect(summary).toContainText("Test account “alice”");
        await pwExpect(summary).toContainText("/api/notes/50123");
        await pwExpect(summary).toContainText("a list, account b’s");
        expect((await apiCall("GET", `/api/v1/security/applications/${appId}/cross-account`)).body.designation).toEqual({
            accountA: "alice",
            accountB: "bob",
            resources: [
                { path: "/api/notes/50123", kind: "item", owner: "B", label: "Bob's note" },
                { path: "/api/notes", kind: "list", owner: "B" },
            ],
            ownerField: "ownerId",
        });
        // The server's readiness problems, in its words: neither account has a saved sign-in.
        const ready = card.getByTestId("sa-xacct-ready");
        await pwExpect(ready).toContainText("Not ready yet");
        await pwExpect(ready).toContainText("Account A (");
        await pwExpect(ready).toContainText("Account B (");
        await axeBoth();

        // Saved sign-ins for both: ready.
        for (const [account, value] of [["alice", "a-4471"], ["bob", "b-9902"]] as const) expect((await apiCall("PUT", `/api/v1/security/applications/${appId}/saved-sign-in`, { account, storageState: stateFor(value) })).status).toBe(200);
        await page.reload();
        await pwExpect(card.getByTestId("sa-xacct-ready")).toContainText("Ready: both accounts have a usable saved sign-in.");

        // Phone width: no sideways scroll, with the summary and with the form open.
        await page.setViewportSize({ width: 375, height: 800 });
        await card.scrollIntoViewIfNeeded();
        await noOverflow();
        await card.getByRole("button", { name: "Change", exact: true }).click();
        await pwExpect(card.getByTestId("sa-xacct-form")).toBeVisible();
        await noOverflow();
        await axeBoth();
        await card.getByRole("button", { name: "Cancel", exact: true }).click();
        await page.setViewportSize({ width: 1280, height: 900 });

        await card.getByRole("button", { name: "Remove", exact: true }).click();
        await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
        await pwExpect(card).toContainText("Not set up.");
        expect((await apiCall("GET", `/api/v1/security/applications/${appId}/cross-account`)).body.designation).toBeNull();
        expect(consoleErrors).toEqual([]);
    }, 240_000);

    it("a production application says the checks are never made there, and offers no set-up", async () => {
        const r = await apiCall("POST", `/api/v1/security/projects/${projectId}/applications`, { name: "Notes (live)", targetUrl: "http://127.0.0.1:9792/", environment: "production", maxRequestsPerSecond: 2 });
        await page.goto(`${BASE}/#/projects/${projectId}/security/applications/${r.body.application.id}`);
        const card = page.getByTestId("sa-xacct");
        await pwExpect(card.getByTestId("sa-xacct-env")).toContainText("not marked as development or staging");
        await pwExpect(card.getByRole("button", { name: "Set up cross-account checks" })).toHaveCount(0);
    });

    it("an older authorization (no authorizer details) shows the date it stops counting", async () => {
        const store = securityStoreFor(platform.db);
        const auth = await apiCall("POST", `/api/v1/security/applications/${appId}/authorizations`, { basis: "owner", approverName: "Dana Client", approverRole: "Head of Engineering", approverEmail: "dana@client.example", documentReference: "SOW-12", authority: "Signed SOW-12.", confirm: true });
        expect(auth.status, JSON.stringify(auth.body)).toBe(201);
        // Make it an older-style record: no details fingerprint (as recorded before the authorizer details were asked for).
        platform.db.run("UPDATE security_authorizations SET details_fingerprint = NULL WHERE application_id = ?", appId);
        const expiresAt = store.listAuthorizations(appId)[0]!.expiresAt!;
        expect(expiresAt).toBeTruthy();
        await page.goto(`${BASE}/#/projects/${projectId}/security/applications/${appId}`);
        const hint = page.getByTestId("sec-auth-details-missing");
        await pwExpect(hint).toContainText("it stops counting on");
        await pwExpect(hint).toContainText("90 days after the server was updated");
        await pwExpect(page.getByTestId("sec-auth-expires")).not.toHaveText("Not known yet");
        // The same date in both places.
        await pwExpect(hint).toContainText(await page.getByTestId("sec-auth-expires").innerText());
    });
});
