/**
 * Project folders, archived projects and personal preferences (NAV-02, US-012; migration slot 41).
 *
 *  - A folder groups projects inside one organisation (for example by client or product line). A project is in at most one folder,
 *    always of its own organisation; a local install (no organisations) keeps its folders under "no organisation". Removing a
 *    folder moves its projects out; it never removes a project.
 *  - An archived project is read-only (the access hook refuses every change to it, auth/access.ts), left out of the lists unless
 *    asked for, and starts no run (Repo.createJob, ScheduleStore.due). Restoring it undoes all of that.
 *  - Deleting a project (only an archived one) removes its rows and its stored files. AI usage, the Activity list and the security
 *    audit stay: they are the record of what happened and what it cost.
 *  - Preferences are per person (a row of `users`): which emails they get and how their projects list opens.
 */
import { randomUUID } from "node:crypto";
import type { Db, Row } from "./db.js";
import type { ObjectStore } from "./object-store.js";

export const FOLDERS_MIGRATION = `
CREATE TABLE project_folders (
    id TEXT PRIMARY KEY,
    organization_id TEXT REFERENCES organizations(id),   -- NULL: a local install's folders (projects without an organisation)
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,                               -- the name trimmed and lower-cased: one name per organisation
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_project_folders_org ON project_folders(organization_id, name_key);
ALTER TABLE projects ADD COLUMN folder_id TEXT REFERENCES project_folders(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN archived_at TEXT;
ALTER TABLE projects ADD COLUMN archived_by TEXT;
CREATE INDEX idx_projects_folder ON projects(folder_id);
CREATE TABLE user_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    prefs_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
`;

const now = () => new Date().toISOString();
const keyOf = (name: string) => name.trim().toLowerCase();

// ── words ──

export const PROJECT_ARCHIVED = "This project is archived, so it is read-only. A Project Admin can restore it in Settings → General.";
export const NOT_ARCHIVED = "Archive the project before deleting it.";
export const ALREADY_ARCHIVED = "This project is already archived.";
export const STOP_RUN_FIRST = "Stop the running test first: a project cannot be archived or deleted while a run, assessment or runbook is in progress.";
export const NEEDS_PROJECT_ADMIN = "Only a Project Admin of this project can archive, restore or delete it.";
export const MAX_FOLDERS_PER_ORGANIZATION = 200;
export const NEEDS_TESTS_DELETE = "Deleting a project deletes its tests, so it also needs permission to delete tests.";
export const NAME_TO_CONFIRM = "Type the project's name exactly to confirm.";
export const projectNameTaken = (name: string) => `A project named “${name.trim().slice(0, 120)}” already exists in this organisation. Choose another name.`;
export const folderNameTaken = (name: string) => `A folder named “${name.trim().slice(0, 80)}” already exists in this organisation.`;
export const FOLDER_NOT_FOUND = "Folder not found";
export const OTHER_ORGANIZATION_FOLDER = "A project can only go into a folder of its own organisation.";

// ── project names ──

/** Whether another project of the same organisation (archived ones too) already has this name, ignoring case and outer spaces. */
export function isProjectNameTaken(db: Db, name: string, organizationId: string | null, exceptId?: string): boolean {
    const rows = organizationId
        ? db.all<{ id: string; name: string }>("SELECT id, name FROM projects WHERE organization_id = ?", organizationId)
        : db.all<{ id: string; name: string }>("SELECT id, name FROM projects WHERE organization_id IS NULL");
    const k = keyOf(name);
    return rows.some((r) => r.id !== exceptId && keyOf(r.name) === k);
}

// ── archive ──

export function isArchived(db: Db, projectId: string): boolean {
    return Boolean(db.get("SELECT 1 AS x FROM projects WHERE id = ? AND archived_at IS NOT NULL", projectId));
}

/** What is still running in the project, in words, or undefined when nothing is. */
export function runningWorkOf(db: Db, projectId: string): string | undefined {
    const job = db.get<{ id: string; status: string }>("SELECT id, status FROM generation_jobs WHERE project_id = ? AND status NOT IN ('COMPLETED','PARTIALLY_COMPLETED','FAILED') LIMIT 1", projectId);
    if (job) return `A run is ${job.status.toLowerCase().replace(/_/g, " ")}.`;
    if (db.get("SELECT 1 AS x FROM security_assessments WHERE project_id = ? AND state NOT IN ('COMPLETED','PARTIALLY_COMPLETED','FAILED','CANCELLED') LIMIT 1", projectId)) return "A security assessment is in progress.";
    if (db.get("SELECT 1 AS x FROM runbook_runs WHERE project_id = ? AND status = 'running' LIMIT 1", projectId)) return "A runbook is running.";
    return undefined;
}

export function archiveProject(db: Db, projectId: string, by: string): void {
    db.run("UPDATE projects SET archived_at = ?, archived_by = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL", now(), by.slice(0, 200), now(), projectId);
}

