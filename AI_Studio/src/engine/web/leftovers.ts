/**
 * The leftover check (queue row 181, second commit): deterministic, no AI. A saved test that acts on, or checks, an item its own
 * earlier steps never added or opened leans on what the account held before it ran: a cart line an earlier test left, a discount an
 * earlier test applied. On a fresh replay that item is not there, so the test is broken, not a finding.
 *
 * "Introduced" means an earlier step of the same test names the item: in a locator, a typed value, an address or its description
 * (the test writer describes the product it adds: "Add Water Bottle to cart"). A removal step introduces nothing. Items of the
 * application's starting data that every fresh session sees (the catalogue, seeded orders) are left alone because the rule only
 * looks at what changes account state or belongs to it:
 *   - a remove, delete, discard, update or edit control inside a named item (a row, a list item), or a click on a named table row;
 *   - an unnamed remove, delete or empty control before any earlier step added or created anything;
 *   - a check of a named item that carries its own remove or delete control (a cart line, not a catalogue card);
 *   - a check of a discount, coupon, promo or voucher naming a code (SAVE10) that no earlier step typed or named.
 * Reading a catalogue card, opening a product by its link, or asserting a seeded order's cells is never flagged.
 */
import type { Locator, Step } from "../spec/schema.js";

export interface LeftoverUse {
    /** 1-based step number. */
    step: number;
    /** What the step does with it, in plain words. */
    what: string;
}

/** Containers that are one item of a list the account can hold (a table row, a list item, a card). */
const ITEM_ROLES = new Set(["row", "listitem", "article", "option", "treeitem", "gridcell"]);
/** Controls that remove or change the item they are inside. */
const CHANGE_CONTROL = /^\s*(remove|delete|discard|update|edit)\b/i;
/** Controls that empty what the account holds, even when no item is named. */
const REMOVE_CONTROL = /^\s*(remove|delete|empty)\b/i;
/** Controls that add or create something: after one, an unnamed removal may be removing it. */
const ADD_CONTROL = /\b(add|create|new|save|submit|apply|place|post|upload|insert|buy|book|send|register|sign up)\b/i;
/** An item whose own name carries a removal control: a line the account holds. */
const REMOVABLE_ITEM = /\b(remove|delete)\b/i;
const OFFER_WORD = /\b(discount|coupon|promo|promotion|voucher)\b/i;
/** A code as shops print them: capitals then digits (SAVE10, WELCOME20). */
const CODE_TOKEN = /\b[A-Z]{2,}\d+[A-Z0-9]*\b/g;
/** Keys whose values are vocabulary, not names the test typed or chose. */
const VOCABULARY = new Set(["action", "by", "role", "check", "source", "until", "compare", "from", "set", "response"]);

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The item name a long accessible name starts with: "Water Bottle $18.00 Quantity 1 Update $18.00 Remove" is "Water Bottle". */
function head(name: string): string {
    const words = name.trim().split(/\s+/);
    const cut = words.findIndex((w, i) => i > 0 && /^[$€£¥₹\d]/.test(w));
    const h = (cut > 0 ? words.slice(0, cut) : words).join(" ");
    return h.length >= 2 ? h : name.trim();
}

/** Every string a step carries (names, typed values, addresses, its description), lower-cased. */
function stringsOf(value: unknown, into: string[] = []): string[] {
    if (typeof value === "string") into.push(norm(value));
    else if (Array.isArray(value)) for (const v of value) stringsOf(v, into);
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) if (!VOCABULARY.has(k)) stringsOf(v, into);
    return into;
}

/** The named item a locator is, or is inside: its row/list-item name, or the text its filter keeps. */
function itemOf(l: Locator | undefined): string | undefined {
    if (!l) return undefined;
    if (l.filter?.hasText) return l.filter.hasText;
    if (l.within?.by === "role" && ITEM_ROLES.has(l.within.role ?? "") && l.within.value) return l.within.value;
    if (l.by === "role" && ITEM_ROLES.has(l.role ?? "") && l.value) return l.value;
    return undefined;
}

const locatorOf = (s: Step): Locator | undefined => ("locator" in s && s.locator && typeof s.locator === "object" && "by" in s.locator ? (s.locator as Locator) : undefined);

/** The steps of a saved test that act on or check an item its own earlier steps never added or opened; empty when there are none. */
export function findLeftoverUse(steps: readonly Step[]): LeftoverUse[] {
    const found: LeftoverUse[] = [];
    const seen: string[] = [];
    let added = false;
    const introduced = (name: string) => {
        const h = norm(head(name));
        return seen.some((s) => s.includes(h));
    };
    steps.forEach((s, i) => {
        const l = locatorOf(s);
        const control = l?.value ?? "";
        const item = itemOf(l);
        const isRemoval = s.action === "click" && REMOVE_CONTROL.test(control);
        if (s.action === "click" && l) {
            const own = l.by === "role" && l.role === "row" && l.value && !l.within && !l.filter ? l.value : undefined;
            const changes = CHANGE_CONTROL.test(control);
            if (changes && item && !introduced(item)) found.push({ step: i + 1, what: `${/^\s*(update|edit)/i.test(control) ? "changes" : "removes"} "${item.trim()}"` });
            else if (own && !introduced(own)) found.push({ step: i + 1, what: `clicks the row "${own.trim()}"` });
            else if (isRemoval && !item && !added) found.push({ step: i + 1, what: `presses "${control.trim()}" before the test added anything` });
        }
        if (s.action === "assert") {
            if (item && REMOVABLE_ITEM.test(item) && !introduced(item)) found.push({ step: i + 1, what: `checks "${head(item)}", a line the account held` });
            const text = [...stringsOf(l), typeof s.expected === "string" ? s.expected : ""].join(" ");
            const raw = [l?.value, l?.filter?.hasText, l?.within?.value, typeof s.expected === "string" ? s.expected : undefined].filter((x): x is string => typeof x === "string").join(" ");
            if (OFFER_WORD.test(text)) {
                const code = [...raw.matchAll(CODE_TOKEN)].map((m) => m[0]).find((c) => !seen.some((x) => x.includes(c.toLowerCase())));
                if (code) found.push({ step: i + 1, what: `checks the code ${code}, which the test never applied` });
            }
        }
        // A removal step introduces nothing: describing a leftover it clears does not make it the test's own.
        if (!isRemoval && !(s.action === "click" && CHANGE_CONTROL.test(control) && item)) seen.push(...stringsOf(s));
        if (s.action === "click" && ADD_CONTROL.test(control)) added = true;
    });
    return found;
}

/** What the test writer is told when its test leaned on leftovers, and what a test saved for review says. */
export function leftoverReason(uses: readonly LeftoverUse[]): string {
    const listed = uses.slice(0, 4).map((u) => `step ${u.step} ${u.what}`).join("; ");
    return `The test depends on what the account held before it ran: ${listed}${uses.length > 4 ? `; and ${uses.length - 4} more` : ""}. No earlier step of the test added or opened what it uses, so on a fresh run it is not there.`;
}

/** The instruction for a second try. */
export const LEFTOVER_REDO =
    "The test account can hold items an earlier test left (cart lines, applied codes). They are not this test's: never remove, change or check them by name, and never clear them first. Add what the test needs with its own steps, then act and assert only on those items.";
