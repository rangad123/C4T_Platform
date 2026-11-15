# Workstream 1 — Security testing audit

Read-only audit, 2026-11-14. Base: `main` = `7a164a8`, with uncommitted Phase 1 work in the tree (`src/eval/*`, `src/engine/intel/`,
`src/platform/app-intel-store.ts`, `src/platform/eval-store.ts`, `db.ts` slot 62, `roles.ts` intel routes, `routes/index.ts`,
`pg/baseline.sql`, `examples/bench-*`). Nothing was run: no tests, builds, servers or scanners. Every claim below comes from reading code.

Labels: **Verified** (read in current code), **Partial** (exists but incomplete), **Missing**, **Suspected** (needs reproduction),
**Proposed**. References are `file:function:line` against the working tree, relative to `AI_Studio/src/` unless they say otherwise.

---

## 1. Summary

1. **There are two separate security paths, and neither tests object-level (horizontal) authorization.**
   - The functional engine's access checks (`engine/identity/access.ts`) cover vertical, read-only checks only: pages, and GET
     endpoints whose path looks privileged.
   - The Security Assessment module (`security/`) is passive and GET-only, and runs as one identity.
2. **Verified passive-mode root cause.** `security/store.ts:createAssessment:641` writes the literal `"passive"`.
   `security/routes/assessments.ts:StartBody:111` accepts only `retestOf` (strict). Nothing writes an assessment's `approval_json`.
   So the `conservative-active` and `advanced` profiles, which are fully modelled (`scanners/profiles.ts`), cannot be reached.
3. **Even with a higher profile, the external scanners would not run in production today.**
   - `deploy/c4t-box/deploy.sh:140` sets `EXECUTION_MODE=runners`.
   - In that mode `routes/assessments.ts:loopDeps:70-86` attaches no `scanners` dependency, only the sentence
     `SCANNERS_NOT_ON_RUNNER`.
   - A scanner also needs `SECURITY_SCANNERS`, a per-project allow-list and an installed binary or daemon. None of those binaries is on
     this machine's `PATH`.
4. **Scanners never use the saved sign-in.** `ScanTarget.authHeader` is built (`assessment/runner.ts:runScanners:503-509`) but no
   ZAP, nuclei or Schemathesis adapter reads it (grep: only the promptfoo adapter reads its own AI-interface header). The advanced
   Schemathesis checks `ignored_auth` and `object_level_authorization` therefore have no identity to compare.
5. **Best first step (Proposed).** Build a read-only cross-account replay check inside the existing assessment loop. Its findings go
   through the existing `findings/ingest.ts` (category `access-control`, already in `contract.ts:CATEGORIES`). It needs one extra
   saved sign-in per application and no new findings system.
   - It can start now: `src/security` is not used by the Phase 1 benchmark (`src/eval` has no import from `security/`).
   - Engine-side changes (`engine/identity/access.ts`, `orchestrator.ts`) must wait. The benchmark runs with `accessChecks` on
     (`eval/bench/cli.ts:45`), so those changes would alter benchmark results.

---

## 2. Current security testing capabilities

### 2.1 Functional engine (runs as part of an exploration, tests stored in the test suite)

