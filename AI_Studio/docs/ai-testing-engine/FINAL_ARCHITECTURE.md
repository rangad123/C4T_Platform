# AI testing engine: final architecture

What the engine is after Phases 1–7, how its parts fit together, and the status of each capability. Measured numbers are in
`BENCHMARK_RESULTS.md`, open problems in `QUALITY_GAPS.md`, and what this means for use in `PRODUCTION_READINESS.md`.

Two paid series measured the engine, both with model `claude-haiku-5-5`:
- the benchmark ladder on build `3cf5bd04` (50 trials);
- a re-check of the ladder's top configuration on build `33a3916d` (10 trials), after the fixes made since the ladder.

For every target the re-check measured, `33a3916d` is the measured build and its number decides the status. The ladder's number is
kept as history. Changes made after the re-check were checked offline only. Where a capability changed after the re-check, its row
says so, and its numbers are marked "offline re-judge, not yet measured in a paid run".

## Status labels

Every capability in these four documents carries exactly one label.

| Label | Meaning |
|---|---|
| **Verified on real applications** | Its benchmark target is met, and it also worked on the practice store: a separate web store application, not part of this repository, run locally with its own seeded bugs. No customer application has been tested. |
| **Verified in benchmark** | Its target is met on the seeded-defect benchmark (BenchShop and BenchNotes, 5 trials per app, median and range) or on the pull-request benchmark. |
| **Tested** | Automated tests or probes for it pass. No benchmark target measures it. |
| **Implemented** | Built and live; no target measures it. |
| **Partial** | Built, but its measured target is not met, or it works only in some cases. |
| **Not implemented** | Not built. |

## The pipeline

```
sources (pages, OpenAPI, requirements, existing tests)
  → application model: screens, endpoints, workflows, rules (each rule with its source; a person confirms)
  → objectives: one per stated rule and workflow
  → exploration loop: bounded steps, odd inputs, repeated and out-of-order steps
  → tests across layers: page, API, stored data, read-only database
  → candidate findings, with steps and evidence; a defect whose own check is at fault is not reported
  → verification: 3 replays on fresh accounts, class, group, cause from code, masking, a 13-field report
  → change-aware testing: which tests a pull request reaches, with a reason each; a full run stays the default
```

Design rules kept throughout (see `MASTER_PLAN.md`):
- No new services, queues or agent frameworks. New job modes, runner modes and stores with their own migrations.
- Deterministic checks first; the AI model for judgement on unstructured input. A verdict comes from a check that ran.
- Every expectation has a source. What the application does today is never taken as proof of what it should do.
- Measured by a seeded-defect benchmark. Detection numbers are kept apart from test-quality scores.

## Parts and where they live

Paths are under `AI_Studio/src/`.

| Part | What it does | Main files |
|---|---|---|
| Benchmark | Two practice apps with switchable seeded bugs (20 original, 11 extension), a catalogue with a checker per bug, the trial runner, metrics, spend limits, the ladder, miss analysis | `eval/bench/catalogue.json`, `catalogue-extension.json`, `controller.ts`, `metrics.ts`, `ladder.ts`, `miss-analysis.ts`, `observed.ts`; apps in `../examples/bench-shop`, `../examples/bench-rbac` |
| Application understanding | Reads pages, API documents and requirements into one model; rules carry source, evidence, explicitness and confidence; pages only a test account reached are kept with who reached them; re-reads only what changed | `engine/understanding/`, `engine/requirements/`, `engine/screenmap/`, `platform/app-intel-store.ts` |
| Exploration | Objectives from rules and workflows, a bounded loop, odd-input classes, perturbed step orders, a coverage record | `engine/explore/` (`objectives.ts`, `loop.ts`, `input-classes.ts`, `perturb.ts`, `coverage.ts`, `independence.ts`) |
| Checks across layers | API answers against the document, documented error cases, two-account access, multi-step API flows, double submits, invariants, read-back, read-only database checks, a risky-checks gate, a layer report | `engine/api/`, `engine/identity/`, `engine/database/`, `engine/security/functional.ts`, `engine/validation/` (`layers.ts`, `invariants.ts`, `risky.ts`, `validator.ts`) |
| Findings and verification | One findings list, a report gate for the test's own faults, lifecycle states, replays, classification, grouping, cause from code, masking, the report, Check the fix | `platform/candidate-finding-store.ts`, `engine/findings/` (`expectation.ts`), `platform/findings/` (`verify-service.ts`, `adapters.ts`, `report-facts.ts`, `regression-service.ts`), `engine/evidence/` |
| Change-aware testing and triggers | Connects a GitHub repository (fine-grained token), reads a pull request, maps tests to pages and endpoints, proposes the tests it reaches; a deploy token that runs a chosen agent | `platform/code-host/`, `engine/impact/`, `platform/trigger-services.ts` |

## Capabilities and status

Numbers are shop / notes app (BenchShop / BenchNotes), median [range] over 5 paid trials: the re-check on `33a3916d` where it measured
the capability, otherwise the ladder on `3cf5bd04`.

