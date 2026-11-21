import { caseOutcomeOf, type AppModelReader } from "../case-outcome.js";
import { caseRunOutcomeOf } from "../case-run-outcome.js";
import { buildCaseWorkbook } from "../case-workbook.js";
import { HttpError } from "../http-error.js";
import { XLSX_CONTENT_TYPE } from "../../shared/xlsx.js";
import type { RouteCtx } from "./types.js";

/**
 * The outcome of a Test Case Generation project (founder 2026-11-19, PLAN.md "Outcome contract"; built in case-outcome.ts):
 *
 *   GET /api/projects/:id/outcome            → CaseOutcome (case-outcome-types.ts); caseAgent false and empty lists for other projects
 *   GET /api/projects/:id/outcome?run=<job>  → the same shape for one run: what that run found (case-run-outcome.ts), 404 for a run that is not one of the project's
 *   GET /api/projects/:id/outcome?counts=1   → CaseOutcomeCounts: the runs and two counts, for the Projects row
 *   GET /api/projects/:id/outcome/workbook   → the three-sheet workbook (case-workbook.ts), as `<project name> test cases.xlsx`
 *
 * Who may read the project gets its outcome; the workbook is a download and needs ai_studio.reports.export (auth/roles.ts). A project
 * out of reach (another organisation's, or one the person was not added to) is a 404 before either answers (auth/project-scope.ts).
 */
export const NOT_A_CASE_AGENT_PROJECT = "This project does not use the Test Case Generation agent, so it has no test cases to download here.";
export const NO_SUCH_RUN = "This run is not one of this project's runs, or what it found was forgotten.";
export const NO_CASE_RUNS = "There are no test cases to download yet. Explore the application first.";

/** `name test cases.xlsx` as a header value: a plain ASCII fallback plus the exact name (RFC 6266). */
export function workbookDisposition(projectName: string): string {
    const name = `${projectName.replace(/[\r\n"\\/]+/g, " ").trim() || "Project"} test cases.xlsx`;
    const ascii = name.replace(/[^\x20-\x7e]+/g, "_");
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function registerCaseOutcomeRoutes(ctx: RouteCtx, appModel: AppModelReader): void {
    const { app, p } = ctx;

    app.get("/api/projects/:id/outcome", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const run = (req.query as { run?: unknown }).run;
        if (typeof run === "string" && run) {
            const one = await caseRunOutcomeOf(p, id, run);
            if (!one) throw new HttpError(404, NO_SUCH_RUN);
            return one;
        }
        if ((req.query as { counts?: unknown }).counts === "1") {
            const { caseAgent, runs, cases, tree } = await caseOutcomeOf(p, id, async () => undefined);
            return { caseAgent, runs, counts: { cases: cases.length, pages: tree.length } };
        }
        return caseOutcomeOf(p, id, appModel);
    });

    app.get("/api/projects/:id/outcome/workbook", async (req, reply) => {
        const { id } = req.params as { id: string };
        const project = ctx.project(id);
        const outcome = await caseOutcomeOf(p, id, appModel);
        if (!outcome.caseAgent) throw new HttpError(404, NOT_A_CASE_AGENT_PROJECT);
        if (!outcome.runs.length) throw new HttpError(404, NO_CASE_RUNS);
        return reply
            .header("content-type", XLSX_CONTENT_TYPE)
            .header("content-disposition", workbookDisposition(String(project.name ?? "")))
            .header("cache-control", "no-store")
            .send(Buffer.from(buildCaseWorkbook(outcome)));
    });
}
