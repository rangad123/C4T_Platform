/** Changing a spec by a healing proposal: only ever the locator of one step, never what the step checks or does. */
import type { Locator, Step, TestSpec } from "../spec/schema.js";

const norm = (l: Locator) => JSON.stringify([l.by, l.role ?? null, l.value ?? null, l.exact ?? false, l.nth ?? null]);
export const sameLocator = (a: Locator, b: Locator): boolean => norm(a) === norm(b);

export type ApplyResult = { ok: true; spec: TestSpec } | { ok: false; reason: string };

/**
 * The spec with `newLocator` in place of `oldLocator` at `stepIndex`. Refuses (a stale proposal) when that step is no longer
 * there or no longer uses `oldLocator`: the test was edited or re-imported after the suggestion was made.
 */
export function applyLocator(spec: TestSpec, stepIndex: number, oldLocator: Locator, newLocator: Locator): ApplyResult {
    const step = spec.steps[stepIndex];
    if (!step || !("locator" in step) || !step.locator) return { ok: false, reason: "The test has changed since this suggestion was made: that step no longer looks for an element." };
    if (!sameLocator(step.locator, oldLocator)) return { ok: false, reason: "The test has changed since this suggestion was made: that step now looks for something else." };
    const steps = spec.steps.map((s, i): Step => (i === stepIndex ? ({ ...s, locator: newLocator } as Step) : s));
    return { ok: true, spec: { ...spec, steps } };
}
