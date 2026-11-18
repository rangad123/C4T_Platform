/**
 * The repeat-run benchmark's numbers (pure, unit-tested without a platform). Each trial explores an app twice in one fresh project: a cold
 * run, then the repeat run. The "on" arm has reuse and the caches on, the "off" arm has them off (and its repeat explores everything again).
 * Both arms run the same model, and their trials alternate.
 *
 * Per app and arm: the median and range of each measure, for the cold runs and for the repeat runs. Savings compare the repeat runs:
 * 1 − median(on) / median(off). Verdict:
 *   meets         every app's repeat uses at least REPEAT_TARGETS fewer AI calls and less time, loses nothing (pages, test ideas and
 *                 requirements covered are at least the off arm's medians) and reported the changed page in every repeat run of both arms;
 *   misses        any of those is broken (one line of `reasons` each);
 *   inconclusive  a trial did not complete, an arm has fewer than MIN_TRIALS completed trials, the change could not be applied to the
 *                 page, or the off arm made no AI call (nothing to compare against).
 */

export interface RunMetrics {
    wallMs: number;
    aiCalls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** Priced from the run's price table; null without one. */
    cost: number | null;
    pages: number;
    scenarios: number;
    requirementsCovered: number;
    /** Events of the run that say something was reused (memory, unchanged pages, cached answers). */
    reuseEvents: number;
}

export type Arm = "on" | "off";

export interface RepeatTrial {
    app: string;
    arm: Arm;
    trial: number;
    status: "completed" | "failed";
    error?: string;
    cold?: RunMetrics;
    repeat?: RunMetrics;
    /** The regression trial: the page changed between the two runs. `applied`: the change was found in the page; `seen`: the repeat run's model shows it. */
    change?: { id: string; applied: boolean; seen: boolean };
}

/** The lead's targets for an unchanged repeat run (2026-11-21). */
export const REPEAT_TARGETS = { aiCalls: 0.3, wallMs: 0.25 } as const;
/** Fewer completed trials per arm than this cannot be judged. */
export const MIN_TRIALS = 5;

export interface Spread {
    median: number;
    min: number;
    max: number;
}
type Measure = Exclude<keyof RunMetrics, "cost"> | "cost" | "cacheReadShare";
export type ArmSummary = Record<Measure, Spread> & { trials: number };

export interface AppReport {
    app: string;
    arms: Record<Arm, { cold: ArmSummary; repeat: ArmSummary }>;
    /** 1 − median(on) / median(off) of the repeat runs; null when the off arm's median is 0. */
    savings: { aiCalls: number | null; wallMs: number | null; inputTokens: number | null };
    noLoss: { ok: boolean; lost: string[] };
    change?: { trials: number; applied: number; seenOn: number; seenOff: number };
}

export interface RepeatReport {
    apps: AppReport[];
    repeat: number;
    complete: boolean;
    verdict: "meets" | "misses" | "inconclusive";
    reasons: string[];
    notes: string[];
}

