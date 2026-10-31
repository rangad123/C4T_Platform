# Environments and test data

Run the same tests against more than one place (staging, production...) with a read-only production mode, and run one test with many rows of data.

Both ideas are ported from `ai-testing-agent` (MIT; see `THIRD_PARTY_LICENSES.md`): `env_manager.py` (environments like Postman, with a read-only production mode) and `data_manager.py` (test data from files, with validation).

## Part 1: named environments

### What it does for a user

A project can have several **named environments**, for example `staging` and `production`. Each has:

- an **address** (the site, like `https://staging.example.com`) and an optional **API address**;
- optional **sign-in details** for that environment only: username, password, API token, a complete Authorization header, an authenticator secret. They are encrypted and **write-only**: the platform never shows them again, only whether one is saved (and the username, which is not a secret);
- **values** (`NAME = value`, not secret) that tests can use as `{{env.NAME}}`;
- a switch **"Use the project's test accounts here"** (on by default) for the access-control checks that sign in as named accounts;
- a **production** flag. One non-production environment is the **default**: it is preselected in the picker (a production environment can never be the default, so nothing runs there by accident). Since round 21 this is true in the UI: the **Run panel** (Run on the Tests page and on the Runs page, "More ways to run" on a test's page) opens with the default environment chosen, and every run step of a **new run sequence** (blank or from a template, and steps added later) starts there. The person can still choose the project address or another environment; that choice stays while the page is open and is not saved anywhere (nothing remembered per project). A phone or desktop test's own panel keeps the project address (those tests do not run on environments), a "run these again" panel keeps the place of the run it repeats, and a saved run sequence keeps the places it was saved with. The one-click **Run again** button on a test's page is not a picker: it still runs on the project's address.

A run against an environment executes the project's tests there: the environment's address, sign-in and values are used instead of the project's own. The result is stored **for that environment**. The test's own status ("Validated", "Needs review"...), its run history, the JUnit file, trends, flaky-test detection and API-drift tracking are the project's main run and are **never changed** by an environment run. Environment runs do not feed trends or regression alerts either.

Each (test, environment) result is one of:

| Result | Meaning |
|---|---|
| **Passed** | the script ran there and passed |
| **Found a problem** (`finding`) | it failed in a way that proves an application problem (a 5xx, a security header, a broken link...), classified by the same rules as the main validation, with a severity |
| **Failed** | it ran and failed, with the failing step, the reason and evidence (screenshot, video, trace) |
| **Not run** (`skipped`) | it was not run there, with the reason |

There is exactly one attempt per test and **no automatic repair**: a model rewriting a test to fit one environment would hide the difference this feature exists to show.

Tests that are never run against an environment (reported "Not run" with the reason): mobile tests (they need a device), visual comparisons (they use the main run's approved screenshots), and, on production, every test that **changes data**.

A run against an environment classifies a failed test with the same function the main validation uses (`classifyFailedRun`), so a finding is a `finding` there exactly when it is "Needs review" in the main run. A failed API test whose answer was 401 because no API token is saved is not told apart there yet (only the main validation names it).

### Safe production mode

An environment flagged `production`:

1. **never runs tests that change data.** A test changes data when it sends a request that is not GET / HEAD / OPTIONS (POST, PUT, PATCH, DELETE), when it is an input check that also submits data-sending forms (`inputHandling` with `all`), or when it carries the tag `changes-data` (or `mutating`). Those tests are skipped with the reason *"production is read-only: this test changes data, so it was not run here."* even if mutating tests are enabled everywhere else. Web journeys that click through a form cannot be recognised from their steps; tag them `changes-data` or keep them off production.
2. **needs an explicit confirmation for every run**: `confirmProduction: true` in the API, `--confirm-production` in the CLI, a checkbox ("Yes, run on production") in the UI. Without it the API answers 409 with `details.requiresConfirmation` and no job is created. A job that reaches the worker without the confirmation never runs.
3. is **labelled prominently** (red "Production · read-only" badge, a warning wherever you pick it).

A schedule can run against an environment too (re-run schedules only). A schedule for a production environment must be created or edited with `confirmProduction: true`; it is recorded as an error, not run, otherwise.

The outbound-address guard (`BLOCK_PRIVATE_TARGETS`, `net-guard.ts`) applies to every environment address, when it is saved **and** again when a run starts.

### Where to find it

- **Tests tab → ⋯ More actions → Environments**: add, edit, make default, remove, and **Run all tests here** for each environment (production needs its checkbox first). The panel explains each field.
- **A test's page → "Run on" picker next to "Run again"**: appears only when the project has environments. A production choice shows its confirmation checkbox and "Run again" stays disabled until it is ticked. After the run, a card per environment appears under **Environments** with the last result, the reason and a screenshot link.
- **Runs tab / project page**: a run against an environment is labelled "Run on staging" and explained in its own words.
- **CLI**: `ai-test run --server <url> --project <name> --env staging` (add `--confirm-production` for a production environment). The report (console, JSON, JUnit, SARIF, HTML, Markdown) is built from that environment's results; the JSON report gets `environment`; tests the environment skipped are "not run", never passes. `--env` needs `--server` (environments are saved in the platform) and cannot be combined with `--analyze`.

### API

All paths are under `/api/projects/:id`.

| Call | What it does |
|---|---|
| `GET /environments` | `{ environments: [{ name, baseUrl, apiBaseUrl, production, isDefault, useProjectAccounts, variables, username, hasPassword, hasTotp, hasApiToken, hasApiAuthHeader }], max }` |
| `POST /environments` | create `{ name, baseUrl, apiBaseUrl?, production?, useProjectAccounts?, variables?, isDefault? }` → 201 |
| `PUT /environments/:name` | change any of `baseUrl, apiBaseUrl (null clears), production, useProjectAccounts, variables` |
| `PUT /environments/:name/secrets` | write-only `{ username?, password?, totpSecret?, apiToken?, apiAuthHeader? }`: a field left out keeps what is saved, `""` removes it |
| `POST /environments/:name/default` | make it the default (400 for production) |
| `DELETE /environments/:name` | remove it and the results kept for it (409 while a schedule uses it) |
| `POST /environments/:name/runs` | `{ testIds?, confirmProduction? }` → 202 `{ jobId, environment, production, testCount, tests, skipped }`; 409 + `requiresConfirmation` for an unconfirmed production run; 422 with the reason when nothing could run |
| `GET /environments/:name/results` | `{ environment, summary, tests: [{ ..., result: { status, reason?, ranAt, durationMs, failedStep?, artifacts, severity? } \| null }] }` (what the CLI reads) |

Existing endpoints take the same choice: `POST /api/tests/:id/validate` and `POST /api/projects/:id/validation` accept `{ environment, confirmProduction }` (without `environment` they behave exactly as before), and schedules accept `environment` and `confirmProduction`. `GET /api/tests/:id` adds `environmentResults: { [name]: { status, reason?, ranAt, durationMs, failedStep?, artifacts, severity? } }`. A job's public shape adds `environment` (and `mode: "environment"`).

Validation: names are lower-case letters, digits, `-`, `_` (start with a letter, at most 24); at most 8 environments per project; the address is the site's origin only (a path is refused with an explanation); at most 30 values, names `[A-Za-z][A-Za-z0-9_]*` that differ by more than capitals.

### How it works

- `src/engine/environments/env.ts`: the rules (names, `changesData`, the skip reasons, `TEST_ENV_<NAME>`). `run.ts`: `runEnvironmentJob` renders each test exactly as the main run does (so stored and downloaded scripts do not change), runs them in **one** Playwright run with the environment's address and secrets passed as the environment variables every script already reads (`BASE_URL`, `API_BASE_URL`, `TEST_USERNAME`, `TEST_PASSWORD`, `API_TOKEN`, `API_AUTH_HEADER`, `TEST_<ACCOUNT>_*`, and `TEST_ENV_<NAME>` for values), and classifies each result with the same finding rules as the validator (`deterministicFinding`, now exported from `validator.ts`).
- **`{{env.NAME}}`** renders as `process.env.TEST_ENV_NAME ?? ""` (in `render-utils.ts`), so a downloaded script works anywhere you set that variable. In a normal (non-environment) run the variables are empty.
- **Storage** (migration slot 11, `src/platform/environments-store.ts`): `project_environments` (own table; the unused per-application `environments` table from migration 1 is left alone because applications are recreated for every run), `test_data_sets`, and `test_executions.environment` (NULL = the main run, like `variant`). Secrets are one `SecretBox`-encrypted blob per environment. `listExecutions` returns main runs only (`variant IS NULL AND environment IS NULL`), so every other reader is unchanged; flaky detection ignores environment rows explicitly. The migration also adds `environment` and `confirm_production` columns to `schedules`.
- A job with `mode: "environment"` (`options.environment`, `options.confirmProduction`, `options.testIds`) is handled in `job-runner.ts` via `src/platform/environment-run.ts`, which re-checks everything when the job runs (the environment may have changed or been deleted since it was queued).
- Skipped tests are recorded once: a repeated identical "skipped" result is not stored again.
- Job outcome: `COMPLETED` when everything that ran passed, `PARTIALLY_COMPLETED` when something failed, `FAILED` when nothing could run.

### Limits

- Environment sign-in covers one set of credentials per environment (plus the project's named accounts if enabled). OAuth2 client credentials are not supported per environment.
- Mobile and visual tests are not run against environments. Web journeys that submit forms are not recognised as data-changing unless tagged.
- No per-environment trends or alerts: run summaries, trends, flaky detection and API-drift tracking describe the main run only.
- A run uses one browser (Chromium) and one attempt; the environment's API address defaults to its site address (the main run may use the address in the OpenAPI document).
- Variables are plain text, not secrets; passwords and tokens go in the sign-in section.

## Part 2: test data (data-driven tests)

### What it does for a user

A **data set** is a named table (up to 200 rows x 20 columns; every value is text of at most 500 characters) imported from **CSV, JSON or YAML**. A test names it with `testData.dataSet: "<name>"`; the test then runs **once per row**, and `{{column}}` in its steps (URLs, values to type, expected text, request paths, queries, headers and bodies) is replaced by that row's value. The row number is in each test's title (`[row 2/5]`). A test uses at most the first **25 rows**; a larger data set is cut short and the platform says so (a comment in the script, an event in the run, and a note on the test's page).

The table is **embedded in the script as plain data**, so a downloaded script is self-contained. That is why a data set is not a place for secrets: sign-in details belong in the project's credentials, test accounts or an environment's sign-in.

If a row fails, the whole test fails and the failing step says which row: *"... (data row 2 of 5)"*. The test still has one execution (durations add up); when every row passes it passes.

### Where to find it

**Tests tab → ⋯ More actions → Test data**: import a file (the name is suggested from the file name), look at the rows, replace or remove a data set, see which tests use it. A test that uses a data set says so on its page.

### Formats and checks

- **CSV**: header row, quotes (`"a,b"`, `""` for a quote), CRLF or LF, a leading BOM, comma / semicolon / tab (taken from the header line), blank lines ignored.
- **JSON**: a list of objects (values are converted to text, `null` becomes empty), or `{ "columns": [...], "rows": [[...]] }`, or `{ "rows": [{...}] }`.
- **YAML**: the same shapes (the `yaml` package was already a dependency). YAML aliases are refused.
- **Excel is not supported** (no license-safe parser is present): the API answers with "save the sheet as CSV".
- Clear 400s (`{ error }` in plain words): empty file or header only, more than 200 rows or 20 columns, a value over 500 characters, duplicate or invalid column names (`[A-Za-z_][A-Za-z0-9_]*`; `unique`, `dataSet`, `credentials`, `env` are reserved), a duplicate data set name, nested values, invalid JSON / YAML. Importing a spec that names a missing data set, or uses `{{x}}` that is not a column / test value / captured value / built-in, is a 400 listing the problem; a test that is already stored cannot lose a column it uses (replace is refused), and a data set that tests use cannot be deleted (409).

### API

| Call | What it does |
|---|---|
| `GET /api/projects/:id/test-data` | `{ dataSets: [{ name, columns, rowCount, testedRows, truncated, usedBy, updatedAt }], limits }` |
| `GET /api/projects/:id/test-data/:name` | the same plus `rows` and the tests that use it |
| `POST /api/projects/:id/test-data` | `{ name, content, format?, filename? }` (`content` is the file's text; the format comes from `format`, then the file name, then the content) → 201 |
| `PUT /api/projects/:id/test-data/:name` | replace it |
| `DELETE /api/projects/:id/test-data/:name` | remove it (409 while tests use it) |

`GET /api/tests/:id` adds `dataDriven: null | { dataSet, found, rows, total, truncated, note? }`.

### How it works

- `src/engine/testdata/dataset.ts`: the parsers, the limits, `resolveRows`, `unknownPlaceholders`. Generators take the project's data sets as `RenderContext.dataSets` (`src/engine/generators/types.ts`). With a `dataSet` in `testData`, `playwright.ts` and `api.ts` emit `const ROWS = [...]` and `for (const [rowIndex, row] of ROWS.entries()) { test(...) }`; each test starts with `data = { ...baseData, ...row, unique }` (a worker runs a file's tests one after another, so rows never see each other's values; the API script also clears its recorded responses per row). Values are JSON string literals, never evaluated, and step values reach the page or request through `data[...]` at run time. A spec without `dataSet` renders byte-for-byte as before.
- `runner.ts` merges the results of one data-driven file: passed only if every row passed, the first failing row speaks for it, durations add up, every row's HTTP responses are kept.
- `job-runner.ts` loads the project's data sets for every kind of job that renders scripts (validation, browser variants, environment runs), so a test is rendered from the current rows each time it is re-run. A missing data set fails the test with a plain message rather than rendering nothing.

### Limits

- One test uses at most 25 rows of a data set (200 allowed in a set); data sets are flat tables of text (no types, no nested data).
- Data-driven tests in the browser-variants check are repeated with the same rows like any other test.
- A data set is shared across the project, not per environment.
- Excel files are not supported.

## Tests

`tests/environments.test.ts` (real Playwright runs against two fixture servers, ports 5510-5512), `tests/test-data.test.ts` (port 5513), `tests/environments-ui.test.ts` (browser journey, ports 5514-5516), and the environment sentinels in `tests/secret-leak.test.ts`. Fixture: `tests/fixtures/environments-app.ts`.
