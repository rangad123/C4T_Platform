/**
 * One job's writes, in the order the engine made them (POSTGRES_S3_MIGRATION.md 3.2, "Engine boundary").
 *
 * The engine's `emit` and `agentAction` stay synchronous: they are called from places that cannot wait (callbacks, hot loops). They hand
 * their write to this queue, and the sink's synchronous-store methods go through it too, so those writes land in program order. The sink's
 * file-storing methods (saveScript, recordExecution and the like) and the job runner's own writes do not pass through it.
 *
 * While each write is synchronous (SQLite today), an idle queue runs it at once, exactly as a direct call did: an event is in the
 * database before `emit` returns, and a synchronous failure reaches the caller as before. Once a write returns a promise (the async
 * stores of M2–M3), later writes wait behind it. `flush` resolves when everything handed in so far is written; the job runner awaits it
 * before the job's final status, on success, failure and cancel alike.
 */
export class JobWriteQueue {
    private tail: Promise<void> | null = null;

    constructor(private readonly onError: (err: unknown) => void = (err) => console.error("[job writes] a queued write failed:", err)) {}

    /** Fire and forget, for `emit` and `agentAction`. A failure of a write that had to wait is reported and the writes after it still run. */
    push(write: () => unknown): void {
        const r = this.enqueue(write);
        if ("promise" in r) r.promise.catch(this.onError);
    }

    /** An awaited write (the sink's methods): its result, or its error, once every earlier write is done. */
    run<T>(write: () => T | Promise<T>): Promise<T> {
        try {
            const r = this.enqueue(write);
            return "promise" in r ? r.promise : Promise.resolve(r.value);
        } catch (err) {
            return Promise.reject(err);
        }
    }

    /** Resolves when every write handed in so far (and any handed in meanwhile) is done. Never rejects. */
    async flush(): Promise<void> {
        while (this.tail) await this.tail;
    }

    /** Whether writes are still waiting (for tests and diagnostics). */
    get pending(): boolean {
        return this.tail !== null;
    }

    /** Runs `write` now when nothing waits and it is synchronous; otherwise chains it behind the writes before it. */
    private enqueue<T>(write: () => T | Promise<T>): { value: T } | { promise: Promise<T> } {
        if (!this.tail) {
            // A synchronous throw reaches the caller directly, as the direct call did.
            const r = write();
            if (!isThenable(r)) return { value: r as T };
            return { promise: this.track(Promise.resolve(r)) };
        }
        return { promise: this.track(this.tail.then(() => write())) };
    }

    private track<T>(p: Promise<T>): Promise<T> {
        const settled = p.then(
            () => undefined,
            () => undefined,
        );
        this.tail = settled;
        void settled.then(() => {
            if (this.tail === settled) this.tail = null;
        });
        return p;
    }
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
    return typeof (v as { then?: unknown } | null)?.then === "function";
}
