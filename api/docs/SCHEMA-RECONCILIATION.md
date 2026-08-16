# Schema reconciliation

**Purpose:** Service Agreement §2.6 makes the Client responsible for supplying the database schema, and the Service Provider responsible for reviewing, validating and refining it. This document is the record of that review.

**Status: FIRST PASS COMPLETE — schema received, reviewed, four blockers raised. Awaiting Client decisions.**

| | |
| --- | --- |
| Source | `api/old sql/crowd4testDB.sql` |
| Dump | phpMyAdmin 5.2.3, generated 10 Aug 2026 |
| Server | MariaDB 10.11.18, PHP 8.4.24 |
| Legacy app | CodeIgniter (inferred from `ci_sessions`) |
| Tables | 66 |
| Rows | **none — the dump is schema-only, 0 `INSERT` statements** |
| Foreign keys | **0** |
| Engines | 34 MyISAM, 32 InnoDB |

> **The dump contains no data.** It was exported with "structure only". Row counts, id ranges and value distributions are therefore unknown, and every estimate below about volume is unverified. A second export **with data** is needed before a migration can be written, let alone rehearsed.
>
> **Do not commit that export to this repository.** It is public, and the tables below hold email addresses, phone numbers, bank account numbers, IFSC codes and PayPal addresses. Transfer it out of band and keep it out of git.

---

## Why this document exists

Three clauses put the schema on the critical path:

| Clause        | Text                                                                                                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §2.6          | "The Client shall provide the database schema for the platform. The Service Provider shall review, validate, and — where needed — refine this schema in consultation with the Client **before implementation**." |
| §3 (CRITICAL) | "Development will commence… **only after** the Client provides the complete DB schema, page-by-page website/functional details, existing content, and any design references."                                    |
| §9.1          | "Provide the complete database (DB) schema for the platform **before backend development begins**."                                                                                                             |

`prisma/schema.prisma` was written as a **reference model** derived from §2.1–§2.4 and §2.8, because the schema had not arrived. It now has. The gap between the two is set out below.

### Commercial note

Rework caused by a late or divergent schema is **not** a Change Order under §6 — §6 covers _added features_, not _redone work_. The schema arrived after the backend was built, so the reconciliation below is unbilled time. Everything in "Feature areas with no home" is a different matter: those are features of the live platform that were never in the Agreement's scope description, and building them is §6 work.

---

## The four blockers

Each of these stops "old users and features work fine" from being true. None can be resolved by writing code alone.

### B1 — Legacy passwords cannot be verified. No old user can sign in.

```sql
`usr_password` varchar(50) NOT NULL
```

Fifty characters. For comparison: bcrypt is 60, Argon2id is ~95. Neither fits, so the column has never held either. What does fit is **MD5 (32 hex chars)** or **SHA-1 (40)** — both unsalted-by-default, both broken, both typical of the CodeIgniter era this app comes from.

The new API hashes with Argon2id and has no other verifier. Point it at migrated rows and **every legacy login fails**, because Argon2id cannot parse an MD5 digest — it does not return "wrong password", it errors on the hash format.

Three ways out:

| Option | What users experience | Cost |
| --- | --- | --- |
| **Rehash on first login** (recommended) | Nothing. They sign in normally, once, and are silently upgraded to Argon2id. | A legacy verifier kept alongside Argon2id, plus a `password_algo` column. ~half a day. |
| Forced reset for everyone | Every user gets a reset email before they can return. | Cheapest to build, worst for retention, and depends on `usr_email` being deliverable. |
| Keep the legacy hash permanently | Nothing changes. | **Not acceptable** — it carries MD5/SHA-1 into a platform whose own site advertises WCAG and security testing. |

Rehash-on-login needs the exact legacy algorithm confirmed. The schema cannot tell us whether it is MD5, SHA-1, or either with a salt or pepper in the PHP source. **Ask for the CodeIgniter login controller** — usually `application/controllers/Login.php` or a `MY_Auth` library. One function settles it.

Until that is known, B1 is unresolvable, and it gates the entire migration.

### B2 — There is no Build layer in the new schema, and the old platform is built on it

In the legacy model a **Project** is the application under test, and a **Build** is a round of testing against one version of it. The Build is where the work actually happens. Sixteen columns across the schema point at `build_id`:

