/**
 * Reusable libraries (migration slot 45): code an organisation shares across its projects, in nested folders.
 *
 *  - A library belongs to one organisation. Projects without an organisation (Crowd4Test's own, or a local install) share one
 *    library of their own, stored with organization_id NULL.
 *  - An item is reusable steps, a helper (code) or a shared element. Every change to its content is a new version; old versions stay.
 *  - A project uses an item by taking a copy of one version into its own reusable steps, helpers or shared elements. From then on the
 *    copy is the project's: its tests run it exactly like anything else of the project, and a newer library version reaches the project
 *    only when someone in the project chooses to update the copy (the normal project edit, with its checks and re-validation).
 *    `library_uses` remembers which version each project copied and what the copy looked like then, so the page can say
 *    "update available" and "changed in this project".
 */
import { createHash, randomUUID } from "node:crypto";
import { BLOCK_MARK } from "../engine/blocks/index.js";
import type { Db, Row } from "./db.js";

export const LIBRARY_MIGRATION = `
-- A folder of an organisation's library; parent_id NULL is the top level. Names are unique among the folders of one parent.
CREATE TABLE library_folders (
    id TEXT PRIMARY KEY,
    organization_id TEXT REFERENCES organizations(id),   -- NULL: the library of projects without an organisation
    parent_id TEXT REFERENCES library_folders(id),
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_library_folders_org ON library_folders(organization_id, parent_id, name_key);
-- An item: kind steps | helper | element. Names are unique per organisation and kind (a project copy keeps the same name).
CREATE TABLE library_items (
    id TEXT PRIMARY KEY,
    organization_id TEXT REFERENCES organizations(id),
    folder_id TEXT REFERENCES library_folders(id),
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL,                             -- the latest version
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_library_items_org ON library_items(organization_id, kind, name_key);
CREATE INDEX idx_library_items_folder ON library_items(folder_id);
-- Every version of an item's content. source_project_id: the project it was published from, if any.
CREATE TABLE library_item_versions (
    item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    content_json TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    source_project_id TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (item_id, version)
);
-- A project that copied an item: which version, under which name, and a fingerprint of the copy as it was made.
CREATE TABLE library_uses (
    item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    local_name TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (item_id, project_id)
);
CREATE INDEX idx_library_uses_project ON library_uses(project_id);
`;

