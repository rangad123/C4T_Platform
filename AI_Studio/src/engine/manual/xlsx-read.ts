/**
 * Reads one sheet of an Excel workbook (.xlsx) as plain text rows, without a spreadsheet library (fflate does the inflating).
 *
 * It reads the test case workbook the platform writes (inline strings) and the same file after a person saved it again in Excel or
 * LibreOffice: shared strings (plain and rich text), styles, other sheets, empty cells, cell and row references with gaps, missing
 * references, line breaks inside a cell (also Excel's `_x000D_` escape), numbers, booleans and formulas. A formula is never evaluated: the
 * cell reads as the value the spreadsheet saved with it, or empty when there is none. Formula text itself is never returned.
 *
 * The file is untrusted, so everything is bounded before any cell text is read:
 * - the file itself at most 10 MB, at most 20 parts inside the zip, at most 10 MB unpacked (counted while inflating, so a part that lies
 *   about its size is stopped too), no encrypted parts, only stored or deflated parts;
 * - no DOCTYPE in any XML part, so no entity can expand (this reader also never resolves any entity but the five XML ones and numeric
 *   character references);
 * - at most `maxRows` rows below the header (default 5 000, lead decision 2026-11-20: every workbook the export can produce imports) and
 *   100 columns with text.
 * A refusal is an `XlsxReadError` whose message is one sentence a person can act on.
 */
import { Inflate, strFromU8 } from "fflate";

export class XlsxReadError extends Error {}

/** Largest file accepted, and largest total of its unpacked parts. */
export const XLSX_MAX_BYTES = 10 * 1024 * 1024;
export const XLSX_MAX_UNPACKED = 10 * 1024 * 1024;
/** Most parts (zip entries) a workbook may have. The platform's workbook has 9; Excel and LibreOffice add a few. */
export const XLSX_MAX_PARTS = 20;
/** Most rows below the header, by default. */
export const XLSX_MAX_ROWS = 5_000;
/** Columns with text beyond this one are refused. */
export const XLSX_MAX_COLUMNS = 100;

export interface ReadSheetOptions {
    /** Most rows below the first (header) row; trailing empty rows do not count. Default `XLSX_MAX_ROWS`. */
    maxRows?: number;
}

// ── the zip ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const damaged = (why: string) => new XlsxReadError(`The workbook is damaged and cannot be read (${why}). Save it again in Excel or LibreOffice and import it again.`);
const TOO_BIG_UNPACKED = () =>
    new XlsxReadError(`The workbook unpacks to more than ${XLSX_MAX_UNPACKED / 1024 / 1024} MB, far more than ${XLSX_MAX_ROWS.toLocaleString("en-US")} test cases need. Import a smaller workbook.`);

interface Entry {
    name: string;
    method: number;
    flags: number;
    compSize: number;
    size: number;
    localOffset: number;
}

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

function startsWith(b: Uint8Array, sig: number[]): boolean {
    return sig.every((x, i) => b[i] === x);
}

/** The zip's central directory, checked against the part limit before anything is inflated. */
function listEntries(b: Uint8Array): Entry[] {
    // End of central directory: 22 bytes plus a comment of at most 65 535 bytes, at the end of the file.
    let e = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65_535); i--) {
        if (u32(b, i) === 0x06054b50) {
            e = i;
            break;
        }
    }
    if (e < 0) throw damaged("the end of the zip is missing");
    const count = u16(b, e + 10);
    const cdSize = u32(b, e + 12);
    const cdOffset = u32(b, e + 16);
    if (count === 0xffff || cdOffset === 0xffffffff) throw damaged("it uses the large-file zip format, which a workbook of this size never needs");
    if (count > XLSX_MAX_PARTS)
        throw new XlsxReadError(`The workbook holds more than ${XLSX_MAX_PARTS} parts (pictures, extra sheets or other content). Copy the test case sheets into a new workbook and import that.`);
    if (cdOffset + cdSize > e) throw damaged("the zip directory is out of place");
    const entries: Entry[] = [];
    const names = new Set<string>();
    let o = cdOffset;
    for (let i = 0; i < count; i++) {
        if (o + 46 > e || u32(b, o) !== 0x02014b50) throw damaged("the zip directory is cut short");
        const nameLen = u16(b, o + 28);
        const end = o + 46 + nameLen + u16(b, o + 30) + u16(b, o + 32);
        if (end > e) throw damaged("the zip directory is cut short");
        const entry: Entry = {
            flags: u16(b, o + 8),
            method: u16(b, o + 10),
            compSize: u32(b, o + 20),
            size: u32(b, o + 24),
            localOffset: u32(b, o + 42),
            name: strFromU8(b.subarray(o + 46, o + 46 + nameLen)),
        };
        if (names.has(entry.name.toLowerCase())) throw damaged("a part appears twice");
        names.add(entry.name.toLowerCase());
        entries.push(entry);
        o = end;
    }
    return entries;
}

