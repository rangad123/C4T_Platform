/**
 * Page speed checks: how fast a page loads, judged against budgets (no LLM).
 *
 * Same shape as the health checks: `PERF_HELPER_SOURCE` is plain JavaScript that the Playwright generator pastes
 * into every script containing a `pageSpeed` assert (so a downloaded script runs on its own), and
 * `loadPerfRuntime()` compiles the very same text for the live interpreter and for tests.
 *
 * The assert's `expected` is an optional space-separated list of overrides: "lcp:2500 fcp:1800 ttfb:800 cls:0.1
 * weight:3000000 requests:100 slow-4g". Defaults are Google's "good" Core Web Vitals thresholds (plus a page weight and
 * request-count budget). `slow-4g` throttles network and CPU (Chromium only). `signed-in` carries the session of the page
 * under test (cookies + local storage) into the fresh measurement contexts, for pages that sit behind a login
 * (see ../identity/signed-in.ts); without it the measurements are made as a visitor.
 *
 * Measuring: each of 3 fresh loads happens in its own new browser context (no cache), the median of each metric is
 * used, and the values are attached to the run as "metrics" whether or not a budget was exceeded — that is the history.
 *
 * Severity (per line, "- [severity] ..."): beyond Google's "poor" threshold -> medium; twice that -> high; over the
 * "good" budget but not "poor" -> low; page weight / request count -> always low.
 */
import type { Page } from "@playwright/test";

/** First words of every page-speed failure; the finding classifier keys on it. */
export const PERFORMANCE_FAILURE_PREFIX = "Page speed check failed:";

export const PERF_METRICS = ["ttfb", "fcp", "lcp", "cls", "load", "weight", "requests"] as const;
export type PerfMetric = (typeof PERF_METRICS)[number];

export interface PerfSample {
    metric: PerfMetric;
    value: number;
    unit: "ms" | "score" | "bytes" | "count";
    /** The budget this value was compared with (absent for metrics that have none, e.g. load time). */
    budget?: number;
}

export const PERF_GOOD = { lcp: 2500, fcp: 1800, ttfb: 800, cls: 0.1, weight: 3_000_000, requests: 100 } as const;
export const PERF_POOR = { lcp: 4000, fcp: 3000, ttfb: 1800, cls: 0.25 } as const;
export const PERF_RUNS = 3;

