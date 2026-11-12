import { z } from "zod";
import { AGENT_LIMITS } from "../../engine/agent/objective.js";
import { misuseRefusal } from "../../engine/authoring/describe.js";
import { agentRunsCanStart, agentRunStoreFor, draftFromRun, NO_RUNNER_YET, ON_YOUR_RUNNER, reconcileRun } from "../agent-run.js";
import { runnersOnly } from "../runner-only.js";
import { isActiveRun, type AgentRun } from "../agent-run-store.js";
import { accessControlOf } from "../auth/access.js";
import { currentActor } from "../auth/actor.js";
import { hidesCost } from "../auth/cost-hiding.js";
import { findEnvironment } from "../environments-store.js";
import { HttpError } from "../http-error.js";
import { assertAllowedTarget } from "../net-guard.js";
import { environmentFor } from "../plain-run.js";
import { projectSetupOf } from "../project-setup.js";
import { DEFAULT_JOB_OPTIONS } from "../repo.js";
import type { RouteCtx } from "./types.js";

/**
 * Agent runs: start one, follow it, answer its approval requests, stop it, and turn a finished one into a draft test. The work is a job of
 * mode "agent" (../agent-run.ts). Reading needs access to the project, the rest ai_studio.agent.run; the draft needs ai_studio.tests.write
 * (auth/roles.ts). Token figures carry the cost field names, so testers never get them (auth/cost-hiding.ts).
 */

const limit = (o: { min: number; max: number }) => z.number().int().min(o.min).max(o.max).optional();
const StartBody = z
    .object({
        objective: z.string().trim().min(10, "Say in a few words what the agent should achieve.").max(2_000),
        successCriteria: z.string().trim().max(2_000).optional(),
        /** A project environment to run on (never a production one). */
        environment: z.string().trim().min(1).max(40).optional(),
        /** A path on the site, or an address on it. Empty: the home page of the site. */
        startAddress: z.string().trim().max(2_000).optional(),
        limits: z.object({ maxSteps: limit(AGENT_LIMITS.steps), maxMinutes: limit(AGENT_LIMITS.minutes), budgetTokens: limit(AGENT_LIMITS.tokens), approvalSeconds: limit(AGENT_LIMITS.approvalSeconds) }).strict().optional(),
    })
    .strict();
const Answer = z.object({ approve: z.boolean() }).strict();
export const NOT_AN_APPROVER = "Only a Project Admin of this project who may approve tests can answer this request.";
export const BUDGET_NEEDS_USAGE = `An AI budget above ${AGENT_LIMITS.tokens.default.toLocaleString("en")} tokens needs permission to see AI usage and cost.`;

