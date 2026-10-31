import type { EngineContext } from "../engine/context.js";
import { localExecutor } from "../engine/frameworks/index.js";
import { withCustomPolicy } from "./custom-policy.js";
import type { Config } from "../config.js";

/** Wraps the job's executor with the run policy when the job includes hand-written tests. A job without any is left exactly as it was. */
export function applyExecutorPolicy(ctx: EngineContext, config: Pick<Config, "ALLOW_CUSTOM_SCRIPTS">, hasCustom: boolean): void {
    if (!hasCustom) return;
    ctx.executor = withCustomPolicy(ctx.executor ?? localExecutor, config.ALLOW_CUSTOM_SCRIPTS === true, true);
}
