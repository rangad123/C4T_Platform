/**
 * The priority of an exploration objective (testing-engine Phase 3): a fixed score, not a learned one, and the sentence that explains it,
 * which is stored and shown beside the objective. What raises it: how firmly the source states the expectation (a person confirmed it, a
 * document states it), words that mark something critical (money, orders, accounts, payments, deleting), a longer workflow, a state not
 * explored yet, and the kind of objective (a check of a stated rule or transition before a coverage gap nobody can check).
 *
 * The priority only orders objectives; it never changes their budgets or operators (objectives.ts takes those from the options).
 */
import type { ObjectiveKind } from "./objectives.js";

export interface PriorityInput {
    kind: ObjectiveKind;
    /** The source's own text the objective comes from: a rule's description and expected result, a workflow's name and steps, a field. */
    sourceText: string;
    /** confirmed: a person confirmed it; explicit: a source states it; none: nothing states it (a coverage gap). */
    stated: "confirmed" | "explicit" | "none";
    /** For a workflow objective: how many steps the workflow has. */
    workflowSteps?: number;
    /** The objective's state or page has not been explored yet. */
    unexplored?: boolean;
}

export interface Priority {
    score: number;
    reason: string;
}

const STATED_POINTS = { confirmed: 4, explicit: 3, none: 0 } as const;
const STATED_WORDS = { confirmed: "confirmed by a person", explicit: "stated by a source", none: "stated by no source" } as const;

const KIND_POINTS: Record<ObjectiveKind, number> = { rule: 3, transition: 3, workflow: 2, constraint: 2, "coverage-gap": 0 };
const KIND_WORDS: Record<ObjectiveKind, string> = {
    rule: "a rule check",
    transition: "a state change check",
    workflow: "a workflow check",
    constraint: "a form field check",
    "coverage-gap": "a coverage gap",
};

/** Criticality words, each with the forms it is found in; whole words only ("border" is not "order"). */
const CRITICAL: ReadonlyArray<readonly [string, RegExp]> = [
    ["money", /\bmoney\b/i],
    ["order", /\b(?:orders?|ordered|ordering)\b/i],
    ["account", /\baccounts?\b/i],
    ["payment", /\b(?:payments?|pay|pays|paid|paying)\b/i],
    ["delete", /\b(?:delete|deletes|deleted|deleting|deletion)\b/i],
];
const POINTS_PER_WORD = 2;
const MAX_CRITICAL_WORDS = 3;
const MAX_WORKFLOW_POINTS = 5;
const UNEXPLORED_POINTS = 2;

const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** The objective's score (a whole number, higher first) and one sentence saying what made it. */
export function priorityOf(input: PriorityInput): Priority {
    const parts: string[] = [STATED_WORDS[input.stated]];
    let score = STATED_POINTS[input.stated] + KIND_POINTS[input.kind];

    const words = CRITICAL.filter(([, re]) => re.test(input.sourceText)).map(([w]) => w);
    if (words.length) {
        score += POINTS_PER_WORD * Math.min(words.length, MAX_CRITICAL_WORDS);
        parts.push(`mentions ${list(words)}`);
    }
    const steps = Math.max(0, Math.floor(input.workflowSteps ?? 0));
    if (input.kind === "workflow" && steps > 0) {
        score += Math.min(MAX_WORKFLOW_POINTS, Math.floor(steps / 2));
        parts.push(`a workflow of ${steps} ${steps === 1 ? "step" : "steps"}`);
    }
    if (input.unexplored) {
        score += UNEXPLORED_POINTS;
        parts.push("not explored yet");
    }
    parts.push(KIND_WORDS[input.kind]);
    return { score, reason: `Priority ${score}: ${parts.join(", ")}.` };
}
