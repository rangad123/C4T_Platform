/**
 * Security reports as an Excel workbook (.xlsx), written without a spreadsheet library.
 *
 * The workbook writer itself is src/shared/xlsx.ts `buildXlsx`.
 *
 * Two sheets: "Summary" (what the report is about, the risk level with its rules, counts by severity and category, the applications and
 * their authorization, coverage and limitations) and "Findings" (one row per finding with exactly the CSV's columns and values).
 *
 * Safety: every cell is an inline string (or a plain number on the Summary), never a formula: a value that starts with = + - @ is shown
 * as typed and a spreadsheet cannot run it. Text is XML-escaped, characters XML cannot carry are removed, and a cell longer than Excel's
 * limit is cut with a note. The content is the report's (already redacted at ingest; free text from records is redacted again here, as
 * the HTML report does); the approver's e-mail address is never written.
 */
import type { FindingCategory, Severity } from "../contract.js";
import { SEVERITIES } from "../contract.js";
import { CATEGORY_WORDS, CSV_COLUMNS, REPORT_MAX_FINDINGS, reportTitle, STATE_WORDS, VALIDATION_WORDS, type SecurityReportData } from "./report.js";
import { redactText } from "./redact.js";
import { signInLabel } from "../authorization.js";
import { buildXlsx, type XlsxCell, type XlsxSheet } from "../../shared/xlsx.js";

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
