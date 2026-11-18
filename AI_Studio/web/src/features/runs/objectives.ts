/**
 * Exploring by objectives (testing-engine Phase 3) as the run pages show it: the API's answers and the pure rules that turn a run's
 * events and its coverage record into each objective's state. Browser-free, so tests read the same rules the page uses.
 *
 *   GET /api/projects/:id/objectives            → ObjectivesAnswer: the objectives of the project's latest analysed model.
 *   GET /api/projects/:id/jobs/:jobId/coverage  → CoverageAnswer: a finished exploration's stop reason, budgets, usage and coverage.
 *
 * While a run explores, the platform says which objective a pursuit was about only when the pursuit ends (an event whose message names
 * the objective's id or its "kind source"), and the session pursues objectives one at a time, highest priority first. So the objective
 * last named is the one being explored, those before it are done and those after it wait. Once the run is over, its coverage record
 * says what was not run and why, and that replaces the estimate.
 */
/** The parts of a run event (api.ts EventRow) these rules read; kept here so the rules import nothing. */
export interface EventRow {
    id: number;
    kind: string;
    message: string;
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
    const running = furthest >= 0 ? furthest : 0;
    return ordered.map((objective, i): ObjectiveRow => {
        if (over) return i <= furthest ? { objective, state: "done", notRun: [] } : { objective, state: "skipped", why: `Not reached: ${stopDetail}`, notRun: [] };
        return { objective, state: i < running ? "done" : i === running ? "running" : "waiting", notRun: [] };
    });
}

/** "3 of 8": a coverage tally as a person reads it. */
export const tallyText = (t: Pick<Tally, "total" | "exercised">): string => (t.total === 0 ? "None in the model" : `${t.exercised} of ${t.total}`);
