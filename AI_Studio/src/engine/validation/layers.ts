/**
 * C12 (Phase 4) layer report: for each layer a run can check (the page, the API, stored data read back through the API, the database),
 * whether it was checked and with how many tests, or why not. Each generated test carries its layer as meta.layer.
 */
import { z } from "zod";
import type { Step } from "../spec/schema.js";
import { InvariantReportSchema } from "./invariants.js";

export const LAYERS = ["page", "api", "storedData", "database"] as const;
export type Layer = (typeof LAYERS)[number];

/** `checks` (database only): the database check steps those tests hold. */
const LayerState = z.union([z.object({ status: z.literal("ran"), tests: z.number().int().min(0), checks: z.number().int().min(0).optional() }).strict(), z.object({ status: z.literal("unavailable"), reason: z.string().max(300) }).strict()]);
/** `invariants` (C5, optional): how many invariants the AI proposed and kept, and each dropped one with its reason. */
export const LayerReportSchema = z.object({ page: LayerState, api: LayerState, storedData: LayerState, database: LayerState, invariants: InvariantReportSchema.optional() }).strict();
export type LayerReport = z.infer<typeof LayerReportSchema>;

/** The layer a test checks: API tests and the API access checks (an accessDenied assert on an API call) are "api", the rest "page". */
export function layerOfSpec(spec: { kind: string; steps: Step[] }): Layer {
    if (spec.kind === "api") return "api";
    const api = spec.steps.some((s) => {
        if (s.action !== "assert" || s.check !== "accessDenied" || typeof s.expected !== "string") return false;
        try {
            return (JSON.parse(s.expected) as { api?: unknown }).api === true;
        } catch {
            return false;
        }
    });
    return api ? "api" : "page";
}

/** The report from the tests made per layer and what the run allowed. A layer with no test says the reason that applies first. */
/**
 * `database` is the run's database layer: unset, no read-only access is set up; `checks` the database check steps made (in
 * `tests.database` tests); `unavailable` why the set-up access gave none (the schema could not be read, say).
 */
export function layerReport(
    tests: Partial<Record<Layer, number>>,
    run: { web: boolean; api: boolean; apiEndpoints: number; dataChanges: boolean; database?: { checks: number } | { unavailable: string } },
): LayerReport {
    const why: Record<Layer, string> = {
        page: run.web ? "no page test was made" : "this run makes no web tests",
        api: !run.api ? "API tests are not part of this run" : !run.apiEndpoints ? "no API was found (no API document, and none seen while exploring)" : "no API test was made",
        storedData: run.dataChanges ? "no write was read back through the API" : "data changes are off, so nothing is written and read back",
        // Database tests exist only with a configured back end (C10, DatabaseProbe), so without one this is the reason.
        database: !run.database
            ? "no read-only database access is set up"
            : "unavailable" in run.database
              ? run.database.unavailable
              : !run.dataChanges
                ? "data changes are off, so no write is followed by a database check"
                : "no data-changing test was made to check the stored data after",
    };
    const state = (l: Layer) => (tests[l] ? { status: "ran" as const, tests: tests[l]! } : { status: "unavailable" as const, reason: `Not checked: ${why[l]}.` });
    const database = state("database");
    return { page: state("page"), api: state("api"), storedData: state("storedData"), database: database.status === "ran" && run.database && "checks" in run.database ? { ...database, checks: run.database.checks } : database };
}

/**
 * Runner capability `validationSteps` (Phase 4): version 1 runs the checks across layers in scripts: a kept response (`wait` with
 * `extract`, C4 and C9), a relation (C5 and C7) and a database check (C10). A runner older than that gets the tests without those steps,
 * and the run says so in this one sentence. Deploy the platform before the runner.
 */
export const VALIDATION_STEPS_VERSION = 1;
export const VALIDATION_STEPS_SKIPPED = "Your runner is older than the checks across layers, so the relation, kept-response and database steps were left out of the tests it ran. Download the runner again to run them.";

/** Whether a test has a step only `validationSteps` 1 understands. */
export const hasValidationSteps = (spec: { steps: readonly Step[] }): boolean =>
    spec.steps.some((s) => (s.action === "assertResponse" && (s.check === "relation" || s.check === "dbCheck")) || (s.action === "wait" && s.extract !== undefined));

/**
 * The test as an older runner runs it: without its relation and database steps, and its kept responses as plain waits.
 * shortcut: a later step that uses a value only a kept response captured still names it; only C4 tests do, and their relation goes too.
 */
export function withoutValidationSteps<T extends { steps: Step[] }>(spec: T): T {
    if (!hasValidationSteps(spec)) return spec;
    const steps = spec.steps
        .filter((s) => !(s.action === "assertResponse" && (s.check === "relation" || s.check === "dbCheck")))
        .map((s) => {
            if (s.action !== "wait" || s.extract === undefined) return s;
            const { extract: _kept, ...plain } = s;
            return plain as Step;
        });
    return { ...spec, steps };
}
