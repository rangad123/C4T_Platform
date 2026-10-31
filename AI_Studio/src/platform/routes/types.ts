import type { FastifyInstance } from "fastify";
import type { Platform } from "../bootstrap.js";
import type { JobRow, Repo } from "../repo.js";
import type { Row } from "../db.js";

/** Everything a feature's route module needs from the core server (kept small and stable on purpose). */
export interface RouteCtx {
    app: FastifyInstance;
    p: Platform;
    repo: Repo;
    /** The project row, or an HTTP 404. */
    project(id: string): Row;
    /** Throws an HTTP 409 if the project already has a job running. Call right before creating a job. */
    assertNoActiveJob(projectId: string): Promise<void>;
    /** The application a validation job runs against (creates one when a URL/credentials/mobile target is given). */
    applicationFor(projectId: string, baseUrl?: string): Promise<{ id: string; url: string }>;
    /** Queue a validation-only job for existing tests. */
    startValidationJob(projectId: string, applicationId: string, testIds: string[]): Promise<JobRow>;
    /** The public (API) shape of a job. */
    publicJob(job: JobRow): Record<string, unknown>;
    /** The test detail answer of GET /api/tests/:id (throws a 404 HttpError for an unknown id). */
    testDetail(testId: string): Record<string, unknown>;
}
