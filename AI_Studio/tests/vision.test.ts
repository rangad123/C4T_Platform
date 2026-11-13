/**
 * Vision judgement ("does this screen look right?"), really executed: real Chromium screenshots of a local fixture app, the real
 * generated script run by Playwright, the real validator, the real platform (worker, API, artifact store) and the real provider code
 * talking HTTP to a scripted OpenAI-compatible endpoint. No real model is ever called.
 *
 * Doubles: (1) in-process `LlmClient`s that judge from the *pixels* they are sent (a coloured block stands for the problem), and
 * (2) a local HTTP server that plays the model for the platform run and judges from a cue in the prompt.
 *
 * Ports: fixture app 5470, scripted model endpoint 5471.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import type { EngineContext, EngineEvent } from "../src/engine/context.js";
import { launchChromium } from "../src/engine/discovery/browser.js";
import { renderScript } from "../src/engine/generators/index.js";
import { llmClientFromModel, LlmNotConfiguredError, unavailableLlmClient, type LlmClient } from "../src/engine/llm/provider.js";
import { ScenarioSchema, TestSpecSchema, describeStep, type TestSpec } from "../src/engine/spec/schema.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { applyVisionJudgement, judgeImage, visionImagesSent } from "../src/engine/vision/judge.js";
import { imageInfo, prepareImage, VisionImageError } from "../src/engine/vision/image.js";
import { generateVisionSpecs, parseVisionReason, visionFinding } from "../src/engine/vision/specs.js";
import {
    CONFIDENCES,
    JUDGE_SYSTEM,
    VerdictSchema,
    VISION_FAILURE_PREFIX,
    VISION_MAX_EDGE,
    VISION_MAX_IMAGES_PER_JOB,
    VISION_MAX_IMAGES_PER_TEST,
    VISION_MAX_LOOKS_PER_SCENARIO,
    VISION_MAX_OUTPUT_TOKENS,
    VISION_UNAVAILABLE_PREFIX,
    weigh,
} from "../src/engine/vision/verdict.js";
import { VISION_AUTHORING_NOTE } from "../src/engine/vision/look.js";
import { assessSeverity } from "../src/engine/validation/severity.js";
import { runScripts, type ScriptRun } from "../src/engine/validation/runner.js";
import { validateBatch, type TestUnderValidation, type ValidationOutcome } from "../src/engine/validation/validator.js";
import { authorWebSpec } from "../src/engine/web/author.js";
import { categorize } from "../src/cli/model.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const FIX_PORT = 5470;
const MODEL_PORT = 5471;
/** Not a real key: it must reach the (scripted) endpoint in the Authorization header and nowhere else. */
const API_KEY = "scripted-endpoint-key-1234";
const FIX = `http://127.0.0.1:${FIX_PORT}`;
const config = loadConfig({});

// ── fixture app: one fine page and pages where a coloured block covers the cart (the "problem") ─────────────────────────────

