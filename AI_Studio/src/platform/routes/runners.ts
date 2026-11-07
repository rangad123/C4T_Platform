/**
 * Runners as machines of an organisation (AD-08, AD-09, RU-06; the rows are in agent-store.ts, the views in runner-health.ts):
 *
 *   GET    /api/runners                      → { runners, canRegister, owners }    every machine the person may see
 *   GET    /api/runners/summary              → the Dashboard's counts
 *   GET    /api/runners/:runnerId            → one runner (the same 404 for one the person may not see)
 *   POST   /api/runners                      { name, organizationId? } → { runner, secret }   the token is shown this once
 *   PATCH  /api/runners/:runnerId            { name } → the runner
 *   POST   /api/runners/:runnerId/retire     → the runner: its token stops working at once, for every project
 *   GET    /api/projects/:id/runner-access   → { runners, available, canManage }
 *   PUT    /api/projects/:id/runner-access/:runnerId   gives the project access
 *   DELETE /api/projects/:id/runner-access/:runnerId   takes it away
 *
 * Round 39 (personal runners and enrollment codes, migration 51):
 *   POST   /api/runners/enroll               { kind: "personal" | "team", label?, organizationId?, projectIds? } → { id, code, expiresAt }
 *   GET    /api/runners/enrollments/:enrollmentId  → { id, kind, status: "waiting" | "used" | "expired", expiresAt, runnerId }
 *   GET    /api/projects/:id/runner-choices  → the runners this person may choose for a run of the project (agent-services.ts runnerChoices)
 *   PATCH  /api/runners/:runnerId also takes { codeScripts?, privateAddresses?, realPhone? } (the owner's switches; codeScripts for team runners too)
 *
 * A customer manages only their organisation's runners; Crowd4Test's shared machines are managed by Crowd4Test (canManageRunner). A person's
 * own computer is managed by that person (and platform admins), seen by nobody else, and never given to projects (canManage, seesRunner).
 */
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { getAgentServices } from "../agent-services.js";
import type { AgentTokenRecord } from "../agent-store.js";
import { accessControlOf, actorOf } from "../auth/access.js";
import { actorLabel, currentActor, sideOf, type Actor } from "../auth/actor.js";
import { visibleProjectsOf } from "../auth/project-scope.js";
import { HttpError } from "../http-error.js";
import { CANNOT_ADD_PERSONAL, CANNOT_MANAGE_PERSONAL, CANNOT_MANAGE_RUNNER, canAddPersonal, canManage, canManageRunner, MAX_RUNNERS_PER_ORGANIZATION, PERSONAL_CAP_REACHED, PERSONAL_NOT_GRANTED, RUNNER_CAP_REACHED, healthInput, OTHER_ORGANIZATION_RUNNER, RUNNER_NOT_FOUND, RUNNER_RETIRED, runnerMayServe, runnerSummary, runnerView, seesRunner, type Reach } from "../runner-health.js";
import { MAX_PERSONAL_RUNNERS, type EnrollmentRecord } from "../agent-store.js";
import { runnerUpdatesFor } from "../runner-update.js";
import { parsePlain } from "./project-settings.js";
import { publicAgent } from "./agents.js";
import type { RouteCtx } from "./types.js";

const RunnerName = z.string().trim().min(1, "Give the runner a name.").max(60, "A runner's name is at most 60 characters.");
const OrgId = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, "An organization id is letters, digits, - and _ (at most 64).");

/** The enrollment-code maker of a server (registered with its runner routes), so the Runners page's kit download makes codes by the same rules. */
const enrollmentMakers = new WeakMap<object, (req: FastifyRequest, body: { kind: "personal" | "team"; label?: string; organizationId?: string | null; projectIds?: string[] }, extra?: { projectId?: string }) => { code: string; record: EnrollmentRecord }>();
export const enrollmentMakerOf = (app: object) => enrollmentMakers.get(app);