| Capability | State | Where |
|---|---|---|
| Named test accounts per project (username, password, TOTP, optional API token), encrypted at rest, at most 6 | Verified | `platform/identity-store.ts:Role:18-26`, `MAX_ROLES:37`; loaded per job `platform/job-runner.ts:269-274` |
| Page reach survey: short crawl as visitor and as each account | Verified | `engine/identity/access.ts:surveyAccess:215`, called `engine/orchestrator.ts:343-346` when `accessChecks !== false && roles.length` |
| Vertical page checks: "lesser account cannot open <page>", judged by the page heading as marker | Verified | `access.ts:generateAccessSpecs:240`; GET-only navigation |
| Horizontal page checks (same-privilege accounts) | **Missing by design** | `access.ts:258`: `if (viewer !== "anonymous" && owner.pages.length <= vReach.pages.length) continue;` means two accounts that reach the same number of pages are never compared |
| API vertical checks: privileged-looking GET endpoints called per token, then `statusDenied` checks | Verified, narrow | `access.ts:surveyApiAccess:323-347` filters `e.method === "GET" && PRIVILEGED.test(e.path)` (`PRIVILEGED:230`); `orchestrator.ts:403-409` keeps only GETs with filled paths; `generateApiAccessSpecs:349` |
| Missing authentication on documented-secured API endpoints ("rejects requests without credentials") | Verified | `engine/api/test-specs.ts:199-212`; classified as a finding by `engine/validation/validator.ts:apiFinding:517-531` (2xx with `auth:"none"`) |
| Missing authentication on pages (visitor vs signed-in) | Verified (vertical form) | the `anonymous` viewer in `generateAccessSpecs` |
| Passive header, cookie, CORS, exposed-file and TLS checks | Verified | `engine/security/specs.ts:1-9`, `engine/security/checks.ts` |
| Result handling | Verified | failing access tests become findings via `accessFinding` (`access.ts:399`, `validator.ts:508-509`) and are stored as tests in review. They are **not** `security_findings` rows |
| Modified IDs, alternative endpoints, B modifies or deletes A's record, session expiry, invalid session, stale permissions | **Missing** | no code path (grep for idor, object-level, token tampering, logout reuse in `engine/` finds nothing relevant) |

### 2.2 Security Assessment module (`src/security`)

| Capability | State | Where |
|---|---|---|
| Applications with environment (`development/staging/production/other`), scope, exclusions, rate, sensitive workflows | Verified | `security/contract.ts:SecurityApplication:17-41` |
| Written authorization tied to a scope fingerprint (target, scope, exclusions, rps, sign-in, sensitive workflows); stale on change; revocable | Verified | `security/authorization.ts:scopeFingerprint:27`, `authorizationStateOf:60`; `store.ts:currentAuthorization:619` |
| Authorization statement says "The assessment is passive" | Verified | `authorization.ts:authorizationStatement:76`. The recorded consent therefore does not cover active testing |
| Scope guard: DNS-pinned, private and metadata addresses refused, rate and byte budgets, **GET, HEAD and OPTIONS only** | Verified | `security/scope.ts:READ_METHODS:318-319`, `guardedFetch` check `:531-532`, browser route `:759-763` |
| Assessment loop with lease, heartbeat, cancel, emergency stop, time limit and restart from work data | Verified | `security/assessment/runner.ts:1-14`, `AssessmentLoop`; started in `routes/assessments.ts:146-155` |
| Signed-in assessment with **one** saved sign-in (storage state, no password typed), sign-out links refused | Verified | `contract.ts:signInAccount:37`; `security/signin.ts:resolveSignIn:145`; `assessment/guard.ts:GuardSignIn` |
| GET operations from an uploaded OpenAPI document | Verified | `assessment/api-operations.ts:requestDocumentOperations:18` |
| Hosted mode: probes run on the starter's runner; loop, judging and storage stay on the server | Verified | `assessment/on-runner.ts:1-11`, `assertAssessmentRunner:37`; runner side `agent/explore-child.ts:158-160` |
| Findings lifecycle: normalise, redact, fingerprint, upsert, sightings, history, retest marks unseen ones fixed | Verified | `findings/ingest.ts:13-26,119`; `findings/normalize.ts:fingerprintOf:139`; `store.ts` upsert `:745-800` |
| Validation states `confirmed, probable, needs-review, false-positive, fixed, accepted-risk`; accepted-risk needs `tests.approve` | Verified | `contract.ts:VALIDATION_STATES`; `auth/roles.ts:547-548` comment and route |
| Report and xlsx export | Verified | `findings/report.ts`, `findings/xlsx.ts` |
| Assessment scheduling | **Missing** | no reference to security assessments in `platform/schedule-store.ts`, `scheduler.ts` or `runbook-*.ts`. Only "notify when finished" exists (`security/notify.ts`) |
| Cross-account, session or mutating checks | **Missing** | the guard forbids non-read methods, and the assessment has a single identity |

