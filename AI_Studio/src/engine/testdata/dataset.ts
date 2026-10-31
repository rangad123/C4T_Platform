/**
 * Test data sets ("data-driven tests"): a named table of strings that a test spec can name with `testData.dataSet`.
 * The generators render ONE test per row, and the rows are embedded in the script as plain data, so a downloaded
 * script runs on its own. Because they are embedded in a file that is downloaded and shared, data sets are not a
 * place for secrets: sign-in details belong in the project's credentials, test accounts or environment secrets.
 *
 * Idea ported from ai-testing-agent's `data_manager.py` (test data from YAML/JSON files, with validation), reduced to
 * what the platform's specs can use: flat tables imported from CSV, JSON or YAML (see THIRD_PARTY_LICENSES.md).
 */
import YAML from "yaml";

export const MAX_DATA_ROWS = 200;
export const MAX_DATA_COLUMNS = 20;
export const MAX_VALUE_LENGTH = 500;
/** More rows than this in one spec are not rendered: the tests of the first rows run and a plain note says so. */
export const MAX_ROWS_PER_SPEC = 25;
/** The key of `testData` that names the data set. It is not a value the steps can use. */
export const DATA_SET_KEY = "dataSet";

export const DATA_SET_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
/** Columns become `{{column}}` placeholders, so they follow the placeholder alphabet without dots (those mean credentials./env.). */
export const COLUMN_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
/** Names that already mean something in a step. */
const RESERVED_COLUMNS = new Set(["unique", DATA_SET_KEY, "credentials", "env"]);

export interface DataSet {
    columns: string[];
    rows: Array<Record<string, string>>;
}

export class DataSetError extends Error {}

export const DATA_FORMATS = ["csv", "json", "yaml"] as const;
export type DataFormat = (typeof DATA_FORMATS)[number];

/** Which format a file name suggests, or undefined when it does not (the caller then looks at the content). */
export function formatFromFilename(name: string | undefined): DataFormat | "excel" | undefined {
    const ext = /\.([a-z0-9]+)$/i.exec(name ?? "")?.[1]?.toLowerCase();
    if (ext === "csv" || ext === "tsv") return "csv";
    if (ext === "json") return "json";
    if (ext === "yaml" || ext === "yml") return "yaml";
    if (ext === "xlsx" || ext === "xls" || ext === "ods") return "excel";
    return undefined;
}

export function sniffFormat(text: string): DataFormat {
    const t = text.trimStart();
    if (t.startsWith("[") || t.startsWith("{")) return "json";
    // A header row with commas is CSV; anything else with "key:" lines is YAML.
    const first = t.split(/\r?\n/, 1)[0] ?? "";
    if (/^\s*-\s|^[\w"'-]+\s*:\s/.test(first) && !/,/.test(first)) return "yaml";
    return "csv";
}

/** CSV with quotes ("a,b", "" for a quote), CRLF or LF, a leading BOM, and a comma, semicolon or tab delimiter (taken from the header line). */
export function parseCsv(text: string): string[][] {
    const src = text.replace(/^﻿/, "");
    const head = src.split(/\r?\n/, 1)[0] ?? "";
    const count = (c: string) => head.split(c).length - 1;
    const delimiter = count("\t") > 0 && count("\t") >= count(",") ? "\t" : count(";") > count(",") ? ";" : ",";
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let quoted = false;
    let line = 1;
    for (let i = 0; i < src.length; i++) {
        const ch = src[i]!;
        if (quoted) {
            if (ch === '"') {
                if (src[i + 1] === '"') {
                    cell += '"';
                    i++;
                } else quoted = false;
            } else {
                if (ch === "\n") line++;
                cell += ch;
            }
            continue;
        }
        if (ch === '"' && cell === "") quoted = true;
        else if (ch === delimiter) {
            row.push(cell);
            cell = "";
        } else if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && src[i + 1] === "\n") i++;
            row.push(cell);
            cell = "";
            rows.push(row);
            row = [];
            line++;
        } else cell += ch;
    }
    if (quoted) throw new DataSetError(`The file ends inside a quoted value that was opened near line ${line}. Close the quote or remove it.`);
    if (cell !== "" || row.length) {
        row.push(cell);
        rows.push(row);
    }
    // Blank lines (a single empty cell) are not rows.
    return rows.filter((r) => !(r.length === 1 && r[0]!.trim() === ""));
}

