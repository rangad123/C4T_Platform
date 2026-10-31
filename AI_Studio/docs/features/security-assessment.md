# Security Assessment

A separate module for the owner's security assessment work: register a client's web application, record the client's authorization,
run a **passive, read-only assessment** of it, manage the findings (with their validation by people), re-test, and hand over a report.
It lives in `src/security/` (server) and `web/src/features/security/` (pages) and is independent of functional testing: its own tables,
routes, jobs, pages and reports. Functional testing never imports `src/security`, and with `SECURITY_ASSESSMENT=off` it is exactly as before.

## What it is, and what it is not

- **It is** a configuration review from the outside: the same ordinary requests a visitor's browser makes (GET, HEAD, OPTIONS), read and
  judged for problems such as missing security headers, cookie flags, TLS, CORS answers to an ordinary request, files that should not be
  public, version banners and directory listings. Findings can also be entered by hand from the client's own tools.
- **It is not** a penetration test. It sends no attack payloads, does no fuzzing, exploitation or brute force, and submits no forms. A
  report never calls an application "secure": it lists what was found and what was not inspected.
- **External scanners are a separate, off-by-default layer** ([docs/features/security-scanners.md](security-scanners.md)). With
  SECURITY_SCANNERS unset, nothing below changes: no tool is started, no route changes, and the assessment is exactly the read-only
  review described here.

## Overview of a project's work

1. **Testing type.** A project is for functional testing, security assessment, or both (`functional` until someone chooses; Setup and
   New project). Turning security on for an existing project works without recreating it.
2. **Register the application**: name, target address, environment (development, staging, production, other), extra origins or host
   patterns in scope, path prefixes never to request, the request rate (1-10 per second, default 2), the public API document address, notes.