export function registerAgentRunRoutes(ctx: RouteCtx): void {
    const { app, p, repo } = ctx;
    const store = agentRunStoreFor(p);

    const runOf = async (projectId: string, rid: string): Promise<AgentRun> => {
        ctx.project(projectId);
        const r = await store.get(rid);
        // Another project's run reads as unknown.
        if (!r || r.projectId !== projectId) throw new HttpError(404, "Agent run not found");
        return reconcileRun(store, repo, r);
    };
    const detail = async (r: AgentRun) => ({ ...r, steps: await store.steps(r.id), approvals: await store.approvals(r.id), canApprove: accessControlOf(app).projects.canApprove(currentActor(), r.projectId) });

    app.get("/api/projects/:id/agent-runs", async (req) => {
        const { id } = req.params as { id: string };
        const project = ctx.project(id);
        const runs = await Promise.all((await store.list(id)).map((r) => reconcileRun(store, repo, r)));
        const environments = repo.db.all<{ name: string; production: number }>("SELECT name, production FROM project_environments WHERE project_id = ? ORDER BY name", id);
        return {
            runs,
            canStart: await agentRunsCanStart(p, id),
            agentModeOn: projectSetupOf(project).testingModes.includes("agent"),
            whereItRuns: runnersOnly(p.config) ? ON_YOUR_RUNNER : NO_RUNNER_YET,
            // Named as a cost field, so people who may not see AI usage do not get the token bounds.
            limits: { steps: AGENT_LIMITS.steps, minutes: AGENT_LIMITS.minutes, budgetTokens: AGENT_LIMITS.tokens, approvalSeconds: AGENT_LIMITS.approvalSeconds },
            address: repo.getLatestApplicationPublic(id)?.url ?? null,
            environments: environments.filter((e) => !Number(e.production)).map((e) => e.name),
        };
    });

    app.post("/api/projects/:id/agent-runs", async (req, reply) => {
        const { id } = req.params as { id: string };
        const project = ctx.project(id);
        const body = StartBody.parse(req.body);
        if (!projectSetupOf(project).testingModes.includes("agent")) throw new HttpError(409, "Agent mode is off for this project. Turn it on in the project's settings to start agent runs.");
        const can = await agentRunsCanStart(p, id);
        if (!can.ok) throw new HttpError(409, can.reason);
        const misuse = misuseRefusal(`${body.objective}\n${body.successCriteria ?? ""}`);
        if (misuse) throw new HttpError(422, misuse, { refused: true });

        let base: string | undefined;
        if (body.environment) base = (await environmentFor(repo, p.config, id, body.environment)).env.baseUrl;
        const latest = repo.getLatestApplicationPublic(id);
        const absolute = body.startAddress && /^[a-z][a-z0-9+.-]*:/i.test(body.startAddress) ? body.startAddress : undefined;
        // A project with no address yet gets the one given here, as when a test is described in words.
        const application = await ctx.applicationFor(id, latest ? undefined : (base ?? absolute));
        if (application.url.startsWith("android-app://") || application.url.startsWith("ios-app://")) throw new HttpError(422, "Agent runs work in a browser, so they need a web application.");
        const site = base ?? application.url;
        let start: URL;
        try {
            start = new URL(body.startAddress || "/", site);
        } catch {
            throw new HttpError(400, "That start address is not a valid address.");
        }
        if (start.username || start.password) throw new HttpError(400, "A start address cannot carry a sign-in.");
        if (start.origin !== new URL(site).origin) throw new HttpError(400, `The start address must be on the site under test (${new URL(site).origin}).`);
        await assertAllowedTarget(start.toString());
        if (body.environment && !findEnvironment(repo.db, id, body.environment)) throw new HttpError(404, `This project has no environment called “${body.environment}”.`);

        const l = body.limits ?? {};
        // A bigger AI budget than the default is spending: it needs the permission to see AI usage and cost.
        if (l.budgetTokens !== undefined && l.budgetTokens > AGENT_LIMITS.tokens.default && hidesCost(currentActor())) throw new HttpError(403, BUDGET_NEEDS_USAGE);
        const limits = {
            maxSteps: l.maxSteps ?? AGENT_LIMITS.steps.default,
            maxMinutes: l.maxMinutes ?? AGENT_LIMITS.minutes.default,
            maxTokens: l.budgetTokens ?? AGENT_LIMITS.tokens.default,
            approvalSeconds: l.approvalSeconds ?? AGENT_LIMITS.approvalSeconds.default,
        };
        const actor = currentActor();
        // The run exists before its job, so a worker that takes the job at once finds it.
        const run = await store.create({
            projectId: id,
            objective: body.objective,
            ...(body.successCriteria ? { successCriteria: body.successCriteria } : {}),
            ...(body.environment ? { environment: body.environment } : {}),
            startAddress: start.toString(),
            limits,
            startedBy: { id: actor.kind === "user" ? (actor.id ?? null) : null, name: actor.name },
        });
        try {
            // Right before creating the job, with no await in between (one active job per project).
            await ctx.assertNoActiveJob(id);
            const job = await repo.createJob(id, application.id, { ...DEFAULT_JOB_OPTIONS, mode: "agent", targets: ["web"], agentRunId: run.id, ...(body.environment ? { environment: body.environment } : {}) });
            await store.setJob(run.id, job.id);
            return await reply.code(202).send({ ...run, jobId: job.id });
        } catch (e) {
            await store.remove(run.id);
            throw e;
        }
    });

    app.get("/api/projects/:id/agent-runs/:rid", async (req) => {
        const { id, rid } = req.params as { id: string; rid: string };
        return detail(await runOf(id, rid));
    });

    /** Stop: the job ends at its next step, and a run waiting for a person ends at once. */
    app.post("/api/projects/:id/agent-runs/:rid/stop", async (req) => {
        const { id, rid } = req.params as { id: string; rid: string };
        const run = await runOf(id, rid);
        if (!isActiveRun(run)) throw new HttpError(409, "This run has already ended.");
        repo.requestCancel(run.jobId);
        return detail(await reconcileRun(store, repo, run));
    });

    app.post("/api/projects/:id/agent-runs/:rid/approvals/:aid", async (req) => {
        const { id, rid, aid } = req.params as { id: string; rid: string; aid: string };
        const run = await runOf(id, rid);
        const body = Answer.parse(req.body);
        const asked = await store.approval(aid);
        if (!asked || asked.runId !== run.id) throw new HttpError(404, "Approval request not found");
        const actor = currentActor();
        // Letting the agent delete, pay, send or submit is an approval: it needs a Project Admin of this project who may approve.
        if (!accessControlOf(app).projects.canApprove(actor, id)) throw new HttpError(403, NOT_AN_APPROVER);
        const done = await store.decide(aid, body.approve ? "approved" : "refused", { id: actor.kind === "user" ? (actor.id ?? null) : null, name: actor.name });
        if (!done) throw new HttpError(409, "This request has already been answered or has timed out.");
        return detail((await store.get(run.id)) ?? run);
    });

    /** A finished run as a draft test. Asking again gives the same test, while it exists. */
    app.post("/api/projects/:id/agent-runs/:rid/draft", async (req, reply) => {
        const { id, rid } = req.params as { id: string; rid: string };
        const run = await runOf(id, rid);
        if (isActiveRun(run)) throw new HttpError(409, "A run can become a test once it has ended.");
        const existing = run.draftTestId ? repo.getTest(run.draftTestId) : undefined;
        if (existing) return reply.send({ testId: existing.id, testKey: existing.testKey, created: false });
        const test = draftFromRun(repo, run, await store.workedSteps(run.id));
        await store.setDraft(run.id, test.id);
        return reply.code(201).send({ testId: test.id, testKey: test.testKey, created: true });
    });
}
