/**
 * The Runners tab in a real browser: what a runner agent is, creating a token (shown once), the connected agents with their
 * devices, choosing where the project's tests run, and the lines on the Tests, test and Runs pages.
 *
 * The platform underneath is real (a seeded project and tests, the real UI bundle). The admin API for tokens, agents and the
 * runner choice is a small in-memory stand-in that follows .scratch/briefs/AGENT-API-SHAPES.md, served by a front server
 * that forwards everything else to the platform. It exists so this file does not depend on the platform half landing.
 * Ports: 8106 front (the address the browser uses), 8107 platform.
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/agents-ui.test.ts
 * Set AH_SHOTS=<folder> to also write screenshots (empty, token just created, connected; light and dark; 1280 and 390 wide).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { addTest, seedProject, seedRun, type Seed } from "./fixtures/dashboard-seed.js";

const FRONT_PORT = 8106;
const PLATFORM_PORT = 8107;
const BASE = `http://127.0.0.1:${FRONT_PORT}`;

// ── the stand-in admin API ──────────────────────────────────────────────────

interface FakeToken { id: string; label: string | null; hint: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }
interface FakeAgent {
    id: string; name: string; version: string; tokenId: string; os: "win32" | "darwin" | "linux"; arch: string; node: string; online: boolean;
    lastSeenAt: string; firstSeenAt: string; activeTasks: number; concurrency: number; capabilities: Record<string, unknown>;
}
const fake = {
    tokens: [] as FakeToken[],
    agents: [] as FakeAgent[],
    runner: { runOn: "platform" as "platform" | "agent", agentId: null as string | null },
    jobRunning: false,
    ranOn: null as null | { kind: "agent"; agentId: string; name: string },
    /** false: the front only forwards, and the real platform answers the admin API. */
    enabled: true,
    seq: 0,
    secrets: [] as string[],
    /** The per-project runner limit the platform reports (one by default; these older tests show the UI with room for more). */
    maxRunners: 25,
};
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function resetFake() {
    Object.assign(fake, { tokens: [], agents: [], runner: { runOn: "platform", agentId: null }, jobRunning: false, ranOn: null, secrets: [], maxRunners: 25 });
}

const MAYA = (): FakeAgent => ({
    id: "ag-maya", name: "Maya’s laptop", version: "1.0.0", tokenId: "tok-1", os: "darwin", arch: "arm64", node: "v22.11.0", online: true,
    lastSeenAt: iso(3_000), firstSeenAt: iso(86_400_000 * 3), activeTasks: 1, concurrency: 2,
    capabilities: {
        browsers: ["chromium", "firefox", "webkit"],
        android: { adb: true, devices: [{ serial: "emulator-5554", model: "Pixel 6", state: "device", emulator: true }, { serial: "R5CT123ABC", model: "Galaxy S21", state: "device", emulator: false }], avds: ["Pixel_6_API_34"] },
        ios: { xcode: true, simulators: ["iPhone 15"] },
        windows: { winappdriver: false },
    },
});
const BUILD = (): FakeAgent => ({
    id: "ag-build", name: "Build server", version: "1.0.0", tokenId: "tok-2", os: "linux", arch: "x64", node: "v22.9.0", online: false,
    lastSeenAt: iso(10 * 60_000), firstSeenAt: iso(86_400_000 * 9), activeTasks: 0, concurrency: 1, capabilities: { browsers: ["chromium"] },
});

function runnerView() {
    const a = fake.agents.find((x) => x.id === fake.runner.agentId);
    if (fake.runner.runOn === "platform" || !a) return { runOn: "platform", agentId: null, status: "Runs on this server.", canRunWeb: true, canRunMobile: false, unavailableReason: null };
    const web = a.online && (a.capabilities.browsers as string[]).length > 0;
    return {
        runOn: "agent", agentId: a.id, status: `Runs on ${a.name} (${a.online ? "online" : "offline"}).`, canRunWeb: web,
        canRunMobile: a.online && !!a.capabilities.android,
        unavailableReason: !a.online ? `${a.name} is offline.` : !web ? "This agent has no browsers installed." : null,
    };
}

