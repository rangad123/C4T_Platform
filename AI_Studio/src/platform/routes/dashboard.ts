import { z } from "zod";
import { actorOf } from "../auth/access.js";
import { visibleProjectsOf } from "../auth/project-scope.js";
import { buildDashboard, READINESS_STATES } from "../dashboard.js";
import type { RouteCtx } from "./types.js";

const Query = z.object({
    state: z.enum(READINESS_STATES as [string, ...string[]]).optional(),
    q: z.string().max(120).optional(),
});

/**
 * Cross-project dashboard. Read-only: starts no job, calls no model and never contacts a target; it only reads what
 * the platform has already stored. Behind the same API key as every other /api route.
 */
export function registerDashboardRoutes({ app, p }: RouteCtx): void {
    app.get("/api/dashboard", async (req) => {
        const q = Query.parse(req.query);
        // Only the projects the caller may see (a person limited to some projects; auth/project-scope.ts).
        const visible = visibleProjectsOf(req, actorOf(req));
        return buildDashboard(p.db, { state: q.state as never, q: q.q, ...(visible ? { projectIds: visible } : {}) });
    });
}
