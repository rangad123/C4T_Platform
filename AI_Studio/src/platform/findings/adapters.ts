/**
 * Findings of every source read as one view (testing-engine Phase 5 S2, spec §5.1 item 1, owner's H2 and Q3): a stored candidate finding
 * (exploration, slot 67/71), a failed run of an ordinary test or of a Phase 4 layer check (test meta `layer`), and a security finding
 * (security_findings, which keeps its own states: they are mapped here and never written back). Each adapter ends in
 * FindingViewSchema.parse, the boundary that redacts and cuts free text.
 */
import { confidenceOf, findingFingerprint, type CandidateFindingInput } from "../../engine/explore/finding.js";
import { AttemptSchema, FindingViewSchema, type Attempt, type FindingView, type FindingViewInput } from "../../engine/findings/view.js";
import { HIDDEN, redactText } from "../../shared/redact-text.js";
import type { FindingState } from "../../engine/findings/lifecycle.js";
import type { TestSpec } from "../../engine/spec/schema.js";
import { testStepFault } from "../../engine/validation/test-fault.js";
import { testAccountLane } from "../../engine/validation/lanes.js";
import { namesASecret } from "../../engine/evidence/secret-policy.js";
import type { ScriptRun } from "../../engine/validation/runner.js";
import type { SecurityFinding, ValidationState } from "../../security/contract.js";
import type { CandidateFindingRecord } from "../candidate-finding-store.js";
import type { Evidence } from "../../engine/evidence/model.js";

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
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
/** A value with every secret-named key's value hidden ({{placeholders}} stay: they hold no value). */
const hideSecrets = (v: unknown, key = ""): unknown =>
    key && namesASecret(key) && !(typeof v === "string" && /^\{\{[^}]+\}\}$/.test(v.trim()))
        ? HIDDEN
        : Array.isArray(v)
          ? v.map((x) => hideSecrets(x))
          : v && typeof v === "object"
            ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hideSecrets(x, k)]))
            : v;
/** A step's typed or expected value as the report shows it: hidden when the field it goes into names a secret. */
const valueOf = (s: Step): string | undefined => {
    const v = field(s, "value") ?? field(s, "expected");
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return undefined;
    return String(hideSecrets(String(v), targetOf(s) ?? ""));
};
/** The saved test's steps with what a developer needs to repeat them: a request's method and body, a step's value (V10 gap 3). */
const stepsOf = (spec: TestSpec | undefined): FindingViewInput["steps"] =>
    (spec?.steps ?? []).slice(0, 500).map((s) => {
        const body = field(s, "body");
        const method = str(field(s, "method"));
        const value = valueOf(s);
        return {
            action: s.action,
            ...(targetOf(s) ? { target: targetOf(s) } : {}),
            ...(typeof field(s, "url") === "string" ? { url: field(s, "url") as string } : {}),
            ...(method ? { method: method.slice(0, 10) } : {}),
            ...(body !== undefined ? { body: JSON.stringify(hideSecrets(body)) } : {}),
            ...(value !== undefined ? { value } : {}),
        };
    });

/**
 * Who the test signs in as (V10 gap 4), in words: an access check's own account (its settings' `as`), a named account, the project's
 * test account, or no one. Names only: user names are often e-mail addresses, which stored text hides.
 */
export function accountOf(spec: TestSpec): string {
    for (const s of spec.steps) {
        if (field(s, "check") !== "accessDenied") continue;
        let cfg: { as?: unknown; by?: unknown } = {};
        try {
            cfg = JSON.parse(String(field(s, "expected")));
        } catch {
            /* not settings: read the steps as any test */
        }
        if (typeof cfg.as === "string") return `the “${cfg.as}” test account${typeof cfg.by === "string" && cfg.by !== cfg.as ? `, and the “${cfg.by}” test account` : ""}`;
    }
    const lane = testAccountLane({ spec }) ?? (spec.steps.some((s) => s.action === "request" && field(s, "auth") === "default") ? "main" : undefined);
    if (lane) return lane === "main" ? "the project's test account" : `the “${lane.slice(5)}” test account`;
    return spec.steps.some((s) => s.action === "request" && /regist|sign-?up/i.test(String(field(s, "path") ?? ""))) ? "an account the test registers itself" : "no account (signed out)";
}

