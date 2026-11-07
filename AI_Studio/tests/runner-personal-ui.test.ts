/**
 * The Runners pages for personal and team runners (round 39), in a real browser against the real built UI (web/dist) and a real platform
 * underneath: "Add this computer" (a one-time enrollment code, a download that carries it or a command with it, its 30 minutes shown,
 * waiting for the computer to connect), "Add a team runner" (owner and projects), a runner's page (yours or team, the computer's facts,
 * current work linked to its run, connection problems and the computer check, how to bring it back by system, the owner's switches),
 * and buttons shown only when the server says the person may.
 *
 * The runner routes of this round (POST /api/runners/enroll, GET /api/runners/enrollments/:id, POST /api/runners/kits and its info,
 * PATCH /api/runners/:id switches, the new fields on /api/runners) are a small in-memory stand-in shaped like src/platform/routes/runners.ts
 * and runner-kits.ts, served by a front server that forwards everything else to the platform, so every state can be driven.
 * Ports: 8100 front (the address the browser uses), 8101 platform.
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   TAQWRIGHT_HOME=/nonexistent-taqwright node scripts/with-lock.mjs browser -- npx vitest run tests/runner-personal-ui.test.ts
 */
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
import { codeLife, enrollCommand, findEnrolled } from "../web/src/features/runners/enroll.js";
import { machineFacts, mayAdd, memoryWords, offlineSteps, whose } from "../web/src/features/runners/runners.js";
import { addTest, seedProject, type Seed } from "./fixtures/dashboard-seed.js";

const FRONT_PORT = 8100;
const PLATFORM_PORT = 8101;
const BASE = `http://127.0.0.1:${FRONT_PORT}`;
const CODE = "aite_ONETIMECODE0123456789abcdefghijklmnopqrstu";

// ── the stand-in API ────────────────────────────────────────────────────────

type Json = Record<string, unknown>;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const fake = {
    answer: { canRegister: false, canRegisterShared: false, owners: [] as Array<{ id: string; name: string }>, canAddPersonal: true, canAddTeam: false },
    runners: [] as Json[],
    enrolls: [] as Json[],
    kits: [] as Json[],
    /** Enrollment records by id: what GET /api/runners/enrollments/:id answers. */
    codes: new Map<string, { status: "waiting" | "used" | "expired"; expiresAt: string; runnerId: string | null }>(),
    patches: [] as Array<{ id: string; body: Json }>,
    info: { available: true, platformUrl: "https://tests.example.com", urlOk: true, nodeMin: 24, kitVersion: "2.0.0" } as Json,
    infoStatus: 200,
    enrollStatus: 200,
    lifeMs: 30 * 60_000,
    seq: 0,
};
function resetFake() {
    Object.assign(fake, {
        answer: { canRegister: false, canRegisterShared: false, owners: [], canAddPersonal: true, canAddTeam: false },
        runners: [],
        enrolls: [],
        kits: [],
        codes: new Map(),
        patches: [],
        info: { available: true, platformUrl: "https://tests.example.com", urlOk: true, nodeMin: 24, kitVersion: "2.0.0" },
        infoStatus: 200,
        enrollStatus: 200,
        lifeMs: 30 * 60_000,
        seq: 0,
    });
}

/** A runner as GET /api/runners answers it, with this round's fields. */
function runner(over: Json & { id: string; name: string }): Json {
    const agentOver = (over.agent ?? {}) as Json;
    const agent =
        over.agent === null
            ? null
            : {
                  id: `ag-${over.id}`, name: over.name, version: "2.0.0", tokenId: over.id, os: "win32", arch: "x64", node: "v24.1.0", online: true,
                  lastSeenAt: iso(2_000), firstSeenAt: iso(60_000), activeTasks: 0, concurrency: 1,
                  ...agentOver,
                  capabilities: { browsers: ["chromium"], osVersion: "10.0.26100", playwrightVersion: "1.55.0", memoryMb: 16384, cpus: 8, ...((agentOver.capabilities ?? {}) as Json) },
              };
    const { agent: _a, ...rest } = over;
    const caps = (agent?.capabilities ?? {}) as Json;
    // The server's summary of the computer (runner-health.ts), from the same report.
    const machine = agent ? { os: agent.os, osVersion: caps.osVersion ?? null, arch: agent.arch, memoryMb: caps.memoryMb ?? null, cpus: caps.cpus ?? null, playwrightVersion: caps.playwrightVersion ?? null, agentVersion: agent.version, bound: true } : null;
    const personal = (over.kind ?? "personal") === "personal";
    return {
        machineName: over.name, hint: "aitg_…abcd", organizationId: null, ownerName: "Tess Tester", status: "online", canManage: true, createdAt: iso(120_000), retiredAt: null,
        lastSeenAt: iso(2_000), version: "2.0.0", devices: [], currentTasks: [], queue: { waiting: 0, oldestWaitMs: 0, averageWaitMs: null }, recentFailures: { count: 0, items: [] },
        projects: [], otherProjects: 0, kind: "personal", mine: true, ownerId: "u-tess",
        settings: { codeScripts: personal, codeScriptsSwitch: personal || over.organizationId != null, privateAddresses: !personal, privateAddressesSwitch: personal, realPhone: false, realPhoneSwitch: personal },
        machine,
        ...rest,
        agent,
    };
}

