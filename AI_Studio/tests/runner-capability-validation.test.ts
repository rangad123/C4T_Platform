/**
 * Phase 4: runner capability `validationSteps: 1` (engine/validation/layers.ts). A current runner reports it in its hello; an older
 * runner's hello, without it, still parses. The platform's runner executor says, from the job starter's runner, whether it may send the
 * checks across layers. A test run on an older runner goes without its relation, kept-response and database steps and the run says so
 * in one sentence; on a current runner, or when the runner is not known, the scripts keep every step. No browser.
 */
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/agent-protocol/schema.js";
import { CapabilityProbe } from "../src/agent/capabilities.js";
import { loadConfig } from "../src/config.js";
import type { EngineContext, EngineEvent } from "../src/engine/context.js";
import type { ScriptExecutor } from "../src/engine/frameworks/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { VALIDATION_STEPS_SKIPPED, VALIDATION_STEPS_VERSION } from "../src/engine/validation/layers.js";
import { validateBatch } from "../src/engine/validation/validator.js";
import { AgentService } from "../src/platform/agent-services.js";

const tmp = os.tmpdir();
const HELLO = { os: "linux", arch: "x64", node: "v24.0.0", browsers: ["chromium"] };

describe("the capability in the hello", () => {
    it("a current runner reports validationSteps 1", async () => {
        const caps = await new CapabilityProbe({ env: { ANDROID_AVD_HOME: path.join(tmp, "avd-none"), TAQWRIGHT_HOME: path.join(tmp, "no-taqwright") }, platform: "linux", browsers: () => ["chromium"], exec: async () => undefined }).get();
        expect(caps.validationSteps).toBe(1);
        expect(VALIDATION_STEPS_VERSION).toBe(1);
    });
    it("an older runner's hello, without it, parses as before; a value out of range does not", () => {
        expect(Capabilities.parse(HELLO).validationSteps).toBeUndefined();
        expect(Capabilities.parse({ ...HELLO, validationSteps: 1 }).validationSteps).toBe(1);
        expect(Capabilities.safeParse({ ...HELLO, validationSteps: "1" }).success).toBe(false);
    });
});

describe("the platform's runner executor", () => {
    /** The executor for a job whose starter's runner last said `caps` (undefined: no runner known). */
    const executorWith = (caps: Record<string, unknown> | undefined): ScriptExecutor => {
        const svc = { jobStarter: () => ({ ownerId: "u-1", kind: "person" }), ownRunner: () => (caps ? { agent: { capabilities: caps } } : undefined) };
        return AgentService.prototype.executorFor.call(svc as unknown as AgentService, { projectId: "p1", jobId: "j1" });
    };
    it("is false for an older runner, true for a current one, unset when the runner is not known", () => {
        expect(executorWith(HELLO).validationSteps).toBe(false);
        expect(executorWith({ ...HELLO, validationSteps: 1 }).validationSteps).toBe(true);
        expect(executorWith(undefined).validationSteps).toBeUndefined();
    });
});

describe("a run on an older runner", () => {
    const config = loadConfig({});
    const model = { pages: [], apis: [] } as unknown as AppModel;
    const spec = TestSpecSchema.parse({
        testId: "API-001",
        title: "A discount is a tenth of the subtotal",
        kind: "api",
        steps: [
            { action: "request", method: "POST", path: "/api/orders", body: { item: 1 }, extract: { orderId: "id" } },
            { action: "assertResponse", check: "status", expected: 201 },
            { action: "assertResponse", check: "relation", expression: "discount == round(subtotal * 0.10)" },
            { action: "assertResponse", check: "dbCheck", name: "exists orders where id = '{{orderId}}'" },
        ],
    });
    const plain = TestSpecSchema.parse({ testId: "API-002", title: "Health", kind: "api", steps: [{ action: "request", method: "GET", path: "/api/health" }, { action: "assertResponse", check: "status", expected: 200 }] });

    async function run(validationSteps: boolean | undefined, tests = [spec, plain]) {
        const sent: string[] = [];
        const events: EngineEvent[] = [];
        const executor: ScriptExecutor = {
            name: "fake-runner",
            remote: true,
            ...(validationSteps === undefined ? {} : { validationSteps }),
            async execute(_a, batch) {
                sent.push(...batch.scripts.map((s) => s.content));
                return batch.scripts.map((s) => ({ testId: s.testId, status: "passed" as const, durationMs: 1, failedStepIndex: -1, steps: [], artifacts: [], responses: [] }));
            },
        };
        const ctx: EngineContext = { config, llm: undefined as never, emit: (e) => events.push(e) };
        const outcomes = await validateBatch(
            ctx,
            { scratchDir: config.scratchDir, env: { baseUrl: "http://127.0.0.1:1", headless: true }, render: { baseUrl: "http://127.0.0.1:1" }, model, maxRepairAttempts: 0, workers: 1, executor },
            tests.map((s) => ({ spec: s, framework: "playwright-api" as const })),
            { async onAttempt() {}, async onFinal() {} },
        );
        return { sent, skipped: events.filter((e) => e.kind === "validation_steps_skipped"), outcomes };
    }

    it("sends the tests without the relation and database steps, says so once, and keeps the test as it is", async () => {
        const r = await run(false);
        expect(r.sent[0]).not.toMatch(/relationAssert|dbAssert/);
        expect(r.sent[0]).toMatch(/\/api\/orders/);
        expect(r.skipped.map((e) => e.message)).toEqual([VALIDATION_STEPS_SKIPPED]);
        expect(r.outcomes[0]!.spec.steps.map((s) => (s.action === "assertResponse" ? s.check : s.action))).toEqual(["request", "status", "relation", "dbCheck"]);
    });
    it("says nothing when no test it ran had such a step", async () => {
        expect((await run(false, [plain])).skipped).toEqual([]);
    });
    it.each([[true], [undefined]])("keeps every step on a current or unknown runner (%s)", async (v) => {
        const r = await run(v);
        expect(r.sent[0]).toMatch(/relationAssert\(/);
        expect(r.sent[0]).toMatch(/dbAssert\(/);
        expect(r.skipped).toEqual([]);
    });
});
