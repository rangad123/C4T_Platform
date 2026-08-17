# Legacy schema inventory

Generated from `api/old sql/crowd4testDB.sql` — the legacy MariaDB dump — and compared
against `api/prisma/schema.prisma`. Every one of the **66 legacy tables** and **600 legacy
columns** is listed. No table is omitted.

Status values: `MAPPED` (concept fully present, possibly renamed/normalised), `PARTIAL`
(present but loses fields or relationships), `MISSING` (no equivalent in the new platform).

| Status | Tables |
| --- | --- |
| MAPPED | 16 |
| PARTIAL | 11 |
| MISSING | 39 |
| **Total** | **66** |

---

## Organisation / User / RBAC

### `user_invitation`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** No invitation entity. Org member onboarding has no invite/passcode/accept flow.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `invite_id` | int(11) | no |  |  |
| `invite_created_by` | int(11) | no |  |  |
| `invite_org_id` | int(11) | no |  |  |
| `invite_email` | varchar(255) | no |  |  |
| `invite_role` | int(11) | no |  |  |
| `invite_passcode` | varchar(55) | no |  |  |
| `invite_datetime` | timestamp | no | `current_timestamp()` |  |
| `invite_accepted` | enum('yes','no') | no | `'no'` |  |

### `users`  —  **PARTIAL**

- **New equivalent:** User + TesterProfile
- **Assessment:** Split across two models. Missing: jira_* integration, usr_expert_badge, usr_agreement_file/verification, usr_silent_mode, usr_looking_for, usr_apple/skype/linkedin, usr_account_balance.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `usr_id` | int(11) | no |  |  |
| `usr_role_id` | int(11) | no |  |  |
| `usr_username` | varchar(50) | no |  |  |
| `usr_password` | varchar(50) | no |  |  |
| `usr_email` | varchar(50) | no |  |  |
| `usr_firstname` | varchar(50) | yes | `NULL` |  |
| `usr_lastname` | varchar(50) | yes | `NULL` |  |
| `usr_companyname` | varchar(50) | yes | `NULL` |  |
| `usr_phone` | varchar(50) | yes | `NULL` |  |
| `usr_add_date` | timestamp | yes | `NULL` |  |
| `usr_upd_date` | timestamp | yes | `NULL` |  |
| `usr_add_by` | int(11) | yes | `NULL` |  |
| `usr_upd_by` | int(11) | yes | `NULL` |  |
| `usr_active` | enum('active','inactive') | no | `'inactive'` |  |
| `usr_silent_mode` | enum('active','inactive') | no | `'active'` |  |
| `usr_country` | varchar(50) | no |  |  |
| `usr_activation_code` | longtext | no |  |  |
| `usr_profile_pic` | varchar(500) | no | `''` |  |
| `usr_skill_set` | varchar(255) | yes | `NULL` |  |
| `usr_account_balance` | double | yes | `0` |  |
| `usr_looking_for` | varchar(255) | yes | `NULL` |  |
| `usr_exp_years` | int(11) | yes | `NULL` |  |
| `usr_current_orgnisation` | int(11) | yes | `NULL` |  |
| `app_token` | varchar(255) | no |  |  |
| `usr_cont_info` | varchar(30) | yes | `NULL` |  |
| `country_flag` | varchar(30) | yes | `NULL` |  |
| `usr_city` | varchar(200) | yes | `NULL` |  |
| `usr_apple` | varchar(50) | yes | `NULL` |  |
| `usr_skype` | varchar(50) | yes | `NULL` |  |
| `usr_linkedin` | varchar(100) | yes | `NULL` |  |
| `usr_gender` | varchar(10) | yes | `NULL` |  |
| `usr_age` | varchar(5) | yes | `NULL` |  |
| `usr_desig` | varchar(50) | yes | `NULL` |  |
| `usr_lang` | varchar(50) | yes | `NULL` |  |
| `export` | varchar(100) | yes | `NULL` |  |
| `jira_username` | varchar(100) | yes | `NULL` |  |
| `jira_password` | varchar(100) | yes | `NULL` |  |
| `jira_url` | varchar(100) | yes | `NULL` |  |
| `rating` | varchar(20) | yes | `NULL` |  |
| `usr_last_login` | timestamp | yes | `NULL` |  |
| `activity_status` | enum('active','inactive') | no | `'inactive'` |  |
| `usr_expert_badge` | varchar(255) | no |  |  |
| `usr_agreement_file` | varchar(255) | yes | `NULL` |  |
| `usr_agreement_verification` | enum('verified','rejected') | yes | `NULL` |  |

### `announcements`  —  **MAPPED**

- **New equivalent:** Announcement
- **Assessment:** Legacy was build-scoped (A_build_id); new is project-scoped + audience enum.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `id` | int(200) | no |  |  |
| `A_build_id` | int(100) | no |  |  |
| `A_body` | longtext | no |  |  |
| `A_added_by` | int(100) | no |  |  |
| `A_added_date` | timestamp | no | `current_timestamp()` |  |
| `A_updated_date` | timestamp | no | `current_timestamp()` |  |

### `organisation`  —  **MAPPED**

- **New equivalent:** Organisation
- **Assessment:** Wallet/credit/plan fields MISSING (org_wallet_balance, locked_amount, credit_rate, test_manager_fee, active_plan_id, org_currency).

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `org_id` | int(11) | no |  |  |
| `org_title` | varchar(100) | yes | `NULL` |  |
| `org_image` | varchar(100) | no | `''` |  |
| `org_address` | varchar(100) | yes | `''` |  |
| `org_desc` | text | yes | `NULL COMMENT 'Detailed description'` | Detailed description |
| `credit_rate` | varchar(20) | yes | `NULL` |  |
| `test_manager_fee` | varchar(20) | yes | `NULL` |  |
| `active_plan_id` | varchar(50) | yes | `NULL` |  |
| `org_wallet_balance` | int(50) | yes | `NULL` |  |
| `org_created_by` | int(11) | no |  |  |
| `org_update_by` | int(11) | yes | `NULL` |  |
| `org_created_date` | timestamp | yes | `current_timestamp()` |  |
| `org_update_date` | timestamp | no | `'0000-00-00 00:00:00'` |  |
| `locked_amount` | int(100) | yes | `NULL` |  |
| `org_currency` | enum('$','INR') | yes | `NULL` |  |

