/**
 * Step list normalisation: what a new step does to the list so far. Pure, so it is tested without a browser.
 *  - fills of the same field in a row become one fill with the final value;
 *  - an identical goto right after a goto is dropped;
 *  - everything is capped (300 steps, value and text lengths);
 *  - indexes are always 0..n-1.
 */
import { locatorKey, REC_LIMITS, clip, type RecStep } from "./model.js";

export type NewStep = Omit<RecStep, "index">;

export interface PushResult {
    steps: RecStep[];
    /** What happened to the new step, for the session's notes. */
    outcome: "added" | "merged" | "dropped" | "full";
}

export const reindex = (steps: RecStep[]): RecStep[] => steps.map((s, i) => (s.index === i ? s : { ...s, index: i }));

/** Caps long text. A secret placeholder is short and untouched. */
export function capStep(step: NewStep): NewStep {
    const out: NewStep = { ...step };
    if (out.value !== undefined && !out.secret) out.value = clip(out.value, REC_LIMITS.maxValue);
    if (out.assert && typeof out.assert.expected === "string") out.assert = { ...out.assert, expected: clip(out.assert.expected, REC_LIMITS.maxAssertText) };
    if (out.url !== undefined) out.url = clip(out.url, 2000);
    return out;
}

export function pushStep(steps: RecStep[], incoming: NewStep, max: number = REC_LIMITS.maxSteps): PushResult {
    const step = capStep(incoming);
    const last = steps[steps.length - 1];
    if (last && step.kind === "fill" && last.kind === "fill" && locatorKey(last.locator) === locatorKey(step.locator) && last.ref === undefined) {
        const merged: RecStep = { ...last, value: step.value, secret: step.secret, describe: step.describe, at: step.at };
        return { steps: [...steps.slice(0, -1), merged], outcome: "merged" };
    }
    if (last && step.kind === "goto" && last.kind === "goto" && last.url === step.url) return { steps, outcome: "dropped" };
    if (steps.length >= max) return { steps, outcome: "full" };
    return { steps: [...steps, { ...step, index: steps.length }], outcome: "added" };
}

/** True when the list holds something worth saving: at least one step that is not only a goto. */
export const hasSavableSteps = (steps: RecStep[]): boolean => steps.some((s) => s.kind !== "goto");
