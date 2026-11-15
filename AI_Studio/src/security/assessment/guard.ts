/**
 * The assessment's `Guard` on top of CORE's scope guard (../scope.ts): one ScopeSession per assessment holds the rate limit, the request
 * and byte budgets and the stop switch; every request goes through `guardedFetch` (address checked and pinned, each redirect hop checked
 * again). This file only translates: the guard's refusals become RefusedError / RequestCapError, and answers get their text.
 *
 * Why discovery does not use `browserRouteGuard` as it is: the assessment must see what the browser received (headers, cookies, the
 * page text) to judge it, and that handler hands answers to the browser without telling anyone. Discovery's own route handler
 * (./discover.ts) applies the same rules through this Guard (guardedFetch, redirects followed on the platform side with each hop
 * checked), so the scope rules, the pinning, the rate limit and the budgets are the same; it also asks for uncompressed answers so the
 * text can be read. It never hands a 3xx to the browser: Chromium follows a fulfilled redirect by itself, without the route handler.
 *
 * Every request also leaves through the request guard the external scanners use (../egress/guard.ts): the scope session above checks
 * it first, then hands it to a guard on 127.0.0.1 started for this assessment, which checks it again (GET/HEAD/OPTIONS, scope,
 * exclusions, rate, budget) and sends it. Both kinds of refusal go into one request log (../egress/request-log.ts) attributed
 * "platform:<check family>", the same log shape as a scanner's "scanner:<id>". There is no direct way out: when that guard cannot start,
 * nothing is sent and the step fails with a plain sentence. The one exception is the TLS handshake that reads the certificate
 * (scan.ts observeTls): it is not an HTTP request, the guard cannot carry it, and it is logged as a "TLS" entry. It is narrow by
 * construction: only to `tlsTarget` (the application's own host and port, fixed here), only while this guard is up, no HTTP bytes.
 */
import http from "node:http";
import type { SecurityApplication } from "../contract.js";
import { addressClass, createScopeSession, guardedFetch, ScopeError, sessionOptionsFrom, type ScopeEvent, type ScopeProxy, type ScopeSession, type ScopeSessionOptions } from "../scope.js";
import { startEgressGuard, type EgressGuard } from "../egress/guard.js";
import { GUARD_MARK_HEADER, RequestLog, SOURCE_HEADER } from "../egress/request-log.js";
import { SecurityProxy, securityProxyFor } from "../proxy.js";
import type { StorageState } from "../../engine/auth/storage-state.js";
import { cookieHeaderFor, isSignOut, SIGN_OUT_REASON } from "../signin-rules.js";
import type { SecuritySettings } from "../settings.js";
import { RefusedError, RequestCapError, type Guard, type GuardedAnswer, type GuardFetchInit } from "./types.js";

const CAP_CODES = new Set(["request-limit", "byte-limit"]);

function translate(e: unknown, url: string): unknown {
    if (!(e instanceof ScopeError)) return e;
    if (CAP_CODES.has(e.code)) return new RequestCapError(e.message);
    if (e.code === "stopped") return new Error("Assessment cancelled");
    return new RefusedError(e.url ?? url, e.message, e.code);
}

/** The request guard could not start: nothing is sent. */
export class GuardDownError extends Error {
    constructor(why: string) {
        super(`The platform's request guard could not be started (${why.split("\n")[0]!.slice(0, 160)}), so nothing was sent to the application.`);
        this.name = "GuardDownError";
    }
}

export interface AssessmentGuard extends Guard {
    session: ScopeSession;
    requestLog(): RequestLog;
    close(): Promise<void>;
    /** Redirects that pointed outside the scope and were not followed (for the coverage list). */
    blockedRedirects: Array<{ url: string; reason: string }>;
}

/**
 * Round 20 (SIGN): a signed-in assessment. `state` is the saved sign-in limited to the scope (../signin.ts): its cookies are added to
 * plain requests the way a browser would (never when the caller passes its own Cookie header, as the browser does), and the scope guard
 * drops them on a redirect to another origin. `refuseSignOut` makes every sign-out-looking address (also a redirect hop) a refusal.
 */
export interface GuardSignIn {
    state?: StorageState;
    refuseSignOut?: boolean;
    /** The check family requests are attributed to in the request log when the call names none ("platform:<family>"). Default "checks". */
    source?: string;
}