```
bug_build_id      tts_build_id      tc_build_id       rvw_build_id
brep_build_id     tsr_build_id      tsc_build_id      doc_build_id
cbf_build_id      cbfa_build_id     ast_build_id      trep_build_id
comments_build_id pmt_for_build_id  A_build_id        build_id
```

Bugs, timesheets, test cases, reviews, reports, documents, custom fields **and payments** all hang off a build. `prisma/schema.prisma` has no `Build` model at all — `Bug` points straight at `Project`.

So a migration has to either:

- **Add a `Build` (or `TestCycle`) model** and carry the dimension across — the honest option, and the one that keeps old data meaningful; or
- **Flatten builds into projects**, which silently merges every testing round of a project into one bucket. A customer who ran twelve builds of the same app would find twelve rounds of history collapsed into an undifferentiated list of bugs, with no way to answer "what did we find in v2.4?".

This is not a missing table. It is a missing *concept*, and it is load-bearing for eight other feature areas.

### B3 — The live platform moves money. The new one, by contract, does not.

The legacy schema runs a real wallet and payout system:

| Table / column | What it does |
| --- | --- |
| `payment_history` | credit / debit / **release** ledger, per user, per build or contest |
| `payment_acc_details` | bank account no., IFSC, PayPal email, Paytm number, Indian vs non-Indian |
| `tds_history` | **Indian Tax Deducted at Source**, accumulated per financial year |
| `active_plans` | subscription with quotas — `remaining_projects`, `remaining_private_testers` |
| `pricing_models` | named pricing schemes referenced by every project |
| `organisation.org_wallet_balance` / `locked_amount` | escrow: funds committed to a build but not yet released |
| `users.usr_account_balance` | tester's withdrawable balance |

The new `Transaction` model is a flat bookkeeping row — `type`, `status`, `amountMinor`, `occurredAt`. It has no wallet, no balance, no escrow, no plan quota, and no concept of TDS.

Agreement §5 excludes payment-gateway integration, and `README.md` records transactions as "records only". That was a defensible reading of the Agreement when nobody had seen the old system. It is now clearly incompatible with the platform being replaced: **testers have balances they expect to withdraw, and organisations have wallet funds they have already paid in.**

TDS is the sharp end. It is a statutory Indian tax obligation with per-financial-year records. Dropping it is not a feature decision.

This needs a §6 scope conversation before any migration, not after.

### B4 — Jira credentials are stored per user, in a 100-character column

```sql
`jira_username` varchar(100)
`jira_password` varchar(100)
`jira_url`      varchar(100)
```

A password column that is read back to authenticate against a third-party API is, by definition, **reversible** — plaintext or symmetric encryption. Migrating those values moves someone else's live Jira credentials into a new database.

They should not be migrated. The replacement is an API token or OAuth per user, entered fresh. Any migration script must **drop these three columns explicitly**, not carry them silently, and the old rows should be destroyed when the legacy database is decommissioned.

---

## Table-by-table mapping

`Ours` = `prisma/schema.prisma`. `Theirs` = the legacy dump.

### Maps cleanly (12)

| Area | Ours | Theirs | Notes | Done |
| --- | --- | --- | --- | --- |
| Users | `User` | `users` | See **B1**. Also 20+ profile columns with no home: `usr_skype`, `usr_linkedin`, `usr_gender`, `usr_age`, `usr_desig`, `usr_expert_badge`, `usr_agreement_file`. | ☐ |
| Roles | `Role` enum | `roles` | Legacy is a table, ours is an enum. Need the row list to map ids → enum values. | ☐ |
| Permissions | `Permission` + `UserPermission` | `permissions` + `resources` | Legacy grants are **per role**; ours are **per user**. Design decision 2 below was answered wrong. | ☐ |
| Organisations | `Organisation` | `organisation` | Missing: `credit_rate`, `test_manager_fee`, wallet columns (**B3**), `org_currency`. | ☐ |
| Org membership | `OrganisationMember` | `user_organisation_map` | Legacy carries `uom_role_id` per membership — closer to ours than expected. Good fit. | ☐ |
| Projects | `Project` | `projects` | Missing: `project_cycle_type` (crowd/private/managed/diy), `project_pricing_model_id`, `export_project_key`. | ☐ |
| Bugs | `Bug` | `bugs_report` | Field-level fit is good. Blocked by **B2** — every bug references a build. | ☐ |
| Bug comments | `BugComment` | `defect_comments` | | ☐ |
| Messages | `Message` | `message` + `message_recipient` | | ☐ |
| Notifications | `Notification` | `notification` | | ☐ |
| Announcements | `Announcement` | `announcements` | | ☐ |
| Skills | `Skill` + `TesterSkill` | `skills` + `skill_categories` | Ours has no category level. | ☐ |

