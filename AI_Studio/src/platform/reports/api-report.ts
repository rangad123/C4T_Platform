/**
 * The API Testing Agent's report as one self-contained HTML file (and, through pdf.ts, the same page as a PDF): the counts, every API
 * test with what it expected and what came back, why each failure failed, and the verified findings. Of one run, or of all its runs
 * (agent-outcomes/api.ts). Every text that came from the tested application, the AI or a person is HTML-escaped; no script, no image,
 * no external file.
 */
import type { ApiOutcome, ApiTestRow } from "../agent-outcomes/api.js";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const when = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
const RESULT = { pass: "PASS", fail: "FAIL", "not-run": "Not run" } as const;
const CONTRACT = { matches: "Contract matches", differs: "Contract differs", "not-checked": "Contract not checked" } as const;
const RUN_STATUS: Record<string, string> = { COMPLETED: "Completed", PARTIALLY_COMPLETED: "Partly completed", FAILED: "Stopped or failed" };

/** What a test checks, without the endpoint its title starts with (as the run page shows it). */
const what = (t: ApiTestRow) => (t.title.startsWith(`${t.method} ${t.path}: `) ? t.title.slice(t.method.length + t.path.length + 3) : t.title);
export const answeredText = (statuses: number[]) => (statuses.length ? `HTTP ${statuses.join(", ")}` : "No answer recorded");

export interface ApiReportInput {
    projectName: string;
    application: string | null;
    outcome: ApiOutcome;
    generatedAt: Date;
}

export function apiReportName(projectName: string, outcome: ApiOutcome, at: Date): string {
    const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
    return `api-report-${slug}${outcome.run ? `-run-${outcome.run.number}` : ""}-${at.toISOString().slice(0, 10)}`;
}

export function renderApiReportHtml({ projectName, application, outcome: o, generatedAt }: ApiReportInput): string {
    const scope = o.run ? `Run ${o.run.number}, started ${when(o.run.createdAt)} (${RUN_STATUS[o.run.status] ?? o.run.status})` : `All runs (${o.runs}): the newest run's tests of each endpoint`;
    const rows = o.tests
        .map(
            (t) =>
                `<tr><td>${esc(t.method)}</td><td>${esc(t.path)}<br><span class="mute">${esc(what(t))}</span></td><td>${t.expectedStatus ? `HTTP ${esc(t.expectedStatus)}` : "Any answer"}<br><span class="mute">${esc(CONTRACT[t.contract])}</span></td><td>${esc(answeredText(t.answered))}${t.contractNote ? `<br><span class="mute">${esc(t.contractNote)}</span>` : ""}</td><td class="res res-${t.result}">${RESULT[t.result]}</td></tr>`,
        )
        .join("\n");
    const failures = o.tests
        .filter((t) => t.evidence)
        .map((t) => {
            const e = t.evidence!;
            const query = e.request.query && Object.keys(e.request.query).length ? `?${new URLSearchParams(e.request.query).toString()}` : "";
            return `<article class="box"><p><strong>${esc(t.method)} ${esc(t.path)}</strong> <span class="mute">${esc(t.testKey)}</span></p><dl><dt>Request</dt><dd class="mono">${esc(e.request.method)} ${esc(e.request.path)}${esc(query)}</dd>${e.request.body !== null ? `<dt>Request body</dt><dd><pre class="mono">${esc(e.request.body)}</pre></dd>` : ""}<dt>Response</dt><dd class="mono">${esc(answeredText(e.response.statuses))}</dd><dt>Why it failed</dt><dd class="pre">${esc(e.response.reason || "No reason was recorded.")}</dd></dl></article>`;
        })
        .join("\n");
    const findings = o.findings
        .map((f) => `<article class="box"><p><strong>${esc(f.title)}</strong> <span class="mute">${esc(f.stateLabel)}${f.severity ? `, ${esc(f.severity)} severity` : ""}</span></p><dl><dt>Expected</dt><dd>${esc(f.expected)}</dd><dt>What happened</dt><dd>${esc(f.observed)}</dd>${f.reproduced.of ? `<dt>Repeated</dt><dd>Failed the same way ${f.reproduced.same} of ${f.reproduced.of} times</dd>` : ""}</dl></article>`)
        .join("\n");
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(projectName)}, API test report</title>
<style>
:root{--fg:#1a1d23;--mute:#5d6572;--line:#dfe3ea;--card:#f7f8fa;--ok:#17703a;--bad:#b42318}
*{box-sizing:border-box}body{font:14.5px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--fg);margin:0 auto;padding:28px;max-width:960px;background:#fff}
h1{font-size:24px;margin:0 0 2px}h2{font-size:17px;margin:28px 0 10px;padding-bottom:4px;border-bottom:1px solid var(--line)}
.mute{color:var(--mute);font-size:13px}.lead{font-size:16px;font-weight:600;margin:12px 0}.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}.pre{white-space:pre-wrap}
pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.box{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:10px 16px;margin:10px 0;break-inside:avoid}.box p{margin:0 0 6px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:0}dt{color:var(--mute)}dd{margin:0;overflow-wrap:anywhere}
table{border-collapse:collapse;width:100%;font-size:13.5px}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}tr{break-inside:avoid}
.res-fail{color:var(--bad);font-weight:700}.res-pass{color:var(--ok);font-weight:700}
@media(max-width:600px){body{padding:14px}dl{grid-template-columns:1fr}}
@media print{body{padding:0;max-width:none}h2{break-after:avoid}}
</style></head><body>
<h1>${esc(projectName)}</h1>
<p class="mute">API test report${application ? ` · ${esc(application)}` : ""} · ${esc(scope)}</p>
<p class="lead">${esc(o.headline)}</p>
<h2>API tests</h2>
${o.tests.length ? `<table><thead><tr><th>Method</th><th>Path</th><th>Expected</th><th>Actual</th><th>Result</th></tr></thead><tbody>\n${rows}\n</tbody></table>` : `<p>No API test was made in ${o.run ? "this run" : "its runs"}.</p>`}
${failures ? `<h2>Failures</h2>\n${failures}` : ""}
<h2>Verified findings</h2>
${findings || "<p>None. A failing API test is listed here once repeating it confirms the problem.</p>"}
<p class="mute">Generated by the AI Testing Platform on ${esc(when(generatedAt.toISOString()))}.</p>
</body></html>
`;
}
