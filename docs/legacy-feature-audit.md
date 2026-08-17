# Legacy Platform Feature-Parity Audit

> Produced against `checklist.md` (source of truth). Read-only audit — no application code was
> modified to produce this document. Method: direct inspection of `api/prisma/schema.prisma`,
> every relevant API module under `api/src/modules/`, every relevant page under
> `web/src/app/app/admin/`, plus 7 parallel deep-dive passes over the areas the checklist calls
> out as high-risk (tester assignment, bug lifecycle, communication, transactions, tables/forms,
> files, RBAC/multi-tenancy).
>
> **Architecture note that shapes almost every finding below:** the new platform has **no
> separate "Build" entity**. A `Project` (schema.prisma:626) is the closest equivalent to a
> legacy Project+Build combined into one record — there is no way for one Project to hold
> multiple Builds, no build-specific status distinct from project status, no "Copy Build," and
> no per-build settings (feature lists, custom bug fields, tester-bug-visibility toggle). Every
> checklist item under "Build Management" and "Build Settings" is evaluated against this
> reality: where the checklist asks for a build-level concept and only a project-level
> equivalent exists, that is marked `[~]`; where nothing at all exists, `[ ]`.

---

## Implementation Pass 1 (post-audit)

The findings below the summary are a frozen snapshot from the initial audit — left as-is so the
history of what was found and why is not lost. This section records what changed afterward.
Where a fix is described here, treat the corresponding finding further down as historical
("this was the gap before the fix") rather than current state.

**Priority 1 — Critical, implemented:**

1. **File download authorization** — `api/src/modules/uploads/uploads.routes.ts`. Added
   `assertCanDownload()`: resolves the file's owning bug/project/thread via the existing
   `bugRelations`/`projectRelations`/`threadRelations` + `authorize()` pattern; admin-side roles
   bypass; avatars/logos stay open (they render unscoped across the admin UI, so gating them
   would break lists for no confidentiality gain); anything unattached (e.g. `TESTER_DOCUMENT`)
   falls back to uploader-only. Verified end-to-end with a real uploaded file: uploader → 200,
   unrelated tester → 403, admin → 200. `docs/SCHEMA-RECONCILIATION.md`'s note on this gap is
   updated to point here.
2. **Maximum tester limit** — `Project.maxTesters` (nullable int, additive schema change),
   enforced in `assignTesters()` (`api/src/modules/projects/projects.service.ts`): counts
   INVITED/ACCEPTED/ACTIVE/COMPLETED assignments against the cap (REMOVED/DECLINED free a slot),
   rejects the batch with a 409 if it would exceed the cap. Editable from the project create/edit
   forms; shown as "N / cap" in the project's "At a glance" panel. Verified end-to-end: a
   `maxTesters: 1` project accepted tester #1 and refused tester #2 with the expected message.
3. **Tester eligibility (device/OS/platform)** — implemented as a non-blocking signal rather than
   a hard gate, since `Project.platformTargets` is free text with no formal contract with
   `DeviceType` — a hard block risked rejecting legitimate assignments on loosely-typed data.
   `deviceFitsTargets()` (`web/src/app/app/admin/projects/[id]/constants.ts`) compares a tester's
   `TesterDevice` rows against the project's targets and appends "no device on this platform" to
   the invite picker's description when there's a clear mismatch, "no signal" otherwise.
4. **Bug Type + Feature classification** — this closed three separate audit findings at once:
   - Added `BugType` enum (Crash/App Freeze/Functional/UI/UX/Security/Performance) and a nullable
     `Bug.type` column.
   - Added `BugStatus.FEATURE_REQUEST`, wired into the transition matrix in
     `api/src/lib/access/policy.ts` (reachable from NEW/TRIAGED, reversible on appeal, same
     pattern as REJECTED/DUPLICATE).
   - Added a `Feature` model (project-scoped, unique per `(projectId, name)`) and a nullable
     `Bug.featureId`, closing all of §13's "Feature Lists" sub-items: list/add/remove via
     `/projects/:id/features`, a "Features" panel on the project detail page, and a Feature select
     on the bug detail page's new "Classification" panel (alongside Type).
   - Also fixed the "Country" column gap on the bug list: `reportedBy.testerProfile.countryCode`
     is now selected in `bugSelect` and rendered with a flag next to the reporter's name.
   - Verified end-to-end in-browser: created a feature, classified a real bug as
     Functional/Checkout, confirmed both persisted after reload, and confirmed the bug list shows
     the new Type column, Type filter, and the feature name as a tag.
5. **Tester bug visibility toggle** — `Project.testersCanSeeOtherBugs` (nullable-free boolean,
   default `false`, additive schema change). Wired symmetrically on both sides of the ReBAC
   consistency invariant: `relations.ts`'s `bugRelations()` adds a `bug:project_tester` relation
   when the flag is on and the caller holds an ACCEPTED/ACTIVE assignment on the bug's project;
   `scopes.ts`'s `bugScope()` OR's in the matching project/assignment-status clause for list
   queries; `policy.ts`'s `bug.read` rule accepts the new relation. Exposed as a checkbox on the
   project brief edit form ("Testers can see bugs raised by others"), off by default. Verified
   end-to-end: an INVITED tester sees nothing, an ACCEPTED tester with the flag on sees every bug
   on the project via both the list endpoint and a direct single-bug fetch, and an unrelated
   tester still gets a 404 on direct fetch — confirming list and detail never disagree. This
   closes the last of §13's three sub-features that was reachable without a schema redesign.
6. **List sorting (§31)** — `ListFilters` (`web/src/components/admin/ListFilters.tsx`) gained a
   generic `sort` prop (sort-by + asc/desc `<Select>` pair), wired into the 5 admin lists whose
   API already accepted a `sort` query param: bugs, organisations, projects, testers, users.
   Verified end-to-end: the API returns rows in the requested order (checked for
   `sort=updatedAt&order=asc` on bugs and `sort=name&order=asc` on organisations against their
   default ordering), and the rendered selects correctly reflect the sort/order taken from the
   URL. Also closed two smaller gaps noticed on the testers list while there: a working search
   box (previously accepted by the API loader but with no UI control) and the same treatment.
