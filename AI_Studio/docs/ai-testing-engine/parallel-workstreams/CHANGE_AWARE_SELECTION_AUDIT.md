# Workstream 4: change-aware test selection (audit and plan)

Read-only audit, 2026-11-14, against `main` at `7a164a8` with the uncommitted Phase 1 work in the tree (`src/engine/intel/`,
`src/platform/app-intel-store.ts`, `src/platform/routes/app-intel.ts`, `src/eval/*`, `db.ts` slot 62, `pg/baseline.sql` `app_*` tables).
Nothing was run, built or modified apart from this file. Paths are relative to `AI_Studio/src/` unless they start with `AI_Studio/`.

Labels: **Verified** (read in current code), **Partial** (exists but does not do the job), **Missing** (searched for, not found),
**Suspected** (likely from reading, needs reproduction), **Proposed** (this plan).

---

## 0. Summary

- **Verified**: the platform has several deterministic change signals: OpenAPI diff, observed-API drift between runs, the site-memory
  diff of pages, endpoints and journeys, and a commit string on deploy triggers. **None of them chooses or orders tests.** Every automated
  run (deploy trigger, schedule, runbook "all") runs every runnable test.
- **Verified**: the only selection that exists is by hand: test ids, suite, tag or type (runbooks, manual runs).
- **Verified**: the platform can already work out **test → pages** (navigate steps, screen map) and **test → endpoints** (API request
  steps) from stored specs. It also has **test → journey (with priority)**, **test → requirement**, flakiness, per-test history and issue
  links. The **observed** endpoints a test calls are **not kept per test**: API test responses are merged into one snapshot per job, and
  UI network logs are kept only for failing tests.
- **Missing**: any reading of customer source. GitHub is only used to create issues and post PR comments. Git import clones at depth 1,
  one commit, and only reads Playwright test files. Nothing maps changed files to anything.
- **Proposed**: a small, explainable selector with no AI. Change set (endpoints, page patterns, journeys, requirements) → coverage edges
  with provenance → selected tests, each with a reason string. Plus an always-run set, a "coverage unknown, so run it" rule, and full
  regression as the default. Source-file mapping is a later, optional step. It is only worth doing with real evidence (an OpenAPI
  document produced at each commit, or route declarations parsed from the repository), never from filenames alone.

---

## A. What exists today

### A1. GitHub and tracker integrations

