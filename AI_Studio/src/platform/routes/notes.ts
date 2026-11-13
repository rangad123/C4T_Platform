/**
 * Notes for the AI (round 53, notes-store.ts): reading needs access to the project; adding, changing and removing need the project
 * settings permission (auth/roles.ts).
 *
 *   GET    /api/projects/:id/notes              → { notes: [{ id, path, text, createdAt, updatedAt }], max }
 *   POST   /api/projects/:id/notes              { path?, text } → the note (201)
 *   PATCH  /api/projects/:id/notes/:noteId      { path?, text? } → the note
 *   DELETE /api/projects/:id/notes/:noteId      → 204
 */
import { z } from "zod";
import { HttpError } from "../http-error.js";
import { MAX_NOTE_PATH, MAX_NOTE_TEXT, MAX_NOTES, NotesStore } from "../notes-store.js";
import { parsePlain } from "./project-settings.js";
import type { RouteCtx } from "./types.js";

const Path = z
    .string()
    .trim()
    .max(MAX_NOTE_PATH, `A page path is at most ${MAX_NOTE_PATH} characters.`)
    .refine((p) => p === "" || p.startsWith("/"), "A page path starts with / (like /checkout or /product/*), or is left empty for the whole site.");
const Text = z.string().trim().min(1, "Write the note.").max(MAX_NOTE_TEXT, `A note is at most ${MAX_NOTE_TEXT} characters.`);
const Add = z.object({ path: Path.optional(), text: Text }).strict();
const Change = z.object({ path: Path, text: Text }).partial().strict();

export function registerNotesRoutes(ctx: RouteCtx): void {
    const { app, p } = ctx;
    const store = new NotesStore(p.sql);
    const projectId = (req: { params: unknown }): string => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        return id;
    };

    app.get("/api/projects/:id/notes", async (req) => ({ notes: await store.list(projectId(req)), max: MAX_NOTES }));

    app.post("/api/projects/:id/notes", async (req, reply) => {
        const pid = projectId(req);
        const body = parsePlain(Add, req.body);
        if ((await store.count(pid)) >= MAX_NOTES) throw new HttpError(409, `A project can have at most ${MAX_NOTES} notes. Remove one first.`);
        return reply.code(201).send(await store.add(pid, { path: body.path ?? "", text: body.text }));
    });

    app.patch("/api/projects/:id/notes/:noteId", async (req) => {
        const pid = projectId(req);
        const { noteId } = req.params as { noteId: string };
        const note = await store.update(pid, noteId, parsePlain(Change, req.body));
        if (!note) throw new HttpError(404, "Note not found");
        return note;
    });

    app.delete("/api/projects/:id/notes/:noteId", async (req, reply) => {
        const pid = projectId(req);
        const { noteId } = req.params as { noteId: string };
        if (!(await store.remove(pid, noteId))) throw new HttpError(404, "Note not found");
        return reply.code(204).send();
    });
}
