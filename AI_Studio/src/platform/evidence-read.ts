/**
 * Reads a failed run's stored evidence and turns it into what the API, the issue text and the report show. Everything is
 * computed from the stored (already redacted) file when asked for; nothing is stored here. The file is parsed and masked
 * again on the way out, so even a file edited on disk cannot put an unmasked pattern into an answer.
 */
import { highlights, stepNumber, summarize, type EvidenceHighlights, type EvidenceSummary } from "../engine/evidence/summary.js";
import { parseEvidence, type Evidence } from "../engine/evidence/model.js";
import { failureFacts } from "../engine/evidence/failure-facts.js";
import { TestSpecSchema, type Step, type TestSpec } from "../engine/spec/schema.js";
import { prunedMessage } from "../engine/retention/format.js";
import type { Repo } from "./repo.js";
import type { ArtifactStore } from "./storage.js";

interface StoredExecution {
    id: string;
    status: string;
    startedAt: string;
    steps: Array<{ index: number; title?: string; status: string; error?: string | null }>;
    artifacts: Array<{ id: string; kind: string; path: string; pruned_at?: string | null }>;
}

export interface EvidenceView {
    available: boolean;
    /** Why there is nothing to show, in words for a person. */
    message?: string;
    execution?: { id: string; status: string; startedAt: string; /** 1-based number of the step that failed. */ failedStep?: number };
    artifactId?: string;
    summary?: EvidenceSummary;
    highlights?: EvidenceHighlights;
    evidence?: Evidence;
    /** One entry per check the run reached, read from what the run stored (nothing is written). See outcomesOf. */
    outcomes?: StepOutcome[];
    /** A passing run's record: the pages and endpoints it touched (no failure details). */
    footprint?: NonNullable<Evidence["footprint"]>;
}

/**
 * What one check of a run expected and what happened, joined at read time from the steps of the version that ran (test_versions, else the
 * test's current steps), the step results, the expected/actual facts in the error text, the evidence of the same step and the artifacts.
 */
export interface StepOutcome {
    /** 1-based step number, as the run's step titles count. */
    step: number;
    /** Stable within one version of a test: "step-<n>". */
    assertionId: string;
    /** The check the step makes ("visible", "text", "status", ...); undefined when the steps that ran are not known. */
    check?: string;
    expected?: string;
    actual?: string;
    passed: boolean;
    /** Positions in evidence.requests of the requests made during this step. */
    requests: number[];
    /** The run's screenshot, trace and video, for a check that failed. */
    artifacts: Array<{ id: string; kind: string }>;
}

const OUTCOME_ARTIFACTS = new Set(["screenshot", "trace", "video"]);
const show = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v).slice(0, 200));

/** The steps of the version a run ran; undefined when they cannot be read or would not line up with the step numbers (reusable steps). */
function stepsThatRan(repo: Repo, testId: string, executionId: string): Step[] | undefined {
    let spec: TestSpec | undefined;
    try {
        const row = repo.db.get<{ spec_json: string | null }>("SELECT v.spec_json FROM test_executions e JOIN test_versions v ON v.id = e.test_version_id WHERE e.id = ?", executionId);
        if (row?.spec_json) spec = TestSpecSchema.parse(JSON.parse(row.spec_json));
    } catch {
        spec = undefined;
    }
    spec ??= repo.getTest(testId)?.spec;
    if (!spec || spec.steps.some((st) => st.action === "useBlock")) return undefined;
    return spec.steps;
}

