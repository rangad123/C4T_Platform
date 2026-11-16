/**
 * A step that finds a field by its label ("Type ... into the "Email" field") on a page whose fields have no label, only a placeholder
 * (many sites: <input placeholder="Email Address">). Playwright's getByLabel matches the label element, aria-label and aria-labelledby;
 * when none of those match, the field whose placeholder equals or starts with the label is used, but only when exactly one visible
 * editable field has such a placeholder. Never a guess between several: the step then fails at once with a sentence naming the fields
 * the page has, instead of waiting out the action timeout on a locator that can never match.
 *
 * The rendered script (../generators/playwright.ts) and the live interpreter (./interpreter.ts) do the same: both run PICK_FIELD_SOURCE
 * in the page, and the waiting around it is written twice (LABEL_FIELD_HELPER_SOURCE and labelledField below).
 */
import type { FrameLocator, Locator, Page } from "@playwright/test";

/** The elements a person types into or picks from. */
export const FIELD_SELECTOR = "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), textarea, select, [contenteditable=''], [contenteditable=true]";
/** How long a label step waits for its field before it says what the page has. */
export const LABEL_WAIT_MS = 5_000;

/**
 * Runs in the page on the FIELD_SELECTOR elements: { pick } is the one field whose placeholder matches the label, or { message } says
 * why there is none. `ready` is false while the document is still loading (the step keeps waiting then). Plain JavaScript, no types:
 * it is embedded as it is in the rendered script and turned into a function for the interpreter.
 */
export const PICK_FIELD_SOURCE = String.raw`(els, a) => {
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const want = norm(a.label);
    const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const usable = (el) => visible(el) && !el.disabled && !el.readOnly;
    const formOf = (el) => {
        const f = el.closest("form");
        if (!f) return "";
        const action = norm(f.getAttribute("action")).split(/[?#]/)[0].replace(/\/+$/, "").split("/").pop();
        return action || norm(f.id) || norm(f.getAttribute("name")) || norm(f.getAttribute("aria-label"));
    };
    const nameOf = (el) => {
        const aria = norm(el.getAttribute("aria-label"));
        if (aria) return [aria, "label"];
        const label = el.labels && el.labels[0] ? norm(el.labels[0].textContent) : "";
        if (label) return [label, "label"];
        const ph = norm(el.getAttribute("placeholder"));
        if (ph) return [ph, "placeholder"];
        return [norm(el.getAttribute("name")) || el.tagName.toLowerCase(), "name"];
    };
    const matches = (ph) => (a.exact ? ph === want : ph.toLowerCase() === want.toLowerCase() || ph.toLowerCase().startsWith(want.toLowerCase()));
    const fields = els.map((el, i) => ({ i, el, ph: norm(el.getAttribute("placeholder")), form: formOf(el) })).filter((f) => usable(f.el));
    const hits = want ? fields.filter((f) => f.ph && matches(f.ph)) : [];
    const ready = !els.length || els[0].ownerDocument.readyState === "complete";
    if (hits.length === 1) return { pick: hits[0].i, ready };
    const and = (xs) => (xs.length < 2 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1]);
    const groups = [];
    for (const f of fields) {
        const [name, kind] = nameOf(f.el);
        const g = groups.find((x) => x.name === name && x.kind === kind);
        if (g) g.forms.push(f.form);
        else groups.push({ name, kind, forms: [f.form] });
    }
    const where = a.scoped ? "Fields in that part of the page" : "Fields on this page";
    const listed = groups.slice(0, 8).map((g) => {
        const forms = g.forms.filter(Boolean);
        const many = g.forms.length > 1 ? ", " + g.forms.length + " fields" + (forms.length === g.forms.length && new Set(forms).size === forms.length ? ": " + and(forms) : "") : "";
        return JSON.stringify(g.name) + " (" + g.kind + many + ")";
    });
    const more = groups.length > 8 ? ", and " + (groups.length - 8) + " more" : "";
    const list = fields.length ? where + ": " + listed.join(", ") + more + "." : a.scoped ? "That part of the page has no field to type into." : "This page has no field to type into.";
    const head = "No field labelled " + JSON.stringify(want);
    if (hits.length > 1) {
        const phs = [...new Set(hits.map((h) => h.ph))];
        const forms = hits.map((h) => h.form);
        const inForms = forms.every(Boolean) && new Set(forms).size === forms.length ? " in the " + and(forms) + " forms" : "";
        return { ready, ambiguous: true, message: head + ", and " + hits.length + " fields have a placeholder that starts with it (" + phs.map((p) => JSON.stringify(p)).join(", ") + inForms + "), so the step does not pick one. Point the step at one field, for example inside its form or by its placeholder. " + list };
    }
    return { ready, message: head + ". " + list };
}`;

/** The rendered script's copy of labelledField: the step's field, or an error that says what the page has. */
export const LABEL_FIELD_HELPER_SOURCE = String.raw`/** A field found by its label; on a page whose fields have only placeholders, the one field whose placeholder starts with the label (never a guess between several). */
const pickLabelledField = ${PICK_FIELD_SOURCE};
async function labelledField(root: import("@playwright/test").Page | import("@playwright/test").FrameLocator | import("@playwright/test").Locator, label: string, exact: boolean, scoped: boolean): Promise<import("@playwright/test").Locator> {
    const byLabel = root.getByLabel(label, { exact });
    const fields = root.locator(${JSON.stringify(FIELD_SELECTOR)});
    const end = Date.now() + ${LABEL_WAIT_MS};
    for (;;) {
        if ((await byLabel.count()) > 0) return byLabel;
        const r = await fields.evaluateAll(pickLabelledField, { label, exact, scoped });
        if (r.pick !== undefined) return fields.nth(r.pick);
        if ((r.ready && r.ambiguous) || Date.now() > end) throw new Error(r.message);
        await new Promise((done) => setTimeout(done, 250));
    }
}`;

type Picked = { pick?: number; ready: boolean; ambiguous?: boolean; message?: string };
const pickField = new Function(`return ${PICK_FIELD_SOURCE};`)() as (els: Element[], a: { label: string; exact: boolean; scoped: boolean }) => Picked;

/** The interpreter's labelledField (same rule and sentence as the rendered script's). */
export async function labelledField(root: Page | FrameLocator | Locator, label: string, exact: boolean, scoped: boolean, waitMs = LABEL_WAIT_MS): Promise<Locator> {
    const byLabel = root.getByLabel(label, { exact });
    const fields = root.locator(FIELD_SELECTOR);
    const end = Date.now() + waitMs;
    for (;;) {
        if ((await byLabel.count()) > 0) return byLabel;
        const r = await fields.evaluateAll(pickField, { label, exact, scoped });
        if (r.pick !== undefined) return fields.nth(r.pick);
        if ((r.ready && r.ambiguous) || Date.now() > end) throw new Error(r.message);
        await new Promise((done) => setTimeout(done, 250));
    }
}
