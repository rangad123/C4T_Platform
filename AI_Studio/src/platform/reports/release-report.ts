/**
 * The sign-off page for a release: one self-contained HTML file that can be attached to a ticket or an email.
 *
 * Every piece of text that a person typed (release name, notes, case titles, steps, notes on results, names, comments) is
 * HTML-escaped. The page has no script and no external file. Nothing secret is ever part of a release.
 */
import { RESULT_LABEL } from "../../engine/manual/cases.js";
import type { ReleaseView } from "../manual-releases.js";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
const when = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

const DECISION = { approved: "Approved", rejected: "Rejected" } as const;
const AUDIT_WORD = { approved: "Approved", rejected: "Rejected", reopened: "Reopened" } as const;

export function releaseReportName(view: Pick<ReleaseView, "name">, projectName: string): string {
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return `signoff-${slug(projectName) || "project"}-${slug(view.name) || "release"}`;
}

export function renderReleaseHtml(projectName: string, v: ReleaseView, generatedAt = new Date()): string {
    const decision = v.decision ? DECISION[v.decision] : "Not signed yet";
    const a = v.automated;
    const r = v.manual.rollup;
    const list = (items: string[]) => (items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "");

    const areas = new Map<string, typeof v.manual.items>();
    for (const i of v.manual.items) areas.set(i.area, [...(areas.get(i.area) ?? []), i]);
    const manual = [...areas.entries()]
        .map(
            ([area, items]) => `<h3>${esc(area)}</h3>
<table><thead><tr><th>Check</th><th>Priority</th><th>Result</th><th>Note</th></tr></thead><tbody>
${items
    .map(
        (i) =>
            `<tr><td>${esc(i.title)}</td><td>${esc(i.priority)}</td><td class="res res-${esc(i.result)}">${esc(RESULT_LABEL[i.result])}${i.by ? `<br><span class="mute">${esc(i.by)}</span>` : ""}</td><td>${esc(i.note)}${i.issue ? `<br><span class="mute">Issue: ${esc(i.issue.externalId)}</span>` : ""}</td></tr>`,
    )
    .join("\n")}
</tbody></table>`,
        )
        .join("\n");

    const audit = v.audit
        .map((e) => `<li><strong>${esc(AUDIT_WORD[e.kind])}</strong> by ${esc(e.by)}, ${esc(when(e.at))}${e.override ? " <strong>(override)</strong>" : ""}${e.comment ? `<br>${esc(e.comment)}` : ""}</li>`)
        .join("");

    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(v.name)}, sign-off for ${esc(projectName)}</title>
<style>
:root{--fg:#1a1d23;--mute:#5d6572;--line:#dfe3ea;--card:#f7f8fa;--ok:#17703a;--bad:#b42318;--warn:#8c530a}
*{box-sizing:border-box}body{font:14.5px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--fg);margin:0 auto;padding:28px;max-width:900px;background:#fff}
h1{font-size:24px;margin:0 0 2px}h2{font-size:17px;margin:28px 0 10px;padding-bottom:4px;border-bottom:1px solid var(--line)}h3{font-size:15px;margin:18px 0 6px}
.mute{color:var(--mute);font-size:13px}.lead{font-size:16px;font-weight:600;margin:12px 0}
.decision{display:inline-block;font-weight:700;border:1px solid currentColor;border-radius:4px;padding:1px 10px}.decision-approved{color:var(--ok)}.decision-rejected{color:var(--bad)}.decision-open{color:var(--mute)}
.box{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:10px 16px;margin:10px 0}
table{border-collapse:collapse;width:100%;font-size:13.5px}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}tr{break-inside:avoid}
.res-failed{color:var(--bad);font-weight:700}.res-passed{color:var(--ok)}.res-blocked{color:var(--warn);font-weight:700}
ul{margin:6px 0;padding-left:20px}
@media(max-width:600px){body{padding:14px}}
@media print{body{padding:0;max-width:none}h2{break-after:avoid}}
</style></head><body>
<h1>${esc(v.name)}</h1>
<p class="mute">Release sign-off for ${esc(projectName)}, opened ${esc(day(v.createdAt))}</p>
<p><span class="decision decision-${v.decision ?? "open"}">${esc(decision)}</span>${v.signedBy && v.signedAt ? ` by ${esc(v.signedBy)}, ${esc(when(v.signedAt))}` : ""}</p>
<p class="lead">${esc(v.sentence)}</p>
${v.notes ? `<p>${esc(v.notes)}</p>` : ""}

<h2>Automated tests</h2>
<div class="box">
<p><strong>${esc(a.readiness.label)}</strong>${a.readiness.reasons.length ? "" : ", nothing needs attention"}</p>
${list(a.readiness.reasons.map((x) => x.text))}
<p class="mute">${a.tests.total} tests: ${a.tests.validated} passed, ${a.tests.needsAttention} need review, ${a.tests.couldNotValidate} could not be validated, ${a.tests.waiting} waiting.
${a.latestRun?.sentence ? ` Last run: ${a.latestRun.sentence}${a.latestRun.others ? ` ${a.latestRun.others}` : ""}` : a.latestRun?.passRate != null ? ` Last run: ${Math.round(a.latestRun.passRate)}% of the tests that ran passed.` : ""}
${a.findings.critical + a.findings.high + a.findings.medium + a.findings.low ? ` Findings: ${a.findings.critical} critical, ${a.findings.high} high, ${a.findings.medium} medium, ${a.findings.low} low.` : ""}
${a.flaky ? ` ${a.flaky} unreliable.` : ""}${a.apiBreakingChanges ? ` ${a.apiBreakingChanges} breaking API changes.` : ""}
State taken ${esc(when(a.takenAt))}${v.frozen ? " (frozen at sign-off)" : " (live)"}.</p>
${a.quarantine ? `<p><strong>${a.quarantine.count} quarantined ${a.quarantine.count === 1 ? "test is" : "tests are"} not counted above</strong></p>${list(a.quarantine.tests.map((t) => `${t.testKey} ${t.title}: ${t.reason} (until ${day(t.expiresAt)})`))}` : ""}
</div>

<h2>Manual checks</h2>
${r.total === 0 ? '<p class="mute">This project has no manual checks.</p>' : `<p class="mute">${r.passed} passed, ${r.failed} failed, ${r.blocked} blocked, ${r.skipped} skipped, ${r.notRun} not run.</p>\n${manual}`}

${v.signoff.blocking.length || v.signoff.warnings.length ? `<h2>${v.frozen ? "State at sign-off" : "What stands in the way"}</h2>${v.signoff.blocking.length ? `<p><strong>Blocking</strong></p>${list(v.signoff.blocking.map((b) => b.text))}` : ""}${v.signoff.warnings.length ? `<p><strong>Worth knowing</strong></p>${list(v.signoff.warnings.map((b) => b.text))}` : ""}` : ""}

<h2>Audit trail</h2>
${audit ? `<ul>${audit}</ul>` : '<p class="mute">No decision has been recorded yet.</p>'}
<p class="mute">Generated by the AI Testing Platform on ${esc(when(generatedAt.toISOString()))}.</p>
</body></html>
`;
}
