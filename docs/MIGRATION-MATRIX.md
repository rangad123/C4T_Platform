# Legacy migration matrix

Generated from `scripts/migration/mapping/registry.ts`. All **66** legacy tables are listed, including those deliberately not migrated.

| Disposition | Tables | Meaning |
| --- | ---: | --- |
| ACTIVE_EQUIVALENT | 33 | The new platform has this concept and uses it. |
| NO_EQUIVALENT | 18 | Nothing in the new schema can hold it. |
| REFERENCE_LOOKUP | 7 | Read to resolve ids; its rows are not themselves migrated. |
| HISTORICAL_EQUIVALENT | 5 | Representable, but as history rather than live state. |
| DEPRECATED | 3 | The concept was retired deliberately. |
| **Total** | **66** | |

**38** tables are migrated by the pipeline; **28** are not, each with a documented reason below.


## Phase 1 — Reference and catalog

| Legacy table | New table(s) | Status | Transformation | Notes |
| --- | --- | --- | --- | --- |
| `app_types` | `Project.platformTargets` | REFERENCE_LOOKUP / NOT_MIGRATED | at_name → a string in Project.platformTargets[] | Resolved when projects are migrated. Seeded from DataCSV for reference. |
| `base_country` | `ISO country codes` | REFERENCE_LOOKUP / NOT_MIGRATED | country name → ISO 3166-1 alpha-2 | The new schema stores bare alpha-2 codes and validates them against src/lib/iso-countries.ts. A second country table would be a duplicate source, which the platform rules forbid. |
| `browser_versions` | `BrowserVersion` | ACTIVE_EQUIVALENT / DIRECT | version → BrowserVersion.version, parent via brw_id | No DataCSV export — this one only exists in the live database. |
| `browsers` | `Browser` | ACTIVE_EQUIVALENT / DIRECT | brw_name → name + slug | Seeded from DataCSV. |
| `bug_types` | `BugType (enum)` | REFERENCE_LOOKUP / NOT_MIGRATED | bt_name → BugType enum member | The new BugType is a closed enum (CRASH, APP_FREEZE, FUNCTIONAL, UI, UX, SECURITY, PERFORMANCE). Legacy names outside it are reported and the bug is stored with type=null rather than being forced into the wrong member. |
| `mobile_brands` | `DeviceBrand` | ACTIVE_EQUIVALENT / DIRECT | mbr_name → DeviceBrand.name, case-normalised | Seeded from DataCSV; "lge" folded into "LG" as the same manufacturer. |
| `mobile_os_type` | `OperatingSystem` | ACTIVE_EQUIVALENT / MERGED | ost_name → OperatingSystem with kind=MOBILE | Second half of the OS merge. No DataCSV export; read from the live database. |
| `mobile_os_version` | `OsVersion` | ACTIVE_EQUIVALENT / MERGED | mov_name → OsVersion under the MOBILE OperatingSystem | Second half of the OS-version merge. |
| `network_providers` | `NetworkProvider` | ACTIVE_EQUIVALENT / DIRECT | network_name + country → NetworkProvider | Carrier list used by TesterDevice.primaryNetworkId / secondaryNetworkId. |
| `os` | `OperatingSystem` | ACTIVE_EQUIVALENT / MERGED | os_name → OperatingSystem, kind from OS_KIND_BY_LEGACY_ID | Merged with mobile_os_type into one OperatingSystem table split by OsKind. |
| `os_versions` | `OsVersion` | ACTIVE_EQUIVALENT / MERGED | version → OsVersion.version, parent via os_type_id | Legacy PK is confusingly also called os_id. Merged with mobile_os_version. Seeded from DataCSV. |
| `permissions` | `Permission (seeded from code)` | REFERENCE_LOOKUP / NOT_MIGRATED | per_name → an existing Permission.code, for resolving grants only | The new permission catalogue is a CLOSED set defined in src/config/permissions.ts and seeded idempotently by prisma/seed.ts. A legacy permission code that is not in that set gates nothing — importing it would fill the admin screen with permissions no route checks, the same failure as importing unknown site_settings keys. Read only to resolve which users held which grants. |
| `pricing_models` | — | NO_EQUIVALENT / NOT_MIGRATED | — | The new platform has no pricing/plan model; commercial terms live outside it. Retained in the legacy database for reference. Referenced by projects.project_pricing_model_id, which is dropped with a note. |
| `resources` | — | NO_EQUIVALENT / NOT_MIGRATED | — | A three-column lookup (res_name, res_desc) with no inbound reference anywhere else in the 66-table schema. Nothing consumes it; nothing to preserve. |
| `roles` | `Role (enum)` | REFERENCE_LOOKUP / NOT_MIGRATED | rol_id → Role enum member, via ROLE_BY_LEGACY_ID | The new platform models roles as a Prisma enum on User, not rows. Read to resolve users.usr_role_id and user_organisation_map.uom_role_id; nothing is written. |
| `skill_categories` | `SkillCategory` | ACTIVE_EQUIVALENT / DIRECT | scat_name → name + slug | Already imported by prisma/seed-catalog.ts from DataCSV. Idempotent upsert on slug. |
| `skills` | `Skill` | ACTIVE_EQUIVALENT / DIRECT | sname → name + slug, category via scat_id | Seeded from DataCSV with documented name fixes (bracketed abbreviations, Localisation/Localization). |
| `test_status` | `TestCaseResult (enum)`, `AssignmentStatus (enum)` | REFERENCE_LOOKUP / NOT_MIGRATED | ts_name → enum member | Resolves assigned_tests.ast_test_status_id and test_report result values. |
| `test_types` | `Build.testType` | REFERENCE_LOOKUP / NOT_MIGRATED | tt_name → Build.testType (free text on the new model) | Kept as a lookup so builds carry a readable name rather than a legacy integer. |

