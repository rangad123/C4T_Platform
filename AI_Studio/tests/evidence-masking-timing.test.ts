/**
 * What the application shows while the AI writes a test is masked before the AI or a record sees it (console, page errors, failed
 * requests, dialogs: discovery/browser.ts with evidence/observed-text.ts), and failure evidence carries each step's time and a read-time
 * outcome view (validation/runner.ts withStepTimes, platform/evidence-read.ts outcomesOf). A scripted model double, a local page, a real
 * browser; no AI provider.
 */
import http from "node:http";
import fs from "node:fs";
import { MockLanguageModelV3 } from "ai/test";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import { BrowserSession, launchChromium } from "../src/engine/discovery/browser.js";
import { sanitizeEvidence, type Evidence } from "../src/engine/evidence/model.js";
import { maskObservedText, observedTextSecrets } from "../src/engine/evidence/observed-text.js";
import { renderScript } from "../src/engine/generators/index.js";
import { ScenarioSchema, TestSpecSchema } from "../src/engine/spec/schema.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { runScripts, withStepTimes } from "../src/engine/validation/runner.js";
import { authorWebSpec } from "../src/engine/web/author.js";
import { outcomesOf } from "../src/platform/evidence-read.js";
import type { Repo } from "../src/platform/repo.js";

const PORT = 9521;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "Pw-main-123";
const TOTP = "JBSWY3DPEHPK3PXP";
const ROLE_TOKEN = "role-api-token-4f2a9c";
const PAGE = `<!doctype html><html><head><title>Shop</title></head><body><h1>Shop</h1><button id="ask">Ask</button>
<script>
console.error("Login failed for the account; secret ${TOTP} and token ${ROLE_TOKEN} and password ${PASSWORD}");
fetch("/api/bad?k=1");
document.getElementById("ask").addEventListener("click", () => alert("Your recovery code is ${TOTP}"));
</script></body></html>`;

let server: http.Server;
let browser: Browser;
beforeAll(async () => {
    server = http.createServer((req, res) => {
        if (req.url?.startsWith("/api/bad")) return res.writeHead(500, { "content-type": "application/json" }).end(`{"error":"${ROLE_TOKEN}"}`);
        res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
    });
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
    browser = await launchChromium(true);
}, 30_000);
afterAll(async () => {
    await browser?.close();
    await new Promise((r) => server?.close(r));
});

const emptyModel: AppModel = {
    url: BASE, origin: BASE, siteType: "ecommerce", purpose: "demo", features: [], pages: [], navigation: [], apis: [], journeys: [],
    authentication: { required: false, mechanisms: [], loggedIn: false }, externalDependencies: [], documentedTestCases: [],
    stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
} as AppModel;
const scenario = ScenarioSchema.parse({ scenarioId: "S-001", title: "Ask for help", description: "A visitor asks", category: "Help", priority: "high", startPath: "/", expectedResults: ["A help answer shows"] });

