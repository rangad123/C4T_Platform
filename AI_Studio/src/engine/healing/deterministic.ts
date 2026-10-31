/**
 * Repair without AI: the fixes a web test that could not find its element can be tried with BEFORE a model is asked.
 *
 * The page is opened at the failing step in a real browser (the steps before it are replayed, as healing does), and what it offers now is
 * compared with what the old locator asked for, by plain rules, in this order:
 *   1. shared-element  the shared element the step uses has other locators on record, and one of them finds exactly one element;
 *   2. role-name       an element with the same role and the same accessible name ("Sign in" / "Sign In"; a name that means the same:
 *                      "Add to cart" / "Add to basket"), or, for a text / label / hint locator, a control whose accessible name reads the same;
 *   3. same-text       an element that shows the same text (a button that became a link; a field whose hint reads like its old label);
 *   4. moved           the element the old test id or CSS selector meant, found by its own attributes (its id, name, test id, classes) elsewhere.
 * A rule only counts when exactly ONE element of the page matches it (two candidates mean guessing, so that rule gives nothing), and only names
 * that read the same are accepted (similar wording is a judgement and is left to the model). The new locator must find exactly that element.
 *
 * Nothing is applied here: the caller runs the test with each fix and keeps the first that PASSES (validation/det-repair.ts). The rules that
 * decide which failures may be repaired at all are healing's (failure.ts): assertions about content, built-in checks and tests with reusable
 * steps are never touched.
 */
import type { Browser, Page } from "playwright";
import { BrowserSession, settle } from "../discovery/browser.js";
import { executeStep, locate, runtimeData, type RuntimeData } from "../web/interpreter.js";
import type { Locator, Step, TestSpec } from "../spec/schema.js";
import type { ScriptRun } from "../validation/runner.js";
import { sameLocator } from "./apply.js";
import { COLLECT_SOURCE, MARKER, type Candidate } from "./candidates.js";
import { CONTROL_ROLES, eligibility } from "./failure.js";
import { cssTokens, describeLocator, suitsAction } from "./rank.js";
import { nameSimilarity } from "./similarity.js";

export const FIX_KINDS = ["shared-element", "role-name", "same-text", "moved"] as const;
export type FixKind = (typeof FIX_KINDS)[number];

/** How each kind is named in events, reasons and the docs. */
export const FIX_KIND_WORDS: Record<FixKind, string> = {
    "shared-element": "the shared element's other locator",
    "role-name": "the same role and name",
    "same-text": "the same text",
    moved: "the element's own attributes",
};

export interface DetFix {
    kind: FixKind;
    stepIndex: number;
    oldLocator: Locator;
    newLocator: Locator;
    /** "the “Log in” button" */
    newDescription: string;
}

export type DetFindResult = { status: "found"; stepIndex: number; oldLocator: Locator; fixes: DetFix[] } | { status: "none"; reason: string };

export interface DetRepairInput {
    browser: Browser;
    baseUrl: string;
    spec: TestSpec;
    run: ScriptRun;
    credentials?: { username: string; password: string; totpSecret?: string };
    /** Other locators of the shared element the failing step uses (empty / absent: it uses none, or none are on record). */
    alternatives?: Locator[];
}

/** At most this many fixes are handed back (each one costs a run of the test). */
export const MAX_FIXES = 3;
const REPLAYED = new Set<Step["action"]>(["navigate", "click", "fill", "select", "check", "press", "hover", "wait"]);
const STEP_TIMEOUT = 6_000;
const OVERALL_TIMEOUT = 60_000;
const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider", "listbox"]);

const none = (reason: string): DetFindResult => ({ status: "none", reason });
const usable = (s: string | null | undefined): s is string => Boolean(s) && !s!.includes("{{") && s!.length < 200;
/** Reads the same once case, spacing and punctuation are tidied up. */
const readsSame = (a: string | null | undefined, b: string | null | undefined): boolean => usable(a) && usable(b) && nameSimilarity(a, b).kind === "same";
/** Reads the same, or means the same by the fixed synonym list ("cart" = "basket", "sign in" = "log in"); never "similar". */
const meansSame = (a: string | null | undefined, b: string | null | undefined): boolean => {
    if (!usable(a) || !usable(b)) return false;
    const k = nameSimilarity(a, b).kind;
    return k === "same" || k === "synonym";
};

