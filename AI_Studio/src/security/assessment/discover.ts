/**
 * DISCOVERING: a read-only look at the application in a real browser, every request through the scope guard.
 *
 * Built from the platform's read-only discovery (src/engine/discovery: the Chromium launch, the page snapshot that reads links and forms,
 * URL normalisation and the id-folding of API paths), but stricter than the functional crawler, because this runs against a client's
 * application under a recorded authorization:
 *  - it only loads pages by address: it never clicks anything (the functional crawler opens menus and probes navigation buttons), never
 *    types, never submits a form;
 *  - the browser never reaches the network itself: every request it makes is answered by the platform through the scope guard
 *    (`Guard.fetch`, address pinned, rate-limited, counted) and handed back with `route.fulfill`. Redirects are followed by the platform,
 *    each hop checked; a 3xx is never handed to the browser, because Chromium then follows it by itself without calling the route
 *    handler (Playwright does not show redirect hops to a route handler; the tests caught a fulfilled 302 reaching an out-of-scope host);
 *  - requests that could change data (POST, PUT, PATCH, DELETE …) that a page's own script tries are blocked and listed, never sent;
 *  - WebSockets are closed (they cannot go through the guard), service workers are blocked, downloads are refused.
 */
import type { Browser, Page, Route } from "playwright";
import { launchChromium, settle } from "../../engine/discovery/browser.js";
import { normalizeApiPath } from "../../engine/discovery/network.js";
import { urlPattern } from "../../engine/discovery/crawler.js";
import { captureSnapshot } from "../../engine/discovery/snapshot.js";
import type { SecurityCall } from "../../engine/security/checks.js";
import { excludedBy } from "../scope.js";
import type { StorageState } from "../../engine/auth/storage-state.js";
import { isSignOut, judgeSignedInPage, SIGN_OUT_REASON } from "../signin-rules.js";
import { RefusedError, RequestCapError, type DiscoveryResult, type Guard } from "./types.js";

export interface DiscoverOptions {
    startUrl: string;
    excludedPaths: string[];
    apiSpecUrl: string | null;
    maxPages: number;
    maxDepth: number;
    /** Most pages sharing one address pattern (/product/{id}). */
    maxPerPattern: number;
    headless: boolean;
    signal: AbortSignal;
    onProgress?: (pagesSeen: number, current: string) => void;
    /** For tests: how the browser is started (default: the platform's Chromium). The browser is closed by this module, by its handle. */
    launch?: () => Promise<Browser>;
    /**
     * Round 20 (SIGN): signed in with a saved sign-in (already limited to the scope). It is loaded into the browser context, the browser's
     * own cookies (and the credentials a page's script adds) are passed on to the application, the signed-in page is opened first and
     * judged, and sign-out addresses are never requested (the guard refuses them). Nothing is typed, no form is submitted.
     */
    signedIn?: { storageState: StorageState; checkUrl?: string; recheckEvery?: number };
}

/**
 * Round 21: how often (in pages) a signed-in assessment checks that the saved sign-in still works: the signed-in page is opened again
 * (signed out when it answers 401/403, asks for a password or moves to a sign-in address), or, without one, the browser must still hold
 * one of the saved cookies. When it stopped working, later pages are visited signed out and the coverage says from which point.
 */
export const SIGN_IN_RECHECK_EVERY = 5;

/** Request headers a signed-in browser carries for its own session; passed on only when signed in, never kept in what is stored. */
const SESSION_HEADERS = ["cookie", "authorization", "x-csrf-token", "x-xsrf-token", "x-requested-with"];

