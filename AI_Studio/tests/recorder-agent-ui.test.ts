/**
 * Record a test on the person's own runner (one runner per person, no picker: docs/features/runner-settings.md). Runners mode: always the
 * person's runner, said once before the click from GET /api/me/runner `can`. Local mode: where the project runs its tests.
 *
 * The platform underneath is real (a seeded project, the real UI bundle). The recorder, /me/runner and project runner routes are a small
 * in-memory stand-in, served by a front server that forwards everything else to the platform (with the execution mode set per test).
 * Ports: 6050 front (the address the browser uses), 6051 platform.
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/recorder-agent-ui.test.ts
 * Set AP_SHOTS=<folder> to also write screenshots (the start form with the choice, a recording on an agent; light and dark; 1280 and 390 wide).
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
import { seedProject, type Seed } from "./fixtures/dashboard-seed.js";

const FRONT_PORT = 6050;
const PLATFORM_PORT = 6051;
const BASE = `http://127.0.0.1:${FRONT_PORT}`;
const APP = "http://127.0.0.1:6052/";

// ── the stand-in API ────────────────────────────────────────────────────────

interface FakeAgent {
    id: string; name: string; online: boolean; record?: boolean; recordHeaded?: boolean;
    /** The server's sentence when it cannot record with a window. */
    why?: string;
}
type Runner = { kind: "platform" } | { kind: "agent"; agentId: string; name: string };
interface FakeStep {
    index: number; kind: string; locator?: { strategy: string; value: string; name?: string }; matches?: number; describe: string; at: string;
}
interface FakeRec {
    id: string; projectId: string; status: "starting" | "recording" | "stopped" | "failed" | "saved"; startUrl: string; headed: boolean;
    steps: FakeStep[]; inspect: { on: boolean; mode: "locator" | "assertion" }; startedAt: string; stoppedAt?: string; error?: string; savedTestId?: string;
    runner?: Runner; pendingCommands?: number;
}
const MAYA: FakeAgent = { id: "ag-maya", name: "Maya’s laptop", online: true, record: true, recordHeaded: true };
const OMAR: FakeAgent = { id: "ag-omar", name: "Omar’s desktop", online: false, record: true, recordHeaded: true };
const DEE: FakeAgent = { id: "ag-dee", name: "Dee’s build box", online: true, record: true, recordHeaded: false, why: "Dee’s build box has no screen to show the recording window on. Start the runner from a signed-in desktop session." };

const fake = {
    /** The person's runner (GET /api/me/runner), null: not set up. */
    me: null as FakeAgent | null,
    meReads: 0,
    mode: "local" as "local" | "runners",
    runner: { runOn: "platform" as "platform" | "agent", agentId: null as string | null },
    rec: null as FakeRec | null,
    /** "ok" starts; the others answer a refusal. */
    start: "ok" as "ok" | "409" | "422" | "offline",
    /** On an agent the inspect command takes a moment to arrive: the answer keeps the old state and counts the command as pending. */
    slowInspect: false,
    calls: [] as string[],
    bodies: [] as Array<{ call: string; body: any }>,
};
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
function resetFake() {
    Object.assign(fake, { me: null, meReads: 0, mode: "local", runner: { runOn: "platform", agentId: null }, rec: null, start: "ok", slowInspect: false, calls: [], bodies: [] });
}
const view = (r: FakeRec) => ({ ...r, canSave: r.steps.some((s) => s.kind !== "goto") });
const ok = { ok: true };
/** GET /api/me/runner's runner, with the server's `can` for recording. */
const mineView = (a: FakeAgent) => ({
    id: a.id, name: a.name, status: a.online ? "online" : "offline", lastSeenAt: iso(a.online ? 1000 : 3_600_000), os: "win32", arch: "x64",
    switches: { codeScripts: true, privateTargets: false, realPhone: false },
    can: { web: ok, phone: ok, ios: ok, windows: ok, record: a.record ? ok : { ok: false, why: `${a.name} can't record.` }, recordHeaded: a.recordHeaded ? ok : { ok: false, why: a.why ?? `${a.name} can't show the window.` }, phoneSession: ok },
});
const GOTO = (i: number): FakeStep => ({ index: i, kind: "goto", describe: `Open ${APP}`, at: iso(4000) });
const CLICK = (i: number): FakeStep => ({
    index: i, kind: "click", locator: { strategy: "role", value: "button", name: "Add to cart" }, matches: 1, describe: "Click the button “Add to cart”", at: iso(3000),
});

