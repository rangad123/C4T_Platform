/**
 * Functional security checks (Phase 4 C11) on the real bench apps, each generated, rendered and run as the platform runs a saved test:
 *  - BS-20 (bench-shop 8.6): the answers captured while a scripted writer (a model double) saves the Account page hold the password; the
 *    saved test made from them fails on the seeded shop and passes on the clean one, where nothing is found to begin with.
 *  - BR-09 (bench-rbac 2.14): the bounded rate-limit check, made from the stated limit only, fails without the limit and passes with it,
 *    and the shared test account still signs in afterwards (the attempts went to a fresh account).
 *  - BR-10 (bench-rbac 3.15): the stored-injection variant of a written "new note" workflow fails where the title becomes markup.
 * The bench servers run on loopback ports and are stopped by this test.
 *
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/security-functional.test.ts
 */
import fs from "node:fs";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import type { DraftSpec } from "../src/engine/api/test-specs.js";
import type { EngineContext } from "../src/engine/context.js";
import { launchChromium } from "../src/engine/discovery/browser.js";
import { renderScript } from "../src/engine/generators/index.js";
import { RATE_LIMIT_MAX_ATTEMPTS, rateLimitSpec, sensitiveFieldSpecs, sensitiveFields, storedInjectionSpec, type StatedRequirement } from "../src/engine/security/functional.js";
import { ScenarioSchema, TestSpecSchema, type Step } from "../src/engine/spec/schema.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { runScripts } from "../src/engine/validation/runner.js";
import { authorWebSpec } from "../src/engine/web/author.js";
import { startBenchApp, type RunningBenchApp } from "../src/eval/bench/verify/app.js";

const ROOT = path.resolve(__dirname, "..");
const PORT = 9781;
const alice = { username: "alice@example.test", password: "Password1!" };
const ana = { username: "ana@example.test", password: "Password1!" };
let app: RunningBenchApp | undefined;
let browser: Browser;
async function bench(name: "bench-shop" | "bench-rbac", defects: string): Promise<string> {
    await app?.stop();
    app = await startBenchApp(name, PORT, defects);
    return app.base;
}
beforeAll(async () => {
    browser = await launchChromium(true);
}, 60_000);
afterAll(async () => {
    await browser?.close();
    await app?.stop();
});

/** The requirement as the app's own requirements document states it. */
function requirement(appName: string, id: string): StatedRequirement {
    const doc = fs.readFileSync(path.join(ROOT, "examples", appName, "requirements", "requirements.md"), "utf8");
    const line = doc.split("\n").find((l) => l.startsWith(`- ${id} `));
    if (!line) throw new Error(`no requirement ${id} in ${appName}`);
    return { id, text: line.slice(`- ${id} `.length) };
}

/** The saved test rendered and run as the platform runs it: "passed" or "failed". */
async function runSpec(draft: DraftSpec, base: string, credentials: { username: string; password: string }): Promise<{ status: string; error?: string }> {
    const spec = TestSpecSchema.parse({ ...draft, testId: draft.kind === "api" ? "API-901" : "WEB-901" });
    const r = renderScript(spec, draft.kind === "api" ? "playwright-api" : "playwright", { baseUrl: base });
    const [res] = await runScripts(loadConfig({}).scratchDir, [{ testId: spec.testId, filename: r.filename, content: r.content }], { baseUrl: base, apiBaseUrl: base, headless: true, credentials, cleanup: "off", riskyChecks: "bench" }, { workers: 1 });
    return res!;
}

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
const label = (value: string) => ({ by: "label", value });
const role = (r: string, value: string) => ({ by: "role", role: r, value });
const saveAccount = (): Call[] => [
    { tool: "fill", input: { target: label("Email"), value: "{{credentials.username}}" } },
    { tool: "fill", input: { target: label("Password"), value: "{{credentials.password}}" } },
    { tool: "click", input: { target: role("button", "Sign in") } },
    { tool: "wait", input: { until: "visible", target: role("button", "Sign out") } },
    { tool: "navigate", input: { url: "/account" } },
    { tool: "fill", input: { target: label("Default delivery address"), value: `${Date.now()} Quay Road, Hull` } },
    { tool: "click", input: { target: role("button", "Save") } },
    { tool: "assert", input: { check: "visible", expected: "Saved.", source: "expected:1" } },
    { tool: "finish", input: { result: "complete", explanation: "done" } },
];
async function captured(base: string) {
    const ctx: EngineContext = {
        config: loadConfig({}),
        emit: () => undefined,
        llm: { modelName: "scripted", model: scripted(saveAccount()), usage: { inputTokens: 0, outputTokens: 0 }, object: async () => ({}) as never, text: async () => "VERDICT: NO" },
    };
    const model: AppModel = {
        url: base, origin: base, siteType: "ecommerce", purpose: "shop", features: [], pages: [], navigation: [], journeys: [],
        apis: ["/api/profile", "/api/orders", "/api/cart"].map((p) => ({ method: "GET", path: p, origin: base, statuses: [200], queryParams: [], source: "openapi" as const, usedIn: [] })),
        authentication: { required: true, mechanisms: [], loggedIn: false }, externalDependencies: [], documentedTestCases: [],
        stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 3, durationMs: 0 },
    };
    const scenario = ScenarioSchema.parse({ scenarioId: "S-ACC", title: "Save account details", description: "Customer flow", category: "Account", startPath: "/login", expectedResults: ["The saved address is the account's from then on (requirement 7.3)"], requirements: ["7.3"] });
    const out = await authorWebSpec({ ctx, browser, baseUrl: base, model, scenario, credentials: alice, requirementIds: ["7.3"], allowPurchases: true });
    expect(out.status, out.explanation).toBe("complete");
    return out.status === "blocked" ? [] : (out.calls ?? []);
}

