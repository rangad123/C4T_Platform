/**
 * Protocol 2: a run's live events, from this computer to the platform (docs/features/runner-protocol-2.md).
 *
 * Events are numbered from 0 per attempt and sent in batches: at most 50 at a time, never more than about a second after the first one
 * waiting. A batch that does not arrive (network trouble, a platform restart) is sent again with the same numbers, which the platform
 * keeps once. A platform that says the attempt is over (404, 409 superseded, 410) ends the sender: nothing more is sent and `onGone`
 * tells the task to stop. Every text is masked with the run's secrets before it is queued.
 */
import type { LiveEvent } from "../agent-protocol/schema.js";
import { sleep } from "./backoff.js";
import { PlatformError } from "./client.js";

type WithoutSeq<T> = T extends unknown ? Omit<T, "seq" | "at"> : never;
/** A live event before it is numbered and stamped. */
export type LiveEventInput = WithoutSeq<LiveEvent>;

export interface LiveEventSenderOptions {
    send(events: LiveEvent[]): Promise<void>;
    /** Masks the run's secrets (the agent's Logger.redact). */
    redact(text: string): string;
    /** The platform no longer wants this attempt's events (it answered 404, 409 or 410). */
    onGone(why: string): void;
    maxBatch?: number;
    maxDelayMs?: number;
    /** Events kept while the platform does not answer; beyond it the oldest log lines go first, then the oldest events. */
    maxQueue?: number;
    now?: () => Date;
    /** Wait before the n-th retry of a batch (n from 1). */
    retryDelayMs?: (n: number) => number;
}

const deepRedact = (v: unknown, redact: (s: string) => string): unknown => {
    if (typeof v === "string") return redact(v);
    if (Array.isArray(v)) return v.map((x) => deepRedact(x, redact));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, deepRedact(x, redact)]));
    return v;
};

export class LiveEventSender {
    private seq = 0;
    private queue: LiveEvent[] = [];
    private timer: ReturnType<typeof setTimeout> | undefined;
    private sending: Promise<void> | undefined;
    private gone = false;
    private closed = false;
    private readonly stopRetry = new AbortController();
    /** Events the platform kept, and events it already had (a batch sent again). */
    stored = 0;
    sent = 0;

    constructor(private readonly o: LiveEventSenderOptions) {}

    get isGone(): boolean {
        return this.gone;
    }

    /** Queue one event (numbered and stamped now). Ignored once the platform said the attempt is over or the sender was closed. */
    push(e: LiveEventInput): void {
        if (this.gone || this.closed) return;
        const event = { ...(deepRedact(e, this.o.redact) as LiveEventInput), seq: this.seq++, at: (this.o.now ?? (() => new Date()))().toISOString() } as LiveEvent;
        this.queue.push(event);
        const max = this.o.maxQueue ?? 2000;
        if (this.queue.length > max) {
            // A flood while the platform is away: keep the structure (tests, steps, screenshots) and drop the oldest log lines first.
            const logAt = this.queue.findIndex((x) => x.type === "log");
            this.queue.splice(logAt >= 0 ? logAt : 0, 1);
        }
        this.schedule(this.queue.length >= (this.o.maxBatch ?? 50) ? 0 : (this.o.maxDelayMs ?? 1000));
    }

    private schedule(delay: number): void {
        if (this.sending) return; // the loop that is sending picks the new events up
        if (this.timer && delay > 0) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.drain();
        }, delay);
    }

    private drain(): Promise<void> {
        if (this.sending) return this.sending;
        this.sending = (async () => {
            let failures = 0;
            while (this.queue.length > 0 && !this.gone) {
                const batch = this.queue.slice(0, this.o.maxBatch ?? 50);
                try {
                    await this.o.send(batch);
                    this.queue.splice(0, batch.length);
                    this.sent += batch.length;
                    failures = 0;
                } catch (e) {
                    const err = e instanceof PlatformError ? e : undefined;
                    if (err && (err.status === 404 || err.status === 409 || err.status === 410)) {
                        this.gone = true;
                        this.queue = [];
                        this.o.onGone(err.message);
                        break;
                    }
                    if (err && err.kind === "rejected") {
                        // The platform refused this batch for good (its format): it is dropped, the next ones still go.
                        this.queue.splice(0, batch.length);
                        continue;
                    }
                    if (this.closed && failures >= 2) break; // closing: a platform that is away does not hold the result back
                    failures++;
                    await sleep(this.o.retryDelayMs?.(failures) ?? Math.min(10_000, 500 * 2 ** failures), this.stopRetry.signal);
                    if (this.stopRetry.signal.aborted) break;
                }
            }
        })().finally(() => {
            this.sending = undefined;
            if (this.queue.length > 0 && !this.gone && !this.closed) this.schedule(this.o.maxDelayMs ?? 1000);
        });
        return this.sending;
    }

    /** Send what is waiting now and wait for it, at most `timeoutMs`. */
    async flush(timeoutMs = 5000): Promise<void> {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        const done = this.drain();
        const stop = new AbortController();
        await Promise.race([done, sleep(timeoutMs, stop.signal)]);
        stop.abort();
    }

    /** No more events: send what is waiting (at most `timeoutMs`), then stop retrying. */
    async close(timeoutMs = 5000): Promise<void> {
        this.closed = true;
        await this.flush(timeoutMs);
        this.stopRetry.abort();
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
    }
}
