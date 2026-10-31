/**
 * Documentation-page scraping against a local site that documents its own
 * tests and APIs. The model is a double (MockLanguageModelV3) behind the real AI SDK structured-
 * output path (generateText + Output.object + zod parsing); it does NOT test extraction quality.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { generateText, Output } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { Browser } from "playwright";
import type { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import type { EngineContext, EngineEvent } from "../src/engine/context.js";
import { BrowserSession, launchChromium } from "../src/engine/discovery/browser.js";
import { documentedApiModels, looksLikeDocumentation, scrapeDocumentationPages } from "../src/engine/discovery/docs.js";
import { unavailableLlmClient, type LlmClient } from "../src/engine/llm/provider.js";

const PORT = 5095;
const BASE = `http://127.0.0.1:${PORT}`;
let app: ChildProcess;
let browser: Browser;

beforeAll(async () => {
    app = spawn(process.execPath, [path.join(REPO_ROOT, "examples/docs-app/server.mjs"), String(PORT)], { stdio: "ignore" });
    for (let i = 0; i < 40; i++) {
        try {
            if ((await fetch(BASE + "/")).ok) break;
        } catch {
            await new Promise((r) => setTimeout(r, 150));
        }
    }
    browser = await launchChromium(true);
}, 30_000);
afterAll(async () => {
    await browser?.close();
    app?.kill();
});

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

/** Model double answering per documentation page; records every prompt it receives. */
function docsModel() {
    const prompts: string[] = [];
    const model = new MockLanguageModelV3({
        doGenerate: async (options) => {
            const prompt = JSON.stringify(options.prompt);
            prompts.push(prompt);
            const body = prompt.includes("/test_cases")
                ? {
                      testCases: [
                          { id: "TC1", name: "Register User", steps: ["Launch browser", "Click 'Signup / Login'"], category: "Auth" },
                          { id: "TC2", name: "Login User with correct email and password" },
                          { id: "TC2", name: "Login User with correct email and password" }, // duplicate → dropped
                      ],
                      apis: [],
                  }
                : {
                      // testCases omitted: the schema default must fill it
                      apis: [
                          { name: "Get All Products List", method: "get", endpoint: `${BASE}/api/productsList`, expectedStatus: 200 },
                          { name: "Get Product By Id", method: "GET", endpoint: `${BASE}/api/products/{id}`, description: "One product" },
                          { name: "Search Product", method: "Request Method: POST", endpoint: "/api/searchProduct" },
                      ],
                  };
            return { content: [{ type: "text" as const, text: JSON.stringify(body) }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
        },
    });
    return { model, prompts };
}

/** LlmClient whose object() goes through the same generateText + Output.object path as the real provider. */
function llmFor(model: MockLanguageModelV3): LlmClient {
    return {
        modelName: "mock",
        model,
        usage: { inputTokens: 0, outputTokens: 0 },
        async object({ system, prompt, schema, maxOutputTokens }) {
            const res = await generateText({ model, system, prompt, maxOutputTokens, output: Output.object({ schema }) });
            return res.output as z.infer<typeof schema>;
        },
        text: async () => "",
    };
}

function ctxWith(llm: LlmClient) {
    const events: EngineEvent[] = [];
    const ctx: EngineContext = { config: loadConfig({}), llm, emit: (e) => events.push(e) };
    return { ctx, events };
}

async function withSession<T>(fn: (s: BrowserSession, navigations: string[]) => Promise<T>): Promise<T> {
    const session = await BrowserSession.launch(browser, { startUrl: BASE });
    const navigations: string[] = [];
    session.page.on("request", (r) => {
        if (r.isNavigationRequest()) navigations.push(new URL(r.url()).pathname);
    });
    try {
        return await fn(session, navigations);
    } finally {
        await session.close();
    }
}

const homeLinks = ["/", "/about", "/docs", "/test_cases", "/api_list"].map((p) => ({ href: BASE + p, text: p }));

describe("documentation scraping", () => {
    it("keyword gate: plain prose is not documentation, test/API docs are", () => {
        expect(looksLikeDocumentation("Create an account, browse products and check out in minutes.")).toBe(false);
        expect(looksLikeDocumentation("Test Case 1: Register User")).toBe(true);
        expect(looksLikeDocumentation("API 1: Get All Products List. Request Method: GET")).toBe(true);
    });

    it("finds doc pages, calls the LLM only for them, and maps the results", async () => {
        const { model, prompts } = docsModel();
        const { ctx, events } = ctxWith(llmFor(model));
        const { result, navigations } = await withSession(async (s, navigations) => ({ result: await scrapeDocumentationPages(s, ctx, BASE, homeLinks), navigations }));

        // /docs (linked, 200, ordinary copy) was fetched but never sent to the model
        expect(navigations).toEqual(["/docs", "/test_cases", "/api_list"]);
        expect(prompts).toHaveLength(2);
        expect(prompts.some((p) => p.includes(`${BASE}/docs`))).toBe(false);

        expect(result.testCases).toEqual([
            { id: "TC1", name: "Register User", description: undefined, steps: ["Launch browser", "Click 'Signup / Login'"], category: "Auth" },
            { id: "TC2", name: "Login User with correct email and password", description: undefined, steps: undefined, category: undefined },
        ]);
        expect(result.apis.map((a) => [a.method, a.endpoint, a.expectedStatus, a.foundOn])).toEqual([
            ["GET", `${BASE}/api/productsList`, 200, "/api_list"],
            ["GET", `${BASE}/api/products/{id}`, 200, "/api_list"],
            ["POST", "/api/searchProduct", 200, "/api_list"],
        ]);

        const found = events.filter((e) => e.kind === "documentation_found");
        expect(found.map((e) => e.message)).toEqual([
            "Documentation page /test_cases: 2 test cases, 0 API endpoints",
            "Documentation page /api_list: 0 test cases, 3 API endpoints",
        ]);
        expect(found.every((e) => e.stage === "discovery" && e.level !== "warn")).toBe(true);

        // → ApiEndpointModel entries the orchestrator can merge (templateKey-comparable paths)
        const models = documentedApiModels(result.apis, BASE);
        expect(models.map((m) => [m.method, m.path, m.origin, m.examplePath, m.source])).toEqual([
            ["GET", "/api/productsList", BASE, "/api/productsList", "documentation"],
            ["GET", "/api/products/{id}", BASE, undefined, "documentation"],
            ["POST", "/api/searchProduct", BASE, "/api/searchProduct", "documentation"],
        ]);
        expect(models[0]!.statuses).toEqual([200]);
        expect(models[1]!.summary).toBe("One product");
        expect(models[0]!.usedIn).toEqual(["/api_list"]);
    }, 60_000);

    it("is bounded: at most 6 URLs fetched and no LLM call when nothing looks like docs", async () => {
        const { model, prompts } = docsModel();
        const { ctx } = ctxWith(llmFor(model));
        // Ordinary or missing pages that all match doc path patterns; guessed paths come after them.
        const links = ["/docs", "/docs/a", "/docs/b", "/readme", "/swagger", "/api/v1", "/api/v2", "/documentation/x"].map((p) => ({ href: BASE + p }));
        const { result, navigations } = await withSession(async (s, navigations) => ({ result: await scrapeDocumentationPages(s, ctx, BASE, links), navigations }));
        expect(navigations).toEqual(["/docs", "/docs/a", "/docs/b", "/readme", "/swagger", "/api/v1"]);
        expect(prompts).toHaveLength(0);
        expect(result).toEqual({ testCases: [], apis: [] });
    }, 60_000);

    it("ignores cross-origin links", async () => {
        const { model, prompts } = docsModel();
        const { ctx } = ctxWith(llmFor(model));
        const links = [{ href: "http://localhost:1/test_cases" }, { href: "https://example.com/api_list" }];
        const { navigations } = await withSession(async (s, navigations) => {
            await scrapeDocumentationPages(s, ctx, BASE, links);
            return { navigations };
        });
        expect(navigations.every((p) => ["/test_cases", "/api_list"].includes(p))).toBe(true);
        expect(navigations).toHaveLength(2); // the guessed same-origin pages only
        expect(prompts).toHaveLength(2);
    }, 60_000);

    it("returns empty results without throwing when no LLM is configured", async () => {
        const { ctx, events } = ctxWith(unavailableLlmClient("No credentials for LLM provider"));
        const result = await withSession((s) => scrapeDocumentationPages(s, ctx, BASE, homeLinks));
        expect(result).toEqual({ testCases: [], apis: [] });
        const warn = events.find((e) => e.kind === "documentation_found");
        expect(warn?.level).toBe("warn");
        expect(warn?.message).toMatch(/not extracted: no LLM configured/);
    }, 60_000);
});
