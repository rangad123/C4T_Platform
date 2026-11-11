# Your runner: one per person, set up in Settings

A runner is the program on your computer that runs your tests. Each person sets it up once, in **Settings → Your runner**
(`#/settings#runner`), and from then on every run they start, and their schedules, go to it. Nobody chooses a runner anywhere
else. This page replaces the earlier pages about personal and team runners, the Runners pages, Add a runner, runner-only mode and
sessions on people's own computers (round 45).

## The model

- **One runner per person.** Setting up a new computer retires the person's previous runner as soon as the new one connects. There
  is no list to manage and no limit to reach.
- **No team or shared runners.** Organisation machines, Crowd4Test's shared runner, per-project runner tokens and kits, and team
  enrollment are gone. A runner still installed with such a credential is refused when it connects, with a sentence that tells the
  person to set up their own runner from Settings, and it stops.
- **Every run is on its starter's own computer.** The project switch "Allow people's own computers" is gone. Schedules, deploy
  triggers and API-key runs run on the computer of the person who made them. A schedule with no recorded maker is refused at its
  next fire: "This schedule has no owner. Open it and save it again to run it on your computer."
- A runner installed before this change keeps working: the wire format (`/api/agent/*`) did not change.

## Your runner in Settings

The section shows for anyone who may run tests in some project, and in open mode (no accounts). It reads `GET /api/me/runner`
every few seconds and has these states:

| State | What it shows |
|---|---|
| Not set up | What a runner is, the system (Windows, Mac, Linux) and processor guessed from the browser, and **Download the runner**. |
| Waiting for the computer | Where the zip was saved, the steps for that system, the unsigned-download notice, and "Waiting for the computer to connect" until `GET /api/me/runner/enrollments/:id` says connected. An expired code offers **Download again**. |
| Connected (online or busy) | Name, computer, system, processor, version, when last heard from, the run it is on (linked), its network sentence, updates, the computer check, the switches, **Rename**, **Set up a different computer**, **Remove this computer**. |
| Offline | The same, with how to bring it back on that system. |
| Needs an update | The update sentence and **Update now** (`POST /api/me/runner/update`), or, when it cannot update itself, to download again. |

- **The download.** `POST /api/me/runner/download` with `{ os, arch }` answers the zip with a personal one-time code inside
  (the installer on Windows and Mac, plain files on Linux). The browser saves it; the page never reads inside it. The server's
  refusals are shown as they are (for example "Sign in with your own account to set up your runner." for a session started with the
  server's access key). `GET /api/me/runner/download/info` says which systems can be downloaded; when it says `mayDownload: false`,
  its `refusal` sentence is shown instead of the button.
- **The switches** (`PATCH /api/me/runner` `{ switches }`): Run code scripts (on), Test private and local addresses (off), Use my
  connected phone (off). The server enforces each when it hands out work, and the runner checks again.
- **Rename** is `PATCH /api/me/runner` `{ name }`; **Remove this computer** is `POST /api/me/runner/retire`.
- **Everyone's runners** (people who manage runners, and platform admins): owner, name, status, last seen and version from
  `GET /api/admin/runners`, with **Remove** (`POST /api/admin/runners/:id/retire`).

## Running tests

- The Run panel, the split Run button, suites, schedules and sessions send no runner. In runners mode the Run controls read
  `GET /api/me/runner` and say before the click when the person's runner is not set up, is offline, or has code scripts off.
- The server refuses up front with 409 `{ error, details: { code, link: "#/settings#runner" } }`. Codes: `RUNNER_NOT_SET_UP`
  ("Set up your runner in Settings to run tests."), `RUNNER_OFFLINE` ("Your runner is offline. Start it on your computer, then try
  again."), `RUNNER_CANNOT_RUN` (phone tests, private addresses, code scripts). The page shows the sentence and links to Settings.
- A run's page still says "Ran on NAME", and marks a run on the person's own runner "Your computer".
- In local mode (self-hosting, development) runs go where the project runs, as before ("Runs on this server").

## Old links

`#/runners`, `#/runners/:id`, `#/runners?add=computer`, `#/settings?section=runners`, `#/projects/:id/runners` and
`#/projects/:id/settings?section=runners` open Your runner in Settings (`web/src/lib/aliases.ts`).

## Runs only on runners (`EXECUTION_MODE=runners`)

A hosted platform never runs its customers' tests on its own server. In this mode a dispatch worker starts with the API process
and hands every run to its starter's runner; exploring with the AI, tests described in words, agent runs, security assessments and
recordings "on the server" are refused when made, with a sentence. The server's own browser launch and script runner refuse
(`SERVER_RUN_REFUSED`) as a last guard. A lost job is queued again without running a test twice, and a deploy hands running jobs
over to the next process ([runner-restarts.md](runner-restarts.md)).

## Sessions on your own computer

Recordings, live sessions and phone sessions run on the starter's own runner and are readable and drivable only by that person.
"Use my connected phone" decides whether a real phone may be used; an app the session installed on a real phone is removed
afterwards.

## Tested

- `tests/runner-settings-ui.test.ts`: the Settings section in a real browser against a stand-in for the `/api/me/runner*` routes
  (every state, the download, the switches, rename, remove, admins' list, refusals with their link, old links).
- `tests/run-on-runner-ui.test.ts`: the Run panel and readiness in runners mode.
