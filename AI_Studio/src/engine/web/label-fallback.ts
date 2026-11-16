/**
 * A step that finds a field by its label ("Type ... into the "Email" field") on a page whose fields have no label, only a placeholder
 * (many sites: <input placeholder="Email Address">). Playwright's getByLabel matches the label element, aria-label and aria-labelledby;
 * when none of those match, the field whose placeholder equals or starts with the label is used, but only when exactly one visible
 * editable field has such a placeholder. Several such fields (a login and a signup form, each with "Email Address"): the one whose form
 * also holds what the test's neighbouring steps act on (its "Password" field, its "Login" button; nearbyTargets) is used, when exactly
 * one does. Never a guess between several: otherwise the step fails at once with a sentence naming the fields the page has, instead of
 * waiting out the action timeout on a locator that can never match.
 *
 * The rendered script (../generators/playwright.ts) and the live interpreter (./interpreter.ts) do the same: both run PICK_FIELD_SOURCE
 * in the page, and the waiting around it is written twice (LABEL_FIELD_HELPER_SOURCE and labelledField below).
 */
import type { FrameLocator, Locator, Page } from "@playwright/test";
import type { Step } from "../spec/schema.js";

/** What a neighbouring step acts on, as the page function reads it (a plain locator without frames, containers or placeholders). */
export interface FieldClue {
    by: "label" | "placeholder" | "role" | "text" | "testId" | "css";
    value: string;
    role?: string;
    exact?: boolean;
}

/** Steps that act on an element; their elements are clues for a label step near them. */
const ACTING = new Set<Step["action"]>(["click", "fill", "select", "check", "press", "hover", "upload"]);
/** How many steps on each side of a label step are read for clues. */
const NEAR_STEPS = 3;

/**
 * The clues for step `i` when it acts on a field by its label: what the steps around it act on, on the same page. Backwards it stops
 * at a page change or a click (what came before was on another page, or opened this one); forwards it takes up to the first click
 * (usually the form's submit button). Elements written with a {{placeholder}}, inside frames or containers, or in another window are left out.
 */
