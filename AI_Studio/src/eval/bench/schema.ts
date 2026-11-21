/**
 * The shape of a benchmark result: kept inside an evaluation run (`EvalRun.benchmark`, src/eval/run.ts) so the platform stores, lists and
 * compares it with the existing evaluation store and route, and written as a file by the benchmark command (src/eval/bench/controller.ts).
 * Validated with caps on every list and string (a run can be sent by anyone holding the API key). Metric definitions: metrics.ts and
 * docs/ai-testing-engine/BENCHMARK_METHODOLOGY.md.
 */
import { z } from "zod";

const Text = (n: number) => z.string().max(n);
const Count = z.number().int().min(0).max(1_000_000_000_000);
const Rate = z.number().min(0).max(1).nullable();
const Money = z.number().min(0).max(1_000_000_000).nullable();
const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/);

/** A test's result in one replay: what the platform's run said ("finding" and "failed" both mean the test did not pass). */
export const ReplayVerdict = z.enum(["passed", "failed", "finding", "not_run"]);
export type ReplayVerdict = z.infer<typeof ReplayVerdict>;

/**
 * What a reported finding turned out to be, decided only by deterministic replays (no model):
 *   confirmed       fails again with the seeded defects on, passes with all off, and fails with at least one single defect on
 *   combined        fails again with the defects on and passes with all off, but no single defect alone makes it fail
 *   false_positive  fails with all defects off too: the application is correct there
 *   unreproduced    did not fail again with the defects on (or could not run): not verified
 */
export const FindingCategory = z.enum(["confirmed", "combined", "false_positive", "unreproduced"]);
export type FindingCategory = z.infer<typeof FindingCategory>;

export const FindingSchema = z
    .object({
        /** The test's platform id and key ("WEB-004"), title, and the reason the platform stored. */
        id: Text(100),
        testKey: Text(100),
        title: Text(500),
        reason: Text(500).optional(),
        /** Where the platform's finding came from: a test the AI stopped as a possible bug while writing it, a failed validation run, or a check. */
        source: z.enum(["authoring", "validation", "check"]),
        replay: z
            .object({
                seeded: ReplayVerdict,
                clean: ReplayVerdict.nullable(),
                single: z.record(Id, ReplayVerdict),
            })
            .strict(),
        category: FindingCategory,
        /** The seeded defects this finding was attributed to by replay (empty unless confirmed). */
        defects: z.array(Id).max(100),
        /** A person's label for a finding the replays could not verify: a defect id, or "false_positive". Never set by code. */
        label: z.union([Id, z.literal("false_positive")]).optional(),
        /**
         * What the author recorded when it stopped the test as a defect (the test's `meta.capture`): "captured" when the saved script ends
         * with the failing sourced check, "observed_only" when it does not. Absent in results written before it existed.
         */
        capture: z.enum(["captured", "observed_only"]).optional(),
        /** When the platform first recorded the failure (earliest failing execution, else the test's creation run). */
        firstSeenAt: z.string().datetime().nullable(),
        /**
         * For a finding the author stopped as a defect (source "authoring", discovery mode): its candidate finding's objective (kind and
         * operator; null when the finding has no objective) and the E7 fields it lacks (observed.ts `evidenceGaps`; empty = complete).
         * Absent in results written before it existed.
         */
        candidate: z
            .object({
                objective: z.object({ kind: Text(40), operator: Text(80).nullable() }).strict().nullable(),
                missing: z.array(Text(40)).max(20),
                /** Shown, not counted against E7 (observed.ts NO_SCREENSHOTS). */
                notes: z.array(Text(60)).max(10).optional(),
            })
            .strict()
            .optional(),
    })
    .strict();
export type BenchFinding = z.infer<typeof FindingSchema>;

export const DefectOutcomeSchema = z
    .object({
        id: Id,
        category: Text(60),
        workflow: Text(120),
        severity: Text(20),
        detected: z.boolean(),
        /** Detected only through a person's label on an unverified finding (not counted in the detection rate). */
        labeledOnly: z.boolean(),
        /** The catalogue marks it unreachable in this bench set-up (scoring v2): it lowers the effective maximum. */
        unreachable: z.boolean().optional(),
        findings: z.array(Text(100)).max(100),
    })
    .strict();

export const BenchMetricsSchema = z
    .object({
        seeded: Count,
        detected: Count,
        missed: Count,
        detectedLabeled: Count,
        findings: Count,
        truePositives: Count,
        falsePositives: Count,
        unreproduced: Count,
        /** Scoring v2 (metrics.ts); absent in v1 results. */
        notReported: Count.optional(),
        seenNotReproducible: Count.optional(),
        reachable: Count.optional(),
        selectedForVerification: Count,
        reproduced: Count,
        detectionRate: Rate,
        precision: Rate,
        precisionVerified: Rate,
        falsePositiveRate: Rate,
        reproductionRate: Rate,
        detectionTimeMs: Count.nullable(),
        cost: Money,
        costPerConfirmedDefect: Money,
        testsGenerated: Count,
        workflows: Count,
        workflowsCovered: Count,
        executionFailures: Count,
        flaky: Count,
        durationMs: Count,
        aiCalls: Count,
        inputTokens: Count,
        outputTokens: Count,
        cacheReadTokens: Count,
        cacheWriteTokens: Count,
    })
    .strict();
export type BenchMetrics = z.infer<typeof BenchMetricsSchema>;

/**
 * One objective-driven exploration session of an app's jobs, read from the job's events (`objectives_planned` opens it with the level's
 * budgets, `exploration_stopped` closes it with the stop reason and what was used): E6 per trial (observed.ts).
 */
