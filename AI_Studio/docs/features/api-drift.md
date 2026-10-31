# API drift: did the live API change shape since the last run?

The [API contracts](contracts.md) tools compare an API with its **description**. Many APIs have none, or have one that nobody keeps
up to date. API drift needs no description: every time your API tests run, the platform remembers the *shape* of what the API
answered, and compares it with the run before. If a field disappeared, a value changed type or an endpoint stopped answering, you are
told in plain words — before a client finds out.

## What you see

* **Overview card "API changes"** (project **Overview** tab). Shown once the project has two runs with API requests. It lists:
  * **Can break clients** — a field was removed, a field changed type (for example a number became text), a field that used to be in
    every item is missing from some, a field is now always empty, an endpoint stopped answering (404/405/410) or now fails with an
    error, an endpoint is no longer reached;
  * **Other changes** — a new field, a new endpoint, an endpoint that used to fail and now works.
  Six changes are shown per group; the rest open under "Show N more". With no changes the card says so calmly. If the comparison
  cannot be loaded it says that, with **Try again**.
* **Alert "The API changed in a breaking way"** (`api_breaking_change`). Add it to an alert channel on the **Schedule** tab
  (opt-in: a channel created without choosing events keeps hearing only about runs). It is sent after a run when that run has
  breaking changes compared with the previous run, once per distinct set of changes: if the next run shows no breaking change the
  memory is cleared, so a later break is announced again. A webhook receives the usual envelope plus
  `apiChanges: { from, to, breaking: [{ operation, message }], breakingCount, otherChanges }`; Slack receives a short list.
  Delivery, retries, the address being a secret and the delivery log work exactly as for the other alerts
  (see [schedules](schedules.md)).
* **API**: `GET /api/projects/:id/api-changes[?since=<jobId>]` → `{ from, to, breaking[], nonBreaking[], message? }`, each change
  `{ breaking, operation: "GET /api/users/{}", message: "response field [].email was removed" }`. By default the newest run against
  the one before it; `since` names an older run to compare with. With fewer than two runs the answer is `200` with `from: null` and
  a plain `message`. An unknown project or run is `404`.

Nothing to turn on: API tests (the "API" target of an analysis, or imported API tests) record their shapes automatically.

## What is recorded — shapes only

For each operation (`GET /api/users/{}`; `/users/42`, `/users/{id}` and `/users/7f3c…` are the same endpoint, like in the OpenAPI
comparison) a run keeps:

* the **HTTP statuses** it answered (every method, so a `POST` that starts failing is noticed);
* for **successful `GET` requests only**, the **shape** of the JSON body: field names and inferred types
  (`string`, `number`, `boolean`, `null`, `object`, `array`), at most 4 levels deep, arrays described by the merged shape of their
  elements (the first 20), at most 40 fields per object, at most 8 KB per operation (a bigger body is described less deeply).

It **never** keeps response values, headers, cookies, tokens, request bodies, or any body of a `POST`/`PUT`/`PATCH`/`DELETE`.
How this is enforced:

* the shape is computed **inside the generated test script**, which attaches only type names — a value never leaves the script;
* the platform **re-validates** whatever a script attached (`sanitizeShape`): unknown types, extra properties, value-like keys and
  oversized shapes are dropped, and a shape attached to anything but a successful GET is ignored;
* an object whose keys look like data (ids, UUIDs, e-mail addresses, tokens, more than 40 keys) is not described at all, so such
  keys never become "field names";
* the tests that really run assert it: the stored snapshots are searched for sentinel values from the API's responses and contain none.

Passive security probes (requests to `/.env`, `/robots.txt` and the like) take no part in drift.

## What counts as a change

Compared per operation, only operations seen in both runs:

| | Breaking | Not breaking |
|---|---|---|
| Operation | it used to succeed and now answers 404/405/410 or fails; it is no longer reached at all (see below) | new operation that succeeds; one that used to fail and now succeeds |
| Fields | a field that was in every item was removed; its type changed; it is no longer in every item; it is now always `null` | a new field |

Careful about noise, on purpose:

* **An empty list proves nothing.** If a list was empty in either run there is no element shape to compare, so its items are not
  "removed" (or "added").
* A field that was only *sometimes* present and is absent now is not reported (it may simply not have been sampled).
* `null` is compared carefully: a field that is `null` in one run and text in another is not a type change; one that was never
  `null` and is now only `null` is reported.
* Operations that errored are never compared field by field. A *new* operation that only errors (tests probing made-up ids) is
  not reported.
* Parts cut off by the depth/size caps are never compared.
* "No longer reached" is only reported when the later run covered **all** of the project's API tests. Re-running a single test
  (or some tests) cannot tell "gone" from "not tried", so it is not reported then.

## How it works

* **Recording.** The API script generator (`src/engine/generators/api.ts`) adds the recorder (`DRIFT_HELPER_SOURCE`, one text
  shared by the script and the platform, see `src/engine/contracts/drift.ts`) and attaches `obs` (a shape, or `null`) to the
  existing per-request `responses` record. `RepoSink.recordExecution` hands each execution's responses to `drift-store.ts`, which
  folds them into **one snapshot per job** (retries and repair attempts merge into it).
* **Storage.** Migration slot 9, table `api_snapshots`: `{ projectId, jobId, at, complete, operations_json }`. The latest **20**
  snapshots per project are kept. Recording never throws; a failure is logged and the job continues.
* **Comparing.** `diffSnapshots(previous, latest)` (`drift.ts`) returns the same `{ breaking, nonBreaking }` of `ApiChange`s as the
  OpenAPI comparison (`diff.ts`), worded the same way ("response field … was removed", "changed type from … to …", "is no longer
  always present", "new operation"), sorted so equal runs always give the same list.
* **Alert.** `onJobFinished` (`schedule-services.ts`) compares the finished job's snapshot with the one before and calls
  `AlertService.notifyApiDrift`; this runs in its own try/catch and never affects the job. Cancelled jobs and browser-compatibility
  runs are skipped.

## Limits

* It only sees what your API tests request. An endpoint no test calls is invisible; the first run after tests are added shows
  those endpoints as new.
* It compares **samples**. A field that is only present for some records can be missed or, if a different sample is returned,
  reported as "no longer always present". Responses that legitimately differ run to run (random data) can produce such notes.
* Bodies are only described when they are JSON and the request was a successful `GET`. Responses to other methods are tracked by
  status only; headers are not compared.
* The first two levels of a very large body may be all that is described (the 8 KB cap); objects with data-like keys are skipped.
* The previous run is whatever ran just before — a scheduled run, a re-run or a fresh analysis alike. Use `?since=` to compare with
  an older run.
* Existing API test scripts are re-rendered with the recorder the next time they are re-validated; until then their runs record nothing.