/** Caps on what is kept (work data is stored with the assessment). */
export const DISCOVERY_CAPS = { documents: 60, documentText: 16_000, apiAnswers: 60, apiText: 2_000, apiCalls: 200, forms: 50, outOfScope: 100, excluded: 50, blockedWrites: 50, technologies: 20, failures: 50 };

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const SKIP_TYPES = new Set(["image", "media", "font"]);
/** Header on the stand-in page a refused page load gets. */
const NOT_REQUESTED = "x-passive-assessment-not-requested";
/** Links that are never loaded even when in scope: they sign out or change data on a GET (bad practice, but common). */
const DANGEROUS = /(log-?out|sign-?out|signoff|delete|remove|destroy|unsubscribe|deactivate|cancel-account|\/pay\b|checkout\/confirm|purchase)/i;
const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|map|woff2?|ttf|eot|pdf|zip|gz|tar|mp4|webm|mp3|xml|json|txt|csv|xlsx?|docx?)$/i;
/** Most bytes of one answer handed to the browser (larger answers are cut, and the page may then look broken: noted as a failure). */
const BROWSER_MAX_BYTES = 5_000_000;
/** Response headers the browser must not get from us (the body is already decoded and complete). */
const HOP_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);
/** Request headers passed on from the browser (cookies and credentials are not: the assessment visits as an anonymous visitor). */
const PASS_HEADERS = ["accept", "accept-language", "user-agent", "referer", "origin", "range", "if-none-match", "if-modified-since", "content-type"];

/** Address without fragment, trailing slash folded (as the functional crawler does), for de-duplication. */
export function pageKey(raw: string, base?: string): string | null {
    try {
        const u = new URL(raw, base);
        if (u.protocol !== "http:" && u.protocol !== "https:") return null;
        u.hash = "";
        if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
        return u.toString();
    } catch {
        return null;
    }
}

/** The scope guard's own exclusion rule (case-insensitive, decoded, doubled slashes collapsed), used to say "excluded" rather than "out of scope". */
export const isExcluded = (url: string, excludedPaths: string[]): boolean => {
    try {
        return excludedBy(new URL(url), excludedPaths) !== undefined;
    } catch {
        return false;
    }
};

const push = <T>(list: T[], item: T, cap: number) => {
    if (list.length < cap) list.push(item);
};

const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.replace(/^page\.goto: /, "").slice(0, 300);

function emptyResult(startUrl: string): DiscoveryResult {
    return { startUrl, pages: [], documents: [], apiAnswers: [], apiCalls: [], forms: [], technologies: [], outOfScope: [], excluded: [], blockedWrites: [], notVisited: 0, signInSeen: false, apiSpec: null, failures: [] };
}

/** Counts operations in an OpenAPI/Swagger document (JSON, or YAML by its indentation). Reading only: nothing in it is called. */
export function countApiOperations(text: string): number {
    const methods = /^(get|put|post|delete|options|head|patch|trace)$/i;
    try {
        const doc = JSON.parse(text) as { paths?: Record<string, Record<string, unknown>> };
        return Object.values(doc.paths ?? {}).reduce((n, ops) => n + Object.keys(ops ?? {}).filter((k) => methods.test(k)).length, 0);
    } catch {
        return (text.match(/^\s{2,8}(get|put|post|delete|options|head|patch|trace):\s*$/gim) ?? []).length;
    }
}

/**
 * Crawl the application read-only and record what was seen. Never throws for a page that fails (it is listed); throws when cancelled
 * (the signal) or when the request budget is used up (RequestCapError), after closing its browser. What was seen until then is in
 * `partial` (the same object the result would be), so the caller keeps it.
 */
