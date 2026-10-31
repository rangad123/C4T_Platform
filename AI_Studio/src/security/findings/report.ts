/**
 * Security assessment reports: one assessment, or the whole project. Built from stored data when asked for (nothing is stored), as a
 * self-contained print-friendly HTML page (also the source of the PDF, see routes) and a CSV of findings that opens in Excel.
 *
 * Sections: executive summary, scope and authorization, risk overview with its rules, findings by severity and category, top issues,
 * affected locations, each finding (evidence as stored, which is already redacted, validation state and history), remediation, coverage
 * and limitations, configuration and timestamps, retest results.
 *
 * Safety: everything is HTML-escaped; evidence was redacted at ingest and free text from records (restrictions, document references,
 * comments) is redacted again here; the approver's e-mail address is never printed; CSV cells that a spreadsheet would run as a formula
 * are prefixed so they stay text.
 */
import type { Db } from "../../platform/db.js";
import type { Evidence, FindingCategory, SecurityApplication, SecurityAssessment, SecurityFinding, Severity, ValidationState } from "../contract.js";
import { CATEGORIES, SEVERITIES } from "../contract.js";
import { securityStoreFor, type FindingHistoryEntry, type StoredAuthorization } from "../store.js";
import { assessRisk, isOpenFinding, type RiskOverview } from "./overview.js";
import { redactText } from "./redact.js";
import { signInLabel } from "../authorization.js";

/** Most findings one report lists (the most serious first); the report says when there were more. */
export const REPORT_MAX_FINDINGS = 1000;

export const VALIDATION_WORDS: Record<ValidationState, string> = {
    confirmed: "Confirmed",
    probable: "Probable",
    "needs-review": "Needs review",
    "false-positive": "False positive",
    fixed: "Fixed",
    "accepted-risk": "Accepted risk",
};

export const CATEGORY_WORDS: Record<FindingCategory, string> = {
    headers: "Security headers",
    cookies: "Cookies",
    tls: "HTTPS certificate",
    cors: "Cross-origin access (CORS)",
    "exposed-files": "Exposed files",
    "information-disclosure": "Information disclosure",
    configuration: "Configuration",
    other: "Other",
    // Additive (SCAN): what the external scanners report.
    injection: "Injection",
    xss: "Cross-site scripting",
    ssrf: "Server-side request forgery",
    "path-traversal": "Path traversal",
    "access-control": "Access control",
    secrets: "Exposed secrets",
    "ai-security": "AI application security",
};

export const STATE_WORDS: Record<string, string> = {
    QUEUED: "Waiting to start",
    DISCOVERING: "Discovering pages",
    SCANNING: "Checking",
    VALIDATING: "Validating findings",
    GENERATING_REPORT: "Writing the report",
    COMPLETED: "Completed",
    PARTIALLY_COMPLETED: "Partly completed",
    FAILED: "Failed",
    CANCELLED: "Cancelled",
};

/** What a passive assessment never does or sees. Printed in every report. */
export const LIMITATIONS: readonly string[] = [
    "This was a passive, read-only assessment: the ordinary requests a visitor's browser makes, plus a few requests for well-known files and folders that should not be public. No attack payloads were sent, no forms were submitted and nothing on the site was changed.",
    "It does not test for injection flaws, broken access control between users, business-logic problems, weak passwords, or anything that needs an attack to show itself.",
    "Pages behind a sign-in (unless the assessment used a saved sign-in, see coverage), pages not linked from the pages seen, the excluded paths and sensitive workflows were not inspected.",
    "No open findings in a category does not mean the application is secure in that respect: it means the checks that ran found nothing.",
    "No AI model judged these findings. Every finding comes from a fixed, written rule or was entered by a person.",
];

export type ReportFinding = SecurityFinding & { applicationName: string; history: FindingHistoryEntry[] };

