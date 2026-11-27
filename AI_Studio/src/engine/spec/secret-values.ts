/**
 * L12: what a test writer (a model) typed or wrote never holds one of the run's secrets when the test is stored. Paid L4 rbac-5 WEB-037,
 * a wrong-password test, typed "Wrong" + the real password; it was kept in the spec, the script, the version and 84 step titles.
 *   - A typed value that holds a secret inside other text gets a generated value instead ("wrong-{{unique}}"): a new value per run that can
 *     never be the secret, so a wrong-password test still sends a wrong password.
 *   - Any other text (title, description, step descriptions, expected results, test data, preconditions) that holds one has it hidden.
 * A typed value that IS a secret is left as it is: that is the sign-in itself, the job of the credential placeholders.
 */
import type { TestSpec } from "./schema.js";

export const GENERATED_WRONG_VALUE = "wrong-{{unique}}";
const HIDDEN = "[hidden]";

/** Scrubs `spec` in place; the number of strings changed. Secrets shorter than 4 characters are not looked for. */
export function scrubSecretValues(spec: TestSpec, secrets: readonly string[]): number {
    const list = [...new Set(secrets.filter((s) => typeof s === "string" && s.length >= 4))].sort((a, b) => b.length - a.length);
    if (!list.length) return 0;
    const holds = (v: string) => list.some((s) => v.includes(s));
    let changed = 0;
    const replaced = new Map<string, string>();
    for (const step of spec.steps)
        if (step.action === "fill" && holds(step.value) && !list.includes(step.value)) {
            replaced.set(step.value, GENERATED_WRONG_VALUE);
            step.value = GENERATED_WRONG_VALUE;
            changed++;
        }
    const clean = (v: string): string => {
        let out = v;
        for (const [from, to] of replaced) out = out.split(from).join(to);
        for (const s of list) out = out.split(s).join(HIDDEN);
        if (out !== v) changed++;
        return out;
    };
    const walk = (o: unknown, skipValue: boolean): unknown => {
        if (typeof o === "string") return holds(o) ? clean(o) : o;
        if (Array.isArray(o)) return o.map((x) => walk(x, false));
        if (o && typeof o === "object") {
            const rec = o as Record<string, unknown>;
            // The stored sign-in typed as it is stays (see the module comment); everything else of the step is text.
            for (const k of Object.keys(rec)) if (!(skipValue && k === "value" && list.includes(rec[k] as string))) rec[k] = walk(rec[k], false);
            return rec;
        }
        return o;
    };
    for (const k of ["title", "description", "preconditions", "expectedResults", "testData"] as const) (spec as Record<string, unknown>)[k] = walk(spec[k], false);
    for (const step of spec.steps) walk(step, step.action === "fill");
    return changed;
}
