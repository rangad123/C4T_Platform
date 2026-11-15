# Test Generation Quality Audit

Phase 0 audit of the AI Studio test-generation pipeline: how a URL (plus optional credentials, requirements and an OpenAPI
document) becomes stored, executed tests and findings, and why the tests it produces rarely find meaningful defects.

Scope: `src/engine` (discovery, understanding, planning, authoring, generators, validation, mutation, healing, quarantine),
the LLM routing, and the platform code that turns results into issues. The AI-key and model-configuration code is treated only
as "the LLM provider abstraction". Everything below was read in code; claims in `docs/` were checked against code and are
marked where they disagree. Line numbers refer to the tree as of 2026-11-14.

Status labels used: **implemented** (code path runs in the default pipeline), **partial**, **present-but-unused** (code
exists, the generation pipeline does not use it), **mocked**, **planned**, **unverified** (could not be confirmed without a
real model or a real application).

---

## 1. Pipeline trace

Entry point: `runGeneration` in `src/engine/orchestrator.ts:223`, called by the platform job worker through the
`GenerationSink` interface (`orchestrator.ts:146-181`). Web + API runs go through `runWebAndApiGeneration`
(`orchestrator.ts:245`); a phone target goes through `src/engine/mobile/explore/pipeline.ts` (not covered in depth here).

Default options (`src/platform/repo.ts:163-177`): level thorough (60 pages, depth 4, 50 scenarios), targets web + api,
`allowMutatingApiTests: false`, health / security / input / contract / access checks on, performance, load and visual off.

| Stage | Where | LLM? | What it produces | Status |
|---|---|---|---|---|
| 1. Discovery: sign-in | `discovery/auth.ts`, `orchestrator.ts:306-316` | no | form login (TOTP supported) or a saved session | implemented |
| 1. Discovery: crawl | `discovery/crawler.ts:526` | no | BFS same-origin `PageModel[]`: ARIA snapshot, headings, forms (heuristically classified), up to N controls, links, API calls, console errors; safe toggles only (`crawler.ts:312-313`), conditional-field probing (`:245`), client-route probing (`:459`) | implemented |
| 1. Discovery: API | `api/openapi.ts`, `discovery/network.ts`, `orchestrator.ts:368-418` | no | OpenAPI probe + observed fetch/XHR folded into `ApiEndpointModel` (status codes, inferred response shape, sample body) | implemented |
| 1. Discovery: site docs | `discovery/docs.ts` | yes | test cases / endpoints a practice site publishes about itself | implemented (niche) |
| 1. Access survey | `identity/access.ts`, `orchestrator.ts:343-359, 402-414` | no | what each named account (and a visitor) can reach | implemented (needs role accounts) |
| 1. Screen map | `screenmap/map.ts`, `orchestrator.ts:448` | no | screens (URL templates) and transitions from the crawl | implemented |
| 2. Understanding | `understanding/analyzer.ts:68` | yes, 1 call | siteType, purpose, features, page purposes/types, 4-12 journeys | implemented |
| 3. Requirements | `requirements/extract.ts`, `requirements/parse.ts` | optional | atomic requirements `{id, text, section, kind}` | implemented |
| 3. Planning | `planning/planner.ts:273` | yes, batched | `Scenario[]` (title, description, category, type, priority, startPath, preconditions, 1-3 expected results, requiredData, requirement ids, role) | implemented |
| 3b. Plan-only review | `orchestrator.ts:553-561`, `planning/preview.ts` | no | plan returned for a person to prune before generation | implemented |
| 4a. Web authoring | `web/author.ts:162` | yes, agent loop per scenario | canonical `TestSpec` from steps that **worked** in a live browser | implemented |
| 4b. API tests | `api/test-specs.ts:131`, `api/workflows.ts`, `identity/access.ts` | no | template matrix per endpoint + simple chains + access checks | implemented |
| 4c. Check families | `a11y/`, `health/`, `inputs/`, `security/`, `performance/`, `visual/`, `vision/` | no (vision: yes) | deterministic, page-generic checks for key pages | implemented |
| 5. Storage | `GenerationSink.createTest/saveScript` (`orchestrator.ts:573-584`), `platform/repo-sink.ts` | no | spec is the source of truth; script re-rendered by `generators/*` via `frameworks/` adapters | implemented |
| 6. Validation run | `validation/validator.ts:168`, `validation/runner.ts` | no | real `playwright test` run, JSON report, per-step results, trace/video/screenshot on failure | implemented |
| 6b. Classification + repair | `validator.ts:260-374`, `validation/repair.ts`, `validation/det-repair.ts` | yes (triage, repair) | VALIDATED / NEEDS_REVIEW / FAILED_VALIDATION | implemented |
| 6c. Flakiness | `validator.ts:378-404` | no | new web tests re-run `repeatPasses` times (3 at thorough); a failing new test re-run once | implemented |
| 6d. Variants | `validation/variants.ts`, `orchestrator.ts:890-910` | no | other browsers / sizes / dark / locale for key tests | implemented (opt-in / deep+) |
| 6e. Test strength | `mutation/strength.ts`, `mutation/faults.ts`, `orchestrator.ts:911-931` | yes (strengthen) | deliberate-fault replay score per validated web test | implemented |
| 7. Healing | `healing/heal.ts`, `healing/deterministic.ts` | no | locator replacement **proposal**, never applied automatically | implemented |
| 8. Quarantine | `quarantine/rules.ts`, `platform/quarantine-service.ts` | no | flaky tests stop gating; check-family tests never eligible | implemented |
| 9. Severity | `validation/severity.ts` | no | severity parsed from the reason string + scenario priority | implemented |
| 10. Issues | `platform/issues/content.ts`, `platform/routes/integrations.ts:140-186` | no | GitHub / Jira / Notion issue from one test, on a person's request | implemented (manual) |

