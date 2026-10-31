/**
 * Model routing without a browser or a platform (fast tier): the routing table, the routed client (by purpose, images, escalation of
 * unusable or failed fast answers, scopes that stay on the main model, scopes that do not leak into each other), the agent escalation
 * rules, the web agent's step-by-step model inside a real AI SDK tool loop, the phone explorer on an in-memory phone, usage per model
 * and escalations in a real usage store, the empty setting (exactly today's client), and that planning is one call for all scenarios.
 * Every model is a scripted double: nothing here calls a real model. The full platform with a browser is tests/model-routing.test.ts.
 */
import { generateText, hasToolCall, stepCountIs, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import type { EngineContext, EngineEvent } from "../src/engine/context.js";
import { LlmCallError } from "../src/engine/llm/errors.js";
import { JobMeter } from "../src/engine/llm/metered.js";
import { llmClientFromModel, LlmNotConfiguredError, type LlmClient } from "../src/engine/llm/provider.js";
import { resetBreakers, ResilientModel, type ModelV3 } from "../src/engine/llm/resilience.js";
import { healthLog } from "../src/engine/llm/health.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";
import {
    actionKey,
    actionsOfStep,
    chooseModel,
    combinedUsage,
    configuredFastModel,
    currentRoute,
    ESCALATION_LIMITS,
    noteAgentStep,
    ROUTE_TABLE,
    RouteScope,
    routedClient,
    setFastModelSource,
    withModelRouting,
    withRoute,
    type Escalation,
} from "../src/engine/llm/routing.js";
import { BudgetExceeded, ESCALATION_PURPOSE, groupRows, PURPOSES, totalsOf } from "../src/engine/llm/usage.js";
import { explore, ModelBudget } from "../src/engine/mobile/explore/explorer.js";
import { DEFAULT_LIMITS } from "../src/engine/mobile/explore/types.js";
import { planScenarios } from "../src/engine/planning/planner.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { Db } from "../src/platform/db.js";
import { routedLlmForJob } from "../src/platform/llm-routing.js";
import { UsageStore } from "../src/platform/usage-store.js";
import { MemoryDevice, shopApp, SHOP } from "./fixtures/memory-device.js";
import { scriptedPhoneModel, type Intent } from "./fixtures/phone-model.js";

// ── scripted doubles ─────────────────────────────────────────────────────────

const usage = (input: number, output: number) => ({ inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: output, text: output, reasoning: 0 } });
const textReply = (text: string, tokens = 10) => ({ content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: "stop" }, usage: usage(tokens, 2), warnings: [] });

/**
 * A real client (structured output with its one re-ask) around a scripted model that plays answers in order and logs each request. Behind a
 * resilient model with one attempt, as every production client is (so the old retry helper for bare models plays no part).
 */
function client(name: string, answers: Array<string | Error>, log: string[]): LlmClient {
    const m = new MockLanguageModelV3({
        provider: name,
        modelId: name,
        doGenerate: async () => {
            log.push(name);
            const a = answers.shift() ?? JSON.stringify({ answer: `${name} default` });
            if (a instanceof Error) throw a;
            return textReply(a);
        },
    });
    const chain = new ResilientModel([{ name, provider: name, breakerKey: `routing-test ${name}`, model: m as unknown as ModelV3 }], { policy: { attempts: 1, breakerFailures: 1000 } });
    return llmClientFromModel(chain, name);
}

const schema = z.object({ answer: z.string() });
const ask = (c: LlmClient, purpose?: Parameters<LlmClient["object"]>[0]["purpose"]) => c.object({ system: "s", prompt: "p", schema, ...(purpose ? { purpose } : {}) });
const ok = (answer: string) => JSON.stringify({ answer });

function routed(o: { fastAnswers?: Array<string | Error>; mainAnswers?: Array<string | Error>; fastImages?: boolean } = {}) {
    const log: string[] = [];
    const events: EngineEvent[] = [];
    const escalations: Escalation[] = [];
    const main = client("main-model", o.mainAnswers ?? [], log);
    const fast = client("fast-model", o.fastAnswers ?? [], log);
    const c = routedClient(main, { fast, fastImages: o.fastImages, onEscalation: (e) => escalations.push(e) });
    // Only the escalation events (the resilient models also tell which model answered).
    c.setEventSink!((e) => void (e.kind === "ai_model_escalated" && events.push(e)));
    return { c, main, fast, log, events, escalations };
}

