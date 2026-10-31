/**
 * Scheduled backups of the whole platform database (BACKUP_DIR, BACKUP_SCHEDULE, BACKUP_KEEP, BACKUP_UPLOAD_COMMAND).
 *
 * The per-project backup (platform/backup.ts, a zip without secrets or history) is for moving a project. This is the disaster-recovery copy:
 * every project, history, and the encrypted secrets, as one SQLite file.
 * - The copy is made with SQLite's online backup (node:sqlite `backup`, page by page, so the server keeps answering) into `<name>.partial`.
 * - It is then **verified by opening it**: switched to a single-file journal, `PRAGMA quick_check` must say ok, and its schema version must be the
 *   one of the live database. Only then is it renamed to `platform-YYYYMMDD-HHMMSS.db`; a copy that fails is removed and the failure is logged and
 *   shown in /metrics (aitp_backup_last_ok 0).
 * - When the encryption key lives in the data folder (no SECRET_KEY in the environment) it is copied beside the backup as `<name>.secret`,
 *   because without it the stored credentials in the backup cannot be read. With SECRET_KEY set, keep that value safe yourself.
 * - The newest BACKUP_KEEP verified backups are kept; older ones (only files with this exact name pattern) are removed.
 * - BACKUP_UPLOAD_COMMAND (optional) runs after each verified backup with the file in $BACKUP_FILE (and the key file, when there is one, in
 *   $BACKUP_SECRET_FILE): e.g. `aws s3 cp "$BACKUP_FILE" s3://bucket/` or `rclone copy "$BACKUP_FILE" remote:bucket`. No cloud SDK is built in.
 * - The API process and a standalone worker may both run the schedule: a lock file in the backup folder and the "is one due?" check (from the
 *   newest backup on disk) mean only one backup is made per slot.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Db } from "../db.js";
import type { BackupCadence } from "./settings.js";

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export const BACKUP_NAME = /^platform-(\d{8})-(\d{6})\.db$/;
const LOCK = ".backup.lock";
const STATUS = "backup-status.json";
const LOCK_STALE_MS = 2 * 3_600_000;
const RETRY_AFTER_FAILURE_MS = 15 * 60_000;
const UPLOAD_TIMEOUT_MS = 30 * 60_000;

export interface BackupStatus {
    lastSuccessAt?: number;
    lastOk?: boolean;
    lastAttemptAt?: number;
    lastError?: string;
    /** File name only (never a full path). */
    lastFile?: string;
    kept: number;
}

export interface BackupJob {
    db: Db;
    dataDir: string;
    /** True when SECRET_KEY comes from the environment (then there is no key file to copy). */
    secretKeyFromEnv: boolean;
    dir: string;
    keep: number;
    uploadCommand?: string;
    log: (level: "info" | "warn" | "error", msg: string) => void;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
export const backupName = (d: Date): string =>
    `platform-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}.db`;

/** When a backup file was made, from its name (UTC). */
export function backupTime(name: string): number | undefined {
    const m = BACKUP_NAME.exec(name);
    if (!m) return undefined;
    const [d, t] = [m[1]!, m[2]!];
    return Date.UTC(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8)), Number(t.slice(0, 2)), Number(t.slice(2, 4)), Number(t.slice(4, 6)));
}

/** Verified backups in the folder, newest first (names only). */
export function listBackups(dir: string): string[] {
    let names: string[];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return [];
    }
    return names.filter((n) => BACKUP_NAME.test(n)).sort().reverse();
}

/** The slot a backup is due for: true when no backup was made since the latest scheduled moment. */
export function isDue(cadence: BackupCadence, lastBackupAt: number | undefined, now: number): boolean {
    if (cadence.kind === "off") return false;
    if (lastBackupAt === undefined) return true;
    if (cadence.kind === "every") return now - lastBackupAt >= cadence.ms;
    const day = new Date(now);
    let slot = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) + cadence.atMinuteUtc * 60_000;
    if (slot > now) slot -= 86_400_000;
    return lastBackupAt < slot;
}