### Foundation (Phase 1)

| Capability | Status | Evidence |
|---|---|---|
| Seeded-defect apps, one switch per bug, a checker per bug | Tested | 31 bugs with checkers; used by all 50 ladder trials and the 10 re-check trials |
| Benchmark runner, metrics, spend estimate and limits | Tested | 50/50 ladder and 10/10 re-check trials completed; runs stop at the spend limit |
| Every result records model, prompts and engine build | Tested | model and a build fingerprint in every trial |
| Test-quality score (kept apart from detection) | Implemented | not wired into generation, by design |
| Baseline of the original pipeline | Verified in benchmark | 0 [0–0] of 12 / 0 [0–1] of 8 |

### Application understanding (Phase 2)

| Capability | Status | Evidence |
|---|---|---|
| Screens found | Verified in benchmark | 1 / 1 (target ≥ 0.9) |
| Documented endpoints in the model | Verified in benchmark | 1 / 1, 0 extra |
| Workflows found | Partial | URL input 1 / 1; full input 1 [0.778–1] / 1 [0.875–1] against a target of 1 |
| Pages only a test account reaches | Tested | kept in the model with who reached them; offline re-judge, not yet measured in a paid run: the notes app's People page in the model in 5/5 stored trials (was 0/5) |
| Rules for the seeded bugs stated | Partial | 1 [0.75–1] / 0.75 [0.75–1] against 0.8 |
| Every rule has its source; none confirmed without a person | Verified in benchmark | 100%; 0 auto-confirmed; 0 from observed behaviour |
| Explicit rules that contradict their source | Verified in benchmark | 0 of 444 (0%) in the 10 ladder trials, target ≤ 5%; inferred rules 3 of 81 |
| Re-reading changes only what changed; decisions kept | Verified in benchmark | 5/5 on both apps |

### Exploration (Phase 3)

| Capability | Status | Evidence |
|---|---|---|
| Objectives for every stated rule and workflow | Partial | rules 100%; inferred workflows get no objective in a live run, by decision (the earlier 88.9% / 65–67.5% workflow figures were from an offline scorer) |
| A pursuit signs in as the account that reaches its pages | Tested | offline re-judge, not yet measured in a paid run: 16 pursuits on the notes app's People page now start signed in as admin |
| Bounded loop that stops for a reason | Partial | re-check: stop reason 10/10; shop 0/5, notes 5/5 over the token budget by 0.03–0.29%. Later the loop keeps the largest call so far in reserve (unit tests; not yet measured in a paid run) |
| Finding capture | Verified in benchmark | re-check 88.2% / 92.9% (target ≥ 80%) |
| Replay on a clean app (isolation) | Partial | re-check 46.7% / 30.8% (target ≥ 90%) |
| Evidence on every finding | Partial | re-check 23.5% / 14.3%; mostly the objective missing |
| Coverage record | Verified in benchmark | every field present in 10/10 ladder records; a third app only in an earlier practice-store run |
| Odd-input classes | Partial | exercised 0 times in all 10 ladder records. Offline re-judge, not yet measured in a paid run: constraint goals inside the cap in 8/10 stored trials (was 5/10) |
| Screenshots on exploration findings | Tested | a finding keeps the picture of its own-steps replay where one ran (browser test); not yet measured in a paid run |
| A test written as a newly registered account runs as one again | Tested | unit tests; an offline replay of 145 ladder findings removed 5 false positives, and no seed was lost |

### Checks across layers (Phase 4)

| Capability | Status | Evidence |
|---|---|---|
| Seeded-bug detection, original set | Verified on real applications | re-check 12 [10–12] of 12 / 8 [8–8] of 8; practice store: 6 of 6 seeded bugs Confirmed (one trial) |
| Seeded-bug detection, extension set | Verified in benchmark | re-check 11 [10–11] of 11 (target ≥ 9) |
| Two-account access checks | Verified on real applications | every access seed 5/5; practice store: the admin API and another person's note Confirmed |
| Multi-step API flows (state changes) | Verified on real applications | BS-05 4/5; practice store: cancelling a shipped order Confirmed |
| Each fixed-rule seed caught in ≥ 4 of 5 trials | Verified in benchmark | re-check: BR-10 5/5, BS-05 4/5, every other 5/5 |
| Calculation and relation checks (invariants) | Verified in benchmark | re-check: BS-01 4/5, BS-02 5/5, BS-11 4/5, BS-13 4/5, BS-14 5/5. A value's letter case now comes from the API document (tests) |
| Displayed-value check | Partial | in the ladder BS-13 was always found by AI-written page tests, never by this check; not re-analysed in the re-check |
| Read-only database checks | Verified in benchmark | re-check: BS-06, BS-17, BS-18, BR-11 5/5 each through a database check. Later, unsourced whole-table key checks run last again and a documented 409's duplicate check keeps its source and place (tests). Those whole-table checks can still fail on rows other tests write at the same time |
| Response schema checks (built-in checker, no ajv) | Tested | schema tests green; no ajv by decision |
| Request caps and the risky-write gate | Verified in benchmark | caps kept; gate-off trials: 0 risky writes |
| Layer report in every trial | Verified in benchmark | 10/10 |
| No credentials in stored tests | Verified in benchmark | re-check: 0 in 10/10 trials, 0 off-origin test targets |
| Full evidence on layer findings | Partial | re-check: requests 91% / 51%, disagreeing layers 8% / 0% |
| Added cost and time | Verified in benchmark | re-check: cost 0.79× / 1.29× (≤ 1.3×), time 1.11× / 1.24× (≤ 1.4×); AI calls not counted |

