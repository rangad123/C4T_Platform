/**
 * Candidate findings (testing-engine Phase 3, candidate-finding-store.ts): what exploration found, as candidates for a person to
 * review. Reading needs access to the project (auth/roles.ts); nothing here changes a finding, and none is ever "confirmed" in Phase 3.
 *
 *   GET /api/projects/:id/candidate-findings?job=   → { findings: [CandidateFindingRecord & { review }] }, newest seen first; `job`:
 *                                                     that run's (found first or last). Another project's run answers 404. `review`
 *                                                     is what the results card shows (Phase 5 U1): the status label (findings/score.ts
 *                                                     `label`: never "Confirmed" below high confidence), severity and confidence each
 *                                                     with its basis, reproduction "same of of", the saved test's steps and the
 *                                                     likely cause with its label (root-cause.ts; Unknown while no code source is
 *                                                     connected), the state's name and rank, and whether a person may Confirm or
 *                                                     call it Not a bug (lifecycle.ts). Computed here, so the page has no rule of
 *                                                     its own.
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
import { isReproduced, reproduction } from "../../engine/findings/classify.js";
import { FINDING_STATES, moversOf, STATE_LABEL } from "../../engine/findings/lifecycle.js";
import { ROOT_CAUSE_LABEL_TEXT, rootCause } from "../../engine/findings/root-cause.js";
import { confidenceScore, label, severityOf } from "../../engine/findings/score.js";
import { SEVERITIES, type Severity } from "../../engine/validation/severity.js";
import { CandidateFindingStore, type CandidateFindingRecord } from "../candidate-finding-store.js";
import { fromCandidate } from "../findings/adapters.js";
import { loadExploration } from "../exploration-store.js";
import { HttpError } from "../http-error.js";
import { appKnowledgeOf } from "../job-runner.js";
import type { RouteCtx } from "./types.js";

const NO_MODEL = "This project has no analysed model of the application yet, so there are no objectives to show; explore the application first.";
const NO_COVERAGE = "This run has no coverage record: it did not explore by objectives, or it ran before coverage was recorded.";

export function registerExploreFindingRoutes(ctx: RouteCtx): void {
    const { app, p, repo } = ctx;
    const store = new CandidateFindingStore(p.sql);

    const reviewOf = async (r: CandidateFindingRecord) => {
        const t = r.testId ? repo.getTest(r.testId) : undefined;
        const view = fromCandidate(r, t && t.projectId === r.projectId && !t.unreadable ? { id: t.id, title: t.title, spec: t.spec, meta: t.generationMeta } : undefined);
        const scored = severityOf(view);
        const stored = SEVERITIES.includes(r.severity as Severity) ? (r.severity as Severity) : undefined;
        const severity = stored ?? scored.severity;
        const conf = r.confidenceDetail ?? confidenceScore(view);
        const rep = reproduction(view.attempts);
        // No code source is connected to projects yet (Phase 6): Unknown with its reason, and no AI call.
        const rc = await rootCause({ members: [view] });
        const at = rc.location ? `${rc.location.file}:${rc.location.line}${rc.location.function ? ` in ${rc.location.function}()` : ""}. ` : "";
        return {
            label: label({ state: r.state, severity, confidence: conf.confidence, security: false, reproduced: isReproduced(rep) }),
            severity,
            // A stored severity keeps the basis only when the rules still agree with it.
            severityBasis: stored && stored !== scored.severity ? null : scored.basis,
            confidence: conf.confidence,
            confidenceBasis: conf.basis,
            reproduction: rep,
            steps: view.steps,
            cause: { label: ROOT_CAUSE_LABEL_TEXT[rc.label], text: `${at}${rc.location?.explanation ?? rc.reason}` },
            // The state's name and its place in the lifecycle (the folded groups' order), and the verdicts a person may give from it.
            stateLabel: STATE_LABEL[r.state],
            stateRank: FINDING_STATES.indexOf(r.state),
            personMay: { confirm: moversOf(r.state, "confirmed").includes("person"), notABug: moversOf(r.state, "not_a_bug").includes("person") },
        };
    };

    app.get("/api/projects/:id/candidate-findings", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const q = req.query as { job?: unknown };
        const job = typeof q.job === "string" && q.job !== "" ? q.job : undefined;
        if (job !== undefined && repo.getJob(job)?.projectId !== id) throw new HttpError(404, "Run not found");
        return { findings: await Promise.all((await store.list(id, job ? { jobId: job } : {})).map(async (r) => ({ ...r, review: await reviewOf(r) }))) };
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
