/**
 * Retention policy: how long a project keeps the files a run leaves behind (screenshots, recordings, traces, recorded
 * network calls). Pure: no I/O, no clock. The platform applies it (platform/retention-runner.ts).
 *
 * The two periods: `keepFailedDays` is how long the files of runs that did not pass are kept (traces,
 * recordings, screenshots, evidence), 7 days by default; `keepDays` is how long the files of passed runs are kept (their evidence
 * record; a passed run keeps no trace or recording), 30 days by default. Retention is on by default; a project may turn it off or
 * change the periods within the server's limits. Nothing else keeps a run's files longer (see rules.ts). Tests, scripts, run
 * history, findings, issues and releases are never part of it: only the files runs leave behind.
 *
 * `keepLatestRuns` is no longer used (the "latest runs are always kept" exception was removed 2026-11-14). It stays in the stored
 * shape only so saved policies and backups keep reading and writing; a patch that sends it is accepted and ignored.
 */
import { z } from "zod";

export const KEEP_DAYS = { min: 7, max: 365, default: 30 } as const;
export const KEEP_FAILED_DAYS = { min: 7, max: 730, default: 7 } as const;
export const KEEP_LATEST_RUNS = { min: 1, max: 50, default: 5 } as const;
/** The optional size cap per project, in MiB. */
export const MAX_ARTIFACT_MB = { min: 10, max: 1_000_000 } as const;

const days = (b: { min: number; max: number }, what: string) =>
    z.number({ error: `${what} must be a number` }).int(`${what} must be a whole number`).min(b.min, `${what} must be at least ${b.min}`).max(b.max, `${what} can be at most ${b.max}`);

export const RetentionPolicySchema = z
    .object({
        enabled: z.boolean(),
        keepDays: days(KEEP_DAYS, "Days to keep the records of passed runs"),
        keepFailedDays: days(KEEP_FAILED_DAYS, "Days to keep traces, recordings and screenshots of failed runs"),
        /** Not used: see the top of the file. */
        keepLatestRuns: days(KEEP_LATEST_RUNS, "Latest runs to always keep"),
        maxArtifactMB: days(MAX_ARTIFACT_MB, "The size limit").nullable().optional(),
    })
    .strict();

export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

/** What the API accepts: every field optional, the rest comes from what is saved (or the defaults). */
export const RetentionPolicyPatchSchema = z
    .object({
        enabled: z.boolean().optional(),
        keepDays: z.number().optional(),
        keepFailedDays: z.number().optional(),
        /** Accepted from older clients and ignored. */
        keepLatestRuns: z.unknown().optional(),
        maxArtifactMB: z.number().nullable().optional(),
    })
    .strict();

export const DEFAULT_POLICY: RetentionPolicy = {
    enabled: true,
    keepDays: KEEP_DAYS.default,
    keepFailedDays: KEEP_FAILED_DAYS.default,
    keepLatestRuns: KEEP_LATEST_RUNS.default,
    maxArtifactMB: null,
};

/** Apply a patch to a base policy and validate the result as a whole. Throws a ZodError with plain messages. */
export function mergePolicy(base: RetentionPolicy, patch: z.infer<typeof RetentionPolicyPatchSchema>): RetentionPolicy {
    const defined = Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== undefined && k !== "keepLatestRuns"));
    return RetentionPolicySchema.parse({ ...base, ...defined, maxArtifactMB: patch.maxArtifactMB === undefined ? (base.maxArtifactMB ?? null) : patch.maxArtifactMB });
}

/** `RETENTION_DEFAULT_DAYS=off`: projects without a policy of their own keep everything (the operator's way to keep the old behaviour). */
export const platformDefaultOff = (raw: string | undefined): boolean => raw !== undefined && /^\s*off\s*$/i.test(raw);

/**
 * The platform default from the environment (`RETENTION_DEFAULT_DAYS`): the days passed runs keep their files. Anything but a whole
 * number of days inside the allowed range counts as "not set" (the built-in default then applies).
 */
export function platformDefaultDays(raw: string | undefined): number | undefined {
    if (raw === undefined || !/^\d{1,4}$/.test(raw.trim())) return undefined;
    const n = Number(raw.trim());
    return n >= KEEP_DAYS.min && n <= KEEP_DAYS.max ? n : undefined;
}

/** The policy a project gets from the platform default: passed runs after `days`, failed runs' media after the default 7 days. */
export function policyFromPlatformDefault(days: number): RetentionPolicy {
    return { enabled: true, keepDays: days, keepFailedDays: KEEP_FAILED_DAYS.default, keepLatestRuns: KEEP_LATEST_RUNS.default, maxArtifactMB: null };
}

/** The longest a project may keep files, set by the server (RETENTION_MAX_METADATA_DAYS, RETENTION_MAX_FAILED_MEDIA_DAYS); a project cannot exceed it. */
export interface RetentionLimits {
    maxKeepDays: number;
    maxKeepFailedDays: number;
}

const limitOf = (raw: string | undefined, b: { min: number; max: number }): number => {
    if (raw === undefined || !/^\d{1,4}$/.test(raw.trim())) return b.max;
    const n = Number(raw.trim());
    return Math.min(b.max, Math.max(b.min, n));
};

/** The server's limits from the environment; a missing or unreadable value means the schema's own maximum. */
export function retentionLimits(env: { RETENTION_MAX_METADATA_DAYS?: string; RETENTION_MAX_FAILED_MEDIA_DAYS?: string }): RetentionLimits {
    return { maxKeepDays: limitOf(env.RETENTION_MAX_METADATA_DAYS, KEEP_DAYS), maxKeepFailedDays: limitOf(env.RETENTION_MAX_FAILED_MEDIA_DAYS, KEEP_FAILED_DAYS) };
}

/** Why a policy is not allowed on this server, in words, or undefined when it fits. */
export function limitProblem(p: RetentionPolicy, l: RetentionLimits): string | undefined {
    if (p.keepDays > l.maxKeepDays) return `This server keeps the records of passed runs for at most ${l.maxKeepDays} days.`;
    if (p.keepFailedDays > l.maxKeepFailedDays) return `This server keeps traces, recordings and screenshots of failed runs for at most ${l.maxKeepFailedDays} days.`;
    return undefined;
}

/** A saved policy as it applies under the server's limits (a policy saved before a limit was lowered is held to the limit). */
export function withinLimits(p: RetentionPolicy, l: RetentionLimits): RetentionPolicy {
    return { ...p, keepDays: Math.min(p.keepDays, l.maxKeepDays), keepFailedDays: Math.min(p.keepFailedDays, l.maxKeepFailedDays) };
}
