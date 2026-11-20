/**
 * Whether a project is a Test Case Generation project, read from its outcome (PLAN.md AD1: `caseAgent` of GET /api/projects/:id/outcome),
 * and the outcome itself. The Runs screens of such a project show what each run added to the one tree (CaseRuns.tsx, CaseRunDetail.tsx);
 * every other project keeps its screens, also when the outcome cannot be read.
 */
import { useFetch, type Fetched } from "../../lib/hooks";
import type { CaseOutcome } from "../outcome/outcome";

/** The project's outcome, or one run's part of it (`run`); polled every 3 s while `poll` says so. */
export function useCaseOutcome(projectId: string, run?: string | null, poll?: (o: CaseOutcome | undefined) => boolean): Fetched<CaseOutcome> {
    return useFetch<CaseOutcome>(`/projects/${projectId}/outcome${run ? `?run=${encodeURIComponent(run)}` : ""}`, poll ? (o) => (poll(o) ? 3000 : null) : undefined);
}

/** True for a Test Case Generation project, false for any other (or when the answer could not be read), undefined until it is known. */
export function useCaseAgent(projectId: string): boolean | undefined {
    const o = useCaseOutcome(projectId);
    if (o.data) return o.data.caseAgent === true;
    return o.loading ? undefined : false;
}

/** Runs are numbered from the first: the outcome lists them newest first, so run n is at index length − n. */
export function runNumbers(o: Pick<CaseOutcome, "runs"> | undefined): Map<string, number> {
    const runs = o?.runs ?? [];
    return new Map(runs.map((r, i) => [r.jobId, runs.length - i]));
}
