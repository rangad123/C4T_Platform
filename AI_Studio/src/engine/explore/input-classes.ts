/**
 * Input classes from a field's constraints (testing-engine Phase 3), without AI: the values an exploration types into a form field to
 * check that the form keeps its stated constraints. From the field's DOM or document constraints (required, type, min, max, minlength,
 * maxlength, pattern, options):
 *
 * - empty;
 * - invalid format by type (email, url, number, date), a value outside the listed options, a value that breaks the pattern;
 * - boundary -1 / at / +1 for each numeric (min, max: number, range, date by one calendar day) or length limit (minlength, maxlength);
 * - long: maxlength + 1 characters, or 1,000 when nothing limits the length;
 * - unicode: a combining mark, a right-to-left script, an emoji.
 *
 * Each class's expected result is worked out from the constraints with the browser's own rules (an empty optional value skips every other
 * check; lengths count UTF-16 code units; a pattern matches the whole value): "refused" names the constraint the value breaks, "accepted"
 * at a boundary names the limit it sits on. Both are `stated`. A class no constraint speaks to (empty on an optional field, long and
 * unicode without a limit) is `inferred`: nothing states the result, so it is the expected default, not a source's claim.
 *
 * Constraints are page data: a limit cannot make a value longer than INPUT_VALUE_MAX (the class is left out), and a pattern that is not a
 * valid expression or could backtrack without end (a quantified group holding a quantifier or an alternative) is ignored, never run.
 */
import type { ObjectiveField } from "./objectives.js";

export const INPUT_CLASS_KINDS = ["empty", "invalid_format", "boundary", "long", "unicode"] as const;
export type InputClassKind = (typeof INPUT_CLASS_KINDS)[number];
export type InputLimit = "min" | "max" | "minLength" | "maxLength";

export interface InputClass {
    /** `<source ref>#<class>[:<variant>][:<limit>]`: unique within one field. */
    key: string;
    class: InputClassKind;
    /** invalid_format: email | url | number | date | option | pattern; boundary: below | at | above; unicode: combining | rtl | emoji. */
    variant?: string;
    /** The limit a boundary (or a capped long value) comes from. */
    limit?: InputLimit;
    value: string;
    expected: "accepted" | "refused";
    /** One sentence: what the form should do with the value, and the constraint that says so. */
    expectedText: string;
    /** stated: a constraint decides the result; inferred: nothing states it. */
    basis: "stated" | "inferred";
    /** The field's source ref (the objective's) and, when stated, the constraint that decides. */
    source: { ref: string; constraint?: string };
}

/** No value is longer than this, whatever the page declares. */
export const INPUT_VALUE_MAX = 10_000;
/** The long value when nothing limits the length. */
const LONG_UNLIMITED = 1000;
/** Length of the unicode values when the limits allow it. */
const UNICODE_LENGTH = 8;

/** Types whose value is text: length limits and a pattern apply (HTML). */
const TEXT_LIKE = new Set(["", "text", "search", "tel", "password", "email", "url", "textarea"]);
const NUMERIC = new Set(["number", "range"]);
/** Controls nobody types a value into. */
const NO_VALUE = new Set(["hidden", "submit", "button", "reset", "image"]);

const INVALID_FORMAT: Record<string, string> = { email: "not-an-email", url: "not a url", number: "abc", date: "2024-02-30" };

/** The browser's own email check (HTML living standard). */
const EMAIL = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const NUMBER = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const DATE = /^(\d{4,})-(\d{2})-(\d{2})$/;

const UNICODE_UNITS = { combining: "é", rtl: "שלום", emoji: "\u{1F600}" } as const;

const clip = (t: string, n: number) => (t.length <= n ? t : `${t.slice(0, n - 1)}…`);

function validUrl(v: string): boolean {
    try {
        new URL(v);
        return true;
    } catch {
        return false;
    }
}

const dayMs = 86_400_000;
function parseDate(v: string): number | undefined {
    const m = DATE.exec(v);
    if (!m) return undefined;
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v ? t : undefined;
}
const formatDate = (t: number) => new Date(t).toISOString().slice(0, 10);
const formatNumber = (n: number) => String(Number(n.toPrecision(12)));

/** A quantified group that holds a quantifier or an alternative can backtrack without end: never run it on page-supplied text. */
const RISKY_PATTERN = /\((?:[^()\\]|\\.)*(?:[+*?}|])(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d*,)/;
function compilePattern(p: string | undefined): RegExp | undefined {
    if (!p || p.length > 500 || RISKY_PATTERN.test(p)) return undefined;
    try {
        return new RegExp(`^(?:${p})$`, "v");
    } catch {
        return undefined;
    }
}