const COLOURS: Record<string, string> = { overlap: "#ff00ff", medium: "#ff8000", unsure: "#00ffff", garbage: "#ffff00" };
const page = (block = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shop</title></head>
<body style="margin:0;font:16px sans-serif"><h1>Shop</h1>
<section id="cart" style="position:relative;width:700px;height:260px;border:1px solid #888;padding:12px"><p>Cart total: $42.00</p><button>Checkout</button>${block}</section>
<p>Footer text</p><nav><a href="/fine">Fine</a> <a href="/overlap">Overlap</a></nav></body></html>`;
const fixture = http.createServer((req, res) => {
    const p = new URL(req.url ?? "/", FIX).pathname.replace(/^\//, "");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page(COLOURS[p] ? `<div style="position:absolute;left:0;top:0;width:100%;height:100%;background:${COLOURS[p]}"></div>` : ""));
});

// ── in-process model double: judges from the pixels it receives ────────────────────────────────────────────────────────────

type Call = { prompt: string; system: string; images: Array<{ bytes: number; mediaType: string; width: number; height: number }>; temperature?: number; maxOutputTokens?: number };

let browser: Browser;

/** Share of the picture covered by each marker colour (loose thresholds: JPEG blurs colours a little). */
async function colourShares(bytes: Uint8Array, mediaType: string): Promise<Record<string, number>> {
    const context = await browser.newContext();
    try {
        const p = await context.newPage();
        return await p.evaluate(
            async ({ b64, mediaType }) => {
                const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: mediaType }));
                const c = document.createElement("canvas");
                c.width = bmp.width;
                c.height = bmp.height;
                const g = c.getContext("2d")!;
                g.drawImage(bmp, 0, 0);
                const d = g.getImageData(0, 0, c.width, c.height).data;
                const n = { magenta: 0, orange: 0, cyan: 0, yellow: 0 };
                for (let i = 0; i < d.length; i += 4) {
                    const [r, gg, b] = [d[i]!, d[i + 1]!, d[i + 2]!];
                    if (r > 200 && gg < 70 && b > 200) n.magenta++;
                    else if (r > 220 && gg > 90 && gg < 170 && b < 70) n.orange++;
                    else if (r < 70 && gg > 200 && b > 200) n.cyan++;
                    else if (r > 200 && gg > 200 && b < 70) n.yellow++;
                }
                const total = d.length / 4;
                return { magenta: n.magenta / total, orange: n.orange / total, cyan: n.cyan / total, yellow: n.yellow / total };
            },
            { b64: Buffer.from(bytes).toString("base64"), mediaType },
        );
    } finally {
        await context.close();
    }
}

function pixelJudge(): { llm: LlmClient; calls: Call[] } {
    const calls: Call[] = [];
    const llm: LlmClient = {
        modelName: "pixel-double",
        model: {} as never,
        usage: { inputTokens: 0, outputTokens: 0 },
        object: async () => ({}) as never,
        text: async () => "",
        async imageObject(args) {
            calls.push({
                prompt: args.prompt,
                system: args.system,
                images: args.images.map((i) => ({ bytes: i.data.length, mediaType: i.mediaType, width: imageInfo(Buffer.from(i.data))?.width ?? 0, height: imageInfo(Buffer.from(i.data))?.height ?? 0 })),
                temperature: args.temperature,
                maxOutputTokens: args.maxOutputTokens,
            });
            const shares = await colourShares(args.images[0]!.data, args.images[0]!.mediaType);
            if (shares.yellow! > 0.02) return "it looks fine to me" as never; // garbage: not a verdict
            if (shares.magenta! > 0.02) return { ok: false, confidence: "high", problems: ["The pink banner covers the cart total and the Checkout button"] } as never;
            if (shares.orange! > 0.02) return { ok: false, confidence: "medium", problems: ["Something orange seems to sit on top of the cart"] } as never;
            if (shares.cyan! > 0.02) return { ok: false, confidence: "low", problems: ["There may be a blue-ish overlay on the cart"] } as never;
            return { ok: true, confidence: "high", problems: [] } as never;
        },
    };
    return { llm, calls };
}

function ctxOf(llm: LlmClient): { ctx: EngineContext; events: EngineEvent[] } {
    const events: EngineEvent[] = [];
    return { ctx: { config, llm, emit: (e) => events.push(e) }, events };
}

const emptyModel: AppModel = {
    url: FIX, origin: FIX, siteType: "ecommerce", purpose: "demo", features: [], pages: [], navigation: [], apis: [], journeys: [],
    authentication: { required: false, mechanisms: [], loggedIn: false }, externalDependencies: [], documentedTestCases: [],
    stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
};

const looksSpec = (id: string, title: string, steps: Array<Record<string, unknown>>): TestSpec =>
    TestSpecSchema.parse({ testId: id, title, kind: "web", category: "AI judgement", type: "vision", source: { origin: "vision-check" }, steps });
const lookAt = (p: string, expected = "", locator?: Record<string, unknown>) => [
    { action: "navigate", url: p },
    { action: "assert", check: "looksRight", expected, ...(locator ? { locator } : {}) },
];

async function validate(llm: LlmClient, specs: TestSpec[]): Promise<{ outcomes: ValidationOutcome[]; events: EngineEvent[]; runs: Map<string, ScriptRun[]> }> {
    const { ctx, events } = ctxOf(llm);
    const runs = new Map<string, ScriptRun[]>();
    const tests: TestUnderValidation[] = specs.map((spec) => ({ spec, framework: "playwright" }));
    const outcomes = await validateBatch(
        ctx,
        { browser, scratchDir: config.scratchDir, env: { baseUrl: FIX, headless: true }, render: { baseUrl: FIX }, model: emptyModel, maxRepairAttempts: 2, workers: 2 },
        tests,
        {
            async onAttempt(t, _a, _s, run) {
                runs.set(t.spec.testId, [...(runs.get(t.spec.testId) ?? []), run]);
            },
            async onFinal() {},
        },
    );
    return { outcomes, events, runs };
}

// ── the scripted "model" the platform run talks to over HTTP ───────────────────────────────────────────────────────────────

interface Seen { model: string; temperature?: number; prompt: string; system: string; images: Array<{ mediaType: string; bytes: number; width: number; height: number }>; headers: string }
const seen: Seen[] = [];
/** Requests that are judgements of a screenshot (the endpoint also answers the platform's text-only analysis calls). */
const judgements = () => seen.filter((s) => s.system === JUDGE_SYSTEM);
const modelServer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
        const body = JSON.parse(raw || "{}") as { model: string; temperature?: number; messages: Array<{ role: string; content: unknown }> };
        const user = body.messages.filter((m) => m.role === "user").at(-1)!;
        const parts = Array.isArray(user.content) ? (user.content as Array<{ type: string; text?: string; image_url?: { url: string } }>) : [];
        const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
        const images = parts
            .filter((p) => p.type === "image_url")
            .map((p) => {
                const m = /^data:(image\/[a-z]+);base64,(.*)$/.exec(p.image_url!.url)!;
                const buf = Buffer.from(m[2]!, "base64");
                return { mediaType: m[1]!, bytes: buf.length, width: imageInfo(buf)?.width ?? 0, height: imageInfo(buf)?.height ?? 0 };
            });
        seen.push({ model: body.model, temperature: body.temperature, prompt: text, system: String(body.messages.find((m) => m.role === "system")?.content ?? ""), images, headers: JSON.stringify(req.headers) });
        const reply = (content: string) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
        };
        if (text.includes("CUE:noimage")) {
            res.writeHead(400, { "content-type": "application/json" });
            return res.end(JSON.stringify({ error: { message: "This model does not support image input", type: "invalid_request_error" } }));
        }
        if (text.includes("CUE:garbage")) return reply("I think it looks fine.");
        if (text.includes("CUE:high")) return reply(JSON.stringify({ ok: false, confidence: "high", problems: ["The cart total is hidden behind a banner"] }));
        if (text.includes("CUE:medium")) return reply(JSON.stringify({ ok: false, confidence: "medium", problems: ["The Checkout button seems to be cut off"] }));
        if (text.includes("CUE:unsure")) return reply(JSON.stringify({ ok: false, confidence: "low", problems: ["Maybe the footer is too close"] }));
        return reply(JSON.stringify({ ok: true, confidence: "high", problems: [] }));
    });
});

let platform: Platform;
let worker: Worker;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;

beforeAll(async () => {
    await new Promise<void>((r) => fixture.listen(FIX_PORT, "127.0.0.1", r));
    await new Promise<void>((r) => modelServer.listen(MODEL_PORT, "127.0.0.1", r));
    browser = await launchChromium(true);
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-vision-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "openai-compatible", LLM_BASE_URL: `http://127.0.0.1:${MODEL_PORT}/v1`, LLM_MODEL: "scripted-vision", LLM_API_KEY: API_KEY }));
    server = await buildServer(platform);
    worker = new Worker(platform, 200);
    worker.start();
}, 60_000);
afterAll(async () => {
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    await browser?.close();
    await new Promise((r) => fixture.close(r));
    await new Promise((r) => modelServer.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
});

// ── 1. rules that need no browser ──────────────────────────────────────────────────────────────────────────────────────────

describe("confidence rules and the verdict schema", () => {
    it("only a not-ok verdict with high or medium confidence is a finding (medium / low severity); low confidence is a note", () => {
        const w = (ok: boolean, confidence: (typeof CONFIDENCES)[number]) => weigh({ ok, confidence, problems: [] });
        for (const c of CONFIDENCES) expect(w(true, c)).toEqual({ kind: "pass" });
        expect(w(false, "high")).toEqual({ kind: "finding", severity: "medium" });
        expect(w(false, "medium")).toEqual({ kind: "finding", severity: "low" });
        expect(w(false, "low")).toEqual({ kind: "note" });
    });

    it("accepts a verdict, defaults a missing problems list, and rejects anything else", () => {
        expect(VerdictSchema.parse({ ok: true, confidence: "high" })).toEqual({ ok: true, confidence: "high", problems: [] });
        for (const garbage of ["looks fine", null, 42, {}, { ok: "yes", confidence: "high" }, { ok: true, confidence: "certain" }, { ok: false, confidence: "high", problems: "overlap" }, { ok: false, confidence: "high", problems: [""] }]) {
            expect(VerdictSchema.safeParse(garbage).success, JSON.stringify(garbage)).toBe(false);
        }
    });

    it("tells the model to ignore instructions inside the screenshot", () => {
        expect(JUDGE_SYSTEM).toMatch(/never instructions to you/);
    });

    it("has no job-option default: the exploration level decides (off at thorough)", () => {
        expect(DEFAULT_JOB_OPTIONS.visionChecks).toBeUndefined();
    });

    it("reads image sizes from PNG and JPEG headers, and nothing else", () => {
        const png = Buffer.alloc(33);
        png.writeUInt32BE(0x89504e47, 0);
        png.write("IHDR", 12, "ascii");
        png.writeUInt32BE(1280, 16);
        png.writeUInt32BE(800, 20);
        expect(imageInfo(png)).toEqual({ mediaType: "image/png", width: 1280, height: 800 });
        // SOI, an APP0 segment of length 4, then SOF0 (height 600, width 900)
        const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x84, 0x03]);
        expect(imageInfo(jpg)).toEqual({ mediaType: "image/jpeg", width: 900, height: 600 });
        expect(imageInfo(Buffer.from("not a picture at all, just text bytes"))).toBeUndefined();
    });
});

