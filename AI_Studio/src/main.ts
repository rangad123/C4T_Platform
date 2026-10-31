import { loadConfiguredPlugins } from "./engine/frameworks/plugin-loader.js";
import { installCrashGuard } from "./platform/crash-guard.js";
import { secretKeyNote } from "./platform/secrets.js";
import { bootstrap } from "./platform/bootstrap.js";
import { getRunbookServices } from "./platform/runbook-runner.js";
import { getScheduleServices } from "./platform/schedule-services.js";
import { installProcessLogging, startProcessOps } from "./platform/ops/process.js";
import { applyServerNetwork } from "./platform/outbound-network.js";
import { buildServer } from "./platform/server.js";
import { Worker } from "./platform/worker.js";

installCrashGuard();
// LOG_FORMAT=json and the error-line count for /metrics: before anything writes a line (platform/ops/process.ts).
const ops = installProcessLogging();
// Company networks: outbound calls honour HTTPS_PROXY / NO_PROXY and the computer's certificate store (platform/outbound-network.ts).
for (const line of applyServerNetwork()) console.log(line);
const platform = bootstrap();
// Where the encryption key came from, said once (never the key): the key file in the data folder is for self-hosted installs (platform/secrets.ts).
const keyNote = secretKeyNote(platform.config);
if (keyNote) (platform.config.SECRET_KEY ? console.warn : console.log)(`[security] ${keyNote}`);
// Adapter plug-ins (off unless ALLOW_ADAPTER_PLUGINS=true with an API_KEY) are loaded before the server accepts a request or the worker claims a job.
await loadConfiguredPlugins(platform.config);
const app = await buildServer(platform);
const schedules = getScheduleServices(platform);
// A runbook run left going by a process that is gone is marked interrupted (never resumed).
const runbooks = getRunbookServices(platform);
runbooks.recover();

if (!platform.config.API_KEY && platform.config.HOST !== "127.0.0.1" && platform.config.HOST !== "localhost") {
    console.warn("[security] API_KEY is not set but the server is listening on a non-loopback address. Set API_KEY.");
}
if (platform.config.customScriptsReason) {
    // Loud and once: someone asked for hand-written scripts on this server, but without an API key that would be remote code execution for anyone who can reach the port.
    console.warn(`[security] ${platform.config.customScriptsReason}`);
} else if (platform.config.ALLOW_CUSTOM_SCRIPTS) {
    console.warn("[security] ALLOW_CUSTOM_SCRIPTS is on: anyone who can edit tests (everyone with the API key) can run code on this server. Only use it among people you trust.");
}
if (platform.llm.modelName === "unavailable") {
    console.warn(`[llm] No LLM credentials configured (provider: ${platform.config.LLM_PROVIDER}). Web test generation will fail until they are set; OpenAPI-driven API tests still work.`);
} else {
    console.log(`[llm] ${platform.config.LLM_PROVIDER} / ${platform.llm.modelName}`);
}

let worker: Worker | undefined;
if (platform.config.WORKER_EMBEDDED) {
    worker = new Worker({ ...platform, onJobFinished: schedules.onJobFinished }, platform.config.WORKER_POLL_MS);
    worker.start();
    console.log("[worker] embedded worker started");
    if (platform.config.SCHEDULER_ENABLED) {
        schedules.scheduler.start();
        console.log(`[scheduler] started (checks every ${platform.config.SCHEDULER_TICK_MS / 1000}s)`);
    }
}

await app.listen({ port: platform.config.PORT, host: platform.config.HOST });
console.log(`AI Testing Platform listening on http://${platform.config.HOST}:${platform.config.PORT}`);

// Worker heartbeat, scheduled backups (BACKUP_DIR) and the graceful shutdown: stop taking jobs, let the running one finish up to
// SHUTDOWN_GRACE_SECONDS, then stop it and record it as interrupted; close the server (recordings, streams), let alerts in flight finish.
const shutdown = startProcessOps({
    platform,
    settings: ops,
    app,
    ...(worker ? { worker } : {}),
    runsSchedules: platform.config.SCHEDULER_ENABLED,
    stopScheduler: () => schedules.scheduler.stop(),
    stopRunbooks: () => runbooks.stop(),
    flush: () => schedules.flush(),
});
process.on("SIGINT", (s) => void shutdown(s));
process.on("SIGTERM", (s) => void shutdown(s));
