/**
 * Task R, R2: planning keeps what a bad answer still has, and splits a call whose answer cannot be used (fast tier, scripted models).
 *  - one bad scenario of 20 keeps 19 and says 1 was dropped;
 *  - a model that fails every 20-idea call but answers 10-idea calls still gives a full plan.
 */
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext, EngineEvent } from "../src/engine/context.js";
import { llmClientFromModel, type LlmClient } from "../src/engine/llm/provider.js";
import { ResilientModel, type ModelV3 } from "../src/engine/llm/resilience.js";
import { planScenarios } from "../src/engine/planning/planner.js";
import type { AppModel, PageModel } from "../src/engine/understanding/app-model.js";

const page = (path: string): PageModel => ({
    url: `http://shop.test${path}`, path, title: path, type: "content", depth: 1, status: 200, headings: [], forms: [], components: [],
    links: [], aria: "", text: "", apiCalls: [], revealed: [], consoleErrors: [],
});
const model = (): AppModel => ({
    url: "http://shop.test", origin: "http://shop.test", siteType: "ecommerce", purpose: "Shop", features: ["catalogue"],
    pages: ["/", "/cart", "/products"].map(page), navigation: [], apis: [], journeys: [], externalDependencies: [], documentedTestCases: [],
    authentication: { required: false, mechanisms: [], loggedIn: false }, stats: { pagesVisited: 3, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
});
const idea = (title: string, extra: Record<string, unknown> = {}) => ({
    title, description: title, category: "Shop", type: "functional", priority: "high", startPath: "/", preconditions: [],
    expectedResults: [`"${title}" is shown`], requiresAuth: false, requiredData: [], requirements: [], ...extra,
});
const reply = (text: string) => ({
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: { inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } },
    warnings: [],
});
const fast = { baseDelayMs: 1, maxDelayMs: 2, attemptTimeoutMs: 2000, deadlineMs: 10_000, breakerFailures: 3, breakerCooldownMs: 60_000 };

/** A real client (provider.ts) over a scripted model that answers from the prompt's text. */
function scriptedClient(answer: (prompt: string) => string, prompts: string[]): LlmClient {
    const m = new MockLanguageModelV3({
        doGenerate: async (o) => {
            const p = JSON.stringify(o.prompt);
            prompts.push(p);
            return reply(answer(p));
        },
    });
    return llmClientFromModel(new ResilientModel([{ name: "m", provider: "x", breakerKey: "x", model: m as unknown as ModelV3 }], { policy: fast }), "m");
}
const quotaOf = (prompt: string) => Number(/Plan at most (\d+) scenarios/.exec(prompt)?.[1]);
const ctxWith = (llm: LlmClient, events: EngineEvent[]): EngineContext => ({ config: loadConfig({}), llm, emit: (e) => void events.push(e) });

describe("planning keeps the usable part of an answer", () => {
    it("one bad scenario of 20 keeps 19 and the warning says 1 was dropped", async () => {
        const prompts: string[] = [];
        const llm = scriptedClient(
            (p) => (p.includes("Not tested yet") ? JSON.stringify({ scenarios: [] }) : JSON.stringify({ scenarios: Array.from({ length: 20 }, (_, i) => idea(`Check thing ${i + 1}`, i === 4 ? { type: "smoke-ish" } : {})) })),
            prompts,
        );
        const events: EngineEvent[] = [];
        const warnings: string[] = [];
        const plan = await planScenarios(ctxWith(llm, events), model(), { maxScenarios: 20, hasCredentials: false, warnings });
        expect(plan).toHaveLength(19);
        expect(plan.map((s) => s.title)).not.toContain("Check thing 5");
        expect(warnings.join(" ")).toMatch(/1 test idea\(s\) were dropped/);
        expect(events.find((e) => e.kind === "planning_partial")?.data).toMatchObject({ dropped: 1 });
        // No re-ask was needed: the first answer's 19 good ideas were used.
        expect(prompts.filter((p) => !p.includes("Not tested yet"))).toHaveLength(1);
        expect(llm.usage.structured).toMatchObject({ partial: 1, itemsDropped: 1 });
    });

    it("a model that fails a 20-idea call but answers 10-idea calls gives a full plan", async () => {
        const prompts: string[] = [];
        let n = 0;
        const llm = scriptedClient((p) => {
            const q = quotaOf(p);
            // Too long for this model: not JSON at all, as MiniMax answered in S13.
            if (q > 10) return "The plan is long, here it comes: scenarios: 1. Log in...";
            if (p.includes("Not tested yet")) return JSON.stringify({ scenarios: [] });
            return JSON.stringify({ scenarios: Array.from({ length: q }, () => idea(`Idea number ${++n}`)) });
        }, prompts);
        const events: EngineEvent[] = [];
        const warnings: string[] = [];
        const plan = await planScenarios(ctxWith(llm, events), model(), { maxScenarios: 20, hasCredentials: false, warnings });
        expect(plan).toHaveLength(20);
        expect(new Set(plan.map((s) => s.title)).size).toBe(20);
        // 20 (asked, re-asked), then two halves of 10; the second half is told what the first planned.
        const quotas = prompts.filter((p) => !p.includes("Not tested yet")).map(quotaOf);
        expect(quotas).toEqual([20, 20, 10, 10]);
        expect(prompts[3]).toContain("Already planned in another part of this request");
        expect(prompts[3]).toContain("Idea number 1");
        expect(llm.usage.structured).toMatchObject({ split: 1 });
        expect(warnings).toEqual([]);
    });

    it("splits at most twice, then says the call failed", async () => {
        const prompts: string[] = [];
        const llm = scriptedClient(() => "never JSON", prompts);
        const err = await planScenarios(ctxWith(llm, []), model(), { maxScenarios: 20, hasCredentials: false }).catch((e) => e);
        expect(err).toMatchObject({ cls: "bad_output" });
        // 20 → 10 + 10 → each 10 → 5 + 5: 1 + 2 + 4 calls, each asked twice.
        expect(prompts.map(quotaOf)).toEqual([20, 20, 10, 10, 5, 5, 5, 5, 10, 10, 5, 5, 5, 5]);
    });
});