async function front(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const p = new URL(req.url ?? "/", BASE).pathname;
    const method = req.method ?? "GET";
    const json = (status: number, data: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
    const parsed = (): any => {
        try {
            return JSON.parse(body.toString() || "{}");
        } catch {
            return {};
        }
    };
    const log = (call: string) => {
        fake.calls.push(call);
        fake.bodies.push({ call, body: body.length ? parsed() : undefined });
    };
    let m: RegExpMatchArray | null;

    if (p === "/api/me/runner" && method === "GET") {
        fake.meReads++;
        return json(200, { runner: fake.me ? mineView(fake.me) : null });
    }
    if (p === "/api/config" && method === "GET" && fake.mode === "runners") {
        const up = (await (await fetch(`http://127.0.0.1:${PLATFORM_PORT}/api/config`)).json()) as Record<string, unknown>;
        return json(200, { ...up, executionMode: "runners", runsHere: true });
    }
    if ((m = p.match(/^\/api\/projects\/([^/]+)\/runner$/)) && method === "GET") {
        return json(200, { ...fake.runner, status: "Runs here.", canRunWeb: true, canRunMobile: false, unavailableReason: null });
    }
    if ((m = p.match(/^\/api\/projects\/([^/]+)\/recordings$/)) && method === "POST") {
        log("start");
        if (fake.start === "409") return json(409, { error: "A recording is already running for this project.", details: { recordingId: "rec-active" } });
        if (fake.start === "422") return json(422, { error: "Maya’s laptop is busy with another recording. Wait for it to finish." });
        if (fake.start === "offline") return json(409, { error: "Your runner is offline. Start it on your computer, then try again.", details: { code: "RUNNER_OFFLINE", link: "#/settings#runner" } });
        const b = parsed();
        // The server picks the caller's own runner when the project runs on runners (always, in runners mode).
        const agent = fake.mode === "runners" || fake.runner.runOn === "agent" ? (fake.me ?? undefined) : undefined;
        fake.rec = {
            id: "rec-1", projectId: m[1]!, status: "recording", startUrl: b.url, headed: b.headed !== false, steps: [], inspect: { on: false, mode: "locator" }, startedAt: iso(5000),
            runner: agent ? { kind: "agent", agentId: agent.id, name: agent.name } : { kind: "platform" },
        };
        return json(201, view(fake.rec));
    }
    if ((m = p.match(/^\/api\/recordings\/([^/]+)$/))) {
        const r = fake.rec;
        if (method === "GET") return !r || r.id !== m[1] ? json(404, { error: "That recording does not exist." }) : json(200, view(r));
        if (method === "DELETE") {
            log("discard");
            fake.rec = null;
            return json(200, { ok: true });
        }
    }
    if ((m = p.match(/^\/api\/recordings\/([^/]+)\/(inspect|stop|save)$/)) && method === "POST") {
        const r = fake.rec;
        if (!r) return json(404, { error: "That recording does not exist." });
        log(m[2]!);
        if (m[2] === "inspect") {
            const b = parsed();
            if (fake.slowInspect) r.pendingCommands = 1; // the agent has not applied it yet: the state stays as it was
            else r.inspect = { on: b.on, mode: b.mode ?? "locator" };
            return json(200, view(r));
        }
        if (m[2] === "stop") {
            r.status = "stopped";
            r.stoppedAt = iso();
            r.inspect.on = false;
            return json(200, view(r));
        }
        r.status = "saved";
        r.savedTestId = "t-fake";
        return json(201, { testId: "t-fake", jobId: null });
    }
    if ((m = p.match(/^\/api\/recordings\/([^/]+)\/steps\/(\d+)$/)) && method === "DELETE") {
        const r = fake.rec;
        if (!r || !r.steps[Number(m[2])]) return json(404, { error: "That step does not exist." });
        log("delete");
        r.steps.splice(Number(m[2]), 1);
        r.steps.forEach((s, i) => (s.index = i));
        return json(200, view(r));
    }

    // everything else (the app itself, the project, its environments) is the real platform
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "connection", "content-length"].includes(k)) headers[k] = v;
    const upstream = await fetch(`http://127.0.0.1:${PLATFORM_PORT}${req.url}`, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : new Uint8Array(body) });
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" }).end(Buffer.from(await upstream.arrayBuffer()));
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
const consoleErrors: string[] = [];

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-recorder-agent-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    frontServer = http.createServer((req, res) => void front(req, res).catch((e) => res.writeHead(500).end(String(e))));
    await new Promise<void>((r) => frontServer.listen(FRONT_PORT, "127.0.0.1", r));
    seed = seedProject(platform, "Atlas shop", APP);
    projectId = seed.projectId;

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); // axe-core refuses pages that were not made through a context
    page = await context.newPage();
    page.on("console", (m) => {
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

const recordUrl = (session?: string) => `${BASE}/#/projects/${projectId}/record${session ? `?session=${session}` : ""}`;
const startButton = () => page.getByRole("button", { name: "Start recording", exact: true });
async function openStart() {
    await page.evaluate(() => sessionStorage.clear()).catch(() => undefined);
    await page.goto(recordUrl());
    await page.reload(); // a hash change alone would not re-run the page's loads
    await pwExpect(page.getByRole("heading", { name: "Record a test", exact: true })).toBeVisible();
    await pwExpect(startButton()).toBeVisible();
}
const onGroup = () => page.getByRole("radiogroup", { name: "Record on", exact: true });
/** Open the form with the person's runner and the project's setting answered. */
async function openWith(me: FakeAgent | null, opts: { mode?: "local" | "runners"; runOn?: "platform" | "agent" } = {}) {
    resetFake();
    fake.me = me;
    fake.mode = opts.mode ?? "local";
    fake.runner = { runOn: opts.runOn ?? "platform", agentId: null };
    await openStart();
    await pwExpect(page.getByLabel("Address to start from")).toHaveValue(APP);
}
async function startOnAgent(steps: FakeStep[] = []) {
    await openWith(MAYA, { mode: "runners" });
    await pwExpect(page.getByTestId("rec-on-hint")).toBeVisible();
    await startButton().click();
    await pwExpect(page.getByTestId("rec-state")).toHaveText("Recording on Maya’s laptop");
    if (steps.length) {
        fake.rec!.steps.push(...steps);
        await pwExpect(page.locator("[data-step]")).toHaveCount(steps.length, { timeout: 8000 });
    }
}
const shots = process.env.AP_SHOTS;
async function shot(name: string) {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
}
async function noOverflow() {
    const wide = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".content *"))
            .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !el.closest(".tabs, .rec-scroll"))
            .slice(0, 5)
            .map((el) => `${el.tagName.toLowerCase()}.${el.className}`),
    );
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect({ overflow, wide }).toEqual({ overflow: 0, wide: [] });
}
/** Every button, text field and select, and the whole row of each checkbox or radio, is at least 44px tall (disabled controls included in the rows). */
async function bigTargets() {
    const small = await page.evaluate(() => {
        const out: string[] = [];
        const check = (el: Element, label: string) => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return;
            if (r.height < 43.5) out.push(`${label} ${Math.round(r.height)}px: ${(el.textContent ?? "").trim().slice(0, 40) || el.getAttribute("aria-label") || el.id}`);
        };
        document.querySelectorAll(".content button, .content a.btn, .content input:not([type=checkbox]):not([type=radio]):not([type=hidden]), .content select").forEach((el) => check(el, el.tagName.toLowerCase()));
        document.querySelectorAll(".content .check, .content .rec-choice").forEach((el) => check(el, "row"));
        return out;
    });
    expect(small).toEqual([]);
}
async function axe() {
    const result = await new AxeBuilder({ page }).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
async function settle(scheme: "light" | "dark") {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(400); // colours ease over 140ms when the scheme flips; audit the settled state
}

// ── journeys ────────────────────────────────────────────────────────────────

describe("Record on: no choice, the person's own runner", () => {
    it("never offers a place or a window switch; local mode on this server sends what it sent before", async () => {
        await openWith(MAYA);
        await page.waitForTimeout(300); // every answer has arrived by now
        await pwExpect(onGroup()).toHaveCount(0);
        await pwExpect(page.getByText("Record on", { exact: true })).toHaveCount(0);
        await pwExpect(page.getByText("Show the browser window")).toHaveCount(0);
        await pwExpect(page.getByText("We open a browser window on the computer that runs this platform. Click through your application as a user would. We write down each step.")).toBeVisible();
        await pwExpect(page.getByText("The page the browser opens first.")).toBeVisible();
        await startButton().click();
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Recording"); // no "on ..." for a server recording
        expect(fake.bodies[0]).toEqual({ call: "start", body: { url: APP, headed: true } });
        expect(fake.calls).toEqual(["start"]);
    });

    it("local mode, a project that runs on runners: says your runner's computer and names no runner in the request", async () => {
        await openWith(MAYA, { runOn: "agent" });
        await pwExpect(page.getByText("We open a browser window on your runner’s computer.", { exact: false })).toBeVisible();
        await pwExpect(page.getByText("We open this address from your runner’s computer, so it can be a private address.")).toBeVisible();
        await page.getByLabel("Address to start from").fill("192.168.1.20:3000/shop");
        await startButton().click();
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Recording on Maya’s laptop");
        expect(fake.bodies[0]).toEqual({ call: "start", body: { url: "http://192.168.1.20:3000/shop", headed: true } });
        expect(page.url()).toContain("?session=rec-1");
    });

    it("runners mode: one line names the runner, and the start names none (the server picks it)", async () => {
        await openWith(MAYA, { mode: "runners" });
        await pwExpect(page.getByTestId("rec-on-hint")).toHaveText("The window opens on your runner, Maya’s laptop, not on this computer.");
        await pwExpect(page.getByTestId("rec-runner-problem")).toHaveCount(0);
        await pwExpect(startButton()).toBeEnabled();
        await shot("start-agent-light-1280");
        await startButton().click();
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Recording on Maya’s laptop");
        expect(fake.bodies[0]).toEqual({ call: "start", body: { url: APP, headed: true } });
    });

    it("runners mode: not set up, offline, or no screen for the window: the server's sentence once, a link to Settings, and nothing starts", async () => {
        for (const [me, text] of [
            [null, "Set up your runner in Settings to run tests."],
            [OMAR, "Your runner is offline. Start it on your computer, then try again."],
            [DEE, DEE.why!],
        ] as const) {
            await openWith(me, { mode: "runners" });
            const box = page.getByTestId("rec-runner-problem");
            await pwExpect(box).toContainText(text);
            await pwExpect(box.getByRole("link", { name: "Open Your runner in Settings" })).toHaveAttribute("href", "#/settings#runner");
            await pwExpect(page.getByText(text)).toHaveCount(1);
            await pwExpect(page.getByTestId("rec-on-hint")).toHaveCount(0);
            await pwExpect(startButton()).toBeDisabled();
            expect(fake.calls).toEqual([]);
        }
    });

    it("a refused start shows the server's words with the Settings link, and reads the runner again", async () => {
        await openWith(MAYA, { mode: "runners" });
        await pwExpect(page.getByTestId("rec-on-hint")).toBeVisible();
        const before = fake.meReads;
        fake.start = "offline";
        await startButton().click();
        await pwExpect(page.getByText("Your runner is offline. Start it on your computer, then try again.")).toBeVisible();
        await pwExpect(page.getByRole("link", { name: "Open Your runner in Settings" })).toHaveAttribute("href", "#/settings#runner");
        await pwExpect.poll(() => fake.meReads).toBeGreaterThan(before);
    });

    it("shows the platform's own words for a refusal, and resumes the running session from the details", async () => {
        await openWith(MAYA, { mode: "runners" });
        await pwExpect(page.getByTestId("rec-on-hint")).toBeVisible();
        fake.start = "422";
        await startButton().click();
        await pwExpect(page.getByText("Maya’s laptop is busy with another recording. Wait for it to finish.")).toBeVisible();
        fake.start = "409";
        fake.rec = { id: "rec-active", projectId, status: "recording", startUrl: APP, headed: true, steps: [], inspect: { on: false, mode: "locator" }, startedAt: iso(9000), runner: { kind: "agent", agentId: "ag-maya", name: "Maya’s laptop" } };
        await startButton().click();
        await pwExpect(page.getByText("A recording is already running for this project.")).toBeVisible();
        await page.getByRole("button", { name: "Resume watching", exact: true }).click();
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Recording on Maya’s laptop");
        expect(page.url()).toContain("?session=rec-active");
    });
});

describe("Record on: a recording on an agent", () => {
    it("says where it runs in the status bar and where the window opens while starting", async () => {
        await startOnAgent([GOTO(0), CLICK(1)]);
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Recording on Maya’s laptop");
        fake.rec!.status = "starting";
        await pwExpect(page.getByText("Starting the browser window. It opens on Maya’s laptop, not on this computer.")).toBeVisible({ timeout: 8000 });
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Starting the browser on Maya’s laptop");
        fake.rec!.status = "recording";
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Recording on Maya’s laptop", { timeout: 8000 });
        await shot("recording-agent-light-1280");
    });

    it("shows Applying… while a command waits, keeps the buttons on the server's state, then follows it", async () => {
        await startOnAgent([GOTO(0), CLICK(1)]);
        const pick = page.getByRole("button", { name: "Pick an element", exact: true });
        await pwExpect(page.getByTestId("rec-applying")).toHaveCount(0);
        fake.slowInspect = true;
        await pick.click();
        await pwExpect(page.getByTestId("rec-applying")).toHaveText("Applying…");
        await pwExpect(pick).toHaveAttribute("aria-pressed", "false"); // the click is not shown as done
        await pwExpect(pick).toBeDisabled();
        await page.waitForTimeout(2300); // two polls with the command still waiting: no flicker
        await pwExpect(pick).toHaveAttribute("aria-pressed", "false");
        await pwExpect(page.getByTestId("rec-applying")).toBeVisible();
        // the agent applies it: the server's state arrives
        fake.rec!.inspect = { on: true, mode: "locator" };
        fake.rec!.pendingCommands = 0;
        await pwExpect(pick).toHaveAttribute("aria-pressed", "true", { timeout: 8000 });
        await pwExpect(page.getByTestId("rec-applying")).toHaveCount(0);
        await pwExpect(pick).toBeEnabled();
        await pwExpect(page.getByText("Picking an element")).toBeVisible();
    });

    it("shows the lost-contact sentence above the steps and the save form, and the steps stay editable and saveable", async () => {
        await startOnAgent([GOTO(0), CLICK(1), { ...CLICK(2), describe: "Click the button “Pay now”", locator: { strategy: "role", value: "button", name: "Pay now" } }]);
        const sentence = "Lost contact with Maya’s laptop. The steps recorded so far are kept.";
        fake.rec!.status = "stopped";
        fake.rec!.stoppedAt = iso();
        fake.rec!.error = sentence;
        fake.rec!.inspect.on = false;
        const callout = page.getByText(sentence);
        await pwExpect(callout).toBeVisible({ timeout: 8000 });
        await pwExpect(page.getByText("The recording ended early")).toBeVisible();
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Stopped on Maya’s laptop");
        // above the steps and the save form
        const order = await page.evaluate((s) => {
            const nodes = Array.from(document.querySelectorAll("*"));
            const at = (match: (el: Element) => boolean) => nodes.findIndex(match);
            return {
                callout: at((el) => el.children.length === 0 && el.textContent === s),
                steps: at((el) => el.getAttribute("aria-labelledby") === "rec-steps-title"),
            };
        }, sentence);
        expect(order.callout).toBeGreaterThan(-1);
        expect(order.callout).toBeLessThan(order.steps);
        // the steps can still be changed: delete one
        await pwExpect(page.locator("[data-step]")).toHaveCount(3);
        await page.locator('[data-step="2"]').getByRole("button", { name: "Delete step 3" }).click();
        await pwExpect(page.locator("[data-step]")).toHaveCount(2);
        expect(fake.calls).toContain("delete");
        // and saved
        await page.getByLabel("Test name").fill("Add a product to the cart");
        await page.getByRole("button", { name: "Save as a test", exact: true }).click();
        await pwExpect(page.getByRole("link", { name: "Open the test", exact: true })).toBeVisible();
        expect(fake.bodies.find((b) => b.call === "save")?.body).toEqual({ title: "Add a product to the cart" });
    });

    it("keeps the steps, the inspector and the stop button working on an agent as on the server", async () => {
        await startOnAgent([GOTO(0), CLICK(1)]);
        await page.getByRole("button", { name: "Stop recording", exact: true }).click();
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Stopped on Maya’s laptop");
        await pwExpect(page.getByText("The recording ended early")).toHaveCount(0); // a normal stop has no error
        expect(fake.calls).toEqual(["start", "stop"]);
    });
});

describe("Record on: phone width and accessibility", () => {
    it("fits 375px with 44px targets on the start form and on a recording on an agent", async () => {
        await page.setViewportSize({ width: 375, height: 812 });
        await openWith(DEE, { mode: "runners" });
        await pwExpect(page.getByTestId("rec-runner-problem")).toBeVisible();
        await noOverflow();
        await bigTargets();
        await openWith(MAYA, { mode: "runners" });
        await pwExpect(page.getByTestId("rec-on-hint")).toBeVisible();
        await noOverflow();
        await bigTargets();
        await shot("start-agent-light-375");
        await startButton().click();
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Recording on Maya’s laptop");
        fake.rec!.steps.push(GOTO(0), CLICK(1));
        await pwExpect(page.locator("[data-step]")).toHaveCount(2, { timeout: 8000 });
        fake.slowInspect = true;
        await page.getByRole("button", { name: "Pick an element", exact: true }).click();
        await pwExpect(page.getByTestId("rec-applying")).toBeVisible();
        await noOverflow();
        await bigTargets();
        await shot("recording-agent-light-375");
        await page.setViewportSize({ width: 1280, height: 900 });
    });

    it("is reachable and usable from the keyboard alone", async () => {
        await openWith(MAYA, { mode: "runners" });
        await pwExpect(page.getByTestId("rec-on-hint")).toBeVisible();
        await page.getByLabel("Address to start from").focus();
        await page.keyboard.press("Tab");
        await pwExpect(startButton()).toBeFocused();
        await page.getByLabel("Address to start from").focus();
        await page.keyboard.press("Enter"); // submits the form
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Recording on Maya’s laptop");
    });

    it("has no accessibility violations in light and dark, on the start form and on recordings that end early", async () => {
        for (const scheme of ["light", "dark"] as const) {
            await settle(scheme);
            await openWith(DEE, { mode: "runners" });
            await pwExpect(page.getByTestId("rec-runner-problem")).toBeVisible();
            await axe(); // the runner can't record
            await openWith(MAYA, { mode: "runners" });
            await pwExpect(page.getByTestId("rec-on-hint")).toBeVisible();
            await axe();
            await shot(`start-${scheme}-1280`);
            await startOnAgent([GOTO(0), CLICK(1)]);
            fake.slowInspect = true;
            await page.getByRole("button", { name: "Pick an element", exact: true }).click();
            await pwExpect(page.getByTestId("rec-applying")).toBeVisible();
            await axe(); // applying
            fake.rec!.status = "stopped";
            fake.rec!.error = "Lost contact with Maya’s laptop. The steps recorded so far are kept.";
            fake.rec!.pendingCommands = 0;
            await pwExpect(page.getByText("The recording ended early")).toBeVisible({ timeout: 8000 });
            await axe(); // lost contact
            await shot(`lost-${scheme}-1280`);
        }
        await page.emulateMedia({ colorScheme: null });
    });

    it("writes the screenshots when asked", async () => {
        if (!shots) return;
        for (const scheme of ["light", "dark"] as const) {
            for (const [w, h] of [[1280, 900], [390, 844]] as const) {
                await settle(scheme);
                await page.setViewportSize({ width: w, height: h });
                await openWith(MAYA, { mode: "runners" });
                await pwExpect(page.getByTestId("rec-on-hint")).toBeVisible();
                await shot(`start-${scheme}-${w}`);
                await startButton().click();
                await pwExpect(page.getByTestId("rec-state")).toHaveText("Recording on Maya’s laptop");
                fake.rec!.steps.push(GOTO(0), CLICK(1));
                await pwExpect(page.locator("[data-step]")).toHaveCount(2, { timeout: 8000 });
                fake.slowInspect = true;
                await page.getByRole("button", { name: "Pick an element", exact: true }).click();
                await pwExpect(page.getByTestId("rec-applying")).toBeVisible();
                await shot(`on-agent-${scheme}-${w}`);
            }
        }
        await page.emulateMedia({ colorScheme: null });
        await page.setViewportSize({ width: 1280, height: 900 });
    });

    it("kept the browser console clean", () => {
        expect(consoleErrors).toEqual([]);
    });
});
