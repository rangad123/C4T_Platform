/**
 * Perturbation operators (testing-engine Phase 3, P3-15): each operator an objective allows (objectives.ts) becomes a scenario the
 * authoring agent pursues, and `operatorApplied` says from the recorded steps alone whether the operator really was applied.
 *
 * - The steps the agent must take are fixed wording per operator. Text from the model (page addresses, workflow step names, field values
 *   from input classes) appears only quoted, after those steps, so nothing read from a page or a document can add an action.
 * - Every expected result is the objective's own expected result (copied from its source by objectives.ts) inside fixed wording, and
 *   cites the source ref. No expected text comes from a model's output.
 * - No new step action (Phase 3 plan, decision 3): refresh is a `navigate` to the current address, back is a `navigate` to the previous
 *   address ("back (by address)"; the browser's history back is not covered), direct URL is a `navigate`, double submit is two recorded
 *   clicks, repeat is the steps again.
 * - Every data-changing operator needs the project's "Include API tests that change data" (`dataChanges`). The two that only submit a
 *   form ("as stated", "invalid input"; owner, 2026-11-21) need nothing more; the others (boundary input, double submit, repeat,
 *   cancel) also need the server's EXPLORE_DATA_OPERATORS (`dataOperators`, decision 6). A skipped one names the setting that is off.
 *   An objective that needs a second account is skipped with "needs a second account" (Q2: two-account checks are Phase 4).
 * Pure: no AI, no browser, no clock.
 */
import { expandRepeats, REPEAT_MAX, ScenarioSchema, type Scenario, type Step } from "../spec/schema.js";
import type { InputClass } from "./input-classes.js";
import { OBJECTIVE_OPERATORS, type Objective, type ObjectiveOperator } from "./objectives.js";

/** Why an operator did not become a scenario. Coverage (P3-16) lists each under "not run" with this reason. */
export const SKIP_REASONS = {
    /** The project's own switch is off: no data-changing operator runs. */
    dataOff: "data changes off: the project's “Include API tests that change data” is off",
    /** The project allows data changes, but the server does not allow the operators beyond submitting a form. */
    serverDataOff: "data changes off: this server does not allow this operator (EXPLORE_DATA_OPERATORS)",
    secondAccount: "needs a second account",
    notAllowed: "not an operator of this objective",
    noLaterPage: "no page for a later step",
    noInputClasses: "no input classes",
} as const;
export type SkipReason = (typeof SKIP_REASONS)[keyof typeof SKIP_REASONS];

/**
 * Whether an operator may change the application's data. Submitting twice, doing it again, cancelling half-way and a boundary value the
 * form accepts all write. Following the source as stated and typing a value the form must refuse both submit forms, and a form submitted
 * is a data change (spec Assumption 5; owner, 2026-11-21, CP2 M-7), so they run only where data changes are allowed too. Opening an
 * address, going back by address and reloading only read (a reload is a `navigate`, a GET, so it never re-posts a form).
 */
export const DATA_CHANGING: Readonly<Record<ObjectiveOperator, boolean>> = {
    as_stated: true,
    invalid_input: true,
    boundary_input: true,
    double_submit: true,
    repeat: true,
    direct_url: false,
    back: false,
    refresh: false,
    cancel: true,
};

/**
 * The data-changing operators that only submit a form the way the source describes (as stated) or with a value it must refuse (invalid
 * input): the project's "Include API tests that change data" alone allows them (owner, 2026-11-21). The rest also need the server's setting.
 */
export const SUBMITS_FORM: Readonly<Record<ObjectiveOperator, boolean>> = {
    as_stated: true,
    invalid_input: true,
    boundary_input: false,
    double_submit: false,
    repeat: false,
    direct_url: false,
    back: false,
    refresh: false,
    cancel: false,
};

/**
 * One value for a field, from its constraints (P3-14, explore/input-classes.ts, maps onto this). `accepted`: the constraint says the form
 * takes it; `boundary`: it sits at or just past a stated limit.
 */
export interface PerturbInputClass {
    name: string;
    value: string;
    accepted: boolean;
    boundary?: boolean;
}