| Claim | Label | Evidence |
|---|---|---|
| The GitHub integration creates issues only (`verify`, `createIssue`). It never reads commits, compare, pull request files or check runs | Verified | `platform/issues/github.ts:10-50` `GithubProvider`; kinds limited to `github`, `jira`, `notion` (`platform/issues/types.ts:5`) |
| Jira and Notion are the same: write-only issue creation. Tracker state (fixed, won't fix) is never read back | Verified | `platform/issues/jira.ts`, `platform/issues/store.ts:40-47`; no fetch/status method in the providers |
| The CI CLI can post one sticky PR comment. It reads the PR number from `$GITHUB_EVENT_PATH` but not the PR's changed files or base SHA | Verified | `cli/github-comment.ts:18-58`, `cli/run.ts:234-242`, flags `cli/args.ts:42-47` |
| The CLI has no test-selection flags (no `--changed`, `--tag`, `--suite`) | Verified | `cli/args.ts:14-52` |
| Issue links are stored per test: provider, external id, url, title. No state, no labels, no component | Verified | `issue_links` in `platform/pg/baseline.sql:366-377` |
| Sentry: "related errors" for a failed test, ranked by matching `culprit` (the route or function Sentry blames) against failed request paths. Answers are cached in memory for 10 minutes and never written to disk | Verified | `platform/sentry/related.ts:1-30` (`CACHE_TTL_MS`), `platform/sentry/match.ts:46,165-168` `pathMatch` |

### A2. Commit and branch handling

| Claim | Label | Evidence |
|---|---|---|
| A deploy trigger accepts `commit` (free text up to 80 characters), `environment`, `url` and `callbackUrl`. There is no branch, base commit or changed-file list | Verified | `platform/trigger-services.ts:28-38` `TriggerRunBody` |
| The commit is stored and echoed back, never interpreted | Verified | `trigger_runs.commit_sha` (`platform/trigger-store.ts:24-33`, `addRun` `:153-158`); `JobOptions.deploy` (`platform/repo.ts:124`); response at `platform/routes/triggers.ts:84` |
| A deploy trigger runs **every runnable test** | Verified | `platform/trigger-services.ts:184` `runnableTestIds(repo, projectId, "validate", …)` → `options.testIds` (`:190-199`) |
| A token linked to a runbook runs that runbook's scope (all, ids, suite, tag, type). The commit is shown as a label only | Verified | `platform/runbook-triggers.ts:24-53`; `platform/runbook-runner.ts:58` `StartedBy.deploy.commit`, `:569,582` |
| Git import: shallow clone (`--depth 1 --single-branch`) or a single-commit fetch. It lists the tree with blob ids (`ls-tree -r -l`), reads blobs with `cat-file --batch`, never writes a working tree and never runs a diff | Verified | `engine/gitimport/git-args.ts:39-52`; `platform/git-checkout.ts:28-43` (`TreeEntry.sha`), `:130-160` |
| A git-import refresh compares imported **test files** by content and reports changed or added test files. The line-count "diff" is a multiset count for display | Verified | `platform/git-import-service.ts:318-340` `check`; `engine/gitimport/provenance.ts:21-34` `summarizeDiff` |
| Test provenance keeps host, path, ref, commit and file for imported tests only | Verified | `engine/gitimport/provenance.ts:3-18` |

### A3. Changed-file detection and source analysis

| Claim | Label | Evidence |
|---|---|---|
| No code path computes changed files of the customer application between two commits | Missing | No `diff`/`log`/`compare` git arguments in `engine/gitimport/git-args.ts`; no GitHub compare call in `platform/issues/github.ts` |
| Source analysis exists only for imported test files. The TypeScript parser extracts each file's imports so disallowed modules can be refused | Partial (not usable for selection) | `engine/gitimport/files.ts:86` `scanTestFile`, `:131-145` `importProblems` |
| The primitives for a cheap, safe "changed files between A and B" exist: two depth-1 checkouts give two `TreeEntry[]` lists with blob SHAs, and comparing them gives added, removed and modified paths with no history | Verified (primitive), Proposed (use) | `platform/git-checkout.ts:28-43`, `GitSession.withCheckout` |
| The Phase 1 intelligence model names `source_code` as a source type and allows `file` evidence, but nothing fills it | Verified (types only) | `engine/intel/model.ts:16,30`; not imported by the pipeline (`PHASE_1_IMPLEMENTATION.md` §2 item 8) |

### A4. Black-box change detection (what the platform observes)

| Signal | Label | Evidence | Drives selection? |
|---|---|---|---|
| **Site-memory diff**: pages added, removed or changed (by structural fingerprint), endpoints added or removed, journeys no longer validating | Verified | `engine/memory/diff.ts:19-59` `diffKnowledge` (pure, deterministic); emitted as event `memory_changes` at `engine/memory/session.ts:121-124`; stored in `site_memory.changes_json` (`platform/memory-store.ts:19,42-52`) | No |
| The memory diff is produced only by **analysis (generation) jobs**, not validate runs. `site_memory` keeps only the latest row per origin (upsert), so there is no history of diffs | Verified | `engine/orchestrator.ts:466` (`openMemory` in `runWebAndApiGeneration`); `platform/memory-store.ts:50-51` `ON CONFLICT … DO UPDATE` | No |
| **Exploration reuse** skips sending unchanged pages to the model | Verified | `engine/memory/reuse.ts`; `ufp` in `engine/memory/types.ts:36-41` | Affects AI calls, not tests |
| **OpenAPI diff** of two documents: breaking and non-breaking changes per operation (`GET /users/{}`) | Verified | `engine/contracts/diff.ts:124` `diffOpenApi`; route `POST /api/projects/:id/api-diff` (`platform/routes/contracts.ts:38`) | No |
| **Observed API drift**: per-job snapshot of statuses and response shapes per operation, last 20 kept, diff between snapshots | Verified | `platform/drift-store.ts:7-21,46-64` `recordObservations`, `:87-100` `apiChanges`; `engine/contracts/drift.ts:258` `diffSnapshots`; route `GET /api/projects/:id/api-changes` (`platform/routes/contracts.ts:50`) | No |
| A drift snapshot from a run of only **some** API tests is marked `complete = 0`, so a missing operation proves nothing | Verified | `platform/drift-store.ts:31-39` `coversAllApiTests` | Relevant: selective runs weaken drift (see D4) |
| **Phase 1 model diff** (pages and workflows added or removed between model versions) | Verified (code), Missing (data) | `engine/intel/model.ts:155-174` `diffModels`; `app_model_versions.diff_json` (`platform/app-intel-store.ts:14-26`); not populated | No |

### A5. Test-to-module (test → surface) relationships

| Relationship | Label | Evidence |
|---|---|---|
| Test → pages it **declares**: `navigate` steps (`url`) | Verified | `engine/spec/schema.ts:290` |
| Test → screens and transitions: `coverWithTests` walks navigate, click and url-assert steps over the screen map. The map is built during analysis and saved inside the app model (`applications.app_model_json`) | Verified | `engine/screenmap/map.ts:216-246`; built at `engine/orchestrator.ts:448`, covered at `:938-941`; saved by `platform/repo-sink.ts:65` → `platform/repo.ts:446` |
| `startPath` exists on the **Scenario** (plan), not on the stored `TestSpec`. A test's first page comes from its first `navigate` step | Verified | `engine/spec/schema.ts:553` (Scenario) vs `:507-541` (TestSpec) |
| Test → endpoints it **declares**: API `request` steps (`method`, `path`) | Verified | `engine/spec/schema.ts:409-420` |
| Test → endpoints it **called** (API tests): the generated script attaches `responses` (method, path, status). The runner returns them in `ScriptRun.responses` | Verified | `engine/generators/api.ts:32-36`; `engine/validation/runner.ts:89,751` |
| …but they are **not stored per test execution**. `recordExecution` folds them into the job-wide `api_snapshots` row, and `test_executions` has no endpoint column | Verified (gap) | `platform/repo-sink.ts:164-180`; `test_executions` columns at `platform/pg/baseline.sql:192-207` |
| Test → endpoints it **called** (UI tests): the evidence recorder logs every request (method, path, status, step) but attaches it only when the test fails, unless `AITP_EVIDENCE=always`. It is capped at 300 requests, with successful ones dropped first | Verified (gap) | `engine/evidence/capture.ts:24-29,181-215,273-276`; switch passed at `engine/validation/runner.ts:519-520` |
| Test → journey: `spec.source.journey` is set by web authoring. Memory journeys carry `priority` (critical, high, medium, low) and `pages` | Verified | `engine/web/author.ts:734-739`; `engine/memory/types.ts:46-56` |
| Test → requirement: `requirement_links` (many to many). Requirements have `priority` and `updated_at`. Specs also carry `source.requirements` | Verified | `platform/pg/baseline.sql:1350-1363` (links), `:602-618` (requirements); `engine/spec/schema.ts:536-537`; coverage `platform/requirement-store.ts:8-10` |
| Test → own priority, type, suite, tags | Verified | `test_cases.priority`, `spec.tags` (`platform/pg/baseline.sql:126-146`; `engine/spec/schema.ts:521-530`) |
| Test → workflow (Phase 1): `ScenarioSchema.covers {pages, endpoints, rules}` + `testCaseId`; `WorkflowStepSchema {page, endpoint}` | Verified (types), Missing (data) | `engine/intel/model.ts:78-90,121-136` |
| Test → source module | Missing | nothing |

### A6. Execution, failure and defect history

| Claim | Label | Evidence |
|---|---|---|
| Per-execution history: status, attempt, script, job, environment, variant, test version | Verified | `test_executions` (`platform/pg/baseline.sql:192-211`) |
| Run summaries per job with per-test results and a diff against what was known before (newly failing, fixed, still failing, flaky passes). A smaller run does not erase one test's history | Verified | `platform/trends.ts:93-125` `collectResults`, `:127-133` `knownBefore`, `:141-158` `diffRuns`; `run_summaries` (`platform/pg/baseline.sql:333-352`) |
| Flakiness: flips, flip rate and flaky passes per test over a window | Verified | `platform/trends.ts:385` `detectFlaky`; `engine/quarantine/rules.ts:88-93` `FlakyEvidence` |
| Last 20 executions of the current script per test | Verified | `platform/quarantine-store.ts:120-146` `recentExecutions` |
| Quarantine gate (quarantined tests do not fail a run); check-family and consistently failing tests are never eligible | Verified | `platform/quarantine-store.ts:148`; `engine/quarantine/rules.ts:62,106,130-139` |
| A commit can be joined to results: `trigger_runs.job_id` → `test_executions.job_id`. `run_summaries` itself has no commit column | Verified | `platform/trigger-store.ts:24-33`; `platform/pg/baseline.sql:333-352` |
| Security findings with identity across runs (`fingerprint`), `location` (URL or path), first and last seen, sightings | Verified | `security_findings` (`platform/pg/baseline.sql:1231-1261`), `security_finding_sightings` (`:1276`) |
| History is not used to choose or order tests anywhere | Verified (gap) | no reader of `detectFlaky`, `issue_links` or `run_summaries` in `runbook-runner.ts`, `trigger-services.ts`, `scheduler.ts` |

### A7. Application and workflow relationships

| Claim | Label | Evidence |
|---|---|---|
| Journeys (name, priority, pages, validated scenario titles) in site memory | Verified | `engine/memory/types.ts:46-56` |
| Screen map (screens as URL patterns, transitions, which are covered) | Verified | `engine/screenmap/map.ts:29-84,161,294` |
| Phase 1 workflows, entities, relationships and rules with evidence: schema and store exist, generation does not fill them yet. `WorkflowSchema` has **no priority or criticality field** | Verified | `engine/intel/model.ts:80-90`; `platform/app-intel-store.ts` |

### A8. Selection today

| Path | What it selects | Evidence |
|---|---|---|
| Deploy trigger (plain) | all runnable tests | `platform/trigger-services.ts:184` |
| Runbook "run tests" step | `all`, or test ids, suite, tag, type, intersected with runnable, minus load checks and (optionally) mobile | `platform/runbook-runner.ts:156-180` `selectTests` |
| Manual run | chosen test ids | `platform/routes/runs.ts:20,39-62` |
| CI validation route | every executable non-mobile, non-desktop test | `platform/routes/integrations.ts:200-228` |
| Schedules | through runbooks or all runnable tests | `platform/scheduler.ts:43` `runnableTestIds` |

---

## B. Proposed deterministic mapping

### B1. Principle

The chain asked for, `changed files → modules → APIs/workflows → tests`, has a **black-box middle** that the platform can
already observe without customer source:

```
change signal  ──►  changed surface items  ──►  coverage edges (with provenance)  ──►  tests
(commit, OpenAPI,     endpoint "POST /orders",     test T touches item I because …        selected + reason
 drift, memory,       screen "/orders/{id}",
 requirement edit,    journey "Checkout",
 optional repo)       requirement "REQ-12"
```

Every edge has a provenance. The selector uses only edges that carry evidence: **declared** (in the stored spec), **observed** (seen
during an execution), **linked** (a person or import linked it), **modelled** (Phase 1 model with `sourceType`). No edge is inferred from
a filename or a title. (Proposed)

### B2. Surface items (keys are normalised the same way everywhere)

| Item | Key | Normaliser that already exists | Label |
|---|---|---|---|
| Endpoint | `METHOD /path/{}` | `engine/contracts/drift.ts:175-190` `templatePath`, `operationKey`; `engine/contracts/diff.ts:33` `template` | Verified (normaliser) |
| Screen | URL pattern (`/course/{slug}`) | `engine/discovery/crawler.ts` `urlPattern`; `engine/screenmap/map.ts` `ScreenIndex` | Verified (normaliser) |
| Journey | lower-cased trimmed name | `engine/memory/diff.ts:12` `jkey` | Verified |
| Requirement | `ref_key` | `requirements.ref_key` (`platform/pg/baseline.sql:606,618`) | Verified |
| Workflow (Phase 1) | `Workflow.id` | `engine/intel/model.ts:80` | Verified (types) |

Both sides of the drift and OpenAPI diffs already use the same operation key (`GET /users/{}`), so endpoint changes and test endpoints can
be joined without new logic. **Suspected**: `diff.ts` `template` gives `{}` for every parameter, and `drift.ts` `templatePath` also
templates numeric and id-like segments. A path written as `/users/42` in a request step and `/users/{id}` in OpenAPI should meet, but this
needs a unit test before anyone relies on it.

### B3. Change signals → changed items (no customer source)

| Signal | Produces | Available when | Label |
|---|---|---|---|
| OpenAPI diff (old vs new document) | endpoints changed, flagged breaking | the pipeline sends the new document, or a stored API document changed (`security_api_documents`, project API spec) | Verified (diff), Proposed (wire) |
| Drift diff between the last two complete snapshots | endpoints whose status set or response shape changed, or that appeared or disappeared | after a run that includes API tests | Verified (diff), Proposed (wire) |
| Site-memory diff | screens changed (fingerprint), screens added or removed, endpoints added or removed, journeys no longer validating | after an analysis job only | Verified (diff), Proposed (wire) |
| Requirement edits since the last run | requirements whose `updated_at` > last run of the linked test | always | Proposed |
| Pipeline-supplied hints in the trigger body (`changes: { endpoints?: string[], paths?: string[] }`) | endpoints or screens the customer says changed | when the customer's CI knows them (for example from its own route manifest) | Proposed |
| Commit alone (`commit` in the trigger) | nothing by itself. It is a key for joining history and for a later repository connection | always (already stored) | Verified (stored) |

Note: for a **deploy-triggered** run, most of these signals are measured by the run itself (drift comes from this run, memory needs an
analysis). The first version therefore selects from **signals known before the run**: the last analysis diff not yet acted on, OpenAPI or
pipeline hints, requirement edits and history. It then **checks** after the run: if this run's drift shows an endpoint change that no
selected test covered, it says so and offers the tests that cover it (Proposed, "post-run widening"). This is honest about what a
black-box platform can know before running.

### B4. Coverage edges (test → item)

| Edge | Source | Provenance | Cost | Label |
|---|---|---|---|---|
| test → endpoint | `request` steps of the stored spec | declared | pure function over `spec_json` | Proposed (data Verified) |
| test → screen | `navigate` steps + url asserts, mapped through the saved screen map (`coverWithTests` logic, made to return per-test keys instead of a count) | declared | pure | Proposed (logic Verified at `screenmap/map.ts:216`) |
| test → endpoint (API tests) | `ScriptRun.responses` per execution | observed | needs a per-execution store (new table, so a migration) | Proposed |
| test → endpoint (UI tests) | evidence requests per execution (same-origin XHR/fetch only, templated) | observed | needs the network log for passing runs (evidence workstream) plus the same store | Proposed, depends on WS3 |
| test → journey | `spec.source.journey` | declared | pure | Proposed (data Verified) |
| test → requirement | `requirement_links` + `spec.source.requirements` | linked | read | Proposed (data Verified) |
| test → workflow / page / endpoint (Phase 1) | `Scenario.covers` + `testCaseId` | modelled (`sourceType`) | read, once Phase 1 fills it | Proposed, depends on Phase 1 |

Observed edges are the strongest evidence for UI tests: a checkout test that never names `POST /orders` in its steps still calls it.
Without them, UI tests reach endpoints only through screens and journeys. That is why the per-execution endpoint set is the one data
addition this workstream really needs. (Proposed)

Edges age out: an observed edge counts only while the test's current script (`generated_scripts.content_hash`, as in
`recentExecutions`) has executed since the edge was recorded. A test whose script changed with no new execution has **unknown coverage**.
(Proposed)