### `permissions`  —  **MAPPED**

- **New equivalent:** Permission + UserPermission
- **Assessment:** Legacy role->resource rows replaced by a permission catalogue + per-user grants.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `per_id` | int(11) | no |  |  |
| `per_roleid` | int(11) | yes | `0` |  |
| `per_resourceid` | int(11) | yes | `0` |  |

### `resources`  —  **MAPPED**

- **New equivalent:** Permission.code
- **Assessment:** Legacy resource rows are encoded as permission code strings.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `res_id` | int(11) | no |  |  |
| `res_name` | varchar(50) | yes | `NULL` |  |
| `res_desc` | varchar(50) | yes | `NULL` |  |

### `roles`  —  **MAPPED**

- **New equivalent:** Role enum
- **Assessment:** Legacy dynamic table -> fixed enum. Intentional: roles are not tenant-configurable in the new platform.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `rol_id` | int(11) | no |  |  |
| `rol_name` | varchar(50) | yes | `NULL` |  |
| `rol_desc` | varchar(50) | yes | `NULL` |  |

### `user_organisation_map`  —  **MAPPED**

- **New equivalent:** OrganisationMember
- **Assessment:** uom_status -> membership existence; orgRole preserved.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `uom_id` | int(11) | no |  |  |
| `uom_user_id` | int(11) | no |  |  |
| `uom_org_id` | int(11) | no |  |  |
| `uom_role_id` | int(11) | no |  |  |
| `uom_added_by` | int(11) | yes | `NULL` |  |
| `uom_creation_date` | timestamp | no | `current_timestamp()` |  |
| `uom_status` | enum('active','inactive') | no | `'inactive'` |  |

---

## Project / Build / Testing

### `applied_tests`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Tester self-application to a test cycle. New platform is invite-only.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `apt_id` | int(11) | no |  |  |
| `apt_tester_id` | int(11) | no | `0` |  |
| `apt_project_id` | int(11) | no | `0` |  |
| `apt_add_date` | timestamp | no | `current_timestamp()` |  |
| `apt_add_by` | int(11) | no | `0` |  |

### `assign_testCase`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Junction: test cases assigned to testers per build.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `Sno` | int(20) | no |  |  |
| `case_id` | varchar(1500) | no |  |  |
| `tester_id` | varchar(1000) | no |  |  |
| `build_id` | varchar(20) | no |  |  |

### `build_reports`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Generated build report files (ties to the Reports module gap).

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `brep_id` | int(100) | no |  |  |
| `brep_file_name` | varchar(500) | no |  |  |
| `brep_build_id` | int(100) | no |  |  |
| `brep_user_id` | int(100) | no |  |  |
| `brep_time` | timestamp | no | `current_timestamp()` |  |

### `test_case`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Structured test cases (id, feature, desc, steps, expected result, status).

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `case_id` | int(11) | no |  |  |
| `testCaseId` | varchar(100) | no |  |  |
| `testCaseFeature` | varchar(255) | yes | `NULL` |  |
| `testCaseDesc` | text | no |  |  |
| `testCaseSteps` | text | no |  |  |
| `expectedResult` | varchar(1500) | no |  |  |
| `test_id` | int(11) | no |  |  |
| `test_status` | varchar(200) | no |  |  |
| `build_id` | varchar(20) | yes | `NULL` |  |

### `test_report`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Per-test-case execution results (pass/fail/blocked, devices, browsers, proof, linked defect).

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `trep_id` | int(11) | no |  |  |
| `trep_build_id` | int(11) | yes | `NULL` |  |
| `trep_assign_test_id` | int(11) | yes | `NULL` |  |
| `trep_case_id` | varchar(50) | yes | `NULL COMMENT 'uniq identification'` | uniq identification |
| `trep_desc` | longtext | yes | `NULL` |  |
| `trep_steps` | longtext | yes | `NULL` |  |
| `trep_result` | varchar(50) | yes | `NULL COMMENT 'pass fail blocked'` | pass fail blocked |
| `trep_defect_id` | varchar(50) | yes | `NULL COMMENT 'to be selected from - defect id column of defect report table'` | to be selected from - defect id column of defect report table |
| `trep_add_by` | int(11) | yes | `NULL` |  |
| `trep_upd_by` | int(11) | yes | `NULL` |  |
| `trep_add_date` | timestamp | yes | `current_timestamp()` |  |
| `trep_upd_date` | timestamp | yes | `NULL` |  |
| `test_devices` | varchar(100) | no |  |  |
| `test_browsers` | varchar(300) | yes | `NULL` |  |
| `test_case_id` | int(11) | yes | `NULL` |  |
| `trep_proof` | varchar(50) | yes | `NULL` |  |
| `other` | varchar(1500) | yes | `NULL` |  |

### `test_review`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Build-level review/summary with a numeric rating.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `rvw_id` | int(11) | no |  |  |
| `rvw_build_id` | int(11) | yes | `NULL` |  |
| `rvw_summary` | longtext | yes | `NULL` |  |
| `rvw_desc` | longtext | yes | `NULL` |  |
| `rvw_val` | int(11) | yes | `NULL` |  |
| `rvw_add_date` | timestamp | no | `current_timestamp()` |  |
| `rvw_add_by` | int(11) | yes | `NULL` |  |

### `test_scenario_reports`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Scenario execution reports.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `tsr_id` | int(255) | no |  |  |
| `tsr_sc_id` | int(255) | no |  |  |
| `tsr_build_id` | int(255) | no |  |  |
| `tsr_desc` | varchar(255) | yes | `NULL` |  |
| `tsr_link` | varchar(255) | no |  |  |
| `tsr_other` | varchar(255) | yes | `NULL` |  |
| `tsr_add_by` | int(100) | no |  |  |
| `tsr_upd_by` | int(100) | no |  |  |
| `tsr_add_date` | timestamp | no | `current_timestamp()` |  |
| `tsr_upd_date` | timestamp | no | `current_timestamp()` |  |

