# Notion issues and Sentry context

Two integrations that sit in the same place as the GitHub and Jira connections (Tests, then the **More actions** menu, then **Issue tracker**):

* **Notion** is a third place to file an issue from a failed test: each issue becomes a page in a Notion database.
* **Sentry** is read-only context: on the page of a failed test, a short list of Sentry errors that **might be related**.
  Sentry is never an issue tracker and never offers to create anything.

## For a user

### Notion

1. In Notion, create an internal integration (Settings, Connections, develop your own integration) and copy its token.
   Open the database that should receive the issues, choose **Connections** and add the integration to it. Without that
   step Notion answers as if the database did not exist.
2. In the platform: **Tests, More actions, Issue tracker, Connect an issue tracker, Notion**.
   * **Notion database**: paste the link to the database (open it as a full page and copy the link) or its 32-character id.
     The platform finds the id in the link (the part after `?v=` is a view, not the database, and is ignored).
   * **Notion integration token**: write-only, stored encrypted, never shown again.
   * **Title column**: the name of the database's title column (default **Name**).
3. **Connect.** The platform reads the database with a real call before saving, and checks that the title column exists and is
   really the title column. Problems are explained in plain words:
   * wrong token: "Notion didn’t accept the token…"
   * database not shared: "Notion can’t see that database. Open the database in Notion, choose “Connections” and share it with your integration."
   * wrong column name: "That database has no column called “Name”. Its title column is “Task”: use that name."
   * anything else Notion rejects: Notion's own message.
4. On a test that found something or could not pass, **Create issue** adds a page. The chip **Notion page** links to it. Asking
   again never makes a second page (one per test and connection, as for GitHub and Jira).

The page has the title (`[High] Cart loads for a signed-in shopper`) in the title column and the same content as a GitHub or
Jira issue: what failed (in a code block), what the page did, details, steps with the failing one marked, expected result,
how to reproduce, and a link back to the test. For a test that uses reusable steps the steps listed are the ones that ran, so the step marked as failed (and "step N is where it went wrong") is the number the run reported. Only the title is set; other columns of the database stay empty.

### Sentry

1. In Sentry, create an auth token that can only read (read access to projects and issues; no write scope is ever used).
2. **Tests, More actions, Issue tracker**, then the **Sentry** part of the same panel, **Connect Sentry**:
   **Sentry organisation** and **Sentry project** (the short names, as in your Sentry address), **Sentry auth token**
   (write-only). Under **Self-hosted Sentry** you can give your own Sentry address; the default is sentry.io.
3. **Save Sentry connection** checks the project with a real call. **Test Sentry connection** repeats it later;
   **Change** edits the names or address (the token can be left empty to keep the current one); **Disconnect** removes it.
4. Open a test that found something or could not pass. If Sentry is connected there is a section
   **Related errors in Sentry** (it is not shown at all when Sentry is not connected). Each item is a link out
   (`rel="noreferrer"`, new tab) with its level, event count, first and last seen, and **why** it might be related, for example:
   *First seen 40 seconds into the failed run and is reported at /api/cart, which failed in this run.*
   * Nothing looks related: "Nothing in Sentry looks related".
   * Sentry cannot be reached or refuses: "We couldn’t check Sentry" with the reason (token refused, project not found, rate
     limit, down). **Check again** asks Sentry again right away.

**Wording is deliberate: these errors might be related. The platform never says one of them caused the failure**, because
the only evidence is timing and a matching address.

## How it works

### Notion

* Kind `notion` in the existing `integrations` table (no new table). Settings: `databaseId` (a dashed UUID; a pasted link
  is converted when saved, also when changing a connection), `titleProperty` (default `Name`), optional `apiUrl`
  (default `https://api.notion.com`; for tests and proxies; it goes through the outbound guard). The token is encrypted
  with `SecretBox` exactly like the GitHub and Jira tokens, and is never returned, logged or put in a page.
