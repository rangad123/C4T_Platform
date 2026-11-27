# AI testing engine: final architecture

What the engine is after Phases 1–7, how its parts fit together, and the status of each capability. Measured numbers are in
`BENCHMARK_RESULTS.md`, open problems in `QUALITY_GAPS.md`, and what this means for use in `PRODUCTION_READINESS.md`.

The measured build is `3cf5bd04` (the paid benchmark ladder, model `claude-haiku-5-5`). Fixes made after the ladder are live in
`7d66fc10` and `33a3916d`; where a capability changed after the ladder, its row says so.

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
  → candidate findings, with steps and evidence
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
| Benchmark | Two practice apps with switchable seeded bugs (20 original, 11 extension), a catalogue with a checker per bug, the trial runner, metrics, spend limits, the ladder, miss analysis | `eval/bench/catalogue.json`, `catalogue-extension.json`, `controller.ts`, `metrics.ts`, `ladder.ts`, `miss-analysis.ts`; apps in `../examples/bench-shop`, `../examples/bench-rbac` |
| Application understanding | Reads pages, API documents and requirements into one model; rules carry source, evidence, explicitness and confidence; re-reads only what changed | `engine/understanding/`, `engine/requirements/`, `platform/app-intel-store.ts` |
| Exploration | Objectives from rules and workflows, a bounded loop, odd-input classes, perturbed step orders, a coverage record | `engine/explore/` (`objectives.ts`, `loop.ts`, `input-classes.ts`, `perturb.ts`, `coverage.ts`) |
| Checks across layers | API answers against the document, documented error cases, two-account access, multi-step API flows, double submits, invariants, read-back, read-only database checks, a risky-checks gate, a layer report | `engine/api/`, `engine/identity/`, `engine/database/`, `engine/security/functional.ts`, `engine/validation/` (`layers.ts`, `invariants.ts`, `risky.ts`, `validator.ts`) |
| Findings and verification | One findings list, lifecycle states, replays, classification, grouping, cause from code, masking, the report | `platform/candidate-finding-store.ts`, `engine/findings/`, `platform/findings/` (`verify-service.ts`, `report-facts.ts`, `regression-service.ts`), `engine/evidence/` |
| Change-aware testing | Connects a GitHub repository (fine-grained token), reads a pull request, maps tests to pages and endpoints, proposes the tests it reaches | `platform/code-host/`, `engine/impact/` |

## Capabilities and status

Numbers are shop / notes app (BenchShop / BenchNotes), median [range] over 5 paid trials on `3cf5bd04`, unless the row says otherwise.

### Foundation (Phase 1)

| Capability | Status | Evidence |
|---|---|---|
| Seeded-defect apps, one switch per bug, a checker per bug | Tested | 31 bugs with checkers; used by all 50 ladder trials |
| Benchmark runner, metrics, spend estimate and limits | Tested | 50/50 ladder trials completed; runs stop at the spend limit |
| Every result records model, prompts and engine build | Tested | model and a build fingerprint in every trial |
| Test-quality score (kept apart from detection) | Implemented | not wired into generation, by design |
| Baseline of the original pipeline | Verified in benchmark | 0 [0–0] of 12 / 0 [0–1] of 8 |

### Application understanding (Phase 2)

| Capability | Status | Evidence |
|---|---|---|
| Screens found | Verified in benchmark | 1 / 1 (target ≥ 0.9) |
| Documented endpoints in the model | Verified in benchmark | 1 / 1, 0 extra |
| Workflows found | Partial | URL input 1 / 1; full input 1 [0.778–1] / 1 [0.875–1] against a target of 1 |
| Rules for the seeded bugs stated | Partial | 1 [0.75–1] / 0.75 [0.75–1] against 0.8 |
| Every rule has its source; none confirmed without a person | Verified in benchmark | 100%; 0 auto-confirmed; 0 from observed behaviour |
| Explicit rules that contradict their source | Verified in benchmark | 0 of 444 (0%) in the 10 ladder trials, target ≤ 5%; inferred rules 3 of 81 |
| Re-reading changes only what changed; decisions kept | Verified in benchmark | 5/5 on both apps |

### Exploration (Phase 3)

| Capability | Status | Evidence |
|---|---|---|
| Objectives for every stated rule and workflow | Partial | rules 100%; workflows 88.9% / 65–67.5% (re-scored offline after a later fix) |
| Bounded loop that stops for a reason | Partial | stop reason 10/10; 7 of 10 trials 0.05–0.34% over the token budget |
| Finding capture | Verified in benchmark | 89.5% / 93.3% (target ≥ 80%) |
| Replay on a clean app (isolation) | Partial | 37.5% / 23.1% (target ≥ 90%) |
| Evidence on every finding | Partial | 22% / 13%; a fix landed later, not re-measured |
| Coverage record | Verified in benchmark | every field present in 10/10 records; a third app only in an earlier practice-store run |
| Odd-input classes | Partial | the field is recorded, but exercised 0 times in all 10 records |
| Screenshots on exploration findings | Not implemented | exploration findings save no screenshots |

