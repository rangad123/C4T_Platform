/**
 * "Add a runner" as a guided download, in a real browser against the real built UI (web/dist) and a real platform underneath.
 *
 * The runner-kit API (info + download) and the token/runner lists are a small in-memory stand-in that follows
 * .scratch/briefs/KIT-ui.md, served by a front server that forwards everything else to the platform. That lets every state be
 * driven (unavailable, URL warning, 409, 503, 400, waiting, connected, still waiting) without the bundle side being built.
 * The last journey switches the stand-in off and talks to the platform's own routes when KIT-A's routes exist.
 * Ports: 6550 front (the address the browser uses), 6551 platform.
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/add-runner-ui.test.ts
 * Set KIT_SHOTS=<folder> to also write screenshots (each step, waiting and connected; light and dark; 1280 and 390 wide).
 * The panel's "still waiting" timer is 3 minutes; these tests shorten it with ?runnerWaitMs=1500 in the page address (a documented test-only knob).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { strToU8, unzipSync, zipSync } from "fflate";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { defaultKind, downloadErrorText, effectiveKind, findNewRunner, guessPlatform, guessTarget, installerAvailable, KitError, sizeWords, startInstructions, targetFromHints, waitLimitMs } from "../web/src/features/agents/kit.js";
import { addTest, seedProject, seedRun, type Seed } from "./fixtures/dashboard-seed.js";

const FRONT_PORT = 6550;
const PLATFORM_PORT = 6551;
const BASE = `http://127.0.0.1:${FRONT_PORT}`;
const SECRET = "aitg_KITSECRET0123456789abcdefghijklmnopqrstuvwxyz";

// ── the stand-in API ────────────────────────────────────────────────────────

interface FakeToken { id: string; label: string | null; hint: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }
interface FakeAgent {
    id: string; name: string; version: string; kitVersion?: string; tokenId: string; os: "win32" | "darwin" | "linux"; arch: string; node: string; online: boolean;
    lastSeenAt: string; firstSeenAt: string; activeTasks: number; concurrency: number; capabilities: { browsers: Array<"chromium" | "firefox" | "webkit">; kitVersion?: string };
}
type KitMode = "ok" | 409 | 503 | 400 | 500;
// maxRunners: these panel tests show the Add flow with room for more runners (the platform's default is one per project).
const INFO_OK = { available: true, platformUrl: "https://tests.example.com", urlOk: true, nodeMin: 24, kitVersion: "1.4.0", maxRunners: 25 };
const fake = {
    tokens: [] as FakeToken[],
    agents: [] as FakeAgent[],
    info: { ...INFO_OK } as Record<string, unknown>,
    infoStatus: 200,
    kit: "ok" as KitMode,
    /** The installer was asked for but this stand-in server has none: it answers with plain files and says so (the platform does the same). */
    installerFallback: false,
    kitRequests: [] as Array<{ name: string; platform: string; kind?: string; complete?: boolean; arch?: string; os?: string; key: string | undefined }>,
    agentRequests: 0,
    deleted: [] as string[],
    enabled: true,
    seq: 0,
};
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function resetFake() {
    Object.assign(fake, { tokens: [], agents: [], info: { ...INFO_OK }, infoStatus: 200, kit: "ok", installerFallback: false, kitRequests: [], agentRequests: 0, deleted: [], seq: 0 });
}

const agent = (over: Partial<FakeAgent> & { id: string; name: string; tokenId: string }): FakeAgent => ({
    version: "1.0.0", os: "linux", arch: "x64", node: "v24.1.0", online: true, lastSeenAt: iso(2_000), firstSeenAt: iso(60_000), activeTasks: 0, concurrency: 2, ...over,
    // the platform reports the kit version inside capabilities
    capabilities: { browsers: ["chromium"], ...(over.kitVersion ? { kitVersion: over.kitVersion } : {}) },
});

function kitZip(): Uint8Array {
    // A small real zip, with the secret inside where a real kit has it. The page must never read it.
    return zipSync({ "start-runner.cmd": strToU8("@echo off\r\n"), "start-runner.sh": strToU8("#!/bin/sh\n"), "runner/connection.json": strToU8(JSON.stringify({ token: SECRET })) });
}

