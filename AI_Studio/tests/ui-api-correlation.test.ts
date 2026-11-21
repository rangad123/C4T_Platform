/**
 * UI–API correlation while a test is written (Phase 4 C4), on the real bench shop (port 9495), with a scripted test writer (a model
 * double, never a real model). The writer only performs the scenario and checks what the page shows; the engine captures the page's own
 * API answers, reads back a successful write, and compares. Seeded, it turns the complete test into a defect test whose last step is the
 * check that shows it (and the saved script fails on the seeded shop, passes on the clean one); clean, from a dirty start, it changes
 * nothing. Expected behaviour comes from bench-shop's requirements: 7.3 (saved details are kept), 6.3 (the Orders page lists every
 * order), 7.4 (an over-long address is refused, and the page shows that message instead of "Saved.").
 */
import { MockLanguageModelV3 } from "ai/test";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import { launchChromium } from "../src/engine/discovery/browser.js";
import { renderScript } from "../src/engine/generators/index.js";
import { ScenarioSchema, TestSpecSchema, type Step } from "../src/engine/spec/schema.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { runScripts } from "../src/engine/validation/runner.js";
import { authorWebSpec, toSpec, type ActionGate, type AuthorOutcome } from "../src/engine/web/author.js";
import { startBenchApp, type RunningBenchApp } from "../src/eval/bench/verify/app.js";

const PORT = 9495;
const alice = { username: "alice@example.test", password: "Password1!" };
let app: RunningBenchApp | undefined;
let browser: Browser;
async function shop(defects: string): Promise<string> {
    await app?.stop();
    app = await startBenchApp("bench-shop", PORT, defects);
    return app.base;
}
beforeAll(async () => {
    browser = await launchChromium(true);
}, 60_000);
afterAll(async () => {
    await browser?.close();
    await app?.stop();
});

type Call = { tool: string; input: Record<string, unknown> };
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
function scripted(calls: Call[]) {
    let i = 0;
    return new MockLanguageModelV3({
        doGenerate: async () => {
            const next = calls[i++];
            if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
            return { content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
        },
    });
}
const ctxFor = (model: MockLanguageModelV3): EngineContext => ({
    config: loadConfig({}),
    emit: () => undefined,
    // A verdict review would say "no": a layer disagreement is judged by code, so it never asks.
    llm: { modelName: "scripted", model, usage: { inputTokens: 0, outputTokens: 0 }, object: async () => ({}) as never, text: async () => "VERDICT: NO" },
});
const model = (base: string): AppModel => ({
    url: base, origin: base, siteType: "ecommerce", purpose: "shop", features: [], pages: [], navigation: [], journeys: [],
    // The documented reads (bench-shop's OpenAPI document).
    apis: ["/api/profile", "/api/orders", "/api/orders/{id}", "/api/cart"].map((path) => ({ method: "GET", path, origin: base, statuses: [200], queryParams: [], source: "openapi" as const, usedIn: [] })),
    authentication: { required: true, mechanisms: [], loggedIn: false }, externalDependencies: [], documentedTestCases: [],
    stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 4, durationMs: 0 },
});

const role = (r: string, value: string) => ({ by: "role", role: r, value });
const label = (value: string) => ({ by: "label", value });
const signIn: Call[] = [
    { tool: "fill", input: { target: label("Email"), value: "{{credentials.username}}" } },
    { tool: "fill", input: { target: label("Password"), value: "{{credentials.password}}" } },
    { tool: "click", input: { target: role("button", "Sign in") } },
    { tool: "wait", input: { until: "visible", target: role("button", "Sign out") } },
];
const finish: Call = { tool: "finish", input: { result: "complete", explanation: "done" } };

interface Case {
    seed: string;
    req: string;
    expected: string;
    calls: () => Call[];
    /** The saved defect test's last step. */
    last: Partial<Step> & Record<string, unknown>;
    layers: string[];
}
const cases: Case[] = [
    {
        seed: "BS-06",
        req: "7.3",
        expected: "The saved address is the account's from then on (requirement 7.3)",
        calls: () => [
            ...signIn,
            { tool: "navigate", input: { url: "/account" } },
            { tool: "fill", input: { target: label("Default delivery address"), value: `${Date.now()} Quay Road, Hull` } },
            { tool: "click", input: { target: role("button", "Save") } },
            { tool: "assert", input: { check: "visible", expected: "Saved.", source: "expected:1" } },
            finish,
        ],
        last: { action: "assertResponse", check: "relation", expression: "name == $sent_name and address == $sent_address", source: "expected:1" },
        layers: ["api", "stored data"],
    },
    {
        seed: "BS-12",
        req: "6.3",
        expected: "The new order is listed on the Orders page (requirement 6.3)",
        calls: () => [
            ...signIn,
            { tool: "navigate", input: { url: "/products/p3" } },
            { tool: "click", input: { target: role("button", "Add to cart") } },
            { tool: "wait", input: { until: "url", value: "/cart" } },
            { tool: "navigate", input: { url: "/checkout" } },
            { tool: "click", input: { target: role("button", "Continue") } },
            { tool: "wait", input: { until: "url", value: "/checkout/review" } },
            { tool: "click", input: { target: role("button", "Place order") } },
            { tool: "wait", input: { until: "url", value: "/orders/ord-" } },
            { tool: "assert", input: { check: "text", target: { by: "testId", value: "status" }, expected: "Placed", source: "expected:1" } },
            finish,
        ],
        last: { action: "assertResponse", check: "relation", expression: "contains(orders[*].id, $created_id)", source: "expected:1" },
        layers: ["api", "stored data"],
    },
    {
        seed: "BS-16",
        req: "7.4",
        expected: "An address over 200 characters is refused, and the page does not say it was saved (requirement 7.4)",
        calls: () => [
            ...signIn,
            { tool: "navigate", input: { url: "/account" } },
            { tool: "fill", input: { target: label("Default delivery address"), value: "x".repeat(201) } },
            { tool: "click", input: { target: role("button", "Save") } },
            { tool: "assert", input: { check: "visible", target: role("heading", "Your account"), source: "expected:1" } },
            finish,
        ],
        last: { action: "assert", check: "hidden", locator: { by: "text", value: "Saved.", exact: true }, source: "expected:1" },
        layers: ["page", "api"],
    },
];

