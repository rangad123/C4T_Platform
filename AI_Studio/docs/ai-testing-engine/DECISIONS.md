# Decision record

Decisions on the testing-engine programme and the parallel workstreams, 2026-11-14. Each entry: the decision, and what it changes or
constrains. "Separate approval" marks items that still need an explicit approval before they are implemented or released.

## A. Benchmark and Phase 1

| # | Decision | Consequence |
|---|---|---|
| A1 | Maximum capability on the free model, exact configuration recorded | Level `everything`, data-changing tests on the benchmark apps only, every check family, one model (`nvidia/nemotron-3-ultra-550b-a55b:free`, OpenRouter); recorded in the run's config |
| A2 | The first baseline day's analysis timeout stays as a baseline observation; no rerun | Noted in the baseline record |
| A3 | Accept the notes-app cross-day validation caveat | First-day tests of bench-rbac are validated by an ordinary run after the continued creation; written in the result's caveats |
| A4 | Separate JavaScript-login run after the original baseline | `--login js`, own output folder, never merged into the HTML-login baseline |
| A5 | Regression mode after the JavaScript-login run | `--mode regression`, own output folder |
| A6 | Repeat benchmark deferred until the first results are reviewed | — |
| A7 | `continueStopped` stays hidden and opt-in | Not shown in any screen; only the benchmark controller sends it |
| A8 | Commit Phase 0/1 documents and code after the baseline is recorded; no push without approval | Separate approval for the push |
| A9 | Phase 1 review and explicit approval before Phase 2 | — |
| A10 | The baseline resumes from a frozen code/configuration snapshot; the JavaScript-login option must not change it | A separate frozen checkout (commit 7a164a8 + the Phase 1 changes as they stood when frozen, snapshot hash recorded); each resume checks the hash first |

## B. Merging the parallel work

| # | Decision | Consequence |
|---|---|---|
| B1 | Proposed merge order approved, with independent review, regression tests and migration checks for every merge; no push without approval | Each merge: review agent, full CI-equivalent run, migration/baseline.sql check |
| B2 | Losing the failure-video step-title captions is accepted only if step names stay available elsewhere (report metadata or another accessible view); action highlights stay | Verify before merging the strict-CSP fix that the run view and stored step results show every step name |

## C. Security

| # | Decision | Consequence |
|---|---|---|
| C1 | The exact consent wording is shown before final approval | Separate approval; no wording ships without it |
| C2 | Active checks only on development and staging, with written client authorization naming the permitted level, approved by a Crowd4Test admin | Backend-enforced gate; project editors cannot approve |
| C3 | S7 (mutating authorization checks) only after the authorization policy is implemented; isolated test accounts, disposable records, cleanup | Waits for C1/C2 |
| C4 | Hosted cross-account checks after the merge and the runner protocol change | — |
| C5 | Advanced scanner profile stays disabled until the adapter fixes are verified | — |
| C6 | No production active or data-changing checks by default; backend enforcement mandatory | — |

## D. Evidence and observability

| # | Decision | Consequence |
|---|---|---|
| D1 | Automatic deletion on: failed-run traces and videos 7 days by default, passing-run metadata 30 days; no full passing-run traces or videos kept by default; project-level configuration allowed | Changes the retention defaults (today off) and its "failed kept three times as long" rule |
| D2 | No automatic embedding of unmasked screenshots in reports until visual redaction exists | Project report stops embedding screenshots |
| D3 | A ~5 KB passing-run metadata record is approved; no bodies, credentials, cookies or screenshots in it | Enables observed coverage for test selection |
| D4 | Response-header capture from a fixed allow-list; response headers only, never injected request headers | — |

## E. Test selection

| # | Decision | Consequence |
|---|---|---|
| E1 | Opt-in automatic selection on deploy triggers; full execution stays the default; unknown coverage never silently excludes a test | Builds on the selection preview |

## F. AI keys

| # | Decision | Consequence |
|---|---|---|
| F1 | The server's AI key stays for operator-only shared access, with usage tracking and spending limits | Existing token limits are by tokens, not money: a spending limit for operator use is needed |
| F2 | The Sonnet organisational key stays admin-only for now; named technical-operator access with quotas and audit logs later | No assignment change |
| F3 | Production OpenRouter credit is handled separately | No action here |

## G. Security housekeeping (actions outside this repository)

| # | Decision |
|---|---|
| G1 | Rotate the exposed gateway token and the exposed third-party JWT immediately |
| G2 | Rotate the exposed S3 key, take the exposed runner-update signing key offline, arrange code-signing certificates; treat every exposed credential as compromised |

## H. Phase 0 open questions

| # | Decision |
|---|---|
| H1 | API-level invariant checks first; read-only database connections later |
| H2 | One common findings model for functional and security findings |
| H3 | fast-check inside the engine only (generated scripts stay dependency-free) |
| H4 | The stronger model writes assertions grounded in sourced requirements or verified rules |
| H5 | A confirmed bug needs reproduction in at least 2 of 3 clean replays AND a sourced expectation or a deterministic oracle |
| H6 | Select 2–3 staging applications before Phase 3 |
| H7 | Revisit PostgreSQL at Phase 5 |
| H8 | Deploy triggers and GitHub are the change sources for test selection |
| H9 | Bounded exploratory sessions; separate capacity reserved for benchmark jobs |

