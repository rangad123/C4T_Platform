/**
 * The xlsx reader (founder 2026-11-19, C5; SPEC R6.2 and R6.3, with the row limit raised to 5,000 by the lead on 2026-11-20): src/engine/manual/xlsx-read.ts reads the "Test cases" sheet of the test
 * case workbook, both as the platform writes it (inline strings, src/shared/xlsx.ts) and as Excel or LibreOffice save it again
 * (shared strings, rich text, styles, gaps, line breaks), and refuses wrong or hostile files with a sentence.
 *
 * LibreOffice and Excel are not on this machine, so the re-saved file is built here by `resavedWorkbook()` in the shape those programs
 * write (shared strings with rich-text runs and phonetic guides, styles, a theme, app properties, `_x000D_` line ends, skipped and missing
 * cell references, formulas with cached values, trailing formatted empty rows). It is committed as tests/fixtures/case-workbook-resaved.xlsx;
 * `WRITE_FIXTURES=1` rewrites it. A real Excel or LibreOffice re-save is still worth one manual try.
 *
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/xlsx-read-unit.test.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { describe, expect, it } from "vitest";
import { readSheet, readTable, XlsxReadError } from "../src/engine/manual/xlsx-read.js";
import { buildXlsx, columnName } from "../src/shared/xlsx.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "case-workbook-resaved.xlsx");

// The owner-decided workbook (SPEC §2 Q3, R9).
const CASE_COLUMNS = ["ID", "Title", "Type", "Priority", "Page", "Preconditions", "Steps", "Expected result", "Requirement"] as const;
const CASES: string[][] = [
    ["TC-001", "Sign in with a valid account", "Automated", "High", "/login", "A registered account exists\nThe user is signed out", "", "The dashboard opens\nThe user's name is shown", "REQ-1"],
    ["TC-002", "Search for a product by name", "Manual", "Medium", "/search", "", "Type “lamp” in the search box => Suggestions appear\nPress Enter => Results list lamps", "Only lamps are listed", ""],
    ["TC-003", "=cmd|' /C calc'!A0 is shown as text", "Automated", "Low", "/", "", "", "", "Free text source"],
];
const PAGES = [["Page", "Address", "Purpose"], ["/", "http://localhost:3000/", "Home"], ["/login", "http://localhost:3000/login", "Sign in"], ["/search", "http://localhost:3000/search", "Search"]];
const TREE = [["Node", "Parent", "Page"], ["/", "", "/"], ["/login", "/", "/login"], ["/search", "/", "/search"]];

/**
 * The workbook exactly as the platform's export writes it: the same writer call, sheet options and widths as `buildCaseWorkbook` in
 * src/platform/case-workbook.ts (C3, 3e5370de), which is built in parallel and so is not imported here. Inline strings, 3 sheets.
 */
function platformWorkbook(cases = CASES): Uint8Array {
    const sheet = (name: string, rows: string[][], widths: number[]) => ({ name, rows, header: true, wrap: true, widths });
    return buildXlsx([sheet("Test cases", [[...CASE_COLUMNS], ...cases], [10, 50, 11, 10, 24, 40, 60, 50, 24]), sheet("Pages", PAGES, [30, 50, 60]), sheet("Tree", TREE, [30, 30, 30])], {
        title: "Test cases",
    });
}

const enc = strToU8;
const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const zip = (files: Record<string, string | Uint8Array>, level: 0 | 6 = 6): Uint8Array => {
    const z: Zippable = {};
    for (const [k, v] of Object.entries(files)) z[k] = [typeof v === "string" ? enc(v) : v, { level }];
    return zipSync(z, { mtime: new Date("2026-11-20T00:00:00Z") });
};

