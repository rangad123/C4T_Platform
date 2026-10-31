/**
 * The engine reads five Settings values synchronously, at every model call or session start: the fast model, the fallback models, compact
 * snapshots, prompt caching and the two "without AI" savings (POSTGRES_S3_MIGRATION.md 2.2). Each is served from one of these caches, so
 * the engine never waits on the database (3.2, "Engine boundary").
 *
 * - A save on this process refreshes the cache at once (the save functions call `refresh`).
 * - A save on another process (the API and the worker are two) is seen within `SETTINGS_REFRESH_MS`: a read of a value older than that
 *   starts a re-read. While reads are synchronous (SQLite) the re-read finishes before the value is returned, as before; once they are
 *   asynchronous the read returns the value it has and the new one lands a moment later.
 */
export const SETTINGS_REFRESH_MS = 5_000;

export class SettingsCache<T> {
    private value: T | undefined;
    private loadedAt = Number.NEGATIVE_INFINITY;
    /** Each re-read is numbered: a slow one that finishes after a newer one never overwrites it. */
    private started = 0;
    private applied = 0;
    private inFlight: Promise<void> | null = null;
    private readonly refreshMs: number;
    private readonly now: () => number;

    constructor(
        private readonly read: () => T | Promise<T>,
        opts: { refreshMs?: number; now?: () => number } = {},
    ) {
        this.refreshMs = opts.refreshMs ?? SETTINGS_REFRESH_MS;
        this.now = opts.now ?? Date.now;
        void this.refresh();
    }

    /** The cached value; never waits. A value older than the refresh interval starts a re-read (at most one at a time). */
    get(): T | undefined {
        if (this.now() - this.loadedAt >= this.refreshMs && !this.inFlight) void this.refresh();
        return this.value;
    }

    /** Re-read now (after a save). Never rejects: the readers already turn an unreadable table into "nothing saved". */
    refresh(): Promise<void> {
        const n = ++this.started;
        let r: T | Promise<T>;
        try {
            r = this.read();
        } catch {
            return Promise.resolve();
        }
        if (!isThenable(r)) {
            this.apply(n, r);
            return Promise.resolve();
        }
        const p = Promise.resolve(r).then(
            (v) => this.apply(n, v),
            () => undefined,
        );
        const tracked = p.finally(() => {
            if (this.inFlight === tracked) this.inFlight = null;
        });
        this.inFlight = tracked;
        return tracked;
    }

    private apply(n: number, v: T): void {
        if (n < this.applied) return;
        this.applied = n;
        this.value = v;
        this.loadedAt = this.now();
    }
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
    return typeof (v as { then?: unknown } | null)?.then === "function";
}