## Conflicts with existing plans or work (reported 2026-11-14)

1. **Retention (D1)** differs from the roadmap's suggested 90/30 days and from the current retention design (one "passed runs" period, failed runs kept three
   times as long, off by default). D1 needs a new default and a separate period for failed-run traces/videos. Plan updated; the final rules are R1-R8 below
   (later decisions), built in the integration tree, not yet merged.
2. **Screenshots in reports (D2)** reverses the roadmap's "keep with a warning". The project report embeds screenshots today; a change is needed.
3. **Consent and approval (C1, C2)**: the security start-path work in progress proposed approval by "platform admins or project security
   editors" and drafted authorization text. C2 narrows approval to Crowd4Test admins; C1 requires the exact wording to be shown first. The work
   stays uncommitted until the wording is approved.
4. **Step names (B2)**: the strict-CSP fix removes step titles from failure videos; merge only after confirming step names in the run view.
5. **Operator spending limit (F1)**: limits today are token counts (`AI_MONTHLY_TOKEN_LIMIT`, `AI_JOB_TOKEN_LIMIT`), not money; a money limit for
   the operator key is new work.
6. **fast-check (H3)** adds a dependency; builders do not install packages without approval — this decision is that approval, for the engine only.
7. **Recorded configuration (A1/A10)**: the resumed baseline's recorded options gain `login: "html"` (the first attempt predates the option);
   behaviour is identical (HTML login is the apps' default), noted in the baseline record.
8. **Exposed credentials (G1, G2)** are actions on external systems, outside this repository; nothing in this repository does them.

## Later decisions (2026-11-14)

Later decisions on the same programme. They refine or replace earlier entries where stated. Nothing here is merged, committed or
released yet: the work sits in one integration tree, reviewed before any merge (B1).

### R. Retention: final rules (refine D1)

| # | Decision | Consequence |
|---|---|---|
| R1 | Retention is on by default; no "keep the latest N runs" exception, and no other keep-rule (newest failing run, pending visual change, issue-linked failed run, release-snapshot runs) | Expiry is decided only by a run's outcome and age, over every kind of stored evidence |
| R2 | Failed runs: evidence records, traces and videos expire after 7 days | Every file of a failed run goes at 7 days |
| R3 | Passing runs: no full traces or videos kept (they go when the next run passes); the compact passing-run record (D3, the footprint) and other files expire after 30 days | — |
| R4 | Minimal run-history rows stay for trends and audit (id, test, outcome, timing, who and when), but must not preserve expired evidence or coverage | At expiry, error text with page content, step errors, URLs, requests, footprint and coverage fields are cleared in the same pass that deletes the files; screens say the evidence expired |
| R5 | Confirmed findings, finding history, approved visual baselines, plans, application models and reports are never deleted by retention | Run-less files that are not evidence stay; evidence without a run link (agent-run screenshots) expires as failed-run media, 7 days |
| R6 | A restore never bypasses retention: a project restored without a saved policy, or with retention saved as off, comes back with retention on | Backup header and restore code follow it |
| R7 | Server-wide upper limits stay (longest allowed metadata and failed-media periods); longer project settings are refused | — |
| R8 | Accepting a visual change whose screenshots have expired is refused with a plain sentence (HTTP 409: run the test again), never a server error | — |

Other stored records that hold application text (job event logs, agent action logs, job error fields, validation reasons) were reviewed
read-only; sanitizing and expiry rules for them are proposals awaiting a decision. Audit records and confirmed findings are sanitized,
never deleted.

### U. Usage page test

| # | Decision | Consequence |
|---|---|---|
| U1 | The test-only correction of the usage-page test is approved | The scripted model answers the review and coverage-gap calls as the usage test does; expected values computed from the fixture's constants; no production code change and no weakened check |

### S. Test selection (refine E1)

| # | Decision | Consequence |
|---|---|---|
| S1 | Opt-in automatic selection on deploy triggers (E1) is **not approved** for building yet | Deploy triggers keep running every test; full execution stays the default; only the read-only selection preview is built |
| S2 | Preconditions before opt-in selection can be considered: nothing silently dropped from coverage (other-host API calls recorded with their host, third-party calls recorded as external; in-app and hash routes; form submissions as method and path; WebSocket, EventSource and beacon traffic typed; unclassified traffic makes coverage incomplete) | Built in the preview; reviewed before any opt-in |
| S3 | No silent truncation: a change list too long to process marks the preview incomplete and requires a full run | — |
| S4 | Matching rules written down and implemented: host-aware API matching, dynamic route patterns (`{slug}`, `:id`, `*`), scheme and host case-insensitive, path case-sensitive, unreserved percent-decoding, trailing slash normalised, query ignored unless the change names it, hash routes compared as paths | — |
| S5 | A test counts as covered only when its latest relevant run (same variant and environment as the change's target) passed with a complete, untruncated footprint, after the test's current version, within a freshness window (proposed 14 days, configurable) | A failed or cancelled latest run, or a newer version without a run, makes it stale |
| S6 | Runner capability parity: the runnable set is computed for the viewer and for every active deploy-trigger token's creator; a difference, or a creator that cannot be resolved, requires a full run | — |
| S7 | Unknown, stale or incomplete coverage, or incomplete change matching, always requires a full run and says why; unreadable tests appear as "Cannot run" with a reason; tests outside the viewer's runnable set are shown with their reason, never hidden | — |

### C. Security (refine C1, C2, C5, C6)

| # | Decision | Consequence |
|---|---|---|
| C7 | Approval of an above-passive profile by a signed-in Crowd4Test admin only is approved as the direction; the fallback that let platform-settings holders approve stays removed | A server without Crowd4Test sign-in has no approver, and says so; the gate is enforced at the route, the store and the start |
| C8 | The consent and refusal **wording is not approved** (C1 still applies); drafts are kept in code as drafts | The server switch for active profiles stays off; passive is the only enabled profile |
| C9 | Requirements for the wording: client (application owner) authorization kept distinct from the Crowd4Test admin profile approval; development and staging only, enforced server-side; create, update, delete, overwrite and other intentional data-changing operations prohibited in every profile; a check that would need one is skipped and listed as skipped; no promise that read-only requests have zero side effects (a target can change state even on a read); state truthfully that unexpected changes are not detected automatically today, what is recorded, that the client is told, and that no undo or cleanup requests are made | Stale text implying an application owner approves a Crowd4Test profile is corrected |
| C10 | ZAP is a blocker for active profiles: its real traffic cannot be verified here (not installed; installing it needs a separate approval) | Verification procedure written; reported as not done |
| C11 | Before active profiles can be considered, every scanner request (not only the first) must be limited to GET, HEAD and OPTIONS and to the application's in-scope origins and paths minus exclusions, enforced by the platform (an enforcing proxy each scanner is forced through, every request logged), with no bypass route; a scan is refused when this cannot be guaranteed (proxy fails to start, scanner cannot be pointed at it, HTTPS where the method and path cannot be seen) | Profiles stay off until this is built and verified |
| C12 | Proposed expiry (implemented as proposed, not final): client authorization expires 90 days after it is recorded, the Crowd4Test admin approval 30 days after; both are invalid at once when scope, target, environment, profile or credentials change; revocation is immediate | Checked server-side at start, approval and display, with plain refusal sentences |
| C13 | The authorization records the authorizing person's name, role and e-mail and their documented authority to authorize testing for the application owner (a document or engagement reference and a statement), all required | Older records show "not recorded" and cannot authorize above passive until recorded again; passive behaviour for them is unchanged unless decided otherwise |

### A. Benchmark (refine A10)

| # | Decision | Consequence |
|---|---|---|
| A11 | The resumed notes-app creation re-authored ideas already made (the controller's resume looked for the idea id where the engine does not store it), so that result is not used as the baseline for that app; a separate, corrected snapshot is approved | The original frozen snapshot and its results (including the shop result) stay unchanged as historical records; the old resume is not continued |
| A12 | Conditions of the corrected snapshot: its only code difference from the original is the idea-id lookup fix; engine, prompts, model, generation settings, benchmark apps, catalogue and prices identical; both fingerprints recorded and checked before each run | Documented with the exact diff and a reset procedure |
| A13 | The corrected notes-only run uses its own output folder and its own fresh platform data folder, and the app starts from its seeded state; the same options as the original run | See BENCHMARK_METHODOLOGY.md, "Output folders" |
| A14 | No duplicate on resume is verified without a real model before the corrected run; the real run is scheduled only after that verification and a review | The earlier daily schedules were removed |

### T. Test infrastructure

| # | Decision | Consequence |
|---|---|---|
| T1 | The browser-test lock is enforced in code, not by instruction: a test file that launches a browser, or a web build used by tests, acquires the shared lock or is refused with a plain message; the fast tier and CI keep working | Built in a separate tree; ported after review |

## Benchmark decisions (2026-11-14, after the shop investigation)

| # | Decision |
|---|---|
| A15 | The corrected notes run uses the originally approved defaults (120-second AI time limit); its configuration is not changed |
| A16 | The original shop 0/12 is kept as a reliability finding, not a defect-detection baseline: the single planning call timed out five times, an empty plan was saved, and the job continued. Decision A2's "analysis timeout" was in fact this planning timeout |
| A17 | After the notes run completes, a shop-only rerun (O2) from the corrected snapshot with a longer AI time limit through the existing settings; every configuration difference recorded; the original shop result kept separately |
| A18 | If O2 times out again, benchmark tuning stops; splitting the planning call and failing explicitly on an empty plan are recommended as the first Phase 2 changes |
| A19 | No engine change for these issues (split planning, retry smaller, fail on empty plan, API checks signing in) before the benchmark decision is complete |