const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`;
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

/** A minimal workbook around raw sheet XML (`<sheetData>` content), for the edge cases. */
function rawWorkbook(sheetData: string, opts: { name?: string; shared?: string[]; extra?: Record<string, string | Uint8Array> } = {}): Uint8Array {
    const ss = opts.shared
        ? `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${opts.shared.length}" uniqueCount="${opts.shared.length}">${opts.shared.map((s) => `<si><t xml:space="preserve">${xmlEsc(s)}</t></si>`).join("")}</sst>`
        : undefined;
    return zip({
        "[Content_Types].xml": CT,
        "_rels/.rels": ROOT_RELS,
        "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${opts.name ?? "Test cases"}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>${ss ? `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` : ""}</Relationships>`,
        "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`,
        ...(ss ? { "xl/sharedStrings.xml": ss } : {}),
        ...opts.extra,
    });
}
const inl = (ref: string, s: string) => `<c r="${ref}" t="inlineStr"><is><t>${xmlEsc(s)}</t></is></c>`;

/**
 * The same workbook as Excel or LibreOffice save it after a person edits it: sheets in another order with a fourth sheet added, every
 * text a shared string (some rich text, one with a phonetic guide, CR LF line ends written as `_x000D_`), styles on every cell, empty
 * styled cells, a cell without a reference, a formula cell with its cached value, trailing formatted empty rows, a theme and app
 * properties, part names in the case Excel uses, and the workbook relationships in another order.
 */
