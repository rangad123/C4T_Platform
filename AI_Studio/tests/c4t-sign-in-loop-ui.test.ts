/**
 * A Crowd4Test sign-in that does not reach AI Studio, in a real browser (ports 6872 AI Studio, 6873 a stand-in crowd4test.com):
 * crowd4test.com says the person is signed in and sends them straight back, but no session arrives here. The page goes there twice
 * at most, then says what happened instead of bouncing until the browser gives up with "too many redirects"; Try again goes once
 * more. Requires `web/dist` (vite build).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 6872;
const SITE_PORT = 6873;
const BASE = `http://127.0.0.1:${PORT}`;
let browser: Browser;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let site: http.Server;
let dataDir = "";
/** Each visit to the stand-in's sign-in hand-off. */
const trips: string[] = [];

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the web UI first");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    // crowd4test.com that thinks everyone is signed in: its hand-off sends the visitor straight back, as the real one does. Its API
    // knows no token (no cookie reaches AI Studio here anyway).
    site = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${SITE_PORT}`);
        if (url.pathname === "/app/ai-studio") {
            trips.push(url.searchParams.get("to") ?? "");
            res.writeHead(303, { location: `${BASE}/#${url.searchParams.get("to") ?? "/"}`, "cache-control": "no-store" });
            return res.end();
        }
        res.writeHead(url.pathname === "/v1/auth/me" ? 401 : 200, { "content-type": "application/json" });
        res.end("{}");
    });
    await new Promise<void>((r) => site.listen(SITE_PORT, "127.0.0.1", r));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-c4t-loop-ui-"));
    platform = bootstrap(
        loadConfig({
            DATA_DIR: dataDir,
            HOST: "127.0.0.1",
            PORT: String(PORT),
            SCHEDULER_ENABLED: "false",
            WORKER_EMBEDDED: "false",
            SECRET_KEY: "c4t-loop-ui-secret-key-0123456789",
            C4T_API_ORIGIN: `http://127.0.0.1:${SITE_PORT}`,
            C4T_SITE_URL: `http://127.0.0.1:${SITE_PORT}`,
        }),
    );
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    await new Promise((r) => site?.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("a Crowd4Test sign-in that does not arrive", () => {
    it("goes to crowd4test.com twice at most, then says so; Try again goes once more", async () => {
        const page = await (await browser.newContext()).newPage();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto(`${BASE}/#/projects`);
        const heading = page.getByRole("heading", { name: "Your Crowd4Test sign-in didn’t reach AI Studio" });
        await pwExpect(heading).toBeVisible({ timeout: 15_000 });
        expect(trips).toEqual(["/projects", "/projects"]);
        await pwExpect(page.getByText("Sign out on crowd4test.com and sign in again", { exact: false })).toBeVisible();
        await pwExpect(page.getByRole("link", { name: "Go to your Crowd4Test portal" })).toHaveAttribute("href", `http://127.0.0.1:${SITE_PORT}/app`);
        // It stays put: no more trips while the message is on screen.
        await page.waitForTimeout(1_500);
        expect(trips).toHaveLength(2);

        // Try again starts a fresh count: one trip there and back, then the next stops again.
        await page.getByRole("button", { name: "Try again" }).click();
        await pwExpect(heading).toBeVisible({ timeout: 15_000 });
        expect(trips.length).toBeGreaterThanOrEqual(3);
        expect(trips.length).toBeLessThanOrEqual(4);
        expect(errors).toEqual([]);
    });
});
