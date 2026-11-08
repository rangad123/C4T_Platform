# Production hosting: health, metrics, logs, shutdown, scheduled backups

What a person running the platform on a server gets: probes for an orchestrator or load balancer, Prometheus metrics, JSON logs without secrets, a shutdown that does not leave jobs looking as if they were running, verified database backups on a schedule, and a deploy kit (Docker Compose with automatic HTTPS, or systemd). Testers see nothing of this. The step-by-step server guide is [deploy/README.md](../../deploy/README.md); the short admin view is the "Production hosting" section of the [admin guide](../ADMIN_GUIDE.md).

## Endpoints

These sit **outside `/api/`** (probes and Prometheus are not people). They are registered by `src/platform/routes/ops.ts`.

| Address | Key | Answer |
|---|---|---|
| `GET /healthz` | none | `200 {"status":"ok"}` while the process answers. Looks at nothing else, so a busy database never makes Docker restart a healthy process. `GET /api/health` still works as before. |
| `GET /readyz` | none | `200 {"status":"ready"}`, or `503 {"status":"not ready","failing":[…]}` with the short names of failing checks only. |
| `GET /metrics` | API key (`x-api-key`) or `METRICS_TOKEN` (`Authorization: Bearer …`) when either is set | Prometheus text format 0.0.4. Open only when the whole platform is open (no `API_KEY`, no `METRICS_TOKEN`). A person's own API token is not accepted here. |

### Readiness checks

| Name | Fails when |
|---|---|
| `database` | the database cannot take its write lock (`BEGIN IMMEDIATE` then rolled back: nothing is written) |
| `migrations` | the database's recorded schema version is lower than the migrations this code knows (`knownSchemaVersion()` in `db.ts`) |
| `worker` | no worker wrote its heartbeat for `WORKER_STALE_SECONDS` (default 90). The heartbeat is `<DATA_DIR>/ops/worker-heartbeat.json` (a time and a process id), rewritten every 15 s by whichever process runs the worker (the API process with `WORKER_EMBEDDED`, or `npm run worker`). An API process with `WORKER_EMBEDDED=false` and no worker running is therefore not ready. |
| `disk` | free space on the data folder's disk is below `READY_MIN_FREE_MB` (default 500; `0` turns the check off) |
| `shutdown` | the process received SIGTERM/SIGINT and is stopping |

The answer never holds a path, version, number or secret.

### Metrics

From the database at scrape time: `aitp_jobs{status}` (every job state), `aitp_job_queue_length`, `aitp_job_duration_seconds{mode}` (histogram of finished jobs, `generate` = exploration, `validate` = run), `aitp_ai_calls_total`, `aitp_ai_failed_calls_total`, `aitp_ai_tokens_total{direction}`, `aitp_ai_estimated_cost_total{currency}` (from the prices set in Settings, AI usage; models without a price count 0 and their tokens are in `aitp_ai_unpriced_tokens_total`), `aitp_runners{state="online"|"offline"}`, `aitp_database_bytes`, `aitp_disk_free_bytes`, `aitp_worker_heartbeat_age_seconds`, and with `BACKUP_DIR` set `aitp_backup_last_success_time_seconds`, `aitp_backup_last_ok`, `aitp_backups_kept`.

From this process since it started: `aitp_http_requests_total{method,route,status}`, `aitp_http_request_duration_seconds{method,route}` (histogram), `aitp_http_server_errors_total` (5xx answers), `aitp_log_error_lines_total`, `aitp_process_start_time_seconds`, `aitp_process_resident_memory_bytes`, `aitp_build_info{version}`.

`route` is the route **template** (`/api/projects/:id`), never the address, so ids, tickets and trigger tokens never become labels. Requests that match no route count as `unmatched`; after 400 distinct label sets new ones count under `route="other"`. With a standalone worker the HTTP numbers are the API process's only (the worker serves no HTTP); everything from the database is shared.

## Request ids and structured logs

Every answer carries `x-request-id`: the caller's own value when it is 1 to 64 letters, digits, `.`, `_` or `-` (a load balancer's id passes through), otherwise a new UUID. Refusals (401, 404) carry one too.

`LOG_FORMAT=json` turns every line the platform writes into one JSON object per line: `time`, `level` (`debug|info|warn|error`), `msg`, and when known `component` (from the usual `[worker]`, `[scheduler]`, `[backup]`… prefix), `job` (the 8-character job id job lines carry), `requestId`. Each answered request adds a line `{"msg":"request","component":"http","requestId","method","route","status","durationMs"}` (route template, never the address; successful `/healthz` and `/readyz` probes are not logged). Info and debug go to stdout, warnings and errors to stderr. Fastify's own error log (pino) was JSON already. Without `LOG_FORMAT=json` the usual text lines are written exactly as before.

