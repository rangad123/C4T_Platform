/**
 * The understanding benchmark's report: for one input configuration (never url and full together), per app, the median and range of
 * each criterion over the trials of each side (Baseline-U and candidate), a verdict for the candidate, and error and work counts per run.
 *
 * Verdicts: "pass" when the whole range meets the target, "fail" when none of it does, "inconclusive" when the range overlaps the target,
 * a value is missing, or the series is incomplete; "reported" for a criterion with no target in this configuration. A series is complete
 * only when every expected trial of every side ran to completion; otherwise no criterion passes. Fewer than MIN_TRIALS trials per side is a
 * smoke series: allowed, said first, and no criterion passes or fails. A criterion with nothing to measure (no rules, a rerun not done) is
 * inconclusive, never a pass. When some trials measured a criterion and others could not, the measured trials' median and range are
 * shown with "n of N measured", and the criterion stays inconclusive while fewer than MIN_TRIALS trials measured it.
 *
 * U3 is judged on recall and precision together: the U3 row shows recall's median and range, the U3-precision row precision's, and the
 * U3 verdict passes only when both pass, fails when either fails, and is inconclusive otherwise.
 *
 * U8 counts the AI calls of each analysis by purpose: reading the application (the analysis: pages, requirements, documents), planning
 * the exploration, and everything else; the run table keeps each trial's total.
 */
import type { UnderstandingScore } from "./score.js";

export type Inputs = "url" | "full";
/** Trials per side a verdict needs (median and range of at least five runs). */
export const MIN_TRIALS = 5;
export type Engine = "baseline" | "candidate";
export type Verdict = "pass" | "fail" | "inconclusive" | "reported";

export interface TrialResult {
    app: string;
    inputs: Inputs;
    engine: Engine;
    /** 1-based position in the series. */
    trial: number;
    status: "completed" | "failed";
    error?: string;
    score?: UnderstandingScore;
    /** Work and errors of the analysis: AI calls made (and by purpose, when the run recorded it), AI calls that failed, pages visited. */
    counts: { aiCalls: number; failedCalls: number; pages: number; byPurpose?: CallsByPurpose };
}

/** AI calls of one analysis by purpose: reading the application, planning the exploration, everything else. */
export interface CallsByPurpose {
    analysis: number;
    planning: number;
    other: number;
}

export interface Stat {
    n: number;
    median: number;
    min: number;
    max: number;
}

export function stat(values: number[]): Stat {
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    return { n: s.length, median, min: s[0], max: s[s.length - 1] };
}

export function verdictAtLeast(values: number[], threshold: number): Verdict {
    const { min, max } = stat(values);
    return min >= threshold ? "pass" : max < threshold ? "fail" : "inconclusive";
}

export function verdictAtMost(values: number[], threshold: number): Verdict {
    const { min, max } = stat(values);
    return max <= threshold ? "pass" : min > threshold ? "fail" : "inconclusive";
}

/** Candidate above the baseline: pass when its whole range is above the baseline's, fail when it is wholly at or below it. */
function verdictAbove(candidate: number[], baseline: number[]): Verdict {
    const c = stat(candidate);
    const b = stat(baseline);
    return c.min > b.max ? "pass" : c.max <= b.min ? "fail" : "inconclusive";
}

const worst = (vs: Verdict[]): Verdict => (vs.includes("fail") ? "fail" : vs.includes("inconclusive") ? "inconclusive" : "pass");

export interface CriterionRow {
    id: string;
    name: string;
    target: string;
    candidate: Stat | null;
    baseline: Stat | null;
    verdict: Verdict;
    why: string;
}

export interface RunRow {
    engine: Engine;
    trial: number;
    status: "completed" | "failed";
    aiCalls: number;
    failedCalls: number;
    pages: number;
    error?: string;
}

/** How a full series gave the requirements document: one record per numbered requirement (the default), or the whole document as one. */
export type DocVariant = "records" | "whole";

export interface UnderstandingReport {
    inputs: Inputs;
    /** Only for a full series. */
    doc?: DocVariant;
    repeat: number;
    engines: Engine[];
    complete: boolean;
    /** Fewer than MIN_TRIALS trials per side: no criterion passes or fails. */
    smoke: boolean;
    problems: string[];
    trialsExpected: number;
    trialsRan: number;
    apps: Array<{ app: string; criteria: CriterionRow[]; runs: RunRow[] }>;
}

