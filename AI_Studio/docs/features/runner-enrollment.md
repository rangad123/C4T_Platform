# Runner enrollment and credentials

Built in round 39 (migration slot 51, `PERSONAL_RUNNERS_MIGRATION` in `src/platform/agent-store.ts`); one runner per person since round 45.

## One runner per person (round 45)

A runner is the program on your computer that runs your tests. Each person has one, set up once in **Settings, Your runner**, and from
then on every run, schedule, deploy trigger and session that person starts uses it by itself; nothing asks which runner to use. Team
runners, Crowd4Test's shared runner, per-project runner tokens and kits, and the project switch "Allow people's own computers" are gone.

A runner that was installed with a team, shared or project credential is refused at every runner request with HTTP 401 and the sentence
"This runner was set up for a team or a project, and those runners are no longer used. Set up your own runner from Settings in AI
Studio." A team enrollment code gets HTTP 410 with the same sentence at `/api/agent/enroll`. The runner shows the sentence ("The platform
no longer accepts this runner. ...") and stops with exit code 3 ("access removed"); it never asks again. A retired personal credential gets
404 and the same exit. A personal runner installed before round 45 keeps working unchanged: the wire format (`/api/agent/*`, hello's
`projectId` string, `runner.kind` "personal") did not change.

The runner's switches (code scripts on, private addresses off, a real phone off by default) are the owner's, in Settings. They reach the
runner in the hello answer (`runner: { id, kind, customScripts, privateTargets }`) as before.

## The download and its one-time code

No download carries a runner credential. The download from Settings holds a single-use code (`aite_` + 32 random bytes) in
`runner.enroll` (mode 0600), stored on the platform only as a SHA-256 hash, valid 30 minutes:

- `GET /api/me/runner/download/info` -> `{ available, kitVersion?, reason?, platformUrl, urlOk, urlWarning?, nodeMin, mayDownload, refusal?, systems }`,
  where `systems` lists each `os` (windows, mac, linux) and `arch` (x64, arm64) with `kind` ("installer" or "files"), `ownNode` (it carries
  its own Node.js), `bytes?`, `note?` and `available`.
- `POST /api/me/runner/download` `{ os, arch }` (nothing else) -> the zip, with `x-runner-enrollment-id`, `x-runner-enrollment-expires`,
  `x-runner-kit-kind`, `x-runner-kit-note` (Windows or Mac fell back to the plain files), `x-runner-kit-target` (it carries its own Node.js).
  One download per system: Windows the setup program (it installs the test tools itself), a Mac the app, Linux the plain files; the Mac
  and Linux downloads carry their own Node.js and test tools when the server built that target (`runner-complete-kit.md`), the Mac app
  then inside it. `runner.json` holds no name: the runner is named
  after the computer, and the person can rename it in Settings.
- Who may download: a signed-in person who may run tests in at least one project, and the open server (no access key, nobody signed up),
  which acts as one person (owner id "open"). The shared access key is refused with 403 "Sign in with your own account to set up your
  runner." A few downloads a minute per person (`RUNNER_KIT_RATE_PER_MINUTE`, default 5).
- `GET /api/me/runner/enrollments/:id` -> `{ status: "waiting" | "connected" | "expired" | "used" }` (its owner only).

The runner trades the code at first contact: `POST /api/agent/enroll` `{ code, name, machineId }` (no Authorization header; limited per
address and per code) -> `{ token, runnerId, kind }`. That makes the person's one runner credential and retires every older credential of
theirs, so setting up a new computer (or the same one again) replaces the previous one. A used, expired or unknown code gets a sentence
saying to download the runner again. If the answer is lost, the same computer (same install id) may ask again with the same code while the
code is valid and the first credential was never used.

Agent command line: `--enroll <code>`, `--enroll-file <file>` (deleted once used), `--forget-credential` (for uninstalling). With no token
argument the runner uses the credential it keeps. `--token`, `--token-file` and `AITP_AGENT_TOKEN` keep working for development but are no
longer in the help text.

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

## Existing data

Round 39 made every runner that existed before it a team runner; round 45 refuses those at hello (above). Personal runners keep their
credential, install id and switches. Tasks keep their owner (`agent_tasks.owner_id`), and a task goes only to its owner's runner.