**Secrets are scrubbed** from every JSON line and every ops line: the server's own secret values (`API_KEY`, `SECRET_KEY`, `LLM_API_KEY`, `SMTP_PASSWORD`, `METRICS_TOKEN`, `OIDC_CLIENT_SECRET`) by the run-secret scrubber (`scrubSecrets` in `agent-routing.ts`), deploy-trigger tokens and stream tickets by their own redactions (`redactTriggerUrl`, `redactStreamUrl`), and credential shapes: `Bearer`/`Basic` values, JWTs, and secret query parameters (`?token=`, `?key=`, `?password=`, `?code=`, …). Lines are cut at 8,000 characters. Tests check this with sentinel values.

## Graceful shutdown

On SIGTERM or SIGINT (`src/platform/ops/shutdown.ts`, used by `src/main.ts` and `src/worker-main.ts`):

1. `/readyz` answers 503 from now on.
2. The scheduler, run sequences, scheduled backups and the heartbeat stop; the worker stops claiming jobs. The HTTP server keeps answering meanwhile (people can still look; new jobs stay queued for the next start).
3. The running job gets `SHUTDOWN_GRACE_SECONDS` (default 60) to finish. If it does, it keeps its real result. A job waiting for a runner is not waited for: it is handed over with its runner task left running, and the next start picks it up ([runner-restarts.md](runner-restarts.md)).
4. If not, it is stopped the way a person's Stop does: its own stop path closes its browsers and test processes, keeps the results of tests that finished and puts the others back to what they were. After at most 20 more seconds the job is recorded as **failed with "Interrupted: the platform was shut down before this job finished. Start it again when the platform is back."**, an event `job_interrupted` says how long it waited, and its lease is cleared so a restart does **not** silently run it again. If the job did not even stop in those 20 s, its tests still marked running go back to "not run yet".
5. The HTTP server closes (this ends recordings and their browsers, and live streams), alerts in flight get 5 s, the log is flushed, the database is closed, exit 0. A second signal exits at once (code 1).

Browsers that Playwright started in this process are also closed by Playwright's own exit handler. The Docker image now starts `node --import tsx src/main.ts` directly (not through `npx`), so `docker stop` reaches the platform; compose files use `init: true` (reaps browser processes) and `stop_grace_period: 90s`; the systemd unit uses `TimeoutStopSec=120`.

## Scheduled backups

