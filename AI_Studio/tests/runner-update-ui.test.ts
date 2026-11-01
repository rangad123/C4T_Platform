/**
 * Runner updates on the runner's row, in a real browser against the real platform: runners report their update state through the real
 * hello route, the platform serves a prebuilt bundle of another version (a small stand-in bundle with a real manifest), and the row says
 * what is happening in plain words. The "Update automatically" switch and "Update this runner" call the real routes (recorded in Activity).
 * A runner started from the project folder shows nothing about updates (its row is unchanged). Keyboard, phone width, axe in light and dark.
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/runner-update-ui.test.ts
 * Port 6975.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 6975;
const BASE = `http://127.0.0.1:${PORT}`;
const savedKitDir = process.env.RUNNER_KIT_DIR;

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let dataDir: string;
let projectId = "";
let latest = "";
const OLD = "9.1.0+aaaaaaaaaa";

const api = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined } as { status: number; body: any };
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    process.env.AGENT_MAX_TOKENS = "25"; // this file gives one project several runners
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-upd-ui-"));
    // The platform's runner bundle: version 9.2.0 (stand-in program files, a real manifest the platform checks).
    const bundle = path.join(dataDir, "bundle");
    fs.mkdirSync(bundle);
    const files = ["runner.mjs", "task-child.mjs", "record-child.mjs", "package.json", "LICENSES.txt"].map((name) => {
        const text = name === "package.json" ? "{}\n" : `// ${name} 9.2.0\n`;
        fs.writeFileSync(path.join(bundle, name), text);
        return { name, bytes: Buffer.byteLength(text), sha256: sha(text) };
    });
    const hash = sha(files.map((f) => `${f.name}\0${f.sha256}\n`).join(""));
    latest = `9.2.0+${hash.slice(0, 10)}`;
    fs.writeFileSync(path.join(bundle, "manifest.json"), JSON.stringify({ format: 1, platformVersion: "9.2.0", hash, kitVersion: latest, nodeMin: 24, files }));
    process.env.RUNNER_KIT_DIR = bundle;

    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "upd-ui-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    projectId = (await api("POST", "/api/projects", { name: "Updates UI project" })).body.id;
    // The browser first: the runners' hellos come last, so they are still online (seen in the last 45 s) while the test clicks.
    browser = await chromium.launch();
    const hello = async (name: string, extra: Record<string, unknown>) => {
        const secret = (await api("POST", `/api/projects/${projectId}/agent-tokens`, { label: name })).body.secret as string;
        const r = await api("POST", "/api/agent/hello", { protocol: 1, name, version: "1.0.0", concurrency: 1, capabilities: { os: "win32", arch: "x64", node: "v24.19.0", browsers: ["chromium"], ...extra } }, { authorization: `Bearer ${secret}` });
        expect(r.status).toBe(200);
        return r.body as { agentId: string; update?: { version: string } };
    };
    const updating = await hello("Updating laptop", { kitVersion: OLD, update: { can: true, state: "preparing", from: OLD, to: latest } });
    // The hello answer itself carries the offer for a runner that can update.
    expect(updating.update?.version).toBe(latest);
    await hello("Stuck laptop", { kitVersion: OLD, update: { can: true, state: "failed", to: latest, error: "The file runner.mjs of the update arrived damaged (its size or checksum does not match what the platform announced). Nothing was changed.", at: new Date().toISOString(), retryAt: new Date(Date.now() + 5 * 60_000).toISOString() } });
    await hello("Desk PC", { kitVersion: OLD, update: { can: true, state: "idle" } });
    await hello("Old download", { kitVersion: OLD });
    await hello("Checkout runner", {});
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    if (savedKitDir === undefined) delete process.env.RUNNER_KIT_DIR;
    else process.env.RUNNER_KIT_DIR = savedKitDir;
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

const words = (v: string) => v.replace("+", " (") + ")";

describe("runner updates on the runner's row", () => {
    it("says what each runner is doing about its update, lets an owner switch it off and ask for one, and records both", async () => {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        try {
            await page.goto(`${BASE}/#/projects/${projectId}/runners`);
            const row = (name: string) => page.locator("[data-agent]").filter({ has: page.getByRole("heading", { name, exact: true }) });
            await row("Updating laptop").waitFor({ timeout: 30_000 });
            await expect(row("Updating laptop").getByTestId("agent-update-status").textContent()).resolves.toBe(`Updating to version ${words(latest)}: downloading and checking. It takes no new tests until it has restarted.`);
            await expect(row("Stuck laptop").getByTestId("agent-update-status").textContent()).resolves.toBe(
                `Could not update: The file runner.mjs of the update arrived damaged (its size or checksum does not match what the platform announced). Nothing was changed. Still on version ${words(OLD)}. It tries again in 5 min.`,
            );
            await expect(row("Old download").getByTestId("agent-update-status").textContent()).resolves.toMatch(/This runner cannot update itself .* Download a new runner to get updates\.$/);
            expect(await row("Old download").getByRole("checkbox").count()).toBe(0);
            expect(await row("Checkout runner").getByTestId("agent-update").count()).toBe(0);

            const desk = row("Desk PC");
            await expect(desk.getByTestId("agent-update-status").textContent()).resolves.toBe(`Version ${words(latest)} is available. It updates between tests.`);
            const auto = desk.getByRole("checkbox", { name: /Update automatically/ });
            expect(await auto.isChecked()).toBe(true);
            expect(await desk.getByRole("button", { name: /Update Desk PC/ }).count()).toBe(0);
            // Keyboard: the switch is reachable and toggles with Space.
            await auto.focus();
            await page.keyboard.press("Space");
            await desk.getByText("Automatic updates are off for this runner.").waitFor();
            expect(await auto.isChecked()).toBe(false);
            const button = desk.getByRole("button", { name: `Update Desk PC to version ${words(latest)}` });
            await button.click();
            await desk.getByRole("button", { name: /Update asked for/ }).waitFor();
            expect(await desk.getByRole("button", { name: /Update asked for/ }).isDisabled()).toBe(true);

            const agents = (await api("GET", `/api/projects/${projectId}/agents`)).body as Array<{ name: string; update?: Record<string, unknown> }>;
            expect(agents.find((a) => a.name === "Desk PC")!.update).toMatchObject({ can: true, auto: false, requested: true, outOfDate: true, latest });
            expect(agents.find((a) => a.name === "Checkout runner")!.update).toBeUndefined();
            const activity = (await api("GET", `/api/activity?project=${projectId}`)).body.activity as Array<{ action: string }>;
            expect(activity.map((r) => r.action)).toEqual(expect.arrayContaining(["PUT /api/projects/:id/agents/:agentId/updates", "POST /api/projects/:id/agents/:agentId/update"]));
        } finally {
            await page.close();
        }
    }, 120_000);

    it("has large targets, no sideways scroll at phone width, and no accessibility violations in light and dark", async () => {
        const context = await browser.newContext({ viewport: { width: 375, height: 800 } });
        const page = await context.newPage();
        try {
            await page.goto(`${BASE}/#/projects/${projectId}/runners`);
            await page.getByTestId("agent-update-status").first().waitFor({ timeout: 30_000 });
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
            for (const label of await page.locator(".ag-update label.check").all()) expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(44);
            for (const scheme of ["light", "dark"] as const) {
                await page.emulateMedia({ colorScheme: scheme });
                await page.waitForTimeout(400);
                const result = await new AxeBuilder({ page }).include(".ag-update").analyze();
                expect(result.violations.map((v) => `${scheme} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
            }
        } finally {
            await context.close();
        }
    }, 120_000);
});
