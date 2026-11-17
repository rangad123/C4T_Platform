/**
 * "Observed vs captured" (pure; unit-tested in tests/bench-observed-unit.test.ts): of the findings a benchmark reported, which ones the saved
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
 */
import type { BenchFinding, Benchmark, ReplayVerdict } from "./schema.js";

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
            rows.push({ app: a.id, testKey: f.testKey, source: f.source, ...(f.capture ? { capture: f.capture } : {}), seeded: f.replay.seeded, clean: f.replay.clean, kind, ...(f.label ? { label: f.label } : {}) });
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
    return { rows, counts, e1: ratio(reproduced, authoring), e2: ratio(isolated, reproduced), cleanNotRun, observedDefects: [...defects].sort(), observedUnlabelled, authorCapture };
}

/**
 * A person's labels (`{ "<app>/<testKey>": "<defect id>" | "false_positive" }`, the bench `--labels` format) applied as the benchmark applies
 * them: only to findings the replays could not verify, and only a defect seeded in that app or false_positive. Returns a copy.
 */
export function withLabels(b: Benchmark, labels: Record<string, string>): Benchmark {
    return {
        ...b,
        apps: b.apps.map((a) => ({
            ...a,
            findings: a.findings.map((f) => {
                const l = labels[`${a.id}/${f.testKey}`];
                return l && f.category === "unreproduced" && (l === "false_positive" || a.seededDefects.includes(l)) ? { ...f, label: l } : f;
            }),
        })),
    };
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
