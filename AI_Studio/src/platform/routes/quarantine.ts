import { z } from "zod";
import { MAX_BY, MAX_DAYS, MAX_REASON } from "../../engine/quarantine/rules.js";
import { HttpError } from "../http-error.js";
import { projectView, quarantineTest, suggestionsFor, testView, viewEntry } from "../quarantine-service.js";
import { QuarantineStore, quarantineGate } from "../quarantine-store.js";
import type { RouteCtx } from "./types.js";

/**
 * Flaky-test quarantine.
 *
 *   GET   /api/projects/:id/quarantine                 what is in quarantine, what ended, suggestions, limits
 *   GET   /api/projects/:id/quarantine/suggestions     flaky tests that may be quarantined, with their evidence
 *   POST  /api/projects/:id/quarantine                 { testId, reason?, days?, by, suggested? }  409 with a plain reason when not eligible
 *   POST  /api/projects/:id/quarantine/:qid/release    { by, note? }
 *   POST  /api/projects/:id/quarantine/:qid/review     { by, extendDays?, note? }
 *   GET   /api/projects/:id/quarantine/history?testId  append-only trail, newest first
 *   GET   /api/tests/:id/quarantine                    one test: its quarantine, whether it may be quarantined, its history
 *
 * Every lookup is by project and id together. Nothing is ever quarantined automatically.
 */
const By = z.string({ required_error: "Your name is required", invalid_type_error: "Your name must be text" }).trim().min(1, "Your name is required").max(MAX_BY, `Your name can be at most ${MAX_BY} characters`);
const Note = z.string().trim().max(MAX_REASON, `The note can be at most ${MAX_REASON} characters`).optional();

const QuarantineBody = z.object({
    testId: z.string().min(1),
    reason: z.string().trim().max(MAX_REASON, `The reason can be at most ${MAX_REASON} characters`).optional(),
    days: z.number().int().min(1, "Days must be at least 1").max(MAX_DAYS, `Days can be at most ${MAX_DAYS}`).optional(),
    by: By,
    suggested: z.boolean().optional(),
});
const ReleaseBody = z.object({ by: By, note: Note });
const ReviewBody = z.object({ by: By, extendDays: z.number().int().min(1).max(MAX_DAYS).optional(), note: Note });

export function registerQuarantineRoutes(ctx: RouteCtx): void {
    const { app, p, repo } = ctx;
    const store = new QuarantineStore(p.db);

    const entryOf = (projectId: string, qid: string) => {
        const e = store.get(qid);
        if (!e || e.projectId !== projectId) throw new HttpError(404, "Quarantine not found");
        return e;
    };

    app.get("/api/projects/:id/quarantine", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        return projectView(repo, store, id, Date.now());
    });

    app.get("/api/projects/:id/quarantine/suggestions", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        return { suggestions: suggestionsFor(repo, store, id) };
    });

    app.post("/api/projects/:id/quarantine", async (req, reply) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const body = QuarantineBody.parse(req.body ?? {});
        const entry = quarantineTest(repo, store, id, body);
        return reply.code(201).send(viewEntry(repo, entry, quarantineGate(p.db, Date.now(), id), Date.now()));
    });

    app.post("/api/projects/:id/quarantine/:qid/release", async (req) => {
        const { id, qid } = req.params as { id: string; qid: string };
        ctx.project(id);
        entryOf(id, qid);
        const body = ReleaseBody.parse(req.body ?? {});
        const done = store.release(qid, body.by, body.note ?? "");
        return viewEntry(repo, done, quarantineGate(p.db, Date.now(), id), Date.now());
    });

    app.post("/api/projects/:id/quarantine/:qid/review", async (req) => {
        const { id, qid } = req.params as { id: string; qid: string };
        ctx.project(id);
        entryOf(id, qid);
        const body = ReviewBody.parse(req.body ?? {});
        const done = store.review(qid, body.by, body.extendDays, body.note ?? "");
        return viewEntry(repo, done, quarantineGate(p.db, Date.now(), id), Date.now());
    });

    app.get("/api/projects/:id/quarantine/history", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const q = z.object({ testId: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.query);
        return { history: store.history(id, q) };
    });

    app.get("/api/tests/:id/quarantine", async (req) => {
        const { id } = req.params as { id: string };
        const test = repo.getTest(id);
        if (!test) throw new HttpError(404, "Test not found");
        return testView(repo, store, test, Date.now());
    });
}
