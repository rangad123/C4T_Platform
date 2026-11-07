# Runners pages: your own computer and team runners

Round 39 made the Runners page the place where a person adds a computer that runs tests. Two kinds of runner are shown:

- **Your computer** (a personal runner): one person's own computer. It takes only the runs that person starts, and their own schedules, in projects that allow people's own computers. Anyone who may run tests in some project may add one (at most 5).
- **Team runner**: a machine of an organisation (or one of Crowd4Test's shared runners) that runs the tests of the projects it is given, for everyone in them. Adding one needs "Manage runners".

Status of each part: the website side described here is **built** and tested in a real browser against a stand-in shaped like the server routes (`tests/runner-personal-ui.test.ts`). The server routes it calls (`src/platform/routes/runners.ts`, `src/platform/routes/runner-kits.ts`) are **built** and tested on their own (`tests/runner-enroll.test.ts`, `tests/runner-personal.test.ts`); the page also copes with an older server (see "With an older server").

## What a person sees

**Runners page** (`#/runners`).

- **Add this computer** appears when the server says `canAddPersonal: true`; **Add a team runner** when it says `canAddTeam: true` (an older server's `canRegister` counts as `canAddTeam`). Neither appears otherwise, so nobody is shown a button that answers 403. The old "Register a runner" (a token shown on screen) is no longer on the page.
- `#/runners?add=computer` opens Add this computer straight away (`ADD_COMPUTER_HREF` in `web/src/features/runners/runners.ts`); `?add=team` opens Add a team runner. Closing the panel leaves the address as `#/runners`.
- Each row has a **Yours**, **Personal** (someone else's computer) or **Team** badge next to its status. A **Kind** filter (all, your computers, team runners) appears once a personal runner is listed.
- The empty state: "A runner is a small program on a Windows computer or a Mac that runs the tests. Nothing runs until one connects." followed by what this person can do.
- The Runners item in the left panel shows for anyone with "Run tests" as well as "Manage runners".

**Add this computer**: the same three steps as Add a runner (`ux-add-runner.md`), with these differences.

1. **Choose the computer.** Windows or Mac (or Linux plain files), the kind of download and processor, guessed from the browser; a name ("My computer" by default). A note says what the computer will do: it runs only the tests the person starts and their schedules, in projects that allow people's own computers; for those runs the project's test accounts (passwords, sign-in codes, API tokens and saved sessions) are sent to it, so use a computer only you use; code scripts run on it, and it does not test localhost or addresses on your own network, both changeable on its page. For a team runner the step also asks for the owner (an organisation, or Crowd4Test shared) and the projects it may run (changeable later on its page).
2. **Download.** "The download holds a one-time code": the code connects one computer, once, within 30 minutes. **Download runner** posts `POST /api/runners/kits` with `{ runner: "personal" | "team", organizationId?, projectIds?, name, platform, kind | complete, arch, os }`; the server makes the code, puts it in the zip as `runner.enroll`, and answers with `x-runner-enrollment-id` and `x-runner-enrollment-expires`; the browser saves the zip and the page never sees the code. The step then says how long the code still works ("The code works once, until 14:32 (30 more minutes).", refreshed every 15 seconds). **Use a command instead** (closed by default) has **Show the command**, which makes a separate code with `POST /api/runners/enroll` (`{ kind, label, organizationId?, projectIds? }` → `{ id, code, expiresAt }`) and shows `node bin/ai-test-agent.mjs --url <address> --enroll <code>` for a developer's checkout, with **Copy command**. That code is on the page only while the command is open, and is kept in the panel's state only. A refusal (for example five computers already) shows the server's sentence. When the server cannot make a download (no `GET /api/runners/kits/info`, or `available: false`), the step offers only the command.
3. **Start it.** The start steps for the download, then "Waiting for the computer to connect…" with the code's remaining time. Every 3 seconds it asks `GET /api/runners/enrollments/:id` (the download's code, else the command's): `status: "used"` with an online runner means connected. It also reads `GET /api/runners` and accepts a runner that was not listed when the panel started, is online, and preferably has the typed name (this catches the other code, and a server without the record). "Connected: NAME is online" links to its page. When the code runs out first: "This code has expired" with **Make a new code** (back to step 2). After 3 minutes (test knob `?runnerWaitMs=`) it lists common reasons.

**A runner's page** (`#/runners/:id`).

- The header says "Your computer", "NAME's computer" or "Team runner · OWNER", with the badge and status.
- **This computer**: machine name, system and version (for example "Windows 11 (26100)"), processor, memory, cores, runner version, Playwright version, update state, when it was last heard from, how many runs it takes at once; then what it can run, its network, the last network problem and the computer check (the lines that need a look, and the full check under a disclosure). Facts a runner does not report are left out, not guessed.
- **Work**: current work, each linked to its run when the server sends `jobId` and the person may open that project; the queue and average wait.
- **This runner is offline** (when offline): when it was last heard from, that it runs only while its computer is on, signed in and online, and the steps for its system: Windows (it starts at sign-in and shows an icon next to the clock; open it and choose Start, or open AI Testing Runner from the Start menu, or run the setup again; a start script needs its window open), Mac (it starts at sign-in; open AI Testing Runner from Applications; or run start-runner.sh again), Linux (run start-runner.sh). A locked screen is fine.
- **What it may run** (when the server sends `settings`): on your own computer, **Run code scripts** (on by default) and **Test private and local addresses** (off by default); on a team runner, **Run code scripts** for someone who manages it; Crowd4Test's shared runners say they never run code scripts. Each change is `PATCH /api/runners/:id` with `{ codeScripts }` or `{ privateAddresses }`; the box changes at once, goes back if the server refuses, and a line says what changed. Someone who may not change them sees the state as a sentence.
- **Which runs it takes** (personal) replaces "Projects that use it" (team).
- Rename and retire as before, only with `canManage`.

## Server fields the pages read

On each runner of `GET /api/runners` and `GET /api/runners/:id`, all optional: `kind` (`"personal" | "team"`, absent means team), `mine`, `settings` (`codeScripts`, `codeScriptsSwitch`, `privateAddresses`, `privateAddressesSwitch`), `machine` (`os`, `osVersion`, `arch`, `memoryMb`, `cpus`, `playwrightVersion`, `agentVersion`), and `currentTasks[].jobId`. On the list answer: `canAddPersonal`, `canAddTeam`, and `personal` (`count`, `max`, `reason`; the reason is shown at the cap). Without `machine` the facts come from the agent's capabilities (`osVersion`, `memoryMb`, `cpus`, `playwrightVersion`). `GET /api/runners/kits/info` is expected to have the same shape as the project's kit info.

## With an older server

Without `canAddPersonal` there is no Add this computer. Without `kind` every runner is a team runner. Without `settings` the switches are not shown. Without `jobId` current work is plain text. Without `GET /api/runners/kits/info` the panel offers only the command.

## Limits

- The page sees the computer only once it connects; it cannot tell that the download was opened.
- The command needs a checkout of AI Studio; people without one use the download.
- The code is single use: if a second start uses it, the page waits until the code expires and then offers a new one.
- Tested in a real browser against a stand-in for this round's server routes (`tests/runner-personal-ui.test.ts`); the full journey against the real server is in the runner journey test.
