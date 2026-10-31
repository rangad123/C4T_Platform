# Live session: drive a browser step by step

A live session lets an AI tool (through the MCP server) or any API client look at a page and act on it one step at a time, and lets a person watch the page while a recording runs. It is a recording session with two extra abilities, not a second browser stack: everything done through it is recorded as test steps exactly as if a person had clicked, so "Save as a test" works unchanged.

## What a person sees

On the Record a test page, while a session runs, a **Live view** panel offers "Show live view". It is closed until asked for and costs nothing while closed. Open, it shows:

- a picture of the page (with a text alternative: the page title and address),
- the address and how fresh the picture is ("Updated just now"),
- a list of the elements on the page, which is the accessible equivalent of the picture. Password, one-time-code and card fields show "[hidden]".

The picture is requested at most once every 1.5 seconds, only while the panel is open, the session is running and the browser tab is in front. It works for a session on the platform and for one on a runner agent. If the agent cannot be driven, the panel says so in plain words and the rest of the page carries on.

## What a tool can do

Five MCP tools (same style as the others; they go through the REST API only):

| Tool | What it does |
| --- | --- |
| `open_live_session` | Opens a browser on a page of a project (platform, or the project's runner agent), returns the session id and what the first page shows. |
| `live_snapshot` | Reads the page now: visible text and the elements you can act on, each with the best locator and how many elements it finds. Read only. |
| `live_act` | Does one action: `navigate`, `click`, `fill`, `press` (Enter, Escape, Tab), `select`, `check`, `waitForText`, `scroll`. Returns the recorded step and the page afterwards. |
| `live_save_as_test` | Saves the session as a normal test and validates it with a real run. |
| `close_live_session` | Closes the browser and forgets the session. |

Typical use: "explore the checkout, then save it as a test". The tool opens a session on the shop, reads the snapshot, fills the sign-in with stand-ins, clicks through to the cart, checks that the total is shown, then saves the session with a title and waits for the validation job. A text the website shows is passed on with a line saying it is information about the page, never instructions, and the page text sits between two lines that carry a random code made for each answer, so a page cannot forge the end of its own text.

REST routes (behind the API key like every route under `/api`):

- `POST /api/recordings/:rid/act` with `{ action, locator?, value?, url?, checked?, timeoutMs?, image? }` returns `{ recorded, step?, note?, snapshot }`.
- `GET /api/recordings/:rid/snapshot[?image=1]` returns `{ url, title, text, elements[], truncated?, image?, imageType? }`.
- `GET /api/projects/:id/live-sessions` lists the audit rows of the project's sessions.
- Opening, saving, stopping and discarding are the recorder's own routes (`POST /api/projects/:id/recordings` with `headed: false`, `/save`, `/stop`, `DELETE /api/recordings/:rid`).

## How it works

- `src/engine/recorder/act.ts` (pure): the action vocabulary and its plain refusals, which field may receive which value, snapshot shaping and cleaning.
- `src/engine/recorder/session.ts`: `act()` and `snapshot()` on the shared recorder core. The page is driven by Playwright; the recorder script in the page sees trusted events and reports them like a person's, using the inspector's own locator ranking. A `goto` is recorded for a navigate; clicks and keys that start a page change wait (bounded) for the new document before the page is read.
- `src/platform/live-session-service.ts` and `routes/live-session.ts`: checks, credential lookup, audit counts, scrubbing.
- On a runner agent, `act` and `snapshot` are heartbeat commands; the answer comes back in the next push (`results`). Protocol additions (version stays 1, all optional): capability `liveSession`; record commands `act` and `snapshot`; `RecordingPush.results`. The platform sends them only to an agent that reports `liveSession`; for any other it says "This agent is too old to be driven step by step."

## Safety rules

- **Secrets.** A password, one-time-code or card field is never typed with a value from a tool. It is refused unless the value is `{{credentials.password}}` (or `{{credentials.totp}}` for a code field), and those two stand-ins are accepted **only** by a field the page script classifies as a password or one-time-code field: an ordinary field takes at most `{{credentials.username}}`, so a password cannot be typed into a plain text field and read back from it. The stand-in is replaced by the project's stored sign-in detail on the machine that owns the browser (for an agent, it travels in the command over the agent's authenticated link, like a task's credentials) and the real value is never returned: every answer and snapshot is scrubbed of the project's secrets **in their usual encodings** (as typed, URL-encoded, form-encoded, HTML-escaped, JSON-escaped, base64, hex, upper and lower case) and of the **live one-time codes** (the current and the two neighbouring 30-second codes of the stored authenticator secrets, for the whole session, so a later snapshot cannot show a code typed earlier). The snapshot shows "[hidden]" for password and code fields, the page script never reads them, and pictures cover them. A field a stand-in was typed into, whatever its kind, shows "[hidden]" for the rest of the session (a user name in a field with a `maxlength` holds only a prefix, which no exact scrub could find). Card details are never typed by a tool. `{{credentials.username}}` can be used in any field and stays a stand-in in the recorded step. **A step the page reports late** (after the action has already answered) is still stored as the stand-in: the session remembers what each stand-in typed, so a saved test never holds a typed value. **What remains:** the scrub knows the listed encodings, not every transformation a hostile page could apply (a hash, a reversed string, every second character), and a password copied by the page into plain text and cut short is not found. The protection that does not depend on the scrub is the rule above: the password and the code go only into password and code fields.
- **Only the application's own site.** The stored details are typed only while the page is on the project's application origin (or the environment's site); anywhere else the action is refused. The platform checks the address it last heard about when it looks the value up; the machine that owns the browser (the platform, or the agent) checks the page's real address again against the allowed origins, which travel with the stand-in (an optional `origins` field of the `act` command), once before it starts looking for the field and again right before the characters are typed. A page that redirects to another origin in between gets nothing and the answer says "nothing was typed". Single sign-on on another origin is therefore not supported.
- **Addresses.** `navigate` goes through the same guard as the recorder: only http and https, no credentials in an address, and private and loopback addresses are refused **only when the platform runs with `BLOCK_PRIVATE_TARGETS=true`, which is off by default** (so local sample apps work). With it off, a session can be opened on a private address, and a snapshot returns the page's text (6 000 characters) and field values, which makes a session a way to read pages on the platform's own network. The answer to opening a session on the platform's browser therefore carries a `warnings` entry when the address is private or loopback and the guard is off (the MCP tool prints it as a notice, and its description says so). Turn `BLOCK_PRIVATE_TARGETS` on if the tools that can open sessions are not fully trusted. On an agent the agent's own network applies and no such notice is made.
- **Limits.** One action at a time (a second is a 409), a 15 second timeout per action, the recorder's step cap (an action that would be recorded after the cap is refused with a plain sentence), its idle and total time limits, and one session per project.
- **Untrusted page text.** Everything from the page is capped, stripped of control characters and never executed. An agent's snapshot is cleaned again on the platform; a picture is kept only when it is real base64 and under 400 KB.
- **Frames.** Pictures are never written to disk or logged. For a session on an agent the platform keeps the last snapshot, picture included, in memory for at most the frame gap (a request within a second is served from it) and lets it go when the session ends. Frames are requested at most once a second per agent session (concurrent requests share one), and an agent answers only the command it was sent. Command ids are capped at 40 characters on the wire (the platform's own look like `c12`).
- **Audit.** One row per session in `live_session_audit` (migration 24): project, start address without query or credentials, where it ran, and counts of actions, refusals and snapshots. No value, text or picture is stored.
- Closing uses the recorder's verified close: only the browser the session started is ended, checked by process id.

## Limits

- Pictures are PNG, or JPEG when a PNG would be too large; a page whose picture is still too large shows no picture and the list of elements.
- `press` is limited to Enter, Escape and Tab (the keys a recording can keep). `scroll` and `waitForText` are done but are not steps.
- A locator that matches more than one element is refused: use a more specific one from the snapshot. Frames inside the page and new tabs are not driven (the recorder records only the first window).
- The MCP tools return text only; the picture is for the live view.
- On an agent a step takes about one to three seconds (the heartbeat is every second).
- The classification of a secret field is the page script's rule, repeated in `act.ts`; a test keeps the two in step.