### B5. Optional repository connection: what it would add, and when it is needed

Customer source is usually not available. Where a customer connects a repository, the only additions worth building are those backed by
evidence:

1. **Changed files between two commits**: compare the `ls-tree` blob ids of two depth-1 checkouts (both commits are already accepted
   inputs: the trigger `commit` and the previous trigger's `commit`). No history download, and the existing safety (no hooks, no working
   tree, size caps) is reused. (Proposed, primitives Verified)
2. **Changed files → endpoints, only through one of**:
   - an **OpenAPI document generated in the customer's build at each commit** (sent with the trigger or stored in the repository at a
     known path). The OpenAPI diff then gives the changed endpoints directly, and file names are not used at all. **Recommended first**;
   - **route declarations parsed from source** (for example Express `app.get('/x', handler)` or a router table) with the TypeScript
     parser already used in `engine/gitimport/files.ts`, plus the import graph from changed module → route file. This is real evidence (a
     call that registers a path), but it depends on the framework and is a later enhancement. Framework file-system routing (for example
     a `pages/` directory) is a convention declared by the framework, so it may be used only when the project explicitly names its
     framework. It must never be guessed from a filename. (Proposed, later)
3. **Changed files → tests directly**: only for **imported** Playwright tests, whose own files changed. This is already detected by
   `GitImportService.check` (`platform/git-import-service.ts:318-340`). (Verified)

