/**
 * The project's notes for the AI in a script render (the overlays a note names are closed in web scripts). Every place that renders a
 * stored test's script outside a job adds them here to the context it already builds, so the script is the one a run would make.
 */
import type { RenderContext } from "../engine/generators/types.js";
import type { Db } from "./db.js";
import { NotesStore } from "./notes-store.js";

export async function withProjectNotes(db: Db, projectId: string, ctx: RenderContext): Promise<RenderContext> {
    const notes = await new NotesStore(db.sql).forEngine(projectId);
    return notes.length ? { ...ctx, notes } : ctx;
}