## Phase 2 — Identity

| Legacy table | New table(s) | Status | Transformation | Notes |
| --- | --- | --- | --- | --- |
| `devices` | `TesterDevice` | ACTIVE_EQUIVALENT / DIRECT | dvc_manufacturer/name/ram/screen/networks → TesterDevice, linked to the catalog where a match exists | Runs late in phase 2 because it depends on users. Free-text legacy values are preserved alongside the catalog foreign keys rather than replaced, so an unrecognised handset still displays. |
| `organisation` | `Organisation`, `FileObject` | ACTIVE_EQUIVALENT / RENAMED | org_title → name (+ slug), org_address → addressLine1, org_desc → notes | org_wallet_balance, locked_amount, credit_rate, test_manager_fee and active_plan_id have no destination — the ledger is the source of truth for money. org_currency (enum $/INR) is carried onto each migrated Transaction instead. |
| `user_browsers` | `TesterBrowser` | ACTIVE_EQUIVALENT / JUNCTION | (user, os, browser, browser_version) → TesterBrowser | Depends on the phase-1 browser and OS catalog. |
| `user_invitation` | `OrganisationInvitation` | HISTORICAL_EQUIVALENT / RENAMED | invite_email → email, invite_accepted → acceptedAt, invite_role → orgRole | invite_passcode is NOT migrated into tokenHash: the new flow hashes a single-use token and a legacy passcode is not one. Accepted invitations migrate as history; pending ones migrate already expired, so nobody can redeem a ten-year-old code. |
| `user_organisation_map` | `OrganisationMember` | ACTIVE_EQUIVALENT / JUNCTION | uom_user_id + uom_org_id → OrganisationMember, uom_role_id → OrgMemberRole | uom_status=inactive has no equivalent (OrganisationMember has no status column); those rows are skipped and reported rather than silently reactivating a removed member. |
| `users` | `User`, `TesterProfile`, `FileObject` | ACTIVE_EQUIVALENT / SPLIT | Account fields → User (legacyId=usr_id); testing fields → TesterProfile; usr_profile_pic → FileObject + User.avatarFileId | usr_password (varchar(50)) is unsalted MD5/SHA-1 — carried across with passwordAlgo set by digest length and upgraded to Argon2id on first successful sign-in. jira_username/password/url, usr_apple and export have no equivalent and are reported. usr_account_balance is NOT copied: the new balance is derived from the Transaction ledger, and a stored figure would be a second, diverging source. |

## Phase 3 — Organisation data

