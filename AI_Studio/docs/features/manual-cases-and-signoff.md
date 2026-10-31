# Manual test cases and release sign-off

Automated tests cover a lot, but teams also check things by hand (how a page looks, a printout, a device, "ask the finance team") and
need an explicit decision before a release goes out. This feature adds **manual cases** that live next to the automated tests, a
**release** that combines both, and a recorded **sign-off**. It calls no AI model and contacts no application; it only reads what the
platform already stores.

## What you see

Every project has a **Releases** tab.

* **Releases** lists the project's releases, newest first, each with its state (Open, Approved, Rejected) and one sentence such as
  "3 of 14 manual checks left, automated tests ready". With no release it explains what a release is.
* **Manual cases** (button on the tab) is where you write the checks: title, area, priority (critical, high, medium, low), steps
  (what to do, what should happen, up to 30), an optional requirement and optional related automated tests. Add, edit, delete,
  **Import** (CSV or JSON file) and **Export** (CSV or JSON).
* **A release page** shows, top to bottom:
  1. the sentence "Release 2.4: 3 of 14 manual checks left, automated tests ready";
  2. **Automated tests**: the run ribbon, the verdict (Ready, Needs attention, Blocked, Unknown) with the same reasons the
     projects dashboard gives, pass rate, findings, unreliable tests and breaking API changes;
  3. **Manual checks** grouped by area, each with five result choices (Not run, Passed, Failed, Blocked, Skipped) as a radio group
     (arrow keys work), an optional note, who set the result and when; a failed check can **create an issue** in the project's
     connected issue tracker;
  4. **Sign-off**: what blocks an approval and what is only a warning, and the Approve and Reject buttons (a dialog asks for your
     name, and for a comment when an override is needed);
  5. **History**: every approval, rejection and reopening, with who, when and the comment.
* **Download report** saves the sign-off as one self-contained HTML page.
* The projects dashboard row has a **Releases** link.

## How a release works

* **Opening** a release (`name` up to 80 characters, optional notes) records how the automated tests look at that moment. The state
  comes from the same function as the dashboard (`buildDashboard`), so the two always agree.
* While a release is **open** its automated state is **live** and its checklist always lists the project's current manual cases (a
  case added later shows as Not run). **Refresh automated results** stores the current state again.
* **Signing** (approve or reject) **freezes** the release: the automated state and every manual check, with its result, note and
  name, are kept as they were. Later runs, edited cases or deleted cases do not change a signed release. Results cannot be changed
  and the release cannot be signed again. (Filing an issue for a failed check is still allowed: it only adds a link.)
* **Reopening** a signed release needs a name and a comment, makes it open again and is recorded.
* The platform has no user accounts. "Who" is the free-text name the person types (up to 80 characters); it is remembered in the
  browser so it is typed once. Treat it as a record, not as proof of identity.

The automated block shows the last run's pass rate with what it is made of ("Last run: 17 of 17 tests that ran passed. 6 other tests did not take part in that run. Across all 23 tests right now, 6 could not be validated."), so the percentage and the ribbon under it never contradict each other. The wording comes from the platform (`automated.latestRun.sentence` and `.others`); the printed report uses the same sentences.

## Sign-off rules

A manual check is **left** when it is not run or blocked. Skipped counts as done: someone decided to skip it.

| | Rule |
|---|---|
| Stops an approval | The automated tests are **blocked** (an open critical or high-severity finding, or the last run failed) |
| Stops an approval | Any manual check has **failed** |
| Stops an approval | Any **critical or high-priority** manual check is not run or blocked |
| Only a warning | The automated tests **need attention** |
| Only a warning | There is no automated information yet (state **unknown**) |
| Only a warning | **Medium or low-priority** manual checks are not run or blocked |

