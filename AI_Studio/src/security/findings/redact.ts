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

import { EMAIL_HIDDEN, HIDDEN, MAX_TEXT, SECRET_KEY, clip, redactText } from "../../shared/redact-text.js";

export { EMAIL_HIDDEN, HIDDEN, MAX_TEXT, redactText };

export const MAX_EVIDENCE_VALUE = 2000;
/** Header names whose whole value is a credential. */
const SECRET_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "x-api-key", "x-auth-token", "x-csrf-token", "x-xsrf-token", "api-key", "x-amz-security-token"]);
/** An `.env` / ini style line: `KEY=value`, `export KEY=value`, `key = value`. */
const ENV_LINE = /^([ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_.-]*[ \t]*[=:][ \t]*)(\S.*)$/gm;

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
