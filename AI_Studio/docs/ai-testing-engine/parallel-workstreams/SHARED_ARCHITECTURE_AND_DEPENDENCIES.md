# Shared architecture and dependencies

Cross-workstream review of the four audits in this folder (`SECURITY_TESTING_AUDIT.md`, `EXECUTION_RELIABILITY_AUDIT.md`,
`EVIDENCE_OBSERVABILITY_AUDIT.md`, `CHANGE_AWARE_SELECTION_AUDIT.md`). Labels as in those documents: **Verified** (read in code),
**Proposed**. State: `main` = `7a164a8`; Phase 1 work uncommitted in the working tree; the Phase 1 baseline benchmark is running.

## 1. The constraint that dominates scheduling (Verified)

The baseline runs for several days and is continued with `--resume` from **this working tree**: each resume starts a new process that
loads `src/platform`, `src/engine` and `src/eval` from disk. Any edit in the working tree between resumes changes the code under
measurement. The controller records the engine commit and a dirty flag (`src/eval/bench/record.ts:33-37`) and fingerprints the prompt
sources (`web/author.ts`, `planning/planner.ts`, `understanding/analyzer.ts`, `validation/repair.ts`, `llm/routing.ts`), but it cannot
tell a mid-run edit apart from the state at start.

Consequence: **no workstream edits this working tree until the baseline is recorded.** Implementation happens in a separate git
worktree on its own branch (created from `7a164a8`), merged after the baseline is frozen and Phase 1 is committed. Documentation-only
work (this folder) is the exception.

## 2. Shared components: one implementation, several users

