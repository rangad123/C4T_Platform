/**
 * Make sure a desktop run leaves nothing behind.
 *
 * Every helper process, and every application it starts, writes itself to a ledger file (pid and start time) in the run's
 * private folder. After the run, whatever it did, this reads the ledgers and stops any of those processes that is still alive.
 * A process is only stopped when its start time still matches the ledger, so a process id the system reused for something else
 * is never touched. A normal run finds nothing to stop: the helper and the application close themselves.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export interface LedgerEntry {
    kind: "host" | "app";
    pid: number;
    /** Process start time as a Windows file time (what `Process.StartTime.ToFileTimeUtc()` returns), kept as DIGITS because it is larger than a JavaScript number can hold exactly. */
    start: string;
}

/** Entries of one ledger file; lines that are not valid are skipped. */
export function parseLedger(text: string): LedgerEntry[] {
    const out: LedgerEntry[] = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
            const j = JSON.parse(line) as Record<string, unknown>;
            if ((j.kind === "host" || j.kind === "app") && Number.isInteger(j.pid) && (j.pid as number) > 0 && typeof j.start === "string" && /^\d{10,20}$/.test(j.start)) out.push({ kind: j.kind, pid: j.pid as number, start: j.start });
        } catch {
            /* a half-written line */
        }
    }
    return out;
}

const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
    }
};

export type KillCheck = (entries: LedgerEntry[]) => Promise<number>;

/** The real check: one short PowerShell run that compares start times and stops matching processes with their trees. Numbers only go into its text. */
export const stopMatching: KillCheck = (entries) =>
    new Promise((resolve) => {
        // Each entry is the text "pid:starttime" (digits only; parseLedger guarantees it): one flat list of strings, so a single entry cannot be flattened into a wrong shape.
        const list = entries.map((e) => `'${Math.trunc(e.pid)}:${e.start.replace(/\D/g, "")}'`).join(",");
        const script = `$k = 0; foreach ($e in @(${list})) { $pair = ([string]$e).Split(':'); $p = Get-Process -Id ([int]$pair[0]) -ErrorAction SilentlyContinue; if ($p -and [string]$p.StartTime.ToFileTimeUtc() -eq $pair[1]) { & (Join-Path $env:SystemRoot 'System32\\taskkill.exe') /PID $pair[0] /T /F 2>&1 | Out-Null; $k++ } }; $k`;
        const exe = path.win32.join(process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        try {
            execFile(exe, ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 30_000, windowsHide: true }, (error, stdout) => resolve(error ? 0 : Number.parseInt(String(stdout).trim(), 10) || 0));
        } catch {
            resolve(0);
        }
    });

/** Stop whatever the ledgers in `dir` list that is still running, then remove the folder. Returns how many processes had to be stopped. */
export async function sweepRunFolder(dir: string, stop: KillCheck = stopMatching): Promise<number> {
    let stopped = 0;
    try {
        const names = (await fs.readdir(dir)).filter((n) => n.endsWith(".jsonl"));
        const entries: LedgerEntry[] = [];
        for (const n of names) entries.push(...parseLedger(await fs.readFile(path.join(dir, n), "utf8").catch(() => "")));
        const running = entries.filter((e) => alive(e.pid));
        if (running.length > 0) stopped = await stop(running);
    } catch {
        /* no folder, nothing to sweep */
    }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => undefined);
    return stopped;
}