export async function discover(guard: Guard, opts: DiscoverOptions, partial: DiscoveryResult = emptyResult(opts.startUrl)): Promise<DiscoveryResult> {
    const result = partial;
    const start = pageKey(opts.startUrl);
    if (!start) throw new Error("The application's address is not a web address.");
    const startOrigin = new URL(start).origin;
    let browser: Browser | undefined;
    let capHit: RequestCapError | undefined;
    /** Plain reasons for page loads that failed in the route handler (network errors), by address. */
    const loadErrors = new Map<string, string>();
    // Round 21: signed in until a re-check finds the saved sign-in no longer working; then the browser's session goes with nothing.
    let signedInNow = Boolean(opts.signedIn) && !result.signInEnded;
    /** A re-check's page load is not recorded as something the application answered (it was already judged once). */
    let rechecking = false;
    let recheckRedirect: string | undefined;
    const closeBrowser = () => browser?.close().catch(() => undefined);
    // Stop within seconds: closing the browser ends whatever page load is under way.
    opts.signal.addEventListener("abort", closeBrowser, { once: true });
    try {
        if (opts.signal.aborted) throw new Error("Assessment cancelled");
        browser = await (opts.launch ?? (() => launchChromium(opts.headless)))();
        if (opts.signal.aborted) throw new Error("Assessment cancelled");
        const context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            serviceWorkers: "block",
            acceptDownloads: false,
            javaScriptEnabled: true,
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 AITestingPlatform-PassiveAssessment/1.0",
            // Signed in: the saved cookies and local storage, as the person left them (Playwright fills local storage without a network request).
            ...(opts.signedIn ? { storageState: opts.signedIn.storageState } : {}),
        });
        context.setDefaultTimeout(8_000);
        context.setDefaultNavigationTimeout(30_000);
        await context.routeWebSocket(/.*/, (ws) => ws.close({ code: 1008, reason: "Closed by the passive assessment" }));
        await context.route("**/*", (route) => handle(route).catch(() => route.abort("failed").catch(() => undefined)));
        const seenApi = new Set<string>(result.apiCalls);

        /**
         * A request that is not sent. An aborted page load leaves Chromium loading its own error page, which then interrupts the next
         * load, so a page load gets a stand-in page (marked, never recorded as a page); everything else is aborted.
         */
        async function refuse(route: Route, why: "blocked" | "failed"): Promise<void> {
            const req = route.request();
            if (req.resourceType() === "document" && req.isNavigationRequest()) {
                return route.fulfill({ status: 200, headers: { "content-type": "text/html; charset=utf-8", [NOT_REQUESTED]: why }, body: "<!doctype html><title>Not requested</title><p>Not requested by the passive assessment.</p>" });
            }
            return route.abort(why === "blocked" ? "blockedbyclient" : "failed");
        }

        // Every request the browser makes: refused, or answered by the platform through the guard.
        async function handle(route: Route): Promise<void> {
            const req = route.request();
            const url = req.url();
            const method = req.method().toUpperCase();
            if (!/^https?:/i.test(url)) return route.continue(); // data:, blob: and the like never reach the network
            if (!READ_METHODS.has(method)) {
                push(result.blockedWrites, { method, url: url.split("?")[0]!.slice(0, 300) }, DISCOVERY_CAPS.blockedWrites);
                return refuse(route, "blocked");
            }
            if (capHit || opts.signal.aborted) return refuse(route, "blocked");
            // Pictures, video and fonts say nothing about the configuration and cost requests (the scope guard's browser default too).
            if (SKIP_TYPES.has(req.resourceType())) return route.abort("blockedbyclient");
            const headers: Record<string, string> = {};
            const sent = await req.allHeaders().catch(() => req.headers());
            for (const h of PASS_HEADERS) if (sent[h]) headers[h] = sent[h]!;
            // Signed in: the browser's own session headers go with the request (the guard drops them on a redirect to another origin).
            const session: Record<string, string> = {};
            if (opts.signedIn && signedInNow) for (const h of SESSION_HEADERS) if (sent[h]) session[h] = sent[h]!;
            let answer;
            try {
                // Redirects are followed here, each hop checked by the guard. A 3xx is never handed to the browser: Chromium follows a
                // fulfilled redirect by itself, without calling this handler again (the tests saw it reach an out-of-scope host that way).
                answer = await guard.fetch(url, { method: method as "GET" | "HEAD" | "OPTIONS", headers: { ...headers, ...session }, redirect: "follow", maxBytes: BROWSER_MAX_BYTES, signal: opts.signal, savedCookies: false });
            } catch (e) {
                if (e instanceof RequestCapError) capHit = e;
                else if (e instanceof RefusedError) noteOutOfScope(e.url, e.reason);
                else loadErrors.set(url, firstLine(e));
                return refuse(route, e instanceof RefusedError || e instanceof RequestCapError ? "blocked" : "failed");
            }
            if (answer.blockedRedirect) {
                // A re-check sent to a sign-in page outside the scope (single sign-on) has stopped working all the same.
                if (rechecking && req.resourceType() === "document") recheckRedirect = answer.blockedRedirect.url;
                noteOutOfScope(answer.blockedRedirect.url, `A redirect from ${url.split(/[?#]/)[0]!.slice(0, 200)} pointed here. ${answer.blockedRedirect.reason}`);
                return refuse(route, "blocked");
            }
            if (answer.status >= 300 && answer.status < 400) {
                loadErrors.set(url, "It redirects too many times, or to something that is not a web address.");
                return refuse(route, "failed");
            }
            const call: SecurityCall = { status: answer.status, headers: answer.headers, text: "", url: answer.url, setCookies: answer.setCookies, sent: lower(headers) };
            const type = req.resourceType();
            if (type === "document") {
                // A re-check opens the signed-in page again only to see whether the sign-in still works: it is not judged twice.
                if (!rechecking) push(result.documents, { ...call, text: answer.text.slice(0, DISCOVERY_CAPS.documentText) }, DISCOVERY_CAPS.documents);
            } else if (type === "fetch" || type === "xhr") {
                const u = new URL(url);
                const key = `${method} ${u.origin === startOrigin ? "" : u.origin}${normalizeApiPath(u.pathname)}`;
                if (!seenApi.has(key)) {
                    seenApi.add(key);
                    push(result.apiCalls, key, DISCOVERY_CAPS.apiCalls);
                    push(result.apiAnswers, { ...call, text: answer.text.slice(0, DISCOVERY_CAPS.apiText) }, DISCOVERY_CAPS.apiAnswers);
                }
            }
            for (const name of ["server", "x-powered-by", "x-aspnet-version", "x-generator"]) {
                const v = answer.headers[name];
                if (v) noteTechnology(`${name}: ${v}`);
            }
            const out: Record<string, string> = {};
            for (const [k, v] of Object.entries(answer.headers)) if (!HOP_HEADERS.has(k) && k !== "set-cookie") out[k] = v;
            if (answer.setCookies.length) out["set-cookie"] = answer.setCookies.join("\n");
            let body: Buffer | undefined = method === "HEAD" ? undefined : answer.body;
            // After a followed redirect the browser still thinks it is at the first address: a <base> keeps the page's relative links right.
            if (body && answer.redirected && type === "document" && /text\/html/i.test(answer.headers["content-type"] ?? "")) body = withBase(answer.text, answer.url);
            return route.fulfill({ status: answer.status, headers: out, body });
        }

        const page = await context.newPage();
        page.on("dialog", (d) => void d.dismiss().catch(() => undefined));
        await crawl(page);
        if (opts.apiSpecUrl && !capHit) await readApiSpec();
    } catch (e) {
        if (opts.signal.aborted) throw new Error("Assessment cancelled");
        throw e;
    } finally {
        opts.signal.removeEventListener("abort", closeBrowser);
        await closeBrowser();
    }
    if (capHit) throw capHit;
    return result;

    function noteSignOut(url: string) {
        let path = url;
        try {
            path = new URL(url).pathname;
        } catch {
            /* keep it */
        }
        const list = (result.signOutSkipped ??= []);
        if (!list.includes(path.slice(0, 200)) && list.length < 20) list.push(path.slice(0, 200));
    }

    function noteOutOfScope(url: string, reason: string) {
        if (reason.endsWith(SIGN_OUT_REASON)) return noteSignOut(url);
        const clean = url.split(/[?#]/)[0]!.slice(0, 300);
        if (isExcluded(url, opts.excludedPaths)) {
            if (!result.excluded.includes(clean)) push(result.excluded, clean, DISCOVERY_CAPS.excluded);
        } else if (!result.outOfScope.some((o) => o.url === clean)) push(result.outOfScope, { url: clean, reason }, DISCOVERY_CAPS.outOfScope);
    }

    function noteTechnology(line: string) {
        const clean = line.slice(0, 120);
        if (!result.technologies.includes(clean)) push(result.technologies, clean, DISCOVERY_CAPS.technologies);
    }

    async function crawl(page: Page): Promise<void> {
        const queue: Array<{ url: string; depth: number }> = [];
        const seen = new Set<string>(result.pages.map((p) => pageKey(p.url) ?? p.url));
        const patterns = new Map<string, number>();
        let dangerous = 0;
        const enqueue = async (raw: string, depth: number, base?: string, text?: string) => {
            const url = pageKey(raw, base);
            if (!url || seen.has(url)) return;
            seen.add(url);
            const u = new URL(url);
            if (ASSET_EXT.test(u.pathname)) return;
            // A sign-out link (by its address or its words) is never loaded, and listed as not inspected.
            if (isSignOut(u, text)) {
                noteSignOut(url);
                dangerous++;
                return;
            }
            if (DANGEROUS.test(u.pathname + u.search)) {
                dangerous++;
                return;
            }
            if (isExcluded(url, opts.excludedPaths)) return noteOutOfScope(url, "The path is excluded from the assessment.");
            const refusal = await guard.refusal(url);
            if (refusal) return noteOutOfScope(url, refusal);
            queue.push({ url, depth });
        };
        await enqueue(start!, 0);
        // Signed in: the page the person was on when saving the sign-in is opened next, and tells whether the session still works.
        const checkKey = opts.signedIn?.checkUrl ? pageKey(opts.signedIn.checkUrl) : null;
        if (checkKey) await enqueue(checkKey, 0);
        let skippedByCap = 0;
        const every = Math.max(1, opts.signedIn?.recheckEvery ?? SIGN_IN_RECHECK_EVERY);
        let lastCheckAt = result.signInConfirmedAfter ?? 0;
        while (queue.length && result.pages.length < opts.maxPages && !capHit) {
            if (opts.signal.aborted) throw new Error("Assessment cancelled");
            // Round 21: still signed in? Every few pages (never signing in again: nothing is typed, no form is submitted).
            if (signedInNow && result.pages.length - lastCheckAt >= every) {
                lastCheckAt = result.pages.length;
                await recheckSignIn(page, checkKey);
                if (capHit) break;
            }
            const next = queue.shift()!;
            const pat = urlPattern(next.url);
            if ((patterns.get(pat) ?? 0) >= opts.maxPerPattern) {
                skippedByCap++;
                continue;
            }
            patterns.set(pat, (patterns.get(pat) ?? 0) + 1);
            opts.onProgress?.(result.pages.length, next.url);
            try {
                const resp = await open(page, next.url);
                const refused = resp?.headers()[NOT_REQUESTED];
                if (refused) {
                    // Out of scope or excluded (already listed as not requested), or a network failure (listed here).
                    if (refused === "failed") push(result.failures, { url: next.url.split("?")[0]!.slice(0, 300), reason: loadErrors.get(next.url) ?? "It could not be loaded." }, DISCOVERY_CAPS.failures);
                    continue;
                }
                await settle(page, 2_000);
                const snap = await captureSnapshot(page);
                const finalUrl = page.url();
                result.pages.push({ url: finalUrl.split("#")[0]!.slice(0, 500), status: resp?.status() ?? 0, title: snap.title.slice(0, 200) });
                const generator = await page.locator('meta[name="generator" i]').first().getAttribute("content", { timeout: 500 }).catch(() => null);
                if (generator) noteTechnology(`generator: ${generator}`);
                for (const f of snap.forms) {
                    const fields = f.fields.map((x) => ({ name: (x.name ?? x.id ?? "").slice(0, 80), type: x.type.slice(0, 30) }));
                    if (fields.some((x) => x.type === "password")) result.signInSeen = true;
                    push(result.forms, { page: finalUrl.split(/[?#]/)[0]!.slice(0, 300), method: (f.method ?? "get").toUpperCase(), action: (f.action ?? "").split("?")[0]!.slice(0, 300), fields: fields.slice(0, 40) }, DISCOVERY_CAPS.forms);
                }
                if (checkKey && next.url === checkKey && !result.signedInCheck) {
                    const hasPasswordField = snap.forms.some((f) => f.fields.some((x) => x.type === "password"));
                    const v = judgeSignedInPage({ status: resp?.status() ?? 0, finalUrl, hasPasswordField }, checkKey);
                    result.signedInCheck = { url: new URL(checkKey).pathname.slice(0, 300), ok: v.ok, reason: v.reason };
                    if (v.ok) lastCheckAt = result.signInConfirmedAfter = result.pages.length;
                }
                if (next.depth < opts.maxDepth) for (const l of snap.links) await enqueue(l.href, next.depth + 1, finalUrl, l.text);
            } catch (e) {
                if (opts.signal.aborted) throw new Error("Assessment cancelled");
                if (capHit) break;
                // A refused load leaves the browser on its error page; start the next page from a blank one.
                await reset(page);
                // Refused by the guard (a redirect out of scope, an excluded path): already listed as not requested, so not a failure.
                if (/ERR_BLOCKED_BY_CLIENT/.test(firstLine(e))) continue;
                push(result.failures, { url: next.url.split("?")[0]!.slice(0, 300), reason: firstLine(e) }, DISCOVERY_CAPS.failures);
            }
        }
        result.notVisited = queue.length + skippedByCap + dangerous;
    }

    /**
     * Round 21: is the saved sign-in still working? The signed-in page (only once its first look found it signed in) is opened again and
     * judged as the first time; and the browser must still hold one of the saved cookies (an application that ends a session usually
     * removes its cookie, which also catches a signed-in page that looks the same signed out, such as a public home page). A load that
     * could not be made decides nothing. Never signs in again.
     */
    async function recheckSignIn(page: Page, checkKey: string | null): Promise<void> {
        if (checkKey && !result.signedInCheck?.ok) return;
        let verdict: { ok: boolean; reason: string } | undefined;
        let byPage = false;
        if (checkKey) {
            rechecking = true;
            recheckRedirect = undefined;
            try {
                const resp = await open(page, checkKey);
                if (resp?.headers()[NOT_REQUESTED]) {
                    // Not loaded: undecided, unless it was a redirect to a sign-in address outside the scope.
                    const moved = recheckRedirect ? judgeSignedInPage({ status: 200, finalUrl: recheckRedirect, hasPasswordField: false }, checkKey) : undefined;
                    if (moved && !moved.ok) verdict = moved;
                } else {
                    await settle(page, 1_000);
                    const snap = await captureSnapshot(page);
                    const hasPasswordField = snap.forms.some((f) => f.fields.some((x) => x.type === "password"));
                    verdict = judgeSignedInPage({ status: resp?.status() ?? 0, finalUrl: page.url(), hasPasswordField }, checkKey);
                }
                byPage = verdict !== undefined;
            } catch {
                if (opts.signal.aborted) throw new Error("Assessment cancelled");
                await reset(page);
            } finally {
                rechecking = false;
            }
        }
        if (!verdict || verdict.ok) {
            const saved = opts.signedIn?.storageState.cookies ?? [];
            const live = saved.length ? await page.context().cookies().catch(() => undefined) : undefined;
            if (live) {
                const now = Date.now() / 1000;
                const bare = (d: string) => d.replace(/^\./, "").toLowerCase();
                const held = saved.some((s) => live.some((c) => c.name === s.name && bare(c.domain) === bare(s.domain) && (c.expires <= 0 || c.expires > now)));
                if (!held) {
                    verdict = { ok: false, reason: "its cookies were removed or ran out" };
                    byPage = false;
                } else verdict ??= { ok: true, reason: "the saved cookies are still there" };
            }
        }
        if (!verdict) return;
        if (verdict.ok) {
            result.signInConfirmedAfter = result.pages.length;
            return;
        }
        // From here on nothing is sent signed in: the browser forgets the session, the guard stops adding the saved cookies.
        signedInNow = false;
        await page.context().clearCookies().catch(() => undefined);
        guard.endSignIn?.();
        result.signInEnded = {
            when: "discovery",
            afterPages: result.pages.length,
            lastOkAfterPages: result.signInConfirmedAfter ?? 0,
            url: byPage && checkKey ? new URL(checkKey).pathname.slice(0, 300) : null,
            reason: verdict.reason,
        };
    }

    async function reset(page: Page): Promise<void> {
        await page.goto("about:blank", { waitUntil: "load", timeout: 5_000 }).catch(() => undefined);
    }

    /** Load a page; once more from a blank page when the browser's own error page interrupted the load (after a refused one). */
    async function open(page: Page, url: string) {
        try {
            return await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        } catch (e) {
            if (!/interrupted by another navigation/i.test(firstLine(e)) || opts.signal.aborted) throw e;
            await reset(page);
            return await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        }
    }

    async function readApiSpec(): Promise<void> {
        const url = opts.apiSpecUrl!;
        const refusal = isExcluded(url, opts.excludedPaths) ? "The path is excluded from the assessment." : await guard.refusal(url);
        if (refusal) {
            result.apiSpec = { url, skipped: refusal };
            return;
        }
        try {
            const answer = await guard.fetch(url, { method: "GET", maxBytes: 2_000_000, signal: opts.signal, headers: { accept: "application/json, application/yaml, text/yaml, */*" } });
            result.apiSpec = { url: url.split("?")[0]!, status: answer.status, operations: answer.status < 400 ? countApiOperations(answer.text) : 0 };
            push(result.apiAnswers, { status: answer.status, headers: answer.headers, text: answer.text.slice(0, DISCOVERY_CAPS.apiText), url: answer.url, setCookies: answer.setCookies }, DISCOVERY_CAPS.apiAnswers);
        } catch (e) {
            if (e instanceof RequestCapError) capHit = e;
            result.apiSpec = { url, skipped: e instanceof RefusedError ? e.reason : `It could not be read: ${firstLine(e)}` };
        }
    }
}

/**
 * Round 21: "still signed in?" right before the read-only checks, which are plain requests carrying the saved sign-in's cookies: the
 * signed-in page is requested once more through the guard (GET, redirects followed and checked) and judged the same way as in the
 * browser (401/403, a password field, a sign-in address). Undefined when it cannot tell (refused, not loaded); throws when cancelled or
 * when the request budget is used up.
 */
export async function checkSignInPlain(guard: Guard, checkUrl: string, signal: AbortSignal): Promise<{ ok: boolean; reason: string } | undefined> {
    try {
        const a = await guard.fetch(checkUrl, { method: "GET", maxBytes: 256_000, signal, headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" } });
        if (a.blockedRedirect) {
            const moved = judgeSignedInPage({ status: 200, finalUrl: a.blockedRedirect.url, hasPasswordField: false }, checkUrl);
            return moved.ok ? undefined : moved;
        }
        if (a.status >= 300 && a.status < 400) return undefined;
        const hasPasswordField = /<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(a.text);
        return judgeSignedInPage({ status: a.status, finalUrl: a.url, hasPasswordField }, checkUrl);
    } catch (e) {
        if (e instanceof RequestCapError || signal.aborted) throw e;
        return undefined;
    }
}

/** The page with a <base href> for where it really is (only when it has none of its own). */
export function withBase(html: string, url: string): Buffer {
    if (/<base\s[^>]*href/i.test(html)) return Buffer.from(html);
    const tag = `<base href="${url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}">`;
    const head = /<head[^>]*>/i.exec(html);
    return Buffer.from(head ? html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length) : tag + html);
}

function lower(h: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}

export { emptyResult as emptyDiscovery };
