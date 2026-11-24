/**
 * "Observed vs fails on the seeded app" (pure; unit-tested in tests/bench-observed-unit.test.ts): of the findings a benchmark reported, which ones the saved
 * script kept and which ones were seen while the test was written but lost on replay. Read from a benchmark result alone (schema.ts); no
 * app, platform or model. Definitions, each finding in exactly one kind, checked in this order:
 *
 *   false_positive   the replay fails with every defect off too, or (when the replay did not fail) a person labelled it false_positive
 *   captured         the saved script fails again on the seeded app
 *   observed_only    the author stopped the test as a defect (source "authoring") and the replay on the seeded app passed
 *   unverified       anything else: the replay did not run, or a validation / check finding that passed on replay
 *
 * And the two Phase 3 criteria, over author-time findings only (source "authoring": the author said the app contradicts what it expected;
 * the results do not record whether that expectation had a source, so every authoring finding is counted, as in the Phase 2 baseline):
 *
 *   E1 capture          authoring findings whose saved script fails on the seeded app / authoring findings
 *   E2 replay isolation of those, the ones whose script passes on the clean app / authoring findings that failed on the seeded app
 *                       (a clean replay that did not run counts as not passing; `cleanNotRun` says how many)
 *
 * Labels never change E1 or E2 and never count as detected; they only say which defect an observed-only finding saw.
 *
 * And, from results written since P3-23 (an app's `exploration` record; absent in older results, then each is null = "not available",
 * never zero):
 *
 *   per objective       candidate findings (authoring findings) by their objective's kind and operator ("none" without an objective)
 *   E6 bounded          objective sessions with a recorded stop reason / sessions, and sessions that used more than a budget they were
 *                       given (objectives pursued, actions, AI calls: the counts `exploration_stopped` records; tokens and minutes: the
 *                       job's exploration record, for its last session; a session without them is not checked on them)
 *   E7 evidence         candidate findings that carry every field of EVIDENCE_FIELDS / candidate findings
 *   E8 cost             the trial's AI calls and estimated cost (always), the objective sessions' own calls (null without the record);
 *                       across trials, the candidate median against the baseline median (report.ts)
 */
import { bindLabels, type LabelSet } from "./labels.js";
import type { BenchFinding, Benchmark, ExplorationSession, ReplayVerdict } from "./schema.js";

export type ObservedKind = "captured" | "observed_only" | "false_positive" | "unverified";
export const OBSERVED_KINDS: ObservedKind[] = ["captured", "observed_only", "false_positive", "unverified"];

export interface Ratio {
    n: number;
    of: number;
    rate: number | null;
}

export interface ObservedRow {
    app: string;
    testKey: string;
    source: BenchFinding["source"];
    capture?: BenchFinding["capture"];
    seeded: ReplayVerdict;
    clean: ReplayVerdict | null;
    kind: ObservedKind;
    label?: string;
    /** A candidate finding's objective ("kind / operator", "none") and the E7 fields it lacks; absent in older results. */
    objective?: string;
    missing?: string[];
    notes?: string[];
}

export interface Observed {
    rows: ObservedRow[];
    counts: Record<ObservedKind, number>;
    e1: Ratio;
    e2: Ratio;
    cleanNotRun: number;
    /** Seeded defects an observed-only finding was labelled with (sorted, distinct): seen while writing, not kept by the script. */
    observedDefects: string[];
    observedUnlabelled: number;
    /** What the author recorded for the authoring findings (meta.capture); "unrecorded" in results written before it existed. */
    authorCapture: { captured: number; observed_only: number; unrecorded: number };
    /** A baseline trial (the benchmark's `baseline`): E8's reference. */
    baseline: boolean;
    /** Candidate findings by objective kind and operator, sorted; null: not available (the result has no exploration record). */
    byObjective: Array<{ kind: string; operator: string; findings: number }> | null;
    /** Session stop reasons and E6; null: not available; "not_applicable" on a baseline trial (it does not explore by objectives). */
    e6: { sessions: number; withStopReason: number; stopReasons: Record<string, number>; overBudget: Array<{ jobId: string; over: string[] }>; pass: boolean } | null | "not_applicable";
    /** E7; null: not available; "not_applicable" on a baseline trial. `missing` counts each absent field over the candidate findings. */
    e7: (Ratio & { missing: Record<string, number>; pass: boolean }) | null | "not_applicable";
    e8: { aiCalls: number; cost: number | null; sessionCalls: number | null };
}

