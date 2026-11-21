/**
 * One count rule everywhere (F3 round 2, M5 and L10; founder 2026-11-19 P3.2): "pages" are real pages only. A requirement area (a tree
 * node with no page, SPEC R16) groups test cases but is never counted or named as a page. The Dashboard summary, the run page, the
 * Projects row and the workbook's Pages sheet all say the same number, for a page-only and a requirements-only outcome.
 * Also L10: a case whose own start page is not a page of the tree keeps that start page, so two cases with one title stay apart.
 * Pure: no database, no browser.
 *
 *   node scripts/with-lock.mjs tsc -- npx vitest run tests/case-outcome-counts-unit.test.ts
 */
import { describe, expect, it } from "vitest";
import { readSheet } from "../src/engine/manual/xlsx-read.js";
import { mergeCaseRuns, type CaseRunInput } from "../src/platform/case-outcome.js";
import { outcomeCounts, type CaseOutcome } from "../src/platform/case-outcome-types.js";
import { runOutcomeOf } from "../src/platform/case-run-outcome.js";
import { buildCaseWorkbook } from "../src/platform/case-workbook.js";
import { countsLine, summaryLine } from "../web/src/features/outcome/outcome.js";

const page = (path: string) => ({ path, url: `http://shop.test${path}`, title: `Title of ${path}`, purpose: "" });
const kase = (title: string, start: string, area?: string) => ({ title, type: "automated" as const, priority: "high" as const, page: start, preconditions: [], steps: [], expected: [], requirement: "", ...(area ? { area } : {}) });
const one = (part: Partial<CaseRunInput["part"]>): CaseRunInput => ({ run: { jobId: "job-1", startedAt: "2026-11-21T10:00:00.000Z", status: "completed" }, part: { pages: [], edges: [], cases: [], failed: [], ...part } });

/** What each screen says about the outcome, by the code each screen uses. */
function screens(input: CaseRunInput) {
    const merged = mergeCaseRuns([input]);
    const o: CaseOutcome = { caseAgent: true, runs: merged.runs, pages: merged.pages, tree: merged.tree, cases: merged.cases, notOpened: merged.notOpened, missing: [] };
    const runPart = runOutcomeOf(merged, input.run.jobId)!;
    const wb = buildCaseWorkbook(o);
    return {
        counts: outcomeCounts(o),
        dashboard: summaryLine(o),
        runPage: summaryLine(runPart),
        runAddedPages: runPart.runs[0]!.addedPages,
        // The Projects row reads GET /outcome?counts=1, which answers outcomeCounts (routes/case-outcome.ts).
        projectsRow: countsLine(outcomeCounts(o)),
        workbookPages: readSheet(wb, "Pages").length - 1,
        workbookTree: readSheet(wb, "Tree").length - 1,
    };
}

describe("one page count on every screen (M5)", () => {
    it("a page-only outcome: 2 pages everywhere", () => {
        const s = screens(one({ pages: [page("/"), page("/cart")], cases: [kase("Open home", "/"), kase("Open the cart", "/cart"), kase("Pay", "/cart")] }));
        expect(s.counts).toEqual({ cases: 3, pages: 2, areas: 0 });
        expect(s.dashboard).toBe("2 pages, 3 test cases, from 1 run");
        expect(s.runPage).toBe(s.dashboard);
        expect(s.runAddedPages).toBe(2);
        expect(s.projectsRow).toBe("3 test cases, 2 pages");
        expect(s.workbookPages).toBe(2);
    });

    it("a requirements-only outcome: 0 pages everywhere, and the areas are named as requirement areas", () => {
        const s = screens(one({ cases: ["REQ-1 Sign in", "REQ-2 Search", "REQ-3 Pay"].flatMap((a) => [kase(`Verify ${a}`, "", a), kase(`Check ${a}`, "", a)]) }));
        expect(s.counts).toEqual({ cases: 6, pages: 0, areas: 3 });
        expect(s.dashboard).toBe("6 test cases in 3 requirement areas, from 1 run");
        expect(s.runPage).toBe(s.dashboard);
        expect(s.runAddedPages).toBe(0);
        expect(s.projectsRow).toBe("6 test cases, 3 requirement areas");
        expect(s.workbookPages).toBe(0);
        // The areas stay in the tree, so the cases are grouped.
        expect(s.workbookTree).toBe(3);
    });

    it("pages and areas together are counted apart", () => {
        const s = screens(one({ pages: [page("/")], cases: [kase("Open home", "/"), kase("Sign in", "", "REQ-1 Sign in")] }));
        expect(s.counts).toEqual({ cases: 2, pages: 1, areas: 1 });
        expect(s.dashboard).toBe("1 page, 1 requirement area, 2 test cases, from 1 run");
        expect(s.runPage).toBe(s.dashboard);
        expect(s.projectsRow).toBe("2 test cases, 1 page, 1 requirement area");
        expect(s.workbookPages).toBe(1);
    });
});

describe("a case keeps its own start page when it is not its tree node (L10)", () => {
    it("two cases with one title and start pages off the tree stay apart; a case on its node says nothing more", () => {
        const m = mergeCaseRuns([one({ pages: [page("/")], cases: [kase("Open the cart", "/basket"), kase("Open the cart", "/basket/mini"), kase("Open home", "/")] })]);
        expect(m.cases.map((c) => [c.id, c.page, c.start])).toEqual([
            ["TC-001", "/", "/basket"],
            ["TC-002", "/", "/basket/mini"],
            ["TC-003", "/", undefined],
        ]);
    });
});
