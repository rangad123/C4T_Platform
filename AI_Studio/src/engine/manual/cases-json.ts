/**
 * JSON import and export of test cases (backups and the API). The test case workbook (.xlsx, workbook-import.ts) is the file people
 * import; CSV was removed (owner decision 2026-11-20): its routes answer `CSV_REPLACED`.
 */
import { ManualCaseInputSchema, MAX_CASES, type ManualCase, type ManualCaseInput } from "./cases.js";

/** Largest import text accepted (characters): about what the import route's body limit lets through. */
export const MAX_IMPORT_CHARS = 13_000_000;

export class ManualImportError extends Error {}

/** What the old CSV import and export answer now (owner decision 2026-11-20). */
export const CSV_REPLACED = "Test cases are no longer imported or exported as CSV files: the test case workbook (.xlsx) replaced them.";

export interface SkippedRow {
    /** The position in the list, starting at 1. */
    row: number;
    reason: string;
}

export interface ParsedImport {
    cases: ManualCaseInput[];
    skipped: SkippedRow[];
}

function firstMessage(err: { issues: Array<{ message: string; path: PropertyKey[] }> }): string {
    const i = err.issues[0]!;
    // "steps.2.action" reads better as "Step 3".
    const step = i.path[0] === "steps" && typeof i.path[1] === "number" ? `Step ${i.path[1] + 1}: ` : "";
    return `${step}${i.message}`;
}

function fromObjects(items: unknown[]): ParsedImport {
    const out: ParsedImport = { cases: [], skipped: [] };
    items.forEach((item, idx) => {
        const parsed = ManualCaseInputSchema.safeParse(item);
        if (parsed.success) out.cases.push(parsed.data);
        else out.skipped.push({ row: idx + 1, reason: firstMessage(parsed.error) });
    });
    return out;
}

function tooMany(n: number): ManualImportError {
    return new ManualImportError(`The file has ${n} cases. Import at most ${MAX_CASES} at a time.`);
}

/** A JSON text, or an already parsed list, or `{ cases: [...] }` as the export writes it. */
export function parseJsonCases(input: unknown): ParsedImport {
    let value = input;
    if (typeof input === "string") {
        if (input.length > MAX_IMPORT_CHARS) throw new ManualImportError("The file is too large to import.");
        try {
            value = JSON.parse(input.replace(/^\uFEFF/, ""));
        } catch {
            throw new ManualImportError("The file is not valid JSON.");
        }
    }
    const list = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { cases?: unknown }).cases) ? (value as { cases: unknown[] }).cases : null;
    if (!list) throw new ManualImportError("The file should hold a list of cases, or an object with a “cases” list.");
    if (list.length > MAX_CASES) throw tooMany(list.length);
    return fromObjects(list);
}

// ── Export ──────────────────────────────────────────────────────────────────

export function casesToJson(cases: ManualCase[], now = new Date()): string {
    return JSON.stringify(
        {
            version: 1,
            exportedAt: now.toISOString(),
            cases: cases.map((c) => ({ title: c.title, area: c.area, priority: c.priority, automation: c.automation, steps: c.steps, requirement: c.requirement, linkedTestIds: c.linkedTestIds, preconditions: c.preconditions, expected: c.expected, page: c.page, sourceRef: c.sourceRef })),
        },
        null,
        2,
    );
}
