/**
 * Evaluation harness end to end, on the two local fixtures of the shipped corpus (eval/corpus.json) and nothing else:
 *   - the command (src/eval/cli.ts `main`, what scripts/eval.mjs runs) starts its own platform, explores the DemoShop sample site in a REAL
 *     Chromium and the mock shop app on the FAKE adb (no phone, no emulator), creates the tests from the plans, reruns them, and writes the
 *     result files; the run is kept by the platform;
 *   - a second run against a RUNNING platform (AITP_EVAL_URL) is compared with the first, a quality gate fails it (exit code 1), and the
 *     phone fixture is skipped there with the reason;
 *   - stopping the command stops the job on the platform; without an AI model nothing starts (exit code 2);
 *   - no sign-in value reaches a result file;
 *   - Settings, Quality shows the kept runs and the comparison, axe-clean in light and dark, and fits a phone.
 * The AI is a scripted double (web: analysis, plan, tool calls; phone: tests/fixtures/phone-model.ts): never a real model, never an outside site.
 *
 * Ports: sample site 6711, platform (remote mode and UI) 6712. Needs web/dist. Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vite/bin/vite.js build web
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/eval.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { MockLanguageModelV3 } from "ai/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";
import { main } from "../src/eval/cli.js";
import type { EvalRun } from "../src/eval/run.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { scriptedPhoneModel, type Intent, type ScriptedPhoneModel } from "./fixtures/phone-model.js";

const SAMPLE_PORT = 6711;
const PLATFORM_PORT = 6712;
const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;
const SECRETS = ["Password123!", "Fake-Pass-1234", "demo-token-123"];
const hasUi = fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"));

// ── the scripted model ────────────────────────────────────────────────────────
const toolQueue: Array<{ tool: string; input: Record<string, unknown> }> = [];
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const languageModel = new MockLanguageModelV3({
    doGenerate: async () => {
        const next = toolQueue.shift();
        if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
        return { content: [{ type: "tool-call" as const, toolCallId: `c${Math.random()}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
    },
});
const IDEAS = [
    { title: "Browse the product list", journey: "Browse products", startPath: "/products", heading: "Products" },
    { title: "Open the home page", journey: "Visit the shop", startPath: "/", heading: "Welcome to DemoShop" },
] as const;
const shopTour = (): Intent[] => [{ tap: "Delete account" }, { tap: "Sign in" }, { type: "Username", text: "tester" }, { type: "Password", text: "hunter2" }, { tap: "Log in" }, { tap: "Products" }, { tap: "Product 1" }, { back: true }, { back: true }, { tap: "Cart" }, { finish: true }];
let phone: ScriptedPhoneModel = scriptedPhoneModel(shopTour());
/** A pause before every answer (the stop test uses it to catch the exploration while it runs). */
let delayMs = 0;
const scripted: LlmClient = {
    modelName: "scripted",
    model: languageModel,
    usage: { inputTokens: 0, outputTokens: 0 },
    text: async () => "",
    object: (async (args: { system: string; prompt: string }) => {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        if (/choosing and naming test ideas/.test(args.system) || args.prompt.includes("<screen untrusted-app-data>")) return phone.object(args as never);
        if (/analysing a web application/.test(args.system)) {
            return {
                siteType: "ecommerce",
                purpose: "A small outdoor shop",
                features: ["Browse products"],
                pagePurposes: [],
                journeys: IDEAS.map((i) => ({ name: i.journey, description: i.title, steps: [i.title], priority: "high", pages: [i.startPath], requiresAuth: false })),
                authenticationMechanisms: [],
            };
        }
        for (const s of IDEAS) {
            toolQueue.push({ tool: "assert", input: { check: "visible", target: { by: "role", role: "heading", value: s.heading } } });
            toolQueue.push({ tool: "finish", input: { result: "complete", explanation: "checked" } });
        }
        return { scenarios: IDEAS.map((s) => ScenarioSchema.omit({ scenarioId: true }).parse({ title: s.title, description: s.title, category: "Browsing", priority: "high", journey: s.journey, startPath: s.startPath, expectedResults: [`${s.heading} is shown`] })) };
    }) as LlmClient["object"],
};

