# Legacy data migration — MariaDB → PostgreSQL

Moves the old Crowd4Test platform's data (MariaDB, 66 tables) into this
platform's PostgreSQL schema.

The table-by-table mapping lives in **[MIGRATION-MATRIX.md](./MIGRATION-MATRIX.md)**,
generated from `api/scripts/migration/mapping/registry.ts`. Read it first — it
is the specification this tool implements.

---

## Read this before running anything

**The dump in `api/old sql/crowd4testDB.sql` contains no data.** It is a
schema-only export: 66 `CREATE TABLE` statements, zero `INSERT`s. The
`DataCSV/` folder beside it holds 11 reference/catalog exports (browsers,
skills, OS versions and so on), and those are *already imported* by
`prisma/seed-catalog.ts`.

So this pipeline reads from a **live MariaDB connection**, which is what
`LEGACY_DB_*` configures. Until it is pointed at a real database it can be
typechecked and reviewed but not exercised, and none of the numbers in this
document have been observed — no row of business data has ever passed through
it. Budget for a dry run against a restored copy of production as the first
real test.

---

## Prerequisites

1. **A read-only MySQL account.** The tool refuses to issue anything but
   `SELECT`, but the grant is the actual guarantee:

   ```sql
   CREATE USER 'c4t_migration'@'%' IDENTIFIED BY '…';
   GRANT SELECT ON crowd4testDB.* TO 'c4t_migration'@'%';
   ```

2. **A backup of the destination database**, taken immediately before the
   production run. The migration never drops or truncates anything, but "never
   needed the backup" is not a plan.

3. **The migration metadata tables.** Three models were added to
   `schema.prisma` (`MigrationRun`, `MigrationTableStat`, `MigrationRecordMap`,
   `MigrationError`). Apply them before the first run:

   ```bash
   cd api
   npx prisma db push
   ```

   **Use `db push`, not `migrate dev`.** This repo's `prisma/migrations/`
   folder contains only the original init migration; every schema change since
   has been applied with `db push`. `prisma migrate diff` against that folder
   therefore reports months of unrelated drift, and `migrate dev` would offer
   to reset the database to reconcile it. `db push` is the workflow this
   project actually uses.

   The tool refuses to start if `migration_record_map` is missing, because
   without it idempotency silently degrades into duplication.

4. **Environment.** Copy the block at the bottom of `api/.env.example` into
   your `.env` and fill it in. Never commit real values.

---

## Commands

```bash
cd api

npm run migration:dry-run    # reads everything, writes nothing
npm run migration:sample     # migrates MIGRATION_SAMPLE_SIZE rows per table
npm run migration            # the full run
npm run migration:matrix     # regenerate docs/MIGRATION-MATRIX.md

# Confirm legacy passwords will carry over (run before the production migration)
npm run migration:check-password -- someone@example.com 'TheirPassword'
```

Flags (all three modes):

| Flag | Effect |
| --- | --- |
| `--only=users,projects` | Restrict to these legacy tables |
| `--skip=attachments` | Skip these |
| `--batch=1000` | Rows per batch |
| `--sample=500` | Rows per table in sample/dry-run mode |
| `--continue-on-error` | Carry on past a failing table |
| `--report-dir=…` | Where reports are written |

---

## The order to run them in

1. **`migration:dry-run`** — connects to both databases, streams every table
   through the real transformers inside a transaction that is always rolled
   back, and writes the full report set. Nothing is written to PostgreSQL.
   Read `migration-report/summary.md`, then `invalid-records.csv` and
   `orphan-records.csv`. Expect orphans: the legacy schema has almost no
   declared foreign keys, so its referential integrity was only ever enforced
   by application code that no longer runs.

2. **`migration:sample`** — migrates a small slice for real. The point is not
   the row count, it is the relationship graph: pick a migrated project and
   confirm its builds, assignments, bugs, comments and attachments all resolved
   to the right parents. A sample that migrates 100 users and no bugs has
   proved nothing.

3. **`migration`** — the production run, after a backup.

Re-running is safe at every stage; see *Idempotency*.

---

## How it works

```
legacy MariaDB ──SELECT──> transform ──validate──> PostgreSQL
                              │                        │
                              └──> reports    migration_record_map
```

- **Extract** (`legacy/client.ts`) — keyset pagination on the primary key, one
  batch at a time. `LIMIT/OFFSET` was rejected: it re-scans from the top on
  every page, and on a live source a concurrent insert shifts the window so
  rows get read twice or skipped.
- **Transform** (`transform/values.ts`) — every MySQL→Postgres coercion in one
  file: zero dates, four spellings of boolean, comma-separated id lists, money
  from float to `BigInt` minor units.
- **Load** (`load/*.ts`) — one loader per legacy table, each returning either
  *written* or *skipped with a reason*.
- **Map** (`idmap.ts`) — legacy `(table, id)` → new id, so a child row's
  parents resolve by id and never by name.
