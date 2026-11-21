/**
 * C12 (Phase 4) layer report: for each layer a run can check (the page, the API, stored data read back through the API, the database),
 * whether it was checked and with how many tests, or why not. Each generated test carries its layer as meta.layer.
 */
import { z } from "zod";
import type { Step } from "../spec/schema.js";

export const LAYERS = ["page", "api", "storedData", "database"] as const;
export type Layer = (typeof LAYERS)[number];

const LayerState = z.union([z.object({ status: z.literal("ran"), tests: z.number().int().min(0) }).strict(), z.object({ status: z.literal("unavailable"), reason: z.string().max(300) }).strict()]);
export const LayerReportSchema = z.object({ page: LayerState, api: LayerState, storedData: LayerState, database: LayerState }).strict();
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
export function layerReport(tests: Partial<Record<Layer, number>>, run: { web: boolean; api: boolean; apiEndpoints: number; dataChanges: boolean }): LayerReport {
    const why: Record<Layer, string> = {
        page: run.web ? "no page test was made" : "this run makes no web tests",
        api: !run.api ? "API tests are not part of this run" : !run.apiEndpoints ? "no API was found (no API document, and none seen while exploring)" : "no API test was made",
        storedData: run.dataChanges ? "no write was read back through the API" : "data changes are off, so nothing is written and read back",
        // Database tests exist only with a configured back end (C10, DatabaseProbe), so without one this is the reason.
        database: "no read-only database access is set up",
    };
    const state = (l: Layer) => (tests[l] ? { status: "ran" as const, tests: tests[l]! } : { status: "unavailable" as const, reason: `Not checked: ${why[l]}.` });
    return { page: state("page"), api: state("api"), storedData: state("storedData"), database: state("database") };
}