afterEach(() => {
    resetBreakers();
    healthLog.clear();
});

// ── the table ────────────────────────────────────────────────────────────────

describe("the routing table", () => {
    it("routine work goes to the fast model, understanding, planning, repairs and images to the main one", () => {
        const pick = (task: Parameters<typeof chooseModel>[0]["task"], images = false, fastImages = false) => chooseModel({ task, images, escalated: false, fastImages });
        expect(pick("authoring")).toBe("fast");
        expect(pick("phone-explore")).toBe("fast");
        expect(pick("plain")).toBe("fast");
        for (const t of ["analysis", "planning", "repair", "vision", "other"] as const) expect(pick(t)).toBe("main");
        // Images: the main model, unless the fast one is marked as able to see them.
        expect(pick("authoring", true)).toBe("main");
        expect(pick("vision", true, true)).toBe("fast");
        // An escalated scope is on the main model whatever the task.
        expect(chooseModel({ task: "authoring", images: false, escalated: true, fastImages: true })).toBe("main");
        // Every purpose label has a row (nothing falls through by accident), and every row says what it covers.
        for (const p of PURPOSES) expect(ROUTE_TABLE[p]).toBeDefined();
        expect(Object.values(ROUTE_TABLE).every((r) => r.what.length > 10)).toBe(true);
    });
});

// ── the routed client ────────────────────────────────────────────────────────

