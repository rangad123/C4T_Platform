/**
 * Reliability and evidence with Playwright 1.65, against a local site (never a real model: scripted doubles only):
 * service workers are blocked so routes see every request; a new test that passed must pass its repeat runs; the failure's
 * accessibility snapshot reaches the repair prompt; a test linked to an open bug renders as test.fail() and says when the bug
 * seems fixed; Playwright's own global time limit keeps the report; a blocked authoring session keeps its trace.
 */
import fs from "node:fs";
import http from "node:http";
import { MockLanguageModelV3 } from "ai/test";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext, EngineEvent } from "../src/engine/context.js";
import { BrowserSession, launchChromium } from "../src/engine/discovery/browser.js";
import { proposeHeal } from "../src/engine/healing/heal.js";
import { playwrightGenerator } from "../src/engine/generators/playwright.js";
import { LEVEL_SETTINGS } from "../src/engine/levels.js";
import { ScenarioSchema, TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { triage } from "../src/engine/validation/repair.js";
import { KNOWN_BUG_FIXED, runScripts, withGlobalTimeout } from "../src/engine/validation/runner.js";
import { classifyFailedRun, validateBatch } from "../src/engine/validation/validator.js";
import { AUTHORING_TRACES, authorWebSpec, pruneAuthoringTraces } from "../src/engine/web/author.js";
import os from "node:os";
import path from "node:path";

const PORT = 9330;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = "s3cret-Passw0rd";
let server: http.Server;
let browser: Browser;
let loads = 0;

// The page registers a service worker that answers /api/data itself; the server's own answer echoes the Authorization header.
const SW_PAGE = `<!doctype html><title>SW</title><h1>Service worker</h1><p id="out"></p><script>
(async () => {
  const sw = navigator.serviceWorker;
  const ready = sw ? await Promise.race([sw.register("/sw.js").then(() => sw.ready).catch(() => null), new Promise((r) => setTimeout(() => r(null), 3000))]) : null;
  if (ready && !sw.controller) await new Promise((r) => { sw.addEventListener("controllerchange", r); setTimeout(r, 3000); });
  document.getElementById("out").textContent = await (await fetch("/api/data")).text();
})();
</script>`;
const SW = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => { if (new URL(e.request.url).pathname === "/api/data") e.respondWith(new Response("from-sw")); });`;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const html = (body: string) => (res.writeHead(200, { "content-type": "text/html; charset=utf-8" }), res.end(body));
        if (req.url === "/sw.js") return res.writeHead(200, { "content-type": "text/javascript" }), res.end(SW);
        if (req.url === "/api/data") return res.writeHead(200, { "content-type": "text/plain" }), res.end(`from-server auth=${req.headers.authorization ?? "none"}`);
        if (req.url === "/sw") return html(SW_PAGE);
        // Passes on the first load, then fails every second one: a test that passes 1 in 2.
        if (req.url === "/flaky") return html(`<!doctype html><title>Flaky</title><h1>${++loads % 2 === 1 ? "Done" : "Working"}</h1>`);
        if (req.url === "/secret") return html(`<!doctype html><title>Secret</title><h1>Welcome</h1><p>Token ${SECRET}</p><button>Pay now</button>`);
        // Deleting asks for confirmation; only an accepted delete shows the (renamed) "Undo the deletion" button.
        if (req.url === "/confirm") return html(`<!doctype html><title>Item</title><h1>Item</h1><button onclick="if (confirm('Delete it?')) document.getElementById('a').innerHTML='<button>Undo the deletion</button>'">Delete</button><div id="a"></div>`);
        if (req.url === "/fixed") return html(`<!doctype html><title>Cart</title><h1>Cart total 10</h1>`);
        if (req.url === "/buggy") return html(`<!doctype html><title>Cart</title><h1>Cart total 0</h1>`);
        html(`<!doctype html><title>Home</title><h1>Home</h1>`);
    });
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
    browser = await launchChromium(true);
}, 30_000);
afterAll(async () => {
    await browser?.close();
    server?.close();
});

const scratch = () => loadConfig({}).scratchDir;
const spec = (id: string, steps: unknown[], extra: Record<string, unknown> = {}): TestSpec => TestSpecSchema.parse({ testId: id, title: id, kind: "web", category: "Cart", source: { origin: "browser-agent" }, steps, ...extra });
const emptyModel = (url: string): AppModel => ({
    url, origin: url, siteType: "ecommerce", purpose: "demo", features: [], pages: [], navigation: [], apis: [], journeys: [],
    authentication: { required: false, mechanisms: [], loggedIn: false }, externalDependencies: [], documentedTestCases: [],
    stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
});
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
function ctxWith(object: EngineContext["llm"]["object"] = async () => ({}) as never) {
    const events: EngineEvent[] = [];
    const model = new MockLanguageModelV3({ doGenerate: async () => ({ content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] }) });
    const ctx: EngineContext = { config: loadConfig({}), emit: (e) => events.push(e), llm: { modelName: "scripted", model, usage: { inputTokens: 0, outputTokens: 0 }, object, text: async () => "" } };
    return { ctx, events };
}
const script = (testId: string, body: string) => ({ testId, filename: `${testId}.spec.ts`, content: `import { test, expect } from "@playwright/test";\ntest(${JSON.stringify(testId)}, async ({ page }) => {\n${body}\n});\n` });

describe("service workers are blocked", () => {
    it("the site's worker really answers when allowed (control)", async () => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${BASE}/sw`);
        await expect.poll(() => page.textContent("#out"), { timeout: 10_000 }).toBe("from-sw");
        await context.close();
    }, 30_000);

    it("the exploring/authoring session sends the bearer token on the request the worker would have answered", async () => {
        const session = await BrowserSession.launch(browser, { startUrl: BASE, authHeaders: { headers: { Authorization: "Bearer t0ken-r54" }, origins: [BASE] } });
        try {
            await session.page.goto(`${BASE}/sw`);
            await expect.poll(() => session.page.textContent("#out"), { timeout: 10_000 }).toBe("from-server auth=Bearer t0ken-r54");
        } finally {
            await session.close();
        }
    }, 30_000);

    it("a test run's route (as fault runs use) sees the request", async () => {
        const [run] = await runScripts(scratch(), [script("SW-1", `    await page.route("**/api/data", (r) => r.fulfill({ body: "from-route" }));\n    await page.goto(${JSON.stringify(`${BASE}/sw`)});\n    await expect(page.locator("#out")).toHaveText("from-route", { timeout: 10_000 });`)], { baseUrl: BASE, headless: true }, { workers: 1 });
        expect(run!.error).toBeUndefined();
        expect(run!.status).toBe("passed");
    }, 90_000);
});