async function front(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", BASE);
    const p = url.pathname;
    const method = req.method ?? "GET";
    const json = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
    };
    let m: RegExpMatchArray | null;
    if (!fake.enabled) return forward(req, res, body, url);

    if (/^\/api\/projects\/[^/]+\/runner-kits\/info$/.test(p) && method === "GET") {
        return json(200, { available: true, platformUrl: BASE, urlOk: true, nodeMin: 24, maxRunners: fake.maxRunners, activeRunners: fake.tokens.filter((t) => !t.revokedAt).length });
    }
    if ((m = p.match(/^\/api\/projects\/[^/]+\/agent-tokens$/))) {
        if (method === "GET") return json(200, [...fake.tokens].reverse());
        if (method === "POST") {
            const label = (JSON.parse(body.toString() || "{}") as { label?: string }).label ?? null;
            const secret = `aitg_${Buffer.from(`secret-${++fake.seq}-${Date.now()}`).toString("hex").slice(0, 40)}`;
            fake.secrets.push(secret);
            const token: FakeToken = { id: `tok-${fake.seq}`, label, hint: `aitg_…${secret.slice(-4)}`, createdAt: iso(0), lastUsedAt: null, revokedAt: null };
            fake.tokens.push(token);
            return json(201, { token, secret });
        }
    }
    if ((m = p.match(/^\/api\/projects\/[^/]+\/agent-tokens\/([^/]+)$/)) && method === "DELETE") {
        const t = fake.tokens.find((x) => x.id === m![1]);
        if (!t) return json(404, { error: "That token does not exist." });
        t.revokedAt = iso(0);
        return json(200, { ok: true });
    }
    if (/^\/api\/projects\/[^/]+\/agents$/.test(p) && method === "GET") return json(200, [...fake.agents].sort((a, b) => Number(b.online) - Number(a.online)));
    if (/^\/api\/projects\/[^/]+\/runner$/.test(p)) {
        if (method === "GET") return json(200, runnerView());
        if (method === "PUT") {
            const b = JSON.parse(body.toString() || "{}") as { runOn: "platform" | "agent"; agentId?: string | null };
            if (fake.jobRunning) return json(409, { error: "A run is in progress for this project. Wait for it to finish, then change where tests run." });
            if (b.runOn === "agent") {
                const a = fake.agents.find((x) => x.id === b.agentId);
                if (!a || !a.online) return json(409, { error: fake.agents.some((x) => x.online) ? "That agent is offline. Choose one that is online." : "No agent is online. Start an agent with a token, then try again." });
            }
            fake.runner = { runOn: b.runOn, agentId: b.runOn === "agent" ? (b.agentId ?? null) : null };
            return json(200, runnerView());
        }
    }
    if (/^\/api\/tests\/[^/]+\/validate$/.test(p) && method === "POST") return json(202, { jobId: "job-fake-agent" });
    if (p === "/api/test-generation/job-fake-agent") {
        return json(200, { jobId: "job-fake-agent", status: "COMPLETED", mode: "validate", progress: {}, counters: {}, error: null, createdAt: iso(2000), startedAt: iso(1500), finishedAt: iso(100), ...(fake.ranOn ? { ranOn: fake.ranOn } : { ranOn: { kind: "platform" } }) });
    }

    return forward(req, res, body, url);
}

/** Everything the stand-in does not answer goes to the real platform. The jobs list gets the two small additions the platform half provides. */
async function forward(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer, url: URL) {
    const p = url.pathname;
    const method = req.method ?? "GET";
    const json = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
    };
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "connection", "content-length"].includes(k)) headers[k] = v;
    const upstream = await fetch(`http://127.0.0.1:${PLATFORM_PORT}${req.url}`, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : new Uint8Array(body) });
    const buf = Buffer.from(await upstream.arrayBuffer());
    const type = upstream.headers.get("content-type") ?? "application/octet-stream";
    if (/^\/api\/projects\/[^/]+\/jobs$/.test(p) && method === "GET") {
        const jobs = JSON.parse(buf.toString()) as Array<Record<string, unknown>>;
        for (const j of jobs) if (fake.ranOn && j.mode === "validate") j.ranOn = fake.ranOn;
        if (fake.jobRunning) jobs.unshift({ jobId: "job-running", projectId: "x", status: "VALIDATING", mode: "validate", progress: {}, counters: {}, error: null, createdAt: iso(1000), startedAt: iso(900), finishedAt: null });
        return json(200, jobs);
    }
    res.writeHead(upstream.status, { "content-type": type }).end(buf);
}

// ── harness ─────────────────────────────────────────────────────────────────

