# API contracts: do responses match the documentation, and what would break clients?

Two tools around the same idea — the API's own description is a promise to its clients.

## 1. Responses are checked against the documentation (automatic)
When an API has an OpenAPI/Swagger description, the "succeeds with a valid request" test of each documented endpoint compares the **real
response** with the documented success schema. A difference is a finding ("Needs review"), because clients written from the documentation break.
On with the project's **API** testing agent (Settings → General → Testing agents). The OpenAPI document's address is kept on the Requirements tab, under **What the agents need**. To leave it out of one exploration, send `contractChecks: false` in the API; the Explore page has no switch for it.

| Difference | Severity |
|---|---|
| A required field is missing, or a value has the wrong type (including `null` where it is not allowed) | High |
| A value outside the documented enum, length, range or pattern | Medium |
| A wrong format (date-time, date, email, uuid), or an undocumented field when the description forbids extra fields | Low |

Each finding lists the differences by path, worst first (`response.items[].id: expected integer, got string`), says the same problem in a list once, and
says how to fix it. The check replaces the generic "is an object" / "contains <key>" steps on those tests, so you get the whole picture in one finding.

**Never a false alarm from `oneOf` / `anyOf`:** the parser keeps only the first alternative of those, so that part of the schema is skipped instead of judged.
The validator is a small dependency-free helper that is pasted into the generated script, so a downloaded script runs on its own. Schemas over 20 KB are not attached.

## 2. API changes: what would break existing clients

Compare two versions of an API description (OpenAPI 3 or Swagger 2, JSON or YAML) and get a list of what changed, split into
**breaking** (a client written against the old version can stop working) and **other** changes. It needs no running
application, so it fits before a release or in a pull request.

## Use it
- **Pipeline:** `npm run ai-test -- api-diff old.json new.json` (files or `http(s)` addresses).
  `--fail-on breaking` (default) exits 1 on any breaking change; `any` exits 1 on any change; `none` never fails.
  `--json report.json` and `--markdown report.md` write the report. Exit codes: 0 gate passed, 1 gate failed, 2 usage or
  infrastructure error (unreadable file, download failed, bad flag).
- **API:** `POST /api/projects/:id/api-diff` with `{ "old": <text, object or address>, "new": <…> }` returns
  `{ breaking, nonBreaking, summary, markdown }`. Addresses go through the same private-address guard as other targets.

## What counts as breaking
| Side | Breaking | Not breaking |
|---|---|---|
| Operations | an operation was removed; it now requires authentication | a new operation; authentication no longer required |
| Inputs (what clients send) | a new required parameter or field; a parameter/field became required; a parameter was removed; a type changed; an enum value is no longer accepted | a new optional parameter or field; a field was dropped from the request; an enum now accepts more |
| Outputs (what clients read) | a field was removed or changed type; a field is no longer always present; a success status (2xx) is no longer documented; an enum can now take a new value | a new field; a new status; an enum can no longer take some value |

`/users/{id}` and `/users/{userId}` are the same endpoint. Schemas are compared a few levels deep, through `$ref`s.

## Limits
- It compares **descriptions**, not live behaviour: an application that stops matching its own description is not detected here.
- `oneOf`/`anyOf` are compared by their first alternative; vendor extensions and examples are ignored.
- Drift between runs when there is no description to compare is covered separately: see [API drift](api-drift.md).
