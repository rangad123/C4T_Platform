/**
 * The test mailbox form when its server changes: the saved IMAP password is only sent to the server it was entered for, so the
 * form says by the password field that it is needed again and Save waits for it; the same server keeps it. Against a real platform
 * (port 8661). Requires `web/dist` (vite build).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 8661;
const BASE = `http://localhost:${PORT}`;
let browser: Browser;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir = "";
let projectId = "";

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-mailbox-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT), SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    projectId = platform.repo.createProject({ name: "Mailbox shop" }).id as string;
    const r = await server.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/mailbox`,
        headers: { "x-requested-with": "ai-studio" },
        payload: { kind: "imap", imap: { host: "imap.example.com", port: 993, tls: true, user: "qa@example.com", password: "mailbox-secret-1" } },
    });
    if (r.statusCode !== 200) throw new Error(`mailbox: ${r.statusCode} ${r.body}`);
    browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("the test mailbox form", () => {
    it("asks for the password again by the field when the server changes, and keeps it for the same server", async () => {
        const page = await (await browser.newContext()).newPage();
        await page.goto(`${BASE}/#/projects/${projectId}/settings?section=accounts`);
        await pwExpect(page.getByRole("heading", { name: "Test mailbox", exact: true })).toBeVisible();
        const save = page.getByRole("button", { name: "Save the mailbox" });
        const pass = page.getByLabel("Password", { exact: true });
        const again = "Enter the password again: the saved one is only sent to the server it was entered for.";
        await pwExpect(pass).toHaveAttribute("placeholder", "Saved — leave empty to keep");
        await pwExpect(save).toBeEnabled();

        await page.getByLabel("Server").fill("imap.elsewhere.example");
        await pwExpect(page.getByText(again)).toBeVisible();
        await pwExpect(pass).toHaveAccessibleDescription(again);
        await pwExpect(save).toBeDisabled();
        await pass.fill("mailbox-secret-2");
        await pwExpect(save).toBeEnabled();
        await pass.fill("");

        // Back to the saved server, with TLS turned off: still a different place to send the password.
        await page.getByLabel("Server").fill("imap.example.com");
        await pwExpect(page.getByText(again)).toHaveCount(0);
        await page.getByLabel(/Use TLS/).uncheck();
        await pwExpect(page.getByText(again)).toBeVisible();
        await pwExpect(save).toBeDisabled();
        await page.context().close();
    });
});