/** Does this candidate stand for the old locator under this rule? Pure: every rule is covered by unit tests. */
export function matchesRule(kind: Exclude<FixKind, "shared-element">, old: Locator, c: Candidate): boolean {
    const value = old.value ?? "";
    switch (kind) {
        case "role-name":
            if (!c.role || !c.name) return false;
            if (old.by === "role") return Boolean(old.role) && c.role === old.role && meansSame(value, c.name);
            // A text, label or hint locator: a control (a field, for a label or a hint) whose accessible name reads the same.
            if (old.by === "text") return CONTROL_ROLES.has(c.role) && readsSame(value, c.name);
            if (old.by === "label" || old.by === "placeholder") return FIELD_ROLES.has(c.role) && readsSame(value, c.name);
            return false;
        case "same-text":
            if (old.by === "role" || old.by === "text") return c.ownsText && readsSame(value, c.text);
            if (old.by === "label") return readsSame(value, c.placeholder);
            if (old.by === "placeholder") return readsSame(value, c.label);
            return false;
        case "moved": {
            if (old.by === "testId") return [c.id, c.nameAttr, c.testId].some((a) => readsSame(value, a));
            if (old.by !== "css") return false;
            const { tag, words } = cssTokens(value);
            if (!words.length || (tag && c.tag !== tag)) return false;
            // Every id, class and attribute value of the selector's last part is carried by the element itself, exactly.
            const attrs = [c.id, c.testId, c.nameAttr, ...c.classes].filter((a): a is string => Boolean(a));
            return words.every((w) => attrs.includes(w));
        }
    }
}

/** The candidates each rule leaves, one rule at a time; a rule with more than one candidate is ambiguous and gives nothing. */
export function ruleMatches(old: Locator, action: Step["action"], candidates: Candidate[], interactive: boolean): Array<{ kind: Exclude<FixKind, "shared-element">; cand: Candidate }> {
    const fit = candidates.filter((c) => suitsAction(action, c) && (!interactive || !c.disabled));
    const out: Array<{ kind: Exclude<FixKind, "shared-element">; cand: Candidate }> = [];
    for (const kind of ["role-name", "same-text", "moved"] as const) {
        const hits = fit.filter((c) => matchesRule(kind, old, c));
        if (hits.length === 1) out.push({ kind, cand: hits[0]! });
    }
    return out;
}

/** Locators that could name `c` for this rule, best first (the first that finds exactly it is used). */
export function optionsFor(kind: Exclude<FixKind, "shared-element">, old: Locator, c: Candidate): Locator[] {
    const byRole: Locator[] = c.role && usable(c.name) ? [{ by: "role", role: c.role, value: c.name, exact: true }] : [];
    const byTestId: Locator[] = usable(c.testId) ? [{ by: "testId", value: c.testId }] : [];
    const byId: Locator[] = c.id && /^[A-Za-z][\w-]*$/.test(c.id) ? [{ by: "css", value: `#${c.id}` }] : [];
    switch (kind) {
        case "role-name":
            return [...byRole, ...byTestId];
        case "same-text": {
            const first: Locator[] =
                old.by === "label" && usable(c.placeholder) ? [{ by: "placeholder", value: c.placeholder, exact: true }] : old.by === "placeholder" && usable(c.label) ? [{ by: "label", value: c.label, exact: true }] : usable(c.text) ? [{ by: "text", value: c.text, exact: true }] : [];
            return [...first, ...byRole, ...byTestId];
        }
        case "moved":
            return [...byTestId, ...byId, ...byRole];
    }
}