Off unless `BACKUP_DIR` is set. This is the disaster-recovery copy of the **whole database** (every project, history, the encrypted secrets, and the Security Assessment module's tables). The per-project zip under Storage and backup stays as it was (it is for moving a project and leaves out secrets and history).

| Setting | Default | Meaning |
|---|---|---|
| `BACKUP_DIR` | none (off) | Folder for backups. Must not be the data folder. Keep it private: it holds the encrypted secrets and, see below, possibly the key. |
| `BACKUP_SCHEDULE` | `daily` (02:30 UTC) | `daily`, `daily@HH:MM` (UTC), `hourly`, `6h` / `every 6h` (1 to 168 hours), `off`. Anything else means daily and a warning at start. |
| `BACKUP_KEEP` | `7` | Verified backups kept (1 to 365); older ones are removed. Only files named `platform-YYYYMMDD-HHMMSS.db` (and their `.secret`) are ever removed. |
| `BACKUP_UPLOAD_COMMAND` | none | Run after each verified backup through the shell, with the file in `$BACKUP_FILE` (and the key file in `$BACKUP_SECRET_FILE` when there is one). For example `aws s3 cp "$BACKUP_FILE" s3://my-bucket/aitp/` or `rclone copy "$BACKUP_FILE" remote:aitp`. 30 minute limit. A failed upload is logged (exit code and the last output lines, scrubbed); the backup itself is kept. |

How one backup is made (`src/platform/ops/backup-schedule.ts`):

1. SQLite's online backup (`node:sqlite` `backup`, page by page, so the server keeps answering) copies the live database to `platform-….db.partial`.
2. The copy is **verified by opening it**: switched to a single-file journal, `PRAGMA quick_check` must answer `ok`, the schema version must equal the live database's, and the projects table must be readable. A copy that fails is deleted, and the failure is logged and shown as `aitp_backup_last_ok 0`. The schedule retries after 15 minutes.
3. Only then is it renamed to `platform-YYYYMMDD-HHMMSS.db` (UTC).
4. When the encryption key lives in the data folder (no `SECRET_KEY` set), `<DATA_DIR>/.secret` is copied beside it as `….db.secret` (mode 0600): without it the stored credentials in the backup cannot be read. With `SECRET_KEY` set, nothing is copied: keep that value safe yourself, with the backups.
5. Older backups beyond `BACKUP_KEEP` are removed, then the upload command runs, then `backup-status.json` in the folder records the result (time, ok, file name, error).

The schedule runs in every process that runs the scheduler (`SCHEDULER_ENABLED`). A lock file in the backup folder and the "is one due?" check (from the newest backup on disk) mean one backup per slot even with an API process and a standalone worker. The first backup is made about 5 seconds after start when none exists yet.

**One now, from a terminal:** `npx tsx src/platform/ops/backup-cli.ts` (same steps). **Check a file:** `npx tsx src/platform/ops/backup-cli.ts --verify FILE`.

**Restore** (the platform stopped): copy the backup over `<DATA_DIR>/platform.db`, delete `platform.db-wal` and `platform.db-shm` if present, put the `.secret` file back as `<DATA_DIR>/.secret` (or set the same `SECRET_KEY`), start. Evidence files (screenshots, recordings, traces in `<DATA_DIR>/generated-tests`) are **not** in the database backup: copy that folder (or snapshot the volume) separately if you need them. Scripts and specs are in the database.

## Database

The platform stays on **SQLite in WAL mode** for a single server. That means: one API process and its workers on the **same machine** (they share the file; never put it on a network file system), one writer at a time (writes are short; `busy_timeout` is 5 s), and the whole platform's capacity is one machine's. In practice this is comfortable for a team running a few jobs at a time and a database of a few GB. Signs it is time to move to a bigger setup: several platform servers are needed, `database` readiness failures under load, or a database of tens of GB. No Postgres port exists.

## Deploy kit

`deploy/docker-compose.prod.yml` (platform plus Caddy with automatic HTTPS, data and backup volumes, health checks, restart policies, log rotation), `deploy/Caddyfile`, `deploy/ai-testing-platform.service` (systemd, without Docker), `deploy/README.md` (the steps for an Ubuntu VPS: domain, DNS, `.env`, start, update, backup and restore, logs, metrics). Changes to the root `Dockerfile`: `/healthz` health check, `node --import tsx` as the main process, `STOPSIGNAL SIGTERM`, a `/backups` folder owned by the runtime user. The root `docker-compose.yml` gained `init: true` and `stop_grace_period: 90s`.

## What is not covered

- **Nothing here was run on a VPS or under Docker.** Docker could not be used on the machine this was built on, so the compose files, the Caddyfile, the image changes and the systemd unit are written by reading the documentation; check them with `docker compose -f deploy/docker-compose.prod.yml config` and `systemd-analyze verify` before relying on them. What was verified locally: the endpoints, metrics, request ids, JSON logs and scrubbing, the shutdown logic with real job rows, and backups on a real database (tests), plus the real program (`node --import tsx src/main.ts`) starting with JSON logs, a ready `/readyz` and a first verified backup.
- **SIGTERM on the real program was not verified here**: Windows cannot deliver SIGTERM to a process (it terminates it). The test for it runs on Linux and macOS only. The shutdown steps themselves are tested by calling them.
- No built-in upload to S3 or another store (no SDK); use `BACKUP_UPLOAD_COMMAND`. Backups are not encrypted by the platform (the secrets inside are, with the key); encrypt the folder or the upload yourself if needed.
- Evidence files are not part of the scheduled backup.
- Metrics are pull only (no push gateway), and HTTP numbers reset when the process restarts (normal for Prometheus counters).
- Logs are not shipped anywhere: they go to stdout/stderr (Docker's log driver, journald).
- `/readyz` checks this machine's worker heartbeat file; workers on other machines cannot share the database anyway.

## Files

`src/platform/ops/{settings,logger,heartbeat,health,metrics,backup-schedule,backup-cli,shutdown,process}.ts`, `src/platform/routes/ops.ts`; additive edits: `src/main.ts`, `src/worker-main.ts`, `src/platform/routes/index.ts` (registration), `src/platform/db.ts` (`knownSchemaVersion`), `src/platform/worker.ts` (`leaseOwner` getter), `Dockerfile`, `docker-compose.yml`, `.env.example`, `docs/ADMIN_GUIDE.md`; `deploy/*`. Tests: `tests/ops-unit.test.ts` (fast tier), `tests/ops.test.ts`.
