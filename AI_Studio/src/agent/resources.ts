/**
 * What a run may take from the runner's computer (docs/features/runner-resources.md). Node has no portable way to put a process in a
 * cgroup or a job object, so the runner does what works the same on Windows, macOS and Linux:
 *  - test processes run at below-normal priority (`os.setPriority` on the task's process; the test runner, its workers and the browsers it
 *    starts inherit it), so the person using the computer keeps a responsive desktop. AITP_AGENT_TEST_PRIORITY=normal switches it off;
 *  - the Node heap of the task's process and of the test runner and its workers is capped (`--max-old-space-size`, default 2048 MB,
 *    AITP_AGENT_TEST_HEAP_MB, 0 = Node's own limit). Browsers are not Node processes and are not capped by it;
 *  - optional, off by default: the memory of the whole process tree (browsers included) is sampled every few seconds and a run over
 *    AITP_AGENT_TEST_MEMORY_MB is stopped with a plain sentence. Linux and macOS only (`ps`); on Windows it is not enforced;
 *  - a run is turned down while the work folder's disk has less than AITP_AGENT_MIN_FREE_MB free (default 512, 0 = off).
 * The per-task time limits stay as they are (task-runner.ts).
 */
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";

export interface ResourceLimits {
    /** os.setPriority value for test processes; undefined = leave them at normal priority. */
    priority?: number;
    /** --max-old-space-size of the test processes, in MB; 0 = Node's own limit. */
    heapMb: number;
    /** Stop a run whose process tree uses more than this (MB); 0 = not watched. */
    memoryMb: number;
    /** Turn a run down while the work folder's disk has less free space than this (MB); 0 = not checked. */
    minFreeMb: number;
}

export const DEFAULT_HEAP_MB = 2048;
export const DEFAULT_MIN_FREE_MB = 512;
/** How often the process tree's memory is looked at when a limit is set. */
export const MEMORY_SAMPLE_MS = 5_000;

const intIn = (raw: string | undefined, fallback: number, min: number, max: number): number => {
    const t = raw?.trim();
    if (!t) return fallback;
    if (!/^\d+$/.test(t)) return fallback;
    const n = Number(t);
    if (n === 0) return 0;
    return Math.min(max, Math.max(min, n));
};

/** The limits from the runner's own environment. Anything unreadable keeps the default. */
export function resourceLimits(env: NodeJS.ProcessEnv): ResourceLimits {
    const p = env.AITP_AGENT_TEST_PRIORITY?.trim().toLowerCase();
    const priority = p === "normal" ? undefined : p === "low" ? os.constants.priority.PRIORITY_LOW : os.constants.priority.PRIORITY_BELOW_NORMAL;
    return {
        ...(priority !== undefined ? { priority } : {}),
        heapMb: intIn(env.AITP_AGENT_TEST_HEAP_MB, DEFAULT_HEAP_MB, 256, 65_536),
        memoryMb: intIn(env.AITP_AGENT_TEST_MEMORY_MB, 0, 256, 1_048_576),
        minFreeMb: intIn(env.AITP_AGENT_MIN_FREE_MB, DEFAULT_MIN_FREE_MB, 1, 1_048_576),
    };
}

/** Lower a process's priority. False when the system did not allow it (the run goes on at normal priority). */
export function lowerPriority(pid: number | undefined, priority: number | undefined): boolean {
    if (!pid || priority === undefined) return false;
    try {
        os.setPriority(pid, priority);
        return true;
    } catch {
        return false;
    }
}

/** Free bytes for this user on the disk that holds `dir`, or undefined when the system does not say. */
export async function freeBytes(dir: string): Promise<number | undefined> {
    try {
        const s = await fsp.statfs(dir);
        return Number(s.bavail) * Number(s.bsize);
    } catch {
        return undefined;
    }
}

const mbOf = (bytes: number): number => Math.floor(bytes / (1024 * 1024));

/** Why this computer does not take a run now (too little free disk space), or undefined. */
export async function lowDiskRefusal(dir: string, minFreeMb: number, free: (d: string) => Promise<number | undefined> = freeBytes): Promise<string | undefined> {
    if (minFreeMb <= 0) return undefined;
    const bytes = await free(dir);
    if (bytes === undefined || bytes >= minFreeMb * 1024 * 1024) return undefined;
    return `This computer has only ${mbOf(bytes)} MB of free disk space where the runner works, and the runner keeps at least ${minFreeMb} MB free (AITP_AGENT_MIN_FREE_MB), so it did not take the run. Free some space, then run again.`;
}

/** The resident memory of a process and everything below it, in bytes. Linux and macOS (`ps`); undefined on Windows or when `ps` fails. */
export function treeMemoryBytes(rootPid: number): Promise<number | undefined> {
    if (process.platform === "win32") return Promise.resolve(undefined);
    return new Promise((resolve) => {
        execFile("ps", ["-A", "-o", "pid=,ppid=,rss="], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
            if (err) return resolve(undefined);
            const children = new Map<number, number[]>();
            const rss = new Map<number, number>();
            for (const line of String(stdout).split("\n")) {
                const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
                if (!m) continue;
                const [pid, ppid, kb] = [Number(m[1]), Number(m[2]), Number(m[3])];
                rss.set(pid, kb * 1024);
                children.set(ppid, [...(children.get(ppid) ?? []), pid]);
            }
            if (!rss.has(rootPid)) return resolve(undefined);
            let total = 0;
            const seen = new Set<number>();
            const stack = [rootPid];
            while (stack.length) {
                const pid = stack.pop()!;
                if (seen.has(pid)) continue;
                seen.add(pid);
                total += rss.get(pid) ?? 0;
                stack.push(...(children.get(pid) ?? []));
            }
            resolve(total);
        });
    });
}

/** The sentence a run stopped for using too much memory ends with. */
export const overMemory = (limitMb: number, usedBytes: number): string =>
    `The run used ${mbOf(usedBytes)} MB of memory, more than the ${limitMb} MB this runner allows (AITP_AGENT_TEST_MEMORY_MB), and was stopped.`;

/**
 * Watch a process tree's memory: `onOver` is called once, with the bytes seen, when it is over `limitMb`. Returns the stop function.
 * Does nothing where the tree cannot be measured (Windows).
 */
export function watchMemory(pid: number | undefined, limitMb: number, onOver: (usedBytes: number) => void, everyMs = MEMORY_SAMPLE_MS, measure: (pid: number) => Promise<number | undefined> = treeMemoryBytes): () => void {
    if (!pid || limitMb <= 0 || process.platform === "win32") return () => undefined;
    let stopped = false;
    let busy = false;
    const timer = setInterval(() => {
        if (busy || stopped) return;
        busy = true;
        void measure(pid)
            .then((used) => {
                if (stopped || used === undefined || used <= limitMb * 1024 * 1024) return;
                stopped = true;
                clearInterval(timer);
                onOver(used);
            })
            .finally(() => (busy = false));
    }, everyMs);
    timer.unref?.();
    return () => {
        stopped = true;
        clearInterval(timer);
    };
}
