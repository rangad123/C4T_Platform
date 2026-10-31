# Explorer view: watch the AI explore (and build) in the platform

What changed for the tester (EXPLORER-VIEW, round 15). The owner asked: "While this platform is exploring the website through AI, why can't we see it happening on the device screen?" The exploration browser is headless and runs on the platform's own computer, so a person only had a text log. Now a person can switch on a live picture of that browser.

## For the tester

- **Watch live.** Under the steps of an exploration, and of a test built from a sentence ("Describe it"), there is a labelled switch, **Watch live**. It is off until you turn it on, and the choice is remembered in this browser (local storage; a browser that refuses storage simply starts off every time). While it is off the page asks the platform for nothing and the platform takes no pictures.
- **Explorer view.** With the switch on and the job running, a panel shows:
  - a picture of the page the AI is on (text alternative: the page title and address),
  - the **address** and the **page title** as text,
  - **Doing now**: one line built from facts, for example "Opened /pricing", "Read 12 links", "Clicked Sign in", "Filled the Email field", "Filled in a hidden field", "Signed in",
  - the stage in words ("Exploring pages", "Signing in", "Building your test"), "12 pages seen" and "Updated just now",
  - **Stop exploring** ("Stop building" for a test built from a sentence): the same Stop dialog as everywhere (it says what is kept). The ordinary Stop control of the progress card is replaced by this one while the panel is open, so there is never a second kind of stop or two copies of one,
  - one sentence: "This is a picture of the browser the AI is using on the platform's computer. It refreshes about once a second while this panel is open. Passwords are hidden."
- **Calm states.** "Waiting for the first picture…" before the first one; "Nothing to show right now." while the AI works without a browser (understanding, planning) with the last picture kept and dimmed; "This part runs on another computer and cannot be shown."; "The picture could not be loaded. Trying again…" with a back-off; a "too many requests" answer is not shown as a problem.
- **Finished.** When the job ends, the panel stays on the Overview as a finished panel: "Exploration finished: 14 pages seen" (or "Exploration stopped: …", "Building finished") with the last picture still on screen. The platform no longer holds that picture; the page keeps it in this tab's memory only and drops it when the person leaves the project page.
- **Accessibility.** The panel is a labelled region; the picture has a text alternative; the "Doing now" line changes on screen at once but a separate polite live region repeats it to a screen reader at most once every 5 seconds; the switch and Stop are reachable by keyboard with a visible focus and are at least 44 px high; both colour schemes; phone width without sideways scrolling (the picture scales).
- **Guide.** Topic "Watch the AI explore" (`watch-the-ai`, group Making tests) and a line in the Overview's place help.

## What it shows and does not show

