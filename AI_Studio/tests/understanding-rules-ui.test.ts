/**
 * Rules to confirm and the analysis inputs on the Requirements tab of an AI agent project, in a real browser against a real platform
 * (port 9751, no AI): each waiting rule with its source, how sure the analysis is, its evidence and its workflow (with a short line when
 * that workflow is only inferred); a rule whose evidence is gone; confirming and rejecting; a refusal shown as its sentence; adding a
 * database schema file and a version label, with the server's refusals shown as sentences; and a person who may only look sees no
 * buttons. Light-mode accessibility of the page. Requires `web/dist` (vite build).
 *
 *   TAQWRIGHT_HOME=/nonexistent-taqwright node scripts/with-lock.mjs build,browser -- sh -c "npx vite build web && npx vitest run tests/understanding-rules-ui.test.ts"
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { AppIntelStore } from "../src/platform/app-intel-store.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { hashPassword } from "../src/platform/auth/password.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { ONLY_A_PERSON, RULE_CHANGED } from "../src/platform/routes/app-intel.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 9751;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "understanding-rules-ui-key-8c02";
const EVIDENCE_GONE = "A later reading no longer found what this rule was based on. Check that it still holds.";
const INFERRED_WORKFLOW = "Tests use this rule once the workflow is stated in a requirements document.";
let browser: Browser;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let intel: AppIntelStore;
let dataDir = "";
let shop = "";
let fresh = "";
const ids: Record<string, string> = {};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-understanding-rules-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY: KEY, HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    shop = platform.repo.createProject({ name: "Agent shop", platforms: ["web"], testingModes: ["agent"] }).id as string;
    platform.repo.createApplication(shop, "https://shop.example/", {} as never);
    fresh = platform.repo.createProject({ name: "New shop", platforms: ["web"], testingModes: ["agent"] }).id as string;

    intel = new AppIntelStore(platform.sql);
    const v = await intel.addVersion({
        projectId: shop,
        model: {
            pages: [{ id: "cart", path: "/cart" }],
            workflows: [
                { id: "checkout", name: "Check out a cart", sourceType: "requirement", evidence: [{ kind: "quote", ref: "Requirements line 4" }] },
                { id: "browse", name: "Browse the catalogue", sourceType: "inferred", evidence: [{ kind: "page", ref: "/" }] },
            ],
        },
    });
    const add = async (ref: string, extra: object) =>
        (ids[ref] = (await intel.addRule(shop, { ref, kind: "constraint", confidence: 0.8, ...extra }, { modelVersionId: v.id })).id);
    await add("R-1", {
        description: "A cart holds at most 50 items",
        expected: "Adding a 51st item is refused with a message",
        sourceType: "requirement",
        sourceRef: "Requirements line 7",
        evidence: [{ kind: "quote", ref: "Requirements line 7", excerpt: "A cart holds at most 50 items." }],
        explicitness: "explicit",
        workflows: ["browse"],
    });
    await add("R-2", { description: "Totals include tax", expected: "The total shows tax included", sourceType: "inferred", explicitness: "inferred", confidence: 0.55, workflows: ["checkout"] });
    await add("R-3", { description: "Guests cannot check out", expected: "Checkout asks a guest to sign in", sourceType: "requirement", sourceRef: "Requirements line 9", explicitness: "explicit" });
    await intel.decide(shop, ids["R-3"]!, "confirmed", "someone");
    await intel.markEvidenceGone(shop, ids["R-3"]!, 2);
    await add("R-4", { description: "Prices are never negative", expected: "No price below zero", sourceType: "inferred", explicitness: "inferred" });

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

describe("rules to confirm and inputs for the analysis", () => {
    let page: Page;
    const list = () => page.getByRole("list", { name: "Rules to confirm" });
    const rule = (name: string) => page.getByRole("article", { name });

    it("lists each waiting rule with its source, how sure, evidence and workflow, and a rule whose evidence is gone", async () => {
        page = await signIn("olga@example.com", "olga's long password");
        await page.goto(`${BASE}/#/projects/${shop}/requirements`);
        await pwExpect(page.getByRole("heading", { name: "Rules to confirm" })).toBeVisible();
        await pwExpect(list().getByRole("article")).toHaveCount(4);
        const cart = rule("A cart holds at most 50 items");
        await pwExpect(cart).toContainText("Stated by a source");
        await pwExpect(cart).toContainText("Expected: Adding a 51st item is refused with a message");
        await pwExpect(cart).toContainText("From: Requirements (Requirements line 7) · How sure: 80%");
        await pwExpect(cart.getByRole("list", { name: "Evidence" })).toContainText("A cart holds at most 50 items.");
        await pwExpect(cart.getByTestId("rule-workflow")).toHaveText(`Workflow: Browse the catalogue. ${INFERRED_WORKFLOW}`);
        const tax = rule("Totals include tax");
        await pwExpect(tax).toContainText("Inferred");
        await pwExpect(tax).toContainText("From: Worked out by the AI · How sure: 55%");
        await pwExpect(tax.getByTestId("rule-workflow")).toHaveText("Workflow: Check out a cart.");
        const gone = rule("Guests cannot check out");
        await pwExpect(gone).toContainText("Evidence gone");
        await pwExpect(gone).toContainText("Confirmed");
        await pwExpect(gone.getByTestId("evidence-gone")).toHaveText(EVIDENCE_GONE);
        await pwExpect(gone.getByRole("button", { name: "Undo the decision" })).toBeVisible();
        const text = (await page.getByTestId("rules-to-confirm").textContent()) ?? "";
        for (const internal of ["R-1", "unverified", "user_confirmed", "inferred,", ids["R-1"]!]) expect(text).not.toContain(internal);
        expect(await axeClean(page)).toEqual([]);
    });

    it("confirms one rule and rejects another, and the server keeps both decisions", async () => {
        await rule("A cart holds at most 50 items").getByRole("button", { name: "Confirm" }).click();
        await pwExpect(rule("A cart holds at most 50 items")).toHaveCount(0);
        expect((await intel.rule(shop, ids["R-1"]!))!.status).toBe("confirmed");
        await rule("Totals include tax").getByRole("button", { name: "Reject" }).click();
        await pwExpect(rule("Totals include tax")).toHaveCount(0);
        expect((await intel.rule(shop, ids["R-2"]!))!.status).toBe("rejected");
    });

    it("keeps the wording a person decided about, says how a later analysis reworded it, and Undo takes the new wording", async () => {
        // A later analysis words the confirmed rule differently (same rule: same kind, expectation and links).
        await intel.addRule(shop, { ref: "R-1", kind: "constraint", confidence: 0.8, description: "A cart takes no more than 50 items", expected: "Adding a 51st item is refused with a message", sourceType: "requirement", sourceRef: "Requirements line 7", evidence: [{ kind: "quote", ref: "Requirements line 7", excerpt: "A cart holds at most 50 items." }], explicitness: "explicit", workflows: ["browse"] });
        await page.reload();
        const decided = rule("A cart holds at most 50 items");
        await pwExpect(decided).toContainText("Confirmed");
        await pwExpect(decided.getByTestId("rule-reworded")).toHaveText("Reworded since you decided: A cart takes no more than 50 items");
        await decided.getByRole("button", { name: "Undo the decision" }).click();
        await pwExpect(rule("A cart takes no more than 50 items").getByRole("button", { name: "Confirm" })).toBeVisible();
        await pwExpect(page.getByTestId("rule-reworded")).toHaveCount(0);
        expect((await intel.rule(shop, ids["R-1"]!))!).toMatchObject({ status: "unverified", description: "A cart takes no more than 50 items" });
    });

    it("shows a refused decision as its sentence", async () => {
        await page.route(`**/api/projects/${shop}/intel/rules/*/decision`, (route) => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: ONLY_A_PERSON }) }));
        await rule("Prices are never negative").getByRole("button", { name: "Confirm" }).click();
        await pwExpect(rule("Prices are never negative").getByTestId("rule-error")).toHaveText(ONLY_A_PERSON);
        await page.unrouteAll();
        expect((await intel.rule(shop, ids["R-4"]!))!.status).toBe("unverified");
    });

    it("says when a rule changed since it was read, decides nothing and shows the rule as it is now", async () => {
        // A later analysis reworded what the rule expects after the page was loaded.
        await intel.addRule(shop, { ref: "R-4", kind: "constraint", confidence: 0.8, description: "Prices are never negative", expected: "Every price is zero or more", sourceType: "inferred", explicitness: "inferred" });
        const prices = rule("Prices are never negative");
        await pwExpect(prices).toContainText("Expected: No price below zero");
        await prices.getByRole("button", { name: "Confirm" }).click();
        await pwExpect(prices.getByTestId("rule-error")).toHaveText(RULE_CHANGED);
        await pwExpect(prices).toContainText("Expected: Every price is zero or more");
        expect((await intel.rule(shop, ids["R-4"]!))!.status).toBe("unverified");
    });

    it("adds a database schema file, says why one is refused, and removes it", async () => {
        const inputs = page.getByTestId("source-inputs");
        await inputs.locator("#schema-file").setInputFiles({ name: "shop.sql", mimeType: "text/plain", buffer: Buffer.from("CREATE TABLE orders (id INT PRIMARY KEY, total INT NOT NULL);\n") });
        await inputs.getByRole("button", { name: "Add schema file" }).click();
        await pwExpect(inputs.getByRole("list", { name: "Database schema files" })).toContainText("shop.sql");
        expect((await intel.sources(shop)).filter((s) => s.kind === "db_schema").map((s) => s.ref)).toEqual(["shop.sql"]);
        await inputs.locator("#schema-file").setInputFiles({ name: "huge.sql", mimeType: "text/plain", buffer: Buffer.alloc(1024 * 1024 + 1, 65) });
        await inputs.getByRole("button", { name: "Add schema file" }).click();
        await pwExpect(inputs.getByTestId("source-inputs-error")).toHaveText("A schema file is at most 1 MB.");
        await inputs.getByRole("button", { name: "Remove shop.sql" }).click();
        await pwExpect(inputs.getByText("None yet.", { exact: false })).toBeVisible();
        expect((await intel.sources(shop)).filter((s) => s.kind === "db_schema")).toEqual([]);
    });

    it("saves a version label, and says why when there is no analysis to label", async () => {
        const inputs = page.getByTestId("source-inputs");
        await inputs.getByLabel("Version label").fill("3.0.0");
        await inputs.getByRole("button", { name: "Save label" }).click();
        await pwExpect(inputs.getByText("Version label saved.")).toBeVisible();
        expect((await intel.latest(shop))!.appVersion).toMatchObject({ source: "person", label: "3.0.0" });

        await page.goto(`${BASE}/#/projects/${fresh}/requirements`);
        const other = page.getByTestId("source-inputs");
        await other.getByLabel("Version label").fill("1.0");
        await other.getByRole("button", { name: "Save label" }).click();
        await pwExpect(other.getByTestId("source-inputs-error")).toHaveText("There is nothing to label yet. Read the application first.");
        await pwExpect(page.getByRole("heading", { name: "Rules to confirm" })).toHaveCount(0);
        expect(await axeClean(page)).toEqual([]);
    });

    it("shows a person who may only look the rules and inputs without any button", async () => {
        const vic = await signIn("vic@example.com", "vic's long password");
        await vic.goto(`${BASE}/#/projects/${shop}/requirements`);
        await pwExpect(vic.getByRole("article", { name: "Prices are never negative" })).toBeVisible();
        for (const name of ["Confirm", "Reject", "Undo the decision", "Add schema file", "Save label", "Choose a schema file"]) await pwExpect(vic.getByRole("button", { name })).toHaveCount(0);
        await pwExpect(vic.getByTestId("source-inputs")).toContainText("The latest reading describes version 3.0.0.");
    });
});
