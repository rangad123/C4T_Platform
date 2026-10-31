# Page health checks and basic security checks

Two groups of automatic checks that need **no AI model** and appear as findings, exactly like accessibility
checks: a problem shows up as a test that **needs review**, with a severity and a plain explanation of what
is wrong and how to fix it.

- **Page health checks** open your key pages in a real browser and watch what happens: script errors, failed
  requests, broken links, insecure content and missing page basics.
- **Basic security checks** take a read-only look at your site from the outside: security headers, cookies,
  cross-origin (CORS) settings, files that should never be public, version banners and the HTTPS certificate.

Both are **on by default**. Under **Advanced options** when you start an analysis you can switch each one off
(**Page health checks**, **Basic security checks**). Page health checks belong to web testing, so that switch is
greyed out when "Web application" is off; the security checks also run for an API-only analysis.

Findings appear in the **Tests** tab in two areas, **Health checks** and **Security checks**. Open a test to
see the problem, its severity and how to fix it. A test that passes simply means nothing was found.

## Page health checks

For up to six important pages that anyone can open without signing in (the same pages the accessibility
audit uses: home, login, search, a listing, a detail page, …) one test opens the page like a visitor, waits
for it to finish loading, and checks five things. Each is its own step, and **one run reports all of them**:
a page with a script error and a broken link shows both.

| Check | What it looks for | Severity |
|---|---|---|
| Script errors | Uncaught JavaScript errors and `console.error` messages | Medium |
| Failed requests | Requests to your own site that failed or answered an error. A server error (HTTP 5xx) or a network failure is more serious than a "not found" (4xx) | High (5xx / network), Medium (4xx) |
| Broken links | Links on the page to your own site's pages that answer "not found" (404 / 410), a server error or nothing | Medium |
| Insecure content | `http://` images, scripts, styles or frames on an `https://` page | Medium |
| Page basics | A page title, the page language, a viewport setting for phones, exactly one main heading (`<h1>`) | Low |

The finding takes the severity of its worst problem.

**What is ignored (known noise).** Requests for the favicon and touch icons, browser-extension scripts, the
browser's own "Failed to load resource" lines (failed requests are reported by their own check), and common
analytics and tag-manager services (Google Analytics / Tag Manager, Hotjar, Sentry, Segment, Mixpanel and
similar). Requests to other websites are never counted as failures of yours.

**How links are checked.** Only links to your own site, de-duplicated and at most 40 per page. Anchors
(`#top`), `mailto:`, `tel:` and `javascript:` links are skipped, and so are links that look like they change
something when opened (anything containing `logout`, `sign-out`, `delete`, `remove`, `destroy`, `unsubscribe`,
`cancel` or `reset`). Each link gets a lightweight `HEAD` request; anything suspicious is confirmed with one
`GET`. Redirects count as fine (they are not followed), as do 401 and 403 (the page exists, you just can't
open it). Nothing is clicked or submitted.

**Single-page apps.** The check waits for the page to load and for the network to go quiet (at most five
seconds), not for a fixed delay.

## Basic security checks

