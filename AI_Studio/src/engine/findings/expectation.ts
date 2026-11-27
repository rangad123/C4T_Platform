/**
 * The expectation check before the verification vote (paid series, V1 and V4): a page test's failing check is judged against the
 * expectation its finding cites. Deterministic, no AI.
 *   - A text the check expects that the cited expectation does not state (and the test did not type itself) is unstated: the vote then
 *     classes a reproduced failure as an incorrect expectation (classify.ts), never an application defect.
 *   - An amount the check expects that the cited expectation does not state is the test writer's arithmetic. It is an incorrect
 *     expectation when the API's own answers (captured while the test was written) do not hold it either; it can be confirmed only when
 *     they do (the page and the API disagree on it); with no API answer to compare it waits for a person (Needs manual review).
 * A check of the application's API layer (a correlation step, a relation) is not judged here, except one: an API check that a repeated
 * identical write is refused (409) is an incorrect expectation when the test's own API document text says a repeat adds to what is there.
 */
import { repeatAdds } from "../api/stated-source.js";
import type { CapturedCall } from "../web/correlation.js";
import { ROLE_MISSING, type TestSpec } from "../spec/schema.js";
import { testStepFault } from "../validation/test-fault.js";

/** What the API's answers said about the amount a page check expects (test meta `apiAmount`, set when the test was written). */
export type ApiAmount = "holds" | "lacks";

export interface PageCheckJudgement {
    /** The cited expectation does not state what the check expects. */
    unstated?: true;
    /** The API's answers do not hold the amount the check expects. */
    contradictedBy?: string;
    /** No API answer to compare the amount with: why a person checks it. */
    review?: string;
}

const MONEY = /[$€£¥₹]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*\.\d{2}\b/g;
const TEXT_CHECKS = new Set(["text", "exactText", "notText", "value", "accessibleErrorMessage", "accessibleName"]);
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
const amountOf = (m: string) => Number(m.replace(/[^\d.]/g, ""));

type Step = TestSpec["steps"][number];

/** What a failing check expects to see, as text: the expected value of a text check, or the text a visible/hidden check looks for. */
function expectedText(step: Step | undefined): string | undefined {
    if (!step || step.action !== "assert") return undefined;
    if (TEXT_CHECKS.has(step.check)) return typeof step.expected === "string" || typeof step.expected === "number" ? String(step.expected) : undefined;
    // A role locator's name is a text the check expects to see, as a text locator's is (N2F WEB-038: a definition named "8").
    if ((step.check === "visible" || step.check === "hidden") && (step.locator?.by === "text" || step.locator?.by === "role")) return step.locator.value;
    return undefined;
}

/**
 * Undefined when the check is not a page check this judges, or what it expects is stated (by the expectation or the test's own data).
 * `required`: the text of the requirements the cited expectation names (citedRequirements); an address check is judged against it, since
 * the expected result is the test writer's own wording (N2F WEB-027: "The address bar shows /spa/#/dashboard (requirement 10.1)").
 */
