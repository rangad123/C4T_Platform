/**
 * Exploring by objectives (testing-engine Phase 3) as the run pages show it: the API's answers and the pure rules that turn a run's
 * events and its coverage record into each objective's state. Browser-free, so tests read the same rules the page uses.
 *
 *   GET /api/projects/:id/objectives            → ObjectivesAnswer: the objectives of the project's latest analysed model.
 *   GET /api/projects/:id/jobs/:jobId/coverage  → CoverageAnswer: a finished exploration's stop reason, budgets, usage and coverage.
 *
 * While a run explores, the session tells each pursuit's start and end (objective_started / objective_finished, row 173: the objective's
 * id, the operator and how it ended), and the list follows them. An older run has no such events: the platform said which objective a
 * pursuit was about only when the pursuit ended (an event whose message names the objective's id or its "kind source"), and the session
 * pursues objectives one at a time, highest priority first, so the objective last named is the one being explored, those before it are
 * done and those after it wait. Once the run is over, its coverage record says what was not run and why, and that replaces both.
 */
/** The parts of a run event (api.ts EventRow) these rules read; kept here so the rules import nothing. */
export interface EventRow {
    id: number;
    kind: string;
    message: string;
    /** Read only for objective_started / objective_finished (`pursuitOf`). */
    data?: unknown;
}

export const OBJECTIVE_KINDS = ["rule", "workflow", "constraint", "transition", "coverage-gap"] as const;
export type ObjectiveKind = (typeof OBJECTIVE_KINDS)[number];

export interface ObjectivePreview {
    id: string;
    kind: ObjectiveKind | string;
    /** The rule, workflow, field or transition the objective comes from. */
    source: string;
    question: string;
    /** What should happen, from the source (never from the application). */
    expected: string;
    operators: string[];
    priority: number;
    /** Why it has this priority, in one sentence. */
    reason: string;
}

export type ObjectivesAnswer = { available: true; objectives: ObjectivePreview[]; overCap: number } | { available: false; objectives?: ObjectivePreview[]; message: string };

export const STOP_REASONS = ["time", "actions", "ai_calls", "tokens", "objectives_done", "instability", "safety", "cancelled"] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export interface Tally {
    total: number;
    exercised: number;
    notExercised: string[];
    more: number;
}

export interface CoverageRecord {
    pages: Tally & { unknown: string[] };
    states: number;
    elements: Tally;
    workflowSteps: Tally;
    transitions: Tally;
    inputClasses: Tally;
    rules: Tally;
    endpoints: Tally;
    uniqueScenarios: number;
    unexplored: Array<{ objectiveId: string; kind: string; source: string; priority: number; reason: string; status: string }>;
    unexploredMore: number;
    notRun: Array<{ objectiveId?: string; operator: string; reason: string }>;
    notRunMore: number;
}

export interface ExplorationBudgets {
    objectives: number;
    actions: number;
    aiCalls: number;
    tokens: number;
    minutes: number;
    depth: number;
    steps?: number;
}

export type CoverageAnswer =
    | {
          available: true;
          stopReason: StopReason | string;
          stopDetail: string;
          budgets: ExplorationBudgets;
          usage: { objectives: number; actions: number; aiCalls: number; tokens: number; minutes: number };
          coverage: CoverageRecord;
          actionLog: unknown[];
          actionLogOmitted: number;
      }
    | { available: false; message: string };

/** The stop reason in a few words; the session's own sentence (stopDetail) says the rest. */
export const STOP_WORD: Record<StopReason, string> = {
    time: "Time limit reached",
    actions: "Action limit reached",
    ai_calls: "AI call limit reached",
    tokens: "AI token limit reached",
    objectives_done: "Objectives done",
    instability: "The application was unstable",
    safety: "Stopped for safety",
    cancelled: "Cancelled",
};
export const stopWord = (r: string): string => STOP_WORD[r as StopReason] ?? "Stopped";

export const KIND_WORD: Record<ObjectiveKind, string> = {
    rule: "Rule",
    workflow: "Workflow",
    constraint: "Form field",
    transition: "Status change",
    "coverage-gap": "Coverage gap",
};
export const kindWord = (k: string): string => KIND_WORD[k as ObjectiveKind] ?? k;

