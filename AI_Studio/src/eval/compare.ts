/**
 * The quality gate for "use less AI without losing quality": the same corpus is run twice, once with the savings OFF (the baseline) and once
 * with them ON (the candidate), each on a platform of its own, and the two runs are compared here (pure: unit-tested without a platform).
 *
 * Measured per side (from the platform's own records, as the normal evaluation): tests created, pass rate, false failures, repairs that fixed
 * a test, and AI use (input, prompt-cache reads and writes, output, calls, escalations, tokens by model), plus what was done without AI.
 *
 * Verdict:
 *   pass        the candidate's pass rate is at most `passPoints` points below the baseline's AND it has at most `falseFailures` more false
 *               failures AND it finished as many entries;
 *   fail        any of those is broken (each broken rule is one line of `reasons`);
 *   not-judged  nothing to compare: plan only (no test is created or run), or the baseline created no test or finished no entry.
 * Pass rate = tests that passed in every rerun / tests created. False failures = tests that failed although the product was not at fault:
 * flaky tests plus tests that kept failing because the test is wrong (the evaluation's own heuristic on the stored reason, metrics.ts).
 * Tokens decide nothing: they are what the savings are for, and are reported with the difference.
 */
import type { EvalRun, UsageDetail } from "./run.js";

/** One setting the comparison turns off for the baseline. */
export interface Toggle {
    /** The environment variable (also what Settings stores, see each feature's doc). */
    name: string;
    /** What the baseline's platform gets ("false", or "" for a model name: none). */
    baseline: string;
    /** What the candidate's platform gets. */
    candidate: string;
    label: string;
}

/** The savings this platform knows of: an on/off switch, or a model name (the fast model). */
export const KNOWN_SAVINGS: Array<{ name: string; kind: "switch" | "model"; label: string }> = [
    { name: "LLM_PROMPT_CACHE", kind: "switch", label: "prompt caching" },
    { name: "LLM_COMPACT_SNAPSHOTS", kind: "switch", label: "smaller page snapshots" },
    { name: "LLM_MODEL_FAST", kind: "model", label: "fast model for routine steps" },
    { name: "LLM_DETERMINISTIC_REPAIR", kind: "switch", label: "repair without AI first" },
    { name: "LLM_EXPLORATION_REUSE", kind: "switch", label: "reuse of unchanged pages" },
];

/**
 * `--toggle A,B=value`: which settings differ between the two sides. A switch is off for the baseline and on for the candidate; a model
 * setting is empty for the baseline and, for the candidate, the value given after `=` or else the environment's. Unknown names are
 * allowed (a saving added later) and treated as switches. Without `--toggle`: every known saving.
 */
export function parseToggles(spec: string | undefined, env: NodeJS.ProcessEnv = process.env): { toggles: Toggle[]; notes: string[] } {
    const items = spec === undefined ? KNOWN_SAVINGS.map((k) => k.name) : spec.split(",").map((s) => s.trim()).filter(Boolean);
    if (!items.length) throw new Error("--toggle needs at least one setting, for example --toggle LLM_PROMPT_CACHE,LLM_DETERMINISTIC_REPAIR");
    const toggles: Toggle[] = [];
    const notes: string[] = [];
    for (const item of items) {
        const eq = item.indexOf("=");
        const name = (eq >= 0 ? item.slice(0, eq) : item).trim();
        const given = eq >= 0 ? item.slice(eq + 1).trim() : undefined;
        if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) throw new Error(`--toggle: "${name}" is not a setting name (capital letters, digits and _ only, like LLM_PROMPT_CACHE)`);
        if (toggles.some((t) => t.name === name)) continue;
        const known = KNOWN_SAVINGS.find((k) => k.name === name);
        const label = known?.label ?? name;
        if (known?.kind === "model") {
            const value = given ?? (env[name] ?? "").trim();
            if (!value) {
                notes.push(`${name} is not set, so the ${label} is the same (none) on both sides; give one with --toggle ${name}=<model>.`);
                continue;
            }
            toggles.push({ name, baseline: "", candidate: value, label });
        } else {
            if (given !== undefined && given !== "" && !/^(true|on|1|yes)$/i.test(given)) throw new Error(`--toggle ${name}=${given}: a switch is compared off against on; leave out the value`);
            toggles.push({ name, baseline: "false", candidate: "true", label });
        }
    }
    if (!toggles.length) throw new Error("Nothing to compare: every setting given to --toggle is the same on both sides.");
    return { toggles, notes };
}