- It shows a **picture** of the browser, not the real window. Why a picture: the exploration browser runs headless on the platform's computer (possibly a server nobody sits at), and a person looks at it through a web page; a picture needs no screen-sharing, works through proxies and the API key, and can have secrets covered before it leaves the browser. A real window cannot be covered, and it would not be visible on a remote server at all.
- `HEADLESS=false` (platform setting) makes the browser open a real window on the platform's computer, for someone sitting at that computer. It has no connection with the Explorer view: the picture is the same either way, and the view works with the default `HEADLESS=true`.
- Pictures are at most 640 px wide, JPEG, at most 120 KB (lower quality is tried first, then the picture is skipped), at most one a second, taken by the browser itself with a scaled clip (no image library).
- **Whatever the page shows is in the picture**, apart from the fields below. A page that shows personal data on screen shows it in the picture. The picture is only for the person who holds the API key and reads the route.
- **Secrets.** Before a picture is taken, every password, one-time-code and card field is covered (the recorder's own rule, `secretKindOfField`, applied to every input of the page and of its frames), and so is **any field whose current value contains one of the project's stored sign-in secrets** (password, authenticator secret, API token, the passwords of named test accounts, and an environment's own), wherever the AI typed it. The cover is put on and taken off again in the same step (the page's inline style, value and markers are restored exactly; a test checks this). If a frame of the page cannot be covered, **no picture is taken** (it fails closed).
- **The stored user name** (the sign-in e-mail) is not a secret in this platform and **can appear** in a picture when the AI types it into the sign-in form. The activity line never carries a typed value.
- **The activity line** is made from facts: a path (no host, no query), the accessible name of a control the AI chose to use (cut to 40 characters, dropped if it contains a stored secret), a count. It carries no page text beyond that, no typed value, at most 80 characters. The address shown next to the picture has no credentials and no query values (`?…`), a `#/route` is kept.
- The title is the page's own `<title>` (up to 200 characters).

## Privacy and limits of storage

- **Only while watched.** The platform marks a job "watched" for 10 seconds after each read of the picture route. The engine asks before every picture and takes none (no screenshot, no cost) when nobody is watching. A test proves this: an exploration nobody watched produced no picture at all.
- **Memory only.** One latest picture per active job in the platform process's memory, at most 8 jobs held (the oldest goes first), dropped when the job ends or is stopped and after 30 seconds without a new one. Never written to disk, never logged, never part of an event or a database row. The job answer only gains `canWatch: boolean`.
- **Rate.** At most 3 reads a second per job (`429` with `Retry-After: 1`).
- **Access.** The route is behind the API key like every route under `/api`; another project's job, an unknown job or an unknown project is a 404.

## How it works (platform and engine)

- `GET /api/projects/:id/jobs/:jobId/frame[?since=<at>]` (`src/platform/routes/explorer.ts`) answers `{ available, mime: "image/jpeg", watching: true, ... }`:
  - `available: true` with `imageBase64`, `url`, `title`, `note`, `phase`, `pagesSeen`, `at`, `ageMs`. With `?since=<at>` of the picture the caller already has: `{ available: true, unchanged: true, ... }` without the picture.
  - `available: false` with a plain `reason` and `why`: `waiting`, `nothing`, `elsewhere`, `finished`, `stopping`, `unavailable`.
- `canWatch` on the job answer is true while a browser part that is wired runs on this platform: the exploration itself (discovery, including a plan-only exploration; not "create from a plan", which explores nothing) and the browser work of a plain-English test (web).
- Engine: `ctx.frames?: FrameSink` (`src/engine/context.ts`, `src/engine/frames/sink.ts`). It is set by the job runner only for those two kinds of job. The engine calls `ctx.frames?.capture(page, facts)` after a page opens and is read (`discovery/crawler.ts`), around the sign-in (`discovery/auth.ts`) and after each action of the plain-English builder (`web/author.ts`, passed only by `authoring/plain.ts`; the writers of an exploration's tests are not wired). Unset, nothing changes: every call is `undefined?.…`.
- `src/engine/frames/shoot.ts` covers, takes the picture (Chrome DevTools Protocol, scaled clip, quality ladder 55, 40, 28) and uncovers; `activity.ts` builds the line; `src/platform/frame-hub.ts` is the per-job memory (watched window, caps, rate allowance, secret list of the job).
- Web: `web/src/features/explorer/*` (`ExplorerView.tsx`, `explorer.ts` hooks, `explorer-text.ts` words and the tab's kept picture), hooked into `JobProgress.tsx` and the project Overview.

## Limits and what is not covered

- **Runner agents.** Exploration and the plain-English builder always run on the platform's computer. A test run on a runner agent (a different job part) cannot be shown: the answer says "This part runs on another computer and cannot be shown." The recorder's own Live view (Record a test) is a separate feature.
- **Separate worker program.** A picture reaches the API server only when the job runs in the same process (the normal case and `npm run dev`). When the worker is a separate program (`npm run worker`) the server cannot see its memory, so the view says "The jobs of this platform run in a separate worker program, so its browser cannot be shown here." Not built: carrying pictures between processes would mean writing them somewhere.
- **Not wired:** the test writers that run during creation (several browsers at once), the access survey, validation runs, and headed (real) windows.
- **Cross-origin frames.** Fields inside frames of other origins are covered through the browser's own frame access and the picture is taken from the whole page; this is exercised in tests only for a frame of the same site (a `srcdoc` frame), not for a real cross-origin payment frame. Pages with more than 12 frames get no picture.
- **Chromium only** (the exploration browser). A failing camera gives no picture and the exploration carries on.
- A very quick exploration may show only a few pictures: at most one a second, and the first only after someone has started reading.
- The picture is a still of the visible part of the page (not the whole page), animations are not shown.
- A stopped job drops its picture on the next read or within 5 seconds (the job runner's check); a picture taken in that moment is dropped when the job ends.

## Tests

`tests/explorer-view-unit.test.ts` (fast tier: sink throttle and watched logic, size and scale decisions, fields to cover, fail-closed covering with page doubles, activity line, per-job store caps and clocks, watch rules), `tests/explorer-view-camera.test.ts` (real Chromium: JPEG size, 640 px, pixel checks that secret fields, a field holding a stored secret and a frame's password field are covered while ordinary fields are not, page restored exactly, scrolled pages, narrow pages), `tests/explorer-view.test.ts` (real platform and worker: pictures, `unchanged`, no picture without readers, the sign-in page's pixels and the page's own report that the cover was on during a picture and off after, no secret in any answer, `canWatch`, "nothing to show" while analysing, frames gone after the end, a stopped job, rate limit, 404s, API key, the plain-English builder), `tests/explorer-view-ui.test.ts` (real browser: the switch, polling, pause when hidden, back-off, throttled announcements, Stop dialog, keyboard, targets, axe in both themes, 375 px, the finished panel, one real exploration with Stop).
