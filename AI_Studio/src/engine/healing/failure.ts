/**
 * Is this failure "the test could not find its element" - and is it a test the platform may offer to heal at all?
 * Anything else (an assertion that fails because the application shows something different, a server error, a security or
 * health finding) is a result about the application and is never healed.
 */
import { hasBlockMarks, hasBlocks } from "../blocks/expand.js";
import type { Locator, Step, TestSpec } from "../spec/schema.js";
import type { ScriptRun } from "../validation/runner.js";

/** Where the test came from: only tests written to exercise a user journey are healed, never the built-in check families. */
const HEALABLE_ORIGINS = new Set(["browser-agent", "imported", "manual", "requirements", "documentation", "plain-english", "recorded", /* AI phone tests (repair: mobile/repair/) */ "exploration"]);
/** Test types that are findings by design. */
const NEVER_HEALED_TYPES = new Set(["security", "accessibility", "visual", "health", "performance", "input"]);

/** Roles of controls: a renamed button is the same button, a renamed heading or alert is a different claim. */
export const CONTROL_ROLES = new Set(["button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "switch", "tab", "menuitem", "spinbutton", "slider", "listbox", "option"]);
/** Assertions about the state of one element. (`count`, `hidden`, text on the page, url, title... are claims about the app.) */
const HEALABLE_ASSERTS = new Set(["visible", "enabled", "disabled", "text", "value"]);

export interface HealTarget {
    stepIndex: number;
    step: Step;
    locator: Locator;
}
export type Eligibility = { ok: true; target: HealTarget } | { ok: false; reason: string };

/** The error says the element was never found (not "found but hidden / disabled / covered", not "several matched"). */
export function elementWasMissing(error: string | undefined): boolean {
    if (!error) return false;
    if (/strict mode violation/i.test(error)) return false;
    if (/element\(s\) not found/i.test(error)) return true;
    return /waiting for (getBy\w+|locator)\(/i.test(error) && !/locator resolved to/i.test(error);
}

export function healableAssert(step: Extract<Step, { action: "assert" }>): string | undefined {
    if (!HEALABLE_ASSERTS.has(step.check)) return `a check of "${step.check}" is about the application itself, not about finding an element`;
    const l = step.locator;
    if (!l) return "the check has no element to look for";
    // Identity strategies only: the name of a heading or message IS the claim being checked.
    if (l.by === "role" && !CONTROL_ROLES.has(l.role ?? "")) return `the check looks for a ${l.role ?? "page element"} by its name, which is itself what the check claims`;
    if (l.by === "text" || l.by === "css") return "the check finds its element by the text or the markup it is expected to show";
    return undefined;
}

/** Why a test is never healed whatever its failure (undefined = it may be). */
export function unhealableTest(spec: TestSpec): string | undefined {
    // Phone tests are repaired by mobile/repair/ (a look at the phone and the AI's choice among what it shows), web tests by heal.ts.
    if (spec.kind !== "web" && spec.kind !== "mobile") return "only web and phone tests can be healed";
    if (!HEALABLE_ORIGINS.has(spec.source.origin)) return "built-in checks report what they find; they are not healed";
    if (NEVER_HEALED_TYPES.has(spec.type)) return `${spec.type} checks report what they find; they are not healed`;
    // The numbers of the steps that ran are not the numbers in the stored test once reusable steps are put in place: fix the reusable steps instead.
    if (hasBlocks(spec) || hasBlockMarks(spec)) return "it uses reusable steps, so a repair would not know which step to change; edit the reusable steps instead";
    return undefined;
}

export function eligibility(spec: TestSpec, run: ScriptRun): Eligibility {
    const no = (reason: string): Eligibility => ({ ok: false, reason });
    const never = unhealableTest(spec);
    if (never) return no(never);
    if (run.status === "passed" || run.failedStepIndex < 0) return no("no single step failed");
    const stepIndex = run.failedStepIndex;
    const step = spec.steps[stepIndex];
    const result = run.steps.find((s) => s.index === stepIndex);
    if (!step || !result) return no("the failing step is unknown");
    if (!elementWasMissing(result.error)) return no("the failure is not a missing element");
    if (!("locator" in step) || !step.locator) return no("the failing step has no element locator");
    if (step.locator.nth !== undefined) return no("the step picks one of several matching elements by position");
    if (step.action === "assert") {
        const why = healableAssert(step);
        if (why) return no(why);
    }
    return { ok: true, target: { stepIndex, step, locator: step.locator } };
}
