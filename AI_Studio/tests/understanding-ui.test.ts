/**
 * Application understanding on the Dashboard of an AI agent project, in a real browser against a real platform (port 9750, no AI):
 * what the latest analysis found (pages, workflows, endpoints, rules by kind), its sources with a failed one's sentence, what is
 * missing, when it ran and which version it describes; "Read again" for a person who may change tests, hidden for one who may
 * only look; a refusal shown as its sentence; and a code project without the section. Light-mode accessibility of the page.
 * Requires `web/dist` (vite build).
 *
 *   TAQWRIGHT_HOME=/nonexistent-taqwright node scripts/with-lock.mjs build,browser -- sh -c "npx vite build web && npx vitest run tests/understanding-ui.test.ts"
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { ANALYSIS_RUNNING } from "../src/platform/app-analysis.js";
import { AppIntelStore } from "../src/platform/app-intel-store.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { hashPassword } from "../src/platform/auth/password.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 9750;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "understanding-ui-key-5b31";
const SITE = "https://shop.example/";
const MISSING = "No API description: 2 observed endpoints have no response schema. Add the OpenAPI document to fill them in.";
const SCHEMA_FAILED = "The schema file has no CREATE TABLE statement or Prisma model.";
let browser: Browser;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir = "";
let shop = "";
let codeProject = "";

const page1 = (id: string, p: string) => ({ id, path: p });
const seen = (p: string) => [{ kind: "page" as const, ref: p }];

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-understanding-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY: KEY, HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    shop = platform.repo.createProject({ name: "Agent shop", platforms: ["web"], testingModes: ["agent"] }).id as string;
    platform.repo.createApplication(shop, SITE, {} as never);
    codeProject = platform.repo.createProject({ name: "Code shop", platforms: ["web"], testingModes: ["code"] }).id as string;

    const intel = new AppIntelStore(platform.sql);
    const v = await intel.addVersion({
        projectId: shop,
        appVersion: { source: "person", label: "2.4.1", analysedAt: new Date().toISOString() },
        model: {
            pages: [page1("home", "/"), page1("cart", "/cart"), page1("checkout", "/checkout")],
            workflows: [
                { id: "checkout", name: "Check out a cart", sourceType: "requirement", evidence: [{ kind: "quote", ref: "Requirements line 4" }] },
                { id: "browse", name: "Browse the catalogue", sourceType: "inferred", evidence: seen("/") },
            ],
            endpoints: [
                { method: "GET", path: "/api/cart", origin: "observed", evidence: [{ kind: "request", ref: "GET /api/cart" }] },
                { method: "POST", path: "/api/orders", origin: "observed", evidence: [{ kind: "request", ref: "POST /api/orders" }] },
            ],
            missingContext: [{ text: MISSING, source: "openapi" }],
        },
    });
    await intel.upsertSource(shop, { kind: "exploration", ref: SITE, status: "processed", fingerprint: "a1", modelVersionId: v.id });
    await intel.upsertSource(shop, { kind: "db_schema", ref: "shop-schema.sql", status: "failed", error: SCHEMA_FAILED });
    const rule = (ref: string, sourceType: string, extra: object = {}) => ({
        ref,
        kind: "constraint",
        description: `Rule ${ref}`,
        expected: `Expected ${ref}`,
        sourceType,
        sourceRef: sourceType === "requirement" ? "Requirements line 7" : "",
        evidence: sourceType === "requirement" ? [{ kind: "quote", ref: "Requirements line 7", excerpt: "A cart holds at most 50 items." }] : [],
        explicitness: sourceType === "requirement" ? "explicit" : "inferred",
        confidence: 0.8,
        ...extra,
    });
    await intel.addRule(shop, rule("R-1", "requirement"), { modelVersionId: v.id });
    await intel.addRule(shop, rule("R-2", "inferred"), { modelVersionId: v.id });
    const r3 = await intel.addRule(shop, rule("R-3", "requirement"), { modelVersionId: v.id });
    await intel.decide(shop, r3.id, "confirmed", "someone");

    const users = accessControlOf(server).users;
    const olga = users.create({ email: "olga@example.com", name: "Olga Owner", role: "owner" });
    users.setPassword(olga.id, await hashPassword("olga's long password"));
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

const axeClean = async (page: Page) => {
    const r = await new AxeBuilder({ page }).analyze();
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
};

describe("application understanding on the Dashboard", () => {
    let page: Page;

    it("shows what the latest analysis found, its sources, what is missing, when it ran and the version", async () => {
        page = await signIn("olga@example.com", "olga's long password");
        await page.goto(`${BASE}/#/projects/${shop}`);
        const card = page.getByRole("region", { name: "Application understanding" });
        await pwExpect(card.getByRole("heading", { name: "Application understanding" })).toBeVisible();
        await pwExpect(card.getByTestId("understanding-status")).toContainText("Last read");
        await pwExpect(card.getByTestId("understanding-status")).toContainText("version 2.4.1");
        await pwExpect(card.getByTestId("understanding-counts")).toHaveText(/3\s*Pages.*2\s*Workflows.*2\s*Endpoints.*3\s*Rules/s);
        await pwExpect(card.getByTestId("understanding-rules")).toHaveText("2 stated by a source, 1 inferred; 2 waiting for a person to confirm.");
        const sources = card.getByTestId("understanding-sources");
        await pwExpect(sources.getByRole("listitem")).toHaveCount(2);
        await pwExpect(sources.getByRole("listitem").filter({ hasText: "Exploring the application" })).toContainText("Processed");
        const failed = sources.getByRole("listitem").filter({ hasText: "Database schema file" });
        await pwExpect(failed).toContainText("shop-schema.sql");
        await pwExpect(failed).toContainText("Failed");
        await pwExpect(failed).toContainText(SCHEMA_FAILED);
        await pwExpect(card.getByTestId("understanding-missing")).toHaveText(MISSING);
        // Plain words only: no internal ids or source names.
        const text = (await card.textContent()) ?? "";
        for (const internal of ["db_schema", "exploration", "R-1", "user_confirmed", "unverified", shop]) expect(text).not.toContain(internal);
        await pwExpect(card.getByRole("button", { name: "Read again" })).toBeVisible();
        expect(await axeClean(page)).toEqual([]);
    });

    it("starts reading again with Read again", async () => {
        const card = page.getByRole("region", { name: "Application understanding" });
        const sent = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${shop}/intel/analyse`) && r.request().method() === "POST");
        await card.getByRole("button", { name: "Read again" }).click();
        expect((await sent).status()).toBe(202);
        await pwExpect(card.getByTestId("understanding-error")).toHaveCount(0);
    });

    it("shows a refusal as its sentence, without leaving the page", async () => {
        await page.route(`**/api/projects/${shop}/intel/analyse`, (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: ANALYSIS_RUNNING }) }));
        await page.route(`**/api/projects/${shop}/intel/sources`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sources: [], running: null, last: null }) }));
        await page.reload();
        const card = page.getByRole("region", { name: "Application understanding" });
        await card.getByRole("button", { name: "Read again" }).click();
        await pwExpect(card.getByTestId("understanding-error")).toHaveText(ANALYSIS_RUNNING);
        await pwExpect(page.getByRole("heading", { name: "Agent shop" })).toBeVisible();
        await page.unrouteAll();
    });

    it("leaves Read again out for a person who may only look", async () => {
        const vic = await signIn("vic@example.com", "vic's long password");
        await vic.goto(`${BASE}/#/projects/${shop}`);
        const card = vic.getByRole("region", { name: "Application understanding" });
        await pwExpect(card.getByTestId("understanding-counts")).toBeVisible();
        await pwExpect(card.getByRole("button", { name: "Read again" })).toHaveCount(0);
        await pwExpect(card.getByRole("button", { name: "Stop" })).toHaveCount(0);
    });

    it("is not on a code project's Dashboard", async () => {
        await page.goto(`${BASE}/#/projects/${codeProject}`);
        await pwExpect(page.getByRole("heading", { name: "Code shop" })).toBeVisible();
        await pwExpect(page.getByTestId("code-empty")).toBeVisible();
        await pwExpect(page.getByRole("region", { name: "Application understanding" })).toHaveCount(0);
    });
});
