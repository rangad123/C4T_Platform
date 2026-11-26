/**
 * The Agent Workspace (agent-workspace.ts; .scratch/agent-workspace/SPEC.md):
 *
 *   GET /api/projects/:id/workspace[?agent=]              → { workspace, agents: [{ id, name, summary, status, needs, runs, lastRun, headline }] }
 *                                                           workspace false and no agents for a project without one (code, mixed, no choice saved);
 *                                                           ?agent= answers that agent's card alone (an agent page); headlines: agent-workspace.ts headlineOf
 *   GET /api/projects/:id/workspace/:agentId/outcome[?run=]  → that agent's outcome (agent-outcomes/<agentId>.ts), or one run's part of it;
 *                                                           501 for an agent whose outcome is not built yet, 404 for an agent the project did not choose
 *   GET /api/projects/:id/workspace/api/report[?run=][&format=html|pdf] → the API Testing Agent's report as a file (reports/api-report.ts),
 *                                                           of one run or of all; exporting needs ai_studio.reports.export
 *   ?run=latest is the agent's newest finished run (404 before one).
 *   GET /api/projects/:id/workspace/:agentId/runs            → that agent's runs only, newest first (the jobs list's shape), a check
 *                                                           agent's run with its own one line (`headline`: what that run found)
 *   GET /api/projects/:id/workspace/:agentId/settings        → { keys, settings }: the defaults this agent has and the ones saved (testing-agents.ts)
 *   PUT /api/projects/:id/workspace/:agentId/settings        { level?, model?, variants?, visionChecks? } → the same; replaces them all
 *
 * Who may read the project reads them; saving an agent's settings is a project setting (auth/roles.ts). A model is saved only when the
 * person saving may use it (as the project's AI model, routes/project-ai-model.ts).
 */
import { z } from "zod";
import { agentStatusOf, headlineOf, jobBelongsTo, resultsStamp, workspaceAgents } from "../agent-workspace.js";
import { outcome as apiOutcome } from "../agent-outcomes/api.js";
import { AGENT_OUTCOMES } from "../agent-outcomes/index.js";
import { toPdf } from "../pdf.js";
import { apiReportName, renderApiReportHtml } from "../reports/api-report.js";
import type { AgentOutcomeCtx } from "../agent-outcomes/types.js";
import { NO_ADDRESS_OR_REQUIREMENTS } from "../case-agent.js";
import type { AppModelReader } from "../case-outcome.js";
import { HttpError } from "../http-error.js";
import type { Row } from "../db.js";
import { TERMINAL_STATES } from "../repo.js";
import { RequirementStore } from "../requirement-store.js";
import { agentById, agentSettingKeys, parseAgentSettings, type AgentId } from "../testing-agents.js";
import { aiOwnerOfActor, modelChoicesOf, PROJECT_MODEL_NOT_YOURS } from "../ai-config.js";
import { actorOf } from "../auth/access.js";
import { actorLabel, currentActor } from "../auth/actor.js";
import { capturedApisFor, missingInputs, savedInputsFor } from "./agent-inputs.js";
import { testingAgentsOf } from "./testing-agents.js";
import type { RouteCtx } from "./types.js";

export const NOT_THIS_PROJECTS_AGENT = "This testing agent is not one of this project's agents.";
export const outcomeNotBuilt = (name: string) => `The ${name}'s outcome is not shown here yet.`;
export const NO_SUCH_AGENT_RUN = "This run is not one of this agent's runs.";

