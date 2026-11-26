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
import type { TestSpec } from "../spec/schema.js";

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
    if ((step.check === "visible" || step.check === "hidden") && step.locator?.by === "text") return step.locator.value;
    return undefined;
}

/** Undefined when the check is not a page check this judges, or what it expects is stated (by the expectation or the test's own data). */
export function judgePageCheck(x: { spec: TestSpec; failedStep?: number; cited: string; apiAmount?: unknown; correlated?: boolean }): PageCheckJudgement | undefined {
    if (x.spec.kind !== "web" || x.correlated || x.failedStep === undefined) return undefined;
    const want = expectedText(x.spec.steps[x.failedStep - 1])?.trim();
    if (!want) return undefined;
    // The test's own data ({{unique}}, a value a step typed) is stated by the test itself.
    const typed = x.spec.steps.flatMap((s) => (s.action === "fill" ? [norm(s.value.replace(/\{\{[^}]*\}\}/g, " "))] : [])).filter((t) => t.length >= 3);
    const w = norm(want);
    if (/\{\{/.test(want) || typed.some((t) => w.includes(t) || (w.length >= 3 && t.includes(w)))) return undefined;
    const cited = norm(x.cited);
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
 * check that 81 is refused). Only a check about a length or limit (its text names the limit, characters, length or a maximum). Undefined
 * otherwise, or when no limit is known.
 */
export function cutByMaxlength(spec: TestSpec, failedStep: number | undefined, limits: ReadonlyMap<string, number> | undefined): string | undefined {
    if (spec.kind !== "web" || failedStep === undefined || !limits?.size) return undefined;
    const check = spec.steps[failedStep - 1];
    if (check?.action !== "assert") return undefined;
    const said = [typeof check.expected === "string" || typeof check.expected === "number" ? String(check.expected) : "", check.locator?.by === "text" ? check.locator.value : "", check.description ?? ""].join(" ");
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
