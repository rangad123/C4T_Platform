# Change-aware testing

A connected GitHub repository tells the platform what a pull request changes. The platform works out which tests reach that change and
why. It keeps track of the bugs a change fixes or brings back. It shows the history as one small card. **A full run stays the
default:** nothing is skipped and nothing is chosen automatically. A focused run of the proposed tests starts only when a person (or the
trigger API's explicit `selection` field) asks for one.

## The path of a pull request

1. **Connect a repository** on **Integrations**, card **Connect GitHub** (`web/src/features/integrations/GithubCodeCard.tsx`): the
   project, the repository (owner/name), a fine-grained personal access token, and **Pull request feedback** on or off. Changing it needs
   the permission to manage keys and connections. The card calls `PUT /api/projects/:id/code-host` (and `POST .../code-host/test`,
   `DELETE .../code-host`); on the first connect it makes a random webhook secret in the browser and sends it along, because the webhook
   refuses unsigned deliveries. The token and secret are stored encrypted (`platform/code-host/store.ts`) and never sent back. Only
   `api.github.com` or a configured GitHub Enterprise host is called (the card offers github.com only; the API takes `apiUrl`). The
   answer gives the webhook address once, and the card shows it with the secret once, with the events to choose in GitHub (Pull requests
   and Deployment statuses); only the address token's hash is kept.
2. **The webhook** (`POST /api/code-host/github/:token`, `platform/code-host/webhook.ts`) counts a delivery only when its
   `X-Hub-Signature-256` matches under the connection's secret, compared in constant time. The delivery must be for the connected
   repository, and at most 30 per minute are taken per project. A delivery id that was already seen does nothing more. A pull request
   opened or pushed to queues an impact analysis. A pull request from a fork is ignored, because its code must not run with this
   project's secrets. A successful `deployment_status` queues a re-check of the findings its pull request says it fixes.
3. **Impact analysis** (`platform/code-host/pr-impact.ts`, `engine/impact/analyze.ts`) maps the changed files and functions to route
   handlers, then to endpoints and pages. From there it finds the tests that reach them by their recorded coverage, plus workflows,
   rules, requirement links and past findings. Every link carries its evidence. Files that reach no route are listed as unmapped.
4. **The selection** (`platform/selection/preview.ts`, `risk.ts`) ranks the proposed tests by a risk score. Each part of the score is
   written into the reason. A full run is recommended when more than 20% of the change is unmapped or when shared code changed. One row
   per head commit is kept in `pr_selections`, with mode `full`.
5. **Feedback**, when the project's switch is on (`platform/code-host/feedback.ts`): one sticky comment on the pull request (the same body
   the CLI writes) and, after a run, a check on the head commit (a commit status when the token may not create check runs). Channels
   that chose it get the `pr_selection_ready` notice (`platform/alerts.ts`).
6. **Runs, After a deploy**, card **Which tests a change calls for**: the latest pull requests are listed with their head commit, the
   number of proposed tests, the full-run reasons, why the first tests were proposed, and the run of that commit. Naming changed pages
   and endpoints by hand is then folded under them ("Or name the changed pages and endpoints yourself"); without pull request lines it
   is the card's content, as before. Each has two buttons:
   **Run all tests** (the default) and **Run only the proposed tests**. Both use `POST /api/projects/:id/selection-run` and need the
   permission to run tests. The focused run sends the routes the change reached and gets the same proposal again from current coverage.

## Fixes and bugs that come back

`platform/findings/regression-service.ts`: a pull request whose title or commits say "Fixes #n" for an issue filed from a finding, or a
person's "Check the fix", starts a verification run on the build that has the fix. The finding becomes **Fixed** only when every attempt
passes. Otherwise its history says "Fix claimed — still reproduces". A fixed finding's test joins the "Regression" suite. When a later
run fails that test, or finds the bug again, the finding goes back to Verification pending, and channels that chose it get
`finding_reopened`.

## The quality card

The project dashboard shows a **Quality** card once the project has run history, confirmed bugs or pull requests
(`web/src/features/dashboard/QualityCard.tsx`). `GET /api/projects/:id/quality` returns the card and the history behind it
(`platform/dashboard.ts projectQuality`, `platform/trends.ts qualityHistory`). It only reads stored rows, so it starts no job and calls
no AI.

| On the card | How it is counted |
|---|---|
| Bugs confirmed | moves of a finding to Confirmed (`finding_events`) in the last 4 weeks; the number links to the run the newest confirmed finding was last seen in |
| Came back after a fix | moves from Fixed back to Verification pending in the last 4 weeks |
| Pass rate, last 10 runs | the average pass rate of the latest 10 runs that have one |
| Workflow steps tried | exercised of all workflow steps in the latest exploration's coverage record; left off the card when there is no record |
| Pull requests checked | pull requests whose tests were chosen in the last 4 weeks; left off the card when there are none |
| Areas that keep failing | pages and endpoints (from test coverage) where a test did not pass in at least 2 of the latest 10 runs; quarantined tests left out; each links to a test that failed there |
| Unreliable tests to fix | the existing flaky-test rule (`detectFlaky`); each links to the test |

The answer also has the median time to confirm (`hoursToConfirm`), which the card does not show. The history in the same answer also has the bugs confirmed per week, bugs confirmed per run, and the pull requests with the run of their
head commit. A run counts for a pull request when a deploy trigger ran it with a commit label of at least 7 characters that starts the
head commit's hash. `GET /api/projects/:id/pull-requests` returns the same pull request list for the selection card.

Limits: findings from the security module keep their own states and are not counted here. An area that every test opens (often `/`)
shows up whenever any test fails.

## Integrations evaluation

What each kind of integration needs, and what was built:

| Integration | Evaluation | Built |
|---|---|---|
| GitHub pull requests | The change is known before the merge, so this gives the most value. The REST API gives files, patches, commits and branches with a fine-grained token. | Yes: repository connection, webhook in, sticky comment and check out, PR lines on the selection card. A GitHub App installation is left for later; the personal access token comes first. |
| CI/CD pipelines | Every pipeline can already call the deploy trigger (`POST /api/trigger/...`, with `commit` and `environment`) and the CLI (JUnit, SARIF, sticky comment). A plugin per CI product would only repeat that. | No new work: pipelines keep the trigger and the CLI (`docs/features/ci.md`). The trigger's `selection` field picks a focused run when a pipeline asks for one; the default stays full. |
| Webhooks | Inbound: GitHub's signed `pull_request` and `deployment_status` events are enough. Outbound: the existing alert webhooks already carry run events. | Inbound GitHub webhook only. |
| Notifications | The existing channels (webhook, Slack, Teams, email) and their log already fit; a new channel would add settings without adding information. | Three events on the existing channels, each opt-in per channel: `finding_confirmed`, `finding_reopened`, `pr_selection_ready`. |
| GitLab merge requests | Similar API (merge request changes, notes, commit statuses) and a webhook secured with a secret token header rather than an HMAC. It would need its own client, webhook check and comment writer. | Evaluated, not built. GitLab CI runs the CLI and the trigger today; merge request comments are not posted. |
| Bitbucket pull requests | Cloud and Data Center have different APIs and webhook signing; app passwords are being replaced by API tokens. Two clients for a smaller share of projects. | Evaluated, not built. Bitbucket Pipelines can call the trigger and the CLI. |

## Not built

- Automatic choice of a focused run for deploys, schedules or pipelines. Full runs stay the default everywhere.
- GitLab and Bitbucket connectors, a GitHub App installation, and a GitHub Enterprise address on the Connect GitHub card (the API takes it).
