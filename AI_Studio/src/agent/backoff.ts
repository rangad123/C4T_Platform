/** Reconnect delays: exponential from 1 s to 30 s, with jitter so a fleet of agents does not knock on the door together. */
export interface BackoffOptions {
    baseMs?: number;
    maxMs?: number;
}

/** Delay before retry number `attempt` (0 = first retry). Never more than `maxMs`, never less than half the plain step. */
export function backoffDelay(attempt: number, opts: BackoffOptions = {}, random: () => number = Math.random): number {
    const base = opts.baseMs ?? 1000;
    const max = opts.maxMs ?? 30_000;
    const step = Math.min(max, base * 2 ** Math.max(0, Math.min(attempt, 30)));
    // 75% to 125% of the step, capped at the maximum.
    return Math.min(max, Math.round(step * (0.75 + random() * 0.5)));
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const t = setTimeout(done, ms);
        function done() {
            clearTimeout(t);
            signal?.removeEventListener("abort", done);
            resolve();
        }
        signal?.addEventListener("abort", done, { once: true });
    });
