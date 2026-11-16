import { z } from "zod";
import { HttpError } from "../http-error.js";
import { parsePlain } from "./project-settings.js";
import type { RouteCtx } from "./types.js";

/**
 * Renaming, deleting and ordering a project's test scripts (the Test scripts list and a script's own page):
 *
 *   PATCH  /api/tests/:id                  { title }      → { id, title }       ai_studio.tests.write
 *   DELETE /api/tests/:id                                 → { deleted: true }   ai_studio.tests.delete
 *   PUT    /api/projects/:id/tests/order    { testIds }    → { testIds }         ai_studio.tests.write
 *
 * A name is not a step, so renaming makes no new version to review. Deleting takes the script's runs, history, versions, links and
 * places in suites with it, and is refused while it runs. The order names every script of the project once; it is what the list, the
 * review list and "run all" follow (Repo.listTests), and a script made later goes to the end.
 */

export const TITLE_MIN = 3;
export const TITLE_MAX = 200;
export const TITLE_TOO_SHORT = `A script needs a name of at least ${TITLE_MIN} characters.`;
export const TITLE_TOO_LONG = `A script name is at most ${TITLE_MAX} characters.`;
export const DELETE_WHILE_RUNNING = "This script is running now. Delete it when the run has finished.";
export const ORDER_OUT_OF_DATE = "The scripts changed since this list was loaded. Reload the list and try again.";

const RenameBody = z
    .object({
        title: z
            .string({ error: TITLE_TOO_SHORT })
            .transform((s) => s.trim())
            .pipe(z.string().min(TITLE_MIN, TITLE_TOO_SHORT).max(TITLE_MAX, TITLE_TOO_LONG)),
    })
    .strict();

const OrderBody = z
    .object({
        testIds: z
            .array(z.string().min(1).max(100))
            .max(5000)
            .refine((ids) => new Set(ids).size === ids.length, "Each script can be in the order once."),
    })
    .strict();

export function registerTestManageRoutes(ctx: RouteCtx): void {
    const { app, repo } = ctx;
    const testOf = (id: string) => {
        const t = repo.getTest(id);
        if (!t) throw new HttpError(404, "Test not found");
        return t;
    };

    app.patch("/api/tests/:id", async (req) => {
        const t = testOf((req.params as { id: string }).id);
        const { title } = parsePlain(RenameBody, req.body);
        repo.renameTest(t.id, title);
        return { id: t.id, title };
    });

    app.delete("/api/tests/:id", async (req) => {
        const t = testOf((req.params as { id: string }).id);
        if (t.validationStatus === "VALIDATING") throw new HttpError(409, DELETE_WHILE_RUNNING);
        const files = repo.deleteTest(t.id);
        // The saved screenshots, videos and traces go too; a file that cannot be removed now is left for retention, not a failed delete.
        for (const key of files) await ctx.p.store.delete(key).catch(() => undefined);
        return { deleted: true };
    });

    app.put("/api/projects/:id/tests/order", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const { testIds } = parsePlain(OrderBody, req.body);
        // Another project's script, or none at all, reads as unknown.
        for (const x of testIds) if (repo.getTest(x)?.projectId !== id) throw new HttpError(404, "Test not found");
        if (!repo.orderTests(id, testIds)) throw new HttpError(409, ORDER_OUT_OF_DATE);
        return { testIds: repo.listTests(id).map((t) => t.id) };
    });
}