### `test_scenarios`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Scenario definitions assigned to testers.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `tsc_id` | int(255) | no |  |  |
| `tsc_desc` | varchar(255) | no |  |  |
| `tsc_steps` | varchar(255) | no |  |  |
| `tsc_build_id` | int(100) | no |  |  |
| `tsc_assigned_testers` | int(100) | no |  |  |
| `tsc_add_date` | timestamp | no | `current_timestamp()` |  |
| `tsc_upd_date` | timestamp | no | `current_timestamp()` |  |

### `test_status`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Lookup for assignment/test status.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `ts_id` | int(11) | no |  |  |
| `ts_name` | varchar(50) | yes | `NULL` |  |
| `ts_desc` | varchar(50) | yes | `NULL` |  |

### `test_types`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Lookup for test type (exploratory, regression...). Legacy builds referenced build_test_type_id.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `tt_id` | int(11) | no |  |  |
| `tt_name` | varchar(100) | yes | `NULL` |  |
| `tt_desc` | varchar(200) | yes | `NULL` |  |

### `testing_time_sheet`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Per-tester per-day time logging with approval workflow.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `tts_id` | int(50) | no |  |  |
| `tts_build_id` | int(50) | no |  |  |
| `tts_tester_id` | int(50) | no |  |  |
| `tts_date` | date | no |  |  |
| `tts_total_time` | time | no |  |  |
| `tts_add_time` | timestamp | no | `current_timestamp()` |  |
| `tts_approved_time` | time | yes | `NULL` |  |
| `tts_approved_by` | int(50) | yes | `NULL` |  |
| `tts_upd_by` | int(50) | no |  |  |
| `tts_upd_time` | timestamp | no | `current_timestamp()` |  |

### `app_types`  —  **PARTIAL**

- **New equivalent:** Project.platformTargets
- **Assessment:** Free-text array instead of a lookup.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `at_id` | int(11) | no |  |  |
| `at_name` | varchar(100) | yes | `NULL` |  |
| `at_desc` | varchar(200) | yes | `NULL` |  |

### `assigned_tests`  —  **PARTIAL**

- **New equivalent:** ProjectAssignment
- **Assessment:** Missing: ast_devices, ast_browsers, ast_language, rate, feedback, rate_by, credit, tc, ast_pmt_status.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `ast_id` | int(11) | no |  |  |
| `ast_build_id` | int(11) | no | `0` |  |
| `ast_tester_id` | int(11) | no | `0 COMMENT 'a tester to whom test has been assigned '` | a tester to whom test has been assigned  |
| `ast_test_status_id` | int(11) | no | `0` |  |
| `ast_add_date` | timestamp | no | `current_timestamp()` |  |
| `ast_add_by` | int(11) | no | `0` |  |
| `ast_devices` | varchar(300) | yes | `NULL` |  |
| `ast_browsers` | varchar(300) | yes | `NULL` |  |
| `ast_language` | varchar(255) | yes | `NULL` |  |
| `rate` | varchar(20) | yes | `NULL` |  |
| `feedback` | varchar(200) | yes | `NULL` |  |
| `rate_by` | varchar(20) | yes | `NULL` |  |
| `credit` | varchar(20) | yes | `NULL` |  |
| `tc` | varchar(20) | yes | `NULL` |  |
| `ast_pmt_status` | enum('paid','not_paid') | no | `'not_paid'` |  |

### `builds`  —  **PARTIAL**

- **New equivalent:** Project
- **Assessment:** NO BUILD ENTITY. Project==Build merged. Loses multi-build-per-project, build_version_no, release notes, apk file, per-build pricing/rewards, cycle type, copy-build.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `build_id` | int(11) | no |  |  |
| `project_id` | int(11) | no |  | Project Id to which build belongs |
| `build_customize_bug` | enum('yes','no') | no | `'no'` |  |
| `build_test_type_id` | int(11) | no |  |  |
| `build_version_desc` | varchar(255) | yes | `NULL COMMENT 'Build Description or version name'` | Build Description or version name |
| `build_app_link` | varchar(400) | yes | `NULL` |  |
| `build_desc` | text | yes | `NULL COMMENT 'detailed description'` | detailed description |
| `build_scope` | text | no |  |  |
| `build_feature_list` | varchar(255) | yes | `NULL` |  |
| `build_devices` | varchar(255) | no |  |  |
| `build_browsers` | varchar(255) | no |  |  |
| `build_browser_spec` | int(11) | yes | `NULL` |  |
| `build_os` | varchar(255) | no |  |  |
| `build_os_spec` | int(11) | yes | `NULL` |  |
| `TestCountry` | varchar(255) | yes | `NULL` |  |
| `build_languages` | varchar(500) | yes | `NULL` |  |
| `build_start_date` | date | no |  |  |
| `build_end_date` | date | no |  |  |
| `doc_id` | int(11) | yes | `NULL` |  |
| `build_add_by` | int(11) | yes | `NULL` |  |
| `build_upd_by` | int(11) | yes | `NULL` |  |
| `build_add_date` | timestamp | yes | `current_timestamp()` |  |
| `build_upd_date` | timestamp | yes | `current_timestamp()` |  |
| `build_test_scenario` | varchar(255) | yes | `NULL` |  |
| `build_per_test_type` | enum('load_test','stress_test','soak_test','soike_test') | yes | `NULL` |  |
| `build_per_protocol` | enum('http','https','tcp','ftp') | yes | `NULL` |  |
| `build_per_load` | int(100) | yes | `NULL` |  |
| `build_cycle_type` | enum('crowd','private','managed','diy') | yes | `'private'` |  |
| `build_release_notes` | text | yes | `NULL COMMENT 'Build release notes'` | Build release notes |
| `build_version_no` | varchar(50) | yes | `NULL COMMENT 'Build version number'` | Build version number |
| `build_apk_file` | varchar(100) | yes | `'0'` |  |
| `build_testdata` | varchar(1000) | no | `'0'` |  |
| `build_testers` | int(11) | no |  |  |
| `build_pricing_model` | enum('tester_credit','hourly_rate','bug_bounty') | yes | `'tester_credit'` |  |
| `tester_reward` | int(50) | yes | `NULL` |  |
| `rewards_currency` | enum('$','INR') | yes | `NULL` |  |
| `build_outof_scope` | text | no |  |  |
| `invited_testers` | longtext | yes | `NULL` |  |
| `build_test_status` | enum('new','assigned','tested','reviewed','closed') | yes | `'new'` |  |
| `build_document` | varchar(255) | yes | `NULL` |  |
| `others_bug_visibility` | enum('yes','no') | yes | `'yes'` |  |

