/**
 * Project folders, archiving and deleting a project, and a person's preferences (NAV-02, US-012; store in project-folders.ts):
 *
 *   GET    /api/folders                    → { folders: [{ id, name, organizationId, organizationName, canManage, projects }], canCreate, organizations }
 *   POST   /api/folders                    { name, organizationId? } → the folder
 *   PATCH  /api/folders/:folderId          { name } → the folder
 *   DELETE /api/folders/:folderId          → { removed, projectsMovedOut }   its projects stay, outside any folder
 *   PUT    /api/projects/:id/folder        { folderId | null } → { folderId }
 *   POST   /api/projects/:id/archive       → the project (read-only, out of the lists, no runs)
 *   POST   /api/projects/:id/unarchive     → the project
 *   DELETE /api/projects/:id               { name } → { deleted, report }   only an archived project, its name typed to confirm
 *   GET    /api/me/preferences             → { preferences, saved }
 *   PUT    /api/me/preferences             { runAlertEmails?, securityEmails?, projectsView? } → { preferences, saved }
 *
 * Who changes folders: people with "create projects", in the organisations they work in (a customer: their own; Crowd4Test staff and
 * local accounts with every project: any). Everyone sees only folders holding a project they can reach, plus the folders they may
 * change; a customer never sees another organisation's folders. Archiving, restoring and deleting need "change project settings"
 * and Project Admin of the project.
 */
import { z } from "zod";
import { accessControlOf, actorOf } from "../auth/access.js";
import { actorLabel, currentActor, isCrowd4TestActor, permissionsOf, sideOf, type Actor } from "../auth/actor.js";
import { visibleProjectsOf } from "../auth/project-scope.js";
import { formatBytes } from "../../engine/retention/format.js";
import { HttpError } from "../http-error.js";
import {
    ALREADY_ARCHIVED,
    archiveProject,
    deleteProject,
    FOLDER_NOT_FOUND,
    folderNameTaken,
    FolderStore,
    isArchived,
    NAME_TO_CONFIRM,
    NEEDS_PROJECT_ADMIN,
    NEEDS_TESTS_DELETE,
    MAX_FOLDERS_PER_ORGANIZATION,
    NOT_ARCHIVED,
    OTHER_ORGANIZATION_FOLDER,
    PreferenceStore,
    restoreProject,
    runningWorkOf,
    STOP_RUN_FIRST,
    type Folder,
} from "../project-folders.js";
import { parsePlain, withSetup } from "./project-settings.js";
import type { RouteCtx } from "./types.js";

export const CANNOT_CHANGE_FOLDERS = "You can't change folders here. Changing folders needs “create projects” in the project's organisation.";
export const NO_PREFERENCES = "Preferences belong to a person's account. Sign in as yourself to save them.";

const FolderName = z.string().trim().min(1, "Give the folder a name.").max(80, "A folder name is at most 80 characters.");
const OrgId = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, "An organization id is letters, digits, - and _ (at most 64).");

