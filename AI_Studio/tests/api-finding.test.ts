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
    it("a probe case (C5, tag invariant) whose stated relation failed on an accepted answer: the API breaks a stated rule", () => {
        const probe = (tags: string[]) =>
            TestSpecSchema.parse({ testId: "API-001", title: "POST /x: requirement 3.9 holds", kind: "api", tags, steps: [{ action: "request", method: "POST", path: "/x" }, { action: "assertResponse", check: "relation", expression: "subtotal == sum(lines[*].lineTotal)", source: "3.9" }] });
        const failedAt = (status: number, error: string): ScriptRun => ({ ...run(status), steps: [{ index: 0, title: "1. POST /x", status: "passed" }, { index: 1, title: "2. Verify", status: "failed", error }] });
        const msg = "Error: Relation check failed (3.9): subtotal == sum(lines[*].lineTotal) is false\n    at x";
        expect(apiFinding(probe(["api", "invariant"]), failedAt(201, msg))).toBe("The API breaks a stated rule (requirement 3.9): Relation check failed (3.9): subtotal == sum(lines[*].lineTotal) is false");
        // not a probe case, a refused answer, or another error: left to the repair loop
        expect(apiFinding(probe(["api"]), failedAt(201, msg))).toBeUndefined();
        expect(apiFinding(probe(["api", "invariant"]), failedAt(400, msg))).toBeUndefined();
        expect(apiFinding(probe(["api", "invariant"]), failedAt(201, "TypeError: x is undefined"))).toBeUndefined();
    });
    it("leaves ordinary expectation mismatches to the repair loop", () => {
        expect(apiFinding(spec(["api"], "default"), run(404))).toBeUndefined();
        expect(apiFinding(spec(["api", "auth"], "none"), run(404))).toBeUndefined();
    });
    it("a code-made security check (C11) whose stated check fails on an answer the API accepted: a finding without AI", () => {
        const check = (origin: string, expected: unknown, check = "status") =>
            TestSpecSchema.parse({ testId: "API-001", title: "Sign-in is limited", kind: "api", tags: ["security"], source: { origin }, steps: [{ action: "request", method: "POST", path: "/x" }, { action: "assertResponse", check, expected, source: "2.14" }] });
        expect(apiFinding(check("security-check", 429), run(200))).toMatch(/stated rule \(2\.14\).*HTTP 200/);
        expect(apiFinding(check("security-check", "undefined", "jsonType"), run(200))).toMatch(/stated rule \(2\.14\)/);
        // Not when the API refused (another refusal goes to repair), and not for a test the AI wrote.
        expect(apiFinding(check("security-check", 429), run(401))).toBeUndefined();
        expect(apiFinding(check("browser-agent", 429), run(200))).toBeUndefined();
    });
});

