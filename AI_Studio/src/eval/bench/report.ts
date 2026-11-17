/** The benchmark result as a short Markdown report (written beside the JSON). Numbers only from the result itself. */
import type { EvalRun } from "../run.js";
import { observedOf, seriesOf, type Observed } from "./observed.js";
import type { Benchmark } from "./schema.js";

const pct = (v: number | null) => (v === null ? "n/a" : `${Math.round(v * 1000) / 10}%`);
const money = (v: number | null) => (v === null ? "not priced" : `$${v.toFixed(2)}`);
const dur = (ms: number | null) => (ms === null ? "n/a" : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

export function benchMarkdown(b: Benchmark, run: EvalRun): string {
    const m = b.metrics;
    const c = b.config;
    const out: string[] = [];
    out.push(`# Benchmark (${b.mode})${b.baseline ? ": baseline" : ""}`, "");
    out.push(`Started ${run.startedAt}, finished ${run.finishedAt}.`, "");
    out.push("| Measure | Value |", "|---|---|");
    out.push(`| Seeded defects | ${m.seeded} |`, `| Detected (confirmed by replay) | ${m.detected} |`, `| Missed | ${m.missed} |`, `| Detected only by a person's label | ${m.detectedLabeled} |`);
    out.push(`| Detection rate | ${pct(m.detectionRate)} |`, `| Reported findings | ${m.findings} |`, `| True positives | ${m.truePositives} |`, `| False positives | ${m.falsePositives} |`, `| Not reproduced | ${m.unreproduced} |`);
    out.push(`| Precision (all findings) | ${pct(m.precision)} |`, `| Precision (verified findings) | ${pct(m.precisionVerified)} |`, `| False-positive rate | ${pct(m.falsePositiveRate)} |`, `| Reproduction rate | ${pct(m.reproductionRate)} |`);
    out.push(`| Detection time | ${dur(m.detectionTimeMs)} |`, `| Execution time | ${dur(m.durationMs)} |`, `| AI calls | ${m.aiCalls} |`, `| Tokens in / out | ${m.inputTokens} / ${m.outputTokens} |`, `| Estimated AI cost | ${money(m.cost)} |`, `| Cost per confirmed defect | ${money(m.costPerConfirmedDefect)} |`);
    out.push(`| Tests generated | ${m.testsGenerated} |`, `| Workflows reached | ${m.workflowsCovered} of ${m.workflows} |`, `| Execution failures | ${m.executionFailures} |`, `| Flaky tests | ${m.flaky} |`, "");
    out.push("## Configuration", "");
    out.push(`- Engine commit ${c.engineCommit}${c.engineDirty ? " (with uncommitted engine changes)" : ""}`);
    out.push(`- Model ${c.model.provider} / ${c.model.model}; fast model ${c.model.fastModel ?? "none"}; planning model ${c.model.planningModel ?? "none"}; temperature ${c.model.temperature}`);
    out.push(`- Catalogue ${c.catalogueVersion}; apps ${c.apps.map((a) => `${a.id} ${a.version}`).join(", ")}`);
    out.push(`- Options ${Object.entries(c.options).map(([k, v]) => `${k}=${String(v)}`).join(", ")}`);
    out.push(`- Prompts ${c.prompts.map((p) => `${p.file.split("/").pop()} ${p.sha256.slice(0, 12)}`).join(", ")}`);
    out.push(`- Prices ${c.prices ? c.prices.map((p) => `${p.model} in ${p.inputPerMTok}/out ${p.outputPerMTok} per M`).join("; ") : "none given"}; approved budget ${c.approvedBudget === null ? "none (no paid model)" : `$${c.approvedBudget}`}`, "");
    for (const a of b.apps) {
        out.push(`## ${a.id}`, "");
        if (a.status !== "done") {
            out.push(`${a.status}: ${a.reason ?? ""}`, "");
            continue;
        }
        out.push("| Defect | Category | Workflow | Severity | Detected | By |", "|---|---|---|---|---|---|");
        for (const d of a.defects) out.push(`| ${d.id} | ${d.category} | ${d.workflow} | ${d.severity} | ${d.detected ? "yes" : d.labeledOnly ? "label only" : "no"} | ${d.findings.join(", ")} |`);
        out.push("", "| Finding | Title | Source | Category | Defects |", "|---|---|---|---|---|");
        for (const f of a.findings) out.push(`| ${f.testKey} | ${f.title.replace(/\|/g, "/")} | ${f.source} | ${f.category}${f.label ? ` (labelled ${f.label})` : ""} | ${f.defects.join(", ")} |`);
        out.push("");
    }
    out.push(observedMarkdown([{ name: run.startedAt, observed: observedOf(b) }]));
    if (b.notes.length) out.push("## Notes", "", ...b.notes.map((n) => `- ${n}`), "");
    return out.join("\n");
}

const ofText = (r: { n: number; of: number; rate: number | null }) => `${r.n} of ${r.of}${r.rate === null ? "" : ` (${pct(r.rate)})`}`;

/**
 * The "Observed vs captured" section (definitions in observed.ts): per trial the kinds, E1 and E2 with their denominators and every finding;
 * with more than one trial, E1 and E2 as median and range.
 */
export function observedMarkdown(trials: Array<{ name: string; observed: Observed }>): string {
    const out: string[] = ["## Observed vs captured", ""];
    for (const { name, observed: o } of trials) {
        if (trials.length > 1) out.push(`### ${name}`, "");
        out.push("| Measure | Value |", "|---|---|");
        out.push(`| Findings | ${o.rows.length} |`, `| Captured: the saved script fails on the seeded app | ${o.counts.captured} |`, `| Observed only: the author said defect, the replay passed | ${o.counts.observed_only} |`);
        out.push(`| False positive | ${o.counts.false_positive} |`, `| Not verified | ${o.counts.unverified} |`);
        out.push(`| E1 capture: author-time findings whose saved script fails on the seeded app | ${ofText(o.e1)} |`, `| E2 replay isolation: of those, scripts that pass on the clean app | ${ofText(o.e2)} |`);
        out.push(`| Clean replay not run (counted as not passing in E2) | ${o.cleanNotRun} |`, `| Author recorded: captured / observed only / not recorded | ${o.authorCapture.captured} / ${o.authorCapture.observed_only} / ${o.authorCapture.unrecorded} |`);
        out.push(`| Defects seen but not captured (person's labels) | ${o.observedDefects.length ? o.observedDefects.join(", ") : "none"}; ${o.observedUnlabelled} observed-only finding(s) unlabelled |`, "");
        out.push("| App | Finding | Source | Author recorded | Seeded | Clean | Observed vs captured | Label |", "|---|---|---|---|---|---|---|---|");
        for (const r of o.rows) out.push(`| ${r.app} | ${r.testKey} | ${r.source} | ${r.capture ?? "-"} | ${r.seeded} | ${r.clean ?? "-"} | ${r.kind.replace("_", " ")} | ${r.label ?? ""} |`);
        out.push("");
    }
    if (trials.length > 1) {
        for (const [k, pick] of [["E1", (o: Observed) => o.e1.rate], ["E2", (o: Observed) => o.e2.rate]] as const) {
            const s = seriesOf(trials.map((t) => pick(t.observed)));
            out.push(s.n ? `- ${k} over ${s.n} trials: median ${pct(s.median)}, range ${pct(s.min)}–${pct(s.max)}` : `- ${k}: no trial had anything to divide by`);
        }
        out.push("");
    }
    return out.join("\n");
}
