# Navigation: six places with one job each

What changed for the tester: a project has six places (Overview, Tests, Runs, Library, Release, Setup) instead of eight tabs plus pages with no tab, one **New test** menu instead of five creation buttons, and a small **More actions** menu instead of sixteen entries. Nothing was removed; every page moved to the place that matches its job, and old links still open.

## The places

| Place | Job | Holds |
|---|---|---|
| Overview | Is it healthy, and what needs me? | result, ribbon, Needs your attention (top 5), next scheduled run, cleanup note when records were left behind. The Storage and backup form is gone from here. |
| Tests | What do we check? | list, search, status filters (Passing, Failing, Needs a look, Not run yet), **Run**, **New test**, **More actions** (Import tests…, Export…, Check other browsers & screen sizes), Select (UX-A). |
| Runs | What happened and when? | sections All runs, Schedules (with run sequences), After a deploy, Trends (trend chart and unreliable tests). One run opens at `#/projects/:id/runs/:jobId` as before. |
| Library | Things my tests share | Reusable steps, Shared elements, Helpers (code), Test data (with the records tests create), Test accounts; one search over the three that have names. |
| Release | Can we ship? | Releases, Manual checks, Compliance. One release opens at `#/projects/:id/release/:releaseId`. |
| Setup | Where and how do tests run? | Runners, Environments, Frameworks, Mobile app, Alerts, Issue tracker, Storage and backup. |

A place with sections shows its title, the tab bar, then a labelled row of sections (`nav` named "Runs sections", and so on) and the chosen section. The section is an existing page drawn *embedded*: it keeps its content and drops its own title, tab bar, breadcrumbs and document title, which the place owns (`web/src/lib/embedded.ts`, used by `PageHeader`, `ProjectTabs`, `usePage`, `useDocumentTitle`). Only the open section is mounted. The open section is in the address (`?section=`), so a link or a reload lands on it.

Rarely changed settings (Frameworks, Mobile app, Storage and backup) are a titled row with a one-line summary and **Change**; the form opens under it. Runners shows connected runners first; installing one is behind **Add a runner** (open by itself while no runner has connected).

## New test and More

**New test** (Tests page, also in the empty state) lists, in three groups, with one line each: Describe it (AI), Record it in a browser, Build steps by hand, Write it as text, Write code, Import tests… (JSON file, Maestro flows, Git repository). Each entry opens the dialog or page that existed before; only the entry points moved (`web/src/features/authoring/NewTestMenu.tsx`, `ImportExport.tsx`). The menu entries have a name (the title) and a description (the line), so a screen reader reads the title first.

**More actions** has Import tests… (the same chooser), **Export…** (one dialog for the Playwright zip, JSON, PDF report, web-page report, JUnit results) and Check other browsers & screen sizes.

## Sidebar and Projects

The sidebar has Projects and Settings only. **New project** is an action in the Projects page header (one project or several); with no project the Projects page is the new-project page.

## Old links

`web/src/lib/aliases.ts` is a table (`ROUTE_ALIASES`) of every address of the earlier eight tabs and the pages without a tab; `App` in `main.tsx` replaces such an address (history is replaced, not pushed) with the new one:

| Old | Now |
|---|---|
| `/projects/:id/schedule[?run=]` | `/runs?section=schedules[&run=]` |
| `/runners` | `/setup` (Runners) |
| `/objects` | `/library?section=elements` |
| `/blocks[?edit=]` | `/library[?edit=]` |
| `/helpers` | `/library?section=helpers` |
| `/releases[/:releaseId]` | `/release[/:releaseId]` |
| `/manual-cases` | `/release?section=manual` |
| `/compliance` | `/release?section=compliance` |

`?quarantine=1`, `?quality=weak`, `?status=` and `?git=1` on the Tests page work as before. Links the platform writes into messages (run sequences link to `/schedule?run=`) go through the table.

## Vocabulary left over from the explain-in-place work

The run that was stopped reads "This run was stopped" and the badge "Stopped" (was "This analysis was cancelled" / "Cancelled"). Platform sentences a tester sees say "code test" instead of "hand-written test" and "Edit the code" / "Switch the test to code first" instead of "Edit the script" / "Take the test over first". The pass-rate sentence says "could not be run" instead of "could not be validated" (`src/engine/summary/pass-rate.ts`, the dashboard reason).

## Limits

- Library search covers reusable steps, shared elements and helpers by name; test data sets and accounts are not searched.
- The empty states inside a section (for example "No schedules yet") are the sections' own and were not merged into one line.
- "Check other browsers & screen sizes" stays in More actions: its panel shows a result matrix the Run panel does not.
- Sentences produced by the command line (`ai-test`), the reports, the MCP tools and the runner program still say "could not be validated" and "hand-written scripts"; they are not part of the web UI and their golden files pin them.
