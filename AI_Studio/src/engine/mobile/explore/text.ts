/**
 * Text that comes from the app on the phone is untrusted data: an app (or a user of it) can put anything on a screen, including a sentence that
 * looks like an instruction to the AI. Everything that reaches the model, an event or a stored plan passes through here first.
 *
 * This is only a first layer. The real guard is code: the safety filter (safety.ts) decides what may be done, whatever the model was told.
 */

/** Control and format characters (including line breaks, zero-width characters and bidi overrides). */
const CONTROL = new RegExp("[\\p{Cc}\\p{Cf}" + String.fromCharCode(0x2028, 0x2029) + "]", "gu");

/** A sentence that tries to give the AI orders. Removed, not quoted. */
const ORDERS = [
    /\b(ignore|disregard|forget|override|bypass)\b[^.!?\n]{0,60}\b(instruction|instructions|rules?|prompt|previous|prior|above|earlier|system|guidelines?|safety)\b/gi,
    /\b(new|updated|real|actual) (instructions?|task|rules?)\b/gi,
    /\byou (are|must|should|will) (now|always|only)\b/gi,
    /\b(act|behave|respond) as\b/gi,
    /\b(do not|don't|never) (follow|obey|tell)\b/gi,
    /\bsystem (prompt|message)\b/gi,
];

/** A line that starts like a chat role or a control section. */
const ROLE_PREFIX = /^\s*(system|assistant|user|developer|human|ai|instructions?|prompt|important|note to (the )?(ai|assistant|model)|tool|function)\s*[:>\-–—]+\s*/i;

const REMOVED = "(text removed)";

/** One piece of screen text made safe to show to the model: single line, no brackets or quotes that could fake the screen's own layout, no orders, capped. */
export function cleanAppText(raw: unknown, max = 60): string {
    let s = typeof raw === "string" ? raw : "";
    s = s.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
    for (let i = 0; i < 3 && ROLE_PREFIX.test(s); i++) s = s.replace(ROLE_PREFIX, "");
    for (const re of ORDERS) s = s.replace(re, REMOVED);
    // The screen block, the element lines `[12] Button "x"` and the markup of the prompt are made of these characters.
    s = s
        .replace(/[<>]/g, (c) => (c === "<" ? "‹" : "›"))
        .replace(/[[\]]/g, (c) => (c === "[" ? "(" : ")"))
        .replace(/"/g, "'")
        .replace(/`/g, "'")
        .replace(/\{\{/g, "{ {")
        .replace(/\}\}/g, "} }")
        .replace(/\s+/g, " ")
        .trim();
    return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s;
}

/** True when the cleaner had to remove an order from this text (a hostile screen), for the job's events. */
export function looksLikeOrders(raw: string): boolean {
    const s = raw.replace(CONTROL, " ");
    return ORDERS.some((re) => new RegExp(re.source, re.flags.replace("g", "")).test(s)) || ROLE_PREFIX.test(s);
}

/** Remove any of the project's secret values (and the pieces long enough to matter) from a text. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
    let out = text;
    for (const s of secrets) if (s.length >= 4) out = out.split(s).join("(hidden)");
    return out;
}
