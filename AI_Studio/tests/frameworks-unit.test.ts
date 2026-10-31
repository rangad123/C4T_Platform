/**
 * Framework adapters, without any browser: registry rules, built-in metadata, the executor seam, byte-for-byte
 * preservation of generated scripts, and a dummy framework ("noop") that goes through render and execute with no change to the core.
 */
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import {
    AdapterRegistry,
    DuplicateFrameworkError,
    LocalExecutor,
    UnknownFrameworkError,
    defaultAdapterFor,
    executorFor,
    getAdapter,
    groupByRuntime,
    hasAdapter,
    listAdapters,
    localExecutor,
    needsDevice,
    registerAdapter,
    renderWithAdapter,
    setExecutorResolver,
    unregisterAdapter,
    type ExecutionBatch,
    type ExecutionEnv,
    type ExecutionOptions,
    type FrameworkAdapter,
    type ScriptExecutor,
} from "../src/engine/frameworks/index.js";
import { defaultFramework, getGenerator, listGenerators, renderScript } from "../src/engine/generators/index.js";
import { generateHealthSpecs } from "../src/engine/health/specs.js";
import { generateInputSpecs } from "../src/engine/inputs/specs.js";
import { generatePerformanceSpecs } from "../src/engine/performance/specs.js";
import { generateSecuritySpecs } from "../src/engine/security/specs.js";
import { generateVisualSpecs } from "../src/engine/visual/baseline.js";
import { generateLatencySpecs } from "../src/engine/performance/latency.js";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { validateBatch, type ValidationDeps } from "../src/engine/validation/validator.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { frameworkLabel } from "../web/src/lib/labels.js";
import { modelFor } from "./fixtures/checks-app.js";

const ok = (testId: string): ScriptRun => ({ testId, status: "passed", durationMs: 1, failedStepIndex: -1, steps: [], artifacts: [], responses: [] });
const ctxFor = (extra: Partial<EngineContext> = {}): EngineContext => ({
    config: loadConfig({}),
    emit: () => undefined,
    llm: { modelName: "none", model: undefined as never, usage: { inputTokens: 0, outputTokens: 0 }, object: async () => ({}) as never, text: async () => "" },
    ...extra,
});

/** A dummy framework: renders a text file, "runs" it by returning a passing result. Nothing in the core knows about it. */
function noopAdapter(id = "noop", runtime = "noop-runtime"): FrameworkAdapter & { calls: Array<{ batch: ExecutionBatch; env: ExecutionEnv; opts: ExecutionOptions }> } {
    const calls: Array<{ batch: ExecutionBatch; env: ExecutionEnv; opts: ExecutionOptions }> = [];
    return {
        id,
        label: "No-op (test)",
        kinds: ["web"],
        executable: true,
        runtime,
        needs: { node: true },
        traits: { visionJudgement: false, cleanupLedger: false, browserRepair: false },
        calls,
        render: (spec) => ({ framework: id, filename: `${spec.testId}.noop.txt`, content: `noop script for ${spec.testId}`, language: "typescript" }),
        async execute(batch, env, opts) {
            calls.push({ batch, env, opts });
            return batch.scripts.map((s) => ok(s.testId));
        },
        describe() {
            return { id, label: "No-op (test)", kinds: ["web"], executable: true, runtime, needs: { node: true }, traits: { visionJudgement: false, cleanupLedger: false, browserRepair: false } };
        },
    };
}

const webSpec = (id: string) => TestSpecSchema.parse({ testId: id, title: "A web test", kind: "web", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "visible", locator: { by: "text", value: "Hello" } }] });
const apiSpec = (id: string) => TestSpecSchema.parse({ testId: id, title: "An API test", kind: "api", steps: [{ action: "request", method: "GET", path: "/things", auth: "default" }, { action: "assertResponse", check: "status", expected: 200 }] });
const mobileSpec = (id: string) => TestSpecSchema.parse({ testId: id, title: "A mobile test", kind: "mobile", steps: [{ action: "assert", check: "visible", locator: { by: "text", value: "Network & internet" } }] });

afterEach(() => {
    unregisterAdapter("noop");
    unregisterAdapter("noop2");
    setExecutorResolver(undefined);
});

