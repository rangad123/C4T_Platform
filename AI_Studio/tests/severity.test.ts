import { describe, expect, it } from "vitest";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { assessSeverity } from "../src/engine/validation/severity.js";

const spec = (over: Record<string, unknown> = {}) =>
    TestSpecSchema.parse({ testId: "WEB-001", title: "Fixture test", kind: "web", steps: [{ action: "navigate", url: "/" }], ...over });

describe("assessSeverity", () => {
    it("only scores application findings", () => {
        expect(assessSeverity(spec(), "VALIDATED", null)).toBeUndefined();
        expect(assessSeverity(spec(), "FAILED_VALIDATION", "locator timed out")).toBeUndefined();
    });

    it("treats an auth bypass as critical regardless of priority", () => {
        expect(assessSeverity(spec({ priority: "low" }), "NEEDS_REVIEW", "Possible security issue: GET /me returned 200 without credentials.")?.severity).toBe("critical");
    });

    it("scores server errors by journey priority", () => {
        expect(assessSeverity(spec({ priority: "critical" }), "NEEDS_REVIEW", "Server error: GET /x returned 500")?.severity).toBe("critical");
        expect(assessSeverity(spec({ priority: "medium" }), "NEEDS_REVIEW", "Server error: GET /x returned 500")?.severity).toBe("high");
    });

    it("maps the worst accessibility impact", () => {
        const a11y = spec({ type: "accessibility" });
        const msg = (impact: string) => `Accessibility audit failed: 1 WCAG rule violated at "serious" impact or above\n- image-alt [${impact}]: Images must have alt text (1 node: img)`;
        expect(assessSeverity(a11y, "NEEDS_REVIEW", msg("critical"))?.severity).toBe("high");
        expect(assessSeverity(a11y, "NEEDS_REVIEW", msg("serious"))?.severity).toBe("medium");
        expect(assessSeverity(a11y, "NEEDS_REVIEW", msg("moderate"))?.severity).toBe("low");
    });

    it("scores functional defects by priority, one step higher for security tests", () => {
        expect(assessSeverity(spec({ priority: "high" }), "NEEDS_REVIEW", "The application did not behave as expected: cart count wrong")?.severity).toBe("high");
        expect(assessSeverity(spec({ priority: "high", type: "security" }), "NEEDS_REVIEW", "unexpected")?.severity).toBe("critical");
        expect(assessSeverity(spec({ priority: "critical", type: "security" }), "NEEDS_REVIEW", "unexpected")?.severity).toBe("critical");
    });
});
