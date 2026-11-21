/**
 * Benchmark numbers (pure functions, unit-tested in tests/bench-metrics-unit.test.ts). Definitions, with their denominators:
 *
 *   finding                a test the platform reported as a possible application problem (validation status NEEDS_REVIEW)
 *   detected               a seeded defect at least one CONFIRMED finding was attributed to by replay
 *   detection rate         detected / seeded defects switched on in the run                       (null when none was seeded)
 *   precision              true positives / all reported findings                                (null when nothing was reported)
 *                          true positive = a confirmed or combined finding (both verified by replay against the correct app)
 *   precision (verified)   true positives / (true positives + false positives)                   (unreproduced findings left out)
 *   false-positive rate    false positives / all reported findings                               (null when nothing was reported)
 *                          false positive = a finding that also fails with every defect off, or one a person labelled so
 *   reproduction rate      findings that failed again in the replay with the defects on / findings selected for verification
 *                          (every reported finding is selected)
 *   detection time         benchmark start to the first failure the platform recorded for a confirmed finding (null when none)
 *   cost per confirmed defect   estimated AI cost / detected defects                             (null when no cost or none detected)
 *
 * A finding a person labelled with a defect (only possible for an unreproduced finding) is counted in `detectedLabeled`, never in `detected`.
 *
 * Scoring rules v2 (SCORING_VERSION, queue row 237; ROW233-ROOT-CAUSE.md §4): detection is scored exactly as in v1. Changed and added:
 *   false positive         as above, but never a test the engine itself did not report (NOT_REPORTED: its leftover and limits gates
 *                          save such tests for review with that reason); those are counted in `notReported`
 *   seen but not reproducible   the author stopped the test as a defect (source "authoring") and its saved test passed on the seeded
 *                          app (`seenNotReproducible`; already inside `unreproduced`, never a false positive)
 *   effective maximum      seeded defects minus those the catalogue marks unreachable (`reachable`); the detection rate stays / seeded
 * A result without `scoring` was scored by v1 (false positives include the engine's unreported tests; no effective maximum).
 */
import type { Benchmark, BenchFinding, BenchMetrics, ExtensionScore, FindingCategory, LayerCounts, ReplayVerdict } from "./schema.js";

export const SCORING_VERSION = 2;
/** The reasons the engine's own gates give a test it saved for review but did not report (engine/orchestrator.ts keepAuthored). */
const NOT_REPORTED = /^(Not reported as a finding|Not validated):/;
export const notReportedByEngine = (f: BenchFinding): boolean => NOT_REPORTED.test(f.reason ?? "");

const failing = (v: ReplayVerdict | null | undefined): boolean => v === "failed" || v === "finding";

/** What a finding is, from its replays alone. */
export function categorize(replay: BenchFinding["replay"]): { category: FindingCategory; defects: string[] } {
    if (!failing(replay.seeded)) return { category: "unreproduced", defects: [] };
    if (replay.clean === null || replay.clean === "not_run") return { category: "unreproduced", defects: [] };
    if (failing(replay.clean)) return { category: "false_positive", defects: [] };
    const defects = Object.entries(replay.single)
        .filter(([, v]) => failing(v))
        .map(([id]) => id)
        .sort();
    return defects.length ? { category: "confirmed", defects } : { category: "combined", defects: [] };
}

const rate = (n: number, d: number): number | null => (d > 0 ? n / d : null);

export interface MetricInputs {
    /** The defects switched on in the run. */
    seeded: string[];
    findings: BenchFinding[];
    /** When the benchmark started (ISO). */
    startedAt: string;
    cost: number | null;
    testsGenerated: number;
    workflows: number;
    workflowsCovered: number;
    executionFailures: number;
    flaky: number;
    durationMs: number;
    aiCalls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** Seeded defects the catalogue marks unreachable (no test can reach them in this bench set-up). */
    unreachable?: string[];
}