export interface SecurityReportData {
    kind: "assessment" | "project";
    projectId: string;
    projectName: string;
    generatedAt: string;
    applications: Array<{ app: SecurityApplication; authorization: StoredAuthorization | null; authorizationNote: string }>;
    /** The assessment this report is about (assessment reports), or the latest per application (project reports). */
    assessments: SecurityAssessment[];
    risk: RiskOverview;
    bySeverity: Record<Severity, number>;
    byCategory: Array<{ category: FindingCategory; label: string; total: number; open: number }>;
    findings: ReportFinding[];
    /** More findings existed than the report lists. */
    truncated: boolean;
    topIssues: ReportFinding[];
    locations: Array<{ location: string; total: number; open: number; worst: Severity }>;
    retest: null | {
        originalId: string;
        fixed: Array<Pick<SecurityFinding, "id" | "title" | "severity" | "location">>;
        stillPresent: Array<Pick<SecurityFinding, "id" | "title" | "severity" | "location">>;
        notMarked: Array<Pick<SecurityFinding, "id" | "title" | "severity" | "location">>;
    };
    limitations: readonly string[];
}

const projectName = (db: Db, projectId: string) => String(db.get<{ name: string }>("SELECT name FROM projects WHERE id = ?", projectId)?.name ?? "Project");

/**
 * Gather a report. `{ assessmentId }`: what that assessment saw (with the evidence as observed then) and, for a retest, what it showed
 * as fixed. `{ projectId }`: every finding of the project, manual ones included. Returns undefined when the object does not exist.
 */
export function buildReport(db: Db, about: { assessmentId: string } | { projectId: string }, now = new Date()): SecurityReportData | undefined {
    const store = securityStoreFor(db);
    let projectId: string;
    let assessments: SecurityAssessment[];
    let found: Array<SecurityFinding & { checkId?: string | null }>;
    let truncated = false;
    let retest: SecurityReportData["retest"] = null;
    let apps: SecurityApplication[];

    if ("assessmentId" in about) {
        const a = store.getAssessment(about.assessmentId);
        if (!a) return undefined;
        projectId = a.projectId;
        assessments = [stripRun(a)];
        const app = store.getApplication(a.applicationId);
        apps = app ? [app] : [];
        // The evidence as this assessment observed it (a later assessment may have replaced the finding's latest evidence).
        const sightings = new Map(store.sightingsOf(a.id).map((s) => [s.findingId, s]));
        found = [];
        for (const [id, s] of sightings) {
            const f = store.getFinding(id);
            if (f && f.projectId === projectId) found.push({ ...f, evidence: s.evidence.length ? s.evidence : f.evidence, lastSeenAt: f.lastSeenAt });
        }
        if (a.retestOf) {
            const fixed: NonNullable<SecurityReportData["retest"]>["fixed"] = [];
            const notMarked: NonNullable<SecurityReportData["retest"]>["notMarked"] = [];
            for (const id of store.findingIdsSeenIn(a.retestOf)) {
                if (sightings.has(id)) continue;
                const f = store.getFinding(id);
                if (!f) continue;
                const h = store.findingHistory(id).filter((e) => e.assessmentId === a.id);
                if (h.some((e) => e.to === "fixed")) fixed.push(pick(f));
                else if (h.length) notMarked.push(pick(f));
            }
            const stillPresent = found.filter((f) => store.findingHistory(f.id).some((e) => e.assessmentId === a.id && /^Still present/.test(e.comment ?? ""))).map(pick);
            retest = { originalId: a.retestOf, fixed, stillPresent, notMarked };
        }
    } else {
        projectId = about.projectId;
        if (!db.get("SELECT 1 AS x FROM projects WHERE id = ?", projectId)) return undefined;
        apps = store.listApplications(projectId);
        assessments = apps.flatMap((app) => store.listAssessments({ applicationId: app.id, limit: 1 }).map(stripRun));
        const total = store.countFindings({ projectId });
        found = store.listFindings({ projectId, limit: REPORT_MAX_FINDINGS });
        truncated = total > found.length;
    }

    const appName = new Map(apps.map((a) => [a.id, a.name]));
    const rank = (s: Severity) => SEVERITIES.indexOf(s);
    const findings: ReportFinding[] = found
        .slice(0, REPORT_MAX_FINDINGS)
        .map(({ checkId: _c, ...f }) => ({ ...f, applicationName: appName.get(f.applicationId) ?? "Application", history: store.findingHistory(f.id) }))
        .sort((a, b) => Number(isOpenFinding(b)) - Number(isOpenFinding(a)) || rank(a.severity) - rank(b.severity) || a.title.localeCompare(b.title));
    if ("assessmentId" in about && found.length > REPORT_MAX_FINDINGS) truncated = true;

    const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const f of findings) bySeverity[f.severity]++;
    const byCategory = CATEGORIES.map((c) => ({ category: c, label: CATEGORY_WORDS[c], total: findings.filter((f) => f.category === c).length, open: findings.filter((f) => f.category === c && isOpenFinding(f)).length })).filter((c) => c.total > 0);
    const loc = new Map<string, { location: string; total: number; open: number; worst: Severity }>();
    for (const f of findings) {
        const l = loc.get(f.location) ?? { location: f.location, total: 0, open: 0, worst: f.severity };
        l.total++;
        if (isOpenFinding(f)) l.open++;
        if (rank(f.severity) < rank(l.worst)) l.worst = f.severity;
        loc.set(f.location, l);
    }
    const finished = assessments.some((a) => a.state === "COMPLETED" || a.state === "PARTIALLY_COMPLETED");
    return {
        kind: "assessmentId" in about ? "assessment" : "project",
        projectId,
        projectName: projectName(db, projectId),
        generatedAt: now.toISOString(),
        applications: apps.map((app) => {
            const auth = "assessmentId" in about ? store.getAuthorization(assessments[0]!.authorizationId) : store.listAuthorizations(app.id)[0];
            const state = store.authorizationState(app);
            return { app, authorization: auth ?? null, authorizationNote: "assessmentId" in about ? "The authorization this assessment ran under." : state.message };
        }),
        assessments,
        risk: assessRisk(findings, finished || findings.length > 0),
        bySeverity,
        byCategory,
        findings,
        truncated,
        topIssues: findings.filter(isOpenFinding).slice(0, 5),
        locations: [...loc.values()].sort((a, b) => b.open - a.open || rank(a.worst) - rank(b.worst) || a.location.localeCompare(b.location)),
        retest,
        limitations: LIMITATIONS,
    };
}

