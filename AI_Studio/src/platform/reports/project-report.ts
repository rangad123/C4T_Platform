/**
 * Shareable project report: one self-contained, print-friendly HTML page (and a PDF made from it) for people who
 * will not open the platform. Everything is computed from stored data when asked for; nothing is stored.
 *
 * Safety: every piece of text that came from the tested application, the AI or a user is HTML-escaped, evidence
 * images are inlined (size-capped), and no credentials, tokens or server file paths are ever included.
 */
import { complianceReport } from "../../engine/compliance/map.js";
import { assessProjectQuality } from "../../engine/quality/rules.js";
import { assessSeverity, SEVERITIES, type Severity } from "../../engine/validation/severity.js";
import { cleanReason } from "../../cli/model.js";
import { withExpandedSpecs } from "../block-store.js";
import { evidenceSentence } from "../evidence-read.js";
import { projectSlowest } from "../perf-store.js";
import type { Repo } from "../repo.js";
import { projectCompat } from "../routes/variants.js";
import type { ArtifactStore } from "../storage.js";
import { passRate } from "../../engine/summary/pass-rate.js";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Evidence screenshots: at most this many in the report, each at most this large (bytes). */
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 350_000;

interface Finding {
    key: string;
    title: string;
    area: string;
    severity: Severity;
    basis: string;
    reason: string;
    image?: string;
    /** One sentence on what the page did during the failed run (network calls, console), when it was recorded. */
    evidence?: string;
}

export interface ProjectReportData {
    projectName: string;
    application: string | null;
    generatedAt: string;
    total: number;
    counts: { validated: number; needsReview: number; failed: number; notRun: number };
    /** Passed tests as a percent of the tests that have a result (passed, finding or could not be validated); null when none has. */
    passRate: number | null;
    /** The tests that have a result: what the pass rate is a share of. */
    ran: number;
    bySeverity: Record<Severity, number>;
    findings: Finding[];
    failedTests: Array<{ key: string; title: string; area: string; reason: string; evidence?: string }>;
    areas: Array<{ name: string; total: number; validated: number; attention: number }>;
    compliance: Array<{ framework: string; covered: number; attention: number; gap: number; total: number }>;
    weak: Array<{ key: string; title: string; reason: string }>;
    compat: Array<{ key: string; title: string; failing: string[] }>;
    slowest: Array<{ key: string; title: string; value: string; over: boolean }>;
    trend: Array<{ at: string; passRate: number }>;
    inventory: Array<{ key: string; title: string; area: string; status: string }>;
}

const STATUS_TEXT: Record<string, string> = { VALIDATED: "Passed", NEEDS_REVIEW: "Needs review", FAILED_VALIDATION: "Could not be validated", PENDING: "Not run yet", VALIDATING: "Running" };