interface Criterion {
    id: string;
    name: string;
    /** The value per trial; null when the trial cannot give one. */
    value: (s: UnderstandingScore) => number | null;
    target: string;
    judge?: (candidate: number[], baseline: number[] | null) => { verdict: Verdict; why: string };
    /** Why a trial cannot be judged even when it has a value (e.g. reviews missing). */
    blocker?: (s: UnderstandingScore) => string | null;
}

const atLeast = (t: number) => (c: number[]) => ({ verdict: verdictAtLeast(c, t), why: "" });
const atMost = (t: number) => (c: number[]) => ({ verdict: verdictAtMost(c, t), why: "" });

function criteria(inputs: Inputs): Criterion[] {
    const url = inputs === "url";
    return [
        { id: "U1", name: "Screen recall", value: (s) => s.screens.value, ...(url ? { target: "≥ 0.9", judge: atLeast(0.9) } : { target: "reported" }) },
        { id: "U2", name: "Documented endpoint recall", value: (s) => s.endpoints.value, ...(url ? { target: "reported" } : { target: "= 1", judge: atLeast(1) }) },
        { id: "U2-extra", name: "Documented endpoints the document lacks", value: (s) => s.endpoints.documentedNotInDocument.length, ...(url ? { target: "reported" } : { target: "= 0", judge: atMost(0) }) },
        {
            id: "U3",
            name: "Workflow recall",
            value: (s) => s.workflows.value,
            ...(url
                ? {
                      target: "≥ 0.8 and above Baseline-U",
                      judge: (c: number[], b: number[] | null) =>
                          b === null || b.length === 0
                              ? { verdict: "inconclusive" as Verdict, why: "no Baseline-U series to compare with" }
                              : { verdict: worst([verdictAtLeast(c, 0.8), verdictAbove(c, b)]), why: "" },
                  }
                : { target: "= 1", judge: atLeast(1) }),
        },
        {
            id: "U3-precision",
            name: "Workflow precision: model workflows wholly inside one answer-key workflow",
            // Trials recorded before U3-precision existed have no value.
            value: (s) => s.workflowPrecision?.value ?? null,
            target: "≥ 0.8",
            judge: atLeast(0.8),
            // Workflows awaiting a recorded link count as not genuine: a value already at the target passes, a lower one cannot fail yet.
            blocker: (s) => (s.workflowPrecision?.needsJudgement.length && (s.workflowPrecision.value ?? 0) < 0.8 ? `${s.workflowPrecision.needsJudgement.length} workflow${s.workflowPrecision.needsJudgement.length === 1 ? "" : "s"} with neither page nor endpoint await${s.workflowPrecision.needsJudgement.length === 1 ? "s" : ""} a recorded workflow link` : null),
        },
        url
            ? { id: "U4", name: "Defect rules present with evidence", value: (s) => s.defectRules.any.value, target: "reported" }
            : { id: "U4", name: "Defect rules as explicit rules citing the requirement line", value: (s) => s.defectRules.explicitCiting.value, target: "≥ 0.8", judge: atLeast(0.8) },
        // No rules: nothing to measure, never a pass.
        { id: "U5", name: "Rules with complete provenance", value: (s) => s.provenance.value, target: "= 1", judge: atLeast(1) },
        { id: "U5-confirmed", name: "Rules confirmed without a person", value: (s) => (s.provenance.total ? s.provenance.confirmedWithoutPerson.length : null), target: "= 0", judge: atMost(0) },
        { id: "U5-observed", name: "Rules sourced from observed behaviour", value: (s) => (s.provenance.total ? s.provenance.fromObserved.length : null), target: "= 0", judge: atMost(0) },
        {
            id: "U6",
            name: "Explicit rules contradicting their source",
            value: (s) => (s.wrongRules.explicit.total === 0 ? null : s.wrongRules.explicit.rate),
            target: "≤ 0.05",
            judge: atMost(0.05),
            blocker: (s) => (s.wrongRules.explicit.unreviewed.length ? `${s.wrongRules.explicit.unreviewed.length} explicit rules not reviewed` : null),
        },
        { id: "U6-inferred", name: "Inferred rules contradicting the answer key", value: (s) => s.wrongRules.inferred.rate, target: "reported" },
        {
            id: "U7",
            name: "Incremental: decisions carried, no-change and one-change reruns",
            value: (s) => {
                // All three parts measured, or nothing to judge: decisions carried, the no-change rerun, the one-change rerun.
                const inc = s.incremental;
                if (!inc || inc.decisions.value === null || !inc.noChange || !inc.oneChanged) return null;
                return inc.decisions.value === 1 && (inc.changedText?.carried.length ?? 0) === 0 && inc.noChange.ok && inc.oneChanged.ok ? 1 : 0;
            },
            target: "= 1",
            judge: atLeast(1),
        },
        // The carry part of U7 as a share: decisions on rules from unchanged text that were found again with their rule (score.ts).
        { id: "U7-carried", name: "Incremental: decisions found again with their rule (unchanged text)", value: (s) => s.incremental?.decisions.value ?? null, target: "reported" },
    ];
}