const scenarioOf = (c: Case) =>
    ScenarioSchema.parse({ scenarioId: `S-${c.seed}`, title: `Correlation ${c.seed}`, description: "Customer flow", category: "Account", startPath: "/login", expectedResults: [c.expected], requirements: [c.req] });
async function author(c: Case, base: string, more: { allowPurchases?: boolean; gate?: ActionGate } = {}): Promise<AuthorOutcome> {
    return authorWebSpec({ ctx: ctxFor(scripted(c.calls())), browser, baseUrl: base, model: model(base), scenario: scenarioOf(c), credentials: alice, requirementIds: [c.req], allowPurchases: more.allowPurchases ?? true, ...(more.gate ? { gate: more.gate } : {}) });
}
/** The saved test rendered as the platform runs it: "passed" or "failed". */
async function script(outcome: AuthorOutcome, c: Case, base: string): Promise<{ status: string; error?: string }> {
    const spec = TestSpecSchema.parse(toSpec(scenarioOf(c), outcome, "WEB-001"));
    const r = renderScript(spec, "playwright", { baseUrl: base });
    const [res] = await runScripts(loadConfig({}).scratchDir, [{ testId: spec.testId, filename: r.filename, content: r.content }], { baseUrl: base, headless: true, credentials: alice }, { workers: 1 });
    return res!;
}

describe("seeded: the layers disagree, and the saved test shows it", () => {
    for (const c of cases) {
        it(`${c.seed}: a defect test captured at the correlation check; its script fails seeded and passes clean`, async () => {
            const seeded = await shop(c.seed);
            const out = await author(c, seeded);
            expect(out.status, out.explanation).toBe("defect");
            if (out.status !== "defect") return;
            expect(out.capture).toBe("captured");
            expect(out.capturedCheck?.source).toBe("expected:1");
            expect(out.steps.at(-1)).toEqual(expect.objectContaining(c.last));
            expect(out.layers?.map((l) => l.layer)).toEqual(c.layers);
            expect(out.evidence?.some((l) => /^(PUT|POST) \/api\/\S+ answered \d{3}$/.test(l))).toBe(true);
            expect((await script(out, c, seeded)).status).toBe("failed");
            const r = await script(out, c, await shop("none"));
            expect(r.status, r.error).toBe("passed");
        }, 240_000);
    }
});

describe("clean, from a dirty start: nothing changes", () => {
    it("every scenario twice on one clean shop (the second run starts from what the first left) is a complete test with its own steps", async () => {
        const base = await shop("none");
        for (const round of [1, 2])
            for (const c of cases) {
                const out = await author(c, base);
                expect(out.status, `${c.seed} round ${round}: ${out.explanation}`).toBe("complete");
                // The written test, unchanged: its last step is the writer's own check, and the answers it caused are kept.
                expect(out.steps.at(-1)).toEqual(expect.objectContaining({ action: "assert", source: "expected:1" }));
                expect(out.status !== "blocked" && out.calls?.some((k) => k.method !== "GET" && k.step !== undefined)).toBe(true);
            }
    }, 480_000);
});

describe("bounds", () => {
    it("data changes off: no read-back is sent, so BS-06 stays a complete test", async () => {
        const out = await author(cases[0]!, await shop("BS-06"), { allowPurchases: false });
        expect(out.status, out.explanation).toBe("complete");
        if (out.status !== "complete") return;
        expect(out.calls?.some((k) => k.method === "PUT")).toBe(true);
        expect(out.calls?.some((k) => k.readBack)).toBe(false);
    }, 240_000);
    it("the read-back is asked of the exploration's bound first; refused, it is not sent", async () => {
        const asked: string[] = [];
        const gate: ActionGate = {
            before: () => ({ allowed: true }),
            after: () => undefined,
            freshPass: () => undefined,
            replay: (_n, what) => {
                asked.push(what);
                return !/read-back/.test(what);
            },
        };
        const out = await author(cases[0]!, await shop("BS-06"), { gate });
        expect(asked).toContain("a read-back of GET /api/profile");
        expect(out.status, out.explanation).toBe("complete");
        expect(out.status !== "blocked" && out.calls?.some((k) => k.readBack)).toBe(false);
    }, 240_000);
    it("masked echoes: an answer that echoes the password (BS-20) is kept with it masked, and nothing the writer returns holds it", async () => {
        const out = await author(cases[0]!, await shop("BS-06,BS-20"));
        expect(out.status).toBe("defect");
        if (out.status === "blocked") return;
        const back = out.calls?.find((k) => k.readBack);
        expect(back?.body).toMatch(/password/);
        expect(JSON.stringify(out)).not.toContain(alice.password);
        expect(JSON.stringify(out)).not.toContain(alice.username);
    }, 240_000);
});
