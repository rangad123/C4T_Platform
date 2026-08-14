# Legacy feature map

A line-by-line reading of `api/old sql/crowd4testDB.sql` (66 tables, 2,065 lines), mapped
against Service Agreement §2.2 (Module A — Admin Panel) and against what the rebuild
currently implements.

Companion to [SCHEMA-RECONCILIATION.md](./SCHEMA-RECONCILIATION.md), which covers the
migration blockers. This document covers **features**: what the old platform does, which
of it the agreement obliges us to rebuild, and where each piece stands.

---

## Three facts about the dump itself

**1. It contains no data.** 66 `CREATE TABLE` statements, **0 `INSERT` statements**, and no
`AUTO_INCREMENT=` seed values. This is a structure-only export. Agreement §9.1 requires the
Client to provide "a complete export/dump of the existing MySQL database (current platform
data)" and §2.8 makes migrating it a deliverable — neither can proceed on this file. A
second export with `--no-create-info` (data only), or a full dump, is still needed.

**2. It declares no foreign keys.** Zero `FOREIGN KEY` constraints across all 66 tables.
Every relationship is by naming convention only, and 34 of the 66 tables are **MyISAM**,
which cannot enforce referential integrity even if constraints were declared. Expect orphan
rows: bugs pointing at deleted builds, assignments pointing at deleted testers. The
migration must therefore treat every foreign key as nullable-until-validated and report
what it could not resolve, rather than aborting a 60,000-row import on the first orphan.

**3. Several columns are typed far wider than their contents.** `int(200)` on
`announcements.id`, `int(255)` on `test_scenarios.tsc_id`, `varchar(20)` holding
`assigned_tests.rate` and `users.rating` (numbers as strings), `bigint(11)` holding
`payment_history.pmt_time` (a Unix timestamp, not a date). The display width in
`int(200)` is cosmetic in MySQL — the storage is a plain 4-byte INT — but the string-typed
numerics mean legacy rates and ratings must be parsed and validated on import, not cast.

---

## Agreement §2.2 — the nine required Admin feature areas

The agreement is the scope boundary. §5 excludes "any feature not expressly described in
Section 2", and §6.1 makes anything beyond it a Change Order. These nine rows are what
Milestone 2 (₹25,000, "Backend core + Admin panel") actually owes.

| # | §2.2 feature area | Legacy tables behind it | API | Admin UI |
|---|---|---|---|---|
| 1 | Project Management | `projects`, `builds`, `assigned_tests`, `applied_tests`, `documents` | 12 routes | list + detail + create + assign |
| 2 | Organisation Management | `organisation`, `user_organisation_map`, `user_invitation`, `active_plans` | 10 routes | list + detail + create + members |
| 3 | Communication | `message`, `message_recipient`, `announcements`, `notification`, `comments_monitor` | 8 routes | announcements + threads |
| 4 | Crowd Tester Management | `users`, `skills`, `skill_categories`, `devices`, `user_browsers` | 3 routes | list + detail + verify |
| 5 | Manager Management | `roles`, `permissions`, `projects.project_manager` | 4 routes | list + detail + assign |
| 6 | Ratings & Reviews | `test_review`, `assigned_tests.rate/feedback`, `users.rating` | 4 routes | list + moderate |
| 7 | Transactions | `payment_history`, `payment_acc_details`, `tds_history` | 5 routes | list + detail + record |
| 8 | Profile Management | `users` (own row) | users/me + auth | profile + password + sessions |
| 9 | Sub-Admin Permissions | `roles`, `resources`, `permissions` | 12 routes | permission editor |

All nine are now covered. The API was already complete at 100 routes before this pass; the
gap was UI.

---

## Legacy feature domains, in full

### Identity and access — 7 tables

`users` `roles` `resources` `permissions` `user_organisation_map` `user_invitation` `ci_sessions`

The legacy RBAC is a three-table join: `roles` × `resources` → `permissions(per_roleid,
per_resourceid)`. Permission is granted to a **role**, not to a user, so there is no way to
give one sub-admin a narrower grant than another with the same role. The rebuild replaces
this with per-user grants (`UserPermission`) over a 30-code catalogue, which is what §2.2
row 9 asks for ("configure their access"). Legacy role rows map to the new `Role` enum;
legacy `permissions` rows are **not** migrated, because the model changed shape.