**Not proposed**: an AI-built dependency graph of the customer's code. Nothing in the black-box chain needs it. The endpoint and screen
items above are already what tests touch, and an AI graph cannot be explained or verified per edge. It would be justified only if, after
B4 ships, measured misses (post-run widening finds changes no selected test covered) show that black-box signals are not enough.
(Proposed decision)

---

## C. Prioritisation: minimal, explainable, full regression always available

### C1. Inputs (all already stored or derivable; new items marked)

| Factor | Source | Label |
|---|---|---|
| Changed impact | B3 change set ∩ B4 edges | Proposed |
| Workflow criticality | memory journey `priority`; requirement `priority`; test `priority` (Phase 1 workflows have no priority field) | Verified data |
| API dependencies | test → endpoint edges; breaking flag from OpenAPI or drift | Verified data / Proposed edges |
| Historical failures | latest result and fails in the last 20 executions (`recentExecutions`), newly failing (`diffRuns`) | Verified |
| Historical defects | open `issue_links` on the test; security findings whose `location` matches a covered item; Sentry culprit match (in memory only) | Verified data, Partial (no tracker state) |
| Reliability | `detectFlaky` flip rate; quarantine gate | Verified |
| Existing coverage | changed items with no covering test → reported as uncovered (and suggested for exploration), not hidden | Proposed |

