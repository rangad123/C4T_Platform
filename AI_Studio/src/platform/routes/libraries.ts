/**
 * Reusable libraries (store in library-store.ts): an organisation's reusable steps, helpers and shared elements, in nested folders,
 * versioned, and used by its projects.
 *
 *   GET    /api/libraries?organization=<id|internal>     → { organizations, organization, canChange, folders, items }
 *   POST   /api/libraries/folders                        { organizationId, parentId?, name } → the folder
 *   PATCH  /api/libraries/folders/:folderId              { name?, parentId? } → the folder (rename, move)
 *   DELETE /api/libraries/folders/:folderId              → { removed }   an empty folder only
 *   POST   /api/libraries/items                          { organizationId, folderId?, kind, name, description?, content, note? } → the item
 *   GET    /api/libraries/items/:itemId                  → { item, content, versions, usedBy, canChange }
 *   PATCH  /api/libraries/items/:itemId                  { name?, description?, folderId? } → the item (rename, move)
 *   PUT    /api/libraries/items/:itemId/content          { content, note?, expectedVersion? } → { item, added }   a new version
 *   GET    /api/libraries/items/:itemId/versions/:version → one version's content
 *   DELETE /api/libraries/items/:itemId                  → { removed }   the projects' copies stay theirs
 *   GET    /api/projects/:id/library                     → the project's organisation's library, with what this project uses
 *   POST   /api/projects/:id/library/use                 { itemId } → a copy of the latest version in the project
 *   POST   /api/projects/:id/library/update              { itemId, replaceLocalChanges? } → the project's copy brought to the latest version
 *   POST   /api/projects/:id/library/publish             { kind, name, itemId?, folderId?, description?, note? } → a new item or version
 *
 * Who reads: anyone with access in the organisation (a customer: their own; Crowd4Test staff: the organisations of the projects they
 * reach, every one for an administrator); a crowd tester reads only the items their own projects use. Who changes a library: "write tests" plus standing in the whole organisation, because a
 * change is offered to every project of it: a customer of that organisation, a Crowd4Test administrator, or a local account with
 * every project. A crowd tester never changes a library. Anything of an organisation the person can't read answers 404.
 *
 * A project takes a copy (it never runs library content directly): the copy goes through the project's own routes (reusable steps,
 * helpers, shared elements), as the same person, so it is checked, rendered and re-validated exactly like an edit made in the project.
 */
import { z } from "zod";
import { checkBlockInput } from "../../engine/blocks/index.js";
import { blockSecretProblems, codeSecretProblems } from "../../engine/builder/index.js";
import { checkScript, describeErrors } from "../../engine/custom/guard.js";
import { isHelperName, MAX_HELPER_BYTES } from "../../engine/custom/helpers.js";
import { printStep } from "../../engine/dsl/printer.js";
import { checkElement, ELEMENT_KINDS } from "../../engine/locators/index.js";
import { accessControlOf, actorOf } from "../auth/access.js";
import { actorLabel, currentActor, permissionsOf, sideOf, type Actor } from "../auth/actor.js";
import { visibleProjectsOf } from "../auth/project-scope.js";
import { BlockStore } from "../block-store.js";
import { CustomScriptStore } from "../custom-script-store.js";
import { HttpError } from "../http-error.js";
import {
    FOLDER_INTO_ITSELF,
    FOLDER_NOT_EMPTY,
    FOLDER_TOO_DEEP,
    fingerprintOf,
    ITEM_KINDS,
    KIND_WORDS,
    LIBRARY_FOLDER_NOT_FOUND,
    LIBRARY_ITEM_NOT_FOUND,
    libraryFolderTaken,
    libraryItemTaken,
    LibraryStore,
    MAX_FOLDER_DEPTH,
    MAX_LIBRARY_FOLDERS,
    MAX_LIBRARY_ITEMS,
    MAX_VERSIONS_SHOWN,
    OTHER_LIBRARY,
    type ItemKind,
    type LibraryFolder,
    type LibraryItem,
} from "../library-store.js";
import { LocatorStore } from "../locator-store.js";
import { parsePlain } from "./project-settings.js";
import type { RouteCtx } from "./types.js";

