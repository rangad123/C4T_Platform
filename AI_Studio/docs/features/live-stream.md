# Live updates (server-sent events)

A person watching a run sees its events as they happen: on the Overview (the newest step), in the activity log under "View technical details", and on the Runs page (a "Live" marker and the newest step of each running job). Runs that execute on a runner agent are included: "Maya's laptop: Finished 2 of 12 tests" appears while the agent works.

If the live connection cannot be made or is lost, nothing breaks: the pages show "Live updates paused, retrying" and carry on with the polling they always had, then return to live by themselves.

## Why server-sent events, not WebSocket

The traffic is one way (platform to browser). Server-sent events (SSE) work through ordinary proxies, the browser reconnects by itself, and no dependency is needed (no `@fastify/websocket`). Anything the browser would send goes through the normal REST routes.

## The routes

| Route | What |
|---|---|
| `POST /api/stream-tickets` `{path}` | with the API key (header): 201 `{ticket, expiresInSeconds}`. `path` must be exactly a stream route of something that exists |
| `GET /api/test-generation/:jobId/stream` | one run: `job`, `log`, then `end` |
| `GET /api/projects/:id/stream` | every run of a project, until none is active |

Frames (`text/event-stream`):

- `event: job`, `data:` the run as `GET /api/test-generation/:jobId` shows it (status, phases, counters). Sent at connect and whenever it changes. No `id`, so it never moves the resume position. The first frame of a connection that skipped older events carries `earlierEvents: n`.
- `event: log`, `id:` the event's id, `data: {id, at, level, message, stage, kind, jobId}`.
- `event: end`, `data: {status}`, then the server closes. Job streams end when the run is finished (after its last events); project streams end when no run of the project is active (`status: "idle"`).
- Comment lines: `: live` first (with `retry: 3000`), then `: keep-alive` after 15 s of silence.

### Resuming without gaps or repeats

`id:` is the job-event id (one increasing counter for the whole database). A reconnect sends `Last-Event-ID` (the browser's own reconnect) or `?lastEventId=` (a hand-made one, because a new EventSource cannot set headers). The server replays every event after that id, in id order, in pages of 200, then carries on. The position moves only after a frame was written and a frame with an id not above it is never sent, so an event is neither lost nor sent twice. SQLite hands out ids under its single writer lock, so a larger id is never committed before a smaller one.

A new connection without a position shows the 500 most recent events of the run and says how many older ones exist (`earlierEvents`). A project stream without a position shows what happens from now on (and the current state of the newest and the active runs). A resume is exact and has no cap (it is read in pages, never all in memory).

## The database is the source of truth

A worker may run in another process (`npm run worker`), and then an in-memory bus would never see its events. So each stream **tails the job-events table**: a loop reads the run's state, then the events after the last one sent. The loop runs every 250 ms while something is happening and backs off by half each quiet round to 1 s. When the API process itself writes an event (`Repo.addEvent`, a status, phase or counter change) it rings an in-process bell (`event-bus.ts`) that wakes the loop at once; the bell carries no data and losing a ring costs at most one poll. The state is read **before** the events, so when a run is seen finished all its events are already readable and the end frame comes after the last one.

No database connection is held by a stream (they share the process's connection); each stream has at most one timer, and none is left after it closes.

## Authentication and tickets

The stream routes need the API key like every other route. A browser's EventSource cannot send headers and the API key must never be in an address or a log, so the page asks for a **ticket** (the key travels in a header) and opens the stream with `?ticket=...`. A ticket:

- is 24 random bytes, only its SHA-256 is kept (in memory);
- opens exactly one stream path, once, within 60 seconds. Trying it for another path, or twice, or late, is refused (401) and burns it;
- is the only credential accepted in a URL on these routes: `?key=` is **not** accepted on a stream.

The request log writes `ticket=[hidden]` (and `key=[hidden]`). The server also masks the configured API key in any event text. A scripted client can use the header directly.

## Limits and safety

- At most 100 streams in the process and 20 on one run or project; the next one gets 429 with a plain message ("Too many live views are open right now...") and the page keeps polling. (A refused request has used up its ticket.)
- A stream closes after 2 hours without an end frame; the browser reconnects with the ticket and position.
- A client that cannot keep up (more than 512 KB unsent, or no drain within 10 s) is dropped; it reconnects and resumes from its last id. Others are unaffected.
- A closed tab, an ended run, a server shutdown (`onClose` closes every stream) all release the stream, its timer and its bell subscription.
- Events are plain text capped at 1000 characters, already scrubbed of the run's credentials. Nothing else is sent.

Settings (environment variables, mostly for tests): `STREAM_POLL_MS`, `STREAM_MAX_POLL_MS`, `STREAM_HEARTBEAT_MS`, `STREAM_MAX_AGE_MS`, `STREAM_MAX_STREAMS`, `STREAM_MAX_PER_JOB`, `STREAM_MAX_BUFFER_BYTES`, `STREAM_DRAIN_TIMEOUT_MS`, `STREAM_TICKET_TTL_MS`.

## Runner agent progress

The agent (`src/agent/*`) sends progress lines in its heartbeat (at most 20 per beat, 300 characters each, as before; the protocol is unchanged). New: lines go out **within about a second** instead of at the next beat (a beat is never more often than once a second and never later than the platform's `heartbeatSeconds`), lines that could not be delivered are kept for the next beat, and the last lines are flushed before the result. The lines are plain: "Downloading 2 baseline images", "Running 12 scripts", "Finished 3 of 12 tests: login works (passed)", "Removing the test data the run created", "Uploading screenshots and other files", and the emulator start-up messages. "Finished k of n" comes from Playwright's list reporter, which is added to the run's configuration **only when progress is asked for** (the agent), so local runs and generated scripts are unchanged.

On the platform the heartbeat turns each line into a job event (`kind: agent_progress`), prefixed with the agent's name and scrubbed of every credential of the run, as it arrives. The stream shows it at once.

## In the browser

`web/src/lib/stream.ts` (`openStream`, `useJobStream`, `useProjectStream`). `JobProgress` shows the newest event in one status line (the only `aria-live="polite"` region of the live view, never every log line); the activity log has a "Pause updates" toggle (new lines are counted and shown on "Resume updates"), follows new lines only if the reader is at the bottom, fades new lines in over 140 ms (not at all with reduced motion), and shows the log from the stream with the old 3-second polling used only while the stream is not connected. After a failure the page asks for a new ticket and reconnects after 1, 2, 4... up to 30 seconds, resuming after the last id.

## Where the code is

`src/platform/stream-core.ts` (framing, resume id, ticket store, caps, the tailing loop), `stream-store.ts` (queries), `event-bus.ts`, `routes/stream.ts`; hooks in `repo.ts` (`addEvent`, status, phase and counters ring the bell), `server.ts` (API-key hook accepts a ticket on exactly the two stream routes; log redaction), `agent-services.ts` (`surfaceProgress`), `src/agent/beat-pacer.ts`, `task-runner.ts`, `task-child.ts`, `engine/validation/runner.ts` (`ProgressParser`, optional `onProgress`).

## Limits

- One process holds the tickets: a restart invalidates tickets that were not used yet (the page asks again).
- Per-test progress exists for Playwright (web and API) runs on agents; Appium and desktop runs report only the stage lines and emulator messages.
- A project stream starts from "now": history comes from the normal run list.
- Behind a proxy that buffers responses the stream is delayed; the page then looks like polling. The server sends `X-Accel-Buffering: no` and a keep-alive every 15 s.
