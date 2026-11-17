/**
 * A defect test carries its candidate finding (testing-engine Phase 3, P3-12), through real jobs: HTTP API -> queue -> worker -> real
 * discovery of a local site -> planning and authoring in a real browser with a scripted model double (never a real model):
 *   - a defect captured by a failing check of the scenario's expected result that cites a stated rule: the independence check replays it twice in fresh browsers
 *     (both fail at that check: independent), the test's meta.finding parses as a CandidateFinding with confidence high, meta.capture is
 *     "captured", the NEEDS_REVIEW reason names the source, and the possible_defect event carries capture and confidence;
 *   - a defect captured by a failing check of a rule: the expected text is the rule's, the finding names the model version; an
 *     objective the planner's model wrote into its reply is dropped (only the objective stage sets one: the finding of an objective
 *     scenario names it in explore-objectives-run and stated-source-unit), so the finding has none;
 *   - a defect the replays do not show again (the page is wrong on its first visit only): state dependent, confidence medium;
 *   - a defect claimed without a failing sourced check: still saved NEEDS_REVIEW, observed only, confidence low, no replays;
 *   - a defect whose failing check is of the planner's own expected result (tied to nothing stated, queue row 172): the same, observed only;
 *   - every AI call of each job is counted: the independence check and the finding add none.
 * Fixture site: port 9764. Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/orchestrator-capture.test.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { CandidateFindingSchema, findingFingerprint } from "../src/engine/explore/finding.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";
import { AppIntelStore } from "../src/platform/app-intel-store.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const PORT = 9764;
const URL = `http://127.0.0.1:${PORT}`;

let site: http.Server;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dir: string;
/** Visits of /once since the case began: its total is wrong on the first visit only. */
let onceVisits = 0;

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main>${body}</main></body></html>`;
const cart = (total: string) => page("Cart", `<h1>Cart</h1><ul><li>Mug $10.00</li><li>Plate $15.00</li></ul><p>Total: <output aria-label="Total">${total}</output></p>`);

/** Every AI call, in order: "object:<purpose>", "text:<purpose>" or "agent". */
const calls: string[] = [];
const toolQueue: Array<{ tool: string; input: Record<string, unknown> }> = [];
/** What the planner answers and the test writer does in the current case. */
let plan: Record<string, unknown> = {};
let script: Array<{ tool: string; input: Record<string, unknown> }> = [];

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const model = new MockLanguageModelV3({
    doGenerate: async () => {
        calls.push("agent");
        const next = toolQueue.shift();
        if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
        return { content: [{ type: "tool-call" as const, toolCallId: `c${Math.random()}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
    },
});
const scripted: LlmClient = {
    modelName: "scripted",
    model,
    usage: { inputTokens: 0, outputTokens: 0 },
    imageObject: async () => {
        throw new Error("no image calls in this test");
    },
    // The author's defect verdict: a real bug.
    text: (async ({ purpose }: { purpose?: string }) => {
        calls.push(`text:${purpose ?? "?"}`);
        return "yes";
    }) as LlmClient["text"],
    object: (async ({ system, purpose }: { system: string; purpose?: string }) => {
        calls.push(`object:${purpose ?? "?"}`);
        if (/analysing a web application/.test(system)) {
            return {
                siteType: "ecommerce", purpose: "A small shop", features: ["Cart"], pagePurposes: [],
                journeys: [{ name: "Check the cart", description: "Look at the cart", steps: ["Open the cart"], priority: "high", pages: ["/"], requiresAuth: false }],
                authenticationMechanisms: [],
            };
        }
        if (purpose === "planning") {
            toolQueue.push(...script);
            return { scenarios: [ScenarioSchema.omit({ scenarioId: true }).parse(plan)] };
        }
        throw new Error(`not scripted: ${purpose ?? system.slice(0, 40)}`);
    }) as LlmClient["object"],
};

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        if (req.url === "/cart") return void res.end(cart("$30.00"));
        if (req.url === "/once") return void res.end(cart(++onceVisits === 1 ? "$30.00" : "$25.00"));
        res.end(page("Shop", "<h1>Shop</h1><p>Welcome to the shop.</p>"));
    });
    await new Promise<void>((r) => site.listen(PORT, "127.0.0.1", r));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-orchestrator-capture-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", CONCURRENCY: "1" }));
    server = await buildServer(platform);
    worker = new Worker({ ...platform, makeLlm: () => scripted }, 100);
    worker.start();
}, 60_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    site?.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body.startsWith("{") || res.body.startsWith("[") ? JSON.parse(res.body) : res.body };
};

