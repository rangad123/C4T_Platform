# More alert channels (Microsoft Teams, email) and Maestro import

Two small additions. Alerts can now go to **Microsoft Teams** and by **email**, next to Slack and any web address. And flows
written for **Maestro** can be imported as tests.

## Part 1: Teams and email alerts

Open a project, choose the **Schedule** tab, and in **Alerts** press **Add a channel**. The channel types are Slack, Microsoft
Teams, Email and any web address. The events you can pick, the minimum severity, "once per situation", the **Send test** button
and the **Recent alerts** log work the same for every type. See [schedules.md](schedules.md) for those.

### Microsoft Teams

* In Teams, create a **workflow** that posts to a channel when a webhook request arrives (the "Post to a channel when a webhook
  request is received" template), and paste the URL it gives you. Older Office 365 incoming-webhook URLs work too.
* The URL is a secret, like a Slack webhook URL: it is stored encrypted and only its host name is ever shown again.
* The message is an **Adaptive Card** in the format Teams Workflows accept (`type: "message"` with the card as an attachment):
  a title, one sentence on what changed, the pass count, the failing and flaky counts, the top five findings, and an
  **Open project** button. It carries the same words as the Slack message. Text from your tests is escaped so a test title
  cannot become a link or bold text in the card.

### Email

* Choose **Email**, type up to **10** addresses (separated by commas), and choose a mail server (below). Addresses are checked
  (plain `name@example.com`; duplicates collapse).
* Each alert is one mail with a subject such as `Test run failed: Acme shop (7 of 9 passed)`, a plain-text body and a simple
  HTML body with the same content and a link back to the project. Everything that comes from your tests is escaped, and the
  subject is always one line.
* **Mail server.** Either:
  1. **Server-wide settings** in the platform's environment (`.env`), used by every email channel:
     `SMTP_HOST`, `SMTP_PORT` (default 587), `SMTP_SECURE` (`true` for TLS from the first byte; default `true` only for port 465),
     `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` (a host and a sender are the minimum); or
  2. **Settings of the channel itself** (host, port, secure connection, "send from", optional user name and password), typed in
     the form. A channel's own settings replace the server's for that channel.
* **The user name and password are secrets.** In a channel they are stored encrypted (the same `SecretBox` as webhook addresses),
  can be written but never read back (the API says only whether a sign-in is saved), and are never put in a message, a log
  line or an error text. In the environment they are only read by the server process. To change a password, send the new one
  (`PATCH …/alert-channels/:id` with `{ "smtp": { "password": "…" } }`); anything left out stays as it was. `{ "smtp": null }`
  goes back to the server-wide settings.
* **No mail server set up?** Creating an email channel answers HTTP 422 with a plain sentence naming what to set (`SMTP_HOST` and
  `SMTP_FROM`, or the channel's own settings). The form tells the same thing.
* **The mail server goes through the same address guard as webhooks.** With `BLOCK_PRIVATE_TARGETS=true` a mail server on a
  private or loopback address is refused when the channel is saved and again before every send.
* **A password is not sent in the clear to a server on the internet.** When a sign-in is configured and the connection is not
  secure from the start, the server must offer STARTTLS, unless it is on a private network address.
* **Delivery.** A temporary failure (the server asks to try later, SMTP 4xx, or cannot be reached) is retried like a webhook
  (waits of 0.5 s and 2 s). A refusal (wrong sign-in, refused recipient, SMTP 5xx) is final, is shown in plain words in
  **Recent alerts** (for example "The mail server refused the sign-in. Check the user name and password."), and never fails a run.
  **Send test** tries once, so what it reports is the real answer.

### API

`POST /api/projects/:id/alert-channels`

```json
{ "kind": "teams", "url": "https://….logic.azure.com/workflows/…" }
{ "kind": "email", "recipients": ["qa@example.com"], "smtp": { "host": "smtp.example.com", "port": 587, "from": "alerts@example.com", "username": "…", "password": "…" } }
```

`smtp` may be left out when the server has its own settings. `GET /api/projects/:id/alert-options` says whether it does
(`email.serverMail`, never including the sign-in). A channel answer for email adds `recipients` and `smtp`
(`source` is `server` or `channel`; host, port, secure, from, `hasLogin`).

### Limits

* Teams: delivery is "the receiver answered 2xx"; whether the card then shows up in the right channel depends on the workflow
  you built in Teams, which the platform cannot see. The Adaptive Card was checked against the format, not against a real Teams.
* Email: tested against a local fake SMTP server (sign-in, recipients, retries, refusals), not against a real provider. TLS to a
  real server is nodemailer's; it is not exercised here. There is no per-recipient delivery tracking (a mail accepted by the
  server may still bounce later).
* Email has no digest: one run, one mail, per channel.

## Part 2: Import Maestro flows

[Maestro](https://maestro.mobile.dev) (Apache-2.0) describes mobile UI tests in YAML. Open **Tests**, press the **More actions**
menu and choose **Import Maestro flows**. Choose one or more `.yaml` files. You first see what each file would become, and which
steps are left out and why; nothing is stored until you press **Import**.

* A flow with an `appId` header becomes a **mobile test** (it runs with Taqwright and Appium on an emulator, like the platform's
  other mobile tests, and the project's mobile app is set from the `appId`). A flow with a `url` header (Maestro for the web)
  becomes a **web test** against that site.
* The tests are stored the same way as **Import tests** does it (same address checks, same rendering, same validation run),
  in the area **Imported from Maestro**, tagged `maestro`. **Nothing in a flow is executed by the import**, and no script, file
  or link a flow names is run or fetched.
* One import is for one app: flows for a different app or site than the first one that converts are left out with that reason.
  Import them separately.

### What is converted

| Maestro | Becomes | Notes |
|---|---|---|
| header `appId` | mobile test for that app | must look like `com.example.app` |
| header `url` | web test; starts by opening the address | must be a plain http(s) address |
| header `name`, `tags` | the test's title and tags | the title falls back to the file name |
| `launchApp` | nothing | every mobile test already starts the app from its first screen; extra options (`clearState`, `permissions`, ...) are noted as ignored |
| `tapOn: "text"`, `tapOn: {text, index}` | click on the element with that text | the text is matched as typed (Maestro treats it as a pattern; a note says so when it looks like one) |
| `tapOn: {id}` | click on the element with that id | mobile: test id; web: the element's `id` |
| `inputText` | fill the field | only straight after a `tapOn` that names the field (the importer cannot know which field is focused otherwise) |
| `assertVisible`, `assertNotVisible` | check that the element is shown / hidden | |
| `scroll` | scroll down (web: the Page Down key) | |
| `scrollUntilVisible` | scroll until the element is on screen (web: a check that it is on the page) | the direction is chosen by the runner |
| `back` | the Back button | mobile only |
| `pressKey` | `Enter`, `Backspace`, `Tab`; mobile also `Back` and `Home` | other keys are reported |
| `swipe` with a `direction` | a swipe that way | mobile only; swipes between points are reported |
| `waitForAnimationToEnd` | a short wait (its `timeout`, at most 10 s; default 1 s) | |
| `runFlow` with inline `commands` | those commands in place | |

Variables: `${PASSWORD}` and similar names become `{{credentials.password}}`, `${USERNAME}` / `${EMAIL}` become
`{{credentials.username}}` (set on the project's test sign-in), and any other plain `${NAME}` becomes `{{env.NAME}}` (read
from the run's environment variables). **Values given in a flow's `env:` are never copied**; the import lists the variables the
test will read so you can set them. A script expression such as `${a + b}` is reported.

### What is reported instead (the step is left out, the rest is imported)

`tapOn` a screen point, optional steps (`optional: true`), selectors that depend on position or state (`below`, `above`,
`enabled`, ...), `inputText` without a preceding tap, `swipe` between points, other keys, `runFlow` from a file or with a
`when` condition, `repeat`, `runScript`, `evalScript`, `openLink`, `hideKeyboard`, `takeScreenshot` and every other command not
in the table, `onFlowStart` / `onFlowComplete` hooks, and `back` / `swipe` in web flows. Each is listed with its step number and the reason.

A flow is **left out as a whole** (with the reason) when it names neither or both of `appId` and `url`, when its address or app id
is not valid, when it is not a flow (for example Maestro's `config.yaml`), or when **none of its checks could be converted**: a
test that only taps and never verifies anything would pass without proving anything.

### How it works

`src/engine/import/maestro.ts` is a pure converter (YAML in, spec out). The route `POST /api/projects/:id/import/maestro`
(`{ files: [{ name, content }], validate?, dryRun?, baseUrl? }`) converts, and hands the specs to the project's normal
spec import (`POST /api/projects/:id/specs`), so every check of that route applies. The answer lists, for every file, whether it
was converted or left out, the reason, the notes per step and the variables. `dryRun: true` only reports.

New: the mobile script generator understands a few device actions in a `press` step (`device:back`, `device:home`,
`device:scroll:<direction>`, `device:swipe:<direction>`, `device:scroll-into-view` with a locator). They are how the spec says
"press Back" or "scroll" without a new kind of step. A `press` with any other key is unchanged.

### Limits and safety

* At most **100 flows** per import and **200 KB** per file (more is answered with HTTP 400). The request as a whole is limited
  by the server's normal 8 MB body limit. The files are sent as JSON; there is no multipart upload.
* YAML is read with the plain YAML types only: custom tags (for example `!!js/function`), duplicate keys and alias bombs are refused
  with HTTP 400 and the name of the file. Every unreadable file is listed, not only the first.
* Not converted: Maestro's iOS-only commands, relative selectors, conditions, loops, scripts, sub-flow files, `env:` values,
  and anything not in the table above. Converted mobile tests need an emulator to run, like all mobile tests here.
* There is no `ai-test import maestro` command: the CLI has commands that run and export tests, but none that writes to a platform
  project, so there was no natural place for it. Use the screen or the API.
* Tested with flows written for this project from the public Maestro documentation, not with a large collection of real-world flows.