### Checks across layers (Phase 4)

| Capability | Status | Evidence |
|---|---|---|
| Seeded-bug detection, original set | Verified on real applications | 11 [10–12] of 12 / 8 [8–8] of 8; practice store: 6 of 6 seeded bugs Confirmed (one trial) |
| Seeded-bug detection, extension set | Verified in benchmark | 10 [9–11] of 11 (target ≥ 9) |
| Two-account access checks | Verified on real applications | every access seed 5/5; practice store: the admin API and another person's note Confirmed |
| Multi-step API flows (state changes) | Verified on real applications | BS-05 4/5; practice store: cancelling a shipped order Confirmed |
| Each fixed-rule seed caught in ≥ 4 of 5 trials | Partial | every seed 5/5 except BS-05 4/5 and BR-10 2/5 (the stored-injection check was filed as a failed test); fixed later, not re-measured |
| Calculation and relation checks (invariants) | Partial | BS-01 1/5, others 3–5/5; fixed later, not re-measured |
| Displayed-value check | Partial | BS-13 3/5, always found by AI-written page tests, never by this check |
| Read-only database checks | Partial | BS-06, BS-18, BR-11 5/5 through a database check; BS-17 0/5 that way; after a later fix a free run gave BS-17 5/5 |
| Response schema checks (built-in checker, no ajv) | Tested | schema tests green; no ajv by decision |
| Request caps and the risky-write gate | Verified in benchmark | caps kept; gate-off trials: 0 risky writes |
| Layer report in every trial | Verified in benchmark | 10/10 |
| No credentials in stored tests | Partial | 1 of 10 trials (a wrong-password test built from the real one); fixed later, not re-measured |
| Full evidence on layer findings | Partial | requests 0%, layers 0%; a fix landed later, not re-measured |
| Added cost and time | Verified in benchmark | cost 0.96× / 1.24× (≤ 1.3×), time 1.27× / 1.27× (≤ 1.4×); AI calls not countable on this build |

### Verification (Phase 5)

| Capability | Status | Evidence |
|---|---|---|
| Replays before "Confirmed"; Confirmed findings are real | Partial | 91.7% / 85.7% (target ≥ 90%, each trial ≥ 80%; one notes trial 66.7%); practice store 8 of 10 |
| Real bugs reach "Confirmed" | Partial | 78.1% / 80.0% (target ≥ 80%) |
| Every finding in a named state with a reason | Verified in benchmark | 100% |
| False alarms classed "not an app bug" | Partial | 53.3% / 45.5% (target ≥ 80%); labelled set 78.0% after a later fix |
| Duplicates grouped, never mixed | Verified in benchmark | 0 mixed groups, 1 group per bug |
| "Confirmed" only at high confidence | Verified in benchmark | 0 below high |
| Cause at the right function, none invented | Verified in benchmark | 86.4% / 75.0% (target ≥ 60%), 0 invented |
| 13-field report on every Confirmed finding | Verified on real applications | 100%; 10 Confirmed reports on the practice store |
| No secret test values in evidence | Tested | 0 canary values over 7 kinds |
| A fresh reviewer reproduces from the report | Verified in benchmark | 10/10 (8 from the report alone; target ≥ 8 of 10) |
| Added cost and time | Verified in benchmark | cost +1.5% / +1.0%, time +11.7% / +10.3% |

### Change-aware testing (Phase 6)

| Capability | Status | Evidence |
|---|---|---|
| Tests a pull request reaches, with a reason each | Verified in benchmark | recall 100% in all 5 repeats; 11.1% of tests, 33.3% of time |
| Unmapped change or decoy → full run | Verified in benchmark | both cases |
| Full suite from the pull-request view; fixed-bug regression; history | Verified in benchmark | 36/36, 29/29; 31/31, 0 wrong; history exact |
| Webhook and token security | Tested | tests green |
| AI calls per pull request | Verified in benchmark | 0 |
| A real pull request | Partial | recommends a full run, for valid reasons (failing and unmapped tests); offline replay would focus 72 of 261 tests |
| GitHub App installation, GitLab and Bitbucket | Not implemented | out of scope; fine-grained token only |

### Evaluation and readiness (Phase 7)

| Capability | Status | Evidence |
|---|---|---|
| 5-rung benchmark ladder | Verified in benchmark | 50/50 trials; final build beats the original on both apps |
| Every miss and false positive explained | Verified in benchmark | 9 misses, 120 false positives (2 attributions corrected by hand) |
| Reliability and security checks | Tested | 11/11 items with a passing test or probe, 0 open high-severity |
| Speed and cost optimisation pass | Not implemented | only cost and time per rung measured |
| New-user journey | Partial | 3 of 8 steps stuck in a fresh review; fixed later, not re-reviewed |
