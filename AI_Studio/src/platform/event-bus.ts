/**
 * An in-process "something changed" bell for job events.
 *
 * It carries no data. The database is the source of truth for events (a worker in a separate process writes to the same
 * file and never touches this bell); a stream that is listening reads the table whenever it is woken. The bell only makes
 * the common case, the API process writing an event itself (a validation job run by the embedded worker, an agent's
 * heartbeat), show up at once instead of at the next short poll. Losing a ring costs at most one poll interval.
 */
export type Wake = () => void;

/** Subscribe to this key to hear about every job. */
export const ANY_JOB = "*";

export class EventBus {
    private readonly subs = new Map<string, Set<Wake>>();

    /** Returns the function that removes the subscription (call it exactly when the stream closes). */
    subscribe(key: string, wake: Wake): () => void {
        let set = this.subs.get(key);
        if (!set) this.subs.set(key, (set = new Set()));
        set.add(wake);
        return () => {
            const s = this.subs.get(key);
            if (!s) return;
            s.delete(wake);
            if (s.size === 0) this.subs.delete(key);
        };
    }

    /** Ring the bell for one job (and for everybody listening to all jobs). A listener that throws never affects the writer. */
    publish(jobId: string): void {
        for (const key of [jobId, ANY_JOB]) {
            const set = this.subs.get(key);
            if (!set) continue;
            for (const wake of [...set]) {
                try {
                    wake();
                } catch {
                    /* a stream's problem is not the writer's */
                }
            }
        }
    }

    /** How many subscriptions are alive (tests assert this returns to its starting value after streams close). */
    listenerCount(): number {
        let n = 0;
        for (const s of this.subs.values()) n += s.size;
        return n;
    }
}

/** The bell of this process. */
export const eventBus = new EventBus();
