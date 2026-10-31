/**
 * The iOS framework (`taqwright-ios`): mobile tests that run on an iOS simulator through Taqwright and Appium (XCUITest).
 *
 * It renders with the Taqwright generator that Android tests use (same getBy* vocabulary), after checking the few things iOS does
 * differently (see ../mobile/ios-spec.ts), and relabels the script as its own framework. It runs only on a Mac with Xcode: the
 * platform server never runs it, a runner agent that reports macOS, Xcode, a simulator and the XCUITest driver does. Without a
 * simulator setup for the run it answers with an error result and a plain sentence, never a pass and never a failed test.
 */
import { renderScript } from "../generators/index.js";
import { runIosScripts } from "../mobile/ios-runner.js";
import type { TestKind, TestSpec } from "../spec/schema.js";
import type { ScriptRun } from "../validation/runner.js";
import type { AdapterDescription, AdapterTraits, ExecutionBatch, ExecutionEnv, ExecutionOptions, FrameworkAdapter, GeneratedScript, RenderContext, RunnerNeeds } from "./types.js";

export interface IosAdapterDeps {
    /** Replace the runner (tests). */
    run?: typeof runIosScripts;
}

const refusal = (testId: string, message: string): ScriptRun => ({ testId, status: "error", durationMs: 0, error: message, failedStepIndex: -1, steps: [], artifacts: [], responses: [] });

export class IosAdapter implements FrameworkAdapter {
    readonly id = "taqwright-ios";
    readonly label = "Taqwright iOS (Appium, TypeScript)";
    readonly kinds: readonly TestKind[] = ["mobile"];
    readonly executable = true;
    readonly runtime = "taqwright-ios";
    readonly needs: RunnerNeeds = { node: true, ios: true };
    readonly traits: AdapterTraits = { visionJudgement: false, cleanupLedger: false, browserRepair: false };

    constructor(private readonly deps: IosAdapterDeps = {}) {}

    render(spec: TestSpec, ctx: RenderContext): GeneratedScript {
        // The iOS generator is the Android one plus the iOS checks: same text, Taqwright applies the platform differences (for example the edge swipe for "back").
        return renderScript(spec, this.id, ctx);
    }

    async execute(batch: ExecutionBatch, env: ExecutionEnv, opts: ExecutionOptions): Promise<ScriptRun[]> {
        if (opts.signal?.aborted) throw new Error("Job cancelled");
        if (!env.ios) return batch.scripts.map((s) => refusal(s.testId, "No iOS simulator is set up for this run."));
        return (this.deps.run ?? runIosScripts)(batch.scratchDir, batch.scripts, env.ios, { ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}), signal: opts.signal, ...(opts.testTimeoutMs !== undefined ? { testTimeoutMs: opts.testTimeoutMs } : {}) });
    }

    describe(): AdapterDescription {
        return { id: this.id, label: this.label, kinds: [...this.kinds], executable: this.executable, runtime: this.runtime, needs: { ...this.needs }, traits: { ...this.traits } };
    }
}

export const iosAdapter: FrameworkAdapter = new IosAdapter();
