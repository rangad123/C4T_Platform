/**
 * Record a test, choosing where: this server or a runner agent (the browser opens on the tester's own machine).
 *
 * The platform underneath is real (a seeded project, the real UI bundle). The recorder, agents and runner routes are a small
 * in-memory stand-in, served by a front server that forwards everything else to the platform, because the platform half
 * (Builder AO) is built in parallel: the shapes are the ones in .scratch/briefs/AP-record-on-agent-ui.md. A real journey with the
 * platform and tests/fixtures/fake-agent.ts is not included: the platform's recorder routes did not take `on` / `agentId` yet.
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
const LIN: FakeAgent = { id: "ag-lin", name: "Lin’s phone lab", online: true, record: false };
const DEE: FakeAgent = { id: "ag-dee", name: "Dee’s build box", online: true, record: true, recordHeaded: false };

const fake = {
    agents: [] as FakeAgent[],
    agentsStatus: 200,
    runner: { runOn: "platform" as "platform" | "agent", agentId: null as string | null },
    rec: null as FakeRec | null,
    /** "ok" starts; the others answer a refusal. */
    start: "ok" as "ok" | "409" | "422",
    /** On an agent the inspect command takes a moment to arrive: the answer keeps the old state and counts the command as pending. */
    slowInspect: false,
    calls: [] as string[],
    bodies: [] as Array<{ call: string; body: any }>,
};
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
function resetFake() {
    Object.assign(fake, { agents: [], agentsStatus: 200, runner: { runOn: "platform", agentId: null }, rec: null, start: "ok", slowInspect: false, calls: [], bodies: [] });
}
const view = (r: FakeRec) => ({ ...r, canSave: r.steps.some((s) => s.kind !== "goto") });
const agentView = (a: FakeAgent) => ({
    id: a.id, name: a.name, version: "1.0.0", tokenId: "tok-1", os: "win32", arch: "x64", node: "v24.0.0", online: a.online, lastSeenAt: iso(a.online ? 1000 : 3_600_000), firstSeenAt: iso(86_400_000),
    activeTasks: 0, concurrency: 1,
    capabilities: { browsers: ["chromium"], ...(a.record !== undefined ? { record: a.record } : {}), ...(a.recordHeaded !== undefined ? { recordHeaded: a.recordHeaded } : {}) },
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

    if ((m = p.match(/^\/api\/projects\/([^/]+)\/agents$/)) && method === "GET") {
        return fake.agentsStatus === 200 ? json(200, fake.agents.map(agentView)) : json(fake.agentsStatus, { error: "Not found" });
    }
    if ((m = p.match(/^\/api\/projects\/([^/]+)\/runner$/)) && method === "GET") {
        return json(200, { ...fake.runner, status: "Runs here.", canRunWeb: true, canRunMobile: false, unavailableReason: null });
    }
    if ((m = p.match(/^\/api\/projects\/([^/]+)\/recordings$/)) && method === "POST") {
        log("start");
        if (fake.start === "409") return json(409, { error: "A recording is already running for this project.", details: { recordingId: "rec-active" } });
        if (fake.start === "422") return json(422, { error: "Maya’s laptop is busy with another recording. Wait for it to finish, or record on this server." });
        const b = parsed();
        const agent = b.on === "agent" ? fake.agents.find((a) => a.id === b.agentId) : undefined;
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
const agentSelect = () => page.getByLabel("Runner", { exact: true });
const onGroup = () => page.getByRole("radiogroup", { name: "Record on", exact: true });
/** Open the form with agents answered, wait for the choice to appear. */
async function openWithAgents(agents: FakeAgent[], runner: { runOn: "platform" | "agent"; agentId: string | null } = { runOn: "platform", agentId: null }) {
    resetFake();
    fake.agents = agents;
    fake.runner = runner;
    await openStart();
    await pwExpect(onGroup()).toBeVisible();
}
async function startOnAgent(steps: FakeStep[] = []) {
    await openWithAgents([MAYA, OMAR]);
    await page.getByRole("radio", { name: "A runner", exact: true }).check();
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

describe("Record on: the choice", () => {
    it("is hidden when no agent can record, and the form and the request are what they were", async () => {
        for (const agents of [[], [LIN], [{ ...LIN, record: undefined }]] as FakeAgent[][]) {
            resetFake();
            fake.agents = agents;
            await openStart();
            await pwExpect(page.getByLabel("Address to start from")).toHaveValue(APP);
            await page.waitForTimeout(300); // the agents answer has arrived by now
            await pwExpect(onGroup()).toHaveCount(0);
            await pwExpect(page.getByText("Record on", { exact: true })).toHaveCount(0);
            await pwExpect(page.getByText("We open a browser window on the computer that runs this platform. Click through your application as a user would. We write down each step.")).toBeVisible();
            await pwExpect(page.getByText("The page the browser opens first.")).toBeVisible();
            await pwExpect(page.getByLabel("Show the browser window")).toBeChecked();
            await startButton().click();
            await pwExpect(page.getByTestId("rec-state")).toHaveText("Recording"); // no "on ..." for a server recording
            expect(fake.bodies[0]).toEqual({ call: "start", body: { url: APP, headed: true } });
            expect(fake.calls).toEqual(["start"]);
        }
    });

    it("stays hidden when the agents list cannot be read", async () => {
        resetFake();
        fake.agentsStatus = 404;
        await openStart();
        await page.waitForTimeout(300);
        await pwExpect(onGroup()).toHaveCount(0);
        await startButton().click();
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Recording");
        expect(fake.bodies[0]).toEqual({ call: "start", body: { url: APP, headed: true } });
    });

    it("is shown with two options, defaults to this server, and a platform start sends exactly what it sent before", async () => {
        await openWithAgents([MAYA, OMAR, LIN]);
        await pwExpect(page.getByRole("radio", { name: "This server", exact: true })).toBeChecked();
        await pwExpect(page.getByRole("radio", { name: "A runner", exact: true })).not.toBeChecked();
        await pwExpect(agentSelect()).toHaveCount(0);
        await pwExpect(page.getByTestId("rec-on-hint")).toHaveText("The browser window opens on the computer that runs this platform.");
        await pwExpect(page.getByText("The page the browser opens first.")).toBeVisible();
        await startButton().click();
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Recording");
        expect(fake.bodies[0]).toEqual({ call: "start", body: { url: APP, headed: true } });
    });

    it("defaults to a runner agent when the project's runner setting says so, and to its agent when it can record", async () => {
        await openWithAgents([MAYA, { ...MAYA, id: "ag-second", name: "Second laptop" }], { runOn: "agent", agentId: "ag-second" });
        await pwExpect(page.getByRole("radio", { name: "A runner", exact: true })).toBeChecked();
        await pwExpect(agentSelect()).toHaveValue("ag-second");
        await startButton().click();
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Recording on Second laptop");
        expect(fake.bodies[0]).toEqual({ call: "start", body: { url: APP, headed: true, on: "agent", agentId: "ag-second" } });
        // the setting names an agent that cannot be used: the first one that can is chosen instead
        await openWithAgents([LIN, MAYA], { runOn: "agent", agentId: "ag-lin" });
        await pwExpect(agentSelect()).toHaveValue("ag-maya");
        // a person's own choice wins over the setting
        await page.getByRole("radio", { name: "This server", exact: true }).check();
        await pwExpect(agentSelect()).toHaveCount(0);
    });

    it("lists every agent with the reason an unusable one is disabled, usable and online ones first", async () => {
        await openWithAgents([OMAR, LIN, DEE, MAYA]);
        await page.getByRole("radio", { name: "A runner", exact: true }).check();
        const select = agentSelect();
        const options = await select.locator("option").evaluateAll((os) => os.map((o) => ({ text: o.textContent, disabled: (o as HTMLOptionElement).disabled })));
        expect(options).toEqual([
            { text: "Maya’s laptop", disabled: false },
            { text: "Lin’s phone lab (Can’t record)", disabled: true },
            { text: "Dee’s build box (No display, so it can’t show the window)", disabled: true },
            { text: "Omar’s desktop (Offline)", disabled: true },
        ]);
        await pwExpect(select).toHaveValue("ag-maya");
        await pwExpect(page.getByTestId("rec-on-hint")).toHaveText("The browser window opens on Maya’s laptop, not on this computer.");
        await pwExpect(page.getByText("We open this address from the runner’s computer, so it can be a private address.")).toBeVisible();
        await pwExpect(page.getByText("The page the browser opens first.")).toHaveCount(0);
        await pwExpect(page.getByLabel("Show the browser window")).toBeEnabled();
        await shot("start-agent-light-1280");
    });

    it("sends the agent and its id, and only then, when an agent is chosen", async () => {
        await openWithAgents([MAYA]);
        await page.getByLabel("Address to start from").fill("192.168.1.20:3000/shop");
        await page.getByRole("radio", { name: "A runner", exact: true }).check();
        await startButton().click();
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Recording on Maya’s laptop");
        expect(fake.bodies[0]).toEqual({ call: "start", body: { url: "http://192.168.1.20:3000/shop", headed: true, on: "agent", agentId: "ag-maya" } });
        expect(page.url()).toContain("?session=rec-1");
    });

    it("turns the window off and locks it for an agent with no display, with the reason", async () => {
        await openWithAgents([DEE, MAYA]);
        await page.getByRole("radio", { name: "A runner", exact: true }).check();
        const dee = agentSelect();
        await pwExpect(dee).toHaveValue("ag-maya");
        await page.getByLabel("Show the browser window").uncheck(); // Dee can be picked once the window is not wanted
        await dee.selectOption("ag-dee");
        const box = page.getByLabel("Show the browser window");
        await pwExpect(box).not.toBeChecked();
        await pwExpect(box).toBeDisabled();
        await pwExpect(page.getByText("Dee’s build box has no display, so it can’t show the window.")).toBeVisible();
        await pwExpect(page.getByTestId("rec-on-hint")).toHaveText("The browser runs on Dee’s build box without showing a window.");
        await startButton().click();
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Recording on Dee’s build box");
        expect(fake.bodies[0]).toEqual({ call: "start", body: { url: APP, headed: false, on: "agent", agentId: "ag-dee" } });
        // back to an agent that has a display: the box is a normal box again
        await openWithAgents([DEE, MAYA]);
        await page.getByRole("radio", { name: "A runner", exact: true }).check();
        await pwExpect(page.getByLabel("Show the browser window")).toBeEnabled();
    });

    it("says so and sends nothing when the agent option is chosen but no agent can record now", async () => {
        await openWithAgents([OMAR, DEE]);
        await page.getByRole("radio", { name: "A runner", exact: true }).check();
        await pwExpect(agentSelect()).toHaveValue("");
        await pwExpect(page.getByTestId("rec-on-hint")).toHaveText("Start a runner that can record, or choose This server.");
        await startButton().click();
        await pwExpect(page.getByText("No runner can record right now").first()).toBeVisible();
        await pwExpect(page.getByText("Pick a runner that is online and can record, or choose This server.")).toBeVisible();
        expect(fake.calls).toEqual([]);
        await page.getByRole("radio", { name: "This server", exact: true }).check();
        await startButton().click();
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Recording");
        expect(fake.bodies[0]).toEqual({ call: "start", body: { url: APP, headed: true } });
    });

    it("shows the platform's own words for a refusal, and resumes the running session from the details", async () => {
        await openWithAgents([MAYA]);
        await page.getByRole("radio", { name: "A runner", exact: true }).check();
        fake.start = "422";
        await startButton().click();
        await pwExpect(page.getByText("Maya’s laptop is busy with another recording. Wait for it to finish, or record on this server.")).toBeVisible();
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
    it("fits 375px with 44px targets on the start form (both options) and on a recording on an agent", async () => {
        await page.setViewportSize({ width: 375, height: 812 });
        await openWithAgents([MAYA, OMAR, LIN, DEE]);
        await page.getByRole("radio", { name: "A runner", exact: true }).check();
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
        await openWithAgents([MAYA, OMAR]);
        await page.getByRole("radio", { name: "This server", exact: true }).focus();
        await page.keyboard.press("ArrowDown"); // radios move with the arrows
        await pwExpect(page.getByRole("radio", { name: "A runner", exact: true })).toBeChecked();
        await pwExpect(agentSelect()).toBeVisible();
        await page.keyboard.press("Tab");
        await pwExpect(agentSelect()).toBeFocused();
        await page.keyboard.press("Tab");
        await pwExpect(page.getByLabel("Address to start from")).toBeFocused();
        await page.keyboard.press("Enter"); // submits the form
        await pwExpect(page.getByTestId("rec-state")).toHaveText("Recording on Maya’s laptop");
    });

    it("has no accessibility violations in light and dark, on the start form and on recordings that end early", async () => {
        for (const scheme of ["light", "dark"] as const) {
            await settle(scheme);
            await openWithAgents([MAYA, OMAR, LIN, DEE]);
            await page.getByRole("radio", { name: "A runner", exact: true }).check();
            await axe(); // the choice with disabled agents
            await page.getByRole("radio", { name: "This server", exact: true }).check();
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
                await openWithAgents([MAYA, OMAR, LIN, DEE]);
                await page.getByRole("radio", { name: "A runner", exact: true }).check();
                await shot(`choice-${scheme}-${w}`);
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