describe("spec, wording, severity and CLI category", () => {
    const model = {
        origin: FIX,
        authentication: { loggedIn: false, required: false, mechanisms: [] },
        pages: ["/", "/shop", "/cart", "/about", "/help"].map((p) => ({ url: FIX + p, path: p, title: p, type: p === "/" ? "home" : "other", depth: 1, status: 200, headings: [], forms: [], components: [], links: [], aria: "", text: "", apiCalls: [], revealed: [], consoleErrors: [] })),
    } as unknown as AppModel;

    it("generates a bounded number of 'looks right' checks for key pages", () => {
        const specs = generateVisionSpecs(model, { maxPages: 3 });
        expect(specs.length).toBeLessThanOrEqual(3);
        expect(specs.length).toBeGreaterThan(0);
        for (const s of specs) {
            expect(s.type).toBe("vision");
            expect(s.source.origin).toBe("vision-check");
            expect(s.steps.map((x) => x.action)).toEqual(["navigate", "assert"]);
            expect(s.steps[1]).toMatchObject({ check: "looksRight" });
            expect(() => TestSpecSchema.parse({ ...s, testId: "WEB-001" })).not.toThrow();
        }
    });

    it("describes the step in plain words, with and without a question", () => {
        expect(describeStep({ action: "assert", check: "looksRight", expected: "", description: "" })).toBe("AI judgement: the page looks right");
        expect(describeStep({ action: "assert", check: "looksRight", expected: "the cart total is visible", description: "", locator: { by: "css", value: "#cart" } })).toBe('AI judgement: css "#cart" looks right (the cart total is visible)');
    });

    it("scores a high-confidence problem medium and a medium-confidence one low; others are not findings", () => {
        const spec = looksSpec("WEB-001", "AI check", lookAt("/overlap"));
        const reason = (sev: string) => `${VISION_FAILURE_PREFIX} a screen may not look right\n- [${sev}] Step 2 (high confidence): the banner covers the total\nHow to check: x`;
        expect(assessSeverity(spec, "NEEDS_REVIEW", reason("medium"))).toMatchObject({ severity: "medium", basis: expect.stringContaining("vision model") });
        expect(assessSeverity(spec, "NEEDS_REVIEW", reason("low"))?.severity).toBe("low");
        expect(parseVisionReason("Server error: something")).toBeUndefined();
        // a model-written problem that mentions other checks must not change the category or severity
        const tricky = `${VISION_FAILURE_PREFIX} a screen may not look right\n- [low] Step 2 (medium confidence): looks like a server error and a possible security issue\nHow to check: x`;
        expect(categorize(tricky)).toBe("ai-judgement");
        expect(assessSeverity(spec, "NEEDS_REVIEW", tricky)?.severity).toBe("low");
        expect(categorize("Input handling check failed: x")).toBe("input-handling");
    });

    it("renders no secrets and never expands placeholders in the question", () => {
        process.env.ANTHROPIC_API_KEY = "sk-ant-vision-SENTINEL-0123456789";
        try {
            const spec = looksSpec("WEB-002", "Question with a placeholder", lookAt("/fine", "Password {{credentials.password}} is not shown", { by: "css", value: "#cart" }));
            const { content } = renderScript(spec, "playwright", { baseUrl: FIX });
            expect(content).toContain("async function visionCapture");
            expect(content).toContain('visionCapture(page, test.info(), 1, "Password {{credentials.password}} is not shown", page.locator("#cart"))');
            expect(content).toContain("only saves a screenshot");
            expect(content).not.toMatch(/SENTINEL|ANTHROPIC|LLM_|sk-ant|TEST_PASSWORD|process\.env\.[A-Z_]*KEY/);
            expect(content).not.toContain("imageObject");
        } finally {
            process.env.ANTHROPIC_API_KEY = "";
        }
    });

    it("is not repeated by a script without the step (helper only where it is used)", () => {
        const plain = renderScript(looksSpec("WEB-003", "No vision step", [{ action: "navigate", url: "/fine" }, { action: "assert", check: "visible", expected: "Shop" }]), "playwright", { baseUrl: FIX });
        expect(plain.content).not.toContain("visionCapture");
    });
});

