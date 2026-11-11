/**
 * The code editor UI in a real browser: take over a test, the hand-written badge and callout, the editor (live check, inline
 * problems, save, run status, unsaved-changes protection, keyboard path), version history with a line diff and restore, writing a test
 * from scratch, the shared helpers page, and the Git import dialog with its repositories list.
 *
 * The platform underneath is real (a seeded project and tests, the real UI bundle). The code endpoints of
 * .scratch/briefs/CODE-API-SHAPES.md are answered by a small in-memory stand-in in a front server that forwards everything else to the
 * platform, so this file does not depend on the platform half landing. A final journey runs against the real routes when they exist.
 * Ports: 6110 front (the address the browser uses), 6111 platform.
 *
 * Requires web/dist (build inside the browser lock):
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/code-ui.test.ts
 * Set AS_SHOTS=<folder> to also write screenshots.
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

const FRONT_PORT = 6110;
const PLATFORM_PORT = 6111;
const BASE = `http://127.0.0.1:${FRONT_PORT}`;

// ── the stand-in code API ───────────────────────────────────────────────────

interface FakeVersion { version: number; createdAt: string; note: string | null; bytes: number; kind: "generated" | "taken-over" | "edited" | "git" | "restored"; by: string | null; content: string }
interface FakeCustom { since: string; origin: "taken-over" | "git" | "written"; canRestoreGenerated: boolean; git?: { host: string; path: string; ref: string; commit: string; importedAt: string } }
interface FakeRepo { id: string; host: string; path: string; ref: string; commit: string; importedAt: string; tests: number }
interface Call { method: string; path: string; body: any }

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const SCRIPT_V1 = `import { test, expect } from "@playwright/test";

test("home page", async ({ page }) => {
    await page.goto(process.env.BASE_URL ?? "");
    await expect(page).toHaveTitle(/Atlas/);
});
`;
const SCRIPT_V2 = SCRIPT_V1.replace("/Atlas/", "/Atlas shop/");
const SCRIPT_V3 = `${SCRIPT_V2}\ntest("pricing page", async ({ page }) => {\n    await page.goto("/pricing");\n});\n`;
const GUARD = ["Only these imports are allowed: @playwright/test, @axe-core/playwright and your own helpers.", "No eval, no new Function and no require.", "No access to files, the network, other processes or the operating system.", "Only BASE_URL, API_BASE_URL and TEST_ or API_ settings can be read."];
const SECRET_TOKEN = "ghp_SENTINEL_token_0123456789abcdef";

const fake = {
    enabled: true,
    platformEnabled: true,
    custom: null as FakeCustom | null,
    script: SCRIPT_V1,
    versions: [] as FakeVersion[],
    takeOverOffer: { allowed: true, losses: ["Repair suggestions stop for this test", "Changes to shared elements no longer apply", "Settings that change the generated script no longer apply"] } as { allowed: boolean; reason?: string; losses: string[] },
    takeOverError: "" as string,
    saveMode: "ok" as "ok" | "422" | "409" | "nojob",
    jobStatus: "QUEUED" as "QUEUED" | "VALIDATING" | "COMPLETED" | "PARTIALLY_COMPLETED",
    validation: "VALIDATED" as "VALIDATED" | "FAILED_VALIDATION",
    calls: [] as Call[],
    checkCalls: 0,
    createdTestId: "",
    helpers: [] as Array<{ name: string; content: string; usedBy: string[]; updatedAt: string }>,
    repos: [] as FakeRepo[],
    repoUpToDate: false,
    /** The stand-in answers as if the first changed file had been edited here since the last import. */
    editedHere: false,
    tokensSeen: [] as string[],
};
let testId = "";
let testId2 = "";
let projectId = "";

function resetFake() {
    Object.assign(fake, {
        enabled: true,
        platformEnabled: true,
        custom: null,
        script: SCRIPT_V1,
        versions: [],
        takeOverOffer: { allowed: true, losses: ["Repair suggestions stop for this test", "Changes to shared elements no longer apply", "Settings that change the generated script no longer apply"] },
        takeOverError: "",
        saveMode: "ok",
        jobStatus: "QUEUED",
        validation: "VALIDATED",
        calls: [],
        checkCalls: 0,
        createdTestId: "",
        helpers: [
            { name: "sign-in", content: `export async function signIn(page: unknown) {\n    return page;\n}\n`, usedBy: ["Checkout works", "Cart total"], updatedAt: iso(3_600_000) },
            { name: "unused-one", content: `export const x = 1;\n`, usedBy: [], updatedAt: iso(86_400_000) },
        ],
        repos: [{ id: "gr-1", host: "github.com", path: "acme/tests", ref: "main", commit: "abc1234def5678", importedAt: iso(7_200_000), tests: 3 }],
        repoUpToDate: false,
        editedHere: false,
        tokensSeen: [],
    });
}
const makeCustom = (origin: FakeCustom["origin"] = "taken-over", extra: Partial<FakeCustom> = {}): FakeCustom => ({ since: iso(600_000), origin, canRestoreGenerated: origin === "taken-over", ...extra });
function history3() {
    fake.versions = [
        { version: 1, createdAt: iso(3_000_000), note: null, bytes: Buffer.byteLength(SCRIPT_V1), kind: "taken-over", by: "Nitika", content: SCRIPT_V1 },
        { version: 2, createdAt: iso(2_000_000), note: "Match the shop title", bytes: Buffer.byteLength(SCRIPT_V2), kind: "edited", by: "Nitika", content: SCRIPT_V2 },
        { version: 3, createdAt: iso(1_000_000), note: null, bytes: Buffer.byteLength(SCRIPT_V3), kind: "edited", by: "Nitika", content: SCRIPT_V3 },
    ];
    fake.script = SCRIPT_V3;
}

/** The guard and syntax check the real platform does, reduced to two rules the tests can trigger. */
function diagnose(content: string) {
    const out: Array<{ severity: "error" | "warning"; line: number; column: number; message: string; rule: string }> = [];
    content.split("\n").forEach((l, i) => {
        const r = l.indexOf("require(");
        if (r >= 0) out.push({ severity: "error", line: i + 1, column: r + 1, message: "require is not allowed. Use import from @playwright/test.", rule: "no-require" });
        const c = l.indexOf("console.log");
        if (c >= 0) out.push({ severity: "warning", line: i + 1, column: c + 1, message: "console.log output is not kept when the test runs.", rule: "no-console" });
    });
    return out;
}