const SIDES: Engine[] = ["baseline", "candidate"];

export function buildReport(input: { inputs: Inputs; repeat: number; apps: string[]; trials: TrialResult[]; engines?: Engine[]; doc?: DocVariant }): UnderstandingReport {
    const { inputs, repeat, trials } = input;
    const mixed = trials.filter((t) => t.inputs !== inputs);
    if (mixed.length) throw new Error(`This is a ${inputs} report, but ${mixed.length} trial(s) used ${mixed[0].inputs}: url and full series are never mixed.`);
    const engines = input.engines ?? SIDES.filter((e) => trials.some((t) => t.engine === e));
    const problems: string[] = [];
    const apps = input.apps.map((app) => {
        const of = (engine: Engine) => trials.filter((t) => t.app === app && t.engine === engine);
        for (const engine of engines) {
            const ts = of(engine);
            for (let n = 1; n <= repeat; n++) {
                const t = ts.filter((x) => x.trial === n);
                if (t.length === 0) problems.push(`${app} ${engine} trial ${n} is missing.`);
                else if (t.length > 1) problems.push(`${app} ${engine} trial ${n} is recorded ${t.length} times.`);
                else if (t[0].status !== "completed" || !t[0].score) problems.push(`${app} ${engine} trial ${n} failed: ${t[0].error ?? "no score was recorded."}`);
            }
            for (const t of ts) if (t.trial < 1 || t.trial > repeat) problems.push(`${app} ${engine} trial ${t.trial} is outside the series of ${repeat}.`);
        }
        const scores = (engine: Engine) => of(engine).flatMap((t) => (t.status === "completed" && t.score ? [{ trial: t.trial, score: t.score }] : []));
        const rows: CriterionRow[] = criteria(inputs).map((c) => {
            const side = (engine: Engine) => {
                if (!engines.includes(engine)) return null;
                // The trials that measured it; null when none did.
                const values = scores(engine).flatMap((x) => {
                    const v = c.value(x.score);
                    return v === null ? [] : [v];
                });
                return values.length ? values : null;
            };
            const cand = side("candidate");
            const base = side("baseline");
            const partial = (vs: number[] | null, engine: Engine) => (vs && vs.length < scores(engine).length ? `${engine === "baseline" ? "Baseline-U " : ""}${vs.length} of ${repeat} measured` : "");
            const measured = [partial(cand, "candidate"), partial(base, "baseline")].filter(Boolean).join("; ");
            const row = { id: c.id, name: c.name, target: c.target, candidate: cand && stat(cand), baseline: base && stat(base) };
            if (!c.judge || !engines.includes("candidate")) return { ...row, verdict: "reported" as Verdict, why: measured };
            if (!cand) return { ...row, verdict: "inconclusive" as Verdict, why: "not measured, or nothing to measure, in every trial" };
            if (measured && cand.length < MIN_TRIALS) return { ...row, verdict: "inconclusive" as Verdict, why: measured };
            const blocked = c.blocker ? scores("candidate").flatMap((x) => (c.blocker!(x.score) ? [`trial ${x.trial}: ${c.blocker!(x.score)}`] : [])) : [];
            if (blocked.length) return { ...row, verdict: "inconclusive" as Verdict, why: blocked.join("; ") };
            const judged = c.judge(cand, base);
            return { ...row, ...judged, why: [judged.why, measured].filter(Boolean).join("; ") };
        });
        // U3 passes only when recall and precision both meet their targets: the U3 row carries the combined verdict.
        const u3 = rows.find((c) => c.id === "U3");
        const u3p = rows.find((c) => c.id === "U3-precision");
        if (u3 && u3p && u3.verdict !== "reported" && u3p.verdict !== "reported") {
            const both = worst([u3.verdict, u3p.verdict]);
            Object.assign(u3, { verdict: both, why: [`recall ${u3.verdict}, precision ${u3p.verdict}`, u3.why].filter(Boolean).join("; ") });
        }
        const runs: RunRow[] = trials
            .filter((t) => t.app === app)
            .sort((a, b) => SIDES.indexOf(a.engine) - SIDES.indexOf(b.engine) || a.trial - b.trial)
            .map((t) => ({ engine: t.engine, trial: t.trial, status: t.status, ...t.counts, ...(t.error ? { error: t.error } : {}) }));
        const u8 = (engine: Engine) => {
            const ts = of(engine);
            return engines.includes(engine) && ts.length ? stat(ts.map((t) => t.counts.aiCalls)) : null;
        };
        rows.push({ id: "U8", name: "AI calls per analysis, all purposes", target: "reported", candidate: u8("candidate"), baseline: u8("baseline"), verdict: "reported", why: "" });
        const PURPOSES: Array<[keyof CallsByPurpose, string]> = [
            ["analysis", "reading the application"],
            ["planning", "planning the exploration"],
            ["other", "everything else"],
        ];
        for (const [purpose, name] of PURPOSES) {
            const by = (engine: Engine) => {
                const vs = of(engine).flatMap((t) => (t.counts.byPurpose ? [t.counts.byPurpose[purpose]] : []));
                return engines.includes(engine) && vs.length ? stat(vs) : null;
            };
            rows.push({ id: `U8-${purpose}`, name: `AI calls per analysis: ${name}`, target: "reported", candidate: by("candidate"), baseline: by("baseline"), verdict: "reported", why: "" });
        }
        return { app, criteria: rows, runs };
    });
    const complete = problems.length === 0;
    const smoke = repeat < MIN_TRIALS;
    if (smoke) for (const a of apps) for (const c of a.criteria) if (c.verdict === "pass" || c.verdict === "fail") Object.assign(c, { verdict: "inconclusive", why: `fewer than ${MIN_TRIALS} trials per side` });
    if (!complete) for (const a of apps) for (const c of a.criteria) if (c.verdict === "pass" || c.verdict === "fail") Object.assign(c, { verdict: "inconclusive", why: "the series is incomplete" });
    const trialsExpected = repeat * engines.length * input.apps.length;
    const trialsRan = trials.filter((t) => input.apps.includes(t.app) && engines.includes(t.engine) && t.status === "completed" && t.score).length;
    return { inputs, ...(inputs === "full" ? { doc: input.doc ?? "records" } : {}), repeat, engines, complete, smoke, problems, trialsExpected, trialsRan, apps };
}