describe("the image call of the provider (imageObject)", () => {
    const verdict = JSON.stringify({ ok: false, confidence: "high", problems: ["x"] });
    const reply = (text: string) => ({
        content: [{ type: "text" as const, text }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: { inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } },
        warnings: [],
    });
    const schema = z.object({ ok: z.boolean(), confidence: z.string(), problems: z.array(z.string()) });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

    it("sends the image as an image part with temperature 0 and returns the parsed verdict", async () => {
        const opts: Array<Record<string, any>> = [];
        const model = new MockLanguageModelV3({ doGenerate: async (o) => (opts.push(o as never), reply(verdict)) });
        const client = llmClientFromModel(model, "mock");
        const out = await client.imageObject!({ system: "sys", prompt: "look", images: [{ data: jpeg, mediaType: "image/jpeg" }], schema, temperature: 0, maxOutputTokens: 55 });
        expect(out).toEqual({ ok: false, confidence: "high", problems: ["x"] });
        expect(opts).toHaveLength(1);
        expect(opts[0]!.temperature).toBe(0);
        expect(opts[0]!.maxOutputTokens).toBe(55);
        const userParts = (opts[0]!.prompt as Array<{ role: string; content: Array<Record<string, any>> }>).find((m) => m.role === "user")!.content;
        expect(userParts.find((p) => p.type === "text")!.text).toBe("look");
        const file = userParts.find((p) => p.type === "file")!;
        expect(file.mediaType).toBe("image/jpeg");
        expect(client.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    });

    it("retries once without temperature when the model refuses one, and gives up on other errors", async () => {
        const temps: Array<number | undefined> = [];
        const picky = new MockLanguageModelV3({
            doGenerate: async (o) => {
                temps.push(o.temperature);
                if (o.temperature !== undefined) throw new Error("temperature is not supported for this model");
                return reply(verdict);
            },
        });
        const out = await llmClientFromModel(picky, "mock").imageObject!({ system: "s", prompt: "p", images: [{ data: jpeg, mediaType: "image/jpeg" }], schema, temperature: 0 });
        expect(out.ok).toBe(false);
        expect(temps).toEqual([0, undefined]);

        const broken = new MockLanguageModelV3({ doGenerate: async () => { throw new Error("boom: model unavailable"); } });
        await expect(llmClientFromModel(broken, "mock").imageObject!({ system: "s", prompt: "p", images: [{ data: jpeg, mediaType: "image/jpeg" }], schema, temperature: 0 })).rejects.toThrow(/boom/);
    });

    it("the unavailable client fails loudly instead of pretending", async () => {
        await expect(unavailableLlmClient("no key").imageObject!({ system: "s", prompt: "p", images: [], schema })).rejects.toBeInstanceOf(LlmNotConfiguredError);
    });
});

// ── 2. judging real screenshots ────────────────────────────────────────────────────────────────────────────────────────────

async function shot(url: string, opts: { viewport?: { width: number; height: number }; type?: "png" | "jpeg"; selector?: string } = {}): Promise<Buffer> {
    const context = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 800 } });
    try {
        const p = await context.newPage();
        await p.goto(FIX + url);
        return await (opts.selector ? p.locator(opts.selector) : p).screenshot({ type: opts.type ?? "jpeg", ...(opts.type === "png" ? {} : { quality: 70 }) });
    } finally {
        await context.close();
    }
}

describe("preparing and sending screenshots", () => {
    it("shrinks a large screenshot to at most the edge limit, as a JPEG under the byte cap", async () => {
        const big = await shot("/fine", { viewport: { width: 2400, height: 1500 }, type: "png" });
        expect(imageInfo(big)).toMatchObject({ width: 2400, height: 1500 });
        const prepared = await prepareImage(browser, big);
        expect(prepared.downscaled).toBe(true);
        expect(prepared.mediaType).toBe("image/jpeg");
        expect(Math.max(prepared.width, prepared.height)).toBeLessThanOrEqual(VISION_MAX_EDGE);
        expect(prepared.width / prepared.height).toBeCloseTo(2400 / 1500, 1);
        expect(prepared.data.length).toBeLessThan(prepared.originalBytes);
        expect(prepared.data.length).toBeLessThanOrEqual(1_500_000);
    });

    it("refuses what it cannot shrink (no browser) or cannot read, instead of sending it", async () => {
        const big = await shot("/fine", { viewport: { width: 2400, height: 1500 }, type: "png" });
        await expect(prepareImage(undefined, big)).rejects.toBeInstanceOf(VisionImageError);
        await expect(prepareImage(browser, Buffer.from("definitely not an image"))).rejects.toThrow(/not a PNG or JPEG/);
        await expect(prepareImage(browser, big, { maxBytes: 100 })).rejects.toThrow(/still \d+ KB after shrinking/);
    });

    it("leaves a small picture alone", async () => {
        const small = await shot("/fine", { selector: "button" });
        const prepared = await prepareImage(browser, small);
        expect(prepared.downscaled).toBe(false);
        expect(prepared.data.equals(small)).toBe(true);
    });

    it("sends exactly one downscaled image with temperature 0, a bounded answer size and the question", async () => {
        const { llm, calls } = pixelJudge();
        const { ctx } = ctxOf(llm);
        const res = await judgeImage(ctx, browser, { image: await shot("/fine"), expected: "the cart total is visible and not overlapped", context: "WEB-001, step 2" });
        expect(res.state).toBe("verdict");
        expect(calls).toHaveLength(1);
        const c = calls[0]!;
        expect(c.images).toHaveLength(1);
        expect(c.images[0]!.mediaType).toBe("image/jpeg");
        expect(Math.max(c.images[0]!.width, c.images[0]!.height)).toBeLessThanOrEqual(VISION_MAX_EDGE);
        expect(c.images[0]!.bytes).toBeLessThanOrEqual(1_500_000);
        expect(c.temperature).toBe(0);
        expect(c.maxOutputTokens).toBe(VISION_MAX_OUTPUT_TOKENS);
        expect(c.prompt).toContain("the cart total is visible and not overlapped");
        expect(c.system).toBe(JUDGE_SYSTEM);
    });
});

