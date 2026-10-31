/**
 * Harmless test data for the fields the AI fills while exploring. A small deterministic table: the AI model is never asked what to type, and
 * whatever it proposes for an ordinary field is replaced by the value of this table, so real-looking personal data cannot appear in a test.
 *
 * The values are reserved for examples (example.com, the 555-01xx telephone range) or plainly made up.
 */
import type { ScreenElement } from "../device/types.js";

export type FieldKind = "email" | "username" | "name" | "firstName" | "lastName" | "phone" | "search" | "number" | "zip" | "city" | "street" | "text";

export const FAKE_VALUES: Record<Exclude<FieldKind, "search">, string> = {
    email: "test@example.com",
    username: "testuser",
    name: "Test User",
    firstName: "Test",
    lastName: "User",
    phone: "5550100",
    number: "2",
    zip: "00000",
    city: "Testville",
    street: "1 Test Street",
    text: "Test",
};

/** Search words, taken in turn so two searches in one exploration differ. */
export const SEARCH_WORDS = ["test", "phone", "book", "shoes", "coffee"] as const;

/** Every value the table can produce (a value outside this set never comes from here). */
export const ALL_FAKE_VALUES: ReadonlySet<string> = new Set([...Object.values(FAKE_VALUES), ...SEARCH_WORDS]);

const has = (hay: string, re: RegExp) => re.test(hay);

/** What a field is for, judged from its own name, label and resource id. */
export function fieldKindOf(e: Pick<ScreenElement, "text" | "desc" | "id">): FieldKind {
    const h = `${e.id} ${e.desc} ${e.text}`.toLowerCase().replace(/[_\-.]/g, " ");
    if (has(h, /e ?mail/)) return "email";
    if (has(h, /search|query|find|suche/)) return "search";
    if (has(h, /user ?name|login|user id|account/)) return "username";
    if (has(h, /first ?name|given name|vorname/)) return "firstName";
    if (has(h, /last ?name|surname|family name|nachname/)) return "lastName";
    if (has(h, /phone|mobile|tel\b|telephone/)) return "phone";
    if (has(h, /zip|postal|post ?code/)) return "zip";
    if (has(h, /city|town/)) return "city";
    if (has(h, /street|address/)) return "street";
    if (has(h, /name/)) return "name";
    if (has(h, /qty|quantity|number|amount|age|count|\bno\b/)) return "number";
    return "text";
}

/** The value to type into an ordinary field. `nth` is how many searches were typed before. */
export function fakeValueFor(e: Pick<ScreenElement, "text" | "desc" | "id">, nth = 0): string {
    const kind = fieldKindOf(e);
    return kind === "search" ? SEARCH_WORDS[nth % SEARCH_WORDS.length]! : FAKE_VALUES[kind];
}