export function median(xs: number[]): number | null {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const spread = (xs: number[]): Spread => (xs.length ? { median: median(xs)!, min: Math.min(...xs), max: Math.max(...xs) } : { median: 0, min: 0, max: 0 });

const MEASURES: Measure[] = ["wallMs", "aiCalls", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "cost", "pages", "scenarios", "requirementsCovered", "reuseEvents", "cacheReadShare"];

function summary(runs: RunMetrics[]): ArmSummary {
    const value = (r: RunMetrics, m: Measure): number => (m === "cacheReadShare" ? (r.inputTokens ? r.cacheReadTokens / r.inputTokens : 0) : m === "cost" ? (r.cost ?? 0) : r[m]);
    return { trials: runs.length, ...(Object.fromEntries(MEASURES.map((m) => [m, spread(runs.map((r) => value(r, m)))])) as Record<Measure, Spread>) };
}

const saving = (on: number, off: number): number | null => (off > 0 ? 1 - on / off : null);
const pct = (x: number) => `${Math.round(x * 100)}%`;

export function buildRepeatReport(o: { apps: string[]; trials: RepeatTrial[]; repeat: number }): RepeatReport {
    const reasons: string[] = [];
    const notes: string[] = [];
    let inconclusive = false;
    const failed = o.trials.filter((t) => t.status !== "completed" || !t.cold || !t.repeat);
    if (failed.length) {
        inconclusive = true;
        reasons.push(`${failed.length} trial(s) did not complete: ${failed.map((t) => `${t.app} ${t.arm} trial ${t.trial}${t.error ? ` (${t.error})` : ""}`).join("; ")}.`);
    }
    const apps: AppReport[] = o.apps.map((app) => {
        const done = (arm: Arm) => o.trials.filter((t) => t.app === app && t.arm === arm && t.status === "completed" && t.cold && t.repeat);
        const arms = {
            on: { cold: summary(done("on").map((t) => t.cold!)), repeat: summary(done("on").map((t) => t.repeat!)) },
            off: { cold: summary(done("off").map((t) => t.cold!)), repeat: summary(done("off").map((t) => t.repeat!)) },
        };
        const on = arms.on.repeat;
        const off = arms.off.repeat;
        const savings = { aiCalls: saving(on.aiCalls.median, off.aiCalls.median), wallMs: saving(on.wallMs.median, off.wallMs.median), inputTokens: saving(on.inputTokens.median, off.inputTokens.median) };
        if (on.trials < MIN_TRIALS || off.trials < MIN_TRIALS) {
            inconclusive = true;
            reasons.push(`${app}: ${on.trials} completed trials with reuse on and ${off.trials} with it off; at least ${MIN_TRIALS} each are needed.`);
        }
        if (savings.aiCalls === null) {
            inconclusive = true;
            reasons.push(`${app}: the repeat with reuse off made no AI call, so there is nothing to compare against.`);
        }
        if (savings.aiCalls !== null && savings.aiCalls < REPEAT_TARGETS.aiCalls) reasons.push(`${app}: AI calls fell by ${pct(savings.aiCalls)} (target at least ${pct(REPEAT_TARGETS.aiCalls)}).`);
        if (savings.wallMs !== null && savings.wallMs < REPEAT_TARGETS.wallMs) reasons.push(`${app}: the time fell by ${pct(savings.wallMs)} (target at least ${pct(REPEAT_TARGETS.wallMs)}).`);
        if (on.trials && off.trials && on.wallMs.max >= off.wallMs.min && on.wallMs.min <= off.wallMs.max) notes.push(`${app}: the time ranges of the two arms overlap (on ${on.wallMs.min}–${on.wallMs.max} ms, off ${off.wallMs.min}–${off.wallMs.max} ms), so the time saving is within the noise of these trials.`);

        const lost: string[] = [];
        for (const [m, label] of [["pages", "pages found"], ["scenarios", "test ideas"], ["requirementsCovered", "requirements covered"]] as const) {
            if (on.trials && off.trials && on[m].median < off[m].median) lost.push(`${label}: ${on[m].median} with reuse on, ${off[m].median} with it off`);
        }
        for (const l of lost) reasons.push(`${app}: ${l}.`);

        const withChange = o.trials.filter((t) => t.app === app && t.change && t.status === "completed");
        let change: AppReport["change"];
        if (withChange.length) {
            const applied = withChange.filter((t) => t.change!.applied);
            change = { trials: withChange.length, applied: applied.length, seenOn: applied.filter((t) => t.arm === "on" && t.change!.seen).length, seenOff: applied.filter((t) => t.arm === "off" && t.change!.seen).length };
            if (applied.length < withChange.length) {
                inconclusive = true;
                reasons.push(`${app}: the change was not applied in ${withChange.length - applied.length} trial(s) (the page did not have the text to change).`);
            }
            const appliedOn = applied.filter((t) => t.arm === "on").length;
            const appliedOff = applied.filter((t) => t.arm === "off").length;
            if (change.seenOn < appliedOn) reasons.push(`${app}: the changed page was reported in ${change.seenOn} of ${appliedOn} repeat runs with reuse on.`);
            if (change.seenOff < appliedOff) reasons.push(`${app}: the changed page was reported in ${change.seenOff} of ${appliedOff} repeat runs with reuse off.`);
        }
        return { app, arms, savings, noLoss: { ok: lost.length === 0, lost }, ...(change ? { change } : {}) };
    });
    const verdict = inconclusive ? "inconclusive" : reasons.length ? "misses" : "meets";
    return { apps, repeat: o.repeat, complete: failed.length === 0, verdict, reasons, notes };
}

const cell = (s: Spread, digits = 0) => `${s.median.toFixed(digits)} (${s.min.toFixed(digits)}–${s.max.toFixed(digits)})`;
const savedCell = (x: number | null, word: string) => (x === null ? "–" : x >= 0 ? `${pct(x)} ${word}` : `${pct(-x)} more`);

export function renderRepeatMd(r: RepeatReport): string {
    const lines = [
        "# Repeat-run benchmark",
        "",
        `Verdict: ${r.verdict}${r.complete ? "" : " (the series is incomplete)"}`,
        `Targets for the repeat run: at least ${pct(REPEAT_TARGETS.aiCalls)} fewer AI calls and ${pct(REPEAT_TARGETS.wallMs)} less time, with nothing lost. Trials per arm asked: ${r.repeat}.`,
        "",
    ];
    for (const a of r.apps) {
        const on = a.arms.on.repeat;
        const off = a.arms.off.repeat;
        lines.push(
            `## ${a.app}`,
            "",
            `Repeat runs: ${on.trials} with reuse and caches on, ${off.trials} with them off. Median (range).`,
            "",
            "| Measure | On | Off | Saving |",
            "|---|---|---|---|",
            `| AI calls | ${cell(on.aiCalls)} | ${cell(off.aiCalls)} | ${savedCell(a.savings.aiCalls, "fewer")} |`,
            `| Time (ms) | ${cell(on.wallMs)} | ${cell(off.wallMs)} | ${savedCell(a.savings.wallMs, "less")} |`,
            `| Input tokens | ${cell(on.inputTokens)} | ${cell(off.inputTokens)} | ${savedCell(a.savings.inputTokens, "fewer")} |`,
            `| Cache-read share | ${cell(on.cacheReadShare, 2)} | ${cell(off.cacheReadShare, 2)} | |`,
            `| Cost (USD) | ${cell(on.cost, 4)} | ${cell(off.cost, 4)} | |`,
            `| Pages found | ${cell(on.pages)} | ${cell(off.pages)} | |`,
            `| Test ideas | ${cell(on.scenarios)} | ${cell(off.scenarios)} | |`,
            `| Requirements covered | ${cell(on.requirementsCovered)} | ${cell(off.requirementsCovered)} | |`,
            `| Reuse events | ${cell(on.reuseEvents)} | ${cell(off.reuseEvents)} | |`,
            "",
            `Cold runs: AI calls ${cell(a.arms.on.cold.aiCalls)} (on) and ${cell(a.arms.off.cold.aiCalls)} (off); time ${cell(a.arms.on.cold.wallMs)} ms and ${cell(a.arms.off.cold.wallMs)} ms.`,
            ...(a.change ? [`Changed page: applied in ${a.change.applied} of ${a.change.trials} trials; reported by ${a.change.seenOn} repeat runs with reuse on and ${a.change.seenOff} with it off.`] : []),
            "",
        );
    }
    if (r.reasons.length) lines.push("## Why", "", ...r.reasons.map((x) => `- ${x}`), "");
    if (r.notes.length) lines.push("## Notes", "", ...r.notes.map((x) => `- ${x}`), "");
    return lines.join("\n");
}