export const ITEM_KINDS = ["steps", "helper", "element"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const KIND_WORDS: Record<ItemKind, string> = { steps: "reusable steps", helper: "helper", element: "shared element" };

export const MAX_FOLDER_DEPTH = 6;
export const MAX_LIBRARY_FOLDERS = 500;
export const MAX_LIBRARY_ITEMS = 2000;
export const MAX_VERSIONS_SHOWN = 100;

export const LIBRARY_FOLDER_NOT_FOUND = "Library folder not found";
export const LIBRARY_ITEM_NOT_FOUND = "Library item not found";
export const FOLDER_NOT_EMPTY = "This folder is not empty. Move or delete what is in it first.";
export const FOLDER_TOO_DEEP = `Library folders go at most ${MAX_FOLDER_DEPTH} levels deep.`;
export const FOLDER_INTO_ITSELF = "A folder can't go inside itself or one of its own folders.";
export const OTHER_LIBRARY = "That folder is in another organisation's library.";
export const libraryFolderTaken = (name: string) => `This folder already has a folder named “${name.trim().slice(0, 80)}”.`;
export const libraryItemTaken = (kind: ItemKind, name: string) => `The library already has ${KIND_WORDS[kind]} named “${name.trim().slice(0, 80)}”. Add a version to it instead, or choose another name.`;

const now = () => new Date().toISOString();
const keyOf = (name: string) => name.trim().toLowerCase();

/** A stable text of a content value: keys sorted, undefined and the engine's expansion notes left out. */
export function canonicalJson(v: unknown): string {
    return JSON.stringify(v, (k, x) => (k === BLOCK_MARK ? undefined : x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
}
export const fingerprintOf = (content: unknown): string => createHash("sha256").update(canonicalJson(content)).digest("hex").slice(0, 32);

export interface LibraryFolder {
    id: string;
    organizationId: string | null;
    parentId: string | null;
    name: string;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface LibraryItem {
    id: string;
    organizationId: string | null;
    folderId: string | null;
    kind: ItemKind;
    name: string;
    description: string;
    version: number;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface LibraryVersion {
    version: number;
    content: unknown;
    note: string;
    sourceProjectId: string | null;
    createdBy: string | null;
    createdAt: string;
}
export interface LibraryUse {
    itemId: string;
    projectId: string;
    version: number;
    localName: string;
    fingerprint: string;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
}

const folderOf = (r: Row): LibraryFolder => ({ id: r.id, organizationId: r.organization_id ?? null, parentId: r.parent_id ?? null, name: r.name, createdBy: r.created_by ?? null, createdAt: r.created_at, updatedAt: r.updated_at });
const itemOf = (r: Row): LibraryItem => ({
    id: r.id,
    organizationId: r.organization_id ?? null,
    folderId: r.folder_id ?? null,
    kind: r.kind,
    name: r.name,
    description: r.description ?? "",
    version: Number(r.version),
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
});
const versionOf = (r: Row): LibraryVersion => ({ version: Number(r.version), content: JSON.parse(r.content_json), note: r.note ?? "", sourceProjectId: r.source_project_id ?? null, createdBy: r.created_by ?? null, createdAt: r.created_at });
const useOf = (r: Row): LibraryUse => ({ itemId: r.item_id, projectId: r.project_id, version: Number(r.version), localName: r.local_name, fingerprint: r.fingerprint, createdBy: r.created_by ?? null, createdAt: r.created_at, updatedAt: r.updated_at });

/** `organization_id = ?` or `IS NULL`, with the value to bind. */
const orgWhere = (organizationId: string | null, column = "organization_id"): [string, string[]] => (organizationId ? [`${column} = ?`, [organizationId]] : [`${column} IS NULL`, []]);

export class LibraryStore {
    constructor(private readonly db: Db) {}

    // ── folders ──

    folders(organizationId: string | null): LibraryFolder[] {
        const [w, a] = orgWhere(organizationId);
        return this.db.all(`SELECT * FROM library_folders WHERE ${w} ORDER BY name_key, id`, ...a).map(folderOf);
    }

    folder(id: string): LibraryFolder | undefined {
        if (!id || id.length > 64) return undefined;
        const r = this.db.get("SELECT * FROM library_folders WHERE id = ?", id);
        return r ? folderOf(r) : undefined;
    }

    folderNameTaken(organizationId: string | null, parentId: string | null, name: string, exceptId?: string): boolean {
        return this.folders(organizationId).some((f) => f.parentId === parentId && keyOf(f.name) === keyOf(name) && f.id !== exceptId);
    }

    /** How deep a folder is (1 = top level). */
    depth(id: string | null): number {
        let n = 0;
        for (let f = id ? this.folder(id) : undefined; f && n <= MAX_FOLDER_DEPTH + 1; f = f.parentId ? this.folder(f.parentId) : undefined) n++;
        return n;
    }

    /** How many levels a folder holds below itself, itself included (1 = no subfolders). */
    height(id: string): number {
        const kids = this.db.all<{ id: string }>("SELECT id FROM library_folders WHERE parent_id = ?", id);
        return 1 + Math.max(0, ...kids.map((k) => this.height(k.id)));
    }

    /** Whether `id` is `ancestor` or inside it. */
    isWithin(id: string | null, ancestor: string): boolean {
        for (let f = id ? this.folder(id) : undefined, n = 0; f && n <= MAX_FOLDER_DEPTH + 1; f = f.parentId ? this.folder(f.parentId) : undefined, n++) if (f.id === ancestor) return true;
        return false;
    }

    countFolders(organizationId: string | null): number {
        return this.folders(organizationId).length;
    }

    createFolder(input: { organizationId: string | null; parentId: string | null; name: string; createdBy: string }): LibraryFolder {
        const id = randomUUID();
        const t = now();
        this.db.run(
            "INSERT INTO library_folders (id, organization_id, parent_id, name, name_key, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
            id,
            input.organizationId,
            input.parentId,
            input.name.trim(),
            keyOf(input.name),
            input.createdBy.slice(0, 200),
            t,
            t,
        );
        return this.folder(id)!;
    }

    updateFolder(id: string, patch: { name?: string; parentId?: string | null }): LibraryFolder | undefined {
        const cur = this.folder(id);
        if (!cur) return undefined;
        const name = patch.name ?? cur.name;
        const parentId = patch.parentId === undefined ? cur.parentId : patch.parentId;
        this.db.run("UPDATE library_folders SET name = ?, name_key = ?, parent_id = ?, updated_at = ? WHERE id = ?", name.trim(), keyOf(name), parentId, now(), id);
        return this.folder(id);
    }

    isEmpty(id: string): boolean {
        return !this.db.get("SELECT 1 AS x FROM library_folders WHERE parent_id = ? LIMIT 1", id) && !this.db.get("SELECT 1 AS x FROM library_items WHERE folder_id = ? LIMIT 1", id);
    }

    removeFolder(id: string): void {
        this.db.run("DELETE FROM library_folders WHERE id = ?", id);
    }

    // ── items ──

    items(organizationId: string | null): LibraryItem[] {
        const [w, a] = orgWhere(organizationId);
        return this.db.all(`SELECT * FROM library_items WHERE ${w} ORDER BY kind, name_key, id`, ...a).map(itemOf);
    }

    item(id: string): LibraryItem | undefined {
        if (!id || id.length > 64) return undefined;
        const r = this.db.get("SELECT * FROM library_items WHERE id = ?", id);
        return r ? itemOf(r) : undefined;
    }

    itemByName(organizationId: string | null, kind: ItemKind, name: string): LibraryItem | undefined {
        const [w, a] = orgWhere(organizationId);
        const r = this.db.get(`SELECT * FROM library_items WHERE ${w} AND kind = ? AND name_key = ?`, ...a, kind, keyOf(name));
        return r ? itemOf(r) : undefined;
    }

    countItems(organizationId: string | null): number {
        const [w, a] = orgWhere(organizationId);
        return Number(this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM library_items WHERE ${w}`, ...a)?.n ?? 0);
    }

    /** A new item with its first version, in one transaction. */
    createItem(input: { organizationId: string | null; folderId: string | null; kind: ItemKind; name: string; description: string; content: unknown; note: string; sourceProjectId: string | null; createdBy: string }): LibraryItem {
        const id = randomUUID();
        const t = now();
        this.db.tx(() => {
            this.db.run(
                "INSERT INTO library_items (id, organization_id, folder_id, kind, name, name_key, description, version, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,1,?,?,?)",
                id,
                input.organizationId,
                input.folderId,
                input.kind,
                input.name.trim(),
                keyOf(input.name),
                input.description.trim(),
                input.createdBy.slice(0, 200),
                t,
                t,
            );
            this.insertVersion(id, 1, input.content, input.note, input.sourceProjectId, input.createdBy, t);
        });
        return this.item(id)!;
    }

    private insertVersion(itemId: string, version: number, content: unknown, note: string, sourceProjectId: string | null, by: string, t: string): void {
        this.db.run(
            "INSERT INTO library_item_versions (item_id, version, content_json, note, source_project_id, created_by, created_at) VALUES (?,?,?,?,?,?,?)",
            itemId,
            version,
            JSON.stringify(content),
            note.trim().slice(0, 500),
            sourceProjectId,
            by.slice(0, 200),
            t,
        );
    }

    /** A new version of the content, or the item unchanged (and `added: false`) when the content is the latest one already. */
    addVersion(itemId: string, input: { content: unknown; note: string; sourceProjectId: string | null; createdBy: string; expectedVersion?: number }): { item: LibraryItem; added: boolean } | "stale" {
        return this.db.tx(() => {
            const cur = this.item(itemId)!;
            if (input.expectedVersion !== undefined && input.expectedVersion !== cur.version) return "stale" as const;
            const latest = this.version(itemId, cur.version);
            if (latest && canonicalJson(latest.content) === canonicalJson(input.content)) return { item: cur, added: false };
            const t = now();
            const next = cur.version + 1;
            this.insertVersion(itemId, next, input.content, input.note, input.sourceProjectId, input.createdBy, t);
            this.db.run("UPDATE library_items SET version = ?, updated_at = ? WHERE id = ?", next, t, itemId);
            return { item: this.item(itemId)!, added: true };
        });
    }

    updateItem(id: string, patch: { name?: string; description?: string; folderId?: string | null }): LibraryItem | undefined {
        const cur = this.item(id);
        if (!cur) return undefined;
        const name = patch.name ?? cur.name;
        this.db.run(
            "UPDATE library_items SET name = ?, name_key = ?, description = ?, folder_id = ?, updated_at = ? WHERE id = ?",
            name.trim(),
            keyOf(name),
            (patch.description ?? cur.description).trim(),
            patch.folderId === undefined ? cur.folderId : patch.folderId,
            now(),
            id,
        );
        return this.item(id);
    }

    /** Removes the item and its versions; the copies projects took stay theirs. */
    removeItem(id: string): void {
        this.db.run("DELETE FROM library_items WHERE id = ?", id);
    }

    version(itemId: string, version: number): LibraryVersion | undefined {
        const r = this.db.get("SELECT * FROM library_item_versions WHERE item_id = ? AND version = ?", itemId, version);
        return r ? versionOf(r) : undefined;
    }

    versions(itemId: string): LibraryVersion[] {
        return this.db.all("SELECT * FROM library_item_versions WHERE item_id = ? ORDER BY version DESC", itemId).map(versionOf);
    }

    // ── uses ──

    usesOfItem(itemId: string): LibraryUse[] {
        return this.db.all("SELECT * FROM library_uses WHERE item_id = ? ORDER BY created_at", itemId).map(useOf);
    }

    usesInProject(projectId: string): LibraryUse[] {
        return this.db.all("SELECT * FROM library_uses WHERE project_id = ?", projectId).map(useOf);
    }

    /** How many projects use each item of an organisation. */
    useCounts(organizationId: string | null): Map<string, number> {
        const [w, a] = orgWhere(organizationId, "i.organization_id");
        return new Map(this.db.all<{ id: string; n: number }>(`SELECT u.item_id AS id, COUNT(*) AS n FROM library_uses u JOIN library_items i ON i.id = u.item_id WHERE ${w} GROUP BY u.item_id`, ...a).map((r) => [r.id, Number(r.n)]));
    }

    recordUse(input: { itemId: string; projectId: string; version: number; localName: string; fingerprint: string; by: string }): void {
        const t = now();
        this.db.run(
            "INSERT INTO library_uses (item_id, project_id, version, local_name, fingerprint, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (item_id, project_id) DO UPDATE SET version = excluded.version, local_name = excluded.local_name, fingerprint = excluded.fingerprint, updated_at = excluded.updated_at",
            input.itemId,
            input.projectId,
            input.version,
            input.localName,
            input.fingerprint,
            input.by.slice(0, 200),
            t,
            t,
        );
    }
}
