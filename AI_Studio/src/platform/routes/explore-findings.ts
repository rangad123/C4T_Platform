/**
 * Candidate findings (testing-engine Phase 3, candidate-finding-store.ts): what exploration found, as candidates for a person to
 * review. Reading needs access to the project (auth/roles.ts); nothing here changes a finding, and none is ever "confirmed" in Phase 3.
 *
 *   GET /api/projects/:id/candidate-findings?job=   → { findings: [CandidateFindingRecord] }, newest seen first; `job`: that run's
 *                                                     (found first or last). Another project's run answers 404.
 *   GET /api/projects/:id/objectives                  → { available: true, objectives: [{ id, kind, source, question, expected, operators,
 *                                                     priority, reason }], overCap } from the latest analysed model, worked out the way
 *                                                     the objective stage does (explore/objectives.ts) with the project's level, without
 *                                                     AI; { available: false, objectives: [], message } when there is no analysed model.
 *   GET /api/projects/:id/jobs/:jobId/coverage        → { available: true, stopReason, stopDetail, budgets, usage, coverage, actionLog,
 *                                                     actionLogOmitted } of a run that explored by objectives (exploration-store.ts);
 *                                                     only these fields, never the outcomes' or objectives' text. { available: false,
 *                                                     message } for a run without one. Another project's run answers 404.
 */
import { levelSettings } from "../../engine/levels.js";
import { objectivesFrom } from "../../engine/explore/objectives.js";
import { CandidateFindingStore } from "../candidate-finding-store.js";
import { loadExploration } from "../exploration-store.js";
import { HttpError } from "../http-error.js";
import { appKnowledgeOf } from "../job-runner.js";
import type { RouteCtx } from "./types.js";

const NO_MODEL = "This project has no analysed model of the application yet, so there are no objectives to show; explore the application first.";
const NO_COVERAGE = "This run has no coverage record: it did not explore by objectives, or it ran before coverage was recorded.";

export function registerExploreFindingRoutes(ctx: RouteCtx): void {
    const { app, p, repo } = ctx;
    const store = new CandidateFindingStore(p.sql);

    app.get("/api/projects/:id/candidate-findings", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const q = req.query as { job?: unknown };
        const job = typeof q.job === "string" && q.job !== "" ? q.job : undefined;
        if (job !== undefined && repo.getJob(job)?.projectId !== id) throw new HttpError(404, "Run not found");
        return { findings: await store.list(id, job ? { jobId: job } : {}) };
    });

    app.get("/api/projects/:id/objectives", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const { appKnowledge: k } = await appKnowledgeOf(repo, id);
        if (!k?.objectiveInputs) return { available: false, objectives: [], message: NO_MODEL };
        // The numbers the objective stage uses (orchestrator.ts objectivePursuits): the level of the project's latest application.
        const lv = levelSettings(repo.getLatestApplicationPublic(id)?.config as { level?: unknown } | undefined);
        const b = lv.exploration;
        const { objectives, overCap } = objectivesFrom(k.objectiveInputs, k.rules, k.workflows, { maxObjectives: b.objectives, budget: { steps: lv.authoringMaxSteps, minutes: b.perObjective.minutes, tokens: b.perObjective.tokens } });
        return {
            available: true,
            objectives: objectives.map((o) => ({ id: o.id, kind: o.kind, source: o.source.ref, question: o.question, expected: o.expected, operators: o.operators, priority: o.priority, reason: o.reason })),
            overCap,
        };
    });

    app.get("/api/projects/:id/jobs/:jobId/coverage", async (req) => {
        const { id, jobId } = req.params as { id: string; jobId: string };
        ctx.project(id);
        if (repo.getJob(jobId)?.projectId !== id) throw new HttpError(404, "Run not found");
        const e = await loadExploration(repo, p.store, jobId);
        if (!e) return { available: false, message: NO_COVERAGE };
        return { available: true, stopReason: e.stopReason, stopDetail: e.stopDetail, budgets: e.budgets, usage: e.usage, coverage: e.coverage, actionLog: e.actionLog, actionLogOmitted: e.actionLogOmitted };
    });
}
