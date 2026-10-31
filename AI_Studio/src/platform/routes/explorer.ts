import { z } from "zod";
import { jobRanOn, projectRunsOnAgent } from "../agent-services.js";
import { frameHub, watchState, REASONS } from "../frame-hub.js";
import { HttpError } from "../http-error.js";
import type { RouteCtx } from "./types.js";

/**
 * The Explorer view: a picture of the browser the AI is using while it explores an application or builds a test from a sentence.
 *
 *   GET /api/projects/:id/jobs/:jobId/frame[?since=<at>]
 *
 * Answers `{ available, mime: "image/jpeg", watching: true, ... }`:
 *   available true   imageBase64 (a JPEG, at most 640 px wide and 120 KB), url, title, note (one plain line), phase, pagesSeen, at, ageMs
 *                    `?since=<at>` of the picture already held: `{ available: true, unchanged: true, ... }` without the picture
 *   available false  reason (plain words) and why: waiting | nothing | elsewhere | finished | stopping | unavailable
 * Reading this route is what "watching" means: the engine takes pictures for 10 seconds after each read, and none when nobody reads.
 * At most 3 reads a second per job (429). Pictures live in memory only (platform/frame-hub.ts), one per job, and never reach a file, a log, an event
 * or the database. Another project's job is a 404; the API key protects the route like every route under /api.
 */
const Query = z.object({ since: z.string().max(40).optional() }).strict();

export function registerExplorerRoutes(ctx: RouteCtx): void {
    const { app, repo } = ctx;

    app.get("/api/projects/:id/jobs/:jobId/frame", async (req, reply) => {
        const { id, jobId } = req.params as { id: string; jobId: string };
        ctx.project(id);
        const job = repo.getJob(jobId);
        if (!job || job.projectId !== id) throw new HttpError(404, "Job not found");
        const { since } = Query.parse(req.query ?? {});

        const none = (why: string, reason: string) => ({ available: false, why, reason, mime: "image/jpeg", watching: true });
        const ranOnAgent = jobRanOn(job)?.kind === "agent" || projectRunsOnAgent(job.projectId);
        const state = watchState(job, { ranOnAgent });
        if (state.why === "finished" || state.why === "stopping") {
            frameHub.drop(jobId);
            return none(state.why, state.reason!);
        }
        if (!frameHub.allowRead(jobId)) {
            reply.header("retry-after", "1");
            throw new HttpError(429, "That is more than three pictures a second. Wait a moment and try again.");
        }
        // A read is what asks the engine for pictures (for the next ten seconds).
        if (state.canWatch) frameHub.markWatched(jobId);
        if (!state.canWatch) return none(state.why ?? "nothing", state.reason ?? REASONS.nothing);

        const f = frameHub.latest(jobId);
        if (!f) return none("waiting", REASONS.waiting);
        const facts = { mime: "image/jpeg", url: f.url, title: f.title, note: f.note, phase: f.phase, pagesSeen: f.pagesSeen, at: f.at, ageMs: Math.max(0, Date.now() - f.receivedAt), watching: true };
        if (since && since === f.at) return { available: true, unchanged: true, ...facts };
        return { available: true, ...facts, imageBase64: Buffer.from(f.jpeg).toString("base64") };
    });
}
