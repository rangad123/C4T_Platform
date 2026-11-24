import { caseOutcomeOf } from "../case-outcome.js";
import { outcomeCounts, type CaseOutcome } from "../case-outcome-types.js";
import { caseRunOutcomeOf } from "../case-run-outcome.js";
import type { AgentOutcomeModule } from "./types.js";

const counted = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Test Case Generation: the tree and its test cases (case-outcome.ts), unchanged. */
export const outcome: AgentOutcomeModule<CaseOutcome> = {
    outcome: (ctx) => caseOutcomeOf(ctx.p, ctx.projectId, ctx.appModel),
    runOutcome: (ctx, jobId) => caseRunOutcomeOf(ctx.p, ctx.projectId, jobId),
    headline: (o) => {
        if (!o.runs.length) return null;
        const c = outcomeCounts(o);
        return `${counted(c.pages, "page")}, ${counted(c.cases, "test case")}`;
    },
};
