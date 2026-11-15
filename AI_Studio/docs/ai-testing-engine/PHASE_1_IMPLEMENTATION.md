# Phase 1 implementation

Status: **in progress** (plan approved by the phase prompt; paid benchmark runs wait for a cost approval). This document is the plan
first and becomes the implementation record as work lands.

## 1. Audit re-check (only what affects Phase 1)

| Phase 0 claim | Re-checked | Result |
|---|---|---|
| Authoring keeps an assertion only when it passes live | `engine/web/author.ts:351-355` | Holds. A failed `assert` returns an error to the model and is not recorded. |
| Web repair has no weakening guard; API repair has `weakensApiTest` | `engine/validation/repair.ts:151,167` | Holds. |
| Crawler never submits forms | `engine/discovery/crawler.ts:310` (`UNSAFE_NAME`) | Holds. |
| API boundary tests only assert "no 5xx" | `engine/api/test-specs.ts:256-272` | Holds. |
| Security assessments are always created `passive` | `security/store.ts:641` literal, start body accepts only `retestOf` (`security/routes/assessments.ts:111`) | Holds. |
| Security findings have fingerprint, sightings, history | `security/findings/*`, `security/store.ts` | Holds. |
| Evaluation harness measures stability and coverage, not defects | `src/eval/metrics.ts`, `harness.ts`, `platform/eval-store.ts`, `routes/eval.ts`, `web/src/features/eval/QualityPanel.tsx` | Holds; the harness drives the real platform API (explore, plan, create, rerun) and stores runs. This is the benchmark's base. |

Discrepancies that change the plan:
- **No Prisma in AI Studio.** The phase prompt mentions a Prisma schema; Prisma is used only by the separate Crowd4Test API (`../api`).
  AI Studio has its own ordered migration slots (`platform/db.ts`, each store owns its SQL, portable subset, `pg/baseline.sql` kept in
  step). New tables follow that convention.
- **AI keys changed after Phase 0** (uncommitted at the time of writing): projects no longer choose an AI configuration; each
  person has one chosen key (organisational or personal). The benchmark records the model through the same job usage rows, unaffected.
- **Production has no full exploration on record with the production model** (largest job: 9 calls), so the cost estimate is derived
  from the engine's limits and must be calibrated with one small capped run.

## 2. Smallest plan

1. **Benchmark applications** (`examples/bench-shop`, `examples/bench-rbac`): dependency-free Node servers like the other fixtures,
   in-memory data, deterministic reset on start and through a guarded reset route, each seeded defect a switch
   (`BENCH_DEFECTS=none|all|<ids>`). No defect ID, catalogue text or hint in anything the application serves.
2. **Defect catalogue** (`src/eval/bench/catalogue.json`, versioned): ID, application, workflow, category, expected, actual, preconditions,
   reproduction steps, verification procedure, severity, detectable-with-current-infrastructure. Read only by the benchmark controller.
   Each defect has an automated independent verifier (proves present when switched on, absent when off).
3. **Benchmark controller** (extends `src/eval`): for each application, start the seeded variant on a local port, run the existing pipeline
   through the platform API exactly as the harness does (explore, plan, create from plan), collect every positive finding the platform
   reported (tests in review as a defect, failed validations classified as application defects, check-family findings), then attribute
   each finding by **deterministic replay** of its test against the clean variant and against single-defect variants (no model calls):
   a finding attributable to defect D fails with D on and passes with all off. A finding that cannot be attributed is a false positive.
   Secondary "regression" measurement (optional, costs a second exploration): explore the clean variant, then run the created tests
   against the seeded variant.
4. **Metrics** (pure functions, unit-tested): detection rate, precision, false-positive rate, reproduction rate, detection time, cost per
   confirmed defect, plus counts (tests, workflow coverage, execution failures, flaky). Definitions in `BENCHMARK_METHODOLOGY.md`.
5. **Recording**: provider, model id, routing (fast/strong models), prompt identifiers (hash of the prompt sources), engine commit,
   application and catalogue versions, all execution settings, raw results; the baseline is written once to an immutable file
   (content hash recorded) and stored through the existing evaluation run store, extended with the defect metrics.
6. **Report**: the existing Quality panel gains a benchmark section (one table per run, comparison with the previous run, links to the
   findings and evidence). No new navigation.
7. **Cost visibility and limits**: the existing job token limit (`AI_JOB_TOKEN_LIMIT`) and usage rows; the controller prints a pre-run
   estimate and refuses to start a paid run without an explicit `--approved-budget-usd` flag; it stops when the recorded estimate passes it.
8. **Intelligence foundation** (additive, not wired into generation): versioned application model with pages, workflows, entities,
   relationships, business rules with source, evidence, explicit/inferred, confidence and validation status; scenario expectation
   source fields (optional). One store, JSON for variable structure, relational columns for what is queried.
9. **Test-quality model**: deterministic scorer over the ten dimensions from stored specs, executions and fault-replay results; no
   model-generated scores. Kept separate from detection metrics.

Order: 1-7 first; the baseline (paid) runs **before** any generation or repair change and after the cost approval; 8-9 are additive and
proven not to change generation output.

## 3. Expected changes

| Area | Change |
|---|---|
| Database | One migration slot for the intelligence store (application model versions, rules); the evaluation run schema gains benchmark fields (JSON + a few columns); `pg/baseline.sql` kept in step |
| API | Evaluation run route accepts the benchmark fields; read routes for model versions and rules (platform admins / project editors as today's eval and project routes) |
| Runner | None (benchmark runs on the developer machine or CI against local fixtures; a runner is not required) |
| Frontend | Benchmark section in the existing Quality panel |
| Engine | None before the baseline. After: optional scenario expectation-source fields (schema only) |

## 4. Implementation record

(Filled in as work lands: files, decisions, tests.)
