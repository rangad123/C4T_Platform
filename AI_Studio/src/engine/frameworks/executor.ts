import { getAdapter } from "./registry.js";
import type { ExecutionBatch, ExecutionEnv, ExecutionOptions, ExecutorScope, ScriptExecutor, ScriptRun } from "./types.js";

/** Runs scripts on this machine: resolves the adapter and calls its `execute`, passing everything through untouched. */
export class LocalExecutor implements ScriptExecutor {
    readonly name = "local";
    async execute(adapterId: string, batch: ExecutionBatch, env: ExecutionEnv, opts: ExecutionOptions): Promise<ScriptRun[]> {
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
