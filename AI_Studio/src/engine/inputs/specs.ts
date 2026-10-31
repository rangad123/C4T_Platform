/**
 * Deterministic input-handling specs (no LLM): one "input" spec per page that has a form safe to probe
 * (see checks.ts for the rules the page-side helper applies). Also classifies a failed run as an application finding.
 */
import type { DraftSpec } from "../api/test-specs.js";
import type { Step, TestSpec } from "../spec/schema.js";
import type { AppModel, FormModel, PageModel } from "../understanding/app-model.js";
import type { ScriptRun } from "../validation/runner.js";
import { INPUT_ADVICE, INPUT_FAILURE_PREFIX, worstInputTag } from "./checks.js";

export interface InputGenOptions {
    maxPages: number;
    /** The user enabled tests that change data: POST forms (other than login/checkout-style ones) may be probed too. */
    allowMutating: boolean;
}

const SENSITIVE_PURPOSE = new Set<FormModel["purpose"]>(["login", "signup", "checkout"]);
const SENSITIVE_FIELD = /pass(word)?|card|cc-|cvv|cvc|security.?code|otp|one-time|ssn|iban|account.?number|\bpin\b/i;
const TEXT_TYPES = new Set(["text", "search", "email", "url", "tel", "textarea", ""]);

/** Does the crawler's model say this form can be probed under the given rules? (The page-side helper re-checks in the live page.) */
export function formIsProbeable(f: FormModel, allowMutating: boolean): boolean {
    if (SENSITIVE_PURPOSE.has(f.purpose)) return false;
    if (f.fields.some((x) => x.type === "password" || SENSITIVE_FIELD.test(`${x.name ?? ""} ${x.label ?? ""} ${x.placeholder ?? ""}`))) return false;
    if (!f.fields.some((x) => TEXT_TYPES.has(x.type))) return false;
    const method = (f.method ?? "get").toLowerCase();
    return method === "get" || allowMutating;
}

export function generateInputSpecs(model: AppModel, opts: InputGenOptions): DraftSpec[] {
    // Pages the crawl reached while logged in would redirect a fresh browser to the login page.
    const gated = model.authentication.loggedIn ? new Set(["account", "dashboard"]) : new Set<string>();
    const seen = new Set<string>();
    const out: DraftSpec[] = [];
    for (const page of model.pages as PageModel[]) {
        if (out.length >= opts.maxPages) break;
        if (page.type === "error" || gated.has(page.type) || (page.status !== 0 && (page.status < 200 || page.status >= 400))) continue;
        try {
            if (new URL(page.url).origin !== model.origin) continue;
        } catch {
            continue;
        }
        const path = (page.path || "/").split("#")[0]!;
        if (seen.has(path) || !page.forms.some((f) => formIsProbeable(f, opts.allowMutating))) continue;
        seen.add(path);
        const name = page.title?.trim() || path;
        const steps: Step[] = [
            { action: "navigate", url: path, description: `Open ${path}` },
            { action: "assert", check: "inputHandling", expected: opts.allowMutating ? "all" : "safe", description: "Forms handle unusual input without errors and without showing it as page markup" },
        ];
        out.push({
            title: `Forms handle unusual input safely (${path})`,
            description: `Tries harmless unusual input in the forms on "${name}" (HTML-like text, nothing, spaces, very long text, emoji, quotes) and checks the page escapes it, the server does not fail and the page does not break. ${opts.allowMutating ? "Forms that send data are included because tests that change data are enabled; login, sign-up and payment forms never are." : "Only search-type forms (GET) are submitted; forms that send data are never touched."}`,
            kind: "web",
            category: "Input handling",
            type: "input",
            priority: "medium",
            preconditions: [],
            steps,
            expectedResults: ["Typed text is shown as text, not as page markup", "No server error, script error or blank page for unusual input"],
            testData: {},
            tags: ["input", "security"],
            source: { origin: "input-check" },
        });
    }
    return out;
}

/** The failure text of the step, minus any call log Playwright appended. */
function ownMessage(text: string): string | undefined {
    const at = text.indexOf(INPUT_FAILURE_PREFIX);
    if (at < 0) return undefined;
    const lines = text.slice(at).split("\n");
    const end = lines.findIndex((l, i) => i > 0 && !l.startsWith("- "));
    return lines
        .slice(0, end < 0 ? lines.length : end)
        .join("\n")
        .trim();
}

/** A failed run is an application finding only when it is the check's own message (not "the page did not load"). */
export function inputFinding(spec: TestSpec, run: ScriptRun): string | undefined {
    if (run.status !== "failed") return undefined;
    const isStep = (s: Step | undefined) => s?.action === "assert" && s.check === "inputHandling";
    let message: string | undefined;
    for (const st of run.steps) if (st.status === "failed" && isStep(spec.steps[st.index])) message = ownMessage(st.error ?? "") ?? message;
    if (!message && run.steps.length === 0 && spec.steps.some(isStep)) message = ownMessage(run.error ?? "");
    return message ? `${message}\nHow to fix: ${INPUT_ADVICE}`.slice(0, 2500) : undefined;
}

/** Worst severity of an input-handling finding reason (undefined if it is not one). */
export function parseInputReason(reason: string): "high" | "medium" | "low" | undefined {
    if (!reason.includes(INPUT_FAILURE_PREFIX)) return undefined;
    return worstInputTag(reason.split(/^how to fix:/im)[0] ?? "") ?? "low";
}