One small group of tests per application (the site's own address), all **read-only**: `GET` requests only,
no credentials sent, no attack payloads, nothing created or changed.

| Test | What it checks | Severity |
|---|---|---|
| Browser security headers are set | `Content-Security-Policy`; protection against being shown in a frame (`X-Frame-Options` or CSP `frame-ancestors`); `X-Content-Type-Options: nosniff`; `Referrer-Policy`; on https sites also `Strict-Transport-Security` (at least six months) | Medium if the Content-Security-Policy is missing, otherwise Low |
| Session cookies are protected | Cookies the site sets that look like session cookies (name contains `sess`, `sid`, `auth`, `token`, `jwt`, `login`, `sso`) must have `HttpOnly`, `Secure` (https only) and `SameSite`. CSRF cookies are skipped because scripts must read them | Medium (HttpOnly / Secure), Low (SameSite) |
| Cross-origin access (CORS) is not wide open | Sends a harmless made-up `Origin` and checks the site does not echo it back or trust every website, especially together with credentials | High with credentials, Medium without |
| Secret and source-control files cannot be downloaded | `/.env`, `/.git/HEAD`, `/.git/config`, `/.svn/entries`, `/wp-config.php.bak`, `/.htpasswd` | Critical (`.svn` and `.htpasswd`: High) |
| Backups and server diagnostic pages cannot be downloaded | `/backup.zip`, `/.DS_Store`, `/server-status`, `/phpinfo.php` | High, Medium or Low by file |
| The server does not reveal software versions or list folders | `Server` / `X-Powered-By` banners that include a version, and "Index of /" directory listings of common folders (`/uploads/`, `/files/`, `/backup/`, `/images/`, `/assets/`) | Medium for a listing, Low for banners |
| The HTTPS certificate is valid and not about to expire (https sites only) | Trusted, issued for this host name, not expired, not expiring within 14 days | High (expired / wrong name), Medium (expiring soon / not trusted) |

**No false alarms from "200 OK".** Many single-page apps answer every address with their home page and a
success status. A sensitive file is only reported when the response has **that file's real content**: for
example `/.git/HEAD` must start with `ref:`, `/.env` must contain `KEY=value` lines and must not be an HTML page,
`/backup.zip` must start with the ZIP signature. Only the first 4 KB of a file is requested, so a real backup is
never downloaded in full.

**Plain-http sites are not blamed for HTTPS features.** `Strict-Transport-Security` and the certificate check
exist only for https. On an `http://` address they are not checked at all, and the test description says why.
(Run your real, public https site through the checks to see them.)

## How it works

- Both families are **deterministic**. No model is involved, so they work without an AI key and give the same
  answer twice.
- Each check is an ordinary test in the usual form. A health test is a web test with the steps "Open the page"
  followed by five check steps; a security test is an API-style test (`GET` requests, then a check step) with the
  category "Security checks". They are created, run and stored like every other test, can be re-run, and appear
  in the exported suite.
- **Severity** is part of each problem line. The test page shows the worst one and what it is about, e.g.
  "Critical severity: sensitive file readable by anyone."
- A finding is the same finding wherever the test runs: the first analysis, a re-run, a schedule (with its immediate retry), a deploy trigger, a runbook step and a run against an environment all call one classification (`classifyFailedRun`), so a security-headers test that was "Needs review, medium severity" is never "Validation failed" on the next run.
- A test that could not do its job (the page did not load, the site refused the connection) is reported as
  "Validation failed", not as a finding, and is not sent to the AI repair loop: there is nothing for a model to fix.
- **Downloaded scripts are normal Playwright scripts.** The helper code is written into the script, so it runs
  on its own with `npx playwright test`. Set `BASE_URL` to point it at another environment (for the health
  checks and the security checks alike). Security scripts ignore certificate errors on purpose, so a broken
  certificate does not hide all the other findings; the certificate test reports it.
- With "Include API tests that change data" nothing changes: these checks never send anything but `GET`.

## Limits

- The security checks are a **first look from outside, not a penetration test** or a compliance assessment. They
  do not try to log in, guess passwords, inject anything or scan for known vulnerabilities.
- Headers, cookies, CORS and disclosure are judged on the first page the exploration loaded successfully (usually
  the home page) and, for CORS, up to two more `GET` endpoints found on the site. A cookie set only after signing
  in is not seen.
- Only the application's own address is checked. An API on another address is not covered unless you analyze that
  address as well.
- Health checks cover pages anyone can open. Pages that need a sign-in are not checked.
- A page's behaviour **after** the first load (clicking, scrolling, timers that fire later) is not observed. A
  script error that happens only when you click something is not found.
- The "known noise" list is short and fixed. A site's own analytics endpoint on its own address is counted like
  any other request of that site.
- The link check covers at most 40 links per page and only those on the page as loaded; links added after a
  click are not seen.
- When a server blocks the platform's address (for example with a firewall that rejects automated requests), the
  checks report what that firewall answered.
- Local and private addresses are checked only if the server allows them (`BLOCK_PRIVATE_TARGETS`), exactly like
  every other target.
