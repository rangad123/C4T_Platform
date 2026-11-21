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

/**
 * The fields of a coverage record kept as written when it is masked: the engine's own ids, enums and keys (an objective's id and kind,
 * a stop reason, an operator, how a pursuit was authored, the saved test's key). Nothing a page or an error wrote is among them.
 */
const RAW_EXPLORATION_KEYS: ReadonlySet<string> = new Set(["id", "objectiveId", "kind", "stopReason", "operator", "operators", "authoring", "testKey"]);

/**
 * A transition's ref (`transition:<entity>:<from>-><to>`, objectives.ts and coverage.ts) has its entity and its states masked apart: the
 * ref's own colon after an entity such as "Session" is not a `session: value` secret (row 232). Any other text is masked whole.
 */
const TRANSITION_REF = /^(transition:)([^:]*):(.*)$/s;
const maskRef = (v: string, mask: (text: string) => string): string => {
    const t = TRANSITION_REF.exec(v);
    return t ? `${t[1]}${mask(t[2]!)}:${mask(t[3]!)}` : mask(v);
};

/**
 * CP3b R-4, CP3c T-5: the record with every string passed through `mask`, except the id-like fields (RAW_EXPLORATION_KEYS). A field
 * list let page paths, element names and endpoints through (`coverage.pages.unknown`, every `notExercised` list, an objective's
 * `source`): the next field added is masked without anyone listing it. Counts are left as they are. The action log's actions and states
 * have their own masking as well (action-mask.ts); masking twice changes nothing.
 * The platform masks with the run's secrets and the shared patterns when it saves the record (exploration-store.ts), a runner before
 * it sends one (task-runner.ts).
 */
export function maskExplorationText<T>(e: T, mask: (text: string) => string): T {
    const walk = (v: unknown, key: string | undefined): unknown => {
        if (typeof v === "string") return key !== undefined && RAW_EXPLORATION_KEYS.has(key) ? v : maskRef(v, mask);
        if (Array.isArray(v)) return v.map((x) => walk(x, key));
        if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, k)]));
        return v;
    };
    return walk(e, undefined) as T;
}
