import { stepTitle } from "../../engine/runbook/flow.js";
import { PRESETS, isPresetId, presetDefinition } from "../../engine/runbook/presets.js";
import { MAX_NAME, MAX_RUNBOOKS, MAX_STEPS, MAX_WAIT_SECONDS, STEP_TYPES, parseDefinition, projectProblems, type RunbookDefinition } from "../../engine/runbook/schema.js";
import { z } from "zod";
import { HttpError } from "../http-error.js";
import { findEnvironment } from "../environments-store.js";
import { getRunbookServices, RunbookOverlapError } from "../runbook-runner.js";
import type { Runbook } from "../runbook-store.js";
import { getScheduleServices } from "../schedule-services.js";
import { OverlapError } from "../scheduler.js";
import { refuseUnlessRunsStart } from "../suite-run.js";
import { getTriggerServices } from "../trigger-services.js";
import type { RouteCtx } from "./types.js";

const FromTemplate = z.object({
    template: z.string(),
    /** Alert channel the preset's message goes to. Without one the preset is made without the message step. */
    channelId: z.string().min(1).max(64).optional(),
    name: z.string().trim().min(1).max(MAX_NAME).optional(),
});
const LinkBody = z.object({ runbookId: z.string().min(1).max(64).nullable() }).strict();

