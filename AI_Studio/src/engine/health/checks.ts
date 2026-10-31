/**
 * Page health checks: what a page does while it loads, judged deterministically (no LLM).
 *
 * One source of truth: `HEALTH_HELPER_SOURCE` is plain JavaScript. The Playwright generator pastes it
 * verbatim into every script that contains a health assert (so a downloaded script runs on its own),
 * and `loadHealthRuntime()` compiles the very same text for the live interpreter and for tests, so
 * the script and the engine can never disagree about a failure message.
 *
 * Semantics (assert checks, none takes `expected`):
 *  - noConsoleErrors   uncaught page errors + console.error, minus known noise (favicon, browser
 *                      extensions, analytics / tag-manager hosts, "Failed to load resource" which
 *                      noFailedRequests already covers).
 *  - noFailedRequests  same-origin requests that failed (network error) or answered HTTP >= 400.
 *                      5xx is "high", 4xx "medium". Aborted requests (navigated away) are ignored.
 *  - noBrokenLinks     same-origin <a href> on the page (de-duplicated, at most 40, state-changing
 *                      looking paths such as /logout skipped) checked with HEAD (GET to confirm);
 *                      404 / 410 / 5xx / unreachable are broken, 2xx / 3xx / 401 / 403 are fine.
 *  - noMixedContent    http:// subresources on an https page (requests, blocked-content console
 *                      messages and http:// attributes in the DOM).
 *  - pageBasics        <title>, <html lang>, viewport meta, exactly one <h1> (all "low").
 * The collector must be installed before the first navigation (`installHealthCollector`).
 */
import type { Page } from "@playwright/test";

/** First words of every health failure; healthFinding keys on it. */
export const HEALTH_FAILURE_PREFIX = "Page health check failed:";

export const HEALTH_CHECKS = ["noConsoleErrors", "noFailedRequests", "noBrokenLinks", "noMixedContent", "pageBasics"] as const;
export type HealthCheck = (typeof HEALTH_CHECKS)[number];

export const isHealthCheck = (c: string): c is HealthCheck => (HEALTH_CHECKS as readonly string[]).includes(c);

/** Lines kept per failure: the runner truncates step errors at 800 characters. */
export const HEALTH_MAX_LINES = 5;
export const HEALTH_MAX_LINKS = 40;

/**
 * Self-contained, dependency-free helper. Uses only the Playwright `page` it is given.
 * Keep it free of backticks and "${": it lives in a template literal and is evaluated with `new Function`.
 */