---

## 3. Cross-user access scenarios: can the engine test them today?

| Scenario | Horizontal / vertical | Today | Why | Proposed home |
|---|---|---|---|---|
| A reads B's records | H | **Missing** | No component substitutes another account's object or id. Same-privilege pairs are skipped (`access.ts:258`). The API survey only probes `PRIVILEGED` paths | Security module, read-only replay (step S3) |
| B modifies A's records | H | **Missing** | The guard is GET-only (`scope.ts:532`); engine access specs are GET-only | Advanced profile, non-production, own records only (S7) |
| B deletes A's records | H | **Missing** | same | same (S7) |
| Modified IDs (enumeration or neighbour ids) | H | **Missing** | nothing derives ids. The engine's id extraction (`engine/api/workflows.ts:consumersOf:338`, `idPathIn` `:409`) finds id-bearing paths but is used for positive workflows only | Swap between the two test accounts' **own** ids first; neighbour ids only in non-production (S3 and S7) |
| Alternative API endpoints (page refused but API open, e.g. a list endpoint behind a refused page) | V/H | **Partial** | Engine API survey covers privileged-looking GETs (catalogue BR-03 is rated "yes"); alternative non-privileged paths and method variants are not tried | S3 replays every API answer discovery saw, not only privileged-looking ones |
| Frontend routes opened directly | V | **Verified** (vertical); H **Missing** | `generateAccessSpecs` plus the `accessDenied` helper | Engine change after Phase 1 (E1) |
| Lower privilege invokes a higher-privilege operation (read) | V | **Verified** for GET | `surveyApiAccess`, `generateApiAccessSpecs` | — |
| Lower privilege invokes a higher-privilege mutation (e.g. role change) | V | **Missing** | GET-only everywhere. Schemathesis `advanced` would send POST, PUT, PATCH and DELETE with one identity, so it cannot compare roles | S7 |
| Missing authentication | — | **Verified** (API with documented auth; pages via the anonymous viewer) | `test-specs.ts:199-212`, `validator.ts:apiFinding` | S3 adds "replay A's authenticated GETs with no credential" in the assessment |
| Session expiry and invalid session (garbled or expired token, reuse after sign-out) | — | **Missing** | The module only detects that *its own* saved sign-in expired (`signin-rules.ts:judgeSignedInPage:72`, `tests/security-signin-expiry.test.ts`). Cookie flags are judged (`assessment/judge.ts`) | S5: GET replay with an altered credential (conservative-active). Reuse after sign-out needs a sign-out, so it belongs in S7 |
| Role changes and stale permissions (revoked share, demoted user) | H/V | **Missing** | needs a state change (revoke or demote) between two reads | Later: S7 with a client-declared "revoke" operation; otherwise out of scope |

The Phase 1 benchmark app `examples/bench-rbac` already seeds BR-01 to BR-06 (`eval/bench/catalogue.json:118-170`): horizontal read,
shared-user edit, vertical list, role escalation, session after sign-out, and stale share. It is a ready acceptance target **after**
Phase 1. It must not be modified, and tuning the engine against its seeded defects should be agreed with the Phase 1 owner, because it
risks overfitting the benchmark.

---

## 4. Passive-mode root cause and scanner activation

### 4.1 Why every assessment is passive (Verified)

1. `security/store.ts:createAssessment:631-648`. The INSERT passes the literal `"passive"` for `kind` (line 641), and the input type
   has no `kind` field.
2. `security/routes/assessments.ts:StartBody:111` is `z.object({ retestOf }).strict()`, so a body with `kind` gets a 400. The web
   client sends only `retestOf` (`web/src/features/security/Assessments.tsx:60`), and the UI subtitle says "A passive, read-only look"
   (`:169`).
3. `approval_json` on `security_assessments` is added by `scanners/store.ts:ensureScannerTables:71` and read by
   `store.ts:assessmentOf:448`, but **no code writes it**. No route records a scan approval either.
