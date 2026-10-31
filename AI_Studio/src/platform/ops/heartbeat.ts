/**
 * The worker's "I am alive" note for GET /readyz. The worker may run in the API process (WORKER_EMBEDDED) or in its own process
 * (`npm run worker`, later its own container), so the note is a row both can see: `ops_heartbeats` (shared-state.ts), name `worker`,
 * rewritten every 15 seconds. It holds a time and a process id, nothing secret.
 *
 * Until round 26 it was a file, `<DATA_DIR>/ops/worker-heartbeat.json`. That file is not read: a note older than a minute and a half means
 * "not ready" anyway, and the worker writes a fresh row as it starts.
 */
import type { Db } from "../db.js";

export const HEARTBEAT_EVERY_MS = 15_000;

const NAME = "worker";

export function writeHeartbeat(db: Db, at: number = Date.now()): void {
    db.run("INSERT INTO ops_heartbeats (name, at, pid) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET at = excluded.at, pid = excluded.pid", NAME, Math.round(at), process.pid);
}

/** When a worker last said it was alive (ms since epoch), or undefined when none ever did or the row cannot be read. */
export function readHeartbeat(db: Db): number | undefined {
    try {
        const at = db.get<{ at: number | bigint | null }>("SELECT at FROM ops_heartbeats WHERE name = ?", NAME)?.at;
        const n = at === null || at === undefined ? NaN : Number(at);
        return Number.isFinite(n) ? n : undefined;
    } catch {
        return undefined;
    }
}

/** Start beating (first beat now). Returns the stop function; stopping removes nothing, so a stopped worker simply goes stale. */
export function startHeartbeat(db: Db, onError: (msg: string) => void = (m) => console.warn(m)): () => void {
    let warned = false;
    const beat = () => {
        try {
            writeHeartbeat(db);
            warned = false;
        } catch (err) {
            if (!warned) onError(`[ops] Could not write the worker heartbeat: ${err instanceof Error ? err.message : String(err)}`);
            warned = true;
        }
    };
    beat();
    const timer = setInterval(beat, HEARTBEAT_EVERY_MS);
    timer.unref();
    return () => clearInterval(timer);
}
