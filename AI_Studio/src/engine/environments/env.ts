/**
 * Named environments (staging, production...): the pure rules. Which tests a read-only production must not run, how an
 * environment's variables reach a script, and the names that are allowed. Storage lives in
 * platform/environments-store.ts; running in ./run.ts.
 *
 * Idea ported from ai-testing-agent's `env_manager.py` (environments like Postman, with a read-only "production"
 * mode that blocks destructive tests); see THIRD_PARTY_LICENSES.md.
 */
import type { TestSpec } from "../spec/schema.js";

/** Environment names are shown in the UI and used in the CLI (`--env staging`). */
export const ENV_NAME = /^[a-z][a-z0-9_-]{0,23}$/;
export const MAX_ENVIRONMENTS = 8;
/** Variable names become `{{env.NAME}}` and TEST_ENV_NAME, so they follow identifier rules. */
export const VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
export const MAX_VARIABLES = 30;
export const MAX_VARIABLE_VALUE = 500;

/** The variable a script reads for `{{env.NAME}}`; the platform sets it for the run, and a person can set it in their shell. */
export const envVarFor = (name: string): string => `TEST_ENV_${name.toUpperCase()}`;

/** Process environment of a run: one TEST_ENV_<NAME> per variable. */
export function variableEnv(vars: Record<string, string> | undefined): Record<string, string> {
    return Object.fromEntries(Object.entries(vars ?? {}).map(([k, v]) => [envVarFor(k), v]));
}

/** Variable names that differ only by case would share one process variable. */
export function caseDuplicates(names: string[]): string | undefined {
    const seen = new Map<string, string>();
    for (const n of names) {
        const k = n.toUpperCase();
        if (seen.has(k)) return seen.get(k) === n ? n : `${seen.get(k)} / ${n}`;
        seen.set(k, n);
    }
    return undefined;
}

/** Tag a test can carry to say "this changes data" when the platform cannot tell from the steps. */
export const CHANGES_DATA_TAGS = ["changes-data", "mutating"];

/**
 * Does running this test change data on the application? True for requests that are not read-only (POST, PUT, PATCH, DELETE),
 * for form probing that also submits data-sending forms (`inputHandling` with "all"), and for tests tagged `changes-data`.
 * Web journeys that click through a form cannot be recognised from their steps: tag them, or keep them off production.
 */
export function changesData(spec: TestSpec): boolean {
    if (spec.tags.some((t) => CHANGES_DATA_TAGS.includes(t.toLowerCase()))) return true;
    return spec.steps.some((s) => {
        if (s.action === "request") return !["GET", "HEAD", "OPTIONS"].includes(s.method);
        if (s.action === "assert" && s.check === "inputHandling") return typeof s.expected === "string" && /^\s*all\b/.test(s.expected);
        return false;
    });
}

/** The plain-language reason stored next to a test that production skipped. */
export const PRODUCTION_SKIP_REASON = "production is read-only: this test changes data, so it was not run here.";
export const MOBILE_SKIP_REASON = "Mobile tests run on a device, so they are not run against an environment.";

/** Statuses stored for an environment run. "finding" = a real application problem (NEEDS_REVIEW in the main run). */
export type EnvStatus = "passed" | "failed" | "finding" | "skipped";
