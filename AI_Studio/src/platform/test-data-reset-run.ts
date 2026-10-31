/**
 * The test data reset before a run: when the project (or the environment the run targets) has a reset request switched on, it is sent once
 * before any test starts. A failure stops the run with a plain message and gives no test a verdict (nothing has been marked as running yet).
 */
import type { Config } from "../config.js";
import type { EngineContext } from "../engine/context.js";
import { environmentStore } from "./environment-run.js";
import type { JobRow, Repo } from "./repo.js";
import { SecretBox } from "./secrets.js";
import { ResetHookStore, resetSummary, sendResetRequest } from "./test-data-reset-store.js";

/** Runs that execute existing tests; an exploration or a test built from a sentence makes its own data and is not reset. */
const RESET_MODES = new Set(["validate", "variants", "environment"]);

export async function resetBeforeRun(repo: Repo, config: Pick<Config, "dataDir" | "SECRET_KEY">, job: JobRow, app: { url: string }, ctx: Pick<EngineContext, "emit" | "signal">): Promise<{ stop?: string }> {
    const mode = job.options.mode ?? "generate";
    if (!RESET_MODES.has(mode)) return {};
    const environment = mode === "environment" ? (job.options.environment ?? "") : "";
    const store = new ResetHookStore(repo.db, new SecretBox(config.dataDir, config.SECRET_KEY));
    let hook: ReturnType<ResetHookStore["secret"]>;
    try {
        hook = store.secret(job.projectId, environment);
    } catch (e) {
        return { stop: `The test data could not be reset: ${e instanceof Error ? e.message : String(e)} No test was run.` };
    }
    if (!hook || !hook.enabled) return {};
    let base = app.url;
    if (environment) {
        const env = environmentStore(repo, config).get(job.projectId, environment);
        if (!env) return { stop: `The test data could not be reset: the environment “${environment}” no longer exists. No test was run.` };
        // Production is read-only for the platform: its data is never reset, whatever was saved before it was marked as production.
        if (env.production) return { stop: `“${environment}” is a production environment, so its test data is never reset. Switch the reset off for it in Settings. No test was run.` };
        base = env.baseUrl;
    }
    ctx.emit({ stage: "validation", kind: "test_data_reset", message: `Resetting the test data first: ${resetSummary(hook)}` });
    let outcome: Awaited<ReturnType<typeof sendResetRequest>>;
    try {
        outcome = await sendResetRequest(hook, base, ctx.signal);
    } catch (e) {
        if (ctx.signal?.aborted) throw e;
        outcome = { ok: false, ms: 0, message: `${resetSummary(hook)} was refused: ${e instanceof Error ? e.message : String(e)}` };
    }
    store.recordOutcome(job.projectId, environment, outcome.ok, outcome.message);
    if (outcome.ok) {
        ctx.emit({ stage: "validation", kind: "test_data_reset_done", message: `Test data reset: ${outcome.message}` });
        return {};
    }
    ctx.emit({ stage: "validation", kind: "test_data_reset_failed", level: "error", message: `The test data reset failed: ${outcome.message}` });
    return { stop: `The test data reset failed: ${outcome.message} No test was run, so no result changed.` };
}