/** Runbooks: chained runs with branching, started by hand, by a schedule or by a deploy token. */
export function registerRunbookRoutes(ctx: RouteCtx): void {
    const { app, p, project } = ctx;
    const svc = getRunbookServices(p);
    const { store } = svc;

    const runbook = (projectId: string, rid: string): Runbook => {
        const r = store.get(rid);
        if (!r || r.projectId !== projectId) throw new HttpError(404, "Runbook not found");
        return r;
    };

    /** A definition from the request body: validated, then checked against what this project has. */
    const definitionFrom = (projectId: string, body: unknown): RunbookDefinition => {
        const parsed = parseDefinition(body);
        if (!parsed.ok) throw new HttpError(400, parsed.errors[0]!.message, { issues: parsed.errors });
        const channels = getScheduleServices(p).alertStore;
        const problems = projectProblems(parsed.definition, {
            environment: (name) => findEnvironment(p.db, projectId, name),
            channelExists: (id) => channels.get(id)?.projectId === projectId,
        });
        if (problems.length) {
            const needsConfirm = problems.some((x) => x.requiresConfirmation);
            throw new HttpError(needsConfirm ? 409 : 400, problems[0]!.message, { issues: problems, ...(needsConfirm ? { requiresConfirmation: true } : {}) });
        }
        return parsed.definition;
    };

    const publicRunbook = async (r: Runbook) => {
        const last = store.lastRun(r.id);
        const active = store.activeRun(r.projectId);
        return {
            id: r.id,
            projectId: r.projectId,
            name: r.name,
            description: r.definition.description ?? null,
            definition: r.definition,
            titles: r.definition.steps.map(stepTitle),
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            usedBy: store.usedBy(r.id),
            lastRun: last ? svc.publicRun(last, false) : null,
            running: active?.runbookId === r.id,
            warnings: await svc.warnings(r.projectId, r.definition),
        };
    };

    /** Start errors in plain words and the right status. */
    const startFailure = (e: unknown): never => {
        if (e instanceof RunbookOverlapError) throw new HttpError(409, `The runbook “${e.runbookName}” is still running for this project. Wait for it to finish or cancel it.`);
        if (e instanceof OverlapError) throw new HttpError(409, `Job ${e.activeJobId} is still ${e.activeStatus}; wait for it to finish or cancel it`);
        throw e;
    };

    // ── runbooks ───────────────────────────────────────────────────────────────
    app.get("/api/projects/:id/runbooks", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        svc.sweep();
        return {
            runbooks: await Promise.all(store.list(id).map(publicRunbook)),
            limits: { maxRunbooks: MAX_RUNBOOKS, maxSteps: MAX_STEPS, maxWaitSeconds: MAX_WAIT_SECONDS, maxNameLength: MAX_NAME, stepMinutes: Math.round(svc.limits.stepCapMs / 60_000), totalMinutes: Math.round(svc.limits.totalCapMs / 60_000), stepTypes: STEP_TYPES },
            templates: PRESETS,
        };
    });

    app.post("/api/projects/:id/runbooks", async (req, reply) => {
        const { id } = req.params as { id: string };
        project(id);
        const def = definitionFrom(id, req.body);
        if (store.count(id) >= MAX_RUNBOOKS) throw new HttpError(409, `A project can have up to ${MAX_RUNBOOKS} runbooks. Delete one you no longer use first.`);
        return reply.code(201).send(await publicRunbook(store.create(id, def)));
    });

    app.post("/api/projects/:id/runbooks/from-template", async (req, reply) => {
        const { id } = req.params as { id: string };
        project(id);
        const body = FromTemplate.parse(req.body);
        if (!isPresetId(body.template)) throw new HttpError(404, `There is no template called “${body.template}”.`);
        if (store.count(id) >= MAX_RUNBOOKS) throw new HttpError(409, `A project can have up to ${MAX_RUNBOOKS} runbooks. Delete one you no longer use first.`);
        const channelId = body.channelId;
        if (channelId && getScheduleServices(p).alertStore.get(channelId)?.projectId !== id) throw new HttpError(404, "This project has no alert channel with that id.");
        const def = { ...presetDefinition(body.template, channelId), ...(body.name ? { name: body.name } : {}) };
        const created = store.create(id, definitionFrom(id, def));
        return reply.code(201).send({ ...(await publicRunbook(created)), note: channelId ? null : "No alert channel was chosen, so this runbook has no message step. Add a channel under Alerts, then add a “Tell the team” step." });
    });

    app.get("/api/projects/:id/runbooks/:rid", async (req) => {
        const { id, rid } = req.params as { id: string; rid: string };
        project(id);
        return await publicRunbook(runbook(id, rid));
    });

    app.put("/api/projects/:id/runbooks/:rid", async (req) => {
        const { id, rid } = req.params as { id: string; rid: string };
        project(id);
        runbook(id, rid);
        const def = definitionFrom(id, req.body);
        return await publicRunbook(store.update(rid, def)!);
    });

    app.delete("/api/projects/:id/runbooks/:rid", async (req, reply) => {
        const { id, rid } = req.params as { id: string; rid: string };
        project(id);
        const rb = runbook(id, rid);
        if (store.activeRun(id)?.runbookId === rid) throw new HttpError(409, "This runbook is running. Cancel the run first, then delete it.");
        const used = store.usedBy(rid);
        const by = [...used.schedules.map((s) => `the schedule “${s.name}”`), ...used.tokens.map((t) => `the deploy token ${t.label ? `“${t.label}”` : `ending in ${t.hint}`}`)];
        if (by.length) throw new HttpError(409, `“${rb.name}” is started by ${by.slice(0, 3).join(", ")}${by.length > 3 ? ` and ${by.length - 3} more` : ""}. Change that first, then delete the runbook.`);
        store.delete(rid);
        return reply.code(204).send();
    });

    // ── running ────────────────────────────────────────────────────────────────
    app.post("/api/projects/:id/runbooks/:rid/run", async (req, reply) => {
        const { id, rid } = req.params as { id: string; rid: string };
        project(id);
        // A step that runs tests or explores queues a job: refused before anything starts while tests are switched off here.
        if (runbook(id, rid).definition.steps.some((s) => s.type === "run" || s.type === "analyze")) refuseUnlessRunsStart(p);
        try {
            const run = await svc.start(rid, { kind: "manual" });
            return reply.code(202).send({ runId: run.id, status: run.status });
        } catch (e) {
            return startFailure(e);
        }
    });

    app.get("/api/projects/:id/runbooks/:rid/runs", async (req) => {
        const { id, rid } = req.params as { id: string; rid: string };
        project(id);
        runbook(id, rid);
        svc.sweep();
        const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(req.query);
        return { runs: store.listRuns(rid, limit).map((r) => svc.publicRun(r, false)) };
    });

    app.get("/api/projects/:id/runbooks/:rid/runs/:runId", async (req) => {
        const { id, rid, runId } = req.params as { id: string; rid: string; runId: string };
        project(id);
        runbook(id, rid);
        svc.sweep();
        const run = store.getRun(runId);
        if (!run || run.runbookId !== rid) throw new HttpError(404, "Run not found");
        return svc.publicRun(run);
    });

    /** The same run found by its id alone (a link from a message names only the run). */
    app.get("/api/projects/:id/runbook-runs/:runId", async (req) => {
        const { id, runId } = req.params as { id: string; runId: string };
        project(id);
        svc.sweep();
        const run = store.getRun(runId);
        if (!run || run.projectId !== id) throw new HttpError(404, "Run not found");
        return svc.publicRun(run);
    });

    app.post("/api/projects/:id/runbooks/:rid/runs/:runId/cancel", async (req, reply) => {
        const { id, rid, runId } = req.params as { id: string; rid: string; runId: string };
        project(id);
        runbook(id, rid);
        const run = store.getRun(runId);
        if (!run || run.runbookId !== rid) throw new HttpError(404, "Run not found");
        if (!svc.cancel(runId)) throw new HttpError(409, "This run has already finished.");
        return reply.code(202).send({ cancelRequested: true });
    });

    // ── what starts a runbook ──────────────────────────────────────────────────
    app.put("/api/projects/:id/schedules/:sid/runbook", async (req) => {
        const { id, sid } = req.params as { id: string; sid: string };
        project(id);
        const sched = getScheduleServices(p).store.get(sid);
        if (!sched || sched.projectId !== id) throw new HttpError(404, "Schedule not found");
        const { runbookId } = LinkBody.parse(req.body);
        if (runbookId) runbook(id, runbookId);
        store.setScheduleLink(sid, runbookId);
        return { scheduleId: sid, runbookId };
    });

    app.put("/api/projects/:id/triggers/:tid/runbook", async (req) => {
        const { id, tid } = req.params as { id: string; tid: string };
        project(id);
        const token = getTriggerServices(p).store.get(tid);
        if (!token || token.projectId !== id || token.revokedAt) throw new HttpError(404, "Token not found, or already revoked");
        const { runbookId } = LinkBody.parse(req.body);
        if (runbookId) runbook(id, runbookId);
        store.setTokenLink(tid, runbookId);
        return { tokenId: tid, runbookId };
    });
}
