/**
 * Settings, Quality of the AI tester, with benchmark runs (web/src/features/eval/Benchmark.tsx): the run list shows the seeded-defect
 * headline instead of the stability numbers, the detail shows the configuration, the numbers, every seeded defect (found or missed) and every
 * finding with its result and a link to its test, and the comparison with the previous benchmark run names the moved benchmark numbers.
 * Accessible (axe) in light and dark, and fits a phone. The runs are kept through the real route (POST /api/eval/runs).
 *
 * Port 9476. Needs web/dist. Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/bench-report-ui.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { headlineOf } from "../src/eval/bench/controller.js";
import { benchMetrics, categorize, combineMetrics } from "../src/eval/bench/metrics.js";
import type { BenchFinding, Benchmark } from "../src/eval/bench/schema.js";
import { overallOf } from "../src/eval/metrics.js";
import type { EvalRun } from "../src/eval/run.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

const PORT = 9476;
const BASE = `http://127.0.0.1:${PORT}`;
const hasUi = fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"));

const f = (testKey: string, title: string, replay: BenchFinding["replay"], source: BenchFinding["source"] = "check"): BenchFinding => ({ id: `t-${testKey}`, testKey, title, source, replay, ...categorize(replay), firstSeenAt: "2026-11-14T10:03:00.000Z" });

function benchRun(startedAt: string, found: boolean): EvalRun {
    const findings = [
        ...(found ? [f("WEB-004", "Cart total equals the sum of its lines", { seeded: "failed", clean: "passed", single: { "BS-01": "failed", "BS-02": "passed" } }, "validation")] : []),
        f("API-029", "Browser security headers are set (/)", { seeded: "finding", clean: "finding", single: {} }),
        f("WEB-009", "Checkout cannot skip the address step", { seeded: "passed", clean: null, single: {} }, "authoring"),
    ];
    const metrics = benchMetrics({ seeded: ["BS-01", "BS-02"], findings, startedAt, cost: 0, testsGenerated: 30, workflows: 7, workflowsCovered: 5, executionFailures: 2, flaky: 1, durationMs: 1_800_000, aiCalls: 400, inputTokens: 3_000_000, outputTokens: 90_000, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const benchmark: Benchmark = {
        format: 1,
        mode: "discovery",
        baseline: !found,
        config: {
            engineCommit: "d4e5e96aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            engineDirty: false,
            prompts: [],
            model: { provider: "openai-compatible", model: "vendor/model:free", fastModel: null, planningModel: null, temperature: "not set by the engine (provider default)" },
            catalogueVersion: "2026-11-14.1 (abcdefabcdef)",
            apps: [{ id: "bench-shop", version: "0123456789abcdef" }],
            options: { level: "everything", allowMutatingApiTests: true },
            prices: [{ model: "vendor/model:free", inputPerMTok: 0, outputPerMTok: 0, note: "free" }],
            approvedBudget: 0,
            dailyCallCap: 1000,
            resumes: 0,
            runtime: { node: "v24", platform: "linux-x64" },
        },
        apps: [
            {
                id: "bench-shop",
                entryId: "bench-shop",
                projectId: "p1",
                status: "done",
                appVersion: "0123456789abcdef",
                seededDefects: ["BS-01", "BS-02"],
                defects: [
                    { id: "BS-01", category: "calculation", workflow: "Cart", severity: "high", detected: found, labeledOnly: false, findings: found ? ["WEB-004"] : [] },
                    { id: "BS-02", category: "validation", workflow: "Registration", severity: "medium", detected: false, labeledOnly: false, findings: [] },
                ],
                findings,
                metrics,
            },
        ],
        metrics: combineMetrics([metrics]),
        notes: [],
    };
    return { format: 1, corpus: "benchmark-discovery", startedAt, finishedAt: new Date(Date.parse(startedAt) + 1_800_000).toISOString(), repeat: 1, planOnly: false, platform: { mode: "in-process", model: "vendor/model:free" }, entries: [], overall: { ...overallOf([]), benchmark: headlineOf(benchmark) }, benchmark };
}

let tmp: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser | undefined;
let page: Page;

beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-bench-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: tmp, LLM_PROVIDER: "anthropic", SECRET_KEY: "test-secret-key-0123456789" }));
    server = await buildServer(platform);
    for (const run of [benchRun("2026-11-13T10:00:00.000Z", false), benchRun("2026-11-14T10:00:00.000Z", true)]) {
        const r = await server.inject({ method: "POST", url: "/api/eval/runs", payload: run });
        expect(r.statusCode, r.body).toBe(201);
    }
    await server.listen({ port: PORT, host: "127.0.0.1" });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe("benchmark runs in Settings, Quality", () => {
    it("the route keeps them and compares the benchmark numbers with the previous benchmark run", async () => {
        const list = (await server.inject({ method: "GET", url: "/api/eval/runs" })).json() as { runs: Array<{ comparison: { overall: Array<{ metric: string; change: string }> } | null }> };
        const newest = list.runs[0]!.comparison!.overall;
        expect(newest.find((c) => c.metric === "benchmark.detectionRate")?.change).toBe("better");
        expect(newest.find((c) => c.metric === "benchmark.precision")?.change).toBe("better");
    });

    it.skipIf(!hasUi)("shows the headline, the defects and findings with links to their tests; accessible in both themes and on a phone", async () => {
        browser = await chromium.launch();
        page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
        await page.goto(`${BASE}/#/settings?section=usage`);
        const panel = page.getByTestId("quality-panel");
        const rows = panel.getByTestId("eval-run");
        await pwExpect(rows).toHaveCount(2);
        // The headline of a benchmark run is its seeded-defect numbers.
        await pwExpect(rows.first().getByTestId("bench-detectionRate")).toHaveText("50%");
        await pwExpect(rows.nth(1).getByTestId("bench-detectionRate")).toHaveText("0%");
        await pwExpect(rows.first().getByTestId("eval-stable")).toHaveCount(0);
        await rows.first().locator("summary").click();
        const detail = rows.first().getByTestId("bench-detail");
        await pwExpect(detail).toContainText("Found 1 of 2 seeded defects");
        await pwExpect(detail).toContainText("vendor/model:free");
        await detail.getByText("bench-shop: found 1 of 2").click();
        await pwExpect(detail.getByRole("table", { name: "Seeded defects of bench-shop" })).toContainText("BS-01");
        await pwExpect(detail.getByRole("table", { name: "Seeded defects of bench-shop" })).toContainText("Missed");
        const findings = detail.getByRole("list", { name: "Findings of bench-shop" });
        await pwExpect(findings).toContainText("Confirmed");
        await pwExpect(findings).toContainText("False positive");
        await pwExpect(findings).toContainText("Not reproduced");
        await pwExpect(findings.getByRole("link", { name: "Cart total equals the sum of its lines" })).toHaveAttribute("href", "#/tests/t-WEB-004");
        await pwExpect(rows.first().getByTestId("eval-changes")).toContainText("Seeded defects found");
        for (const scheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.waitForTimeout(400);
            const result = await new AxeBuilder({ page }).include('[data-testid="quality-panel"]').analyze();
            expect(result.violations.map((v) => `${v.id}: ${v.help} (${v.nodes[0]?.html.slice(0, 120)})`), scheme).toEqual([]);
        }
        await page.emulateMedia({ colorScheme: "light" });
        await page.setViewportSize({ width: 375, height: 800 });
        await pwExpect(panel).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    }, 120_000);
});
