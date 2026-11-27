/**
 * Plain words where people look (fresh review a8, a6): a queued run says it waits for a worker or runner, never "Running 4%"; a failed
 * test case run's outcome says why, in the Runs tab's words, without the parser's "(it was not valid JSON)". Browser-free: the page's
 * own rules (web/src).
 */
import { describe, expect, it } from "vitest";
import { lastRunNote } from "../web/src/features/outcome/outcome.js";
import { friendlyJobErrors, runningLabel } from "../web/src/lib/labels.js";

const job = (status: string) => ({ status, progress: { discovery: "done", understanding: "running", planning: "pending", generation: "pending", validation: "pending" } }) as never;

describe("a run nothing has started yet", () => {
    it("reads as waiting for a worker or runner, not as running", () => {
        expect(runningLabel(job("QUEUED"))).toBe("Waiting for a worker or runner");
        expect(runningLabel(job("RUNNING"))).toMatch(/^Running \d+%$/);
    });
});

describe("a failed run's reason on the Outcome tab", () => {
    const AI_FAIL = "The application could not be read with AI: The AI's answer could not be used: no structured output in the expected format, even after asking again. (it was not valid JSON).";
    it("names the reason in plain words, without the parser's", () => {
        const note = lastRunNote([{ jobId: "j", startedAt: "2026-11-27T10:00:00.000Z", status: "failed", addedPages: 0, addedCases: 0, reason: AI_FAIL }])!;
        expect(note).toMatch(/^The last run did not finish: the AI’s answers could not be used\. The AI model answered in a form AI Studio could not read/);
        expect(note).not.toMatch(/JSON/);
        expect(friendlyJobErrors(AI_FAIL)[0]!.body).not.toMatch(/JSON/);
    });
    it("a run with no reason stored keeps the old sentence", () => {
        expect(lastRunNote([{ jobId: "j", startedAt: "2026-11-27T10:00:00.000Z", status: "failed", addedPages: 2, addedCases: 3 }])).toBe("The last run did not finish. It kept the 2 pages and 3 test cases it found before then.");
    });
});
