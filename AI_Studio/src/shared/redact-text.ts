/**
 * Pattern redaction for free text, shared by the security module (findings, evidence) and the platform's masking on write
 * (src/platform/redact-text.ts). Moved here from src/security/findings/redact.ts so the platform does not import the security module;
 * the rules live only here. Besides credentials it hides personal data (e-mails, also URL-encoded; phone numbers; postal addresses; card
 * numbers that pass the Luhn check) and query values that are one of these once decoded. It is a pattern filter, not a guarantee: a
 * value with nothing around it that marks it (a token written as plain text) is not found.
 */
export const HIDDEN = "[hidden]";
export const EMAIL_HIDDEN = "[email hidden]";

/** Longest evidence value / free text kept (characters); longer text is cut with a note. */
export const MAX_TEXT = 8000;


/**
 * A key name that says its value is secret (or personal), in config lines, query strings and JSON. `auth` is a secret word except in the
 * whole prose words author, authors, authored, authoring, authority, authorities and authentic; authorization, authentication and their
 * compounds (authorizationKey, proxyAuthorization, x_authentication) stay secret names.
 */
export const SECRET_KEY = String.raw`[A-Za-z0-9_.-]{0,64}(?:pass(?:word|wd)?|pwd|secret|token|bearer|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth(?!or(?:s|ed|ing|ity|ities)?\b|entic\b)|credential|session|cookie|signature|salt|dsn|conn(?:ection)?[_-]?string)[A-Za-z0-9_.-]{0,64}`;

