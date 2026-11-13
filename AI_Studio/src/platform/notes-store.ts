/**
 * Notes for the AI (round 53): plain hints a person writes for their project, optionally tied to a path or page pattern. Written only
 * through routes/notes.ts (the project settings permission); every exploration reads them (engine/memory/notes.ts says how they are used).
 * Site memory (memory-store.ts) is what the AI learned; these are what people told it, so they live beside it and are never overwritten
 * by an analysis.
 */
import { randomUUID } from "node:crypto";
import type { SiteNote } from "../engine/memory/notes.js";
import type { Sql } from "./sql.js";

/** Migration slot 59. */
export const NOTES_MIGRATION = `
CREATE TABLE project_notes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL DEFAULT '',        -- '' = the whole site; else a path or pattern (/checkout, /product/*, /users/:id)
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_project_notes_project ON project_notes(project_id, created_at);
`;

export const MAX_NOTES = 50;
export const MAX_NOTE_TEXT = 500;
export const MAX_NOTE_PATH = 200;

export interface NoteRecord {
    id: string;
    /** "" = the whole site. */
    path: string;
    text: string;
    createdAt: string;
    updatedAt: string;
}

interface Row {
    id: string;
    path: string;
    text: string;
    created_at: string;
    updated_at: string;
}

const toRecord = (r: Row): NoteRecord => ({ id: r.id, path: r.path, text: r.text, createdAt: r.created_at, updatedAt: r.updated_at });

export class NotesStore {
    constructor(private readonly sql: Sql) {}

    async list(projectId: string): Promise<NoteRecord[]> {
        return (await this.sql.all<Row>("SELECT id, path, text, created_at, updated_at FROM project_notes WHERE project_id = ? ORDER BY created_at, id", projectId)).map(toRecord);
    }

    async get(projectId: string, id: string): Promise<NoteRecord | undefined> {
        const r = await this.sql.get<Row>("SELECT id, path, text, created_at, updated_at FROM project_notes WHERE project_id = ? AND id = ?", projectId, id);
        return r ? toRecord(r) : undefined;
    }

    async count(projectId: string): Promise<number> {
        return Number((await this.sql.get<{ n: number }>("SELECT COUNT(*) AS n FROM project_notes WHERE project_id = ?", projectId))?.n ?? 0);
    }

    async add(projectId: string, v: { path: string; text: string }): Promise<NoteRecord> {
        const id = randomUUID();
        const at = new Date().toISOString();
        await this.sql.run("INSERT INTO project_notes (id, project_id, path, text, created_at, updated_at) VALUES (?,?,?,?,?,?)", id, projectId, v.path, v.text, at, at);
        return (await this.get(projectId, id))!;
    }

    async update(projectId: string, id: string, v: { path?: string; text?: string }): Promise<NoteRecord | undefined> {
        const cur = await this.get(projectId, id);
        if (!cur) return undefined;
        await this.sql.run("UPDATE project_notes SET path = ?, text = ?, updated_at = ? WHERE project_id = ? AND id = ?", v.path ?? cur.path, v.text ?? cur.text, new Date().toISOString(), projectId, id);
        return this.get(projectId, id);
    }

    async remove(projectId: string, id: string): Promise<boolean> {
        return (await this.sql.run("DELETE FROM project_notes WHERE project_id = ? AND id = ?", projectId, id)).changes > 0;
    }

    /** What an exploration gets (engine/memory/notes.ts). Never throws: notes can never stop an exploration. */
    async forEngine(projectId: string): Promise<SiteNote[]> {
        try {
            return (await this.list(projectId)).map((n) => (n.path ? { path: n.path, text: n.text } : { text: n.text }));
        } catch {
            return [];
        }
    }
}