### C2. Algorithm (deterministic, integer weights, ties by test key)

```
mode = request.select ?? "all"                       # default: full regression, exactly as today
if mode == "all": run runnableTestIds (unchanged path), record reasons = "full regression"
pool = runnableTestIds(...)  (same filter as today: adapters, device, load checks, switched-off frameworks)
change = changeSet(signals)                           # items with kind, key, breaking?, source
if change is empty or stale(coverage) -> fall back to "all", reason "no usable change information"

for t in pool:
  hits = edges(t) ∩ change                            # each hit keeps its provenance
  must = []
  if hits:                              must += "touches changed " + describe(hits)
  if coverageUnknown(t):                must += "coverage unknown (script changed since its last run)"
  if lastResult(t) in {failed, needs review}: must += "failed last run"
  if t in alwaysRun:                    must += "always run: critical journey / critical priority"   # small smoke set
  selected = must nonempty
  score = 5*observedEndpointHits + 4*declaredEndpointHits + 3*breakingHits + 3*screenHits
        + 3*journeyHits + 2*requirementHits
        + crit(t)        (critical 3, high 2, medium 1, low 0; max of test, journey, requirement)
        + min(3, failsInLast20(t)) + (openIssue(t) ? 1 : 0)
        - (flaky(t) ? 2 : 0)                          # flaky runs later; it still runs; quarantine gating unchanged
order selected by score desc, then test key
uncovered = change items with no edge from any test  -> listed in the run, "suggest exploring /orders/{id}"
```

