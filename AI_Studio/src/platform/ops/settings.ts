/**
 * Settings of the production-hosting pieces (health, metrics, logs, shutdown, scheduled backups). Read from the environment only, in this
 * file, so the shared config.ts stays untouched. Anything that is not a valid value counts as "not set" (the default), like the retention
 * setting does: a typo in .env must never stop the platform from starting.
 */
import path from "node:path";

export type BackupCadence = { kind: "off" } | { kind: "every"; ms: number } | { kind: "daily"; atMinuteUtc: number };

export interface OpsSettings {
    /** `json` = one JSON object per log line (LOG_FORMAT=json); `text` = the platform's usual lines. */
    logFormat: "text" | "json";
    /** A token that may read GET /metrics instead of the API key (Authorization: Bearer <token>). */
    metricsToken?: string;
    /** How long a stopping platform waits for the running job before it stops it (SHUTDOWN_GRACE_SECONDS, default 60). */
    shutdownGraceMs: number;
    /** GET /readyz fails when the data folder's disk has less free space than this (READY_MIN_FREE_MB, default 500). */
    minFreeBytes: number;
    /** GET /readyz fails when no worker has said it is alive for this long (WORKER_STALE_SECONDS, default 90). */
    workerStaleMs: number;
    /** Where scheduled backups go (BACKUP_DIR). Scheduled backups are off without it. */
    backupDir?: string;
    backupCadence: BackupCadence;
    /** How many verified backups to keep (BACKUP_KEEP, 1-365, default 7). */
    backupKeep: number;
    /** Optional command run after each verified backup, with the file in $BACKUP_FILE (BACKUP_UPLOAD_COMMAND). */
    backupUploadCommand?: string;
}

const HOUR = 3_600_000;

function wholeNumber(raw: string | undefined, min: number, max: number): number | undefined {
    const t = (raw ?? "").trim();
    if (!/^\d+$/.test(t)) return undefined;
    const n = Number(t);
    return n >= min && n <= max ? n : undefined;
}

/**
 * BACKUP_SCHEDULE: `daily` (the default when BACKUP_DIR is set; at 02:30 UTC), `daily@HH:MM` (UTC), `hourly`, `every 6h` / `6h` (1-168 hours), `off`.
 * Anything else falls back to daily, and `scheduleProblem` says so (shown once at start).
 */
export function parseBackupSchedule(raw: string | undefined): { cadence: BackupCadence; problem?: string } {
    const t = (raw ?? "").trim().toLowerCase();
    const daily = { kind: "daily" as const, atMinuteUtc: 2 * 60 + 30 };
    if (!t || t === "daily") return { cadence: daily };
    if (t === "off" || t === "false" || t === "none") return { cadence: { kind: "off" } };
    if (t === "hourly") return { cadence: { kind: "every", ms: HOUR } };
    const at = /^daily@([01]?\d|2[0-3]):([0-5]\d)$/.exec(t);
    if (at) return { cadence: { kind: "daily", atMinuteUtc: Number(at[1]) * 60 + Number(at[2]) } };
    const every = /^(?:every\s*)?(\d{1,3})\s*h$/.exec(t);
    if (every && Number(every[1]) >= 1 && Number(every[1]) <= 168) return { cadence: { kind: "every", ms: Number(every[1]) * HOUR } };
    return { cadence: daily, problem: `BACKUP_SCHEDULE "${t.slice(0, 40)}" is not understood, so backups run daily at 02:30 UTC. Use daily, daily@HH:MM, hourly, 6h or off.` };
}

export function loadOpsSettings(env: NodeJS.ProcessEnv = process.env): OpsSettings & { problems: string[] } {
    const problems: string[] = [];
    const schedule = parseBackupSchedule(env.BACKUP_SCHEDULE);
    if (schedule.problem && env.BACKUP_DIR?.trim()) problems.push(schedule.problem);
    const token = env.METRICS_TOKEN?.trim();
    if (token && token.length < 16) problems.push("METRICS_TOKEN is shorter than 16 characters and is ignored. Use a long random value.");
    const dir = env.BACKUP_DIR?.trim();
    const upload = env.BACKUP_UPLOAD_COMMAND?.trim();
    return {
        logFormat: (env.LOG_FORMAT ?? "").trim().toLowerCase() === "json" ? "json" : "text",
        ...(token && token.length >= 16 ? { metricsToken: token } : {}),
        shutdownGraceMs: (wholeNumber(env.SHUTDOWN_GRACE_SECONDS, 0, 3600) ?? 60) * 1000,
        minFreeBytes: (wholeNumber(env.READY_MIN_FREE_MB, 0, 10_000_000) ?? 500) * 1024 * 1024,
        workerStaleMs: (wholeNumber(env.WORKER_STALE_SECONDS, 15, 86_400) ?? 90) * 1000,
        ...(dir ? { backupDir: path.resolve(dir) } : {}),
        backupCadence: dir ? schedule.cadence : { kind: "off" },
        backupKeep: wholeNumber(env.BACKUP_KEEP, 1, 365) ?? 7,
        ...(upload ? { backupUploadCommand: upload } : {}),
        problems,
    };
}