/** The first option that Playwright resolves to exactly the candidate element. */
async function verified(page: Page, options: Locator[], key: number, data: RuntimeData): Promise<Locator | undefined> {
    for (const option of options) {
        try {
            const loc = locate(page, option, data);
            if ((await loc.count()) !== 1) continue;
            if ((await loc.getAttribute(MARKER, { timeout: 2_000 })) === String(key)) return option;
        } catch {
            /* this option cannot be used; try the next */
        }
    }
    return undefined;
}

async function find(input: DetRepairInput): Promise<DetFindResult> {
    const eligible = eligibility(input.spec, input.run);
    if (!eligible.ok) return none(eligible.reason);
    const { stepIndex, step, locator: old } = eligible.target;
    if (old.frame?.length) return none("the element is inside a frame");

    const session = await BrowserSession.launch(input.browser, { startUrl: input.baseUrl });
    try {
        const { page } = session;
        page.setDefaultTimeout(STEP_TIMEOUT);
        const data = runtimeData(input.spec.testData, input.credentials);
        for (const prior of input.spec.steps.slice(0, stepIndex)) {
            if (!REPLAYED.has(prior.action)) continue;
            try {
                await executeStep(page, prior, data, input.baseUrl, STEP_TIMEOUT);
            } catch {
                return none("the steps before the failing one could not be repeated");
            }
        }
        await settle(page);
        if ((await locate(page, old, data).count()) > 0) return none("the element is on the page, so it is not missing");

        const all = (await page.evaluate(COLLECT_SOURCE)) as Candidate[];
        const byKey = new Map(all.map((c) => [c.key, c]));
        const interactive = step.action !== "assert" && step.action !== "hover";
        const fixes: DetFix[] = [];
        /** Elements a fix already points at: one element is tried once, whichever rule found it. */
        const taken = new Set<number>();
        const add = (kind: FixKind, newLocator: Locator, key: number | undefined) => {
            if (fixes.length >= MAX_FIXES || sameLocator(newLocator, old) || fixes.some((f) => sameLocator(f.newLocator, newLocator))) return;
            if (key !== undefined && taken.has(key)) return;
            if (key !== undefined) taken.add(key);
            fixes.push({ kind, stepIndex, oldLocator: old, newLocator, newDescription: describeLocator(newLocator) });
        };

        // 1. The shared element's other locators: one that finds exactly one element the step can act on.
        for (const alt of input.alternatives ?? []) {
            if (alt.frame?.length) continue;
            try {
                const loc = locate(page, alt, data);
                if ((await loc.count()) !== 1) continue;
                const key = Number(await loc.getAttribute(MARKER, { timeout: 2_000 }));
                const cand = byKey.get(key);
                if (cand && (!suitsAction(step.action, cand) || (interactive && cand.disabled))) continue;
                add("shared-element", alt, Number.isFinite(key) ? key : undefined);
            } catch {
                /* this alternative cannot be used */
            }
        }
        // 2-4. The plain rules, each with exactly one match.
        for (const m of ruleMatches(old, step.action, all, interactive)) {
            const loc = await verified(page, optionsFor(m.kind, old, m.cand), m.cand.key, data);
            if (loc) add(m.kind, loc, m.cand.key);
        }
        return fixes.length ? { status: "found", stepIndex, oldLocator: old, fixes } : none("no element on the page matches by the plain rules (same role and name, same text, same attributes)");
    } finally {
        await session.close();
    }
}

/** Never throws and is bounded in time: a lookup that cannot be made only means "no fix without AI". */
export async function findDeterministicFixes(input: DetRepairInput): Promise<DetFindResult> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            find(input),
            new Promise<DetFindResult>((resolve) => {
                timer = setTimeout(() => resolve(none("the lookup took too long")), OVERALL_TIMEOUT);
            }),
        ]);
    } catch (err) {
        return none(`the page could not be examined (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
    } finally {
        clearTimeout(timer);
    }
}

/** "same text" etc. joined into one plain sentence for the job log and the test's history. */
export function fixSentence(old: Locator, fix: DetFix): string {
    return `${describeLocator(old)} was not on the page; with ${fix.newDescription} instead (found by ${FIX_KIND_WORDS[fix.kind]}) the test passed`;
}

