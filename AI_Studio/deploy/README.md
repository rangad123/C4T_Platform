# Run the platform on a small server (Ubuntu VPS)

Step by step, for one server with a domain name and automatic HTTPS. What each piece does is in [docs/features/production-hosting.md](../docs/features/production-hosting.md).

> Honest note: these files were written and checked by reading the Docker, Caddy and systemd documentation. They have **not** been run on a VPS or under Docker yet. Run the check commands in each step.

## What you need

- A VPS with Ubuntu 22.04 or 24.04, **at least 2 CPUs and 4 GB of RAM** (each browser in a run takes a few hundred MB), 20 GB of disk or more.
- A domain or subdomain you control (for example `tests.example.com`).
- An AI service key (Anthropic, OpenAI, Google or a compatible service) for web exploration.
- Optional: an S3-compatible bucket or any place `rclone` can copy to, for off-server backups.

## 1. DNS

Create an `A` record (and `AAAA` if the server has IPv6) for your domain pointing at the server's address. Check: `dig +short tests.example.com` shows the server's address. Caddy gets the HTTPS certificate only once this works and ports 80 and 443 are open.

## 2. Server basics

```bash
sudo apt update && sudo apt upgrade -y
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp && sudo ufw enable
# Docker Engine and the compose plugin (from Docker's own instructions):
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # sign out and in again
docker compose version
```

## 3. Get the code and write `.env`

```bash
git clone <your repository address> ai-testing-platform && cd ai-testing-platform
cp .env.example .env
```

Edit `.env` and set at least:

```bash
DOMAIN=tests.example.com
PUBLIC_URL=https://tests.example.com
API_KEY=<a long random value: openssl rand -hex 32>
SECRET_KEY=<another long random value: openssl rand -hex 32>   # keep a copy outside the server: backups need it
LLM_PROVIDER=anthropic
LLM_API_KEY=<your AI service key>
BLOCK_PRIVATE_TARGETS=true          # a hosted platform should not test the server's own network
# Optional:
METRICS_TOKEN=<openssl rand -hex 24>   # lets Prometheus read /metrics without the API key
BACKUP_SCHEDULE=daily@02:30
BACKUP_KEEP=14
# BACKUP_UPLOAD_COMMAND=rclone copy "$BACKUP_FILE" remote:aitp-backups
```

`HOST`, `DATA_DIR`, `BACKUP_DIR` and `LOG_FORMAT` are set by the compose file. Never commit `.env`.

## 4. Start

```bash
docker compose -f deploy/docker-compose.prod.yml config > /dev/null && echo "compose file ok"
docker compose -f deploy/docker-compose.prod.yml up -d --build
docker compose -f deploy/docker-compose.prod.yml ps        # platform should become "healthy" within about a minute
curl -fsS https://tests.example.com/healthz                 # {"status":"ok"}
curl -fsS https://tests.example.com/readyz                  # {"status":"ready"}
```

Open `https://tests.example.com`, enter the access key (`API_KEY`), and create the first owner account if people accounts are offered.

If `/readyz` says `"failing":["worker"]`, the worker has not started yet (wait a minute) or crashed (see the logs). `"disk"` means less than 500 MB free (`READY_MIN_FREE_MB`).

## 5. Update

```bash
cd ai-testing-platform
docker compose -f deploy/docker-compose.prod.yml exec platform npx tsx src/platform/ops/backup-cli.ts   # a backup first
git pull
docker compose -f deploy/docker-compose.prod.yml up -d --build
```

Stopping the old container sends SIGTERM: a running job gets 60 seconds to finish (`SHUTDOWN_GRACE_SECONDS`), then it is stopped and shown as "Interrupted: the platform was shut down…" so you can start it again. Database migrations run by themselves at start; `/readyz` stays "not ready" (`migrations`) until they are done.

## 6. Backups and restore

With this compose file backups are on: `BACKUP_DIR=/backups` on the `platform-backups` volume, daily at 02:30 UTC unless `BACKUP_SCHEDULE` says otherwise, the newest 7 (`BACKUP_KEEP`) kept, each one checked by opening it.

```bash
# List them
docker compose -f deploy/docker-compose.prod.yml exec platform ls -l /backups
# Copy the newest one off the server (run on your own computer)
scp <server>:/var/lib/docker/volumes/ai-testing-platform_platform-backups/_data/platform-YYYYMMDD-HHMMSS.db .
```