describe("a judgement that cannot run is never a pass", () => {
    let image: Buffer;
    beforeAll(async () => {
        image = await shot("/fine");
    });
    const run = (llm: LlmClient) => judgeImage(ctxOf(llm).ctx, browser, { image });
    const withImage = (fn: LlmClient["imageObject"]): LlmClient => ({ ...pixelJudge().llm, imageObject: fn });

    it("treats garbage answers as unavailable", async () => {
        for (const garbage of ["looks fine", null, { ok: "yes", confidence: "high" }, { ok: true }, { ok: true, confidence: "sure" }, [], 7]) {
            const res = await run(withImage((async () => garbage) as never));
            expect(res, JSON.stringify(garbage)).toMatchObject({ state: "unavailable", reason: expect.stringContaining("not a usable verdict") });
        }
    });

    it("explains a missing model, a model without image support and a failed call in plain words", async () => {
        expect(await run(withImage(async () => { throw new LlmNotConfiguredError("No credentials"); }))).toMatchObject({ state: "unavailable", reason: expect.stringContaining("no AI model is set up") });
        expect(await run(withImage(async () => { throw new Error("400 This model does not support image input"); }))).toMatchObject({ state: "unavailable", reason: expect.stringContaining("does not accept images") });
        expect(await run(withImage(async () => { throw new Error("socket hang up"); }))).toMatchObject({ state: "unavailable", reason: expect.stringContaining("could not be reached") });
        const noImages: LlmClient = { ...pixelJudge().llm };
        delete noImages.imageObject;
        expect(await run(noImages)).toMatchObject({ state: "unavailable", reason: expect.stringContaining("cannot send images") });
        // keys in an error message are never repeated
        const leaky = await run(withImage(async () => { throw new Error("request failed for key sk-ant-api03-abcdefghijklmnop"); }));
        expect(JSON.stringify(leaky)).not.toContain("abcdefghijklmnop");
    });

    it("stops sending after the per-job image limit", async () => {
        const { llm, calls } = pixelJudge();
        const { ctx } = ctxOf({ ...llm, imageObject: async (a) => (calls.push({} as Call), ({ ok: true, confidence: "high", problems: [] }) as never) });
        const tiny = await shot("/fine", { selector: "button" });
        for (let i = 0; i < VISION_MAX_IMAGES_PER_JOB; i++) expect((await judgeImage(ctx, browser, { image: tiny })).state).toBe("verdict");
        const over = await judgeImage(ctx, browser, { image: tiny });
        expect(over).toMatchObject({ state: "unavailable", reason: expect.stringContaining(`limit of ${VISION_MAX_IMAGES_PER_JOB}`) });
        expect(calls).toHaveLength(VISION_MAX_IMAGES_PER_JOB);
        expect(visionImagesSent(ctx)).toBe(VISION_MAX_IMAGES_PER_JOB);
    }, 180_000);
});

// ── 3. the replayable check, through the real script, runner and validator ─────────────────────────────────────────────────

