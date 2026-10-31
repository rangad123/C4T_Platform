/**
 * Integration test of the non-LLM half of the pipeline against a real local app:
 *   canonical spec → render → execute with Playwright → parse result
 *   OpenAPI discovery → API spec generation → render → execute
 * The web specs below are hand-written *fixtures for the renderer/runner* (the LLM-authored path
 * is exercised by scripts/e2e.ts with real credentials).
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { request } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { generateApiSpecs } from "../src/engine/api/test-specs.js";
import { probeOpenApi } from "../src/engine/api/openapi.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { runScripts } from "../src/engine/validation/runner.js";

const PORT = 5071;
const BASE = `http://127.0.0.1:${PORT}`;
let app: ChildProcess;

beforeAll(async () => {
    app = spawn(process.execPath, [path.join(REPO_ROOT, "examples/sample-app/server.mjs"), String(PORT)], { stdio: "ignore" });
    for (let i = 0; i < 40; i++) {
        try {
            if ((await fetch(BASE + "/")).ok) return;
        } catch {
            await new Promise((r) => setTimeout(r, 150));
        }
    }
    throw new Error("sample app did not start");
}, 20_000);
afterAll(() => app?.kill());

const cfg = loadConfig({});
const env = { baseUrl: BASE, credentials: { username: "demo@example.com", password: "Password123!" }, apiToken: "demo-token-123", headless: true };

const loginOk: TestSpec = TestSpecSchema.parse({
    testId: "WEB-001",
    title: "Login succeeds with valid credentials",
    kind: "web",
    category: "Authentication",
    priority: "critical",
    steps: [
        { action: "navigate", url: "/login" },
        { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}" },
        { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" },
        { action: "click", locator: { by: "role", role: "button", value: "Log in" } },
        { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Welcome, Demo User" } },
        { action: "assert", check: "url", expected: "/account" },
    ],
    expectedResults: ["Account page is displayed"],
});

const loginBad: TestSpec = TestSpecSchema.parse({
    testId: "WEB-002",
    title: "Login fails with a wrong password",
    kind: "web",
    category: "Authentication",
    type: "negative",
    steps: [
        { action: "navigate", url: "/login" },
        { action: "fill", locator: { by: "label", value: "Email" }, value: "demo@example.com" },
        { action: "fill", locator: { by: "label", value: "Password" }, value: "wrong-{{unique}}" },
        { action: "click", locator: { by: "role", role: "button", value: "Log in" } },
        { action: "assert", check: "visible", expected: "Invalid email or password" },
    ],
});

const brokenLocator: TestSpec = TestSpecSchema.parse({
    testId: "WEB-003",
    title: "Deliberately wrong locator must FAIL validation",
    kind: "web",
    steps: [
        { action: "navigate", url: "/products" },
        { action: "click", locator: { by: "role", role: "button", value: "Nonexistent button" } },
    ],
});

describe("deterministic pipeline", () => {
    it("renders runnable Playwright for web specs and reports real pass/fail with the failing step", async () => {
        const scripts = [loginOk, loginBad, brokenLocator].map((s) => {
            const r = renderScript(s, "playwright", { baseUrl: BASE });
            return { testId: s.testId, filename: r.filename, content: r.content };
        });
        const runs = await runScripts(cfg.scratchDir, scripts, env, { workers: 2 });
        const by = Object.fromEntries(runs.map((r) => [r.testId, r]));
        expect(by["WEB-001"]!.status).toBe("passed");
        expect(by["WEB-002"]!.status).toBe("passed");
        expect(by["WEB-003"]!.status).toBe("failed");
        expect(by["WEB-003"]!.failedStepIndex).toBe(1);
        expect(by["WEB-003"]!.error).toMatch(/Nonexistent button|Timeout/i);
        // failures keep a screenshot, trace, video and the page's network/console evidence; passing runs keep none
        expect(by["WEB-003"]!.artifacts.map((a) => a.kind).sort()).toEqual(["evidence", "screenshot", "trace", "video"]);
        expect(by["WEB-001"]!.artifacts).toEqual([]);
    }, 120_000);

    it("never embeds credentials in rendered scripts", () => {
        const { content } = renderScript(loginOk, "playwright", { baseUrl: BASE });
        expect(content).not.toContain("Password123!");
        expect(content).toContain("process.env.TEST_PASSWORD");
    });

    it("discovers the OpenAPI document, generates API specs and they validate", async () => {
        const ctx = await request.newContext();
        const found = await probeOpenApi(ctx, BASE);
        await ctx.dispose();
        expect(found).not.toBeNull();
        expect(found!.parsed.operations.map((o) => `${o.method} ${o.path}`)).toContain("GET /api/products/{id}");

        const { specs, skippedMutating } = generateApiSpecs(found!.parsed.operations, { allowMutating: false, maxPerEndpoint: 6 });
        expect(skippedMutating).toBe(1); // POST /api/login skipped in safe mode
        expect(specs.length).toBeGreaterThan(4);

        const full = specs.map((d, i) => TestSpecSchema.parse({ ...d, testId: `API-${String(i + 1).padStart(3, "0")}` }));
        const scripts = full.map((s) => {
            const r = renderScript(s, "playwright-api", { baseUrl: BASE });
            return { testId: s.testId, filename: r.filename, content: r.content };
        });
        const runs = await runScripts(cfg.scratchDir, scripts, env, { workers: 3 });
        const failed = runs.filter((r) => r.status !== "passed").map((r) => `${r.testId} ${full.find((s) => s.testId === r.testId)!.title}: ${r.error?.slice(0, 200)}`);
        expect(failed).toEqual([]);
    }, 120_000);

    it("renders the same spec for Taqwright (mobile) without executing it", () => {
        const r = renderScript(loginOk, "taqwright", { baseUrl: BASE });
        expect(r.content).toContain('from "@taqwright/taqwright"');
        expect(r.content).toContain("mobile.getByLabel");
    });
});
