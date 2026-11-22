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
    it("C9 read-back, C6 backend and C8 concurrency checks and database checks are judged by code: a failure on an accepted answer is a finding", () => {
        const made = (tags: string[], check: Record<string, unknown>) =>
            TestSpecSchema.parse({ testId: "API-001", title: "Workflow: x", kind: "api", tags, steps: [{ action: "request", method: "POST", path: "/x" }, { action: "assertResponse", ...check }] });
        const failedAt = (status: number, error: string): ScriptRun => ({ ...run(status), steps: [{ index: 0, title: "1. POST /x", status: "passed" }, { index: 1, title: "2. Check", status: "failed", error }] });
        const rel = { check: "relation", expression: "ok == 1" };
        const relErr = "Error: Relation check failed: ok == 1. Values: ok = 3.";
        for (const tag of ["readback", "backend", "concurrency"]) expect(apiFinding(made(["api", "workflow", tag], rel), failedAt(200, relErr))).toMatch(/breaks a stated rule.*ok == 1/);
        expect(apiFinding(made(["api", "workflow", "backend", "duplicate"], { check: "status", expected: 409 }), failedAt(201, "expect(received).toBe(expected)"))).toMatch(/HTTP 409.*accepted.*HTTP 201/);
        const dbErr = "Error: Database check failed: exists users where name = 'N': no stored row matches what the write sent.";
        expect(apiFinding(made(["api", "workflow"], { check: "dbCheck", name: "exists users where name = 'N'" }), failedAt(200, dbErr))).toMatch(/stored data.*no stored row matches/);
        // Not for other tests, a refused answer, or another error: left to the repair loop.
        expect(apiFinding(made(["api", "workflow"], rel), failedAt(200, relErr))).toBeUndefined();
        expect(apiFinding(made(["api", "readback"], rel), failedAt(400, relErr))).toBeUndefined();
        expect(apiFinding(made(["api", "readback"], rel), failedAt(200, "TypeError: x"))).toBeUndefined();
        expect(apiFinding(made(["api", "workflow"], { check: "dbCheck", name: "exists users where name = 'N'" }), failedAt(200, "fetch failed"))).toBeUndefined();
        // A database check at the end of a test follows its last answer, which may be a documented refusal (the deleted record is gone).
        expect(apiFinding(made(["api", "workflow"], { check: "dbCheck", name: "orphans a(b) -> c(d)" }), failedAt(404, "Error: Database check failed: orphans a(b) -> c(d): 1 more row(s) break it"))).toMatch(/stored data/);
        expect(apiFinding(made(["api", "readback"], { check: "status", expected: 409 }), failedAt(409, "x"))).toBeUndefined();
        // A status check that expects a success is not a refusal the API skipped.
        expect(apiFinding(made(["api", "readback"], { check: "status", expected: 200 }), failedAt(201, "x"))).toBeUndefined();
    });
    it("counts each copy of a request sent several times at once: the answer judged is the one before the failing check", () => {
        const spec = TestSpecSchema.parse({ testId: "API-001", title: "Concurrency: x", kind: "api", tags: ["api", "workflow", "concurrency"], steps: [{ action: "request", method: "POST", path: "/x", parallel: 3 }, { action: "request", method: "GET", path: "/x" }, { action: "assertResponse", check: "relation", expression: "count(items) == 1" }] });
        const r: ScriptRun = { ...run(200), failedStepIndex: 2, steps: [{ index: 0, title: "1. POST", status: "passed" }, { index: 1, title: "2. GET", status: "passed" }, { index: 2, title: "3. One record", status: "failed", error: "Error: Relation check failed: count(items) == 1. Values: count(items) = 3." }], responses: [{ method: "POST", path: "/x", status: 201 }, { method: "POST", path: "/x", status: 409 }, { method: "POST", path: "/x", status: 201 }, { method: "GET", path: "/x", status: 200 }] };
        expect(apiFinding(spec, r)).toMatch(/breaks a stated rule/);
    });
});