function resavedWorkbook(): Uint8Array {
    const shared: string[] = [];
    const sst: string[] = [];
    const s = (text: string, xml?: string) => {
        let i = shared.indexOf(text);
        if (i < 0 || xml) {
            i = sst.length;
            shared.push(text);
            sst.push(xml ?? `<si><t${/^\s|\s$|\n/.test(text) ? ' xml:space="preserve"' : ""}>${xmlEsc(text).replace(/\n/g, "_x000D_\n")}</t></si>`);
        }
        return i;
    };
    const cellRow = (r: number, cells: string[], styleOf: (c: number) => number) =>
        `<row r="${r}" spans="1:10" s="1" customFormat="1">${cells
            .map((v, c) => {
                const ref = `${columnName(c)}${r}`;
                if (v === "") return `<c r="${ref}" s="${styleOf(c)}"/>`;
                return `<c r="${ref}" s="${styleOf(c)}" t="s"><v>${s(v)}</v></c>`;
            })
            .join("")}</row>`;
    // Test cases sheet: the header bold (s=1), the rest wrapped (s=2). Row 2's title is rich text; row 3's steps carry CR LF.
    const header = cellRow(1, [...CASE_COLUMNS], () => 1);
    const r2 = CASES[0]!.slice();
    const richTitle = s(
        r2[1]!,
        `<si><r><rPr><b/><sz val="11"/><rFont val="Calibri"/></rPr><t xml:space="preserve">Sign in </t></r><r><rPr><sz val="11"/><rFont val="Calibri"/></rPr><t>with a valid account</t></r><rPh sb="0" eb="4"><t>サインイン</t></rPh></si>`,
    );
    const row2 = `<row r="2" spans="1:10"><c r="A2" s="2" t="s"><v>${s(r2[0]!)}</v></c><c r="B2" s="2" t="s"><v>${richTitle}</v></c>${r2
        .slice(2)
        .map((v, i) => (v ? `<c r="${columnName(i + 2)}2" s="2" t="s"><v>${s(v)}</v></c>` : ""))
        .join("")}</row>`;
    // Row 3: no reference on the first cell (allowed by ECMA-376), the gaps left out entirely (F3 and I3), a formula with a cached value in J3.
    const r3 = CASES[1]!;
    const row3 = `<row r="3"><c s="2" t="s"><v>${s(r3[0]!)}</v></c><c r="B3" s="2" t="s"><v>${s(r3[1]!)}</v></c><c r="C3" s="2" t="s"><v>${s(r3[2]!)}</v></c><c r="D3" s="2" t="s"><v>${s(r3[3]!)}</v></c><c r="E3" s="2" t="s"><v>${s(r3[4]!)}</v></c><c r="G3" s="2" t="s"><v>${s(r3[6]!)}</v></c><c r="H3" s="2" t="s"><v>${s(r3[7]!)}</v></c><c r="K3" s="2" t="str"><f>A3&amp;" note"</f><v>TC-002 note</v></c></row>`;
    const row4 = cellRow(4, CASES[2]!, () => 2);
    // Rows a person formatted but left empty, as Excel keeps them.
    const empty = `<row r="5" spans="1:10" s="2" customFormat="1"><c r="A5" s="2"/><c r="B5" s="2"/></row><row r="40" ht="15" customHeight="1"/>`;
    const sheet = (rowsXml: string, dim: string) =>
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"><sheetPr filterMode="false"><pageSetUpPr fitToPage="false"/></sheetPr><dimension ref="${dim}"/><sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15" x14ac:dyDescent="0.25"/><cols><col min="1" max="1" width="12" customWidth="1"/><col min="2" max="1024" width="30" customWidth="1"/></cols><sheetData>${rowsXml}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
    const plain = (rows: string[][]) => rows.map((r, i) => cellRow(i + 1, r, () => (i === 0 ? 1 : 0))).join("");
    const files: Record<string, string> = {
        "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
        "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        "docProps/app.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Excel</Application><DocSecurity>0</DocSecurity></Properties>`,
        "docProps/core.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Test cases</dc:title><cp:lastModifiedBy>A person</cp:lastModifiedBy></cp:coreProperties>`,
        "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="27425"/><workbookPr defaultThemeVersion="166925"/><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="12300" activeTab="1"/></bookViews><sheets><sheet name="Notes" sheetId="4" r:id="rId4"/><sheet name="Test cases" sheetId="1" r:id="rId1"/><sheet name="Pages" sheetId="2" r:id="rId2"/><sheet name="Tree" sheetId="3" r:id="rId3"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="1" hidden="1">'Test cases'!$A$1:$I$4</definedName></definedNames><calcPr calcId="191029"/></workbook>`,
        "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet1.xml"/><Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet4.xml"/></Relationships>`,
        "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;TC-&quot;000"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs></styleSheet>`,
        "xl/theme/theme1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1></a:clrScheme></a:themeElements></a:theme>`,
        "xl/worksheets/sheet1.xml": sheet(header + row2 + row3 + row4 + empty, "A1:K40"),
        "xl/worksheets/sheet2.xml": sheet(plain(PAGES), "A1:C4"),
        "xl/worksheets/sheet3.xml": sheet(plain(TREE), "A1:C4"),
        "xl/worksheets/sheet4.xml": sheet(plain([["Reviewed by", "Asha"], ["Date", "2026-11-21"]]), "A1:B2"),
    };
    files["xl/sharedStrings.xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.length + 3}" uniqueCount="${sst.length}">${sst.join("")}</sst>`;
    return zip(files);
}

function refusal(fn: () => unknown): string {
    try {
        fn();
    } catch (err) {
        expect(err).toBeInstanceOf(XlsxReadError);
        return (err as Error).message;
    }
    throw new Error("expected a refusal, got a result");
}

const asRecords = (rows: string[][]) => rows.slice(1).map((r) => CASE_COLUMNS.map((_, i) => r[i] ?? ""));
const table = (bytes: Uint8Array) => readTable(bytes, "Test cases", { columns: CASE_COLUMNS, required: ["Title"] });

describe("reading the test case workbook", () => {
    it("reads the platform's own workbook (inline strings) cell for cell, line breaks kept", () => {
        const rows = readSheet(platformWorkbook(), "Test cases");
        expect(rows[0]).toEqual([...CASE_COLUMNS]);
        expect(asRecords(rows)).toEqual(CASES);
        expect(rows[2]![6]).toBe("Type “lamp” in the search box => Suggestions appear\nPress Enter => Results list lamps");
        expect(readSheet(platformWorkbook(), "Pages")).toEqual(PAGES);
        expect(readSheet(platformWorkbook(), "Tree")).toEqual(TREE);
    });

    it("reads the committed re-saved fixture (shared strings, rich text, styles, gaps, CR LF) as the same records", () => {
        const built = resavedWorkbook();
        if (process.env.WRITE_FIXTURES === "1") fs.writeFileSync(FIXTURE, built);
        const committed = new Uint8Array(fs.readFileSync(FIXTURE));
        for (const bytes of [committed, built]) {
            const rows = readSheet(bytes, "Test cases");
            expect(asRecords(rows)).toEqual(CASES);
            // The extra column a person added (a formula) reads as its cached value; the formula itself never appears.
            expect(rows[2]![10]).toBe("TC-002 note");
            expect(JSON.stringify(rows)).not.toContain('" note"');
            // The phonetic guide of the rich-text title is not part of the text.
            expect(rows[1]![1]).toBe("Sign in with a valid account");
            // Trailing formatted empty rows are not rows.
            expect(rows).toHaveLength(4);
            expect(readSheet(bytes, "Pages")).toEqual(PAGES);
            expect(readSheet(bytes, "Tree")).toEqual(TREE);
        }
        expect(table(committed)).toEqual(table(platformWorkbook()));
    });

    it("matches headers in any order and case, ignores unknown columns, and fills missing optional columns with empty text", () => {
        const bytes = rawWorkbook(
            `<row r="1">${inl("A1", "  expected RESULT ")}${inl("B1", "Notes")}${inl("C1", "title")}${inl("D1", "TYPE")}</row>` +
                `<row r="2">${inl("A2", "It works")}${inl("B2", "ignored")}${inl("C2", "A case")}${inl("D2", "Manual")}</row>` +
                `<row r="4">${inl("C4", "Another case")}</row>`,
        );
        const out = table(bytes);
        expect(out.map((r) => r.row)).toEqual([2, 4]);
        expect(out[0]!.values).toEqual({ ID: "", Title: "A case", Type: "Manual", Priority: "", Page: "", Preconditions: "", Steps: "", "Expected result": "It works", Requirement: "" });
        expect(out[1]!.values.Title).toBe("Another case");
        expect(out[1]!.values["Expected result"]).toBe("");
    });

    it("keeps positions across skipped cells and rows, cells and rows without references, and empty cells", () => {
        const rows = readSheet(
            rawWorkbook(`<row r="1">${inl("A1", "a")}${inl("D1", "d")}</row><row>${inl("", "x")}<c t="inlineStr"><is><t>y</t></is></c><c r="C2"/><c r="E2" t="inlineStr"><is/></c></row><row r="5"><c r="B5" t="s"><v>1</v></c></row>`, {
                shared: ["zero", "one"],
                name: "Data",
            }),
            "data",
        );
        expect(rows).toEqual([["a", "", "", "d"], ["x", "y"], [], [], ["", "one"]]);
    });

    it("reads numbers, booleans, errors and formulas as the text the spreadsheet showed, and never returns formula text", () => {
        const rows = readSheet(
            rawWorkbook(
                `<row r="1"><c r="A1"><v>3</v></c><c r="B1"><v>0.10000000000000001</v></c><c r="C1" t="b"><v>1</v></c><c r="D1" t="e"><v>#N/A</v></c>` +
                    `<c r="E1"><f>1+1</f><v>2</v></c><c r="F1" t="str"><f>HYPERLINK("http://evil.example","x")</f></c><c r="G1" t="inlineStr"><is><t>=1+1</t></is></c><c r="H1" t="s"><f>A1</f><v>0</v></c></row>`,
                { shared: ["shared text"] },
            ),
            "Test cases",
        );
        expect(rows).toEqual([["3", "0.1", "TRUE", "#N/A", "2", "", "=1+1", "shared text"]]);
        expect(JSON.stringify(rows)).not.toContain("HYPERLINK");
    });

    it("decodes XML escapes, numeric references and Excel's _xHHHH_ escapes, and leaves undefined entities as written", () => {
        const rows = readSheet(
            rawWorkbook(`<row r="1"><c r="A1" t="inlineStr"><is><t>a &amp; b &lt;c&gt; &#233;&#x1F600; &xxe;</t></is></c><c r="B1" t="inlineStr"><is><t><![CDATA[<raw>]]></t></is></c><c r="C1" t="s"><v>0</v></c></row>`, {
                shared: ["line one_x000D_\nline two_x000D_\nline_x005F_x0041_ three"],
            }),
            "Test cases",
        );
        expect(rows[0]).toEqual(["a & b <c> é😀 &xxe;", "<raw>", "line one\nline two\nline_x0041_ three"]);
    });

    it("reads namespace-prefixed XML (as some tools write it) and stored (uncompressed) parts", () => {
        const sheet = `<?xml version="1.0"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>Title</x:t></x:is></x:c></x:row><x:row r="2"><x:c r="A2" t="inlineStr"><x:is><x:r><x:t>Pre</x:t></x:r><x:r><x:t>fixed</x:t></x:r></x:is></x:c></x:row></x:sheetData></x:worksheet>`;
        const base = rawWorkbook("");
        const files = zipToMap(base);
        files["xl/worksheets/sheet1.xml"] = sheet;
        files["xl/workbook.xml"] = files["xl/workbook.xml"]!.replace(/<(\/?)(workbook|sheets|sheet)\b/g, "<$1x:$2").replace('xmlns="', 'xmlns:x="');
        expect(readSheet(zip(files, 0), "Test cases")).toEqual([["Title"], ["Prefixed"]]);
    });

    it("reads 5,000 test cases of the export's size (the most it imports) inside the size guard, in well under the time a request allows", () => {
        const cases = Array.from({ length: 5000 }, (_, i) => [
            `TC-${String(i + 1).padStart(4, "0")}`,
            `Check that the ${i % 7 === 0 ? "checkout" : "product"} page ${i + 1} shows the right totals after a change`,
            i % 3 ? "Automated" : "Manual",
            ["Critical", "High", "Medium", "Low"][i % 4]!,
            `/area-${i % 40}/page-${i % 200}`,
            "The user is signed in\nThe cart holds two products",
            i % 3 ? "" : "Open the cart => Two products are listed\nChange the first quantity to 3 => The total updates\nPress Checkout => The payment step opens",
            "The total equals the sum of the lines\nNo error is shown",
            `REQ-${i % 30}`,
        ]);
        const bytes = platformWorkbook(cases);
        const t0 = performance.now();
        const out = table(bytes);
        expect(performance.now() - t0).toBeLessThan(3000);
        expect(out).toHaveLength(5000);
        expect(out.map((r) => CASE_COLUMNS.map((c) => r.values[c]))).toEqual(cases);
    });
});