/**
 * The line of a failure that says what differed (V10 gap 2), not the assertion's own words: Playwright's Expected/Received pair as
 * "Expected 409, got 200", else a check's first "- [severity] …" detail ("response.total: expected integer, got string"), else the first line.
 */
export function headlineOf(error: string): string {
    const lines = error.split("\n").map((l) => l.trim()).filter(Boolean);
    const first = (re: RegExp) => lines.map((l) => re.exec(l)?.[1]?.trim()).find((x) => x);
    const want = first(/^Expected(?: [a-z]+)?:\s*(.+)$/);
    const got = first(/^Received(?: [a-z]+)?:\s*(.+)$/);
    if (want && got) return `Expected ${want}, got ${got}`;
    return first(/^- \[[a-z]+\]\s*(.+)$/) ?? lines[0] ?? "";
}

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
    // The first line only: the run's secrets are not known here, and a headline can quote a value (fromCandidate makes it from the
    // verification attempts, which are masked).
    const observed = ((run.steps.find((st) => st.status === "failed")?.error ?? run.error ?? "").split("\n")[0] ?? "").trim() || `${test.spec.testId} failed.`;
    // A stored-data check failing after the API accepted its write (the last answer is the read-back): the API and the stored data disagree.
    const write = run.responses.findLast((r) => r.method.toUpperCase() !== "GET");
    const readBack = test.meta?.layer === "storedData" && write && write.status >= 200 && write.status < 300 && run.responses.at(-1)?.method.toUpperCase() === "GET";
    return {
        objective: null,
        actions: { stepCount: test.spec.steps.length },
        expected,
        observed,
        evidence: {
            screenshots: [],
            requests: run.responses.slice(-20).map((x) => `${x.method} ${x.path} -> ${x.status}`),
            console: [],
            ...(readBack ? { layers: [{ layer: "api" as const, observed: `${write.method} ${write.path} answered ${write.status}` }, { layer: "stored data" as const, observed }] } : {}),
        },
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
/** `tried`: the attempts a verification is judging now (not yet stored on `r`): the expectation is read from them (failingExpectation). */
export function fromCandidate(r: CandidateFindingRecord, test?: TestOf, tried?: readonly Attempt[]): FindingView {
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
    // An execution finding stores the first line of its error; the attempts carry it in full (masked), so the headline comes from them.
    const error = recorded.find((a) => a.outcome === "failed" && a.error)?.error;
    const observed = error && error.split("\n")[0]!.trim() === f.observed.trim() ? headlineOf(error) : f.observed;
    const expected = failingExpectation(f.expected, test?.spec, tried ?? recorded);
    return FindingViewSchema.parse({
        id: r.id,
        projectId: r.projectId,
        source: { kind: execution ? (layer ? "layer" : "execution") : "exploration", id: r.id },
        state: r.state,
        title: test?.title ?? f.expected.text,
        testId: r.testId,
        detectedAt: r.firstSeenAt,
        expected: { text: expected.text, source: expected.source, stated: expected.source ? "explicit" : execution && expected.text ? "inferred" : "none" },
        observed,
        steps: stepsOf(test?.spec),
        ...(test ? { account: accountOf(test.spec) } : {}),
        attempts: attempts.slice(0, 6),
        requirements: (test?.spec.source.requirements ?? []).slice(0, 20),
        ...(test ? { priority: test.spec.priority } : {}),
        // The attempts captured the failing sourced check (failingExpectation took its source).
        capture: expected.source !== null && f.expected.source === null ? "captured" : f.capture,
        independence: f.independence,
        confidence: f.confidence,
        ...(layer ? { layer } : {}),
        ...(execution && test ? { origin: test.spec.source.origin } : {}),
        ...(f.evidence.layers?.length ? { correlated: { disagreed: f.evidence.layers.map((l) => l.layer) } } : {}),
    } satisfies FindingViewInput);
}

/**
 * The expectation the attempts' failing check names (V10 R10): a check of `expected:<n>` quotes that expected result, not the one the
 * finding was first stored with (another check of the same test, which passed). A finding stored from a check with no source (a database
 * key check that ran first, lane M: re-check shop API-015, API-069) whose attempts fail at a sourced check takes that check's source.
 * Anything else stays as stored.
 */
function failingExpectation(stored: { text: string; source: string | null }, spec: TestSpec | undefined, attempts: readonly Attempt[]): { text: string; source: string | null } {
    const at = attempts.find((a) => a.outcome === "failed" && a.failedStep !== undefined)?.failedStep;
    const source = spec && at !== undefined ? str(field(spec.steps[at - 1] ?? ({} as Step), "source")) : undefined;
    const n = /^expected:(\d+)$/.exec(source ?? "")?.[1];
    const text = n ? spec!.expectedResults[Number(n) - 1] : undefined;
    if (text && source !== stored.source) return { text, source: source! };
    return source && stored.source === null ? { text: stored.text, source } : stored;
}

/** "Request: PUT /api/notes/n3 {…} -> HTTP 200": a request an access check sent itself (identity/access.ts, identity-writes.ts). */
const SENT = /^Request: ([A-Z]{3,7}) (\/\S*)(?: (.+?))? -> HTTP (\d{1,3})$/gm;
const sentIn = (error: string) =>
    [...error.matchAll(SENT)].map((m) => ({ method: m[1]!, path: m[2]!, status: Number(m[4]) >= 100 && Number(m[4]) <= 599 ? Number(m[4]) : null, own: true, ...(m[3] ? { body: m[3] } : {}) }));

/** One run of a test as an attempt: where it stopped, the failing check, and whether the failure is the test's own step. */
export function attemptOf(run: ScriptRun, spec: TestSpec): Attempt {
    // A run that skipped itself never ran its checks: it is no failure of the application (V10 R7, R9: an access write without its gate).
    if (run.status === "skipped") return AttemptSchema.parse({ outcome: "error", environment: `The attempt did not run: the test skipped itself${run.error ? ` (${run.error.split("\n")[0]})` : ""}.` });
    const outcome = run.status === "passed" ? "passed" : run.status === "error" ? "error" : "failed";
    const at = run.failedStepIndex >= 0 ? run.failedStepIndex : undefined;
    const step = at === undefined ? undefined : spec.steps[at];
    const full = run.steps.find((s) => s.status === "failed")?.error ?? run.error ?? "";
    const error = full.split("\n").slice(0, 6).join("\n");
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
        requests: [...run.responses.map((x) => ({ method: x.method, path: x.path, status: x.status, own: true })), ...sentIn(full)].slice(-20),
    });
}

