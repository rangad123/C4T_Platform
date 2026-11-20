/**
 * The clean-account replays through a real exploration (row 229, fix 1b): real discovery of a local shop that signs the project's test
 * account in and keeps each account's cart on its server (fixtures/account-shop.ts), planning and authoring in a real browser with a
 * scripted model double (never a real model), then keepAuthored's independence check:
 *   - a test whose expected $25.00 is the sum of what the account already held (alice keeps a Plate an earlier test left; the test adds
 *     only a Mug, as WEB-005): on the shared account both replays see $30.00 again. With the project's data changes off, no account is
 *     registered and the finding is `not_on_clean_state`, medium (it was `independent`, high, before row 229). With data changes on,
 *     each replay registers a new account through the sign-up page the exploration found, sees $10.00, and the finding is
 *     `state_dependent`;
 *   - a test that sets up its own cart (adds both items; the seeded defect shows on any account): as new accounts it is `independent`, high.
 * Fixture site: port 9923. Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/orchestrator-clean-replay.test.ts
 */
import { MockLanguageModelV3 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { CandidateFindingSchema } from "../src/engine/explore/finding.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import type { GenerationSink } from "../src/engine/orchestrator.js";
import type { AppKnowledge } from "../src/engine/planning/planner.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";
import { ALICE, startAccountShop, type AccountShop } from "./fixtures/account-shop.js";

const PORT = 9923;
let shop: AccountShop;
beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    shop = await startAccountShop(PORT);
}, 30_000);
afterAll(async () => {
    await shop?.close();
});

