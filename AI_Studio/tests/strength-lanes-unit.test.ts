/**
 * The strength check keeps one lane per account (queue row 189): a test that missed a deliberate fault is written once more in the
 * authoring browser, and its stronger version is run against the application. Tests that sign in as the same account share its
 * state on the server, so neither the rewrites nor the runs of the stronger versions overlap; signed-out tests run beside them.
 * The test writer is a stand-in (vi.mock of ../src/engine/web/author.js) that records when it ran; scripts run on a fake executor.
 * No browser, no AI.
 */
import { describe, expect, it, vi } from "vitest";

type Span = { id: string; lane: string | undefined; start: number; end: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rewrites: Span[] = [];

vi.mock("../src/engine/web/author.js", async (importOriginal) => {
    const original = await importOriginal<typeof import("../src/engine/web/author.js")>();
    return {
        ...original,
        authorWebSpec: async (input: { scenario: { title: string }; resume?: { prefix: Array<Record<string, unknown>> } }) => {
            const prefix = input.resume?.prefix ?? [];
            const span: Span = { id: input.scenario.title, lane: JSON.stringify(prefix).includes("{{credentials.username}}") ? "main" : undefined, start: performance.now(), end: Infinity };
            rewrites.push(span);
            await sleep(40);
            span.end = performance.now();
            // A stronger version: one more check.
            const extra = { action: "assert", check: "visible", locator: { by: "css", value: "#total" }, description: "" };
            return { status: "complete", steps: [...prefix, extra], testData: {}, explanation: "stronger" };
        },
    };
});

const { loadConfig } = await import("../src/config.js");
const { checkStrength } = await import("../src/engine/mutation/strength.js");
const { ScenarioSchema, TestSpecSchema } = await import("../src/engine/spec/schema.js");
import type { EngineContext } from "../src/engine/context.js";
import type { ScriptExecutor } from "../src/engine/frameworks/index.js";
import type { Step } from "../src/engine/spec/schema.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";

const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;
const signIn = [
    { action: "navigate", url: "/login" },
    { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}" },
    { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" },
    { action: "click", locator: { by: "role", role: "button", value: "Sign in" } },
];
const test = (n: number, signsIn: boolean) => {
    const spec = TestSpecSchema.parse({
        testId: `WEB-${String(n).padStart(3, "0")}`,
        title: `Test ${n}`,
        kind: "web",
        steps: [...(signsIn ? signIn : []), { action: "navigate", url: "/cart" }, { action: "assert", check: "text", locator: { by: "css", value: "#total" }, expected: "Total: $25.00" }] as Step[],
    });
    const scenario = ScenarioSchema.parse({ scenarioId: `S-${n}`, title: `Test ${n}`, description: "The cart total", category: "Cart", expectedResults: ["The total is $25.00"] });
    return { spec, validationStatus: "VALIDATED", scenario };
};

describe("the strength check's rewrites and their runs keep one lane per account", () => {
    it("the account's tests are rewritten and run one at a time; signed-out ones beside them", async () => {
        const runs: Span[] = [];
        // Every deliberate fault is missed (the replay passes), so every test is rewritten; the stronger versions pass too.
        const executor: ScriptExecutor = {
            name: "fake",
            async execute(_adapter, batch, _env, opts) {
                const queue = [...batch.scripts];
                const out = new Map<string, ScriptRun>();
                await Promise.all(
                    Array.from({ length: Math.min(opts.workers, queue.length) }, async () => {
                        for (let s = queue.shift(); s; s = queue.shift()) {
                            const span: Span = { id: s.testId, lane: /TEST_USERNAME/.test(s.content) ? "main" : undefined, start: performance.now(), end: Infinity };
                            runs.push(span);
                            await sleep(20);
                            span.end = performance.now();
                            out.set(s.testId, { testId: s.testId, status: "passed", durationMs: 20, failedStepIndex: -1, steps: [], artifacts: [], responses: [] });
                        }
                    }),
                );
                return batch.scripts.map((s) => out.get(s.testId)!);
            },
        };
        const config = loadConfig({ CONCURRENCY: "3" });
        const ctx: EngineContext = { config, llm: { modelName: "scripted" } as never, emit: () => undefined };
        await checkStrength(
            ctx,
            { scratchDir: config.scratchDir, env: { baseUrl: "http://127.0.0.1:1", headless: true }, render: { baseUrl: "http://127.0.0.1:1" }, workers: 3, executor, browser: {} as never, baseUrl: "http://127.0.0.1:1", model: { pages: [], apis: [] } as unknown as AppModel, limit: Infinity },
            [test(1, true), test(2, false), test(3, true), test(4, false), test(5, true)],
            { async onScored() {} },
        );

        expect(rewrites).toHaveLength(5);
        for (const spans of [rewrites, runs]) {
            const main = spans.filter((s) => s.lane === "main");
            expect(main.length).toBeGreaterThanOrEqual(3);
            for (const a of main) for (const b of main) if (a !== b) expect(overlaps(a, b), `${a.id} and ${b.id} ran at the same time`).toBe(false);
            expect(spans.filter((s) => s.lane === undefined).some((f) => main.some((m) => overlaps(f, m)))).toBe(true);
        }
    });
});