3. **Record the authorization** (owner role). The person confirms a plain, specific statement: *"I confirm that &lt;client&gt; owns
   &lt;target&gt; or that its owner has given documented permission to assess it, within the scope listed."* (the scope and exclusions are
   spelled out after it), with the basis (we own it / the owner's documented permission), the approver's name and email, a reference to
   the engagement letter or permission document, and any restrictions. Who confirmed it and when are recorded with the exact sentence.
4. **Assess**, then review findings, re-test and export the report (sections below, written by the parts that built them).

## The authorization rules

- No assessment starts without a **current** authorization.
- An authorization covers a fingerprint of the target, the scope entries, the exclusions and the request rate (normalized: order and
  case of scope entries do not matter). Changing any of those makes it **stale**: the application page and the API say *"The target,
  scope, exclusions or request limit changed after the authorization was recorded. Record a new authorization before the next
  assessment."* Changing the name, environment, notes or API document address does not.
- Recording a new authorization revokes the earlier ones ("replaced by a newer authorization"). **Revoking** one (owner) also asks a
  running assessment of that application to stop.
- While an assessment runs, the target, scope, exclusions and rate cannot be changed and the application cannot be deleted (409).

## Safety: the scope guard

Every request an assessment sends, by plain HTTP or from the browser, goes through `src/security/scope.ts`:

- only `http` and `https`; no user name or password in an address;
- the host must be the target's own origin, or match a scope entry: an origin (`https://api.example.com`), a host
  (`static.example.org`, or `reports.example.org:8443` for another port) or a subdomain pattern (`*.cdn.example.net`, which covers
  subdomains, not the bare domain). Host and pattern entries cover the default port only;
- excluded path prefixes are never requested; the comparison ignores case, decodes `%xx` and collapses doubled slashes
  (`/admin/billing` also stops `/ADMIN//billing/2024` and `/admin%2Fbilling`). A prefix is a prefix: `/admin` also stops `/administrator`;
- names are resolved and **every** answer must be allowed. Loopback, private, link-local, carrier-grade NAT, multicast, unspecified and
  reserved addresses are refused unless the platform setting `SECURITY_ALLOW_PRIVATE_TARGETS=true`; IPv4 written inside IPv6 forms
  (mapped, NAT64, 6to4) is judged as IPv4. **Cloud metadata** addresses and names (169.254.169.254, fd00:ec2::254, 100.100.100.200,
  metadata.google.internal, …) are refused always, even with private targets allowed;
- the connection goes to the address that was checked (no second lookup, so an answer that changes in between cannot redirect it);
- every redirect hop is checked again before it is followed; one that leaves the scope is not followed (the answer says which and why).
  Cookies and authorization headers are not carried to another origin by a redirect;
- only GET, HEAD and OPTIONS are sent; a form submit or a script's POST in the browser is aborted;
- a per-assessment **rate limit** (token bucket at the application's requests per second), a **cap on requests** per assessment
  (`SECURITY_MAX_REQUESTS`, default 2000), a cap on bytes read per response (`SECURITY_MAX_RESPONSE_BYTES`, default 5 MB; the rest is not
  read and the result says so) and on the total read per assessment, and a stop switch (cancel, emergency stop) that tears down
  requests on the wire;
- in the browser (`browserRouteGuard`), the guard fetches each allowed request itself and hands the answer to the page; images, media and
  fonts are not requested at all (a passive assessment does not need them and they would use up the request budget).

Registration already refuses targets and scope entries that can never be reached (metadata, and private addresses while they are not
allowed); DNS is checked again at every request.

**Not covered by the guard:** the browser's own WebSocket connections and service-worker fetches are not routed through Playwright's
handlers (a browser used for an assessment must block service workers); after a redirect the guard followed for the browser, the page keeps the
address it asked for. Assessment requests connect directly to the checked address; only with `SECURITY_USE_PROXY=on` do they go
through the company proxy, and then the proxy resolves the name itself (see "The company proxy (OPS)" below).

## Data

All tables come from migration slot 31 (`src/security/store.ts`), every row belongs to one project and goes with it:

| Table | What it keeps |
|---|---|
| `security_applications` | registered applications (target, environment, scope, exclusions, rate, API document, notes) |
| `security_authorizations` | each recorded authorization with the exact statement, approver, document reference, restrictions, who confirmed it and when, the scope fingerprint, revocation |
| `security_assessments` | assessments: state, progress and its plain sentence, coverage, error, who started it, timestamps, the retest link, the cancel request and the assessment loop's lease |
| `security_findings` | findings, unique per application and fingerprint (category + check + normalized location), with the latest (redacted) evidence and the validation state people gave it |
| `security_finding_history` | every validation change (who, when, from, to, comment) and notes such as "still present" |
| `security_finding_sightings` | which assessment saw which finding, with that assessment's evidence |
| `security_audit` | the module's audit trail (kept even when the object it describes is deleted) |
| `security_project_settings` | the project's testing type |

**Audit.** Creating, changing and deleting applications, recording and revoking authorizations, starting, cancelling and stopping
assessments, validation changes, manual findings, report exports and testing-type changes are recorded twice: in the module's own trail
(`GET /api/v1/security/projects/:id/activity`, with who and one plain sentence) and in the platform's Activity list (Settings, People),
shown as "Security assessment" with the same sentence. A change that records no event of its own (a refused request, for example) is
still listed in Activity in the usual "who, what, status" form. Summaries never carry secrets or the approver's email.

**Retention.** Finished assessments older than `SECURITY_RETENTION_DAYS` (default 365) are removed once a day with their
per-assessment evidence; findings stay with their latest evidence and their history. Running assessments are never touched. Each
removal is one line in the project's trail. Project backups (Storage, backup) include the security data, and the scheduled full backup
includes every security table (see "Backups (OPS)" below).

**Roles** (people and access): viewers read everything, editors register and change applications, run assessments and set the testing
type, owners record and revoke authorizations and delete applications. Every object addressed by its id is checked against its project:
an id of another project answers 404 (add `?projectId=` to make the check explicit).

## API (CORE part)

All under `/api/v1/security`, JSON.

| Route | Role | Answer |
|---|---|---|
| `GET /status` | viewer | `{ enabled, limits }` (answers even when the module is off) |
| `GET /projects/:id/applications` | viewer | `{ applications: [{ …application, authorization, activeAssessmentId }], limits }` |
| `POST /projects/:id/applications` | editor | 201 `{ application, authorization, statement }` |
| `GET /applications/:appId` | viewer | `{ application, authorization, currentAuthorization, statement, activeAssessmentId }` |
| `PATCH /applications/:appId` | editor | `{ application, authorization, changed }` |
| `DELETE /applications/:appId` | owner | `{ deleted: true }` |
| `GET /applications/:appId/authorizations` | viewer | `{ authorizations, authorization, statement }` (newest first) |
| `POST /applications/:appId/authorizations` | owner | 201 `{ authorization, state }`; body `{ basis, approverName, approverEmail?, documentReference?, restrictions?, confirm: true }` |
| `DELETE /authorizations/:authId` | owner | `{ authorization, state, stoppedAssessmentId }` (revoke) |
| `GET /projects/:id/activity` | viewer | `{ events }` (`?limit`, `?before`, `?applicationId`) |
| `GET /projects/:id/testing-type` | viewer | `{ testingType: "functional" \| "security" \| "both" }` |
| `PUT /projects/:id/testing-type` | editor | same, body `{ testingType }` |

`authorization` is `{ state: "current" | "stale" | "revoked" | "none", message, authorizationId }`, the message being the plain sentence to show.

## Access per project (ACC)

A client's login can be limited to the client's own projects (Settings, People, **Only these projects**; see
[people-and-access.md](people-and-access.md#per-project-access-projects-a-person-may-see)). For the security module that means:

- The security home lists only the person's projects (it reads `GET /api/projects`, which is narrowed for them).
- Every `/api/v1/security/projects/:id/…` route of another project, and every application, assessment, finding and authorization of
  another project (found by its own id), answers **404 "Application not found"** (or Assessment, Finding, Authorization, Project): the
  same as an unknown id, so nothing reveals that it exists. A `?projectId=` naming the person's own project does not change that.
  This is one central check in front of every route (`src/platform/auth/project-scope.ts`), not a check in each security route;
  the routes' own tenant checks (`?projectId=`, an object of another project) still apply on top.
- Inside an allowed project the role that counts is the lower of the role chosen there and the person's own role: a client who is a
  Viewer in their project reads findings and downloads reports but cannot start assessments or change validation states; recording
  an authorization still needs an Owner there.
- `GET /api/v1/security/status` stays open to every signed-in person (it holds no project's data).
- Tested route by route (`tests/project-access.test.ts`: every registered security route with another project's ids answers 404, and
  every GET route with the person's own ids answers as it does for the access key).

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `SECURITY_ASSESSMENT` | `on` | `off`: every route except `GET /status` answers 404 and the pages are hidden; functional testing is unchanged |
| `SECURITY_ALLOW_PRIVATE_TARGETS` | off | `true` lets assessments reach loopback and private networks (an internal staging server); metadata stays refused |
| `SECURITY_RETENTION_DAYS` | 365 | finished assessments older than this are removed (1-3650) |
| `SECURITY_MAX_REQUESTS` | 2000 | requests one assessment may send (10-100000) |
| `SECURITY_MAX_RESPONSE_BYTES` | 5242880 | bytes read from one response (16 KB - 50 MB) |
| `SECURITY_ASSESSMENT_MINUTES` | 30 | time limit of one assessment (1-600) |
| `SECURITY_USE_PROXY` | off | `on`: assessment requests go through the company proxy (`HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`); see "The company proxy (OPS)" |
| `SECURITY_PROXY_ALLOW_PRIVATE` | off | `true` lets that proxy be on a loopback or private address (most company proxies are); cloud metadata addresses stay refused |

A value that is empty or not a number in range keeps the default.

## Tests (CORE)

`tests/security-core-unit.test.ts` (store and migration, staleness, leases, dedup and history, audit, retention, every refused address
class, DNS answers that change, pinning, redirects, exclusions, methods, rate limit, caps, stop), `tests/security-core-api.test.ts`
(roles, plain validation, staleness through the API, revoke stops a running assessment, tenant isolation, audit and Activity, testing
type, the switch off), `tests/security-browser-guard.test.ts` (the guard in a real Chromium).

## Limits (CORE)

- The guard covers HTTP(S) requests; see "Not covered by the guard" above.
- Roles are platform-wide (as everywhere in the platform); there is no per-project membership, so "tenant isolation" means every object
  is reached through, and checked against, its own project.
- Security data is part of a project backup since round 20 (OPS); a backup that holds it cannot be restored by an older platform version,
  so a backup can leave it out for one (round 21, see "Backups (OPS)").

## Findings (FIND)

Code: `src/security/findings/` (`ingest.ts`, `normalize.ts`, `redact.ts`, `service.ts`, `overview.ts`, `report.ts`), routes in
`src/security/routes/findings.ts`.

### How a finding is made
The assessment hands every problem it saw to `ingest(store, assessment, results, { retestComplete })`. A raw result is one failure
line of the platform's existing read-only checks (`src/engine/security/checks.ts`), for the response it was judged on, so the
judging and the wording are the same as in functional testing. Ingest then:

1. **Normalizes** it: a short title, the category, the check's own severity, a confidence, the location, the description and the
   fix (the check's own words), what it means for the client (impact), steps a person can follow in a browser to see it for
   themselves, and the evidence as received (the header, the cookie's name and flags, the status, the start of a file).
2. **Redacts** everything before it is stored (`redact.ts`): cookie values (names and flags stay), auth headers, bearer/basic
   credentials, JWTs, secret-looking query parameters and `key=value` / JSON pairs whose key names a secret, passwords in
   addresses, e-mail addresses, long hex or base64 strings, and every value of an `.env`-like `KEY=value` line (key names stay).
   The database, the API, reports and CSV all see the cleaned text. Manual findings and comments go through the same filter.
3. **Deduplicates** by fingerprint (category + check + rule + normalized location, per application). Where a setting lives
   decides the location: security headers, version banners, session cookies and the certificate are site-wide (one finding per
   origin, with a "Seen on" note listing up to 20 addresses); exposed files, directory listings and CORS answers are one finding
   per address. Query strings and fragments are never part of a location.
4. **Keeps people's decisions**: a new finding starts as *probable* when the evidence is a direct observation (every built-in
   rule except an untrusted certificate and a CORS echo without credentials), otherwise *needs review*. Nothing is ever set to
   *confirmed* automatically. A finding seen again keeps its state; one marked *fixed* that shows up again is reopened as
   *needs review*, with a history line saying so.

### Validation states and history
`PATCH /api/v1/security/findings/:fid` with `{ validation, comment }` (editor). Every change is kept with who, when, from, to and
the comment, and recorded in the security trail and Activity. Marking a finding *false positive* or *accepted risk* needs a
comment; *accepted risk* also needs an owner (a business decision). The same state again with a comment adds a note.
`aiNote` exists in the contract but stays empty: no AI model is called in this module.

### Manual findings
`POST /api/v1/security/applications/:appId/findings` (editor) with the same fields (title, category, severity, confidence,
location, description, impact, remediation, reproduction, up to 20 evidence items, an optional source note, a starting state).
Stored as `source: "manual"`, redacted the same way, never merged with another finding.

### Retests
A retest (`retestOf`) re-checks the original assessment's open findings (`retestTargets()` gives RUN their addresses). After it,
the original's open findings that were not seen again become *fixed* (the history names the retest); the ones seen again get a
"Still present" note. If the retest could not finish checking (cancelled, partly failed), nothing is marked fixed and the
history says why.

### Overview and risk rules
`GET /api/v1/security/projects/:id/overview`: applications (with their last assessment and state), assessments completed, open
critical/high, awaiting review (open and not yet confirmed by a person), fixed after a retest, remediation remaining, false
positives and accepted risks, the ten most serious open findings and the latest fixes. The risk level follows written rules that
are part of the answer and of every report:

- Only open findings count (confirmed, probable, needs review).
- High risk: any open critical or high finding. Medium: otherwise any open medium. Low: only low or informational ones.
- No open findings: nothing open was found by the checks that ran, which is **not** a statement that the application is secure.
- Not assessed: nothing has finished yet.

There is deliberately no single "secure" score.

## Reports (FIND)

`GET /api/v1/security/assessments/:aid/report` and `GET /api/v1/security/projects/:id/report`, `?format=html|pdf|csv` (viewer).
Built from stored data when asked for; nothing is stored. Every export is recorded in the security trail and Activity.

- **HTML**: one self-contained page, shown in the app (`inline`) or saved (`&download=1`). Served with
  `Content-Security-Policy: default-src 'none'` so it can run and load nothing.
- **PDF**: the same page printed by the platform's own Chromium (as the project report does), scripts off.
- **CSV**: one row per finding, UTF-8 with a byte-order mark and CRLF so Excel opens it; cells that start with `= + - @` are
  prefixed with `'` so a spreadsheet never runs them as formulas.

Sections: executive summary, scope and authorization (who approved, on what basis, when, the document reference and
restrictions; the approver's e-mail is never printed), risk overview with the rules, findings by category, top issues, affected
locations, retest results, every finding (location, description, impact, fix, browser steps, evidence as received with secrets
hidden, validation state and history, first and last seen), coverage (pages, forms and API calls seen, and the plain list of what
was not inspected) and limitations, configuration and timestamps. An assessment report shows the evidence as that assessment saw
it; a project report shows every finding of the project, manual ones included (at most 1000, most serious first; the report says
when there were more).

### What is not covered (FIND)
- Redaction is a pattern filter. It hides the shapes listed above; a secret in an unusual shape in free text a person types (or
  a phone number, a postal address) is not recognised.
- People and roles are platform-wide, not per project: a viewer can read the findings of every project. Tenant isolation means
  every route checks that the objects it is given belong to the project in the address (or `?projectId=`), not that a person
  belongs to a project.
- The PDF's text is checked only indirectly (it is printed from the HTML, which the tests check for secrets).
- Findings are listed up to 1000 per page and per report; the overview counts up to 20 000 findings per project.

## API (FIND part)

All under `/api/v1/security`, JSON unless stated.

| Route | Role | Answer |
|---|---|---|
| `GET /projects/:id/findings` | viewer | `{ findings, total, limit, offset }`; filters `application`, `severity`, `category`, `validation` (one value or a comma list), `from`, `to` (a bare day includes the whole day), `location`, `q`, `limit` (≤ 1000), `offset` |
| `GET /findings/:fid` | viewer | `{ finding, history, application: { id, name, targetUrl }, sightings: [{ assessmentId, createdAt, state }] }` |
| `PATCH /findings/:fid` | editor (owner for *accepted risk*) | `{ finding, history }`; body `{ validation, comment? }` |
| `POST /applications/:appId/findings` | editor | 201 `{ finding }` (manual entry) |
| `GET /projects/:id/overview` | viewer | `{ risk: { level, label, reason, openBySeverity, rules }, counts, applications, needsAttention, fixedRecently }` |
| `GET /assessments/:aid/report` | viewer | `?format=html` (default) \| `pdf` \| `csv` \| `xlsx` (round 20, see "Excel export"), `&download=1` for an HTML file |
| `GET /projects/:id/report` | viewer | same formats, every finding of the project |

For the assessment job: `ingest(store | db, assessment, results, { retestComplete? })`, `fromCheckFailure(check, message, call)` (one
raw result per failure line) and `retestTargets(store | db, originalAssessmentId)` in `src/security/findings/ingest.ts`;
`buildReport(db, { assessmentId } | { projectId })` in `report.ts`.

## Tests (FIND)

`tests/security-findings-unit.test.ts` (fast tier: redaction, normalization of each check's lines, dedup across assessments, people's
states kept, reopening, retest fixed / still present / unfinished, validation history and reasons, manual entry, no secret in the
tables, report and CSV contents, risk rules and overview numbers) and `tests/security-findings-api.test.ts` (under the browser lock for
the PDF: filters, detail, roles, owner-only accepted risk, manual entry, overview, HTML/CSV/PDF, export audit, tenant isolation on every
route, no secret in any answer or in Activity).

## Assessments (RUN)

`src/security/assessment/` runs the passive assessment; `src/security/routes/assessments.ts` starts and stops it.

### What one assessment does

1. **Queued.** Started from `POST /applications/:appId/assessments` only while the application has a current authorization (otherwise
   409 with the authorization's plain sentence) and no other unfinished assessment (409). The start is recorded in the security trail
   and Activity.
2. **Discovering.** A real Chromium opens the target and follows links (at most 30 pages, 3 links deep, 5 pages per address pattern
   such as `/product/{id}`). It only loads pages by address: it never clicks, types or submits a form (the functional crawler opens
   menus and probes navigation buttons; this one does not). The browser never reaches the network itself: every request it makes is
   answered by the platform through the scope guard (`guardedFetch`: address checked and pinned, rate-limited, counted) and handed back
   with `route.fulfill`. Redirects are followed on the platform side with every hop checked, and a 3xx is never handed to the browser,
   because Chromium follows a fulfilled redirect by itself without asking the route handler (the tests caught a fulfilled 302 reaching
   an out-of-scope host before this was changed). Requests a page's own script tries that could change data (POST, PUT, PATCH, DELETE)
   are blocked and listed; WebSockets are closed; service workers and downloads are blocked; pictures, video and fonts are not
   requested. Recorded: pages (address, status, title), forms (field names and types only), API calls the pages made, technology
   banners, out-of-scope and excluded addresses seen, and the API document at `apiSpecUrl` (read, operations counted, none called).
   Links that look like sign-out or delete are never loaded.
3. **Scanning.** The same read-only requests the platform's security checks make (`src/engine/security/specs.ts`): the sensitive-file
   paths (first 4 KB only), the folder-listing paths, an ordinary GET with a made-up Origin to the home page and up to three API
   addresses, and one TLS handshake with the site (https only, to the address the guard checked). Then the existing checks' own judging
   (`src/engine/security/checks.ts`) runs over every response seen, one response at a time, so each problem is tied to where it was
   seen. Transient network errors (connection reset, timeout, 502/503/504) are retried twice.
4. **Validating.** FIND's `ingest` turns the results into findings (redacted, deduplicated, people's validation kept).
5. **Generating report.** Checks that the report can be built; it is built when someone opens or downloads it.
6. **Completed**, or **Partially completed** with the reason (a check that kept failing, a page that could not be loaded, the request
   budget used up, the time limit), or **Failed** with a plain explanation.

Progress (0-100) and a plain sentence of the current step are kept up to date. `coverage` gives pages, forms and API calls seen and a
`notInspected` list of plain sentences: signed-in areas (always: the assessment visits as an anonymous visitor), pages over the limits,
excluded paths, out-of-scope addresses, blocked writes, forms never submitted, the API document's operations not called, pages that
could not be loaded, checks that failed, and what passive checks cannot find. It never presents the work as complete when it was not.

### Retests

`{ retestOf }` (a finished assessment of the same application) requests again only the addresses where the original's open findings
were seen (FIND's `retestTargets`), judges them with the same checks, and lets `ingest` mark the ones not seen again as fixed. A retest
that could not finish every location marks nothing fixed.

### Stopping

- **Cancel** (`POST /assessments/:aid/cancel`) and the **emergency stop** (`POST /projects/:id/stop-all`, every unfinished assessment of
  the project) set a stop request; the loop checks it every second, closes the browser it opened (by its handle), judges what it had
  already received (judging sends nothing) so it is kept, and ends **Cancelled**. A queued assessment no loop holds yet ends at once.
- A revoked authorization, or a change of target, scope, exclusions or request rate that makes it stale, stops a running assessment
  the same way.
- The time limit (`SECURITY_ASSESSMENT_MINUTES`, default 30) ends it **Partially completed** with what was seen kept.

### The loop

Its own loop (not the functional job runner), in the API process when `WORKER_EMBEDDED` is on (the default), following the platform
worker's pattern: it claims one assessment at a time with a 60-second lease, renews it every 5 seconds, gives the work up when another
loop holds it, and an assessment whose loop died is picked up again when its lease runs out. What discovery saw and what the scan judged
are kept in the assessment's work data, so a restarted loop continues from the last finished step; an assessment interrupted three
times fails with that reason. Logs are one JSON line per event with ids, states and counts only (no addresses with queries, headers or
bodies). No temporary files are written (the browser's profile is Playwright's own and goes with the browser).

### API (RUN part)

All under `/api/v1/security`.

| Route | Role | Answer |
|---|---|---|
| `POST /applications/:appId/assessments` `{ retestOf? }` | editor | 201 `{ assessment }`; 409 without a current authorization or while one is unfinished |
| `GET /projects/:id/assessments` `?applicationId=&state=&limit=&before=` | viewer | `{ assessments }`, newest first |
| `GET /assessments/:aid` | viewer | `{ assessment }` |
| `POST /assessments/:aid/cancel` | editor | 202 `{ assessment }`; 409 when it has finished |
| `POST /projects/:id/stop-all` | editor | 202 `{ stopped, assessments }` |

An assessment is the contract's `SecurityAssessment` plus `applicationName` and `cancelRequested`.

### What is not covered (RUN)

- Signed-in areas: without a saved sign-in no account is used, so nothing behind a sign-in is looked at (round 20: see "Signed-in assessments" below).
- Anything that needs an interaction: menus, tabs, buttons and forms are never used, so content they reveal is not seen.
- WebSocket traffic, and what blocked writes would have done.
- The judging is the existing checks' (headers, cookies, CORS answer to an ordinary request, exposed files by content signature,
  version banners and directory listings, the TLS certificate); nothing else is judged.
- After a redirect the platform followed for the browser, the page keeps the address it asked for (a `<base>` is added to HTML so
  its links still resolve).

### Tests (RUN)

`tests/security-run-unit.test.ts` (fast, no browser: judging with the checks' logic, coverage sentences, retries, failure words, role
rules) and `tests/security-assessment-run.test.ts` (under the browser lock: a real Chromium against `tests/fixtures/security-fixture-app.ts`,
our own local app with deliberate misconfigurations: the problems are found, the out-of-scope redirect and the private-address link are
never contacted, excluded paths never requested, nothing but GET/HEAD/OPTIONS reaches the app, no secret stored; progress, coverage,
409s, tenant isolation, retest marking fixed, cancel, emergency stop, time limit, partial completion, restart safety, revoked
authorization).

## The screens (UI)

Code: `web/src/features/security/` (`security.ts` words, routes and data helpers; `SecurityChrome.tsx` layout, tabs, badges, emergency
stop; `TestingType.tsx`; `Overview.tsx`; `Applications.tsx`; `Assessments.tsx`; `Findings.tsx`; `Reports.tsx`; `SecurityPage.tsx` routes,
the top-level place and the summary card). Small hook-ins: `Shell.tsx` (sidebar), `main.tsx` (routes), `ProjectOverview.tsx` (tab and
summary card), `SetupPage.tsx` (testing type above the sections), `NewProject.tsx` and `onboarding/Welcome.tsx` (testing type when a
project is made).

- **The switch.** The shell reads `GET /status` once per page load. Off (or a server without the module): the sidebar is exactly as
  before ("Workspace", Projects), no testing-type choice anywhere, and `#/security` or `#/projects/:id/security` say it is turned off
  without asking anything else. On: the sidebar names the two capabilities apart ("Functional testing" with Projects; "Security" with
  Security assessment, `#/security`, which lists the projects that include it).
- **Testing type** (`GET|PUT /projects/:id/testing-type`). New project asks Functional testing / Security assessment / Both above the ways
  to start. Security assessment needs only a project name, stores the type and opens Register application. Both keeps every way to
  start and stores the type right after the project is made. Setup shows a "Testing type" row above its sections. A project that includes
  security gets a "Security assessment" tab after Setup and one small summary card on its Overview (open critical or high, awaiting review)
  linking to the section; a security-only project's Overview opens its security overview. A functional project's security section offers
  "Turn on security assessment" (sets Both).
- **Routes** (`#/projects/:id/security/...`): overview; `applications`, `applications/new`, `applications/:appId` (`?authorize=1` opens
  the authorization form); `new` (`?app=`, `?retest=<assessment>`); `assessments`, `assessments/:aid`; `findings` (filters in the address:
  `application, severity, category, validation, from, to, location, q`, plus `open=1` from the overview), `findings/new`, `findings/:fid`;
  `reports` (`?assessment=`).
- **Authorization.** The statement shown is the server's (it names the organization, target and scope); the request sends
  `confirm: true` only after the box is ticked. Out of date after a change of target, scope, exclusions or rate: the page says so and opens
  the form again. Recording and withdrawing are offered to owners only.
- **Assessments.** New assessment lists what the passive assessment does and does not do, the request limits (per second, in all, minutes,
  from `/status`) and exclusions; Start is disabled without a current authorization, with a link to it. The progress page polls every 2 s
  while running: state, percentage, the server's progress sentence, the four steps; Stop assessment asks first. Finished: the outcome in
  plain words, coverage (pages, forms, API calls, the not-inspected list), Report and Retest.
- **Findings.** The list sorts most serious first. A state change always needs a reason (the server needs one for Not a problem and Risk
  accepted); the same state with a reason adds a note; Risk accepted is offered to owners only. An AI note, when present, is shown apart
  and labelled as not evidence. Manual entry asks for title, location, what was found, why it matters and how to fix it (all required by
  the server), plus optional steps and an observation kept as evidence.
- **Reports.** The HTML report is shown in an `iframe` with `sandbox=""` (no script runs in it); PDF and CSV are fetched with the same
  credentials and saved under the server's file name.
- **Roles.** The page reads the person's role and does not offer what the server would refuse (viewer: no add, start, stop, state change;
  editor: no authorization, delete or risk acceptance). The server still checks every action; a refusal is shown in plain words.

### Tests (UI)

- `tests/security-ui.test.ts`: real browser against a fake security API (`tests/fixtures/security-fake-api.ts`, the real routes' answer
  shapes): the switch off and on, the testing type (new project security-only and both, Setup, tab, summary card, security-only redirect,
  turning it on in place, a server without the route), register and authorization (checks, statement, out of date, withdraw), assessments
  (what it does, limits, refused without authorization, progress, stop, emergency stop, coverage, retest), findings (filters, detail, state
  change with history, manual entry), overview and risk rules, reports (sandboxed HTML, CSV and PDF downloads), viewer and editor limits,
  keyboard, 375 px without sideways scroll, 44 px targets, axe in light and dark on every page.
- `tests/security-ui-real.test.ts`: the same screens against the real platform (CORE, RUN, FIND, the real assessment loop) and the
  fixture application: project, application, authorization, a real passive assessment, findings, a state change, overview and report.

### What is not covered (UI)

- The role shown is the person's platform role; a project-level role that differs is enforced by the server (the page then shows the
  refusal) rather than predicted by the page.
- (Round 20: the Activity list of security events now has its own page; see "Round 20 screens".)
- The report frame is excluded from the automated accessibility check (nothing can run inside it); the report's own HTML is FIND's.

## Round 20 screens and the Excel export (UI2)

Code: `web/src/features/security/` (`Activity.tsx`, `Notifications.tsx`, `ApplicationExtras.tsx`, additions to `Applications.tsx`,
`Reports.tsx`, `SecurityChrome.tsx`, `SecurityPage.tsx`, `security.ts`); the workbook writer `src/security/findings/xlsx.ts` and one
anchored addition to FIND's `routes/findings.ts`.

- **Activity** (`#/projects/:id/security/activity`, a tab of the section): the project's security trail (CORE's
  `GET /projects/:id/activity`), newest first: the sentence, who, when, the kind of change, and a link to the application, assessment,
  finding or report when it still exists (never for a deleted one). Filters in the address: **Application** (`application`, sent to the
  server as `applicationId`), **What** (`kind`: applications with their API documents and saved sign-ins, authorizations, assessments,
  findings, reports, settings and upkeep) and **Who** (`person`). What and who narrow the events loaded so far; **Show older events**
  loads the next 100 (`before`). The same events stay in the platform's Activity list.
- **Notifications** (`#/projects/:id/security/notifications`, a tab): OPS's setting (`GET|PUT /projects/:id/notifications`). Three
  switches: new critical or high findings (on unless changed), an assessment fails (on unless changed; only the Failed state, not a cancelled or partly completed one), every assessment that
  ends (off unless changed); where messages go: every alert channel of the project, or only the ones ticked (turned-off channels
  cannot be ticked). No channel yet: the page says messages go nowhere and links to Setup, Alerts. A warning when no channel would
  receive anything. The last 20 messages with their channel, reason and whether the channel took them. Editors and owners change it;
  viewers read it.
- **Application form** (SIGN's fields, sent only when set or changed, so a plain registration sends exactly the round-18 body):
  - **Signed-in assessment (optional)**: no sign-in (an anonymous visitor), the project's own sign-in (`main`) or a test account, each
    with the server's judgement from `GET /projects/:id/sign-ins` (ready, not checked yet, expired, none saved, saved for another site,
    cannot be read) and, for the chosen one, the server's own sentence; an unusable one links to Test accounts.
  - **Sensitive workflows** (under Advanced): name, the paths never requested (one per line, each starting with `/`), a note; rows can
    be added (at most 30) and removed; an empty row is ignored. Checked before sending.
  - The detail page lists *Signed in as* and *Sensitive workflows* in Scope and limits. The out-of-date wording names the saved sign-in
    and the sensitive workflows too.
- **Application page panels**: **Signed-in assessment** (the chosen sign-in's state in the server's words; editors can upload a saved
  browser state file, Playwright's `--save-storage` JSON, at most 1 MB, with an optional signed-in page: `PUT
  /applications/:appId/saved-sign-in`; nothing of the file is shown back) and **API document** (`GET|PUT|DELETE
  /applications/:appId/api-document`: file, format, size, title and version, operations listed and how many may be requested, who
  uploaded it and when, and per operation what an assessment would do with it; upload or replace a JSON or YAML file up to 2 MB, checked
  in the page before it is sent; removing asks first).
- **Reports**: **Download as Excel** next to PDF and CSV. The Reports page now also offers the project report when the project has
  findings but no assessment yet (findings entered by hand).

### Excel export

`GET /assessments/:aid/report?format=xlsx` and `GET /projects/:id/report?format=xlsx` (viewer) answer
`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` as an attachment named like the CSV (`security-report-<name>-<date>.xlsx`),
built from the same report data, and are recorded in the trail and Activity like every export ("… as XLSX (n findings)").

- **How it is made:** an .xlsx file is a zip of a few XML parts; `xlsx.ts` writes them (content types, relationships, workbook, two
  worksheets, styles, core properties) and zips them with fflate, the zip code the runner kit already uses. No new dependency.
- **Summary sheet:** title, project, what the report is on, when it was made, the risk level with its reason and its rules, open,
  critical or high, awaiting review and fixed counts, counts by severity and category, each application with its target, environment,
  request limit, authorization (approver, basis, who recorded it and when, reference and restrictions, redacted again; never the
  approver's email), its assessment and state, scope and exclusions, retest results, coverage with what was not inspected, and the
  limitations.
- **Findings sheet:** the CSV's 16 columns in the CSV's order with the CSV's values, one row per finding; bold header row frozen while
  scrolling, filter buttons, wrapped text, column widths.
- **Safety:** every cell is an inline string or a plain number, never a formula, so a value that starts with `=`, `+`, `-` or `@` is shown
  exactly as typed and cannot run (the CSV prefixes such values with an apostrophe instead). Text is XML-escaped; characters XML cannot
  carry are removed; a cell over Excel's 32 767-character limit is cut with a note that the full text is in the HTML or PDF report.

### Tests (UI2)

- `tests/security-xlsx.test.ts` (no browser; the real server through `server.inject`, run under the lock): the writer (column and sheet
  names, the package parts, formula-looking values kept as text, escaping, removed control characters, the cut cell), the project and
  assessment reports as workbooks read back from the zip (sheets, the Findings rows equal the CSV's cell for cell, a hand-entered
  finding whose title, location, description and impact look like formulas, the Summary's contents, no secret or approver email, the
  export in the trail, another project's assessment 404, an unknown format 400).
- `tests/security-ui2.test.ts` (browser, fake API, port 7190): activity (order, links, filters in the address and the request, older
  events, empty), notifications (no channel, change and save with the exact body, recent messages, viewer), the form (sign-in choice and
  the server's words, workflows with their checks, the body sent, the detail page, a change making the authorization out of date and
  sending only the changed field), the panels (saved sign-in upload never showing the cookie, API document upload with a bad file, the
  summary and operations, replace, remove with confirmation, viewer), the Excel download, keyboard, 375 px, 44 px targets, axe light
  and dark.
- `tests/security-ui2-real.test.ts` (browser, the real platform, port 7191): register with a sign-in and a sensitive workflow, the server's
  statement naming both, the stored fields, the authorization, a real API document read by SIGN's parser, a saved sign-in file, the
  notification setting stored, the Excel report downloaded from the page and read back, the activity page listing every step.

### What is not covered (UI2)

- Whether Microsoft Excel opens the workbook without a repair prompt could not be checked here (no Excel on this machine). The parts
  follow ECMA-376 as Excel writes them; a spreadsheet library (openpyxl) read a generated file without warnings during development
  (by hand, not in the tests). LibreOffice, Numbers and Google Sheets were not tried.
- The Who filter lists the people in the events loaded so far; the server has no person or kind filter, so a long trail may need
  **Show older events** first. There is no date filter.
- The page's role is still the person's platform role; a lower role inside a project (ACC) is enforced by the server, and the page shows
  its refusal.

## Backups, messages and the company proxy (OPS)

Code: `src/security/backup.ts` (the security part of a project backup), `src/security/notify.ts` and `src/security/routes/notifications.ts`
(messages when an assessment ends), `src/security/proxy.ts` (assessments through the company proxy). Anchored additions: `platform/backup.ts`
and `engine/retention/backup-model.ts` (the `security.json` document), `scope.ts` (the `proxy` option and the `proxy` refusal),
`assessment/guard.ts`, `runner.ts`, `scan.ts`, `types.ts` (the proxy check before the first request and the TLS handshake through the
tunnel), `routes/assessments.ts` (the message when an assessment ends), `settings.ts` and `config.ts` (two settings), `store.ts` (two audit
codes), `auth/roles.ts` (two routes).

### Backups (OPS)

- **The scheduled full backup** (`BACKUP_DIR`, production-hosting.md) copies the whole database, so it holds every security table:
  applications, authorizations, assessments, findings, history, sightings, the trail, the testing type, SIGN's application extras and API
  documents, and the message setting. Restoring it brings everything back exactly (current authorizations included). Tested by making a
  backup and reading the copy.
- **A project backup** (Storage and backup, `GET /api/projects/:id/backup`, owner) of a project with security data holds one more document,
  `security.json`: the testing type, the message setting, applications (scope, exclusions, rate, notes, sensitive workflows, the *name* of
  the saved sign-in, the uploaded API document), every authorization record (statement, basis, approver, document reference,
  restrictions, who confirmed it and when, revocation), assessments (state, progress words, coverage, error, timestamps, the retest link),
  findings with their latest evidence, their validation history and the evidence each assessment saw, and the security trail. A project
  without security data gets exactly the backup it got before (no `security.json`). The manifest counts `securityApplications`,
  `securityAuthorizations`, `securityAssessments`, `securityFindings` and `securityAuditLines`.
- **Never in it**: secrets. Evidence was redacted when it was stored (FIND) and stays so; the saved signed-in state (cookies, tokens) is not
  copied: the backup names it in "secrets needed" (*Saved sign-in "main" for the security assessment of "Shop"*: sign in again in Setup);
  alert channels (their addresses are secrets) are not copied, so chosen channels are dropped. The approver's e-mail is kept, as it is part
  of the authorization record (only an owner downloads a backup).
- **Restore** (`POST /api/projects/restore`) makes a new project as always, with new ids everywhere. Nothing is authorized and nothing
  runs: every authorization comes back as history and withdrawn (*Restored from a backup: record a new authorization before the next
  assessment*), so starting an assessment answers 409 until a person records a new one; an assessment that had not finished comes back
  **Cancelled** (*Restored from a backup before it had finished; it was not run again*). Evidence, finding texts, comments and trail lines
  are redacted again (a backup is a file someone may have edited). The trail gets *Restored the security assessment data from a project
  backup …*, by the person restoring. Restore notes say what to do next. The restore message names what came back (round 21): a project
  with security data and no tests says *"Restored the security assessment data into a new project, “Client A copy”: 1 application, 1
  authorization (withdrawn: record a new one before the next assessment), 3 assessments and 3 findings. Nothing has been run."* (not
  "Restored 0 tests"); a project with tests keeps its sentence and adds *"Security assessment data: …"*.
- **Without the security data (round 21)**, for restoring on a platform version from before round 20:
  `GET /api/projects/:id/backup?withoutSecurity=true` (owner, like every backup; on the page *Leave out the security assessment data*, shown only when the project has
  some). The file is exactly the earlier format: no `security.json`, no security counts in the manifest, no security sign-in among the
  secrets to enter again; everything else is byte for byte what the full backup holds. Each such download is recorded: in the project's
  security trail and Activity (*Downloaded a project backup without the security assessment data, for an older platform: 1 application, 1
  authorization, 3 assessments and 3 findings were left out of it.*), or, for a project without security data, in Activity only (a trail
  line would itself be security data and would put `security.json` into its next backups). `GET /api/projects/:id/storage` answers
  `securityData` (true when a backup would carry some).
- **Checked before anything is created**: the document's shape (zod, every text capped), every reference inside it (an assessment of an
  unknown application, a finding seen by an unknown assessment …), two findings with the same fingerprint, too many findings for one
  application. A damaged document answers 400 *The backup is damaged: security.json: …* and nothing is created; a restore that fails later
  removes the project and the security trail lines it wrote.
- **Caps**: 200 applications, 5000 authorizations, 5000 assessments (newest), 20 000 findings (most recently seen), 500 history lines and
  500 sightings per finding, 20 000 trail lines (newest), API documents up to 12 MB together. Over 30 MB the per-assessment evidence and
  then the API documents are left out (the restore notes say so); a project still too large answers 413 and points to the full backup.

### Messages when an assessment ends (OPS)

Through the project's existing alert channels (Setup, Alerts: webhook, Slack, Microsoft Teams, email), when the project's setting says so:

| Switch | Default | Sends when |
|---|---|---|
| `newCriticalHigh` | on | the assessment found critical or high findings that were not known before (new in this assessment), or (round 21) saw again critical or high findings marked fixed: they "came back" (reason `reopened-critical-high`) |
| `failed` | on | the assessment **failed** (cancelled or finished with gaps is not a failure) |
| `everyFinish` | off | every end: completed, completed with gaps, failed, cancelled |

At most one message per assessment and channel; when several reasons apply they are combined (`events`). `channelIds` `null` means every
enabled channel of the project; a list means only those (turned-off channels never receive; a deleted one is skipped). Every delivery is
written to the project's alert log (event `security:<reasons>`), like run alerts.

**What a message carries:** the project and application names, the state in plain words, the number of new critical/high findings, the
findings seen in the assessment by severity, and the link `<PUBLIC_URL>/#/projects/<project>/security/assessments/<assessment>`. **Never:**
evidence, finding titles or locations, the target address, the approver, the assessment's error text (it can name addresses), any secret.
The webhook body:

```json
{ "event": "security_assessment", "events": ["new-critical-high"], "test": false, "sentAt": "…", "project": { "id": "…", "name": "Client A" },
  "link": "https://platform.example/#/projects/…/security/assessments/…",
  "summary": "The passive assessment of “Shop” in Client A finished with gaps. 1 new critical or high finding (0 critical, 1 high). Findings seen: 1 high, 2 medium.",
  "assessment": { "id": "…", "applicationId": "…", "applicationName": "Shop", "state": "PARTIALLY_COMPLETED", "retest": false, "finishedAt": "…",
                  "findingsSeen": { "critical": 0, "high": 1, "medium": 2, "low": 0, "info": 0 }, "newFindings": { "critical": 0, "high": 1 },
                  "reopenedFindings": { "critical": 0, "high": 0 } } }
```

**Came back (round 21).** A finding a person marked *fixed* that an assessment sees again is reopened by FIND's ingest (*needs review*,
with a history line naming the assessment). When it is critical or high, it counts for the `newCriticalHigh` switch with its own reason
`reopened-critical-high` (in `events`, in the alert log's event `security:…`, and in the Notifications page's recent list as "critical or
high findings came back"). The message says *"1 critical or high finding came back: marked fixed, then seen again (0 critical, 1 high)."*,
its title is *Critical or high findings came back: Shop* when nothing new was found, Slack, Teams and email list "Came back (critical or
high)" among the facts, and the webhook carries `reopenedFindings`. A finding seen again while still open is not "came back".

Slack gets the same sentence with the counts and an "Open assessment" button, Teams an Adaptive Card, email a message whose subject is
the title (*New critical or high findings: Shop (finished with gaps)*). The message is sent when the assessment loop records the end
(`loopDeps().onFinished`, in the API process or the standalone worker); it never waits for delivery and never changes the assessment.

**Settings API** (the switch UI2 built):

| Route | Role | Answer |
|---|---|---|
| `GET /api/v1/security/projects/:id/notifications` | viewer | `{ settings: { newCriticalHigh, failed, everyFinish, channelIds }, saved, defaults, channels: [{ id, name, kind, enabled, selected }], recent: [{ at, channelName, channelKind, status, reasons, error, summary }] }` |
| `PUT /api/v1/security/projects/:id/notifications` | editor | the same; body any of `{ newCriticalHigh, failed, everyFinish: boolean, channelIds: string[] \| null }` (strict; a channel of another project is a 400) |

`channels` never carries a channel's address or sign-in; `recent` is the last 20 assessment messages from the alert log. A change is a line
in the security trail and Activity (*Changed the assessment messages of "Client A": new critical or high findings on, failures on, every
finish off; sent to every alert channel of the project.*). Storage: the key/value table `ai_settings` (as `llm-health.ts` does), key
`security-notify:<projectId>`; **no migration**.

### The company proxy (OPS)

`SECURITY_USE_PROXY=on` (default off) sends assessment requests through the proxy the platform's other outbound calls use (`HTTPS_PROXY`,
`HTTP_PROXY`, `NO_PROXY`, company-networks.md), chosen the same way: an https address uses `HTTPS_PROXY` (else `HTTP_PROXY`), an http one
`HTTP_PROXY`; names in `NO_PROXY` and this computer (`localhost`, `127.0.0.1`, `::1`) are reached directly.

- **The guard still checks first, on the platform.** Every address passes the scope rules and the DNS check (every answer, private and
  metadata addresses) before anything is sent; a refused one never reaches the proxy. The name must therefore also resolve on the platform
  server.
- **Then the proxy resolves the name itself.** The guard's pinning ("connect to the address that was checked") cannot be enforced through a
  proxy: if the proxy's DNS answers differently, the proxy decides where the request goes, so the protection against private and metadata
  addresses then also depends on the proxy. That is why it is off by default; use it when the client's application is only reachable
  through the company proxy.
- **https** goes through a CONNECT tunnel: the TLS session is end to end with the site, so the certificate judged is the site's own (the
  scan's one TLS handshake goes through the tunnel too). **http** is sent to the proxy in absolute form, as Node's own proxy support does.
- **Refused**: switched on without a proxy, or with one that cannot be read (SOCKS, PAC): the assessment fails at start with the reason,
  before any request. A proxy on a cloud metadata address: always. A proxy on a loopback, private, link-local or carrier-grade NAT address:
  unless `SECURITY_PROXY_ALLOW_PRIVATE=true`. An address that is the proxy itself (its name on any port, or its address on its port):
  refused like an out-of-scope address (*… is the company proxy itself …; an assessment never assesses the proxy*).
- The proxy's sign-in (`http://user:password@proxy:8080`) is sent as `Proxy-Authorization` and never shown: messages say
  `http://user:***@proxy:8080`. A 407 (missing or wrong sign-in), a 403 (the proxy refuses the address) and an unreachable proxy are
  plain sentences in the assessment's coverage or failure.

### Tests (OPS)

- `tests/security-ops-proxy.test.ts` (12, under the lock: local CONNECT proxies with and without a password and one that refuses an
  address, a local app and an https front with the test-only company certificate): absolute form for http, CONNECT for https with the
  site's certificate, the platform-side DNS check first (nothing reaches the proxy), NO_PROXY and this computer direct, the proxy itself
  refused, 407/403/unreachable sentences without the password, private and metadata proxies, switched on without a proxy, the TLS
  handshake through the tunnel, an assessment failing at start before any request.
- `tests/security-ops-proxy-run.test.ts` (1, browser): a real passive assessment of the security fixture app reachable only by a name
  behind the proxy: every request the app received came through the proxy, nothing out of scope reached it, the problems are found.
- `tests/security-ops-notify.test.ts` (8, under the lock: a local webhook receiver and the fake mail server): defaults, combined reasons,
  the four channel kinds' bodies, nothing of the evidence, locations, target address or error text in any of them, chosen and turned-off
  channels, the loop's end hook, the alert log and `recent`, roles, strict validation, tenant check, the audit line, the switch off.
- Round 21 additions: `tests/security-ops-notify.test.ts` (+1: a finding marked fixed and seen again, through FIND's real ingest, is sent
  as came back on every channel kind, not for one seen again while open, and not when the switch is off), `tests/security-ops-backup.test.ts`
  (+2: the restore message with and without tests; the backup without security data: only the earlier documents, unchanged otherwise, no
  security counts or sign-in need, the trail and Activity lines, restored here without security data, a functional project's Activity-only
  line, owner only), `tests/retention-ui.test.ts` (+1: the box shown only with security data, the downloaded zip without `security.json`).
- `tests/security-ops-backup.test.ts` (5, under the lock): the scheduled full backup read back, the project backup's `security.json` (every
  part, redaction intact, no token, no channel address, the sign-in named as needed), a functional project unchanged, restore (withdrawn
  authorizations, cancelled unfinished assessment, history, sightings, trail, the message setting, new ids, 409 on start), an edited file
  redacted again, a damaged one refused with nothing created.

### What is not covered (OPS)

- **No real company proxy, NTLM/Kerberos proxy or PAC file was used**: only the local CONNECT proxy fixture (plain Node). Proxies that
  accept only the Windows sign-in, SOCKS proxies and automatic proxy scripts are not supported (as for the platform's other calls).
- Through a proxy, the pinning depends on the proxy's DNS (above). For a plain-http address the proxy relays the answer: a proxy's own
  refusal page is recognised only by a 407 or an RFC 9209 `Proxy-Status` error header; another refusal page would be judged as the site's
  answer (https addresses are not affected: the tunnel either opens or the request fails).
- Messages: a channel that does not answer is retried like run alerts; there is no "send a test message" for the security message (the
  channel's own test exists under Setup, Alerts). Teams, Slack and email were checked against local fakes only.
- A project backup with security data cannot be restored by a platform version from before round 20 (it answers *"The file is not a
  backup this platform made: it holds “security.json”, which a backup never contains."*); that cannot be changed there, so make the backup
  **without the security data** for it (below). The saved signed-in state and alert channels must be entered again after a restore.
- The setting lives in `ai_settings`, which a project deletion does not clean up (a few bytes per deleted project; never shown).

## Signed-in assessments, uploaded API documents, sensitive workflows (SIGN)

Code: `src/security/signin.ts` (which saved sign-in is used, cookies, sign-out rules, scrubbing), `src/security/api-document.ts` (reading
the document, which operations may be requested), `src/security/assessment/api-operations.ts` (requesting them during an assessment),
`src/security/extras.ts` (migration slot 33), `src/security/routes/signin.ts`; small additions to CORE's `contract.ts`, `authorization.ts`,
`store.ts`, `routes/core.ts`, RUN's `assessment/guard.ts`, `discover.ts`, `runner.ts`, `types.ts`, `routes/assessments.ts` and FIND's `report.ts`.

### Signed-in assessment

- An application can name one saved sign-in: `"main"` (the project's own) or a test account's name (`signInAccount`). The assessment
  never types a password, never submits a sign-in form and never reads a test account's password: it only loads the **saved signed-in
  browser state** (hard sign-ins, `saved_sessions`, encrypted) into its browser context, decrypted for the assessment only and limited to
  the cookies and local storage of hosts in the authorized scope.
- The browser's own cookies (and credentials a page's script adds) go with its requests through the scope guard; the plain read-only
  requests (sensitive files, folder listings, the CORS look, the API document's operations) get the saved cookies the way a browser
  would: host-only cookies to their host, domain cookies to the domain and its subdomains, path and `Secure` respected, expired ones
  dropped. A redirect to another origin carries no cookie (the guard's rule).
- The page the person was on when saving the sign-in is opened right after the target; if it answers 401/403, asks for a password or
  moves to a sign-in address, the coverage says *"Signed-in pages may not have been inspected: with the saved sign-in for …, the
  signed-in page /account answered HTTP 401. Sign in again in Setup."*
- **Still signed in? (round 21).** While the assessment runs, the saved sign-in is checked again every 5 pages and once more right before
  the read-only checks: the signed-in page is opened again and judged the same way (401/403, a password field, a move to a sign-in
  address, also one outside the scope such as a single sign-on page), and the browser must still hold one of the saved cookies (an
  application that ends a session usually removes its cookie; this also catches a signed-in page that looks the same signed out). Before
  the read-only checks it is one plain GET of the signed-in page with the saved cookies, through the guard. When it has stopped working,
  nothing more is sent signed in (the browser forgets its cookies and session headers, the read-only checks carry no saved cookie; sign-out
  addresses stay refused), what was seen is kept, and the coverage says from which point, e.g. *"The saved sign-in for the project's own
  account stopped working after 14 pages (the signed-in page /account answered HTTP 401; it last worked after 10 pages); signed-in pages
  after that were not inspected. Save the sign-in again in Setup. It was not signed in again: no password was typed and no form was
  submitted."* Found only before the read-only checks: *"… no longer worked when the read-only checks started (…); the read-only checks
  were made signed out. Pages after the first 2 pages may have been looked at signed out. …"*. It never signs in again. A check that
  cannot be made (the page refused or not loaded) decides nothing. A signed-in page whose first look already failed is not checked again
  (that sentence above stands).
- **Sign-out is never followed:** links whose address (`logout`, `log-out`, `sign_out`, `signoff`, `end-session` …) or words ("Log out",
  "Sign out", "Log off") say so are not loaded and are listed (*"Sign-out links were not followed, so the session was not ended: …"*);
  while signed in, the guard also refuses any sign-out-looking address, from a page's script or as a redirect hop.
- Missing, expired (its cookies ran out, or the last "Still signed in?" check found it signed out), saved for a site outside the scope,
  or unreadable: the assessment carries on **signed out** and the coverage says why, e.g. *"Signed-in pages were not inspected: the saved
  sign-in for the project's own account has expired. Sign in again in Setup."*
- **No value is kept:** every cookie and local-storage value of the saved sign-in is replaced by `[hidden]` in the assessment's work
  data and in the results before FIND's ingest (which redacts on top); request headers the browser sent are never stored. The tests read
  every table of the database, every answer, the HTML/CSV reports and Activity for the values.
- A security-only project has no functional "application address", so a sign-in can be uploaded for the application itself
  (`PUT /applications/:appId/saved-sign-in`, the storage-state file Playwright's `--save-storage` writes). It is stored as the project's
  saved sign-in for that account (the same row the Test accounts page shows), for the application's target.

### Uploaded API document

- OpenAPI 3 or Swagger 2, JSON or YAML, at most 2 MB, kept with the application (`security_api_documents`); its text is never returned.
- Read only. Every operation is listed; only **GET operations without required parameters** (no path parameter, no required query,
  header or cookie parameter, no required body; a `$ref` parameter that cannot be read counts as required) are requested, at most 50 per
  assessment, one plain GET each with no value from the document, through the scope guard (in scope, not excluded, not a sensitive
  workflow, not a sign-out address, within the request budget). The base address is `servers[0].url` (variables filled with their
  defaults, a relative one resolved against the target) or Swagger's `schemes/host/basePath`, else the target's origin.
- Coverage: *"The API document “api.yaml” lists 11 operations; 3 GET operations were requested read-only, the rest were not called (3
  could change data or are not GET; 2 need values the assessment does not invent; 1 look like sign-out addresses; 2 are excluded,
  sensitive, outside the scope or could not be requested, for example /account/payments/history)."* The answers are judged like the API
  answers the pages fetched (cookies, information disclosure, and the CORS look for up to three).
- The document address (`apiSpecUrl`) works as before: read and counted, nothing called.

### Sensitive workflows

A list on the application (`sensitiveWorkflows: [{ name, pathPrefixes, note }]`, at most 30, 20 paths each). Their paths are excluded
exactly like `excludedPaths` (the guard refuses them everywhere: pages, scripts, redirects, plain requests, the API document), they are
named in the authorization statement (*"Sensitive workflows, never requested: Payments (/account/payments)."*), in every coverage list
(*"Sensitive workflow “Payments” (/account/payments) was never requested: Real card payments."*) and in the report's scope section.

### The authorization

The saved sign-in used and the sensitive workflows (names and paths; not the note) are part of the scope fingerprint, **only when set**,
so an application without them keeps its fingerprint and its authorization. Changing either makes the authorization out of date (the
sentence now reads *"The target, scope, exclusions, request limit, saved sign-in or sensitive workflows changed …"*) and is refused (409)
while an assessment runs. The statement says the assessment visits signed in, as whom, and that no password is typed. Changing the API
document does not need a new authorization (it only adds GET requests within the authorized scope).

### API (SIGN part)

Application routes (CORE's, additive): `POST /projects/:id/applications` and `PATCH /applications/:appId` take `signInAccount`
(`"main"`, a test account's name, or `null`; an unknown one is 400) and `sensitiveWorkflows`. Every application answer carries
`signInAccount`, `sensitiveWorkflows` and `apiDocument` (`{ fileName, format, sizeBytes, sha256, title, version, operations, requestable,
uploadedAt, uploadedBy }` or `null`). `GET /applications/:appId` also answers `signIn`: the status below, or `null`.

| Route | Role | Answer |
|---|---|---|
| `GET /projects/:id/sign-ins` (`?applicationId=` judges for it) | viewer | `{ signIns: [{ account, label, state, message, savedAt, expiresAt, site }] }`, `state`: `ready`, `not-checked`, `expired`, `missing`, `other-site`, `unreadable` |
| `PUT /applications/:appId/saved-sign-in` | editor | body `{ account, storageState, checkUrl? }` (checkUrl in scope, not a sign-out address); `{ signIn }` |
| `GET /applications/:appId/api-document` | viewer | `{ document, operations: [{ method, path, url, request, reason, kind }], baseUrl }` (`document: null` when none) |
| `PUT /applications/:appId/api-document` | editor | body `{ fileName, content }`; same answer; 400 with a plain reason for a document that is not one or is too large |
| `DELETE /applications/:appId/api-document` | editor | `{ deleted }` |

`kind` is `request`, `not-get`, `needs-values`, `sign-out`, `bad-path` or `refused` (outside the scope, excluded or sensitive, judged
without DNS; DNS is checked again during the assessment). Uploads, removals and saved sign-ins are recorded in the trail and Activity
(`api-document.uploaded`, `api-document.removed`, `sign-in.saved`), never with a value.

### Tests (SIGN)

`tests/security-signin-unit.test.ts` (fast tier, one local HTTP server on 7152/7153: sign-out rules and the guard's refusal including a
redirect hop, cookies by host/path/Secure/expiry, scope limiting, cookies on plain requests and none after a redirect to another origin,
scrubbing, the signed-in page judgement, slot-33 tables and cascade, missing/ready/other-site/expired, fingerprint and statement, the
guard excluding sensitive paths, reading and planning API documents, base addresses, coverage sentences, redaction of a signed-in cookie
in findings, the report lines) and `tests/security-signin.test.ts` (under the browser lock: a real Chromium against the fixture app's
signed-in area on 7154/7155: the fields and their refusals, uploading a saved sign-in and an API document, staleness, a signed-in
assessment that reaches the signed-in pages with the cookie and never requests a sign-out address, the sensitive workflow or anything but
GET/HEAD/OPTIONS, only the document's GET operations without required parameters, coverage, no value in any table, answer, report or
export, an expired sign-in, and a sign-in the app rejects).

Round 21: `tests/security-signin-expiry.test.ts` (4, under the browser lock, the fixture app on 7210/7211 ending its session on the server
mid-run and removing its cookie): found by opening the signed-in page again, found by the browser's cookies without a signed-in page,
found only before the read-only checks, and a session that keeps working; each time no request carries the session after the point it
ended (the read-only checks included), only GET/HEAD/OPTIONS, never a sign-in or sign-out address, and the coverage sentence. And
`tests/security-fx-unit.test.ts` (6, fast tier, 7212/7213): the sentences, the coverage list, the plain check before the read-only checks
against the fixture, the guard sending no saved cookie afterwards, the restore words.

### What is not covered (SIGN)

- Signed in means "with a saved browser state": nothing signs in by itself, and a session that runs out during the assessment is not
  renewed. Since round 21 it is noticed (every 5 pages and before the read-only checks) and the rest is done signed out, but pages between
  the last good check and the one that noticed it may have been seen signed out (the coverage names that window). When the signed-in page
  is the application's own address (the default when none was given) and looks the same signed out, an ending session is noticed only
  when the application removes its cookie; give a page only a signed-in person sees, such as /account.
- A test account's API token is not used (only its saved sign-in).
- Sign-out detection is a pattern on addresses and link words; an app that signs out at an address like `/bye` without such words is not
  recognised (list it as an excluded path or a sensitive workflow).
- The API document's operations are requested only when they need no value; anything with parameters is listed, never called.
- A project export (OPS's backup) carries the sign-in's name, the sensitive workflows and the API document (see "Backups (OPS)"), never the
  saved signed-in state itself; a full database backup carries everything.

## External scanners (SCAN)

An assessment can also run four well-known tools - OWASP ZAP, Nuclei, Schemathesis and Promptfoo - and fold what they find into the same
findings as the read-only checks. It is **off by default**: with `SECURITY_SCANNERS` unset, nothing below changes and the assessment is
exactly the read-only review described above. Full detail, including what each tool does not cover, is in
[security-scanners.md](security-scanners.md).

### Two gates, and both must be open

1. `SECURITY_SCANNERS` names the tools that may run at all. Installing a tool on the machine does nothing by itself.
2. An editor allows them for the project (`PUT /api/v1/security/projects/:id/scanners`).

The health view says which of the two is shut, in different words, because they have different fixes: `off` means an administrator must name
the tool in the environment file, `not-allowed` means somebody must allow it for this project. One project's allow-list grants nothing over
another project's targets.

### Profiles, and the approval an intrusive one needs

`passive` sends ordinary and known-file requests. `conservative-active` sends crafted requests bounded by the rate and the budget.
`advanced` may send requests that change what the application holds (POST, PUT, PATCH, DELETE): it needs a **recorded approval** (who, when,
which environment, the exact statement shown) and is **refused in production**. Every profile also carries a `never` list, shown before a
scan starts and printed in the report.

### What a scanner's findings become

A scanner finding becomes a `RawResult` in exactly the shape the platform's own read-only checks produce, so it goes through the same
redaction, deduplication, history and re-test pipeline. A scanner finding is **never** created as confirmed, and an **AI** finding is always
`confidence: "low"`, never above `medium`, and its description says in words that this is observed behaviour for a person to judge. A tool
reporting the same rule on the same address a thousand times produces one finding plus a coverage line saying how many were folded.

### The coverage list

Every run adds plain sentences to the coverage list: what ran and what it found, and **what did not run and why**. One tool failing never
fails the assessment - the other tools still run, the assessment finishes `PARTIALLY_COMPLETED`, and the reason is written out in words
rather than as an error code. A tool that is not installed, not configured, not allowed or refused at the profile is reported as such and
produces no findings: there is no path here where a missing tool becomes a clean result.

### API (SCAN part)

| Route | Role | What it does |
| --- | --- | --- |
| `GET /api/v1/security/projects/:id/scanners` | viewer | Health of every known scanner for this project, what each covers, the profiles and the AI cases |
| `PUT /api/v1/security/projects/:id/scanners` | editor | `{ enabled: [...] }`; a tool the platform has not switched on is answered as `refused` |
| `GET /api/v1/security/projects/:id/scans` | viewer | The project's recent scanner runs |
| `GET /api/v1/security/assessments/:aid/scans` | viewer | One assessment's runs, with what each found and did not cover |
| `GET /api/v1/security/scanners` | viewer | Platform settings, with every secret reported only as set or not set |

There is deliberately **no route that runs a scanner**, and no field anywhere that takes a binary, a template, a path or a command from a
caller. A scan runs as part of an assessment, so it inherits that assessment's authorization, rate limit, exclusions and cancellation.

### Tests (SCAN)

`tests/security-scanner-core-unit.test.ts`, `tests/security-scanner-adapters-unit.test.ts`,
`tests/security-scanner-orchestration-unit.test.ts` and `tests/security-scanner-api.test.ts`, with real captured tool output in
`tests/fixtures/security/` and a deliberately vulnerable fixture application in `examples/security-fixture/`.