4. Downstream already respects the kind. `assessment/runner.ts:runScanners:489` derives `profile` from `a.kind`, and `:517` passes
   `a.approval`. `orchestration/run.ts:runScanners:122` refuses an approval-requiring profile without an approval.
5. `scanners/profiles.ts:profileRefusal:95` (production refused for `advanced`, approval required) is called only by the reporting
   route `routes/scanners.ts:53` (`GET …/scanners?profile=`). The start path never enforces it.
6. Audit wording, notifications and the report all say "passive" (`routes/assessments.ts:60,188,214`; `authorization.ts:76`).

Conclusion: the profiles are complete in the model and the adapters, and are blocked only at creation. **Unblocking them safely needs
more than adding `kind` to the body.** It also needs an approval record, start-time enforcement of `profileRefusal`, an authorization
that names the intensity (§6), and corrected wording.

### 4.2 Scanners in the repository

Every scanner is off unless all of these hold: it is named in `SECURITY_SCANNERS` (`scanners/settings.ts:enabledScanners:55`;
`.env.example:46-47` defaults to none); the project allows it (`scanners/store.ts:projectScanners:201`, set through
`PUT /api/v1/security/projects/:id/scanners`, permission `ai_studio.security.use`, `auth/roles.ts:569`); the binary or daemon is
reachable (`scanners/binaries.ts`, `registry.ts:usableAdapters:133`); the profile allows it; and the platform is **not** in
`EXECUTION_MODE=runners`.

| Scanner | Code | Operational end to end? | Notes |
|---|---|---|---|
| ZAP (daemon, API key) | `scanners/zap/adapter.ts` (552 lines) | **Partial.** Passive profile: `accessUrl` per URL, then the passive queue. Active profiles: `ascan` with protect mode and a context that includes the origin and excludes exclusions (`:323-357`). The live test is env-gated (`tests/security-scanner-e2e.test.ts:10-12`) | No auth header is used, so it scans signed out. **Suspected:** `ascan` with `recurse:true` from the origin (`:357`) scans everything in ZAP's site tree for that origin, and ZAP's active rules can submit forms. The profile text "nothing is created, changed or deleted" (`profiles.ts:60`) is not guaranteed by ZAP's policy. Needs reproduction |
| nuclei (binary plus a reviewed template directory) | `scanners/nuclei/adapter.ts`, `policy.ts` | **Partial.** The tag allow-list per profile (`policy.ts:PROFILE_TAGS:51-53`); xss, sqli, ssrf and rce are blocked at every profile | At passive the adapter adds `-passive` (`adapter.ts:226`). The repo's own integration test notes that this drops most templates ("1 of these 3 survives", `tests/security-scanner-integration.test.ts:72-74`). **Suspected:** near-zero passive coverage in practice |
| Schemathesis (CLI plus an uploaded API document) | `scanners/schemathesis/adapter.ts` | **Partial.** Reviewed checks, positive mode, safe methods only below `advanced` (`methodsFor:96`) | (a) No auth header is passed, so `ignored_auth` and `object_level_authorization` cannot work with one identity or none. (b) **Suspected:** `object_level_authorization` (`:58`) may not be a check name in the installed Schemathesis version. An unknown name could fail the whole advanced run. (c) **Suspected:** excluded paths and sensitive workflows are checked only on `target.urls` (`:369`). The document's operations under those prefixes are not removed from the spec and no exclude flag is passed (`args :409-447`), so at `advanced` a DELETE under a sensitive path could be generated |
| promptfoo (CLI plus a configured AI interface) | `scanners/promptfoo/adapter.ts`, `cases.ts` | **Partial.** Needs `aiInterface`, which `loopDeps` never supplies (`routes/assessments.ts:105-107` passes `settings` only; `RunnerDeps.scanners.aiInterface` stays unset) | **Suspected:** never receives an interface in the product, so it always refuses. Needs reproduction |

