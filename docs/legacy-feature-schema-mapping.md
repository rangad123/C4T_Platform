# Legacy feature ↔ schema mapping

Where `legacy-schema-inventory.md` answers *"is the column represented?"*, this answers the
harder question: **"is the capability those columns existed to support actually usable?"** It is
possible to preserve every column and still lose the feature.

Three sources reconciled here:

1. `api/old sql/crowd4testDB.sql` — the legacy data model (66 tables, 600 columns).
2. `checklist.md` — features visible in the legacy demo recording.
3. The current platform — its own features, architecture and decisions.

The schema is the **broader** of the three. Several capabilities below are provable from foreign
keys and column names but never appeared in the demo, so they are absent from `checklist.md`
entirely. Those are called out as **schema-derived**.

---

## Capability register

### 1. Structured testing workflow — **MISSING** (schema-derived)

**Schema:** `test_case`, `assign_testCase`, `test_report`, `test_review`, `test_scenarios`,
`test_scenario_reports`, `test_status`, `test_types`, `testing_time_sheet`, `applied_tests`

**What the schema proves.** The legacy platform did far more than "tester files a bug":

```
Build ──> test_case ──> assign_testCase ──> tester
                             │
                             ▼
                        test_report  (result: pass / fail / blocked,
                             │        devices, browsers, proof,
                             │        trep_defect_id ──> bugs_report)
                             ▼
                        test_review  (build-level summary + rvw_val rating)
```

`test_report.trep_defect_id` is the load-bearing detail: a bug was the *outcome of executing a
test case*, not a free-floating report. The new platform only has the free-floating half.

`applied_tests` vs `assigned_tests` proves a two-step intake — a tester **applies**, and is then
**assigned**. The new platform is invite-only, so the apply direction does not exist.

`testing_time_sheet` has `tts_approved_time` / `tts_approved_by` — logged time was **approved**,
which means it fed billing or payout.

**New platform:** no test-case entity, no execution results, no scenarios, no reviews, no
timesheets, no tester-initiated application.

**Status: MISSING.** Largest single gap in the audit. Not in `checklist.md` — recoverable only
from the schema.

---

### 2. Device / browser catalog — **PARTIAL → now IMPLEMENTED (this pass)**

**Schema:** `devices`, `mobile_brands`, `mobile_os_type`, `mobile_os_version`,
`network_providers`, `os`, `os_versions`, `browsers`, `browser_versions`, `user_browsers`

**What the schema proves.** Ten tables describing a fully structured device/browser ecosystem:
brands, OS types and their versions, browsers and their versions, carriers with country, and a
`user_browsers` join carrying `(user, os, browser, browser_version)`.

**Previous new-platform state.** `TesterDevice` stored everything as free text —
`manufacturer`, `osName`, `osVersion`, `browser`, `network` were all unconstrained strings.
Two testers on the same handset could write "Samsung Galaxy S24", "samsung galaxy s24" and
"SM-S921B", making device-based tester matching unreliable. `user_browsers` had no
representation at all beyond a single string column.

**Now:** a real catalog — see *Implemented in this pass* below.

**Status: IMPLEMENTED** (catalog + structured tester selection). Legacy free-text values are
preserved alongside the new foreign keys rather than being discarded.

---

### 3. Contests — **MISSING**

**Schema:** `contests`, `contest_participant`, `contest_question`, `contest_answers`,
`contest_tasks`, `contest_feedback`, `cust_feedback_fields`, `cust_feedback_answers`

**What the schema proves.** A complete survey/competition engine: contests with prize tiers
(1st–5th), demographic targeting (age range, gender, country, employment, industry, parental
status), dated tasks, questions across three phases (`pre` / `post` / `task`) with six answer
types (descriptive, scale, multichoice, checkbox, number, verbal), participant answers with
video URLs, and per-contest custom feedback fields.

**New platform:** nothing. No model, no route, no navigation.

**Status: MISSING.** `checklist.md` §29 lists Contests as a navigation item only — the demo did
not show the workflow, so the schema is the only evidence of its real depth.