`users` carries 44 columns, doing the work of five tables in the rebuild:

| Legacy columns | Rebuild home |
|---|---|
| `usr_username` `usr_email` `usr_password` `usr_active` `usr_activation_code` | `User` |
| `usr_firstname` `usr_lastname` `usr_phone` `usr_country` `usr_city` `usr_profile_pic` | `User` |
| `usr_gender` `usr_age` `usr_desig` `usr_lang` `usr_apple` `usr_skype` `usr_linkedin` | **no home** — see below |
| `usr_skill_set` `usr_exp_years` `usr_looking_for` `rating` `usr_expert_badge` | `TesterProfile` |
| `usr_agreement_file` `usr_agreement_verification` | `TesterProfile.ndaAcceptedAt` (lossy) |
| `usr_account_balance` | **no home** — §5 excludes wallets |
| `usr_current_orgnisation` | `OrganisationMember` |
| `jira_username` `jira_password` `jira_url` | **deliberately dropped** — B4 |
| `app_token` `usr_silent_mode` `activity_status` `usr_last_login` | partly `User.lastLoginAt` |

Demographics (`usr_gender`, `usr_age`) and social handles have no destination. They are used
by legacy contest targeting (`contests.contest_min_age/max_age/contest_gender`), which is
itself out of scope — so dropping them is consistent, but it is data loss and the Client
should confirm it.

`usr_password varchar(50)` is **blocker B1**: 50 characters fits MD5 (32) or SHA-1 (40) and
nothing modern. A verifier for both, with rehash-to-Argon2id on first successful login, is
implemented at `api/src/lib/legacy-password.ts` and proven end-to-end — but which of the two
the legacy app used cannot be determined from the schema. Confirming it needs one look at
the CodeIgniter login controller, or one real password hash to test against.

### Organisations and commercial — 4 tables

`organisation` `active_plans` `pricing_models` `marketing`

`organisation` holds a **wallet**: `org_wallet_balance`, `locked_amount`, `credit_rate`,
`test_manager_fee`, `org_currency`. `active_plans` is a **subscription**: plan name
(`private`/`diy`/`managed`), start/end dates, and quota counters
(`remaining_projects`, `remaining_private_testers`).

Together these are a metered billing system: a customer buys a plan, the plan grants a
project quota, running a build debits the wallet, and `locked_amount` escrows tester rewards
until release. Agreement §5 excludes "payment gateway, SMS gateway, and email automation
integrations, unless separately scoped", and the rebuild's `Transaction` model is
bookkeeping only. **This is the sharpest scope tension in the whole migration** — §2.8
promises existing users keep working features, and a wallet balance is unambiguously a
working feature with real money in it. Recorded as blocker B3. It needs a Client decision,
not a technical one.

`marketing` (FirstName, LastName, Email, Location, Phone, organization, date) is the
existing contact-form capture. It maps cleanly onto the rebuild's `Lead`, which is already
built and live at `/app/admin/leads`.

### Project → Build → Assignment — 6 tables

`projects` `builds` `build_reports` `assigned_tests` `applied_tests` `assign_testCase`

**This is the structural finding of the review, and blocker B2.**

The legacy platform has *three* levels where the rebuild has two:

```
legacy:   organisation → projects → builds → assigned_tests → bugs_report
rebuild:  Organisation → Project ──────────→ Assignment ───→ Bug
```

A `project` is the long-lived container: which app, which org, cycle type, pricing model,
`project_manager`. A `build` is one actual test cycle inside it: version description, app
link, scope and out-of-scope text, target devices/browsers/OS/countries/languages, start and
end dates, tester count, pricing model, `tester_reward` and currency, invited testers, and
its own lifecycle (`build_test_status`: new → assigned → tested → reviewed → closed).

Everything that matters hangs off the **build**, not the project:

- `bugs_report.bug_build_id` — every defect is filed against a build
- `assigned_tests.ast_build_id` — testers are assigned to builds
- `announcements.A_build_id` — announcements are scoped to a build
- `documents.doc_build_id`, `build_reports.brep_build_id`
- `cust_bug_fields.cbf_build_id` — custom bug form per build
- `test_case.build_id`, `test_scenarios.tsc_build_id`, `testing_time_sheet.tts_build_id`

The rebuild collapsed build into project. That is defensible for new work — one project =
one cycle — but it means a legacy project with five builds has nowhere to land except as
five separate projects, losing the grouping, or as one project, losing four cycles of bug
history. Neither is acceptable under §2.8. **A `Build` model is required before migration.**

`assigned_tests` also carries per-assignment commercial data the rebuild's `Assignment` does
not model: `rate`, `feedback`, `rate_by`, `credit`, `tc`, and
`ast_pmt_status enum('paid','not_paid')`. This is where per-tester payment state lives, and
it ties back to B3.

`applied_tests` is the **crowd self-selection** model — a tester applies to a project rather
than being assigned to it (the table comment reads "one tester can appliy any number of
tests"). Combined with `build_cycle_type enum('crowd','private','managed','diy')`, the legacy
platform supports four delivery models. The rebuild only implements assignment. Crowd
application is a real user-facing feature for existing testers.

### Test execution and artefacts — 8 tables

`test_case` `test_report` `test_scenarios` `test_scenario_reports` `test_review`
`test_status` `test_types` `testing_time_sheet`

A structured test-management layer with no equivalent in the rebuild:

- `test_case` — id, feature, description, steps, expected result, per build
- `assign_testCase` — which testers execute which cases
- `test_report` — per-case execution result (`trep_result`: pass / fail / blocked), with the
  defect id raised, devices and browsers used, and proof
- `test_scenarios` / `test_scenario_reports` — a lighter parallel structure
- `test_review` — the customer's sign-off on a build (`rvw_summary`, `rvw_desc`, `rvw_val`)
- `testing_time_sheet` — **billable hours with an approval workflow**: tester logs
  `tts_total_time`, an admin sets `tts_approved_time` and `tts_approved_by`

Timesheets feed the `hourly_rate` pricing model. Bugs are only one of three ways the legacy
platform records work; the rebuild implements only bugs. §2.3 of the agreement describes the
Tester portal in terms of bugs alone, so test-case execution is arguably outside the written
scope — but it is a working feature for existing users under §2.8.

### Defects — 7 tables

`bugs_report` `bug_types` `defect_comments` `comments_monitor` `attachments`
`cust_bug_fields` `cust_bug_answers`

`bugs_report` is richer than the rebuild's `Bug` in three ways:

1. **Classification depth** — `bug_typeofdefect` (UI / Usability / Functionality),
   `defect_sub_type`, `bug_type_id` → `bug_types`, `bug_ln_defect_type`, `bug_feature`.
   The rebuild has severity and status but no defect taxonomy.
2. **Reproducibility as a fraction** — `bug_reproducibility` plus `sometimeFreq` and
   `sometimeTotal`, i.e. "reproduced 3 times out of 10". The rebuild's
   `BugReproducibility` enum cannot express that.
3. **Evidence fields** — `bug_video_url`, `bug_screen1`, `bug_screen2`, `bug_attachment`,
   plus the `attachments` table. The rebuild has `BugAttachment` and covers this.

Legacy bug *status* is far thinner: `bug_status int` with `0=>Normal, 1=>duplicate,
2=>invalid` against the rebuild's ten-state lifecycle. Migration is therefore a widening —
every legacy `0` becomes `NEW` (or `CONFIRMED`; the Client should choose), `1` becomes
`DUPLICATE`, `2` becomes `REJECTED`. Note the legacy schema has **no** notion of fixed or
verified, so no legacy bug can be migrated as resolved.

`cust_bug_fields` / `cust_bug_answers` let a **customer define extra bug-form fields per
build** (text / dropdown / checkbox / number / boolean, with six option slots). That is a
form-builder. No equivalent in the rebuild and none in the agreement.

`comments_monitor` tracks per-recipient read state on each bug comment — the unread badge.

`bug_export_jira` and `projects.export_project_key` are the Jira export, tied to blocker B4.

### Contests / UX research — 8 tables

`contests` `contest_answers` `contest_feedback` `contest_participant` `contest_question`
`contest_tasks` `cust_feedback_fields` `cust_feedback_answers`

An entire **second product**: timed UX-research contests with prize money (five prize tiers),
demographic targeting (age range, gender, country, employment, industry, parental status),
participant invitation and joining, multi-stage surveys (`survey_type`: pre / post / task),
six answer types (descriptive, scale, multichoice, checkbox, number, verbal), per-task
scheduling, video responses, and a customer-defined feedback form.

Nothing in Agreement §2 mentions contests. It is not in the five modules, not in the §2.2
Admin areas, and not in the role descriptions. Under §5 and §6.1 it is **out of scope and
would need a Change Order**. It is also the single largest omission by table count, and if
the live site runs contests today, §2.8 is in direct conflict with §5 here. Flag to the
Client explicitly rather than discovering it at UAT.

### Finance — 3 tables plus wallet columns

`payment_acc_details` `payment_history` `tds_history`

- `payment_acc_details` — one payout account per user: Indian bank (account no, bank,
  branch, IFSC), non-Indian bank, PayPal email, or Paytm number. **This is the most
  sensitive table in the schema.** It must never reach the public GitHub repository, and the
  rebuild has no destination for it.
- `payment_history` — the ledger: `pmt_type enum('credit','debit','release')`, method,
  amount, currency, summary, and `pmt_time` as a Unix `bigint`. `release` is the escrow
  release that pairs with `organisation.locked_amount`.
- `tds_history` — **Indian Tax Deducted at Source, per user per financial year**. A
  statutory obligation, not a feature. Removing it from a platform that pays Indian testers
  has compliance consequences that are the Client's to weigh.

All three sit inside blocker B3.

### Communication — 4 tables

`message` `message_recipient` `announcements` `notification`

- `message` + `message_recipient(is_read)` — a fan-out inbox, one message to many
  recipients. The rebuild models threads with participants instead, which is a better fit
  for §2.2's "communication threads" but is not the same shape: a legacy broadcast to 40
  testers is 1 message + 40 recipient rows, not 40 threads.
- `announcements` — scoped to a **build** (`A_build_id`), not platform-wide. The rebuild's
  `Announcement` has an `audience` enum instead. Legacy per-build announcements have no
  destination until `Build` exists (B2).
- `notification` — per-**organisation** preference flags (`allN`, `buildStatus`,
  `criticalDef`), i.e. which events an org wants to hear about. The rebuild has a
  `Notification` record but no preference model.

### Device and environment catalogue — 11 tables

`devices` `mobile_brands` `mobile_os_type` `mobile_os_version` `browsers`
`browser_versions` `os` `os_versions` `network_providers` `user_browsers` `base_country`

A normalised hardware/software matrix: brand → OS type → OS version, browser → version, plus
device RAM, screen size, and primary/secondary network provider. `user_browsers` records
which OS/browser/version combinations a specific tester actually has.

This exists so a customer can say "test on Android 13, Chrome 119, on Airtel" and the
platform can find testers who match. The rebuild's `TesterDevice` holds free-text
`model`/`osName`/`osVersion`, which cannot support that matching — free text does not join.
Device-matched tester selection is a real capability that does not survive the migration in
its current form.

`base_country` (iso2, iso3, name_en/fr/de) is a reference table; the rebuild uses ISO codes
directly, which is equivalent and simpler.

### Skills — 2 tables

`skill_categories` → `skills` (with `sname_identifier` slugs). Maps cleanly onto the
rebuild's `Skill`, except the rebuild has no category level. Two-level taxonomy flattens to
one; low-risk, worth confirming.

### Automation — 2 tables

`automation_modules` (module name, steps, expected result, per build) and
`automation_reports` (report file, selected modules, selected scripts). An automation-suite
runner. Not in Agreement §2. Out of scope.

### Documents — 2 tables

`documents` (per project **and** build) and `attachments` (per bug). The rebuild has
`ProjectMaterial` and `BugAttachment` plus a real presigned-upload flow, which supersedes
both — but note `documents.doc_build_id` again needs `Build`.

### Platform operations — 3 tables

- `site_settings` — key/value configuration, editable at runtime by an admin. The rebuild
  uses environment variables, which cannot be changed without a redeploy. If the Client
  currently tunes anything live, this is a regression.
- `site_statistics` — one row per day: logins, new tests, tested tests. The rebuild computes
  stats live from the tables, which is more accurate but loses history that was already
  aggregated. Worth importing as-is for the historical chart.
- `app_types` — desktop / website / app. Maps to the rebuild's `platformTargets`.

---

## What the rebuild does not implement, ranked by risk to §2.8

§2.8 promises: *"Users already existing on the current platform shall not face any issue
with respect to features that rely on their already-migrated data."*

| Risk | Feature | Tables | Status |
|---|---|---|---|
| **Critical** | Build layer — everything hangs off it | `builds` +9 referencing | B2 — schema change needed before migration |
| **Critical** | Legacy password verification | `users.usr_password` | B1 — implemented, algorithm unconfirmed |
| **Critical** | Wallet, ledger, payout accounts, TDS | 3 + wallet columns | B3 — needs Client decision (§5 conflict) |
| **High** | Test cases, execution reports, timesheets | 8 | Not built; arguably outside §2.3 |
| **High** | Crowd self-application + 4 cycle types | `applied_tests`, cycle enums | Not built |
| **High** | Contests / UX research | 8 | Out of scope per §5 — needs Change Order |
| **Medium** | Device-matched tester selection | 11 | Degraded to free text |
| **Medium** | Custom bug + feedback form builder | 4 | Not built |
| **Medium** | Per-build announcements, fan-out inbox, notification prefs | 4 | Partly; blocked on B2 |
| **Medium** | Defect taxonomy + reproducibility fraction | `bug_types` + columns | Not built |
| **Low** | Runtime site settings | `site_settings` | Now env vars |
| **Low** | Daily statistics history | `site_statistics` | Computed live |
| **Low** | Skill categories | `skill_categories` | Flattened |
| **Low** | Automation suite | 2 | Out of scope per §5 |
| **N/A** | Jira credentials | 3 columns | Deliberately dropped — B4 |

---

## What is needed from the Client

Ordered by what blocks work.

1. **A data dump.** The supplied file is structure-only (0 rows). §2.8 migration cannot
   start without the data.
2. **One legacy password hash**, or the CodeIgniter login controller, to settle MD5 vs SHA-1
   (B1). Until then no existing user can sign in.
3. **A decision on money** (B3): does the rebuild carry the wallet, ledger, payout accounts
   and TDS history? §5 excludes it; §2.8 implies it. This is a scope decision with a cost.
4. **A decision on the Build layer** (B2): confirm that projects have multiple test cycles
   and that `Build` should be added. Everything in the migration depends on it.
5. **A decision on contests** (§5 / §6.1): is the contest product live? If so it needs a
   Change Order; if not, confirm we drop 8 tables.
6. **Confirmation on data loss**: tester demographics and social handles, skill categories,
   defect taxonomy, and reproducibility fractions currently have no destination.
7. **Confirm the bug-status mapping**: legacy `0` → `NEW` or `CONFIRMED`?

---

## Security notes on the legacy data

These are not optional.

- **`payment_acc_details` holds bank account numbers, IFSC codes, PayPal addresses and Paytm
  numbers.** The GitHub repository is public. This table must never be committed, and the
  data dump must be transferred out of band, not through the repo.
- **`users` holds email addresses, phone numbers, ages and genders.** Same handling.
- **`jira_password varchar(100)` is reversibly stored by definition** — a 100-character
  column cannot hold a one-way hash of a usable credential. Migrating it would move a live
  third-party credential belonging to someone else into a new database. The columns are
  dropped, and the affected users should be told to rotate those Jira credentials.
- **`ci_sessions`** holds live session blobs. Do not migrate; let everyone re-authenticate.