export function judgePageCheck(x: { spec: TestSpec; failedStep?: number; cited: string; required?: string; apiAmount?: unknown; correlated?: boolean }): PageCheckJudgement | undefined {
    if (x.spec.kind !== "web" || x.correlated || x.failedStep === undefined) return undefined;
    const step = x.spec.steps[x.failedStep - 1];
    // A check that the page stays where it is (a refused form keeps its page) is about the refusal, not an address the writer chose
    // (paid L4 rbac-4 WEB-035 BR-09: "… and the page stays on /login (requirement 2.14)").
    if (step?.action === "assert" && (step.check === "url" || step.check === "urlPattern")) return STAYS.test(`${x.cited} ${step.description ?? ""}`) ? undefined : judgeAddress(x.spec, step.expected, x.required ?? x.cited);
    const want = expectedText(x.spec.steps[x.failedStep - 1])?.trim();
    if (!want) return undefined;
    // The test's own data ({{unique}}, a value a step typed) is stated by the test itself, where it was typed. Shown elsewhere it is
    // stated only when the cited requirement speaks of the field it was typed into (paid L4 shop-1 WEB-025: the typed name expected in
    // the navigation, under 1.10 "A new account is signed in straight away …", which says nothing of a name).
    const w = norm(want);
    const fills = x.spec.steps.flatMap((s) => (s.action === "fill" ? [s] : []));
    const typedInto = fills.find((s) => {
        const t = norm(s.value.replace(/\{\{[^}]*\}\}/g, " "));
        return (/\{\{/.test(want) && s.value.includes(want)) || (t.length >= 3 && (w.includes(t) || (w.length >= 3 && t.includes(w))));
    });
    if (typedInto || /\{\{/.test(want)) {
        const field = typedInto ? (typedInto.locator as { value?: string }).value : undefined;
        const sameField = field && step?.action === "assert" && (step.locator as { value?: string } | undefined)?.value === field;
        return x.required && field && !sameField && !norm(x.required).includes(norm(field)) ? { unstated: true } : undefined;
    }
    // A text is stated by the requirement the expected result cites, when the project holds it: the expected result is the test writer's
    // own wording (paid L4 shop-4 WEB-004: "The Add to cart button is visible (requirement 1.1)", where 1.1 says only that anyone may
    // browse). A word inside an address ("/notes") is not a text the page shows (rbac-1 WEB-027: heading "Notes" from "The URL becomes /notes").
    // A number is the data the writer saw (a count of orders), which a requirement never lists: it stays judged on the expected result.
    const cited = norm((/^\d+$/.test(w) ? x.cited : (x.required ?? x.cited)).replace(/(?:^|\s)\/[^\s()]*/g, " "));
    const amounts = [...want.matchAll(MONEY)].map((m) => m[0]);
    const plain = x.cited.replace(/,/g, "");
    const states = (a: string) => {
        const n = amountOf(a);
        return [n.toFixed(2), ...(Number.isInteger(n) ? [String(n)] : [])].some((t) => new RegExp(`(^|[^\\d.])${t.replace(".", "\\.")}($|[^\\d]|\\.(?!\\d))`).test(plain));
    };
    const unstatedAmount = amounts.find((a) => !states(a));
    if (unstatedAmount !== undefined) {
        if (x.apiAmount === "holds") return undefined;
        if (x.apiAmount === "lacks") return { contradictedBy: `the API's answers (none holds ${unstatedAmount})` };
        return { review: `The check expects ${unstatedAmount}, an amount the cited expectation does not state, and no API answer was captured to compare it with: a person checks the arithmetic before it is confirmed.` };
    }
    if (amounts.length) return undefined;
    return cited.includes(w) ? undefined : { unstated: true };
}

const ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^/]+/i;
const STAYS = /\b(?:stays?|remains?|still on)\b/i;
const decoded = (u: string) => {
    try {
        return decodeURIComponent(u);
    } catch {
        return u;
    }
};

/** An address check: stated when the text names the address, or the test itself opened it or sent it in a query value (?next=/orders). */
function judgeAddress(spec: TestSpec, expected: unknown, text: string): PageCheckJudgement | undefined {
    const want = typeof expected === "string" ? expected.trim().replace(ORIGIN, "") : "";
    if (!want || !norm(want)) return undefined;
    const opened = spec.steps.flatMap((s) => (s.action === "navigate" ? [decoded(s.url)] : []));
    if (opened.some((u) => u.replace(ORIGIN, "") === want || u.includes(`=${want}`))) return undefined;
    return norm(text).includes(norm(want)) ? undefined : { unstated: true };
}

/**
 * The text of the requirements a cited expectation names ("… (requirement 10.1)"), from the project's requirements by ref key
 * (refKey); undefined when it names none the project holds.
 * shortcut: one ref per "requirement" word; "requirements 3.4 and 10.2" reads 3.4 only.
 */
export function citedRequirements(cited: string, requirements: ReadonlyMap<string, string> | undefined): string | undefined {
    if (!requirements?.size) return undefined;
    const refs = [...cited.matchAll(/\brequirements?\s+([A-Za-z0-9][A-Za-z0-9._#-]*)/gi)].map((m) => m[1]!.replace(/\.+$/, "").toUpperCase());
    // A clause of a requirement ("3.13.b", the writer's split of 3.13) is read as the requirement it belongs to.
    const texts = refs.flatMap((r) => requirements.get(r) ?? requirements.get(r.replace(/\.?[A-Z]$/, "")) ?? []);
    return texts.length ? texts.join(" ") : undefined;
}

/**
 * The written expectation a test's failing check cites: its expected result (expected:N), else all of them. An execution finding's
 * stored expectation carries the check's own value ("… ($21.00)"), so judged against that every check would read as stated.
 */
export function writtenExpectation(spec: TestSpec, failedStep: number | undefined): string {
    const source = failedStep === undefined ? undefined : (spec.steps[failedStep - 1] as { source?: unknown } | undefined)?.source;
    const n = typeof source === "string" ? /^expected:(\d+)$/.exec(source) : null;
    return (n ? spec.expectedResults[Number(n[1]) - 1] : undefined) ?? spec.expectedResults.join(" ");
}

/**
 * Whether the API answers a test captured while it was written hold the amount its failing check expects (in units or in cents):
 * "holds" means the page and the API disagree on it, "lacks" that the API does not support it. Undefined: not an amount check, or no
 * answer with numbers to compare.
 */
export function apiOnAmount(steps: readonly Step[], source: string | undefined, calls: readonly CapturedCall[] | undefined): ApiAmount | undefined {
    const check = [...steps].reverse().find((s) => s.action === "assert" && s.source === source);
    const want = expectedText(check);
    const amounts = want ? [...want.matchAll(MONEY)].map((m) => amountOf(m[0])) : [];
    if (!amounts.length || !calls?.length) return undefined;
    const numbers = new Set<number>();
    const walk = (v: unknown, depth = 0): void => {
        if (depth > 20) return;
        if (typeof v === "number" && Number.isFinite(v)) numbers.add(Math.abs(v));
        else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
        else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x, depth + 1);
    };
    for (const c of calls) {
        if (c.status < 200 || c.status > 299) continue;
        try {
            walk(JSON.parse(c.body));
        } catch {
            /* not JSON, or cut */
        }
    }
    if (!numbers.size) return undefined;
    return amounts.every((a) => numbers.has(a) || numbers.has(Math.round(a * 100))) ? "holds" : "lacks";
}

/**
 * An API test whose failing check expects a refusal (409) of a write it sent the same way before, while the API document's summary it
 * carries (spec.description) says a repeat adds to what is there (practice store API-070: "adds to the line if it is already in the cart").
 */
export function judgeRepeatRefusal(spec: TestSpec, failedStep: number | undefined): PageCheckJudgement | undefined {
    if (spec.kind !== "api" || failedStep === undefined || !repeatAdds(spec.description)) return undefined;
    const step = spec.steps[failedStep - 1];
    if (step?.action !== "assertResponse" || step.check !== "status" || Number(step.expected) !== 409) return undefined;
    const sent = spec.steps.slice(0, failedStep - 1).flatMap((s) => (s.action === "request" ? [JSON.stringify([s.method, s.path, s.body ?? null])] : []));
    const last = sent.at(-1);
    if (!last || !sent.slice(0, -1).includes(last)) return undefined;
    return { contradictedBy: `the API document ("${spec.description.slice(0, 200)}": a repeat adds to what is there)` };
}

const fieldKey = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The longest text each form field takes (its maxlength), by label and by name, from an application model's pages (the analysis's or the
 * discovery's: pages → forms → fields). A key two fields give different limits is left out.
 */
export function fieldLimits(model: unknown): Map<string, number> {
    const out = new Map<string, number>();
    const clash = new Set<string>();
    const pages = (model as { pages?: Array<{ forms?: Array<{ fields?: Array<{ label?: unknown; name?: unknown; placeholder?: unknown; maxLength?: unknown }> }> }> } | null | undefined)?.pages;
    for (const p of Array.isArray(pages) ? pages : [])
        for (const form of p?.forms ?? [])
            for (const f of form?.fields ?? []) {
                if (typeof f?.maxLength !== "number" || f.maxLength <= 0) continue;
                for (const k of [f.label, f.name, f.placeholder]) {
                    if (typeof k !== "string" || !k.trim()) continue;
                    const key = fieldKey(k);
                    if (out.has(key) && out.get(key) !== f.maxLength) clash.add(key);
                    else out.set(key, f.maxLength);
                }
            }
    for (const k of clash) out.delete(k);
    return out;
}

/**
 * Why a web test's failing check is the test's own problem when an earlier step typed more than the field's maxlength allows: the browser
 * cut the value before anything was sent, so the application never saw it (N2E WEB-044: 81 characters into maxlength="80", then the
 * check that 81 is refused). Only a check about a length or limit: its text, or the expectation the finding cites (`cited`), names the
 * limit, characters, length or a maximum (N2F WEB-032 failed at an earlier check of the same test, whose text names none). Undefined
 * otherwise, or when no limit is known.
 */
export function cutByMaxlength(spec: TestSpec, failedStep: number | undefined, limits: ReadonlyMap<string, number> | undefined, cited = ""): string | undefined {
    if (spec.kind !== "web" || failedStep === undefined || !limits?.size) return undefined;
    const check = spec.steps[failedStep - 1];
    if (check?.action !== "assert") return undefined;
    const said = [typeof check.expected === "string" || typeof check.expected === "number" ? String(check.expected) : "", check.locator?.by === "text" ? check.locator.value : "", check.description ?? "", cited].join(" ");
    for (const s of spec.steps.slice(0, failedStep - 1)) {
        if (s.action !== "fill" || /\{\{/.test(s.value)) continue;
        const l = s.locator as { by?: string; value?: string; role?: string };
        const name = l.by === "label" || l.by === "placeholder" || (l.by === "role" && /textbox|searchbox/.test(l.role ?? "")) ? l.value : undefined;
        const max = name ? limits.get(fieldKey(name)) : undefined;
        if (max === undefined || s.value.length <= max) continue;
        if (!new RegExp(`\\b${max}\\b|character|too long|length|at most|maximum`, "i").test(said)) continue;
        return `The test typed ${s.value.length} characters into “${name}”, whose maxlength is ${max}: the browser cut the value to ${max} before anything was sent, so the application never received the longer value. The limit was enforced by the field itself; check it by sending the long value to the API instead.`;
    }
    return undefined;
}

/**
 * Why a web test's failing check is the test's own problem, from the test and the attempts alone, if it is:
 *  - the check expects a placeholder that check reads as written ({{…}} in an ARIA snapshot or an address pattern, generators/playwright.ts),
 *    so no page can match it (paid L4 shop-1 WEB-026: "textbox \"Name\": Test User {{unique}}");
 *  - an exact-text check on an element it finds by a different text;
 *  - the page the test itself opened answered 404 at the failing step: the application has no such page, so the check never saw the page it
 *    was written for (paid L4 rbac-3 WEB-049: GET /people → 404, the People page is elsewhere); or, for a check that expects a refusal,
 *    the opened page answered 401/403 itself: the access was refused, so the failure is about the page's words, not about access;
 *  - the action the test is about (its title: delete, remove, archive) is done by none of its steps, so the checks after it never saw its
 *    result (paid L4 rbac-1 WEB-027, rbac-2 WEB-047, rbac-5 WEB-049: "delete a note" tests that never press Delete).
 */
export function ownCheckFault(spec: TestSpec, attempts: ReadonlyArray<{ outcome: string; failedStep?: number; requests: ReadonlyArray<{ method: string; path: string; status: number | null; own: boolean }> }>): string | undefined {
    if (spec.kind !== "web") return undefined;
    const failed = attempts.filter((a) => a.outcome === "failed" && a.failedStep !== undefined);
    if (!failed.length) return undefined;
    const check = spec.steps[failed[0]!.failedStep! - 1];
    const never = check?.action === "assert" ? actionNeverDone(spec) : undefined;
    if (never) return never;
    if (check?.action === "assert" && (check.check === "ariaSnapshot" || check.check === "urlPattern") && /\{\{[^}]*\}\}/.test(String(check.expected ?? "")))
        return `The check expects “${String(check.expected).match(/\{\{[^}]*\}\}/)![0]}” as written: a ${check.check === "ariaSnapshot" ? "structure snapshot" : "URL pattern"} does not fill placeholders, so no page can match it. The test needs the value itself or a pattern.`;
    const other = check?.action === "assert" ? foundByOtherText(check) : undefined;
    if (other) return other;
    const opened = new Set(spec.steps.flatMap((s) => (s.action === "navigate" ? [decoded(s.url).replace(ORIGIN, "").split(/[?#]/)[0]!] : [])));
    // A check that expects a refusal, on a page that answered a refusal itself: access was refused, only the page's words differ.
    const wantsRefusal = check?.action === "assert" && REFUSAL.test(`${check.description ?? ""} ${String(check.expected ?? "")} ${check.locator?.value ?? ""}`);
    const missing = (a: (typeof failed)[number]) => a.requests.find((r) => r.own && r.method.toUpperCase() === "GET" && (r.status === 404 || (wantsRefusal && (r.status === 401 || r.status === 403))) && opened.has(r.path.split(/[?#]/)[0]!));
    const page = failed.every(missing) ? missing(failed[0]!) : undefined;
    if (page?.status === 404) return `The page the test opened, GET ${page.path}, answered 404 in every failed attempt: the application has no such page, so the check never saw the page it was written for. The test needs the application's own address for it.`;
    return page ? `The page the test opened, GET ${page.path}, answered ${page.status} in every failed attempt: the access was refused, as the check expects, so the failure is about how the page words the refusal, not about access. The test needs the application's own page and words for it.` : undefined;
}

/**
 * Why a defect the test writer reported (web/author.ts, finish "defect") is the test's own fault, from its captured check alone: the facts
 * the validator (test-fault.ts) and the verification judge (ownCheckFault) already read, applied before it is reported
 * (orchestrator.ts keepAuthored), since a defect test never goes through the validator. Undefined when none holds.
 *  - the captured failure is an element several match (strict mode violation): re-check shop-4 WEB-040/046/058, `getByText('Subtotal')`;
 *  - the captured check can never pass (ownCheckFault: a placeholder in a snapshot, an element found by another text);
 *  - the captured check reads an element that shows only the text it is found by (a label) for a value that text does not hold: the
 *    value is in another element (re-check shop-4 WEB-048: “Discount (SAVE10)” must contain “−$4.70”, received “Discount (SAVE10)”).
 *    Not when the expected text holds that text: the element can show it with more (rbac-5 WEB-032: “Bold x” must contain “<b>Bold x</b>”);
 *  - the captured check could not run (a role locator without its role: shop-2 WEB-028);
 *  - a whole text written with spaces between parts the element's text runs together (cells of a row, items of a list).
 */
export function authoredCheckFault(spec: TestSpec, captured: { source: string; observed: string } | undefined): string | undefined {
    if (spec.kind !== "web" || !captured) return undefined;
    let at = -1;
    for (let i = spec.steps.length - 1; i >= 0 && at < 0; i--) if ((spec.steps[i] as { source?: string }).source === captured.source) at = i;
    const check = spec.steps[at];
    if (!check) return undefined;
    // On a check only an element several match is the step's fault (an element not found is a claim about the page).
    const ambiguous = testStepFault({ status: "failed", steps: [], error: captured.observed }, check);
    if (ambiguous) return ambiguous;
    // The step itself could not run: its role locator has no role (spec/schema.ts), so it never looked at the page.
    if (captured.observed.includes(ROLE_MISSING)) return `The test needs fixing, not your application: its check could not run. ${ROLE_MISSING}`;
    const own = ownCheckFault(spec, [{ outcome: "failed", failedStep: at + 1, requests: [] }]);
    if (own || check.action !== "assert" || (check.check !== "text" && check.check !== "exactText")) return own;
    const l = check.locator as { by?: string; role?: string; value?: string } | undefined;
    const found = l?.by === "text" || (l?.by === "role" && NAMED_BY_TEXT.has(l.role ?? "")) ? (l.value ?? "") : "";
    const received = captured.observed.match(/Received(?: string)?:\s*"([^"]*)"/)?.[1];
    const want = norm(String(check.expected ?? ""));
    // A whole text written with a space where the element's text has none: the parts are separate cells or items, whose text joins
    // without one (re-check shop-3 WEB-013: “Headphones $59.99 Quantity 2 …”, received “Headphones$59.99Quantity …”).
    const words = String(check.expected ?? "").trim().split(/\s+/);
    const joined = check.check === "exactText" && received !== undefined ? words.slice(1).findIndex((b, i) => received.includes(words[i]! + b) && !received.includes(`${words[i]} ${b}`)) : -1;
    if (joined >= 0)
        return `The check expects the whole text “${String(check.expected).slice(0, 80)}”, with a space between “${words[joined]}” and “${words[joined + 1]}”, but the element’s text runs them together (“${words[joined]}${words[joined + 1]}”): they are separate parts of the page, so its text can never read as written. The test needs a check of each part.`;
    if (found && received !== undefined && norm(received) === norm(found) && want && !norm(found).includes(want) && !want.includes(norm(found)))
        return `The check reads the element that shows only “${found.slice(0, 80)}”, the text it finds it by, and expects it to contain “${String(check.expected).slice(0, 80)}”: that value is in another element, so no page laid out this way can pass it. The test needs the element that holds the value.`;
    return undefined;
}

const REFUSAL = /\b40[13]\b|not allowed|forbidden|denied|refused|unauthori[sz]ed/i;
/** Roles whose accessible name is their own text, so a name is text the element shows. */
const NAMED_BY_TEXT = new Set(["heading", "link", "button"]);

/**
 * Why a text check can never pass, when the element is found by one text and then must show another:
 *  - an exact-text check whose expected text does not hold the text (or, for a heading, link or button, the name) it finds the element
 *    by (paid L4 shop-3 WEB-053: the text "$52.00" must read "$50.75"; re-check rbac-1 WEB-016: the heading named "Bold qa1r4o" must read
 *    "<b>Bold</b> qa1r4o");
 *  - a contains check on an element found by its exact text (or exact name) that does not hold the expected text (re-check shop-3 WEB-051:
 *    the exact text "Free" must contain "$0.00"; shop-4 WEB-036: the link named exactly "Cart" must contain "2").
 */
function foundByOtherText(check: Extract<Step, { action: "assert" }>): string | undefined {
    const l = check.locator as { by?: string; role?: string; value?: string; exact?: boolean } | undefined;
    const by = l?.by === "text" ? "text" : l?.by === "role" && NAMED_BY_TEXT.has(l.role ?? "") ? "name" : undefined;
    const found = by ? (l!.value ?? "") : "";
    const want = norm(String(check.expected ?? ""));
    if (!found || !norm(found) || !want) return undefined;
    if (check.check === "exactText" && !want.includes(norm(found)))
        return `The check finds the element by its ${by} “${found.slice(0, 80)}” and then expects its whole text to be “${String(check.expected).slice(0, 80)}”: no element can be both, so no page can pass it.`;
    if (check.check === "text" && l!.exact && !norm(found).includes(want))
        return `The check finds the element whose ${by} is exactly “${found.slice(0, 80)}” and then expects it to contain “${String(check.expected).slice(0, 80)}”: no element can be both, so no page can pass it.`;
    return undefined;
}

/** The actions a test title can be about, each with the words a step that does it carries. */
const ACTIONS: ReadonlyArray<{ word: string; title: RegExp; does: RegExp; method?: string }> = [
    { word: "delete", title: /\bdelet(?:e|es|ed|ing)\b/i, does: /\bdelet/i, method: "DELETE" },
    { word: "remove", title: /\bremov(?:e|es|ed|ing)\b/i, does: /\bremov/i, method: "DELETE" },
    { word: "archive", title: /\barchiv(?:e|es|ed|ing)\b/i, does: /\barchiv/i },
];

/**
 * Why a web test's checks never saw what it is about: its title names an action (delete, remove, archive) that none of its steps does.
 * A step does it when it presses, ticks or picks a control named for it, opens an address naming it, or sends the matching request. A
 * control named after text the test itself typed (a note titled "Delete me") is that text, not the action.
 */
export function actionNeverDone(spec: TestSpec): string | undefined {
    if (spec.kind !== "web") return undefined;
    const typed = new Set(spec.steps.flatMap((s) => (s.action === "fill" ? [norm(s.value)] : [])));
    const named = (l: unknown) => {
        const v = (l as { value?: string } | undefined)?.value ?? "";
        return v && !typed.has(norm(v)) ? v : "";
    };
    for (const a of ACTIONS) {
        if (!a.title.test(spec.title)) continue;
        const done = spec.steps.some((s) =>
            s.action === "click" || s.action === "check" || s.action === "select" || s.action === "press"
                ? a.does.test(named(s.locator)) || (s.action === "select" && a.does.test(s.value))
                : s.action === "navigate"
                  ? a.does.test(s.url)
                  : s.action === "request"
                    ? s.method === a.method || a.does.test(s.path)
                    : s.action === "useBlock" || s.action === "condition",
        );
        if (!done)
            return `The test’s title (“${spec.title.slice(0, 120)}”) is about the ${a.word} action, but none of its steps does it: no step presses a control, opens an address or sends a request to ${a.word}. Its checks never saw the result of that action, so their failure says nothing about it.`;
    }
    return undefined;
}
