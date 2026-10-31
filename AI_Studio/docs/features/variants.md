# Cross-browser and responsive checks

Re-run your validated web tests on other browsers and screen sizes, and see where they break.

## What it does for a user

A web test is validated on desktop Chrome (Chromium). That says nothing about Firefox, Safari or a phone. This feature repeats the tests that passed on:

| Name in the UI | What runs |
|---|---|
| Firefox | Firefox engine, 1280 × 800 |
| Safari (WebKit) | WebKit engine (Safari on Mac / iPhone), 1280 × 800 |
| Phone | Chromium with a mobile browser profile, touch, 390 × 844 |
| Tablet | Chromium with a tablet profile, touch, 820 × 1180 |

Desktop Chrome is the existing main run and is never repeated here.

The main result is never changed. A test is `VALIDATED` because of the desktop Chrome run alone; a variant run only adds a compatibility result and can never turn a test into "Validation failed".

Each (test, browser/size) result is one of:

- **Passed**: really ran and passed.
- **Fails here**: really ran and failed. The failing step, the reason, a screenshot, a recording and a trace are kept.
- **Couldn't run here** (`unavailable`): the browser is not installed or could not be started. This says nothing about your application and is never a finding.
- **Not repeated** (`skipped`): the test is not the kind that is repeated, with the reason shown.

A test that passes in Chrome but fails on another variant is a **compatibility finding** (medium severity): it works for some visitors and not for others.

Which tests are repeated: web tests that are `VALIDATED`, except accessibility audits, visual tests (any test with a screenshot assertion, because baselines are per browser and size) and security / health checks. Everything excluded is reported with a reason, never silently dropped. API tests have no browser and are ignored.

### Where to find it

- **New analysis → Advanced options → Other browsers and screen sizes → "Also check on: …"**: collapsed and off by default. After the main validation, the tests that validated are repeated on what you tick.
- **Tests tab → ⋯ More actions → Check other browsers & screen sizes**: pick variants and run them for the whole project.
- **A test's page → Other browsers & screen sizes**: the matrix (✓ passed, ✗ fails here, – couldn't run / not repeated), the failing step, evidence links, and "Check again" for that one test.
- **Tests list**: a badge such as "Fails on Safari" and a "Differs by browser" filter chip.
- A browser that is not installed on the server is shown with a note and cannot be ticked.

## How it works

- `src/engine/validation/variants.ts` is the single definition of the variants (ids `chromium-desktop`, `firefox`, `webkit`, `mobile-chrome`, `tablet`, labels, Playwright device profile and viewport), the eligibility rules, `detectBrowsers()`, the classification of a run (`passed` / `failed` / `unavailable`) and `runVariantChecks()`.
- `runScripts` in `runner.ts` accepts `projects`. The generated Playwright config then has one project per variant, so one run covers all scripts × variants. Results are parsed per (script, project) and each `ScriptRun` carries its `variant`. Without `projects` the config and results are exactly what they were before.
- Timeouts, allow-listed child environment and artifacts (screenshot / video / trace kept on failure) are the same as the normal run. At most two workers are used because Firefox and WebKit are heavy.
- A run that fails before any step started with a browser launch error ("Executable doesn't exist" …) is classified `unavailable`, not `failed`.
- Installed browsers are detected by looking for each Playwright executable. `INSTALLED_BROWSERS_OVERRIDE` (comma list, e.g. `chromium,firefox`) replaces the check. The platform's tests use it to simulate a machine like the Docker image, which only has Chromium. `runVariantChecks` also takes an injectable `detect` function.
- **Storage** (migration slot 3): `test_executions.variant` (NULL = base run). Variant rows live in the same table with status `passed | failed | unavailable | skipped` and the reason in `error`; steps and artifacts are stored like any run. `listExecutions` returns base runs only, so run history, JUnit and the "latest run" shown for a test are unchanged. Evidence is stored under `_artifacts/<test>/job-<id>/variant-<name>/`.
- **Triggers**
  1. Job option `variants: string[]` (default none). `POST /api/projects/:id/test-generation` accepts it; after the base validation the orchestrator (and validation-only jobs) run the variants for tests that validated, as a sub-step of the validation phase.
  2. `POST /api/projects/:id/variants` `{ variants, testIds? }` queues a job with `mode: "variants"`. It honours the one-active-job-per-project rule (409). Response: `jobId`, `tests` (queued), `skipped` (with reasons) and `unavailable` (chosen variants this machine cannot run). 422 when nothing can be checked.
  3. `POST /api/tests/:id/variants` `{ variants }` does the same for one test (422 with the reason when it is not eligible).
- A `variants` job touches no test's validation status. It ends `COMPLETED` when every test behaves the same everywhere, `PARTIALLY_COMPLETED` ("needs attention") when some tests differ or a browser couldn't run, and `FAILED` only when nothing could be checked. Counters: `testsGenerated` = tests compared, `testsValidated` = tests that passed everywhere they ran, `testsNeedingReview` = tests that differ, plus `variantChecks` and `variantFailures`. Events: `variants_started`, `variant_passed | failed | unavailable | skipped`, `variants_done`.

### API shapes

- `GET /api/config` adds `browsers: { chromium, firefox, webkit }` and `variants: [{ id, label, description, browser, available, reason? }]`.
- `GET /api/tests/:id` keeps `executions` (base runs) and adds `compatibility: { [variant]: { status, reason?, executionId, ranAt, durationMs, failedStep?, artifacts: [{id, kind}], stale } }` (newest per variant; `stale` = the test was re-run after this check) and `variantCheck: { eligible, reason? }`.
- `GET /api/projects/:id/tests` summaries add `compat: null | { failing, unavailable, passed, severity: { severity: "medium", basis } | null }`.

## Limits

- Results come from the Playwright browsers on the computer that runs the platform. "Safari" is Playwright's WebKit build, not Safari itself, and "Phone" / "Tablet" are emulated profiles in Chromium (screen size, touch, user agent), not real devices or other mobile engines.
- The Docker image ships Chromium only, so Firefox and Safari show as unavailable there until `npx playwright install firefox webkit` is added to the image.
- Visual and accessibility tests are not repeated. A visual check per browser would need a baseline per browser and size.
- A result can go out of date when a test changes; the matrix says so ("checked before the test's latest run").
- Tests run once per variant (no retries), so a flaky page can show a one-off failure. Use "Check again".
- The generation-job option (`variants` on `test-generation`) only has an effect for web tests, which need an AI model to be generated. The automated tests exercise the same step through a validation job and the on-demand routes against a local fixture app.
