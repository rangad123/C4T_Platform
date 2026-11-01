/**
 * AI configuration in a real browser against the built page and a real platform (port 7827), with a stand-in Crowd4Test sign-in (7828) and
 * a stand-in provider (7829): no real provider is called. The platform is set up like the hosted preview: no server key, no worker. A
 * customer adds a key in global Settings and tests it; chooses it in project settings; a bad key says plainly that it did not work; a tester
 * sees only whether AI is available. Light-mode accessibility of both pages. Requires `web/dist` (vite build).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { resetKeyTests } from "../src/platform/routes/ai-config.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 7827;
const C4T_PORT = 7828;
const PROVIDER_PORT = 7829;
const BASE = `http://127.0.0.1:${PORT}`;
const GOOD = "ORG-ui-key-sentinel-1234";
const BAD = "BAD-ui-key-sentinel-9999";

const user = (id: string, role: string, permissions: readonly string[], organisationId: string | null) => ({ data: { user: { id, email: `${id}@people.example`, role, status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions, organisationId } } });
const ACCOUNTS: Record<string, unknown> = { "t-cora": user("cora", "CUSTOMER", PERMISSIONS, "org-a"), "t-tim": user("tim", "TESTER", ["ai_studio.access"], null) };

let browser: Browser;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let c4t: http.Server;
let provider: http.Server;
let dir = "";
let cora: Page;
let projectId = "";

const pageFor = async (token: string) => {
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "c4t_access", value: token, url: BASE }]);
    return ctx.newPage();
};
const axe = async (page: Page) => {
    const r = await new AxeBuilder({ page }).disableRules(["color-contrast"]).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    c4t = http.createServer((req, res) => {
        const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        res.writeHead(ACCOUNTS[auth] ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ACCOUNTS[auth] ?? { error: { message: "Invalid access token" } }));
    });
    await new Promise<void>((r) => c4t.listen(C4T_PORT, "127.0.0.1", r));
    provider = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.setHeader("content-type", "application/json");
            if (String(req.headers.authorization).includes("BAD")) {
                res.statusCode = 401;
                return res.end(JSON.stringify({ error: { message: "Invalid API key", code: "invalid_api_key" } }));
            }
            res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } }));
        });
    });
    await new Promise<void>((r) => provider.listen(PROVIDER_PORT, "127.0.0.1", r));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-aiconfig-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: "ai-config-ui-key-1", SECRET_KEY: "ai-config-ui-secret-0123456789", C4T_API_ORIGIN: `http://127.0.0.1:${C4T_PORT}`, C4T_SITE_URL: "https://crowd4test.example", WEB_DIST: path.join(REPO_ROOT, "web/dist") } as never));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    browser = await chromium.launch();
    cora = await pageFor("t-cora");
    await cora.goto(BASE);
    projectId = await cora.evaluate(async () => {
        const r = await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "ai-studio" }, body: JSON.stringify({ name: "Shop" }) });
        return (await r.json()).id as string;
    });
    const tim = (await server.inject({ method: "GET", url: "/api/auth/state", headers: { cookie: "c4t_access=t-tim" } })).json().me.id;
    accessControlOf(server).projects.store.addMember(projectId, tim, { role: "owner", projectAdmin: false, source: "added", addedBy: "test" } as never);
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    await new Promise((r) => c4t?.close(r));
    await new Promise((r) => provider?.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
});

const fill = async (page: Page, prefix: string, label: string, key: string) => {
    const form = page.getByTestId(`${prefix}-form`);
    await form.getByLabel("Name").fill(label);
    await form.getByLabel("Provider").selectOption({ label: "Custom endpoint" });
    await form.getByLabel("Address").fill(`http://127.0.0.1:${PROVIDER_PORT}/v1`);
    await form.getByLabel("Model", { exact: true }).fill("stand-in-model");
    await form.getByLabel("Key", { exact: true }).fill(key);
    await form.getByRole("button", { name: "Save configuration" }).click();
};

describe("global Settings: the organisation's configurations", () => {
    it("says what the hosted preview cannot do, adds a key, never shows it again, and tests it for real", async () => {
        await cora.goto(`${BASE}/#/settings`);
        const card = cora.getByTestId("ai-configurations");
        await pwExpect(card.getByText("This server has no AI key of its own")).toBeVisible();
        await pwExpect(card.getByText("AI work does not run on this server")).toBeVisible();
        await card.getByRole("button", { name: "Add a configuration" }).click();
        await fill(cora, "ai-config-new", "Team key", GOOD);
        const row = card.getByTestId("ai-configuration");
        await pwExpect(row.getByText("Not tested yet")).toBeVisible();
        await pwExpect(row.getByText("1234", { exact: true })).toBeVisible();
        expect(await cora.content()).not.toContain(GOOD);
        await row.getByRole("button", { name: "Test this key: Team key" }).click();
        await pwExpect(row.getByText("The key works")).toBeVisible();
        await pwExpect(row.getByText(/It worked: stand-in-model answered/)).toBeVisible();
        await pwExpect(row.getByText("Working", { exact: true })).toBeVisible();
        await axe(cora);
    });
});

describe("project settings: AI configuration", () => {
    it("chooses who pays and the key, and says plainly when a key does not work", async () => {
        resetKeyTests();
        await cora.goto(`${BASE}/#/projects/${projectId}/settings?section=ai`);
        const ai = cora.getByTestId("project-ai");
        await pwExpect(ai.getByTestId("project-ai-available").getByText("Not available", { exact: true })).toBeVisible();
        await pwExpect(ai.getByText("This server has no AI key of its own")).toBeVisible();
        await pwExpect(ai.getByText("AI work does not run on this server: nothing here")).toBeVisible();
        await pwExpect(ai.getByTestId("project-ai-budget").getByText(/no monthly limit/)).toBeVisible();

        const choice = ai.getByTestId("project-ai-choice");
        await choice.getByLabel(/Our own key/).check();
        await pwExpect(choice.getByLabel("Configuration")).toContainText("Team key");
        await choice.getByRole("button", { name: "Save" }).click();
        await pwExpect(choice.getByText("Saved. This project now uses its own key.")).toBeVisible();
        await pwExpect(choice.getByTestId("key-status").getByText("Working", { exact: true })).toBeVisible();
        await axe(cora);

        await choice.getByRole("button", { name: "Add a key for this project" }).click();
        await fill(cora, "project-ai-new", "Broken key", BAD);
        await pwExpect(choice.getByText("Saved. This project now uses its own key.")).toBeVisible();
        const status = choice.getByTestId("key-status");
        await pwExpect(status.getByText("Not tested yet")).toBeVisible();
        await status.getByRole("button", { name: "Test this key: Broken key" }).click();
        await pwExpect(status.getByText("The key did not work")).toBeVisible();
        await pwExpect(status.getByText(/The provider refused this key/)).toBeVisible();
        await pwExpect(status.getByText("Not working", { exact: true })).toBeVisible();
        expect(await cora.content()).not.toContain(BAD);
        // A key that does not work: nobody is told AI is available.
        await pwExpect(ai.getByTestId("project-ai-available").getByText("Not available", { exact: true })).toBeVisible();

        // Back to managed: the page says who pays, and the own key stays listed for later.
        await choice.getByLabel(/managed AI/).check();
        await choice.getByRole("button", { name: "Save" }).click();
        await pwExpect(choice.getByText("Saved. This project now uses Crowd4Test’s managed AI.")).toBeVisible();
    });

    it("shows a tester only whether AI is available", async () => {
        const tim = await pageFor("t-tim");
        await tim.goto(`${BASE}/#/projects/${projectId}/settings?section=ai`);
        const ai = tim.getByTestId("project-ai");
        await pwExpect(ai.getByTestId("project-ai-available")).toBeVisible();
        await pwExpect(ai.getByText(/not available for this project/i)).toBeVisible();
        for (const hidden of ["project-ai-choice", "project-ai-who-pays", "project-ai-budget"]) await pwExpect(ai.getByTestId(hidden)).toHaveCount(0);
        await pwExpect(ai.getByText(/ending in|tokens|Who pays/)).toHaveCount(0);
        await tim.goto(`${BASE}/#/settings`);
        await pwExpect(tim.getByRole("heading", { name: "Settings" })).toBeVisible();
        await pwExpect(tim.getByTestId("ai-configurations")).toHaveCount(0);
        await tim.context().close();
    });
});