export function registerAgentWorkspaceRoutes(ctx: RouteCtx, appModel: AppModelReader): void {
    const { app, p, repo } = ctx;
    const store = testingAgentsOf(p, repo);

    /** What the agent cannot run without, as the sentences its refusal says (routes/agent-inputs.ts REQUIRED_INPUTS, case-agent.ts). */
    const needsOf = async (row: Row, agentId: AgentId): Promise<string[]> => {
        const id = String(row.id);
        const latest = repo.getLatestApplicationPublic(id);
        const openApiUrl = latest ? savedInputsFor(p, id, String(latest.url)).openApiUrl : undefined;
        const needs = missingInputs([agentId], { openApiUrl, capturedApis: agentId === "api" && capturedApisFor(repo, id, latest?.url as string | undefined) }).map((m) => m.text);
        if (agentId === "test-generation" && !latest?.url && !row.url && !latest?.config?.mobile) {
            if (!(await new RequirementStore(p.db.sql).list(id)).some((r) => r.status === "active")) needs.push(NO_ADDRESS_OR_REQUIREMENTS);
        }
        return needs;
    };
    const runsOf = (projectId: string, agentId: AgentId) => repo.listJobs(projectId).filter((j) => jobBelongsTo(j, agentId));
    /** The project row and one of its Workspace agents, or a 404. */
    const agentOf = async (id: string, raw: string) => {
        const row = ctx.project(id);
        const a = agentById(raw);
        if (!a || !(await workspaceAgents(store, row))?.includes(a.id)) throw new HttpError(404, NOT_THIS_PROJECTS_AGENT);
        return { row, agent: a };
    };
    const outcomeCtx = (projectId: string, agentId: AgentId): AgentOutcomeCtx => ({ p, projectId, agentId, runs: runsOf(projectId, agentId), appModel });
    /** `?run=`: one of this agent's runs, "latest" its newest finished one; undefined when it is neither. */
    const runOf = (c: AgentOutcomeCtx, run: string) => (run === "latest" ? c.runs.find((j) => TERMINAL_STATES.includes(j.status)) : c.runs.find((j) => j.id === run));

    app.get("/api/projects/:id/workspace", async (req) => {
        const { id } = req.params as { id: string };
        const row = ctx.project(id);
        const chosen = await workspaceAgents(store, row);
        if (!chosen) return { workspace: false, agents: [] };
        const only = (req.query as { agent?: unknown }).agent;
        const going = repo.listJobs(id).filter((j) => !TERMINAL_STATES.includes(j.status)).map((j) => j.id);
        const stamp = await resultsStamp(p.db.sql, id, going);
        const agents = [];
        for (const agentId of chosen) {
            if (typeof only === "string" && only && only !== agentId) continue;
            const a = agentById(agentId)!;
            const c = outcomeCtx(id, agentId);
            const needs = await needsOf(row, agentId);
            const module = AGENT_OUTCOMES[agentId];
            let headline: string | null = null;
            try {
                if (module && c.runs.length) headline = await headlineOf(id, agentId, c.runs, stamp, async () => module.headline(await module.outcome(c)));
            } catch (err) {
                // One agent's outcome that cannot be read leaves its card without a headline; the Workspace still shows.
                console.error(`[agents] the ${agentId} outcome of project ${id.slice(0, 8)} could not be read:`, err);
            }
            agents.push({ id: agentId, name: a.name, summary: a.summary, status: agentStatusOf(c.runs[0], needs), needs, runs: c.runs.length, lastRun: c.runs[0] ? ctx.publicJob(c.runs[0]) : null, headline });
        }
        return { workspace: true, agents };
    });

    app.get("/api/projects/:id/workspace/:agentId/outcome", async (req) => {
        const { id, agentId } = req.params as { id: string; agentId: string };
        const { agent } = await agentOf(id, agentId);
        const module = AGENT_OUTCOMES[agent.id];
        if (!module) throw new HttpError(501, outcomeNotBuilt(agent.name));
        const c = outcomeCtx(id, agent.id);
        const run = (req.query as { run?: unknown }).run;
        if (typeof run === "string" && run) {
            const job = runOf(c, run);
            const one = job ? await module.runOutcome(c, job.id) : undefined;
            if (!one) throw new HttpError(404, NO_SUCH_AGENT_RUN);
            return one;
        }
        return module.outcome(c);
    });

    app.get("/api/projects/:id/workspace/api/report", async (req, reply) => {
        const { id } = req.params as { id: string };
        const { row } = await agentOf(id, "api");
        const { format, run } = z.object({ format: z.enum(["html", "pdf"]).default("html"), run: z.string().optional() }).parse(req.query);
        const c = outcomeCtx(id, "api");
        const job = run ? runOf(c, run) : undefined;
        if (run && !job) throw new HttpError(404, NO_SUCH_AGENT_RUN);
        const outcome = job ? (await apiOutcome.runOutcome(c, job.id))! : await apiOutcome.outcome(c);
        const generatedAt = new Date();
        const latest = repo.getLatestApplicationPublic(id);
        const html = renderApiReportHtml({ projectName: String(row.name), application: latest ? String(latest.url) : null, outcome, generatedAt });
        const base = apiReportName(String(row.name), outcome, generatedAt);
        if (format === "pdf") {
            const pdf = await toPdf(html, p.config.HEADLESS);
            return reply.header("content-type", "application/pdf").header("content-disposition", `attachment; filename="${base}.pdf"`).send(pdf);
        }
        return reply.header("content-type", "text/html; charset=utf-8").header("content-disposition", `attachment; filename="${base}.html"`).send(html);
    });

    app.get("/api/projects/:id/workspace/:agentId/runs", async (req) => {
        const { id, agentId } = req.params as { id: string; agentId: string };
        const { agent } = await agentOf(id, agentId);
        const c = outcomeCtx(id, agent.id);
        const module = AGENT_OUTCOMES[agent.id];
        // Test Case Generation's run rows say what each added to the tree (CaseRuns); a check agent's say what that run found.
        if (!module || agent.id === "test-generation") return c.runs.map(ctx.publicJob);
        const out = [];
        // shortcut: one run outcome per row on every read (the list polls while a run goes); cache finished runs' lines if a long list gets slow.
        for (const j of c.runs) {
            let headline: string | null = null;
            try {
                const one = await module.runOutcome(c, j.id);
                headline = one === undefined ? null : module.headline(one);
            } catch (err) {
                console.error(`[agents] the ${agent.id} run ${j.id.slice(0, 8)} could not be read:`, err);
            }
            out.push({ ...ctx.publicJob(j), headline });
        }
        return out;
    });

    const settingsAnswer = async (id: string, agentId: AgentId) => ({ keys: agentSettingKeys(agentId), settings: await store.settingsOf(id, agentId) });

    app.get("/api/projects/:id/workspace/:agentId/settings", async (req) => {
        const { id, agentId } = req.params as { id: string; agentId: string };
        const { agent } = await agentOf(id, agentId);
        return settingsAnswer(id, agent.id);
    });

    app.put("/api/projects/:id/workspace/:agentId/settings", async (req) => {
        const { id, agentId } = req.params as { id: string; agentId: string };
        const { agent } = await agentOf(id, agentId);
        const settings = parseAgentSettings(agent.id, req.body);
        const before = (await store.settingsOf(id, agent.id)).model;
        const changed = settings.model && (settings.model.provider !== before?.provider || settings.model.model !== before?.model);
        if (changed && !(await modelChoicesOf({ sql: p.sql, config: p.config }, aiOwnerOfActor(currentActor()))).some((c) => c.provider === settings.model!.provider && c.model === settings.model!.model)) throw new HttpError(403, PROJECT_MODEL_NOT_YOURS);
        await store.setSettings(id, agent.id, settings, actorLabel(actorOf(req) ?? currentActor()));
        return settingsAnswer(id, agent.id);
    });
}
