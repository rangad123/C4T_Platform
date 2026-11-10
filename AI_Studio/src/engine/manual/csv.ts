/**
 * CSV and JSON import/export of manual cases. No dependency: the CSV reader and writer are small and strict.
 *
 * CSV columns: `title,area,priority,steps`. The `steps` cell holds one step per line as `action => expected`.
 * Exported cells that start with `=`, `+`, `-` or `@` get a leading `'` so a spreadsheet never runs them as a formula;
 * the import removes that quote again, so a file survives a round trip.
 */
import { ManualCaseInputSchema, MAX_CASES, MAX_STEPS, type ManualCase, type ManualCaseInput, PRIORITIES, clean } from "./cases.js";

/** Largest import text accepted (characters). Far more than 500 cases of maximum size would need is refused. */
export const MAX_IMPORT_CHARS = 2_000_000;

export class ManualImportError extends Error {}

export interface SkippedRow {
    /** CSV: the row number in the file (the header is row 1). JSON: the position in the list, starting at 1. */
    row: number;
    reason: string;
}

export interface ParsedImport {
    cases: ManualCaseInput[];
    skipped: SkippedRow[];
}

// ── CSV reading ─────────────────────────────────────────────────────────────

/** RFC 4180 style: commas, double-quoted cells with "" escapes, newlines allowed inside quotes. */
export function parseCsv(input: string): string[][] {
    const text = input.replace(/^﻿/, "");
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let inQuotes = false;
    let started = false; // anything seen on this row (so a trailing newline does not add an empty row)
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]!;
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    cell += '"';
                    i++;
                } else inQuotes = false;
            } else cell += ch;
            continue;
        }
        if (ch === '"' && cell === "") {
            inQuotes = true;
            started = true;
        } else if (ch === ",") {
            row.push(cell);
            cell = "";
            started = true;
        } else if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && text[i + 1] === "\n") i++;
            if (started || cell !== "") {
                row.push(cell);
                rows.push(row);
            }
            row = [];
            cell = "";
            started = false;
        } else {
            cell += ch;
            started = true;
        }
    }
    if (inQuotes) throw new ManualImportError("The CSV has a quote that is never closed. Check the cell that starts with a double quote.");
    if (started || cell !== "") {
        row.push(cell);
        rows.push(row);
    }
    return rows;
}

/** Undo the leading quote the export adds in front of formula-looking cells. */
const unprotect = (cell: string): string => (/^'[=+\-@]/.test(cell) ? cell.slice(1) : cell);

/** `action => expected` per line. Blank lines are ignored; a line without `=>` is an action with no expected result. */
export function parseSteps(cell: string): Array<{ action: string; expected: string }> {
    return clean(cell)
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
            const at = line.indexOf("=>");
            return at < 0 ? { action: line, expected: "" } : { action: line.slice(0, at).trim(), expected: line.slice(at + 2).trim() };
        });
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

export function parseCsvCases(input: string): ParsedImport {
    if (input.length > MAX_IMPORT_CHARS) throw new ManualImportError("The file is too large to import.");
    const rows = parseCsv(input);
    if (rows.length === 0) throw new ManualImportError("The file is empty. It needs a header row with at least a “title” column.");
    const header = rows[0]!.map((h) => unprotect(h).trim().toLowerCase());
    const col = (name: string) => header.indexOf(name);
    if (col("title") < 0) throw new ManualImportError("The first row must be a header with a “title” column. The other columns are area, priority and steps.");
    const data = rows.slice(1);
    if (data.length > MAX_CASES) throw tooMany(data.length);

    const out: ParsedImport = { cases: [], skipped: [] };
    data.forEach((cells, idx) => {
        const get = (name: string) => (col(name) < 0 ? "" : unprotect(cells[col(name)] ?? ""));
        // A row with nothing in it is a stray blank line from the spreadsheet, not a mistake.
        if (cells.every((c) => c.trim() === "")) return;
        const priority = get("priority").trim().toLowerCase();
        if (priority && !(PRIORITIES as readonly string[]).includes(priority)) {
            out.skipped.push({ row: idx + 2, reason: `Priority “${priority.slice(0, 20)}” is not one of ${PRIORITIES.join(", ")}` });
            return;
        }
        const steps = parseSteps(get("steps"));
        if (steps.length > MAX_STEPS) {
            out.skipped.push({ row: idx + 2, reason: `A case can have at most ${MAX_STEPS} steps` });
            return;
        }
        const parsed = ManualCaseInputSchema.safeParse({ title: get("title"), area: get("area"), ...(priority ? { priority } : {}), steps });
        if (parsed.success) out.cases.push(parsed.data);
        else out.skipped.push({ row: idx + 2, reason: firstMessage(parsed.error) });
    });
    return out;
}

/** A JSON text, or an already parsed list, or `{ cases: [...] }` as the export writes it. */
export function parseJsonCases(input: unknown): ParsedImport {
    let value = input;
    if (typeof input === "string") {
        if (input.length > MAX_IMPORT_CHARS) throw new ManualImportError("The file is too large to import.");
        try {
            value = JSON.parse(input);
        } catch {
            throw new ManualImportError("The file is not valid JSON.");
        }
    }
    const list = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { cases?: unknown }).cases) ? (value as { cases: unknown[] }).cases : null;
    if (!list) throw new ManualImportError("The file should hold a list of cases, or an object with a “cases” list.");
    if (list.length > MAX_CASES) throw tooMany(list.length);
    return fromObjects(list);
}

/** JSON or CSV by the declared format, or by looking at the text when none is given. */
export function parseImport(content: unknown, format?: "json" | "csv"): ParsedImport {
    if (typeof content === "string") {
        const f = format ?? (/^\s*[[{]/.test(content.replace(/^﻿/, "")) ? "json" : "csv");
        return f === "csv" ? parseCsvCases(content) : parseJsonCases(content.replace(/^﻿/, ""));
    }
    if (format === "csv") throw new ManualImportError("CSV content has to be sent as text.");
    return parseJsonCases(content);
}

// ── Export ──────────────────────────────────────────────────────────────────

/** A cell a spreadsheet could take for a formula gets a leading quote (OWASP "CSV injection"). */
export const protectCell = (s: string): string => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

const quote = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** One step per line; a newline or `=>` inside a step would break that format, so they become a space and `->`. */
const stepLine = (s: { action: string; expected: string }): string => {
    const one = (t: string) => t.replace(/\s*\n\s*/g, " ");
    return `${one(s.action).replace(/=>/g, "->")} => ${one(s.expected)}`.replace(/ => $/, "");
};

export function casesToCsv(cases: Array<Pick<ManualCase, "title" | "area" | "priority" | "steps">>): string {
    const lines = [["title", "area", "priority", "steps"].join(",")];
    for (const c of cases) {
        const cells = [c.title, c.area, c.priority, c.steps.map(stepLine).join("\n")];
        lines.push(cells.map((x) => quote(protectCell(x))).join(","));
    }
    return `${lines.join("\r\n")}\r\n`;
}

export function casesToJson(cases: ManualCase[], now = new Date()): string {
    return JSON.stringify(
        {
            version: 1,
            exportedAt: now.toISOString(),
            cases: cases.map((c) => ({ title: c.title, area: c.area, priority: c.priority, automation: c.automation, steps: c.steps, requirement: c.requirement, linkedTestIds: c.linkedTestIds })),
        },
        null,
        2,
    );
}
