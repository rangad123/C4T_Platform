/**
 * Security reports as an Excel workbook (.xlsx), written without a spreadsheet library.
 *
 * An .xlsx file is a zip of a few XML parts (Office Open XML, ECMA-376): the package's content types and relationships, a workbook that
 * lists its sheets, one XML file per sheet and a style sheet. The zip is made with fflate, the same zip code the runner kit uses
 * (src/platform/runner-kit.ts), so this needs no new dependency.
 *
 * Two sheets: "Summary" (what the report is about, the risk level with its rules, counts by severity and category, the applications and
 * their authorization, coverage and limitations) and "Findings" (one row per finding with exactly the CSV's columns and values).
 *
 * Safety: every cell is an inline string (or a plain number on the Summary), never a formula: a value that starts with = + - @ is shown
 * as typed and a spreadsheet cannot run it. Text is XML-escaped, characters XML cannot carry are removed, and a cell longer than Excel's
 * limit is cut with a note. The content is the report's (already redacted at ingest; free text from records is redacted again here, as
 * the HTML report does); the approver's e-mail address is never written.
 */
import { zipSync, type Zippable } from "fflate";
import type { FindingCategory, Severity } from "../contract.js";
import { SEVERITIES } from "../contract.js";
import { CATEGORY_WORDS, CSV_COLUMNS, REPORT_MAX_FINDINGS, reportTitle, STATE_WORDS, VALIDATION_WORDS, type SecurityReportData } from "./report.js";
import { redactText } from "./redact.js";
import { signInLabel } from "../authorization.js";

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

// ── the generic writer ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

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

function cellText(v: string): string {
    const s = xmlSafe(v);
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

// ── the security report as a workbook ────────────────────────────────────────────────────────────────────────────────────────────────

const day = (iso: string | null | undefined) => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "");
const clean = (s: string | null | undefined) => (s ? redactText(s, 2000) : "");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One row per finding, the CSV's columns in the CSV's order (src/security/findings/report.ts `renderReportCsv`). */
export function findingRows(d: SecurityReportData): string[][] {
    return d.findings.map((f) => [
        f.id,
        f.applicationName,
        f.title,
        f.severity,
        CATEGORY_WORDS[f.category],
        f.confidence,
        VALIDATION_WORDS[f.validation],
        f.location,
        f.source,
        f.firstSeenAt,
        f.lastSeenAt,
        f.description,
        f.impact,
        f.remediation,
        f.reproduction ?? "",
        f.evidence.map((e) => `${e.label}: ${e.value}`).join("\n"),
    ]);
}

