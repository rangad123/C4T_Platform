/**
 * Retention policy: how long a project keeps the files a run leaves behind (screenshots, recordings, traces, recorded
 * network calls). Pure: no I/O, no clock. The platform applies it (platform/retention-runner.ts).
 *
 * Nothing is ever removed unless a policy is enabled, and tests, scripts, run history, issues and releases are never part
 * of it: only evidence files.
 */
import { z } from "zod";

export const KEEP_DAYS = { min: 7, max: 365, default: 30 } as const;
export const KEEP_FAILED_DAYS = { min: 7, max: 730, default: 90 } as const;
export const KEEP_LATEST_RUNS = { min: 1, max: 50, default: 5 } as const;
/** The optional size cap per project, in MiB. */
export const MAX_ARTIFACT_MB = { min: 10, max: 1_000_000 } as const;

const days = (b: { min: number; max: number }, what: string) =>
    z.number({ invalid_type_error: `${what} must be a number` }).int(`${what} must be a whole number`).min(b.min, `${what} must be at least ${b.min}`).max(b.max, `${what} can be at most ${b.max}`);

export const RetentionPolicySchema = z
    .object({
        enabled: z.boolean(),
        keepDays: days(KEEP_DAYS, "Days to keep files of passed runs"),
        keepFailedDays: days(KEEP_FAILED_DAYS, "Days to keep files of failed runs"),
        keepLatestRuns: days(KEEP_LATEST_RUNS, "Latest runs to always keep"),
        maxArtifactMB: days(MAX_ARTIFACT_MB, "The size limit").nullable().optional(),
    })
    .strict()
    .refine((p) => p.keepFailedDays >= p.keepDays, { path: ["keepFailedDays"], message: "Files of failed runs must be kept at least as long as files of passed runs" });

export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

/** What the API accepts: every field optional, the rest comes from what is saved (or the defaults). */
export const RetentionPolicyPatchSchema = z
    .object({
        enabled: z.boolean().optional(),
        keepDays: z.number().optional(),
        keepFailedDays: z.number().optional(),
        keepLatestRuns: z.number().optional(),
        maxArtifactMB: z.number().nullable().optional(),
    })
    .strict();

export const DEFAULT_POLICY: RetentionPolicy = {
    enabled: false,
    keepDays: KEEP_DAYS.default,
    keepFailedDays: KEEP_FAILED_DAYS.default,
    keepLatestRuns: KEEP_LATEST_RUNS.default,
    maxArtifactMB: null,
};

/** Apply a patch to a base policy and validate the result as a whole. Throws a ZodError with plain messages. */
export function mergePolicy(base: RetentionPolicy, patch: z.infer<typeof RetentionPolicyPatchSchema>): RetentionPolicy {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    return RetentionPolicySchema.parse({ ...base, ...defined, maxArtifactMB: patch.maxArtifactMB === undefined ? (base.maxArtifactMB ?? null) : patch.maxArtifactMB });
}

/**
 * The platform default from the environment (`RETENTION_DEFAULT_DAYS`). Anything but a whole number of days inside the allowed
 * range counts as "not set": an empty line in .env or a typo must never switch deletion on.
 */
export function platformDefaultDays(raw: string | undefined): number | undefined {
    if (raw === undefined || !/^\d{1,4}$/.test(raw.trim())) return undefined;
    const n = Number(raw.trim());
    return n >= KEEP_DAYS.min && n <= KEEP_DAYS.max ? n : undefined;
}

/** The policy a project gets from the platform default: passed runs after `days`, failed runs three times as long. */
export function policyFromPlatformDefault(days: number): RetentionPolicy {
    return { enabled: true, keepDays: days, keepFailedDays: Math.min(KEEP_FAILED_DAYS.max, Math.max(days, days * 3)), keepLatestRuns: KEEP_LATEST_RUNS.default, maxArtifactMB: null };
}
