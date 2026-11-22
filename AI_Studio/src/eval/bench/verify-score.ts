/**
 * Verification scoring (testing-engine Phase 5 B1, PHASE_5_7_SPEC §5.2): V1–V8 and V11 of one trial, from the trial's results JSON
 * (BenchAppResult: the harness truth, never the engine's) and what the platform recorded about its findings (the lifecycle state, the
 * last event's reason, the class, the confidence, the duplicate group; later the report fields of C3 and the root cause of C2).
 * Seed locations (p57-wave0/p5-corpus/seed-locations.json, W0-3) are the V7 truth.
 *
 * Nothing missing is ever a 0: a trial without verification data has every criterion "not measured", and so does a criterion whose own
 * input is missing (no report fields yet, no root causes, no seed locations, no added cost). A measured criterion with an empty
 * denominator has value null and says why.
 */
import type { FindingConfidence } from "../../engine/explore/finding.js";
import type { FindingState } from "../../engine/findings/lifecycle.js";
import type { CandidateFindingStore } from "../../platform/candidate-finding-store.js";
import type { BenchAppResult, BenchFinding } from "./schema.js";

/** The 13 report fields (spec §5.1 item 7). Only `likelyCause` may be "unknown", and then with a reason. */
export const REPORT_FIELDS = ["title", "severity", "confidence", "area", "environment", "preconditions", "steps", "expected", "actual", "reproductionRate", "evidence", "likelyCause", "nextStep"] as const;
export type ReportField = (typeof REPORT_FIELDS)[number];
export const ROOT_CAUSE_LABELS = ["verified", "strongly_supported", "hypothesis", "unknown"] as const;

/** One platform finding of the trial, as the verification left it. */
export interface VerifiedFinding {
    id: string;
    testId: string | null;
    state: FindingState;
    /** The reason of the finding's last lifecycle event. */
    reason: string | null;
    groupId: string | null;
    /** classify.ts's class, `open`, or null before classification. */
    findingClass: string | null;
    confidence: FindingConfidence | null;
    /** A security finding: its severity and whether H5 reproduced it. */
    security?: { severity: string; reproduced: boolean };
    /** C3's report; absent until C3 lands. */
    report?: Partial<Record<ReportField, string | null>>;
    /** C2's root cause; `exists` is the location check's result. */
    rootCause?: { label: (typeof ROOT_CAUSE_LABELS)[number]; locations: Array<{ path: string; line?: number; fn?: string; route?: string; exists: boolean }> };
}

export interface Verification {
    findings: VerifiedFinding[];
    /** What verification added to the trial: AI cost and job time (null when not recorded). */
    added: { cost: number | null; durationMs: number | null };
}

/** W0-3: the function holding a seed's `on("BS-…")` line and the routes that reach it. */
export interface SeedLocation {
    seed: string;
    file: string;
    line: number;
    handler: string;
    routes: string[];
}

export type Measure<T> = ({ measured: true } & T) | { measured: false; why: string };
type Rate = { value: number | null; n: number; note?: string };

export interface VerifyScore {
    V1: Measure<Rate & { listPrecision: number | null }>;
    V2: Measure<Rate & { unconfirmedWithoutReason: string[] }>;
    V3: Measure<Rate & { silent: string[] }>;
    V4: Measure<{ fp: Rate & { decided: number | null }; labelled: Rate & { decided: number | null } }>;
    V5: Measure<{ mixed: number; groupsPerSeed: Record<string, number>; median: number | null }>;
    V6: Measure<{ confirmedBelowHigh: number; securityWithoutH5: number }>;
    V7: Measure<{ invented: number } & Rate>;
    V8: Measure<Rate & { incomplete: string[] }>;
    V11: Measure<{ cost: number | null; time: number | null }>;
}

/** Confirmed and what can only follow it. */
const CONFIRMED: readonly FindingState[] = ["confirmed", "classified", "reported"];
const UNFINISHED: readonly FindingState[] = ["detected", "candidate", "verification_pending"];

const no = (why: string) => ({ measured: false as const, why });
const rate = (a: number, b: number, empty: string): Rate => (b > 0 ? { value: a / b, n: b } : { value: null, n: 0, note: empty });
const median = (xs: number[]): number | null => {
    const s = [...xs].sort((a, b) => a - b);
    const n = s.length;
    return n === 0 ? null : n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
};
const isApp = (c: string | null) => c === "app_defect";
/** A seed the harness pinned the finding to, else the one a person labelled it with. */
const seedsOf = (b: BenchFinding | undefined): string[] => (b ? (b.defects.length ? b.defects : b.label && b.label !== "false_positive" ? [b.label] : []) : []);