export interface Margins {
    /** Largest drop of the pass rate, in percentage points (default 2). */
    passPoints: number;
    /** Largest number of extra false failures (default 0). */
    falseFailures: number;
}
export const DEFAULT_MARGINS: Margins = { passPoints: 2, falseFailures: 0 };

/** `--max-quality-drop pass=2,false=0` (either part may be left out; a bare number is the pass-rate points). */
export function parseMargins(spec: string): Margins {
    const out = { ...DEFAULT_MARGINS };
    for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
        const m = /^(?:(pass|false)\s*=\s*)?(\d+(?:\.\d+)?)$/i.exec(part);
        if (!m) throw new Error(`--max-quality-drop: "${part}" is not like pass=2 or false=0`);
        const v = Number(m[2]);
        if ((m[1] ?? "pass").toLowerCase() === "pass") {
            if (v > 100) throw new Error("--max-quality-drop: pass is in points, from 0 to 100");
            out.passPoints = v;
        } else {
            if (!Number.isInteger(v)) throw new Error("--max-quality-drop: false is a whole number of tests");
            out.falseFailures = v;
        }
    }
    return out;
}

export interface SideSummary {
    entries: number;
    entriesDone: number;
    planned: number;
    created: number;
    passingEveryRerun: number;
    passedFirstRun: number;
    /** passingEveryRerun / created; null when nothing was created. */
    passRate: number | null;
    falseFailures: number;
    repairsFixed: number;
    repairsWithoutAi: number;
    pagesReused: number;
    aiCalls: number;
    escalations: number;
    tokens: { input: number; cacheRead: number; cacheWrite: number; output: number; total: number };
    byModel: UsageDetail["byModel"];
    cost: number | null;
}

export function summariseSide(run: EvalRun): SideSummary {
    const o = run.overall;
    const u = run.entries.map((e) => e.usage).filter((x): x is UsageDetail => Boolean(x));
    const sum = (f: (d: UsageDetail) => number) => u.reduce((a, d) => a + f(d), 0);
    const byModel: UsageDetail["byModel"] = [];
    for (const d of u)
        for (const m of d.byModel) {
            const row = byModel.find((r) => r.model === m.model);
            if (row) {
                row.calls += m.calls;
                row.inputTokens += m.inputTokens;
                row.outputTokens += m.outputTokens;
                row.cacheReadTokens += m.cacheReadTokens;
            } else byModel.push({ ...m });
        }
    byModel.sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) || a.model.localeCompare(b.model));
    return {
        entries: o.entries,
        entriesDone: o.entriesDone,
        planned: o.planned,
        created: o.created,
        passingEveryRerun: o.stablePassing,
        passedFirstRun: o.passedFirstRun,
        passRate: o.created > 0 ? o.stablePassing / o.created : null,
        falseFailures: o.flaky + o.failingTestWrong,
        repairsFixed: sum((d) => d.repairsFixed),
        repairsWithoutAi: sum((d) => d.repairsWithoutAi),
        pagesReused: sum((d) => d.pagesReused),
        aiCalls: o.aiCalls,
        escalations: sum((d) => d.escalations),
        tokens: { input: o.inputTokens, cacheRead: sum((d) => d.cacheReadTokens), cacheWrite: sum((d) => d.cacheWriteTokens), output: o.outputTokens, total: o.inputTokens + o.outputTokens },
        byModel,
        cost: o.cost,
    };
}

export interface EntryComparison {
    id: string;
    baseline: { status: string; created: number; passRate: number | null; falseFailures: number; tokens: number };
    candidate: { status: string; created: number; passRate: number | null; falseFailures: number; tokens: number };
}

export interface CompareReport {
    format: 1;
    kind: "compare";
    corpus: string;
    startedAt: string;
    finishedAt: string;
    planOnly: boolean;
    repeat: number;
    warm: boolean;
    model: string;
    toggles: Toggle[];
    margins: Margins;
    baseline: SideSummary;
    candidate: SideSummary;
    /** Candidate minus baseline: negative = fewer. */
    difference: { inputTokens: number; outputTokens: number; totalTokens: number; totalTokensPct: number | null; aiCalls: number; passRatePoints: number | null; falseFailures: number; created: number };
    verdict: "pass" | "fail" | "not-judged";
    reasons: string[];
    entries: EntryComparison[];
}

const pts = (r: number | null) => (r === null ? null : Math.round(r * 1000) / 10);