const EMAIL = /[A-Za-z0-9._%+-]{1,64}(?:@|%40)[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g;
const AUTH_SCHEME = /\b(Bearer|Basic|Digest|Token)\s+([A-Za-z0-9._~+/=-]{6,})/gi;
/**
 * A credential after a bare auth scheme word (no header name before it) has at least one character that is not a lowercase letter (digit,
 * uppercase, + / = . _ ~ -) and is not one capitalized word, so English after the word ("Basic security checks", "Token Expired") is kept.
 * A short one (6 or 7 characters) also needs a digit ("Bearer abc123", not "Basic OAuth"). Checked case-sensitively here because the scheme
 * match above ignores case.
 */
const isCredential = (value: string): boolean => /[^a-z]/.test(value) && !/^[A-Z][a-z]+$/.test(value) && (value.length >= 8 || /\d/.test(value));
/** An optional quote, plain or escaped as inside a JSON string (`"`, `'`, `\"`). */
const QUOTE = String.raw`(?:\\?["'])`;
/**
 * The value of an `Authorization` / `Proxy-Authorization` header wherever one is written: `Authorization: Bearer x`,
 * `"authorization":"Bearer x"`, `-H 'Authorization: Basic x'`, `authorization=x`, `["Authorization", "Bearer x"]`,
 * `{"name":"Authorization","value":"Bearer x"}`. Groups: 1 the name up to the value, 2-3 a Digest value (the rest of the line, it has
 * several parts), 4 another scheme, 5 the credential. Not a query parameter (`?authorization=`): the secret-parameter rule has those.
 */
const AUTH_HEADER = new RegExp(
    String.raw`(?<![?&;])(\b(?:Proxy-)?Authorization${QUOTE}?\s*(?:[:=]|,\s*(?:${QUOTE}value${QUOTE}\s*:\s*)?(?=${QUOTE}))\s*${QUOTE}?)(?:(Digest)\s+([^\r\n]+)|(?:(Bearer|Basic|Token|Negotiate|NTLM)\s+)?([^\s"'\\]+))`,
    "gi",
);
const SCHEME_WORD = /^(?:Bearer|Basic|Digest|Token|Negotiate|NTLM)$/i;
/** A value that is already a mask (`•••`, `[hidden]`, `[token]`): masking it again would only rewrite it. */
const MASKED = /^(?:•+|\[hidden\]|\[token\])$/;

/**
 * The one auth-credential rule (free text, logs, site memory all use it; no copies):
 *  - after an `Authorization` / `Proxy-Authorization` header name the credential is always hidden, whatever its letters and however short;
 *  - after a bare `Bearer` / `Basic` / `Digest` / `Token` only what looks like a credential is (isCredential), so English stays readable;
 *  - `strict` (server log, site memory): every value after a bare `bearer` (any case, any letters, any length) is hidden as well.
 * `shown` writes what replaces "scheme credential" (scheme is "" when the header value had none).
 */
export function hideAuthCredentials(
    text: string,
    shown: (scheme: string) => string = (scheme) => (scheme ? `${scheme} ${HIDDEN}` : HIDDEN),
    opts: { strict?: boolean; found?: Found } = {},
): string {
    const found = opts.found ?? (() => undefined);
    const out = text
        .replace(AUTH_HEADER, (m: string, head: string, digest: string | undefined, _rest: string | undefined, scheme: string | undefined, value: string | undefined) => {
            if (digest) return (found(_rest ?? ""), `${head}${shown(digest)}`);
            const tail = /[,;)]+$/.exec(value ?? "")?.[0] ?? "";
            const core = tail ? (value ?? "").slice(0, -tail.length) : (value ?? "");
            if (!core) return `${head}${shown(scheme ?? "")}`;
            // `Authorization: none`, `authorization: is required`: a sentence about the header, not a credential (see PROSE_VALUE).
            if (!scheme && PROSE_VALUE.test(core)) return m;
            return MASKED.test(core) ? m : (found(core), `${head}${shown(scheme ?? "")}${tail}`);
        })
        .replace(AUTH_SCHEME, (m: string, scheme: string, value: string) => (isCredential(value) ? (found(value), shown(scheme)) : m));
    // Logs and site memory: every value after a bare "bearer" (any case, any letters, any length) is hidden too.
    return opts.strict ? out.replace(BARE_BEARER, (m: string, scheme: string, value: string) => (MASKED.test(value) ? m : (found(value), shown(scheme)))) : out;
}
/** Told each secret value a rule hides (secretsInText). */
type Found = (value: string) => void;
/** Strict mode: any value after a bare `bearer`, however short or lowercase. */
const BARE_BEARER = /\b(bearer)\s+([A-Za-z0-9._~+/=-]+)/gi;
const JWT = /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:"'<>]+(?::[^\s/@"'<>]*)?@/gi;
const SECRET_PARAM = new RegExp(String.raw`([?&;](?:${SECRET_KEY}|authori[sz]ation|key|code|otp|sig|ticket)=)[^&#\s"'<>]*`, "gi");
const JSON_PAIR = new RegExp(String.raw`("${SECRET_KEY}"\s*:\s*)("(?:[^"\\]|\\.)*"|[^,}\s]+)`, "gi");
/** A word that only ever starts ordinary prose, never a secret value ("secret: is not documented", "authored: The …"). */
const PROSE_VALUE = /^(?:is|are|was|were|not|the|a|an|this|that|none|missing|required|empty|unset|null|undefined|true|false|yes|no)$/i;
const CONFIG_PAIR = new RegExp(String.raw`\b(${SECRET_KEY})(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)`, "gi");
/** 32+ characters of hex, or base64/base64url with both letters and digits: keys, hashes, session ids. */
const LONG_HEX = /\b[0-9a-fA-F]{32,}\b/g;
const LONG_B64 = /(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]{32,})(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{32,}={0,2}/g;

/**
 * A long base64-looking run, unless it is a slug (SLUG). With slashes it may be an address path (`9501/api/notes/50123/comments/70001`): then only its long parts are
 * hidden and its short parts (ports, words, numeric ids) stay. A real base64 value has a slash only now and then, so its parts are long and
 * are all hidden.
 */
const hideLongRun = (m: string): string => (m.includes("/") ? m.split("/").map((part) => (part.replace(/=+$/, "").length >= 20 && !SLUG.test(part) ? HIDDEN : part)).join("/") : SLUG.test(m) ? m : HIDDEN);
/**
 * A dash-joined run of lowercase words and whole numbers (`journey-1-sign-in-to-the-account`, row 232): an id made from a label, not a key.
 * A random key's dash-cut parts mix letters with digits or upper case (`9f86d081-884c7d65`, `Ab3dE-f9GhIj`), so they are still hidden.
 */
const SLUG = /^(?:[a-z]+|\d+)(?:-(?:[a-z]+|\d+))+$/;
/** A `host:port` in an address (`//session.example:8080`, `user@db.internal:5432`): the host only looks like a secret key name. */
const isHostPort = (all: string, offset: number, key: string, sep: string, value: string): boolean =>
    sep.trim() === ":" && key.includes(".") && /^\d{1,5}(?:[/?#][^\s]*)?$/.test(value) && /(?:\/\/|@)$/.test(all.slice(Math.max(0, offset - 2), offset));

/** Sentence punctuation right after a value, before a space or the end of the text: it belongs to the sentence, not to the value. */
const TRAILING = /[,;)]+$/;
/** `Authorization: Bearer [hidden]`: the header rule already hid the credential, so the scheme word before the mask stays. */
const schemeKept = (all: string, end: number, value: string): boolean => SCHEME_WORD.test(value) && /^\s+(?:•+|\[hidden\])/.test(all.slice(end, end + 16));
/**
 * The hidden form of a secret value found at `offset` in `all`: trailing sentence punctuation stays, and a value that is already a mask is
 * left exactly as it is.
 */
function hideValue(value: string, end: number, all: string, hidden: string = HIDDEN): string {
    const atEnd = end >= all.length || /\s/.test(all[end] ?? "");
    const tail = atEnd ? (TRAILING.exec(value)?.[0] ?? "") : "";
    const core = tail ? value.slice(0, -tail.length) : value;
    if (core === "" || MASKED.test(core)) return value;
    return `${hidden}${tail}`;
}

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 12)}… (cut)` : s);

/**
 * A card number: 13 to 19 digits, grouped by single spaces or dashes or not at all, starting as cards do (2-6), and passing the Luhn check,
 * so most other long numbers (ids, epoch times that start with 1) stay.
 */
const CARD = /(?<![\w.-])[2-6]\d(?:[ -]?\d){11,17}(?![\w-])/g;
const luhn = (digits: string): boolean => {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
        let d = Number(digits[digits.length - 1 - i]);
        if (i % 2 === 1 && (d *= 2) > 9) d -= 9;
        sum += d;
    }
    return sum % 10 === 0;
};
const isCard = (m: string): boolean => {
    const d = m.replace(/\D/g, "");
    return d.length >= 13 && d.length <= 19 && luhn(d);
};
/**
 * A phone number: international (`+` and 8 to 15 digits, grouped by spaces or dashes), or a national one with an area code in brackets
 * (`(415) 555-0111`) or grouped 3-3-4 (`415-555-0111`). Dates, times, versions and server addresses do not have these shapes.
 */
const PHONE = /(?<![\w+])\+\d{1,3}(?:[ -]?\(?\d{1,5}\)?){1,5}(?![\w-])|(?<![\w(])\(\d{2,4}\)[ -]?\d{3,4}[ -]\d{4}(?![\w-])|(?<![\w-])\d{3}[ -]\d{3}[ -]\d{4}(?![\w-])/g;
const isPhone = (m: string): boolean => !m.startsWith("+") || (m.replace(/\D/g, "").length >= 8 && m.replace(/\D/g, "").length <= 15);
/** A postal address: a house number, one to four capitalised words and a street word, then optionally `, Town`. */
const ADDRESS =
    /\b\d{1,6}[A-Za-z]?\s+(?:[A-Z][a-z]+\s+){1,4}(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Boulevard|Blvd|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Close|Crescent|Parkway|Highway|Square|Row)\b\.?(?:,\s*[A-Z][a-z]+(?:\s[A-Z][a-z]+){0,2})?/g;
/** API keys in formats that name themselves (Stripe, GitHub, Slack, AWS, Google), with or without a key word before them. */
const KEY_FORMAT = /\b(?:(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g;
/** A query parameter's value: hidden whole when, decoded, it holds something the rules hide (an encoded e-mail, address or connection string). */
const QUERY_VALUE = /([?&;][^=&#\s"'<>?]{1,64}=)([^&#\s"'<>]+)/g;
const decoded = (v: string): string => {
    try {
        return decodeURIComponent(v.replace(/\+/g, " "));
    } catch {
        return v;
    }
};

/** Clean one piece of free text (descriptions, comments, locations, header values that are not credentials). */
export function redactText(input: unknown, max = MAX_TEXT): string {
    // Control and direction-override characters never belong in a report.
    return clip(redactCore(String(input ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, "")), max);
}

/**
 * Every value in a text that redactText would hide, as it stands there (a query value also decoded; a connection string's password also
 * on its own), for masking by value where the rules cannot run on the text itself (a trace, evidence/trace-scrub.ts). Long hex and base64
 * runs are left out: a trace's own ids look like them.
 */
export function secretsInText(text: string): string[] {
    const out = new Set<string>();
    redactCore(text, (v) => {
        if (v && !MASKED.test(v)) out.add(v);
    });
    return [...out];
}

function redactCore(input: string, found: Found = () => undefined, depth = 0): string {
    let s = input;
    const hid = (value: string, end: number, all: string): string => {
        const out = hideValue(value, end, all);
        if (out !== value) found(value.replace(TRAILING, ""));
        return out;
    };
    if (depth === 0) {
        s = s.replace(QUERY_VALUE, (m: string, head: string, value: string) => {
            const plain = decoded(value);
            if (plain === value || MASKED.test(plain)) return m;
            const inner: string[] = [];
            if (redactCore(plain, (v) => inner.push(v), 1) === plain) return m;
            found(value);
            found(plain);
            inner.forEach(found);
            return `${head}${HIDDEN}`;
        });
    }
    s = s
        .replace(URL_USERINFO, (m: string, scheme: string) => {
            const info = m.slice(scheme.length, -1);
            found(info);
            if (info.includes(":")) found(info.slice(info.indexOf(":") + 1));
            return `${scheme}${HIDDEN}@`;
        })
        .replace(JWT, (m: string) => (found(m), HIDDEN))
        .replace(KEY_FORMAT, (m: string) => (found(m), HIDDEN));
    s = hideAuthCredentials(s, undefined, { found })
        .replace(SECRET_PARAM, (m: string, head: string, offset: number, all: string) => `${head}${hid(m.slice(head.length), offset + m.length, all)}`)
        .replace(JSON_PAIR, (m: string, head: string, value: string) => (MASKED.test(value.replace(/^"|"$/g, "")) ? m : (found(value.replace(/^"|"$/g, "")), `${head}"${HIDDEN}"`)))
        // CORS answers name "credentials" but their values ("true") are the evidence, not a secret.
        .replace(CONFIG_PAIR, (m: string, k: string, sep: string, value: string, offset: number, all: string) =>
            /allow-credentials$/i.test(k) || isHostPort(all, offset, k, sep, value) || PROSE_VALUE.test(value) || schemeKept(all, offset + m.length, value)
                ? m
                : `${k}${sep}${/^["']/.test(value) ? (MASKED.test(value.slice(1, -1)) ? value : (found(value.slice(1, -1)), HIDDEN)) : hid(value, offset + m.length, all)}`,
        )
        .replace(EMAIL, (m: string) => (found(m), EMAIL_HIDDEN))
        .replace(CARD, (m: string) => (isCard(m) ? (found(m), HIDDEN) : m))
        .replace(PHONE, (m: string) => (isPhone(m) ? (found(m), HIDDEN) : m))
        .replace(ADDRESS, (m: string) => (found(m), HIDDEN))
        .replace(LONG_HEX, HIDDEN)
        .replace(LONG_B64, hideLongRun);
    return s;
}
