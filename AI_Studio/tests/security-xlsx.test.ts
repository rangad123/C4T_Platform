/**
 * Security reports as Excel workbooks (round 20, UI2): the minimal XLSX writer (src/security/findings/xlsx.ts) and `format=xlsx` on FIND's
 * report routes, through the real platform server (server.inject, no port opened, no browser).
 *
 * The file is unzipped here and its XML read back: the parts a spreadsheet needs, the two sheets, the Findings sheet's columns and values
 * (the CSV's), every cell text or a number (no formula, whatever a value starts with), XML escaping, no secret, and the export recorded in
 * the security trail. Whether Excel itself opens the file without a warning cannot be checked on this machine (no Excel here); the parts
 * follow ECMA-376 as Excel writes them.
 *
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/security-xlsx.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { evaluateSecurity, type SecurityCall, type SecurityCheck } from "../src/engine/security/checks.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { UserStore } from "../src/platform/user-store.js";
import { fromCheckFailure, ingest, type RawResult } from "../src/security/findings/ingest.js";
import { buildReport, CSV_COLUMNS, renderReportCsv } from "../src/security/findings/report.js";
import { buildXlsx, columnName, findingRows, sheetName, XLSX_CELL_MAX } from "../src/security/findings/xlsx.js";
import { securityStoreFor, type SecurityStore } from "../src/security/store.js";

type App = Awaited<ReturnType<typeof buildServer>>;
const KEY = "xlsx-test-access-key-0123456789";
const API = "/api/v1/security";
const SENTINELS = { cookie: "XLSXCOOKIE-SENTINEL-1a2b", env: "XLSXENV-SENTINEL-3c4d", email: "approver.person@xlsx-sentinel.example" };

// ── reading a workbook back ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
function unzip(bytes: Uint8Array): Record<string, string> {
    const files = unzipSync(bytes);
    return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strFromU8(v)]));
}
/** The sheet's rows as arrays of cell values (strings for text, numbers for numbers), by cell reference. */
function readSheet(xml: string): Array<Array<string | number | undefined>> {
    const rows: Array<Array<string | number | undefined>> = [];
    for (const r of xml.matchAll(/<row r="(\d+)">(.*?)<\/row>/gs)) {
        const row: Array<string | number | undefined> = [];
        for (const c of r[2]!.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)) {
            let col = 0;
            for (const ch of c[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
            const inner = c[3] ?? "";
            const t = /<t xml:space="preserve">(.*?)<\/t>/s.exec(inner);
            const v = /<v>(.*?)<\/v>/s.exec(inner);
            row[col - 1] = t ? unesc(t[1]!) : v ? Number(v[1]) : undefined;
        }
        rows[Number(r[1]) - 1] = row;
    }
    return rows;
}
/** A CSV of the report (quoted cells, CRLF) back into rows, undoing the formula guard's leading apostrophe. */
function readCsv(text: string): string[][] {
    const out: string[][] = [];
    let row: string[] = [];
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    while (i < text.length) {
        if (text[i] === '"') {
            let j = i + 1;
            let cell = "";
            while (j < text.length) {
                if (text[j] === '"' && text[j + 1] === '"') (cell += '"'), (j += 2);
                else if (text[j] === '"') break;
                else cell += text[j++];
            }
            row.push(/^'[=+\-@\t\r]/.test(cell) ? cell.slice(1) : cell);
            i = j + 1;
        }
        if (text[i] === ",") i++;
        else if (text[i] === "\r" && text[i + 1] === "\n") {
            out.push(row);
            row = [];
            i += 2;
        } else if (i < text.length && text[i] !== '"') i++;
    }
    return out;
}

describe("the writer", () => {
    it("column names and sheet names", () => {
        expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnName)).toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
        expect(sheetName("Findings")).toBe("Findings");
        expect(sheetName("a/b:c*d?[e]")).toBe("a b c d  e");
        expect(sheetName("'quoted'")).toBe("quoted");
        expect(sheetName("x".repeat(40))).toHaveLength(31);
        expect(sheetName("")).toBe("Sheet");
    });

    it("writes the parts a spreadsheet needs, and every cell is text or a number, never a formula", () => {
        const risky = ["=cmd|' /C calc'!A0", "+SUM(1,2)", "-2+3", "@SUM(A1)", "\t=1", "a<b & \"c\" > d", "bell\u0001here\u0008", "line one\nline two", "café ü 日本"];
        const bytes = buildXlsx([{ name: "Data", rows: [["Value", "Number"], ...risky.map((v, i) => [v, i])], header: true }, { name: "data", rows: [["second sheet, same name in another case"]] }], { title: "A <title>", created: new Date("2026-10-01T10:00:00.000Z") });
        // A zip ("PK"), as Excel expects.
        expect(Array.from(bytes.slice(0, 2))).toEqual([0x50, 0x4b]);
        const f = unzip(bytes);
        expect(Object.keys(f).sort()).toEqual(["[Content_Types].xml", "_rels/.rels", "docProps/core.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]);
        for (const [name, xml] of Object.entries(f)) expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'), name).toBe(true);
        expect(f["[Content_Types].xml"]).toContain('PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"');
        expect(f["_rels/.rels"]).toContain('Target="xl/workbook.xml"');
        expect(f["xl/_rels/workbook.xml.rels"]).toContain('Target="worksheets/sheet1.xml"');
        expect(f["xl/_rels/workbook.xml.rels"]).toContain('Target="styles.xml"');
        // Sheet names are unique regardless of case.
        expect([...f["xl/workbook.xml"]!.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1])).toEqual(["Data", "data 2"]);
        expect(f["xl/workbook.xml"]).toContain(`<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'Data'!$A$1:$B$10</definedName>`);
        expect(f["docProps/core.xml"]).toContain("<dc:title>A &lt;title&gt;</dc:title>");
        expect(f["docProps/core.xml"]).toContain("2026-10-01T10:00:00Z");

        const sheet = f["xl/worksheets/sheet1.xml"]!;
        expect(sheet).not.toMatch(/<f[\s>]/);
        expect(sheet).not.toContain("\u0001");
        expect(sheet).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
        expect(sheet).toContain('<autoFilter ref="A1:B10"/>');
        const rows = readSheet(sheet);
        expect(rows[0]).toEqual(["Value", "Number"]);
        // Exactly as typed (only the characters XML cannot carry are gone), as inline strings: a spreadsheet shows them, it does not run them.
        expect(rows.slice(1).map((r) => r[0])).toEqual(risky.map((v) => v.replace(/[\u0001\u0008]/g, "")));
        expect(rows.slice(1).map((r) => r[1])).toEqual(risky.map((_, i) => i));
        expect([...sheet.matchAll(/<c r="A\d+"[^>]*>/g)].every((m) => / t="inlineStr"/.test(m[0]))).toBe(true);
        // The header row is bold (style 1).
        expect(sheet).toMatch(/<c r="A1" s="1" t="inlineStr">/);
    });

    it("cuts a cell longer than Excel's limit and says so; an empty workbook is refused", () => {
        const f = unzip(buildXlsx([{ name: "Long", rows: [["x".repeat(XLSX_CELL_MAX + 500)]] }]));
        const cell = readSheet(f["xl/worksheets/sheet1.xml"]!)[0]![0] as string;
        expect(cell.length).toBeLessThanOrEqual(XLSX_CELL_MAX);
        expect(cell).toMatch(/cut here: the full text is in the HTML or PDF report\)$/);
        expect(() => buildXlsx([])).toThrow();
    });
});

