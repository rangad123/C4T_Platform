# Running the platform from a pipeline (`ai-test`)

`ai-test` is a command-line tool that runs the platform's tests and **gates a CI pipeline** on the result: it exits with a
code your pipeline understands, prints a plain summary, and writes reports in the formats CI systems expect (JUnit, JSON,
SARIF for GitHub code scanning, one self-contained HTML page, Markdown). On GitHub it can also keep **one comment on the
pull request** up to date.

```
npm run ai-test -- run --specs tests/ai-tests.json --url http://localhost:3000 --fail-on high
```

Also available as the `ai-test` bin (`node bin/ai-test.mjs …`). `ai-test --help`, `ai-test run --help` and
`ai-test export --help` list every flag.

## What it does for you

The usual setup is **replay mode**: you export your project's saved tests once (`ai-test export`, or Tests → ⋯ More actions →
Export… in the UI), commit the file, and every pipeline run replays them against the freshly deployed or freshly started
application. Replay uses **no AI**: a saved test passes or fails the same way every time, runs in seconds to minutes, and costs
nothing. Findings (problems the tests detect in the application, such as a server error or an accessibility violation) and
broken tests (a test that cannot pass any more) are both reported, with a severity for each finding.

## Three ways to run

| You pass | What happens | Needs |
| --- | --- | --- |
| `--specs <file.json> --url <app>` | **Replay**: imports the saved tests into a throwaway platform inside the command (its own temporary data folder, never your `./data`), runs them in a real browser, reports. | Chromium (`npx playwright install chromium`). No AI key. |
| `--analyze --url <app>` | **Generate**: runs the full analysis in-process (explore the app, plan, write tests), then validates them. | Chromium and an AI key, set like for the server (`ANTHROPIC_API_KEY` or `LLM_API_KEY`…). Without a key only the parts that need no AI run (API tests from an OpenAPI document, the built-in page checks). |
| `--server <url> --project <name> [--specs … \| --analyze] --url <app>` | **Remote**: drives a platform that is already running, over its REST API. The CI runner needs no browser. | A running platform; `--api-key-env NAME` (or the `AI_TEST_API_KEY` variable) when the server is protected by an API key. |

With `--server` and neither `--specs` nor `--analyze`, the command re-runs the existing tests of `--project`.

### Remote mode details

* `--project` names the project to create or reuse (an id works too). Without it a new `ci-<time>` project is created for the run.
* Reusing a project **adds only the tests it does not have yet** (matched by test id such as `WEB-001`); tests that already exist are
  re-run but **not updated** if the file changed. To pick up edited tests, use a new project name or edit them in the platform.