/**
 * E7: what a candidate finding must carry (spec E7, §3 "Candidate finding"), each checked present and non-empty in the test's
 * `meta.finding` (engine/explore/finding.ts):
 *   objective      an objective with an id and kind          actions       a replayable step sequence (stepCount >= 1)
 *   expected       the expected text                         source        where the expected result comes from (expected.source); only a
 *                                                                           captured finding needs one: one marked observed_only with no
 *                                                                           source says nothing stated backs it, which is not a gap
 *   observed       what the app did                          evidence      at least one screenshot, request summary or console line (no
 *                                                                           screenshots is noted, "screenshots: none saved", not a gap)
 *   confidence     high / medium / low                       reproduction  the saved test it is on (its test key)
 *   modelVersion   the application model version it came from
 * A defect test with no candidate finding at all lacks "finding" (and so every field).
 */
export const EVIDENCE_FIELDS = ["objective", "actions", "expected", "source", "observed", "evidence", "confidence", "reproduction", "modelVersion"] as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const filled = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
const nonEmptyList = (v: unknown): boolean => Array.isArray(v) && v.some(filled);

/** The E7 fields this candidate finding (a test's `meta.finding`, as the platform returns it) lacks; empty = complete. */
export function evidenceGaps(finding: unknown, testKey: string): string[] {
    if (!isObj(finding)) return ["finding", ...EVIDENCE_FIELDS];
    const f = finding;
    const o = f.objective;
    const a = f.actions;
    const ex = f.expected;
    const ev = f.evidence;
    const has: Record<(typeof EVIDENCE_FIELDS)[number], boolean> = {
        objective: isObj(o) && filled(o.id) && filled(o.kind),
        actions: isObj(a) && typeof a.stepCount === "number" && Number.isInteger(a.stepCount) && a.stepCount >= 1,
        expected: isObj(ex) && filled(ex.text),
        source: isObj(ex) && (filled(ex.source) || (f.capture === "observed_only" && ex.source === null)),
        observed: filled(f.observed),
        evidence: isObj(ev) && (nonEmptyList(ev.screenshots) || nonEmptyList(ev.requests) || nonEmptyList(ev.console)),
        confidence: f.confidence === "high" || f.confidence === "medium" || f.confidence === "low",
        reproduction: filled(testKey),
        modelVersion: filled(f.modelVersion),
    };
    return EVIDENCE_FIELDS.filter((k) => !has[k]);
}

/** Shown beside the gaps of a candidate finding with no screenshot (known: queue row 173); not an E7 gap. */
export const NO_SCREENSHOTS = "screenshots: none saved";

/** What the benchmark keeps of a candidate finding: its objective's kind and operator, the E7 fields it lacks, and notes (NO_SCREENSHOTS). */
export function candidateOf(finding: unknown, testKey: string): NonNullable<BenchFinding["candidate"]> {
    const o = isObj(finding) ? finding.objective : undefined;
    const ev = isObj(finding) ? finding.evidence : undefined;
    const shots = isObj(ev) && nonEmptyList(ev.screenshots);
    return {
        objective: isObj(o) && filled(o.kind) ? { kind: String(o.kind).slice(0, 40), operator: filled(o.operator) ? String(o.operator).slice(0, 80) : null } : null,
        missing: evidenceGaps(finding, testKey),
        ...(isObj(finding) && !shots ? { notes: [NO_SCREENSHOTS] } : {}),
    };
}

const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

/**
 * A job's objective sessions from its events, in order: `objectives_planned` opens a session (its `data.budgets`), `exploration_stopped`
 * closes the open one (`data.stopReason`, `pursued`, `actions`, `aiCalls`), or stands alone when nothing was opened. A session opened and
 * never closed has no stop reason. Event data is read defensively: a field that is not a count is left out (budgets / used null).
 * `record`: the tokens and minutes the job's exploration record says its last session used (the event does not carry them).
 */