interface Field {
    type: string;
    required: boolean;
    options?: readonly string[];
    pattern?: RegExp;
    patternText?: string;
    minLength?: number;
    maxLength?: number;
    min?: string;
    max?: string;
}

const describe = {
    required: () => "a value is required",
    type: (t: string) => `the value must be a valid ${t}`,
    options: () => "the value must be one of the listed options",
    min: (v: string) => `at least ${clip(v, 100)}`,
    max: (v: string) => `at most ${clip(v, 100)}`,
    minLength: (n: number) => `at least ${n} characters`,
    maxLength: (n: number) => `at most ${n} characters`,
    pattern: (p: string) => `it must match the pattern "${clip(p, 200)}"`,
};

/** The first stated constraint the value breaks, by the browser's rules; undefined when the form should accept it. */
function broken(f: Field, value: string): string | undefined {
    if (value === "") return f.required ? describe.required() : undefined;
    if (f.options) return f.options.includes(value) ? undefined : describe.options();
    if (NUMERIC.has(f.type)) {
        if (!NUMBER.test(value)) return describe.type("number");
        const n = Number(value);
        if (f.min !== undefined && Number.isFinite(Number(f.min)) && n < Number(f.min)) return describe.min(f.min);
        if (f.max !== undefined && Number.isFinite(Number(f.max)) && n > Number(f.max)) return describe.max(f.max);
        return undefined;
    }
    if (f.type === "date") {
        const t = parseDate(value);
        if (t === undefined) return describe.type("date");
        const lo = f.min !== undefined ? parseDate(f.min) : undefined;
        const hi = f.max !== undefined ? parseDate(f.max) : undefined;
        if (lo !== undefined && t < lo) return describe.min(f.min!);
        if (hi !== undefined && t > hi) return describe.max(f.max!);
        return undefined;
    }
    if (!TEXT_LIKE.has(f.type)) return undefined;
    if (f.type === "email" && !EMAIL.test(value)) return describe.type("email");
    if (f.type === "url" && !validUrl(value)) return describe.type("url");
    if (f.minLength !== undefined && value.length < f.minLength) return describe.minLength(f.minLength);
    if (f.maxLength !== undefined && value.length > f.maxLength) return describe.maxLength(f.maxLength);
    if (f.pattern && !f.pattern.test(value)) return describe.pattern(f.patternText!);
    return undefined;
}

/** A value of exactly `n` characters with the field's format (and its pattern when a filler fits it); undefined when none can be built. */
function ofLength(f: Field, n: number): string | undefined {
    if (n < 1 || n > INPUT_VALUE_MAX) return undefined;
    const build = (fill: string): string | undefined => {
        if (f.type === "email") return n >= 6 ? `${fill.repeat(n - 5)}@x.io` : undefined;
        if (f.type === "url") return n >= 13 ? `https://x.io/${fill.repeat(n - 13)}` : undefined;
        return fill.repeat(n);
    };
    const fillers = ["a", "1", "A", "x", "0"];
    const first = build(fillers[0]!);
    if (!first || !f.pattern) return first;
    for (const fill of fillers) {
        const v = build(fill)!;
        if (f.pattern.test(v)) return v;
    }
    return first;
}

/** Whole units of `unit` up to `n` characters, padded with "a" to exactly `n`; undefined when not one unit fits. */
function unicodeOf(unit: string, n: number): string | undefined {
    const chars = [...unit.repeat(Math.ceil(n / unit.length) + 1)];
    let out = "";
    for (const c of chars) {
        if (out.length + c.length > n) break;
        out += c;
    }
    // A combining mark belongs to the letter before it: never end on a bare base letter cut from its mark.
    if (unit === UNICODE_UNITS.combining && out.length % 2 === 1) out = out.slice(0, -1);
    if (!out) return undefined;
    return out + "a".repeat(n - out.length);
}

/**
 * The input classes of one field, in a fixed order (empty, invalid formats, boundaries min/max/minLength/maxLength, long, unicode), each
 * with its expected result and `ref`. Same field, same classes.
 */
