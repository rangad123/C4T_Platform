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
 * A customer manages only their organisation's runners; Crowd4Test's shared machines are managed by Crowd4Test (canManageRunner).
 */
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { getAgentServices } from "../agent-services.js";
import type { AgentTokenRecord } from "../agent-store.js";
import { accessControlOf, actorOf } from "../auth/access.js";
import { actorLabel, currentActor, sideOf, type Actor } from "../auth/actor.js";
import { visibleProjectsOf } from "../auth/project-scope.js";
import { HttpError } from "../http-error.js";
import { CANNOT_MANAGE_RUNNER, canManageRunner, MAX_RUNNERS_PER_ORGANIZATION, RUNNER_CAP_REACHED, healthInput, mayServe, OTHER_ORGANIZATION_RUNNER, RUNNER_NOT_FOUND, RUNNER_RETIRED, runnerSummary, runnerView, seesRunner, type Reach } from "../runner-health.js";
import { runnerUpdatesFor } from "../runner-update.js";
import { parsePlain } from "./project-settings.js";
import { publicAgent } from "./agents.js";
import type { RouteCtx } from "./types.js";

const RunnerName = z.string().trim().min(1, "Give the runner a name.").max(60, "A runner's name is at most 60 characters.");
const OrgId = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, "An organization id is letters, digits, - and _ (at most 64).");

export function registerRunnerRoutes(ctx: RouteCtx): void {
    const { app, p } = ctx;
    const control = accessControlOf(app);
    const svc = getAgentServices(p);
    const updates = runnerUpdatesFor(p);
    const who = (req: FastifyRequest): Actor => actorOf(req) ?? currentActor();

    const reachOf = (req: FastifyRequest): Reach => {
        const actor = who(req);
        const projects = new Map(p.db.all<{ id: string; name: string; organization_id: string | null }>("SELECT id, name, organization_id FROM projects").map((r) => [r.id, { name: r.name, organizationId: r.organization_id ?? null }]));
        return { actor, visible: visibleProjectsOf(req, actor), projects, organizations: new Map(control.projects.store.organizations().map((o) => [o.id, o.name])), now: svc.clock() };
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
        return { runners: seen.map((t) => runnerView(svc.store, reach, t, input, control.projects, agentView)), canRegister: shared || owners.length > 0, canRegisterShared: shared, owners };
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
        const body = parsePlain(z.object({ name: RunnerName }).strict(), req.body);
        if (!canManageRunner(control.projects, actor, t.organizationId)) throw new HttpError(403, CANNOT_MANAGE_RUNNER);
        if (!svc.store.renameToken(t.id, body.name)) throw new HttpError(409, RUNNER_RETIRED);
        note(actor, "runner-renamed", `Runner renamed to “${body.name}”.`);
        return viewOf(req, svc.store.getToken(t.id)!);
    });

    app.post("/api/runners/:runnerId/retire", async (req) => {
        const { runnerId } = req.params as { runnerId: string };
        const t = visibleRunner(req, runnerId);
        const actor = who(req);
        if (!canManageRunner(control.projects, actor, t.organizationId)) throw new HttpError(403, CANNOT_MANAGE_RUNNER);
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
            .filter((t) => !t.revokedAt && !have.has(t.id) && mayServe(t.organizationId, org) && canManageRunner(control.projects, reach.actor, t.organizationId))
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
        if (!canManageRunner(control.projects, actor, t.organizationId)) throw new HttpError(403, CANNOT_MANAGE_RUNNER);
        if (t.revokedAt) throw new HttpError(409, RUNNER_RETIRED);
        if (!mayServe(t.organizationId, control.projects.store.projectOrganization(id))) throw new HttpError(409, OTHER_ORGANIZATION_RUNNER);
        if (svc.store.grantAccess(t.id, id, actorLabel(actor))) note(actor, "runner-access-given", `Runner “${t.label ?? t.hint}” may now run this project's tests.`, id);
        return { ok: true };
    });

    app.delete("/api/projects/:id/runner-access/:runnerId", async (req) => {
        const { id, t } = accessTarget(req);
        const actor = who(req);
        if (!canManageRunner(control.projects, actor, t.organizationId)) throw new HttpError(403, CANNOT_MANAGE_RUNNER);
        if (!svc.store.removeAccess(t.id, id)) throw new HttpError(404, "This project does not use that runner.");
        note(actor, "runner-access-removed", `Runner “${t.label ?? t.hint}” no longer runs this project's tests.`, id);
        return { ok: true };
    });
}
