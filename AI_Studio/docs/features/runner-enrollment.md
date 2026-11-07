# Runner enrollment, personal runners and credentials

Built in round 39. Migration slot 51 (`PERSONAL_RUNNERS_MIGRATION` in `src/platform/agent-store.ts`).

## Two kinds of runner

- **Team runner**: a machine of an organisation, or a Crowd4Test shared machine (no organisation and no project). Given to projects on the
  Runners page. Managed by people with "manage runners", as before. Every runner that existed before this change is a team runner.
- **Personal runner** ("this person's computer"): owned by one person. Anyone who may run tests in at least one project can add their own
  computer, Crowd4Test testers included. At most 5 active personal runners per person.

A personal runner takes **only runs its owner starts** (and runs of schedules its owner made), only in projects the owner can still open,
and only where the project allows people's own computers. It is never given to a project, never a project's pinned runner, and nobody
but its owner (and platform admins) sees it. The rule is checked when a task is offered and again inside the claim itself
(`agent_tasks.owner_id`, set when the task is queued).

A runner made from a project that has no organisation serves only that project. Only Crowd4Test staff (or, on a server without
Crowd4Test sign-in, people who reach every project) can make a shared runner.

## Switches

| Switch | Personal runner | Team runner |
|---|---|---|
| Code scripts (hand-written, imported, Git) | On by default; the owner can switch it off | Off by default: only with `--allow-custom-scripts`, or the admin's switch. Never on a Crowd4Test shared runner |
| Private and local addresses (localhost, LAN, 169.254.x) | Off by default; the owner can allow them | Allowed, as before |
| A connected real phone | Off by default (emulators only) | Not used by this switch |

Project setting **Allow people's own computers** (`PUT /api/projects/:id/runner { allowPersonal }`, needs project settings): on by default.
When on, the project's test accounts (passwords, authenticator secrets, API tokens, saved sign-ins) reach the owner's computer for their runs.

The switches are sent to the runner in the hello answer (`runner: { id, kind, customScripts, privateTargets }`). A runner that understands
them reports `capabilities.runnerSwitches: true`; code scripts go only to such a runner when they depend on a switch. With private addresses
off, every test the runner starts gets `BLOCK_PRIVATE_TARGETS=true` (the check generated scripts make on every step). Code scripts can
still reach any address on their own; that is a limit, not a guarantee.

## Enrollment codes

No download carries a runner credential. The website makes a single-use code (`aite_` + 32 random bytes), stored only as a SHA-256 hash,
valid 30 minutes:

- `POST /api/runners/enroll` `{ kind: "personal" | "team", label?, organizationId?, projectIds? }` → `{ id, kind, code, expiresAt }`
- `GET /api/runners/enrollments/:id` → `{ status: "waiting" | "used" | "expired", runnerId }` (its maker only)
- `POST /api/runners/kits` and `POST /api/projects/:id/runner-kits`: the download, with the code in `runner.enroll` (mode 0600) and the
  headers `x-runner-enrollment-id`, `x-runner-enrollment-expires`. `GET /api/runners/kits/info` answers like the project's kit info.

The runner trades the code at first contact: `POST /api/agent/enroll` `{ code, name, machineId }` (no Authorization header; limited per
address and per code) → `{ token, runnerId, kind }`. A used, expired or unknown code gets a sentence saying to make a new one on the Runners
page. If the answer is lost, the same computer (same install id) may ask again with the same code while the code is valid and the first
credential was never used; it gets a fresh credential and the first one stops working. Anyone else gets "already used".

Agent command line: `--enroll <code>`, `--enroll-file <file>` (deleted once used), `--forget-credential` (for uninstalling). With no token
argument the runner uses the credential it keeps. `--token`, `--token-file` and `AITP_AGENT_TOKEN` keep working for development and older
installs.

## Where the credential is kept

`src/agent/credential-store.ts`, keyed to the runner's folder (`AITP_CREDENTIAL_DIR`; a download sets it to its own folder, a checkout
uses its work folder):

- Windows: `runner.credential`, the token protected with DPAPI for the current Windows user (PowerShell, `ProtectedData`, CurrentUser).
- macOS: the login Keychain, service "Crowd4Test AI Studio runner", account = the runner's folder (`security`; the token goes on stdin).
- Linux: `runner.credential`, mode 0600, not encrypted.

This protects against other accounts on the same computer and a copied disk. It does **not** protect against programs running as the same
user, which includes the tests the runner runs: they can ask DPAPI or the Keychain the same way. The token never appears on a command line,
in output or in logs.

Verified: the Linux file store end to end with the real agent program (`tests/runner-enroll.test.ts`). Windows and macOS: only the
commands are unit-tested (`tests/credential-store-unit.test.ts`); they have not been run on a real Windows PC or Mac.

## Machine identity and rotation

- The runner makes a random install id once (`runner.machine` next to its settings) and sends it with enroll and hello. The platform binds
  the credential to the first id it sees; another id (or none, for a credential made with a code) is refused with a sentence and an
  Activity entry. Older runners with a token given by hand send none and keep today's behaviour.
- `POST /api/agent/rotate` gives a new credential. The old one keeps working until the new one is first used, at most 24 hours; asking
  again with the old one replaces an unused new one, so a lost answer never locks the runner out. The hello answer says `rotate: true`
  when the credential is 30 days old; a runner keeping its credential in the store rotates then, and checks once a day while connected.

## Choosing the runner for one run

`GET /api/projects/:id/runner-choices` (needs running tests there) lists the caller's own computers first, then the project's team runners,
with `online`, `busy`, `machine`, `canRunWeb`, `canRunMobile`, `codeScripts`, `problem`, plus `allowPersonal` and `defaultRunnerId`.
A run-start route that receives `runnerId` sends the run only to that runner; a runner the person may not use answers 404, one that
cannot take the run now a 409 with the reason. Without `runnerId` the project's setting applies as before.

## Existing data after the migration

Every existing runner becomes a team runner with today's rules (code scripts off unless started with `--allow-custom-scripts`, private
addresses allowed, no install id until a newer runner connects). Existing tasks have no owner, so no personal runner takes them. Every
project allows people's own computers. Old kits keep working with their `runner.token`.
