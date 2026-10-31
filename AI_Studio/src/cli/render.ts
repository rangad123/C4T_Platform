import { SEVERITIES } from "../engine/validation/severity.js";
import { buildJunit } from "../platform/reports/junit.js";
import { isQuarantinedFailure, SEVERITY_RANK, type CiReport, type CiTest } from "./model.js";

/** Hidden marker that identifies the one sticky pull-request comment of this tool. */
export const COMMENT_MARKER = "<!-- ai-testing-platform:ci-report -->";

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const oneLine = (s: string | undefined, n = 220) => {
    const t = (s ?? "").replace(/\s+/g, " ").trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const secs = (ms: number) => (ms < 950 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

const byWorst = (a: CiTest, b: CiTest) => SEVERITY_RANK[b.severity ?? "low"] - SEVERITY_RANK[a.severity ?? "low"] || a.testId.localeCompare(b.testId);
export const findings = (r: CiReport) => r.tests.filter((t) => t.outcome === "finding" && !t.quarantine).sort(byWorst);
export const failedTests = (r: CiReport) => r.tests.filter((t) => t.outcome === "failed" && !t.quarantine);
/** Quarantined tests that did not pass: still reported, never counted. */
export const quarantinedTests = (r: CiReport) => r.tests.filter(isQuarantinedFailure).sort(byWorst);

export function headline(r: CiReport): string {
    const s = r.summary;
    const parts = [`${s.total - s.notRun} tests run`, `${s.passed} passed`];
    if (s.findings) parts.push(`${s.findings} finding${s.findings === 1 ? "" : "s"}`);
    if (s.failedValidation) parts.push(`${s.failedValidation} could not be validated`);
    if (s.notRun) parts.push(`${s.notRun} not run`);
    if (s.quarantined) parts.push(`${s.quarantined} quarantined (not counted)`);
    return parts.join(" · ");
}

// ── console ──────────────────────────────────────────────────────────────────

export function renderConsole(r: CiReport, evidenceFiles: string[]): string {
    const L: string[] = [];
    L.push(`AI Testing Platform — ${r.gate.passed ? "PASSED" : "GATE FAILED"}`);
    L.push(`Target: ${r.target}   Mode: ${r.mode}   Took: ${secs(r.durationMs)}`);
    L.push(headline(r));
    const f = findings(r);
    if (f.length) {
        L.push("", "Findings (problems the tests found in the application):");
        for (const t of f.slice(0, 15)) {
            L.push(`  [${(t.severity ?? "medium").toUpperCase()}] ${t.testId} ${t.title}`);
            L.push(`      ${oneLine(t.reason, 300) || "No detail recorded."}${t.severityBasis ? ` (${t.severityBasis})` : ""}`);
        }
        if (f.length > 15) L.push(`  …and ${f.length - 15} more (see the report files).`);
    }
    const bad = failedTests(r);
    if (bad.length) {
        L.push("", "Tests that could not be validated:");
        for (const t of bad.slice(0, 15)) {
            L.push(`  [FAILED] ${t.testId} ${t.title}`);
            L.push(`      ${oneLine(t.reason, 300) || "No detail recorded."}`);
        }
        if (bad.length > 15) L.push(`  …and ${bad.length - 15} more (see the report files).`);
    }
    const held = quarantinedTests(r);
    if (held.length) {
        L.push("", "Quarantined (flaky tests that still run but do not count):");
        for (const t of held.slice(0, 15)) L.push(`  [QUARANTINED] ${t.testId} ${t.title}: ${t.quarantine!.reason}`);
        if (held.length > 15) L.push(`  …and ${held.length - 15} more (see the report files).`);
    }
    if (evidenceFiles.length) L.push("", `Evidence saved: ${evidenceFiles.length} file(s)`);
    L.push("");
    if (r.gate.passed) L.push(`Gate: passed (fail-on ${r.gate.failOn}${r.gate.failOnFailedValidation ? ", failed validations count" : ""}).`);
    else for (const reason of r.gate.reasons) L.push(`Gate failed: ${reason}`);
    return L.join("\n");
}

// ── Markdown (file, $GITHUB_STEP_SUMMARY, PR comment) ─────────────────────────

const cell = (s: string | undefined) => oneLine(s, 200).replace(/\|/g, "\\|");

export function renderMarkdown(r: CiReport, opts: { comment?: boolean } = {}): string {
    const s = r.summary;
    const M: string[] = [];
    if (opts.comment) M.push(COMMENT_MARKER);
    M.push(`## AI Testing Platform: ${r.gate.passed ? "passed" : "gate failed"}`, "");
    M.push(r.gate.passed ? `No blocking problems (fail-on **${r.gate.failOn}**).` : r.gate.reasons.map((x) => `- ${x}`).join("\n"), "");
    M.push("| Run | Passed | Findings | Could not validate | Not run |", "| ---: | ---: | ---: | ---: | ---: |", `| ${s.total - s.notRun} | ${s.passed} | ${s.findings} | ${s.failedValidation} | ${s.notRun} |`, "");
    const f = findings(r);
    if (f.length) {
        M.push("### Findings", "", "| Severity | Test | What was found |", "| --- | --- | --- |");
        for (const t of f.slice(0, 20)) M.push(`| ${cap(t.severity ?? "medium")} | ${t.link ? `[${t.testId}](${t.link})` : t.testId} ${cell(t.title)} | ${cell(t.reason)}${t.severityBasis ? ` _(${cell(t.severityBasis)})_` : ""} |`);
        if (f.length > 20) M.push("", `…and ${f.length - 20} more.`);
        M.push("");
    }
    const bad = failedTests(r);
    if (bad.length) {
        M.push("### Tests that could not be validated", "", "| Test | What happened |", "| --- | --- |");
        for (const t of bad.slice(0, 20)) M.push(`| ${t.link ? `[${t.testId}](${t.link})` : t.testId} ${cell(t.title)} | ${cell(t.reason)} |`);
        if (bad.length > 20) M.push("", `…and ${bad.length - 20} more.`);
        M.push("");
    }
    const held = quarantinedTests(r);
    if (held.length) {
        M.push("### Quarantined, not counted", "", "| Test | Reason |", "| --- | --- |");
        for (const t of held.slice(0, 20)) M.push(`| ${t.link ? `[${t.testId}](${t.link})` : t.testId} ${cell(t.title)} | ${cell(t.quarantine!.reason)} |`);
        if (held.length > 20) M.push("", `…and ${held.length - 20} more.`);
        M.push("");
    }
    M.push(`<sub>Target ${r.target} · ${r.mode} · ${secs(r.durationMs)} · ${r.generatedAt}</sub>`);
    return M.join("\n") + "\n";
}

// ── JSON ─────────────────────────────────────────────────────────────────────

/** The documented, versioned JSON report (docs/features/ci.md). Evidence bytes are never included. */
export function renderJson(r: CiReport): string {
    return JSON.stringify({ ...r, tests: r.tests.map((t) => ({ ...t, evidence: t.evidence.map(({ kind, file }) => ({ kind, ...(file ? { file } : {}) })) })) }, null, 2) + "\n";
}

// ── JUnit ────────────────────────────────────────────────────────────────────

export function renderJunit(r: CiReport): string {
    return buildJunit(
        r.project.name,
        r.tests.map((t) => ({
            suite: t.suite,
            testKey: t.testId,
            title: t.title,
            kind: t.kind,
            priority: t.priority,
            validationStatus: t.validation,
            validationReason: t.reason ?? null,
            last: t.outcome === "not_run" ? undefined : { status: t.outcome === "passed" || t.outcome === "finding" ? "passed" : "failed", durationMs: t.durationMs, error: t.reason ?? null },
            ...(t.quarantine ? { quarantine: { reason: t.quarantine.reason } } : {}),
        })),
    );
}

// ── SARIF 2.1.0 ──────────────────────────────────────────────────────────────

const RULES = {
    security: { name: "AuthenticationNotEnforced", text: "A protected endpoint answered without credentials", help: "A documented-as-protected endpoint returned a success response to a request that carried no credentials.", sec: "9.0" },
    "security-check": { name: "SecurityCheck", text: "A passive security check failed", help: "A built-in security check found a weakness, such as missing browser security headers, an exposed file or an expiring certificate.", sec: undefined },
    "page-health": { name: "PageHealth", text: "A page has script errors, failed requests or broken links", help: "A built-in page-health check found JavaScript errors, failed requests, broken links or insecure content on a page.", sec: undefined },
    "access-control": { name: "AccessControl", text: "A page may be open to someone who should not see it", help: "A built-in access-control check opened a page that only a more privileged account reached while browsing, as a less privileged account (or as a visitor), and its content was shown. This is a heuristic: confirm the page is meant to be restricted.", sec: undefined },
    "api-contract": { name: "ApiContract", text: "An API response differs from its documentation", help: "A response did not match the documented schema: a required field is missing, a value has the wrong type, or it falls outside the documented values. Clients written from the documentation will break.", sec: undefined },
    "ai-judgement": { name: "AiJudgement", text: "An AI reviewer thinks a screen does not look right", help: "A vision-capable model looked at a screenshot and reported a visible problem (overlapping or clipped elements, broken images, unreadable text). This is a judgement, not a measurement: open the attached screenshot and decide.", sec: undefined },
    "input-handling": { name: "InputHandling", text: "A form handles unusual input badly", help: "A built-in input check found a form that shows typed text as page markup (possible cross-site scripting), fails on unusual input, or breaks the page.", sec: undefined },
    performance: { name: "SlowPage", text: "A page loads slowly", help: "A built-in page-speed check measured a page (median of three cold loads) over its budget for server response, main content, layout stability, weight or request count.", sec: undefined },
    load: { name: "LoadCapacity", text: "An API endpoint struggles when several people use it at once", help: "A built-in load check sent GET requests as up to 10 users at once and the endpoint went over its budget for speed or errors (also when re-run at half the users), or started failing. It is a small check, not a capacity test.", sec: undefined },
    "server-error": { name: "ServerError", text: "The application answered with a server error", help: "A request received a 5xx response. A server error is never the correct answer.", sec: undefined },
    accessibility: { name: "AccessibilityViolation", text: "An accessibility check failed", help: "An automated accessibility audit (axe-core) found violations on a page.", sec: undefined },
    "visual-change": { name: "VisualChange", text: "A page differs from its approved screenshot", help: "A page no longer matches its approved baseline screenshot. If the change is intended, accept the new screenshot in the platform.", sec: undefined },
    "functional-defect": { name: "FunctionalDefect", text: "A test found a functional problem", help: "A test failed in a way that points at the application, not at the test.", sec: undefined },
    "app-crash": { name: "AppCrash", text: "The phone app crashed or stopped responding", help: "The phone's own log reported a crash (an exception or a fatal signal) or a freeze (ANR) of the app under test during the test. The finding has the stack trace and the steps.", sec: undefined },
} as const;

const LEVEL = { critical: "error", high: "error", medium: "warning", low: "note" } as const;

/**
 * SARIF 2.1.0 with one result per finding (a test in "needs review"). Findings concern a running
 * application, not a source file, so each result points at the test's entry in the specs file
 * (when one was used) — the place a developer would look to see what the test does.
 */
export function renderSarif(r: CiReport, opts: { specsFile?: string; specsText?: string; fingerprint: (s: string) => string }): string {
    const ids = Object.keys(RULES) as Array<keyof typeof RULES>;
    const used = ids.filter((id) => r.tests.some((t) => t.outcome === "finding" && t.category === id));
    const rules = used.map((id) => ({
        id: `ai-testing/${id}`,
        name: RULES[id].name,
        shortDescription: { text: RULES[id].text },
        fullDescription: { text: RULES[id].help },
        help: { text: RULES[id].help },
        defaultConfiguration: { level: id === "visual-change" ? "note" : "warning" },
        properties: { tags: id === "security" ? ["security", "ai-testing"] : ["ai-testing"], ...(RULES[id].sec ? { "security-severity": RULES[id].sec } : {}) },
    }));
    const lineOf = (testId: string): number => {
        const text = opts.specsText;
        if (!text) return 1;
        const at = text.search(new RegExp(`"testId"\\s*:\\s*"${testId.replace(/[^\w-]/g, "")}"`));
        return at < 0 ? 1 : text.slice(0, at).split("\n").length;
    };
    // Quarantined findings stay in the file as notes (never errors or warnings): nothing is hidden, nothing gates.
    const results = r.tests.filter((t) => t.outcome === "finding").sort(byWorst).map((t) => {
        const cat = t.category ?? "functional-defect";
        return {
            ruleId: `ai-testing/${cat}`,
            ruleIndex: used.indexOf(cat),
            level: t.quarantine ? "note" : LEVEL[t.severity ?? "medium"],
            message: { text: `${t.quarantine ? `(quarantined: ${oneLine(t.quarantine.reason, 200)}) ` : ""}${t.testId} ${t.title}: ${oneLine(t.reason, 500) || "needs review"}${t.severityBasis ? ` (${t.severityBasis})` : ""}` },
            locations: [
                {
                    physicalLocation: { artifactLocation: { uri: opts.specsFile ?? "ai-tests.json" }, region: { startLine: lineOf(t.testId) } },
                    logicalLocations: [{ name: t.testId, fullyQualifiedName: `${t.suite}/${t.testId}` }],
                },
            ],
            // Stable across runs so GitHub tracks one alert instead of opening a new one each time.
            partialFingerprints: { "aiTesting/v1": opts.fingerprint(`${t.testId}|${cat}|${oneLine(t.reason, 300)}`) },
            properties: { severity: t.severity, testId: t.testId, target: r.target, ...(t.link ? { link: t.link } : {}), ...(t.quarantine ? { quarantined: true } : {}) },
        };
    });
    const sarif = {
        $schema: "https://json.schemastore.org/sarif-2.1.0.json",
        version: "2.1.0",
        runs: [
            {
                tool: { driver: { name: "AI Testing Platform", version: r.tool.version, rules } },
                invocations: [{ executionSuccessful: true, endTimeUtc: r.generatedAt }],
                results,
            },
        ],
    };
    return JSON.stringify(sarif, null, 2) + "\n";
}

// ── HTML ─────────────────────────────────────────────────────────────────────

const esc = (s: string | undefined) => (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const MIME: Record<string, string> = { screenshot: "image/png", "visual-diff": "image/png", "visual-actual": "image/png", "vision-shot": "image/jpeg" };
const EVIDENCE_LABEL: Record<string, string> = { screenshot: "When it failed", "visual-diff": "Differences (in red)", "visual-actual": "New screenshot", "vision-shot": "What the AI looked at", video: "Recording", trace: "Detailed trace" };

/** One self-contained page: styles inline, screenshots embedded, no scripts, nothing fetched. */
export function renderHtml(r: CiReport): string {
    const s = r.summary;
    const section = (title: string, tests: CiTest[], kind: "finding" | "failed" | "quarantined") =>
        tests.length === 0
            ? ""
            : `<h2>${esc(title)} (${tests.length})</h2>${tests
                  .map((t) => {
                      const imgs = t.evidence
                          .filter((e) => e.data && MIME[e.kind])
                          .map((e) => `<figure><img alt="${esc(EVIDENCE_LABEL[e.kind])}" src="data:${MIME[e.kind]};base64,${e.data!.toString("base64")}"><figcaption>${esc(EVIDENCE_LABEL[e.kind])}</figcaption></figure>`)
                          .join("");
                      const files = t.evidence.filter((e) => e.file && !MIME[e.kind]).map((e) => `<li>${esc(EVIDENCE_LABEL[e.kind])}: <code>${esc(e.file)}</code></li>`).join("");
                      return `<article class="card ${kind}" id="${esc(t.testId)}"><header><span class="sev sev-${t.severity ?? "none"}">${kind === "finding" ? esc(cap(t.severity ?? "medium")) : kind === "quarantined" ? "Quarantined" : "Failed"}</span> <strong>${esc(t.testId)}</strong> ${esc(t.title)}</header>${t.quarantine ? `<p class="meta">Quarantine: ${esc(t.quarantine.reason)}. It still runs but does not count.</p>` : ""}<p class="reason">${esc(oneLine(t.reason, 1200)) || "No detail recorded."}</p><p class="meta">${esc(t.suite)} · ${esc(t.kind)} · ${esc(t.priority)} priority${t.severityBasis ? ` · ${esc(t.severityBasis)}` : ""}${t.failedStep ? ` · stopped at step ${t.failedStep.number}: ${esc(t.failedStep.title)}` : ""}${t.link ? ` · <a href="${esc(t.link)}">open in platform</a>` : ""}</p>${imgs ? `<div class="shots">${imgs}</div>` : ""}${files ? `<ul>${files}</ul>` : ""}</article>`;
                  })
                  .join("")}`;
    const rows = r.tests
        .map((t) => `<tr><td>${esc(t.testId)}</td><td>${esc(t.title)}</td><td>${esc(t.suite)}</td><td class="o-${t.outcome}">${{ passed: "Passed", finding: `Finding${t.severity ? ` (${t.severity})` : ""}`, failed: "Could not validate", not_run: "Not run" }[t.outcome]}${t.quarantine ? " (quarantined)" : ""}</td><td>${t.outcome === "not_run" ? "" : esc(secs(t.durationMs))}</td></tr>`)
        .join("");
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Testing Platform report</title>
<style>
:root{--bg:#fff;--fg:#1a1d23;--mute:#5d6572;--line:#dfe3ea;--card:#f7f8fa;--ok:#17703a;--bad:#b42318;--warn:#a15c07}
@media(prefers-color-scheme:dark){:root{--bg:#14161a;--fg:#e8eaee;--mute:#9aa3b0;--line:#2c313a;--card:#1b1e24;--ok:#4cc38a;--bad:#ff8a80;--warn:#f0b35a}}
body{font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:24px;max-width:980px;margin-inline:auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 10px}.mute,.meta{color:var(--mute);font-size:13px}
.banner{padding:12px 16px;border-radius:10px;border:1px solid var(--line);background:var(--card);margin:14px 0;font-weight:600}
.banner.ok{border-color:var(--ok);color:var(--ok)}.banner.bad{border-color:var(--bad);color:var(--bad)}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0}.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 14px}.stat b{display:block;font-size:20px}
.card{border:1px solid var(--line);background:var(--card);border-radius:10px;padding:12px 16px;margin:10px 0}.card header{font-size:15px}
.sev{display:inline-block;font-size:12px;font-weight:700;border-radius:6px;padding:1px 8px;border:1px solid currentColor;margin-right:6px}
.sev-critical,.sev-high,.sev-none{color:var(--bad)}.sev-medium{color:var(--warn)}.sev-low{color:var(--mute)}
.reason{white-space:pre-wrap;word-break:break-word;margin:8px 0}.shots{display:flex;gap:12px;flex-wrap:wrap}figure{margin:0}figure img{max-width:100%;max-height:320px;border:1px solid var(--line);border-radius:6px}figcaption{font-size:12px;color:var(--mute)}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top}
.o-passed{color:var(--ok)}.o-finding{color:var(--warn)}.o-failed{color:var(--bad)}.o-not_run{color:var(--mute)}
@media(max-width:600px){body{padding:14px}}
</style></head><body>
<h1>AI Testing Platform report</h1>
<p class="mute">${esc(r.project.name)} · ${esc(r.target)} · ${esc(r.mode)} · ${esc(secs(r.durationMs))} · ${esc(r.generatedAt)}</p>
<div class="banner ${r.gate.passed ? "ok" : "bad"}" role="status">${r.gate.passed ? "Passed: no blocking problems." : `Gate failed. ${esc(r.gate.reasons.join(" "))}`}</div>
<div class="stats"><div class="stat"><b>${s.total - s.notRun}</b>run</div><div class="stat"><b>${s.passed}</b>passed</div><div class="stat"><b>${s.findings}</b>findings</div><div class="stat"><b>${s.failedValidation}</b>could not validate</div><div class="stat"><b>${s.notRun}</b>not run</div></div>
${section("Findings", findings(r), "finding")}${section("Tests that could not be validated", failedTests(r), "failed")}${section("Quarantined, not counted", quarantinedTests(r), "quarantined")}
<h2>All tests</h2><table><thead><tr><th>ID</th><th>Test</th><th>Area</th><th>Result</th><th>Time</th></tr></thead><tbody>${rows}</tbody></table>
<p class="mute">Severity: ${SEVERITIES.map((v) => `${v} ${s.bySeverity[v]}`).join(" · ")}</p>
</body></html>
`;
}