/** The Summary sheet's rows, and which of them are section headings (shown in bold). */
export function summaryRows(d: SecurityReportData): { rows: XlsxCell[][]; headings: number[] } {
    const rows: XlsxCell[][] = [];
    const headings: number[] = [];
    const heading = (...cells: XlsxCell[]) => {
        if (rows.length) rows.push([]);
        headings.push(rows.length);
        rows.push(cells);
    };
    const open = d.findings.filter((f) => ["confirmed", "probable", "needs-review"].includes(f.validation));
    rows.push([reportTitle(d)]);
    rows.push(["Project", d.projectName]);
    rows.push(["Report on", d.kind === "assessment" ? `One assessment${d.assessments[0] ? ` (${d.assessments[0].id})` : ""}` : "The whole project, every application"]);
    rows.push(["Generated", day(d.generatedAt)]);
    rows.push(["Findings in this report", d.findings.length]);
    if (d.truncated) rows.push(["Note", `More findings exist than one report lists: the ${REPORT_MAX_FINDINGS} most serious are included.`]);

    heading("Risk overview");
    rows.push(["Level", d.risk.label]);
    rows.push(["Why", d.risk.reason]);
    rows.push(["Open findings", open.length]);
    rows.push(["Open critical or high", d.risk.openBySeverity.critical + d.risk.openBySeverity.high]);
    rows.push(["Awaiting review", open.filter((f) => f.validation !== "confirmed").length]);
    rows.push(["Fixed", d.findings.filter((f) => f.validation === "fixed").length]);
    d.risk.rules.forEach((r, i) => rows.push([i === 0 ? "How the level is decided" : "", r]));

    heading("Severity", "Open", "In this report");
    for (const s of SEVERITIES as readonly Severity[]) rows.push([cap(s), d.risk.openBySeverity[s], d.bySeverity[s]]);

    if (d.byCategory.length) {
        heading("Category", "Open", "In this report");
        for (const c of d.byCategory) rows.push([CATEGORY_WORDS[c.category as FindingCategory] ?? c.label, c.open, c.total]);
    }

    heading("Application", "Target", "Environment", "Requests per second", "Authorization", "Assessment", "State", "Started", "Finished");
    for (const { app, authorization: au, authorizationNote } of d.applications) {
        const a = d.assessments.find((x) => x.applicationId === app.id);
        const auth = au
            ? `Authorized by ${au.approverName} (${au.basis === "owner" ? "owner of the application" : "documented permission of the owner"}), recorded by ${au.confirmedByName} on ${day(au.confirmedAt)}${au.documentReference ? `. Reference: ${clean(au.documentReference)}` : ""}${au.restrictions ? `. Restrictions: ${clean(au.restrictions)}` : ""}${au.revokedAt ? `. Revoked on ${day(au.revokedAt)}` : ""}. ${authorizationNote}`
            : `No authorization is recorded. ${authorizationNote}`;
        rows.push([app.name, app.targetUrl, app.environment, app.maxRequestsPerSecond, auth.trim(), a ? `${a.id}${a.retestOf ? " (retest)" : ""}` : "none", a ? (STATE_WORDS[a.state] ?? a.state) : "", day(a?.startedAt), day(a?.finishedAt)]);
        if (app.scope.length) rows.push(["", `Also in scope: ${app.scope.join(", ")}`]);
        if (app.excludedPaths.length) rows.push(["", `Never requested: ${app.excludedPaths.join(", ")}`]);
        // Round 20 (SIGN), as the HTML report shows them: sensitive workflows, the saved sign-in used (by account, never a value), the API document.
        for (const w of app.sensitiveWorkflows ?? []) rows.push(["", `Sensitive workflow, never requested: ${w.name} (${w.pathPrefixes.join(", ")})${w.note ? `: ${clean(w.note)}` : ""}`]);
        if (app.signInAccount) rows.push(["", `Signed in with: the saved sign-in of ${signInLabel(app.signInAccount)} (no password typed, no form submitted, sign-out links not followed)`]);
        if (app.apiDocument) rows.push(["", `API document: ${app.apiDocument.fileName}, ${app.apiDocument.operations} operations, of which ${app.apiDocument.requestable} GET without required parameters may be requested read-only`]);
    }

    if (d.retest) {
        heading("Retest results");
        rows.push(["Re-checked", `The open findings of assessment ${d.retest.originalId}`]);
        rows.push(["Fixed (not seen again)", d.retest.fixed.length]);
        for (const f of d.retest.fixed) rows.push(["", `${f.title} (${f.location})`]);
        rows.push(["Still present", d.retest.stillPresent.length]);
        for (const f of d.retest.stillPresent) rows.push(["", `${f.title} (${f.location})`]);
        if (d.retest.notMarked.length) {
            rows.push(["Not seen, not marked fixed (the retest did not finish)", d.retest.notMarked.length]);
            for (const f of d.retest.notMarked) rows.push(["", `${f.title} (${f.location})`]);
        }
    }

    heading("Coverage");
    if (!d.assessments.length) rows.push(["", "No assessment has run yet."]);
    for (const a of d.assessments) {
        const app = d.applications.find((x) => x.app.id === a.applicationId)?.app;
        const c = a.coverage;
        rows.push([app?.name ?? "Application", c ? `${c.pagesSeen} pages, ${c.formsSeen} forms (looked at, never submitted) and ${c.apiCallsSeen} API calls seen; assessment of ${day(a.createdAt)}, ${STATE_WORDS[a.state] ?? a.state}.` : `No coverage was recorded for the assessment of ${day(a.createdAt)}.`]);
        for (const n of c?.notInspected ?? []) rows.push(["Not inspected", clean(n)]);
        if (a.error) rows.push(["", clean(a.error)]);
    }

    heading("Limitations");
    for (const l of d.limitations) rows.push(["", l]);
    rows.push([]);
    rows.push(["", "Evidence is shown as received, with secrets, cookie values and personal data hidden. Every cell is text or a number; nothing in this file is a formula."]);
    return { rows, headings };
}

/** The report as an .xlsx workbook: "Summary" and "Findings". */
export function renderReportXlsx(d: SecurityReportData): Uint8Array {
    const { rows, headings } = summaryRows(d);
    const findings: XlsxSheet = {
        name: "Findings",
        rows: [[...CSV_COLUMNS], ...findingRows(d)],
        header: true,
        wrap: true,
        widths: [14, 22, 40, 10, 22, 11, 14, 44, 10, 21, 21, 60, 50, 50, 50, 60],
    };
    return buildXlsx([{ name: "Summary", rows, widths: [34, 70, 14, 14, 60, 16, 16, 21, 21] }, findings], { title: reportTitle(d), created: new Date(d.generatedAt), boldRows: { 0: headings }, titleRow: [0] });
}