export const CANNOT_CHANGE_LIBRARY =
    "You can't change this library. Changing a library needs “write tests” and a place in the whole organisation (a person of the organisation, or Crowd4Test staff with every project), because every project of the organisation can use it.";
export const INTERNAL = "internal";
export const ALREADY_USED = "This project already has a copy of it. Use Update to bring it to the latest version.";
export const LOCAL_CHANGES = (name: string, version: number) =>
    `This project changed its copy of “${name}” after it took version ${version}. Publish the project's copy to the library first, or update anyway to replace the project's changes.`;
export const NOT_USED_YET = "This project does not use this library item yet. Add it first.";
export const localNameTaken = (kind: ItemKind, name: string) =>
    `This project already has its own ${KIND_WORDS[kind]} named “${name.slice(0, 80)}”. Rename the project's one first, or publish it to the library as a new version.`;
export const notInProject = (kind: ItemKind, name: string) => `This project has no ${KIND_WORDS[kind]} named “${name.slice(0, 80)}”.`;

const Name = z.string().trim().min(1, "Give it a name.").max(80, "A name is at most 80 characters.");
const Id = z.string().min(1).max(64);
const OrgId = z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, "An organization id is letters, digits, - and _ (at most 64).")
    .nullable();
const Kind = z.enum(ITEM_KINDS);
const Note = z.string().max(500).optional();

type Req = Parameters<typeof actorOf>[0];
type Org = string | null;

/** Checks an item's content the way the project's own routes check that kind (shape, names, typed secrets, the code guard) and returns it cleaned. */
export function checkContent(kind: ItemKind, name: string, raw: unknown): Record<string, unknown> {
    const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    if (kind === "steps") {
        const c = checkBlockInput({ name, description: o.description, kind: o.kind ?? "any", params: o.params ?? [], steps: o.steps });
        if (!c.ok) throw new HttpError(400, c.error);
        const secrets = blockSecretProblems(c.block);
        if (secrets.length) throw new HttpError(400, `The reusable steps hold what looks like a real secret. ${secrets[0]}`);
        return { ...(c.block.description ? { description: c.block.description } : {}), kind: c.block.kind, params: c.block.params, steps: c.block.steps };
    }
    if (kind === "helper") {
        if (!isHelperName(name)) throw new HttpError(400, "Helper names use lower-case letters, digits and hyphens (for example login-steps), start with a letter and are at most 41 characters.");
        if (typeof o.content !== "string" || !o.content.trim()) throw new HttpError(400, "A helper needs its code (content).");
        if (Buffer.byteLength(o.content, "utf8") > MAX_HELPER_BYTES) throw new HttpError(413, `A helper can be at most ${MAX_HELPER_BYTES / 1000} KB.`);
        const r = checkScript(o.content, { kind: "helper" });
        if (!r.ok) throw new HttpError(422, `The helper was not saved: ${describeErrors(r.diagnostics)}`, r.diagnostics);
        const secrets = codeSecretProblems(o.content);
        if (secrets.length) throw new HttpError(400, `The helper holds what looks like a real secret. ${secrets[0]}`);
        return { content: o.content };
    }
    const c = checkElement({ name, kind: o.kind, locator: o.locator, ...(o.page ? { page: o.page } : {}), ...(o.notes ? { notes: o.notes } : {}), ...(o.alternatives !== undefined ? { alternatives: o.alternatives } : {}) });
    if (!c.ok) throw new HttpError(400, c.error);
    const e = c.element;
    return { kind: e.kind, locator: e.locator, ...(e.page ? { page: e.page } : {}), ...(e.notes ? { notes: e.notes } : {}), ...(e.alternatives?.length ? { alternatives: e.alternatives } : {}) };
}

