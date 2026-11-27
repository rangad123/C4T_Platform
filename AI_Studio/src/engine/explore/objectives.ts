/**
 * Exploration objectives (testing-engine Phase 3): what an exploration session sets out to check, worked out from the application model
 * without AI. Each objective carries the expected result its source states and that source's ref, so a failing check can say where the
 * expectation came from. Never from what the application did: a transition only seen in the application (or only guessed) becomes a
 * coverage gap, which records that no source states it and runs nothing.
 *
 * - one per usable rule (stated by a source or confirmed by a person, never rejected, its evidence not gone; `usableRules`) whose
 *   expected result can be checked;
 * - one per workflow a source states (`usableWorkflows`), and one per workflow only followed while exploring (`stated: false`, last);
 * - one per form field whose page declares a constraint (required, a typed value, limits, a pattern, a list of options); on a page a
 *   workflow's step happens on (a form the exploration fills), it ranks with the highest-ranked such workflow, so its input classes are
 *   tried beside that workflow instead of after every other objective (or not at all, past the cap);
 * - one per stated transition; a coverage gap per transition nobody states.
 *
 * Text from the model (page and field names, workflow steps, rule wording) is data: it becomes the bounded question and expected text and
 * may raise the priority, but budgets come only from the options and operators only from the objective's kind, so nothing read from a
 * page can lengthen a session or add an action. The result does not depend on the order of the model: objectives are deduplicated by
 * their fingerprint and sorted by priority, then fingerprint.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { AGENT_LIMITS } from "../agent/objective.js";
import { STATING_SOURCES, type SourceType } from "../intel/model.js";
import { usableRules, usableWorkflows, type KnowledgeRule, type KnowledgeWorkflow } from "../planning/planner.js";
import { priorityOf, type PriorityInput } from "./priority.js";

export const OBJECTIVE_KINDS = ["rule", "workflow", "constraint", "transition", "coverage-gap"] as const;
export type ObjectiveKind = (typeof OBJECTIVE_KINDS)[number];

/**
 * What an objective may do to the application. as_stated: follow the source as written; the rest are the perturbations P3-15 compiles to
 * steps (input classes from a field's constraints, submitting twice, repeating, opening a later step's address directly, going back,
 * reloading, cancelling).
 */
export const OBJECTIVE_OPERATORS = ["as_stated", "invalid_input", "boundary_input", "double_submit", "repeat", "direct_url", "back", "refresh", "cancel"] as const;
export type ObjectiveOperator = (typeof OBJECTIVE_OPERATORS)[number];

/** The operators of each kind, fixed here. A coverage gap has none: there is nothing stated to check. */
const KIND_OPERATORS: Record<ObjectiveKind, readonly ObjectiveOperator[]> = {
    rule: ["as_stated"],
    workflow: ["as_stated", "double_submit", "repeat", "direct_url", "back", "refresh", "cancel"],
    constraint: ["invalid_input", "boundary_input"],
    transition: ["as_stated", "repeat", "direct_url"],
    "coverage-gap": [],
};

const QUESTION_MAX = 1000;
const EXPECTED_MAX = 1000;
const REF_MAX = 500;
/** The longest source ref an objective has. */
export const OBJECTIVE_REF_MAX = REF_MAX;
/** No level asks for more objectives in one session than this. */
export const MAX_OBJECTIVES = 500;
/** At most this many explored source refs are read (`ObjectiveOptions.explored`). */
export const MAX_EXPLORED = 5000;

const limit = (l: { min: number; max: number }) => z.number().int().min(l.min).max(l.max);
export const ObjectiveBudgetSchema = z.object({ steps: limit(AGENT_LIMITS.steps), minutes: limit(AGENT_LIMITS.minutes), tokens: limit(AGENT_LIMITS.tokens) }).strict();
export type ObjectiveBudget = z.infer<typeof ObjectiveBudgetSchema>;

