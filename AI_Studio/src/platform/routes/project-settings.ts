/**
 * A project's general settings (US-010, US-011) and the organisations list (D-14):
 *
 *   PATCH /api/projects/:id                { name?, description?, platforms?, testingModes?, c4tProjectId? } → the project
 *   GET   /api/projects/:id/setup-check    → { items: [{ key, ok, text }] }   warnings for what the platforms and modes need
 *   GET   /api/projects/:id/c4t-projects   → { available, projects: [{ id, reference, title, status }], c4tProjectId, message? }
 *   GET   /api/organizations               → { organizations: [{ id, name, status }], source: "crowd4test" | "mirror", notice? }
 *
 * Narrowing the platforms or modes loses nothing: the lists are stored as given and the engines recomputed, and every test of a
 * platform or mode turned off stays where it is and keeps showing. The linked Crowd4Test project is a reference only (D-27): it is
 * checked to belong to the project's organisation through Crowd4Test's service, and it grants nobody anything.
 */
import { projectAiGate } from "../ai-config.js";
import { z } from "zod";
import { MobileTargetSchema } from "../../engine/mobile/target.js";
import { isAppUri } from "../../engine/desktop/target.js";
import { getAgentServices } from "../agent-services.js";
import { accessControlOf, actorOf } from "../auth/access.js";
import { currentActor, sideOf } from "../auth/actor.js";
import { C4T_SERVICE_OFF, c4tServiceOf, clientIpOf, type C4tOrganisation } from "../c4t-service.js";
import type { Platform } from "../bootstrap.js";
import type { Row } from "../db.js";
import { HttpError } from "../http-error.js";
import { PlatformsSchema, projectSetupOf, setupItems, TestingModesSchema } from "../project-setup.js";
import { isProjectNameTaken, projectNameTaken } from "../project-folders.js";
import { runsCanStartHere } from "../suite-run.js";
import type { RouteCtx } from "./types.js";

export const NO_ORGANIZATION_TO_LINK = "This project is not part of an organisation, so it cannot be linked to a Crowd4Test project.";
export const OTHER_ORGANIZATION_PROJECT = "Only Crowd4Test projects of this project's organisation can be linked.";
export const C4T_ORGANISATION_UNKNOWN = "Crowd4Test does not know this project's organisation.";

const PatchBody = z
    .object({
        name: z.string().min(1, "A project needs a name.").max(120, "A project name is at most 120 characters."),
        description: z.string().max(1000, "A description is at most 1,000 characters.").nullable(),
        platforms: PlatformsSchema,
        testingModes: TestingModesSchema,
        c4tProjectId: z.string().min(1).max(64).nullable(),
    })
    .partial()
    .strict();

/** A zod parse whose refusal is one plain sentence (the first problem), not the generic "Invalid request". */
export function parsePlain<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
    const r = schema.safeParse(value ?? {});
    if (!r.success) throw new HttpError(400, r.error.issues[0]?.message ?? "Invalid request");
    return r.data;
}

/** A project row with the camelCase platforms, testing modes and engines beside its snake_case columns. */
export const withSetup = (row: Row): Row => ({ ...row, ...projectSetupOf(row) });

export interface LinkedC4tProject {
    id: string;
    /** Null while Crowd4Test cannot say (the service is off or unreachable, or the project is gone there). */
    reference: string | null;
    title: string | null;
}

/** The linked Crowd4Test project of a row, as GET /api/projects/:id shows it (from the 5-minute cache of the service). */
export async function linkedC4tProject(p: Platform, row: Row, clientIp?: string): Promise<LinkedC4tProject | null> {
    const id = row.c4t_project_id as string | null | undefined;
    if (!id) return null;
    const service = c4tServiceOf(p);
    const org = row.organization_id as string | null | undefined;
    const unknown = { id, reference: null, title: null };
    if (!service || !org) return unknown;
    try {
        const found = (await service.projectsOf(org, clientIp))?.find((c) => c.id === id);
        return found ? { id, reference: found.reference, title: found.title } : unknown;
    } catch {
        return unknown;
    }
}

