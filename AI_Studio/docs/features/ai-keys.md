# AI keys (round 57)

An AI key here is a whole AI configuration: the provider, the model (and an optional fast model), the key itself, and an address for a
custom endpoint. There are two kinds, and projects choose nothing.

## The two kinds

- **Organisational keys** are Crowd4Test's. Only Crowd4Test admins add, change, test and remove them, and assign each one to particular
  admins or sub-admins. A person sees an organisational key only when it is assigned to them; they may use it and test it, not change it.
  Customers and testers are never assigned one. Crowd4Test pays for what they use.
- **Personal keys** belong to one person. Anyone who may use AI in AI Studio (admins, sub-admins, customers and testers who may use the AI
  to write tests or run agents) can add their own. Only that person sees, changes, tests, removes and uses them; nobody else, admins
  included, sees another person's personal key. That person pays.

## Your chosen key

Each person has one **chosen key**, picked in **Settings, AI keys** from their own keys and the organisational keys assigned to them. The
first key a person adds becomes their chosen key. All the AI work they start uses it, in any project: exploring, Describe it, agent runs,
creating test cases from requirements, writing scripts, proposing suites, phone exploring and the connection check. An exploration on a
runner uses it too: the AI calls stay on the platform. A schedule's or a deploy trigger's work uses the chosen key of the person who made it.

- **No key, no AI.** A person with no usable key is told: "You have no AI key. Add your own key in Settings, AI keys, or ask an admin to
  assign an organisational key." The server's own key (`LLM_*` in `.env`) is never used for a signed-in person.
- **A key that goes away.** When an admin takes an assignment away or removes an organisational key, the people who had chosen it lose that
  choice and are told so. A person who is no longer a Crowd4Test admin or sub-admin cannot use an organisational key, even if it is still
  assigned. Nothing ever moves to another key on its own.
- **A key that fails.** The work stops with a plain sentence; the key's own note (only for whoever manages it) says what failed. Its own
  models only: no fallback models and no fast model from Settings.
- **Without a person.** On a server without accounts (the open server) the work uses the open server's chosen key if it has one, else the
  server's own key, as before. The shared access key (`API_KEY`) is an operator's credential, not a person's account: work started with it,
  and the work of schedules and deploy triggers made with it, uses the server's own key (Crowd4Test pays). This was a deliberate choice, so
  CI and scripts keep working. Those schedules and triggers still have no runner, as before. An older schedule or trigger with no maker at all
  is refused with a sentence.
- **A person turned off here** (or no longer here): their keys and assignments no longer serve their schedules and jobs, which stop with a
  sentence.
- **Who counts as an admin, and who may be assigned:** with Crowd4Test sign-in, only Crowd4Test admins (role ADMIN) manage organisational
  keys, and only active Crowd4Test admins and sub-admins can be assigned one; local accounts never do. Without Crowd4Test sign-in, the
  server's owners do both.
- **Creating tests from a plan** records the person who clicks, not who made the plan: their key and their runner are used.
- **Provenance:** a test made on a personal key says "A personal key" where it would name the model, as the usage pages do.

A job is read by everyone on its project, so its messages name no key and no person: "AI is not available for this work: the person who
started it has no AI key. ..."

## Who pays

Usage rows record who paid: `crowd4test` (an organisational key, or the server's own key) or `personal` (with the person's id). The
platform's monthly AI limit counts only what Crowd4Test pays for, and does not apply to work on a personal key; a project's own limits and
the per-job limit still apply ([ai-usage-budgets.md](ai-usage-budgets.md)).

## Routes

| Method | Endpoint | Who | What |
| --- | --- | --- | --- |
| GET | `/api/me/ai` | the person | `{ chosen, problem, personal, organisational (assigned to me), canManageOrganisational, providers, openServer }` |
| PUT | `/api/me/ai/chosen` | the person | `{ keyId }`: one of my keys, or one assigned to me |
| POST · PATCH · DELETE | `/api/me/ai/keys` (`/:keyId`) | the person | my own keys; a new provider or address needs the key entered again |
| POST | `/api/me/ai/keys/:keyId/test` | the person | "Test this key": mine, or one assigned to me |
| GET · POST | `/api/admin/ai-keys` | Crowd4Test admins | organisational keys with their assignees, and the people who may be assigned |
| PATCH · DELETE | `/api/admin/ai-keys/:keyId` | Crowd4Test admins | change or remove one (people who chose it lose that choice) |
| POST | `/api/admin/ai-keys/:keyId/test` | Crowd4Test admins | "Test this key" |
| PUT | `/api/admin/ai-keys/:keyId/assignees` | Crowd4Test admins | `{ personIds }`: admins and sub-admins only |

A key goes in and never comes out: no answer carries it, only its last four characters. A key someone may not see answers the same 404 as an
unknown one. "Crowd4Test admins" means the Crowd4Test role ADMIN holding "manage AI keys"; on a server without Crowd4Test sign-in, people
holding the platform settings. Every change, assignment and choice is in Activity.

## The change from before (migration 61)

Before round 57 a key belonged to Crowd4Test, to an organisation or to one project, and each project chose which key it used and who paid.
Migration 61 turned them into the two kinds:

- The maker is found by the exact "(person id)" at the end of `created_by` (or a `created_by` that is exactly an id).
- Crowd4Test's keys became organisational keys, assigned to the person who added them. An admin assigns them to others afterwards.
- Organisation and project keys became personal keys of the person who added them. A key whose maker cannot be found was removed; it was
  never given to someone else. The server log says how many were removed (no labels).
- Everyone who had started AI work in a project that used a key they may still use got it as their chosen key (best effort, from the jobs'
  recorded starters). Anyone still without a choice who may use exactly one key got that one.
- The projects' AI settings were removed, and usage rows paid by a customer's own key now say `personal`.

Code: `src/platform/ai-config-store.ts` (tables, migration, backfill), `src/platform/ai-config.ts` (which key the work uses),
`src/platform/routes/ai-config.ts` (the routes). Tests: `tests/ai-config-api.test.ts`, `tests/ai-keys-migration.test.ts`.
