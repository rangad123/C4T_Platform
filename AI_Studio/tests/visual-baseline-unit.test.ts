import { describe, expect, it } from "vitest";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { isMissingBaseline } from "../src/engine/visual/baseline.js";

const run = (r: Partial<ScriptRun>): ScriptRun => ({ testId: "WEB-001", status: "failed", steps: [], ...r }) as ScriptRun;
const fresh = [{ name: "WEB-001-step-2.png", path: "/b/WEB-001-step-2.png" }];

describe("a first visual run", () => {
    it("counts as new baselines whether Playwright failed the run (older versions) or passed it (newer ones)", () => {
        expect(isMissingBaseline(run({ status: "failed", error: "A snapshot doesn't exist at /b/WEB-001-step-2.png, writing actual.", newBaselines: fresh }))).toBe(true);
        expect(isMissingBaseline(run({ status: "passed", newBaselines: fresh }))).toBe(true);
    });

    it("does not count when nothing was written, or the run failed for another reason", () => {
        expect(isMissingBaseline(run({ status: "passed", newBaselines: [] }))).toBe(false);
        expect(isMissingBaseline(run({ status: "passed" }))).toBe(false);
        expect(isMissingBaseline(run({ status: "failed", error: "Timed out waiting for the page", newBaselines: fresh }))).toBe(false);
    });
});
