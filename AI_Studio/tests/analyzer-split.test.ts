/**
 * Task R, R3: when the whole-application understanding answer is unusable even after the re-ask, it is asked in parts (pages per area,
 * then the journeys over those page paths), merged, and validated by the same linked schema (scripted model, no browser).
 */
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext, EngineEvent } from "../src/engine/context.js";
import { llmClientFromModel, type LlmClient } from "../src/engine/llm/provider.js";
import { ResilientModel, type ModelV3 } from "../src/engine/llm/resilience.js";
import { analyzeApplication } from "../src/engine/understanding/analyzer.js";
import { LinkedAnalysisSchema, type AppModel, type PageModel } from "../src/engine/understanding/app-model.js";

const page = (path: string): PageModel => ({
    url: `http://shop.test${path}`, path, title: path, type: "content", depth: 1, status: 200, headings: [], forms: [], components: [],
    links: [], aria: "", text: "", apiCalls: path === "/cart" ? ["POST /api/cart"] : [], revealed: [], consoleErrors: [],
});
// 20 pages: more than one planning area (15): /products and /help get a part each, "/" and "/cart" share one; then the journeys.
const paths = ["/", "/cart", ...Array.from({ length: 9 }, (_, i) => `/products/${i}`), ...Array.from({ length: 9 }, (_, i) => `/help/${i}`)];
const base = (): Omit<AppModel, "siteType" | "purpose" | "features" | "journeys"> => ({
    url: "http://shop.test", origin: "http://shop.test", pages: paths.map(page), navigation: [], apis: [], externalDependencies: [], documentedTestCases: [],
    authentication: { required: false, mechanisms: [], loggedIn: false }, stats: { pagesVisited: paths.length, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
});
const reply = (text: string) => ({
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: { inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } },
    warnings: [],
});
const fast = { baseDelayMs: 1, maxDelayMs: 2, attemptTimeoutMs: 2000, deadlineMs: 10_000, breakerFailures: 3, breakerCooldownMs: 60_000 };

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
const ctxWith = (llm: LlmClient, events: EngineEvent[]): EngineContext => ({ config: loadConfig({}), llm, emit: (e) => void events.push(e) });
const listed = (prompt: string) => [...prompt.matchAll(/### (\/[^ \\]*)/g)].map((m) => m[1]!);

/** Fails the whole-application call (not JSON); answers page parts with their own pages and the journeys call with `journeyPage`. */
const splitModel = (journeyPage: string) => (p: string) => {
    if (p.includes("Give the journeys only")) {
        return JSON.stringify({ journeys: [{ name: "Buy", description: "Add to cart", steps: [{ action: "Add", page: journeyPage, endpoint: "POST /api/cart" }], priority: "critical", pages: ["/", journeyPage], requiresAuth: false }] });
    }
    if (p.includes("Describe the application and these pages only")) {
        const own = listed(p);
        return JSON.stringify({ siteType: own.includes("/") ? "ecommerce" : "docs", purpose: own.includes("/") ? "A shop" : "Help", features: own.includes("/") ? ["cart"] : ["help", "cart"], pagePurposes: own.map((path) => ({ path, type: "content", purpose: `About ${path}` })), authenticationMechanisms: [] });
    }
    return "Sorry, the analysis is too long to give as JSON.";
};

describe("split understanding", () => {
    it("fails the single call, answers the parts, and gives a model that passes the linked schema", async () => {
        const prompts: string[] = [];
        const events: EngineEvent[] = [];
        const llm = scriptedClient(splitModel("/cart"), prompts);
        const out = await analyzeApplication(ctxWith(llm, events), base());
        // Asked whole twice (the re-ask), then 3 page parts and the journeys.
        expect(prompts.filter((p) => p.includes("Describe the application and these pages only"))).toHaveLength(3);
        expect(prompts.filter((p) => p.includes("Give the journeys only"))).toHaveLength(1);
        expect(prompts).toHaveLength(6);
        // Every page was described by exactly one part.
        expect(out.pages.every((p) => p.purpose === `About ${p.path}`)).toBe(true);
        expect(out.siteType).toBe("ecommerce");
        expect(out.features).toEqual(["help", "cart"]);
        expect(out.journeys).toMatchObject([{ name: "Buy", pages: ["/", "/cart"], stepLinks: [{ page: "/cart", endpoint: "POST /api/cart" }] }]);
        expect(events.some((e) => e.kind === "analysis_split")).toBe(true);
        expect(llm.usage.structured).toMatchObject({ split: 1 });
        // The merged answer passes the same schema the single call asks for.
        expect(LinkedAnalysisSchema.safeParse({ siteType: out.siteType, purpose: out.purpose, features: out.features, pagePurposes: out.pages.map((p) => ({ path: p.path, type: p.type, purpose: p.purpose })), journeys: out.journeys.map((j) => ({ ...j, steps: j.steps })), authenticationMechanisms: [] }).success).toBe(true);
    });

    it("refuses a part that names a page the crawl does not have, instead of dropping it", async () => {
        const llm = scriptedClient(splitModel("/checkout"), []);
        const err = await analyzeApplication(ctxWith(llm, []), base()).catch((e) => e);
        expect(err).toMatchObject({ cls: "bad_output" });
        expect(err.message).toContain("/checkout");
    });

    it("a journey listing a page the crawl does not have is refused even when its steps are fine", async () => {
        const llm = scriptedClient((p) => splitModel("/cart")(p).replace('"pages":["/","/cart"]', '"pages":["/","/cart","/basket"]'), []);
        const err = await analyzeApplication(ctxWith(llm, []), base()).catch((e) => e);
        expect(err.message).toContain("/basket");
    });

    it("a page part that describes another part's page is refused too", async () => {
        const llm = scriptedClient((p) => (p.includes("Describe the application and these pages only") ? splitModel("/cart")(p).replace('"path":"/help/0"', '"path":"/nowhere"') : splitModel("/cart")(p)), []);
        const err = await analyzeApplication(ctxWith(llm, []), base()).catch((e) => e);
        expect(err.message).toContain("/nowhere");
    });

    it("an error that is not a bad answer is not split", async () => {
        const prompts: string[] = [];
        const llm = scriptedClient(() => {
            throw new Error("boom");
        }, prompts);
        await expect(analyzeApplication(ctxWith(llm, []), base())).rejects.toThrow();
        expect(prompts.some((p) => p.includes("Describe the application and these pages only"))).toBe(false);
    });
});