/**
 * An input class (P3-14) as this file's input: `accepted` when the class's expected result is that the form takes it; `boundary` for a
 * value at or around a stated limit, or a long value one past the maximum length (a long value with no limit is not a boundary).
 */
export function perturbInputClassOf(c: InputClass): PerturbInputClass {
    return {
        name: [c.class, c.variant].filter(Boolean).join(" ") + (c.limit ? ` (${c.limit})` : ""),
        value: c.value,
        accepted: c.expected === "accepted",
        boundary: c.class === "boundary" || (c.class === "long" && c.limit !== undefined),
    };
}

const isInputClass = (c: PerturbInputClass | InputClass): c is InputClass => "key" in c && "class" in c;

/** A run of one letter or digit this long or longer is written as a {{repeat.<c>.<n>}} placeholder in the prompt. */
const REPEAT_FROM = 50;
/**
 * A value as the prompt shows it: each run of REPEAT_FROM or more of one letter or digit becomes `{{repeat.<c>.<n>}}` (spec/schema.ts),
 * which the step renders back to the exact value when it runs. So a 2,001-character class is a short line, and the agent copies it whole.
 */
export function promptValueOf(value: string): string {
    return value.replace(/([A-Za-z0-9])\1+/g, (run, c: string) => (run.length >= REPEAT_FROM && run.length <= REPEAT_MAX ? `{{repeat.${c}.${run.length}}}` : run));
}
const shownValue = (c: PerturbInputClass) => JSON.stringify(promptValueOf(c.value).slice(0, 1100));

/** A workflow's stated steps, with the page each happens on when the model knows it (P3-18 `objectiveInputs`). */
export interface PerturbWorkflow {
    preconditions?: readonly string[];
    steps: ReadonlyArray<{ order: number; action: string; page?: string }>;
}

export interface PerturbOptions {
    /** The project's "Include API tests that change data" is on: the form-submitting operators may run. Absent: off. */
    dataChanges?: boolean;
    /** Every data-changing operator is allowed (EXPLORE_DATA_OPERATORS=true and the project allows data changes; orchestrator.ts). Absent: off. */
    dataOperators?: boolean;
    /** For a workflow objective: its stated steps and preconditions. */
    workflow?: PerturbWorkflow;
    /** For a constraint objective: the field's input classes (P3-14's own, or already mapped with perturbInputClassOf). */
    inputClasses?: ReadonlyArray<PerturbInputClass | InputClass>;
    /** Where the scenario starts; default the first step's page, a constraint's page, or "/". */
    startPath?: string;
    requiresAuth?: boolean;
    /** cancel only: the order of the stated step to cancel at; default the first. */
    at?: number;
}

/** What `operatorApplied` compares the recorded steps with: the address a direct URL opens, the values an input operator fills. */
export interface OperatorCheck {
    url?: string;
    values?: string[];
}

export type PerturbResult =
    | { status: "ready"; operator: ObjectiveOperator; dataChanging: boolean; scenario: Scenario; check: OperatorCheck }
    | { status: "skipped"; operator: ObjectiveOperator; reason: SkipReason };

const TITLES: Record<ObjectiveOperator, string> = {
    as_stated: "As stated",
    invalid_input: "Invalid input",
    boundary_input: "Boundary input",
    double_submit: "Double submit",
    repeat: "Repeat",
    direct_url: "Direct URL to a later step",
    back: "Back (by address)",
    refresh: "Refresh",
    cancel: "Cancel",
};

const norm = (t: string) => t.replace(/\s+/g, " ").trim();
const clip = (t: string, n: number) => {
    const s = norm(t);
    return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
};
const quote = (t: string, n = 200) => JSON.stringify(clip(t, n));

/** Words that say the check involves someone else's data or a second sign-in: two-account checks are Phase 4 (Q2). */
const SECOND_ACCOUNT =
    /\b(?:another|other|a different|a second|second|different)\s+(?:user|account|customer|member|tenant|person|people|users|accounts|customers|members|tenants)\b|\bsomeone else\b|\bcross[- ]account\b/i;
const needsSecondAccount = (o: Objective, wf?: PerturbWorkflow) => SECOND_ACCOUNT.test([o.question, o.expected, ...(wf?.preconditions ?? [])].join(" \n "));

