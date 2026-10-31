import { forgetMemory, latestMemory } from "../memory-store.js";
import type { RouteCtx } from "./types.js";

/** Routes for the "memory" feature: what the platform remembers about a project's application, and how to forget it. */
export function registerMemoryRoutes({ app, repo, project }: RouteCtx): void {
    /**
     * A summary of what is remembered plus what changed in the latest analysis. Structural facts only: no content
     * fingerprints and nothing that could be page text or user data (none is ever stored).
     */
    app.get("/api/projects/:id/memory", async (req) => {
        const id = (req.params as { id: string }).id;
        project(id);
        const m = latestMemory(repo.db, id);
        if (!m) return { remembered: false, message: "Nothing has been learned about this application yet. The first analysis saves notes that the next one starts from." };
        const k = m.knowledge;
        return {
            remembered: true,
            updatedAt: m.updatedAt,
            analysedAt: k.analysedAt,
            origin: k.origin,
            siteType: k.siteType,
            purpose: k.purpose,
            learned: k.learned,
            loginPath: k.loginPath ?? null,
            counts: { pages: k.pages.length, journeys: k.journeys.length, endpoints: k.apis.length, journeysWithValidatedTests: k.journeys.filter((j) => j.validated.length > 0).length },
            pages: k.pages.slice(0, 100).map((p) => ({ path: p.path, type: p.type, title: p.title })),
            journeys: k.journeys.map((j) => ({ name: j.name, priority: j.priority, validatedTests: j.validated.length })),
            /** Null after the first analysis (nothing to compare with yet). */
            changes: m.changes,
        };
    });

    /** "Forget what we learned": the next analysis starts from scratch (and saves new notes unless it is told not to). */
    app.delete("/api/projects/:id/memory", async (req) => {
        const id = (req.params as { id: string }).id;
        project(id);
        return { forgotten: forgetMemory(repo.db, id) > 0 };
    });
}