/** What each operator does to the application, as a person would say it. */
export const OPERATOR_WORD: Record<string, string> = {
    as_stated: "As stated",
    invalid_input: "Invalid input",
    boundary_input: "Boundary values",
    double_submit: "Submit twice",
    repeat: "Do it again",
    direct_url: "Open by its address",
    back: "Go back",
    refresh: "Reload the page",
    cancel: "Cancel part-way",
};
export const operatorWord = (op: string): string => OPERATOR_WORD[op] ?? op.replace(/_/g, " ");

export type ObjectiveState = "waiting" | "running" | "done" | "skipped" | "unfinished";
export const STATE_WORD: Record<ObjectiveState, string> = { waiting: "Waiting", running: "Exploring", done: "Done", skipped: "Skipped", unfinished: "Not finished" };

export interface ObjectiveRow {
    objective: ObjectivePreview;
    state: ObjectiveState;
    /** Why it was skipped or not finished. */
    why?: string;
    /** Its operators that did not run, each with why. */
    notRun: Array<{ operator: string; reason: string }>;
}

/** The events the objectives view reads: the session's own, and those that end a pursuit (they name its objective). */
export const OBJECTIVE_EVENT_KINDS: ReadonlySet<string> = new Set([
    "objectives_planned",
    "objective_started",
    "objective_finished",
    "objectives_need_runner",
    "objectives_unavailable",
    "exploration_stopped",
    "objective_not_written",
    "operator_not_applied",
    "script_generated",
    "possible_defect",
    "defect_unverified",
    "finding_invalid",
]);

/** The engine's reason (engine/web/author.ts, kept equal by a test) when the test writer stopped before finishing a test. */
export const WRITER_STOPPED = "The test writer stopped before finishing the test";
/** The events that end a pursuit, of which objective_not_written can say the test writer stopped. */
const PURSUIT_ENDS: ReadonlySet<string> = new Set(["objective_not_written", "operator_not_applied", "script_generated", "possible_defect", "defect_unverified", "finding_invalid"]);
const writerStopped = (e: EventRow) => e.kind === "objective_not_written" && e.message.includes(`(${WRITER_STOPPED})`);

const first = (events: readonly EventRow[], kind: string) => events.find((e) => e.kind === kind);
const sentence = (t: string) => (t ? t[0]!.toUpperCase() + t.slice(1) : t);

/** A sentence that replaces the list: the runner is too old to explore by objectives, or there is no model to make objectives from. */
export function explorationNote(events: readonly EventRow[]): { kind: "need_runner" | "unavailable"; text: string } | null {
    const old = first(events, "objectives_need_runner");
    if (old) return { kind: "need_runner", text: old.message };
    const none = first(events, "objectives_unavailable");
    if (none) return { kind: "unavailable", text: none.message };
    return null;
}

export const PURSUIT_EVENT_KINDS: ReadonlySet<string> = new Set(["objective_started", "objective_finished"]);

/** A pursuit's start or end from its event's facts (ids and names only), or null when the event is not one or its facts are not these. */
export function pursuitOf(e: EventRow): { objectiveId: string; operator: string; outcome?: string } | null {
    if (!PURSUIT_EVENT_KINDS.has(e.kind) || !e.data || typeof e.data !== "object") return null;
    const d = e.data as Record<string, unknown>;
    if (typeof d.objectiveId !== "string" || typeof d.operator !== "string") return null;
    const outcome = e.kind === "objective_finished" ? (typeof d.outcome === "string" ? d.outcome : "") : undefined;
    return { objectiveId: d.objectiveId, operator: d.operator, ...(outcome !== undefined ? { outcome } : {}) };
}

/** How a pursuit ended (explore/loop.ts OutcomeStatus), when it did not run to its end. */
const OUTCOME_WORD: Record<string, string> = {
    interrupted: "the session stopped during it",
    environment_failure: "the application or the browser failed",
    unsafe: "an unsafe action was reported",
};
const RAN = new Set(["completed", "stopped"]);

/** Whether a pursuit-ending event is about this objective: its id, or the "kind source" its saved test's title carries. */
const names = (message: string, o: ObjectivePreview) => message.includes(o.id) || (o.source.length > 0 && message.includes(`${o.kind} ${o.source.slice(0, 100)}`));