const sortedSteps = (wf?: PerturbWorkflow) => [...(wf?.steps ?? [])].sort((a, b) => a.order - b.order || (a.action < b.action ? -1 : a.action > b.action ? 1 : 0));

/**
 * Fixed wording around the source's expected result, citing the source. The expected text is quoted as data (one JSON string): it comes
 * from documents or the page, and it reaches the test writer's prompt.
 */
function expectedFor(o: Objective, op: ObjectiveOperator, stepName?: string): string {
    const cite = ` (source: ${norm(o.source.ref)})`;
    const expected = JSON.stringify(norm(o.expected));
    switch (op) {
        case "double_submit":
            return `Submitting twice has the effect of submitting once: ${expected}${cite}`;
        case "repeat":
            return `Done again, it still holds as stated: ${expected}${cite}`;
        case "direct_url":
            return `Opening a later step's address directly does not skip the earlier steps; this holds only after every stated step: ${expected}${cite}`;
        case "back":
            return `After going back to the previous page by its address, nothing is lost or done twice: ${expected}${cite}`;
        case "refresh":
            return `After reloading the page, it still holds: ${expected}${cite}`;
        case "cancel":
            return `Cancelling at ${stepName ? `the step ${quote(stepName, 100)}` : "a stated step"} leaves nothing half-done; this happens only when every step is completed: ${expected}${cite}`;
        default:
            return `${expected}${cite}`;
    }
}

/** The steps the agent must take, fixed per operator; model text only quoted. */
function stepsFor(op: ObjectiveOperator, ctx: { later?: string; cancelAt?: string; values?: PerturbInputClass[]; page?: string }): string[] {
    switch (op) {
        case "as_stated":
            return ["Do the preconditions, then follow the stated steps in order.", "Check each expected result with an assert that cites it."];
        case "double_submit":
            return ["Follow the stated steps up to the final submit.", "Click the control that submits twice in a row, with no other step between the two clicks.", "Check each expected result."];
        case "repeat":
            return ["Follow the stated steps to the end.", "Do the same steps again, in the same order and with the same values.", "Check each expected result after the second time."];
        case "direct_url":
            return [`Open ${quote(ctx.later ?? "/")} directly by its address, before doing any earlier step.`, "Do not do the earlier steps first.", "Check each expected result against what the page lets you do."];
        case "back":
            return [
                "Follow the stated steps until a step has taken you to a new page.",
                "Open the address of the previous page again with a navigate step (do not use the browser's back button).",
                "Continue the stated steps from there, and check each expected result.",
            ];
        case "refresh":
            return ["Follow the stated steps; after a step that changes what the page shows, reload the page by opening its current address again with a navigate step.", "Continue the stated steps, and check each expected result."];
        case "cancel":
            return [
                `Follow the stated steps up to and including ${ctx.cancelAt ? `the step ${quote(ctx.cancelAt, 100)}` : "the first step that offers a way to cancel"}.`,
                "Cancel there: click the control that cancels, closes or discards, or press Escape. Do not complete the remaining steps.",
                "Check each expected result.",
            ];
        case "invalid_input":
        case "boundary_input": {
            const list = (ctx.values ?? []).map((c, i) => `   ${String.fromCharCode(97 + (i % 26))}. ${clip(c.name, 60)}: ${shownValue(c)} (the constraint says the form ${c.accepted ? "accepts" : "refuses"} it)`);
            const repeats = list.some((l) => l.includes("{{repeat."));
            return [
                `On the form${ctx.page ? ` at ${quote(ctx.page)}` : ""}, fill the field with each value below, one at a time, and submit after each:\n${list.join("\n")}`,
                ...(repeats ? ["Type each value exactly as written, placeholders included: {{repeat.a.2001}} is the letter a written 2001 times, filled in when the step runs."] : []),
                "Check each expected result after each submit.",
            ];
        }
    }
}

function laterPage(wf?: PerturbWorkflow): string | undefined {
    const steps = sortedSteps(wf);
    if (steps.length < 2) return undefined;
    const first = steps[0]!.page;
    for (const s of steps.slice(1).reverse()) if (s.page?.trim() && s.page.trim() !== first?.trim()) return s.page.trim();
    return undefined;
}

