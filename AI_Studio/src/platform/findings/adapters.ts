/**
 * Findings of every source read as one view (testing-engine Phase 5 S2, spec §5.1 item 1, owner's H2 and Q3): a stored candidate finding
 * (exploration, slot 67/71), a failed run of an ordinary test or of a Phase 4 layer check (test meta `layer`), and a security finding
 * (security_findings, which keeps its own states: they are mapped here and never written back). Each adapter ends in
 * FindingViewSchema.parse, the boundary that redacts and cuts free text.
 */
import { confidenceOf, findingFingerprint, type CandidateFindingInput } from "../../engine/explore/finding.js";
import { AttemptSchema, FindingViewSchema, type Attempt, type FindingView, type FindingViewInput } from "../../engine/findings/view.js";
import { redactText } from "../../shared/redact-text.js";
import type { FindingState } from "../../engine/findings/lifecycle.js";
import type { TestSpec } from "../../engine/spec/schema.js";
import { testStepFault } from "../../engine/validation/test-fault.js";
import type { ScriptRun } from "../../engine/validation/runner.js";
import type { SecurityFinding, ValidationState } from "../../security/contract.js";
import type { CandidateFindingRecord } from "../candidate-finding-store.js";

/** The security module's states in lifecycle words (plan S2). */
export const SECURITY_STATE: Record<ValidationState, FindingState> = {
    confirmed: "confirmed",
    probable: "candidate",
    "needs-review": "needs_manual_review",
    "false-positive": "unconfirmed",
    fixed: "fixed",
    "accepted-risk": "accepted_risk",
};

/** What a view needs of the test a finding belongs to. */
export interface TestOf {
    id: string;
    title: string;
    spec: TestSpec;
    /** The test's meta (TestRow.generationMeta): Phase 4 puts `layer` there. */
    meta?: Record<string, unknown> | null;
}

type Step = TestSpec["steps"][number];
const field = (s: Step, k: string): unknown => (s as Record<string, unknown>)[k];
const targetOf = (s: Step): string | undefined => {
    const loc = field(s, "locator") as { value?: unknown; ref?: unknown } | undefined;
    const v = loc?.value ?? loc?.ref ?? field(s, "path");
    return typeof v === "string" && v ? v : undefined;
};
const stepsOf = (spec: TestSpec | undefined): FindingViewInput["steps"] =>
    (spec?.steps ?? []).slice(0, 500).map((s) => ({ action: s.action, ...(targetOf(s) ? { target: targetOf(s) } : {}), ...(typeof field(s, "url") === "string" ? { url: field(s, "url") as string } : {}) }));
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/**
 * The fingerprint of a failed run of an ordinary test or layer check (V1): one finding per project, test and expectation. The scenario
 * `execution:<test key>` keeps it apart from an exploration finding of the same check; fromCandidate reads the source kind back from it.
 */
export const executionFingerprint = (testKey: string, expected: { text: string; source: string | null }): string =>
    findingFingerprint({ source: expected.source, expected: expected.text, scenario: `execution:${testKey}` });

/** What the failed run says the test expected: the failing check's own source when it names one, else the test's written results. */
function expectationOf(spec: TestSpec, run: Pick<ScriptRun, "failedStepIndex">): { text: string; source: string | null } {
    const failing = run.failedStepIndex >= 0 ? spec.steps[run.failedStepIndex] : undefined;
    const source = failing ? (str(field(failing, "source")) ?? null) : null;
    const value = failing ? field(failing, "expected") : undefined;
    const text = typeof value === "string" || typeof value === "number" ? `${spec.expectedResults.join(" ")} (${String(value)})`.trim() : spec.expectedResults.join(" ");
    // Stored text is redacted and cut (CandidateFindingSchema): the fingerprint is made from the stored form, so it can be checked again.
    return { text: redactText(text || spec.title, 2000), source };
}

/** A failed run of an ordinary test (or Phase 4 layer check) as a candidate finding to store (V1; S2 noted none were written). */
export function executionFinding(test: TestOf, run: ScriptRun): CandidateFindingInput {
    const expected = expectationOf(test.spec, run);
    const capture = expected.source ? "captured" : "observed_only";
    const observed = ((run.steps.find((st) => st.status === "failed")?.error ?? run.error ?? "").split("\n")[0] ?? "").trim() || `${test.spec.testId} failed.`;
    return {
        objective: null,
        actions: { stepCount: test.spec.steps.length },
        expected,
        observed,
        evidence: { screenshots: [], requests: run.responses.slice(-20).map((x) => `${x.method} ${x.path} -> ${x.status}`), console: [] },
        capture,
        independence: "not_run",
        confidence: confidenceOf({ sourced: expected.source !== null, capture, independence: "not_run" }),
        fingerprint: executionFingerprint(test.spec.testId, expected),
        modelVersion: null,
        replays: [],
    };
}

/**
 * A stored candidate finding: an exploration finding, or (its fingerprint says so, executionFingerprint) a failed run of an ordinary test
 * or layer check. Recorded attempts (slot 71) win; else the detection and the engine's own replays.
 */