const pick = (f: SecurityFinding) => ({ id: f.id, title: f.title, severity: f.severity, location: f.location });
const stripRun = (a: SecurityAssessment & { cancelRequested?: boolean }): SecurityAssessment => {
    const { cancelRequested: _c, ...rest } = a;
    return rest;
};

// ── HTML ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const day = (iso: string | null | undefined) => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "not yet");
const clean = (s: string | null | undefined) => (s ? redactText(s, 2000) : "");

/** Round 20 (SIGN): sensitive workflows, the saved sign-in used (by account, never a value) and the uploaded API document. */
function scopeExtrasHtml(app: SecurityApplication): string {
    const parts: string[] = [];
    for (const w of app.sensitiveWorkflows ?? [])
        parts.push(`<br><b>Sensitive workflow, never requested:</b> ${esc(w.name)} (${w.pathPrefixes.map((p) => `<code>${esc(p)}</code>`).join(", ")})${w.note ? `: ${esc(clean(w.note))}` : ""}`);
    if (app.signInAccount) parts.push(`<br><b>Signed in with:</b> the saved sign-in of ${esc(signInLabel(app.signInAccount))} (no password typed, no form submitted, sign-out links not followed)`);
    if (app.apiDocument) parts.push(`<br><b>API document:</b> ${esc(app.apiDocument.fileName)}, ${app.apiDocument.operations} operations, of which ${app.apiDocument.requestable} GET without required parameters may be requested`);
    return parts.join("");
}

function evidenceHtml(ev: Evidence[]): string {
    if (!ev.length) return `<p class="meta">No evidence was recorded.</p>`;
    return `<dl class="ev">${ev.map((e) => `<dt>${esc(e.label)} <span class="meta">${esc(e.kind)}, ${esc(day(e.observedAt))}</span></dt><dd><pre>${esc(e.value)}</pre></dd>`).join("")}</dl>`;
}

function historyHtml(h: FindingHistoryEntry[]): string {
    if (!h.length) return "";
    return `<details><summary>Validation history (${h.length})</summary><ul>${h
        .map((e) => `<li>${esc(day(e.at))}, ${esc(e.actor)}: ${e.to && e.from !== e.to ? `${esc(e.from ? VALIDATION_WORDS[e.from] : "new")} to ${esc(VALIDATION_WORDS[e.to])}` : "note"}${e.comment ? `. ${esc(clean(e.comment))}` : ""}</li>`)
        .join("")}</ul></details>`;
}

