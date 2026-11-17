/**
 * Candidate findings (testing-engine Phase 3, candidate-finding-store.ts): what exploration found, as candidates for a person to
 * review. Reading needs access to the project (auth/roles.ts); nothing here changes a finding, and none is ever "confirmed" in Phase 3.
 *
 *   GET /api/projects/:id/candidate-findings?job=   → { findings: [CandidateFindingRecord] }, newest seen first; `job`: that run's
 *                                                     (found first or last). Another project's run answers 404.
 */
import { CandidateFindingStore } from "../candidate-finding-store.js";
import { HttpError } from "../http-error.js";
import type { RouteCtx } from "./types.js";

export function registerExploreFindingRoutes(ctx: RouteCtx): void {
    const { app, p, repo } = ctx;
    const store = new CandidateFindingStore(p.sql);

    app.get("/api/projects/:id/candidate-findings", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const q = req.query as { job?: unknown };
        const job = typeof q.job === "string" && q.job !== "" ? q.job : undefined;
        if (job !== undefined && repo.getJob(job)?.projectId !== id) throw new HttpError(404, "Run not found");
        return { findings: await store.list(id, job ? { jobId: job } : {}) };
    });
}
