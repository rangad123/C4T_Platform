/**
 * Applies a project's framework settings to every run, in one place: a wrapper around the job's script executor.
 *
 * Every caller (validation, re-runs, variants, environments, schedules, triggers, runbooks, plain-English validation) already runs
 * scripts through `executor.execute(...)`, whether the executor runs them here or sends them to a runner agent. Wrapping that one seam
 * means the same values reach every run, and a task sent to an agent carries them too (the remote executor puts them in the task).
 *
 * With default settings `withFrameworkSettings` returns the executor it was given, so nothing about a run changes.
 */
import { DEFAULT_FRAMEWORK_SETTINGS, FRAMEWORK_IDS, turnedOffMessage, type EffectiveSettings, type FrameworkId } from "./settings.js";
import type { ExecutionBatch, ExecutionEnv, ExecutionOptions, ScriptExecutor, ScriptRun } from "./types.js";
import { getAdapter } from "./registry.js";

const refusal = (testId: string, message: string): ScriptRun => ({ testId, status: "error", durationMs: 0, error: message, failedStepIndex: -1, steps: [], artifacts: [], responses: [] });

const isFramework = (id: string): id is FrameworkId => (FRAMEWORK_IDS as readonly string[]).includes(id);

class SettingsExecutor implements ScriptExecutor {
    constructor(
        private readonly inner: ScriptExecutor,
        private readonly eff: EffectiveSettings,
    ) {}

    get name(): string {
        return this.inner.name;
    }
    get remote(): boolean | undefined {
        return this.inner.remote;
    }

    async execute(adapterId: string, batch: ExecutionBatch, env: ExecutionEnv, opts: ExecutionOptions): Promise<ScriptRun[]> {
        const runtime = (() => {
            try {
                return getAdapter(adapterId).runtime;
            } catch {
                return undefined;
            }
        })();
        // Web and API scripts travel in one Playwright process, but each has its own settings: split only when they would differ.
        if (runtime === "playwright") return this.playwright(adapterId, batch, env, opts);
        if (!isFramework(adapterId)) return this.inner.execute(adapterId, batch, env, opts);
        const off = this.eff.enabled[adapterId] ? undefined : turnedOffMessage(adapterId);
        if (off) return batch.scripts.map((s) => refusal(s.testId, off));
        return this.inner.execute(adapterId, batch, this.envFor(adapterId, env), this.optsFor(adapterId, opts));
    }

    /** The time limits and device choices of one framework, only where they differ from what the platform always did. */
    private optsFor(id: FrameworkId, opts: ExecutionOptions): ExecutionOptions {
        const d = DEFAULT_FRAMEWORK_SETTINGS;
        const e = this.eff;
        switch (id) {
            case "playwright":
                return { ...opts, ...(e.web.workersLimit !== null && e.web.workersLimit < opts.workers ? { workers: e.web.workersLimit } : {}), ...(e.web.testTimeoutSeconds !== d.web.testTimeoutSeconds ? { testTimeoutMs: e.web.testTimeoutSeconds * 1000 } : {}) };
            case "playwright-api":
                return { ...opts, ...(e.web.workersLimit !== null && e.web.workersLimit < opts.workers ? { workers: e.web.workersLimit } : {}), ...(e.api.testTimeoutSeconds !== d.api.testTimeoutSeconds ? { testTimeoutMs: e.api.testTimeoutSeconds * 1000 } : {}) };
            case "taqwright":
                return { ...opts, ...(e.android.testTimeoutSeconds !== d.android.testTimeoutSeconds ? { testTimeoutMs: e.android.testTimeoutSeconds * 1000 } : {}) };
            case "taqwright-ios":
                return { ...opts, ...(e.ios.testTimeoutSeconds !== d.ios.testTimeoutSeconds ? { testTimeoutMs: e.ios.testTimeoutSeconds * 1000 } : {}) };
            case "windows-uia":
                return {
                    ...opts,
                    ...(e.windows.testTimeoutSeconds !== d.windows.testTimeoutSeconds ? { testTimeoutMs: e.windows.testTimeoutSeconds * 1000 } : {}),
                    ...(e.windows.startTimeoutSeconds !== d.windows.startTimeoutSeconds ? { startTimeoutMs: e.windows.startTimeoutSeconds * 1000 } : {}),
                };
        }
    }

