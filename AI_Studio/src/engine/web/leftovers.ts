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
 *
 * Two more rules (queue row 228, from the row 227 triage of the Phase 3 smoke trial):
 *   - a record id (ord-1008: letters, a hyphen, 3+ digits) the test opens, clicks or checks that is not one of the application's
 *     starting records (`startingIds`, read from the discovery model): no step can have made it, since a record the test creates gets
 *     whatever number the application hands out, so it is a record an earlier test left (or this run's number written as a literal).
 *     A test that checks such an id is not found is left alone. Off when no starting ids are given;
 *   - once the test has signed in with the provided account ({{credentials...}}) and before any step that adds to it (Add to cart,
 *     Create, Place...): a press of Check out or Place order (or a wait or check that it shows), an Apply of a code just typed into a
 *     discount or coupon field, and a check of an amount on the cart (its page, or a subtotal or discount) other than zero. Those show
 *     only what the shared account already held. Signed out (or in a freshly registered account) the browser is fresh, so what such a
 *     page shows is the application's starting data.
 *
 * Values recorded from the authoring run (paid trials rbac-2 and shop-2: counts 5 and 34, a title and an address from an earlier run):
 *   - an address that opens a record by its number (/notes/n52, /orders/1034) that is not in the application's starting data: the
 *     application numbered it while the test was written, so a fresh run gets another number;
 *   - a run's {{unique}} value (a millisecond time, 1795433813701) in what the test opens or checks: `withOwnUnique` first turns the test's
 *     own back into {{unique}}, so one that is left came from another run;
 *   - on the shared account, a count of 2 or more that the scenario's stated words do not give: it counts what earlier tests left there.
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

/** A record id as shops print them: ord-1008, inv-20391. Lower-case only, so requirement and rule refs (R-033) are not records. */
const RECORD_ID = /\b[a-z]+-\d{3,}\b/g;
/** Controls that add to what the account holds: before one, the account's cart and orders are not the test's. */
const GROW_CONTROL = /\b(add|create|new|place|buy|book|insert|upload|post|register|sign up)\b/i;
/** Controls that are there only when the account holds something (a cart to check out). */
const STATE_CONTROL = /^\s*(check ?out|proceed to checkout|place order)\b/i;
/** A field a code is typed into before Apply. */
const CODE_FIELD = /\b(discount|coupon|promo|promotion|voucher|gift ?card)\b/i;
const APPLY_CONTROL = /^\s*apply\b/i;
const MONEY = /[$€£¥₹]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*\.\d{2}\b/g;
const CART_PLACE = /\b(cart|basket|bag|checkout|check out)\b/i;
const CART_WORDS = /\b(subtotal|discount|cart|basket)\b/i;
/** A value typed from the provided test account: the test works in the shared account, which earlier tests may have filled. */
const SHARED_ACCOUNT = /\{\{\s*credentials\./;
const NOT_FOUND = /\b(not found|404|no such|does not exist|doesn't exist|no longer exists)\b/i;
/** A record number in an address: a path part of up to 4 letters and digits (n52, ord1034) or 2+ digits (1034). */
const PATH_ID = /\/([a-z]{1,4}\d+|\d{2,})(?=$|[/?#\s"'])/gi;
/** A record number in a heading: "Note n17", "Order #1034" (letters then digits, or # then digits). */
const HEADING_ID = /(?<![\w-])#?([a-z]{1,4}\d+)\b|#(\d{2,})\b/gi;
/** A {{unique}} value as a run writes it: the time in milliseconds (2020 to 2033), with the Playwright worker's index after it. */
export const RUN_VALUE = /\b1[6-9]\d{11}\d{0,2}\b/g;
/** Checks that something is absent: on a fresh account that holds, so they are not leaning on leftovers. */
const ABSENCE_CHECKS = new Set(["hidden", "notText", "count"]);

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

/** Every string a step carries except its description and vocabulary, as written (ids are matched case-sensitively). */
function rawStringsOf(value: unknown, into: string[] = []): string[] {
    if (typeof value === "string") into.push(value);
    else if (Array.isArray(value)) for (const v of value) rawStringsOf(v, into);
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) if (!VOCABULARY.has(k) && k !== "description") rawStringsOf(v, into);
    return into;
}

/**
 * Where a step names a record it opens, clicks or checks: an address, a locator's names, a check's expected text. Not typed values
 * (a password like wrong-pass-123 is no record) and not requests (an API test's made-up id is its own).
 */
function whereRecordsShow(s: Step): string[] {
    const l = locatorOf(s);
    const names = [l?.value, l?.filter?.hasText, l?.within?.value];
    if (s.action === "navigate") names.push(s.url);
    if (s.action === "assert" && typeof s.expected === "string") names.push(s.expected);
    return names.filter((x): x is string => typeof x === "string");
}

/**
 * The record ids in a model of the application (its discovery crawl, every string in it): the starting data every fresh session sees.
 * Record numbers of addresses are kept with their slash ("/n1", "/1034").
 */
export function startingIdsOf(model: unknown): Set<string> {
    const ids = new Set<string>();
    const walk = (v: unknown, depth: number): void => {
        if (depth > 40) return;
        if (typeof v === "string") {
            for (const m of v.matchAll(RECORD_ID)) ids.add(m[0]);
            for (const m of v.matchAll(PATH_ID)) ids.add(`/${m[1]!.toLowerCase()}`);
        }
        else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
        else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x, depth + 1);
    };
    walk(model, 0);
    return ids;
}

const locatorOf = (s: Step): Locator | undefined => ("locator" in s && s.locator && typeof s.locator === "object" && "by" in s.locator ? (s.locator as Locator) : undefined);

/**
 * The steps of a saved test that act on or check an item its own earlier steps never added or opened; empty when there are none.
 * `startingIds`: the record ids of the application's starting data (`startingIdsOf` the discovery model); without them record ids are
 * not checked. `stated`: the scenario's own words (its expected results); a count they give is the scenario's, not a recorded one.
 */
export function findLeftoverUse(steps: readonly Step[], startingIds?: ReadonlySet<string>, stated?: string): LeftoverUse[] {
    const found: LeftoverUse[] = [];
    const seen: string[] = [];
    let added = false;
    // Row 228: whether a step has added to the account yet, where the test is (its last address or link), and what it reported once.
    let grew = false;
    let place = "";
    let onStartingRecord = false;
    let lastFill = "";
    let signedIn = false;
    let flaggedControl = false;
    const usedIds = new Set<string>();
    const checksNotFound = steps.some((s) => s.action === "assert" && NOT_FOUND.test(rawStringsOf(s).join(" ")));
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
        // A record id no step could have made: not starting data, so an earlier test's record.
        if (startingIds && !checksNotFound) {
            for (const id of whereRecordsShow(s).flatMap((t) => [...t.matchAll(RECORD_ID)].map((m) => m[0]))) {
                if (startingIds.has(id) || usedIds.has(id)) continue;
                usedIds.add(id);
                found.push({ step: i + 1, what: `uses the record ${id}, which the test never created` });
            }
        }
        // An address's record number the application handed out while the test was written (/notes/n52).
        if (startingIds && !checksNotFound && s.action === "navigate") {
            for (const m of s.url.matchAll(PATH_ID)) {
                const id = `/${m[1]!.toLowerCase()}`;
                if (startingIds.has(id) || usedIds.has(id)) continue;
                usedIds.add(id);
                found.push({ step: i + 1, what: `opens ${s.url.slice(0, 80)}, a record number the test never made` });
            }
        }
        // The same in a check of the address or of a heading (paid trial rbac-5 WEB-027 `url /notes/n17`, rbac-4 WEB-038 `/notes/n25`).
        if (startingIds && !checksNotFound && s.action === "assert") {
            const address = (s.check === "url" || s.check === "urlPattern") && typeof s.expected === "string" ? s.expected : undefined;
            const heading = l?.by === "role" && l.role === "heading" ? `${l.value ?? ""} ${typeof s.expected === "string" ? s.expected : ""}` : undefined;
            const ids = address !== undefined ? [...address.matchAll(PATH_ID)].map((m) => m[1]!) : heading ? [...heading.matchAll(HEADING_ID)].map((m) => m[1] ?? m[2]!) : [];
            for (const raw of ids) {
                const id = `/${raw.toLowerCase()}`;
                // A number the test typed itself (a title) is its own.
                if (startingIds.has(id) || usedIds.has(id) || (heading !== undefined && seen.some((x) => x.includes(raw.toLowerCase())))) continue;
                usedIds.add(id);
                found.push({ step: i + 1, what: `checks ${(address ?? heading!).trim().slice(0, 80)}, a record number the test never made` });
            }
        }
        // A {{unique}} value of another run: this run writes a new one.
        for (const v of whereRecordsShow(s).flatMap((t) => [...t.matchAll(RUN_VALUE)].map((m) => m[0]))) {
            if (usedIds.has(v)) continue;
            usedIds.add(v);
            found.push({ step: i + 1, what: `uses ${v}, a generated value of an earlier run` });
        }
        // A count of what the shared account holds, which earlier tests change, that the scenario does not state.
        if (s.action === "assert" && s.check === "count" && signedIn) {
            const n = Number(s.expected);
            if (Number.isInteger(n) && n >= 2 && !new RegExp(`(^|[^\\d.])${n}($|[^\\d]|\\.(?!\\d))`).test(stated ?? ""))
                found.push({ step: i + 1, what: `expects ${n} items on the shared account, a count its stated results do not give` });
        }
        if (signedIn && !grew && !flaggedControl && l && (l.by === "role" || l.by === "text")) {
            const shows = s.action === "click" || (s.action === "wait" && s.until === "visible") || (s.action === "assert" && (s.check === "visible" || s.check === "enabled"));
            const applies = s.action === "click" && APPLY_CONTROL.test(control) && CODE_FIELD.test(lastFill);
            if ((shows && STATE_CONTROL.test(control)) || applies) {
                flaggedControl = true;
                found.push({ step: i + 1, what: `presses "${control.trim()}" before the test added anything` });
            }
        }
        if (s.action === "assert" && signedIn && !grew && !onStartingRecord && !ABSENCE_CHECKS.has(s.check)) {
            const shown = [l?.value, l?.filter?.hasText, typeof s.expected === "string" ? s.expected : undefined].filter((x): x is string => typeof x === "string").join(" ");
            const amounts = [...shown.matchAll(MONEY)].map((m) => m[0]).filter((a) => /[1-9]/.test(a));
            if (amounts.length && (CART_PLACE.test(place) || CART_WORDS.test(`${shown} ${s.description ?? ""}`)))
                found.push({ step: i + 1, what: `checks the amount ${amounts[0]} before the test added anything` });
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
        if (s.action === "click" && GROW_CONTROL.test(control)) grew = true;
        if (s.action === "fill") {
            lastFill = [l?.value, s.description].join(" ");
            if (SHARED_ACCOUNT.test(s.value)) signedIn = true;
        }
        const goesTo = s.action === "navigate" ? s.url : s.action === "click" && l?.role === "link" ? control : undefined;
        if (goesTo !== undefined) {
            place = goesTo;
            onStartingRecord = !!startingIds && [...goesTo.matchAll(RECORD_ID)].some((m) => startingIds.has(m[0]));
        }
    });
    return found;
}

/**
 * The test's own {{unique}} values written back as {{unique}}: a check or address holding the value a step typed with {{unique}} in it
 * ("Bench note {{unique}}" typed, the link "Bench note 1795433813701" checked) reads the value the run makes, not the authoring run's.
 */
/** The words of a scenario a count may be stated in (findLeftoverUse's `stated`). */
export function scenarioWords(scenario: { description?: string; preconditions?: string[]; requiredData?: string[]; expectedResults?: string[] }): string {
    return [scenario.description ?? "", ...(scenario.preconditions ?? []), ...(scenario.requiredData ?? []), ...(scenario.expectedResults ?? [])].join("\n");
}

export function withOwnUnique(steps: readonly Step[]): Step[] {
    const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const typed = steps.flatMap((s) => (s.action === "fill" && /\{\{\s*unique\s*\}\}/.test(s.value) ? [s.value] : []));
    const patterns = typed.map((v) => new RegExp(v.split(/\{\{\s*unique\s*\}\}/).map(esc).join(`(${RUN_VALUE.source})`), "g"));
    const seen = new Set<string>();
    for (const s of steps) for (const t of whereRecordsShow(s)) for (const re of patterns) for (const m of t.matchAll(re)) for (const d of m.slice(1)) if (d) seen.add(d);
    if (!seen.size) return [...steps];
    const swap = (v: unknown): unknown => {
        if (typeof v === "string") return [...seen].reduce((t, d) => t.split(d).join("{{unique}}"), v);
        if (Array.isArray(v)) return v.map(swap);
        if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, VOCABULARY.has(k) ? x : swap(x)]));
        return v;
    };
    return steps.map((s) => (s.action === "fill" ? s : (swap(s) as Step)));
}

/** What the test writer is told when its test leaned on leftovers, and what a test saved for review says. */
export function leftoverReason(uses: readonly LeftoverUse[]): string {
    const listed = uses.slice(0, 4).map((u) => `step ${u.step} ${u.what}`).join("; ");
    return `The test depends on what the account held before it ran: ${listed}${uses.length > 4 ? `; and ${uses.length - 4} more` : ""}. No earlier step of the test added or opened what it uses, so on a fresh run it is not there.`;
}

/** The instruction for a second try. */
export const LEFTOVER_REDO =
    "The test account can hold items an earlier test left (cart lines, applied codes). They are not this test's: never remove, change or check them by name, and never clear them first. Add what the test needs with its own steps, then act and assert only on those items. Never write down a number the application handed out while you worked (a record's address such as /notes/n52, a generated name, how many items a shared list holds): open what the test made by its own links, and use {{unique}} for generated values.";