| Legacy table | New table(s) | Status | Transformation | Notes |
| --- | --- | --- | --- | --- |
| `active_plans` | — | NO_EQUIVALENT / NOT_MIGRATED | — | Subscription plans (plan_name enum) have no counterpart; the new platform does not model subscriptions. Reported so the commercial history is known to exist in the legacy database. |
| `marketing` | `Lead` | HISTORICAL_EQUIVALENT / RENAMED | FirstName/LastName/Email/Phone/organization → Lead, status=NEW | Website enquiry capture. Maps cleanly onto the new Lead model. marketingConsent defaults false — consent was not recorded, and assuming it is not something a migration may do. |
| `projects` | `Project`, `Build`, `FileObject` | ACTIVE_EQUIVALENT / SPLIT | project_title → title, project_desc → summary, project_scope/out_of_scope → instructions; device/browser/language CSV columns → the default Build | The legacy table has no status column, so ProjectStatus is derived from its builds and dates. project_devices/browsers/test_lang are comma-separated varchars that belong to a build in the new model, so a default Build is created per project to hold them. project_cycle_type, project_pricing_model_id and export_project_key have no destination. |

## Phase 4 — Builds and testing

| Legacy table | New table(s) | Status | Transformation | Notes |
| --- | --- | --- | --- | --- |
| `applied_tests` | — | DEPRECATED / NOT_MIGRATED | — | A tester applying to a project. The new platform is invite-only by design — there is no apply direction to migrate into, and creating assignments from applications would fabricate acceptances that never happened. Reported so the applications remain traceable. |
| `assign_testCase` | `TestCaseAssignment` | ACTIVE_EQUIVALENT / JUNCTION | case_id + tester id → TestCaseAssignment | Note the camelCase table name — it is spelled that way in the dump. |
| `assigned_tests` | `ProjectAssignment`, `Rating` | ACTIVE_EQUIVALENT / SPLIT | ast_build_id + ast_tester_id → ProjectAssignment; rate/rate_by/feedback → Rating | The legacy row carries both the assignment and the customer’s rating of the tester, which are separate models now. ast_pmt_status and credit are handled in phase 7 as ledger entries, not here. |
| `build_reports` | `ProjectMaterial`, `FileObject` | HISTORICAL_EQUIVALENT / MERGED | brep_file_name → FileObject + ProjectMaterial on the build | Uploaded per-build report files. No dedicated model; merged into ProjectMaterial, which is what the new platform uses for build-scoped artefacts. |
| `builds` | `Build`, `BugCustomField` | ACTIVE_EQUIVALENT / DIRECT | 41 columns → Build; target device/browser/OS/country/language CSVs → String[] | Build has no legacyId column, so the mapping lives in migration_record_map. build_customize_bug drives bugCustomizationEnabled. |
| `documents` | `ProjectMaterial`, `FileObject` | ACTIVE_EQUIVALENT / SPLIT | doc_filename + doc_loc_server → FileObject; doc_title → ProjectMaterial.title | ProjectMaterial requires both projectId and buildId; a document with only doc_project_id is attached to that project’s default build. |
| `test_case` | `TestCase` | ACTIVE_EQUIVALENT / DIRECT | case_title → title, steps → steps, expected → expectedResult | The new schema gained TestCase/TestReport/TestReview after the first legacy audit was written; that audit’s "structured testing workflow is MISSING" verdict is out of date. |
| `test_report` | `TestReport` | ACTIVE_EQUIVALENT / DIRECT | result → TestCaseResult, trep_defect_id → TestReport.linkedBugId | trep_defect_id is the load-bearing column: it is what makes a bug the outcome of executing a test case rather than a free-floating report. Resolved in phase 5 once bugs exist. |
| `test_review` | `TestReview` | ACTIVE_EQUIVALENT / DIRECT | rvw_summary → summary, rvw_val → rating | Build-level review with a numeric rating. |
| `test_scenario_reports` | — | NO_EQUIVALENT / NOT_MIGRATED | — | Depends on test_scenarios, which has no destination. |
| `test_scenarios` | — | NO_EQUIVALENT / NOT_MIGRATED | — | Scenarios sit above test cases in the legacy hierarchy. The new schema models cases directly on a build with no scenario grouping, so there is no column to hold a scenario and flattening would invent structure. Reported for review. |
| `testing_time_sheet` | — | NO_EQUIVALENT / NOT_MIGRATED | — | Logged time with tts_approved_time/tts_approved_by, so it fed billing. The new platform has no timesheet model. Flagged as a genuine capability gap rather than obsolete data — see MIGRATION.md, "Known incompatibilities". |