    private envFor(id: FrameworkId, env: ExecutionEnv): ExecutionEnv {
        const e = this.eff;
        // A visible browser window is only for a run a person can watch: on a runner agent. (effectiveSettings already forced headless
        // on the platform host; this is the second lock.)
        if (id === "playwright" && !e.web.headless && this.inner.remote && env.run.headless !== false) return { ...env, run: { ...env.run, headless: false } };
        if (id === "taqwright" && env.mobile) {
            const mobile = { ...env.mobile };
            let changed = false;
            if (e.android.keepEmulator && !mobile.keepEmulator) {
                mobile.keepEmulator = true;
                changed = true;
            }
            // The project's app emulator wins; the project's default emulator comes before the platform's MOBILE_AVD / first one found.
            if (e.android.defaultAvd && !mobile.target.avd && mobile.avd !== e.android.defaultAvd) {
                mobile.avd = e.android.defaultAvd;
                changed = true;
            }
            if (changed) return { ...env, mobile };
        }
        if (id === "taqwright-ios" && env.ios) {
            const ios = { ...env.ios };
            let changed = false;
            if (e.ios.keepSimulator && !ios.keepSimulator) {
                ios.keepSimulator = true;
                changed = true;
            }
            // The project's app simulator wins; the project's default simulator comes before "a running one, else the first available".
            if (e.ios.defaultSimulator && !ios.target.simulator && ios.defaultSimulator !== e.ios.defaultSimulator) {
                ios.defaultSimulator = e.ios.defaultSimulator;
                changed = true;
            }
            if (changed) return { ...env, ios };
        }
        return env;
    }

    private async playwright(adapterId: string, batch: ExecutionBatch, env: ExecutionEnv, opts: ExecutionOptions): Promise<ScriptRun[]> {
        const frameworkOf = (s: { framework?: string }): FrameworkId => (s.framework === "playwright-api" || s.framework === "playwright" ? s.framework : adapterId === "playwright-api" ? "playwright-api" : "playwright");
        const groups = new Map<FrameworkId, number[]>();
        batch.scripts.forEach((s, i) => {
            const id = frameworkOf(s);
            groups.set(id, [...(groups.get(id) ?? []), i]);
        });
        const out: ScriptRun[] = new Array(batch.scripts.length);
        // One group, or two with the same effect: one call, exactly as before.
        const plans = [...groups.entries()].map(([id, indexes]) => ({ id, indexes, opts: this.optsFor(id, opts), env: this.envFor(id, env), off: this.eff.enabled[id] ? undefined : turnedOffMessage(id) }));
        const live = plans.filter((p) => !p.off);
        for (const p of plans) if (p.off) for (const i of p.indexes) out[i] = refusal(batch.scripts[i]!.testId, p.off);
        const sameEffect = live.length > 1 && live.every((p) => p.opts.testTimeoutMs === live[0]!.opts.testTimeoutMs && p.opts.workers === live[0]!.opts.workers && p.env.run.headless === live[0]!.env.run.headless);
        if (live.length === 0) return out;
        if (live.length === 1 || sameEffect) {
            const first = live[0]!;
            const indexes = live.flatMap((p) => p.indexes).sort((a, b) => a - b);
            const runs = await this.inner.execute(adapterId, { ...batch, scripts: indexes.map((i) => batch.scripts[i]!) }, first.env, first.opts);
            indexes.forEach((i, k) => (out[i] = runs[k]!));
            return out;
        }
        for (const p of live) {
            const runs = await this.inner.execute(adapterId, { ...batch, scripts: p.indexes.map((i) => batch.scripts[i]!) }, p.env, p.opts);
            p.indexes.forEach((i, k) => (out[i] = runs[k]!));
        }
        return out;
    }
}

/** The executor with the project's settings applied. Returns `inner` itself when `needed` is false (default settings). */
export function withFrameworkSettings(inner: ScriptExecutor, eff: EffectiveSettings, needed: boolean): ScriptExecutor {
    return needed ? new SettingsExecutor(inner, eff) : inner;
}