describe("the routed client", () => {
    it("routes each call by its purpose; text calls too; images stay on the main model unless the fast one can see them", async () => {
        const r = routed();
        expect(r.c.modelName).toBe("main-model");
        expect(await ask(r.c, "planning")).toEqual({ answer: "main-model default" });
        expect(await ask(r.c, "analysis")).toEqual({ answer: "main-model default" });
        expect(await ask(r.c, "repair")).toEqual({ answer: "main-model default" });
        expect(await ask(r.c, "plain")).toEqual({ answer: "fast-model default" });
        expect(await ask(r.c)).toEqual({ answer: "main-model default" }); // unlabelled = other = main
        expect(await r.c.text({ system: "s", prompt: "p", purpose: "authoring" })).toContain("fast-model");
        const img = { system: "s", prompt: "p", images: [{ data: new Uint8Array(1), mediaType: "image/png" }], schema };
        expect(await r.c.imageObject!({ ...img, purpose: "authoring" })).toEqual({ answer: "main-model default" });
        expect(r.log).toEqual(["main-model", "main-model", "main-model", "fast-model", "main-model", "fast-model", "main-model"]);

        const seeing = routed({ fastImages: true });
        expect(await seeing.c.imageObject!(img)).toEqual({ answer: "fast-model default" });
        expect(r.events).toEqual([]);
    });

    it("keeps 'cannot look at images' exactly as the main client says", () => {
        const main = { ...client("m", [], []), imageObject: undefined } as LlmClient;
        expect(routedClient(main, { fast: client("f", [], []) }).imageObject).toBeUndefined();
    });

    it("an unusable answer after the existing re-ask is asked again, the same call, on the main model, and is counted", async () => {
        const r = routed({ fastAnswers: ["not json", "still not json"], mainAnswers: [ok("from main")] });
        expect(await ask(r.c, "plain")).toEqual({ answer: "from main" });
        // The fast model got its own repair re-ask first (two requests), then the main model one.
        expect(r.log).toEqual(["fast-model", "fast-model", "main-model"]);
        expect(r.escalations).toEqual([{ from: "fast-model", to: "main-model", reason: "gave no usable answer", task: "plain", retried: true }]);
        expect(r.events).toHaveLength(1);
        expect(r.events[0]).toMatchObject({ kind: "ai_model_escalated", level: "info", message: "The fast AI model fast-model gave no usable answer, so the main model main-model answered that call instead." });
        // Outside an agent scope each call is judged on its own: the next one goes to the fast model again.
        expect(await ask(r.c, "plain")).toEqual({ answer: "fast-model default" });
        // The tokens of every request are in the client's counters (the fast model's unusable answers included).
        expect(r.c.usage.inputTokens).toBe(40);
    });

    it("a fast model that is unavailable hands the call to the main model (and its fallbacks)", async () => {
        const r = routed({ fastAnswers: [new LlmCallError({ cls: "credit" }, { modelName: "fast-model" })] });
        expect(await ask(r.c, "plain")).toEqual({ answer: "main-model default" });
        expect(r.escalations[0]!.reason).toBe("was unavailable (out of credit)");
    });

    it("never escalates a reached AI limit or a missing model: no other model would change those", async () => {
        const hit = new BudgetExceeded({ cap: "job", used: 10, limit: 10, percent: 100 });
        const fast: LlmClient = { ...client("fast-model", [], []), object: async () => Promise.reject(hit) };
        const main = client("main-model", [], []);
        await expect(ask(routedClient(main, { fast }), "plain")).rejects.toBe(hit);
        const none = new LlmNotConfiguredError("no model");
        await expect(ask(routedClient(main, { fast: { ...fast, object: async () => Promise.reject(none) } }), "plain")).rejects.toBe(none);
    });

    it("inside a scope the rest of the scope stays on the main model after an escalation; another scope at the same time does not", async () => {
        const r = routed({ fastAnswers: ["bad", "bad"] });
        const a = withRoute({ task: "authoring", what: "Scenario S-001" }, async () => {
            const first = await ask(r.c, "authoring");
            await new Promise((res) => setTimeout(res, 20));
            const second = await ask(r.c, "authoring");
            return [first, second, currentRoute()!.escalated];
        });
        const b = withRoute({ task: "authoring", what: "Scenario S-002" }, async () => {
            await new Promise((res) => setTimeout(res, 10));
            return [await ask(r.c, "authoring"), currentRoute()!.escalated];
        });
        const [ra, rb] = await Promise.all([a, b]);
        expect(ra).toEqual([{ answer: "main-model default" }, { answer: "main-model default" }, true]);
        expect(rb).toEqual([{ answer: "fast-model default" }, false]);
        expect(r.events.map((e) => e.message)).toEqual(["Scenario S-001: the fast AI model fast-model gave no usable answer, so the main model main-model answered that step again and does the rest of it."]);
    });

    it("one usage object over both models: sums, the agent's own additions, and counters a model starts later", () => {
        const a = { inputTokens: 10, outputTokens: 1 };
        const b: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } = { inputTokens: 5, outputTokens: 2 };
        const u = combinedUsage([a, b]);
        expect(u.inputTokens).toBe(15);
        u.inputTokens += 100; // what the web agent does after each step
        expect(u.inputTokens).toBe(115);
        a.inputTokens += 1;
        expect(u.inputTokens).toBe(116);
        b.cacheReadTokens = 4;
        expect(u.cacheReadTokens).toBe(4);
        // A copy (the usage meter keeps one) has the later counter too, with the summed values.
        expect({ ...u }).toEqual({ inputTokens: 116, outputTokens: 3, cacheReadTokens: 4 });
    });
});

// ── the agent rules ──────────────────────────────────────────────────────────