### `projects`  —  **PARTIAL**

- **New equivalent:** Project
- **Assessment:** Missing: export_project_key (JIRA), project_manager, project_pricing_model_id, project_cycle_type, project_testdata.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `project_id` | int(11) | no |  |  |
| `org_id` | int(11) | no |  |  |
| `project_title` | varchar(100) | yes | `NULL` |  |
| `project_app_type_id` | int(11) | yes |  | type of application [drop down] (values : mobille app , website, desktop app) |
| `project_devices` | varchar(500) | yes | `NULL COMMENT 'devices on which to be test - (text area )(user will add comma seprated list)'` | devices on which to be test - (text area )(user will add comma seprated list) |
| `project_os_id` | int(11) | no |  | Operating system (drop down box) (val: android os, ios, windows, ) |
| `project_browsers` | varchar(500) | yes | `NULL COMMENT 'textarea- information with versions'` | textarea- information with versions |
| `project_image_icon` | varchar(100) | no | `''` |  |
| `project_testdata` | varchar(500) | no | `''` |  |
| `project_desc` | text | yes | `NULL COMMENT 'Detailed description'` | Detailed description |
| `project_scope` | text | yes | `NULL` |  |
| `project_testers` | int(11) | no |  |  |
| `project_outof_scope` | text | yes | `NULL` |  |
| `project_test_type_id` | int(11) | no | `0` |  |
| `project_pricing_model_id` | int(11) | no | `0` |  |
| `project_cycle_type` | enum('crowd','private','managed','diy') | no | `'private'` |  |
| `project_created_by` | int(11) | no |  |  |
| `project_update_by` | int(11) | yes | `NULL` |  |
| `project_created_date` | timestamp | yes | `current_timestamp()` |  |
| `project_update_date` | timestamp | yes | `current_timestamp()` |  |
| `export_project_key` | varchar(20) | yes | `NULL` |  |
| `project_test_lang` | varchar(1000) | yes | `NULL` |  |
| `project_manager` | varchar(50) | yes | `NULL` |  |

---

## Bug / Defect Management

### `comments_monitor`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Per-user read/unread tracking on bug comments.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `monitor_id` | int(11) | no |  |  |
| `bug_id` | int(11) | no |  |  |
| `comments_id` | int(11) | no |  |  |
| `written_by` | int(11) | no |  |  |
| `written_to` | int(11) | no |  |  |
| `user_read` | tinyint(4) | no |  |  |
| `created_date` | timestamp | no | `current_timestamp()` |  |

### `cust_bug_answers`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Answers to the above, per bug.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `cbfa_id` | int(255) | no |  |  |
| `cbfa_fid` | int(255) | no |  |  |
| `cbfa_build_id` | int(100) | yes | `NULL` |  |
| `cbfa_bug_id` | int(100) | yes | `NULL` |  |
| `cbfa_answer` | text | no |  |  |
| `cbfa_add_by` | int(100) | no |  |  |
| `cbfa_add_date` | timestamp | no | `current_timestamp()` |  |
| `cbfa_upd_date` | timestamp | no | `current_timestamp()` |  |

### `cust_bug_fields`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Per-build custom bug fields (text/dropdown/checkbox/number/boolean, 6 options).

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `cbf_id` | int(100) | no |  |  |
| `cbf_build_id` | int(50) | yes | `NULL` |  |
| `cbf_name` | varchar(255) | yes | `NULL` |  |
| `cbf_type` | enum('text','dropdown','checkbox','number','boolean') | no | `'text'` |  |
| `cbf_opt_A` | varchar(100) | yes | `NULL` |  |
| `cbf_opt_B` | varchar(100) | yes | `NULL` |  |
| `cbf_opt_C` | varchar(100) | yes | `NULL` |  |
| `cbf_opt_D` | varchar(100) | yes | `NULL` |  |
| `cbf_opt_E` | varchar(100) | yes | `NULL` |  |
| `cbf_opt_F` | varchar(100) | yes | `NULL` |  |
| `cbf_add_date` | timestamp | no | `current_timestamp()` |  |
| `cbf_upd_date` | timestamp | no | `current_timestamp()` |  |

### `bugs_report`  —  **PARTIAL**