/**
 * The scenario for one objective and one operator, or why it is skipped (see the file comment). The checks run in a fixed order: the
 * objective allows the operator, it does not need a second account, data changes are allowed, then the operator has what it needs.
 */
export function scenarioFor(o: Objective, op: ObjectiveOperator, options: PerturbOptions = {}): PerturbResult {
    const skip = (reason: SkipReason): PerturbResult => ({ status: "skipped", operator: op, reason });
    if (!o.operators.includes(op) || !OBJECTIVE_OPERATORS.includes(op)) return skip(SKIP_REASONS.notAllowed);
    if (needsSecondAccount(o, options.workflow)) return skip(SKIP_REASONS.secondAccount);
    if (DATA_CHANGING[op]) {
        // `dataOperators` is only ever true with the project's switch on (orchestrator.ts), so it allows the form-submitting ones too.
        if (options.dataChanges !== true && options.dataOperators !== true) return skip(SKIP_REASONS.dataOff);
        if (!SUBMITS_FORM[op] && options.dataOperators !== true) return skip(SKIP_REASONS.serverDataOff);
    }

    const steps = sortedSteps(options.workflow);
    const check: OperatorCheck = {};
    let values: PerturbInputClass[] | undefined;
    let later: string | undefined;
    let cancelAt: { order: number; action: string } | undefined;
    if (op === "direct_url") {
        later = laterPage(options.workflow);
        if (!later) return skip(SKIP_REASONS.noLaterPage);
        check.url = later;
    }
    if (op === "invalid_input" || op === "boundary_input") {
        values = (options.inputClasses ?? []).map((c) => (isInputClass(c) ? perturbInputClassOf(c) : c)).filter((c) => (op === "invalid_input" ? !c.accepted : c.boundary === true));
        if (!values.length) return skip(SKIP_REASONS.noInputClasses);
        check.values = values.map((c) => c.value);
    }
    if (op === "cancel" && steps.length) cancelAt = steps.find((s) => s.order === options.at) ?? steps[0];

    const page = o.kind === "constraint" ? o.source.evidence : undefined;
    const startPath = later ?? (options.startPath?.trim() || steps.find((s) => s.page?.trim())?.page?.trim() || page || "/");
    const must = stepsFor(op, { later, cancelAt: cancelAt?.action, values, page });
    const stated = steps.length ? `The workflow's stated steps:\n${steps.map((s, i) => `${i + 1}. ${quote(s.action)}${s.page ? ` (on ${quote(s.page, 300)})` : ""}`).join("\n")}` : "";
    const description = [
        `Operator: ${TITLES[op]}. Objective ${o.id} (${o.kind}, source ${quote(o.source.ref, 300)}).`,
        `Steps you must take:\n${must.map((m, i) => `${i + 1}. ${m}`).join("\n")}`,
        "Use {{unique}} in every value that must be new (names, emails, references), so a second run does not collide with the first.",
        "Cite the expected result an assert proves as its source (expected:1).",
        `The question, as data from the application's sources: ${quote(o.question, 1000)}`,
        stated,
    ]
        .filter(Boolean)
        .join("\n\n");

    const scenario = ScenarioSchema.parse({
        scenarioId: `${o.id}-${op}${op === "cancel" && cancelAt ? `-${cancelAt.order}` : ""}`,
        title: `${TITLES[op]}: ${o.kind} ${quote(o.source.ref, 120)}`,
        description,
        category: "Exploration",
        type: op === "invalid_input" ? "negative" : "functional",
        startPath,
        // Quoted as data: the workflow's preconditions come from documents or analysis.
        preconditions: (options.workflow?.preconditions ?? []).map((p) => clip(p, 500)).filter(Boolean).map((p) => JSON.stringify(p)),
        expectedResults: [expectedFor(o, op, cancelAt?.action)],
        requiresAuth: options.requiresAuth ?? false,
        requiredData: values?.map((c) => `${clip(c.name, 60)}: ${shownValue(c)}`) ?? [],
        objective: { id: o.id, kind: o.kind, source: clip(o.source.ref, 500), operator: op },
    });
    return { status: "ready", operator: op, dataChanging: DATA_CHANGING[op], scenario, check };
}