describe("when an agent loop leaves the fast model", () => {
    const scope = () => {
        const s = new RouteScope("authoring", "Scenario S-009");
        const reasons: string[] = [];
        s.bind((_x, why) => reasons.push(why));
        return { s, reasons };
    };
    it("the same action failing twice", () => {
        const { s, reasons } = scope();
        s.observe([{ key: "click #a", ok: false }]);
        s.observe([{ key: "click #b", ok: true }]);
        expect(s.escalated).toBe(false);
        s.observe([{ key: "click #a", ok: false }]);
        expect(reasons).toEqual(["tried the same action twice and it failed both times"]);
    });
    it(`the same action ${ESCALATION_LIMITS.sameActionRepeats} times in a row, even when it works`, () => {
        const { s, reasons } = scope();
        for (let i = 0; i < ESCALATION_LIMITS.sameActionRepeats; i++) s.observe([{ key: "wait 500", ok: true }]);
        expect(reasons).toEqual([`repeated the same action ${ESCALATION_LIMITS.sameActionRepeats} times in a row`]);
    });
    it(`${ESCALATION_LIMITS.stepsWithoutProgress} steps without progress (different failures, answers without an action)`, () => {
        const { s, reasons } = scope();
        s.observe([{ key: "click #1", ok: false }]);
        s.observe([]);
        s.observe([{ key: "click #2", ok: false }]);
        expect(s.escalated).toBe(false);
        s.observe([{ key: "scroll", ok: true, progress: false }]);
        expect(reasons).toEqual([`made no progress for ${ESCALATION_LIMITS.stepsWithoutProgress} steps`]);
        // Once on the main model, it stays there and is told only once.
        s.observe([{ key: "click #1", ok: false }]);
        s.escalate("again");
        expect(reasons).toHaveLength(1);
    });
    it("progress resets the count; the free-text description does not make two actions different", () => {
        const { s } = scope();
        for (let i = 0; i < 10; i++) s.observe([{ key: `click #${i}`, ok: true }]);
        expect(s.escalated).toBe(false);
        expect(actionKey("click", { target: { by: "css", value: "#a" }, why: "first try" })).toBe(actionKey("click", JSON.stringify({ why: "again", target: { value: "#a", by: "css" } })));
    });
    it("reads failed actions out of an AI SDK step: a result with success false, and a tool error", () => {
        const acts = actionsOfStep({
            content: [
                { type: "tool-call", toolCallId: "1", toolName: "click", input: { target: "a" } },
                { type: "tool-result", toolCallId: "1", toolName: "click", output: { success: false, error: "not found" } },
                { type: "tool-call", toolCallId: "2", toolName: "assert", input: { check: "url" } },
                { type: "tool-result", toolCallId: "2", toolName: "assert", output: { success: true } },
                { type: "tool-error", toolCallId: "3", toolName: "fill", input: "{bad" },
                { type: "tool-call", toolCallId: "4", toolName: "seeWholePage", input: {} },
                { type: "tool-result", toolCallId: "4", toolName: "seeWholePage", output: { success: true } },
            ],
        });
        expect(acts.map((a) => [a.key.split(" ")[0], a.ok])).toEqual([
            ["click", false],
            ["assert", true],
            ["fill", false],
        ]);
    });
});

// ── the web agent's model inside a real tool loop ────────────────────────────

type Call = { tool: string; input: Record<string, unknown> } | Error;
const toolCall = (n: number, c: { tool: string; input: Record<string, unknown> }) => ({
    content: [{ type: "tool-call" as const, toolCallId: `c${n}`, toolName: c.tool, input: JSON.stringify(c.input) }],
    finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
    usage: usage(100, 10),
    warnings: [],
});
function agentModel(name: string, calls: Call[], log: string[]) {
    let n = 0;
    return new MockLanguageModelV3({
        provider: name,
        modelId: name,
        doGenerate: async () => {
            log.push(name);
            const c = calls.shift();
            if (c instanceof Error) throw c;
            return c ? toolCall(++n, c) : textReply("done");
        },
    });
}

async function agentRun(fastCalls: Call[], mainCalls: Call[], what = "Scenario S-001") {
    const log: string[] = [];
    const events: EngineEvent[] = [];
    const main = llmClientFromModel(agentModel("main-model", mainCalls, log), "main-model");
    const fast = llmClientFromModel(agentModel("fast-model", fastCalls, log), "fast-model");
    const c = routedClient(main, { fast });
    c.setEventSink!((e) => events.push(e));
    const done: string[] = [];
    const tools = {
        click: tool({
            inputSchema: z.object({ target: z.string(), why: z.string().optional() }),
            execute: async ({ target }) => (target === "missing" ? { success: false, error: "not found" } : (done.push(target), { success: true })),
        }),
        finish: tool({ inputSchema: z.object({ result: z.string() }), execute: async () => ({ done: true }) }),
        // The compact-snapshot builder's read-only look (author.ts): returns the whole page, changes nothing.
        seeWholePage: tool({ inputSchema: z.object({}), execute: async () => ({ success: true, snapshot: "- heading \"Shop\"" }) }),
    };
    await withRoute({ task: "authoring", what }, () =>
        generateText({
            model: c.model,
            prompt: "do the scenario",
            tools,
            stopWhen: [stepCountIs(12), hasToolCall("finish")],
            onStepFinish: (e) => noteAgentStep(e),
        }),
    );
    return { log, events, done };
}