export const ExplorationSessionSchema = z
    .object({
        jobId: Text(100),
        /** null: the session has no `exploration_stopped` event (it ended without a recorded stop reason). */
        stopReason: Text(40).nullable(),
        detail: Text(600),
        /** The budgets the session was given; null when its `objectives_planned` event is missing or unreadable. */
        budgets: z.object({ objectives: Count, actions: Count, aiCalls: Count }).strict().nullable(),
        /** What it used, from `exploration_stopped`; null without that event. */
        used: z.object({ objectives: Count, actions: Count, aiCalls: Count }).strict().nullable(),
    })
    .strict();
export type ExplorationSession = z.infer<typeof ExplorationSessionSchema>;

export const BenchAppResultSchema = z
    .object({
        id: Id,
        /** The evaluation entry that explored it (EvalRun.entries[].id). */
        entryId: Text(48),
        projectId: Text(100).optional(),
        /** stopped: the provider's rate limit or the daily call cap stopped it; what was made so far is judged, and `--resume` runs it again. */
        status: z.enum(["done", "stopped", "skipped", "failed"]),
        reason: Text(1000).optional(),
        appVersion: Text(80),
        seededDefects: z.array(Id).max(100),
        defects: z.array(DefectOutcomeSchema).max(100),
        findings: z.array(FindingSchema).max(500),
        metrics: BenchMetricsSchema,
        /** The platform jobs that made this app's tests: the exploration, then every creation (more than one when a stop was continued). */
        jobs: z.object({ planJobId: Text(100).optional(), createJobIds: z.array(Text(100)).max(30), validationJobIds: z.array(Text(100)).max(30).optional() }).strict().optional(),
        /**
         * The app's objective-driven exploration sessions (empty: its jobs did not explore by objectives). Absent in results written
         * before it existed: then per-objective counts, stop reasons, E6 and E7 are not available for the trial (never zero).
         */
        exploration: z.object({ sessions: z.array(ExplorationSessionSchema).max(30) }).strict().optional(),
        /** What makes this app's numbers differ from one uninterrupted run (said in the report). */
        caveats: z.array(Text(600)).max(10).optional(),
    })
    .strict();
export type BenchAppResult = z.infer<typeof BenchAppResultSchema>;

const Scalar = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);

export const PriceRowSchema = z
    .object({
        model: Text(200).min(1),
        inputPerMTok: z.number().min(0).max(1_000_000),
        outputPerMTok: z.number().min(0).max(1_000_000),
        cachedInputPerMTok: z.number().min(0).max(1_000_000).optional(),
        cacheWritePerMTok: z.number().min(0).max(1_000_000).optional(),
        /** The operator's words for the price, shown with the result ("free (OpenRouter :free variant)"). */
        note: Text(120).optional(),
    })
    .strict();
export type PriceRow = z.infer<typeof PriceRowSchema>;

export const BenchConfigSchema = z
    .object({
        engineCommit: Text(64),
        /** Uncommitted changes under src/engine at run time (then the commit alone does not identify the engine). */
        engineDirty: z.boolean(),
        prompts: z.array(z.object({ file: Text(200), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict()).max(40),
        model: z
            .object({
                provider: Text(80),
                model: Text(200),
                fastModel: Text(200).nullable(),
                planningModel: Text(200).nullable(),
                /** Generation settings the engine sets: none for planning and authoring today (provider defaults). */
                temperature: Text(80),
            })
            .strict(),
        catalogueVersion: Text(40),
        apps: z
            .array(
                z
                    .object({
                        id: Id,
                        version: Text(80),
                        /** The requirements document imported into the app's project before exploring it: file and sha256 (absent: none). */
                        requirements: z.object({ file: Text(300), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict().optional(),
                    })
                    .strict(),
            )
            .max(20),
        /** The exploration options sent to the platform (the same for every app). */
        options: z.record(z.string().max(60), Scalar),
        prices: z.array(PriceRowSchema).max(20).nullable(),
        approvedBudget: z.number().min(0).max(1_000_000).nullable(),
        /** The most AI calls the benchmark's platform may make in one UTC day (free models are limited per day); null: no cap. */
        dailyCallCap: Count.nullable(),
        /** How many times the run was resumed after a stop (rate limit, daily cap). */
        resumes: Count,
        runtime: z.object({ node: Text(40), platform: Text(40) }).strict(),
    })
    .strict();
export type BenchConfig = z.infer<typeof BenchConfigSchema>;

export const BenchmarkSchema = z
    .object({
        format: z.literal(1),
        /** The scoring rules (metrics.ts SCORING_VERSION); absent: v1, before row 237. */
        scoring: z.number().int().min(1).max(100).optional(),
        /** discovery: the engine explores the app with the defects in it (the primary measure). regression: it explores the correct app, then its tests run with the defects in. */
        mode: z.enum(["discovery", "regression"]),
        baseline: z.boolean(),
        config: BenchConfigSchema,
        apps: z.array(BenchAppResultSchema).max(20),
        metrics: BenchMetricsSchema,
        notes: z.array(Text(500)).max(40),
    })
    .strict();
export type Benchmark = z.infer<typeof BenchmarkSchema>;

/** The few numbers shown in the run list and compared with the previous run (EvalRun.overall.benchmark). */
export const BenchHeadlineSchema = z
    .object({
        mode: z.enum(["discovery", "regression"]),
        /** The scoring rules the numbers follow (absent in older runs: 1); runs with different rules are not compared. */
        scoring: z.number().int().min(1).max(100).optional(),
        seeded: Count,
        detected: Count,
        falsePositives: Count,
        detectionRate: Rate,
        precision: Rate,
        falsePositiveRate: Rate,
        reproductionRate: Rate,
        cost: Money,
    })
    .strict();
export type BenchHeadline = z.infer<typeof BenchHeadlineSchema>;
