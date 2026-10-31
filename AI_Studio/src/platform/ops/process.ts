/**
 * The ops pieces a platform process starts (src/main.ts and src/worker-main.ts): log format, worker heartbeat, scheduled backups and the
 * graceful shutdown. Kept here so the two entry files only gain a few lines.
 */
import type { FastifyInstance } from "fastify";
import type { Platform } from "../bootstrap.js";
import { opsRuntimeFor } from "../routes/ops.js";
import { startBackupSchedule, type BackupSchedule } from "./backup-schedule.js";
import { startHeartbeat } from "./heartbeat.js";
import { createOpsLogger, installConsole, serverSecrets } from "./logger.js";
import { loadOpsSettings, type OpsSettings } from "./settings.js";
import { createShutdown } from "./shutdown.js";

/** First thing a process does: the log format (LOG_FORMAT=json) and the error-line count for /metrics. Says once what it did not understand. */
export function installProcessLogging(env: NodeJS.ProcessEnv = process.env): OpsSettings {
    const settings = loadOpsSettings(env);
    installConsole(settings.logFormat, serverSecrets(env));
    for (const p of settings.problems) console.warn(`[ops] ${p}`);
    return settings;
}

export interface ProcessParts {
    platform: Platform;
    settings: OpsSettings;
    app?: FastifyInstance;
    worker?: { stop(): Promise<void>; readonly leaseOwner: string };
    /** This process runs the scheduler (and so the backup schedule). */
    runsSchedules: boolean;
    stopScheduler: () => Promise<void>;
    stopRunbooks: () => Promise<void>;
    flush: () => Promise<void>;
}

/** Start the heartbeat (when this process runs the worker) and the backup schedule; returns the signal handler. */
export function startProcessOps(parts: ProcessParts): (signal: string) => Promise<void> {
    const { platform, settings } = parts;
    const log = createOpsLogger(settings.logFormat, serverSecrets());
    const stopBeat = parts.worker ? startHeartbeat(platform.db) : undefined;
    let backups: BackupSchedule | undefined;
    if (parts.runsSchedules && settings.backupDir && settings.backupCadence.kind !== "off") {
        backups = startBackupSchedule(
            {
                db: platform.db,
                dataDir: platform.config.dataDir,
                secretKeyFromEnv: Boolean(platform.config.SECRET_KEY),
                dir: settings.backupDir,
                keep: settings.backupKeep,
                ...(settings.backupUploadCommand ? { uploadCommand: settings.backupUploadCommand } : {}),
                log: (level, msg) => log.log(level, msg),
            },
            settings.backupCadence,
        );
        log.log("info", `[backup] Scheduled backups on (keeping ${settings.backupKeep}).`);
    }
    const state = (parts.app && opsRuntimeFor(parts.app)?.state) || { shuttingDown: false };
    return createShutdown({
        repo: platform.repo,
        db: platform.db,
        ...(parts.worker ? { worker: parts.worker } : {}),
        stopTakingWork: [parts.stopScheduler, parts.stopRunbooks, () => backups?.stop(), () => stopBeat?.()],
        ...(parts.app ? { closeServer: () => parts.app!.close() } : {}),
        flush: parts.flush,
        graceMs: settings.shutdownGraceMs,
        log: (level, msg) => log.log(level, msg),
        exit: (code) => process.exit(code),
        state,
    });
}