| Component | Exists today | Who needs it | Proposal |
|---|---|---|---|
| **Per-step evidence** (requests, console, page errors tagged with the step) | Verified: `engine/evidence/capture.ts` embedded in rendered scripts (`generators/playwright.ts:388-395`), `evidenceStep(page, n)`, `sanitizeEvidence` (`evidence/model.ts`), `evidence` artifact; kept only for failing tests (`capture.ts:275`) | WS3 (bug evidence), WS4 (test→endpoint coverage from passing runs), WS1 (proof of a cross-account read), WS2 (crash/disconnect events) | Evidence JSON v2 inside the existing artifact (WS3 E5-E8), plus a small footprint for passing runs (WS3 E10) that is exactly WS4's coverage source. One format, no new table. |
| **Secret masking** | Verified: two lists — `secretsOfRun` (`evidence/model.ts:58-67`: credentials, tokens, roles) and `traceSecretsOfRun` (`evidence/trace-scrub.ts`: also secret-named environment variables and saved sign-in values); console problems kept raw (`discovery/browser.ts:159`) | WS3 (all artifacts), WS1 (cross-account evidence, two accounts' secrets), WS2 (crash events) | One function, the wider list, used everywhere (WS3 E1/E3/E4) — prerequisite for WS1 S3-S6 and any new evidence. |
| **Sign-in** | Verified: `discovery/auth.ts:login` (judges too early, `:125-132` + `browser.ts:settle:280-283`); `run-session.ts:86` and `signed-in.ts:126` already wait for the password field to go | WS2 (C1 root cause), WS1 (second account sign-in for cross-user replay; `identity/access.ts:188` uses `login()`), the benchmark (`BENCH_LOGIN=js`) | Fix once in `auth.ts` (WS2 C1); WS1 then reuses it. |
| **Findings** | Verified: `security/findings/*` (normalise, fingerprint, upsert, sightings, retest; category `access-control`) | WS1 (cross-account findings), later Phase 5 (functional findings) | WS1 writes into the existing security findings — no second findings store. Generalising to functional findings stays Phase 5. |
| **Guarded outbound requests** | Verified: `security/scope.ts guardedFetch` GET/HEAD/OPTIONS only | WS1 (read-only replay as another account), WS3 (request event stream for correlation, optional) | Keep read-only for S3-S6; a mutating path only with the advanced profile and authorization (WS1 S7). |
| **Job orchestration** | Verified: `generation_jobs`, modes, triggers (`trigger-services.ts:184` runs every runnable test), runbooks (`runbook-runner.ts:156-180` manual selection) | WS4 (selected test list in job options JSON), WS1 (assessment kind on start) | No new queue; selection is a list of test ids in options, as runbooks already pass. |
| **Test↔page/endpoint/requirement relations** | Verified partially: derivable from spec `navigate`/`request` steps, screen map, requirement links; per-test observed endpoints not stored (`repo-sink.ts:179` merges per job) | WS4 (selection), Phase 2 (coverage of rules/workflows) | WS4's pure coverage extractor (steps 1-4) reads what exists; observed coverage arrives with the shared evidence footprint. |

Not forced together: security assessment models and functional execution records stay separate (different lifecycles and consent); the
Phase 1 intelligence store is read by WS4 later but not changed by it.

## 3. Dependency matrix

Columns: (1) independent of Phase 1 code · (2) depends on Phase 1 DB models · (3) depends on Phase 1 intelligence · (4) changes generation
or repair · (5) changes benchmark execution if merged mid-run · (6) can change customer results · (7) conflicts with another workstream.

| Item | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| WS1 S1 assessment `kind` on start (default passive) | yes | no | no | no | no¹ | no (default unchanged) | — |
| WS1 S2 approval route + profile-naming authorization | yes | no | no | no | no¹ | no | roles.ts (append) |
| WS1 S3-S6 read-only cross-account replay, id swap, altered session | yes | no | no | no | no¹ | yes (new findings, opt-in) | needs shared masking; uses fixed sign-in |
| WS1 S7 mutating checks (advanced profile, non-production) | yes | no | no | no | no¹ | yes (opt-in) | WS3 evidence shape |
| WS1 S8 engine horizontal checks (`identity/access.ts`) | yes | no | no | no | **yes** (bench runs accessChecks) | yes | WS2 `auth.ts` |
| WS2 C1 sign-in waits for outcome (`auth.ts`) | yes | no | no | no | **yes** (engine dirty; HTML login unaffected) | yes (JS-login sites start working) | WS1 sign-in reuse |
| WS2 C2 retry interrupted crawl navigation | yes | no | no | no | **yes** | yes | `crawler.ts` |
| WS2 C3 drop step titles from failure video (after reproduction) | yes | no | no | no | **yes** | yes (strict-CSP sites lose false findings) | WS3 (videos) |
| WS2 C4 crash/disconnect session events | yes | no | no | no | **yes** | no (records only) | WS3 events, `browser.ts` |
| WS2 C5 `--login js` benchmark option | no (Phase 1 file `eval/bench/apps.ts:84-90`) | — | — | no | **yes** (benchmark config) | no | — |
| WS3 E1/E3/E4 platform-side masking fixes | yes | no | no | no | no¹ | no (masks more) | shared with WS1 |
| WS3 E2 mask console text before authoring prompts (`web/author.ts`) | yes | no | no | **prompt input** | **yes** (fingerprinted prompt source) | slightly | — |
| WS3 E5-E7 step timing, outcome view, trace digest | yes | no | no | no | depends on file² | no | `validation/runner.ts` with WS2 |
| WS3 E8 rendered-script evidence v2 | yes | no | no | no | **yes** (script hash changes; resets quarantine window `quarantine-store.ts:128-140`) | no | WS2 generator edits; keep `evidenceStep(page, N);` line (`mutation/faults.ts:157`) |
| WS4 steps 1-4 coverage extractor, selector, facts adapter, preview route | yes | no | no | no | no¹ | no (preview only) | — |
| WS4 step 5 opt-in selection on triggers/runbooks/CLI | yes | no | no | no | no¹ | only when opted in | `trigger-services.ts`, `runbook-runner.ts` |
| WS4 step 7 per-execution endpoint store | yes | migration slot after 62 | no | no | no¹ | no | WS3 E10 footprint |
| WS4 step 9 workflow/rule-aware selection | no | yes | **yes** | no | no | — | Phase 2 |

¹ Not part of the benchmark's code path, but still edits loaded by a `--resume` process if made in this working tree — hence §1.
² `validation/runner.ts` is engine code: any edit marks the benchmark dirty.

## 4. Files most likely to conflict

| File | Touched by | Note |
|---|---|---|
| `src/platform/db.ts`, `src/platform/pg/baseline.sql` | Phase 1 (slot 62, uncommitted), WS4 step 7 | WS1 avoids them with module-owned `ALTER`s (pattern `security/scanners/store.ts:71`); WS4 step 7 takes the next slot after Phase 1 is committed |
| `src/platform/auth/roles.ts`, `routes/index.ts` | Phase 1, WS1 S2, WS4 step 4 | append-only edits; merge after Phase 1 commit |
| `src/engine/discovery/browser.ts` | WS2 C1/C4, WS3 E4, WS1 (sign-in reuse) | one owner at a time |
| `src/engine/discovery/auth.ts` | WS2 C1, WS1 S8 | WS2 first |
| `src/engine/validation/runner.ts`, `generators/playwright.ts` | WS2 C3, WS3 E5-E8, WS4 (footprint) | batch generator changes in one release |
| `src/engine/evidence/*`, `trace-scrub.ts` | WS3, WS1 | WS3 first |
| `src/eval/bench/*`, `vitest.fast.config.ts`, `tests/bench-*` | Phase 1 only | other workstreams add their own test files |

## 5. Recommended order (minimises conflicts)

1. **Now (docs only, this tree):** these audits; decisions (§ open questions in the roadmap).
2. **Now, in a separate worktree/branch from `7a164a8`, no merge until the baseline is frozen:** WS3 E1/E3/E4 (shared masking) → WS1
   S1-S2 → WS1 S3-S6 → WS4 steps 1-4. None touches generation, repair or the benchmark's code path.
3. **After the baseline is recorded and Phase 1 committed:** WS2 C1 → C2 → C4; WS3 E2, E5-E7; WS2 C3 after its reproduction;
   WS3 E8 together with any generator change; WS1 S7, S8; WS4 step 5, step 7 (next migration slot).
4. **After Phase 2 data exists:** WS4 step 9.
