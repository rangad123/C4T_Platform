/**
 * One test, two bugs. A test with an open issue link is an expected failure only when it fails the way its linked finding did: the same
 * failing step (the same check with the same expected value), or, for a finding known only by its error, the same first error line. This
 * is V1's same-failure rule. Another failure is reported as a failure of its own (a new finding), and a pass says "seems fixed" for the
 * tracked bug. Browser-free: the real platform (SQLite) and Playwright's JSON report as the runner reads it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { apiGenerator } from "../src/engine/generators/api.js";
import { KNOWN_BUG_FAILURE } from "../src/engine/generators/types.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { failsAsTracked, KNOWN_BUG_FIXED, parseReport } from "../src/engine/validation/runner.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { knownBugsOf, trackedFailures } from "../src/platform/job-runner.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";

// The cart test both seeds break: one changes the subtotal (step 4 fails), the other only the discount (step 6 fails).
const spec = TestSpecSchema.parse({
    testId: "API-017",
    title: "SAVE10 takes 10% off the subtotal",
    kind: "api",
    category: "Discounts",
    steps: [
        { action: "request", method: "POST", path: "/api/cart/items", body: { productId: "p1", quantity: 2 } },
        { action: "assertResponse", check: "status", expected: 201 },
        { action: "request", method: "POST", path: "/api/cart/discount", body: { code: "SAVE10" } },
        { action: "assertResponse", check: "jsonPath", path: "subtotal", expected: 3350 },
        { action: "request", method: "GET", path: "/api/cart" },
        { action: "assertResponse", check: "jsonPath", path: "discount", expected: 335 },
    ],
});
const BUG = "#101 https://github.example/acme/bench/issues/101";

let platform: Platform;
let dir = "";
beforeAll(() => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-two-seeds-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "two-seeds-secret-key-0123456789abcdef", API_KEY: "k-two-seeds", SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
});
afterAll(() => {
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

/** A project whose test API-017 has the first seed's finding (its attempts failed at `step`) filed as issue #101. */
function trackedTest(attempts: unknown[], observed = "Error: expect(received).toEqual(expected) Expected: 3350 Received: 2925") {
    const projectId = String(platform.repo.createProject({ name: `Shop ${Math.random()}` }).id);
    platform.repo.createApplication(projectId, "http://127.0.0.1:5591", { ...DEFAULT_JOB_OPTIONS });
    const suiteId = platform.repo.getOrCreateSuite(projectId, "Discounts", "discounts");
    const testId = platform.repo.insertTest({ projectId, suiteId, jobId: null, spec, framework: "playwright-api", validationStatus: "VALIDATED" });
    const t = new Date().toISOString();
    platform.db.run(
        "INSERT INTO candidate_findings (id, project_id, test_id, fingerprint, status, confidence, capture, finding_json, first_seen_at, last_seen_at, created_at, updated_at, state, attempts_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        `f-${projectId}`, projectId, testId, `fp-${projectId}`, "candidate", "high", "captured", JSON.stringify({ observed }), t, t, t, t, "confirmed", JSON.stringify(attempts),
    );
    platform.db.run("INSERT INTO issue_links (id, test_case_id, integration_id, provider, external_id, url, title, created_at) VALUES (?,?,?,?,?,?,?,?)", `l-${projectId}`, testId, null, "github", "#101", "https://github.example/acme/bench/issues/101", "Subtotal", t);
    return testId;
}
const failedAt = (step: number, value: string) => ({ outcome: "failed", failedStep: step, check: "jsonPath", value, error: `Error: expect(received).toEqual(expected) Expected: ${value}` });

