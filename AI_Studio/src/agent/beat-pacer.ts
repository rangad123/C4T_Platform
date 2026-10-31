/**
 * When the next heartbeat of a running task is due.
 *
 * A beat is due `maxMs` after the last one (the platform's heartbeat interval: the lease depends on it). While progress lines are
 * waiting to be sent it is due sooner, so a person watching the run sees them within about a second, but never sooner than `minGapMs`
 * after the last beat (1 s by default), so a chatty run cannot flood the platform. Nothing is left running after `wait` settles.
 */
export class BeatPacer {
    private last = 0;
    private nudged?: () => void;

    constructor(
        private readonly maxMs: number,
        private readonly minGapMs: number = Math.min(1000, maxMs),
        private readonly now: () => number = Date.now,
    ) {}

    /** Call when a beat is sent. */
    markBeat(): void {
        this.last = this.now();
    }

    /** Call when a progress line was queued: the waiting `wait` ends at the earliest allowed moment. */
    nudge(): void {
        this.nudged?.();
    }

    /** Resolves when the next beat is due (or the signal aborts). `pending()` says whether lines are already queued. */
    wait(signal: AbortSignal, pending: () => boolean): Promise<void> {
        return new Promise((resolve) => {
            if (signal.aborted) return resolve();
            let early: ReturnType<typeof setTimeout> | undefined;
            const finish = () => {
                clearTimeout(full);
                clearTimeout(early);
                signal.removeEventListener("abort", finish);
                this.nudged = undefined;
                resolve();
            };
            const sinceLast = this.now() - this.last;
            const full = setTimeout(finish, Math.max(0, this.maxMs - sinceLast));
            this.nudged = () => {
                if (early) return;
                early = setTimeout(finish, Math.max(0, this.minGapMs - (this.now() - this.last)));
            };
            signal.addEventListener("abort", finish, { once: true });
            if (pending()) this.nudged();
        });
    }
}
