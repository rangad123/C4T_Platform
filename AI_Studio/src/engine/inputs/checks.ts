/**
 * Input handling checks: how a page's forms cope with awkward input, judged deterministically (no LLM).
 *
 * Same shape as the health and speed checks: `INPUT_HELPER_SOURCE` is plain JavaScript pasted into every script that
 * contains an `inputHandling` assert, and compiled for the live interpreter and tests from the very same text.
 *
 * What it does, on the page it is given (already navigated):
 *  1. finds the forms that are safe to probe, in the live page:
 *       - mode "safe" (default): only GET forms (search-type forms);
 *       - mode "all": also POST forms, but only when the user enabled tests that change data;
 *       - never a form with a password / card / security-code / one-time-code field, never one whose address or id
 *         looks like login, sign-up, checkout, payment, cart, order, delete or logout. Those are skipped in every mode.
 *  2. submits a small FIXED set of harmless probe strings (at most 7 per form, at most 2 forms): HTML-like text,
 *     nothing, spaces only, 5,000 characters, emoji and right-to-left text, quotes and a backslash, a null character;
 *  2b. before any submission, checks the forms' client-side limits in the live page without submitting anything:
 *      maxlength is honoured while typing (medium), required fields block an empty submit and email / web address / number
 *      fields reject a wrong value (both low, advice). Switched off with "nolimits" in the step's expected text.
 *  3. after each submission checks: the HTML-like text did not become real page markup (possible cross-site
 *     scripting, high); no HTTP 5xx from the site (high); no uncaught script error (medium); the page did not go blank (high).
 * Each form is reloaded fresh before every probe. Nothing else on the site is touched.
 */
import type { Page } from "@playwright/test";

/** First words of every input-handling failure; the finding classifier keys on it. */
export const INPUT_FAILURE_PREFIX = "Input handling check failed:";

export const INPUT_MARKER = '<i data-aitp-probe="1">aitp</i>';
/** Forms probed per page and probes per form: bounded so the check stays quick and polite. */
export const INPUT_MAX_FORMS = 2;
/** Largest declared maxlength the limit check will really type out (N+10 characters are typed). */
export const INPUT_MAX_LENGTH = 500;