### Verification (Phase 5)

| Capability | Status | Evidence |
|---|---|---|
| A reported defect whose own check is at fault is not reported | Tested | unit and end-to-end tests. Offline re-judge, not yet measured in a paid run: false positives 74 → 48 over the 10 re-check trials, 0 true positives held back over 59 stored trials |
| Replays before "Confirmed"; Confirmed findings are real | Verified in benchmark | re-check 100% [89.5–100] / 94.1% [86.7–100] (target ≥ 90%, each trial ≥ 80%); practice store 8 of 10 |
| Real bugs reach "Confirmed" | Partial | re-check 64.5% / 87.0% (target ≥ 80%). Verification now reads a finding's expectation from the attempts it judges; offline re-judge, not yet measured in a paid run: shop 77.4% |
| Every finding in a named state with a reason | Verified in benchmark | 100% |
| False alarms classed "not an app bug" | Partial | re-check 62.5% / 66.7% (target ≥ 80%); labelled set 78.0% |
| Duplicates grouped, never mixed | Verified in benchmark | 0 mixed groups, 1 group per bug |
| "Confirmed" only at high confidence | Verified in benchmark | 0 below high |
| Cause at the right function, none invented | Verified in benchmark | re-check 93.8% / 80.0% (target ≥ 60%), 0 invented |
| 13-field report on every Confirmed finding | Verified on real applications | 100%; 10 Confirmed reports on the practice store |
| No secret test values in evidence | Tested | 0 canary values over 7 kinds |
| A fresh reviewer reproduces from the report | Verified in benchmark | 10/10 (8 from the report alone; target ≥ 8 of 10) |
| Added cost and time | Verified in benchmark | re-check: cost +1.7% / +0.8%, time +11.7% / +10.6% |
| Check the fix | Tested | a button on a finding with a saved test queues a check of its test; the finding is Fixed only when every attempt passes, and the check has its own run page with its verdict. Tests green |
| A fresh run tag in the replays made when a finding is found | Not implemented | built and held out by a decision of 2026-11-28: in an offline re-judge it Confirmed 7 more false alarms (`QUALITY_GAPS.md` section 6) |

### Change-aware testing and triggers (Phase 6)

| Capability | Status | Evidence |
|---|---|---|
| Tests a pull request reaches, with a reason each | Verified in benchmark | recall 100% in all 5 repeats; 11.1% of tests, 33.3% of time |
| Unmapped change or decoy → full run | Verified in benchmark | both cases |
| Full suite from the pull-request view; fixed-bug regression; history | Verified in benchmark | 36/36, 29/29; 31/31, 0 wrong; history exact |
| Webhook and token security | Tested | tests green |
| AI calls per pull request | Verified in benchmark | 0 |
| A real pull request | Partial | recommends a full run, for valid reasons (failing and unmapped tests); offline replay would focus 72 of 261 tests |
| A deploy token runs a chosen agent (AI agent projects) | Tested | the token names its agent; the pipeline call starts that agent's run; a focused run is refused; a pull request offers "Run the agent". An old token with no agent says how to make a new one. Tests green |
| GitHub App installation, GitLab and Bitbucket | Not implemented | out of scope; fine-grained token only |

### Evaluation and readiness (Phase 7)

| Capability | Status | Evidence |
|---|---|---|
| 5-rung benchmark ladder | Verified in benchmark | 50/50 trials; final build beats the original on both apps |
| Paid re-check of the final rung after the fixes | Verified in benchmark | 10/10 trials on `33a3916d`; seven more targets met (L4, L5, L6, L7, L8, L12, V1) |
| Every miss and false positive explained | Verified in benchmark | ladder: 9 misses, 120 false positives (2 attributions corrected by hand); re-check: 5 misses, 74 false positives |
| Reliability and security checks | Tested | 11/11 items with a passing test or probe, 0 open high-severity |
| Speed and cost optimisation pass | Not implemented | only cost and time per trial measured |
| Failure reasons on agent cards | Tested | the Workspace card and the agent's Outcome tab show the same reason as the run page; tests green |
| New-user journey | Tested | second fresh review 7 of 8 steps; after the fixes, a re-walk of steps 7 and 8 by the developer who made them completed 8 of 8, not yet a fresh reviewer |
