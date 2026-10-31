import { z } from "zod";
import { evidenceView } from "../evidence-read.js";
import { HttpError } from "../http-error.js";
import type { RouteCtx } from "./types.js";

/**
 * Failure evidence routes (Builder V).
 *   GET /api/tests/:id/evidence[?executionId=...]  what the page did during the latest failed run: its network calls and console
 *   lines (already redacted when stored), a plain-language summary and the entries that most likely matter. A test or run without
 *   evidence is a normal 200 answer with `available: false` and a message, because that is the usual case for old runs.
 */
export function registerEvidenceRoutes(ctx: RouteCtx): void {
    const { app, repo, p } = ctx;

    app.get("/api/tests/:id/evidence", async (req) => {
        const { id } = req.params as { id: string };
        const { executionId } = z.object({ executionId: z.string().min(1).max(100).optional() }).parse(req.query ?? {});
        if (!repo.getTest(id)) throw new HttpError(404, "Test not found");
        const view = await evidenceView(repo, p.store, id, executionId);
        if (!view) throw new HttpError(404, "Run not found for this test");
        return view;
    });
}