export function restoreProject(db: Db, projectId: string): void {
    db.run("UPDATE projects SET archived_at = NULL, archived_by = NULL, updated_at = ? WHERE id = ?", now(), projectId);
}

// ── delete ──

/** Rows of a deleted project that stay: the record of who did what (Activity, the security audit) and of what the AI cost (AI-04). */
export const KEPT_ON_DELETE = ["activity", "ai_usage", "security_audit"] as const;

export interface DeleteReport {
    /** Rows removed from the tables that name the project, by table (rows that went with them through ON DELETE CASCADE are not counted). */
    rows: Record<string, number>;
    tests: number;
    runs: number;
    files: number;
    bytes: number;
    kept: readonly string[];
}

/** Every table with a `project_id` column, except `projects` itself and the kept ones. Read from the schema, so new tables are included. */
export function projectTables(db: Db): string[] {
    const d = db.dialect;
    return d
        .listTables(db)
        .filter((t) => t !== "projects" && !(KEPT_ON_DELETE as readonly string[]).includes(t))
        .filter((t) => d.listColumns(db, t).some((c) => c.name === "project_id"))
        .sort();
}

/** The stored files of a project that its rows name outside its own folder (older rows); its folder `<projectId>/` holds the rest. */
function strayKeys(db: Db, projectId: string): string[] {
    const own = `${projectId}/`;
    const named = [
        ...db.all<{ k: string | null }>("SELECT path AS k FROM artifacts WHERE project_id = ?", projectId),
        ...db.all<{ k: string | null }>("SELECT s.storage_path AS k FROM generated_scripts s JOIN test_cases t ON t.id = s.test_case_id WHERE t.project_id = ?", projectId),
    ];
    // Never a file in another project's folder, whatever a row says: deleting one project must not touch another.
    const others = new Set(db.all<{ id: string }>("SELECT id FROM projects WHERE id <> ?", projectId).map((r) => r.id));
    return [...new Set(named.map((r) => r.k ?? "").filter((k) => k && !k.startsWith(own) && !k.startsWith("/") && !/^[A-Za-z]:/.test(k) && !k.includes("..") && !others.has(k.split("/")[0]!)))];
}

/**
 * Remove an archived project: first its files (everything under `<projectId>/` in the object store, plus any file its rows name
 * elsewhere), then, in one transaction, the project row (ON DELETE CASCADE takes the tables that reference it) and the rows of every
 * other table that names it. Files go first so a failure leaves the project in place to try again, never rows pointing at nothing
 * or files nobody can find. The caller checks that it is archived and that nothing runs.
 */
