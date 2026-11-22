# Application understanding

For a project tested by the AI agent, the platform keeps a picture of the application it tests: its pages, workflows, API endpoints,
data, roles and the business rules found in what people wrote about it. Every item says where it came from. Test planning reads the
rules that a source states or that a person confirmed; what the application merely did is never treated as expected behaviour.

The picture is built by an **analysis**. Exploring the application runs one at the end; "Read again" on the Dashboard runs one on its
own, for example after a schema file was added. Each analysis is stored as a new numbered version and is never changed afterwards,
except for its version label (see "Versions").

## Where it shows

Only websites the AI agent explores show it (a project tested only by code scripts, and a phone app, do not). There is no separate tab.

- **Dashboard, "Application understanding"** (`web/src/features/understanding/UnderstandingCard.tsx`):
  - whether an analysis is running, when the last one ran, and the version label of the build it describes;
  - how many pages, workflows, endpoints and rules it holds, and how many rules are stated by a source, inferred, and still waiting
    for a person;
  - each source with its state (waiting, processed, failed) and, for a failed one, the sentence saying why;
  - what is missing: plain sentences naming what the analysis could not work out and which source would answer it (for example
    "No API description: 14 observed endpoints have no response schema. Add the OpenAPI document to fill them in.");
  - "Read again" while nothing runs, "Stop" while one runs.
  - Before the first reading (none done, none running, none failed) the card is not shown: the first exploration reads the application.
- **Requirements tab, "Rules to confirm"** (`RulesToConfirm.tsx`): the rules no person has decided yet, plus any rule whose evidence a
  later analysis no longer found.
- **Requirements tab, "More for application understanding"** (`SourceInputs.tsx`), closed to one line until opened: database schema
  files, and the version label once something has been read.

People who may only look at the project see all of it without the buttons. A refusal from the server (for example "There is no analysis
to label yet. Analyse the application first.") is shown as its sentence next to the control that caused it.

## Sources

None is required: an application address alone works.

| Source | What it adds | Uses AI |
|---|---|---|
| Exploring the application | pages, navigation, forms and their field limits, dialogs, menus, tables, roles, the requests the application made | only for workflows and page purposes |
| API description (OpenAPI) | endpoints, parameters, schemas, sign-in needs, error responses, entities | no |
| Requirements | rules with the quoted line they rest on, workflows, roles, state changes | yes |
| Database schema file | entities, fields, types, constraints, relationships, enumerations | no |
| Source repository | API descriptions, schema files, documents and tests found in it, each handled as its own source | only through documents and tests |
| Existing tests | workflows and the outcomes they check | yes |

Without an AI key the deterministic sources are still processed, and the analysis notes that rules were not read from documents, tests
or pages. AI work uses the
key chosen by the person who started the analysis.

A database schema file is SQL (`CREATE TABLE`) or a Prisma schema, at most 1 MB, at most 20 per project. It is stored and read as text,
never run, and is used from the next analysis on. Removing it takes it out of the next analysis.

## Rules and confirmation

Each rule has a description, what is expected, where it came from, how sure the analysis is, and the evidence it rests on (quoted
lines, a file and line, an API path, a page). A rule is **stated** when a source such as a requirements document, the API description,
a schema or an existing test states it, and **inferred** otherwise.

- Every rule starts unconfirmed. Only a signed-in person can confirm or reject one; the shared access key cannot.
- Tests treat a rule as expected behaviour once a source states it or a person confirms it. A rejected rule is not used.
- A confirmed or rejected rule keeps its decision, and the wording the person decided about, in later analyses. When a later analysis
  words it differently, the rule shows "Reworded since you decided: …" with the new text; "Undo the decision" takes the new wording.
- When a later analysis no longer finds what a rule rests on, the rule is kept with its decision and marked "Evidence gone", so a person
  can check that it still holds. It is never deleted.
- A rule linked to a workflow shows the workflow's name. When that workflow is only inferred, the rule says that its tests use it once
  the workflow is confirmed, with a "Confirm the workflow" link to it.

## Workflows to confirm

A workflow a source states (a requirements document, an existing test) is used by tests as it is. One the AI worked out itself is listed
under "Workflows to confirm", with its steps and the pages or lines it was built from, and tests follow it only once a person confirms
it; a rejected one is left out.

- Confirm, Reject and "Undo the decision" work as for rules, for people who may change tests.
- A decision is about the workflow's steps as the person read them. When a later reading changed a step in the meantime, nothing is
  decided: the page says "This workflow changed since you read it. Read it again, then confirm or reject it." and shows it as it is now.
- A decision follows the same steps into later readings. When a later reading names the workflow differently, the decided name stays
  and the page says "Reworded since you decided: …"; "Undo the decision" takes the new name.
- "Undo the decision" puts a confirmed or rejected rule back to waiting.
- A decision is about the rule as the person read it. When a later analysis changed the rule in the meantime, nothing is decided: the
  page says "This rule changed since you read it. Read it again, then confirm or reject it." and shows the rule as it is now.

## Versions

Each analysis records which build of the application it describes. That is never guessed from a page: it is the label a person gave,
the version a deploy sent, the repository commit analysed, or nothing (then only the analysis time says when). A person can set or change
the label of the latest analysis on the Requirements tab.

## Limits

- One analysis per project at a time; a second start is refused with a sentence until the first finishes or is stopped.
- An analysis that is stopped or cannot finish keeps nothing of itself; the previous version stays, and the Dashboard says why.
- The newer form, dialog and request details need a current runner; with an older runner the page says to download the runner again.
- Figma and live database connections are not sources.

## API

All under `/api/projects/:id/intel`; reading needs access to the project, everything else permission to write tests.

| Request | Answer |
|---|---|
| `GET /models`, `GET /models/latest` (or a version number) | the versions; one version with its model (404 before the first analysis) |
| `GET /rules?status=&explicitness=` | `{ rules }` |
| `PUT /workflows/:workflowId/decision` `{ status, fingerprint }` | the workflow (always with the fingerprint read; 409 when its steps changed since; a signed-in person only) |
| `PUT /rules/:ruleId/decision` `{ status, fingerprint }` | the rule (`confirmed` or `rejected` with the fingerprint read, 409 when the rule changed since; `unverified` needs none; a signed-in person only) |
| `GET /sources` | `{ sources, running, last }` |
| `POST /analyse`, `DELETE /analyse` | 202 started (409 while one runs); stopped (404 when none runs) |
| `POST /sources/schema?name=` (file bytes), `DELETE /sources/schema/:sourceId` | the source (201); `{ removed }` |
| `PUT /app-version` `{ label }` | the labelled version (409 before the first analysis) |