/** The objectives in the order the session pursues them: highest priority first, ties as listed. */
export const inPursuitOrder = (objectives: readonly ObjectivePreview[]): ObjectivePreview[] =>
    objectives
        .map((o, i) => ({ o, i }))
        .sort((a, b) => b.o.priority - a.o.priority || a.i - b.i)
        .map((x) => x.o);

/**
 * Each objective's state. With the run's coverage record (after the exploration): skipped or not finished with the record's reason,
 * else done, and every operator that did not run with its reason. Without it, from the run's events as described at the top.
 */
export function objectiveRows(objectives: readonly ObjectivePreview[], events: readonly EventRow[], opts: { active: boolean; coverage?: CoverageAnswer }): ObjectiveRow[] {
    const ordered = inPursuitOrder(objectives);
    const cov = opts.coverage?.available ? opts.coverage.coverage : undefined;
    if (cov) {
        const left = new Map(cov.unexplored.map((u) => [u.objectiveId, u.status]));
        return ordered.map((objective) => {
            const status = left.get(objective.id);
            const notRun = cov.notRun.filter((n) => n.objectiveId === objective.id).map((n) => ({ operator: n.operator, reason: sentence(n.reason) }));
            if (status === undefined) return { objective, state: "done", notRun };
            return { objective, state: status.startsWith("not finished") ? "unfinished" : "skipped", why: sentence(status), notRun };
        });
    }
    const planned = first(events, "objectives_planned");
    if (!planned) return ordered.map((objective) => ({ objective, state: "waiting", notRun: [] }));
    const after = events.filter((e) => e.id > planned.id);
    const stopped = after.find((e) => e.kind === "exploration_stopped");
    let furthest = -1;
    for (const e of after) {
        if (e.kind === "exploration_stopped" || e.kind === "objectives_planned") continue;
        ordered.forEach((o, i) => {
            if (i > furthest && names(e.message, o)) furthest = i;
        });
    }
    const over = Boolean(stopped) || !opts.active;
    const stopDetail = stopped ? stopped.message.replace(/^Exploring by objectives stopped:\s*/, "") : "the run ended first.";
    const pursuits = after.map(pursuitOf).filter((p) => p !== null);
    if (pursuits.length) {
        // The session's own account of each pursuit: running while started and not finished, else done or not finished by how it ended.
        return ordered.map((objective): ObjectiveRow => {
            const own = pursuits.filter((p) => p.objectiveId === objective.id);
            const open = own.filter((p) => p.outcome === undefined).length - own.filter((p) => p.outcome !== undefined).length;
            const ends = own.flatMap((p) => (p.outcome !== undefined ? [p.outcome] : []));
            if (open > 0) return over ? { objective, state: "unfinished", why: `Not finished: ${stopDetail}`, notRun: [] } : { objective, state: "running", notRun: [] };
            if (ends.some((o) => RAN.has(o))) return { objective, state: "done", notRun: [] };
            if (ends.length) return { objective, state: "unfinished", why: `Not finished: ${OUTCOME_WORD[ends[ends.length - 1]!] ?? "it did not run to its end"}.`, notRun: [] };
            return over ? { objective, state: "skipped", why: `Not reached: ${stopDetail}`, notRun: [] } : { objective, state: "waiting", notRun: [] };
        });
    }
    const running = furthest >= 0 ? furthest : 0;
    // Past an objective whose every pursuit ended with the test writer stopping, it is not finished, as the coverage record will say.
    const ended = (o: ObjectivePreview): ObjectiveRow => {
        const ends = after.filter((e) => PURSUIT_ENDS.has(e.kind) && names(e.message, o));
        return ends.length > 0 && ends.every(writerStopped) ? { objective: o, state: "unfinished", why: WRITER_STOPPED, notRun: [] } : { objective: o, state: "done", notRun: [] };
    };
    return ordered.map((objective, i): ObjectiveRow => {
        if (over) return i <= furthest ? ended(objective) : { objective, state: "skipped", why: `Not reached: ${stopDetail}`, notRun: [] };
        return i < running ? ended(objective) : { objective, state: i === running ? "running" : "waiting", notRun: [] };
    });
}

/** "3 of 8": a coverage tally as a person reads it. */
export const tallyText = (t: Pick<Tally, "total" | "exercised">): string => (t.total === 0 ? "None in the model" : `${t.exercised} of ${t.total}`);