/** Requests of these kinds are the application's work (a page, a form sent, a call), not files the page loads. */
const WORK_TYPES = new Set(["document", "fetch", "xhr"]);

/**
 * A web attempt with the requests its failing step made, from the run's evidence (V7: a page finding's root cause maps them to their
 * handlers): the failing step's own requests, else those of the nearest earlier step that made any (a check after the click it checks).
 * An attempt that already has requests (an API test's answers), or a run without evidence, is left as it is.
 */
export function withStepRequests(a: Attempt, ev: Pick<Evidence, "requests"> | undefined): Attempt {
    if (a.requests.length || !ev || a.failedStep === undefined) return a;
    const work = ev.requests.filter((r) => WORK_TYPES.has(r.type) && r.step <= a.failedStep!);
    const step = work.reduce((m, r) => Math.max(m, r.step), -1);
    if (step < 0) return a;
    const requests = work
        .filter((r) => r.step === step)
        .slice(-20)
        .map((r) => ({ method: r.method, path: r.path, status: r.status !== undefined && r.status <= 599 ? r.status : null, own: !r.host }));
    return AttemptSchema.parse({ ...a, requests });
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
        observed: headlineOf(first?.steps.find((st) => st.status === "failed")?.error ?? first?.error ?? ""),
        steps: stepsOf(spec),
        account: accountOf(spec),
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
