# Project report (PDF or web page)

One document for people who will never open the platform: a manager, a client, a release sign-off.

**Tests tab → ⋯ More actions → Download report** (PDF) or **Download report (web page)**. The API is
`GET /api/projects/:id/report?format=pdf|html`.

## What it contains
- **Headline in words** ("1 finding (1 high) needs attention, and 1 test could not be validated"), the number of tests, pass rate, findings, tests not validated, tests not run yet.
- **Pass rate over recent runs** (a small chart, once scheduled or repeated runs exist).
- **What needs attention:** the most serious 15 findings with severity, what is wrong, and a screenshot where one was captured.
- **Tests that could not be validated**, **coverage by area**, **security control coverage** (indicative, not an assessment),
  **browser and screen-size differences**, **slowest pages**, **tests that check very little**, and the **full list of tests** with their result.
- Sections without content are left out.

The pass-rate tile is the share of tests that have a result (passed, found a problem or could not be validated). It is labelled with that count ("passed, of the 4 tests with a result") and a line under the tiles says how many tests have not been run yet and are left out. The dashboard and the release page use the same rule (see `dashboard.md`).

## Safe to share
- All text that came from the tested application, the AI or a user is escaped, so a hostile page title cannot inject markup into the report.
- It is one self-contained page with no scripts and no external assets; screenshots are embedded (at most 6, each under 350 KB).
- It never includes credentials, tokens or server file paths. (Test titles and findings are included as they are, so check them before sending outside your organisation.)

## How it works
Computed from stored results when you ask; nothing is stored. The PDF is made from the same page by the platform's own Chromium (A4, scripts off).
`src/platform/reports/project-report.ts`, `src/platform/routes/reports.ts`.

## Limits
- It reports the latest result of each test, not a history of every run (the chart shows the trend).
- A PDF needs Chromium on the machine that runs the platform (the same one used for testing).
