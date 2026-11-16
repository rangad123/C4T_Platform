/**
 * Secret hiding for text that becomes application knowledge (documents, tests, pages, OpenAPI and schema text) before it is sent to a
 * model or stored. On top of the shared redaction: the project's own secrets, well-known API key formats, a value after a secret word
 * ("password Hunter2!", "PIN 4921"), a value on the line after "password:", and anything shaped like a strong password. It is a pattern
 * filter, not a guarantee; it errs towards hiding.
 */
import { HIDDEN, redactText, SECRET_KEY } from "../../../shared/redact-text.js";

/** Stripe, GitHub, Slack, AWS, Google and GitLab style keys. */
const KNOWN_KEY = /\b(?:[sprk]k_(?:live|test)_[A-Za-z0-9]{6,}|gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|xox[abprs]-[A-Za-z0-9-]{6,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|glpat-[A-Za-z0-9_-]{10,})/g;
/** A secret word followed (after optional "is"/"of"/":") by a value. */
const WORD_VALUE = /\b(pass(?:word|wd|code|phrase)?|pwd|pw|pin|otp|secret|api[ _-]?key|token|code word)\b(\s*(?:is|of|:|=)?\s+)([^\s,;]{3,64})/gi;
const WORD_ONLY = new RegExp(String.raw`(?:^|[^A-Za-z])(?:${SECRET_KEY}|pw|pin|otp|passcode)\s*[:=]\s*$`, "i");
/** At least three of: lower case, upper case, digit, symbol; 6-64 characters; or letters and digits with a symbol. */
function strongPassword(token: string): boolean {
    if (token.length < 6 || token.length > 64 || token === HIDDEN || /^\[.*\]$/.test(token) || /^(?:https?:|\/|\.)/.test(token)) return false;
    const lower = /[a-z]/.test(token);
    const upper = /[A-Z]/.test(token);
    const digit = /\d/.test(token);
    const symbol = /[!@#$%^&*+=?~]/.test(token);
    return (lower || upper) && digit && (symbol || (lower && upper && token.length >= 8));
}
const looksLikeValue = (v: string) => /\d/.test(v) || /[!@#$%^&*+=?~]/.test(v) || (/[a-z]/.test(v) && /[A-Z]/.test(v));

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One line or piece of text, cut to `max` characters before any pattern runs. */
export function hideSecrets(text: string, opts: { secrets?: readonly string[]; max?: number } = {}): string {
    const max = opts.max ?? 1000;
    let s = text.slice(0, max * 2);
    for (const secret of opts.secrets ?? []) if (secret && secret.length >= 4) s = s.replace(new RegExp(escape(secret), "g"), HIDDEN);
    s = s.replace(KNOWN_KEY, HIDDEN).replace(WORD_VALUE, (m, word: string, sep: string, value: string) => (looksLikeValue(value) ? `${word}${sep}${HIDDEN}` : m));
    s = s
        .split(/(\s+)/)
        .map((t) => {
            const core = t.replace(/^[("'“]+|[)"'”.,;:]+$/g, "");
            return core && strongPassword(core) ? t.replace(core, HIDDEN) : t;
        })
        .join("");
    return redactText(s, max);
}

/** Lines of one document: each hidden, and a line right after a bare "password:" is hidden whole. */
export function hideSecretLines(lines: readonly string[], opts: { secrets?: readonly string[]; max?: number } = {}): string[] {
    return lines.map((l, i) => (i > 0 && WORD_ONLY.test(lines[i - 1]!.slice(-200)) && l.trim() ? HIDDEN : hideSecrets(l, opts)));
}
