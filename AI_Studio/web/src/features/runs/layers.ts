/**
 * C12 (Phase 4): the "Checked layers" line of a finished exploration (GET /api/projects/:id/jobs/:jobId/coverage, `layers`): which
 * layers its tests check (the page, the API, stored data read back through the API, the database) with how many tests, and why each
 * other layer was not checked. The shape is the engine's LayerReportSchema (src/engine/validation/layers.ts).
 */
export type LayerState = { status: "ran"; tests: number; checks?: number } | { status: "unavailable"; reason: string };
export interface LayerReport {
    page: LayerState;
    api: LayerState;
    storedData: LayerState;
    database: LayerState;
}

export const LAYER_ORDER = ["page", "api", "storedData", "database"] as const;
export const LAYER_WORDS: Record<(typeof LAYER_ORDER)[number], string> = { page: "Page", api: "API", storedData: "Stored data", database: "Database" };

const tests = (n: number) => `${n} test${n === 1 ? "" : "s"}`;

/** "Page (4 tests), Database (1 test, 3 checks)", or "None"; and each layer not checked with its reason. */
export function layersLine(r: LayerReport): { checked: string; notChecked: Array<{ layer: string; reason: string }> } {
    const ran: string[] = [];
    const notChecked: Array<{ layer: string; reason: string }> = [];
    for (const k of LAYER_ORDER) {
        const s = r[k];
        if (s.status === "ran") ran.push(`${LAYER_WORDS[k]} (${tests(s.tests)}${s.checks !== undefined ? `, ${s.checks} check${s.checks === 1 ? "" : "s"}` : ""})`);
        else notChecked.push({ layer: LAYER_WORDS[k], reason: s.reason.replace(/^Not checked:\s*/, "") });
    }
    return { checked: ran.length ? ran.join(", ") : "None", notChecked };
}