/** Text parts of a zip (for small edits in tests). */
function zipToMap(bytes: Uint8Array): Record<string, string> {
    return Object.fromEntries(Object.entries(unzipSync(bytes)).map(([k, v]) => [k, strFromU8(v)]));
}

describe("refusing wrong or hostile files with a sentence", () => {
    it("a file that is not a workbook: text, an old .xls, an OpenDocument spreadsheet, a cut-off zip", () => {
        expect(refusal(() => readSheet(enc("title,steps\nA,B\n"), "Test cases"))).toMatch(/^This file is not an Excel workbook \(\.xlsx\)\./);
        expect(refusal(() => readSheet(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0]), "Test cases"))).toMatch(/old Excel file \(\.xls\)/);
        expect(refusal(() => readSheet(zip({ mimetype: "application/vnd.oasis.opendocument.spreadsheet", "content.xml": "<office:document-content/>" }, 0), "Test cases"))).toMatch(/OpenDocument spreadsheet \(\.ods\)/);
        const good = platformWorkbook();
        expect(refusal(() => readSheet(good.subarray(0, good.length - 30), "Test cases"))).toMatch(/^The workbook is damaged and cannot be read/);
        expect(refusal(() => readSheet(zip({ "readme.txt": "hello" }), "Test cases"))).toMatch(/not an Excel workbook/);
    });

    it("no “Test cases” sheet: names the sheets it has", () => {
        const bytes = buildXlsx([{ name: "Sheet1", rows: [["Title"], ["x"]] }, { name: "Pages", rows: PAGES }]);
        expect(refusal(() => readSheet(bytes, "Test cases"))).toBe("The workbook has no sheet named “Test cases”. Its sheets are “Sheet1”, “Pages”. Import the test case workbook, whose first sheet is “Test cases”.");
    });

    it("an empty sheet, a missing “Title” column, a column twice", () => {
        expect(refusal(() => table(rawWorkbook(`<row r="1"><c r="A1"/></row>`)))).toMatch(/^The “Test cases” sheet is empty\. Its first row must be the header: ID, Title, Type/);
        expect(refusal(() => table(rawWorkbook(`<row r="1">${inl("A1", "ID")}${inl("B1", "Name")}</row><row r="2">${inl("A2", "TC-1")}</row>`)))).toBe(
            "The “Test cases” sheet has no “Title” column. Its first row must be the header: ID, Title, Type, Priority, Page, Preconditions, Steps, Expected result, Requirement.",
        );
        expect(refusal(() => table(rawWorkbook(`<row r="1">${inl("A1", "Title")}${inl("B1", "title ")}</row>`)))).toMatch(/has the column “Title” more than once/);
    });

    it("more than 5,000 rows below the header, however the rows are numbered; 5,000 is fine", () => {
        const rowsXml = (n: number) => `<row r="1">${inl("A1", "Title")}</row>` + Array.from({ length: n }, (_, i) => `<row r="${i + 2}">${inl(`A${i + 2}`, `case ${i}`)}</row>`).join("");
        expect(table(rawWorkbook(rowsXml(5000)))).toHaveLength(5000);
        expect(refusal(() => table(rawWorkbook(rowsXml(5001))))).toBe("The “Test cases” sheet has more than 5,000 rows below its header. Import at most 5,000 at a time.");
        // A caller can ask for fewer.
        expect(refusal(() => readTable(rawWorkbook(rowsXml(11)), "Test cases", { columns: CASE_COLUMNS, required: ["Title"], maxRows: 10 }))).toMatch(/more than 10 rows/);
        // One stray cell far down counts; formatted empty rows there do not.
        expect(refusal(() => readSheet(rawWorkbook(`<row r="1">${inl("A1", "Title")}</row><row r="1048576">${inl("A1048576", "x")}</row>`), "Test cases"))).toMatch(/more than 5,000 rows/);
        expect(readSheet(rawWorkbook(`<row r="1">${inl("A1", "Title")}</row><row r="1048576" s="1" customFormat="1"><c r="A1048576" s="1"/></row>`), "Test cases")).toEqual([["Title"]]);
        expect(refusal(() => readSheet(rawWorkbook(`<row r="1">${inl("A1", "a")}${inl("XFD1", "far")}</row>`), "Test cases"))).toMatch(/text beyond column 100/);
    });

    it("a file over 10 MB, or more than 20 parts", () => {
        expect(refusal(() => readSheet(new Uint8Array(10 * 1024 * 1024 + 1), "Test cases"))).toBe("The file is larger than 10 MB. Import a smaller workbook.");
        const many: Record<string, string> = {};
        for (let i = 0; i < 21; i++) many[`xl/media/p${i}.xml`] = "<x/>";
        expect(refusal(() => readSheet(zip(many), "Test cases"))).toMatch(/^The workbook holds more than 20 parts/);
        // 20 parts is fine.
        const files = zipToMap(platformWorkbook());
        for (let i = Object.keys(files).length; i < 20; i++) files[`docProps/extra${i}.xml`] = "<x/>";
        expect(Object.keys(files)).toHaveLength(20);
        expect(readSheet(zip(files), "Test cases")[0]).toEqual([...CASE_COLUMNS]);
    });

    it("a zip bomb: more than 10 MB unpacked, whether declared or hidden behind a false size", () => {
        const zeros = new Uint8Array(24 * 1024 * 1024);
        const bomb = rawWorkbook(`<row r="1">${inl("A1", "Title")}</row>`, { extra: { "xl/bomb.xml": zeros } });
        expect(bomb.length).toBeLessThan(200_000);
        expect(refusal(() => readSheet(bomb, "Test cases"))).toMatch(/^The workbook unpacks to more than 10 MB/);
        // The same bomb with its declared size set to 100 bytes, in the central directory and the local header.
        const liar = lieAboutSize(bomb, "xl/bomb.xml", 100);
        const t0 = performance.now();
        expect(refusal(() => readSheet(liar, "Test cases"))).toMatch(/^The workbook unpacks to more than 10 MB/);
        expect(performance.now() - t0).toBeLessThan(3000);
    });

    it("a DOCTYPE in any part (entity expansion), and an encrypted part", () => {
        const laughs = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>&lol2;</t></si></sst>`;
        const msg = "The workbook contains a document type declaration (DOCTYPE), which Excel and LibreOffice never write. It was refused for safety.";
        expect(refusal(() => readSheet(rawWorkbook(`<row r="1"><c r="A1" t="s"><v>0</v></c></row>`, { extra: { "xl/sharedStrings.xml": laughs } }), "Test cases"))).toBe(msg);
        // In a part the reader would not otherwise look at, too.
        const xxe = `<?xml version="1.0"?><!doctype x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>`;
        expect(refusal(() => readSheet(rawWorkbook(`<row r="1">${inl("A1", "Title")}</row>`, { extra: { "docProps/custom.xml": xxe } }), "Test cases"))).toBe(msg);
        const enc = setFlag(platformWorkbook(), "xl/worksheets/sheet1.xml", 1);
        expect(refusal(() => readSheet(enc, "Test cases"))).toMatch(/protected with a password/);
    });

    it("a damaged cell: a shared string that is not there", () => {
        expect(refusal(() => readSheet(rawWorkbook(`<row r="1"><c r="A1" t="s"><v>5</v></c></row>`, { shared: ["only one"] }), "Test cases"))).toMatch(/^The workbook is damaged and cannot be read \(a cell points to text that is not there\)/);
    });
});

// ── raw zip edits ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function findEntries(b: Uint8Array, name: string): { central: number; local: number } {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    for (let o = b.length - 22; o >= 0; o--) {
        if (dv.getUint32(o, true) !== 0x06054b50) continue;
        let p = dv.getUint32(o + 16, true);
        for (let i = 0; i < dv.getUint16(o + 10, true); i++) {
            const n = dv.getUint16(p + 28, true);
            const fn = new TextDecoder().decode(b.subarray(p + 46, p + 46 + n));
            if (fn === name) return { central: p, local: dv.getUint32(p + 42, true) };
            p += 46 + n + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
        }
    }
    throw new Error(`no ${name} in the zip`);
}
function lieAboutSize(src: Uint8Array, name: string, size: number): Uint8Array {
    const b = src.slice();
    const dv = new DataView(b.buffer);
    const { central, local } = findEntries(b, name);
    dv.setUint32(central + 24, size, true);
    dv.setUint32(local + 22, size, true);
    return b;
}
function setFlag(src: Uint8Array, name: string, flag: number): Uint8Array {
    const b = src.slice();
    const dv = new DataView(b.buffer);
    const { central, local } = findEntries(b, name);
    dv.setUint16(central + 8, dv.getUint16(central + 8, true) | flag, true);
    dv.setUint16(local + 6, dv.getUint16(local + 6, true) | flag, true);
    return b;
}
