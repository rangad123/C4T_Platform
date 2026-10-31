/**
 * How a scanner tool is started, stopped and cleaned up. Every adapter goes through this and nothing else starts a process.
 *
 * What it guarantees:
 *   - No shell. `spawn(file, args)` with an argument array and `shell: false`, so nothing anybody typed can become a command. There
 *     is no code path in this module that builds a command line by joining strings.
 *   - The executable is a file the administrator configured (an absolute path, or a bare name looked up only in the configured
 *     directories). It is never taken from a request.
 *   - A scrubbed environment: only PATH, the platform's own operating-system variables and the variables the adapter explicitly
 *     passes are inherited. The platform's secrets (LLM_API_KEY, SECRET_KEY and the like) are NOT inherited, so a scanner process
 *     that is buggy, compromised or replaced cannot read them out of its own environment.
 *   - Bounded output: at most `maxOutputBytes` per stream, kept in memory, so a runaway tool cannot exhaust the platform.
 *   - A hard time limit: at the limit the child is asked to stop, then killed, and the tree is killed with it (`taskkill /T` on
 *     Windows, a process-group kill elsewhere) so a tool that forked helpers leaves nothing behind.
 *   - Cancellation through an AbortSignal, the same signal the assessment's cancel, timeout and authorization checks use.
 *
 * Temporary artifacts (an API document written out for a spec-driven tool) go through `withSecureTempDir`: a directory created with
 * owner-only permissions, removed on the way out whatever happened, and never under the data directory the reports live in.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { planSpawn } from "./cmd-shim.js";

export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface RunOptions {
    /** Path to the executable. Never derived from user input. */
    file: string;
    /** Arguments, passed one by one: never joined into a string. */
    args: string[];
    /** Variables added to the scrubbed environment (a tool's own API key, its template directory). */
    env?: Record<string, string>;
    /** Working directory. Defaults to the directory of the executable, not the platform's. */
    cwd?: string;
    /** Aborted on cancel or at the time limit; the child is then stopped and killed. */
    signal?: AbortSignal;
    /** Wall-clock limit in ms. Always applied, even without a signal. */
    timeoutMs?: number;
    /** Most bytes kept per stream (default MAX_OUTPUT_BYTES). */
    maxOutputBytes?: number;
    /** Called for every line of stdout as it arrives, for JSONL parsers. */
    onStdoutLine?: (line: string) => void;
    /** Called for every line of stderr as it arrives. */
    onStderrLine?: (line: string) => void;
}

export interface RunOutcome {
    /** Exit code, or null when the process was killed by a signal or by the platform. */
    code: number | null;
    signal: NodeJS.Signals | null;
    /** True when the platform stopped it: the signal fired, or the time limit passed. */
    stopped: boolean;
    /** Why it stopped, when it was stopped. */
    stopReason: "cancelled" | "timeout" | null;
    stdout: string;
    stderr: string;
    /** True when a stream produced more than the cap, so the output cannot be trusted as complete. */
    truncated: boolean;
    /** How long the process ran, in ms. */
    tookMs: number;
}

/** Variables a scanner process is allowed to inherit. Everything else in the platform's environment is withheld. */
const INHERIT = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "HOMEDRIVE", "HOMEPATH", "USERPROFILE", "LANG", "LC_ALL", "TZ", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "APPDATA", "LOCALAPPDATA", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"] as const;

/** The environment a child actually sees: the allow-list plus exactly what the adapter passes. */
export function scrubbedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of INHERIT) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
    }
    for (const [key, value] of Object.entries(extra)) if (key && value !== undefined) env[key] = String(value);
    return env;
}

/** Split a stream into lines as they arrive (the last, possibly partial, line is kept until the stream ends). */
function lineReader(onLine: (line: string) => void): (chunk: Buffer) => void {
    let rest = "";
    return (chunk: Buffer) => {
        rest += chunk.toString("utf8");
        let at = rest.indexOf("\n");
        while (at >= 0) {
            const line = rest.slice(0, at).replace(/\r$/, "");
            rest = rest.slice(at + 1);
            if (line.length) onLine(line);
            at = rest.indexOf("\n");
        }
        // A tool that prints without newlines must not grow this buffer without bound.
        if (rest.length > 1_000_000) {
            onLine(rest);
            rest = "";
        }
    };
}

function collect(cap: number): { push: (chunk: Buffer) => void; text: () => string; truncated: () => boolean } {
    const parts: Buffer[] = [];
    let size = 0;
    let cut = false;
    return {
        push: (chunk: Buffer) => {
            if (size >= cap) {
                cut = true;
                return;
            }
            const room = cap - size;
            const take = chunk.length > room ? chunk.subarray(0, room) : chunk;
            parts.push(take);
            size += take.length;
            if (take.length < chunk.length) cut = true;
        },
        text: () => Buffer.concat(parts).toString("utf8"),
        truncated: () => cut,
    };
}