export function registerRunnerRoutes(ctx: RouteCtx): void {
    const { app, p } = ctx;
    const control = accessControlOf(app);
    const svc = getAgentServices(p);
    const updates = runnerUpdatesFor(p);
    const who = (req: FastifyRequest): Actor => actorOf(req) ?? currentActor();

    const reachOf = (req: FastifyRequest): Reach => {
        const actor = who(req);
        const projects = new Map(p.db.all<{ id: string; name: string; organization_id: string | null }>("SELECT id, name, organization_id FROM projects").map((r) => [r.id, { name: r.name, organizationId: r.organization_id ?? null }]));
        return { actor, visible: visibleProjectsOf(req, actor), projects, organizations: new Map(control.projects.store.organizations().map((o) => [o.id, o.name])), now: svc.clock(), personName: (id) => p.db.get<{ name: string | null }>("SELECT name FROM users WHERE id = ?", id)?.name ?? null };
    };
    /** Who may change a runner, by its kind: a personal one its owner (and platform admins), a team one canManageRunner. */
    const refuseUnlessManages = (actor: Actor, t: AgentTokenRecord): void => {
        if (!canManage(control.projects, actor, t)) throw new HttpError(403, t.kind === "personal" ? CANNOT_MANAGE_PERSONAL : CANNOT_MANAGE_RUNNER);
    };
    const agentView = (a: Parameters<typeof publicAgent>[0]) => (a.capabilities.kitVersion || a.capabilities.update ? { ...publicAgent(a), update: updates.publicView(a) } : publicAgent(a));
    const viewOf = (req: FastifyRequest, t: AgentTokenRecord, reach = reachOf(req)) => runnerView(svc.store, reach, t, healthInput(svc.store), control.projects, agentView);

    /** A runner the person may see, or the same 404 as an unknown one. */
    const visibleRunner = (req: FastifyRequest, id: string): AgentTokenRecord => {
        const t = svc.store.getToken(id);
        if (!t || !seesRunner(svc.store, reachOf(req), t)) throw new HttpError(404, RUNNER_NOT_FOUND);
        return t;
    };
    const note = (actor: Actor, action: string, detail: string, projectId?: string) =>
        control.users.addActivity({ actorKind: actor.kind, actorId: actor.id ?? null, actorName: actor.name, action, detail, projectId: projectId ?? null });

    app.get("/api/runners", async (req) => {
        const reach = reachOf(req);
        const input = healthInput(svc.store);
        const seen = svc.store.allTokens().filter((t) => seesRunner(svc.store, reach, t));
        const side = sideOf(reach.actor);
        const orgs = side === "customer" ? [reach.actor.organizationId ?? ""].filter(Boolean) : [...reach.organizations.keys()];
        const owners = orgs.filter((o) => canManageRunner(control.projects, reach.actor, o)).map((id) => ({ id, name: reach.organizations.get(id) ?? null }));
        const shared = canManageRunner(control.projects, reach.actor, null);
        // What the caller may do, so the page shows only buttons that work: add their own computer, add a team runner (canManage is per runner).
        const personal = canAddPersonal(control.projects, reach.actor);
        const own = reach.actor.kind === "user" && reach.actor.id ? svc.store.countLivePersonalOf(reach.actor.id) : 0;
        return {
            runners: seen.map((t) => runnerView(svc.store, reach, t, input, control.projects, agentView)),
            canRegister: shared || owners.length > 0,
            canRegisterShared: shared,
            owners,
            canAddTeam: shared || owners.length > 0,
            canAddPersonal: personal && own < MAX_PERSONAL_RUNNERS,
            personal: { count: own, max: MAX_PERSONAL_RUNNERS, ...(personal && own >= MAX_PERSONAL_RUNNERS ? { reason: PERSONAL_CAP_REACHED } : !personal ? { reason: CANNOT_ADD_PERSONAL } : {}) },
        };
    });

    // ── enrollment codes (the download or the command carries one; the runner trades it once for its credential) ──
    const EnrollBody = z
        .object({
            kind: z.enum(["personal", "team"]),
            label: RunnerName.optional(),
            organizationId: OrgId.nullable().optional(),
            projectIds: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
        })
        .strict();

    /** Check who may make a code of this kind and make it; also used by the Runners page's kit download (routes/runner-kits.ts). */
    const makeEnrollment = (req: FastifyRequest, body: z.infer<typeof EnrollBody>, extra: { projectId?: string } = {}): { code: string; record: EnrollmentRecord } => {
        const actor = who(req);
        if (body.kind === "personal") {
            if (!canAddPersonal(control.projects, actor)) throw new HttpError(403, CANNOT_ADD_PERSONAL);
            if (svc.store.countLivePersonalOf(actor.id!) >= MAX_PERSONAL_RUNNERS) throw new HttpError(409, PERSONAL_CAP_REACHED);
            const made = svc.store.createEnrollment({ kind: "personal", ownerId: actor.id!, label: body.label ?? null, createdBy: actorLabel(actor), createdById: actor.id ?? null });
            note(actor, "runner-enrollment-made", "A code to add their own computer was made.");
            return made;
        }
        let org = body.organizationId ?? null;
        if (sideOf(actor) === "customer") {
            if (org && org !== actor.organizationId) throw new HttpError(403, CANNOT_MANAGE_RUNNER);
            org = actor.organizationId ?? null;
        }
        // A runner of no organisation and no project is a Crowd4Test shared machine: only Crowd4Test staff (canManageRunner(null)) make one.
        if (!canManageRunner(control.projects, actor, org)) throw new HttpError(403, CANNOT_MANAGE_RUNNER);
        if (svc.store.countLiveRunnersOf(org) >= MAX_RUNNERS_PER_ORGANIZATION) throw new HttpError(409, RUNNER_CAP_REACHED);
        const reach = reachOf(req);
        const projectIds = [...new Set(body.projectIds ?? [])];
        for (const id of projectIds) {
            // A project the person cannot see is "not found"; one of another organisation cannot use this runner.
            if (!reach.projects.has(id) || (reach.visible && !reach.visible.has(id))) throw new HttpError(404, "Project not found");
            if (org !== null && reach.projects.get(id)!.organizationId !== org) throw new HttpError(409, OTHER_ORGANIZATION_RUNNER);
            // Giving a runner to a project needs "manage runners" in that project (the same rule as PUT .../runner-access/:runnerId).
            if (!control.projects.permissionsIn(actor, id)?.has("ai_studio.runners.manage")) throw new HttpError(403, "Giving a runner to a project needs permission to manage runners in that project.");
        }
        if (org) control.projects.store.ensureOrganization(org);
        const made = svc.store.createEnrollment({ kind: "team", organizationId: org, ...(extra.projectId ? { projectId: extra.projectId } : {}), projectIds, label: body.label ?? null, createdBy: actorLabel(actor), createdById: actor.id ?? null });
        note(actor, "runner-enrollment-made", `A code to add the team runner${body.label ? ` “${body.label}”` : ""} was made.`);
        return made;
    };
    enrollmentMakers.set(app, makeEnrollment as never);

    app.post("/api/runners/enroll", async (req, reply) => {
        const body = parsePlain(EnrollBody, req.body ?? {});
        const { code, record } = makeEnrollment(req, body);
        // The only time the code is shown. It is not stored (only its hash), logged or returned again.
        return reply.code(201).send({ id: record.id, kind: record.kind, code, expiresAt: new Date(record.expiresMs).toISOString() });
    });

    app.get("/api/runners/enrollments/:enrollmentId", async (req) => {
        const { enrollmentId } = req.params as { enrollmentId: string };
        const e = svc.store.getEnrollment(enrollmentId);
        const actor = who(req);
        // The person who made it, and platform admins; anyone else gets the same answer as for an unknown id.
        if (!e || !((actor.id && e.createdById === actor.id) || (!e.createdById && actor.kind !== "user") || canManageRunner(control.projects, actor, null))) throw new HttpError(404, "Enrollment code not found");
        const status = e.usedMs !== null ? "used" : svc.clock() >= e.expiresMs ? "expired" : "waiting";
        const runner = e.tokenId ? svc.store.getToken(e.tokenId) : undefined;
        return { id: e.id, kind: e.kind, status, expiresAt: new Date(e.expiresMs).toISOString(), runnerId: e.tokenId, ...(runner && seesRunner(svc.store, reachOf(req), runner) ? { runner: viewOf(req, runner) } : {}) };
    });

    // ── per-run choice: the runners this person may run this project's tests on ──
    app.get("/api/projects/:id/runner-choices", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const actor = who(req);
        return svc.runnerChoices(id, actor.kind === "user" && actor.id ? actor.id : null);
    });

    app.get("/api/runners/summary", async (req) => {
        const reach = reachOf(req);
        const input = healthInput(svc.store);
        const views = svc.store.allTokens().filter((t) => seesRunner(svc.store, reach, t)).map((t) => runnerView(svc.store, reach, t, input, control.projects, agentView));
        return runnerSummary(views, input.tasks, reach);
    });

    app.get("/api/runners/:runnerId", async (req) => {
        const { runnerId } = req.params as { runnerId: string };
        return viewOf(req, visibleRunner(req, runnerId));
    });

    app.post("/api/runners", async (req, reply) => {
        const actor = who(req);
        const body = parsePlain(z.object({ name: RunnerName, organizationId: OrgId.nullable().optional() }).strict(), req.body);
        let org = body.organizationId ?? null;
        if (sideOf(actor) === "customer") {
            if (org && org !== actor.organizationId) throw new HttpError(403, CANNOT_MANAGE_RUNNER);
            org = actor.organizationId ?? null;
        }
        if (!canManageRunner(control.projects, actor, org)) throw new HttpError(403, CANNOT_MANAGE_RUNNER);
        if (svc.store.countLiveRunnersOf(org) >= MAX_RUNNERS_PER_ORGANIZATION) throw new HttpError(409, RUNNER_CAP_REACHED);
        if (org) control.projects.store.ensureOrganization(org);
        const { secret, record } = svc.store.createRunnerToken({ organizationId: org, label: body.name, createdBy: actorLabel(actor) });
        note(actor, "runner-registered", `Runner “${body.name}” registered.`);
        // The only time the token is shown. It is not stored, logged or returned again.
        return reply.code(201).send({ runner: viewOf(req, record), secret });
    });

    app.patch("/api/runners/:runnerId", async (req) => {
        const { runnerId } = req.params as { runnerId: string };
        const t = visibleRunner(req, runnerId);
        const actor = who(req);
        const body = parsePlain(z.object({ name: RunnerName.optional(), codeScripts: z.boolean().optional(), privateAddresses: z.boolean().optional(), realPhone: z.boolean().optional() }).strict(), req.body);
        refuseUnlessManages(actor, t);
        if (t.revokedAt) throw new HttpError(409, RUNNER_RETIRED);
        // Private addresses and a real phone are switches of a person's own computer; a team runner keeps today's rules for them.
        if (t.kind === "team" && (body.privateAddresses !== undefined || body.realPhone !== undefined)) throw new HttpError(400, "Private addresses and a connected phone are switches of a person's own computer. A team runner keeps its own rules.");
        // What a person's own computer runs is that person's choice alone: platform admins may rename and retire it, not change its switches.
        const switching = body.codeScripts !== undefined || body.privateAddresses !== undefined || body.realPhone !== undefined;
        if (t.kind === "personal" && switching && !(actor.kind === "user" && actor.id && actor.id === t.ownerId)) throw new HttpError(403, "Only the person whose computer this is can change what it runs.");
        // A Crowd4Test shared machine never runs code scripts: one customer's code must not run on a machine that serves others.
        if (body.codeScripts === true && t.kind === "team" && t.organizationId === null && t.projectId === null) throw new HttpError(409, "A Crowd4Test shared runner never runs code scripts.");
        if (body.name !== undefined && !svc.store.renameToken(t.id, body.name)) throw new HttpError(409, RUNNER_RETIRED);
        if (!svc.store.setTokenSwitches(t.id, { ...(body.codeScripts !== undefined ? { allowCodeScripts: body.codeScripts } : {}), ...(body.privateAddresses !== undefined ? { allowPrivateTargets: body.privateAddresses } : {}), ...(body.realPhone !== undefined ? { allowRealPhone: body.realPhone } : {}) })) throw new HttpError(409, RUNNER_RETIRED);
        if (body.name !== undefined) note(actor, "runner-renamed", `Runner renamed to “${body.name}”.`);
        const said = [body.codeScripts !== undefined ? `code scripts ${body.codeScripts ? "allowed" : "not allowed"}` : "", body.privateAddresses !== undefined ? `private addresses ${body.privateAddresses ? "allowed" : "not allowed"}` : "", body.realPhone !== undefined ? `a connected phone ${body.realPhone ? "may be used" : "is not used"}` : ""].filter(Boolean);
        if (said.length) note(actor, "runner-switches-changed", `Runner “${body.name ?? t.label ?? t.hint}”: ${said.join(", ")}.`);
        return viewOf(req, svc.store.getToken(t.id)!);
    });

    app.post("/api/runners/:runnerId/retire", async (req) => {
        const { runnerId } = req.params as { runnerId: string };
        const t = visibleRunner(req, runnerId);
        const actor = who(req);
        refuseUnlessManages(actor, t);
        if (!svc.store.retireToken(t.id)) throw new HttpError(409, RUNNER_RETIRED);
        note(actor, "runner-retired", `Runner “${t.label ?? t.hint}” retired.`);
        return viewOf(req, svc.store.getToken(t.id)!);
    });

    // ── a project's runner access ───────────────────────────────────────────
    app.get("/api/projects/:id/runner-access", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const reach = reachOf(req);
        const input = healthInput(svc.store);
        const org = reach.projects.get(id)?.organizationId ?? null;
        const views = svc.store.listTokens(id).filter((t) => !t.revokedAt).map((t) => runnerView(svc.store, reach, t, input, control.projects, agentView));
        const have = new Set(views.map((v) => v.id));
        const available = svc.store
            .allTokens()
            .filter((t) => !t.revokedAt && t.kind === "team" && !have.has(t.id) && runnerMayServe(t, id, org) && canManageRunner(control.projects, reach.actor, t.organizationId))
            .map((t) => ({ id: t.id, name: t.label ?? svc.store.agentsOfToken(t.id)[0]?.name ?? "Unnamed runner", ownerName: t.organizationId ? (reach.organizations.get(t.organizationId) ?? "Your organisation") : "Crowd4Test (shared)" }));
        return { runners: views, available, canManage: canManageRunner(control.projects, reach.actor, org) };
    });

    const accessTarget = (req: FastifyRequest) => {
        const { id, runnerId } = req.params as { id: string; runnerId: string };
        ctx.project(id);
        return { id, t: visibleRunner(req, runnerId) };
    };

    app.put("/api/projects/:id/runner-access/:runnerId", async (req) => {
        const { id, t } = accessTarget(req);
        const actor = who(req);
        refuseUnlessManages(actor, t);
        if (t.kind === "personal") throw new HttpError(409, PERSONAL_NOT_GRANTED);
        if (t.revokedAt) throw new HttpError(409, RUNNER_RETIRED);
        if (!runnerMayServe(t, id, control.projects.store.projectOrganization(id))) throw new HttpError(409, OTHER_ORGANIZATION_RUNNER);
        if (svc.store.grantAccess(t.id, id, actorLabel(actor))) note(actor, "runner-access-given", `Runner “${t.label ?? t.hint}” may now run this project's tests.`, id);
        return { ok: true };
    });

    app.delete("/api/projects/:id/runner-access/:runnerId", async (req) => {
        const { id, t } = accessTarget(req);
        const actor = who(req);
        refuseUnlessManages(actor, t);
        if (!svc.store.removeAccess(t.id, id)) throw new HttpError(404, "This project does not use that runner.");
        note(actor, "runner-access-removed", `Runner “${t.label ?? t.hint}” no longer runs this project's tests.`, id);
        return { ok: true };
    });
}