- **New equivalent:** Bug
- **Assessment:** Missing: bug_pre_condition, sometimeFreq/sometimeTotal, defect_sub_type, bug_video_url, bug_export_jira, bug_ln_defect_type, bug_assign_test_id link.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `bug_id` | int(11) | no |  |  |
| `bug_project_id` | int(11) | no |  | Refers Project Table |
| `bug_build_id` | int(11) | no |  | Refers Build Table |
| `bug_defect_id` | varchar(50) | yes | `NULL COMMENT 'Unique Id for Crash or Defect'` | Unique Id for Crash or Defect |
| `bug_type` | varchar(20) | yes | `NULL` |  |
| `bug_typeofdefect` | varchar(55) | yes |  |  Type Of Defect = UI, Usability, Functionality |
| `defect_sub_type` | varchar(30) | yes | `NULL` |  |
| `bug_reproducibility` | varchar(50) | yes |  | Defect Reproduce always,sometimes |
| `sometimeFreq` | varchar(5) | yes | `NULL` |  |
| `sometimeTotal` | varchar(5) | yes | `NULL` |  |
| `bug_severity` | varchar(50) | yes |  | Defect Severity critical, major ,minor |
| `bug_device_used` | varchar(255) | no |  | Devices used |
| `bug_browsers_used` | varchar(255) | yes | `NULL COMMENT 'Browsers used'` | Browsers used |
| `bug_feature` | varchar(200) | yes | `NULL` |  |
| `bug_desc` | text | yes | `NULL COMMENT 'Crash or Defect Desc'` | Crash or Defect Desc |
| `bug_pre_condition` | varchar(255) | yes | `NULL COMMENT 'Defect Pre Condition'` | Defect Pre Condition |
| `bug_steps` | text | yes | `NULL COMMENT 'Defect Steps'` | Defect Steps |
| `bug_exp_result` | text | yes | `NULL COMMENT 'Defect Expected Results'` | Defect Expected Results |
| `bug_actual_result` | text | yes | `NULL COMMENT 'Defect Actual Results'` | Defect Actual Results |
| `bug_video_url` | longtext | yes | `NULL` |  |
| `bug_screen1` | varchar(255) | yes | `NULL` |  |
| `bug_screen2` | varchar(255) | yes | `NULL` |  |
| `bug_attachment` | varchar(255) | yes | `NULL` |  |
| `bug_created_by` | int(11) | yes | `NULL COMMENT 'Defect or Crash Created By'` | Defect or Crash Created By |
| `bug_updated_by` | int(11) | yes | `NULL COMMENT 'Defect or Crash Updated By'` | Defect or Crash Updated By |
| `bug_created_date` | timestamp | yes | `current_timestamp() COMMENT 'Defect or Crash Created Time'` | Defect or Crash Created Time |
| `bug_updated_date` | timestamp | yes | `NULL COMMENT 'Defect or Crash Updated Time'` | Defect or Crash Updated Time |
| `bug_status` | int(11) | no |  | 0=>Normal,1=>duplicate,2=>invalid |
| `bug_export_jira` | int(2) | no | `0` |  |
| `bug_assign_test_id` | int(11) | yes | `NULL` |  |
| `bug_title` | text | yes | `NULL COMMENT 'Crash Title'` | Crash Title |
| `bug_type_id` | int(11) | yes | `NULL COMMENT 'Refers bug_types'` | Refers bug_types |
| `bug_ln_defect_type` | varchar(100) | yes | `NULL` |  |

### `attachments`  —  **MAPPED**

- **New equivalent:** BugAttachment + FileObject
- **Assessment:** Normalised into a generic file store.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `attach_id` | int(11) | no |  |  |
| `attach_title` | varchar(100) | no |  |  |
| `attach_type` | varchar(100) | yes | `NULL` |  |
| `attach_filename` | varchar(100) | yes | `NULL` |  |
| `attach_loc_server` | varchar(100) | yes | `NULL` |  |
| `attach_bugs_report_id` | int(11) | no |  | Bugs Report Id |
| `attach_created_by` | int(11) | no |  | User Id who uploaded the document |
| `attach_created_date` | timestamp | no | `current_timestamp()` |  |

### `bug_types`  —  **MAPPED**

- **New equivalent:** BugType enum
- **Assessment:** Legacy per-tenant table -> fixed enum. Loses tenant-defined bug types.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `bt_id` | int(11) | no |  |  |
| `bt_title` | varchar(255) | yes | `NULL` |  |
| `bt_desc` | text | yes | `NULL COMMENT 'Crash or Defect Desc'` | Crash or Defect Desc |
| `bt_created_by` | int(11) | yes | `NULL` |  |
| `bt_updated_by` | int(11) | yes | `NULL` |  |
| `bt_created_date` | timestamp | yes | `current_timestamp()` |  |
| `bt_updated_date` | timestamp | yes | `NULL` |  |

### `defect_comments`  —  **MAPPED**

- **New equivalent:** BugComment
- **Assessment:** Legacy had 2 attachment slots; new uses isInternal + separate attachments.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `comments_id` | int(11) | no |  |  |
| `comments_build_id` | int(11) | no |  |  |
| `comments_bug_id` | int(11) | no |  |  |
| `comments_comment` | text | no |  |  |
| `comments_attach1` | varchar(255) | no |  |  |
| `comments_attach2` | varchar(255) | no |  |  |
| `comments_done_by` | int(11) | no |  |  |
| `comments_date` | timestamp | no | `current_timestamp()` |  |

---

## Contests

### `contest_answers`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Participant answers incl. video URL.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `answer_id` | int(11) | no |  |  |
| `contest_id` | int(11) | no |  |  |
| `participant_id` | int(11) | no |  |  |
| `question_id` | int(11) | no |  |  |
| `answer` | text | no |  |  |
| `answer_submition_time` | timestamp | no | `current_timestamp()` |  |
| `video_url` | varchar(255) | yes | `NULL` |  |

### `contest_feedback`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Contest feedback with device/browser/attachment/video.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `feedback_id` | int(11) | no |  |  |
| `participant_id` | int(11) | no |  |  |
| `contest_id` | int(11) | no |  |  |
| `feedback_title` | text | yes | `NULL` |  |
| `feedback` | longtext | yes | `NULL` |  |
| `feedback_devices` | varchar(20) | yes | `NULL` |  |
| `feedback_browsers` | varchar(20) | yes | `NULL` |  |
| `feedback_time` | timestamp | no | `current_timestamp()` |  |
| `feedback_attachment` | varchar(255) | yes | `NULL` |  |
| `feedback_video_url` | longtext | yes | `NULL` |  |

### `contest_participant`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Contest participation + invite/join/submit timestamps.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `participant_id` | int(11) | no |  |  |
| `participant_user_id` | int(11) | no |  |  |
| `contest_id` | int(11) | no |  |  |
| `invitation_time` | timestamp | no | `current_timestamp()` |  |
| `joining_time` | timestamp | yes | `NULL` |  |
| `submission_time` | timestamp | yes | `NULL` |  |