type Call = { tool: string; input: Record<string, unknown> };
const signIn: Call[] = [
    { tool: "navigate", input: { url: "/login" } },
    { tool: "fill", input: { target: { by: "label", value: "Email" }, value: "{{credentials.username}}" } },
    { tool: "fill", input: { target: { by: "label", value: "Password" }, value: "{{credentials.password}}" } },
    { tool: "click", input: { target: { by: "role", role: "button", value: "Sign in" } } },
];
const addItem = (item: string): Call => ({ tool: "click", input: { target: { by: "role", role: "link", value: `Add ${item}` } } });
const total: Call = { tool: "assert", input: { check: "exactText", target: { by: "role", role: "status", value: "Total" }, expected: "$25.00", source: "expected:2" } };
const finish: Call = { tool: "finish", input: { result: "defect", explanation: "The total shows $30.00, not $25.00" } };
let script: Call[] = [];

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
        const next = script[options.prompt.filter((m) => m.role === "assistant").length];
        if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
        return { content: [{ type: "tool-call" as const, toolCallId: `c${Math.random()}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
    },
});
const TIED = "The total is $25.00 (R-TOTAL)";
const PLAN = [ScenarioSchema.omit({ scenarioId: true }).parse({ title: "Cart total", description: "The cart adds up its lines", category: "Cart", priority: "high", journey: "Check the cart", startPath: "/login", requiresAuth: true, expectedResults: ["The cart is shown", TIED] })];
const scripted: LlmClient = {
    modelName: "scripted",
    model,
    usage: { inputTokens: 0, outputTokens: 0 },
    imageObject: async () => {
        throw new Error("no image calls in this test");
    },
    // The author's defect verdict: a real bug.
    text: (async () => "yes") as LlmClient["text"],
    object: (async ({ system, purpose }: { system: string; purpose?: string }) => {
        if (/analysing a web application/.test(system)) return { siteType: "ecommerce", purpose: "A small shop", features: ["Cart"], pagePurposes: [], journeys: [], authenticationMechanisms: ["form"] };
        if (purpose === "planning") return { scenarios: PLAN };
        throw new Error(`not scripted: ${purpose ?? system.slice(0, 40)}`);
    }) as LlmClient["object"],
};
const knowledge = (): AppKnowledge => ({
    modelVersionId: "mv-cart-1",
    rules: [{ ref: "R-TOTAL", kind: "calculation", description: "The total is the sum of the line prices", expected: "The total equals the sum of the lines", explicitness: "explicit", workflows: ["wf-cart"], status: "unverified" }],
    workflows: [{ id: "wf-cart", name: "Check the cart", preconditions: [], postconditions: [], sourceType: "requirement", steps: [{ order: 1, action: "Open the cart" }] }],
});

type Saved = { testId: string; validation: string; reason?: string; meta: Record<string, unknown> };
async function explore(steps: Call[], dataChanges: boolean) {
    script = steps;
    const { runGeneration } = await import("../src/engine/orchestrator.js");
    const events: Array<{ kind: string; message: string; data?: Record<string, unknown> }> = [];
    const tests: Saved[] = [];
    let n = 0;
    const sink: GenerationSink = {
        phase: async () => undefined,
        counters: async () => undefined,
        saveModel: async () => undefined,
        nextTestKey: async (prefix) => `${prefix}-${String(++n).padStart(3, "0")}`,
        createTest: async ({ spec, validation, reason, meta }) => {
            tests.push({ testId: spec.testId, validation, ...(reason ? { reason } : {}), meta: (meta ?? {}) as Record<string, unknown> });
            return { id: spec.testId, testId: spec.testId };
        },
        updateTest: async () => undefined,
        saveScript: async (h) => `script-${h.testId}`,
        recordExecution: async () => undefined,
        saveTextArtifact: async () => undefined,
        saveBaselines: async () => undefined,
        loadBaselines: async () => [],
        startAgentRun: async (_role, subject) => `run-${subject.split(" ")[0]}`,
        agentAction: () => undefined,
        finishAgentRun: async () => undefined,
    };
    await runGeneration(
        { config: loadConfig({ CONCURRENCY: "1" } as never), llm: scripted, emit: (e) => events.push({ kind: e.kind, message: e.message, ...(e.data ? { data: e.data } : {}) }) },
        {
            url: shop.url, targets: ["web"], maxPages: 8, maxDepth: 2, maxScenarios: 1, allowMutatingApiTests: dataChanges, useMemory: false, credentials: ALICE,
            functionalTests: true, accessibility: false, healthChecks: false, securityChecks: false, inputChecks: false, contractChecks: false, accessChecks: false, visionChecks: false,
            appKnowledge: knowledge(),
        } as never,
        sink,
    );
    const defects = tests.filter((t) => t.meta.finding);
    expect(defects, JSON.stringify({ tests, events: events.filter((e) => /defect|skipped|failed|leftover|depends|error/.test(e.kind)) }).slice(0, 4000)).toHaveLength(1);
    return { finding: CandidateFindingSchema.parse(defects[0]!.meta.finding), events };
}

describe("keepAuthored replays a defect test on clean account state", () => {
    it("data changes off: no account is registered, and the leftover-bound test is not checked on clean state (medium, not high)", async () => {
        shop.reset(["Plate"]);
        const { finding } = await explore([...signIn, addItem("Mug"), total, finish], false);
        expect(finding).toMatchObject({ capture: "captured", independence: "not_on_clean_state", confidence: "medium" });
        for (const r of finding.replays) expect(r.summary).toMatch(/on the shared test account \(the project does not allow tests that change data.*\), so not checked on clean state: stopped at step 7.*saw the same value as when captured \(\$30\.00\)/);
        expect(shop.registered).toEqual([]);
    }, 240_000);

    it("data changes on: each replay registers a new account, sees $10.00, and the test is state dependent", async () => {
        shop.reset(["Plate"]);
        const { finding } = await explore([...signIn, addItem("Mug"), total, finish], true);
        expect(finding).toMatchObject({ capture: "captured", independence: "state_dependent", confidence: "medium" });
        for (const r of finding.replays) expect(r.summary).toMatch(/as a newly registered account: stopped at step 7.*captured \$30\.00, replay saw \$10\.00/);
        expect(shop.registered).toHaveLength(2);
        // The replays signed in as the new accounts, never as the shared one.
        expect(shop.signIns.slice(-4).filter((e) => e === ALICE.username)).toEqual([]);
    }, 240_000);

    it("data changes on: a test that sets up its own cart is independent and high as new accounts", async () => {
        shop.reset(["Plate"]);
        const { finding } = await explore([...signIn, addItem("Mug"), addItem("Plate"), total, finish], true);
        expect(finding).toMatchObject({ capture: "captured", independence: "independent", confidence: "high" });
        for (const r of finding.replays) expect(r.summary).toMatch(/as a newly registered account: stopped at step 8.*same value as when captured \(\$30\.00\)/);
        expect(shop.registered).toHaveLength(2);
    }, 240_000);
});