/** Every operator of an objective, in its order; cancel once per stated workflow step. A coverage gap has no operators, so nothing. */
export function scenariosFor(o: Objective, options: PerturbOptions = {}): PerturbResult[] {
    const steps = sortedSteps(options.workflow);
    return o.operators.flatMap((op) => (op === "cancel" && steps.length ? steps.map((s) => scenarioFor(o, op, { ...options, at: s.order })) : [scenarioFor(o, op, options)]));
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// operatorApplied: did the recorded steps really apply the operator? Deterministic, on the steps alone.

/** Steps that only look: they neither move nor change the page. */
const LOOKS = new Set<Step["action"]>(["assert", "assertResponse", "wait", "remember"]);
const MAX_STEPS = 500;

/** Path and query of an address, so "/cart", "/cart/" and "https://host/cart" compare equal. */
function addressOf(url: string): string {
    try {
        const u = new URL(url.trim(), "http://same.invalid");
        const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
        return `${path}${u.search}`;
    } catch {
        return url.trim();
    }
}

/** What a step does, without its wording or timing. */
function identity(s: Step): string {
    const r = s as Record<string, unknown>;
    return JSON.stringify([s.action, r.url === undefined ? null : addressOf(String(r.url)), r.locator ?? null, r.value ?? null, r.key ?? null, r.inPopup ?? null]);
}

const CANCEL_WORDS = /\b(?:cancel|close|discard|abort|dismiss|never ?mind)\b/i;

/**
 * Whether `steps` apply `op`:
 * - as_stated: anything was recorded;
 * - double_submit: the same control clicked twice in a row;
 * - repeat: a run of two or more steps (looks left out) done again right after itself;
 * - refresh: the address last opened is opened again after something was done on it;
 * - back: an address opened before is opened again after a different one;
 * - direct_url: `check.url` is the first address opened, before any other action;
 * - cancel: a click on a control named cancel / close / discard / abort / dismiss, or Escape pressed;
 * - invalid_input / boundary_input: a value from `check.values` is filled (as written, or as the value its {{repeat.<c>.<n>}} placeholders
 *   render) and then a click or key press follows.
 */
export function operatorApplied(steps: readonly Step[], op: ObjectiveOperator, check: OperatorCheck = {}): boolean {
    const all = steps.slice(0, MAX_STEPS);
    switch (op) {
        case "as_stated":
            return all.length > 0;
        case "double_submit":
            return all.some((s, i) => i > 0 && s.action === "click" && all[i - 1]!.action === "click" && identity(s) === identity(all[i - 1]!));
        case "repeat": {
            const ids = all.filter((s) => !LOOKS.has(s.action)).map(identity);
            for (let k = 2; 2 * k <= ids.length; k++)
                for (let i = 0; i + 2 * k <= ids.length; i++) if (ids.slice(i, i + k).every((id, j) => id === ids[i + k + j])) return true;
            return false;
        }
        case "refresh":
        case "back": {
            let previous: string | undefined;
            const seen = new Set<string>();
            let acted = false;
            for (const s of all) {
                if (s.action !== "navigate") {
                    if (!LOOKS.has(s.action)) acted = true;
                    continue;
                }
                const at = addressOf(s.url);
                if (op === "refresh" && previous === at && acted) return true;
                if (op === "back" && previous !== undefined && previous !== at && seen.has(at)) return true;
                if (previous !== undefined) seen.add(previous);
                previous = at;
                acted = false;
            }
            return false;
        }
        case "direct_url": {
            if (!check.url) return false;
            const first = all.find((s) => !LOOKS.has(s.action));
            return first?.action === "navigate" && addressOf(first.url) === addressOf(check.url);
        }
        case "cancel":
            return all.some(
                (s) =>
                    (s.action === "click" && CANCEL_WORDS.test(String((s.locator as { value?: unknown }).value ?? ""))) || (s.action === "press" && /^esc(?:ape)?$/i.test(s.key.trim())),
            );
        case "invalid_input":
        case "boundary_input": {
            const values = new Set(check.values ?? []);
            if (!values.size) return false;
            return all.some((s, i) => s.action === "fill" && (values.has(s.value) || values.has(expandRepeats(s.value))) && all.slice(i + 1).some((t) => t.action === "click" || t.action === "press"));
        }
    }
}