describe("repeat passes", () => {
    const scenario = ScenarioSchema.parse({ scenarioId: "S-54", title: "Flaky", description: "Open the page", category: "Cart", expectedResults: ["Done"] });
    it("a new test that passes 1 in 2 is flaky, a steady one is validated; the levels set 3, 3 and 5", async () => {
        expect([LEVEL_SETTINGS.thorough.repeatPasses, LEVEL_SETTINGS.deep.repeatPasses, LEVEL_SETTINGS.everything.repeatPasses]).toEqual([3, 3, 5]);
        loads = 0;
        const flaky = spec("WEB-541", [{ action: "navigate", url: "/flaky" }, { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Done" } }]);
        const steady = spec("WEB-542", [{ action: "navigate", url: "/fixed" }, { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Cart total 10" } }]);
        const { ctx } = ctxWith();
        const attempts = new Map<string, number>();
        const outcomes = await validateBatch(
            ctx,
            { browser, scratchDir: ctx.config.scratchDir, env: { baseUrl: BASE, headless: true }, render: { baseUrl: BASE }, model: emptyModel(BASE), maxRepairAttempts: 0, repeatPasses: 3, workers: 1 },
            [flaky, steady].map((s) => ({ spec: s, framework: "playwright" as const, scenario })),
            { onAttempt: async (t, a) => void attempts.set(t.spec.testId, a), onFinal: async () => undefined },
        );
        expect(outcomes[0]!.status).toBe("FAILED_VALIDATION");
        expect(outcomes[0]!.reason).toMatch(/^Flaky: passed 2 of 4 runs\. The failing run stopped at /);
        expect(attempts.get("WEB-541")).toBe(2);
        expect(outcomes[1]!.status).toBe("VALIDATED");
        expect(attempts.get("WEB-542")).toBe(1);
    }, 180_000);
});

describe("failure context", () => {
    it("the aria snapshot at the failing check is read, masked, and reaches the repair prompt; trace and video are kept", async () => {
        const failing = script("CTX-001", `    await page.goto(${JSON.stringify(`${BASE}/secret`)});\n    await expect(page.getByRole("button", { name: "Pay later" })).toBeVisible({ timeout: 2000 });`);
        const [run] = await runScripts(scratch(), [failing], { baseUrl: BASE, headless: true, credentials: { username: "u", password: SECRET } }, { workers: 1 });
        expect(run!.status).toBe("failed");
        expect(run!.errorContext).toContain('button "Pay now"');
        expect(run!.errorContext).not.toContain(SECRET);
        expect(run!.errorContext).toContain("[hidden]");
        expect(run!.artifacts.map((a) => a.kind)).toEqual(expect.arrayContaining(["trace", "video"]));
        const prompts: string[] = [];
        const { ctx } = ctxWith(async (a) => (prompts.push(a.prompt), { category: "locator", fixable: true, reason: "renamed" }) as never);
        await triage(ctx, spec("CTX-001", [{ action: "navigate", url: "/secret" }]), run!);
        expect(prompts[0]).toContain("What the page showed when it failed (accessibility snapshot)");
        expect(prompts[0]).toContain('button "Pay now"');
    }, 90_000);
});

describe("known bugs", () => {
    const tracked = spec("WEB-543", [{ action: "navigate", url: "/buggy" }, { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Cart total 10" } }], { source: { origin: "requirements", scenarioId: "S-7", requirements: ["REQ-12"] } });
    const render = (url: string) => {
        const s = { ...tracked, steps: [{ ...tracked.steps[0]!, url }, tracked.steps[1]!] as TestSpec["steps"] };
        return playwrightGenerator.render(s, { baseUrl: BASE, knownBugs: { "WEB-543": "BUG-9 https://tracker.example/BUG-9" } });
    };
    it("renders test.fail() with the bug, and annotations for its scenario and requirement", () => {
        const out = render("/buggy");
        expect(out.content).toContain('test.fail(true, "Tracks the open bug BUG-9 https://tracker.example/BUG-9");');
        expect(out.content).toContain('annotation: [{"type":"scenario","description":"S-7"},{"type":"requirement","description":"REQ-12"}]');
        expect(playwrightGenerator.render(tracked, { baseUrl: BASE }).content).not.toContain("test.fail(");
    });
    it("stays green while the bug is there, and says it seems fixed when the test passes", async () => {
        const [still, fixed] = await runScripts(scratch(), [{ testId: "WEB-543", ...render("/buggy") }, { testId: "WEB-544", ...render("/fixed"), filename: "WEB-544.spec.ts" }], { baseUrl: BASE, headless: true }, { workers: 2 });
        expect(still!.status).toBe("passed");
        expect(still!.notes?.[0]).toMatch(/^Failed as expected: the bug this test tracks \(Tracks the open bug BUG-9/);
        expect(fixed!.status).toBe("failed");
        expect(fixed!.error).toMatch(new RegExp(`^${KNOWN_BUG_FIXED} \\(Tracks the open bug BUG-9`));
        expect(classifyFailedRun(tracked, fixed!)).toEqual({ status: "FAILED_VALIDATION", reason: fixed!.error });
    }, 90_000);
});

describe("Playwright's global time limit", () => {
    it("sits just under the kill timer", () => {
        expect(withGlobalTimeout("    retries: 0,\n", 40_000)).toBe("    retries: 0,\n    globalTimeout: 36000,\n");
        expect(withGlobalTimeout("    retries: 0,\n", 600_000)).toContain("globalTimeout: 570000,");
    });
    it("stops a run that would be killed, and the report is still complete", async () => {
        const slow = script("SLOW-1", `    await page.goto(${JSON.stringify(BASE)});\n    await page.waitForTimeout(55_000);`);
        const quick = script("QUICK-1", `    await page.goto(${JSON.stringify(BASE)});\n    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();`);
        const [s, q] = await runScripts(scratch(), [slow, quick], { baseUrl: BASE, headless: true }, { workers: 2, timeoutMs: 40_000 });
        expect(q!.status).toBe("passed");
        expect(s!.status).toBe("timedOut");
        expect(s!.error).not.toBe("Validation run exceeded its time limit");
    }, 90_000);
});

describe("authoring trace", () => {
    it("a blocked scenario keeps the session's trace as evidence", async () => {
        const { ctx, events } = ctxWith();
        const scenario = ScenarioSchema.parse({ scenarioId: "S-55", title: "Nothing", description: "Open home", category: "Home", startPath: "/", expectedResults: ["Home"] });
        const out = await authorWebSpec({ ctx, browser, baseUrl: BASE, model: emptyModel(BASE), scenario, maxSteps: 1 });
        expect(out.status).toBe("blocked");
        const trace = out.status === "blocked" ? out.trace : undefined;
        expect(trace && fs.statSync(trace).size).toBeGreaterThan(0);
        expect(events.some((e) => e.kind === "authoring_trace_kept")).toBe(true);
        fs.rmSync(trace!, { force: true });
    }, 60_000);
});

describe("kept authoring traces are cleaned up", () => {
    it("after an hour, and the oldest first once they pass 256 MB together", async () => {
        const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-traces-"));
        const dir = path.join(scratchDir, AUTHORING_TRACES);
        fs.mkdirSync(dir);
        const put = (name: string, mb: number, ageMin: number) => {
            const file = path.join(dir, name);
            fs.writeFileSync(file, "");
            fs.truncateSync(file, mb * 1024 * 1024); // sparse: the size counts, nothing is written
            const t = new Date(Date.now() - ageMin * 60_000);
            fs.utimesSync(file, t, t);
        };
        put("old.zip", 1, 61);
        put("big-1.zip", 150, 30);
        put("big-2.zip", 150, 20);
        put("new.zip", 1, 1);
        await pruneAuthoringTraces(scratchDir);
        expect(fs.readdirSync(dir).sort()).toEqual(["big-2.zip", "new.zip"]);
        fs.rmSync(scratchDir, { recursive: true, force: true });
    });
});

describe("healing replays state-setting steps", () => {
    it("a healed step after a dialog step sees the page as the accepted dialog left it", async () => {
        const healed = spec("WEB-545", [
            { action: "navigate", url: "/confirm" },
            { action: "dialog", response: "accept" },
            { action: "click", locator: { by: "role", role: "button", value: "Delete" } },
            { action: "click", locator: { by: "role", role: "button", value: "Undo deletion", exact: true } },
        ]);
        const error = "locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Undo deletion' })";
        const run = { testId: "WEB-545", status: "failed" as const, durationMs: 1, failedStepIndex: 3, steps: [{ index: 3, title: "4. Click Undo deletion", status: "failed" as const, error }], artifacts: [], responses: [], error };
        const out = await proposeHeal({ browser, baseUrl: BASE, spec: healed, run });
        expect(out.status === "none" ? out.reason : "proposed").toBe("proposed");
        expect(out.status === "proposed" && out.proposal.newLocator).toMatchObject({ by: "role", role: "button", value: "Undo the deletion" });
    }, 60_000);
});
