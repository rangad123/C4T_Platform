/**
 * Where a job keeps how its objective-driven exploration went (testing-engine Phase 3): the engine's `summary.exploration`
 * (orchestrator.ts), as one JSON artifact of the job, saved when the exploration ends. GET /api/projects/:id/jobs/:jobId/coverage
 * (routes/explore-findings.ts) reads it back. The action log in it is already capped (ACTION_LOG_CAP).
 */
import type { ExplorationSummary, GenerationSink } from "../engine/orchestrator.js";
import type { Repo } from "./repo.js";
import type { ArtifactStore } from "./storage.js";

export const EXPLORATION_ARTIFACT = "exploration";
export const EXPLORATION_FILE = "exploration.json";

export async function saveExploration(sink: Pick<GenerationSink, "saveTextArtifact">, exploration: ExplorationSummary): Promise<void> {
    await sink.saveTextArtifact(EXPLORATION_ARTIFACT, EXPLORATION_FILE, JSON.stringify(exploration));
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