/** The checks of one run (assert and assertResponse steps it reached), with expected and actual and their evidence. */
export function outcomesOf(repo: Repo, testId: string, execution: StoredExecution & { artifacts: StoredExecution["artifacts"] }, evidence?: Evidence): StepOutcome[] {
    const steps = stepsThatRan(repo, testId, execution.id);
    const out: StepOutcome[] = [];
    for (const r of execution.steps) {
        const spec = steps?.[r.index];
        const isCheck = spec ? spec.action === "assert" || spec.action === "assertResponse" : /^\d+\.\s+(?:Verify|Check)\b/i.test(r.title ?? "");
        if (!isCheck) continue;
        const n = r.index + 1;
        const passed = r.status !== "failed";
        const facts = passed ? undefined : failureFacts(r.error, spec);
        const declared = spec && (spec.action === "assert" || spec.action === "assertResponse") ? show(spec.expected) : undefined;
        out.push({
            step: n,
            assertionId: `step-${n}`,
            ...(spec && "check" in spec ? { check: String(spec.check) } : {}),
            ...(facts?.expected ?? declared ? { expected: facts?.expected ?? declared } : {}),
            ...(facts?.actual ? { actual: facts.actual } : {}),
            passed,
            requests: evidence ? evidence.requests.flatMap((q, i) => (q.step === n ? [i] : [])) : [],
            artifacts: passed ? [] : execution.artifacts.filter((a) => OUTCOME_ARTIFACTS.has(a.kind) && !a.pruned_at).map((a) => ({ id: a.id, kind: a.kind })),
        });
    }
    return out;
}

export async function evidenceView(repo: Repo, store: ArtifactStore, testId: string, executionId?: string): Promise<EvidenceView | undefined> {
    const test = repo.getTest(testId);
    if (!test) return undefined;
    if (test.kind !== "web") {
        return { available: false, message: "Network calls and console messages are recorded for web tests only." };
    }
    const executions = repo.listExecutions(testId) as unknown as StoredExecution[];
    let chosen: StoredExecution | undefined;
    if (executionId) {
        chosen = executions.find((e) => e.id === executionId);
        if (!chosen) return undefined;
    } else {
        if (executions.length === 0) return { available: false, message: "This test has not been run yet." };
        // The latest run that did not pass and kept evidence; a newer failure without any (old run) is reported as such.
        chosen = executions.find((e) => e.status !== "passed");
        if (!chosen) return { available: false, message: "The latest run passed, so there is no failure to explain." };
    }
    const failedIndex = chosen.steps.find((s) => s.status === "failed")?.index;
    const execution = { id: chosen.id, status: chosen.status, startedAt: chosen.startedAt, ...(stepNumber(failedIndex) ? { failedStep: stepNumber(failedIndex)! } : {}) };
    const artifact = chosen.artifacts.find((a) => a.kind === "evidence");
    if (!artifact) {
        return { available: false, execution, message: "No network or console details were recorded for this run. Runs made before this was added do not have them. Run the test again to capture them.", outcomes: outcomesOf(repo, testId, chosen) };
    }
    // The retention policy may have removed the file when it expired; say that, not "could not be read".
    if (artifact.pruned_at) return { available: false, execution, message: prunedMessage("evidence", artifact.pruned_at) };
    let evidence: Evidence | undefined;
    try {
        evidence = parseEvidence((await store.getBytes(artifact.path)).toString("utf8"));
    } catch {
        /* the file is gone */
    }
    if (!evidence) return { available: false, execution, message: "The recorded details for this run could not be read." };
    // A passing run keeps only its footprint: there is nothing to explain, but what it touched is there for whoever needs it. (Full
    // evidence carries a footprint too; it is shown in full as before.)
    const footprintOnly = evidence.footprint && evidence.requests.length === 0 && evidence.console.length === 0;
    if (footprintOnly && chosen.status === "passed") return { available: false, execution, message: "This run passed: only the pages and endpoints it touched were kept.", footprint: evidence.footprint! };
    return { available: true, execution, artifactId: artifact.id, evidence, summary: summarize(evidence, execution.failedStep), highlights: highlights(evidence, execution.failedStep), outcomes: outcomesOf(repo, testId, chosen, evidence) };
}

/** The one-paragraph summary for an issue or a report; undefined when the latest failure has no evidence. */
export async function evidenceSentence(repo: Repo, store: ArtifactStore, testId: string): Promise<string | undefined> {
    try {
        const v = await evidenceView(repo, store, testId);
        return v?.available ? v.summary?.sentence : undefined;
    } catch {
        return undefined;
    }
}
