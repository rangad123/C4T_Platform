/**
 * The UI side of AI judgement, driven in a real browser against a real platform whose "model" is a scripted local endpoint:
 *  1. the "New project" form: the AI screen review switch exists, is off by default, explains itself in plain words and sends
 *     what was chosen;
 *  2. a finding, a passing note and a "could not run" result are shown in plain language, with the screenshot the model looked at.
 * Requires `npm run build:web` (run inside the shared "browser" lock).
 *
 * Ports: fixture app 5473, scripted model endpoint 5474, platform 5475.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const FIX_PORT = 5473;
const MODEL_PORT = 5474;
const PLATFORM_PORT = 5475;
const FIX = `http://127.0.0.1:${FIX_PORT}`;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;

const fixture = http.createServer((req, res) => {
    const p = new URL(req.url ?? "/", FIX).pathname;
    const block = p === "/overlap" ? `<div style="position:absolute;left:0;top:0;width:100%;height:100%;background:#ff00ff"></div>` : "";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shop</title></head><body style="margin:0;font:16px sans-serif"><h1>Shop</h1><section style="position:relative;width:700px;height:260px;border:1px solid #888;padding:12px"><p>Cart total: $42.00</p>${block}</section></body></html>`);
});

const model = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
        const body = JSON.parse(raw || "{}") as { model: string; messages: Array<{ role: string; content: unknown }> };
        const user = body.messages.filter((m) => m.role === "user").at(-1)!;
        const text = Array.isArray(user.content) ? (user.content as Array<{ type: string; text?: string }>).filter((p) => p.type === "text").map((p) => p.text).join("\n") : String(user.content);
        const reply = (content: string) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        };
        if (text.includes("CUE:noimage")) {
            res.writeHead(400, { "content-type": "application/json" });
            return res.end(JSON.stringify({ error: { message: "This model does not support image input", type: "invalid_request_error" } }));
        }
        if (text.includes("CUE:high")) return reply(JSON.stringify({ ok: false, confidence: "high", problems: ["The pink banner covers the cart total"] }));
        if (text.includes("CUE:unsure")) return reply(JSON.stringify({ ok: false, confidence: "low", problems: ["Maybe the footer is too close"] }));
        reply(JSON.stringify({ ok: true, confidence: "high", problems: [] }));
    });
});

let browser: Browser;
let page: Page;
let platform: Platform;
let worker: Worker;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: run `npm run build:web` first");
    await new Promise<void>((r) => fixture.listen(FIX_PORT, "127.0.0.1", r));
    await new Promise<void>((r) => model.listen(MODEL_PORT, "127.0.0.1", r));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-visionui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "openai-compatible", LLM_BASE_URL: `http://127.0.0.1:${MODEL_PORT}/v1`, LLM_MODEL: "scripted-vision", LLM_API_KEY: "scripted-endpoint-key", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT) }));
    server = await buildServer(platform);
    await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
    worker = new Worker(platform, 200);
    worker.start();
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    await new Promise((r) => fixture.close(r));
    await new Promise((r) => model.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const api = async (method: "GET" | "POST", url: string, body?: unknown) => {
    const res = await fetch(`${BASE}/api${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
};

async function waitIdle(projectId: string) {
    for (let i = 0; i < 240; i++) {
        const jobs = (await api("GET", `/projects/${projectId}/jobs`)).body as Array<{ status: string }>;
        if (jobs.length && jobs.every((j) => ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status))) return;
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("job never finished");
}

const draft = (title: string, p: string, expected: string) => ({
    title,
    kind: "web",
    category: "AI judgement",
    type: "vision",
    priority: "medium",
    source: { origin: "vision-check" },
    steps: [{ action: "navigate", url: p }, { action: "assert", check: "looksRight", expected }],
});

describe("AI judgement results in the UI", () => {
    let projectId: string;

    beforeAll(async () => {
        projectId = (await api("POST", "/projects", { name: "Vision UI" })).body.id;
        const specs = [draft("Cart looks right on the overlapped page", "/overlap", "CUE:high"), draft("Footer spacing", "/fine", "CUE:unsure"), draft("Model without images", "/fine", "CUE:noimage")];
        const res = await api("POST", `/projects/${projectId}/specs`, { specs, baseUrl: FIX });
        expect(res.status).toBe(202);
        await waitIdle(projectId);
    }, 240_000);

    it("shows a finding in plain words with its severity, the steps and the screenshot the AI looked at", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/tests`);
        await pwExpect(page.getByRole("heading", { name: "Automated tests", exact: true })).toBeVisible();
        await page.locator("a.list-row", { hasText: "Cart looks right on the overlapped page" }).click();
        await pwExpect(page.getByText("This test found something that needs a look")).toBeVisible();
        const callout = page.locator(".callout", { hasText: "This test found something that needs a look" });
        await pwExpect(callout).toContainText("AI judgement — please look:");
        await pwExpect(callout).toContainText("a screen may not look right");
        await pwExpect(callout).toContainText("Step 2 (high confidence): The pink banner covers the cart total");
        await pwExpect(callout).toContainText("open the screenshot and decide for yourself");
        await pwExpect(callout).not.toContainText("[medium]");
        await pwExpect(callout).toContainText("Medium severity: a vision model thinks something looks wrong on screen.");
        const steps = page.locator("ol.bld-steps > li.bld-step");
        await pwExpect(steps).toHaveCount(2);
        await pwExpect(steps.last()).toContainText("Ask an AI reviewer whether the page looks right");
        await pwExpect(steps.last()).toHaveClass(/is-failed/);
        await pwExpect(steps.first()).not.toHaveClass(/is-failed/);
        const figure = page.locator("figure", { hasText: "What the AI reviewer looked at" });
        await pwExpect(figure.getByRole("img", { name: "Screenshot the AI reviewer looked at" })).toBeVisible();
        // the image really loaded (not a broken link)
        const loaded = await figure.locator("img").evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0);
        expect(loaded).toBe(true);
        await pwExpect(page.getByTestId("test-meta")).toContainText("AI judgement"); // type label
    });

    it("shows a low-confidence doubt as a plain note on a passing test", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/tests`);
        await page.locator("a.list-row", { hasText: "Footer spacing" }).click();
        const callout = page.locator(".callout", { hasText: "This test is passing" });
        await pwExpect(callout).toBeVisible();
        await pwExpect(callout).toContainText("AI judgement note (not sure)");
        await pwExpect(callout).toContainText("so the test still passes");
    });

    it("says plainly when the model cannot look at images", async () => {
        await page.goto(`${BASE}/#/projects/${projectId}/tests`);
        await page.locator("a.list-row", { hasText: "Model without images" }).click();
        const callout = page.locator(".callout", { hasText: "This test is failing" });
        await pwExpect(callout).toContainText("AI judgement could not run: the configured AI model does not accept images");
        await pwExpect(callout).toContainText("neither passed nor flagged");
    });
});

describe("New project form", () => {
    let made = 0;
    async function openAdvanced(url: string) {
        await page.goto(`${BASE}/#/new?url=${encodeURIComponent(url)}`);
        await pwExpect(page.getByLabel("Application URL")).toHaveValue(url);
        // Round 37: a new project's name is always typed (a taken name is refused, so each form gets its own).
        await page.getByLabel("Project name").fill(`Vision project ${++made}`);
        await page.getByText("Advanced options", { exact: true }).click();
    }

    it("offers the AI screen review switch, off by default, with plain wording, and sends what was chosen", async () => {
        // A port nothing listens on: the job is accepted (and its options stored) but ends at once.
        const dead = "http://127.0.0.1:5479/";
        await openAdvanced(dead);
        const box = page.getByRole("checkbox", { name: /AI screen review/ });
        await pwExpect(box).not.toBeChecked();
        await pwExpect(page.getByText("An AI model looks at screenshots of key pages and says whether the screen looks right", { exact: false })).toBeVisible();
        await pwExpect(page.getByText("Screenshots are sent to your AI provider.", { exact: false })).toBeVisible();

        const sent: Array<Record<string, unknown>> = [];
        await page.route("**/api/projects/*/test-generation", (route) => {
            sent.push(route.request().postDataJSON());
            return route.continue();
        });
        await page.getByRole("button", { name: "Start exploring" }).click();
        await page.waitForURL((u) => u.hash.startsWith("#/projects/"));
        await pwExpect.poll(() => sent.length).toBe(1);
        expect(sent[0]!.visionChecks).toBeUndefined();

        await openAdvanced(dead);
        await box.check();
        await pwExpect(page.getByText("We’ll test:", { exact: false })).toContainText("AI screen review");
        await page.getByRole("button", { name: "Start exploring" }).click();
        await pwExpect.poll(() => sent.length).toBe(2);
        expect(sent[1]).toMatchObject({ visionChecks: true });

        const projects = (await api("GET", "/projects")).body as Array<{ id: string }>;
        const options: Array<Record<string, unknown>> = [];
        for (const p of projects) for (const j of platform.repo.listJobs(p.id)) options.push(j.options as unknown as Record<string, unknown>);
        expect(options.some((o) => o.visionChecks === true)).toBe(true);
        for (const p of projects) await waitIdle(p.id).catch(() => undefined);
    }, 120_000);

    it("is switched off and unavailable for an API-only analysis", async () => {
        await openAdvanced(FIX + "/");
        await page.getByRole("checkbox", { name: /Web application/ }).uncheck();
        await pwExpect(page.getByRole("checkbox", { name: /AI screen review/ })).toBeDisabled();
    });
});
