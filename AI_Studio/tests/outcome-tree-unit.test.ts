/**
 * The outcome report's pure helpers (web/src/features/outcome/outcome.ts, founder 2026-11-19 P3, R8, R15): the nested tree from the
 * outcome's flat node list, the cases of a node, the counts that must agree, the keyboard order of the visible nodes and the words.
 * Expected values come from the contract (PLAN.md "Outcome contract") and SPEC P3: a node's parent is its `parent` path; a node whose
 * parent is not in the list is a root; one page count everywhere (the number of tree nodes); failed addresses are not pages.
 */
import { describe, expect, it } from "vitest";
import type { CaseOutcome, CaseOutcomeCase, CaseOutcomeTreeNode } from "../src/platform/case-outcome-types.js";
import { buildTree, casesForNode, countsAgree, lastRunNote, nodeCaseCounts, notOpenedLine, summaryLine, unplacedCases, visibleNodes } from "../web/src/features/outcome/outcome.js";

const node = (path: string, parent: string | null, cases = 0, title = path): CaseOutcomeTreeNode => ({ node: path, parent, page: path, title, cases });
const tc = (id: string, page: string, type: CaseOutcomeCase["type"] = "automated"): CaseOutcomeCase => ({ id, title: `Case ${id}`, type, priority: "medium", page, preconditions: [], steps: [], expected: [], requirement: "" });
const outcome = (o: Partial<CaseOutcome>): CaseOutcome => ({ caseAgent: true, runs: [], pages: [], tree: [], cases: [], notOpened: 0, missing: [], ...o });

describe("buildTree", () => {
    it("nests each node under its parent and keeps the order the outcome gives", () => {
        const roots = buildTree([node("/", null), node("/products", "/"), node("/about", "/"), node("/products/1", "/products")]);
        expect(roots.map((r) => r.path)).toEqual(["/"]);
        expect(roots[0].children.map((c) => c.path)).toEqual(["/products", "/about"]);
        expect(roots[0].children[0].children.map((c) => c.path)).toEqual(["/products/1"]);
        expect(roots[0].children[0].children[0].level).toBe(3);
    });

    it("makes a node whose parent is missing a root, and a parent listed after its child still adopts it", () => {
        const roots = buildTree([node("/a/b", "/a"), node("/x", "/gone"), node("/a", null)]);
        expect(roots.map((r) => r.path).sort()).toEqual(["/a", "/x"]);
        expect(roots.find((r) => r.path === "/a")!.children.map((c) => c.path)).toEqual(["/a/b"]);
    });

    it("never loops on a cycle or a node that names itself, and lists every node exactly once", () => {
        const roots = buildTree([node("/a", "/b"), node("/b", "/a"), node("/c", "/c"), node("/c", null)]);
        const all: string[] = [];
        const walk = (ns: ReturnType<typeof buildTree>) => ns.forEach((n) => (all.push(n.path), walk(n.children)));
        walk(roots);
        expect(all.sort()).toEqual(["/a", "/b", "/c"]);
    });
});

describe("cases and counts", () => {
    const tree = [node("/", null, 1), node("/products", "/", 2), node("/cart", "/", 0)];
    const cases = [tc("TC-001", "/"), tc("TC-002", "/products"), tc("TC-003", "/products", "manual"), tc("TC-004", "")];

    it("lists the cases that start on a node, and every case for no node", () => {
        expect(casesForNode(cases, "/products").map((c) => c.id)).toEqual(["TC-002", "TC-003"]);
        expect(casesForNode(cases, "/cart")).toEqual([]);
        expect(casesForNode(cases, null)).toHaveLength(4);
    });

    it("counts each node's cases from the cases themselves, so a node's number equals the rows it lists", () => {
        const counts = nodeCaseCounts(tree, cases);
        expect(counts.get("/")).toBe(1);
        expect(counts.get("/products")).toBe(2);
        expect(counts.get("/cart")).toBe(0);
    });

    it("finds the cases that start on no page of the tree", () => {
        expect(unplacedCases(tree, cases).map((c) => c.id)).toEqual(["TC-004"]);
    });

    it("says whether the node counts add up to the total", () => {
        expect(countsAgree(tree, cases)).toBe(true);
        expect(countsAgree([node("/", null, 5)], [tc("TC-001", "/")])).toBe(false);
    });
});

describe("visibleNodes", () => {
    const roots = buildTree([node("/", null), node("/products", "/"), node("/products/1", "/products"), node("/about", "/")]);
    it("walks the open branches in screen order, skipping what sits under a closed node", () => {
        expect(visibleNodes(roots, new Set(["/"])).map((n) => n.path)).toEqual(["/", "/products", "/about"]);
        expect(visibleNodes(roots, new Set(["/", "/products"])).map((n) => n.path)).toEqual(["/", "/products", "/products/1", "/about"]);
        expect(visibleNodes(roots, new Set()).map((n) => n.path)).toEqual(["/"]);
    });
});

describe("words", () => {
    it("says the summary with one page count: the number of tree nodes, never the failed addresses", () => {
        const o = outcome({ tree: [node("/", null), node("/a", "/")], cases: [tc("TC-001", "/")], runs: [{ jobId: "j1", startedAt: "", status: "completed", addedPages: 2, addedCases: 1 }], notOpened: 5 });
        expect(summaryLine(o)).toBe("2 pages · 1 test case · built from 1 run");
        expect(summaryLine(outcome({ tree: [node("/", null)], cases: [], runs: [] }))).toBe("1 page · 0 test cases · built from 0 runs");
    });

    it("names the addresses that could not be opened once, in the singular and the plural, and nothing when there are none", () => {
        expect(notOpenedLine(1)).toBe("1 address could not be opened");
        expect(notOpenedLine(5)).toBe("5 addresses could not be opened");
        expect(notOpenedLine(0)).toBeNull();
    });

    it("says what the newest run's state means for the report", () => {
        const run = (status: CaseOutcome["runs"][number]["status"]) => [{ jobId: "j", startedAt: "", status, addedPages: 3, addedCases: 4 }];
        expect(lastRunNote([])).toBeNull();
        expect(lastRunNote(run("completed"))).toBeNull();
        expect(lastRunNote(run("running"))).toMatch(/still running/);
        expect(lastRunNote(run("stopped"))).toBe("The last run was stopped. It kept the 3 pages and 4 test cases it found before then.");
        expect(lastRunNote(run("failed"))).toMatch(/did not finish/);
    });
});