describe("C-2: observed text is masked before the AI sees it", () => {
    it("the session masks console errors, failed requests and dialog messages with the run's secrets; ordinary words stay", async () => {
        const session = await BrowserSession.launch(browser, { startUrl: BASE, secrets: [PASSWORD, TOTP, ROLE_TOKEN] });
        try {
            await session.page.goto(BASE + "/");
            await session.quiet(800);
            await session.page.click("#ask");
            await session.quiet(500);
            const e = session.takeEvents();
            const all = JSON.stringify([e.problems, e.dialogs.map((d) => d.message)]);
            for (const s of [PASSWORD, TOTP, ROLE_TOKEN]) expect(all, s).not.toContain(s);
            expect(all).toContain("Login failed for the account");
            expect(all).toContain("recovery code");
            expect(e.problems.some((p) => p.includes("/api/bad?…") && p.includes("500"))).toBe(true);
        } finally {
            await session.close();
        }
    }, 60_000);

    it("without secrets the text is still single-line and capped (the earlier shape)", () => {
        expect(maskObservedText("a\n\n b   c", observedTextSecrets([]), 300)).toBe("a b c");
        expect(maskObservedText("x".repeat(500), [], 300).length).toBeLessThanOrEqual(300);
    });

    it("authoring prompts, agent-action observations and the defect verdict never carry a secret the page echoed", async () => {
        const prompts: string[] = [];
        const calls = [
            { tool: "navigate", input: { url: "/" } },
            { tool: "click", input: { target: { by: "role", role: "button", value: "Ask" } } },
            { tool: "finish", input: { result: "defect", explanation: "The help answer never shows" } },
        ];
        let i = 0;
        const model = new MockLanguageModelV3({
            doGenerate: async (options) => {
                prompts.push(JSON.stringify(options.prompt));
                const next = calls[i++];
                const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
                if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
                return { content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
            },
        });
        const verdicts: string[] = [];
        const ctx: EngineContext = {
            config: loadConfig({}),
            emit: () => undefined,
            llm: { modelName: "scripted", model, usage: { inputTokens: 0, outputTokens: 0 }, object: async () => ({}) as never, text: async (a: { prompt: string }) => (verdicts.push(a.prompt), "yes") },
        } as unknown as EngineContext;
        const observations: string[] = [];
        const out = await authorWebSpec({ ctx, browser, baseUrl: BASE, model: emptyModel, scenario, credentials: { username: "u@example.test", password: PASSWORD }, secrets: [TOTP, ROLE_TOKEN], onAction: (a) => observations.push(a.observation) });
        expect(out.status).toBe("defect");
        const seen = JSON.stringify({ prompts, observations, verdicts, evidence: out.status === "defect" ? out.evidence : [] });
        expect(seen).toContain("Login failed for the account");
        for (const s of [PASSWORD, TOTP, ROLE_TOKEN]) expect(seen, s).not.toContain(s);
    }, 90_000);
});

describe("H-5: step timing and the outcome view", () => {
    it("withStepTimes adds ms to the matching evidence steps; sanitizing keeps it, and older evidence without ms still reads", () => {
        const ev = { steps: [{ n: 1, t: 0 }, { n: 2, t: 40 }, { n: 3, t: 90 }] };
        withStepTimes(ev, [
            { index: 0, title: "1. Open /", status: "passed", durationMs: 35 },
            { index: 1, title: "2. Verify", status: "failed", durationMs: 12 },
            { index: 2, title: "3. x", status: "passed" },
        ]);
        expect(ev.steps).toEqual([{ n: 1, t: 0, ms: 35 }, { n: 2, t: 40, ms: 12 }, { n: 3, t: 90 }]);
        const base: Evidence = { v: 1, durationMs: 100, counts: { requests: 0, requestsKept: 0, console: 0, consoleKept: 0 }, steps: ev.steps, requests: [], console: [] };
        const once = sanitizeEvidence(base)!;
        expect(once.steps).toEqual(ev.steps);
        expect(sanitizeEvidence(once)).toEqual(once);
        expect(sanitizeEvidence({ ...base, steps: [{ n: 1, t: 0 }] })!.steps).toEqual([{ n: 1, t: 0 }]);
    });

    it("a real failing run reports each step's time, and its stored evidence has ms for every step, within the test's duration", async () => {
        const spec = TestSpecSchema.parse({ testId: "WEB-901", title: "timing", kind: "web", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "visible", expected: "Not on the page" }] });
        const script = renderScript(spec, "playwright", { baseUrl: BASE });
        const [run] = await runScripts(loadConfig({}).scratchDir, [{ testId: spec.testId, filename: script.filename, content: script.content }], { baseUrl: BASE, headless: true, credentials: { username: "u@example.test", password: PASSWORD, totpSecret: TOTP }, apiToken: ROLE_TOKEN });
        expect(run!.status).toBe("failed");
        for (const st of run!.steps) expect(typeof st.durationMs, st.title).toBe("number");
        const file = run!.artifacts.find((a) => a.kind === "evidence")?.path;
        expect(file).toBeTruthy();
        const stored = JSON.parse(fs.readFileSync(file!, "utf8")) as Evidence;
        const top = stored.steps.filter((s) => s.n >= 1 && s.n <= run!.steps.length);
        expect(top.length).toBe(run!.steps.length);
        for (const s of top) expect(typeof s.ms, `step ${s.n}`).toBe("number");
        expect(top.reduce((a, s) => a + (s.ms ?? 0), 0)).toBeLessThanOrEqual(run!.durationMs + 50);
        expect(JSON.stringify(stored)).not.toContain(ROLE_TOKEN);
    }, 120_000);

    it("outcomesOf joins the version's checks with the step results, the facts in the error, the same step's requests and the artifacts", () => {
        const spec = TestSpecSchema.parse({ testId: "WEB-902", title: "outcome test", kind: "web", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "text", expected: "Total: 10.00" }, { action: "assert", check: "visible", expected: "Thanks" }] });
        const repo = { db: { get: () => undefined }, getTest: () => ({ spec }) } as unknown as Repo;
        const execution = {
            id: "e1", status: "failed", startedAt: "2026-11-14T00:00:00Z",
            steps: [{ index: 0, title: "1. Open /", status: "passed" }, { index: 1, title: "2. Verify text", status: "failed", error: 'Expected: "Total: 10.00"\nReceived: "Total: 12.00"' }],
            artifacts: [{ id: "a1", kind: "screenshot", path: "x" }, { id: "a2", kind: "trace", path: "y" }, { id: "a3", kind: "evidence", path: "z" }, { id: "a4", kind: "video", path: "v", pruned_at: "2026-11-01" }],
        };
        const evidence: Evidence = { v: 1, durationMs: 5, counts: { requests: 2, requestsKept: 2, console: 0, consoleKept: 0 }, steps: [], console: [], requests: [{ t: 1, step: 1, method: "GET", type: "document", path: "/" }, { t: 2, step: 2, method: "GET", type: "fetch", path: "/api/cart", status: 200 }] };
        const out = outcomesOf(repo, "t1", execution, evidence);
        expect(out).toEqual([{ step: 2, assertionId: "step-2", check: "text", expected: "Total: 10.00", actual: "Total: 12.00", passed: false, requests: [1], artifacts: [{ id: "a1", kind: "screenshot" }, { id: "a2", kind: "trace" }] }]);
    });

    it("steps with reusable blocks are not joined to the spec (numbers would not line up): the titles decide, no check is named", () => {
        const spec = TestSpecSchema.parse({ testId: "WEB-903", title: "block test", kind: "web", steps: [{ action: "useBlock", block: "sign-in" }, { action: "assert", check: "visible", expected: "Hi" }] });
        const repo = { db: { get: () => undefined }, getTest: () => ({ spec }) } as unknown as Repo;
        const out = outcomesOf(repo, "t1", { id: "e2", status: "passed", startedAt: "x", steps: [{ index: 0, title: "1. Open /login", status: "passed" }, { index: 3, title: "4. Verify visible of text \"Hi\"", status: "passed" }], artifacts: [] });
        expect(out).toEqual([{ step: 4, assertionId: "step-4", passed: true, requests: [], artifacts: [] }]);
    });
});
