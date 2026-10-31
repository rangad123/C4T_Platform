/**
 * Repair without AI first, with real work: a fixture page whose controls changed after the tests were written, the real validator running
 * the rendered scripts under Playwright, and a scripted model that counts every call (never a real model).
 *   - each kind of fix (same role and name, same text, moved element, a shared element's other locator) makes the test pass and the model
 *     is NOT called; the job log says which way fixed it;
 *   - when no plain fix exists, or the one found does not make the test pass, the model is asked as before;
 *   - with the switch off the model is asked even where a plain fix exists.
 * Port 7350. Runs a browser: node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/det-repair.test.ts
 */
import http from "node:http";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import type { EngineContext, EngineEvent } from "../src/engine/context.js";
import { launchChromium } from "../src/engine/discovery/browser.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { indexOf } from "../src/engine/locators/refs.js";
import { ScenarioSchema, TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { validateBatch, type ValidationOutcome } from "../src/engine/validation/validator.js";

const PORT = 7350;
const FIX = `http://127.0.0.1:${PORT}`;

// The page as it is now: every control a test was written against has changed a little.
const PAGE = `<!doctype html><html><head><title>Shop</title></head><body>
<h1>Shop</h1>
<main>
  <button onclick="say('sign-in')">Sign in</button>
  <a href="#" onclick="say('checkout');return false;">Checkout</a>
  <section class="new-place"><button class="primary buy-now" onclick="say('buy')">Buy it now</button></section>
  <button onclick="say('save')">Save changes</button>
  <p id="msg">Nothing clicked</p>
</main>
<script>function say(w){document.getElementById('msg').textContent='Clicked: '+w;}</script>
</body></html>`;

let server: http.Server;
let browser: Browser;
const baseConfig = loadConfig({});

beforeAll(async () => {
    server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE);
    });
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
    browser = await launchChromium(true);
}, 60_000);

afterAll(async () => {
    await browser?.close().catch(() => undefined);
    server?.close();
});

const emptyModel: AppModel = {
    url: FIX, origin: FIX, siteType: "ecommerce", purpose: "demo", features: [], pages: [], navigation: [], apis: [], journeys: [],
    authentication: { required: false, mechanisms: [], loggedIn: false }, externalDependencies: [], documentedTestCases: [],
    stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
};

/** A model double: every call is counted; a repair triage says "the application is at fault", so nothing is re-authored. */
function countingModel() {
    const calls: Array<{ purpose?: string; prompt: string }> = [];
    const llm: LlmClient = {
        modelName: "scripted",
        model: {} as never,
        usage: { inputTokens: 0, outputTokens: 0 },
        text: async () => "",
        object: (async (args: { prompt: string; purpose?: string }) => {
            calls.push({ purpose: args.purpose, prompt: args.prompt });
            return { category: "app_defect", fixable: false, reason: "The scripted model blames the application." };
        }) as LlmClient["object"],
    };
    return { llm, calls };
}

let n = 0;
const spec = (title: string, click: Record<string, unknown>, expected: string): TestSpec =>
    TestSpecSchema.parse({
        testId: `WEB-${String(++n).padStart(3, "0")}`,
        title,
        kind: "web",
        category: "Shop",
        source: { origin: "browser-agent" },
        steps: [
            { action: "navigate", url: "/" },
            { action: "click", locator: click },
            { action: "assert", check: "text", locator: { by: "css", value: "#msg" }, expected },
        ],
    });
const scenario = ScenarioSchema.parse({ scenarioId: "S-1", title: "Use the shop", description: "Use the shop", category: "Shop", expectedResults: ["It works"] });

async function validate(specs: TestSpec[], config: Partial<Config> = {}, sharedElements?: EngineContext["sharedElements"]) {
    const m = countingModel();
    const events: EngineEvent[] = [];
    const ctx: EngineContext = { config: { ...baseConfig, ...config }, llm: m.llm, emit: (e) => events.push(e), ...(sharedElements ? { sharedElements } : {}) };
    const attempts = new Map<string, number>();
    const repaired = new Map<string, string>();
    const outcomes: ValidationOutcome[] = await validateBatch(
        ctx,
        { browser, scratchDir: baseConfig.scratchDir, env: { baseUrl: FIX, headless: true }, render: { baseUrl: FIX }, model: emptyModel, maxRepairAttempts: 1, workers: 2 },
        specs.map((s) => ({ spec: s, framework: "playwright", scenario })),
        {
            async onAttempt(t, a) {
                attempts.set(t.spec.testId, a);
            },
            async onRepaired(t, _s, reason) {
                repaired.set(t.spec.testId, reason);
            },
            async onFinal() {},
        },
    );
    return { outcomes, events, calls: m.calls, attempts, repaired };
}

const byId = (o: ValidationOutcome[], id: string) => o.find((x) => x.spec.testId === id)!;

