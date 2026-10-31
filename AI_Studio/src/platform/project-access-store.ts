/**
 * Per-project access (migration slot 32): which projects a person may see, and their role in each.
 *
 * A person is either "all projects" (the default for everyone, and what every person had before this existed: nothing changes for
 * them) or "only these projects", each with a role there. The role in a project never goes above the person's platform role: it is
 * stored as chosen, and the lower of the two counts at use (an owner who later lowers someone's platform role does not have to
 * revisit every project). A personal API token acts as its person, so it is limited the same way.
 *
 * The decision itself (which routes belong to which project, 404 for a project the person may not see) lives in
 * auth/project-scope.ts; this file only stores the choice.
 *
 * Since round 25 (migration slot 34) the same rows are also a project's members (ACCESS_MODEL.md, D-27): Crowd4Test accounts other
 * than ADMIN are always "only these projects", and a row is how they were added to one. A row carries the Project Admin flag (who
 * approves there, D-23), where it came from (the creator, or added by someone) and who added it. Organizations (the tenant, D-14) are
 * mirrored here lazily from Crowd4Test's `/auth/me`, and a project may belong to one.
 */
import type { Db } from "./db.js";
import { lowerRole, type Role } from "./auth/actor.js";

export const PROJECT_ACCESS_MIGRATION = `
ALTER TABLE users ADD COLUMN project_access TEXT NOT NULL DEFAULT 'all'; -- all | only
CREATE TABLE user_projects (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    role TEXT NOT NULL,                                 -- owner | editor | viewer; the lower of this and the platform role counts
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, project_id)
);
CREATE INDEX idx_user_projects_project ON user_projects(project_id);
`;

export const MEMBERSHIP_MIGRATION = `
ALTER TABLE user_projects ADD COLUMN project_admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_projects ADD COLUMN source TEXT NOT NULL DEFAULT 'added'; -- creator | added
ALTER TABLE user_projects ADD COLUMN added_by TEXT;                       -- who added the row (an actor label), null for older rows
-- The Crowd4Test account behind a person, refreshed at each arrival: what may be done with them on a project (customers stay in
-- their organisation). Null for people made here.
ALTER TABLE users ADD COLUMN c4t_role TEXT;                               -- ADMIN | SUB_ADMIN | CUSTOMER | TESTER
ALTER TABLE users ADD COLUMN organization_id TEXT;
CREATE TABLE organizations (
    id TEXT PRIMARY KEY,                                                  -- the Crowd4Test Organisation id
    name TEXT,                                                            -- null until Crowd4Test's service endpoint provides it
    status TEXT,
    synced_at TEXT NOT NULL
);
ALTER TABLE projects ADD COLUMN organization_id TEXT REFERENCES organizations(id);
CREATE INDEX idx_projects_organization ON projects(organization_id);
`;

/** At most this many projects in one person's list (a picker, not a bulk import). */
export const MAX_PROJECTS_PER_PERSON = 500;

export type ProjectAccess = { mode: "all" } | { mode: "only"; projects: Map<string, Role> };

export interface ProjectAccessView {
    mode: "all" | "only";
    /** Only for "only": each project with its name and the role chosen there (and the role that counts, after the platform role). */
    projects?: Array<{ projectId: string; name: string; role: Role; effectiveRole: Role }>;
}

export class ProjectAccessStore {
    constructor(private readonly db: Db) {}

    /** What a person may see. Unknown ids and the built-in project-owner row count as "all" (they are never limited people). */
    accessOf(userId: string): ProjectAccess {
        const u = this.db.get<{ project_access: string | null }>("SELECT project_access FROM users WHERE id = ? AND role IS NOT NULL", userId);
        if (!u || u.project_access !== "only") return { mode: "all" };
        const rows = this.db.all<{ project_id: string; role: Role }>("SELECT project_id, role FROM user_projects WHERE user_id = ?", userId);
        return { mode: "only", projects: new Map(rows.map((r) => [r.project_id, r.role])) };
    }

    /** The answer the People screen shows (names of the projects, effective roles under the person's platform role). */
    view(userId: string, platformRole: Role): ProjectAccessView {
        const a = this.accessOf(userId);
        if (a.mode === "all") return { mode: "all" };
        const rows = this.db.all<{ project_id: string; role: Role; name: string }>(
            "SELECT up.project_id, up.role, p.name FROM user_projects up JOIN projects p ON p.id = up.project_id WHERE up.user_id = ? ORDER BY LOWER(p.name), p.id",
            userId,
        );
        return { mode: "only", projects: rows.map((r) => ({ projectId: r.project_id, name: r.name, role: r.role, effectiveRole: lowerRole(r.role, platformRole) })) };
    }