let browser: Browser;
let context: BrowserContext;
let page: Page;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let frontServer: http.Server;
let dataDir: string;
let seed: Seed;
let projectId: string;
let testId: string;
const consoleErrors: string[] = [];

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-agents-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    frontServer = http.createServer((req, res) => void front(req, res).catch((e) => res.writeHead(500).end(String(e))));
    await new Promise<void>((r) => frontServer.listen(FRONT_PORT, "127.0.0.1", r));

    seed = seedProject(platform, "Atlas shop", "http://127.0.0.1:5899");
    testId = addTest(platform, seed, "home page");
    addTest(platform, seed, "pricing page");
    await seedRun(platform, seed, { "home page": "pass", "pricing page": "pass" }, { daysAgo: 1 });
    projectId = seed.projectId;

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); // axe-core refuses pages that were not made through a context
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
    page = await context.newPage();
    page.on("console", (m) => {
        // A 409 the page shows on purpose is logged by the browser as a failed load; that is not a page error.
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
}, 120_000);

afterAll(async () => {
    await browser?.close();
    frontServer?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const runnersUrl = () => `${BASE}/#/projects/${projectId}/runners`; // an old address: it lands on the Runners page, open on the project (round 37); its own section and the machine list are both empty
async function open() {
    await page.goto(runnersUrl());
    await page.reload(); // a hash change alone would not re-run the page's loads
    await pwExpect(page.getByRole("heading", { name: "Runners", exact: true })).toBeVisible();
    // The old token-and-command steps are behind "Advanced: start a runner from the project folder" (closed by default). These journeys need them open.
    await pwExpect(page.locator(".skeleton")).toHaveCount(0);
    const add = page.locator("details.ag-add");
    if ((await add.getAttribute("open")) === null) await add.locator("summary").click();
    await pwExpect(add).toHaveAttribute("open", "");
}
const shots = process.env.AH_SHOTS;
async function shot(name: string) {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
}
const section = (name: string) => page.getByRole("region", { name, exact: true });

async function noOverflow() {
    const wide = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".content *"))
            .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !el.closest(".tabs"))
            .slice(0, 5)
            .map((el) => `${el.tagName.toLowerCase()}.${el.className}`),
    );
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect({ overflow, wide }).toEqual({ overflow: 0, wide: [] });
}