Re-runs of stored tests go through `src/engine/validate-only.ts` (schedules, runbooks, CI). There a repair is saved as a draft
and never run (`validate-only.ts:203-206`).

---

## 2. The prompts (summarised, key lines quoted)

Models per purpose come from `src/engine/llm/routing.ts:41-51` (`ROUTE_TABLE`). With a fast model configured, **authoring
steps go to the fast model**; analysis, planning and review go to the "strong" model; repair to the main model. No call sets a
temperature except the vision judge (`vision/judge.ts:69`), so generation is not reproducible run to run. Default model per
provider: `llm/provider.ts:26-31`.

### 2.1 Understanding (`understanding/analyzer.ts:23-30`, purpose `analysis`)
"You are a senior QA engineer analysing a web application from crawl data ... Describe what the application is and identify its
important end-to-end user journeys." Rules: "do not invent pages, features or flows", "Prefer a focused set of 4-12 journeys".
Input: at most 40 API lines (`:83`), one block per page inside a 45,000-character budget (`:35`), ARIA snapshot truncated per page.
Output schema `AnalysisSchema` (`understanding/app-model.ts:167-187`): `siteType, purpose, features[], pagePurposes[], journeys[], authenticationMechanisms[]`.
There is no field for entities, attributes, states, business rules, invariants or field constraints.

### 2.2 Planning (`planning/planner.ts:84-115`, purpose `planning`)
"You are a senior QA lead planning a web test suite ... Produce meaningful, independent scenarios — NOT one test per button."
It asks for happy paths plus negative/validation cases, "curious use", edge cases, persistence after reload, content checks
("lorem ipsum", "undefined", broken images, wrong totals) and "constraint checks (the app's business rules: dates in order,
limits and quantities, a total equal to the sum of its lines)". Expected results must be "concrete, observable" (1-3 per
scenario). Two rules matter for defect detection:
- "Derive expected behaviour from the intended functionality, but only reference UI that exists in the model." (`:102`)
- "These are UI tests ... Never expect anything about API endpoints, JSON responses or network calls" (`:107-108`).
Batching: one call per area of ≤15 pages, one cross-area journey call, requirement batches of 40, role-difference calls, and
up to 3 coverage-gap rounds (`:281-387`). Deterministic post-filters: requirement ids must exist (`:336`), vague outcomes
dropped (`VAGUE`, `:252-254`), duplicates dropped by exact title or by a bag-of-words "intent key" on the same start page (`:256-259`).

