/**
 * Row 205: the bench-shop model and rules from the C1e candidate trial (bench-shop-c1e-model.json), as the job runner hands them to the
 * engine (platform/job-runner.ts appKnowledgeOf): usable rules, usable workflows without their pages, and the objective inputs.
 */
import { readFileSync } from "node:fs";
import { objectiveInputsOf, usableRules, usableWorkflows, type AppKnowledge, type KnowledgeRule } from "../../src/engine/planning/planner.js";

interface Fixture {
    model: { pages: unknown[]; transitions: unknown[]; workflows: Array<{ id: string; name: string; steps: Array<{ order: number; action: string; page?: string; endpoint?: string }>; preconditions: string[]; postconditions: string[]; sourceType: string }> };
    rules: Array<Omit<KnowledgeRule, "workflows">>;
}

export const c1e = JSON.parse(readFileSync(new URL("./bench-shop-c1e-model.json", import.meta.url), "utf8")) as Fixture;

/** The rules as the premise check reads them (evidence present, no workflow links). */
export const c1eRules = (): KnowledgeRule[] => c1e.rules.map((r) => ({ ...r, workflows: [] }));

/** `renameId` gives the model's pages (and the workflow steps naming them) other ids, as another analysis might. */
export function c1eKnowledge(renameId: (id: string) => string = (id) => id): AppKnowledge {
    const model = {
        ...c1e.model,
        pages: (c1e.model.pages as Array<{ id: string }>).map((p) => ({ ...p, id: renameId(p.id) })),
        workflows: c1e.model.workflows.map((w) => ({ ...w, steps: w.steps.map((s) => (s.page ? { ...s, page: renameId(s.page) } : s)) })),
    };
    const usable = usableWorkflows(model.workflows as never) as Fixture["model"]["workflows"];
    return {
        modelVersionId: "mv-c1e",
        rules: usableRules(c1eRules()),
        workflows: usable.map((w) => ({ id: w.id, name: w.name, steps: w.steps.map((x) => ({ order: x.order, action: x.action })), preconditions: w.preconditions, postconditions: w.postconditions, sourceType: w.sourceType as never })),
        objectiveInputs: objectiveInputsOf(model as never, usable),
    };
}
