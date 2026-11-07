import { getAdapter } from "./registry.js";
import type { ExecutionBatch, ExecutionEnv, ExecutionOptions, ExecutorScope, ScriptExecutor, ScriptRun } from "./types.js";

/** Set while this process may not run test code itself (EXECUTION_MODE=runners, platform/runner-only.ts): makes the error every local run is refused with. */
let localRefusal: (() => Error) | undefined;

/** Refuse (with the error `refusal` makes) or, with undefined, allow again every script run on this machine. The last line behind the routing: a path that was missed fails loudly. */
export function refuseLocalExecution(refusal: (() => Error) | undefined): void {
    localRefusal = refusal;
}

/** Runs scripts on this machine: resolves the adapter and calls its `execute`, passing everything through untouched. */
export class LocalExecutor implements ScriptExecutor {
    readonly name = "local";
    async execute(adapterId: string, batch: ExecutionBatch, env: ExecutionEnv, opts: ExecutionOptions): Promise<ScriptRun[]> {
        if (localRefusal) throw localRefusal();
        return getAdapter(adapterId).execute(batch, env, opts);
    }
}

export const localExecutor: ScriptExecutor = new LocalExecutor();

type Resolver = (scope: ExecutorScope) => ScriptExecutor | undefined;
let resolver: Resolver | undefined;

/**
 * Where should the work of this job or project run? Today always here. A later stage can install a resolver
 * (`setExecutorResolver`) that returns a remote executor for projects that use a runner agent; returning
 * undefined keeps the local executor, so callers never need to know.
 */
export function executorFor(scope: ExecutorScope = {}): ScriptExecutor {
    return resolver?.(scope) ?? localExecutor;
}

/** Install (or with undefined, remove) the resolver `executorFor` consults. */
export function setExecutorResolver(fn: Resolver | undefined): void {
    resolver = fn;
}
