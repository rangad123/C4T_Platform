/**
 * The leftover check through real jobs (queue row 181, second commit): HTTP API -> queue -> worker -> real discovery of a local shop ->
 * planning and authoring in a real browser with a scripted model double (never a real model). The cart starts with a Desk Lamp line
 * the test account was left with:
 *   - a test that removes that Desk Lamp by name, and does so again when written a second time: saved for review with the reason,
 *     never validated (no replay), a depends_on_earlier_state event;
 *   - a defect test that does the same: saved for review without a candidate finding, no possible_defect event, and its defect is
 *     not put to the verdict reviews;
 *   - a test that removes it the first time and, written again, adds its own Trail Mug and removes that: kept and validated.
 * Fixture site: port 9786. Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/orchestrator-leftovers.test.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const PORT = 9786;
const URL = `http://127.0.0.1:${PORT}`;

let site: http.Server;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dir: string;

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main>${body}</main></body></html>`;
const CART = page(
    "Cart",
    `<h1>Your cart</h1>
<table aria-label="Items in your cart"><tbody id="lines"><tr><td>Desk Lamp</td><td><button type="button" onclick="this.closest('tr').remove()">Remove</button></td></tr></tbody></table>
<button type="button" onclick="add()">Add Trail Mug</button>
<script>function add(){const r=document.createElement('tr');r.innerHTML='<td>Trail Mug</td><td><button type="button">Remove</button></td>';r.querySelector('button').onclick=()=>r.remove();document.getElementById('lines').append(r);}</script>`,
);

/** Every AI call, in order: "object:<purpose>", "text:<purpose>" or "agent". */
const calls: string[] = [];
const toolQueue: Array<{ tool: string; input: Record<string, unknown> }> = [];
let plan: Record<string, unknown> = {};
/** The test writer's first try, then its second (the leftover check's redo). */
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
    // The test review answers with no change; a defect verdict would say yes.
    text: (async ({ purpose }: { purpose?: string }) => {
        calls.push(`text:${purpose ?? "?"}`);
        return "yes";
    }) as LlmClient["text"],
    object: (async ({ system, purpose }: { system: string; purpose?: string }) => {
        calls.push(`object:${purpose ?? "?"}`);
        if (/analysing a web application/.test(system)) {
            return {
                siteType: "ecommerce", purpose: "A small shop", features: ["Cart"], pagePurposes: [],
                journeys: [{ name: "Change the cart", description: "Remove a line", steps: ["Open the cart"], priority: "high", pages: ["/"], requiresAuth: false }],
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
        if (req.url === "/cart") return void res.end(CART);
        res.end(page("Shop", `<h1>Shop</h1><p>Welcome to the shop.</p><a href="/cart">Cart</a>`));
    });
    await new Promise<void>((r) => site.listen(PORT, "127.0.0.1", r));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-orchestrator-leftovers-"));
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
    // Both tries were written: nothing of the script is left over.
    expect(toolQueue).toEqual([]);
    return { status: job!.status, test: tests[0]!, events: platform.repo.listEvents(queued.body.jobId) as Event[] };
}

const lampRow = { by: "role", role: "row", value: "Desk Lamp" };
const mugRow = { by: "role", role: "row", value: "Trail Mug" };
const removeLamp = { tool: "click", input: { target: { by: "role", role: "button", value: "Remove", within: lampRow }, why: "Remove the Desk Lamp line" } };
const lampGone = { tool: "assert", input: { check: "hidden", target: lampRow, source: "expected:1" } };
const finishComplete = { tool: "finish", input: { result: "complete", explanation: "The line is removed" } };
const cartScenario = { title: "Remove a cart line", description: "A line removed from the cart is gone", category: "Cart", priority: "high", journey: "Change the cart", startPath: "/cart", expectedResults: ["The removed line is no longer listed"] };
const kinds = (events: Event[], kind: string) => events.filter((e) => e.kind === kind);

describe("the leftover check", () => {
    it("a test that removes a line it never added, twice: saved for review with the reason, never validated", async () => {
        const projectId = (await call("POST", "/api/projects", { name: "Leftover" })).body.id as string;
        plan = cartScenario;
        script = [removeLamp, lampGone, finishComplete, removeLamp, lampGone, finishComplete];
        const { test, events } = await explore(projectId);

        expect(test.validationStatus).toBe("NEEDS_REVIEW");
        expect(test.validationReason).toMatch(/^Not validated: The test depends on what the account held before it ran: step \d+ removes "Desk Lamp"/);
        expect((test.generationMeta as Record<string, unknown>).leftovers).toEqual([{ step: expect.any(Number), what: 'removes "Desk Lamp"' }]);
        expect(kinds(events, "leftover_redo")).toHaveLength(1);
        expect(kinds(events, "depends_on_earlier_state")).toHaveLength(1);
        expect(kinds(events, "depends_on_earlier_state")[0]!.data).toMatchObject({ testKey: test.testKey });
        // Never replayed: no execution of the test was recorded.
        expect(platform.repo.listExecutions(test.id)).toEqual([]);
    }, 300_000);

    it("a defect test that does the same: saved for review without a candidate finding, no possible_defect, no verdict reviews", async () => {
        const projectId = (await call("POST", "/api/projects", { name: "Leftover defect" })).body.id as string;
        plan = cartScenario;
        const finishDefect = { tool: "finish", input: { result: "defect", explanation: "The Desk Lamp line is still listed" } };
        const lampShown = { tool: "assert", input: { check: "visible", target: lampRow, source: "expected:1" } };
        script = [removeLamp, lampShown, finishDefect, removeLamp, lampShown, finishDefect];
        const { test, events } = await explore(projectId);

        expect(test.validationStatus).toBe("NEEDS_REVIEW");
        expect(test.validationReason).toMatch(/^Not reported as a finding: The test depends on what the account held before it ran: /);
        const meta = test.generationMeta as Record<string, unknown>;
        expect(meta).not.toHaveProperty("finding");
        expect(meta.authoring).toBe("defect");
        expect(await new CandidateFindingStore(platform.db.sql).list(projectId)).toEqual([]);
        expect(kinds(events, "possible_defect")).toEqual([]);
        expect(kinds(events, "depends_on_earlier_state")).toHaveLength(1);
        expect(calls.filter((c) => c.startsWith("text:"))).toEqual([]);
    }, 300_000);

    it("written again with its own item: the second test adds a Trail Mug and removes it, and is validated", async () => {
        const projectId = (await call("POST", "/api/projects", { name: "Own item" })).body.id as string;
        plan = cartScenario;
        const addMug = { tool: "click", input: { target: { by: "role", role: "button", value: "Add Trail Mug" }, why: "Add a Trail Mug" } };
        const removeMug = { tool: "click", input: { target: { by: "role", role: "button", value: "Remove", within: mugRow }, why: "Remove the Trail Mug line" } };
        const mugGone = { tool: "assert", input: { check: "hidden", target: mugRow, source: "expected:1" } };
        script = [removeLamp, lampGone, finishComplete, addMug, removeMug, mugGone, finishComplete];
        const { test, events } = await explore(projectId);

        expect(kinds(events, "leftover_redo")).toHaveLength(1);
        expect(kinds(events, "depends_on_earlier_state")).toEqual([]);
        expect(test.spec.steps.some((s) => "locator" in s && JSON.stringify(s.locator).includes("Desk Lamp"))).toBe(false);
        expect(test.validationStatus).toBe("VALIDATED");
    }, 300_000);
});
