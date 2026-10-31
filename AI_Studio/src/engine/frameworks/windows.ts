/**
 * The Windows desktop framework (`windows-uia`): tests that drive a Windows application through UI Automation.
 *
 * Scripts are ordinary Playwright Test files that never use a browser (see ../generators/windows.ts), so the existing
 * runner, report parsing, artifacts, cancel and runner-agent protocol carry them unchanged. What this adapter adds around the
 * run is the part that must be right:
 *
 *  - It runs only on Windows, from a normal (not elevated) interactive session.
 *  - BEFORE anything is started, every script's application is checked against this computer's allow-list and the hard
 *    deny-list. A refusal is an infrastructure answer ("This computer isn't set up to start X ..."), never a failing test.
 *  - The computer's policy is written into the script text for this run only; the stored script is untouched.
 *  - Afterwards, whatever happened (pass, fail, time-out, cancel), the ledger of processes the helper started is swept so no
 *    PowerShell or application process is left behind.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderScript } from "../generators/index.js";
import { hostAllowList, scriptRefusal, withPolicy } from "../desktop/policy.js";
import { desktopUnavailableReason, probeDesktop, type DesktopProbeResult } from "../desktop/probe.js";
import { DESKTOP_REFUSED_PREFIX } from "../desktop/helper.js";
import { withDesktopTimings } from "../desktop/timings.js";
import { sweepRunFolder } from "../desktop/sweep.js";
import type { TestKind, TestSpec } from "../spec/schema.js";
import { runScripts, type ScriptRun } from "../validation/runner.js";
import type { AdapterDescription, AdapterTraits, ExecutionBatch, ExecutionEnv, ExecutionOptions, FrameworkAdapter, GeneratedScript, RenderContext, RunnerNeeds } from "./types.js";

/** Things that depend on the machine, replaceable in tests. */
export interface WindowsAdapterDeps {
    platform?: NodeJS.Platform;
    probe?: () => Promise<DesktopProbeResult>;
    /** The platform host's allow-list (DESKTOP_ALLOWED_APPS); an agent passes its own in `env.desktop`. */
    hostAllow?: () => string[];
    run?: typeof runScripts;
    /** Called with the number of leftover processes the sweep had to stop (0 = the run cleaned up after itself). */
    onSweep?: (stopped: number) => void;
}

const refusal = (s: { testId: string }, message: string): ScriptRun => ({ testId: s.testId, status: "error", durationMs: 0, error: message, failedStepIndex: -1, steps: [], artifacts: [], responses: [] });

export class WindowsAdapter implements FrameworkAdapter {
    readonly id = "windows-uia";
    readonly label = "Windows UI Automation (PowerShell)";
    readonly kinds: readonly TestKind[] = ["desktop"];
    readonly executable = true;
    readonly runtime = "windows-uia";
    readonly needs: RunnerNeeds = { node: true, windows: true };
    readonly traits: AdapterTraits = { visionJudgement: false, cleanupLedger: false, browserRepair: false };

    constructor(private readonly deps: WindowsAdapterDeps = {}) {}

    render(spec: TestSpec, ctx: RenderContext): GeneratedScript {
        return renderScript(spec, this.id, ctx);
    }

    async execute(batch: ExecutionBatch, env: ExecutionEnv, opts: ExecutionOptions): Promise<ScriptRun[]> {
        if (opts.signal?.aborted) throw new Error("Job cancelled");
        const platform = this.deps.platform ?? process.platform;
        const unavailable = desktopUnavailableReason(platform, platform === "win32" ? await (this.deps.probe ?? probeDesktop)() : undefined);
        if (unavailable) return batch.scripts.map((s) => refusal(s, unavailable));

        // The agent hands in its own allow-list; a run on the platform host reads DESKTOP_ALLOWED_APPS.
        const via = env.desktop ? "agent" : "host";
        const allow = env.desktop ? [...env.desktop.allowApps] : (this.deps.hostAllow ?? hostAllowList)();

        // 1. Pre-flight: which scripts may run here at all.
        const results: Array<ScriptRun | undefined> = batch.scripts.map(() => undefined);
        const runnable: Array<{ index: number; script: (typeof batch.scripts)[number] }> = [];
        batch.scripts.forEach((script, index) => {
            const why = scriptRefusal(script.content, allow, via, platform);
            if (why) results[index] = refusal(script, why);
            else runnable.push({ index, script });
        });
        if (runnable.length === 0) return results as ScriptRun[];

        // 2. Run. The folder holds this run's host scripts and the ledger of processes they start.
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aitp-uia-"));
        let runs: ScriptRun[] = [];
        try {
            // The project's own time limits (framework settings) are laid over the script for this run only; unset, the script runs as rendered.
            const timings = opts.testTimeoutMs !== undefined || opts.startTimeoutMs !== undefined ? { ...(opts.testTimeoutMs !== undefined ? { testTimeoutMs: opts.testTimeoutMs } : {}), ...(opts.startTimeoutMs !== undefined ? { startTimeoutMs: opts.startTimeoutMs } : {}) } : undefined;
            const scripts = runnable.map(({ script }) => {
                const content = withPolicy(script.content, { allow, via, dir });
                return { ...script, content: timings ? withDesktopTimings(content, timings) : content };
            });
            // The overall limit of the run grows with a longer test limit, so it never ends a test before the test's own limit would.
            const limitMs = opts.testTimeoutMs ?? (opts.startTimeoutMs !== undefined ? Math.max(120, Math.ceil(opts.startTimeoutMs / 1000) + 90) * 1000 : undefined);
            runs = await (this.deps.run ?? runScripts)(batch.scratchDir, scripts, env.run, { workers: opts.workers, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}), signal: opts.signal, ...(limitMs !== undefined ? { testTimeoutMs: limitMs } : {}) });
        } finally {
            // Whatever happened (a pass, a failure, a time-out, a cancel) nothing the helper started may stay running.
            const stopped = await sweepRunFolder(dir);
            this.deps.onSweep?.(stopped);
            if (stopped > 0) runs = runs.map((r) => ({ ...r, notes: [...(r.notes ?? []), `${stopped} leftover process${stopped === 1 ? "" : "es"} of the desktop test ${stopped === 1 ? "was" : "were"} stopped.`] }));
        }
        runnable.forEach(({ index }, k) => (results[index] = infrastructureRefusal(runs[k]!)));
        return results as ScriptRun[];
    }

    describe(): AdapterDescription {
        return { id: this.id, label: this.label, kinds: [...this.kinds], executable: this.executable, runtime: this.runtime, needs: { ...this.needs }, traits: { ...this.traits } };
    }
}

/** A refusal raised inside the script (the second check) is an infrastructure answer too: status "error" with the plain sentence. */
function infrastructureRefusal(run: ScriptRun): ScriptRun {
    const text = run.error ?? run.steps.find((s) => s.status === "failed")?.error ?? "";
    const m = new RegExp(String.raw`^(?:Error:\s*)?${DESKTOP_REFUSED_PREFIX}\s*`).exec(text);
    if (!m) return run;
    return { ...run, status: "error", error: text.slice(m[0].length).trim(), steps: [], failedStepIndex: -1 };
}

export const windowsAdapter: FrameworkAdapter = new WindowsAdapter();