Hosted platform (Verified from code and `deploy/c4t-box/deploy.sh:140`):
- `runnersOnly(config)` makes `loopDeps` return deps without `scanners` (`routes/assessments.ts:70-86`), so
  `runner.ts:385` (`if (this.deps.scanners && !work.scanners)`) never runs the scanner stage. Coverage carries
  `SCANNERS_NOT_ON_RUNNER` (`platform/runner-only.ts:68`).
- Production's actual env file was not read (out of bounds). The deploy script writes `EXECUTION_MODE=runners`.

### 4.3 What activation needs (Proposed, smallest first)

1. **Profile on start:** add an optional `kind` to `StartBody` (default `passive`, so existing clients are unchanged) and an
   optional `kind` to `createAssessment`. Enforce `profileRefusal(kind, app.environment, hasApproval)` at start and answer 409 with its
   sentence. Make audit and UI wording use the kind.
2. **Approval record:** `POST …/applications/:appId/scan-approvals` (permission `ai_studio.tests.approve`, as authorizations use) builds
   one with `profiles.ts:requiredApproval:114`. It is stored on the assessment's `approval_json` (the column already exists) at
   creation and bound to the current authorization id, so a revoked or stale authorization voids it.
3. **Authorization names the maximum intensity:** add `maxProfile` to the scope fingerprint only when it is set, so existing
   authorizations stay current (the same additive pattern as `signInAccount`, `authorization.ts:35-39`). Change the statement
   sentence per profile.
4. **Scanners with sign-in:** pass `target.authHeader` into ZAP (a replacer rule or header), nuclei (`-H`) and Schemathesis
   (`--header`), only when the application's authorization covers the signed-in account.
5. **Hosted:** either run scanners on the runner (a new runner capability: binaries on the runner's computer, which is a larger
   change and touches `src/agent`), or keep scanners for self-hosted platforms only and say so in the UI. **Recommendation:** keep it
   self-hosted only for now. The cross-account checks in §5 do not need external tools and work on runners through `probe.ts`.