/** One part's bytes, inflated in small steps so that no part can grow past what is left of the unpacked budget. */
function inflateEntry(b: Uint8Array, en: Entry, budget: { left: number }): Uint8Array {
    if (en.flags & 1) throw new XlsxReadError("The workbook is protected with a password. Save it without a password and import it again.");
    const lo = en.localOffset;
    if (lo + 30 > b.length || u32(b, lo) !== 0x04034b50) throw damaged("a part is missing");
    const start = lo + 30 + u16(b, lo + 26) + u16(b, lo + 28);
    const data = b.subarray(start, start + en.compSize);
    if (start + en.compSize > b.length) throw damaged("a part is cut short");
    if (en.method === 0) {
        if (data.length > budget.left) throw TOO_BIG_UNPACKED();
        budget.left -= data.length;
        return data;
    }
    if (en.method !== 8) throw damaged("a part uses an unknown compression");
    const chunks: Uint8Array[] = [];
    let total = 0;
    const inf = new Inflate((chunk) => {
        total += chunk.length;
        if (total > budget.left) throw TOO_BIG_UNPACKED();
        chunks.push(chunk);
    });
    // 4 KB of deflated input can grow to about 4 MB at most, so the budget is checked often enough.
    const STEP = 4096;
    try {
        if (!data.length) inf.push(data, true);
        for (let i = 0; i < data.length; i += STEP) inf.push(data.subarray(i, i + STEP), i + STEP >= data.length);
    } catch (err) {
        if (err instanceof XlsxReadError) throw err;
        throw damaged("a part cannot be unpacked");
    }
    budget.left -= total;
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) {
        out.set(c, p);
        p += c.length;
    }
    return out;
}

/** The workbook's XML parts as text, after every limit and the DOCTYPE check. Binary parts (pictures, printer settings) are not unpacked. */
function readParts(bytes: Uint8Array): Map<string, string> {
    if (bytes.length > XLSX_MAX_BYTES) throw new XlsxReadError(`The file is larger than ${XLSX_MAX_BYTES / 1024 / 1024} MB. Import a smaller workbook.`);
    if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
        throw new XlsxReadError("This is an old Excel file (.xls) or a workbook protected with a password. Save it as “Excel Workbook (.xlsx)” without a password and import it again.");
    if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) && !startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]))
        throw new XlsxReadError("This file is not an Excel workbook (.xlsx). Import the test case workbook downloaded from a Test Case Generation project, or a copy of it saved as “Excel Workbook (.xlsx)”.");
    const entries = listEntries(bytes);
    const declared = entries.reduce((n, en) => n + en.size, 0);
    if (declared > XLSX_MAX_UNPACKED) throw TOO_BIG_UNPACKED();
    const budget = { left: XLSX_MAX_UNPACKED };
    const parts = new Map<string, string>();
    for (const en of entries) {
        if (en.name.endsWith("/")) continue;
        if (en.name === "mimetype") {
            const t = strFromU8(inflateEntry(bytes, en, budget));
            if (t.includes("opendocument"))
                throw new XlsxReadError("This is an OpenDocument spreadsheet (.ods). Save it as “Excel Workbook (.xlsx)” and import it again.");
            continue;
        }
        if (!/\.(xml|rels)$/i.test(en.name)) continue;
        const text = strFromU8(inflateEntry(bytes, en, budget));
        // No DTD in any part: entity expansion ("billion laughs") and external entities need one.
        if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text))
            throw new XlsxReadError("The workbook contains a document type declaration (DOCTYPE), which Excel and LibreOffice never write. It was refused for safety.");
        parts.set(en.name.replace(/^\/+/, ""), text);
    }
    return parts;
}

