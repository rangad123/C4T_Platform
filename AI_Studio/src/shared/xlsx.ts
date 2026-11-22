/**
 * An Excel workbook (.xlsx) from plain rows, written without a spreadsheet library. Shared by the security report export
 * (src/security/findings/xlsx.ts) and the platform's test case workbook (src/platform/case-workbook.ts); moved here from
 * src/security/findings/xlsx.ts so the platform does not import the security module. The writer is unchanged.
 *
 * An .xlsx file is a zip of a few XML parts (Office Open XML, ECMA-376): the package's content types and relationships, a workbook that
 * lists its sheets, one XML file per sheet and a style sheet. The zip is made with fflate, the same zip code the runner kit uses
 * (src/platform/runner-kit.ts), so this needs no new dependency.
 *
 * Safety: every cell is an inline string (or a plain number), never a formula: a value that starts with = + - @ is shown as typed and a
 * spreadsheet cannot run it. Text is XML-escaped, characters XML cannot carry are removed, Excel's own `_xHHHH_` escape is escaped, and a
 * cell longer than Excel's limit is cut with a note.
 */
import { zipSync, type Zippable } from "fflate";

export const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Excel keeps at most 32 767 characters in a cell. */
export const XLSX_CELL_MAX = 32_767;
const CUT_NOTE = " … (cut here: the full text is in the HTML or PDF report)";

export type XlsxCell = string | number | null | undefined;
export interface XlsxSheet {
    name: string;
    rows: XlsxCell[][];
    /** The first row is a header: bold, frozen while scrolling, with filter buttons. */
    header?: boolean;
    /** Column widths in characters (Excel's unit). */
    widths?: number[];
    /** Cells that wrap their text (long descriptions); the default keeps one line per cell. */
    wrap?: boolean;
}

