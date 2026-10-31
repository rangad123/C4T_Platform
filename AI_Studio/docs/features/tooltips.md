# Tooltips and in-place explanations

A first-time tester should understand every non-obvious control, status, number and setting without leaving the page. Round 19 adds
one tooltip primitive, a "?" help button, one file of definitions, and wires them into the shared components. This page is for people
who write UI code: how to use them, how to write a tip, and where the words live.

## What the tester sees

- **Hover a control or status** (mouse): after a short pause (0.4 s) a small dark panel says what it does or means. Moving to the next
  control shows the next one at once. Moving away, scrolling, pressing the control or Escape closes it. (A panel opened with the
  keyboard follows its control while the page scrolls, since tabbing scrolls the control into view, and closes when it leaves the window.)
- **Tab to a control** (keyboard): the panel opens at once and is read by screen readers as the control's description. Escape closes
  only the panel: a dialog or menu around it stays open.
- **Icon-only buttons** (the bin, the cross, "More actions") show their name, then what they do.
- **A "?" next to a field, setting, heading or number** opens the explanation on hover, on keyboard focus, and on a tap (phones):
  a second tap, a tap elsewhere or Escape closes it.
- **Statuses explain themselves**: every test status, severity, job (exploration/run) badge, run ribbon tick and metric with a "?" uses
  the same definition everywhere.
- **Lists and tables explain their badges with one "?"** (round 21): badges in rows are not tab stops (a list of 200 tests would get 200
  stops), so each list or table with status-like badges has one "?" beside its heading or in its status column heading. It lists the
  values that list shows right now (only those), each with its definition: for example "Passing: The last run of this test passed…",
  "Failing: …", "Low severity: Minor…". Keyboard, screen reader and touch all reach it.
- **A disabled button that says why can be reached with Tab** (round 21): a button with a tip that is disabled (for example
  "Save or discard your changes first") stays in the tab order, so the keyboard can read its reason. Pressing it does nothing (no
  click, no form submit), it looks exactly like a disabled button, and screen readers announce it as unavailable.

Nothing essential is hover-only: instructions, limits, warnings and validation stay visible text. Tooltips never cover an open menu,
never take a click, and are not shown for touch (the "?" is the touch path).

## Using it (web/src/components/Tooltip.tsx)

```tsx
import { FieldHelp, HelpTip, Tooltip } from "../../components/Tooltip";
import { help } from "../../lib/help";

<Tooltip content="Downloads every result of this run as a CSV file."><a className="btn" href={csv} download>Export</a></Tooltip>
<Button tip="Starts a run of every test in this project.">Run all</Button>        // shared components take `tip`
<Button iconOnly icon={Trash2} aria-label="Delete step 1" tip="Removes this step; Undo brings it back." />
<Metric value="94%" label="Latest pass rate" tip={help("metric", "latestPassRate")} />
<HelpTip label="Requests per second" text="The most requests the assessment sends each second." />
<FieldHelp htmlFor="rps" label="Requests per second" help="…" hint="Between 1 and 10." />  // hint stays visible, id "rps-hint"
<BadgeKey label="the badges in this list" entries={[...statusKey(rows.map((t) => t.validationStatus)), ...severityKey(rows.map((t) => t.severity?.severity))]} />
```

- `BadgeKey` (round 21) is a HelpTip named "About <label>" whose panel lists one line per entry (`{ word, text }`; empty or repeated
  words are dropped, nothing at all renders nothing), in a wider panel (360 px). Build the entries from the rows the list shows, so it
  explains only the values present: `statusKey`, `severityKey`, `jobKey` (ui.tsx), `severityKey`, `validationKey`, `stateKey`,
  `authKey` (security/SecurityChrome.tsx), `findingKey` (security/Overview.tsx), or `keyEntries(order, present, word, text)` for any
  word table (it keeps the order of `order`). Put it beside the list's heading, in the status column's `<th>`, or in the page subtitle,
  never inside a heading element (the heading's name would grow by "About …"). `tests/tooltips-unit.test.ts` fails when a file shows
  a status badge outside the tab order and has no BadgeKey.
- `Button` with `tip` and `disabled` (or `loading`) renders `aria-disabled="true"` instead of the `disabled` attribute and cancels the
  click (`preventDefault` and `stopPropagation`), so neither its handler, a click handler around it nor its form's submit runs, also
  for Enter in a field of that form. Without a tip a disabled Button keeps `disabled` as before. Playwright's `toBeDisabled()` and
  `click()`'s actionability check treat both the same.

- `Tooltip` props: `content`, `placement` (top, bottom, left, right; default top; flips and shifts to stay on screen), `delay`
  (default 400 ms), `disabled`, `strict` (stay on that axis, hidden when it does not fit: tips beside a menu), `describe` (default
  true; false when the tip only repeats the accessible name, like the ribbon). The child must be ONE element that can take focus;
  it keeps its own handlers and ref.
- `HelpTip` is named "About <label>" and `FieldHelp`'s HelpTip "About <helpLabel>" (default: the field label without a trailing
  "(optional)"-style note). Because that name contains the field's words, a test that finds a field with `getByLabel` must pass
  `{ exact: true }`, or the help button matches too.