function findingHtml(f: ReportFinding): string {
    return `<article class="card" id="f-${esc(f.id)}"><header><span class="sev sev-${f.severity}">${esc(cap(f.severity))}</span> <strong>${esc(f.title)}</strong></header>
<p class="meta">${esc(CATEGORY_WORDS[f.category])}, ${esc(f.confidence)} confidence, ${esc(VALIDATION_WORDS[f.validation])}, ${f.source === "manual" ? "entered by hand" : "found by the platform's checks"}. ${esc(f.applicationName)}.</p>
<p><b>Location:</b> <code>${esc(f.location)}</code></p>
<p>${esc(f.description)}</p>
<p><b>Why it matters:</b> ${esc(f.impact)}</p>
<p><b>How to fix:</b> ${esc(f.remediation)}</p>
${f.reproduction ? `<p><b>How to see it yourself:</b></p><pre class="steps">${esc(f.reproduction)}</pre>` : ""}
<p><b>Evidence</b> <span class="meta">(as received; secrets, cookie values and personal data are hidden)</span></p>${evidenceHtml(f.evidence)}
${f.aiNote ? `<aside class="ai"><b>AI suggestion, not evidence:</b> ${esc(f.aiNote)}</aside>` : ""}
<p class="meta">First seen ${esc(day(f.firstSeenAt))}, last seen ${esc(day(f.lastSeenAt))}.</p>${historyHtml(f.history)}</article>`;
}

const table = (head: string[], rows: string[][]) =>
    `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;

export function reportTitle(d: SecurityReportData): string {
    return d.kind === "assessment" ? `Security assessment report: ${d.applications[0]?.app.name ?? d.projectName}` : `Security assessment report: ${d.projectName}`;
}

export function renderReportHtml(d: SecurityReportData): string {
    const open = d.findings.filter(isOpenFinding);
    const sevLine = SEVERITIES.filter((s) => d.risk.openBySeverity[s] > 0).map((s) => `${d.risk.openBySeverity[s]} ${s}`).join(", ");
    const summary =
        d.findings.length === 0
            ? "No findings were recorded. That covers only what was inspected; see Coverage and limitations."
            : `${open.length} open finding${open.length === 1 ? "" : "s"}${sevLine ? ` (${sevLine})` : ""} of ${d.findings.length} in this report. ${d.risk.label}: ${d.risk.reason}`;
    const a0 = d.kind === "assessment" ? d.assessments[0] : undefined;
    const coverage = d.assessments
        .map((a) => {
            const app = d.applications.find((x) => x.app.id === a.applicationId)?.app;
            const c = a.coverage;
            return `<h3>${esc(app?.name ?? "Application")}, assessment of ${esc(day(a.createdAt))} (${esc(STATE_WORDS[a.state] ?? a.state)})</h3>${
                c
                    ? `<p>${c.pagesSeen} page${c.pagesSeen === 1 ? "" : "s"}, ${c.formsSeen} form${c.formsSeen === 1 ? "" : "s"} (looked at, never submitted) and ${c.apiCallsSeen} API call${c.apiCallsSeen === 1 ? "" : "s"} seen.</p>${c.notInspected.length ? `<p><b>Not inspected:</b></p><ul>${c.notInspected.map((n) => `<li>${esc(clean(n))}</li>`).join("")}</ul>` : ""}`
                    : `<p class="meta">No coverage was recorded for this assessment${a.state === "COMPLETED" ? "" : " (it did not finish)"}.</p>`
            }${a.error ? `<p class="meta">${esc(clean(a.error))}</p>` : ""}`;
        })
        .join("");

    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(reportTitle(d))}</title>
<style>
:root{--fg:#14191f;--mute:#56606c;--line:#dde2e8;--card:#f6f8f9;--accent:#0f766e;--bad:#b42318;--warn:#a15c07}
*{box-sizing:border-box}body{font:14.5px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--fg);margin:0 auto;padding:28px;max-width:920px;background:#fff}
h1{font-size:24px;margin:0 0 2px}h2{font-size:17px;margin:30px 0 10px;padding-bottom:4px;border-bottom:1px solid var(--line)}h3{font-size:15px;margin:16px 0 6px}
.meta{color:var(--mute);font-size:13px}.lead{font-size:16px;font-weight:600;margin:12px 0}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0}.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 14px;min-width:96px}.stat b{display:block;font-size:22px}
.card{border:1px solid var(--line);background:var(--card);border-radius:10px;padding:12px 16px;margin:12px 0;break-inside:avoid}.card p{margin:6px 0}
.sev{display:inline-block;font-size:12px;font-weight:700;border-radius:6px;padding:1px 8px;border:1px solid currentColor}.sev-critical,.sev-high{color:var(--bad)}.sev-medium{color:var(--warn)}.sev-low,.sev-info{color:var(--mute)}
.risk{border-left:4px solid var(--accent);padding:8px 14px;background:var(--card);border-radius:0 10px 10px 0}
pre{white-space:pre-wrap;word-break:break-word;font:12.5px/1.45 ui-monospace,"JetBrains Mono",Consolas,monospace;background:#fff;border:1px solid var(--line);border-radius:6px;padding:6px 8px;margin:4px 0}
code{font:12.5px ui-monospace,"JetBrains Mono",Consolas,monospace;word-break:break-all}
dl.ev{margin:4px 0}dl.ev dt{font-weight:600;margin-top:6px}dl.ev dd{margin:0}
.ai{border:1px dashed var(--mute);border-radius:6px;padding:6px 10px;margin:8px 0;font-size:13px}
table{border-collapse:collapse;width:100%;font-size:13.5px}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top}tr{break-inside:avoid}
ul{margin:6px 0;padding-left:20px}details summary{cursor:pointer;color:var(--mute);font-size:13px}
@media(max-width:600px){body{padding:14px}}
@media print{body{padding:0;max-width:none}h2{break-after:avoid}details{display:block}}
</style></head><body>
<h1>${esc(reportTitle(d))}</h1>
<p class="meta">${esc(d.projectName)}, generated ${esc(day(d.generatedAt))}${a0 ? `, assessment ${esc(a0.id)}` : ""}</p>

<h2>Executive summary</h2>
<p class="lead">${esc(summary)}</p>
<div class="stats">
<div class="stat"><b>${open.length}</b>open findings</div>
<div class="stat"><b>${d.risk.openBySeverity.critical + d.risk.openBySeverity.high}</b>open critical or high</div>
<div class="stat"><b>${open.filter((f) => f.validation !== "confirmed").length}</b>awaiting review</div>
<div class="stat"><b>${d.findings.filter((f) => f.validation === "fixed").length}</b>fixed</div>
</div>

<h2>Scope and authorization</h2>
${d.applications
    .map(({ app, authorization: au, authorizationNote }) => `<h3>${esc(app.name)}</h3>
