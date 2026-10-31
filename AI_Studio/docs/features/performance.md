# Speed checks: pages and API endpoints

Loads your key pages the way a first-time visitor would and tells you which ones are slow, with the numbers. **Off by default**
(timings depend on the machine and network, and each page is loaded four times), so tick **Page speed checks** under
*Advanced options* when you start an analysis. A test can also be imported by hand (see below).

## What is measured
For each of up to five key pages that anyone can open, one test loads the page **three times from scratch** (a fresh browser
context each time, so nothing is cached) and takes the **median** of each value, which damps one-off spikes:

| Measure | Plain meaning | Default budget |
|---|---|---|
| Server starts responding (TTFB) | How long until the server begins answering | 0.8 s |
| First content appears (FCP) | Time until anything is drawn | 1.8 s |
| Main content appears (LCP) | Time until the biggest element is drawn | 2.5 s |
| Layout stability (CLS) | How much the page jumps while loading | 0.1 |
| Page size | Bytes downloaded | 3 MB |
| Requests made | Number of requests | 100 |
| Page finished loading | The load event | (recorded, no budget) |

The first four defaults are Google's "good" Core Web Vitals thresholds. A measurement over its budget is a **finding** ("Needs
review") that says what it measured and what to aim for, e.g. *"Main content appears after 3.4 s (aim for under 2.5 s)"*, plus how to fix it.

**Severity:** over "poor" (LCP 4 s, FCP 3 s, TTFB 1.8 s, CLS 0.25) → *medium*; twice that → *high*; over the budget but under "poor" → *low*;
page size and request count → always *low*. With a custom budget, "poor" is 1.6× that budget.

## API response times
The same option (**Speed checks**) also times up to **8 safe GET endpoints** of the API: endpoints that can be called with what the description
or the observed traffic provides (no path parameter without an example; never POST, PUT, PATCH or DELETE). For each one the test sends
**one warm-up request (not counted) and then 10 measured requests, strictly one after another**, and compares the 95th percentile with a budget
(default **1 s**). This is a latency check, **not load testing**: an endpoint never receives two requests at once from a test, and the check
**stops at once** if the endpoint answers HTTP 429 (rate limited, reported as *low*: "could not be measured") or 5xx (reported as *high*).
Different endpoints may be checked at the same time.

Severity: over budget by less than 1.5× → low; 1.5× or more → medium; 3× or more → high. The typical (median), 95th-percentile and slowest
times are recorded for every run, also when within budget, and shown in a *Response speed* card on the test page.

Budget overrides use the same field as page speed: `p95:500 p50:200 max:2000 runs:15` (runs between 3 and 30). In an imported spec, a request step followed by
`{ "action": "assertResponse", "check": "latency", "expected": "p95:500" }` repeats that request.

## Seeing the results
- **Test page:** a *Page speed* card with each value, its budget, *Within budget* / *Over budget* in words, and a small history line
  once the test has run more than once. Values are kept for every run, also when within budget.
- **Project Overview:** a *Slowest pages* list, worst first.

## Custom budgets and slow networks
The speed step's `expected` is a space-separated list: `lcp:3000 fcp:2000 ttfb:600 cls:0.05 weight:5000000 requests:80 slow-4g`.
`slow-4g` throttles network and CPU (Chromium only). From the API, pass `performanceBudgets` next to `performanceChecks: true` when starting an
analysis. In an imported spec:

```json
{ "title": "Home loads quickly", "kind": "web", "type": "performance", "source": { "origin": "performance-check" },
  "steps": [ { "action": "navigate", "url": "/" }, { "action": "assert", "check": "pageSpeed", "expected": "lcp:3000" } ] }
```

## API
`GET /api/tests/:id/performance` → `{ latest, history }` (up to 20 runs); `GET /api/projects/:id/performance` → `{ slowest }`.

## How it works
`src/engine/performance/`: `latency.ts` is the API counterpart (helper, endpoint selection, finding classification); `checks.ts` holds one plain-JavaScript helper that is pasted into the generated script (so a downloaded
script runs on its own) and compiled for the live interpreter; `specs.ts` generates the tests and classifies a failure as a finding (its
messages start with "Page speed check failed:" and carry a `[severity]` per line, like the other check families). Measured values travel
as a `metrics` attachment and are stored in `perf_metrics` (migration 6).

## Limits
- Timings from one machine are indicative. Compare a page with itself over time rather than across machines.
- **Not built:** a UI field for budgets (use the API or an imported spec), and latency checks for endpoints that change data.
- Only anonymous pages are measured; the first load of a freshly started server can be slower than later ones.