export const HEALTH_HELPER_SOURCE = String.raw`const HEALTH_PREFIX = ${JSON.stringify(HEALTH_FAILURE_PREFIX)};
const HEALTH_MAX_LINES = ${HEALTH_MAX_LINES};
const HEALTH_MAX_LINKS = ${HEALTH_MAX_LINKS};
// Known noise: not the application's own defects.
const HEALTH_NOISE_URL = /favicon\.ico|apple-touch-icon|\/\.well-known\/|(?:chrome|moz|safari)-extension:|google-analytics|googletagmanager|doubleclick|googlesyndication|connect\.facebook|facebook\.net|hotjar|clarity\.ms|segment\.(?:io|com)|sentry\.io|mixpanel|amplitude|fullstory|newrelic|nr-data\.net|datadoghq|plausible\.io|matomo|cloudflareinsights/i;
const HEALTH_NOISE_TEXT = /^Failed to load resource|(?:chrome|moz|safari)-extension:|ResizeObserver loop|^Script error\.?$/i;
// Links that look like they change state when fetched are never requested.
const HEALTH_RISKY_PATH = /(?:^|[\/_-])(?:log-?out|sign-?out|delete|remove|destroy|unsubscribe|cancel|reset)(?:$|[\/._?-])/i;

/** Start collecting. Call once, before the first navigation of the page. */
function installHealthCollector(page, origin) {
    const state = { origin, errors: [], failed: [], insecure: [] };
    const isSameOrigin = (u) => { try { return new URL(u).origin === origin; } catch (e) { return false; } };
    const where = (u) => { try { const p = new URL(u); return p.pathname + p.search; } catch (e) { return String(u); } };
    page.on("pageerror", (e) => {
        const text = String((e && e.message) || e || "");
        const stack = String((e && e.stack) || "");
        if (HEALTH_NOISE_TEXT.test(text) || HEALTH_NOISE_URL.test(stack)) return;
        state.errors.push({ kind: "Uncaught error", text });
    });
    page.on("console", (m) => {
        const text = m.text();
        if (m.type() !== "error") return;
        const mixed = /Mixed Content: .*?requested an insecure [\w -]+ '([^']+)'/.exec(text);
        if (mixed) { state.insecure.push(mixed[1]); return; }
        const loc = m.location();
        if (HEALTH_NOISE_TEXT.test(text) || (loc && loc.url && HEALTH_NOISE_URL.test(loc.url))) return;
        state.errors.push({ kind: "console.error", text });
    });
    page.on("response", (r) => {
        const url = r.url();
        if (r.status() < 400 || !isSameOrigin(url) || HEALTH_NOISE_URL.test(url)) return;
        state.failed.push({ method: r.request().method(), status: r.status(), where: where(url) });
    });
    page.on("requestfailed", (r) => {
        const url = r.url();
        const reason = (r.failure() && r.failure().errorText) || "network error";
        if (!isSameOrigin(url) || HEALTH_NOISE_URL.test(url) || /ERR_ABORTED|NS_BINDING_ABORTED|cancelled|Load request cancelled/i.test(reason)) return;
        state.failed.push({ method: r.method(), status: 0, where: where(url), reason });
    });
    page.on("request", (r) => {
        const url = r.url();
        if (/^http:\/\//i.test(url) && r.resourceType() !== "document") state.insecure.push(url);
    });
    return state;
}

function healthClip(s, n) {
    const t = String(s).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 3) + "..." : t;
}
function healthPlural(n, one, many) { return n + " " + (n === 1 ? one : many || one + "s"); }

/** One failure: a headline plus at most HEALTH_MAX_LINES "- [severity] detail" lines. */
function healthFail(headline, lines) {
    const shown = lines.slice(0, HEALTH_MAX_LINES);
    if (lines.length > shown.length) shown.push("- ...and " + (lines.length - shown.length) + " more");
    throw new Error(HEALTH_PREFIX + " " + headline + "\n" + shown.join("\n"));
}

async function healthSettle(page) {
    await page.waitForLoadState("load");
    // Single-page apps keep fetching after "load": wait for the network to go quiet, but never for long.
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
}

async function healthLinkStatus(page, url) {
    const opts = { maxRedirects: 0, failOnStatusCode: false, timeout: 10000 };
    try {
        let res = await page.request.head(url, opts);
        // Some servers answer HEAD badly: confirm anything suspicious with a GET before calling it broken.
        if (res.status() >= 400) res = await page.request.get(url, opts);
        return res.status();
    } catch (e) {
        return 0;
    }
}

async function healthLinks(page, origin) {
    const anchors = await page.$$eval("a[href]", (els) => els.map((a) => ({ raw: (a.getAttribute("href") || "").trim(), href: a.href })));
    const seen = new Set();
    const out = [];
    for (const { raw, href } of anchors) {
        // In-page anchors (#top) and non-http schemes (mailto:, tel:, javascript:) are not links to check.
        if (!raw || raw.startsWith("#")) continue;
        let u;
        try { u = new URL(href); } catch (e) { continue; }
        if (!/^https?:$/.test(u.protocol) || u.origin !== origin) continue;
        u.hash = "";
        const key = u.toString();
        if (seen.has(key) || HEALTH_RISKY_PATH.test(u.pathname)) continue;
        seen.add(key);
        out.push(key);
    }
    return out.slice(0, HEALTH_MAX_LINKS);
}

/** Run one health check against what the collector has seen. Throws "<prefix> ..." when it fails. */
async function healthAssert(page, health, check) {
    await healthSettle(page);
    if (check === "noConsoleErrors") {
        const seen = new Set();
        const errs = health.errors.filter((e) => { const k = e.kind + e.text; if (seen.has(k)) return false; seen.add(k); return true; });
        if (errs.length === 0) return;
        healthFail(healthPlural(errs.length, "JavaScript error") + (errs.length === 1 ? " was" : " were") + " reported on this page",
            errs.map((e) => "- [medium] " + e.kind + ": " + healthClip(e.text, 140)));
    } else if (check === "noFailedRequests") {
        const byKey = new Map();
        for (const f of health.failed) {
            const k = f.method + " " + f.status + " " + f.where;
            const hit = byKey.get(k);
            if (hit) hit.n++; else byKey.set(k, { ...f, n: 1 });
        }
        const list = [...byKey.values()].sort((a, b) => (b.status >= 500) - (a.status >= 500));
        if (list.length === 0) return;
        healthFail(healthPlural(list.length, "request") + " to this site failed",
            list.map((f) => "- [" + (f.status >= 500 || f.status === 0 ? "high" : "medium") + "] " + f.method + " " + healthClip(f.where, 100) + " " +
                (f.status ? "returned HTTP " + f.status : "failed (" + healthClip(f.reason || "network error", 40) + ")") + (f.n > 1 ? " (" + f.n + " times)" : "")));
    } else if (check === "noBrokenLinks") {
        const urls = await healthLinks(page, health.origin);
        const bad = [];
        let next = 0;
        const worker = async () => {
            while (next < urls.length) {
                const url = urls[next++];
                const status = await healthLinkStatus(page, url);
                if (status === 404 || status === 410 || status >= 500 || status === 0) bad.push({ url, status });
            }
        };
        await Promise.all(Array.from({ length: Math.min(6, urls.length) }, worker));
        if (bad.length === 0) return;
        bad.sort((a, b) => a.url.localeCompare(b.url));
        healthFail(healthPlural(bad.length, "link") + " on this page " + (bad.length === 1 ? "is" : "are") + " broken (checked " + urls.length + ")",
            bad.map((b) => { const p = new URL(b.url); return "- [medium] " + healthClip(p.pathname + p.search, 100) + " " + (b.status ? "returned HTTP " + b.status : "could not be reached"); }));
    } else if (check === "noMixedContent") {
        if (!/^https:/i.test(page.url())) return;
        const dom = await page.evaluate(() => {
            const attrs = [["img[src]", "src"], ["script[src]", "src"], ["iframe[src]", "src"], ["audio[src]", "src"], ["video[src]", "src"], ["source[src]", "src"], ["embed[src]", "src"], ["object[data]", "data"], ["link[rel~=stylesheet][href]", "href"]];
            const found = [];
            for (const [sel, attr] of attrs) for (const el of document.querySelectorAll(sel)) { const v = el.getAttribute(attr) || ""; if (/^http:\/\//i.test(v)) found.push(v); }
            return found;
        });
        const urls = [...new Set([...health.insecure, ...dom])].filter((u) => !HEALTH_NOISE_URL.test(u));
        if (urls.length === 0) return;
        healthFail(healthPlural(urls.length, "insecure (http://) resource") + (urls.length === 1 ? " is" : " are") + " loaded on this secure page",
            urls.map((u) => "- [medium] " + healthClip(u, 120)));
    } else if (check === "pageBasics") {
        const info = await page.evaluate(() => ({
            title: document.title.trim(),
            lang: (document.documentElement.getAttribute("lang") || "").trim(),
            viewport: !!document.querySelector('meta[name="viewport" i]'),
            h1: document.querySelectorAll("h1").length,
        }));
        const lines = [];
        if (!info.title) lines.push("- [low] The page has no title (the <title> tag is missing or empty)");
        if (!info.lang) lines.push("- [low] The page does not declare its language (<html lang> is missing)");
        if (!info.viewport) lines.push("- [low] There is no viewport setting, so phones may show a shrunken desktop page");
        if (info.h1 === 0) lines.push("- [low] The page has no main heading (<h1>)");
        if (info.h1 > 1) lines.push("- [low] The page has " + info.h1 + " main headings (<h1>); it should have one");
        if (lines.length === 0) return;
        healthFail(healthPlural(lines.length, "basic detail") + " missing or wrong on this page", lines);
    } else {
        throw new Error("Unknown health check: " + check);
    }
}
`;