/** One guard per assessment. `extra` lets tests pass a DNS resolver or a clock. */
export function guardFor(app: SecurityApplication, settings: SecuritySettings, signal: AbortSignal, extra: Partial<ScopeSessionOptions> = {}, signIn: GuardSignIn = {}): AssessmentGuard {
    const blockedRedirects: AssessmentGuard["blockedRedirects"] = [];
    const onEvent = (e: ScopeEvent) => {
        if (e.type === "blocked" && e.via === "redirect" && blockedRedirects.length < 50) blockedRedirects.push({ url: e.url.split(/[?#]/)[0]!.slice(0, 300), reason: e.reason });
        extra.onEvent?.(e);
    };
    // SECURITY_USE_PROXY: the company proxy from the platform's environment (tests pass their own in `extra.proxy`).
    const proxy = extra.proxy ?? securityProxyFor(settings);
    const opts: ScopeSessionOptions = { ...sessionOptionsFrom(settings), ...extra };
    const log = new RequestLog();
    const family = signIn.source ?? "checks";
    // The request guard, started once on first use (or by ready()); it carries the company proxy, when there is one.
    let started: Promise<EgressGuard> | undefined;
    const start = () =>
        (started ??= (async () => {
            try {
                await proxy?.ready();
                return await startEgressGuard({
                    app,
                    allowPrivate: opts.allowPrivate === true,
                    ...(opts.maxRequests ? { maxRequests: opts.maxRequests } : {}),
                    signal,
                    ...(opts.resolver ? { resolver: opts.resolver } : {}),
                    source: "platform",
                    log,
                    allowInvalidCertificate: true,
                    session: { ...(proxy ? { proxy } : {}), ...(opts.maxResponseBytes ? { maxResponseBytes: opts.maxResponseBytes } : {}), ...(opts.maxTotalBytes ? { maxTotalBytes: opts.maxTotalBytes } : {}) },
                });
            } catch (e) {
                throw new GuardDownError(e instanceof Error ? e.message : String(e));
            }
        })());
    const close = async () => {
        const g = await started?.catch(() => undefined);
        await g?.close();
    };
    signal.addEventListener("abort", () => void close(), { once: true });
    // The scope session's way out: every request, absolute form, to the guard (plain HTTP on 127.0.0.1; it makes the TLS connection).
    const viaGuard: ScopeProxy = {
        ready: async () => void (await start()),
        async targetProblem(d) {
            const g = await start();
            const port = Number(d.url.port) || (d.url.protocol === "https:" ? 443 : 80);
            return addressClass(d.address) === "loopback" && port === g.port ? `${d.url.origin} is the platform's request guard itself; it is never assessed.` : undefined;
        },
        async route(d) {
            const g = await start();
            const target = new URL(d.url.href);
            target.hash = "";
            return {
                lib: http,
                options: { hostname: "127.0.0.1", port: g.port, path: target.href, agent: false },
                headers: { host: d.url.host },
                // The guard's own answer, never the site's. A failure keeps the network's words ("socket hang up", ECONNRESET), so the
                // checks' retry of dropped connections behaves as it did on a direct connection.
                checkAnswer: (status, h, body) => {
                    if (!h[GUARD_MARK_HEADER]) return undefined;
                    const words = body.toString("utf8").split("\n")[0]!.slice(0, 300);
                    return h[GUARD_MARK_HEADER] === "failed" ? words || `The request could not be completed (HTTP ${status}).` : `The platform's request guard refused this request (HTTP ${status}): ${words}`;
                },
            };
        },
    };
    const session = createScopeSession(app, { ...opts, proxy: viaGuard, signal, onEvent });
    if (signIn.refuseSignOut) {
        // Every address the guard checks (page loads, script requests, each redirect hop, plain requests) passes here first.
        const check = session.checkUrl.bind(session);
        session.checkUrl = async (raw) => {
            const d = await check(raw);
            return d.allowed && isSignOut(d.url) ? { allowed: false, url: d.url.href, code: "excluded-path", reason: SIGN_OUT_REASON } : d;
        };
    }
    // Round 21: once a re-check found the saved sign-in no longer working, nothing more is sent with its cookies.
    let signInEnded = false;
    const withSavedCookies = (url: string, init: GuardFetchInit): Record<string, string> | undefined => {
        if (!signIn.state || signInEnded || init.savedCookies === false || Object.keys(init.headers ?? {}).some((k) => k.toLowerCase() === "cookie")) return init.headers;
        const cookie = cookieHeaderFor(signIn.state, url);
        return cookie ? { ...init.headers, cookie } : init.headers;
    };
    const target = new URL(app.targetUrl);
    const tlsTarget = Object.freeze({ host: target.hostname.replace(/^\[|\]$/g, "").toLowerCase(), port: target.protocol === "https:" ? Number(target.port) || 443 : 443 });
    return {
        session,
        blockedRedirects,
        tlsTarget,
        async ready() {
            await start();
        },
        requestLog: () => log,
        close,
        note(e) {
            log.note(`platform:${e.source ?? family}`, e.method, e.url, e.verdict, e.reason);
        },
        async tunnel(url, sig) {
            if (!(proxy instanceof SecurityProxy)) return undefined;
            const d = await session.checkUrl(url);
            if (!d.allowed) throw new RefusedError(d.url, d.reason, d.code);
            return proxy.tunnel(d, sig, session.options.timeoutMs);
        },
        async refusal(url) {
            const d = await session.checkUrl(url);
            return d.allowed ? undefined : d.reason;
        },
        async fetch(url: string, init: GuardFetchInit = {}): Promise<GuardedAnswer> {
            const source = `platform:${init.source ?? family}`;
            const method = init.method ?? "GET";
            try {
                const r = await guardedFetch(session, url, { method, headers: { ...withSavedCookies(url, init), [SOURCE_HEADER]: source }, followRedirects: init.redirect !== "manual", maxBytes: init.maxBytes, allowInvalidCertificate: true });
                // A redirect the scope session did not follow never reached the guard: it is logged here.
                if (r.blockedRedirect) log.note(source, method, r.blockedRedirect.url, "refused", r.blockedRedirect.reason);
                return {
                    url: r.url,
                    status: r.status,
                    headers: r.headers,
                    setCookies: r.setCookies,
                    body: r.body,
                    text: r.body.toString("utf8"),
                    redirected: r.redirects.length > 0,
                    blockedRedirect: r.blockedRedirect ? { url: r.blockedRedirect.url, reason: r.blockedRedirect.reason } : null,
                };
            } catch (e) {
                // Refused before the guard saw it (scope, method, a cap) or the guard is down: logged with the platform's attribution.
                if ((e instanceof ScopeError && e.code !== "stopped") || e instanceof GuardDownError) log.note(source, method, e instanceof ScopeError ? (e.url ?? url) : url, "refused", e.message);
                throw translate(e, url);
            }
        },
        async pinnedAddress(url) {
            const d = await session.checkUrl(url);
            return d.allowed ? d.address : undefined;
        },
        async take() {
            try {
                await session.take();
            } catch (e) {
                throw translate(e, "");
            }
        },
        requestsSent: () => session.stats.requests,
        endSignIn() {
            signInEnded = true;
        },
    };
}