/** Characters XML 1.0 cannot carry (C0 controls except tab/LF/CR, the two non-characters, lone surrogates) are dropped. */
function xmlSafe(s: string): string {
    return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "");
}
const esc = (s: string) => xmlSafe(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** "A", "B", … "Z", "AA", … for a 0-based column. */
export function columnName(i: number): string {
    let n = i + 1;
    let s = "";
    while (n > 0) {
        const r = (n - 1) % 26;
        s = String.fromCharCode(65 + r) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

/** A sheet name Excel accepts: at most 31 characters, none of : \ / ? * [ ], not starting or ending with an apostrophe. */
export function sheetName(name: string): string {
    const s = name.replace(/[:\\/?*[\]]/g, " ").replace(/^'+|'+$/g, "").trim().slice(0, 31);
    return s || "Sheet";
}

/**
 * Excel reads `_xHHHH_` in cell text as the character HHHH (its escape for what XML cannot carry), so a literal one is written with its
 * underscore escaped (`_x005F_xHHHH_`): Excel, LibreOffice and the import (engine/manual/xlsx-read.ts) then read the exact text back. The
 * lookahead leaves the closing underscore in place, so in `_x0041_x0042_` both are escaped.
 */
const escapeExcelEscapes = (s: string): string => s.replace(/_(?=x[0-9a-fA-F]{4}_)/g, "_x005F_");

function cellText(v: string): string {
    const s = escapeExcelEscapes(xmlSafe(v));
    return s.length > XLSX_CELL_MAX ? s.slice(0, XLSX_CELL_MAX - CUT_NOTE.length) + CUT_NOTE : s;
}

/** Style ids in styles.xml: 0 plain, 1 bold header, 2 wrapped text aligned to the top, 3 bold title. */
const STYLE = { plain: 0, header: 1, wrap: 2, title: 3 } as const;

function cellXml(ref: string, v: XlsxCell, style: number): string {
    const s = style ? ` s="${style}"` : "";
    if (v === null || v === undefined || v === "") return style ? `<c r="${ref}"${s}/>` : "";
    if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
    // An inline string is text by type: Excel never reads it as a formula, whatever it starts with.
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(cellText(String(v)))}</t></is></c>`;
}

function sheetXml(sheet: XlsxSheet): string {
    const cols = Math.max(1, ...sheet.rows.map((r) => r.length));
    const last = `${columnName(cols - 1)}${Math.max(1, sheet.rows.length)}`;
    const rows = sheet.rows
        .map((r, ri) => {
            const style = sheet.header && ri === 0 ? STYLE.header : sheet.wrap ? STYLE.wrap : STYLE.plain;
            const cells = r.map((v, ci) => cellXml(`${columnName(ci)}${ri + 1}`, v, style)).join("");
            return `<row r="${ri + 1}">${cells}</row>`;
        })
        .join("");
    const view = sheet.header
        ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>`
        : `<sheetViews><sheetView workbookViewId="0"/></sheetViews>`;
    const widths = sheet.widths?.length ? `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(4, Math.min(120, w))}" customWidth="1"/>`).join("")}</cols>` : "";
    const filter = sheet.header && sheet.rows.length > 1 ? `<autoFilter ref="A1:${last}"/>` : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:${last}"/>${view}<sheetFormatPr defaultRowHeight="15"/>${widths}<sheetData>${rows}</sheetData>${filter}<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="14"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/**
 * A workbook from plain rows. Returns the .xlsx bytes. `title` goes into the file's properties; `boldRows` (per sheet index) marks
 * extra rows to show in bold (section headings on a summary sheet), `titleRow` the sheet's first row as a title.
 */
export function buildXlsx(sheets: XlsxSheet[], opts: { title?: string; created?: Date; boldRows?: Record<number, number[]>; titleRow?: number[] } = {}): Uint8Array {
    if (!sheets.length) throw new Error("A workbook needs at least one sheet");
    const names: string[] = [];
    for (const s of sheets) {
        let n = sheetName(s.name);
        // Sheet names are unique without regard to case.
        for (let i = 2; names.some((x) => x.toLowerCase() === n.toLowerCase()); i++) n = `${sheetName(s.name).slice(0, 28)} ${i}`;
        names.push(n);
    }
    const enc = (s: string) => new TextEncoder().encode(s);
    const files: Zippable = {};
    const add = (name: string, xml: string) => {
        files[name] = [enc(xml), { level: 6 }];
    };
    add(
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    );
    add(
        "_rels/.rels",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    );
    const created = (opts.created ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
    add(
        "docProps/core.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc((opts.title ?? "").slice(0, 250))}</dc:title><dc:creator>AI Testing Platform</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created></cp:coreProperties>`,
    );
    // The filter range of a sheet with a header row is a defined name, as Excel itself writes it.
    const filters = sheets
        .map((s, i) => {
            if (!s.header || s.rows.length < 2) return "";
            const cols = Math.max(1, ...s.rows.map((r) => r.length));
            return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(names[i]!.replace(/'/g, "''"))}'!$A$1:$${columnName(cols - 1)}$${s.rows.length}</definedName>`;
        })
        .join("");
    add(
        "xl/workbook.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>${filters ? `<definedNames>${filters}</definedNames>` : ""}</workbook>`,
    );
    add(
        "xl/_rels/workbook.xml.rels",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    );
    add("xl/styles.xml", STYLES_XML);
    sheets.forEach((s, i) => {
        let xml = sheetXml(s);
        // Section headings and the title row of a summary sheet: the same cells, a bold style.
        for (const r of opts.boldRows?.[i] ?? []) xml = xml.replace(new RegExp(`(<c r="[A-Z]+${r + 1}")( t=|>|/>)`, "g"), `$1 s="${STYLE.header}"$2`);
        if (opts.titleRow?.includes(i)) xml = xml.replace(/(<c r="A1")( t=)/, `$1 s="${STYLE.title}"$2`);
        add(`xl/worksheets/sheet${i + 1}.xml`, xml);
    });
    return zipSync(files);
}