### 2.3 Authoring agent (`web/author.ts:75-100`, purpose `authoring`)
"You are an automated QA engineer authoring ONE end-to-end test by performing it in a real browser. Every action you perform
successfully is recorded into a reusable Playwright test". Key rules: role/label locators first; "Use the strongest check
that fits: exactText ... remembered"; "You MUST finish with assertions ... A test without assertions is worthless"; "If an
assertion fails because the application genuinely behaves differently from the expected result, call finish(result="defect")";
"Stay in the UI: do not navigate to API/JSON endpoints". The prompt (`:559-577`) carries the scenario, its expected results,
up to 4 known pages (`pageHint`, `:144-156`), notes and the first ARIA snapshot. It does not carry the requirement text the
scenario cites, the journey description, the API model or any data rule.
Tools: click, fill, select, check, press, hover, upload, drop, drag, dialog, download, switchTab, navigate, clock, condition,
wait, remember, assert (24 UI checks, `AUTHOR_CHECKS` `:106`), optional lookAtScreen / testValue / seeWholePage, finish.
No tool asserts on a network response, although the step schema and the web renderer support `assertResponse` in web tests
(`web/checks.ts:141`) — **present-but-unused** for AI authoring.

### 2.4 Review (`web/author.ts:219-225`, purpose `review`)
One review of each complete test: asks for a change only for missing/vacuous outcome assertions, unchecked dependent outcomes,
weak locators, off-intent steps, fixed waits. "Never ask to remove or loosen an assertion." Fixes are applied by resuming the agent.

### 2.5 Defect verdict (`web/author.ts:175-201`, purpose `review`)
"You judge ONE suspected bug found by an automated test writer ... Answer only "yes" ... or "no"". Asked 3 times; majority "no"
turns the outcome into "blocked" (not reported). Input is text only (scenario, explanation, step descriptions, console/network
errors); nothing is re-executed.

### 2.6 Triage and repair (`validation/repair.ts:49-64, 114-159`, purpose `repair`)
Triage: category `locator | timing | test_data | assertion | app_defect | environment | other`, `fixable`, `firstWrongStep`.
"Be conservative: only mark fixable=true if a test change would plausibly make it pass." Web repair = re-run the authoring agent
from the first wrong step (from scratch on a second attempt, `:96`). API repair: "correct the test's request/assertions to match
the real behaviour only when that behaviour is reasonable ... Never loosen an assertion", backed by a structural guard
`weakensApiTest` (`:167-184`). **There is no equivalent guard for web repairs.**

### 2.7 Requirements normalisation (`requirements/parse.ts:416`)
Deterministic extraction first, then optional LLM normalisation into atomic requirements with a `kind`. Planning sees each
requirement cut to 240 characters (`planner.ts:51-52`), at most 150 per prompt.

---

## 3. Findings per question (§2 of the plan)

### 3.1 Application understanding

