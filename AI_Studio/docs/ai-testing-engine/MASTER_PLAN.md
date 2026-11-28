# AI testing engine: master plan

## Vision

Make AI Studio find real, previously unknown defects with evidence a developer can act on, and prove it with measurement. The Phase 0
audit (`CURRENT_STATE_AUDIT.md`, `TEST_GENERATION_QUALITY_AUDIT.md`, `CAPABILITY_GAP_ANALYSIS.md`, `EXISTING_INFRASTRUCTURE_MAP.md`)
found that today's generated tests check what the application does when they are written, not what it should do; the
`TARGET_ARCHITECTURE_PROPOSAL.md` separates expectations (with sources) from observations (with evidence).

## Architecture decisions

- No new services, queues or agent frameworks: new job modes, runner explore modes, store files with their own migration slot.
- Deterministic first; the model for judgement on unstructured input. A verdict comes from a check that ran.
- Every expectation has a source; inferred behaviour never silently becomes a verified rule; current behaviour is not proof of correctness.
- Measured by a seeded-defect benchmark; detection metrics are kept apart from test-quality scores.

## Phase status

| Phase | Status |
|---|---|
| 0 Audit | Done (7 documents in this folder) |
| 1 Foundation and baseline benchmark | Done; live in `1a756d77` |
| 2 Application intelligence | Done; live in `5209fc85`, measured build `381b1cb8` |
| 3 Exploratory engine | Done; live in `be712d18` |
| 4 Multi-layer validation | Done; live in `be712d18` |
| 5 Verification, dedupe, root cause | Done; live in `be712d18`, fixes in `3cf5bd04` |
| 6 Change-aware testing | Done; live in `be712d18` |
| 7 Evaluation and readiness | Benchmark ladder measured on `3cf5bd04`; follow-up fixes in `7d66fc10` and `33a3916d`, measured by a paid re-check on `33a3916d` (seven more targets met). Later changes checked offline only, not yet in a paid run. Not met yet: E2, E7, L13, V2 on the shop, V4, E4 on the shop |

## Phase 1 decisions (approved)

- Use the existing production model, provider integration and configuration; no benchmark-only provider; no hard-coded keys or model ids;
  record provider, model id, generation settings and prompt identifiers; never switch models silently on failure.
- No assumed budget: estimate first, ask before paid runs, enforce limits with existing usage tracking.
- Data-changing tests only inside the benchmark applications with isolated, resettable data; nothing changes in the customer pipeline.
- Reuse the platform, database, job queue, AI layer, runner protocol, execution and evaluation harness.

## Decisions

All decisions are in DECISIONS.md (2026-11-14), including the frozen baseline snapshot, the merge rules, the security
authorization policy and the evidence retention defaults.

## Exclusions in Phase 1

Autonomous exploration, general form submission on customer applications, multi-layer validation, property-based and stateful fuzzing,
concurrency testing, full cross-user authorization scanning, findings lifecycle changes, verification/dedupe expansion, root cause,
pull-request selection, change-aware regression, new agents or services, large UI redesigns.
