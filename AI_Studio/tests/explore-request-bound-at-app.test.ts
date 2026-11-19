/**
 * The page-independent request bound at the application (CP3b R-2): within one pursuit, the state-changing requests the engine's actions
 * send (POST, PUT, PATCH, DELETE) are counted by method and address pattern, and once one has been sent the repeat limit's number of times,
 * an action that would send it again is refused before it runs. The cases are the CP3b adversary's evasions (b/zz-interrogate-b1): a
 * button whose name carries a counter, a changing aria-label, a clock or navigate step between the clicks, and a late button spelled 8
 * ways. Each must send at most the limit of POSTs, and the extra clicks are refused before they run. A legitimate test that submits the same form twice with different values still works.
 * A local server counts what really arrived; the test writer is a scripted model double, never a real model.
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/explore-request-bound-at-app.test.ts
 */
import http from "node:http";
import { MockLanguageModelV3 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { exploreShop, type ShopSite } from "./fixtures/objectives-shop.js";

const PORT = 9983;
/** The loop's repeat limit: an action and its double submit. */
const LIMIT = 2;
let site: ShopSite & { posts: Record<string, number> };
const page = (body: string, script = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>T</title></head><body><main>${body}</main>${script}</body></html>`;

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = { server: undefined as unknown as http.Server, url: `http://127.0.0.1:${PORT}`, fixed: false, injection: true, posts: {} };
    site.server = http.createServer((req, res) => {
        const path = (req.url ?? "/").split("?")[0]!;
        if (req.method === "POST") site.posts[path] = (site.posts[path] ?? 0) + 1;
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            const n = site.posts[path] ?? 0;
            if (path === "/count") return res.end(page(`<h1>Count</h1><form method="post" action="/count"><button type="submit">Order (${n})</button></form>`));
            if (path === "/label") return res.end(page(`<h1>Label</h1><form method="post" action="/label"><button type="submit" aria-label="Place order ${n}">Order</button></form>`));
            if (path === "/late")
                return res.end(page(`<h1>Late</h1><form method="post" action="/late" id="f"></form>`, `<script>setTimeout(()=>{const b=document.createElement('button');b.type='submit';b.textContent='Order';document.getElementById('f').append(b)},3500)</script>`));
            if (path === "/api") {
                // A form-less button that sends its order with fetch; its text carries the count.
                return res.end(page(`<h1>Api</h1><button id="b">Buy (${n})</button><p id="out"></p>`, `<script>let k=0;document.getElementById('b').onclick=async()=>{await fetch('/api/orders/'+(++k*7),{method:'POST'});const b=document.getElementById('b');b.textContent='Buy ('+k+')';b.name='n'+k}</script>`));
            }
            if (path.startsWith("/api/orders/")) return res.end("{}");
            res.end(page(`<h1>Order</h1><form method="post" action="/order"><label>Quantity <input name="qty"></label><button type="submit">Order</button></form><p>Ordered: ${req.method === "POST" ? "yes" : "no"}</p>`));
        });
    });
    await new Promise<void>((r) => site.server.listen(PORT, "127.0.0.1", r));
}, 60_000);
afterAll(() => site?.server.close());

