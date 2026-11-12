/**
 * The saved sign-in's pure rules (no database, no key): what looks like a sign-out, the Cookie header a browser would send, scrubbing secret
 * values, and "still signed in?". Split from signin.ts (round 52) so an assessment on a runner (assessment/on-runner.ts) reaches none of the
 * platform's storage; signin.ts re-exports them.
 */
import { cookieMatchesHost, type StorageState } from "../engine/auth/storage-state.js";
import { HIDDEN } from "./findings/redact.js";

/** Paths that sign out (never requested while signed in, never followed as links). */
const SIGN_OUT_PATH = /(^|[/_.-])(log[-_]?out|sign[-_]?out|log[-_]?off|sign[-_]?off|end[-_]?session)([/_.?;-]|$)/i;
/** Link words that sign out. */
const SIGN_OUT_TEXT = /\b(log|sign)\s*-?\s*(out|off)\b|\blogout\b|\bsignout\b/i;
/** The reason the scope guard gives for a refused sign-out address (discovery lists those apart). */
export const SIGN_OUT_REASON = "It looks like a sign-out address; following it would end the saved sign-in, so it is never requested.";

/** Does this address (or its link text) look like it signs out? */
export function isSignOut(url: string | URL, text?: string | null): boolean {
    let path = "";
    try {
        const u = typeof url === "string" ? new URL(url) : url;
        path = decodeURIComponent(u.pathname + u.search);
    } catch {
        path = String(url);
    }
    return SIGN_OUT_PATH.test(path) || (text ? SIGN_OUT_TEXT.test(text.replace(/\s+/g, " ").slice(0, 200)) : false);
}

/** The `Cookie` header the browser would send to this address from the saved state (empty string when none applies). */
export function cookieHeaderFor(state: StorageState | undefined, raw: string, now = Date.now()): string {
    if (!state) return "";
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return "";
    }
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const path = u.pathname || "/";
    const pairs: string[] = [];
    for (const c of state.cookies) {
        if (c.expires > 0 && c.expires * 1000 <= now) continue;
        if (c.secure && u.protocol !== "https:") continue;
        // A domain without a leading dot is host-only (Playwright writes them that way): that host and no other.
        const ok = c.domain.startsWith(".") ? cookieMatchesHost(c.domain, host) : c.domain.toLowerCase() === host;
        if (!ok) continue;
        const cp = c.path || "/";
        if (!(path === cp || path.startsWith(cp.endsWith("/") ? cp : `${cp}/`))) continue;
        pairs.push(`${c.name}=${c.value}`);
    }
    return pairs.join("; ");
}

/** Replaces every secret value (and its URL-encoded form) in every string of a value, deeply. Returns a new value. */
export function scrubSecrets<T>(value: T, secrets: readonly string[]): T {
    const list = [...new Set(secrets.flatMap((s) => [s, encodeURIComponent(s)]).filter((s) => s.length >= 6))].sort((a, b) => b.length - a.length);
    if (!list.length) return value;
    const clean = (s: string) => {
        let out = s;
        for (const secret of list) if (out.includes(secret)) out = out.split(secret).join(HIDDEN);
        return out;
    };
    const walk = (v: unknown): unknown => {
        if (typeof v === "string") return clean(v);
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [clean(k), walk(x)]));
        return v;
    };
    return walk(value) as T;
}

/** "Still signed in?" for the signed-in page the assessment opened: signed out when it answers 401/403, asks for a password or lands on a sign-in address. */
export function judgeSignedInPage(page: { status: number; finalUrl: string; hasPasswordField: boolean }, checkUrl: string): { ok: boolean; reason: string } {
    if (page.status === 401 || page.status === 403) return { ok: false, reason: `answered HTTP ${page.status}` };
    if (page.hasPasswordField) return { ok: false, reason: "asked for a password again" };
    const signInPath = /(^|\/)(log-?in|sign-?in|signin|sso|oauth2?|session\/new|users\/sign_in)(\/|$|\?)/i;
    try {
        const from = new URL(checkUrl);
        const to = new URL(page.finalUrl);
        if (!signInPath.test(from.pathname) && signInPath.test(to.pathname)) return { ok: false, reason: `moved to the sign-in address ${to.pathname}` };
    } catch {
        /* judged on the rest */
    }
    return { ok: true, reason: "showed a signed-in page" };
}