async function front(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", BASE);
    const p = url.pathname;
    const method = req.method ?? "GET";
    const json = (status: number, data: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
    if (!fake.enabled) return forward(req, res, raw, url);
    const body = raw.length ? safeJson(raw.toString()) : undefined;
    let m: RegExpMatchArray | null;
    const log = () => fake.calls.push({ method, path: p, body });

    if ((m = p.match(/^\/api\/tests\/([^/]+)\/take-over$/))) {
        log();
        if (method === "GET") return json(200, fake.takeOverOffer);
        if (fake.takeOverError) return json(409, { error: fake.takeOverError });
        fake.custom = makeCustom("taken-over");
        fake.versions = [{ version: 1, createdAt: iso(1000), note: null, bytes: Buffer.byteLength(fake.script), kind: "taken-over", by: "Nitika", content: fake.script }];
        return json(200, { id: m[1], custom: fake.custom });
    }
    if ((m = p.match(/^\/api\/tests\/([^/]+)\/restore-generated$/))) {
        log();
        fake.custom = null;
        return json(200, { id: m[1] });
    }
    if ((m = p.match(/^\/api\/tests\/([^/]+)\/script$/))) {
        if (method === "GET") return void res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(fake.script);
        log();
        const content = String(body?.content ?? "");
        if (fake.saveMode === "422") return json(422, { error: "The script has problems and was not saved.", diagnostics: diagnose(content).length ? diagnose(content) : [{ severity: "error", line: 1, column: 1, message: "This script cannot be saved.", rule: "guard" }] });
        if (fake.saveMode === "409") return json(409, { error: "A run is in progress for this project. Wait for it to finish, then save again." });
        const version = (fake.versions.at(-1)?.version ?? 0) + 1;
        fake.versions.push({ version, createdAt: iso(0), note: body?.note ?? null, bytes: Buffer.byteLength(content), kind: "edited", by: "Nitika", content });
        fake.script = content;
        fake.jobStatus = "QUEUED";
        return json(200, { version, diagnostics: diagnose(content).filter((d) => d.severity === "warning"), jobId: fake.saveMode === "nojob" ? null : "job-fake-code", ...(fake.saveMode === "nojob" ? { note: "Running hand-written scripts is not switched on for this server, so the test stays Not validated." } : {}) });
    }
    if ((m = p.match(/^\/api\/tests\/([^/]+)\/script\/check$/)) && method === "POST") {
        fake.checkCalls++;
        return json(200, { diagnostics: diagnose(String(body?.content ?? "")) });
    }
    if ((m = p.match(/^\/api\/tests\/([^/]+)\/script-versions$/)) && method === "GET") return json(200, [...fake.versions].reverse().map(({ content: _c, ...v }) => v));
    if ((m = p.match(/^\/api\/tests\/([^/]+)\/script-versions\/(\d+)\/restore$/)) && method === "POST") {
        log();
        const src = fake.versions.find((v) => v.version === Number(m![2]));
        if (!src) return json(404, { error: "That version does not exist." });
        const version = fake.versions.length + 1;
        fake.versions.push({ version, createdAt: iso(0), note: `Restored from version ${src.version}`, bytes: src.bytes, kind: "restored", by: "Nitika", content: src.content });
        fake.script = src.content;
        fake.jobStatus = "QUEUED";
        return json(200, { version, diagnostics: [], jobId: "job-fake-code" });
    }
    if ((m = p.match(/^\/api\/tests\/([^/]+)\/script-versions\/(\d+)$/)) && method === "GET") {
        const v = fake.versions.find((x) => x.version === Number(m![2]));
        return v ? json(200, { version: v.version, content: v.content }) : json(404, { error: "That version does not exist." });
    }
    if (p === "/api/test-generation/job-fake-code") {
        return json(200, { jobId: "job-fake-code", status: fake.jobStatus, mode: "validate", progress: {}, counters: {}, error: null, createdAt: iso(2000), startedAt: iso(1500), finishedAt: fake.jobStatus.startsWith("COMPLETED") || fake.jobStatus === "PARTIALLY_COMPLETED" ? iso(100) : null });
    }
    if (/^\/api\/projects\/[^/]+\/custom-tests$/.test(p) && method === "POST") {
        log();
        fake.createdTestId = testId2;
        fake.custom = makeCustom("written", { canRestoreGenerated: false });
        fake.script = String(body?.content ?? "");
        fake.versions = [{ version: 1, createdAt: iso(0), note: null, bytes: Buffer.byteLength(fake.script), kind: "taken-over", by: "Nitika", content: fake.script }];
        fake.jobStatus = "QUEUED";
        return json(201, { testId: testId2, version: 1, diagnostics: [], jobId: "job-fake-code" });
    }
    // helpers
    if ((m = p.match(/^\/api\/projects\/[^/]+\/helpers$/)) && method === "GET") return json(200, fake.helpers.map((h) => ({ name: h.name, bytes: Buffer.byteLength(h.content), updatedAt: h.updatedAt, usedBy: h.usedBy.length })));
    if ((m = p.match(/^\/api\/projects\/[^/]+\/helpers\/([^/]+)$/))) {
        const name = m[1]!;
        const h = fake.helpers.find((x) => x.name === name);
        if (method === "GET") return h ? json(200, { name, content: h.content }) : json(404, { error: "No helper with that name." });
        log();
        if (method === "PUT") {
            const content = String(body?.content ?? "");
            const errors = diagnose(content).filter((d) => d.severity === "error");
            if (errors.length) return json(422, { error: "The helper has problems and was not saved.", diagnostics: errors });
            if (h) Object.assign(h, { content, updatedAt: iso(0) });
            else fake.helpers.push({ name, content, usedBy: [], updatedAt: iso(0) });
            return json(200, { diagnostics: [] });
        }
        if (method === "DELETE") {
            if (!h) return json(404, { error: "No helper with that name." });
            if (h.usedBy.length) return json(409, { error: `${h.usedBy.length} tests still import this helper: ${h.usedBy.join(", ")}. Change them first.`, tests: h.usedBy });
            fake.helpers = fake.helpers.filter((x) => x !== h);
            return json(200, { ok: true });
        }
    }
    // Git import
    if (/^\/api\/projects\/[^/]+\/git-imports$/.test(p)) {
        if (method === "GET") return json(200, fake.repos);
        log();
        if (body?.token) fake.tokensSeen.push(body.token);
        if (!String(body?.url ?? "").startsWith("https://")) return json(400, { error: "Only https addresses can be used." });
        if (String(body.url).includes("private") && !body.token) return json(401, { error: "The repository asked for a sign-in. Add an access token and try again." });
        if (body.dryRun)
            return json(200, {
                commit: "9f8e7d6c5b4a",
                files: [
                    { path: "tests/login.spec.ts", title: "Login", bytes: 1200, tests: 2, problems: [] },
                    { path: "tests/legacy.spec.ts", title: "Legacy checkout", bytes: 900, tests: 1, problems: ["Imports a package that is not allowed: lodash"] },
                    { path: "tests/cart.spec.ts", title: "Cart", bytes: 2400, tests: 3, problems: [] },
                ],
                skipped: [{ path: "README.md", reason: "Not a Playwright test file" }],
            });
        fake.repos.push({ id: "gr-2", host: "github.com", path: "your-team/your-tests", ref: body.ref ?? "main", commit: "9f8e7d6c5b4a", importedAt: iso(0), tests: 5 });
        return json(201, { commit: "9f8e7d6c5b4a", imported: [{ testId: "t1", path: "tests/login.spec.ts", created: true }, { testId: "t2", path: "tests/cart.spec.ts", created: false }], skipped: [{ path: "tests/legacy.spec.ts", reason: "It has problems" }], jobId: "job-fake-code" });
    }
    if ((m = p.match(/^\/api\/projects\/[^/]+\/git-imports\/([^/]+)\/check$/)) && method === "POST") {
        log();
        return json(200, fake.repoUpToDate ? { upToDate: true, changed: [] } : { upToDate: false, newCommit: "fff0000aaa11", changed: [{ testId: "t1", path: "tests/login.spec.ts", ...(fake.editedHere ? { editedHere: true } : {}) }] });
    }
    if ((m = p.match(/^\/api\/projects\/[^/]+\/git-imports\/([^/]+)\/refresh$/)) && method === "POST") {
        log();
        if (body?.token) fake.tokensSeen.push(body.token);
        return json(200, { commit: "fff0000aaa11", imported: [{ testId: "t1", path: "tests/login.spec.ts", created: false }], skipped: fake.editedHere ? [{ path: "tests/cart.spec.ts", reason: "Edited here since the last import, so it was left as it is.", editedHere: true }] : [], jobId: "job-fake-code" });
    }
    if ((m = p.match(/^\/api\/projects\/[^/]+\/git-imports\/([^/]+)$/)) && method === "DELETE") {
        log();
        fake.repos = fake.repos.filter((r) => r.id !== m![1]);
        return json(200, { ok: true });
    }
    return forward(req, res, raw, url);
}

const safeJson = (s: string) => {
    try {
        return JSON.parse(s);
    } catch {
        return undefined;
    }
};

/** Everything the stand-in does not answer goes to the real platform, with the small additions the code half provides. */
async function forward(req: http.IncomingMessage, res: http.ServerResponse, raw: Buffer, url: URL) {
    const p = url.pathname;
    const method = req.method ?? "GET";
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "connection", "content-length"].includes(k)) headers[k] = v;
    const upstream = await fetch(`http://127.0.0.1:${PLATFORM_PORT}${req.url}`, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : new Uint8Array(raw) });
    const buf = Buffer.from(await upstream.arrayBuffer());
    const type = upstream.headers.get("content-type") ?? "application/octet-stream";
    const send = (data: unknown) => void res.writeHead(upstream.status, { "content-type": "application/json" }).end(JSON.stringify(data));
    const customOf = (id: string) => (fake.enabled && (id === testId || (id === testId2 && fake.createdTestId)) && fake.custom ? { custom: fake.custom } : {});
    if (fake.enabled && method === "GET" && type.includes("json")) {
        let m: RegExpMatchArray | null;
        if (p === "/api/config") return send({ ...JSON.parse(buf.toString()), customScripts: { platform: fake.platformEnabled, maxBytes: 200000, guard: GUARD } });
        if ((m = p.match(/^\/api\/tests\/([^/]+)$/))) {
            const t = JSON.parse(buf.toString());
            const patched = { ...t, ...customOf(m[1]!) };
            if (fake.custom && (m[1] === testId || (m[1] === testId2 && fake.createdTestId))) patched.validationStatus = fake.validation;
            return send(patched);
        }
        if (/^\/api\/projects\/[^/]+\/tests$/.test(p)) {
            const list = JSON.parse(buf.toString()) as Array<{ id: string }>;
            return send(list.map((t) => ({ ...t, ...customOf(t.id) })));
        }
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
const consoleErrors: string[] = [];
const requested: string[] = [];
/** Browser dialogs (the unsaved-changes warning on leaving a page): accepted so a test can move on, unless a test is checking them. */
const dialogs = { mode: "accept" as "accept" | "dismiss", kinds: [] as string[] };

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-code-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    frontServer = http.createServer((req, res) => void front(req, res).catch((e) => res.writeHead(500).end(String(e))));
    await new Promise<void>((r) => frontServer.listen(FRONT_PORT, "127.0.0.1", r));

    seed = seedProject(platform, "Atlas shop", "http://127.0.0.1:6119");
    testId = addTest(platform, seed, "home page");
    testId2 = addTest(platform, seed, "pricing page");
    await seedRun(platform, seed, { "home page": "pass", "pricing page": "pass" }, { daysAgo: 1 });
    projectId = seed.projectId;

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
    page = await context.newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    page.on("request", (r) => requested.push(new URL(r.url()).pathname));
    page.on("dialog", (d) => {
        dialogs.kinds.push(d.type());
        void (dialogs.mode === "dismiss" ? d.dismiss() : d.accept());
    });
}, 120_000);

