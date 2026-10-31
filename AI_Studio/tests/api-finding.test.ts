import { describe, expect, it } from "vitest";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { apiFinding } from "../src/engine/validation/validator.js";

const spec = (tags: string[], auth: "default" | "none") =>
    TestSpecSchema.parse({
        testId: "API-001",
        title: "Fixture API test",
        kind: "api",
        tags,
        steps: [
            { action: "request", method: "GET", path: "/x", auth },
            { action: "assertResponse", check: "statusClass", expected: "4xx" },
        ],
    });

const run = (status: number): ScriptRun => ({
    testId: "API-001",
    status: "failed",
    durationMs: 1,
    failedStepIndex: 1,
    steps: [
        { index: 0, title: "1. GET /x", status: "passed" },
        { index: 1, title: "2. Rejected", status: "failed", error: "Expected 4" },
    ],
    artifacts: [],
    responses: [{ method: "GET", path: "/x", status }],
});

describe("apiFinding", () => {
    it("flags any 5xx as a server error", () => {
        expect(apiFinding(spec(["api"], "default"), run(500))).toMatch(/Server error.*500/);
    });
    it("flags a no-credentials test that got 2xx as a security issue", () => {
        expect(apiFinding(spec(["api", "auth"], "none"), run(200))).toMatch(/security issue/);
    });
    it("leaves ordinary expectation mismatches to the repair loop", () => {
        expect(apiFinding(spec(["api"], "default"), run(404))).toBeUndefined();
        expect(apiFinding(spec(["api", "auth"], "none"), run(404))).toBeUndefined();
    });
});
