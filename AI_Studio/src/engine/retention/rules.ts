/**
 * What a retention policy may remove. Pure: rows and a clock in, a plan out. The preview and the real run both call
 * `planPrune` with the same rows, so what the preview promises is exactly what the run does.
 *
 * Expiry is decided by the run a file belongs to, its outcome and its age, over every kind of file a run stores (so a kind
 * added later is covered without a change here). For every stored file, the first rule that applies decides:
 *   1. kind        approved visual baselines are never removed (they are the project's reference, not a run's evidence)
 *   2. no run      a file that does not belong to a run (plans, app models, reports...) is never removed, except the screenshots
 *                  an agent run takes (`vision-shot` without a test run): those are a run's media too and count as a failed run's,
 *                  removed after `keepFailedDays` from the agent run's job (the platform passes the job's start as `at`; a row with no
 *                  job, or whose job is gone, counts from its own creation time)
 *   3. passed run  traces and recordings: removed at the next pass (passed runs keep no full trace or recording);
 *                  everything else (its evidence record, screenshots...): removed after `keepDays`
 *   4. other run   (failed, broken, skipped...): everything removed after `keepFailedDays`
 * Nothing else keeps a run's files: not being the latest run, a failing test, an issue or a release. What a finding or an issue
 * says about a run (its rows, status and history) is never touched here; only the files go, and the reader then says they expired.
 * Then, when a size limit is set, the oldest files that are not yet due are removed until the project fits.
 * The limit counts only files it may remove: a file held by the first-deploy grace or by an unreadable time (below) is left out of the
 * sum (`heldBytes`), so what is held never pushes newer files out. Once the grace is over its files count again, oldest first.
 * First-deploy grace (files here, and the same for every record's text via `graceHolds`): for GRACE_DAYS after the platform first ran a version with retention (`graceFrom`), a file
 * created before that moment is never removed (not by age, not by the size limit); after it, the rules above apply to it as to any file.
 * A file created after that moment follows the rules from the start.
 * A file whose time cannot be read (`at` 0 or not a number: an unparseable run start) is never removed by age or by the size limit:
 * its age is unknown (a passed run's trace or recording still goes, as that rule does not depend on age). It is kept and counted in `undated`, so the preview can say so; its run's details are not cleared either.
 *
 * The run rows themselves stay (id, test, outcome, timing, attempt, who and which version ran: trends, flaky detection and audit read
 * them), but once a run is past its period (passed: `keepDays`, any other outcome: `keepFailedDays`) the details it holds about the
 * application go with its files: the run's failure message and its steps' failure messages (they quote page text, addresses and
 * requests). `expiredRuns` lists the runs past their period that still hold such details; the platform clears them in the same pass.
 */
import { A11Y_FAILURE_PREFIX } from "../a11y/audit.js";
import { CONTRACT_FAILURE_PREFIX } from "../contracts/check.js";
import { HEALTH_FAILURE_PREFIX, healthCheckOf } from "../health/checks.js";
import { ACCESS_FAILURE_PREFIX } from "../identity/access.js";
import { INPUT_FAILURE_PREFIX } from "../inputs/checks.js";
import { PHONE_A11Y_PREFIX, PHONE_ANR_PREFIX, PHONE_CRASH_PREFIX, PHONE_SLOW_START_PREFIX } from "../mobile/quality/findings.js";
import { LATENCY_FAILURE_PREFIX } from "../performance/latency.js";
import { LOAD_FAILURE_PREFIX } from "../performance/load.js";
import { PERFORMANCE_FAILURE_PREFIX } from "../performance/checks.js";
import { SECURITY_FAILURE_PREFIX, securityCheckOf } from "../security/checks.js";
import { KNOWN_BUG_FIXED } from "../validation/runner.js";
import { VISION_FAILURE_PREFIX } from "../vision/verdict.js";
import type { RetentionPolicy } from "./policy.js";

export const DAY_MS = 86_400_000;

