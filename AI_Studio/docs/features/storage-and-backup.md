# Storage, retention and backup

Videos, traces, screenshots and recorded network calls pile up with every run, and a project could not be moved or backed up. This feature adds a storage view, a retention policy (on by default) that removes the files runs leave behind once they expire, and export/import of a whole project.

## What a person sees

- **Settings, Storage.** What the platform uses: test files by kind (recordings, screenshots, traces, network and console records, reports, Android apps, approved screenshots, scripts), the database, free disk space, and the projects that use the most.
- **Project Overview, Storage and backup.**
  - Usage of this project and how much was already removed.
  - **Remove old files.** A form with three settings and three buttons: Save settings, Preview ("This would remove 214 files (1.8 GB) older than 30 days"), and Remove old files now (a confirm dialog that shows the current number).
  - **Backup.** Download backup, with an option to include approved screenshots and recent evidence files (up to 50 MB).
  - **Restore.** Choose a backup file and press Restore as a new project. The result lists what to enter again and anything that could not be restored.
- **Test page.** A removed file is not shown as a broken image: the page says "This recording expired and was removed on Oct 5, 2026 (the project's retention policy)." The evidence section says the same, and the download link answers 410 with that sentence.
- **Project report.** A finding whose run's files expired keeps its title, severity and reason, and says "The evidence for this finding expired and was removed on Oct 5, 2026 (the project's retention policy). The finding itself is kept." instead of a picture.

## Retention rules

Retention is **on by default**.

