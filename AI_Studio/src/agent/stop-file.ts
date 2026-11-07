/**
 * The stop file (round 39): how the Windows installer's tray program asks the runner to stop gracefully. Windows has no SIGTERM for a
 * hidden child process, so the host writes `stop.request` in the runner's folder (the folder that holds runner.mjs, its working folder),
 * waits up to 25 seconds for the runner to report its running task and exit, and only then ends it hard (installer/win/RunnerHost.cs).
 *
 * The agent watches for the file and treats it like SIGTERM (cancel running tasks with "The agent was stopped.", drain, exit 0). The file
 * holds nothing secret (a time stamp); it is deleted by whoever sees it first, and a leftover one is deleted at start so it never stops
 * the next start.
 */
import fs from "node:fs";
import path from "node:path";

export const STOP_FILE = "stop.request";
/** How long the Windows host waits for the runner after writing the file, before it ends it hard. */
export const STOP_GRACE_MS = 25_000;

export const stopFilePath = (runnerDir: string): string => path.join(runnerDir, STOP_FILE);

/** Remove a stop request left by an earlier session (called at start, before the watch begins). */
export function clearStopRequest(runnerDir: string): void {
    fs.rmSync(stopFilePath(runnerDir), { force: true });
}

/** Write the request (what the Windows host does; also used by tests and by `--stop` on other systems if wanted). */
export function requestStop(runnerDir: string, now: () => number = Date.now): void {
    fs.writeFileSync(stopFilePath(runnerDir), `${new Date(now()).toISOString()}\n`);
}

/**
 * Call `onStop` once when the stop file appears, after deleting it. Polls (a file watcher misses events on some network and synced
 * folders). Returns a function that ends the watch.
 */
export function watchStopFile(runnerDir: string, onStop: () => void, intervalMs = 1000): () => void {
    const file = stopFilePath(runnerDir);
    let done = false;
    const timer = setInterval(() => {
        if (done || !fs.existsSync(file)) return;
        done = true;
        clearInterval(timer);
        try {
            fs.rmSync(file, { force: true });
        } catch {
            /* the stop is what matters */
        }
        onStop();
    }, intervalMs);
    timer.unref?.();
    return () => {
        done = true;
        clearInterval(timer);
    };
}