* `POST /v1/pages` with `Notion-Version: 2022-06-28`, `parent.database_id`, the title property and `children`. The content is
  built by the same `issues/content.ts` builder as GitHub and Jira and turned into Notion blocks: headings
  (`heading_3`), paragraphs, bulleted and numbered items, one `code` block for the failure message, and the link back as
  a text link. Notion reads `rich_text.content` as literal text, so nothing in a test title or failure message can become
  markup, a mention or a link; every text is cut into pieces of at most 2000 characters (measured in UTF-16 units, never inside
  a character) inside one block, and a page has at most 100 blocks (a note points to the platform if there were ever more).
* The page address returned by Notion is stored in `issue_links` (`provider = notion`, `external_id = page`), with the same
  one-link-per-test-and-connection rule, the same double-click guard and the same `502` plain-sentence failures as the
  other trackers (`code` is one of `unauthorized`, `forbidden`, `not_found`, `rate_limited`, `rejected`, `unreachable`, `blocked`).
* Outbound calls: address guard on save and on every use, 10 s timeout, **no redirects** (the token would travel with it).
* Code: `src/platform/issues/notion.ts`, additive changes in `issues/types.ts`, `issues/store.ts`, `issues/content.ts`,
  `routes/integrations.ts`; UI in `web/src/features/integrations/`.

### Sentry

* Kind `sentry` in the same `integrations` table. `IntegrationStore` (the issue trackers) only ever selects the tracker kinds
  (`github`, `jira`, `notion`), so Sentry is invisible to every tracker route: it is not listed by
  `GET /api/projects/:id/integrations`, cannot be created, changed, tested or removed through `/api/integrations/:id`, and
  `POST /api/tests/:id/issue` with its id answers 404. One Sentry connection per project; connecting again replaces it.
  Settings: `baseUrl` (default `https://sentry.io`, self-hosted allowed, outbound guard on save and on every use),
  `organization`, `project` (short names); the token is encrypted with `SecretBox` and write-only.