function kitZip(): Uint8Array {
    // Where a real personal kit has it: the one-time code, and no runner credential.
    return zipSync({ "start-runner.cmd": strToU8("@echo off\r\n"), "start-runner.sh": strToU8("#!/bin/sh\n"), "runner/runner.enroll": strToU8(`${CODE}\n`) });
}

async function front(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const p = new URL(req.url ?? "/", BASE).pathname;
    const method = req.method ?? "GET";
    const json = (status: number, data: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
    const read = () => JSON.parse(body.toString() || "{}") as Json;
    let m: RegExpMatchArray | null;
    const newCode = () => {
        const id = `enr-${++fake.seq}`;
        const expiresAt = new Date(Date.now() + fake.lifeMs).toISOString();
        fake.codes.set(id, { status: "waiting", expiresAt, runnerId: null });
        return { id, expiresAt };
    };
    if (p === "/api/runners" && method === "GET") return json(200, { ...fake.answer, runners: fake.runners });
    if (p === "/api/runners/enroll" && method === "POST") {
        fake.enrolls.push(read());
        if (fake.enrollStatus === 409) return json(409, { error: "You have added 5 computers already, the most one person can have. Retire one on the Runners page first." });
        const c = newCode();
        return json(201, { id: c.id, kind: "personal", code: CODE, expiresAt: c.expiresAt });
    }
    if ((m = p.match(/^\/api\/runners\/enrollments\/([^/]+)$/)) && method === "GET") {
        const c = fake.codes.get(m[1]!);
        if (!c) return json(404, { error: "Enrollment code not found" });
        const status = c.status === "waiting" && Date.parse(c.expiresAt) <= Date.now() ? "expired" : c.status;
        const r = c.runnerId ? fake.runners.find((x) => x.id === c.runnerId) : undefined;
        return json(200, { id: m[1], kind: "personal", status, expiresAt: c.expiresAt, runnerId: c.runnerId, ...(r ? { runner: r } : {}) });
    }
    if (p === "/api/runners/kits/info" && method === "GET") return fake.infoStatus === 200 ? json(200, fake.info) : json(fake.infoStatus, { error: "Not found" });
    if (p === "/api/runners/kits" && method === "POST") {
        const b = read();
        fake.kits.push(b);
        if (fake.enrollStatus === 409) return json(409, { error: "You have added 5 computers already, the most one person can have. Retire one on the Runners page first." });
        const c = newCode();
        res.writeHead(200, {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="ai-testing-runner-${b.platform}.zip"`,
            "x-runner-kit-kind": b.kind === "installer" ? "installer" : "files",
            "x-runner-enrollment-id": c.id,
            "x-runner-enrollment-expires": c.expiresAt,
            "access-control-expose-headers": "x-runner-enrollment-id, x-runner-enrollment-expires, content-disposition, x-runner-kit-kind",
        }).end(Buffer.from(kitZip()));
        return;
    }
    if ((m = p.match(/^\/api\/runners\/([^/]+)$/))) {
        const r = fake.runners.find((x) => x.id === m![1]);
        if (!r) return json(404, { error: "Runner not found" });
        if (method === "GET") return json(200, r);
        if (method === "PATCH") {
            const b = read();
            fake.patches.push({ id: r.id as string, body: b });
            const s = r.settings as Json;
            if (typeof b.codeScripts === "boolean") s.codeScripts = b.codeScripts;
            if (typeof b.privateAddresses === "boolean") s.privateAddresses = b.privateAddresses;
            if (typeof b.realPhone === "boolean") s.realPhone = b.realPhone;
            if (typeof b.name === "string") r.name = b.name;
            return json(200, r);
        }
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
const consoleErrors: string[] = [];

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-runner-personal-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), PUBLIC_URL: "https://tests.example.com", SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    frontServer = http.createServer((req, res) => void front(req, res).catch((e) => res.writeHead(500).end(String(e))));
    await new Promise<void>((r) => frontServer.listen(FRONT_PORT, "127.0.0.1", r));
    seed = seedProject(platform, "Atlas shop", "http://127.0.0.1:8109");
    addTest(platform, seed, "home page");
    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"] });
    page = await context.newPage();
    page.on("console", (msg) => {
        // A 409 or 404 the page shows on purpose is logged by the browser as a failed load; that is not a page error.
        if (msg.type() === "error" && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text());
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

const panel = (name = "Add this computer") => page.getByRole("region", { name, exact: true });
const status = () => page.getByTestId("kit-status");
async function openRunners(query = "") {
    await page.goto(`${BASE}/#/runners${query}`);
    await page.reload(); // a hash change alone would not re-run the page's loads
    await pwExpect(page.getByRole("heading", { name: "Runners", level: 1 })).toBeVisible();
    await pwExpect(page.locator(".skeleton")).toHaveCount(0);
}
async function openRunner(id: string, query = "") {
    await page.goto(`${BASE}/#/runners/${id}${query}`);
    await page.reload();
    await pwExpect(page.locator(".skeleton")).toHaveCount(0);
}
async function axe() {
    const result = await new AxeBuilder({ page }).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
async function noOverflow() {
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
}
/** Step 1 to the download, for the person's own computer. */
async function toDownload(name?: string) {
    await openRunners("?runnerWaitMs=1500");
    await page.getByRole("button", { name: "Add this computer", exact: true }).click();
    await pwExpect(panel().getByRole("radio", { name: /Windows/ })).toBeVisible();
    if (name) await panel().getByLabel("Name", { exact: true }).fill(name);
    await panel().getByRole("button", { name: "Continue", exact: true }).click();
    await pwExpect(panel().getByText("Step 2 of 3")).toBeVisible();
}

// ── the small rules, without a browser ──────────────────────────────────────

describe("personal runners: rules", () => {
    it("says how long a code still works, and when it has expired", () => {
        const now = Date.parse("2026-11-07T10:00:00Z");
        expect(codeLife("2026-11-07T10:30:00Z", now)).toMatchObject({ expired: false, minutes: 30 });
        expect(codeLife("2026-11-07T10:30:00Z", now).text).toMatch(/^The code works once, until .+ \(30 more minutes\)\.$/);
        expect(codeLife("2026-11-07T10:00:20Z", now).text).toMatch(/\(1 more minute\)/);
        expect(codeLife("2026-11-07T09:59:59Z", now)).toEqual({ expired: true, minutes: 0, text: "This code has expired. Make a new one." });
        expect(codeLife("not a date", now).expired).toBe(true);
    });

    it("finds the computer that just enrolled: a new runner that is online, its name first, never one listed before", () => {
        const before = new Set(["r-old"]);
        const list = [
            { id: "r-old", name: "My computer", status: "online" },
            { id: "r-other", name: "Something else", status: "online" },
            { id: "r-new", name: "My computer", status: "online" },
            { id: "r-off", name: "My computer", status: "not-connected" },
        ];
        expect(findEnrolled(list, { before, name: "my computer " })?.id).toBe("r-new");
        expect(findEnrolled(list.filter((r) => r.id !== "r-new"), { before, name: "My computer" })?.id).toBe("r-other");
        expect(findEnrolled([list[0]!, list[3]!], { before, name: "My computer" })).toBeNull();
    });

    it("builds the command with the code, and reads the computer's facts from whichever field the server sends", () => {
        expect(enrollCommand("https://tests.example.com", CODE)).toBe(`node bin/ai-test-agent.mjs --url https://tests.example.com --enroll ${CODE}`);
        expect(machineFacts({ os: "darwin", arch: "arm64", version: "2.0.0", node: "v24.1.0", capabilities: { osVersion: "15.1", playwrightVersion: "1.55.0", memoryMb: 16384, cpus: 10 } })).toEqual({
            system: "macOS 15.1", arch: "arm64", memory: "16 GB", cpus: 10, agentVersion: "2.0.0", playwright: "1.55.0", node: "24.1.0",
        });
        // The server's machine summary wins over the agent's own report.
        expect(machineFacts({ os: "linux", arch: "x64", version: "1.0.0" }, { os: "win32", osVersion: "10.0.22631", arch: "arm64", memoryMb: 8192, cpus: 4, playwrightVersion: "1.56.0", agentVersion: "2.1.0" })).toMatchObject({
            system: "Windows 10.0.22631", arch: "arm64", memory: "8 GB", cpus: 4, agentVersion: "2.1.0", playwright: "1.56.0",
        });
        // An older runner reports none of the new fields: they are left out, not made up.
        expect(machineFacts({ os: "win32", arch: "x64", version: "1.0.0", capabilities: { browsers: [] } })).toMatchObject({ system: "Windows", memory: null, cpus: null, playwright: null });
        expect(machineFacts(null).system).toBeNull();
        expect(memoryWords(512 * 1024 ** 2)).toBe("512 MB");
    });

    it("says how to bring a runner back for each system, and who a runner belongs to", () => {
        expect(offlineSteps("win32").join(" ")).toMatch(/notification area next to the clock/);
        expect(offlineSteps("darwin").join(" ")).toMatch(/starts by itself when you sign in/);
        expect(offlineSteps("linux").join(" ")).toMatch(/start-runner\.sh/);
        expect(offlineSteps(undefined)).toHaveLength(1);
        expect(whose({ kind: "personal", mine: true, ownerName: "Tess" }).label).toBe("Yours");
        expect(whose({ kind: "personal", mine: false, ownerName: "Tess" }).tip).toMatch(/^Tess's own computer/);
        expect(whose({ ownerName: "Acme" }).label).toBe("Team");
        // An older server sends only canRegister: that means a team runner, never the person's own computer.
        expect(mayAdd({ canRegister: true })).toEqual({ personal: false, team: true });
        expect(mayAdd({ canRegister: true, canAddPersonal: true, canAddTeam: false })).toEqual({ personal: true, team: false });
    });
});

// ── the pages ───────────────────────────────────────────────────────────────

describe("Runners pages for personal and team runners", () => {
    it("shows a tester only Add this computer, and the empty state says how, with no Linux installer or old settings path", async () => {
        resetFake();
        await openRunners();
        await pwExpect(page.getByRole("button", { name: "Add this computer", exact: true })).toBeVisible();
        await pwExpect(page.getByRole("button", { name: "Add a team runner" })).toHaveCount(0);
        await pwExpect(page.getByRole("button", { name: "Register a runner" })).toHaveCount(0);
        await pwExpect(page.getByTestId("personal-cap")).toHaveCount(0);
        const empty = page.getByText(/Nothing runs until one connects/);
        await pwExpect(empty).toContainText("To run tests on your own computer, choose Add this computer.");
        await pwExpect(empty).not.toContainText(/Settings, Runners|Linux|Most people do not need/);
        await axe();
    });

    it("shows neither button when the server says the person may add nothing, and says why at the cap", async () => {
        resetFake();
        fake.answer.canAddPersonal = false;
        await openRunners();
        await pwExpect(page.getByTestId("runner-add-actions")).toHaveCount(0);
        await pwExpect(page.getByText(/Ask someone who manages runners/)).toBeVisible();
        (fake.answer as Json).personal = { count: 5, max: 5, reason: "You have added 5 computers already, the most one person can have. Retire one on the Runners page first." };
        await openRunners();
        await pwExpect(page.getByTestId("personal-cap")).toContainText("You have added 5 computers already");
    });

    it("adds this computer: says what the computer will do, makes a code, and downloads a runner that carries it", async () => {
        resetFake();
        await openRunners("?runnerWaitMs=1500");
        await page.getByRole("button", { name: "Add this computer", exact: true }).click();
        await pwExpect(panel()).toBeVisible();
        await pwExpect(panel().getByTestId("personal-terms")).toContainText("only the tests you start");
        await pwExpect(panel().getByTestId("personal-terms")).toContainText("the project’s test accounts");
        await pwExpect(panel().getByLabel("Name", { exact: true })).toHaveValue("My computer");
        await pwExpect(panel().getByRole("link", { name: "Settings, Mobile app" })).toHaveCount(0);
        await axe();
        await panel().getByLabel("Name", { exact: true }).fill("Tess’s laptop");
        await panel().getByRole("button", { name: "Continue", exact: true }).click();
        await pwExpect(panel().getByText("The download holds a one-time code")).toBeVisible();
        const [dl] = await Promise.all([page.waitForEvent("download"), panel().getByRole("button", { name: "Download runner", exact: true }).click()]);
        await pwExpect(page.getByTestId("kit-downloaded")).toBeVisible();
        // The server made the download's code itself; the page asked for no other.
        expect(fake.enrolls).toEqual([]);
        expect(fake.kits).toHaveLength(1);
        expect(fake.kits[0]).toMatchObject({ runner: "personal", name: "Tess’s laptop", platform: expect.any(String) });
        const files = unzipSync(new Uint8Array(fs.readFileSync((await dl.path())!)));
        expect(Object.keys(files)).toContain("runner/runner.enroll");
        expect(Object.values(files).some((f) => Buffer.from(f).toString().includes("aitg_"))).toBe(false);
        await pwExpect(page.getByTestId("kit-downloaded").getByTestId("code-life")).toHaveText(/^The code works once, until .+ \((30|29) more minutes\)\.$/);
        // The code is not on the page until the person asks for the command.
        expect(await page.content()).not.toContain(CODE);
        await panel().getByText("Use a command instead").click();
        await panel().getByRole("button", { name: "Show the command" }).click();
        await pwExpect(page.getByTestId("enroll-command").locator("code")).toHaveText(`node bin/ai-test-agent.mjs --url ${BASE} --enroll ${CODE}`);
        expect(fake.enrolls).toEqual([{ kind: "personal", label: "Tess’s laptop" }]);
        await page.getByRole("button", { name: "Copy command" }).click();
        await pwExpect(page.getByRole("button", { name: "Copied" })).toBeVisible();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(`--enroll ${CODE}`);
        // Closing and opening the command again does not make another code.
        await panel().getByText("Use a command instead").click();
        await panel().getByText("Use a command instead").click();
        await pwExpect(page.getByTestId("enroll-command")).toBeVisible();
        expect(fake.enrolls).toHaveLength(1);
        await axe();
    });

    it("waits for the computer with the code's time shown, then says Connected and links to its page", async () => {
        resetFake();
        fake.runners = [runner({ id: "r-old", name: "Old desk", status: "offline" })];
        await toDownload("Tess’s laptop");
        await panel().getByRole("button", { name: "Download runner", exact: true }).click();
        await pwExpect(page.getByTestId("kit-downloaded")).toBeVisible();
        await panel().getByRole("button", { name: "Continue", exact: true }).click();
        await pwExpect(panel().getByText("Step 3 of 3")).toBeVisible();
        await pwExpect(status()).toHaveAttribute("data-state", /waiting|slow/);
        await pwExpect(status().getByTestId("code-life")).toBeVisible();
        await pwExpect(status()).toHaveAttribute("data-state", "slow", { timeout: 10_000 });
        await pwExpect(page.getByTestId("kit-slow")).toContainText("The code was already used");
        // The old runner coming back online is not the new one.
        fake.runners[0]!.status = "online";
        await page.waitForTimeout(3500);
        await pwExpect(status()).not.toHaveAttribute("data-state", "connected");
        // The download's code is traded: the enrollment record names the new runner (its name differs from the one typed).
        fake.runners.push(runner({ id: "r-new", name: "TESS-LAPTOP" }));
        const [id] = [...fake.codes.keys()];
        fake.codes.set(id!, { ...fake.codes.get(id!)!, status: "used", runnerId: "r-new" });
        await pwExpect(status()).toHaveAttribute("data-state", "connected", { timeout: 15_000 });
        await pwExpect(status()).toContainText("Connected: TESS-LAPTOP is online");
        await pwExpect(status().getByRole("link", { name: "Open its page" })).toHaveAttribute("href", "#/runners/r-new");
        await axe();
        await panel().getByRole("button", { name: "Done" }).click();
        await pwExpect(panel()).toHaveCount(0);
    });

    it("says when the code expired before the computer connected, and makes a new one", async () => {
        resetFake();
        fake.lifeMs = 1500;
        await toDownload();
        await panel().getByRole("button", { name: "Download runner", exact: true }).click();
        await pwExpect(page.getByTestId("kit-downloaded")).toBeVisible();
        await panel().getByRole("button", { name: "Continue", exact: true }).click();
        await pwExpect(status()).toHaveAttribute("data-state", "expired", { timeout: 20_000 });
        await pwExpect(status()).toContainText("This code has expired");
        fake.lifeMs = 30 * 60_000;
        await status().getByRole("button", { name: "Make a new code" }).click();
        await pwExpect(panel().getByText("Step 2 of 3")).toBeVisible();
        await panel().getByRole("button", { name: "Download runner", exact: true }).click();
        await pwExpect(page.getByTestId("kit-downloaded")).toBeVisible();
        expect(fake.kits).toHaveLength(2);
    });

    it("shows the server's sentence when no code may be made (five computers already)", async () => {
        resetFake();
        fake.enrollStatus = 409;
        await toDownload();
        await panel().getByRole("button", { name: "Download runner", exact: true }).click();
        await pwExpect(panel().getByText("You have added 5 computers already")).toBeVisible();
    });

    it("still offers the command when this server cannot make a download", async () => {
        resetFake();
        fake.infoStatus = 404;
        await openRunners();
        await page.getByRole("button", { name: "Add this computer", exact: true }).click();
        await pwExpect(panel().getByText("This server cannot make a download yet")).toBeVisible();
        await panel().getByRole("button", { name: "Continue", exact: true }).click();
        await panel().getByRole("button", { name: "Show the command" }).click();
        await pwExpect(page.getByTestId("enroll-command").locator("code")).toContainText(`--enroll ${CODE}`);
        await panel().getByRole("button", { name: "Continue", exact: true }).click();
        await pwExpect(status()).toHaveAttribute("data-state", /waiting|slow/);
    });

    it("opens Add this computer from a link (?add=computer), the way other pages send people here", async () => {
        resetFake();
        await openRunners("?add=computer");
        await pwExpect(panel()).toBeVisible();
        await panel().getByRole("button", { name: "Close" }).click();
        await pwExpect(panel()).toHaveCount(0);
        await pwExpect(page).toHaveURL(/#\/runners$/);
    });

    it("adds a team runner for someone who manages runners: owner and projects go with the code", async () => {
        resetFake();
        fake.answer = { canRegister: true, canRegisterShared: true, owners: [{ id: "org-acme", name: "Acme" }], canAddPersonal: true, canAddTeam: true };
        await openRunners();
        await page.getByRole("button", { name: "Add a team runner" }).click();
        const team = panel("Add a team runner");
        await pwExpect(team).toBeVisible();
        await pwExpect(team.getByTestId("personal-terms")).toHaveCount(0);
        // Acme has no project here; Crowd4Test's shared runners may serve any.
        await pwExpect(team.getByText("No project to give it yet.")).toBeVisible();
        await team.getByLabel("Owner").selectOption({ label: "Crowd4Test (shared)" });
        await team.getByRole("checkbox", { name: "Atlas shop" }).check();
        await team.getByLabel("Name", { exact: true }).fill("Lab Mac");
        await axe();
        await team.getByRole("button", { name: "Continue", exact: true }).click();
        await team.getByRole("button", { name: "Download runner", exact: true }).click();
        await pwExpect(page.getByTestId("kit-downloaded")).toBeVisible();
        expect(fake.enrolls).toEqual([]);
        expect(fake.kits[0]).toMatchObject({ runner: "team", name: "Lab Mac", projectIds: [seed.projectId] });
        expect(fake.kits[0]).not.toHaveProperty("organizationId");
    });

    it("lists yours and team runners apart, with a filter", async () => {
        resetFake();
        fake.runners = [runner({ id: "r-mine", name: "Tess’s laptop" }), runner({ id: "r-team", name: "Lab Mac", kind: "team", mine: false, ownerName: "Acme", organizationId: "org-acme" })];
        await openRunners();
        const list = page.getByRole("list", { name: "Runners" });
        await pwExpect(list.getByRole("link", { name: /Tess’s laptop/ })).toContainText("Yours");
        await pwExpect(list.getByRole("link", { name: /Tess’s laptop/ })).toContainText("Runs the tests you start");
        await pwExpect(list.getByRole("link", { name: /Lab Mac/ })).toContainText("Team");
        await page.getByLabel("Kind").selectOption({ label: "Your computers" });
        await pwExpect(list.getByRole("link")).toHaveCount(1);
        await page.getByLabel("Kind").selectOption({ label: "Team runners" });
        await pwExpect(list.getByRole("link", { name: /Lab Mac/ })).toBeVisible();
        await pwExpect(list.getByRole("link")).toHaveCount(1);
        await axe();
    });

    it("shows your computer's page: its facts, its work linked to the run, the computer check, and which runs it takes", async () => {
        resetFake();
        fake.runners = [
            runner({
                id: "r-mine", name: "Tess’s laptop", status: "busy",
                currentTasks: [{ kind: "Web and API tests", projectId: seed.projectId, projectName: "Atlas shop", jobId: "job-42", startedAt: iso(30_000), done: 1, total: 3 }],
                agent: { capabilities: { network: { problem: "The proxy refused the connection.", problemAt: iso(60_000) }, check: { at: iso(120_000), items: [{ id: "browser", status: "missing", title: "No browser for web tests", fix: "Install Microsoft Edge." }] } } },
            }),
        ];
        await openRunner("r-mine");
        await pwExpect(page.getByRole("heading", { name: "Tess’s laptop", level: 1 })).toBeVisible();
        await pwExpect(page.getByText(/^Your computer · Last seen/)).toBeVisible();
        const facts = page.getByTestId("runner-facts");
        for (const t of ["Windows 10.0.26100", "x64", "16 GB", "8", "2.0.0", "1.55.0"]) await pwExpect(facts).toContainText(t);
        await pwExpect(facts).toContainText("Last heard from");
        await pwExpect(page.getByRole("list", { name: "Current work" }).getByRole("link", { name: "Web and API tests" })).toHaveAttribute("href", `#/projects/${seed.projectId}/runs/job-42`);
        await pwExpect(page.getByTestId("agent-network-problem")).toContainText("The proxy refused the connection.");
        await pwExpect(page.getByTestId("agent-check")).toContainText("No browser for web tests");
        await pwExpect(page.getByTestId("runner-takes")).toContainText("Only the runs you start");
        await pwExpect(page.getByTestId("runner-projects")).toHaveCount(0);
        await pwExpect(page.getByRole("button", { name: "Rename" })).toBeVisible();
        await axe();
    });

    it("lets the owner switch code scripts off and private addresses on, and says so", async () => {
        resetFake();
        fake.runners = [runner({ id: "r-mine", name: "Tess’s laptop" })];
        await openRunner("r-mine");
        const switches = page.getByTestId("runner-switches");
        const code = switches.getByRole("checkbox", { name: /Run code scripts/ });
        const priv = switches.getByRole("checkbox", { name: /Test private and local addresses/ });
        await pwExpect(code).toBeChecked();
        await pwExpect(priv).not.toBeChecked();
        await code.uncheck();
        await pwExpect(switches.getByText("Code scripts no longer run on this runner.")).toBeVisible();
        await priv.check();
        await pwExpect(switches.getByText("Tests on this computer may now reach private and local addresses.")).toBeVisible();
        const phone = switches.getByRole("checkbox", { name: /Use my connected phone/ });
        await pwExpect(phone).not.toBeChecked();
        await pwExpect(switches).toContainText("When this is off, only emulators are used.");
        await phone.check();
        await pwExpect(switches.getByText("Your phone tests and sessions may now use the phone connected to this computer.")).toBeVisible();
        expect(fake.patches).toEqual([
            { id: "r-mine", body: { codeScripts: false } },
            { id: "r-mine", body: { privateAddresses: true } },
            { id: "r-mine", body: { realPhone: true } },
        ]);
        await pwExpect(code).not.toBeChecked();
        await pwExpect(priv).toBeChecked();
        await pwExpect(phone).toBeChecked();
        await axe();
    });

    it("shows someone else's computer read-only: no switches to flip and no actions", async () => {
        resetFake();
        fake.runners = [runner({ id: "r-ana", name: "Ana’s laptop", mine: false, ownerName: "Ana", canManage: false })];
        await openRunner("r-ana");
        await pwExpect(page.getByText(/^Ana's computer · /)).toBeVisible();
        await pwExpect(page.getByTestId("runner-switches").getByRole("checkbox")).toHaveCount(0);
        await pwExpect(page.getByTestId("runner-switches")).toContainText("Code scripts run on this runner.");
        await pwExpect(page.getByTestId("runner-switches")).toContainText("Phone tests on this computer use only emulators.");
        await pwExpect(page.getByTestId("runner-takes")).toContainText("Only the runs Ana starts");
        await pwExpect(page.getByRole("heading", { name: "Actions" })).toHaveCount(0);
    });

    it("tells an offline runner's owner how to start it again, for Windows and for a Mac", async () => {
        resetFake();
        fake.runners = [
            runner({ id: "r-win", name: "Desk PC", status: "offline", lastSeenAt: iso(3_600_000) }),
            runner({ id: "r-mac", name: "MacBook", status: "offline", agent: { os: "darwin", arch: "arm64", capabilities: { osVersion: "15.1" } } }),
        ];
        await openRunner("r-win");
        const help = page.getByTestId("runner-offline-help");
        await pwExpect(help).toContainText("notification area next to the clock");
        await pwExpect(help).toContainText("A locked screen is fine.");
        await axe();
        await openRunner("r-mac");
        await pwExpect(page.getByTestId("runner-offline-help")).toContainText("starts by itself when you sign in");
        await pwExpect(page.getByTestId("runner-facts")).toContainText("macOS 15.1");
    });

    it("gives a team runner's manager the code scripts switch, and says shared runners never run them", async () => {
        resetFake();
        fake.runners = [
            runner({ id: "r-team", name: "Lab Mac", kind: "team", mine: false, ownerName: "Acme", organizationId: "org-acme" }),
            runner({ id: "r-shared", name: "Shared box", kind: "team", mine: false, ownerName: "Crowd4Test (shared)", organizationId: null }),
        ];
        await openRunner("r-team");
        await pwExpect(page.getByText(/^Team runner · Acme · /)).toBeVisible();
        const code = page.getByTestId("runner-switches").getByRole("checkbox", { name: /Run code scripts/ });
        await pwExpect(code).not.toBeChecked();
        // A team runner has no private addresses or phone switch.
        await pwExpect(page.getByTestId("runner-switches").getByRole("checkbox")).toHaveCount(1);
        await code.check();
        expect(fake.patches.at(-1)).toEqual({ id: "r-team", body: { codeScripts: true } });
        await pwExpect(page.getByTestId("runner-projects")).toBeVisible();
        await openRunner("r-shared");
        await pwExpect(page.getByTestId("runner-switches")).toContainText("never run code scripts");
        await pwExpect(page.getByTestId("runner-switches").getByRole("checkbox")).toHaveCount(0);
    });

    it("says when an update could not be checked on the computer, and why this platform offers none", async () => {
        resetFake();
        fake.runners = [runner({ id: "r-mine", name: "Tess’s laptop", agent: { update: { can: true, auto: true, outOfDate: true, requested: false, latest: "2.1.0", state: "needs-manual", published: false, unpublished: "the runner download is not signed." } } })];
        await openRunners();
        await pwExpect(page.getByRole("list", { name: "Runners" }).getByTestId("runner-needs-manual")).toHaveText("An update is available but couldn't be checked on this computer. Download the new version from Add this computer.");
        await openRunner("r-mine");
        await pwExpect(page.getByTestId("runner-needs-manual")).toBeVisible();
        await pwExpect(page.getByText("This platform offers no automatic update: the runner download is not signed.")).toBeVisible();
    });

    it("hides the switches for a server that does not report them", async () => {
        resetFake();
        fake.runners = [runner({ id: "r-old", name: "Old runner", kind: undefined, mine: undefined, settings: undefined, machine: undefined })];
        await openRunner("r-old");
        await pwExpect(page.getByTestId("runner-switches")).toHaveCount(0);
        await pwExpect(page.getByText(/^Team runner · /)).toBeVisible();
    });

    it("works on a phone-sized screen without sideways scrolling, in light and dark", async () => {
        resetFake();
        fake.runners = [runner({ id: "r-mine", name: "A laptop with a very long name that has to wrap on a narrow screen", status: "offline" })];
        await page.setViewportSize({ width: 390, height: 800 });
        await openRunners();
        await noOverflow();
        await page.getByRole("button", { name: "Add this computer", exact: true }).click();
        await noOverflow();
        await openRunner("r-mine");
        await noOverflow();
        await page.emulateMedia({ colorScheme: "dark" });
        await page.waitForTimeout(400);
        await axe();
        await page.emulateMedia({ colorScheme: "light" });
        await page.setViewportSize({ width: 1280, height: 900 });
    });

    it("kept the browser console clean", () => {
        expect(consoleErrors).toEqual([]);
    });
});