afterAll(async () => {
    await browser?.close();
    // Live-update streams the page opened can keep a connection alive; end them so closing the servers cannot wait on them.
    frontServer?.closeAllConnections?.();
    frontServer?.close();
    server?.server?.closeAllConnections?.();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const shots = process.env.AS_SHOTS;
async function shot(name: string) {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
}
/** A fresh load of a page (a hash change alone would not re-run the page's loads). */
async function visit(hash: string) {
    await page.goto("about:blank");
    await page.goto(`${BASE}/${hash}`);
}
const testHash = (id = testId) => `#/tests/${id}/code`; // the Code tab of the workbench (the test page and the script editor are one page now)
const editorHash = (id = testId, q = "") => `#/tests/${id}/code${q}`;
async function noOverflow() {
    const wide = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".content *"))
            .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !el.closest(".cm-scroller") && !el.closest(".tabs"))
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
/** Run an audit in both colour schemes after the 400 ms settle. `setup` re-creates the state to audit. */
async function axeBoth(setup: () => Promise<void>, name: string) {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(400);
        await setup();
        // Settle again: the state `setup` makes can restyle a control (Preview turns from primary to secondary once a preview is
        // shown), and colours ease over 140 ms; axe must see the colours a person sees, not the middle of the fade.
        await page.waitForTimeout(400);
        await shot(`${name}-${scheme}-1280`);
        await axe();
    }
    await page.emulateMedia({ colorScheme: null });
}
const editorText = async () => (await page.locator(".cm-line").allInnerTexts()).join("\n");
const focusEditorEnd = async () => {
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
};
const editorReady = () => pwExpect(page.locator(".cm-content")).toBeVisible({ timeout: 15_000 });

// ── journeys ────────────────────────────────────────────────────────────────