export function verifyScore(trial: BenchAppResult, v: Verification | undefined, opts: { seedLocations?: readonly SeedLocation[]; describesSeed?: readonly string[] } = {}): VerifyScore {
    if (!v) {
        const why = "The trial has no verification data.";
        return { V1: no(why), V2: no(why), V3: no(why), V4: no(why), V5: no(why), V6: no(why), V7: no(why), V8: no(why), V11: no(why) };
    }
    const bench = new Map(trial.findings.map((f) => [f.id, f]));
    const benchOf = (f: VerifiedFinding) => (f.testId ? bench.get(f.testId) : undefined);
    const byTest = new Map(v.findings.filter((f) => f.testId).map((f) => [f.testId!, f]));
    const groups = new Map<string, VerifiedFinding[]>();
    for (const f of v.findings) groups.set(f.groupId ?? `solo:${f.id}`, [...(groups.get(f.groupId ?? `solo:${f.id}`) ?? []), f]);
    const confirmedGroups = [...groups.values()].filter((g) => g.some((f) => CONFIRMED.includes(f.state)));

    // V1, V2
    const harnessConfirms = (g: VerifiedFinding[]) => g.some((f) => benchOf(f)?.category === "confirmed");
    const V1 = { measured: true as const, ...rate(confirmedGroups.filter(harnessConfirms).length, confirmedGroups.length, "Nothing was Confirmed."), listPrecision: trial.metrics.precision };
    const truth = trial.findings.filter((b) => b.category === "confirmed");
    const engineOf = (b: BenchFinding) => byTest.get(b.id);
    const V2 = {
        measured: true as const,
        ...rate(truth.filter((b) => CONFIRMED.includes(engineOf(b)?.state as FindingState)).length, truth.length, "The harness confirmed nothing."),
        unconfirmedWithoutReason: truth.filter((b) => engineOf(b)?.state === "unconfirmed" && !engineOf(b)?.reason?.trim()).map((b) => b.id),
    };

    // V3: an unfinished state, or a state without a reason, is silent.
    const silent = v.findings.filter((f) => UNFINISHED.includes(f.state) || !f.reason?.trim()).map((f) => f.id);
    const V3 = { measured: true as const, ...rate(v.findings.length - silent.length, v.findings.length, "The trial has no findings."), silent };

    // V4: (a) harness false positives that describe no seed; (b) person labels. Open counts as not an app defect in `value`; `decided` counts only decided classes.
    const described = new Set(opts.describesSeed ?? []);
    const fps = trial.findings.filter((b) => b.category === "false_positive" && !described.has(b.id) && !(b.label && b.label !== "false_positive")).flatMap((b) => {
        const f = engineOf(b);
        return f?.findingClass ? [f.findingClass] : [];
    });
    const labelled = trial.findings.filter((b) => b.label).flatMap((b) => {
        const f = engineOf(b);
        return f?.findingClass ? [{ app: b.label !== "false_positive", c: f.findingClass }] : [];
    });
    const decidedOk = (c: string, app: boolean) => c !== "open" && isApp(c) === app;
    const V4 = {
        measured: true as const,
        fp: {
            ...rate(fps.filter((c) => !isApp(c)).length, fps.length, "No classified harness false positive that describes no seed."),
            decided: fps.length ? fps.filter((c) => decidedOk(c, false)).length / fps.length : null,
            ...(opts.describesSeed ? {} : { note: "No seed-description list given: only false positives a person labelled with a seed are left out." }),
        },
        labelled: {
            ...rate(labelled.filter((l) => (l.c === "open" ? !l.app : isApp(l.c) === l.app)).length, labelled.length, "No classified person label."),
            decided: labelled.length ? labelled.filter((l) => decidedOk(l.c, l.app)).length / labelled.length : null,
        },
    };

    // V5
    const perSeed: Record<string, number> = {};
    let mixed = 0;
    for (const g of groups.values()) {
        const seeds = new Set(g.flatMap((f) => seedsOf(benchOf(f))));
        // Mixed: two of its findings are pinned to different seeds (no seed in common). One finding whose pin names several is not.
        const pins = g.map((f) => seedsOf(benchOf(f))).filter((p) => p.length);
        if (pins.some((p, i) => pins.slice(i + 1).some((q) => !q.some((x) => p.includes(x))))) mixed++;
        for (const s of seeds) perSeed[s] = (perSeed[s] ?? 0) + 1;
    }
    const V5 = { measured: true as const, mixed, groupsPerSeed: perSeed, median: median(Object.values(perSeed)) };

    // V6
    const confirmed = v.findings.filter((f) => CONFIRMED.includes(f.state));
    const V6 = {
        measured: true as const,
        confirmedBelowHigh: confirmed.filter((f) => f.confidence !== "high").length,
        securityWithoutH5: confirmed.filter((f) => f.security && (f.security.severity === "critical" || f.security.severity === "high") && !f.security.reproduced).length,
    };

    // V7
    const withCause = v.findings.filter((f) => f.rootCause);
    let V7: VerifyScore["V7"];
    if (!withCause.length) V7 = no("No finding has a root cause (C2).");
    else if (!opts.seedLocations?.length) V7 = no("No seed locations were given.");
    else {
        const loc = new Map(opts.seedLocations.map((s) => [s.seed, s]));
        const hits = (f: VerifiedFinding, s: SeedLocation) =>
            (f.rootCause?.label === "verified" || f.rootCause?.label === "strongly_supported") &&
            f.rootCause.locations.some((l) => l.exists && ((l.route !== undefined && s.routes.includes(l.route)) || (l.path.endsWith(s.file) && (l.fn === s.handler || l.line === s.line))));
        const seeded = confirmedGroups.flatMap((g) => {
            const s = [...new Set(g.flatMap((f) => seedsOf(benchOf(f))))].map((id) => loc.get(id)).filter((x): x is SeedLocation => !!x);
            return s.length ? [{ g, s }] : [];
        });
        V7 = {
            measured: true,
            invented: withCause.reduce((n, f) => n + f.rootCause!.locations.filter((l) => !l.exists).length, 0),
            ...rate(seeded.filter(({ g, s }) => g.some((f) => s.some((x) => hits(f, x)))).length, seeded.length, "No Confirmed group of a located seed."),
        };
    }

    // V8
    const reported = confirmed.filter((f) => f.report);
    let V8: VerifyScore["V8"];
    if (!reported.length) V8 = no("No Confirmed finding has a report (C3).");
    else {
        const complete = (r: NonNullable<VerifiedFinding["report"]>) =>
            REPORT_FIELDS.every((k) => {
                const t = r[k]?.trim() ?? "";
                if (!t) return false;
                // "unknown" alone is never complete; with a reason only for the likely cause.
                return !/^unknown\b/i.test(t) || (k === "likelyCause" && t.replace(/^unknown\b[\s:—-]*/i, "").length > 0);
            });
        const incomplete = confirmed.filter((f) => !f.report || !complete(f.report)).map((f) => f.id);
        V8 = { measured: true, ...rate(confirmed.length - incomplete.length, confirmed.length, "Nothing was Confirmed."), incomplete };
    }

    // V11: added cost and time as a share of the trial's own.
    const share = (a: number | null, b: number | null) => (a === null || b === null || b <= 0 ? null : a / b);
    const V11: VerifyScore["V11"] =
        v.added.cost === null && v.added.durationMs === null
            ? no("The trial recorded no added cost or time for verification.")
            : { measured: true, cost: share(v.added.cost, trial.metrics.cost), time: share(v.added.durationMs, trial.metrics.durationMs) };

    return { V1, V2, V3, V4, V5, V6, V7, V8, V11 };
}

/** The trial's verification data as the platform stored it (candidate findings and their last event); `added` comes from the jobs. */
export async function verificationOf(store: CandidateFindingStore, projectId: string, added: Verification["added"]): Promise<Verification> {
    const rows = await store.list(projectId);
    const findings = await Promise.all(
        rows.map(async (r) => ({
            id: r.id,
            testId: r.testId,
            state: r.state,
            reason: (await store.history(projectId, r.id)).at(-1)?.reason ?? null,
            groupId: r.groupId,
            findingClass: r.findingClass,
            confidence: r.confidenceDetail?.confidence ?? null,
        })),
    );
    return { findings, added };
}
