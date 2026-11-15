# Which tests a change calls for (selection preview)

Runs, **After a deploy**, card **Which tests a change calls for**. A person names the pages and endpoints a release changes (or takes the
ones the platform detected) and sees which tests open or call them, and why.

**It is a recommendation only.** Nothing is run or skipped. **Automatic selection on deploys is not available:** deploy triggers,
schedules, runbooks and the CI route keep running every runnable test, exactly as before (`platform/trigger-services.ts` still queues
every runnable test). A full run stays the default; the preview only says which tests a change would call for, and when even that cannot
be worked out safely.

## What a test is mapped to

| Source | What | Where it comes from |
|---|---|---|
| Declared | pages: the address of each `navigate` step; endpoints: the method and path of each `request` step (query parameter names kept apart) | the test's **latest approved version** (what runs execute; a draft never runs), reusable steps put in place |
| Observed | pages: every address the main frame reached (page loads, `pushState` routes, hash routes); endpoints: fetch and XHR, forms sent to the server (`POST /login`), WebSockets, EventSource streams and beacons, on every host | the footprints stored with the newest runs (up to 3) of the test's **current** script on the deploy target (runs of an older script are not used) |

Nothing is taken from a test's title or description, and no AI is used.

Hosts: the application's own hosts follow the same strict rule as the API access checks (`src/shared/app-host.ts`): the application's
host on any port or scheme, a host under the application's own name (`api.shop.example` for `shop.example`; `www.` dropped, so also for
`www.shop.example`), its API base address (Settings), and hosts its own request steps name. A shared parent domain or hosting provider
proves nothing: `api.shop.example` for `app.shop.example`, `b.vercel.app` for `a.vercel.app` or `y.herokuapp.com` for `x.herokuapp.com`
are not the application's unless set as its API address. An IP address and a one-label name such as `localhost` match only by their
exact name. A change without a host, or naming one of them, matches any of them. Any other host is **external**: it is kept and shown as
such, and only a change naming that host matches it. While the API address is not set, a web test whose runs called an external endpoint
is partial (it may be the application's own API), so the preview requires a full run rather than calling it "not matched".

## URL matching

One rule set for tests and changes (written down in `src/platform/selection/coverage.ts`, compared in `preview.ts`):

- host case-insensitive, default port dropped; the scheme itself is not compared (`http`, `https`, `ws`, `wss` reach the same host);
- the path is case-sensitive (RFC 3986): `/Orders` and `/orders` are different;
- percent-encoded unreserved characters (letters, digits, `-` `.` `_` `~`) are decoded, other escapes are upper-cased; a trailing slash
  is dropped;
- ids (numbers, UUIDs, long hex, long mixed letter-and-digit ids), `{{variables}}`, `{name}`, `:name` and `*` segments become `{}`, and
  `{}` matches any one segment on either side (same number of segments), so `/products/{slug}` matches `/products/blue-shirt`;
- an endpoint change without a method (`/orders`) matches any method;
- the query is ignored unless the change names parameters (`GET /search?q`); then a test must be known to send them (a footprint keeps no
  query names, so it still matches);
- a hash route (`/app#/cart/7`) is the page `/app#/cart/{}`; its route is compared as a path. A page change without a route matches the
  page, every route of it, and a hash route equal to its path (`/cart/{id}` matches `/app#/cart/7`); a change with a route matches only
  that route of that page. A plain anchor (`#top`) is ignored;
- when the API's base address has a path (`https://shop.test/api`), `/orders` in a request step and `/api/orders` in a page's traffic are
  the same endpoint.

An entry that is not a page address or an endpoint (`mailto:`, an address with no scheme for another site, an unknown method, an address
made only of a variable) is listed as not read.

## Freshness

A web test's observed coverage counts as complete only when its **latest relevant run** vouches for it. The latest relevant run is the
newest run of the test on the **deploy target** (no browser or screen variant, no named environment: what a deploy trigger runs), whatever
its status and whether or not it kept a record; on a tie, the later attempt. Runs with a variant or a named environment are ignored, newer
or not. That run must:

1. have **passed**. A latest run that failed, ended with an error, was cancelled, skipped, timed out, stopped or has not finished makes
   the test's coverage out of date, whatever passed before it;
2. have run the test's **current version**: the latest approved version, and the current script. A newer approved version that has not
   run yet, a run not linked to any version, or code that changed after the run makes it out of date;
3. be within the **freshness window**: 14 days by default, set with `SELECTION_FRESH_DAYS` (a whole number of days from 1 to 365;
   anything else falls back to 14);
4. have left a **complete footprint**: not cut to its size limit (`truncated`), no request it could not classify (`unclassified`), at
   least one page or endpoint, and the record still stored.

Older passing runs of the current script still **add** pages and endpoints (more proposals, never fewer), but never make a test complete.
A test that has never run on the deploy target is "unknown", not "out of date". An API test's pages and endpoints come from the steps of
its approved version (they are the whole test), but it counts as complete only with a **fresh passing run** too: rules 1 to 3 apply as for
web tests; rule 4 does not, because runs of API tests keep no footprint. An API test that has never run is unknown; one whose latest run
breaks a freshness rule is out of date.

A run also stops vouching for a test when the application's address moved to another host after that run (`src/platform/selection/facts.ts`):
it touched the old address, not what runs open now, so its coverage is out of date until it runs again. Each run is judged against the
address in force when it started.

A run also stops vouching for a test when a shared part it uses (reusable steps, a shared element, a helper) changed after that run and
the project's policy approves such changes at once: the test runs with the change, but its latest run did not, so its coverage is out of
date until a run on the deploy target uses the change.

## Completeness

- **Declared complete**: an API test whose requests can all be read (no request made only of a variable, every reusable step put in place)
  and whose latest relevant run is fresh (see Freshness).
- **Observed complete**: a web test whose latest relevant run meets every freshness rule above. A record from before the footprint
  (requests only) never makes a test complete.
- **Partial**: something is known, but the test can reach more (pages opened by clicking, requests a page makes, a run that is out of
  date, a reusable step that could not be put in place). A web test is never complete, however fresh its run, when:
  - it has a **broken-links check**: the check asks for every link on its page through a channel the run's record does not see, so the
    pages it depends on are not all known;
  - it has an **access check**: that page is opened as another account in a browser of its own, which the record does not see;
  - a request step's address starts with a variable, or has a **variable inside its path whose test data value is not one path segment**
    (`/{{ordersPath}}` with `ordersPath` = `orders/list`, or empty), so the endpoint read from the step is not the one called (this also
    keeps an API test from being declared complete);
  - a run called **endpoints on another site while the application's API address is not set** (Settings): they may be the application's
    own API on a different site, so whether a change to a path reaches them is not known.
- **Unknown**: nothing reliable is known (unreadable steps, phone and desktop tests, a test that opens no address of its own and has no
  recorded run).

## Runner parity

The preview judges the tests **your** runner can run. A deploy trigger runs the tests the runner of **the person who made its token** can
run. So for every active (not revoked) deploy token of the project, the preview works out that person's runnable set the same way the
trigger does and compares it with yours:

- **same**: listed under "Deploy triggers that run the same tests as your runner";
- **different**: a full run is required, and each test in the difference gets a note ("... which cannot run this test, so its runs leave
  it out", or "... which runs this test");
- **cannot be compared**: a token made before tokens recorded who made them, a maker who no longer has an active account, a maker the
  Crowd4Test owner check refuses or cannot confirm, or a runnable set that could not be worked out (yours or theirs). A full run is
  required.

Before comparing, each token's maker goes through the same check the trigger makes before it starts a run (the Crowd4Test owner check):
whether a Crowd4Test maker is still active there and may still run tests. When Crowd4Test says no, or cannot answer, the trigger's runs
would not start as the preview describes, so the token is listed as not comparable, with why, and a full run is required.

A token made with the shared access key runs as the trigger runs it, with no person's runner.

## The preview

- **Proposed: touch a change**: a declared or observed page or endpoint is one the change names. Each reason says which change, which
  page or endpoint, declared or observed, and where it was seen (step number or run date).
- **Proposed: coverage unknown**: nothing matches, but the coverage is out of date (with the freshness rule it breaks), partial or
  unknown. A missing mapping never leaves a test out. While the change list was not read in full, complete tests are proposed here too.
- **Not matched**: only tests with complete coverage, none of it in the change, each with what its completeness rests on ("its steps",
  "the passing run of" a date).
- **Cannot run**: never hidden, each with why:
  - its stored steps cannot be read;
  - it has **no approved version** yet, so runs leave it out until one is approved;
  - it is **held back**: a shared part it uses changed after its approval and the project's policy asks for approval of such changes, so
    runs hold it back until it is approved again. This is worked out read-only (`src/platform/selection/held.ts` mirrors the run's own
    check without recording or drafting anything);
  - your runner leaves it out of runs (phone and desktop tests that need a device or a runner set up for them; a framework switched
    off, a load check, a plug-in not loaded, a hand-written test not allowed in automated runs).

### When "A full run is required"

The preview shows **A full run is required**, with each reason, when any of these holds:

- the change names more than 200 pages and endpoints (the rest are listed as not compared);
- an entry could not be read as a page or an endpoint;
- a proposed test's recorded coverage is out of date (freshness rules);
- what a proposed test touches is not fully known, matched or not;
- a test cannot run on your runner, so it was not judged (a deploy run on another runner may still run it);
- a test is **held back** (a shared part it uses changed after its approval and the project asks for approval of such changes): runs
  leave it out until it is approved again, so the deploy tests less than the project has. The reason names each held test;
- a deploy trigger's runner can run a different set of tests than yours, or cannot be compared.

A test whose steps cannot be read or that has no approved version is listed under "Cannot run" but does not by itself require a full run. A
held-back test does. Partial coverage of any proposed test (a broken-links check, a variable spanning several path segments, another
site's endpoints without an API address, and the rest above) requires a full run through "what a proposed test touches is not fully
known"; a changed application address does through "recorded coverage is out of date".

Changes no known coverage reaches are listed. The card also states the freshness window in use.

**Use detected changes** fills in what earlier jobs saw: the API drift between the last two runs with API tests
(`GET /api/projects/:id/api-changes`) and the site memory's comparison with the analysis before. These are past observations, not a
prediction of what a coming deploy changes.

## Routes

`GET /api/projects/:id/test-coverage`, `POST /api/projects/:id/selection-preview` `{ pages?, endpoints? }` (the answer carries
`fullRunRequired`, `fullRunReasons`, `triggers` and `freshDays`), `GET /api/projects/:id/selection-preview/detected-changes`. All read
only, for anyone on the project.

## Limits

- A passing web run keeps a compact footprint (about 6 KB, no bodies, credentials, cookies or pictures); a failed run keeps its full
  evidence with the same footprint. A footprint cut to its size is marked and treated as incomplete.
- API tests' observed responses are folded into one snapshot per job, not kept per test, so API coverage is declared only.
- Phone and desktop tests are not mapped yet.
- No customer source code is read; a change is named by its pages and endpoints, not by files.
- A test with branches is mapped along the path its steps and recorded runs show.
- Automatic selection stays unavailable: the preview never changes what a deploy trigger, schedule, runbook or the CI route runs.