<p><b>Target:</b> <code>${esc(app.targetUrl)}</code> (${esc(app.environment)})${app.scope.length ? `<br><b>Also in scope:</b> ${app.scope.map((s) => `<code>${esc(s)}</code>`).join(", ")}` : ""}${app.excludedPaths.length ? `<br><b>Never requested:</b> ${app.excludedPaths.map((s) => `<code>${esc(s)}</code>`).join(", ")}` : ""}${scopeExtrasHtml(app)}</p>
${
    au
        ? `<p><b>Authorized by</b> ${esc(au.approverName)} (${au.basis === "owner" ? "owner of the application" : "documented permission of the owner"}), recorded by ${esc(au.confirmedByName)} on ${esc(day(au.confirmedAt))}${au.documentReference ? `. Reference: ${esc(clean(au.documentReference))}` : ""}.${au.restrictions ? `<br><b>Restrictions:</b> ${esc(clean(au.restrictions))}` : ""}${au.revokedAt ? `<br><b>Revoked</b> on ${esc(day(au.revokedAt))}.` : ""}</p>`
        : `<p>No authorization is recorded.</p>`
}<p class="meta">${esc(authorizationNote)}</p>`)
    .join("")}

<h2>Risk overview</h2>
<p class="risk"><b>${esc(d.risk.label)}.</b> ${esc(d.risk.reason)}</p>
<p class="meta">How the level is decided:</p><ul>${d.risk.rules.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
${table(["Severity", "Open", "In this report"], SEVERITIES.map((s) => [esc(cap(s)), String(d.risk.openBySeverity[s]), String(d.bySeverity[s])]))}

${d.byCategory.length ? `<h2>Findings by category</h2>${table(["Category", "Open", "In this report"], d.byCategory.map((c) => [esc(c.label), String(c.open), String(c.total)]))}` : ""}

${d.topIssues.length ? `<h2>Top issues</h2><ol>${d.topIssues.map((f) => `<li><span class="sev sev-${f.severity}">${esc(cap(f.severity))}</span> <a href="#f-${esc(f.id)}">${esc(f.title)}</a> <span class="meta">${esc(f.location)}</span></li>`).join("")}</ol>` : ""}

${d.locations.length ? `<h2>Affected locations</h2>${table(["Location", "Open", "Findings", "Most serious"], d.locations.slice(0, 100).map((l) => [`<code>${esc(l.location)}</code>`, String(l.open), String(l.total), esc(cap(l.worst))]))}` : ""}

${d.retest ? `<h2>Retest results</h2><p>This assessment re-checked the open findings of assessment ${esc(d.retest.originalId)}.</p>
<p><b>Fixed (not seen again): ${d.retest.fixed.length}</b></p>${d.retest.fixed.length ? `<ul>${d.retest.fixed.map((f) => `<li>${esc(f.title)} <span class="meta">${esc(f.location)}</span></li>`).join("")}</ul>` : ""}
<p><b>Still present: ${d.retest.stillPresent.length}</b></p>${d.retest.stillPresent.length ? `<ul>${d.retest.stillPresent.map((f) => `<li>${esc(f.title)} <span class="meta">${esc(f.location)}</span></li>`).join("")}</ul>` : ""}
${d.retest.notMarked.length ? `<p><b>Not seen, but not marked fixed because the retest did not finish: ${d.retest.notMarked.length}</b></p><ul>${d.retest.notMarked.map((f) => `<li>${esc(f.title)} <span class="meta">${esc(f.location)}</span></li>`).join("")}</ul>` : ""}` : ""}

<h2>Findings (${d.findings.length}${d.truncated ? `, the ${REPORT_MAX_FINDINGS} most serious shown` : ""})</h2>
${d.findings.length ? d.findings.map(findingHtml).join("\n") : `<p>No findings.</p>`}

<h2>Coverage and limitations</h2>
${coverage || `<p class="meta">No assessment has run yet.</p>`}
<ul>${d.limitations.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>

<h2>Configuration and timestamps</h2>
${table(
    ["Application", "Environment", "Requests per second", "Assessment", "Started", "Finished", "State"],
    d.applications.map(({ app }) => {
        const a = d.assessments.find((x) => x.applicationId === app.id);
        return [esc(app.name), esc(app.environment), String(app.maxRequestsPerSecond), a ? `<code>${esc(a.id)}</code>${a.retestOf ? " (retest)" : ""}` : "none", esc(day(a?.startedAt)), esc(day(a?.finishedAt)), esc(a ? (STATE_WORDS[a.state] ?? a.state) : "")];
    }),
)}
<p class="meta">Generated by the AI Testing Platform's Security Assessment module on ${esc(day(d.generatedAt))}. Evidence is shown as received, with secrets, cookie values and personal data hidden.</p>
</body></html>
`;
}

// ── CSV ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** One cell: quoted, inner quotes doubled, and a leading = + - @ (or tab/CR) prefixed with ' so a spreadsheet keeps it as text. */
export function csvCell(v: unknown): string {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
}

export const CSV_COLUMNS = ["Id", "Application", "Title", "Severity", "Category", "Confidence", "Validation", "Location", "Source", "First seen", "Last seen", "Description", "Impact", "Remediation", "Reproduction", "Evidence"] as const;

/** Findings as CSV for Excel: UTF-8 with a byte-order mark, CRLF line ends. */
export function renderReportCsv(d: SecurityReportData): string {
    const rows = d.findings.map((f) => [
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
    return `﻿${[CSV_COLUMNS as readonly string[], ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** A file name without the project's spaces or symbols: security-report-<name>-<date>. */
export function reportFileBase(d: SecurityReportData): string {
    const name = (d.kind === "assessment" ? (d.applications[0]?.app.name ?? d.projectName) : d.projectName).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "project";
    return `security-report-${name}-${d.generatedAt.slice(0, 10)}`;
}
