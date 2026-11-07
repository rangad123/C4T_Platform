/**
 * Results that must reach the platform (docs/features/runner-protocol-2.md, "durable results").
 *
 * A finished task's result is written to `<work folder>/outbox/<task>.json` (only this user can read it) BEFORE it is posted, and the file
 * is removed only when the platform answered: 2xx (kept, or it had it already), or 404, 409 or 410 (it no longer wants it). Network
 * trouble, a server error or a rate limit keeps the file, and the agent tries again with growing waits (2 s up to a minute) for as long
 * as it runs, and again after it restarts: the task folder is wiped at start, the outbox is not. A result older than a day is dropped
 * (the platform forgets finished tasks after a day).
 *
 * The file holds what the result holds: the runs with every secret of the task masked (mapping.ts maskRun), never the task's credentials.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { ResultRequest } from "../agent-protocol/schema.js";
import { sleep } from "./backoff.js";
import { PlatformError, type PlatformClient } from "./client.js";
import type { Logger } from "./log.js";
import { sanitizeName } from "./names.js";

export const OUTBOX_MAX_AGE_MS = 24 * 60 * 60_000;

export interface OutboxEntry {
    taskId: string;
    body: ResultRequest;
    savedAt: string;
}

export type Delivery = "sent" | "refused" | "pending";

export class ResultOutbox {
    private readonly dir: string;
    private wakeUp: (() => void) | undefined;
    private loop: Promise<void> | undefined;
    private readonly stopped = new AbortController();

    constructor(
        workDir: string,
        private readonly o: { client: PlatformClient; log: Logger; now?: () => number; maxDelayMs?: number },
    ) {
        this.dir = path.join(workDir, "outbox");
    }

    private file(taskId: string): string {
        return path.join(this.dir, `${sanitizeName(taskId, 64, "task")}.json`);
    }

    async init(): Promise<void> {
        await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    }

    /** Keep a result on disk (replacing an earlier one for the same task). Written to a temporary name first, so a crash never leaves half a file. */
    async put(taskId: string, body: ResultRequest): Promise<void> {
        await this.init();
        const entry: OutboxEntry = { taskId, body, savedAt: new Date(this.o.now?.() ?? Date.now()).toISOString() };
        const tmp = `${this.file(taskId)}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(entry), { mode: 0o600 });
        await fs.rename(tmp, this.file(taskId));
    }

    /** Task ids waiting to be delivered, oldest first. */
    async pending(): Promise<string[]> {
        const names = await fs.readdir(this.dir).catch(() => [] as string[]);
        const out: Array<{ id: string; at: number }> = [];
        for (const n of names) {
            if (!n.endsWith(".json")) continue;
            const entry = await this.read(path.join(this.dir, n));
            if (entry) out.push({ id: entry.taskId, at: Date.parse(entry.savedAt) || 0 });
        }
        return out.sort((a, b) => a.at - b.at).map((x) => x.id);
    }

    private async read(file: string): Promise<OutboxEntry | undefined> {
        try {
            const v = JSON.parse(await fs.readFile(file, "utf8")) as Partial<OutboxEntry>;
            const body = ResultRequest.safeParse(v.body);
            if (typeof v.taskId !== "string" || !body.success || typeof v.savedAt !== "string") throw new Error("unreadable");
            return { taskId: v.taskId, body: body.data, savedAt: v.savedAt };
        } catch {
            await fs.rm(file, { force: true }).catch(() => undefined); // a damaged entry can never be delivered
            return undefined;
        }
    }

    /** One try at delivering a kept result. */
    async deliver(taskId: string): Promise<Delivery> {
        const file = this.file(taskId);
        const entry = await this.read(file).catch(() => undefined);
        if (!entry) return "refused";
        const short = taskId.slice(0, 12);
        if ((this.o.now?.() ?? Date.now()) - (Date.parse(entry.savedAt) || 0) > OUTBOX_MAX_AGE_MS) {
            this.o.log.warn(`Task ${short}: its result waited more than a day for the platform and was dropped.`);
            await fs.rm(file, { force: true });
            return "refused";
        }
        try {
            const r = await this.o.client.result(taskId, entry.body);
            await fs.rm(file, { force: true });
            this.o.log.info(`Task ${short}: result sent (${entry.body.ok ? "ok" : `not run: ${entry.body.error ?? "stopped"}`})${r.alreadyReceived ? "; the platform had it already" : ""}.`);
            return "sent";
        } catch (e) {
            const err = e instanceof PlatformError ? e : undefined;
            // The platform answered and said no (task gone, already finished, a newer attempt, not ours): sending again will not change that.
            if (err && (err.kind === "rejected" || err.kind === "auth" || err.kind === "conflict" || err.kind === "protocol") && err.status !== undefined && err.status < 500 && err.status !== 429) {
                this.o.log.warn(`Task ${short}: the platform did not accept the result (${err.message})`);
                await fs.rm(file, { force: true });
                return "refused";
            }
            return "pending";
        }
    }

    /** Try every kept result once. Returns how many are still waiting. */
    async flush(): Promise<number> {
        let left = 0;
        for (const id of await this.pending()) if ((await this.deliver(id)) === "pending") left++;
        return left;
    }

    /** Keep trying in the background until `stop()`: at once after `wake()`, otherwise with growing waits while something is waiting. */
    start(): void {
        if (this.loop) return;
        this.loop = (async () => {
            let waiting = 0;
            while (!this.stopped.signal.aborted) {
                const left = await this.flush().catch(() => 1);
                waiting = left > 0 ? waiting + 1 : 0;
                const delay = left > 0 ? Math.min(this.o.maxDelayMs ?? 60_000, 2000 * 2 ** Math.min(waiting - 1, 5)) : 60_000;
                const signal = this.stopped.signal;
                await new Promise<void>((resolve) => {
                    const t = setTimeout(done, delay);
                    signal.addEventListener("abort", done, { once: true });
                    this.wakeUp = done;
                    function done() {
                        clearTimeout(t);
                        signal.removeEventListener("abort", done);
                        resolve();
                    }
                });
                this.wakeUp = undefined;
            }
        })();
    }

    wake(): void {
        this.wakeUp?.();
    }

    async stop(): Promise<void> {
        this.stopped.abort();
        this.wakeUp?.();
        await Promise.race([this.loop ?? Promise.resolve(), sleep(2000)]);
    }
}
