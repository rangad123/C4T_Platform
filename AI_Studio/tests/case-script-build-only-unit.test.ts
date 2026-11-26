/**
 * Sheet #27: a test script made from a written test case (Test cases, Generate test scripts) is built and saved, never run. The person
 * starts the run with Run. A test described on Test scripts (Describe it) is still run once, as before. No browser and no real model:
 * an API description (built without a browser), a scripted model answer and a sink that records what the engine asked for.
 *
 *   npx vitest run -c vitest.fast.config.ts tests/case-script-build-only-unit.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const validated = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/engine/validation/validator.js", async (orig) => ({
    ...(await orig<object>()),
    validateBatch: async (_ctx: unknown, _opts: unknown, tests: Array<{ spec: { testId: string } }>) => {
        validated.calls++;
        return tests.map((t) => ({ spec: t.spec, status: "VALIDATED", attempts: 1 }));
    },
}));

import { loadConfig } from "../src/config.js";
import { runPlainAuthoring, type PlainRequest } from "../src/engine/authoring/plain.js";
import type { EngineContext } from "../src/engine/context.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import type { GenerationSink } from "../src/engine/orchestrator.js";
import { plainRequestOf } from "../src/platform/plain-run.js";
import type { JobRow, Repo } from "../src/platform/repo.js";

const llm = {
    modelName: "scripted",
    usage: { inputTokens: 0, outputTokens: 0 },
    text: async () => "",
    object: async () => ({ operation: "GET /api/products", explanation: "Lists the products", pathValues: [], query: [], body: null, expect: { status: 200, fields: [], bodyContains: [] } }),
} as unknown as LlmClient;

function recordingSink() {
    const seen = { executions: 0, created: [] as string[], phases: [] as string[] };
    const sink = {
        phase: async (_s: string, phase: string, state: string) => void seen.phases.push(`${phase}:${state}`),
        counters: async () => undefined,
        nextTestKey: async (prefix: string) => `${prefix}-001`,
        createTest: async (a: { validation: string }) => {
            seen.created.push(a.validation);
            return { id: "t1", testId: "API-001" };
        },
        updateTest: async () => undefined,
        saveScript: async () => "s1",
        recordExecution: async () => void seen.executions++,
    } as unknown as GenerationSink;
    return { sink, seen };
}

const request = (extra: Partial<PlainRequest> = {}): PlainRequest => ({
    description: "GET /api/products lists the products",
    kind: "api",
    url: "http://127.0.0.1:7790",
    model: { origin: "http://127.0.0.1:7790", apis: [{ method: "GET", path: "/api/products", origin: "http://127.0.0.1:7790", statuses: [200], queryParams: [], source: "openapi", usedIn: [] }] } as never,
    allowChanges: false,
    ...extra,
});
const ctx = (): EngineContext => ({ config: loadConfig({}), llm, emit: () => undefined });

beforeEach(() => {
    validated.calls = 0;
});

describe("a test script made from a test case is not run (sheet #27)", () => {
    it("the job of a test case asks for the test to be built only; a described test's job does not", async () => {
        const job = (options: Record<string, unknown>) => ({ id: "j1", projectId: "p1", options: { mode: "plain", plainDescription: "Open the home page", ...options } }) as unknown as JobRow;
        const args = { repo: {} as Repo, config: { dataDir: "/nonexistent", SECRET_KEY: "x".repeat(32) }, app: { url: "http://127.0.0.1:7790", config: {}, model: null }, roles: [], cleanup: {} as never, dataSets: {}, deleteOps: [] };
        expect((await plainRequestOf({ ...args, job: job({ plainCaseId: "c1", plainCaseQueue: [] }) })).buildOnly).toBe(true);
        expect((await plainRequestOf({ ...args, job: job({}) })).buildOnly).toBeUndefined();
    });

    it("built only: the test is saved as not run yet, and nothing runs it", async () => {
        const { sink, seen } = recordingSink();
        const summary = await runPlainAuthoring(ctx(), request({ buildOnly: true }), sink);
        expect(summary.testsGenerated).toBe(1);
        expect(seen.created).toEqual(["PENDING"]);
        expect(validated.calls).toBe(0);
        expect(seen.executions).toBe(0);
        expect(seen.phases).toContain("validation:skipped");
        expect(summary.testsValidated + summary.testsFailedValidation).toBe(0);
    });

    it("a described test (Describe it) is still run once after it is built", async () => {
        const { sink, seen } = recordingSink();
        await runPlainAuthoring(ctx(), request(), sink);
        expect(seen.created).toEqual(["PENDING"]);
        expect(validated.calls).toBe(1);
        expect(seen.phases).toContain("validation:done");
    });
});
