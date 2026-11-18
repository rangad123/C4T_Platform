/**
 * The repeat-run benchmark command (`bench --mode repeat`, src/eval/bench/repeat/run.ts) end to end on bench-shop with a scripted model:
 * it proves the plumbing (two arms on their own platforms, a cold and a repeat run per project, the page changed between them through
 * the proxy, the measures read from the platform's records, the report written), not any saving. Also: the estimate starts nothing, and
 * a run with a real model is refused without one model, a price table, a budget and a daily cap.
 * Ports 9890–9891 (the app and its proxy). Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/bench-repeat-run.test.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { ExtractionAnswerSchema } from "../src/engine/intel/extract/rules.js";
import { NormalisedSchema } from "../src/engine/requirements/parse.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { benchMain } from "../src/eval/bench/cli.js";
import { ChangeProxy, PAGE_CHANGES } from "../src/eval/bench/repeat/change-proxy.js";
import { ARMS, repeatMain } from "../src/eval/bench/repeat/run.js";

const PORT = 9890;
const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY", "LLM_PROVIDER", "LLM_MODEL", "LLM_BASE_URL", "LLM_MODEL_FAST", "LLM_PROMPT_CACHE", "LLM_EXPLORATION_REUSE", "LLM_RESPONSE_CACHE", "CONCURRENCY"];
const saved: Record<string, string | undefined> = {};
let tmp = "";
const lines: string[] = [];
const log = (s: string) => lines.push(s);

/** Every model call, by the arm whose platform made it (its data folder is named after the arm). */
const calls: string[] = [];
const scriptedFor = (config: Config): LlmClient => {
    const arm = path.basename(config.DATA_DIR);
    return {
        modelName: "scripted",
        model: undefined as never,
        usage: { inputTokens: 0, outputTokens: 0 },
        text: async () => "",
        object: (async (args: { system: string; schema: unknown }) => {
            calls.push(arm);
            if (args.schema === ExtractionAnswerSchema) return { rules: [], workflows: [], roles: [], transitions: [], entities: [] };
            if (args.schema === NormalisedSchema) return { requirements: [] };
            if (/analysing a web application/.test(args.system)) return { siteType: "ecommerce", purpose: "A small shop", features: [], pagePurposes: [], journeys: [], authenticationMechanisms: [] };
            return { scenarios: [] };
        }) as LlmClient["object"],
    };
};
const deps = () => ({ log, makeLlm: scriptedFor, pollMs: 200, env: { ...process.env } });

beforeAll(() => {
    for (const k of KEYS) {
        saved[k] = process.env[k];
        if (k === "CONCURRENCY") process.env[k] = "1";
        else delete process.env[k];
    }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-repeat-"));
});
afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe("before anything starts", () => {
    it("--estimate-only through the bench command prints the arms and the estimate and starts nothing", async () => {
        lines.length = 0;
        const out = path.join(tmp, "estimate");
        expect(await benchMain(["--mode", "repeat", "--repeat", "5", "--estimate-only", "--out", out], deps())).toBe(0);
        expect(lines.join("\n")).toMatch(/Arms: on \(reuse and caches on\) and off; 5 trials per arm and app/);
        expect(lines.join("\n")).toMatch(/Estimate: at most [\d,]+ AI calls/);
        expect(fs.existsSync(out)).toBe(false);
    });

    it("a run with a real model is refused without one model, a price table, a budget and a daily cap", async () => {
        const { makeLlm: _m, ...real } = deps();
        const prices = path.join(tmp, "prices.json");
        fs.writeFileSync(prices, JSON.stringify([{ model: "m", inputPerMTok: 0, outputPerMTok: 0 }]));
        const refused = async (argv: string[], why: RegExp) => {
            lines.length = 0;
            expect(await repeatMain(["--mode", "repeat", "--apps", "bench-shop", "--out", path.join(tmp, "real"), ...argv], real)).toBe(2);
            expect(lines.join("\n")).toMatch(why);
        };
        await refused(["--prices", prices, "--approved-budget-usd", "1", "--daily-call-cap", "100"], /give --single-model/);
        await refused(["--single-model", "--approved-budget-usd", "1", "--daily-call-cap", "100"], /Give --prices/);
        await refused(["--single-model", "--prices", prices, "--daily-call-cap", "100"], /Give --approved-budget-usd/);
        await refused(["--single-model", "--prices", prices, "--approved-budget-usd", "1"], /Give --daily-call-cap/);
        expect(fs.existsSync(path.join(tmp, "real"))).toBe(false);
    });

    it("the off arm switches every saving off and explores its repeat as new; the on arm switches them on", () => {
        expect(ARMS.off.env).toEqual({ LLM_PROMPT_CACHE: "false", LLM_EXPLORATION_REUSE: "false", LLM_RESPONSE_CACHE: "false" });
        expect(ARMS.off.repeat).toEqual({ fullExploration: true, useMemory: false, responseCache: false });
        expect(Object.keys(ARMS.on.env).sort()).toEqual(Object.keys(ARMS.off.env).sort());
        expect(Object.values(ARMS.on.env).every((v) => v === "true")).toBe(true);
    });
});

