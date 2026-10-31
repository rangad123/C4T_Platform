/**
 * The savings comparison end to end (`node scripts/eval.mjs --compare`), on the local DemoShop sample site only, with a scripted model double
 * (never a real model, never an outside site):
 *   - two platforms are started one after the other, each with its own fresh data folder, the savings OFF for the first and ON for the second
 *     (through the settings' environment variables), and each explores (after a warm-up) and creates and reruns the tests;
 *   - with the savings on, unchanged pages are not sent to the AI again, so fewer tokens are used, and the quality is the same: the verdict
 *     passes, and both result files say so;
 *   - a remote platform is refused, and so are --toggle / --warm without --compare.
 * Port 7352 (sample site). Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/eval-compare.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";
import { main } from "../src/eval/cli.js";
import type { CompareReport } from "../src/eval/compare.js";

const SAMPLE_PORT = 7352;
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
/** Which settings each platform was built with (the comparison passes them as environment variables). */
const seenConfigs: Array<Pick<Config, "LLM_DETERMINISTIC_REPAIR" | "LLM_EXPLORATION_REUSE" | "LLM_PROMPT_CACHE">> = [];
const scripted: LlmClient = {
    modelName: "scripted",
    model: languageModel,
    usage: { inputTokens: 0, outputTokens: 0 },
    text: async () => "",
    object: (async (args: { system: string; prompt: string }) => {
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
const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY", "CONCURRENCY", "AITP_EVAL_URL"];
const saved: Record<string, string | undefined> = {};
const lines: string[] = [];

beforeAll(() => {
    for (const k of KEYS) {
        saved[k] = process.env[k];
        process.env[k] = k === "CONCURRENCY" ? "1" : "";
    }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-eval-compare-"));
});
afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the savings comparison", () => {
    it("runs the corpus with the savings off then on, on two fresh platforms, and passes with fewer tokens", async () => {
        const out = path.join(tmp, "results");
        const code = await main(["--compare", "--warm", "--only", "sample-app", "--repeat", "1", "--yes", "--out", out, "--data-dir", path.join(tmp, "data")], {
            log: (s) => lines.push(s),
            makeLlm: (config) => {
                seenConfigs.push({ LLM_DETERMINISTIC_REPAIR: config.LLM_DETERMINISTIC_REPAIR, LLM_EXPLORATION_REUSE: config.LLM_EXPLORATION_REUSE, LLM_PROMPT_CACHE: config.LLM_PROMPT_CACHE });
                return scripted;
            },
            samplePort: SAMPLE_PORT,
            pollMs: 150,
            env: { ...process.env },
        });
        expect(code, lines.join("\n")).toBe(0);
        // Each platform got its side's settings.
        expect(seenConfigs.find((c) => c.LLM_EXPLORATION_REUSE === "false")).toMatchObject({ LLM_DETERMINISTIC_REPAIR: "false", LLM_PROMPT_CACHE: "false" });
        expect(seenConfigs.find((c) => c.LLM_EXPLORATION_REUSE === "true")).toMatchObject({ LLM_DETERMINISTIC_REPAIR: "true", LLM_PROMPT_CACHE: "true" });

        const files = fs.readdirSync(out);
        const json = files.find((f) => f.endsWith("-default-compare.json"))!;
        expect(json, files.join(", ")).toBeDefined();
        const report = JSON.parse(fs.readFileSync(path.join(out, json), "utf8")) as CompareReport & { runs: { baseline: unknown; candidate: unknown } };
        expect(report).toMatchObject({ kind: "compare", corpus: "default", warm: true, verdict: "pass", reasons: [], margins: { passPoints: 2, falseFailures: 0 } });
        expect(report.baseline).toMatchObject({ entriesDone: 1, created: 2, passRate: 1, falseFailures: 0, pagesReused: 0 });
        expect(report.candidate).toMatchObject({ entriesDone: 1, created: 2, passRate: 1, falseFailures: 0 });
        // The candidate re-explored the site it explored in the warm-up and did not send the unchanged pages again.
        expect(report.candidate.pagesReused).toBeGreaterThan(0);
        expect(report.candidate.tokens.input).toBeLessThan(report.baseline.tokens.input);
        expect(report.difference.totalTokens).toBeLessThan(0);
        expect(report.baseline.byModel.map((m) => m.model)).toEqual(["scripted"]);
        expect(report.runs.baseline).toBeDefined();
        const md = fs.readFileSync(path.join(out, json.replace(/\.json$/, ".md")), "utf8");
        expect(md).toContain("**Pass: quality held with the savings on.**");
        expect(md).toContain("| Unchanged pages not sent to the AI | 0 |");
        expect(lines.join("\n")).toMatch(/Pass: quality held with the savings on\. Tokens saved: [\d,]+ \(\d+(\.\d)?%\)/);
        console.log(`[eval-compare] input tokens ${report.baseline.tokens.input} with the savings off, ${report.candidate.tokens.input} on; pages reused ${report.candidate.pagesReused}`);
        // No eval run is kept on the platform for a comparison and nothing was written in ./data.
        expect(fs.existsSync(path.join(tmp, "data", "compare", "baseline"))).toBe(true);
    }, 900_000);

    it("refuses a remote platform, and comparison options without --compare", async () => {
        const log: string[] = [];
        expect(await main(["--compare", "--yes"], { log: (s) => log.push(s), env: { ...process.env, AITP_EVAL_URL: "http://127.0.0.1:1" } })).toBe(2);
        expect(log.join("\n")).toMatch(/cannot use a running platform/);
        expect(await main(["--warm"], { log: (s) => log.push(s), env: { ...process.env } })).toBe(2);
        expect(log.join("\n")).toMatch(/only go with --compare/);
    });
});