export interface HealthCollector {
    origin: string;
    errors: unknown[];
    failed: unknown[];
    insecure: string[];
}

export interface HealthRuntime {
    installHealthCollector(page: Page, origin: string): HealthCollector;
    healthAssert(page: Page, health: HealthCollector, check: HealthCheck): Promise<void>;
}

let runtime: HealthRuntime | undefined;

/** The exact helper the generated scripts carry, compiled for use inside the engine and in tests. */
export function loadHealthRuntime(): HealthRuntime {
    runtime ??= new Function(`${HEALTH_HELPER_SOURCE}\nreturn { installHealthCollector, healthAssert };`)() as HealthRuntime;
    return runtime;
}

const collectors = new WeakMap<Page, HealthCollector>();

/**
 * Live (interpreter) execution of a health assert. A page already navigated has missed its own load
 * events, so the first health assert installs the collector and reloads the page once to observe it.
 */
export async function runHealthCheck(page: Page, check: HealthCheck): Promise<void> {
    const rt = loadHealthRuntime();
    let collector = collectors.get(page);
    if (!collector) {
        // Let whatever the page is still loading finish first, so those events are not counted twice.
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
        collector = rt.installHealthCollector(page, new URL(page.url()).origin);
        collectors.set(page, collector);
        await page.reload({ waitUntil: "load" });
    }
    await rt.healthAssert(page, collector, check);
}

