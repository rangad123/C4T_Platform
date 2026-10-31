/**
 * A fixed `ai-test` result used to prove the CLI's HTML / Markdown / console / JSON / JUnit / SARIF output
 * never changes when the renderer's internals are shared with the project report (tests/reports.test.ts).
 * The goldens in tests/fixtures/golden-ci/ were captured from the renderer BEFORE it was refactored.
 */
import { summarize, type CiReport, type CiTest } from "../../src/cli/model.js";

// 1x1 PNG, deterministic bytes.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");

const base = (over: Partial<CiTest>): CiTest => ({ id: "x", testId: "WEB-001", title: "A test", suite: "General", kind: "web", type: "functional", priority: "high", outcome: "passed", validation: "VALIDATED", durationMs: 100, attempts: 1, evidence: [], ...over });

const tests: CiTest[] = [
    base({ id: "t1", testId: "WEB-001", title: "Home page loads", durationMs: 420 }),
    base({ id: "t2", testId: "WEB-002", title: "Checkout <b>button</b> works | really", suite: "Checkout", outcome: "finding", validation: "NEEDS_REVIEW", severity: "critical", severityBasis: "payment flow", category: "functional-defect", reason: "Expected the \"Pay\" button to be visible & enabled\nbut it was missing <script>alert(1)</script>", durationMs: 2350, failedStep: { number: 3, title: "Click Pay" }, link: "http://platform.test/#/tests/t2?a=1&b=2", evidence: [{ kind: "screenshot", data: PNG }, { kind: "video", file: "evidence/WEB-002.webm" }] }),
    base({ id: "t3", testId: "WEB-003", title: "Security headers", suite: "Security", outcome: "finding", validation: "NEEDS_REVIEW", severity: "medium", severityBasis: "missing header", category: "security-check", reason: "Passive security check: Content-Security-Policy header is missing", durationMs: 900 }),
    base({ id: "t4", testId: "WEB-004", title: "Contrast", suite: "Accessibility", outcome: "finding", validation: "NEEDS_REVIEW", severity: "low", category: "accessibility", reason: "Accessibility: 2 violations", durationMs: 1500, evidence: [{ kind: "visual-diff", data: PNG }, { kind: "trace", file: "evidence/t4.zip" }] }),
    base({ id: "t5", testId: "API-001", title: "List orders", suite: "Orders", kind: "api", outcome: "failed", validation: "FAILED_VALIDATION", reason: "Timed out waiting for response after 30000 ms", durationMs: 30000, failedStep: { number: 1, title: "GET /orders" } }),
    base({ id: "t6", testId: "WEB-005", title: "Not yet run", outcome: "not_run", validation: "PENDING", durationMs: 0 }),
];

export const goldenReport: CiReport = {
    schemaVersion: 1,
    tool: { name: "ai-test", version: "0.0.0-golden" },
    generatedAt: "2026-01-02T03:04:05.000Z",
    mode: "replay",
    target: "http://app.test:3000",
    project: { name: "Golden <project>", id: "p1" },
    durationMs: 12345,
    summary: summarize(tests),
    gate: { failOn: "high", failOnFailedValidation: true, passed: false, reasons: ["1 finding at high or higher severity (worst: critical).", "1 test could not be validated."], exitCode: 1 },
    tests,
};

export const goldenPassed: CiReport = {
    ...goldenReport,
    tests: [tests[0]!],
    summary: summarize([tests[0]!]),
    gate: { failOn: "high", failOnFailedValidation: true, passed: true, reasons: [], exitCode: 0 },
};