## Phase 5 — Defects

| Legacy table | New table(s) | Status | Transformation | Notes |
| --- | --- | --- | --- | --- |
| `attachments` | `BugAttachment`, `FileObject` | ACTIVE_EQUIVALENT / SPLIT | attach_filename + attach_loc_server → FileObject; row → BugAttachment | A BugAttachment cannot exist without a FileObject, so an attachment whose file cannot be located is reported in missing_files.csv and skipped rather than pointed at a URL that 404s. |
| `bugs_report` | `Bug` | ACTIVE_EQUIVALENT / DIRECT | 33 columns → Bug (legacyId=bug_id); severity/status/type/reproducibility → enums | Bug.buildId is required but the legacy column is nullable, so a bug with no build is attached to its project’s default build rather than dropped. Legacy statuses outside BugStatus are reported and mapped to the closest member. |
| `comments_monitor` | — | NO_EQUIVALENT / NOT_MIGRATED | — | Per-user read receipts for bug comments (user_read, written_to). BugComment has no read-tracking, and the notification feed is not a substitute — a receipt says "this person has seen it", a notification says "this person was told". Reported. |
| `cust_bug_answers` | `BugCustomValue` | ACTIVE_EQUIVALENT / DIRECT | answer → BugCustomValue.value, keyed by bug + field | Skipped when either the bug or the field failed to migrate. |
| `cust_bug_fields` | `BugCustomField` | ACTIVE_EQUIVALENT / DIRECT | cbf_name → name, cbf_type → BugFieldType, options CSV → options[] | Custom bug fields are build-scoped in both schemas. |
| `defect_comments` | `BugComment` | ACTIVE_EQUIVALENT / DIRECT | comment body → BugComment.body, author via written_by | isInternal defaults false — the legacy table draws no internal/external distinction. |

## Phase 6 — Contests

| Legacy table | New table(s) | Status | Transformation | Notes |
| --- | --- | --- | --- | --- |
| `contest_answers` | — | NO_EQUIVALENT / NOT_MIGRATED | — | Participant answers. The new platform has no contest feature at all — no model, no route, no UI. Eight tables of real historical data with nowhere to land; migrating them would require designing and building the feature first. Reported in full so nothing is lost from the record. |
| `contest_feedback` | — | NO_EQUIVALENT / NOT_MIGRATED | — | Feedback submitted per contest. The new platform has no contest feature at all — no model, no route, no UI. Eight tables of real historical data with nowhere to land; migrating them would require designing and building the feature first. Reported in full so nothing is lost from the record. |
| `contest_participant` | — | NO_EQUIVALENT / NOT_MIGRATED | — | Who entered. The new platform has no contest feature at all — no model, no route, no UI. Eight tables of real historical data with nowhere to land; migrating them would require designing and building the feature first. Reported in full so nothing is lost from the record. |
| `contest_question` | — | NO_EQUIVALENT / NOT_MIGRATED | — | Survey questions (survey_type, answer_type). The new platform has no contest feature at all — no model, no route, no UI. Eight tables of real historical data with nowhere to land; migrating them would require designing and building the feature first. Reported in full so nothing is lost from the record. |
| `contest_tasks` | — | NO_EQUIVALENT / NOT_MIGRATED | — | Tasks within a contest. The new platform has no contest feature at all — no model, no route, no UI. Eight tables of real historical data with nowhere to land; migrating them would require designing and building the feature first. Reported in full so nothing is lost from the record. |
| `contests` | — | NO_EQUIVALENT / NOT_MIGRATED | — | The contest itself — 34 columns including prizes, gender targeting and custom feedback. The new platform has no contest feature at all — no model, no route, no UI. Eight tables of real historical data with nowhere to land; migrating them would require designing and building the feature first. Reported in full so nothing is lost from the record. |
| `cust_feedback_answers` | — | NO_EQUIVALENT / NOT_MIGRATED | — | Answers to those custom feedback fields. The new platform has no contest feature at all — no model, no route, no UI. Eight tables of real historical data with nowhere to land; migrating them would require designing and building the feature first. Reported in full so nothing is lost from the record. |
| `cust_feedback_fields` | — | NO_EQUIVALENT / NOT_MIGRATED | — | Custom feedback field definitions, contest-scoped. The new platform has no contest feature at all — no model, no route, no UI. Eight tables of real historical data with nowhere to land; migrating them would require designing and building the feature first. Reported in full so nothing is lost from the record. |