async function axe() {
    const result = await new AxeBuilder({ page }).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

// ── journeys ────────────────────────────────────────────────────────────────

describe("Runners tab", () => {
    it("explains the feature and invites one action when nothing is set up", async () => {
        resetFake();
        await page.goto(`${BASE}/#/projects/${projectId}`);
        await pwExpect(page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Settings", exact: true })).toBeVisible();
        await open();
        await pwExpect(page.getByText("A runner is a small program you start on your own computer")).toBeVisible();
        const steps = page.getByRole("list").filter({ hasText: "Create a token." });
        await pwExpect(steps.getByRole("listitem")).toHaveCount(3);
        await pwExpect(page.getByTestId("project-runners").getByText("No runners yet", { exact: true })).toBeVisible();
        await pwExpect(page.getByText("No tokens yet.")).toBeVisible();
        // the command is shown with a placeholder and the page's own address
        await pwExpect(page.getByTestId("agent-command")).toHaveText(`node bin/ai-test-agent.mjs --url ${BASE} --token <your token>`);
        await pwExpect(page.getByText(/needs Node, a checkout of the platform/)).toBeVisible();
        await pwExpect(section("Where this project’s tests run").getByTestId("runner-status")).toHaveText("Runs on this server.");
        await shot("empty-light-1280");
        // the empty state's button opens the guided "Add a runner" panel (its own test file covers the steps)
        await page.getByRole("button", { name: "Add a runner", exact: true }).click();
        await pwExpect(page.getByRole("region", { name: "Add a runner", exact: true })).toBeVisible();
        await pwExpect(page.getByText("Step 1 of 3")).toBeVisible();
    });

    it("has no accessibility violations when empty, in light and dark", async () => {
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.waitForTimeout(400); // colours ease over 140ms when the scheme flips; audit the settled state
            await open();
            await pwExpect(page.getByTestId("project-runners").getByText("No runners yet", { exact: true })).toBeVisible();
            await shot(`empty-${scheme}-1280`);
            await axe();
        }
        await page.emulateMedia({ colorScheme: null });
    });

    it("creates a token that is shown once, with the exact command, and never stored", async () => {
        resetFake();
        await open();
        await page.getByLabel("Name (optional)").fill("Maya’s laptop");
        await page.getByRole("button", { name: "Create token", exact: true }).click();

        const fresh = page.getByRole("region", { name: "Your new token", exact: true });
        await pwExpect(fresh).toBeVisible();
        await pwExpect(fresh).toContainText("We show this only once. Anyone with it can run tests as this project. Revoke it if it leaks.");
        const secret = fake.secrets.at(-1)!;
        expect(secret).toMatch(/^aitg_/);
        const field = fresh.getByLabel("New token", { exact: true });
        await pwExpect(field).toHaveValue(secret);
        expect(await field.evaluate((el) => (el as HTMLInputElement).readOnly)).toBe(true);
        await pwExpect(fresh.getByTestId("agent-command")).toHaveText(`node bin/ai-test-agent.mjs --url ${BASE} --token ${secret}`);

        await fresh.getByRole("button", { name: "Copy token", exact: true }).click();
        await pwExpect(fresh.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret);
        await fresh.getByRole("button", { name: "Copy command", exact: true }).click();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`node bin/ai-test-agent.mjs --url ${BASE} --token ${secret}`);
        await shot("token-created-light-1280");

        // the list shows the label and the fingerprint, not the secret
        const row = page.locator("[data-token]");
        await pwExpect(row).toHaveCount(1);
        await pwExpect(row).toContainText("Maya’s laptop");
        await pwExpect(row).toContainText(`aitg_…${secret.slice(-4)}`);
        await pwExpect(row).toContainText("Active");
        await pwExpect(row).toContainText("Last used never");

        // while it is on screen it is in no storage, address or log
        const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
        expect(stored).not.toContain(secret);
        expect(page.url()).not.toContain(secret);

        // closing the notice removes it from the page entirely, and the command falls back to the placeholder
        await fresh.getByRole("button", { name: "I have copied it", exact: true }).click();
        await pwExpect(fresh).toHaveCount(0);
        await pwExpect(page.getByTestId("agent-command")).toHaveText(`node bin/ai-test-agent.mjs --url ${BASE} --token <your token>`);
        expect(await page.content()).not.toContain(secret);

        // after a reload only the fingerprint is known
        await page.reload();
        await pwExpect(page.locator("[data-token]")).toContainText(`aitg_…${secret.slice(-4)}`);
        expect(await page.content()).not.toContain(secret);
        expect(consoleErrors.join("\n")).not.toContain(secret);
    });

    it("revokes a token only after a confirmation", async () => {
        await open();
        await page.getByRole("button", { name: "Revoke token: Maya’s laptop" }).click();
        const dialog = page.getByRole("dialog", { name: "Revoke this token?" });
        await pwExpect(dialog).toBeVisible();
        await pwExpect(dialog).toContainText("turned away at its next request");
        await dialog.getByRole("button", { name: "Keep token", exact: true }).click();
        await pwExpect(dialog).toHaveCount(0);
        await pwExpect(page.locator("[data-token]")).toContainText("Active");

        await page.getByRole("button", { name: "Revoke token: Maya’s laptop" }).click();
        await page.getByRole("dialog", { name: "Revoke this token?" }).getByRole("button", { name: "Revoke token", exact: true }).click();
        await pwExpect(page.locator("[data-token]")).toContainText("Revoked");
        await pwExpect(page.getByRole("button", { name: /Revoke token:/ })).toHaveCount(0);
        expect(fake.tokens[0]!.revokedAt).not.toBeNull();

        // Escape also leaves the dialog without revoking
        await page.getByLabel("Name (optional)").fill("Second");
        await page.getByRole("button", { name: "Create token", exact: true }).click();
        await page.getByRole("button", { name: "I have copied it", exact: true }).click();
        await page.getByRole("button", { name: "Revoke token: Second" }).click();
        await pwExpect(page.getByRole("dialog", { name: "Revoke this token?" })).toBeVisible();
        await page.keyboard.press("Escape");
        await pwExpect(page.getByRole("dialog")).toHaveCount(0);
        expect(fake.tokens[1]!.revokedAt).toBeNull();
    });

    it("one runner per project: once it exists, Add a runner and Create token give way to a note, and Remove access stays", async () => {
        fake.maxRunners = 1; // the platform's default
        fake.agents = [MAYA()];
        fake.tokens = [{ id: "tok-1", label: "Maya’s laptop", hint: "aitg_…x7Qd", createdAt: iso(86_400_000), lastUsedAt: iso(3000), revokedAt: null }];
        await open();
        await pwExpect(page.getByTestId("runner-limit-note").first()).toContainText("already has a runner");
        await pwExpect(page.getByRole("button", { name: "Add a runner", exact: true })).toHaveCount(0);
        await pwExpect(page.getByTestId("token-limit-note")).toBeVisible();
        await pwExpect(page.getByRole("button", { name: "Create token", exact: true })).toHaveCount(0);
        // Deleting the runner is still one press away.
        await pwExpect(page.getByRole("button", { name: "Remove access for Maya’s laptop" }).first()).toBeVisible();
    });

    it("lists agents with online state, capabilities in words and their devices", async () => {
        fake.agents = [BUILD(), MAYA()];
        await open();
        const list = page.getByRole("list", { name: "Runners", exact: true });
        const rows = list.locator("[data-agent]");
        await pwExpect(rows).toHaveCount(2);
        await pwExpect(rows.nth(0)).toContainText("Maya’s laptop"); // online first
        await pwExpect(rows.nth(0)).toContainText("Online");
        await pwExpect(rows.nth(0)).toContainText("macOS");
        await pwExpect(rows.nth(0)).toContainText("1 of 2 tasks running");
        await pwExpect(rows.nth(0).getByTestId("agent-capabilities")).toHaveText("Chromium, Firefox, WebKit. Android: 2 devices, 1 emulator.");
        await pwExpect(rows.nth(1)).toContainText("Offline");
        await pwExpect(rows.nth(1)).toContainText("10 min ago");
        await pwExpect(rows.nth(1).getByTestId("agent-capabilities")).toHaveText("Chromium.");
        await pwExpect(page.getByText("1 of 2 online")).toBeVisible();

        const maya = rows.nth(0);
        const toggle = maya.getByRole("button", { name: "Show details for Maya’s laptop" });
        await pwExpect(toggle).toHaveAttribute("aria-expanded", "false");
        await toggle.click();
        await pwExpect(maya.getByRole("button", { name: "Hide details for Maya’s laptop" })).toHaveAttribute("aria-expanded", "true");
        const devices = maya.getByRole("list", { name: "Android devices on Maya’s laptop" });
        await pwExpect(devices.getByRole("listitem")).toHaveCount(2);
        await pwExpect(devices.locator("[data-device='emulator-5554']")).toContainText("Pixel 6");
        await pwExpect(devices.locator("[data-device='emulator-5554']")).toContainText("Emulator");
        await pwExpect(devices.locator("[data-device='R5CT123ABC']")).toContainText("Galaxy S21");
        await pwExpect(devices.locator("[data-device='R5CT123ABC']")).toContainText("Phone");
        await pwExpect(devices.locator("[data-device='R5CT123ABC']")).toContainText("Ready");
        await pwExpect(maya).toContainText("Emulators it can start: Pixel_6_API_34");
        await pwExpect(maya).toContainText("Detected (iPhone 15), not supported yet.");
        await pwExpect(maya).toContainText("Not found."); // WinAppDriver is absent
        await pwExpect(maya).toContainText("macOS, arm64, Node 22.11.0");
    });

    it("saves where tests run, and tells you plainly when no agent is online", async () => {
        resetFake();
        fake.agents = [BUILD(), { ...MAYA(), online: false }];
        await open();
        const where = section("Where this project’s tests run");
        await pwExpect(where.getByTestId("runner-status")).toHaveText("Runs on this server.");
        await pwExpect(where.getByRole("button", { name: "Save", exact: true })).toBeDisabled(); // nothing changed yet

        await where.getByRole("radio", { name: /On a runner/ }).check();
        await pwExpect(where.getByText("No runner is online right now.")).toBeVisible();
        const pick = where.getByLabel("Runner", { exact: true });
        await pwExpect(pick.locator("option[disabled]")).toHaveCount(2); // both offline, with the reason in the text
        await pwExpect(pick.locator("option", { hasText: "Build server (offline, last seen 10 min ago)" })).toBeDisabled();
        await where.getByRole("button", { name: "Save", exact: true }).click();
        await pwExpect(where.getByText("No agent is online. Start an agent with a token, then try again.")).toBeVisible();
        expect(fake.runner.runOn).toBe("platform");

        // an agent comes online: the list picks it up, it is chosen by default and the save works
        fake.agents = [BUILD(), MAYA()];
        await open();
        await where.getByRole("radio", { name: /On a runner/ }).check();
        await pwExpect(pick).toHaveValue("ag-maya");
        await pwExpect(pick.locator("option[disabled]")).toHaveCount(1);
        await where.getByRole("button", { name: "Save", exact: true }).click();
        await pwExpect(where.getByTestId("runner-status")).toHaveText("Runs on Maya’s laptop (online).");
        await pwExpect(where.getByText("Web and API tests can run")).toBeVisible();
        await pwExpect(where.getByText("Phone tests can run")).toBeVisible();
        expect(fake.runner).toEqual({ runOn: "agent", agentId: "ag-maya" });

        // back to the server
        await where.getByRole("radio", { name: "On this server" }).check();
        await where.getByRole("button", { name: "Save", exact: true }).click();
        await pwExpect(where.getByTestId("runner-status")).toHaveText("Runs on this server.");
        await pwExpect(where.getByText("Web and API tests can run")).toHaveCount(0);
    });

    it("shows why an agent cannot run tests", async () => {
        fake.agents = [{ ...MAYA(), capabilities: { browsers: [] } }];
        fake.runner = { runOn: "agent", agentId: "ag-maya" };
        await open();
        const where = section("Where this project’s tests run");
        await pwExpect(where.getByText("This agent has no browsers installed.")).toBeVisible();
        await pwExpect(where.getByText("Web and API tests cannot run")).toBeVisible();
        await pwExpect(where.getByText("Phone tests cannot run")).toBeVisible();
    });

    it("locks the choice while a run is in progress", async () => {
        fake.agents = [MAYA()];
        fake.runner = { runOn: "platform", agentId: null };
        fake.jobRunning = true;
        await open();
        const where = section("Where this project’s tests run");
        await pwExpect(where.getByText("A run is in progress for this project.")).toBeVisible();
        await pwExpect(where.getByRole("radio", { name: /On a runner/ })).toBeDisabled();
        await pwExpect(where.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
        fake.jobRunning = false;
        await pwExpect(where.getByText("A run is in progress for this project.")).toHaveCount(0, { timeout: 15_000 }); // the page polls
        await pwExpect(where.getByRole("radio", { name: /On a runner/ })).toBeEnabled();
    });

    it("notices an agent going offline without a reload", async () => {
        fake.agents = [MAYA()];
        fake.runner = { runOn: "agent", agentId: "ag-maya" };
        await open();
        const row = page.locator("[data-agent='ag-maya']");
        await pwExpect(row).toContainText("Online");
        fake.agents[0]!.online = false;
        await pwExpect(row).toContainText("Offline", { timeout: 15_000 });
        await pwExpect(section("Where this project’s tests run").getByTestId("runner-status")).toHaveText("Runs on Maya’s laptop (offline).", { timeout: 15_000 });
        await pwExpect(section("Where this project’s tests run").getByText("Maya’s laptop is offline.")).toBeVisible();
    });

    it("says where tests run on the Tests page, the test page and in Runs", async () => {
        fake.agents = [MAYA()];
        fake.runner = { runOn: "agent", agentId: "ag-maya" };
        fake.ranOn = { kind: "agent", agentId: "ag-maya", name: "Maya’s laptop" };

        await page.goto(`${BASE}/#/projects/${projectId}/scripts`);
        await page.reload();
        await pwExpect(page.getByTestId("runs-on")).toContainText("Runs on Maya’s laptop (online).");
        await page.getByTestId("runs-on").getByRole("link", { name: "Change" }).click();
        await pwExpect(page.getByRole("heading", { name: "Runners", exact: true })).toBeVisible();

        await page.goto(`${BASE}/#/tests/${testId}`);
        await page.reload();
        await pwExpect(page.getByTestId("runs-on")).toContainText("Runs on Maya’s laptop (online).");
        await page.getByRole("button", { name: /Run again/ }).click();
        await pwExpect(page.getByTestId("runs-on")).toContainText("Ran on Maya’s laptop.", { timeout: 15_000 });

        await page.goto(`${BASE}/#/projects/${projectId}/runs`);
        await page.reload();
        await pwExpect(page.getByText("On Maya’s laptop", { exact: true })).toBeVisible();

        // a server that never heard of runner agents shows no line at all
        fake.runner = { runOn: "platform", agentId: null };
        fake.ranOn = null;
        await page.goto(`${BASE}/#/projects/${projectId}/scripts`);
        await page.reload();
        await pwExpect(page.getByTestId("runs-on")).toContainText("Runs on this server.");
    });

    it("can be used with the keyboard alone", async () => {
        resetFake();
        fake.agents = [MAYA()];
        await open();
        await page.getByLabel("Name (optional)").focus();
        await page.keyboard.type("Keyboard laptop");
        await page.keyboard.press("Enter");
        const fresh = page.getByRole("region", { name: "Your new token", exact: true });
        await pwExpect(fresh).toBeFocused(); // focus moves to the one-time notice
        await page.keyboard.press("Tab");
        await pwExpect(fresh.getByLabel("New token", { exact: true })).toBeFocused();
        await page.keyboard.press("Tab");
        await pwExpect(fresh.getByRole("button", { name: "Copy token", exact: true })).toBeFocused();
        await page.keyboard.press("Enter");
        await pwExpect(fresh.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
        await fresh.getByRole("button", { name: "I have copied it", exact: true }).focus();
        await page.keyboard.press("Enter");
        await pwExpect(fresh).toHaveCount(0);

        // open the agent's details and the revoke dialog without a mouse
        const toggle = page.getByRole("button", { name: "Show details for Maya’s laptop" });
        await toggle.focus();
        await page.keyboard.press("Enter");
        await pwExpect(page.getByRole("button", { name: "Hide details for Maya’s laptop" })).toHaveAttribute("aria-expanded", "true");
        await page.getByRole("button", { name: "Revoke token: Keyboard laptop" }).focus();
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog", { name: "Revoke this token?" });
        await pwExpect(dialog.getByRole("button", { name: "Keep token", exact: true })).toBeFocused(); // the safe choice first
        await page.keyboard.press("Escape");
        await pwExpect(dialog).toHaveCount(0);
        // the focus ring is visible on a button reached by keyboard
        await page.getByRole("button", { name: "Revoke token: Keyboard laptop" }).focus();
        const ring = await page.getByRole("button", { name: "Revoke token: Keyboard laptop" }).evaluate((el) => getComputedStyle(el).boxShadow + getComputedStyle(el).outlineStyle);
        expect(ring).not.toBe("nonenone");
    });

    it("works on a phone-sized screen without sideways scrolling, with large touch targets", async () => {
        fake.agents = [MAYA(), BUILD()];
        await page.setViewportSize({ width: 375, height: 800 });
        await open();
        await page.getByRole("button", { name: "Show details for Maya’s laptop" }).click();
        await pwExpect(page.getByRole("list", { name: "Android devices on Maya’s laptop" })).toBeVisible();
        await page.getByLabel("Name (optional)").fill("A phone-sized name for a token that is quite long indeed");
        await page.getByRole("button", { name: "Create token", exact: true }).click();
        await pwExpect(page.getByRole("region", { name: "Your new token", exact: true })).toBeVisible();
        await noOverflow();
        const small = await page.evaluate(() =>
            Array.from(document.querySelectorAll<HTMLElement>(".content button, .content a.btn, .content select, .content label.check, .content input:not([type=radio]):not([type=checkbox]):not([readonly])"))
                .filter((el) => el.offsetParent !== null)
                .map((el) => ({ el: `${el.tagName.toLowerCase()} ${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)}`, h: Math.round(el.getBoundingClientRect().height) }))
                .filter((x) => x.h < 43),
        );
        expect(small).toEqual([]);
        await shot("token-created-light-375");
        await page.setViewportSize({ width: 1280, height: 900 });
    });

    it("has no accessibility violations when connected, in light and dark", async () => {
        resetFake();
        fake.agents = [MAYA(), BUILD()];
        fake.tokens = [{ id: "tok-1", label: "Maya’s laptop", hint: "aitg_…x7Qd", createdAt: iso(3 * 86_400_000), lastUsedAt: iso(5_000), revokedAt: null }, { id: "tok-0", label: null, hint: "aitg_…k2Lm", createdAt: iso(9 * 86_400_000), lastUsedAt: null, revokedAt: iso(86_400_000) }];
        fake.runner = { runOn: "agent", agentId: "ag-maya" };
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.waitForTimeout(400); // colours ease over 140ms when the scheme flips; audit the settled state
            await open();
            await page.getByRole("button", { name: "Show details for Maya’s laptop" }).click();
            await pwExpect(page.getByText("Detected (iPhone 15), not supported yet.")).toBeVisible();
            await shot(`connected-${scheme}-1280`);
            await axe();
            // with the one-time notice on screen too
            await page.getByLabel("Name (optional)").fill("Another");
            await page.getByRole("button", { name: "Create token", exact: true }).click();
            await pwExpect(page.getByRole("region", { name: "Your new token", exact: true })).toBeVisible();
            await axe();
            await shot(`token-created-${scheme}-1280`);
            // and the dialog
            await page.getByRole("button", { name: "I have copied it", exact: true }).click();
            await page.getByRole("button", { name: "Revoke token: Maya’s laptop" }).click();
            await pwExpect(page.getByRole("dialog", { name: "Revoke this token?" })).toBeVisible();
            await axe();
            await page.keyboard.press("Escape");
        }
        await page.emulateMedia({ colorScheme: null });
    });

    it("writes the phone screenshots when asked", async () => {
        if (!shots) return;
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.waitForTimeout(400); // colours ease over 140ms when the scheme flips; audit the settled state
            await page.setViewportSize({ width: 390, height: 844 });
            resetFake();
            await open();
            await shot(`empty-${scheme}-390`);
            await page.getByLabel("Name (optional)").fill("Maya’s laptop");
            await page.getByRole("button", { name: "Create token", exact: true }).click();
            await pwExpect(page.getByRole("region", { name: "Your new token", exact: true })).toBeVisible();
            await shot(`token-created-${scheme}-390`);
            fake.agents = [MAYA(), BUILD()];
            fake.runner = { runOn: "agent", agentId: "ag-maya" };
            await open();
            await page.getByRole("button", { name: "Show details for Maya’s laptop" }).click();
            await shot(`connected-${scheme}-390`);
        }
        await page.emulateMedia({ colorScheme: null });
        await page.setViewportSize({ width: 1280, height: 900 });
    });

    it("works against the real platform: a token, an agent that says hello, choosing it, revoking the token", async () => {
        fake.enabled = false; // the front now only forwards; the platform's own admin routes answer
        try {
            await open();
            await page.getByLabel("Name (optional)").fill("Real laptop");
            await page.getByRole("button", { name: "Create token", exact: true }).click();
            const fresh = page.getByRole("region", { name: "Your new token", exact: true });
            await pwExpect(fresh).toBeVisible();
            const secret = await fresh.getByLabel("New token", { exact: true }).inputValue();
            expect(secret).toMatch(/^aitg_/);
            await pwExpect(fresh.getByTestId("agent-command")).toContainText(secret);
            await fresh.getByRole("button", { name: "I have copied it", exact: true }).click();
            await pwExpect(page.locator("[data-token]")).toContainText("Real laptop");
            await pwExpect(page.locator("[data-token]")).not.toContainText(secret);

            // a real agent connects with that token (what the agent program does first)
            const hello = (token: string) =>
                fetch(`http://127.0.0.1:${PLATFORM_PORT}/api/agent/hello`, {
                    method: "POST",
                    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
                    body: JSON.stringify({
                        protocol: 1, name: "Real laptop agent", version: "1.0.0", concurrency: 2,
                        capabilities: { os: "linux", arch: "x64", node: "v22.0.0", browsers: ["chromium"], android: { adb: true, devices: [{ serial: "emulator-5554", model: "Pixel 7", state: "device", emulator: true }], avds: [] } },
                    }),
                });
            const ok = await hello(secret);
            expect(ok.status).toBe(200);
            const row = page.locator("[data-agent]");
            await pwExpect(row).toContainText("Real laptop agent", { timeout: 15_000 }); // the list polls
            await pwExpect(row).toContainText("Online");
            await pwExpect(row.getByTestId("agent-capabilities")).toHaveText("Chromium. Android: 1 device, 1 emulator.");

            const where = section("Where this project’s tests run");
            await where.getByRole("radio", { name: /On a runner/ }).check();
            await where.getByRole("button", { name: "Save", exact: true }).click();
            await pwExpect(where.getByTestId("runner-status")).toContainText("Real laptop agent");
            await pwExpect(where.getByText("Web and API tests can run")).toBeVisible();
            await page.goto(`${BASE}/#/projects/${projectId}/scripts`);
            await page.reload();
            await pwExpect(page.getByTestId("runs-on")).toContainText("Real laptop agent");

            // revoke: the platform turns the agent away
            await open();
            await page.getByRole("button", { name: "Revoke token: Real laptop" }).click();
            await page.getByRole("dialog", { name: "Revoke this token?" }).getByRole("button", { name: "Revoke token", exact: true }).click();
            await pwExpect(page.locator("[data-token]")).toContainText("Revoked");
            expect((await hello(secret)).status).toBeGreaterThanOrEqual(400);
        } finally {
            fake.enabled = true;
        }
    });

    it("kept the browser console clean", () => {
        expect(consoleErrors).toEqual([]);
    });
});
