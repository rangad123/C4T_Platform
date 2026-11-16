/**
 * A failure caused by the test's own step: the step could not find or could not pick its element (not found, several match, the
 * field-by-label sentence, a timeout waiting for the element). That is a test to fix, never a finding about the application, whatever a
 * model said: only a check of what the application shows or answers (an assertion) or an application error can be a finding.
 * Console errors and failed requests of the page (blocked third-party fonts, mixed content) are evidence only and never decide this.
 */
import type { Step } from "../spec/schema.js";
import type { ScriptRun } from "./runner.js";

/** The step's element could not be told apart from others: always the test's to fix, also in a check. */
const AMBIGUOUS = /strict mode violation|No field labelled "[^"]*", and \d+ fields/i;
/** The step's element was not there (or not found in time). */
const NOT_FOUND = /No field labelled "|element\(s\) not found|resolved to 0 elements|waiting for (getBy\w+|locator|frameLocator|selector)\(|waiting for selector/i;
/** A Playwright expectation: a claim about the page, whose element missing is a result about the application. */
const EXPECTATION = /^(Error: )?expect\(/;

/**
 * The reason to show when a failed run is the test's own step, or undefined when it is not. `step` is the stored step that failed
 * (absent for a code test, whose steps are its code): a check step whose element is missing is a claim about the application.
 */
export function testStepFault(run: Pick<ScriptRun, "status" | "steps" | "error">, step?: Step): string | undefined {
    if (run.status === "passed") return undefined;
    const failed = run.steps.find((s) => s.status === "failed");
    const error = (failed?.error ?? run.error ?? "").trim();
    if (!error) return undefined;
    const ambiguous = AMBIGUOUS.test(error);
    if (!ambiguous) {
        if (!NOT_FOUND.test(error)) return undefined;
        const isCheck = step ? step.action === "assert" : EXPECTATION.test(error);
        if (isCheck) return undefined;
    }
    const first = error.split("\n")[0]!.replace(/^Error: /, "").slice(0, 600);
    const where = failed ? `Step ${failed.index + 1} (${failed.title})` : "A step";
    const advice = /point the step/i.test(first)
        ? ""
        : ambiguous
          ? " Several elements match: point the step at one of them, for example by its label, inside its form, or by its placeholder."
          : " Check that the element is on the page at that point and point the step at it as the page shows it now.";
    return `The test needs fixing, not your application: ${where} could not use its element. ${first.replace(/\.?$/, ".")}${advice}`.slice(0, 900);
}