export function compareRuns(baseline: EvalRun, candidate: EvalRun, o: { toggles: Toggle[]; margins: Margins; warm: boolean; startedAt: string; finishedAt?: string }): CompareReport {
    const b = summariseSide(baseline);
    const c = summariseSide(candidate);
    const reasons: string[] = [];
    let verdict: CompareReport["verdict"];
    const passRatePoints = b.passRate !== null && c.passRate !== null ? Math.round((c.passRate - b.passRate) * 1000) / 10 : null;
    if (baseline.planOnly) {
        verdict = "not-judged";
        reasons.push("Plan only: no test was created or run, so quality is not judged (only the AI use is compared).");
    } else if (b.entriesDone === 0 || b.created === 0) {
        verdict = "not-judged";
        reasons.push(b.entriesDone === 0 ? "No entry finished with the savings off, so there is nothing to compare with." : "No test was created with the savings off, so there is nothing to compare with.");
    } else {
        if (c.entriesDone < b.entriesDone) reasons.push(`Entries finished: ${c.entriesDone} with the savings on against ${b.entriesDone} with them off.`);
        if (c.passRate === null) reasons.push("No test was created with the savings on.");
        else if (passRatePoints! < -o.margins.passPoints) reasons.push(`Pass rate fell by ${Math.abs(passRatePoints!)} points (${pts(b.passRate)}% to ${pts(c.passRate)}%); at most ${o.margins.passPoints} is allowed.`);
        if (c.falseFailures - b.falseFailures > o.margins.falseFailures) reasons.push(`False failures rose from ${b.falseFailures} to ${c.falseFailures}; at most ${o.margins.falseFailures} more ${o.margins.falseFailures === 1 ? "is" : "are"} allowed.`);
        verdict = reasons.length ? "fail" : "pass";
    }
    const entries: EntryComparison[] = baseline.entries.map((be) => {
        const ce = candidate.entries.find((e) => e.id === be.id);
        const side = (e: typeof be | undefined) => ({
            status: e?.status ?? "missing",
            created: e?.metrics?.created ?? 0,
            passRate: e?.metrics && e.metrics.created > 0 ? e.metrics.stablePassing / e.metrics.created : null,
            falseFailures: e?.metrics ? e.metrics.flaky + e.metrics.failingTestWrong : 0,
            tokens: e?.metrics ? e.metrics.inputTokens + e.metrics.outputTokens : 0,
        });
        return { id: be.id, baseline: side(be), candidate: side(ce) };
    });
    return {
        format: 1,
        kind: "compare",
        corpus: baseline.corpus,
        startedAt: o.startedAt,
        finishedAt: o.finishedAt ?? new Date().toISOString(),
        planOnly: baseline.planOnly,
        repeat: baseline.repeat,
        warm: o.warm,
        model: baseline.platform.model,
        toggles: o.toggles,
        margins: o.margins,
        baseline: b,
        candidate: c,
        difference: {
            inputTokens: c.tokens.input - b.tokens.input,
            outputTokens: c.tokens.output - b.tokens.output,
            totalTokens: c.tokens.total - b.tokens.total,
            totalTokensPct: b.tokens.total > 0 ? Math.round(((c.tokens.total - b.tokens.total) / b.tokens.total) * 1000) / 10 : null,
            aiCalls: c.aiCalls - b.aiCalls,
            passRatePoints,
            falseFailures: c.falseFailures - b.falseFailures,
            created: c.created - b.created,
        },
        verdict,
        reasons,
        entries,
    };
}

const pct = (v: number | null) => (v === null ? "n/a" : `${Math.round(v * 1000) / 10}%`);
const k = (n: number) => n.toLocaleString("en-US");
const signed = (n: number | null, unit = "") => (n === null ? "n/a" : `${n > 0 ? "+" : ""}${n.toLocaleString("en-US")}${unit}`);
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ");

