import { HttpError } from "../http-error.js";
import { projectSlowest, testHistory } from "../perf-store.js";
import type { RouteCtx } from "./types.js";

/** Routes for the "performance" feature: the measured page-speed values and their history. */
export function registerPerformanceRoutes({ app, p, repo, project }: RouteCtx): void {
    app.get("/api/tests/:id/performance", async (req) => {
        const t = repo.getTest((req.params as { id: string }).id);
        if (!t) throw new HttpError(404, "Test not found");
        return testHistory(p.sql, t.id);
    });

    app.get("/api/projects/:id/performance", async (req) => {
        const id = (req.params as { id: string }).id;
        project(id);
        return { slowest: await projectSlowest(p.sql, id) };
    });
}
