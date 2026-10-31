/**
 * Reads a failed run's stored evidence and turns it into what the API, the issue text and the report show. Everything is
 * computed from the stored (already redacted) file when asked for; nothing is stored here. The file is parsed and masked
 * again on the way out, so even a file edited on disk cannot put an unmasked pattern into an answer.
 */
import { highlights, stepNumber, summarize, type EvidenceHighlights, type EvidenceSummary } from "../engine/evidence/summary.js";
import { parseEvidence, type Evidence } from "../engine/evidence/model.js";
import { prunedMessage } from "../engine/retention/format.js";
import type { Repo } from "./repo.js";
import type { ArtifactStore } from "./storage.js";

interface StoredExecution {
    id: string;
    status: string;
    startedAt: string;
    steps: Array<{ index: number; status: string }>;
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
        return { available: false, execution, message: "No network or console details were recorded for this run. Runs made before this was added do not have them. Run the test again to capture them." };
    }
    // The retention policy may have removed the file to save space; say that, not "could not be read".
    if (artifact.pruned_at) return { available: false, execution, message: prunedMessage("evidence", artifact.pruned_at) };
    let evidence: Evidence | undefined;
    try {
        evidence = parseEvidence((await store.getBytes(artifact.path)).toString("utf8"));
    } catch {
        /* the file is gone */
    }
    if (!evidence) return { available: false, execution, message: "The recorded details for this run could not be read." };
    return { available: true, execution, artifactId: artifact.id, evidence, summary: summarize(evidence, execution.failedStep), highlights: highlights(evidence, execution.failedStep) };
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
