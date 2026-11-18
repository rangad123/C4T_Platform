/**
 * Continuing a stopped exploration (POST /api/projects/:id/explorations/:jobId/continue, routes/plans.ts) instead of starting it again.
 *
 * - A stopped exploration that stops at a plan keeps a checkpoint as it goes (engine/orchestrator.ts saveCheckpoint): after the crawl, and
 *   after the AI's reading of the application. Continuing starts from the newest one, so pages already crawled are not crawled again and a
 *   finished reading is not asked for again. A stop during the crawl, or during planning, starts that stage again from its beginning: a
 *   crawl's half-built page list and navigation, and a planning call's unfinished answer, are not kept.
 * - A stopped creation (tests being made from a plan) keeps every test it made. Continuing makes only the plan's ideas that have no test
 *   yet, runs the kept tests that have no result yet, and makes no check a second time (engine GenerationRequest.carry).
 */
import { CHECKPOINT_ARTIFACT, type CarriedTest, type ExploreCheckpoint } from "../engine/orchestrator.js";
import type { Scenario } from "../engine/spec/schema.js";
import type { Repo } from "./repo.js";
import type { ArtifactStore } from "./storage.js";

const isCheckpoint = (v: unknown): v is ExploreCheckpoint => {
    const c = v as ExploreCheckpoint | null;
    return !!c && c.version === 1 && (c.stage === "discovered" || c.stage === "understood") && !!c.model && Array.isArray(c.model.pages) && Array.isArray(c.model.apis) && Array.isArray(c.accessReach) && Array.isArray(c.apiAccess);
};

/**
 * The newest checkpoint a stopped exploration can continue from: its own, else (it was itself a continue, stopped before it kept one) the one
 * it continued from, and so on.
 */
export async function loadCheckpoint(repo: Repo, store: ArtifactStore, jobId: string): Promise<ExploreCheckpoint | undefined> {
    let id: string | undefined = jobId;
    for (let i = 0; id && i < 20; i++) {
        const own = await ownCheckpoint(repo, store, id);
        if (own) return own;
        id = repo.getJob(id)?.options.resumeFrom;
    }
    return undefined;
}

async function ownCheckpoint(repo: Repo, store: ArtifactStore, jobId: string): Promise<ExploreCheckpoint | undefined> {
    const row = repo.db.get<{ path: string; pruned_at: string | null }>(`SELECT path, pruned_at FROM artifacts WHERE job_id = ? AND kind = ? ORDER BY created_at DESC, ${repo.db.dialect.insertionOrder()} DESC LIMIT 1`, jobId, CHECKPOINT_ARTIFACT);
    if (!row || row.pruned_at) return undefined;
    try {
        const parsed: unknown = JSON.parse((await store.getBytes(row.path)).toString("utf8"));
        return isCheckpoint(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

/** The test idea a created test was written for (the engine keeps the scenario in its meta and the idea's id in its source). */
export const ideaOfTest = (t: { spec: { source?: { scenarioId?: unknown } }; generationMeta: Record<string, unknown> | null }): string | undefined => {
    const fromMeta = (t.generationMeta?.scenario as { scenarioId?: unknown } | undefined)?.scenarioId;
    const id = fromMeta ?? t.spec.source?.scenarioId;
    return typeof id === "string" && id ? id : undefined;
};

/** Every test the given creations made, as the engine carries them on (repo order: oldest first). Unreadable tests are left out. */
export function carriedTests(repo: Repo, projectId: string, jobIds: readonly string[]): CarriedTest[] {
    const out: CarriedTest[] = [];
    for (const jobId of jobIds) {
        for (const t of repo.listTests(projectId, { jobId })) {
            if (t.unreadable) continue;
            const scenario = ideaOfTest(t) ? (t.generationMeta?.scenario as Scenario | undefined) : undefined;
            out.push({ handle: { id: t.id, testId: t.testKey }, spec: t.spec, framework: t.framework, hasResult: t.validationStatus !== "PENDING" && t.validationStatus !== "VALIDATING", ...(scenario ? { scenario } : {}) });
        }
    }
    return out;
}

/**
 * The plan's ideas the given creations dealt with: written (a test exists) or decided against (the AI found it could not be written, which a
 * second try would decide again). An idea the stop came before, or one left for an AI limit, is neither: a continue writes it.
 */
export function ideasDealtWith(repo: Repo, projectId: string, jobIds: readonly string[]): Set<string> {
    const done = new Set<string>();
    for (const jobId of jobIds) {
        for (const t of repo.listTests(projectId, { jobId })) {
            const id = ideaOfTest(t);
            if (id) done.add(id);
        }
        for (const e of repo.listEvents(jobId, 0, 5000)) {
            if (e.kind !== "scenario_skipped" || !/could not be authored/.test(String(e.message))) continue;
            const id = (e.data as { scenarioId?: unknown } | null)?.scenarioId ?? /^([A-Z]+-\d+)\b/.exec(String(e.message))?.[1];
            if (typeof id === "string") done.add(id);
        }
    }
    return done;
}
