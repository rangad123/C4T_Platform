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
import type { Browser } from "playwright";
import { loadConfig } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import { launchChromium } from "../src/engine/discovery/browser.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { actionTracker } from "../src/engine/orchestrator.js";
import { ScenarioSchema, type Step } from "../src/engine/spec/schema.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { authorWebSpec, type ActionGate } from "../src/engine/web/author.js";
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
            if (path === "/login") return res.end(page(`<h1>Sign in</h1><form method="post" action="/login/session"><label>Username <input name="u"></label><label>Password <input name="p" type="password"></label><button type="submit">Sign in</button></form>`));
            // A single-endpoint app (CP3c T-4): the sign-in form and a Delete form elsewhere both post to /app.
            if (path === "/login2")
                return res.end(page(`<h1>Sign in</h1><form method="post" action="/app"><input type="hidden" name="op" value="login"><label>Username <input name="u"></label><label>Password <input name="p" type="password"></label><button type="submit">Sign in</button></form>`));
            if (path === "/shop") return res.end(page(`<h1>Shop</h1><form method="post" action="/app"><input type="hidden" name="op" value="delete-account"><button type="submit">Delete</button></form>`));
            if (path === "/app") return res.end(page(`<h1>Done</h1><a href="/shop">Shop</a>`));
            if (path === "/login/session") return res.end(page(`<h1>Welcome</h1><a href="/order">Order</a>`));
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

// ------------------------------------------------------------------ the run's own sign-in, in every pass of one pursuit

