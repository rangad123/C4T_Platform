/**
 * E5 of the testing-engine Phase 3 benchmark: objective coverage of one stored model version. Deterministic, no AI.
 *
 * - Rules: the stored rules a person may rely on (explicit or confirmed by a person, not rejected, evidence not gone) whose expected
 *   result says something checkable (a letter or digit, not a placeholder such as "TBD", "n/a" or "-"), that at least one rule objective
 *   cites by ref / those rules. Defined here from the spec, not by calling the engine's own filter, so a rule the engine wrongly leaves
 *   out is counted as missed rather than dropped from the denominator.
 * - Workflows: catalogue workflows identified, as U3 identifies them (score.ts `workflowRecall`, with the trial's recorded workflow
 *   links), by the model workflows that have a workflow objective / catalogue workflows.
 *
 * The objectives are built once, from the stored model, its rules and its workflows, exactly as an exploration would get them; the
 * answer key is used only afterwards, to name which catalogue workflow a model workflow is. The cap is the largest any level allows
 * (`MAX_OBJECTIVES`), so E5 measures what the model yields, not a session's budget; `overCap` says if even that cut any.
 */
import { AGENT_LIMITS } from "../../../engine/agent/objective.js";
import { MAX_OBJECTIVES, OBJECTIVE_KINDS, objectivesFrom, type ObjectiveKind } from "../../../engine/explore/objectives.js";
import type { AppModel } from "../../../engine/intel/model.js";
import type { KnowledgeRule, KnowledgeWorkflow } from "../../../engine/planning/planner.js";
import type { AnswerKey, Judgements } from "./answer-key.js";
import { workflowRecall, type Ratio, type ScoredRule } from "./score.js";

export interface ObjectiveCoverage {
    /** Counted rules (refs) with at least one rule objective citing them. */
    rules: Ratio;
    /** Catalogue workflows covered by a workflow objective. */
    workflows: Ratio;
    /** Every counted rule and every catalogue workflow has its objective (E5's 100% target). */
    met: boolean;
    objectives: { total: number; overCap: number; byKind: Record<ObjectiveKind, number> };
    /** Model workflows with an objective that fit several key workflows and have no recorded link (as in U3). */
    needsJudgement: string[];
}

const norm = (t: string) => t.replace(/\s+/g, " ").trim();
const checkable = (expected: string) => /[\p{L}\p{N}]/u.test(expected) && !/^(?:n\/?a|tbd|unknown|none|-+)$/i.test(norm(expected));
const ratio = (found: number, total: number, missed: string[]): Ratio => ({ found, total, value: total === 0 ? null : found / total, missed: [...missed].sort() });

export function objectiveCoverage(
    input: { model: AppModel; rules: readonly ScoredRule[]; key: AnswerKey; catalogueWorkflows: readonly string[]; judgements?: Judgements },
    build: typeof objectivesFrom = objectivesFrom,
): ObjectiveCoverage {
    const { model } = input;
    // What the engine is given: the stored model, its rules and its workflows. Nothing of the answer key.
    const rules: KnowledgeRule[] = input.rules.map((r) => ({
        ref: r.ref,
        kind: r.kind,
        description: r.description,
        expected: r.expected,
        explicitness: r.explicitness,
        workflows: r.workflows,
        status: r.status,
        ...(r.evidenceGone ? { evidenceGone: r.evidenceGone as NonNullable<KnowledgeRule["evidenceGone"]> } : {}),
    }));
    const workflows: KnowledgeWorkflow[] = model.workflows.map((w) => ({ id: w.id, name: w.name, steps: w.steps.map((s) => ({ order: s.order, action: s.action })), preconditions: w.preconditions, postconditions: w.postconditions, sourceType: w.sourceType }));
    const built = build(model, rules, workflows, { maxObjectives: MAX_OBJECTIVES, budget: { steps: AGENT_LIMITS.steps.default, minutes: AGENT_LIMITS.minutes.default, tokens: AGENT_LIMITS.tokens.default } });

    const cited = (kind: ObjectiveKind) => new Set(built.objectives.filter((o) => o.kind === kind).map((o) => norm(o.source.ref)));
    const ruleRefs = cited("rule");
    const counted = input.rules.filter((r) => !r.evidenceGone && r.status !== "rejected" && (r.explicitness === "explicit" || r.status === "confirmed") && checkable(r.expected)).map((r) => r.ref);
    const uniqueCounted = [...new Set(counted)];
    const rulesMissed = uniqueCounted.filter((ref) => !ruleRefs.has(norm(ref)));

    // The catalogue workflows U3 finds when only the model workflows with a workflow objective are there.
    const withObjective = cited("workflow");
    const covered = workflowRecall({ ...model, workflows: model.workflows.filter((w) => withObjective.has(norm(w.id))) }, input.key, [...input.catalogueWorkflows], input.judgements);

    const byKind = Object.fromEntries(OBJECTIVE_KINDS.map((k) => [k, built.objectives.filter((o) => o.kind === k).length])) as Record<ObjectiveKind, number>;
    const rulesRatio = ratio(uniqueCounted.length - rulesMissed.length, uniqueCounted.length, rulesMissed);
    const workflowsRatio: Ratio = { found: covered.found, total: covered.total, value: covered.value, missed: covered.missed };
    return {
        rules: rulesRatio,
        workflows: workflowsRatio,
        met: rulesRatio.found === rulesRatio.total && workflowsRatio.found === workflowsRatio.total,
        objectives: { total: built.objectives.length, overCap: built.overCap, byKind },
        needsJudgement: covered.needsJudgement,
    };
}
