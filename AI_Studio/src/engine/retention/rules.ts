/**
 * What a retention policy may remove. Pure: rows and a clock in, a plan out. The preview and the real run both call
 * `planPrune` with the same rows, so what the preview promises is exactly what the run does.
 *
 * The order of the rules is the safety design. For every evidence file, the first rule that applies decides:
 *   1. kind        only screenshots, recordings, traces, recorded network calls and visual-diff images are ever removed;
 *                  approved visual baselines and everything else (app models, reports...) are never touched
 *   2. no run      a file that does not belong to a run is never removed
 *   3. latest runs the newest `keepLatestRuns` runs of every test (per browser / environment) are kept
 *   4. failure     the newest run of a test that is not passing keeps its files (what the test page shows today)
 *   5. visual      the newest run that holds new/different screenshots of a test whose latest run did not pass
 *                  (a change waiting to be accepted as the new baseline)
 *   6. issue       the failed run an issue was filed from
 *   7. release     the newest run of each test at the moment each release (open or signed) was snapshotted
 *   8. age         older than `keepDays` (passed runs) or `keepFailedDays` (anything else): removed
 * A file that is protected by 3-7 but old enough to be removed is counted under the rule that saved it.
 * Then, when a size limit is set, the oldest files nothing protects are removed until the project fits.
 */
import type { RetentionPolicy } from "./policy.js";

export const DAY_MS = 86_400_000;

/** The kinds of file a policy may remove. Everything else a run stores (baselines, app models, reports) stays. */
export const PRUNABLE_KINDS = ["screenshot", "video", "trace", "evidence", "visual-actual", "visual-diff", "vision-shot"] as const;
export type PrunableKind = (typeof PRUNABLE_KINDS)[number];
export const isPrunableKind = (k: string): k is PrunableKind => (PRUNABLE_KINDS as readonly string[]).includes(k);

const VISUAL_KINDS = new Set(["visual-actual", "visual-diff"]);

export interface RetentionExecution {
    id: string;
    testId: string;
    /** "" for the main run, otherwise the browser variant or the environment ("variant:firefox", "env:staging"). */
    group: string;
    /** Epoch ms. */
    startedAt: number;
    passed: boolean;
}

export interface RetentionArtifact {
    id: string;
    kind: string;
    size: number;
    executionId: string | null;
    /** Epoch ms of the run the file belongs to (its creation time when it has none). */
    at: number;
}

export interface RetentionInput {
    now: number;
    policy: RetentionPolicy;
    executions: RetentionExecution[];
    /** Files not yet removed. */
    artifacts: RetentionArtifact[];
    /** test id -> epoch ms at which an issue was filed for it. */
    issueTimes: Map<string, number[]>;
    /** Epoch ms at which each release (open or signed) was snapshotted. */
    releaseMoments: number[];
}

export type KeepReason = "kind" | "no-run" | "latest-runs" | "failure" | "visual" | "issue" | "release";
export type PruneReason = "age" | "age-failed" | "size-cap";

export interface PlannedPrune {
    id: string;
    kind: string;
    size: number;
    at: number;
    reason: PruneReason;
}

export interface PrunePlan {
    /** Oldest first. */
    prune: PlannedPrune[];
    files: number;
    bytes: number;
    oldest: number | null;
    newest: number | null;
    byKind: Record<string, { files: number; bytes: number }>;
    byReason: Record<PruneReason, number>;
    /** Files old enough to go that a rule kept. */
    protectedFiles: Record<KeepReason, number>;
}

const emptyKeep = (): Record<KeepReason, number> => ({ kind: 0, "no-run": 0, "latest-runs": 0, failure: 0, visual: 0, issue: 0, release: 0 });

const groupKey = (e: RetentionExecution) => `${e.testId}\u0000${e.group}`;
const newestFirst = (a: RetentionExecution, b: RetentionExecution) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1);