describe("the web agent's model, step by step", () => {
    it("stays on the fast model while it works", async () => {
        const r = await agentRun([{ tool: "click", input: { target: "Products" } }, { tool: "finish", input: { result: "complete" } }], []);
        expect(r.log).toEqual(["fast-model", "fast-model"]);
        expect(r.done).toEqual(["Products"]);
        expect(r.events).toEqual([]);
    });

    it("looking at the whole page again is not an action: several looks in a row never hand the scenario over", async () => {
        const look = { tool: "seeWholePage", input: {} };
        const r = await agentRun([look, look, look, look, look, { tool: "click", input: { target: "Products" } }, look, look, { tool: "finish", input: { result: "complete" } }], []);
        expect(r.log.every((m) => m === "fast-model")).toBe(true);
        expect(r.log).toHaveLength(9);
        expect(r.done).toEqual(["Products"]);
        expect(r.events).toEqual([]);
    });

    it("the same failing action twice: the main model does the rest of the scenario", async () => {
        const r = await agentRun(
            [
                { tool: "click", input: { target: "missing", why: "open it" } },
                { tool: "click", input: { target: "missing", why: "try again" } },
                { tool: "click", input: { target: "never asked" } },
            ],
            [{ tool: "click", input: { target: "About" } }, { tool: "finish", input: { result: "complete" } }],
        );
        expect(r.log).toEqual(["fast-model", "fast-model", "main-model", "main-model"]);
        expect(r.done).toEqual(["About"]);
        expect(r.events.map((e) => e.message)).toEqual(["Scenario S-001: the fast AI model fast-model tried the same action twice and it failed both times, so the main model main-model does the rest of it."]);
    });

    it("a step the fast model cannot answer is answered again by the main model, which keeps the scenario", async () => {
        const r = await agentRun([new LlmCallError({ cls: "overloaded" }, { modelName: "fast-model" })], [{ tool: "click", input: { target: "Home" } }, { tool: "finish", input: { result: "complete" } }]);
        expect(r.log).toEqual(["fast-model", "main-model", "main-model"]);
        expect(r.events[0]!.message).toBe("Scenario S-001: the fast AI model fast-model was unavailable (overloaded), so the main model main-model answered that step again and does the rest of it.");
    });

    it("steps outside any scope (nothing to escalate with) use the main model", async () => {
        const log: string[] = [];
        const c = routedClient(llmClientFromModel(agentModel("main-model", [], log), "main-model"), { fast: llmClientFromModel(agentModel("fast-model", [], log), "fast-model") });
        await generateText({ model: c.model, prompt: "hi" });
        expect(log).toEqual(["main-model"]);
    });
});

// ── the phone explorer ───────────────────────────────────────────────────────