Rules:
- `alwaysRun` = tests with `priority = critical` or on a journey with `priority = critical`, capped (for example 20, by score). Proposed.
- The flaky penalty changes **order only**. Selection is never reduced because a test is flaky. Quarantine semantics stay as in
  `quarantine-store.ts:148`.
- No probabilistic model, no AI call, no learned weights in v1. The weights are constants in one file, covered by unit tests.

### C3. Reason strings (stored with the job, shown on the run page)

One sentence per selected test, built from the hits. Examples (Proposed):

- `Selected: calls POST /orders/{} (seen in its last run), which changed in the API description (breaking: field "total" removed).`
- `Selected: opens /checkout, whose page structure changed since the last analysis; on the critical journey "Checkout".`
- `Selected: linked to REQ-12, edited after this test last ran.`
- `Selected: failed on its last run.` / `Selected: its script changed since its last run, so what it covers is unknown.`
- `Not selected: touches none of the 3 changed items (it covers GET /profile, /settings).` (listed in a collapsed "not run" section)

### C4. Full regression

- **Default stays "all"** for triggers, schedules, runbooks, manual runs and the CLI. Change-aware selection is opt-in per trigger call
  (`select: "impacted"`), per runbook step (`scope: { impacted: true }`), or per CLI flag. (Proposed)
- Automatic fallback to all: no change information, coverage map older than a configurable age, more than N% of tests with unknown
  coverage, or a selected set larger than (for example) 70% of the pool. (Proposed)
- Recommended practice, shown in the UI: a scheduled full run at least daily. It also keeps API drift snapshots `complete`
  (`drift-store.ts:31-39`). (Proposed)

---

## D. Implementation plan

Small steps, each shippable alone. Steps 1 to 5 need no migration and do not change any existing run.

