# Your runner: one per person, set up in Settings

A runner is the program on your computer that runs your tests. Each person sets it up once, in **Settings → Your runner**
(`#/settings#runner`), and from then on every run they start, and their schedules, go to it. Nobody chooses a runner anywhere
else. This page replaces the earlier pages about personal and team runners, the Runners pages, Add a runner, runner-only mode and
sessions on people's own computers (round 45).

## The model

- **One runner per person.** Setting up a new computer replaces the person's previous runner as soon as the new one connects
  (the database holds at most one per person). Every runner from before migration 57 was removed: everyone downloads the new one here. There
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
| Not set up | What a runner is and one **Download for {system}** button for the computer the browser is on (system and processor guessed from the browser). **For another computer?** opens the system and processor choice. |
| Waiting for the computer | Where the zip was saved, the steps for that system (they include how to get past the first unsigned-download warning), and "Waiting for the computer to connect" until `GET /api/me/runner/enrollments/:id` says connected. **Still blocked?** holds the other cases (a browser that holds the download, the plain files' SmartScreen warning, a blocked zip) and the computer check script. An expired code offers **Download again**. |
| Connected (online or busy) | The header: status, name and when last heard from. Then the run it is on (linked), the update sentence, what the computer check found missing, and a **Details** disclosure with the computer, system, processor, version, network sentence and every line of the check. Then the switches (one-sentence hints), **Rename**, **Set up a different computer**, **Remove this computer**. |
| Offline | The same, with how to bring it back on that system: runs can’t start until it is back online; schedules wait for it. |
| Needs an update | The update sentence (said once, in the updates line) and **Update now** (`POST /api/me/runner/update`). When it cannot update itself, or the platform publishes no update (`published: false`), the sentence says to download the runner again from Settings and there is no **Update now**. |

- **The download.** `POST /api/me/runner/download` with `{ os, arch }` answers the zip with a personal one-time code inside
  (the installer on Windows and Mac, plain files on Linux). The browser saves it; the page never reads inside it. The server's
  refusals are shown as they are (for example "Sign in with your own account to set up your runner." for a session started with the
  server's access key). `GET /api/me/runner/download/info` says which systems can be downloaded; when it says `mayDownload: false`,
  its `refusal` sentence is shown instead of the button.
- **The switches** (`PATCH /api/me/runner` `{ switches }`): Run code scripts (on), Test private and local addresses (off), Use my
  connected phone (off). The server enforces each when it hands out work, and the runner checks again. A person who still has more than
  one computer from before round 45 changes the switches of all of them at once.
- **Rename** is `PATCH /api/me/runner` `{ name }`; **Remove this computer** is `POST /api/me/runner/retire`.
- **Everyone's runners** (people who manage runners, and platform admins): its own section below Your runner, with owner, name,
  status, last seen and version from `GET /api/admin/runners`, and **Remove** (`POST /api/admin/runners/:id/retire`).

## Elsewhere on the website

- **Dashboard**: the Your runner card shows only while the runner is not set up or is offline. A project's Still to set up list
  (`GET /api/projects/:id/setup-check`) is the other place that asks for it; Next steps no longer does.
- **Record**: no "Record on" choice and no "Show the browser window" box (a recording always has its window). In runners mode the
  form says once whether the person's runner can record (`can.recordHeaded` from `GET /api/me/runner`), links to
  Settings when not, and the server picks the runner. In local mode it records where the project runs ("this server" wording).
- **Phones** (Settings, Mobile app): in runners mode, "Phones on your runner" (the server's `can.phone` sentence and the state of
  Use my connected phone) replaces the platform computer's phone check, and "Where phone tests run" offers no phone of the
  platform's computer. "Use my connected phone" is the only real-phone gate. Mobile tooling on the platform's computer is hidden.
- **Explore with AI** for a phone app is switched off at the button in runners mode, with the reason. In local mode the panel says
  where it runs (where the project runs its tests, from `GET /api/projects/:id/runner`, or `can.phoneSession` on the person's runner)
  and never changes the project's setting.
- The website no longer reads `GET /api/projects/:id/agents`: every runner shape comes from `GET /api/me/runner`.

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
and hands every run to its starter's runner. Exploring with the AI runs on the starter's runner too, with the AI on the platform
([explore-on-runner.md](explore-on-runner.md), round 51). Scheduled or triggered explorations, exploring a phone app, tests described
in words, agent runs, security assessments and recordings "on the server" are refused when made, with a sentence. The server's own browser launch and script runner refuse
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
- `tests/explore-on-runner-ui.test.ts`: exploring on your runner (not set up, offline, too old, named, "Exploring on").