describe("registry", () => {
    it("registers, gets and lists adapters in registration order; a duplicate id is refused", () => {
        const r = new AdapterRegistry();
        const a = noopAdapter("a");
        const b = noopAdapter("b");
        r.register(a);
        r.register(b);
        expect(r.list().map((x) => x.id)).toEqual(["a", "b"]);
        expect(r.get("b")).toBe(b);
        expect(r.has("a")).toBe(true);
        expect(() => r.register(noopAdapter("a"))).toThrow(DuplicateFrameworkError);
        expect(() => r.register(noopAdapter("a"))).toThrow(/already registered/);
    });

    it("an unknown id is a typed error with a plain message that lists what exists", () => {
        const r = new AdapterRegistry();
        r.register(noopAdapter("a"));
        let err: unknown;
        try {
            r.get("nope");
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(UnknownFrameworkError);
        expect((err as UnknownFrameworkError).framework).toBe("nope");
        expect((err as Error).message).toBe('The testing framework "nope" is not available in this platform (available: a).');
        expect(() => getAdapter("does-not-exist")).toThrow(UnknownFrameworkError);
    });

    it("the shared registry already has the built-ins (web, API, mobile, Windows desktop) and refuses to drop them", () => {
        expect(listAdapters().map((a) => a.id)).toEqual(["playwright", "playwright-api", "taqwright", "windows-uia", "taqwright-ios"]);
        expect(() => registerAdapter(noopAdapter("playwright"))).toThrow(DuplicateFrameworkError);
        expect(unregisterAdapter("playwright")).toBe(false);
        expect(hasAdapter("playwright")).toBe(true);
        registerAdapter(noopAdapter());
        expect(hasAdapter("noop")).toBe(true);
        expect(unregisterAdapter("noop")).toBe(true);
        expect(hasAdapter("noop")).toBe(false);
    });

    it("the default adapter per kind matches the old defaultFramework, and a plug-in never takes over a kind", () => {
        for (const kind of ["web", "api", "mobile"] as const) expect(defaultAdapterFor(kind).id).toBe(defaultFramework(kind));
        registerAdapter(noopAdapter());
        expect(defaultAdapterFor("web").id).toBe("playwright");
    });
});

describe("built-in adapters", () => {
    it("describe themselves: id, label, kinds, runtime, what the runner machine needs", () => {
        const byId = Object.fromEntries(listAdapters().map((a) => [a.id, a.describe()]));
        expect(byId["playwright"]).toEqual({ id: "playwright", label: "Playwright (TypeScript)", kinds: ["web"], executable: true, runtime: "playwright", needs: { node: true, browsers: ["chromium"] }, traits: { visionJudgement: true, cleanupLedger: true, browserRepair: true } });
        expect(byId["playwright-api"]).toMatchObject({ id: "playwright-api", label: "Playwright API (TypeScript)", kinds: ["api"], runtime: "playwright", needs: { node: true } });
        expect(byId["taqwright"]).toMatchObject({ id: "taqwright", label: "Taqwright (Appium, TypeScript)", kinds: ["mobile"], runtime: "taqwright", needs: { node: true, android: true }, traits: { visionJudgement: false, cleanupLedger: false, browserRepair: false } });
        expect(JSON.parse(JSON.stringify(byId))).toEqual(byId);
    });

    it("labels match the wording the interface shows, and each adapter matches its generator", () => {
        for (const a of listAdapters()) {
            expect(frameworkLabel(a.id)).toBe(a.label);
            expect(a.executable).toBe(getGenerator(a.id).executable);
        }
        expect(listAdapters().map((a) => [a.id, a.kinds[0]])).toEqual(listGenerators().map((g) => [g.framework, g.kind]));
    });

    it("only the mobile adapters (Android and iOS) need a device", () => {
        expect(listAdapters().filter(needsDevice).map((a) => a.id)).toEqual(["taqwright", "taqwright-ios"]);
    });
});

describe("rendering is unchanged", () => {
    const origin = "https://shop.example";
    const model = modelFor(origin, [{ path: "/", type: "home" }, { path: "/products", type: "content" }, { path: "/login", type: "auth" as never }]);
    const openapi = parseOpenApi({ openapi: "3.0.0", info: { title: "t", version: "1" }, paths: { "/a": { get: { responses: { "200": { description: "ok" } } } }, "/b": { get: { parameters: [{ name: "limit", in: "query", required: true, schema: { type: "integer" } }], responses: { "200": { description: "ok" } } } } } }, "http://x/openapi.json").operations;
    const drafts = [
        ...generateHealthSpecs(model, { maxPages: 3 }),
        ...generateInputSpecs(model, { maxPages: 3 } as never),
        ...generatePerformanceSpecs(model, { maxPages: 2 } as never),
        ...generateSecuritySpecs(model, {}),
        ...generateVisualSpecs(model, { maxPages: 2 }),
    ];
    const web: TestSpec[] = [webSpec("WEB-900"), ...drafts.map((d, i) => TestSpecSchema.parse({ ...d, testId: `WEB-${String(i + 1).padStart(3, "0")}` }))].filter((s) => s.kind === "web");
    const api: TestSpec[] = [apiSpec("API-900"), ...generateLatencySpecs(openapi, { maxEndpoints: 4 }).map((d, i) => TestSpecSchema.parse({ ...d, testId: `API-${String(i + 1).padStart(3, "0")}` }))].filter((s) => s.kind === "api");
    const ctx = { baseUrl: origin, apiBaseUrl: "https://api.shop.example", deleteOps: ["/things/{id}"] };

    it("has a useful spread of fixtures", () => {
        expect(web.length).toBeGreaterThan(6);
        expect(api.length).toBeGreaterThan(1);
    });

    it("every spec renders byte for byte the same through the adapter as through the generator", () => {
        const cases: Array<[string, TestSpec[]]> = [["playwright", web], ["playwright-api", api], ["taqwright", [mobileSpec("MOB-001"), mobileSpec("MOB-002"), webSpec("WEB-901")]]];
        let compared = 0;
        for (const [framework, specs] of cases) {
            for (const spec of specs) {
                const direct = getGenerator(framework).render(spec, ctx);
                expect(getAdapter(framework).render(spec, ctx)).toEqual(direct);
                expect(renderWithAdapter(spec, framework, ctx)).toEqual(direct);
                expect(renderScript(spec, framework, ctx)).toEqual(direct);
                compared++;
            }
        }
        expect(compared).toBeGreaterThan(10);
    });

    it("keeps the generator's own rule about which kinds a framework can render", () => {
        expect(() => renderWithAdapter(apiSpec("API-901"), "playwright", ctx)).toThrow('Framework "playwright" cannot render a "api" spec');
        expect(() => renderWithAdapter(webSpec("WEB-902"), "nope", ctx)).toThrow(UnknownFrameworkError);
    });
});

describe("executor seam", () => {
    const batch: ExecutionBatch = { scratchDir: "/scratch", scripts: [{ testId: "WEB-001", filename: "WEB-001.spec.ts", content: "x" }] };
    const env: ExecutionEnv = { run: { baseUrl: "http://x", headless: true } };
    const opts: ExecutionOptions = { workers: 3, timeoutMs: 5000, signal: new AbortController().signal };

    it("LocalExecutor resolves the adapter and passes batch, env and options through untouched", async () => {
        const a = noopAdapter();
        registerAdapter(a);
        const runs = await new LocalExecutor().execute("noop", batch, env, opts);
        expect(runs.map((r) => r.testId)).toEqual(["WEB-001"]);
        expect(a.calls).toHaveLength(1);
        expect(a.calls[0]!.batch).toBe(batch);
        expect(a.calls[0]!.env).toBe(env);
        expect(a.calls[0]!.opts).toBe(opts);
    });

    it("an unknown adapter id is the typed error, not a crash", async () => {
        await expect(localExecutor.execute("nope", batch, env, opts)).rejects.toBeInstanceOf(UnknownFrameworkError);
    });

    it("executorFor is the local executor unless a resolver says otherwise", () => {
        expect(executorFor()).toBe(localExecutor);
        expect(executorFor({ projectId: "p", jobId: "j", mode: "validate" })).toBe(localExecutor);
        const remote: ScriptExecutor = { name: "remote", execute: async () => [] };
        const seen: unknown[] = [];
        setExecutorResolver((scope) => (seen.push(scope), scope.projectId === "remote-project" ? remote : undefined));
        expect(executorFor({ projectId: "remote-project" })).toBe(remote);
        expect(executorFor({ projectId: "other" })).toBe(localExecutor);
        expect(seen).toHaveLength(2);
        setExecutorResolver(undefined);
        expect(executorFor({ projectId: "remote-project" })).toBe(localExecutor);
    });

    it("groups by runtime in registration order: Playwright web and API together, mobile after", () => {
        const items = [{ f: "taqwright" }, { f: "playwright-api" }, { f: "playwright" }, { f: "taqwright" }];
        const groups = groupByRuntime(items, (i) => i.f);
        expect(groups.map((g) => [g.adapter.id, g.entries.map((e) => e.index)])).toEqual([["playwright", [1, 2]], ["taqwright", [0, 3]]]);
    });
});

describe("a new framework needs no change to the core", () => {
    const deps = (over: Partial<ValidationDeps> = {}): ValidationDeps => ({
        scratchDir: "/scratch",
        env: { baseUrl: "http://x", headless: true },
        render: { baseUrl: "http://x" },
        model: modelFor("http://x", []),
        maxRepairAttempts: 0,
        workers: 2,
        ...over,
    });
    const hooks = (attempts: string[] = []) => ({
        onAttempt: async (t: { spec: TestSpec }, _n: number, script: { filename: string }) => void attempts.push(`${t.spec.testId}:${script.filename}`),
        onFinal: async () => undefined,
    });

    it("renders, runs through the executor and validates a test of a registered dummy framework", async () => {
        const a = noopAdapter();
        registerAdapter(a);
        const attempts: string[] = [];
        const outcomes = await validateBatch(ctxFor(), deps(), [{ spec: webSpec("WEB-001"), framework: "noop" }], hooks(attempts));
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]!.status).toBe("VALIDATED");
        expect(outcomes[0]!.script).toMatchObject({ framework: "noop", filename: "WEB-001.noop.txt", content: "noop script for WEB-001" });
        expect(attempts).toEqual(["WEB-001:WEB-001.noop.txt"]);
        expect(a.calls).toHaveLength(1);
        expect(a.calls[0]!.batch.scratchDir).toBe("/scratch");
        expect(a.calls[0]!.batch.scripts.map((s) => s.filename)).toEqual(["WEB-001.noop.txt"]);
    });

    it("sends every batch through the injected executor, Playwright web and API as one batch, mobile after it", async () => {
        const calls: Array<{ id: string; files: string[]; cleanup?: string; hasMobile: boolean }> = [];
        const recording: ScriptExecutor = {
            name: "recording",
            async execute(id, b, e) {
                calls.push({ id, files: b.scripts.map((s) => s.filename), cleanup: e.run.cleanup, hasMobile: Boolean(e.mobile) });
                return b.scripts.map((s) => ok(s.testId));
            },
        };
        const tests = [
            { spec: mobileSpec("MOB-001"), framework: "taqwright" },
            { spec: apiSpec("API-001"), framework: "playwright-api" },
            { spec: webSpec("WEB-001"), framework: "playwright" },
        ];
        const outcomes = await validateBatch(ctxFor(), deps({ executor: recording, cleanup: { enabled: true }, mobile: { target: { appPackage: "com.example.app" }, avd: "Pixel" } }), tests, hooks());
        expect(outcomes.map((o) => o.status)).toEqual(["VALIDATED", "VALIDATED", "VALIDATED"]);
        expect(calls).toEqual([
            { id: "playwright", files: ["API-001.spec.ts", "WEB-001.spec.ts"], cleanup: "platform", hasMobile: true },
            { id: "taqwright", files: ["MOB-001.mobile.spec.ts"], cleanup: undefined, hasMobile: true },
        ]);
    });

    it("an executor on the engine context is used when the call gives none", async () => {
        const used: string[] = [];
        const viaCtx: ScriptExecutor = { name: "ctx", execute: async (id, b) => (used.push(id), b.scripts.map((s) => ok(s.testId))) };
        await validateBatch(ctxFor({ executor: viaCtx }), deps(), [{ spec: webSpec("WEB-001"), framework: "playwright" }], hooks());
        expect(used).toEqual(["playwright"]);
    });

    it("a mobile test without a device still reports the same plain error", async () => {
        const outcomes = await validateBatch(ctxFor(), deps(), [{ spec: mobileSpec("MOB-001"), framework: "taqwright" }], hooks());
        expect(outcomes[0]!.status).toBe("FAILED_VALIDATION");
        expect(outcomes[0]!.lastRun).toMatchObject({ status: "error", error: "No Android device is set up for this run." });
    });
});