/** The evidence kinds a run records today (a backup carries these). Expiry itself is not limited to them. */
export const PRUNABLE_KINDS = ["screenshot", "video", "trace", "evidence", "visual-actual", "visual-diff", "vision-shot"] as const;
export type PrunableKind = (typeof PRUNABLE_KINDS)[number];
export const isPrunableKind = (k: string): k is PrunableKind => (PRUNABLE_KINDS as readonly string[]).includes(k);

/** Never removed, whatever run they belong to. */
const NEVER_REMOVED = new Set(["baseline"]);
/** Kinds whose files without a test run still expire: an agent run's screenshots (agent-run.ts, agent-on-runner.ts), as a failed run's media. */
const RUNLESS_MEDIA = new Set(["vision-shot"]);
/** Full traces and recordings: a passed run keeps none. */
const FULL_MEDIA = new Set(["trace", "video"]);

export interface RetentionExecution {
    id: string;
    /** Epoch ms. */
    startedAt: number;
    passed: boolean;
    /** The row still holds details about the application (a failure message on the run or a step). Undefined counts as yes. */
    details?: boolean;
}

export interface RetentionArtifact {
    id: string;
    kind: string;
    size: number;
    executionId: string | null;
    /** Epoch ms of the run the file belongs to (for an agent run's screenshot, its job's start; its creation time when it has neither). */
    at: number;
    /** Epoch ms the file was stored (its row's creation); for the first-deploy grace. Unknown (0 or missing) counts as before it. */
    createdAt?: number;
}

/** Days after the first deployment with retention during which files that existed before it are kept. */
export const GRACE_DAYS = 14;

export interface RetentionInput {
    now: number;
    policy: RetentionPolicy;
    executions: RetentionExecution[];
    /** Files not yet removed. */
    artifacts: RetentionArtifact[];
    /** Epoch ms of the first deployment with retention (the start of the first-deploy grace); undefined: no grace. */
    graceFrom?: number;
}

export type KeepReason = "kind" | "no-run";
export type PruneReason = "age" | "age-failed" | "passed-media" | "size-cap";

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
    /** Files that are never removed (baselines, files that belong to no run). */
    protectedFiles: Record<KeepReason, number>;
    /** Runs past their period whose rows still hold details about the application: those details are cleared (the rows stay). */
    expiredRuns: string[];
    /** Files kept because their time could not be read (age unknown). */
    undated: number;
    /** Files kept by the first-deploy grace (they existed before the first deployment with retention, which is under GRACE_DAYS ago). */
    grace: number;
    /** Bytes of the files held by the grace or by an unreadable time. The size limit does not count them. */
    heldBytes: number;
    /** Runs past their period whose details the first-deploy grace keeps (they started before the first deployment). */
    graceRuns: number;
}

/** A time the rules can age: a positive, finite epoch. 0 (what an unparseable date becomes) and NaN are unknown. */
const known = (at: number): boolean => Number.isFinite(at) && at > 0;

/**
 * The first-deploy grace: true while it runs (GRACE_DAYS from `graceFrom`) for anything dated before `graceFrom` (an unknown date counts
 * as before). Nothing that existed before the first deployment with retention is removed or cleared while this holds: files and text.
 * A date equal to `graceFrom` (the same millisecond, e.g. a file stored just as a damaged start row is repaired to "now") cannot be
 * ordered after it, so it counts as before: the grace fails towards keeping.
 */
export const graceHolds = (at: number, graceFrom: number | undefined, now: number): boolean =>
    graceFrom !== undefined && known(graceFrom) && now - graceFrom <= GRACE_DAYS * DAY_MS && !(known(at) && at > graceFrom);