describe("Taking over a generated test", () => {
    it("lists what stops, lets you cancel, then opens the editor", async () => {
        resetFake();
        await visit(testHash());
        const edit = page.getByRole("button", { name: "Switch to code", exact: true }).last();
        await pwExpect(edit).toBeVisible();
        // the generated script is read-only on this tab, with the one way to code beside it
        await pwExpect(page.locator("pre.code").first()).toBeVisible();
        await edit.click();
        const dialog = page.getByRole("dialog", { name: "Switch this test to code?" });
        await pwExpect(dialog).toBeVisible();
        const losses = dialog.getByTestId("takeover-losses").getByRole("listitem");
        await pwExpect(losses).toHaveCount(3);
        await pwExpect(losses.first()).toHaveText("Repair suggestions stop for this test");
        await pwExpect(dialog).toContainText("You can go back to the generated version later.");
        await shot("takeover-light-1280");
        await axeBoth(async () => {
            await visit(testHash());
            await page.getByRole("button", { name: "Switch to code", exact: true }).last().click();
            await pwExpect(page.getByRole("dialog", { name: "Switch this test to code?" })).toBeVisible();
        }, "takeover");

        // cancel: nothing is posted
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await pwExpect(dialog).toHaveCount(0);
        expect(fake.calls.filter((c) => c.method === "POST")).toEqual([]);

        // Escape closes it too
        await edit.click();
        await pwExpect(page.getByRole("dialog", { name: "Switch this test to code?" })).toBeVisible();
        await page.keyboard.press("Escape");
        await pwExpect(page.getByRole("dialog")).toHaveCount(0);

        // confirm: the call carries confirm: true and the editor opens
        await edit.click();
        await page.getByRole("button", { name: "Switch to code", exact: true }).last().click();
        await pwExpect(page).toHaveURL(new RegExp(`#/tests/${testId}/code$`));
        await editorReady();
        expect(fake.calls.find((c) => c.method === "POST" && c.path.endsWith("/take-over"))?.body).toEqual({ confirm: true });
        await pwExpect(page.getByText("Code test", { exact: true }).first()).toBeVisible();
    });

    it("shows the platform’s reason when it refuses, and keeps the dialog open", async () => {
        resetFake();
        fake.takeOverError = "A run is in progress for this project. Wait for it to finish, then take the test over.";
        await visit(testHash());
        await page.getByRole("button", { name: "Switch to code", exact: true }).last().click();
        await page.getByRole("button", { name: "Switch to code", exact: true }).last().click();
        await pwExpect(page.getByRole("dialog", { name: "Switch this test to code?" })).toContainText("A run is in progress for this project.");
        expect(fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/take-over")).length).toBeGreaterThan(0);
        await pwExpect(page.locator(".cm-content")).toHaveCount(0); // still not code: the editor did not open
        await page.keyboard.press("Escape");

        // not allowed at all: the reason is shown and the button is off
        fake.takeOverOffer = { allowed: false, reason: "Mobile app tests cannot be taken over yet.", losses: [] };
        await visit(testHash());
        await page.getByRole("button", { name: "Switch to code", exact: true }).last().click();
        const dialog = page.getByRole("dialog", { name: "Switch this test to code?" });
        await pwExpect(dialog).toContainText("Mobile app tests cannot be taken over yet.");
        await pwExpect(dialog.getByRole("button", { name: "Switch to code", exact: true })).toBeDisabled();
    });
});

describe("A hand-written test", () => {
    it("shows the badge, the origin and the callout, and goes back to the generated version after a confirmation", async () => {
        resetFake();
        fake.custom = makeCustom("taken-over");
        await visit(testHash());
        await pwExpect(page.getByText("Code test", { exact: true }).first()).toBeVisible();
        await pwExpect(page.getByText("Switched to code", { exact: true }).first()).toBeVisible();
        const callout = page.locator(".callout", { hasText: "This is a code test" });
        await pwExpect(callout).toContainText("The script is the source of truth");
        await pwExpect(callout.getByRole("link", { name: "Edit the code", exact: true })).toHaveAttribute("href", `#/tests/${testId}/code`);
        await pwExpect(callout.getByRole("link", { name: "Version history", exact: true })).toHaveAttribute("href", `#/tests/${testId}/code?history=1`);
        // the steps of the archived specification are not shown as if they still drove the test
        await page.getByRole("tab", { name: "Steps", exact: true }).click();
        await pwExpect(page.getByText("A code test has no list of steps")).toBeVisible();
        await page.getByRole("tab", { name: "Code", exact: true }).click();
        await shot("custom-callout-light-1280");
        await axeBoth(async () => {
            await visit(testHash());
            await pwExpect(page.getByText("Code test", { exact: true }).first()).toBeVisible();
        }, "custom-test");

        await callout.getByRole("button", { name: "Go back to the generated version", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Go back to the generated version?" });
        await pwExpect(dialog).toContainText("Your edits stay in the version history");
        await dialog.getByRole("button", { name: "Keep my script", exact: true }).click();
        expect(fake.calls.filter((c) => c.path.endsWith("restore-generated"))).toEqual([]);
        await callout.getByRole("button", { name: "Go back to the generated version", exact: true }).click();
        await page.getByRole("dialog").getByRole("button", { name: "Go back to the generated version", exact: true }).click();
        await pwExpect(page.locator(".callout", { hasText: "This is a code test" })).toHaveCount(0);
        expect(fake.calls.find((c) => c.path.endsWith("restore-generated"))?.body).toEqual({ confirm: true });
    });

    it("hides “go back” when there is no generated version, and shows the Git source with a check for updates", async () => {
        resetFake();
        fake.custom = makeCustom("git", { canRestoreGenerated: false, git: { host: "github.com", path: "acme/tests", ref: "main", commit: "abc1234def5678", importedAt: iso(3_600_000) } });
        await visit(testHash());
        await pwExpect(page.getByText("From Git", { exact: true })).toBeVisible();
        await pwExpect(page.getByRole("button", { name: "Go back to the generated version" })).toHaveCount(0);
        await pwExpect(page.getByTestId("git-line")).toHaveText("From github.com/acme/tests, main, commit abc1234");
        expect(await page.getByTestId("git-line").textContent()).not.toContain("·");
        await page.getByRole("button", { name: "Check for updates", exact: true }).click();
        await pwExpect(page.getByTestId("git-check")).toContainText("The repository has changed");
        await pwExpect(page.getByTestId("git-check")).toContainText("tests/login.spec.ts");
        fake.repoUpToDate = true;
        await page.getByRole("button", { name: "Check for updates", exact: true }).click();
        await pwExpect(page.getByTestId("git-check")).toContainText("up to date");
    });

    it("marks hand-written tests in the Tests list", async () => {
        resetFake();
        fake.custom = makeCustom("taken-over");
        await visit(`#/projects/${projectId}/scripts`);
        const row = page.getByTestId("script-row").filter({ hasText: /Check home page/ });
        await pwExpect(row).toContainText("Code test");
        await pwExpect(page.getByTestId("script-row").filter({ hasText: /Check pricing page/ })).not.toContainText("Code test");
    });
});

describe("The editor", () => {
    it("loads the script with an accessible name and highlighting, the allowed rules and the hint for keyboard users", async () => {
        resetFake();
        fake.custom = makeCustom("taken-over");
        history3();
        await visit(editorHash());
        await editorReady();
        const content = page.locator(".cm-content");
        await pwExpect(content).toHaveAttribute("aria-label", "Script editor");
        await pwExpect(page.getByRole("textbox", { name: "Script editor" })).toBeVisible();
        expect(await editorText()).toContain('await expect(page).toHaveTitle(/Atlas shop/);');
        await pwExpect(page.locator(".cm-lineNumbers")).toBeVisible();
        // syntax highlighting is applied (a keyword has its own colour, not the plain text colour)
        const [kw, plain] = await page.evaluate(() => {
            const colour = (el: Element | null) => (el ? getComputedStyle(el).color : "");
            const spans = Array.from(document.querySelectorAll(".cm-line span"));
            const kwEl = spans.find((s) => s.textContent === "import");
            return [colour(kwEl ?? null), colour(document.querySelector(".cm-content"))];
        });
        expect(kw).not.toBe("");
        expect(kw).not.toBe(plain);
        await pwExpect(page.getByText("To leave the editor with the keyboard, press Escape, then Tab.")).toBeVisible();
        // the rules in words, with the honest sentence
        await page.locator("summary", { hasText: "What’s allowed in a script" }).click();
        for (const rule of GUARD) await pwExpect(page.getByText(rule, { exact: true })).toBeVisible();
        await pwExpect(page.getByText("not a security boundary", { exact: false })).toBeVisible();
        // no warning when scripts can run
        await pwExpect(page.getByText("Code tests cannot run yet")).toHaveCount(0);
    });

    it("warns, with what to switch on, when hand-written scripts cannot run", async () => {
        resetFake();
        fake.custom = makeCustom("taken-over");
        fake.platformEnabled = false;
        await visit(editorHash());
        await editorReady();
        const warning = page.locator(".callout", { hasText: "Code tests cannot run yet" });
        await pwExpect(warning).toBeVisible();
        await pwExpect(warning).toContainText("switch on Run code scripts");
        await pwExpect(warning).toContainText("ALLOW_CUSTOM_SCRIPTS=true");
        await shot("not-enabled-light-1280");
    });

    it("shows a test that is still generated read-only, and offers to take it over", async () => {
        resetFake();
        await visit(editorHash());
        await pwExpect(page.getByText("Want to change the code itself?")).toBeVisible();
        // the script is shown for reading (no editor, so nothing can be typed into it) and the one way to code is beside it
        await pwExpect(page.locator("pre.code").first()).toBeVisible();
        expect(await page.locator(".cm-content").count()).toBe(0);
        await pwExpect(page.getByRole("button", { name: "Switch to code", exact: true }).last()).toBeVisible();
    });

    it("checks after a pause (debounced), marks problems inline, lists them and jumps to the line", async () => {
        resetFake();
        fake.custom = makeCustom("taken-over");
        await visit(editorHash());
        await editorReady();
        await pwExpect(page.getByTestId("check-state")).toHaveText("No problems found.");
        const before = fake.checkCalls;
        await focusEditorEnd();
        await page.keyboard.type('\nconst fs = require("fs");', { delay: 15 });
        await pwExpect(page.getByTestId("check-state")).toContainText("1 error", { timeout: 8000 });
        // typing in one burst made one check, not one per key
        expect(fake.checkCalls - before).toBeLessThanOrEqual(2);
        await pwExpect(page.locator(".cm-lintRange-error").first()).toBeVisible();
        const item = page.getByRole("button", { name: /Error.*Line 8, column 12.*require is not allowed/ });
        await pwExpect(item).toBeVisible();
        await shot("editor-problems-light-1280");
        await axeBoth(async () => {
            await visit(editorHash());
            await editorReady();
            await focusEditorEnd();
            await page.keyboard.type('\nconst fs = require("fs");\nconsole.log(1);', { delay: 5 });
            await pwExpect(page.getByTestId("check-state")).toContainText("1 error", { timeout: 8000 });
        }, "editor-problems");

        // click-to-jump moves the cursor to that line and puts focus back in the editor
        await page.getByRole("button", { name: /Warning.*console.log output/ }).click();
        await pwExpect(page.locator(".cm-activeLine")).toContainText("console.log");
        await pwExpect(page.locator(".cm-content")).toBeFocused();
    });

    it("keeps the text on a refused save (422) and shows the problems", async () => {
        resetFake();
        fake.custom = makeCustom("taken-over");
        fake.saveMode = "422";
        await visit(editorHash());
        await editorReady();
        await focusEditorEnd();
        await page.keyboard.type("\n// my change", { delay: 5 });
        await page.getByRole("button", { name: "Save and run", exact: true }).click();
        await pwExpect(page.getByText("Not saved. Fix the problems listed below")).toBeVisible();
        await pwExpect(page.getByRole("button", { name: /This script cannot be saved/ })).toBeVisible();
        expect(await editorText()).toContain("// my change");
        await pwExpect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();

        // a plain refusal (409) says what to do
        fake.saveMode = "409";
        await page.getByRole("button", { name: "Save and run", exact: true }).click();
        await pwExpect(page.getByText("A run is in progress for this project. Wait for it to finish, then save again.")).toBeVisible();
    });

    it("saves with a note, then follows the run from queued to passed", async () => {
        resetFake();
        fake.custom = makeCustom("taken-over");
        history3();
        await visit(editorHash());
        await editorReady();
        await focusEditorEnd();
        await page.keyboard.type("\n// checked the title", { delay: 5 });
        await page.getByLabel("Note for this version (optional)").fill("Added a comment");
        await page.getByRole("button", { name: "Save and run", exact: true }).click();
        const status = page.getByTestId("run-status");
        await pwExpect(status).toContainText("Queued");
        const put = fake.calls.find((c) => c.method === "PUT" && c.path.endsWith("/script"));
        expect(put?.body.note).toBe("Added a comment");
        expect(put?.body.content).toContain("// checked the title");
        await pwExpect(page.getByTestId("saved-version")).toHaveText("Saved as version 4.");
        fake.jobStatus = "VALIDATING";
        await pwExpect(status).toContainText("Running", { timeout: 8000 });
        fake.jobStatus = "COMPLETED";
        await pwExpect(status).toContainText("Passed", { timeout: 8000 });
        await pwExpect(status.getByRole("link", { name: "Open the test", exact: true })).toHaveAttribute("href", `#/tests/${testId}`);
        await pwExpect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(0);
        await shot("editor-saved-light-1280");

        // a failing run says so, with the platform's reason
        fake.validation = "FAILED_VALIDATION";
        await focusEditorEnd();
        await page.keyboard.type("\n// again", { delay: 5 });
        await page.getByRole("button", { name: "Save and run", exact: true }).click();
        fake.jobStatus = "PARTIALLY_COMPLETED";
        await pwExpect(page.getByTestId("run-status")).toContainText("Did not pass", { timeout: 8000 });
    });

    it("says why nothing ran when the save started no job", async () => {
        resetFake();
        fake.custom = makeCustom("taken-over");
        fake.saveMode = "nojob";
        await visit(editorHash());
        await editorReady();
        await focusEditorEnd();
        await page.keyboard.type("\n// no run", { delay: 5 });
        await page.getByRole("button", { name: "Save and run", exact: true }).click();
        await pwExpect(page.getByTestId("run-status")).toContainText("Not run: Running hand-written scripts is not switched on for this server");
    });

    it("protects unsaved changes: leaving asks first, discarding asks first, closing the tab warns", async () => {
        resetFake();
        fake.custom = makeCustom("taken-over");
        await visit(editorHash());
        await editorReady();
        await focusEditorEnd();
        await page.keyboard.type("\n// unsaved", { delay: 5 });
        await page.getByRole("link", { name: "Test scripts", exact: true }).first().click();
        const dialog = page.getByRole("dialog", { name: "Leave without saving?" });
        await pwExpect(dialog).toBeVisible();
        await shot("leave-dialog-light-1280");
        await dialog.getByRole("button", { name: "Stay and keep editing", exact: true }).click();
        expect(page.url()).toContain("/code");
        expect(await editorText()).toContain("// unsaved");

        // beforeunload: the browser is asked to confirm a reload
        dialogs.kinds.length = 0;
        dialogs.mode = "dismiss";
        await page.reload({ timeout: 3000 }).catch(() => undefined);
        dialogs.mode = "accept";
        expect(dialogs.kinds).toContain("beforeunload");
        expect(await editorText()).toContain("// unsaved");

        // discard asks, then returns to the saved text
        await page.getByRole("button", { name: "Discard changes", exact: true }).click();
        const d2 = page.getByRole("dialog", { name: "Discard your changes?" });
        await d2.getByRole("button", { name: "Keep editing", exact: true }).click();
        expect(await editorText()).toContain("// unsaved");
        await page.getByRole("button", { name: "Discard changes", exact: true }).click();
        await page.getByRole("dialog").getByRole("button", { name: "Discard changes", exact: true }).click();
        expect(await editorText()).not.toContain("// unsaved");

        // clean again: leaving needs no question
        await page.getByRole("link", { name: "Test scripts", exact: true }).first().click();
        await pwExpect(page).toHaveURL(new RegExp(`#/projects/${projectId}/scripts$`));
    });

    it("works from the keyboard: Tab indents, Escape then Tab leaves the editor", async () => {
        resetFake();
        fake.custom = makeCustom("taken-over");
        await visit(editorHash());
        await editorReady();
        await focusEditorEnd();
        await page.keyboard.press("Tab");
        expect(await editorText()).toMatch(/\n[ \t]+$/);
        const inEditor = () => page.evaluate(() => !!document.activeElement?.closest(".cm-editor"));
        expect(await inEditor()).toBe(true);
        await page.keyboard.press("Escape");
        await page.keyboard.press("Tab");
        expect(await inEditor()).toBe(false);
        // focus is somewhere visible on the page, not lost
        expect(await page.evaluate(() => document.activeElement && document.activeElement !== document.body)).toBe(true);
        // wrap toggle and search work
        const wrap = page.getByRole("button", { name: "Wrap lines", exact: true });
        await wrap.click();
        await pwExpect(wrap).toHaveAttribute("aria-pressed", "true");
        await pwExpect(page.locator(".cm-lineWrapping")).toBeVisible();
        await page.locator(".cm-content").click();
        await page.keyboard.press("Control+f");
        await pwExpect(page.locator(".cm-search")).toBeVisible();
        await page.keyboard.press("Escape");
        await pwExpect(page.locator(".cm-search")).toHaveCount(0);
    });
});

describe("Version history", () => {
    it("lists the versions, compares two with a line diff, and restores one after a confirmation", async () => {
        resetFake();
        fake.custom = makeCustom("taken-over");
        history3();
        await visit(editorHash(testId, "?history=1"));
        await editorReady();
        const list = page.getByTestId("versions");
        await pwExpect(list.getByRole("listitem")).toHaveCount(3);
        const v3 = list.locator('[data-version="3"]');
        await pwExpect(v3).toContainText("Current");
        await pwExpect(list.locator('[data-version="1"]')).toContainText("Switched to code");
        await pwExpect(list.locator('[data-version="2"]')).toContainText("Edited");
        await pwExpect(list.locator('[data-version="2"]')).toContainText("Match the shop title");

        // one picked: compared with the newest
        await list.locator('[data-version="2"]').getByLabel("Compare version 2").check();
        await pwExpect(page.getByRole("heading", { name: "Version 2 compared with version 3" })).toBeVisible();
        await pwExpect(page.getByTestId("diff-summary")).toHaveText("4 lines added, 0 lines removed");
        // two picked: those two
        await list.locator('[data-version="1"]').getByLabel("Compare version 1").check();
        await pwExpect(page.getByRole("heading", { name: "Version 1 compared with version 2" })).toBeVisible();
        await pwExpect(page.getByTestId("diff-summary")).toHaveText("1 line added, 1 line removed");
        const diff = page.getByTestId("diff");
        // added and removed lines carry a symbol and a spoken label, not only a colour
        await pwExpect(diff.locator(".cell.del").first()).toContainText("−");
        await pwExpect(diff.locator(".cell.del").first()).toContainText("Removed:");
        await pwExpect(diff.locator(".cell.del code")).toContainText("/Atlas/");
        await pwExpect(diff.locator(".cell.add").first()).toContainText("+");
        await pwExpect(diff.locator(".cell.add").first()).toContainText("Added:");
        await pwExpect(diff.locator(".cell.add code")).toContainText("/Atlas shop/");
        // side by side on a wide screen
        const cols = await diff.locator(".code-diff-row").first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
        expect(cols).toBe(2);
        await shot("version-diff-light-1280");
        await axeBoth(async () => {
            await visit(editorHash(testId, "?history=1"));
            await editorReady();
            await page.locator('[data-version="2"]').getByLabel("Compare version 2").check();
            await page.locator('[data-version="1"]').getByLabel("Compare version 1").check();
            await pwExpect(page.getByTestId("diff-summary")).toBeVisible();
        }, "version-diff");

        // identical versions say so
        await list.locator('[data-version="1"]').getByLabel("Compare version 1").uncheck();
        await list.locator('[data-version="2"]').getByLabel("Compare version 2").uncheck();

        // restore: asks first, then makes a new version, shows it in the editor and follows the run
        await list.locator('[data-version="1"]').getByRole("button", { name: "Restore version 1" }).click();
        const dialog = page.getByRole("dialog", { name: "Restore version 1?" });
        await pwExpect(dialog).toContainText("saves version 1 again as the newest version");
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        expect(fake.calls.filter((c) => c.path.includes("/restore"))).toEqual([]);
        await list.locator('[data-version="1"]').getByRole("button", { name: "Restore version 1" }).click();
        await page.getByRole("dialog").getByRole("button", { name: "Restore this version", exact: true }).click();
        await pwExpect(page.getByText("Version 1 is restored")).toBeVisible();
        await pwExpect(page.getByRole("listitem").filter({ hasText: "Restored" }).first()).toContainText("Version 4");
        await pwExpect(page.locator(".cm-line", { hasText: "/Atlas/" }).first()).toBeVisible();
        expect(await editorText()).not.toContain("pricing page");
        await pwExpect(page.getByTestId("run-status")).toContainText("Queued");
    });
});

describe("Write a test from scratch", () => {
    it("validates the form, opens the editor with a starter script and creates the test", async () => {
        resetFake();
        await visit(`#/projects/${projectId}/scripts`);
        await page.getByRole("button", { name: "New test script", exact: true }).click();
        await page.getByRole("menuitem", { name: "Write code", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Write a test in code" });
        await pwExpect(dialog).toBeVisible();
        await dialog.getByLabel("Title").fill("ab");
        await dialog.getByRole("button", { name: "Open the editor", exact: true }).click();
        await pwExpect(dialog.getByText("Give the test a title of at least 3 characters.")).toBeVisible();
        await shot("write-form-light-1280");
        await axeBoth(async () => {
            await visit(`#/projects/${projectId}/scripts`);
            await page.getByRole("button", { name: "New test script", exact: true }).click();
        await page.getByRole("menuitem", { name: "Write code", exact: true }).click();
            await pwExpect(page.getByRole("dialog", { name: "Write a test in code" })).toBeVisible();
        }, "write-form");
        await dialog.getByLabel("Title").fill("Pricing table lists three plans");
        await dialog.getByLabel("Kind of test").selectOption("api");
        await dialog.getByLabel("Area (optional)", { exact: true }).fill("Pricing");
        await dialog.getByRole("button", { name: "Open the editor", exact: true }).click();

        await pwExpect(page).toHaveURL(new RegExp(`#/projects/${projectId}/write-code\\?`));
        await editorReady();
        const starter = await editorText();
        expect(starter).toContain("API_BASE_URL");
        for (const banned of ["sk-", "api_key", "TEST_PASSWORD", "password:"]) expect(starter).not.toContain(banned);
        await pwExpect(page.getByText("Problems are found when you save.")).toBeVisible();
        await page.getByRole("button", { name: "Create the test", exact: true }).click();

        await pwExpect(page).toHaveURL(new RegExp(`#/tests/${testId2}/code\\?`));
        const post = fake.calls.find((c) => c.method === "POST" && c.path.endsWith("/custom-tests"));
        expect(post?.body).toMatchObject({ title: "Pricing table lists three plans", kind: "api", category: "Pricing" });
        expect(post?.body.content).toContain("API_BASE_URL");
        await editorReady();
        await pwExpect(page.getByTestId("run-status")).toContainText("Queued");
        await pwExpect(page.getByText("Written as code", { exact: true }).first()).toBeVisible();
    });

    it("starts a web test from a browser example", async () => {
        resetFake();
        await visit(`#/projects/${projectId}/write-code?title=Home%20page%20opens&kind=web`);
        await editorReady();
        const starter = await editorText();
        expect(starter).toContain("BASE_URL");
        expect(starter).toContain("page.goto");
        await axeBoth(async () => {
            await visit(`#/projects/${projectId}/write-code?title=Home%20page%20opens&kind=web`);
            await editorReady();
        }, "write-editor");
    });
});

describe("Shared helpers", () => {
    it("lists helpers, adds one with a checked name, edits it, and refuses to delete one that tests use", async () => {
        resetFake();
        await visit(`#/projects/${projectId}/scripts`);
        // Helpers moved from the Library to Test scripts (round 25).
        await page.getByRole("navigation", { name: "Project sections", exact: true }).getByRole("link", { name: /^Test scripts/ }).click();
        await page.getByRole("link", { name: "Helpers (code)", exact: true }).click();
        await pwExpect(page.getByRole("heading", { name: "Shared helpers", exact: true })).toBeVisible();
        const rows = page.getByTestId("helpers").getByRole("listitem");
        await pwExpect(rows).toHaveCount(2);
        await pwExpect(rows.first()).toContainText("sign-in");
        await pwExpect(rows.first()).toContainText("used by 2 tests");
        await pwExpect(rows.nth(1)).toContainText("used by 0 tests");
        await pwExpect(page.getByTestId("import-example")).toHaveText('import { x } from "./helpers/sign-in";');
        await page.getByRole("button", { name: "Copy", exact: true }).click();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('import { x } from "./helpers/sign-in";');
        await shot("helpers-light-1280");
        await axeBoth(async () => {
            await visit(`#/projects/${projectId}/helpers`);
            await pwExpect(page.getByTestId("helpers").getByRole("listitem")).toHaveCount(2);
        }, "helpers");

        // name validation as the API
        await page.getByLabel("Name of a new helper").fill("Bad Name");
        await page.getByRole("button", { name: "Add a helper", exact: true }).click();
        await pwExpect(page.getByText("Use a lowercase name that starts with a letter")).toBeVisible();
        await page.getByLabel("Name of a new helper").fill("sign-in");
        await pwExpect(page.getByText("A helper with this name already exists.")).toBeVisible();
        await page.getByLabel("Name of a new helper").fill("cart-tools");
        await page.getByRole("button", { name: "Add a helper", exact: true }).click();
        await editorReady();
        await pwExpect(page.getByRole("heading", { name: "New helper: cart-tools" })).toBeVisible();
        expect(await editorText()).toContain("./helpers/cart-tools");
        await focusEditorEnd();
        await page.keyboard.type("\nexport const total = 3;", { delay: 5 });
        await page.getByRole("button", { name: "Save helper", exact: true }).click();
        await pwExpect(page.getByTestId("saved-notice")).toContainText("Tests that import this helper run again.");
        await pwExpect(page.getByTestId("helpers").getByRole("listitem")).toHaveCount(3);
        expect(fake.calls.find((c) => c.method === "PUT" && c.path.endsWith("/helpers/cart-tools"))?.body.content).toContain("export const total = 3;");

        // a helper with a guard error is not saved, and says why
        await focusEditorEnd();
        await page.keyboard.type('\nconst fs = require("fs");', { delay: 5 });
        await page.getByRole("button", { name: "Save helper", exact: true }).click();
        await pwExpect(page.getByRole("button", { name: /require is not allowed/ })).toBeVisible();
        await pwExpect(page.getByText("Not saved. Fix the problems listed below")).toBeVisible();

        // edit an existing helper (the editor asks before closing with changes)
        await page.getByRole("button", { name: "Close the editor", exact: true }).click();
        await page.getByRole("dialog").getByRole("button", { name: "Close and lose changes", exact: true }).click();
        await page.getByRole("button", { name: "Edit sign-in", exact: true }).click();
        await pwExpect(page.getByRole("heading", { name: "Editing: sign-in" })).toBeVisible();
        await pwExpect(page.locator(".cm-line", { hasText: "signIn" }).first()).toBeVisible();

        // delete: refused while tests import it, and they are named
        await page.getByRole("button", { name: "Delete sign-in", exact: true }).click();
        await page.getByRole("dialog").getByRole("button", { name: "Delete helper", exact: true }).click();
        await pwExpect(page.getByTestId("blocking-tests")).toContainText("Checkout works");
        await pwExpect(page.getByTestId("blocking-tests")).toContainText("Cart total");
        await page.getByRole("dialog").getByRole("button", { name: "Keep it", exact: true }).click();
        await pwExpect(page.getByTestId("helpers").locator('[data-helper="sign-in"]')).toBeVisible();

        // an unused helper deletes
        await page.getByRole("button", { name: "Delete unused-one", exact: true }).click();
        await page.getByRole("dialog").getByRole("button", { name: "Delete helper", exact: true }).click();
        await pwExpect(page.getByText("The helper “unused-one” is deleted.")).toBeVisible();
        await pwExpect(page.getByTestId("helpers").locator('[data-helper="unused-one"]')).toHaveCount(0);
    });
});

describe("Import from Git", () => {
    const openDialog = async () => {
        await visit(`#/projects/${projectId}/scripts`);
        await page.getByRole("button", { name: "New test script", exact: true }).click();
        await page.getByRole("menuitem", { name: "Import scripts…", exact: true }).click();
        await page.getByRole("dialog", { name: "Import tests", exact: true }).getByRole("button", { name: "Import from Git", exact: true }).click();
        await pwExpect(page.getByRole("dialog", { name: "Import from Git" })).toBeVisible();
        return page.getByRole("dialog", { name: "Import from Git" });
    };

    it("checks the address, previews files with their problems, and imports; the token is never kept", async () => {
        resetFake();
        const dialog = await openDialog();
        // https only
        await dialog.getByLabel("Repository address").fill("http://github.com/acme/tests");
        await dialog.getByRole("button", { name: "Preview", exact: true }).click();
        await pwExpect(dialog.getByText("Use an address that starts with https://")).toBeVisible();
        await dialog.getByLabel("Repository address").fill("git@github.com:acme/tests.git");
        await dialog.getByRole("button", { name: "Preview", exact: true }).click();
        await pwExpect(dialog.getByText("Use an address that starts with https://")).toBeVisible();
        expect(fake.calls.filter((c) => c.method === "POST")).toEqual([]);

        // a private repository: the platform says a token is needed; then it works
        await dialog.getByLabel("Repository address").fill("https://github.com/your-team/private-tests");
        await dialog.getByRole("button", { name: "Preview", exact: true }).click();
        await pwExpect(dialog.getByText("The repository asked for a sign-in. Add an access token and try again.")).toBeVisible();
        const token = dialog.getByLabel("Access token (optional)");
        expect(await token.getAttribute("type")).toBe("password");
        await token.fill(SECRET_TOKEN);
        await dialog.getByLabel("Branch or tag (optional)", { exact: true }).fill("main");
        await dialog.getByLabel("Subfolder (optional)").fill("tests");
        await dialog.getByRole("button", { name: "Preview", exact: true }).click();
        const preview = dialog.getByTestId("git-preview");
        await pwExpect(preview).toContainText("Found 3 files at commit 9f8e7d6");
        await pwExpect(preview).toContainText("Imports a package that is not allowed: lodash");
        await pwExpect(preview).toContainText("Has problems");
        await pwExpect(dialog.getByTestId("git-skipped")).toContainText("README.md: Not a Playwright test file");
        const importBtn = dialog.getByRole("button", { name: "Import 2 files", exact: true });
        await pwExpect(importBtn).toBeEnabled();
        await shot("git-preview-light-1280");
        // while it is open the token is in no storage, address or markup
        const where = async () => page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, href: location.href }));
        expect(await where()).not.toContain(SECRET_TOKEN);
        expect(await dialog.getByLabel("Access token (optional)").inputValue()).toBe(SECRET_TOKEN);
        // the only place the token appears in the markup is the password field itself
        const holders = await page.evaluate((t) => Array.from(document.querySelectorAll("*")).filter((el) => Array.from(el.attributes).some((a) => a.value.includes(t)) || Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").includes(t))).map((el) => `${el.tagName.toLowerCase()}#${el.id}`), SECRET_TOKEN);
        expect(holders).toEqual(["input#git-token"]);
        await axeBoth(async () => {
            const d = await openDialog();
            await d.getByLabel("Repository address").fill("https://github.com/your-team/your-tests");
            await d.getByRole("button", { name: "Preview", exact: true }).click();
            await pwExpect(d.getByTestId("git-preview")).toBeVisible();
        }, "git-preview");

        const dry = fake.calls.filter((c) => c.method === "POST" && c.body?.dryRun).at(-1);
        expect(dry?.body).toMatchObject({ url: "https://github.com/your-team/your-tests" });

        // editing the address drops the preview (it no longer describes what will be imported)
        const d2 = await openDialog();
        await d2.getByLabel("Repository address").fill("https://github.com/your-team/your-tests");
        await d2.getByRole("button", { name: "Preview", exact: true }).click();
        await pwExpect(d2.getByTestId("git-preview")).toBeVisible();
        await d2.getByLabel("Repository address").fill("https://github.com/your-team/other");
        await pwExpect(d2.getByTestId("git-preview")).toHaveCount(0);
        await d2.getByRole("button", { name: "Preview", exact: true }).click();
        await d2.getByLabel("Access token (optional)").fill(SECRET_TOKEN);
        await d2.getByRole("button", { name: "Import 2 files", exact: true }).click();
        const result = d2.getByTestId("git-result");
        await pwExpect(result).toContainText("1 test created, 1 test updated, 1 file skipped.");
        await pwExpect(result).toContainText("We are running them now.");
        await pwExpect(result).toContainText("tests/legacy.spec.ts: It has problems");
        // the token field is cleared after the import and nothing kept it
        await pwExpect(d2.getByLabel("Access token (optional)")).toHaveValue("");
        expect(await where()).not.toContain(SECRET_TOKEN);
        expect(await page.content()).not.toContain(SECRET_TOKEN);
        // the new repository is listed
        await pwExpect(d2.getByTestId("repos")).toContainText("github.com/your-team/your-tests");

        // closing and opening again: empty fields
        await d2.getByRole("button", { name: "Close", exact: true }).click();
        const d3 = await openDialog();
        await pwExpect(d3.getByLabel("Access token (optional)")).toHaveValue("");
        await pwExpect(d3.getByLabel("Repository address")).toHaveValue("");
        expect(consoleErrors.join("\n")).not.toContain(SECRET_TOKEN);
    });

    it("disables Import while no file can be imported, and handles an empty result", async () => {
        resetFake();
        const dialog = await openDialog();
        await pwExpect(dialog.getByRole("button", { name: /^Import \d+ files?$/ })).toHaveCount(0);
        await pwExpect(dialog.getByText("Repositories", { exact: true })).toBeVisible();
    });

    it("lists repositories and checks, refreshes (asking for a token again) and unlinks them", async () => {
        resetFake();
        const dialog = await openDialog();
        const repo = dialog.getByTestId("repos").locator('[data-repo="gr-1"]');
        await pwExpect(repo).toContainText("github.com/acme/tests");
        await pwExpect(repo).toContainText("main, commit abc1234, imported");
        await pwExpect(repo).toContainText("3 tests");
        expect(await repo.textContent()).not.toContain("·");

        await repo.getByRole("button", { name: /Check acme\/tests for updates/ }).click();
        await pwExpect(repo).toContainText("A newer commit fff0000 exists. 1 test differs: tests/login.spec.ts. Refresh to update them.");
        fake.repoUpToDate = true;
        await repo.getByRole("button", { name: /Check acme\/tests for updates/ }).click();
        await pwExpect(repo).toContainText("Up to date with the repository.");

        await repo.getByRole("button", { name: /Refresh acme\/tests/ }).click();
        const tok = repo.getByLabel("Access token (only if the repository is private)");
        await pwExpect(tok).toBeVisible();
        await tok.fill(SECRET_TOKEN);
        await repo.getByRole("button", { name: "Refresh from the repository", exact: true }).click();
        await pwExpect(repo).toContainText("Refreshed: 1 test updated, 0 tests created.");
        expect(fake.calls.find((c) => c.path.endsWith("/refresh"))?.body).toEqual({ token: SECRET_TOKEN });
        expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(SECRET_TOKEN);

        await repo.getByRole("button", { name: /Remove the link to acme\/tests/ }).click();
        await pwExpect(repo).toContainText("The tests stay as code tests. Only the link to the repository is removed.");
        await repo.getByRole("button", { name: "Remove the link", exact: true }).click();
        await pwExpect(dialog.getByText("No repository is linked yet.")).toBeVisible();
        expect(fake.repos).toEqual([]);
    });
});

describe("Import from Git: files edited here (AZ2, L1)", () => {
    it("says before and after a refresh that an edited script is kept", async () => {
        resetFake();
        fake.editedHere = true;
        await visit(`#/projects/${projectId}/scripts`);
        await page.getByRole("button", { name: "New test script", exact: true }).click();
        await page.getByRole("menuitem", { name: "Import scripts…", exact: true }).click();
        await page.getByRole("dialog", { name: "Import tests", exact: true }).getByRole("button", { name: "Import from Git", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Import from Git" });
        const repo = dialog.getByTestId("repos").locator('[data-repo="gr-1"]');
        await repo.getByRole("button", { name: /Check acme\/tests for updates/ }).click();
        await pwExpect(repo).toContainText("1 test differs: tests/login.spec.ts. Refresh to update them. 1 test was edited here, so a refresh leaves it as it is.");
        await repo.getByRole("button", { name: /Refresh acme\/tests/ }).click();
        await repo.getByRole("button", { name: "Refresh from the repository", exact: true }).click();
        await pwExpect(repo).toContainText("1 test edited here was left as it is.");
        fake.editedHere = false;
    });
});

describe("Loading and layout", () => {
    it("keeps CodeMirror out of the main bundle and fetches the editor only on the editor page", async () => {
        const dist = path.join(REPO_ROOT, "web/dist");
        const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
        const entry = /src="\/?(assets\/index-[^"]+\.js)"/.exec(html)?.[1];
        expect(entry).toBeTruthy();
        const main = fs.readFileSync(path.join(dist, entry!), "utf8");
        const chunks = fs.readdirSync(path.join(dist, "assets")).filter((f) => /^CodeEditor-.*\.js$/.test(f));
        expect(chunks).toHaveLength(1);
        const chunk = fs.readFileSync(path.join(dist, "assets", chunks[0]!), "utf8");
        for (const marker of ["cm-content", "cm-editor", "cm-lineNumbers"]) {
            expect(main).not.toContain(marker);
            expect(chunk).toContain(marker);
        }
        // the entry does not statically depend on the chunk (it is loaded by a dynamic import only)
        expect(html).not.toContain(chunks[0]!);

        resetFake();
        fake.custom = makeCustom("taken-over");
        requested.length = 0;
        await visit(`#/tests/${testId}/steps`);
        await pwExpect(page.getByText("A code test has no list of steps")).toBeVisible();
        await visit(`#/projects/${projectId}/scripts`);
        await pwExpect(page.getByRole("heading", { name: "Scripts", exact: true })).toBeVisible();
        await visit(`#/projects/${projectId}/helpers`);
        await pwExpect(page.getByRole("heading", { name: "Shared helpers", exact: true })).toBeVisible();
        expect(requested.filter((p) => p.includes("CodeEditor-"))).toEqual([]);
        await visit(editorHash());
        await editorReady();
        expect(requested.filter((p) => p.includes("CodeEditor-"))).toHaveLength(1);
        expect(consoleErrors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
    });

    it("fits a phone: nothing scrolls sideways, the diff stacks, targets are at least 44 px", async () => {
        resetFake();
        fake.custom = makeCustom("taken-over");
        history3();
        await page.setViewportSize({ width: 375, height: 800 });
        await visit(editorHash(testId, "?history=1"));
        await editorReady();
        await pwExpect(page.getByTestId("versions")).toBeVisible();
        await page.locator('[data-version="2"]').getByLabel("Compare version 2").check();
        await page.locator('[data-version="1"]').getByLabel("Compare version 1").check();
        await pwExpect(page.getByTestId("diff-summary")).toBeVisible();
        await noOverflow();
        const stacked = await page.locator(".code-diff-row").first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
        expect(stacked).toBe(1);
        const small = await page.evaluate(() =>
            Array.from(document.querySelectorAll<HTMLElement>(".code-toolbar .btn, .code-version .btn, .code-version-pick"))
                .map((el) => ({ n: el.textContent?.trim() || el.className, h: Math.round(el.getBoundingClientRect().height) }))
                .filter((x) => x.h < 44),
        );
        expect(small).toEqual([]);
        await shot("editor-history-light-375");

        for (const hash of [testHash(), `#/projects/${projectId}/helpers`, `#/projects/${projectId}/write-code?title=Phone%20test&kind=web`]) {
            await visit(hash);
            await pwExpect(page.locator("h1")).toBeVisible();
            await page.waitForTimeout(300);
            await noOverflow();
        }
        await visit(`#/projects/${projectId}/scripts`);
        await page.getByRole("button", { name: "New test script", exact: true }).click();
        await page.getByRole("menuitem", { name: "Import scripts…", exact: true }).click();
        await page.getByRole("dialog", { name: "Import tests", exact: true }).getByRole("button", { name: "Import from Git", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Import from Git" });
        await dialog.getByLabel("Repository address").fill("https://github.com/your-team/your-tests");
        await dialog.getByRole("button", { name: "Preview", exact: true }).click();
        await pwExpect(dialog.getByTestId("git-preview")).toBeVisible();
        const box = await dialog.evaluate((el) => ({ w: el.getBoundingClientRect().width, scroll: el.scrollWidth - el.clientWidth }));
        expect(box.w).toBeLessThanOrEqual(375);
        expect(box.scroll).toBeLessThanOrEqual(1);
        await shot("git-preview-light-375");
        await page.keyboard.press("Escape");
        await page.setViewportSize({ width: 1280, height: 900 });
    });

    it("looks right in dark at 390 px (screenshots only when AS_SHOTS is set)", async () => {
        if (!shots) return;
        resetFake();
        fake.custom = makeCustom("taken-over");
        history3();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.emulateMedia({ colorScheme: "dark" });
        await page.waitForTimeout(400);
        await visit(editorHash(testId, "?history=1"));
        await editorReady();
        await focusEditorEnd();
        await page.keyboard.type('\nconst fs = require("fs");', { delay: 5 });
        await pwExpect(page.getByTestId("check-state")).toContainText("1 error", { timeout: 8000 });
        await shot("editor-problems-dark-390");
        await page.locator('[data-version="2"]').getByLabel("Compare version 2").check();
        await page.locator('[data-version="1"]').getByLabel("Compare version 1").check();
        await shot("version-diff-dark-390");
        await page.emulateMedia({ colorScheme: null });
        await page.setViewportSize({ width: 1280, height: 900 });
    });
});

describe("Against the real platform routes", () => {
    it("takes a test over, edits and saves it, reads the history, goes back to the generated version and manages a helper", async () => {
        // Only when the platform half is present and answers the shapes in CODE-API-SHAPES.md.
        const probe = await fetch(`http://127.0.0.1:${PLATFORM_PORT}/api/tests/${testId}/take-over`).catch(() => null);
        if (!probe || probe.status === 404) return;
        resetFake();
        fake.enabled = false;
        try {
            const realId = addTest(platform, seed, "checkout page");
            await visit(testHash(realId));
            await page.getByRole("button", { name: "Switch to code", exact: true }).last().click();
            const dialog = page.getByRole("dialog", { name: "Switch this test to code?" });
            await pwExpect(dialog.getByTestId("takeover-losses").getByRole("listitem").first()).toBeVisible({ timeout: 10_000 });
            await dialog.getByRole("button", { name: "Switch to code", exact: true }).last().click();
            await pwExpect(page).toHaveURL(new RegExp(`#/tests/${realId}/code`));
            await editorReady();
            await pwExpect(page.getByText("Code test", { exact: true }).first()).toBeVisible();

            // the real check finds a forbidden import while typing
            await focusEditorEnd();
            await page.keyboard.type('\nconst fs = require("fs");', { delay: 10 });
            await pwExpect(page.getByTestId("check-state")).toContainText("error", { timeout: 10_000 });
            await pwExpect(page.locator(".cm-lintRange-error").first()).toBeVisible();
            // the real save refuses it and keeps the text
            await page.getByRole("button", { name: "Save and run", exact: true }).click();
            await pwExpect(page.getByText("Not saved. Fix the problems listed below")).toBeVisible();
            expect(await editorText()).toContain("require");
            await page.getByRole("button", { name: "Discard changes", exact: true }).click();
            await page.getByRole("dialog").getByRole("button", { name: "Discard changes", exact: true }).click();

            // a valid edit saves as a new version; running is off on this platform, so the page says why
            await focusEditorEnd();
            await page.keyboard.type("\n// edited by hand", { delay: 10 });
            await page.getByRole("button", { name: "Save and run", exact: true }).click();
            await pwExpect(page.getByTestId("saved-version")).toBeVisible({ timeout: 10_000 });
            await pwExpect(page.getByTestId("run-status")).toContainText("Not run:");
            await page.getByRole("button", { name: "Version history", exact: true }).click();
            await expect.poll(async () => page.getByTestId("versions").getByRole("listitem").count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

            // back on the test page, the callout offers the generated version
            await visit(testHash(realId));
            await page.getByRole("button", { name: "Go back to the generated version", exact: true }).click();
            await page.getByRole("dialog").getByRole("button", { name: "Go back to the generated version", exact: true }).click();
            await pwExpect(page.getByText("This is a code test")).toHaveCount(0, { timeout: 10_000 });

            // helpers
            await visit(`#/projects/${projectId}/helpers`);
            await pwExpect(page.getByText("No shared helpers yet")).toBeVisible();
            await page.getByLabel("Name of a new helper").fill("real-helper");
            await page.getByRole("button", { name: "Add a helper", exact: true }).click();
            await editorReady();
            await page.getByRole("button", { name: "Save helper", exact: true }).click();
            await pwExpect(page.getByTestId("saved-notice")).toBeVisible({ timeout: 10_000 });
            await pwExpect(page.getByTestId("helpers").locator('[data-helper="real-helper"]')).toBeVisible();
            await page.getByRole("button", { name: "Delete real-helper", exact: true }).click();
            await page.getByRole("dialog").getByRole("button", { name: "Delete helper", exact: true }).click();
            await pwExpect(page.getByTestId("helpers")).toHaveCount(0);
        } finally {
            fake.enabled = true;
        }
    });
});