async function front(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", BASE);
    const p = url.pathname;
    const method = req.method ?? "GET";
    const json = (status: number, data: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
    if (!fake.enabled) return forward(req, res, body);

    let m: RegExpMatchArray | null;
    if (/^\/api\/projects\/[^/]+\/runner-kits\/info$/.test(p) && method === "GET") {
        if (fake.infoStatus !== 200) return json(fake.infoStatus, { error: "The runner download is not available here." });
        return json(200, fake.info);
    }
    if (/^\/api\/projects\/[^/]+\/runner-kits$/.test(p) && method === "POST") {
        const b = JSON.parse(body.toString() || "{}") as { name: string; platform: string; kind?: string; complete?: boolean; arch?: string; os?: string };
        fake.kitRequests.push({ ...b, key: req.headers["x-api-key"] as string | undefined });
        if (b.complete && fake.kit === "ok") {
            // The complete download: named by system and processor, as the platform does.
            const target = `${b.platform === "windows" ? "win" : b.os}-${b.arch}`;
            const token: FakeToken = { id: `tok-k${++fake.seq}`, label: b.name, hint: `aitg_…${SECRET.slice(-4)}`, createdAt: iso(0), lastUsedAt: null, revokedAt: null };
            fake.tokens.push(token);
            const slug = b.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
            res.writeHead(200, {
                "content-type": "application/zip",
                "content-disposition": `attachment; filename="runner-${slug}-${target}.zip"`,
                "x-runner-token-id": token.id,
                "x-runner-kit-kind": "complete",
                "x-runner-kit-target": target,
                "access-control-expose-headers": "x-runner-token-id, content-disposition, x-runner-kit-kind, x-runner-kit-note, x-runner-kit-target",
            }).end(Buffer.from(kitZip()));
            return;
        }
        if (fake.kit === 409) return json(409, { error: "This project already has 20 runner accesses, the most it can have." });
        if (fake.kit === 503) return json(503, { error: "The runner download has not been built on this server." });
        if (fake.kit === 400) return json(400, { error: "Give the runner a name of 1 to 60 characters." });
        if (fake.kit === 500) return json(500, { error: "Something went wrong while making the download." });
        const token: FakeToken = { id: `tok-k${++fake.seq}`, label: b.name, hint: `aitg_…${SECRET.slice(-4)}`, createdAt: iso(0), lastUsedAt: null, revokedAt: null };
        fake.tokens.push(token);
        const zip = kitZip();
        const installer = b.kind === "installer" && !fake.installerFallback;
        const slug = b.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        res.writeHead(200, {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="runner-${slug}-${installer ? (b.platform === "windows" ? "windows" : "mac") + "-setup" : b.platform}.zip"`,
            "x-runner-token-id": token.id,
            "x-runner-kit-kind": installer ? "installer" : "files",
            ...(b.kind === "installer" && !installer ? { "x-runner-kit-note": "The Windows installer has not been built on this server. A plain files kit was made instead." } : {}),
            "access-control-expose-headers": "x-runner-token-id, content-disposition, x-runner-kit-kind, x-runner-kit-note",
        }).end(Buffer.from(zip));
        return;
    }
    if (/^\/api\/projects\/[^/]+\/agent-tokens$/.test(p) && method === "GET") return json(200, [...fake.tokens].reverse());
    if ((m = p.match(/^\/api\/projects\/[^/]+\/agent-tokens\/([^/]+)$/)) && method === "DELETE") {
        const t = fake.tokens.find((x) => x.id === m![1]);
        if (!t) return json(404, { error: "That access does not exist." });
        t.revokedAt = iso(0);
        fake.deleted.push(t.id);
        return json(200, { ok: true });
    }
    if (/^\/api\/projects\/[^/]+\/agents$/.test(p) && method === "GET") {
        fake.agentRequests++;
        return json(200, [...fake.agents].sort((a, b) => Number(b.online) - Number(a.online)));
    }
    return forward(req, res, body);
}

async function forward(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) {
    const method = req.method ?? "GET";
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "connection", "content-length"].includes(k)) headers[k] = v;
    const upstream = await fetch(`http://127.0.0.1:${PLATFORM_PORT}${req.url}`, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : new Uint8Array(body) });
    const out: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
        if (!["content-encoding", "transfer-encoding", "connection", "content-length"].includes(k)) out[k] = v;
    });
    res.writeHead(upstream.status, out).end(Buffer.from(await upstream.arrayBuffer()));
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
    process.env.AGENT_MAX_TOKENS = "25"; // this file gives one project several runners
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-add-runner-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), PUBLIC_URL: "https://tests.example.com" }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    frontServer = http.createServer((req, res) => void front(req, res).catch((e) => res.writeHead(500).end(String(e))));
    await new Promise<void>((r) => frontServer.listen(FRONT_PORT, "127.0.0.1", r));

    seed = seedProject(platform, "Atlas shop", "http://127.0.0.1:6559");
    addTest(platform, seed, "home page");
    await seedRun(platform, seed, { "home page": "pass" }, { daysAgo: 1 });
    projectId = seed.projectId;

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    page = await context.newPage();
    page.on("console", (m) => {
        // A 409 or 503 the page shows on purpose is logged by the browser as a failed load; that is not a page error.
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

const shots = process.env.KIT_SHOTS;
async function shot(name: string) {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
}
const panel = () => page.getByRole("region", { name: "Add a runner", exact: true });
const status = () => page.getByTestId("kit-status");

/** Open Settings > Runners fresh. `wait` shortens the "still waiting" timer for the tests that need to see it. */
async function open(wait?: number) {
    await page.goto(`${BASE}/#/projects/${projectId}/settings?section=runners${wait ? `&runnerWaitMs=${wait}` : ""}`);
    await page.reload(); // a hash change alone would not re-run the page's loads
    await pwExpect(page.getByRole("heading", { name: "Runners", exact: true })).toBeVisible();
    await pwExpect(page.locator(".skeleton")).toHaveCount(0);
}
async function openPanel(wait?: number) {
    await open(wait);
    await page.getByRole("button", { name: "Add a runner", exact: true }).click();
    await pwExpect(panel()).toBeVisible();
    await pwExpect(panel().getByRole("radio", { name: /Windows/ })).toBeVisible(); // the kit info has loaded
}
async function chooseAndDownload(name?: string, os?: "Windows" | "Mac or Linux") {
    if (os) await panel().getByRole("radio", { name: new RegExp(os) }).check();
    if (name !== undefined) await panel().getByLabel("Name", { exact: true }).fill(name);
    await panel().getByRole("button", { name: "Continue", exact: true }).click();
    await pwExpect(panel().getByText("Step 2 of 3")).toBeVisible();
    const [dl] = await Promise.all([page.waitForEvent("download"), panel().getByRole("button", { name: "Download runner", exact: true }).click()]);
    await pwExpect(page.getByTestId("kit-downloaded")).toBeVisible();
    return dl;
}
async function toStep3(name?: string, os?: "Windows" | "Mac or Linux") {
    await chooseAndDownload(name, os);
    await panel().getByRole("button", { name: "Continue", exact: true }).click();
    await pwExpect(panel().getByText("Step 3 of 3")).toBeVisible();
}

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
async function smallTargets() {
    // Measure the label row of a radio, not the 16 px circle; every button and field inside the panel must be at least 44 px tall.
    const small = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>("[data-testid=add-runner] button, [data-testid=add-runner] label.check, [data-testid=add-runner] input:not([type=radio])"))
            .filter((el) => el.offsetParent !== null)
            .map((el) => ({ el: `${el.tagName.toLowerCase()} ${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)}`, h: Math.round(el.getBoundingClientRect().height) }))
            .filter((x) => x.h < 43),
    );
    expect(small).toEqual([]);
}
async function axe() {
    const result = await new AxeBuilder({ page }).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

// ── the small rules, without a browser ──────────────────────────────────────

describe("add a runner: rules", () => {
    it("preselects the computer from what the browser says", () => {
        expect(guessPlatform({ platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" })).toBe("windows");
        expect(guessPlatform({ platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" })).toBe("unix");
        expect(guessPlatform({ platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" })).toBe("unix");
        expect(guessPlatform({ platform: "", userAgent: "" })).toBe("windows"); // unknown: the common case
    });

    it("finds the runner that just connected: its own access first, then its name, then any newcomer; never one that was already online", () => {
        const a = agent({ id: "a1", name: "Old box", tokenId: "tok-old" });
        const b = agent({ id: "a2", name: "Other", tokenId: "tok-x" });
        const c = agent({ id: "a3", name: "Office computer", tokenId: "tok-name" });
        const d = agent({ id: "a4", name: "Mine", tokenId: "tok-mine" });
        const before = new Set(["a1"]);
        expect(findNewRunner([a], { tokenId: "tok-old", name: "Old box", onlineBefore: before })).toBeNull();
        expect(findNewRunner([a, b, d], { tokenId: "tok-mine", name: "Zed", onlineBefore: before })?.id).toBe("a4");
        expect(findNewRunner([a, b, c], { tokenId: "tok-none", name: "office COMPUTER", onlineBefore: before })?.id).toBe("a3");
        expect(findNewRunner([a, b], { tokenId: null, name: "Zed", onlineBefore: before })?.id).toBe("a2");
        expect(findNewRunner([{ ...b, online: false }], { tokenId: null, name: "Other", onlineBefore: before })).toBeNull();
    });

    it("keeps the wait at three minutes unless a sensible shorter one is asked for", () => {
        expect(waitLimitMs(new URLSearchParams(""))).toBe(180_000);
        expect(waitLimitMs(new URLSearchParams("runnerWaitMs=1500"))).toBe(1500);
        expect(waitLimitMs(new URLSearchParams("runnerWaitMs=5"))).toBe(180_000);
        expect(waitLimitMs(new URLSearchParams("runnerWaitMs=99999999"))).toBe(180_000);
        expect(waitLimitMs(new URLSearchParams("runnerWaitMs=abc"))).toBe(180_000);
    });

    it("words the failures plainly and tells the limit apart", () => {
        expect(downloadErrorText(new KitError(409, "Too many."))).toEqual({ text: "Too many.", limit: true });
        expect(downloadErrorText(new KitError(503, "Not built.")).text).toContain("Ask whoever runs the platform");
        expect(downloadErrorText(new KitError(400, "Bad name.")).text).toBe("Bad name.");
        expect(startInstructions("windows").steps.join(" ")).toContain("start-runner.cmd");
        expect(startInstructions("unix").command).toBe("sh start-runner.sh");
    });

    it("offers the installer only where the server has one, and never picks an installer that is not there", () => {
        const both = { installer: { windows: true, mac: true } };
        const winOnly = { installer: { windows: true, mac: false } };
        const mac = { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" };
        const linux = { platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" };
        expect(installerAvailable(both, "windows")).toBe(true);
        expect(installerAvailable(winOnly, "unix")).toBe(false);
        expect(installerAvailable({}, "windows")).toBe(false); // a server that predates installers
        expect(defaultKind(both, "windows")).toBe("installer");
        expect(defaultKind(both, "unix", mac)).toBe("installer");
        expect(defaultKind(both, "unix", linux)).toBe("files"); // the app is for macOS
        expect(defaultKind(winOnly, "unix", mac)).toBe("files");
        expect(defaultKind({}, "windows")).toBe("files");
        expect(effectiveKind(both, "windows", null)).toBe("installer");
        expect(effectiveKind(both, "windows", "files")).toBe("files");
        expect(effectiveKind(winOnly, "unix", "installer")).toBe("files");
        expect(effectiveKind({}, "windows", "installer")).toBe("files");
    });

    it("tells the person what to do with the installer, in plain words, including the unsigned warning", () => {
        const win = startInstructions("windows", "installer", 24);
        expect(win.steps[0]).toBe("Open the folder you unzipped.");
        expect(win.steps[1]).toBe("Double-click AITestingRunnerSetup.exe. If Windows says “Windows protected your PC”, choose More info, then Run anyway: the installer is not signed yet.");
        expect(win.steps[2]).toContain("It checks what your computer already has, and only downloads what is missing: Node.js and the test tools. You do not need to install anything first.");
        expect(win.command).toBeUndefined();
        expect(win.nodeHelp).toContain("You do not need to install Node.js first");
        const mac = startInstructions("unix", "installer", 24);
        expect(mac.steps[1]).toContain("could not verify the app, because it is not signed yet");
        expect(mac.steps[1]).toContain("Privacy & Security");
        expect(mac.steps[1]).toContain("Open Anyway");
        expect(mac.note).toContain("xattr -dr com.apple.quarantine");
        for (const s of [...win.steps, ...mac.steps, win.nodeHelp, mac.note ?? ""]) expect(s).not.toMatch(/!|seamless|leverage|unlock|empower/i);
    });
});

// ── journeys ────────────────────────────────────────────────────────────────

describe("Add a runner panel", () => {
    it("starts with an inviting empty state and opens the first step with the computer preselected", async () => {
        resetFake();
        await open();
        await pwExpect(page.getByText("No runners yet", { exact: true })).toBeVisible();
        await pwExpect(page.getByText("Most people do not need one.")).toBeVisible();
        await pwExpect(page.getByText("Add one to run tests on a computer where your app can be reached.")).toBeVisible();
        await shot("empty-light-1280");
        await page.getByRole("button", { name: "Add a runner", exact: true }).click();
        await pwExpect(panel()).toBeVisible();
        await pwExpect(panel().getByText("Step 1 of 3")).toBeVisible();
        await pwExpect(panel().getByRole("heading", { name: "Choose the computer", exact: true })).toBeFocused();
        await pwExpect(panel().getByText("A runner is a small program on a computer where your app can be reached.")).toBeVisible();
        await pwExpect(panel().getByText("nobody opens a door into your network")).toBeVisible();
        // the test machine is Windows: that is the preselected choice; the other choice is one click away
        const picked = await panel().getByRole("radio", { name: /Windows/ }).isChecked();
        const other = await panel().getByRole("radio", { name: /Mac or Linux/ }).isChecked();
        expect(picked !== other).toBe(true);
        await pwExpect(panel().getByLabel("Name", { exact: true })).toHaveValue("Office computer");
        await pwExpect(panel().getByText(/Phone testing and visible browser windows need a runner on a computer you can see/)).toBeVisible();
        // The place is called Settings since round 25; the link's words still say Setup (reported to the lead), its address is current.
        await pwExpect(panel().getByRole("link", { name: "Settings, Mobile app" })).toHaveAttribute("href", `#/projects/${projectId}/settings?section=mobile`);
        await shot("step1-light-1280");
        // the add button hides while the panel is open; Close puts it back
        await pwExpect(page.getByRole("button", { name: "Add a runner", exact: true })).toHaveCount(0);
        await panel().getByRole("button", { name: "Close", exact: true }).click();
        await pwExpect(panel()).toHaveCount(0);
    });

    it("preselects Mac or Linux on a Mac", async () => {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" });
        await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }));
        const mac = await ctx.newPage();
        try {
            resetFake();
            await mac.goto(`${BASE}/#/projects/${projectId}/settings?section=runners`);
            await mac.reload();
            await mac.getByRole("button", { name: "Add a runner", exact: true }).click();
            await pwExpect(mac.getByRole("radio", { name: /Mac or Linux/ })).toBeChecked();
        } finally {
            await ctx.close();
        }
    });

    it("says plainly when the server cannot make a download, and offers the guide", async () => {
        resetFake();
        fake.info = { ...INFO_OK, available: false, reason: "The runner download was not prepared on this server." };
        await openPanel();
        const msg = page.getByTestId("kit-unavailable");
        await pwExpect(msg).toContainText("The runner download was not prepared on this server.");
        await pwExpect(msg).toContainText("Ask whoever runs the platform");
        await pwExpect(msg.getByRole("button", { name: "See how", exact: true })).toBeVisible();
        await pwExpect(panel().getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
        await shot("unavailable-light-1280");
        await msg.getByRole("button", { name: "See how", exact: true }).click();
        await pwExpect(page.getByRole("complementary", { name: "Help" }).or(page.getByRole("dialog", { name: /Run tests on your own computer/ }))).toContainText("A runner is a computer, other than the platform");
    });

    it("shows a calm warning when the platform's address will not work from another computer, and still lets you go on", async () => {
        resetFake();
        fake.info = { ...INFO_OK, urlOk: false, urlWarning: "The platform’s address is localhost, which only works on this computer.", platformUrl: "http://localhost:4000" };
        await openPanel();
        await pwExpect(panel()).toContainText("The runner may not be able to find this platform");
        await pwExpect(panel()).toContainText("localhost, which only works on this computer");
        await pwExpect(panel()).toContainText("The runner will try http://localhost:4000");
        await pwExpect(panel().getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
        await shot("url-warning-light-1280");
    });

    it("shows a remark about an address that works as a calm note, not a warning", async () => {
        resetFake();
        fake.info = { ...INFO_OK, platformUrl: "http://127.0.0.1:4000", urlWarning: "This is an address on this computer. Only a runner on this computer can use it." };
        await openPanel();
        await pwExpect(panel()).toContainText("Only a runner on this computer can use it.");
        await pwExpect(panel()).not.toContainText("The runner may not be able to find this platform");
    });

    it("shows a retry when the download information cannot be loaded", async () => {
        resetFake();
        fake.infoStatus = 500;
        await open();
        await page.getByRole("button", { name: "Add a runner", exact: true }).click();
        await pwExpect(panel().getByRole("button", { name: "Try again", exact: true })).toBeVisible();
        fake.infoStatus = 200;
        await panel().getByRole("button", { name: "Try again", exact: true }).click();
        await pwExpect(panel().getByRole("radio", { name: /Windows/ })).toBeVisible();
    });

    it("needs a name before it goes on", async () => {
        resetFake();
        await openPanel();
        await panel().getByLabel("Name", { exact: true }).fill("   ");
        await panel().getByRole("button", { name: "Continue", exact: true }).click();
        await pwExpect(panel().getByText("Step 1 of 3")).toBeVisible();
        await pwExpect(panel().getByText("Give it a name of 1 to 60 characters.")).toBeVisible();
        await pwExpect(panel().getByLabel("Name", { exact: true })).toHaveAttribute("aria-invalid", "true");
    });

    it("downloads a real zip, warns about the secret first, and never puts it on the page", async () => {
        resetFake();
        await openPanel();
        await panel().getByRole("radio", { name: /Windows/ }).check();
        await panel().getByLabel("Name", { exact: true }).fill("Maya’s laptop");
        await panel().getByRole("button", { name: "Continue", exact: true }).click();
        await pwExpect(panel().getByText("Step 2 of 3")).toBeVisible();
        await pwExpect(panel().getByRole("heading", { name: "Download and unzip", exact: true })).toBeFocused();
        // the notice comes before the download
        await pwExpect(panel()).toContainText("This file contains a secret that lets a computer run tests for this project. Don’t share it. Delete it after the runner connects.");
        expect(fake.kitRequests).toEqual([]);
        await shot("step2-light-1280");

        const [dl] = await Promise.all([page.waitForEvent("download"), panel().getByRole("button", { name: "Download runner", exact: true }).click()]);
        expect(dl.suggestedFilename()).toBe("runner-maya-s-laptop-windows.zip");
        const bytes = fs.readFileSync((await dl.path())!);
        expect(bytes.subarray(0, 2).toString()).toBe("PK"); // a real zip
        // Changed with the installer: the page always says which kind it wants. This stand-in server has no installers, so it asks for plain files.
        expect(fake.kitRequests).toEqual([{ name: "Maya’s laptop", platform: "windows", kind: "files", key: undefined }]);

        const done = page.getByTestId("kit-downloaded");
        await pwExpect(done).toContainText("runner-maya-s-laptop-windows.zip");
        await pwExpect(done).toContainText("Access created: Maya’s laptop (remove it any time under Access for runners).");
        await pwExpect(done).toContainText("Unzip it on the computer where your app can be reached. Unzip means right-click, then Extract all.");
        await shot("step2-done-light-1280");
        // the secret is in the file only: not on screen, not in storage, not in the address
        expect(await page.content()).not.toContain(SECRET);
        expect(await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }))).not.toContain("aitg_");
        expect(page.url()).not.toContain("aitg_");
        // the new access is listed, by name, with a way to remove it
        const access = page.locator("[data-access]");
        await pwExpect(access).toHaveCount(1);
        await pwExpect(access).toContainText("Maya’s laptop");
        await pwExpect(access).toContainText("Not used yet");
        await pwExpect(access.getByRole("button", { name: "Remove access for Maya’s laptop", exact: true })).toBeVisible();
    });

    it("sends the access key and says what to do on a Mac or Linux computer", async () => {
        resetFake();
        await openPanel();
        await page.evaluate(() => localStorage.setItem("aitp.apiKey", "k-test")); // the page sends it as x-api-key, checked on the request below
        await chooseAndDownload("Build box", "Mac or Linux");
        expect(fake.kitRequests.at(-1)).toMatchObject({ name: "Build box", platform: "unix", key: "k-test" });
        await pwExpect(panel()).toContainText("double-click the file on a Mac, or run unzip on Linux");
        await panel().getByRole("button", { name: "Continue", exact: true }).click();
        await pwExpect(panel().getByRole("heading", { name: "Start it", exact: true })).toBeFocused();
        await pwExpect(panel().getByTestId("kit-command")).toHaveText("sh start-runner.sh");
        // Changed with the Node.js discovery work: the Mac steps now avoid the permission and unidentified-developer prompts (drag the folder into Terminal, run sh).
        await pwExpect(panel().getByText("Open Terminal, type cd and a space, drag the unzipped folder into the Terminal window, and press Enter.")).toBeVisible();
        await pwExpect(panel().getByText("Run the command below. This way macOS does not ask for permission first.")).toBeVisible();
        await pwExpect(panel().getByText("You can also double-click start-runner.command. If macOS says it could not verify the file, open System Settings, Privacy & Security and choose Open Anyway (on macOS 14 or older, right-click the file and choose Open).")).toBeVisible();
        await pwExpect(panel().getByTestId("kit-node-help")).toHaveText("If it says it cannot find Node.js but you have it, open Terminal and run node --version there. If that works, run start-runner.sh from that same window.");
        await pwExpect(panel().getByText(/If you are asked to install Node.js, say yes\. Node.js is the free program the runner is built on, and it needs version 24 or newer\./)).toBeVisible();
        await page.evaluate(() => localStorage.removeItem("aitp.apiKey"));
    });

    it("explains each failed download in plain words, with Try again", async () => {
        const cases: Array<{ mode: KitMode; text: string; title: string }> = [
            { mode: 409, text: "This project already has 20 runner accesses, the most it can have.", title: "This project has all the runner access it can have" },
            { mode: 503, text: "The runner download has not been built on this server. Ask whoever runs the platform to prepare the runner download.", title: "The download did not work" },
            { mode: 400, text: "Give the runner a name of 1 to 60 characters.", title: "The download did not work" },
            { mode: 500, text: "Something went wrong while making the download.", title: "The download did not work" },
        ];
        for (const c of cases) {
            resetFake();
            fake.kit = c.mode;
            await openPanel();
            await panel().getByRole("button", { name: "Continue", exact: true }).click();
            await panel().getByRole("button", { name: "Download runner", exact: true }).click();
            const alert = panel().getByRole("alert");
            await pwExpect(alert).toContainText(c.title);
            await pwExpect(alert).toContainText(c.text);
            await pwExpect(panel().getByText("Access created:")).toHaveCount(0);
            if (c.mode === 409) {
                await pwExpect(alert).toContainText("Remove access you no longer use under Access for runners");
                await pwExpect(alert.getByRole("button", { name: "Go to Access for runners", exact: true })).toBeVisible();
                await shot("error-409-light-1280");
            }
            if (c.mode === 503) await shot("error-503-light-1280");
            // fixed on the server: Try again works
            fake.kit = "ok";
            const [dl] = await Promise.all([page.waitForEvent("download"), alert.getByRole("button", { name: "Try again", exact: true }).click()]);
            expect(dl.suggestedFilename()).toMatch(/\.zip$/);
            await pwExpect(page.getByTestId("kit-downloaded")).toBeVisible();
            await pwExpect(panel().getByRole("alert")).toHaveCount(0);
        }
        // the 409 case: a project with access already has the list the message points to
    });

    it("waits, then says Connected when the runner for that download comes online, and Done closes the panel", async () => {
        resetFake();
        // someone else's runner is already online: it must not be mistaken for the new one
        fake.agents = [agent({ id: "ag-old", name: "Build server", tokenId: "tok-old" })];
        await openPanel();
        await toStep3("Office computer", "Windows");
        await pwExpect(panel().getByText("Open the folder you unzipped.")).toBeVisible();
        await pwExpect(panel().getByText("start-runner.cmd", { exact: true })).toBeVisible();
        await pwExpect(panel().getByTestId("kit-node-help")).toHaveText("If it says it cannot find Node.js but you have it, open Command Prompt and run node --version there. If that works, run start-runner.cmd from that same window.");
        await pwExpect(panel().getByText("The first start downloads what it needs and can take a few minutes. Leave the window open.")).toBeVisible();
        await pwExpect(status()).toHaveAttribute("data-state", "waiting");
        await pwExpect(status()).toContainText("Waiting for your runner to connect…");
        await shot("step3-waiting-light-1280");
        await page.waitForTimeout(3500); // a poll has happened: the older runner does not count
        await pwExpect(status()).toHaveAttribute("data-state", "waiting");
        await pwExpect(panel().getByRole("button", { name: "Done", exact: true })).toHaveCount(0);

        // the runner starts under the access made for this download, with a name of its own
        const tokenId = fake.tokens.at(-1)!.id;
        fake.agents.push(agent({ id: "ag-new", name: "DESKTOP-4F2K", tokenId, kitVersion: "1.4.0" }));
        await pwExpect(status()).toHaveAttribute("data-state", "connected", { timeout: 15_000 });
        await pwExpect(status()).toContainText("Connected: DESKTOP-4F2K is online");
        await shot("step3-connected-light-1280");
        await panel().getByRole("button", { name: "Done", exact: true }).click();
        await pwExpect(panel()).toHaveCount(0);
        // the list shows it, first, with the kit version
        const row = page.locator("[data-agent='ag-new']");
        await pwExpect(row).toBeVisible({ timeout: 15_000 });
        await pwExpect(row).toContainText("Runner download 1.4.0");
        await pwExpect(page.locator("[data-agent]").first()).toHaveAttribute("data-agent", /ag-/);
    });

    it("matches by the name typed when the access cannot tell, and by newcomer when the name differs", async () => {
        for (const how of ["name", "newcomer"] as const) {
            resetFake();
            await openPanel();
            await toStep3("Lab Mac", "Mac or Linux");
            fake.agents.push(agent({ id: "ag-x", name: how === "name" ? "lab mac" : "something-else", tokenId: "tok-unrelated" }));
            await pwExpect(status()).toHaveAttribute("data-state", "connected", { timeout: 15_000 });
            await pwExpect(status()).toContainText(how === "name" ? "Connected: lab mac is online" : "Connected: something-else is online");
        }
    });

    it("says what is likely wrong after a long wait, and still notices a late connection", async () => {
        resetFake();
        await openPanel(1500);
        await toStep3("Slow computer", "Windows");
        await pwExpect(status()).toHaveAttribute("data-state", "slow", { timeout: 10_000 });
        const slow = page.getByTestId("kit-slow");
        await pwExpect(slow).toContainText("Still waiting. Common reasons:");
        const reasons = slow.getByRole("listitem");
        await pwExpect(reasons.first()).toContainText("The window was closed. Open start-runner.cmd again and leave the window open.");
        // Changed with the Node.js discovery work: a Node.js that is installed but not on the script's PATH is not "not installed".
        await pwExpect(slow).toContainText("The runner cannot find Node.js. If you have it, open Command Prompt, run node --version there, and start start-runner.cmd from that same window. If you do not, install Node.js 24 or newer from nodejs.org");
        await pwExpect(slow).toContainText("A firewall blocks outbound connections");
        await pwExpect(slow).toContainText("The address needs https");
        await shot("step3-slow-light-1280");
        fake.agents.push(agent({ id: "ag-late", name: "Slow computer", tokenId: fake.tokens.at(-1)!.id }));
        await pwExpect(status()).toHaveAttribute("data-state", "connected", { timeout: 15_000 });
        await pwExpect(slow).toHaveCount(0);
    });

    it("puts the address problem first in the long-wait list when the platform's address looked wrong", async () => {
        resetFake();
        fake.info = { ...INFO_OK, urlOk: false, urlWarning: "That address is only for this computer.", platformUrl: "http://localhost:4000" };
        await openPanel(1500);
        await toStep3("Far computer");
        await pwExpect(page.getByTestId("kit-slow")).toBeVisible({ timeout: 10_000 });
        await pwExpect(page.getByTestId("kit-slow").getByRole("listitem").first()).toContainText("http://localhost:4000");
    });

    it("stops polling when the panel closes, and pauses while the tab is hidden", async () => {
        resetFake();
        await openPanel();
        await toStep3();
        const base = fake.agentRequests;
        // hidden tab: no new requests are scheduled
        await page.evaluate(() => {
            Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        });
        await page.waitForTimeout(6000); // a poll already scheduled may still fire once (the page refreshes its own list every 5 s)
        const paused = fake.agentRequests;
        await page.waitForTimeout(4500);
        expect(fake.agentRequests - paused).toBeLessThanOrEqual(0);
        expect(paused).toBeGreaterThan(base - 1);
        // visible again: it asks straight away
        await page.evaluate(() => {
            Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
            document.dispatchEvent(new Event("visibilitychange"));
        });
        await pwExpect.poll(() => fake.agentRequests, { timeout: 8000 }).toBeGreaterThan(paused);
        // closed: the step is gone, and so is its polling (the page itself still refreshes the list every 5 s)
        await panel().getByRole("button", { name: "Close", exact: true }).click();
        await pwExpect(panel()).toHaveCount(0);
        const closedAt = fake.agentRequests;
        await page.waitForTimeout(6500);
        expect(fake.agentRequests - closedAt).toBeLessThanOrEqual(3); // only the page's own 5 s refresh (at most ~1-2), not a 3 s poll on top
    });

    it("keeps working with the keyboard alone, and Escape leaves the panel", async () => {
        resetFake();
        await open();
        await page.getByRole("button", { name: "Add a runner", exact: true }).focus();
        await page.keyboard.press("Enter");
        await pwExpect(panel().getByRole("heading", { name: "Choose the computer", exact: true })).toBeFocused();
        await pwExpect(panel().getByRole("radio", { name: /Windows/ })).toBeVisible();
        await page.keyboard.press("Tab"); // the first radio group member
        await pwExpect(panel().getByRole("radio").first().or(panel().getByRole("radio", { checked: true }).first())).toBeFocused();
        await panel().getByLabel("Name", { exact: true }).focus();
        await page.keyboard.press("ControlOrMeta+A");
        await page.keyboard.type("Keyboard laptop");
        await page.keyboard.press("Enter"); // Enter in the field goes on
        await pwExpect(panel().getByText("Step 2 of 3")).toBeVisible();
        const download = panel().getByRole("button", { name: "Download runner", exact: true });
        await download.focus();
        const ring = await download.evaluate((el) => getComputedStyle(el).boxShadow + getComputedStyle(el).outlineStyle);
        expect(ring).not.toBe("nonenone"); // the focus ring is visible
        const [dl] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Enter")]);
        expect(dl.suggestedFilename()).toContain("keyboard-laptop");
        await panel().getByRole("button", { name: "Continue", exact: true }).focus();
        await page.keyboard.press("Enter");
        await pwExpect(panel().getByText("Step 3 of 3")).toBeVisible();
        await page.keyboard.press("Escape");
        await pwExpect(panel()).toHaveCount(0);
        // the back button path
        await page.getByRole("button", { name: "Add a runner", exact: true }).click();
        await panel().getByRole("button", { name: "Continue", exact: true }).click();
        await panel().getByRole("button", { name: "Back", exact: true }).click();
        await pwExpect(panel().getByText("Step 1 of 3")).toBeVisible();
    });

    it("removes access from a runner card only after an honest confirmation", async () => {
        resetFake();
        fake.tokens = [{ id: "tok-a", label: "Maya’s laptop", hint: "aitg_…x7Qd", createdAt: iso(86_400_000), lastUsedAt: iso(3000), revokedAt: null }];
        fake.agents = [agent({ id: "ag-maya", name: "Maya’s laptop", tokenId: "tok-a", kitVersion: "1.4.0" })];
        await open();
        const card = page.locator("[data-agent='ag-maya']");
        await pwExpect(card).toContainText("Runner download 1.4.0");
        await card.getByRole("button", { name: "Remove access for Maya’s laptop", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Remove access for Maya’s laptop?" });
        await pwExpect(dialog).toBeVisible();
        await pwExpect(dialog).toContainText("This runner will stop and can’t connect again. Tests keep their results.");
        await pwExpect(dialog.getByRole("button", { name: "Keep access", exact: true })).toBeFocused(); // the safe choice first
        await page.keyboard.press("Escape");
        await pwExpect(dialog).toHaveCount(0);
        expect(fake.deleted).toEqual([]);
        await shot("remove-dialog-light-1280");

        await card.getByRole("button", { name: "Remove access for Maya’s laptop", exact: true }).click();
        await dialog.getByRole("button", { name: "Remove access", exact: true }).click();
        await pwExpect(dialog).toHaveCount(0);
        expect(fake.deleted).toEqual(["tok-a"]);
        // the access is gone from the list of access too
        await pwExpect(page.locator("[data-access]")).toHaveCount(0);
    });

    it("lists the access nobody has used yet, so a download that was never started can be removed", async () => {
        resetFake();
        fake.tokens = [
            { id: "tok-1", label: "Never started", hint: "aitg_…aaaa", createdAt: iso(2 * 86_400_000), lastUsedAt: null, revokedAt: null },
            { id: "tok-2", label: "Maya’s laptop", hint: "aitg_…bbbb", createdAt: iso(86_400_000), lastUsedAt: iso(1000), revokedAt: null },
            { id: "tok-3", label: "Old one", hint: "aitg_…cccc", createdAt: iso(9 * 86_400_000), lastUsedAt: null, revokedAt: iso(86_400_000) },
        ];
        fake.agents = [agent({ id: "ag-maya", name: "Maya’s laptop", tokenId: "tok-2" })];
        await open();
        const list = page.getByRole("list", { name: "Access for runners", exact: true });
        await pwExpect(list.locator("[data-access]")).toHaveCount(2); // the revoked one is not listed
        await pwExpect(list.locator("[data-access='tok-1']")).toContainText("Not used yet");
        await pwExpect(list.locator("[data-access='tok-2']")).toContainText("Used by Maya’s laptop");
        await list.locator("[data-access='tok-1']").getByRole("button", { name: "Remove access for Never started", exact: true }).click();
        await page.getByRole("dialog", { name: "Remove access for Never started?" }).getByRole("button", { name: "Remove access", exact: true }).click();
        await pwExpect(list.locator("[data-access]")).toHaveCount(1);
        expect(fake.deleted).toEqual(["tok-1"]);
    });

    // ── the installer choice ────────────────────────────────────────────────

    const WITH_INSTALLER = { installer: { windows: true, mac: true, reasons: {} } };

    it("offers the installer first on Windows, sends that choice, and shows the installer's steps with the unsigned warning", async () => {
        resetFake();
        fake.info = { ...INFO_OK, ...WITH_INSTALLER };
        await openPanel();
        await panel().getByRole("radio", { name: /Windows/ }).check();
        const kindBox = page.getByTestId("kit-kind");
        await pwExpect(kindBox.getByText("How do you want to set it up?", { exact: true })).toBeVisible();
        await pwExpect(kindBox.getByRole("radio", { name: /Installer \(recommended\)/ })).toBeChecked();
        await pwExpect(kindBox.getByRole("radio", { name: /Plain files \(advanced\)/ })).not.toBeChecked();
        await pwExpect(kindBox).toContainText("Checks what the computer already has and only downloads what is missing.");
        await shot("installer-step1-light-1280");
        await panel().getByLabel("Name", { exact: true }).fill("Maya’s laptop");
        await panel().getByRole("button", { name: "Continue", exact: true }).click();
        await pwExpect(panel()).toContainText("We make a download for Maya’s laptop on Windows, with the installer.");
        const [dl] = await Promise.all([page.waitForEvent("download"), panel().getByRole("button", { name: "Download runner", exact: true }).click()]);
        expect(dl.suggestedFilename()).toBe("runner-maya-s-laptop-windows-setup.zip");
        expect(fake.kitRequests).toEqual([{ name: "Maya’s laptop", platform: "windows", kind: "installer", key: undefined }]);
        await pwExpect(page.getByTestId("kit-downloaded")).toContainText("runner-maya-s-laptop-windows-setup.zip");
        await pwExpect(page.getByTestId("kit-downloaded")).not.toContainText("plain files");
        await panel().getByRole("button", { name: "Continue", exact: true }).click();
        await pwExpect(panel().getByRole("heading", { name: "Start it", exact: true })).toBeFocused();
        const steps = panel().locator("ol.ag-steps li");
        await pwExpect(steps).toHaveCount(3);
        await pwExpect(steps.nth(0)).toHaveText("Open the folder you unzipped.");
        await pwExpect(steps.nth(1)).toHaveText("Double-click AITestingRunnerSetup.exe. If Windows says “Windows protected your PC”, choose More info, then Run anyway: the installer is not signed yet.");
        await pwExpect(steps.nth(1).locator("b")).toHaveText("AITestingRunnerSetup.exe");
        await pwExpect(steps.nth(2)).toHaveText("Choose Install and start. It checks what your computer already has, and only downloads what is missing: Node.js and the test tools. You do not need to install anything first.");
        await pwExpect(panel().getByTestId("kit-command")).toHaveCount(0);
        await pwExpect(panel().getByTestId("kit-node-help")).toHaveText("You do not need to install Node.js first. If this computer already has Node.js 24 or newer, the installer uses it; if not, it downloads its own copy and changes nothing else on the computer.");
        await pwExpect(panel().getByText(/If you are asked to install Node\.js, say yes/)).toHaveCount(0);
        await pwExpect(status()).toContainText("Waiting for your runner to connect…");
        await shot("installer-step3-light-1280");
        // After it connects the same live line as the plain files, with words for the installer.
        fake.agents.push(agent({ id: "ag-inst", name: "DESKTOP-INST", tokenId: fake.tokens.at(-1)!.id }));
        await pwExpect(status()).toHaveAttribute("data-state", "connected", { timeout: 15_000 });
        await pwExpect(status()).toContainText("Connected: DESKTOP-INST is online");
        await pwExpect(status()).toContainText("You can delete the downloaded file and the unzipped folder now: the installer keeps its own copy.");
    });

    it("gives a Mac the app's steps, and a plain-files choice sends plain files", async () => {
        resetFake();
        fake.info = { ...INFO_OK, ...WITH_INSTALLER };
        await openPanel();
        await panel().getByRole("radio", { name: /Mac or Linux/ }).check();
        await pwExpect(page.getByTestId("kit-kind").getByRole("radio", { name: /Installer/ })).toBeChecked();
        await pwExpect(page.getByTestId("kit-kind")).toContainText("The installer is for a Mac. On Linux, choose plain files.");
        await panel().getByLabel("Name", { exact: true }).fill("Mac mini");
        await panel().getByRole("button", { name: "Continue", exact: true }).click();
        const [dl] = await Promise.all([page.waitForEvent("download"), panel().getByRole("button", { name: "Download runner", exact: true }).click()]);
        expect(dl.suggestedFilename()).toBe("runner-mac-mini-mac-setup.zip");
        expect(fake.kitRequests.at(-1)).toMatchObject({ platform: "unix", kind: "installer" });
        await panel().getByRole("button", { name: "Continue", exact: true }).click();
        const steps = panel().locator("ol.ag-steps li");
        await pwExpect(steps.nth(1)).toContainText("macOS will probably say it could not verify the app, because it is not signed yet");
        await pwExpect(panel().getByText(/xattr -dr com\.apple\.quarantine/)).toBeVisible();
        await pwExpect(panel().getByTestId("kit-command")).toHaveCount(0);
        // The other way in: choose plain files on the same computer.
        await panel().getByRole("button", { name: "Back", exact: true }).click();
        await panel().getByRole("button", { name: "Back", exact: true }).click();
        await panel().getByRole("radio", { name: /Plain files/ }).check();
        await panel().getByRole("button", { name: "Continue", exact: true }).click();
        // The first download is already made, so the step offers it again (this makes new access for the new choice).
        const [dl2] = await Promise.all([page.waitForEvent("download"), panel().getByRole("button", { name: "Download again", exact: true }).click()]);
        expect(dl2.suggestedFilename()).toBe("runner-mac-mini-unix.zip");
        expect(fake.kitRequests.at(-1)).toMatchObject({ platform: "unix", kind: "files" });
    });

    it("says plainly when the server has no installer for this computer, and the plain files go ahead", async () => {
        resetFake();
        fake.info = { ...INFO_OK, installer: { windows: false, mac: true, reasons: { windows: "The Windows installer has not been built on this server." } } };
        await openPanel();
        await panel().getByRole("radio", { name: /Windows/ }).check();
        const installerRadio = page.getByTestId("kit-kind").getByRole("radio", { name: /Installer/ });
        await pwExpect(installerRadio).toBeDisabled();
        await pwExpect(installerRadio).not.toBeChecked();
        await pwExpect(page.getByTestId("kit-kind").getByRole("radio", { name: /Plain files/ })).toBeChecked();
        await pwExpect(page.getByTestId("kit-kind")).toContainText("This server has not prepared an installer for this computer yet. Ask whoever runs the platform, or use plain files.");
        await shot("installer-missing-light-1280");
        await panel().getByRole("button", { name: "Continue", exact: true }).click();
        const [dl] = await Promise.all([page.waitForEvent("download"), panel().getByRole("button", { name: "Download runner", exact: true }).click()]);
        expect(dl.suggestedFilename()).toBe("runner-office-computer-windows.zip");
        expect(fake.kitRequests.at(-1)).toMatchObject({ platform: "windows", kind: "files" });
        // Mac is available on this server: switching the computer brings the installer back as the choice.
        await panel().getByRole("button", { name: "Continue", exact: true }).click();
        await panel().getByRole("button", { name: "Back", exact: true }).click();
        await panel().getByRole("button", { name: "Back", exact: true }).click();
        await panel().getByRole("radio", { name: /Mac or Linux/ }).check();
        await pwExpect(page.getByTestId("kit-kind").getByRole("radio", { name: /Installer/ })).toBeEnabled();
        await pwExpect(page.getByTestId("kit-kind").getByRole("radio", { name: /Installer/ })).toBeChecked();
    });

    it("tells the person when the server made plain files although the installer was asked for", async () => {
        resetFake();
        fake.info = { ...INFO_OK, ...WITH_INSTALLER };
        fake.installerFallback = true;
        await openPanel();
        await panel().getByRole("radio", { name: /Windows/ }).check();
        await panel().getByRole("button", { name: "Continue", exact: true }).click();
        const [dl] = await Promise.all([page.waitForEvent("download"), panel().getByRole("button", { name: "Download runner", exact: true }).click()]);
        expect(dl.suggestedFilename()).toBe("runner-office-computer-windows.zip");
        const done = page.getByTestId("kit-downloaded");
        await pwExpect(done).toContainText("You got plain files, not the installer");
        await pwExpect(done).toContainText("The installer is not ready on this server yet, so this download holds a start script instead.");
        // The steps that follow are the ones for what was really made.
        await panel().getByRole("button", { name: "Continue", exact: true }).click();
        await pwExpect(panel().getByText("Double-click start-runner.cmd.", { exact: false })).toBeVisible();
        await pwExpect(panel().getByTestId("kit-node-help")).toContainText("If it says it cannot find Node.js but you have it");
    });

    it("has the installer steps keyboard-reachable, without sideways scroll, with large targets and no accessibility violations in light and dark", async () => {
        for (const scheme of ["light", "dark"] as const) {
            resetFake();
            fake.info = { ...INFO_OK, ...WITH_INSTALLER };
            await page.emulateMedia({ colorScheme: scheme });
            await page.waitForTimeout(400);
            await page.setViewportSize({ width: 1280, height: 900 });
            await openPanel(1500);
            await panel().getByRole("radio", { name: /Windows/ }).check();
            await axe(); // step 1 with the installer choice
            await page.setViewportSize({ width: 375, height: 800 });
            await noOverflow();
            await smallTargets();
            await page.setViewportSize({ width: 1280, height: 900 });
            await chooseAndDownload("Installer laptop");
            await axe();
            await panel().getByRole("button", { name: "Continue", exact: true }).click();
            await pwExpect(panel().locator("ol.ag-steps li")).toHaveCount(3);
            await axe(); // step 3 waiting, installer words
            await pwExpect(status()).toHaveAttribute("data-state", "slow", { timeout: 10_000 });
            await pwExpect(page.getByTestId("kit-slow")).toContainText("The setup window shows what went wrong");
            await axe();
            await page.setViewportSize({ width: 375, height: 800 });
            await noOverflow();
            await smallTargets();
            await page.setViewportSize({ width: 1280, height: 900 });
        }
        await page.emulateMedia({ colorScheme: null });
        // the choice can be changed with the arrow keys
        resetFake();
        fake.info = { ...INFO_OK, ...WITH_INSTALLER };
        await openPanel();
        await panel().getByRole("radio", { name: /Windows/ }).check();
        await page.getByTestId("kit-kind").getByRole("radio", { name: /Installer/ }).focus();
        await page.keyboard.press("ArrowDown");
        await pwExpect(page.getByTestId("kit-kind").getByRole("radio", { name: /Plain files/ })).toBeChecked();
    });

    // ── the complete download ───────────────────────────────────────────────

    const MB = 1024 * 1024;
    const WITH_COMPLETE = {
        ...WITH_INSTALLER,
        complete: {
            targets: {
                "win-x64": { available: true, bytes: 62 * MB, nodeVersion: "v24.19.0" },
                "win-arm64": { available: true, bytes: 60 * MB, nodeVersion: "v24.19.0" },
                "mac-arm64": { available: true, bytes: 70 * MB, nodeVersion: "v24.19.0" },
                "mac-x64": { available: true, bytes: 72 * MB, nodeVersion: "v24.19.0" },
                "linux-x64": { available: false, reason: "The complete download for Linux on an Intel or AMD processor has not been built on this server." },
                "linux-arm64": { available: false, reason: "Not built." },
            },
        },
    };

    it("guesses system and processor, and puts the complete download first where the server has it (no browser)", () => {
        expect(guessTarget({ platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" })).toBe("win-x64");
        expect(guessTarget({ platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0; ARM64)" })).toBe("win-arm64");
        // A Mac's browser always says Intel; most Macs now have an Apple chip, so that is the guess until the browser says more.
        expect(guessTarget({ platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" })).toBe("mac-arm64");
        expect(guessTarget({ platform: "Linux aarch64", userAgent: "Mozilla/5.0 (X11; Linux aarch64)" })).toBe("linux-arm64");
        expect(guessTarget({ platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" })).toBe("linux-x64");
        expect(targetFromHints("mac-arm64", { architecture: "x86", bitness: "64" })).toBe("mac-x64");
        expect(targetFromHints("win-x64", { architecture: "arm", bitness: "64" })).toBe("win-arm64");
        expect(targetFromHints("win-x64", { architecture: "" })).toBe("win-x64");
        expect(targetFromHints("linux-x64", undefined)).toBe("linux-x64");
        expect(sizeWords(62 * MB)).toBe("about 62 MB");
        expect(sizeWords(undefined)).toBe("");
        expect(defaultKind(WITH_COMPLETE, "windows", undefined, "win-x64")).toBe("complete");
        expect(defaultKind(WITH_COMPLETE, "unix", { platform: "Linux x86_64", userAgent: "X11; Linux" }, "linux-x64")).toBe("files");
        expect(effectiveKind(WITH_COMPLETE, "windows", null, "win-x64")).toBe("complete");
        expect(effectiveKind(WITH_COMPLETE, "windows", "installer", "win-x64")).toBe("installer");
        expect(effectiveKind(WITH_COMPLETE, "windows", "files", "win-x64")).toBe("files");
        // A server without complete builds behaves as before.
        expect(effectiveKind(WITH_INSTALLER, "windows", null, "win-x64")).toBe("installer");
        const win = startInstructions("windows", "complete", 24, { installerInside: true });
        expect(win.steps[1]).toContain("Double-click start-runner.cmd.");
        expect(win.steps[2]).toBe("It starts straight away: this download already has Node.js and the test tools, so nothing is installed. Leave the window open.");
        expect(win.note).toContain("AITestingRunnerSetup.exe");
        expect(win.nodeHelp).toContain("You do not need Node.js");
        expect(startInstructions("unix", "complete").command).toBe("sh start-runner.sh");
        for (const s of [...win.steps, win.nodeHelp, win.note ?? ""]) expect(s).not.toMatch(/!|seamless|leverage|unlock|empower/i);
    });

    it("offers Complete download (recommended) with its size, then Installer, then Plain files, guesses the processor and sends system and processor", async () => {
        resetFake();
        fake.info = { ...INFO_OK, ...WITH_COMPLETE };
        await openPanel();
        await panel().getByRole("radio", { name: /Windows/ }).check();
        const kindBox = page.getByTestId("kit-kind");
        const radios = kindBox.getByRole("radio");
        await pwExpect(radios).toHaveCount(3);
        await pwExpect(radios.nth(0)).toHaveAccessibleName(/^Complete download \(recommended\), about 62 MB/);
        await pwExpect(radios.nth(1)).toHaveAccessibleName(/^Installer\s*Checks what/);
        await pwExpect(radios.nth(2)).toHaveAccessibleName(/^Plain files \(advanced\)/);
        await pwExpect(radios.nth(0)).toBeChecked();
        await pwExpect(kindBox).toContainText("Everything in one download, with its own Node.js and test tools. Nothing else to install.");
        const select = panel().getByLabel("System and processor", { exact: true });
        await pwExpect(select).toHaveValue("win-x64");
        await pwExpect(select.locator("option")).toHaveText(["Windows on an Intel or AMD processor, about 62 MB", "Windows on an ARM processor, about 60 MB"]);
        await pwExpect(page.getByTestId("kit-target-hint")).toHaveText("We guessed Windows on an Intel or AMD processor. Change it if that is wrong.");
        await shot("complete-step1-light-1280");
        await select.selectOption("win-arm64");
        await pwExpect(page.getByTestId("kit-target-hint")).toHaveText("The download for Windows on an ARM processor. It only works on that kind of computer.");
        await pwExpect(radios.nth(0)).toHaveAccessibleName(/about 60 MB/);
        await panel().getByLabel("Name", { exact: true }).fill("Surface");
        await panel().getByRole("button", { name: "Continue", exact: true }).click();
        await pwExpect(panel()).toContainText("We make a complete download for Surface on Windows on an ARM processor, about 60 MB. It holds its own Node.js and test tools, so nothing else is installed.");
        const [dl] = await Promise.all([page.waitForEvent("download"), panel().getByRole("button", { name: "Download runner", exact: true }).click()]);
        expect(dl.suggestedFilename()).toBe("runner-surface-win-arm64.zip");
        expect(fake.kitRequests).toEqual([{ name: "Surface", platform: "windows", complete: true, arch: "arm64", key: undefined }]);
        await panel().getByRole("button", { name: "Continue", exact: true }).click();
        const steps = panel().locator("ol.ag-steps li");
        await pwExpect(steps).toHaveCount(3);
        await pwExpect(steps.nth(1).locator("b")).toHaveText("start-runner.cmd");
        await pwExpect(steps.nth(2)).toHaveText("It starts straight away: this download already has Node.js and the test tools, so nothing is installed. Leave the window open.");
        await pwExpect(panel()).toContainText("You can also double-click AITestingRunnerSetup.exe instead.");
        await pwExpect(panel().getByTestId("kit-node-help")).toContainText("You do not need Node.js: this download brings its own.");
        await pwExpect(panel().getByText(/If you are asked to install Node\.js, say yes/)).toHaveCount(0);
        // Choosing another way still works, and the installer is labelled plainly next to the recommended one.
        resetFake();
        fake.info = { ...INFO_OK, ...WITH_COMPLETE };
        await openPanel();
        await panel().getByRole("radio", { name: /Windows/ }).check();
        await page.getByTestId("kit-kind").getByRole("radio", { name: /^Installer/ }).check();
        await pwExpect(panel().getByLabel("System and processor", { exact: true })).toHaveCount(0);
        await chooseAndDownload("Setup PC");
        expect(fake.kitRequests).toEqual([{ name: "Setup PC", platform: "windows", kind: "installer", key: undefined }]);
    });

    it("on a Mac asks the browser for the processor, offers only what was built for Mac or Linux, and says when Linux has no complete download", async () => {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" });
        await ctx.addInitScript(() => {
            Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" });
            // A Chromium browser on an Intel Mac answers "x86".
            Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => ({ getHighEntropyValues: async () => ({ architecture: "x86", bitness: "64" }) }) });
        });
        const mac = await ctx.newPage();
        const macPanel = () => mac.getByRole("region", { name: "Add a runner", exact: true });
        try {
            resetFake();
            fake.info = { ...INFO_OK, ...WITH_COMPLETE };
            await mac.goto(`${BASE}/#/projects/${projectId}/settings?section=runners`);
            await mac.reload();
            await mac.getByRole("button", { name: "Add a runner", exact: true }).click();
            await pwExpect(mac.getByRole("radio", { name: /Mac or Linux/ })).toBeChecked();
            const select = macPanel().getByLabel("System and processor", { exact: true });
            await pwExpect(select).toHaveValue("mac-x64");
            await pwExpect(mac.getByTestId("kit-target-hint")).toHaveText("We guessed a Mac with an Intel processor. Change it if that is wrong.");
            await pwExpect(select.locator("option")).toHaveText([
                "A Mac with an Apple chip, about 70 MB",
                "A Mac with an Intel processor, about 72 MB",
                "Linux on an Intel or AMD processor (not prepared on this server)",
                "Linux on an ARM processor (not prepared on this server)",
            ]);
            await pwExpect(select.locator("option[value=linux-x64]")).toBeDisabled();
            await pwExpect(macPanel()).toContainText("On Linux, choose the complete download or plain files.");
            await macPanel().getByLabel("Name", { exact: true }).fill("Maya Mac");
            await macPanel().getByRole("button", { name: "Continue", exact: true }).click();
            const [dl] = await Promise.all([mac.waitForEvent("download"), macPanel().getByRole("button", { name: "Download runner", exact: true }).click()]);
            expect(dl.suggestedFilename()).toBe("runner-maya-mac-mac-x64.zip");
            expect(fake.kitRequests).toEqual([{ name: "Maya Mac", platform: "unix", complete: true, arch: "x64", os: "mac", key: undefined }]);
            await macPanel().getByRole("button", { name: "Continue", exact: true }).click();
            await pwExpect(macPanel().getByTestId("kit-command")).toHaveText("sh start-runner.sh");
        } finally {
            await ctx.close();
        }
        // A server whose complete downloads are all for other systems shows the choice disabled, with the reason.
        resetFake();
        fake.info = { ...INFO_OK, ...WITH_INSTALLER, complete: { targets: { "mac-arm64": { available: true, bytes: 70 * MB } } } };
        await openPanel();
        await panel().getByRole("radio", { name: /Windows/ }).check();
        const complete = page.getByTestId("kit-kind").getByRole("radio", { name: /Complete download/ });
        await pwExpect(complete).toBeDisabled();
        await pwExpect(page.getByTestId("kit-kind")).toContainText("This server has not prepared the complete download for this computer yet.");
        await pwExpect(page.getByTestId("kit-kind").getByRole("radio", { name: /Installer \(recommended\)/ })).toBeChecked();
    });

    it("has the complete download keyboard-reachable, without sideways scroll, with large targets and no accessibility violations in light and dark", async () => {
        for (const scheme of ["light", "dark"] as const) {
            resetFake();
            fake.info = { ...INFO_OK, ...WITH_COMPLETE };
            await page.emulateMedia({ colorScheme: scheme });
            await page.waitForTimeout(400);
            await page.setViewportSize({ width: 1280, height: 900 });
            await openPanel(1500);
            await panel().getByRole("radio", { name: /Windows/ }).check();
            await axe();
            await page.setViewportSize({ width: 375, height: 800 });
            await noOverflow();
            await smallTargets();
            await shot(`complete-step1-${scheme}-375`);
            await page.setViewportSize({ width: 1280, height: 900 });
            await chooseAndDownload("Complete laptop");
            await axe();
            await panel().getByRole("button", { name: "Continue", exact: true }).click();
            await pwExpect(status()).toHaveAttribute("data-state", "slow", { timeout: 10_000 });
            await pwExpect(page.getByTestId("kit-slow")).toContainText("The download is for another processor");
            await axe();
            await page.setViewportSize({ width: 375, height: 800 });
            await noOverflow();
            await smallTargets();
            await page.setViewportSize({ width: 1280, height: 900 });
        }
        await page.emulateMedia({ colorScheme: null });
        // The select is reached with Tab after the choice, and changes with the keyboard.
        resetFake();
        fake.info = { ...INFO_OK, ...WITH_COMPLETE };
        await openPanel();
        await panel().getByRole("radio", { name: /Windows/ }).check();
        await page.getByTestId("kit-kind").getByRole("radio", { name: /Complete download/ }).focus();
        await page.keyboard.press("Tab");
        await pwExpect(panel().getByLabel("System and processor", { exact: true })).toBeFocused();
        await page.keyboard.press("ArrowDown");
        await pwExpect(panel().getByLabel("System and processor", { exact: true })).toHaveValue("win-arm64");
    });

    it("keeps the old way under Advanced, closed by default and unchanged", async () => {
        resetFake();
        await open();
        const adv = page.locator("details.ag-add");
        await pwExpect(adv).not.toHaveAttribute("open", "");
        await pwExpect(adv.locator("summary")).toContainText("Advanced: start a runner from the project folder");
        await adv.locator("summary").click();
        await pwExpect(adv.getByTestId("agent-command")).toHaveText(`node bin/ai-test-agent.mjs --url ${BASE} --token <your token>`);
        await pwExpect(adv.getByRole("button", { name: "Create token", exact: true })).toBeVisible();
    });

    it("works on a phone-sized screen without sideways scrolling, with large touch targets, at every step", async () => {
        resetFake();
        fake.agents = [agent({ id: "ag-maya", name: "Maya’s laptop with a very long name to wrap around the narrow screen", tokenId: "tok-a", kitVersion: "1.4.0" })];
        await page.setViewportSize({ width: 375, height: 800 });
        await openPanel(1500);
        await noOverflow();
        await smallTargets();
        await shot("step1-light-375");
        await panel().getByLabel("Name", { exact: true }).fill("A phone-sized name for a runner that is quite long indeed");
        await panel().getByRole("button", { name: "Continue", exact: true }).click();
        await noOverflow();
        await smallTargets();
        await shot("step2-light-375");
        await panel().getByRole("button", { name: "Download runner", exact: true }).click();
        await pwExpect(page.getByTestId("kit-downloaded")).toBeVisible();
        await noOverflow();
        await smallTargets();
        await panel().getByRole("button", { name: "Continue", exact: true }).click();
        await pwExpect(status()).toHaveAttribute("data-state", "slow", { timeout: 10_000 });
        await noOverflow();
        await smallTargets();
        await shot("step3-slow-light-375");
        fake.agents.push(agent({ id: "ag-new", name: "Connected with a long name that wraps nicely", tokenId: fake.tokens.at(-1)!.id }));
        await pwExpect(status()).toHaveAttribute("data-state", "connected", { timeout: 15_000 });
        await noOverflow();
        await smallTargets();
        await shot("step3-connected-light-375");
        await page.setViewportSize({ width: 1280, height: 900 });
    });

    it("has no accessibility violations at any step, in light and dark", async () => {
        for (const scheme of ["light", "dark"] as const) {
            resetFake();
            await page.emulateMedia({ colorScheme: scheme });
            await page.waitForTimeout(400); // colours ease over 140 ms when the scheme flips; audit the settled state
            await openPanel(1500);
            await axe(); // step 1
            await shot(`step1-${scheme}-1280`);
            await chooseAndDownload();
            await axe(); // step 2, after the download, with the access list
            await shot(`step2-done-${scheme}-1280`);
            await panel().getByRole("button", { name: "Continue", exact: true }).click();
            await pwExpect(status()).toHaveAttribute("data-state", "waiting");
            await axe(); // step 3, waiting
            await shot(`step3-waiting-${scheme}-1280`);
            await pwExpect(status()).toHaveAttribute("data-state", "slow", { timeout: 10_000 });
            await axe();
            await shot(`step3-slow-${scheme}-1280`);
            fake.agents.push(agent({ id: `ag-${scheme}`, name: "Office computer", tokenId: fake.tokens.at(-1)!.id }));
            await pwExpect(status()).toHaveAttribute("data-state", "connected", { timeout: 15_000 });
            await axe(); // connected
            await shot(`step3-connected-${scheme}-1280`);
            await panel().getByRole("button", { name: "Done", exact: true }).click();
            await page.locator("[data-agent]").first().getByRole("button", { name: /Remove access for/ }).click();
            await pwExpect(page.getByRole("dialog")).toBeVisible();
            await axe(); // the confirmation dialog
            await page.keyboard.press("Escape");
        }
        await page.emulateMedia({ colorScheme: null });
    });

    it("writes the phone screenshots when asked", async () => {
        if (!shots) return;
        await page.setViewportSize({ width: 390, height: 844 });
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.waitForTimeout(400);
            resetFake();
            await openPanel(1500);
            await shot(`step1-${scheme}-390`);
            await chooseAndDownload();
            await shot(`step2-done-${scheme}-390`);
            await panel().getByRole("button", { name: "Continue", exact: true }).click();
            await shot(`step3-waiting-${scheme}-390`);
            fake.agents.push(agent({ id: `ag-phone-${scheme}`, name: "Office computer", tokenId: fake.tokens.at(-1)!.id }));
            await pwExpect(status()).toHaveAttribute("data-state", "connected", { timeout: 15_000 });
            await shot(`step3-connected-${scheme}-390`);
        }
        await page.emulateMedia({ colorScheme: null });
        await page.setViewportSize({ width: 1280, height: 900 });
    });
});

describe("Add a runner against the real platform", () => {
    // The platform's own runner-kit routes answer. If the runner bundle (npm run build:runner) is not built here, a tiny stand-in bundle
    // with correct checksums is used, so the routes, the zip and the token are real while the program inside is a placeholder.
    let kitDir = "";
    const restore = { dir: process.env.RUNNER_KIT_DIR, installer: process.env.RUNNER_INSTALLER_DIR, maxTokens: process.env.AGENT_MAX_TOKENS };
    let installerDir = "";
    // These journeys download several kits for one project; the one-runner default is covered in runner-limit-unit.test.ts.
    beforeAll(() => {
        process.env.AGENT_MAX_TOKENS = "25";
    });
    /** A small installer folder the way `npm run build:installer` writes one: a stand-in program for Windows and a manifest. No Mac app: that case is shown too. */
    function stubInstaller(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-installer-stub-"));
        fs.mkdirSync(path.join(dir, "win"), { recursive: true });
        const body = "MZ stand-in program";
        fs.writeFileSync(path.join(dir, "win", "AITestingRunnerSetup.exe"), body);
        fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ format: 1, windows: { available: true, files: [{ path: "win/AITestingRunnerSetup.exe", mode: 493, sha256: createHash("sha256").update(body).digest("hex") }] } }));
        return dir;
    }
    function stubBundle(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-kit-stub-"));
        const files = { "runner.mjs": "// stand-in", "task-child.mjs": "// stand-in", "record-child.mjs": "// stand-in", "package.json": '{"name":"runner-stub","type":"module"}' };
        const sha = (t: string) => createHash("sha256").update(t).digest("hex");
        for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), t);
        fs.writeFileSync(
            path.join(dir, "manifest.json"),
            JSON.stringify({ format: 1, platformVersion: "0.0.0", hash: sha("stub"), kitVersion: "0.0.0-stub", nodeMin: 24, files: Object.entries(files).map(([name, t]) => ({ name, bytes: Buffer.byteLength(t), sha256: sha(t) })) }),
        );
        return dir;
    }

    afterAll(() => {
        if (restore.dir === undefined) delete process.env.RUNNER_KIT_DIR;
        else process.env.RUNNER_KIT_DIR = restore.dir;
        if (restore.installer === undefined) delete process.env.RUNNER_INSTALLER_DIR;
        else process.env.RUNNER_INSTALLER_DIR = restore.installer;
        if (restore.maxTokens === undefined) delete process.env.AGENT_MAX_TOKENS;
        else process.env.AGENT_MAX_TOKENS = restore.maxTokens;
        if (kitDir) fs.rmSync(kitDir, { recursive: true, force: true });
        if (installerDir) fs.rmSync(installerDir, { recursive: true, force: true });
    });

    it("downloads a real zip, lists the new access, notices the runner when it says hello, and removes the access", async () => {
        fake.enabled = false; // the front now only forwards
        try {
            installerDir = installerDir || stubInstaller();
            process.env.RUNNER_INSTALLER_DIR = installerDir;
            const realBundle = fs.existsSync(path.join(REPO_ROOT, "dist/runner/manifest.json"));
            if (!realBundle) {
                kitDir = stubBundle();
                process.env.RUNNER_KIT_DIR = kitDir;
            }
            await open();
            await page.getByRole("button", { name: "Add a runner", exact: true }).click();
            await pwExpect(panel().getByRole("radio", { name: /Windows/ })).toBeVisible();
            await pwExpect(page.getByTestId("kit-unavailable")).toHaveCount(0);
            await panel().getByLabel("Name", { exact: true }).fill("Real kit computer");
            await panel().getByRole("radio", { name: /Windows/ }).check();
            // This server has an installer (a stand-in here), which is the recommended choice; this journey is about the plain files, so choose them.
            await pwExpect(panel().getByRole("radio", { name: /Installer/ })).toBeChecked();
            await panel().getByRole("radio", { name: /Plain files/ }).check();
            await panel().getByRole("button", { name: "Continue", exact: true }).click();
            const [dl] = await Promise.all([page.waitForEvent("download"), panel().getByRole("button", { name: "Download runner", exact: true }).click()]);
            const bytes = fs.readFileSync((await dl.path())!);
            expect(bytes.subarray(0, 2).toString()).toBe("PK");
            expect(dl.suggestedFilename()).toMatch(/.zip$/);
            const files = unzipSync(new Uint8Array(bytes));
            const names = Object.keys(files);
            expect(names.some((n) => n.endsWith("/start-runner.cmd"))).toBe(true);
            const secret = new TextDecoder().decode(files[names.find((n) => n.endsWith("/runner.token"))!]).trim();
            expect(secret).toMatch(/^aitg_/);

            await pwExpect(page.getByTestId("kit-downloaded")).toContainText("Access created: Real kit computer");
            // the platform lists the access under the runner's name; the page shows it and never the secret
            const access = page.locator("[data-access]");
            await pwExpect(access).toHaveCount(1);
            await pwExpect(access).toContainText("Real kit computer");
            expect(await page.content()).not.toContain(secret);
            const listed = (await (await fetch(`http://127.0.0.1:${PLATFORM_PORT}/api/projects/${projectId}/agent-tokens`)).json()) as Array<{ label: string | null }>;
            expect(listed.map((t) => t.label)).toContain("Real kit computer");

            // the runner starts: what the program in the kit does first. The page is on step 3 and sees it come online.
            await panel().getByRole("button", { name: "Continue", exact: true }).click();
            await pwExpect(status()).toHaveAttribute("data-state", "waiting");
            const hello = await fetch(`http://127.0.0.1:${PLATFORM_PORT}/api/agent/hello`, {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
                body: JSON.stringify({ protocol: 1, name: "DESKTOP-REAL", version: "1.0.0", concurrency: 1, capabilities: { os: "win32", arch: "x64", node: "v24.0.0", browsers: ["chromium"], kitVersion: "1.2.3" } }),
            });
            expect(hello.status).toBe(200);
            await pwExpect(status()).toHaveAttribute("data-state", "connected", { timeout: 15_000 });
            await pwExpect(status()).toContainText("Connected: DESKTOP-REAL is online");
            await panel().getByRole("button", { name: "Done", exact: true }).click();
            const card = page.locator("[data-agent]");
            await pwExpect(card).toContainText("DESKTOP-REAL", { timeout: 15_000 });
            await pwExpect(card).toContainText("Runner download 1.2.3");
            await pwExpect(access).toContainText("Used by DESKTOP-REAL");

            // remove access: the platform turns the runner away
            await card.getByRole("button", { name: "Remove access for DESKTOP-REAL", exact: true }).click();
            await page.getByRole("dialog", { name: "Remove access for DESKTOP-REAL?" }).getByRole("button", { name: "Remove access", exact: true }).click();
            await pwExpect(access).toHaveCount(0);
            const again = await fetch(`http://127.0.0.1:${PLATFORM_PORT}/api/agent/hello`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: "{}" });
            expect(again.status).toBeGreaterThanOrEqual(400);
        } finally {
            fake.enabled = true;
        }
    });

    it("downloads the installer zip from the real platform, shows the installer's steps, and offers no Mac installer where none was built", async () => {
        fake.enabled = false;
        try {
            installerDir = installerDir || stubInstaller();
            process.env.RUNNER_INSTALLER_DIR = installerDir;
            if (!fs.existsSync(path.join(REPO_ROOT, "dist/runner/manifest.json"))) {
                kitDir = kitDir || stubBundle();
                process.env.RUNNER_KIT_DIR = kitDir;
            }
            await open();
            await page.getByRole("button", { name: "Add a runner", exact: true }).click();
            await panel().getByRole("radio", { name: /Windows/ }).check();
            await pwExpect(page.getByTestId("kit-kind").getByRole("radio", { name: /Installer/ })).toBeChecked();
            await panel().getByLabel("Name", { exact: true }).fill("Real installer computer");
            await panel().getByRole("button", { name: "Continue", exact: true }).click();
            const [dl] = await Promise.all([page.waitForEvent("download"), panel().getByRole("button", { name: "Download runner", exact: true }).click()]);
            expect(dl.suggestedFilename()).toMatch(/-windows-setup\.zip$/);
            const files = unzipSync(new Uint8Array(fs.readFileSync((await dl.path())!)));
            const names = Object.keys(files);
            expect(names.some((n) => n.endsWith("/AITestingRunnerSetup.exe"))).toBe(true);
            expect(names.some((n) => n.endsWith("/start-runner.cmd"))).toBe(false);
            const readme = new TextDecoder().decode(files[names.find((n) => n.endsWith("/README.txt"))!]);
            expect(readme).toContain("Run anyway");
            const secret = new TextDecoder().decode(files[names.find((n) => n.endsWith("/runner.token"))!]).trim();
            expect(secret).toMatch(/^aitg_/);
            await pwExpect(page.getByTestId("kit-downloaded")).toContainText("-windows-setup.zip");
            expect(await page.content()).not.toContain(secret);
            await panel().getByRole("button", { name: "Continue", exact: true }).click();
            await pwExpect(panel().locator("ol.ag-steps li").nth(1)).toContainText("Double-click AITestingRunnerSetup.exe.");
            // The runner the installer starts says hello with that token, and the page notices it.
            const hello = await fetch(`http://127.0.0.1:${PLATFORM_PORT}/api/agent/hello`, {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
                body: JSON.stringify({ protocol: 1, name: "DESKTOP-SETUP", version: "1.0.0", concurrency: 1, capabilities: { os: "win32", arch: "x64", node: "v24.0.0", browsers: ["chromium"] } }),
            });
            expect(hello.status).toBe(200);
            await pwExpect(status()).toHaveAttribute("data-state", "connected", { timeout: 15_000 });
            await panel().getByRole("button", { name: "Done", exact: true }).click();
            // No Mac installer was built in this stand-in folder: the choice says so and plain files are selected.
            await page.getByRole("button", { name: "Add a runner", exact: true }).click();
            await panel().getByRole("radio", { name: /Mac or Linux/ }).check();
            await pwExpect(page.getByTestId("kit-kind").getByRole("radio", { name: /Installer/ })).toBeDisabled();
            await pwExpect(page.getByTestId("kit-kind").getByRole("radio", { name: /Plain files/ })).toBeChecked();
            await panel().getByRole("button", { name: "Close", exact: true }).click();
        } finally {
            fake.enabled = true;
        }
    });

    it("kept the browser console clean", () => {
        expect(consoleErrors).toEqual([]);
    });
});