// ── a small XML reader ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Tag {
    /** Local name, without a namespace prefix ("x:c" and "c" are both "c"). */
    name: string;
    close: boolean;
    selfClose: boolean;
    attrs: Record<string, string>;
    /** Text between the previous tag and this one (already decoded). */
    textBefore: string;
}

const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** The five XML entities and numeric references; anything else stays as written (there is no DTD to define more). */
function decodeXml(s: string): string {
    if (!s.includes("&")) return s;
    return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, ref: string) => {
        if (ref[0] !== "#") return NAMED[ref] ?? m;
        const cp = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
        return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "";
    });
}

const localName = (n: string) => n.slice(n.indexOf(":") + 1);

/** Tags in document order. Comments, processing instructions and CDATA are handled; CDATA becomes text. */
function* tags(xml: string): Generator<Tag> {
    const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
    let last = 0;
    let text = "";
    for (let m = re.exec(xml); m; m = re.exec(xml)) {
        text += decodeXml(xml.slice(last, m.index));
        last = re.lastIndex;
        if (m[1] !== undefined) {
            text += m[1];
            continue;
        }
        if (!m[3]) continue; // comment or processing instruction
        const attrs: Record<string, string> = {};
        if (m[4]) for (const a of m[4].matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]!] = decodeXml(a[2] ?? a[3] ?? "");
        yield { name: localName(m[3]), close: m[2] === "/", selfClose: m[5] === "/", attrs, textBefore: text };
        text = "";
    }
}

const attr = (t: Tag, name: string) => t.attrs[name] ?? Object.entries(t.attrs).find(([k]) => localName(k) === name)?.[1];

