/**
 * Smaller page snapshots in the web authoring agent (src/engine/web/author.ts + src/engine/snapshots/*), in a real browser with a scripted model
 * double (AI SDK's MockLanguageModelV3, never a real model). The same scripted runs with the setting off and on must end with the same test
 * (same steps, byte-identical script) while the model is sent fewer characters; the numbers are printed for the report. Ports 7314-7315.
 * Runs under the browser lock:  node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/snapshot-agent.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import type http from "node:http";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import type { EngineContext, EngineEvent } from "../src/engine/context.js";
import { launchChromium } from "../src/engine/discovery/browser.js";
import { renderScript } from "../src/engine/generators/index.js";
import { COMPACT_SNAPSHOT_NOTE } from "../src/engine/snapshots/compact.js";
import { EVENT_SNAPSHOT_SAVINGS } from "../src/engine/snapshots/setting.js";
import { ScenarioSchema, TestSpecSchema } from "../src/engine/spec/schema.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { authorWebSpec, toSpec } from "../src/engine/web/author.js";
import { startCatalog } from "./fixtures/snapshot-catalog.js";

const SAMPLE_PORT = 7314;
const CATALOG_PORT = 7315;
const SAMPLE = `http://127.0.0.1:${SAMPLE_PORT}`;
const CATALOG = `http://127.0.0.1:${CATALOG_PORT}`;
let app: ChildProcess;
let catalog: http.Server;
let browser: Browser;

beforeAll(async () => {
    app = spawn(process.execPath, [path.join(REPO_ROOT, "examples/sample-app/server.mjs"), String(SAMPLE_PORT)], { stdio: "ignore" });
    catalog = await startCatalog(CATALOG_PORT);
    for (let i = 0; i < 40; i++) {
        try {
            if ((await fetch(SAMPLE + "/")).ok) break;
        } catch {
            await new Promise((r) => setTimeout(r, 150));
        }
    }
    browser = await launchChromium(true);
}, 30_000);
afterAll(async () => {
    await browser?.close();
    catalog?.close();
    app?.kill();
});

type Call = { tool: string; input: Record<string, unknown> };
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

/** Plays back a fixed list of tool calls and keeps what each model step was sent. */
function scripted(calls: Call[]) {
    let i = 0;
    const prompts: string[] = [];
    const systems: string[] = [];
    const toolNames: string[][] = [];
    const model = new MockLanguageModelV3({
        doGenerate: async (options) => {
            prompts.push(JSON.stringify(options.prompt));
            const sys = options.prompt.find((m) => m.role === "system");
            systems.push(sys && typeof sys.content === "string" ? sys.content : "");
            toolNames.push((options.tools ?? []).map((t) => t.name));
            const next = calls[i++];
            if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
            return { content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
        },
    });
    return { model, prompts, systems, toolNames };
}

/** The tool results the model got back, in order (the snapshots after each action). */
function toolResults(promptJson: string): string[] {
    const msgs = JSON.parse(promptJson) as Array<{ role: string; content: unknown }>;
    const out: string[] = [];
    for (const m of msgs) if (m.role === "tool" && Array.isArray(m.content)) for (const part of m.content as Array<{ output?: { value?: unknown } }>) out.push(JSON.stringify(part.output?.value ?? part.output));
    return out;
}

const emptyModel = (url: string): AppModel => ({
    url, origin: url, siteType: "ecommerce", purpose: "demo", features: [], pages: [], navigation: [], apis: [], journeys: [],
    authentication: { required: false, mechanisms: [], loggedIn: false }, externalDependencies: [], documentedTestCases: [],
    stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
});

async function author(o: { setting: "on" | "off"; base: string; calls: Call[]; scenario: ReturnType<typeof ScenarioSchema.parse>; credentials?: { username: string; password: string } }) {
    const s = scripted(o.calls);
    const events: EngineEvent[] = [];
    const actions: string[] = [];
    const ctx: EngineContext = {
        config: loadConfig({ LLM_COMPACT_SNAPSHOTS: o.setting }),
        emit: (e) => events.push(e),
        llm: { modelName: "scripted", model: s.model, usage: { inputTokens: 0, outputTokens: 0 }, object: async () => ({}) as never, text: async () => "" },
    };
    const out = await authorWebSpec({ ctx, browser, baseUrl: o.base, model: emptyModel(o.base), scenario: o.scenario, ...(o.credentials ? { credentials: o.credentials } : {}), onAction: (a) => actions.push(`${a.tool}:${a.ok}`) });
    const sent = s.prompts.reduce((a, p) => a + p.length, 0);
    return { out, events, actions, sent, ...s };
}

const loginScenario = ScenarioSchema.parse({
    scenarioId: "S-001", title: "Login succeeds with valid credentials", description: "A registered user logs in", category: "Authentication", priority: "critical",
    startPath: "/login", expectedResults: ["Account page greets the user"], requiresAuth: true,
});
const creds = { username: "demo@example.com", password: "Password123!" };
const loginCalls: Call[] = [
    { tool: "fill", input: { target: { by: "label", value: "Email" }, value: "{{credentials.username}}" } },
    { tool: "click", input: { target: { by: "role", role: "button", value: "Nonexistent" } } },
    { tool: "fill", input: { target: { by: "label", value: "Password" }, value: "{{credentials.password}}" } },
    { tool: "click", input: { target: { by: "role", role: "button", value: "Log in" } } },
    { tool: "assert", input: { check: "visible", target: { by: "role", role: "heading", value: "Welcome, Demo User" } } },
    { tool: "assert", input: { check: "url", expected: "/account" } },
    { tool: "finish", input: { result: "complete", explanation: "Logged in" } },
];

describe("smaller page snapshots in the authoring agent", () => {
    it("writes the same sign-in test on the sample app with fewer characters sent", async () => {
        const off = await author({ setting: "off", base: SAMPLE, calls: loginCalls, scenario: loginScenario, credentials: creds });
        const on = await author({ setting: "on", base: SAMPLE, calls: loginCalls, scenario: loginScenario, credentials: creds });

        expect(off.out.status).toBe("complete");
        expect(on.out.status).toBe("complete");
        expect(on.out.steps).toEqual(off.out.steps);
        const script = (o: typeof on) => renderScript(TestSpecSchema.parse(toSpec(loginScenario, o.out, "WEB-001")), "playwright", { baseUrl: SAMPLE }).content;
        expect(script(on)).toBe(script(off));
        expect(on.actions).toEqual(off.actions);

        // Off: exactly the agent of before (no note, no extra tool, the raw snapshot with its address lines).
        expect(off.systems[0]).not.toContain(COMPACT_SNAPSHOT_NOTE.trim().slice(0, 40));
        expect(off.toolNames[0]).not.toContain("seeWholePage");
        expect(off.prompts[0]).toContain("- /url: /products");
        expect(off.events.some((e) => e.kind === EVENT_SNAPSHOT_SAVINGS)).toBe(false);
        // On: the note, the tool, compact first snapshot, then only what changed.
        expect(on.systems[0]).toContain(COMPACT_SNAPSHOT_NOTE.trim().slice(0, 40));
        expect(on.toolNames[0]).toContain("seeWholePage");
        expect(on.prompts[0]).toContain('link \\"Products\\" [url=/products]');
        const results = toolResults(on.prompts[on.prompts.length - 1]!);
        expect(results[0]).toContain("changed:");
        expect(results[0]).toContain("demo@example.com");
        expect(results[1]).toContain("nothing changed since your last look");

        const offResults = toolResults(off.prompts[off.prompts.length - 1]!).join("").length;
        const onResults = results.join("").length;
        const ev = on.events.find((e) => e.kind === EVENT_SNAPSHOT_SAVINGS)!;
        console.log(
            `sample app sign-in: whole prompts over ${on.prompts.length} model steps ${off.sent} → ${on.sent} characters (about ${Math.ceil(off.sent / 4)} → ${Math.ceil(on.sent / 4)} tokens, ${Math.round((1 - on.sent / off.sent) * 100)}% fewer); ` +
                `tool results (snapshots) in the last step ${offResults} → ${onResults} characters; event: ${ev.message}`,
        );
        expect(on.sent).toBeLessThan(off.sent);
        expect(ev.data).toMatchObject({ kind: "web", snapshots: 7, wholePage: 0 });
    }, 120_000);

    it("lets the model see the whole page, finds a collapsed item, and keeps the test the same on a long catalog", async () => {
        const scenario = ScenarioSchema.parse({
            scenarioId: "S-002", title: "Find a product and filter the catalog", description: "A shopper looks for a product deep in the list", category: "Catalog", priority: "medium",
            startPath: "/", expectedResults: ["The 40th product is listed", "The search box keeps the typed word"],
        });
        const calls: Call[] = [
            { tool: "seeWholePage", input: {} },
            { tool: "assert", input: { check: "visible", target: { by: "role", role: "link", value: "Sleeping Pad 5" } } },
            { tool: "fill", input: { target: { by: "role", role: "textbox", value: "Search the catalog" }, value: "mug" } },
            { tool: "check", input: { target: { by: "role", role: "checkbox", value: "In stock only" }, checked: true } },
            { tool: "assert", input: { check: "value", target: { by: "role", role: "textbox", value: "Search the catalog" }, expected: "mug" } },
            { tool: "assert", input: { check: "count", target: { by: "role", role: "button", value: "Add to cart" }, expected: 40 } },
            { tool: "finish", input: { result: "complete", explanation: "Found and filtered" } },
        ];
        const off = await author({ setting: "off", base: CATALOG, calls: calls.slice(1), scenario });
        // The model acts on the 40th product from the collapsed line alone (its exact role and name are there) ...
        const on = await author({ setting: "on", base: CATALOG, calls: calls.slice(1), scenario });
        // ... or asks for the whole page first.
        const look = await author({ setting: "on", base: CATALOG, calls, scenario });
        for (const r of [off, on, look]) expect(r.out.status).toBe("complete");
        expect(on.out.steps).toEqual(off.out.steps);
        expect(look.out.steps).toEqual(off.out.steps);
        expect(on.actions).toEqual(off.actions);
        expect(look.actions[0]).toBe("seeWholePage:true");
        expect(look.actions.slice(1)).toEqual(off.actions);

        // The opening snapshot was compact: the 40th product only on the collapsed line.
        expect(on.prompts[0]).toContain("37 more article like the 3 above");
        expect(on.prompts[0]).toContain('link \\"Sleeping Pad 5\\"');
        expect(on.prompts[0]).not.toContain("- /url: /product/40");
        // After typing: only the changed textbox.
        const results = toolResults(on.prompts[on.prompts.length - 1]!);
        expect(results[1]).toContain("changed:");
        expect(results[1]).toContain("mug");
        // The whole page: untouched (the collapsed product is there with its own lines).
        const lookResults = toolResults(look.prompts[look.prompts.length - 1]!);
        expect(lookResults[0]).toContain('link \\"Sleeping Pad 5\\":');
        expect(lookResults[0]).toContain("- /url: /product/40");

        const pct = (a: number, b: number) => Math.round((1 - b / a) * 100);
        const ev = on.events.find((e) => e.kind === EVENT_SNAPSHOT_SAVINGS)!;
        const lookEv = look.events.find((e) => e.kind === EVENT_SNAPSHOT_SAVINGS)!;
        console.log(
            `catalog: whole prompts over ${on.prompts.length} model steps ${off.sent} → ${on.sent} characters (about ${Math.ceil(off.sent / 4)} → ${Math.ceil(on.sent / 4)} tokens, ${pct(off.sent, on.sent)}% fewer); event: ${ev.message}. ` +
                `With one whole-page look (${look.prompts.length} steps): ${look.sent} characters (${pct(off.sent, look.sent)}% fewer than without the setting); event: ${lookEv.message}`,
        );
        expect(on.sent).toBeLessThan(off.sent * 0.6);
        expect(look.sent).toBeLessThan(off.sent);
        expect(ev.data).toMatchObject({ wholePage: 0 });
        expect(lookEv.data).toMatchObject({ wholePage: 1 });
    }, 120_000);
});
