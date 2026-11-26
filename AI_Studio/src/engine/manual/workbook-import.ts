/**
 * The test case workbook (src/platform/case-workbook.ts) read back as test cases for a code project (founder 2026-11-19, SPEC R6, owner
 * decisions Q1 and Q3).
 *
 * Only the "Test cases" sheet is read (xlsx-read.ts `readTable`, which bounds the file and refuses what it cannot read safely), with the
 * headers ID, Title, Type, Priority, Page, Preconditions, Steps, Expected result, Requirement in any order and case; only Title is required.
 * Per row:
 * - Type is Automated or Manual and Priority critical, high, medium or low, both without regard to case; an empty Type is Manual (the
 *   platform's default for a new case), an empty Priority medium; any other word skips the row with a reason.
 * - Steps, one per line as `action => expected` (the rule the platform has always used), numbered or not, are kept on every row,
 *   Automated or Manual (owner decision 2026-11-26).
 * - Preconditions are one per line; Expected result is kept as written; Page is the page's path; ID is kept as the case's source ID.
 * - The case's area is its page (its first 80 characters), so cases are grouped by page and two cases with the same title on two pages
 *   are two cases (an import leaves out a case whose title and area the project already has); a row without a page is in "General".
 * - Requirement is kept as the free text, and `requirementRef` carries it for the caller to match against the project's requirements.
 * A row that does not make a valid case is skipped with the row's number in the sheet and one sentence why.
 */
import { MAX_AREA, MAX_STEPS, ManualCaseInputSchema, PRIORITIES, clean, type ManualCaseInput } from "./cases.js";
import { readTable } from "./xlsx-read.js";

export const WORKBOOK_SHEET = "Test cases";
export const WORKBOOK_COLUMNS = ["ID", "Title", "Type", "Priority", "Page", "Preconditions", "Steps", "Expected result", "Requirement"] as const;

export interface WorkbookCase extends ManualCaseInput {
    /** The Requirement cell as written (trimmed), for matching to a requirement reference such as REQ-3. */
    requirementRef: string;
}

export interface WorkbookImport {
    cases: WorkbookCase[];
    skipped: Array<{ row: number; reason: string }>;
}

/** `action => expected` per line; a line without `=>` is an action with no expected result; blank lines are ignored. */
export function stepsFromCell(cell: string): Array<{ action: string; expected: string }> {
    return clean(cell)
        .split("\n")
        // The export numbers its steps ("1. Open the cart"); the number is not part of the step.
        .map((l) => l.trim().replace(/^\d{1,3}[.)]\s+/, ""))
        .filter(Boolean)
        .map((line) => {
            const at = line.indexOf("=>");
            return at < 0 ? { action: line, expected: "" } : { action: line.slice(0, at).trim(), expected: line.slice(at + 2).trim() };
        });
}

const lines = (cell: string) =>
    clean(cell)
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

const firstMessage = (err: { issues: Array<{ message: string; path: PropertyKey[] }> }): string => {
    const i = err.issues[0]!;
    const n = typeof i.path[1] === "number" ? i.path[1] + 1 : 0;
    const where = i.path[0] === "steps" && n ? `Step ${n}: ` : i.path[0] === "preconditions" && n ? `Precondition ${n}: ` : "";
    return `${where}${i.message}`;
};

/** Reads the workbook's bytes. Throws `XlsxReadError` (one sentence) when the file itself cannot be imported. */
export function casesFromWorkbook(bytes: Uint8Array): WorkbookImport {
    const rows = readTable(bytes, WORKBOOK_SHEET, { columns: WORKBOOK_COLUMNS, required: ["Title"] });
    const out: WorkbookImport = { cases: [], skipped: [] };
    for (const { row, values: v } of rows) {
        const type = v.Type!.trim().toLowerCase();
        if (type && type !== "automated" && type !== "manual") {
            out.skipped.push({ row, reason: `Type “${v.Type!.trim().slice(0, 20)}” is not Automated or Manual` });
            continue;
        }
        const automation = type === "automated" ? "automated" : "manual";
        const priority = v.Priority!.trim().toLowerCase();
        if (priority && !(PRIORITIES as readonly string[]).includes(priority)) {
            out.skipped.push({ row, reason: `Priority “${v.Priority!.trim().slice(0, 20)}” is not one of critical, high, medium or low` });
            continue;
        }
        const steps = stepsFromCell(v.Steps!);
        if (steps.length > MAX_STEPS) {
            out.skipped.push({ row, reason: `A case can have at most ${MAX_STEPS} steps` });
            continue;
        }
        const parsed = ManualCaseInputSchema.safeParse({
            title: v.Title,
            area: clean(v.Page!).slice(0, MAX_AREA),
            ...(priority ? { priority } : {}),
            automation,
            steps,
            preconditions: lines(v.Preconditions!),
            expected: v["Expected result"],
            page: v.Page,
            requirement: v.Requirement,
            sourceRef: v.ID,
        });
        if (!parsed.success) {
            out.skipped.push({ row, reason: firstMessage(parsed.error) });
            continue;
        }
        out.cases.push({ ...parsed.data, requirementRef: v.Requirement!.trim() });
    }
    return out;
}
