/**
 * Video off for verification attempts (Phase 5 E2, spec Q6: a recording shows every value on screen and cannot be masked). The option
 * goes validateBatch (`video: false`) -> the executor's options -> the Playwright adapter -> runScripts -> the run's Playwright config.
 * Unset, every test is recorded as before. No browser, no AI: the executor and runScripts are stand-ins where a run would start.
 */
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import type { ExecutionOptions, ScriptExecutor } from "../src/engine/frameworks/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";

const seen = vi.hoisted(() => ({ runScripts: [] as Array<{ video?: false }> }));
vi.mock("../src/engine/validation/runner.js", async (orig) => ({
    ...(await orig<object>()),
    runScripts: async (_dir: string, _scripts: unknown[], _env: unknown, opts: { video?: false }) => (seen.runScripts.push(opts), []),
}));

const { runConfigOf } = await vi.importActual<typeof import("../src/engine/validation/runner.js")>("../src/engine/validation/runner.js");
const { playwrightAdapter } = await import("../src/engine/frameworks/index.js");
const { validateBatch } = await import("../src/engine/validation/validator.js");

describe("verification attempts record no video", () => {
    it("the run config: video off whether asked or not (owner 2026-11-24, V9); a runner's installed browser is kept either way", () => {
        expect(runConfigOf([], {})).toContain('video: "off"');
        const off = runConfigOf([], { video: false });
        expect(off).toContain('video: "off"');
        expect(off).not.toContain('video: { mode: "on"');
        const chrome = runConfigOf([], { video: false, browser: { channel: "chrome" } });
        expect(chrome).toContain('video: "off"');
        expect(chrome).toContain('channel: "chrome"');
        // Variants (cross-browser projects) inherit it from the shared `use`.
        expect(runConfigOf([{ name: "phone", device: "Pixel 7" }], { video: false })).toContain('video: "off"');
    });

    it("the Playwright adapter hands it to runScripts", async () => {
        seen.runScripts.length = 0;
        const batch = { scratchDir: "/nonexistent", scripts: [] };
        await playwrightAdapter.execute(batch, { run: { baseUrl: "http://127.0.0.1:1", headless: true } }, { workers: 1, video: false });
        await playwrightAdapter.execute(batch, { run: { baseUrl: "http://127.0.0.1:1", headless: true } }, { workers: 1 });
        expect(seen.runScripts.map((o) => o.video)).toEqual([false, undefined]);
    });

    it("validateBatch with video false asks the executor for no recording on every run; without it, nothing changes", async () => {
        const config = loadConfig({});
        const ctx: EngineContext = { config, llm: undefined as never, emit: () => undefined };
        const spec = TestSpecSchema.parse({ testId: "WEB-001", title: "Test 1", kind: "web", steps: [{ action: "navigate", url: "/cart" }] });
        const calls: ExecutionOptions[] = [];
        const executor: ScriptExecutor = {
            name: "fake",
            async execute(_a, batch, _e, opts) {
                calls.push(opts);
                return batch.scripts.map((s): ScriptRun => ({ testId: s.testId, status: "passed", durationMs: 1, failedStepIndex: -1, steps: [], artifacts: [], responses: [] }));
            },
        };
        const run = (video?: false) =>
            validateBatch(
                ctx,
                { scratchDir: config.scratchDir, env: { baseUrl: "http://127.0.0.1:1", headless: true }, render: { baseUrl: "http://127.0.0.1:1" }, model: { pages: [], apis: [] } as unknown as AppModel, maxRepairAttempts: 0, workers: 1, executor, ...(video === false ? { video } : {}) },
                [{ spec, framework: "playwright" as const }],
                { async onAttempt() {}, async onFinal() {} },
            );
        await run(false);
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every((o) => o.video === false)).toBe(true);
        calls.length = 0;
        await run();
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every((o) => o.video === undefined)).toBe(true);
    });
});