export function benchMetrics(i: MetricInputs): BenchMetrics {
    const seeded = new Set(i.seeded);
    const detected = new Set<string>();
    const labeled = new Set<string>();
    let tp = 0;
    let fp = 0;
    let unreproduced = 0;
    let reproduced = 0;
    let notReported = 0;
    let seenNotReproducible = 0;
    let first: number | null = null;
    for (const f of i.findings) {
        if (failing(f.replay.seeded)) reproduced++;
        if (f.category === "confirmed" || f.category === "combined") tp++;
        const unreported = notReportedByEngine(f);
        if (unreported) notReported++;
        else if (f.category === "false_positive" || (f.category === "unreproduced" && f.label === "false_positive")) fp++;
        if (!unreported && f.source === "authoring" && f.replay.seeded === "passed") seenNotReproducible++;
        if (f.category === "unreproduced") unreproduced++;
        if (f.category === "confirmed") {
            for (const d of f.defects) if (seeded.has(d)) detected.add(d);
            if (f.firstSeenAt) {
                const t = Date.parse(f.firstSeenAt) - Date.parse(i.startedAt);
                if (Number.isFinite(t)) first = first === null ? Math.max(0, t) : Math.min(first, Math.max(0, t));
            }
        }
        if (f.category === "unreproduced" && f.label && f.label !== "false_positive" && seeded.has(f.label)) labeled.add(f.label);
    }
    for (const d of detected) labeled.delete(d);
    const n = i.findings.length;
    return {
        seeded: seeded.size,
        detected: detected.size,
        missed: seeded.size - detected.size,
        detectedLabeled: labeled.size,
        findings: n,
        truePositives: tp,
        falsePositives: fp,
        unreproduced,
        notReported,
        seenNotReproducible,
        reachable: [...seeded].filter((d) => !i.unreachable?.includes(d)).length,
        selectedForVerification: n,
        reproduced,
        detectionRate: rate(detected.size, seeded.size),
        precision: rate(tp, n),
        precisionVerified: rate(tp, tp + fp),
        falsePositiveRate: rate(fp, n),
        reproductionRate: rate(reproduced, n),
        detectionTimeMs: first === null ? null : Math.round(first),
        cost: i.cost,
        costPerConfirmedDefect: i.cost === null || detected.size === 0 ? null : i.cost / detected.size,
        testsGenerated: i.testsGenerated,
        workflows: i.workflows,
        workflowsCovered: i.workflowsCovered,
        executionFailures: i.executionFailures,
        flaky: i.flaky,
        durationMs: i.durationMs,
        aiCalls: i.aiCalls,
        inputTokens: i.inputTokens,
        outputTokens: i.outputTokens,
        cacheReadTokens: i.cacheReadTokens,
        cacheWriteTokens: i.cacheWriteTokens,
    };
}

