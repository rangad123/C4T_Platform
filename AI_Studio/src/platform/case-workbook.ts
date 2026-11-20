/**
 * The Test Case Generation outcome as a workbook (.xlsx) to download (founder 2026-11-19, SPEC R7 and R9, owner decision Q3).
 *
 * Exactly three sheets, in this order:
 *   - "Test cases": ID, Title, Type, Priority, Page, Preconditions, Steps, Expected result, Requirement (one row per case);
 *   - "Pages": Page, Address, Purpose (one row per page; Page is the page's path, the key the other sheets use);
 *   - "Tree": Node, Parent, Page (one row per tree node).
 * A code project's Import reads the "Test cases" sheet back (src/engine/manual/xlsx-read.ts), so the headers are part of the contract.
 *
 * Steps are written only for Manual cases (R7), one per line as `action => expected` (the CSV rule, src/engine/manual/csv.ts), or the
 * action alone when it has no expected result. Preconditions and expected results are one per line.
 *
 * Safety comes from the writer (src/security/findings/xlsx.ts `buildXlsx`): every cell is an inline string, so a value that starts with
 * = + - @ is shown as typed and never runs as a formula; text is XML-escaped, characters XML cannot carry are dropped and a cell longer
 * than Excel's limit is cut. No prefix is added, so an imported title is exactly the title that was written. Here, the Tree keeps its
 * integrity (a Parent that is not another Node is written empty, a Page that is not a row of Pages is written empty) and no sheet goes
 * past Excel's row limit.
 */
import type { ManualCase } from "../engine/manual/cases.js";
import type { CaseOutcome, CaseOutcomeCase } from "./case-outcome-types.js";
import { buildXlsx, type XlsxSheet } from "../security/findings/xlsx.js";

export const CASE_WORKBOOK_SHEETS = ["Test cases", "Pages", "Tree"] as const;
export const CASE_WORKBOOK_HEADERS = {
    "Test cases": ["ID", "Title", "Type", "Priority", "Page", "Preconditions", "Steps", "Expected result", "Requirement"],
    Pages: ["Page", "Address", "Purpose"],
    Tree: ["Node", "Parent", "Page"],
} as const;

/** Excel holds at most 1 048 576 rows in a sheet, the header included. */
const ROW_MAX = 1_048_576;

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
    const cases = o.cases.map((c) => [c.id, c.title, word(c.type), word(c.priority), c.page, lines(c.preconditions), stepsCell(c), lines(c.expected), c.requirement]);
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

/**
 * A code project's test cases as the same workbook (owner decision 2026-11-20, FX16), so the download imports into another code project.
 * Pages and Tree name each page the cases are on once, with no address, purpose or parent: a code project keeps no more than that.
 */
export function manualCaseWorkbook(cases: readonly ManualCase[]): Uint8Array {
    const pages = [...new Set(cases.map((c) => c.page).filter(Boolean))];
    return buildCaseWorkbook({
        caseAgent: false,
        runs: [],
        notOpened: 0,
        missing: [],
        pages: pages.map((path) => ({ path, url: "", title: "", purpose: "" })),
        tree: pages.map((node) => ({ node, parent: null, page: node, title: "", cases: 0 })),
        cases: cases.map((c) => ({ id: c.ref, title: c.title, type: c.automation, priority: c.priority, page: c.page, preconditions: c.preconditions, steps: c.steps, expected: c.expected.split("\n"), requirement: c.requirement })),
    });
}