* The lookup, for a test that is *Needs review* or *Validation failed*, using its latest run that did not pass:
  1. Window: from two minutes before the run started to two minutes after it ended (`start` and `end`, UTC, to the second;
     `statsPeriod` is not used).
  2. One `GET /api/0/projects/{organization}/{project}/issues/` with `start`, `end`, `limit=25`, `sort=date` and
     `query=is:unresolved`, with the token as a Bearer header. Only `GET` is ever sent.
  3. Only the fields below are read from each issue; everything else Sentry sends (event data, stack traces, tags, users,
     breadcrumbs, metadata) is dropped by the schema before anything is stored or shown: id (digits), title (cut to 300),
     level, event count, first and last seen, the link, and the `culprit`, which is used only to compare with the failed request and is
     never returned. Items that do not fit are skipped; an answer that is not a list is reported as a problem.
  4. Issues that were not around during the window (last seen before it opened, or first seen after it closed) are left out.
  5. The rest are ranked by points (`src/platform/sentry/match.ts`, `WEIGHTS`), the five best are returned:

     | Evidence | Points |
     | --- | --- |
     | The issue's location (culprit) is exactly the path of a request that failed in the run | 100 |
     | Its title or location mentions that path as a whole path (not `/v2/api/cart`, not `/api/cart-items`) | 60 |
     | Sentry saw it for the first time inside the window (a new error) | 40 |
     | Level `error` or `fatal` | 10 |
     | Event count: `floor(log10(count + 1) * 2)`, at most | 8 |

     Ties go to the most recently seen, then the lowest id, so the same input always gives the same answer.
  6. Failed request paths come from the recorded failure evidence of web tests (the same stored, redacted file as
     `GET /api/tests/:id/evidence`), from `GET /api/x` style text in the failure message, and from the path or address of the
     step that failed (for a test that uses reusable steps, the step that actually ran: a run's step numbers follow the steps with the reusable steps put in place, not the small list the test stores). Query strings are ignored, case is ignored.
  7. Each issue comes back with a **reason in plain words** built only from what is true of it ("First seen 40 seconds
     into the failed run", "Was active while the test ran", "mentions /api/cart, which failed in this run").
* The link of an issue is the one Sentry gave when it is a web address, otherwise one built from the connection
  (`{baseUrl}/organizations/{org}/issues/{id}/`), so a hostile `javascript:` link is never shown.
* Limits and failure: answers are cached in memory (never on disk) per test and run for **10 minutes**, so reopening the page
  costs nothing; two page views at once make one request; the timeout is **8 seconds**; a network error or a 5xx answer is tried
  **once more**, a timeout, 401, 403, 404 and 429 are not; failures are not cached. A problem on Sentry's side is never an error
  status: the answer is `200` with `state: "unavailable"`, a `code` and a plain `message`.
* Code: `src/platform/sentry/` (`match.ts` pure ranking, `client.ts` read-only client, `store.ts`, `related.ts` lookup and
  cache), `src/platform/routes/sentry.ts`; UI in `web/src/features/sentry/`.
* **Issue text**: when the test page has already looked up related errors for the failed run (the cached answer), the issue
  body for GitHub, Jira and Notion gets the top one as a link, worded "might be related ... that does not mean it caused it".
  Creating an issue never asks Sentry itself, so nothing is added when nobody looked.

### API

| Call | What it does |
| --- | --- |
| `POST /api/projects/:id/integrations` with `{ kind: "notion", databaseId, titleProperty?, token, apiUrl? }` | Connect Notion (`verify: false` skips the real check). `201`, no secret in the answer. `databaseId` may be a pasted link. |
| `PATCH /api/integrations/:id` | Also accepts `databaseId` and `titleProperty` for Notion. |
| `GET /api/projects/:id/sentry` | `{ connected: false }` or `{ connected: true, connection: { id, name, baseUrl, organization, project, createdAt } }`. |
| `PUT /api/projects/:id/sentry` | Body `{ organization, project, token?, baseUrl?, verify? }`: connect or replace (`201` / `200`). `token` may be left out only when a connection exists. `502` with `{ error, details: { code } }` when the check fails; `400` for a bad name or a blocked address. |
| `DELETE /api/projects/:id/sentry` | Disconnect (`204`, `404` if none). |
| `POST /api/projects/:id/sentry/test` | A real call: `{ ok: true, message }` or `{ ok: false, code, message }`. |
| `GET /api/tests/:id/sentry[?refresh=1]` | `{ connected: false }`, or `{ connected: true, state: "ok", issues: [{ id, title, level, count, firstSeen, lastSeen, url, reason }], note, checkedAt, cached, window }`, or `{ connected: true, state: "unavailable", code, message }` (`not_failed`, `not_run`, `unauthorized`, `forbidden`, `not_found`, `rate_limited`, `unreachable`, `rejected`, `blocked`). Always `200` once the test exists. |

## Limits

* Notion: one page per test and connection, created and not kept in sync. Only the title column is set; other
  columns stay empty (if Notion refuses a page for that reason, its own message is shown). Pages are created in the database
  itself, not inside another page.
* Sentry: "might be related" is by time and by address only. A failed run that touched no address Sentry knows (a purely visual
  failure, a timeout with no request) is matched on time alone, which is weak, so the list may be empty or generic.
  Dynamic paths (`/api/cart/42` against `/api/cart/:id`) are not normalised; only unresolved issues are asked for;
  at most 25 are fetched and 5 shown; the recorded evidence exists for web tests only (API tests use the failure message and the
  request step).
* No event bodies, stack traces, users, tags or breadcrumbs are fetched into the platform or shown; to read those, follow the link.
* Verified against local receivers that implement the documented Notion (databases, pages, error bodies, size limits) and Sentry
  (project issues, project details, 401/403/404/429/5xx, slow answers, extra fields) endpoints, not against notion.com or a
  live Sentry. Which exact read scopes your Sentry needs for these two endpoints was not checked against Sentry
  here; **Test Sentry connection** (and the "isn’t allowed to read this project" message) tells you if a token is too narrow.
