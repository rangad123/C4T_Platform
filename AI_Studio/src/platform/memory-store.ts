/**
 * Site memory persistence: one structural record per project and application origin (see engine/memory/*).
 * Every query is scoped by project id, so one project's memory can never reach another's prompts or API answers.
 * Reading never throws: an unusable record becomes a plain warning, and a corrupted or oversized one is deleted.
 */
import { MAX_MEMORY_BYTES, MAX_ORIGINS_PER_PROJECT, MemoryChangesSchema, MEMORY_VERSION, SiteKnowledgeSchema, type MemoryChanges, type MemoryLoad, type SiteKnowledge } from "../engine/memory/types.js";
import type { Db } from "./db.js";

/** Migration slot 10. */
export const MEMORY_MIGRATION = `
CREATE TABLE site_memory (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    origin TEXT NOT NULL,
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    job_id TEXT,
    size_bytes INTEGER NOT NULL,
    knowledge_json TEXT NOT NULL,   -- structural facts only (paths, page types, fingerprints, journey names, endpoint templates)
    changes_json TEXT,              -- what changed compared with the analysis before (null on the first one)
    PRIMARY KEY (project_id, origin)
);
`;

interface Row {
    origin: string;
    version: number;
    updated_at: string;
    job_id: string | null;
    size_bytes: number;
    knowledge_json: string;
    changes_json: string | null;
}

export interface StoredMemory {
    knowledge: SiteKnowledge;
    changes: MemoryChanges | null;
    updatedAt: string;
    jobId: string | null;
}

/** Replace the memory of this project's application. Throws only for a record that cannot be stored (too big). */
export function saveMemory(db: Db, args: { projectId: string; jobId?: string; knowledge: SiteKnowledge; changes: MemoryChanges | null; now?: string }): void {
    const json = JSON.stringify(SiteKnowledgeSchema.parse(args.knowledge));
    const size = Buffer.byteLength(json, "utf8");
    if (size > MAX_MEMORY_BYTES) throw new Error(`site memory is ${size} bytes, over the ${MAX_MEMORY_BYTES} byte limit`);
    const changes = args.changes ? JSON.stringify(MemoryChangesSchema.parse(args.changes)) : null;
    const at = args.now ?? new Date().toISOString();
    db.tx(() => {
        db.run(
            `INSERT INTO site_memory (project_id, origin, version, updated_at, job_id, size_bytes, knowledge_json, changes_json) VALUES (?,?,?,?,?,?,?,?)
             ON CONFLICT (project_id, origin) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at, job_id = excluded.job_id, size_bytes = excluded.size_bytes, knowledge_json = excluded.knowledge_json, changes_json = excluded.changes_json`,
            args.projectId,
            args.knowledge.origin,
            MEMORY_VERSION,
            at,
            args.jobId ?? null,
            size,
            json,
            changes,
        );
        db.run(
            "DELETE FROM site_memory WHERE project_id = ? AND origin NOT IN (SELECT origin FROM site_memory WHERE project_id = ? ORDER BY updated_at DESC, origin LIMIT ?)",
            args.projectId,
            args.projectId,
            MAX_ORIGINS_PER_PROJECT,
        );
    });
}

type Parsed = { ok: true; value: StoredMemory } | { ok: false; reason: "version" | "corrupt" };

function parse(row: Row): Parsed {
    // Check the version before the shape: a newer release may have changed the shape.
    if (row.version !== MEMORY_VERSION) return { ok: false, reason: "version" };
    if (row.size_bytes > MAX_MEMORY_BYTES || Buffer.byteLength(row.knowledge_json, "utf8") > MAX_MEMORY_BYTES) return { ok: false, reason: "corrupt" };
    try {
        const knowledge = SiteKnowledgeSchema.parse(JSON.parse(row.knowledge_json));
        const changes = row.changes_json ? MemoryChangesSchema.safeParse(JSON.parse(row.changes_json)) : null;
        return { ok: true, value: { knowledge, changes: changes?.success ? changes.data : null, updatedAt: row.updated_at, jobId: row.job_id } };
    } catch {
        return { ok: false, reason: "corrupt" };
    }
}

/**
 * The memory of this project for one application origin, for use in prompts. A record from an unknown version is
 * ignored (and kept); a corrupted or oversized one is deleted. Either way the caller gets a plain warning, never an error.
 */
export function loadMemory(db: Db, projectId: string, origin: string): MemoryLoad {
    try {
        const row = db.get<Row>("SELECT origin, version, updated_at, job_id, size_bytes, knowledge_json, changes_json FROM site_memory WHERE project_id = ? AND origin = ?", projectId, origin);
        if (!row) return { knowledge: null };
        const p = parse(row);
        if (p.ok) return { knowledge: p.value.knowledge };
        if (p.reason === "version") return { knowledge: null, warning: "What we remembered about this site was saved by a different version of the platform, so it was not used. This analysis will save fresh notes." };
        db.run("DELETE FROM site_memory WHERE project_id = ? AND origin = ?", projectId, origin);
        return { knowledge: null, warning: "What we remembered about this site was damaged or too large, so it was discarded. This analysis will save fresh notes." };
    } catch (err) {
        return { knowledge: null, warning: `Site memory could not be read (${err instanceof Error ? err.message : String(err)}); continuing without it.` };
    }
}

/** The most recently updated usable memory of a project (for the Overview card). Unusable rows are skipped, not deleted. */
export function latestMemory(db: Db, projectId: string): StoredMemory | null {
    const rows = db.all<Row>("SELECT origin, version, updated_at, job_id, size_bytes, knowledge_json, changes_json FROM site_memory WHERE project_id = ? ORDER BY updated_at DESC, origin", projectId);
    for (const row of rows) {
        const p = parse(row);
        if (p.ok) return p.value;
    }
    return null;
}

/** Forget everything remembered about a project's applications. Returns how many records were removed. */
export function forgetMemory(db: Db, projectId: string): number {
    return Number(db.run("DELETE FROM site_memory WHERE project_id = ?", projectId).changes);
}
