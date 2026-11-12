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
 */
import type { SecurityApplication } from "../contract.js";
import { createScopeSession, guardedFetch, ScopeError, sessionOptionsFrom, type ScopeEvent, type ScopeSession, type ScopeSessionOptions } from "../scope.js";
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

export interface AssessmentGuard extends Guard {
    session: ScopeSession;
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
    const session = createScopeSession(app, { ...sessionOptionsFrom(settings), ...extra, ...(proxy ? { proxy } : {}), signal, onEvent });
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
    return {
        session,
        blockedRedirects,
        async ready() {
            await proxy?.ready();
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
            try {
                const r = await guardedFetch(session, url, { method: init.method ?? "GET", headers: withSavedCookies(url, init), followRedirects: init.redirect !== "manual", maxBytes: init.maxBytes, allowInvalidCertificate: true });
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