describe("the phone explorer", () => {
    const tour: Intent[] = [{ tap: "Products" }, { tap: "Product 1" }, { back: true }, { back: true }, { tap: "Cart" }, { finish: true }];
    const run = async (fastScript: Intent[], mainScript: Intent[]) => {
        const fast = scriptedPhoneModel(fastScript);
        const main = scriptedPhoneModel(mainScript);
        (fast as { modelName: string }).modelName = "fast-model";
        (main as { modelName: string }).modelName = "main-model";
        const events: EngineEvent[] = [];
        const ctx: EngineContext = { config: loadConfig({}), llm: routedClient(main, { fast }), emit: (e) => events.push(e) };
        ctx.llm.setEventSink!((e) => events.push(e));
        const model = await explore({ ctx, session: new MemoryDevice(shopApp()), appPackage: SHOP, credentialsGiven: false, allowDataChanges: false }, new ModelBudget(DEFAULT_LIMITS.maxModelCalls));
        return { model, fast, main, events };
    };
    const titles = (m: { screens: Array<{ title: string }> }) => m.screens.map((s) => s.title).sort();

    it("runs its turns on the fast model and finds what a main-model-only run finds", async () => {
        const a = await run(tour, []);
        expect(a.fast.turns.length).toBe(tour.length);
        expect(a.main.calls).toBe(0);
        expect(a.events.some((e) => e.kind === "ai_model_escalated")).toBe(false);
        const alone = scriptedPhoneModel(tour);
        const ctx: EngineContext = { config: loadConfig({}), llm: alone, emit: () => undefined };
        const b = await explore({ ctx, session: new MemoryDevice(shopApp()), appPackage: SHOP, credentialsGiven: false, allowDataChanges: false });
        expect(titles(a.model)).toEqual(titles(b));
        expect(a.model.edges.length).toBe(b.edges.length);
    });

    it("an unusable answer moves the rest of the exploration to the main model, which asks that turn again", async () => {
        const r = await run([{ garbage: { what: "nonsense" } }, { tap: "never used" }], tour);
        expect(r.fast.calls).toBe(1);
        expect(r.main.turns.length).toBe(tour.length);
        expect(titles(r.model)).toEqual(expect.arrayContaining(["Products", "Cart"]));
        const esc = r.events.filter((e) => e.kind === "ai_model_escalated");
        expect(esc.map((e) => e.message)).toEqual(["The phone exploration: the fast AI model fast-model gave no usable answer, so the main model main-model does the rest of it."]);
    });

    it("choosing an element that is not on the screen twice does the same", async () => {
        const r = await run([{ raw: { kind: "tap", index: 4999 } }, { raw: { kind: "tap", index: 4999 } }, { tap: "never used" }], tour);
        expect(r.fast.calls).toBe(2);
        expect(r.main.turns.length).toBeGreaterThan(0);
        expect(r.events.find((e) => e.kind === "ai_model_escalated")!.message).toContain("tried the same action twice and it failed both times");
    });
});

// ── usage per model and escalations, in a real usage store ───────────────────

describe("AI usage by model, with escalations counted", () => {
    afterEach(() => setFastModelSource(undefined));

    it("rows per model and purpose, one escalation row, totals that keep calls and escalations apart", async () => {
        const db = new Db(":memory:");
        const store = new UsageStore(db);
        const config = loadConfig({ LLM_PROVIDER: "anthropic", LLM_API_KEY: "k", LLM_MODEL: "main-model", LLM_MODEL_FAST: "fast-model" });
        const log: string[] = [];
        const job = { id: "job-1", projectId: "p1" };
        const c = routedLlmForJob({ db, config, emit: () => undefined }, job, client("main-model", [], log), { fast: client("fast-model", ["bad", "bad"], log) });
        const meter = new JobMeter({ backend: store, jobId: job.id, projectId: job.projectId });
        const llm = meter.wrap(c);
        await ask(llm, "planning");
        await ask(llm, "plain"); // escalated: fast twice, then main
        await ask(llm, "plain"); // fast
        meter.finish();
        const rows = store.jobRows(job.id);
        const row = (purpose: string, model: string) => rows.find((r) => r.purpose === purpose && r.model === model);
        expect(row("planning", "main-model")).toMatchObject({ calls: 1, inputTokens: 10 });
        expect(row("plain", "fast-model")).toMatchObject({ calls: 1, inputTokens: 10 });
        // The escalated call is recorded under the model that answered it in the end (with the fast model's unusable answers).
        expect(row("plain", "main-model")).toMatchObject({ calls: 1, inputTokens: 30 });
        expect(row(ESCALATION_PURPOSE, "main-model")).toMatchObject({ calls: 1, inputTokens: 0, outputTokens: 0 });
        const t = totalsOf(rows);
        expect(t).toMatchObject({ calls: 3, escalations: 1, inputTokens: 50 });
        expect(groupRows(rows, "purpose").map((g) => g.key).sort()).toEqual(["plain", "planning"]);
        expect(groupRows(rows, "model").find((g) => g.key === "main-model")).toMatchObject({ escalations: 1, calls: 2 });
        expect(store.jobTokens(job.id)).toBe(t.totalTokens);
        db.close();
    });
});

// ── the setting ──────────────────────────────────────────────────────────────