let tmp: string;
let dataDir: string;
let outDir: string;
// No AI key; and one test written at a time, because the scripted tool calls come from one shared queue (the platform the command starts reads its settings from the environment).
const LLM_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY", "CONCURRENCY"];
const savedKeys: Record<string, string | undefined> = {};
const lines: string[] = [];
const log = (s: string) => lines.push(s);
/** Oldest first, by when they were written ("…-default-2.json" sorts before "…-default.json" by name). */
const resultFiles = () =>
    fs
        .readdirSync(outDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => ({ f, t: fs.statSync(path.join(outDir, f)).mtimeMs }))
        .sort((a, b) => a.t - b.t)
        .map((x) => x.f);
const readRun = (f: string) => JSON.parse(fs.readFileSync(path.join(outDir, f), "utf8")) as EvalRun;

let savedExplorer: string | undefined;
beforeAll(() => {
    // This file covers the AI-led explorer (PHONE_EXPLORER=ai; the eval command reads it from the environment); the map explorer is covered in tests/phone-explore-map-*.test.ts.
    savedExplorer = process.env.PHONE_EXPLORER;
    process.env.PHONE_EXPLORER = "ai";
    for (const k of LLM_KEYS) {
        savedKeys[k] = process.env[k];
        process.env[k] = k === "CONCURRENCY" ? "1" : "";
    }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-eval-"));
    dataDir = path.join(tmp, "data");
    outDir = path.join(tmp, "results");
});