    /**
     * Replaces a person's access in one transaction. The caller has checked the projects exist and the roles are allowed. A project
     * that stays in the list keeps its Project Admin flag and where it came from.
     */
    set(userId: string, access: { mode: "all" } | { mode: "only"; projects: Array<{ projectId: string; role: Role }> }): void {
        this.db.tx(() => {
            const kept = new Map(
                this.db.all<{ project_id: string; project_admin: number; source: string; added_by: string | null; created_at: string }>(
                    "SELECT project_id, project_admin, source, added_by, created_at FROM user_projects WHERE user_id = ?",
                    userId,
                ).map((r) => [r.project_id, r]),
            );
            this.db.run("UPDATE users SET project_access = ?, updated_at = ? WHERE id = ? AND role IS NOT NULL", access.mode, new Date().toISOString(), userId);
            this.db.run("DELETE FROM user_projects WHERE user_id = ?", userId);
            if (access.mode === "only") {
                const t = new Date().toISOString();
                for (const p of access.projects) {
                    const k = kept.get(p.projectId);
                    this.db.run(
                        "INSERT INTO user_projects (user_id, project_id, role, created_at, project_admin, source, added_by) VALUES (?,?,?,?,?,?,?)",
                        userId, p.projectId, p.role, k?.created_at ?? t, k?.project_admin ?? 0, k?.source ?? "added", k?.added_by ?? null,
                    );
                }
            }
        });
    }

    /** "all" or "only", leaving the person's project rows as they are (a Crowd4Test account's reach follows its Crowd4Test role). */
    setMode(userId: string, mode: "all" | "only"): void {
        this.db.run("UPDATE users SET project_access = ?, updated_at = ? WHERE id = ? AND role IS NOT NULL AND project_access <> ?", mode, new Date().toISOString(), userId, mode);
    }

    // ── a project's members ──

    members(projectId: string): Member[] {
        return this.db
            .all<MemberRow>(`${MEMBER_SELECT} WHERE up.project_id = ? ORDER BY up.project_admin DESC, LOWER(u.name) NULLS FIRST, u.email`, projectId)
            .map(toMember);
    }

    member(projectId: string, userId: string): Member | undefined {
        const r = this.db.get<MemberRow>(`${MEMBER_SELECT} WHERE up.project_id = ? AND up.user_id = ?`, projectId, userId);
        return r ? toMember(r) : undefined;
    }

    /** Adds a person to a project; false when they already are a member. */
    addMember(projectId: string, userId: string, m: { role: Role; projectAdmin: boolean; source: "creator" | "added"; addedBy: string | null }): boolean {
        const r = this.db.run(
            "INSERT INTO user_projects (user_id, project_id, role, created_at, project_admin, source, added_by) VALUES (?,?,?,?,?,?,?) ON CONFLICT (user_id, project_id) DO NOTHING",
            userId, projectId, m.role, new Date().toISOString(), m.projectAdmin ? 1 : 0, m.source, m.addedBy,
        );
        return Number(r.changes) > 0;
    }

    setProjectAdmin(projectId: string, userId: string, projectAdmin: boolean): void {
        this.db.run("UPDATE user_projects SET project_admin = ? WHERE project_id = ? AND user_id = ?", projectAdmin ? 1 : 0, projectId, userId);
    }

    removeMember(projectId: string, userId: string): boolean {
        return Number(this.db.run("DELETE FROM user_projects WHERE project_id = ? AND user_id = ?", projectId, userId).changes) > 0;
    }

    isProjectAdmin(projectId: string, userId: string): boolean {
        return Boolean(this.db.get("SELECT 1 AS x FROM user_projects WHERE project_id = ? AND user_id = ? AND project_admin = 1", projectId, userId));
    }

    projectAdminCount(projectId: string): number {
        return Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM user_projects WHERE project_id = ? AND project_admin = 1", projectId)?.n ?? 0);
    }

    // ── Crowd4Test accounts and organizations ──

    /** What Crowd4Test said about a person at their latest arrival (their kind, and a customer's organisation). */
    recordCrowd4TestAccount(userId: string, c4tRole: string, organizationId: string | null): void {
        this.db.run(
            "UPDATE users SET c4t_role = ?, organization_id = ? WHERE id = ? AND (c4t_role IS DISTINCT FROM ? OR organization_id IS DISTINCT FROM ?)",
            c4tRole, organizationId, userId, c4tRole, organizationId,
        );
    }