describe("the setting", () => {
    afterEach(() => setFastModelSource(undefined));
    const base = { LLM_PROVIDER: "anthropic", LLM_API_KEY: "k", LLM_MODEL: "main-model" };

    it("empty: the job gets the main client itself, exactly as before", () => {
        const main = client("main-model", [], []);
        expect(withModelRouting(loadConfig(base), main)).toEqual({ client: main });
        expect(withModelRouting(loadConfig({ ...base, LLM_MODEL_FAST: "   " }), main).client).toBe(main);
        // A double handed in changes nothing while the setting is empty.
        expect(withModelRouting(loadConfig(base), main, { fast: client("f", [], []) }).client).toBe(main);
        // The main model named as the fast one: nothing to route, nothing to say.
        expect(withModelRouting(loadConfig({ ...base, LLM_MODEL_FAST: "main-model" }), main)).toEqual({ client: main });
    });

    it("a fast model this server cannot use is said in words and the main model does everything", () => {
        const before = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
        delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
        try {
            const main = client("main-model", [], []);
            const r = withModelRouting(loadConfig({ ...base, LLM_MODEL_FAST: "google:gemini-2.5-flash-lite" }), main);
            expect(r.client).toBe(main);
            expect(r.note).toBe("The fast model gemini-2.5-flash-lite is not used: The server has no key for Google (set GOOGLE_GENERATIVE_AI_API_KEY). Every AI call uses the main model.");
        } finally {
            if (before !== undefined) process.env.GOOGLE_GENERATIVE_AI_API_KEY = before;
        }
    });

    it("a usable fast model on the main model's provider builds a routed client (no request is sent)", () => {
        const main = client("main-model", [], []);
        const r = withModelRouting(loadConfig({ ...base, LLM_MODEL_FAST: "claude-haiku-4-5" }), main);
        expect(r.client).not.toBe(main);
        expect(r.client.modelName).toBe("main-model");
        expect(r.note).toBeUndefined();
    });

    it("Settings wins over the environment; an empty value saved there switches routing off; images are a separate yes/no", () => {
        const cfg = loadConfig({ ...base, LLM_MODEL_FAST: "claude-haiku-4-5", LLM_MODEL_FAST_IMAGES: "true" });
        expect(configuredFastModel(cfg)).toMatchObject({ provider: "anthropic", model: "claude-haiku-4-5", images: true, source: "environment", ready: true, environment: "claude-haiku-4-5" });
        setFastModelSource(() => ({ model: "openai:gpt-5.4-mini", images: false }));
        expect(configuredFastModel(cfg)).toMatchObject({ provider: "openai", model: "gpt-5.4-mini", images: false, source: "app" });
        setFastModelSource(() => ({ model: "", images: false }));
        expect(configuredFastModel(cfg)).toMatchObject({ model: null, source: "app", ready: false });
        expect(withModelRouting(cfg, client("main-model", [], [])).note).toBeUndefined();
    });
});

// ── batching ─────────────────────────────────────────────────────────────────

describe("planning is one call for all scenarios", () => {
    it("asks the model once for the whole plan, however many scenarios it holds", async () => {
        let calls = 0;
        const scenarios = Array.from({ length: 6 }, (_, i) => ScenarioSchema.omit({ scenarioId: true }).parse({ title: `Scenario ${i}`, description: "d", category: "C", priority: "high", journey: "J", startPath: "/", expectedResults: ["x"] }));
        const llm: LlmClient = { modelName: "m", model: {} as never, usage: { inputTokens: 0, outputTokens: 0 }, text: async () => "", object: (async () => (calls++, { scenarios })) as LlmClient["object"] };
        const model = { url: "http://x", origin: "http://x", siteType: "shop", purpose: "p", features: [], pages: [], navigation: [], apis: [], journeys: [], authentication: { required: false, mechanisms: [], loggedIn: false }, externalDependencies: [], documentedTestCases: [], stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 0 } } as unknown as AppModel;
        const planned = await planScenarios({ config: loadConfig({}), llm, emit: () => undefined }, model, { maxScenarios: 10, hasCredentials: false });
        expect(planned).toHaveLength(6);
        expect(calls).toBe(1);
    });
});