export function fromCandidate(r: CandidateFindingRecord, test?: TestOf): FindingView {
    const f = r.finding;
    const execution = test !== undefined && r.fingerprint === executionFingerprint(test.spec.testId, f.expected);
    const layer = execution ? str(test.meta?.layer) : undefined;
    const recorded = r.attempts.map((a) => AttemptSchema.safeParse(a)).flatMap((p) => (p.success ? [p.data] : []));
    const attempts: FindingViewInput["attempts"] = recorded.length
        ? recorded
        : [
              // The detection itself; what the page showed is `observed`, not an error text the rules read.
              ...(f.capture === "captured" ? [{ outcome: "failed" as const }] : []),
              ...f.replays.map((p) => ({ outcome: p.outcome, ...(p.failedStep ? { failedStep: p.failedStep } : {}), error: p.summary })),
          ];
    return FindingViewSchema.parse({
        id: r.id,
        projectId: r.projectId,
        source: { kind: execution ? (layer ? "layer" : "execution") : "exploration", id: r.id },
        state: r.state,
        title: test?.title ?? f.expected.text,
        testId: r.testId,
        detectedAt: r.firstSeenAt,
        expected: { text: f.expected.text, source: f.expected.source, stated: f.expected.source ? "explicit" : execution && f.expected.text ? "inferred" : "none" },
        observed: f.observed,
        steps: stepsOf(test?.spec),
        attempts: attempts.slice(0, 6),
        requirements: (test?.spec.source.requirements ?? []).slice(0, 20),
        ...(test ? { priority: test.spec.priority } : {}),
        capture: f.capture,
        independence: f.independence,
        confidence: f.confidence,
        ...(layer ? { layer } : {}),
        ...(execution && test ? { origin: test.spec.source.origin } : {}),
    } satisfies FindingViewInput);
}

/** One run of a test as an attempt: where it stopped, the failing check, and whether the failure is the test's own step. */
export function attemptOf(run: ScriptRun, spec: TestSpec): Attempt {
    const outcome = run.status === "passed" ? "passed" : run.status === "error" ? "error" : "failed";
    const at = run.failedStepIndex >= 0 ? run.failedStepIndex : undefined;
    const step = at === undefined ? undefined : spec.steps[at];
    const error = (run.steps.find((s) => s.status === "failed")?.error ?? run.error ?? "").split("\n").slice(0, 6).join("\n");
    const fault = outcome === "failed" ? testStepFault(run, step) : undefined;
    const value = step ? field(step, "expected") : undefined;
    return AttemptSchema.parse({
        outcome,
        ...(at !== undefined ? { failedStep: at + 1 } : {}),
        ...(step && str(field(step, "check")) ? { check: field(step, "check") } : {}),
        ...(step && targetOf(step) ? { target: targetOf(step) } : {}),
        ...(typeof value === "string" || typeof value === "number" ? { value: String(value) } : {}),
        ...(error ? { error } : {}),
        ...(fault ? { stepFault: fault } : {}),
        // An API test's responses are its application's own answers.
        requests: run.responses.slice(-20).map((x) => ({ method: x.method, path: x.path, status: x.status, own: true })),
    });
}

/**
 * A failed test run, with its later attempts: an ordinary test (`execution`) or a Phase 4 layer check (`layer`, from the test's meta).
 * The expectation is the failing check's own source when it names one, else the test's written expected results (the planner's).
 */
export function fromExecution(x: { id: string; projectId: string; test: TestOf; runs: readonly ScriptRun[]; state?: FindingState; detectedAt: string }): FindingView {
    const { spec } = x.test;
    const layer = str(x.test.meta?.layer);
    const first = x.runs.find((r) => r.status !== "passed") ?? x.runs[0];
    const failing = first && first.failedStepIndex >= 0 ? spec.steps[first.failedStepIndex] : undefined;
    const source = failing ? str(field(failing, "source")) : undefined;
    const written = spec.expectedResults.join(" ");
    return FindingViewSchema.parse({
        id: x.id,
        projectId: x.projectId,
        source: { kind: layer ? "layer" : "execution", id: x.test.id },
        state: x.state ?? "detected",
        title: x.test.title,
        testId: x.test.id,
        detectedAt: x.detectedAt,
        expected: { text: written, source: source ?? null, stated: source ? "explicit" : written ? "inferred" : "none" },
        observed: ((first?.steps.find((st) => st.status === "failed")?.error ?? first?.error ?? "").split("\n")[0] ?? "").trim(),
        steps: stepsOf(spec),
        attempts: x.runs.slice(0, 6).map((r) => attemptOf(r, spec)),
        requirements: (spec.source.requirements ?? []).slice(0, 20),
        priority: spec.priority,
        ...(layer ? { layer } : {}),
        origin: spec.source.origin,
    } satisfies FindingViewInput);
}

/** A security finding, read only: its own state kept as `sourceState`, mapped into the lifecycle's words. */
export function fromSecurity(f: SecurityFinding & { checkId?: string | null }): FindingView {
    return FindingViewSchema.parse({
        id: f.id,
        projectId: f.projectId,
        source: { kind: "security", id: f.id },
        sourceState: f.validation,
        state: SECURITY_STATE[f.validation],
        title: f.title,
        testId: null,
        detectedAt: f.firstSeenAt,
        expected: { text: f.remediation, source: f.checkId ?? `security:${f.category}`, stated: "explicit" },
        observed: f.description,
        steps: [],
        attempts: [],
        security: { severity: f.severity, category: f.category, confidence: f.confidence },
    } satisfies FindingViewInput);
}
