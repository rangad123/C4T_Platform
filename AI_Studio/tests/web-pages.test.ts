/**
 * Frames, test files, drag and drop, popups and the test data reset, run for real: a local fixture application (an iframe with a frame
 * inside it, a file field and a button that opens the file chooser, an HTML5 drag-and-drop board, a link that opens a popup, a reset endpoint
 * that checks a header), the real platform API with a worker, real Playwright runs of the rendered scripts, and the real recorder.
 *
 * Browser-launching: run with  node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/web-pages.test.ts
 * Ports: fixture application 6850, platform 6851.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { expect as pwExpect } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { RecorderSession } from "../src/engine/recorder/session.js";
import { buildRecordedSpec } from "../src/engine/recorder/spec.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";

const APP_PORT = 6850;
const PLATFORM_PORT = 6851;
const APP = `http://127.0.0.1:${APP_PORT}`;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;
const RESET_TOKEN = "reset-sentinel-7f3a91";

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const PAGES: Record<string, string> = {
    "/frames": page("Checkout", `<h1>Checkout</h1><iframe name="checkout" src="/frame-outer" width="500" height="300"></iframe>`),
    "/frame-outer": page("Outer", `<p id="paid">Not paid</p><button onclick="document.getElementById('paid').textContent='Paid'">Pay</button><iframe title="Card" src="/frame-card" width="400" height="120"></iframe>`),
    "/frame-card": page("Card", `<label>Card name <input id="cn" oninput="document.getElementById('echo').textContent='Name: '+this.value"></label><p id="echo"></p>`),
    "/upload": page(
        "Upload",
        `<label>Avatar <input type="file" id="avatar" onchange="document.getElementById('got').textContent='Got '+this.files[0].name+' ('+this.files[0].size+' bytes)'"></label>
         <p id="got">No file</p>
         <input type="file" id="hidden-doc" style="display:none" onchange="document.getElementById('doc').textContent='Document '+this.files[0].name">
         <button onclick="document.getElementById('hidden-doc').click()">Choose a document</button><p id="doc">No document</p>`,
    ),
    "/board": page(
        "Board",
        `<ul aria-label="To do"><li id="card" draggable="true">Card 1</li></ul>
         <ul aria-label="Done" id="done" style="min-height:60px;border:1px solid #888"></ul><p id="moved">Not moved</p>
         <script>
           const card = document.getElementById("card"), done = document.getElementById("done");
           card.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", "card"));
           done.addEventListener("dragover", (e) => e.preventDefault());
           done.addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer.getData("text/plain") === "card") { done.appendChild(card); document.getElementById("moved").textContent = "Moved to done"; } });
         </script>`,
    ),
    "/popup": page("Sign up", `<h1>Sign up</h1><a href="/terms" target="_blank" rel="opener">Terms</a>`),
    "/terms": page("Terms of use", `<h1>Terms of use</h1><button onclick="document.getElementById('ok').textContent='Accepted'">Accept</button><p id="ok"></p>`),
};

let resets = 0;
let resetAnswer = 204;
const appServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", APP);
    if (url.pathname === "/test/reset") {
        if (req.method !== "POST" || req.headers["x-reset-token"] !== RESET_TOKEN) {
            res.writeHead(403).end("no");
            return;
        }
        resets++;
        res.writeHead(resetAnswer).end();
        return;
    }
    const html = PAGES[url.pathname];
    if (!html) {
        res.writeHead(404).end("not found");
        return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
});

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dataDir: string;
let projectId: string;

const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text } as { status: number; text: string; body: any };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function idle(): Promise<Array<{ jobId: string; status: string; error?: string }>> {
    for (let i = 0; i < 600; i++) {
        const jobs = (await call("GET", `/api/projects/${projectId}/jobs`)).body as Array<{ jobId: string; status: string; error?: string }>;
        if (jobs.length && jobs.every((j) => ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status))) return jobs;
        await sleep(400);
    }
    throw new Error("project never became idle");
}
const tests = async () => (await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; testId: string; validationStatus: string; validationReason?: string; reason?: string }>;
const byKey = async (key: string) => (await tests()).find((t) => t.testId === key)!;

const nav = (url: string) => ({ action: "navigate", url });
const SPECS = [
    {
        testId: "WEB-001",
        title: "Pay inside the checkout frame and type into the card frame",
        kind: "web",
        steps: [
            nav("/frames"),
            { action: "click", locator: { by: "role", role: "button", value: "Pay", frame: [{ by: "name", value: "checkout" }] } },
            { action: "assert", check: "text", locator: { by: "css", value: "#paid", frame: [{ by: "name", value: "checkout" }] }, expected: "Paid" },
            { action: "fill", locator: { by: "label", value: "Card name", frame: [{ by: "name", value: "checkout" }, { by: "title", value: "Card" }] }, value: "Ada" },
            { action: "assert", check: "text", locator: { by: "css", value: "#echo", frame: [{ by: "name", value: "checkout" }, { by: "url", value: "/frame-card" }] }, expected: "Name: Ada" },
        ],
    },
    {
        testId: "WEB-002",
        title: "Upload a test file into a field and through the file chooser",
        kind: "web",
        steps: [
            nav("/upload"),
            { action: "upload", locator: { by: "label", value: "Avatar" }, file: "avatar.png" },
            { action: "assert", check: "text", locator: { by: "css", value: "#got" }, expected: "Got avatar.png (68 bytes)" },
            { action: "upload", locator: { by: "role", role: "button", value: "Choose a document" }, file: "avatar.png" },
            { action: "assert", check: "text", locator: { by: "css", value: "#doc" }, expected: "Document avatar.png" },
        ],
    },
    {
        testId: "WEB-003",
        title: "Drag a card to the done list",
        kind: "web",
        steps: [nav("/board"), { action: "drag", locator: { by: "text", value: "Card 1" }, target: { by: "role", role: "list", value: "Done" } }, { action: "assert", check: "text", locator: { by: "css", value: "#moved" }, expected: "Moved to done" }],
    },
    {
        testId: "WEB-004",
        title: "Accept the terms in the popup",
        kind: "web",
        steps: [
            nav("/popup"),
            { action: "click", locator: { by: "role", role: "link", value: "Terms" }, opensPopup: true },
            { action: "assert", check: "title", expected: "Terms of use", inPopup: true },
            { action: "click", locator: { by: "role", role: "button", value: "Accept" }, inPopup: true },
            { action: "assert", check: "text", locator: { by: "css", value: "#ok" }, expected: "Accepted", inPopup: true },
            { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Sign up" } },
        ],
    },
    {
        testId: "WEB-005",
        title: "An upload of a file the library does not have",
        kind: "web",
        steps: [nav("/upload"), { action: "upload", locator: { by: "label", value: "Avatar" }, file: "missing.pdf" }],
    },
];

// 68 bytes: a tiny PNG header and padding; the fixture shows the size, which proves the real bytes arrived.
const AVATAR = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, 7)]);

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    await new Promise<void>((r) => appServer.listen(APP_PORT, "127.0.0.1", r));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-wp-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), CONCURRENCY: "1", MAX_REPAIR_ATTEMPTS: "0" }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 200);
    worker.start();
}, 60_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    await new Promise<void>((r) => appServer.close(() => r()));
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("test files", () => {
    it("are uploaded as raw bytes, capped by name, type and size, and listed", async () => {
        projectId = (await call("POST", "/api/projects", { name: "Pages" })).body.id;
        const put = (name: string, data: Buffer) => fetch(`${BASE}/api/projects/${projectId}/test-files?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(data) });
        const ok = await put("avatar.png", AVATAR);
        expect(ok.status, await ok.clone().text()).toBe(201);
        expect(await ok.json()).toMatchObject({ name: "avatar.png", size: 68, contentType: "image/png" });
        expect((await put("tool.exe", Buffer.from("MZ"))).status).toBe(400);
        expect((await put("..", Buffer.from("x"))).status).toBe(400);
        expect((await put("empty.txt", Buffer.alloc(0))).status).toBe(400);
        expect((await put("big.txt", Buffer.alloc(5 * 1024 * 1024 + 10, 1))).status).toBe(413);
        const list = (await call("GET", `/api/projects/${projectId}/test-files`)).body;
        expect(list.files.map((f: { name: string }) => f.name)).toEqual(["avatar.png"]);
        expect(JSON.stringify(list)).not.toContain(dataDir.replace(/\\/g, "\\\\")); // no server paths
        expect(list.limits.types).toContain("pdf");
    });
});

describe("frames, uploads, drag and drop and popups run for real", () => {
    it("imports the tests; they pass, and the one whose file is missing fails plainly", async () => {
        const imported = await call("POST", `/api/projects/${projectId}/specs`, { specs: SPECS, baseUrl: APP });
        expect(imported.status, imported.text).toBe(202);
        await idle();
        for (const key of ["WEB-001", "WEB-002", "WEB-003", "WEB-004"]) {
            const t = await byKey(key);
            expect(t.validationStatus, `${key}: ${t.validationReason ?? t.reason ?? ""}`).toBe("VALIDATED");
        }
        const missing = await byKey("WEB-005");
        expect(missing.validationStatus).toBe("FAILED_VALIDATION");
        expect(JSON.stringify(await call("GET", `/api/tests/${missing.id}`))).toMatch(/missing\.pdf.*is not available to this run/);
        // The library now knows who uses what: a used file cannot be removed, a missing one is listed.
        const list = (await call("GET", `/api/projects/${projectId}/test-files`)).body;
        expect(list.files[0].usedBy).toEqual(["WEB-002"]);
        expect(list.missing).toEqual([{ name: "missing.pdf", usedBy: ["WEB-005"] }]);
        const del = await call("DELETE", `/api/projects/${projectId}/test-files/avatar.png`);
        expect(del.status).toBe(409);
        expect(del.body.error).toMatch(/WEB-002/);
    }, 300_000);

    it("the stored script of each test is the rendered one, with frames, the upload helper, dragTo and the popup", async () => {
        const script = async (key: string) => JSON.stringify((await call("GET", `/api/tests/${(await byKey(key)).id}`)).body);
        expect(await script("WEB-001")).toContain("frameLocator");
        expect(await script("WEB-002")).toContain("uploadTestFile");
        expect(await script("WEB-003")).toContain("dragTo");
        expect(await script("WEB-004")).toContain("popupPage()");
    });
});

describe("the test data reset", () => {
    it("is saved with write-only, encrypted header values and keeps to the application's own site", async () => {
        const outside = await call("PUT", `/api/projects/${projectId}/test-data-reset`, { enabled: true, method: "POST", url: "https://elsewhere.example/reset", expectedStatus: 204, headers: [] });
        expect(outside.status).toBe(400);
        expect(outside.body.error).toMatch(/own site/);
        expect((await call("PUT", `/api/projects/${projectId}/test-data-reset`, { enabled: true, method: "POST", url: "/test/reset", headers: [{ name: "Host", value: "x" }] })).status).toBe(400);
        const saved = await call("PUT", `/api/projects/${projectId}/test-data-reset`, { enabled: true, method: "POST", url: "/test/reset", expectedStatus: 204, headers: [{ name: "X-Reset-Token", value: RESET_TOKEN }] });
        expect(saved.status, saved.text).toBe(200);
        expect(saved.body).toMatchObject({ environment: "", enabled: true, method: "POST", url: "/test/reset", headerNames: ["X-Reset-Token"], expectedStatus: 204 });
        const got = await call("GET", `/api/projects/${projectId}/test-data-reset`);
        expect(got.text).not.toContain(RESET_TOKEN);
        // Saving again without the value keeps it.
        expect((await call("PUT", `/api/projects/${projectId}/test-data-reset`, { enabled: true, method: "POST", url: "/test/reset", expectedStatus: 204, headers: [{ name: "X-Reset-Token" }] })).status).toBe(200);
        const raw = fs.readFileSync(path.join(dataDir, "platform.db"));
        expect(raw.includes(Buffer.from(RESET_TOKEN))).toBe(false);
        const tried = await call("POST", `/api/projects/${projectId}/test-data-reset/try`, {});
        expect(tried.body).toMatchObject({ ok: true, status: 204 });
        expect(tried.text).not.toContain(RESET_TOKEN);
        expect(resets).toBe(1);
    });

    it("runs before a run, and the run says so", async () => {
        const t = await byKey("WEB-003");
        const started = await call("POST", `/api/tests/${t.id}/validate`);
        expect(started.status, started.text).toBe(202);
        await idle();
        expect(resets).toBe(2);
        expect((await byKey("WEB-003")).validationStatus).toBe("VALIDATED");
        const events = (await call("GET", `/api/test-generation/${started.body.jobId}/events`)).body as Array<{ kind: string; message: string }>;
        expect(events.find((e) => e.kind === "test_data_reset_done")?.message).toMatch(/POST \/test\/reset answered 204/);
        expect(JSON.stringify(events)).not.toContain(RESET_TOKEN);
    }, 120_000);

    it("stops the run when it fails: no test runs and no result changes", async () => {
        resetAnswer = 500;
        const t = await byKey("WEB-003");
        const before = (await call("GET", `/api/tests/${t.id}`)).body;
        const started = await call("POST", `/api/tests/${t.id}/validate`);
        expect(started.status, started.text).toBe(202);
        const jobs = await idle();
        const job = jobs.find((j) => j.jobId === started.body.jobId)!;
        expect(job.status).toBe("FAILED");
        expect(job.error).toMatch(/The test data reset failed: POST \/test\/reset answered 500; 204 was expected\. No test was run/);
        const after = (await call("GET", `/api/tests/${t.id}`)).body;
        expect(after.validationStatus).toBe("VALIDATED");
        expect(JSON.stringify(after.executions ?? after.history ?? [])).toBe(JSON.stringify(before.executions ?? before.history ?? []));
        const hook = (await call("GET", `/api/projects/${projectId}/test-data-reset`)).body.hooks[0];
        expect(hook.last).toMatchObject({ ok: false });
        resetAnswer = 204;
        // Switched off: runs go ahead without calling it.
        await call("PUT", `/api/projects/${projectId}/test-data-reset`, { enabled: false, method: "POST", url: "/test/reset", expectedStatus: 204, headers: [{ name: "X-Reset-Token" }] });
        const n = resets;
        await call("POST", `/api/tests/${t.id}/validate`);
        await idle();
        expect(resets).toBe(n);
    }, 120_000);
});

describe("the recorder", () => {
    let browser: Browser | undefined;
    afterAll(async () => {
        await browser?.close().catch(() => undefined);
    });

    it("records actions inside frames, a chosen file's name, a drag and drop and the steps in a popup, and the result runs", async () => {
        const session = new RecorderSession({
            startUrl: `${APP}/frames`,
            headed: false,
            launch: async (headless) => (browser = await chromium.launch({ headless })),
        });
        session.start();
        let p: Page | undefined;
        for (let i = 0; i < 100 && !p; i++) {
            p = browser?.contexts()[0]?.pages()[0];
            if (!p || session.status !== "recording") {
                p = undefined;
                await sleep(100);
            }
        }
        expect(p, "the recording page").toBeTruthy();
        const rec = p!;
        const stepsWhen = async (n: number) => {
            for (let i = 0; i < 100; i++) {
                if (session.state().steps.length >= n) return session.state().steps;
                await sleep(100);
            }
            throw new Error(`only ${session.state().steps.length} steps: ${JSON.stringify(session.state().steps.map((s) => s.describe))} notes: ${session.state().notes.join(" | ")}`);
        };
        await rec.waitForLoadState("domcontentloaded");
        await rec.frameLocator('iframe[name="checkout"]').getByRole("button", { name: "Pay" }).click();
        let steps = await stepsWhen(2);
        expect(steps[1]).toMatchObject({ kind: "click", frame: [{ by: "name", value: "checkout" }], locator: { strategy: "role", value: "button", name: "Pay" } });

        await sleep(2800); // longer than a click is credited for a page load, so the typed address is a step of its own
        await rec.goto(`${APP}/upload`);
        await stepsWhen(3);
        const file = path.join(dataDir, "My avatar.png");
        fs.writeFileSync(file, AVATAR);
        await rec.setInputFiles("#avatar", file);
        steps = await stepsWhen(4);
        expect(steps[3]).toMatchObject({ kind: "upload", value: "My-avatar.png", locator: { strategy: "label" } });
        expect(session.state().notes.join(" ")).toMatch(/add “My-avatar\.png” to the project's test files/);

        await sleep(2800);
        await rec.goto(`${APP}/board`);
        await stepsWhen(5);
        await rec.dragAndDrop("#card", "#done");
        steps = await stepsWhen(6);
        expect(steps[5]).toMatchObject({ kind: "drag", locator: { value: "Card 1" } });
        expect(steps[5]!.target).toBeTruthy();

        await sleep(2800);
        await rec.goto(`${APP}/popup`);
        await stepsWhen(7);
        const opened = rec.waitForEvent("popup");
        await rec.getByRole("link", { name: "Terms" }).click();
        const popup = await opened;
        await popup.waitForLoadState("domcontentloaded");
        await sleep(500);
        await popup.getByRole("button", { name: "Accept" }).click();
        steps = await stepsWhen(9);
        expect(steps[7]).toMatchObject({ kind: "click", opensPopup: true });
        expect(steps[8]).toMatchObject({ kind: "click", inPopup: true, locator: { name: "Accept" } });
        await session.stop();

        // The recording becomes a test that the platform runs: the file is taken from the project's library by its recorded name.
        const put = await fetch(`${BASE}/api/projects/${projectId}/test-files?name=${encodeURIComponent("My-avatar.png")}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(AVATAR) });
        expect(put.status).toBe(201);
        const built = buildRecordedSpec({ title: "Recorded pages journey", startUrl: `${APP}/frames`, steps: session.state().steps });
        expect(built.problems).toEqual([]);
        const spec = TestSpecSchema.parse({ ...built.spec, testId: "WEB-010" });
        const imported = await call("POST", `/api/projects/${projectId}/specs`, { specs: [spec], baseUrl: APP });
        expect(imported.status, imported.text).toBe(202);
        await idle();
        const t = await byKey("WEB-010");
        expect(t.validationStatus, JSON.stringify(await call("GET", `/api/tests/${t.id}`)).slice(0, 2000)).toBe("VALIDATED");
    }, 240_000);
});

describe("the pages in the app (needs web/dist: build it inside the browser lock first)", () => {
    let browser: Browser | undefined;
    let ui: Page;
    beforeAll(async () => {
        if (!fs.existsSync(path.join(process.cwd(), "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first");
        browser = await chromium.launch();
        ui = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    }, 60_000);
    afterAll(async () => {
        await browser?.close().catch(() => undefined);
    });
    const axe = async () => {
        const { AxeBuilder } = await import("@axe-core/playwright");
        for (const scheme of ["light", "dark"] as const) {
            await ui.emulateMedia({ colorScheme: scheme });
            await ui.waitForTimeout(400);
            const r = await new AxeBuilder({ page: ui }).include("[data-testid=test-files]").include("[data-testid=reset-hook]").analyze();
            expect(r.violations.map((v) => `${scheme} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
        }
        await ui.emulateMedia({ colorScheme: null });
    };

    it("Settings, Test data: add a test file, see who uses each, try the reset; readable in both themes and at phone width", async () => {
        await ui.goto(`${BASE}/#/projects/${projectId}/settings?section=data`);
        const files = ui.getByTestId("test-files");
        await pwExpect(files.getByText("avatar.png", { exact: true })).toBeVisible();
        await pwExpect(files.getByText(/used by WEB-002/)).toBeVisible();
        await pwExpect(files.getByRole("button", { name: "Remove avatar.png" })).toBeDisabled();
        const extra = path.join(dataDir, "notes for test.txt");
        fs.writeFileSync(extra, "hello");
        await ui.locator("#wp-file").setInputFiles(extra);
        await files.getByRole("button", { name: "Add file", exact: true }).click();
        await pwExpect(files.getByText("Added notes-for-test.txt. Steps use it by that name.")).toBeVisible();
        await pwExpect(files.getByText("notes-for-test.txt", { exact: true })).toBeVisible();

        const reset = ui.getByTestId("reset-hook");
        await pwExpect(reset.getByLabel("Address")).toHaveValue("/test/reset");
        await pwExpect(reset.getByLabel("Value")).toHaveAttribute("placeholder", "Saved. Type to replace it");
        await pwExpect(reset.getByLabel("Value")).toHaveValue("");
        await reset.getByRole("button", { name: "Try it now", exact: true }).click();
        await pwExpect(reset.getByTestId("reset-outcome")).toContainText("POST /test/reset answered 204");
        expect(await ui.content()).not.toContain(RESET_TOKEN);
        await axe();

        await ui.setViewportSize({ width: 375, height: 800 });
        await ui.reload();
        await pwExpect(ui.getByTestId("reset-hook")).toBeVisible();
        expect(await ui.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
        await ui.setViewportSize({ width: 1280, height: 900 });
    }, 120_000);

    it("the step editor shows the new steps' forms: a frame, the test file choice, the drop target and the popup ticks", async () => {
        const open = async (key: string, step: number) => {
            await ui.goto("about:blank");
            await ui.goto(`${BASE}/#/tests/${(await byKey(key)).id}/steps`);
            await ui.locator(".bld-head").nth(step).click();
        };
        await open("WEB-001", 1);
        await pwExpect(ui.getByLabel("Inside a frame", { exact: true }).first()).toHaveValue("name");
        await pwExpect(ui.getByLabel("Frame name").first()).toHaveValue("checkout");
        await open("WEB-002", 1);
        await pwExpect(ui.getByLabel("Test file", { exact: true })).toHaveValue("avatar.png");
        await open("WEB-003", 1);
        await pwExpect(ui.getByRole("group", { name: "Where to drop it" })).toBeVisible();
        await open("WEB-004", 1);
        await pwExpect(ui.getByLabel("Opens a popup")).toBeChecked();
        await pwExpect(ui.locator(".bld-head").nth(3)).toContainText("in the popup");
    }, 120_000);
});