* Only one run can be active per project at a time (the platform's existing rule).
* The remote command uses `POST /api/projects/:id/specs` (`validate: false`) followed by `POST /api/projects/:id/validation`
  (added for this feature: re-run every runnable test of a project, optionally with an address, credentials and API address).
  Mobile tests need an emulator and are left alone.

## The gate and exit codes

| Exit code | Meaning |
| ---: | --- |
| `0` | The gate passed. |
| `1` | The gate failed: a finding at or above `--fail-on`, or (unless disabled) a test that could not be validated. |
| `2` | Usage or infrastructure error: bad flags, a missing environment variable, an unreadable or invalid specs file, server unreachable, wrong API key, the run failed or timed out, or nothing could be run. |

* `--fail-on <critical|high|medium|low|any|none>` (default `high`) — findings at that severity **or higher** fail the gate. `any`
  fails on every finding, `none` never fails on findings.
* `--fail-on-failed-validation` (default **on**; turn off with `--no-fail-on-failed-validation`) — a test that could not be made
  to pass (the page changed, a button is gone, …) fails the gate, because the pipeline can no longer vouch for that behaviour.
* Tests that were **not run** (for example mobile tests without an emulator) never fail the gate, but a run in which *nothing* ran
  is an error (exit 2), not a pass.
* Findings come from the platform's own deterministic rules (see the severity rules in the user guide): authentication not enforced
  is critical, server errors high (critical on a critical journey), accessibility violations by their impact, visual changes low, and
  the security-header and page-health checks by the severity each problem carries.

Every run ends with a summary like:

```
AI Testing Platform — GATE FAILED
Target: http://localhost:3000   Mode: replay   Took: 41.2 s
12 tests run · 9 passed · 2 findings · 1 could not be validated

Findings (problems the tests found in the application):
  [HIGH] WEB-102 Newsletter page is accessible
      Accessibility audit failed: - [critical] image-alt: Images must have alternative text … (critical accessibility violation)
…
Gate failed: 1 finding at high or higher severity (worst: high).
```

## Credentials and secrets

Credentials for the application under test are passed as **the names of environment variables**, never as values:

```
--username-env APP_USER --password-env APP_PASS     # web sign-in
--token-env API_TOKEN                               # bearer token for API tests
--auth-header-env API_AUTH                          # a complete Authorization header value
--api-base-url https://api.example.com              # if the API is not at the app's address
```

* A flag that is given a value that is not a valid variable name is refused (so a pasted password is rejected, not used).
* A named variable that is unset or empty is a usage error (exit 2).
* Every secret value the command knows (app credentials, the platform API key, the GitHub token) is **redacted from everything it
  prints or writes** — console, JSON, SARIF, HTML, Markdown, JUnit, the PR comment, `$GITHUB_STEP_SUMMARY` — even when a failing
  test's own message quotes it (tests cover this). Screenshots are not altered: use a dedicated test account.
* Replay and generate mode never read or write `./data`; they use a temporary folder that is deleted afterwards.

## Outputs

All optional. Parent folders are created.

| Flag | Output |
| --- | --- |
| `--junit <file>` | JUnit XML, the same writer as the platform's `/api/projects/:id/junit`. Findings are failures of type `application-finding`; broken tests `test-failure`; never-run tests `<skipped/>`. |
| `--json <file>` | The versioned machine-readable report (below). |
| `--sarif <file>` | SARIF 2.1.0 with **one result per finding** (see below). |
| `--html <file>` | One self-contained page (no scripts, nothing fetched, screenshots embedded, light/dark). |
| `--markdown <file>` | The summary as Markdown. |
| `--evidence-dir <dir>` | Screenshots, and videos/traces (up to 25 MB each) of tests that need attention, named `<TEST-ID>-<kind>.<ext>`. The JSON report refers to them by file name. |
| *(automatic)* | When `$GITHUB_STEP_SUMMARY` is set, the Markdown summary is **appended** to it. |

### JSON report (`schemaVersion: 1`)

```jsonc
{
  "schemaVersion": 1,
  "tool": { "name": "ai-test", "version": "0.1.0" },
  "generatedAt": "2026-01-01T12:00:00.000Z",
  "mode": "replay",                  // replay | analyze | remote-replay | remote-analyze | remote-rerun
  "target": "http://localhost:3000",
  "project": { "name": "ci-20260101120000", "id": "…" },   // id only in remote modes
  "durationMs": 41200,
  "summary": { "total": 12, "passed": 9, "findings": 2, "failedValidation": 1, "notRun": 0,
               "bySeverity": { "critical": 0, "high": 1, "medium": 1, "low": 0 } },
  "gate": { "failOn": "high", "failOnFailedValidation": true, "passed": false,
            "reasons": ["1 finding at high or higher severity (worst: high)."], "exitCode": 1 },
  "tests": [{
    "id": "…", "testId": "WEB-102", "title": "…", "suite": "…", "kind": "web", "type": "accessibility", "priority": "high",
    "outcome": "finding",            // passed | finding | failed | not_run
    "validation": "NEEDS_REVIEW",    // the platform's own status
    "severity": "high", "severityBasis": "critical accessibility violation (blocks some users)",   // findings only
    "category": "accessibility",     // security | server-error | accessibility | visual-change | functional-defect (findings only)
    "reason": "…", "durationMs": 1830, "attempts": 1,
    "failedStep": { "number": 2, "title": "…" },
    "link": "http://platform/#/tests/…",      // remote modes
    "evidence": [{ "kind": "screenshot", "file": "WEB-102-screenshot.png" }]
  }]
}
```

New fields may be added; existing ones keep their meaning within a `schemaVersion`.

### SARIF and GitHub code scanning

Each finding becomes a result with `level` from its severity (critical/high → `error`, medium → `warning`, low → `note`) and a rule
per kind of finding (`ai-testing/accessibility`, `…/server-error`, `…/security`, `…/visual-change`, `…/functional-defect`).
Findings concern a running application rather than a source file, so each result points at **the test's entry in the specs file**
you passed (path relative to the directory you ran the command in — run it from the repository root — and the line of its `testId`).
`partialFingerprints` are stable between runs, so GitHub tracks one alert per finding instead of opening a new one each time.
Broken tests (not findings) are not in the SARIF file; they are in JUnit/JSON/HTML.

## Pull request comment (GitHub)

`--github-comment` posts **one** comment and **updates it** on every later run (it finds its own comment by a hidden marker, also
across more than 100 comments), so a busy pull request does not fill with reports.

* Repository: `--github-repo owner/name` or `$GITHUB_REPOSITORY`. Pull request: `--pr <n>` or the event file at `$GITHUB_EVENT_PATH`
  (a push event has no pull request: the comment is skipped with a note).
* Token: `$GITHUB_TOKEN` (or `--github-token-env NAME`). GitHub Enterprise: `--github-api-url` or `$GITHUB_API_URL`.
* The address is checked with the platform's outbound-URL guard (set `BLOCK_PRIVATE_TARGETS=true` to refuse private addresses).
* **It never fails the pipeline.** A token without permission (give the job `pull-requests: write`; pull requests from forks get a
  read-only token) or a network problem is a warning on stderr; the exit code still reflects the gate only.

## GitHub Actions

See [`.github/workflows/ai-tests.example.yml`](../../.github/workflows/ai-tests.example.yml): replay-mode gate, artifact upload,
SARIF upload to code scanning, JUnit check, sticky PR comment, step summary.

## GitLab CI

Pull request comments are GitHub-only; everything else works. JUnit appears in the merge request's test tab.

```yaml
ai-tests:
  image: mcr.microsoft.com/playwright:v1.63.0-jammy      # same Playwright version as the platform's package.json
  variables:
    APP_USER: $AI_TEST_USER                              # CI/CD variables (masked)
    APP_PASS: $AI_TEST_PASSWORD
  before_script:
    - git clone --depth 1 https://example.com/your-org/ai-testing-platform.git
    - (cd ai-testing-platform && npm ci)
    # start your application in the background here, e.g.  - npm ci && npm start &  - npx wait-on http://127.0.0.1:3000
  script:
    - mkdir -p ai-test-results
    - node ai-testing-platform/bin/ai-test.mjs run --specs tests/ai-tests.json --url http://127.0.0.1:3000
        --username-env APP_USER --password-env APP_PASS --fail-on high
        --junit ai-test-results/junit.xml --html ai-test-results/report.html --evidence-dir ai-test-results/evidence
  artifacts:
    when: always
    paths: [ai-test-results/]
    reports:
      junit: ai-test-results/junit.xml
```

## Jenkins

```groovy
pipeline {
  agent any
  environment {
    APP_USER = credentials('ai-test-user')              // "Secret text" credentials
    APP_PASS = credentials('ai-test-password')
  }
  stages {
    stage('AI tests') {
      steps {
        sh '''
          mkdir -p ai-test-results
          node ai-testing-platform/bin/ai-test.mjs run --specs tests/ai-tests.json --url http://127.0.0.1:3000 \
            --username-env APP_USER --password-env APP_PASS --fail-on high \
            --junit ai-test-results/junit.xml --html ai-test-results/report.html --evidence-dir ai-test-results/evidence
        '''
      }
    }
  }
  post {
    always {
      junit 'ai-test-results/junit.xml'
      archiveArtifacts artifacts: 'ai-test-results/**', allowEmptyArchive: true
    }
  }
}
```

To mark the build *unstable* instead of failed on exit code 1, run the command with `returnStatus: true` and call `unstable()` when it
returns 1 (and `error()` when it returns 2).

## `ai-test export`

```
ai-test export --server https://platform.example.com --project "My shop" --out tests/ai-tests.json
```

Writes `{ "specs": [...] }`, the same file as Tests → More actions → Export…. Commit it and replay it with `--specs`.

## Limits and honest notes

* **Not verified on GitHub Actions, GitLab or Jenkins.** Those could not be run in the environment this was built in. What *was*
  verified: the command itself (real child processes, real exit codes, real Playwright runs against the sample apps), the GitHub
  comment code against a local mock that implements the documented comment endpoints, SARIF structure, and the workflow YAML only by
  reading it. Expect to adjust the example to your setup on first use.
* Replay runs the tests exactly as saved. If your application's text or layout changed on purpose, update the saved tests (re-export
  from the platform after it repaired them, or edit the file) — a changed page legitimately fails the gate until you do.
* Replay never calls an AI, so there is no automatic repair of a broken test: it is reported as "could not be validated".
* Web tests run in Chromium only (the platform's usual validation browser).
* Mobile tests are skipped (they need an Android emulator).
* Remote mode does not update tests that already exist in the project (see above).
* On Windows the command lets the process end by itself instead of calling `process.exit()`; calling it while HTTP connections were
  closing produced a garbled exit code (`0xC0000409`) in testing, which a pipeline would misread. A short safety timer (8 s) ends the
  process if something refuses to close.