export function registerProjectSettingsRoutes(ctx: RouteCtx): void {
    const { app, p, repo, project } = ctx;
    const control = accessControlOf(app);

    app.patch("/api/projects/:id", async (req) => {
        const { id } = req.params as { id: string };
        const row = project(id);
        const body = parsePlain(PatchBody, req.body);
        // A new name must not be one another project of the organisation already has (project-folders.ts).
        if (body.name !== undefined && body.name.trim().toLowerCase() !== String(row.name).trim().toLowerCase() && isProjectNameTaken(p.db, body.name, (row.organization_id as string | null) ?? null, id)) {
            throw new HttpError(409, projectNameTaken(body.name));
        }
        let linked: { reference: string; title: string } | undefined;
        if (body.c4tProjectId) {
            const service = c4tServiceOf(p);
            if (!service) throw new HttpError(409, C4T_SERVICE_OFF);
            const org = row.organization_id as string | null;
            if (!org) throw new HttpError(409, NO_ORGANIZATION_TO_LINK);
            const theirs = await service.projectsOf(org, clientIpOf(req));
            if (!theirs) throw new HttpError(409, C4T_ORGANISATION_UNKNOWN);
            const found = theirs.find((c) => c.id === body.c4tProjectId);
            if (!found) throw new HttpError(403, OTHER_ORGANIZATION_PROJECT);
            linked = found;
        }
        const updated = repo.updateProject(id, body)!;
        if (body.c4tProjectId !== undefined && body.c4tProjectId !== (row.c4t_project_id ?? null)) {
            const actor = actorOf(req) ?? currentActor();
            control.users.addActivity({
                actorKind: actor.kind,
                actorId: actor.id ?? null,
                actorName: actor.name,
                action: body.c4tProjectId ? "linked a Crowd4Test project" : "unlinked the Crowd4Test project",
                projectId: id,
                path: `/api/projects/${id}`,
                status: 200,
                detail: linked ? `${linked.reference} ${linked.title}`.trim().slice(0, 500) : row.c4t_project_id ? `Was ${String(row.c4t_project_id)}` : null,
            });
        }
        return { ...withSetup(updated), c4tProject: await linkedC4tProject(p, updated, clientIpOf(req)) };
    });

    app.get("/api/projects/:id/setup-check", async (req) => {
        const { id } = req.params as { id: string };
        const row = project(id);
        const latest = repo.getLatestApplicationPublic(id);
        const mobile = MobileTargetSchema.safeParse(latest?.config?.mobile);
        const m = mobile.success ? mobile.data : undefined;
        const url = latest?.url as string | undefined;
        const hasEnvironment = Boolean(p.db.get("SELECT 1 AS x FROM project_environments WHERE project_id = ? LIMIT 1", id));
        const agents = getAgentServices(p);
        const runner = agents.runnerStatus(id);
        return {
            items: setupItems({
                setup: projectSetupOf(row),
                hasWebAddress: hasEnvironment || Boolean(url && !isAppUri(url) && /^https?:/i.test(url)),
                hasAndroidApp: Boolean(m?.appPackage || m?.apkPath),
                hasIosApp: Boolean(m?.iosBundleId),
                canRunIos: runner.canRunIos,
                aiConfigured: (await projectAiGate(p, id)).ok,
                runner: runner.runOn === "platform" ? { runOn: "platform" } : { runOn: "agent", online: agents.eligibleAgents(id).length },
                runsHere: runsCanStartHere(p).ok,
            }),
        };
    });

    const C4T_PROJECTS_NOT_FOR_YOU = "Linking a Crowd4Test project is done by the organisation's own people or Crowd4Test staff.";
    app.get("/api/projects/:id/c4t-projects", async (req) => {
        const { id } = req.params as { id: string };
        const row = project(id);
        const c4tProjectId = (row.c4t_project_id as string | null) ?? null;
        const service = c4tServiceOf(p);
        if (!service) return { available: false, projects: [], c4tProjectId, message: C4T_SERVICE_OFF };
        const org = row.organization_id as string | null;
        if (!org) return { available: false, projects: [], c4tProjectId, message: NO_ORGANIZATION_TO_LINK };
        // The organisation's whole list of Crowd4Test projects: for its own people and for staff, never for a tester (or another organisation).
        const actor = currentActor();
        if (sideOf(actor) === "tester" || (sideOf(actor) === "customer" && actor.organizationId !== org)) throw new HttpError(403, C4T_PROJECTS_NOT_FOR_YOU);
        const theirs = await service.projectsOf(org, clientIpOf(req));
        if (!theirs) return { available: false, projects: [], c4tProjectId, message: C4T_ORGANISATION_UNKNOWN };
        return { available: true, projects: theirs, c4tProjectId };
    });

    /**
     * Customers see their own organisation, staff (and local accounts that reach every project) all of them, everyone else none.
     * With the service, names and statuses come from Crowd4Test and refresh the mirror; without it (or while it is down, with a
     * notice), the mirror answers, whose names may still be missing.
     */
    app.get("/api/organizations", async (req) => {
        const actor = actorOf(req);
        const side = actor ? sideOf(actor) : "local";
        const own = side === "customer" ? (actor?.organizationId ?? null) : undefined;
        const everything = side === "admin" || (side === "local" && control.projects.allowed(actor) === null);
        if (side === "tester" || (own === undefined && !everything) || own === null) return { organizations: [], source: c4tServiceOf(p) ? "crowd4test" : "mirror" };
        const keep = (o: { id: string }) => own === undefined || o.id === own;
        const store = control.projects.store;
        const service = c4tServiceOf(p);
        const fromMirror = (notice?: string) => ({
            organizations: store.organizations().filter(keep).map((o) => ({ id: o.id, name: o.name, status: o.status })),
            source: "mirror" as const,
            ...(notice ? { notice } : {}),
        });
        if (!service) return fromMirror();
        let list: C4tOrganisation[];
        try {
            list = own ? [(await service.organisation(own, clientIpOf(req))) ?? { id: own, name: own, status: "" }] : await service.organisations(clientIpOf(req));
        } catch (e) {
            if (e instanceof HttpError && e.status === 503) return fromMirror(e.message);
            throw e;
        }
        for (const o of list) store.recordOrganization(o.id, o.name, o.status);
        return { organizations: list.filter(keep).map((o) => ({ id: o.id, name: o.name, status: o.status })), source: "crowd4test" as const };
    });
}