export const ObjectiveSchema = z
    .object({
        /** OBJ- and the start of the fingerprint: the same objective has the same id in every analysis. */
        id: z.string().regex(/^OBJ-[0-9a-f]{16}$/),
        kind: z.enum(OBJECTIVE_KINDS),
        /** The rule ref, workflow id, page/form/field, or transition the objective comes from, and a pointer to its evidence. */
        source: z.object({ ref: z.string().min(1).max(REF_MAX), evidence: z.string().max(REF_MAX).optional() }).strict(),
        question: z.string().min(1).max(QUESTION_MAX),
        /** What the source states should happen; empty only for a coverage gap. */
        expected: z.string().max(EXPECTED_MAX),
        /**
         * false: no source states a result to check (a workflow with no postconditions), so `expected` is the engine's own wording of
         * "the steps can be done", and a failing check of it is observed only, never captured (queue row 228). Absent: stated.
         */
        stated: z.literal(false).optional(),
        operators: z.array(z.enum(OBJECTIVE_OPERATORS)).max(OBJECTIVE_OPERATORS.length),
        budget: ObjectiveBudgetSchema,
        priority: z.number().int(),
        reason: z.string().min(1).max(500),
        fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict()
    .superRefine((o, ctx) => {
        if (o.kind !== "coverage-gap" && !o.expected.trim()) ctx.addIssue({ code: "custom", path: ["expected"], message: "An objective states what its source expects." });
        if (o.kind === "coverage-gap" && (o.expected || o.operators.length)) ctx.addIssue({ code: "custom", path: ["kind"], message: "A coverage gap has no expected result and runs nothing." });
    });
export type Objective = z.infer<typeof ObjectiveSchema>;

/** What a session may spend on objectives: from the exploration level, never from the model. */
export const ObjectiveOptionsSchema = z
    .object({
        maxObjectives: z.number().int().min(0).max(MAX_OBJECTIVES),
        /** Per objective; bounded to the objective agent's limits. */
        budget: z.object({ steps: z.number(), minutes: z.number(), tokens: z.number() }).strict(),
        /** Only these operators may run (e.g. without the data-changing ones); default: each kind's own. */
        operators: z.array(z.enum(OBJECTIVE_OPERATORS)).max(OBJECTIVE_OPERATORS.length).optional(),
        /** Source refs whose state was explored before (raises the priority of the others). */
        explored: z.array(z.string().max(REF_MAX)).max(MAX_EXPLORED).optional(),
    })
    .strict();
export type ObjectiveOptions = z.input<typeof ObjectiveOptionsSchema>;

/** The parts of the model objectives read; the stored model (intel/model.ts) has these shapes. */
export interface ObjectiveModel {
    pages?: ReadonlyArray<{
        id: string;
        path: string;
        forms?: ReadonlyArray<{ name?: string; fields?: ReadonlyArray<ObjectiveField> }>;
    }>;
    transitions?: ReadonlyArray<{ entity: string; from: string; to: string; trigger?: string; sourceType: SourceType; expectation?: boolean; evidence: ReadonlyArray<{ ref: string }> }>;
    /** The page (model id) each workflow step happens on (planner.ts objectiveInputsOf): which forms a workflow fills. */
    workflowSteps?: ReadonlyArray<{ workflowId: string; steps: ReadonlyArray<{ page?: string }> }>;
}
export interface ObjectiveField {
    name: string;
    label?: string;
    type?: string;
    required?: boolean;
    min?: string;
    max?: string;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    options?: readonly string[];
}

export interface ObjectivesResult {
    /** Highest priority first, at most `maxObjectives`. */
    objectives: Objective[];
    /** How many objectives the cap left out. */
    overCap: number;
}

/** Spacing only, as `ruleFingerprint` does: case is content. */
const norm = (t: string) => t.replace(/\s+/g, " ").trim();
const clip = (t: string, n: number) => {
    const s = norm(t);
    return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
};
/** Text from a source or a page as data: one JSON string, so a quote inside it cannot end it (as the planner quotes knowledge). */
const quote = (t: string, n = 200) => JSON.stringify(clip(t, n));

/** sha256 of the kind, the source ref and the expected result, ignoring only spacing. */
export function objectiveFingerprint(o: { kind: ObjectiveKind; source: { ref: string }; expected: string }): string {
    return createHash("sha256").update(JSON.stringify(["objective", o.kind, norm(o.source.ref), norm(o.expected)])).digest("hex");
}

/** Something to check, without its budget, operators or priority (those are added in one place below). */
interface Draft {
    kind: ObjectiveKind;
    ref: string;
    /** false: the expected text is the engine's wording, not a source's (see `stated` on the objective). */
    stated?: false;
    /** A workflow no source states: ranked after every other objective. */
    inferred?: true;
    /** A constraint's page (model id). */
    page?: string;
    evidence?: string;
    question: string;
    expected: string;
    priority: Omit<PriorityInput, "kind" | "unexplored">;
}

/** An expected result that says something: not blank and not a placeholder. */
const checkable = (expected: string) => /[\p{L}\p{N}]/u.test(expected) && !/^(?:n\/?a|tbd|unknown|none|-+)$/i.test(norm(expected));

const fromRules = (rules: readonly KnowledgeRule[]): Draft[] =>
    usableRules(rules)
        .filter((r) => checkable(r.expected))
        .map((r) => ({
            kind: "rule",
            ref: r.ref,
            question: `Does the application keep rule ${clip(r.ref, 100)}: ${quote(r.description, 400)}?`,
            expected: r.expected,
            priority: { sourceText: `${r.description} ${r.expected}`, stated: r.status === "confirmed" ? "confirmed" : "explicit" },
        }));

/** The engine's own wording around a workflow's expected result (`engineWordingIn` in perturb.ts refuses an assert of it). */
export const WORKFLOW_WORDING = { after: "Afterwards:", steps: "Every step completes:" } as const;

/**
 * A workflow a source states gets its stated postconditions as the expected result. A workflow only followed while exploring (inferred)
 * gets one too, `stated: false`, checking only that its steps can be done (never what the application showed afterwards: that is not a
 * source), so E5 covers it; these come after every other objective (`objectivesFrom`), so they only use what the cap leaves.
 */
const fromWorkflows = (workflows: readonly KnowledgeWorkflow[]): Draft[] => {
    const stated = new Set(usableWorkflows(workflows));
    return workflows.map((w) => {
        const inferred = !stated.has(w);
        const steps = [...w.steps].sort((a, b) => a.order - b.order || (a.action < b.action ? -1 : a.action > b.action ? 1 : 0)).map((s) => norm(s.action));
        const post = inferred ? [] : w.postconditions.map(norm).filter(Boolean);
        return {
            kind: "workflow",
            ref: w.id,
            question: inferred
                ? `Can the workflow ${quote(w.name)}, followed while exploring and stated by no source, be completed, and does it hold when repeated, interrupted or reached out of order?`
                : `Can the workflow ${quote(w.name)} be completed as stated, and does it hold when repeated, interrupted or reached out of order?`,
            expected: post.length ? `${WORKFLOW_WORDING.after} ${post.join("; ")}` : `${WORKFLOW_WORDING.steps} ${steps.join(" -> ")}`,
            // No postconditions: nothing a source states can be checked, only that the steps can be done (row 228: WEB-064, WEB-065).
            ...(post.length ? {} : { stated: false as const }),
            ...(inferred ? { inferred: true as const } : {}),
            priority: { sourceText: [w.name, ...steps, ...post].join(" "), stated: inferred ? "none" : "explicit", workflowSteps: steps.length },
        };
    });
};

/** Types whose value the browser checks itself, so declaring one is a constraint. */
const TYPED = new Set(["email", "number", "url", "tel", "date", "datetime-local", "time", "month", "week", "range", "color"]);

function constraintsOf(f: ObjectiveField): string[] {
    const out: string[] = [];
    if (f.required) out.push("a value is required");
    const type = (f.type ?? "text").trim().toLowerCase();
    if (TYPED.has(type)) out.push(`the value must be a valid ${type}`);
    if (f.min !== undefined && f.min !== "") out.push(`at least ${clip(f.min, 100)}`);
    if (f.max !== undefined && f.max !== "") out.push(`at most ${clip(f.max, 100)}`);
    if (f.minLength !== undefined) out.push(`at least ${f.minLength} characters`);
    if (f.maxLength !== undefined) out.push(`at most ${f.maxLength} characters`);
    if (f.pattern) out.push(`it must match the pattern ${quote(f.pattern)}`);
    if (f.options?.length) out.push(`one of ${[...new Set(f.options.map((o) => clip(o, 60)))].sort().slice(0, 20).map((o) => JSON.stringify(o)).join(", ")}`);
    return out;
}

const fromForms = (model: ObjectiveModel): Draft[] =>
    (model.pages ?? []).flatMap((page) =>
        (page.forms ?? []).flatMap((form) =>
            (form.fields ?? []).flatMap((field): Draft[] => {
                const rules = constraintsOf(field);
                if (!rules.length) return [];
                const name = field.label?.trim() || field.name;
                return [
                    {
                        kind: "constraint",
                        ref: clip(`${page.id}/${form.name?.trim() || "form"}/${field.name}`, REF_MAX),
                        page: page.id,
                        evidence: clip(page.path, REF_MAX),
                        question: `Does the form on ${quote(page.path)} refuse a ${quote(name, 100)} value that breaks its stated constraints?`,
                        expected: `The field ${quote(name, 100)} accepts a value only when ${rules.join("; ")}; any other value is refused.`,
                        priority: { sourceText: `${name} ${field.name}`, stated: "explicit" },
                    },
                ];
            }),
        ),
    );

const fromTransitions = (model: ObjectiveModel): Draft[] =>
    (model.transitions ?? []).map((t): Draft => {
        const ref = clip(`transition:${t.entity}:${t.from}->${t.to}`, REF_MAX);
        const evidence = t.evidence[0] ? clip(t.evidence[0].ref, REF_MAX) : undefined;
        const trigger = t.trigger?.trim() ? ` when ${quote(t.trigger)} is done` : "";
        const move = `${quote(t.entity, 100)} from ${quote(t.from, 100)} to ${quote(t.to, 100)}${trigger}`;
        // Only intended behaviour a source states is an expectation; what the application did, or a guess, is a gap in the sources.
        if (t.expectation && STATING_SOURCES.has(t.sourceType))
            return { kind: "transition", ref, evidence, question: `Does ${move} happen as stated, and only from that state?`, expected: `The ${clip(t.entity, 100)} moves ${move}.`, priority: { sourceText: `${t.entity} ${t.trigger ?? ""}`, stated: "explicit" } };
        return { kind: "coverage-gap", ref, evidence, question: `No source states whether ${move} is intended; which document says what should happen?`, expected: "", priority: { sourceText: `${t.entity} ${t.trigger ?? ""}`, stated: "none" } };
    });

/** A total order that does not depend on input order: priority, then fingerprint, then the whole record. */
const compare = (a: Objective, b: Objective) => b.priority - a.priority || (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0) || (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);

/**
 * The objectives of one session from the model, its rules and its workflows (see the file comment). Budgets come from `options.budget`
 * bounded to the objective agent's limits; operators from the kind, narrowed to `options.operators`; the number from
 * `options.maxObjectives`.
 */
export function objectivesFrom(model: ObjectiveModel, rules: readonly KnowledgeRule[], workflows: readonly KnowledgeWorkflow[], options: ObjectiveOptions): ObjectivesResult {
    const opts = ObjectiveOptionsSchema.parse(options);
    const bound = (n: number, l: { min: number; max: number }) => Math.min(l.max, Math.max(l.min, Math.floor(Number.isFinite(n) ? n : l.min)));
    const budget = { steps: bound(opts.budget.steps, AGENT_LIMITS.steps), minutes: bound(opts.budget.minutes, AGENT_LIMITS.minutes), tokens: bound(opts.budget.tokens, AGENT_LIMITS.tokens) };
    const allowed = opts.operators ? new Set<ObjectiveOperator>(opts.operators) : undefined;
    const explored = new Set(opts.explored ?? []);

    const byFingerprint = new Map<string, Objective>();
    const inferred = new Set<string>();
    const drafts = [...fromRules(rules), ...fromWorkflows(workflows), ...fromForms(model), ...fromTransitions(model)];
    const priorityOfDraft = (d: Draft) => priorityOf({ ...d.priority, kind: d.kind, unexplored: opts.explored ? !explored.has(clip(d.ref, REF_MAX)) : undefined });
    // The workflows whose steps happen on each page (forms the exploration fills), with the workflow's own priority.
    const filledBy = new Map<string, { score: number; name: string }>();
    const flowByRef = new Map(drafts.filter((d) => d.kind === "workflow").map((d) => [norm(d.ref), d]));
    for (const w of model.workflowSteps ?? []) {
        const d = flowByRef.get(norm(w.workflowId));
        if (!d) continue;
        const score = priorityOfDraft(d).score;
        const name = workflows.find((x) => norm(x.id) === norm(w.workflowId))?.name ?? w.workflowId;
        for (const s of w.steps) {
            const kept = s.page ? filledBy.get(s.page) : undefined;
            if (s.page && (!kept || score > kept.score || (score === kept.score && name < kept.name))) filledBy.set(s.page, { score, name });
        }
    }
    for (const d of drafts) {
        const ref = clip(d.ref, REF_MAX);
        const expected = d.kind === "coverage-gap" ? "" : clip(d.expected, EXPECTED_MAX);
        const fingerprint = objectiveFingerprint({ kind: d.kind, source: { ref }, expected });
        const own = priorityOfDraft(d);
        const fills = d.kind === "constraint" && d.page ? filledBy.get(d.page) : undefined;
        const { score, reason } = fills && fills.score > own.score ? { score: fills.score, reason: clip(`${own.reason.replace(/\.$/, "")}; ranked with the workflow ${quote(fills.name, 100)}, which fills this form (priority ${fills.score}).`, 500) } : own;
        const objective = ObjectiveSchema.parse({
            id: `OBJ-${fingerprint.slice(0, 16)}`,
            kind: d.kind,
            source: d.evidence ? { ref, evidence: d.evidence } : { ref },
            question: clip(d.question, QUESTION_MAX),
            expected,
            ...(d.stated === false ? { stated: false } : {}),
            operators: KIND_OPERATORS[d.kind].filter((op) => !allowed || allowed.has(op)),
            budget,
            priority: score,
            reason,
            fingerprint,
        });
        if (d.inferred) inferred.add(fingerprint);
        const kept = byFingerprint.get(fingerprint);
        if (!kept || compare(objective, kept) < 0) byFingerprint.set(fingerprint, objective);
    }
    const sorted = [...byFingerprint.values()].sort(compare);
    const all = [...sorted.filter((o) => !inferred.has(o.fingerprint)), ...sorted.filter((o) => inferred.has(o.fingerprint))];
    return { objectives: all.slice(0, opts.maxObjectives), overCap: Math.max(0, all.length - opts.maxObjectives) };
}
