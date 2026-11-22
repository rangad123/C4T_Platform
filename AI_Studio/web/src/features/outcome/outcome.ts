/**
 * The outcome report of a Test Case Generation project (founder 2026-11-19 P3, R8, R15): the types of `GET /api/projects/:id/outcome`
 * (PLAN.md "Outcome contract", src/platform/case-outcome-types.ts) and the pure helpers the report is drawn from. One page count is used
 * everywhere (`outcomeCounts`): the tree's real pages. Requirement areas are counted apart, and addresses that failed to load are one
 * number, `notOpened`.
 */
import { outcomeCounts, type CaseOutcome, type CaseOutcomeCounts, type CaseOutcomeCase, type CaseOutcomePage, type CaseOutcomePriority, type CaseOutcomeRun, type CaseOutcomeTreeNode, type CaseOutcomeType } from "../../../../src/platform/case-outcome-types.js";

export type { CaseOutcome, CaseOutcomeCounts, CaseOutcomeCase, CaseOutcomePage, CaseOutcomePriority, CaseOutcomeRun, CaseOutcomeTreeNode, CaseOutcomeType };

/** One node of the nested tree: a page, with the pages first reached from it. */
export interface TreeNode {
    path: string;
    title: string;
    /** The page path this node shows (a row of `pages`); empty for a requirement area. */
    page: string;
    /** 1 for a root, as aria-level counts. */
    level: number;
    children: TreeNode[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Nests the outcome's flat node list. A node goes under its `parent`; a node whose parent is not in the list, names itself, or sits on a
 * cycle is a root. The first row for a path wins, and the order of the list is kept among siblings.
 */
export function buildTree(nodes: CaseOutcomeTreeNode[]): TreeNode[] {
    const byPath = new Map<string, CaseOutcomeTreeNode>();
    for (const n of nodes) if (!byPath.has(n.node)) byPath.set(n.node, n);
    const parentOf = (path: string): string | null => {
        const p = byPath.get(path)?.parent ?? null;
        return p === null || p === path || !byPath.has(p) ? null : p;
    };
    const made = new Map<string, TreeNode>();
    for (const n of byPath.values()) made.set(n.node, { path: n.node, title: n.title || n.node, page: n.page, level: 1, children: [] });
    const roots: TreeNode[] = [];
    for (const n of byPath.values()) {
        const p = parentOf(n.node);
        const me = made.get(n.node)!;
        // A node on a cycle (a → b → a) would end up under itself: it is a root instead, so every node is listed exactly once.
        if (p !== null && !reaches(made, parentOf, p, n.node)) made.get(p)!.children.push(me);
        else roots.push(me);
    }
    const setLevel = (list: TreeNode[], level: number) => list.forEach((t) => ((t.level = level), setLevel(t.children, level + 1)));
    setLevel(roots, 1);
    return roots;
}

/** Whether walking up from `from` reaches `target` (then `target` under `from` would close a loop). */
function reaches(made: Map<string, TreeNode>, parentOf: (p: string) => string | null, from: string, target: string): boolean {
    const seen = new Set<string>();
    for (let q: string | null = from; q !== null && made.has(q); q = parentOf(q)) {
        if (q === target) return true;
        if (seen.has(q)) return false;
        seen.add(q);
    }
    return false;
}

/** The tree node a case hangs on: its requirement area (a run from the requirements alone, SPEC R16), else its start page. */
const nodeOfCase = (c: CaseOutcomeCase): string => c.area || c.page;

/** The cases that hang on a node; every case for `null` (nothing selected). */
export const casesForNode = (cases: CaseOutcomeCase[], node: string | null): CaseOutcomeCase[] => (node === null ? cases : cases.filter((c) => nodeOfCase(c) === node));

/** How many cases start on each node, counted from the cases (so a node's number is always the rows it lists). */
export function nodeCaseCounts(tree: CaseOutcomeTreeNode[], cases: CaseOutcomeCase[]): Map<string, number> {
    const counts = new Map<string, number>(tree.map((n) => [n.node, 0]));
    for (const c of cases) if (counts.has(nodeOfCase(c))) counts.set(nodeOfCase(c), counts.get(nodeOfCase(c))! + 1);
    return counts;
}

/** Cases whose page is not a node of the tree (for example written from a requirement alone). */
export function unplacedCases(tree: CaseOutcomeTreeNode[], cases: CaseOutcomeCase[]): CaseOutcomeCase[] {
    const paths = new Set(tree.map((n) => n.node));
    return cases.filter((c) => !paths.has(nodeOfCase(c)));
}

/** Whether the numbers the server put on the nodes add up, with the unplaced cases, to the number of cases. */
export function countsAgree(tree: CaseOutcomeTreeNode[], cases: CaseOutcomeCase[]): boolean {
    const counts = nodeCaseCounts(tree, cases);
    return tree.every((n) => n.cases === counts.get(n.node)) && [...counts.values()].reduce((a, b) => a + b, 0) + unplacedCases(tree, cases).length === cases.length;
}

/** The nodes a person can see, in screen order: a closed node hides everything under it. */
export function visibleNodes(roots: TreeNode[], expanded: ReadonlySet<string>): TreeNode[] {
    const out: TreeNode[] = [];
    const walk = (list: TreeNode[]) => {
        for (const n of list) {
            out.push(n);
            if (n.children.length && expanded.has(n.path)) walk(n.children);
        }
    };
    walk(roots);
    return out;
}

/** The node above `path` in the nested tree, or null for a root. */
export function parentNode(roots: TreeNode[], path: string): TreeNode | null {
    const find = (list: TreeNode[], parent: TreeNode | null): TreeNode | null | undefined => {
        for (const n of list) {
            if (n.path === path) return parent;
            const hit = find(n.children, n);
            if (hit !== undefined) return hit;
        }
        return undefined;
    };
    return find(roots, null) ?? null;
}

/** "N pages" and/or "A requirement areas", by the one count rule (a requirements-only outcome names no pages). */
const placesOf = (c: CaseOutcomeCounts["counts"]): string[] => [...(c.pages || !c.areas ? [plural(c.pages, "page")] : []), ...(c.areas ? [plural(c.areas, "requirement area")] : [])];

/** "N pages, M test cases, from K runs", or "M test cases in A requirement areas, from K runs" (commas, not middle dots: the copy rule in styles.css). */
export function summaryLine(o: Pick<CaseOutcome, "tree" | "cases" | "runs">): string {
    const c = outcomeCounts(o);
    const runs = `from ${plural(o.runs.length, "run")}`;
    return !c.pages && c.areas ? `${plural(c.cases, "test case")} in ${placesOf(c)[0]}, ${runs}` : `${[...placesOf(c), plural(c.cases, "test case")].join(", ")}, ${runs}`;
}

/** The Projects row: "M test cases, N pages" (and/or the requirement areas). */
export const countsLine = (c: CaseOutcomeCounts["counts"]): string => [plural(c.cases, "test case"), ...placesOf(c)].join(", ");

/** The one note about addresses that failed to load; null when every address opened. */
export const notOpenedLine = (n: number): string | null => (n > 0 ? `${plural(n, "address", "addresses")} could not be opened` : null);

/** What the newest run's state means for the report; null when it finished (nothing to say). */
export function lastRunNote(runs: CaseOutcomeRun[]): string | null {
    const last = runs[0];
    if (!last) return null;
    const kept = `${plural(last.addedPages, "page")} and ${plural(last.addedCases, "test case")}`;
    if (last.status === "running") return "A run is still running. New pages and test cases appear here as it finds them.";
    if (last.status === "stopped") return `The last run was stopped. It kept the ${kept} it found before then.`;
    if (last.status === "failed") return `The last run did not finish. It kept the ${kept} it found before then.`;
    return null;
}

export const TYPE_LABEL: Record<CaseOutcomeType, string> = { automated: "Automated", manual: "Manual" };
export const PRIORITY_LABEL: Record<CaseOutcomePriority, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
export { outcomeCounts, plural };