### `contest_question`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Pre/post/task survey questions with 6 answer types.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `question_id` | int(11) | no |  |  |
| `contest_id` | int(11) | no |  |  |
| `survey_type` | enum('pre','post','task') | yes | `NULL` |  |
| `question` | longtext | no |  |  |
| `answer_type` | enum('descriptive','scale','multichoice','checkbox','number','verbal') | yes | `NULL` |  |
| `choice_A` | varchar(100) | yes | `NULL` |  |
| `choice_B` | varchar(100) | yes | `NULL` |  |
| `choice_C` | varchar(100) | yes | `NULL` |  |
| `choice_D` | varchar(100) | yes | `NULL` |  |
| `choice_E` | varchar(100) | yes | `NULL` |  |
| `choice_F` | varchar(100) | no |  |  |
| `question_created_time` | timestamp | yes | `NULL` |  |
| `question_updated_time` | timestamp | no | `current_timestamp()` |  |
| `appear_date` | date | yes | `NULL` |  |
| `task_id` | int(50) | yes | `NULL` |  |

### `contest_tasks`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Dated contest tasks.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `task_id` | int(50) | no |  |  |
| `contest_id` | int(50) | no |  |  |
| `task_name` | varchar(255) | yes | `NULL` |  |
| `task_apear_date` | date | yes | `NULL` |  |
| `task_created_time` | timestamp | yes | `current_timestamp()` |  |
| `task_updated_time` | timestamp | yes | `NULL` |  |
| `task_created_by` | int(20) | yes | `NULL` |  |
| `task_updated_by` | int(20) | yes | `NULL` |  |

### `contests`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Entire contests module.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `contest_id` | int(11) | no |  |  |
| `org_id` | int(11) | no |  |  |
| `contest_title` | varchar(100) | yes | `NULL` |  |
| `contest_desc` | text | yes | `NULL` |  |
| `contest_objective` | text | yes | `NULL` |  |
| `contest_guidelines` | text | yes | `NULL` |  |
| `contest_data` | text | yes | `NULL` |  |
| `contest_start_time` | date | no |  |  |
| `contest_end_time` | date | no |  |  |
| `max_participants` | int(10) | yes | `NULL` |  |
| `contest_logo` | varchar(100) | yes | `NULL` |  |
| `contest_prizes` | int(3) | yes | `NULL` |  |
| `first_prize` | int(11) | yes | `NULL` |  |
| `second_prize` | int(11) | yes | `NULL` |  |
| `third_prize` | int(11) | yes | `NULL` |  |
| `fourth_prize` | int(11) | yes | `NULL` |  |
| `fifth_prize` | int(11) | yes | `NULL` |  |
| `contest_app_link` | varchar(200) | yes | `NULL` |  |
| `contest_attachment` | varchar(150) | yes | `NULL` |  |
| `contest_min_age` | int(50) | yes | `NULL` |  |
| `contest_max_age` | int(50) | yes | `NULL` |  |
| `contest_gender` | enum('Male','Female','Others') | yes | `NULL` |  |
| `contest_countries` | varchar(255) | yes | `NULL` |  |
| `employment` | varchar(255) | yes | `NULL` |  |
| `industry` | varchar(255) | yes | `NULL` |  |
| `parental_status` | varchar(255) | yes | `NULL` |  |
| `contest_type` | enum('Web','Mobile') | yes | `NULL` |  |
| `contest_os_type` | varchar(100) | yes | `NULL` |  |
| `contest_created_by` | int(11) | no |  |  |
| `invited_participants` | longtext | yes | `NULL` |  |
| `joined_participants` | longtext | yes | `NULL` |  |
| `contest_created_date` | timestamp | yes | `NULL` |  |
| `contest_updated_date` | timestamp | no | `current_timestamp()` |  |
| `contest_customize_feedback` | enum('yes','no') | no | `'no'` |  |

### `cust_feedback_answers`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Answers to the above.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `cffa_id` | int(30) | no |  |  |
| `cffa_fid` | int(30) | no |  |  |
| `contest_id` | int(30) | no |  |  |
| `feedback_id` | int(30) | no |  |  |
| `cffa_answer` | varchar(255) | yes | `NULL` |  |
| `cffa_added_by` | int(30) | no |  |  |
| `cffa_added_date` | timestamp | no | `current_timestamp()` |  |
| `cffa_updated_date` | timestamp | yes | `NULL` |  |

### `cust_feedback_fields`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Per-contest custom feedback fields.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `cff_id` | int(30) | no |  |  |
| `contest_id` | int(20) | yes | `NULL` |  |
| `cff_name` | varchar(50) | yes | `NULL` |  |
| `cff_type` | enum('text','dropdown') | no | `'text'` |  |
| `cff_opt_A` | varchar(20) | yes | `NULL` |  |
| `cff_opt_B` | varchar(20) | yes | `NULL` |  |
| `cff_opt_C` | varchar(20) | yes | `NULL` |  |
| `cff_opt_D` | varchar(20) | yes | `NULL` |  |
| `cff_opt_E` | varchar(20) | yes | `NULL` |  |
| `cff_opt_F` | varchar(20) | yes | `NULL` |  |
| `cff_added_date` | timestamp | no | `current_timestamp()` |  |
| `cff_updated_date` | timestamp | yes | `NULL` |  |

---

## Devices / OS / Browsers

### `browser_versions`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Browser version catalog.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `version_id` | int(11) | no |  |  |
| `browser_id` | int(11) | no |  |  |
| `version` | varchar(30) | no |  |  |
| `created_by` | int(11) | no |  |  |
| `created_date` | timestamp | no | `current_timestamp()` |  |

### `browsers`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Browser catalog with logo.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `brw_id` | int(11) | no |  |  |
| `brw_name` | varchar(50) | yes | `NULL` |  |
| `brw_desc` | varchar(50) | yes | `NULL` |  |
| `brw_image` | varchar(100) | no |  |  |

### `mobile_brands`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Device brand catalog.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `mbr_id` | int(11) | no |  |  |
| `mbr_name` | varchar(255) | no |  |  |

### `mobile_os_type`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Mobile OS catalog (Android/iOS).

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `ost_id` | int(11) | no |  |  |
| `ost_name` | varchar(255) | no |  |  |

### `mobile_os_version`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Mobile OS version catalog.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `mov_id` | int(11) | no |  |  |
| `mov_type_id` | int(11) | no |  |  |
| `mov_name` | varchar(255) | no |  |  |