export function inputClassesFor(field: ObjectiveField, ref: string): InputClass[] {
    const type = (field.type ?? "text").trim().toLowerCase();
    if (NO_VALUE.has(type)) return [];
    const nonNeg = (n: number | undefined) => (n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined);
    const f: Field = {
        type: type === "select" || type === "select-one" ? "select" : type,
        required: field.required === true,
        options: field.options?.length ? field.options : undefined,
        pattern: compilePattern(field.pattern),
        patternText: field.pattern,
        minLength: nonNeg(field.minLength),
        maxLength: nonNeg(field.maxLength),
        min: field.min?.trim() || undefined,
        max: field.max?.trim() || undefined,
    };
    const textLike = !f.options && TEXT_LIKE.has(f.type);
    const out: InputClass[] = [];

    const add = (cls: InputClassKind, value: string | undefined, o: { variant?: string; limit?: InputLimit; limitText?: string; capAt?: number } = {}) => {
        if (value === undefined || value.length > INPUT_VALUE_MAX) return;
        const why = broken(f, value);
        const stated = why !== undefined || cls === "boundary" || cls === "invalid_format";
        const constraint = why ?? (stated ? o.limitText : undefined);
        const expectedText =
            why !== undefined
                ? `The form refuses the value and says why (${why})${o.capAt !== undefined ? `, or stops input at ${o.capAt} characters` : ""}.`
                : stated
                  ? `The form accepts the value: it is within the stated limit (${o.limitText}).`
                  : "No stated constraint refuses this value, so the form is expected to accept it (inferred, not stated by a source).";
        out.push({
            key: [`${ref}#${cls}`, o.variant, o.limit].filter(Boolean).join(":"),
            class: cls,
            ...(o.variant ? { variant: o.variant } : {}),
            ...(o.limit ? { limit: o.limit } : {}),
            value,
            expected: why === undefined ? "accepted" : "refused",
            expectedText,
            basis: stated ? "stated" : "inferred",
            source: constraint ? { ref, constraint } : { ref },
        });
    };

    add("empty", "");

    // Invalid formats.
    if (f.options) {
        let v = "not-an-option";
        while (f.options.includes(v)) v += "-x";
        add("invalid_format", v, { variant: "option" });
    } else {
        const format = INVALID_FORMAT[NUMERIC.has(f.type) ? "number" : f.type];
        if (format) add("invalid_format", format, { variant: NUMERIC.has(f.type) ? "number" : f.type });
        if (textLike && f.pattern) {
            const n = Math.max(f.minLength ?? 1, Math.min(3, f.maxLength ?? 3));
            const v = ["!", "a", "1", "-", "_"].map((c) => c.repeat(n)).find((c) => !f.pattern!.test(c));
            add("invalid_format", v, { variant: "pattern" });
        }
    }

    // Numeric limits: one step (1, or a calendar day) each side.
    const numericLimit = (limit: "min" | "max", raw: string | undefined) => {
        if (raw === undefined) return;
        const text = limit === "min" ? describe.min(raw) : describe.max(raw);
        if (NUMERIC.has(f.type)) {
            const n = Number(raw);
            if (!NUMBER.test(raw) || !Number.isFinite(n)) return;
            for (const [variant, d] of [["below", -1], ["at", 0], ["above", 1]] as const) add("boundary", formatNumber(n + d), { variant, limit, limitText: text });
        } else if (f.type === "date") {
            const t = parseDate(raw);
            if (t === undefined) return;
            for (const [variant, d] of [["below", -1], ["at", 0], ["above", 1]] as const) add("boundary", formatDate(t + d * dayMs), { variant, limit, limitText: text });
        }
    };
    if (!f.options) {
        numericLimit("min", f.min);
        numericLimit("max", f.max);
    }

    // Length limits. A length of 0 is the empty class, which skips the other checks.
    if (textLike) {
        for (const limit of ["minLength", "maxLength"] as const) {
            const n = f[limit];
            if (n === undefined) continue;
            const limitText = limit === "minLength" ? describe.minLength(n) : describe.maxLength(n);
            for (const [variant, d] of [["below", -1], ["at", 0], ["above", 1]] as const) {
                const capAt = limit === "maxLength" && variant === "above" ? n : undefined;
                add("boundary", ofLength(f, n + d), { variant, limit, limitText, capAt });
            }
        }
        if (f.maxLength !== undefined) add("long", ofLength(f, f.maxLength + 1), { limit: "maxLength", capAt: f.maxLength });
        else add("long", ofLength(f, LONG_UNLIMITED));

        const n = Math.max(f.minLength ?? 0, Math.min(UNICODE_LENGTH, f.maxLength ?? UNICODE_LENGTH));
        if (n <= INPUT_VALUE_MAX) for (const [variant, unit] of Object.entries(UNICODE_UNITS)) add("unicode", unicodeOf(unit, n), { variant });
    }
    return out;
}
