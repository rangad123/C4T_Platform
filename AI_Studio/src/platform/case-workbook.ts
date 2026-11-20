/**
 * The Test Case Generation outcome as a workbook (.xlsx) to download (founder 2026-11-19, SPEC R7 and R9, owner decision Q3).
 *
 * Exactly three sheets, in this order:
 *   - "Test cases": ID, Title, Type, Priority, Page, Preconditions, Steps, Expected result, Requirement (one row per case);
 *   - "Pages": Page, Address, Purpose (one row per page; Page is the page's path, the key the other sheets use);
 *   - "Tree": Node, Parent, Page (one row per tree node).
 * A code project's Import reads the "Test cases" sheet back (src/engine/manual/xlsx-read.ts), so the headers are part of the contract.
 *
 * Steps are written only for Manual cases (R7), one per line as `action => expected` (read back by src/engine/manual/workbook-import.ts stepsFromCell), or the
 * action alone when it has no expected result. Preconditions and expected results are one per line.
 *
 * Safety comes from the writer (src/shared/xlsx.ts `buildXlsx`): every cell is an inline string, so a value that starts with
 * = + - @ is shown as typed and never runs as a formula; text is XML-escaped, characters XML cannot carry are dropped and a cell longer
 * than Excel's limit is cut. No prefix is added, so an imported title is exactly the title that was written. Here, the Tree keeps its
 * integrity (a Parent that is not another Node is written empty, a Page that is not a row of Pages is written empty) and no sheet goes
 * past Excel's row limit. Past the Import's 5,000 rows every case is still written, and a line under the last one says how many more
 * there are than the Import takes.
 */
import type { CaseOutcome, CaseOutcomeCase } from "./case-outcome-types.js";
import { buildXlsx, type XlsxSheet } from "../shared/xlsx.js";
// The most test case rows a code project's Import reads: the reader's own limit, so the note below and the Import never disagree.
import { XLSX_MAX_ROWS as CASE_IMPORT_MAX_ROWS } from "../engine/manual/xlsx-read.js";

export const CASE_WORKBOOK_SHEETS = ["Test cases", "Pages", "Tree"] as const;
export const CASE_WORKBOOK_HEADERS = {
    "Test cases": ["ID", "Title", "Type", "Priority", "Page", "Preconditions", "Steps", "Expected result", "Requirement"],
    Pages: ["Page", "Address", "Purpose"],
    Tree: ["Node", "Parent", "Page"],
} as const;

/** Excel holds at most 1 048 576 rows in a sheet, the header included. */
const ROW_MAX = 1_048_576;

const n = (x: number) => x.toLocaleString("en-US");
/**
 * The line under the last test case when there are more than the Import reads: the workbook still has them all, and says so. It sits in
 * the ID column with the other cells empty, so an Import never takes it for a test case.
 */
export const tooManyCasesNote = (total: number): string =>
    `Note: this workbook has ${n(total)} test cases, ${n(total - CASE_IMPORT_MAX_ROWS)} more than a code project's Import takes (${n(CASE_IMPORT_MAX_ROWS)}). Before you import it, delete this line and ${n(total - CASE_IMPORT_MAX_ROWS)} test case rows, and import those in a second workbook.`;

const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, " ").trim();
const lines = (xs: readonly string[]) => xs.map(oneLine).filter(Boolean).join("\n");
const word = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function stepsCell(c: CaseOutcomeCase): string {
    if (c.type !== "manual") return "";
    return c.steps
        .map((s) => {
            const action = oneLine(s.action);
            const expected = oneLine(s.expected);
            return expected ? `${action} => ${expected}` : action;
        })
        .filter(Boolean)
        .join("\n");
}

function sheet(name: (typeof CASE_WORKBOOK_SHEETS)[number], rows: string[][], widths: number[]): XlsxSheet {
    return { name, rows: [[...CASE_WORKBOOK_HEADERS[name]], ...rows.slice(0, ROW_MAX - 1)], header: true, wrap: true, widths };
}

/** The outcome as the three-sheet .xlsx of SPEC R9. */
export function buildCaseWorkbook(o: CaseOutcome): Uint8Array {
    const cases = o.cases.slice(0, ROW_MAX - 2).map((c) => [c.id, c.title, word(c.type), word(c.priority), c.page, lines(c.preconditions), stepsCell(c), lines(c.expected), c.requirement]);
    if (o.cases.length > CASE_IMPORT_MAX_ROWS) cases.push([tooManyCasesNote(o.cases.length), "", "", "", "", "", "", "", ""]);
    const pages = o.pages.map((p) => [p.path, p.url, p.purpose]);
    const pagePaths = new Set(o.pages.map((p) => p.path));
    const nodes = new Set(o.tree.map((t) => t.node));
    const tree = o.tree.map((t) => [t.node, t.parent && t.parent !== t.node && nodes.has(t.parent) ? t.parent : "", pagePaths.has(t.page) ? t.page : ""]);
    return buildXlsx(
        [
            sheet("Test cases", cases, [10, 50, 11, 10, 24, 40, 60, 50, 24]),
            sheet("Pages", pages, [30, 50, 60]),
            sheet("Tree", tree, [30, 30, 30]),
        ],
        { title: "Test cases" },
    );
}