* Approving while something stops it is refused with **409** and a plain sentence ("This release cannot be approved yet: 1 manual
  check failed."), and the answer carries `details.blocking` and `details.warnings`.
* It goes ahead with `override: true` and a **comment of at least 10 characters** (after trimming). The audit entry is marked as an
  override and keeps the reasons that were overridden. An override flag with a too-short comment is refused with 400.
* **Rejecting** never needs a reason (one is allowed) and is never blocked.
* The rules are a pure function (`src/engine/manual/signoff.ts`, `evaluateSignoff`), tested as a table, and are returned in every
  release answer as `signoff.rules`.

## The audit trail

Each approval, rejection and reopening appends one entry: who, when, the decision, the comment, whether it was an override, and what
the release looked like then (automated verdict and reasons, manual counts, blocking reasons, warnings). There is no way to edit or
delete an entry through the API, and the database refuses an `UPDATE` of an audit row. Deleting the whole project removes it.

## Import and export

* **CSV**: header row with a `title` column and optionally `area`, `priority`, `steps`, in any order; other columns are ignored.
  The `steps` cell holds one step per line as `action => expected` (a line without `=>` is a step with no expected result).
  Quoted cells, doubled quotes, line breaks inside quotes, CRLF and a byte-order mark are handled. A bad row (missing title,
  unknown priority, more than 30 steps, text too long) is skipped and reported by row number; the other rows are imported.
* **JSON**: a list of cases or `{ "cases": [...] }` (what the export writes).
* **Limits**: at most 500 cases per project; a file with more than 500 cases, or one that would take the project past 500, is
  refused as a whole. Text up to 2,000,000 characters. A case with the same title and area as an existing one is left out, so
  importing the same file twice adds nothing.
* **Export safety**: in the CSV, a cell starting with `=`, `+`, `-` or `@` gets a leading `'` so a spreadsheet never runs it as a
  formula; the import removes that quote again. In an exported step a line break becomes a space and `=>` becomes `->` (the one
  lossy spot, needed to keep one step on one line). The JSON export also carries the requirement and related tests.

## Issues for failed checks

`POST .../results/:cid/issue` with `{ integrationId }` creates an issue in a tracker already connected to the project (GitHub, Jira,
or any other kind the integrations code supports). The title is "[Manual check failed] ..."; everything a person typed (note,
steps, area, requirement) goes inside code blocks, never in running text, so a tracker cannot be made to link, mention or format
anything from it. One issue per check per release: asking again returns the existing one. Only a check whose result is Failed
qualifies (422 otherwise). A tracker that is down answers 502 and nothing is stored.

## The report page

`GET /api/projects/:id/releases/:rid/report?format=html` returns one HTML file with no script and no outside file: decision, the
sentence, automated state, manual results by area with notes, what blocked or warned, and the audit trail. Every typed text is
HTML-escaped and the response carries a `Content-Security-Policy` that forbids scripts. PDF is not offered.

## API

All under `/api/projects/:id` and behind the same API key as every other route. Every lookup is by project and id together: a
case or release of one project is a 404 through another.

| Method and path | What it does |
|---|---|
| `GET/POST /manual-cases` | list (with `total`, `max`, `areas`), add (201) |
| `GET/PUT/DELETE /manual-cases/:cid` | one case (delete answers 204) |
| `POST /manual-cases/import` | `{ format?: "json" \| "csv", content }`; answers `{ created, duplicates, skipped[], total }` |
| `GET /manual-cases/export?format=json\|csv` | file download |
| `GET/POST /releases` | list (`{ releases, manualCases }`), open one (201, full view) |
| `GET /releases/:rid` | the full view: `sentence`, `automated`, `manual.rollup`, `manual.items`, `signoff` (`blocking`, `warnings`, `canApprove`, `rules`), `audit` |
| `POST /releases/:rid/refresh` | store the automated state again (open releases only) |
| `PUT /releases/:rid/results/:cid` | `{ result, note?, by? }`; `note`/`by` absent keep the old value, an empty string clears (open releases only) |
| `POST /releases/:rid/results/:cid/issue` | `{ integrationId }`, see above |
| `POST /releases/:rid/signoff` | `{ decision: "approved" \| "rejected", by, comment?, override? }` |
| `POST /releases/:rid/reopen` | `{ by, comment }` |
| `GET /releases/:rid/report?format=html` | the sign-off page |

## How it is built

* `src/engine/manual/cases.ts` (types, validation), `csv.ts` (CSV/JSON read and write), `signoff.ts` (roll-up, rules, sentence):
  pure, tested in `tests/manual-unit.test.ts` (browser-free, in the fast tier).
* `src/platform/manual-case-store.ts` (migration slot 15: `manual_cases`, `releases`, `release_results`, `release_audit`),
  `manual-releases.ts` (snapshot from the dashboard, release views, sign-off and reopen), `reports/release-report.ts`,
  `issues/manual.ts`, `routes/manual-cases.ts`.
* UI in `web/src/features/manual/`; the Releases tab, the routes `#/projects/:id/releases[/:rid]` and
  `#/projects/:id/manual-cases`, and a "Releases" link in the dashboard row.
* Tests: `tests/manual-unit.test.ts`, `tests/manual-cases.test.ts` (real platform, seeded like the dashboard tests, a local
  GitHub-shaped receiver on port 5710), `tests/manual-ui.test.ts` (real browser, port 5711).

## Limits

* No user accounts: names are free text and not authenticated beyond the API key.
* A release cannot be deleted; there is no PDF; the report omits the written steps of each case.
* Related automated tests are stored on a case and shown in the editor and the JSON export; the release page does not yet list them.
* Issue creation is offered only with the project's first connected tracker in the UI (the API takes any connection).