const asText = (v: unknown, where: string): string => {
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
    throw new DataSetError(`${where} is a nested list or object; a data set holds plain values only (text, numbers, true/false).`);
};

/** Objects (`[{...}]`, or `{ columns, rows }`, or `{ rows: [{...}] }`) from parsed JSON/YAML into a table. */
function fromStructured(data: unknown): DataSet {
    let list: unknown = data;
    let columns: string[] | undefined;
    if (data && typeof data === "object" && !Array.isArray(data)) {
        const o = data as { columns?: unknown; rows?: unknown };
        if (!Array.isArray(o.rows)) throw new DataSetError("Expected a list of rows: either [{...}, {...}] or an object with a \"rows\" list (and optionally \"columns\").");
        list = o.rows;
        if (o.columns !== undefined) {
            if (!Array.isArray(o.columns) || o.columns.some((c) => typeof c !== "string")) throw new DataSetError("\"columns\" must be a list of column names.");
            columns = o.columns as string[];
        }
    }
    if (!Array.isArray(list)) throw new DataSetError("Expected a list of rows: either [{...}, {...}] or an object with a \"rows\" list.");
    const rows: Array<Record<string, string>> = [];
    const order = new Set<string>(columns ?? []);
    list.forEach((item, i) => {
        if (Array.isArray(item)) {
            if (!columns) throw new DataSetError(`Row ${i + 1} is a list, so the file needs a "columns" list that names its values.`);
            if (item.length > columns.length) throw new DataSetError(`Row ${i + 1} has ${item.length} values but there are ${columns.length} columns.`);
            rows.push(Object.fromEntries(columns.map((c, k) => [c, asText(item[k], `Row ${i + 1}, column ${c}`)])));
            return;
        }
        if (!item || typeof item !== "object") throw new DataSetError(`Row ${i + 1} is not an object like {"name": "value"}.`);
        const rec: Record<string, string> = {};
        for (const [k, v] of Object.entries(item)) {
            order.add(k);
            rec[k] = asText(v, `Row ${i + 1}, column ${k}`);
        }
        rows.push(rec);
    });
    const cols = [...order];
    // Objects may omit a key in some rows: that is an empty value.
    return { columns: cols, rows: rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? ""]))) };
}

/** Turn an imported file's text into a checked table. Throws DataSetError with a sentence a person can act on. */
export function parseDataSet(text: string, format: DataFormat): DataSet {
    let set: DataSet;
    if (format === "csv") {
        const table = parseCsv(text);
        if (table.length === 0) throw new DataSetError("The file is empty.");
        const columns = table[0]!.map((c) => c.trim());
        const rows: Array<Record<string, string>> = [];
        for (const [i, r] of table.slice(1).entries()) {
            if (r.length > columns.length) throw new DataSetError(`Row ${i + 1} has ${r.length} values but the header names ${columns.length} columns.`);
            rows.push(Object.fromEntries(columns.map((c, k) => [c, r[k] ?? ""])));
        }
        set = { columns, rows };
    } else if (format === "json") {
        let data: unknown;
        try {
            data = JSON.parse(text);
        } catch {
            throw new DataSetError("The file is not valid JSON.");
        }
        set = fromStructured(data);
    } else {
        let data: unknown;
        try {
            // Aliases are the way a small YAML file expands into a huge one: not allowed here.
            data = YAML.parse(text, { maxAliasCount: 0 });
        } catch (e) {
            throw new DataSetError(`The file is not valid YAML${e instanceof Error ? `: ${e.message.split("\n")[0]}` : "."}`);
        }
        set = fromStructured(data);
    }
    return checkDataSet(set);
}

