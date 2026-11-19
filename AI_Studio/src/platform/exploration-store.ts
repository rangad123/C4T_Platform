/**
 * Where a job keeps how its objective-driven exploration went (testing-engine Phase 3): the engine's `summary.exploration`
 * (orchestrator.ts), as one JSON artifact of the job, saved when the exploration ends. GET /api/projects/:id/jobs/:jobId/coverage
 * (routes/explore-findings.ts) reads it back. The action log in it is already capped (ACTION_LOG_CAP).
 */
import { maskExplorationText } from "../agent-protocol/exploration.js";
import { maskActionLog } from "../engine/explore/action-mask.js";
import type { ExplorationSummary, GenerationSink } from "../engine/orchestrator.js";
import { maskText } from "./redact-text.js";
import type { Repo } from "./repo.js";
import type { ArtifactStore } from "./storage.js";

export const EXPLORATION_ARTIFACT = "exploration";
export const EXPLORATION_FILE = "exploration.json";

/**
 * Stored with its text masked again, whoever wrote the record: the action log (explore/action-mask.ts) and every free-text field (the
 * stop detail, the outcome and skip reasons, the coverage lists' statuses and reasons: an outcome's reason can be an error's raw text,
 * CP3b R-4), with the run's secrets the sink knows and the shared patterns. The engine masks the action log already, and masking twice
 * changes nothing, so a record from a runner that did not mask it is stored masked too.
 */
export async function saveExploration(sink: Pick<GenerationSink, "saveTextArtifact"> & { secretsToMask?(): string[] }, exploration: ExplorationSummary): Promise<void> {
    const secrets = sink.secretsToMask?.() ?? [];
    const text = maskExplorationText(exploration, (t) => maskText(t, secrets));
    await sink.saveTextArtifact(EXPLORATION_ARTIFACT, EXPLORATION_FILE, JSON.stringify({ ...text, actionLog: maskActionLog(exploration.actionLog ?? [], secrets) }));
}

/** The job's exploration summary, or undefined when the job has none (an older job, one that did not explore by objectives, or pruned). */
export async function loadExploration(repo: Repo, store: ArtifactStore, jobId: string): Promise<ExplorationSummary | undefined> {
    const row = repo.db.get<{ path: string; pruned_at: string | null }>(`SELECT path, pruned_at FROM artifacts WHERE job_id = ? AND kind = ? ORDER BY created_at DESC, ${repo.db.dialect.insertionOrder()} DESC LIMIT 1`, jobId, EXPLORATION_ARTIFACT);
    if (!row || row.pruned_at) return undefined;
    try {
        const parsed = JSON.parse((await store.getBytes(row.path)).toString("utf8")) as ExplorationSummary | null;
        return parsed && typeof parsed.stopReason === "string" && Array.isArray(parsed.actionLog) && parsed.coverage ? parsed : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The source refs of the objectives a session explored: an objective one of whose pursuits ran (completed, or stopped by the loop), as
 * the coverage record counts exercised (engine/explore/coverage.ts). Sorted, without repeats.
 */
export function exploredSources(e: Pick<ExplorationSummary, "objectives" | "outcomes">): string[] {
    const ran = new Set(e.outcomes.filter((o) => o.status === "completed" || o.status === "stopped").map((o) => String(o.objectiveId).split(":")[0]));
    return [...new Set(e.objectives.filter((o) => ran.has(o.id)).map((o) => o.source))].sort();
}

/**
 * GenerationRequest.exploredObjectives for a new exploration of the project: what its last exploration by objectives explored. Nothing
 * when the project has no such record (none yet, or pruned): then no objective is marked "not explored yet".
 */
export async function exploredObjectivesOf(repo: Repo, store: ArtifactStore, projectId: string): Promise<{ exploredObjectives?: string[] }> {
    const row = repo.db.get<{ job_id: string }>(`SELECT job_id FROM artifacts WHERE project_id = ? AND kind = ? AND job_id IS NOT NULL AND pruned_at IS NULL ORDER BY created_at DESC, ${repo.db.dialect.insertionOrder()} DESC LIMIT 1`, projectId, EXPLORATION_ARTIFACT);
    const last = row ? await loadExploration(repo, store, row.job_id) : undefined;
    return last && Array.isArray(last.objectives) && Array.isArray(last.outcomes) ? { exploredObjectives: exploredSources(last) } : {};
}
