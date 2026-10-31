# Storage, retention and backup

Videos, traces, screenshots and recorded network calls pile up with every run, and a project could not be moved or backed up. This feature adds a storage view, an opt-in policy that removes old evidence files, and export/import of a whole project.

## What a person sees

- **Settings, Storage.** What the platform uses: test files by kind (recordings, screenshots, traces, network and console records, reports, Android apps, approved screenshots, scripts), the database, free disk space, and the projects that use the most.
- **Project Overview, Storage and backup.**
  - Usage of this project and how much was already removed.
  - **Remove old files.** A form with four settings and three buttons: Save settings, Preview ("This would remove 214 files (1.8 GB) older than 30 days"), and Remove old files now (a confirm dialog that shows the current number).
  - **Backup.** Download backup, with an option to include approved screenshots and recent evidence files (up to 50 MB).
  - **Restore.** Choose a backup file and press Restore as a new project. The result lists what to enter again and anything that could not be restored.
- **Test page.** A removed file is not shown as a broken image: the page says "This recording was removed to save space on Oct 5, 2026." The evidence section says the same, and the download link answers 410 with that sentence.

## Retention rules

Retention is **off by default**. Nothing is removed unless the project's policy is on.

| Setting | Range | Default |
| --- | --- | --- |
| Keep files of passed runs (days) | 7 to 365 | 30 |
| Keep files of failed runs (days) | 7 to 730 (not shorter than the passed setting) | 90 |
| Always keep the latest runs of each test | 1 to 50 | 5 |
| Size limit per project, MB (optional) | 10 and up | none |

`RETENTION_DEFAULT_DAYS` (7 to 365, see `.env.example`) turns retention on for projects that have no policy of their own (failed runs are kept three times as long). Anything that is not a whole number in range counts as not set. A project's own saved policy, including "off", always wins.

Only **screenshots, recordings, traces, recorded network calls, visual comparison images and AI-review screenshots** can be removed. For each file the first matching rule decides (`src/engine/retention/rules.ts`):

1. Approved visual baselines, app models, reports and anything else are never removed.
2. A file that belongs to no run is never removed.
3. The newest N runs of each test (counted separately for each browser variant and environment) are kept.
4. The newest run of a test that is not passing is kept (what the test page shows today).
5. The newest run holding new/different screenshots of a test whose latest run did not pass is kept (a visual change waiting to be accepted).
6. The failed run an issue was filed from is kept. Issue state lives in the tracker, so every filed issue counts as open.
7. For every release (open or signed, by the time it was signed or last snapshotted), the newest run of each test at that moment is kept.
8. Otherwise a file older than the setting (strictly more than N days; exactly N days old is kept) is removed.

Then, when a size limit is set, the oldest files that nothing protects are removed until the project fits. The limit never removes a protected file.

Test cases, specs, scripts, executions, step results, run summaries, issues, releases and manual results are never touched, so trends and flaky detection do not change. A removed file keeps its row in `artifacts`, marked with `pruned_at` and a reason (`age`, `age-failed`, `size-cap`).

### Preview and run

`POST /api/projects/:id/retention/preview` and the run use the same function (`planFor`), so they agree. The preview shows counts, bytes, oldest and newest dates, what was kept and why, and the first 20 files as ids (never a path on the server). The run:

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

`POST /api/projects/restore` takes the zip as the request body (`application/zip` or `application/octet-stream`; optional `?name=`) and **always creates a new project**. Restored tests start as PENDING with a plain note, nothing runs, schedules come back switched off (and unconfirmed for production), the retention policy comes back off, and the list of secrets to enter again is kept on the new project (`GET /api/projects/:id/storage`, cleared with `DELETE /api/projects/:id/restore-needs`). Baselines in the zip become the new project's baselines; evidence files stay in the zip for your records and are not imported. Manual cases are linked to the new tests and releases point at the new cases.

The zip is untrusted. It is unpacked as a stream in 16 KB slices, so a refusal stops the work immediately:

- the file is at most 256 MB, 20,000 entries, 32 MB per document or file and 512 MB unpacked in total (counted as it unpacks, whatever the headers claim);
- every entry name is checked (no `..`, absolute paths, drive letters, backslashes, control characters, repeats) and must be one of the known documents or a file below `baselines/` or `evidence/`;
- the manifest is read first; a format newer than 1 is refused with "made by a newer version of the platform";
- every document is validated (zod, and the test, runbook, schedule and data set rules of the platform); anything invalid is refused before anything is created;
- file names written to disk are built from ids made at restore time, never taken from the zip;
- all database writes happen in one stretch without waiting, and if one fails the new project and its files are removed again.

## Limits

- A removed file's page notice is shown for the latest run's files and for the run history line; runs are only ever pruned once newer runs exist.
- Variant and environment result pages show only the newest run per browser or environment, which retention always keeps.
- Evidence files in a backup are not re-imported; only baselines are.
- Executions, run summaries and logs are not backed up, so a restored project starts without history.
- The size walk is a snapshot cached for a minute, so the numbers can lag behind a run in progress.

## Files

`src/engine/retention/{policy,rules,format,backup-model}.ts`, `src/platform/{retention-store,retention-runner,storage-usage,backup}.ts`, `src/platform/routes/retention.ts`, `web/src/features/storage/*`. Additive edits: `db.ts` (migration 16), `config.ts`, `scheduler.ts` (`afterPass`), `schedule-services.ts`, `server.ts` (410 for a removed file), `repo.ts` (`pruned_at` in artifact lists), `evidence-read.ts`, `Settings.tsx`, `ProjectOverview.tsx`, `TestDetail.tsx`, `.env.example`. Tests: `tests/retention-unit.test.ts`, `tests/retention.test.ts`, `tests/retention-ui.test.ts`.