export function registerProjectFolderRoutes(ctx: RouteCtx): void {
    const { app, p, repo, project } = ctx;
    const control = accessControlOf(app);
    const folders = new FolderStore(p.db);
    const prefs = new PreferenceStore(p.db);

    const who = (req: Parameters<typeof actorOf>[0]): Actor => actorOf(req) ?? currentActor();

    /** Whether the actor may create, rename, remove and fill folders of this organisation (null: projects without one). */
    const canManage = (actor: Actor, organizationId: string | null): boolean => {
        if (!permissionsOf(actor).has("ai_studio.project.create")) return false;
        const side = sideOf(actor);
        if (side === "customer") return Boolean(actor.organizationId) && organizationId === actor.organizationId;
        if (side === "tester") return false;
        if (side === "admin") return true;
        return control.projects.allowed(actor) === null;
    };
    /** A customer sees nothing of another organisation, whatever else holds. */
    const ownSide = (actor: Actor, f: Folder) => sideOf(actor) !== "customer" || f.organizationId === (actor.organizationId ?? "\u0000");

    const folderView = (req: Parameters<typeof actorOf>[0], withArchived: boolean) => {
        const actor = who(req);
        const visible = visibleProjectsOf(req, actor);
        const reach = (id: string) => !visible || visible.has(id);
        const placed = folders.placements().filter((x) => reach(x.id));
        const names = new Map(control.projects.store.organizations().map((o) => [o.id, o.name]));
        const list = folders
            .list()
            .filter((f) => ownSide(actor, f))
            .map((f) => ({ f, manage: canManage(actor, f.organizationId), projects: placed.filter((x) => x.folderId === f.id) }))
            .filter((x) => x.manage || x.projects.length > 0)
            .map(({ f, manage, projects }) => ({
                ...f,
                organizationName: f.organizationId ? (names.get(f.organizationId) ?? null) : null,
                canManage: manage,
                projects: projects.filter((x) => withArchived || !x.archived).map((x) => ({ id: x.id, name: x.name, archived: x.archived })),
                archivedCount: projects.filter((x) => x.archived).length,
            }));
        return { actor, list };
    };

    /** A folder the actor can see, or the same 404 as an unknown one. */
    const visibleFolder = (req: Parameters<typeof actorOf>[0], folderId: string): Folder => {
        const f = folders.get(folderId);
        if (!f || !folderView(req, true).list.some((x) => x.id === f.id)) throw new HttpError(404, FOLDER_NOT_FOUND);
        return f;
    };

    app.get("/api/folders", async (req) => {
        const withArchived = (req.query as { archived?: string } | undefined)?.archived === "include";
        const { actor, list } = folderView(req, withArchived);
        // The organisations a new folder can go in: those of the projects the actor may organise (and "none" for projects without one).
        const visible = visibleProjectsOf(req, actor);
        const orgs = new Set<string | null>(
            p.db
                .all<{ id: string; organization_id: string | null }>("SELECT id, organization_id FROM projects")
                .filter((r) => !visible || visible.has(r.id))
                .map((r) => r.organization_id ?? null)
                .filter((o) => canManage(actor, o)),
        );
        if (sideOf(actor) === "customer" && actor.organizationId && canManage(actor, actor.organizationId)) orgs.add(actor.organizationId);
        const names = new Map(control.projects.store.organizations().map((o) => [o.id, o.name]));
        const organizations = [...orgs].map((id) => ({ id, name: id ? (names.get(id) ?? null) : null }));
        return { folders: list, canCreate: organizations.length > 0 || canManage(actor, null), organizations };
    });

    app.post("/api/folders", async (req, reply) => {
        const actor = who(req);
        const body = parsePlain(z.object({ name: FolderName, organizationId: OrgId.nullable().optional() }).strict(), req.body);
        let org = body.organizationId ?? null;
        if (sideOf(actor) === "customer") {
            if (org && org !== actor.organizationId) throw new HttpError(403, "You can make folders in your own organisation only.");
            org = actor.organizationId ?? null;
        }
        if (!canManage(actor, org)) throw new HttpError(403, CANNOT_CHANGE_FOLDERS);
        if (folders.nameTaken(org, body.name)) throw new HttpError(409, folderNameTaken(body.name));
        if (folders.countOf(org) >= MAX_FOLDERS_PER_ORGANIZATION) throw new HttpError(409, `An organisation can have at most ${MAX_FOLDERS_PER_ORGANIZATION} folders. Remove one first.`);
        if (org) control.projects.store.ensureOrganization(org);
        return reply.code(201).send(folders.create({ organizationId: org, name: body.name, createdBy: actorLabel(actor) }));
    });

    app.patch("/api/folders/:folderId", async (req) => {
        const { folderId } = req.params as { folderId: string };
        const f = visibleFolder(req, folderId);
        const body = parsePlain(z.object({ name: FolderName }).strict(), req.body);
        if (!canManage(who(req), f.organizationId)) throw new HttpError(403, CANNOT_CHANGE_FOLDERS);
        if (folders.nameTaken(f.organizationId, body.name, f.id)) throw new HttpError(409, folderNameTaken(body.name));
        return folders.rename(f.id, body.name);
    });

    app.delete("/api/folders/:folderId", async (req) => {
        const { folderId } = req.params as { folderId: string };
        const f = visibleFolder(req, folderId);
        if (!canManage(who(req), f.organizationId)) throw new HttpError(403, CANNOT_CHANGE_FOLDERS);
        return { removed: true, projectsMovedOut: folders.remove(f.id) };
    });

    app.put("/api/projects/:id/folder", async (req) => {
        const { id } = req.params as { id: string };
        const row = project(id);
        const body = parsePlain(z.object({ folderId: z.string().min(1).max(64).nullable() }).strict(), req.body);
        const actor = who(req);
        const org = (row.organization_id as string | null) ?? null;
        if (!canManage(actor, org)) throw new HttpError(403, CANNOT_CHANGE_FOLDERS);
        if (body.folderId) {
            const f = visibleFolder(req, body.folderId);
            if (f.organizationId !== org) throw new HttpError(409, OTHER_ORGANIZATION_FOLDER);
        }
        folders.setProjectFolder(id, body.folderId);
        return { folderId: body.folderId };
    });

    // ── archive, restore, delete (US-012) ──

    const assertProjectAdmin = (req: Parameters<typeof actorOf>[0], id: string) => {
        const actor = actorOf(req);
        if (actor && !control.projects.isProjectAdmin(actor, id)) throw new HttpError(403, NEEDS_PROJECT_ADMIN);
    };
    const assertNothingRuns = (id: string) => {
        const running = runningWorkOf(p.db, id);
        if (running) throw new HttpError(409, `${STOP_RUN_FIRST} ${running}`);
    };

    app.post("/api/projects/:id/archive", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        assertProjectAdmin(req, id);
        if (isArchived(p.db, id)) throw new HttpError(409, ALREADY_ARCHIVED);
        assertNothingRuns(id);
        archiveProject(p.db, id, actorLabel(who(req)));
        return withSetup(repo.getProject(id)!);
    });

    app.post("/api/projects/:id/unarchive", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        assertProjectAdmin(req, id);
        restoreProject(p.db, id);
        return withSetup(repo.getProject(id)!);
    });

    app.delete("/api/projects/:id", async (req) => {
        const { id } = req.params as { id: string };
        const row = project(id);
        assertProjectAdmin(req, id);
        // Deleting a project deletes its tests: that permission is needed here too, not only the project's settings.
        const deleter = actorOf(req);
        if (deleter && !control.projects.permissionsIn(deleter, id)?.has("ai_studio.tests.delete")) throw new HttpError(403, NEEDS_TESTS_DELETE);
        if (!row.archived_at) throw new HttpError(409, NOT_ARCHIVED);
        const body = parsePlain(z.object({ name: z.string().max(200) }).strict(), req.body);
        if (body.name.trim() !== String(row.name).trim()) throw new HttpError(400, NAME_TO_CONFIRM);
        assertNothingRuns(id);
        let report;
        try {
            report = await deleteProject(p.db, p.store, id);
        } catch (e) {
            req.log.error({ err: e }, "project delete failed");
            throw new HttpError(500, "The project could not be deleted completely: some of its files could not be removed. Nothing else was changed; try again.");
        }
        const actor = who(req);
        control.users.addActivity({
            actorKind: actor.kind,
            actorId: actor.id ?? null,
            actorName: actor.name,
            action: "deleted the project",
            projectId: id,
            path: `/api/projects/${id}`,
            status: 200,
            detail: `${String(row.name)}: ${report.tests} tests, ${report.runs} runs, ${report.files} files (${formatBytes(report.bytes)}) removed`.slice(0, 500),
        });
        return { deleted: true, report };
    });

    // ── a person's own preferences ──

    const personOf = (req: Parameters<typeof actorOf>[0]): string | undefined => {
        const a = actorOf(req);
        return a?.kind === "user" && a.id ? a.id : undefined;
    };
    app.get("/api/me/preferences", async (req) => {
        const id = personOf(req);
        return { preferences: id ? prefs.get(id) : prefs.get(""), saved: Boolean(id), crowd4test: Boolean(actorOf(req) && isCrowd4TestActor(actorOf(req)!)) };
    });
    app.put("/api/me/preferences", async (req) => {
        const id = personOf(req);
        if (!id) throw new HttpError(409, NO_PREFERENCES);
        const body = parsePlain(z.object({ runAlertEmails: z.boolean(), securityEmails: z.boolean(), projectsView: z.enum(["dashboard", "list"]) }).partial().strict(), req.body);
        return { preferences: prefs.set(id, body), saved: true };
    });
}
