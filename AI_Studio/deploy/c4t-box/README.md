# AI Studio on the Crowd4Test server

A preview of AI Studio at `aistudio.crowd4test.com`, on the same EC2 box as crowd4test.com. It uses SQLite and local disk. **Tests never run on this box: every run goes to a runner**; see [Tests run only on runners](#tests-run-only-on-runners).

## What runs where

| What | Where |
| --- | --- |
| Code | `/var/www/c4t/AI_Studio`, the shared checkout. `scripts/deploy-pull.sh` hard-resets it. |
| Node 24.22.2 | `/home/ubuntu/.ai-studio/node`. The system Node and the C4T apps' Node 20 are not touched. |
| Process | pm2 app `ai-studio`, on `127.0.0.1:4100`. |
| Settings | `/home/ubuntu/.ai-studio/env`, mode 600. **Every deploy rewrites it** from the repository's secrets. |
| Your own settings | `/home/ubuntu/.ai-studio/env.local`, optional, mode 600. Deploys never touch it, and it overrides `env`. |
| Data | `/home/ubuntu/.ai-studio/data`. |
| Logs | `/home/ubuntu/.ai-studio/logs`. |
| Backups of changed files | `/home/ubuntu/.ai-studio/backups`. |
| Runner downloads | `/home/ubuntu/.ai-studio/runner-downloads` (`runner`, `runner-complete`, `installer`, `build-info.json`), built by the deploy workflow, never on this box. Uploads wait in `/home/ubuntu/.ai-studio/incoming`. |
| Browser | Playwright's Chromium, in `/home/ubuntu/.cache/ms-playwright`. |
| Web server | nginx site `aistudio.crowd4test.com`, with a Let's Encrypt certificate from certbot. |

Files:

- `deploy.sh` does everything on the box and is safe to run again.
- `ecosystem.config.cjs` is the pm2 process.
- `nginx-site.conf` is the site, before certbot adds TLS.
- `.github/workflows/ai-studio-ci.yml` checks a push.
- `.github/workflows/ai-studio-deploy.yml` deploys after CI succeeds on `main`, or when run by hand.

### Runner downloads

The Runners page offers a complete download for each system and processor (its own Node.js, the runner and every test tool, plus the installer program on Windows and Mac), so a tester installs nothing else. Building those needs the internet and about 1 GB more memory, so this box never builds them. `.github/workflows/ai-studio-deploy.yml` does, in three jobs:

1. **Build the Windows installer** on `windows-latest` (`csc.exe` comes with Windows).
2. **Build the runner downloads** on `ubuntu-latest`: `npm ci`, then `npm run build:runner -- --complete --targets win-x64,win-arm64,mac-arm64,mac-x64,linux-x64` (Node.js from nodejs.org, every archive checked against its SHA-256), then `build:installer` with that Windows program and the Mac app. They are packed into one tar (about 300 MB) with its SHA-256 and `build-info.json` (the commit they came from).
3. **Deploy to EC2** copies the tar into `~/.ai-studio/incoming` over the same SSH secrets (no new secret), if the box has room for it twice plus the 2,500 MB the deploy needs, then runs `deploy.sh` as before.

`deploy.sh` checks the SHA-256, that the tar holds only those four names, only files and folders, and nothing that climbs out, and that the disk has room, then swaps the folder in and points `RUNNER_KIT_DIR`, `RUNNER_COMPLETE_DIR` and `RUNNER_INSTALLER_DIR` at it in `env`. Anything wrong (no upload, a damaged one, no room) keeps the downloads from the last deploy and the deploy still succeeds; the log says which. If the Windows installer could not be built, the downloads go out without it; if the downloads could not be built at all, the app is still deployed.

The downloads are not code-signed: the Runners page tells people what SmartScreen and Gatekeeper show and how to get past it.

### Memory

`npm ci` peaks at about 650 MB and the web build at about 1 GB. `npm ci` runs only when `package-lock.json` changes. Both run at `nice` 15 and are the first thing the OOM killer takes. A deploy stops before it starts if memory plus swap has less than 1,500 MB free, or the disk has less than 2,500 MB free. To make room, enlarge the EBS volume in AWS; the next deploy grows the root partition and filesystem to match (`growpart`, then `resize2fs` or `xfs_growfs`).

## Tests run only on runners

**Anything AI Studio ran on this box could read every file the `ubuntu` user can**, including `/var/www/c4t/api/.env`, the web app's env file and AI Studio's own env file. So this box never runs a test: every run goes to a runner, a small program on a tester's or a team's own computer.

What makes it so:

- `EXECUTION_MODE=runners` in the env file. The API process starts a dispatch worker (even with `WORKER_EMBEDDED=false`): it takes only runs of existing tests, hands each to a runner the project may use, and looks after several at once (`DISPATCH_CONCURRENCY`, 8 by default). Every project runs on runners whatever its stored setting says, and a project cannot be set to run here.
- A run with no runner online is refused at once, in a sentence. Schedules fire and hand their runs to runners, and runner housekeeping runs on the scheduler's tick.
- As a last line, the server's own browser launches and local script runs throw. A path that should have gone to a runner fails loudly instead of running here.
- `WORKER_EMBEDDED=false` stays: the full worker, which can run tests here, is never started. `ALLOW_CUSTOM_SCRIPTS` is not set. Do not set either here.

What does not run here (each is refused with a sentence, not queued):

- Exploring an application with the AI, describing a test in plain words, and agent runs. They use a browser on the server.
- Security assessments, recording on the server, and phone sessions on the server. Recording and phone sessions work on a runner.
- Checking or capturing a saved sign-in in a browser. A saved sign-in still goes to the runner with the tests; it is not checked first.
- Repair suggestions that need a browser, after a failing web test.
- A test data reset to a private or local address. The reset is sent from this box, so only to a public address; otherwise the run stops before any test and says why.
- Email steps: the test mailbox is read by the platform, so tests with an email step fail on a runner with that message.

One browser still opens here: making a PDF of a report. It renders the platform's own page, with scripts off.

`/readyz` reports the dispatch worker under `worker`. A deploy restarts the API process, and with it the dispatch worker: a runner run still going after `SHUTDOWN_GRACE_SECONDS` (60) is stopped, the runner is told to stop, and its tests go back to not run yet.

Still open before more is allowed here:

- Approved tests held back when a reusable step, helper or shared element they use changes.
- Environment runs given a project's accounts only on the project's own address.
- A monthly AI limit per organisation, so one customer cannot use up the platform limit.

## Secrets

These go in the repository's Actions secrets, each one the output of `openssl rand -hex 32`:

- `AI_STUDIO_SECRET_KEY` encrypts stored credentials. **Keep a copy outside GitHub.** Changing it makes everything already encrypted unreadable, and backups need it too.
- `AI_STUDIO_API_KEY` is an owner-level key for scripts.
- `AI_STUDIO_SERVICE_TOKEN` is shared with the Crowd4Test API (`AI_STUDIO_SERVICE_TOKEN` in `api/.env`, `C4T_SERVICE_TOKEN` here).

A deploy with one missing stops before it changes anything.

AI features also need an AI service key. It is not one of these secrets, so add it to `env.local`, for example `LLM_PROVIDER=anthropic` and `LLM_API_KEY=...`, then run `pm2 restart ai-studio`.

## Going live

1. Add a DNS `A` record: `aistudio.crowd4test.com` to the same address as `crowd4test.com` (`dig +short crowd4test.com`). If it goes through a proxy, turn that off, because the script compares the name with the box's own address. Ports 80 and 443 must be open.
2. Run **Deploy AI Studio** from the Actions tab, leaving the box unticked. It installs the nginx site and the certificate. Then open `https://aistudio.crowd4test.com/api/health`, which should answer `{"status":"ok"}`.
3. Run **Deploy AI Studio** again with `enable_shared_sign_in` ticked. This is the only step that changes crowd4test.com.

Step 3 backs up both files, then sets:

- in the web app's env file: `AUTH_COOKIE_DOMAIN=.crowd4test.com` and `AI_STUDIO_URL=https://aistudio.crowd4test.com`;
- in `/var/www/c4t/api/.env`: `COOKIE_DOMAIN=.crowd4test.com` and `AI_STUDIO_SERVICE_TOKEN`.

The web app's env file is the first of `.env.production.local`, `.env.local`, `.env.production` and `.env` that exists in `/var/www/c4t/web`, which is the order Next reads them. The step then restarts `c4t-api` and `c4t-web`, and puts both files back if they do not answer again. A restart is enough, no rebuild: only `NEXT_PUBLIC_*` variables are fixed at build time. Running the step again changes nothing.

**The API must stay one pm2 instance.** The Google sign-in handoff is held in its memory; see `api/ecosystem.config.cjs`.

Until DNS exists, every deploy prints one line saying so and still succeeds.

## Rolling back

**To an earlier version:** every deploy first copies the database to `backups/data/pre-deploy-<time>.db` (the five newest are kept), at the schema the running app was on. Choose one:

- *Exactly as before the deploy* (loses what changed since): `pm2 stop ai-studio`, copy the newest `pre-deploy-*.db` over `/home/ubuntu/.ai-studio/data/platform.db`, delete `platform.db-wal` and `platform.db-shm` beside it, then revert the commit on `main` and push.
- *Keep the data:* revert the commit on `main` and push. The older code starts on the newer database, but ignores what it does not know: it runs a test's latest content even when that is an unapproved draft, shows archived projects, and gives runners registered meanwhile no project access. Do not edit tests or register runners while rolled back. After rolling forward again, approve tests made in that window, and give each runner made in that window access to its project from the Runners page.

CI and the deploy run again either way. If the revert changes `package-lock.json`, `npm ci` runs again by itself.

**Shared sign-in off:** on the box, restore the two newest files from `backups`, then restart:

```bash
cd /home/ubuntu/.ai-studio/backups && ls -t
cp web-env.<stamp> /var/www/c4t/web/<the env file>
cp api-env.<stamp> /var/www/c4t/api/.env
pm2 restart c4t-api --update-env && pm2 restart c4t-web --update-env
```

People already signed in keep cookies written for the parent domain until those expire or they sign in again. Hiding AI Studio only takes removing `AI_STUDIO_URL`.

**Take the site down:** `sudo rm /etc/nginx/sites-enabled/aistudio.crowd4test.com && sudo nginx -t && sudo systemctl reload nginx`. Stop the app with `pm2 stop ai-studio && pm2 save`. Neither touches the data.

## Keeping the data

Nothing deletes `/home/ubuntu/.ai-studio/data`: not a deploy, a rollback or `deploy-pull.sh`. The deploy turns on a daily backup of the database into `backups/data` (7 kept) and keeps run evidence 14 days. Those backups are on the same disk, so losing the disk loses them too: set `BACKUP_UPLOAD_COMMAND` in `env.local` to copy each one off the box. Files in `backups` are not pruned, and they hold secrets, so clear old ones by hand.

## Not production-grade yet

- **SQLite and local disk.** One process, one box, no failover.
- **No isolation.** AI Studio runs as `ubuntu`, so [tests are off](#tests-are-off) here.
- **Shared memory.** AI Studio and its browsers compete with `c4t-api` and `c4t-web`. `max_memory_restart` (1200 MB) covers the Node process only, not its browsers. `CONCURRENCY=1` is set for when tests run.
- **Deploys share one queue.** All three deploy workflows use the `c4t-ec2-deploy` group, and GitHub keeps only one waiting run in it, so a slow AI Studio deploy can replace a waiting web or API deploy. If that happens, re-run the replaced one.
- **Runner downloads are not signed.** Windows SmartScreen and macOS Gatekeeper warn on the first start; signing needs a code-signing certificate and an Apple developer account.
- **A failed deploy's log is public.** The repository is public, and a failed health check prints the last 20 lines of the error log. GitHub masks the secrets, but other text in those lines is visible.
