# Visual test builder (edit steps, build a test)

## What it does for a person
- **Edit steps** (button next to View code on a generated web or API test, `#/tests/:id/builder`): the steps of a test as a list in plain words. Open a step to change it, add steps from a grouped palette (Go to, Interact, Check, Wait; for API tests Request and Check the response), move steps (drag the handle, Move up / Move down buttons, or Alt+Up / Alt+Down on the step), duplicate, delete (with Undo).
- **Locator picker**: find an element by role and name, label, text, placeholder, test id or CSS selector, or pick a **shared element** from the project's object repository (the step then stores a reference, so a later fix to the element applies here too).
- **Values**: any text can use the project's placeholders (test values, the saved sign-in `{{credentials...}}`, `{{env.NAME}}`; names only, never values). A field that looks like a secret (password, one-time code, card number) only offers the saved sign-in values.
- **Script preview** beside the steps (read-only, collapsible), refreshed 500 ms after the last change. Problems are listed with a "Go to step N" button and a badge on the step.
- **Save and run** stores the steps, renders the script again and queues the normal validation run; the status line goes Queued, Running, Passed or Did not pass. **Discard changes** goes back to the saved steps. Leaving with unsaved changes asks first (links) or shows the browser warning (closing the tab).
- **Take over as code** opens the existing take-over dialog for people who need more than steps.
- Version history (button next to Add a step): lists the saved versions of the steps (version 1 is the test before the first edit, the newest is marked Current, at most 20 are kept), compares one version with the newest or any two, step by step in plain words (steps added, removed, changed, moved, plus a new test name or test values; colour is backed by a symbol and a word), and **Restore this version**. Restoring saves the old steps again through the normal save (`PUT /api/tests/:id/spec`, note "Restored version N") as a new newest version, replaces unsaved changes in the editor after a confirmation that says so, and follows the run like Save and run. Nothing is deleted; restoring steps that are already current changes nothing. Only available while the test can be edited (not read-only, no run in progress).
- **Build a test** (Tests page): title, kind (web or API), optional area. The test starts with one valid step (open the application's address, or a GET request) and opens in the editor. It is not run until the first save.
- Read-only: a hand-written test is not edited here (the page links to the script editor); while a run is in progress the steps are shown with Try again; only web and API tests are edited.

## How it works
The canonical spec stays the source of truth. The editor sends the whole spec back; the platform replaces only what the editor owns (title, steps, test values) and always takes the test id, kind, area and origin from the stored test. A save is all-or-nothing: the spec is checked, rendered, and only then stored; the script is rendered again from the stored spec for every framework the test has a script for, history is kept and a validation job is queued (or the answer says why not).

### API (all API-key protected like the rest)
- `GET /api/tests/:id/spec` returns `{ testId, projectId, key, kind, title, validationStatus, spec, editable, reason?, busy?, custom?, kinds, placeholders, versions }`. `kinds` lists what the schema offers (actions per kind, checks, locator strategies, methods, roles, limits); `placeholders` lists names only.
- `PUT /api/tests/:id/spec` body `{ spec, note? }` returns `{ testId, scriptVersion, changed, diagnostics, jobId, note? }`. Nothing changed means no new version and no run (`changed: false`). 422 `{ error, diagnostics }` when invalid (nothing saved); 409 for a hand-written test, an unsupported kind, no application, or a run in progress.
- `POST /api/tests/:id/spec/preview` body `{ spec }` returns `{ ok, script, filename, diagnostics }`. Stores nothing; invalid specs return `ok: false, script: null`. At most 5 a second per client.
- `GET /api/tests/:id/spec-versions` and `/:version`: earlier steps (version 1 is the test before the first edit; at most 20 kept).
- `POST /api/projects/:id/built-tests` body `{ title, kind: "web" | "api", startUrl?, category? }` returns 201 `{ testId }`.
- A diagnostic is `{ stepIndex?, message, severity: "error" | "warning" }`; warnings (for example a `{{name}}` nothing defines) do not stop a save.

### Rules checked on save and preview (src/engine/builder/index.ts)
The schema, then: at most 100 steps, 2000 characters per text, 30 test values; the actions that fit the kind (no request step in a web test); every locator and required field filled in; shared elements must exist in this project and fit the kind; every address a step can reach passes the same outbound guard as an imported spec; no literal secret: a fill into a secret-looking field must use a `{{credentials...}}`, `{{secret...}}` or `{{env...}}` placeholder, secret headers likewise, and key or token patterns are refused anywhere in a step or test value. Secret rules apply to steps that were added or changed, so an older test with such a step keeps working when someone edits another step.

### Storage
One migration (slot 23, `src/platform/spec-version-store.ts`): `spec_versions`. Audit entries go to the existing custom-scripts audit table (`edit-steps`, `build`).

## Limits
- Web and API tests only (not mobile, desktop or hand-written tests).
- No match count for a locator: no cheap source exists outside a live recording, so none is shown.
- Not yet: a way to compare your unsaved changes with a saved version (compare saved versions only).
- A step the editor does not know can be moved, duplicated or deleted, not changed.
- `{{data.x}}` from the brief does not exist in the platform: values are `{{name}}` for a test value or data set column.
- Not verified here: very long tests (100 steps) in the browser, drag and drop on touch screens (the Move buttons are the touch path).
