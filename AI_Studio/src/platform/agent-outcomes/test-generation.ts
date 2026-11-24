import { jobBelongsTo } from "../agent-workspace.js";
import { AppIntelStore } from "../app-intel-store.js";
import { caseOutcomeOf, type AppModelReader } from "../case-outcome.js";
import { outcomeCounts, type CaseOutcome } from "../case-outcome-types.js";
import { caseRunOutcomeOf } from "../case-run-outcome.js";
import type { AgentOutcomeCtx, AgentOutcomeModule } from "./types.js";

const counted = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The newest application model that is not another agent's: each exploration ends by updating the model from what it saw
 * (job-runner.ts analyseAfterExploration), so a version made while another agent's run went says what that run saw (W3 review M1).
 * A version made outside any run (a person's own analysis) counts.
 */
const caseAppModel =
    (ctx: AgentOutcomeCtx): AppModelReader =>
    async (projectId) => {
        const others = ctx.p.repo.listJobs(projectId).filter((j) => !jobBelongsTo(j, "test-generation"));
        const during = (at: string) => others.some((j) => (j.startedAt ?? j.createdAt) <= at && (!j.finishedAt || at <= j.finishedAt));
        const store = new AppIntelStore(ctx.p.sql);
        const v = (await store.versions(projectId)).find((x) => !during(x.createdAt));
        return v ? (await store.version(projectId, v.version))?.model : undefined;
    };

/** Test Case Generation: the tree and its test cases (case-outcome.ts), from its own runs only. */
export const outcome: AgentOutcomeModule<CaseOutcome> = {
    outcome: (ctx) => caseOutcomeOf(ctx.p, ctx.projectId, caseAppModel(ctx)),
    runOutcome: (ctx, jobId) => caseRunOutcomeOf(ctx.p, ctx.projectId, jobId),
    headline: (o) => {
        if (!o.runs.length) return null;
        const c = outcomeCounts(o);
        return `${counted(c.pages, "page")}, ${counted(c.cases, "test case")}`;
    },
};