function seconds(ms: number): string {
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

export async function gatherReport(repo: Repo, store: ArtifactStore, projectId: string, now = new Date()): Promise<ProjectReportData | undefined> {
    const project = repo.getProject(projectId);
    if (!project) return undefined;
    // Judged on the steps a test really has, reusable steps included.
    const tests = withExpandedSpecs(repo.db, projectId, repo.listTests(projectId));
    const quality = assessProjectQuality(tests);
    const compat = projectCompat(repo, projectId);

    const counts = { validated: 0, needsReview: 0, failed: 0, notRun: 0 };
    const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    const findings: Finding[] = [];
    const failedTests: ProjectReportData["failedTests"] = [];
    const areas = new Map<string, { name: string; total: number; validated: number; attention: number }>();

    for (const t of tests) {
        const a = areas.get(t.suite) ?? { name: t.suite, total: 0, validated: 0, attention: 0 };
        a.total++;
        if (t.validationStatus === "VALIDATED") (counts.validated++, a.validated++);
        else if (t.validationStatus === "NEEDS_REVIEW") (counts.needsReview++, a.attention++);
        else if (t.validationStatus === "FAILED_VALIDATION") (counts.failed++, a.attention++);
        else counts.notRun++;
        areas.set(t.suite, a);

        if (t.validationStatus === "NEEDS_REVIEW") {
            const sev = assessSeverity(t.spec, t.validationStatus, t.validationReason) ?? { severity: "medium" as Severity, basis: "defect found" };
            bySeverity[sev.severity]++;
            findings.push({ key: t.testKey, title: t.title, area: t.suite, severity: sev.severity, basis: sev.basis, reason: cleanReason(t.validationReason) ?? "" });
        } else if (t.validationStatus === "FAILED_VALIDATION") {
            failedTests.push({ key: t.testKey, title: t.title, area: t.suite, reason: cleanReason(t.validationReason) ?? "" });
        }
    }
    findings.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.key.localeCompare(b.key));

    // Evidence for the most serious findings: the latest run's failure screenshot, if small enough.
    let images = 0;
    for (const f of findings.slice(0, 10)) {
        if (images >= MAX_IMAGES) break;
        const test = tests.find((t) => t.testKey === f.key)!;
        const latest = repo.listExecutions(test.id)[0] as { artifacts: Array<{ kind: string; path: string }> } | undefined;
        const shot = latest?.artifacts.find((x) => x.kind === "visual-diff") ?? latest?.artifacts.find((x) => x.kind === "screenshot");
        if (!shot) continue;
        try {
            const info = await store.head(shot.path);
            if (!info) throw new Error("gone");
            if (info.size > MAX_IMAGE_BYTES) continue;
            f.image = `data:image/png;base64,${(await store.getBytes(shot.path)).toString("base64")}`;
            images++;
        } catch {
            /* evidence vanished: report without it */
        }
    }

    // What the page did when it failed (the summary only; the tables stay on the test page).
    for (const f of findings.slice(0, 15)) f.evidence = await evidenceSentence(repo, store, tests.find((t) => t.testKey === f.key)!.id);
    for (const f of failedTests.slice(0, 15)) f.evidence = await evidenceSentence(repo, store, tests.find((t) => t.testKey === f.key)!.id);

    const mapped = complianceReport(tests.map((t) => ({ id: t.id, testKey: t.testKey, spec: t.spec, validationStatus: t.validationStatus })));
    const slowest = (await projectSlowest(repo.db.sql, projectId)).map((r) => ({
        key: r.testKey,
        title: r.title,
        value: r.unit === "ms" ? seconds(r.value) : String(r.value),
        over: r.budget !== null && r.value > r.budget,
    }));
    const trend = repo.db
        .all<{ finished_at: string; pass_rate: number }>("SELECT finished_at, pass_rate FROM run_summaries WHERE project_id = ? AND pass_rate IS NOT NULL ORDER BY finished_at DESC LIMIT 12", projectId)
        .reverse()
        .map((r) => ({ at: r.finished_at, passRate: r.pass_rate }));

    const run = counts.validated + counts.needsReview + counts.failed;
    const app = repo.getLatestApplicationPublic(projectId);
    return {
        projectName: String(project.name),
        application: app ? String(app.url).replace(/^android-app:\/\//, "Android app: ").replace(/^windows-app:\/\/desktop$/, "Windows desktop application") : null,
        generatedAt: now.toISOString(),
        total: tests.length,
        counts,
        passRate: passRate(counts.validated, run) === null ? null : Math.round(passRate(counts.validated, run)!),
        ran: run,
        bySeverity,
        findings,
        failedTests,
        areas: [...areas.values()].sort((a, b) => b.attention - a.attention || a.name.localeCompare(b.name)),
        compliance: mapped.map((f) => ({ framework: f.framework, ...f.summary })),
        weak: tests.filter((t) => quality.get(t.id)?.level === "weak").map((t) => ({ key: t.testKey, title: t.title, reason: quality.get(t.id)!.reasons[0] ?? "" })),
        compat: tests.flatMap((t) => {
            const c = compat(t.id);
            return c?.failing.length ? [{ key: t.testKey, title: t.title, failing: c.failing }] : [];
        }),
        slowest,
        trend,
        inventory: tests.map((t) => ({ key: t.testKey, title: t.title, area: t.suite, status: STATUS_TEXT[t.validationStatus] ?? t.validationStatus })),
    };
}

function trendSvg(points: ProjectReportData["trend"]): string {
    if (points.length < 2) return "";
    const w = 360;
    const h = 70;
    const xy = points.map((p, i) => `${(6 + (i / (points.length - 1)) * (w - 12)).toFixed(1)},${(h - 6 - (p.passRate / 100) * (h - 12)).toFixed(1)}`).join(" ");
    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Pass rate over the last ${points.length} runs, from ${Math.round(points[0]!.passRate)}% to ${Math.round(points.at(-1)!.passRate)}%"><polyline points="${xy}" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
}

export function renderReportHtml(d: ProjectReportData): string {
    const sev = SEVERITIES.filter((s) => d.bySeverity[s] > 0).map((s) => `${d.bySeverity[s]} ${s}`).join(", ");
    const headline =
        d.total === 0
            ? "There are no tests yet."
            : d.counts.needsReview + d.counts.failed === 0 && d.counts.validated > 0
              ? `All ${d.counts.validated} tests that ran passed.`
              : `${d.counts.needsReview} finding${d.counts.needsReview === 1 ? "" : "s"}${sev ? ` (${sev})` : ""} need${d.counts.needsReview === 1 ? "s" : ""} attention${d.counts.failed ? `, and ${d.counts.failed} test${d.counts.failed === 1 ? "" : "s"} could not be validated` : ""}.`;
    const list = (items: string[]) => (items.length ? `<ul>${items.join("")}</ul>` : "");
    const table = (head: string[], rows: string[][]) =>
        `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;

    const findings = d.findings
        .slice(0, 15)
        .map(
            (f) => `<article class="card"><header><span class="sev sev-${f.severity}">${esc(cap(f.severity))}</span> <strong>${esc(f.title)}</strong> <span class="meta">${esc(f.key)} · ${esc(f.area)}</span></header>
<p class="meta">${esc(f.basis)}</p><p class="reason">${esc(f.reason)}</p>${f.evidence ? `<p class="meta">What the page did: ${esc(f.evidence)}</p>` : ""}${f.image ? `<figure><img alt="Screenshot of the problem" src="${f.image}"></figure>` : ""}</article>`,
        )
        .join("");

    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(d.projectName)} — test report</title>
<style>
:root{--fg:#1a1d23;--mute:#5d6572;--line:#dfe3ea;--card:#f7f8fa;--ok:#17703a;--bad:#b42318;--warn:#a15c07}
*{box-sizing:border-box}body{font:14.5px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--fg);margin:0 auto;padding:28px;max-width:900px;background:#fff}
h1{font-size:24px;margin:0 0 2px}h2{font-size:17px;margin:30px 0 10px;padding-bottom:4px;border-bottom:1px solid var(--line)}
.meta,.mute{color:var(--mute);font-size:13px}.lead{font-size:16px;font-weight:600;margin:12px 0}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0}.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 14px;min-width:96px}.stat b{display:block;font-size:22px}
.card{border:1px solid var(--line);background:var(--card);border-radius:10px;padding:12px 16px;margin:10px 0;break-inside:avoid}
.sev{display:inline-block;font-size:12px;font-weight:700;border-radius:6px;padding:1px 8px;border:1px solid currentColor}.sev-critical,.sev-high{color:var(--bad)}.sev-medium{color:var(--warn)}.sev-low{color:var(--mute)}
.reason{white-space:pre-wrap;word-break:break-word;margin:6px 0}figure{margin:8px 0}figure img{max-width:100%;max-height:300px;border:1px solid var(--line);border-radius:6px}
table{border-collapse:collapse;width:100%;font-size:13.5px}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top}tr{break-inside:avoid}
ul{margin:6px 0;padding-left:20px}svg{color:var(--ok);max-width:100%;height:auto}
@media(max-width:600px){body{padding:14px}}
@media print{body{padding:0;max-width:none}h2{break-after:avoid}}
</style></head><body>
<h1>${esc(d.projectName)}</h1>
<p class="meta">Test report${d.application ? ` · ${esc(d.application)}` : ""} · ${esc(d.generatedAt.slice(0, 10))}</p>
<p class="lead">${esc(headline)}</p>
<div class="stats">
<div class="stat"><b>${d.total}</b>tests</div>
<div class="stat"><b>${d.passRate === null ? "–" : `${d.passRate}%`}</b>passed, of the ${d.ran} ${d.ran === 1 ? "test" : "tests"} with a result</div>
<div class="stat"><b>${d.counts.needsReview}</b>findings</div>
<div class="stat"><b>${d.counts.failed}</b>not validated</div>
<div class="stat"><b>${d.counts.notRun}</b>not run yet</div>
</div>
${d.counts.notRun ? `<p class="meta">The pass rate counts only tests that have a result (passed, found a problem, or could not be validated). ${d.counts.notRun} ${d.counts.notRun === 1 ? "test has" : "tests have"} not been run yet and ${d.counts.notRun === 1 ? "is" : "are"} left out.</p>` : ""}
${d.trend.length > 1 ? `<h2>Pass rate over recent runs</h2>${trendSvg(d.trend)}` : ""}
${d.findings.length ? `<h2>What needs attention (${d.findings.length}${d.findings.length > 15 ? ", most serious 15 shown" : ""})</h2>${findings}` : ""}
${d.failedTests.length ? `<h2>Tests that could not be validated (${d.failedTests.length})</h2>${list(d.failedTests.slice(0, 15).map((t) => `<li><strong>${esc(t.title)}</strong> <span class="meta">${esc(t.key)} · ${esc(t.area)}</span><br><span class="reason">${esc(t.reason)}</span>${t.evidence ? `<br><span class="meta">What the page did: ${esc(t.evidence)}</span>` : ""}</li>`))}` : ""}
${d.areas.length ? `<h2>Coverage by area</h2>${table(["Area", "Tests", "Passed", "Need attention"], d.areas.map((a) => [esc(a.name), String(a.total), String(a.validated), String(a.attention)]))}` : ""}
${d.compliance.length && d.total ? `<h2>Security control coverage</h2><p class="meta">An indicative mapping of tests to control topics, not a compliance assessment.</p>${table(["Framework", "Covered", "Need attention", "No tests yet"], d.compliance.map((c) => [esc(c.framework), `${c.covered} of ${c.total}`, String(c.attention), String(c.gap)]))}` : ""}
${d.compat.length ? `<h2>Browser and screen-size differences (${d.compat.length})</h2>${list(d.compat.map((c) => `<li>${esc(c.title)} <span class="meta">${esc(c.key)}</span> — fails on ${esc(c.failing.join(", "))}</li>`))}` : ""}
${d.slowest.length ? `<h2>Slowest pages</h2>${list(d.slowest.map((s) => `<li>${esc(s.title)} — main content after <strong>${esc(s.value)}</strong>${s.over ? " (over budget)" : ""}</li>`))}` : ""}
${d.weak.length ? `<h2>Tests that check very little (${d.weak.length})</h2><p class="meta">These pass even if the feature breaks; they need a stronger check.</p>${list(d.weak.slice(0, 20).map((w) => `<li>${esc(w.title)} <span class="meta">${esc(w.key)}</span> — ${esc(w.reason)}</li>`))}` : ""}
${d.inventory.length ? `<h2>All tests (${d.inventory.length})</h2>${table(["ID", "Test", "Area", "Result"], d.inventory.map((t) => [esc(t.key), esc(t.title), esc(t.area), esc(t.status)]))}` : ""}
<p class="mute">Generated by the AI Testing Platform on ${esc(d.generatedAt.slice(0, 19).replace("T", " "))} UTC.</p>
</body></html>
`;
}