---

### 4. Payments / plans / finance — **PARTIAL**

**Schema:** `active_plans`, `pricing_models`, `payment_acc_details`, `payment_history`,
`tds_history`, plus `organisation.org_wallet_balance` / `locked_amount` / `credit_rate` /
`org_currency`, and `builds.build_pricing_model` / `tester_reward` / `rewards_currency`

**What the schema proves.** `payment_history.pmt_type` is `credit | debit | release` — a
three-stage model where funds are credited, then *released*. That is exactly the "Credit Fund /
Release Fund" split `checklist.md` §21 asks for, and it is why the current platform cannot show
it: `TransactionStatus` has no release stage. `organisation.locked_amount` is the escrow side of
the same mechanism. `payment_acc_details` holds real payout instruments (Indian/non-Indian bank,
IFSC, PayPal, Paytm). `tds_history` is per-financial-year tax deduction.

**New platform:** `Transaction` covers the ledger; earnings and history are live on the tester
portal. Missing: release semantics, payout accounts, TDS, org wallet/escrow, plans, pricing
models.

**Status: PARTIAL.**

---

### 5. Custom bug fields — **MISSING**

**Schema:** `cust_bug_fields`, `cust_bug_answers`

Per-build user-defined fields (`text | dropdown | checkbox | number | boolean`, up to six
options) with per-bug answers. Legacy `builds.build_customize_bug` was the on/off switch.

**Status: MISSING.**

---

### 6. Multi-build projects — **PARTIAL (architectural)**

**Schema:** `projects` 1─N `builds`; `builds` carries 41 columns including `build_version_no`,
`build_release_notes`, `build_apk_file`, `build_test_type_id`, `build_cycle_type`
(`crowd | private | managed | diy`), `build_pricing_model`, `tester_reward`, `others_bug_visibility`.

The new platform merged Project and Build into one entity. One project cannot hold several
builds, "Copy Build" has no meaning, and version/release-notes/APK have nowhere to live.
`others_bug_visibility` **was** recovered (as `Project.testersCanSeeOtherBugs`).

**Status: PARTIAL — deliberate architectural choice, but a real capability loss.** Flagged rather
than reversed: re-introducing Build is a migration touching nearly every table.

---

### 7. Automation — **MISSING**

**Schema:** `automation_modules` (module + script definitions per build), `automation_reports`
(run reports referencing selected modules/scripts).

**Status: MISSING.**

---

### 8. Bug system field-level parity — **PARTIAL**

`bugs_report` has 33 columns. Represented: type, severity, status, reproducibility, steps,
expected/actual, device/browser, feature, attachments, comments. **Not** represented:
`bug_pre_condition`, `sometimeFreq`/`sometimeTotal` (the "sometimes — N of M attempts" detail),
`defect_sub_type`, `bug_video_url`, `bug_export_jira`, `bug_ln_defect_type`, and
`bug_assign_test_id` (the link back to the assignment/test execution — see capability 1).

`comments_monitor` (per-user read/unread on comments) has no equivalent.

**Status: PARTIAL.**

---

### 9. Reference/lookup data — **PARTIAL**

`base_country`, `app_types`, `test_types`, `test_status`, `pricing_models`, `network_providers`,
`os`, `browsers` were all lookup tables. The new platform stores several of these as free text
(`platformTargets`) or fixed enums (`BugType`, `SkillCategory`). Enums are defensible where the
set is genuinely closed and platform-owned; free text is not, where the legacy data was a
controlled list.

**Status: PARTIAL** — improved for devices/browsers in this pass; `base_country`, `app_types`,
`test_types`, `pricing_models` remain unstructured.

---

### 10. Org member invitations — **MISSING**

`user_invitation` (email, role, passcode, accepted flag). The new platform can create users but
has no invite/accept handshake.

**Status: MISSING.**

---

### 11. Notification preferences — **MISSING**