### `network_providers`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Network/carrier catalog with country + logo.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `network_id` | int(20) | no |  |  |
| `network_name` | varchar(100) | yes | `NULL` |  |
| `network_country` | varchar(100) | yes | `NULL` |  |
| `network_desc` | varchar(200) | yes | `NULL` |  |
| `network_image` | varchar(100) | yes | `NULL` |  |

### `os`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Desktop/web OS catalog.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `os_id` | int(11) | no |  |  |
| `os_name` | varchar(50) | yes | `NULL` |  |
| `os_desc` | varchar(50) | yes | `NULL` |  |

### `os_versions`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** OS version catalog.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `os_id` | int(11) | no |  |  |
| `os_type_id` | int(11) | no |  |  |
| `os_name` | varchar(50) | yes | `NULL` |  |
| `os_desc` | varchar(50) | yes | `NULL` |  |
| `os_image` | varchar(100) | no |  |  |

### `devices`  —  **PARTIAL**

- **New equivalent:** TesterDevice
- **Assessment:** FREE TEXT, not a catalog. Missing structured brand/os/os-version/network FKs; ram/screen present as free text; no soft delete.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `dvc_id` | int(11) | no |  |  |
| `dvc_manufacturer` | int(11) | yes | `NULL` |  |
| `dvc_name` | varchar(50) | yes | `NULL` |  |
| `dvc_desc` | varchar(50) | yes | `NULL` |  |
| `dvc_manufacturer_name` | varchar(100) | no | `'0'` |  |
| `dvc_mob_os_ver_id` | int(11) | yes | `NULL` |  |
| `dvc_os_details` | varchar(500) | no | `'0'` |  |
| `dvc_ram` | int(10) | yes | `NULL` |  |
| `dvc_screen` | double | yes | `NULL` |  |
| `dvc_primary_network` | int(50) | yes | `NULL` |  |
| `dvc_secondary_network` | int(50) | yes | `NULL` |  |
| `dvc_add_date` | timestamp | no | `current_timestamp()` |  |
| `dvc_add_by` | int(11) | no | `0` |  |
| `dvc_updated_date` | timestamp | no | `current_timestamp()` |  |
| `dvc_deleted_date` | timestamp | yes | `NULL` |  |

### `user_browsers`  —  **PARTIAL**

- **New equivalent:** TesterDevice.browser
- **Assessment:** Free-text string on the device row. Loses browser/version/OS relationships and per-tester browser rows.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `user_browsers_id` | int(11) | no |  |  |
| `os_id` | int(11) | no |  |  |
| `browser_id` | int(11) | no |  |  |
| `browser_version_id` | int(11) | no |  |  |
| `user_id` | int(11) | no |  |  |
| `created_by` | int(11) | no |  |  |
| `created_date` | timestamp | no | `current_timestamp()` |  |
| `deleted_date` | timestamp | yes | `NULL` |  |
| `browser_version` | varchar(255) | yes | `NULL` |  |

---

## Payments / Plans

### `active_plans`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Org subscription plan + remaining project/tester quotas.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `act_pid` | int(20) | no |  |  |
| `org_id` | int(20) | yes | `NULL` |  |
| `plan_name` | enum('private','diy','managed') | yes | `NULL` |  |
| `start_date` | date | yes | `NULL` |  |
| `end_date` | date | yes | `NULL` |  |
| `remaining_projects` | int(20) | yes | `NULL` |  |
| `remaining_private_testers` | int(20) | yes | `NULL` |  |

### `payment_acc_details`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Tester payout accounts (bank/PayPal/Paytm, IFSC, Indian/non-Indian).

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `pmt_id` | int(11) | no |  |  |
| `pmt_user_id` | int(11) | no |  |  |
| `pmt_country` | enum('Indian','Non-indian') | no |  |  |
| `pmt_payment_type` | enum('ind_bank_acc','non-ind_bank_acc','paypal','paytm') | yes | `NULL` |  |
| `pmt_account_name` | varchar(255) | yes | `NULL` |  |
| `pmt_account_no` | varchar(25) | yes | `NULL` |  |
| `pmt_bank_name` | varchar(255) | yes | `NULL` |  |
| `pmt_branch_name` | varchar(255) | yes | `NULL` |  |
| `pmt_ifsc_code` | varchar(25) | yes | `NULL` |  |
| `pmt_paypal_email` | varchar(255) | yes | `NULL` |  |
| `pmt_paytm_number` | varchar(10) | yes | `NULL` |  |
| `pmt_status` | enum('Active','Inactive') | no | `'Active'` |  |
| `pmt_timestamp` | bigint(11) | no |  |  |
| `pmt_acc_updated` | timestamp | no | `current_timestamp()` |  |

### `pricing_models`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Pricing model lookup (tester_credit/hourly_rate/bug_bounty).

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `pm_id` | int(11) | no |  |  |
| `pm_name` | varchar(50) | yes | `'0'` |  |
| `pm_desc` | varchar(500) | yes | `'0'` |  |

### `tds_history`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Per-financial-year TDS deductions.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `tds_id` | int(255) | no |  |  |
| `tds_user_id` | int(255) | yes | `NULL` |  |
| `tds_fy` | varchar(255) | yes | `NULL` |  |
| `tds_amount` | double | yes | `NULL` |  |
| `tds_added_date` | timestamp | no | `current_timestamp()` |  |
| `tds_updated_date` | timestamp | yes | `NULL` |  |

### `payment_history`  —  **PARTIAL**

- **New equivalent:** Transaction
- **Assessment:** Missing: credit/debit/release semantics, pmt_method + details, contest linkage, seen/new status.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `pmt_id` | int(11) | no |  |  |
| `pmt_user_id` | int(11) | no |  |  |
| `pmt_for_build_id` | varchar(100) | yes | `NULL` |  |
| `pmt_for_contest_id` | varchar(50) | yes | `NULL` |  |
| `pmt_type` | enum('credit','debit','release') | no |  |  |
| `pmt_method` | enum('ind_bank_acc','non-ind_bank_acc','paypal','paytm') | yes | `NULL` |  |
| `pmt_method_details` | varchar(50) | yes | `NULL` |  |
| `pmt_amount` | bigint(11) | no |  |  |
| `pmt_in` | varchar(5) | yes | `NULL` |  |
| `pmt_summary` | varchar(255) | no |  |  |
| `pmt_status` | enum('new','seen') | no | `'new'` |  |
| `pmt_time` | bigint(11) | no |  |  |