describe("repair without AI first", () => {
    it("each kind of plain fix makes its test pass, and the model is never asked", async () => {
        const roleName = spec("Sign in", { by: "role", role: "button", value: "Sign In", exact: true }, "Clicked: sign-in");
        const sameText = spec("Check out", { by: "role", role: "button", value: "Checkout", exact: true }, "Clicked: checkout");
        const moved = spec("Buy", { by: "css", value: "div.cart > button.buy-now" }, "Clicked: buy");
        const shared = spec("Save", { by: "testId", value: "old-save" }, "Clicked: save");
        // As the job runner hands it over: the shared element resolved to its locator, remembering its name (locators/refs.ts).
        (shared.steps[1] as { locator: Record<string, unknown> }).locator.ref = "Save button";
        const objects = indexOf([{ name: "Save button", kind: "web", locator: { by: "testId", value: "old-save" }, alternatives: [{ by: "role", role: "button", value: "Save changes", exact: true }] }]);
        const t0 = Date.now();
        const r = await validate([roleName, sameText, moved, shared], {}, objects);
        const ms = Date.now() - t0;

        expect(r.calls, JSON.stringify(r.calls.map((c) => c.purpose))).toEqual([]);
        for (const s of [roleName, sameText, moved, shared]) {
            const o = byId(r.outcomes, s.testId);
            expect(o.status, `${s.testId}: ${o.reason}`).toBe("VALIDATED");
            expect(o.attempts).toBe(2);
            expect(r.repaired.get(s.testId)).toMatch(/^Fixed without AI: /);
        }
        const kinds = Object.fromEntries(r.events.filter((e) => e.kind === "repaired_without_ai").map((e) => [(e.data as { testId: string }).testId, (e.data as { kind: string }).kind]));
        expect(kinds).toEqual({ [roleName.testId]: "role-name", [sameText.testId]: "same-text", [moved.testId]: "moved", [shared.testId]: "shared-element" });

        // The new locators: only the failing step changed, and it finds the element as it is now.
        expect(byId(r.outcomes, roleName.testId).spec.steps[1]).toMatchObject({ action: "click", locator: { by: "role", role: "button", value: "Sign in", exact: true } });
        expect(byId(r.outcomes, sameText.testId).spec.steps[1]).toMatchObject({ locator: { by: "text", value: "Checkout", exact: true } });
        expect(byId(r.outcomes, moved.testId).spec.steps[1]).toMatchObject({ locator: { by: "role", role: "button", value: "Buy it now", exact: true } });
        expect(byId(r.outcomes, shared.testId).spec.steps[1]).toMatchObject({ locator: { by: "role", role: "button", value: "Save changes", exact: true } });
        expect(byId(r.outcomes, roleName.testId).spec.steps[2]).toEqual(roleName.steps[2]);
        expect(r.events.find((e) => e.kind === "repaired_without_ai" && (e.data as { testId: string }).testId === sameText.testId)!.message).toBe(
            `${sameText.testId}: Fixed without AI: the “Checkout” button was not on the page; with the text “Checkout” instead (found by the same text) the test passed.`,
        );
        console.log(`[det-repair] 4 tests repaired without AI in ${ms} ms, 0 model calls`);
    }, 240_000);

    it("asks the model when no plain fix exists, or when the one found does not make the test pass", async () => {
        const nothing = spec("Missing", { by: "role", role: "button", value: "Order history" }, "Clicked: history");
        const stillFails = spec("Sign in and see something else", { by: "role", role: "button", value: "Sign In", exact: true }, "Welcome back");
        const r = await validate([nothing, stillFails]);
        expect(r.calls.map((c) => c.purpose)).toEqual(["repair", "repair"]);
        for (const s of [nothing, stillFails]) expect(byId(r.outcomes, s.testId).status).toBe("NEEDS_REVIEW");
        expect(r.events.some((e) => e.kind === "repaired_without_ai")).toBe(false);
        expect(r.events.find((e) => e.kind === "repair_without_ai_tried")?.message).toBe(`${stillFails.testId}: tried the “Sign in” button (found by the same role and name); the test still did not pass with it`);
        // The model saw the original failure, not the plain fix's.
        expect(r.calls.find((c) => c.prompt.includes(stillFails.testId))!.prompt).toContain('"value":"Sign In"');
    }, 240_000);

    it("with the switch off the model is asked even where a plain fix exists", async () => {
        const roleName = spec("Sign in (switch off)", { by: "role", role: "button", value: "Sign In", exact: true }, "Clicked: sign-in");
        const r = await validate([roleName], { LLM_DETERMINISTIC_REPAIR: "false" });
        expect(r.calls.map((c) => c.purpose)).toEqual(["repair"]);
        expect(byId(r.outcomes, roleName.testId).status).toBe("NEEDS_REVIEW");
        expect(r.events.some((e) => e.kind === "repaired_without_ai" || e.kind === "repair_without_ai_tried")).toBe(false);
    }, 240_000);
});
