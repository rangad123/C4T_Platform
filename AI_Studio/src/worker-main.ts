import { loadConfiguredPlugins } from "./engine/frameworks/plugin-loader.js";
import { bootstrap } from "./platform/bootstrap.js";
import { installCrashGuard } from "./platform/crash-guard.js";
import { secretKeyNote } from "./platform/secrets.js";
import { getRunbookServices } from "./platform/runbook-runner.js";
import { getScheduleServices } from "./platform/schedule-services.js";
import { installProcessLogging, startProcessOps } from "./platform/ops/process.js";
import { applyServerNetwork } from "./platform/outbound-network.js";
import { Worker } from "./platform/worker.js";
import { runnersOnly } from "./platform/runner-only.js";
import { startStandaloneAssessmentLoop } from "./security/standalone.js";

// Standalone worker process: run with WORKER_EMBEDDED=false on the API process.
installCrashGuard();
// LOG_FORMAT=json and the error-line count: before anything writes a line (platform/ops/process.ts).
const ops = installProcessLogging();
// Company networks: outbound calls honour HTTPS_PROXY / NO_PROXY and the computer's certificate store (platform/outbound-network.ts).
for (const line of applyServerNetwork()) console.log(line);
const platform = bootstrap();
// Where the encryption key came from, said once (never the key): the key file in the data folder is for self-hosted installs (platform/secrets.ts).
const keyNote = secretKeyNote(platform.config);
if (keyNote) (platform.config.SECRET_KEY ? console.warn : console.log)(`[security] ${keyNote}`);
// A standalone worker runs the jobs, so it needs the same adapter plug-ins as the API process (same environment, same rules).
await loadConfiguredPlugins(platform.config);
const schedules = getScheduleServices(platform);
// A runbook run left going by a process that is gone is marked interrupted (never resumed).
const runbooks = getRunbookServices(platform);
runbooks.recover();
// EXECUTION_MODE=runners: this process may only hand runs to runners (the API process already does; a second one is safe, jobs are claimed
// atomically), and security assessments, which use a browser here, do not run (runner-only.ts).
const runners = runnersOnly(platform.config);
const worker = runners ? Worker.dispatch({ ...platform, onJobFinished: schedules.onJobFinished }, platform.config.WORKER_POLL_MS) : new Worker({ ...platform, onJobFinished: schedules.onJobFinished }, platform.config.WORKER_POLL_MS);
worker.start();
console.log(runners ? "[worker] standalone dispatch worker started: tests run only on runners" : "[worker] standalone worker started");
// Security assessments run in their own loop (src/security), next to the functional worker, never inside it.
const stopAssessments = runners ? undefined : startStandaloneAssessmentLoop(platform);
process.once("beforeExit", () => void stopAssessments?.());
// Safe next to the API process's own scheduler: a due schedule is claimed atomically, so only one acts on it.
if (platform.config.SCHEDULER_ENABLED) schedules.scheduler.start();

// Worker heartbeat (GET /readyz of the API process reads it), scheduled backups (BACKUP_DIR; one per slot even with two processes) and the
// graceful shutdown: let the running job finish up to SHUTDOWN_GRACE_SECONDS, then stop it and record it as interrupted.
const shutdown = startProcessOps({
    platform,
    settings: ops,
    worker,
    runsSchedules: platform.config.SCHEDULER_ENABLED,
    stopScheduler: () => schedules.scheduler.stop(),
    stopRunbooks: () => runbooks.stop(),
    flush: () => schedules.flush(),
});
process.on("SIGINT", (s) => void shutdown(s));
process.on("SIGTERM", (s) => void shutdown(s));