Legacy `notification` was a *preferences* table (`allN`, `buildStatus`, `criticalDef` per org),
not a feed. The new `Notification` model is a feed. Users cannot choose what to be notified about.

**Status: MISSING** (distinct from the notification feed, which exists).

---

### 12. Site settings / statistics — **MISSING**

`site_settings` (global key/value) and `site_statistics` (daily logins / new tests / tested
tests). The admin dashboard computes stats live instead of rolling them up daily.

**Status: MISSING** — low value; live queries are arguably better than a rollup table at this
data volume.

---

## Implemented in this pass

### Device / browser catalog (capability 2)

Ten legacy tables recovered as six normalised models, plus structured tester selection.

| Legacy | New model | Notes |
| --- | --- | --- |
| `mobile_brands` | `DeviceBrand` | Also covers desktop makers; not mobile-only. |
| `mobile_os_type` + `os` | `OperatingSystem` | One table with a `kind` discriminator (`MOBILE`/`DESKTOP`) rather than two near-identical tables. |
| `mobile_os_version` + `os_versions` | `OsVersion` | FK to `OperatingSystem`. |
| `browsers` | `Browser` | |
| `browser_versions` | `BrowserVersion` | FK to `Browser`. |
| `network_providers` | `NetworkProvider` | Retains `countryCode`. |
| `devices` (catalog half) | `DeviceModel` | Brand + default OS + RAM + screen. |
| `user_browsers` | `TesterBrowser` | `(tester, browser, version, OS)` — the join the legacy table described. |

**Improvement over legacy, not a copy:**

- `mobile_os_type`/`os` and `mobile_os_version`/`os_versions` were near-duplicate pairs
  distinguished only by mobile-vs-desktop. Collapsed into one `OperatingSystem` + `OsVersion`
  pair with a `kind` discriminator — same information, half the tables, one code path.
- Every catalog row has `isActive`, which legacy lacked (it used `dvc_deleted_date` on devices
  only). Retiring a browser version no longer means deleting rows testers reference.
- Catalog rows are **global**, not tenant-scoped — a Samsung Galaxy S24 is the same device for
  every customer. Tenant-specific data stays on `TesterDevice`/`TesterBrowser`.

**Non-destructive by design.** `TesterDevice` keeps every existing free-text column
(`manufacturer`, `model`, `osName`, `osVersion`, `browser`, `network`, `ramGb`, `screenSize`)
and *adds* nullable FKs beside them. Nothing was dropped or backfilled destructively: rows
entered before the catalog existed still render exactly as before, and a tester can still type a
device the catalog does not list. The FK is the preferred path, not the only one.

---

## Prioritised remaining gaps

| # | Gap | Priority | Why |
| --- | --- | --- | --- |
| 1 | Structured testing workflow (test cases, execution, scenarios, reviews, timesheets, applications) | **Critical** | Largest capability loss; ~9 tables; changes what the product *is*, not just what it stores. |
| 2 | Payments: release semantics, payout accounts, TDS, org wallet/escrow | **High** | Real money. `checklist.md` §21 already blocked on it. |
| 3 | Contests module | **High** | 8 tables, entirely absent. |
| 4 | Custom bug fields | **Medium** | 2 tables; per-tenant bug extensibility. |
| 5 | Multi-build projects | **Medium** | Architectural; large migration. |
| 6 | Bug field parity (pre-condition, sometimes-frequency, video URL, JIRA export, assignment link) | **Medium** | Small columns, real reporting detail. |
| 7 | Automation modules/reports | **Medium** | 2 tables. |
| 8 | Org member invitations | **Low** | Users can be created directly today. |
| 9 | Notification preferences | **Low** | Feed exists; only per-user choice is missing. |
| 10 | Reports module (`build_reports`) | **High** | Already tracked as an open gap in `legacy-feature-audit.md`. |
| 11 | `base_country` / `app_types` / `test_types` / `pricing_models` lookups | **Low** | Same catalog treatment as devices; smaller payoff. |
| 12 | Site settings / statistics | **Low** | Live queries currently sufficient. |