---

## Automation

### `automation_modules`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Automation module/script definitions per build.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `tc_id` | int(100) | no |  |  |
| `tc_module_id` | varchar(100) | no |  |  |
| `tc_module_name` | varchar(500) | yes | `NULL` |  |
| `tc_steps` | text | no |  |  |
| `tc_expected_result` | text | no |  |  |
| `tc_build_id` | varchar(50) | no |  |  |
| `tc_project_id` | varchar(50) | no |  |  |

### `automation_reports`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Automation run reports.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `ID` | int(11) | no |  |  |
| `report` | varchar(255) | no |  |  |
| `selectedModules` | varchar(5000) | yes | `NULL` |  |
| `selectedScripts` | varchar(10000) | yes | `NULL` |  |
| `build` | varchar(20) | no |  |  |
| `project` | varchar(20) | no |  |  |

---

## Messaging / Notifications

### `notification`  —  **PARTIAL**

- **New equivalent:** Notification
- **Assessment:** Legacy was per-org notification preferences (allN/buildStatus/criticalDef); new is a notification feed. Preference concept MISSING.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `Sno` | int(11) | no |  |  |
| `org` | varchar(255) | no |  |  |
| `allN` | varchar(255) | yes | `NULL` |  |
| `buildStatus` | varchar(255) | yes | `NULL` |  |
| `criticalDef` | varchar(255) | yes | `NULL` |  |

### `message`  —  **MAPPED**

- **New equivalent:** Message
- **Assessment:** Now thread-based rather than standalone message+recipient.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `id` | int(200) | no |  |  |
| `creator_id` | int(50) | no |  |  |
| `message_body` | longtext | yes | `NULL` |  |
| `create_date` | timestamp | no | `current_timestamp()` |  |
| `deleted_at` | timestamp | no | `current_timestamp()` |  |

### `message_recipient`  —  **MAPPED**

- **New equivalent:** ThreadParticipant
- **Assessment:** is_read -> lastReadAt.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `id` | int(200) | no |  |  |
| `recipient_id` | int(50) | no |  |  |
| `message_id` | int(200) | no |  |  |
| `is_read` | enum('0','1') | no | `'0'` |  |

---

## Skills

### `skill_categories`  —  **MAPPED**

- **New equivalent:** SkillCategory enum
- **Assessment:** Legacy dynamic table -> fixed 4-value enum.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `scat_id` | int(11) | no |  |  |
| `scat_name` | varchar(255) | no |  |  |
| `scat_identifier` | varchar(255) | no |  |  |

### `skills`  —  **MAPPED**

- **New equivalent:** Skill
- **Assessment:** sname_cat_id -> SkillCategory enum.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `sname_id` | int(11) | no |  |  |
| `sname_cat_id` | int(11) | no |  |  |
| `sname_name` | varchar(255) | no |  |  |
| `sname_identifier` | varchar(255) | no |  |  |

---

## System / Misc

### `site_settings`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Global key/value settings.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `id` | int(11) | no |  |  |
| `key_name` | varchar(50) | no |  |  |
| `key_value` | varchar(50) | no |  |  |
| `created_by` | int(11) | no |  |  |
| `created_date` | timestamp | no | `current_timestamp()` |  |

### `site_statistics`  —  **MISSING**

- **New equivalent:** _none_
- **Assessment:** Daily aggregate stats (logins, new tests, tested).

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `stat_id` | int(11) | no |  |  |
| `stat_date` | varchar(20) | no |  |  |
| `stat_logins` | int(11) | no | `0` |  |
| `stat_new_test` | int(11) | no | `0` |  |
| `stat_tested_tests` | int(11) | no | `0` |  |

### `base_country`  —  **PARTIAL**

- **New equivalent:** countryCode strings
- **Assessment:** No country lookup table; ISO codes stored as free strings.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `id` | int(11) | no |  |  |
| `iso2` | char(2) | yes | `NULL` |  |
| `iso3` | char(3) | yes | `NULL` |  |
| `name_en` | varchar(64) | yes | `NULL` |  |
| `name_fr` | varchar(64) | yes | `NULL` |  |
| `name_de` | varchar(64) | yes | `NULL` |  |

### `ci_sessions`  —  **MAPPED**

- **New equivalent:** Session
- **Assessment:** Framework session table -> real session model with refresh rotation.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `id` | varchar(128) | no |  |  |
| `ip_address` | varchar(45) | no |  |  |
| `timestamp` | int(10) | no | `0` |  |
| `data` | blob | no |  |  |

### `documents`  —  **MAPPED**

- **New equivalent:** ProjectMaterial + FileObject
- **Assessment:** doc_build_id collapses to project.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `doc_id` | int(11) | no |  |  |
| `doc_title` | varchar(100) | no |  |  |
| `doc_type` | varchar(100) | yes | `NULL` |  |
| `doc_filename` | varchar(100) | yes | `NULL` |  |
| `doc_loc_server` | varchar(100) | yes | `NULL` |  |
| `doc_project_id` | int(11) | no |  | Project Id |
| `doc_build_id` | int(11) | no |  |  |
| `doc_created_by` | int(11) | no |  | User Id who uploaded the document |
| `doc_created_date` | timestamp | no | `current_timestamp()` |  |

### `marketing`  —  **MAPPED**

- **New equivalent:** Lead
- **Assessment:** Marketing capture -> Lead pipeline.

| Legacy column | Type | Null | Default | Legacy comment |
| --- | --- | --- | --- | --- |
| `Sno` | int(11) | no |  |  |
| `FirstName` | varchar(255) | no |  |  |
| `LastName` | varchar(255) | yes | `NULL` |  |
| `Email` | varchar(255) | yes | `NULL` |  |
| `Location` | varchar(500) | yes | `NULL` |  |
| `Phone` | varchar(255) | yes | `NULL` |  |
| `organization` | varchar(255) | yes | `NULL` |  |
| `date` | varchar(255) | yes | `NULL` |  |

---
