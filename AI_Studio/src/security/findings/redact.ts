/**
 * Redaction for everything a finding keeps: evidence, descriptions, reproduction steps, comments, manual entries.
 *
 * Runs before anything is stored, so the database, API answers, CSV, HTML/PDF reports and logs all see the same cleaned text.
 * What goes: cookie values (names and flags stay), auth headers, bearer/basic credentials, JWTs, secret-looking query parameters and
 * `key=value` / `"key": "value"` pairs whose key names a secret, passwords in addresses (user:pass@host), e-mail addresses, long hex or
 * base64 strings, and in body excerpts every value of an `.env`-like `KEY=value` line (key names only).
 * It is a pattern filter, not a guarantee: free text a person types is cleaned with the same patterns, nothing more.
 */
import type { Evidence } from "../contract.js";

export const HIDDEN = "[hidden]";
export const EMAIL_HIDDEN = "[email hidden]";

/** Longest evidence value / free text kept (characters); longer text is cut with a note. */
export const MAX_EVIDENCE_VALUE = 2000;
export const MAX_TEXT = 8000;

/** Header names whose whole value is a credential. */
const SECRET_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "x-api-key", "x-auth-token", "x-csrf-token", "x-xsrf-token", "api-key", "x-amz-security-token"]);

/** A key name that says its value is secret (or personal), in config lines, query strings and JSON. */
const SECRET_KEY = String.raw`[A-Za-z0-9_.-]*(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth|credential|session|cookie|signature|salt|dsn|conn(?:ection)?[_-]?string)[A-Za-z0-9_.-]*`;

const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g;
const AUTH_SCHEME = /\b(Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const JWT = /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"'<>]+(?::[^\s/@"'<>]*)?@/gi;
const SECRET_PARAM = new RegExp(String.raw`([?&;](?:${SECRET_KEY}|key|code|otp|sig|ticket)=)[^&#\s"'<>]*`, "gi");
const JSON_PAIR = new RegExp(String.raw`("${SECRET_KEY}"\s*:\s*)("(?:[^"\\]|\\.)*"|[^,}\s]+)`, "gi");
const CONFIG_PAIR = new RegExp(String.raw`\b(${SECRET_KEY})(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)`, "gi");
/** 32+ characters of hex, or base64/base64url with both letters and digits: keys, hashes, session ids. */
const LONG_HEX = /\b[0-9a-fA-F]{32,}\b/g;
const LONG_B64 = /(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]{32,})(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{32,}={0,2}/g;
/** An `.env` / ini style line: `KEY=value`, `export KEY=value`, `key = value`. */
const ENV_LINE = /^([ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_.-]*[ \t]*[=:][ \t]*)(\S.*)$/gm;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 12)}… (cut)` : s);

/** Clean one piece of free text (descriptions, comments, locations, header values that are not credentials). */
export function redactText(input: unknown, max = MAX_TEXT): string {
    let s = String(input ?? "");
    // Control and direction-override characters never belong in a report.
    s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, "");
    s = s
        .replace(URL_USERINFO, `$1${HIDDEN}@`)
        .replace(JWT, HIDDEN)
        .replace(AUTH_SCHEME, `$1 ${HIDDEN}`)
        .replace(SECRET_PARAM, `$1${HIDDEN}`)
        .replace(JSON_PAIR, `$1"${HIDDEN}"`)
        // CORS answers name "credentials" but their values ("true") are the evidence, not a secret.
        .replace(CONFIG_PAIR, (m: string, k: string, sep: string) => (/allow-credentials$/i.test(k) ? m : `${k}${sep}${HIDDEN}`))
        .replace(EMAIL, EMAIL_HIDDEN)
        .replace(LONG_HEX, HIDDEN)
        .replace(LONG_B64, HIDDEN);
    return clip(s, max);
}

/** A body excerpt: every `KEY=value` line keeps only its key, then the general patterns. */
export function redactExcerpt(input: unknown, max = MAX_EVIDENCE_VALUE): string {
    const s = String(input ?? "").replace(ENV_LINE, (_m, key: string) => `${key}${HIDDEN}`);
    return redactText(s, max);
}

/** One Set-Cookie (or Cookie) header value: cookie names and attributes stay, values go. */
export function redactCookie(raw: string): string {
    const parts = String(raw).split(";").map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return "";
    const nameOf = (p: string) => (p.includes("=") ? p.slice(0, p.indexOf("=")).trim() : p);
    const [first, ...attrs] = parts;
    // Attribute values are harmless (Path, Domain, Expires, SameSite) except a Domain that is an e-mail or similar: the text filter handles that.
    return redactText([`${nameOf(first!)}=${HIDDEN}`, ...attrs].join("; "), MAX_EVIDENCE_VALUE);
}

/** A request `Cookie:` header: only the names. */
export function redactCookieHeader(raw: string): string {
    return String(raw)
        .split(";")
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => `${p.includes("=") ? p.slice(0, p.indexOf("=")) : p}=${HIDDEN}`)
        .join("; ");
}

/** A header as received: credential headers are hidden whole, cookies keep names and flags, the rest goes through the text filter. */
export function redactHeader(name: string, value: string): string {
    const n = name.toLowerCase();
    if (n === "set-cookie") return redactCookie(value);
    if (n === "cookie") return redactCookieHeader(value);
    if (SECRET_HEADERS.has(n)) return HIDDEN;
    return redactText(value, MAX_EVIDENCE_VALUE);
}

/** One piece of evidence, cleaned for storing. */
export function redactEvidence(e: Evidence): Evidence {
    const label = redactText(e.label, 200);
    let value: string;
    if (e.kind === "cookie") value = redactCookie(e.value);
    else if (e.kind === "response-header") {
        const colon = e.value.indexOf(":");
        // "Name: value" keeps the name; a bare value is judged by the label (the header name).
        value = colon > 0 && /^[A-Za-z0-9-]+$/.test(e.value.slice(0, colon)) ? `${e.value.slice(0, colon)}: ${redactHeader(e.value.slice(0, colon), e.value.slice(colon + 1).trim())}` : redactHeader(label, e.value);
    } else if (e.kind === "body-excerpt") value = redactExcerpt(e.value);
    else value = redactText(e.value, MAX_EVIDENCE_VALUE);
    return { kind: e.kind, label, value: clip(value, MAX_EVIDENCE_VALUE), observedAt: String(e.observedAt).slice(0, 40) };
}
