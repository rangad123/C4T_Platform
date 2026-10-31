/**
 * The shape of one evaluation run: what the harness writes to `eval/results/<date>-<corpus>.json` and sends to the platform to keep
 * (`POST /api/eval/runs`). Validated with zod on the platform side, with caps on every list and string, because a run can be sent by anyone
 * holding the API key.
 */
import { z } from "zod";
import { MAX_ENTRIES } from "./corpus.js";

export const MAX_TESTS_PER_ENTRY = 500;
const Text = (n: number) => z.string().max(n);
const Count = z.number().int().min(0).max(1_000_000_000_000);
const Rate = z.number().min(0).max(1).nullable();
const Verdict = z.enum(["passed", "failed", "finding", "not_run"]);

const MetricsSchema = z
    .object({
        planned: Count,
        created: Count,
        passedFirstRun: Count,
        stable: Count,
        stablePassing: Count,
        stableFailing: Count,
        flaky: Count,
        notRun: Count,
        failingProduct: Count,
        failingTestWrong: Count,
        failingUnclear: Count,
        duplicates: Count,
        coverageUnit: z.enum(["pages", "screens"]),
        found: Count,
        covered: Count,
        durationMs: Count,
        aiCalls: Count,
        inputTokens: Count,
        outputTokens: Count,
        cost: z.number().min(0).max(1_000_000_000).nullable(),
        safetyRefusals: Count.nullable(),
    })
    .strict();

export const RatesSchema = z.object({ firstPass: Rate, stable: Rate, flaky: Rate, duplicates: Rate, coverage: Rate, testWrong: Rate }).strict();

const TestSchema = z
    .object({
        id: Text(100),
        testId: Text(100),
        title: Text(500),
        firstRun: Verdict.nullable(),
        reruns: z.array(Verdict).max(10),
        outcome: z.enum(["stable-pass", "stable-fail", "flaky", "not-run"]),
        failure: z.enum(["product", "test-wrong", "unclear"]).optional(),
        reason: Text(500).optional(),
        duplicate: z.literal(true).optional(),
    })
    .strict();

/**
 * What the AI did for an entry beyond the plain totals (the comparison with savings on and off reads it, compare.ts): prompt-cache reads and
 * writes, escalations to the main model, tokens by model, repairs (with and without AI) and pages reused. Optional: older runs have none.
 */
export const UsageDetailSchema = z
    .object({
        cacheReadTokens: Count,
        cacheWriteTokens: Count,
        escalations: Count,
        byModel: z.array(z.object({ model: Text(200), calls: Count, inputTokens: Count, outputTokens: Count, cacheReadTokens: Count }).strict()).max(20),
        /** Created tests that passed in the run that created them only after a repair (attempts > 1). */
        repairsFixed: Count,
        /** Repairs made by the plain rules, without asking the model. */
        repairsWithoutAi: Count,
        /** Pages not sent to the AI again because they had not changed since the last exploration. */
        pagesReused: Count,
    })
    .strict();
export type UsageDetail = z.infer<typeof UsageDetailSchema>;

export const EntryResultSchema = z
    .object({
        id: Text(48),
        kind: z.enum(["web", "android"]),
        /** done: explored, created and rerun; planned: --plan-only stopped at the plan; skipped: not started (reason); failed: started and could not finish (reason). */
        status: z.enum(["done", "planned", "skipped", "failed"]),
        reason: Text(1000).optional(),
        projectId: Text(100).optional(),
        planJobId: Text(100).optional(),
        createJobId: Text(100).optional(),
        metrics: MetricsSchema.optional(),
        rates: RatesSchema.optional(),
        tests: z.array(TestSchema).max(MAX_TESTS_PER_ENTRY).optional(),
        usage: UsageDetailSchema.optional(),
    })
    .strict();
export type EntryResult = z.infer<typeof EntryResultSchema>;

const OverallSchema = MetricsSchema.omit({ coverageUnit: true })
    .extend({ entries: Count, entriesDone: Count, rates: RatesSchema })
    .strict();

const GateSchema = z
    .object({
        name: z.enum(["stable", "firstPass", "coverage", "flaky", "duplicates", "testWrong"]),
        limit: z.number().min(0).max(1),
        kind: z.enum(["min", "max"]),
        value: Rate,
        passed: z.boolean(),
        message: Text(300),
    })
    .strict();

export const EvalRunSchema = z
    .object({
        format: z.literal(1),
        corpus: Text(80).min(1),
        startedAt: z.string().datetime(),
        finishedAt: z.string().datetime(),
        repeat: z.number().int().min(1).max(10),
        planOnly: z.boolean(),
        /** Where it ran ("in-process": a platform the harness started itself; "remote": a running platform) and the AI model's name. */
        platform: z.object({ mode: z.enum(["in-process", "remote"]), model: Text(200) }).strict(),
        entries: z.array(EntryResultSchema).max(MAX_ENTRIES),
        overall: OverallSchema,
        gates: z.array(GateSchema).max(6).optional(),
    })
    .strict();
export type EvalRun = z.infer<typeof EvalRunSchema>;

/** Largest run a platform keeps (a full corpus with 500 tests per entry stays well under it). */
export const MAX_RUN_BYTES = 4 * 1024 * 1024;
