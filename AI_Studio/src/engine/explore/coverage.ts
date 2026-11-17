/**
 * The coverage record of an exploration session (testing-engine Phase 3, P3-16). Pure: built from the application model, the session's
 * objectives (objectives.ts), the loop's outcomes and action log (loop.ts), the saved tests and the operators the scenario builder skipped.
 *
 * What counts as exercised (only what the record shows, never what a pursuit claims):
 * - a page: an action the loop performed on a state with the page's address pattern, or a saved test's `navigate` to it;
 * - an element (one with a name): a performed action on its page whose text names it;
 * - a workflow step: with a page, that page was acted on during a pursuit of the workflow's objective; without one, the workflow's
 *   objective was pursued to its end;
 * - a transition, an input class (a constraint objective's input operator), a rule: a pursuit of its objective ended `completed` or
 *   `stopped`, or a saved test belongs to it (for a rule also: a saved check whose `source` is the rule's ref);
 * - an endpoint: a saved test's request to it, a performed action naming a control the model saw call it on that page, or an exercised
 *   workflow step that names it.
 *
 * A pursuit is keyed `pursuitKey(objectiveId, operator)`; a bare objective id stands for every operator of the objective. Everything an
 * objective offers that was not exercised is listed: the objective itself under `unexplored` (highest priority first, with the priority's
 * reason) when nothing of it ran, and each operator that did not run under `notRun` with its reason, so a skipped operator is never
 * silent (E9). Lists are sorted and capped, so the record is the same for the same session in any order and stays small enough for the
 * job summary.
 */
import { pathPattern } from "./state.js";
import type { ActionLogRow, ObjectiveOutcome, OutcomeStatus } from "./loop.js";
import type { Objective } from "./objectives.js";

/** The parts of the model coverage reads; the stored model (intel/model.ts) has these shapes. */
export interface CoverageModel {
    pages?: ReadonlyArray<{
        id: string;
        path: string;
        elements?: ReadonlyArray<{ role?: string; name: string }>;
        interactions?: ReadonlyArray<{ control: string; method: string; path: string }>;
    }>;
    workflows?: ReadonlyArray<{ id: string; steps: ReadonlyArray<{ order: number; action: string; page?: string; endpoint?: string }> }>;
    transitions?: ReadonlyArray<{ entity: string; from: string; to: string }>;
    endpoints?: ReadonlyArray<{ method: string; path: string }>;
}

/** A saved test as far as coverage reads it: the objective it pursued and its steps. */
export interface CoverageTest {
    objective?: { id: string; operator?: string } | null;
    steps: ReadonlyArray<{ action: string; url?: string; method?: string; path?: string; source?: string }>;
}

/** An operator the scenario builder did not run, with its reason ("not run: data changes off", "needs a second account"). */
export interface SkippedOperator {
    objectiveId: string;
    operator: string;
    reason: string;
}

export interface CoverageInput {
    model: CoverageModel;
    objectives: readonly Objective[];
    outcomes: readonly ObjectiveOutcome[];
    actionLog: readonly ActionLogRow[];
    tests?: readonly CoverageTest[];
    skipped?: readonly SkippedOperator[];
}

export interface Tally {
    total: number;
    exercised: number;
    /** What was not exercised, sorted, at most LIST_CAP. */
    notExercised: string[];
    /** How many more were not exercised than the list shows. */
    more: number;
}

export interface UnexploredItem {
    objectiveId: string;
    kind: Objective["kind"];
    source: string;
    priority: number;
    /** The priority's own sentence (priority.ts). */
    reason: string;
    /** What happened to it in this session. */
    status: string;
}

export interface NotRunOperator {
    /** Absent for a note about the whole session (history back). */
    objectiveId?: string;
    operator: string;
    reason: string;
}

export interface CoverageRecord {
    pages: Tally & { unknown: string[] };
    /** Distinct states (address pattern + outline) the loop performed actions on. */
    states: number;
    elements: Tally;
    workflowSteps: Tally;
    transitions: Tally;
    inputClasses: Tally;
    rules: Tally;
    endpoints: Tally;
    /** Distinct pursuits (objective + operator) exercised, by the loop or a saved test. */
    uniqueScenarios: number;
    unexplored: UnexploredItem[];
    unexploredMore: number;
    notRun: NotRunOperator[];
    notRunMore: number;
}

export const LIST_CAP = 100;
const TEXT_CAP = 300;
const INPUT_OPERATORS = new Set(["invalid_input", "boundary_input"]);
const EXERCISED: ReadonlySet<OutcomeStatus> = new Set(["completed", "stopped"]);
const NOT_RUN: ReadonlySet<OutcomeStatus> = new Set(["skipped", "not_reached"]);
export const HISTORY_BACK_NOT_COVERED = "history back not covered";

/** The key a pursuit of one operator of an objective is known by in outcomes and the action log. */
export const pursuitKey = (objectiveId: string, operator?: string): string => (operator ? `${objectiveId}:${operator}` : objectiveId);
const splitKey = (key: string): { id: string; operator?: string } => {
    const i = key.indexOf(":");
    return i < 0 ? { id: key } : { id: key.slice(0, i), operator: key.slice(i + 1) };
};

