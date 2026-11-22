/**
 * Effectiveness metrics (testing-engine Phase 7 B3, PHASE_5_7_SPEC §7.1 item 2) of one trial (one app of one result), from the result and
 * the trial's saved platform data (readSavedTrial):
 *
 *   time to first confirmed seed   job start (the earliest `job_started` of the app's jobs) to the earliest moment the platform named a
 *                                  test that the replays confirmed against a seeded defect: an event naming it, else its first failure
 *   suite stability                the saved suite (tests that passed in the run that made them) over the harness's reruns of every
 *                                  created test (`--repeat`): passed runs / runs that ran; no AI
 *   workflow coverage              the exploration's coverage record (workflow steps exercised / steps), and the harness's own count
 *                                  (catalogue workflows a test reached / workflows)
 *   reproduction rate              the replays' (findings that failed again with the defects on / findings) and Phase 5's (findings
 *                                  verification reproduced / findings it decided)
 *   mutation score                 deliberate faults caught / faults, over the validated tests the engine scored (mutation/faults.ts,
 *                                  its `strength_scored` events; the last score of a test counts)
 *
 * Nothing missing is ever a 0: a metric whose input is absent is "not measured" with the reason; a measured one with an empty
 * denominator has value null and says why.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { FindingState } from "../../engine/findings/lifecycle.js";
import { LayerReportSchema, type LayerReport } from "../../engine/validation/layers.js";
import type { BenchAppResult, ReplayVerdict } from "./schema.js";
import type { Measure } from "./verify-score.js";

/** What a trial's platform data holds for one project, as far as B3 and B4 read it. */
export interface SavedTrial {
    events: Array<{ jobId: string | null; kind: string; message: string; data: unknown; at: string }>;
    tests: Array<{ id: string; key: string; title: string; validationStatus: string; validationReason: string | null; meta: unknown }>;
    /** The app model's rules with the requirement each came from; null: the data has no rules table (before Phase 2). */
    rules: Array<{ ref: string; sourceRef: string | null }> | null;
    /** The latest exploration's coverage record (only the part read here); null: none kept. */
    coverage: { workflowSteps: { total: number; exercised: number } } | null;
    /** The latest C12 layer report; null: none kept (before Phase 4). */
    layers: LayerReport | null;
}

/** A created test's runs as the evaluation entry kept them (EvalRun entries[].tests). */
export interface EntryTest {
    id: string;
    testId: string;
    firstRun: ReplayVerdict | null;
    reruns: ReplayVerdict[];
}

type Rate = { value: number | null; n: number; note?: string };
export interface Effectiveness {
    timeToFirstConfirmedSeed: Measure<{ value: number | null; seed: string | null; testKey: string | null; note?: string }>;
    stability: Measure<Rate & { tests: number; unstable: string[] }>;
    workflowCoverage: { record: Measure<Rate>; catalogue: Rate };
    reproduction: { replay: Rate; verification: Measure<Rate> };
    mutationScore: Measure<Rate & { tests: number }>;
}

const no = (why: string) => ({ measured: false as const, why });
const rate = (a: number, b: number, empty: string): Rate => (b > 0 ? { value: a / b, n: b } : { value: null, n: 0, note: empty });
const REPRODUCED: readonly FindingState[] = ["reproduced", "confirmed", "classified", "reported", "fixed", "accepted_risk"];
const UNDECIDED: readonly FindingState[] = ["detected", "candidate", "verification_pending", "duplicate"];
const field = (d: unknown, k: string): unknown => (d && typeof d === "object" ? (d as Record<string, unknown>)[k] : undefined);
/** The test key an event is about: its data's testKey/testId, else the key its message starts with. */
export const eventTestKey = (e: SavedTrial["events"][number]): string | undefined => {
    const k = field(e.data, "testKey") ?? field(e.data, "testId");
    return typeof k === "string" ? k : /^([A-Z]+-\d+)\b/.exec(e.message)?.[1];
};