export const INPUT_HELPER_SOURCE = String.raw`const INPUT_PREFIX = ${JSON.stringify(INPUT_FAILURE_PREFIX)};
const INPUT_MAX_FORMS = ${INPUT_MAX_FORMS};
const INPUT_MAX_LENGTH = ${INPUT_MAX_LENGTH};
const INPUT_TEXT_FIELDS = "input:not([type]),input[type=text],input[type=search],input[type=email],input[type=url],input[type=tel],textarea";
const INPUT_PROBES = [
    { id: "markup", value: ${JSON.stringify(INPUT_MARKER)}, words: "HTML-like text is entered" },
    { id: "empty", value: "", words: "nothing is entered" },
    { id: "spaces", value: "   ", words: "only spaces are entered" },
    { id: "long", value: "a".repeat(5000), words: "a very long text (5,000 characters) is entered" },
    { id: "unicode", value: "\u{1F600} مرحبا ​‮ test", words: "emoji and right-to-left text are entered" },
    { id: "quote", value: "'\"\\", words: "quotes and a backslash are entered" },
    { id: "nul", value: "a\u0000b", words: "a null character is entered" },
];

/** The forms on the page that are safe to probe (see the module comment for the rules). */
async function inputForms(page, mode) {
    return page.evaluate((mode) => {
        const SENSITIVE = /pass(word)?|card|cc-|cvv|cvc|security.?code|otp|one-time|ssn|iban|account.?number|\bpin\b/i;
        const RISKY = /log-?in|sign-?in|sign-?up|register|checkout|payment|\bpay\b|cart|order|delete|log-?out|subscribe/i;
        const out = [];
        document.querySelectorAll("form").forEach((form, index) => {
            const method = (form.getAttribute("method") || "get").toLowerCase();
            const fields = Array.from(form.elements).filter((el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement);
            const textual = fields.filter((el) => el instanceof HTMLTextAreaElement || ["text", "search", "email", "url", "tel"].indexOf(el.type || "text") >= 0);
            const sensitive = fields.some((el) => el.type === "password" || SENSITIVE.test([el.name, el.id, el.autocomplete, el.getAttribute("aria-label"), el.placeholder].join(" ")));
            if (!textual.length || sensitive || RISKY.test((form.getAttribute("action") || "") + " " + (form.id || ""))) return;
            if (mode !== "all" && method !== "get") return;
            const first = textual[0];
            out.push({ index: index, method: method, label: first.name || first.getAttribute("aria-label") || first.placeholder || "text" });
        });
        return out;
    }, mode);
}

/**
 * Client-side limits of the given (already eligible) forms, in the live page. Nothing is ever submitted: fields are only
 * typed into / emptied and the browser's own validity state is read (never a click on the submit button, so the form's
 * own script, if any, never runs). Returns [{ kind, severity, form, id, text }] with kind maxlength | required | type.
 */
async function inputLimits(page, forms) {
    const out = [];
    for (const form of forms) {
        try {
            const f = page.locator("form").nth(form.index);
            // A form (or its submit control) that turns the browser's checks off lets anything through on submit.
            const off = await f.evaluate((el) => {
                const sub = el.querySelector("button[type=submit],input[type=submit],button:not([type])");
                return !!(el.noValidate || (sub && sub.formNoValidate));
            });
            const fields = f.locator(INPUT_TEXT_FIELDS);
            const meta = await fields.evaluateAll((els) => els.map((e) => ({
                type: e.tagName === "TEXTAREA" ? "textarea" : (e.getAttribute("type") || "text").toLowerCase(),
                max: e.getAttribute("maxlength"),
                required: e.required,
                label: e.name || e.getAttribute("aria-label") || e.placeholder || "text",
            })));
            const usable = async (loc) => (await loc.isVisible()) && (await loc.isEnabled()) && (await loc.isEditable());
            const add = (kind, severity, id, text) => out.push({ kind: kind, severity: severity, form: form, id: id, text: text });
            const limit = Math.min(meta.length, 6);

            // 1. required: empty every required field, then ask the browser whether it would let the form go.
            const req = [];
            for (let i = 0; i < limit; i++) {
                if (!meta[i].required) continue;
                try {
                    const el = fields.nth(i);
                    if (!(await usable(el))) continue;
                    await el.fill("", { timeout: 3000 });
                    req.push(i);
                } catch (e) { /* not fillable: says nothing about the app */ }
            }
            if (req.length) {
                const state = await fields.evaluateAll((els, idx) => idx.map((i) => ({ missing: els[i].validity.valueMissing, will: els[i].willValidate })), req);
                const open = state.filter((s) => s.will && !s.missing).length > 0;
                if (off || open) {
                    const names = req.map((i) => "“" + meta[i].label + "”");
                    const who = names.length === 1 ? names[0] + " field is" : names[0] + " field and " + (names.length - 1) + " more are";
                    add("required", "low", "required", "the " + who + " marked required, but the form can be submitted with " + (names.length === 1 ? "it" : "them") + " empty" + (off ? " (the form switches off the browser’s own checks)" : ""));
                }
            }

            // 2. maxlength: really type N+10 characters (fill() would bypass the limit) and see how many stay.
            for (let i = 0; i < limit; i++) {
                const m = meta[i];
                const n = parseInt(m.max, 10);
                if (!(n >= 1 && n <= INPUT_MAX_LENGTH) || ["text", "search", "textarea"].indexOf(m.type) < 0) continue;
                try {
                    const el = fields.nth(i);
                    if (!(await usable(el))) continue;
                    await el.fill("", { timeout: 3000 });
                    await el.pressSequentially("a".repeat(n + 10), { delay: 0, timeout: 10000 });
                    const kept = (await el.inputValue()).length;
                    if (kept > n) add("maxlength", "medium", "max:" + i, "“" + m.label + "” says it takes at most " + n + " characters but accepts more (typed " + (n + 10) + ", it kept " + kept + ")");
                } catch (e) { /* not typeable */ }
            }

            // 3. type hints: a clearly wrong value for an email / web address / number field.
            for (let i = 0; i < limit; i++) {
                const m = meta[i];
                if (m.type !== "email" && m.type !== "url") continue;
                try {
                    const el = fields.nth(i);
                    if (!(await usable(el))) continue;
                    const wrong = m.type === "email" ? "not-an-email" : "not a web address";
                    await el.fill(wrong, { timeout: 3000 });
                    const mismatch = await el.evaluate((e) => e.validity.typeMismatch);
                    if (!mismatch || off) add("type", "low", "type:" + i, "“" + m.label + "” is " + (m.type === "email" ? "an email" : "a web address") + " field but “" + wrong + "” is " + (!mismatch ? "accepted as it is" : "not stopped when the form is sent (the form switches off the browser’s own checks)"));
                } catch (e) { /* not fillable */ }
            }
            const numbers = f.locator("input[type=number]");
            const nn = Math.min(await numbers.count(), 3);
            for (let i = 0; i < nn; i++) {
                try {
                    const el = numbers.nth(i);
                    if (!(await usable(el))) continue;
                    const label = await el.evaluate((e) => e.name || e.getAttribute("aria-label") || e.placeholder || "number");
                    await el.fill("", { timeout: 3000 });
                    await el.pressSequentially("abc", { delay: 0, timeout: 3000 });
                    const v = await el.inputValue();
                    if (/[a-df-z]/i.test(v)) add("type", "low", "number:" + i, "“" + label + "” is a number field but letters are accepted (it kept “" + v + "”)");
                } catch (e) { /* not typeable */ }
            }
        } catch (e) {
            // A form that cannot be inspected (it vanished, a script replaced it) says nothing about the app.
        }
    }
    return out;
}

/**
 * Probe the page's safe forms and fail with one line per problem.
 * mode: space-separated words. "safe" (default) or "all" picks the forms; "nolimits" switches the client-side limit checks
 * (maxlength, required, email/number types) off. Older specs say just "safe" or "all", which keeps the limit checks on.
 */
async function inputAssert(page, mode) {
    const words = String(mode || "safe").split(/\s+/);
    const origin = new URL(page.url()).origin;
    const url = page.url();
    const forms = (await inputForms(page, words.indexOf("all") >= 0 ? "all" : "safe")).slice(0, INPUT_MAX_FORMS);
    if (forms.length === 0) return;
    const blankBefore = await page.evaluate(() => ((document.body && document.body.innerText) || "").trim().length === 0);

    let current = null;
    const found = [];
    const note = (kind, severity, form, probe, text) => {
        const key = kind + "|" + form.index + "|" + probe.id;
        if (!found.some((f) => f.key === key)) found.push({ key: key, kind: kind, severity: severity, form: form, probe: probe, text: text });
    };
    if (words.indexOf("nolimits") < 0) {
        for (const l of await inputLimits(page, forms)) note(l.kind, l.severity, l.form, { id: l.id, words: "" }, l.text);
    }
    const onError = (e) => { if (current) note("script", "medium", current.form, current.probe, String((e && e.message) || e).slice(0, 80)); };
    const onResponse = (r) => {
        try { if (current && r.status() >= 500 && new URL(r.url()).origin === origin) note("server", "high", current.form, current.probe, "HTTP " + r.status()); } catch (e) { /* ignore */ }
    };
    page.on("pageerror", onError);
    page.on("response", onResponse);
    try {
        for (const form of forms) {
            for (const probe of INPUT_PROBES) {
                current = { form: form, probe: probe };
                try {
                    await page.goto(url, { waitUntil: "load", timeout: 30000 });
                    const f = page.locator("form").nth(form.index);
                    const fields = f.locator("input:not([type]),input[type=text],input[type=search],input[type=email],input[type=url],input[type=tel],textarea");
                    const n = Math.min(await fields.count(), 3);
                    for (let i = 0; i < n; i++) await fields.nth(i).fill(probe.value, { timeout: 5000 });
                    const btn = f.locator("button[type=submit],input[type=submit],button:not([type])").first();
                    if (await btn.count()) await btn.click({ timeout: 5000 });
                    else await fields.first().press("Enter", { timeout: 5000 });
                    await page.waitForLoadState("load", { timeout: 10000 }).catch(() => undefined);
                    await page.waitForTimeout(400);
                    const state = await page.evaluate(() => ({
                        markup: !!document.querySelector("[data-aitp-probe]"),
                        blank: ((document.body && document.body.innerText) || "").trim().length === 0,
                    }));
                    if (probe.id === "markup" && state.markup) note("markup", "high", form, probe, "");
                    if (state.blank && !blankBefore) note("blank", "high", form, probe, "");
                } catch (e) {
                    // A probe that could not be carried out (field not fillable, navigation timed out) says nothing about the app.
                }
            }
        }
    } finally {
        current = null;
        page.off("pageerror", onError);
        page.off("response", onResponse);
    }
    if (found.length === 0) return;
    const rank = { high: 0, medium: 1, low: 2 };
    found.sort((a, b) => rank[a.severity] - rank[b.severity]);
    const where = (f) => "the form with the “" + f.form.label + "” field";
    const lines = found.slice(0, 6).map((f) => {
        if (f.kind === "maxlength" || f.kind === "required" || f.kind === "type") return "- [" + f.severity + "] In " + where(f) + ", " + f.text;
        if (f.kind === "markup") return "- [high] " + where(f) + " shows what you type as page markup instead of plain text (possible cross-site scripting)";
        if (f.kind === "server") return "- [high] " + where(f) + " makes the server fail (" + f.text + ") when " + f.probe.words;
        if (f.kind === "script") return "- [medium] " + where(f) + " triggers a script error when " + f.probe.words + ": " + f.text;
        return "- [high] The page goes blank after " + where(f) + " is submitted when " + f.probe.words;
    });
    if (found.length > 6) lines.push("- [low] ...and " + (found.length - 6) + " more");
    throw new Error(INPUT_PREFIX + " " + found.length + (found.length === 1 ? " problem was" : " problems were") + " found in how this page handles input (" + forms.length + (forms.length === 1 ? " form" : " forms") + " tried)\n" + lines.join("\n"));
}
`;