const SUMMED = ["seeded", "detected", "missed", "detectedLabeled", "findings", "truePositives", "falsePositives", "unreproduced", "selectedForVerification", "reproduced", "testsGenerated", "workflows", "workflowsCovered", "executionFailures", "flaky", "durationMs", "aiCalls", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;

/** The whole benchmark: counts summed over the apps, rates recomputed from the sums (never averaged), detection time the earliest. */
export function combineMetrics(parts: BenchMetrics[]): BenchMetrics {
    const s = Object.fromEntries(SUMMED.map((k) => [k, parts.reduce((n, m) => n + m[k], 0)])) as Record<(typeof SUMMED)[number], number>;
    const costs = parts.map((m) => m.cost).filter((c): c is number => c !== null);
    const cost = costs.length ? costs.reduce((a, b) => a + b, 0) : null;
    // v2 counts, only when every part has them (a v1 part has none: never read as zero).
    const added = Object.fromEntries((["notReported", "seenNotReproducible", "reachable"] as const).filter((k) => parts.every((m) => m[k] !== undefined)).map((k) => [k, parts.reduce((n, m) => n + m[k]!, 0)]));
    const times = parts.map((m) => m.detectionTimeMs).filter((t): t is number => t !== null);
    return {
        ...s,
        ...added,
        detectionRate: rate(s.detected, s.seeded),
        precision: rate(s.truePositives, s.findings),
        precisionVerified: rate(s.truePositives, s.truePositives + s.falsePositives),
        falsePositiveRate: rate(s.falsePositives, s.findings),
        reproductionRate: rate(s.reproduced, s.selectedForVerification),
        detectionTimeMs: times.length ? Math.min(...times) : null,
        cost,
        costPerConfirmedDefect: cost === null || s.detected === 0 ? null : cost / s.detected,
    };
}

/**
 * The extension seeds' own score (catalogue 2026-11-21.1): detection over the extension seeds only, from the same findings. It is reported
 * beside the original score and never added into `metrics`, so results of the original catalogue stay comparable.
 */
export function extensionScore(i: MetricInputs): ExtensionScore {
    const m = benchMetrics(i);
    return { seeded: m.seeded, detected: m.detected, missed: m.missed, detectedLabeled: m.detectedLabeled, reachable: m.reachable!, detectionRate: m.detectionRate };
}

/** The extension score of the whole benchmark (counts summed, the rate recomputed); undefined when no app had extension seeds. */
export function combineExtension(parts: Array<ExtensionScore | undefined>): ExtensionScore | undefined {
    const xs = parts.filter((x): x is ExtensionScore => x !== undefined);
    if (!xs.length) return undefined;
    const sum = (k: "seeded" | "detected" | "missed" | "detectedLabeled" | "reachable") => xs.reduce((n, x) => n + x[k], 0);
    return { seeded: sum("seeded"), detected: sum("detected"), missed: sum("missed"), detectedLabeled: sum("detectedLabeled"), reachable: sum("reachable"), detectionRate: rate(sum("detected"), sum("seeded")) };
}

/**
 * Tests, findings, confirmed findings and false positives per layer (the engine's meta.layer; "unlabelled" for a test or finding without
 * one). `tests` are the layers of the tests read, one entry per test.
 */
export function layerCounts(tests: Array<string | undefined>, findings: Array<Pick<BenchFinding, "layer" | "category" | "label" | "reason">>): Record<string, LayerCounts> {
    const out: Record<string, LayerCounts> = {};
    const row = (l: string | undefined) => (out[l ?? "unlabelled"] ??= { tests: 0, findings: 0, confirmed: 0, falsePositives: 0 });
    for (const l of tests) row(l).tests++;
    for (const f of findings) {
        const r = row(f.layer);
        r.findings++;
        if (f.category === "confirmed") r.confirmed++;
        if (!NOT_REPORTED.test(f.reason ?? "") && (f.category === "false_positive" || (f.category === "unreproduced" && f.label === "false_positive"))) r.falsePositives++;
    }
    return out;
}

/**
 * A saved result scored again by the current rules, offline: the categories the replays gave stay as they are, so detection cannot change;
 * every count is recomputed from the findings, the other numbers (cost, time, tests) are kept. Extension seeds (`extension`, the ids the
 * result's catalogue marks so) are scored apart, as when the result was made. Returns a copy.
 */
export function rescored(b: Benchmark, unreachable: string[], extension: string[] = []): Benchmark {
    const apps = b.apps.map((a) => {
        const m = a.metrics;
        const inputs = { ...m, seeded: a.seededDefects.filter((d) => !extension.includes(d)), findings: a.findings, startedAt: "1970-01-01T00:00:00.000Z", unreachable };
        const metrics = { ...benchMetrics(inputs), detectionTimeMs: m.detectionTimeMs };
        const ext = a.seededDefects.filter((d) => extension.includes(d));
        return { ...a, metrics, ...(ext.length ? { extension: extensionScore({ ...inputs, seeded: ext }) } : {}), defects: a.defects.map((d) => ({ ...d, ...(unreachable.includes(d.id) ? { unreachable: true } : {}) })) };
    });
    const ext = combineExtension(apps.map((a) => a.extension));
    return { ...b, scoring: SCORING_VERSION, apps, metrics: combineMetrics(apps.map((a) => a.metrics)), ...(ext ? { extension: ext } : {}) };
}

/**
 * The estimated cost of AI use from token counts and a price table (USD per million tokens), the same arithmetic as the platform's
 * usage page (engine/llm/usage.ts costOf): cache reads at the cached price, cache writes at the write price, the rest at the input price.
 * Null when the model has no price.
 */
export function costOfTokens(t: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }, price: { inputPerMTok: number; outputPerMTok: number; cachedInputPerMTok?: number; cacheWritePerMTok?: number } | undefined): number | null {
    if (!price) return null;
    const read = Math.min(Math.max(0, t.cacheReadTokens), t.inputTokens);
    const write = Math.min(Math.max(0, t.cacheWriteTokens), t.inputTokens - read);
    const plain = t.inputTokens - read - write;
    return (plain * price.inputPerMTok + read * (price.cachedInputPerMTok ?? price.inputPerMTok) + write * (price.cacheWritePerMTok ?? price.inputPerMTok) + t.outputTokens * price.outputPerMTok) / 1_000_000;
}