export const PERF_HELPER_SOURCE = String.raw`const PERF_PREFIX = ${JSON.stringify(PERFORMANCE_FAILURE_PREFIX)};
const PERF_GOOD = ${JSON.stringify(PERF_GOOD)};
const PERF_POOR = ${JSON.stringify(PERF_POOR)};
const PERF_RUNS = ${PERF_RUNS};

function perfParse(spec) {
    const budgets = Object.assign({}, PERF_GOOD);
    let throttle = false;
    for (const tok of String(spec == null ? "" : spec).split(/[\s,;]+/).filter(Boolean)) {
        if (tok.toLowerCase() === "slow-4g") { throttle = true; continue; }
        const m = /^(lcp|fcp|ttfb|cls|weight|requests)[:=]([0-9.]+)$/i.exec(tok);
        if (m) budgets[m[1].toLowerCase()] = Number(m[2]);
    }
    return { budgets, throttle };
}
function perfMedian(xs) {
    const s = xs.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}
function perfTime(ms) { return ms >= 1000 ? (ms / 1000).toFixed(1) + " s" : Math.round(ms) + " ms"; }
function perfBytes(b) { return b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB"; }

/**
 * One cold load of url in a brand-new browser context (so nothing is cached). With a signed-in session (cookies and local
 * storage captured from the test's own page) the new context starts signed in; without one it starts as a visitor.
 */
async function perfMeasure(page, url, throttle, state, ownPageHasSignInForm) {
    const browser = page.context().browser();
    const ctx = browser ? await browser.newContext({ viewport: page.viewportSize() || { width: 1280, height: 800 }, ignoreHTTPSErrors: true, ...(state ? { storageState: state } : {}) }) : page.context();
    const p = await ctx.newPage();
    try {
        if (throttle) {
            try {
                const cdp = await ctx.newCDPSession(p);
                await cdp.send("Network.enable");
                await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
                await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
            } catch (e) { /* not Chromium: measured unthrottled */ }
        }
        await p.goto(url, { waitUntil: "load", timeout: 60000 });
        await p.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
        await p.waitForTimeout(800);
        // A carried session that the app did not accept would silently measure the sign-in page instead of the page under test.
        if (state && !ownPageHasSignInForm && (await p.locator("input[type=password]:visible").count()) > 0) {
            throw new Error("The signed-in session was not accepted in a fresh browser (it showed the sign-in form instead of the page), so the speed of the page could not be measured.");
        }
        return await p.evaluate(() => new Promise((resolve) => {
            let lcp = 0, cls = 0;
            const o1 = new PerformanceObserver((l) => { for (const e of l.getEntries()) lcp = e.startTime; });
            const o2 = new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value; });
            try { o1.observe({ type: "largest-contentful-paint", buffered: true }); } catch (e) { /* unsupported */ }
            try { o2.observe({ type: "layout-shift", buffered: true }); } catch (e) { /* unsupported */ }
            // Buffered entries are delivered asynchronously; give them a moment.
            setTimeout(() => {
                const nav = performance.getEntriesByType("navigation")[0];
                const res = performance.getEntriesByType("resource");
                const fcp = performance.getEntriesByName("first-contentful-paint")[0];
                resolve({
                    ttfb: nav ? Math.max(0, nav.responseStart - nav.startTime) : null,
                    fcp: fcp ? fcp.startTime : null,
                    lcp: lcp > 0 ? lcp : null,
                    cls: cls,
                    load: nav && nav.loadEventEnd > 0 ? nav.loadEventEnd : null,
                    weight: (nav ? nav.transferSize || 0 : 0) + res.reduce((n, r) => n + (r.transferSize || 0), 0),
                    requests: res.length + 1,
                });
            }, 150);
        }));
    } finally {
        await p.close().catch(() => undefined);
        if (browser) await ctx.close().catch(() => undefined);
    }
}

/**
 * Measure the page 3 times (cold), take the median of each metric, report values through attach("metrics", json),
 * and fail with one line per metric over its budget. attach may be omitted.
 */
async function pageSpeedAssert(page, spec, attach) {
    const { budgets, throttle } = perfParse(spec);
    const url = page.url();
    // "signed-in" in the spec: carry this page's session (cookies, local storage) into every fresh measurement context.
    const signedIn = /(^|[\s,;])signed-in($|[\s,;])/i.test(String(spec == null ? "" : spec));
    const state = signedIn ? await page.context().storageState() : undefined;
    const ownPageHasSignInForm = signedIn ? (await page.locator("input[type=password]:visible").count()) > 0 : false;
    const runs = [];
    for (let i = 0; i < PERF_RUNS; i++) runs.push(await perfMeasure(page, url, throttle, state, ownPageHasSignInForm));
    const median = (k) => {
        const xs = runs.map((r) => r[k]).filter((v) => typeof v === "number" && isFinite(v));
        return xs.length ? perfMedian(xs) : null;
    };
    const UNIT = { ttfb: "ms", fcp: "ms", lcp: "ms", cls: "score", load: "ms", weight: "bytes", requests: "count" };
    const samples = [];
    for (const k of ["ttfb", "fcp", "lcp", "cls", "load", "weight", "requests"]) {
        const v = median(k);
        if (v === null) continue;
        const s = { metric: k, value: k === "cls" ? Math.round(v * 1000) / 1000 : Math.round(v), unit: UNIT[k] };
        if (budgets[k] !== undefined) s.budget = budgets[k];
        samples.push(s);
    }
    if (attach) await attach("metrics", JSON.stringify(samples));

    const sev = (k, v) => {
        if (k === "weight" || k === "requests") return "low";
        const poor = budgets[k] === PERF_GOOD[k] ? PERF_POOR[k] : budgets[k] * 1.6;
        if (v >= poor * 2) return "high";
        if (v >= poor) return "medium";
        return "low";
    };
    const WORDS = {
        lcp: (v, b) => "Main content appears after " + perfTime(v) + " (aim for under " + perfTime(b) + ")",
        fcp: (v, b) => "Nothing is shown for " + perfTime(v) + " (aim for under " + perfTime(b) + ")",
        ttfb: (v, b) => "The server takes " + perfTime(v) + " to start responding (aim for under " + perfTime(b) + ")",
        cls: (v, b) => "The layout shifts while loading, by " + v + " (aim for under " + b + ")",
        weight: (v, b) => "The page downloads " + perfBytes(v) + " (budget " + perfBytes(b) + ")",
        requests: (v, b) => "The page makes " + v + " requests (budget " + b + ")",
    };
    const lines = [];
    for (const s of samples) {
        if (s.budget === undefined || s.value <= s.budget || !WORDS[s.metric]) continue;
        lines.push("- [" + sev(s.metric, s.value) + "] " + WORDS[s.metric](s.value, s.budget));
    }
    if (lines.length === 0) return;
    throw new Error(PERF_PREFIX + " " + lines.length + (lines.length === 1 ? " measurement is" : " measurements are") + " over budget on this page (median of " + PERF_RUNS + " fresh loads" + (throttle ? ", slow 4G" : "") + ")\n" + lines.join("\n"));
}
`;

export interface PerfRuntime {
    pageSpeedAssert(page: Page, spec: string | undefined, attach?: (name: string, body: string) => Promise<void> | void): Promise<void>;
    perfParse(spec: string | undefined): { budgets: Record<string, number>; throttle: boolean };
    perfMedian(xs: number[]): number;
}

let runtime: PerfRuntime | undefined;

/** The exact helper the generated scripts carry, compiled for use inside the engine and in tests. */
export function loadPerfRuntime(): PerfRuntime {
    runtime ??= new Function(`${PERF_HELPER_SOURCE}\nreturn { pageSpeedAssert, perfParse, perfMedian };`)() as PerfRuntime;
    return runtime;
}

/** Live (interpreter) execution of a page-speed assert. */
export async function runPageSpeed(page: Page, spec: string | undefined): Promise<void> {
    await loadPerfRuntime().pageSpeedAssert(page, spec);
}

/** How to fix, in plain words (appended to a finding's reason). */
export const PERFORMANCE_ADVICE =
    "Slow server response: cache or speed up the page's backend. Slow first/main content: reduce render-blocking scripts and styles, compress and size images, and defer what is not needed first. Layout shifts: give images and embeds fixed sizes and avoid inserting content above what is already shown. Heavy pages: compress, lazy-load and remove unused code.";

export const PERFORMANCE_BASIS = "page loads slowly";

/** Severity tag worst-first, e.g. "- [high] ..." -> "high". */
export function worstPerfTag(text: string): "high" | "medium" | "low" | undefined {
    for (const s of ["high", "medium", "low"] as const) if (text.includes(`[${s}]`)) return s;
    return undefined;
}