/** Excel writes characters XML cannot carry (and a carriage return) as `_xHHHH_`; `_x005F_` escapes an underscore. Line ends become "\n". */
function cellString(s: string): string {
    return s.replace(/_x([0-9a-fA-F]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/\r\n?/g, "\n");
}

/** Text of a string item (<si> or <is>): plain <t>, or the <t> of each rich-text run; phonetic guides (<rPh>) are left out. */
function collectStrings(xml: string, item: "si"): string[] {
    const out: string[] = [];
    let cur: string | null = null;
    let inT = false;
    let skip = 0;
    for (const t of tags(xml)) {
        if (inT && cur !== null && !skip) cur += t.textBefore;
        if (t.name === item && !t.close) {
            if (t.selfClose) out.push("");
            else cur = "";
        } else if (t.name === item && t.close) {
            if (cur !== null) out.push(cellString(cur));
            cur = null;
        } else if (t.name === "rPh" && !t.selfClose) skip += t.close ? -1 : 1;
        else if (t.name === "t" && !t.selfClose) inT = !t.close;
    }
    return out;
}

// ── the workbook ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A relationship target, relative to the part that owns it (or absolute from the package root). */
function resolve(from: string, target: string): string {
    const base = target.startsWith("/") ? [] : from.split("/").slice(0, -1);
    for (const seg of target.replace(/^\/+/, "").split("/")) {
        if (seg === "..") base.pop();
        else if (seg && seg !== ".") base.push(seg);
    }
    return base.join("/");
}

function relsOf(parts: Map<string, string>, part: string): Array<{ id: string; type: string; target: string }> {
    const dir = part.split("/").slice(0, -1).join("/");
    const file = part.split("/").pop()!;
    const xml = parts.get(`${dir ? dir + "/" : ""}_rels/${file}.rels`);
    if (!xml) return [];
    const out: Array<{ id: string; type: string; target: string }> = [];
    for (const t of tags(xml)) {
        if (t.name !== "Relationship" || t.close) continue;
        if (attr(t, "TargetMode") === "External") continue;
        out.push({ id: attr(t, "Id") ?? "", type: attr(t, "Type") ?? "", target: resolve(part, attr(t, "Target") ?? "") });
    }
    return out;
}

/** Part names in a zip are matched without regard to case, as Office does. */
function getPart(parts: Map<string, string>, name: string): string | undefined {
    if (parts.has(name)) return parts.get(name);
    const lower = name.toLowerCase();
    for (const [k, v] of parts) if (k.toLowerCase() === lower) return v;
    return undefined;
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** "A" → 0, "AA" → 26. */
function columnIndex(letters: string): number {
    let n = 0;
    for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}

/**
 * The rows of the sheet called `name` (matched without regard to case or extra spaces), each a list of cell texts. Row i of the result
 * is the sheet's row i + 1; empty rows inside the sheet are empty lists, trailing empty rows are dropped, and each row ends at its last
 * cell with text. Other sheets are not read.
 */
export function readSheet(bytes: Uint8Array, name: string, opts: ReadSheetOptions = {}): string[][] {
    const maxRows = opts.maxRows ?? XLSX_MAX_ROWS;
    const parts = readParts(bytes);
    const root = relsOf(parts, "").find((r) => r.type.endsWith("/officeDocument"));
    const wbPath = root?.target ?? "xl/workbook.xml";
    const wbXml = getPart(parts, wbPath);
    if (!wbXml) throw new XlsxReadError("This file is not an Excel workbook (.xlsx): it has no list of sheets. Import the test case workbook, or a copy of it saved as “Excel Workbook (.xlsx)”.");

    const sheets: Array<{ name: string; rid: string }> = [];
    for (const t of tags(wbXml)) if (t.name === "sheet" && !t.close) sheets.push({ name: attr(t, "name") ?? "", rid: attr(t, "id") ?? "" });
    const sheet = sheets.find((s) => s.name === name) ?? sheets.find((s) => norm(s.name) === norm(name));
    if (!sheet) {
        const list = sheets.slice(0, 10).map((s) => `“${s.name.slice(0, 31)}”`).join(", ");
        throw new XlsxReadError(`The workbook has no sheet named “${name}”.${list ? ` Its sheets are ${list}${sheets.length > 10 ? " and more" : ""}.` : ""} Import the test case workbook, whose first sheet is “${name}”.`);
    }
    const wbRels = relsOf(parts, wbPath);
    const target = wbRels.find((r) => r.id === sheet.rid)?.target;
    const sheetXml = target ? getPart(parts, target) : undefined;
    if (!sheetXml) throw damaged(`the sheet “${sheet.name.slice(0, 31)}” is missing`);
    const ssPath = wbRels.find((r) => r.type.endsWith("/sharedStrings"))?.target ?? "xl/sharedStrings.xml";
    const ssXml = getPart(parts, ssPath);
    const shared = ssXml ? collectStrings(ssXml, "si") : [];

    const rows: string[][] = [];
    const label = sheet.name.slice(0, 31);
    let rowIdx = -1;
    let colIdx = -1;
    let cell: { type: string; v: string | null; is: string | null } | null = null;
    let inV = false;
    let inIs = false;
    let inT = false;
    let skip = 0;
    const put = (r: number, c: number, text: string) => {
        if (!text) return;
        if (r > maxRows) throw new XlsxReadError(`The “${label}” sheet has more than ${maxRows.toLocaleString("en-US")} rows below its header. Import at most ${maxRows.toLocaleString("en-US")} at a time.`);
        if (c >= XLSX_MAX_COLUMNS) throw new XlsxReadError(`The “${label}” sheet has text beyond column ${XLSX_MAX_COLUMNS}. Remove it and import again.`);
        while (rows.length <= r) rows.push([]);
        const row = rows[r]!;
        while (row.length < c) row.push("");
        row[c] = text;
    };
    for (const t of tags(sheetXml)) {
        if (cell) {
            if (inV) cell.v = (cell.v ?? "") + t.textBefore;
            if (inIs && inT && !skip) cell.is = (cell.is ?? "") + t.textBefore;
        }
        switch (t.name) {
            case "row":
                if (t.close) break;
                {
                    const r = Number(attr(t, "r"));
                    rowIdx = Number.isInteger(r) && r - 1 > rowIdx ? r - 1 : rowIdx + 1;
                    colIdx = -1;
                }
                break;
            case "c": {
                if (t.close) {
                    if (cell) put(rowIdx, colIdx, cellValue(cell, shared));
                    cell = null;
                    break;
                }
                if (rowIdx < 0) rowIdx = 0;
                const ref = /^([A-Za-z]{1,3})(\d+)$/.exec(attr(t, "r") ?? "");
                colIdx = ref ? columnIndex(ref[1]!) : colIdx + 1;
                if (ref && Number(ref[2]) - 1 > rowIdx) rowIdx = Number(ref[2]) - 1;
                cell = t.selfClose ? null : { type: attr(t, "t") ?? "n", v: null, is: null };
                break;
            }
            case "v":
                if (!t.selfClose) inV = !t.close;
                break;
            case "is":
                if (!t.selfClose) inIs = !t.close;
                break;
            case "rPh":
                if (!t.selfClose) skip += t.close ? -1 : 1;
                break;
            case "t":
                if (!t.selfClose) inT = !t.close;
                break;
        }
    }
    // Trailing rows and cells without text are not part of the result.
    while (rows.length && !rows[rows.length - 1]!.length) rows.pop();
    return rows;
}

/** A cell's text. A formula (<f>) is never read: only the value saved with it, which is what a person last saw in the cell. */
function cellValue(c: { type: string; v: string | null; is: string | null }, shared: string[]): string {
    switch (c.type) {
        case "s": {
            if (c.v === null) return "";
            const i = Number(c.v.trim());
            if (!Number.isInteger(i) || i < 0 || i >= shared.length) throw damaged("a cell points to text that is not there");
            return shared[i]!;
        }
        case "inlineStr":
            // Some writers put an inline string in <v>.
            return cellString(c.is ?? c.v ?? "");
        case "b":
            return c.v === null ? "" : c.v.trim() === "1" ? "TRUE" : "FALSE";
        case "str":
        case "e":
        case "d":
            return cellString(c.v ?? "");
        default: {
            const raw = (c.v ?? "").trim();
            const n = Number(raw);
            // 0.1 saved as 0.10000000000000001 reads as 0.1, as the spreadsheet shows it.
            return raw && Number.isFinite(n) ? String(n) : raw;
        }
    }
}

// ── a sheet with a header row ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TableRow {
    /** The row's number in the sheet (the header is usually row 1). */
    row: number;
    /** Each known column's text, keyed by the column name as given in `columns` (empty when the cell is empty). */
    values: Record<string, string>;
}

/**
 * The sheet as records: its first row with text is the header, matched to `columns` without regard to case, extra spaces or order;
 * unknown columns are ignored and a missing optional column reads as empty. Rows with no text in a known column are left out.
 */
export function readTable(bytes: Uint8Array, sheet: string, spec: { columns: readonly string[]; required: readonly string[]; maxRows?: number }): TableRow[] {
    const rows = readSheet(bytes, sheet, { maxRows: spec.maxRows });
    const headerAt = rows.findIndex((r) => r.some((c) => c.trim()));
    const expected = spec.columns.join(", ");
    if (headerAt < 0) throw new XlsxReadError(`The “${sheet}” sheet is empty. Its first row must be the header: ${expected}.`);
    const header = rows[headerAt]!.map(norm);
    const at = new Map<string, number>();
    for (const col of spec.columns) {
        const hits = header.flatMap((h, i) => (h === norm(col) ? [i] : []));
        if (hits.length > 1) throw new XlsxReadError(`The “${sheet}” sheet has the column “${col}” more than once. Keep one and import again.`);
        if (hits.length) at.set(col, hits[0]!);
    }
    for (const col of spec.required) if (!at.has(col)) throw new XlsxReadError(`The “${sheet}” sheet has no “${col}” column. Its first row must be the header: ${expected}.`);
    const out: TableRow[] = [];
    rows.slice(headerAt + 1).forEach((r, i) => {
        const values: Record<string, string> = {};
        let any = false;
        for (const col of spec.columns) {
            const idx = at.get(col);
            values[col] = idx === undefined ? "" : (r[idx] ?? "");
            if (values[col]!.trim()) any = true;
        }
        if (any) out.push({ row: headerAt + i + 2, values });
    });
    return out;
}
