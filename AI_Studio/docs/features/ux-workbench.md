# The test workbench (UX-B)

What changed for the tester, the decisions behind it, and what is not covered. Code: `web/src/features/workbench/*`; the step editor (`features/builder/BuilderPage.tsx`) and the text view (`features/dsl/TextMode.tsx`) now live inside it.

## What the tester sees

**One page per test, four tabs, the tab is the route.** `#/tests/:id/steps`, `/text`, `/code`, `/history`. The bare `#/tests/:id` opens Steps. `#/tests/:id/builder` still works and is redirected to `/steps` (Back keeps working); `#/tests/:id/code` is the Code tab itself. The tab strip is a real `tablist` (arrow keys, Home and End); on a phone it scrolls sideways inside itself. The header (name, verdict in the decided words, last run time, where the test came from, **Run** with its arrow, and a **More actions** menu with Quarantine or Release, Download script and Create mobile version) and the **results column** stay put when the tab changes. Duplicate and Delete are not offered: the platform has no such action for a test, and the page does not invent one.

**Steps.** What the test checks, then the step editor (palette, locator picker, reusable steps, Use as shared element) with the **generated script on the right** (test first, setup code folded). After a run each step carries a mark and a word for screen readers (passed or failed). The failing step is highlighted and shows its message; the failure summary sits beside it. Marks are shown only while they are true: after an edit was saved following that run they are not shown, and a step edited on screen says "edited since that run".

**Save and Save and run are two buttons.** Any change shows a bar that follows the tester across tabs: "2 unsaved changes", **Preview changes** (a step-by-step difference, or a line difference for text, or both when the steps and the text were both changed), **Discard changes** (asks first), **Save** and **Save and run**. Save stores a new version and starts no run; the test then says "Not run yet" and the bar after the save says so. Saving needs a valid test: when it cannot, the bar says why in a sentence. After a save a bar says "Saved version 3. The test is running." with **Undo**, which saves the version before it again (a new version; nothing is deleted). Undo is offered only when the version really is the newest and nothing is unsaved.

**Text, for every generated test.** The text is the same test as one line per step. A step that has no phrase appears as a `# not expressible: step N, …` line, and the text is read-only because saving it would lose that step. The page says so, lists what has no text form, and offers **Edit the steps** and **Switch to code**; it never refuses to show the test. Unsaved steps appear in the text and the other way round when the text reads. Text that does not read stays where it is, names the line, and the route does not move. A code test has no text form: the Text tab says so and links to Code.

**Code.** A generated test shows its script read-only with **Switch to code** and what stops (the dialog from before: repairs, shared-element updates, the steps stop driving the test; you can go back). A code test shows the editor with live checks, versions, the run policy message and **Go back to the generated version**, in the page. View technical details (the test as JSON) is here.

**History.** One list, newest first: versions of the steps (the original, edits, edits as text, restores and undos), versions of the code (switched, edited, from Git, restored), runs (result, attempt, time, a link to the screenshot of a failed run when it still exists), repairs applied or dismissed, an auto-fix, an import, quarantine. Tick two versions of the same kind to compare them (a step difference for steps, a line difference for code; steps and code cannot be compared with each other, and the page says so). **Restore this version** saves an old version as the newest and runs the test, after saying so.

**Results column.** The live run strip, then the last result, **Undo my last edit** (only when a run passed, then the steps were saved, then a run did not pass, and an earlier version exists; the text says which version it goes back to), what failed (expected and got, evidence, what you can do), the runs of this test as a strip, evidence, and the cards that belong to a result (repair, issue tracker, other browsers, speed, test data it created, quarantine). A run started or finished anywhere updates the page by itself.

States: loading skeleton, error with Try again, "A run is in progress" (the steps stay readable and Try again works once it ends), keyboard path, 44 px targets, light and dark, 375 px with the results under the work.

## How it works

- `test-model.ts` holds every statement the page makes, as pure functions with unit tests (`tests/workbench-unit.test.ts`): which marks are current, when Undo my last edit is true, the change count, the history list, which two versions can be compared.
- The step editor and the text view are one component with two views (`StepsEditor`). Work in progress is kept while another tab is shown: a tab is built the first time it is opened and then only hidden.
- The platform got one additive option: `run: false` on `PUT /api/tests/:id/spec` and `PUT /api/tests/:id/dsl` saves without queueing a run (the answer has `jobId: null` and a note). The default is unchanged.
- Undo and Restore use the existing spec versions (`GET /api/tests/:id/spec-versions`) and the normal save. History merges `spec-versions`, `script-versions`, the test's executions, healing proposals and quarantine history; nothing new is stored.

## Decisions

- History dates come from what is stored: an auto-fix is dated by the first passing run, an import by the first script or the Git import time.
- A repair that is only proposed is not history yet.
- Undo my last edit needs an earlier passing run, so an edit is never blamed when nothing had passed before it.
- The bar offering Undo after a save is hidden while there are unsaved changes, so Undo cannot discard them silently.

## Not covered

- The platform stores no per-step results for runs older than the latest, so only the last run marks steps. History shows older runs as a whole.
- Results of a run started elsewhere appear after the platform finishes it (polled every few seconds), not step by step.
- The text and steps of one test share one set of unsaved changes; the count is the larger of the two, not their sum.
- No duplicate or delete for a test (the platform has neither).
- An auto-fix has no step diff (the platform keeps each attempt's result, not the earlier steps).
- Compare works between saved versions only (the unsaved preview is separate).
- Inside a use of reusable steps the Steps tab lists the steps as written (with `{{values}}` not yet filled in) and gives one mark for the whole use; the earlier test page listed the steps that really ran with each one's result.
- The Steps tab shows the "Use as shared element" action on every web step, as the earlier test page did.

## Tests

`tests/workbench-unit.test.ts` (pure functions), `tests/workbench-api.test.ts` (Save without a run, real routes), `tests/workbench-ui.test.ts` (real Chromium against a real platform and the sample app, ports 6470 and 6471: tabs and routes, keyboard, unsaved bar, Save and Save and run, Undo, text for every generated test, a failing run in view with expected and got, Switch to code and back, History and restore, read-only states, phone width, axe in both themes).
