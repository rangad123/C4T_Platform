/**
 * "Check this computer" on screen (docs/features/runner-check.md): the runner's row says "2 things need a look" with the lines, Show details
 * lists every line, a runner whose check is all fine shows no note, and the Add a runner panel's last step says to double-click
 * check-computer. Accessible in light and dark, no sideways scroll at phone width. A real platform and the real UI bundle; a FAKE AGENT
 * (plain protocol calls) stands in for the runner.
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/runner-check-ui.test.ts
 * Port: platform 6938.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunnerCheck } from "../src/agent-protocol/schema.js";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { defaultCaps, FakeAgent, viaFetch } from "./fixtures/fake-agent.js";
// @ts-expect-error plain JavaScript build script (no type declarations)
import { buildRunner } from "../scripts/build-runner.mjs";

const PORT = 6938;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "Chk-Ui-Pr0xy-Secret";

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let tmp: string;
let browser: Browser;
let page: Page;
let projectId: string;
const saved = { kit: process.env.RUNNER_KIT_DIR, installer: process.env.RUNNER_INSTALLER_DIR, complete: process.env.RUNNER_COMPLETE_DIR };

const CHECK: RunnerCheck = {
    at: new Date(Date.now() - 5 * 60_000).toISOString(),
    items: [
        { id: "node", status: "ok", title: "Node.js v24.19.0, came with this download" },
        { id: "files", status: "ok", title: "Runner files match this download (version 0.1.0+0fde81ee6f)" },
        { id: "browser", status: "ok", title: "Web tests use Microsoft Edge 155, installed on this computer" },
        { id: "engines", status: "optional", title: "Firefox and WebKit are not here yet (only runs on other browsers need them)", fix: "Nothing to do: the runner downloads them when such a run arrives." },
        // A sign-in that slipped into a line is masked by the platform before the page sees it.
        { id: "network", status: "ok", title: `Network: connects through the proxy http://maya:${PASSWORD}@proxy.corp.test:8080, from HTTPS_PROXY / HTTP_PROXY` },
        { id: "disk", status: "missing", title: "Only 0.4 GB free on the disk that holds the runner's folder: it needs at least 1 GB", fix: "Free some space, then start the runner again." },
        { id: "clock", status: "missing", title: "This computer's clock is 3 hours ahead of the platform's: a clock that far off breaks https connections", fix: "Set the date and time to be set automatically, then run this check again." },
    ],
};

const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: /^[{[]/.test(text) ? JSON.parse(text) : text } as { status: number; body: any };
};

beforeAll(async () => {
    if (!fs.existsSync(path.join(process.cwd(), "web", "dist", "index.html"))) throw new Error("Build the UI first: node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web");
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-check-ui-"));
    await buildRunner({ outDir: path.join(tmp, "bundle") });
    // Plain files only: no installer and no complete download on this server. Two runners on one project: above the default limit of one.
    Object.assign(process.env, { RUNNER_KIT_DIR: path.join(tmp, "bundle"), RUNNER_INSTALLER_DIR: path.join(tmp, "no-installer"), RUNNER_COMPLETE_DIR: path.join(tmp, "no-complete"), AGENT_MAX_TOKENS: "25" });
    platform = bootstrap(loadConfig({ DATA_DIR: path.join(tmp, "data"), HOST: "127.0.0.1", PORT: String(PORT), PUBLIC_URL: BASE }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    projectId = (await call("POST", "/api/projects", { name: "Check shop" })).body.id;
    for (const [name, check] of [["maya-laptop", CHECK], ["office-pc", { at: CHECK.at, items: CHECK.items.filter((i) => i.status !== "missing") }]] as const) {
        const secret = (await call("POST", `/api/projects/${projectId}/agent-tokens`, { label: name })).body.secret as string;
        const agent = new FakeAgent(viaFetch(BASE), secret, { name, capabilities: { ...defaultCaps({ os: "win32", browsers: ["chromium"] }), check } as never });
        expect((await agent.hello()).status).toBe(200);
    }
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    for (const [k, v] of [["RUNNER_KIT_DIR", saved.kit], ["RUNNER_INSTALLER_DIR", saved.installer], ["RUNNER_COMPLETE_DIR", saved.complete]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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

describe("the computer check on screen", () => {
    it("the platform passes the check through with a sign-in masked", async () => {
        const list = (await call("GET", `/api/projects/${projectId}/agents`)).body as Array<{ name: string; capabilities: { check?: RunnerCheck } }>;
        const maya = list.find((a) => a.name === "maya-laptop")!.capabilities.check!;
        expect(maya.items).toHaveLength(7);
        expect(maya.items.find((i) => i.id === "network")!.title).toBe("Network: connects through the proxy http://maya:***@proxy.corp.test:8080, from HTTPS_PROXY / HTTP_PROXY");
        expect(JSON.stringify(list)).not.toContain(PASSWORD);
    });

    it("the runner's row says how many things need a look, with each line and its fix; Show details lists every line; a fine runner shows no note", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/runners`);
        await page.reload();
        const card = page.locator(".ag-agent", { hasText: "maya-laptop" });
        const note = card.getByRole("group", { name: "Computer check for maya-laptop" });
        await pwExpect(note).toContainText("2 things need a look on this computer, checked when the runner started");
        await pwExpect(note.getByRole("listitem")).toHaveText([
            "Only 0.4 GB free on the disk that holds the runner's folder: it needs at least 1 GB. To fix: Free some space, then start the runner again.",
            "This computer's clock is 3 hours ahead of the platform's: a clock that far off breaks https connections. To fix: Set the date and time to be set automatically, then run this check again.",
        ]);
        await pwExpect(page.locator(".ag-agent", { hasText: "office-pc" }).getByTestId("agent-check")).toHaveCount(0);
        await card.getByRole("button", { name: "Show details for maya-laptop" }).click();
        const all = card.getByTestId("agent-check-all");
        await pwExpect(all.getByRole("listitem")).toHaveCount(7);
        await pwExpect(all.locator("li[data-status=optional]")).toHaveText(["OptionalFirefox and WebKit are not here yet (only runs on other browsers need them). Nothing to do: the runner downloads them when such a run arrives."]);
        await pwExpect(page.locator("body")).not.toContainText(PASSWORD);
        await axe();
        await noSidewaysScroll();
    });

    it("the Add a runner panel's last step says to double-click check-computer when the runner does not connect", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/settings?section=runners`);
        await page.reload();
        await page.getByRole("button", { name: "Add a runner", exact: true }).click();
        const panel = page.getByRole("region", { name: "Add a runner", exact: true });
        await panel.getByRole("radio", { name: /Windows/ }).check();
        await panel.getByLabel("Name", { exact: true }).fill("Front desk");
        await panel.getByRole("button", { name: "Continue", exact: true }).click();
        await Promise.all([page.waitForEvent("download"), panel.getByRole("button", { name: "Download runner", exact: true }).click()]);
        await panel.getByRole("button", { name: "Continue", exact: true }).click();
        await pwExpect(panel.getByText("Step 3 of 3")).toBeVisible();
        const help = panel.getByTestId("kit-check-help");
        await pwExpect(help).toHaveText("If it does not connect, double-click check-computer.cmd in the same folder. It checks this computer and says what to fix, and changes nothing.");
        await pwExpect(help.locator("b")).toHaveText("check-computer.cmd");
        await axe();
        await noSidewaysScroll();
    });
});