Off-server copies: set `BACKUP_UPLOAD_COMMAND` (the tool must exist inside the container, or run the copy from the host with cron instead, for example `rclone copy /var/lib/docker/volumes/ai-testing-platform_platform-backups/_data remote:aitp`).

**Restore:**

```bash
docker compose -f deploy/docker-compose.prod.yml stop platform
docker run --rm -v ai-testing-platform_platform-data:/data -v ai-testing-platform_platform-backups:/backups alpine sh -c \
  'cp /backups/platform-YYYYMMDD-HHMMSS.db /data/platform.db && rm -f /data/platform.db-wal /data/platform.db-shm && chown 10001 /data/platform.db'
# If you did not set SECRET_KEY, also put the key back:  cp /backups/platform-YYYYMMDD-HHMMSS.db.secret /data/.secret
docker compose -f deploy/docker-compose.prod.yml start platform
```

Check a backup file without restoring: `docker compose -f deploy/docker-compose.prod.yml exec platform npx tsx src/platform/ops/backup-cli.ts --verify /backups/platform-YYYYMMDD-HHMMSS.db`.

Evidence files (screenshots, recordings, traces) are not in the database backup. To keep them too, back up the `platform-data` volume's `generated-tests` folder separately.

## 7. Logs and metrics

```bash
docker compose -f deploy/docker-compose.prod.yml logs -f platform      # one JSON object per line
docker compose -f deploy/docker-compose.prod.yml logs platform | grep '"level":"error"'
```

Every answer has an `x-request-id`; search the logs for it. Prometheus can scrape `https://tests.example.com/metrics` with `Authorization: Bearer <METRICS_TOKEN>`:

```yaml
scrape_configs:
  - job_name: aitp
    scheme: https
    metrics_path: /metrics
    authorization: { credentials: "<METRICS_TOKEN>" }
    static_configs: [{ targets: ["tests.example.com"] }]
```

Useful alerts: `aitp_backup_last_ok == 0`, `time() - aitp_backup_last_success_time_seconds > 2*86400`, `aitp_job_queue_length > 10` for 30 minutes, `aitp_worker_heartbeat_age_seconds > 120`, `aitp_disk_free_bytes < 2e9`.

## 8. Runner installers

Runner kits and the Mac installer are built into the image. The Windows installer needs a Windows computer: build it there with `npm run build:installer`, copy `dist/installer/` to `deploy/runner-installer/` on the server, and uncomment the two `runner-installer` lines in `deploy/docker-compose.prod.yml` (see [runner-installer.md](../docs/features/runner-installer.md)). Or put a prebuilt `installer/prebuilt/AITestingRunnerSetup.exe` in place before `--build`.

## Without Docker (systemd)

```bash
# Node 24 (NodeSource or nvm), git, then:
sudo useradd --system --create-home --home-dir /opt/ai-testing-platform aitp
sudo -u aitp git clone <your repository address> /opt/ai-testing-platform
cd /opt/ai-testing-platform
sudo -u aitp npm ci
sudo PLAYWRIGHT_BROWSERS_PATH=/opt/ai-testing-platform/.browsers npx playwright install --with-deps chromium
sudo chown -R aitp /opt/ai-testing-platform/.browsers
sudo -u aitp npm run build:web && sudo -u aitp npm run build:runner
sudo mkdir -p /var/lib/ai-testing-platform /var/backups/ai-testing-platform && sudo chown aitp /var/lib/ai-testing-platform /var/backups/ai-testing-platform
sudo -u aitp cp .env.example .env    # then edit: DATA_DIR=/var/lib/ai-testing-platform, BACKUP_DIR=/var/backups/ai-testing-platform, HOST=127.0.0.1, the keys
sudo cp deploy/ai-testing-platform.service /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/ai-testing-platform.service
sudo systemctl daemon-reload && sudo systemctl enable --now ai-testing-platform
journalctl -u ai-testing-platform -f
```

Put a reverse proxy with HTTPS in front (Caddy installed from its apt repository with the same `deploy/Caddyfile`, replacing `platform:4000` with `127.0.0.1:4000`). Update: `git pull && npm ci && npm run build:web && npm run build:runner && sudo systemctl restart ai-testing-platform`.

## Limits

One server: the database is SQLite (WAL) and lives on the same machine as the platform and its worker. Fine for a team running a few jobs at a time; see "Database" in [production-hosting.md](../docs/features/production-hosting.md) for when to move on.