/** The steps of a steps item in plain words, one line each (what the page shows instead of the raw steps). */
export const stepsInWords = (content: unknown): string[] | undefined => {
    const steps = (content as { steps?: unknown } | null)?.steps;
    if (!Array.isArray(steps)) return undefined;
    return steps.map((st) => {
        try {
            return printStep(st as Parameters<typeof printStep>[0]) ?? String((st as { action?: string }).action ?? "step");
        } catch {
            return String((st as { action?: string }).action ?? "step");
        }
    });
};

export function registerLibraryRoutes(ctx: RouteCtx): void {
    const { app, p, project } = ctx;
    const control = accessControlOf(app);
    const lib = new LibraryStore(p.db);
    const blocks = new BlockStore(p.db);
    const helpers = new CustomScriptStore(p.db);
    const elements = new LocatorStore(p.db);
    const crowd4test = Boolean(p.config.C4T_API_ORIGIN?.trim() || p.config.C4T_SITE_URL?.trim());

    const who = (req: Req): Actor => actorOf(req) ?? currentActor();
    const orgName = (id: Org): string => (id ? (control.projects.store.organization(id)?.name ?? id) : crowd4test ? "Crowd4Test internal" : "This installation");

    /** The organisations whose library the actor may read. */
    const readable = (req: Req, actor: Actor): Org[] => {
        const side = sideOf(actor);
        if (side === "customer") return actor.organizationId ? [actor.organizationId] : [];
        const visible = visibleProjectsOf(req, actor);
        const all: Org[] = [null, ...control.projects.store.organizations().map((o) => o.id)];
        if (!visible || side === "admin") return all;
        const orgs = new Set<Org>(
            p.db
                .all<{ id: string; organization_id: string | null }>("SELECT id, organization_id FROM projects")
                .filter((r) => visible.has(r.id))
                .map((r) => r.organization_id ?? null),
        );
        return all.filter((o) => orgs.has(o));
    };
    const canRead = (req: Req, org: Org): boolean => readable(req, who(req)).includes(org);
    /** A crowd tester reads only the items their own projects use (null: no narrowing, for everyone else). */
    const testerItems = (req: Req, actor: Actor): Set<string> | null => {
        if (sideOf(actor) !== "tester") return null;
        const visible = visibleProjectsOf(req, actor);
        return new Set([...(visible?.keys() ?? [])].flatMap((pid) => lib.usesInProject(pid).map((u) => u.itemId)));
    };
    /** The items of a library the person may read, and the folders on the way to them (all of them for anyone but a crowd tester). */
    const shownOf = (req: Req, org: Org): { items: LibraryItem[]; folders: LibraryFolder[] } => {
        const only = testerItems(req, who(req));
        const items = lib.items(org);
        const folders = lib.folders(org);
        if (!only) return { items, folders };
        const kept = items.filter((i) => only.has(i.id));
        const byId = new Map(folders.map((f) => [f.id, f]));
        const onPath = new Set<string>();
        for (const i of kept) for (let f = i.folderId ? byId.get(i.folderId) : undefined; f && !onPath.has(f.id); f = f.parentId ? byId.get(f.parentId) : undefined) onPath.add(f.id);
        return { items: kept, folders: folders.filter((f) => onPath.has(f.id)) };
    };
    /** Whether the actor may change this organisation's library. */
    const canChange = (actor: Actor, org: Org): boolean => {
        if (!permissionsOf(actor).has("ai_studio.tests.write")) return false;
        const side = sideOf(actor);
        if (side === "customer") return Boolean(actor.organizationId) && org === actor.organizationId;
        if (side === "tester") return false;
        if (side === "admin") return true;
        return control.projects.allowed(actor) === null;
    };
    const mustChange = (req: Req, org: Org) => {
        if (!canChange(who(req), org)) throw new HttpError(403, CANNOT_CHANGE_LIBRARY);
    };

    const folderSeen = (req: Req, id: string): LibraryFolder => {
        const f = lib.folder(id);
        if (!f || !canRead(req, f.organizationId)) throw new HttpError(404, LIBRARY_FOLDER_NOT_FOUND);
        return f;
    };
    const itemSeen = (req: Req, id: string): LibraryItem => {
        const i = lib.item(id);
        if (!i || !canRead(req, i.organizationId)) throw new HttpError(404, LIBRARY_ITEM_NOT_FOUND);
        const only = testerItems(req, who(req));
        if (only && !only.has(i.id)) throw new HttpError(404, LIBRARY_ITEM_NOT_FOUND);
        return i;
    };
    /** A folder to put something in: one of the same library (null: the top level). */
    const targetFolder = (req: Req, org: Org, folderId: string | null | undefined): string | null => {
        if (!folderId) return null;
        const f = folderSeen(req, folderId);
        if (f.organizationId !== org) throw new HttpError(409, OTHER_LIBRARY);
        return f.id;
    };

    /** The projects that use an item: the ones the person can see by name, the others counted. */
    const usersOf = (req: Req, item: LibraryItem) => {
        const visible = visibleProjectsOf(req, who(req));
        const uses = lib.usesOfItem(item.id);
        const shown = uses.filter((u) => !visible || visible.has(u.projectId));
        return {
            projects: shown.map((u) => ({ projectId: u.projectId, projectName: String(p.repo.getProject(u.projectId)?.name ?? ""), version: u.version, localName: u.localName, updateAvailable: u.version < item.version })),
            otherProjects: uses.length - shown.length,
        };
    };

    // ── the library itself ──

    app.get("/api/libraries", async (req) => {
        const actor = who(req);
        const orgs = readable(req, actor);
        const asked = (req.query as { organization?: string } | undefined)?.organization;
        const wanted: Org | undefined = asked === undefined || asked === "" ? undefined : asked === INTERNAL ? null : asked;
        if (wanted !== undefined && !orgs.includes(wanted)) throw new HttpError(404, "Library not found");
        const org = wanted !== undefined ? wanted : (orgs[0] ?? null);
        const organizations = orgs.map((id) => ({ id, name: orgName(id), canChange: canChange(actor, id) }));
        if (!orgs.length) return { organizations, organization: null, canChange: false, folders: [], items: [] };
        const counts = lib.useCounts(org);
        const shown = shownOf(req, org);
        return {
            organizations,
            organization: { id: org, name: orgName(org) },
            canChange: canChange(actor, org),
            folders: shown.folders,
            items: shown.items.map((i) => ({ ...i, usedBy: counts.get(i.id) ?? 0 })),
            limits: { depth: MAX_FOLDER_DEPTH, folders: MAX_LIBRARY_FOLDERS, items: MAX_LIBRARY_ITEMS },
        };
    });

    app.post("/api/libraries/folders", async (req, reply) => {
        const body = parsePlain(z.object({ organizationId: OrgId, parentId: Id.nullable().optional(), name: Name }).strict(), req.body);
        const org = body.organizationId;
        if (!canRead(req, org)) throw new HttpError(404, "Library not found");
        mustChange(req, org);
        const parentId = targetFolder(req, org, body.parentId);
        if (lib.depth(parentId) + 1 > MAX_FOLDER_DEPTH) throw new HttpError(409, FOLDER_TOO_DEEP);
        if (lib.folderNameTaken(org, parentId, body.name)) throw new HttpError(409, libraryFolderTaken(body.name));
        if (lib.countFolders(org) >= MAX_LIBRARY_FOLDERS) throw new HttpError(409, `A library can have at most ${MAX_LIBRARY_FOLDERS} folders. Remove one first.`);
        if (org) control.projects.store.ensureOrganization(org);
        return reply.code(201).send(lib.createFolder({ organizationId: org, parentId, name: body.name, createdBy: actorLabel(who(req)) }));
    });

    app.patch("/api/libraries/folders/:folderId", async (req) => {
        const f = folderSeen(req, (req.params as { folderId: string }).folderId);
        const body = parsePlain(z.object({ name: Name.optional(), parentId: Id.nullable().optional() }).strict(), req.body);
        mustChange(req, f.organizationId);
        const parentId = body.parentId === undefined ? f.parentId : targetFolder(req, f.organizationId, body.parentId);
        if (parentId && lib.isWithin(parentId, f.id)) throw new HttpError(409, FOLDER_INTO_ITSELF);
        if (parentId !== f.parentId && lib.depth(parentId) + lib.height(f.id) > MAX_FOLDER_DEPTH) throw new HttpError(409, FOLDER_TOO_DEEP);
        const name = body.name ?? f.name;
        if (lib.folderNameTaken(f.organizationId, parentId, name, f.id)) throw new HttpError(409, libraryFolderTaken(name));
        return lib.updateFolder(f.id, { name, parentId });
    });

    app.delete("/api/libraries/folders/:folderId", async (req) => {
        const f = folderSeen(req, (req.params as { folderId: string }).folderId);
        mustChange(req, f.organizationId);
        if (!lib.isEmpty(f.id)) throw new HttpError(409, FOLDER_NOT_EMPTY);
        lib.removeFolder(f.id);
        return { removed: true };
    });

    // ── items ──

    const itemView = (req: Req, i: LibraryItem) => {
        const versions = lib.versions(i.id);
        const visible = visibleProjectsOf(req, who(req));
        return {
            item: i,
            content: versions[0]?.content ?? null,
            ...(i.kind === "steps" ? { stepsText: stepsInWords(versions[0]?.content) } : {}),
            versions: versions.slice(0, MAX_VERSIONS_SHOWN).map((v) => {
                const src = v.sourceProjectId && (!visible || visible.has(v.sourceProjectId)) ? p.repo.getProject(v.sourceProjectId) : undefined;
                return { version: v.version, note: v.note, createdBy: v.createdBy, createdAt: v.createdAt, fromProject: v.sourceProjectId ? (src ? { id: v.sourceProjectId, name: String(src.name) } : { id: null, name: null }) : null };
            }),
            usedBy: usersOf(req, i),
            canChange: canChange(who(req), i.organizationId),
        };
    };

    app.post("/api/libraries/items", async (req, reply) => {
        const body = parsePlain(
            z.object({ organizationId: OrgId, folderId: Id.nullable().optional(), kind: Kind, name: Name, description: z.string().max(2000).optional(), content: z.unknown().optional(), note: Note }).strict(),
            req.body,
        );
        const org = body.organizationId;
        if (!canRead(req, org)) throw new HttpError(404, "Library not found");
        mustChange(req, org);
        const folderId = targetFolder(req, org, body.folderId);
        const content = checkContent(body.kind, body.name, body.content);
        if (lib.itemByName(org, body.kind, body.name)) throw new HttpError(409, libraryItemTaken(body.kind, body.name));
        if (lib.countItems(org) >= MAX_LIBRARY_ITEMS) throw new HttpError(409, `A library can have at most ${MAX_LIBRARY_ITEMS} items. Remove one first.`);
        if (org) control.projects.store.ensureOrganization(org);
        const description = body.description ?? (typeof content.description === "string" ? content.description : "");
        const item = lib.createItem({ organizationId: org, folderId, kind: body.kind, name: body.name, description, content, note: body.note ?? "", sourceProjectId: null, createdBy: actorLabel(who(req)) });
        return reply.code(201).send(itemView(req, item));
    });

    app.get("/api/libraries/items/:itemId", async (req) => itemView(req, itemSeen(req, (req.params as { itemId: string }).itemId)));

    app.get("/api/libraries/items/:itemId/versions/:version", async (req) => {
        const { itemId, version } = req.params as { itemId: string; version: string };
        const i = itemSeen(req, itemId);
        const v = lib.version(i.id, Number(version));
        if (!/^\d{1,6}$/.test(version) || !v) throw new HttpError(404, "Version not found");
        return { item: i, version: v.version, content: v.content, ...(i.kind === "steps" ? { stepsText: stepsInWords(v.content) } : {}), note: v.note, createdBy: v.createdBy, createdAt: v.createdAt };
    });

    app.patch("/api/libraries/items/:itemId", async (req) => {
        const i = itemSeen(req, (req.params as { itemId: string }).itemId);
        const body = parsePlain(z.object({ name: Name.optional(), description: z.string().max(2000).optional(), folderId: Id.nullable().optional() }).strict(), req.body);
        mustChange(req, i.organizationId);
        const folderId = body.folderId === undefined ? i.folderId : targetFolder(req, i.organizationId, body.folderId);
        if (body.name !== undefined && body.name.trim() !== i.name) {
            // The name has to stay valid for the kind (a helper name is a module name); the content is unchanged.
            checkContent(i.kind, body.name, lib.version(i.id, i.version)?.content);
            const other = lib.itemByName(i.organizationId, i.kind, body.name);
            if (other && other.id !== i.id) throw new HttpError(409, libraryItemTaken(i.kind, body.name));
        }
        return itemView(req, lib.updateItem(i.id, { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.description !== undefined ? { description: body.description } : {}), folderId })!);
    });

    app.put("/api/libraries/items/:itemId/content", async (req) => {
        const i = itemSeen(req, (req.params as { itemId: string }).itemId);
        const body = parsePlain(z.object({ content: z.unknown().optional(), note: Note, expectedVersion: z.number().int().positive().optional() }).strict(), req.body);
        mustChange(req, i.organizationId);
        const content = checkContent(i.kind, i.name, body.content);
        const r = lib.addVersion(i.id, { content, note: body.note ?? "", sourceProjectId: null, createdBy: actorLabel(who(req)), ...(body.expectedVersion !== undefined ? { expectedVersion: body.expectedVersion } : {}) });
        if (r === "stale") throw new HttpError(409, "Someone added a version since you opened it. Reload it and try again.");
        return { ...itemView(req, r.item), added: r.added };
    });

    app.delete("/api/libraries/items/:itemId", async (req) => {
        const i = itemSeen(req, (req.params as { itemId: string }).itemId);
        mustChange(req, i.organizationId);
        const uses = lib.usesOfItem(i.id).length;
        lib.removeItem(i.id);
        return { removed: true, projectsKeepTheirCopy: uses };
    });

    // ── a project and its organisation's library ──

    /** What the project has under that kind and name now, in the library's content shape, or undefined. */
    const localContent = (projectId: string, kind: ItemKind, name: string): { content: Record<string, unknown>; id?: string } | undefined => {
        if (kind === "steps") {
            const b = blocks.get(projectId, name);
            return b ? { content: { ...(b.description ? { description: b.description } : {}), kind: b.kind, params: b.params, steps: b.steps } } : undefined;
        }
        if (kind === "helper") {
            const h = isHelperName(name) ? helpers.getHelper(projectId, name) : undefined;
            return h ? { content: { content: h.content } } : undefined;
        }
        const e = elements.getByName(projectId, name);
        return e ? { id: e.id, content: { kind: e.kind, locator: e.locator, ...(e.page ? { page: e.page } : {}), ...(e.notes ? { notes: e.notes } : {}), ...(e.alternatives?.length ? { alternatives: e.alternatives } : {}) } } : undefined;
    };
    const localNames = (projectId: string) => ({
        steps: blocks.list(projectId).map((b) => b.name),
        helpers: helpers.listHelpers(projectId).map((h) => h.name),
        elements: elements.list(projectId).map((e) => e.name),
    });

    /**
     * Writes a copy into the project through the project's own route, as the same person: the same permission check, the same checks of
     * the content, the same re-rendering and re-validation of the tests that use it. Answers what that route answered.
     */
    const throughProject = async (req: Req, method: "POST" | "PUT", url: string, payload: unknown): Promise<{ status: number; body: any }> => {
        const headers: Record<string, string> = {};
        // Every header of the person's request (session, CSRF token, Origin with its Host), except those that describe the body.
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["content-length", "content-type", "connection", "transfer-encoding", "accept-encoding"].includes(k)) headers[k] = v;
        const r = await app.inject({ method, url, headers, payload: payload as object });
        let body: unknown = r.body;
        try {
            body = r.body ? JSON.parse(r.body) : null;
        } catch {
            // not JSON: passed on as text
        }
        return { status: r.statusCode, body };
    };
    const writeCopy = (req: Req, projectId: string, kind: ItemKind, name: string, content: Record<string, unknown>, existingId?: string, exists = false) => {
        const enc = encodeURIComponent(name);
        // An update replaces the whole copy: a description the library version does not have is cleared too.
        if (kind === "steps") return exists ? throughProject(req, "PUT", `/api/projects/${projectId}/blocks/${enc}`, { description: null, ...content }) : throughProject(req, "POST", `/api/projects/${projectId}/blocks`, { name, ...content });
        if (kind === "helper") return throughProject(req, "PUT", `/api/projects/${projectId}/helpers/${enc}`, { content: content.content });
        if (exists) {
            const { kind: _kind, ...rest } = content;
            return throughProject(req, "PUT", `/api/projects/${projectId}/objects/${existingId}`, { page: null, notes: null, alternatives: [], ...rest });
        }
        return throughProject(req, "POST", `/api/projects/${projectId}/objects`, { name, ...content });
    };
    const projectOrg = (projectId: string): Org => (project(projectId).organization_id as string | null) ?? null;
    /** An item of the project's own organisation, or the same 404 as an unknown one. */
    const itemForProject = (req: Req, projectId: string, itemId: string): LibraryItem => {
        const i = itemSeen(req, itemId);
        if (i.organizationId !== projectOrg(projectId)) throw new HttpError(404, LIBRARY_ITEM_NOT_FOUND);
        return i;
    };

    app.get("/api/projects/:id/library", async (req) => {
        const { id } = req.params as { id: string };
        const org = projectOrg(id);
        const uses = new Map(lib.usesInProject(id).map((u) => [u.itemId, u]));
        const names = localNames(id);
        const has = (kind: ItemKind, name: string) => (kind === "steps" ? names.steps : kind === "helper" ? names.helpers : names.elements).some((n) => n.toLowerCase() === name.toLowerCase());
        const shown = shownOf(req, org);
        const items = shown.items.map((i) => {
            const u = uses.get(i.id);
            const local = u ? localContent(id, i.kind, u.localName) : undefined;
            return {
                ...i,
                use: u ? { version: u.version, localName: u.localName, inProject: Boolean(local), updateAvailable: u.version < i.version, changedHere: Boolean(local) && fingerprintOf(local!.content) !== u.fingerprint } : null,
                nameTakenHere: !u && has(i.kind, i.name),
            };
        });
        const published = (kind: ItemKind) => new Map([...uses.values()].filter((u) => lib.item(u.itemId)?.kind === kind).map((u) => [u.localName.toLowerCase(), u.itemId]));
        const local = (kind: ItemKind, list: string[]) => {
            const m = published(kind);
            return list.map((name) => ({ name, itemId: m.get(name.toLowerCase()) ?? null }));
        };
        return {
            organization: { id: org, name: orgName(org) },
            canPublish: canChange(who(req), org),
            folders: shown.folders,
            items,
            local: { steps: local("steps", names.steps), helper: local("helper", names.helpers), element: local("element", names.elements) },
        };
    });

    app.post("/api/projects/:id/library/use", async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = parsePlain(z.object({ itemId: Id }).strict(), req.body);
        const i = itemForProject(req, id, body.itemId);
        const use = lib.usesInProject(id).find((u) => u.itemId === i.id);
        const name = use?.localName ?? i.name;
        if (localContent(id, i.kind, name)) throw new HttpError(409, use ? ALREADY_USED : localNameTaken(i.kind, name));
        const v = lib.version(i.id, i.version)!;
        const r = await writeCopy(req, id, i.kind, name, v.content as Record<string, unknown>);
        if (r.status >= 400) return reply.code(r.status).send(r.body);
        const local = localContent(id, i.kind, name);
        if (!local) throw new HttpError(500, "The copy was not stored. Nothing else was changed; try again.");
        lib.recordUse({ itemId: i.id, projectId: id, version: i.version, localName: name, fingerprint: fingerprintOf(local.content), by: actorLabel(who(req)) });
        return reply.code(201).send({ item: i, version: i.version, localName: name, project: r.body });
    });

    app.post("/api/projects/:id/library/update", async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = parsePlain(z.object({ itemId: Id, replaceLocalChanges: z.boolean().optional() }).strict(), req.body);
        const i = itemForProject(req, id, body.itemId);
        const use = lib.usesInProject(id).find((u) => u.itemId === i.id);
        if (!use) throw new HttpError(409, NOT_USED_YET);
        const local = localContent(id, i.kind, use.localName);
        if (local && use.version >= i.version && fingerprintOf(local.content) === use.fingerprint) return { item: i, version: use.version, localName: use.localName, upToDate: true };
        if (local && fingerprintOf(local.content) !== use.fingerprint && !body.replaceLocalChanges) throw new HttpError(409, LOCAL_CHANGES(use.localName, use.version), { changedHere: true });
        const v = lib.version(i.id, i.version)!;
        const content = v.content as Record<string, unknown>;
        if (i.kind === "element" && local && local.content.kind !== content.kind) throw new HttpError(409, "The kind of a shared element can't be changed. Delete the project's copy and add the library item again.");
        const r = await writeCopy(req, id, i.kind, use.localName, content, local?.id, Boolean(local));
        if (r.status >= 400) return reply.code(r.status).send(r.body);
        const now = localContent(id, i.kind, use.localName);
        if (!now) throw new HttpError(500, "The copy was not stored. Nothing else was changed; try again.");
        lib.recordUse({ itemId: i.id, projectId: id, version: i.version, localName: use.localName, fingerprint: fingerprintOf(now.content), by: actorLabel(who(req)) });
        return { item: i, version: i.version, localName: use.localName, upToDate: false, project: r.body };
    });

    app.post("/api/projects/:id/library/publish", async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = parsePlain(
            z.object({ kind: Kind, name: z.string().min(1).max(200), itemId: Id.optional(), folderId: Id.nullable().optional(), description: z.string().max(2000).optional(), note: Note }).strict(),
            req.body,
        );
        const org = projectOrg(id);
        mustChange(req, org);
        const local = localContent(id, body.kind, body.name);
        if (!local) throw new HttpError(404, notInProject(body.kind, body.name));
        const localName = body.kind === "helper" ? body.name : (body.kind === "steps" ? blocks.get(id, body.name)?.name : elements.getByName(id, body.name)?.name) ?? body.name;
        const by = actorLabel(who(req));
        let item: LibraryItem;
        let added = true;
        if (body.itemId) {
            const target = itemForProject(req, id, body.itemId);
            if (target.kind !== body.kind) throw new HttpError(409, `That library item is ${KIND_WORDS[target.kind]}, not ${KIND_WORDS[body.kind]}.`);
            const content = checkContent(target.kind, target.name, local.content);
            const r = lib.addVersion(target.id, { content, note: body.note ?? "", sourceProjectId: id, createdBy: by });
            if (r === "stale") throw new HttpError(409, "Someone added a version since you opened it. Reload it and try again.");
            item = r.item;
            added = r.added;
        } else {
            const content = checkContent(body.kind, localName, local.content);
            if (lib.itemByName(org, body.kind, localName)) throw new HttpError(409, libraryItemTaken(body.kind, localName));
            if (lib.countItems(org) >= MAX_LIBRARY_ITEMS) throw new HttpError(409, `A library can have at most ${MAX_LIBRARY_ITEMS} items. Remove one first.`);
            const folderId = targetFolder(req, org, body.folderId);
            if (org) control.projects.store.ensureOrganization(org);
            const description = body.description ?? (typeof content.description === "string" ? content.description : "");
            item = lib.createItem({ organizationId: org, folderId, kind: body.kind, name: localName, description, content, note: body.note ?? "", sourceProjectId: id, createdBy: by });
        }
        // The project's copy is the published version now: it uses that version, unchanged.
        lib.recordUse({ itemId: item.id, projectId: id, version: item.version, localName, fingerprint: fingerprintOf(local.content), by });
        return reply.code(body.itemId ? 200 : 201).send({ item, version: item.version, added });
    });
}