## Phase 7 — Financial

| Legacy table | New table(s) | Status | Transformation | Notes |
| --- | --- | --- | --- | --- |
| `payment_acc_details` | `PaymentAccount` | ACTIVE_EQUIVALENT / DIRECT | Bank/PayPal/Paytm details → encrypted PaymentAccount.secureDetails + masked display fields | The legacy table stores account numbers in the clear. The new model encrypts them into secureDetails and keeps only a last-4/masked form for display, so the migration encrypts on the way in. Raw values never reach a log or a report. |
| `payment_history` | `Transaction` | ACTIVE_EQUIVALENT / DIRECT | pmt_amount → amountMinor (BigInt), pmt_type/method/status → enums, legacyId=pmt_id | Amounts move from float/varchar to integer minor units — the reason the new schema uses BigInt. Currency comes from the owning organisation’s org_currency. |
| `tds_history` | `Transaction.tdsAmountMinor` | ACTIVE_EQUIVALENT / MERGED | tds amount → tdsAmountMinor on the related Transaction | Indian withholding tax. Merged onto the transaction it belongs to rather than kept as a separate ledger, which is how the new schema models it. |

## Phase 8 — Communication and system

| Legacy table | New table(s) | Status | Transformation | Notes |
| --- | --- | --- | --- | --- |
| `announcements` | `Announcement` | ACTIVE_EQUIVALENT / DIRECT | A_body → body, A_build_id → buildId, audience=ALL | Announcement.title is required and the legacy table has no title column; the first line of the body is used, which is what the legacy UI displayed anyway. |
| `message` | `Broadcast` | HISTORICAL_EQUIVALENT / RENAMED | creator_id → senderId, message_body → body, status=SENT | One author, many recipients, no reply — that is the new Broadcast model, not Thread/Message (which is two-way). Mapping it to a Thread would imply conversations that never existed. |
| `message_recipient` | `BroadcastRecipient` | HISTORICAL_EQUIVALENT / JUNCTION | recipient_id + message_id → BroadcastRecipient | is_read has no destination — BroadcastRecipient records delivery and failure, not reading. Reported once per run rather than per row. |
| `notification` | — | NO_EQUIVALENT / NOT_MIGRATED | — | Per-organisation notification PREFERENCES (allN, buildStatus, criticalDef), not notification records. The new platform has a single per-user User.emailNotifications flag and no per-event or per-org preferences, so there is nothing with the right shape to receive these. |
| `site_settings` | `PlatformSetting` | ACTIVE_EQUIVALENT / DIRECT | key_name → key, key_value → value | Imported only where the key is one the new platform recognises; unknown legacy keys are reported rather than written, so the settings table does not fill with dead configuration. |
| `site_statistics` | — | DEPRECATED / NOT_MIGRATED | — | A precomputed rollup of counts the new platform queries live. Migrating it would create a second, immediately stale source for numbers the database can already answer exactly. |

## Phase 9 — Automation

| Legacy table | New table(s) | Status | Transformation | Notes |
| --- | --- | --- | --- | --- |
| `automation_modules` | — | NO_EQUIVALENT / NOT_MIGRATED | — | Automation suites. The new platform has no automation feature. Reported; the data stays in the legacy database. |
| `automation_reports` | — | NO_EQUIVALENT / NOT_MIGRATED | — | Automation run results. Depends on automation_modules, which has no destination. |

## Infrastructure

| Legacy table | New table(s) | Status | Transformation | Notes |
| --- | --- | --- | --- | --- |
| `ci_sessions` | — | DEPRECATED / NOT_MIGRATED | — | CodeIgniter PHP session storage — ephemeral infrastructure, not business data, and the brief calls it out by name. The new platform issues its own stateful sessions; importing decade-old PHP session blobs would be meaningless and is the one table with no primary key to stream on. |

