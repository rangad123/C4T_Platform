/**
 * What a cancelled run did, said from the facts the job recorded (how many tests it meant to run, how many reached a result).
 * Shown on the Runs page and the project page instead of a fixed sentence: a cancel keeps the results of the tests that finished
 * and leaves every other test exactly as it was, and this says how many of each there were.
 */
import type { JobRow } from "./repo.js";

export interface CancelSummary {
    /** Tests the run meant to run. */
    planned: number;
    /** Tests that reached a result before the cancel; they keep it. */
    ran: number;
    /** Tests that did not get to run; each keeps the result it had before the run. */
    notRun: number;
    /** One plain sentence. */
    note: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** True for a job that ended because someone cancelled it. */
export const wasCancelled = (job: Pick<JobRow, "status" | "error">): boolean => job.status === "FAILED" && job.error === "Cancelled";

export function cancelSummary(job: Pick<JobRow, "status" | "error" | "counters" | "options">): CancelSummary | undefined {
    if (!wasCancelled(job)) return undefined;
    const c = job.counters;
    const planned = Math.max(c.testsGenerated, c.testsValidated + c.testsFailedValidation + c.testsNeedingReview, 0);
    const ran = Math.min(planned, c.testsValidated + c.testsFailedValidation + c.testsNeedingReview);
    const notRun = planned - ran;
    // An analysis creates its tests as it goes; the ones the cancel came before exist, but have never been run.
    const created = (job.options.mode ?? "generate") === "generate";
    let note: string;
    if (planned === 0) note = "The run was cancelled before any test started. No test was changed.";
    else if (ran === 0) note = created ? `The run was cancelled before any test ran. The ${plural(planned, "test")} that ${planned === 1 ? "was" : "were"} created ${planned === 1 ? "has" : "have"} not been run yet.` : `The run was cancelled before any test ran. All ${plural(planned, "test")} keep the result ${planned === 1 ? "it" : "they"} had before.`;
    else if (notRun === 0) note = `The run was cancelled after all ${plural(planned, "test")} had finished, so every result is kept.`;
    else note = `The run was cancelled. ${ran} of ${plural(planned, "test")} had finished and ${ran === 1 ? "keeps its" : "keep their"} new ${ran === 1 ? "result" : "results"}. ${notRun} did not run and ${created ? "have not been run yet" : notRun === 1 ? "keeps the result it had before" : "keep the results they had before"}.`;
    return { planned, ran, notRun, note };
}

/**
 * SQL condition (alias `e` = test_executions): the execution does not come from a cancelled run. What a half-finished run
 * recorded says nothing about how reliable a test is, so flakiness, quarantine and "unreliable" counts leave it out.
 */
export const NOT_FROM_CANCELLED_JOB = "(e.job_id IS NULL OR e.job_id NOT IN (SELECT id FROM generation_jobs WHERE status = 'FAILED' AND error = 'Cancelled'))";
