# Creating issues from findings (GitHub and Jira)

> Notion is also supported as a tracker (a page is created in a database): see [notion-and-sentry.md](notion-and-sentry.md).

When exploration finds a bug, or a test finds a problem or cannot be made to pass, you can file an issue in your tracker with one
click. The issue already contains what failed, how severe it is and why, the steps, how to reproduce it and a link back.

## For a user

1. **Connect a tracker.** Open **Integrations** (left sidebar) and choose **Set up GitHub Issues** or **Set up Jira** (or **Set up
   Notion**). Fill in:
   * **GitHub**: the **Owner** and **Repository**, and an **Access token** that can create issues in it (a fine-grained token with
     *Issues: read and write* is enough). Only for GitHub Enterprise Server: the **GitHub Enterprise API address**.
   * **Jira (Cloud)**: your **Jira address** (`https://yourcompany.atlassian.net`), the **Project key** (for example `SHOP`), the
     **Account email**, an **API token** (Atlassian account → Security → API tokens) and the **Issue type** (default *Bug*).
2. **Set up …** checks the address and token with a real call before saving anything, and explains a problem in plain words ("GitHub
   did not accept the token…", "…could not find it. Check the owner and repository name…"). **Test the connection** repeats the check
   later; **Remove** deletes a connection no project uses.
3. **Use it in a project:** under **Use in a project**, choose the project and **Use it**. The connection then shows in the project's
   **Settings → Connections**, under **Issue tracker** ("Shared from Integrations"). A project can also connect a tracker of its own
   there, with **Connect another**.
4. **File from a finding:** on an exploration's run page, under **Findings to check**, choose **File issue** on a confirmed finding or
   one that needs manual review. The row then shows "Filed as GitHub #12". Until the project has a tracker, the card says where to connect
   one, and there is no File issue button.
5. **File from a test:** open a test that found something (*Needs a look*) or that could not be validated and choose **Create issue**.
   With several connections you pick one. The link to the new issue (for example *GitHub #12*, *Jira SHOP-7*) appears as a chip on the
   test page.

Asking again never creates a duplicate: if the finding or test already has an issue in that tracker, the existing link is returned. A
passing or never-run test has nothing to report, so there is no button for it.

### What the issue contains

* **Title**: `[High] Cart loads for a signed-in shopper` — the severity first (`[Failing test] …` for a test that could not be made to
  pass, which has no severity because it is not a defect in the application), then the test's title.
* **Body**: *What failed* (the failure message, without terminal colour codes or Playwright's call log), *Details* (test id, area,
  severity and its basis, priority, last run, application address), *Steps* (with the failing step marked), *Expected result*,
  *How to reproduce*, and a link to the test in the platform. GitHub gets Markdown; Jira gets Atlassian Document Format.
* **Labels**: `ai-testing`, `severity-<level>` (findings only) and `finding` or `test-failure`.
* The link back uses `PUBLIC_URL` when it is set (set it to the address people use to reach the platform), otherwise the address the
  request came in on.

## How it works

* **Storage** (migration slot 5): table `integrations` (project, kind, name, non-secret settings as JSON, `secret_enc`) and table
  `issue_links` (test, integration, provider, external id/key, url, title, created time; at most one link per test and integration).
  The token is stored **encrypted with the platform's `SecretBox`** (AES-256-GCM, same key as stored test credentials) and is **never
  returned by the API**, never put into an issue, an error message or a log line. Removing an integration keeps its links.
* **Outbound calls** go through the platform's address guard (`net-guard.ts`: with `BLOCK_PRIVATE_TARGETS=true`, private and loopback
  addresses are refused when saving *and* on every call), with a 10 s timeout, and **never follow a redirect** (the credentials would
  travel with it).
* **Code**: `src/platform/issues/` (`http.ts` shared outbound call and error wording, `content.ts` the issue text and its two renderings,
  `github.ts`, `jira.ts`, `store.ts`), routes in `src/platform/routes/integrations.ts`, UI in `web/src/features/integrations/`.

### API

| Call | What it does |
| --- | --- |
| `GET /api/projects/:id/integrations` | The project's connections (kind, name, non-secret settings). |
| `POST /api/projects/:id/integrations` | Connect. Body: `{ kind: "github", owner, repo, token, apiUrl? }` or `{ kind: "jira", baseUrl, projectKey, email, token, issueType? }`, plus optional `name` and `verify` (default `true`: check with a real call first). `201` with the connection (no secret). |
| `PATCH /api/integrations/:id` | Rename, change non-secret settings, or replace the token. |
| `DELETE /api/integrations/:id` | Remove (`204`). |
| `POST /api/integrations/:id/test` | A real call to the tracker. `200 { ok, message }` or `{ ok: false, code, message }`. |
| `POST /api/tests/:id/issue` | Body `{ integrationId }`. `201 { link, existing: false }`, or `200 { link, existing: true }` when one already exists. `422` unless the test is *Needs review* or *Validation failed*; `404` for an unknown test or a connection of another project. |
| `GET /api/tests/:id/issues` | The test's linked issues. |

Failures from the tracker are `502` with `{ error: <plain sentence>, details: { code, upstreamStatus } }`, where `code` is one of
`unauthorized` (401), `forbidden` (403), `not_found` (404), `rate_limited` (429, or 403 with an exhausted limit), `rejected`,
`unreachable` (network, timeout, 5xx) or `blocked` (address guard).

## Limits

* GitHub Issues and **Jira Cloud** (REST v3) only. Jira Server/Data Center (v2 wiki markup) is not supported. Linear, GitLab and
  others are not included.
* Issues are created, not synchronised: closing an issue in the tracker does not change the test, and re-running the test does not
  update the issue.
* One issue per test and connection; there is no way to create a second one for the same test in the same tracker from the UI.
* Custom required fields in a Jira project (beyond project, type, summary, description and labels) are not filled in; Jira's answer
  is shown to the user ("Jira rejected the request: …") when a project needs them.
* Verified against local mock servers that implement the documented GitHub and Jira endpoints (auth checks, 401/403/404/rate-limit
  answers, payload validation), not against github.com or a live Jira site.
* Databases created while migration slot 5 was still a placeholder have the slot recorded as applied without the tables; use a fresh
  database (or add the two tables from `db.ts`) for such an installation.