/** The rules every data set follows, wherever it came from. */
export function checkDataSet(set: DataSet): DataSet {
    if (set.columns.length === 0) throw new DataSetError("The data set has no columns.");
    if (set.columns.length > MAX_DATA_COLUMNS) throw new DataSetError(`The data set has ${set.columns.length} columns; at most ${MAX_DATA_COLUMNS} are allowed.`);
    const seen = new Set<string>();
    for (const c of set.columns) {
        if (!COLUMN_NAME.test(c)) throw new DataSetError(`The column name “${c}” is not allowed: use letters, digits and _, starting with a letter or _ (at most 40 characters), so steps can refer to it as {{${c.replace(/[^\w]/g, "_") || "name"}}}.`);
        if (RESERVED_COLUMNS.has(c)) throw new DataSetError(`The column name “${c}” already has a meaning in a test; choose another name.`);
        if (seen.has(c)) throw new DataSetError(`The column “${c}” appears more than once.`);
        seen.add(c);
    }
    if (set.rows.length === 0) throw new DataSetError("The data set has no rows (only a header). Add at least one row.");
    if (set.rows.length > MAX_DATA_ROWS) throw new DataSetError(`The data set has ${set.rows.length} rows; at most ${MAX_DATA_ROWS} are allowed.`);
    set.rows.forEach((r, i) => {
        for (const c of set.columns) {
            const v = r[c];
            if (typeof v !== "string") throw new DataSetError(`Row ${i + 1} has no value for “${c}”.`);
            if (v.length > MAX_VALUE_LENGTH) throw new DataSetError(`Row ${i + 1}, column “${c}” is ${v.length} characters long; at most ${MAX_VALUE_LENGTH} are allowed.`);
        }
    });
    return set;
}

/** Rows a spec's tests are rendered for, and whether some were left out. Throws when the spec names a set that is not there. */
export function resolveRows(setName: string, dataSets: Record<string, DataSet> | undefined): { rows: Array<Record<string, string>>; total: number; truncated: boolean; columns: string[] } {
    const set = dataSets?.[setName];
    if (!set) throw new DataSetError(`The test uses the data set “${setName}”, but this project has no data set with that name.`);
    return { rows: set.rows.slice(0, MAX_ROWS_PER_SPEC), total: set.rows.length, truncated: set.rows.length > MAX_ROWS_PER_SPEC, columns: set.columns };
}

/** The data set a spec names, if any. */
export const dataSetNameOf = (testData: Record<string, string> | undefined): string | undefined => {
    const v = testData?.[DATA_SET_KEY];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

export const truncationNote = (name: string, total: number): string =>
    `The data set “${name}” has ${total} rows; only the first ${MAX_ROWS_PER_SPEC} are tested (the most one test renders). Split the data into smaller sets to cover the rest.`;

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

function stringsOf(value: unknown, out: string[] = []): string[] {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) value.forEach((v) => stringsOf(v, out));
    else if (value && typeof value === "object") Object.values(value).forEach((v) => stringsOf(v, out));
    return out;
}

/**
 * Placeholders a data-driven spec uses that nothing provides: not a column, not a testData value, not captured by an earlier
 * request step, and not one of the built-ins ({{unique}}, {{credentials...}}, {{env...}}). Returned in first-use order.
 */
export function unknownPlaceholders(spec: { steps: unknown[]; testData: Record<string, string> }, columns: string[]): string[] {
    const known = new Set<string>([...columns, ...Object.keys(spec.testData).filter((k) => k !== DATA_SET_KEY), "unique"]);
    for (const s of spec.steps as Array<{ extract?: Record<string, string> }>) for (const k of Object.keys(s.extract ?? {})) known.add(k);
    const unknown: string[] = [];
    for (const text of stringsOf(spec.steps)) {
        for (const m of text.matchAll(PLACEHOLDER)) {
            const name = m[1]!;
            if (known.has(name) || name.startsWith("credentials.") || name.startsWith("env.")) continue;
            if (!unknown.includes(name)) unknown.push(name);
        }
    }
    return unknown;
}