describe("the way a tracked bug fails its test", () => {
    it("is the step the linked finding's attempts failed at, while that step is the same check with the same expected value", () => {
        const id = trackedTest([failedAt(4, "3350"), failedAt(4, "3350"), { outcome: "passed" }]);
        expect(trackedFailures(platform.db, id, spec)).toEqual([{ step: 4 }]);
        const k = knownBugsOf(platform.db, [{ handle: { id, testId: "API-017" }, spec } as never]);
        expect(k).toEqual({ knownBugs: { "API-017": BUG }, knownBugFailures: { "API-017": [{ step: 4 }] } });
        // The step now checks something else: only the error's first line identifies the bug.
        const changed = { ...spec, steps: spec.steps.map((s, i) => (i === 3 ? { ...s, expected: 9999 } : s)) } as typeof spec;
        expect(trackedFailures(platform.db, id, changed)).toEqual([{ firstLine: "Error: expect(received).toEqual(expected) Expected: 3350" }]);
        // No attempts yet: the finding's observed error line.
        expect(trackedFailures(platform.db, trackedTest([]), spec)).toEqual([{ firstLine: "Error: expect(received).toEqual(expected) Expected: 3350 Received: 2925" }]);
    });

    it("follows V1's rule: the same step, else the same first error line; no known way keeps any failure expected", () => {
        expect(failsAsTracked([{ step: 4 }], 3, "anything")).toBe(true);
        expect(failsAsTracked([{ step: 4 }], 5, "anything")).toBe(false);
        expect(failsAsTracked([{ step: 4 }], undefined, "anything")).toBe(false);
        expect(failsAsTracked([{ firstLine: "Error: Expected 3350" }], 5, "error:  expected 3350\nat line 2")).toBe(true);
        expect(failsAsTracked([{ firstLine: "Error: Expected 3350" }], 5, "Error: Expected 335")).toBe(false);
        expect(failsAsTracked(undefined, 5, "x")).toBe(true);
        expect(failsAsTracked([], 5, "x")).toBe(true);
    });

    it("travels in the tracked test's script", () => {
        const out = apiGenerator.render(spec, { baseUrl: "http://127.0.0.1:5591", knownBugs: { "API-017": BUG }, knownBugFailures: { "API-017": [{ step: 4 }] } });
        expect(out.content).toContain(`test.fail(true, "Tracks the open bug ${BUG}");`);
        expect(out.content).toContain(`test.info().annotations.push({ type: "${KNOWN_BUG_FAILURE}", description: "[{\\"step\\":4}]" });`);
        expect(apiGenerator.render(spec, { baseUrl: "http://127.0.0.1:5591", knownBugs: { "API-017": BUG } }).content).not.toContain(KNOWN_BUG_FAILURE);
    });
});

describe("two seeds sharing one test", () => {
    /** Playwright's JSON report for one tracked run of API-017 that failed at `failsAt` (1-based), or passed. */
    async function run(failsAt: number | null, ways: unknown = [{ step: 4 }]) {
        const runDir = fs.mkdtempSync(path.join(dir, "run-"));
        const steps = spec.steps.map((_, i) => ({ title: `${i + 1}. step`, duration: 1, ...(failsAt === i + 1 ? { error: { message: `Error: expect(received).toEqual(expected) at step ${i + 1}` } } : {}) })).slice(0, failsAt ?? spec.steps.length);
        const annotations = [{ type: "fail", description: `Tracks the open bug ${BUG}` }, ...(ways ? [{ type: KNOWN_BUG_FAILURE, description: JSON.stringify(ways) }] : [])];
        const result = { status: failsAt ? "failed" : "passed", duration: 5, steps, attachments: [], ...(failsAt ? { error: { message: steps.at(-1)!.error!.message } } : {}) };
        const report = { suites: [{ file: "API-017.spec.ts", specs: [{ title: "API-017", file: "API-017.spec.ts", tests: [{ projectName: "api", status: failsAt ? "expected" : "unexpected", expectedStatus: "failed", annotations, results: [result] }] }] }] };
        fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report));
        const [r] = await parseReport(runDir, [{ testId: "API-017", filename: "API-017.spec.ts", content: "" }], "", false);
        return r!;
    }

    it("the first seed's failure is the expected one: green, and noted as the tracked bug", async () => {
        const r = await run(4);
        expect(r.status).toBe("passed");
        expect(r.notes?.[0]).toMatch(/^Failed as expected: the bug this test tracks \(Tracks the open bug #101/);
    });

    it("the second seed's failure (another step) is a failure of its own, so a new finding can be written", async () => {
        const r = await run(6);
        expect(r.status).toBe("failed");
        expect(r.failedStepIndex).toBe(5);
        expect(r.error).toContain("at step 6");
        expect(r.notes).toContain(`It failed another way than the bug it tracks (Tracks the open bug ${BUG}): this is a failure of its own.`);
    });

    it("a pass says the tracked bug seems fixed; a script with no known way keeps every failure expected", async () => {
        const pass = await run(null);
        expect(pass.status).toBe("failed");
        expect(pass.error).toMatch(new RegExp(`^${KNOWN_BUG_FIXED} \\(Tracks the open bug #101`));
        expect((await run(6, null)).status).toBe("passed");
    });
});