export async function deleteProject(db: Db, store: ObjectStore, projectId: string): Promise<DeleteReport> {
    const tests = Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM test_cases WHERE project_id = ?", projectId)?.n ?? 0);
    const runs = Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM generation_jobs WHERE project_id = ?", projectId)?.n ?? 0);
    const listed = await store.list(projectId);
    let files = listed.length;
    let bytes = listed.reduce((s, o) => s + o.size, 0);
    for (const key of strayKeys(db, projectId)) {
        try {
            const info = await store.head(key);
            if (await store.delete(key)) {
                files++;
                bytes += info?.size ?? 0;
            }
        } catch {
            // A name that is not a valid key (an absolute path from long ago) is not in the store: nothing to remove.
        }
    }
    await store.deletePrefix(projectId);
    const rows: Record<string, number> = {};
    const tables = projectTables(db);
    db.tx(() => {
        for (const t of tables) {
            const n = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id = ?`, projectId)?.n ?? 0);
            if (n) rows[t] = n;
        }
        db.run("DELETE FROM projects WHERE id = ?", projectId);
        // Tables that name the project without a foreign key (artifacts, budgets...): nothing cascaded to them.
        for (const t of tables) db.run(`DELETE FROM ${t} WHERE project_id = ?`, projectId);
    });
    return { rows, tests, runs, files, bytes, kept: KEPT_ON_DELETE };
}

// ── folders ──

export interface Folder {
    id: string;
    organizationId: string | null;
    name: string;
    createdAt: string;
    updatedAt: string;
}

const folderOf = (r: Row): Folder => ({ id: r.id, organizationId: r.organization_id ?? null, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at });

export class FolderStore {
    constructor(private readonly db: Db) {}

    list(): Folder[] {
        return this.db.all("SELECT * FROM project_folders ORDER BY name_key, id").map(folderOf);
    }

    get(id: string): Folder | undefined {
        if (!id || id.length > 64) return undefined;
        const r = this.db.get("SELECT * FROM project_folders WHERE id = ?", id);
        return r ? folderOf(r) : undefined;
    }

    nameTaken(organizationId: string | null, name: string, exceptId?: string): boolean {
        const rows = organizationId
            ? this.db.all<{ id: string }>("SELECT id FROM project_folders WHERE organization_id = ? AND name_key = ?", organizationId, keyOf(name))
            : this.db.all<{ id: string }>("SELECT id FROM project_folders WHERE organization_id IS NULL AND name_key = ?", keyOf(name));
        return rows.some((r) => r.id !== exceptId);
    }

    /** How many folders an organisation has (NULL: a local install's). */
    countOf(organizationId: string | null): number {
        const r = organizationId ? this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM project_folders WHERE organization_id = ?", organizationId) : this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM project_folders WHERE organization_id IS NULL");
        return Number(r?.n ?? 0);
    }

    /** The organisation must exist in `organizations` already (ProjectAccessStore.ensureOrganization). */
    create(input: { organizationId: string | null; name: string; createdBy: string }): Folder {
        const id = randomUUID();
        const t = now();
        this.db.run(
            "INSERT INTO project_folders (id, organization_id, name, name_key, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
            id,
            input.organizationId,
            input.name.trim(),
            keyOf(input.name),
            input.createdBy.slice(0, 200),
            t,
            t,
        );
        return this.get(id)!;
    }

    rename(id: string, name: string): Folder | undefined {
        this.db.run("UPDATE project_folders SET name = ?, name_key = ?, updated_at = ? WHERE id = ?", name.trim(), keyOf(name), now(), id);
        return this.get(id);
    }

    /** Removes the folder; its projects stay, outside any folder. Returns how many projects were moved out. */
    remove(id: string): number {
        return this.db.tx(() => {
            const moved = Number(this.db.run("UPDATE projects SET folder_id = NULL WHERE folder_id = ?", id).changes);
            this.db.run("DELETE FROM project_folders WHERE id = ?", id);
            return moved;
        });
    }

    setProjectFolder(projectId: string, folderId: string | null): void {
        this.db.run("UPDATE projects SET folder_id = ? WHERE id = ?", folderId, projectId);
    }

    /** Every project that is in a folder: id, folder, name, organisation and whether it is archived. */
    placements(): Array<{ id: string; name: string; folderId: string; organizationId: string | null; archived: boolean }> {
        return this.db
            .all<{ id: string; name: string; folder_id: string; organization_id: string | null; archived_at: string | null }>("SELECT id, name, folder_id, organization_id, archived_at FROM projects WHERE folder_id IS NOT NULL ORDER BY name")
            .map((r) => ({ id: r.id, name: r.name, folderId: r.folder_id, organizationId: r.organization_id ?? null, archived: r.archived_at !== null }));
    }
}

// ── preferences ──

/**
 * What a person can choose. Only what AI Studio really does: it emails people only through a project's email alert channels (run
 * alerts: Schedule → Alerts) and the security assessment's messages, to the addresses listed there; a person whose account email is
 * listed can turn those off for themselves. `projectsView` is how the Projects page opens when there are two or more projects.
 */
export interface Preferences {
    runAlertEmails: boolean;
    securityEmails: boolean;
    projectsView: "dashboard" | "list";
}
export const DEFAULT_PREFERENCES: Preferences = { runAlertEmails: true, securityEmails: true, projectsView: "dashboard" };
export type EmailKind = "runAlertEmails" | "securityEmails";

const parsePrefs = (json: string | null | undefined): Preferences => {
    try {
        const v = JSON.parse(json ?? "{}") as Partial<Preferences>;
        return {
            runAlertEmails: v.runAlertEmails !== false,
            securityEmails: v.securityEmails !== false,
            projectsView: v.projectsView === "list" ? "list" : "dashboard",
        };
    } catch {
        return { ...DEFAULT_PREFERENCES };
    }
};

export class PreferenceStore {
    constructor(private readonly db: Db) {}

    get(userId: string): Preferences {
        return parsePrefs(this.db.get<{ prefs_json: string }>("SELECT prefs_json FROM user_preferences WHERE user_id = ?", userId)?.prefs_json);
    }

    set(userId: string, patch: Partial<Preferences>): Preferences {
        const next = { ...this.get(userId), ...patch };
        this.db.run(
            "INSERT INTO user_preferences (user_id, prefs_json, updated_at) VALUES (?,?,?) ON CONFLICT (user_id) DO UPDATE SET prefs_json = excluded.prefs_json, updated_at = excluded.updated_at",
            userId,
            JSON.stringify(next),
            now(),
        );
        return next;
    }

    /** Lower-cased email addresses of the people who turned this kind of email off. */
    optedOut(kind: EmailKind): Set<string> {
        const rows = this.db.all<{ email: string; prefs_json: string }>("SELECT u.email, up.prefs_json FROM user_preferences up JOIN users u ON u.id = up.user_id");
        return new Set(rows.filter((r) => parsePrefs(r.prefs_json)[kind] === false).map((r) => r.email.trim().toLowerCase()));
    }
}

/** The recipients of an alert email minus the people who turned that kind off. Never throws: a broken lookup sends to everyone listed. */
export function wantedRecipients(db: Db, kind: EmailKind, to: string[]): string[] {
    try {
        const out = new PreferenceStore(db).optedOut(kind);
        return out.size ? to.filter((a) => !out.has(a.trim().toLowerCase())) : to;
    } catch {
        return to;
    }
}

export const EVERYONE_OPTED_OUT = "Not sent: every recipient turned these emails off in their profile.";
