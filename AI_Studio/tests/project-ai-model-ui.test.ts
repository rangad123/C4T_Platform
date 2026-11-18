/**
 * A project's AI model in a real browser against the built page and a real platform (port 7946), with a stand-in Crowd4Test sign-in (7947).
 * Project Settings, General: the list holds only the models of the AI keys the person looking may use, empty is each person's default, a
 * refusal shows as its sentence, and a person without "Change project settings" sees it read-only. No AI provider is called. Requires
 * `web/dist`.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { aiConfigStore, PROJECT_MODEL_NOT_YOURS } from "../src/platform/ai-config.js";
import { PERMISSIONS } from "../src/platform/auth/permissions.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 7946;
const C4T_PORT = 7947;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS_DIR;

const user = (id: string, role: string, permissions: readonly string[], organisationId: string | null) => ({ data: { user: { id, email: `${id}@people.example`, role, status: "ACTIVE", firstName: id, lastName: "Person", emailVerified: true, permissions, organisationId } } });
const ACCOUNTS: Record<string, unknown> = {
    "t-cora": user("cora", "CUSTOMER", PERMISSIONS, "org-a"),
    "t-vic": user("vic", "CUSTOMER", PERMISSIONS.filter((c) => c !== "ai_studio.project.settings"), "org-a"),
};

let browser: Browser;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let c4t: http.Server;
let dir = "";
let pid = "";
const contexts: BrowserContext[] = [];

const pageFor = async (token: string) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    contexts.push(ctx);
    await ctx.addCookies([{ name: "c4t_access", value: token, url: BASE }]);
    return ctx.newPage();
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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-project-ai-model-ui-"));
    platform = bootstrap(
        loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: "project-ai-model-ui-key-1", SECRET_KEY: "project-ai-model-ui-secret-0123456789", C4T_API_ORIGIN: `http://127.0.0.1:${C4T_PORT}`, C4T_SITE_URL: "https://crowd4test.example", WEB_DIST: path.join(REPO_ROOT, "web/dist") } as never),
    );
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    browser = await chromium.launch();
    const ids: Record<string, string> = {};
    for (const t of Object.keys(ACCOUNTS)) ids[t] = JSON.parse((await server.inject({ method: "GET", url: "/api/auth/state", headers: { cookie: `c4t_access=${t}` } })).body).me.id;
    pid = JSON.parse((await server.inject({ method: "POST", url: "/api/projects", headers: { cookie: "c4t_access=t-cora", "x-requested-with": "ai-studio" }, payload: { name: "Model project" } })).body).id;
    const added = await server.inject({ method: "POST", url: `/api/projects/${pid}/members`, headers: { cookie: "c4t_access=t-cora", "x-requested-with": "ai-studio" }, payload: { personId: ids["t-vic"] } });
    expect(added.statusCode, added.body).toBe(201);
    const store = aiConfigStore({ sql: platform.sql, config: platform.config });
    for (const [label, model] of [["Main", "model-main"], ["Quick", "model-quick"]] as const) {
        const k = await store.create({ kind: "personal", ownerPersonId: ids["t-cora"]!, label, provider: "openai-compatible", model, baseUrl: "https://llm.example/v1", apiKey: `UI-key-${label}-0000`, createdBy: "test" });
        if (label === "Main") await store.setChosen(ids["t-cora"]!, k.id);
    }
}, 120_000);

afterAll(async () => {
    for (const c of contexts) await c.close().catch(() => undefined);
    await browser?.close();
    await server?.close();
    platform?.db.close();
    await new Promise((r) => c4t?.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("Project Settings, General: AI model", () => {
    it("lists only the person's own models, saves one, and shows a refusal as its sentence", async () => {
        const page = await pageFor("t-cora");
        await page.goto(`${BASE}/#/projects/${pid}/settings`);
        const card = page.getByTestId("project-ai-model");
        await pwExpect(card.getByRole("heading", { name: "AI model" })).toBeVisible();
        const select = card.getByLabel("AI model");
        await pwExpect(select).toHaveValue("");
        expect(await select.locator("option").allTextContents()).toEqual(["Each person’s default AI key", "Custom endpoint, model-main", "Custom endpoint, model-quick"]);
        const save = card.getByRole("button", { name: "Save" });
        await pwExpect(save).toBeDisabled();
        await select.selectOption({ label: "Custom endpoint, model-quick" });
        await save.click();
        await pwExpect(card.getByText("Saved.")).toBeVisible();
        expect(platform.db.get("SELECT ai_provider, ai_model FROM projects WHERE id = ?", pid)).toEqual({ ai_provider: "openai-compatible", ai_model: "model-quick" });
        if (SHOTS) await card.screenshot({ path: path.join(SHOTS, "project-ai-model-saved.png") });
        // The key behind a choice is removed while the page is open: saving it again is refused, and the page shows the server's sentence.
        await page.reload();
        await select.selectOption({ label: "Custom endpoint, model-main" });
        platform.db.run("DELETE FROM ai_configurations WHERE model = 'model-main'");
        await save.click();
        await pwExpect(card.getByText(PROJECT_MODEL_NOT_YOURS)).toBeVisible();
        if (SHOTS) await card.screenshot({ path: path.join(SHOTS, "project-ai-model-refused.png") });
        expect(platform.db.get("SELECT ai_model FROM projects WHERE id = ?", pid)).toEqual({ ai_model: "model-quick" });
    });

    it("a person who may not change settings sees the model read-only, and one not among their keys is named as such", async () => {
        const page = await pageFor("t-vic");
        await page.goto(`${BASE}/#/projects/${pid}/settings`);
        const card = page.getByTestId("project-ai-model");
        const select = card.getByLabel("AI model");
        await pwExpect(select).toBeDisabled();
        await pwExpect(select.locator("option:checked")).toHaveText("model-quick (not one of your AI keys)");
        await pwExpect(card.getByText("Changing this needs “Change project settings”.")).toBeVisible();
        await pwExpect(card.getByRole("button", { name: "Save" })).toHaveCount(0);
        await pwExpect(card.getByText("You have no AI keys with a model to choose. Add one in Settings, AI keys.")).toBeVisible();
        if (SHOTS) await card.screenshot({ path: path.join(SHOTS, "project-ai-model-read-only.png") });
    });
});