/** Which runs each protecting rule keeps. Exposed for the tests. */
export function protectedRuns(input: Pick<RetentionInput, "executions" | "artifacts" | "issueTimes" | "releaseMoments" | "policy">): Map<string, KeepReason> {
    const out = new Map<string, KeepReason>();
    const keep = (id: string, why: KeepReason) => {
        if (!out.has(id)) out.set(id, why);
    };

    const groups = new Map<string, RetentionExecution[]>();
    for (const e of input.executions) {
        const k = groupKey(e);
        const list = groups.get(k);
        if (list) list.push(e);
        else groups.set(k, [e]);
    }
    for (const list of groups.values()) list.sort(newestFirst);

    // 3. the newest runs of every test (per browser / environment)
    for (const list of groups.values()) for (const e of list.slice(0, input.policy.keepLatestRuns)) keep(e.id, "latest-runs");
    // 4. a test whose newest run did not pass keeps that run's files
    for (const list of groups.values()) if (list[0] && !list[0].passed) keep(list[0].id, "failure");

    // 5. a visual change still waiting to be accepted: the newest run that has new/different screenshots, for a test whose main run does not pass
    const visualRuns = new Set(input.artifacts.filter((a) => VISUAL_KINDS.has(a.kind) && a.executionId).map((a) => a.executionId!));
    const tests = new Set(input.executions.map((e) => e.testId));
    for (const testId of tests) {
        const main = groups.get(`${testId}\u0000`);
        if (!main?.[0] || main[0].passed) continue;
        const withVisual = main.find((e) => visualRuns.has(e.id));
        if (withVisual) keep(withVisual.id, "visual");
    }

    // 6. the failed run an issue was filed from: per group, the newest run that did not pass at or before the moment the issue was filed
    for (const [testId, times] of input.issueTimes) {
        for (const [key, list] of groups) {
            if (!key.startsWith(`${testId}\u0000`)) continue;
            for (const t of times) {
                const from = list.find((e) => !e.passed && e.startedAt <= t);
                if (from) keep(from.id, "issue");
            }
        }
    }

    // 7. what each release looked at: per test and group, the newest run at or before the moment of its snapshot
    for (const moment of input.releaseMoments) {
        for (const list of groups.values()) {
            const at = list.find((e) => e.startedAt <= moment);
            if (at) keep(at.id, "release");
        }
    }
    return out;
}

export function planPrune(input: RetentionInput): PrunePlan {
    const { policy, now } = input;
    const byId = new Map(input.executions.map((e) => [e.id, e]));
    const kept = protectedRuns(input);
    const protectedFiles = emptyKeep();
    const prune: PlannedPrune[] = [];
    const unprotected: RetentionArtifact[] = [];
    let remaining = 0;

    for (const a of input.artifacts) {
        if (!isPrunableKind(a.kind)) {
            protectedFiles.kind++;
            continue;
        }
        remaining += a.size;
        const exec = a.executionId ? byId.get(a.executionId) : undefined;
        if (!exec) {
            protectedFiles["no-run"]++;
            continue;
        }
        const keepDays = exec.passed ? policy.keepDays : policy.keepFailedDays;
        // Older than N days means strictly more than N whole days: a file exactly N days old is still kept.
        const old = now - a.at > keepDays * DAY_MS;
        const why = kept.get(exec.id);
        if (why) {
            if (old) protectedFiles[why]++;
            continue;
        }
        if (old) prune.push({ id: a.id, kind: a.kind, size: a.size, at: a.at, reason: exec.passed ? "age" : "age-failed" });
        else unprotected.push(a);
    }

    // The size limit: oldest first, only files nothing protects, until what is left fits.
    if (policy.maxArtifactMB) {
        const limit = policy.maxArtifactMB * 1024 * 1024;
        remaining -= prune.reduce((n, p) => n + p.size, 0);
        for (const a of [...unprotected].sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1))) {
            if (remaining <= limit) break;
            prune.push({ id: a.id, kind: a.kind, size: a.size, at: a.at, reason: "size-cap" });
            remaining -= a.size;
        }
    }

    prune.sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1));
    const byKind: PrunePlan["byKind"] = {};
    const byReason: PrunePlan["byReason"] = { age: 0, "age-failed": 0, "size-cap": 0 };
    for (const p of prune) {
        const k = (byKind[p.kind] ??= { files: 0, bytes: 0 });
        k.files++;
        k.bytes += p.size;
        byReason[p.reason]++;
    }
    return {
        prune,
        files: prune.length,
        bytes: prune.reduce((n, p) => n + p.size, 0),
        oldest: prune[0]?.at ?? null,
        newest: prune.length ? prune[prune.length - 1]!.at : null,
        byKind,
        byReason,
        protectedFiles,
    };
}
