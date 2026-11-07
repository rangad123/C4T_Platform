/**
 * The test data reset before a run: when the project (or the environment the run targets) has a reset request switched on, it is sent once
 * before any test starts. A failure stops the run with a plain message and gives no test a verdict (nothing has been marked as running yet).
 */
import dns from "node:dns/promises";
import type { Config } from "../config.js";
import type { EngineContext } from "../engine/context.js";
import { environmentStore } from "./environment-run.js";
import type { JobRow, Repo } from "./repo.js";
import { SecretBox } from "./secrets.js";
import { isPrivateHost } from "./net-guard.js";
import { ResetHookStore, resetSummary, resetTarget, sendResetRequest } from "./test-data-reset-store.js";

/**
 * EXECUTION_MODE=runners: the reset request is still sent from this server (not from the runner), so only to an address on the public
 * internet. A private or local one (that only the tester's own network can reach) is named, and the run stops before any test, as for
 * any reset that cannot be sent. Undefined when the address is public.
 */
async function privateResetHost(url: string, base: string): Promise<string | undefined> {
    let host: string;
    try {
        host = resetTarget(url, base).hostname.replace(/^\[|\]$/g, "");
    } catch {
        return undefined; // the send below says what is wrong with the address
    }
    if (isPrivateHost(host)) return host;
    const addrs = await dns.lookup(host, { all: true }).catch(() => []);
    return addrs.some((a) => isPrivateHost(a.address)) ? host : undefined;
}

/** Runs that execute existing tests; an exploration or a test built from a sentence makes its own data and is not reset. */
const RESET_MODES = new Set(["validate", "variants", "environment"]);

export async function resetBeforeRun(repo: Repo, config: Pick<Config, "dataDir" | "SECRET_KEY"> & Partial<Pick<Config, "EXECUTION_MODE">>, job: JobRow, app: { url: string }, ctx: Pick<EngineContext, "emit" | "signal">): Promise<{ stop?: string }> {
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
    if (config.EXECUTION_MODE === "runners") {
        const host = await privateResetHost(hook.url, base);
        if (host) {
            const why = `${resetSummary(hook)} goes to ${host}, a private or local address. The reset is sent from the platform's server, not from the runner, and that server cannot reach the address.`;
            store.recordOutcome(job.projectId, environment, false, why);
            ctx.emit({ stage: "validation", kind: "test_data_reset_failed", level: "error", message: `The test data cannot be reset from here: ${why}` });
            return { stop: `The test data cannot be reset from here: ${why} Switch the reset off in Settings, or give it a public address. No test was run, so no result changed.` };
        }
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