describe("looksRight in validation (real Playwright, pixel-judging double)", () => {
    let result: Awaited<ReturnType<typeof validate>>;
    let calls: Call[];
    const by = (id: string) => result.outcomes.find((o) => o.spec.testId === id)!;

    beforeAll(async () => {
        const judge = pixelJudge();
        calls = judge.calls;
        const six = [{ action: "navigate", url: "/fine" }, ...Array.from({ length: 6 }, () => ({ action: "assert", check: "looksRight", expected: "general look" }))];
        result = await validate(judge.llm, [
            looksSpec("WEB-101", "Fine page", lookAt("/fine", "the cart total is visible")),
            looksSpec("WEB-102", "Overlapped cart (high confidence)", lookAt("/overlap", "the cart total is visible and not overlapped")),
            looksSpec("WEB-103", "Overlapped cart (medium confidence)", lookAt("/medium")),
            looksSpec("WEB-104", "Unsure about the cart", lookAt("/unsure")),
            looksSpec("WEB-105", "Model answers nonsense", lookAt("/garbage")),
            looksSpec("WEB-106", "Only the cart element is judged", lookAt("/overlap", "cart", { by: "css", value: "#cart" })),
            looksSpec("WEB-107", "Many screenshots in one test", six),
            looksSpec("WEB-108", "Fails before judging", [...lookAt("/overlap"), { action: "assert", check: "visible", expected: "Text that is not on the page" }]),
        ]);
    }, 280_000);

    it("a screen that looks fine validates, with no reason attached", () => {
        expect(by("WEB-101").status).toBe("VALIDATED");
        expect(by("WEB-101").reason).toBeUndefined();
    });

    it("high confidence not-ok is a finding labelled 'AI judgement — please look', severity medium, screenshot attached", () => {
        const o = by("WEB-102");
        expect(o.status).toBe("NEEDS_REVIEW");
        expect(o.reason).toContain("AI judgement — please look:");
        expect(o.reason).toContain("- [medium] Step 2 (high confidence): The pink banner covers the cart total");
        expect(o.reason).toContain("How to check:");
        expect(assessSeverity(o.spec, o.status, o.reason)).toMatchObject({ severity: "medium" });
        expect(categorize(o.reason)).toBe("ai-judgement");
        const shots = o.lastRun.artifacts.filter((a) => a.kind === "vision-shot");
        expect(shots).toHaveLength(1);
        expect(fs.statSync(shots[0]!.path).size).toBeGreaterThan(500);
        expect(imageInfo(fs.readFileSync(shots[0]!.path))).toMatchObject({ mediaType: "image/jpeg", width: 1280, height: 800 });
        // the run itself is recorded as failed at the judged step, so history and trends agree with the finding
        expect(o.lastRun.status).toBe("failed");
        expect(o.lastRun.failedStepIndex).toBe(1);
        expect(visionFinding(o.spec, o.lastRun)).toContain("may not look right");
    });

    it("medium confidence not-ok is a finding with low severity", () => {
        const o = by("WEB-103");
        expect(o.status).toBe("NEEDS_REVIEW");
        expect(o.reason).toContain("- [low] Step 2 (medium confidence)");
        expect(assessSeverity(o.spec, o.status, o.reason)?.severity).toBe("low");
    });

    it("low confidence never fails the test: it passes with a plain note", () => {
        const o = by("WEB-104");
        expect(o.status).toBe("VALIDATED");
        expect(o.reason).toMatch(/^AI judgement note \(not sure\): step 2/);
        expect(o.reason).toContain("so the test still passes");
        expect(o.lastRun.status).toBe("passed");
    });

    it("a nonsense answer fails validation with a plain reason: not a pass, not a finding", () => {
        const o = by("WEB-105");
        expect(o.status).toBe("FAILED_VALIDATION");
        expect(o.reason).toMatch(/^AI judgement could not run: the model's answer was not a usable verdict/);
        expect(o.reason).toContain("neither passed nor flagged");
        expect(assessSeverity(o.spec, o.status, o.reason)).toBeUndefined();
        expect(result.events.some((e) => e.kind === "vision_unavailable" && e.message.includes("WEB-105"))).toBe(true);
    });

    it("judges an element's screenshot when the step has a locator (only the cart, not the page)", () => {
        const o = by("WEB-106");
        expect(o.status).toBe("NEEDS_REVIEW");
        const shot = o.lastRun.artifacts.find((a) => a.kind === "vision-shot")!;
        const info = imageInfo(fs.readFileSync(shot.path))!;
        expect(info.width).toBeLessThan(800);
        expect(info.height).toBeLessThan(400);
    });

    it("judges at most the per-test number of screenshots and says that the rest were not judged", () => {
        const o = by("WEB-107");
        expect(o.status).toBe("VALIDATED");
        expect(o.reason).toContain(`only the first ${VISION_MAX_IMAGES_PER_TEST} of 6 screenshots`);
        expect(calls.filter((c) => c.prompt.includes("general look"))).toHaveLength(VISION_MAX_IMAGES_PER_TEST);
    });

    it("sends nothing to the model for a run that already failed", () => {
        const o = by("WEB-108");
        expect(o.status).toBe("FAILED_VALIDATION");
        expect(o.reason).not.toContain("AI judgement");
        expect(o.lastRun.vision?.length).toBe(1); // the screenshot was taken ...
        expect(o.lastRun.visionJudged).toBeUndefined(); // ... but never judged
    });

    it("sent real, downscaled, size-capped images with temperature 0 every time", () => {
        expect(calls.length).toBeGreaterThanOrEqual(7);
        for (const c of calls) {
            expect(c.images).toHaveLength(1);
            expect(c.temperature).toBe(0);
            expect(Math.max(c.images[0]!.width, c.images[0]!.height)).toBeLessThanOrEqual(VISION_MAX_EDGE);
            expect(c.images[0]!.bytes).toBeLessThanOrEqual(1_500_000);
        }
    });
});

describe("no usable model in validation", () => {
    const fine = () => looksSpec("WEB-201", "Fine page", lookAt("/fine"));

    it("no model configured: FAILED_VALIDATION with a clear reason, never a pass", async () => {
        const { outcomes, events } = await validate(unavailableLlmClient("No credentials for LLM provider"), [fine()]);
        expect(outcomes[0]!.status).toBe("FAILED_VALIDATION");
        expect(outcomes[0]!.reason).toMatch(/^AI judgement could not run: no AI model is set up/);
        expect(events.some((e) => e.kind === "vision_unavailable")).toBe(true);
    }, 90_000);

    it("a client that cannot send images: FAILED_VALIDATION too", async () => {
        const llm: LlmClient = { ...pixelJudge().llm };
        delete llm.imageObject;
        const { outcomes } = await validate(llm, [fine()]);
        expect(outcomes[0]!.status).toBe("FAILED_VALIDATION");
        expect(outcomes[0]!.reason).toContain("cannot send images");
    }, 90_000);
});

describe("the downloaded script", () => {
    it("run on its own saves the screenshot and never judges: it passes even for an overlapped page, and says so", async () => {
        const spec = looksSpec("WEB-301", "Overlapped cart", lookAt("/overlap", "the cart total is visible"));
        const script = renderScript(spec, "playwright", { baseUrl: FIX });
        const [run] = await runScripts(config.scratchDir, [{ testId: spec.testId, filename: script.filename, content: script.content }], { baseUrl: FIX, headless: true });
        expect(run!.status, run!.error).toBe("passed");
        expect(run!.vision).toHaveLength(1);
        expect(run!.vision![0]).toMatchObject({ step: 1, expected: "the cart total is visible" });
        expect(run!.visionJudged).toBeUndefined();
        expect(script.content).toContain("The model that judges it runs inside the platform");
        expect(script.content).toContain("this script does not judge it");
    }, 90_000);
});

// ── 4. authoring: the lookAtScreen tool ────────────────────────────────────────────────────────────────────────────────────

type ToolCall = { tool: string; input: Record<string, unknown> };
function scriptedAgent(calls: ToolCall[]) {
    let i = 0;
    const requests: Array<{ tools: string[]; system: string }> = [];
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    const model = new MockLanguageModelV3({
        doGenerate: async (options) => {
            requests.push({
                tools: ((options.tools ?? []) as Array<{ name: string }>).map((t) => t.name),
                system: JSON.stringify((options.prompt as Array<{ role: string; content: unknown }>).find((m) => m.role === "system")?.content ?? ""),
            });
            const next = calls[i++];
            if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
            return { content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
        },
    });
    return { model, requests };
}

const scenario = ScenarioSchema.parse({ scenarioId: "S-001", title: "Cart shows the total", description: "The cart total is visible", category: "Cart", startPath: "/overlap", expectedResults: ["The cart shows the total"] });
const finishOk: ToolCall[] = [{ tool: "assert", input: { check: "text", target: { by: "css", value: "#cart" }, expected: "Cart total" } }, { tool: "finish", input: { result: "complete", explanation: "done" } }];

describe("authoring with lookAtScreen", () => {
    const authorWith = (llm: LlmClient, agent: ReturnType<typeof scriptedAgent>, vision: boolean | undefined) => {
        const { ctx, events } = ctxOf({ ...llm, model: agent.model });
        const actions: Array<{ tool: string; ok: boolean; observation: string }> = [];
        const promise = authorWebSpec({ ctx, browser, baseUrl: FIX, model: emptyModel, scenario, ...(vision === undefined ? {} : { vision }), onAction: (a) => actions.push({ tool: a.tool, ok: a.ok, observation: a.observation }) });
        return { promise, events, actions };
    };

    it("off by default: the agent has no such tool and no picture is ever sent", async () => {
        const judge = pixelJudge();
        const agent = scriptedAgent(finishOk);
        const { promise } = authorWith(judge.llm, agent, undefined);
        const out = await promise;
        expect(out.status).toBe("complete");
        expect(out.observations).toBeUndefined();
        expect(agent.requests[0]!.tools).not.toContain("lookAtScreen");
        expect(agent.requests[0]!.system).not.toContain("lookAtScreen");
        expect(judge.calls).toHaveLength(0);
    }, 90_000);

    it("on: a screen the model finds wrong is recorded as an observation (and an event), never ignored", async () => {
        const judge = pixelJudge();
        const agent = scriptedAgent([{ tool: "lookAtScreen", input: { question: "cart total visible and not overlapped" } }, ...finishOk]);
        const { promise, events, actions } = authorWith(judge.llm, agent, true);
        const out = await promise;
        expect(out.status).toBe("complete");
        expect(agent.requests[0]!.tools).toContain("lookAtScreen");
        expect(agent.requests[0]!.system).toContain(VISION_AUTHORING_NOTE.trim().slice(0, 40));
        expect(out.observations).toHaveLength(1);
        expect(out.observations![0]).toContain("/overlap");
        expect(out.observations![0]).toContain("pink banner covers the cart total");
        expect(out.observations![0]).toContain("high confidence");
        expect(events.filter((e) => e.kind === "vision_observation")).toHaveLength(1);
        expect(actions.find((a) => a.tool === "lookAtScreen")).toMatchObject({ ok: true, observation: "ok=false confidence=high" });
        expect(judge.calls).toHaveLength(1);
        expect(judge.calls[0]!.images[0]).toMatchObject({ mediaType: "image/jpeg" });
        expect(Math.max(judge.calls[0]!.images[0]!.width, judge.calls[0]!.images[0]!.height)).toBeLessThanOrEqual(VISION_MAX_EDGE);
        expect(judge.calls[0]!.prompt).toContain("cart total visible and not overlapped");
        // the recorded steps are unchanged: looking never becomes a step
        expect(out.steps.map((s) => s.action)).toEqual(["navigate", "assert"]);
    }, 90_000);

    it("a screen that looks fine, or an unsure model, records nothing", async () => {
        const judge = pixelJudge();
        const agent = scriptedAgent([{ tool: "lookAtScreen", input: {} }, ...finishOk]);
        const fineScenario = { ...scenario, startPath: "/fine" };
        const { ctx } = ctxOf({ ...judge.llm, model: agent.model });
        const out = await authorWebSpec({ ctx, browser, baseUrl: FIX, model: emptyModel, scenario: fineScenario, vision: true });
        expect(out.status).toBe("complete");
        expect(out.observations).toBeUndefined();
        expect(judge.calls).toHaveLength(1);
        expect(judge.calls[0]!.prompt).toContain("General check");

        const unsure = pixelJudge();
        const agent2 = scriptedAgent([{ tool: "lookAtScreen", input: {} }, ...finishOk]);
        const { ctx: ctx2 } = ctxOf({ ...unsure.llm, model: agent2.model });
        const out2 = await authorWebSpec({ ctx: ctx2, browser, baseUrl: FIX, model: emptyModel, scenario: { ...scenario, startPath: "/unsure" }, vision: true });
        expect(out2.observations).toBeUndefined();
    }, 120_000);

    it(`caps the looks per scenario at ${VISION_MAX_LOOKS_PER_SCENARIO}`, async () => {
        const judge = pixelJudge();
        const agent = scriptedAgent([...Array.from({ length: 5 }, () => ({ tool: "lookAtScreen", input: {} })), ...finishOk]);
        const { promise, actions } = authorWith(judge.llm, agent, true);
        const out = await promise;
        expect(out.status).toBe("complete");
        expect(judge.calls).toHaveLength(VISION_MAX_LOOKS_PER_SCENARIO);
        expect(actions.filter((a) => a.tool === "lookAtScreen" && !a.ok && a.observation === "look limit reached")).toHaveLength(2);
        expect(out.observations).toHaveLength(VISION_MAX_LOOKS_PER_SCENARIO);
    }, 120_000);

    it("a model that cannot look: the tool says so once, authoring carries on and completes", async () => {
        const failing: LlmClient = { ...pixelJudge().llm, imageObject: async () => { throw new LlmNotConfiguredError("No credentials"); } };
        const agent = scriptedAgent([{ tool: "lookAtScreen", input: {} }, { tool: "lookAtScreen", input: {} }, ...finishOk]);
        const { promise, events } = authorWith(failing, agent, true);
        const out = await promise;
        expect(out.status).toBe("complete");
        expect(out.observations).toBeUndefined();
        expect(events.filter((e) => e.kind === "vision_unavailable")).toHaveLength(1);
        expect(events.find((e) => e.kind === "vision_unavailable")!.message).toContain("no AI model is set up");
    }, 90_000);
});

// ── 5. the whole platform: worker, API, artifacts, and the real provider over HTTP ─────────────────────────────────────────

describe("through the platform, with the real provider talking to a scripted endpoint", () => {
    const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
        const res = await server.inject({ method, url, payload: payload as never });
        return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, raw: res.rawPayload };
    };
    async function waitForJob(jobId: string) {
        for (let i = 0; i < 600; i++) {
            const j = (await call("GET", `/api/test-generation/${jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) return j;
            await new Promise((r) => setTimeout(r, 500));
        }
        throw new Error("job did not finish");
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
    type T = { id: string; title: string; validationStatus: string; validationReason: string | null; severity: { severity: string; basis: string } | null };
    let projectId = "";
    let tests: Record<string, T> = {};
    /** Everything else off, so a generation job here only exercises the AI checks (the model double cannot plan scenarios). */
    const onlyVisionRelevant = { accessibility: false, healthChecks: false, securityChecks: false, inputChecks: false, contractChecks: false, accessChecks: false, maxPages: 4, maxDepth: 1 };

    beforeAll(async () => {
        projectId = (await call("POST", "/api/projects", { name: "Vision" })).body.id;
        const specs = [
            draft("Fine", "/fine", "CUE:fine the cart total is visible"),
            draft("High problem", "/overlap", "CUE:high"),
            draft("Medium problem", "/medium", "CUE:medium"),
            draft("Unsure", "/unsure", "CUE:unsure"),
            draft("Garbage answer", "/garbage", "CUE:garbage"),
            draft("No image support", "/fine", "CUE:noimage"),
        ];
        const res = await call("POST", `/api/projects/${projectId}/specs`, { specs, baseUrl: FIX });
        expect(res.status).toBe(202);
        await waitForJob(res.body.jobId);
        tests = Object.fromEntries(((await call("GET", `/api/projects/${projectId}/tests`)).body as T[]).map((t) => [t.title, t]));
    }, 300_000);

    it("a fine screen validates; problems become findings with the right severity", () => {
        expect(tests["Fine"]!.validationStatus).toBe("VALIDATED");
        expect(tests["High problem"]).toMatchObject({ validationStatus: "NEEDS_REVIEW", severity: { severity: "medium" } });
        expect(tests["High problem"]!.validationReason).toContain("AI judgement — please look:");
        expect(tests["High problem"]!.validationReason).toContain("The cart total is hidden behind a banner");
        expect(tests["Medium problem"]).toMatchObject({ validationStatus: "NEEDS_REVIEW", severity: { severity: "low" } });
        expect(tests["Unsure"]!.validationStatus).toBe("VALIDATED");
        expect(tests["Unsure"]!.validationReason).toContain("AI judgement note");
    });

    it("a garbage answer and a model without image support fail validation with plain reasons", () => {
        expect(tests["Garbage answer"]!.validationStatus).toBe("FAILED_VALIDATION");
        expect(tests["Garbage answer"]!.validationReason).toContain("AI judgement could not run: the model's answer was not a usable verdict");
        expect(tests["Garbage answer"]!.severity).toBeNull();
        expect(tests["No image support"]!.validationStatus).toBe("FAILED_VALIDATION");
        expect(tests["No image support"]!.validationReason).toContain("AI judgement could not run: the configured AI model does not accept images");
    });

    it("the provider really sent a downscaled JPEG with temperature 0, and no secrets", () => {
        expect(judgements().length).toBeGreaterThanOrEqual(6);
        for (const s of judgements()) {
            expect(s.model).toBe("scripted-vision");
            expect(s.temperature).toBe(0);
            expect(s.images).toHaveLength(1);
            expect(s.images[0]).toMatchObject({ mediaType: "image/jpeg" });
            expect(Math.max(s.images[0]!.width, s.images[0]!.height)).toBeLessThanOrEqual(VISION_MAX_EDGE);
            expect(s.system).toBe(JUDGE_SYSTEM);
            expect(s.headers).toContain(API_KEY); // sent to the model endpoint, as configured ...
            expect(s.prompt + s.system).not.toContain(API_KEY); // ... but never part of what the model is asked
            expect(s.headers + s.prompt + s.system).not.toMatch(/TEST_PASSWORD|sk-ant|SECRET_KEY/);
        }
    });

    it("stores the judged screenshot as evidence the UI can fetch", async () => {
        const detail = (await call("GET", `/api/tests/${tests["High problem"]!.id}`)).body;
        const art = detail.executions[0].artifacts.find((a: { kind: string }) => a.kind === "vision-shot");
        expect(art).toBeTruthy();
        const img = await server.inject({ method: "GET", url: `/api/artifacts/${art.id}` });
        expect(img.headers["content-type"]).toBe("image/jpeg");
        expect(imageInfo(img.rawPayload)).toMatchObject({ mediaType: "image/jpeg", width: 1280, height: 800 });
        expect(detail.executions[0].status).toBe("failed");
        // the passing check keeps its screenshot too (evidence of what was judged)
        const fineDetail = (await call("GET", `/api/tests/${tests["Fine"]!.id}`)).body;
        expect(fineDetail.executions[0].artifacts.some((a: { kind: string }) => a.kind === "vision-shot")).toBe(true);
    });

    it("the stored script has no model call and no secrets, and re-renders from the spec", async () => {
        const detail = (await call("GET", `/api/tests/${tests["High problem"]!.id}`)).body;
        const content = detail.scripts[0].content as string;
        expect(content).toContain("visionCapture(page, test.info(), 1");
        expect(content).not.toMatch(/imageObject|api[_-]?key|TEST_PASSWORD|LLM_/i);
        expect(content).not.toContain(API_KEY);
    });

    it("the job option defaults to off: a normal analysis generates no AI checks and sends no picture", async () => {
        const sentBefore = judgements().length;
        const off = (await call("POST", "/api/projects", { name: "Vision off" })).body.id;
        const q = await call("POST", `/api/projects/${off}/test-generation`, { url: FIX, targets: ["web"], ...onlyVisionRelevant });
        expect(q.status).toBe(202);
        await waitForJob(q.body.jobId);
        expect((platform.repo.listJobs(off)[0]!.options as { visionChecks?: boolean }).visionChecks ?? false).toBe(false);
        const types = ((await call("GET", `/api/projects/${off}/tests`)).body as Array<{ type: string }>).map((t) => t.type);
        expect(types).not.toContain("vision");
        expect(judgements().length).toBe(sentBefore);
    }, 300_000);

    it("switched on, a real generation job adds 'looks right' checks for key pages and validates them through the model", async () => {
        const sentBefore = judgements().length;
        const on = (await call("POST", "/api/projects", { name: "Vision on" })).body.id;
        const q = await call("POST", `/api/projects/${on}/test-generation`, { url: FIX, targets: ["web"], visionChecks: true, ...onlyVisionRelevant });
        expect(q.status).toBe(202);
        await waitForJob(q.body.jobId);
        expect((platform.repo.listJobs(on)[0]!.options as { visionChecks?: boolean }).visionChecks).toBe(true);
        const list = (await call("GET", `/api/projects/${on}/tests`)).body as T[] & Array<{ type: string }>;
        const vision = list.filter((t) => (t as unknown as { type: string }).type === "vision");
        expect(vision.length).toBeGreaterThan(0);
        expect(vision.length).toBeLessThanOrEqual(3);
        for (const t of vision) expect(t.validationStatus, t.validationReason ?? "").toBe("VALIDATED");
        expect(judgements().length - sentBefore).toBeGreaterThanOrEqual(vision.length);
        const events = (await call("GET", `/api/test-generation/${q.body.jobId}/events`)).body as Array<{ kind: string }> | { events: Array<{ kind: string }> };
        const kinds = (Array.isArray(events) ? events : events.events).map((e) => e.kind);
        expect(kinds).toContain("vision_tests_generated");
    }, 400_000);
});
