/**
 * What one run of a Test Case Generation project found (founder 2026-11-19, R10.3, Q4; PLAN.md U5): the run page shows that run's part
 * of the project's one tree and the test cases it wrote, with the numbers the whole outcome uses (TC ids, page titles), not a second list.
 *
 *   GET /api/projects/:id/outcome?run=<jobId>   → a CaseOutcome holding only that run: `runs` is [the run], `pages` and `tree` are the
 *                                                  pages it reached, `cases` the test cases it wrote (new or already known).
 *
 * A page's parent is its parent in the whole tree when the run reached that one too, else the nearest such page above it, else none (a
 * root of the run's part). A stopped run's part is what it found before it stopped.
 */
import type { CaseOutcome } from "./case-outcome-types.js";
import { isCaseAgentProject } from "./case-agent.js";
import { mergedOf, type MergedRuns } from "./case-outcome.js";

export function runOutcomeOf(merged: Omit<MergedRuns, "written">, jobId: string): Omit<CaseOutcome, "caseAgent" | "missing"> | undefined {
    const run = merged.runs.find((r) => r.jobId === jobId);
    const part = merged.byRun.get(jobId);
    if (!run || !part) return undefined;
    const mine = new Set(part.pages);
    const ids = new Set(part.cases);
    const parentOf = new Map(merged.tree.map((t) => [t.node, t.parent]));
    /** The nearest page above `node` in the whole tree that this run reached too. */
    const parentInRun = (node: string): string | null => {
        const seen = new Set<string>([node]);
        for (let at = parentOf.get(node) ?? null; at !== null && !seen.has(at); at = parentOf.get(at) ?? null) {
            if (mine.has(at)) return at;
            seen.add(at);
        }
        return null;
    };
    const cases = merged.cases.filter((c) => ids.has(c.id));
    const count = new Map<string, number>();
    for (const c of cases) count.set(c.page, (count.get(c.page) ?? 0) + 1);
    const tree = merged.tree.filter((t) => mine.has(t.node)).map((t) => ({ ...t, parent: parentInRun(t.node), cases: count.get(t.node) ?? 0 }));
    return {
        runs: [run],
        pages: merged.pages.filter((pg) => mine.has(pg.path)),
        tree,
        cases,
        notOpened: part.failed.filter((f) => !parentOf.has(f)).length,
    };
}

/** The outcome of one run of a project (the route's `?run=`): caseAgent false and empty lists for another kind of project; undefined for a run that is not one of its runs. */
export async function caseRunOutcomeOf(p: Parameters<typeof mergedOf>[0], projectId: string, jobId: string): Promise<CaseOutcome | undefined> {
    if (!(await isCaseAgentProject(p.repo, projectId))) return { caseAgent: false, runs: [], pages: [], tree: [], cases: [], notOpened: 0, missing: [] };
    const part = runOutcomeOf(await mergedOf(p, projectId), jobId);
    return part && { caseAgent: true, ...part, missing: [] };
}
