/**
 * Pattern redaction for free text, shared by the security module (findings, evidence) and the platform's masking on write
 * (src/platform/redact-text.ts). Moved here from src/security/findings/redact.ts so the platform does not import the security module;
 * the rules are unchanged and live only here. It is a pattern filter, not a guarantee.
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
export const SECRET_KEY = String.raw`[A-Za-z0-9_.-]{0,64}(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth(?!or(?:s|ed|ing|ity|ities)?\b|entic\b)|credential|session|cookie|signature|salt|dsn|conn(?:ection)?[_-]?string)[A-Za-z0-9_.-]{0,64}`;

const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g;
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
    opts: { strict?: boolean } = {},
): string {
    const out = text
        .replace(AUTH_HEADER, (m: string, head: string, digest: string | undefined, _rest: string | undefined, scheme: string | undefined, value: string | undefined) => {
            if (digest) return `${head}${shown(digest)}`;
            const tail = /[,;)]+$/.exec(value ?? "")?.[0] ?? "";
            const core = tail ? (value ?? "").slice(0, -tail.length) : (value ?? "");
            if (!core) return `${head}${shown(scheme ?? "")}`;
            // `Authorization: none`, `authorization: is required`: a sentence about the header, not a credential (see PROSE_VALUE).
            if (!scheme && PROSE_VALUE.test(core)) return m;
            return MASKED.test(core) ? m : `${head}${shown(scheme ?? "")}${tail}`;
        })
        .replace(AUTH_SCHEME, (m: string, scheme: string, value: string) => (isCredential(value) ? shown(scheme) : m));
    // Logs and site memory: every value after a bare "bearer" (any case, any letters, any length) is hidden too.
    return opts.strict ? out.replace(BARE_BEARER, (m: string, scheme: string, value: string) => (MASKED.test(value) ? m : shown(scheme))) : out;
}
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
 * A long base64-looking run. With slashes it may be an address path (`9501/api/notes/50123/comments/70001`): then only its long parts are
 * hidden and its short parts (ports, words, numeric ids) stay. A real base64 value has a slash only now and then, so its parts are long and
 * are all hidden.
 */
const hideLongRun = (m: string): string => (m.includes("/") ? m.split("/").map((part) => (part.replace(/=+$/, "").length >= 20 ? HIDDEN : part)).join("/") : HIDDEN);
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

/** Clean one piece of free text (descriptions, comments, locations, header values that are not credentials). */
export function redactText(input: unknown, max = MAX_TEXT): string {
    let s = String(input ?? "");
    // Control and direction-override characters never belong in a report.
    s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, "");
    s = s
        .replace(URL_USERINFO, `$1${HIDDEN}@`)
        .replace(JWT, HIDDEN);
    s = hideAuthCredentials(s)
        .replace(SECRET_PARAM, (m: string, head: string, offset: number, all: string) => `${head}${hideValue(m.slice(head.length), offset + m.length, all)}`)
        .replace(JSON_PAIR, (m: string, head: string, value: string) => (MASKED.test(value.replace(/^"|"$/g, "")) ? m : `${head}"${HIDDEN}"`))
        // CORS answers name "credentials" but their values ("true") are the evidence, not a secret.
        .replace(CONFIG_PAIR, (m: string, k: string, sep: string, value: string, offset: number, all: string) =>
            /allow-credentials$/i.test(k) || isHostPort(all, offset, k, sep, value) || PROSE_VALUE.test(value) || schemeKept(all, offset + m.length, value) ? m : `${k}${sep}${/^["']/.test(value) ? (MASKED.test(value.slice(1, -1)) ? value : HIDDEN) : hideValue(value, offset + m.length, all)}`,
        )
        .replace(EMAIL, EMAIL_HIDDEN)
        .replace(LONG_HEX, HIDDEN)
        .replace(LONG_B64, hideLongRun);
    return clip(s, max);
}