6. **Fix the suspected issues** (ZAP scope recursion, the Schemathesis exclusion gap, the check name, promptfoo's interface) before
   offering `advanced` to anyone. Each needs a reproduction on the security fixture (`examples/security-fixture/server.mjs`) first.

---

## 5. Minimal implementation plan (Proposed)

The steps are small and can each ship alone. S1–S6 touch only `src/security`, `web/src/features/security` and tests. All default off
or to existing behaviour.

| Step | What | Files | Profile needed | Size |
|---|---|---|---|---|
| S1 | `kind` on start, `profileRefusal` enforced at start, wording follows the kind. Default `passive`, unchanged | `security/routes/assessments.ts`, `security/store.ts:createAssessment`, `web/src/features/security/Assessments.tsx` | — | S |
| S2 | Scan approval route plus `approval_json` written at creation. Authorization gains an optional `maxProfile` (fingerprint changes only when set). Statement per profile | `security/routes/core.ts` or a new route file, `security/authorization.ts`, `security/store.ts`, `auth/roles.ts` (one line per new route) | — | S |
| S3 | **Read-only cross-account replay.** The application gets an optional `peerSignInAccount` (a second saved sign-in via the existing `SessionStore` account names, `security/signin.ts:accountNames:59`), and it joins the fingerprint when set. After discovery as A, every same-origin GET answer A received with 2xx JSON or HTML (`DiscoveryResult.apiAnswers`, `assessment/types.ts:91`; pages) is replayed through the **same guard** as B and as anonymous. Verdict per URL: B or anonymous gets 2xx **and** the body contains A-only markers (ids or emails present in A's answer but absent from B's own discovery) → `access-control` finding, `probable`. 401/403/404 or no marker → pass, listed in coverage. Capped (e.g. 50 URLs), rate-limited, sign-out refused as today | new `security/assessment/cross-account.ts`; hook in `assessment/runner.ts` after SCANNING; `probe.ts` so it also runs on runners; normalize rule in `findings/normalize.ts` | conservative-active, because it deliberately presents one identity for another's resource | M |
| S4 | Id swap between the two **test accounts' own** objects: ids seen in A's URLs or bodies are substituted into B's id-bearing GET paths and the reverse. No enumeration of unknown ids | `cross-account.ts` (reuse the path-template logic idea from `engine/api/workflows.ts:consumersOf`, copied rather than imported so the engine stays untouched) | conservative-active | S |
| S5 | Invalid-session check: replay 3–5 of A's authenticated GETs with the session cookie or token altered (truncated, or with a wrong signature), expecting 401/403 or a redirect to sign-in | `cross-account.ts` | conservative-active | S |
| S6 | Evidence and dedupe: fingerprint = `access-control` + check id (`cross-account-read`, `id-swap`, `invalid-session`) + normalised path template (ids replaced by `{id}`), so 40 note ids give one finding. Evidence = status for A, B and anonymous, the matched marker (redacted), and replay steps. Scrubbed with `scrubSecrets` for both sign-ins | `findings/normalize.ts`, `signin-rules.ts` usage | — | S |
| S7 | **Mutating checks (advanced, non-production, approved).** A guard method allowance for PUT, PATCH and DELETE that applies **only** to a record the assessment itself created as A in this run, where the create and delete operations come from the uploaded API document. Sequence: A creates → B reads, updates and deletes (expect refusal) → A re-reads to confirm it is unchanged → A deletes (cleanup). Covers BR-02 and BR-04-style role escalation when the document has the operation. Sign-out reuse (BR-05): A signs out with the saved session copy kept, then replays one GET | `security/scope.ts` (a narrow, separately tested allowance), `cross-account.ts`, profile text | advanced | M–L |
| S8 (later) | Engine-side horizontal checks: compare same-privilege accounts in `generateAccessSpecs`, and widen `surveyApiAccess` beyond `PRIVILEGED` to id-bearing GETs. **Only after Phase 1** | `engine/identity/access.ts`, `engine/orchestrator.ts` | — | M |
| S9 (later) | Scheduled assessments (weekly or after deploy) through the existing schedule infrastructure | `platform/schedule-*.ts`, `security/routes` | — | M |

Not proposed:
- a second findings table or a "functional findings" fork for access results;
- a new job queue (the assessment loop already has lease, cancel and restart);
- external tools for BOLA (the in-house replay is cheaper, runs on runners, and stays under the scope guard);
- enumeration of unknown ids in production.

---

## 6. Safety and environment restrictions (Proposed, required before S3+)

1. **Authorization record:** active checks need a current authorization whose `maxProfile` is at least the run's kind, and whose
   statement names the checks in plain words ("signs in as two test accounts and requests one account's pages as the other"). Any
   change to the peer account, the profile or the scope makes it stale (fingerprint).
2. **Scope guard stays the only network path** for in-house checks (`guardFor`, or the runner-side guard in `probe.ts`).
   - S3–S6 remain GET, HEAD and OPTIONS.
   - S7's write allowance is per run, per created record id, and recorded in the audit log.
   - Sensitive workflows and excluded paths are never requested at any profile.
3. **Non-production only for mutating checks:**
   - `advanced` stays refused where `app.environment === "production"` (`profiles.ts:78`).
   - Also refuse when the URL matches a project environment flagged `production` (`platform/environments-store.ts` `production`
     column), so a mislabelled application cannot slip through. This reuses the platform's production rule
     (`platform/environment-run.ts:35,41-49`).
4. **Test accounts only:** both identities must be saved sign-ins of named test accounts. The project's main account is not allowed
   as the peer, and real customer accounts are not supported.
5. **Approval:** advanced requires an approval (`tests.approve`) recorded with the assessment, as already modelled
   (`profiles.ts:requiredApproval`).
6. **Budgets:** the existing `SECURITY_MAX_REQUESTS`, per-application rps, and time limit apply. Cross-account replay gets its own
   sub-cap.
7. **Kill switch:** cancel and the emergency stop already abort the loop (`routes/assessments.ts:stopOne`). No new path may bypass
   them.
8. **Evidence:** bodies are excerpted and redacted (`findings/redact.ts`). Values of both sign-ins are scrubbed. Another person's data
   is never stored beyond the marker that proves exposure.

---

## 7. Acceptance criteria

- **S1/S2:**
  - A POST without `kind` behaves byte-for-byte as today (same row, audit text, UI).
  - `kind:"advanced"` on a production application → 409 with the `profileRefusal` sentence. Without an approval → 409.
  - With an approval → `approval_json` is stored, and `orchestration/run.ts` runs the allowed adapters (unit test with fake adapters,
    as in `tests/security-scanner-orchestration-unit.test.ts:191-212`).
  - Existing authorizations stay `current` after the upgrade.
- **S3–S6, on a local fixture with two same-role accounts (a new security fixture, not the Phase 1 bench app):**
  - A note readable by B → one `access-control` finding (one per path template), `probable`, with evidence for A, B and anonymous.
    The correct fixture variant → zero findings.
  - Zero non-GET requests in the scope-session event log.
  - Neither account's cookie appears in stored evidence (assert with `scrubSecrets` inputs).
  - The retest marks it `fixed` when the fixture is corrected.
- **S7:**
  - Refused on production and without approval.
  - On staging, the B update and delete of A's created record is detected.
  - Only records created in the run are written. Cleanup leaves no record (verified by A's list before and after).
  - Every write is in `security_audit`.
- **After Phase 1 (optional):** on `examples/bench-rbac`, detect BR-01 and BR-03 at conservative-active, and BR-02, BR-04 and BR-05
  at advanced. Report the result separately from the Phase 1 baseline.
- No change to functional test generation or to any customer test result (S1–S7 touch no `src/engine` file).

---

## 8. Reuse map (Section C)

| Need | Reuse | Note |
|---|---|---|
| Auth and session | `security/signin.ts:resolveSignIn`, `limitToScope:124`; `signin-rules.ts:cookieHeaderFor:29`, `isSignOut:17`, `scrubSecrets:54`; `platform/session-store.ts` (saved sign-ins per account) | A second resolved sign-in per application is the only new piece |
| Roles and permissions | Platform: `auth/roles.ts:ROUTE_PERMISSIONS` (security routes `:525-570`; approvals use `ai_studio.tests.approve`). App under test: `identity-store.ts` names | Role names carry no privilege order. The engine infers it from page counts (`access.ts:258`); the module needs none (pairwise) |
| Test accounts | `IdentityStore` (passwords, TOTP, API tokens; engine) and `SessionStore` (saved storage states; security module). Environments can carry their own accounts (`environments-store.ts:use_project_accounts`) | The security module never types a password, so the peer must be a saved sign-in |
| Finding lifecycle and dedupe | `findings/ingest.ts:ingest:119`, `normalize.ts:fingerprintOf:139`, `normalizeLocation:128`, `store.ts` upsert, sightings and history, retest `ingest.ts:retestTargets:203` | Only a path-template normaliser for ids is new |
| Evidence | `contract.ts:Evidence:161` (`status`, `body-excerpt`, `note`), capped at 20 items and 4000 chars (`store.ts:233-234`) | Enough for A, B and anonymous statuses and the marker |
| Scheduling and execution | `AssessmentLoop` (lease, restart, cancel); `on-runner.ts` and `probe.ts` for hosted; retest | No schedule exists (S9) |

---

## 9. Dependency and conflict table

Columns: (1) independent of Phase 1, (2) needs Phase 1 DB models, (3) needs Phase 1 application intelligence, (4) changes
generation or repair, (5) changes benchmark execution, (6) could alter existing customer results, (7) conflicts with another
workstream.

| Change | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| S1 kind on start | yes | no | no | no | no | no (default passive) | none |
| S2 approval and authorization `maxProfile` | yes | no | no | no | no | no (additive fingerprint) | none |
| S3–S6 cross-account replay | yes | no | no (later: intel entities and relationships, `engine/intel/model.ts:EntitySchema/RelationshipSchema`, could label ownership) | no | no | only for applications that opt in to a peer sign-in | WS3 evidence model (shared shape for request/response evidence) |
| S7 mutating checks | yes | no | optional | no | no | opt-in, advanced only | WS2 if it changes the sign-in or session helpers |
| Scanner auth header and fixes | yes | no | no | no | no | only for platforms with scanners enabled | none |
| S8 engine horizontal checks | **no, after the benchmark** | no | benefits | **yes** (new generated tests) | **yes** (`accessChecks` on in the bench, `eval/bench/cli.ts:45,306`) | yes (new tests in explorations) | WS2 (`engine/discovery/auth.ts` login), WS4 (test metadata and selection) |
| S9 scheduling | yes | no | no | no | no | no | WS4 if it adds deploy-triggered runs |

Shared files and merge risk:

| File | Phase 1 state | Other workstreams | Risk |
|---|---|---|---|
| `platform/db.ts` (migration list) | **modified**, slot 62 = `APP_INTEL_MIGRATION` | any WS adding tables | High. Security tables are created through `ensureSecurityTables` and `ensureScannerTables` with additive ALTERs (`scanners/store.ts:71`). S2 and S3 should add columns there (application `peer_sign_in`, authorization `max_profile`) instead of taking slot 63, and also update `pg/baseline.sql` (**modified** by Phase 1) only once Phase 1 has merged |
| `platform/auth/roles.ts` | **modified** (intel routes) | WS3/WS4 new routes | Medium (append-only map; rebase conflict only) |
| `platform/routes/index.ts` | **modified** | — | Low. Security routes register inside `security/routes/index.ts` |
| `engine/identity/access.ts`, `engine/orchestrator.ts` | read by the benchmark | WS2 (sign-in helper `ACCESS_HELPER_SOURCE:30-86`, `discovery/auth.ts`), WS4 | High. S8 waits for Phase 1 |
| `engine/validation/validator.ts` (`accessFinding`, `apiFinding`) | used by the benchmark | WS2 (assertion and execution split) | High. Not touched by S1–S7 |
| `security/assessment/runner.ts`, `probe.ts`, `scope.ts` | untouched | WS3 if it instruments the guard's `ScopeEvent` stream (`scope.ts:322`) for request correlation | Medium. Agree that `ScopeEvent` is the request event the WS3 model consumes |
| `src/agent/explore-child.ts` (runner side of probes) | untouched | WS2 (runner execution) | Medium. S3 runs inside the existing `probe.ts` path, so no change is needed there |
| `web/src/features/security/*` | untouched | — | Low |

Recommended order: S1 → S2 → S6 (normaliser) → S3 → S4 → S5 (all now, all in `src/security`). Fix the suspected scanner issues in
parallel. S7 comes once the WS3 evidence shape is agreed. S8 and S9 come after Phase 1 merges.

---

## 10. Risks

- Higher profiles become reachable: one wrong default, or a missing start-time check, would run intrusive tools. Mitigations: the
  default stays passive; `profileRefusal` is enforced server-side; there are tests for production refusal and approval absence.
- **Suspected** ZAP active-scan side effects, and the Schemathesis exclusion gap. Do not enable `advanced` until both are reproduced
  and fixed.
- Cross-account replay false positives: shared or public resources look exposed. Mitigations: the marker requirement (A-only values),
  `probable` rather than `confirmed`, and a person validates.
- Customer consent: existing authorizations say "passive". Active checks must require a new statement; they must never reuse an old
  authorization.
- Merge conflicts on `db.ts` and `baseline.sql` with Phase 1. Avoided by the additive ensure-ALTER pattern until Phase 1 lands.

## 11. Complexity

S1 S, S2 S, S3 M, S4 S, S5 S, S6 S, S7 M–L, S8 M, S9 M; the scanner fixes are S each once reproduced. S1–S6 together are about M (one
engineer, roughly one round).