type Event = { kind: string; message: string; data: Record<string, unknown> | null };
async function explore(projectId: string) {
    calls.length = toolQueue.length = 0;
    onceVisits = 0;
    const queued = await call("POST", `/api/projects/${projectId}/test-generation`, {
        url: URL, targets: ["web"], maxPages: 5, accessibility: false, healthChecks: false, securityChecks: false, inputChecks: false, contractChecks: false, accessChecks: false,
    });
    expect(queued.status, JSON.stringify(queued.body)).toBe(202);
    let job: { status: string } | undefined;
    for (let i = 0; i < 600; i++) {
        job = (await call("GET", `/api/test-generation/${queued.body.jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job!.status)) break;
        await new Promise((r) => setTimeout(r, 400));
    }
    const tests = platform.repo.listTests(projectId).filter((t) => (t.generationMeta as { scenario?: unknown } | null)?.scenario);
    expect(tests, `job ${job!.status}`).toHaveLength(1);
    const events = platform.repo.listEvents(queued.body.jobId) as Event[];
    // Every AI call of the job, counted: understanding, planning, the three scripted agent turns, the author's defect verdicts and the
    // analysis after the exploration. The independence check and the finding add none.
    expect(calls).toEqual(["object:analysis", "object:planning", "agent", "agent", "agent", "text:review", "text:review", "text:review", "object:analysis"]);
    return { status: job!.status, test: tests[0]!, events };
}

const heading = { tool: "assert", input: { check: "visible", target: { by: "role", role: "heading", value: "Cart" }, source: "expected:1" } };
const total = (source?: string) => ({ tool: "assert", input: { check: "exactText", target: { by: "role", role: "status", value: "Total" }, expected: "$25.00", ...(source ? { source } : {}) } });
const finishDefect = { tool: "finish", input: { result: "defect", explanation: "The total shows $30.00, not $25.00" } };
const cartScenario = (startPath: string) => ({ title: "Cart total", description: "The cart adds up its lines", category: "Cart", priority: "high", journey: "Check the cart", startPath, expectedResults: ["The cart page is shown", "The total is $25.00"] });

/** The stated rule R-TOTAL of the workflow the cart scenario's journey names, so authoring is given it; returns the model version. */
async function statedRule(projectId: string): Promise<string> {
    const intel = new AppIntelStore(platform.db.sql);
    const version = await intel.addVersion({ projectId, model: { workflows: [{ id: "wf-cart", name: "Check the cart", steps: [{ order: 1, action: "Open the cart" }], sourceType: "requirement" }] } });
    await intel.addRule(projectId, {
        ref: "R-TOTAL", kind: "constraint", description: "The total is the sum of the line prices", expected: "The total equals the sum of the lines", sourceType: "requirement", sourceRef: "req.md#total", explicitness: "explicit", confidence: 0.9, workflows: ["wf-cart"],
    }, { modelVersionId: version.id });
    return version.id;
}
/** The cart scenario with its second expected result tied to the stated rule R-TOTAL. */
const TIED = "The total is $25.00 (source: R-TOTAL)";
const tiedScenario = (startPath: string) => ({ ...cartScenario(startPath), expectedResults: ["The cart page is shown", TIED] });

const metaOf = (t: { generationMeta: unknown }) => t.generationMeta as Record<string, unknown>;
const defectEvent = (events: Event[]) => {
    const found = events.filter((e) => e.kind === "possible_defect");
    expect(found).toHaveLength(1);
    return found[0]!;
};

describe("a defect test carries its candidate finding", () => {
    it("captured by a failing expected-result check that both replays show: independent, confidence high, the source named", async () => {
        const projectId = (await call("POST", "/api/projects", { name: "Captured" })).body.id as string;
        const version = await statedRule(projectId);
        plan = tiedScenario("/cart");
        script = [heading, total("expected:2"), finishDefect];
        const { test, events } = await explore(projectId);

        expect(test.validationStatus).toBe("NEEDS_REVIEW");
        const meta = metaOf(test);
        expect(meta.capture).toBe("captured");
        expect(meta.capturedCheck).toMatchObject({ source: "expected:2", observed: expect.stringContaining("$30.00") });
        const finding = CandidateFindingSchema.parse(meta.finding);
        expect(finding).toMatchObject({
            objective: null,
            actions: { stepCount: test.spec.steps.length },
            expected: { text: TIED, source: "expected:2" },
            observed: "The total shows $30.00, not $25.00",
            capture: "captured",
            independence: "independent",
            confidence: "high",
            modelVersion: version,
        });
        expect(finding.fingerprint).toBe(findingFingerprint({ source: "expected:2", expected: TIED, scenario: "Cart total" }));
        expect(finding.replays).toHaveLength(2);
        for (const r of finding.replays) expect(r).toMatchObject({ outcome: "failed", failedStep: test.spec.steps.length });
        expect(finding).not.toHaveProperty("testId");

        expect(test.validationReason).toMatch(/^The application did not behave as expected: /);
        expect(test.validationReason).toContain(`expected result 2 (${TIED})`);
        expect(test.validationReason).toContain("confidence high");
        const e = defectEvent(events);
        expect(e.data).toMatchObject({ capture: "captured", confidence: "high", independence: "independent", source: "expected:2" });
    }, 300_000);

    it("captured by a failing rule check: the rule's expected text and the model version; an objective the planner's model wrote is dropped", async () => {
        const projectId = (await call("POST", "/api/projects", { name: "Rule" })).body.id as string;
        const intel = new AppIntelStore(platform.db.sql);
        const version = await intel.addVersion({ projectId, model: { workflows: [{ id: "wf-cart", name: "Check the cart", steps: [{ order: 1, action: "Open the cart" }], sourceType: "requirement" }] } });
        await intel.addRule(projectId, {
            ref: "R-TOTAL", kind: "constraint", description: "The total is the sum of the line prices", expected: "The total equals the sum of the lines", sourceType: "requirement", sourceRef: "req.md#total", explicitness: "explicit", confidence: 0.9, workflows: ["wf-cart"],
        }, { modelVersionId: version.id });
        // The planner's model writes an objective of its own: the planner drops it, so it never reaches the test or its finding.
        plan = { ...cartScenario("/cart"), objective: { id: "obj-total", kind: "rule", source: "R-TOTAL" } };
        script = [heading, total("R-TOTAL"), finishDefect];
        const { test, events } = await explore(projectId);

        const finding = CandidateFindingSchema.parse(metaOf(test).finding);
        expect((metaOf(test).scenario as Record<string, unknown>).objective).toBeUndefined();
        expect(finding).toMatchObject({
            objective: null,
            expected: { text: "The total equals the sum of the lines", source: "R-TOTAL" },
            capture: "captured",
            independence: "independent",
            confidence: "high",
            modelVersion: version.id,
        });
        expect(finding.fingerprint).toBe(findingFingerprint({ source: "R-TOTAL", expected: "The total equals the sum of the lines", scenario: "Cart total" }));
        expect(test.validationReason).toContain("rule R-TOTAL");
        expect(defectEvent(events).data).toMatchObject({ capture: "captured", confidence: "high", source: "R-TOTAL" });
    }, 300_000);

    it("a defect the fresh replays do not show again: state dependent, confidence medium", async () => {
        const projectId = (await call("POST", "/api/projects", { name: "Once" })).body.id as string;
        await statedRule(projectId);
        plan = tiedScenario("/once");
        script = [heading, total("expected:2"), finishDefect];
        const { test, events } = await explore(projectId);

        const finding = CandidateFindingSchema.parse(metaOf(test).finding);
        expect(finding).toMatchObject({ capture: "captured", independence: "state_dependent", confidence: "medium" });
        expect(finding.replays.map((r) => r.outcome)).toEqual(["passed", "passed"]);
        expect(test.validationReason).toContain("confidence medium");
        expect(defectEvent(events).data).toMatchObject({ capture: "captured", confidence: "medium", independence: "state_dependent" });
    }, 300_000);

    it("a defect without a failing sourced check: saved for review, observed only, confidence low, no replays", async () => {
        const projectId = (await call("POST", "/api/projects", { name: "Observed" })).body.id as string;
        plan = cartScenario("/cart");
        script = [heading, total(), finishDefect];
        const { test, events } = await explore(projectId);

        expect(test.validationStatus).toBe("NEEDS_REVIEW");
        const meta = metaOf(test);
        expect(meta.capture).toBe("observed_only");
        expect(meta).not.toHaveProperty("capturedCheck");
        const finding = CandidateFindingSchema.parse(meta.finding);
        expect(finding).toMatchObject({ expected: { source: null }, capture: "observed_only", independence: "not_run", confidence: "low", replays: [] });
        expect(test.validationReason).toMatch(/^The application did not behave as expected: /);
        expect(test.validationReason).toContain("observed only");
        expect(test.validationReason).toContain("confidence low");
        expect(defectEvent(events).data).toMatchObject({ capture: "observed_only", confidence: "low", independence: "not_run", source: null });
    }, 300_000);

    it("a failing check of the planner's own expected result: saved for review, observed only, confidence low, no replays", async () => {
        const projectId = (await call("POST", "/api/projects", { name: "Planner" })).body.id as string;
        await statedRule(projectId);
        plan = cartScenario("/cart");
        script = [heading, total("expected:2"), finishDefect];
        const { test, events } = await explore(projectId);

        expect(test.validationStatus).toBe("NEEDS_REVIEW");
        const meta = metaOf(test);
        expect(meta.capture).toBe("observed_only");
        expect(meta).not.toHaveProperty("capturedCheck");
        // The failing check is not the saved test's last step: the test is what ran, and it passes on this app.
        expect(test.spec.steps.at(-1)).toMatchObject({ check: "visible", source: "expected:1" });
        const finding = CandidateFindingSchema.parse(meta.finding);
        expect(finding).toMatchObject({ expected: { source: null }, capture: "observed_only", independence: "not_run", confidence: "low", replays: [] });
        expect(test.validationReason).toContain("observed only");
        expect(defectEvent(events).data).toMatchObject({ capture: "observed_only", confidence: "low", independence: "not_run", source: null });
    }, 300_000);
});