- **Validate** (`validate/checks.ts`) — counts on both sides, plus relationship
  assertions the legacy schema could not express.

### Ordering

Loaders declare which table they read; the registry declares which phase that
table belongs to; the runner sorts by phase. Parents therefore always precede
children, and a loader's `dependsOn` is preloaded into the id cache before it
runs.

The one deliberate exception is `test_report.trep_defect_id`, which points
*forward*: a test report is migrated before the bug it produced exists. That
link is resolved after phase 5 by `linkTestReportsToBugs`.

---

## Idempotency

Running the migration twice does not duplicate anything.

- Eight models carry a `legacyId` column — `User`, `Organisation`, `Project`,
  `Bug`, `Rating`, `TesterProfile`, `Transaction`, `PaymentAccount` — and are
  matched on it directly.
- Everything else is matched through `migration_record_map`, written inside the
  same transaction as the row it describes. A rolled-back batch therefore
  leaves no mapping, and a committed row always has one.
- Migrated business references are derived from the legacy id
  (`C4T-LEG-000123`, `BUG-LEG-004501`, `TXN-LEG-00088`) rather than drawn from
  the live sequence, so a re-run does not mint new numbers and migrated rows
  can never collide with references the application issues later.

---

## Transactions and rollback

Batches commit independently. A single transaction around a large table would
hold locks for the length of the run and lose everything on the last row.

When a batch fails it is rolled back and then **replayed row by row**, so one
malformed record cannot cost the other 499 and the row that actually failed is
named in `migration-errors.csv`.

To roll back a test migration, restore the backup. There is no selective undo:
`migration_record_map` records what was written and could drive one, but a
partial delete across a graph this connected is more dangerous than a restore.

---

## Passwords

Handled, and worth understanding before you run it.

The legacy column is `usr_password varchar(50)`. bcrypt needs 60 characters and
Argon2id about 95, so it has never held either — what fits is unsalted MD5 (32
hex) or SHA-1 (40). The migration copies the digest across and sets
`passwordAlgo` from its length. On the first successful sign-in the API
re-hashes the plaintext with Argon2id and flips the row to `ARGON2ID`
(`src/lib/legacy-password.ts`), so each account upgrades exactly once, at the
only moment the plaintext is legitimately available.

**Nobody is locked out, and no password is reset.**

Two caveats:

- The exact legacy scheme is **unconfirmed**. It is inferred from the column
  width; the answer is in the CodeIgniter login controller. If that code turns
  out to use a **per-user salt**, the salt is not in the schema and those
  accounts will need a forced reset.

  Confirm it against a real account before the production run:

  ```bash
  npm run migration:check-password -- someone@example.com 'TheirPassword'
  ```

  That reads the row from the legacy MySQL and reports which scheme reproduces
  the stored digest. Do not assume passwords carry over until it prints
  `MATCH`. (Note `npm run legacy:verify` is a different, weaker check: it
  invents its own digest to prove the *upgrade mechanism* works, so it passes
  regardless of what the real database contains.)
- If a site-wide pepper was used, set `LEGACY_PASSWORD_PEPPER`. Guessing it
  locks out every legacy user.

A digest that is not clean hex migrates as *no password*, and that account uses
the normal reset flow rather than being stranded behind a hash nothing can
verify.

---

## Files and attachments

Database rows are not enough: `attachments`, `documents`, `build_reports` and
`users.usr_profile_pic` all point at files on the legacy server.

Set `LEGACY_FILE_ROOT` to migrate them. Leave it unset and attachment rows are
**skipped** and listed in `missing-files.csv` — deliberately, because a
`FileObject` pointing at bytes that were never copied renders as a broken
download with nothing to indicate the data was lost.

When files are migrated, the `FileObject` is created with `isComplete: false`
until the bytes are verified in place. That flag is the platform's existing
mechanism for "row exists, payload does not", so nothing downstream needs to
learn a new state.

---

## Reports

Written to `migration-report/` (configurable):

| File | Contents |
| --- | --- |
| `summary.md` | Human-readable overview; read this first |
| `summary.json` | The same, machine-readable |
| `table-counts.csv` | Per table: read / inserted / updated / skipped / failed, and whether they balance |
| `id-mappings.csv` | legacy id → new id |
| `migration-errors.csv` | Rows that failed |
| `invalid-records.csv` | Rows that were skipped, defaulted or truncated, and why |
| `orphan-records.csv` | References to rows that do not exist |
| `missing-files.csv` | Attachments whose bytes were not migrated |

Every row read is accounted for as inserted, updated, skipped or failed. If
those do not add up, `summary.md` says so in place of a total — nothing is
dropped silently, and nothing is quietly rounded.

CSV values beginning `=`, `+`, `-` or `@` are apostrophe-prefixed: these files
get opened in Excel, and a legacy field containing `=cmd|…` would otherwise be
a formula-injection payload.

---

## Known incompatibilities