export function readStatus(dir: string): BackupStatus {
    const kept = listBackups(dir).length;
    try {
        const raw = fs.readFileSync(path.join(dir, STATUS), "utf8");
        const s = JSON.parse(raw.slice(0, 8192)) as Partial<BackupStatus>;
        return {
            kept,
            ...(typeof s.lastSuccessAt === "number" ? { lastSuccessAt: s.lastSuccessAt } : {}),
            ...(typeof s.lastOk === "boolean" ? { lastOk: s.lastOk } : {}),
            ...(typeof s.lastAttemptAt === "number" ? { lastAttemptAt: s.lastAttemptAt } : {}),
            ...(typeof s.lastError === "string" ? { lastError: s.lastError.slice(0, 500) } : {}),
            ...(typeof s.lastFile === "string" ? { lastFile: s.lastFile.slice(0, 80) } : {}),
        };
    } catch {
        return { kept };
    }
}

function writeStatus(dir: string, s: Omit<BackupStatus, "kept">): void {
    const file = path.join(dir, STATUS);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, file);
}

/** Open a finished copy and prove it is a whole, readable platform database of the expected version. Throws a plain message otherwise. */
export function verifyBackupFile(file: string, expectedVersion?: number): { version: number } {
    let copy: InstanceType<typeof sqlite.DatabaseSync> | undefined;
    try {
        copy = new sqlite.DatabaseSync(file);
        // A copy of a WAL database is a WAL database: make it one self-contained file, so restoring it is copying one file.
        copy.exec("PRAGMA journal_mode = DELETE");
        const check = copy.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
        const verdict = check.map((r) => String(Object.values(r)[0])).join("; ");
        if (verdict !== "ok") throw new Error(`the copy is damaged (${verdict.slice(0, 200)})`);
        const v = (copy.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null } | undefined)?.v ?? 0;
        if (!v) throw new Error("the copy has no schema version");
        if (expectedVersion !== undefined && v !== expectedVersion) throw new Error(`the copy has schema version ${v}, the live database ${expectedVersion}`);
        copy.prepare("SELECT COUNT(*) AS n FROM projects").get();
        return { version: v };
    } catch (err) {
        throw new Error(`Backup check failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
        try {
            copy?.close();
        } catch {
            /* already closed */
        }
    }
}

function takeLock(dir: string, now: number): boolean {
    const lock = path.join(dir, LOCK);
    for (let i = 0; i < 2; i++) {
        try {
            fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
            return true;
        } catch {
            try {
                if (now - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
                else return false;
            } catch {
                return false;
            }
        }
    }
    return false;
}

function runUpload(command: string, file: string, secretFile: string | undefined): Promise<{ ok: boolean; note: string }> {
    return new Promise((resolve) => {
        const child = spawn(command, { shell: true, windowsHide: true, env: { ...process.env, BACKUP_FILE: file, ...(secretFile ? { BACKUP_SECRET_FILE: secretFile } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
        let tail = "";
        const keep = (b: Buffer) => {
            tail = (tail + b.toString("utf8")).slice(-1000);
        };
        child.stdout?.on("data", keep);
        child.stderr?.on("data", keep);
        const timer = setTimeout(() => child.kill(), UPLOAD_TIMEOUT_MS);
        child.on("error", (err) => {
            clearTimeout(timer);
            resolve({ ok: false, note: err.message });
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ ok: code === 0, note: code === 0 ? "" : `exit code ${code}: ${tail.trim().split("\n").slice(-3).join(" | ")}` });
        });
    });
}

export interface BackupOutcome {
    ok: boolean;
    file?: string;
    error?: string;
    removed: string[];
    uploaded?: boolean;
}

/** Make one backup now: copy, verify, rename, copy the key file, prune, upload. Never throws. */
export async function makeBackup(job: BackupJob, at: Date = new Date()): Promise<BackupOutcome> {
    const dir = job.dir;
    const name = backupName(at);
    const final = path.join(dir, name);
    const partial = `${final}.partial`;
    const attemptAt = at.getTime();
    const previous = (() => {
        try {
            return readStatus(dir);
        } catch {
            return { kept: 0 } as BackupStatus;
        }
    })();
    try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (path.resolve(dir) === path.resolve(job.dataDir)) throw new Error("BACKUP_DIR must not be the data folder itself");
        fs.rmSync(partial, { force: true });
        const expected = (job.db.get<{ v: number | null }>("SELECT MAX(version) AS v FROM schema_version")?.v ?? 0) || undefined;
        await sqlite.backup(job.db.raw, partial, { rate: 256 });
        verifyBackupFile(partial, expected);
        fs.renameSync(partial, final);
        let secretFile: string | undefined;
        if (!job.secretKeyFromEnv) {
            const keyFile = path.join(job.dataDir, ".secret");
            if (fs.existsSync(keyFile)) {
                secretFile = `${final}.secret`;
                fs.copyFileSync(keyFile, secretFile);
                fs.chmodSync(secretFile, 0o600);
            }
        }
        const removed = pruneBackups(dir, job.keep);
        let uploaded: boolean | undefined;
        if (job.uploadCommand) {
            const up = await runUpload(job.uploadCommand, final, secretFile);
            uploaded = up.ok;
            if (!up.ok) job.log("error", `[backup] The upload command failed for ${name}: ${up.note}. The backup itself is kept in the backup folder.`);
        }
        writeStatus(dir, { lastSuccessAt: attemptAt, lastOk: true, lastAttemptAt: attemptAt, lastFile: name });
        job.log("info", `[backup] Made and verified ${name}${removed.length ? `, removed ${removed.length} older` : ""}${uploaded ? ", uploaded" : ""}.`);
        return { ok: true, file: name, removed, ...(uploaded !== undefined ? { uploaded } : {}) };
    } catch (err) {
        fs.rmSync(partial, { force: true });
        const msg = err instanceof Error ? err.message : String(err);
        try {
            writeStatus(dir, { ...(previous.lastSuccessAt !== undefined ? { lastSuccessAt: previous.lastSuccessAt, lastFile: previous.lastFile } : {}), lastOk: false, lastAttemptAt: attemptAt, lastError: msg.slice(0, 500) });
        } catch {
            /* the folder itself is the problem; the log line says so */
        }
        job.log("error", `[backup] The scheduled backup failed: ${msg}`);
        return { ok: false, error: msg, removed: [] };
    }
}

/** Keep the newest `keep` backups; remove older ones (and their key files). Only files named like a backup are ever removed. */
export function pruneBackups(dir: string, keep: number): string[] {
    const removed: string[] = [];
    for (const old of listBackups(dir).slice(Math.max(1, keep))) {
        fs.rmSync(path.join(dir, old), { force: true });
        fs.rmSync(path.join(dir, `${old}.secret`), { force: true });
        removed.push(old);
    }
    return removed;
}

export interface BackupSchedule {
    /** Run the due check now (the timer calls it every minute). */
    tick(now?: Date): Promise<BackupOutcome | undefined>;
    /** Stop the timer and wait for a backup in progress (at most `waitMs`). */
    stop(waitMs?: number): Promise<void>;
}

export function startBackupSchedule(job: BackupJob, cadence: BackupCadence, tickMs = 60_000): BackupSchedule {
    let running: Promise<BackupOutcome | undefined> | undefined;
    const tick = async (nowDate: Date = new Date()): Promise<BackupOutcome | undefined> => {
        if (running) return undefined;
        const now = nowDate.getTime();
        const newest = listBackups(job.dir)[0];
        if (!isDue(cadence, newest ? backupTime(newest) : undefined, now)) return undefined;
        const status = readStatus(job.dir);
        if (status.lastOk === false && status.lastAttemptAt !== undefined && now - status.lastAttemptAt < RETRY_AFTER_FAILURE_MS) return undefined;
        try {
            fs.mkdirSync(job.dir, { recursive: true, mode: 0o700 });
        } catch {
            /* makeBackup reports it */
        }
        if (!takeLock(job.dir, now)) return undefined;
        running = makeBackup(job, nowDate).finally(() => {
            fs.rmSync(path.join(job.dir, LOCK), { force: true });
            running = undefined;
        });
        return running;
    };
    const timer = cadence.kind === "off" ? undefined : setInterval(() => void tick(), tickMs);
    timer?.unref();
    if (cadence.kind !== "off") setTimeout(() => void tick(), 5_000).unref();
    return {
        tick,
        async stop(waitMs = 30_000) {
            if (timer) clearInterval(timer);
            if (running) await Promise.race([running, new Promise((r) => setTimeout(r, waitMs).unref())]);
        },
    };
}