export function planPrune(input: RetentionInput): PrunePlan {
    const { policy, now } = input;
    const byId = new Map(input.executions.map((e) => [e.id, e]));
    const protectedFiles: Record<KeepReason, number> = { kind: 0, "no-run": 0 };
    const prune: PlannedPrune[] = [];
    const notDue: RetentionArtifact[] = [];
    let remaining = 0;
    let undated = 0;
    let grace = 0;
    let heldBytes = 0;

    for (const a of input.artifacts) {
        if (NEVER_REMOVED.has(a.kind)) {
            protectedFiles.kind++;
            continue;
        }
        const exec = a.executionId ? byId.get(a.executionId) : undefined;
        if (!exec && !RUNLESS_MEDIA.has(a.kind)) {
            protectedFiles["no-run"]++;
            continue;
        }
        if (graceHolds(a.createdAt ?? 0, input.graceFrom, now)) {
            grace++; // existed before the first deployment: kept until the grace is over (not chosen by the size limit, not counted in it)
            heldBytes += a.size;
            continue;
        }
        if (!known(a.at) && !(exec?.passed && FULL_MEDIA.has(a.kind))) {
            undated++; // never chosen to go by age or size, and not counted in the size limit: its age is unknown (a passed run's trace goes regardless of age)
            heldBytes += a.size;
            continue;
        }
        remaining += a.size; // only what the limit may remove counts towards it: held bytes must not push newer files out
        const due = (days: number) => now - a.at > days * DAY_MS; // strictly more than N whole days: a file exactly N days old stays
        const reason: PruneReason | undefined = !exec ? (due(policy.keepFailedDays) ? "age-failed" : undefined) : exec.passed ? (FULL_MEDIA.has(a.kind) ? "passed-media" : due(policy.keepDays) ? "age" : undefined) : due(policy.keepFailedDays) ? "age-failed" : undefined;
        if (reason) prune.push({ id: a.id, kind: a.kind, size: a.size, at: a.at, reason });
        else notDue.push(a);
    }

    // The size limit: oldest first, until what is left fits.
    if (policy.maxArtifactMB) {
        const limit = policy.maxArtifactMB * 1024 * 1024;
        remaining -= prune.reduce((n, p) => n + p.size, 0);
        for (const a of [...notDue].sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1))) {
            if (remaining <= limit) break;
            prune.push({ id: a.id, kind: a.kind, size: a.size, at: a.at, reason: "size-cap" });
            remaining -= a.size;
        }
    }

    prune.sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1));
    // Strictly more than N whole days, as for files: a run exactly N days old keeps its details.
    const pastPeriod = input.executions.filter((e) => e.details !== false && known(e.startedAt) && now - e.startedAt > (e.passed ? policy.keepDays : policy.keepFailedDays) * DAY_MS);
    const expiredRuns = pastPeriod
        .filter((e) => !graceHolds(e.startedAt, input.graceFrom, now))
        .map((e) => e.id)
        .sort();
    const byKind: PrunePlan["byKind"] = {};
    const byReason: PrunePlan["byReason"] = { age: 0, "age-failed": 0, "passed-media": 0, "size-cap": 0 };
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
        oldest: prune.find((p) => known(p.at))?.at ?? null,
        newest: prune.findLast((p) => known(p.at))?.at ?? null,
        byKind,
        byReason,
        protectedFiles,
        expiredRuns,
        undated,
        grace,
        heldBytes,
        graceRuns: pastPeriod.length - expiredRuns.length,
    };
}

// ── other records at expiry ─────────────────────────────────────────────────
// Job events, job errors, test verdict reasons and agent-run steps hold failure text that quotes pages, addresses and requests.
// They expire by the same age rules as runs; the row stays, its details are replaced. Every function here is a fixpoint: applied to
// its own output it changes nothing, so a second pass is a no-op.

/** What expired failure text is replaced with. */
export const DETAILS_EXPIRED = "Details expired.";

/** Strictly more than N whole days, as for runs and files. */
export const isExpired = (at: number, passed: boolean, policy: RetentionPolicy, now: number): boolean => known(at) && now - at > (passed ? policy.keepDays : policy.keepFailedDays) * DAY_MS;