const num = (v: number) => String(Math.round(v * 1000) / 1000);
const cell = (s: Stat | null) => (s ? `${num(s.median)} (${num(s.min)}–${num(s.max)})` : "–");
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ");

export function renderReportMd(r: UnderstandingReport): string {
    const out: string[] = ["# Understanding benchmark", ""];
    if (r.smoke) out.push(`**Smoke series: fewer than ${MIN_TRIALS} trials per side (${r.repeat}); no criterion can pass or fail.**`, "");
    if (!r.complete) out.push(`**Incomplete series: no criterion can pass.** ${r.problems.map(esc).join(" ")}`, "");
    out.push(`Input configuration: ${r.inputs}`, ...(r.doc ? [`Requirements document: ${r.doc === "whole" ? "uploaded whole, as one document" : "imported one record per numbered requirement"}`] : []), `Sides: ${r.engines.join(", ")}`, `Trials: ${r.repeat} per side, ${r.trialsRan} of ${r.trialsExpected} ran`, "");
    out.push("A verdict is inconclusive when the range of the trials overlaps the target. Values are median (range).", "");
    for (const a of r.apps) {
        out.push(`## ${a.app}`, "", "| Criterion | Name | Target | Candidate | Baseline-U | Verdict | Note |", "|---|---|---|---|---|---|---|");
        for (const c of a.criteria) out.push(`| ${c.id} | ${esc(c.name)} | ${esc(c.target)} | ${cell(c.candidate)} | ${cell(c.baseline)} | ${c.verdict} | ${esc(c.why)} |`);
        out.push("", "| Side | Trial | Status | AI calls | Failed AI calls | Pages | Error |", "|---|---|---|---|---|---|---|");
        for (const run of a.runs) out.push(`| ${run.engine} | ${run.trial} | ${run.status} | ${run.aiCalls} | ${run.failedCalls} | ${run.pages} | ${esc(run.error ?? "")} |`);
        out.push("");
    }
    return out.join("\n");
}