describe("the change proxy", () => {
    it("passes everything through, and changes the one page only while the change is on, counting each change", async () => {
        const app = http.createServer((req, res) => {
            if (req.url === "/account") {
                res.writeHead(200, { "content-type": "text/html", "set-cookie": "s=1" });
                return res.end(`<form><label>Name <input name="name"></label><label>Default delivery address <textarea name="address" rows="3">1 Road</textarea></label><button>Save</button></form>`);
            }
            res.writeHead(303, { location: "/account" });
            res.end();
        });
        await new Promise<void>((r) => app.listen(PORT + 5, "127.0.0.1", () => r()));
        const proxy = new ChangeProxy(`http://127.0.0.1:${PORT + 5}`, PAGE_CHANGES["bench-shop"]);
        await proxy.start(PORT + 6);
        try {
            const before = await fetch(`${proxy.url}/account`);
            expect(before.headers.get("set-cookie")).toBe("s=1");
            expect(await before.text()).toContain("Default delivery address");
            proxy.changed = true;
            const after = await (await fetch(`${proxy.url}/account`)).text();
            expect(after).not.toContain("Default delivery address");
            expect(after).toContain('<input name="name">');
            expect(proxy.hits).toBe(1);
            const moved = await fetch(`${proxy.url}/elsewhere`, { redirect: "manual" });
            expect(moved.status).toBe(303);
            expect(moved.headers.get("location")).toBe("/account");
        } finally {
            await proxy.stop();
            await new Promise<void>((r) => app.close(() => r()));
        }
    });
});

describe("a scripted series", () => {
    it("runs both arms on bench-shop: a cold and a repeat run each, the page changed and reported, the measures and the report written", async () => {
        lines.length = 0;
        calls.length = 0;
        const out = path.join(tmp, "series");
        const code = await repeatMain(["--mode", "repeat", "--apps", "bench-shop", "--repeat", "1", "--port-base", String(PORT), "--out", out, "--data-dir", path.join(tmp, "data"), "--yes"], deps());
        expect(code, lines.join("\n")).toBe(0);
        const file = fs.readdirSync(out).find((f) => /-repeat\.json$/.test(f))!;
        const result = JSON.parse(fs.readFileSync(path.join(out, file), "utf8"));
        expect(result.trials).toHaveLength(2);
        // Alternation: trial 1 runs the on arm first.
        expect(result.trials.map((t: { arm: string }) => t.arm)).toEqual(["on", "off"]);
        for (const t of result.trials) {
            expect(t.status, t.error).toBe("completed");
            expect(t.cold.pages).toBeGreaterThan(1);
            expect(t.repeat.pages).toBeGreaterThan(1);
            expect(t.cold.aiCalls).toBeGreaterThan(0);
            expect(t.repeat.wallMs).toBeGreaterThan(0);
            // The account page lost its address field between the runs, and the repeat run's model shows it.
            expect(t.change).toEqual({ id: "account-address-removed", applied: true, seen: true });
        }
        // The on arm's repeat started from what the cold run learned; the off arm's explored as new.
        const on = result.trials.find((t: { arm: string }) => t.arm === "on");
        const off = result.trials.find((t: { arm: string }) => t.arm === "off");
        expect(on.repeat.reuseEvents).toBeGreaterThan(0);
        expect(off.repeat.reuseEvents).toBe(0);
        // The AI response cache: the on arm's repeat run asked the model less, answering the same questions from the cold run's answers;
        // the off arm's kept and used none. Nothing was lost for it.
        expect(on.repeat.cachedCalls).toBeGreaterThan(0);
        expect(off.cold.cachedCalls + off.repeat.cachedCalls).toBe(0);
        expect(on.repeat.aiCalls).toBeLessThan(off.repeat.aiCalls);
        expect(on.repeat.pages).toBeGreaterThanOrEqual(off.repeat.pages);
        expect(on.repeat.scenarios).toBeGreaterThanOrEqual(off.repeat.scenarios);
        expect(on.repeat.requirementsCovered).toBeGreaterThanOrEqual(off.repeat.requirementsCovered);
        // Each arm's model calls came from its own platform.
        expect(calls.filter((c) => c === "on").length).toBe(on.cold.aiCalls + on.repeat.aiCalls);
        expect(calls.filter((c) => c === "off").length).toBe(off.cold.aiCalls + off.repeat.aiCalls);
        // One trial per arm cannot be judged, and the report says so.
        expect(result.report.verdict).toBe("inconclusive");
        const md = fs.readFileSync(path.join(out, file.replace(/\.json$/, ".md")), "utf8");
        expect(md).toMatch(/Verdict: inconclusive/);
        expect(md).toMatch(/at least 5 each are needed/);
        expect(md).toMatch(/the account page no longer has the Default delivery address field/);
        expect(fs.existsSync(path.join(out, "trials", "bench-shop-on-1.json"))).toBe(true);
    }, 600_000);
});
