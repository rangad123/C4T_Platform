/**
 * Object repository: the model of a named, shared UI element.
 *
 * An element is a named locator that tests can refer to (`{ ref: "Cart / Checkout button" }`). Everything here is pure text work,
 * so the same rules check an element typed into the UI, one imported from a file and one proposed by the extraction.
 */
import { z } from "zod";
import { controlTypeOf, DESKTOP_CONTROL_TYPES } from "../desktop/target.js";
import { LocatorSchema, type Locator } from "../spec/schema.js";

export const ELEMENT_KINDS = ["web", "mobile", "desktop"] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

export const MAX_ELEMENTS = 1000;
export const NAME_MAX = 80;
export const PAGE_MAX = 80;
export const NOTES_MAX = 300;
export const VALUE_MAX = 500;
/** Other ways to find one element (see `ElementInputSchema.alternatives`). */
export const MAX_ALTERNATIVES = 4;

/** Words, digits and a few separators: the name is shown in the UI and in messages, never pasted into a script. */
const NAME_CHARS = /^[\p{L}\p{N}][\p{L}\p{N} _.\-/&'()+,:]*$/u;

/** The name as it is stored: no spaces at the ends, one space between words. */
export const normalizeName = (s: string): string => s.trim().replace(/\s+/g, " ");

/** Names are unique per project ignoring case, so "Cart / Checkout" and "cart / checkout" cannot both exist. */
export const nameKey = (name: string): string => name.toLowerCase();

/** What is wrong with a name, in words a person can act on (undefined = fine). Expects an already normalized name. */
export function nameProblem(name: string): string | undefined {
    if (!name) return "Give the element a name.";
    if (name.length > NAME_MAX) return `Names can have at most ${NAME_MAX} characters.`;
    if (!NAME_CHARS.test(name)) return "Names start with a letter or a number and use letters, numbers, spaces and these characters only: / . - _ & ' ( ) + , :";
    return undefined;
}

const clean = (s: string | undefined, max: number): string | undefined => {
    const t = (s ?? "").trim();
    return t === "" ? undefined : t.slice(0, max);
};

const PROBLEM = {
    role: "A role locator needs the role (for example button, link or textbox).",
    value: "This kind of locator needs a value to look for.",
} as const;

/** What is wrong with a locator for an element of this kind (undefined = fine). The strategies are the ones specs already use. */
export function locatorProblem(kind: ElementKind, l: Locator): string | undefined {
    if (l.value !== undefined && l.value.length > VALUE_MAX) return `The value can have at most ${VALUE_MAX} characters.`;
    if (l.nth !== undefined && l.nth > 100) return "The position (nth) can be at most 100.";
    if (kind === "desktop") {
        if (l.by === "css" || l.by === "placeholder") return `Desktop elements can't be found by ${l.by}. Use testId (the automation id), label or text (the element's name) or role (the control type).`;
        if (l.by === "role") return controlTypeOf(l.role) ? undefined : `"${l.role ?? ""}" isn't a control type. Use one of: ${DESKTOP_CONTROL_TYPES.join(", ")}.`;
        if (!l.value) return PROBLEM.value;
        if (l.role !== undefined && !controlTypeOf(l.role)) return `"${l.role}" isn't a control type. Use one of: ${DESKTOP_CONTROL_TYPES.join(", ")}.`;
        return undefined;
    }
    if (l.by === "role") {
        if (!l.role || !/^[a-z][a-z-]{0,40}$/i.test(l.role)) return PROBLEM.role;
        return undefined;
    }
    if (!l.value) return PROBLEM.value;
    if (l.role !== undefined) return "Only a role locator has a role.";
    return undefined;
}

/** An element as a person or a file gives it. `locator` is the same shape a spec step uses. */
export const ElementInputSchema = z.object({
    name: z.string().min(1, "Give the element a name.").max(200).transform(normalizeName),
    kind: z.enum(ELEMENT_KINDS),
    locator: LocatorSchema.strict("An element's locator is a concrete locator (by, role, value, exact, nth), not a reference."),
    page: z.string().max(200).optional(),
    notes: z.string().max(2000).optional(),
    /** Other ways to find the same element (a repair without AI tries them when the locator finds nothing). Never rendered into a script. */
    alternatives: z.array(LocatorSchema.strict("Another way to find the element is a concrete locator (by, role, value, exact, nth).")).max(MAX_ALTERNATIVES, `An element can have at most ${MAX_ALTERNATIVES} other ways to find it.`).optional(),
});
export type ElementInput = z.infer<typeof ElementInputSchema>;

/** The element with every rule applied, or the first problem in plain words. */
export function checkElement(input: unknown): { ok: true; element: { name: string; kind: ElementKind; locator: Locator; page?: string; notes?: string; alternatives?: Locator[] } } | { ok: false; error: string } {
    const r = ElementInputSchema.safeParse(input);
    if (!r.success) {
        const i = r.error.issues[0]!;
        const where = i.path.length ? `${i.path.join(".")}: ` : "";
        return { ok: false, error: `${where}${i.message}` };
    }
    const { name, kind, locator, page, notes } = r.data;
    const bad = nameProblem(name) ?? locatorProblem(kind, locator);
    if (bad) return { ok: false, error: bad };
    // Other ways to find it: each one checked like the locator, without duplicates and without the locator itself.
    const alternatives: Locator[] = [];
    for (const a of r.data.alternatives ?? []) {
        const wrong = locatorProblem(kind, a);
        if (wrong) return { ok: false, error: `Another way to find the element: ${wrong}` };
        const t = tidy(a);
        const key = locatorKey(kind, t);
        if (key !== locatorKey(kind, locator) && !alternatives.some((x) => locatorKey(kind, x) === key)) alternatives.push(t);
    }
    const pageText = clean(page, PAGE_MAX);
    if (page !== undefined && page.trim().length > PAGE_MAX) return { ok: false, error: `The page can have at most ${PAGE_MAX} characters.` };
    if (notes !== undefined && notes.trim().length > NOTES_MAX) return { ok: false, error: `Notes can have at most ${NOTES_MAX} characters.` };
    const noteText = clean(notes, NOTES_MAX);
    return { ok: true, element: { name, kind, locator: tidy(locator), ...(pageText ? { page: pageText } : {}), ...(noteText ? { notes: noteText } : {}), ...(alternatives.length ? { alternatives } : {}) } };
}

/** The locator with its keys in a fixed order and without empty ones, so equal locators are stored (and compared) alike. */
export function tidy(l: Locator): Locator {
    return {
        by: l.by,
        ...(l.role !== undefined ? { role: l.role } : {}),
        ...(l.value !== undefined ? { value: l.value } : {}),
        ...(l.exact ? { exact: true } : {}),
        ...(l.nth !== undefined ? { nth: l.nth } : {}),
    };
}

/** Same element, whatever the order of keys or an `exact: false`. Provenance (`ref`) is not part of the identity. */
export const locatorKey = (kind: ElementKind, l: Locator): string => JSON.stringify([kind, l.by, l.role ?? null, l.value ?? null, l.exact ?? false, l.nth ?? null]);

const ordinal = (n: number): string => {
    const v = n % 100;
    if (v >= 11 && v <= 13) return `${n}th`;
    return `${n}${["th", "st", "nd", "rd"][n % 10 > 3 ? 0 : n % 10] ?? "th"}`;
};

/** The locator in words: `Button "Add to cart"`, `Test id: checkout`. */
export function describeLocatorWords(l: Locator): string {
    const v = l.value ?? "";
    const q = `"${v}"`;
    let out: string;
    switch (l.by) {
        case "role": {
            const role = (l.role ?? "element").replace(/^./, (c) => c.toUpperCase());
            out = v ? `${role} ${q}` : role;
            break;
        }
        case "label":
            out = `Field labelled ${q}`;
            break;
        case "text":
            out = `Text ${q}`;
            break;
        case "placeholder":
            out = `Field with the hint ${q}`;
            break;
        case "testId":
            out = `Test id: ${v}`;
            break;
        case "css":
            out = `CSS selector: ${v}`;
            break;
        default:
            out = "Element";
    }
    return l.nth !== undefined ? `${out}, ${ordinal(l.nth + 1)} match` : out;
}
