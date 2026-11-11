/**
 * A deploy token that is linked to a runbook starts a run of it instead of a plain re-run. The token is still the only
 * credential of the pipeline's two routes, and the same per-token rate limit applies. The pipeline asks about the run with the
 * same status route as for a plain run, using the run id it was given.
 */
import type { Platform } from "./bootstrap.js";
import { getRunbookServices, RunbookOverlapError } from "./runbook-runner.js";
import { OverlapError } from "./scheduler.js";
import { HttpError } from "./http-error.js";
import { assertC4tOwnerMayRun } from "./c4t-service.js";
import { RateLimited, TriggerRunBody, getTriggerServices } from "./trigger-services.js";

export interface RunbookTriggerStarted {
    kind: "runbook";
    runId: string;
    runbook: string;
    state: "running";
    commit: string | null;
    environment: string | null;
    ignored?: string[];
}

/** Starts the token's runbook. Returns undefined when the token is unknown or not linked to a runbook (the plain path then answers). */
export async function startRunbookForToken(p: Platform, presented: string, rawInput: unknown): Promise<RunbookTriggerStarted | undefined> {
    const triggers = getTriggerServices(p);
    const token = triggers.store.find(presented);
    if (!token) return undefined;
    const runbooks = getRunbookServices(p);
    const runbookId = runbooks.store.tokenLink(token.id);
    if (!runbookId) return undefined;

    const wait = triggers.store.waitMs(token, triggers.minGapMs);
    if (wait > 0) throw new RateLimited(Math.ceil(wait / 1000));
    const input = TriggerRunBody.parse(rawInput ?? {});
    const ignored: string[] = [];
    if (input.url) ignored.push("url ignored: a runbook runs against the project’s own address or the environments it names");
    if (input.callbackUrl) ignored.push("callbackUrl ignored: ask for the result with the status route instead");
    await assertC4tOwnerMayRun(p, token.createdBy);

    let run;
    try {
        run = await runbooks.start(runbookId, { kind: "deploy", tokenId: token.id, commit: input.commit, environment: input.environment, label: token.label ?? undefined });
    } catch (e) {
        if (e instanceof RunbookOverlapError) throw new HttpError(409, `The runbook “${e.runbookName}” is already running for this project. Try again when it has finished.`);
        if (e instanceof OverlapError) throw new HttpError(409, `Tests are already running for this project (${e.activeStatus.toLowerCase().replace(/_/g, " ")}). Try again when that run has finished.`);
        throw e;
    }
    // Take the token's slot. Of two simultaneous requests only one gets it; the loser's run is cancelled before it does anything.
    if (!triggers.store.claimSlot(token.id, triggers.minGapMs)) {
        runbooks.cancel(run.id);
        throw new RateLimited(Math.max(1, Math.ceil(triggers.store.waitMs(triggers.store.find(presented) ?? token, triggers.minGapMs) / 1000)));
    }
    return { kind: "runbook", runId: run.id, runbook: run.runbookName, state: "running", commit: input.commit ?? null, environment: input.environment ?? null, ...(ignored.length ? { ignored } : {}) };
}

/** The status of a runbook run the token started; undefined when the id is not one of this token's runbook runs. */
export function runbookRunStatus(p: Platform, presented: string, runId: string): Record<string, unknown> | undefined {
    const triggers = getTriggerServices(p);
    const token = triggers.store.find(presented);
    if (!token) return undefined;
    const runbooks = getRunbookServices(p);
    runbooks.sweep();
    const run = runbooks.store.getRun(runId);
    if (!run || run.trigger !== "deploy" || run.triggerRef !== token.id) return undefined;
    triggers.store.touch(token.id);
    const pub = runbooks.publicRun(run) as { steps: Array<{ id: string; title: string; status: string; reason: string | null; jobId: string | null }> } & Record<string, unknown>;
    return {
        kind: "runbook",
        runId: run.id,
        runbook: run.runbookName,
        state: run.status,
        finished: pub.finished,
        passed: pub.passed,
        reason: run.reason,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt,
        steps: pub.steps.map((s) => ({ id: s.id, title: s.title, status: s.status, reason: s.reason, jobId: s.jobId })),
    };
}