### Partial — data would be lost (6)

| Area | Ours | Theirs | What is lost | Done |
| --- | --- | --- | --- | --- |
| Transactions | `Transaction` | `payment_history` | Balances, escrow, TDS, plans. **B3** | ☐ |
| Attachments | `BugAttachment`, `FileObject` | `attachments`, `documents` | Legacy files are paths on disk; ours are S3 objects. Needs a file copy, not just a row copy. | ☐ |
| Tester devices | `TesterDevice` | `devices`, `user_browsers`, `mobile_brands`, `mobile_os_*` | Ours is free-text; theirs is a normalised catalogue. Mapping is lossy in one direction and needs a decision. | ☐ |
| Ratings | `Rating` | `test_review` | Legacy reviews are per build. **B2** | ☐ |
| Sessions | `Session` | `ci_sessions` | Discard. PHP session blobs, not migratable, and no reason to. | ☐ |
| Leads | `Lead` | `marketing` | Confirm whether `marketing` is the enquiry table or a mailing list. | ☐ |

### Feature areas with no home in the new schema (~48 tables)

These are working features of the live platform. None is described in Agreement §2.1–§2.4, which is why none was built. **Each is a §6 scope conversation.**

| Feature | Tables | Consequence of dropping |
| --- | --- | --- |
| **Builds / test cycles** | `builds`, `build_reports` | **B2.** Structural. Blocks eight other areas. |
| **Test case management** | `test_case`, `test_scenarios`, `test_scenario_reports`, `test_report`, `test_status`, `test_types`, `assign_testCase`, `assigned_tests`, `applied_tests` | Scripted testing disappears; the platform becomes exploratory-only. |
| **Contests** | `contests`, `contest_question`, `contest_answers`, `contest_tasks`, `contest_participant`, `contest_feedback` | A whole gamification product with prize money (`first_prize`…`fifth_prize`). |
| **Finance** | `payment_history`, `payment_acc_details`, `tds_history`, `active_plans`, `pricing_models` | **B3.** Statutory tax records among them. |
| **Custom bug/feedback forms** | `cust_bug_fields`, `cust_bug_answers`, `cust_feedback_fields`, `cust_feedback_answers` | Per-project custom fields (`build_customize_bug`). Customers lose bespoke report shapes. |
| **Automation** | `automation_modules`, `automation_reports` | Automation-run reporting. |
| **Timesheets** | `testing_time_sheet` | Tester hours with an approval step (`tts_approved_by`) — this is how testers get paid. Ties to **B3**. |
| **Reference catalogues** | `browsers`, `browser_versions`, `os`, `os_versions`, `devices`, `mobile_brands`, `mobile_os_type`, `mobile_os_version`, `network_providers`, `app_types`, `base_country`, `bug_types`, `test_types` | Ours stores these as free text. Normalised lists give consistent filtering and reporting; free text does not. |
| **Site config** | `site_settings`, `site_statistics` | Runtime configuration and the public stats counters. Note the marketing site's `content/stats.ts` currently hardcodes these. |
| **Invitations** | `user_invitation` | Invite flow. |
| **Comment monitoring** | `comments_monitor` | Unclear; needs the Client's description. |

---

## Design decisions — reviewed against the real schema

The nine assumptions made in the absence of the schema. Four were right, two were wrong, three still need the Client.

