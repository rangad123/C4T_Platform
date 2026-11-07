# Recordings, live sessions and phone sessions on people's own computers

A person's own computer (a personal runner) hosts a recording, a live session or an AI phone session **only for its owner**. Team
runners keep the project's rules. This page says what is built and tested, and what is not.

## Who may use it

- **Choosing a machine.** The recorder, the live session (a recording driven step by step) and the phone explorer choose from the
  caller's own computers and the team runners given to the project (`sessionHosts` in `src/platform/agent-record.ts`). Another
  person's computer is never in the list. Naming it by id answers 404, as for an id that does not exist. Own computers count only
  while the project allows people's own computers and the person may still run its tests.
- **Who started it.** Every record and device task keeps who started it: on the task (`agent_tasks.owner_id`, set at enqueue) and on
  the session. A phone session of an exploration belongs to the person who started the job (or made its schedule).
- **Offering.** A record or device task goes only to the machine it was started on. On a person's own computer, it also needs the
  owner to be the starter, the project to allow people's own computers, and the owner to still reach the project
  (`offerSession` in `src/platform/agent-services.ts`; the claim itself checks the owner too). A phone session there also needs a
  runner that reports `runnerSwitches`, so an older runner never gets one.
- **Reading and driving.** Every `/api/recordings/:rid…` route (read, snapshot, act, inspect, edit, save, stop, discard) answers 404
  to anyone but the starter when the session is on a person's own computer. The access key is not a person, so it is refused too.
  The phone sign-in question of an exploration (`/api/projects/:id/jobs/:jobId/phone-sign-in`) follows the same rule.
- **Access ends, session ends.** On every heartbeat of a session (any runner), the platform checks that its starter is still active
  and may still run the project's tests. On a person's own computer it also checks that the project still allows people's own
  computers and the computer was not retired. If not, the heartbeat answers `cancel` and the session ends with a plain sentence.
  Recorded steps are kept.

## Real phones on a person's own computer

- **"Use my connected phone"** (`agent_tokens.allow_real_phone`, off by default; the owner turns it on with
  `PATCH /api/runners/:runnerId` `{ realPhone: true }`). While it is off, the device task carries `realPhone: false`, and the runner
  uses only an emulator: a running one, else an AVD it starts. A phone named by serial is refused, and so is a computer with only a
  real phone. The sentence says what to do.
- The chooser refuses up front when the computer reports no emulator and the switch is off.
- **App removal.** On a person's own computer the device task also carries `removeInstalledApp: true`. On a real phone, if the app was
  not there before the session installed it, the runner uninstalls it when the session closes (`uninstall <package>`, allowed only
  through `Adb.forCleanup()`). An app that was already on the phone stays.
- The project's own "emulator only" phone setting now reaches runners too (`emulatorOnly`). Before, only this server honoured it.

The new fields on the device task (`emulatorOnly`, `realPhone`, `removeInstalledApp`) are optional, so protocol-1 runners keep working.
Team runners get none of them unless the project asks for an emulator.

## Tested

`tests/runner-sessions-personal.test.ts` (a real platform through inject, stand-in runners, and the fake adb): another person cannot
pick, see, read, drive, stop or discard a recording on someone's own computer; its owner can; another person's session is never
offered to it; access lost or the project switch turned off ends the session within one heartbeat; a team runner's recording stays
readable by the project; the phone offer says "no real phone" until the switch is on; the agent passes the rules to the phone
session; the session on the runner never uses a real phone while the switch is off, and removes the app only when it installed it.

## Limits

- Sessions live in the platform's memory, as before: a restart ends them.
- The rule is checked when the task is offered. If the owner turns "Use my connected phone" off after a phone session was queued but
  before it started, that session still carries the old answer.
- The runner keeps no copy of the owner's choice of its own. It follows what the task says, and only runners that report
  `runnerSwitches` get these tasks.
- The list of past live sessions (`GET /api/projects/:id/live-sessions`) still shows every session's address and counts to the
  project. It holds no page text, pictures or typed values.
- The exploration job's own pages (events, screens in the live view) follow the job's rules. They are not limited to the starter.
- Private and local addresses inside a recording on a person's own computer are a separate guard. See `runner-agent.md` and
  `docs/runner-implementation/SECURITY_DESIGN.md`.