/** The Markdown the owner reads: the verdict first, then the two sides next to each other. */
export function compareMarkdown(r: CompareReport): string {
    const L: string[] = [];
    const word = r.verdict === "pass" ? "Pass: quality held with the savings on" : r.verdict === "fail" ? "Fail: quality dropped with the savings on" : "Not judged";
    L.push(`# Savings comparison: ${r.corpus}`, "");
    L.push(`${r.startedAt.slice(0, 16).replace("T", " ")} UTC, AI model ${r.model}, ${r.planOnly ? "plan only" : `${r.repeat} reruns of every created test`}${r.warm ? ", each entry explored once before the measured exploration (warm-up)" : ""}.`, "");
    L.push(`**${word}.**`, "");
    for (const reason of r.reasons) L.push(`- ${reason}`);
    if (r.reasons.length) L.push("");
    L.push(`Allowed: the pass rate may fall by at most ${r.margins.passPoints} points, and at most ${r.margins.falseFailures} more false ${r.margins.falseFailures === 1 ? "failure" : "failures"}.`, "");
    L.push("Savings compared (off for the baseline, on for the candidate):", "");
    for (const t of r.toggles) L.push(`- ${t.label} (\`${t.name}\`: ${t.baseline === "" ? "none" : t.baseline} against ${t.candidate})`);
    L.push("", "## Side by side", "", "| Measure | Savings off | Savings on | Difference |", "|---|---|---|---|");
    const b = r.baseline;
    const c = r.candidate;
    const rows: Array<[string, string, string, string]> = [
        ["Entries finished", `${b.entriesDone} of ${b.entries}`, `${c.entriesDone} of ${c.entries}`, signed(c.entriesDone - b.entriesDone)],
        ["Tests planned", k(b.planned), k(c.planned), signed(c.planned - b.planned)],
        ["Tests created", k(b.created), k(c.created), signed(r.difference.created)],
        ["Pass rate (every rerun)", pct(b.passRate), pct(c.passRate), signed(r.difference.passRatePoints, " points")],
        ["False failures", k(b.falseFailures), k(c.falseFailures), signed(r.difference.falseFailures)],
        ["Repairs that fixed a test", k(b.repairsFixed), k(c.repairsFixed), signed(c.repairsFixed - b.repairsFixed)],
        ["  of them without AI", k(b.repairsWithoutAi), k(c.repairsWithoutAi), signed(c.repairsWithoutAi - b.repairsWithoutAi)],
        ["Unchanged pages not sent to the AI", k(b.pagesReused), k(c.pagesReused), signed(c.pagesReused - b.pagesReused)],
        ["AI calls", k(b.aiCalls), k(c.aiCalls), signed(r.difference.aiCalls)],
        ["Escalated to the main model", k(b.escalations), k(c.escalations), signed(c.escalations - b.escalations)],
        ["Input tokens", k(b.tokens.input), k(c.tokens.input), signed(r.difference.inputTokens)],
        ["  read from the prompt cache", k(b.tokens.cacheRead), k(c.tokens.cacheRead), signed(c.tokens.cacheRead - b.tokens.cacheRead)],
        ["  written to the prompt cache", k(b.tokens.cacheWrite), k(c.tokens.cacheWrite), signed(c.tokens.cacheWrite - b.tokens.cacheWrite)],
        ["Output tokens", k(b.tokens.output), k(c.tokens.output), signed(r.difference.outputTokens)],
        ["All tokens", k(b.tokens.total), k(c.tokens.total), `${signed(r.difference.totalTokens)}${r.difference.totalTokensPct === null ? "" : ` (${signed(r.difference.totalTokensPct, "%")})`}`],
        ["Cost", b.cost === null ? "n/a" : String(Math.round(b.cost * 10000) / 10000), c.cost === null ? "n/a" : String(Math.round(c.cost * 10000) / 10000), b.cost !== null && c.cost !== null ? signed(Math.round((c.cost - b.cost) * 10000) / 10000) : "n/a"],
    ];
    for (const row of rows) L.push(`| ${row.map(cell).join(" | ")} |`);
    const models = [...new Set([...b.byModel, ...c.byModel].map((m) => m.model))];
    if (models.length) {
        L.push("", "## Tokens by model", "", "| Model | Savings off (in / out, calls) | Savings on (in / out, calls) |", "|---|---|---|");
        const one = (s: SideSummary, m: string) => {
            const row = s.byModel.find((x) => x.model === m);
            return row ? `${k(row.inputTokens)} / ${k(row.outputTokens)}, ${row.calls}${row.cacheReadTokens ? ` (${k(row.cacheReadTokens)} cached)` : ""}` : "none";
        };
        for (const m of models) L.push(`| ${cell(m)} | ${one(b, m)} | ${one(c, m)} |`);
    }
    if (r.entries.length) {
        L.push("", "## Per entry", "", "| Entry | Created (off / on) | Pass rate (off / on) | False failures (off / on) | Tokens (off / on) |", "|---|---|---|---|---|");
        for (const e of r.entries) L.push(`| ${cell(e.id)} | ${e.baseline.created} / ${e.candidate.created} | ${pct(e.baseline.passRate)} / ${pct(e.candidate.passRate)} | ${e.baseline.falseFailures} / ${e.candidate.falseFailures} | ${k(e.baseline.tokens)} / ${k(e.candidate.tokens)} |`);
    }
    L.push("", "Pass rate: created tests that passed in every rerun. False failures: flaky tests plus tests that kept failing because the test was wrong (a heuristic on the stored reason). Tokens are the platform's own usage records; with a scripted model or a provider that reports none they are estimates.", "");
    return L.join("\n");
}
