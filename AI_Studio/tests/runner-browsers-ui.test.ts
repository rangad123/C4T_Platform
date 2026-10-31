/**
 * Which browser a runner used, on screen: the run details say "Ran in Microsoft Edge 155, installed on maya-laptop.", the runner's card
 * says which browser its web tests run in, and its details list the Chrome and Edge it found (with why one is not used). Accessible in
 * light and dark, no sideways scroll at phone width. A real platform and the real UI bundle; a FAKE AGENT (plain protocol calls) stands
 * in for the runner.
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/runner-browsers-ui.test.ts
 * Port: platform 6936.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { defaultCaps, FakeAgent, passedRun, viaFetch } from "./fixtures/fake-agent.js";

const PORT = 6936;
const BASE = `http://127.0.0.1:${PORT}`;
const APP = "http://127.0.0.1:6937";
const EDGE = { name: "msedge" as const, version: "155.0.4283.62", source: "installed" as const };

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let browser: Browser;
let page: Page;
let projectId: string;
let jobId: string;
const saved = { poll: process.env.AGENT_POLL_SECONDS, watch: process.env.AGENT_WATCH_MS };

const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: /^[{[]/.test(text) ? JSON.parse(text) : text } as { status: number; body: any };
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(process.cwd(), "web", "dist", "index.html"))) throw new Error("Build the UI first: node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web");
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_WATCH_MS: "50" });
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-browsers-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, HOST: "127.0.0.1", PORT: String(PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });

    projectId = (await call("POST", "/api/projects", { name: "Browser shop" })).body.id;
    const secret = (await call("POST", `/api/projects/${projectId}/agent-tokens`, { label: "maya-laptop" })).body.secret as string;
    const agent = new FakeAgent(viaFetch(BASE), secret, {
        name: "maya-laptop",
        capabilities: defaultCaps({ os: "win32", browsers: ["chromium"], browser: EDGE, installedBrowsers: [{ name: "chrome", version: "120.0.6099.71", usable: false, reason: "Google Chrome 120 is too old: the test tools need version 150 or newer" }, { name: "msedge", version: EDGE.version, usable: true }] }),
    });
    expect((await agent.hello()).status).toBe(200);
    getAgentServices(platform).store.setRunner(projectId, { runOn: "agent", agentId: null });
    // One run on the runner whose result names its browser.
    const app = platform.repo.createApplication(projectId, APP, { ...DEFAULT_JOB_OPTIONS }, undefined);
    const job = await platform.repo.createJob(projectId, app, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] });
    jobId = job.id;
    const pending = getAgentServices(platform).executorFor({ projectId, jobId }).execute("playwright", { scratchDir: path.join(dataDir, "scratch"), scripts: [{ testId: "WEB-001", filename: "WEB-001.spec.ts", content: "// script" }] }, { run: { baseUrl: APP, headless: true } }, { workers: 1 });
    const offer = (await agent.next())!;
    expect((await agent.result(offer.taskId, { ok: true, runs: [passedRun("WEB-001")], browser: EDGE })).status).toBe(200);
    await pending;
    platform.repo.setJobStatus(jobId, "COMPLETED");

    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    if (saved.poll === undefined) delete process.env.AGENT_POLL_SECONDS;
    else process.env.AGENT_POLL_SECONDS = saved.poll;
    if (saved.watch === undefined) delete process.env.AGENT_WATCH_MS;
    else process.env.AGENT_WATCH_MS = saved.watch;
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const axe = async () => {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(400);
        const r = await new AxeBuilder({ page }).analyze();
        expect(r.violations.map((v) => `${scheme}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
};
const noSidewaysScroll = async () => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
};

describe("the browser a runner used, on screen", () => {
    it("the run details say which browser the run used, and where it came from", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/runs/${jobId}`);
        const facts = page.getByRole("region", { name: "About this run" });
        await pwExpect(facts.getByTestId("run-browser")).toHaveText("Ran in Microsoft Edge 155, installed on maya-laptop.");
        await pwExpect(facts.getByText("On maya-laptop", { exact: true })).toBeVisible();
        await axe();
        await noSidewaysScroll();
    });

    it("the runner's card says which browser its web tests run in, and its details list what it found", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/runners`);
        await page.reload();
        const card = page.locator(".ag-agent", { hasText: "maya-laptop" });
        await pwExpect(card.getByTestId("agent-browser")).toHaveText("Web tests run in Microsoft Edge 155, installed on maya-laptop.");
        await card.getByRole("button", { name: "Show details for maya-laptop" }).click();
        const found = card.getByRole("list", { name: "Browsers found on maya-laptop" });
        await pwExpect(found.getByRole("listitem")).toHaveText(["Google Chrome 120, not used: Google Chrome 120 is too old: the test tools need version 150 or newer", "Microsoft Edge 155, used for web tests"]);
        await axe();
        await noSidewaysScroll();
    });
});
