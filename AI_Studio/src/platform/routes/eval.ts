import { z } from "zod";
import { EvalRunSchema, MAX_RUN_BYTES } from "../../eval/run.js";
import { EvalStore } from "../eval-store.js";
import { HttpError } from "../http-error.js";
import type { RouteCtx } from "./types.js";

/**
 * Evaluation runs (Settings, Quality). The harness (`node scripts/eval.mjs`, see docs/features/evaluation.md) measures the AI tester on a
 * corpus of real apps and sends each finished run here so the history and the comparison with the previous run can be seen.
 *
 *   GET    /api/eval/runs              the newest runs (overall numbers), each compared with the run before it
 *   GET    /api/eval/runs/:id          one run: every entry, its tests, and the comparison (overall and per entry)
 *   POST   /api/eval/runs              keep a run the harness wrote (validated, at most 4 MB)
 *   DELETE /api/eval/runs/:id          forget one run
 * The projects a run created are normal projects; nothing here touches them.
 */

const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).strict();
const Id = z.string().uuid("Unknown evaluation run");

export function registerEvalRoutes(ctx: RouteCtx): void {
    const { app, p } = ctx;
    const store = () => new EvalStore(p.db);

    app.get("/api/eval/runs", async (req) => {
        const q = ListQuery.parse(req.query ?? {});
        const s = store();
        return { runs: s.list(q.limit).map((r) => ({ ...r, comparison: s.compare(r) })) };
    });

    app.get("/api/eval/runs/:id", async (req) => {
        const parsed = Id.safeParse((req.params as { id: string }).id);
        if (!parsed.success) throw new HttpError(404, "Evaluation run not found");
        const s = store();
        const found = s.get(parsed.data);
        if (!found) throw new HttpError(404, "Evaluation run not found");
        return { ...found.summary, run: found.run, comparison: s.compare(found.summary, found.run) };
    });

    app.post("/api/eval/runs", async (req, reply) => {
        const json = JSON.stringify(req.body ?? null);
        if (Buffer.byteLength(json) > MAX_RUN_BYTES) throw new HttpError(413, `An evaluation run may be at most ${MAX_RUN_BYTES / 1024 / 1024} MB`);
        const run = EvalRunSchema.parse(req.body);
        if (run.finishedAt < run.startedAt) throw new HttpError(400, "“finishedAt” must not be before “startedAt”");
        const s = store();
        const id = s.add(run, JSON.stringify(run));
        const summary = s.get(id)!.summary;
        return reply.code(201).send({ id, comparison: s.compare(summary, run) });
    });

    app.delete("/api/eval/runs/:id", async (req) => {
        const parsed = Id.safeParse((req.params as { id: string }).id);
        if (!parsed.success || !store().delete(parsed.data)) throw new HttpError(404, "Evaluation run not found");
        return { deleted: true };
    });
}