/** Stop a child and everything it started. Windows needs `taskkill /T` to take the tree; elsewhere a group kill does it. */
export function killTree(child: ChildProcessWithoutNullStreams): void {
    try {
        if (process.platform === "win32") {
            spawn("taskkill", ["/pid", String(child.pid ?? ""), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => undefined);
        } else {
            try {
                if (child.pid) process.kill(-child.pid, "SIGKILL");
                else child.kill("SIGKILL");
            } catch {
                child.kill("SIGKILL");
            }
        }
    } catch {
        /* already gone */
    }
}

/**
 * Run one tool to its end, or until the time limit or the signal stops it. Never throws for a process that fails: the exit code and
 * the captured streams are the outcome. Rejects only when the executable itself cannot be started (ENOENT, EACCES).
 */
export function runProcess(options: RunOptions): Promise<RunOutcome> {
    const cap = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    const startedAt = Date.now();
    return new Promise<RunOutcome>((resolve, reject) => {
        let child: ChildProcessWithoutNullStreams;
        try {
            // A Windows .cmd/.bat shim cannot be spawned directly; planSpawn routes it through the command interpreter narrowly,
            // and refuses outright rather than quoting anything it would have to reinterpret.
            const plan = planSpawn(options.file, options.args);
            child = spawn(plan.file, plan.args, {
                cwd: options.cwd,
                env: scrubbedEnv(options.env),
                shell: false,
                windowsHide: true,
                windowsVerbatimArguments: plan.verbatimArguments,
                stdio: ["ignore", "pipe", "pipe"],
                detached: process.platform !== "win32",
            }) as unknown as ChildProcessWithoutNullStreams;
        } catch (e) {
            reject(e);
            return;
        }

        const out = collect(cap);
        const err = collect(cap);
        let stopReason: RunOutcome["stopReason"] = null;
        let stopped = false;
        let settled = false;

        const stdoutLines = options.onStdoutLine ? lineReader(options.onStdoutLine) : undefined;
        const stderrLines = options.onStderrLine ? lineReader(options.onStderrLine) : undefined;
        child.stdout.on("data", (chunk: Buffer) => {
            out.push(chunk);
            stdoutLines?.(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
            err.push(chunk);
            stderrLines?.(chunk);
        });

        const stop = (reason: NonNullable<RunOutcome["stopReason"]>) => {
            if (stopped) return;
            stopped = true;
            stopReason = reason;
            try {
                child.kill();
            } catch {
                /* already gone */
            }
            // A tool that ignores a polite stop is taken down with its children shortly after.
            setTimeout(
                () => {
                    if (!settled) killTree(child);
                },
                2_000,
            ).unref?.();
        };

        const onAbort = () => stop("cancelled");
        options.signal?.addEventListener("abort", onAbort, { once: true });
        const timer = options.timeoutMs ? setTimeout(() => stop("timeout"), Math.max(1, options.timeoutMs)) : undefined;

        const finish = (code: number | null, signal: NodeJS.Signals | null) => {
            if (settled) return;
            settled = true;
            options.signal?.removeEventListener("abort", onAbort);
            if (timer) clearTimeout(timer);
            resolve({ code, signal, stopped, stopReason, stdout: out.text(), stderr: err.text(), truncated: out.truncated() || err.truncated(), tookMs: Date.now() - startedAt });
        };

        child.on("error", (e) => {
            if (settled) return;
            settled = true;
            options.signal?.removeEventListener("abort", onAbort);
            if (timer) clearTimeout(timer);
            reject(e);
        });
        child.on("close", finish);
    });
}

/** What `withSecureTempDir` hands back: a directory for one run, and a way to take it away again. */
export interface SecureTempDir {
    dir: string;
    /** Write a file with owner-only permissions and return its path. */
    write(name: string, content: string): Promise<string>;
    /** Remove everything in it. Never throws. */
    remove(): Promise<void>;
}

/**
 * A directory for one run's temporary artifacts, created with owner-only permissions and removed on the way out. It lives in the
 * system temporary directory, never under the data directory (where reports and findings are), and never in the repository.
 */
export async function withSecureTempDir(prefix: string): Promise<SecureTempDir> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `freit-${prefix}-`));
    if (process.platform !== "win32") await fsp.chmod(dir, 0o700).catch(() => undefined);
    return {
        dir,
        write: async (name, content) => {
            const file = path.join(dir, path.basename(name));
            await fsp.writeFile(file, content, { mode: 0o600 });
            return file;
        },
        remove: async () => {
            await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        },
    };
}

/** True when `child` is inside `parent` (used to prove an artifact was written where it should be, and nowhere else). */
export function insideDir(child: string, parent: string): boolean {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Does this path exist as a readable file? Used by every adapter before it reports a tool as installed. */
export function isExecutableFile(file: string): boolean {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

/** Does this path exist as a directory? Used for template directories and scanner work directories. */
export function isDirectory(dir: string): boolean {
    try {
        return fs.statSync(dir).isDirectory();
    } catch {
        return false;
    }
}
