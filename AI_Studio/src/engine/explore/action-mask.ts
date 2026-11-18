/**
 * The action log as it is kept and shown (summary.exploration, the job's exploration artifact, a runner's exploration record, the
 * coverage route): every row's text masked when it is written. The loop itself works on the raw rows (repeat detection, coverage); only
 * the kept copy is masked.
 *  - Addresses lose their query string and fragment (`?token=…`, `#access_token=…`): the path is what a reader needs.
 *  - Typed values (`fill`, `select`, `press`, …): a `{{…}}` placeholder stays; a literal one is hidden when it is one of the run's
 *    secrets, when the pattern masking would hide anything in it, or when the field it went into is named like a secret field;
 *    otherwise it is kept, cut to TYPED_MAX characters.
 *  - Every other text passes the shared pattern masking (src/shared/redact-text.ts) and the run's secrets.
 * Masking an already masked row changes nothing, so the platform can mask again whatever a runner sent.
 */
import { maskSecrets } from "../frameworks/plugin.js";
import { clip, HIDDEN, redactText } from "../../shared/redact-text.js";
import type { ActionLogRow } from "./loop.js";

/** Longest typed value kept in the log (characters). */
export const TYPED_MAX = 80;
/** Longest action / state / reason text kept in one row (characters). */
export const ROW_TEXT_MAX = 1_000;

const PLACEHOLDER = /^\{\{[\w.-]{1,80}\}\}$/;
/** A field named like one that takes a secret: its value is hidden whatever it looks like. */
const SECRET_FIELD = /pass(?:word|wd|code|phrase)?|pwd|\bpin\b|otp|one[ -]?time|totp|2fa|mfa|secret|token|api[ _-]?key|private[ _-]?key|credential|\bcvv\b|\bcvc\b|security code|card ?number|\bssn\b/i;
/** Argument names that hold a typed value. */
const TYPED_KEYS = new Set(["value", "promptText", "text", "key"]);
/** Argument names that hold an address. */
const URL_KEYS = new Set(["url", "href", "to"]);
const ABSOLUTE_URL = /\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi;

/** An address without its query string and fragment. */
export function withoutQuery(url: string): string {
    const cut = url.search(/[?#]/);
    return cut === -1 ? url : url.slice(0, cut);
}

/** Free text masked: addresses lose their query and fragment, then pattern masking and the run's secrets. */
function maskText(text: string, secrets: readonly string[], max = ROW_TEXT_MAX): string {
    return redactText(maskSecrets(text.replace(ABSOLUTE_URL, "$1"), secrets), max);
}

function looksSecret(value: string, secrets: readonly string[]): boolean {
    return maskSecrets(value, secrets) !== value || redactText(value, Number.MAX_SAFE_INTEGER) !== value;
}

function maskTyped(value: string, secrets: readonly string[], secretField: boolean): string {
    if (PLACEHOLDER.test(value) || value === HIDDEN) return value;
    if (secretField || looksSecret(value, secrets)) return HIDDEN;
    return clip(value, TYPED_MAX);
}

function maskArgs(v: unknown, secrets: readonly string[], secretField: boolean, key?: string): unknown {
    if (typeof v === "string") {
        if (key !== undefined && TYPED_KEYS.has(key)) return maskTyped(v, secrets, secretField);
        if (key !== undefined && URL_KEYS.has(key)) return maskText(withoutQuery(v), secrets);
        return maskText(v, secrets);
    }
    if (Array.isArray(v)) return v.map((x) => maskArgs(x, secrets, secretField));
    if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        // The field the value goes into (`target`, a locator): its name says whether the value is a secret. A locator's own `value` is
        // the element's name, not something typed.
        const field = secretField || (o.target !== undefined && SECRET_FIELD.test(JSON.stringify(o.target)));
        return Object.fromEntries(
            Object.entries(o).map(([k, x]) => [k, k === "target" || k === "has" || k === "hasNot" || k === "filter" || k === "frame" ? maskLocator(x, secrets) : maskArgs(x, secrets, field, k)]),
        );
    }
    return v;
}

/** A locator: names of elements are kept (pattern-masked), they are not typed values. */
function maskLocator(v: unknown, secrets: readonly string[]): unknown {
    if (typeof v === "string") return maskText(v, secrets);
    if (Array.isArray(v)) return v.map((x) => maskLocator(x, secrets));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, maskLocator(x, secrets)]));
    return v;
}

/** One action as the log writes it (`tool {json args}`), masked. Text that is not that shape is masked as free text. */
export function maskAction(action: string, secrets: readonly string[] = []): string {
    const space = action.indexOf(" ");
    const tool = space === -1 ? action : action.slice(0, space);
    const rest = space === -1 ? "" : action.slice(space + 1);
    let args: unknown;
    try {
        args = JSON.parse(rest);
    } catch {
        return maskText(action, secrets);
    }
    return clipRow(`${maskText(tool, secrets, 80)} ${JSON.stringify(maskArgs(args, secrets, false))}`);
}

const clipRow = (s: string) => clip(s, ROW_TEXT_MAX);

/** The rows with every text masked (see the file comment). */
export function maskActionLog(rows: readonly ActionLogRow[], secrets: readonly string[] = []): ActionLogRow[] {
    return rows.map((r) => ({
        ...r,
        objectiveId: maskText(String(r.objectiveId), secrets, 200),
        // The state is an address pattern (query keys only, no values) and a digest.
        state: maskText(String(r.state), secrets, 400),
        action: maskAction(String(r.action), secrets),
        ...(r.reason !== undefined ? { reason: maskText(String(r.reason), secrets) } : {}),
    }));
}