describe("BS-20: sensitive fields in captured answers", () => {
    it("the Account page's answers hold the password on the seeded shop; its saved test fails there and passes clean", async () => {
        const seededCalls = await captured(await bench("bench-shop", "BS-20"));
        const hits = sensitiveFields(seededCalls);
        expect(hits).toEqual([expect.objectContaining({ method: "GET", path: "/api/profile", fields: ["password"] })]);
        // Captured answers are masked: the password itself is never in them or in the test.
        const specs = sensitiveFieldSpecs(hits, [requirement("bench-shop", "8.6")]);
        expect(JSON.stringify({ seededCalls, specs })).not.toContain(alice.password);
        expect(specs).toHaveLength(1);
        expect((await runSpec(specs[0]!, app!.base, alice)).status).toBe("failed");

        const clean = await bench("bench-shop", "none");
        expect(sensitiveFields(await captured(clean))).toEqual([]);
        const r = await runSpec(specs[0]!, clean, alice);
        expect(r.status, r.error).toBe("passed");
    }, 300_000);
});

describe("BR-09: the bounded rate-limit check from requirement 2.14", () => {
    it("fails without the limit, passes with it, and the shared test account still signs in afterwards", async () => {
        const req = requirement("bench-rbac", "2.14");
        const seeded = await bench("bench-rbac", "BR-09");
        const apis = parseOpenApi(await (await fetch(`${seeded}/openapi.json`)).json(), `${seeded}/openapi.json`).operations;
        const { spec, skipped } = rateLimitSpec({ apis, requirements: [requirement("bench-rbac", "2.13"), req], gate: true });
        expect(skipped).toBeUndefined();
        expect(spec!.steps.filter((s) => s.action === "request" && s.path === "/api/login").length).toBeLessThanOrEqual(RATE_LIMIT_MAX_ATTEMPTS);
        expect(JSON.stringify(spec)).not.toContain("credentials.");
        // Without the stated limit there is no check at all.
        expect(rateLimitSpec({ apis, requirements: [requirement("bench-rbac", "2.13")], gate: true }).spec).toBeUndefined();

        expect((await runSpec(spec!, seeded, ana)).status).toBe("failed");
        const clean = await bench("bench-rbac", "none");
        const r = await runSpec(spec!, clean, ana);
        expect(r.status, r.error).toBe("passed");
        const after = await fetch(`${clean}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: ana.username, password: ana.password }) });
        expect(after.status).toBe(200);
    }, 300_000);
});

describe("BR-10: stored injection in a written workflow", () => {
    const workflow: Step[] = [
        { action: "navigate", url: "/login", description: "Open the sign-in page" },
        { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}", description: "Fill the email" },
        { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}", description: "Fill the password" },
        { action: "click", locator: { by: "role", role: "button", value: "Sign in" }, description: "Sign in" },
        { action: "wait", ms: 0, until: "url", value: "/notes", description: "Wait for the notes" },
        { action: "navigate", url: "/notes/new", description: "Open a new note" },
        { action: "fill", locator: { by: "label", value: "Title" }, value: "Groceries", description: "Fill the title" },
        { action: "fill", locator: { by: "label", value: "Text" }, value: "Milk and bread", description: "Fill the text" },
        { action: "click", locator: { by: "role", role: "button", value: "Save note" }, description: "Save the note" },
        { action: "wait", ms: 0, until: "url", value: "/notes/n", description: "Wait for the note's page" },
        { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Groceries" }, source: "expected:1", description: "The note is shown" },
    ] as Step[];
    // What the written test's actions caused, as authoring captures it (web/correlation.ts CapturedCall).
    const calls = [{ step: 8, method: "POST", path: "/api/notes", status: 201, body: '{"id":"n5","title":"Groceries"}' }];

    it("the marker becomes an element on the seeded app, and stays text on the clean one", async () => {
        const spec = storedInjectionSpec({ title: "New note", steps: workflow, calls, requirements: [requirement("bench-rbac", "3.15")], dataChanges: true });
        expect(spec?.source).toEqual({ origin: "security-check", requirements: ["3.15"] });
        expect((await runSpec(spec!, await bench("bench-rbac", "BR-10"), ana)).status).toBe("failed");
        const r = await runSpec(spec!, await bench("bench-rbac", "none"), ana);
        expect(r.status, r.error).toBe("passed");
        // The plain workflow passes on both: the marker, not the workflow, is what fails.
        expect((await runSpec({ ...spec!, steps: workflow }, await bench("bench-rbac", "BR-10"), ana)).status).toBe("passed");
    }, 300_000);
});
