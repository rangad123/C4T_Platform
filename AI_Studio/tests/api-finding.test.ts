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
    it("a documented case (C2) whose documented status was answered with a success: the API does not keep a rule its document states", () => {
        const documented = (tags: string[]) =>
            TestSpecSchema.parse({ testId: "API-001", title: "POST /x: rejects", kind: "api", tags, steps: [{ action: "request", method: "POST", path: "/x" }, { action: "assertResponse", check: "status", expected: 400 }] });
        expect(apiFinding(documented(["validation", "documented"]), run(201))).toMatch(/document says HTTP 400.*accepted.*HTTP 201/);
        // another refusal than the documented one, an undocumented case, or a status-class check: left to the repair loop as before
        expect(apiFinding(documented(["validation", "documented"]), run(422))).toBeUndefined();
        expect(apiFinding(documented(["validation"]), run(201))).toBeUndefined();
        expect(apiFinding(spec(["documented"], "default"), run(200))).toBeUndefined();
    });
    it("leaves ordinary expectation mismatches to the repair loop", () => {
        expect(apiFinding(spec(["api"], "default"), run(404))).toBeUndefined();
        expect(apiFinding(spec(["api", "auth"], "none"), run(404))).toBeUndefined();
    });
});
