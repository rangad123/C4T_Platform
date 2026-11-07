/**
 * The three frameworks that ship with the platform. Each adapter only wraps what already existed: the generator
 * renders the script and the existing runner executes it. Nothing here changes what a script looks like or how it runs.
 */
import { getGenerator, renderScript } from "../generators/index.js";
import type { Framework } from "../generators/types.js";
import { runMobileScripts } from "../validation/mobile-runner.js";
import { runScripts, type ScriptRun } from "../validation/runner.js";
import type { AdapterDescription, AdapterTraits, ExecutionBatch, ExecutionEnv, ExecutionOptions, FrameworkAdapter, GeneratedScript, RenderContext, RunnerNeeds } from "./types.js";
import type { TestKind, TestSpec } from "../spec/schema.js";

/** Shared plumbing for an adapter backed by a generator and an `execute` function. */
class GeneratorAdapter implements FrameworkAdapter {
    readonly executable: boolean;
    constructor(
        readonly id: Framework,
        readonly label: string,
        readonly kinds: readonly TestKind[],
        readonly runtime: string,
        readonly needs: RunnerNeeds,
        readonly traits: AdapterTraits,
        private readonly run: (batch: ExecutionBatch, env: ExecutionEnv, opts: ExecutionOptions) => Promise<ScriptRun[]>,
        readonly alsoRenders?: readonly TestKind[],
    ) {
        this.executable = getGenerator(id).executable;
    }

    render(spec: TestSpec, ctx: RenderContext): GeneratedScript {
        // The kind check (a mobile generator may also render a web spec) lives next to the generators; reuse it as is.
        return renderScript(spec, this.id, ctx);
    }

    execute(batch: ExecutionBatch, env: ExecutionEnv, opts: ExecutionOptions): Promise<ScriptRun[]> {
        return this.run(batch, env, opts);
    }

    describe(): AdapterDescription {
        return { id: this.id, label: this.label, kinds: [...this.kinds], executable: this.executable, runtime: this.runtime, needs: { ...this.needs, ...(this.needs.browsers ? { browsers: [...this.needs.browsers] } : {}) }, traits: { ...this.traits } };
    }
}

/** Playwright (web and API) scripts run in one `playwright test` process. */
const runPlaywright = (batch: ExecutionBatch, env: ExecutionEnv, opts: ExecutionOptions): Promise<ScriptRun[]> =>
    runScripts(batch.scratchDir, batch.scripts, env.run, { workers: opts.workers, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}), signal: opts.signal, ...(opts.projects ? { projects: opts.projects } : {}), ...(opts.testTimeoutMs !== undefined ? { testTimeoutMs: opts.testTimeoutMs } : {}), ...(opts.onProgress ? { onProgress: opts.onProgress } : {}), ...(opts.onLive ? { onLive: opts.onLive } : {}), ...(opts.allowCustom ? { allowCustom: true } : {}), ...(batch.helpers?.length ? { helpers: batch.helpers } : {}), ...(opts.mail ? { mail: opts.mail } : {}), ...(opts.browser ? { browser: opts.browser } : {}) });

/** Taqwright (Appium) scripts run one after another on a single device. Without a device they report an error instead of running. */
const runTaqwright = async (batch: ExecutionBatch, env: ExecutionEnv, opts: ExecutionOptions): Promise<ScriptRun[]> =>
    env.mobile
        ? runMobileScripts(batch.scratchDir, batch.scripts, env.mobile.credentials || !env.run?.credentials ? env.mobile : { ...env.mobile, credentials: { username: env.run.credentials.username, password: env.run.credentials.password } }, { ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}), signal: opts.signal, ...(opts.testTimeoutMs !== undefined ? { testTimeoutMs: opts.testTimeoutMs } : {}) })
        : batch.scripts.map((s): ScriptRun => ({ testId: s.testId, status: "error", durationMs: 0, error: "No Android device is set up for this run.", failedStepIndex: -1, steps: [], artifacts: [], responses: [] }));

export const playwrightAdapter: FrameworkAdapter = new GeneratorAdapter(
    "playwright",
    "Playwright (TypeScript)",
    ["web"],
    "playwright",
    { node: true, browsers: ["chromium"] },
    { visionJudgement: true, cleanupLedger: true, browserRepair: true },
    runPlaywright,
);

export const playwrightApiAdapter: FrameworkAdapter = new GeneratorAdapter(
    "playwright-api",
    "Playwright API (TypeScript)",
    ["api"],
    "playwright",
    { node: true },
    { visionJudgement: true, cleanupLedger: true, browserRepair: true },
    runPlaywright,
);

export const taqwrightAdapter: FrameworkAdapter = new GeneratorAdapter(
    "taqwright",
    "Taqwright (Appium, TypeScript)",
    ["mobile"],
    "taqwright",
    { node: true, android: true },
    { visionJudgement: false, cleanupLedger: false, browserRepair: false },
    runTaqwright,
    ["web"],
);
