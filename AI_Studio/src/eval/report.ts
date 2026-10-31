/** The Markdown summary written next to a run's JSON file (what the owner reads, and sends back). */
import type { MetricChange } from "./metrics.js";
import type { EvalRun } from "./run.js";

export interface ComparisonView {
    comparedWith: { id: string; startedAt: string };
    overall: MetricChange[];
    entries: Array<{ id: string; metrics: MetricChange[] }>;
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "n/a" : `${Math.round(v * 1000) / 10}%`);
const num = (v: number | null | undefined) => (v === null || v === undefined ? "n/a" : String(v));
const mins = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 6000) / 10} min`);
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ");

const METRIC_LABEL: Record<string, string> = {
    "rates.firstPass": "Passing on first run",
    "rates.stable": "Stable",
    "rates.flaky": "Flaky",
    "rates.coverage": "Coverage",
    "rates.duplicates": "Duplicates",
    "rates.testWrong": "Failing because the test is wrong",
    planned: "Tests planned",
    created: "Tests created",
    durationMs: "Time",
    aiCalls: "AI calls",
    cost: "Cost",
    safetyRefusals: "Safety refusals",
};
const show = (metric: string, v: number | null) => (v === null ? "n/a" : metric.startsWith("rates.") ? pct(v) : metric === "durationMs" ? mins(v) : String(v));

export function markdownSummary(run: EvalRun, comparison: ComparisonView | null): string {
    const o = run.overall;
    const lines: string[] = [];
    lines.push(`# Evaluation: ${run.corpus}`, "");
    lines.push(`${run.startedAt.slice(0, 16).replace("T", " ")} UTC, ${run.planOnly ? "plan only (nothing created or run)" : `${run.repeat} reruns of every created test`}, AI model ${run.platform.model}, ${run.platform.mode === "in-process" ? "platform started by the harness" : "running platform"}.`, "");
    lines.push("## Overall", "");
    lines.push("| Measure | Value |", "|---|---|");
    const rows: Array<[string, string]> = [
        ["Entries finished", `${o.entriesDone} of ${o.entries}`],
        ["Tests planned", num(o.planned)],
        ["Tests created", num(o.created)],
        ["Passing on first run", `${o.passedFirstRun} (${pct(o.rates.firstPass)})`],
        ["Stable (same verdict in every rerun)", `${o.stable} (${pct(o.rates.stable)})`],
        ["Flaky (mixed verdicts)", `${o.flaky} (${pct(o.rates.flaky)})`],
        ["Not run in some rerun", num(o.notRun)],
        ["Kept failing: product finding", num(o.failingProduct)],
        ["Kept failing: the test is wrong", num(o.failingTestWrong)],
        ["Kept failing: unclear", num(o.failingUnclear)],
        ["Duplicates", `${o.duplicates} (${pct(o.rates.duplicates)})`],
        ["Coverage (pages or screens a test visits, of those found)", `${o.covered} of ${o.found} (${pct(o.rates.coverage)})`],
        ["Time", mins(o.durationMs)],
        ["AI calls", num(o.aiCalls)],
        ["Tokens in / out", `${o.inputTokens} / ${o.outputTokens}`],
        ["Cost", o.cost === null ? "n/a (no price set in Settings, AI usage)" : String(o.cost)],
        ["Safety refusals (phone)", num(o.safetyRefusals)],
    ];
    for (const [k, v] of rows) lines.push(`| ${k} | ${cell(v)} |`);
    lines.push("");

    if (run.gates?.length) {
        lines.push("## Quality gates", "");
        for (const g of run.gates) lines.push(`- ${g.passed ? "Passed" : "Failed"}: ${g.message}`);
        lines.push("");
    }

    if (comparison) {
        lines.push(`## Compared with the previous run (${comparison.comparedWith.startedAt.slice(0, 16).replace("T", " ")} UTC)`, "");
        lines.push("| Measure | Before | Now | |", "|---|---|---|---|");
        for (const c of comparison.overall) lines.push(`| ${METRIC_LABEL[c.metric] ?? c.metric} | ${show(c.metric, c.previous)} | ${show(c.metric, c.current)} | ${c.change} |`);
        lines.push("");
    } else lines.push("This is the first run of this corpus kept by the platform, so there is nothing to compare with yet.", "");

    lines.push("## Entries", "");
    lines.push("| Entry | Status | Planned | Created | First run | Stable | Flaky | Coverage | Time | AI calls |", "|---|---|---|---|---|---|---|---|---|---|");
    for (const e of run.entries) {
        const m = e.metrics;
        if (!m) {
            lines.push(`| ${e.id} | ${e.status}: ${cell(e.reason ?? "")} | | | | | | | | |`);
            continue;
        }
        lines.push(`| ${e.id} | ${e.status} | ${m.planned} | ${m.created} | ${pct(e.rates?.firstPass)} | ${pct(e.rates?.stable)} | ${pct(e.rates?.flaky)} | ${m.covered} of ${m.found} ${m.coverageUnit} | ${mins(m.durationMs)} | ${m.aiCalls} |`);
    }
    lines.push("");

    for (const e of run.entries) {
        const notable = (e.tests ?? []).filter((t) => t.outcome !== "stable-pass" || t.duplicate);
        if (!notable.length) continue;
        lines.push(`### ${e.id}: tests to look at`, "");
        for (const t of notable.slice(0, 50)) {
            const what = t.outcome === "flaky" ? "flaky" : t.outcome === "not-run" ? "not run in every rerun" : t.outcome === "stable-fail" ? `keeps failing (${t.failure === "product" ? "product finding" : t.failure === "test-wrong" ? "the test is wrong" : "unclear"})` : "passes";
            lines.push(`- ${t.testId} ${cell(t.title)}: ${what}${t.duplicate ? ", repeats another test" : ""}${t.reason ? `. ${cell(t.reason)}` : ""}`);
        }
        lines.push("");
    }
    lines.push("Failure reasons are sorted by a heuristic on the stored reason (an element not found or a wait that timed out: the test is wrong; other content than expected, a server error or a check's finding: a product finding). Check a few by hand before trusting the split.", "");
    return lines.join("\n");
}
