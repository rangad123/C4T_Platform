/**
 * Reading an almost-valid structured answer (task R, PHASE_5_7_SPEC §4): a model that wraps its JSON in `<think>` blocks, code fences or
 * prose, or whose answer was cut off, need not lose the call. Pure; the caller (provider.ts `structured()`) decides when to use it.
 *
 * Never weaker than the schema: whatever is returned is the original schema's own parse of the value, so an accepted answer passes exactly
 * the validation the model's first answer had to pass. Per-item salvage keeps the valid items of one declared list and says how many it
 * dropped; it is only for lists of independent items, never for objects whose parts refer to each other.
 */
import { z } from "zod";

/** What was done to make the answer usable: `cleaned` (wrapping removed), `salvaged` (a cut-off list closed after its last whole item), `partial` (bad items dropped). */
export type ToleranceKind = "cleaned" | "salvaged" | "partial";

export interface Tolerated {
    value: unknown;
    kind: ToleranceKind;
    /** Items of the declared list that were left out (invalid, or cut off: at least 1 for a salvaged answer). */
    dropped: number;
}

/** At most this many candidate values are read out of one answer (prose with many brackets cannot make this slow). */
const MAX_CANDIDATES = 20;

/** The answer without leading `<think>…</think>` blocks and code-fence lines (a JSON string holds no line break, so no fence line is inside one). */
export function stripWrapping(text: string): string {
    return text.replace(/^(\s*<think>[\s\S]*?<\/think>)+/i, "").replace(/^\s*```[a-z]*\s*$/gim, "");
}

interface Scan {
    /** Where the value ends (exclusive), or -1 when the text ends first. */
    end: number;
    /** For a value the text cut off: the text up to its last complete part, closed (undefined when there is no such point). */
    closed?: string;
}

/** Reads one JSON object or array from `start` (a `{` or `[`), string-aware, to its matching close. */
function scan(text: string, start: number): Scan {
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    let cut: { at: number; open: string[] } | undefined;
    const close = (open: string[]) => open.map((c) => (c === "{" ? "}" : "]")).reverse().join("");
    for (let i = start; i < text.length; i++) {
        const ch = text[i]!;
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === "{" || ch === "[") {
            stack.push(ch);
            cut = { at: i + 1, open: [...stack] };
        } else if (ch === "}" || ch === "]") {
            if (stack.pop() !== (ch === "}" ? "{" : "[")) return { end: -2 };
            if (!stack.length) return { end: i + 1 };
            cut = { at: i + 1, open: [...stack] };
        } else if (ch === ",") cut = { at: i, open: [...stack] };
    }
    // Cut off: keep what was complete before the last comma or bracket (a half-written string or number is never kept).
    return { end: -1, closed: cut ? text.slice(start, cut.at) + close(cut.open) : undefined };
}

const parse = (s: string): { ok: true; value: unknown } | { ok: false } => {
    try {
        return { ok: true, value: JSON.parse(s) };
    } catch {
        return { ok: false };
    }
};

/** The JSON values in an answer, outermost first, and whether the last one was cut off (then closed after its last complete part). */
export function candidates(text: string): Array<{ value: unknown; truncated: boolean }> {
    const t = stripWrapping(text);
    const out: Array<{ value: unknown; truncated: boolean }> = [];
    let i = t.search(/[{[]/);
    while (i >= 0 && out.length < MAX_CANDIDATES) {
        const s = scan(t, i);
        if (s.end === -1) {
            const v = s.closed ? parse(s.closed) : { ok: false as const };
            if (v.ok) out.push({ value: v.value, truncated: true });
            break;
        }
        const v = s.end > 0 ? parse(t.slice(i, s.end)) : { ok: false as const };
        if (v.ok) out.push({ value: v.value, truncated: false });
        const next = t.slice(s.end > 0 ? s.end : i + 1).search(/[{[]/);
        i = next < 0 ? -1 : (s.end > 0 ? s.end : i + 1) + next;
    }
    return out;
}

/** The element schema of `schema`'s list `items` (a top-level array property), when there is one. */
function itemSchema(schema: z.ZodTypeAny, items: string): z.ZodTypeAny | undefined {
    const field = schema instanceof z.ZodObject ? (schema.shape as Record<string, z.ZodTypeAny>)[items] : undefined;
    return field instanceof z.ZodArray ? (field.element as z.ZodTypeAny) : undefined;
}

/**
 * A usable value from an answer the schema refused, or undefined. In order: each JSON value found in the text (wrapping removed) against
 * the schema; with `items`, the same value with the list's invalid items dropped. A cut-off answer is used only with `items` and only when
 * at least one whole item is left (an object that lost its end cannot say what it lost; the caller asks again for a shorter answer).
 */
export function tolerate(text: string, schema: z.ZodTypeAny, items?: string): Tolerated | undefined {
    const element = items ? itemSchema(schema, items) : undefined;
    for (const c of candidates(text)) {
        if (c.truncated && !element) continue;
        if (!c.truncated) {
            const whole = schema.safeParse(c.value);
            if (whole.success) return { value: whole.data, kind: "cleaned", dropped: 0 };
        }
        if (!element || !items) continue;
        const obj = c.value as Record<string, unknown> | null;
        const list = obj && typeof obj === "object" && !Array.isArray(obj) ? obj[items] : undefined;
        if (!Array.isArray(list)) continue;
        const kept = list.filter((x) => element.safeParse(x).success);
        if (c.truncated && !kept.length) continue;
        const invalid = list.length - kept.length;
        if (!c.truncated && !invalid) continue;
        const again = schema.safeParse({ ...obj, [items]: kept });
        if (!again.success) continue;
        const dropped = c.truncated ? Math.max(invalid, 1) : invalid;
        return { value: again.data, kind: c.truncated ? "salvaged" : "partial", dropped };
    }
    return undefined;
}
