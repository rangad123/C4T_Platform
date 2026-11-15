# Parallel implementation roadmap

Built from the four audits and `SHARED_ARCHITECTURE_AND_DEPENDENCIES.md`. Effort: S < 1 week, M 1-3 weeks, L 3-6 (one engineer, tests
included). Every item lands on its own branch from a separate worktree and is merged only after the Phase 1 baseline is recorded
(reason: `SHARED_ARCHITECTURE_AND_DEPENDENCIES.md` §1).

## Critical fixes

| # | Item | Why | Files | Effort | Can start |
|---|---|---|---|---|---|
| C-1 | One secret-masking list for evidence, traces and stored errors (WS3 E1/E3/E4) | Verified gap: `evidence/model.ts:secretsOfRun` omits secret-named environment variables and saved sign-in values that `trace-scrub.ts` covers; stored run/step errors on the platform path suspected unmasked | `engine/evidence/model.ts`, platform mapping of run results | S | now (worktree) |
| C-2 | Mask browser console and page-error text before it reaches the AI (WS3 E2) | Verified: `discovery/browser.ts:159,181` keep raw text; it is sent with authoring prompts (`web/author.ts`) | `discovery/browser.ts`, `web/author.ts` | S | after baseline (prompt source) |
| C-3 | Sign-in waits for its outcome (WS2 C1) | Verified root cause: `auth.ts:125-132` clicks then `settle()` (`browser.ts:280-283`) returns at once on an already-loaded page; JS-submitted forms are judged before they navigate; the late navigation then interrupts the crawl (`crawler.ts:678`) and the access survey drops every account (`identity/access.ts:188`) | `discovery/auth.ts` (reuse the wait in `run-session.ts:86` / `signed-in.ts:126`) | S | after baseline |
| C-4 | Active security profile must never start by accident: `kind` on start with a start-time `profileRefusal` check (WS1 S1) | Verified: kind is a literal (`security/store.ts:641`), the approval column is never written, the refusal check only runs in the report route (`routes/scanners.ts:53`); fixing the start path safely is the prerequisite for anything active | `security/store.ts`, `security/routes/assessments.ts` | S | now (worktree) |

## High-value improvements

| # | Item | Files | Effort | Can start |
|---|---|---|---|---|
| H-1 | Read-only cross-account checks: replay A's GET answers as B and as a visitor, swap ids between two test accounts, altered/expired session (WS1 S3-S6), findings into the existing security findings (`access-control`) | `src/security/**` (new probe beside `assessment/probe.ts`), saved sign-ins | M | now (worktree), after C-1 |
| H-2 | Authorization that names the highest allowed profile and an approval route (WS1 S2); old passive consent never covers active checks (`authorization.ts:76`) | `security/authorization.ts`, routes, web security pages | S | now (worktree) |
| H-3 | Coverage extractor + explainable selector + preview route (WS4 steps 1-4): changed endpoints/screens/requirements → tests, a reason per test, untested changes listed, full regression still the default | new `src/platform/selection/*`, one route | M | now (worktree) |
| H-4 | Retry an interrupted crawl navigation once (WS2 C2), as `security/assessment/discover.ts:432` already does | `discovery/crawler.ts` | S | after baseline |
| H-5 | Step timing, page address/title and assertion outcome in evidence JSON v2; outcome joined at read time from `test_version_id` + `failure-facts.ts` (WS3 E5-E6) | `validation/runner.ts`, evidence read side | M | after baseline |
| H-6 | Opt-in selection on deploy triggers, runbooks and the CLI (WS4 step 5) | `trigger-services.ts`, `runbook-runner.ts` | S-M | after H-3 and the baseline |
| H-7 | Crash and disconnect recorded as session events (WS2 C4) | `discovery/browser.ts` | S | after baseline |

## Later enhancements

- WS2 C3: remove step titles from the failure-video overlay **only after** the three-configuration reproduction confirms it as the strict-CSP
  false-positive source (the audit found the earlier "Playwright-injected style" explanation unlikely; `runner.ts:157` `show.test`).
- WS3 E7 trace digest, E8 rendered-script evidence v2 (ship together with any generator change; keep the `evidenceStep(page, N);` line that
  fault injection matches), E9 optional screenshot covering / no failure video, E10 passing-run footprint (only with WS4 step 7).
- WS4 step 7 per-execution endpoint store (next migration slot after Phase 1's 62), step 9 workflow/rule-aware selection (after Phase 2).
- WS1 S7 mutating authorization checks (advanced profile, non-production, approved, only records the run created), S8 engine-side horizontal
  checks in `identity/access.ts`, S9 scheduled assessments.
- WS2 C5 `--login js` in the benchmark (Phase 1's file `eval/bench/apps.ts:84-90` never passes `BENCH_LOGIN`): a Phase 1 follow-up run, not part
  of the frozen baseline.

## Not recommended (overengineered or unsafe now)

- A new observability platform, tracing collector or event table: evidence JSON in the existing artifact is enough.
- Adding correlation headers to the application's requests: cross-origin calls would trigger CORS preflights and change behaviour.
- An AI-built dependency graph or filename-based impact inference for selection.
- Enabling the external scanners in the hosted mode before their suspected issues are reproduced (ZAP recursive active scan may submit
  forms; Schemathesis may generate requests to excluded or sensitive operations; a possibly invalid check name; nuclei `-passive`
  dropping most templates; promptfoo always refusing; none reads `target.authHeader`).
- Filtering CSP messages or weakening health checks to remove the false positive.
- A second findings system.

## Acceptance (per item, detail in each audit)

- C-1/C-2: a test seeds each secret kind (password, one-time secret, token, auth header, secret-named variable, saved sign-in value) and
  proves none appears in evidence JSON, trace, stored error or prompt text.
- C-3: the bench apps' `BENCH_LOGIN=js` variant signs in; wrong credentials still fail; HTML login unchanged; regression scenarios R1-R10.
- C-4/H-2: an assessment without an authorization naming the profile cannot start as anything but passive; default unchanged.
- H-1: on bench-rbac (read-only, separate from the baseline) the cross-account scenarios report the seeded authorization defects and nothing
  on the clean variant.
- H-3/H-6: each selected test has a reason; untested changes are listed; "run everything" always available; no existing run changes unless
  selection is switched on.

## Decisions (2026-11-14, see ../DECISIONS.md)

Answered: retention on (failed-run traces/videos 7 days, passing-run metadata 30 days, no full passing traces/videos; project setting allowed);
no automatic screenshot embedding until visual redaction exists; ~5 KB passing-run metadata approved (no bodies, credentials, cookies,
screenshots); response-header allow-list approved (read only, never inject); active/mutating security checks only on development and staging,
written client authorization naming the level, approval by a Crowd4Test admin, backend-enforced, never production by default; consent wording
must be shown before approval; S7 after the authorization policy; hosted cross-account after the runner protocol change; advanced scanner
profile disabled until adapter fixes are verified; opt-in automatic selection on deploy triggers (full run default, unknown coverage never
excludes); step-title captions may go only if step names stay available elsewhere.

New items from those decisions (added to the queue):
- D-1 retention defaults (7 / 30 days, failed-run media separate from passing metadata).
- D-2 project report without embedded screenshots (until visual redaction).
- D-3 passing-run metadata record (WS3 E10) and observed coverage for selection (WS4 step 7).
- D-4 response-header allow-list in evidence.
- E-1 opt-in selection on deploy triggers (H-6).
- F-1 money spending limit for the operator (shared access key) AI use.
- C-gate: authorization policy per C1/C2 (wording approval first), then S7.