const clip = (t: string) => (t.length > TEXT_CAP ? `${t.slice(0, TEXT_CAP)}…` : t);
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** An address or path template as a state's address pattern: `{id}`, `{{name}}` and `:name` segments count as ids. */
const patternOf = (path: string) => pathPattern(path.replace(/\{\{[^}]*\}\}|\{[^}/]*\}/g, "0").replace(/(?<=\/):[A-Za-z_]\w*/g, "0"));
const statePath = (state: string) => (state.includes("|") ? state.slice(0, state.lastIndexOf("|")) : state);
const endpointOf = (method: string, path: string) => `${method.trim().toUpperCase()} ${patternOf(path)}`;
const lower = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();

function tally(all: ReadonlyArray<readonly [string, boolean]>): Tally {
    const missed = [...new Set(all.filter(([, hit]) => !hit).map(([k]) => clip(k)))].sort(byText);
    return { total: all.length, exercised: all.filter(([, hit]) => hit).length, notExercised: missed.slice(0, LIST_CAP), more: Math.max(0, missed.length - LIST_CAP) };
}

const STATUS_ORDER: OutcomeStatus[] = ["completed", "stopped", "interrupted", "unsafe", "environment_failure", "skipped", "not_reached"];

export function coverageOf(input: CoverageInput): CoverageRecord {
    const pages = input.model.pages ?? [];
    const tests = input.tests ?? [];
    const performed = input.actionLog.filter((r) => r.result === "performed");

    // Pursuits: what happened to each key, by the loop and by saved tests.
    const outcomesOf = new Map<string, ObjectiveOutcome[]>();
    for (const o of input.outcomes) outcomesOf.set(o.objectiveId, [...(outcomesOf.get(o.objectiveId) ?? []), o]);
    const exercisedKeys = new Set<string>([...input.outcomes.filter((o) => EXERCISED.has(o.status)).map((o) => o.objectiveId)]);
    for (const t of tests) if (t.objective?.id) exercisedKeys.add(pursuitKey(t.objective.id, t.objective.operator));
    // A saved check citing a rule's ref checks the rule as stated: the same pursuit key a pursuit of it has, never a bare id (which
    // would count that pursuit twice).
    const sourcedChecks = new Set(tests.flatMap((t) => t.steps.filter((s) => s.action === "assert" && s.source).map((s) => s.source!)));
    for (const o of input.objectives) if (o.kind === "rule" && sourcedChecks.has(o.source.ref)) exercisedKeys.add(pursuitKey(o.id, "as_stated"));
    const ran = (id: string, op?: string) => exercisedKeys.has(id) || (op !== undefined && exercisedKeys.has(pursuitKey(id, op)));
    const ranAny = (o: Objective) => exercisedKeys.has(o.id) || [...exercisedKeys].some((k) => splitKey(k).id === o.id);
    /** The most telling outcome of a key (or its bare objective), for a reason. */
    const mostTelling = (a: ObjectiveOutcome, b: ObjectiveOutcome) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || byText(a.reason, b.reason);
    const outcomeFor = (id: string, op: string) => [...(outcomesOf.get(pursuitKey(id, op)) ?? []), ...(outcomesOf.get(id) ?? [])].sort(mostTelling)[0];

    // Pages and states.
    const visitedPaths = new Set(performed.map((r) => statePath(r.state)));
    for (const t of tests) for (const s of t.steps) if (s.action === "navigate" && s.url) visitedPaths.add(patternOf(s.url));
    const pagePattern = new Map(pages.map((p) => [p.id, patternOf(p.path)]));
    const known = new Set(pagePattern.values());
    const unknown = [...visitedPaths].filter((p) => !known.has(p)).sort(byText);
    const actionsOn = (pattern: string, rows = performed) => rows.filter((r) => statePath(r.state) === pattern).map((r) => lower(r.action));

    // Endpoints exercised by saved tests and by controls the model saw call them.
    const endpointsHit = new Set<string>();
    for (const t of tests) for (const s of t.steps) if (s.action === "request" && s.method && s.path) endpointsHit.add(endpointOf(s.method, s.path));
    for (const p of pages) {
        const done = actionsOn(pagePattern.get(p.id)!);
        for (const i of p.interactions ?? []) if (i.control.trim() && done.some((a) => a.includes(lower(i.control)))) endpointsHit.add(endpointOf(i.method, i.path));
    }

    // Workflow steps, by what was done during the workflow objective's pursuits.
    const workflowObjective = new Map(input.objectives.filter((o) => o.kind === "workflow").map((o) => [o.source.ref, o]));
    const workflowSteps: Array<[string, boolean]> = [];
    for (const w of input.model.workflows ?? []) {
        const obj = workflowObjective.get(w.id);
        const rows = obj ? performed.filter((r) => splitKey(r.objectiveId).id === obj.id) : [];
        const completed = obj ? ranAny(obj) : false;
        for (const s of [...w.steps].sort((a, b) => a.order - b.order)) {
            const pattern = s.page ? pagePattern.get(s.page) : undefined;
            const hit = s.page ? pattern !== undefined && actionsOn(pattern, rows).length > 0 : completed;
            workflowSteps.push([`${w.id} #${s.order} ${s.action}`, hit]);
            const m = hit && s.endpoint ? /^([A-Za-z]+)\s+(\S+)/.exec(s.endpoint.trim()) : null;
            if (m) endpointsHit.add(endpointOf(m[1]!, m[2]!));
        }
    }

    const objectivesOf = (kind: Objective["kind"]) => input.objectives.filter((o) => o.kind === kind);
    const transitionHit = new Map(objectivesOf("transition").map((o) => [o.source.ref, ranAny(o)]));

    const inputClasses = new Map<string, boolean>();
    for (const o of objectivesOf("constraint")) {
        const ops = new Set(o.operators.filter((op) => INPUT_OPERATORS.has(op)) as string[]);
        for (const k of exercisedKeys) if (splitKey(k).id === o.id && splitKey(k).operator) ops.add(splitKey(k).operator!);
        for (const op of ops) inputClasses.set(`${o.source.ref} ${op}`, ran(o.id, op));
    }

    // What nothing exercised, highest priority first.
    const unexploredAll = input.objectives
        .filter((o) => !ranAny(o))
        .sort((a, b) => b.priority - a.priority || byText(a.id, b.id))
        .map((o): UnexploredItem => {
            const last = input.outcomes.filter((x) => splitKey(x.objectiveId).id === o.id).sort(mostTelling)[0];
            const status =
                o.kind === "coverage-gap" ? "coverage gap: no source states what should happen, so nothing was run" : last ? `${NOT_RUN.has(last.status) ? "not run" : "not finished"}: ${last.reason}` : "not run: not reached in this session";
            return { objectiveId: o.id, kind: o.kind, source: clip(o.source.ref), priority: o.priority, reason: o.reason, status: clip(status) };
        });

    // Every operator that did not run, with its reason.
    const notRun = new Map<string, NotRunOperator>();
    const add = (n: NotRunOperator) => notRun.set(JSON.stringify([n.objectiveId ?? "", n.operator]), { ...n, reason: clip(n.reason) });
    for (const s of [...(input.skipped ?? [])].sort((a, b) => byText(JSON.stringify(a), JSON.stringify(b)))) if (!ran(s.objectiveId, s.operator)) add({ objectiveId: s.objectiveId, operator: s.operator, reason: s.reason });
    for (const o of input.objectives)
        for (const op of o.operators) {
            if (ran(o.id, op) || notRun.has(JSON.stringify([o.id, op]))) continue;
            const last = outcomeFor(o.id, op);
            add({ objectiveId: o.id, operator: op, reason: last ? `${NOT_RUN.has(last.status) ? "not run" : "not finished"}: ${last.reason}` : "not run: not reached in this session" });
        }
    if (input.objectives.some((o) => o.operators.includes("back"))) add({ operator: "history_back", reason: HISTORY_BACK_NOT_COVERED });
    const notRunAll = [...notRun.entries()].sort(([a], [b]) => byText(a, b)).map(([, n]) => n);

    // A bare id (an outcome for the whole objective) is one scenario, unless a pursuit of one of its operators is already counted.
    const withOperator = new Set([...exercisedKeys].filter((k) => splitKey(k).operator).map((k) => splitKey(k).id));
    const scenarios = new Set([...exercisedKeys].filter((k) => splitKey(k).operator || !withOperator.has(k)));
    return {
        pages: { ...tally(pages.map((p) => [p.path, visitedPaths.has(pagePattern.get(p.id)!)] as const)), unknown: unknown.slice(0, LIST_CAP).map(clip) },
        states: new Set(performed.map((r) => r.state)).size,
        elements: tally(
            pages.flatMap((p) => {
                const done = actionsOn(pagePattern.get(p.id)!);
                return (p.elements ?? []).filter((e) => e.name.trim()).map((e) => [`${p.path} ${e.role ?? ""} "${e.name}"`, done.some((a) => a.includes(lower(e.name)))] as const);
            }),
        ),
        workflowSteps: tally(workflowSteps),
        transitions: tally((input.model.transitions ?? []).map((t) => {
            const ref = `transition:${t.entity}:${t.from}->${t.to}`;
            return [ref, transitionHit.get(ref) ?? false] as const;
        })),
        inputClasses: tally([...inputClasses.entries()]),
        rules: tally(objectivesOf("rule").map((o) => [o.source.ref, ranAny(o)] as const)),
        endpoints: tally((input.model.endpoints ?? []).map((e) => [`${e.method.toUpperCase()} ${e.path}`, endpointsHit.has(endpointOf(e.method, e.path))] as const)),
        uniqueScenarios: scenarios.size,
        unexplored: unexploredAll.slice(0, LIST_CAP),
        unexploredMore: Math.max(0, unexploredAll.length - LIST_CAP),
        notRun: notRunAll.slice(0, 2 * LIST_CAP),
        notRunMore: Math.max(0, notRunAll.length - 2 * LIST_CAP),
    };
}