describe("the request bound and the run's own sign-in: every pass may sign in again, a submit may not be sent a third time", () => {
    let browser: Browser;
    beforeAll(async () => {
        browser = await launchChromium(true);
    }, 60_000);
    afterAll(async () => {
        await browser?.close();
    });
    const ctxOf = (calls: Call[][]): EngineContext => {
        let n = 0;
        const m = new MockLanguageModelV3({
            doGenerate: async () => {
                const step = calls[n++];
                if (!step) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
                return { content: step.map((c, i) => ({ type: "tool-call" as const, toolCallId: `p${n}c${i}`, toolName: c.tool, input: JSON.stringify(c.input) })), finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
            },
        });
        return { config: loadConfig({}), emit: () => undefined, llm: { modelName: "scripted", model: m, usage: { inputTokens: 0, outputTokens: 0 }, object: async () => ({}) as never, text: async () => "yes" } };
    };
    const app = (): AppModel => ({
        url: site.url, origin: site.url, siteType: "ecommerce", purpose: "demo", features: [], pages: [], navigation: [], apis: [], journeys: [],
        authentication: { required: true, mechanisms: ["form"], loggedIn: true, loginPath: "/login" }, externalDependencies: [], documentedTestCases: [],
        stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
    });
    const scenario = ScenarioSchema.parse({ scenarioId: "S-ORDER", title: "Order", description: "Sign in and order", category: "Order", startPath: "/login", expectedResults: ["The order page is shown"] });
    const open = { action: "navigate", url: "/login", description: "Open /login" } as Step;
    const signIn = [
        { action: "fill", locator: { by: "label", value: "Username" }, value: "{{credentials.username}}", description: "" },
        { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}", description: "" },
        { action: "click", locator: { by: "role", role: "button", value: "Sign in" }, description: "" },
    ] as Step[];
    const order = [{ action: "navigate", url: "/order", description: "" }, { action: "click", locator: { by: "role", role: "button", value: "Order" }, description: "" }] as Step[];
    const finish: Call[][] = [[{ tool: "assert", input: { check: "visible", target: { by: "role", role: "heading", value: "Order" } } }], [{ tool: "finish", input: { result: "complete", explanation: "ordered" } }]];

    /** One pursuit's gate as the orchestrator builds it, with the engine's sign-in page; a refusal of the tracker is a refusal. */
    function pursuitGate(signInPath: string | undefined): ActionGate {
        const t = actionTracker(`${site.url}/login`, [], signInPath ? { signInPath } : {});
        return {
            before: (a) => {
                const v = t.before(a);
                return v.refusal ? { allowed: false, reason: v.refusal } : { allowed: true };
            },
            after: (a) => t.after(a),
            freshPass: (start) => t.freshPass(start),
            // The replays without the AI (pruning stale steps) are refused, so what reaches the app is only the passes' own actions.
            replay: () => false,
            request: (target) => t.request(target),
            limitReached: () => t.limitReached(),
            signedIn: (a) => t.signedIn(a),
        };
    }
    /** A pass that replays `prefix` (a review's fix, the leftover redo) and then lets the scripted model finish. */
    const pass = (gate: ActionGate, prefix: Step[]) =>
        authorWebSpec({ ctx: ctxOf(finish), browser, baseUrl: site.url, model: app(), scenario, credentials: { username: "tester", password: "Pw-12345!" }, gate, resume: { prefix: [open, ...prefix], failure: "x", review: true } });

    it("four passes each sign in again and the test is saved; the order submit is refused the third time", async () => {
        site.posts = {};
        const gate = pursuitGate("/login");
        const outs = [];
        outs.push(await pass(gate, [...signIn, ...order]));
        outs.push(await pass(gate, [...signIn, ...order]));
        outs.push(await pass(gate, [...signIn, ...order]));
        outs.push(await pass(gate, [...signIn, order[0]!]));
        console.log("SIGNIN", JSON.stringify({ posts: site.posts, outs: outs.map((o) => [o.status, o.explanation.slice(0, 160)]) }));
        expect(outs[0]!.status).toBe("complete");
        expect(outs[1]!.status).toBe("complete");
        // The third pass signs in (not refused), and is refused at its third order submit.
        expect(outs[2]).toMatchObject({ status: "blocked", explanation: expect.stringMatching(/^Replay of previous steps was refused at ".*": The request POST \S+\/order was already sent 2 times/) });
        // The fourth pass signs in a fourth time and its test is saved.
        expect(outs[3]!.status).toBe("complete");
        expect(site.posts["/login/session"]).toBe(4);
        expect(site.posts["/order"]).toBe(2);
    }, 300_000);

    it("the exemption is the engine's sign-in page only: without it, the third sign-in is refused like any submit", async () => {
        site.posts = {};
        const gate = pursuitGate(undefined);
        const outs = [];
        for (let i = 0; i < 3; i++) outs.push(await pass(gate, [...signIn, order[0]!]));
        expect(outs.slice(0, 2).map((o) => o.status)).toEqual(["complete", "complete"]);
        expect(outs[2]).toMatchObject({ status: "blocked", explanation: expect.stringMatching(/refused at ".*": The request POST \S+\/login\/session was already sent 2 times/) });
        expect(site.posts["/login/session"]).toBe(2);
    }, 300_000);

    it("the exemption is the sign-in form, not its address: a Delete form posting to the sign-in's /app is counted (CP3c T-4)", async () => {
        site.posts = {};
        const gate = pursuitGate("/login2");
        const prefix = [
            open,
            { action: "navigate", url: "/login2", description: "" },
            ...signIn,
            ...Array.from({ length: 6 }, (_, i) => [{ action: "navigate", url: `/shop?i=${i}`, description: "" }, { action: "click", locator: { by: "role", role: "button", value: "Delete" }, description: "" }]).flat(),
        ] as Step[];
        const done: Call[][] = [[{ tool: "assert", input: { check: "visible", target: { by: "role", role: "heading", value: "Done" } } }], [{ tool: "finish", input: { result: "complete", explanation: "signed in" } }]];
        const o = await authorWebSpec({ ctx: ctxOf(done), browser, baseUrl: site.url, model: app(), scenario, credentials: { username: "tester", password: "Pw-12345!" }, gate, resume: { prefix, failure: "x", review: true } });
        // One sign-in and the limit's Delete submits; the third Delete is refused before it runs.
        expect(o).toMatchObject({ status: "blocked", explanation: expect.stringMatching(/refused at ".*": The request POST \S+\/app was already sent 2 times/) });
        expect(site.posts["/app"]).toBe(1 + LIMIT);
        // The sign-in itself stays exempt: two more passes sign in again on the same /app.
        site.posts = {};
        const again = [open, ...Array.from({ length: 2 }, () => [{ action: "navigate", url: "/login2", description: "" }, ...signIn]).flat()] as Step[];
        const o2 = await authorWebSpec({ ctx: ctxOf(done), browser, baseUrl: site.url, model: app(), scenario, credentials: { username: "tester", password: "Pw-12345!" }, gate, resume: { prefix: again, failure: "x", review: true } });
        expect(o2.status).toBe("complete");
        expect(site.posts["/app"]).toBe(2);
    }, 300_000);

    it("only the run's own password placeholder marks the sign-in: a form filled with typed text on the sign-in page is counted", async () => {
        site.posts = {};
        const gate = pursuitGate("/login");
        // The password typed as text, not as {{credentials.password}}: the engine did not sign in, the page's form is any form.
        const typed = signIn.map((st) => ((st as { value?: string }).value === "{{credentials.password}}" ? { ...st, value: "Pw-12345!" } : st)) as Step[];
        const outs = [];
        for (let i = 0; i < 3; i++) outs.push(await pass(gate, [...typed, order[0]!]));
        expect(outs[2]).toMatchObject({ status: "blocked", explanation: expect.stringMatching(/The request POST \S+\/login\/session was already sent 2 times/) });
        expect(site.posts["/login/session"]).toBe(2);
    }, 300_000);
});