type Call = { tool: string; input: Record<string, unknown> };
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
function model(steps: Call[][]): LlmClient {
    const m = new MockLanguageModelV3({
        doGenerate: async (options) => {
            const messages = options.prompt as Array<{ role: string; content: unknown }>;
            const first = JSON.stringify(messages.find((x) => x.role === "user")?.content ?? "");
            const op = /Operator: ([A-Za-z ()]+?)\./.exec(first)?.[1] ?? "?";
            const n = messages.filter((x) => x.role === "assistant").length;
            const calls = op === "As stated" ? steps[n] : undefined;
            if (!calls) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
            return { content: calls.map((c, i) => ({ type: "tool-call" as const, toolCallId: `s${n}c${i}`, toolName: c.tool, input: JSON.stringify(c.input) })), finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
        },
    });
    return {
        modelName: "scripted", model: m, usage: { inputTokens: 0, outputTokens: 0 },
        text: (async () => "yes") as LlmClient["text"],
        object: (async ({ system }: { system: string }) => {
            if (/analysing a web application/.test(system)) return { siteType: "ecommerce", purpose: "shop", features: [], pagePurposes: [], journeys: [], authenticationMechanisms: [] };
            throw new Error("not scripted");
        }) as LlmClient["object"],
    };
}
async function run(name: string, steps: Call[][]) {
    site.posts = {};
    const r = await exploreShop(site, model(steps), { objectives: true, dataOperators: true, allowMutatingApiTests: true });
    const ex = r.summary.exploration!;
    const rule = ex.outcomes.find((o) => o.objectiveId.endsWith(":as_stated"))!;
    const log = ex.actionLog.filter((a) => a.objectiveId === rule.objectiveId);
    const out = { status: rule.status, reason: rule.reason, posts: { ...site.posts }, performedClicks: log.filter((a) => a.result === "performed" && a.action.startsWith("click")).length, refused: log.filter((a) => a.result === "refused") };
    console.log(name, JSON.stringify(out));
    return out;
}
const btn = (value: string) => ({ tool: "click", input: { target: { by: "role", role: "button", value } } });
const css = (value: string) => ({ tool: "click", input: { target: { by: "css", value } } });
const nav = (url: string) => ({ tool: "navigate", input: { url } });
/** Refused before it ran: as a repeat of the same action on the same state, or by the request bound. */
const REFUSED = /^(The same action on the same state was tried again|The request POST .* was already sent \d+ times in this pursuit)/;

describe("the request bound: names the page controls and actions in between do not make the same submit new (R-2)", () => {
    it("A1: a button 'Order (n)' whose count changes, 12 clicks in one reply", async () => {
        const r = await run("A1", [[nav("/count")], Array.from({ length: 12 }, () => css("form button"))]);
        expect(r.posts["/count"] ?? 0).toBeLessThanOrEqual(LIMIT);
        expect(r.posts["/count"]).toBe(r.performedClicks);
        expect(r.status).toBe("stopped");
    }, 300_000);
    it("A1b: the same, 45 clicks in one reply", async () => {
        const r = await run("A1b", [[nav("/count")], Array.from({ length: 45 }, () => css("form button"))]);
        expect(r.posts["/count"] ?? 0).toBeLessThanOrEqual(LIMIT);
    }, 600_000);
    it("A2: a changing aria-label, 12 clicks in one reply", async () => {
        const r = await run("A2", [[nav("/label")], Array.from({ length: 12 }, () => ({ tool: "click", input: { target: { by: "text", value: "Order" } } }))]);
        expect(r.posts["/label"] ?? 0).toBeLessThanOrEqual(LIMIT);
        expect(r.refused[0]?.reason).toMatch(REFUSED);
    }, 300_000);
    it("A3: a clock step with a new value between the same Order clicks", async () => {
        const calls = Array.from({ length: 10 }, (_, i) => [{ tool: "clock", input: { op: "fastForward", minutes: i + 1 } }, btn("Order")]).flat();
        const r = await run("A3", [[nav("/order")], calls]);
        expect(r.posts["/order"] ?? 0).toBeLessThanOrEqual(LIMIT);
        expect(r.refused[0]?.reason).toMatch(REFUSED);
    }, 300_000);
    it("A4: a navigate with a new query string between the same Order clicks", async () => {
        const calls = Array.from({ length: 10 }, (_, i) => [nav(`/order?i=${i}`), btn("Order")]).flat();
        const r = await run("A4", [[nav("/order")], calls]);
        expect(r.posts["/order"] ?? 0).toBeLessThanOrEqual(LIMIT);
        expect(r.refused[0]?.reason).toMatch(REFUSED);
    }, 300_000);
    it("A5: a button that appears 3.5 s after load, its locator spelled 8 ways", async () => {
        const v = ["form button", "main button", "button", "#f button", "form > button", "main form button", "body button", "button[type=submit]"];
        const r = await run("A5", [[nav("/late")], ...v.map((value) => [css(value)])]);
        expect(r.posts["/late"] ?? 0).toBeLessThanOrEqual(LIMIT);
        expect(r.refused[0]?.reason).toMatch(REFUSED);
    }, 300_000);
    it("a form-less fetch button whose text, name and request id change: one request target", async () => {
        const r = await run("API", [[nav("/api")], Array.from({ length: 8 }, () => ({ tool: "click", input: { target: { by: "css", value: "#b" } } }))]);
        const sent = Object.entries(r.posts).filter(([p]) => p.startsWith("/api/orders/")).reduce((s, [, n]) => s + n, 0);
        expect(sent).toBeLessThanOrEqual(LIMIT);
    }, 300_000);
    it("a legitimate test that submits the same form twice with different values still works within the limit", async () => {
        const fill = (v: string) => ({ tool: "fill", input: { target: { by: "label", value: "Quantity" }, value: v } });
        const r = await run("LEGIT", [
            [nav("/order")],
            [fill("1")],
            [btn("Order")],
            [fill("2")],
            [btn("Order")],
            [{ tool: "assert", input: { check: "visible", target: { by: "text", value: "Ordered: yes" } } }],
            [{ tool: "finish", input: { result: "complete", explanation: "ordered twice" } }],
        ]);
        // Both submits were performed and nothing was refused; the test was written. (The saved test then runs and is replayed after
        // the pursuit, which sends more POSTs: those are the saved test's runs, not the exploration's actions.)
        expect(r.performedClicks).toBe(2);
        expect(r.posts["/order"]).toBeGreaterThanOrEqual(2);
        expect(r.refused).toEqual([]);
        expect(r.status).toBe("completed");
    }, 300_000);
});
