# Object repository: named, shared locators

Every test used to carry its own locators, so one renamed button broke (and one repair fixed) one test at a time. The object repository keeps **named elements** per project ("Cart / Checkout button") that tests refer to. Change the element once and every test that uses it follows.

## What you see

- **Objects tab** in every project: the elements grouped by page, each with its kind (web, mobile, desktop), the locator in words (`Button "Add to cart"`, `Test id: checkout`), and which tests use it. Tests that reach an element only through reusable steps (blocks) are counted and named too, as "Ada signs in (through the reusable steps “Sign in”)"; an element that a set of reusable steps holds, with no test using it yet, reads "Not used by a test yet. Held in the reusable steps “X”" and can't be deleted. Add, edit and delete from there. An empty project says: "Name the buttons and fields your tests use once, and fix them in one place."
- **Applies to N tests**: editing a used element shows how many tests follow the change. Saving re-renders their scripts and starts a normal validation run for them. If another run is in progress, or the project cannot be run right now, the tests are marked as waiting for a run (status "Not validated yet" with the reason) and the answer says so.
- **Find shared locators**: looks through the tests for locators that two or more steps spell out identically and proposes a named element for each (name from the accessible name, label, test id or role, with the page when every use is on the same page). You see the preview, can edit the names, and nothing changes until you press "Create shared elements".
- **On a test page**: a step that uses an element shows a chip "Shared: Cart / Checkout button" linking to the Objects tab; a step that spells its locator out has a "Make shared" action (name, and an option to use the element in every other step that finds the same element the same way).
- **Repair suggestions**: when a suggestion is applied to a step that uses an element, the element is changed (one fix for all tests). The suggestion says "This also changes N other tests" and the button names the number; the API requires the confirmation (`acceptSharedChange: true`). Steps without an element are repaired exactly as before.

## How it works

- An element: `name` (1-80 characters: letters, numbers, spaces and `/ . - _ & ' ( ) + , :`; unique per project ignoring case), `kind`, `locator` (the same shape a spec step uses, checked per kind: desktop elements cannot use css or placeholder), optional `page` and `notes` (up to 300 characters), timestamps and a `version` that grows with every change. At most 1000 elements per project.
- A spec step may use `{ "ref": "Cart / Checkout button" }` instead of a locator (any step with a locator: click, fill, select, check, press, hover, assert). The reference exists **only in the stored spec**. Before a spec is rendered or run it is resolved into the element's concrete locator, so a generated or downloaded script contains no reference and no dependency on the platform, and is byte for byte the script the locator written out would give.
- An unknown name, or an element of another kind than the test, is a plain error at save, import and render time ("This test refers to 'X', which is not in the object repository."), never a fallback. A step is either a concrete locator or a reference, never both.
- The engine works on resolved specs. A resolved locator keeps a note of its element, and `Repo.updateTest` folds it back to `{ ref }` whenever a spec is stored, so a run never copies an element's locator into the tests that use it. (A step the engine itself rewrote, for example an AI repair, is stored as the new concrete locator: it detaches from the element.)
- **Usage** is not kept by hand: `locator_usage` is rebuilt from a test's spec every time the spec is stored (insert or update). Changes that matter (rename, delete, new locator, extraction) read the specs themselves.
- **Rename** rewrites every spec in one database transaction; scripts do not change (they contain no names), so no new script version appears and no run is started.
- **Delete** of an element that tests use is refused with `409` and the list of tests.
- **Spec export** (`GET /api/projects/:id/specs`) keeps references and, only when some spec uses one, adds `objects` with the elements needed. Importing (`POST .../specs`) accepts `objects` too: new names are created, a name that exists must have the same locator (otherwise `409`). The project zip adds `objects.json` in the same case (also when only reusable steps of the exported tests refer to an element; those sets travel in `blocks.json`, and a spec export carries them as `blocks`), and project backups carry `objects.json` and restore the elements before the tests.

## API

All routes need the API key when the server has one, and every query is scoped to the project (another project's element id is a `404`).

| Route | What it does |
| --- | --- |
| `GET /api/projects/:id/objects` | List with `usedBy` (count, steps, first three tests; a test that reaches the element through reusable steps also has `viaBlocks`, and `blocks` lists the sets that hold the element; both are absent when there are none). Filters: `q`, `kind`, `test` (elements one test uses, through reusable steps too). |
| `POST /api/projects/:id/objects` | Create (`name`, `kind`, `locator`, `page?`, `notes?`). `201`, `400` with the reason, `409` name taken. |
| `GET/PUT/DELETE /api/projects/:id/objects/:oid` | Read (all users), change (`name`, `locator`, `page`, `notes`, `expectedVersion?`), delete. A change answers `appliesTo`, `tests`, `revalidation` (`started` with `jobId`, `waiting` with a message, or `none`) and `problems` (a script that could not be rendered again). The kind cannot change. |
| `GET /api/projects/:id/objects/export` | `{ version: 1, elements: [...] }` without ids. |
| `POST /api/projects/:id/objects/import` | `{ elements, overwrite? }`, at most 1000. Everything is validated before anything is stored (`400` with the index of each bad element). A name that exists with another locator is `409` unless `overwrite`; replaced elements propagate like any edit. |
| `POST /api/projects/:id/objects/extract` | `{ dryRun: true }` (default) returns proposals. `{ dryRun: false, apply: [{ key, name? }] }` (or `all: true`) creates the elements and points those steps at them; without a choice it is `400`. `minUses` changes the threshold (default 2). |
| `POST /api/tests/:id/steps/:index/share` | "Make shared" for one step: `{ name?, everywhere? }`. |
| `POST /api/tests/:id/healing/:pid/apply` | For a shared step, `{ acceptSharedChange: true }` is required when other tests use the element (`409` with `requiresConfirmation` otherwise). |

## Limits

- Locators that contain a `{{placeholder}}` are never proposed for sharing (they depend on one test's data); you can still make such a step shared by hand.
- Only web, mobile and desktop tests have elements. A web test cannot use a mobile element and the other way round.
- Re-validation after an element change uses the platform's normal validation job, so it follows the same rules (one active job per project, the allowed targets, switched-off frameworks). Mobile tests need a device to run; without one they stay "Not validated yet".
- A run that started before the element changed keeps the locator it started with.
- The `ai-test` command line replays spec files on their own; a file that refers to an element needs the elements from the same export imported into a project first.
- Element text is untrusted: the UI shows it as text, and locator values are escaped in generated scripts like any other locator text. Elements are not for secrets.

## Tests

`tests/locators-unit.test.ts` (browser-free, in the fast tier): names, locators per kind, resolution (found, unknown, wrong kind), scripts identical with and without a reference, usage, extraction, rename, the store and the backup round trip. `tests/locators.test.ts` (real worker and Chromium, fixture shop on port 5930): create, import, propagation and re-validation, waiting while busy, shared repair, delete and rename, export and import, extraction and "Make shared", project isolation and API-key protection. `tests/locators-ui.test.ts` (real browser, port 5931): the tab, dialogs, extraction preview, step chip, axe in light and dark, phone width.