7. **Bugs CSV export (§31, "Action menu/buttons")** — `GET /v1/bugs/export.csv` accepts the same
   query schema as `GET /v1/bugs`, drops pagination, and emits a 24-column CSV with the same
   `bugScope()` access enforcement so RBAC scoping is identical to the list endpoint. Tiny
   no-dep CSV writer in `api/src/lib/csv.ts` (CRLF terminators, RFC 4180 quoting, timestamped
   filenames). Web side: a Next.js Route Handler at
   `web/src/app/app/admin/bugs/export/route.ts` forwards cookies and streams the API response
   back to the browser, so the export stays same-origin and the link is a normal `<a>`. The
   bugs list page's toolbar now has a secondary "Export CSV" button next to the filter strip;
   `buildExportHref()` preserves the current filter set as querystring. Verified end-to-end:
   admin export returns 4 rows with the expected `text/csv` headers and an attachment filename;
   `?status=NEW` filters down to the 1 NEW bug; tester1 export returns an empty data section
   (matches the same scope's list count of 0); the route handler's pass-through preserves the
   API's status, content-type, and content-disposition headers.
10. **CSV export for the other 4 admin lists** — extended the bugs pattern to organisations,
    projects, testers, and users. Each has an `export{X}CSV()` service function that re-uses
    the same `where` clause as the matching list endpoint (so RBAC scoping is unchanged),
    and a `GET /v1/{x}/export.csv` route that streams the CSV. Initially added a per-list
    Next.js Route Handler at `/app/admin/bugs/export/`, then refactored to a single catch-all
    `web/src/app/app/admin/export/[...path]/route.ts` that proxies any
    `/app/admin/export/{list}/...` path to the matching API export — so a new list only needs
    the API route and the button, no new Route Handler. Each list page has its own
    `buildExportHref()` preserving the current filter set. Verified end-to-end: API calls
    return 7 orgs / 2 projects / 5 testers / 14 users with `Content-Type: text/csv; charset=utf-8`
    and timestamped attachment filenames; `?status=IN_PROGRESS`, `?countryCode=IN`,
    `?role=ADMIN` filters all pass through to the export.
8. **Testers country filter UI** — the API endpoint already accepted `countryCode` and the
   admin testers page already validated and forwarded it, but there was no UI control to set
   it. Added a compact text input to the testers list toolbar via a new `texts` prop on
   `ListFilters` (the wider Search box is for free-form name/email matches; the country code
   is a 2-letter ISO code and would be lost in a generic search). Validated end-to-end:
   `?countryCode=IN` returns 1 result (Shubham Kumar, QA Engineer), `?countryCode=US` and
   `?countryCode=ZZ` correctly return 0. Lowercase `?countryCode=in` is also accepted — the
   page normalises to upper-case before forwarding.
9. **Organisations list Phone column** — `Organisation.contactPhone` existed in the schema
   and was already returned by the API list endpoint, but the web list page just didn't render
   it. Added a "Phone" column between "Status" and "Members" on the admin organisations table,
   rendered as a `tel:` link when the value is present and an em dash otherwise. Seed data
   had every phone set to `NULL`; verified end-to-end by PATCHing Vela Travel and confirming
   the next list GET returns the value.
11. **Unsaved-changes warning (§31 polish)** — `<UnsavedChangesWarning>` (a small `'use client'`
    leaf) plus a `<TrackedForm>` wrapper that owns the form ref. The wrapper is a drop-in
    replacement for `<form action={...}>` and works for both Server Actions and string URLs.
    On `input`/`change` events the component compares the current value of every form
    element to a snapshot taken at mount, flipping the dirty flag; on `submit` it clears
    the flag so a successful save doesn't show a warning. While dirty, a `beforeunload`
    listener prompts the browser's native dialog. Wired into the four longest editing
    forms: project edit brief, project create, organisation create, bug classification.
    `web tsc`/`eslint` clean; the new component is in the compiled bundles (74 references).
12. **Tester device hardware fields (§19)** — added `ramGb`, `network`, `browser` columns to
    `TesterDevice` (`api/prisma/schema.prisma`). Free-text strings rather than enums so
    the schema doesn't have to migrate every time a new device ships with more RAM. The
    API `deviceSchema` accepts the new fields, the `addDevice` service passes them
    through, the `profileSelect` exposes them on every tester read, and the admin
    tester detail page renders them in a new "Hardware" column. Verified end-to-end:
    tester1 POSTed `{ramGb: "32", network: "WiFi 6", browser: "Safari 18"}` and the
    subsequent admin `?search=tester1` returned the values.
13. **Project-scoped announcements (§20)** — added nullable `projectId` on `Announcement`
    and the matching `Project.announcements` relation. The list endpoint now applies an
    additional visibility filter: project-scoped announcements are visible to admin-side
    roles always, to testers with an ACCEPTED/ACTIVE assignment on that project, and to
    customer members of the project's organisation; everyone else sees the platform-wide
    set only. Created via `POST /v1/communication/announcements` with a new optional
    `projectId` field. The compose form (`/app/admin/communication/announcements/new`) has
    a new "Limit to one project" panel with a Select listing every project (defaults to
    "Platform-wide"). The list page now has a "Scope" column linking to the project or
    showing "Platform-wide". Verified end-to-end: created a project-scoped announcement,
    listed it back with `project.reference` populated, then deleted it.
14. **Skill taxonomy (§18)** — new `SkillCategory` enum (`DOMAIN`/`TYPE`/`TOOL`/`APPLICATION`)
    with a non-nullable `Skill.category` field defaulting to `TOOL` (so legacy free-text
    skills don't break). New admin endpoints: `GET /v1/testers/skills/catalogue` lists
    every skill with its `_count.testers`; `PATCH /v1/testers/skills/:skillId/category`
    re-classifies one. The tester profile select now exposes `skill.category` so any
    downstream UI can group skills by taxonomy. New admin page
    `/app/admin/skills` groups skills by category with a per-row Save button to
    re-classify, wired through a Server Action that mirrors the API's enum and narrows
    unknown values to `TOOL`. Verified end-to-end: listed 8 skills, patched the first
    to `DOMAIN`, list now reports 1 DOMAIN skill. The "Skills" entry has been added to
    the admin sidebar.
15. **Bulk row-actions on the bugs list (§31, remaining half of #15)** — `POST
    /v1/bugs/bulk-status` accepts up to 200 bug ids plus an optional `status` and/or
    `severity`, and applies the exact same per-bug transition-matrix and relation checks
    as the single-bug `changeBugStatus` — one row failing (e.g. an illegal transition)
    is recorded as skipped with a reason rather than aborting the whole batch. New
    `bulkChangeBugStatus()` service function in `api/src/modules/bugs/bugs.service.ts`.
    Web side: a checkbox column was added to the bugs table (`form="bugs-bulk-form"`
    lets each row's checkbox submit into a form that lives outside the table, the
    standard HTML mechanism — no client JS needed), plus a bulk-action bar below the
    filter strip with a status Select, a severity Select, and an Apply button.
    `bulkChangeBugStatusAction` (Server Action) narrows the submitted enum values before
    forwarding. Verified end-to-end: bulk-moved 1 bug NEW→TRIAGED→CONFIRMED (succeeded),
    then attempted a mixed 3-bug batch → NEW where 2 were already past NEW (all 3
    correctly skipped with per-row reasons naming the illegal transition), then bulk-set
    severity on 2 bugs (succeeded). All test-induced state was reverted afterward —
    including two stray `BugStatusHistory` rows created by the test, deleted directly
    since the transition matrix (correctly) does not allow moving a bug backward from
    CONFIRMED to NEW through the normal API.
16. **Sort + CSV export for managers and transactions (§31, closing the last two lists)** —
    both routers previously hardcoded `orderBy: { createdAt: 'desc' }` with no `sort`
    query param at all. Added `MANAGER_SORT_FIELDS`/`TRANSACTION_SORT_FIELDS` and wired
    `buildOrderBy()` into both list endpoints, plus `GET /v1/managers/export.csv` and
    `GET /v1/transactions/export.csv` (transactions' amount export divides the BigInt
    minor-unit column by 100 to a plain decimal — Excel reads `"150000"` literally, not
    as ₹1,500.00). Refactored the transactions list handler to share one
    `transactionWhere()` builder between the list and export endpoints so they can never
    drift apart. Web pages for both lists gained the standard `SORT_OPTIONS` +
    `buildExportHref()` + "Export CSV" button pattern already used by the other 5 lists.
    Verified end-to-end: `managers?sort=firstName&order=asc` returns in the right order;
    both export endpoints return 200 with the right CSV headers and row counts (2
    managers, 3 transactions) via the same proxy logic the catch-all route handler uses.
17. **Wider `TrackedForm` rollout + a real dirty-detection bug found and fixed** — extended
    the unsaved-changes warning (Pass 1 #11) to 6 more multi-field forms: the admin's own
    profile (name/phone/timezone) and password-change forms, the create-user form, the
    edit-user identity form, the sub-admin permissions checklist, the tester
    status-change form (status + note), and the bug status-move form (status +
    duplicate-of + note). Single-field/single-button forms (role dropdowns, archive
    buttons, remove-member buttons) were deliberately left alone — matches the original
    scoping rationale.
    While wiring the sub-admin permissions form (many checkboxes sharing one
    `name="permissionCodes"`), found that `UnsavedChangesWarning`'s original
    implementation was subtly broken in two ways: (1) its snapshot `Map` was keyed by
    `name`, so multiple same-named checkboxes silently collapsed onto one map entry —
    toggling any checkbox but the last in DOM order would never register as a change;
    (2) worse, it read `.value` for every input including checkboxes/radios, but a
    checkbox's `.value` is the static value attribute and never changes when the box is
    (un)checked — so dirty detection for *every* checkbox in the app, including the
    already-shipped `testersCanSeeOtherBugs` toggle on the project brief form, was
    silently a no-op from the moment it shipped. Rewrote the component to key the
    snapshot by DOM element identity (a `WeakMap<Element, string>`) instead of by name,
    and to read `.checked` for checkbox/radio inputs instead of `.value`. This is a real
    correctness fix, not just new coverage — `web tsc`/`eslint` clean after the rewrite.
18. **Bulk tester messaging / broadcast (§22)** — previously deferred as a multi-day feature
    ("needs a new admin thread-create UI; the API (`POST /threads`) already supports it"). Turned
    out to be a same-session lift once actually scoped: the API needed nothing at all.
    New page `/app/admin/communication/broadcast` — a recipient picker (reusing the testers
    list's search/status-filter/sort pattern, defaulting to VERIFIED testers sorted by rating)
    with a checkbox per row, plus a compose panel (subject + body). Submitting calls
    `POST /v1/communication/threads` once per selected tester with `type: DIRECT` and a
    single-element `participantIds` — deliberately fanning out into N private one-to-one
    conversations rather than one shared group thread, so a tester never sees who else got the
    same message or how they replied. Capped at 100 recipients per send; one recipient failing
    does not abort the rest of the batch. A "Message a group of testers" button was added to the
    Communication page's toolbar alongside "Compose announcement" and "Open message threads".
    Verified end-to-end: sent a test broadcast to 2 testers, confirmed each got their own private
    thread seeded with the message and the sender as the only other participant, confirmed
    tester3 got a 404 attempting to read tester2's copy of the thread directly (privacy holds),
    confirmed tester2's own thread list shows exactly 1 conversation. Cleaned up both test
    threads via a direct Prisma delete afterward (the API has no thread-delete route — only
    close, which is a different semantic than "never happened").
    **While verifying this feature, found and fixed a real bug from earlier in this session:**
    every "Export CSV" button added across all 7 admin lists used `iconLeft="download"`, and the
    bulk bug-status bar's "Apply to selected" button used `iconLeft="check-check"` — neither
    icon was registered in `web/src/components/ds/core/icon-registry.ts`. Because `Button`'s
    `iconLeft` prop is typed as a loose `string` rather than the strict `IconName` union,
    `tsc` never caught it; at runtime the `Icon` component silently renders nothing for an
    unregistered name (by design, to avoid a hard crash on a bad name) and logs a dev-only
    console warning, which is how it surfaced — while restarting the dev server for this
    feature, the log showed `[Icon] "download" is not in the icon registry` repeated dozens of
    times. Added `Download` and `CheckCheck` to the registry; both are real `lucide-react`
    exports, so this was a one-line-per-icon fix, not a design decision. Every Export CSV button
    across the app, and the bulk-action bar, now renders its icon correctly.
    **Also found while restarting servers for this verification:** a stale zombie `next dev`
    process from earlier in the session was still bound to port 3000 with a corrupted Turbopack
    cache, silently serving 404s for routes that exist (`/app/admin/bugs`, the new broadcast
    page, etc.) while a *fresh* `npm run dev` invocation quietly fell back to port 3001 instead
    of failing loudly. Killed the zombie, cleared `.next/`, restarted clean on 3000 — worth
    flagging as a recurring hazard in this environment: a 404 on a route that should exist is not
    proof the route is broken, it may mean the dev server serving that port is stale.
19. **Communication Templates (§23)** — previously deferred alongside bulk messaging as "no
    `MessageTemplate` model." New model, project-scoped nowhere — templates are platform-wide,
    matching the legacy example ("Profile Update Request" applies to any tester, not one
    project). `GET/POST /v1/communication/templates` and `DELETE .../templates/:id`, gated by
    the existing `communication.read`/`communication.write` permissions (no new permission
    codes needed). No update route — deleting and recreating is the correction path, matching
    the Announcement model's existing "no edit, only delete" precedent in this same module.
    New management page `/app/admin/communication/templates`; a new `<TemplatePicker>` client
    component (the one genuinely interactive piece — populating two other fields from a
    `<select>` cannot be done without JS) wired into both the announcement composer and the
    broadcast composer via `Panel`'s `actions` slot. Deliberately did not build
    variable/placeholder substitution — no message body in this platform needs per-recipient
    interpolation, since broadcasts already fan out into independent private threads rather
    than one shared render pass. Verified end-to-end: created "Profile Update Request" as
    permanent demo data (matching the precedent set for the Checkout feature and the Vela
    Travel phone number), confirmed it round-trips through the same fetch path both composer
    pages use, confirmed the duplicate-name guard rejects a second template with the same
    name. Caught and fixed a data-corruption artifact from my own test tooling along the way:
    an em dash typed directly into a bash `curl -d '...'` heredoc landed in Postgres as a
    replacement character (U+FFFD) — not an API or app bug, a Git-Bash/MSYS encoding issue with
    that particular shell invocation. Fixed by deleting and recreating the template from a
    `--data-binary @file.json` payload instead of an inline string.
20. **Global Assets Management (§18)** — previously deferred as needing "new `Device`/`Browser`
    lookup tables." Re-examined: legacy's Devices/Browsers assets have "Added By" and "Country"
    columns, which only make sense as an aggregate view of what testers themselves registered,
    not a curated reference table an admin maintains independently — this platform's
    `TesterDevice` rows already are that data, just scoped to one tester at a time on the
    existing detail page. New `GET /v1/testers/devices` (admin, `tester.read`) lists every
    device across every tester with search/type/country filters and sort; `onlyWithBrowser=true`
    reuses the same endpoint as the Browsers tab rather than a second table. Two new pages,
    `/app/admin/assets/devices` and `/app/admin/assets/browsers`, added to the sidebar under
    Accounts. One honest gap flagged rather than papered over: `TesterDevice.browser` is a
    single free-text field (`"Chrome 128"`), not separate name/version columns, so "Browser
    Version" is marked `[~]` in `checklist.md` — folded into the Browser column — rather than
    faked as an empty column with no data source. Caught and fixed a real bug in my own draft
    before it shipped: the `where` clause built `testerProfile: {...}` from two separate
    conditional spreads (`user.deletedAt` and `countryCode`), which — being the same top-level
    key — would have silently overwritten each other instead of combining, meaning a
    country-filtered query would have leaked devices belonging to soft-deleted testers. Fixed
    by merging both conditions into one `testerProfile` object before the filters are combined.
    Verified end-to-end with real data: re-registered a tester's device through the real
    add/remove device endpoints (no update route exists) to attach a `browser` value as
    permanent demo data, confirmed the Devices page lists all 3 seeded devices, confirmed
    `?countryCode=IN` narrows to exactly the Indian tester's device, confirmed the Browsers page
    shows only the one device with a browser on file.
    **While verifying this feature, hit two unrelated processes from other projects on this
    machine squatting on the ports this project uses** — a compiled `dist/main.js` Node/Nest app
    (almost certainly this environment's separate PaymentWallet project) repeatedly respawned on
    port 4000, and an unrelated Next.js dev server from `C:\Users\laptop\Desktop\DBSK CBT` took
    over port 3000 after this project's own web server had died earlier in the session. Neither
    was touched without asking first; the user confirmed both were safe to kill. Where the API
    process kept respawning under what looks like a supervisor, rather than keep fighting it,
    the web server was instead pointed at this project's API on an alternate port
    (`API_ORIGIN=http://localhost:4010`) as a one-off environment override for verification —
    nothing was written back to the committed `.env`.
21. **Tester Account/Finance — read-only slice (§21)** — previously deferred as "100% missing
    at the schema level." Re-examined: the *balance/earnings* half needed zero schema changes
    — `GET /v1/transactions/summary/mine` (groups the tester's own `TESTER_EARNING`/
    `TESTER_PAYOUT` rows by status) and `GET /v1/transactions` (auto-scoped to
    `counterpartyId: user.id` via `transactionScope`) already existed and were already callable
    by any authenticated tester with no permission gate beyond `authenticate`. What was
    actually missing was the UI. Replaced `web/src/app/app/tester/page.tsx`'s
    `<PortalNotReady />` with a real dashboard — the tester's actual `ROLE_HOME` destination —
    showing four stat tiles (Available balance, Total earned, Pending review, Paid out) and a
    50-row transaction history table, every figure a live read from the same ledger the admin
    Transactions list uses. "Available balance" is computed client-side as approved earnings
    minus paid-out amounts and labelled with that formula explicitly, rather than presented as
    an unqualified number.
    **Deliberately NOT built, and explicitly said so on the page itself:** a Credit Fund /
    Release Fund split (the schema's `TransactionStatus` enum has no such two-stage semantic —
    fabricating one would misstate the account holder's real position), a payment
    method/PayPal field (no such field exists on `User` or `TesterProfile`), a TDS figure (no
    `tdsAmountMinor` field on `Transaction`), and a Finance Year date-range filter (small,
    real follow-up — the admin Transactions list already has `from`/`to` params, this page
    just doesn't expose them yet). Also explicitly deferred: bug reporting, evidence upload,
    profile self-service, and an announcements feed — the rest of the tester portal, called out
    as "coming soon" directly on the page so it never implies more is done than actually is.
    Verified end-to-end with real accounts: tester1's page shows their real transaction
    (`TXN-2026-0002`); tester2's page correctly shows "No transactions yet" (no cross-tester
    leakage); an ADMIN account visiting `/app/tester` directly is redirected to `/app/admin`
    rather than reaching tester data, proving the role gate holds independently of the shared
    `/app/layout.tsx`'s "is signed in" check.
    **Caught a real build-artifact corruption while re-verifying, unrelated to this feature's
    own code:** a prior `tsc`/`eslint` verification command in this session piped output
    through `tail` and checked `$?` afterward — which captures `tail`'s exit code, not `tsc`'s,
    so a genuine failure was silently reported as passing. Re-running properly (capturing the
    real command's exit code) surfaced 7 syntax errors in `.next/dev/types/routes.d.ts`, a
    Next.js auto-generated file that had been left mid-write and corrupted — almost certainly
    from one of this session's several forceful `taskkill`s against dev-server processes during
    the port-conflict cleanup. `.next/` is gitignored build output, not source; cleared it and
    let Next.js regenerate cleanly, then re-verified all four checks (`api tsc`/`eslint`,
    `web tsc`/`eslint`) with correctly-captured exit codes this time — all genuinely clean, zero
    lines of output.
22. **Tester profile self-service (§2.3)** — the second real slice of the tester portal. Like
    the finance slice, this needed **zero API changes**: `PATCH /testers/me`, the device and
    work-history add/remove pairs, the skills/languages full-replacement PUTs, and the NDA
    accept endpoint all already existed under a `requireRole(TESTER)` sub-router. The gap was
    that no web UI had ever called any of them. New page `/app/tester/profile` with sections
    for basic info, devices, skills, languages, work history, and an NDA-acceptance panel that
    only renders when `ndaAcceptedAt` is null. Linked from the tester dashboard, and the
    dashboard's "coming soon" note narrowed accordingly so it never overstates what is done.
    Languages needed care: the API has no per-row endpoint, only a full-collection
    `PUT /testers/me/languages`, so each add/remove form carries the current set as a hidden
    JSON snapshot and the Server Action recomputes the whole array before PUTting it — that
    mirrors the API's actual contract rather than working around it.
    **Found and fixed a real pre-existing production bug while verifying this** — not test
    flakiness, and not something this pass introduced. `setSkills` ran N `skill.upsert` calls
    **plus** a `deleteMany`, a `createMany`, **and** a final `findUnique` using the heavy
    `profileSelect` (which fans out across five relations) all inside one interactive
    transaction. Prisma's default interactive-transaction budget is 5000ms; each round trip to
    the remote Neon instance is roughly a second. The result was that a tester saving **three
    or more skills got a 400 with nothing saved** — reproduced deterministically from the API
    log at 5270ms and 5283ms across separate attempts, while a two-skill save squeaked
    through. `setLanguages` had the same shape (delete + create + heavy read) and was
    intermittently failing for the same reason.
    The fix scopes each transaction down to only the work that genuinely needs atomicity —
    the delete-then-recreate of that one tester's rows, so the set is never observable
    half-replaced. The `skill.upsert` calls moved out (they create rows in the *global*
    catalogue, are idempotent, and are not part of the set being swapped — an orphaned
    catalogue row on failure is harmless), and the final profile read moved out too (it only
    builds the response, and reading after commit is if anything more correct). Verified: the
    exact three-skill payload that previously failed now returns 200 with all three saved, and
    an **eight**-skill payload completes in 12.44s versus 12.41s for three — near-identical,
    confirming the transaction is now N-independent and the upserts parallelise properly
    outside it. (Those wall-clock figures are dev-laptop-to-us-east-Neon latency across ~7
    round trips, not representative of a co-located deployment; the correctness fix is the
    point, not the timing.)
    All test mutations reverted afterward: tester1's skills and languages restored to their
    original values, and the two skill-catalogue rows the eight-skill test created
    (`Load Testing`, `Regression Testing`, both with zero testers) deleted directly via
    Prisma since the API intentionally exposes no skill-delete route — catalogue verified back
    at its original 8 rows with unchanged tester counts.
23. **Tester bug reporting (§2.3)** — the third slice, and the core tester workflow. Again
    **zero API changes**: `POST /v1/bugs` already gated `bug.create` on an ACCEPTED/ACTIVE
    assignment and already refused DRAFT/COMPLETED/CANCELLED projects. Two new pages —
    `/app/tester/bugs` (the tester's bug list) and `/app/tester/bugs/new` (the report form,
    covering title, description, steps, expected/actual, severity, reproducibility, type, and
    the full environment block). The project picker is built from `/projects/my-assignments`
    filtered to assignments that actually confer `bug.create` and to projects in an
    accepting status — a UX courtesy, explicitly *not* the security boundary, since the API
    re-checks the relation on every submit.
    Verified both layers independently: tester1 (ACCEPTED assignment) filed a real report that
    appears in their list and in the admin cross-tenant list attributed to them; tester2 (no
    assignment) sees "No project to report against" in the UI **and** gets a 403 from a
    hand-built `POST /v1/bugs` bypassing the UI entirely; tester2's bug list correctly shows
    "No bugs yet" rather than tester1's report, confirming `bugScope` holds.
    Setting this up required a real assignment, created through the actual admin workflow
    (`POST /projects/:id/assignments` then the tester's own `POST /projects/:id/respond`)
    rather than by writing to the database — that assignment and the resulting bug report are
    kept as demo data, consistent with the precedent set for the Checkout feature and the
    Profile Update Request template. (It also surfaced that the one pre-existing assignment on
    C4T-2026-0002 is `REMOVED` — leftover from this session's earlier `maxTesters` testing.
    Left in place: `REMOVED` is a valid terminal state and deleting assignment history would
    destroy a real audit trail.)
    **Found and fixed a latent reference-numbering bug while verifying.** The new bug was
    numbered `BUG-2026-00001` while the seeded bugs are `BUG-2026-0004` — investigating showed
    `nextReference()` pads bugs and transactions to 5 digits (matching the schema's own
    documented examples, `BUG-2026-00417` / `TXN-2026-00318`) but `prisma/seed.ts` hardcoded
    them at 4. Worse, the seed advanced the **project** sequence with `setval` — with an
    explicit comment explaining that skipping it would collide on the unique reference index —
    but never did the same for bugs or transactions. Those only avoided a collision *by
    accident*, because the mismatched padding made `BUG-2026-00001` ≠ `BUG-2026-0001`; aligning
    the padding without also adding the `setval` would have turned a cosmetic wart into a hard
    unique-constraint failure on the first bug reported after any re-seed. Fixed all of it:
    padding aligned to 5, `setval` added for both sequences, and the bug refs' hardcoded literal
    year `2026` templated like the others (seeding in 2027 would otherwise have produced
    `BUG-2026-*`). Also guarded the new `setval`s with `CREATE SEQUENCE IF NOT EXISTS`, since
    these sequences are created lazily by `nextReference()` and would not exist on a genuinely
    fresh database. **This takes effect on the next re-seed; the current dev database keeps its
    existing 4-digit seeded references and is not in a collision state.**

**Explicitly deferred** (each is a multi-day feature on its own; implementing any of them
partially would have produced exactly the "UI exists but isn't real" anti-pattern this audit
was built to catch):

- The rest of the tester self-service portal — Account/Finance (Pass 1 #21), profile
  self-service (Pass 1 #22) and bug reporting (Pass 1 #23) are now real. Still missing:
  **evidence upload** (needs the presign → upload → attach flow wired end to end, and a
  client-side file input, which is the one genuinely new UI mechanic left) and a
  **project-announcements feed** for the tester.
- Reports module (§24) — no code exists to build on top of; needs a `reports` API module.
- Build Settings' remaining sub-feature: fully dynamic Custom Bug Fields (Feature Lists and the
  tester-bug-visibility toggle — the other two sub-features — are now both done, see above).

**No longer deferred, done in a later pass despite the original multi-day estimate:**
- ~~Bulk tester messaging / broadcast (§22)~~ — see Implementation Pass 1 #18. The API needed
  zero changes; the estimate assumed a new thread-create UI would be a bigger lift than it
  turned out to be once actually scoped down to "checkbox picker + compose form + fan-out loop".
- ~~Sorting on the managers and transactions admin lists~~ — see Implementation Pass 1 #16.
- ~~Communication Templates (§23)~~ — see Implementation Pass 1 #19. The "no `MessageTemplate`
  model" framing made it sound bigger than "a Skill-sized lookup table plus one `<select>` that
  writes into two other fields" — which is what it actually was once scoped down.
- ~~Global Assets catalog (§18)~~ — see Implementation Pass 1 #20. The "needs new lookup
  tables" framing assumed a curated reference catalogue; the legacy columns ("Added By",
  "Country") actually described an aggregate view of tester-submitted data this platform
  already stores.
- ~~Tester Account/Finance — balance and transaction history half (§21)~~ — see Implementation
  Pass 1 #21. The "100% missing at the schema level" framing was true for the Credit
  Fund/Release Fund/TDS/payment-method parts, but the balance/earnings/history part needed no
  schema at all — `GET /v1/transactions/summary/mine` already existed and had already done the
  real work.

---

## Summary

```
Total legacy requirements (checkbox lines in checklist.md, sections 1-38): 621
Fully implemented [x]:      ~215
Partially implemented [~]:  ~140
Missing [ ]:                 ~250
Unknown [?]:                  ~16
```

*(Pre-"Implementation Pass 1" snapshot — see that section above for the items that moved from
`[ ]`/`[~]` to `[x]` afterward: max tester limit, file download authorization, Bug
Type/Feature Request/Feature Lists, the bug list's Country column, the tester-eligibility signal,
the tester-bug-visibility toggle, and admin-list sorting. `checklist.md` itself carries the
current per-item status for those areas.)*

These are section-weighted counts (see per-section tables below for the basis), and predate
Implementation Pass 1. The single largest driver of the `[ ]` count at audit time was that four
entire checklist sections had **zero** implementation: Section 13 (Build Settings — Feature Lists
/ tester-bug-visibility / custom bug fields, of which the first two are now done, see above),
Section 18 (Global Assets — Devices/Browsers catalog), Section 23 (Communication Templates),
Section 24 (Reports), plus Section 29 (Contests) and Section 30 (Remote QA). Together these six
sections accounted for 82 of the ~250 missing items at audit time.

---

## Detailed findings by section

### 1. Global Platform / Navigation

| Item | Status | Evidence |
|---|---|---|
| Home/Dashboard nav exists | [x] | `web/src/app/app/admin/layout.tsx:23-71` |
| Projects nav exists | [x] | same file |
| Contests nav exists | [ ] | no `Contest` model anywhere in `schema.prisma`; no nav entry |
| Organisations nav exists | [x] | |
| Crowd Testers nav exists | [x] | "Testers" link |
| Managers nav exists | [x] | |
| Assets nav exists | [ ] | no nav entry, no backing model |
| Communication nav exists | [x] | |
| Reports nav exists | [ ] | no nav entry, no `reports` API module at all |
| Transactions nav exists | [x] | |
| Remote QA nav exists | [ ] | no nav entry, no backing code anywhere |
| User/Profile menu exists | [x] | |
| Nav visibility respects role/permission | [~] | `Sidebar.tsx` filters by coarse `role`, not by the caller's actual granted permissions — a SUB_ADMIN without `transaction.read` still sees the Transactions link and is only blocked when the page itself runs `requirePermission` server-side. No data leak, just a noisy/inconsistent UX. |
| Nav works from every module | [x] | |
| Active/current nav state clear | [x] | `Sidebar.tsx:78-89` prefix-match |
| Unauthorized modules cannot be accessed directly by URL/API | [x] (admin) / [~] (customer/tester) | Admin gate is a real server round-trip (`requireRole` → `getUser()` → live `/auth/me` call), not a decorative client check, confirmed by tracing `web/src/lib/auth/session.ts`. Customer/tester side is trivially "protected" only because there is nothing behind the gate yet (see Section 2). |
| Global search/filter consistent | [?] | not deeply verified; no global search component found, only per-module filters |

**Section 1 tally: 12 [x], 2 [~], 4 [ ], 1 [?] (of 19 lines incl. sub-bullets counted individually in checklist.md, ~17 substantive)**

---

### 2. Home / Dashboard

The entire section is `[ ]` for the roles it actually matters for. `web/src/app/app/page.tsx`
(CUSTOMER) and `web/src/app/app/tester/page.tsx` (TESTER) both render `<PortalNotReady />` — a
deliberate placeholder, not a bug (the code comment explains a half-built scaffold was removed
on purpose). The only working dashboard is the **admin** operations dashboard
(`api/src/modules/stats/stats.routes.ts`), which is a real, live-DB-backed aggregate view (not
mock data) but is not the legacy "Recent Projects / Recent Contests card" experience a Customer
or Tester would see, and Contests cannot exist regardless since there is no Contest model.

| Item | Status |
|---|---|
| Recent Projects section exists | [ ] |
| Project cards show image/logo | [ ] |
| Project name displayed | [ ] |
| Org/client name displayed | [ ] |
| Project creation date displayed | [ ] |
| OS/platform info displayed | [ ] |
| Number of builds displayed | [ ] (no build concept) |
| Project details action exists | [ ] |
| Project edit action exists | [ ] |
| "View more projects" action exists | [ ] |
| Project cards open correct project | [ ] |
| Recent Contests section exists | [ ] |
| Recent contest info displayed | [ ] |
| Contest entries open correct contest | [ ] |
| Loading state | [?] |
| Empty state | [ ] |
| Error state | [ ] |
| Permission-aware dashboard data | [~] (true for the admin dashboard; moot for customer/tester) |

### Feature: Customer/Tester Home Dashboard
Status: `[ ]`
Current implementation: Both portals render a static "not ready" placeholder component.
Missing: Everything the checklist asks for — recent-projects cards, recent-contests cards, all
dashboard states.
Relevant files: `web/src/app/app/page.tsx`, `web/src/app/app/tester/page.tsx`,
`web/src/components/portal/PortalNotReady.tsx`.
Recommended change: Build a real Customer dashboard (recent projects the org owns, via the
existing `projects.service.ts` `visibilityFilter`) and a real Tester dashboard (assigned
projects via `ProjectAssignment`, recent bugs they reported). Both APIs already exist
(`/stats/customer`, `/stats/tester`) — this is primarily a frontend gap. Recent Contests cannot
be built until Contests (Section 29) has a data model.

---

### 3. Project Management

| Item | Status | Evidence |
|---|---|---|
| Project listing exists | [x] | `web/src/app/app/admin/projects/page.tsx` |
| Create project | [x] | `web/src/app/app/admin/projects/new/page.tsx` |
| View project | [x] | `web/src/app/app/admin/projects/[id]/page.tsx` |
| Edit project | [x] | same file, Overview panel edit form |
| Project search | [x] | real API-backed search |
| Project filtering | [x] | status + priority selects, API-backed |
| Project sorting | [ ] | API supports `sort` (`PROJECT_SORT_FIELDS`) but no UI control anywhere calls it |
| Project status represented | [x] | `ProjectStatus` enum + `StatusBadge` |
| Project associated with an organisation/client | [x] | `Project.organisationId` |
| Project can contain multiple builds | [ ] | no `Build` entity exists at all |
| Project/build relationship preserved | [ ] | n/a — there is no build to relate to |
| Project-level permissions enforced | [x] | `requirePermission`/relationship-based `can()` checks throughout |

**Section 3 tally: 8 [x], 0 [~], 3 [ ] (project sort, multi-build, project/build relation)**

---

### 4. Build Management

Almost the entire section is `[ ]` or `[~]` because of the missing Build entity. Where a
`Project` field can represent the *information* (even if not the *hierarchy*), it's marked `[~]`.

| Item | Status | Evidence |
|---|---|---|
| Builds can be listed under a project | [ ] | no Build entity |
| Build selector/dropdown exists | [ ] | |
| Current build/version clearly displayed | [ ] | |
| Multiple builds can coexist under one project | [ ] | |
| Correct build can be selected | [ ] | |
| Edit Build | [~] | project itself is editable; no build-level edit exists |
| Copy Build | [ ] | no such action exists anywhere |
| Download Report | [ ] | no reports module exists at all (Section 24) |
| View build details | [~] | project details exist; no separate build details |
| Build status | [~] | `Project.status` (`ProjectStatus`) serves this role |
| Test type | [ ] | no field anywhere (`api/src/modules/projects/projects.schema.ts`) |
| Test start date | [x] | `Project.startDate` |
| Test end date | [x] | `Project.endDate` |
| Maximum testers | [ ] | confirmed absent — no `maxTesters`/`testerLimit` field, no enforcement anywhere in `projects.service.ts` |
| Application/website URL | [~] | no dedicated field, but can be represented as a `ProjectMaterial` row with a `url` |
| Test document upload/link | [x] | `ProjectMaterial` (title/description/fileId-or-url) |
| Country/country selection | [x] | `Project.targetCountries` (ISO alpha-2 array) |
| Feature selection/list | [ ] | no `Feature`/`FeatureList` model anywhere in the schema |
| Application type | [~] | `Project.platformTargets` (free-text string array, e.g. `["web","android","ios"]`) — loosely covers this, not a structured enum |
| Supported operating systems | [~] | same `platformTargets` array; no OS-version granularity |
| Supported browsers | [ ] | no browser field anywhere in the schema |
| Testing instructions | [x] | `Project.instructions` (see Section 5) |
| Special requirements | [ ] | confirmed absent (Section 6) |
| *Legacy example* — Status = Assigned | [~] | `AssignmentStatus`/`ProjectStatus` cover the concept, different vocabulary |
| *Legacy example* — Test type = Exploratory Testing | [ ] | no test-type field |
| *Legacy example* — start/end dates | [x] | |
| *Legacy example* — Maximum testers configurable | [ ] | |
| *Legacy example* — web app/website URL | [~] | via `ProjectMaterial` |
| *Legacy example* — test document | [x] | |
| *Legacy example* — country configurable | [x] | |
| *Legacy example* — multiple feature tags | [ ] | |

### Feature: Build Management (Test Type, Max Testers, Browser Matrix)
Status: `[ ]`
Current implementation: `Project` has `platformTargets` (free string array) and
`targetCountries`/`targetLanguages`, but no `testType`, no `maxTesters`, no structured browser
list.
Missing: A `testType` enum (Exploratory/Functional/Regression/…), a `maxTesters` integer field
with enforcement in `assignTesters()` (`api/src/modules/projects/projects.service.ts:483-538`),
and either a `supportedBrowsers` string array or a proper `Browser`/`BrowserVersion` lookup
table (see Section 18 — the same missing catalog would serve both).
Relevant files: `api/prisma/schema.prisma` (`Project` model, ~line 626), `api/src/modules/projects/projects.schema.ts`, `api/src/modules/projects/projects.service.ts`.
Recommended change: add the three fields via a migration, thread `testType`/`maxTesters`
through `createProjectSchema`/`updateProjectSchema`, and add a hard check in `assignTesters()`
that rejects a new assignment once `_count.assignments >= maxTesters`.

---

### 5. Testing Instructions

| Item | Status | Evidence |
|---|---|---|
| Build has a testing-instructions field/editor | [x] | `Project.instructions`, up to 20,000 chars |
| Long-form instructions supported | [x] | |
| Test objective/scope can be described | [x] | via `instructions`/`summary` |
| Instructions visible to assigned testers | [~] | API returns it in project detail for anyone with `project.read` relation; no tester-facing UI exists to actually view it (tester portal is a placeholder) |
| Formatting is preserved where supported | [?] | plain-text field; no rich-text/markdown confirmed either way |
| Instructions editable by authorized users | [x] | |
| Instructions are versioned/persisted correctly | [~] | persisted, yes; no edit-history table for instructions specifically |

**Section 5 tally: 4 [x], 2 [~], 0 [ ], 1 [?]** — this section is in the best shape of the
Build-related sections precisely because it maps onto a `Project` field that already exists.

---

### 6. Special Test Requirements

Confirmed entirely absent — a full-repo grep for anything resembling
"required evidence"/"mandatory screenshot"/"crash log required" returns nothing.

| Item | Status |
|---|---|
| Build supports special testing requirements | [ ] |
| Screenshot/video-URL-mandatory can be configured/enforced | [ ] |
| Crash-log requirement can be configured/enforced | [ ] |
| Required evidence validated on bug submission | [ ] |
| Special requirements visible to testers | [ ] |

---

### 7. Build Summary / Analytics

| Item | Status | Evidence |
|---|---|---|
| Summary page exists | [ ] | no per-project bug-analytics view; only a platform-wide admin dashboard |
| Bug Type analytics exist | [ ] | no bug-type field exists to aggregate |
| Bug Severity analytics exist | [~] | platform-wide (`GET /stats/admin` → `bugsBySeverity`), real DB aggregate, but **not scoped to one project/build** |
| Bug Reproducibility analytics exist | [ ] | never aggregated anywhere |
| Bug Status analytics exist | [~] | platform-wide only, same caveat as severity |
| Bug Type categories: Crash / App Freeze / Functional / UI / UX / Security / Performance (7) | [ ] × 7 | no bug-type field in the schema at all |
| Severity categories: Critical / Major / Minor (3) | [~] × 3 | `BugSeverity` = CRITICAL/HIGH/MEDIUM/LOW — 4 levels vs legacy's 3, ambiguous mapping for HIGH/MEDIUM → "Major"/"Minor" |
| Reproducibility categories: Always / Sometimes (2) | [x] × 2 | both present in `BugReproducibility` enum (plus 2 extra values, which the checklist explicitly permits) |
| Status categories: New / Duplicate / Invalid / Feature Request (4) | [x], [x], [~], [ ] | NEW and DUPLICATE map directly; REJECTED plausibly = Invalid; nothing represents Feature Request |
| Analytics reflect current build data | [ ] | no build-level scoping possible |
| Counts are accurate | [~] | accurate at the (wrong) platform-wide scope |
| Empty/no-data state exists | [?] | not directly verified |
| Analytics do not expose cross-tenant data | [x] | customer-scoped `/stats/customer` applies `visibilityFilter`, confirmed |

### Feature: Per-Project Bug Analytics
Status: `[ ]`
Current implementation: the project detail page shows only a raw count ("Bugs logged") and a
10-row preview table with a link to the filtered global bug list
(`web/src/app/app/admin/projects/[id]/page.tsx:740-776`). No breakdown by severity, status, or
reproducibility is rendered anywhere scoped to one project.
Missing: A `bySeverity`/`byStatus`/`byReproducibility` aggregate scoped to `projectId`, and (once
Section 4's `testType` gap and Bug's missing `type` field are addressed) a bug-type breakdown.
Relevant files: `api/src/modules/stats/stats.routes.ts` (pattern to copy), `api/src/modules/bugs/bugs.service.ts`, `web/src/app/app/admin/projects/[id]/page.tsx`.
Recommended change: add a small `GET /projects/:id/bug-stats` endpoint using the exact
`groupBy` pattern already proven in `stats.routes.ts`, and a "Bug Summary" panel on the project
detail page.

---

### 8. Build Testers

*(Full end-to-end trace performed by a dedicated audit pass; see that agent's original findings
for file:line detail — summarized here.)*

**Tester list**

| Item | Status |
|---|---|
| Testers page exists | [x] |
| Assigned testers listed | [x] |
| Tester name displayed | [x] |
| Tester rating displayed | [x] |
| Tester location displayed | [~] (country only, city never selected) |
| Assignment status displayed | [x] |
| Bug count displayed | [ ] (not fetched for the roster at all) |
| OS/device information displayed | [ ] (not queried for the roster) |
| Browser information displayed | [ ] (no browser field exists anywhere in the schema) |
| Payment state displayed | [ ] (zero linkage between roster and `Transaction`) |
| Tester action controls exist | [x] (assignment status change) |
| Search testers/devices (in-roster) | [ ] |
| Filtering (in-roster) | [ ] |
| Sorting (in-roster) | [ ] |
| Pagination/large-list handling (in-roster) | [ ] (whole roster renders unpaginated) |

**Tester assignment**

| Item | Status |
|---|---|
| "Assign New Tester" action exists | [x] |
| Eligible testers can be found | [~] (top-40-by-rating pool only, no search box) |
| Eligibility considers device/OS/browser requirements | [ ] (only checks VERIFIED status + NDA, never compares against `Project.platformTargets` or tester devices) |
| Tester can be assigned | [x] |
| Assignment status persisted | [x] (real DB write, confirmed via `revalidatePath`, not optimistic-only) |
| Tester can be removed/unassigned | [x] (soft status flip to `REMOVED`) |
| Maximum tester limit respected | [ ] (no such field/check exists — see Section 4) |
| Duplicate assignment prevented | [x] (`@@unique([projectId, testerId])` + pre-check) |
| Assignment permissions enforced | [x] |

**Payment state**

| Item | Status |
|---|---|
| Payment status visible | [ ] |
| Paid state supported | [~] (`TransactionStatus.PAID` exists on the model but never surfaced on the roster) |
| Credit state supported | [ ] (no "credit" concept anywhere in `TransactionStatus`) |
| Payment state linked to transaction records | [ ] (schema *could* support the join — `Transaction.projectId`/`counterpartyId` — but nothing queries it) |

### Feature: Tester Roster — Bug Count, Device/OS, Payment State
Status: `[ ]`
Current implementation: `getProject()`'s assignment select
(`api/src/modules/projects/projects.service.ts:145-162`) only pulls
`testerProfile: { ratingAverage, countryCode }` — no devices, no bug counts, no transactions.
Missing: joins to `TesterDevice`, a per-project `Bug.reportedById` count, and a `Transaction`
lookup scoped to `(projectId, counterpartyId=testerId)`.
Relevant files: `projects.service.ts` (assignment select), `web/src/app/app/admin/projects/[id]/page.tsx` (roster columns/`constants.ts`).
Recommended change: extend the Prisma select and add 3 columns to `assignmentColumns`.

### Feature: Tester Eligibility Gate (Device/OS/Browser)
Status: `[ ]`
Current implementation: `assertAssignable()` (`api/src/modules/testers/testers.service.ts:335+`)
checks only `TesterStatus.VERIFIED` + NDA acceptance.
Missing: a comparison of the project's `platformTargets` against the tester's `TesterDevice`
rows before allowing assignment (or at minimum, a warning rather than a hard block).
Relevant files: `api/src/modules/testers/testers.service.ts`, `api/src/modules/projects/projects.service.ts` (`assignTesters`).
Recommended change: add an optional eligibility check parameterized so it can warn-only at
first, since not every project needs to be that strict.

---

### 9-11. Bug / Defect Management, Bug Detail, Comments

*(Full lifecycle trace performed by a dedicated audit pass — see agent findings for exact
file:line citations; summarized here.)*

| Area | Status | Note |
|---|---|---|
| Bug list page, search, filter, pagination | [x] | real, API-backed |
| Bug ID | [~] | human `reference` shown as secondary text, no dedicated "ID" column |
| Feature column | [ ] | no Feature model |
| Bug type column/classification | [ ] | no type field in the schema at all |
| Severity | [x] | shown, real enum |
| Sort control | [ ] | API supports it, no UI |
| Open/view/edit bug | [~] | view is full-featured; there's no inline edit of title/description/steps — only triage (severity/status), attachments, and comments are editable |
| Bug actions respect permissions | [x] | relationship-based `authorize()` calls, not UI-only |
| Bug type categories (7) | [ ] × 7 | confirmed, no schema support |
| Severity (Critical/Major/Minor) | [~] | 4-value enum vs 3-value legacy |
| Reproducibility (Always/Sometimes) | [x] | superset present |
| Status (New/Duplicate/Invalid/Feature Request) | [x],[x],[~],[ ] | Feature Request has no representation |
| Bug detail: description/steps/expected/actual | [x] | all present and rendered |
| Bug detail: pre-condition | [ ] | no field anywhere |
| Bug detail: video/URL evidence | [ ] | evidence is file-upload only; no URL-as-a-field option |
| Bug detail: attachments/screenshots/crash logs | [~] | fully wired end-to-end on the **API and admin-view side**; **no tester-facing bug-report UI exists at all** to create one (tester portal placeholder) |
| Status changes persisted with history | [x] | `BugStatusHistory` row written on every transition |
| Evidence requirements enforced | [ ] | a bug can be created/progressed with zero attachments; nothing enforces "Crash type needs a crash log" (moot anyway since there's no bug-type field) |
| Unauthorized users cannot modify bugs | [x] | relationship-based `authorize()`, verified server-side |
| Country column on bug list | [ ] | `TesterProfile.countryCode` exists but is never selected/joined into the bug query |
| Comments: create/list/persist/author+timestamp/scoped-to-bug/permissions | [x] all | fully real, including internal-vs-visible comment filtering |
| Comment notifications | [?] | not directly traced |

### Feature: Tester-Facing Bug Report Form
Status: `[ ]`
Current implementation: the API (`POST /bugs`, presigned uploads, attachment linking) is fully
built and correct. There is **no UI anywhere** for a tester to actually use it —
`web/src/app/app/tester/page.tsx` is `<PortalNotReady />`.
Missing: an actual bug-report form in the (currently nonexistent) tester portal.
Relevant files: `api/src/modules/bugs/` (reusable as-is), `web/src/app/app/tester/`.
Recommended change: this is the single highest-leverage fix in the whole audit — the backend
work is already done; only the tester-facing form needs building.

### Feature: Bug Type / Feature Classification
Status: `[ ]`
Current implementation: `Bug` model has `severity`, `status`, `reproducibility` — no `type`, no
`feature`.
Missing: a `BugType` enum (Crash/App Freeze/Functional/UI/UX/Security/Performance) and a
`Feature` model (name + `projectId`) with a `featureId` FK on `Bug`.
Relevant files: `api/prisma/schema.prisma` (`Bug` model ~line 732), `api/src/modules/bugs/bugs.schema.ts`.
Recommended change: two focused, additive schema changes — a new enum column and a new
lightweight lookup table, following the exact pattern used for `TesterWorkHistory` earlier this
session (additive `db push`, no destructive migration).

---

### 12. Build Announcements

| Item | Status | Evidence |
|---|---|---|
| Announcements section exists under a build | [ ] | `Announcement` model has **no** `projectId`/`buildId` field — the model's own doc-comment states these are platform-wide by design |
| Authorized users can create announcements | [x] | `POST /announcements`, permission-gated |
| Announcement content is persisted | [x] | |
| Assigned testers can see applicable announcements | [~] | filtered by role (`ALL`/`TESTERS`/etc.), not by project assignment — every tester on every project sees the same set; also unreachable end-to-end since the tester portal doesn't exist |
| Announcement visibility respects build/project permissions | [ ] | `GET /announcements/:id` has no audience check at all — any authenticated user who knows/guesses an id can fetch any announcement |
| Announcement history retained | [~] | create/list/get/delete exist; no update/edit route, so announcements are immutable once posted (a crude form of history, no real edit trail) |

### Feature: Project-Scoped Announcements
Status: `[ ]`
Current implementation: platform-wide only, gated by a coarse `AnnouncementAudience` enum.
Missing: an optional `projectId` on `Announcement`, and a visibility rule "testers assigned to
this project, or platform-wide if `projectId` is null."
Relevant files: `api/prisma/schema.prisma` (`Announcement` model ~line 899), `api/src/modules/communication/communication.routes.ts`.
Recommended change: add a nullable `projectId` field (additive migration) and extend the list
query's `where` clause.

---

### 13. Build Settings

**Confirmed 100% absent, verified by direct repo-wide grep with zero hits for any of:
"featurelist", "customfield", "testerscansee".**

| Item | Status |
|---|---|
| Feature Lists section exists / add / list / remove / associated with build / usable for bug classification / duplicate handling (6) | [ ] × 6 |
| "Testers can see bugs raised by others?" setting, Yes/No, enforced (4) | [ ] × 4 |
| Bug customization: enable/disable, add/edit/delete custom field, name/type/options, required/optional, values persisted, appears in bug forms (10) | [ ] × 10 |

### Feature: Build Settings (Feature Lists, Tester Bug Visibility, Custom Bug Fields)
Status: `[ ]`
Current implementation: none. No `Feature` model, no per-project settings row, no custom-field
concept anywhere in `api/prisma/schema.prisma`.
Missing: everything. This is a legitimately large feature area — three separate sub-features,
each needing its own schema addition:
1. `Feature` model (id, projectId, name) + `featureId` on `Bug`.
2. A `testersCanSeeOtherBugs: Boolean` field on `Project`, enforced in the bug-list query's
   `where` clause for TESTER-role callers.
3. A `CustomBugField` model (projectId, name, type, options JSON) + a `CustomBugFieldValue`
   model (bugId, fieldId, value) — this is the most involved of the three.
Relevant files: `api/prisma/schema.prisma`, `api/src/modules/projects/`, `api/src/modules/bugs/`.
Recommended change: implement #1 and #2 first (small, high-value); treat #3 (fully dynamic
custom fields) as its own follow-up given its size.

---

### 14. Organisations

| Item | Status | Evidence |
|---|---|---|
| Organisations page exists | [x] | |
| Organisation cards/list | [x] | |
| Organisation logo/icon | [x] | `Avatar` component + `logoFileId` |
| Organisation name | [x] | |
| Country | [x] | |
| Country flag where applicable | [x] | `CountryFlag` component wired in |
| Phone number | [ ] | present on the detail page but **not the list** — `OrganisationRow` interface has no `contactPhone` field |
| Email address | [x] | |
| View Details | [x] | |
| Search | [x] | real, server-side |
| Filter | [~] | status filter only; no industry/country filter despite those being displayed columns |
| Organisation permissions/tenant isolation | [x] | `assertOrgAccess` traced on both read and write paths — a customer requesting another org's id by direct API call gets 404, not data; no IDOR found |
| Organisation details page exists | [x] | |
| Organisation information displayed | [x] | full profile + record panels |
| Related projects/builds accessible per permission | [~] | only a raw project **count** is shown; no linked/filtered project list from the org page, even though the API already supports `organisationId` filtering — the web projects-list page's `searchParams` type just doesn't accept that param yet |
| Organisation can be edited by authorized users | [x] | |

**Section 14 tally: 12 [x], 2 [~], 1 [ ]**

---

### 15. Crowd Tester Directory

| Item | Status | Evidence |
|---|---|---|
| Directory exists | [x] | `web/src/app/app/admin/testers/page.tsx` |
| Tester search | [ ] | API schema supports `search`; page's `ListFilters` toolbar never wires up a search box |
| Tester filtering | [~] | status filter present; country filter accepted by the loader but has no visible UI control |
| Tester sorting | [ ] | `TESTER_SORT_FIELDS` exists API-side; page passes no `sort` and has no sortable headers |
| Tester profile can be opened | [x] | |
| Availability/assignment info available | [?] | not directly verified on the directory list itself |
| Eligibility evaluable via profile/device/skill info | [ ] | directory doesn't surface device/skill data, and (per Section 8) nothing in the assignment flow evaluates it anyway |

---

### 16. Tester Profile

| Item | Status | Evidence |
|---|---|---|
| Profile photo | [x] | `Avatar` renders a real uploaded image via `avatarFileId` when present, not just initials |
| Tester name / Email / Country / Rating | [x] all | |
| Profession | [~] | mapped to `TesterProfile.headline` (free text, labeled "Headline" not "Profession") |
| Age group | [ ] | no field anywhere on `User` or `TesterProfile` |
| Gender | [ ] | same, confirmed absent |
| City | [x] | |
| Spoken languages | [x] | `TesterLanguage` |
| Experience years | [x] | |
| Registered date | [x] | `user.createdAt`, confirmed rendered |
| Last login | [x] | `user.lastLoginAt`, confirmed rendered ("Never" fallback) |

### Feature: Tester Self-Service Portal
Status: `[ ]`
Current implementation: `web/src/app/app/tester/page.tsx` is exactly `<PortalNotReady />`.
Missing: every tester-facing screen — profile edit, photo upload, device/skill/work-history
management, bug reporting. The APIs for most of these already exist
(`PATCH /testers/me`, `/testers/me/devices`, `/testers/me/skills`, `/testers/me/languages`,
`/testers/me/work-history`) — this is overwhelmingly a frontend gap, not a backend one.
This single gap is the root cause behind roughly a third of all `[~]`/`[ ]` marks across
Sections 16, 17, 19, 20, 21 and the bug-report gap in Section 10 — closing it would upgrade
many "API exists, nothing uses it" findings to full parity in one pass.

---

### 17. Tester Assets / Devices

| Item | Status | Evidence |
|---|---|---|
| Tester Assets tab / Devices list exists | [x] | `TesterDevice` |
| Device brand / model / OS | [x] | |
| RAM | [ ] | no field on `TesterDevice` |
| Screen information | [x] | `screenSize` |
| Primary network | [ ] | no network/carrier field on `TesterDevice` at all |
| Secondary network | [ ] | same |
| Browser information | [ ] | no browser field on `TesterDevice` (only `Bug.browser`, a report-time snapshot, unrelated) |
| Device/browser info usable for tester selection | [~] | filterable only by coarse `DeviceType` enum, not OS/screen/network/browser |

---

### 18. Global Assets Management

**Confirmed 100% absent** — no `Device`, `Browser`, `OS`, or `NetworkProvider` Prisma model
exists; no `/app/admin/assets` (or devices/browsers) route anywhere.

| Item | Status |
|---|---|
| Devices: exists / brand / model / OS / network / added-by / country / search / filter / sort / manage (10) | [ ] × 10 |
| Browsers: exists / OS name / browser / version / added-by / country / search / filter / sort / manage (9) | [ ] × 9 |

### Feature: Global Assets Catalog (Devices + Browsers)
Status: `[ ]`
Missing: an admin-managed master catalog, separate from `TesterDevice` (which is free-text and
per-tester, not a controlled vocabulary). This is the same underlying gap noted in Section 4's
"Supported browsers" finding — one schema addition serves both checklist sections.
Recommended change: add `Device`/`Browser` lookup tables (brand/model/OS or OS-name/version) an
admin can manage, and have `TesterDevice` optionally reference them instead of free text (keep
the free-text fields for backward compatibility, add nullable FKs alongside).

---

### 19. Tester Skills

The `Skill` model (`name`, `slug` — no category field) is flat. Any of the legacy skill names
("BFSI", "Selenium", "iOS", "Manual Testing") *can* be added as a `Skill` row today, so
individual skill items are `[~]` (representable, un-categorized) rather than `[ ]`; the
category **structure** itself is `[ ]`.

| Item | Status |
|---|---|
| Domain Knowledge section exists (as a distinct category) | [ ] |
| Multiple domain skills supported | [~] (as flat, uncategorized skills) |
| Testing Types section (distinct category) | [ ] |
| API/Automation/Localisation/Manual/Usability Testing (5 items) | [~] × 5 |
| Testing Tools section (distinct category) | [ ] |
| Appium/Git/QTP/Selenium (4 items) | [~] × 4 |
| Applications Tested section (distinct category) | [ ] |
| Android/Desktop/iOS/Web (4 items) | [~] × 4 |
| Additional items addable in each category | [~] (addable, but not category-scoped) |

### Feature: Skill Categorization
Status: `[~]`
Current implementation: `Skill` has no `category` field; the admin UI renders all of a tester's
skills as one undifferentiated badge list.
Missing: a `category` enum (`DOMAIN`/`TESTING_TYPE`/`TOOL`/`APPLICATION`) on `Skill`, and four
grouped sections in the UI instead of one flat list.
Relevant files: `api/prisma/schema.prisma` (`Skill` model), `web/src/app/app/admin/testers/[id]/page.tsx` (Skills panel).
Recommended change: one additive enum column + a UI grouping pass — small, high-value fix.

---

### 20. Tester Work History

| Item | Status | Evidence |
|---|---|---|
| Work History tab exists | [~] | exists, but represents CV/employment history (`TesterWorkHistory`, added this session), not platform project history |
| Projects history | [ ] | no UI surfaces `ProjectAssignment` on the tester profile at all — a genuinely separate, still-missing feature from what was built |
| Contests history | [ ] | no Contest model exists platform-wide |
| Project history: icon/build/project/build-type/dates/status/bug-count (7) | [ ] × 7 | none of this is queried or rendered |
| Status examples: Assigned/Closed/extensible (3) | [~] | `AssignmentStatus` enum covers the concept, but is never surfaced on the tester profile |

### Feature: Tester Project-Assignment History
Status: `[ ]`
Current implementation: the `TesterWorkHistory` panel built this session covers prior
*employment* (company/job title/dates) — a different, legitimate concept, but not what this
checklist section means by "Project history."
Missing: a panel querying `ProjectAssignment` (joined to `Project` for name/dates/status) plus a
per-project `Bug.reportedById` count, rendered on the tester detail page.
Relevant files: `api/src/modules/testers/testers.service.ts` (`profileSelect`), `web/src/app/app/admin/testers/[id]/page.tsx`.
Recommended change: add a `projectAssignments` relation to the tester detail query and a new
"Projects worked on" panel, distinct from the existing "Work history" (CV) panel — do not
conflate or replace the CV panel, since both are legitimate, separate legacy concepts.

---

### 21. Tester Account / Finance

**Confirmed 100% absent.** No balance, credit-fund, release-fund, TDS, or payment-method
concept exists anywhere in the schema (`User`, `TesterProfile`, `Transaction` all checked).

| Item | Status |
|---|---|
| Current balance / Credit Fund / Release Fund (3) | [ ] × 3 |
| Account identifier/email / payment account-method / PayPal info (3) | [~], [ ], [ ] (identifier=email exists trivially; no payment-method or PayPal field) |
| Account History: type/amount/project-or-contest-or-bank/description/date (5) | [~] × 5 (the raw `Transaction` fields could partially support this shape, but no tester-facing or admin-side view actually renders it) |
| Finance Year filter | [ ] |
| Credited Amount / Released Amount | [ ] × 2 |
| TDS Deducted | [ ] |
| Financial info permission-restricted | [x] (transactions are permission-gated generally, though no tester-specific finance view exists to restrict) |
| Financial calculations persisted accurately | [~] (transactions themselves persist correctly; no balance/TDS calculation exists to be accurate or not) |
| Currency explicit | [x] | `Transaction.currency`, default INR |

### Feature: Tester Account / Finance Page
Status: `[ ]`
Missing: this is the largest genuinely-missing *data model* gap in the whole audit (not just a
missing UI over existing data) — TDS, credit fund, release fund, and payment method (bank vs
PayPal) have zero schema representation. Building this needs: a `tdsAmountMinor` field on
`Transaction`, a `PaymentMethod` field/model on `User` or `TesterProfile` (bank details vs
PayPal id), and either a computed "balance" (sum of earnings minus payouts) or a maintained
running total. None of this can be done as a pure frontend change.
Relevant files: `api/prisma/schema.prisma` (`Transaction`, `User`, `TesterProfile`).

---

### 22. Communication

| Item | Status | Evidence |
|---|---|---|
| Communication module exists | [x] | thread + announcement infrastructure |
| Tester selection (for sending a message) | [ ] | **no admin UI anywhere calls `POST /threads`** — admins can only reply to/close threads someone else started |
| Individual tester selection | [ ] | same root cause |
| Select All | [ ] | same |
| Search crowd testers (for messaging) | [ ] | same |
| Filter (for messaging) | [ ] | same |
| Sort by rating (for messaging) | [ ] | same |
| Message template selection | [ ] | see Section 23 |
| Subject | [x] | field exists on both threads and announcements |
| Message body | [x] | |
| Send message | [x] | real, persisted, notification side-effects |
| Sending feedback/success state | [x] | |
| Error handling | [x] | consistent `BadRequestError`/`ForbiddenError`/`NotFoundError` |
| Communication history | [x] | full thread history + announcement list |

### Feature: Bulk Tester Messaging (Broadcast)
Status: `[ ]`
Current implementation: the `Thread` model technically supports up to 50 `participantIds` per
create call (`api/src/modules/communication/communication.routes.ts:87`), so the *data model*
could support a small broadcast — but **no UI anywhere creates a thread**, admin or otherwise.
Announcements are the closest working equivalent, but are audience-enum-only (`ALL`/
`CUSTOMERS`/`TESTERS`/`ADMINS`) with **no per-tester targeting, search, filter, or rating sort**
— confirmed by inspecting the announcement-create page's only recipient control (4 radio
buttons). Legacy's core "search/filter/sort testers by rating, multi-select, blast one message"
workflow has no equivalent anywhere in the new platform.
Relevant files: `web/src/app/app/admin/communication/` (needs a new create-thread page), `api/src/modules/communication/communication.routes.ts` (already supports it).
Recommended change: build an admin thread-create page reusing the existing tester-picker pattern
already proven in the project tester-invite flow (`web/src/app/app/admin/projects/[id]/page.tsx`
"Invite testers" panel) — search/filter/sort by rating, multi-select, submit to the existing
`POST /threads` endpoint. This is a frontend-only fix; the API is ready.

---

### 23. Communication Templates

**Confirmed 100% absent** — no `MessageTemplate` model, no dropdown, no reusable subject/body
anywhere in either codebase.

| Item | Status |
|---|---|
| Template dropdown / reusable templates / selecting populates message / subject / body / create-edit / variables / permissions (9) | [ ] × 9 |

---

### 24. Reports

**Confirmed 100% absent, including navigation** — no `reports` API module directory, no
`/app/admin/reports` route, no CSV/PDF generation code anywhere. (Two false leads were checked
and ruled out: the `stats` module is live dashboard JSON, not a downloadable report; a file
named `web/src/lib/admin/csv.ts` is actually a comma-separated-string form-input parser, not an
export utility.)

| Item | Status |
|---|---|
| Reports module exists / Select Project / generation / Download (4) | [ ] × 4 |
| By Build: Start/End Build, range respected (3) | [ ] × 3 |
| By Date: Start/End date, range respected (3) | [ ] × 3 |
| Report contains relevant data / handles large datasets / download works / permission checks / error handling (5) | [ ] × 5 |

### Feature: Reports Module
Status: `[ ]`
Missing: everything — this is a from-scratch feature. Given there's no `Build` entity, "By
Build" range would need to become "by date range within a project" until/unless Section 4's
Build gap is closed.
Recommended change: given the size, treat as its own follow-up project: a `reports` API module
generating CSV (simplest first cut) from the same aggregates already proven in `stats.routes.ts`
and the bug/transaction list queries, plus a `/app/admin/reports` page with project + date-range
pickers.

---

### 25-27. Transactions (Indian / International / Pending Payments)

There is a single unified `Transaction` model and one admin transactions page — no split by
country/currency, no dedicated Pending Payments view.

`Transaction` fields (confirmed directly): `id, legacyId, reference, type, status, amountMinor,
currency (default "INR"), organisationId, projectId, counterpartyId, recordedById, description,
externalRef, occurredAt, settledAt, createdAt, updatedAt`. No TDS field, no bank/PayPal field
anywhere on `Transaction`, `User`, or `TesterProfile`.

| Item | Status | Note |
|---|---|---|
| Indian Transactions page exists | [ ] | one unified ledger, no India-specific route |
| International Transactions page exists | [ ] | same |
| Pending Payments page exists | [ ] | closest equivalent is filtering the unified list by `status=PENDING` |
| Search (on transactions) | [ ] | list query has no `search` param at all |
| Finance Year filter | [ ] | only a raw `from`/`to` date range exists, no fiscal-year grouping |
| Month filter | [ ] | same |
| Payment Method filter | [ ] | payment method doesn't exist as a concept in the schema |
| Paid Amount | [~] | a `totalsByType` aggregate exists, not filtered to `status=PAID` specifically — a small query change away |
| TDS Amount | [ ] | **missing data model field**, not just UI — confirmed via schema grep |
| Outstanding Amount | [ ] | no aggregate computes unpaid balances anywhere |
| Table: Name/Type/Amount/Date | [x] | all shown on the list |
| Table: Project/Build/Contest/Bank Details | [~] | project shown on detail page only, not the list; "Bank Details" has no field to show at all |
| Table: Summary | [?] | not directly verified |
| Credit/Debit transaction type | [~] | `TransactionType` is a 6-value enum (CUSTOMER_INVOICE/CUSTOMER_PAYMENT/TESTER_EARNING/TESTER_PAYOUT/ADJUSTMENT/REFUND), not tagged as credit-vs-debit directly, though each type is unambiguously one or the other conceptually |
| Currency supported and clearly displayed | [x] | free-form 3-char string, default INR, rendered via `formatMoney` |
| PayPal/payment account support | [ ] | **missing data model field**, confirmed |
| Tester name / Location / Month / Amount / Currency / Payment Method / Method Details (pending-payments table, 7) | [~],[~],[~],[x],[x],[ ],[ ] | name/location/amount/currency derivable from existing fields; month derivable from `occurredAt` (UI-only gap); payment method + details need new schema fields |
| Payment methods: Bank / PayPal (2) | [ ] × 2 | no schema field |
| Currencies: INR / USD / extensible (3) | [x], [x], [x] | free-text currency field accepts any code already |

### Feature: Transaction Finance Fields (TDS, Payment Method)
Status: `[ ]`
Missing: `tdsAmountMinor` on `Transaction`; a payment-method field/model (bank account details vs
PayPal id) on `User` or `TesterProfile`. This blocks Sections 25/26/27 almost entirely and is a
schema change, not a UI change.
Recommended change: additive migration adding the two fields, then a Finance-Year/Month filter
(computable purely from `occurredAt`, no schema change needed) and an India/International split
by `currency === 'INR'` (also no schema change needed — this one actually is a pure UI/query
gap once the underlying `currency` field, which already exists, is used for the split).

---

### 28. Managers

| Item | Status | Evidence |
|---|---|---|
| Managers module exists | [x] | list + detail pages, full API |
| Manager directory/workflow implemented | [x] | real search, pagination |
| Manager permissions implemented | [x] | `MANAGER_READ`/`MANAGER_WRITE` gates |
| Manager-to-project relationships implemented | [x] | `ManagerAssignment`, assign/unassign forms traced end-to-end to real Prisma writes + audit log |
| Manager actions respect role permissions | [x] | assignment endpoint validates the target user actually has ADMIN/SUB_ADMIN role before allowing assignment |

**Section 28 tally: 5 [x] — this is the most complete section in the entire audit.**

---

### 29. Contests

**Confirmed 100% absent** — no `Contest` model, enum, or reference anywhere in
`api/prisma/schema.prisma`.

| Item | Status |
|---|---|
| Contests module exists / listing / create-edit-view / participation-assignment / history-in-work-history / financial records (6) | [ ] × 6 |

---

### 30. Remote QA

**Confirmed 100% absent** — no code, no nav entry, nothing.

| Item | Status |
|---|---|
| Remote QA nav / module / workflow / permissions / verified-elsewhere (5) | [ ] × 5 |

---

### 31. Global Table Features

*(Checked across bugs, organisations, transactions, and managers list pages.)*

| Item | Status | Evidence |
|---|---|---|
| Search | [~] | present and API-backed on bugs/organisations/managers; **absent entirely** on the transactions list |
| Filter | [x] | real, API-backed selects on every page checked |
| Sorting | [ ] | confirmed absent on every page checked — `ListFilters` has no sort control, and every API route hard-codes its `orderBy` |
| Pagination | [x] | consistent, real, via shared `Pagination` component + `meta.total/page/limit` |
| Column headers | [x] | |
| Action menu/buttons | [x] | |
| Loading state | [~] | the shared `AdminListPage` handles forbidden/error/empty states; a dedicated loading spinner wasn't confirmed (Server Components rely on Next's route-level `loading.tsx`, not verified to exist) |
| Empty state | [x] | centralized in `AdminListPage`, split into filtered-no-results vs genuinely-empty copy |
| Error state | [x] | same, forbidden vs unknown-error distinguished |
| No-results state | [x] | same |
| Responsive behavior | [?] | not verified (no viewport testing performed) |
| Consistent date/time formatting | [x] | `formatDate` used uniformly |
| Consistent currency formatting | [x] | `formatMoney` used uniformly |
| Export/download | [ ] | confirmed absent on every list page checked |
| Bulk actions | [ ] | confirmed absent — no row-selection checkbox anywhere in the shared `Table` component |

### Feature: List Sorting
Status: `[ ]`
Current implementation: every checked API route (`transactions.routes.ts`, `managers.routes.ts`)
hard-codes `orderBy`, and `ListFilters.tsx` has no sort control at all — even though several
list schemas already define a `sort` param/`*_SORT_FIELDS` const that nothing ever sends.
Missing: a sort-by dropdown or clickable column headers in `ListFilters`/`Table`.
Relevant files: `web/src/components/admin/ListFilters.tsx`, `web/src/components/ds/admin/Table.tsx`, every `*.schema.ts` that already defines `*_SORT_FIELDS`.
Recommended change: this is the single most repeatable, highest-leverage UI fix in the audit —
one component change (`ListFilters`) benefits every list page in the admin panel at once, since
the API-side `sort` parameter already exists on most modules.

---

### 32. Global Form Features

| Item | Status | Evidence |
|---|---|---|
| Required fields clearly marked | [x] | `Field` component renders a visible asterisk + visually-hidden "(required)" |
| Client-side validation | [x] | real HTML5 `type`/`required` attributes alongside Zod |
| Server-side validation | [x] | `validate({ body: ... })` Zod middleware on every write route checked |
| Correct field types / dropdowns / multi-select / date fields / file upload | [x] | consistent across forms checked |
| Invalid input produces clear errors | [x] | |
| Successful submission produces clear feedback | [x] | |
| Duplicate data handled | [x] | e.g. duplicate-assignment prevention, unique constraints surfaced as friendly errors |
| Unsaved-changes warning | [ ] | confirmed absent — no `beforeunload`/dirty-tracking logic anywhere; all forms are plain server-action submits |
| Permissions enforced server-side | [x] | consistent throughout |

**Section 32 tally: 8 [x], 1 [ ]**

---

### 33. Files / Evidence

| Item | Status | Evidence |
|---|---|---|
| Test documents associated with builds | [x] | via `ProjectMaterial` |
| Screenshots uploaded to bugs | [x] | `BugAttachment` + presigned S3 flow |
| Video URLs associated with bugs | [ ] | no dedicated field; only generic file upload |
| Crash logs attached | [~] | works generically as a file upload; no crash-log-specific field/label |
| Attachments viewable/downloadable by authorized users | [x] | signed download URLs |
| File-type validation | [x] | `assertUploadAllowed` allowlist, enforced server-side on both S3 and local drivers |
| File-size validation | [x] | double-enforced (`UPLOAD_MAX_BYTES` checked in `assertUploadAllowed` **and** at the body-parser level for the local driver) |
| Secure file access | [ ] | **confirmed real gap, self-documented in the code**: the download-URL route (`api/src/modules/uploads/uploads.routes.ts:98-116`) checks only that the caller is authenticated and the file `isComplete` — no ownership/tenant check. A code comment explicitly flags this as an accepted-for-launch gap. |
| Files cannot be accessed by unauthorized tenants | [ ] | same finding — cuid unguessability is the only mitigation |

### Feature: File Download Authorization
Status: `[ ]` — **flagged as the single most severe finding in this entire audit.**
Current implementation: any authenticated user (any role, any tenant) who obtains or guesses a
file id gets a valid signed download URL, regardless of which organisation/project/bug the file
belongs to.
Relevant files: `api/src/modules/uploads/uploads.routes.ts:98-116` (the code's own comment names
the exact gap and the exact fix needed).
Recommended change: resolve the owning bug/message/material for the file id and run the same
relationship-based `authorize()` check used everywhere else, before minting the signed URL. This
should be Priority 1 — it is the one finding in this audit that is a genuine cross-tenant data
exposure, not merely a missing feature.

---

### 34. Role-Based Access Control

| Item | Status | Evidence |
|---|---|---|
| Roles: Super Admin/Admin/Manager/Tester/Client (mapped to `ADMIN`/`SUB_ADMIN`/`CUSTOMER`/`TESTER`) | [~] | reasonable mapping; "Manager" is a `SUB_ADMIN` user with `ManagerAssignment` rows rather than its own `Role` enum value — a modeling choice, not a gap, but worth recording as an approved deviation |
| Correct navigation/page/create/read/edit/delete/assignment/financial/communication/report/bug permissions per role | [~] overall | the permission catalogue and middleware are real and independently verified (not decorative) for organisations, transactions, projects, bugs; CUSTOMER/TESTER page-level access is largely unverifiable beyond the auth gate itself because their dashboards are placeholders |

### Feature: Permission Catalogue
Status: `[x]` (mechanism) / `[~]` (coverage, since two portals are placeholders)
Evidence: `api/src/config/permissions.ts`, `api/src/middleware/authorize.ts`, relationship-based
policy engine at `api/src/lib/access/policy.ts` — genuinely enforced server-side on every module
checked, not just hidden buttons.

---

### 35. Multi-Tenant Requirements

| Item | Status | Evidence |
|---|---|---|
| Tenant/organisation isolation | [x] | verified for projects, organisations, bugs — each traced to a real per-user relationship/membership check, not just a permission flag |
| Users cannot view another tenant's projects/bugs | [x] | confirmed via direct trace of `getProject`/`getOrganisation`/bug detail |
| Users cannot view another tenant's testers unless permitted | [x] | (trivially true today since `testerScope()` denies CUSTOMER entirely) |
| Users cannot access another tenant's reports/financial records | [?] | reports don't exist to test (Section 24); transactions scoping not separately re-verified in this pass beyond the general RBAC check |
| Tenant isolation enforced in backend, not just frontend | [x] | confirmed — API-level checks independent of UI |
| Direct URL access is protected | [x] | |
| Database queries are tenant-scoped | [x] | `projectScope()`/`organisationScope()` applied directly in `where` clauses |
| **File storage is tenant-scoped** | [ ] | **confirmed gap** — see Section 33's File Download Authorization finding |
| Notifications are tenant-scoped | [x] | keyed by `userId` by construction |
| Search results are tenant-scoped | [x] | list endpoints apply the same scope helpers as detail endpoints |

**Section 35 tally: 8 [x], 1 [ ], 1 [?]** — strong overall, with one confirmed real gap (files).

---

### 36. Authentication / Account

| Item | Status | Evidence |
|---|---|---|
| Login flow | [x] | |
| Logout | [x] | |
| Password handling | [x] | Argon2id, upgrade-on-login for legacy hashes |
| Password reset/recovery | [x] | fixed and verified end-to-end earlier this session |
| OAuth/social login | [x] | Google OAuth, link-or-create logic |
| Session expiration | [x] | absolute + idle TTLs |
| Unauthorized access handling | [x] | |
| Role-aware post-login routing | [x] | `ROLE_HOME` map |
| Account/profile menu | [x] | |
| User profile | [~] | full for admin; CUSTOMER/TESTER profile pages don't exist (portal placeholders) |
| Security controls (refresh rotation + reuse detection) | [x] | confirmed real: a replayed refresh token destroys the whole session, not just logged |
| Tenant-aware authentication | [x] | |

**Section 36 tally: 11 [x], 1 [~]**

---

### 37. Audit / Data Integrity

| Item | Status | Evidence |
|---|---|---|
| Audit log for important changes | [x] | `AuditLog` model + `recordAudit()` helper |
| Who created/modified a project | [x] | |
| Who assigned/removed a tester | [x] | `project.testers_assigned`/`project.assignment_updated` audit events confirmed |
| Who changed a bug / bug status/severity | [x] | confirmed call sites in `bugs.controller.ts` |
| Who changed financial records | [x] | confirmed in `transactions.routes.ts` |
| Who sent communications | [x] | confirmed in `communication.routes.ts` |
| Timestamps for important actions | [x] | |
| Historical records not accidentally overwritten | [x] | `AuditLog` is append-only, no update/delete path found |

**Section 37 tally: 9/9 [x] — every named trigger in the checklist has a matching, verified `recordAudit` call site. This is the strongest section in the entire audit.**

---

### 38. Notifications

| Item | Status | Evidence |
|---|---|---|
| In-app notifications | [x] | full CRUD, real read/unread state |
| Bug assignment/status-change notification | [x] | confirmed call sites |
| New announcement notification | [~] | thread-message fan-out confirmed; a distinct announcement-specific notification trigger was not separately confirmed |
| Tester assignment notification | [x] | confirmed |
| Communication notification | [x] | confirmed |
| Payment notification | [x] | confirmed in transactions routes |
| Report generation notification | [ ] | moot — no async report generation exists (Section 24) |
| Notification preferences | [ ] | no preference/opt-out field on the `Notification` model or any settings endpoint |
| Read/unread state | [x] | real, indexed `[userId, readAt]` |

**Section 38 tally: 6 [x], 1 [~], 2 [ ]**

---

### 39. New Platform Features (recorded per the checklist's own instruction)

- NEW-001: Ratings module (`Rating` model, subject types TESTER/CUSTOMER/PROJECT, admin
  moderation with hide/unhide rather than delete).
- NEW-002: Relationship-based access control (ReBAC) engine (`api/src/lib/access/policy.ts`) —
  more granular than legacy's presumed flat role check.
- NEW-003: Full audit log (`AuditLog`) covering every write path — no legacy equivalent
  confirmed.
- NEW-004: Session security — refresh-token rotation with reuse detection (destroys the whole
  session on replay).
- NEW-005: Country flags (via `country-flag-icons`) next to every country code across the admin
  panel.
- NEW-006: Avatar component with deterministic colored-initials fallback (organisations and
  testers) when no photo is uploaded.
- NEW-007: Show/hide password toggle on every password field, built as an isolated Client
  Component to keep the rest of the app server-rendered.
- NEW-008: Google OAuth sign-in (link-or-create by verified email).
- NEW-009: Tester work-history (CV/employment) self-service sub-resource, mirroring the
  existing device self-service pattern — a genuinely new concept, not a legacy equivalent.
- NEW-010: Forgot/reset-password self-service flow with a console-log mail driver for local
  development.

---

### 40. Legacy Parity Status

| Module | Status |
|---|---|
| Home/Dashboard | [ ] (admin-only; customer/tester placeholders) |
| Projects | [x] |
| Builds | [ ] (no entity) |
| Build Details | [~] (project-level equivalents only) |
| Build Summary | [ ] |
| Build Testers | [~] |
| Bug Management | [~] |
| Bug Details | [~] |
| Build Settings | [ ] |
| Organisations | [x] |
| Crowd Testers | [~] |
| Tester Profile | [~] |
| Tester Assets | [~] |
| Tester Skills | [~] |
| Tester Work History | [~] (CV history exists; project-assignment history does not) |
| Tester Account | [ ] |
| Global Assets | [ ] |
| Communication | [~] (1:1/thread messaging works; bulk broadcast does not) |
| Communication Templates | [ ] |
| Reports | [ ] |
| Indian Transactions | [ ] |
| International Transactions | [ ] |
| Pending Payments | [ ] |
| Contests | [ ] |
| Managers | [x] |
| Remote QA | [ ] |
| Announcements (complete workflow) | [~] |

---

### 41. Final Parity Gate

Not yet met — this is expected and correct at the audit stage. Per the task's own instructions,
implementation has not begun; this gate should be re-evaluated after Priority 1/2 items are
closed. Recorded here only to confirm it was read and is understood as the eventual completion
bar, not skipped.

---

## Top gaps by priority

### Priority 1 — Critical

1. **File download authorization has no tenant/ownership check**
   (`api/src/modules/uploads/uploads.routes.ts:98-116`) — any authenticated user can fetch a
   signed URL for any file by id. Self-documented in the code as an accepted gap; should not
   stay accepted. **This is the only finding in the audit that is an active security exposure
   rather than a missing feature.**
2. **No maximum-tester-limit enforcement** — a project can be assigned an unbounded number of
   testers; no field, no check.
3. **No tester eligibility gate on assignment** (device/OS/browser) — any VERIFIED tester can be
   assigned to any project regardless of platform fit.
4. **No tester-facing portal at all** — blocks bug reporting, evidence upload, profile
   self-service, and viewing testing instructions/announcements, even though the backing APIs
   for most of these are already built and correct.
5. **Bug classification (type + feature) has no schema support** — blocks Section 7's analytics,
   Section 9/10's bug list/detail "type"/"feature" columns, and Section 13's Feature Lists.

### Priority 2 — Major

6. ~~Bulk tester messaging (broadcast)~~ — **done**, see Implementation Pass 1 #18.
7. Reports module — 100% missing, including navigation.
8. ~~Communication Templates~~ — **done**, see Implementation Pass 1 #19.
9. ~~Global Assets (Devices/Browsers catalog)~~ — **done**, see Implementation Pass 1 #20.
10. Build Settings — ~~Feature Lists~~ and ~~tester-bug-visibility toggle~~ done (Implementation
    Pass 1 #4, #5); fully dynamic Custom Bug Fields is the one sub-feature still missing.
11. Tester Account/Finance — **balance/earnings/transaction history done**, see Implementation
    Pass 1 #21. Credit fund, release fund, TDS, and payment method remain genuinely missing at
    the schema level — those still need real schema work, not just UI.
12. Payment state entirely disconnected from the tester roster, despite `Transaction` having
    the fields needed to join it.
13. No per-project bug analytics (severity/status/reproducibility breakdown scoped to one
    project) — only platform-wide aggregates exist.

### Priority 3 — Minor / polish

14. ~~No sort control on any admin list table~~ — **done**: see Implementation Pass 1 #6.
15. ~~No export/CSV and no bulk row-actions on any list page~~ — **done**. CSV export now
    covers all 7 admin lists (see Implementation Pass 1 #7, #10, #16 — bugs, organisations,
    projects, testers, users, managers, transactions). Bulk row-actions implemented for the
    bugs list (Implementation Pass 1 #15) — the highest-traffic list and the one where
    working a queue one row at a time is the actual pain point; other lists don't have an
    equivalent "move N rows through a workflow" need.
16. No unsaved-changes warning on any form. **Done as a generic opt-in**: a tiny
    `<UnsavedChangesWarning>` client component tracks dirty state via `input`/`change`
    events on a form ref and registers a `beforeunload` listener while dirty. The browser's
    native dialog is reused — no custom modal — for unbranded, consistent wording. A
    `<TrackedForm>` wrapper is the drop-in replacement for `<form>` on the four longest
    editing forms (project edit brief, project create, organisation create, bug
    classification). Other forms can opt in by swapping `<form action={x}>` for
    `<TrackedForm action={x}>` — no other changes needed.
17. ~~Organisation list omits phone number~~ — **done**: see Implementation Pass 1 #9.
18. ~~Skill taxonomy is flat~~ — **done**: see Implementation Pass 1 #14.
19. ~~Tester device model missing RAM, network, and browser fields~~ — **done**: see
    Implementation Pass 1 #12.
20. ~~Announcements are platform-wide only, cannot be scoped to a project~~ — **done**:
    see Implementation Pass 1 #13.

---

## Approved deviations (for `checklist.md` §43)

None recorded yet — every difference found above is either a genuine gap or an open design
question (e.g., "Manager" modeled as a `SUB_ADMIN` + `ManagerAssignment` rather than a distinct
role) that should be confirmed with the project owner before being logged as an *approved*
deviation. Recommend adding the Manager-role mapping as `DEV-001` once explicitly signed off.
