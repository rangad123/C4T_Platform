/**
 * The runner's network on its card, in a real browser against the real platform: a runner that reports a proxy and a network problem
 * (through the real hello route) shows the problem on its row and the proxy under Show details, with the password masked; a runner
 * that reports nothing shows neither (an older runner's card is unchanged).
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/company-network-ui.test.ts
 * Port 6977.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 6977;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "Pr0xy-S3cret-NETui";

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let dataDir: string;
let projectId = "";

const api = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined } as { status: number; body: any };
};

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-net-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "net-ui-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    projectId = (await api("POST", "/api/projects", { name: "Net UI project" })).body.id;
    const hello = async (name: string, network?: unknown) => {
        const secret = (await api("POST", `/api/projects/${projectId}/agent-tokens`, { label: name })).body.secret as string;
        const r = await api("POST", "/api/agent/hello", { protocol: 1, name, version: "1.0.0", concurrency: 1, capabilities: { os: "win32", arch: "x64", node: "v24.19.0", browsers: ["chromium"], ...(network ? { network } : {}) } }, { authorization: `Bearer ${secret}` });
        expect(r.status).toBe(200);
    };
    await hello("Office laptop", { proxy: "proxy.corp.test:8080", proxySource: "windows", certificates: ["system"], problem: `Could not reach platform.test: the proxy http://maya:${PASSWORD}@proxy.corp.test:8080 asks for a user name and password (HTTP 407).`, problemAt: new Date(Date.now() - 5 * 60_000).toISOString() });
    await hello("Old runner");
    browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

describe("the runner's network on its card", () => {
    it("shows the last problem on the row and the proxy under Show details, never the password; an older runner shows neither", async () => {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        try {
            await page.goto(`${BASE}/#/projects/${projectId}/runners`);
            const office = page.locator('[data-agent]').filter({ has: page.getByRole("heading", { name: "Office laptop", exact: true }) });
            await office.waitFor({ timeout: 30_000 });
            await expect(office.getByTestId("agent-network-problem").textContent()).resolves.toMatch(/^Network problem 5 min ago: Could not reach platform\.test: the proxy http:\/\/maya:\*\*\*@proxy\.corp\.test:8080 asks for a user name and password \(HTTP 407\)\.$/);
            await office.getByRole("button", { name: "Show details for Office laptop" }).click();
            await expect(office.getByTestId("agent-network").textContent()).resolves.toBe("Connects through the proxy proxy.corp.test:8080, from the Windows proxy setting. Tests reach the application directly. Also trusts this computer's certificates.");
            expect(await page.content()).not.toContain(PASSWORD);

            const old = page.locator('[data-agent]').filter({ has: page.getByRole("heading", { name: "Old runner", exact: true }) });
            await old.getByRole("button", { name: "Show details for Old runner" }).click();
            expect(await old.getByTestId("agent-network").count()).toBe(0);
            expect(await old.getByTestId("agent-network-problem").count()).toBe(0);
            // Phone width: no sideways scroll with the long sentence on the card.
            await page.setViewportSize({ width: 375, height: 800 });
            await page.waitForTimeout(200);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        } finally {
            await page.close();
        }
    }, 120_000);
});