/** An address cut to its origin and path: no query, no fragment, no credentials. Text that is not an address loses anything after ? or #. */
export function originPath(url: string): string {
    try {
        const u = new URL(url);
        if (u.origin && u.origin !== "null") return u.origin + u.pathname;
    } catch {
        /* not an absolute address */
    }
    return url.split(/[?#]/)[0]!;
}

const cutUrls = (text: string) => text.replace(/\bhttps?:\/\/[^\s"'<>)]+/gi, (m) => originPath(m));

/** Event data with every `error` and `url` field removed, at any depth. Undefined when nothing changes; null for data that is not JSON. */
export function expiredEventData(json: string | null): string | null | undefined {
    if (json === null) return undefined;
    let data: unknown;
    try {
        data = JSON.parse(json);
    } catch {
        return null;
    }
    let changed = false;
    const walk = (x: unknown): void => {
        if (Array.isArray(x)) for (const v of x) walk(v);
        else if (x && typeof x === "object") {
            const o = x as Record<string, unknown>;
            for (const k of ["error", "url"]) if (k in o) (delete o[k], (changed = true));
            for (const v of Object.values(o)) walk(v);
        }
    };
    walk(data);
    return changed ? JSON.stringify(data) : undefined;
}

/**
 * The heads code reads a verdict reason by (quarantine's family check, engine/quarantine/rules.ts; severity, validation/severity.ts;
 * the phone quality and known-bug heads). An expired reason keeps the text up to its head, so those checks read it as before.
 * A check family's prefix follows the failed step's title ("Sign in — Security check failed: ..."); the other heads start the reason.
 */
const FAMILY_HEADS = [
    SECURITY_FAILURE_PREFIX, HEALTH_FAILURE_PREFIX, A11Y_FAILURE_PREFIX, CONTRACT_FAILURE_PREFIX, ACCESS_FAILURE_PREFIX, INPUT_FAILURE_PREFIX,
    PERFORMANCE_FAILURE_PREFIX, LATENCY_FAILURE_PREFIX, LOAD_FAILURE_PREFIX, VISION_FAILURE_PREFIX,
];
const START_HEADS = [
    PHONE_CRASH_PREFIX.trim(), PHONE_ANR_PREFIX.trim(), PHONE_SLOW_START_PREFIX.trim(), PHONE_A11Y_PREFIX.trim(),
    "Possible security issue:", "Server error:", "Visual change:", KNOWN_BUG_FIXED, "Flaky:", "Validation crashed:",
];
const withExpired = (text: string) => (text.endsWith(DETAILS_EXPIRED) ? text : `${text}${/[:.]$/.test(text) ? " " : ". "}${DETAILS_EXPIRED}`);
const TAG = /\[(critical|high|medium|low)\]/;

/**
 * A test's verdict reason past its period: cut to the step title and the head code parses ("Sign in — Security check failed:
 * Details expired."), with each problem line reduced to its severity tag ("- [high] Details expired.") and a check's headline kept
 * when it names the check (counts only, addresses cut to origin and path), so the family check and the severity read the same.
 * A reason without such a head becomes "Details expired.". Null and empty stay as they are.
 */
export function expiredReason(reason: string | null): string | null {
    if (!reason) return reason;
    const out: string[] = [];
    for (const raw of reason.split("\n")) {
        const line = raw.trimEnd();
        if (/^how to (?:fix|check):/i.test(line)) break;
        let end = -1;
        for (const h of FAMILY_HEADS) {
            const i = line.indexOf(h);
            if (i >= 0) end = Math.max(end, i + h.length);
        }
        for (const h of START_HEADS) if (line.startsWith(h)) end = Math.max(end, h.length);
        const named = !line.startsWith("- ") && (securityCheckOf(line) || healthCheckOf(line)) && (end >= 0 || out.length > 0);
        if (named) out.push(withExpired(cutUrls(line)));
        else if (end >= 0) out.push(withExpired(line.slice(0, end).trimEnd()));
        else if (out.length && TAG.test(line)) {
            const tagged = `- [${TAG.exec(line)![1]}] ${DETAILS_EXPIRED}`;
            if (out.at(-1) !== tagged) out.push(tagged);
        }
    }
    return out.length ? out.join("\n") : DETAILS_EXPIRED;
}
