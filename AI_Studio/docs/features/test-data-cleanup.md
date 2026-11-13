# Test-data cleanup

Data-changing API tests ("Include API tests that change data") create records in the real application. This feature records what a test run **itself created** and removes it afterwards, and says honestly what it could not remove.

## What a user sees

- **Overview card** "Test data cleanup", shown only when some test changes data. It says, for example, "Last run created 5 records; 4 removed, 1 left behind", lists what stayed in the application and why, and offers "Retry removing 1 record".
- **A line on the test page** (API tests): what the latest run created for that test and what became of it.
- **Tests, More actions, Records created by tests**: the same card as a panel, with the switch.
- **A plain job event** at the end of the run: "Removed 4 of 5 records the tests created; 1 left behind."
- **The switch**: "Remove the records tests create after each run" (on by default). Off means nothing is deleted; the card warns that records will stay and lists them as "Left in place". The generation form offers the same choice next to "Include API tests that change data".

Outcomes per record:

| Outcome | Meaning |
| --- | --- |
| Removed | The platform deleted it, or the test deleted it itself. |
| Already gone | The application answered 404 or 410: it was already removed. |
| Could not remove | The DELETE failed (HTTP status, a refused credential, a timeout). Can be retried. |
| No way to remove it | No DELETE operation is known for it, so it stays. |
| Left in place | Cleanup was switched off. |

## What counts as "created"

A successful `POST` (2xx, not 204) in a generated API test whose answer names the new record:

- a JSON object with a top-level `id`, `<singular>Id`, `<singular>_id` or `uuid` (a safe integer or a string up to 200 characters; nothing nested, nothing guessed), or
- a `Location` header on the application's own address, one level below the POST path.

POSTs to login, token, search, GraphQL and similar paths are never treated as creating a record.

## Generated test data and browser tests

With data-changing tests on, planning may plan create, edit and delete scenarios "with generated data", and the authoring agent asks for each field's value (`src/engine/testdata/generate.ts`): realistic names, emails on `example.com`, phones in the fictional 555-01xx range, dates and numbers within the field's limits, addresses, plus boundary and invalid values for validation tests. Every value that names a record carries the run's tag (e.g. `qa7k2q`), so runs do not collide and records can be found again. Values are deterministic for a seed.

A browser test with generated data (`testData.runTag`) writes down each record the page's own requests created with it: a successful POST on the API's address whose request carries the tag and whose answer names the record (same rules as above). Those records are removed after the run like API-created ones, through a DELETE the API description knows, with the API credentials. What could not be removed is said with its tag: "3 records with tag qa7k2q were left in the app." A browser test run on its own removes nothing.

A record is removed only when a **known DELETE operation** matches it: `DELETE /things/{id}` for `POST /things`, known from the OpenAPI document or the analysis (`ApiEndpointModel`), from a DELETE step of the test itself (`DELETE /things/{{id}}`), or from another test of the same project. Never a collection-wide DELETE, never a listing, never a guess. No known operation: the record is listed as "No way to remove it".

## How it works

1. **The script writes down what it created.** Every API script that can POST carries a small helper (`src/engine/cleanup/helper.ts`, pasted into the script and compiled for the platform from the same text). `call()` reports every response to `cleanupObserve`, which keeps the path and id of each created record (and each DELETE the test itself made).
2. **Exactly one party deletes**, chosen with the environment variable `AITP_CLEANUP`:
   - unset or `self` (a downloaded script run on its own): the script deletes the records itself in a `test.afterEach`, newest first, with the same base URL and the same `API_TOKEN` / `API_AUTH_HEADER` variables as the test. The script says so in a comment; nothing secret is embedded.
   - `platform` (every platform run: validation, generation, environment runs): the script only writes one JSON line per event to `AITP_CREATED_DIR/<test>.jsonl`, as it happens (so a run killed on a timeout still reports what it created). The platform deletes after the whole run.
   - `off` (cleanup switched off): same as `platform` for the script; the platform deletes nothing and records the items as left in place.
3. **The platform plans each delete itself** from the recorded path and id with the same rules the script uses (it never trusts a delete address from the script), skips records the test deleted itself (nothing is deleted twice), and sends the DELETEs one at a time, newest first, with a 10 second timeout each:
   - 2xx removed, 404/410 already gone, anything else failed with a plain reason (HTTP status, "refused", "no answer within 10 seconds", "redirect");
   - the same API credentials the run used (a bearer token or an auth header); for a named environment, that environment's own credentials;
   - only on the run's own origin, through the same outbound guard as every other request (`assertAllowedTarget`); a path outside the origin is refused, and redirects are never followed;
   - cleanup also runs when a job is cancelled, and never changes a test's validation status or fails the job.
4. **Production** is read-only: tests that change data are skipped there, so nothing is created and nothing is deleted; a retry never sends anything to a production environment.

## The ledger

Stored in `cleanup_ledger` (migration 13, `src/platform/cleanup-store.ts`): job, test, creation order, `POST` path, record id, the planned DELETE path, the origin, the environment, status and a plain reason. **Only ids and paths are stored**: never a response body, a header or a token (the answer to a DELETE is not even read). Rows older than 30 days are pruned. The per-project switch is `cleanup_settings`.

## API

| Request | Answer |
| --- | --- |
| `GET /api/projects/:id/cleanup` | `{ enabled, dataChangingTests, latest, runs }`; `latest` is the newest run with its items and counts. |
| `PUT /api/projects/:id/cleanup/settings` | `{ cleanupAfter: boolean }`: the project's switch. |
| `POST /api/projects/:id/cleanup/retry` | Tries the failed items of the latest run again, with the ids recorded then and the run's credentials (an OAuth2 client gets a fresh token). `409` when nothing failed or a job is running. Bounded to about a minute per request. |
| `GET /api/tests/:id/cleanup` | What the newest run created for one test. |

Job option `cleanupAfter` (generation request and job options): per-job override; a generation request that sets it also becomes the project's switch. Default on.

## Limits (honest)

- **Only POST-created records.** Records created by PUT or by a web journey are not tracked.
- **An answer that names an existing record is trusted.** An API that answers 2xx to a POST with the id of a record that already existed (an upsert) would have that record removed. Exclude such endpoints from data-changing tests.
- **A test that signs in with a token captured during the test** (a login step, then `Authorization: Bearer {{token}}`) created its record with that token; the platform has only the project's default credentials, so such a DELETE may be refused. It then shows as "Could not remove" with the reason.
- **A run killed before it ends** still reports the records written so far (the event file is written immediately), but a record whose creating answer was never received is unknown.
- **Retention**: the ledger keeps 30 days; a record left behind longer than that is no longer listed.
- Self-deletion by a downloaded script knows the DELETE operations of the application description and of the test itself at the time the script was rendered, not those of other tests.
- Cleanup of mobile, web-journey and load-test traffic is out of scope.
