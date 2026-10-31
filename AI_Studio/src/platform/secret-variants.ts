/**
 * The forms in which a secret can come back out of a page, so that scrubbing an answer does not depend on the page echoing it byte for byte.
 *
 * A page that shows what was typed into it can URL-encode it (a search form that puts it in the address), HTML-escape it, change its case or base64 it. Scrubbing
 * only the raw string misses all of those. This is a list of the usual encodings, not a proof: a page can still transform a secret in a way not listed here
 * (a hash, a rot13, every second character). The real protection is that a stand-in is typed only into a password or one-time-code field of the application's own
 * site (act.ts `decideFill`, session.ts); this list narrows what a hostile page can read back from there.
 */
import { totp } from "../engine/identity/totp.js";

const MIN = 4;

const htmlEscape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Every listed encoding of one secret, the secret itself first. Variants shorter than the minimum are left out. */
export function secretVariants(secret: string): string[] {
    if (secret.length < MIN) return [];
    const out = new Set<string>([secret]);
    const add = (v: string | undefined) => {
        if (v && v.length >= MIN) out.add(v);
    };
    const b64 = Buffer.from(secret, "utf8").toString("base64");
    const forms = [
        encodeURIComponent(secret),
        encodeURI(secret),
        encodeURIComponent(secret).replace(/%20/g, "+"), // form encoding
        encodeURIComponent(encodeURIComponent(secret)),
        escape(secret),
        htmlEscape(secret),
        JSON.stringify(secret).slice(1, -1),
        b64,
        b64.replace(/=+$/, ""),
        b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
        Buffer.from(secret, "utf8").toString("hex"),
        Buffer.from(secret, "utf8").toString("hex").toUpperCase(),
    ];
    for (const f of forms) add(f);
    // Case: a page may show a value upper- or lower-cased (a CSS-free echo, a "normalised" copy). Only when the case actually changes the text.
    for (const f of [secret, encodeURIComponent(secret), htmlEscape(secret)]) {
        add(f.toLowerCase());
        add(f.toUpperCase());
    }
    return [...out];
}

/** The variants of a whole list, without repeats. */
export function expandSecrets(secrets: readonly string[]): string[] {
    const out = new Set<string>();
    for (const s of secrets) for (const v of secretVariants(s)) out.add(v);
    return [...out];
}

/**
 * The one-time codes an authenticator secret gives now and in the neighbouring windows (a code is accepted a window either side, and a snapshot taken a moment
 * later is still in the next one). Empty when the secret is not valid base32.
 */
export function totpCodesNear(secret: string | undefined, now = Date.now()): string[] {
    if (!secret) return [];
    try {
        return [-1, 0, 1].map((w) => totp(secret, { now: now + w * 30_000 }));
    } catch {
        return [];
    }
}