export function nearbyTargets(steps: readonly Step[], i: number): FieldClue[] {
    const self = steps[i];
    const own = self && "locator" in self ? self.locator : undefined;
    if (!own || own.by !== "label" || !ACTING.has(self.action)) return [];
    const popup = "inPopup" in self && self.inPopup === true;
    const clue = (s: Step): FieldClue | undefined => {
        if (!ACTING.has(s.action) || !("locator" in s) || !s.locator) return undefined;
        if (("inPopup" in s && s.inPopup === true) !== popup) return undefined;
        const l = s.locator as Record<string, unknown>;
        if (l.frame || l.within || l.filter || typeof l.value !== "string" || !l.value || l.value.includes("{{")) return undefined;
        if (!["label", "placeholder", "role", "text", "testId", "css"].includes(String(l.by))) return undefined;
        if (l.by === "label" && String(l.value).toLowerCase() === String(own.value ?? "").toLowerCase()) return undefined;
        return { by: l.by as FieldClue["by"], value: l.value, ...(typeof l.role === "string" ? { role: l.role } : {}), ...(l.exact === true ? { exact: true } : {}) };
    };
    const out: FieldClue[] = [];
    for (let j = i - 1; j >= Math.max(0, i - NEAR_STEPS); j--) {
        const s = steps[j]!;
        if (s.action === "navigate" || s.action === "click") break;
        const c = clue(s);
        if (c) out.push(c);
    }
    for (let j = i + 1; j < Math.min(steps.length, i + 1 + NEAR_STEPS); j++) {
        const s = steps[j]!;
        if (s.action === "navigate") break;
        const c = clue(s);
        if (c) out.push(c);
        if (s.action === "click") break;
    }
    return out;
}

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
    // Several fields: the one whose form (or the largest part of the page holding no other of them) also holds what the test's
    // neighbouring steps act on (the "Password" field, the "Login" button), when exactly one does. Clues every field shares say nothing.
    if (hits.length > 1 && a.near && a.near.length) {
        const boxes = new Map();
        const box = (h) => {
            if (boxes.has(h)) return boxes.get(h);
            let b = h.el.closest("form");
            if (!b || hits.some((o) => o !== h && b.contains(o.el))) {
                b = h.el;
                while (b.parentElement && !hits.some((o) => o !== h && b.parentElement.contains(o.el))) b = b.parentElement;
            }
            boxes.set(h, b);
            return b;
        };
        const same = (text, value, exact) => (exact ? norm(text) === value : norm(text).toLowerCase().includes(value.toLowerCase()));
        const fieldName = (el) => [norm(el.getAttribute("aria-label")), el.labels && el.labels[0] ? norm(el.labels[0].textContent) : "", norm(el.getAttribute("placeholder"))];
        const ROLES = { button: "button, input[type=submit], input[type=button], input[type=reset], [role=button]", link: ":any-link, [role=link]", textbox: "input:not([type]), input[type=text], input[type=email], input[type=password], input[type=search], input[type=tel], input[type=url], textarea, [role=textbox]", checkbox: "input[type=checkbox], [role=checkbox]", radio: "input[type=radio], [role=radio]", combobox: "select, [role=combobox]" };
        const holds = (b, n) => {
            const value = norm(n.value);
            const all = (sel) => { try { return [...b.querySelectorAll(sel)]; } catch (e) { return []; } };
            if (n.by === "label") return all(${JSON.stringify(FIELD_SELECTOR)}).some((el) => fieldName(el).some((t) => t && same(t, value, n.exact)));
            if (n.by === "placeholder") return all("[placeholder]").some((el) => same(el.getAttribute("placeholder"), value, n.exact));
            if (n.by === "testId") return all("[data-testid]").some((el) => el.getAttribute("data-testid") === n.value);
            if (n.by === "css") return all(n.value).length > 0;
            if (n.by === "text") return same(b.textContent, value, false);
            if (n.by === "role") {
                const els = all(ROLES[n.role] || "[role=" + JSON.stringify(String(n.role)) + "]");
                return value ? els.some((el) => same(norm(el.getAttribute("aria-label")) || el.textContent || el.value || el.getAttribute("title"), value, n.exact)) : els.length > 0;
            }
            return false;
        };
        const telling = a.near.map((n) => hits.filter((h) => holds(box(h), n))).filter((hs) => hs.length > 0 && hs.length < hits.length);
        const chosen = hits.filter((h) => telling.some((hs) => hs.includes(h)));
        if (chosen.length === 1) return { pick: chosen[0].i, ready };
    }
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
async function labelledField(root: import("@playwright/test").Page | import("@playwright/test").FrameLocator | import("@playwright/test").Locator, label: string, exact: boolean, scoped: boolean, near: Array<{ by: string; value: string; role?: string; exact?: boolean }> = []): Promise<import("@playwright/test").Locator> {
    const byLabel = root.getByLabel(label, { exact });
    const fields = root.locator(${JSON.stringify(FIELD_SELECTOR)});
    const end = Date.now() + ${LABEL_WAIT_MS};
    for (;;) {
        if ((await byLabel.count()) > 0) return byLabel;
        const r = await fields.evaluateAll(pickLabelledField, { label, exact, scoped, near });
        if (r.pick !== undefined) return fields.nth(r.pick);
        if ((r.ready && r.ambiguous) || Date.now() > end) throw new Error(r.message);
        await new Promise((done) => setTimeout(done, 250));
    }
}`;

type Picked = { pick?: number; ready: boolean; ambiguous?: boolean; message?: string };
const pickField = new Function(`return ${PICK_FIELD_SOURCE};`)() as (els: Element[], a: { label: string; exact: boolean; scoped: boolean; near: FieldClue[] }) => Picked;

/** The interpreter's labelledField (same rule and sentence as the rendered script's). */
export async function labelledField(root: Page | FrameLocator | Locator, label: string, exact: boolean, scoped: boolean, waitMs = LABEL_WAIT_MS, near: FieldClue[] = []): Promise<Locator> {
    const byLabel = root.getByLabel(label, { exact });
    const fields = root.locator(FIELD_SELECTOR);
    const end = Date.now() + waitMs;
    for (;;) {
        if ((await byLabel.count()) > 0) return byLabel;
        const r = await fields.evaluateAll(pickField, { label, exact, scoped, near });
        if (r.pick !== undefined) return fields.nth(r.pick);
        if ((r.ready && r.ambiguous) || Date.now() > end) throw new Error(r.message);
        await new Promise((done) => setTimeout(done, 250));
    }
}
