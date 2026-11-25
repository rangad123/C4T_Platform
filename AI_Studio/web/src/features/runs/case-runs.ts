/**
 * Whether a project is a Test Case Generation project (`caseAgent` of GET /api/projects/:id/testing-agents, FX14: the cheap answer),
 * and the project's outcome. The Runs screens of such a project show what each run added to the one tree (CaseRuns.tsx, CaseRunDetail.tsx);
 * every other project keeps its screens, also when the outcome cannot be read.
 */
import { useFetch, type Fetched } from "../../lib/hooks";
import type { CaseOutcome } from "../outcome/outcome";
import type { ProjectAgents } from "../testing-agents/testing-agents";

/** The project's outcome, or one run's part of it (`run`); polled every 3 s while `poll` says so. */
export function useCaseOutcome(projectId: string, run?: string | null, poll?: (o: CaseOutcome | undefined) => boolean): Fetched<CaseOutcome> {
    return useFetch<CaseOutcome>(`/projects/${projectId}/outcome${run ? `?run=${encodeURIComponent(run)}` : ""}`, poll ? (o) => (poll(o) ? 3000 : null) : undefined);
}

/** True for a Test Case Generation project, false for any other (or when the answer could not be read, or `projectId` is null), undefined until it is known. */
export function useCaseAgent(projectId: string | null): boolean | undefined {
    const a = useFetch<Pick<ProjectAgents, "caseAgent">>(projectId ? `/projects/${projectId}/testing-agents` : null);
    if (a.data) return a.data.caseAgent === true;
    return a.loading ? undefined : false;
}

/** The workbook of one run's test cases (GET /api/projects/:id/outcome/workbook?run=), for downloadFrom (sheet #29). */
export function runWorkbookPath(projectId: string, jobId: string): string {
    return `/projects/${projectId}/outcome/workbook?run=${encodeURIComponent(jobId)}`;
}

/** Runs are numbered from the first: the outcome lists them newest first, so run n is at index length − n. */
export function runNumbers(o: Pick<CaseOutcome, "runs"> | undefined): Map<string, number> {
    const runs = o?.runs ?? [];
    return new Map(runs.map((r, i) => [r.jobId, runs.length - i]));
}
