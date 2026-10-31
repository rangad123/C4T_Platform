/**
 * Runs the system `git` for the import: an argument array through `spawn` (never a shell), a time limit, an output cap, and a
 * watch on how much disk the download uses. On a timeout or a limit the process this code started is ended by its process id
 * (and, on Windows, its own child processes with it); nothing else is ever touched.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface GitCommand {
    /** The program to start: `git` by default; tests may point it at a stand-in. */
    file: string;
    /** Arguments placed before every git argument (a stand-in script path). */
    prefixArgs?: string[];
}

export interface GitRunResult {
    code: number | null;
    stdout: Buffer;
    stderr: string;
    timedOut: boolean;
    /** Output or disk limit exceeded. */
    tooLarge: boolean;
    /** The program could not be started (git is not installed). */
    missing: boolean;
}

export interface GitRunOptions {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    input?: Buffer | string;
    maxStdout?: number;
    /** A folder whose size is watched while the process runs; the process is ended when it grows past `maxDirBytes`. */
    watchDir?: string;
    maxDirBytes?: number;
    /** How long to wait, after the process was told to end, for it to be gone before giving up on its `close` event (default 5 s). */
    graceMs?: number;
    /** Test seam: how the process tree is ended (default `endProcessTree`). */
    kill?: (pid: number | undefined) => Promise<void>;
}

const STDERR_CAP = 64 * 1024;

/** Longest wait for `taskkill` itself (it normally takes well under a second). */
const TASKKILL_WAIT_MS = 4_000;

/**
 * End a process we started, together with the processes it started. By id only. The promise settles when the end has been carried out (on Windows: when
 * `taskkill` has returned, or after a bounded wait), so a caller that is about to delete the folder the process worked in can wait for it. It never rejects.
 */
export function endProcessTree(pid: number | undefined): Promise<void> {
    if (!pid) return Promise.resolve();
    if (process.platform === "win32") {
        return new Promise((resolve) => {
            const t = setTimeout(resolve, TASKKILL_WAIT_MS);
            t.unref?.();
            try {
                execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: TASKKILL_WAIT_MS }, () => (clearTimeout(t), resolve()));
            } catch {
                clearTimeout(t);
                resolve();
            }
        });
    }
    try {
        process.kill(pid, "SIGKILL");
    } catch {
        /* already gone */
    }
    return Promise.resolve();
}

/** Size of a folder in bytes, stopping early once it passes `limit`. */
export function dirSizeUpTo(dir: string, limit: number): number {
    let total = 0;
    const stack = [dir];
    while (stack.length) {
        const d = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) stack.push(p);
            else {
                try {
                    total += fs.statSync(p).size;
                } catch {
                    /* removed while walking */
                }
                if (total > limit) return total;
            }
        }
    }
    return total;
}

export function runGit(cmd: GitCommand, args: string[], o: GitRunOptions): Promise<GitRunResult> {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(cmd.file, [...(cmd.prefixArgs ?? []), ...args], { cwd: o.cwd, env: o.env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
        } catch {
            return resolve({ code: null, stdout: Buffer.alloc(0), stderr: "", timedOut: false, tooLarge: false, missing: true });
        }
        const out: Buffer[] = [];
        let outBytes = 0;
        let err = "";
        let timedOut = false;
        let tooLarge = false;
        let missing = false;
        let settled = false;
        const maxStdout = o.maxStdout ?? 16 * 1024 * 1024;
        let killing: Promise<void> | undefined;
        let grace: NodeJS.Timeout | undefined;
        // Ending the process should make `close` fire. If it never does (the kill failed, a grandchild holds the pipes), the answer is given anyway after a bounded
        // wait, so the caller's per-project lock is always released.
        const stop = () => {
            killing ??= (o.kill ?? endProcessTree)(child.pid).catch(() => undefined);
            grace ??= setTimeout(() => finish(null), o.graceMs ?? 5_000);
        };
        const timer = setTimeout(() => ((timedOut = true), stop()), o.timeoutMs);
        const watcher =
            o.watchDir && o.maxDirBytes
                ? setInterval(() => {
                      if (dirSizeUpTo(o.watchDir!, o.maxDirBytes!) > o.maxDirBytes!) ((tooLarge = true), stop());
                  }, 400)
                : undefined;
        const finish = (code: number | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (grace) clearTimeout(grace);
            if (watcher) clearInterval(watcher);
            const result = { code, stdout: Buffer.concat(out), stderr: err, timedOut, tooLarge, missing };
            // The caller deletes the working folder next: wait (bounded) until the tree has really been ended.
            if (killing) void Promise.race([killing, new Promise<void>((r) => setTimeout(r, o.graceMs ?? 5_000).unref?.())]).then(() => resolve(result));
            else resolve(result);
        };
        child.stdout.on("data", (b: Buffer) => {
            outBytes += b.length;
            if (outBytes > maxStdout) {
                tooLarge = true;
                stop();
                return;
            }
            out.push(b);
        });
        child.stderr.on("data", (b: Buffer) => {
            if (err.length < STDERR_CAP) err += b.toString("utf8");
        });
        child.on("error", (e: NodeJS.ErrnoException) => {
            if (e.code === "ENOENT") missing = true;
            finish(null);
        });
        child.on("close", (code) => finish(code));
        child.stdin.on("error", () => undefined);
        if (o.input !== undefined) child.stdin.end(o.input);
        else child.stdin.end();
    });
}
