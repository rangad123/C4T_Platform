/**
 * Make one verified backup now, or check a backup file, from a terminal (before an update, or to test a restore):
 *   npx tsx src/platform/ops/backup-cli.ts                 one backup into BACKUP_DIR (same checks, key file and pruning as the schedule)
 *   npx tsx src/platform/ops/backup-cli.ts --verify FILE   open FILE and check it (it is switched to a single-file journal; nothing else changes)
 * Exit code 0 = ok, 1 = failed (the reason is printed).
 */
import { loadConfig } from "../../config.js";
import { Db } from "../db.js";
import { makeBackup, verifyBackupFile } from "./backup-schedule.js";
import { loadOpsSettings } from "./settings.js";

const args = process.argv.slice(2);
const verifyAt = args.indexOf("--verify");
if (verifyAt >= 0) {
    const file = args[verifyAt + 1];
    if (!file) {
        console.error("Give the backup file after --verify.");
        process.exit(1);
    }
    try {
        const { version } = verifyBackupFile(file);
        console.log(`The backup opens and checks ok (schema version ${version}).`);
        process.exit(0);
    } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }
}

const config = loadConfig();
const ops = loadOpsSettings();
if (!ops.backupDir) {
    console.error("Set BACKUP_DIR to the folder backups go to (outside the data folder), then run this again.");
    process.exit(1);
}
const db = new Db(config.dbPath);
const out = await makeBackup({
    db,
    dataDir: config.dataDir,
    secretKeyFromEnv: Boolean(config.SECRET_KEY),
    dir: ops.backupDir,
    keep: ops.backupKeep,
    ...(ops.backupUploadCommand ? { uploadCommand: ops.backupUploadCommand } : {}),
    log: (level, msg) => (level === "error" ? console.error(msg) : console.log(msg)),
});
db.close();
process.exit(out.ok ? 0 : 1);
