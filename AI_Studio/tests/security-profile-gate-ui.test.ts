/**
 * The profile gate through the screens, against the real platform (open mode, no Crowd4Test sign-in: the viewer acts as an owner): the
 * authorization form offers "The most it allows" and its statement follows the choice (worded by the server); the application page says
 * plainly that nobody can approve here (only a Crowd4Test admin approves, and this server has no Crowd4Test sign-in) and offers no
 * approval form; the new-assessment page offers a profile and shows the server's refusal sentence as it is; axe in light and dark; 375 px
 * without sideways scroll. Nothing above passive starts. (Approval by a Crowd4Test admin is proven through the API in
 * security-profile-gate.test.ts.)
 *
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/security-profile-gate-ui.test.ts
 * Port: platform 9531.
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
import { GATE_WORDS } from "../src/security/profile-gate.js";

const PORT = 9531;
const BASE = `http://127.0.0.1:${PORT}`;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let page: Page;
let dataDir: string;
let projectId: string;
let appId: string;

const api = async (method: string, url: string, body?: unknown) => {
    const r = await fetch(`${BASE}${url}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};

async function axeBoth() {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(400);
        const r = await new AxeBuilder({ page }).analyze();
        expect(r.violations.map((v) => `${scheme} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), page.url()).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: null });
}

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sec-gate-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    projectId = (await api("POST", "/api/projects", { name: "Gate client" })).json.id;
    expect((await api("PUT", `/api/v1/security/projects/${projectId}/testing-type`, { testingType: "both" })).status).toBe(200);
    const created = await api("POST", `/api/v1/security/projects/${projectId}/applications`, { name: "Shop staging", targetUrl: "https://staging.shop.example.com/", environment: "staging", maxRequestsPerSecond: 2 });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    appId = created.json.application.id;
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("the profile gate on the security screens", () => {
    it("records an authorization that allows a profile above passive, with the server's statement for that choice", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/security/applications/${appId}?authorize=1`);
        const form = page.getByTestId("sec-auth-form");
        await pwExpect(form).toBeVisible();
        await pwExpect(page.getByTestId("sec-statement")).toContainText("The assessment is passive");
        await form.getByRole("radio", { name: /^Conservative active checks/ }).check();
        await pwExpect(page.getByTestId("sec-statement")).toContainText("may run at most the Conservative active checks profile");
        await form.getByLabel("Authorized by").fill("Dana Client");
        await form.getByLabel("Their role").fill("Head of Engineering");
        await form.getByLabel("Their email").fill("dana@client.example");
        await form.getByLabel("Permission document").fill("SOW-12");
        await form.getByLabel("Their authority to permit testing").fill("Signed SOW-12 for the owner.");
        await form.getByRole("checkbox", { name: /I confirm the statement above/ }).check();
        await axeBoth();
        await form.getByRole("button", { name: "Record authorization", exact: true }).click();
        await pwExpect(page.getByTestId("sec-auth-max")).toHaveText("Conservative active checks");
        const stored = (await api("GET", `/api/v1/security/applications/${appId}/authorizations`)).json.authorizations[0];
        expect(stored.maxProfile).toBe("conservative-active");
        expect(stored.statement).toMatch(/may run at most the Conservative active checks profile/);
    });

    it("lists approvals, offers no approval form, and says plainly that nobody can approve without Crowd4Test sign-in", async () => {
        const panel = page.getByTestId("sec-approvals");
        await pwExpect(panel).toContainText("Only passive assessments start on this server");
        await pwExpect(panel).toContainText("No profile above passive is approved");
        await pwExpect(page.getByTestId("sec-approve-refusal")).toHaveText(GATE_WORDS.noCrowd4Test);
        await pwExpect(panel.getByRole("button", { name: "Approve a profile" })).toHaveCount(0);
        expect((await api("POST", `/api/v1/security/applications/${appId}/approvals`, { profile: "conservative-active", confirm: true })).json.error).toBe(GATE_WORDS.noCrowd4Test);
        await axeBoth();
    });

    it("the new-assessment page offers the profile and shows the server's refusal as it is; nothing starts", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/security/new?app=${appId}`);
        await page.getByLabel("Profile", { exact: true }).selectOption("conservative-active");
        await page.getByRole("button", { name: "Start assessment", exact: true }).click();
        await pwExpect(page.getByText(GATE_WORDS.noCrowd4Test)).toBeVisible();
        expect((await api("GET", `/api/v1/security/projects/${projectId}/assessments`)).json.assessments).toEqual([]);
        await axeBoth();
    });

    it("phone width: no sideways scroll on the application page", async () => {
        await page.setViewportSize({ width: 375, height: 800 });
        await page.goto(`${BASE}/#/projects/${projectId}/security/applications/${appId}`);
        await pwExpect(page.getByTestId("sec-approvals")).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBe(0);
    });
});
