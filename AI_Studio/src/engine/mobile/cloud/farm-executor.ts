/**
 * Where a project's phone tests run, laid over the job's script executor (the one seam every run goes through: validation, re-runs, schedules,
 * environments, phone exploration's own tests).
 *
 *  - "Run on: device farm": Taqwright (Android) batches go to the farm (farm-runner.ts) instead of this computer's phone or a runner. Every other kind of
 *    test (web, API, iOS, Windows) goes to the executor it always went to.
 *  - "Several phones at once" on this computer: the batch carries the number, and the local runner shares the tests out among the connected phones.
 *
 * With the project's defaults (no farm, one at a time) `withDeviceChoice` returns the executor it was given: nothing about a run changes.
 */
import type { ExecutionBatch, ExecutionEnv, ExecutionOptions, ScriptExecutor, ScriptRun } from "../../frameworks/types.js";
import { runFarmScripts } from "./farm-runner.js";
import type { FarmRunPlan, FarmSessionRecord } from "./types.js";

export interface DeviceChoice {
    /** Set: phone tests run on this farm. */
    farm?: FarmRunPlan;
    /** Phone tests at once on this computer's connected phones (1 = one after another). */
    localParallel?: number;
    onSession?: (r: FarmSessionRecord) => void;
    buildName?: string;
    fetchImpl?: typeof fetch;
    expectTimeoutMs?: number;
}

const ANDROID = "taqwright";

class DeviceChoiceExecutor implements ScriptExecutor {
    constructor(
        private readonly inner: ScriptExecutor,
        private readonly choice: DeviceChoice,
    ) {}
    get name(): string {
        return this.inner.name;
    }
    get remote(): boolean | undefined {
        return this.inner.remote;
    }

    execute(adapterId: string, batch: ExecutionBatch, env: ExecutionEnv, opts: ExecutionOptions): Promise<ScriptRun[]> {
        if (adapterId !== ANDROID || !env.mobile) return this.inner.execute(adapterId, batch, env, opts);
        const farm = this.choice.farm;
        if (farm) {
            const creds = env.mobile.credentials ?? (env.run?.credentials ? { username: env.run.credentials.username, password: env.run.credentials.password } : undefined);
            return runFarmScripts(
                batch.scratchDir,
                batch.scripts,
                {
                    plan: farm,
                    target: env.mobile.target,
                    ...(creds ? { credentials: creds } : {}),
                    ...(env.mobile.log ? { log: env.mobile.log } : {}),
                    ...(this.choice.onSession ? { onSession: this.choice.onSession } : {}),
                    ...(this.choice.buildName ? { buildName: this.choice.buildName } : {}),
                    ...(this.choice.fetchImpl ? { fetchImpl: this.choice.fetchImpl } : {}),
                    ...(this.choice.expectTimeoutMs ? { expectTimeoutMs: this.choice.expectTimeoutMs } : {}),
                },
                { ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.testTimeoutMs !== undefined ? { testTimeoutMs: opts.testTimeoutMs } : {}) },
            );
        }
        // A runner decides about its own phones; only this computer's runs share tests out.
        const n = this.choice.localParallel ?? 1;
        if (n > 1 && !this.inner.remote) return this.inner.execute(adapterId, batch, { ...env, mobile: { ...env.mobile, parallel: n } }, opts);
        return this.inner.execute(adapterId, batch, env, opts);
    }
}

/** The executor with the project's phone choice applied; `inner` itself when the choice is the default. */
export function withDeviceChoice(inner: ScriptExecutor, choice: DeviceChoice): ScriptExecutor {
    if (!choice.farm && !((choice.localParallel ?? 1) > 1)) return inner;
    return new DeviceChoiceExecutor(inner, choice);
}
