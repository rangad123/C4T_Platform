/**
 * A saved web test is self-contained (Phase 3 P3-09; D1 WEB-034 failed on both the seeded and the clean app because the cart was
 * empty, or held items from earlier tests).
 *
 * Every test starts in a fresh browser on a fresh session, sets up what it needs in its own steps, and never relies on what another
 * test left. The scenario's preconditions are given to the agent as the first things to set up, not as a state to assume.
 *
 * The fixture is a shop whose cart is kept on the server for its one account, so one test's additions are there for the next; the
 * account starts empty. The scripted model stands in for an agent that does what its prompt says: told to set the preconditions up, it
 * adds the item itself; told only that "the cart holds a Mug", it assumes the state and checks the cart straight away (which passes while
 * the earlier test's Mug is still there). Never a real model.
 */
import http from "node:http";
import { MockLanguageModelV3 } from "ai/test";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import { BrowserSession, launchChromium, settle } from "../src/engine/discovery/browser.js";
import { ScenarioSchema, type Step } from "../src/engine/spec/schema.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { authorWebSpec } from "../src/engine/web/author.js";
import { executeStep, runtimeData } from "../src/engine/web/interpreter.js";

const PORT = 9893;
const BASE = `http://127.0.0.1:${PORT}`;
/** The account's cart, kept by the server across browsers and sessions. */
let cart: string[] = [];

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`;
const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/add") {
        let b = "";
        req.on("data", (d) => (b += d));
        req.on("end", () => {
            cart.push(new URLSearchParams(b).get("item") ?? "?");
            res.writeHead(303, { location: "/cart" });
            res.end();
        });
        return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (req.url === "/cart")
        return void res.end(page("Cart", `<h1>Cart</h1>${cart.length ? `<ul aria-label="Cart items">${cart.map((i) => `<li>${i}</li>`).join("")}</ul>` : "<p>Your cart is empty</p>"}<a href="/shop">Shop</a>`));
    res.end(page("Shop", `<h1>Shop</h1><form method="post" action="/add"><button name="item" value="Mug">Add Mug to cart</button></form><a href="/cart">Cart</a>`));
});

let browser: Browser;
beforeAll(async () => {
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
    browser = await launchChromium(true);
}, 30_000);
afterAll(async () => {
    await browser?.close();
    server.close();
});

type Call = { tool: string; input: Record<string, unknown> };
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
type Prompt = Parameters<MockLanguageModelV3["doGenerate"]>[0]["prompt"];
const textOf = (prompt: Prompt, role: "system" | "user") =>
    prompt
        .filter((m) => m.role === role)
        .map((m) => (typeof m.content === "string" ? m.content : m.content.map((p) => ("text" in p ? p.text : "")).join("")))
        .join("\n");

/** A model double that reads its prompt once and then plays the script it picks, one tool call per turn. */
function scripted(pick: (system: string, user: string) => Call[], seen?: { system: string; user: string }) {
    let calls: Call[] | undefined;
    let i = 0;
    return new MockLanguageModelV3({
        doGenerate: async ({ prompt }) => {
            if (!calls) {
                const system = textOf(prompt, "system");
                const user = textOf(prompt, "user");
                if (seen) Object.assign(seen, { system, user });
                calls = pick(system, user);
            }
            const next = calls[i++];
            if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
            return { content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
        },
    });
}
const ctxFor = (model: MockLanguageModelV3): EngineContext => ({
    config: loadConfig({}),
    emit: () => undefined,
    llm: { modelName: "scripted", model, usage: { inputTokens: 0, outputTokens: 0 }, object: async () => ({}) as never, text: async () => "OK" },
});
const appModel: AppModel = {
    url: BASE, origin: BASE, siteType: "ecommerce", purpose: "fixture", features: [], pages: [], navigation: [], apis: [], journeys: [],
    authentication: { required: false, mechanisms: [], loggedIn: false }, externalDependencies: [], documentedTestCases: [],
    stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
};

const addMug: Call = { tool: "click", input: { target: { by: "role", role: "button", value: "Add Mug to cart" }, why: "Add a Mug to the cart" } };
const cartListsMug: Call = { tool: "assert", input: { check: "text", target: { by: "role", role: "list", value: "Cart items" }, expected: "Mug", source: "expected:1" } };
const done: Call = { tool: "finish", input: { result: "complete", explanation: "The cart lists the Mug" } };

/** Replays saved steps in a fresh browser, as a saved test runs: true when every step passed. */
async function replays(steps: Step[]): Promise<boolean> {
    const session = await BrowserSession.launch(browser, { startUrl: BASE });
    session.page.setDefaultTimeout(3_000);
    try {
        const data = runtimeData({});
        for (const step of steps) {
            await executeStep(session.page, step, data, BASE, 3_000);
            await settle(session.page, 500);
        }
        return true;
    } catch {
        return false;
    } finally {
        await session.close();
    }
}

describe("a saved test sets up its own state", () => {
    it("a test authored after another one changed the account still replays green on a freshly reset app", async () => {
        cart = [];
        // An earlier test leaves a Mug in the account's cart.
        const first = await authorWebSpec({
            ctx: ctxFor(scripted(() => [addMug, cartListsMug, done])),
            browser, baseUrl: BASE, model: appModel,
            scenario: ScenarioSchema.parse({ scenarioId: "S-ADD", title: "Add a Mug", description: "A Mug can be added to the cart", category: "Cart", startPath: "/shop", expectedResults: ["The cart lists the Mug"] }),
        });
        expect(first.status).toBe("complete");
        expect(cart.length).toBeGreaterThan(0);

        const seen = { system: "", user: "" };
        // Told to set the preconditions up with its own first steps, the agent adds the Mug itself; otherwise it assumes the cart holds one.
        const setUpAsked = (user: string) => /Set up first[^\n]*\n\s*1\. The cart holds a Mug/.test(user);
        const second = await authorWebSpec({
            ctx: ctxFor(scripted((_system, user) => (setUpAsked(user) ? [{ tool: "navigate", input: { url: "/shop" } }, addMug, cartListsMug, done] : [cartListsMug, done]), seen)),
            browser, baseUrl: BASE, model: appModel,
            scenario: ScenarioSchema.parse({ scenarioId: "S-CART", title: "The cart lists what was added", description: "The cart shows an item that is in it", category: "Cart", startPath: "/cart", preconditions: ["The cart holds a Mug"], expectedResults: ["The cart lists the Mug"] }),
        });
        expect(second.status).toBe("complete");

        // The prompt states the preconditions as steps to perform, and the instructions say why.
        expect(seen.user).toMatch(/Set up first[^\n]*\n\s*1\. The cart holds a Mug/);
        expect(seen.user).not.toMatch(/^Preconditions: The cart holds a Mug/m);
        expect(seen.system).toMatch(/fresh browser/i);
        expect(seen.system).toMatch(/never rel(y|ies) on what another test/i);
        expect(seen.system).toMatch(/\{\{unique\}\}[^\n]*every new record/i);

        // A freshly reset app: the saved test adds its own Mug, so it still passes.
        cart = [];
        expect(second.steps.map((s) => s.action)).toEqual(["navigate", "navigate", "click", "assert"]);
        expect(await replays(second.steps)).toBe(true);
    }, 120_000);

    it("a scenario without preconditions says so and asks for no setup", async () => {
        cart = [];
        const seen = { system: "", user: "" };
        await authorWebSpec({
            ctx: ctxFor(scripted(() => [addMug, cartListsMug, done], seen)),
            browser, baseUrl: BASE, model: appModel,
            scenario: ScenarioSchema.parse({ scenarioId: "S-ADD2", title: "Add a Mug", description: "A Mug can be added", category: "Cart", startPath: "/shop", expectedResults: ["The cart lists the Mug"] }),
        });
        expect(seen.user).toMatch(/^Preconditions: none$/m);
        expect(seen.user).not.toMatch(/Set up first/);
    }, 90_000);
});