export function sessionsFromEvents(jobId: string, events: readonly unknown[], record?: { tokens?: unknown; minutes?: unknown }): ExplorationSession[] {
    const out: ExplorationSession[] = [];
    let open: ExplorationSession | undefined;
    for (const e of events) {
        if (!isObj(e)) continue;
        const d = isObj(e.data) ? e.data : {};
        if (e.kind === "objectives_planned") {
            const b = isObj(d.budgets) ? d.budgets : {};
            const [objectives, actions, aiCalls] = [count(b.objectives), count(b.actions), count(b.aiCalls)];
            open = { jobId: jobId.slice(0, 100), stopReason: null, detail: "", budgets: objectives !== null && actions !== null && aiCalls !== null ? { objectives, actions, aiCalls, ...tokensMinutes(b) } : null, used: null };
            out.push(open);
        } else if (e.kind === "exploration_stopped") {
            const s = open ?? { jobId: jobId.slice(0, 100), stopReason: null, detail: "", budgets: null, used: null };
            if (!open) out.push(s);
            open = undefined;
            s.stopReason = filled(d.stopReason) ? String(d.stopReason).slice(0, 40) : null;
            s.detail = typeof e.message === "string" ? e.message.slice(0, 600) : "";
            const [objectives, actions, aiCalls] = [count(d.pursued), count(d.actions), count(d.aiCalls)];
            s.used = objectives !== null && actions !== null && aiCalls !== null ? { objectives, actions, aiCalls } : null;
        }
    }
    const last = out.findLast((x) => x.used);
    if (last?.used && record) last.used = { ...last.used, ...tokensMinutes(record) };
    return out.slice(0, 30);
}

const amount = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
/** Tokens (a count) and minutes (any amount), each only when readable. */
function tokensMinutes(x: { tokens?: unknown; minutes?: unknown }): { tokens?: number; minutes?: number } {
    const [tokens, minutes] = [count(x.tokens), amount(x.minutes)];
    return { ...(tokens !== null ? { tokens } : {}), ...(minutes !== null ? { minutes } : {}) };
}

/** The budgets this session used more of than it was given (objectives, actions, aiCalls, tokens, minutes); empty when within them or not known. */
export function overBudget(s: ExplorationSession): string[] {
    if (!s.budgets || !s.used) return [];
    const b = s.budgets;
    const u = s.used;
    return (["objectives", "actions", "aiCalls", "tokens", "minutes"] as const).filter((k) => u[k] !== undefined && b[k] !== undefined && u[k] > b[k]);
}

const failing = (v: ReplayVerdict | null | undefined): boolean => v === "failed" || v === "finding";
const ratio = (n: number, of: number): Ratio => ({ n, of, rate: of > 0 ? n / of : null });

export function observedKind(f: BenchFinding): ObservedKind {
    if (f.category === "false_positive") return "false_positive";
    if (failing(f.replay.seeded)) return "captured";
    if (f.label === "false_positive") return "false_positive";
    if (f.source === "authoring" && f.replay.seeded === "passed") return "observed_only";
    return "unverified";
}