/** Severity tag worst-first, e.g. "- [high] ..." -> "high". */
export function worstTag(text: string): "critical" | "high" | "medium" | "low" | undefined {
    for (const s of ["critical", "high", "medium", "low"] as const) if (text.includes(`[${s}]`)) return s;
    return undefined;
}

/** What each check looks for and how to fix it, in plain words (appended to a finding's reason). */
export const HEALTH_ADVICE: Record<HealthCheck, string> = {
    noConsoleErrors: "Open the page with the browser's developer console (F12) to see the error, then fix the script that throws it.",
    noFailedRequests: "Check the listed addresses: fix the server error or remove/repair the request the page makes to them.",
    noBrokenLinks: "Fix or remove the listed links so visitors do not land on a missing page.",
    noMixedContent: "Load these resources over https:// (or relative URLs); browsers block or warn about insecure content on secure pages.",
    pageBasics: "Add the missing basics to the page's HTML; they help search engines, screen readers and phones.",
};

/** Short basis shown next to the severity, keyed by the check that produced the worst problem. */
export const HEALTH_BASIS: Record<HealthCheck, string> = {
    noConsoleErrors: "JavaScript error on the page",
    noFailedRequests: "request to the site failed",
    noBrokenLinks: "broken link",
    noMixedContent: "insecure content on a secure page",
    pageBasics: "missing page basics",
};

/** Which check a failure message came from, judged by its headline (used when no spec is at hand). */
export function healthCheckOf(message: string): HealthCheck | undefined {
    if (/JavaScript errors? (?:was|were) reported/.test(message)) return "noConsoleErrors";
    if (/requests? to this site failed/.test(message)) return "noFailedRequests";
    if (/links? on this page (?:is|are) broken/.test(message)) return "noBrokenLinks";
    if (/insecure \(http:\/\/\) resources? (?:is|are) loaded/.test(message)) return "noMixedContent";
    if (/basic details? missing or wrong/.test(message)) return "pageBasics";
    return undefined;
}