| # | Assumption | Verdict |
| --- | --- | --- |
| 1 | `USER` is a role, not a table | ✅ **Correct.** `users.usr_role_id` is a column. |
| 2 | Sub-Admin permissions are **per-user** grants | ❌ **Wrong.** Legacy `permissions` maps `per_roleid` → `per_resourceid`: permissions attach to **roles**, not users. Either migrate role grants into per-user rows (expanding them) or add role templates. Needs the `roles` and `resources` row lists. |
| 3 | Customers belong to organisations, many-to-many | ✅ **Correct.** `user_organisation_map` is exactly this, with a per-membership role. |
| 4 | Money as `BigInt` minor units | ⚠️ **Mismatch.** Legacy uses `double` for `usr_account_balance` and `tds_amount`, `int` for wallet balances, `bigint` for `pmt_amount`. Floats for money. Migration must round explicitly and the rounding rule must be agreed — it will not always reconcile to the penny. |
| 5 | Transactions are records, not gateway operations | ❌ **Wrong in context.** See **B3**. |
| 6 | Testers cannot see each other's bugs | ❓ Unresolved. Legacy has no visibility column, so this was enforced in PHP. Needs the Client. |
| 7 | Deletes are soft | ❓ Legacy uses status enums (`usr_active`, `uom_status`) rather than `deleted_at`. Map `inactive` → which state? `SUSPENDED`, `DEACTIVATED` and soft-delete are three different things in ours and one in theirs. |
| 8 | Reference numbers from Postgres sequences | ⚠️ Legacy ids are plain `int(11)` autoincrement, with a separate human key on bugs (`bug_defect_id`) and projects (`export_project_key`). Decide whether old references stay visible to users. |
| 9 | `legacy_id` on every migratable entity | ⚠️ **Correct but under-applied.** Only `User`, `Organisation`, `Project`, `Bug`, `Rating`, `TesterProfile` and `Transaction` have it. 25 models do not — including `OrganisationMember`, `BugComment`, `Message` and `ProjectAssignment`, all of which have legacy rows to trace. Add before migrating. |

---

## Two schema-quality notes

**No foreign keys anywhere.** Zero `FOREIGN KEY` constraints across 66 tables, and 34 tables are MyISAM, which cannot enforce them. Nothing has guaranteed referential integrity, so the export will contain orphans: bugs pointing at deleted builds, memberships pointing at deleted users. The migration must **count and report** orphans rather than assume they do not exist, and the Client has to decide per case whether to drop or re-parent.

**`org_update_date timestamp NOT NULL DEFAULT '0000-00-00 00:00:00'`.** The MySQL zero date is not a valid PostgreSQL timestamp and will fail on insert. Every zero date must be mapped to `NULL` during migration. Check `usr_add_date`, `usr_upd_date` and `pmt_time` (a `bigint` epoch, not a timestamp) as well.

---

## What is needed from the Client

In priority order. The first two block everything.

1. **The CodeIgniter login controller** — settles **B1**. Without the hashing algorithm no old user can sign in, and no migration is worth running.
2. **A second dump, with data, transferred out of band.** Structure-only tells us nothing about volume, orphan rate, or how the enum-ish varchar columns (`bug_severity`, `bug_type`) are actually populated.
3. **Row exports of the small lookup tables** even if the full dump is delayed: `roles`, `resources`, `permissions`, `test_status`, `bug_types`, `test_types`, `pricing_models`. They are tiny and they define the value mappings.
4. **Decisions on B2, B3, and each row of "Feature areas with no home"** — keep, drop, or defer. Every "keep" is §6 scope.
5. **Confirmation on decision 2 and 7** above (role-based vs per-user permissions; what `inactive` means).

---

## Known implementation gaps flagged from code

| Location                                         | Issue                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ~~`uploads.routes.ts` → `GET /:id/download-url`~~ | **Resolved.** The route now resolves the owning bug/project/thread and reuses its `authorize()` check (admin-side bypasses; avatars/logos stay open to any authenticated user; anything unattached falls back to uploader-only). See `assertCanDownload` in `uploads.routes.ts`. |
| `testers.service.ts` → `refreshTesterAggregates` | Runs synchronously after every bug and rating write. Fine at current scale; move to a background job if the tester pool grows large.                                                                                                                                                       |
| Soft deletes                                     | Enforced by every query remembering `deletedAt: null`. A Prisma client extension would make this global and remove the footgun.                                                                                                                                                            |
