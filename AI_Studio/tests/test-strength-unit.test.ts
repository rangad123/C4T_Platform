/** Testing the tests, without a browser: which faults apply to a test, how a fault run is read, and the level's bound. */
import { describe, expect, it } from "vitest";
import { LEVEL_SETTINGS } from "../src/engine/levels.js";
import { classifyFaultRun, faultEligibility, faultScript, faultsFor, NOT_APPLIED, strengthText } from "../src/engine/mutation/faults.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";

const spec = (steps: unknown[], testData?: Record<string, string>): TestSpec => TestSpecSchema.parse({ testId: "WEB-001", title: "A test", kind: "web", category: "Forms", source: { origin: "browser-agent" }, steps, ...(testData ? { testData } : {}) });
const open = { action: "navigate", url: "/" };
const run = (p: Partial<ScriptRun>): ScriptRun => ({ testId: "x", status: "failed", durationMs: 1, failedStepIndex: -1, steps: [], artifacts: [], responses: [], ...p });

describe("deliberate faults", () => {
    it("picks the faults that fit the checked step", () => {
        expect(faultsFor(spec([open, { action: "assert", check: "text", locator: { by: "css", value: "#m" }, expected: "Saved" }])).map((f) => f.kind)).toEqual(["error", "empty", "changed", "hidden"]);
        expect(faultsFor(spec([open, { action: "assert", check: "url", expected: "/done" }])).map((f) => f.kind)).toEqual(["error", "empty"]);
        expect(faultsFor(spec([open, { action: "assert", check: "a11y" }]))).toEqual([]);
    });

    it("never replays tests that create records, did not pass, or check nothing on the page", () => {
        const ok = spec([open, { action: "assert", check: "title", expected: "Home" }]);
        expect(faultEligibility(ok, "VALIDATED")).toEqual({ eligible: true });
        expect(faultEligibility(ok, "NEEDS_REVIEW").eligible).toBe(false);
        expect(faultEligibility(spec(ok.steps, { runTag: "qa1b2c" }), "VALIDATED")).toMatchObject({ eligible: false, reason: expect.stringMatching(/creates records/) });
    });

    it("builds the fault into the test's own script, changing only responses", () => {
        const s = spec([open, { action: "click", locator: { by: "role", role: "button", value: "Go" } }, { action: "assert", check: "visible", expected: "Done" }]);
        const f = faultScript(s, { baseUrl: "http://127.0.0.1:1" }, faultsFor(s)[0]!)!;
        expect(f.testId).toBe("WEB-001~fault-error");
        expect(f.content.indexOf("await faultResponses(page);")).toBeLessThan(f.content.indexOf("evidenceStep(page, 2);"));
        expect(f.content).toContain("route.fetch({ maxRedirects: 0 })");
        expect(f.content).not.toMatch(/route\.continue\(\{/);
    });

    it("reads a fault run: failed caught it, passed missed it, nothing changed does not count", () => {
        expect(classifyFaultRun(run({ status: "failed", steps: [{ index: 0, title: "1", status: "failed", error: "x" }] }))).toBe("caught");
        expect(classifyFaultRun(run({ status: "passed" }))).toBe("missed");
        expect(classifyFaultRun(run({ status: "failed", error: `Error: ${NOT_APPLIED}` }))).toBe("not_applied");
        expect(classifyFaultRun(run({ status: "error" }))).toBe("no_result");
        expect(strengthText({ caught: 3, total: 4 })).toBe("catches 3 of 4 deliberate faults");
    });

    it("is bounded per level", () => {
        expect([LEVEL_SETTINGS.thorough.strengthTests, LEVEL_SETTINGS.deep.strengthTests, LEVEL_SETTINGS.everything.strengthTests]).toEqual([15, 40, Infinity]);
    });
});
