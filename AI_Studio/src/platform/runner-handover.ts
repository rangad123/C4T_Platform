/**
 * Runs on runners survive a restart of the platform (docs/features/runner-restarts.md).
 *
 * A run that is going on a runner does not need the platform process that started it: the runner keeps running and reporting. So a
 * graceful stop (a deploy) does not cancel it. Instead:
 *  1. the platform drains (AgentService.drain): nothing new is handed to a runner, open polls end, and the executor of every job that
 *     is waiting for a runner parks right where it is (`parkForHandover`), without telling the runner anything;
 *  2. the worker hands each parked job over (`handOver`, wired by the job runner): from then on nothing of this attempt writes for the job
 *     any more (`isHandedOver`; the job runner waits for the writes already going, then closes the job's write queue), its tests that had
 *     no result yet go back to what they were, an event says what happened, and the job's lease is released with the HANDED_OVER mark;
 *  3. the next platform process re-queues the job without counting it as a lost attempt (Repo.reclaimStaleJobs), and the job's executor
 *     picks up the runner task it already had (RemoteExecutor in agent-services.ts): no second task, no second execution.
 * A parked job is never resumed in the process that parks it: the process is stopping.
 */

/** The lease owner a handed-over job carries until the next platform process takes it again. */
export const HANDED_OVER = "handed-over";

/** Why a job's lease was lost, as the abort reason of its signal: the runner task is another worker's now, so it is not cancelled. */
export const LEASE_LOST = Object.freeze({ leaseLost: true as const });
export const isLeaseLoss = (reason: unknown): boolean => reason === LEASE_LOST;

const parked = new Set<string>();
const waiters = new Map<string, Array<() => void>>();
const hooks = new Map<string, () => Promise<void>>();
/** Jobs whose hand-over has begun in this process. */
const closed = new Set<string>();

/**
 * True once the job's hand-over has begun in this process: every part of the attempt still going (another test of the same job, a
 * result being collected) writes nothing more for it and parks, so nothing lands after the lease is released.
 */
export function isHandedOver(jobId: string): boolean {
    return closed.has(jobId);
}

/** Park a job's executor for the handover: the returned promise never settles (the process is stopping). */
export function parkForHandover(jobId: string): Promise<never> {
    if (!parked.has(jobId)) {
        parked.add(jobId);
        for (const wake of waiters.get(jobId) ?? []) wake();
        waiters.delete(jobId);
    }
    return new Promise<never>(() => undefined);
}

/** Settles when the job's executor parks for the handover. */
export function whenParked(jobId: string): Promise<void> {
    if (parked.has(jobId)) return Promise.resolve();
    return new Promise((resolve) => waiters.set(jobId, [...(waiters.get(jobId) ?? []), resolve]));
}

/** The job runner says how one of its jobs is handed over. Returns the unregister function. */
export function onHandover(jobId: string, hook: () => Promise<void>): () => void {
    // A new attempt of the job in this process (only where one process plays several, as tests do) starts unfenced.
    closed.delete(jobId);
    hooks.set(jobId, hook);
    return () => {
        if (hooks.get(jobId) === hook) hooks.delete(jobId);
        waiters.delete(jobId);
    };
}

/** Hand a parked job over (once). False when the job registered no way to do that. */
export async function handOver(jobId: string): Promise<boolean> {
    const hook = hooks.get(jobId);
    if (!hook) return false;
    hooks.delete(jobId);
    parked.delete(jobId);
    closed.add(jobId);
    await hook();
    return true;
}
