/**
 * Phase 3 (row 184): how an exploration by objectives went (the engine's `ExplorationSummary`, orchestrator.ts), as a runner sends it in its
 * explore result (`ResultRequest.explore.exploration`). The wire field itself is `unknown`, so a record this platform cannot read never fails
 * the run: the platform checks it on arrival with `parseExploration` (explore-dispatch.ts), keeps it when it is well formed and within
 * EXPLORATION_MAX_BYTES, and otherwise drops it with a warning on the job. The runner checks it the same way before it sends it.
 *
 * Objects strip fields they do not know (a newer engine may add some); arrays are capped, the action log at ACTION_LOG_CAP rows.
 */
import { z } from "zod";
import { STOP_REASONS } from "../engine/explore/loop.js";
import { OBJECTIVE_KINDS, OBJECTIVE_OPERATORS } from "../engine/explore/objectives.js";

/** The largest record kept, as JSON text (UTF-8). A full action log of 2,000 rows is well under it. */
export const EXPLORATION_MAX_BYTES = 2 * 1024 * 1024;
/** The same number as the engine's ACTION_LOG_CAP (orchestrator.ts; a test keeps them equal): the protocol does not import the orchestrator. */
export const EXPLORATION_ACTION_LOG_MAX = 2_000;
const ROWS_MAX = 5_000;
const LIST_MAX = 1_000;

const Text = z.string().max(4_000);
const Count = z.number().int().min(0);
const Num = z.number().min(0);
const Tally = z.object({ total: Count, exercised: Count, notExercised: z.array(Text).max(LIST_MAX), more: Count });
const OutcomeStatus = z.enum(["completed", "stopped", "writer_stopped", "environment_failure", "unsafe", "interrupted", "skipped", "not_reached"]);

const Shape = z.object({
    stopReason: z.enum(STOP_REASONS),
    stopDetail: Text,
    budgets: z.object({ objectives: Num, actions: Num, aiCalls: Num, tokens: Num, minutes: Num, depth: Num, steps: Num }),
    objectives: z.array(z.object({ id: Text, kind: z.enum(OBJECTIVE_KINDS), source: Text, priority: z.number().int(), reason: Text, operators: z.array(z.enum(OBJECTIVE_OPERATORS)).max(OBJECTIVE_OPERATORS.length) })).max(ROWS_MAX),
    overCap: Count,
    skipped: z.array(z.object({ objectiveId: Text, operator: Text, reason: Text })).max(ROWS_MAX),
    outcomes: z
        .array(
            z.object({
                objectiveId: Text,
                status: OutcomeStatus,
                reason: Text,
                actions: Count,
                result: z.object({ applied: z.boolean().optional(), authoring: z.enum(["complete", "defect", "blocked"]).optional(), testKey: Text.optional(), ended: Text.optional() }).optional(),
            }),
        )
        .max(ROWS_MAX),
    usage: z.object({ objectives: Num, actions: Num, aiCalls: Num, tokens: Num, minutes: Num }),
    coverage: z.object({
        pages: Tally.extend({ unknown: z.array(Text).max(LIST_MAX) }),
        states: Count,
        elements: Tally,
        workflowSteps: Tally,
        transitions: Tally,
        inputClasses: Tally,
        rules: Tally,
        endpoints: Tally,
        uniqueScenarios: Count,
        unexplored: z.array(z.object({ objectiveId: Text, kind: z.enum(OBJECTIVE_KINDS), source: Text, priority: z.number().int(), reason: Text, status: Text })).max(LIST_MAX),
        unexploredMore: Count,
        notRun: z.array(z.object({ objectiveId: Text.optional(), operator: Text, reason: Text })).max(LIST_MAX),
        notRunMore: Count,
    }),
    actionLog: z
        .array(z.object({ seq: Count, objectiveId: Text, state: Text, action: Text, atMs: Num, result: z.enum(["performed", "refused"]), reason: Text.optional() }))
        .max(EXPLORATION_ACTION_LOG_MAX),
    actionLogOmitted: Count,
});

/** A record as one exploration session sends it: its shape, and at most EXPLORATION_MAX_BYTES as JSON. */
export const ExplorationRecord = z.unknown().superRefine((v, ctx) => {
    let bytes: number;
    try {
        bytes = Buffer.byteLength(JSON.stringify(v) ?? "", "utf8");
    } catch {
        bytes = Infinity;
    }
    if (bytes > EXPLORATION_MAX_BYTES) ctx.addIssue({ code: "custom", message: `it is larger than ${EXPLORATION_MAX_BYTES / (1024 * 1024)} MB` });
}).pipe(Shape);
export type ExplorationRecord = z.infer<typeof Shape>;

/** The record, or why it was left out (one short phrase). Never throws. */
export function parseExploration(v: unknown): { ok: true; value: ExplorationRecord } | { ok: false; problem: string } {
    const r = ExplorationRecord.safeParse(v);
    if (r.success) return { ok: true, value: r.data };
    const issue = r.error.issues[0];
    return { ok: false, problem: `${issue?.path.length ? `${issue.path.join(".")}: ` : ""}${issue?.message ?? "not a coverage record"}`.slice(0, 300) };
}