| # | Step | Files (new unless marked) | Acceptance criteria |
|---|---|---|---|
| 1 | **Static coverage extractor** (pure): `coverageOf(spec, screenIndex?) → {endpoints[], screens[], journey?, requirements[]}` with provenance `declared` | `engine/selection/coverage.ts`; reuse `contracts/drift.ts` `operationKey`, `screenmap/map.ts` (export a per-test variant of `coverWithTests`; leave the existing function unchanged) | Unit tests: API spec → `POST /orders/{}`; web spec with navigate + click → screen keys; `/users/42` and `/users/{id}` give the same key (settles the B2 suspicion); no I/O; `screenmap/map.ts` existing tests still pass |
| 2 | **Selector** (pure): `select(pool, edges, change, facts, opts) → {mode, selected[{testId, score, reasons[]}], notSelected[], uncovered[], fallback?}` | `engine/selection/select.ts` | Unit tests for each rule in C2: empty change → fallback all; unknown coverage → selected; flaky only changes order; deterministic order; every selected test has at least one reason; a test with no hits and known coverage is not selected |
| 3 | **Facts adapter** (read-only): last result, fails in 20, flaky, open issue links, quarantine, requirement `updated_at` vs last run, latest memory `changes_json`, latest `apiChanges` | `platform/selection-facts.ts` (reads `trends.ts`, `quarantine-store.ts`, `memory-store.ts`, `drift-store.ts`, `requirement-store.ts`; no writes) | Integration test on a seeded DB: facts match hand-computed values; no table written |
| 4 | **Preview route**: `POST /api/projects/:id/selection/preview` body `{changes?, openapi?, since?}` → the selector output; nothing queued | `platform/routes/selection.ts`; one line in `platform/routes/index.ts`; permission in `platform/auth/roles.ts` | Same access as runs; returns reasons; with no input returns `mode: all`; no job row is created |
| 5 | **Opt-in on runs**: `TriggerRunBody.select` + `changes`; runbook `scope.impacted`; CLI `--select impacted`. The selection (reasons, uncovered, fallback) is saved in `JobOptions.selection` (JSON in `options_json`, no schema change) | `platform/trigger-services.ts`, `platform/runbook-runner.ts` (`selectTests`), runbook schema, `cli/args.ts`, `cli/run.ts` | Without the new fields, `testIds` is byte-identical to today (regression test on both paths); with `impacted`, `testIds` = selector output; callback and status include `selection.count` and `fallback` |
| 6 | **Run page "Why these tests"**: reasons, not-run list, uncovered changes with "Explore this page" | `web/src/features/runs/*` | Selected and not-run lists render from `options.selection`; full runs show "Full regression" |
| 7 | **Observed coverage store**: per execution, the set of operation keys called (API: `run.responses`; UI: same-origin fetch/XHR from the network log) | migration (new slot after Phase 1's 62) `test_execution_endpoints(execution_id, op_key)` or a JSON column; `platform/repo-sink.ts` `recordExecution` (one added call, never throws, like `recordObservations`) | Values never stored, only `METHOD /templated/path`; bounded (≤300 per execution); failure to record never affects a job; edges age out when the script hash changes |
| 8 | **Post-run widening**: after an impacted run, compare this run's drift with the previous complete snapshot; list changed endpoints no selected test covered and offer "run the N tests that cover them" | `platform/selection-facts.ts`, `platform/trends.ts` (summary field only) | A seeded change on an uncovered endpoint is reported; nothing is started automatically |
| 9 | **Phase 1 edges**: read `Scenario.covers` and `Workflow.steps[].endpoint/page` from the latest model version once Phase 1 fills it; add a workflow priority field there if Phase 1 accepts it | `platform/selection-facts.ts`; `engine/intel/model.ts` (Phase 1 owns it) | Edges carry `modelled` provenance and `sourceType`; inferred items are never the only reason for skipping a test |
| 10 (later) | **Repository connection**: changed files by blob comparison of two commits; changed endpoints from an OpenAPI document generated at each commit; route-declaration parsing after that | `platform/git-checkout.ts` (one new method), `platform/selection-repo.ts` | Changed-file list equals `git diff --name-status A B` on fixture repositories; no file contents kept; a filename alone never creates an edge |

Complexity: steps 1-4 small (S, about 2-3 days with tests), step 5 S-M, step 6 S, step 7 M (migration + evidence dependency),
step 8 S, step 9 S once Phase 1 data exists, step 10 M-L.

### D1. Overall acceptance criteria

1. With no new parameters, every existing path (trigger, runbook, schedule, manual, CLI, `/validation`) queues exactly the same tests as
   today. Proven by tests comparing `testIds`.
2. Every selected test has one or more reason strings tied to a stored fact. Every changed item is either covered by a selected test or
   listed as uncovered.
3. Full regression stays one parameter away, and the fallbacks in C4 trigger automatically.
4. No AI call anywhere in selection. The same inputs always give the same output and order.
5. On a benchmark-style fixture with a seeded change to one endpoint, the impacted run includes every test that the full run shows
   failing because of that change (recall 100% on the fixture), and runs fewer tests than the full run.

### D2. Dependencies and conflicts

| Item | Independent of Phase 1? | Needs Phase 1 DB models | Needs Phase 1 intelligence | Changes generation or repair | Changes benchmark execution | Could change customer results | Conflicts with |
|---|---|---|---|---|---|---|---|
| 1 static coverage | Yes | No | No | No | No | No | none (new files; `screenmap/map.ts` gets one export) |
| 2 selector | Yes | No | No | No | No | No | none |
| 3 facts adapter | Yes | No | No | No | No | No | WS2 if it changes `quarantine-store.ts` or `trends.ts` signatures |
| 4 preview route | Yes | No | No | No | No | No | Phase 1 and others edit `routes/index.ts` and `auth/roles.ts` (one-line merges) |
| 5 opt-in on runs | Yes | No | No | No | No (bench drives the API without `select`) | Only when opted in | WS1 (if it hardens `trigger-services.ts` / trigger body), WS2 (if it changes `runbook-runner.ts` `selectTests` or `scheduler.ts` `runnableTestIds`) |
| 6 run page | Yes | No | No | No | No | No | WS3 (run/evidence views in `web/src/features/runs`) |
| 7 observed coverage | Schema slot after 62 | Ordering only (slot numbering in `db.ts`, `pg/baseline.sql`) | No | No | No | No (write-only side store) | **WS3**: the per-action network log is the UI source; both touch `engine/evidence/capture.ts`, `engine/validation/runner.ts`, `platform/repo-sink.ts`. Build one shared per-execution request summary, not two |
| 8 post-run widening | Yes | No | No | No | No | No | WS3 (run summary fields) |
| 9 Phase 1 edges | No | Yes (`app_model_versions`) | Yes | No | No | No | Phase 1 owns `engine/intel/model.ts` |
| 10 repository | Yes | No | No | No | No | No | WS1 (git safety in `git-checkout.ts`, outbound guards) |

Shared files (merge-conflict watch list): `platform/db.ts` and `platform/pg/baseline.sql` (migration slots; Phase 1 holds slot 62,
uncommitted), `platform/routes/index.ts` and `platform/auth/roles.ts` (Phase 1 modified, uncommitted), `platform/repo-sink.ts`
(`recordExecution`: WS3 evidence and this step 7), `engine/evidence/capture.ts` and `engine/validation/runner.ts` (WS3, WS2),
`platform/trigger-services.ts` and `platform/runbook-runner.ts` (WS1/WS2 and step 5), `platform/scheduler.ts` (`runnableTestIds`, WS2),
`platform/trends.ts` (WS2 flakiness, step 8), `engine/intel/model.ts` (Phase 1 only).

Recommended order: 1 → 2 → 3 → 4 (all new files, can start now) → 5 after WS1/WS2 have landed their trigger and runbook changes →
7 together with WS3's network-log work, after Phase 1's slot 62 is committed → 6, 8 → 9 when Phase 1 fills the model → 10 only if
post-run widening shows measured misses.

### D3. Risks

- **Missed regressions** when a change reaches a test through a path with no edge (server-side logic behind an unchanged endpoint).
  Mitigations: opt-in only, unknown coverage means the test runs, always-run critical set, post-run widening, scheduled full runs.
  (Proposed)
- **Weaker drift detection** in impacted runs, because the snapshot is marked incomplete (`drift-store.ts:31-39`). Mitigation: scheduled
  full runs, and widening compares only against complete snapshots. (Verified mechanism)
- **Trend distortion** (Suspected): `run_summaries.pass_rate` from a 10-test impacted run sits beside 300-test full runs in
  `trendsFor` (`trends.ts:277`). Per-test history is safe (`trends.ts:136-140`), but the project pass-rate chart should mark or filter
  selective runs. Needs checking in the dashboard before step 5 ships.
- **Phase 1 benchmark**: none of the steps touch generation, repair, prompts, eval or runner behaviour. The benchmark calls the platform
  API without `select`, so steps 1-8 cannot change its results. Do not modify `routes/index.ts`, `roles.ts`, `db.ts` or `baseline.sql`
  until Phase 1's uncommitted hunks in those files are committed. (Verified: those files are modified in the working tree)