afterAll(() => {
    if (savedExplorer === undefined) delete process.env.PHONE_EXPLORER;
    else process.env.PHONE_EXPLORER = savedExplorer;
    for (const [k, v] of Object.entries(savedKeys)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the evaluation command on the two local fixtures", () => {
    let first: EvalRun;

    it("explores, creates, reruns and measures both fixtures with its own platform, writes the results and keeps the run", async () => {
        const code = await main(["--repeat", "2", "--yes", "--out", outDir, "--data-dir", dataDir, "--fail-under", "stable=0.5,flaky=0.5"], { log, makeLlm: () => scripted, samplePort: SAMPLE_PORT, pollMs: 150, env: { ...process.env } });
        expect(code, lines.join("\n")).toBe(0);
        const files = resultFiles();
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}-default\.json$/);
        first = readRun(files[0]!);
        expect(fs.readFileSync(path.join(outDir, files[0]!.replace(/\.json$/, ".md")), "utf8")).toContain("# Evaluation: default");
        expect(first).toMatchObject({ corpus: "default", repeat: 2, planOnly: false, platform: { mode: "in-process", model: "scripted" } });
        expect(first.gates!.map((g) => g.passed)).toEqual([true, true]);

        const web = first.entries.find((e) => e.id === "sample-app")!;
        expect(web.status, web.reason).toBe("done");
        // The two journeys were planned and created, ran in the real browser, and passed every time.
        expect(web.metrics!.planned).toBe(2);
        expect(web.metrics!.created).toBe(2);
        expect(web.tests!.map((t) => [t.firstRun, t.reruns, t.outcome])).toEqual([
            ["passed", ["passed", "passed"], "stable-pass"],
            ["passed", ["passed", "passed"], "stable-pass"],
        ]);
        expect(web.rates).toMatchObject({ firstPass: 1, stable: 1, flaky: 0, duplicates: 0 });
        // Coverage: the home page and the products page of the pages the exploration found.
        expect(web.metrics!.coverageUnit).toBe("pages");
        expect(web.metrics!.covered).toBe(2);
        // (more than the two: the gate "coverage=1" of the second run relies on it)
        expect(web.metrics!.found).toBeGreaterThan(2);
        // AI use is the platform's own record: the analysis and the plan at least.
        expect(web.metrics!.aiCalls).toBeGreaterThanOrEqual(2);
        expect(web.metrics!.safetyRefusals).toBeNull();

        const shop = first.entries.find((e) => e.id === "fake-shop")!;
        expect(shop.status, shop.reason).toBe("done");
        expect(shop.metrics!.created).toBeGreaterThan(0);
        expect(shop.metrics!.created).toBe(shop.metrics!.planned);
        expect(shop.tests!.every((t) => t.reruns.length === 2)).toBe(true);
        expect(shop.metrics!.coverageUnit).toBe("screens");
        expect(shop.metrics!.covered).toBeGreaterThan(0);
        expect(shop.metrics!.covered).toBeLessThanOrEqual(shop.metrics!.found);
        // "Delete account" was refused by the platform's safety filter, and counted.
        expect(shop.metrics!.safetyRefusals).toBeGreaterThanOrEqual(1);
        expect(shop.metrics!.aiCalls).toBeGreaterThan(5);

        expect(first.overall.entriesDone).toBe(2);
        expect(first.overall.created).toBe(web.metrics!.created + shop.metrics!.created);
        for (const f of fs.readdirSync(outDir)) for (const s of SECRETS) expect(fs.readFileSync(path.join(outDir, f), "utf8")).not.toContain(s);
    }, 600_000);

    describe("against a running platform", () => {
        let platform: Platform;
        let server: Awaited<ReturnType<typeof buildServer>>;
        let worker: Worker;
        let browser: Browser | undefined;
        let page: Page;

        beforeAll(async () => {
            // The same data folder: the run the command kept is there.
            platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", CONCURRENCY: "1", SECRET_KEY: "test-secret-key-0123456789", PHONE_EXPLORER: "ai" }));
            platform.llm = scripted;
            server = await buildServer(platform);
            await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
            worker = new Worker({ ...platform, makeLlm: () => scripted }, 150);
            worker.start();
        }, 60_000);

        afterAll(async () => {
            await browser?.close();
            await worker?.stop();
            await server?.close();
            platform?.db.close();
        });

        it("measures again through the API, skips the phone fixture with the reason, compares with the first run and fails a gate", async () => {
            lines.length = 0;
            const code = await main(["--repeat", "1", "--yes", "--out", outDir, "--fail-under", "coverage=1"], { log, samplePort: SAMPLE_PORT, pollMs: 150, env: { ...process.env, AITP_EVAL_URL: BASE } });
            expect(code, lines.join("\n")).toBe(1);
            const second = readRun(resultFiles().at(-1)!);
            expect(second.platform.mode).toBe("remote");
            expect(second.entries.find((e) => e.id === "fake-shop")).toMatchObject({ status: "skipped", reason: expect.stringContaining("needs the platform the harness starts itself") });
            expect(second.entries.find((e) => e.id === "sample-app")!.status).toBe("done");
            expect(second.gates![0]).toMatchObject({ name: "coverage", passed: false });
            expect(lines.join("\n")).toContain("Gate coverage");
            const md = fs.readFileSync(path.join(outDir, resultFiles().at(-1)!.replace(/\.json$/, ".md")), "utf8");
            expect(md).toContain("## Compared with the previous run");
            const kept = (await (await fetch(`${BASE}/api/eval/runs`)).json()) as { runs: Array<{ id: string; comparison: { comparedWith: { id: string } } | null }> };
            expect(kept.runs).toHaveLength(2);
            expect(kept.runs[0]!.comparison!.comparedWith.id).toBe(kept.runs[1]!.id);
        }, 300_000);

        it("stops the job on the platform when the command is stopped", async () => {
            lines.length = 0;
            phone = scriptedPhoneModel(shopTour());
            delayMs = 400;
            const ac = new AbortController();
            const running = main(["--only", "sample-app", "--yes", "--out", outDir], { log, samplePort: SAMPLE_PORT, pollMs: 100, signal: ac.signal, env: { ...process.env, AITP_EVAL_URL: BASE } });
            for (let i = 0; i < 100 && !lines.some((l) => l.includes("exploring")); i++) await new Promise((r) => setTimeout(r, 100));
            ac.abort();
            expect(await running).toBe(3);
            delayMs = 0;
            const run = readRun(resultFiles().at(-1)!);
            const entry = run.entries[0]!;
            expect(entry).toMatchObject({ status: "failed", reason: "Stopped by you; the job in progress was stopped on the platform." });
            for (let i = 0; i < 100; i++) {
                const job = (await (await fetch(`${BASE}/api/test-generation/${entry.planJobId}`)).json()) as { status: string };
                if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) {
                    expect(job.status).toBe("FAILED");
                    return;
                }
                await new Promise((r) => setTimeout(r, 200));
            }
            throw new Error("the stopped job did not end");
        }, 120_000);

        it("starts nothing without an AI model (exit code 2, a plain message)", async () => {
            lines.length = 0;
            const code = await main(["--only", "sample-app", "--yes", "--out", outDir, "--data-dir", path.join(tmp, "no-model")], { log, samplePort: SAMPLE_PORT, env: { ...process.env } });
            expect(code).toBe(2);
            expect(lines.join("\n")).toContain("The evaluation needs an AI model.");
        }, 60_000);

        it.skipIf(!hasUi)("shows the kept runs in Settings, Quality, with the comparison; accessible in both themes and on a phone", async () => {
            browser = await chromium.launch();
            page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
            await page.goto(`${BASE}/#/settings`);
            const panel = page.getByTestId("quality-panel");
            await pwExpect(panel.getByRole("heading", { name: "Quality of the AI tester", exact: true })).toBeVisible();
            const rows = panel.getByTestId("eval-run");
            // Newest first: the stopped run, the run against the running platform, the first run.
            await pwExpect(rows).toHaveCount(3);
            await pwExpect(rows.nth(2).getByTestId("eval-stable")).toHaveText(`${Math.round(first.overall.rates.stable! * 1000) / 10}%`);
            await pwExpect(rows.first().getByTestId("eval-stable")).toHaveText("Not measured");
            await rows.nth(1).locator("summary").click();
            const detail = rows.nth(1).getByTestId("eval-detail");
            await pwExpect(detail.getByRole("table")).toContainText("sample-app");
            await pwExpect(detail.getByRole("table")).toContainText("Skipped");
            await pwExpect(detail.getByRole("list", { name: "Quality gates" })).toContainText("coverage");
            await pwExpect(detail.getByText(/^Compared with the run of /)).toBeVisible();
            for (const scheme of ["light", "dark"] as const) {
                await page.emulateMedia({ colorScheme: scheme });
                await page.waitForTimeout(400);
                const result = await new AxeBuilder({ page }).include('[data-testid="quality-panel"]').analyze();
                expect(result.violations.map((v) => `${v.id}: ${v.help} (${v.nodes[0]?.html.slice(0, 120)})`), scheme).toEqual([]);
            }
            await page.emulateMedia({ colorScheme: "light" });
            await page.setViewportSize({ width: 375, height: 800 });
            await pwExpect(panel).toBeVisible();
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
            // The run's summary row is a real touch target.
            expect((await rows.first().locator("summary").boundingBox())!.height).toBeGreaterThanOrEqual(44);
            // Removing asks first, and the projects stay.
            await detail.getByRole("button", { name: "Remove run", exact: true }).click();
            await pwExpect(detail.getByText("Remove this run from the list? The projects it created stay.")).toBeVisible();
            await detail.getByRole("button", { name: "Keep it", exact: true }).click();
            await pwExpect(rows).toHaveCount(3);
        }, 120_000);
    });
});