export interface InputRuntime {
    inputAssert(page: Page, mode?: string): Promise<void>;
    inputForms(page: Page, mode: string): Promise<Array<{ index: number; method: string; label: string }>>;
    /** Client-side limit checks only (nothing is submitted); used by tests to prove that. */
    inputLimits(page: Page, forms: Array<{ index: number; method: string; label: string }>): Promise<Array<{ kind: string; severity: string; id: string; text: string }>>;
}

let runtime: InputRuntime | undefined;

/** The exact helper the generated scripts carry, compiled for use inside the engine and in tests. */
export function loadInputRuntime(): InputRuntime {
    runtime ??= new Function(`${INPUT_HELPER_SOURCE}\nreturn { inputAssert, inputForms, inputLimits };`)() as InputRuntime;
    return runtime;
}

/** Live (interpreter) execution of an input-handling assert. */
export async function runInputCheck(page: Page, mode: string | undefined): Promise<void> {
    await loadInputRuntime().inputAssert(page, mode);
}

/** How to fix, in plain words (appended to a finding's reason). */
export const INPUT_ADVICE =
    "Show what visitors type as text, never as HTML (escape it before putting it on the page). Validate and limit input on the server and handle empty, very long and unusual characters without crashing. Check the server log for the failing request. If a field has a size limit, enforce it on the server too and keep the page's maxlength correct; only mark a field required where the form really checks it (no novalidate).";

export const INPUT_BASIS = "form handles unusual input badly";

/** Severity tag worst-first, e.g. "- [high] ..." -> "high". */
export function worstInputTag(text: string): "high" | "medium" | "low" | undefined {
    for (const s of ["high", "medium", "low"] as const) if (text.includes(`[${s}]`)) return s;
    return undefined;
}
