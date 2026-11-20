/**
 * The words of a Test Case Generation project's runs (founder 2026-11-19 P5.3, R10.3, Q4; PLAN.md U5, FX8): a run says what it added to
 * the tree, a stopped one that what it found is kept, its stages are Exploring, Understanding and Writing test cases, and its status
 * never speaks of tests passing or a plan. Every other project's words are unchanged. Pure: no browser.
 */
import { describe, expect, it } from "vitest";
import { jobHelp } from "../web/src/lib/help.js";
import { jobLabel } from "../web/src/lib/labels.js";
import { CASE_STAGES, CASE_STOP_QUESTION, caseRunLine, caseRunTitle, caseStageText, stopQuestion } from "../web/src/features/runs/run-text.js";

const STATUSES = ["QUEUED", "DISCOVERING", "ANALYZING", "PLANNING", "GENERATING", "VALIDATING", "COMPLETED", "PARTIALLY_COMPLETED", "FAILED"] as const;
const BANNED = /pass|plan|script|check|need a look|tests? (?:were )?(?:created|run)/i;

describe("a Test Case Generation run's line", () => {
    it("says what it added, and for a stopped or unfinished run that what it found is kept", () => {
        expect(caseRunLine({ status: "completed", addedPages: 4, addedCases: 9 })).toBe("Added 4 pages and 9 test cases.");
        expect(caseRunLine({ status: "completed", addedPages: 1, addedCases: 1 })).toBe("Added 1 page and 1 test case.");
        expect(caseRunLine({ status: "stopped", addedPages: 22, addedCases: 14 })).toBe("Stopped. What it found is kept: it added 22 pages and 14 test cases.");
        expect(caseRunLine({ status: "failed", addedPages: 2, addedCases: 0 })).toBe("Did not finish. What it found is kept: it added 2 pages and 0 test cases.");
        expect(caseRunLine({ status: "running", addedPages: 3, addedCases: 0 })).toBe("Added 3 pages and 0 test cases so far.");
        expect(caseRunTitle(2)).toBe("Run 2");
        expect(caseRunTitle(undefined)).toBe("Run");
    });

    it("names the three stages for what they do", () => {
        expect(CASE_STAGES.map((s) => caseStageText(s, "running", {}).title)).toEqual(["Exploring", "Understanding", "Writing test cases"]);
        expect(caseStageText("discovery", "running", { pagesDiscovered: 3 }).detail).toBe("3 pages so far");
        expect(caseStageText("discovery", "done", { pagesDiscovered: 1 }).detail).toBe("Found 1 page");
        expect(caseStageText("planning", "done", { scenariosPlanned: 9 }).detail).toBe("9 test cases");
        for (const s of CASE_STAGES) for (const st of ["pending", "running", "done"] as const) expect(JSON.stringify(caseStageText(s, st, { pagesDiscovered: 2, scenariosPlanned: 2 }))).not.toMatch(BANNED);
    });

    it("promises before a stop that what the run found stays in the tree", () => {
        expect(CASE_STOP_QUESTION.body).toContain("are kept in the project's tree");
        expect(CASE_STOP_QUESTION.body).not.toMatch(BANNED);
    });
});

describe("a Test Case Generation run's status (FX8)", () => {
    it("is said in its own words, and never as tests passing, needing a look or a plan", () => {
        const label = (status: (typeof STATUSES)[number], error: string | null = null) => jobLabel({ status, error, mode: "generate", planOnly: true, caseAgent: true });
        expect(label("COMPLETED")).toEqual({ label: "Test cases written", tone: "success" });
        expect(label("PARTIALLY_COMPLETED")).toEqual({ label: "Test cases written, with a problem", tone: "warning" });
        expect(label("FAILED", "Cancelled")).toEqual({ label: "Stopped", tone: "neutral" });
        expect(label("FAILED", "boom")).toEqual({ label: "Did not finish", tone: "danger" });
        expect(label("DISCOVERING").label).toBe("Exploring");
        expect(label("ANALYZING").label).toBe("Understanding");
        expect(label("PLANNING").label).toBe("Writing test cases");
        for (const s of STATUSES) {
            expect(label(s).label).not.toMatch(BANNED);
            expect(jobHelp({ status: s, error: null, mode: "generate", planOnly: true, caseAgent: true })).not.toMatch(BANNED);
        }
        expect(jobHelp({ status: "FAILED", error: "Cancelled", planOnly: true, caseAgent: true })).toBe("Someone stopped it. The pages and test cases it found before then are kept in the tree.");
    });

    it("leaves every other project's words as they were", () => {
        expect(jobLabel({ status: "PARTIALLY_COMPLETED", error: null, mode: "generate" }).label).toBe("Ready, some tests need a look");
        expect(jobLabel({ status: "PARTIALLY_COMPLETED", error: null, mode: "generate", planOnly: true }).label).toBe("Plan ready");
        expect(jobLabel({ status: "COMPLETED", error: null, mode: "generate" }).label).toBe("Test suite ready");
        expect(jobLabel({ status: "PARTIALLY_COMPLETED", error: null, mode: "generate", caseAgent: false }).label).toBe("Ready, some tests need a look");
        expect(jobHelp({ status: "COMPLETED", planOnly: true })).toBe("The exploration made a plan of tests. Nothing is created until you choose what to make from it.");
        expect(stopQuestion("generate", undefined, true).body).toContain("No plan is made");
    });
});