- Shared components (`web/src/components/ui.tsx`): `Button` and `LinkButton` take `tip` (external `LinkButton`s say "Opens in a new
  tab." by default); `iconOnly` buttons show their `aria-label`; `Menu` takes `tip` for its trigger and never shows it while open;
  `MenuItem` takes `tip` (beside the menu only; `description` is the visible line); `Badge` takes `tip` (the older `title` now shows
  as the tooltip; `tipFocusable` makes a lone badge a tab stop); `StatusBadge`, `SeverityBadge` (definition plus "Rated from: …") and
  `JobBadge` show their definitions automatically; `Metric` takes `tip` (a "?" beside its label); `Ribbon` names the verdict under
  the pointer.
- The panel is rendered in a portal: into the open `<dialog>` around the element (the dialog is in the browser's top layer), else
  into `<body>`, with fixed position, so cards, tables and scroll areas never clip it. It has `role="tooltip"`, is `aria-hidden` (screen
  readers hear it once, as the description of the element via `aria-describedby`), and `pointer-events: none`. One is open at a time.
  It appears fully opaque at once, with no fade (a fade made accessibility checks that ran mid-fade measure a half-transparent
  panel), so there is no motion to reduce. Light theme: ink panel; dark theme: light panel.

## Writing a tip

Say what happens, why, or what a value means, in one short sentence (two at most), in the decided vocabulary (Passing, Failing, Needs a
look, Not run yet, Exploration, Run, Runner, Shared elements, Reusable steps, Code test, Repair, Auto-fix, Run sequence).

| Good | Bad (why) |
|---|---|
| "Removes this step; Undo brings it back." | "Delete" (repeats the label) |
| "Downloads every result of this run as a CSV file." | "Click here to export" (says nothing; "click here") |
| "Tests that passed, out of the tests that produced a result in that run. Tests not in the run and tests in quarantine are left out." | "Pass rate" (repeats the label) |
| "Stops the run. Results recorded so far are kept." | "Are you sure?" (a confirmation belongs in a dialog, not a tip) |
| "Nobody has checked this finding yet. It counts as open." | "Needs review" (old word, no meaning) |

Only add a tip where purpose, behaviour, meaning or consequence is unclear. Do not tip every field; do not add a tip to a word that
`<Term>` already explains (GLOSSARY in `labels.ts` is for words; `help.ts` is for values and states).

## Where the definitions live (web/src/lib/help.ts)

One file, grouped by what decides the value, each written from that code: test status (`VALIDATION`, the validator), severity of a
finding on a test (`validation/severity.ts`), a test's state in one run (`platform/run-view.ts`), ribbon ticks, job status and
`jobHelp(job)` (same branches as `jobLabel`), exploration steps, schedules (`scheduler.ts`: started, skipped, error), deploy trigger
tokens, runners (online = heard from in the last 45 seconds, `agent-store.ts`), phone states (adb, phone tools), device-farm results,
and the Security Assessment: assessment states, finding validation states, severity, confidence (`findings/normalize.ts`: high = a
known rule matched; high with evidence starts as Probable), categories, risk levels (the rules in `findings/overview.ts`),
authorization states, and the numbers (`engine/summary/pass-rate.ts`, `trends.ts`, the security overview counts, compliance).
Round 22 added the states and reasons of rounds 20-21: a saved sign-in's state for a signed-in assessment (`signIn`: ready,
not checked yet, expired, missing, saved for another site, cannot be read; `security/signin.ts`), why an assessment message was sent
(`notifyReason`; `security/notify.ts`), what an assessment does with each operation of an uploaded API document (`apiOperation`;
`security/api-document.ts`), and per-project access (`projectAccess`: All projects or Only these projects; `projectRole`: a role in one
project, from the route rules in `auth/roles.ts`). They are shown by BadgeKeys beside the sign-in choice, the API document's operation
count, the recent messages and the security Activity list, and in the People screen's Access and role tips. `tests/tooltips-unit.test.ts`
compares each of these groups with the union the server code declares, so a new state fails until it has a sentence.

`help(group, key)` is typed (a wrong key is a compile error); `helpFor(group, value)` takes a string from an answer and returns
`undefined` when there is no definition. Enum groups are typed `Record<TheEnum, string>`, so a new enum value fails the typecheck
until it has a sentence. To add one, put it in the right group and run `tests/tooltips-unit.test.ts`.

## Checks

- `tests/tooltips-unit.test.ts` (fast tier, no browser): every `iconOnly` Button/Menu in `web/src` has a name; every definition is a
  sentence of at most two, not its key, no "click here", no old vocabulary; literal tips at call sites are not empty, not the visible
  label, at least 12 characters (a Tooltip that names an icon-only control is allowed); `ui.tsx` and `Tooltip.tsx` put no native
  `title=` on elements; the badges read help.ts; help.ts covers every value of `ValidationStatus`, `JobStatus`, `PhaseState`, run
  states, the security contract's enums, the security pages' word tables and the risk levels (each risk definition matches its rule);
  placement flips and shifts inside the window.
- `tests/tooltips-ui.test.ts` (browser, port 7230, a harness page built from the shared components with Vite): hover delay, instant
  move between tips, keyboard focus and Escape, icon-only names, badges and metrics, ribbon, not clipped by a scroll container,
  inside a dialog (Escape closes the tip and not the dialog; the dialog still works), a menu still works and no tip covers it,
  FieldHelp, reduced motion, axe in light and dark with tips open, a list's BadgeKey (one stop, only the values shown), a disabled
  Button with a tip (Tab reaches it, it says why, Enter, Space, a click and Enter in its form's field do nothing), and on a 375 px
  touch screen: tap on "?", no hover tips on touch, no sideways scroll. Since round 21 the whole file runs in **Chromium, Firefox and
  WebKit**, each when Playwright's build of it is installed (otherwise that group is skipped and its name says why; nothing is
  downloaded). Firefox's phone context has touch but no `isMobile` (Playwright does not emulate mobile Firefox).

## Limits

- A disabled **Button with a tip** is reachable by keyboard (above). Other disabled controls (a plain `<button disabled>`, a
  disabled `MenuItem`, a disabled input or radio) still cannot take focus, so a tip on them shows on hover only. A reason a person
  needs must also be visible text.
- Badges are not tab stops by default (a list would get one per row). **The rule:** pass `tipFocusable` when the badge is the one
  status of a page or panel: the header of a test, a run, an exploration, an assessment or a finding, and a card that shows one status.
  Leave it off in lists and tables and give the list a `BadgeKey` instead (round 21: tests, needs attention, all runs, a run's tests,
  projects and the fleet dashboard, runners' devices and tokens, schedules, alert channels and deliveries, unreliable tests, releases
  and their history, run sequences and their earlier runs, environments and results per environment, farm sessions, a test's history,
  people and activity, the evaluation table, and the Security Assessment's applications, assessments, findings, overview lists and
  delivery list; round 22: the security Activity list, the saved sign-in choice and the API document's operations).
- A disabled Button with a tip is now a tab stop, so its tip should say why it is disabled while it is: round 22 made the tips of
  "Upload API document", "Restore as a new project", "Use defaults" (a run in progress) and "Check" (a script too long) say so. A badge's own text that is only in its tip for one row (the projects a person sees, a deploy's commit) is still
  mouse-only; the key says what the badge means, not that row's detail.
- Links are not Tab stops in WebKit by default (as in Safari, where Option+Tab reaches them, or Tab once "Press Tab to highlight each
  item" is on), so there a tooltip on a link opens from the keyboard that way; buttons and "?" are Tab stops in every engine.
- Native `title` attributes outside `ui.tsx` are replaced by the area work of this round, page by page; any that remain are not
  keyboard or touch accessible.
- The tooltip is checked in Playwright's Chromium, Firefox and WebKit builds (desktop and touch) on Windows; no difference in
  positioning, focus, Escape or touch needed a code change. Real Safari on a Mac or iPhone, and real phones, were not run here.
  Most feature pages' own UI tests run in Chromium only (`npm run test:ui:browsers` runs the smoke and flow tests in all three).
- Wording in other languages, the PDF/HTML report printouts and the CLI are not covered.