| Question | Finding | Evidence | Status |
|---|---|---|---|
| Understands workflows? | Journeys are LLM prose (`name, description, steps[], pages[]`) inferred from one static crawl. They are not executed or verified during understanding; their `pages` are only filtered to known paths (`analyzer.ts:129`). | `app-model.ts:119-126`, `analyzer.ts:86-101` | partial |
| Discovers pages and elements? | Yes, BFS by URL with per-pattern caps; ARIA snapshot, forms, controls, links, revealed menus/tabs, conditional fields. Forms are never submitted during the crawl, so states that exist only after an action (a created record, a filled cart, a wizard's step 2) are not discovered unless reachable by URL. | `crawler.ts:1-13, 245, 312-313, 337, 459` | implemented, state-blind |
| Understands business entities? | No. Nothing in the model represents entities, attributes, identifiers, relationships or lifecycles. API response shapes are inferred (`network.ts:179`) but never linked to UI fields. | `app-model.ts:134-164` | missing |
| Relationships between workflows? | Only implicitly: a cross-area journey planning call and a screen map of URL-template transitions. No "workflow A creates what workflow B reads" model. | `planner.ts:292-296`, `screenmap/map.ts` | partial |
| Ingests API specs and requirements? | Yes: OpenAPI probing/merge (`orchestrator.ts:370-400`), requirements from txt/md/pdf/docx (`requirements/extract.ts`) with deterministic + LLM parsing. Requirements reach planning only, as truncated lines; the authoring agent never sees them. API specs feed API templates and contract checks; they do not inform UI scenarios. | `planner.ts:54-70`, `author.ts:559-577` | implemented, shallow use |
| Expected behaviour vs assumptions? | Not distinguished. Expected results are free text written by the planning model; there is no source/confidence field (requirement, spec, observed, inferred). The crawl only shows current behaviour, so most "expected" results are either observed state or the model's guess. | `spec/schema.ts:532-551` (`ScenarioSchema`), `planner.ts:102` | missing |

### 3.2 Test generation

| Question | Finding | Evidence |
|---|---|---|
| Generic or application-specific? | Web scenarios are application-specific in wording (real labels, paths). API tests and every check family are generic templates applied per page/endpoint. | `api/test-specs.ts:131-272`, `inputs/checks.ts:1-23`, `health/`, `security/` |
| Sufficiently detailed? | Scenarios carry 1-3 expected results; steps are concrete because they are recorded from a live run. Detail is bounded by `authoringMaxSteps` (30 at thorough, `levels.ts:61`). | `planner.ts:103-106` |
| Negative / boundary cases? | Asked for in the planning prompt; deterministic API matrix adds missing-field, wrong-type, empty / 5,000-char / injection strings; input checks submit 7 fixed probes on GET forms by default. Boundary API cases only assert "no 5xx" (`statusBelow 500`). Data-changing API cases are off by default. | `planner.ts:88-91`, `api/test-specs.ts:256-272`, `repo.ts:168` |
| Business rules → assertions? | Only if the planning model writes the rule as an expected result and the authoring agent can observe it. No rule extraction, no invariant model, no computed oracle (e.g. sum of lines). The `remember` + `remembered` comparison exists and is the only cross-step oracle. | `planner.ts:95-97`, `author.ts:83-85`, `spec/schema.ts:171` |
| Independent or duplicated? | Each scenario starts from a clean browser at `startPath` (`author.ts:299`). Duplicates are filtered by exact title or same start page + same word set (`planner.ts:256-259, 326-328`); semantically equal scenarios with different words survive. The eval harness counts duplicates by same steps or same title (`eval/metrics.ts:29`). | — |
| Meaningful assertions? | Guards exist against vacuous ones: an outcome assertion is required after the last action (`author.ts:210-217`, pushback `:542-555`); empty expectations refused (`:515-523`); a review pass (`:219-258`). But every recorded assertion has **already passed against the live app** (see 4.1), so "meaningful" means "true today", not "checks the rule". | `author.ts:331-368` |
| Can tests detect actual defects? | During authoring: only if the agent itself decides an assertion failure is a defect (`finish("defect")`) and the 3-vote verdict agrees. Afterwards, as regression tests: they detect change from the authored state, and the strength check shows they detect blunt breakage (server error, empty data, hidden element, changed literal). They do not detect logic defects that were present at authoring time. | `author.ts:95, 185-201`, `mutation/faults.ts:87-105` |

### 3.3 Execution

| Question | Finding | Evidence |
|---|---|---|
| Executed or only generated? | Executed. A test is VALIDATED only after a real `playwright test` run passes (`runner.ts:1-6`, Playwright `retries: 0` at `runner.ts:145`). Exception: authoring outcomes of type "defect" are stored as NEEDS_REVIEW **without being run as a script** (`orchestrator.ts:621-627`; they never enter `pending`). | — |
| Failures properly classified? | Deterministic first (`classifyFailedRun`, `validator.ts:481-500`): check-family findings, 5xx on API tests, auth not enforced, captcha, sign-in failure. Everything else in a web test goes to LLM triage on text + the failing step's ARIA context (`repair.ts:38-64`). A UI assertion failure is therefore an LLM judgement call between "test wrong" and "app wrong", with an instruction to be conservative about fixable. | — |
| Browser / API / backend correlated? | Evidence capture records network requests and console during web runs (`evidence/capture.ts`, `runner.ts:16`) and is used for issue text (`issues/content.ts:76-79`). No assertion correlates UI with API; the planner forbids it (`planner.ts:107-108`). No backend or database observation exists. | partial (evidence only) |
| Retries masking failures? | Playwright retries are 0. New tests: a failing one is re-run once to label flaky/broken (`validator.ts:378-389`); a passing one must pass `repeatPasses` more times (`:391-404`). Scheduled runs default to `retryFailures: 1` (`platform/schedule-store.ts:105`): a fail-then-pass ends **VALIDATED**, with only a `flaky_pass` event (`validator.ts:247-259, 406`). The bigger masking path is repair: a failing web test is re-authored until it passes (below). | partial masking |
| Reproducible? | Execution yes (the spec is stored and re-rendered; `{{unique}}` varies). Generation no: no temperature, no seed, plan and steps differ between runs; authoring is a free agent loop. | `llm/provider.ts`, `author.ts:579-597` |

### 3.4 Bug detection

| Question | Finding | Evidence |
|---|---|---|
| App defects vs automation failures? | Three statuses; deterministic rules for check families and API 5xx/auth; LLM triage for UI. `FAILED_VALIDATION` mixes "test could not be made to pass" and "app broken but triage said fixable and repairs ran out". The eval harness classifies failures by regex on the reason (`eval/metrics.ts:10-12`), which confirms there is no structured failure taxonomy. | `validator.ts:481-532`, `repair.ts:20-30` |
| Verifies suspicious findings? | Authoring "defect": LLM majority vote on text, no re-execution (`author.ts:185-201`). `pruneByReplay` replays once but does not demote a defect whose assertion passes on replay (`author.ts:679-717`, status unchanged). Validation findings: deterministic findings are not re-run; new failing web tests are re-run once. | partial |
| Sufficient evidence? | Good for failed script runs: Playwright trace (DOM/ARIA/screens), video, screenshot, redacted network/console evidence, ARIA error context. Authoring-time defects keep the steps and up to 15 console/network problem lines; a trace is kept only for **blocked** scenarios (`author.ts:649-669`), not for defects. | `runner.ts:145-160` |
| Duplicate findings? | No finding-level deduplication. Issues are deduplicated per test + tracker only (`routes/integrations.ts:147`). Ten tests that hit the same 500 give ten findings. | missing |
| Useful reproduction steps? | Issue text lists the spec steps in plain words with "← failed here", expected results, failure text, evidence sentence, link to the test (`issues/content.ts:55-112`). Issues are created manually per test. No minimisation of steps, no environment/data preconditions captured. | partial |

---

## 4. Concrete weaknesses (with file references)

### 4.1 The oracle is the application itself (highest impact)
`record()` in `web/author.ts:331-368` executes every tool call, including `assert`, against the live page and appends the step
**only when it succeeds** (`:353-355`). A failing assertion returns an error to the model, which may then try a different
check, a different expected value, or a different element. The finish rule only requires *some* passing outcome assertion
(`hasOutcomeAssertion`, `:210-217`). The path to report a bug requires the agent to stop trying and call `finish("defect")`,
and then a 3-vote LLM verdict that defaults to "test writer's mistake" on any doubt about wrong element, expectation or timing
(`:175`). The incentive of the loop is to converge on assertions the current application already satisfies.

### 4.2 Repair rewrites web tests until they pass, without a weakening guard
`validator.ts:313-374` sends a failing web test to `repairWeb`, which re-runs the authoring agent from the first wrong step
(and from scratch on a later attempt, `repair.ts:96`) with the failure text. The result is accepted if the agent reaches
"complete" (`repair.ts:107-108`). API repairs are checked by `weakensApiTest`; web repairs are not. A real defect that the
triage model labels `assertion` + fixable is "repaired" into a passing test that now encodes the defect. Only on approved
tests (validate-only) is the repair kept as an unrun draft (`validate-only.ts:203-206`).

### 4.3 Expected behaviour has no source
`ScenarioSchema.expectedResults` is `string[]` (`spec/schema.ts:542`). Nothing records whether an expectation comes from a
requirement, an OpenAPI contract, observed behaviour or the model's assumption; the authoring agent never sees the requirement
text (`author.ts:559-577`). There is no way to tell a "defect" from a wrong guess, which is exactly why 4.1's verdict is
conservative.

### 4.4 No application knowledge model beyond pages and journeys
`AppModel` (`app-model.ts:134-164`) has pages, forms, controls, API endpoints and LLM journeys. No entities, field
constraints, state machine, roles-to-permissions matrix (beyond the reach survey), invariants or cross-workflow data flow.
Planning therefore cannot ask for "the order total equals the sum of its lines" with a computed oracle, or "an item created
in A appears in B" across workflows, except as free text.

### 4.5 UI tests are forbidden from looking at the API
`planner.ts:107-108` and `author.ts:98` keep UI tests in the UI; the authoring toolset has no response assertion although the
schema and renderer support one (`web/checks.ts:141`). Defects where the UI shows a value the API did not return (or a failed
request the UI swallows) are invisible to functional tests. Health checks catch failed requests and console errors only on the
key pages they load, not inside journeys.

### 4.6 Generic templates for API and checks
`api/test-specs.ts:131-272`: happy path asserts status class + documented schema; missing field / wrong type assert `4xx`;
boundary and injection assert only `status < 500`. Observed (non-OpenAPI) endpoints get a status class and a JSON type.
Data-changing endpoints are skipped by default (`repo.ts:168`). These find crashes, missing auth and contract drift, not
business-logic defects.

### 4.7 Test strength measures blunt breakage
`mutation/faults.ts:87-105`: faults are "every same-origin response is a 500", "every response is empty", "the asserted literal
is replaced", "the asserted element is hidden", plus socket faults. Only the **last content assertion** is targeted
(`keyStep`, `:53-58`). Almost any test that checks a visible text catches the first two. A high score does not show the test
would notice a wrong total, a wrong filter result, an off-by-one or a stale value. Tests that create records are never scored
(`:65`).

### 4.8 The cheapest model writes the assertions
`ROUTE_TABLE.authoring` is `fast` (`llm/routing.ts:43`). When a fast model is configured, the step-by-step agent that chooses
locators and assertions runs on it; only review, planning and analysis are on the strong model. Escalation is driven by tool
failures and lack of progress (`ESCALATION_LIMITS`), not by assertion quality.

### 4.9 Crawl does not reach state behind actions
Discovery never submits forms (`crawler.ts:313` `UNSAFE_NAME` includes submit/save/send/order) and caps pages per URL pattern
(`levels.ts:54`). Combined with `allowMutatingApiTests: false`, most create/edit/delete lifecycles, multi-step wizards and
post-action states are neither discovered nor planned with real data.

### 4.10 Findings are not verified, deduplicated or grouped
Authoring defects are stored without a script run (`orchestrator.ts:621-627`); verification is an LLM vote. No fingerprint
(endpoint + status, page + console signature, assertion + element) groups findings; issues are one per test, made by hand.

### 4.11 Evaluation measures stability, not bug-finding
`src/eval/metrics.ts:1-60` and `eval/corpus.json`: metrics are planned/created counts, first-pass, stable, flaky, coverage of
pages, tokens. No seeded-defect fixture app (the bundled `examples/*` apps have no planted functional bugs; only
`examples/security-fixture` plants security problems). There is no number that says "found k of n known bugs".

### 4.12 Smaller issues
- Requirements are cut to 240 characters and ≤150 per prompt (`planner.ts:51-52`); long acceptance criteria lose their conditions.
- Analyzer sees at most 40 API endpoints (`analyzer.ts:83`).
- Scenario deduplication is lexical (`planner.ts:256-259`).
- Scheduled `retryFailures` (default 1) converts fail-then-pass to VALIDATED (`validator.ts:247-259`).
- No temperature/seed: two runs of the same job produce different suites, which makes A/B evaluation noisy.
- The authoring agent has no high-impact action gate (the objective agent has one, `agent/high-impact.ts`); safety relies on
  prompt rules and site notes.

---

## 5. What a typical generated test looks like

No stored output from a real model run against a real application exists in the repository; the scripts under
`.validation/run-*/` were produced by the test suite with scripted models against local fixtures. They are still the exact
render of the generators, and their shape matches what the prompts and tools allow.

**Web (rendered by `generators/playwright.ts`)**, from `.validation/run-1794597076781-a15ccf57/WEB-001.spec.ts` (357 lines;
~340 are the address guard, evidence capture and secret scrubbing helpers; the test body is):

```ts
test("WEB-001: Browse the product list", { tag: ["@functional","@high"], annotation: [{"type":"scenario","description":"S-001"}] }, async ({ page }) => {
    await installOverlayHandlers(page);
    evidenceStep(page, 1);
    await test.step("1. Open /products", async () => {
        await page.goto(await allowedAddress("/products", BASE_URL));
    });
    evidenceStep(page, 2);
    await test.step("2. Verify visible of heading \"Products\"", async () => {
        await expect(page.getByRole("heading", { name: "Products" })).toBeVisible();
    });
});
```

A typical real-model test, from the prompt rules and tool set, is longer but the same kind: navigate → fill/click with
role/label locators → 1-3 assertions such as `toContainText("No products found")`, `toHaveURL(/\/account/)`,
`toHaveCount(3)` or a `remembered` price compared on the cart page, each one **observed true** on the live app while authoring.

**API (rendered from `api/test-specs.ts`)**, step titles across the stored scripts: `GET /api/items` → `Verify response status = 200`;
`POST /api/items: rejects a body missing required field "name"` → `Verify response statusClass = 4xx`; boundary cases →
`statusBelow 500`.

What such tests **can** catch:
- the page or endpoint stops loading, a 5xx, a missing element, a renamed heading or label, a URL change, a changed literal
  that was asserted, a removed validation message (regression relative to the authored state);
- missing authentication on documented-secured endpoints; responses that break the documented schema;
- page-generic problems via the check families: console errors, failed requests, broken links, axe violations, missing security
  headers, reflected markup from input probes.

What they **cannot** catch:
- a defect present when the test was written (the assertion was fitted to it, 4.1/4.2);
- wrong computed values unless the model happened to assert the exact number (no computed oracle);
- UI showing something different from what the API returned, or a swallowed failed request inside a journey (4.5);
- persistence and cross-workflow effects (create here, read there) when data-changing tests are off;
- authorization defects beyond "page/endpoint reachable by the wrong account";
- concurrency, idempotency, state-machine violations, database invariants (no such model or tooling).

---

## 6. Why the current generated tests are weak (ranked by impact)

1. **Assertions are fitted to the current application.** Only passing steps are recorded (`web/author.ts:353-355`); the loop
   rewards finding an assertion that passes; bug reporting needs the agent to give up and a conservative 3-vote LLM verdict
   (`:175-201`). Result: tests are change detectors, not defect detectors.
2. **Repair can turn a real defect into a passing test.** Web repair re-authors until "complete" with no weakening guard
   (`validation/repair.ts:66-112`, contrast `weakensApiTest` `:167-184`); triage decides fixable from text.
3. **No source of truth for expected behaviour.** Expectations are model prose without provenance (`spec/schema.ts:532-551`);
   requirements never reach the author (`author.ts:559-577`); there is no entity/rule model to compute oracles from
   (`understanding/app-model.ts:134-187`).
4. **Single-layer observation.** UI tests may not assert on the API (`planner.ts:107-108`, `author.ts:98`); no backend/DB
   observation; correlation exists only as evidence text.
5. **Shallow, safe-by-default exploration.** Crawl never submits forms (`crawler.ts:313`), data-changing tests off by default
   (`platform/repo.ts:168`), per-pattern caps; stateful flows and post-action states are mostly absent from the model and plan.
6. **Generic templates for API and checks.** Status-class and "no 5xx" oracles (`api/test-specs.ts:166-272`) catch crashes and
   contract drift, not logic.
7. **Strength score overstates quality.** Blunt faults on the last assertion only (`mutation/faults.ts:53-105`).
8. **No measurement of bug-finding.** The evaluation harness measures stability and coverage (`src/eval/metrics.ts`); there is
   no seeded-defect benchmark, so improvements to finding bugs cannot be shown or regressions noticed.
9. **Fast model writes assertions; no reproducibility.** `llm/routing.ts:43`; no temperature/seed anywhere in planning or authoring.

---

## 7. Docs checked against code

| Claim | Where | Verdict |
|---|---|---|
| "Only steps that actually worked are recorded; assertions are mandatory" | `docs/AI_TESTING_ARCHITECTURE.md` §2.4 | True (`author.ts:353-355, 542-555, 604-606`). The doc presents it as a strength; it is also the root of weakness 1. |
| "Outcome defect is stored as NEEDS_REVIEW instead of being forced to pass" | same | True, but the defect is not executed as a script and is filtered by an LLM vote first (`orchestrator.ts:621-627`, `author.ts:185-201`). |
| "The pruned version is kept only if every assertion still passes" | same | True for complete tests (`author.ts:713`); for defects a passing replay does not demote the defect. |
| "LLM API repairs are structurally checked ... Vacuous web assertions are refused" | §Security hardening | True (`repair.ts:167-184`, `author.ts:515-523`); no structural check for web repairs. |
| "A test is VALIDATED only if its rendered script passed under Playwright" | §7 | True, with the scheduled fail-then-pass case (`validator.ts:247-259`). |
| "Mobile tests are not yet generated by the AI pipeline ... exploring a native app is not implemented"; "No CAPTCHA/2FA/SSO login support" | §Known limitations | Out of date: `mobile/explore/pipeline.ts` is wired in `orchestrator.ts:57, 224-230`; TOTP sign-in exists (`orchestrator.ts:255`), captcha detection and saved sessions exist (`auth/`, `orchestrator.ts:306-310`). |
| Real-world LLM runs (DemoShop, third-party demo shop) and their numbers | §Real-world check | Unverified: no stored results in the repository; would need a real model. |

---

## 8. Reusable as-is for a stronger engine

- Canonical `TestSpec` + renderers + framework adapters (`spec/schema.ts`, `generators/`, `frameworks/`): rich step and check
  vocabulary, including `remember`/`remembered`, `ariaSnapshot`, `assertResponse` in web tests, `clock`, `condition`.
- Live interpreter and browser session with event capture (`web/interpreter.ts`, `discovery/browser.ts`): the right base for
  an exploration agent that observes network and console per action.
- Real execution and evidence (`validation/runner.ts`, `evidence/`): traces, video, redacted network evidence.
- Deterministic finding classifiers and severity (`validator.ts:481-532`, `validation/severity.ts`).
- Fault injection harness (`mutation/faults.ts`): response/element interception per step can be extended to semantic faults.
- Model routing, budgets, prompt caching (`llm/`), plan-only review (`planning/preview.ts`), requirements extraction, site memory.
- Evaluation harness (`src/eval/`): the place to add a seeded-defect corpus and a "defects found" metric.