export function effectiveness(trial: BenchAppResult, saved: SavedTrial | undefined, entryTests?: readonly EntryTest[]): Effectiveness {
    // Time to first confirmed seed.
    let time: Effectiveness["timeToFirstConfirmedSeed"];
    const starts = (saved?.events ?? []).filter((e) => e.kind === "job_started").map((e) => Date.parse(e.at)).filter(Number.isFinite);
    if (!saved) time = no("The trial's platform data was not read.");
    else if (!starts.length) time = no("No job start was recorded for the app's jobs.");
    else {
        const start = Math.min(...starts);
        const seeded = new Set(trial.seededDefects);
        let best: { value: number; seed: string; testKey: string } | null = null;
        for (const f of trial.findings) {
            const seed = f.category === "confirmed" ? f.defects.find((d) => seeded.has(d)) : undefined;
            if (!seed) continue;
            const named = saved.events.filter((e) => eventTestKey(e) === f.testKey).map((e) => Date.parse(e.at));
            const at = Math.min(...[...named, f.firstSeenAt ? Date.parse(f.firstSeenAt) : NaN].filter(Number.isFinite));
            if (Number.isFinite(at) && (!best || at - start < best.value)) best = { value: Math.max(0, at - start), seed, testKey: f.testKey };
        }
        const anyConfirmed = trial.findings.some((f) => f.category === "confirmed" && f.defects.some((d) => seeded.has(d)));
        time = best ? { measured: true, ...best } : { measured: true, value: null, seed: null, testKey: null, note: anyConfirmed ? "No event or failure time names a confirmed test." : "No seed was confirmed." };
    }

    // Stability: shortcut: reruns are on the trial's app (defects in), not a clean app; a saved test passed there when made, so a failed rerun is instability. Upgrade with a clean-app rerun stage in the harness.
    let stability: Effectiveness["stability"];
    const suite = (entryTests ?? []).filter((t) => t.firstRun === "passed");
    const ran = suite.map((t) => ({ t, runs: t.reruns.filter((v) => v !== "not_run") }));
    const total = ran.reduce((n, r) => n + r.runs.length, 0);
    if (!entryTests) stability = no("The trial's created tests and their reruns were not given.");
    else if (!total) stability = no("No rerun of the saved suite ran (run the trial with --repeat).");
    else {
        const passed = ran.reduce((n, r) => n + r.runs.filter((v) => v === "passed").length, 0);
        stability = { measured: true, ...rate(passed, total, ""), tests: suite.length, unstable: ran.filter((r) => r.runs.some((v) => v !== "passed")).map((r) => r.t.testId) };
    }

    const steps = saved?.coverage?.workflowSteps;
    const workflowCoverage = {
        record: steps ? { measured: true as const, ...rate(steps.exercised, steps.total, "The coverage record lists no workflow step.") } : no("The trial kept no coverage record (it did not explore by objectives)."),
        catalogue: rate(trial.metrics.workflowsCovered, trial.metrics.workflows, "The app has no catalogue workflow."),
    };

    const decided = trial.verification?.findings.filter((f) => !UNDECIDED.includes(f.state));
    const reproduction = {
        replay: trial.metrics.reproductionRate === null ? { value: null, n: 0, note: "No finding was replayed." } : { value: trial.metrics.reproductionRate, n: trial.metrics.selectedForVerification },
        verification: decided ? { measured: true as const, ...rate(decided.filter((f) => REPRODUCED.includes(f.state)).length, decided.length, "Verification decided no finding.") } : no("The trial has no verification data."),
    };

    const scores = new Map<string, { caught: number; total: number }>();
    for (const e of [...(saved?.events ?? [])].filter((x) => x.kind === "strength_scored").sort((a, b) => a.at.localeCompare(b.at))) {
        const [k, caught, all] = [field(e.data, "testId"), field(e.data, "caught"), field(e.data, "total")];
        if (typeof k === "string" && typeof caught === "number" && typeof all === "number") scores.set(k, { caught, total: all });
    }
    const faults = [...scores.values()].reduce((n, s) => n + s.total, 0);
    const mutationScore: Effectiveness["mutationScore"] = scores.size
        ? { measured: true, ...rate([...scores.values()].reduce((n, s) => n + s.caught, 0), faults, "The scored tests had no applicable fault."), tests: scores.size }
        : no("The engine scored no test against deliberate faults in this trial.");

    return { timeToFirstConfirmedSeed: time, stability, workflowCoverage, reproduction, mutationScore };
}

/**
 * One project's saved data from a trial's data folder (`platform.db` and `generated-tests/`), opened read-only: a write through the
 * connection fails, so a saved trial is never changed.
 */
export function readSavedTrial(dataDir: string, projectId: string): SavedTrial {
    // As platform/db.ts loads it: the test runner's bundler does not know node:sqlite as a built-in.
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(`${pathToFileURL(path.join(dataDir, "platform.db")).href}?mode=ro`, { readOnly: true });
    try {
        const json = (s: unknown): unknown => {
            try {
                return typeof s === "string" ? JSON.parse(s) : null;
            } catch {
                return null;
            }
        };
        const events = (db.prepare("SELECT e.job_id, e.kind, e.message, e.data_json, e.created_at FROM agent_events e JOIN generation_jobs j ON j.id = e.job_id WHERE j.project_id = ? ORDER BY e.id").all(projectId) as Array<Record<string, string | null>>).map((r) => ({
            jobId: r.job_id ?? null,
            kind: r.kind ?? "",
            message: r.message ?? "",
            data: json(r.data_json),
            at: r.created_at ?? "",
        }));
        const tests = (db.prepare("SELECT id, test_key, title, validation_status, validation_reason, generation_meta_json FROM test_cases WHERE project_id = ?").all(projectId) as Array<Record<string, string | null>>).map((r) => ({
            id: r.id!,
            key: r.test_key ?? "",
            title: r.title ?? "",
            validationStatus: r.validation_status ?? "",
            validationReason: r.validation_reason ?? null,
            meta: json(r.generation_meta_json),
        }));
        // Data from before Phase 2 has no rules table: not recorded (null), never "no rules".
        let rules: SavedTrial["rules"] = null;
        try {
            rules = (db.prepare("SELECT ref, source_ref FROM app_rules WHERE project_id = ?").all(projectId) as Array<{ ref: string; source_ref: string | null }>).map((r) => ({ ref: r.ref, sourceRef: r.source_ref }));
        } catch (e) {
            if (!/no such table/i.test(e instanceof Error ? e.message : String(e))) throw e;
        }
        const artifact = (kind: string): unknown => {
            const row = db.prepare("SELECT path FROM artifacts WHERE project_id = ? AND kind = ? AND pruned_at IS NULL ORDER BY created_at DESC LIMIT 1").get(projectId, kind) as { path: string } | undefined;
            const file = row && path.resolve(dataDir, "generated-tests", row.path);
            // The stored path stays inside the trial's folder.
            if (!file || !file.startsWith(path.resolve(dataDir) + path.sep) || !fs.existsSync(file)) return null;
            return json(fs.readFileSync(file, "utf8"));
        };
        const steps = field(field(artifact("exploration"), "coverage"), "workflowSteps");
        const layers = LayerReportSchema.safeParse(artifact("layer-report"));
        return {
            events,
            tests,
            rules,
            coverage: typeof field(steps, "total") === "number" && typeof field(steps, "exercised") === "number" ? { workflowSteps: steps as { total: number; exercised: number } } : null,
            layers: layers.success ? layers.data : null,
        };
    } finally {
        db.close();
    }
}