export function observedOf(b: Benchmark): Observed {
    const rows: ObservedRow[] = [];
    const counts: Record<ObservedKind, number> = { captured: 0, observed_only: 0, false_positive: 0, unverified: 0 };
    const authorCapture = { captured: 0, observed_only: 0, unrecorded: 0 };
    const defects = new Set<string>();
    let authoring = 0;
    let reproduced = 0;
    let isolated = 0;
    let cleanNotRun = 0;
    let observedUnlabelled = 0;
    for (const a of b.apps) {
        for (const f of a.findings) {
            const kind = observedKind(f);
            counts[kind]++;
            rows.push({ app: a.id, testKey: f.testKey, source: f.source, ...(f.capture ? { capture: f.capture } : {}), seeded: f.replay.seeded, clean: f.replay.clean, kind, ...(f.label ? { label: f.label } : {}), ...(f.candidate ? { objective: f.candidate.objective ? `${f.candidate.objective.kind} / ${f.candidate.objective.operator ?? "none"}` : "none", missing: f.candidate.missing, ...(f.candidate.notes?.length ? { notes: f.candidate.notes } : {}) } : {}) });
            if (kind === "observed_only") {
                if (f.label && f.label !== "false_positive") defects.add(f.label);
                else observedUnlabelled++;
            }
            if (f.source !== "authoring") continue;
            authoring++;
            authorCapture[f.capture ?? "unrecorded"]++;
            if (!failing(f.replay.seeded)) continue;
            reproduced++;
            if (f.replay.clean === "passed") isolated++;
            else if (f.replay.clean === null || f.replay.clean === "not_run") cleanNotRun++;
        }
    }
    const recorded = b.apps.filter((a) => a.exploration);
    const available = recorded.length > 0;
    const sessions = recorded.flatMap((a) => a.exploration!.sessions);
    // Per objective and E7: the candidate findings of the apps that kept the record (an older app result in the same file has none).
    const candidates = recorded.flatMap((a) => a.findings.filter((f) => f.source === "authoring" && f.candidate)).map((f) => f.candidate!);
    const groups = new Map<string, { kind: string; operator: string; findings: number }>();
    const missing: Record<string, number> = {};
    for (const c of candidates) {
        const kind = c.objective?.kind ?? "none";
        const operator = c.objective?.operator ?? "none";
        const g = groups.get(`${kind}\u0000${operator}`) ?? { kind, operator, findings: 0 };
        g.findings++;
        groups.set(`${kind}\u0000${operator}`, g);
        for (const m of c.missing) missing[m] = (missing[m] ?? 0) + 1;
    }
    const stopReasons: Record<string, number> = {};
    for (const s of sessions) if (s.stopReason) stopReasons[s.stopReason] = (stopReasons[s.stopReason] ?? 0) + 1;
    const over = sessions.map((s) => ({ jobId: s.jobId, over: overBudget(s) })).filter((x) => x.over.length);
    const withStopReason = sessions.filter((s) => s.stopReason).length;
    const complete = candidates.filter((c) => c.missing.length === 0).length;
    return {
        rows,
        counts,
        e1: ratio(reproduced, authoring),
        e2: ratio(isolated, reproduced),
        cleanNotRun,
        observedDefects: [...defects].sort(),
        observedUnlabelled,
        authorCapture,
        baseline: b.baseline,
        byObjective: available ? [...groups.values()].sort((x, y) => x.kind.localeCompare(y.kind) || x.operator.localeCompare(y.operator)) : null,
        e6: !available ? null : b.baseline ? "not_applicable" : { sessions: sessions.length, withStopReason, stopReasons, overBudget: over, pass: withStopReason === sessions.length && over.length === 0 },
        e7: !available ? null : b.baseline ? "not_applicable" : { ...ratio(complete, candidates.length), missing, pass: complete === candidates.length },
        e8: { aiCalls: b.metrics.aiCalls, cost: b.metrics.cost, sessionCalls: available ? sessions.reduce((n, s) => n + (s.used?.aiCalls ?? 0), 0) : null },
    };
}

/**
 * A person's labels (labels.ts: bound to the trial they were made for) applied as the benchmark applies them: only labels made for this
 * result's projects, only to findings the replays could not verify, and only a defect seeded in that app or false_positive. Returns a copy,
 * and notes for the report (labels for another trial ignored).
 */
export function withLabels(b: Benchmark, set: LabelSet): { benchmark: Benchmark; notes: string[] } {
    const { labels, notes } = bindLabels(set, b.apps);
    const benchmark = {
        ...b,
        apps: b.apps.map((a) => ({
            ...a,
            findings: a.findings.map((f) => {
                const l = labels[`${a.id}/${f.testKey}`];
                return l && f.category === "unreproduced" && (l === "false_positive" || a.seededDefects.includes(l)) ? { ...f, label: l } : f;
            }),
        })),
    };
    return { benchmark, notes };
}

/** Why a result cannot stand for one whole trial (an app that did not finish), or undefined. */
export function trialProblem(b: Benchmark): string | undefined {
    const unfinished = b.apps.filter((a) => a.status !== "done");
    if (!b.apps.length) return "The result has no apps.";
    if (unfinished.length) return `${unfinished.map((a) => `${a.id} did not finish (${a.status}${a.reason ? `: ${a.reason.slice(0, 200)}` : ""})`).join("; ")}; an incomplete trial is reported as incomplete, not counted.`;
    return undefined;
}

/** Median and range of one rate over trials; trials with no rate (nothing to divide by) are left out and not counted in n. */
export function seriesOf(values: Array<number | null>): { n: number; median: number | null; min: number | null; max: number | null } {
    const v = values.filter((x): x is number => x !== null).sort((a, b) => a - b);
    if (!v.length) return { n: 0, median: null, min: null, max: null };
    const mid = Math.floor(v.length / 2);
    return { n: v.length, median: v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2, min: v[0]!, max: v[v.length - 1]! };
}