| Setting | Range | Default |
| --- | --- | --- |
| Keep the records of passed runs (days) | 7 to 365 (or the server's `RETENTION_MAX_METADATA_DAYS`) | 30 |
| Keep traces and screenshots of failed runs (days; recordings are always 7) | 7 to 730 (or the server's `RETENTION_MAX_FAILED_MEDIA_DAYS`) | 7 |
| Size limit per project, MB (optional) | 10 and up | none |

`RETENTION_DEFAULT_DAYS` (7 to 365, see `.env.example`) changes the passed-run period for projects that have no policy of their own, and `off` keeps everything for them; anything else that is not a whole number in range counts as not set. A project's own saved policy, including "off", wins, but never above the server's limits: a longer setting is refused (400, in words), and a policy saved before a limit was lowered applies held to the limit. A project restored from a backup without a policy gets the default (on).

Expiry is decided by the run a file belongs to, the run's outcome and the file's age, over **every kind of file a run stores** (a kind added later, such as a passing run's footprint inside the evidence record, is covered without a change). For each file the first matching rule decides (`src/engine/retention/rules.ts`):

1. Approved visual baselines are never removed.
2. A file that belongs to no run (plans, app models, reports) is never removed.
3. A recording (of a passed or a failed run) is kept 7 days and removed after that, whatever the periods below say (reason `recording-age`; a removed one says "This recording was removed after 7 days, on <date>").
4. A passed run keeps no trace: it is removed at the next pass. Its other files (the evidence record, screenshots) are removed after the passed-run period.
5. A run that did not pass: every other file is removed after the failed-run period.

"After N days" means strictly more than N days; a file exactly N days old is kept. Nothing else keeps a run's files longer. The exceptions of the first version were removed: the latest runs of each test (the setting `keepLatestRuns` is ignored; older clients may still send it), the newest run of a failing test, a visual change waiting to be accepted (accepting it after its screenshots expired is refused with 409 and asks for a new run), the failed run an issue was filed from, and the runs a release looked at.

Then, when a size limit is set, the oldest files that are not yet due are removed until the project fits (baselines and files of no run do not count, nor do files held by the first-deploy grace or by a time that cannot be read).

### First-deploy grace

The first daily pass after a deploy runs across every project without a policy of its own, and what it removes cannot be brought back. So for **14 days** (`GRACE_DAYS` in `src/engine/retention/rules.ts`) after the platform first starts a version with retention, nothing dated before that start is removed or cleared:

- **files**: a run's files stored before the start are kept (files made after it follow the normal periods from the start);
- **text records**: the failure details of runs and steps, run summaries, job errors and events, test reasons and AI agent runs dated before the start keep their text.

A file or record whose date cannot be read counts as before the start. The start is recorded once in the database (`auth_settings`, key `retention.first_deploy`, `src/platform/retention-runner.ts`) when the platform starts and before each scheduled pass; restarts and later deployments do not move it, and a restored database keeps it. A recorded start that cannot be read as a time (damaged) is not read as "no grace": the grace starts at that moment and the value is rewritten with it, so every later read agrees.

**The size limit does not count held files** during the grace (`heldBytes`), so they never push newer files out; once the grace is over they count again, oldest first. Files kept because their run's time cannot be read are left out of the limit the same way.

**What the storage page says.** The preview lists, in plain words: "Kept until <date>: N files and the details of N records from before retention was first switched on. Nothing from before then is removed in the first 14 days." and, when a size limit is set and files are held, that the limit does not count them (for example "The 500 MB size limit does not count the 1.2 GB of files kept for the first 14 days, so they do not push newer files out."). The answer carries `grace`, `graceRecords`, `graceUntil`, `heldBytes` and `sizeLimitNote`.

**Back up before the first deploy with retention on**, database and object store, and verify both: the steps are in the admin guide, section 11 (Storage, retention and backup). To hold retention off for projects without a policy of their own, set `RETENTION_DEFAULT_DAYS=off` before deploying.

**Findings keep their records.** Retention removes files and marks their `artifacts` rows. Test cases and their results (including a test marked as a finding), specs, scripts, security findings with their status and history, issues, releases and manual results are never changed or deleted. Executions, step results and run summaries are never deleted either, so trends and flaky detection do not change, but once a run is past its period (passed: the passed-run period, any other outcome: the failed-run period) the same pass clears what those rows say about the application: the run's failure message and each step's failure message (they quote page text, addresses and requests), and in run summaries older than the failed-run period each test's reason and the job's error. What stays: the run's id, test, outcome, timing, attempt, browser or environment name and the version that ran; each step's number, title and outcome; a summary's counts, pass rate and the tests with their outcome. The preview counts those runs (`runs`, `summaries`, `details`), and a manual run reports them. Requests, console messages and the pages and endpoints a passing run touched (its footprint, which selection reads as coverage) live only in the evidence file, so they go with it. A finding may lose its evidence files; the test page, the evidence view, the download link (410) and the project report then say that the evidence expired. A removed file keeps its row, marked with `pruned_at` and a reason (`age`, `age-failed`, `passed-media`, `recording-age`, `size-cap`).

### Preview and run

`POST /api/projects/:id/retention/preview` and the run use the same function (`planFor`), so they agree. The preview shows counts, bytes, oldest and newest dates, the files that are never removed, and the first 20 files as ids (never a path on the server). The run:

- needs a policy that is on, `{ "confirm": true }`, and no job running for the project (409 otherwise);
- re-plans just before removing, resolves every path inside the artifact folder, removes plain files only (a link or folder is skipped), one by one;
- logs a file it cannot remove and goes on; the row stays unmarked and the next run tries again;
- tidies empty folders under the project's `_artifacts` folder only.

### Daily pass

The scheduler tick (`afterPass` in `scheduler.ts`) runs `runScheduledRetention`: for every project whose effective policy is on, at most once in 24 hours, never while a job is running. Each pass writes a `retention_log` row (when, files, bytes, errors), even when nothing needed removing, which is also what enforces the daily limit. The log keeps the latest 200 rows per project.

## Storage numbers

`GET /api/storage` and `GET /api/projects/:id/storage` walk the artifact folder (capped at 400,000 entries and 12 levels, cached for 60 seconds, never following a link, never leaving the artifact folder) and group files by the kind in the database, then by folder and extension. The platform answer adds the database size (with its write-ahead log) and the free disk space from `fs.statfs`.

## Backup and restore

`GET /api/projects/:id/backup` returns a zip. Documents (JSON): `manifest.json` (format 1, platform version, counts), `project.json`, `tests.json` (specs and their current scripts), `manual-cases.json`, `releases.json` (including frozen sign-offs, results and the audit trail), `runbooks.json`, `environments.json`, `test-data.json`, `schedules.json`, `alert-channels.json` (names and kinds only), `secrets-needed.json`. With `?evidence=true&maxEvidenceMB=N` (default 50, at most 200) it also holds `baselines/<test>/<file>` and `evidence/<n>-<kind>.<ext>` files.

**Secrets are never written.** Not the application's sign-in details, test accounts, environment sign-ins, alert channel addresses and mail logins, issue-tracker and Sentry tokens, or deploy trigger tokens. They are listed by name in `secrets-needed.json`. In data that is copied, values are scrubbed too: user names, passwords and secret-looking query parameters in addresses, environment variables and test data columns whose names look secret, and the path of an uploaded Android app. Specs are exported as stored; put real secrets in the credentials fields, never inside a test.

`POST /api/projects/restore` takes the zip as the request body (`application/zip` or `application/octet-stream`; optional `?name=`) and **always creates a new project**. Restored tests start as PENDING with a plain note, nothing runs, schedules come back switched off (and unconfirmed for production), retention always comes back switched on (a policy saved in the backup keeps its periods, held to this server's limits, but is on even if the source project had it off; a backup without one gets the default, on), so a backup is never a way around retention, and the list of secrets to enter again is kept on the new project (`GET /api/projects/:id/storage`, cleared with `DELETE /api/projects/:id/restore-needs`). Baselines in the zip become the new project's baselines; evidence files stay in the zip for your records and are not imported. Manual cases are linked to the new tests and releases point at the new cases.

The zip is untrusted. It is unpacked as a stream in 16 KB slices, so a refusal stops the work immediately:

- the file is at most 256 MB, 20,000 entries, 32 MB per document or file and 512 MB unpacked in total (counted as it unpacks, whatever the headers claim);
- every entry name is checked (no `..`, absolute paths, drive letters, backslashes, control characters, repeats) and must be one of the known documents or a file below `baselines/` or `evidence/`;
- the manifest is read first; a format newer than 1 is refused with "made by a newer version of the platform";
- every document is validated (zod, and the test, runbook, schedule and data set rules of the platform); anything invalid is refused before anything is created;
- file names written to disk are built from ids made at restore time, never taken from the zip;
- all database writes happen in one stretch without waiting, and if one fails the new project and its files are removed again.

## Limits

- A removed file's page notice is shown for the latest run's files and for the run history line.
- Variant and environment result pages show only the newest run per browser or environment; once its files expire they show no media.
- Accepting a visual change needs the run's new screenshots: after 7 days (failed run) they have expired, and the test must be run again first.
- Evidence files in a backup are not re-imported; only baselines are.
- Executions, run summaries and logs are not backed up, so a restored project starts without history.
- The size walk is a snapshot cached for a minute, so the numbers can lag behind a run in progress.

## Files

`src/engine/retention/{policy,rules,format,backup-model}.ts`, `src/platform/{retention-store,retention-runner,storage-usage,backup}.ts`, `src/platform/routes/retention.ts`, `web/src/features/storage/*`. Additive edits: `db.ts` (migration 16), `config.ts`, `scheduler.ts` (`afterPass`), `schedule-services.ts`, `server.ts` (410 for a removed file), `repo.ts` (`pruned_at` in artifact lists), `evidence-read.ts`, `Settings.tsx`, `ProjectOverview.tsx`, `TestDetail.tsx`, `.env.example`. Tests: `tests/retention-unit.test.ts`, `tests/retention.test.ts`, `tests/retention-ui.test.ts`.