    crowd4TestAccountOf(userId: string): { c4tRole: string | null; organizationId: string | null } | undefined {
        const r = this.db.get<{ c4t_role: string | null; organization_id: string | null }>("SELECT c4t_role, organization_id FROM users WHERE id = ? AND role IS NOT NULL", userId);
        return r ? { c4tRole: r.c4t_role, organizationId: r.organization_id } : undefined;
    }

    /** An organization seen in a Crowd4Test answer or named by staff: kept as its id until Crowd4Test can say its name. */
    ensureOrganization(id: string): void {
        // Read first: this runs on every Crowd4Test request, and a write would take the database's write lock each time.
        if (this.db.get("SELECT 1 AS x FROM organizations WHERE id = ?", id)) return;
        this.db.run("INSERT INTO organizations (id, name, status, synced_at) VALUES (?, NULL, NULL, ?) ON CONFLICT(id) DO NOTHING", id, new Date().toISOString());
    }

    organization(id: string): Organization | undefined {
        const r = this.db.get<{ id: string; name: string | null; status: string | null; synced_at: string }>("SELECT * FROM organizations WHERE id = ?", id);
        return r ? { id: r.id, name: r.name, status: r.status, syncedAt: r.synced_at } : undefined;
    }

    /** Crowd4Test's name and status of a mirrored organization (c4t-service.ts). Written only when they changed; unknown ids are left alone. */
    recordOrganization(id: string, name: string, status: string): void {
        const cur = this.organization(id);
        if (!cur || (cur.name === name && cur.status === status)) return;
        this.db.run("UPDATE organizations SET name = ?, status = ?, synced_at = ? WHERE id = ?", name, status, new Date().toISOString(), id);
    }

    /** Every mirrored organization (the organisations list when the Crowd4Test service is off). */
    organizations(): Organization[] {
        return this.db
            .all<{ id: string; name: string | null; status: string | null; synced_at: string }>("SELECT * FROM organizations ORDER BY CASE WHEN name IS NULL THEN 1 ELSE 0 END, name, id")
            .map((r) => ({ id: r.id, name: r.name, status: r.status, syncedAt: r.synced_at }));
    }

    projectOrganization(projectId: string): string | null {
        return this.db.get<{ o: string | null }>("SELECT organization_id AS o FROM projects WHERE id = ?", projectId)?.o ?? null;
    }

    setProjectOrganization(projectId: string, organizationId: string | null): void {
        if (organizationId) this.ensureOrganization(organizationId);
        this.db.run("UPDATE projects SET organization_id = ? WHERE id = ?", organizationId, projectId);
    }
}

export interface Organization {
    id: string;
    name: string | null;
    status: string | null;
    syncedAt: string;
}

/** One person on a project, as the Members screen shows them. */
export interface Member {
    personId: string;
    name: string;
    email: string;
    /** "admin" | "customer" | "tester" for Crowd4Test accounts; "local" for people made here. */
    kind: "admin" | "customer" | "tester" | "local";
    organizationId: string | null;
    projectAdmin: boolean;
    source: "creator" | "added";
    addedBy: string | null;
    addedAt: string;
    status: string;
}

interface MemberRow {
    user_id: string;
    name: string | null;
    email: string;
    status: string;
    c4t_role: string | null;
    organization_id: string | null;
    project_admin: number;
    source: string;
    added_by: string | null;
    created_at: string;
}

const MEMBER_SELECT = `SELECT up.user_id, u.name, u.email, u.status, u.c4t_role, u.organization_id, up.project_admin, up.source, up.added_by, up.created_at
    FROM user_projects up JOIN users u ON u.id = up.user_id AND u.role IS NOT NULL`;

export const kindOfC4tRole = (r: string | null): Member["kind"] =>
    r === "ADMIN" || r === "SUB_ADMIN" ? "admin" : r === "CUSTOMER" ? "customer" : r === "TESTER" ? "tester" : "local";

const toMember = (r: MemberRow): Member => ({
    personId: r.user_id,
    name: r.name || r.email,
    email: r.email,
    kind: kindOfC4tRole(r.c4t_role),
    organizationId: r.organization_id,
    projectAdmin: r.project_admin === 1,
    source: r.source === "creator" ? "creator" : "added",
    addedBy: r.added_by,
    addedAt: r.created_at,
    status: r.status,
});
