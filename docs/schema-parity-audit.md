# Schema parity audit — legacy vs new

`api/old sql/crowd4testDB.sql` (66 tables / 600 columns) vs `api/prisma/schema.prisma`
(46 models / 572 fields, up from 36/477 before the catalog/skills/bank-details/transactions pass).

This is the table-level verdict. Column-level detail is in
`legacy-schema-inventory.md`; capability-level detail is in
`legacy-feature-schema-mapping.md`.

## Summary

| Status | Count | Meaning |
| --- | --- | --- |
| MAPPED | 27 | Concept fully carried over, often renamed or normalised. |
| PARTIAL | 10 | Present, but specific legacy fields or relationships are not represented. |
| MISSING | 29 | No equivalent exists in the new platform. |
| **Total** | **66** | |

> The new platform has **46 models vs 66 legacy tables**. That is not itself a loss —
> lookup tables became enums, and several legacy tables were normalised together. The
> real losses are enumerated below.

---

## Full table map

| Legacy table | New equivalent | Status | Notes |
| --- | --- | --- | --- |
| `user_invitation` | — | **MISSING** | No invitation entity. Org member onboarding has no invite/passcode/accept flow. |
| `users` | User + TesterProfile | **PARTIAL** | Split across two models. Missing: jira_* integration, usr_expert_badge, usr_agreement_file/verification, usr_silent_mode, usr_looking_for, usr_apple/skype/linkedin, usr_account_balance. |
| `announcements` | Announcement | **MAPPED** | Legacy was build-scoped (A_build_id); new is project-scoped + audience enum. |
| `organisation` | Organisation | **MAPPED** | Wallet/credit/plan fields MISSING (org_wallet_balance, locked_amount, credit_rate, test_manager_fee, active_plan_id, org_currency). |
| `permissions` | Permission + UserPermission | **MAPPED** | Legacy role->resource rows replaced by a permission catalogue + per-user grants. |
| `resources` | Permission.code | **MAPPED** | Legacy resource rows are encoded as permission code strings. |
| `roles` | Role enum | **MAPPED** | Legacy dynamic table -> fixed enum. Intentional: roles are not tenant-configurable in the new platform. |
| `user_organisation_map` | OrganisationMember | **MAPPED** | uom_status -> membership existence; orgRole preserved. |
| `applied_tests` | — | **MISSING** | Tester self-application to a test cycle. New platform is invite-only. |
| `assign_testCase` | — | **MISSING** | Junction: test cases assigned to testers per build. |
| `build_reports` | — | **MISSING** | Generated build report files (ties to the Reports module gap). |
| `test_case` | — | **MISSING** | Structured test cases (id, feature, desc, steps, expected result, status). |
| `test_report` | — | **MISSING** | Per-test-case execution results (pass/fail/blocked, devices, browsers, proof, linked defect). |
| `test_review` | — | **MISSING** | Build-level review/summary with a numeric rating. |
| `test_scenario_reports` | — | **MISSING** | Scenario execution reports. |
| `test_scenarios` | — | **MISSING** | Scenario definitions assigned to testers. |
| `test_status` | — | **MISSING** | Lookup for assignment/test status. |
| `test_types` | — | **MISSING** | Lookup for test type (exploratory, regression...). Legacy builds referenced build_test_type_id. |
| `testing_time_sheet` | — | **MISSING** | Per-tester per-day time logging with approval workflow. |
| `app_types` | Project.platformTargets | **PARTIAL** | Free-text array instead of a lookup. |
| `assigned_tests` | ProjectAssignment | **PARTIAL** | Missing: ast_devices, ast_browsers, ast_language, rate, feedback, rate_by, credit, tc, ast_pmt_status. |
| `builds` | Project | **PARTIAL** | NO BUILD ENTITY. Project==Build merged. Loses multi-build-per-project, build_version_no, release notes, apk file, per-build pricing/rewards, cycle type, copy-build. |
| `projects` | Project | **PARTIAL** | Missing: export_project_key (JIRA), project_manager, project_pricing_model_id, project_cycle_type, project_testdata. |
| `comments_monitor` | — | **MISSING** | Per-user read/unread tracking on bug comments. |
| `cust_bug_answers` | — | **MISSING** | Answers to the above, per bug. |
| `cust_bug_fields` | — | **MISSING** | Per-build custom bug fields (text/dropdown/checkbox/number/boolean, 6 options). |
| `bugs_report` | Bug | **PARTIAL** | Missing: bug_pre_condition, sometimeFreq/sometimeTotal, defect_sub_type, bug_video_url, bug_export_jira, bug_ln_defect_type, bug_assign_test_id link. |
| `attachments` | BugAttachment + FileObject | **MAPPED** | Normalised into a generic file store. |
| `bug_types` | BugType enum | **MAPPED** | Legacy per-tenant table -> fixed enum. Loses tenant-defined bug types. |
| `defect_comments` | BugComment | **MAPPED** | Legacy had 2 attachment slots; new uses isInternal + separate attachments. |
| `contest_answers` | — | **MISSING** | Participant answers incl. video URL. |
| `contest_feedback` | — | **MISSING** | Contest feedback with device/browser/attachment/video. |
| `contest_participant` | — | **MISSING** | Contest participation + invite/join/submit timestamps. |
| `contest_question` | — | **MISSING** | Pre/post/task survey questions with 6 answer types. |
| `contest_tasks` | — | **MISSING** | Dated contest tasks. |
| `contests` | — | **MISSING** | Entire contests module. |
| `cust_feedback_answers` | — | **MISSING** | Answers to the above. |
| `cust_feedback_fields` | — | **MISSING** | Per-contest custom feedback fields. |
| `browser_versions` | BrowserVersion | **MAPPED** | Catalog table, seeded by hand (no CSV source). |
| `browsers` | Browser | **MAPPED** | Seeded from `DataCSV/browsers.csv` (6 rows). |
| `mobile_brands` | DeviceBrand | **MAPPED** | Seeded from `DataCSV/mobile_brands.csv` (53 rows → 51 unique, deduped). |
| `mobile_os_type` | OperatingSystem (`kind=MOBILE`) | **MAPPED** | Merged with `os` into one table with an `OsKind` discriminator. |
| `mobile_os_version` | OsVersion (mobile rows) | **MAPPED** | Merged with `os_versions`, same reasoning. |
| `network_providers` | NetworkProvider | **MAPPED** | No CSV source in the legacy export; seeded by hand (8 carriers). |
| `os` | OperatingSystem | **MAPPED** | Seeded from `DataCSV/os.csv` — this is the unified OS-type list `os_versions.os_type_id` actually references. |
| `os_versions` | OsVersion | **MAPPED** | Seeded from `DataCSV/os_versions.csv` (60 rows → 59 unique). |
| `devices` | TesterDevice | **PARTIAL** | Catalog FKs (`deviceModelId`/`osVersionRefId`/`primaryNetworkId`/`secondaryNetworkId`) now exist alongside the free-text columns, never replacing them. Still no soft delete; model name stays free text by design. |
| `user_browsers` | TesterBrowser | **MAPPED** | Real per-tester join to Browser/BrowserVersion/OperatingSystem now exists, independent of `TesterDevice.browser`'s free-text mirror. |
| `active_plans` | — | **MISSING** | Org subscription plan + remaining project/tester quotas. |
| `payment_acc_details` | PaymentAccount | **MAPPED** | Sensitive fields (account name/number, IFSC, PayPal email, Paytm number) live only inside an AES-256-GCM envelope, never a plaintext column. Masked-by-default; reveal is a separate audited, password-gated admin action. |
| `pricing_models` | — | **MISSING** | Pricing model lookup (tester_credit/hourly_rate/bug_bounty). |
| `tds_history` | Transaction.tdsAmountMinor | **MAPPED** | Folded into the transaction it belongs to, rather than a separate table — every row was already one TDS figure tied to one payment. Financial year is computed from `occurredAt`, not stored. |
| `payment_history` | Transaction | **PARTIAL** | `pmt_method`/`pmt_method_details`/`pmt_amount`/`pmt_summary`/build-contest linkage now map onto `paymentMethod`/`paymentAccountId`/`amountMinor`/`description`/`buildOrContestRef`. Still missing: `pmt_status`'s new/seen read-tracking flag (a different concept from `TransactionStatus`). Indian/International/Pending (§21-27) is derived from `paymentMethod`+`currency`+`status`, not stored. |
| `automation_modules` | — | **MISSING** | Automation module/script definitions per build. |
| `automation_reports` | — | **MISSING** | Automation run reports. |
| `notification` | Notification | **PARTIAL** | Legacy was per-org notification preferences (allN/buildStatus/criticalDef); new is a notification feed. Preference concept MISSING. |
| `message` | Message | **MAPPED** | Now thread-based rather than standalone message+recipient. |
| `message_recipient` | ThreadParticipant | **MAPPED** | is_read -> lastReadAt. |
| `skill_categories` | SkillCategory | **MAPPED** | Was a fixed 4-value enum; promoted to a real catalog table (matching every other reference entity) and seeded from `DataCSV/skill_categories.csv`. |
| `skills` | Skill | **MAPPED** | `sname_cat_id` → a relation to `SkillCategory`. Seeded from `DataCSV/skills.csv` (26 rows), reconciled with 8 pre-existing skills. Testers now select from this catalog rather than typing a skill into existence. |
| `site_settings` | — | **MISSING** | Global key/value settings. |
| `site_statistics` | — | **MISSING** | Daily aggregate stats (logins, new tests, tested). |
| `base_country` | countryCode strings | **PARTIAL** | No country lookup table; ISO codes stored as free strings. |
| `ci_sessions` | Session | **MAPPED** | Framework session table -> real session model with refresh rotation. |
| `documents` | ProjectMaterial + FileObject | **MAPPED** | doc_build_id collapses to project. |
| `marketing` | Lead | **MAPPED** | Marketing capture -> Lead pipeline. |

---

## Tables with no equivalent (29)

**Organisation / User / RBAC** — `user_invitation`

**Project / Build / Testing** — `applied_tests`, `test_case`, `test_report`, `test_review`, `test_scenarios`, `test_scenario_reports`, `test_status`, `test_types`, `testing_time_sheet`, `assign_testCase`, `build_reports`

**Bug / Defect Management** — `comments_monitor`, `cust_bug_fields`, `cust_bug_answers`

**Contests** — `contests`, `contest_participant`, `contest_question`, `contest_answers`, `contest_tasks`, `contest_feedback`, `cust_feedback_fields`, `cust_feedback_answers`

**Payments / Plans** — `active_plans`, `pricing_models`

_(`payment_acc_details` and `tds_history` moved to MAPPED — see the table above. The
Devices/OS/Browsers catalog is now fully MAPPED or PARTIAL — none of that family is MISSING
any longer.)_

**Automation** — `automation_modules`, `automation_reports`

**System / Misc** — `site_settings`, `site_statistics`