These are capability gaps, not bugs. Each is a legacy feature with no
counterpart in the new platform, so its data has nowhere to land.

| Legacy area | Tables | Why it cannot migrate |
| --- | --- | --- |
| **Contests** | `contests`, `contest_tasks`, `contest_question`, `contest_answers`, `contest_participant`, `contest_feedback`, `cust_feedback_fields`, `cust_feedback_answers` | The new platform has no contest feature — no model, no route, no UI. Eight tables of real history; migrating them means building the feature first. |
| **Test scenarios** | `test_scenarios`, `test_scenario_reports` | Scenarios group test cases in the legacy hierarchy. The new schema hangs cases directly off a build, so flattening would invent structure that was never there. |
| **Timesheets** | `testing_time_sheet` | Logged time with `tts_approved_time`/`tts_approved_by`, so it fed billing. No timesheet model exists. **The most commercially significant gap.** |
| **Automation** | `automation_modules`, `automation_reports` | No automation feature. |
| **Plans and pricing** | `active_plans`, `pricing_models` | The platform does not model subscriptions; commercial terms live outside it. |
| **Notification preferences** | `notification` | Per-organisation preferences (`allN`, `buildStatus`, `criticalDef`). The new platform has one per-user email flag and no per-event or per-org preferences. |
| **Comment read receipts** | `comments_monitor` | `BugComment` has no read tracking. A notification is not a substitute: a receipt says someone *has seen* it, a notification says they *were told*. |
| **Tester applications** | `applied_tests` | The new platform is invite-only. Turning applications into assignments would fabricate acceptances that never happened. |
| **Site statistics** | `site_statistics` | A precomputed rollup of counts the new platform queries live. Importing it creates a second source that is stale on arrival. |

Additionally, some columns are dropped from tables that otherwise migrate
cleanly. The significant ones:

- `users.usr_account_balance` and `organisation.org_wallet_balance` — **not
  copied**. Balances are derived from the `Transaction` ledger; a stored figure
  would be a second source that disagrees the first time a transaction is
  recorded. Both are reported per row so you can reconcile the ledger against
  them.
- `users.jira_username` / `jira_password` / `jira_url` — no integration exists.
  The password column is never read at all.
- `projects.project_cycle_type`, `project_pricing_model_id`,
  `export_project_key` — no destination.
- `user_organisation_map.uom_status = inactive` — `OrganisationMember` has no
  inactive state, so those rows are **skipped** rather than silently
  re-admitting people who were removed from a company.
- `user_invitation.invite_passcode` — deliberately **not** carried into
  `tokenHash`. The new flow hashes a single-use expiring token; a legacy
  passcode is neither, and copying it would leave live redeemable invitations
  in a decade-old table. Accepted invitations migrate as history; pending ones
  arrive revoked.

---

## Structural decisions worth knowing

**Every legacy project gets a default build.** The legacy model hangs devices,
browsers, languages and documents off the *project*; the new model hangs them
off a *build*, and `Bug.buildId`, `ProjectMaterial.buildId` and
`ProjectAssignment.buildId` are all required. The default build is where that
project-level data lands. It is not invented data — it is the same data, in the
place the new schema keeps it.

**Migrated projects land as `COMPLETED`.** The legacy `projects` table has no
status column at all; status was implied by whether builds existed and had been
tested. Rather than infer one, historical projects from a decommissioned
platform arrive completed — marking a ten-year-old project `IN_PROGRESS` would
put it back into active queues and tester dashboards.

**Timestamps are read as UTC strings.** The legacy dump sets
`time_zone = "+00:00"`, and mysql2 would otherwise convert `DATETIME` using the
*driver's* timezone — silently shifting a decade of history by however many
hours the operator's laptop is offset. `dateStrings: true` plus explicit UTC
parsing is what prevents that.

**`0000-00-00 00:00:00` becomes `NULL`, not `now()`.** It is a legal MariaDB
value and not a legal instant. Where a required timestamp is missing we fall
back to the row's own creation date rather than to the migration's clock —
stamping migrated rows with the time of the migration would destroy their
history.

---

## Troubleshooting

**`Cannot read the legacy database`** — check `LEGACY_DB_*`, and that the host
allows connections from wherever you are running this.

**`migration_record_map is missing`** — apply the schema (prerequisite 3).

**Everything skips with `ORPHAN_REFERENCE`** — a parent phase did not run.
Check that you are not using `--only` with a child table but not its parents;
the id map is populated by the parent's own loader.

**Accented names arrive mangled** — set `LEGACY_DB_CHARSET=latin1`. Dumps of
this era frequently hold latin1 bytes in a column declared utf8.

**Counts do not balance in `summary.md`** — a loader returned without recording
an outcome. That is a bug in the loader, not in the data; the table name in the
report says which one.

**A legacy user cannot sign in after migration** — confirm the password scheme
with `npm run migration:check-password -- <email> '<password>'`. If the legacy
application used a per-user salt, those accounts need a forced reset; see
*Passwords*.