describe("format=xlsx on the report routes", () => {
    let dir: string;
    let platform: Platform;
    let app: App;
    let store: SecurityStore;
    let projectId: string;
    let otherProjectId: string;
    let viewerToken: string;
    let appId: string;
    let assessmentId: string;

    const page = (url: string, over: Partial<SecurityCall> = {}): SecurityCall => ({ status: 200, headers: { "content-type": "text/html", server: "Apache/2.4.7" }, text: "<html></html>", url, ...over });
    async function results(check: SecurityCheck, c: SecurityCall): Promise<RawResult[]> {
        const msg = await evaluateSecurity(check, [c]);
        return msg ? fromCheckFailure(check, msg, c) : [];
    }
    async function call(method: string, url: string, body?: unknown, key = KEY) {
        const res = await app.inject({ method: method as "GET", url, headers: { "x-api-key": key, ...(body ? { "content-type": "application/json" } : {}) }, payload: body ? JSON.stringify(body) : undefined });
        return { status: res.statusCode, headers: res.headers, raw: res.rawPayload, text: res.body };
    }

    beforeAll(async () => {
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-secxlsx-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", SECRET_KEY: "xlsx-test-secret-key-0123456789", API_KEY: KEY }));
        app = await buildServer(platform);
        await app.ready();
        store = securityStoreFor(platform.db);
        projectId = String(platform.repo.createProject({ name: "Client X" }).id);
        otherProjectId = String(platform.repo.createProject({ name: "Client Y" }).id);
        const users = new UserStore(platform.db);
        viewerToken = users.createToken(users.create({ email: "vi@example.com", name: "Vi", role: "viewer" }).id, { name: "t", role: "viewer" }).token;
        const a = store.createApplication(projectId, { name: "Shop", targetUrl: "http://shop.test/", environment: "staging", excludedPaths: ["/admin"] });
        appId = a.id;
        store.addAuthorization(a.id, { basis: "client-permission", approverName: "Pat Approver", approverEmail: SENTINELS.email, documentReference: "SOW-7", restrictions: "Office hours only", statement: "I confirm.", confirmedByName: "Owner" });
        const rs = [
            ...(await results("securityHeaders", page("http://shop.test/"))),
            ...(await results("cookieFlags", page("http://shop.test/login", { setCookies: [`session=${SENTINELS.cookie}; Path=/`] }))),
            ...(await results("noExposedFiles", page("http://shop.test/.env", { headers: { "content-type": "text/plain" }, text: `DB_PASSWORD=${SENTINELS.env}\n` }))),
        ];
        const as = store.createAssessment({ applicationId: a.id, authorizationId: store.currentAuthorization(a)!.id, startedBy: "Test" });
        store.updateAssessment(as.id, { state: "COMPLETED", progress: 100, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), coverage: { pagesSeen: 3, formsSeen: 1, apiCallsSeen: 0, notInspected: ["Signed-in pages: no account was given."] } });
        await ingest(store, store.getAssessment(as.id)!, rs);
        assessmentId = as.id;
        // A finding entered by hand whose words look like spreadsheet formulas.
        const manual = await call("POST", `${API}/applications/${appId}/findings`, { title: "=HYPERLINK(\"http://evil.test\",\"click\")", category: "other", severity: "low", location: "@SUM(A1:A9)", description: "+cmd|' /C calc'!A0", impact: "-1+1", remediation: "Escape <tags> & quotes \"properly\"." });
        expect(manual.status).toBe(201);
    });

    afterAll(async () => {
        await app?.close();
        platform?.db.close();
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });

    it("the project report: a workbook with Summary and Findings; the Findings sheet has the CSV's columns and values", async () => {
        const r = await call("GET", `${API}/projects/${projectId}/report?format=xlsx`, undefined, viewerToken);
        expect(r.status).toBe(200);
        expect(r.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        expect(r.headers["content-disposition"]).toMatch(/^attachment; filename="security-report-client-x-\d{4}-\d{2}-\d{2}\.xlsx"$/);
        const f = unzip(new Uint8Array(r.raw));
        expect([...f["xl/workbook.xml"]!.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1])).toEqual(["Summary", "Findings"]);
        const rows = readSheet(f["xl/worksheets/sheet2.xml"]!);
        expect(rows[0]).toEqual([...CSV_COLUMNS]);
        const csv = readCsv((await call("GET", `${API}/projects/${projectId}/report?format=csv`)).text);
        expect(csv[0]).toEqual([...CSV_COLUMNS]);
        expect(rows.length).toBe(csv.length);
        expect(rows.length).toBeGreaterThan(4);
        // Cell for cell the CSV's values (the CSV adds an apostrophe before = + - @, the workbook keeps them as typed text).
        for (let i = 1; i < rows.length; i++) expect(rows[i]!.map((c) => c ?? ""), `row ${i}`).toEqual(csv[i]);
        const data = buildReport(platform.db, { projectId })!;
        expect(rows.slice(1).map((r) => r.map((c) => c ?? ""))).toEqual(findingRows(data));

        const manual = rows.find((x) => x[2] === '=HYPERLINK("http://evil.test","click")');
        expect(manual, "the hand-entered finding").toBeTruthy();
        expect(manual![7]).toBe("@SUM(A1:A9)");
        expect(manual![11]).toBe("+cmd|' /C calc'!A0");
        expect(manual![12]).toBe("-1+1");
        expect(manual![13]).toBe('Escape <tags> & quotes "properly".');
        for (const xml of Object.values(f)) expect(xml).not.toMatch(/<f[\s>]/);
    });

    it("the Summary sheet: what it is about, the risk and its rules, counts, the authorization without the approver's email, coverage, limits", async () => {
        const r = await call("GET", `${API}/projects/${projectId}/report?format=xlsx`);
        const f = unzip(new Uint8Array(r.raw));
        const rows = readSheet(f["xl/worksheets/sheet1.xml"]!).map((x) => (x ?? []).map((c) => c ?? ""));
        const flat = rows.map((x) => x.join(" | ")).join("\n");
        expect(rows[0]![0]).toBe("Security assessment report: Client X");
        expect(flat).toContain("Project | Client X");
        expect(flat).toContain("Report on | The whole project, every application");
        expect(flat).toMatch(/Level \| (High|Medium|Low) risk/);
        expect(flat).toContain("How the level is decided | ");
        expect(flat).toMatch(/Severity \| Open \| In this report/);
        const critical = rows.find((x) => x[0] === "Critical")!;
        expect(typeof critical[1]).toBe("number");
        expect(flat).toContain("Authorized by Pat Approver (documented permission of the owner), recorded by Owner");
        expect(flat).toContain("Restrictions: Office hours only");
        expect(flat).toContain("Never requested: /admin");
        expect(flat).toContain("Not inspected | Signed-in pages: no account was given.");
        expect(flat).toContain("No AI model judged these findings.");
        // Section headings are bold, the title larger.
        expect(f["xl/worksheets/sheet1.xml"]).toMatch(/<c r="A1" s="3" t="inlineStr">/);
        expect(f["xl/worksheets/sheet1.xml"]).toMatch(/<c r="A\d+" s="1" t="inlineStr"><is><t xml:space="preserve">Risk overview</);
        const all = Object.values(f).join("\n");
        for (const s of Object.values(SENTINELS)) expect(all).not.toContain(s);
    });

    it("one assessment's report, the export in the security trail and Activity, and another project's assessment answers 404", async () => {
        const r = await call("GET", `${API}/assessments/${assessmentId}/report?format=xlsx`);
        expect(r.status).toBe(200);
        expect(r.headers["content-disposition"]).toMatch(/filename="security-report-shop-\d{4}-\d{2}-\d{2}\.xlsx"/);
        const f = unzip(new Uint8Array(r.raw));
        const summary = readSheet(f["xl/worksheets/sheet1.xml"]!).map((x) => (x ?? []).join(" | ")).join("\n");
        expect(summary).toContain(`Report on | One assessment (${assessmentId})`);
        const audit = store.listAudit(projectId, { action: "report.exported" }).map((e) => e.summary);
        expect(audit.some((s) => /^Exported the report of the assessment of “Shop” as XLSX \(\d+ findings?\)\.$/.test(s))).toBe(true);
        expect(audit.some((s) => /^Exported the project's security report as XLSX/.test(s))).toBe(true);
        const other = await call("GET", `${API}/assessments/${assessmentId}/report?format=xlsx&projectId=${otherProjectId}`);
        expect(other.status).toBe(404);
        expect((await call("GET", `${API}/projects/${projectId}/report?format=xls`)).status).toBe(400);
        expect(renderReportCsv(buildReport(platform.db, { projectId })!).length).toBeGreaterThan(0);
    });
});
